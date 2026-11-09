/**
 * Tabular Editor's **Save to Folder** layout, put back together as the one
 * TMSL database it was split from, so the TMSL reader in
 * `semanticModelImport.ts` reads it as it reads a `model.bim`.
 *
 * The layout (Tabular Editor 2 and 3, `TabularEditor_SerializeOptions` in
 * `database.json`): `database.json` holds the database and its model, less
 * what each serialisation level splits out into its own JSON file, one object
 * per file:
 *
 * - `tables/<Table>/<Table>.json`, and under it `columns/`, `measures/`,
 *   `partitions/`, `hierarchies/`, `calculationItems/` (a calculation group's
 *   items), one file each;
 * - `relationships/`, `roles/`, `perspectives/`, `cultures/`, `dataSources/`,
 *   `expressions/` (and any other model collection), one file each.
 *
 * Options that move objects elsewhere are read too: `LocalRelationships`
 * keeps each table's relationships in its own file, in a
 * `TabularEditor_Relationships` annotation (JSON text, often split one line
 * per string); `LocalPerspectives` lists the perspectives in the model's
 * `TabularEditor_Perspectives` annotation; `LocalTranslations` keeps each
 * object's translations in `TabularEditor_TranslatedNames`,
 * `…TranslatedDescriptions` and `…TranslatedDisplayFolders` annotations
 * (`{ "fr-FR": "…" }`), counted here per culture. `PrefixFilenames`
 * (`001 Name.json`) only orders the files, and files are read in path order.
 *
 * One file that does not read never fails the model: it is left out and
 * recorded as a ledger `problem` with its file and line, and the table it
 * belongs to is named. Only a model with no table left fails, in
 * `semanticModelImport.ts`.
 *
 * Pure: no `vscode`, no Node built-ins.
 */

import { createLedger, type LedgerEntry, type LedgerUnit } from './importLedger';
import { jsonErrorLineOf, parseJsonWithLines, type JsonLines } from './jsonLines';

export interface FolderModelFile {
  path: string;
  text: string;
}

/** Where an object, or one of its keys, is written. */
export interface JsonPlace {
  file: string;
  line?: number;
}

export interface FolderModelRead {
  /** The database as one TMSL object (`{ name, model: { tables, relationships, … } }`). */
  database: Record<string, unknown>;
  /** The file and line of an object (or of its `key`) in the assembled database. */
  place(obj: unknown, key?: string): JsonPlace | undefined;
  /** Translated captions, descriptions and display folders kept on the objects themselves (`LocalTranslations`), per culture. */
  localTranslations: Map<string, number>;
  /** What did not read, one message each (with its file and line), for a model that ends with no table. */
  problems: Array<{ file: string; line?: number; message: string }>;
  /** Files that did not read, or sit outside the layout: `problem` and `skipped` entries. */
  ledger: LedgerEntry[];
  /** The database.json file's path ('' when there is none). */
  databaseFile: string;
}

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const textOf = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join('\n');
  return undefined;
};

const norm = (p: string): string => p.replace(/\\/g, '/');
const baseName = (p: string): string => norm(p).split('/').pop() ?? p;

/** A file or folder name as Tabular Editor wrote it (`%2F` for `/`…), read back; as written when it does not decode. */
function decodeName(segment: string): string {
  const stem = segment.replace(/\.json$/i, '');
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
}

/** Model collections a top-level folder fills, by its name in any case. */
const MODEL_COLLECTIONS: Readonly<Record<string, string>> = {
  tables: 'tables',
  relationships: 'relationships',
  roles: 'roles',
  perspectives: 'perspectives',
  cultures: 'cultures',
  translations: 'cultures',
  datasources: 'dataSources',
  expressions: 'expressions',
  functions: 'functions',
  querygroups: 'queryGroups',
};

/** Table collections a table's folder fills (`calculationItems` go inside its `calculationGroup`). */
const TABLE_COLLECTIONS: Readonly<Record<string, string>> = {
  columns: 'columns',
  measures: 'measures',
  partitions: 'partitions',
  hierarchies: 'hierarchies',
  calculationitems: 'calculationItems',
  calendars: 'calendars',
};

/** What one kind of file is called in the ledger, and its unit. */
const ROLE: Readonly<Record<string, { unit: LedgerUnit; what: string }>> = {
  database: { unit: 'file', what: 'database.json' },
  table: { unit: 'table', what: 'table file' },
  columns: { unit: 'column', what: 'column file' },
  measures: { unit: 'object', what: 'measure file' },
  partitions: { unit: 'object', what: 'partition file' },
  hierarchies: { unit: 'object', what: 'hierarchy file' },
  calculationItems: { unit: 'object', what: 'calculation item file' },
  relationships: { unit: 'relationship', what: 'relationship file' },
  other: { unit: 'object', what: 'model file' },
};

const LOCAL_TRANSLATIONS = /^TabularEditor_Translated(Names|Descriptions|DisplayFolders)$/i;

/** The 1-based line of a `JSON.parse` error, from either message V8 writes. */
function jsonErrorLine(text: string, message: string): number | undefined {
  const lineCol = /line (\d+) column \d+/.exec(message);
  if (lineCol) return Number(lineCol[1]);
  const pos = /position (\d+)/.exec(message);
  if (pos) return text.slice(0, Number(pos[1])).split(/\r\n|\r|\n/).length;
  return undefined;
}

/** Whether `paths` (any separators) hold a Save to Folder model: a `database.json` with `tables/<Table>/<file>.json` beside it. */
export function isSaveToFolderLayout(paths: readonly string[]): boolean {
  const all = paths.map(norm);
  return all.some((p) => {
    if (baseName(p).toLowerCase() !== 'database.json') return false;
    const dir = p.slice(0, Math.max(0, p.lastIndexOf('/')));
    const prefix = (dir ? `${dir}/` : '').toLowerCase();
    return all.some((q) => {
      const l = q.toLowerCase();
      if (!l.startsWith(`${prefix}tables/`) || !l.endsWith('.json')) return false;
      return l.slice(prefix.length).split('/').length >= 3;
    });
  });
}

/**
 * The database a Save to Folder model's files make (see the module comment).
 * `files` are every `.json` file of the model; the one `database.json`
 * nearest the top is its root, and files outside it are skipped. Never throws.
 */
export function readFolderModel(files: readonly FolderModelFile[]): FolderModelRead {
  const ledger = createLedger();
  const problems: FolderModelRead['problems'] = [];
  const places = new WeakMap<object, JsonPlace>();
  const linesOf = new WeakMap<object, { file: string; lines: JsonLines }>();
  const localTranslations = new Map<string, number>();

  const databaseEntry = files
    .filter((f) => baseName(f.path).toLowerCase() === 'database.json')
    .sort((a, b) => norm(a.path).split('/').length - norm(b.path).split('/').length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))[0];
  const rootDir = databaseEntry ? norm(databaseEntry.path).slice(0, Math.max(0, norm(databaseEntry.path).lastIndexOf('/'))) : '';
  const relative = (p: string): string[] | undefined => {
    const n = norm(p);
    if (!rootDir) return n.split('/');
    if (!n.toLowerCase().startsWith(`${rootDir.toLowerCase()}/`)) return undefined;
    return n.slice(rootDir.length + 1).split('/');
  };

  /** Records why a file did not read: a message and a ledger `problem` (`column file that does not parse`: each reason its own line). */
  const fileProblem = (file: string, role: string, message: string, why: string, line?: number, names: { table?: string; column?: string } = {}): void => {
    problems.push({ file, ...(line !== undefined ? { line } : {}), message });
    const r = ROLE[role] ?? ROLE.other;
    ledger.problem(r.unit, 'parseError', `${r.what} ${why}`, { file, ...(line !== undefined ? { line } : {}), ...names }, 'not read');
  };

  /** One file's object; undefined (and recorded) when it does not read. */
  const parse = (file: FolderModelFile, role: string, names: { table?: string; column?: string } = {}): Loose | undefined => {
    const text = file.text.replace(/^﻿/, '');
    if (text.slice(0, 65536).includes('\u0000')) {
      fileProblem(file.path, role, 'This file is not UTF-8 text: it holds NUL characters, as a UTF-16 file read as UTF-8 does. Save it as UTF-8 and import again.', 'that is not UTF-8 text', undefined, names);
      return undefined;
    }
    let parsed;
    try {
      parsed = parseJsonWithLines(text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const line = jsonErrorLineOf(e) ?? jsonErrorLine(text, message);
      fileProblem(file.path, role, `Not valid JSON: ${message}`, 'that does not parse', line, names);
      return undefined;
    }
    if (!isObject(parsed.value)) {
      fileProblem(file.path, role, 'This file does not hold a JSON object.', 'that is not a JSON object', 1, names);
      return undefined;
    }
    // Every object in the file is found by walking it: its lines come from this file.
    const todo: unknown[] = [parsed.value];
    while (todo.length > 0) {
      const x = todo.pop();
      if (Array.isArray(x)) {
        linesOf.set(x, { file: file.path, lines: parsed.lines });
        todo.push(...x);
      } else if (isObject(x)) {
        linesOf.set(x, { file: file.path, lines: parsed.lines });
        for (const v of Object.values(x)) if (typeof v === 'object' && v !== null) todo.push(v);
      }
    }
    return parsed.value;
  };

  // database.json: the database and its model (an empty one when it does not read; the tables can still be read).
  let database: Loose | undefined = databaseEntry ? parse(databaseEntry, 'database') : undefined;
  if (database && !isObject(database.model) && isObject(database.database)) database = database.database as Loose;
  database ??= {};
  if (!isObject(database.model)) database.model = {};
  const model = database.model as Loose;
  const push = (target: Loose, key: string, obj: Loose): void => {
    const list = Array.isArray(target[key]) ? (target[key] as unknown[]) : [];
    list.push(obj);
    target[key] = list;
  };

  // Tables first (by folder), then everything else, each in path order.
  const sorted = [...files].filter((f) => f !== databaseEntry).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const tableByFolder = new Map<string, Loose | null>();
  const tableFiles = sorted.filter((f) => {
    const rel = relative(f.path);
    return rel && rel.length === 3 && rel[0].toLowerCase() === 'tables';
  });
  for (const f of tableFiles) {
    const rel = relative(f.path)!;
    const folder = rel[1];
    if (tableByFolder.get(folder)) {
      // A second file directly in a table's folder: not part of the layout.
      ledger.skipped('file', 'other', 'file outside the Save to Folder layout', { file: f.path });
      continue;
    }
    const table = parse(f, 'table', { table: decodeName(folder) });
    tableByFolder.set(folder, table ?? null);
    if (table) push(model, 'tables', table);
  }
  /** Files of a table that did not read: counted with it, by kind. */
  const orphaned = new Map<string, Map<string, number>>();
  for (const f of sorted) {
    if (tableFiles.includes(f)) continue;
    const rel = relative(f.path);
    if (!rel) {
      ledger.skipped('file', 'other', 'file outside the Save to Folder layout', { file: f.path });
      continue;
    }
    if (rel.length === 4 && rel[0].toLowerCase() === 'tables') {
      const key = TABLE_COLLECTIONS[rel[2].toLowerCase()];
      const table = tableByFolder.get(rel[1]);
      if (!key) {
        ledger.skipped('file', 'other', 'file outside the Save to Folder layout', { file: f.path, table: decodeName(rel[1]) });
        continue;
      }
      if (!table) {
        // Its table did not read (already a problem by name), or has no file of its own.
        const counts = orphaned.get(rel[1]) ?? new Map<string, number>();
        counts.set(key, (counts.get(key) ?? 0) + 1);
        orphaned.set(rel[1], counts);
        continue;
      }
      const obj = parse(f, key, { table: str(table.name) ?? decodeName(rel[1]), ...(key === 'columns' ? { column: decodeName(rel[3]) } : {}) });
      if (!obj) continue;
      if (key === 'calculationItems') {
        if (!isObject(table.calculationGroup)) table.calculationGroup = {};
        push(table.calculationGroup as Loose, 'calculationItems', obj);
      } else {
        push(table, key, obj);
      }
      continue;
    }
    if (rel.length === 2) {
      const key = MODEL_COLLECTIONS[rel[0].toLowerCase()];
      if (!key || key === 'tables') {
        ledger.skipped('file', 'other', 'file outside the Save to Folder layout', { file: f.path });
        continue;
      }
      const obj = parse(f, key === 'relationships' ? 'relationships' : 'other');
      if (obj) push(model, key, obj);
      continue;
    }
    ledger.skipped('file', 'other', 'file outside the Save to Folder layout', { file: f.path });
  }
  for (const [folder, counts] of orphaned) {
    const name = decodeName(folder);
    const read = tableByFolder.has(folder);
    if (!read) {
      // Files under tables/<X>/ with no <X>.json: the table itself is not there.
      const file = `${rootDir ? `${rootDir}/` : ''}tables/${folder}`;
      fileProblem(file, 'table', `Table folder ${folder} has no table file (${folder}.json), so its files were not read.`, 'missing from its folder', undefined, { table: name });
    }
    for (const [key, n] of counts) {
      const r = ROLE[key] ?? ROLE.other;
      ledger.problem(r.unit, 'parseError', `${r.what} of a table that did not read`, { table: name }, 'not read', n);
    }
  }

  // Local relationships: each table's own, in its TabularEditor_Relationships annotation.
  const annotations = (obj: Loose): Loose[] => (Array.isArray(obj.annotations) ? obj.annotations.filter(isObject) : []);
  const placeOf = (obj: unknown, key?: string): JsonPlace | undefined => {
    if (typeof obj !== 'object' || obj === null) return undefined;
    const fixed = places.get(obj);
    if (fixed) return fixed;
    const at = linesOf.get(obj);
    if (!at) return undefined;
    const line = (key !== undefined ? at.lines.keyLine(obj, key) : undefined) ?? at.lines.lineOf(obj);
    return { file: at.file, ...(line !== undefined ? { line } : {}) };
  };
  for (const table of Array.isArray(model.tables) ? (model.tables as unknown[]).filter(isObject) : []) {
    for (const a of annotations(table)) {
      if (str(a.name) !== 'TabularEditor_Relationships') continue;
      const text = textOf(a.value) ?? '';
      if (!text.trim()) continue;
      const at = placeOf(a, 'value');
      // Split one string per line, the text's line k is the line after the array's `[` plus k - 1.
      const arrayLine = Array.isArray(a.value) ? linesOf.get(a.value as object)?.lines.lineOf(a.value) : undefined;
      const lineIn = (inner: number | undefined): number | undefined => (arrayLine !== undefined && inner !== undefined ? arrayLine + inner : at?.line);
      let parsed;
      try {
        parsed = parseJsonWithLines(text);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const line = lineIn(jsonErrorLineOf(e) ?? jsonErrorLine(text, message));
        const file = at?.file ?? '';
        problems.push({ file, ...(line !== undefined ? { line } : {}), message: `The relationships kept in table ${str(table.name) ?? ''} are not valid JSON: ${message}` });
        ledger.problem('relationship', 'parseError', 'relationships kept with a table that do not parse', { file, ...(line !== undefined ? { line } : {}), ...(str(table.name) ? { table: str(table.name) } : {}) }, 'not read: its TabularEditor_Relationships annotation');
        continue;
      }
      for (const r of Array.isArray(parsed.value) ? parsed.value : []) {
        if (!isObject(r)) continue;
        const line = lineIn(parsed.lines.lineOf(r));
        places.set(r, { file: at?.file ?? '', ...(line !== undefined ? { line } : {}) });
        push(model, 'relationships', r);
      }
    }
  }

  // Local perspectives: named in the model's TabularEditor_Perspectives annotation.
  for (const a of annotations(model)) {
    if (str(a.name) !== 'TabularEditor_Perspectives') continue;
    let list: unknown;
    try {
      list = JSON.parse(textOf(a.value) ?? '[]');
    } catch {
      list = [];
    }
    const at = placeOf(a, 'value');
    const known = new Set((Array.isArray(model.perspectives) ? model.perspectives : []).filter(isObject).map((p) => str(p.name)?.toLowerCase()));
    for (const p of Array.isArray(list) ? list : []) {
      const name = isObject(p) ? str(p.Name) ?? str(p.name) : undefined;
      if (!name || known.has(name.toLowerCase())) continue;
      known.add(name.toLowerCase());
      const obj: Loose = { name };
      if (at) places.set(obj, at);
      push(model, 'perspectives', obj);
    }
  }

  // Local translations: counted per culture, over every object of every file.
  const todo: unknown[] = [database];
  while (todo.length > 0) {
    const x = todo.pop();
    if (Array.isArray(x)) {
      todo.push(...x);
      continue;
    }
    if (!isObject(x)) continue;
    for (const [k, v] of Object.entries(x)) {
      if (k === 'annotations' && Array.isArray(v)) {
        for (const a of v.filter(isObject)) {
          if (!LOCAL_TRANSLATIONS.test(str(a.name) ?? '')) continue;
          try {
            const byCulture = JSON.parse(textOf(a.value) ?? '{}') as unknown;
            if (!isObject(byCulture)) continue;
            for (const [culture, text] of Object.entries(byCulture)) {
              if (typeof text === 'string' && text !== '') localTranslations.set(culture, (localTranslations.get(culture) ?? 0) + 1);
            }
          } catch {
            // A translation annotation that does not parse holds no translation to name.
          }
        }
      } else if (typeof v === 'object' && v !== null) {
        todo.push(v);
      }
    }
  }

  return { database, place: placeOf, localTranslations, problems, ledger: [...ledger.entries], databaseFile: databaseEntry?.path ?? '' };
}
