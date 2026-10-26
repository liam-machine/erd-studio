/**
 * Import DBML — turn a DBML file (ERD Studio's own rich export, or one from
 * dbdiagram.io or any other tool) into a NEW logical subject area: the table
 * files the library does not have yet, the subject area document, its
 * relationships and, when a `.dbdiagram` layout sits next to the file, the
 * canvas positions and sticky notes. The reading half is
 * `src/services/dbmlImportParse.ts`; the command writes what this plans the
 * way Draw from dbt writes a draft (`saveTable`, the subject area file created
 * with `wx`, rollback on failure).
 *
 * The mapping is the rich export's (`toDbmlRich` in `@erd-studio/core`) in
 * reverse, its property names read from core's `dbmlRichProperties` with or
 * without the `erd_` prefix:
 *
 * | DBML | ERD Studio |
 * |---|---|
 * | `Project name { Note }` | suggested subject area name; its description |
 * | `TableGroup` or schema named after a layer | suggested layer (other groups are reported, not kept) |
 * | `Table [schema.]name`, its `Note` | table name and schema, description |
 * | `role`, `grain`, `alias` | `modelRole` (from another tool, only a role ERD Studio knows), `grain`, `alias` |
 * | `schema` on a table with none | `schema` (how the export writes `public`, which DBML reads as no schema) |
 * | `rationale_<snake_case>` | `rationale.<camelCase>` |
 * | `meta_<key>`, `meta_json` | `meta`, exactly |
 * | `pk`, `indexes { (a, b) [pk] }` | `isPrimaryKey` |
 * | `natural_key`, `scd_type`, `additive_type`, `foreign_key` | the column flags |
 * | column `note` | column description |
 * | `Ref`, and `[ref: …]` on a column | a relationship stored from its FK (many) side; a composite one is one entry per column pair sharing `compositeKey`; the ref's name is its role; `?` (optional) is not kept |
 * | `Note name [color]` and its layout | an annotation; `linked_table` links it to a table (in ERD Studio's own export, even one not in the diagram, as the diagram had it) |
 * | the placeholder column (`erd_placeholder`) | dropped: the table has no columns |
 *
 * What DBML can say and ERD Studio has no field for is kept under the
 * reserved `dbml` key of the table's or column's `meta` (see
 * {@link DBML_META_KEY}), so nothing a team wrote is lost and a later rich
 * export carries it back out (inside `meta_json`):
 *
 * - column: `not_null`, `unique` (not the `unique` an exported one-to-one
 *   adds to its FK column), `increment`, `default` (an expression in
 *   backticks), `checks`, `enum` (an enum type's values), `name` (the
 *   original name, when it had to change), `properties` (custom properties
 *   that are not ERD Studio's);
 * - table: `indexes` (every index but the primary key), `checks`,
 *   `header_color`, `alias` (the DBML alias, `Table users as U`), `name` (the
 *   original name, when it had to change and cannot be the warehouse
 *   `alias`), `properties`.
 *
 * Dropped, and listed in the report: Records (sample rows), a ref's
 * `delete` / `update` / `color` / `inactive`, the project's `database_type`
 * and other settings, table groups other than the layer's, dependency
 * arrows, diagram views, and a sticky note's own properties.
 *
 * Names: a table name must match `TABLE_NAME_PATTERN` and a column name
 * `COLUMN_NAME_PATTERN`; one that does not becomes the nearest name that does
 * (`Order Items` → `Order_Items`), with the original kept as the warehouse
 * `alias` when it can be one, else in `meta.dbml.name`. Two tables whose
 * names differ only by schema or case become `{schema}_{name}` with
 * `alias: {name}`. A name the Table Library already has, in any case, is used
 * as it is in the library — never overwritten — in the library's spelling.
 *
 * Pure: no `vscode`, no file access. The library comes in as two lookups.
 */

import {
  DBML_RICH_COLUMN_PROPERTIES,
  DBML_RICH_META_JSON_PROPERTY,
  DBML_RICH_META_PREFIX,
  DBML_RICH_NOTE_PROPERTIES,
  DBML_RICH_PLACEHOLDER_PROPERTY,
  DBML_RICH_TABLE_PROPERTIES,
  MAX_COMPOSITE_PAIRS,
  bareDbmlProperty,
  isValidTableAlias,
  linkKey,
  normaliseRelationshipRole,
  rationaleKeyOf,
  readMeta,
  sameLink,
  setMetaEntry,
  stickyColourOfHex,
  toTableNamingDocument,
} from '@erd-studio/core';
import type {
  Annotation,
  ColumnDef,
  Meta,
  MetaValue,
  NodePosition,
  Rationale,
  Relationship,
  SemanticTable,
  TableRelationship,
  TableRole,
  ViewConfig,
} from '../types/semantic';
import { COLUMN_NAME_PATTERN, TABLE_NAME_PATTERN } from '../types/naming';
import { isValidTableRole } from '../providers/payloadValidation';
import { buildDraftSubjectAreaDocument, toSubjectAreaSlug } from './dbtDraft';
import { libraryRelationshipsOf, nextCompositeKey, routeToLibrary } from './libraryRelationships';
import type { DbmlField, DbmlModel, DbmlRefEnd, DbmlTable } from './dbmlImportParse';

/** The `meta` key that holds what DBML says and ERD Studio has no field for. */
export const DBML_META_KEY = 'dbml';

/** A subject area name the suggestion falls back to. */
export const DBML_IMPORT_DEFAULT_NAME = 'dbml-import';

const SLUG_MAX = 64;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Table positions and sticky-note layouts from the `.dbdiagram` file next to
 * the DBML: the result of `readDbdiagramLayout` in `@erd-studio/core`
 * (structurally the same type). `schemaName` is as the file writes it;
 * `'public'` means no schema.
 */
export interface DbmlImportLayout {
  tables: ReadonlyArray<{ name: string; schemaName: string; x: number; y: number }>;
  stickies: ReadonlyArray<{ name: string; x: number; y: number; width?: number; height?: number }>;
  problems?: readonly string[];
}

/** What the planner needs from the Table Library (`TableLibraryService`). */
export interface DbmlImportLibrary {
  /** The library's spelling of `name`, ignoring case, or null (`findTableNameIgnoringCase`). */
  findTableName(name: string): string | null;
  /** The library table (`getTable`), or null when its file cannot be read. The planner copies it before changing it. */
  getTable(name: string): SemanticTable | null;
}

export interface PlanDbmlImportInput {
  model: DbmlModel;
  /** The sibling `.dbdiagram` layout, when there is one. */
  layout?: DbmlImportLayout;
  /** The layer id the subject area goes in. */
  layer: string;
  /** The new subject area's name (its file name, already validated). */
  subjectAreaName: string;
  /** The DBML file's name, for the default description. */
  fileName?: string;
  /** Overrides the description (default: the Project note; else "Imported from <file>." for a file ERD Studio did not write). */
  description?: string;
  library: DbmlImportLibrary;
  /**
   * Relationships go to their FK tables' library files (true), or into the
   * new subject area's `logical.relationships` (false). The command decides
   * with `usesLibraryRelationships`, as Draw from dbt does.
   */
  libraryRelationships: boolean;
  /** `drawnDiagramCopies(...)` of the project's other diagrams: a link one keeps a copy of stays in this file (see `routeToLibrary`). */
  diagramCopies?: readonly Relationship[];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** The subject area document, in the key order `createDomain` writes (v5 keys; see {@link serializeDbmlImportDocument}). */
export interface DbmlImportSubjectAreaDocument {
  schemaVersion: number;
  domain: string;
  layer: string;
  description: string;
  logical: { models: string[]; relationships: Relationship[] };
  viewConfig: ViewConfig;
}

/** A name the import changed. */
export interface DbmlImportRename {
  kind: 'table' | 'column';
  /** The table's imported name (for a column, the table it is in). */
  table: string;
  /** As the DBML file writes it (a table schema-qualified when it has a schema). */
  from: string;
  to: string;
  /**
   * `invalid-name`: not a name ERD Studio can use; `same-name`: another table
   * in the file has the same name in another schema or case; `duplicate`: two
   * columns became one name.
   */
  reason: 'invalid-name' | 'same-name' | 'duplicate';
}

/** A table the library already has: used as it is, never overwritten. */
export interface DbmlImportReused {
  /** The library's spelling. */
  name: string;
  /** As the DBML file writes it. */
  dbmlName: string;
  /** DBML columns the library's table does not have (they are not added). */
  missingColumns: string[];
}

/** Something in the file the import does not keep, and why. */
export interface DbmlImportDropped {
  what: string;
  why: string;
}

export interface DbmlImportReport {
  /** Tables created, in file order. */
  newTables: string[];
  reusedTables: DbmlImportReused[];
  renamed: DbmlImportRename[];
  dropped: DbmlImportDropped[];
  /** Kept, but worth saying (a value ERD Studio does not recognise, kept in `meta.dbml`). */
  notes: string[];
  /** Tables and columns that keep DBML-only settings in `meta.dbml`. */
  keptInMeta: number;
  relationships: number;
  /** Relationships stored in table files (library mode), the rest in the subject area file. */
  relationshipsInLibrary: number;
  /** Links the Table Library already stores: left as the library has them. */
  relationshipsAlreadyInLibrary: number;
  /** Refs that were optional (`?`): ERD Studio does not record optionality. */
  optionalRefs: number;
  /** The file is ERD Studio's own rich export (whose `?`s are its own, so not worth a word). */
  erdStudioExport: boolean;
  /** Tables placed from the layout; the rest are placed by the canvas when it opens. */
  positioned: number;
  unpositioned: number;
  stickyNotes: number;
  /** Whether a layout file was read, and what in it could not be. */
  layoutRead: boolean;
  layoutProblems: string[];
}

export interface DbmlImportPlan {
  subjectAreaName: string;
  layer: string;
  /** Every table in the subject area, in file order: what `logical.models` holds. */
  modelNames: string[];
  /** Table files to create (`saveTable`), library relationships already on them in library mode. */
  newTables: SemanticTable[];
  /** Names (the library's spelling) the library already has: referenced only. */
  reusedTables: string[];
  /** Every relationship, stored from its FK side. */
  relationships: Relationship[];
  /** Existing library tables that gain relationships (library mode): save each after the subject area is written. */
  changedLibraryTables: SemanticTable[];
  /** The subject area file's content. */
  document: DbmlImportSubjectAreaDocument;
  report: DbmlImportReport;
}

// ---------------------------------------------------------------------------
// Analysis: the defaults for the command's prompts
// ---------------------------------------------------------------------------

export interface DbmlImportAnalysis {
  /** A free subject area slug: the Project name, else the file name. */
  suggestedName: string;
  /** A configured layer a TableGroup or schema is named after, when one is. */
  suggestedLayer?: string;
  projectName: string | null;
  tableCount: number;
  relationshipCount: number;
  stickyNoteCount: number;
  erdStudioExport: boolean;
}

export interface AnalyseDbmlOptions {
  layerIds: readonly string[];
  fileName?: string;
  /** Subject area names already used (in the suggested layer); the suggestion avoids them. */
  takenSubjectAreaNames?: Iterable<string>;
}

/** Defaults for the import's prompts. */
export function analyseDbml(model: DbmlModel, options: AnalyseDbmlOptions): DbmlImportAnalysis {
  const analysis: DbmlImportAnalysis = {
    suggestedName: suggestDbmlSubjectAreaName(model, options.fileName, options.takenSubjectAreaNames),
    projectName: model.project?.name ?? null,
    tableCount: model.tables.length,
    relationshipCount: model.refs.length,
    stickyNoteCount: model.notes.length,
    erdStudioExport: model.erdStudioExport,
  };
  const layer = suggestDbmlLayer(model, options.layerIds);
  if (layer) analysis.suggestedLayer = layer;
  return analysis;
}

/**
 * The layer a file suggests: the TableGroup named after a configured layer
 * that holds the most tables (ERD Studio's export writes one, named after the
 * layer), else the configured layer most tables' schema is named after.
 * Matched without case; returned as `layerIds` spells it.
 */
export function suggestDbmlLayer(model: DbmlModel, layerIds: readonly string[]): string | undefined {
  const layerOf = (name: string | null | undefined): string | undefined =>
    name ? layerIds.find((id) => id.toLowerCase() === name.toLowerCase()) : undefined;
  let best: { layer: string; count: number } | undefined;
  for (const group of model.tableGroups) {
    const layer = layerOf(group.name);
    if (layer && (!best || group.tables.length > best.count)) best = { layer, count: group.tables.length };
  }
  if (best) return best.layer;
  const counts = new Map<string, number>();
  for (const table of model.tables) {
    const layer = layerOf(table.schema);
    if (layer) counts.set(layer, (counts.get(layer) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * A subject area slug for the file: its Project name, else its file name
 * (without folders or `.dbml`), else `dbml-import`; with `taken`, a `-2`,
 * `-3`… suffix keeps it free.
 */
export function suggestDbmlSubjectAreaName(model: DbmlModel, fileName?: string, taken: Iterable<string> = []): string {
  const base = toSubjectAreaSlug(model.project?.name ?? '')
    || toSubjectAreaSlug(baseNameOf(fileName ?? ''))
    || DBML_IMPORT_DEFAULT_NAME;
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, SLUG_MAX - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

/** `a/b/silver.dbml` → `silver`. */
function baseNameOf(fileName: string): string {
  const last = fileName.split(/[\\/]/).pop() ?? '';
  return last.replace(/\.dbml$/i, '');
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The nearest `TABLE_NAME_PATTERN` name: other characters become `_`, and a name not starting with a letter gets `t_`. */
export function sanitiseDbmlTableName(name: string): string {
  if (TABLE_NAME_PATTERN.test(name)) return name;
  let out = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!out) return 'table';
  if (!/^[A-Za-z]/.test(out)) out = `t_${out}`;
  return out;
}

/** The nearest `COLUMN_NAME_PATTERN` name: other characters become `_`. */
export function sanitiseDbmlColumnName(name: string): string {
  if (COLUMN_NAME_PATTERN.test(name)) return name;
  const out = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return out || 'column';
}

const lower = (s: string): string => s.toLowerCase();

/** `name`, or `name_2`, `name_3`… — the first not in `used` (lowercased); adds it. */
function freeName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let n = 2; used.has(lower(candidate)); n++) candidate = `${name}_${n}`;
  used.add(lower(candidate));
  return candidate;
}

/** How a DBML table is written: `schema.name`, or `name`. */
function dbmlTableLabel(table: Pick<DbmlTable, 'schema' | 'name'>): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** One DBML table as it will be imported. */
interface PlannedTable {
  dbml: DbmlTable;
  /** Its name in ERD Studio (the library's spelling when reused). */
  name: string;
  /** The new table to create; undefined when the library has it. */
  table?: SemanticTable;
  /** The library's copy, when reused and readable. */
  library?: SemanticTable | null;
  reused: boolean;
  /** DBML column name → imported column name. */
  columns: Map<string, string>;
  /** Lowercased imported column names that are the primary key. */
  primaryKey: Set<string>;
}

interface Context {
  report: DbmlImportReport;
  /** The file is ERD Studio's own export, so its `role` is a role whatever it says. */
  erdStudioExport: boolean;
}

/**
 * What importing `model` as a new subject area writes, and what it reports.
 * Never touches the library: reused tables are referenced, and in library
 * mode the ones that gain relationships come back as copies to save.
 */
export function planDbmlImport(input: PlanDbmlImportInput): DbmlImportPlan {
  const { model } = input;
  const report: DbmlImportReport = {
    newTables: [],
    reusedTables: [],
    renamed: [],
    dropped: [],
    notes: [],
    keptInMeta: 0,
    relationships: 0,
    relationshipsInLibrary: 0,
    relationshipsAlreadyInLibrary: 0,
    optionalRefs: 0,
    erdStudioExport: model.erdStudioExport,
    positioned: 0,
    unpositioned: 0,
    stickyNotes: 0,
    layoutRead: input.layout !== undefined,
    layoutProblems: [...(input.layout?.problems ?? [])],
  };
  const ctx: Context = { report, erdStudioExport: model.erdStudioExport };

  const names = planTableNames(model.tables, ctx);
  const planned: PlannedTable[] = model.tables.map((dbml, i) => planTable(dbml, names[i], input.library, ctx));
  applyEnums(model, planned);

  const relationships = planRelationships(model, tableLookup(planned), ctx);
  // An exported one-to-one marks its FK column `unique` (a composite one with a
  // unique index), which the relationship already says: that is not kept in meta.
  dropOneToOneUniques(planned, relationships);

  const newTables = planned.filter((p) => p.table).map((p) => p.table!);
  report.keptInMeta = newTables.reduce((n, t) => n + (hasDbmlMeta(t.meta) ? 1 : 0)
    + (t.columns ?? []).filter((c) => hasDbmlMeta(c.meta)).length, 0);

  // Relationships: to the library files of their FK tables, or the subject area file.
  let domainRelationships: Relationship[] = relationships;
  let changedLibraryTables: SemanticTable[] = [];
  if (input.libraryRelationships && relationships.length > 0) {
    const copies = new Map<string, SemanticTable | null>();
    const libraryCopy = (name: string): SemanticTable | null => {
      const key = lower(name);
      if (!copies.has(key)) {
        const found = planned.find((p) => p.reused && lower(p.name) === key);
        const source = found ? found.library ?? null : input.library.getTable(name);
        copies.set(key, source ? structuredClone(source) : null);
      }
      return copies.get(key) ?? null;
    };
    // Asked before routing, which adds to the copies.
    const stored = new Set(relationships.filter((rel) =>
      [rel.fromModel, rel.toModel].some((n) => {
        const m = libraryCopy(n);
        return !!m && libraryRelationshipsOf(m).some((r) => sameLink(r, rel));
      })));
    const routed = routeToLibrary(relationships, newTables, libraryCopy, input.diagramCopies ?? []);
    domainRelationships = routed.kept;
    changedLibraryTables = routed.changed.filter((m) => !newTables.includes(m));
    const kept = new Set(routed.kept);
    report.relationshipsAlreadyInLibrary = relationships.filter((r) => !kept.has(r) && stored.has(r)).length;
    report.relationshipsInLibrary = relationships.filter((r) => !kept.has(r) && !stored.has(r)).length;
  }
  report.relationships = relationships.length;

  const viewConfig = planViewConfig(model, planned, input.layout, ctx);
  const description = input.description
    ?? (model.project?.note
      || (model.erdStudioExport ? '' : `Imported from ${input.fileName ? lastSegment(input.fileName) : 'DBML'}.`));
  const document: DbmlImportSubjectAreaDocument = {
    ...buildDraftSubjectAreaDocument({
      domain: input.subjectAreaName,
      layer: input.layer,
      description,
      modelNames: planned.map((p) => p.name),
      relationships: domainRelationships,
    }),
    viewConfig,
  };

  reportFileExtras(model, input.layer, ctx);
  report.newTables = newTables.map((t) => t.name);
  report.reusedTables = planned.filter((p) => p.reused).map((p) => ({
    name: p.name,
    dbmlName: dbmlTableLabel(p.dbml),
    missingColumns: p.dbml.fields.filter((f) => !isPlaceholder(f) && !p.columns.has(f.name)).map((f) => f.name),
  }));

  return {
    subjectAreaName: input.subjectAreaName,
    layer: input.layer,
    modelNames: planned.map((p) => p.name),
    newTables,
    reusedTables: planned.filter((p) => p.reused).map((p) => p.name),
    relationships,
    changedLibraryTables,
    document,
    report,
  };
}

/**
 * Take out the `unique` a rich export adds to a one-to-one's FK column, or
 * the unnamed unique index it adds over a composite one's columns.
 */
function dropOneToOneUniques(planned: readonly PlannedTable[], relationships: readonly Relationship[]): void {
  const groups = new Map<string, Relationship[]>();
  for (const rel of relationships) {
    if (rel.cardinality !== 'one-to-one') continue;
    const key = `${lower(rel.fromModel)}\u0000${rel.compositeKey ?? `${lower(rel.fromColumn)}\u0001${lower(rel.toModel)}`}`;
    groups.set(key, [...(groups.get(key) ?? []), rel]);
  }
  for (const members of groups.values()) {
    const table = planned.find((p) => p.name === members[0].fromModel)?.table;
    if (!table) continue;
    if (members.length === 1) {
      const column = table.columns?.find((c) => c.name === members[0].fromColumn);
      const extras = dbmlMetaOf(column?.meta);
      if (column && extras?.unique === true) {
        delete extras.unique;
        column.meta = tidyDbmlMeta(column.meta!);
        if (Object.keys(column.meta).length === 0) delete column.meta;
      }
      continue;
    }
    const extras = dbmlMetaOf(table.meta);
    if (!extras || !Array.isArray(extras.indexes)) continue;
    const wanted = members.map((m) => lower(m.fromColumn)).sort().join('\u0000');
    const at = extras.indexes.findIndex((i) => {
      if (!i || typeof i !== 'object' || Array.isArray(i)) return false;
      const keys = Object.keys(i).sort().join(',');
      const cols = Array.isArray(i.columns) ? i.columns.map((c) => lower(String(c))).sort().join('\u0000') : '';
      return keys === 'columns,unique' && i.unique === true && cols === wanted;
    });
    if (at === -1) continue;
    extras.indexes.splice(at, 1);
    if (extras.indexes.length === 0) delete extras.indexes;
    table.meta = tidyDbmlMeta(table.meta!);
    if (Object.keys(table.meta).length === 0) delete table.meta;
  }
}

/** `meta.dbml` when it is a map. */
function dbmlMetaOf(meta: Meta | undefined): Record<string, MetaValue> | undefined {
  const value = meta?.[DBML_META_KEY];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** `meta` without an emptied `dbml` map. */
function tidyDbmlMeta(meta: Meta): Meta {
  const extras = dbmlMetaOf(meta);
  if (!extras || Object.keys(extras).length > 0) return meta;
  const rest = { ...meta };
  delete rest[DBML_META_KEY];
  return rest;
}

function lastSegment(fileName: string): string {
  return fileName.split(/[\\/]/).pop() ?? fileName;
}

function hasDbmlMeta(meta: Meta | undefined): boolean {
  return !!meta && DBML_META_KEY in meta;
}

/**
 * Each table's imported name: its own when valid and unique; the nearest
 * valid name otherwise; `{schema}_{name}` when another table in the file has
 * the same name in another schema or case; then `_2`, `_3`… for what is left.
 */
function planTableNames(tables: readonly DbmlTable[], ctx: Context): string[] {
  const bases = tables.map((t) => sanitiseDbmlTableName(t.name));
  const groups = new Map<string, number[]>();
  bases.forEach((b, i) => groups.set(lower(b), [...(groups.get(lower(b)) ?? []), i]));
  const candidates = bases.map((base, i) => {
    const group = groups.get(lower(base))!;
    const schema = tables[i].schema;
    return group.length > 1 && schema ? sanitiseDbmlTableName(`${schema}_${base}`) : base;
  });
  const used = new Set<string>();
  return candidates.map((candidate, i) => {
    const name = freeName(candidate, used);
    const original = tables[i].name;
    if (name !== original) {
      const sameName = groups.get(lower(bases[i]))!.length > 1;
      ctx.report.renamed.push({
        kind: 'table',
        table: name,
        from: dbmlTableLabel(tables[i]),
        to: name,
        reason: sameName ? 'same-name' : 'invalid-name',
      });
    }
    return name;
  });
}

function isPlaceholder(field: DbmlField): boolean {
  return field.properties[DBML_RICH_PLACEHOLDER_PROPERTY] !== undefined;
}

/** Text that reads as `true` (`'true'`, any case). */
const isTrue = (value: string): boolean => value.trim().toLowerCase() === 'true';

/**
 * `meta_json`'s value as meta entries, read as a model file's `meta:` is
 * (`readMeta`: numbers carried as their text, every key an own entry,
 * `__proto__` included), or undefined when it is not a JSON object.
 */
function metaFromJson(textValue: string): Meta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return readMeta(parsed) ?? {};
}

/** Merge `extras` into `meta.dbml` (what `meta_json` brought back first, then this file's own). */
function withDbmlMeta(meta: Meta, extras: Record<string, MetaValue>): Meta {
  if (Object.keys(extras).length === 0) return meta;
  const current = meta[DBML_META_KEY];
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  return { ...meta, [DBML_META_KEY]: { ...base, ...extras } };
}

/** The properties ERD Studio reads off a table or column that are not its own: kept under `meta.dbml.properties`. */
type Unknown = Record<string, string>;

function planTable(dbml: DbmlTable, name: string, library: DbmlImportLibrary, ctx: Context): PlannedTable {
  const libraryName = library.findTableName(name);
  const columns = new Map<string, string>();
  const primaryKey = new Set<string>();
  const label = dbmlTableLabel(dbml);

  if (libraryName !== null) {
    // Used as the library has it: map DBML columns onto the library's spelling where they exist.
    // A library file that cannot be read is still the table: its columns are taken on trust.
    const libraryTable = library.getTable(libraryName);
    for (const field of dbml.fields) {
      if (isPlaceholder(field)) continue;
      const wanted = sanitiseDbmlColumnName(field.name);
      if (!libraryTable) { columns.set(field.name, wanted); continue; }
      const existing = libraryTable.columns?.find((c) => lower(c.name) === lower(wanted));
      if (existing) columns.set(field.name, existing.name);
    }
    for (const c of libraryTable?.columns ?? []) if (c.isPrimaryKey) primaryKey.add(lower(c.name));
    return { dbml, name: libraryName, library: libraryTable, reused: true, columns, primaryKey };
  }

  // Columns: placeholder dropped, names made valid and unique.
  const used = new Set<string>();
  const kept = dbml.fields.filter((f) => !isPlaceholder(f));
  const pkIndexColumns = new Set(
    dbml.indexes.filter((i) => i.pk).flatMap((i) => i.columns.filter((c) => !c.expression).map((c) => c.value)),
  );
  const table: SemanticTable = { name };
  if (dbml.schema) table.schema = dbml.schema;

  const tableUnknown: Unknown = {};
  let meta: Meta = {};
  const rationale: Rationale = {};
  for (const [key, value] of Object.entries(dbml.properties)) {
    const bare = bareDbmlProperty(key);
    const rationaleKey = rationaleKeyOf(key);
    if (bare === DBML_RICH_TABLE_PROPERTIES.role) {
      // A table file keeps any role text it holds, so ERD Studio's own export
      // carries one back as it is; another tool's `role` must be one of ours.
      if (isValidTableRole(value) || (ctx.erdStudioExport && value.trim() !== '')) table.modelRole = value as TableRole;
      else {
        setMetaEntry(tableUnknown, key, value);
        ctx.report.notes.push(`${label}: "${value}" is not an ERD Studio table role, so it was kept in meta.${DBML_META_KEY}.`);
      }
    } else if (bare === DBML_RICH_TABLE_PROPERTIES.schema && dbml.schema === null && value !== '') {
      // The export says `public` this way: DBML reads `Table public.x` as no schema.
      table.schema = value;
    } else if (bare === DBML_RICH_TABLE_PROPERTIES.schema && value === dbml.schema) {
      // Says what the table name already does.
    } else if (bare === DBML_RICH_TABLE_PROPERTIES.grain) {
      table.grain = value;
    } else if (bare === DBML_RICH_TABLE_PROPERTIES.alias) {
      if (isValidTableAlias(value)) table.alias = value;
      else {
        setMetaEntry(tableUnknown, key, value);
        ctx.report.notes.push(`${label}: "${value}" cannot be a warehouse table name, so it was kept in meta.${DBML_META_KEY}.`);
      }
    } else if (rationaleKey) {
      rationale[rationaleKey] = value;
    } else if (bare === DBML_RICH_META_JSON_PROPERTY) {
      const entries = metaFromJson(value);
      if (entries) meta = { ...meta, ...entries };
      else {
        setMetaEntry(tableUnknown, key, value);
        ctx.report.notes.push(`${label}: ${key} is not valid JSON, so it was kept as text in meta.${DBML_META_KEY}.`);
      }
    } else if (bare.startsWith(DBML_RICH_META_PREFIX) && bare.length > DBML_RICH_META_PREFIX.length) {
      setMetaEntry(meta, bare.slice(DBML_RICH_META_PREFIX.length), value);
    } else {
      setMetaEntry(tableUnknown, key, value);
    }
  }

  const tableExtras: Record<string, MetaValue> = {};
  if (name !== dbml.name) {
    if (!table.alias && isValidTableAlias(dbml.name)) table.alias = dbml.name;
    else tableExtras.name = dbml.name;
  }
  if (dbml.alias) tableExtras.alias = dbml.alias;
  if (dbml.headerColor) tableExtras.header_color = dbml.headerColor;

  if (dbml.note) table.description = dbml.note;
  table.columns = kept.map((field) => {
    const columnName = freeName(sanitiseDbmlColumnName(field.name), used);
    columns.set(field.name, columnName);
    if (columnName !== field.name) {
      const valid = sanitiseDbmlColumnName(field.name) === field.name;
      ctx.report.renamed.push({ kind: 'column', table: name, from: field.name, to: columnName, reason: valid ? 'duplicate' : 'invalid-name' });
    }
    const column = planColumn(field, columnName, `${label}.${field.name}`, ctx);
    if (field.pk || pkIndexColumns.has(field.name)) {
      column.isPrimaryKey = true;
      primaryKey.add(lower(columnName));
    }
    return column;
  });
  // A table without columns (an export's placeholder dropped) has none, as its file reads back.
  if (table.columns.length === 0) delete table.columns;
  const nonPk = dbml.indexes.filter((i) => !i.pk);
  if (nonPk.length > 0) {
    tableExtras.indexes = nonPk.map((i) => {
      const out: Record<string, MetaValue> = {
        columns: i.columns.map((c) => (c.expression ? `\`${c.value}\`` : columns.get(c.value) ?? c.value)),
      };
      if (i.unique) out.unique = true;
      if (i.name) out.name = i.name;
      if (i.type) out.type = i.type;
      if (i.note) out.note = i.note;
      return out;
    });
  }
  if (dbml.checks.length > 0) tableExtras.checks = dbml.checks.map(checkValue);
  if (Object.keys(tableUnknown).length > 0) tableExtras.properties = tableUnknown;

  if (Object.keys(rationale).length > 0) table.rationale = rationale;
  meta = withDbmlMeta(meta, tableExtras);
  if (Object.keys(meta).length > 0) table.meta = meta;
  return { dbml, name, table, reused: false, columns, primaryKey };
}

function checkValue(check: { expression: string; name?: string }): MetaValue {
  return check.name ? { name: check.name, expression: check.expression } : check.expression;
}

const SCD_TYPES: Record<string, 0 | 1 | 2> = { '0': 0, '1': 1, '2': 2 };
const ADDITIVE_TYPES = new Set<NonNullable<ColumnDef['additiveType']>>(['additive', 'semi-additive', 'non-additive']);

function planColumn(field: DbmlField, name: string, label: string, ctx: Context): ColumnDef {
  const column: ColumnDef = { name, dataType: field.type, description: field.note };
  const unknown: Unknown = {};
  let meta: Meta = {};
  for (const [key, value] of Object.entries(field.properties)) {
    const bare = bareDbmlProperty(key);
    if (bare === DBML_RICH_COLUMN_PROPERTIES.naturalKey) {
      if (isTrue(value)) column.isNaturalKey = true;
    } else if (bare === DBML_RICH_COLUMN_PROPERTIES.foreignKey) {
      if (isTrue(value)) column.isForeignKey = true;
    } else if (bare === DBML_RICH_COLUMN_PROPERTIES.scdType) {
      const scd = SCD_TYPES[value.trim()];
      if (scd !== undefined) column.scdType = scd;
      else {
        setMetaEntry(unknown, key, value);
        ctx.report.notes.push(`${label}: SCD type "${value}" is not 0, 1 or 2, so it was kept in meta.${DBML_META_KEY}.`);
      }
    } else if (bare === DBML_RICH_COLUMN_PROPERTIES.additiveType) {
      const additive = value.trim() as NonNullable<ColumnDef['additiveType']>;
      if (ADDITIVE_TYPES.has(additive)) column.additiveType = additive;
      else {
        setMetaEntry(unknown, key, value);
        ctx.report.notes.push(`${label}: additive type "${value}" is not additive, semi-additive or non-additive, so it was kept in meta.${DBML_META_KEY}.`);
      }
    } else if (bare === DBML_RICH_META_JSON_PROPERTY) {
      const entries = metaFromJson(value);
      if (entries) meta = { ...meta, ...entries };
      else {
        setMetaEntry(unknown, key, value);
        ctx.report.notes.push(`${label}: ${key} is not valid JSON, so it was kept as text in meta.${DBML_META_KEY}.`);
      }
    } else if (bare.startsWith(DBML_RICH_META_PREFIX) && bare.length > DBML_RICH_META_PREFIX.length) {
      setMetaEntry(meta, bare.slice(DBML_RICH_META_PREFIX.length), value);
    } else {
      setMetaEntry(unknown, key, value);
    }
  }

  const extras: Record<string, MetaValue> = {};
  if (name !== field.name) extras.name = field.name;
  if (field.notNull) extras.not_null = true;
  if (field.unique) extras.unique = true;
  if (field.increment) extras.increment = true;
  if (field.default) extras.default = field.default.type === 'expression' ? `\`${field.default.value}\`` : field.default.value;
  if (field.checks.length > 0) extras.checks = field.checks.map(checkValue);
  if (Object.keys(unknown).length > 0) extras.properties = unknown;
  meta = withDbmlMeta(meta, extras);
  if (Object.keys(meta).length > 0) column.meta = meta;
  return column;
}

/** Enum values for columns of an enum type (`meta.dbml.enum`), once every table is planned. */
function applyEnums(model: DbmlModel, planned: readonly PlannedTable[]): void {
  if (model.enums.length === 0) return;
  const byType = new Map<string, string[]>();
  for (const e of model.enums) {
    byType.set(e.schema ? `${e.schema}.${e.name}` : e.name, e.values);
    if (!e.schema || e.schema === 'public') byType.set(e.name, e.values);
  }
  for (const p of planned) {
    if (!p.table) continue;
    for (const field of p.dbml.fields) {
      const values = byType.get(field.type) ?? byType.get(field.type.replace(/^public\./, ''));
      if (!values) continue;
      const column = p.table.columns?.find((c) => c.name === p.columns.get(field.name));
      if (column) column.meta = withDbmlMeta(column.meta ?? {}, { enum: [...values] });
    }
  }
}

/** Finds a planned table from a DBML reference (schema and name as the file writes them). */
type TableLookup = (schema: string | null, name: string) => PlannedTable | undefined;

function tableLookup(planned: readonly PlannedTable[]): TableLookup {
  const schemaKey = (schema: string | null): string => (schema === null || schema === 'public' ? '' : schema);
  return (schema, name) =>
    planned.find((p) => p.dbml.name === name && schemaKey(p.dbml.schema) === schemaKey(schema))
    ?? planned.find((p) => lower(p.dbml.name) === lower(name) && lower(schemaKey(p.dbml.schema)) === lower(schemaKey(schema)));
}

/** Whether a ref end's relation is "many" (`*`, `1..*`) rather than "one" (`1`, `0..1`). */
function isMany(relation: string): boolean {
  return relation === '*' || relation.endsWith('..*');
}

function isOptional(relation: string): boolean {
  return relation.startsWith('0');
}

function planRelationships(model: DbmlModel, lookup: TableLookup, ctx: Context): Relationship[] {
  const out: Relationship[] = [];
  const seen = new Set<string>();
  // compositeKey names used per from-table: its library entries, then this import's.
  const compositeKeys = new Map<string, Array<Pick<TableRelationship, 'compositeKey'>>>();
  const entriesOf = (p: PlannedTable): Array<Pick<TableRelationship, 'compositeKey'>> => {
    const key = lower(p.name);
    if (!compositeKeys.has(key)) compositeKeys.set(key, [...(p.library?.relationships ?? [])]);
    return compositeKeys.get(key)!;
  };

  for (const ref of model.refs) {
    const what = describeRef(ref.ends, ref.name);
    const ends = ref.ends.map((end) => resolveEnd(end, lookup)) as [ResolvedEnd | string, ResolvedEnd | string];
    const problem = ends.find((e): e is string => typeof e === 'string');
    if (problem) {
      ctx.report.dropped.push({ what, why: problem });
      continue;
    }
    const [a, b] = ends as [ResolvedEnd, ResolvedEnd];
    if (a.columns.length !== b.columns.length || a.columns.length === 0) {
      ctx.report.dropped.push({ what, why: 'its two ends name different numbers of columns.' });
      continue;
    }
    if (isOptional(ref.ends[0].relation) || isOptional(ref.ends[1].relation)) ctx.report.optionalRefs++;

    const manyA = isMany(ref.ends[0].relation);
    const manyB = isMany(ref.ends[1].relation);
    let from = a;
    let to = b;
    let cardinality: Relationship['cardinality'];
    if (manyA !== manyB) {
      cardinality = 'many-to-one';
      if (manyB) [from, to] = [b, a];
    } else if (manyA) {
      cardinality = 'many-to-many';
      if (ref.declaredAt === 1) [from, to] = [b, a];
    } else {
      cardinality = 'one-to-one';
      // The column that declared the ref holds the key; in ERD Studio's own
      // export, the first end (it writes every Ref from its foreign-key end,
      // whatever the keys say); else the end that is not its table's whole
      // key; else the first.
      const wholeKeyA = isWholeKey(a);
      const wholeKeyB = isWholeKey(b);
      if (ref.declaredAt !== undefined) {
        if (ref.declaredAt === 1) [from, to] = [b, a];
      } else if (!ctx.erdStudioExport && wholeKeyA && !wholeKeyB) {
        [from, to] = [b, a];
      }
    }

    const settings = [
      ref.onDelete ? `delete: ${ref.onDelete}` : '',
      ref.onUpdate ? `update: ${ref.onUpdate}` : '',
      ref.color ? `color: ${ref.color}` : '',
      ref.inactive ? 'inactive' : '',
    ].filter(Boolean);
    if (settings.length > 0) {
      ctx.report.dropped.push({
        what: `${what}: ${settings.join(', ')}`,
        why: 'ERD Studio does not record what a reference does on delete or update, its colour, or whether it is inactive. The relationship itself was imported.',
      });
    }

    const role = normaliseRelationshipRole(ref.name ?? undefined);
    const pairs = from.columns.map((column, i) => ({ fromColumn: column, toColumn: to.columns[i] }));
    let compositeKey: string | undefined;
    if (pairs.length > 1 && pairs.length <= MAX_COMPOSITE_PAIRS) {
      const entries = entriesOf(from.table);
      compositeKey = nextCompositeKey(entries, to.table.name);
      entries.push({ compositeKey });
    } else if (pairs.length > MAX_COMPOSITE_PAIRS) {
      ctx.report.notes.push(`${what} joins more than ${MAX_COMPOSITE_PAIRS} column pairs, so it was imported as ${pairs.length} separate relationships.`);
    }
    for (const pair of pairs) {
      const rel: Relationship = {
        fromModel: from.table.name,
        fromColumn: pair.fromColumn,
        toModel: to.table.name,
        toColumn: pair.toColumn,
        cardinality,
        ...(role ? { role } : {}),
        ...(compositeKey ? { compositeKey } : {}),
      };
      const key = linkKey(rel);
      if (seen.has(key)) {
        ctx.report.dropped.push({ what, why: 'another reference already joins the same columns.' });
        continue;
      }
      seen.add(key);
      out.push(rel);
    }
  }
  return out;
}

interface ResolvedEnd {
  table: PlannedTable;
  /** Imported column names. */
  columns: string[];
}

/** An end's table and columns as imported, or why it cannot be. */
function resolveEnd(end: DbmlRefEnd, lookup: TableLookup): ResolvedEnd | string {
  const table = lookup(end.schema, end.table);
  const label = end.schema ? `${end.schema}.${end.table}` : end.table;
  if (!table) return `${label} is not a table in the file.`;
  const columns: string[] = [];
  for (const column of end.columns) {
    const name = table.columns.get(column)
      ?? [...table.columns].find(([dbmlName]) => lower(dbmlName) === lower(column))?.[1];
    if (name === undefined) {
      return table.reused
        ? `${table.name} is already in your Table Library and has no column ${column}; the library's table is used as it is.`
        : `${label} has no column ${column}.`;
    }
    columns.push(name);
  }
  return { table, columns };
}

/** Whether an end's columns are its table's whole primary key. */
function isWholeKey(end: ResolvedEnd): boolean {
  const pk = end.table.primaryKey;
  return pk.size > 0 && pk.size === end.columns.length && end.columns.every((c) => pk.has(lower(c)));
}

function describeRef(ends: readonly [DbmlRefEnd, DbmlRefEnd], name: string | null): string {
  const end = (e: DbmlRefEnd): string => {
    const table = e.schema ? `${e.schema}.${e.table}` : e.table;
    return e.columns.length === 1 ? `${table}.${e.columns[0]}` : `${table}.(${e.columns.join(', ')})`;
  };
  return `Reference ${name ? `"${name}" ` : ''}${end(ends[0])} – ${end(ends[1])}`;
}

// ---------------------------------------------------------------------------
// Layout and sticky notes
// ---------------------------------------------------------------------------

const STICKY_GAP = 260;
const STICKY_ABOVE = 200;

function planViewConfig(model: DbmlModel, planned: readonly PlannedTable[], layout: DbmlImportLayout | undefined, ctx: Context): ViewConfig {
  const viewConfig: ViewConfig = {};
  const positions: Record<string, NodePosition> = {};
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  const schemaOf = (s: string | null): string => (s === null || s === '' ? 'public' : s);
  for (const p of planned) {
    const schema = schemaOf(p.dbml.schema);
    const tables = layout?.tables ?? [];
    const at = tables.find((t) => t.name === p.dbml.name && schemaOf(t.schemaName) === schema)
      ?? tables.find((t) => lower(t.name) === lower(p.dbml.name) && lower(schemaOf(t.schemaName)) === lower(schema));
    if (at && finite(at.x) && finite(at.y) && !(p.name in positions)) {
      positions[p.name] = { x: at.x, y: at.y };
      ctx.report.positioned++;
    } else {
      ctx.report.unpositioned++;
    }
  }
  if (Object.keys(positions).length > 0) viewConfig.positions = positions;

  const annotations = planAnnotations(model, planned, layout, positions, ctx);
  if (annotations.length > 0) viewConfig.annotations = annotations;
  return viewConfig;
}

function planAnnotations(
  model: DbmlModel,
  planned: readonly PlannedTable[],
  layout: DbmlImportLayout | undefined,
  positions: Record<string, NodePosition>,
  ctx: Context,
): Annotation[] {
  const placed = Object.values(positions);
  const originX = placed.length > 0 ? Math.min(...placed.map((p) => p.x)) : 0;
  const originY = (placed.length > 0 ? Math.min(...placed.map((p) => p.y)) : 0) - STICKY_ABOVE;
  const ids = new Set<string>();
  let unplaced = 0;
  return model.notes.map((note) => {
    const id = freeName(`dbml-${sanitiseDbmlColumnName(note.name)}`, ids);
    const stickies = layout?.stickies ?? [];
    const at = stickies.find((s) => s.name === note.name) ?? stickies.find((s) => lower(s.name) === lower(note.name));
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    const annotation: Annotation = at && finite(at.x) && finite(at.y)
      ? { id, text: note.content, x: at.x, y: at.y }
      : { id, text: note.content, x: originX + STICKY_GAP * unplaced++, y: originY };
    if (at && finite(at.width) && at.width > 0) annotation.width = at.width;
    if (at && finite(at.height) && at.height > 0) annotation.height = at.height;
    const color = note.color ? stickyColourOfHex(note.color) : undefined;
    if (color) annotation.color = color;

    for (const [key, value] of Object.entries(note.properties)) {
      if (bareDbmlProperty(key) === DBML_RICH_NOTE_PROPERTIES.linkedTable) {
        const linked = findTableByLabel(planned, value);
        if (linked) annotation.linkedModel = linked.name;
        // ERD Studio's own note keeps a link to a table not in the diagram, as the
        // diagram had it (it draws once that table is added).
        else if (ctx.erdStudioExport && value.trim() !== '') annotation.linkedModel = value;
        else ctx.report.dropped.push({ what: `Sticky note ${note.name}'s link to ${value}`, why: `${value} is not a table in the file.` });
      } else {
        ctx.report.dropped.push({ what: `Sticky note ${note.name}: ${key}`, why: 'ERD Studio sticky notes have no custom properties.' });
      }
    }
    ctx.report.stickyNotes++;
    return annotation;
  });
}

/** The table a `linked_table` value names: `schema.name` or `name`, exact first, then ignoring case. */
function findTableByLabel(planned: readonly PlannedTable[], value: string): PlannedTable | undefined {
  const matches = (p: PlannedTable, same: (a: string, b: string) => boolean): boolean =>
    same(dbmlTableLabel(p.dbml), value) || same(p.dbml.name, value) || same(p.name, value);
  return planned.find((p) => matches(p, (a, b) => a === b)) ?? planned.find((p) => matches(p, (a, b) => lower(a) === lower(b)));
}

// ---------------------------------------------------------------------------
// The rest of the file
// ---------------------------------------------------------------------------

/** Report what the file holds beyond tables, refs and notes that is not kept. */
function reportFileExtras(model: DbmlModel, layer: string, ctx: Context): void {
  const { dropped } = ctx.report;
  for (const records of model.records) {
    const table = records.schema ? `${records.schema}.${records.table}` : records.table;
    dropped.push({
      what: `Records for ${table} (${records.rows} ${records.rows === 1 ? 'row' : 'rows'})`,
      why: 'ERD Studio does not keep sample data.',
    });
  }
  for (const [key, value] of Object.entries(model.project?.properties ?? {})) {
    dropped.push({
      what: `Project setting ${key}: ${value}`,
      why: key === 'database_type' ? 'ERD Studio does not record the database type.' : 'ERD Studio subject areas have no project settings.',
    });
  }
  for (const group of model.tableGroups) {
    // ERD Studio's export writes the layer as a group; a group named after the chosen layer is that.
    if (lower(group.name) === lower(layer)) continue;
    dropped.push({
      what: `Table group ${group.name} (${group.tables.length} ${group.tables.length === 1 ? 'table' : 'tables'})`,
      why: 'ERD Studio has no table groups; its tables were imported.',
    });
  }
  if (model.dependencies > 0) {
    dropped.push({ what: `${model.dependencies} dependency ${model.dependencies === 1 ? 'arrow' : 'arrows'}`, why: 'ERD Studio draws relationships, not dependencies.' });
  }
  if (model.diagramViews > 0) {
    dropped.push({ what: `${model.diagramViews} diagram ${model.diagramViews === 1 ? 'view' : 'views'}`, why: 'Each ERD Studio subject area is one view.' });
  }
}

// ---------------------------------------------------------------------------
// The subject area file and the dry-run summary
// ---------------------------------------------------------------------------

/**
 * The subject area file's text, formatted as `createDomain` writes it: under
 * the v5 keys, or in the v6 naming (#182) for a project that writes it
 * (`TableLibraryService.writesTableNaming()`).
 */
export function serializeDbmlImportDocument(doc: DbmlImportSubjectAreaDocument, tableNaming = false): string {
  return JSON.stringify(tableNaming ? toTableNamingDocument({ ...doc }) : doc, null, 2) + '\n';
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function someOf(names: readonly string[], shown = 4): string {
  const head = names.slice(0, shown).join(', ');
  return names.length > shown ? `${head} and ${names.length - shown} more` : head;
}

/**
 * The dry-run summary the command shows before writing: what is created,
 * what is reused, where the relationships go, the layout, and what was
 * renamed or left out. Plain text, one point per line.
 */
export function describeDbmlImportPlan(plan: DbmlImportPlan, options: { layerLabel?: string; layoutFileName?: string } = {}): string {
  const { report } = plan;
  const lines: string[] = [];
  const layer = options.layerLabel ?? plan.layer;
  lines.push(`Import ${plural(plan.modelNames.length, 'table')} into a new diagram "${plan.subjectAreaName}" in the ${layer} layer.`);
  if (report.newTables.length > 0) lines.push(`• New: ${someOf(report.newTables)}.`);
  if (report.reusedTables.length > 0) {
    const differ = report.reusedTables.filter((r) => r.missingColumns.length > 0).length;
    lines.push(`• Already in your Table Library, used as they are: ${someOf(report.reusedTables.map((r) => r.name))}.`
      + (differ > 0 ? ` ${plural(differ, 'of them has', 'of them have')} columns the file has and the library does not; those are not added.` : ''));
  }
  if (report.relationships > 0) {
    const where = report.relationshipsInLibrary > 0
      ? (report.relationshipsInLibrary === report.relationships - report.relationshipsAlreadyInLibrary
        ? ' saved in the tables\' files'
        : ` (${report.relationshipsInLibrary} saved in the tables' files)`)
      : '';
    const already = report.relationshipsAlreadyInLibrary > 0
      ? ` ${plural(report.relationshipsAlreadyInLibrary, 'is', 'are')} already in your Table Library and kept as it has them.`
      : '';
    lines.push(`• ${plural(report.relationships, 'relationship')}${where}.${already}`);
  }
  if (report.optionalRefs > 0 && !report.erdStudioExport) {
    lines.push(`• ${plural(report.optionalRefs, 'reference is', 'references are')} optional (?). ERD Studio doesn't record that, so they are imported as plain relationships.`);
  }
  const layoutName = options.layoutFileName ?? 'the layout file';
  if (!report.layoutRead) {
    lines.push('• No layout file: the diagram is laid out automatically when it opens.');
  } else if (report.positioned === 0) {
    lines.push(`• ${layoutName} has no positions for these tables: the diagram is laid out automatically when it opens.`);
  } else if (report.unpositioned > 0) {
    lines.push(`• Layout: ${report.positioned} of ${plan.modelNames.length} tables placed from ${layoutName}; the rest are placed when it opens.`);
  } else {
    lines.push(`• Layout: every table placed from ${layoutName}.`);
  }
  for (const problem of report.layoutProblems) lines.push(`• ${layoutName}: ${problem}`);
  if (report.stickyNotes > 0) lines.push(`• ${plural(report.stickyNotes, 'sticky note')}.`);
  if (report.keptInMeta > 0) {
    lines.push(`• DBML settings ERD Studio has no field for (not null, defaults, indexes, …) are kept in the meta of ${plural(report.keptInMeta, 'table or column', 'tables and columns')}, under "${DBML_META_KEY}".`);
  }
  if (report.renamed.length > 0) {
    const shown = report.renamed.slice(0, 4).map((r) => (r.kind === 'column' ? `${r.table}.${r.from} → ${r.to}` : `${r.from} → ${r.to}`));
    const more = report.renamed.length > 4 ? ` and ${report.renamed.length - 4} more` : '';
    lines.push(`• Renamed to names ERD Studio can use: ${shown.join(', ')}${more}.`);
  }
  for (const note of report.notes.slice(0, 3)) lines.push(`• ${note}`);
  if (report.notes.length > 3) lines.push(`• And ${plural(report.notes.length - 3, 'more note')}.`);
  if (report.dropped.length > 0) {
    lines.push('Left out:');
    for (const d of report.dropped.slice(0, 5)) lines.push(`• ${d.what}: ${d.why}`);
    if (report.dropped.length > 5) lines.push(`• And ${plural(report.dropped.length - 5, 'more thing')}.`);
  }
  return lines.join('\n');
}
