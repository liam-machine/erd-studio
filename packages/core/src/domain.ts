/**
 * Domain JSON -> UnifiedSubjectArea, without touching a file system.
 *
 * The extension host's SubjectAreaService reads the file and hands the text here;
 * other hosts (a browser, a server reading from a git provider) do the same
 * with whatever `readFile` they have. The parsing, validation and repair
 * rules — and every message they produce — live in this one place, so every
 * host shows the same domain for the same file.
 */

import type {
  Cardinality,
  SubjectAreaFormat,
  Layer,
  TableLoadError,
  TableLoadErrorKind,
  DbmlMetadataTarget,
  NodePosition,
  Relationship,
  SemanticSubjectArea,
  SemanticTable,
  StageData,
  UnreadableTablePlaceholder,
  UnifiedSubjectArea,
  ViewConfig,
  Annotation,
} from './types/semantic.js';
import { CURRENT_JSON_SCHEMA_VERSION, TABLE_NAMING_SCHEMA_VERSION, describeUnsupportedSubjectAreaFormat, detectSubjectAreaFormat, usesTableLibrary } from './types/semantic.js';
import { LOGICAL_MODELS_DIR, TableMergeConflictError } from './logicalModel.js';
import {
  canonicalRelationship, compositeGroupProblem, linkKey, normaliseCompositeKey, normaliseRelationshipRole, respellRelationship,
  reverseRelationship,
} from './relationships.js';
import { keyEvidence } from './keyEvidence.js';
import type { DbtKeyIndex, KeyedTable } from './keyEvidence.js';
import { findConflictMarkers } from './mergeConflict.js';

/**
 * Sub-directories of the semantic dir that never contain domain files.
 *
 * The single source of truth for "is this `{semanticDir}/x/y.json` a domain?".
 * The watcher classifies delete events through it, and the custom editor
 * refuses to render a canvas for anything it excludes — a template opened from
 * the explorer is a JSON file to edit, not a diagram to draw.
 */
export const NON_SUBJECT_AREA_DIRS: ReadonlySet<string> = new Set([
  'templates', LOGICAL_MODELS_DIR, 'logical', 'physical',
]);

/**
 * Why a domain file could not be turned into a `UnifiedSubjectArea`.
 * `'invalid-dbml'` is a `.dbml` diagram the DBML parser rejects (native DBML
 * storage); like `'invalid-json'` it is transient unless the file holds
 * merge conflicts.
 */
export type SubjectAreaFileErrorReason = 'missing' | 'unreadable' | 'empty' | 'invalid-json' | 'invalid-dbml';

/**
 * What kind of JSON mistake an 'invalid-json' file holds (#186), worked out
 * from the text around the parser's position:
 *
 * - `trailing-comma` — a comma right before a closing `}` or `]`;
 * - `missing-comma` — a value followed by another with no comma between;
 * - `truncated` — the text ends before the JSON does;
 * - `unexpected` — anything else, located where the parser stopped.
 */
export type JsonSyntaxProblem = 'trailing-comma' | 'missing-comma' | 'truncated' | 'unexpected';

/**
 * A domain file that could not be read or parsed.
 *
 * `transient` is the point of the type. A domain file is replaced, not patched
 * in place — by `git checkout`, by a formatter, by an AI agent following the
 * installed harness — and for a few milliseconds mid-replacement it is empty
 * or truncated. Reading it in that window is not an error about the project;
 * it is an error about the timing of the read, and the fix is to read again.
 * `ManifestService` already treats a malformed `manifest.json` this way (dbt
 * mid-write); this is the same courtesy for the file the canvas is built from.
 *
 * The one 'invalid-json' that is not transient is a file holding unresolved
 * git merge conflicts (#145): `mergeConflict` is true, `line` is the first
 * `<<<<<<<`, and re-reading cannot help — someone has to keep one side. It
 * stays an 'invalid-json' (a flag, not a new reason) so a host that predates
 * the flag still reports it as the unparseable file it is.
 *
 * Any other 'invalid-json' carries `line`, `column` and `syntaxProblem` when
 * the parser said where it stopped (#186), so a host can point the user at
 * the mistake rather than echo the parser. `message` is unchanged by them.
 */
export class SubjectAreaFileError extends Error {
  readonly transient: boolean;
  /** The file holds unresolved git conflict markers; always false unless reason is 'invalid-json' or 'invalid-dbml'. */
  readonly mergeConflict: boolean;
  /**
   * 1-based line: of the first conflict marker when `mergeConflict`, else of
   * the JSON mistake when the parser located one.
   */
  readonly line?: number;
  /** 1-based column of the JSON mistake, alongside `line`; absent for a conflict. */
  readonly column?: number;
  /** What the JSON mistake looks like, when `line` locates one; absent for a conflict. */
  readonly syntaxProblem?: JsonSyntaxProblem;

  constructor(
    readonly reason: SubjectAreaFileErrorReason,
    readonly filePath: string,
    message: string,
    options: { mergeConflict?: boolean; line?: number; column?: number; syntaxProblem?: JsonSyntaxProblem } = {},
  ) {
    super(message);
    this.name = 'SubjectAreaFileError';
    this.mergeConflict = options.mergeConflict === true;
    if (options.line !== undefined) this.line = options.line;
    if (options.column !== undefined) this.column = options.column;
    if (options.syntaxProblem !== undefined) this.syntaxProblem = options.syntaxProblem;
    this.transient = reason === 'empty' || ((reason === 'invalid-json' || reason === 'invalid-dbml') && !this.mergeConflict);
  }
}

/** Where `JSON.parse` stopped, as a character offset into `raw`, from its message. */
function jsonParseOffset(raw: string, parserMessage: string): number | undefined {
  // V8 (Node, Chrome, Electron): "… in JSON at position N", with or without
  // a trailing "(line L column C)" depending on the version.
  const position = /\bposition (\d+)/.exec(parserMessage);
  if (position) return Math.min(Number(position[1]), raw.length);
  // SpiderMonkey (Firefox): "… at line L column C of the JSON data".
  const lineColumn = /\bline (\d+) column (\d+)/.exec(parserMessage);
  if (lineColumn) {
    const lines = raw.split('\n');
    const line = Math.min(Number(lineColumn[1]), lines.length);
    let offset = 0;
    for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1;
    return Math.min(offset + Number(lineColumn[2]) - 1, raw.length);
  }
  // "Unexpected end of JSON input" (V8), "unexpected end of data" (SpiderMonkey).
  if (/end of (?:JSON input|data)/i.test(parserMessage)) return raw.length;
  return undefined;
}

const isJsonWhitespace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/**
 * Where `firstJsonErrorOffset` stopped, and whether a comma (between items)
 * was one of the things that could have come next there.
 */
class JsonScanStop {
  constructor(readonly at: number, readonly commaFits = false) {}
}

/**
 * The offset of the first character that stops `raw` being JSON, by walking
 * the JSON grammar; `raw.length` when it ends too early, `undefined` when it
 * parses. Only ever run on text `JSON.parse` already rejected: engines word
 * their errors differently and V8's "Unexpected token" names no position.
 */
function firstJsonErrorOffset(raw: string): JsonScanStop | undefined {
  let i = 0;
  const fail = (at: number, commaFits = false): never => { throw new JsonScanStop(at, commaFits); };
  const ws = (): void => { while (i < raw.length && isJsonWhitespace(raw[i])) i++; };
  const literal = (word: string): void => {
    const start = i;
    for (const ch of word) { if (raw[i] !== ch) fail(start); i++; }
  };
  const digits = (): void => {
    if (!/[0-9]/.test(raw[i] ?? '')) fail(i);
    while (/[0-9]/.test(raw[i] ?? '')) i++;
  };
  const string = (): void => {
    i++;
    for (;;) {
      if (i >= raw.length) fail(i);
      const ch = raw[i];
      if (ch === '"') { i++; return; }
      if (ch < ' ') fail(i);
      if (ch === '\\') {
        i++;
        if (raw[i] === 'u') {
          i++;
          for (let k = 0; k < 4; k++, i++) { if (!/[0-9a-fA-F]/.test(raw[i] ?? '')) fail(i); }
          continue;
        }
        if (!'"\\/bfnrt'.includes(raw[i] ?? 'x')) fail(i);
      }
      i++;
    }
  };
  const value = (): void => {
    ws();
    const ch = raw[i];
    if (ch === '{') {
      i++; ws();
      if (raw[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (raw[i] !== '"') fail(i);
        string(); ws();
        if (raw[i] !== ':') fail(i);
        i++; value(); ws();
        if (raw[i] === ',') { i++; continue; }
        if (raw[i] === '}') { i++; return; }
        fail(i, true);
      }
    }
    if (ch === '[') {
      i++; ws();
      if (raw[i] === ']') { i++; return; }
      for (;;) {
        value(); ws();
        if (raw[i] === ',') { i++; continue; }
        if (raw[i] === ']') { i++; return; }
        fail(i, true);
      }
    }
    if (ch === '"') { string(); return; }
    if (ch === 't') { literal('true'); return; }
    if (ch === 'f') { literal('false'); return; }
    if (ch === 'n') { literal('null'); return; }
    if (ch === '-' || /[0-9]/.test(ch ?? '')) {
      if (ch === '-') i++;
      if (raw[i] === '0') i++; else digits();
      if (raw[i] === '.') { i++; digits(); }
      if (raw[i] === 'e' || raw[i] === 'E') {
        i++;
        if (raw[i] === '+' || raw[i] === '-') i++;
        digits();
      }
      return;
    }
    fail(i);
  };
  try {
    value(); ws();
    return i < raw.length ? new JsonScanStop(i) : undefined;
  } catch (err) {
    if (err instanceof JsonScanStop) return new JsonScanStop(Math.min(err.at, raw.length), err.commaFits);
    return undefined; // nesting deep enough to overflow the stack: let the message decide
  }
}

/** The last character of a complete value: a string, number, literal, object or array. */
const endsValue = (ch: string): boolean => /["\]}0-9el]/.test(ch);
/** The first character of a value or of a property name. */
const startsValue = (ch: string): boolean => /["{[0-9tfn-]/.test(ch);

/**
 * Locate the mistake in text `JSON.parse` rejected (#186), as a 1-based line
 * and column, and say what it looks like. The parser's own position is often
 * one step past the mistake — at the `}` after a trailing comma, at the
 * property after a missing comma — so this steps back to where a person would
 * put the fix. `undefined` when the parser did not say where it stopped.
 */
export function locateJsonSyntaxError(
  raw: string,
  parserMessage: string,
): { line: number; column: number; problem: JsonSyntaxProblem } | undefined {
  const scanned = firstJsonErrorOffset(raw);
  const at = scanned?.at ?? jsonParseOffset(raw, parserMessage);
  if (at === undefined) return undefined;
  // Without a scan (a nesting deep enough to overflow it), only the parser's
  // own "expected ':'" tells a missing colon from a missing comma.
  const commaFits = scanned ? scanned.commaFits : !parserMessage.includes("':'");
  let next = at;
  while (next < raw.length && isJsonWhitespace(raw[next])) next++;
  let prev = at - 1;
  while (prev >= 0 && isJsonWhitespace(raw[prev])) prev--;

  let offset = at;
  let problem: JsonSyntaxProblem = 'unexpected';
  if (next >= raw.length) {
    problem = 'truncated';
    offset = prev + 1;
  } else if ((raw[next] === '}' || raw[next] === ']') && raw[prev] === ',') {
    problem = 'trailing-comma';
    offset = prev;
  } else if (commaFits && prev >= 0 && prev < at - 1 && endsValue(raw[prev]) && startsValue(raw[next])) {
    // Only where a comma could go, and only across whitespace: `01` is a
    // bad number, not two values.
    problem = 'missing-comma';
    offset = prev + 1;
  }

  const before = raw.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1) + 1;
  return { line, column, problem };
}

/**
 * A domain file that parsed as JSON but is not a domain this version can load:
 * not an object, no usable `schemaVersion`, a newer schema, a legacy or hybrid
 * layout, or a layer that is not configured.
 *
 * Its `name` is deliberately left as `Error`, so logs that print the error
 * read exactly as they did when these were plain `Error`s.
 */
export class SubjectAreaValidationError extends Error {}

export const VALID_CARDINALITIES: ReadonlySet<Cardinality> = new Set<Cardinality>([
  'many-to-one', 'one-to-one', 'one-to-many', 'many-to-many',
]);

/**
 * Parse the text of a domain file.
 *
 * Throws a transient `SubjectAreaFileError` for an empty file ('empty') and for
 * text that is not JSON ('invalid-json') — except text holding git conflict
 * markers, an 'invalid-json' with `mergeConflict` set that is not transient.
 * A plain 'invalid-json' carries where the mistake is (`locateJsonSyntaxError`).
 * Reading the file — and the 'missing' / 'unreadable' failures — is the
 * caller's job.
 */
export function parseSubjectAreaJson(raw: string, filePath: string): unknown {
  if (raw.trim() === '') {
    // Almost always a file mid-creation: the create event lands a zero-byte
    // file and the content follows milliseconds later. Say what is true of
    // the file rather than echoing "Unexpected end of JSON input", which
    // reads as corruption when nothing is corrupt.
    throw new SubjectAreaFileError('empty', filePath, `Subject area file is empty: ${filePath}`);
  }

  // A byte order mark (Windows PowerShell 5 writes one) is not a mistake
  // the user can see or fix in the text editor, which hides it (#186). It is
  // left out of the location too, or every mistake in such a file would be
  // reported at line 1, column 1.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    return JSON.parse(text);
  } catch (err) {
    // Only text that already failed to parse is checked, so a valid file
    // whose description quotes a marker can never be reported as conflicted.
    const line = findConflictMarkers(text);
    if (line !== null) {
      throw new SubjectAreaFileError(
        'invalid-json',
        filePath,
        `Subject area file ${filePath} has unresolved git merge conflicts (first at line ${line}). `
          + 'Resolve them in the file — if only positions conflict, either side is safe to keep.',
        { mergeConflict: true, line },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    const located = locateJsonSyntaxError(text, message);
    throw new SubjectAreaFileError(
      'invalid-json',
      filePath,
      `Invalid JSON in subject area file ${filePath}: ${message}`,
      located ? { line: located.line, column: located.column, syntaxProblem: located.problem } : {},
    );
  }
}

/**
 * Check that parsed JSON is a domain document this version can load, and
 * work out its format. Throws `SubjectAreaValidationError` otherwise.
 */
export function validateSubjectAreaDocument(
  data: unknown,
  filePath: string,
): { obj: Record<string, unknown>; format: SubjectAreaFormat } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SubjectAreaValidationError(`Subject area file ${filePath} does not contain a JSON object`);
  }

  const obj = data as Record<string, unknown>;

  // Schema version check
  if (typeof obj.schemaVersion !== 'number') {
    throw new SubjectAreaValidationError(
      `Subject area file ${filePath} is missing a valid "schemaVersion" field`
    );
  }

  // A JSON file is held to the JSON ceiling (6), with the words it always
  // had: 7 is a DBML diagram's version, never a JSON one.
  if (obj.schemaVersion > CURRENT_JSON_SCHEMA_VERSION) {
    throw new SubjectAreaValidationError(
      `Subject area file ${filePath} has schemaVersion ${obj.schemaVersion} ` +
      `but this extension only supports up to version ${CURRENT_JSON_SCHEMA_VERSION}. ` +
      'Please update the extension.'
    );
  }

  // Format check — legacy (pre-v4) and hybrid (mixed / self-contradicting)
  // documents are rejected with a remediation hint rather than silently
  // loaded as an empty or half-resolved domain.
  const format = detectSubjectAreaFormat(obj);
  const unsupported = describeUnsupportedSubjectAreaFormat(format, filePath, obj);
  if (unsupported) {
    throw new SubjectAreaValidationError(unsupported);
  }

  return { obj: format === 'v6' ? normaliseSubjectAreaDocument(obj) : obj, format };
}

/**
 * Rename the key `from` to `to` in a copy of `obj`, where `from` stood, so
 * the key order (and a byte-level rewrite that pairs renamed keys by
 * position, like the extension's) is kept; when both are written, `from`'s
 * value wins.
 */
function renamedKey(obj: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  if (!(from in obj)) return obj;
  // `fromEntries` defines each key as data, so a `__proto__` key stays a key.
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== to).map(([k, v]) => [k === from ? to : k, v]));
}

/** The v6 key and its v5 (in-memory) name, for each key the naming changes (#162). */
const SUBJECT_AREA_KEYS = { subjectArea: 'domain', tables: 'models' } as const;
const RELATIONSHIP_END_KEYS = { fromTable: 'fromModel', toTable: 'toModel' } as const;
const ANNOTATION_KEYS = { linkedTable: 'linkedModel' } as const;

/** Which way {@link renameNamingKeys} goes: v6 names to the in-memory (v5) ones, or back. */
type NamingDirection = 'toV5' | 'toV6';

/** `[from, to]` for a v6 → v5 key pair in `direction`. */
function keyPair(v6: string, v5: string, direction: NamingDirection): [string, string] {
  return direction === 'toV5' ? [v6, v5] : [v5, v6];
}

/** The relationship entries of a list under the other naming's keys. */
function renameRelationshipEntries(value: unknown, direction: NamingDirection): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    // A v6 end wins only when it holds text, as `parseTableText` reads `toTable`;
    // a stray non-string one beside a v5 end is dropped rather than hiding it.
    const end = (o: Record<string, unknown>, v6: string, v5: string): Record<string, unknown> => {
      const [from, to] = keyPair(v6, v5, direction);
      if (direction === 'toV6' || typeof o[from] === 'string' || !(to in o)) return renamedKey(o, from, to);
      const { [from]: _stray, ...rest } = o;
      return rest;
    };
    let out = entry as Record<string, unknown>;
    for (const [v6, v5] of Object.entries(RELATIONSHIP_END_KEYS)) out = end(out, v6, v5);
    return out;
  });
}

/** A view config (top level, or the stage-level fallback) under the other naming's keys. */
function renameViewConfig(value: unknown, direction: NamingDirection): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const viewConfig = value as Record<string, unknown>;
  if (!Array.isArray(viewConfig.annotations)) return viewConfig;
  const [from, to] = keyPair('linkedTable', ANNOTATION_KEYS.linkedTable, direction);
  return {
    ...viewConfig,
    annotations: viewConfig.annotations.map((a: unknown) =>
      a && typeof a === 'object' && !Array.isArray(a) ? renamedKey(a as Record<string, unknown>, from, to) : a),
  };
}

/** Every key the naming changes, renamed in `direction`, in place of the old one. */
function renameNamingKeys(obj: Record<string, unknown>, direction: NamingDirection): Record<string, unknown> {
  const doc = renamedKey(obj, ...keyPair('subjectArea', SUBJECT_AREA_KEYS.subjectArea, direction));
  const result: Record<string, unknown> = { ...doc };
  if (doc.logical && typeof doc.logical === 'object' && !Array.isArray(doc.logical)) {
    const logical = renamedKey(doc.logical as Record<string, unknown>, ...keyPair('tables', SUBJECT_AREA_KEYS.tables, direction));
    result.logical = {
      ...logical,
      ...('relationships' in logical ? { relationships: renameRelationshipEntries(logical.relationships, direction) } : {}),
      ...('viewConfig' in logical ? { viewConfig: renameViewConfig(logical.viewConfig, direction) } : {}),
    };
  }
  if ('viewConfig' in doc) result.viewConfig = renameViewConfig(doc.viewConfig, direction);
  return result;
}

/**
 * The one place the v6 names (#162) become the in-memory ones, so nothing
 * after `validateSubjectAreaDocument` branches on the naming: `subjectArea`
 * → `domain`, `logical.tables` → `logical.models`, a relationship's
 * `fromTable` / `toTable` → `fromModel` / `toModel`, an annotation's
 * `linkedTable` → `linkedModel`. Returns a copy, in the file's key order;
 * `schemaVersion` keeps the file's own value. Model yml is normalised the
 * same way, by key, in `parseTableText`. {@link toTableNamingDocument} is
 * the way back.
 */
export function normaliseSubjectAreaDocument(obj: Record<string, unknown>): Record<string, unknown> {
  return renameNamingKeys(obj, 'toV5');
}

/**
 * A subject area document held under the in-memory (v5) keys, written back
 * in the v6 naming (#182): the inverse of {@link normaliseSubjectAreaDocument},
 * key order kept, with `schemaVersion` set to 6 (in place, or first when the
 * document had none). Returns a copy. What a host writes for a v6 file, and
 * what the naming migration writes for a v5 one.
 */
export function toTableNamingDocument(obj: Record<string, unknown>): Record<string, unknown> {
  const renamed = renameNamingKeys(obj, 'toV6');
  return 'schemaVersion' in renamed
    ? { ...renamed, schemaVersion: TABLE_NAMING_SCHEMA_VERSION }
    : { schemaVersion: TABLE_NAMING_SCHEMA_VERSION, ...renamed };
}

/** The configured layers, as far as domain loading needs them. */
export interface LayerLookup {
  hasLayer(id: string): boolean;
  getValidLayerIds(): string[];
}

/**
 * The layer a domain belongs to: its `layer` field when that is configured,
 * otherwise the name of the directory it sits in. Throws
 * `SubjectAreaValidationError` when neither is a configured layer.
 */
export function resolveSubjectAreaLayer(
  value: unknown,
  filePath: string,
  parentDirName: string,
  layers: LayerLookup,
): Layer {
  if (typeof value === 'string' && layers.hasLayer(value)) {
    return value;
  }

  // Fall back to inferring from directory name
  if (layers.hasLayer(parentDirName)) {
    return parentDirName;
  }

  const validLayers = layers.getValidLayerIds().join(', ');
  throw new SubjectAreaValidationError(
    `Subject area file ${filePath} has invalid layer "${String(value)}". ` +
    `Expected one of: ${validLayers}`,
  );
}

/** What `buildUnifiedSubjectArea` needs from its host. */
export interface BuildUnifiedSubjectAreaContext {
  /** How the file is named in messages (a path, or a repo-relative label). */
  filePath: string;
  /** Domain name used when the document has no string `domain` (the file name without `.json`). */
  domainNameFallback: string;
  /** Name of the directory holding the file; the layer when `layer` is not usable. */
  parentDirName: string;
  layers: LayerLookup;
  /**
   * Resolve a v5 model reference. Return null for a missing or unreadable
   * model: it becomes a placeholder `{ name, columns: [] }`. When omitted,
   * every reference becomes a placeholder without a warning.
   */
  getModel?: (name: string) => SemanticTable | null;
  /**
   * Asked only when `getModel` returned null: why that model's file, if it
   * exists, could not be read. A non-null answer is attached to the
   * placeholder as `loadError` and names the error in the warning instead of
   * reporting the model as missing.
   */
  getModelError?: (name: string) => TableLoadError | null;
  /** Receives repair warnings (dropped entries, defaulted values). Defaults to console.warn. */
  warn?: (message: string) => void;
  /**
   * What dbt's tests say about keys (#133 L1): how the read winner tells a
   * link's copies apart when no key is flagged. Without it, flags only.
   */
  dbtKeyIndex?: DbtKeyIndex;
}

/**
 * Turn a validated domain document into a `UnifiedSubjectArea`: resolve the layer,
 * the global view config, `stubColumns` and the logical stage, repairing or
 * dropping malformed entries with a warning rather than failing the domain.
 */
export function buildUnifiedSubjectArea(
  obj: Record<string, unknown>,
  format: SubjectAreaFormat,
  ctx: BuildUnifiedSubjectAreaContext,
): UnifiedSubjectArea {
  const warn = ctx.warn ?? ((message: string) => console.warn(message));
  const { filePath } = ctx;

  const domain = typeof obj.domain === 'string' ? obj.domain : ctx.domainNameFallback;
  const layer = resolveSubjectAreaLayer(obj.layer, filePath, ctx.parentDirName, ctx.layers);

  const emptyStage: StageData = { models: [], relationships: [] };

  // Global viewConfig — fall back to stage-level viewConfig for existing files
  const globalViewConfig = parseViewConfig(
    obj.viewConfig
      ?? (obj.logical as Record<string, unknown> | undefined)?.viewConfig,
    warn,
  );

  // Parse stubColumns — optional string[] of model names with stub display
  const stubColumns = Array.isArray(obj.stubColumns)
    ? (obj.stubColumns as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;

  return {
    schemaVersion: obj.schemaVersion as number,
    domain,
    layer,
    description: typeof obj.description === 'string' ? obj.description : '',
    ...(typeof obj.modelFolder === 'string' ? { modelFolder: obj.modelFolder } : {}),
    logical: parseStageData(obj.logical, format, filePath, ctx.getModel, ctx.getModelError, warn, ctx.dbtKeyIndex) ?? { ...emptyStage },
    ...(stubColumns && stubColumns.length > 0 ? { stubColumns } : {}),
    viewConfig: globalViewConfig,
  };
}

/**
 * Project a `UnifiedSubjectArea` onto its logical stage.
 *
 * Physical stages are derived from the dbt project by the extension host and
 * are not produced here.
 */
export function toLogicalStage(unified: UnifiedSubjectArea): SemanticSubjectArea {
  const stageData = unified.logical;

  return {
    schemaVersion: unified.schemaVersion,
    domain: unified.domain,
    layer: unified.layer,
    stage: 'logical',
    description: unified.description,
    ...(unified.modelFolder ? { modelFolder: unified.modelFolder } : {}),
    models: stageData.models,
    relationships: stageData.relationships,
  };
}

/**
 * Parse a stage data section from a domain file.
 * Handles both v4 (inline SemanticTable[]) and v5 / v6 (string[] name
 * references; v6 already normalised to v5 keys by `validateSubjectAreaDocument`)
 * as decided by {@link detectSubjectAreaFormat} — hybrid/legacy documents are
 * rejected before this point, so every entry is guaranteed to match `format`.
 * For v5 and v6, resolves model names through `getModel`.
 * Returns null if the section is missing or invalid.
 */
function parseStageData(
  value: unknown,
  format: SubjectAreaFormat,
  filePath: string,
  getModel: ((name: string) => SemanticTable | null) | undefined,
  getModelError: ((name: string) => TableLoadError | null) | undefined,
  warn: (message: string) => void,
  dbt?: DbtKeyIndex,
): StageData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const rawModels = Array.isArray(obj.models) ? obj.models : [];
  const relationships = parseRelationships(obj.relationships, filePath, warn);

  let models: SemanticTable[];
  if (usesTableLibrary(format)) {
    const names = rawModels.filter((m): m is string => typeof m === 'string');
    if (getModel) {
      // Resolve model name references from logical-models/*.yml
      models = [];
      for (const name of names) {
        const model = getModel(name);
        if (model) {
          models.push(model);
        } else {
          // Broken reference — create a placeholder so the UI can show an error
          const loadError = getModelError?.(name) ?? null;
          if (loadError) {
            warn(`Model "${name}": ${describeTableLoadError(loadError)}`);
            const placeholder: UnreadableTablePlaceholder = { name, columns: [], loadError: { ...loadError } };
            models.push(placeholder);
          } else {
            warn(`Model "${name}" not found in the table library`);
            models.push({ name, columns: [] });
          }
        }
      }
    } else {
      // v5 format but no model lookup available (e.g., testing)
      // Create placeholder models from names
      models = names.map(name => ({ name, columns: [] }));
    }
    return { models, relationships: mergeLibraryRelationships(models, relationships, filePath, warn, dbt) };
  } else {
    // v4 format: inline model objects — each must carry a string name
    models = [];
    for (const entry of rawModels) {
      const candidate = entry as Record<string, unknown> | null;
      if (candidate && typeof candidate === 'object' && typeof candidate.name === 'string') {
        models.push(candidate as unknown as SemanticTable);
      } else {
        warn(`Skipping inline model without a string "name" in ${filePath}`);
      }
    }
  }

  const grouped = assembleGroups(relationships.map((rel, index) => ({ rel, at: { source: 'dom' as const, file: '', index } })), filePath, warn);
  return { models, relationships: grouped.map((rel) => respellRelationship(rel, models)) };
}

/** The YAML parser's error codes, grouped into the kinds the UI and telemetry use. */
const YAML_ERROR_KINDS: Readonly<Record<string, TableLoadErrorKind>> = {
  TAB_AS_INDENT: 'yamlIndent',
  BAD_INDENT: 'yamlIndent',
  BAD_SCALAR_START: 'yamlScalar',
  BLOCK_AS_IMPLICIT_KEY: 'yamlScalar',
  UNEXPECTED_TOKEN: 'yamlScalar',
  MISSING_CHAR: 'yamlScalar',
  BAD_ALIAS: 'yamlScalar',
  BLOCK_IN_FLOW: 'yamlScalar',
  MULTIPLE_DOCS: 'yamlStructure',
  MULTILINE_IMPLICIT_KEY: 'yamlStructure',
  DUPLICATE_KEY: 'yamlDuplicateKey',
};

/**
 * ERD Studio's own rules for a `.dbml` table file (§2.2 of the native DBML
 * storage spec): it holds exactly one Table (`notOneTable`), the Table is
 * named as the file (`nameMismatch`, case aside), and it declares nothing a
 * table file may not (`unsupportedElement`: a Project, TableGroup, top-level
 * Note, TablePartial, Records or DiagramView), and a `Metadata` block names
 * a table or column the file declares (`metadataTarget`, D25).
 */
export type DbmlTableStructureRule = 'notOneTable' | 'nameMismatch' | 'unsupportedElement' | 'metadataTarget';

/**
 * What a DBML diagnostic code means, by its range, the same in `@dbml/parse`
 * 9.1, 10.3 and 11.0: 1000–1999 the lexer and parser (`syntax`), 3000–3999
 * the validator (`invalid`), 4000–4001 the binder (`binding`: a name that is
 * not declared), 5000 and up the interpreter. Parser-free.
 */
export type DbmlErrorClass = 'syntax' | 'invalid' | 'binding' | 'interpreter';

/** The {@link DbmlErrorClass} of a DBML diagnostic code. A code outside every range is `invalid`. */
export function dbmlErrorClassOf(code: number): DbmlErrorClass {
  if (code >= 1000 && code < 2000) return 'syntax';
  if (code >= 4000 && code < 5000) return 'binding';
  if (code >= 5000) return 'interpreter';
  return 'invalid';
}

/**
 * DBML codes for an unquoted value in a table file, in the pinned
 * `@dbml/parse` 11.0.0's numbering (10.3.1 shares it): `3025` a column
 * setting, `3075` a table setting. 11.0 reads an unquoted number or boolean,
 * so these are a word, a phrase or `null` (`grain: one row`). Not `3073`,
 * which is a TablePartial error there (9.1.1 numbers its codes differently).
 */
export const DBML_TABLE_QUOTE_HINT_CODES: ReadonlySet<string> = new Set(['3025', '3075']);

/**
 * DBML codes for an unquoted value in a diagram file, in the same numbering:
 * `3063` a Project custom key (every parser wants a quoted string there) and
 * `3051` a Note setting.
 */
export const DBML_DIAGRAM_QUOTE_HINT_CODES: ReadonlySet<string> = new Set(['3063', '3051']);

/** The fix for a value DBML wants quoted, with an example that is an error in every parser. */
export const DBML_QUOTE_HINT = "Quote the value, as in grain: 'One row per order line'.";

/**
 * A `.dbml` table file that could not be read, as a DBML reader reports it to
 * {@link classifyTableLoadError}: the diagnostic's numeric `dbmlCode`, or one of
 * ERD Studio's own `rule`s, and where. `message` is for logs and may quote the
 * file; the classification never reads it.
 */
export class TableDbmlError extends Error {
  readonly dbmlCode?: number;
  readonly rule?: DbmlTableStructureRule;
  readonly line?: number;
  readonly column?: number;
  readonly mergeConflict: boolean;
  /** For the `metadataTarget` rule: the missing table or column. */
  readonly target?: DbmlMetadataTarget;

  constructor(
    message: string,
    options: { dbmlCode?: number; rule?: DbmlTableStructureRule; line?: number; column?: number; mergeConflict?: boolean; target?: DbmlMetadataTarget } = {},
  ) {
    super(message);
    this.name = 'TableDbmlError';
    if (options.dbmlCode !== undefined) this.dbmlCode = options.dbmlCode;
    if (options.rule !== undefined) this.rule = options.rule;
    if (options.target !== undefined) this.target = options.target;
    if (options.line !== undefined) this.line = options.line;
    if (options.column !== undefined) this.column = options.column;
    this.mergeConflict = options.mergeConflict === true;
  }
}

/**
 * The {@link TableLoadError} of a `.dbml` table file: conflict markers are a
 * `dbmlSyntax` with `mergeConflict`; an ERD Studio rule is a `dbmlStructure`
 * with code `structure:<rule>`; a parser code maps by {@link dbmlErrorClassOf}
 * (`syntax` → `dbmlSyntax`, `binding` → `dbmlStructure`, anything else →
 * `dbmlInvalid`) with the code as text.
 */
export function classifyDbmlTableError(error: {
  dbmlCode?: number; rule?: DbmlTableStructureRule; line?: number; column?: number; mergeConflict?: boolean; target?: DbmlMetadataTarget;
}): TableLoadError & { column?: number } {
  const at = {
    ...(error.line !== undefined ? { line: error.line } : {}),
    ...(error.column !== undefined ? { column: error.column } : {}),
  };
  if (error.mergeConflict) {
    return { kind: 'dbmlSyntax', ...(error.line !== undefined ? { line: error.line } : {}), mergeConflict: true };
  }
  if (error.rule !== undefined) {
    return {
      kind: 'dbmlStructure', ...at, code: `structure:${error.rule}`,
      ...(error.rule === 'metadataTarget' && error.target !== undefined ? { target: { ...error.target } } : {}),
    };
  }
  if (typeof error.dbmlCode === 'number' && Number.isFinite(error.dbmlCode)) {
    const errorClass = dbmlErrorClassOf(error.dbmlCode);
    const kind: TableLoadErrorKind = errorClass === 'syntax' ? 'dbmlSyntax' : errorClass === 'binding' ? 'dbmlStructure' : 'dbmlInvalid';
    return { kind, ...at, code: String(error.dbmlCode) };
  }
  return { kind: 'dbmlInvalid', ...at };
}

/**
 * Classify an error thrown while reading or parsing a model file, from its
 * `code` and `linePos` only (never the message, which may quote the file). A
 * Node fs code (`ENOENT`, `EACCES`, …) is a `read`; a YAML code maps through
 * the table above; anything else is `yamlOther`. A file holding git conflict
 * markers is a `yamlOther` with `mergeConflict` and the first marker's line.
 * A {@link TableDbmlError} (a `.dbml` table file) goes through
 * {@link classifyDbmlTableError}.
 */
export function classifyTableLoadError(err: unknown): TableLoadError & { column?: number; code?: string } {
  if (err instanceof TableMergeConflictError) {
    return { kind: 'yamlOther', line: err.line, mergeConflict: true };
  }
  if (err instanceof TableDbmlError) {
    return classifyDbmlTableError(err);
  }
  const e = err as { code?: unknown; linePos?: Array<{ line: number; col: number }> } | null;
  const code = e && typeof e.code === 'string' ? e.code : undefined;
  const pos = e && Array.isArray(e.linePos) ? e.linePos[0] : undefined;
  const isFsError = code !== undefined && /^E[A-Z]+$/.test(code);
  const kind: TableLoadErrorKind = isFsError
    ? 'read'
    : (code !== undefined ? (YAML_ERROR_KINDS[code] ?? 'yamlOther') : 'yamlOther');
  return {
    kind,
    ...(pos ? { line: pos.line, column: pos.col } : {}),
    ...(code !== undefined && !isFsError ? { code } : {}),
  };
}

/** Whether `kind` is one of the `.dbml` table-file kinds. */
function isDbmlKind(kind: TableLoadErrorKind): boolean {
  return kind === 'dbmlSyntax' || kind === 'dbmlInvalid' || kind === 'dbmlStructure';
}

/**
 * One plain phrase for a model file that exists but cannot be read, e.g.
 * `logical-models file has a YAML error on line 4`, or for a `.dbml` table
 * file `table file has a DBML syntax error on line 4`. Built from the kind,
 * code and line only, so it never quotes the file.
 */
export function describeTableLoadError(error: TableLoadError): string {
  if (error.kind === 'read') {
    return 'logical-models file could not be read';
  }
  if (isDbmlKind(error.kind)) {
    return describeDbmlTableLoadError(error);
  }
  if (error.mergeConflict) {
    return error.line !== undefined
      ? `logical-models file has an unresolved git merge conflict on line ${error.line}`
      : 'logical-models file has an unresolved git merge conflict';
  }
  return error.line !== undefined
    ? `logical-models file has a YAML error on line ${error.line}`
    : 'logical-models file has a YAML error';
}

function describeDbmlTableLoadError(error: TableLoadError): string {
  const onLine = error.line !== undefined ? ` on line ${error.line}` : '';
  if (error.mergeConflict) {
    return `table file has an unresolved git merge conflict${onLine}`;
  }
  switch (error.kind) {
    case 'dbmlSyntax':
      return `table file has a DBML syntax error${onLine}`;
    case 'dbmlStructure':
      if (error.code === 'structure:metadataTarget') {
        const named = error.target ? `${error.target.element} '${error.target.name}'` : 'a table or column';
        return `table file has a Metadata block${onLine} that targets ${named}, which this table does not have; rename or remove the block`;
      }
      return `table file must hold exactly one Table that needs no other file${error.line !== undefined ? ` (line ${error.line})` : ''}`;
    default:
      if (error.code !== undefined && DBML_TABLE_QUOTE_HINT_CODES.has(error.code)) {
        return `table file has an unquoted value${onLine}; quote it, as in grain: 'One row per order line'`;
      }
      return `table file is not valid DBML${error.code !== undefined ? ` (${error.code})` : ''}${onLine}`;
  }
}

/** Identity of a relationship: its four endpoints, compared without case. */
export function relationshipKey(rel: Pick<Relationship, 'fromModel' | 'fromColumn' | 'toModel' | 'toColumn'>): string {
  return [rel.fromModel, rel.fromColumn, rel.toModel, rel.toColumn].map((part) => part.toLowerCase()).join('\u0000');
}

/**
 * How a copy of a link stored twice ranks against its other copies: the
 * lowest rank is the one drawn, whatever the file or entry order (#133).
 * First a copy in its home (not one-to-many), then one not leaving its
 * model's whole key (`keyEvidence`: flags, else dbt's tests — choosing
 * between copies changes no data, so this needs no evidence about the other
 * end), then the lowest model name, then the lowest content, then `index`.
 * `fromTable` is the from-model as read (or undefined when it is unknown).
 * Shared by {@link mergeLibraryRelationships} and the DBML relationships
 * reader (`attachRelationships`), which dedupe the same way.
 */
export function libraryCopyRank(
  rel: Relationship,
  fromTable: KeyedTable | undefined,
  index: number,
  dbt?: DbtKeyIndex,
): string {
  return [
    `${rel.cardinality === 'one-to-many' ? 1 : 0}${keyEvidence(fromTable ?? { name: rel.fromModel }, rel.fromColumn, dbt) === 'whole-key' ? 1 : 0}`,
    ...[rel.fromModel, rel.fromColumn, rel.toModel, rel.toColumn].map((part) => part.toLowerCase()),
    // A copy with a role (or a composite key) before its unlabelled twin: the label is information.
    rel.cardinality, rel.role ? `0${rel.role}` : '1', rel.compositeKey ? `0${rel.compositeKey}` : '1',
    // Spelling only splits copies that differ in case; then the index splits identical ones.
    rel.fromModel, rel.fromColumn, rel.toModel, rel.toColumn, String(index).padStart(6, '0'),
  ].join('\u0000');
}

/**
 * The relationships a v5 domain draws (issue #126): its own
 * `logical.relationships`, plus every relationship stored in a model's library
 * file whose two ends are both in the domain. A relationship is defined once
 * in the library and shown by every domain that holds both models.
 *
 * The domain's own entries keep their order (so moving them into the library
 * changes nothing on the canvas) and the library entries follow. When both
 * define the same endpoints, the library's cardinality wins — it is the one
 * every other domain shows too — and the disagreement is warned about.
 * Entries sharing a `compositeKey` are drawn as one composite foreign key
 * when they form a valid one (`assembleGroups`, #133 L2).
 */
export function mergeLibraryRelationships(
  models: readonly SemanticTable[],
  own: readonly Relationship[],
  filePath = '',
  warn: (message: string) => void = () => { /* silent */ },
  /** dbt's tests, the key evidence for a model that flags no key (#133 L1). */
  dbt?: DbtKeyIndex,
): Relationship[] {
  const byName = new Map(models.map((m) => [m.name.toLowerCase(), m]));
  const modelOf = (name: string): SemanticTable | undefined => byName.get(name.toLowerCase());
  const rankOf = (rel: Relationship, index: number): string => libraryCopyRank(rel, modelOf(rel.fromModel), index, dbt);
  type Held = { rel: Relationship; rank: string; at: GroupSource };
  const keep = (map: Map<string, Held>, rel: Relationship, rank: string, at: GroupSource): void => {
    const key = linkKey(rel);
    const held = map.get(key);
    if (!held || rank < held.rank) map.set(key, { rel, rank, at });
  };
  const ranked = new Map<string, Held>();
  for (const model of models) {
    (model.relationships ?? []).forEach((entry, index) => {
      if (!byName.has(entry.toModel.toLowerCase())) return;
      const rel = { fromModel: model.name, ...entry };
      keep(ranked, rel, rankOf(rel, index), { source: 'lib', file: model.name.toLowerCase(), index });
    });
  }
  // The domain file's own copies of one link are drawn once too, from the
  // same ranking, at the place of the first.
  const ownRanked = new Map<string, Held>();
  own.forEach((rel, index) => keep(ownRanked, rel, rankOf(rel, index), { source: 'dom', file: '', index }));
  const drawn: Array<{ rel: Relationship; at: GroupSource }> = [];
  const seen = new Set<string>();
  for (const first of own) {
    const key = linkKey(first);
    if (seen.has(key)) continue;
    seen.add(key);
    const { rel, at } = ownRanked.get(key)!;
    const shared = ranked.get(key);
    if (!shared) {
      drawn.push({ rel, at });
      continue;
    }
    // Stored the other way round in the library (#133): the same link, read
    // from the other end. The library's entry is the one drawn.
    if (relationshipKey(shared.rel) !== relationshipKey(rel)) {
      drawn.push({ rel: shared.rel, at: shared.at });
      continue;
    }
    if (shared.rel.cardinality !== rel.cardinality) {
      warn(
        `Relationship ${rel.fromModel}.${rel.fromColumn} → ${rel.toModel}.${rel.toColumn} in ${filePath} ` +
        `is ${rel.cardinality}, but the table library defines it as ${shared.rel.cardinality}; using ${shared.rel.cardinality}`,
      );
    }
    // The library's definition, at the domain entry's place.
    const { compositeKey: _own, ...rest } = rel;
    drawn.push({
      rel: {
        ...rest, cardinality: shared.rel.cardinality,
        ...(shared.rel.role ? { role: shared.rel.role } : {}),
        ...(shared.rel.compositeKey ? { compositeKey: shared.rel.compositeKey } : {}),
      },
      at: shared.at,
    });
  }
  for (const [key, held] of ranked) {
    if (!seen.has(key)) drawn.push({ rel: held.rel, at: held.at });
  }
  // Every end is drawn with the real model and column spelling (L4).
  return assembleGroups(drawn, filePath, warn).map((rel) => respellRelationship(rel, models));
}

/** Where a drawn relationship is stored: the library (a model's file) or the domain file, and its entry index there. */
interface GroupSource {
  source: 'lib' | 'dom';
  /** The library model whose file holds it, lowercased ('' for the domain file). */
  file: string;
  index: number;
}

/**
 * Composite foreign keys among the drawn relationships (#133 L2). Entries
 * sharing a `compositeKey` in one source — the library, from one canonical
 * model, or the domain file, from one model — are one composite when
 * `compositeGroupProblem` finds nothing wrong: they keep the key, spelled as
 * on the member stored first, all carry that member's role, and sit together
 * at the first one's place. Otherwise the key is dropped from what is drawn,
 * once with a warning, and each draws as a single link; nothing on disk
 * changes.
 */
function assembleGroups(
  drawn: ReadonlyArray<{ rel: Relationship; at: GroupSource }>,
  filePath: string,
  warn: (message: string) => void,
): Relationship[] {
  const groups = new Map<string, Array<{ rel: Relationship; at: GroupSource }>>();
  for (const item of drawn) {
    if (!item.rel.compositeKey) continue;
    const owner = item.at.source === 'lib' ? canonicalRelationship(item.rel).fromModel : item.rel.fromModel;
    const id = `${item.at.source}:${owner.toLowerCase()}:${item.rel.compositeKey.toLowerCase()}`;
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  if (groups.size === 0) return drawn.map((d) => d.rel);
  const byFile = (a: { at: GroupSource }, b: { at: GroupSource }): number =>
    (a.at.file < b.at.file ? -1 : a.at.file > b.at.file ? 1 : a.at.index - b.at.index);
  const replaced = new Map<Relationship, Relationship[] | null>();
  for (const members of groups.values()) {
    const ordered = [...members].sort(byFile);
    const problem = compositeGroupProblem(ordered.map((m) => m.rel));
    if (problem) {
      const key = ordered[0].rel.compositeKey;
      warn(`Relationships in ${ordered[0].at.source === 'lib' ? `${ordered[0].rel.fromModel}'s model file` : filePath} ` +
        `marked compositeKey "${key}" do not form one composite key (${problem}); drawn separately`);
      for (const m of members) {
        const { compositeKey: _dropped, ...single } = m.rel;
        replaced.set(m.rel, [single]);
      }
      continue;
    }
    const head = ordered[0].rel;
    // Every member read the way the first is (one line, one direction), its meaning unchanged.
    const unified = ordered.map(({ rel }) => {
      const { role: _role, ...rest } = rel.fromModel.toLowerCase() === head.fromModel.toLowerCase() ? rel : reverseRelationship(rel);
      return { ...rest, compositeKey: head.compositeKey!, ...(head.role ? { role: head.role } : {}) };
    });
    // The whole group is placed where its first drawn member falls.
    const first = drawn.find((d) => members.some((m) => m.rel === d.rel))!.rel;
    for (const m of members) replaced.set(m.rel, m.rel === first ? unified : null);
  }
  return drawn.flatMap(({ rel }) => {
    const r = replaced.get(rel);
    return r === undefined ? [rel] : r ?? [];
  });
}

/**
 * Validate the relationships array entry-by-entry. Entries missing any of the
 * four string endpoints are dropped with a warning; an unrecognised
 * cardinality falls back to many-to-one.
 */
function parseRelationships(value: unknown, filePath: string, warn: (message: string) => void): Relationship[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const relationships: Relationship[] = [];
  for (const entry of value) {
    const r = entry as Record<string, unknown> | null;
    if (
      !r || typeof r !== 'object' || Array.isArray(r) ||
      typeof r.fromModel !== 'string' || typeof r.fromColumn !== 'string' ||
      typeof r.toModel !== 'string' || typeof r.toColumn !== 'string'
    ) {
      warn(`Skipping malformed relationship entry in ${filePath}: ${JSON.stringify(entry)}`);
      continue;
    }

    const cardinality = VALID_CARDINALITIES.has(r.cardinality as Cardinality)
      ? (r.cardinality as Cardinality)
      : 'many-to-one';
    if (cardinality !== r.cardinality) {
      warn(
        `Relationship ${r.fromModel}.${r.fromColumn} → ${r.toModel}.${r.toColumn} in ${filePath} ` +
        `has invalid cardinality ${JSON.stringify(r.cardinality)}; defaulting to many-to-one`,
      );
    }

    const { role: _role, compositeKey: _compositeKey, ...rest } = r as unknown as Relationship;
    const role = normaliseRelationshipRole(r.role);
    const compositeKey = normaliseCompositeKey(r.compositeKey);
    relationships.push({
      ...rest,
      cardinality,
      ...(role ? { role } : {}),
      ...(compositeKey ? { compositeKey } : {}),
    });
  }
  return relationships;
}

function parseViewConfig(value: unknown, warn: (message: string) => void): ViewConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const obj = value as Record<string, unknown>;
  return {
    showFkEdges: typeof obj.showFkEdges === 'boolean' ? obj.showFkEdges : undefined,
    layoutOptions: obj.layoutOptions && typeof obj.layoutOptions === 'object' && !Array.isArray(obj.layoutOptions)
      ? (obj.layoutOptions as Record<string, string>)
      : undefined,
    positions: obj.positions && typeof obj.positions === 'object' && !Array.isArray(obj.positions)
      ? parsePositions(obj.positions as Record<string, unknown>, warn)
      : undefined,
    annotations: Array.isArray(obj.annotations)
      ? (obj.annotations as unknown[]).filter(
          (a): a is Annotation => {
            const r = a as Record<string, unknown>;
            return typeof r?.id === 'string' && typeof r?.x === 'number' && typeof r?.y === 'number';
          },
        )
      : undefined,
  };
}

/**
 * Keep only position entries with finite numeric x/y. Malformed entries
 * (string coordinates, null, non-objects) are dropped so the model is
 * auto-positioned instead of reaching the canvas with NaN coordinates.
 */
function parsePositions(value: Record<string, unknown>, warn: (message: string) => void): Record<string, NodePosition> {
  const positions: Record<string, NodePosition> = {};
  for (const [name, entry] of Object.entries(value)) {
    const p = entry as Record<string, unknown> | null;
    if (
      p && typeof p === 'object' && !Array.isArray(p) &&
      typeof p.x === 'number' && Number.isFinite(p.x) &&
      typeof p.y === 'number' && Number.isFinite(p.y)
    ) {
      positions[name] = { x: p.x, y: p.y };
    } else {
      warn(`Ignoring malformed viewConfig.positions entry for "${name}"`);
    }
  }
  return positions;
}
