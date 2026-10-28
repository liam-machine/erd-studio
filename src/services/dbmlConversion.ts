/**
 * Convert Project to DBML (native DBML storage, §6.1 and D22 of
 * docs/plans/native-dbml-storage.md): the pure planner and the describer the
 * command's modal and `erd-studio doctor`'s preview share.
 *
 * {@link planDbmlConversion} takes the text of every file under the semantic
 * dir the classifier names (YAML tables, JSON diagrams and, in a mixed or
 * half-converted project, the DBML files already there) and returns the
 * creates, replaces and deletes that store the whole project as DBML, or the
 * refusals that say why it will not. It never guesses: anything it cannot
 * write as valid DBML is handled by a named rule and a note, and the plan is
 * checked before it is returned (step 8: every DBML file after the plan
 * compiles, and every diagram draws what it drew before, through the one
 * storage-equivalence comparator).
 *
 * Tables are written by core's `renderNewTableDbml`, relationships only
 * through `planDbmlLibraryWrites` (§4.6), diagrams by
 * `renderNewSubjectAreaDbml` and the layout by `editDiagramLayout`. No
 * `vscode`, no `fs`: the CLI bundles it.
 */

import { createHash } from 'crypto';

import { Parser, isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { Node as YamlNode, Pair } from 'yaml';

import {
  DBML_RELATIONSHIPS_FILE_HEADER,
  DBML_RELATIONSHIPS_FILE_NAME,
  RATIONALE_KEYS,
  TABLES_DIR,
  canonicalRelationship,
  classifySemanticFile,
  dbmlName,
  detectSubjectAreaFormat,
  editDiagramLayout,
  isReservedTableName,
  layoutFilePathOf,
  libraryCopyRank,
  linkKey,
  loadDisplaySubjectArea,
  normaliseForStorageEquivalence,
  parseLayersText,
  parseSubjectAreaJson,
  parseTableText,
  stickyLayoutsOf,
  subjectAreaViewConfig,
  validateSubjectAreaDocument,
} from '@erd-studio/core';
import type {
  Annotation,
  DbmlAttachTable,
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
  editSubjectAreaDbml,
  parseSubjectAreaDbml,
  parseTableDbml,
  readRelationshipsDbml,
  renderNewSubjectAreaDbml,
  renderNewTableDbml,
  subjectAreaMembersDbml,
} from '@erd-studio/core/dbml';

import { planDbmlLibraryWrites } from './dbmlLibraryWrites';
import type { DbmlLibrarySnapshot, DbmlLibraryWritePlan, DbmlSnapshotTable } from './dbmlLibraryWrites';
import { planMoveToLibrary } from './libraryRelationships';

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
   * half-converted project, the `.dbml` tables, relationships files, `.dbml`
   * diagrams and `.dbdiagram` layouts already there. The listing is also the
   * resolver of the self-check.
   */
  files: DbmlConversionFile[];
}

export interface DbmlConversionPlan {
  /** Tables, relationships files, diagrams and layout files (paths relative to the semantic dir). */
  creates: Array<{ path: string; text: string }>;
  /** Existing relationships files and DBML diagrams that gain Refs or `use` lines (mixed projects). */
  replaces: Array<{ path: string; text: string }>;
  /** Every converted `.yml` and `.json`. */
  deletes: string[];
  /** Targets already on disk with exactly the planned bytes (a half-applied earlier run): neither created nor refused. */
  resumed: string[];
  /** Non-empty: nothing is written. */
  refusals: string[];
  /** Lossy-but-kept items and behaviour changes. */
  notes: string[];
  /** Diagrams still in schema v4: the v4 → v5 step first. */
  v4SubjectAreas: string[];
  /** Relationships a diagram file held, now in the library, and the other diagrams where they now also draw. */
  movedRelationships: Array<{ from: string; to: string; diagrams: string[] }>;
  summary: { tables: number; diagrams: number; relationshipsFiles: number; relationships: number };
}

/** Test seams. */
export interface DbmlConversionOptions {
  /** The multi-file compile of the self-check (default: core's, with the pinned parser). */
  compile?: (files: Readonly<Record<string, string>>, entries: readonly string[]) => Record<string, DbmlDiagnostic[]>;
}

/** The comment block's first line (§2.8). */
export function keptFromLine(oldPath: string): string {
  return `// Kept from ${oldPath} by Convert Project to DBML:`;
}

/** Whether the plan writes anything. */
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

/** A Ref line as the relationships writer writes it (D18 marks), for a commented-out dangling relationship. */
function refLine(rel: Relationship, members: readonly Relationship[] = [rel]): string {
  const cols = (cs: string[]): string => (cs.length === 1 ? dbmlName(cs[0]) : `(${cs.map(dbmlName).join(', ')})`);
  const fromEnd = `${dbmlName(rel.fromModel)}.${cols(members.map((m) => m.fromColumn))}`;
  const toEnd = `${dbmlName(rel.toModel)}.${cols(members.map((m) => m.toColumn))}`;
  const name = rel.role ? ` ${dbmlName(rel.role)}` : '';
  if (rel.cardinality === 'one-to-one') return `Ref${name}: ${toEnd} ?- ${fromEnd}`;
  if (rel.cardinality === 'many-to-many') return `Ref${name}: ${fromEnd} <>? ${toEnd}`;
  return `Ref${name}: ${fromEnd} >? ${toEnd}`;
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

/** Every comment's offset in a YAML text, from the CST (never from a `#` inside a scalar). */
function yamlCommentOffsets(text: string): number[] {
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
}

/** A relationship written as a commented line (§6.1 step 3). */
interface Dangling {
  /** The relationships file it goes in. */
  file: string;
  reason: string;
  members: Relationship[];
}

function emptyPlan(): DbmlConversionPlan {
  return {
    creates: [], replaces: [], deletes: [], resumed: [], refusals: [], notes: [], v4SubjectAreas: [], movedRelationships: [],
    summary: { tables: 0, diagrams: 0, relationshipsFiles: 0, relationships: 0 },
  };
}

/** Plan the conversion of a project to DBML (§6.1). Never writes; refusals mean nothing may be applied. */
export async function planDbmlConversion(input: DbmlConversionInput, options: DbmlConversionOptions = {}): Promise<DbmlConversionPlan> {
  const plan = emptyPlan();
  const { refusals, notes } = plan;
  const files = input.files;
  const fileAt = new Map(files.map((f) => [f.path, f]));
  const fileAtLower = new Map(files.map((f) => [lower(f.path), f]));
  const sd = input.semanticDir;

  if (input.tablesDirIsLayer) {
    refusals.push(
      `This project has a layer called "${TABLES_DIR}", and a DBML project keeps its table library in ${sd}/${TABLES_DIR}/. ` +
        'Rename that layer (its folder and its id in layers.json), then convert.',
    );
    return plan;
  }

  // ---- 1. Tables ---------------------------------------------------------------------------
  const yamlTables = files.filter((f) => f.kind === 'table' && f.storage === 'yaml');
  const dbmlTables = files.filter((f) => f.kind === 'table' && f.storage === 'dbml');
  const library = new Map<string, LibraryTable>();
  const byName = new Map<string, Array<{ path: string; target?: string; text?: string; storage: 'yaml' | 'dbml' }>>();
  const addName = (name: string, entry: { path: string; target?: string; text?: string; storage: 'yaml' | 'dbml' }): void => {
    byName.set(lower(name), [...(byName.get(lower(name)) ?? []), entry]);
  };
  const converted: LibraryTable[] = [];
  for (const f of yamlTables) {
    const cls = classifySemanticFile(f.path, { tablesDirIsLayer: false });
    const stem = cls.name ?? stemOf(f.path);
    if (isReservedTableName(stem)) {
      refusals.push(`${f.path}: ‘_relationships’ is the name of the relationships file in a DBML project; give the table another name (rename the file and its name: key), then convert.`);
      continue;
    }
    let model: SemanticTable | null;
    try {
      model = parseTableText(f.text, stem);
    } catch (err) {
      const e = err as { message?: string; line?: number; linePos?: Array<{ line: number }> };
      const line = e.line ?? e.linePos?.[0]?.line;
      refusals.push(`${f.path} does not parse as YAML${line !== undefined ? ` (line ${line})` : ''}: ${String(e.message ?? err).split('\n')[0]}. Fix it, then convert.`);
      continue;
    }
    if (!model) {
      refusals.push(`${f.path} has no name: key, so it is not a table. Add one, or delete the file, then convert.`);
      continue;
    }
    if (lower(model.name) !== lower(stem)) {
      refusals.push(`${f.path} holds the table "${model.name}", and a DBML table file is named exactly as its table. Rename the file or the name: key, then convert.`);
      continue;
    }
    if (isReservedTableName(model.name)) {
      refusals.push(`${f.path}: ‘_relationships’ is the name of the relationships file in a DBML project; give the table another name, then convert.`);
      continue;
    }
    // DBML refuses two columns of one name ([3023]), compared exactly as written.
    const columnNames = (model.columns ?? []).map((c) => c.name);
    const twice = [...new Set(columnNames.filter((n, i) => columnNames.indexOf(n) !== i))];
    if (twice.length > 0) {
      refusals.push(`${f.path} lists the column${twice.length === 1 ? '' : 's'} ${twice.join(', ')} more than once, and a DBML table names each column once. Remove or rename the copy, then convert.`);
      continue;
    }
    const folder = cls.folder ?? '';
    const target = `${TABLES_DIR}/${folder ? `${folder}/` : ''}${model.name}.dbml`;
    const kept = keptYamlLines(f.path, f.text, model.name);
    const { relationships: _r, ...bare } = model;
    const text = [...kept.block, renderNewTableDbml(bare as SemanticTable)].join('\n');
    if (kept.comments) notes.push(`${f.path}: its comments are kept as // lines above the Table in ${target}; ERD Studio does not read them.`);
    if (kept.unknownKeys.length > 0) notes.push(`${f.path}: keys ERD Studio does not read (${kept.unknownKeys.join(', ')}) are kept as // lines above the Table in ${target}.`);
    if (kept.ignoredValues.length > 0) notes.push(`${f.path}: values ERD Studio does not read (${kept.ignoredValues.join(', ')}) are kept as // lines above the Table in ${target}; they were not drawn before and are not drawn now.`);
    if (kept.anchors) notes.push(`${f.path}: its YAML anchors and aliases are written out in full; the lines that held them are kept as // lines above the Table in ${target}.`);
    const table: LibraryTable = { name: model.name, path: target, folder, model, converted: { source: f.path, text, resumed: false } };
    converted.push(table);
    addName(model.name, { path: f.path, target, text, storage: 'yaml' });
  }
  const existingDbml: LibraryTable[] = [];
  /** DBML table files that do not read: a refusal only when the plan needs them (§6.1). Lower-case stem → why. */
  const unreadableTables = new Map<string, string>();
  /** DBML table files that read but the writer may not edit (`writable: false`): a refusal only when the plan must change one. */
  const nonWritableTables = new Set<string>();
  for (const f of dbmlTables) {
    const cls = classifySemanticFile(f.path, { tablesDirIsLayer: false });
    const stem = cls.name ?? stemOf(f.path);
    const reading = parseTableDbml(f.text, stem);
    if (!reading.ok) {
      unreadableTables.set(lower(stem), `${f.path} is not readable DBML (${reading.error.message}${reading.error.line !== undefined ? `, line ${reading.error.line}` : ''})`);
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
  // Names: one file per table, whatever the folder, format or case (the duplicate resolver picks, never Convert).
  const resumedTables = new Set<string>();
  for (const [, entries] of byName) {
    if (entries.length < 2) continue;
    const yaml = entries.filter((e) => e.storage === 'yaml');
    const dbml = entries.filter((e) => e.storage === 'dbml');
    if (yaml.length === 1 && dbml.length === 1 && dbml[0].path === yaml[0].target) {
      if (dbml[0].text === yaml[0].text) {
        resumedTables.add(dbml[0].path);
        continue;
      }
      refusals.push(`${dbml[0].path} already exists, with other contents than ${yaml[0].path} converts to. Keep one of them (delete the other), then convert.`);
      continue;
    }
    refusals.push(`One table has ${entries.length} files: ${entries.map((e) => e.path).join(', ')}. Keep one of them (ERD Studio: Give Duplicate Its Own Name, or delete the others), then convert.`);
  }
  if (refusals.length > 0) return plan;
  for (const t of converted) {
    if (resumedTables.has(t.path)) t.converted!.resumed = true;
    library.set(lower(t.name), t);
  }
  for (const t of existingDbml) {
    if (resumedTables.has(t.path)) continue;
    library.set(lower(t.name), t);
  }

  // ---- 2. Relationships files already there --------------------------------------------------
  const relationshipsReadings = new Map<string, DbmlRelationshipsReading>();
  /** Relationships files that do not read: a refusal only when the plan must write to their folder. Path → why. */
  const unreadableRelationships = new Map<string, string>();
  for (const f of files.filter((x) => x.kind === 'relationships')) {
    const reading = readRelationshipsDbml(f.text);
    if (!reading.readable) {
      const problem = reading.problems[0];
      unreadableRelationships.set(f.path, `${f.path} is not readable DBML${problem ? ` (${problem.message}${problem.line !== undefined ? `, line ${problem.line}` : ''})` : ''}`);
      continue;
    }
    relationshipsReadings.set(f.path, reading);
  }
  /** A refusal naming an unreadable file the plan needs, once each. */
  const needsUnreadable = (why: string, by: string): void => {
    const message = `${why}, and ${by} needs it. Fix it, then convert.`;
    if (!refusals.includes(message)) refusals.push(message);
  };
  const attachTables: DbmlAttachTable[] = [...library.values()].map((t) => ({
    table: { name: t.name, columns: t.model.columns ?? [] },
    folder: t.folder,
    storage: 'dbml',
    ...(t.dbml?.alias !== undefined ? { dbmlAlias: t.dbml.alias } : {}),
  }));
  const lookup = dbmlTableLookup(attachTables);
  const attachment = attachRelationships([...relationshipsReadings].map(([path, reading]) => ({ path, reading })), lookup);

  // ---- 3. The relationships pool: every owner's list, respelled, deduped, canonical ----------
  const tableOf = (name: string): LibraryTable | undefined => library.get(lower(name));
  const columnOf = (t: LibraryTable, column: string): string | undefined => {
    const cols = (t.model.columns ?? []).map((c) => c.name);
    return cols.find((c) => c === column) ?? cols.find((c) => lower(c) === lower(column));
  };
  const relationshipsFileOfFolder = (folder: string): string => {
    const dir = folder ? `${TABLES_DIR}/${folder}` : TABLES_DIR;
    const listed = [...relationshipsReadings.keys()].find((p) => lower(dirOf(p)) === lower(dir));
    return listed ?? `${dir}/${DBML_RELATIONSHIPS_FILE_NAME}`;
  };
  /** Relationships files an earlier, half-applied run wrote: they hold what this run would write there (§6.1 step 7). */
  const resumedRelationships = new Set<string>();
  const pool: PoolEntry[] = [];
  for (const t of library.values()) {
    if (t.converted) {
      (t.model.relationships ?? []).forEach((entry, index) => {
        pool.push({ rel: { ...entry, fromModel: t.name } as Relationship, file: t.converted!.source, index, source: 'yaml' });
      });
    }
    (attachment.byOwner.get(lower(t.name)) ?? []).forEach((entry, index) => {
      pool.push({ rel: { ...entry, fromModel: t.name } as Relationship, file: relationshipsFileOfFolder(t.folder), index: 1000 + index, source: 'dbml' });
    });
  }
  const dangling: Dangling[] = [];
  /** Respell an entry against the library; a dangling one is recorded and dropped (null). */
  const checkEntry = (e: PoolEntry): PoolEntry | null => {
    const owner = tableOf(e.rel.fromModel);
    const to = tableOf(e.rel.toModel);
    const home = relationshipsFileOfFolder(owner?.folder ?? to?.folder ?? '');
    const drop = (reason: string, badge?: string): null => {
      dangling.push({ file: home, reason, members: [e.rel] });
      notes.push(
        `${e.file}: the relationship ${describeEnds(e.rel.fromModel, [e.rel.fromColumn], e.rel.toModel, [e.rel.toColumn])} is written as a commented-out line in ${home}, because ${reason}; ` +
          `it was not drawn before and is not drawn now${badge ? `, and ${badge} loses the foreign-key mark it gave it (unless its file says isForeignKey: true)` : ''}.`,
      );
      return null;
    };
    for (const end of [e.rel.fromModel, e.rel.toModel]) {
      const why = unreadableTables.get(lower(end));
      if (why && !tableOf(end)) {
        needsUnreadable(why, `the relationship ${describeEnds(e.rel.fromModel, [e.rel.fromColumn], e.rel.toModel, [e.rel.toColumn])} in ${e.file}`);
        return null;
      }
    }
    if (!owner) return drop(`${e.rel.fromModel} has no table file`);
    if (!to) return drop(`${e.rel.toModel} has no table file`);
    const fromColumn = columnOf(owner, e.rel.fromColumn);
    if (fromColumn === undefined) return drop(`${owner.name} has no column ${e.rel.fromColumn}`);
    const toColumn = columnOf(to, e.rel.toColumn);
    if (toColumn === undefined) {
      const declared = (owner.model.columns ?? []).find((c) => c.name === fromColumn)?.isForeignKey === true;
      return drop(`${to.name} has no column ${e.rel.toColumn}`, declared ? undefined : `${owner.name}.${fromColumn}`);
    }
    const respelled = { ...e.rel, fromModel: owner.name, fromColumn, toModel: to.name, toColumn };
    if (respelled.fromColumn !== e.rel.fromColumn || respelled.toModel !== e.rel.toModel || respelled.toColumn !== e.rel.toColumn || respelled.fromModel !== e.rel.fromModel) {
      notes.push(`${e.file}: ${describeEnds(e.rel.fromModel, [e.rel.fromColumn], e.rel.toModel, [e.rel.toColumn])} is written as ${describeEnds(respelled.fromModel, [respelled.fromColumn], respelled.toModel, [respelled.toColumn])}, the tables' and columns' own spelling (DBML compares names exactly).`);
    }
    return { ...e, rel: respelled };
  };
  let entries = pool.map(checkEntry).filter((e): e is PoolEntry => e !== null);

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
    return { ...e, rel: turned };
  });

  /** Each owner's list, in pool order. */
  const listsOf = (list: readonly PoolEntry[]): Map<string, PoolEntry[]> => {
    const out = new Map<string, PoolEntry[]>();
    for (const e of list) out.set(lower(e.rel.fromModel), [...(out.get(lower(e.rel.fromModel)) ?? []), e]);
    return out;
  };

  // ---- 4. Diagrams: read, and the relationships they hold moved to the library (§6.3) --------
  interface JsonDiagram { file: DbmlConversionFile; raw: Record<string, unknown>; obj: Record<string, unknown>; layer: string; name: string; target: string }
  const jsonDiagrams: JsonDiagram[] = [];
  for (const f of files.filter((x) => x.kind === 'diagram' && x.storage === 'json')) {
    const cls = classifySemanticFile(f.path, { tablesDirIsLayer: false });
    let raw: unknown;
    try {
      raw = parseSubjectAreaJson(f.text, f.path);
    } catch (err) {
      refusals.push(`${f.path} is not valid JSON (${err instanceof Error ? err.message.split('\n')[0] : String(err)}). Fix it, then convert.`);
      continue;
    }
    const format = detectSubjectAreaFormat(raw);
    const inline = isObject(raw) && isObject(raw.logical) ? raw.logical.models : undefined;
    if (format === 'v4' && Array.isArray(inline) && inline.some((m) => isObject(m))) {
      plan.v4SubjectAreas.push(f.path);
      continue;
    }
    if (format === 'hybrid' || format === 'legacy') {
      refusals.push(`${f.path} does not load (it is a ${format} file). Fix it, then convert.`);
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = validateSubjectAreaDocument(raw, f.path).obj;
    } catch (err) {
      refusals.push(`${f.path} does not load (${err instanceof Error ? err.message : String(err)}). Fix it, then convert.`);
      continue;
    }
    const layer = cls.layer ?? dirOf(f.path);
    if (typeof obj.layer === 'string' && obj.layer !== layer) {
      refusals.push(`${f.path} says its layer is "${obj.layer}", but it is in the ${layer}/ folder. A DBML diagram's layer is its folder: make them agree, then convert.`);
      continue;
    }
    const name = cls.name ?? stemOf(f.path);
    jsonDiagrams.push({ file: f, raw: raw as Record<string, unknown>, obj, layer, name, target: `${layer}/${name}.dbml` });
  }
  if (refusals.length > 0) return plan;

  const diagramRelationships = (d: JsonDiagram): Relationship[] => {
    const logical = isObject(d.obj.logical) ? d.obj.logical : {};
    return Array.isArray(logical.relationships) ? (logical.relationships as Relationship[]) : [];
  };
  const libraryModel = (lists: Map<string, PoolEntry[]>) => (name: string): SemanticTable | null => {
    const t = tableOf(name);
    if (!t) return null;
    const own = (lists.get(lower(t.name)) ?? []).map((e) => { const { fromModel: _f, ...rest } = e.rel; return rest as TableRelationship; });
    return { ...t.model, name: t.name, relationships: own };
  };
  const domains = jsonDiagrams.map((d) => ({ label: d.file.path, relationships: diagramRelationships(d) })).filter((d) => d.relationships.length > 0);
  const moved: Array<{ members: Relationship[]; holders: string[] }> = [];
  if (domains.length > 0) {
    const move = planMoveToLibrary(domains, libraryModel(listsOf(entries)), [], () => false);
    for (const conflict of move.conflicts) {
      const r = conflict.relationship;
      refusals.push(
        `Diagrams define the relationship ${describeEnds(r.fromModel, [r.fromColumn], r.toModel, [r.toColumn])} in different ways: ` +
          `${conflict.definitions.map((d) => `${d.cardinality}${d.relationship.role ? ` "${d.relationship.role}"` : ''} in ${d.domains.join(', ')}`).join('; ')}. ` +
          'Make them agree, then convert.',
      );
    }
    for (const kept of move.keptLibrary) {
      const r = kept.relationship;
      refusals.push(
        `${kept.domain} defines the relationship ${describeEnds(r.fromModel, [r.fromColumn], r.toModel, [r.toColumn])} as ${r.cardinality}${r.role ? ` "${r.role}"` : ''}, ` +
          `but the table library defines it as ${kept.library.cardinality}${kept.library.role ? ` "${kept.library.role}"` : ''}. ` +
          'Make them agree (or remove the diagram\'s copy), then convert.',
      );
    }
    for (const left of move.leftGroups) {
      const head = left.members[0];
      if (/has no readable file/.test(left.reason)) {
        const to = tableOf(head.toModel);
        const file = relationshipsFileOfFolder(to?.folder ?? '');
        dangling.push({ file, reason: `${head.fromModel} has no table file`, members: left.members });
        notes.push(`${left.domains.join(', ')}: the relationship ${describeEnds(head.fromModel, left.members.map((m) => m.fromColumn), head.toModel, left.members.map((m) => m.toColumn))} is written as a commented-out line in ${file}, because ${head.fromModel} has no table file.`);
        continue;
      }
      refusals.push(`${left.domains.join(', ')}: the relationship ${describeEnds(head.fromModel, left.members.map((m) => m.fromColumn), head.toModel, left.members.map((m) => m.toColumn))} can't move to the table library: ${left.reason}. Fix it, then convert.`);
    }
    for (const r of move.skippedNoModel) {
      const to = tableOf(r.toModel);
      const file = relationshipsFileOfFolder(to?.folder ?? '');
      dangling.push({ file, reason: `${r.fromModel} has no table file`, members: [r] });
      notes.push(`${domains.filter((d) => d.relationships.some((x) => linkKey(x) === linkKey(r))).map((d) => d.label).join(', ')}: the relationship ${describeEnds(r.fromModel, [r.fromColumn], r.toModel, [r.toColumn])} is written as a commented-out line in ${file}, because ${r.fromModel} has no table file; it is not drawn now.`);
    }
    for (const t of move.turned) {
      notes.push(`${t.domain}: the relationship ${describeEnds(t.relationship.fromModel, [t.relationship.fromColumn], t.relationship.toModel, [t.relationship.toColumn])} is stored the other way round, ${describeEnds(t.to.fromModel, [t.to.fromColumn], t.to.toModel, [t.to.toColumn])}, as its keys say.`);
    }
    if (refusals.length > 0) return plan;
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
      if (added.some((a) => a === null)) continue;
      entries.push(...(added as PoolEntry[]));
      moved.push({ members: (added as PoolEntry[]).map((a) => a.rel), holders });
    }
  }

  // A relationship whose two ends are the same columns, and composite groups that disagree.
  const lists = listsOf(entries);
  for (const [, list] of lists) {
    for (const e of list) {
      if (lower(e.rel.fromModel) === lower(e.rel.toModel) && lower(e.rel.fromColumn) === lower(e.rel.toColumn)) {
        refusals.push(`${e.file}: the relationship ${describeEnds(e.rel.fromModel, [e.rel.fromColumn], e.rel.toModel, [e.rel.toColumn])} joins a column to itself. Remove it, then convert.`);
      }
    }
    const groups = new Map<string, PoolEntry[]>();
    for (const e of list) if (e.rel.compositeKey) groups.set(lower(e.rel.compositeKey), [...(groups.get(lower(e.rel.compositeKey)) ?? []), e]);
    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      const head = members[0].rel;
      if (members.some((m) => lower(m.rel.toModel) !== lower(head.toModel) || m.rel.cardinality !== head.cardinality)) {
        refusals.push(`${members[0].file}: the columns of the composite relationship "${key}" from ${head.fromModel} disagree about the table they point at or their cardinality. Make them agree, then convert.`);
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
  if (refusals.length > 0) return plan;

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
    // An unreadable relationships file is known to exist: the planner refuses to edit it, and never creates one beside it.
    ...unreadableRelationships.keys(),
    ...[...library.values()].map((t) => t.path),
    ...files.filter((f) => f.storage === 'dbml' || f.kind === 'layout').map((f) => f.path),
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
  const saves: Array<{ model: SemanticTable }> = [];
  for (const t of library.values()) {
    if (t.converted) {
      saves.push({ model: { ...t.model, relationships: desired(t) } });
      continue;
    }
    const current = attachment.byOwner.get(lower(t.name)) ?? [];
    const want = desired(t);
    const key = (list: readonly TableRelationship[]): string => list.map((r) => identity({ ...r, fromModel: t.name } as Relationship)).sort().join('\n');
    if (key(current) !== key(want)) saves.push({ model: { ...t.model, relationships: want } });
  }
  let libraryPlan: DbmlLibraryWritePlan;
  try {
    libraryPlan = planDbmlLibraryWrites(snapshot, { save: saves });
  } catch (err) {
    if (err instanceof DbmlEditRefused) {
      // A table Convert itself writes is named by the file it comes from.
      const source = [...library.values()].find((t) => t.converted && lower(t.path) === lower(err.file))?.converted?.source;
      refusals.push(source !== undefined
        ? `Convert can't write ${source} as DBML: ${err.message.replace(/^Fix the DBML in \S+ first \((.*)\)\. ERD Studio never rewrites a file it cannot read\.$/, '$1')}. Fix ${source}, then convert.`
        : `Convert can't write the table library: ${err.message}`);
      return plan;
    }
    throw err;
  }
  for (const w of libraryPlan.writes) {
    if (w.kind === 'create' || !nonWritableTables.has(w.path)) continue;
    refusals.push(`${w.path} must change for the conversion, and ERD Studio can't edit it (it holds a use line, a Ref or an inline ref: setting, which belong in its folder's _relationships.dbml). Fix it, then convert.`);
  }
  if (refusals.length > 0) return withoutWrites(plan);

  const creates = new Map<string, string>();
  const replaces = new Map<string, string>();
  for (const w of libraryPlan.writes) {
    // Never a second relationships file beside an unreadable one spelled in another case.
    const clash = [...unreadableRelationships].find(([p]) => p !== w.path && lower(p) === lower(w.path));
    if (clash) {
      needsUnreadable(clash[1], `the relationships Convert writes to ${w.path}`);
      continue;
    }
    if (w.kind === 'delete') continue;
    if (plannedTableText.has(w.path)) plannedTableText.set(w.path, w.text);
    else if (w.kind === 'create') creates.set(w.path, w.text);
    else replaces.set(w.path, w.text);
  }
  // Dangling relationships, as commented lines in their relationships file.
  const danglingByFile = new Map<string, Dangling[]>();
  for (const d of dangling) danglingByFile.set(d.file, [...(danglingByFile.get(d.file) ?? []), d]);
  for (const [file, list] of danglingByFile) {
    const unreadable = [...unreadableRelationships].find(([p]) => lower(p) === lower(file));
    if (unreadable) {
      needsUnreadable(unreadable[1], `a relationship Convert keeps there as a comment (${list.map((d) => d.reason).join('; ')})`);
      continue;
    }
    const base = creates.get(file) ?? replaces.get(file) ?? fileAt.get(file)?.text ?? null;
    // A block already in the file (an earlier, half-applied run wrote it) is not written again.
    const pairs = [...new Set(list.map((d) => [
      `// Kept by Convert Project to DBML: ${d.reason}, so this relationship is not active.`,
      `// ${refLine(d.members[0], d.members)}`,
    ].join('\n')))];
    const missing = base === null ? pairs : pairs.filter((pair) => !base.split(/\r?\n/).join('\n').includes(pair));
    if (missing.length === 0) {
      if (fileAt.has(file)) resumedRelationships.add(file);
      continue;
    }
    const text = base === null
      ? `${DBML_RELATIONSHIPS_FILE_HEADER}\n\n${missing.join('\n')}\n`
      : `${base.replace(/\n*$/, '\n')}\n${missing.join('\n')}\n`;
    if (fileAt.has(file)) replaces.set(file, text);
    else creates.set(file, text);
  }

  for (const t of library.values()) {
    if (!t.converted) continue;
    const text = plannedTableText.get(t.path)!;
    if (t.converted.resumed && fileAt.get(t.path)?.text === text) plan.resumed.push(t.path);
    else if (fileAt.has(t.path)) refusals.push(`${t.path} already exists, with other contents than ${t.converted.source} converts to. Keep one of them, then convert.`);
    else creates.set(t.path, text);
    plan.deletes.push(t.converted.source);
  }

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
  for (const d of jsonDiagrams) {
    const text = [] as string[];
    const logical = isObject(d.obj.logical) ? d.obj.logical : {};
    // The view config as the loader reads it: the top level, else the stage-level one older versions wrote,
    // with the positions and sticky notes it drops left out (they were never drawn).
    const viewAt = d.obj.viewConfig !== undefined && d.obj.viewConfig !== null ? 'viewConfig' : 'logical.viewConfig';
    const rawView = viewAt === 'viewConfig' ? d.obj.viewConfig : logical.viewConfig;
    const view = subjectAreaViewConfig(d.obj);
    const ignored: Array<[string, unknown]> = [];
    if (isObject(rawView)) {
      if (isObject(rawView.positions)) {
        for (const [key, value] of Object.entries(rawView.positions)) if (!view.positions || !Object.prototype.hasOwnProperty.call(view.positions, key)) ignored.push([`${viewAt}.positions.${key}`, value]);
      } else if (rawView.positions !== undefined) ignored.push([`${viewAt}.positions`, rawView.positions]);
      if (Array.isArray(rawView.annotations)) {
        rawView.annotations.forEach((a: unknown, i: number) => { if (!(view.annotations ?? []).includes(a as Annotation)) ignored.push([`${viewAt}.annotations[${i}]`, a]); });
      } else if (rawView.annotations !== undefined) ignored.push([`${viewAt}.annotations`, rawView.annotations]);
    }
    const kept = keptJsonLines(d.file.path, d.raw, viewAt, ignored);
    const unknown = kept.keys.filter((k) => !ignored.some(([i]) => i === k));
    if (unknown.length > 0) notes.push(`${d.file.path}: keys a DBML diagram does not store (${unknown.join(', ')}) are kept as // lines above the Project in ${d.target}.`);
    if (ignored.length > 0) notes.push(`${d.file.path}: positions and sticky notes ERD Studio does not draw (${ignored.map(([k]) => k).join(', ')}: no id, or no numeric x and y) are kept as // lines above the Project in ${d.target}.`);
    const names = Array.isArray(logical.models) ? (logical.models as unknown[]).filter((m): m is string => typeof m === 'string') : [];
    const members: Array<{ name: string; reference: string; path: string }> = [];
    for (const name of names) {
      const t = libraryPlan.resolveTable(name);
      const unreadable = unreadableTables.get(lower(name));
      if (!t && unreadable) {
        needsUnreadable(unreadable, d.file.path);
        continue;
      }
      if (!t) {
        refusals.push(`${d.file.path} lists ${name}, which has no table file, and a DBML diagram names each table by its file. Add the table, or remove it from the diagram, then convert.`);
        continue;
      }
      if (t.name !== name) {
        refusals.push(
          `${d.file.path} lists ${name}, but the table is named ${t.name}, and a DBML diagram names each table exactly. ` +
            `Write ${t.name} in the diagram (its models list, and its positions if it has any), then convert.`,
        );
        continue;
      }
      members.push({ name: t.name, reference: t.reference, path: t.path });
    }
    const seenIds = new Set<string>();
    const annotations = (view.annotations ?? []).map((a, i) => {
      if (typeof a.id !== 'string' || !seenIds.has(lower(a.id))) {
        if (typeof a.id === 'string') seenIds.add(lower(a.id));
        return a;
      }
      const id = derivedUuid(d.file.path, a.id, String(i));
      seenIds.add(lower(id));
      notes.push(`${d.file.path}: a second sticky note with the id ${a.id} gets a new id (DBML names each Note once).`);
      return { ...a, id };
    });
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
      relationshipsFiles: relationshipsFilesFor(members.map((m) => m.name)),
      annotations,
    }));
    const diagramText = text.join('\n');
    const positions: Record<string, NodePosition> = view.positions ?? {};
    const layout = editDiagramLayout(null, positions, stickyLayoutsOf(annotations));
    const place = (target: string, body: string): void => {
      const there = fileAt.get(target) ?? fileAtLower.get(lower(target));
      if (!there) creates.set(target, body);
      else if (there.path === target && there.text === body) plan.resumed.push(target);
      else refusals.push(`${d.file.path} and ${there.path} are both in ${d.layer}/, and ${there.path} holds something other than ${d.file.path} converts to. Keep one of them, then convert.`);
    };
    place(d.target, diagramText);
    if (layout !== null) place(layoutFilePathOf(d.target), layout);
    else {
      // No layout to write, and a stale one beside the target would be read as this diagram's.
      const stale = fileAt.get(layoutFilePathOf(d.target)) ?? fileAtLower.get(lower(layoutFilePathOf(d.target)));
      if (stale) refusals.push(`${stale.path} already exists, and ${d.file.path} has no positions or sticky notes to put in it, so the converted diagram would read that file's layout. Delete ${stale.path} (or move it), then convert.`);
    }
    diagramTargets.set(lower(d.target), d.file.path);
    plan.deletes.push(d.file.path);
  }

  // Existing DBML diagrams: a settle re-render, for the use lines of the files this run creates.
  const dbmlDiagrams = files.filter((f) => f.kind === 'diagram' && f.storage === 'dbml' && !diagramTargets.has(lower(f.path)));
  for (const f of dbmlDiagrams) {
    const members = subjectAreaMembersDbml(f.text);
    const affected = members === null || members.some((m) => pathChanged.has(lower(m)) || relationshipsFilesFor([m]).some((r) => createdRelationships.has(r)));
    const layoutText = fileAt.get(layoutFilePathOf(f.path))?.text ?? null;
    try {
      const reading = parseSubjectAreaDbml(f.text, f.path, layoutText);
      if (!reading.writable && affected) throw new DbmlEditRefused(f.path, `${f.path} has a repeated Note name or a second Project`);
      if (!affected) continue;
      const before = reading.obj;
      const text = editSubjectAreaDbml(f.text, {
        filePath: f.path,
        before,
        after: structuredClone(before),
        resolveTable: (name) => libraryPlan.resolveTable(name),
        relationshipsFilesFor,
        fileExists: fileExistsAfter,
        pathChanged,
        refreshRelationshipsUses: true,
      });
      if (text !== f.text) replaces.set(f.path, text);
    } catch (err) {
      if (!affected) continue;
      refusals.push(`${f.path} must gain use lines for the converted tables, and ERD Studio can't edit it: ${err instanceof Error ? err.message : String(err)} Fix it, then convert.`);
    }
  }
  if (refusals.length > 0) return withoutWrites(plan);

  for (const p of resumedRelationships) if (fileAt.has(p) && !creates.has(p) && !replaces.has(p)) plan.resumed.push(p);
  plan.creates = orderCreates([...creates].map(([path, text]) => ({ path, text })));
  plan.replaces = [...replaces].map(([path, text]) => ({ path, text }));
  plan.deletes = [...new Set(plan.deletes)];

  // Summary and moved relationships.
  const unitCount = [...finalLists.values()].reduce((n, list) => {
    const seen = new Set<string>();
    for (const e of list) seen.add(e.rel.compositeKey ? `c\u0000${lower(e.rel.toModel)}\u0000${lower(e.rel.compositeKey)}` : `l\u0000${linkKey(e.rel)}`);
    return n + seen.size;
  }, 0);
  const relationshipsFilesWritten = new Set([...creates.keys(), ...replaces.keys()].filter((p) => lower(p.slice(p.lastIndexOf('/') + 1)) === DBML_RELATIONSHIPS_FILE_NAME));
  plan.summary = { tables: converted.length, diagrams: jsonDiagrams.length, relationshipsFiles: relationshipsFilesWritten.size, relationships: unitCount };

  const membersAfter = new Map<string, string[]>();
  for (const d of jsonDiagrams) {
    const logical = isObject(d.obj.logical) ? d.obj.logical : {};
    membersAfter.set(d.target, Array.isArray(logical.models) ? (logical.models as unknown[]).filter((m): m is string => typeof m === 'string').map(lower) : []);
  }
  for (const f of dbmlDiagrams) membersAfter.set(f.path, (subjectAreaMembersDbml(f.text) ?? []).map(lower));
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
  const before: Record<string, string> = {};
  for (const f of files) before[f.path] = f.text;
  const after: Record<string, string> = { ...before };
  for (const p of plan.deletes) delete after[p];
  for (const c of plan.creates) after[c.path] = c.text;
  for (const r of plan.replaces) after[r.path] = r.text;
  const compile = options.compile ?? ((fs, entries) => compileDbmlProject(fs, entries));
  const dbmlPaths = (set: Record<string, string>): string[] => Object.keys(set).filter((p) => lower(p).endsWith('.dbml'));
  const dbmlOnly = (set: Record<string, string>): Record<string, string> => Object.fromEntries(dbmlPaths(set).map((p) => [p, set[p]]));
  const diagnosticKey = (file: string, d: DbmlDiagnostic): string => `${file}\u0000${d.code}\u0000${d.message}`;
  const already = new Set<string>();
  if (dbmlPaths(before).length > 0) {
    for (const [file, list] of Object.entries(compile(dbmlOnly(before), dbmlPaths(before)))) for (const d of list) already.add(diagnosticKey(file, d));
  }
  const compiled = compile(dbmlOnly(after), dbmlPaths(after));
  for (const [file, list] of Object.entries(compiled)) {
    const fresh = list.find((d) => !already.has(diagnosticKey(file, d)));
    if (fresh) {
      refusals.push(`Convert would write DBML that does not compile: ${file}:${fresh.line} ${fresh.message} [${fresh.code}]. Nothing was changed; please report this with the file.`);
      return withoutWrites(plan);
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
    ...dbmlDiagrams.map((f) => ({ from: f.path, to: f.path })),
  ];
  const libraryFolders = [...new Set([...library.values()].map((t) => t.folder).filter((f) => f !== ''))];
  for (const { from, to } of comparisons) {
    const was = await displayOf(before, from, libraryFolders, input.layers);
    if (was === null) continue;
    const now = await displayOf(after, to, libraryFolders, input.layers);
    if (now === null) {
      refusals.push(`Convert would write ${to} so that it no longer loads. Nothing was changed; please report this with the file.`);
      return withoutWrites(plan);
    }
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
    const a = normaliseForStorageEquivalence(was, { convert: true });
    const b = normaliseForStorageEquivalence(now, { convert: true });
    const difference = firstDifference(a, b);
    if (difference !== null) {
      refusals.push(`Convert would change what ${from} draws (${difference}). Nothing was changed; please report this with the file.`);
      return withoutWrites(plan);
    }
  }
  return plan;
}

/** The plan with its writes dropped (it refuses). */
function withoutWrites(plan: DbmlConversionPlan): DbmlConversionPlan {
  return { ...plan, creates: [], replaces: [], deletes: [], resumed: [] };
}

/** Creates in the order they are applied (D23): relationships files, tables, diagrams, layouts. */
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
async function displayOf(
  set: Readonly<Record<string, string>>,
  domainPath: string,
  libraryFolders: readonly string[],
  layerIds: readonly string[],
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
      dbml: dbmlStorageReader,
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
  return lines.join('\n');
}
