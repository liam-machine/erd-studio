/**
 * The SQL Server catalog query (`test/fixtures/catalog-csv/queries/sqlserver.sql`). NOT YET RUN on SQL Server:
 * `test/fixtures/catalog-csv/sqlserver/run_sqlserver.sh` runs it in Docker and writes the export these tests
 * read. Until that export exists only the offline checks run, and the query stays out of the import guide.
 *
 * Offline: every column the query returns is one the catalog reader reads, and it counts its own rows.
 * Live (`sqlserver/probe.csv`, saved by the VS Code mssql extension's writer): the import matches the
 * probe schema's truth exactly; the CSV holds the same cells as a lossless JSON copy of the rows; and the
 * DDL route (an SMO script of the same schema) is scored beside it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { catalogCsvToDbml, mapCatalogHeaders, readDelimited } from '../../src/services/catalogCsvImport';
import { convertSqlDdl } from '../../src/services/sqlDdlImport';
import { dbmlCoreSqlEngine, readsAsDbml } from '../../src/services/sqlImportEngine';
import { scoreDbml, type Truth } from './catalogCsv/sqlserverTruth';

const DIR = path.join(__dirname, '../fixtures/catalog-csv');
const QUERY = fs.readFileSync(path.join(DIR, 'queries/sqlserver.sql'), 'utf-8');
const truth = JSON.parse(fs.readFileSync(path.join(DIR, 'sqlserver/truth.json'), 'utf-8')) as Truth;
const CSV = path.join(DIR, 'sqlserver/probe.csv');
const ROWS = path.join(DIR, 'sqlserver/probe.rows.json');
const SMO = path.join(DIR, 'sqlserver/probe-smo-script.sql');
const live = fs.existsSync(CSV) && fs.existsSync(path.join(DIR, 'sqlserver/SOURCE.md'));

/** The select list's output names, in order (`… AS name,` at a line's end). */
const outputNames = (sql: string): string[] => [...sql.slice(0, sql.indexOf('\nFROM ')).matchAll(/\bAS (\w+),?\s*$/gm)].map((m) => m[1]);

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

describe.skipIf(!live)('the SQL Server catalog query, live (run_sqlserver.sh)', () => {
  const read = () => ({ name: 'probe.csv', text: fs.readFileSync(CSV, 'utf-8') });

  it('imports the probe schema exactly: tables, columns, types, keys, unique keys, relationships, comments, defaults, identity', () => {
    const r = catalogCsvToDbml([read()], readsAsDbml);
    if (!r.ok) throw new Error(r.problems.map((p) => p.message).join(' | '));
    expect(r.skipped).toEqual(['1 view (table_type says so)']);
    expect(r.notes).toEqual([]);
    expect(r.coverage).toMatchObject({ totalRows: true, primaryKeyColumn: true, foreignKeyColumns: true, uniqueColumn: true, comments: true, types: 'whole' });
    const s = scoreDbml(r.dbml, truth);
    expect(s.typeMismatches).toEqual([]);
    expect(s.wrongUnique).toEqual([]);
    expect(s.fkMismatches).toEqual([]);
    expect(s.commentMismatches).toEqual([]);
    expect(s.defaultMismatches).toEqual([]);
    for (const k of ['tables', 'columns', 'notNull', 'primaryKeys', 'uniqueKeys', 'foreignKeys', 'tableComments', 'columnComments', 'defaults', 'identity'] as const) {
      expect(s[k][0], k).toBe(s[k][1]);
    }
    expect(s.viewsImported).toBe(0);
  });

  it('the CSV holds the same cells as the lossless JSON copy (the writer\'s quoting round-trips commas, quotes and line breaks)', () => {
    const rows = JSON.parse(fs.readFileSync(ROWS, 'utf-8')) as Array<Record<string, string | number | null>>;
    const csv = readDelimited(read().text);
    expect(csv.ragged).toBe(0);
    expect(csv.rows).toHaveLength(rows.length);
    const asCell = (v: string | number | null): string => (v === null ? 'NULL' : String(v));
    const key = (cells: string[]): string => JSON.stringify(cells);
    const fromJson = new Set(rows.map((o) => key(csv.header.map((h) => asCell(o[h] ?? null)))));
    for (const row of csv.rows) expect(fromJson.has(key(row)), key(row)).toBe(true);
  });

  it.skipIf(!fs.existsSync(SMO))('the DDL route, on SMO\'s script of the same schema, scored beside it', () => {
    const r = convertSqlDdl({ dialect: 'sqlserver', files: [{ name: 'probe-smo-script.sql', text: fs.readFileSync(SMO, 'utf-8') }] }, dbmlCoreSqlEngine, readsAsDbml);
    if (!r.ok) throw new Error(JSON.stringify(r.problems));
    const s = scoreDbml(r.dbml, truth);
    // What the DDL route loses or keeps is recorded, not required: the comparison is the point.
    console.log(JSON.stringify({ ddlRoute: s }, null, 2));
    expect(s.tables[0]).toBe(s.tables[1]);
  });
});
