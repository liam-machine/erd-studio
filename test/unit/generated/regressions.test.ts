/**
 * Counterexamples the generated tests found, kept as fixed regression tests
 * (each shrunk by fast-check, then written out by hand). The fix for each is
 * general, not for this input: see the comment on each.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { sqlDdlToDbml } from '../../../src/services/sqlImportEngine';
import { ledgerLeftOut } from '../../../src/services/importLedger';
import { readSemanticModel, semanticModelToDbml } from '../../../src/services/semanticModelImport';
import { roundTripDbml } from './dbmlRoundTrip';

const tablesOf = (dbml: string): string[] => [...dbml.matchAll(/^Table (?:"[^"]+"\.)?"([^"]+)"/gm)].map((m) => m[1]);

describe('SQL: a lost quote spoils its own line, never the rest of the file', () => {
  // sqlDdlLexer.ts `lostQuote`: a quoted name never spans lines; a string that runs
  // across the end of one statement into the start of the next lost its quote.
  it('a quoted name that lost its opening quote (postgres): the next table imports', () => {
    const text = 'CREATE TABLE a0" (\n  "aa" integer\n);\nCREATE TABLE "Aa" (\n  "a0" integer\n);\n';
    const r = sqlDdlToDbml({ files: [{ name: 'schema.sql', text }], dialect: 'postgres' });
    // Before: "No CREATE TABLE statements with a column list were found", the quotes paired one off all the way down.
    expect(r.ok && tablesOf(r.dbml)).toEqual(['Aa']);
    // The broken one is a table that did not read (counted, reported with its line), not "a CREATE TABLE without a column list".
    expect(r.tablesFound).toBe(2);
    expect(r.problems).toEqual([expect.objectContaining({ line: 1, table: 'a0', message: expect.stringMatching(/stray quote/) })]);
  });

  it.each(['postgres', 'snowflake', 'mysql'] as const)('a string that lost its opening quote (%s): the next table imports, the broken one is reported', (dialect) => {
    const comment = dialect === 'postgres' ? 'COMMENT ON TABLE aa IS People who buy.\';' : dialect === 'mysql' ? ') COMMENT=People who buy.\';' : ') COMMENT = People who buy.\';';
    const close = dialect === 'postgres' ? ');\n' : '';
    const nextComment = dialect === 'postgres' ? '\nCOMMENT ON TABLE ab IS \'People who buy.\';' : '';
    const nextClose = dialect === 'postgres' ? ');' : dialect === 'mysql' ? ') COMMENT=\'People who buy.\';' : ') COMMENT = \'People who buy.\';';
    const text = `CREATE TABLE aa (\n  a0 int\n${close}${comment}\n\nCREATE TABLE ab (\n  a0 int\n${nextClose}${nextComment}\n`;
    const r = sqlDdlToDbml({ files: [{ name: 'schema.sql', text }], dialect });
    // Before: table ab was swallowed into the string, with no problem at all (a silent loss).
    expect(r.ok && tablesOf(r.dbml)).toEqual(expect.arrayContaining(['ab']));
    if (r.ok) expect(r.tableCount + r.problems.filter((p) => p.table).length).toBe(r.tablesFound);
  });

  it('a template placeholder after a lost quote is still read as one (the placeholder scanner pairs quotes as the lexer does)', () => {
    const text = "CREATE TABLE {{ schema }}.a (\n  x int COMMENT 'oops\n);\n\nCREATE TABLE {{ schema }}.b (\n  y int COMMENT 'fine'\n);\n";
    const r = sqlDdlToDbml({ files: [{ name: 'schema.sql', text }], dialect: 'mysql' });
    expect(r.ok && tablesOf(r.dbml)).toEqual(expect.arrayContaining(['b']));
  });

  it('a multi-line string that is not a lost quote still reads whole', () => {
    const text = "CREATE TABLE t (id int);\nCOMMENT ON TABLE t IS 'First line;\nsecond line';\n";
    const r = sqlDdlToDbml({ files: [{ name: 'schema.sql', text }], dialect: 'postgres' });
    expect(r.ok && r.dbml).toContain("'''First line;\nsecond line'''");
  });
});

describe('SQL: the repair ledger never says "readCOMMENT"', () => {
  // sqlDdlRepair.ts: the options rung's detail joins its parts with "; ".
  it('a table whose only trailing option is its COMMENT', () => {
    const text = "CREATE TABLE aa (\n  a0 number(38,0)\n) COMMENT = People who buy.';\n";
    const r = sqlDdlToDbml({ files: [{ name: 'schema.sql', text }], dialect: 'snowflake' });
    const details = (r.ledger ?? []).map((e) => e.detail ?? '');
    expect(details.join('\n')).not.toMatch(/readCOMMENT/);
  });
});

describe('Power BI: a nameless table, column or relationship is in the ledger with its place', () => {
  // semanticModelImport.ts readTmslDatabase / tmdlTable: each one a ledger problem (was a warning only, so
  // conservation by the ledger did not hold, and a model whose only table had no name said "no tables").
  const bim = (tables: unknown[], relationships: unknown[] = []): string => JSON.stringify({ name: 'Gen', compatibilityLevel: 1567, model: { tables, relationships } }, null, 1);

  it('model.bim: a table with no name is a problem with its line; the others import', () => {
    const r = readSemanticModel([{ path: 'Gen.SemanticModel/model.bim', text: bim([{ columns: [{ name: 'a', dataType: 'int64' }] }, { name: 'b', columns: [{ name: 'x', dataType: 'int64' }] }]) }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.problems).toEqual([{ file: 'Gen.SemanticModel/model.bim', line: 6, message: 'Table 1 has no name, so it was skipped (with its columns).' }]);
    const converted = semanticModelToDbml(r.model);
    expect(converted.ledger).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'problem', unit: 'table', what: 'TMSL table with no name', where: { file: 'Gen.SemanticModel/model.bim', line: 6 } })]));
  });

  it('model.bim: when the only table has no name, that is the problem (not "no tables")', () => {
    const r = readSemanticModel([{ path: 'Gen.SemanticModel/model.bim', text: bim([{ columns: [{ name: 'a', dataType: 'int64' }] }]) }]);
    expect(r).toEqual({ ok: false, problems: [expect.objectContaining({ line: 6, message: expect.stringMatching(/Table 1 has no name/) })] });
  });

  it('model.bim: a column with no name and a relationship without both ends are counted problems', () => {
    const r = readSemanticModel([{ path: 'Gen.SemanticModel/model.bim', text: bim([{ name: 'b', columns: [{ name: 'x', dataType: 'int64' }, { dataType: 'string' }] }], [{ fromTable: 'b', fromColumn: 'x' }]) }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ledger = semanticModelToDbml(r.model).ledger;
    expect(ledgerLeftOut(ledger)).toEqual(expect.arrayContaining(['1 column: TMSL column with no name not read (b).', '1 relationship: TMSL relationship without both ends not read (b).']));
    for (const e of ledger.filter((x) => x.outcome === 'problem')) expect(e.where?.line).toBeGreaterThan(0);
  });

  it('TMDL: a column with no name is a ledger problem with its file and line', () => {
    const r = readSemanticModel([
      { path: 'Gen.SemanticModel/definition/model.tmdl', text: 'model Model\n' },
      { path: 'Gen.SemanticModel/definition/tables/T.tmdl', text: 'table T\n\tcolumn\n\t\tdataType: string\n\tcolumn b\n\t\tdataType: string\n' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(semanticModelToDbml(r.model).ledger).toEqual(expect.arrayContaining([expect.objectContaining({
      outcome: 'problem', unit: 'column', what: 'TMDL column with no name', where: { file: 'Gen.SemanticModel/definition/tables/T.tmdl', line: 2, table: 'T' },
    })]));
  });
});

describe('DBML round trip: a key the source declared survives export → import', () => {
  // dbmlImport.ts dropOneToOneUniques: the `unique` a rich export adds to a one-to-one's FK
  // column is dropped on import, but not one the source declared (its meta_json says so).
  it('a one-to-one whose FK column the source marks unique (prisma-dbml-generator\'s Profile.userId)', () => {
    const file = path.resolve(__dirname, '../../fixtures/dbml-other-tools/prisma-dbml-generator/schema.dbml');
    const trip = roundTripDbml(fs.readFileSync(file, 'utf-8'));
    const userId = (c: typeof trip.first): unknown => c.tables.find((t) => t.name === 'Profile')!.columns.find((x) => x.name === 'userId');
    expect(userId(trip.first)).toMatchObject({ unique: true });
    expect(userId(trip.second)).toEqual(userId(trip.first));
  });

  it('a composite one-to-one whose columns the source gives a unique index keeps the index', () => {
    const text = [
      'Table a {', '  k1 int', '  k2 int', '  indexes {', '    (k1, k2) [pk]', '  }', '}',
      'Table b {', '  id int [pk]', '  f1 int', '  f2 int', '  indexes {', '    (f1, f2) [unique]', '  }', '}',
      'Ref: b.(f1, f2) - a.(k1, k2)', '',
    ].join('\n');
    const trip = roundTripDbml(text);
    expect(trip.first.tables.find((t) => t.name === 'b')!.uniqueKeys).toEqual(['f1,f2']);
    expect(trip.second).toEqual(trip.first);
  });

  it('an export\'s own unique on a one-to-one is still not kept as a key', () => {
    const text = 'Table a {\n  id int [pk]\n}\nTable b {\n  id int [pk]\n  a_id int\n}\nRef: b.a_id - a.id\n';
    const trip = roundTripDbml(text);
    const col = (c: typeof trip.first): unknown => c.tables.find((t) => t.name === 'b')!.columns.find((x) => x.name === 'a_id');
    expect(col(trip.first)).toMatchObject({ unique: false });
    expect(col(trip.second)).toEqual(col(trip.first));
  });
});
