/**
 * The catalog exports real engines wrote (`test/fixtures/catalog-csv/`, see
 * its README: a live Databricks Unity Catalog download, and the shipped
 * queries run on PostgreSQL 18, MySQL 8.0 and DuckDB), through the catalog
 * reader and Import DBML's own flow. Pagila and Sakila are scored against
 * the real-world truth the SQL DDL route is scored against.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { catalogCsvToDbml, catalogOriginPhrase, type CatalogCsvResult } from '../../src/services/catalogCsvImport';
import { readDbml } from '../../src/services/dbmlImportParse';
import { readsAsDbml } from '../../src/services/sqlImportEngine';
import { importDbmlFlow, loadTruth, scoreSample } from './realWorldScorecard';

const DIR = path.join(__dirname, '../fixtures/catalog-csv');
const read = (rel: string): { name: string; text: string } => ({ name: path.basename(rel), text: fs.readFileSync(path.join(DIR, rel), 'utf-8') });

type Ok = Extract<CatalogCsvResult, { ok: true }>;
function convert(rel: string): Ok {
  const r = catalogCsvToDbml([read(rel)], readsAsDbml);
  if (!r.ok) throw new Error(`${rel}: ${r.problems.map((p) => p.message).join(' | ')}`);
  expect(readDbml(r.dbml).ok).toBe(true);
  // The check never had to leave anything out: the writer's output reads as written.
  expect(r.ledger.filter((e) => e.cause === 'parseError')).toEqual([]);
  return r;
}
function flow(rel: string, r: Ok) {
  return importDbmlFlow(r.dbml, path.basename(rel).replace(/\.\w+$/, '.dbml'), 'sql', {
    from: catalogOriginPhrase([path.basename(rel)]), notes: r.notes, skipped: r.skipped, ledger: r.ledger, ...(r.notice ? { notice: r.notice } : {}),
  });
}

describe('Databricks Unity Catalog: the live download', () => {
  const r = convert('databricks/probe.csv');

  it('12 tables, 41 columns, 9 relationships; the view is skipped and said', () => {
    expect([r.tableCount, r.columnCount, r.refCount]).toEqual([12, 41, 9]);
    expect(r.skipped).toEqual(['1 view (table_type says so)']);
    expect(r.dbml).not.toContain('v_order_totals');
    expect(r.problems).toEqual([]);
  });

  it('whole types as Unity Catalog writes them, with no note that sizes are missing (decision 5)', () => {
    expect(r.dbml).toContain('"currency_code" varchar(3) [pk]');
    expect(r.dbml).toContain('"c_decimal" decimal(18,4)');
    expect(r.dbml).toContain('"c_struct" "struct<a:int,b:array<string>>"');
    expect(r.notes).toEqual([]);
    expect(r.notice).toBeUndefined();
  });

  it('0-based ordinals keep the column order; a composite primary key; a composite foreign key paired by fk_ordinal; a column in two foreign keys', () => {
    const line = r.dbml.slice(r.dbml.indexOf('Table "probe_sales"."order_line" {'));
    expect(line.indexOf('"order_id"')).toBeLessThan(line.indexOf('"line_no"'));
    expect(line).toContain('("order_id", "line_no") [pk]');
    expect(r.dbml).toContain('Ref: "probe_sales"."order_line_note".("ord_id", "ln_no") > "probe_sales"."order_line".("order_id", "line_no")');
    expect(r.dbml).toContain('Ref: "probe_sales"."order_line_note"."ord_id" > "probe_sales"."orders"."order_id"');
    expect(r.dbml).toContain('Ref: "probe_ref"."employee"."manager_id" > "probe_ref"."employee"."employee_id"');
  });

  it('comments come in exactly: commas, doubled quotes, apostrophes, backslashes, line breaks', () => {
    const run = flow('databricks/probe.csv', r);
    const customer = run.tables.find((t) => t.name === 'customer')!;
    expect(customer.description).toBe('Customer, "master" table - it\'s got a back\\slash\nand a newline');
    expect(customer.columns.find((c) => c.name === 'CustomerKey')?.description).toBe('Comma, "double" it\'s back\\slash\nsecond line');
    expect(customer.columns.find((c) => c.name === 'customer_name')?.description).toBe('Name, "quoted" - O\'Brien \\ C:\\temp\nline two');
    expect(run.tables).toHaveLength(12);
    expect(run.relationships.length).toBeGreaterThanOrEqual(9);
  });
});

describe('the shipped queries on PostgreSQL 18, MySQL 8.0 and DuckDB', () => {
  for (const rel of ['postgres/probe.csv', 'mysql/probe.tsv', 'duckdb/probe.csv']) {
    it(`${rel}: every table, key, relationship and comment of the probe schema; total_rows checked`, () => {
      const r = convert(rel);
      expect(r.coverage).toMatchObject({ totalRows: true, primaryKeyColumn: true, foreignKeyColumns: true, tableType: true });
      expect(r.tableCount).toBe(12);
      expect(r.columnCount).toBe(49);
      expect(r.skipped).toEqual(['1 view (table_type says so)']);
      expect(r.notes).toEqual([]);
      expect(r.dbml).toMatch(/"ord_id", "ln_no"\) > "sales"\."order_line"\.\("order_id", "line_no"\)/);
      expect(r.dbml).toMatch(/"email" [^\n]*\[unique, note: 'Login email, lower-cased'\]/);
      expect(r.dbml).toContain('Note: \'\'\'Customers, the "golden" record.\nOne row per person; it\'s deduplicated\'\'\'');
      // A reserved word as a column name, with its comment (DuckDB writes its types upper case).
      expect(r.dbml).toMatch(/"order" (integer|int) \[note: 'Sort order \(reserved word\)'\]/i);
      // A cross-schema foreign key (DuckDB keeps its foreign keys within one schema).
      if (!rel.startsWith('duckdb')) expect(r.dbml).toContain('Ref: "sales"."customer"."country_code" > "ref"."country"."country_code"');
      expect(r.refCount).toBe(rel.startsWith('duckdb') ? 10 : 12);
    });
  }

  it('a copy cut short is refused by its own total_rows', () => {
    for (const rel of ['postgres/probe.csv', 'mysql/probe.tsv', 'duckdb/probe.csv']) {
      const { name, text } = read(rel);
      const cut = text.split('\n').slice(0, 20).join('\n') + '\n';
      const r = catalogCsvToDbml([{ name, text: cut }]);
      expect(!r.ok && r.reason, rel).toBe('truncated');
    }
  });

  it('MySQL\'s tab-separated output: NULL, \\n in a comment and a bare literal default read as written', () => {
    const r = convert('mysql/probe.tsv');
    expect(r.coverage.delimiter).toBe('\t');
    expect(r.dbml).toContain("\"country_code\" char(2) [not null, default: 'AU']");
    expect(r.dbml).toContain('"customer_id" int [pk, increment]');
  });
});

describe('Pagila and Sakila: real exports scored against the real-world truth', () => {
  const truth = loadTruth();

  it('Pagila (PostgreSQL 18): partitions come in as their parent, their foreign keys on it; nothing extra', () => {
    const r = convert('postgres/pagila.csv');
    expect([r.tableCount, r.columnCount, r.refCount]).toEqual([16, 94, 22]);
    const score = scoreSample('postgres-pagila', truth.samples['postgres-pagila'], flow('postgres/pagila.csv', r));
    expect(score.tables).toMatchObject({ matched: 16, source: 16, extra: [] });
    expect(score.columns).toMatchObject({ matched: 94, source: 94 });
    expect(score.primaryKeys).toMatchObject({ matched: 16, source: 16 });
    expect(score.relationships).toMatchObject({ matched: 22, source: 22, extra: [] });
    expect(score.uniqueKeys.kept).toBe(score.uniqueKeys.source);
    expect(score.silentLosses.total).toBe(0);
    expect(score.verdict).toBe('Clean');
  });

  it('Sakila (MySQL 8.0): every table, key and relationship', () => {
    const r = convert('mysql/sakila.tsv');
    expect([r.tableCount, r.columnCount, r.refCount]).toEqual([16, 90, 22]);
    const score = scoreSample('mysql-sakila', truth.samples['mysql-sakila'], flow('mysql/sakila.tsv', r));
    expect(score.tables).toMatchObject({ matched: 16, source: 16, extra: [] });
    expect(score.relationships).toMatchObject({ matched: 22, source: 22, extra: [] });
    expect(score.primaryKeys).toMatchObject({ matched: 16, source: 16 });
    expect(score.verdict).toBe('Clean');
  });
});
