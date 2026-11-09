/**
 * **Import Power BI or Fabric semantic model…** — the engine: read a semantic
 * model saved as files (a Power BI Project's `<Name>.SemanticModel` folder, a
 * Fabric Git-integration folder, Tabular Editor's save-to-folder) and turn it
 * into DBML that **Import DBML…** (`src/commands/importDbml.ts`) takes as it
 * is: the command hands the text to the same flow Open Example Diagram uses,
 * so the user still names the diagram and sees the dry run first.
 *
 * Three formats, all read here:
 *
 * - **TMSL**: one JSON file, `<Name>.SemanticModel/model.bim` (the older
 *   `<Name>.Dataset/model.bim`, or a bare `*.bim`): `{ model: { tables,
 *   relationships } }`, or a `createOrReplace` / `create` script around it.
 * - **TMDL**: `<Name>.SemanticModel/definition/` — `model.tmdl`,
 *   `tables/*.tmdl`, `relationships.tmdl`, `database.tmdl`, `cultures/…` —
 *   an indentation-based text format (tabs by default; spaces read too):
 *   `table 'Date Table'`, nested `column Amount` with `dataType: decimal`,
 *   `isKey`, `isHidden`…, `measure X = …` (one line, an indented block, or a
 *   ``` fence), `/// description` above an object, `relationship <id>` with
 *   `fromColumn: Sales.CustomerKey` / `toColumn: 'Date Table'.DateKey`.
 *   A TMDL script (`createOrReplace` → `database` → `model` → tables) reads
 *   the same; a property value wrapped whole in `"…"` is unwrapped; LF, CRLF
 *   and a lone CR all end a line.
 * - **Tabular Editor Save to Folder**: `database.json` and one JSON file per
 *   table, column, measure, partition, relationship, role…
 *   (`tables/<Table>/columns/<Column>.json`), relationships kept with their
 *   table when saved so (`TabularEditor_Relationships`): put back together as
 *   one TMSL database (`semanticModelFolder.ts`) and read as TMSL.
 *   Model features an ERD has no place for (hierarchies, roles with their
 *   row filters and column permissions, perspectives, cultures, shared
 *   expressions, data sources, KPIs, variations, DAX user-defined functions,
 *   calendars, report settings such as
 *   `formatString` or `sortByColumn`) are read just enough to be named in the
 *   loss ledger ({@link SemanticModelFeature}); unknown properties and tool
 *   metadata (`lineageTag`, `annotation`s other than the date/time one) are
 *   skipped over.
 *
 * The mapping to DBML ({@link semanticModelToDbml}):
 *
 * | Semantic model | DBML (and so ERD Studio) |
 * |---|---|
 * | table, its description | `Table snake_name`, its `Note` |
 * | column, `dataType`, description | `snake_name <type> [note: …]` ({@link SEMANTIC_MODEL_TYPE_MAP}); a description is kept exactly as written |
 * | `dateTime` with `UnderlyingDateTimeDataType` `Date` / `Time` (else a date-only or time-only `formatString`) | `date` / `time` ({@link semanticDateTimeKind}) |
 * | `isKey` (else, with `inferKeys`, the one column a many-to-one relationship points at; in a date table whose `isKey` date column no relationship joins, the one column they all join, the date column then `unique`) | `pk` |
 * | a "one" end that is not the table's key (Power BI requires it unique), `isUnique` | `unique` |
 * | `isNullable: false` | `not null` |
 * | a partition's M navigation (`Source{[Schema="dbo",Item="X"]}`, `{[Name=…,Kind="Table"]}`; an incremental-refresh table's `refreshPolicy` `sourceExpression`; comments ignored; a workbook's sheet is a file, not a table) or Direct Lake entity | `meta_power_bi_source: 'dbo.X'` |
 * | relationship many → one | `Ref: fact.col > dim.col`; the many side's column gets `foreign_key: 'true'` |
 * | one → one, many → many | `-`, `<>` |
 * | `isActive: false` | the Ref kept, named (so its role is) "inactive in Power BI"; skipped with `inactiveRelationships: 'skip'` |
 * | the original name, when snake_case changed it | `meta_power_bi_name` (ERD Studio's `meta.power_bi_name`) |
 * | a hidden table or column | `meta_power_bi_hidden: 'true'` |
 * | a calculated column or table | kept, with `meta_power_bi_calculated: 'true'`; its DAX is not imported (a ledger `lost` entry, and the note says so when there is no description to keep) |
 * | a query that merges or appends (`Table.NestedJoin`, `Table.Combine`…) | `meta_power_bi_sources: 'dbo.Orders, Customer'`: every source it reads ({@link mCombinedSources}) |
 * | `crossFilteringBehavior` / `securityFilteringBehavior` both ways, `relyOnReferentialIntegrity` | not kept: a ledger `lost` entry on the relationship's line |
 *
 * A table with no columns (a measure table) cannot be a DBML table: it is a
 * `lost` ledger entry by name (its measures counted as every table's are).
 *
 * Skipped, and listed in `skipped`: measures (counted per table, never their
 * DAX), calculation groups, auto date/time tables (`LocalDateTable_…`,
 * `DateTableTemplate_…`, and any private variations-only table) with the
 * relationships into them, relationships whose ends are missing or skipped.
 * Hidden row-number columns (TMSL's `RowNumber-…`) are dropped silently (the
 * engine makes them; they are not the model's).
 *
 * The loss ledger (`result.ledger`, `importLedger.ts`): every model feature
 * not kept is a `lost` / `notDesign` entry with its table and (TMDL) line;
 * `changed` entries say what was kept in another form (a `dateTime` read as
 * `date`, an inferred key, a unique "one" end, the warehouse table a
 * partition reads); `skipped` entries count what `skipped` already lists.
 *
 * Names: Power BI names often carry spaces and punctuation (`'Date Table'`,
 * `Sales Amount`); ERD Studio names must match `TABLE_NAME_PATTERN` /
 * `COLUMN_NAME_PATTERN`, so every name becomes snake_case
 * ({@link toSnakeCaseName}: `Date Table` → `date_table`, `CustomerKey` →
 * `customer_key`; Cyrillic and Greek spelled in Latin letters, a table name
 * cut to {@link MAX_TABLE_NAME_LENGTH}), deterministically, and Refs use the converted names. Two
 * names that convert to the same one get `_2`, `_3`… (and a warning).
 *
 * One file that does not read never fails the model: a TMDL file (or the
 * object in it that does not read), or a Save to Folder JSON file, is left
 * out and recorded in the ledger as a `problem` with its file and line; only
 * a model with nothing left to draw fails. TMSL entries carry their
 * `model.bim` line too ({@link parseJsonWithLines}).
 *
 * Pure: no `vscode`, no Node built-ins. The host passes paths and file texts.
 */

import { createLedger, type ImportLedger, type LedgerEntry, type LedgerUnit } from './importLedger';
import { jsonErrorLineOf, parseJsonWithLines } from './jsonLines';
import { mCombineCalls, mName, mReferences, parseMLet, type MCombineCall } from './powerQueryLet';
import { isSaveToFolderLayout, readFolderModel, type JsonPlace } from './semanticModelFolder';
import { DBML_RICH_META_PREFIX } from '@erd-studio/core';

import { COLUMN_NAME_PATTERN, TABLE_NAME_PATTERN } from '../types/naming';

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** `tmsl`: one `model.bim`; `tmdl`: a TMDL definition folder; `folder`: Tabular Editor's Save to Folder (`database.json` and a JSON file per object). */
export type SemanticModelKind = 'tmsl' | 'tmdl' | 'folder';

/** A column. `kind` is TMSL's `type` (`data` when absent); TMDL's `column X = <DAX>` is `calculated`. */
export interface SemanticModelColumn {
  name: string;
  /** As the model writes it (`int64`, `string`, `dateTime`…); `''` when absent. */
  dataType: string;
  isKey: boolean;
  isHidden: boolean;
  description?: string;
  kind: 'data' | 'calculated' | 'calculatedTableColumn' | 'rowNumber';
  sourceColumn?: string;
  /** The `UnderlyingDateTimeDataType` annotation (`Date`, `Time`, `DateTime`), as written. */
  dateTimeAnnotation?: string;
  /** The `formatString`, as written. */
  formatString?: string;
  /** `isNullable: false` (a required column); undefined when not stated. */
  isNullable?: boolean;
  /** TMSL's `isUnique`. */
  isUnique?: boolean;
  /** 1-based line of the column in its file. */
  line?: number;
  /** The file it is defined in, when not its table's (Save to Folder keeps each column in its own file). */
  file?: string;
}

/** A measure: only its name, description and whether it has a KPI are read (never its DAX). */
export interface SemanticModelMeasure {
  name: string;
  description?: string;
  /** It carries a KPI (target and status). */
  kpi?: boolean;
  line?: number;
  file?: string;
}

/**
 * Where a table's rows come from, as far as an ERD can say: the warehouse
 * table a partition's M navigates to (or a Direct Lake entity), else what
 * kind of source it is.
 */
export interface SemanticModelSource {
  kind: 'navigation' | 'entity' | 'nativeQuery' | 'file' | 'calculated' | 'other';
  /** `schema.item` (or `item`) for `navigation` and `entity`. */
  table?: string;
  line?: number;
  /** The partition's file, when not its table's (Save to Folder). */
  file?: string;
  /**
   * The query merges or appends rows from several sources (`Table.NestedJoin`,
   * `Table.Join`, `Table.Combine`…): each one, as the warehouse table it
   * navigates to (`dbo.Orders`), the query or table it reads (`Item`), or what
   * kind of source it is (`a file`); in the order the query names them.
   */
  combined?: { kind: 'merge' | 'append' | 'merge and append'; inputs: string[] };
}

/**
 * A model feature an ERD has no place for, read only to be named in the
 * loss ledger: what it is, its own name, and the table (and column) it
 * belongs to.
 */
export type SemanticModelFeatureKind =
  | 'hierarchy' | 'role' | 'rowFilter' | 'tablePermission' | 'columnPermission' | 'perspective'
  | 'translation' | 'linguisticMetadata' | 'dataSource' | 'expression' | 'parameter'
  | 'dateTable' | 'variation' | 'kpi' | 'function' | 'calendar' | 'setting';

export interface SemanticModelFeature {
  kind: SemanticModelFeatureKind;
  /** Its own name (a hierarchy's, a role's…); for `setting`, the property (`formatString`). */
  name: string;
  /** The table it belongs to (a role, perspective or culture: undefined). */
  table?: string;
  column?: string;
  /** A variation's target table (an auto date/time table's variation goes with that table). */
  target?: string;
  /** How many it stands for (a culture's translated captions, a hierarchy's levels). */
  count?: number;
  file?: string;
  line?: number;
}

export interface SemanticModelTable {
  name: string;
  description?: string;
  isHidden: boolean;
  /** `isPrivate` (auto date/time tables are). */
  isPrivate: boolean;
  /** `showAsVariationsOnly` (auto date/time tables are). */
  showAsVariationsOnly: boolean;
  /** `calculated`: a partition's source is DAX (`= calculated`); `calculationGroup`: it has one. */
  kind: 'table' | 'calculated' | 'calculationGroup';
  columns: SemanticModelColumn[];
  measures: SemanticModelMeasure[];
  /** The file it is defined in, and its 1-based line (TMDL). */
  file?: string;
  line?: number;
  /** Where its rows come from (its first partition). */
  source?: SemanticModelSource;
  /** A calculation group's items. */
  calculationItems?: number;
}

export type SemanticModelCardinality = 'one' | 'many';

export interface SemanticModelRelationship {
  /** Power BI names them with a GUID; undefined when absent. */
  name?: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** Default `many`. */
  fromCardinality: SemanticModelCardinality;
  /** Default `one`. */
  toCardinality: SemanticModelCardinality;
  /** Default true. */
  isActive: boolean;
  /** `oneDirection` (the default, so undefined), `bothDirections`, `automatic`. */
  crossFilteringBehavior?: string;
  /** `relyOnReferentialIntegrity` (Assume referential integrity): true when set. */
  relyOnReferentialIntegrity?: boolean;
  /** `oneDirection` (the default, so undefined), `bothDirections`, `none`. */
  securityFilteringBehavior?: string;
  /** Where it is defined. */
  file?: string;
  line?: number;
}

export interface SemanticModel {
  /** Fabric's `.platform` displayName, else the `<Name>` of `<Name>.SemanticModel` / `.Dataset`, else a database or model name that is not a tool default, else its folder. */
  name: string;
  kind: SemanticModelKind;
  tables: SemanticModelTable[];
  relationships: SemanticModelRelationship[];
  /** What the model holds that an ERD has no place for (named in the ledger, never imported). */
  features?: SemanticModelFeature[];
  /**
   * What reading the files recorded (`importLedger.ts`): a file, table,
   * column or relationship that did not read (`problem`, with its file and
   * line), a file outside the layout (`skipped`). {@link semanticModelToDbml}
   * puts it first in its own ledger.
   */
  ledger?: LedgerEntry[];
}

export interface SemanticModelFile {
  path: string;
  text: string;
}

export interface SemanticModelProblem {
  /** The file's path as given. */
  file: string;
  /** 1-based, when known. */
  line?: number;
  message: string;
}

export type ReadSemanticModelResult =
  /** `problems`: what did not read and was left out (one bad file never fails the model; each is in `model.ledger` too). */
  | { ok: true; model: SemanticModel; warnings: string[]; problems?: SemanticModelProblem[] }
  | { ok: false; problems: SemanticModelProblem[] };

// ---------------------------------------------------------------------------
// Finding models under a folder
// ---------------------------------------------------------------------------

/** A semantic model found under a picked folder. */
export interface SemanticModelEntry {
  /** What to call it: `Sales` for `Sales.SemanticModel`. */
  name: string;
  kind: SemanticModelKind;
  /** The model's folder, sliced from the paths given (so in their separators): every file of the model is under it. */
  root: string;
  /** The given paths that belong to the model (what to read and pass to {@link readSemanticModel}), in input order. */
  files: string[];
}

/** Folders a model is never found inside. */
const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.pbi']);

/** `X.SemanticModel` / `X.Dataset` → `X`; otherwise undefined. */
function modelFolderName(segment: string): string | undefined {
  const m = /^(.+)\.(SemanticModel|Dataset)$/i.exec(segment);
  return m ? m[1] : undefined;
}

/**
 * Which folders and files among `paths` (every file under a picked folder,
 * absolute or relative, `/` or `\`) are semantic models, for a picker:
 *
 * - a `X.SemanticModel/` (or `X.Dataset/`) folder with `definition/**.tmdl`
 *   is TMDL, else with a `model.bim` (directly inside) TMSL; root is that
 *   folder, name `X`;
 * - outside those, a folder holding `model.tmdl` or `database.tmdl` (a TMDL
 *   folder saved by Tabular Editor, or a bare `definition/`) is TMDL, root
 *   that folder (its parent when it is named `definition`), with every
 *   `.tmdl` under it;
 * - outside those, a folder holding `database.json` with
 *   `tables/<Table>/<file>.json` beside it is Tabular Editor's Save to
 *   Folder (`folder`), root that folder, with every `.json` under it;
 * - outside all three, each `*.bim` is TMSL on its own, root its folder, named
 *   after the file (after the folder for `model.bim`).
 *
 * Paths under `node_modules`, `.git` or `.pbi` are ignored. Sorted by root,
 * then name.
 */
export function findSemanticModels(paths: readonly string[]): SemanticModelEntry[] {
  interface Found {
    entry: SemanticModelEntry;
    normRoot: string;
  }
  const norm = paths.map((p) => p.replace(/\\/g, '/'));
  const usable = norm.map((p) => !p.split('/').some((s) => IGNORED_SEGMENTS.has(s)));
  const rootOf = (i: number, normRoot: string): string => paths[i].slice(0, normRoot.length);
  const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));
  const isUnder = (p: string, root: string): boolean => p.toLowerCase().startsWith(`${root.toLowerCase()}/`);
  const found: Found[] = [];

  // 1. <X>.SemanticModel / <X>.Dataset folders (the nearest one to the file).
  const pbip = new Map<string, { name: string; normRoot: string; index: number; tmdl: number[]; bim: number[] }>();
  norm.forEach((p, i) => {
    if (!usable[i]) return;
    const segments = p.split('/');
    for (let s = segments.length - 2; s >= 0; s--) {
      const name = modelFolderName(segments[s]);
      if (!name) continue;
      const normRoot = segments.slice(0, s + 1).join('/');
      const key = normRoot.toLowerCase();
      if (!pbip.has(key)) pbip.set(key, { name, normRoot, index: i, tmdl: [], bim: [] });
      const rest = segments.slice(s + 1);
      if (rest.length > 1 && rest[0].toLowerCase() === 'definition' && /\.tmdl$/i.test(p)) pbip.get(key)!.tmdl.push(i);
      if (rest.length === 1 && /\.bim$/i.test(p)) pbip.get(key)!.bim.push(i);
      break;
    }
  });
  for (const f of pbip.values()) {
    const kind: SemanticModelKind | undefined = f.tmdl.length > 0 ? 'tmdl' : f.bim.length > 0 ? 'tmsl' : undefined;
    if (!kind) continue;
    found.push({
      entry: { name: f.name, kind, root: rootOf(f.index, f.normRoot), files: (kind === 'tmdl' ? f.tmdl : f.bim).map((i) => paths[i]) },
      normRoot: f.normRoot,
    });
  }
  const underPbip = (p: string): boolean => [...pbip.values()].some((f) => isUnder(p, f.normRoot));

  // 2. Bare TMDL folders.
  const tmdlRoots: Array<{ normRoot: string; index: number }> = [];
  norm.forEach((p, i) => {
    if (!usable[i] || underPbip(p)) return;
    const file = p.split('/').pop()!.toLowerCase();
    if (file !== 'model.tmdl' && file !== 'database.tmdl') return;
    let dir = dirOf(p);
    if (dir.split('/').pop()?.toLowerCase() === 'definition' && dir.includes('/')) dir = dirOf(dir);
    if (!tmdlRoots.some((r) => r.normRoot.toLowerCase() === dir.toLowerCase())) tmdlRoots.push({ normRoot: dir, index: i });
  });
  for (const r of tmdlRoots) {
    const files: string[] = [];
    norm.forEach((p, i) => {
      if (!usable[i] || !/\.tmdl$/i.test(p) || !(r.normRoot === '' || isUnder(p, r.normRoot))) return;
      // A nested TMDL root owns its own files.
      const deeper = tmdlRoots.some((o) => o.normRoot.length > r.normRoot.length && isUnder(p, o.normRoot));
      if (!deeper) files.push(paths[i]);
    });
    const name = r.normRoot.split('/').pop() || 'model';
    found.push({ entry: { name, kind: 'tmdl', root: rootOf(r.index, r.normRoot), files }, normRoot: r.normRoot });
  }

  // 3. Tabular Editor Save to Folder models: database.json with tables/<Table>/*.json beside it.
  const folderRoots: string[] = [];
  norm.forEach((p, i) => {
    if (!usable[i] || underPbip(p) || p.split('/').pop()!.toLowerCase() !== 'database.json') return;
    if (tmdlRoots.some((r) => r.normRoot === '' || isUnder(p, r.normRoot))) return;
    const dir = dirOf(p);
    const inside = (q: string): boolean => dir === '' || isUnder(q, dir);
    // This database.json's own tables/ folder: one deeper down (another model's) does not make it a model.
    const tables = `${dir ? `${dir}/` : ''}tables/`.toLowerCase();
    if (!isSaveToFolderLayout([p, ...norm.filter((q, j) => usable[j] && q.toLowerCase().startsWith(tables))])) return;
    if (folderRoots.some((r) => r.toLowerCase() === dir.toLowerCase())) return;
    folderRoots.push(dir);
    const files: string[] = [];
    norm.forEach((q, j) => {
      if (!usable[j] || !/\.json$/i.test(q) || !inside(q)) return;
      files.push(paths[j]);
    });
    const name = dir.split('/').pop() || 'model';
    found.push({ entry: { name, kind: 'folder', root: rootOf(i, dir), files }, normRoot: dir });
  });
  // A Save to Folder model nested in another owns its own files.
  for (const f of found) {
    if (f.entry.kind !== 'folder') continue;
    f.entry.files = f.entry.files.filter((file) => {
      const n = file.replace(/\\/g, '/');
      return !folderRoots.some((r) => r.length > f.normRoot.length && isUnder(n, r));
    });
  }

  // 4. Bare .bim files.
  norm.forEach((p, i) => {
    if (!usable[i] || !/\.bim$/i.test(p) || underPbip(p)) return;
    if (tmdlRoots.some((r) => r.normRoot === '' || isUnder(p, r.normRoot))) return;
    if (folderRoots.some((r) => r === '' || isUnder(p, r))) return;
    const dir = dirOf(p);
    const base = p.split('/').pop()!.replace(/\.bim$/i, '');
    const name = base.toLowerCase() === 'model' ? dir.split('/').pop() || 'model' : base;
    found.push({ entry: { name, kind: 'tmsl', root: rootOf(i, dir), files: [paths[i]] }, normRoot: dir });
  });

  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return found
    .sort((a, b) => cmp(a.normRoot.toLowerCase(), b.normRoot.toLowerCase()) || cmp(a.entry.name, b.entry.name))
    .map((f) => f.entry);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read a semantic model from its files (what {@link findSemanticModels}
 * listed, or any set of `.bim` / `.tmdl` files): TMDL when any file is
 * `.tmdl`, else the one `.bim`. Other files are ignored. Problems (the model
 * cannot be read) come back instead of a model; anything read around (an
 * unreadable relationship, a duplicate table) is a warning. Never throws.
 */
export function readSemanticModel(files: readonly SemanticModelFile[]): ReadSemanticModelResult {
  const tmdl = files.filter((f) => /\.tmdl$/i.test(f.path));
  const bim = files.filter((f) => /\.bim$/i.test(f.path));
  const json = files.filter((f) => /\.json$/i.test(f.path));
  const folder = tmdl.length === 0 && isSaveToFolderLayout(json.map((f) => f.path));
  // Fabric Git integration's `.platform` names the item (its displayName): the best name there is.
  const platformName = files.map((f) => (baseName(f.path).toLowerCase() === '.platform' ? platformDisplayName(f.text) : undefined)).find((n) => !!n);
  // TMDL and Save to Folder read file by file: a file that is not UTF-8 text is left out there, with the rest read.
  if (tmdl.length > 0) {
    const result = readTmdl(tmdl, platformName);
    if (result.ok && bim.length > 0) {
      result.warnings.unshift(`Read the TMDL definition; ${bim.map((f) => baseName(f.path)).join(', ')} was ignored.`);
    }
    return result;
  }
  if (folder) {
    const result = readSaveToFolder(json, platformName);
    if (result.ok && bim.length > 0) {
      result.warnings.unshift(`Read the Tabular Editor folder (database.json); ${bim.map((f) => baseName(f.path)).join(', ')} was ignored.`);
    }
    return result;
  }
  // Text that is not UTF-8 (a UTF-16 file read as UTF-8 is full of NULs) would read as JSON gibberish.
  const encoding = bim.filter((f) => notTextReason(f.text)).map((f) => ({ file: f.path, message: notTextReason(f.text)! }));
  if (encoding.length > 0) return { ok: false, problems: encoding };
  if (bim.length === 1) return readTmsl(bim[0], platformName);
  if (bim.length > 1) {
    return {
      ok: false,
      problems: [{ file: bim[0].path, message: `${bim.length} .bim files were given (${bim.map((f) => baseName(f.path)).join(', ')}); pick one semantic model.` }],
    };
  }
  return {
    ok: false,
    problems: [{ file: files[0]?.path ?? '', message: 'No semantic model files: expected a model.bim (TMSL), a definition folder of .tmdl files (TMDL) or a Tabular Editor Save to Folder model (database.json).' }],
  };
}

/**
 * Why a model file's text is not text this reader can take: NUL characters
 * (a UTF-16 file decoded as UTF-8, or a binary file); undefined when it is fine.
 */
function notTextReason(text: string): string | undefined {
  if (!text.slice(0, 65536).includes('\u0000')) return undefined;
  return 'This file is not UTF-8 text: it holds NUL characters, as a UTF-16 file read as UTF-8 does. Save it as UTF-8 (Power BI Desktop and Tabular Editor do by default) and import again.';
}

/**
 * A model file's bytes as text: UTF-8 (a BOM dropped), or UTF-16 when it
 * starts with a UTF-16 BOM or, without one, when every other byte of its
 * start is zero (Visual Studio and older SSDT tools save `model.bim` so).
 * Pure: `TextDecoder` is a global in Node and in browsers.
 */
export function decodeSemanticModelFile(bytes: Uint8Array): string {
  const swap = (b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(b.length - (b.length % 2));
    for (let i = 0; i + 1 < b.length; i += 2) {
      out[i] = b[i + 1];
      out[i + 1] = b[i];
    }
    return out;
  };
  const utf16le = (b: Uint8Array): string => new TextDecoder('utf-16le').decode(b);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return utf16le(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16le(swap(bytes.subarray(2)));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  // No BOM: ASCII-heavy UTF-16 has a zero in every other byte.
  const head = bytes.subarray(0, Math.min(bytes.length, 512));
  if (head.length >= 4) {
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i < head.length; i++) if (head[i] === 0) (i % 2 === 0 ? evenZero++ : oddZero++);
    const half = Math.floor(head.length / 2);
    if (oddZero >= half * 0.9 && evenZero === 0) return utf16le(bytes);
    if (evenZero >= half * 0.9 && oddZero === 0) return utf16le(swap(bytes));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function baseName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

/** The `<Name>` of a `<Name>.SemanticModel` / `.Dataset` folder in `path`, nearest first. */
function modelNameFromPath(path: string): string | undefined {
  const segments = path.replace(/\\/g, '/').split('/');
  for (let s = segments.length - 2; s >= 0; s--) {
    const name = modelFolderName(segments[s]);
    if (name) return name;
  }
  return undefined;
}

/** A Fabric `.platform` file's `metadata.displayName`; undefined when it is not one or does not parse. */
export function platformDisplayName(text: string): string | undefined {
  try {
    const json = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    const metadata = isObject(json) ? json.metadata : undefined;
    const name = isObject(metadata) ? str(metadata.displayName) : undefined;
    return name?.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A database or model name a tool writes by default, so no name at all:
 * `SemanticModel` (Visual Studio's TMSL default), `Model` (TMDL's `model
 * Model`), `Dataset`, `Database`, or a GUID (Fabric and the service).
 */
export function isDefaultModelName(name: string | undefined): boolean {
  const n = name?.trim() ?? '';
  return n === ''
    || /^(semantic[ _-]?model|model|data[ _-]?set|database|tabular[ _-]?project\d*(_\S*)?)$/i.test(n)
    || /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(n);
}

/** The folder a model's files sit in: a `.bim`'s folder (its own name for `X.bim`), a TMDL `definition/`'s parent. */
function modelFolderOf(path: string): string | undefined {
  const segments = path.replace(/\\/g, '/').split('/').filter((x) => x !== '' && x !== '.');
  const file = segments.pop() ?? '';
  if (/\.bim$/i.test(file) && file.toLowerCase() !== 'model.bim') return file.replace(/\.bim$/i, '');
  const definition = segments.findIndex((x) => x.toLowerCase() === 'definition');
  const dir = definition > 0 ? segments[definition - 1] : definition === 0 ? undefined : segments[segments.length - 1];
  return dir && !/^\.+$/.test(dir) ? dir : undefined;
}

/**
 * The model's name, best first: Fabric's `.platform` displayName (the
 * item's own name; its folder is only named after it when first synced),
 * its `<Name>.SemanticModel` / `.Dataset` folder, a database or model name
 * that is not a tool default, then the folder its files are in.
 */
function chooseModelName(path: string, platformName: string | undefined, named: ReadonlyArray<string | undefined>): string {
  return cleanModelName(platformName)
    ?? cleanModelName(modelNameFromPath(path))
    ?? cleanModelName(named.map(cleanModelName).find((n) => !isDefaultModelName(n)))
    ?? cleanModelName(modelFolderOf(path))
    ?? 'semantic-model';
}

/**
 * A model name on one line: line breaks, tabs and other control characters
 * become a single space (the name goes into a DBML Project name, a comment
 * and the draft's banner, none of which may break a line); undefined when
 * nothing is left.
 */
export function cleanModelName(name: string | undefined): string | undefined {
  const n = name?.replace(/[\s\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').trim();
  return n ? n : undefined;
}

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** TMSL writes long text as a string or an array of lines. */
const textOf = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join('\n');
  return undefined;
};
const cardinality = (v: unknown, fallback: SemanticModelCardinality): SemanticModelCardinality => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'one' || s === 'many' ? s : fallback;
};
const COLUMN_KINDS = new Set<SemanticModelColumn['kind']>(['data', 'calculated', 'calculatedTableColumn', 'rowNumber']);

/** The 1-based line of a `JSON.parse` error, from either message V8 writes. */
function jsonErrorLine(text: string, message: string): number | undefined {
  const lineCol = /line (\d+) column \d+/.exec(message);
  if (lineCol) return Number(lineCol[1]);
  const pos = /position (\d+)/.exec(message);
  if (pos) return text.slice(0, Number(pos[1])).split('\n').length;
  return undefined;
}

// ---------------------------------------------------------------------------
// Date/time columns, M sources, report settings (shared by both readers)
// ---------------------------------------------------------------------------

/**
 * What a `formatString` says a `dateTime` column holds: `date` (`Long Date`,
 * `Short Date`, `yyyy-mm-dd`, `mmm yyyy`), `time` (`Long Time`, `h:mm`,
 * `hh:mm:ss tt`), `dateTime` (`General Date`, `dd/mm/yyyy hh:nn`), or
 * undefined when it is not a date/time format at all. Quoted text, `\x`
 * escapes and `[$-locale]` codes are ignored; a lone `m` is a month unless
 * an hour or a second is beside it.
 */
export function dateTimeFormatKind(formatString: string | undefined): 'date' | 'time' | 'dateTime' | undefined {
  const named = (formatString ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!named) return undefined;
  if (/^(long|short|medium) date$/.test(named)) return 'date';
  if (/^(long|short|medium) time$/.test(named)) return 'time';
  if (named === 'general date') return 'dateTime';
  const s = named.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  // Only format letters and separators: anything else (`0.00`, `General Number`) is not a date/time format.
  if (!/^[dmyhnsqwtap/:.,\-_ '()]+$/.test(s) || !/[dmyhns]/.test(s)) return undefined;
  const time = /[hns]/.test(s) || /am\/pm|a\/p|tt/.test(s);
  const date = /[dyqw]/.test(s) || (/m/.test(s.replace(/am\/pm|a\/p/g, '')) && !/[hns]/.test(s));
  if (date && time) return 'dateTime';
  if (date) return 'date';
  return time ? 'time' : undefined;
}

/**
 * What a `dateTime` column holds: its `UnderlyingDateTimeDataType`
 * annotation first (`Date`, `Time`, `DateTime`; Power BI writes it when the
 * source column is date-only or time-only), else its `formatString`
 * ({@link dateTimeFormatKind}); undefined for any other data type, or with
 * no signal (then `timestamp`, as before).
 */
export function semanticDateTimeKind(column: Pick<SemanticModelColumn, 'dataType' | 'dateTimeAnnotation' | 'formatString'>): 'date' | 'time' | 'dateTime' | undefined {
  if (column.dataType.trim().toLowerCase() !== 'datetime') return undefined;
  const annotation = column.dateTimeAnnotation?.trim().toLowerCase();
  if (annotation === 'date') return 'date';
  if (annotation === 'time') return 'time';
  if (annotation === 'datetime') return 'dateTime';
  return dateTimeFormatKind(column.formatString);
}

/** Column properties that only shape reports: named in the ledger as not kept. */
export const REPORT_COLUMN_SETTINGS = ['formatString', 'dataCategory', 'sortByColumn', 'summarizeBy', 'isDefaultLabel', 'isDefaultImage', 'displayFolder'] as const;

/** A partition as read, before its M is resolved against the model's shared expressions. */
interface RawPartition {
  /** `m`, `entity`, `calculated`, `query`, `policyRange`… (lower case). */
  type: string;
  text?: string;
  entity?: { schema?: string; name?: string };
  line?: number;
  /** Its file, when not its table's (Save to Folder). */
  file?: string;
}

/** The `key="value"` fields of one M record selector's body (keys lower case, `""` unescaped). */
function mFields(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"]|"")*)"/g)) out.set(m[1].toLowerCase(), m[2].replace(/""/g, '"'));
  return out;
}

/**
 * The warehouse table an M query navigates to, from its record selectors
 * in order: `Source{[Schema="dbo",Item="DimDate"]}` (SQL Server, Fabric
 * warehouses), `{[Name="PUBLIC",Kind="Schema"]}` then `{[Name="T",Kind="Table"]}`
 * (Snowflake, Databricks), `{[Id="t",ItemKind="Table"]}` (Fabric lakehouses).
 * `schema.item`, or `item` with no schema; undefined when it names none.
 */
export function mNavigationTable(m: string): string | undefined {
  let schema: string | undefined;
  let item: string | undefined;
  // A record selector's body; a `]` inside a quoted value (`Item="Sales[2024]"`) does not end it.
  for (const sel of stripMComments(m).matchAll(/\{\s*\[((?:[^\]"]|"(?:[^"]|"")*")*)\]\s*\}/g)) {
    const f = mFields(sel[1]);
    if (f.has('item')) {
      item = f.get('item');
      if (f.has('schema')) schema = f.get('schema');
      continue;
    }
    const name = f.get('name') ?? f.get('id');
    const kind = (f.get('kind') ?? f.get('itemkind') ?? '').toLowerCase();
    if (name === undefined) continue;
    if (kind === 'schema') schema = name;
    else if (kind === 'table' || kind === 'view') item = name;
  }
  if (!item?.trim()) return undefined;
  return schema?.trim() ? `${schema}.${item}` : item;
}

const NATIVE_QUERY = /\bValue\.NativeQuery\s*\(|\b(Sql\.Databases?|Snowflake\.Databases|Databricks\.(Catalogs|Query)|Oracle\.Database|PostgreSQL\.Database|MySQL\.Database|AmazonRedshift\.Database|GoogleBigQuery\.Database)\s*\([^)]*\[\s*Query\s*=|\bOdbc\.Query\s*\(|\bOleDb\.Query\s*\(/;
/** Connectors whose navigation reaches a warehouse table (a query that reads a file too still navigates one). */
const DATABASE_SOURCE = /\b(Sql\.Databases?|Snowflake\.Databases|Databricks(MultiCloud)?\.Catalogs|Lakehouse\.Contents|Fabric\.Warehouse|PostgreSQL\.Database|Oracle\.Database|MySQL\.Database|AmazonRedshift\.Database|GoogleBigQuery\.Database|Teradata\.Database|Db2\.Database|Sybase\.Database|Informix\.Database|SapHana\.Database|AnalysisServices\.Database|AzureDataExplorer\.Contents|Odbc\.DataSource|OleDb\.DataSource|AmazonAthena\.Databases|Exasol\.Database|Vertica\.Database|Impala\.Database|Presto\.Database|Trino\.Database|ClickHouse\.Database|DuckDB\.Database)\s*\(/;
const FILE_SOURCE = /\b(Csv\.Document|Excel\.(Workbook|CurrentWorkbook)|File\.Contents|Json\.Document|Folder\.(Files|Contents)|SharePoint\.(Files|Contents|Tables)|Web\.(Contents|Page)|Xml\.(Tables|Document)|Parquet\.Document|AzureStorage\.\w+|Lines\.FromBinary)\s*\(/;

/**
 * Where an M query's rows come from: a native query (its SQL is not
 * parsed), a navigation to a warehouse table, a file or web source, a shared
 * expression it reads (followed, up to four deep), or something else.
 */
export function describeMSource(text: string, expressions: ReadonlyMap<string, string> = new Map(), depth = 0): SemanticModelSource {
  // A commented-out step (`// Source = OldServer…`) is not where the rows come from.
  const m = stripMComments(text);
  if (NATIVE_QUERY.test(m)) return { kind: 'nativeQuery' };
  // A workbook's sheet or table is navigated to like a warehouse table (`{[Item="Sales",Kind="Sheet"]}`): a file all the same.
  if (FILE_SOURCE.test(m) && !DATABASE_SOURCE.test(m)) return { kind: 'file' };
  const table = mNavigationTable(m);
  if (table) return { kind: 'navigation', table };
  if (FILE_SOURCE.test(m)) return { kind: 'file' };
  if (depth < 4) {
    // A query that starts from a shared expression (`Source = Staging,` or the whole query `Staging`)
    // reads what that expression reads; one that only uses it inside a step (`List.Min(Staging[Date])`) does not.
    for (const [name, text] of expressions) {
      const bare = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name.replace(/[.]/g, '\\.') : undefined;
      const quoted = `#"${name.replace(/"/g, '""')}"`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const ref = bare ? `(?:${quoted}|${bare})` : quoted;
      const startsFrom = new RegExp(`(?:^|=)\\s*${ref}\\s*(?:,|$|\\bin\\b)`, 'i');
      if (!startsFrom.test(m.trim())) continue;
      const inner = describeMSource(text, expressions, depth + 1);
      if (inner.kind !== 'other') return inner;
    }
  }
  return { kind: 'other' };
}

/**
 * M with its `//` and `/* … *\/` comments removed, string literals and
 * `#"quoted names"` left whole (a URL's `//` is not a comment).
 */
export function stripMComments(m: string): string {
  let out = '';
  let i = 0;
  while (i < m.length) {
    const ch = m[i];
    if (ch === '"') {
      // A string or the body of #"…": "" is a quote inside.
      let j = i + 1;
      while (j < m.length) {
        if (m[j] === '"') {
          if (m[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += m.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && m[i + 1] === '/') {
      while (i < m.length && m[i] !== '\n' && m[i] !== '\r') i++;
    } else if (ch === '/' && m[i + 1] === '*') {
      const end = m.indexOf('*/', i + 2);
      out += ' ';
      i = end < 0 ? m.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** A partition's source, resolved against the model's shared expressions. */
function resolveSource(raw: RawPartition | undefined, expressions: ReadonlyMap<string, string>): SemanticModelSource | undefined {
  if (!raw) return undefined;
  const at = { ...(raw.line !== undefined ? { line: raw.line } : {}), ...(raw.file ? { file: raw.file } : {}) };
  if (raw.type === 'calculated') return { kind: 'calculated', ...at };
  if (raw.type === 'entity') {
    const name = raw.entity?.name?.trim();
    if (!name) return { kind: 'other', ...at };
    const schema = raw.entity?.schema?.trim();
    return { kind: 'entity', table: schema ? `${schema}.${name}` : name, ...at };
  }
  if (raw.type === 'query') return { kind: 'nativeQuery', ...at };
  if (raw.type === 'm' && raw.text) return { ...describeMSource(raw.text, expressions), ...at };
  return { kind: 'other', ...at };
}

/**
 * What a query merges or appends (`Table.NestedJoin`, `Table.Join`,
 * `Table.FuzzyNestedJoin`, `Table.FuzzyJoin`, `Table.AddJoinColumn`,
 * `Table.Combine`), every source each call reads, in order: a step is
 * followed to where its rows come from (the warehouse table its navigation
 * reaches, `dbo.Orders`), another table of the model or a shared query by its
 * name (a shared query that navigates, by its warehouse table), else `a
 * file`, `a native query`, `tables listed at run time` (a `Table.Combine`
 * over a list it builds) or `its own rows` (the query's earlier steps, when
 * they name no source). Undefined when it does neither.
 */
export function mCombinedSources(
  m: string,
  queries: ReadonlyMap<string, string> = new Map(),
  tableNames: ReadonlySet<string> = new Set(),
): { kind: 'merge' | 'append' | 'merge and append'; inputs: string[] } | undefined {
  return combinedSourcesIn(m, mSourcesContext(queries, tableNames), 0);
}

/**
 * What resolving one query's merge sources shares across the shared queries
 * it reaches: each shared query is resolved once (`memo`), one that reads
 * itself through others stops at its name (`visiting`), and the queries and
 * tables an expression can start from are listed once, not per expression.
 */
interface MSourcesContext {
  queries: ReadonlyMap<string, string>;
  lowerTables: ReadonlySet<string>;
  /** Shared queries that hold rows (not a parameter or a function), then tables with no query of their own, in that order. */
  candidates: readonly string[];
  /** Names (lower case) never followed: the table whose query this is. */
  exclude: ReadonlySet<string>;
  memo: Map<string, string[]>;
  visiting: Set<string>;
}

/** Shared queries deeper than this are named, not followed. */
const MAX_M_QUERY_NESTING = 16;

function mSourcesContext(queries: ReadonlyMap<string, string>, tableNames: ReadonlySet<string>, exclude: ReadonlySet<string> = new Set()): MSourcesContext {
  const candidates = [
    ...[...queries].filter(([, text]) => !isMParameter(text) && !isMFunction(text)).map(([q]) => q),
    ...[...tableNames].filter((t) => !queries.has(t)),
  ].filter((q) => !exclude.has(q.toLowerCase()));
  return { queries, lowerTables: new Set([...tableNames].map((t) => t.toLowerCase())), candidates, exclude, memo: new Map(), visiting: new Set() };
}

function combinedSourcesIn(m: string, ctx: MSourcesContext, nesting: number): { kind: 'merge' | 'append' | 'merge and append'; inputs: string[] } | undefined {
  const { steps } = parseMLet(m);
  const byName = new Map(steps.map((s) => [s.name, s.expr]));
  const calls = steps.flatMap((s) => mCombineCalls(s.expr));
  if (calls.length === 0) return undefined;
  const memo = new Map<string, string[]>();
  /** A shared query or table: a table by its name, a query by the warehouse table it navigates to, else its name. */
  const query = (name: string, depth: number): string[] => {
    const lower = name.toLowerCase();
    if (ctx.lowerTables.has(lower) || ctx.exclude.has(lower) || depth > 4) return [name];
    const text = ctx.queries.get(name);
    if (text === undefined) return [name];
    // Followed only above step depth 4, so remembered per side of it.
    const key = `${name}\u0000${depth < 4}`;
    const known = ctx.memo.get(key);
    if (known) return known;
    // A query that reads itself through others (Power BI refuses the cycle; a file can still hold one): named, not followed again.
    if (ctx.visiting.has(name) || nesting >= MAX_M_QUERY_NESTING) return [name];
    ctx.visiting.add(name);
    let out: string[];
    try {
      const nested = combinedSourcesIn(text, ctx, nesting + 1);
      if (nested && depth < 4) out = nested.inputs;
      else {
        const source = describeMSource(text, ctx.queries);
        out = [source.kind === 'navigation' && source.table ? source.table : name];
      }
    } finally {
      ctx.visiting.delete(name);
    }
    ctx.memo.set(key, out);
    return out;
  };
  /** The steps an expression reads, each with the steps it reads, in step order: the text a navigation is spread over. */
  const chain = (expr: string, seen = new Set<string>()): string => {
    const parts: string[] = [];
    for (const ref of mReferences(expr, byName.keys())) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      parts.push(chain(byName.get(ref) ?? '', seen), byName.get(ref) ?? '');
    }
    return [...parts, expr].join('\n');
  };
  const resolve = (expr: string, depth: number): string[] => {
    const name = mName(expr);
    if (name !== undefined && byName.has(name) && depth < 32) {
      if (memo.has(name)) return memo.get(name)!;
      memo.set(name, ['its own rows']);
      const inner = mCombineCalls(byName.get(name)!);
      const out = inner.length > 0 ? inputsOf(inner, depth + 1) : resolve(byName.get(name)!, depth + 1);
      memo.set(name, out);
      return out;
    }
    if (name !== undefined && !byName.has(name)) return query(name, depth);
    const text = stripMComments(chain(expr));
    if (NATIVE_QUERY.test(text)) return ['a native query'];
    const table = mNavigationTable(text);
    if (table) return [table];
    if (FILE_SOURCE.test(text)) return ['a file'];
    // An expression that starts from a shared query or another table (`Table.SelectColumns(Item, …)`); a parameter or a function is not a source.
    const named = mReferences(expr, ctx.candidates.filter((q) => !byName.has(q)));
    if (named.length > 0) return query(named[0], depth);
    return ['its own rows'];
  };
  const inputsOf = (list: readonly MCombineCall[], depth: number): string[] => {
    const out: string[] = [];
    for (const call of list) {
      if (call.dynamic) out.push('tables listed at run time');
      for (const t of call.tables) for (const input of resolve(t, depth)) out.push(input);
    }
    return [...new Set(out)];
  };
  // A call nested in another step's call is reached through it: only the outermost calls count.
  const inner = new Set(steps.flatMap((s) => mCombineCalls(s.expr).flatMap((c) => c.tables.map(mName).filter((n): n is string => !!n))));
  const outer = steps.filter((s) => !inner.has(s.name) || mCombineCalls(s.expr).length === 0).flatMap((s) => mCombineCalls(s.expr));
  const inputs = inputsOf(outer.length > 0 ? outer : calls, 0);
  const kinds = new Set(calls.map((c) => c.kind));
  return { kind: kinds.size > 1 ? 'merge and append' : kinds.has('merge') ? 'merge' : 'append', inputs };
}

/** Each table's source, resolved against the model's shared expressions, with what its query merges or appends. */
function resolveSources(partitions: ReadonlyMap<SemanticModelTable, RawPartition | undefined>, expressions: ReadonlyMap<string, string>): void {
  // A query may read another table's query by its name, as it reads a shared expression.
  const queries = new Map(expressions);
  const tableNames = new Set<string>();
  for (const [table, raw] of partitions) {
    tableNames.add(table.name);
    if (raw?.type === 'm' && raw.text && !queries.has(table.name)) queries.set(table.name, raw.text);
  }
  // Listed once for the model: which queries hold rows (a regex over every query's text) does not change per table.
  const shared = mSourcesContext(queries, tableNames);
  for (const [table, raw] of partitions) {
    const source = resolveSource(raw, expressions);
    if (!source) continue;
    if (raw?.type === 'm' && raw.text && mCombineCalls(raw.text).length > 0) {
      // Its own query is never one of its sources.
      const self = table.name.toLowerCase();
      const ctx: MSourcesContext = { ...shared, candidates: shared.candidates.filter((q) => q.toLowerCase() !== self), exclude: new Set([self]), memo: new Map(), visiting: new Set() };
      const combined = combinedSourcesIn(raw.text, ctx, 0);
      if (combined && combined.inputs.length > 0) source.combined = combined;
    }
    table.source = source;
  }
}

/** Whether a shared M expression is a function (`(x as number) => …`, or a `let` whose first step is one). */
function isMFunction(text: string): boolean {
  return /^\s*(?:let\s+(?:#"(?:[^"]|"")*"|[A-Za-z_][\w.]*)\s*=\s*)?\([^()]*\)\s*(?:as\s+[\w.]+\s*)?=>/.test(stripMComments(text));
}

/** Whether a shared M expression is a parameter (`… meta [IsParameterQuery=true]`). */
function isMParameter(text: string): boolean {
  return /IsParameterQuery\s*=\s*true/i.test(text);
}

/** TMSL `annotations: [{ name, value }]`: the value of `name`, as a string. */
function tmslAnnotation(v: unknown, name: string): string | undefined {
  if (!Array.isArray(v)) return undefined;
  for (const a of v) {
    if (isObject(a) && str(a.name)?.toLowerCase() === name.toLowerCase()) return textOf(a.value);
  }
  return undefined;
}

/** How many translated captions, descriptions and display folders a TMSL culture holds. */
function countTmslTranslations(v: unknown): number {
  // Iterative: a hostile file nested thousands deep must not overflow the stack.
  let n = 0;
  const todo: unknown[] = [v];
  while (todo.length > 0) {
    const x = todo.pop();
    if (Array.isArray(x)) {
      // One push each: spreading a list of 100 000+ items into push() overflows the stack.
      for (const y of x) todo.push(y);
    } else if (isObject(x)) {
      for (const [k, y] of Object.entries(x)) {
        if (/^translated(Caption|Description|DisplayFolder)$/.test(k) && textOf(y)) n++;
        else todo.push(y);
      }
    }
  }
  return n;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * An incremental-refresh table's partitions are `policyRange` (often with no
 * M of their own); its `refreshPolicy`'s `sourceExpression` is the query
 * they are cut from, so that is where its rows come from.
 */
function withRefreshPolicy(partition: RawPartition | undefined, sourceExpression: string | undefined): RawPartition | undefined {
  if (!sourceExpression?.trim()) return partition;
  if (partition && partition.type === 'm' && partition.text?.trim()) return partition;
  if (partition && partition.type !== 'policyrange' && partition.type !== '' && partition.type !== 'm') return partition;
  return { type: 'm', text: sourceExpression, ...(partition?.line !== undefined ? { line: partition.line } : {}), ...(partition?.file ? { file: partition.file } : {}) };
}

function readTmsl(file: SemanticModelFile, platformName?: string): ReadSemanticModelResult {
  const text = file.text.replace(/^﻿/, '');
  if (text.trim() === '') return { ok: false, problems: [{ file: file.path, message: 'The file is empty, so it holds no semantic model.' }] };
  let parsed: ReturnType<typeof parseJsonWithLines>;
  try {
    parsed = parseJsonWithLines(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const line = jsonErrorLineOf(e) ?? jsonErrorLine(text, message);
    return { ok: false, problems: [{ file: file.path, ...(line ? { line } : {}), message: `Not valid JSON: ${message}` }] };
  }
  const { lines } = parsed;
  const place = (obj: unknown, key?: string): JsonPlace => {
    const line = (key !== undefined ? lines.keyLine(obj, key) : undefined) ?? lines.lineOf(obj);
    return { file: file.path, ...(line !== undefined ? { line } : {}) };
  };
  return readTmslDatabase(parsed.value, { file: file.path, kind: 'tmsl', place, platformName });
}

/** Tabular Editor's Save to Folder: its files put back together as one database (`semanticModelFolder.ts`), then read as TMSL. */
function readSaveToFolder(files: readonly SemanticModelFile[], platformName?: string): ReadSemanticModelResult {
  const folder = readFolderModel(files);
  const file = folder.databaseFile || files[0]?.path || '';
  const result = readTmslDatabase(folder.database, {
    file,
    kind: 'folder',
    place: (obj, key) => folder.place(obj, key) ?? { file },
    platformName,
    localTranslations: folder.localTranslations,
    readLedger: folder.ledger,
    readProblems: folder.problems,
  });
  return result;
}

interface TmslReadOptions {
  /** The file problems with the whole model are reported against. */
  file: string;
  kind: SemanticModelKind;
  /** Where an object (or one of its keys) is written. */
  place: (obj: unknown, key?: string) => JsonPlace;
  platformName?: string;
  /** Translations kept on the objects themselves (Save to Folder's LocalTranslations), per culture. */
  localTranslations?: ReadonlyMap<string, number>;
  /** What reading the files recorded already (Save to Folder: files that did not read). */
  readLedger?: readonly LedgerEntry[];
  readProblems?: readonly SemanticModelProblem[];
}

/** A TMSL database (or a script around one), read into the model: `model.bim` and Save to Folder share it. */
function readTmslDatabase(json: unknown, opts: TmslReadOptions): ReadSemanticModelResult {
  const { place } = opts;
  const fileName = baseName(opts.file);
  const readProblems = [...(opts.readProblems ?? [])];
  // The model, or a TMSL script around a database.
  let database: Loose | undefined = isObject(json) ? json : undefined;
  // A TMSL script: `{ createOrReplace: { database } }`, `{ database }`, or a
  // `sequence` of operations (Tabular Editor's deployment script), its first that holds one.
  const unwrap = (d: Loose): Loose | undefined => {
    if (isObject(d.model)) return d;
    for (const command of ['createOrReplace', 'create', 'alter']) {
      const c = d[command];
      if (isObject(c) && isObject(c.database)) return c.database;
    }
    if (isObject(d.database) && isObject(d.database.model)) return d.database;
    if (isObject(d.sequence)) {
      for (const op of arr(d.sequence.operations)) {
        const inner = isObject(op) ? unwrap(op) : undefined;
        if (inner) return inner;
      }
    }
    return undefined;
  };
  if (database) database = unwrap(database) ?? database;
  const model = database && isObject(database.model) ? database.model : undefined;
  if (!database || !model) {
    return { ok: false, problems: [{ file: opts.file, message: 'This .bim file has no "model" object, so it is not a TMSL semantic model.' }] };
  }
  const warnings: string[] = [];
  const features: SemanticModelFeature[] = [];
  const at = (obj: unknown, key?: string): Pick<SemanticModelFeature, 'file' | 'line'> => {
    const p = place(obj, key);
    return { file: p.file, ...(p.line !== undefined ? { line: p.line } : {}) };
  };
  const feature = (f: Omit<SemanticModelFeature, 'file' | 'line'>, obj: unknown, key?: string): void => { features.push({ ...f, ...at(obj, key) }); };
  const tables: SemanticModelTable[] = [];
  const partitions = new Map<SemanticModelTable, RawPartition | undefined>();
  const rawTables = arr(model.tables);
  rawTables.forEach((raw, i) => {
    if (!isObject(raw) || !str(raw.name)?.trim()) {
      const p = place(raw);
      warnings.push(`Table ${i + 1} in ${baseName(p.file) || fileName} has no name, so it was skipped${p.line !== undefined ? ` (line ${p.line})` : ''}.`);
      return;
    }
    const tableName = raw.name as string;
    const tablePlace = place(raw);
    const rawPartitions = arr(raw.partitions).filter(isObject);
    const calculated = rawPartitions.some((p) => isObject(p.source) && str(p.source.type)?.toLowerCase() === 'calculated');
    const columns: SemanticModelColumn[] = [];
    arr(raw.columns).forEach((c, ci) => {
      if (!isObject(c) || !str(c.name)?.trim()) {
        const p = place(c);
        warnings.push(`Column ${ci + 1} of table ${tableName} in ${baseName(p.file) || fileName} has no name, so it was skipped${p.line !== undefined ? ` (line ${p.line})` : ''}.`);
        return;
      }
      const type = str(c.type) as SemanticModelColumn['kind'] | undefined;
      const columnPlace = place(c);
      const column: SemanticModelColumn = {
        name: c.name as string,
        dataType: str(c.dataType) ?? '',
        isKey: c.isKey === true,
        isHidden: c.isHidden === true,
        kind: type && COLUMN_KINDS.has(type) ? type : 'data',
        ...(columnPlace.line !== undefined ? { line: columnPlace.line } : {}),
        ...(columnPlace.file !== tablePlace.file ? { file: columnPlace.file } : {}),
      };
      const description = textOf(c.description);
      if (description) column.description = description;
      if (str(c.sourceColumn)) column.sourceColumn = c.sourceColumn as string;
      const annotation = tmslAnnotation(c.annotations, 'UnderlyingDateTimeDataType');
      if (annotation) column.dateTimeAnnotation = annotation;
      const formatString = textOf(c.formatString);
      if (formatString) column.formatString = formatString;
      if (c.isNullable === false) column.isNullable = false;
      if (c.isUnique === true) column.isUnique = true;
      columns.push(column);
      for (const setting of REPORT_COLUMN_SETTINGS) {
        const v = c[setting];
        if (v === undefined || v === null || v === false || v === '' || (setting === 'summarizeBy' && str(v)?.toLowerCase() === 'default')) continue;
        feature({ kind: 'setting', name: setting, table: tableName, column: column.name }, c, setting);
      }
      for (const v of arr(c.variations)) {
        if (!isObject(v)) continue;
        const target = isObject(v.defaultHierarchy) ? str(v.defaultHierarchy.table) : undefined;
        feature({ kind: 'variation', name: str(v.name) ?? 'Variation', table: tableName, column: column.name, ...(target ? { target } : {}) }, v);
      }
    });
    const measures: SemanticModelMeasure[] = [];
    for (const m of arr(raw.measures)) {
      if (!isObject(m) || !str(m.name)) continue;
      const description = textOf(m.description);
      const p = place(m);
      measures.push({
        name: m.name as string,
        ...(description ? { description } : {}),
        ...(isObject(m.kpi) ? { kpi: true } : {}),
        ...(p.line !== undefined ? { line: p.line } : {}),
        ...(p.file !== tablePlace.file ? { file: p.file } : {}),
      });
      if (isObject(m.kpi)) feature({ kind: 'kpi', name: m.name as string, table: tableName, column: m.name as string }, m);
    }
    const calculationGroup = isObject(raw.calculationGroup) ? raw.calculationGroup : undefined;
    const table: SemanticModelTable = {
      name: tableName,
      isHidden: raw.isHidden === true,
      isPrivate: raw.isPrivate === true,
      showAsVariationsOnly: raw.showAsVariationsOnly === true,
      kind: calculationGroup ? 'calculationGroup' : calculated ? 'calculated' : 'table',
      columns,
      measures,
      file: tablePlace.file,
      ...(tablePlace.line !== undefined ? { line: tablePlace.line } : {}),
    };
    if (calculationGroup) table.calculationItems = arr(calculationGroup.calculationItems).length;
    const description = textOf(raw.description);
    if (description) table.description = description;
    tables.push(table);
    const category = str(raw.dataCategory);
    if (category && category.toLowerCase() === 'time') feature({ kind: 'dateTable', name: tableName, table: tableName }, raw, 'dataCategory');
    else if (category) feature({ kind: 'setting', name: 'dataCategory', table: tableName }, raw, 'dataCategory');
    for (const h of arr(raw.hierarchies)) {
      if (isObject(h) && str(h.name)) feature({ kind: 'hierarchy', name: h.name as string, table: tableName, count: arr(h.levels).length }, h);
    }
    for (const c of arr(raw.calendars)) {
      if (isObject(c) && str(c.name)) feature({ kind: 'calendar', name: c.name as string, table: tableName }, c);
    }
    const first = rawPartitions[0];
    const source = first && isObject(first.source) ? first.source : undefined;
    let partition: RawPartition | undefined;
    if (source) {
      const type = (str(source.type) ?? '').toLowerCase();
      const p = place(first);
      partition = {
        type,
        ...(textOf(source.expression) ? { text: textOf(source.expression) } : textOf(source.query) ? { text: textOf(source.query) } : {}),
        ...(type === 'entity' ? { entity: { schema: str(source.schemaName), name: str(source.entityName) } } : {}),
        ...(p.line !== undefined ? { line: p.line } : {}),
        ...(p.file !== tablePlace.file ? { file: p.file } : {}),
      };
    }
    const policy = isObject(raw.refreshPolicy) ? textOf(raw.refreshPolicy.sourceExpression) : undefined;
    partition = withRefreshPolicy(partition, policy);
    if (partition) partitions.set(table, partition);
  });
  const relationships: SemanticModelRelationship[] = [];
  const rawRels = arr(model.relationships);
  rawRels.forEach((r, i) => {
    const p = place(r);
    const at = `${p.line !== undefined ? ` (${baseName(p.file) || fileName}, line ${p.line})` : ''}`;
    if (!isObject(r)) {
      warnings.push(`Relationship ${i + 1} in ${baseName(p.file) || fileName} is not an object, so it was skipped${p.line !== undefined ? ` (line ${p.line})` : ''}.`);
      return;
    }
    const ends = [r.fromTable, r.fromColumn, r.toTable, r.toColumn].map(str);
    if (ends.some((e) => !e)) {
      warnings.push(`Relationship ${str(r.name) ?? i + 1}${at} does not name both tables and columns, so it was skipped.`);
      return;
    }
    const rel: SemanticModelRelationship = {
      fromTable: ends[0]!,
      fromColumn: ends[1]!,
      toTable: ends[2]!,
      toColumn: ends[3]!,
      fromCardinality: cardinality(r.fromCardinality, 'many'),
      toCardinality: cardinality(r.toCardinality, 'one'),
      isActive: r.isActive !== false,
      file: p.file,
      ...(p.line !== undefined ? { line: p.line } : {}),
    };
    if (str(r.name)) rel.name = r.name as string;
    if (str(r.crossFilteringBehavior)) rel.crossFilteringBehavior = r.crossFilteringBehavior as string;
    if (r.relyOnReferentialIntegrity === true) rel.relyOnReferentialIntegrity = true;
    if (str(r.securityFilteringBehavior)) rel.securityFilteringBehavior = r.securityFilteringBehavior as string;
    relationships.push(rel);
  });

  // Model-level features: roles, perspectives, cultures, data sources, shared expressions.
  for (const role of arr(model.roles)) {
    if (!isObject(role) || !str(role.name)) continue;
    feature({ kind: 'role', name: role.name as string }, role);
    for (const tp of arr(role.tablePermissions)) {
      if (!isObject(tp) || !str(tp.name)) continue;
      const tableName = tp.name as string;
      if (textOf(tp.filterExpression)?.trim()) feature({ kind: 'rowFilter', name: role.name as string, table: tableName }, tp, 'filterExpression');
      if (str(tp.metadataPermission)?.toLowerCase() === 'none') feature({ kind: 'tablePermission', name: role.name as string, table: tableName }, tp, 'metadataPermission');
      for (const cp of arr(tp.columnPermissions)) {
        // Only `none` hides the column (object-level security); `read` / `default` grant what the table does.
        if (isObject(cp) && str(cp.name) && str(cp.metadataPermission)?.toLowerCase() === 'none') {
          feature({ kind: 'columnPermission', name: role.name as string, table: tableName, column: cp.name as string }, cp);
        }
      }
    }
  }
  for (const p of arr(model.perspectives)) {
    if (isObject(p) && str(p.name)) feature({ kind: 'perspective', name: p.name as string }, p);
  }
  const local = new Map(opts.localTranslations ?? []);
  for (const c of arr(model.cultures)) {
    if (!isObject(c) || !str(c.name)) continue;
    const name = c.name as string;
    const n = countTmslTranslations(c.translations) + (local.get(name) ?? 0);
    local.delete(name);
    if (n > 0) feature({ kind: 'translation', name, count: n }, c);
    if (c.linguisticMetadata !== undefined && c.linguisticMetadata !== null) feature({ kind: 'linguisticMetadata', name }, c, 'linguisticMetadata');
  }
  // Translations kept on the objects for a culture with no file of its own.
  for (const [name, n] of local) if (n > 0) features.push({ kind: 'translation', name, count: n, file: opts.file });
  for (const d of arr(model.dataSources)) {
    if (isObject(d) && str(d.name)) feature({ kind: 'dataSource', name: d.name as string }, d);
  }
  const expressions = new Map<string, string>();
  for (const e of arr(model.expressions)) {
    if (!isObject(e) || !str(e.name)) continue;
    const body = textOf(e.expression) ?? '';
    expressions.set(e.name as string, body);
    feature({ kind: isMParameter(body) ? 'parameter' : 'expression', name: e.name as string }, e);
  }
  resolveSources(partitions, expressions);
  for (const f of arr(model.functions)) {
    if (isObject(f) && str(f.name)) feature({ kind: 'function', name: f.name as string }, f);
  }

  const result = finish(
    {
      name: chooseModelName(opts.file, opts.platformName, [str(database.name), str(model.name)]),
      kind: opts.kind,
      tables,
      relationships,
      features,
      ...(opts.readLedger?.length ? { ledger: [...opts.readLedger] } : {}),
    },
    warnings,
    opts.file,
    readProblems,
  );
  return result;
}

/**
 * Shared checks: a model with no tables cannot be imported (when files did
 * not read, those are why); duplicate table names keep the first.
 * `problems`: what did not read and was left out, each in `model.ledger`.
 */
function finish(model: SemanticModel, warnings: string[], file: string, problems: readonly SemanticModelProblem[] = []): ReadSemanticModelResult {
  if (model.tables.length === 0) {
    return { ok: false, problems: problems.length > 0 ? [...problems] : [{ file, message: 'The semantic model has no tables.' }] };
  }
  // What did not read left no column to draw: those problems are why nothing imports.
  if (problems.length > 0 && !model.tables.some((t) => t.columns.length > 0)) return { ok: false, problems: [...problems] };
  const seen = new Set<string>();
  const duplicates = createLedger();
  model.tables = model.tables.filter((t) => {
    const key = t.name.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`Table "${t.name}" is defined more than once; the first definition was used.`);
      // Its columns go with it: named where it is defined, so the second definition is not left unsaid.
      duplicates.skipped('table', 'duplicate', 'table defined more than once', {
        ...(t.file ? { file: t.file } : {}), ...(t.line !== undefined ? { line: t.line } : {}), table: t.name,
      }, 'not read: the first definition was used');
      return false;
    }
    seen.add(key);
    return true;
  });
  if (duplicates.entries.length > 0) model.ledger = [...(model.ledger ?? []), ...duplicates.entries];
  return { ok: true, model, warnings, ...(problems.length > 0 ? { problems: [...problems] } : {}) };
}

// ---------------------------------------------------------------------------
// TMDL
// ---------------------------------------------------------------------------

/** One TMDL line read as an object (`table Sales`), a property (`dataType: int64`) or a flag (`isKey`). */
interface TmdlNode {
  /** `table`, `column`, `dataType`, `isKey`… */
  keyword: string;
  kind: 'object' | 'property';
  /** An object's name (unquoted); '' for a property or an unnamed object (`database`, `calculationGroup`). */
  name: string;
  /** A property's value, or what follows an object's `=` (its expression or partition type); undefined for a flag. */
  value?: string;
  /** `/// …` lines above an object, joined. */
  doc?: string;
  indent: number;
  line: number;
  children: TmdlNode[];
  /** It did not read (a name with no closing quote, a ``` block never closed): why, as {@link TMDL_BROKEN} says it. */
  broken?: string;
}

/** Width of a line's leading whitespace: a tab is four columns. */
function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === '\t') w += 4;
    else if (ch === ' ') w += 1;
    else break;
  }
  return w;
}

/** A TMDL name at the start of `s`: `'quoted ''name'''` or a bare run up to whitespace, `=`, `:`. */
function readTmdlName(s: string): { name: string; rest: string } | undefined {
  if (s.startsWith("'")) {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return { name: out, rest: s.slice(i + 1) };
      }
      out += s[i];
    }
    return undefined;
  }
  const m = /^[^\s=:]+/.exec(s);
  return m ? { name: m[0], rest: s.slice(m[0].length) } : undefined;
}

interface TmdlParse {
  nodes: TmdlNode[];
  problems: SemanticModelProblem[];
  /**
   * Objects declared after a ``` block that is never closed (the rest of the
   * file was read as its expression): named, so the ledger can say each one
   * was not read. `table` is the top-level object they were under.
   */
  unread: Array<{ keyword: string; name: string; line: number; table?: string; from?: { table: string; column: string } }>;
  /**
   * Git merge conflicts left in the file (`<<<<<<<` … `>>>>>>>`): the line
   * each starts on, the table it is in, and the lines of the side that was
   * not read (`=======` to `>>>>>>>`, and a diff3 base from `|||||||`).
   */
  conflicts: Array<{ line: number; table?: string; skipped?: { from: number; to: number } }>;
}

/** A Git merge conflict marker line: `<<<<<<< HEAD`, `||||||| base` (diff3), `=======`, `>>>>>>> branch`. */
const MERGE_CONFLICT_MARKER = /^(?:<{7}|>{7}|\|{7})(?:\s|$)|^={7}$/;

/** Why a TMDL object did not read: the end of its ledger phrase (`TMDL column with no closing quote`), so each reason is its own line. */
const TMDL_BROKEN = {
  name: 'with no closing quote',
  fence: 'with a ``` block never closed',
  afterFence: 'after a ``` block never closed',
  noName: 'with no name',
} as const;

/** Line breaks: LF, CRLF, or a lone CR (classic Mac line endings some editors still write). */
const TMDL_LINE_BREAK = /\r\n|\r|\n/;

/**
 * A TMDL property value as meant: one wrapped whole in double quotes (TMDL
 * quotes a text value with leading or trailing spaces or special characters,
 * doubling a quote inside) is unwrapped; anything else is as written, so a
 * format string such as `"Q"q yyyy` keeps its quotes.
 */
export function unquoteTmdlValue(value: string): string {
  const m = /^"((?:[^"]|"")*)"$/.exec(value);
  return m ? m[1].replace(/""/g, '"') : value;
}

/** Parse one `.tmdl` file into a tree of nodes. Expressions are consumed (never read as nodes). */
function parseTmdl(file: SemanticModelFile): TmdlParse {
  const lines = file.text.replace(/^﻿/, '').split(TMDL_LINE_BREAK);
  const problems: SemanticModelProblem[] = [];
  const unread: TmdlParse['unread'] = [];
  const conflicts: TmdlParse['conflicts'] = [];
  /** In a merge conflict: reading its first side (`ours`), or passing over the rest of it (`other`). */
  let conflictSide: 'ours' | 'other' | undefined;
  const root: TmdlNode = { keyword: '', kind: 'object', name: '', indent: -1, line: 0, children: [] };
  const stack: TmdlNode[] = [root];
  let doc: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const lineNo = i + 1;
    if (MERGE_CONFLICT_MARKER.test(trimmed)) {
      // Only the first side of a conflict is read (as the file stood on the branch it was merged into); the
      // base and the other side are passed over and named, so nothing is read twice or as a copy of itself.
      const open = conflicts[conflicts.length - 1];
      if (trimmed.startsWith('<')) {
        if (conflictSide === undefined) {
          const table = [...stack].reverse().find((n) => n.keyword.toLowerCase() === 'table' && n.name);
          conflicts.push({ line: lineNo, ...(table ? { table: table.name } : {}) });
        }
        conflictSide = 'ours';
      } else if (trimmed.startsWith('>')) {
        if (open?.skipped) open.skipped.to = lineNo;
        conflictSide = undefined;
      } else if (conflictSide !== undefined) {
        if (open && !open.skipped) open.skipped = { from: lineNo, to: lines.length };
        conflictSide = 'other';
      }
      doc = [];
      continue;
    }
    if (conflictSide === 'other') continue;
    if (trimmed === '') continue;
    if (trimmed.startsWith('///')) {
      // `/// ` and the text as written: only the one space TMDL writes after the slashes goes, so an indented line stays indented.
      doc.push(trimmed.slice(3).replace(/^ /, ''));
      continue;
    }
    if (trimmed.startsWith('//')) continue;
    const indent = indentWidth(raw);

    const head = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(trimmed);
    if (!head) {
      // Not something TMDL starts a line with (a stray expression line): skip it.
      doc = [];
      continue;
    }
    const keyword = head[1];
    const after = head[2];
    let node: TmdlNode;
    if (/^\s*:/.test(after)) {
      node = { keyword, kind: 'property', name: '', value: unquoteTmdlValue(after.replace(/^\s*:/, '').trim()), indent, line: lineNo, children: [] };
    } else if (after.trim() === '') {
      node = { keyword, kind: 'property', name: '', indent, line: lineNo, children: [] };
    } else if (/^\s*=/.test(after)) {
      // A property whose value is an expression: `source = …`, `expression = …`.
      node = { keyword, kind: 'property', name: '', value: after.replace(/^\s*=/, '').trim(), indent, line: lineNo, children: [] };
    } else if (/^\s/.test(after)) {
      const named = readTmdlName(after.trim());
      if (!named) {
        problems.push({ file: file.path, line: lineNo, message: `"${keyword}" has a name that is not closed with a quote.` });
        // Kept as a broken object, so what is indented under it stays with it (and is left out with it).
        const partial = after.trim().replace(/^'/, '').replace(/\s*[=:].*$/, '').trim();
        node = { keyword, kind: 'object', name: partial, indent, line: lineNo, children: [], broken: TMDL_BROKEN.name };
        doc = [];
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
        stack[stack.length - 1].children.push(node);
        stack.push(node);
        continue;
      }
      node = { keyword, kind: 'object', name: named.name, indent, line: lineNo, children: [] };
      const rest = named.rest.trim();
      if (rest.startsWith('=')) node.value = rest.slice(1).trim();
      if (doc.length > 0) node.doc = doc.join('\n');
    } else {
      doc = [];
      continue;
    }
    doc = [];

    // An expression after `=`: on the line, a ``` fence, or an indented block below.
    if (node.value !== undefined) {
      if (node.value.startsWith('```')) {
        const inline = node.value.slice(3);
        if (inline.includes('```')) {
          node.value = inline.slice(0, inline.indexOf('```')).trim();
        } else {
          const body: string[] = inline.trim() ? [inline] : [];
          let closed = false;
          let j = i + 1;
          for (; j < lines.length; j++) {
            const t = lines[j].trim();
            if (t.endsWith('```')) {
              if (t.length > 3) body.push(t.slice(0, -3));
              closed = true;
              break;
            }
            body.push(lines[j]);
          }
          if (!closed) {
            problems.push({ file: file.path, line: lineNo, message: `The expression of ${keyword} ${node.name || ''} starts a \`\`\` block that is never closed.`.replace('  ', ' ') });
            node.broken = TMDL_BROKEN.fence;
            // The rest of the file was read as the expression: name what is declared in it, so none of it goes unsaid.
            while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
            // The table what follows is declared in: the nearest one open here (inside a `createOrReplace`
            // script too), until a later `table` line starts another or a line no deeper than it ends it.
            const open = [...stack.slice(1), node].reverse().find((n) => n.keyword.toLowerCase() === 'table');
            let context = open?.name;
            let contextIndent = open?.indent ?? -1;
            for (let k = i + 1; k < lines.length; k++) {
              const decl = /^\s*(table|column|measure|relationship|partition|hierarchy|role|perspective|cultureInfo|expression|dataSource|function|calculationItem)\s+(.+)$/.exec(lines[k]);
              const declared = decl ? readTmdlName(decl[2].trim()) : undefined;
              if (!decl || !declared) continue;
              const kw = decl[1];
              const at = indentWidth(lines[k]);
              if (kw === 'table') {
                context = declared.name;
                contextIndent = at;
              } else if (context !== undefined && at <= contextIndent) {
                context = undefined;
              }
              const table = kw === 'table' ? declared.name : context;
              // A relationship is named by the column it starts from (its own name is a GUID).
              const from = kw === 'relationship' ? tmdlFromColumnBelow(lines, k, at) : undefined;
              unread.push({ keyword: kw, name: declared.name, line: k + 1, ...(table ? { table } : {}), ...(from ? { from } : {}) });
            }
            i = lines.length;
          } else {
            i = j;
          }
          node.value = body.map((l) => l.trim()).join('\n').trim();
        }
      } else if (node.value === '') {
        const body: string[] = [];
        let first = -1;
        let j = i + 1;
        for (; j < lines.length; j++) {
          const t = lines[j].trim();
          if (t === '') {
            body.push('');
            continue;
          }
          const w = indentWidth(lines[j]);
          if (first < 0) {
            if (w <= indent) break;
            first = w;
          } else if (w < first) {
            break;
          }
          body.push(lines[j]);
        }
        // Trailing blank lines are not the expression's.
        while (body.length > 0 && body[body.length - 1] === '') {
          body.pop();
          j--;
        }
        node.value = body.map((l) => l.trim()).join('\n');
        i = j - 1;
      }
    }

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return { nodes: root.children, problems, unread, conflicts };
}

/** The `fromColumn:` of the object declared on line `k` (0-based) at `indent`, read from the lines indented under it. */
function tmdlFromColumnBelow(lines: readonly string[], k: number, indent: number): { table: string; column: string } | undefined {
  for (let m = k + 1; m < lines.length; m++) {
    if (lines[m].trim() === '') continue;
    if (indentWidth(lines[m]) <= indent) return undefined;
    const p = /^\s*fromColumn\s*:\s*(.+)$/.exec(lines[m]);
    if (p) return parseTmdlColumnRef(unquoteTmdlValue(p[1].trim()));
  }
  return undefined;
}

/**
 * Why a node did not read: the node itself, or a ``` block under it (which
 * took the rest of the file, so the node is incomplete). Undefined when it
 * reads; then each object under it whose own name did not read (an
 * annotation, a variation, a level…) is taken out of it and passed to
 * `leftOut`, so the node is read without it: one broken annotation never
 * costs its column, measure or relationship.
 */
function brokenIn(node: TmdlNode, leftOut: (n: TmdlNode) => void = () => {}): { node: TmdlNode; detail: string } | undefined {
  if (node.broken) return { node, detail: node.broken };
  const all = descendants(node);
  const whole = all.find((d) => d.broken && d.broken !== TMDL_BROKEN.name);
  if (whole) return { node: whole, detail: whole.broken! };
  if (!all.some((d) => d.broken)) return undefined;
  const todo: TmdlNode[] = [node];
  while (todo.length > 0) {
    const n = todo.pop()!;
    const kept: TmdlNode[] = [];
    for (const c of n.children) {
      if (c.broken) leftOut(c);
      else {
        kept.push(c);
        todo.push(c);
      }
    }
    n.children = kept;
  }
  return undefined;
}

/** A property's value (`undefined` when absent; `'true'` for a bare flag). */
function prop(node: TmdlNode, key: string): string | undefined {
  const p = node.children.find((c) => c.kind === 'property' && c.keyword.toLowerCase() === key.toLowerCase());
  if (!p) return undefined;
  return p.value === undefined ? 'true' : p.value;
}

function flag(node: TmdlNode, key: string): boolean {
  const v = prop(node, key);
  return v !== undefined && v.trim().toLowerCase() !== 'false';
}

/** A TMDL description: the `///` lines, else a `description:` property. */
function describe(node: TmdlNode): string | undefined {
  const d = node.doc ?? prop(node, 'description');
  return d && d.trim() ? d.trim() : undefined;
}

/**
 * A TMDL column reference: `Table.Column`, either part `'quoted'`, or
 * `Table[Column]` / `'Table'[Column]`. Undefined when it is neither.
 */
export function parseTmdlColumnRef(value: string): { table: string; column: string } | undefined {
  const s = value.trim();
  let tableName: string;
  let rest: string;
  if (s.startsWith("'")) {
    const table = readTmdlName(s);
    if (!table) return undefined;
    tableName = table.name;
    rest = table.rest.trim();
  } else {
    const m = /^([^.[\]]+)(.*)$/.exec(s);
    if (!m) return undefined;
    tableName = m[1].trim();
    rest = m[2].trim();
  }
  let column: string | undefined;
  if (rest.startsWith('.')) {
    const c = rest.slice(1).trim();
    if (c.startsWith("'")) {
      const named = readTmdlName(c);
      if (!named || named.rest.trim() !== '') return undefined;
      column = named.name;
    } else {
      column = c;
    }
  } else if (rest.startsWith('[')) {
    const m = /^\[(.*)\]$/.exec(rest);
    column = m ? m[1].replace(/\]\]/g, ']') : undefined;
  }
  if (!tableName || !column) return undefined;
  return { table: tableName, column };
}

/** The objects a TMDL file defines, looking inside `createOrReplace` scripts and a `model` that nests them. */
function topObjects(nodes: readonly TmdlNode[]): TmdlNode[] {
  const out: TmdlNode[] = [];
  for (const n of nodes) {
    const k = n.keyword.toLowerCase();
    if (k === 'createorreplace' || k === 'create' || k === 'alter' || k === 'model' || k === 'database') {
      out.push(n, ...topObjects(n.children));
    } else {
      out.push(n);
    }
  }
  return out;
}

/** The children of `node` with this keyword (any case) that are objects. */
function objects(node: TmdlNode, keyword: string): TmdlNode[] {
  return node.children.filter((c) => c.kind === 'object' && c.keyword.toLowerCase() === keyword.toLowerCase());
}

/** An `annotation <name> = <value>` child's value. */
function tmdlAnnotation(node: TmdlNode, name: string): string | undefined {
  const a = objects(node, 'annotation').find((c) => c.name.toLowerCase() === name.toLowerCase());
  return a?.value?.trim() || undefined;
}

/** Every node under `node`, depth first. */
function descendants(node: TmdlNode): TmdlNode[] {
  // Iterative: a hostile file indented thousands deep must not overflow the stack.
  const out: TmdlNode[] = [];
  const todo: TmdlNode[] = [...node.children].reverse();
  while (todo.length > 0) {
    const n = todo.pop()!;
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) todo.push(n.children[i]);
  }
  return out;
}

/** The ledger unit and phrase for a TMDL object of this keyword that did not read. */
function tmdlUnreadUnit(keyword: string, why: string): { unit: LedgerUnit; what: string } {
  const k = keyword.toLowerCase();
  const unit: LedgerUnit = k === 'table' ? 'table' : k === 'column' ? 'column' : k === 'relationship' ? 'relationship' : 'object';
  return { unit, what: `TMDL ${keyword} ${why}` };
}

/** The ledger's detail for every TMDL object that did not read (the reason is in its phrase). */
const TMDL_NOT_READ = 'not read';

/**
 * Read a TMDL definition, file by file: a file (or an object in it) that does
 * not read is left out and recorded in the model's ledger with its file and
 * line, and the rest is read. Only a model with no table left fails.
 */
function readTmdl(files: readonly SemanticModelFile[], platformName?: string): ReadSemanticModelResult {
  const problems: SemanticModelProblem[] = [];
  const warnings: string[] = [];
  const ledger = createLedger();
  const tables: SemanticModelTable[] = [];
  const relationships: SemanticModelRelationship[] = [];
  const features: SemanticModelFeature[] = [];
  const partitions = new Map<SemanticModelTable, RawPartition | undefined>();
  const expressions = new Map<string, string>();
  let databaseName: string | undefined;
  let modelName: string | undefined;
  /** One object that did not read: a problem entry naming it, at its line. */
  const unreadObject = (file: SemanticModelFile, keyword: string, line: number, why: string, names: { table?: string; column?: string } = {}): void => {
    const { unit, what } = tmdlUnreadUnit(keyword, why);
    ledger.problem(unit, 'parseError', what, { file: file.path, line, ...names }, TMDL_NOT_READ);
  };

  // Model order is the file order; sort by path so the result never depends on how the host listed them.
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const read: SemanticModelFile[] = [];
  /** A whole file that did not read: under `tables/`, the table it is named after (`G%2FL Accounts.tmdl` holds `G/L Accounts`). */
  const unreadFile = (file: SemanticModelFile, message: string, detail: string): void => {
    problems.push({ file: file.path, message });
    const stem = /(?:^|[\\/])tables[\\/]([^\\/]+)\.tmdl$/i.exec(file.path)?.[1];
    let table: string | undefined;
    try {
      table = stem !== undefined ? decodeURIComponent(stem) : undefined;
    } catch {
      table = stem;
    }
    if (table) ledger.problem('table', 'parseError', `TMDL table file ${detail}`, { file: file.path, table }, TMDL_NOT_READ);
    else ledger.problem('file', 'parseError', `TMDL file ${detail}`, { file: file.path }, TMDL_NOT_READ);
  };
  for (const file of sorted) {
    const notText = notTextReason(file.text);
    if (notText) {
      unreadFile(file, notText, 'that is not UTF-8 text');
      continue;
    }
    let parsed: TmdlParse;
    try {
      parsed = parseTmdl(file);
    } catch {
      unreadFile(file, 'This file could not be read as TMDL.', 'that is not TMDL');
      continue;
    }
    read.push(file);
    problems.push(...parsed.problems);
    const at = (node: TmdlNode): Pick<SemanticModelFeature, 'file' | 'line'> => ({ file: file.path, line: node.line });
    for (const node of topObjects(parsed.nodes)) {
      const keyword = node.keyword.toLowerCase();
      const isContainer = keyword === 'createorreplace' || keyword === 'create' || keyword === 'alter' || keyword === 'model' || keyword === 'database';
      // A container's own objects are read one by one; any other object that did not read is left out whole.
      const names = keyword === 'role' || keyword === 'perspective' || keyword === 'cultureinfo' || keyword === 'expression' || keyword === 'datasource' || keyword === 'function'
        ? { table: node.name } : {};
      // An object under it whose own name did not read (an annotation, a table permission) is left out alone, named under it.
      const leftOut = (d: TmdlNode): void => unreadObject(file, d.keyword, d.line, d.broken!, names);
      const broken = isContainer ? (node.broken ? { node, detail: node.broken } : undefined) : keyword === 'table' ? undefined : brokenIn(node, leftOut);
      if (broken && !(node.kind === 'property')) {
        if (keyword === 'relationship') {
          const from = parseTmdlColumnRef(prop(node, 'fromColumn') ?? '');
          unreadObject(file, node.keyword, broken.node.line, broken.detail, from ? { table: from.table, column: from.column } : {});
        } else {
          unreadObject(file, node.keyword, broken.node.line, broken.detail, names);
        }
        continue;
      }
      if (keyword === 'database' && node.name) databaseName ??= node.name;
      else if (keyword === 'model' && node.name) modelName ??= node.name;
      else if (keyword === 'table') {
        if (node.broken) {
          unreadObject(file, 'table', node.line, node.broken, node.name ? { table: node.name } : {});
          continue;
        }
        if (node.kind !== 'object' || !node.name.trim()) {
          problems.push({ file: file.path, line: node.line, message: 'A table has no name.' });
          unreadObject(file, 'table', node.line, TMDL_BROKEN.noName);
          continue;
        }
        const table = tmdlTable(node, file, warnings, ledger);
        tables.push(table.table);
        partitions.set(table.table, table.partition);
        features.push(...table.features);
      } else if (keyword === 'relationship') {
        const rel = tmdlRelationship(node, file, warnings);
        if (rel) relationships.push(rel);
      } else if (keyword === 'role' && node.kind === 'object') {
        features.push({ kind: 'role', name: node.name, ...at(node) });
        for (const tp of objects(node, 'tablePermission')) {
          if (tp.value?.trim()) features.push({ kind: 'rowFilter', name: node.name, table: tp.name, ...at(tp) });
          if (prop(tp, 'metadataPermission')?.trim().toLowerCase() === 'none') features.push({ kind: 'tablePermission', name: node.name, table: tp.name, ...at(tp) });
          for (const cp of objects(tp, 'columnPermission')) {
            // Only `none` hides the column (object-level security).
            if (prop(cp, 'metadataPermission')?.trim().toLowerCase() === 'none') features.push({ kind: 'columnPermission', name: node.name, table: tp.name, column: cp.name, ...at(cp) });
          }
        }
      } else if (keyword === 'perspective' && node.kind === 'object') {
        features.push({ kind: 'perspective', name: node.name, ...at(node) });
      } else if (keyword === 'cultureinfo' && node.kind === 'object') {
        const translations = node.children.filter((c) => c.keyword.toLowerCase() === 'translations')
          .flatMap(descendants)
          .filter((c) => c.kind === 'property' && /^(caption|description|displayfolder)$/i.test(c.keyword)).length;
        if (translations > 0) features.push({ kind: 'translation', name: node.name, count: translations, ...at(node) });
        const lm = node.children.find((c) => c.keyword.toLowerCase() === 'linguisticmetadata');
        if (lm) features.push({ kind: 'linguisticMetadata', name: node.name, ...at(lm) });
      } else if (keyword === 'expression' && node.kind === 'object') {
        const body = node.value ?? '';
        expressions.set(node.name, body);
        features.push({ kind: isMParameter(body) ? 'parameter' : 'expression', name: node.name, ...at(node) });
      } else if (keyword === 'datasource' && node.kind === 'object') {
        features.push({ kind: 'dataSource', name: node.name, ...at(node) });
      } else if (keyword === 'function' && node.kind === 'object') {
        features.push({ kind: 'function', name: node.name, ...at(node) });
      }
    }
    for (const c of parsed.conflicts) {
      const other = c.skipped ? `lines ${c.skipped.from}–${c.skipped.to}` : undefined;
      problems.push({
        file: file.path,
        line: c.line,
        message: `A Git merge conflict (<<<<<<< … >>>>>>>) is left in this file: only its first side was read${other ? `, and ${other} were not` : ''}. Resolve it and import again.`,
      });
      ledger.problem('file', 'parseError', 'TMDL merge conflict', { file: file.path, line: c.line, ...(c.table ? { table: c.table } : {}) },
        other ? `only the first side read; ${other} not read` : 'only the first side read');
    }
    for (const u of parsed.unread) {
      const k = u.keyword.toLowerCase();
      // A relationship by the column it starts from; a column with its table; anything else by its table, or its own name.
      const names = k === 'relationship'
        ? (u.from ? { table: u.from.table, column: u.from.column } : {})
        : k === 'column'
          ? { ...(u.table ? { table: u.table } : {}), column: u.name }
          : { table: u.table ?? u.name };
      unreadObject(file, u.keyword, u.line, TMDL_BROKEN.afterFence, names);
    }
  }
  resolveSources(partitions, expressions);
  // model.tmdl's `ref table …` lines give the model's own table order; tables it does not list follow, in file order.
  const order = new Map<string, number>();
  for (const file of read) {
    for (const line of file.text.split(TMDL_LINE_BREAK)) {
      const m = /^\s*ref\s+table\s+(.+)$/.exec(line);
      const named = m ? readTmdlName(m[1].trim()) : undefined;
      if (named && !order.has(named.name.toLowerCase())) order.set(named.name.toLowerCase(), order.size);
    }
  }
  const rank = (t: SemanticModelTable): number => order.get(t.name.toLowerCase()) ?? order.size;
  tables.sort((a, b) => rank(a) - rank(b));
  const path = files[0]?.path ?? '';
  return finish(
    {
      name: chooseModelName(path, platformName, [databaseName, modelName]),
      kind: 'tmdl',
      tables,
      relationships,
      features,
      ...(ledger.entries.length > 0 ? { ledger: [...ledger.entries] } : {}),
    },
    warnings,
    path,
    problems,
  );
}

function tmdlTable(node: TmdlNode, file: SemanticModelFile, warnings: string[], ledger: ImportLedger): { table: SemanticModelTable; partition?: RawPartition; features: SemanticModelFeature[] } {
  const columns: SemanticModelColumn[] = [];
  const measures: SemanticModelMeasure[] = [];
  const features: SemanticModelFeature[] = [];
  let calculated = false;
  let calculationGroup: TmdlNode | undefined;
  let partition: RawPartition | undefined;
  const at = (n: TmdlNode): Pick<SemanticModelFeature, 'file' | 'line'> => ({ file: file.path, line: n.line });
  let refreshSource: string | undefined;
  for (const child of node.children) {
    const k = child.keyword.toLowerCase();
    // One object of the table that did not read is left out (and named); the rest of the table is read.
    // An object under it whose own name did not read (an annotation) is left out alone, named under this child.
    const broken = brokenIn(child, (d) => {
      const { unit, what } = tmdlUnreadUnit(d.keyword, d.broken!);
      ledger.problem(unit, 'parseError', what, {
        file: file.path, line: d.line, table: node.name,
        ...(k === 'column' && child.name ? { column: child.name } : {}),
      }, TMDL_NOT_READ);
    });
    if (broken) {
      const { unit, what } = tmdlUnreadUnit(child.keyword, broken.detail);
      ledger.problem(unit, 'parseError', what, {
        file: file.path, line: broken.node.line, table: node.name,
        ...(k === 'column' && child.name ? { column: child.name } : {}),
      }, TMDL_NOT_READ);
      continue;
    }
    if (k === 'column' && (child.kind !== 'object' || !child.name.trim())) {
      warnings.push(`A column in table ${node.name} (${baseName(file.path)}, line ${child.line}) has no name, so it was skipped.`);
    } else if (k === 'column' && child.kind === 'object') {
      const calculatedColumn = child.value !== undefined && child.value !== '';
      const column: SemanticModelColumn = {
        name: child.name,
        dataType: prop(child, 'dataType') ?? '',
        isKey: flag(child, 'isKey'),
        isHidden: flag(child, 'isHidden'),
        kind: calculatedColumn ? 'calculated' : 'data',
        line: child.line,
      };
      const type = prop(child, 'type') as SemanticModelColumn['kind'] | undefined;
      if (!calculatedColumn && type && COLUMN_KINDS.has(type)) column.kind = type;
      const description = describe(child);
      if (description) column.description = description;
      const source = prop(child, 'sourceColumn');
      if (source) column.sourceColumn = source;
      const annotation = tmdlAnnotation(child, 'UnderlyingDateTimeDataType');
      if (annotation) column.dateTimeAnnotation = annotation;
      const formatString = prop(child, 'formatString');
      if (formatString?.trim()) column.formatString = formatString.trim();
      if (prop(child, 'isNullable')?.trim().toLowerCase() === 'false') column.isNullable = false;
      if (flag(child, 'isUnique')) column.isUnique = true;
      columns.push(column);
      for (const setting of REPORT_COLUMN_SETTINGS) {
        const p = child.children.find((c) => c.kind === 'property' && c.keyword.toLowerCase() === setting.toLowerCase());
        if (!p || p.value?.trim().toLowerCase() === 'false') continue;
        features.push({ kind: 'setting', name: setting, table: node.name, column: child.name, ...at(p) });
      }
      for (const v of objects(child, 'variation')) {
        const hierarchy = prop(v, 'defaultHierarchy');
        const target = hierarchy ? parseTmdlColumnRef(hierarchy)?.table : undefined;
        features.push({ kind: 'variation', name: v.name, table: node.name, column: child.name, ...(target ? { target } : {}), ...at(v) });
      }
    } else if (k === 'measure' && child.kind === 'object') {
      const description = describe(child);
      const kpi = child.children.some((c) => c.keyword.toLowerCase() === 'kpi');
      measures.push({ name: child.name, ...(description ? { description } : {}), ...(kpi ? { kpi: true } : {}), line: child.line });
      if (kpi) features.push({ kind: 'kpi', name: child.name, table: node.name, column: child.name, ...at(child) });
    } else if (k === 'partition' && child.kind === 'object') {
      const type = child.value?.trim().toLowerCase() ?? '';
      if (type === 'calculated') calculated = true;
      if (!partition) {
        const source = child.children.find((c) => c.keyword.toLowerCase() === 'source');
        partition = {
          type,
          line: child.line,
          ...(source?.value ? { text: source.value } : {}),
          ...(type === 'entity' && source ? { entity: { schema: prop(source, 'schemaName'), name: prop(source, 'entityName') } } : {}),
        };
      }
    } else if (k === 'calculationgroup') {
      calculationGroup = child;
    } else if (k === 'refreshpolicy') {
      refreshSource = prop(child, 'sourceExpression');
    } else if (k === 'calendar' && child.kind === 'object') {
      features.push({ kind: 'calendar', name: child.name, table: node.name, ...at(child) });
    } else if (k === 'hierarchy' && child.kind === 'object') {
      features.push({ kind: 'hierarchy', name: child.name, table: node.name, count: objects(child, 'level').length, ...at(child) });
    } else if (k === 'datacategory' && child.kind === 'property') {
      const category = child.value?.trim() ?? '';
      if (category.toLowerCase() === 'time') features.push({ kind: 'dateTable', name: node.name, table: node.name, ...at(child) });
      else if (category) features.push({ kind: 'setting', name: 'dataCategory', table: node.name, ...at(child) });
    }
  }
  const table: SemanticModelTable = {
    name: node.name,
    isHidden: flag(node, 'isHidden'),
    isPrivate: flag(node, 'isPrivate'),
    showAsVariationsOnly: flag(node, 'showAsVariationsOnly'),
    kind: calculationGroup ? 'calculationGroup' : calculated ? 'calculated' : 'table',
    columns,
    measures,
    file: file.path,
    line: node.line,
  };
  if (calculationGroup) table.calculationItems = objects(calculationGroup, 'calculationItem').length;
  const description = describe(node);
  if (description) table.description = description;
  partition = withRefreshPolicy(partition, refreshSource);
  return { table, ...(partition ? { partition } : {}), features };
}

function tmdlRelationship(node: TmdlNode, file: SemanticModelFile, warnings: string[]): SemanticModelRelationship | undefined {
  const fromRaw = prop(node, 'fromColumn');
  const toRaw = prop(node, 'toColumn');
  const from = fromRaw ? parseTmdlColumnRef(fromRaw) : undefined;
  const to = toRaw ? parseTmdlColumnRef(toRaw) : undefined;
  if (!from || !to) {
    warnings.push(`Relationship ${node.name || '(no name)'} (${baseName(file.path)}, line ${node.line}) does not name a fromColumn and a toColumn as Table.Column, so it was skipped.`);
    return undefined;
  }
  const rel: SemanticModelRelationship = {
    ...(node.name ? { name: node.name } : {}),
    fromTable: from.table,
    fromColumn: from.column,
    toTable: to.table,
    toColumn: to.column,
    fromCardinality: cardinality(prop(node, 'fromCardinality'), 'many'),
    toCardinality: cardinality(prop(node, 'toCardinality'), 'one'),
    isActive: prop(node, 'isActive')?.trim().toLowerCase() !== 'false',
  };
  const cross = prop(node, 'crossFilteringBehavior');
  if (cross) rel.crossFilteringBehavior = cross.trim();
  if (flag(node, 'relyOnReferentialIntegrity')) rel.relyOnReferentialIntegrity = true;
  const security = prop(node, 'securityFilteringBehavior');
  if (security?.trim()) rel.securityFilteringBehavior = security.trim();
  rel.file = file.path;
  rel.line = node.line;
  return rel;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * `name` in snake_case, deterministically: accents dropped, camelCase split
 * (`CustomerKey` → `customer_key`, `HTTPStatus` → `http_status`), anything
 * but letters and digits a single `_`, lower case. A table name that does not
 * start with a letter gets `t_` (`2024 Budget` → `t_2024_budget`); an empty
 * result is `table` / `column`.
 */
export function toSnakeCaseName(name: string, kind: 'table' | 'column'): string {
  let out = transliterate(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/%/g, ' pct ')
    .replace(/#/g, ' num ')
    .replace(/&/g, ' and ')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!out) out = kind;
  if (kind === 'table' && !/^[a-z]/.test(out)) out = `t_${out}`;
  // A table is a file (`<name>.yml`): a name Power BI allows (hundreds of characters) would pass the file system's 255-byte limit.
  if (kind === 'table' && out.length > MAX_TABLE_NAME_LENGTH) out = out.slice(0, MAX_TABLE_NAME_LENGTH).replace(/_+$/, '');
  return out;
}

/** The longest converted table name (the original is kept in `meta.power_bi_name`). */
export const MAX_TABLE_NAME_LENGTH = 100;

/**
 * Latin letters that do not decompose (`ß`, `ø`, `æ`…), and the Cyrillic and
 * Greek alphabets, in plain Latin letters: a Russian or Greek model's names
 * stay readable (`Клиенты` → `klienty`) instead of all becoming `table`,
 * `table_2`…. Scripts with no alphabet to spell out (Chinese, Japanese,
 * Arabic…) still fall back to `table` / `column` with a numbered suffix;
 * the original name is kept either way.
 */
const TRANSLITERATION: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {
    ß: 'ss', ẞ: 'SS', æ: 'ae', Æ: 'Ae', œ: 'oe', Œ: 'Oe', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D',
    þ: 'th', Þ: 'Th', ł: 'l', Ł: 'L', ı: 'i', ħ: 'h', Ħ: 'H', ŧ: 't', Ŧ: 'T', ŋ: 'ng', Ŋ: 'Ng', ĸ: 'k',
  };
  const cyrillic = 'а a б b в v г g д d е e ё e ж zh з z и i й y к k л l м m н n о o п p р r с s т t у u ф f х kh ц ts ч ch ш sh щ shch ъ _ ы y ь _ э e ю yu я ya є ye і i ї yi ґ g ў u ђ dj ј j љ lj њ nj ћ c џ dz ѓ gj ќ kj ѕ dz';
  const greek = 'α a β v γ g δ d ε e ζ z η i θ th ι i κ k λ l μ m ν n ξ x ο o π p ρ r σ s ς s τ t υ y φ f χ ch ψ ps ω o ά a έ e ή i ί i ό o ύ y ώ o ϊ i ϋ y ΐ i ΰ y';
  for (const table of [cyrillic, greek]) {
    const parts = table.split(' ');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const [lower, latin] = [parts[i], parts[i + 1] === '_' ? '' : parts[i + 1]];
      map[lower] = latin;
      const upper = lower.toUpperCase();
      // An upper-case letter starts a word (`Клиенты` → `Klienty`), so camelCase splitting still sees it.
      if (upper !== lower) map[upper] = latin ? latin[0].toUpperCase() + latin.slice(1) : '';
    }
  }
  return map;
})();

function transliterate(name: string): string {
  let out = '';
  for (const ch of name) out += TRANSLITERATION[ch] ?? ch;
  return out;
}

// ---------------------------------------------------------------------------
// DBML
// ---------------------------------------------------------------------------

/** Power BI data types → DBML column types. Matched without case; anything else is `variant`. */
export const SEMANTIC_MODEL_TYPE_MAP: Readonly<Record<string, string>> = {
  int64: 'bigint',
  string: 'varchar',
  double: 'double',
  decimal: 'decimal',
  datetime: 'timestamp',
  boolean: 'boolean',
  binary: 'binary',
  variant: 'variant',
};

/**
 * The custom-property names the DBML carries (`DBML_RICH_META_PREFIX` + this
 * becomes ERD Studio's `meta.<this>`). The generated file is Import DBML's
 * input, so it uses the rich export's `meta_` spelling, which Import DBML
 * reads (a bare setting there is another tool's, kept in `meta.dbml`).
 */
export const SEMANTIC_MODEL_META = {
  /** The original name, when snake_case changed it. */
  name: 'power_bi_name',
  /** `'true'` on a hidden table or column. */
  hidden: 'power_bi_hidden',
  /** `'true'` on a calculated column or calculated table. */
  calculated: 'power_bi_calculated',
  /** The warehouse table a table's partition reads (`schema.item`), from its M navigation or Direct Lake entity. */
  source: 'power_bi_source',
  /** Every source a table's query merges or appends, in order, comma-separated (`dbo.Orders, Customer`). */
  sources: 'power_bi_sources',
} as const;

/** The sentence a calculated column's note carries. */
export const CALCULATED_COLUMN_NOTE = 'Calculated column in Power BI; its DAX was not imported.';
/** The sentence a calculated table's note carries. */
export const CALCULATED_TABLE_NOTE = 'Calculated table in Power BI; its DAX was not imported.';

/**
 * What the ledger says about each model feature it names as not kept (every
 * one `lost` / `notDesign`): its unit, the fixed phrase that groups the
 * lines, and the clause after it.
 */
/** The order the ledger names features in: security first, report settings last. */
const FEATURE_ORDER: readonly SemanticModelFeatureKind[] = [
  'role', 'rowFilter', 'tablePermission', 'columnPermission', 'hierarchy', 'kpi', 'function', 'calendar', 'perspective', 'dateTable', 'variation',
  'translation', 'linguisticMetadata', 'dataSource', 'expression', 'parameter', 'setting',
];

const FEATURE_LEDGER: Readonly<Record<Exclude<SemanticModelFeatureKind, 'setting'>, { unit: LedgerUnit; what: string; detail: string }>> = {
  hierarchy: { unit: 'object', what: 'hierarchy', detail: 'not kept: a drill path over columns that were kept' },
  role: { unit: 'object', what: 'security role', detail: 'not kept, nor its members' },
  rowFilter: { unit: 'object', what: 'row filter', detail: "not kept: a security role's DAX filter on the table" },
  tablePermission: { unit: 'object', what: 'table permission', detail: 'not kept: a security role hides the table' },
  columnPermission: { unit: 'object', what: 'column permission', detail: 'not kept: a security role hides the column' },
  perspective: { unit: 'object', what: 'perspective', detail: 'not kept: a named view of part of the model' },
  translation: { unit: 'object', what: 'translated caption', detail: 'not kept: names and descriptions in another language' },
  linguisticMetadata: { unit: 'object', what: 'Q&A linguistic metadata', detail: 'not kept' },
  dataSource: { unit: 'object', what: 'data source', detail: 'not kept: a connection, not design' },
  expression: { unit: 'object', what: 'Power Query expression', detail: 'not kept: shared M' },
  parameter: { unit: 'object', what: 'Power Query parameter', detail: 'not kept' },
  dateTable: { unit: 'setting', what: 'Mark as date table', detail: 'not kept' },
  variation: { unit: 'setting', what: 'variation', detail: 'not kept: a link to a date hierarchy' },
  kpi: { unit: 'object', what: 'KPI', detail: 'not kept, as its measure is not' },
  function: { unit: 'object', what: 'DAX function', detail: 'not kept: a user-defined DAX function, not data' },
  calendar: { unit: 'object', what: 'calendar', detail: 'not kept: a time-intelligence calendar over columns that were kept' },
};

/** How the DBML header names each format. */
export const SEMANTIC_MODEL_KIND_LABELS: Readonly<Record<SemanticModelKind, string>> = {
  tmsl: 'TMSL',
  tmdl: 'TMDL',
  folder: 'TMSL, Tabular Editor folder',
};

/** The role (the Ref's name) an inactive relationship gets. */
export const INACTIVE_RELATIONSHIP_ROLE = 'inactive in Power BI';

export interface SemanticModelToDbmlOptions {
  /** The DBML Project's name (the import suggests the diagram name from it). Default: the model's name. */
  projectName?: string;
  /**
   * Mark as `pk` the one column a table is the "one" end of many-to-one
   * relationships through, when the table flags no `isKey` (Power BI rarely
   * sets it). Default true. Either way a "one" end that is not the key is
   * written `unique` (Power BI requires it), never made a second key.
   */
  inferKeys?: boolean;
  /** Inactive relationships: kept with the role {@link INACTIVE_RELATIONSHIP_ROLE} (default), or skipped. */
  inactiveRelationships?: 'keep' | 'skip';
}

export interface SemanticModelRename {
  kind: 'table' | 'column';
  /** The table's converted name (for a column, the table it is in). */
  table: string;
  from: string;
  to: string;
}

export interface SemanticModelToDbmlResult {
  dbml: string;
  tableCount: number;
  refCount: number;
  /** What was left out, one sentence each (measures are counted per table, never their DAX). */
  skipped: string[];
  /**
   * Kept, but worth saying: a name collision's suffix, a "one" end written
   * unique beside the table's own key (or beside none, when several are
   * joined), a relationship's cross-filter direction. Inferred keys and
   * retyped columns are counted in {@link ledger} instead (one note each kind).
   */
  warnings: string[];
  /** Every name snake_case changed. */
  renamed: SemanticModelRename[];
  /** What `skipped` lists, counted by kind (for a summary that names nothing). */
  skippedCounts: SemanticModelSkippedCounts;
  /**
   * What the conversion changed or could not keep (`importLedger.ts`):
   * Import Semantic Model… passes it on as the origin's ledger, rendered into
   * the draft's notes and Not imported list. [] when nothing was.
   */
  ledger: LedgerEntry[];
}

/** Skipped items by kind: measures (summed over tables), auto date/time tables, calculation groups, relationships. */
export interface SemanticModelSkippedCounts {
  measures: number;
  autoDateTables: number;
  calculationGroups: number;
  relationships: number;
}

/** Whether `table` is one Power BI's Auto date/time made. */
export function isAutoDateTable(table: Pick<SemanticModelTable, 'name' | 'isPrivate' | 'showAsVariationsOnly'>): boolean {
  return /^(LocalDateTable|DateTableTemplate)_/i.test(table.name) || (table.isPrivate && table.showAsVariationsOnly);
}

function isRowNumberColumn(column: SemanticModelColumn): boolean {
  return column.kind === 'rowNumber' || /^RowNumber-[0-9A-F-]+$/i.test(column.name);
}

/** A DBML identifier: bare when it is a plain word, else double-quoted. */
function ident(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A DBML string: `'…'`, or `'''…'''` when it has a line break. */
function dbmlString(text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return text.includes('\n') ? `'''${escaped}'''` : `'${escaped}'`;
}

/** `name`, or `name_2`, `name_3`… — the first not in `used` (case-insensitive); adds it. */
function freeName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name}_${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Parts of a note joined as sentences. One part is returned as written
 * (outer whitespace aside): a description is the user's own text and never
 * gains a full stop. Joining, a part before another gets one only when it
 * does not already end a sentence (`.`, `!`, `?`, `…`).
 */
export function sentenceJoin(parts: readonly string[]): string {
  const kept = parts.map((p) => p.trim()).filter((p) => p !== '');
  return kept.map((p, i) => (i < kept.length - 1 ? p.replace(/([^.!?\u2026])$/u, '$1.') : p)).join(' ');
}

interface ConvertedTable {
  source: SemanticModelTable;
  name: string;
  /** Kept columns in order: source column → converted name. */
  columns: Array<{ source: SemanticModelColumn; name: string }>;
  byName: Map<string, string>;
  pk: Set<string>;
  fk: Set<string>;
  /** Columns written `unique` (never the primary key). */
  unique: Set<string>;
}

/** `a`, `a and b`, `a, b and c`. */
function listJoin(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The DBML column type of a Power BI column ({@link SEMANTIC_MODEL_TYPE_MAP}; `dateTime` by {@link semanticDateTimeKind}). */
export function semanticColumnType(column: Pick<SemanticModelColumn, 'dataType' | 'dateTimeAnnotation' | 'formatString'>): string {
  const kind = semanticDateTimeKind(column);
  if (kind === 'date') return 'date';
  if (kind === 'time') return 'time';
  return SEMANTIC_MODEL_TYPE_MAP[column.dataType.trim().toLowerCase()] ?? 'variant';
}

/**
 * The model as DBML that **Import DBML…** reads whole (see the module
 * comment for the mapping). Deterministic: the same model gives the same
 * text. Tables and columns keep the model's order.
 */
export function semanticModelToDbml(model: SemanticModel, opts: SemanticModelToDbmlOptions = {}): SemanticModelToDbmlResult {
  const inferKeys = opts.inferKeys !== false;
  const keepInactive = opts.inactiveRelationships !== 'skip';
  const skipped: string[] = [];
  const warnings: string[] = [];
  const renamed: SemanticModelRename[] = [];
  const skippedCounts: SemanticModelSkippedCounts = { measures: 0, autoDateTables: 0, calculationGroups: 0, relationships: 0 };
  // What reading the files recorded comes first: a file or object that did not read.
  const ledger = createLedger(model.ledger ?? []);
  /** A place in a table: its file (or `file`, where a column or partition has its own), the line, the table and column. */
  const where = (table: SemanticModelTable, line?: number, column?: string, file?: string): { file?: string; line?: number; table: string; column?: string } => ({
    ...(file ?? table.file ? { file: file ?? table.file } : {}),
    ...(line !== undefined ? { line } : {}),
    table: table.name,
    ...(column ? { column } : {}),
  });

  // Tables.
  const usedTables = new Set<string>();
  const converted: ConvertedTable[] = [];
  const bySource = new Map<string, ConvertedTable>();
  const skippedTables = new Map<string, 'auto-date' | 'calculation-group' | 'no-columns'>();
  /** Tables whose source the ledger names, after the model's features. */
  const sourced: SemanticModelTable[] = [];
  /** The DAX of calculated tables and columns, named after the model's features. */
  const daxLost: Array<() => void> = [];
  for (const table of model.tables) {
    if (isAutoDateTable(table)) {
      skippedTables.set(table.name.toLowerCase(), 'auto-date');
      skippedCounts.autoDateTables++;
      skipped.push(`Auto date/time table ${table.name} (Power BI makes one per date column; add a date table of your own instead).`);
      ledger.skipped('table', 'notDesign', 'auto date/time table', where(table, table.line));
      continue;
    }
    if (table.kind === 'calculationGroup') {
      skippedTables.set(table.name.toLowerCase(), 'calculation-group');
      skippedCounts.calculationGroups++;
      skipped.push(`Calculation group ${table.name} (it holds DAX, not data).`);
      ledger.skipped('table', 'notDesign', 'calculation group', where(table, table.line));
      if (table.calculationItems) ledger.skipped('object', 'notDesign', 'calculation item', where(table, table.line), undefined, table.calculationItems);
      continue;
    }
    if (table.columns.every(isRowNumberColumn)) {
      // A table with no columns (a "measure table" that only holds measures) is not a table DBML,
      // or a diagram, can hold: named as not drawn; its measures are counted as every table's are.
      skippedTables.set(table.name.toLowerCase(), 'no-columns');
      ledger.lost('table', 'notDesign', 'table with no columns', where(table, table.line), table.measures.length > 0 ? 'not drawn: it holds only measures' : 'not drawn: it has no columns');
      if (table.measures.length > 0) {
        const n = table.measures.length;
        skippedCounts.measures += n;
        skipped.push(`${n} measure${n === 1 ? '' : 's'} in ${table.name} (${table.measures.map((m) => m.name).join(', ')}): measures are DAX calculations, not columns.`);
        ledger.skipped('object', 'notDesign', 'measure', where(table), undefined, n);
      }
      continue;
    }
    const wanted = toSnakeCaseName(table.name, 'table');
    const name = freeName(wanted, usedTables);
    if (name !== wanted) warnings.push(`Tables ${table.name} and another both become ${wanted}, so ${table.name} is ${name}.`);
    if (name !== table.name) renamed.push({ kind: 'table', table: name, from: table.name, to: name });

    const usedColumns = new Set<string>();
    const columns: ConvertedTable['columns'] = [];
    const byName = new Map<string, string>();
    for (const column of table.columns) {
      if (isRowNumberColumn(column)) continue;
      const wantedColumn = toSnakeCaseName(column.name, 'column');
      const columnName = freeName(wantedColumn, usedColumns);
      if (columnName !== wantedColumn) {
        warnings.push(`In ${table.name}, columns ${column.name} and another both become ${wantedColumn}, so ${column.name} is ${columnName}.`);
      }
      if (columnName !== column.name) renamed.push({ kind: 'column', table: name, from: column.name, to: columnName });
      columns.push({ source: column, name: columnName });
      byName.set(column.name.toLowerCase(), columnName);
      if (column.kind === 'calculated') daxLost.push(() => ledger.lost('column', 'notDesign', 'DAX expression', where(table, column.line, column.name, column.file), "not kept: a calculated column's DAX (the column is kept)"));
      const kind = semanticDateTimeKind(column);
      if (kind === 'date' || kind === 'time') {
        ledger.changed('type', 'inferred', `dateTime → ${kind}`, where(table, column.line, column.name, column.file), `because Power BI marks the column ${kind}-only`);
      }
    }
    if (table.measures.length > 0) {
      const n = table.measures.length;
      skippedCounts.measures += n;
      skipped.push(`${n} measure${n === 1 ? '' : 's'} in ${table.name} (${table.measures.map((m) => m.name).join(', ')}): measures are DAX calculations, not columns.`);
      ledger.skipped('object', 'notDesign', 'measure', where(table), undefined, n);
    }
    if (table.kind === 'calculated') daxLost.push(() => ledger.lost('table', 'notDesign', 'DAX expression', where(table, table.line), "not kept: a calculated table's DAX (the table is kept)"));
    const pk = new Set(columns.filter((c) => c.source.isKey).map((c) => c.name));
    const unique = new Set(columns.filter((c) => c.source.isUnique && !pk.has(c.name)).map((c) => c.name));
    const entry: ConvertedTable = { source: table, name, columns, byName, pk, fk: new Set(), unique };
    converted.push(entry);
    bySource.set(table.name.toLowerCase(), entry);
    if (table.source && table.kind !== 'calculated') sourced.push(table);
  }
  // Model features an ERD has no place for: named, never imported; what matters most first.
  // A measure table's own features (its KPIs) are still named: only its columns were not there to draw.
  const keptTable = (name: string | undefined): boolean => !name || (skippedTables.get(name.toLowerCase()) ?? 'no-columns') === 'no-columns';
  const features = [...(model.features ?? [])].sort((a, b) => FEATURE_ORDER.indexOf(a.kind) - FEATURE_ORDER.indexOf(b.kind));
  for (const f of features) {
    if (!keptTable(f.table)) continue; // Left out with its table, which says so.
    if (f.kind === 'variation' && f.target && skippedTables.get(f.target.toLowerCase()) === 'auto-date') continue; // Part of Auto date/time.
    const at = { ...(f.file ? { file: f.file } : {}), ...(f.line !== undefined ? { line: f.line } : {}) };
    if (f.kind === 'setting') {
      ledger.lost('setting', 'notDesign', f.name, { ...at, ...(f.table ? { table: f.table } : {}), ...(f.column ? { column: f.column } : {}) }, 'not kept: a report setting');
      continue;
    }
    const spec = FEATURE_LEDGER[f.kind];
    // A table's own feature is named with the table (`Calendar.Year-Month-Day`); a model-level one by its own name.
    const named = f.table
      ? { table: f.table, ...(f.column ? { column: f.column } : f.kind === 'hierarchy' || f.kind === 'calendar' ? { column: f.name } : {}) }
      : { table: f.name };
    ledger.lost(spec.unit, 'notDesign', spec.what, { ...at, ...named }, spec.detail, f.kind === 'translation' ? Math.max(1, f.count ?? 1) : 1);
  }
  for (const record of daxLost) record();
  // Where each table's rows come from: kept when the M names a warehouse table, else named as not kept.
  for (const table of sourced) {
    if (!table.source) continue;
    const combined = table.source.combined;
    if (combined) {
      // A merge or an append: every source it reads, kept in meta power_bi_sources.
      ledger.changed('table', 'other', `Power Query ${combined.kind}`, where(table, table.source.line, undefined, table.source.file),
        `reads ${listJoin(combined.inputs)}; all kept as ${SEMANTIC_MODEL_META.sources}`);
    }
    if (table.source.kind === 'navigation' || table.source.kind === 'entity') {
      ledger.changed('table', 'other', 'Power Query source', where(table, table.source.line, undefined, table.source.file), 'kept as the warehouse table it reads');
    } else {
      const lost: Record<string, [string, string]> = {
        nativeQuery: ['native query', 'not kept: its SQL is not read'],
        file: ['file source', 'not kept: a file or web source, not a warehouse table'],
        other: ['Power Query source', 'not kept: its M names no warehouse table'],
        calculated: ['Power Query source', 'not kept: its M names no warehouse table'],
      };
      const [what, detail] = lost[table.source.kind] ?? lost.other;
      ledger.lost('table', 'notDesign', what, where(table, table.source.line, undefined, table.source.file), detail);
    }
  }

  // Relationships.
  interface PlannedRef {
    from: { table: ConvertedTable; column: string };
    to: { table: ConvertedTable; column: string };
    op: '>' | '-' | '<>';
    inactive: boolean;
  }
  const refs: PlannedRef[] = [];
  const seenLinks = new Set<string>();
  /** Per table, the columns it is the "one" end of a relationship through (Power BI requires each unique). */
  const oneSideColumns = new Map<ConvertedTable, Set<string>>();
  /** The other end of a one-to-one: unique too, but never a key inferred from it. */
  const uniqueOnly = new Map<ConvertedTable, Set<string>>();
  const addTo = (map: Map<ConvertedTable, Set<string>>, table: ConvertedTable, column: string): void => {
    if (!map.has(table)) map.set(table, new Set());
    map.get(table)!.add(column);
  };
  /** Where a relationship is written, named by its "many" end. */
  const relWhere = (r: SemanticModelRelationship): { file?: string; line?: number; table: string; column: string } => ({
    ...(r.file ? { file: r.file } : {}),
    ...(r.line !== undefined ? { line: r.line } : {}),
    table: r.fromTable,
    column: r.fromColumn,
  });
  for (const rel of model.relationships) {
    const skipRelationship = (line: string): void => {
      skippedCounts.relationships++;
      skipped.push(line);
      ledger.skipped('relationship', 'other', 'relationship', { ...(rel.file ? { file: rel.file } : {}), ...(rel.line !== undefined ? { line: rel.line } : {}), table: rel.fromTable });
    };
    const label = `${rel.fromTable}[${rel.fromColumn}] → ${rel.toTable}[${rel.toColumn}]`;
    const skippedEnd = [rel.fromTable, rel.toTable].map((t) => skippedTables.get(t.toLowerCase()));
    if (skippedEnd.includes('auto-date')) {
      // Part of Auto date/time: the table's own line says so.
      ledger.skipped('relationship', 'notDesign', 'auto date/time link', { ...(rel.file ? { file: rel.file } : {}), ...(rel.line !== undefined ? { line: rel.line } : {}), table: rel.fromTable });
      continue;
    }
    if (skippedEnd.includes('calculation-group')) {
      skipRelationship(`Relationship ${label}: it joins a calculation group.`);
      continue;
    }
    const noColumns = [rel.fromTable, rel.toTable].find((t) => skippedTables.get(t.toLowerCase()) === 'no-columns');
    if (noColumns) {
      skipRelationship(`Relationship ${label}: ${noColumns} has no columns.`);
      continue;
    }
    const fromTable = bySource.get(rel.fromTable.toLowerCase());
    const toTable = bySource.get(rel.toTable.toLowerCase());
    if (!fromTable || !toTable) {
      skipRelationship(`Relationship ${label}: the model has no table ${!fromTable ? rel.fromTable : rel.toTable}.`);
      continue;
    }
    const fromColumn = fromTable.byName.get(rel.fromColumn.toLowerCase());
    const toColumn = toTable.byName.get(rel.toColumn.toLowerCase());
    if (!fromColumn || !toColumn) {
      skipRelationship(`Relationship ${label}: ${!fromColumn ? rel.fromTable : rel.toTable} has no column ${!fromColumn ? rel.fromColumn : rel.toColumn}.`);
      continue;
    }
    if (fromTable === toTable && fromColumn === toColumn) {
      skipRelationship(`Relationship ${label}: it joins a column to itself.`);
      continue;
    }
    if (!rel.isActive && !keepInactive) {
      skipRelationship(`Inactive relationship ${label}.`);
      continue;
    }
    const linkKey = [`${fromTable.name}.${fromColumn}`, `${toTable.name}.${toColumn}`].sort().join('|');
    if (seenLinks.has(linkKey)) {
      skipRelationship(`Relationship ${label}: the same two columns are already joined.`);
      continue;
    }
    seenLinks.add(linkKey);

    let from = { table: fromTable, column: fromColumn };
    let to = { table: toTable, column: toColumn };
    let op: PlannedRef['op'];
    if (rel.fromCardinality === 'many' && rel.toCardinality === 'one') op = '>';
    else if (rel.fromCardinality === 'one' && rel.toCardinality === 'many') {
      op = '>';
      [from, to] = [to, from];
    } else if (rel.fromCardinality === 'one') op = '-';
    else op = '<>';
    if (op === '>') {
      from.table.fk.add(from.column);
      addTo(oneSideColumns, to.table, to.column);
    } else if (op === '-') {
      from.table.fk.add(from.column);
      addTo(oneSideColumns, to.table, to.column);
      addTo(uniqueOnly, from.table, from.column);
    }
    // How the relationship filters, and what Power BI may assume of it: no place in a diagram, so named as not kept.
    const cross = rel.crossFilteringBehavior?.trim().toLowerCase();
    if (cross === 'bothdirections') ledger.lost('setting', 'noField', 'cross-filter direction', relWhere(rel), 'not kept: it filters both ways in Power BI');
    const security = rel.securityFilteringBehavior?.trim().toLowerCase();
    if (security === 'bothdirections') ledger.lost('setting', 'noField', 'security filter direction', relWhere(rel), 'not kept: row-level security filters across it both ways');
    else if (security === 'none') ledger.lost('setting', 'noField', 'security filter direction', relWhere(rel), 'not kept: row-level security does not filter across it');
    if (rel.relyOnReferentialIntegrity) ledger.lost('setting', 'noField', 'assume referential integrity', relWhere(rel), 'not kept: Power BI assumes every row has a match (inner joins)');
    refs.push({ from, to, op, inactive: !rel.isActive });
  }

  // Keys. Power BI requires the "one" end of a relationship to be unique: the
  // table's key when it is that column (isKey, else inferred for a table with
  // none that is reached through one column), otherwise written unique — never
  // a second key, and never a key moved off the column the model flags (bar a
  // date table's Mark-as-date-table key, below).
  const sourceColumnOf = (t: ConvertedTable, name: string): string => t.columns.find((c) => c.name === name)?.source.name ?? name;
  const lineOf = (t: ConvertedTable, name: string): number | undefined => t.columns.find((c) => c.name === name)?.source.line;
  const markUnique = (table: ConvertedTable, columns: readonly string[]): string[] => {
    const added = columns.filter((c) => !table.pk.has(c) && !table.unique.has(c));
    for (const c of added) {
      table.unique.add(c);
      ledger.changed('uniqueKey', 'inferred', 'marked unique', where(table.source, lineOf(table, c), sourceColumnOf(table, c)), 'because relationships join it (Power BI requires the one side unique)');
    }
    return added;
  };
  // A table marked as a date table (dataCategory Time) has its date column flagged
  // isKey by Mark as date table, for time intelligence. When no relationship joins
  // that column and every relationship joins one other (DimDate's DateKey), that
  // other column is the table's key; the date column stays unique (a date table's
  // dates are), and a note says so.
  const dateTables = new Set((model.features ?? []).filter((f) => f.kind === 'dateTable' && f.table).map((f) => f.table!.toLowerCase()));
  const dateTableKey = (table: ConvertedTable, columns: readonly string[]): string | undefined => {
    if (!inferKeys || columns.length !== 1 || table.pk.size !== 1 || !dateTables.has(table.source.name.toLowerCase())) return undefined;
    const [flagged] = table.pk;
    if (flagged === columns[0]) return undefined;
    const type = table.columns.find((c) => c.name === flagged)?.source.dataType.toLowerCase();
    return type === 'datetime' || type === 'date' ? flagged : undefined;
  };
  for (const [table, set] of oneSideColumns) {
    const columns = [...set];
    const dateColumn = dateTableKey(table, columns);
    if (dateColumn) {
      table.pk.clear();
      table.pk.add(columns[0]);
      table.unique.delete(columns[0]);
      table.unique.add(dateColumn);
      ledger.changed('primaryKey', 'inferred', 'date table key', where(table.source, lineOf(table, columns[0]), sourceColumnOf(table, columns[0])),
        `chosen because every relationship joins it; ${sourceColumnOf(table, dateColumn)} (isKey from Mark as date table) is marked unique`);
      warnings.push(`${table.source.name}: every relationship joins ${columns[0]}, so it is the key; ${dateColumn}, which Mark as date table flags isKey, is marked unique.`);
      continue;
    }
    if (table.pk.size === 0 && inferKeys && columns.length === 1) {
      table.pk.add(columns[0]);
      ledger.changed('primaryKey', 'inferred', 'inferred key', where(table.source, lineOf(table, columns[0]), sourceColumnOf(table, columns[0])), 'chosen because relationships point at it');
      continue;
    }
    const added = markUnique(table, columns);
    if (added.length === 0) continue;
    const joins = `relationships join ${listJoin(added)}, which Power BI requires to be unique`;
    if (table.pk.size > 0) {
      warnings.push(`${table.source.name}: ${joins}; ${listJoin([...table.pk])} stays the key (isKey).`);
    } else if (inferKeys && columns.length > 1) {
      warnings.push(`${table.source.name}: ${joins}; no primary key is inferred, as relationships join more than one column.`);
    }
  }
  for (const [table, set] of uniqueOnly) markUnique(table, [...set]);

  // The text.
  const out: string[] = [];
  out.push(`// Converted by ERD Studio from the Power BI semantic model "${model.name.replace(/[\r\n]+/g, ' ')}" (${SEMANTIC_MODEL_KIND_LABELS[model.kind]}).`);
  out.push(`// Measures, calculation groups and auto date/time tables are not included; original names are in meta_${SEMANTIC_MODEL_META.name}.`);
  out.push('');
  const projectName = opts.projectName ?? model.name;
  out.push(`Project ${ident(projectName)} {`);
  out.push(`  Note: ${dbmlString(`Converted from the Power BI semantic model ${model.name}.`)}`);
  out.push('}');

  for (const t of converted) {
    out.push('');
    const tableSettings: string[] = [];
    if (t.name !== t.source.name) tableSettings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.name}: ${dbmlString(t.source.name)}`);
    if (t.source.isHidden) tableSettings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.hidden}: 'true'`);
    if (t.source.kind === 'calculated') tableSettings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.calculated}: 'true'`);
    if (t.source.source?.table && t.source.kind !== 'calculated') tableSettings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.source}: ${dbmlString(t.source.source.table)}`);
    if (t.source.source?.combined && t.source.kind !== 'calculated') tableSettings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.sources}: ${dbmlString(t.source.source.combined.inputs.join(', '))}`);
    out.push(`Table ${ident(t.name)}${tableSettings.length ? ` [${tableSettings.join(', ')}]` : ''} {`);
    for (const c of t.columns) {
      const settings: string[] = [];
      if (t.pk.has(c.name)) settings.push('pk');
      else if (t.unique.has(c.name)) settings.push('unique');
      if (c.source.isNullable === false && !t.pk.has(c.name)) settings.push('not null');
      if (t.fk.has(c.name)) settings.push(`foreign_key: 'true'`);
      const calculated = c.source.kind === 'calculated';
      // A description is kept exactly as written; with none, a calculated column's note says its DAX was not imported.
      const note = c.source.description?.trim() ? sentenceJoin([c.source.description]) : calculated ? CALCULATED_COLUMN_NOTE : '';
      if (note) settings.push(`note: ${dbmlString(note)}`);
      if (c.name !== c.source.name) settings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.name}: ${dbmlString(c.source.name)}`);
      if (c.source.isHidden) settings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.hidden}: 'true'`);
      if (calculated) settings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.calculated}: 'true'`);
      out.push(`  ${ident(c.name)} ${semanticColumnType(c.source)}${settings.length ? ` [${settings.join(', ')}]` : ''}`);
    }
    const tableNote = t.source.description?.trim() ? sentenceJoin([t.source.description]) : t.source.kind === 'calculated' ? CALCULATED_TABLE_NOTE : '';
    if (tableNote) out.push(`  Note: ${dbmlString(tableNote)}`);
    out.push('}');
  }

  if (refs.length > 0) out.push('');
  for (const r of refs) {
    const name = r.inactive ? ` ${ident(INACTIVE_RELATIONSHIP_ROLE)}` : '';
    const end = (e: PlannedRef['from']): string => `${ident(e.table.name)}.${ident(e.column)}`;
    // Import DBML reads a one-to-one's second end as the foreign key, so the FK end goes second.
    const [first, second] = r.op === '-' ? [r.to, r.from] : [r.from, r.to];
    // No `[inactive]`: Import DBML does not keep it (and would list it as left out); the role says it.
    out.push(`Ref${name}: ${end(first)} ${r.op} ${end(second)}`);
  }
  out.push('');

  return { dbml: out.join('\n'), tableCount: converted.length, refCount: refs.length, skipped, warnings, renamed, skippedCounts, ledger: [...ledger.entries] };
}

/** Names matching ERD Studio's patterns — a guard the tests assert every converted name passes. */
export function isImportableName(name: string, kind: 'table' | 'column'): boolean {
  return (kind === 'table' ? TABLE_NAME_PATTERN : COLUMN_NAME_PATTERN).test(name);
}
