/**
 * Import DBML — turn a DBML file (ERD Studio's own rich export, or one from
 * dbdiagram.io or any other tool) into a NEW logical subject area: the table
 * files the library does not have yet, the subject area document, its
 * relationships and, from the file's own `erd_layout` when it has one, the
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
 * | `Ref`, and `[ref: …]` on a column | a relationship stored from its FK (many) side — of a one-to-one, the column that declared it, else the second end as DBML reads it; a composite one is one entry per column pair sharing `compositeKey`, imported whole or not at all; the ref's name is its role; `?` (optional) is not kept |
 * | `Note name [color]` and its layout | an annotation; `linked_table` links it to a table (in ERD Studio's own export, even one not in the diagram, as the diagram had it) |
 * | the Project's `erd_layout` | table positions (by name: the DBML name, then the imported one, then ignoring case) and sticky-note boxes (by Note name) |
 * | the placeholder column (`erd_placeholder`) | dropped: the table has no columns |
 *
 * What DBML can say and ERD Studio has no field for is kept under the
 * reserved `dbml` key of the table's or column's `meta` (see
 * {@link DBML_META_KEY}), so nothing a team wrote is lost and a later rich
 * export carries it back out (inside `meta_json`):
 *
 * - column: `not_null`, `unique` (not the `unique` an exported one-to-one
 *   adds to its FK column), `increment`, `default` (an expression in
 *   backticks), `checks`, `enum` (an enum type's values; `{ name, note }`
 *   for one with a note), `name` (the original name, when it had to
 *   change), `properties` (custom properties that are not ERD Studio's);
 * - table: `indexes` (every index but the primary key), `checks`,
 *   `header_color`, `alias` (the DBML alias, `Table users as U`), `name` (the
 *   original name, when it had to change and cannot be the warehouse
 *   `alias`), `properties`.
 *
 * Dropped, and listed in the report: Records (sample rows), a ref's
 * `delete` / `update` / `color` / `inactive`, the project's `database_type`
 * and other settings, table groups other than the layer's, an enum no new
 * column has, dependency arrows, diagram views, and a sticky note's own
 * properties. A property set both plain and with the `erd_` prefix is read
 * from the prefixed one; the plain one is the team's own, kept in
 * `meta.dbml.properties`.
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
  DBML_DIAGRAM_PROPERTIES,
  DBML_RICH_COLUMN_PROPERTIES,
  DBML_RICH_META_JSON_PROPERTY,
  DBML_RICH_META_PREFIX,
  DBML_RICH_NOTE_PROPERTIES,
  DBML_RICH_PLACEHOLDER_PROPERTY,
  DBML_RICH_PROPERTY_PREFIX,
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
import { normaliseName } from './nameUtils';
import { isValidTableRole } from '../providers/payloadValidation';
import { buildDraftSubjectAreaDocument, freeSubjectAreaSlug, serializeDraftSubjectAreaDocument, toSubjectAreaSlug } from './dbtDraft';
import { libraryRelationshipsOf, nextCompositeKey, routeToLibrary } from './libraryRelationships';
import type { DbmlEnum, DbmlEnumValue, DbmlField, DbmlModel, DbmlProperties, DbmlRefEnd, DbmlTable } from './dbmlImportParse';

/** The `meta` key that holds what DBML says and ERD Studio has no field for. */
export const DBML_META_KEY = 'dbml';

/** A subject area name the suggestion falls back to. */
export const DBML_IMPORT_DEFAULT_NAME = 'dbml-import';


// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Table positions and sticky-note boxes from the file's own `erd_layout`
 * (its Project's last key, as ERD Studio's rich export and its stored
 * diagrams write it): what `readErdLayoutDbml` in `@erd-studio/core/dbml`
 * reads, structurally the same. Positions are keyed by table name, with no
 * schema; a sticky note's `id` is its Note's name.
 */
export interface DbmlImportLayout {
  positions: Readonly<Record<string, { x: number; y: number }>>;
  stickies: ReadonlyArray<{ id: string; x: number; y: number; width?: number; height?: number }>;
  /** Sentences for what in `erd_layout` could not be read. */
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
  /** The file's `erd_layout`, when it has one. */
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
  /**
   * The new diagram can hold no relationships (a `.dbml` diagram, D5): a
   * relationship the library cannot take (its foreign-key table's file could
   * not be read) is left out and named in `report.dropped`, never kept in
   * the document or counted. Needs `libraryRelationships`.
   */
  diagramHoldsNoRelationships?: boolean;
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

/** What kind of thing an import leaves out: the summary gives each kind one line. */
export type DbmlImportDroppedKind =
  | 'table-group'
  | 'database-type'
  | 'project-setting'
  | 'records'
  | 'enum'
  | 'dependencies'
  | 'diagram-views'
  | 'reference'
  | 'reference-settings'
  | 'sticky-note';

/** Something in the file the import does not keep, and why. */
export interface DbmlImportDropped {
  kind: DbmlImportDroppedKind;
  /** The whole description (`Table group people (2 tables)`). */
  what: string;
  why: string;
  /** Its short name, for a summary line that lists several of a kind (`people`; a reference's settings). */
  item: string;
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
  /** Whether the file had an `erd_layout`, and what in it could not be read. */
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
  return freeSubjectAreaSlug(base, taken);
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

/** A real number (not NaN or ±Infinity). */
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * `name`, or `name_2`, `name_3`… — the first not in `used` (normalised) and
 * not `taken`; adds it to `used`.
 */
function freeName(name: string, used: Set<string>, taken: (candidate: string) => boolean = () => false): string {
  let candidate = name;
  for (let n = 2; used.has(normaliseName(candidate)) || taken(candidate); n++) candidate = `${name}_${n}`;
  used.add(normaliseName(candidate));
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
  /** ERD Studio's plain (v1) export: a one-to-one's first end is the FK. */
  erdStudioPlainExport: boolean;
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
  const ctx: Context = { report, erdStudioExport: model.erdStudioExport, erdStudioPlainExport: model.erdStudioPlainExport === true };

  const names = planTableNames(model.tables, input.library, ctx);
  const planned: PlannedTable[] = model.tables.map((dbml, i) => planTable(dbml, names[i], input.library, ctx));
  applyEnums(model, planned, ctx);

  let relationships = planRelationships(model, tableLookup(planned), ctx);
  const newTables = planned.filter((p) => p.table).map((p) => p.table!);

  // Relationships: to the library files of their FK tables, or the subject area file.
  let domainRelationships: Relationship[] = relationships;
  let changedLibraryTables: SemanticTable[] = [];
  if (input.libraryRelationships && relationships.length > 0) {
    const copies = new Map<string, SemanticTable | null>();
    const libraryCopy = (name: string): SemanticTable | null => {
      const key = normaliseName(name);
      if (!copies.has(key)) {
        const found = planned.find((p) => p.reused && normaliseName(p.name) === key);
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
    // A composite goes whole into one file or not at all: core reads a group
    // from one file, and fewer pairs than the reference has are not one. It is
    // left out where the library already stores some of its pairs (which stay
    // as the library has them), and stays here where another diagram keeps a
    // copy of one.
    const held = new Set((input.diagramCopies ?? []).map(linkKey));
    const left = new Set<Relationship>();
    const keptHere = new Set<Relationship>();
    for (const members of compositeGroupsOf(relationships)) {
      const already = members.filter((m) => stored.has(m));
      if (already.length > 0 && already.length < members.length) {
        for (const m of members) left.add(m);
        const what = describeComposite(members);
        report.dropped.push({
          kind: 'reference',
          what,
          item: what.replace(/^Reference /, ''),
          why: `your Table Library already stores ${already.map(describeLink).join(' and ')} on its own, so the composite was not imported.`,
        });
      } else if (members.some((m) => held.has(linkKey(m)))) {
        for (const m of members) keptHere.add(m);
      }
    }
    relationships = relationships.filter((r) => !left.has(r));
    const routed = routeToLibrary(relationships.filter((r) => !keptHere.has(r)), newTables, libraryCopy, input.diagramCopies ?? []);
    const kept = new Set([...keptHere, ...routed.kept]);
    if (input.diagramHoldsNoRelationships && kept.size > 0) {
      // Nowhere to store them: named, not counted (the S5 rule for a DBML diagram).
      const unstored = relationships.filter((r) => kept.has(r));
      const groups = compositeGroupsOf(unstored);
      const grouped = new Set(groups.flat());
      const why = "not stored, because its table's file could not be read.";
      for (const members of groups) {
        const what = describeComposite(members);
        report.dropped.push({ kind: 'reference', what, item: what.replace(/^Reference /, ''), why });
      }
      for (const rel of unstored.filter((r) => !grouped.has(r))) {
        report.dropped.push({ kind: 'reference', what: `Reference ${describeLink(rel)}`, item: describeLink(rel), why });
      }
      relationships = relationships.filter((r) => !kept.has(r));
      kept.clear();
    }
    domainRelationships = relationships.filter((r) => kept.has(r));
    changedLibraryTables = routed.changed.filter((m) => !newTables.includes(m));
    report.relationshipsAlreadyInLibrary = relationships.filter((r) => !kept.has(r) && stored.has(r)).length;
    report.relationshipsInLibrary = relationships.filter((r) => !kept.has(r) && !stored.has(r)).length;
  }

  // An exported one-to-one marks its FK column `unique` (a composite one with a
  // unique index), which the relationship already says: that is not kept in meta.
  dropOneToOneUniques(planned, relationships);
  report.keptInMeta = newTables.reduce((n, t) => n + (hasDbmlMeta(t.meta) ? 1 : 0)
    + (t.columns ?? []).filter((c) => hasDbmlMeta(c.meta)).length, 0);
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
    const key = `${normaliseName(rel.fromModel)}\u0000${rel.compositeKey ?? `${normaliseName(rel.fromColumn)}\u0001${normaliseName(rel.toModel)}`}`;
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
    const wanted = members.map((m) => normaliseName(m.fromColumn)).sort().join('\u0000');
    const at = extras.indexes.findIndex((i) => {
      if (!i || typeof i !== 'object' || Array.isArray(i)) return false;
      const keys = Object.keys(i).sort().join(',');
      const cols = Array.isArray(i.columns) ? i.columns.map((c) => normaliseName(String(c))).sort().join('\u0000') : '';
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
 * A name kept as the file writes it is handed out first, so a renamed table
 * (`"dim-customer"` → `dim_customer`) never takes the name of a table the
 * file really calls that.
 */
function planTableNames(tables: readonly DbmlTable[], library: DbmlImportLibrary, ctx: Context): string[] {
  const groups = new Map<string, number>();
  for (const t of tables) groups.set(normaliseName(t.name), (groups.get(normaliseName(t.name)) ?? 0) + 1);
  const sameName = (t: DbmlTable): boolean => groups.get(normaliseName(t.name))! > 1;
  const candidates = tables.map((t) => {
    const base = sanitiseDbmlTableName(t.name);
    return sameName(t) && t.schema ? sanitiseDbmlTableName(`${t.schema}_${base}`) : base;
  });
  const used = new Set<string>();
  const names: string[] = new Array(tables.length);
  // Names as the file writes them first, then the changed ones, each in file order.
  for (const keptAsWritten of [true, false]) {
    candidates.forEach((candidate, i) => {
      // Only a name the file wrote may be a library table (planTable reuses it);
      // a name made up here steers clear of the library instead.
      const madeUp = (n: string): boolean => n !== tables[i].name && library.findTableName(n) !== null;
      if ((candidate === tables[i].name) === keptAsWritten) names[i] = freeName(candidate, used, madeUp);
    });
  }
  names.forEach((name, i) => {
    if (name === tables[i].name) return;
    ctx.report.renamed.push({
      kind: 'table',
      table: name,
      from: dbmlTableLabel(tables[i]),
      to: name,
      reason: sameName(tables[i]) ? 'same-name' : 'invalid-name',
    });
  });
  return names;
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

/** Whether a bare property name (`meta_owner`) is one of the `meta_` properties. */
const isMetaProperty = (bare: string): boolean =>
  bare === DBML_RICH_META_JSON_PROPERTY || (bare.startsWith(DBML_RICH_META_PREFIX) && bare.length > DBML_RICH_META_PREFIX.length);

const TABLE_PROPERTY_NAMES: ReadonlySet<string> = new Set(Object.values(DBML_RICH_TABLE_PROPERTIES));
const COLUMN_PROPERTY_NAMES: ReadonlySet<string> = new Set(Object.values(DBML_RICH_COLUMN_PROPERTIES));
const readsTableProperty = (bare: string): boolean =>
  TABLE_PROPERTY_NAMES.has(bare) || rationaleKeyOf(bare) !== undefined || isMetaProperty(bare);
const readsColumnProperty = (bare: string): boolean => COLUMN_PROPERTY_NAMES.has(bare) || isMetaProperty(bare);

/**
 * The plain property names ERD Studio reads that the file also writes with
 * the `erd_` prefix (`grain` beside `erd_grain`). The prefix is there for a
 * team whose own properties use the plain name, so the prefixed one is read
 * and the plain one is the team's own, kept in `meta.dbml.properties`,
 * whichever comes first.
 */
function shadowedByPrefix(properties: DbmlProperties, reads: (bare: string) => boolean): Set<string> {
  const shadowed = new Set<string>();
  for (const key of Object.keys(properties)) {
    const bare = bareDbmlProperty(key);
    if (bare !== key && Object.hasOwn(properties, bare) && reads(bare)) shadowed.add(bare);
  }
  return shadowed;
}

function shadowedNote(label: string, key: string): string {
  return `${label}: both ${key} and ${DBML_RICH_PROPERTY_PREFIX}${key} are set. ERD Studio read ${DBML_RICH_PROPERTY_PREFIX}${key}; ${key} was kept in meta.${DBML_META_KEY}.`;
}

function planTable(dbml: DbmlTable, name: string, library: DbmlImportLibrary, ctx: Context): PlannedTable {
  // A name the file wrote is the library's table; one the import made up never is (planTableNames).
  const libraryName = name === dbml.name ? library.findTableName(name) : null;
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
      const existing = libraryTable.columns?.find((c) => normaliseName(c.name) === normaliseName(wanted));
      if (existing) columns.set(field.name, existing.name);
    }
    for (const c of libraryTable?.columns ?? []) if (c.isPrimaryKey) primaryKey.add(normaliseName(c.name));
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
  const shadowed = shadowedByPrefix(dbml.properties, readsTableProperty);
  for (const [key, value] of Object.entries(dbml.properties)) {
    const bare = bareDbmlProperty(key);
    const rationaleKey = rationaleKeyOf(key);
    if (shadowed.has(key)) {
      setMetaEntry(tableUnknown, key, value);
      ctx.report.notes.push(shadowedNote(label, key));
    } else if (bare === DBML_RICH_TABLE_PROPERTIES.role) {
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
  // Names as the file writes them first, then the changed ones, as for tables
  // (planTableNames): a cleaned-up `order-id` never takes `order_id`'s own name.
  const columnNames = new Map<DbmlField, string>();
  for (const keptAsWritten of [true, false]) {
    for (const field of kept) {
      const candidate = sanitiseDbmlColumnName(field.name);
      if ((candidate === field.name) === keptAsWritten) columnNames.set(field, freeName(candidate, used));
    }
  }
  table.columns = kept.map((field) => {
    const columnName = columnNames.get(field)!;
    columns.set(field.name, columnName);
    if (columnName !== field.name) {
      const valid = sanitiseDbmlColumnName(field.name) === field.name;
      ctx.report.renamed.push({ kind: 'column', table: name, from: field.name, to: columnName, reason: valid ? 'duplicate' : 'invalid-name' });
    }
    const column = planColumn(field, columnName, `${label}.${field.name}`, ctx);
    if (field.pk || pkIndexColumns.has(field.name)) {
      column.isPrimaryKey = true;
      primaryKey.add(normaliseName(columnName));
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
  const shadowed = shadowedByPrefix(field.properties, readsColumnProperty);
  for (const [key, value] of Object.entries(field.properties)) {
    const bare = bareDbmlProperty(key);
    if (shadowed.has(key)) {
      setMetaEntry(unknown, key, value);
      ctx.report.notes.push(shadowedNote(label, key));
    } else if (bare === DBML_RICH_COLUMN_PROPERTIES.naturalKey) {
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

/**
 * Enum values for columns of an enum type (`meta.dbml.enum`: each value's
 * name, or `{ name, note }` for one with a note), once every table is
 * planned. A type name without a schema is one in `public`, as DBML reads it.
 * An enum no new column has is reported: its values are kept nowhere else.
 */
function applyEnums(model: DbmlModel, planned: readonly PlannedTable[], ctx: Context): void {
  if (model.enums.length === 0) return;
  const byType = new Map<string, DbmlEnum>();
  for (const e of model.enums) {
    byType.set(e.schema ? `${e.schema}.${e.name}` : e.name, e);
    if (!e.schema || e.schema === 'public') byType.set(e.name, e);
  }
  const used = new Set<DbmlEnum>();
  for (const p of planned) {
    if (!p.table) continue;
    for (const field of p.dbml.fields) {
      const found = byType.get(field.type) ?? byType.get(field.type.replace(/^public\./, ''));
      if (!found) continue;
      const column = p.table.columns?.find((c) => c.name === p.columns.get(field.name));
      if (!column) continue;
      column.meta = withDbmlMeta(column.meta ?? {}, { enum: found.values.map(enumValue) });
      used.add(found);
    }
  }
  for (const e of model.enums) {
    if (used.has(e)) continue;
    const label = e.schema ? `${e.schema}.${e.name}` : e.name;
    ctx.report.dropped.push({
      kind: 'enum',
      what: `Enum ${label} (${plural(e.values.length, 'value')})`,
      item: label,
      why: 'ERD Studio keeps an enum\'s values on the columns of its type, and no table this import creates has one.',
    });
  }
}

function enumValue(value: DbmlEnumValue): MetaValue {
  return value.note ? { name: value.name, note: value.note } : value.name;
}

/** Finds a planned table from a DBML reference (schema and name as the file writes them). */
type TableLookup = (schema: string | null, name: string) => PlannedTable | undefined;

function tableLookup(planned: readonly PlannedTable[]): TableLookup {
  const schemaKey = (schema: string | null): string => (schema === null || schema === 'public' ? '' : schema);
  return (schema, name) =>
    planned.find((p) => p.dbml.name === name && schemaKey(p.dbml.schema) === schemaKey(schema))
    ?? planned.find((p) => normaliseName(p.dbml.name) === normaliseName(name) && normaliseName(schemaKey(p.dbml.schema)) === normaliseName(schemaKey(schema)));
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
  const seen = new Map<string, Seen>();
  // compositeKey names used per from-table: its library entries, then this import's.
  const compositeKeys = new Map<string, Array<Pick<TableRelationship, 'compositeKey'>>>();
  const entriesOf = (p: PlannedTable): Array<Pick<TableRelationship, 'compositeKey'>> => {
    const key = normaliseName(p.name);
    if (!compositeKeys.has(key)) compositeKeys.set(key, [...(p.library?.relationships ?? [])]);
    return compositeKeys.get(key)!;
  };
  const dropReference = (what: string, why: string): void => {
    ctx.report.dropped.push({ kind: 'reference', what, item: what.replace(/^Reference /, ''), why });
  };

  for (const ref of model.refs) {
    const what = describeRef(ref.ends, ref.name);
    const ends = ref.ends.map((end) => resolveEnd(end, lookup)) as [ResolvedEnd | string, ResolvedEnd | string];
    const problem = ends.find((e): e is string => typeof e === 'string');
    if (problem) {
      dropReference(what, problem);
      continue;
    }
    const [a, b] = ends as [ResolvedEnd, ResolvedEnd];
    if (a.columns.length !== b.columns.length || a.columns.length === 0) {
      dropReference(what, 'its two ends name different numbers of columns.');
      continue;
    }

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
      // The column that declared the ref holds the key. Otherwise ERD Studio's
      // plain export wrote the FK end first (`from.col - to.col`), so keep it;
      // its rich export and DBML itself read the second end as the FK
      // (`users.id - user_infos.user_id`), whatever the keys say; in another
      // tool's file, the first end when only the second is its table's whole
      // key (`badge_id - badges.id`).
      const onlySecondIsKey = !isWholeKey(a) && isWholeKey(b);
      if (ref.declaredAt !== undefined) {
        if (ref.declaredAt === 1) [from, to] = [b, a];
      } else if (ctx.erdStudioPlainExport) {
        // Already FK first.
      } else if (ctx.erdStudioExport || !onlySecondIsKey) {
        [from, to] = [b, a];
      }
    }

    const role = normaliseRelationshipRole(ref.name ?? undefined);
    const rels: Relationship[] = from.columns.map((column, i) => ({
      fromModel: from.table.name,
      fromColumn: column,
      toModel: to.table.name,
      toColumn: to.columns[i],
      cardinality,
      ...(role ? { role } : {}),
    }));
    const keys = rels.map(linkKey);
    if (new Set(keys).size < keys.length) {
      dropReference(what, 'it joins the same columns more than once.');
      continue;
    }
    const composite = rels.length > 1 && rels.length <= MAX_COMPOSITE_PAIRS;
    if (composite) {
      // A composite is all or nothing (a group of fewer pairs is not one): it
      // takes the place of single references over some of its columns, and is
      // left out where another composite already joins one of them.
      const earlier = [...new Set(keys.map((k) => seen.get(k)).filter((s): s is Seen => s !== undefined))];
      if (earlier.some((s) => s.composite)) {
        dropReference(what, 'another composite reference already joins some of the same columns.');
        continue;
      }
      for (const s of earlier) {
        out.splice(out.indexOf(s.rel), 1);
        dropReference(s.what, `${what.replace(/^Reference/, 'the composite reference')} joins the same columns, so it was imported as part of that one.`);
      }
      const entries = entriesOf(from.table);
      const compositeKey = nextCompositeKey(entries, to.table.name);
      entries.push({ compositeKey });
      for (const rel of rels) rel.compositeKey = compositeKey;
    } else if (rels.length > MAX_COMPOSITE_PAIRS) {
      ctx.report.notes.push(`${what} joins more than ${MAX_COMPOSITE_PAIRS} column pairs, so it was imported as ${rels.length} separate relationships.`);
    }

    // A single reference, or a pair of one too wide to be a composite, may repeat an earlier one.
    const repeated = composite ? 0 : keys.filter((k) => seen.has(k)).length;
    rels.forEach((rel, i) => {
      if (seen.has(keys[i]) && !composite) return;
      seen.set(keys[i], { rel, what, composite });
      out.push(rel);
    });
    if (repeated === rels.length) {
      dropReference(what, 'another reference already joins the same columns.');
      continue;
    }
    if (repeated > 0) dropReference(what, `another reference already joins ${repeated} of its column pairs; the rest were imported.`);
    if (isOptional(ref.ends[0].relation) || isOptional(ref.ends[1].relation)) ctx.report.optionalRefs++;
    const settings = [
      ref.onDelete ? `delete: ${ref.onDelete}` : '',
      ref.onUpdate ? `update: ${ref.onUpdate}` : '',
      ref.color ? `color: ${ref.color}` : '',
      ref.inactive ? 'inactive' : '',
    ].filter(Boolean).join(', ');
    if (settings) ctx.report.dropped.push({ kind: 'reference-settings', what: `${what} (${settings})`, item: settings, why: REF_SETTINGS_WHY });
  }
  return out;
}

/** Each composite's members, by from-table and `compositeKey`. */
function compositeGroupsOf(relationships: readonly Relationship[]): Relationship[][] {
  const groups = new Map<string, Relationship[]>();
  for (const rel of relationships) {
    if (!rel.compositeKey) continue;
    const key = `${normaliseName(rel.fromModel)}\u0000${normaliseName(rel.compositeKey)}`;
    groups.set(key, [...(groups.get(key) ?? []), rel]);
  }
  return [...groups.values()];
}

/** `a.x – b.y`, in imported names. */
function describeLink(rel: Relationship): string {
  return `${rel.fromModel}.${rel.fromColumn} – ${rel.toModel}.${rel.toColumn}`;
}

/** `Reference a.(x, y) – b.(u, v)`, in imported names. */
function describeComposite(members: readonly Relationship[]): string {
  const columns = (pick: (r: Relationship) => string): string => members.map(pick).join(', ');
  return `Reference ${members[0].fromModel}.(${columns((r) => r.fromColumn)}) – ${members[0].toModel}.(${columns((r) => r.toColumn)})`;
}

/** A relationship planned, with the reference it came from. */
interface Seen {
  rel: Relationship;
  /** The reference, as the report names it. */
  what: string;
  /** It is one pair of a composite. */
  composite: boolean;
}

const REF_SETTINGS_WHY = 'ERD Studio does not record what a reference does on delete or update, its colour, or whether it is inactive. The relationships were imported.';

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
      ?? [...table.columns].find(([dbmlName]) => normaliseName(dbmlName) === normaliseName(column))?.[1];
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
  return pk.size > 0 && pk.size === end.columns.length && end.columns.every((c) => pk.has(normaliseName(c)));
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
  const placed = layout?.positions ?? {};
  // Own entries only: a table may be called `constructor` or `toString`.
  const own = (name: string): { x: number; y: number } | undefined => (Object.hasOwn(placed, name) ? placed[name] : undefined);
  const anyCase = (name: string): { x: number; y: number } | undefined => {
    const key = Object.keys(placed).find((k) => normaliseName(k) === normaliseName(name));
    return key === undefined ? undefined : placed[key];
  };
  for (const p of planned) {
    // The name as the file writes it, then the name it is imported as, then either ignoring case.
    const at = own(p.dbml.name) ?? own(p.name) ?? anyCase(p.dbml.name) ?? anyCase(p.name);
    if (at && finite(at.x) && finite(at.y) && !Object.hasOwn(positions, p.name)) {
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
    const at = stickies.find((s) => s.id === note.name) ?? stickies.find((s) => normaliseName(s.id) === normaliseName(note.name));
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
        else {
          ctx.report.dropped.push({
            kind: 'sticky-note',
            what: `Sticky note ${note.name}'s link to ${value}`,
            item: `${note.name}'s link to ${value}`,
            why: `${value} is not a table in the file.`,
          });
        }
      } else {
        ctx.report.dropped.push({
          kind: 'sticky-note',
          what: `Sticky note ${note.name}'s property ${key}`,
          item: `${key} on ${note.name}`,
          why: 'ERD Studio sticky notes have no custom properties.',
        });
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
  return planned.find((p) => matches(p, (a, b) => a === b)) ?? planned.find((p) => matches(p, (a, b) => normaliseName(a) === normaliseName(b)));
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
      kind: 'records',
      what: `Records for ${table} (${plural(records.rows, 'row')})`,
      item: table,
      why: 'ERD Studio does not keep sample data.',
    });
  }
  for (const [key, value] of Object.entries(model.project?.properties ?? {})) {
    // The positions: read into the layout, not left out.
    if (key.toLowerCase() === DBML_DIAGRAM_PROPERTIES.layout) continue;
    dropped.push(key === 'database_type'
      ? { kind: 'database-type', what: `The database type (${value})`, item: value, why: 'ERD Studio does not record the database type.' }
      : { kind: 'project-setting', what: `Project setting ${key} (${value})`, item: key, why: 'ERD Studio subject areas have no project settings.' });
  }
  for (const group of model.tableGroups) {
    // ERD Studio's export writes the layer as a group; a group named after the chosen layer is that.
    if (normaliseName(group.name) === normaliseName(layer)) continue;
    dropped.push({
      kind: 'table-group',
      what: `Table group ${group.name} (${plural(group.tables.length, 'table')})`,
      item: group.name,
      why: 'ERD Studio has no table groups. The tables were imported.',
    });
  }
  if (model.dependencies > 0) {
    const what = plural(model.dependencies, 'dependency arrow');
    dropped.push({ kind: 'dependencies', what, item: what, why: 'ERD Studio draws relationships, not dependencies.' });
  }
  if (model.diagramViews > 0) {
    const what = plural(model.diagramViews, 'diagram view');
    dropped.push({ kind: 'diagram-views', what, item: what, why: 'Each ERD Studio subject area is one view.' });
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
  return serializeDraftSubjectAreaDocument(doc, tableNaming);
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function someOf(names: readonly string[], shown = 4): string {
  const head = names.slice(0, shown).join(', ');
  return names.length > shown ? `${head} and ${names.length - shown} more` : head;
}

/** What {@link describeDbmlImportPlan} needs to know beyond the plan. */
export interface DescribeDbmlImportOptions {
  /** The layer as the user sees it (default: its id). */
  layerLabel?: string;
  /**
   * A project that stores DBML: where its relationships are written, as the
   * user sees the paths (`tables/silver/_relationships.dbml`). Absent for a
   * YAML project, whose relationships go in the tables' own files. Either
   * way the layout goes in the diagram file (a DBML diagram's `erd_layout`).
   */
  dbml?: { relationshipsFiles: readonly string[] };
}

/**
 * The dry-run summary the command shows before writing: what is created,
 * what is reused, where the relationships go, the layout, and what was
 * renamed or left out. Plain text, one point per line.
 */
export function describeDbmlImportPlan(plan: DbmlImportPlan, options: DescribeDbmlImportOptions = {}): string {
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
    // A DBML project writes them to the library's relationships files, a YAML one to the tables' own files.
    const home = options.dbml
      ? (options.dbml.relationshipsFiles.length > 0 ? someOf(options.dbml.relationshipsFiles, 3) : 'the Table Library\'s relationships files')
      : 'the tables\' files';
    const where = report.relationshipsInLibrary > 0
      // "All saved in …" only when every one is: links the library already
      // stores are counted in `relationships` but not written.
      ? (report.relationshipsInLibrary === report.relationships
        ? ` saved in ${home}`
        : ` (${report.relationshipsInLibrary} saved in ${home})`)
      : '';
    const already = report.relationshipsAlreadyInLibrary > 0
      ? ` ${plural(report.relationshipsAlreadyInLibrary, 'is', 'are')} already in your Table Library and kept as it has them.`
      : '';
    lines.push(`• ${plural(report.relationships, 'relationship')}${where}.${already}`);
  }
  if (report.optionalRefs > 0 && !report.erdStudioExport) {
    lines.push(`• ${plural(report.optionalRefs, 'reference is', 'references are')} optional (?). ERD Studio doesn't record that, so they are imported as plain relationships.`);
  }
  // Opening it lays it out and saves that layout, as for any new diagram: in a DBML project, in the diagram file's erd_layout.
  const laidOut = options.dbml
    ? 'the diagram is laid out automatically when it opens, and that layout is saved in the diagram file.'
    : 'the diagram is laid out automatically when it opens.';
  if (!report.layoutRead) {
    lines.push(`• No erd_layout in the file: ${laidOut}`);
  } else if (report.positioned === 0) {
    lines.push(`• The file's erd_layout has no positions for these tables: ${laidOut}`);
  } else if (report.unpositioned > 0) {
    lines.push(`• Layout: ${report.positioned} of ${plan.modelNames.length} tables placed from the file's erd_layout; the rest are placed when it opens.`);
  } else {
    lines.push(`• Layout: every table placed from the file's erd_layout.`);
  }
  for (const problem of report.layoutProblems) lines.push(`• ${problem}.`);
  if (report.stickyNotes > 0) lines.push(`• ${plural(report.stickyNotes, 'sticky note')}.`);
  if (report.keptInMeta > 0) {
    lines.push(`• DBML settings ERD Studio has no field for (not null, defaults, indexes, …) are kept in the meta of ${plural(report.keptInMeta, 'table or column', 'tables and columns')}, under "${DBML_META_KEY}".`);
  }
  if (report.renamed.length > 0) {
    const renames = renameEntries(report.renamed);
    const more = renames.length > 4 ? ` and ${renames.length - 4} more` : '';
    lines.push(`• Renamed to names ERD Studio can use: ${renames.slice(0, 4).join(', ')}${more}.`);
  }
  for (const note of report.notes.slice(0, 3)) lines.push(`• ${note}`);
  if (report.notes.length > 3) lines.push(`• And ${plural(report.notes.length - 3, 'more note')}.`);
  if (report.dropped.length > 0) {
    lines.push('Left out:');
    const groups = droppedGroups(report.dropped);
    for (const items of groups.slice(0, DROPPED_LINES)) {
      lines.push(items.length === 1 ? `• ${items[0].what}: ${items[0].why}` : `• ${droppedGroupLabel(items)}: ${items[0].why}`);
    }
    const rest = groups.slice(DROPPED_LINES).reduce((n, items) => n + items.length, 0);
    if (rest > 0) lines.push(`• And ${plural(rest, 'more thing')}.`);
  }
  return lines.join('\n');
}

/** Renames as the summary names them: a column renamed the same way in several tables once. */
function renameEntries(renamed: readonly DbmlImportRename[]): string[] {
  const columns = new Map<string, DbmlImportRename[]>();
  for (const r of renamed) {
    if (r.kind !== 'column') continue;
    const key = `${r.from}\u0000${r.to}`;
    columns.set(key, [...(columns.get(key) ?? []), r]);
  }
  const out: string[] = [];
  const shown = new Set<string>();
  for (const r of renamed) {
    if (r.kind === 'table') {
      out.push(`${r.from} → ${r.to}`);
      continue;
    }
    const key = `${r.from}\u0000${r.to}`;
    if (shown.has(key)) continue;
    shown.add(key);
    const same = columns.get(key)!;
    out.push(same.length > 1 ? `${r.from} → ${r.to} (in ${plural(same.length, 'table')})` : `${r.table}.${r.from} → ${r.to}`);
  }
  return out;
}

/** How many lines the summary gives what was left out; the rest are counted. */
const DROPPED_LINES = 8;

/** The order the summary lists what was left out in: the file's own settings, then references, then sticky notes. */
const DROPPED_ORDER: readonly DbmlImportDroppedKind[] = [
  'table-group', 'database-type', 'project-setting', 'records', 'enum', 'dependencies', 'diagram-views',
  'reference', 'reference-settings', 'sticky-note',
];

/** What was left out, one group per kind and reason, in {@link DROPPED_ORDER} and then file order. */
function droppedGroups(dropped: readonly DbmlImportDropped[]): DbmlImportDropped[][] {
  const groups = new Map<string, DbmlImportDropped[]>();
  const rank = (d: DbmlImportDropped): number => {
    const at = DROPPED_ORDER.indexOf(d.kind);
    return at === -1 ? DROPPED_ORDER.length : at;
  };
  for (const d of [...dropped].sort((a, b) => rank(a) - rank(b))) {
    const key = `${d.kind}\u0000${d.why}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.values()];
}

/** One line's name for several things of one kind: `2 table groups (a, b)`. */
function droppedGroupLabel(items: readonly DbmlImportDropped[]): string {
  const n = items.length;
  const examples = someOf([...new Set(items.map((d) => d.item))], 3);
  switch (items[0].kind) {
    case 'reference-settings': return `Settings on ${n} references (${examples})`;
    case 'records': return `Records for ${n} tables (${examples})`;
    case 'table-group': return `${plural(n, 'table group')} (${examples})`;
    case 'project-setting': return `${plural(n, 'project setting')} (${examples})`;
    case 'enum': return `${plural(n, 'enum')} (${examples})`;
    case 'reference': return `${plural(n, 'reference')} (${examples})`;
    case 'sticky-note': return `${plural(n, 'sticky note setting')} (${examples})`;
    default: return `${plural(n, 'thing')} (${examples})`;
  }
}
