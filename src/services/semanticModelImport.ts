/**
 * **Import Power BI or Fabric semantic model…** — the engine: read a semantic
 * model saved as files (a Power BI Project's `<Name>.SemanticModel` folder, a
 * Fabric Git-integration folder, Tabular Editor's save-to-folder) and turn it
 * into DBML that **Import DBML…** (`src/commands/importDbml.ts`) takes as it
 * is: the command hands the text to the same flow Open Example Diagram uses,
 * so the user still names the diagram and sees the dry run first.
 *
 * Two formats, both read here:
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
 * | a calculated column or table | kept, with a sentence in its note and `meta_power_bi_calculated: 'true'` (its DAX is not imported) |
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
 * Pure: no `vscode`, no Node built-ins. The host passes paths and file texts.
 */

import { createLedger, type LedgerEntry, type LedgerUnit } from './importLedger';
import { DBML_RICH_META_PREFIX } from '@erd-studio/core';

import { COLUMN_NAME_PATTERN, TABLE_NAME_PATTERN } from '../types/naming';

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export type SemanticModelKind = 'tmsl' | 'tmdl';

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
  /** 1-based line of the column in its file (TMDL). */
  line?: number;
}

/** A measure: only its name, description and whether it has a KPI are read (never its DAX). */
export interface SemanticModelMeasure {
  name: string;
  description?: string;
  /** It carries a KPI (target and status). */
  kpi?: boolean;
  line?: number;
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
}

export interface SemanticModel {
  /** Fabric's `.platform` displayName, else the `<Name>` of `<Name>.SemanticModel` / `.Dataset`, else a database or model name that is not a tool default, else its folder. */
  name: string;
  kind: SemanticModelKind;
  tables: SemanticModelTable[];
  relationships: SemanticModelRelationship[];
  /** What the model holds that an ERD has no place for (named in the ledger, never imported). */
  features?: SemanticModelFeature[];
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
  | { ok: true; model: SemanticModel; warnings: string[] }
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
 * - outside both, each `*.bim` is TMSL on its own, root its folder, named
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

  // 3. Bare .bim files.
  norm.forEach((p, i) => {
    if (!usable[i] || !/\.bim$/i.test(p) || underPbip(p)) return;
    if (tmdlRoots.some((r) => r.normRoot === '' || isUnder(p, r.normRoot))) return;
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
  // Text that is not UTF-8 (a UTF-16 file read as UTF-8 is full of NULs) would read as no model at all, or as JSON gibberish.
  const encoding = [...(tmdl.length > 0 ? tmdl : bim)].filter((f) => notTextReason(f.text)).map((f) => ({ file: f.path, message: notTextReason(f.text)! }));
  if (encoding.length > 0) return { ok: false, problems: encoding };
  // Fabric Git integration's `.platform` names the item (its displayName): the best name there is.
  const platformName = files.map((f) => (baseName(f.path).toLowerCase() === '.platform' ? platformDisplayName(f.text) : undefined)).find((n) => !!n);
  if (tmdl.length > 0) {
    const result = readTmdl(tmdl, platformName);
    if (result.ok && bim.length > 0) {
      result.warnings.unshift(`Read the TMDL definition; ${bim.map((f) => baseName(f.path)).join(', ')} was ignored.`);
    }
    return result;
  }
  if (bim.length === 1) return readTmsl(bim[0], platformName);
  if (bim.length > 1) {
    return {
      ok: false,
      problems: [{ file: bim[0].path, message: `${bim.length} .bim files were given (${bim.map((f) => baseName(f.path)).join(', ')}); pick one semantic model.` }],
    };
  }
  return {
    ok: false,
    problems: [{ file: files[0]?.path ?? '', message: 'No semantic model files: expected a model.bim (TMSL) or a definition folder of .tmdl files (TMDL).' }],
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
  const at = raw.line !== undefined ? { line: raw.line } : {};
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
      todo.push(...x);
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
  return { type: 'm', text: sourceExpression, ...(partition?.line !== undefined ? { line: partition.line } : {}) };
}

function readTmsl(file: SemanticModelFile, platformName?: string): ReadSemanticModelResult {
  const text = file.text.replace(/^﻿/, '');
  if (text.trim() === '') return { ok: false, problems: [{ file: file.path, message: 'The file is empty, so it holds no semantic model.' }] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const line = jsonErrorLine(text, message);
    return { ok: false, problems: [{ file: file.path, ...(line ? { line } : {}), message: `Not valid JSON: ${message}` }] };
  }
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
    return { ok: false, problems: [{ file: file.path, message: 'This .bim file has no "model" object, so it is not a TMSL semantic model.' }] };
  }
  const warnings: string[] = [];
  const features: SemanticModelFeature[] = [];
  const feature = (f: Omit<SemanticModelFeature, 'file'>): void => { features.push({ ...f, file: file.path }); };
  const tables: SemanticModelTable[] = [];
  const partitions = new Map<SemanticModelTable, RawPartition | undefined>();
  const rawTables = arr(model.tables);
  rawTables.forEach((raw, i) => {
    if (!isObject(raw) || !str(raw.name)?.trim()) {
      warnings.push(`Table ${i + 1} in ${baseName(file.path)} has no name, so it was skipped.`);
      return;
    }
    const tableName = raw.name as string;
    const rawPartitions = arr(raw.partitions).filter(isObject);
    const calculated = rawPartitions.some((p) => isObject(p.source) && str(p.source.type)?.toLowerCase() === 'calculated');
    const columns: SemanticModelColumn[] = [];
    arr(raw.columns).forEach((c, ci) => {
      if (!isObject(c) || !str(c.name)?.trim()) {
        warnings.push(`Column ${ci + 1} of table ${tableName} in ${baseName(file.path)} has no name, so it was skipped.`);
        return;
      }
      const type = str(c.type) as SemanticModelColumn['kind'] | undefined;
      const column: SemanticModelColumn = {
        name: c.name as string,
        dataType: str(c.dataType) ?? '',
        isKey: c.isKey === true,
        isHidden: c.isHidden === true,
        kind: type && COLUMN_KINDS.has(type) ? type : 'data',
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
        feature({ kind: 'setting', name: setting, table: tableName, column: column.name });
      }
      for (const v of arr(c.variations)) {
        if (!isObject(v)) continue;
        const target = isObject(v.defaultHierarchy) ? str(v.defaultHierarchy.table) : undefined;
        feature({ kind: 'variation', name: str(v.name) ?? 'Variation', table: tableName, column: column.name, ...(target ? { target } : {}) });
      }
    });
    const measures: SemanticModelMeasure[] = [];
    for (const m of arr(raw.measures)) {
      if (!isObject(m) || !str(m.name)) continue;
      const description = textOf(m.description);
      measures.push({ name: m.name as string, ...(description ? { description } : {}), ...(isObject(m.kpi) ? { kpi: true } : {}) });
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
      file: file.path,
    };
    if (calculationGroup) table.calculationItems = arr(calculationGroup.calculationItems).length;
    const description = textOf(raw.description);
    if (description) table.description = description;
    tables.push(table);
    const category = str(raw.dataCategory);
    if (category && category.toLowerCase() === 'time') feature({ kind: 'dateTable', name: tableName, table: tableName });
    else if (category) feature({ kind: 'setting', name: 'dataCategory', table: tableName });
    for (const h of arr(raw.hierarchies)) {
      if (isObject(h) && str(h.name)) feature({ kind: 'hierarchy', name: h.name as string, table: tableName, count: arr(h.levels).length });
    }
    for (const c of arr(raw.calendars)) {
      if (isObject(c) && str(c.name)) feature({ kind: 'calendar', name: c.name as string, table: tableName });
    }
    const first = rawPartitions[0];
    const source = first && isObject(first.source) ? first.source : undefined;
    let partition: RawPartition | undefined;
    if (source) {
      const type = (str(source.type) ?? '').toLowerCase();
      partition = {
        type,
        ...(textOf(source.expression) ? { text: textOf(source.expression) } : textOf(source.query) ? { text: textOf(source.query) } : {}),
        ...(type === 'entity' ? { entity: { schema: str(source.schemaName), name: str(source.entityName) } } : {}),
      };
    }
    const policy = isObject(raw.refreshPolicy) ? textOf(raw.refreshPolicy.sourceExpression) : undefined;
    partition = withRefreshPolicy(partition, policy);
    if (partition) partitions.set(table, partition);
  });
  const relationships: SemanticModelRelationship[] = [];
  const rawRels = arr(model.relationships);
  rawRels.forEach((r, i) => {
    if (!isObject(r)) {
      warnings.push(`Relationship ${i + 1} in ${baseName(file.path)} is not an object, so it was skipped.`);
      return;
    }
    const ends = [r.fromTable, r.fromColumn, r.toTable, r.toColumn].map(str);
    if (ends.some((e) => !e)) {
      warnings.push(`Relationship ${str(r.name) ?? i + 1} does not name both tables and columns, so it was skipped.`);
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
    };
    if (str(r.name)) rel.name = r.name as string;
    if (str(r.crossFilteringBehavior)) rel.crossFilteringBehavior = r.crossFilteringBehavior as string;
    relationships.push(rel);
  });

  // Model-level features: roles, perspectives, cultures, data sources, shared expressions.
  for (const role of arr(model.roles)) {
    if (!isObject(role) || !str(role.name)) continue;
    feature({ kind: 'role', name: role.name as string });
    for (const tp of arr(role.tablePermissions)) {
      if (!isObject(tp) || !str(tp.name)) continue;
      const tableName = tp.name as string;
      if (textOf(tp.filterExpression)?.trim()) feature({ kind: 'rowFilter', name: role.name as string, table: tableName });
      if (str(tp.metadataPermission)?.toLowerCase() === 'none') feature({ kind: 'tablePermission', name: role.name as string, table: tableName });
      for (const cp of arr(tp.columnPermissions)) {
        // Only `none` hides the column (object-level security); `read` / `default` grant what the table does.
        if (isObject(cp) && str(cp.name) && str(cp.metadataPermission)?.toLowerCase() === 'none') {
          feature({ kind: 'columnPermission', name: role.name as string, table: tableName, column: cp.name as string });
        }
      }
    }
  }
  for (const p of arr(model.perspectives)) {
    if (isObject(p) && str(p.name)) feature({ kind: 'perspective', name: p.name as string });
  }
  for (const c of arr(model.cultures)) {
    if (!isObject(c) || !str(c.name)) continue;
    const n = countTmslTranslations(c.translations);
    if (n > 0) feature({ kind: 'translation', name: c.name as string, count: n });
    if (c.linguisticMetadata !== undefined && c.linguisticMetadata !== null) feature({ kind: 'linguisticMetadata', name: c.name as string });
  }
  for (const d of arr(model.dataSources)) {
    if (isObject(d) && str(d.name)) feature({ kind: 'dataSource', name: d.name as string });
  }
  const expressions = new Map<string, string>();
  for (const e of arr(model.expressions)) {
    if (!isObject(e) || !str(e.name)) continue;
    const body = textOf(e.expression) ?? '';
    expressions.set(e.name as string, body);
    feature({ kind: isMParameter(body) ? 'parameter' : 'expression', name: e.name as string });
  }
  for (const [table, raw] of partitions) {
    const source = resolveSource(raw, expressions);
    if (source) table.source = source;
  }
  for (const t of tables) {
    for (const m of t.measures) if (m.kpi) feature({ kind: 'kpi', name: m.name, table: t.name, column: m.name });
  }
  for (const f of arr(model.functions)) {
    if (isObject(f) && str(f.name)) feature({ kind: 'function', name: f.name as string });
  }

  return finish(
    {
      name: chooseModelName(file.path, platformName, [str(database.name), str(model.name)]),
      kind: 'tmsl',
      tables,
      relationships,
      features,
    },
    warnings,
    file.path,
  );
}

/** Shared checks: a model with no tables cannot be imported; duplicate table names keep the first. */
function finish(model: SemanticModel, warnings: string[], file: string): ReadSemanticModelResult {
  if (model.tables.length === 0) {
    return { ok: false, problems: [{ file, message: 'The semantic model has no tables.' }] };
  }
  const seen = new Set<string>();
  model.tables = model.tables.filter((t) => {
    const key = t.name.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`Table "${t.name}" is defined more than once; the first definition was used.`);
      return false;
    }
    seen.add(key);
    return true;
  });
  return { ok: true, model, warnings };
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
}

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
  const root: TmdlNode = { keyword: '', kind: 'object', name: '', indent: -1, line: 0, children: [] };
  const stack: TmdlNode[] = [root];
  let doc: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('///')) {
      // `/// ` and the text as written: only the one space TMDL writes after the slashes goes, so an indented line stays indented.
      doc.push(trimmed.slice(3).replace(/^ /, ''));
      continue;
    }
    if (trimmed.startsWith('//')) continue;
    const indent = indentWidth(raw);
    const lineNo = i + 1;

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
        doc = [];
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
  return { nodes: root.children, problems };
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

function readTmdl(files: readonly SemanticModelFile[], platformName?: string): ReadSemanticModelResult {
  const problems: SemanticModelProblem[] = [];
  const warnings: string[] = [];
  const tables: SemanticModelTable[] = [];
  const relationships: SemanticModelRelationship[] = [];
  const features: SemanticModelFeature[] = [];
  const partitions = new Map<SemanticModelTable, RawPartition | undefined>();
  const expressions = new Map<string, string>();
  let databaseName: string | undefined;
  let modelName: string | undefined;

  // Model order is the file order; sort by path so the result never depends on how the host listed them.
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    const parsed = parseTmdl(file);
    problems.push(...parsed.problems);
    const at = (node: TmdlNode): Pick<SemanticModelFeature, 'file' | 'line'> => ({ file: file.path, line: node.line });
    for (const node of topObjects(parsed.nodes)) {
      const keyword = node.keyword.toLowerCase();
      if (keyword === 'database' && node.name) databaseName ??= node.name;
      else if (keyword === 'model' && node.name) modelName ??= node.name;
      else if (keyword === 'table') {
        if (node.kind !== 'object' || !node.name.trim()) {
          problems.push({ file: file.path, line: node.line, message: 'A table has no name.' });
          continue;
        }
        const read = tmdlTable(node, file, warnings);
        tables.push(read.table);
        partitions.set(read.table, read.partition);
        features.push(...read.features);
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
  }
  if (problems.length > 0) return { ok: false, problems };
  for (const [table, raw] of partitions) {
    const source = resolveSource(raw, expressions);
    if (source) table.source = source;
  }
  // model.tmdl's `ref table …` lines give the model's own table order; tables it does not list follow, in file order.
  const order = new Map<string, number>();
  for (const file of sorted) {
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
    { name: chooseModelName(path, platformName, [databaseName, modelName]), kind: 'tmdl', tables, relationships, features },
    warnings,
    path,
  );
}

function tmdlTable(node: TmdlNode, file: SemanticModelFile, warnings: string[]): { table: SemanticModelTable; partition?: RawPartition; features: SemanticModelFeature[] } {
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
  const ledger = createLedger();
  const where = (table: SemanticModelTable, line?: number, column?: string): { file?: string; line?: number; table: string; column?: string } => ({
    ...(table.file ? { file: table.file } : {}),
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
      const kind = semanticDateTimeKind(column);
      if (kind === 'date' || kind === 'time') {
        ledger.changed('type', 'inferred', `dateTime → ${kind}`, where(table, column.line, column.name), `because Power BI marks the column ${kind}-only`);
      }
    }
    if (table.measures.length > 0) {
      const n = table.measures.length;
      skippedCounts.measures += n;
      skipped.push(`${n} measure${n === 1 ? '' : 's'} in ${table.name} (${table.measures.map((m) => m.name).join(', ')}): measures are DAX calculations, not columns.`);
      ledger.skipped('object', 'notDesign', 'measure', where(table), undefined, n);
    }
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
  // Where each table's rows come from: kept when the M names a warehouse table, else named as not kept.
  for (const table of sourced) {
    if (!table.source) continue;
    if (table.source.kind === 'navigation' || table.source.kind === 'entity') {
      ledger.changed('table', 'other', 'Power Query source', where(table, table.source.line), 'kept as the warehouse table it reads');
    } else {
      const lost: Record<string, [string, string]> = {
        nativeQuery: ['native query', 'not kept: its SQL is not read'],
        file: ['file source', 'not kept: a file or web source, not a warehouse table'],
        other: ['Power Query source', 'not kept: its M names no warehouse table'],
        calculated: ['Power Query source', 'not kept: its M names no warehouse table'],
      };
      const [what, detail] = lost[table.source.kind] ?? lost.other;
      ledger.lost('table', 'notDesign', what, where(table, table.source.line), detail);
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
  /** Relationships that filter both ways: one warning for them all, so a model full of them does not bury the other notes. */
  const bothDirections: string[] = [];
  const skipRelationship = (line: string, table?: string): void => {
    skippedCounts.relationships++;
    skipped.push(line);
    ledger.skipped('relationship', 'other', 'relationship', table ? { table } : undefined);
  };
  for (const rel of model.relationships) {
    const label = `${rel.fromTable}[${rel.fromColumn}] → ${rel.toTable}[${rel.toColumn}]`;
    const skippedEnd = [rel.fromTable, rel.toTable].map((t) => skippedTables.get(t.toLowerCase()));
    if (skippedEnd.includes('auto-date')) {
      // Part of Auto date/time: the table's own line says so.
      ledger.skipped('relationship', 'notDesign', 'auto date/time link', { table: rel.fromTable });
      continue;
    }
    if (skippedEnd.includes('calculation-group')) {
      skipRelationship(`Relationship ${label}: it joins a calculation group.`, rel.fromTable);
      continue;
    }
    const noColumns = [rel.fromTable, rel.toTable].find((t) => skippedTables.get(t.toLowerCase()) === 'no-columns');
    if (noColumns) {
      skipRelationship(`Relationship ${label}: ${noColumns} has no columns.`, rel.fromTable);
      continue;
    }
    const fromTable = bySource.get(rel.fromTable.toLowerCase());
    const toTable = bySource.get(rel.toTable.toLowerCase());
    if (!fromTable || !toTable) {
      skipRelationship(`Relationship ${label}: the model has no table ${!fromTable ? rel.fromTable : rel.toTable}.`, rel.fromTable);
      continue;
    }
    const fromColumn = fromTable.byName.get(rel.fromColumn.toLowerCase());
    const toColumn = toTable.byName.get(rel.toColumn.toLowerCase());
    if (!fromColumn || !toColumn) {
      skipRelationship(`Relationship ${label}: ${!fromColumn ? rel.fromTable : rel.toTable} has no column ${!fromColumn ? rel.fromColumn : rel.toColumn}.`, rel.fromTable);
      continue;
    }
    if (fromTable === toTable && fromColumn === toColumn) {
      skipRelationship(`Relationship ${label}: it joins a column to itself.`, rel.fromTable);
      continue;
    }
    if (!rel.isActive && !keepInactive) {
      skipRelationship(`Inactive relationship ${label}.`, rel.fromTable);
      continue;
    }
    const linkKey = [`${fromTable.name}.${fromColumn}`, `${toTable.name}.${toColumn}`].sort().join('|');
    if (seenLinks.has(linkKey)) {
      skipRelationship(`Relationship ${label}: the same two columns are already joined.`, rel.fromTable);
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
    if (rel.crossFilteringBehavior && rel.crossFilteringBehavior.toLowerCase() === 'bothdirections') bothDirections.push(label);
    refs.push({ from, to, op, inactive: !rel.isActive });
  }

  if (bothDirections.length === 1) {
    warnings.push(`Relationship ${bothDirections[0]} filters in both directions in Power BI; ERD Studio does not record filter direction.`);
  } else if (bothDirections.length > 1) {
    const shown = bothDirections.slice(0, 3);
    const more = bothDirections.length - shown.length;
    warnings.push(`${bothDirections.length} relationships (${listJoin(more > 0 ? [...shown, `${more} more`] : shown)}) each filters in both directions in Power BI; ERD Studio does not record filter direction.`);
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
  out.push(`// Converted by ERD Studio from the Power BI semantic model "${model.name.replace(/[\r\n]+/g, ' ')}" (${model.kind.toUpperCase()}).`);
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
    out.push(`Table ${ident(t.name)}${tableSettings.length ? ` [${tableSettings.join(', ')}]` : ''} {`);
    for (const c of t.columns) {
      const settings: string[] = [];
      if (t.pk.has(c.name)) settings.push('pk');
      else if (t.unique.has(c.name)) settings.push('unique');
      if (c.source.isNullable === false && !t.pk.has(c.name)) settings.push('not null');
      if (t.fk.has(c.name)) settings.push(`foreign_key: 'true'`);
      const calculated = c.source.kind === 'calculated';
      const note = sentenceJoin([c.source.description ?? '', calculated ? CALCULATED_COLUMN_NOTE : '']);
      if (note) settings.push(`note: ${dbmlString(note)}`);
      if (c.name !== c.source.name) settings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.name}: ${dbmlString(c.source.name)}`);
      if (c.source.isHidden) settings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.hidden}: 'true'`);
      if (calculated) settings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.calculated}: 'true'`);
      out.push(`  ${ident(c.name)} ${semanticColumnType(c.source)}${settings.length ? ` [${settings.join(', ')}]` : ''}`);
    }
    const tableNote = sentenceJoin([t.source.description ?? '', t.source.kind === 'calculated' ? CALCULATED_TABLE_NOTE : '']);
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
