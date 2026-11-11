/**
 * The SQL Server catalog query (`test/fixtures/catalog-csv/queries/sqlserver.sql`), run on SQL Server 2022
 * by `test/fixtures/catalog-csv/sqlserver/run_sqlserver.sh` (see `sqlserver/SOURCE.md`).
 *
 * Offline: every column the query returns is one the catalog reader reads, and it counts its own rows.
 * The export (`sqlserver/probe.csv`, saved by the VS Code SQL Server extension's own writer, SqlToolsService's
 * `query/saveCsv`): the import matches the probe schema's truth exactly, also with Windows line ends; the
 * CSV holds the same cells as a lossless JSON copy of the rows; and the DDL route (SMO's script of the same
 * database, through Import SQL DDL…) is scored beside it, so a change in either route shows here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { catalogCsvToDbml, mapCatalogHeaders, readDelimited } from '../../src/services/catalogCsvImport';
import { decodeText } from '../../src/services/readFileStart';
import { convertSqlDdl } from '../../src/services/sqlDdlImport';
import { dbmlCoreSqlEngine, readsAsDbml } from '../../src/services/sqlImportEngine';
import { scoreDbml, type Truth } from './catalogCsv/sqlserverTruth';

const DIR = path.join(__dirname, '../fixtures/catalog-csv');
const QUERY = fs.readFileSync(path.join(DIR, 'queries/sqlserver.sql'), 'utf-8');
const truth = JSON.parse(fs.readFileSync(path.join(DIR, 'sqlserver/truth.json'), 'utf-8')) as Truth;
const CSV = path.join(DIR, 'sqlserver/probe.csv');
const ROWS = path.join(DIR, 'sqlserver/probe.rows.json');
const SMO = path.join(DIR, 'sqlserver/probe-smo-script.sql');

/** The select list's output names, in order (`… AS name,` at a line's end). */
const outputNames = (sql: string): string[] => [...sql.slice(0, sql.indexOf('\nFROM ')).matchAll(/\bAS (\w+),?\s*$/gm)].map((m) => m[1]);

/** Every truth count met: what the route got equals what the truth holds. */
const FULL = ['tables', 'columns', 'notNull', 'primaryKeys', 'uniqueKeys', 'foreignKeys', 'tableComments', 'columnComments', 'defaults', 'identity'] as const;

/** The CSV as SqlToolsService writes it on Windows: each record ends CRLF (line breaks inside quoted cells are data, kept). */
function withWindowsLineEnds(text: string): string {
  let out = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    out += ch === '\n' && !quoted ? '\r\n' : ch;
  }
  return out;
}

describe('the SQL Server catalog query, offline', () => {
  it('returns only columns the catalog reader reads, each as one role, and counts its own rows', () => {
    const names = outputNames(QUERY);
    expect(names).toEqual(['table_schema', 'table_name', 'table_type', 'table_comment', 'column_name', 'ordinal_position', 'data_type',
      'is_nullable', 'column_default', 'column_comment', 'is_identity', 'is_primary_key', 'pk_ordinal', 'unique_constraint_name',
      'fk_constraint_name', 'fk_ordinal', 'fk_table_schema', 'fk_table', 'fk_column', 'total_rows']);
    const roles = mapCatalogHeaders(names);
    expect(Object.keys(roles)).toHaveLength(names.length);
    expect(QUERY).toMatch(/COUNT\(\*\) OVER \(\) AS total_rows/);
  });

  it('reads unique keys over key columns only: never a filtered, disabled or hypothetical index, never an included column', () => {
    expect(QUERY).toMatch(/ic\.key_ordinal > 0 AND ic\.is_included_column = 0/);
    expect(QUERY).toMatch(/i\.has_filter = 0 AND i\.is_disabled = 0 AND i\.is_hypothetical = 0/);
  });
});

describe('the SQL Server catalog query, on SQL Server 2022 (sqlserver/probe.csv)', () => {
  const read = () => ({ name: 'probe.csv', text: decodeText(fs.readFileSync(CSV)) });

  it('imports the probe schema exactly: tables, columns, types, keys, unique keys, relationships, comments, defaults, identity', () => {
    const r = catalogCsvToDbml([read()], readsAsDbml);
    if (!r.ok) throw new Error(r.problems.map((p) => p.message).join(' | '));
    expect(r.skipped).toEqual(['1 view (table_type says so)']);
    expect(r.notes).toEqual([]);
    expect(r.coverage).toMatchObject({ rows: 63, totalRows: true, primaryKeyColumn: true, foreignKeyColumns: true, uniqueColumn: true, comments: true, types: 'whole' });
    const s = scoreDbml(r.dbml, truth);
    expect(s.typeMismatches).toEqual([]);
    expect(s.wrongUnique).toEqual([]);
    expect(s.fkMismatches).toEqual([]);
    expect(s.commentMismatches).toEqual([]);
    expect(s.defaultMismatches).toEqual([]);
    for (const k of FULL) expect(s[k][0], k).toBe(s[k][1]);
    expect(s.typesExact).toEqual([60, 60]);
    expect(s.uniqueKeys).toEqual([6, 6]);
    expect(s.foreignKeys).toEqual([14, 14]);
    expect(s.viewsImported).toBe(0);
    // SSMS's diagram table is not the design, and the computed column comes with the type SQL Server gives it.
    expect(r.dbml).not.toMatch(/sysdiagrams/);
    expect(r.dbml).toMatch(/"line_total" decimal\(29,4\)/);
    // The composite foreign key whose columns sit the other way round in the table pairs by key position.
    expect(r.dbml).toContain('Ref: "sales"."shipment_line".("ord_id", "ln_no") > "sales"."order_line".("order_id", "line_no")');
  });

  it('reads the same with Windows line ends (the writer ends records with the platform\'s line break)', () => {
    const lf = catalogCsvToDbml([read()], readsAsDbml);
    const crlf = catalogCsvToDbml([{ name: 'probe.csv', text: withWindowsLineEnds(read().text) }], readsAsDbml);
    if (!lf.ok || !crlf.ok) throw new Error('did not import');
    expect(crlf.dbml).toBe(lf.dbml);
  });

  it('the CSV holds the same cells as the lossless JSON copy (the writer\'s quoting round-trips commas, quotes and line breaks)', () => {
    const rows = JSON.parse(fs.readFileSync(ROWS, 'utf-8')) as Array<Record<string, string | number | null>>;
    const csv = readDelimited(read().text);
    expect(csv.ragged).toBe(0);
    expect(csv.unterminatedQuote).toBe(false);
    expect(csv.rows).toHaveLength(rows.length);
    // The writer spells a database NULL as the text NULL.
    const asCell = (v: string | number | null): string => (v === null ? 'NULL' : String(v));
    const key = (cells: string[]): string => JSON.stringify(cells);
    const fromJson = new Set(rows.map((o) => key(csv.header.map((h) => asCell(o[h] ?? null)))));
    for (const row of csv.rows) expect(fromJson.has(key(row)), key(row)).toBe(true);
  });

  it('the DDL route, on SMO\'s script of the same database, scored beside it', () => {
    const r = convertSqlDdl({ dialect: 'sqlserver', files: [{ name: 'probe-smo-script.sql', text: decodeText(fs.readFileSync(SMO)) }] }, dbmlCoreSqlEngine, readsAsDbml);
    if (!r.ok) throw new Error(JSON.stringify(r.problems));
    const s = scoreDbml(r.dbml, truth);
    // Everything the truth holds, but for two things the catalog route gets right:
    for (const k of FULL) expect(s[k][0], k).toBe(s[k][1]);
    expect(s.fkMismatches).toEqual([]);
    expect(s.commentMismatches).toEqual([]);
    expect(s.defaultMismatches).toEqual([]);
    expect(s.viewsImported).toBe(0);
    // a computed column has no type in a script (its expression is not imported either),
    expect(s.typeMismatches).toEqual(['order_line.line_total: computed (truth decimal(29,4))']);
    // and SSMS's diagram table is a table like any other there.
    expect(s.wrongUnique).toEqual(['dbo.sysdiagrams(principal_id, name)']);
    expect(r.dbml).toMatch(/Table "dbo"\."sysdiagrams"/);
    // What only the script keeps: a CHECK constraint.
    expect(r.dbml).toContain('`([quantity]>(0))` [name: \'order_line_quantity_ck\']');
  });
});
