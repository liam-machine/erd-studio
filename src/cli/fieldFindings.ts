/**
 * `doctor`'s `erd.fields` block: which field list the project uses
 * (`.erd-studio/fields.yml`, or the starting set without one), every problem
 * with that file, and what the tables' own field values say about it.
 *
 * Kept apart from `erd.dbmlProblems` on purpose: a DBML problem breaks a
 * file for ERD Studio or another DBML tool, while a field finding is about
 * the team's list. Only an error here (a fields.yml problem the reader could
 * not settle on its own) raises a next step, `fix-fields-file`; warnings and
 * information never do, so an assistant's "run doctor until clean" loop ends.
 *
 * Findings, in this order:
 * - every fields.yml problem (core's `parseFieldsText`; `file` and `line` say where);
 * - `fieldValueOutsideChoices` (warning, one per table or column): a value
 *   of a choice or yes-no field that is not one of its options (the table
 *   role is not checked here);
 * - `fieldSpelledTwice` (warning, one per table or column and field; DBML
 *   only): one field set under more than one spelling (`rationale_purpose`
 *   and `purpose`);
 * - `fieldOldSpellings` (info, one for the project; DBML only): settings a
 *   new file would spell another way, counted;
 * - `fieldRetired` (info, one): tables that still hold a retired field;
 * - `fieldNotInList` (info, one; only with a fields.yml): fields with a
 *   value that the list does not name (its `left_out` keys excepted);
 * - `fieldMetaShadowsBuiltIn` (info, one): metadata keys named like a
 *   built-in field or a reserved setting, which stay metadata.
 *
 * Reads only, never throws, no `vscode`.
 */

import * as path from 'path';

import {
  FIELDS_FILE_NAME,
  STARTING_FIELD_LIST,
  builtInField,
  isReservedFieldKey,
  resolveColumnFields,
  resolveTableFields,
  type ColumnDef,
  type DbmlFieldSpelling,
  type DbmlTableReading,
  type FieldList,
  type FieldRow,
  type FieldScope,
  type FieldsFileProblem,
  type MetaValue,
  type SemanticTable,
} from '@erd-studio/core';
import { readFieldsFile, type FieldsReading } from '../services/fieldsService';
import type { CliContext } from './context';

/** The findings doctor adds to fields.yml's own problem codes. */
export type FieldFindingCode =
  | 'fieldValueOutsideChoices'
  | 'fieldSpelledTwice'
  | 'fieldOldSpellings'
  | 'fieldRetired'
  | 'fieldNotInList'
  | 'fieldMetaShadowsBuiltIn';

export const FIELD_FINDING_CODES: readonly FieldFindingCode[] = Object.freeze([
  'fieldValueOutsideChoices',
  'fieldSpelledTwice',
  'fieldOldSpellings',
  'fieldRetired',
  'fieldNotInList',
  'fieldMetaShadowsBuiltIn',
] as FieldFindingCode[]);

/** One finding about the field list or the tables' field values. */
export interface FieldFinding {
  /** A fields.yml problem code (`fieldsKeyReserved`, …) or a {@link FieldFindingCode}. */
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Project-relative, forward slashes: fields.yml for its problems, the table file for a table's finding. */
  file?: string;
  /** 1-based, for a fields.yml problem at a line. */
  line?: number;
  /** The table it is about (the example table, for an aggregated finding). */
  table?: string;
  /** The column it is about, for a column's finding. */
  column?: string;
  /** The field key it is about (the example key, for an aggregated finding). */
  key?: string;
  /** For an aggregated finding: how many (tables, or settings for `fieldOldSpellings`). */
  count?: number;
  /** fields.yml holds unresolved git conflict markers (doctor's `resolve-merge-conflicts`, never `fix-fields-file`). */
  mergeConflict?: true;
}

/** `erd.fields`: the field list doctor read, and every finding. */
export interface FieldsSummary {
  /** fields.yml, project-relative, when the file exists; null without one. */
  file: string | null;
  /** `file` when fields.yml gave the list; `starting-set` without one, or when it could not be read. */
  source: 'file' | 'starting-set';
  /** The table field keys, in display order. */
  tables: string[];
  /** The column field keys, in display order. */
  columns: string[];
  /** The dbt meta keys the list never copies. */
  leftOut: string[];
  problems: FieldFinding[];
}

/** One table, as the findings read it. */
export interface FieldTableInput {
  name: string;
  /** The table file, project-relative, forward slashes. */
  file: string;
  table: SemanticTable;
  /** The DBML reader's spellings (DBML tables only). */
  spellings?: readonly DbmlFieldSpelling[];
  /** Problems the DBML reader raised about fields: reported here, never as DBML problems. */
  readerProblems?: ReadonlyArray<{ code?: string; line?: number; message: string }>;
}

/** Whether a DBML reader problem code is a field one (`field…`), which belongs here and never in `dbmlProblems`. */
export function isFieldProblemCode(code: unknown): boolean {
  return typeof code === 'string' && /^field/.test(code);
}

/** The block for a project with no `.erd-studio` (or nothing to read): the starting set, nothing found. */
export function startingSetSummary(): FieldsSummary {
  return {
    file: null,
    source: 'starting-set',
    tables: STARTING_FIELD_LIST.tables.map((d) => d.key),
    columns: STARTING_FIELD_LIST.columns.map((d) => d.key),
    leftOut: [],
    problems: [],
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `a`, `a or b`, `a, b or c`, or the first three and "or N more". */
function orList(items: string[], shown = 3): string {
  if (items.length <= 1) return items.join('');
  if (items.length <= shown + 1) return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
  return `${items.slice(0, shown).join(', ')} or ${items.length - shown} more`;
}

/** A value as a message shows it: text as it is, anything else as JSON. */
function valueText(value: MetaValue | undefined): string {
  if (typeof value === 'string') return value === '' ? "''" : value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A field's options, as a message lists them. */
function optionsText(row: FieldRow): string {
  if (row.definition.type === 'yes-no') return 'true or false';
  const values = Array.isArray(row.definition.values) ? row.definition.values : [];
  return values.join(', ');
}

/**
 * Whether a `meta` key is named like a built-in field of its scope kept
 * somewhere else (`meta.purpose`) or a reserved setting (`meta.note`): it
 * stays metadata and shows as `<key> (metadata)` (spec A2).
 */
function shadowsBuiltIn(key: string, scope: FieldScope): boolean {
  const builtin = builtInField(key, scope);
  return isReservedFieldKey(key, scope) || (builtin !== undefined && builtin.home.kind !== 'meta');
}

function isMetaRow(row: FieldRow): boolean {
  return (row.definition.home as { kind?: unknown } | undefined)?.kind === 'meta';
}

/** The setting name a spelling stands for, as a message names it. */
function spellingName(s: DbmlFieldSpelling): string {
  const named = s.name;
  if (typeof named === 'string' && named !== '') return s.spelling === 'json' ? `${named}'s ${s.key}` : named;
  switch (s.spelling) {
    case 'bare': return s.key;
    case 'rationale': return `rationale_${s.key}`;
    case 'meta': return `meta_${s.key}`;
    case 'json': return `meta_json's ${s.key}`;
    default: return `an erd_ spelling of ${s.key}`;
  }
}

/** The setting an old spelling is counted under (`rationale_purpose`, `meta_owner`, `meta_json`). */
function oldSpellingName(s: DbmlFieldSpelling): string {
  const named = s.name;
  if (typeof named === 'string' && named !== '') return named;
  if (s.spelling === 'json') return 'meta_json';
  return s.spelling === 'rationale' ? `rationale_${s.key}` : `meta_${s.key}`;
}

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/**
 * The `erd.fields` block from a reading of fields.yml and the project's
 * tables. Pure: `fieldsFile` is fields.yml's project-relative path.
 */
export function summariseFields(reading: FieldsReading, fieldsFile: string, tables: readonly FieldTableInput[]): FieldsSummary {
  const usable = reading.exists && !reading.problems.some((p) => p.code === 'fieldsYamlInvalid');
  const list: FieldList = reading.list;
  const problems: FieldFinding[] = [];

  // ── fields.yml's own problems, in file order ───────────────────────────
  for (const p of reading.problems as readonly FieldsFileProblem[]) {
    problems.push({
      code: p.code,
      severity: p.severity,
      message: p.message,
      file: fieldsFile,
      ...(p.line !== undefined ? { line: p.line } : {}),
      ...(p.key !== undefined ? { key: p.key } : {}),
      ...(p.mergeConflict ? { mergeConflict: true as const } : {}),
    });
  }

  // A field problem the DBML reader raised (none today): here, never in dbmlProblems.
  for (const t of tables) {
    for (const p of t.readerProblems ?? []) {
      problems.push({
        code: p.code ?? 'fieldWarning', severity: 'warning', message: p.message, file: t.file, table: t.name,
        ...(p.line !== undefined ? { line: p.line } : {}),
      });
    }
  }

  const listOwner = usable ? 'fields.yml allows' : undefined;
  const outside: FieldFinding[] = [];
  const twice: FieldFinding[] = [];
  const old = { count: 0, tables: [] as string[], names: new Map<string, number>(), example: undefined as { table: string; file: string; key: string } | undefined };
  const retired = { tables: [] as string[], labels: [] as string[], keys: [] as string[], file: undefined as string | undefined };
  const notInList = { tables: [] as string[], keys: [] as string[], file: undefined as string | undefined };
  const shadows = { tables: [] as string[], keys: [] as string[], reserved: 0, file: undefined as string | undefined };
  const leftOut = new Set(list.leftOut);

  for (const t of tables) {
    const tableRows = safe(() => resolveTableFields(t.table, list), [] as FieldRow[]);
    const columns: ColumnDef[] = Array.isArray(t.table.columns) ? t.table.columns : [];
    const columnRows = columns.map((c) => ({
      column: c,
      rows: safe(() => resolveColumnFields(c, t.table, list), [] as FieldRow[]),
    }));
    const owners: Array<{ column?: string; scope: FieldScope; rows: FieldRow[] }> = [
      { scope: 'table', rows: tableRows },
      ...columnRows.map((c) => ({ column: typeof c.column?.name === 'string' ? c.column.name : undefined, scope: 'column' as const, rows: c.rows })),
    ];

    let retiredHere = false;
    let notListedHere = false;
    let shadowHere = false;
    for (const { column, scope, rows } of owners) {
      const where = column !== undefined ? `${t.name}.${column}` : t.name;
      for (const row of rows) {
        // A choice or yes-no value that is not one of its options. The role is the canvas's own dropdown.
        if (row.outsideChoices && row.id !== 'role') {
          outside.push({
            code: 'fieldValueOutsideChoices', severity: 'warning', file: t.file, table: t.name,
            ...(column !== undefined ? { column } : {}), key: row.definition.key,
            message: `${where}: ${row.definition.key} is ${valueText(row.value)}; ${listOwner ?? `${row.definition.label} allows`} ${optionsText(row)}.`,
          });
        }
        if (scope === 'table' && row.source === 'retired' && row.value !== undefined) {
          retiredHere = true;
          if (!retired.keys.includes(row.definition.key)) {
            retired.keys.push(row.definition.key);
            retired.labels.push(row.definition.label);
          }
        }
        const shadow = isMetaRow(row) && shadowsBuiltIn(row.definition.key, scope);
        if (shadow && row.value !== undefined) {
          shadowHere = true;
          if (!shadows.keys.includes(row.definition.key)) {
            shadows.keys.push(row.definition.key);
            if (isReservedFieldKey(row.definition.key, scope)) shadows.reserved++;
          }
        }
        if (usable && row.source === 'notInList' && row.value !== undefined && !shadow
          && !(isMetaRow(row) && leftOut.has(row.definition.key))) {
          notListedHere = true;
          if (!notInList.keys.includes(row.definition.key)) notInList.keys.push(row.definition.key);
        }
      }
    }
    if (retiredHere) { retired.tables.push(t.name); retired.file ??= t.file; }
    if (notListedHere) { notInList.tables.push(t.name); notInList.file ??= t.file; }
    if (shadowHere) { shadows.tables.push(t.name); shadows.file ??= t.file; }

    // ── DBML spellings ────────────────────────────────────────────────────
    const spellings = t.spellings ?? [];
    const groups = new Map<string, DbmlFieldSpelling[]>();
    let oldHere = false;
    for (const s of spellings) {
      const id = `${s.owner}\u0000${s.home}\u0000${s.key}`;
      groups.set(id, [...(groups.get(id) ?? []), s]);
      if (s.old === true) {
        oldHere = true;
        old.count++;
        const name = oldSpellingName(s);
        old.names.set(name, (old.names.get(name) ?? 0) + 1);
        old.example ??= { table: t.name, file: t.file, key: s.key };
      }
    }
    if (oldHere) old.tables.push(t.name);
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const { owner, key } = group[0];
      const where = owner !== '' ? `${t.name}.${owner}` : t.name;
      const names = group.map(spellingName);
      const used = group.find((s) => s.used);
      const others = group.length === 2 ? 'the other' : 'the others';
      twice.push({
        code: 'fieldSpelledTwice', severity: 'warning', file: t.file, table: t.name,
        ...(owner !== '' ? { column: owner } : {}), key,
        message: `${where} has ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}; `
          + (used ? `${spellingName(used)} is used. Remove ${others}.` : `none of them has a value. Keep one and remove ${others}.`),
      });
    }
  }

  problems.push(...outside, ...twice);

  if (old.count > 0 && old.example) {
    const names = [...old.names.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const n = old.tables.length;
    problems.push({
      code: 'fieldOldSpellings', severity: 'info', file: old.example.file, table: old.example.table, key: old.example.key, count: old.count,
      message: `${plural(n, 'table')} still ${n === 1 ? 'says' : 'say'} ${orList(names)} (${plural(old.count, 'old spelling')}). `
        + 'They read as the same fields. Ask your assistant to rename them.',
    });
  }
  if (retired.tables.length > 0) {
    const n = retired.tables.length;
    problems.push({
      code: 'fieldRetired', severity: 'info', ...(retired.file ? { file: retired.file } : {}), table: retired.tables[0], key: retired.keys[0], count: n,
      message: `${plural(n, 'table')} still ${n === 1 ? 'has' : 'have'} ${orList(retired.labels)}. `
        + `Ask your assistant to move ${retired.labels.length === 1 ? 'it' : 'them'} into Decisions.`,
    });
  }
  if (notInList.tables.length > 0) {
    const n = notInList.tables.length;
    problems.push({
      code: 'fieldNotInList', severity: 'info', ...(notInList.file ? { file: notInList.file } : {}), table: notInList.tables[0], key: notInList.keys[0], count: n,
      message: `${plural(n, 'table')} ${n === 1 ? 'has' : 'have'} ${orList(notInList.keys, 6)}, which fields.yml does not list. `
        + `The canvas shows ${notInList.keys.length === 1 ? 'it' : 'them'} under "Not in your list".`,
    });
  }
  if (shadows.tables.length > 0) {
    const n = shadows.tables.length;
    const key = shadows.keys[0];
    problems.push({
      code: 'fieldMetaShadowsBuiltIn', severity: 'info', ...(shadows.file ? { file: shadows.file } : {}), table: shadows.tables[0], key, count: n,
      message: `${plural(n, 'table')} ${n === 1 ? 'has' : 'have'} metadata named ${orList(shadows.keys)}, `
        + (shadows.reserved === 0
          ? `the name of a built-in field. It stays metadata, shown as "${key} (metadata)", apart from the built-in.`
          : shadows.reserved === shadows.keys.length
            ? `a name DBML or ERD Studio reserves. It stays metadata, shown as "${key} (metadata)".`
            : `the name of a built-in field or a reserved setting. It stays metadata, shown as "${key} (metadata)".`),
    });
  }

  return {
    file: reading.exists ? fieldsFile : null,
    source: usable ? 'file' : 'starting-set',
    tables: list.tables.map((d) => d.key),
    columns: list.columns.map((d) => d.key),
    leftOut: [...list.leftOut],
    problems,
  };
}

/**
 * The `erd.fields` block of a project: fields.yml read once (uncached), and
 * every library table that reads. `dbmlReadings` are the DBML table
 * readings `collectDbmlProblems` already made, by absolute path, so
 * no table file is parsed twice; a table not among them is read through the
 * table library.
 */
export function collectFieldsSummary(ctx: CliContext, dbmlReadings: ReadonlyMap<string, DbmlTableReading> = new Map()): FieldsSummary {
  const semanticRoot = path.join(ctx.root, ctx.semanticDir);
  const fieldsFile = `${ctx.semanticDir.replace(/\\/g, '/').replace(/\/+$/, '')}/${FIELDS_FILE_NAME}`;
  const reading = readFieldsFile(semanticRoot);
  const rel = (abs: string): string => path.relative(ctx.root, abs).split(path.sep).join('/');
  const tables: FieldTableInput[] = [];
  const entries = safe(() => ctx.tableLibraryService.listTableFiles(), []);
  for (const entry of entries) {
    if (entry.shadowedBy) continue;
    const file = rel(entry.filePath);
    const dbml = dbmlReadings.get(path.resolve(entry.filePath));
    if (dbml) {
      if (!dbml.ok) continue;
      const readerProblems = dbml.problems
        .filter((p) => isFieldProblemCode(p.code))
        .map((p) => ({ code: String(p.code), message: p.message, ...(p.line !== undefined ? { line: p.line } : {}) }));
      tables.push({
        name: dbml.table.name, file, table: dbml.table,
        ...(dbml.fieldSpellings ? { spellings: dbml.fieldSpellings } : {}),
        ...(readerProblems.length > 0 ? { readerProblems } : {}),
      });
      continue;
    }
    const table = safe(() => ctx.tableLibraryService.getTable(entry.name), null);
    if (table) tables.push({ name: table.name, file, table });
  }
  return summariseFields(reading, fieldsFile, tables);
}
