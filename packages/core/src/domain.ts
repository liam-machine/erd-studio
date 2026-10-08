/**
 * Domain JSON -> UnifiedDomain, without touching a file system.
 *
 * The extension host's DomainService reads the file and hands the text here;
 * other hosts (a browser, a server reading from a git provider) do the same
 * with whatever `readFile` they have. The parsing, validation and repair
 * rules — and every message they produce — live in this one place, so every
 * host shows the same domain for the same file.
 */

import type {
  Cardinality,
  DomainFormat,
  Layer,
  ModelLoadError,
  ModelLoadErrorKind,
  NodePosition,
  Relationship,
  SemanticDomain,
  SemanticModel,
  StageData,
  UnreadableModelPlaceholder,
  UnifiedDomain,
  ViewConfig,
  Annotation,
} from './types/semantic.js';
import { CURRENT_SCHEMA_VERSION, describeUnsupportedDomainFormat, detectDomainFormat } from './types/semantic.js';
import { LOGICAL_MODELS_DIR } from './logicalModel.js';
import { linkKey, normaliseRelationshipRole, respellRelationship } from './relationships.js';
import { keyEvidence } from './keyEvidence.js';
import type { DbtKeyIndex } from './keyEvidence.js';

/**
 * Sub-directories of the semantic dir that never contain domain files.
 *
 * The single source of truth for "is this `{semanticDir}/x/y.json` a domain?".
 * The watcher classifies delete events through it, and the custom editor
 * refuses to render a canvas for anything it excludes — a template opened from
 * the explorer is a JSON file to edit, not a diagram to draw.
 */
export const NON_DOMAIN_DIRS: ReadonlySet<string> = new Set([
  'templates', LOGICAL_MODELS_DIR, 'logical', 'physical',
]);

/** Why a domain file could not be turned into a `UnifiedDomain`. */
export type DomainFileErrorReason = 'missing' | 'unreadable' | 'empty' | 'invalid-json';

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
 */
export class DomainFileError extends Error {
  readonly transient: boolean;

  constructor(
    readonly reason: DomainFileErrorReason,
    readonly filePath: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainFileError';
    this.transient = reason === 'empty' || reason === 'invalid-json';
  }
}

/**
 * A domain file that parsed as JSON but is not a domain this version can load:
 * not an object, no usable `schemaVersion`, a newer schema, a legacy or hybrid
 * layout, or a layer that is not configured.
 *
 * Its `name` is deliberately left as `Error`, so logs that print the error
 * read exactly as they did when these were plain `Error`s.
 */
export class DomainValidationError extends Error {}

export const VALID_CARDINALITIES: ReadonlySet<Cardinality> = new Set<Cardinality>([
  'many-to-one', 'one-to-one', 'one-to-many', 'many-to-many',
]);

/**
 * Parse the text of a domain file.
 *
 * Throws a transient `DomainFileError` for an empty file ('empty') and for
 * text that is not JSON ('invalid-json'). Reading the file — and the
 * 'missing' / 'unreadable' failures — is the caller's job.
 */
export function parseDomainJson(raw: string, filePath: string): unknown {
  if (raw.trim() === '') {
    // Almost always a file mid-creation: the create event lands a zero-byte
    // file and the content follows milliseconds later. Say what is true of
    // the file rather than echoing "Unexpected end of JSON input", which
    // reads as corruption when nothing is corrupt.
    throw new DomainFileError('empty', filePath, `Domain file is empty: ${filePath}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DomainFileError(
      'invalid-json',
      filePath,
      `Invalid JSON in domain file ${filePath}: ${message}`,
    );
  }
}

/**
 * Check that parsed JSON is a domain document this version can load, and
 * work out its format. Throws `DomainValidationError` otherwise.
 */
export function validateDomainDocument(
  data: unknown,
  filePath: string,
): { obj: Record<string, unknown>; format: DomainFormat } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new DomainValidationError(`Domain file ${filePath} does not contain a JSON object`);
  }

  const obj = data as Record<string, unknown>;

  // Schema version check
  if (typeof obj.schemaVersion !== 'number') {
    throw new DomainValidationError(
      `Domain file ${filePath} is missing a valid "schemaVersion" field`
    );
  }

  if (obj.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new DomainValidationError(
      `Domain file ${filePath} has schemaVersion ${obj.schemaVersion} ` +
      `but this extension only supports up to version ${CURRENT_SCHEMA_VERSION}. ` +
      'Please update the extension.'
    );
  }

  // Format check — legacy (pre-v4) and hybrid (mixed / self-contradicting)
  // documents are rejected with a remediation hint rather than silently
  // loaded as an empty or half-resolved domain.
  const format = detectDomainFormat(obj);
  const unsupported = describeUnsupportedDomainFormat(format, filePath);
  if (unsupported) {
    throw new DomainValidationError(unsupported);
  }

  return { obj, format };
}

/** The configured layers, as far as domain loading needs them. */
export interface LayerLookup {
  hasLayer(id: string): boolean;
  getValidLayerIds(): string[];
}

/**
 * The layer a domain belongs to: its `layer` field when that is configured,
 * otherwise the name of the directory it sits in. Throws
 * `DomainValidationError` when neither is a configured layer.
 */
export function resolveDomainLayer(
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
  throw new DomainValidationError(
    `Domain file ${filePath} has invalid layer "${String(value)}". ` +
    `Expected one of: ${validLayers}`,
  );
}

/** What `buildUnifiedDomain` needs from its host. */
export interface BuildUnifiedDomainContext {
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
  getModel?: (name: string) => SemanticModel | null;
  /**
   * Asked only when `getModel` returned null: why that model's file, if it
   * exists, could not be read. A non-null answer is attached to the
   * placeholder as `loadError` and names the error in the warning instead of
   * reporting the model as missing.
   */
  getModelError?: (name: string) => ModelLoadError | null;
  /** Receives repair warnings (dropped entries, defaulted values). Defaults to console.warn. */
  warn?: (message: string) => void;
  /**
   * What dbt's tests say about keys (#133 L1): how the read winner tells a
   * link's copies apart when no key is flagged. Without it, flags only.
   */
  dbtKeyIndex?: DbtKeyIndex;
}

/**
 * Turn a validated domain document into a `UnifiedDomain`: resolve the layer,
 * the global view config, `stubColumns` and the logical stage, repairing or
 * dropping malformed entries with a warning rather than failing the domain.
 */
export function buildUnifiedDomain(
  obj: Record<string, unknown>,
  format: DomainFormat,
  ctx: BuildUnifiedDomainContext,
): UnifiedDomain {
  const warn = ctx.warn ?? ((message: string) => console.warn(message));
  const { filePath } = ctx;

  const domain = typeof obj.domain === 'string' ? obj.domain : ctx.domainNameFallback;
  const layer = resolveDomainLayer(obj.layer, filePath, ctx.parentDirName, ctx.layers);

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
 * Project a `UnifiedDomain` onto its logical stage.
 *
 * Physical stages are derived from the dbt project by the extension host and
 * are not produced here.
 */
export function toLogicalStage(unified: UnifiedDomain): SemanticDomain {
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
 * Handles both v4 (inline SemanticModel[]) and v5 (string[] name references)
 * as decided by {@link detectDomainFormat} — hybrid/legacy documents are
 * rejected before this point, so every entry is guaranteed to match `format`.
 * For v5, resolves model names through `getModel`.
 * Returns null if the section is missing or invalid.
 */
function parseStageData(
  value: unknown,
  format: DomainFormat,
  filePath: string,
  getModel: ((name: string) => SemanticModel | null) | undefined,
  getModelError: ((name: string) => ModelLoadError | null) | undefined,
  warn: (message: string) => void,
  dbt?: DbtKeyIndex,
): StageData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const rawModels = Array.isArray(obj.models) ? obj.models : [];
  const relationships = parseRelationships(obj.relationships, filePath, warn);

  let models: SemanticModel[];
  if (format === 'v5') {
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
            warn(`Model "${name}": ${describeModelLoadError(loadError)}`);
            const placeholder: UnreadableModelPlaceholder = { name, columns: [], loadError: { ...loadError } };
            models.push(placeholder);
          } else {
            warn(`Model "${name}" not found in logical-models/`);
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
        models.push(candidate as unknown as SemanticModel);
      } else {
        warn(`Skipping inline model without a string "name" in ${filePath}`);
      }
    }
  }

  return { models, relationships: relationships.map((rel) => respellRelationship(rel, models)) };
}

/** The YAML parser's error codes, grouped into the kinds the UI and telemetry use. */
const YAML_ERROR_KINDS: Readonly<Record<string, ModelLoadErrorKind>> = {
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
 * Classify an error thrown while reading or parsing a model file, from its
 * `code` and `linePos` only (never the message, which may quote the file). A
 * Node fs code (`ENOENT`, `EACCES`, …) is a `read`; a YAML code maps through
 * the table above; anything else is `yamlOther`.
 */
export function classifyModelLoadError(err: unknown): ModelLoadError & { column?: number; code?: string } {
  const e = err as { code?: unknown; linePos?: Array<{ line: number; col: number }> } | null;
  const code = e && typeof e.code === 'string' ? e.code : undefined;
  const pos = e && Array.isArray(e.linePos) ? e.linePos[0] : undefined;
  const isFsError = code !== undefined && /^E[A-Z]+$/.test(code);
  const kind: ModelLoadErrorKind = isFsError
    ? 'read'
    : (code !== undefined ? (YAML_ERROR_KINDS[code] ?? 'yamlOther') : 'yamlOther');
  return {
    kind,
    ...(pos ? { line: pos.line, column: pos.col } : {}),
    ...(code !== undefined && !isFsError ? { code } : {}),
  };
}

/**
 * One plain phrase for a model file that exists but cannot be read, e.g.
 * `logical-models file has a YAML error on line 4`. Built from the kind and
 * line only, so it never quotes the file.
 */
export function describeModelLoadError(error: ModelLoadError): string {
  if (error.kind === 'read') {
    return 'logical-models file could not be read';
  }
  return error.line !== undefined
    ? `logical-models file has a YAML error on line ${error.line}`
    : 'logical-models file has a YAML error';
}

/** Identity of a relationship: its four endpoints, compared without case. */
export function relationshipKey(rel: Pick<Relationship, 'fromModel' | 'fromColumn' | 'toModel' | 'toColumn'>): string {
  return [rel.fromModel, rel.fromColumn, rel.toModel, rel.toColumn].map((part) => part.toLowerCase()).join('\u0000');
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
 */
export function mergeLibraryRelationships(
  models: readonly SemanticModel[],
  own: readonly Relationship[],
  filePath = '',
  warn: (message: string) => void = () => { /* silent */ },
  /** dbt's tests, the key evidence for a model that flags no key (#133 L1). */
  dbt?: DbtKeyIndex,
): Relationship[] {
  const byName = new Map(models.map((m) => [m.name.toLowerCase(), m]));
  const modelOf = (name: string): SemanticModel | undefined => byName.get(name.toLowerCase());
  // A link stored twice is drawn from the same copy whatever the file or
  // entry order (#133): one in its home (not one-to-many), then one not
  // leaving its model's whole key (`keyEvidence`: flags, else dbt's tests —
  // choosing between copies changes no data, so this needs no evidence about
  // the other end), then the lowest model name, then the lowest content.
  const rankOf = (rel: Relationship, index: number): string => [
    `${rel.cardinality === 'one-to-many' ? 1 : 0}${keyEvidence(modelOf(rel.fromModel) ?? { name: rel.fromModel }, rel.fromColumn, dbt) === 'whole-key' ? 1 : 0}`,
    ...[rel.fromModel, rel.fromColumn, rel.toModel, rel.toColumn].map((part) => part.toLowerCase()),
    // A copy with a role before its unlabelled twin: the label is information.
    rel.cardinality, rel.role ? `0${rel.role}` : '1',
    // Spelling only splits copies that differ in case; then the index splits identical ones.
    rel.fromModel, rel.fromColumn, rel.toModel, rel.toColumn, String(index).padStart(6, '0'),
  ].join('\u0000');
  const ranked = new Map<string, { rel: Relationship; rank: string }>();
  const keep = (map: Map<string, { rel: Relationship; rank: string }>, rel: Relationship, rank: string): void => {
    const key = linkKey(rel);
    const held = map.get(key);
    if (!held || rank < held.rank) map.set(key, { rel, rank });
  };
  for (const model of models) {
    (model.relationships ?? []).forEach((entry, index) => {
      if (!byName.has(entry.toModel.toLowerCase())) return;
      const rel = { fromModel: model.name, ...entry };
      keep(ranked, rel, rankOf(rel, index));
    });
  }
  const library = new Map([...ranked].map(([key, { rel }]) => [key, rel]));
  // The domain file's own copies of one link are drawn once too, from the
  // same ranking, at the place of the first.
  const ownRanked = new Map<string, { rel: Relationship; rank: string }>();
  own.forEach((rel, index) => keep(ownRanked, rel, rankOf(rel, index)));
  // Every end is drawn with the real model and column spelling (L4).
  const spelled = (rels: Relationship[]): Relationship[] => rels.map((rel) => respellRelationship(rel, models));
  if (library.size === 0) {
    const drawn: Relationship[] = [];
    for (const rel of own) {
      const winner = ownRanked.get(linkKey(rel));
      if (winner && !drawn.includes(winner.rel)) drawn.push(winner.rel);
    }
    return spelled(drawn);
  }

  const merged: Relationship[] = [];
  const seen = new Set<string>();
  for (const first of own) {
    const key = linkKey(first);
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = ownRanked.get(key)!.rel;
    const shared = library.get(key);
    // Stored the other way round in the library (#133): the same link, read
    // from the other end. The library's entry is the one drawn.
    if (shared && relationshipKey(shared) !== relationshipKey(rel)) {
      merged.push(shared);
      continue;
    }
    if (shared && shared.cardinality !== rel.cardinality) {
      warn(
        `Relationship ${rel.fromModel}.${rel.fromColumn} → ${rel.toModel}.${rel.toColumn} in ${filePath} ` +
        `is ${rel.cardinality}, but logical-models/ defines it as ${shared.cardinality}; using ${shared.cardinality}`,
      );
    }
    merged.push(shared ? { ...rel, cardinality: shared.cardinality, ...(shared.role ? { role: shared.role } : {}) } : rel);
  }
  for (const [key, rel] of library) {
    if (!seen.has(key)) merged.push(rel);
  }
  return spelled(merged);
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

    const { role: _role, ...rest } = r as unknown as Relationship;
    const role = normaliseRelationshipRole(r.role);
    relationships.push({
      ...rest,
      cardinality,
      ...(role ? { role } : {}),
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
