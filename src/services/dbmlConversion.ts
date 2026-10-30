/**
 * Convert Project to DBML (native DBML storage, §6.1 and D22 of
 * docs/plans/native-dbml-storage.md): the pure planner and the describer the
 * command's modal and `erd-studio doctor`'s preview share.
 *
 * {@link planDbmlConversion} takes the text of every file under the semantic
 * dir the classifier names (YAML tables, JSON diagrams and, in a mixed or
 * half-converted project, the DBML files already there) and returns the
 * creates, replaces and deletes that store the project as DBML. It never
 * guesses: a file it cannot read or write as DBML is left exactly as it is
 * (`leftAsIs`; running it again after the fix finishes the job), lossless
 * fixes are applied and listed (`handled`), a diagram member with no table
 * file stays on the diagram (`keptMissing`, D26) and a relationship that
 * cannot be a live Ref yet is a pending line (D27). It refuses only when
 * nothing can convert (a layer called `tables`) or its self-check fails
 * (step 8: every DBML file after the plan compiles, and every diagram draws
 * what it drew before, through the one storage-equivalence comparator). The
 * same input always gives the same plan.
 *
 * Tables are written by core's `renderNewTableDbml`, relationships only
 * through `planDbmlLibraryWrites` (§4.6), and diagrams, their positions in
 * the Project's `erd_layout`, by `renderNewSubjectAreaDbml`. No
 * `vscode`, no `fs`: the CLI bundles it.
 */

import { createHash } from 'crypto';

import { Parser, isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { Node as YamlNode, Pair } from 'yaml';

import {
  DBML_RELATIONSHIPS_FILE_NAME,
  RATIONALE_KEYS,
  SubjectAreaFileError,
  TABLES_DIR,
  canonicalRelationship,
  classifySemanticFile,
  dbmlName,
  describeUnsupportedSubjectAreaFormat,
  detectSubjectAreaFormat,
  ERD_LAYOUT_NOTE_PREFIX,
  isErdLayoutName,
  isReservedTableName,
  libraryCopyRank,
  linkKey,
  loadDisplaySubjectArea,
  normaliseForStorageEquivalence,
  parseLayersText,
  parseSubjectAreaJson,
  parseTableText,
  subjectAreaViewConfig,
  validateSubjectAreaDocument,
} from '@erd-studio/core';
import type {
  Annotation,
  DbmlAttachTable,
  DbmlStorageReader,
  DbmlDiagnostic,
  DbmlRelationshipsReading,
  NodePosition,
  Relationship,
  SemanticFileKind,
  SemanticTable,
  TableRelationship,
} from '@erd-studio/core';
import {
  DbmlEditRefused,
  attachRelationships,
  compileDbmlProject,
  dbmlStorageReader,
  dbmlTableLookup,
  parseSubjectAreaDbml,
  parseTableDbml,
  pendingRelationshipRef,
  readRelationshipsDbml,
  subjectAreaMembersDbml,
} from '@erd-studio/core/dbml';
import { canonicalDbml, editSubjectAreaDbml, formatWrittenDbml, renderNewSubjectAreaDbml, renderNewTableDbml } from './dbmlWriters';

import { DbmlFileCompileMemo, compileDbmlFilesSeparately, compileDbmlFilesSeparatelyAsync } from './dbmlFileCompile';
import { planDbmlLibraryWrites } from './dbmlLibraryWrites';
import type { DbmlLibrarySnapshot, DbmlLibraryWritePlan, DbmlSnapshotTable } from './dbmlLibraryWrites';
import { planMoveToLibrary } from './libraryRelationships';
import { jsonMistakeAt } from './commandErrors';

/**
 * Whether an existing DBML table file already holds what Convert writes
 * there (an earlier, half-applied run): the same bytes, or the same table in
 * an older layout. 1.9.x wrote the body Note last and the column `note`
 * before the other settings, without aligning: the same table, from the same
 * characters in another order and spacing. Anything else (a comment or a
 * setting added by hand, a value changed) is other contents.
 */
export function sameConvertedTable(existing: string, planned: string, stem: string): boolean {
  if (existing === planned) return true;
  const characters = (text: string): string => [...text.replace(/^\uFEFF/, '').replace(/\s+/g, '')].sort().join('');
  if (characters(existing) !== characters(planned)) return false;
  const a = parseTableDbml(existing, stem);
  const b = parseTableDbml(planned, stem);
  return a.ok && b.ok && a.writable && a.declaredName === b.declaredName && JSON.stringify(a.table) === JSON.stringify(b.table);
}

// ---------------------------------------------------------------------------
// Input and plan
// ---------------------------------------------------------------------------

/** One file under the semantic dir, as `dbmlConversionFiles.ts` reads it. */
export interface DbmlConversionFile {
  /** Relative to the semantic dir, posix. */
  path: string;
  /** Its text, byte-order mark stripped. */
  text: string;
  hadBom: boolean;
  kind: SemanticFileKind;
  storage?: 'yaml' | 'json' | 'dbml';
}

export interface DbmlConversionInput {
  /** The semantic dir, for messages only. */
  semanticDir: string;
  /** Layer ids (layers.json or the defaults). */
  layers: string[];
  tablesDirIsLayer: boolean;
  /**
   * Every file under the semantic dir the classifier names (§3.5), with its
   * text: `.yml` tables, `.json` diagrams, `layers.json` and, in a mixed or
   * half-converted project, the `.dbml` tables, relationships files and
   * `.dbml` diagrams already there. The listing is also the
   * resolver of the self-check.
   */
  files: DbmlConversionFile[];
  /**
   * Table files in the library whose name ends in `.yaml`, or `.yml` in
   * another case (`.YML`), with the table each holds: ERD Studio's library
   * never lists them, so Convert leaves each with what to rename it to.
   * Optional (absent: none).
   */
  misnamedTables?: Array<{ path: string; name: string }>;
}

export interface DbmlConversionPlan {
  /** Tables, relationships files and diagrams (paths relative to the semantic dir). */
  creates: Array<{ path: string; text: string }>;
  /** Existing relationships files and DBML diagrams that gain Refs or `use` lines (mixed projects). */
  replaces: Array<{ path: string; text: string }>;
  /** Every converted `.yml` and `.json`. */
  deletes: string[];
  /** Targets already on disk with exactly the planned bytes (a half-applied earlier run): neither created nor refused. */
  resumed: string[];
  /**
   * Non-empty: nothing is written. Only where leaving a file as it is would
   * not help: a layer called `tables`; an existing DBML table or
   * relationships file Convert must change but cannot (one that holds a
   * self-join or a disagreeing composite included); and the self-check and
   * its round limit (an ERD Studio bug). Everything else is converted,
   * handled or left as is.
   */
  refusals: string[];
  /** Lossless, deterministic fixes Convert applies (§6.1, D27): "Handled for you". */
  handled: Array<{ path: string; text: string }>;
  /**
   * Files Convert leaves exactly as they are until they are fixed (a YAML
   * table or JSON diagram it cannot read or write as DBML, or a DBML file it
   * cannot edit), with the problem and its line. The project is `mixed`
   * (D20) until they are fixed and Convert runs again.
   */
  leftAsIs: Array<{ path: string; line?: number; problem: string }>;
  /**
   * Diagram members with no table file anywhere (D26), per converted diagram
   * (its `.dbml` path): kept on the diagram, drawn as missing exactly as
   * before, in the Project's `erd_unlinked_tables`.
   */
  keptMissing: Array<{ diagram: string; tables: string[] }>;
  /** Lossy-but-kept items and behaviour changes. */
  notes: string[];
  /** Diagrams still in schema v4: the v4 → v5 step first. */
  v4SubjectAreas: string[];
  /** Relationships a diagram file held, now in the library, and the other diagrams where they now also draw. */
  movedRelationships: Array<{ from: string; to: string; diagrams: string[] }>;
  /**
   * Converted diagrams (their new `.dbml` paths) whose layout places every one
   * of their tables, so opening one in the canvas writes nothing: no ELK auto
   * layout and no auto-placed new tables. Undo of the conversion is one step
   * from such a canvas; any other diagram's first open saves a layout on top.
   */
  placedDiagrams: string[];
  summary: { tables: number; diagrams: number; relationshipsFiles: number; relationships: number; pending?: number };
}

/**
 * How every self-check refusal ends: the planned DBML would not compile, load
 * or draw the same. These are ERD Studio's own bugs, not something in the
 * user's files, so the Convert panel words them differently and offers Send Feedback.
 */
export const DBML_SELF_CHECK_REFUSAL_END = 'Nothing was changed; please report this with the file.';

/** Whether a refusal is the planner's self-check (ERD Studio's bug), not a problem the user can fix. */
export function isDbmlSelfCheckRefusal(refusal: string): boolean {
  return refusal.endsWith(DBML_SELF_CHECK_REFUSAL_END);
}

/** What the planner is doing, for a progress message. */
export type DbmlConversionPhase = 'planning' | 'checking';

/** Test seams, and the hooks a long plan reports through. */
export interface DbmlConversionOptions {
  /**
   * The multi-file compile of the self-check: `compileDbmlProject`'s contract.
   * Default: `compileDbmlFilesSeparately` (the same diagnostics, file by file,
   * in time that grows with the project rather than its square).
   */
  compile?: (files: Readonly<Record<string, string>>, entries: readonly string[]) => Record<string, DbmlDiagnostic[]> | Promise<Record<string, DbmlDiagnostic[]>>;
  /** Called as each phase starts (it may be called again for another round). */
  onPhase?: (phase: DbmlConversionPhase) => void | Promise<void>;
  /**
   * Awaited every few tens of milliseconds of planning, so the extension host
   * can handle other events (a progress notification, its Cancel button). It
   * may throw to stop the plan; the error reaches the caller and nothing is planned.
   */
  pause?: () => Promise<void>;
}

/** How long the planner works between two {@link DbmlConversionOptions.pause}s. */
const PAUSE_EVERY_MS = 50;

/** An awaitable that calls `pause` when {@link PAUSE_EVERY_MS} have passed since the last time (nothing without one). */
function breather(pause: DbmlConversionOptions['pause']): () => Promise<void> {
  let last = Date.now();
  return async () => {
    if (!pause || Date.now() - last < PAUSE_EVERY_MS) return;
    await pause();
    last = Date.now();
  };
}

/** The comment block's first line (§2.8). */
export function keptFromLine(oldPath: string): string {
  return `// Kept from ${oldPath} by Convert Project to DBML:`;
}

/** Whether the plan writes anything. (A plan that writes nothing may still list files left as they are.) */
/**
 * The heading for the files Convert leaves as they are, by their own format:
 * "Left as YAML until fixed" (tables), "Left as JSON until fixed"
 * (diagrams), or "Left as they are until fixed" for a mix or an existing
 * `.dbml` file.
 */
export function dbmlLeftAsIsTitle(left: ReadonlyArray<{ path: string }>): string {
  const kinds = new Set(left.map((l) => (/\.ya?ml$/i.test(l.path) ? 'YAML' : /\.json$/i.test(l.path) ? 'JSON' : 'other')));
  return kinds.size === 1 && !kinds.has('other') ? `Left as ${[...kinds][0]} until fixed` : 'Left as they are until fixed';
}

export function dbmlConversionIsEmpty(plan: DbmlConversionPlan): boolean {
  return plan.creates.length === 0 && plan.replaces.length === 0 && plan.deletes.length === 0;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const lower = (s: string): string => s.toLowerCase();
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function stemOf(p: string): string {
  const file = p.slice(p.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot <= 0 ? file : file.slice(0, dot);
}

function dirOf(p: string): string {
  const at = p.lastIndexOf('/');
  return at < 0 ? '' : p.slice(0, at);
}

/** `a.b → c.d` (columns in brackets for a composite). */
function describeEnds(from: string, fromColumns: readonly string[], to: string, toColumns: readonly string[]): string {
  const cols = (cs: readonly string[]): string => (cs.length === 1 ? cs[0] : `(${cs.join(', ')})`);
  return `${from}.${cols(fromColumns)} → ${to}.${cols(toColumns)}`;
}

/** A deterministic UUID for a duplicate sticky-note id, so a re-plan (and a resume) writes the same bytes. */
function derivedUuid(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The first place two JSON values differ, as a dotted path with both values. */
function firstDifference(a: unknown, b: unknown, at = ''): string | null {
  if (a === b) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      const d = firstDifference(a[key], b[key], at ? `${at}.${key}` : key);
      if (d !== null) return d;
    }
    return null;
  }
  const show = (v: unknown): string => (v === undefined ? 'nothing' : JSON.stringify(v));
  return `${at || 'the diagram'}: ${show(a)} before, ${show(b)} after`;
}

// ---------------------------------------------------------------------------
// The comment block (§2.8): what ERD Studio does not read, kept as `//` lines
// ---------------------------------------------------------------------------

const TABLE_KEYS = new Set(['name', 'schema', 'alias', 'description', 'grain', 'modelRole', 'tableRole', 'rationale', 'meta', 'columns', 'relationships']);
const COLUMN_KEYS = new Set(['name', 'dataType', 'data_type', 'description', 'isPrimaryKey', 'isForeignKey', 'isNaturalKey', 'scdType', 'additiveType', 'meta']);
const RELATIONSHIP_KEYS = new Set(['fromModel', 'fromTable', 'fromColumn', 'toModel', 'toTable', 'toColumn', 'cardinality', 'role', 'compositeKey']);
const RATIONALE_KEY_SET = new Set<string>(RATIONALE_KEYS);

interface KeptLines {
  /** The comment block (each line already `// `-prefixed, the header first), or [] when nothing is kept. */
  block: string[];
  comments: boolean;
  unknownKeys: string[];
  /** Known keys holding a value ERD Studio does not read (it ignores them), e.g. `relationships[2]`, `rationale`. */
  ignoredValues: string[];
  anchors: boolean;
}

const YAML_CARDINALITIES: ReadonlySet<string> = new Set(['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many']);
const isPlainMap = (v: unknown): v is Record<string, unknown> => isObject(v) && Object.getPrototypeOf(v) === Object.prototype;
const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Whether core's model-file reader takes this `relationships:` entry (`readRelationships`: three non-empty string ends). */
function readsAsRelationship(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  const toModel = typeof entry.toTable === 'string' ? entry.toTable : entry.toModel;
  return nonEmptyString(entry.fromColumn) && nonEmptyString(toModel) && nonEmptyString(entry.toColumn);
}

/** Line index (0-based) of an offset. */
function lineIndexAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** The 1-based line of a YAML node (`at`: keys and list indexes from the root), or undefined. */
function yamlLineOf(text: string, at: ReadonlyArray<string | number>): number | undefined {
  try {
    const node = parseDocument(text, { uniqueKeys: false }).getIn(at, true);
    return isNode(node) && node.range ? lineIndexAt(lineStarts(text), node.range[0]) + 1 : undefined;
  } catch {
    return undefined;
  }
}

/** The 1-based line of the second column entry named `name` (as written), or undefined. */
function secondColumnLine(text: string, name: string): number | undefined {
  try {
    const doc = parseDocument(text, { uniqueKeys: false });
    const columns = doc.get('columns', true);
    if (!isSeq(columns)) return undefined;
    let seen = 0;
    for (const item of columns.items) {
      if (!isMap(item)) continue;
      const value = item.get('name', true);
      if (!isScalar(value) || String(value.value) !== name) continue;
      seen += 1;
      if (seen === 2) return value.range ? lineIndexAt(lineStarts(text), value.range[0]) + 1 : undefined;
    }
  } catch {
    /* no line */
  }
  return undefined;
}

/** Every comment's offset in a YAML text, from the CST (never from a `#` inside a scalar). */
function yamlCommentOffsets(text: string): number[] {
  // A comment starts with `#`: a text without one has none (and skips the CST).
  if (!text.includes('#')) return [];
  const out: number[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const n = node as Record<string, unknown>;
    if (n.type === 'comment' && typeof n.offset === 'number') out.push(n.offset);
    for (const [key, value] of Object.entries(n)) {
      if (key === 'source' && typeof value === 'string') continue;
      walk(value);
    }
  };
  for (const token of new Parser().parse(text)) walk(token);
  return out;
}

/**
 * The lines of a YAML table file ERD Studio does not read: comments, unknown
 * keys, anchors and aliases, and known keys whose value the reader ignores (a
 * `relationships:` entry without its three ends, a `fromModel` naming another
 * table, a cardinality it does not know, a `rationale` or `meta` that is not
 * a map, a column entry that is not a map, an `scdType` that is not a number).
 */
function keptYamlLines(oldPath: string, text: string, tableName: string): KeptLines {
  const starts = lineStarts(text);
  const keep = new Set<number>();
  const keepRange = (from: number, to: number): void => {
    const a = lineIndexAt(starts, from);
    const b = lineIndexAt(starts, Math.max(from, to - 1));
    for (let i = a; i <= b; i++) keep.add(i);
  };
  const commentOffsets = yamlCommentOffsets(text);
  for (const offset of commentOffsets) keep.add(lineIndexAt(starts, offset));
  const unknownKeys: string[] = [];
  const ignoredValues: string[] = [];
  let anchors = false;
  const doc = parseDocument(text);
  const ignoredNode = (node: unknown, label: string): void => {
    const range = isNode(node) ? node.range : undefined;
    if (range) keepRange(range[0], range[1]);
    ignoredValues.push(label);
  };
  const ignoredPair = (pair: Pair | undefined, label: string): void => {
    const range = pair ? pairRange(pair) : null;
    if (!range) return;
    keepRange(range[0], range[1]);
    ignoredValues.push(label);
  };
  /** A plain value (aliases expanded) of a node; undefined when it cannot be made. */
  const plain = (node: unknown): unknown => {
    try {
      return isNode(node) ? node.toJS(doc, { maxAliasCount: -1 }) : node;
    } catch {
      return undefined;
    }
  };
  const pairOf = (map: unknown, key: string): Pair | undefined =>
    isMap(map) ? (map.items as Pair[]).find((p) => isScalar(p.key) && p.key.value === key) : undefined;
  const present = (v: unknown): boolean => v !== undefined && v !== null;
  const pairRange = (pair: Pair): [number, number] | null => {
    const key = isNode(pair.key) ? pair.key.range : undefined;
    const value = isNode(pair.value) ? pair.value.range : undefined;
    if (!key) return null;
    return [key[0], value ? value[1] : key[1]];
  };
  const unknownIn = (map: unknown, known: ReadonlySet<string>, where: string): void => {
    if (!isMap(map)) return;
    for (const pair of map.items as Pair[]) {
      const name = isScalar(pair.key) ? String(pair.key.value) : undefined;
      if (name !== undefined && known.has(name)) continue;
      const range = pairRange(pair);
      if (range) keepRange(range[0], range[1]);
      unknownKeys.push(`${where}${name ?? '?'}`);
    }
  };
  const root = doc.contents;
  if (isMap(root)) {
    unknownIn(root, TABLE_KEYS, '');
    const get = (key: string): unknown => (root.items as Pair[]).find((p) => isScalar(p.key) && p.key.value === key)?.value;
    const rationale = get('rationale');
    if (isMap(rationale)) unknownIn(rationale, RATIONALE_KEY_SET, 'rationale.');
    else if (present(plain(rationale)) && !isObject(plain(rationale))) ignoredPair(pairOf(root, 'rationale'), 'rationale');
    const meta = plain(get('meta'));
    if (present(meta) && !isPlainMap(meta)) ignoredPair(pairOf(root, 'meta'), 'meta');
    const columns = get('columns');
    if (isSeq(columns)) {
      columns.items.forEach((item, i) => {
        if (!isObject(plain(item))) {
          ignoredNode(item, `columns[${i}]`);
          return;
        }
        unknownIn(item, COLUMN_KEYS, 'columns[].');
        const scd = pairOf(item, 'scdType');
        const scdValue = scd ? plain(scd.value) : undefined;
        if (present(scdValue) && !Number.isFinite(Number(scdValue))) ignoredPair(scd, `columns[${i}].scdType`);
        const columnMeta = plain(pairOf(item, 'meta')?.value);
        if (present(columnMeta) && !isPlainMap(columnMeta)) ignoredPair(pairOf(item, 'meta'), `columns[${i}].meta`);
      });
    } else if (present(plain(columns))) {
      ignoredPair(pairOf(root, 'columns'), 'columns');
    }
    const relationships = get('relationships');
    if (isSeq(relationships)) {
      relationships.items.forEach((item, i) => {
        const entry = plain(item);
        if (!readsAsRelationship(entry)) {
          ignoredNode(item, `relationships[${i}]`);
          return;
        }
        unknownIn(item, RELATIONSHIP_KEYS, 'relationships[].');
        const from = (entry as Record<string, unknown>).fromTable ?? (entry as Record<string, unknown>).fromModel;
        if (present(from) && (typeof from !== 'string' || lower(from) !== lower(tableName))) {
          ignoredPair(pairOf(item, 'fromTable') ?? pairOf(item, 'fromModel'), `relationships[${i}].fromModel`);
        }
        const cardinality = (entry as Record<string, unknown>).cardinality;
        if (present(cardinality) && !(typeof cardinality === 'string' && YAML_CARDINALITIES.has(cardinality))) {
          ignoredPair(pairOf(item, 'cardinality'), `relationships[${i}].cardinality`);
        }
      });
    } else if (present(plain(relationships))) {
      ignoredPair(pairOf(root, 'relationships'), 'relationships');
    }
  }
  visit(doc, {
    Node: (_key, node) => {
      const n = node as YamlNode & { anchor?: string };
      if (isAlias(node) || n.anchor) {
        anchors = true;
        if (n.range) keepRange(n.range[0], n.range[0] + 1);
      }
    },
  });
  if (keep.size === 0) return { block: [], comments: false, unknownKeys: [], ignoredValues: [], anchors: false };
  // A kept line inside a column or relationship entry keeps the entry's first line (`- name: x`) and the
  // line of the key that names it (`name:`, or a relationship's `fromColumn:`) too, wherever that key is,
  // so the comment says which column (or relationship) it belonged to.
  if (isMap(root)) {
    const naming: Record<string, readonly string[]> = { columns: ['name'], relationships: ['fromColumn'] };
    for (const key of ['columns', 'relationships']) {
      const list = (root.items as Pair[]).find((p) => isScalar(p.key) && p.key.value === key)?.value;
      if (!isSeq(list)) continue;
      for (const item of list.items) {
        const range = isNode(item) ? item.range : undefined;
        if (!range) continue;
        const first = lineIndexAt(starts, range[0]);
        const last = lineIndexAt(starts, Math.max(range[0], range[1] - 1));
        let holdsKept = false;
        for (let i = first + 1; i <= last; i++) {
          if (keep.has(i)) {
            holdsKept = true;
            break;
          }
        }
        if (!holdsKept) continue;
        keep.add(first);
        for (const name of naming[key]) {
          const pair = pairOf(item, name);
          const at = pair && isNode(pair.key) ? pair.key.range : undefined;
          if (at) keep.add(lineIndexAt(starts, at[0]));
        }
      }
    }
  }
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const block = [keptFromLine(oldPath), ...[...keep].sort((a, b) => a - b).map((i) => (lines[i] === '' ? '//' : `// ${lines[i]}`))];
  return { block, comments: commentOffsets.length > 0, unknownKeys: [...new Set(unknownKeys)], ignoredValues: [...new Set(ignoredValues)], anchors };
}

const DIAGRAM_TOP_KEYS = new Set(['schemaVersion', 'domain', 'subjectArea', 'layer', 'description', 'modelFolder', 'logical', 'viewConfig', 'stubColumns']);
const DIAGRAM_LOGICAL_KEYS = new Set(['models', 'tables', 'relationships']);
const DIAGRAM_VIEW_KEYS = new Set(['showFkEdges', 'layoutOptions', 'positions', 'annotations']);

/**
 * The keys of a JSON diagram a DBML diagram does not store, as `"key": <JSON>`
 * comment lines. `viewAt` is where the view config the loader reads is (the
 * top level, or the stage-level `logical.viewConfig` older versions wrote):
 * its known keys are stored, not kept. `ignored` adds entries the loader
 * drops (a sticky note with no id or position, a malformed position).
 */
function keptJsonLines(
  oldPath: string,
  raw: Record<string, unknown>,
  viewAt: 'viewConfig' | 'logical.viewConfig',
  ignored: ReadonlyArray<[string, unknown]> = [],
): { block: string[]; keys: string[] } {
  const kept: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(raw)) if (!DIAGRAM_TOP_KEYS.has(key)) kept.push([key, value]);
  const logicalView = viewAt === 'logical.viewConfig';
  if (isObject(raw.logical)) {
    for (const [key, value] of Object.entries(raw.logical)) {
      if (DIAGRAM_LOGICAL_KEYS.has(key) || (logicalView && key === 'viewConfig')) continue;
      kept.push([`logical.${key}`, value]);
    }
  }
  const view = logicalView ? (isObject(raw.logical) ? raw.logical.viewConfig : undefined) : raw.viewConfig;
  if (isObject(view)) for (const [key, value] of Object.entries(view)) if (!DIAGRAM_VIEW_KEYS.has(key)) kept.push([`${viewAt}.${key}`, value]);
  kept.push(...ignored);
  if (kept.length === 0) return { block: [], keys: [] };
  return {
    block: [keptFromLine(oldPath), ...kept.map(([key, value]) => `// ${JSON.stringify(key)}: ${JSON.stringify(value) ?? 'null'}`)],
    keys: kept.map(([key]) => key),
  };
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/** A library table as it will be once converted. */
interface LibraryTable {
  name: string;
  /** Its `.dbml` path after the plan. */
  path: string;
  folder: string;
  model: SemanticTable;
  /** A YAML table being converted. */
  converted?: { source: string; text: string; resumed: boolean };
  /** An existing DBML table (a mixed project). */
  dbml?: { reference: string; alias?: string; text: string };
}

/** A relationship in the pool, with where it came from. */
interface PoolEntry {
  rel: Relationship;
  /** The file it was read from (for notes). */
  file: string;
  index: number;
  source: 'yaml' | 'dbml' | 'diagram';
  /** Kept as a pending line (D27): it cannot be a live Ref yet, and why. */
  pending?: string;
}

/** Why a file is left as it is (D26/D27, Liam's (B)): its problem and line. */
interface LeftFile {
  problem: string;
  line?: number;
}

function emptyPlan(): DbmlConversionPlan {
  return {
    creates: [], replaces: [], deletes: [], resumed: [], refusals: [], handled: [], leftAsIs: [], keptMissing: [], notes: [],
    v4SubjectAreas: [], movedRelationships: [], placedDiagrams: [],
    summary: { tables: 0, diagrams: 0, relationshipsFiles: 0, relationships: 0 },
  };
}

/** The most rounds the planner takes to settle which files it leaves as they are (each round leaves at least one more). */
const MAX_ROUNDS = 64;

/**
 * Plan the conversion of a project to DBML (§6.1). Never writes; refusals
 * mean nothing may be applied.
 *
 * A file Convert cannot read or write as DBML is left exactly as it is
 * (`leftAsIs`), and everything else converts; leaving one file can leave
 * another (a diagram whose relationships can only move with it), so the
 * plan is made again with the files left so far until it settles. The same
 * project always gives the same plan, byte for byte.
 */
export async function planDbmlConversion(input: DbmlConversionInput, options: DbmlConversionOptions = {}): Promise<DbmlConversionPlan> {
  if (input.tablesDirIsLayer) {
    const plan = emptyPlan();
    plan.refusals.push(
      `This project has a layer called "${TABLES_DIR}", and a DBML project keeps its table library in ${input.semanticDir}/${TABLES_DIR}/. ` +
        'Rename that layer (its folder and its id in layers.json), then convert.',
    );
    return plan;
  }
  const left = new Map<string, LeftFile>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    await options.onPhase?.('planning');
    const attempt = await planOnce(input, options, left);
    if (attempt.leaveMore.size === 0) return attempt.plan;
    for (const [p, why] of attempt.leaveMore) if (!left.has(p)) left.set(p, why);
  }
  const plan = emptyPlan();
  plan.refusals.push(`Convert could not settle which files to leave as they are. ${DBML_SELF_CHECK_REFUSAL_END}`);
  return plan;
}

/** One planning round, with `left` (path → why) left as they are. `leaveMore` non-empty: plan again. */
async function planOnce(
  input: DbmlConversionInput,
  options: DbmlConversionOptions,
  left: ReadonlyMap<string, LeftFile>,
): Promise<{ plan: DbmlConversionPlan; leaveMore: Map<string, LeftFile> }> {
  const plan = emptyPlan();
  const { refusals, notes } = plan;
  const breathe = breather(options.pause);
  const leaveMore = new Map<string, LeftFile>();
  const leave = (path: string, problem: string, line?: number): void => {
    if (!left.has(path) && !leaveMore.has(path)) leaveMore.set(path, { problem, ...(line !== undefined ? { line } : {}) });
  };
  const again = (): { plan: DbmlConversionPlan; leaveMore: Map<string, LeftFile> } => ({ plan, leaveMore });
  const files = input.files;
  const fileAt = new Map(files.map((f) => [f.path, f]));
  const fileAtLower = new Map(files.map((f) => [lower(f.path), f]));
  const sd = input.semanticDir;
  /** Handled-for-you entries, once each. */
  const handle = (path: string, text: string): void => {
    if (!plan.handled.some((h) => h.path === path && h.text === text)) plan.handled.push({ path, text });
  };

  // ---- 1. Tables ---------------------------------------------------------------------------
  const yamlTables = files.filter((f) => f.kind === 'table' && f.storage === 'yaml');
  const dbmlTables = files.filter((f) => f.kind === 'table' && f.storage === 'dbml');
  const library = new Map<string, LibraryTable>();
  const byName = new Map<string, Array<{ path: string; target?: string; text?: string; storage: 'yaml' | 'dbml' }>>();
  const addName = (name: string, entry: { path: string; target?: string; text?: string; storage: 'yaml' | 'dbml' }): void => {
    byName.set(lower(name), [...(byName.get(lower(name)) ?? []), entry]);
  };
  /**
   * Tables left as YAML (lower-case name → their files, in library order), so diagrams list them as
   * unlinked and Refs to them stay pending. A name left in two files (a duplicate) keeps both.
   */
  const leftTables = new Map<string, string[]>();
  const addLeftTable = (name: string, path: string): void => {
    const paths = leftTables.get(lower(name)) ?? [];
    if (!paths.includes(path)) leftTables.set(lower(name), [...paths, path]);
  };
  const converted: LibraryTable[] = [];
  /** Converted tables whose identical duplicate keys were read once: the before-display's warning is not a difference. */
  const dedupedKeys = new Set<string>();
  for (const f of yamlTables) {
    await breathe();
    const cls = classifySemanticFile(f.path, { tablesDirIsLayer: false });
    const stem = cls.name ?? stemOf(f.path);
    if (left.has(f.path)) {
      // A name it holds (or its stem) is a left table: diagrams keep it unlinked, Refs to it pending.
      addLeftTable(stem, f.path);
      let held: SemanticTable | null = null;
      try { held = parseTableText(f.text, stem, { duplicateKeys: 'last' }); } catch { /* unreadable: its stem names it */ }
      if (held) addLeftTable(held.name, f.path);
      continue;
    }
    if (isReservedTableName(stem)) {
      leave(f.path, '‘_relationships’ is the name of the relationships file in a DBML project. Rename the table (its file and its name: key).');
      continue;
    }
    let model: SemanticTable | null;
    try {
      model = parseTableText(f.text, stem);
    } catch (err) {
      const duplicates = duplicateKeysOf(f.text);
      if (duplicates !== null && duplicates.differ.length === 0 && duplicates.keys.length > 0) {
        try {
          model = parseTableText(f.text, stem, { duplicateKeys: 'last' });
        } catch {
          model = null;
        }
        if (model) {
          delete (model as Partial<{ loadWarning: unknown }>).loadWarning;
          dedupedKeys.add(lower(model.name));
          const first = duplicates.keys[0];
          handle(f.path, `${duplicates.keys.length === 1 ? `The key ${first.key} is` : `${duplicates.keys.length} keys (${duplicates.keys.map((k) => k.key).join(', ')}) are`} written twice with the same value (line ${first.line}); converted as if written once.`);
        }
      } else if (duplicates !== null && duplicates.differ.length > 0) {
        const first = duplicates.differ[0];
        leave(f.path, `The key ${first.key} is written twice with different values (line ${first.line}). Keep the one you mean.`, first.line);
        continue;
      } else {
        const e = err as { message?: string; line?: number; linePos?: Array<{ line: number }>; code?: string; mergeConflict?: boolean };
        const line = e.line ?? e.linePos?.[0]?.line;
        if (e.mergeConflict === true && line !== undefined) {
          // Said as the diagram's twin says it (and doctor), with what to do.
          leave(f.path, `It has unresolved git merge conflicts (first at line ${line}). Resolve them (keep one side), then convert again.`, line);
        } else if (e.code === 'TAB_AS_INDENT') {
          leave(f.path, `It does not parse as YAML: line ${line ?? '?'} is indented with a tab, and YAML indents with spaces only. Replace the tab with spaces, then convert again.`, line);
        } else {
          leave(f.path, `It does not parse as YAML${line !== undefined ? ` (line ${line})` : ''}: ${String(e.message ?? err).split('\n')[0].replace(/[\s:]+$/, '')}. Fix it, then convert again.`, line);
        }
        continue;
      }
    }
    if (!model) {
      leave(f.path, noTableProblem(f.text));
      continue;
    }
    if (lower(model.name) !== lower(stem)) {
      leave(f.path, `It holds the table "${model.name}", and a DBML table file is named exactly as its table. Rename the file or the name: key.`, yamlLineOf(f.text, ['name']));
      continue;
    }
    if (isReservedTableName(model.name)) {
      leave(f.path, '‘_relationships’ is the name of the relationships file in a DBML project. Rename the table (its file and its name: key).');
      continue;
    }
    // DBML refuses two columns of one name ([3023]), compared exactly as written.
    const columnNames = (model.columns ?? []).map((c) => c.name);
    const twice = [...new Set(columnNames.filter((n, i) => columnNames.indexOf(n) !== i))];
    if (twice.length > 0) {
      leave(f.path, `It lists the column${twice.length === 1 ? '' : 's'} ${twice.join(', ')} more than once, and a DBML table names each column once. Remove or rename the copy.`, secondColumnLine(f.text, twice[0]));
      continue;
    }
    const folder = cls.folder ?? '';
    const target = `${TABLES_DIR}/${folder ? `${folder}/` : ''}${model.name}.dbml`;
    const kept = keptYamlLines(f.path, f.text, model.name);
    const { relationships: _r, ...bare } = model;
    // The kept YAML lines go above the Table as `//` lines; the whole file is then formatted once more.
    const rendered = renderNewTableDbml(bare as SemanticTable);
    const text = kept.block.length > 0 ? formatWrittenDbml([...kept.block, rendered].join('\n'), target) : rendered;
    if (kept.comments) notes.push(`${f.path}: its comments are kept as // lines above the Table in ${target}; ERD Studio does not read them.`);
    if (kept.unknownKeys.length > 0) notes.push(`${f.path}: keys ERD Studio does not read (${kept.unknownKeys.join(', ')}) are kept as // lines above the Table in ${target}.`);
    if (kept.ignoredValues.length > 0) notes.push(`${f.path}: values ERD Studio does not read (${kept.ignoredValues.join(', ')}) are kept as // lines above the Table in ${target}; they were not drawn before and are not drawn now.`);
    if (kept.anchors) notes.push(`${f.path}: its YAML anchors and aliases are written out in full; the lines that held them are kept as // lines above the Table in ${target}.`);
    const table: LibraryTable = { name: model.name, path: target, folder, model, converted: { source: f.path, text, resumed: false } };
    converted.push(table);
    addName(model.name, { path: f.path, target, text, storage: 'yaml' });
  }
  const existingDbml: LibraryTable[] = [];
  /** DBML table files that do not read (lower-case stem → path and why): diagrams keep them unlinked, Refs to them stay pending. */
  const unreadableTables = new Map<string, { path: string; why: string; line?: number }>();
  /** DBML table files that read but the writer may not edit (`writable: false`). */
  const nonWritableTables = new Set<string>();
  for (const f of dbmlTables) {
    const cls = classifySemanticFile(f.path, { tablesDirIsLayer: false });
    const stem = cls.name ?? stemOf(f.path);
    const reading = parseTableDbml(f.text, stem);
    if (!reading.ok) {
      unreadableTables.set(lower(stem), {
        path: f.path,
        why: `It is not readable DBML (${reading.error.message})`,
        ...(reading.error.line !== undefined ? { line: reading.error.line } : {}),
      });
      addName(stem, { path: f.path, text: f.text, storage: 'dbml' });
      continue;
    }
    const table: LibraryTable = {
      name: reading.table.name, path: f.path, folder: cls.folder ?? '', model: reading.table,
      dbml: { reference: reading.declaredReference, ...(reading.alias !== undefined ? { alias: reading.alias } : {}), text: f.text },
    };
    if (!reading.writable) nonWritableTables.add(f.path);
    existingDbml.push(table);
    addName(reading.table.name, { path: f.path, text: f.text, storage: 'dbml' });
  }
  // A table file named .yaml (or .YML): never listed by the library, so never converted. Diagrams keep its
  // members as they drew them, and it is left with the name to give it (unless a table of that name has a file).
  for (const m of input.misnamedTables ?? []) {
    const stem = stemOf(m.path);
    if (left.has(m.path)) {
      addLeftTable(stem, m.path);
      addLeftTable(m.name, m.path);
      continue;
    }
    // A table file of that name is there too (read or left): this copy was never read, and renaming it would clash.
    if (byName.has(lower(m.name)) || byName.has(lower(stem)) || files.some((f) => f.kind === 'table' && [lower(stem), lower(m.name)].includes(lower(stemOf(f.path))))) continue;
    const file = m.path.slice(m.path.lastIndexOf('/') + 1);
    const caseOnly = lower(file).endsWith('.yml');
    // The name the loader probes, and the one a DBML table file must have: its table's.
    const target = lower(m.name) === lower(stem) ? stem : m.name;
    leave(m.path, caseOnly
      ? `It is named ${file}, and ERD Studio reads a table file only when its name ends in .yml, in lower case: the table library does not list it, ` +
        `and a diagram finds it only on a file system that ignores case. Rename it to ${target}.yml, then convert again.`
      : `It is named ${file}, and ERD Studio reads a table file only when its name ends in .yml, so it does not read this one ` +
        `(a diagram that lists ${m.name} draws it as missing). Rename it to ${target}.yml, then convert again.`);
  }
  // Names: one file per table, whatever the folder, format or case. Convert never picks a copy: the
  // YAML copies stay as they are (the resolver keeps choosing what it chose), the DBML ones stay too.
  const resumedTables = new Set<string>();
  for (const [, entries] of byName) {
    if (entries.length < 2) continue;
    const yaml = entries.filter((e) => e.storage === 'yaml');
    const dbml = entries.filter((e) => e.storage === 'dbml');
    if (yaml.length === 1 && dbml.length === 1 && dbml[0].path === yaml[0].target) {
      if (sameConvertedTable(dbml[0].text!, yaml[0].text!, stemOf(dbml[0].path))) {
        resumedTables.add(dbml[0].path);
        continue;
      }
      leave(yaml[0].path, `${dbml[0].path} already exists, with other contents than this file converts to. Keep one of them (delete the other).`);
      continue;
    }
    for (const e of yaml) {
      leave(e.path, `One table has ${entries.length} files: ${entries.map((x) => x.path).join(', ')}. Keep one of them (ERD Studio: Give Duplicate Table Its Own Name, or delete the others).`);
    }
  }
  if (leaveMore.size > 0) return again();
  for (const t of converted) {
    if (resumedTables.has(t.path)) t.converted!.resumed = true;
    library.set(lower(t.name), t);
  }
  for (const t of existingDbml) {
    if (resumedTables.has(t.path)) continue;
    library.set(lower(t.name), t);
  }

  await breathe();
  // ---- 2. Relationships files already there --------------------------------------------------
  const relationshipsReadings = new Map<string, DbmlRelationshipsReading>();
  /** Relationships files that do not read (path → why and line): never edited. */
  const unreadableRelationships = new Map<string, { why: string; line?: number }>();
  for (const f of files.filter((x) => x.kind === 'relationships')) {
    const reading = readRelationshipsDbml(f.text);
    if (!reading.readable) {
      const problem = reading.problems[0];
      unreadableRelationships.set(f.path, {
        why: `It is not readable DBML${problem ? ` (${problem.message})` : ''}`,
        ...(problem?.line !== undefined ? { line: problem.line } : {}),
      });
      continue;
    }
    relationshipsReadings.set(f.path, reading);
  }
  const attachTables: DbmlAttachTable[] = [...library.values()].map((t) => ({
    table: { name: t.name, columns: t.model.columns ?? [] },
    folder: t.folder,
    storage: 'dbml',
    ...(t.dbml?.alias !== undefined ? { dbmlAlias: t.dbml.alias } : {}),
  }));
  const lookup = dbmlTableLookup(attachTables);
  const attachment = attachRelationships([...relationshipsReadings].map(([path, reading]) => ({ path, reading })), lookup);

  await breathe();
  // ---- 3. The relationships pool: every owner's list, respelled, deduped, canonical ----------
  const tableOf = (name: string): LibraryTable | undefined => library.get(lower(name));
  const columnOf = (t: LibraryTable, column: string): string | undefined => {
    const cols = (t.model.columns ?? []).map((c) => c.name);
    return cols.find((c) => c === column) ?? cols.find((c) => lower(c) === lower(column));
  };
  const relationshipsFileOfFolder = (folder: string): string => {
    const dir = folder ? `${TABLES_DIR}/${folder}` : TABLES_DIR;
    const listed = [...relationshipsReadings.keys(), ...unreadableRelationships.keys()].find((p) => lower(dirOf(p)) === lower(dir));
    return listed ?? `${dir}/${DBML_RELATIONSHIPS_FILE_NAME}`;
  };
  /** Relationships files an earlier, half-applied run wrote: they hold what this run would write there (§6.1 step 7). */
  const resumedRelationships = new Set<string>();
  const pool: PoolEntry[] = [];
  /** Refs a relationships file holds for a table still in YAML: replaced by the YAML file's list. */
  const replacedRefs: Array<{ rel: Relationship; table: LibraryTable }> = [];
  for (const t of library.values()) {
    if (t.converted) {
      (t.model.relationships ?? []).forEach((entry, index) => {
        pool.push({ rel: { ...entry, fromModel: t.name } as Relationship, file: t.converted!.source, index, source: 'yaml' });
      });
      // A table still in YAML keeps its relationships in its own file: that list is what ERD Studio
      // draws, and a Ref a relationships file holds for it is never drawn (attachRelationships orphans
      // it). Such Refs are an earlier, half-applied run's output (or written by hand against D20), so
      // the YAML list replaces them; one the YAML file no longer has is named, not silently dropped.
      const stale = attachment.byOwner.get(lower(t.name)) ?? [];
      if (stale.length > 0) resumedRelationships.add(relationshipsFileOfFolder(t.folder));
      for (const entry of stale) replacedRefs.push({ rel: { ...entry, fromModel: t.name } as Relationship, table: t });
      continue;
    }
    (attachment.byOwner.get(lower(t.name)) ?? []).forEach((entry, index) => {
      pool.push({ rel: { ...entry, fromModel: t.name } as Relationship, file: relationshipsFileOfFolder(t.folder), index: 1000 + index, source: 'dbml' });
    });
  }
  {
    const yamlLinks = new Set(pool.filter((e) => e.source === 'yaml').map((e) => linkKey(e.rel)));
    for (const { rel, table } of replacedRefs) {
      if (yamlLinks.has(linkKey(rel))) continue;
      notes.push(
        `${relationshipsFileOfFolder(table.folder)}: the Ref ${describeEnds(rel.fromModel, [rel.fromColumn], rel.toModel, [rel.toColumn])} belongs to ${table.name}, ` +
          `which is still a YAML table (${table.converted!.source}), so ERD Studio never drew it; ${table.converted!.source}'s relationships replace it.`,
      );
    }
  }
  /** Why a table name has no DBML table to point a live Ref at, or undefined when it has one. */
  const noFileReason = (name: string): string | undefined => {
    if (tableOf(name)) return undefined;
    const yamlFiles = leftTables.get(lower(name));
    if (yamlFiles && yamlFiles.length === 1) return `${name} stays a YAML table until ${yamlFiles[0]} is fixed`;
    // A name in two files: neither is the table until one is kept, so both are named.
    if (yamlFiles) return `${name} stays a YAML table until its files (${yamlFiles.join(', ')}) are made one`;
    const unreadable = unreadableTables.get(lower(name));
    if (unreadable) return `${unreadable.path} does not read`;
    return `${name} has no table file`;
  };
  /** Respell an entry against the library; one that cannot be a live Ref yet is kept pending (D27). */
  const checkEntry = (e: PoolEntry): PoolEntry => {
    const owner = tableOf(e.rel.fromModel)!;
    const to = tableOf(e.rel.toModel);
    const pendingOf = (reason: string): PoolEntry => ({ ...e, pending: reason });
    if (!to) return pendingOf(noFileReason(e.rel.toModel)!);
    const fromColumn = columnOf(owner, e.rel.fromColumn);
    if (fromColumn === undefined) return pendingOf(`${owner.name} has no column ${e.rel.fromColumn}`);
    const toColumn = columnOf(to, e.rel.toColumn);
    if (toColumn === undefined) return pendingOf(`${to.name} has no column ${e.rel.toColumn}`);
    const respelled = { ...e.rel, fromModel: owner.name, fromColumn, toModel: to.name, toColumn };
    if (respelled.fromColumn !== e.rel.fromColumn || respelled.toModel !== e.rel.toModel || respelled.toColumn !== e.rel.toColumn || respelled.fromModel !== e.rel.fromModel) {
      notes.push(`${e.file}: ${describeEnds(e.rel.fromModel, [e.rel.fromColumn], e.rel.toModel, [e.rel.toColumn])} is written as ${describeEnds(respelled.fromModel, [respelled.fromColumn], respelled.toModel, [respelled.toColumn])}, the tables' and columns' own spelling (DBML compares names exactly).`);
    }
    return { ...e, rel: respelled };
  };
  let entries = pool.map(checkEntry);

  // A link stored twice (in both ends' files, or twice in one): the copy mergeLibraryRelationships draws.
  const identity = (r: Relationship): string =>
    [r.fromModel, r.fromColumn, r.toModel, r.toColumn, r.cardinality, r.role ?? '', r.compositeKey ?? ''].map((s) => lower(String(s))).join('\u0000');
  const dedupe = (list: PoolEntry[]): PoolEntry[] => {
    const best = new Map<string, { e: PoolEntry; rank: string }>();
    for (const e of list) {
      const key = linkKey(e.rel);
      const rank = libraryCopyRank(e.rel, tableOf(e.rel.fromModel)?.model, e.index);
      const held = best.get(key);
      if (!held || rank < held.rank) best.set(key, { e, rank });
    }
    const kept = new Set([...best.values()].map((b) => b.e));
    for (const e of list) {
      if (kept.has(e)) continue;
      const winner = best.get(linkKey(e.rel))!.e;
      // The same entry read twice (a half-applied earlier run: the yml and the Ref it became) is one, silently.
      // A Ref carries no composite key name, so the names are not compared.
      const sameEntry = (a: Relationship, b: Relationship): boolean => {
        const strip = ({ compositeKey: _k, ...rest }: Relationship): Relationship => rest as Relationship;
        return identity(strip(canonicalRelationship(a))) === identity(strip(canonicalRelationship(b)));
      };
      if (winner.source !== e.source && (winner.source === 'dbml' || e.source === 'dbml') && sameEntry(winner.rel, e.rel)) {
        if (winner.source === 'yaml' || e.source === 'yaml') resumedRelationships.add((winner.source === 'dbml' ? winner : e).file);
        continue;
      }
      notes.push(`${e.file}: the relationship ${describeEnds(e.rel.fromModel, [e.rel.fromColumn], e.rel.toModel, [e.rel.toColumn])} is stored twice (also in ${winner.file}); it is written once, as ${winner.file} has it, the copy ERD Studio already drew.`);
    }
    return list.filter((e) => kept.has(e));
  };
  entries = dedupe(entries);

  // A library `one-to-many` (1.6.6 / 1.6.7) is stored canonically, by its other end.
  entries = entries.map((e) => {
    if (e.rel.cardinality !== 'one-to-many') return e;
    const turned = canonicalRelationship(e.rel);
    notes.push(`${e.file}: the one-to-many ${describeEnds(e.rel.fromModel, [e.rel.fromColumn], e.rel.toModel, [e.rel.toColumn])} is stored as the many-to-one ${describeEnds(turned.fromModel, [turned.fromColumn], turned.toModel, [turned.toColumn])}, in ${turned.fromModel}'s folder; it draws the same.`);
    // The other end owns it now; it has a table file only when it is in the library.
    if (!tableOf(turned.fromModel)) return { ...e, rel: turned, pending: e.pending ?? noFileReason(turned.fromModel) };
    return checkEntry({ ...e, rel: turned });
  });
  // A turned one-to-many whose new owner has no table file cannot be stored as its relationship: its
  // YAML table stays as it is (it keeps drawing it).
  for (const e of entries) {
    if (tableOf(e.rel.fromModel) || e.source !== 'yaml') continue;
    leave(e.file, `Its relationship ${describeEnds(e.rel.fromModel, [e.rel.fromColumn], e.rel.toModel, [e.rel.toColumn])} belongs to ${e.rel.fromModel} (it is the many side), which has no DBML table to hold it. Add that table, or store the relationship there.`);
  }
  if (leaveMore.size > 0) return again();

  /** Each owner's list, in pool order. */
  const listsOf = (list: readonly PoolEntry[]): Map<string, PoolEntry[]> => {
    const out = new Map<string, PoolEntry[]>();
    for (const e of list) out.set(lower(e.rel.fromModel), [...(out.get(lower(e.rel.fromModel)) ?? []), e]);
    return out;
  };

  await breathe();
  // ---- 4. Diagrams: read, and the relationships they hold moved to the library (§6.3) --------
  interface JsonDiagram { file: DbmlConversionFile; raw: Record<string, unknown>; obj: Record<string, unknown>; layer: string; name: string; target: string }
  const jsonDiagrams: JsonDiagram[] = [];
  for (const f of files.filter((x) => x.kind === 'diagram' && x.storage === 'json')) {
    if (left.has(f.path)) continue;
    const cls = classifySemanticFile(f.path, { tablesDirIsLayer: false });
    let raw: unknown;
    try {
      raw = parseSubjectAreaJson(f.text, f.path);
    } catch (err) {
      // Where the mistake is, in words, with its line for Open (as the editor says it, #186).
      const located = err instanceof SubjectAreaFileError ? err : undefined;
      if (located?.mergeConflict && located.line !== undefined) {
        leave(f.path, `It has unresolved git merge conflicts (first at line ${located.line}). Resolve them (keep one side; if only positions conflict, either is safe), then convert again.`, located.line);
      } else if (located && jsonMistakeAt(located) !== undefined) {
        leave(f.path, `It is not valid JSON: ${jsonMistakeAt(located)}. Fix it, then convert again.`, located.line);
      } else {
        leave(f.path, `It is not valid JSON (${err instanceof Error ? err.message.split('\n')[0] : String(err)}).`, located?.line);
      }
      continue;
    }
    const format = detectSubjectAreaFormat(raw);
    const inline = isObject(raw) && isObject(raw.logical) ? raw.logical.models : undefined;
    if (format === 'v4' && Array.isArray(inline) && inline.some((m) => isObject(m))) {
      plan.v4SubjectAreas.push(f.path);
      continue;
    }
    if (format === 'hybrid' || format === 'legacy') {
      // What is wrong and how to repair it, as the editor says it (not the format's internal name).
      const why = describeUnsupportedSubjectAreaFormat(format, f.path, raw) ?? `It is a ${format} file.`;
      leave(f.path, `It does not load, so it is not converted: ${why.replace(/^Subject area file \S+ /, 'it ')} Then convert again.`);
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = validateSubjectAreaDocument(raw, f.path).obj;
    } catch (err) {
      leave(f.path, `It does not load (${err instanceof Error ? err.message : String(err)}).`);
      continue;
    }
    const layer = cls.layer ?? dirOf(f.path);
    if (typeof obj.layer === 'string' && obj.layer !== layer) {
      leave(f.path, `It says its layer is "${obj.layer}", but it is in the ${layer}/ folder, and a DBML diagram's layer is its folder. Make them agree.`);
      continue;
    }
    if (!input.layers.includes(layer)) {
      // It does not open (its layer is unknown), so the self-check could not tell whether it draws the same.
      leave(f.path, unknownLayerProblem(layer, files.find((x) => x.kind === 'layers')?.text ?? null));
      continue;
    }
    const name = cls.name ?? stemOf(f.path);
    jsonDiagrams.push({ file: f, raw: raw as Record<string, unknown>, obj, layer, name, target: `${layer}/${name}.dbml` });
  }
  // Existing DBML diagrams: their pending relationships (D27) move to the library once their table has a file.
  interface DbmlDiagram { file: DbmlConversionFile; reading: ReturnType<typeof parseSubjectAreaDbml> | null; error?: string }
  const dbmlDiagrams: DbmlDiagram[] = files
    .filter((f) => f.kind === 'diagram' && f.storage === 'dbml' && !left.has(f.path))
    .filter((f) => !jsonDiagrams.some((d) => lower(d.target) === lower(f.path)))
    .map((f) => {
      try {
        return { file: f, reading: parseSubjectAreaDbml(f.text, f.path) };
      } catch (err) {
        return { file: f, reading: null, error: err instanceof Error ? err.message : String(err) };
      }
    });
  if (leaveMore.size > 0) return again();

  const diagramRelationships = (d: JsonDiagram): Relationship[] => {
    const logical = isObject(d.obj.logical) ? d.obj.logical : {};
    return Array.isArray(logical.relationships) ? (logical.relationships as Relationship[]) : [];
  };
  const dbmlDiagramRelationships = (d: DbmlDiagram): Relationship[] => {
    const logical = d.reading && isObject(d.reading.obj.logical) ? d.reading.obj.logical : {};
    return Array.isArray(logical.relationships) ? (logical.relationships as Relationship[]) : [];
  };
  const libraryModel = (lists: Map<string, PoolEntry[]>) => (name: string): SemanticTable | null => {
    const t = tableOf(name);
    if (!t) return null;
    const own = (lists.get(lower(t.name)) ?? []).map((e) => { const { fromModel: _f, ...rest } = e.rel; return rest as TableRelationship; });
    return { ...t.model, name: t.name, relationships: own };
  };
  const domains = [
    ...jsonDiagrams.map((d) => ({ label: d.file.path, relationships: diagramRelationships(d) })),
    ...dbmlDiagrams.map((d) => ({ label: d.file.path, relationships: dbmlDiagramRelationships(d) })),
  ].filter((d) => d.relationships.length > 0);
  const moved: Array<{ members: Relationship[]; holders: string[] }> = [];
  /** Per diagram (its source path): the relationships it keeps as its own pending lines (their table has no file). */
  const removedFrom = new Map<string, Set<string>>();
  if (domains.length > 0) {
    const move = planMoveToLibrary(domains, libraryModel(listsOf(entries)), [], () => false);
    for (const [label, keys] of move.removeFromDomains) removedFrom.set(label, new Set(keys));
    for (const conflict of move.conflicts) {
      const r = conflict.relationship;
      const why = `Diagrams define the relationship ${describeEnds(r.fromModel, [r.fromColumn], r.toModel, [r.toColumn])} in different ways: ` +
        `${conflict.definitions.map((d) => `${d.cardinality}${d.relationship.role ? ` "${d.relationship.role}"` : ''} in ${d.domains.join(', ')}`).join('; ')}. Make them agree.`;
      for (const d of conflict.definitions) for (const label of d.domains) leave(label, why);
    }
    for (const kept of move.keptLibrary) {
      const r = kept.relationship;
      leave(kept.domain,
        `It defines the relationship ${describeEnds(r.fromModel, [r.fromColumn], r.toModel, [r.toColumn])} as ${r.cardinality}${r.role ? ` "${r.role}"` : ''}, ` +
          `but the table library defines it as ${kept.library.cardinality}${kept.library.role ? ` "${kept.library.role}"` : ''}. ` +
          "Make them agree (or remove the diagram's copy).");
    }
    for (const group of move.leftGroups) {
      if (/has no readable file/.test(group.reason)) continue; // its table has no file: kept pending in each diagram
      const head = group.members[0];
      for (const label of group.domains) {
        leave(label, `Its relationship ${describeEnds(head.fromModel, group.members.map((m) => m.fromColumn), head.toModel, group.members.map((m) => m.toColumn))} can't move to the table library: ${group.reason}.`);
      }
    }
    for (const t of move.turned) {
      notes.push(`${t.domain}: the relationship ${describeEnds(t.relationship.fromModel, [t.relationship.fromColumn], t.relationship.toModel, [t.relationship.toColumn])} is stored the other way round, ${describeEnds(t.to.fromModel, [t.to.fromColumn], t.to.toModel, [t.to.toColumn])}, as its keys say.`);
    }
    if (leaveMore.size > 0) return again();
    // Each moved relationship joins its owner's list (a composite as one unit).
    const holdersOf = (rel: Relationship): string[] => domains.filter((d) => d.relationships.some((x) => linkKey(x) === linkKey(rel))).map((d) => d.label);
    const units = new Map<string, Relationship[]>();
    for (const rel of move.toLibrary) {
      const key = rel.compositeKey ? `${lower(rel.fromModel)}\u0000${lower(rel.toModel)}\u0000${lower(rel.compositeKey)}` : linkKey(rel);
      units.set(key, [...(units.get(key) ?? []), rel]);
    }
    for (const members of units.values()) {
      const holders = [...new Set(members.flatMap(holdersOf))];
      const added = members.map((rel, i) => checkEntry({ rel, file: holders[0] ?? 'a diagram', index: 2000 + i, source: 'diagram' }));
      entries.push(...added);
      moved.push({ members: added.map((a) => a.rel), holders });
    }
  }
  /** A diagram's own relationships that stay its own, as pending lines (D27): their table has no file. */
  const ownPending = (label: string, own: readonly Relationship[]): Relationship[] => {
    const removed = removedFrom.get(label) ?? new Set<string>();
    return own.filter((r) => !removed.has(linkKey(r)));
  };

  // A relationship whose two ends are the same columns, and composite groups that disagree: the
  // file it comes from stays as it is (a YAML table keeps drawing it; a diagram keeps its copy).
  const leaveSource = (e: PoolEntry, holders: readonly string[], why: string): void => {
    if (e.source === 'yaml') leave(e.file, why);
    else if (e.source === 'diagram') for (const h of holders.length > 0 ? holders : [e.file]) leave(h, why);
    else refusals.push(`${e.file}: ${why}`);
  };
  const holdersOfEntry = (e: PoolEntry): string[] => moved.find((m) => m.members.includes(e.rel))?.holders ?? [];
  const lists = listsOf(entries);
  for (const [, list] of lists) {
    for (const e of list) {
      if (lower(e.rel.fromModel) === lower(e.rel.toModel) && lower(e.rel.fromColumn) === lower(e.rel.toColumn)) {
        leaveSource(e, holdersOfEntry(e), `The relationship ${describeEnds(e.rel.fromModel, [e.rel.fromColumn], e.rel.toModel, [e.rel.toColumn])} joins a column to itself, which DBML refuses. Remove it.`);
      }
    }
    const groups = new Map<string, PoolEntry[]>();
    for (const e of list) if (e.rel.compositeKey) groups.set(lower(e.rel.compositeKey), [...(groups.get(lower(e.rel.compositeKey)) ?? []), e]);
    for (const [key, members] of groups) {
      if (members.length < 2) {
        // A composite of one column pair: drawn as a single relationship (with a warning), written as one Ref.
        const r = members[0].rel;
        notes.push(
          `${members[0].file}: the composite relationship "${key}" from ${r.fromModel} has only one column pair (${describeEnds(r.fromModel, [r.fromColumn], r.toModel, [r.toColumn])}), ` +
            (members[0].pending === undefined
              ? 'so it is written as a single-column Ref without its compositeKey'
              : 'so it is kept as a single-column pending line without its compositeKey') +
            ', as ERD Studio already drew it. Add the other columns on the canvas if it is meant to be composite.',
        );
        continue;
      }
      const head = members[0].rel;
      if (members.some((m) => lower(m.rel.toModel) !== lower(head.toModel) || m.rel.cardinality !== head.cardinality)) {
        for (const m of members) leaveSource(m, holdersOfEntry(m), `The columns of the composite relationship "${key}" from ${head.fromModel} disagree about the table they point at or their cardinality. Make them agree.`);
        continue;
      }
      if (members.some((m) => (m.rel.role ?? '') !== (head.role ?? ''))) {
        for (const m of members) {
          if (head.role) m.rel = { ...m.rel, role: head.role };
          else { const { role: _drop, ...rest } = m.rel; m.rel = rest as Relationship; }
        }
        notes.push(`${members[0].file}: the columns of the composite relationship "${key}" from ${head.fromModel} have different roles; it takes its first column's role${head.role ? ` ("${head.role}")` : ' (none)'}, as ERD Studio already drew it.`);
      }
    }
  }
  if (refusals.length > 0) return { plan: withoutWrites(plan), leaveMore };
  if (leaveMore.size > 0) return again();

  // A relationship bound for a relationships file that does not read: its YAML table (or the diagram
  // that held it) stays as it is, since that file is never edited.
  for (const [, list] of lists) {
    const owner = tableOf(list[0].rel.fromModel);
    if (!owner) continue;
    const home = relationshipsFileOfFolder(owner.folder);
    const broken = unreadableRelationships.get(home);
    if (!broken) continue;
    const current = attachment.byOwner.get(lower(owner.name)) ?? [];
    const changes = owner.converted !== undefined || list.length !== current.length;
    if (!changes) continue;
    for (const e of list) {
      leaveSource(e, holdersOfEntry(e), `Its relationships go in ${home}, which does not read: ${broken.why}${broken.line !== undefined ? ` (line ${broken.line})` : ''}. Fix that file.`);
    }
  }
  if (refusals.length > 0) return { plan: withoutWrites(plan), leaveMore };
  if (leaveMore.size > 0) return again();

  // Notes for the pending relationships of the library (D27).
  for (const e of entries) {
    if (e.pending === undefined) continue;
    const owner = tableOf(e.rel.fromModel)!;
    notes.push(
      `${e.file}: the relationship ${describeEnds(e.rel.fromModel, [e.rel.fromColumn], e.rel.toModel, [e.rel.toColumn])} is kept as a pending line in ` +
        `${relationshipsFileOfFolder(owner.folder)} (${e.pending}). It draws as before, and becomes a live Ref when both ends have table files with those columns.`,
    );
  }

  await breathe();
  // ---- 5. The library plan (§4.6): tables, then relationships files -----------------------------
  const plannedTableText = new Map<string, string>();
  for (const t of library.values()) if (t.converted) plannedTableText.set(t.path, t.converted.text);
  const textOf = (path: string): string | null => plannedTableText.get(path) ?? fileAt.get(path)?.text ?? null;
  const snapshotTables = new Map<string, DbmlSnapshotTable>();
  for (const t of library.values()) {
    snapshotTables.set(lower(t.name), {
      name: t.name,
      reference: t.dbml?.reference ?? dbmlName(t.name),
      path: t.path,
      storage: 'dbml',
      folder: t.folder,
      columns: (t.model.columns ?? []).map((c) => c.name),
      primaryKey: (t.model.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name),
      ...(t.dbml?.alias !== undefined ? { dbmlAlias: t.dbml.alias } : {}),
    });
  }
  const snapshotFiles = new Set<string>([
    // An unreadable relationships file is known to exist: the planner never creates one beside it.
    ...unreadableRelationships.keys(),
    ...[...library.values()].map((t) => t.path),
    ...files.filter((f) => f.storage === 'dbml').map((f) => f.path),
  ]);
  const snapshot: DbmlLibrarySnapshot = {
    semanticDir: sd,
    tables: snapshotTables,
    relationshipsFiles: relationshipsReadings,
    files: snapshotFiles,
    readText: textOf,
  };
  const finalLists = listsOf(entries);
  const desired = (t: LibraryTable): TableRelationship[] =>
    (finalLists.get(lower(t.name)) ?? []).map((e) => { const { fromModel: _f, ...rest } = e.rel; return rest as TableRelationship; });
  const saves: Array<{ model: SemanticTable; asWritten?: boolean }> = [];
  for (const t of library.values()) {
    if (t.converted) {
      // Its file is the text this run rendered from this model: the plan only places its relationships.
      saves.push({ model: { ...t.model, relationships: desired(t) }, asWritten: true });
      continue;
    }
    const current = attachment.byOwner.get(lower(t.name)) ?? [];
    const want = desired(t);
    const key = (list: readonly TableRelationship[]): string => list.map((r) => identity({ ...r, fromModel: t.name } as Relationship)).sort().join('\n');
    if (key(current) !== key(want)) saves.push({ model: { ...t.model, relationships: want } });
  }
  let libraryPlan: DbmlLibraryWritePlan;
  try {
    // Every table this run writes as DBML gains its file: a Ref already in a relationships file that
    // names one (written against it while it was YAML) gets its use line, or the file would not compile;
    // a pending line naming one becomes a live Ref.
    const gainFile = [...library.values()].filter((t) => t.converted).map((t) => t.name);
    libraryPlan = planDbmlLibraryWrites(snapshot, { save: saves, writePending: true, ...(gainFile.length > 0 ? { gainFile } : {}) });
  } catch (err) {
    if (err instanceof DbmlEditRefused) {
      // A table Convert itself writes is left as YAML, named by the file it comes from.
      const source = [...library.values()].find((t) => t.converted && lower(t.path) === lower(err.file))?.converted?.source;
      if (source !== undefined) {
        leave(source, `It can't be written as DBML: ${err.message.replace(/^Fix the DBML in \S+ first \((.*)\)\. ERD Studio never rewrites a file it cannot read\.$/, '$1')}.`);
        return again();
      }
      refusals.push(`Convert can't write the table library: ${err.message}`);
      return { plan: withoutWrites(plan), leaveMore };
    }
    throw err;
  }
  for (const w of libraryPlan.writes) {
    if (w.kind === 'create' || !nonWritableTables.has(w.path)) continue;
    // An existing DBML table that must change but can't be edited: the diagrams whose relationships
    // would go to it keep them (and stay JSON).
    const owner = [...library.values()].find((t) => t.path === w.path);
    const fromDiagrams = owner ? (finalLists.get(lower(owner.name)) ?? []).filter((e) => e.source === 'diagram') : [];
    if (fromDiagrams.length === 0) {
      refusals.push(`${w.path} must change for the conversion, and ERD Studio can't edit it (it holds a use line, a Ref or an inline ref: setting, which belong in its folder's _relationships.dbml). Fix it, then convert.`);
      continue;
    }
    for (const e of fromDiagrams) for (const h of holdersOfEntry(e)) leave(h, `Its relationships would go to ${w.path}, which ERD Studio can't edit (it holds a use line, a Ref or an inline ref: setting). Fix that file.`);
  }
  if (refusals.length > 0) return { plan: withoutWrites(plan), leaveMore };
  if (leaveMore.size > 0) return again();

  const creates = new Map<string, string>();
  const replaces = new Map<string, string>();
  for (const w of libraryPlan.writes) {
    if (w.kind === 'delete') continue;
    if (plannedTableText.has(w.path)) plannedTableText.set(w.path, w.text);
    else if (w.kind === 'create') creates.set(w.path, w.text);
    else replaces.set(w.path, w.text);
  }
  // A relationships file that already holds the pending lines this run would write (an earlier,
  // half-applied run) and is not otherwise changed counts as resumed.
  for (const [path, reading] of relationshipsReadings) {
    if ((reading.pending ?? []).length > 0 && !creates.has(path) && !replaces.has(path)) {
      const owners = new Set((reading.pending ?? []).map((r) => lower(lookup(r.owner)?.table.name ?? r.owner)));
      if ([...owners].some((o) => tableOf(o)?.converted)) resumedRelationships.add(path);
    }
  }

  for (const t of library.values()) {
    if (!t.converted) continue;
    const text = plannedTableText.get(t.path)!;
    const there = fileAt.get(t.path)?.text;
    if (t.converted.resumed && there !== undefined && sameConvertedTable(there, text, t.name)) plan.resumed.push(t.path);
    else if (fileAt.has(t.path)) {
      leave(t.converted.source, `${t.path} already exists, with other contents than this file converts to. Keep one of them.`);
      continue;
    } else creates.set(t.path, text);
    plan.deletes.push(t.converted.source);
  }
  if (leaveMore.size > 0) return again();

  await breathe();
  // ---- 6. Diagrams ----------------------------------------------------------------------------
  const convertedNames = new Set([...library.values()].filter((t) => t.converted).map((t) => lower(t.name)));
  const pathChanged = new Set<string>(convertedNames);
  for (const [oldName, newPath] of libraryPlan.pathChanged) {
    pathChanged.add(lower(oldName));
    if (newPath !== null) pathChanged.add(lower(stemOf(newPath)));
  }
  const createdRelationships = new Set(libraryPlan.createdRelationshipsFiles);
  const relationshipsFilesFor = (names: readonly string[]): string[] => libraryPlan.relationshipsFilesFor(names);
  const fileExistsAfter = (p: string): boolean => libraryPlan.fileExists(p) || creates.has(p) || plannedTableText.has(p);
  const diagramTargets = new Map<string, string>(); // lower target path → source json
  /** Members with no DBML table file to use, per diagram source: kept unlinked (D26). */
  const unlinkedOf = new Map<string, string[]>();
  /** Position keys the canvas never drew that a converted diagram keeps as // lines, not in erd_layout, per target. */
  const keptPositionKeys = new Map<string, Set<string>>();
  /** What a diagram draws before this run (only asked for when its positions must be pinned). */
  let beforeSet: Record<string, string> | undefined;
  const displayBeforeOf = (from: string): Promise<Record<string, unknown> | null> => {
    beforeSet ??= Object.fromEntries(files.map((f) => [f.path, f.text]));
    const folders = [...new Set([
      ...[...library.values()].map((t) => t.folder),
      ...files.filter((f) => f.kind === 'table').map((f) => classifySemanticFile(f.path, { tablesDirIsLayer: false }).folder ?? ''),
    ].filter((f) => f !== ''))].sort();
    return displayOf(beforeSet, from, folders, input.layers);
  };
  /** Members the self-check treats as missing or unreadable (names, lower-case), per diagram source. */
  for (const d of jsonDiagrams) {
    await breathe();
    const text = [] as string[];
    const logical = isObject(d.obj.logical) ? d.obj.logical : {};
    // The view config as the loader reads it: the top level, else the stage-level one older versions wrote,
    // with the positions and sticky notes it drops left out (they were never drawn).
    const viewAt = d.obj.viewConfig !== undefined && d.obj.viewConfig !== null ? 'viewConfig' : 'logical.viewConfig';
    const rawView = viewAt === 'viewConfig' ? d.obj.viewConfig : logical.viewConfig;
    const view = subjectAreaViewConfig(d.obj);
    const ignored: Array<[string, unknown]> = [];
    // A position erd_layout cannot hold (a name with a line break or white space at an end, or one
    // starting note/) is kept as a // line too: never dropped silently (§1.6).
    const unrepresentable = (key: string): boolean => !isErdLayoutName(key) || key.startsWith(ERD_LAYOUT_NOTE_PREFIX);
    const unheld: Array<[string, unknown]> = [];
    if (isObject(rawView)) {
      if (isObject(rawView.positions)) {
        for (const [key, value] of Object.entries(rawView.positions)) {
          if (!view.positions || !Object.prototype.hasOwnProperty.call(view.positions, key)) ignored.push([`${viewAt}.positions.${key}`, value]);
          else if (unrepresentable(key)) unheld.push([`${viewAt}.positions.${key}`, value]);
        }
      } else if (rawView.positions !== undefined) ignored.push([`${viewAt}.positions`, rawView.positions]);
      if (Array.isArray(rawView.annotations)) {
        rawView.annotations.forEach((a: unknown, i: number) => { if (!(view.annotations ?? []).includes(a as Annotation)) ignored.push([`${viewAt}.annotations[${i}]`, a]); });
      } else if (rawView.annotations !== undefined) ignored.push([`${viewAt}.annotations`, rawView.annotations]);
    }
    const names = Array.isArray(logical.models) ? (logical.models as unknown[]).filter((m): m is string => typeof m === 'string') : [];
    // A table with no .dbml file listed twice in different case draws twice in 1.x (one box per spelling), and
    // a DBML diagram names each member once: keeping one would lose the other's box, so the diagram stays JSON.
    const twice = names.find((name, i) => libraryPlan.resolveTable(name)?.storage !== 'dbml'
      && names.slice(0, i).some((earlier) => lower(earlier) === lower(name) && earlier !== name));
    if (twice !== undefined) {
      const first = names.find((n) => lower(n) === lower(twice))!;
      leave(d.file.path, `It lists ${first} and ${twice}, which differ only in case and have no table file, so it draws two tables where a DBML diagram can name one. Remove one of them.`);
      continue;
    }
    const members: Array<{ name: string; reference: string; path: string }> = [];
    const unlinked: string[] = [];
    const missing: string[] = [];
    for (const name of names) {
      const t = libraryPlan.resolveTable(name);
      if (!t || t.storage !== 'dbml') {
        // No .dbml table file to use: kept by name (D26), drawn exactly as before (missing, unreadable or YAML).
        if (!unlinked.some((u) => lower(u) === lower(name)) && !members.some((m) => lower(m.name) === lower(name))) unlinked.push(name);
        if (!leftTables.has(lower(name)) && !unreadableTables.has(lower(name))) missing.push(name);
        continue;
      }
      if (t.name !== name) {
        // The table's own spelling (DBML names each table exactly). The canvas already drew it under that
        // name, so its position is the one keyed by that spelling; a key in the listed spelling, which the
        // canvas never used, stays as written.
        handle(d.file.path, `It lists ${name}, which is the table ${t.name}; the DBML diagram names it ${t.name}.`);
      }
      members.push({ name: t.name, reference: t.reference, path: t.path });
    }
    if (missing.length > 0) plan.keptMissing.push({ diagram: d.target, tables: missing });
    unlinkedOf.set(d.file.path, unlinked);
    const unheldKeys = new Set(unheld.map(([k]) => k.slice(`${viewAt}.positions.`.length)));
    if (unheldKeys.size > 0) keptPositionKeys.set(d.target, unheldKeys);
    const kept = keptJsonLines(d.file.path, d.raw, viewAt, [...ignored, ...unheld]);
    const unknown = kept.keys.filter((k) => ![...ignored, ...unheld].some(([i]) => i === k));
    const seenIds = new Set<string>();
    const annotations = (view.annotations ?? []).map((a, i) => {
      if (typeof a.id !== 'string') return a;
      // erd_layout holds a note's box on one line by its id (§1.6): an id it cannot hold gets a new one.
      const representable = isErdLayoutName(a.id);
      if (representable && !seenIds.has(lower(a.id))) {
        seenIds.add(lower(a.id));
        return a;
      }
      const id = derivedUuid(d.file.path, a.id, String(i));
      seenIds.add(lower(id));
      notes.push(representable
        ? `${d.file.path}: a second sticky note with the id ${a.id} gets a new id (DBML names each Note once).`
        : `${d.file.path}: the sticky note with the id ${JSON.stringify(a.id)} gets a new id (erd_layout holds each note's box on one line, by an id with no line break or white space at either end).`);
      return { ...a, id };
    });
    const positions: Record<string, NodePosition> = {};
    for (const [key, value] of Object.entries(view.positions ?? {})) if (!unheldKeys.has(key)) positions[key] = value;
    // The canvas places a table with no position of its own beside the others, every stored position
    // counted. Two things would move it: a position kept as a // line (no longer counted), and a key
    // spelled as the table is in another case, which erd_layout's reader maps onto the table when it has
    // no line of its own (§1.6). Then each unplaced table is written where the canvas places it now.
    const drawn = [...members.map((m) => m.name), ...unlinked];
    const unplaced = drawn.filter((name) => !Object.prototype.hasOwnProperty.call(positions, name));
    const variantOnly = unplaced.some((name) => Object.keys(positions).some((key) => lower(key) === lower(name)));
    if (unplaced.length > 0 && (unheldKeys.size > 0 || variantOnly)) {
      const was = await displayBeforeOf(d.file.path);
      const placedNow = isObject(was?.viewConfig) ? (was!.viewConfig as { positions?: Record<string, NodePosition> }).positions ?? {} : {};
      for (const name of unplaced) if (Object.prototype.hasOwnProperty.call(placedNow, name)) positions[name] = placedNow[name];
    }
    // The diagram's own relationships that stay its own: pending lines, their table has no file (D27).
    const pendingLines = pendingRefLines(ownPending(d.file.path, diagramRelationships(d)));
    if (pendingLines.length > 0) {
      notes.push(`${d.file.path}: ${plural(pendingLines.length, 'relationship')} whose foreign-key table has no table file ${pendingLines.length === 1 ? 'is' : 'are'} kept in ${d.target} as pending lines; ${pendingLines.length === 1 ? 'it draws' : 'they draw'} as before.`);
    }
    text.push(...kept.block);
    text.push(renderNewSubjectAreaDbml({
      filePath: d.target,
      domain: typeof d.obj.domain === 'string' ? d.obj.domain : d.name,
      ...(typeof d.obj.description === 'string' ? { description: d.obj.description } : {}),
      ...(typeof d.obj.modelFolder === 'string' ? { modelFolder: d.obj.modelFolder } : {}),
      ...(typeof view.showFkEdges === 'boolean' ? { showFkEdges: view.showFkEdges } : {}),
      ...(isObject(view.layoutOptions) ? { layoutOptions: view.layoutOptions as Record<string, string> } : {}),
      ...(Array.isArray(d.obj.stubColumns) ? { stubColumns: d.obj.stubColumns as string[] } : {}),
      members,
      ...(unlinked.length > 0 ? { unlinked } : {}),
      ...(pendingLines.length > 0 ? { pendingRefs: pendingLines } : {}),
      relationshipsFiles: relationshipsFilesFor(members.map((m) => m.name)),
      annotations,
      positions,
    }));
    const diagramText = kept.block.length > 0 ? formatWrittenDbml(text.join('\n'), d.target) : text.join('\n');
    const there = (target: string): DbmlConversionFile | undefined => fileAt.get(target) ?? fileAtLower.get(lower(target));
    const existing = there(d.target);
    // An earlier run's diagram in an older layout holds the same tokens: formatted, it is this run's text.
    // Read only, never written here: compared without formatWrittenDbml's "was written" log line.
    if (existing && !(existing.path === d.target && (existing.text === diagramText || canonicalDbml(existing.text) === diagramText))) {
      leave(d.file.path, `${existing.path} is also in ${d.layer}/, and holds something other than this file converts to. Keep one of them.`);
      continue;
    }
    if (unknown.length > 0) notes.push(`${d.file.path}: keys a DBML diagram does not store (${unknown.join(', ')}) are kept as // lines above the Project in ${d.target}.`);
    if (ignored.length > 0) notes.push(`${d.file.path}: positions and sticky notes ERD Studio does not draw (${ignored.map(([k]) => k).join(', ')}: no id, or no numeric x and y) are kept as // lines above the Project in ${d.target}.`);
    if (unheld.length > 0) notes.push(`${d.file.path}: positions erd_layout cannot hold (${unheld.map(([k]) => k).join(', ')}: a name with a line break or white space at either end, or one starting note/) are kept as // lines above the Project in ${d.target}.`);
    const place = (target: string, body: string): void => {
      const existing = there(target);
      if (!existing) creates.set(target, body);
      else plan.resumed.push(target);
    };
    place(d.target, diagramText);
    // Opening it writes nothing only when every table already has a place (isFreshLayout / computeMissingPositions read exact names).
    const placed = (name: string): boolean => {
      const p = Object.prototype.hasOwnProperty.call(positions, name) ? positions[name] : undefined;
      return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
    };
    if ([...members.map((m) => m.name), ...unlinked].every(placed)) plan.placedDiagrams.push(d.target);
    diagramTargets.set(lower(d.target), d.file.path);
    plan.deletes.push(d.file.path);
  }
  if (leaveMore.size > 0) return again();

  // Existing DBML diagrams: a settle re-render, for the use lines of the files this run creates, the
  // unlinked members that gain a table file (D26) and the pending relationships that move to the library (D27).
  for (const d of dbmlDiagrams) {
    const f = d.file;
    const members = subjectAreaMembersDbml(f.text, f.path);
    const ownBefore = dbmlDiagramRelationships(d);
    const ownAfter = ownPending(f.path, ownBefore);
    const affected = members === null
      || members.some((m) => pathChanged.has(lower(m)) || relationshipsFilesFor([m]).some((r) => createdRelationships.has(r)))
      || ownAfter.length !== ownBefore.length
      // An unlinked member whose table has a .dbml file now (Add from dbt made it): it gains its use line.
      || (d.reading?.unlinked ?? []).some((m) => libraryPlan.resolveTable(m)?.storage === 'dbml');
    if (!affected) continue;
    if (!d.reading) {
      leave(f.path, `It must gain use lines for the converted tables, and it does not read: ${d.error}. It still draws the same in ERD Studio; fix it so other DBML tools read it too.`);
      continue;
    }
    try {
      if (!d.reading.writable) throw new DbmlEditRefused(f.path, `${f.path} has a repeated Note name or a second Project.`);
      const before = d.reading.obj;
      const after = structuredClone(before);
      if (isObject(after.logical)) (after.logical as Record<string, unknown>).relationships = ownAfter;
      const text = editSubjectAreaDbml(f.text, {
        filePath: f.path,
        before,
        after,
        resolveTable: (name) => libraryPlan.resolveTable(name),
        // 2.0-switch: S8a (the folder-based plan gives the imports until the planner's index does)
        relationshipsImportsFor: (names) => relationshipsFilesFor(names),
        fileExists: fileExistsAfter,
        pathChanged,
        refreshRelationshipsUses: true,
        keepLayoutIfConflicted: true,
      });
      if (text !== f.text) replaces.set(f.path, text);
    } catch (err) {
      if (ownAfter.length !== ownBefore.length) {
        // Its pending relationships can't leave it: they stay (and the library does not gain them).
        leave(f.path, `It can't be edited: ${err instanceof Error ? err.message : String(err)} Its pending relationships stay where they are until it is fixed.`);
        continue;
      }
      // Its use lines are output for other DBML tools only (D4): ERD Studio reads its members by name.
      leave(f.path, `It should gain use lines for the converted tables, and ERD Studio can't edit it: ${err instanceof Error ? err.message : String(err)} It still draws the same in ERD Studio; fix it so other DBML tools read it too.`);
    }
  }
  if (leaveMore.size > 0) return again();

  for (const p of resumedRelationships) if (fileAt.has(p) && !creates.has(p) && !replaces.has(p) && !plan.resumed.includes(p)) plan.resumed.push(p);
  plan.creates = orderCreates([...creates].map(([path, text]) => ({ path, text })));
  plan.replaces = [...replaces].map(([path, text]) => ({ path, text }));
  plan.deletes = [...new Set(plan.deletes)];

  // Files left as they are, with their problems: those of earlier rounds, and the unreadable DBML
  // tables a diagram lists or a relationship names (never edited; drawn as before).
  for (const [path, why] of [...left].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    plan.leftAsIs.push({ path, problem: why.problem, ...(why.line !== undefined ? { line: why.line } : {}) });
  }
  const namedUnreadable = new Set<string>();
  for (const d of jsonDiagrams) for (const name of unlinkedOf.get(d.file.path) ?? []) if (unreadableTables.has(lower(name))) namedUnreadable.add(lower(name));
  for (const e of entries) if (unreadableTables.has(lower(e.rel.toModel)) && !tableOf(e.rel.toModel)) namedUnreadable.add(lower(e.rel.toModel));
  for (const name of [...namedUnreadable].sort()) {
    const u = unreadableTables.get(name)!;
    if (plan.leftAsIs.some((l) => l.path === u.path)) continue;
    plan.leftAsIs.push({ path: u.path, problem: `${u.why}. Diagrams show it as before; fix it so it gets its use lines and live Refs.`, ...(u.line !== undefined ? { line: u.line } : {}) });
  }

  // Summary and moved relationships.
  const unitCount = [...finalLists.values()].reduce((n, list) => {
    const seen = new Set<string>();
    for (const e of list) seen.add(e.rel.compositeKey ? `c\u0000${lower(e.rel.toModel)}\u0000${lower(e.rel.compositeKey)}` : `l\u0000${linkKey(e.rel)}`);
    return n + seen.size;
  }, 0);
  const pendingCount = [...finalLists.values()].reduce((n, list) => n + list.filter((e) => e.pending !== undefined).length, 0)
    + jsonDiagrams.reduce((n, d) => n + ownPending(d.file.path, diagramRelationships(d)).length, 0);
  const relationshipsFilesWritten = new Set([...creates.keys(), ...replaces.keys()].filter((p) => lower(p.slice(p.lastIndexOf('/') + 1)) === DBML_RELATIONSHIPS_FILE_NAME));
  plan.summary = {
    tables: converted.filter((t) => library.get(lower(t.name)) === t).length,
    diagrams: jsonDiagrams.length,
    relationshipsFiles: relationshipsFilesWritten.size,
    relationships: unitCount,
    ...(pendingCount > 0 ? { pending: pendingCount } : {}),
  };

  const membersAfter = new Map<string, string[]>();
  for (const d of jsonDiagrams) {
    const logical = isObject(d.obj.logical) ? d.obj.logical : {};
    membersAfter.set(d.target, Array.isArray(logical.models) ? (logical.models as unknown[]).filter((m): m is string => typeof m === 'string').map(lower) : []);
  }
  for (const d of dbmlDiagrams) membersAfter.set(d.file.path, (subjectAreaMembersDbml(d.file.text, d.file.path) ?? []).map(lower));
  for (const f of files.filter((x) => x.kind === 'diagram' && x.storage === 'json' && left.has(x.path))) {
    try {
      const raw = parseSubjectAreaJson(f.text, f.path) as Record<string, unknown>;
      const models = isObject(raw.logical) && Array.isArray(raw.logical.models) ? raw.logical.models : [];
      membersAfter.set(f.path, models.filter((m): m is string => typeof m === 'string').map(lower));
    } catch { /* unreadable: draws nothing */ }
  }
  const sourceOf = (target: string): string => diagramTargets.get(lower(target)) ?? target;
  for (const m of moved) {
    const head = m.members[0];
    const also = [...membersAfter].filter(([target, names]) => names.includes(lower(head.fromModel)) && names.includes(lower(head.toModel)) && !m.holders.includes(sourceOf(target)))
      .map(([target]) => sourceOf(target));
    plan.movedRelationships.push({
      from: `${head.fromModel}.${m.members.length === 1 ? head.fromColumn : `(${m.members.map((x) => x.fromColumn).join(', ')})`}`,
      to: `${head.toModel}.${m.members.length === 1 ? head.toColumn : `(${m.members.map((x) => x.toColumn).join(', ')})`}`,
      diagrams: also,
    });
  }

  // ---- 8. The self-check -------------------------------------------------------------------------
  await options.onPhase?.('checking');
  await breathe();
  const before: Record<string, string> = {};
  for (const f of files) before[f.path] = f.text;
  const after: Record<string, string> = { ...before };
  for (const p of plan.deletes) delete after[p];
  for (const c of plan.creates) after[c.path] = c.text;
  for (const r of plan.replaces) after[r.path] = r.text;
  const compileMemo = new DbmlFileCompileMemo();
  const pause = options.pause;
  const compile = options.compile ?? (pause
    ? (fs: Readonly<Record<string, string>>, list: readonly string[]) => compileDbmlFilesSeparatelyAsync(fs, list, pause, compileDbmlProject, compileMemo)
    : (fs: Readonly<Record<string, string>>, list: readonly string[]) => compileDbmlFilesSeparately(fs, list, compileDbmlProject, compileMemo));
  const dbmlPaths = (set: Record<string, string>): string[] => Object.keys(set).filter((p) => lower(p).endsWith('.dbml'));
  const dbmlOnly = (set: Record<string, string>): Record<string, string> => Object.fromEntries(dbmlPaths(set).map((p) => [p, set[p]]));
  const diagnosticKey = (file: string, d: DbmlDiagnostic): string => `${file}\u0000${d.code}\u0000${d.message}`;
  const already = new Set<string>();
  if (dbmlPaths(before).length > 0) {
    for (const [file, list] of Object.entries(await compile(dbmlOnly(before), dbmlPaths(before)))) for (const d of list) already.add(diagnosticKey(file, d));
  }
  const compiled = await compile(dbmlOnly(after), dbmlPaths(after));
  for (const [file, list] of Object.entries(compiled)) {
    const fresh = list.find((d) => !already.has(diagnosticKey(file, d)));
    if (fresh) {
      refusals.push(`Convert would write DBML that does not compile: ${file}:${fresh.line} ${fresh.message} [${fresh.code}]. ${DBML_SELF_CHECK_REFUSAL_END}`);
      return { plan: withoutWrites(plan), leaveMore: new Map() };
    }
  }
  const movedInto = new Map<string, Set<string>>();
  for (const m of moved) {
    const head = m.members[0];
    for (const [target, names] of membersAfter) {
      if (!names.includes(lower(head.fromModel)) || !names.includes(lower(head.toModel)) || m.holders.includes(sourceOf(target))) continue;
      const set = movedInto.get(target) ?? new Set<string>();
      for (const member of m.members) set.add(linkKey(member));
      movedInto.set(target, set);
    }
  }
  const comparisons: Array<{ from: string; to: string }> = [
    ...jsonDiagrams.map((d) => ({ from: d.file.path, to: d.target })),
    ...dbmlDiagrams.map((d) => ({ from: d.file.path, to: d.file.path })),
    // A JSON diagram left as it is must draw what it drew too: the library changed under it.
    ...files.filter((f) => f.kind === 'diagram' && f.storage === 'json' && left.has(f.path)).map((f) => ({ from: f.path, to: f.path })),
  ];
  const libraryFolders = [...new Set([
    ...[...library.values()].map((t) => t.folder),
    ...files.filter((f) => f.kind === 'table').map((f) => classifySemanticFile(f.path, { tablesDirIsLayer: false }).folder ?? ''),
  ].filter((f) => f !== ''))].sort();
  // Every diagram reads the same tables and relationships files: each text is parsed once.
  const reader = memoisedDbmlReader();
  for (const { from, to } of comparisons) {
    await breathe();
    const was = await displayOf(before, from, libraryFolders, input.layers, reader);
    if (was === null) continue;
    const now = await displayOf(after, to, libraryFolders, input.layers, reader);
    if (now === null) {
      refusals.push(`Convert would write ${to} so that it no longer loads. ${DBML_SELF_CHECK_REFUSAL_END}`);
      return { plan: withoutWrites(plan), leaveMore: new Map() };
    }
    // A table whose identical duplicate keys Convert reads once had a warning about them; it has none now.
    for (const model of Array.isArray(was.models) ? (was.models as Array<Record<string, unknown>>) : []) {
      if (typeof model.name === 'string' && dedupedKeys.has(lower(model.name))) delete model.loadWarning;
    }
    // The members are compared as a set, by name: a DBML diagram lists its use lines first and the
    // members with no table file after them (D26), so a member that gains or loses a table file (this
    // run, or a fix between runs) changes its place in the list, never in the drawing (positions are
    // keyed by name). A drawn name can differ from the member's (a YAML table whose name: is not its
    // file's), so the order cannot be matched member by member.
    sortModelsByName(was);
    sortModelsByName(now);
    const drop = movedInto.get(to);
    if (drop && Array.isArray(now.relationships)) {
      // A moved relationship this diagram now also draws (documented in the
      // plan), with the foreign-key mark it puts on its column.
      const dropped = (now.relationships as Relationship[]).filter((r) => drop.has(linkKey(r)));
      now.relationships = (now.relationships as Relationship[]).filter((r) => !drop.has(linkKey(r)));
      type Col = { name?: string; isForeignKey?: boolean };
      const columnOfDisplay = (area: Record<string, unknown>, model: string, column: string): Col | undefined => {
        const m = (Array.isArray(area.models) ? (area.models as Array<{ name?: string; columns?: Col[] }>) : []).find((x) => typeof x.name === 'string' && lower(x.name) === lower(model));
        return m?.columns?.find((c) => typeof c.name === 'string' && lower(c.name) === lower(column));
      };
      for (const r of dropped) {
        const nowColumn = columnOfDisplay(now, r.fromModel, r.fromColumn);
        const wasColumn = columnOfDisplay(was, r.fromModel, r.fromColumn);
        if (nowColumn && wasColumn) nowColumn.isForeignKey = wasColumn.isForeignKey;
      }
    }
    // The positions kept as // lines (a name erd_layout cannot hold: never a table's) are not in the
    // converted diagram's view config.
    const keptKeys = keptPositionKeys.get(to);
    const wasPositions = isObject(was.viewConfig) && isObject((was.viewConfig as Record<string, unknown>).positions)
      ? (was.viewConfig as Record<string, Record<string, unknown>>).positions : undefined;
    if (keptKeys && wasPositions) for (const key of keptKeys) delete wasPositions[key];
    const a = normaliseForStorageEquivalence(was, { convert: true });
    const b = normaliseForStorageEquivalence(now, { convert: true });
    const difference = firstDifference(a, b) ?? danglingDifference(was, now);
    if (difference !== null) {
      refusals.push(`Convert would change what ${from} draws (${difference}). ${DBML_SELF_CHECK_REFUSAL_END}`);
      return { plan: withoutWrites(plan), leaveMore: new Map() };
    }
  }
  return { plan, leaveMore: new Map() };
}

/**
 * Why a diagram's folder is not a layer ERD Studio opens, and what to do: the
 * folder name can't be a layer id (layers.json skips such an entry), layers.json
 * does not read (the default layers apply), or layers.json does not list it.
 */
function unknownLayerProblem(layer: string, layersText: string | null): string {
  const opens = 'so ERD Studio does not open it';
  if (!/^[a-z][a-z0-9_-]*$/.test(layer)) {
    return `It is in the ${layer}/ folder, and a layer id (its folder's name) is lower-case letters, digits, - and _, starting with a letter, ${opens}. ` +
      "Move it into a layer's folder (or rename the folder and its id in layers.json to such a name), then convert again.";
  }
  const warnings: string[] = [];
  parseLayersText(layersText, (message) => warnings.push(message));
  // A warning about the whole file (not one entry) means the default layers apply.
  const wholeFile = warnings.find((w) => !/^(Layer |Duplicate layer )/.test(w));
  if (layersText !== null && wholeFile !== undefined) {
    return `It is in the ${layer}/ folder, and layers.json does not read (${wholeFile}), so ERD Studio uses its default layers and does not open it. Fix layers.json, then convert again.`;
  }
  if (layersText === null) {
    const defaults = parseLayersText(null).map((l) => `${l.id}/`).join(', ');
    return `It is in the ${layer}/ folder, and the project has no layers.json, so ERD Studio opens only its default layers (${defaults}) and does not open it. ` +
      `Create layers.json with the layer ${layer} (ERD Studio: Initialize Layer Configuration, then add the layer), or move the file into ${defaults.replace(/, ([^,]*)$/, ' or $1')}, then convert again.`;
  }
  return `It is in the ${layer}/ folder, which is not a layer in layers.json, ${opens}. Add the layer ${layer} to layers.json (or move the file into a layer's folder), then convert again.`;
}

/** `area.models` sorted by name (any case first, then exact), in place: the self-check's member order. */
function sortModelsByName(area: Record<string, unknown>): void {
  if (!Array.isArray(area.models)) return;
  const nameOf = (m: unknown): string => (isObject(m) && typeof m.name === 'string' ? m.name : '');
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  area.models = [...(area.models as unknown[])].sort((a, b) => order(lower(nameOf(a)), lower(nameOf(b))) || order(nameOf(a), nameOf(b)));
}

/**
 * The lines a relationship to or from a table with no columns draws (a
 * missing or unreadable table's placeholder): the comparator's Convert rows
 * drop them as dangling on both sides, so this compares them on their own,
 * by ends, cardinality and role. Null when both draw the same.
 */
function danglingDifference(was: Record<string, unknown>, now: Record<string, unknown>): string | null {
  const keys = (area: Record<string, unknown>): string[] => {
    const models = Array.isArray(area.models) ? (area.models as Array<{ name?: unknown; columns?: unknown[] }>) : [];
    const empty = new Set(models.filter((m) => typeof m.name === 'string' && (!Array.isArray(m.columns) || m.columns.length === 0)).map((m) => lower(m.name as string)));
    const rels = Array.isArray(area.relationships) ? (area.relationships as Relationship[]) : [];
    return rels
      .filter((r) => empty.has(lower(String(r.fromModel))) || empty.has(lower(String(r.toModel))))
      .map((r) => {
        const c = canonicalRelationship(r);
        return [linkKey(c), c.cardinality, lower(c.role ?? '')].join('\u0000');
      })
      .sort();
  };
  const a = keys(was);
  const b = keys(now);
  if (a.join('\n') === b.join('\n')) return null;
  const missing = a.find((k) => !b.includes(k));
  const extra = b.find((k) => !a.includes(k));
  const show = (k: string): string => k.split('\u0000').slice(0, 4).join(' ');
  return missing !== undefined ? `a relationship to a missing table, ${show(missing)}, is no longer drawn` : `a relationship to a missing table, ${show(extra!)}, is drawn that was not`;
}

/**
 * A diagram's own pending relationships as Ref lines (D27): each composite
 * group (`compositeKey`, per owner) one line, stored canonically, in the
 * order the diagram held them (so it reads back in the same order).
 */
function pendingRefLines(own: readonly Relationship[]): string[] {
  const units = new Map<string, Relationship[]>();
  for (const raw of own) {
    const rel = canonicalRelationship(raw);
    const key = rel.compositeKey ? `c\u0000${lower(rel.fromModel)}\u0000${lower(rel.toModel)}\u0000${lower(rel.compositeKey)}` : `l\u0000${linkKey(rel)}`;
    units.set(key, [...(units.get(key) ?? []), rel]);
  }
  return [...units.values()].map((members) => pendingRelationshipRef(members));
}

/**
 * Why a `.yml` in the library that parses is not a table (it has no `name:`):
 * an empty file, a dbt schema file (`version:` with `models:` or `sources:`)
 * copied in, or neither. Each says what to do.
 */
function noTableProblem(text: string): string {
  if (text.split(/\r?\n/).every((line) => /^\s*(#.*)?$/.test(line))) {
    return 'It is empty, so ERD Studio does not read it as a table (a diagram that lists it draws it as missing). Write the table in it, or delete the file.';
  }
  let raw: unknown;
  try { raw = parseDocument(text).toJS({ maxAliasCount: -1 }); } catch { raw = undefined; }
  if (isObject(raw) && 'version' in raw && (Array.isArray(raw.models) || Array.isArray(raw.sources) || Array.isArray(raw.seeds) || Array.isArray(raw.snapshots))) {
    return 'It is a dbt schema file (version: and models: or sources:), not an ERD Studio table. Move it out of the table library, or delete it.';
  }
  return 'It has no name: key, so ERD Studio does not read it as a table. Add one, or delete the file.';
}

/**
 * The keys a YAML text writes twice in one block, each with the line of its
 * later copy, split into those whose copies hold the same value (deep-equal,
 * aliases expanded) and those that differ. Null when the text has another
 * error than a duplicate key (or none).
 */
function duplicateKeysOf(text: string): { keys: Array<{ key: string; line: number }>; differ: Array<{ key: string; line: number }> } | null {
  const strict = parseDocument(text);
  if (strict.errors.length === 0 || !strict.errors.every((e) => e.code === 'DUPLICATE_KEY')) return null;
  const doc = parseDocument(text, { uniqueKeys: false });
  if (doc.errors.length > 0) return null;
  const starts = lineStarts(text);
  const keys: Array<{ key: string; line: number }> = [];
  const differ: Array<{ key: string; line: number }> = [];
  /** A value's canonical JSON (aliases expanded, keys sorted), or null when it cannot be made (never equal to anything). */
  const plain = (node: unknown): string | null => {
    try {
      return JSON.stringify(canonicalJson(isNode(node) ? node.toJS(doc, { maxAliasCount: -1 }) : node)) ?? 'undefined';
    } catch {
      return null;
    }
  };
  visit(doc, {
    Map: (_key, map) => {
      const first = new Map<string, unknown>();
      for (const pair of map.items as Pair[]) {
        const keyNode = pair.key;
        const key = isScalar(keyNode) ? String(keyNode.value) : String(keyNode);
        if (!first.has(key)) {
          first.set(key, pair.value);
          continue;
        }
        const line = isNode(keyNode) && keyNode.range ? lineIndexAt(starts, keyNode.range[0]) + 1 : 1;
        const a = plain(first.get(key));
        const same = a !== null && a === plain(pair.value);
        (same ? keys : differ).push({ key, line });
      }
    },
  });
  const byLine = (a: { line: number }, b: { line: number }): number => a.line - b.line;
  return { keys: keys.sort(byLine), differ: differ.sort(byLine) };
}

/** A value with its object keys sorted, for a deep-equality test through JSON. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonicalJson((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** The plan with its writes dropped (it refuses). */
function withoutWrites(plan: DbmlConversionPlan): DbmlConversionPlan {
  return { ...plan, creates: [], replaces: [], deletes: [], resumed: [] };
}

/** Creates in the order they are applied (D23): relationships files, tables, diagrams, anything else. */
function orderCreates(creates: Array<{ path: string; text: string }>): Array<{ path: string; text: string }> {
  const rank = (p: string): number => {
    const name = lower(p.slice(p.lastIndexOf('/') + 1));
    if (name === DBML_RELATIONSHIPS_FILE_NAME) return 0;
    if (p.startsWith(`${TABLES_DIR}/`)) return 1;
    if (name.endsWith('.dbml')) return 2;
    return 3;
  };
  return creates.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.path) - rank(b.c.path) || a.i - b.i).map(({ c }) => c);
}

/**
 * A diagram's display through core's loader over in-memory files, with every
 * library folder listed as a layer so the loader's probe finds every table
 * and relationships file wherever it is, and a path the listing holds in
 * another case resolved to the listed file (the host's semantics, §3.4: it
 * finds a table file by its stem without case), before and after alike.
 * Null when it does not load.
 */
/**
 * Core's DBML readers, each text read once: the self-check loads every
 * diagram before and after, and they share their tables and relationships
 * files. A reading is copied out, so a caller that changes one changes no other.
 */
export function memoisedDbmlReader(base: DbmlStorageReader = dbmlStorageReader): DbmlStorageReader {
  const tables = new Map<string, ReturnType<DbmlStorageReader['parseTable']>>();
  const relationships = new Map<string, ReturnType<DbmlStorageReader['readRelationships']>>();
  return {
    parseTable: (text, fileStem) => {
      const key = `${fileStem}\u0000${text}`;
      let reading = tables.get(key);
      if (!reading) { reading = base.parseTable(text, fileStem); tables.set(key, reading); }
      return structuredClone(reading);
    },
    readRelationships: (text) => {
      let reading = relationships.get(text);
      if (!reading) { reading = base.readRelationships(text); relationships.set(text, reading); }
      return structuredClone(reading);
    },
    parseSubjectArea: (text, filePath) => base.parseSubjectArea(text, filePath),
    subjectAreaMembers: (text, filePath) => base.subjectAreaMembers(text, filePath),
  };
}

async function displayOf(
  set: Readonly<Record<string, string>>,
  domainPath: string,
  libraryFolders: readonly string[],
  layerIds: readonly string[],
  reader: DbmlStorageReader = dbmlStorageReader,
): Promise<Record<string, unknown> | null> {
  const layers = parseLayersText(set['layers.json'] ?? null, () => { /* the same either way */ });
  const known = new Set(layers.map((l) => l.id));
  const extra = libraryFolders.filter((f) => !known.has(f) && !layerIds.includes(f)).map((id, i) => ({
    id, label: id, abbreviation: id.slice(0, 3).toUpperCase(), color: '#888888', creatable: false, order: 1000 + i,
  }));
  const layersText = JSON.stringify({ schemaVersion: 1, layers: [...layers, ...extra] });
  const listed = new Map<string, string>();
  for (const p of Object.keys(set).sort()) if (!listed.has(lower(p))) listed.set(lower(p), p);
  const read = (p: string): string | null => {
    if (Object.prototype.hasOwnProperty.call(set, p)) return set[p];
    const other = listed.get(lower(p));
    return other === undefined ? null : set[other];
  };
  try {
    const display = await loadDisplaySubjectArea({
      domainPath,
      readOnly: true,
      dbml: reader,
      warn: () => { /* compared, not shown */ },
      readFile: async (p) => (p === 'layers.json' ? layersText : read(p)),
    });
    return JSON.parse(JSON.stringify(display)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The describer (the modal and doctor)
// ---------------------------------------------------------------------------

/** The plan in words: the modal's detail and `erd-studio doctor`'s preview. */
export function describeDbmlConversion(plan: DbmlConversionPlan): string {
  const lines: string[] = [];
  if (plan.refusals.length > 0) {
    lines.push("Can't convert yet:", ...plan.refusals.map((r) => `• ${r}`), '');
  }
  if (plan.v4SubjectAreas.length > 0) {
    lines.push(`Run the v4 → v5 step first (the command does it for you): ${plan.v4SubjectAreas.join(', ')}.`, '');
  }
  if (plan.refusals.length === 0) {
    const s = plan.summary;
    if (plan.handled.length > 0) {
      lines.push('Handled for you:');
      for (const h of plan.handled) lines.push(`• ${h.path}: ${h.text}`);
    }
    if (plan.leftAsIs.length > 0) {
      lines.push(`${dbmlLeftAsIsTitle(plan.leftAsIs)} (${plan.leftAsIs.length === 1 ? 'this file stays' : 'these files stay'} as ${plan.leftAsIs.length === 1 ? 'it is' : 'they are'}; run Convert again after fixing ${plan.leftAsIs.length === 1 ? 'it' : 'them'} to finish the job):`);
      for (const l of plan.leftAsIs) lines.push(`• ${l.path}${l.line !== undefined ? `:${l.line}` : ''}: ${l.problem}`);
    }
    if (plan.keptMissing.length > 0) {
      lines.push('Kept as missing on their diagrams, drawn as before (create them later with Add from dbt):');
      for (const k of plan.keptMissing) lines.push(`• ${k.diagram}: ${k.tables.join(', ')}`);
    }
    if (!dbmlConversionIsEmpty(plan)) {
      lines.push(
        `Write ${plural(s.tables, 'table')}, ${plural(s.diagrams, 'diagram')} and ${plural(s.relationships, 'relationship')} ` +
          `(in ${plural(s.relationshipsFiles, 'relationships file')}) as DBML:`,
      );
      for (const c of plan.creates) lines.push(`• create ${c.path}`);
      for (const r of plan.replaces) lines.push(`• update ${r.path}`);
      for (const d of plan.deletes) lines.push(`• delete ${d}`);
    }
    if (plan.resumed.length > 0) lines.push(`Already converted by an earlier run: ${plan.resumed.join(', ')}.`);
    if (plan.movedRelationships.length > 0) {
      const also = plan.movedRelationships.filter((m) => m.diagrams.length > 0);
      if (also.length > 0) {
        lines.push('Relationships kept in diagram files move to the table library and will also show in these diagrams:');
        for (const m of also) lines.push(`• ${m.from} → ${m.to}: ${m.diagrams.join(', ')}`);
      }
      const only = plan.movedRelationships.length - also.length;
      if (only > 0) {
        lines.push(`${also.length > 0 ? `${plural(only, 'other relationship')}` : plural(only, 'relationship')} kept in diagram files ${only === 1 ? 'moves' : 'move'} to the table library and ${only === 1 ? 'shows' : 'show'} in the same diagrams as before.`);
      }
    }
  }
  for (const note of plan.notes) lines.push(`Note: ${note}`);
  if (lines.length === 0) lines.push('Nothing to convert: this project is already stored as DBML.');
  else if (plan.refusals.length === 0 && dbmlConversionIsEmpty(plan) && plan.leftAsIs.length > 0) lines.push('Nothing else to convert until those files are fixed.');
  return lines.join('\n');
}
