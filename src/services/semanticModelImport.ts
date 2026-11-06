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
 *   Anything else (partitions' M, annotations, hierarchies, cultures,
 *   perspectives, roles, unknown properties) is skipped over.
 *
 * The mapping to DBML ({@link semanticModelToDbml}):
 *
 * | Semantic model | DBML (and so ERD Studio) |
 * |---|---|
 * | table, its description | `Table snake_name`, its `Note` |
 * | column, `dataType`, description | `snake_name <type> [note: …]` ({@link SEMANTIC_MODEL_TYPE_MAP}) |
 * | `isKey` (else, with `inferKeys`, the one column a many-to-one relationship points at) | `pk` |
 * | relationship many → one | `Ref: fact.col > dim.col`; the many side's column gets `foreign_key: 'true'` |
 * | one → one, many → many | `-`, `<>` |
 * | `isActive: false` | the Ref kept, named (so its role is) "inactive in Power BI"; skipped with `inactiveRelationships: 'skip'` |
 * | the original name, when snake_case changed it | `meta_power_bi_name` (ERD Studio's `meta.power_bi_name`) |
 * | a hidden table or column | `meta_power_bi_hidden: 'true'` |
 * | a calculated column or table | kept, with a sentence in its note and `meta_power_bi_calculated: 'true'` (its DAX is not imported) |
 *
 * Skipped, and listed in `skipped`: measures (counted per table, never their
 * DAX), calculation groups, auto date/time tables (`LocalDateTable_…`,
 * `DateTableTemplate_…`, and any private variations-only table) with the
 * relationships into them, relationships whose ends are missing or skipped.
 * Hidden row-number columns (TMSL's `RowNumber-…`) are dropped silently.
 *
 * Names: Power BI names often carry spaces and punctuation (`'Date Table'`,
 * `Sales Amount`); ERD Studio names must match `TABLE_NAME_PATTERN` /
 * `COLUMN_NAME_PATTERN`, so every name becomes snake_case
 * ({@link toSnakeCaseName}: `Date Table` → `date_table`, `CustomerKey` →
 * `customer_key`), deterministically, and Refs use the converted names. Two
 * names that convert to the same one get `_2`, `_3`… (and a warning).
 *
 * Pure: no `vscode`, no Node built-ins. The host passes paths and file texts.
 */

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
}

/** A measure: only its name and description are read (never its DAX). */
export interface SemanticModelMeasure {
  name: string;
  description?: string;
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
  /** The `<Name>` of `<Name>.SemanticModel` / `.Dataset`, else the database's or model's name. */
  name: string;
  kind: SemanticModelKind;
  tables: SemanticModelTable[];
  relationships: SemanticModelRelationship[];
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
  if (tmdl.length > 0) {
    const result = readTmdl(tmdl);
    if (result.ok && bim.length > 0) {
      result.warnings.unshift(`Read the TMDL definition; ${bim.map((f) => baseName(f.path)).join(', ')} was ignored.`);
    }
    return result;
  }
  if (bim.length === 1) return readTmsl(bim[0]);
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

function readTmsl(file: SemanticModelFile): ReadSemanticModelResult {
  const text = file.text.replace(/^﻿/, '');
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
  if (database) {
    for (const command of ['createOrReplace', 'create', 'alter']) {
      const c = database[command];
      if (isObject(c) && isObject(c.database)) {
        database = c.database;
        break;
      }
    }
  }
  const model = database && isObject(database.model) ? database.model : undefined;
  if (!database || !model) {
    return { ok: false, problems: [{ file: file.path, message: 'This .bim file has no "model" object, so it is not a TMSL semantic model.' }] };
  }
  const warnings: string[] = [];
  const tables: SemanticModelTable[] = [];
  const rawTables = Array.isArray(model.tables) ? model.tables : [];
  rawTables.forEach((raw, i) => {
    if (!isObject(raw) || !str(raw.name)?.trim()) {
      warnings.push(`Table ${i + 1} in ${baseName(file.path)} has no name, so it was skipped.`);
      return;
    }
    const partitions = Array.isArray(raw.partitions) ? raw.partitions : [];
    const calculated = partitions.some((p) => isObject(p) && isObject(p.source) && str(p.source.type)?.toLowerCase() === 'calculated');
    const columns: SemanticModelColumn[] = [];
    for (const c of Array.isArray(raw.columns) ? raw.columns : []) {
      if (!isObject(c) || !str(c.name)) continue;
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
      columns.push(column);
    }
    const measures: SemanticModelMeasure[] = [];
    for (const m of Array.isArray(raw.measures) ? raw.measures : []) {
      if (!isObject(m) || !str(m.name)) continue;
      const description = textOf(m.description);
      measures.push({ name: m.name as string, ...(description ? { description } : {}) });
    }
    const table: SemanticModelTable = {
      name: raw.name as string,
      isHidden: raw.isHidden === true,
      isPrivate: raw.isPrivate === true,
      showAsVariationsOnly: raw.showAsVariationsOnly === true,
      kind: isObject(raw.calculationGroup) ? 'calculationGroup' : calculated ? 'calculated' : 'table',
      columns,
      measures,
    };
    const description = textOf(raw.description);
    if (description) table.description = description;
    tables.push(table);
  });
  const relationships: SemanticModelRelationship[] = [];
  const rawRels = Array.isArray(model.relationships) ? model.relationships : [];
  rawRels.forEach((r, i) => {
    if (!isObject(r)) return;
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
  return finish(
    {
      name: modelNameFromPath(file.path) ?? str(database.name) ?? str(model.name) ?? (baseName(file.path).replace(/\.bim$/i, '') || 'semantic-model'),
      kind: 'tmsl',
      tables,
      relationships,
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

/** Parse one `.tmdl` file into a tree of nodes. Expressions are consumed (never read as nodes). */
function parseTmdl(file: SemanticModelFile): TmdlParse {
  const lines = file.text.replace(/^﻿/, '').split(/\r?\n/);
  const problems: SemanticModelProblem[] = [];
  const root: TmdlNode = { keyword: '', kind: 'object', name: '', indent: -1, line: 0, children: [] };
  const stack: TmdlNode[] = [root];
  let doc: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('///')) {
      doc.push(trimmed.slice(3).trim());
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
      node = { keyword, kind: 'property', name: '', value: after.replace(/^\s*:/, '').trim(), indent, line: lineNo, children: [] };
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
    if (k === 'createorreplace' || k === 'create' || k === 'alter' || k === 'model') {
      out.push(n, ...topObjects(n.children));
    } else {
      out.push(n);
    }
  }
  return out;
}

function readTmdl(files: readonly SemanticModelFile[]): ReadSemanticModelResult {
  const problems: SemanticModelProblem[] = [];
  const warnings: string[] = [];
  const tables: SemanticModelTable[] = [];
  const relationships: SemanticModelRelationship[] = [];
  let databaseName: string | undefined;
  let modelName: string | undefined;

  // Model order is the file order; sort by path so the result never depends on how the host listed them.
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    const parsed = parseTmdl(file);
    problems.push(...parsed.problems);
    for (const node of topObjects(parsed.nodes)) {
      const keyword = node.keyword.toLowerCase();
      if (keyword === 'database' && node.name) databaseName ??= node.name;
      else if (keyword === 'model' && node.name) modelName ??= node.name;
      else if (keyword === 'table' && node.kind === 'object') {
        if (!node.name.trim()) {
          problems.push({ file: file.path, line: node.line, message: 'A table has no name.' });
          continue;
        }
        tables.push(tmdlTable(node));
      } else if (keyword === 'relationship' && node.kind === 'object') {
        const rel = tmdlRelationship(node, file, warnings);
        if (rel) relationships.push(rel);
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  // model.tmdl's `ref table …` lines give the model's own table order; tables it does not list follow, in file order.
  const order = new Map<string, number>();
  for (const file of sorted) {
    for (const line of file.text.split(/\r?\n/)) {
      const m = /^\s*ref\s+table\s+(.+)$/.exec(line);
      const named = m ? readTmdlName(m[1].trim()) : undefined;
      if (named && !order.has(named.name.toLowerCase())) order.set(named.name.toLowerCase(), order.size);
    }
  }
  const rank = (t: SemanticModelTable): number => order.get(t.name.toLowerCase()) ?? order.size;
  tables.sort((a, b) => rank(a) - rank(b));
  const path = files[0]?.path ?? '';
  return finish(
    { name: modelNameFromPath(path) ?? databaseName ?? modelName ?? 'semantic-model', kind: 'tmdl', tables, relationships },
    warnings,
    path,
  );
}

function tmdlTable(node: TmdlNode): SemanticModelTable {
  const columns: SemanticModelColumn[] = [];
  const measures: SemanticModelMeasure[] = [];
  let calculated = false;
  let calculationGroup = false;
  for (const child of node.children) {
    const k = child.keyword.toLowerCase();
    if (k === 'column' && child.kind === 'object') {
      const calculatedColumn = child.value !== undefined && child.value !== '';
      const column: SemanticModelColumn = {
        name: child.name,
        dataType: prop(child, 'dataType') ?? '',
        isKey: flag(child, 'isKey'),
        isHidden: flag(child, 'isHidden'),
        kind: calculatedColumn ? 'calculated' : 'data',
      };
      const type = prop(child, 'type') as SemanticModelColumn['kind'] | undefined;
      if (!calculatedColumn && type && COLUMN_KINDS.has(type)) column.kind = type;
      const description = describe(child);
      if (description) column.description = description;
      const source = prop(child, 'sourceColumn');
      if (source) column.sourceColumn = source;
      columns.push(column);
    } else if (k === 'measure' && child.kind === 'object') {
      const description = describe(child);
      measures.push({ name: child.name, ...(description ? { description } : {}) });
    } else if (k === 'partition' && child.kind === 'object') {
      if (child.value?.trim().toLowerCase() === 'calculated') calculated = true;
    } else if (k === 'calculationgroup') {
      calculationGroup = true;
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
  };
  const description = describe(node);
  if (description) table.description = description;
  return table;
}

function tmdlRelationship(node: TmdlNode, file: SemanticModelFile, warnings: string[]): SemanticModelRelationship | undefined {
  const fromRaw = prop(node, 'fromColumn');
  const toRaw = prop(node, 'toColumn');
  const from = fromRaw ? parseTmdlColumnRef(fromRaw) : undefined;
  const to = toRaw ? parseTmdlColumnRef(toRaw) : undefined;
  if (!from || !to) {
    warnings.push(`Relationship ${node.name} (${baseName(file.path)}, line ${node.line}) does not name a fromColumn and a toColumn as Table.Column, so it was skipped.`);
    return undefined;
  }
  const rel: SemanticModelRelationship = {
    name: node.name,
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
  let out = name
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
} as const;

/** The role (the Ref's name) an inactive relationship gets. */
export const INACTIVE_RELATIONSHIP_ROLE = 'inactive in Power BI';

export interface SemanticModelToDbmlOptions {
  /** The DBML Project's name (the import suggests the diagram name from it). Default: the model's name. */
  projectName?: string;
  /**
   * Mark as `pk` the one column a table is the "one" end of many-to-one
   * relationships through, when the table flags no `isKey` (Power BI rarely
   * sets it). Default true.
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
  /** Kept, but worth saying: a name collision's suffix, an inferred key, a relationship's cross-filter direction. */
  warnings: string[];
  /** Every name snake_case changed. */
  renamed: SemanticModelRename[];
  /** What `skipped` lists, counted by kind (for a summary that names nothing). */
  skippedCounts: SemanticModelSkippedCounts;
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

function sentenceJoin(parts: string[]): string {
  return parts.filter((p) => p.trim()).map((p) => p.trim().replace(/([^.!?])$/, '$1.')).join(' ');
}

interface ConvertedTable {
  source: SemanticModelTable;
  name: string;
  /** Kept columns in order: source column → converted name. */
  columns: Array<{ source: SemanticModelColumn; name: string }>;
  byName: Map<string, string>;
  pk: Set<string>;
  fk: Set<string>;
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

  // Tables.
  const usedTables = new Set<string>();
  const converted: ConvertedTable[] = [];
  const bySource = new Map<string, ConvertedTable>();
  const skippedTables = new Map<string, 'auto-date' | 'calculation-group'>();
  for (const table of model.tables) {
    if (isAutoDateTable(table)) {
      skippedTables.set(table.name.toLowerCase(), 'auto-date');
      skippedCounts.autoDateTables++;
      skipped.push(`Auto date/time table ${table.name} (Power BI makes one per date column; add a date table of your own instead).`);
      continue;
    }
    if (table.kind === 'calculationGroup') {
      skippedTables.set(table.name.toLowerCase(), 'calculation-group');
      skippedCounts.calculationGroups++;
      skipped.push(`Calculation group ${table.name} (it holds DAX, not data).`);
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
    }
    if (table.measures.length > 0) {
      const n = table.measures.length;
      skippedCounts.measures += n;
      skipped.push(`${n} measure${n === 1 ? '' : 's'} in ${table.name} (${table.measures.map((m) => m.name).join(', ')}): measures are DAX calculations, not columns.`);
    }
    const pk = new Set(columns.filter((c) => c.source.isKey).map((c) => c.name));
    const entry: ConvertedTable = { source: table, name, columns, byName, pk, fk: new Set() };
    converted.push(entry);
    bySource.set(table.name.toLowerCase(), entry);
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
  const oneSideColumns = new Map<ConvertedTable, Set<string>>();
  for (const rel of model.relationships) {
    const label = `${rel.fromTable}[${rel.fromColumn}] → ${rel.toTable}[${rel.toColumn}]`;
    const skippedEnd = [rel.fromTable, rel.toTable].map((t) => skippedTables.get(t.toLowerCase()));
    if (skippedEnd.includes('auto-date')) continue; // Part of Auto date/time: the table's own line says so.
    if (skippedEnd.includes('calculation-group')) {
      skippedCounts.relationships++;
      skipped.push(`Relationship ${label}: it joins a calculation group.`);
      continue;
    }
    const fromTable = bySource.get(rel.fromTable.toLowerCase());
    const toTable = bySource.get(rel.toTable.toLowerCase());
    if (!fromTable || !toTable) {
      skippedCounts.relationships++;
      skipped.push(`Relationship ${label}: the model has no table ${!fromTable ? rel.fromTable : rel.toTable}.`);
      continue;
    }
    const fromColumn = fromTable.byName.get(rel.fromColumn.toLowerCase());
    const toColumn = toTable.byName.get(rel.toColumn.toLowerCase());
    if (!fromColumn || !toColumn) {
      skippedCounts.relationships++;
      skipped.push(`Relationship ${label}: ${!fromColumn ? rel.fromTable : rel.toTable} has no column ${!fromColumn ? rel.fromColumn : rel.toColumn}.`);
      continue;
    }
    if (fromTable === toTable && fromColumn === toColumn) {
      skippedCounts.relationships++;
      skipped.push(`Relationship ${label}: it joins a column to itself.`);
      continue;
    }
    if (!rel.isActive && !keepInactive) {
      skippedCounts.relationships++;
      skipped.push(`Inactive relationship ${label}.`);
      continue;
    }
    const linkKey = [`${fromTable.name}.${fromColumn}`, `${toTable.name}.${toColumn}`].sort().join('|');
    if (seenLinks.has(linkKey)) {
      skippedCounts.relationships++;
      skipped.push(`Relationship ${label}: the same two columns are already joined.`);
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
      if (!oneSideColumns.has(to.table)) oneSideColumns.set(to.table, new Set());
      oneSideColumns.get(to.table)!.add(to.column);
    } else if (op === '-') {
      from.table.fk.add(from.column);
    }
    if (rel.crossFilteringBehavior && rel.crossFilteringBehavior.toLowerCase() === 'bothdirections') {
      warnings.push(`Relationship ${label} filters in both directions in Power BI; ERD Studio does not record filter direction.`);
    }
    refs.push({ from, to, op, inactive: !rel.isActive });
  }

  if (inferKeys) {
    for (const [table, columns] of oneSideColumns) {
      if (table.pk.size > 0 || columns.size !== 1) continue;
      const [column] = [...columns];
      table.pk.add(column);
      warnings.push(`${table.source.name}: ${column} is marked as the primary key, because relationships point at it.`);
    }
  }

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
    out.push(`Table ${ident(t.name)}${tableSettings.length ? ` [${tableSettings.join(', ')}]` : ''} {`);
    for (const c of t.columns) {
      const settings: string[] = [];
      if (t.pk.has(c.name)) settings.push('pk');
      if (t.fk.has(c.name)) settings.push(`foreign_key: 'true'`);
      const calculated = c.source.kind === 'calculated';
      const note = sentenceJoin([
        c.source.description ?? '',
        calculated ? 'Calculated column in Power BI; its DAX was not imported' : '',
      ]);
      if (note) settings.push(`note: ${dbmlString(note)}`);
      if (c.name !== c.source.name) settings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.name}: ${dbmlString(c.source.name)}`);
      if (c.source.isHidden) settings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.hidden}: 'true'`);
      if (calculated) settings.push(`${DBML_RICH_META_PREFIX}${SEMANTIC_MODEL_META.calculated}: 'true'`);
      const type = SEMANTIC_MODEL_TYPE_MAP[c.source.dataType.trim().toLowerCase()] ?? 'variant';
      out.push(`  ${ident(c.name)} ${type}${settings.length ? ` [${settings.join(', ')}]` : ''}`);
    }
    const tableNote = sentenceJoin([
      t.source.description ?? '',
      t.source.kind === 'calculated' ? 'Calculated table in Power BI; its DAX was not imported' : '',
    ]);
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

  return { dbml: out.join('\n'), tableCount: converted.length, refCount: refs.length, skipped, warnings, renamed, skippedCounts };
}

/** Names matching ERD Studio's patterns — a guard the tests assert every converted name passes. */
export function isImportableName(name: string, kind: 'table' | 'column'): boolean {
  return (kind === 'table' ? TABLE_NAME_PATTERN : COLUMN_NAME_PATTERN).test(name);
}
