/**
 * Review findings on the Power BI import (fix/importers-finish): a Save to
 * Folder model the size of a real one, a broken annotation that cost its
 * column, a merge conflict read on both sides, and objects after an unclosed
 * ``` block named under the wrong table. Import or report: every loss names
 * the object it is, with its file and line.
 */

import { describe, expect, it } from 'vitest';

import { MAX_SEMANTIC_MODEL_FILES, walkSemanticModelFiles } from '../../src/commands/importSemanticModel';
import type { DirEntries } from '../../src/services/importSources';
import type { LedgerEntry } from '../../src/services/importLedger';
import { readSemanticModel, semanticModelToDbml, type SemanticModelFile } from '../../src/services/semanticModelImport';

function readOk(files: SemanticModelFile[]): Extract<ReturnType<typeof readSemanticModel>, { ok: true }> {
  const r = readSemanticModel(files);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r;
}

const problems = (ledger: readonly LedgerEntry[] | undefined): LedgerEntry[] => (ledger ?? []).filter((e) => e.outcome === 'problem');
const tmdl = (path: string, lines: string[]): SemanticModelFile => ({ path: `X.SemanticModel/definition/${path}`, text: [...lines, ''].join('\n') });

/** A Save to Folder tree: `tables` tables of `columns` columns each, a partition per table (one JSON file per object). */
function folderTree(tables: number, columns: number): Record<string, DirEntries> {
  const tree: Record<string, DirEntries> = {
    '/m': [['database.json', false], ['tables', true]],
    '/m/tables': Array.from({ length: tables }, (_, i) => [`T${i}`, true] as [string, boolean]),
  };
  for (let t = 0; t < tables; t++) {
    tree[`/m/tables/T${t}`] = [[`T${t}.json`, false], ['columns', true], ['partitions', true]];
    tree[`/m/tables/T${t}/columns`] = Array.from({ length: columns }, (_, c) => [`C${c}.json`, false] as [string, boolean]);
    tree[`/m/tables/T${t}/partitions`] = [[`T${t}.json`, false]];
  }
  return tree;
}

describe('Save to Folder: a model of a real size', () => {
  it('a model with a file per column, more files than the model-file bound, is walked whole (the bound is for finding models, not for one model\'s objects)', async () => {
    const tree = folderTree(200, 25);
    const walk = await walkSemanticModelFiles('/m', async (f) => tree[f] ?? []);
    expect(walk.truncated).toBe(false);
    expect(walk.files.length).toBe(1 + 200 + 200 * 25 + 200);
    expect(walk.files.length).toBeGreaterThan(MAX_SEMANTIC_MODEL_FILES);
  });

  it('a folder with more models than the bound is still cut short', async () => {
    const tree: Record<string, DirEntries> = { '/r': Array.from({ length: MAX_SEMANTIC_MODEL_FILES + 1 }, (_, i) => [`m${i}.bim`, false] as [string, boolean]) };
    expect((await walkSemanticModelFiles('/r', async (f) => tree[f] ?? [])).truncated).toBe(true);
  });
});

describe('TMDL: a broken object under a column or a relationship', () => {
  it('an annotation with no closing quote is left out on its own: the column it is under is imported, and the ledger names the annotation', () => {
    const r = readOk([tmdl('tables/Sales.tmdl', [
      'table Sales',
      '\tcolumn id',
      '\t\tdataType: int64',
      "\t\tannotation 'Summarization Set By = Automatic",
      '\tcolumn amt',
      '\t\tdataType: double',
    ])]);
    expect(r.model.tables[0].columns.map((c) => [c.name, c.dataType])).toEqual([['id', 'int64'], ['amt', 'double']]);
    expect(problems(r.model.ledger)).toEqual([
      expect.objectContaining({ unit: 'object', what: 'TMDL annotation with no closing quote', where: expect.objectContaining({ line: 4, table: 'Sales', column: 'id' }) }),
    ]);
    // The draft keeps the column, and its ledger the one problem.
    const converted = semanticModelToDbml(r.model);
    expect(converted.dbml).toMatch(/\bid\b/);
    expect(problems(converted.ledger)).toHaveLength(1);
  });

  it('a relationship with a broken annotation is still imported, and the annotation is named', () => {
    const r = readOk([
      tmdl('tables/Sales.tmdl', ['table Sales', '\tcolumn CustomerKey', '\t\tdataType: int64']),
      tmdl('tables/Customer.tmdl', ['table Customer', '\tcolumn CustomerKey', '\t\tdataType: int64', '\t\tisKey']),
      tmdl('relationships.tmdl', [
        'relationship 5e6f0000-0000-0000-0000-000000000001',
        '\tfromColumn: Sales.CustomerKey',
        '\ttoColumn: Customer.CustomerKey',
        "\tannotation 'Broken = x",
      ]),
    ]);
    expect(r.model.relationships.map((x) => `${x.fromTable}.${x.fromColumn}>${x.toTable}.${x.toColumn}`)).toEqual(['Sales.CustomerKey>Customer.CustomerKey']);
    expect(problems(r.model.ledger)).toEqual([
      expect.objectContaining({ unit: 'object', what: 'TMDL annotation with no closing quote', where: expect.objectContaining({ line: 4 }) }),
    ]);
  });

  it('a column whose own name is not closed is still left out whole, named as the column', () => {
    const r = readOk([tmdl('tables/Sales.tmdl', ['table Sales', "\tcolumn 'id", '\t\tdataType: int64', '\tcolumn amt', '\t\tdataType: double'])]);
    expect(r.model.tables[0].columns.map((c) => c.name)).toEqual(['amt']);
    expect(problems(r.model.ledger)).toEqual([expect.objectContaining({ unit: 'column', what: 'TMDL column with no closing quote', where: expect.objectContaining({ line: 2, table: 'Sales' }) })]);
  });
});

describe('TMDL: a Git merge conflict', () => {
  it('only one side is read: no column from both sides, no phantom copy, and the side left out is named with its lines', () => {
    const r = readOk([tmdl('tables/Sales.tmdl', [
      'table Sales',
      '\tcolumn id',
      '\t\tdataType: int64',
      '<<<<<<< HEAD',
      '\tcolumn amount',
      '\t\tdataType: double',
      '=======',
      '\tcolumn amount',
      '\t\tdataType: string',
      '\tcolumn extra',
      '\t\tdataType: string',
      '>>>>>>> feature',
      '\tcolumn cid',
      '\t\tdataType: int64',
    ])]);
    expect(r.model.tables[0].columns.map((c) => [c.name, c.dataType])).toEqual([['id', 'int64'], ['amount', 'double'], ['cid', 'int64']]);
    const dbml = semanticModelToDbml(r.model).dbml;
    expect(dbml).not.toMatch(/amount_2/);
    expect(problems(r.model.ledger)).toEqual([
      expect.objectContaining({ unit: 'file', what: 'TMDL merge conflict', detail: expect.stringMatching(/lines 7.12 .*not read/), where: { file: 'X.SemanticModel/definition/tables/Sales.tmdl', line: 4, table: 'Sales' } }),
    ]);
  });

  it('a diff3 conflict (||||||| base) reads neither the base nor the other side', () => {
    const r = readOk([tmdl('tables/T.tmdl', [
      'table T',
      '<<<<<<< ours',
      '\tcolumn a',
      '||||||| base',
      '\tcolumn b',
      '=======',
      '\tcolumn c',
      '>>>>>>> theirs',
    ])]);
    expect(r.model.tables[0].columns.map((c) => c.name)).toEqual(['a']);
  });
});

describe('TMDL: what follows a ``` block never closed is named as what it is', () => {
  it('a relationship after it is named by its from table and column, never by its own name as a table', () => {
    const r = readOk([
      tmdl('tables/Customer.tmdl', ['table Customer', '\tcolumn CustomerKey', '\t\tdataType: int64']),
      tmdl('tables/Sales.tmdl', [
        'table Sales',
        '\tcolumn CustomerKey',
        '\t\tdataType: int64',
        '\tmeasure Total = ```',
        '\t\t\tSUM(Sales[Amount])',
        '',
        'relationship 5e6f0000-0000-0000-0000-000000000002',
        '\tfromColumn: Sales.CustomerKey',
        '\ttoColumn: Customer.CustomerKey',
      ]),
    ]);
    const rel = problems(r.model.ledger).find((e) => e.unit === 'relationship');
    expect(rel?.where).toEqual(expect.objectContaining({ line: 7, table: 'Sales', column: 'CustomerKey' }));
  });

  it('inside a createOrReplace script, a column after it is named with its table', () => {
    const r = readOk([{ path: 'script.tmdl', text: [
      'createOrReplace',
      '',
      '\ttable First',
      '\t\tcolumn a',
      '\t\t\tdataType: int64',
      '',
      '\ttable Sales',
      '\t\tcolumn k',
      '\t\t\tdataType: int64',
      '\t\tmeasure M = ```',
      '\t\t\tSUM(x)',
      '\t\tcolumn after',
      '\t\t\tdataType: int64',
      '',
      '\ttable Other',
      '\t\tcolumn o',
      '',
    ].join('\n') }]);
    const unread = problems(r.model.ledger).filter((e) => e.what.includes('after a'));
    expect(unread).toEqual(expect.arrayContaining([
      expect.objectContaining({ unit: 'column', where: expect.objectContaining({ line: 12, table: 'Sales', column: 'after' }) }),
      expect.objectContaining({ unit: 'table', where: expect.objectContaining({ line: 15, table: 'Other' }) }),
      expect.objectContaining({ unit: 'column', where: expect.objectContaining({ line: 16, table: 'Other', column: 'o' }) }),
    ]));
  });
});
