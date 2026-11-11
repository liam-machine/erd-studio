/**
 * Generated tests for the catalog export reader (`catalogCsvImport.ts`):
 * a generated schema written as a catalog query's CSV, one row per column
 * (a row per foreign key a column is in), in either key shape (the shipped
 * queries' `is_primary_key` / `fk_*` columns, or the constraint-join shape),
 * with the knobs real exports vary: delimiter, header case and spelling,
 * quoting every cell, CRLF, a BOM, rows in any order, NULL written out.
 *
 * Every such file: never throws; every table and column is imported, or
 * (a name over the length limit) reported with its line; every foreign key
 * between imported tables is drawn, and one to a table left out is said;
 * the DBML always reads back with nothing left out by the check; Import
 * DBML's flow draws the draft; no shown string echoes more than a short
 * snippet of the file.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MAX_CATALOG_NAME_CHARS, catalogCsvToDbml, catalogOriginPhrase } from '../../../src/services/catalogCsvImport';
import { readsAsDbml } from '../../../src/services/sqlImportEngine';
import { importDbmlFlow } from '../realWorldScorecard';
import { echoViolations, ledgerStrings } from './invariants';
import { params, runs, schemaArb, timeout, type GSchema } from './schemaArbitraries';

interface CsvStyle {
  delimiter: ',' | '\t' | ';';
  upper: boolean;
  quoteAll: boolean;
  crlf: boolean;
  bom: boolean;
  shape: 'flags' | 'constraints';
  nullText: '' | 'NULL' | 'null';
  shuffle: number[];
}

const styleArb: fc.Arbitrary<CsvStyle> = fc.record({
  delimiter: fc.constantFrom<CsvStyle['delimiter']>(',', '\t', ';'),
  upper: fc.boolean(),
  quoteAll: fc.boolean(),
  crlf: fc.boolean(),
  bom: fc.boolean(),
  shape: fc.constantFrom<CsvStyle['shape']>('flags', 'constraints'),
  nullText: fc.constantFrom<CsvStyle['nullText']>('', 'NULL', 'null'),
  shuffle: fc.array(fc.nat(), { maxLength: 40 }),
});

const TYPES: Record<string, string> = { int: 'integer', bigint: 'bigint', text: 'text', varchar: 'varchar(100)', decimal: 'decimal(12,2)', timestamp: 'timestamp', date: 'date', boolean: 'boolean' };

/** The schema as a catalog export in `style`. */
function writeCatalogCsv(schema: GSchema, style: CsvStyle): string {
  const head = style.shape === 'flags'
    ? ['table_schema', 'table_name', 'column_name', 'ordinal_position', 'data_type', 'is_nullable', 'column_comment', 'table_comment', 'is_primary_key', 'pk_ordinal', 'is_unique', 'fk_constraint_name', 'fk_ordinal', 'fk_table_schema', 'fk_table', 'fk_column']
    : ['table_schema', 'table_name', 'column_name', 'ordinal_position', 'data_type', 'is_nullable', 'column_comment', 'table_comment', 'constraint_name', 'constraint_type', 'referenced_table_schema', 'referenced_table_name', 'referenced_column_name'];
  const rows: Array<Array<string | null>> = [];
  schema.tables.forEach((t, ti) => {
    t.columns.forEach((c, ci) => {
      const base = ['gen', t.name, c.name, String(ci + 1), TYPES[c.type], c.notNull ? 'NO' : 'YES', c.comment ?? null, t.comment ?? null];
      const fks = t.fks.flatMap((fk, fi) => fk.columns.map((col, k) => ({ col, k, fi, fk }))).filter((x) => x.col === c.name);
      if (style.shape === 'flags') {
        const pk = t.pk.indexOf(c.name);
        const flags = [pk >= 0 ? 'YES' : 'NO', pk >= 0 ? String(pk + 1) : null, c.unique ? 'YES' : 'NO'];
        if (fks.length === 0) rows.push([...base, ...flags, null, null, null, null, null]);
        for (const x of fks) rows.push([...base, ...flags, `fk_${ti}_${x.fi}`, String(x.k + 1), 'gen', x.fk.table, x.fk.references[x.k]]);
      } else {
        const joined: Array<Array<string | null>> = [];
        if (t.pk.includes(c.name)) joined.push([`pk_${ti}`, 'PRIMARY KEY', null, null, null]);
        if (c.unique) joined.push([`uq_${ti}_${ci}`, 'UNIQUE', null, null, null]);
        for (const x of fks) joined.push([`fk_${ti}_${x.fi}`, 'FOREIGN KEY', 'gen', x.fk.table, x.fk.references[x.k]]);
        if (joined.length === 0) joined.push([null, null, null, null, null]);
        for (const j of joined) rows.push([...base, ...j]);
      }
    });
  });
  // Rows in any order: the reader orders columns by ordinal_position.
  for (const [i, n] of style.shuffle.entries()) {
    const a = i % rows.length;
    const b = n % rows.length;
    [rows[a], rows[b]] = [rows[b], rows[a]];
  }
  const d = style.delimiter;
  const cell = (v: string | null): string => {
    if (v === null) return style.nullText;
    return style.quoteAll || v.includes(d) || /["\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const eol = style.crlf ? '\r\n' : '\n';
  const lines = [head.map((h) => (style.upper ? h.toUpperCase() : h)).join(d), ...rows.map((r) => r.map(cell).join(d))];
  return `${style.bom ? '﻿' : ''}${lines.join(eol)}${eol}`;
}

describe('generated catalog exports', () => {
  it('every table, column and foreign key comes in, or is reported; the DBML reads; the draft is drawn', () => {
    fc.assert(fc.property(schemaArb({ maxTables: 5, maxColumns: 5 }), styleArb, (schema, style) => {
      // A tab-separated file reads backslash escapes; the generated names and comments hold none.
      const text = writeCatalogCsv(schema, style);
      const where = `${JSON.stringify(style)}\n${text.slice(0, 3000)}`;
      const result = catalogCsvToDbml([{ name: 'gen.csv', text }], readsAsDbml);
      const long = (n: string): boolean => n.length > MAX_CATALOG_NAME_CHARS;
      // A table comes in when its name and at least one of its columns' names are short enough.
      const kept = schema.tables.filter((t) => !long(t.name) && t.columns.some((c) => !long(c.name)));
      const keptNames = new Set(kept.map((t) => t.name));
      if (kept.length === 0) {
        expect(result.ok, where).toBe(false);
        return;
      }
      if (!result.ok) throw new Error(`${where}\n${JSON.stringify(result.problems)}`);
      expect(result.ledger.filter((e) => e.cause === 'parseError'), where).toEqual([]);
      expect(result.tableCount, where).toBe(kept.length);
      expect(result.columnCount, where).toBe(kept.reduce((n, t) => n + t.columns.filter((c) => !long(c.name)).length, 0));
      // Every name left out is reported, at its line.
      const shortNamed = schema.tables.filter((t) => !long(t.name));
      const leftOut = schema.tables.length - shortNamed.length
        + shortNamed.reduce((n, t) => n + t.columns.filter((c) => long(c.name)).length, 0)
        + shortNamed.filter((t) => t.columns.every((c) => long(c.name))).length;
      expect(result.ledger.filter((e) => e.outcome === 'problem' && e.where?.line !== undefined).length, where).toBe(leftOut);
      // Foreign keys between tables that came in, on columns that came in, are drawn; the rest are said.
      const drawable = kept.flatMap((t) => t.fks.filter((fk) => keptNames.has(fk.table) && fk.columns.every((c) => !long(c)) && fk.references.every((c) => !long(c))));
      const selfOrMutual = new Set<string>();
      let expected = 0;
      for (const t of kept) {
        for (const fk of t.fks) {
          if (!drawable.includes(fk)) continue;
          // DBML holds one link between the same columns, whichever way round (a one-to-one key-to-key cycle).
          const ends = [`${t.name}(${fk.columns})`, `${fk.table}(${fk.references})`].sort().join('|');
          if (selfOrMutual.has(ends)) continue;
          selfOrMutual.add(ends);
          expected++;
        }
      }
      expect(result.refCount, where).toBe(expected);
      const said = result.ledger.filter((e) => e.unit === 'relationship' && e.outcome === 'lost').reduce((n, e) => n + e.count, 0);
      expect(said, where).toBe(kept.reduce((n, t) => n + t.fks.length, 0) - expected);
      const run = importDbmlFlow(result.dbml, 'gen.dbml', 'sql', {
        from: catalogOriginPhrase(['gen.csv']), notes: result.notes, skipped: result.skipped, ledger: result.ledger, ...(result.notice ? { notice: result.notice } : {}),
      });
      expect(run.ok, `${where}\n${run.failureMessage}`).toBe(true);
      expect(run.tables.length, where).toBe(kept.length);
      const names = schema.tables.flatMap((t) => [t.name, ...t.columns.map((c) => c.name)]);
      const shown = [...result.notes, ...result.skipped, ...result.problems.map((p) => p.message), ...ledgerStrings(result.ledger)];
      expect(echoViolations(shown, [text], names), where).toEqual([]);
    }), params(runs(60, 0.5)));
  }, timeout(60_000));
});
