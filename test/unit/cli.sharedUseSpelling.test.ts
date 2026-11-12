/**
 * The CLI on Gerhard's photo-2 shape (packages/core/test/fixtures/dbml/
 * same-name-unqualified): two `Table adresse` files with no schema, in
 * tables/bqs/ and tables/ccc/, imported side by side under one spelling as
 * ERD Studio 2.0.4 wrote them. doctor says which line imports the spelling
 * again and how to write it (in place of the parser's bare [3003]), and no
 * longer calls the Refs it reads by their columns dangling; inventory tells
 * the two rows apart; export declares each in its schema folder's schema
 * and keeps every Ref, and the pinned parser reads the result.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compileDbmlProject } from '@erd-studio/core/dbml';
import { buildCliContext } from '../../src/cli/context';
import { runDoctor } from '../../src/cli/doctor';
import { runExport } from '../../src/cli/export';
import { formatInventory, makePaint } from '../../src/cli/format';
import { runInventory } from '../../src/cli/inventory';
import { sharedUseSpellings } from '../../src/services/sharedUseSpelling';

const FIXTURE = path.resolve(__dirname, '../../packages/core/test/fixtures/dbml/same-name-unqualified');
let tmp: string;
let root: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-cli-shared-use-'));
  root = path.join(tmp, 'project');
  fs.cpSync(FIXTURE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function problems(): Promise<Array<{ file: string; line?: number; code: string | number; severity: string; message: string }>> {
  const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: tmp });
  return r.erd.dbmlProblems.map((p) => ({ file: p.file.replace('.erd-studio/', ''), ...(p.line !== undefined ? { line: p.line } : {}), code: p.code, severity: p.severity, message: p.message }));
}

describe('sharedUseSpellings', () => {
  it('finds a spelling two lines import from different table files, by line, and nothing else', () => {
    const text = [
      "use { table bqs__v_sap_prod_unit2 } from '../tables/bqs/bqs__v_sap_prod_unit2.dbml'",
      "use { table adresse } from '../tables/bqs/adresse.dbml'",
      "use { table adresse } from '../tables/ccc/adresse.dbml'",
      "use { table ccc.kunde } from '../tables/ccc/kunde.dbml'",
      "use { table bqs.kunde } from '../tables/bqs/kunde.dbml'",
      "use { table x as ccc_x } from '../tables/ccc/x.dbml'",
      "use { table x } from '../tables/bqs/x.dbml'",
      "// use { table adresse } from '../tables/ddd/adresse.dbml'",
      '',
    ].join('\n');
    const groups = sharedUseSpellings(text, 'bronze/diagrams/sap.dbml');
    expect(groups.map((g) => ({ spelling: g.spelling, lines: g.uses.map((u) => u.line), schemas: g.uses.map((u) => u.id?.schema) }))).toEqual([
      { spelling: 'adresse', lines: [2, 3], schemas: ['bqs', 'ccc'] },
    ]);
  });

  it('one table imported twice (the same file) is no shared spelling', () => {
    const text = "use { table adresse } from '../tables/bqs/adresse.dbml'\nuse { table adresse } from '../tables/bqs/adresse'\n";
    expect(sharedUseSpellings(text, 'bronze/diagrams/sap.dbml')).toEqual([]);
  });
});

describe('doctor on photo-2\'s shape', () => {
  it('reports sharedUseSpelling (error) on each later line, with the line to write, in place of the parser\'s bare [3003]', async () => {
    const all = await problems();
    const shared = all.filter((p) => p.code === 'sharedUseSpelling');
    expect(shared.map((p) => [p.file, p.line, p.severity])).toEqual([
      ['bronze/diagrams/sap.dbml', 13, 'error'],
      ['bronze/relationships/bronze.dbml', 4, 'error'],
    ]);
    expect(shared[0].message).toContain('Line 13 imports adresse from ../tables/ccc/adresse.dbml, as line 12 (../tables/bqs/adresse.dbml) does from another file.');
    expect(shared[0].message).toContain("use { table ccc.adresse } from '../tables/ccc/adresse.dbml'");
    expect(shared[0].message).toContain('Qualify Tables');
    expect(all.some((p) => p.code === 3003)).toBe(false);
    // Nor the parser's [4000] "Column … does not exist in Table 'public.adresse'" on the Refs it bound to the first file.
    expect(all.filter((p) => p.code === 4000)).toEqual([]);
  });

  it('no danglingRef for the Refs read by their columns; the Ref whose columns neither table has is ambiguousTableReference', async () => {
    const all = await problems();
    expect(all.filter((p) => p.code === 'danglingRef')).toEqual([]);
    expect(all.filter((p) => p.code === 'ambiguousTableReference').map((p) => [p.file, p.line])).toEqual([['bronze/relationships/bronze.dbml', 9]]);
  });

  it('a project with qualified headers and use lines reports no sharedUseSpelling', async () => {
    const at = (rel: string): string => path.join(root, '.erd-studio', rel);
    for (const [rel, schema] of [['bronze/tables/bqs/adresse.dbml', 'bqs'], ['bronze/tables/ccc/adresse.dbml', 'ccc']] as const) {
      fs.writeFileSync(at(rel), fs.readFileSync(at(rel), 'utf-8').replace('Table adresse', `Table ${schema}.adresse`));
    }
    fs.writeFileSync(at('bronze/diagrams/sap.dbml'), fs.readFileSync(at('bronze/diagrams/sap.dbml'), 'utf-8')
      .replace("use { table adresse } from '../tables/bqs", "use { table bqs.adresse } from '../tables/bqs")
      .replace("use { table adresse } from '../tables/ccc", "use { table ccc.adresse } from '../tables/ccc"));
    const all = await problems();
    expect(all.filter((p) => p.file === 'bronze/diagrams/sap.dbml' && p.code === 'sharedUseSpelling')).toEqual([]);
  });
});

describe('inventory and export on photo-2\'s shape', () => {
  it('inventory\'s text tells the two adresse rows apart by their schema folders', async () => {
    const text = formatInventory(runInventory(await buildCliContext({ project: root, semanticDir: '.erd-studio' })), makePaint(false));
    expect(text).toMatch(/^ {4}bqs\.adresse {2}3 columns/m);
    expect(text).toMatch(/^ {4}ccc\.adresse {2}4 columns/m);
    expect(text).toMatch(/^ {4}bqs__v_sap_prod_unit2 {2}3 columns/m);
  });

  it.each(['dbml', 'dbml-rich'] as const)('export --format %s declares Table bqs.adresse / ccc.adresse, keeps every Ref, and the pinned parser reads it', async (format) => {
    const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
    const r = await runExport(ctx, { domain: '.erd-studio/bronze/diagrams/sap.dbml', format });
    expect(r.content).toMatch(/^Table bqs\.adresse \{/m);
    expect(r.content).toMatch(/^Table ccc\.adresse \{/m);
    expect(r.content).not.toContain('"bqs.adresse"');
    expect(r.content).not.toContain('Not exported: bqs__v_sap_prod_unit2');
    // Every table is declared in its schema folder's schema, as core's loader reads an unqualified Table (§1.2).
    expect(r.content).toMatch(/^Table bqs\.bqs__v_sap_prod_unit2 \{/m);
    expect(r.content).toMatch(/^Ref: bqs\.bqs__v_sap_prod_unit2\.ccc_adresse_id >\?? ccc\.adresse\.adr_id$/m);
    expect(r.content).toMatch(/^Ref: ccc\.adresse\.adr_id >\?? bqs\.adresse\.id$/m);
    expect(compileDbmlProject({ 'x.dbml': r.content }, ['x.dbml'])).toEqual({ 'x.dbml': [] });
  });
});
