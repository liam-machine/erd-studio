/**
 * Edge cases that broke the Power BI import (Save to Folder, TMDL isolation,
 * model.bim lines, Power Query merge sources): each one a messy real-world
 * input that threw, hung, lost something silently or reported the wrong
 * line. Import or report: nothing here may throw, and every loss is a ledger
 * entry with its file and line.
 */

import { describe, expect, it } from 'vitest';

import { walkSemanticModelFiles } from '../../src/commands/importSemanticModel';
import type { DirEntries } from '../../src/services/importSources';
import type { LedgerEntry } from '../../src/services/importLedger';
import { jsonErrorLineOf, parseJsonWithLines } from '../../src/services/jsonLines';
import {
  findSemanticModels,
  mCombinedSources,
  readSemanticModel,
  semanticModelToDbml,
  type SemanticModelFile,
} from '../../src/services/semanticModelImport';

function readOk(files: SemanticModelFile[]): Extract<ReturnType<typeof readSemanticModel>, { ok: true }> {
  const r = readSemanticModel(files);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r;
}

const problems = (ledger: readonly LedgerEntry[] | undefined): LedgerEntry[] => (ledger ?? []).filter((e) => e.outcome === 'problem');

/** A Save to Folder model: database.json and one table T with column K, plus `extra` files. */
function folderModel(database: Record<string, unknown>, table: Record<string, unknown>, extra: SemanticModelFile[] = []): SemanticModelFile[] {
  return [
    { path: 'M/database.json', text: JSON.stringify({ name: 'M', compatibilityLevel: 1550, ...database }, null, 2) },
    { path: 'M/tables/T/T.json', text: JSON.stringify({ name: 'T', ...table }, null, 2) },
    { path: 'M/tables/T/columns/K.json', text: JSON.stringify({ name: 'K', dataType: 'int64', sourceColumn: 'K' }, null, 2) },
    ...extra,
  ];
}

describe('model.bim and Save to Folder JSON: the line a parse error is on', () => {
  it('a file nested deeper than the line reader follows still reports the line the error is on, not the deep one', () => {
    const deep = `${'['.repeat(300)}${']'.repeat(300)}`;
    const text = `{\n"a": ${deep},\n"b": 1,\n"c": 2,\n"d": x\n}`;
    let line: number | undefined;
    try {
      parseJsonWithLines(text);
    } catch (e) {
      line = jsonErrorLineOf(e);
    }
    expect(line).toBe(5);
  });

  it('a deep file that ends early is reported on its last line', () => {
    const text = `{\n"a": ${'['.repeat(300)}${']'.repeat(300)},\n"b": [1,\n2`;
    let line: number | undefined;
    try {
      parseJsonWithLines(text);
    } catch (e) {
      line = jsonErrorLineOf(e);
    }
    expect(line).toBe(4);
  });
});

describe('Save to Folder: big and broken annotations', () => {
  it('a table file holding an array of 300 000 strings reads (no stack overflow), and its column is imported', () => {
    const lines = Array.from({ length: 300_000 }, (_, i) => `line ${i}`);
    const files = folderModel({ model: {} }, { annotations: [{ name: 'Notes', value: lines }] });
    const r = readOk(files);
    expect(r.model.tables.map((t) => t.columns.map((c) => c.name))).toEqual([['K']]);
  });

  it('a model.bim culture holding 300 000 translations reads (no stack overflow)', () => {
    const translations = { model: { name: 'M', tables: Array.from({ length: 300_000 }, (_, i) => ({ name: `t${i}`, translatedCaption: `x${i}` })) } };
    const bim = { name: 'M', model: { tables: [{ name: 'T', columns: [{ name: 'K', dataType: 'int64' }] }], cultures: [{ name: 'fr-FR', translations }] } };
    const r = readOk([{ path: 'M/model.bim', text: JSON.stringify(bim) }]);
    expect(r.model.features?.find((f) => f.kind === 'translation')?.count).toBe(300_000);
  });

  it('a TabularEditor_Perspectives annotation that does not parse is a problem with its file and line, not silently no perspectives', () => {
    const files = folderModel({ model: { annotations: [{ name: 'TabularEditor_Perspectives', value: '[{"Name":"Sales"' }] } }, {});
    const r = readOk(files);
    expect(problems(r.model.ledger)).toEqual([
      expect.objectContaining({ unit: 'object', what: expect.stringContaining('perspectives'), where: expect.objectContaining({ file: 'M/database.json', line: expect.any(Number) }) }),
    ]);
  });

  it('a TabularEditor_TranslatedNames annotation that does not parse is a problem with its file and line', () => {
    const files = folderModel({ model: {} }, { annotations: [{ name: 'TabularEditor_TranslatedNames', value: '{"fr-FR": "Ventes"' }] });
    const r = readOk(files);
    expect(problems(r.model.ledger)).toEqual([
      expect.objectContaining({ what: expect.stringContaining('translations'), where: expect.objectContaining({ file: 'M/tables/T/T.json', line: expect.any(Number), table: 'T' }) }),
    ]);
  });

  it('TabularEditor_Relationships holding one relationship on its own is read; an entry that is not a relationship is a problem, not silently dropped', () => {
    const one = JSON.stringify({ name: 'r1', fromTable: 'T', fromColumn: 'K', toTable: 'U', toColumn: 'K' });
    const files = [
      ...folderModel({ model: {} }, { annotations: [{ name: 'TabularEditor_Relationships', value: one }] }),
      { path: 'M/tables/U/U.json', text: JSON.stringify({ name: 'U', annotations: [{ name: 'TabularEditor_Relationships', value: '[ 42, "x" ]' }] }, null, 2) },
      { path: 'M/tables/U/columns/K.json', text: JSON.stringify({ name: 'K', dataType: 'int64' }) },
    ];
    const r = readOk(files);
    expect(r.model.relationships.map((x) => `${x.fromTable}.${x.fromColumn}>${x.toTable}.${x.toColumn}`)).toEqual(['T.K>U.K']);
    expect(problems(r.model.ledger)).toEqual([
      expect.objectContaining({ unit: 'relationship', count: 2, where: { file: 'M/tables/U/U.json', line: expect.any(Number), table: 'U' } }),
    ]);
  });

  it('a TabularEditor_Relationships annotation that is neither a list nor a relationship is a problem', () => {
    const files = folderModel({ model: {} }, { annotations: [{ name: 'TabularEditor_Relationships', value: '"r1"' }] });
    expect(problems(readOk(files).model.ledger)).toEqual([
      expect.objectContaining({ unit: 'relationship', where: expect.objectContaining({ file: 'M/tables/T/T.json', table: 'T', line: expect.any(Number) }) }),
    ]);
  });
});

describe('Power Query: shared queries that read each other', () => {
  const nav = (item: string): string => `let s = Sql.Database("srv", "db"), t = s{[Schema="dbo",Item="${item}"]}[Data] in t`;

  it('two shared queries that merge each other (a cycle) never overflow the stack', () => {
    const queries = new Map([
      ['X', 'let a = Table.Combine({Y, Z}) in a'],
      ['Y', 'let a = Table.NestedJoin(X, {"k"}, Z, {"k"}, "n", JoinKind.LeftOuter) in a'],
      ['Z', nav('Z')],
    ]);
    const got = mCombinedSources('let a = Table.Combine({X, Y}) in a', queries, new Set());
    expect(got?.kind).toBe('append');
    expect(got?.inputs).toContain('dbo.Z');
  });

  it('a TMDL model whose shared expressions merge each other imports (one bad query never fails the model)', () => {
    const files: SemanticModelFile[] = [
      { path: 'M.SemanticModel/definition/expressions.tmdl', text: [
        'expression X =', '\t\tlet', '\t\t\ta = Table.Combine({Y, T})', '\t\tin', '\t\t\ta', '',
        'expression Y =', '\t\tlet', '\t\t\ta = Table.NestedJoin(X, {"k"}, T, {"k"}, "n", JoinKind.LeftOuter)', '\t\tin', '\t\t\ta', '',
      ].join('\n') },
      { path: 'M.SemanticModel/definition/tables/T.tmdl', text: [
        'table T', '\tcolumn k', '\t\tdataType: int64', '',
        '\tpartition T = m', '\t\tmode: import', '\t\tsource =', '\t\t\tlet', '\t\t\t\ta = Table.Combine({X, Y})', '\t\t\tin', '\t\t\t\ta', '',
      ].join('\n') },
    ];
    const r = readOk(files);
    expect(r.model.tables[0].source?.combined?.kind).toBe('append');
  });

  it('a long chain of shared queries, each appending the two before it, resolves without an exponential walk', () => {
    const chain = (n: number): Map<string, string> => {
      const queries = new Map<string, string>([['Q0', nav('A')], ['Q1', nav('B')]]);
      for (let i = 2; i < n; i++) queries.set(`Q${i}`, `let a = Table.Combine({Q${i - 1}, Q${i - 2}}) in a`);
      return queries;
    };
    // Twelve deep: followed to the warehouse tables.
    expect(mCombinedSources('let a = Table.Combine({Q11, Q10}) in a', chain(12), new Set())?.inputs.sort()).toEqual(['dbo.A', 'dbo.B']);
    // Sixty deep: fast, and what is too deep to follow is named, never dropped.
    const queries = chain(60);
    const started = Date.now();
    const got = mCombinedSources('let a = Table.Combine({Q59, Q58}) in a', queries, new Set());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(got?.inputs.length).toBeGreaterThan(0);
    for (const input of got?.inputs ?? []) expect(queries.has(input) || /^dbo\.[AB]$/.test(input), input).toBe(true);
  });

  it('1500 tables whose queries each merge two others read in a few seconds (no table × query × regex blow-up)', () => {
    const n = 1500;
    const files: SemanticModelFile[] = [];
    for (let i = 0; i < n; i++) {
      files.push({ path: `M.SemanticModel/definition/tables/T${i}.tmdl`, text: [
        `table T${i}`, '\tcolumn K', '\t\tdataType: int64', '',
        `\tpartition T${i} = m`, '\t\tmode: import', '\t\tsource =', '\t\t\tlet',
        `\t\t\t\tS = Table.SelectColumns(T${(i + 1) % n}, {"K"}),`,
        `\t\t\t\tJ = Table.NestedJoin(S, {"K"}, Table.Buffer(T${(i + 2) % n}), {"K"}, "x", JoinKind.LeftOuter)`,
        '\t\t\tin', '\t\t\t\tJ', '',
      ].join('\n') });
    }
    const started = Date.now();
    const r = readOk(files);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.model.tables.find((t) => t.name === 'T0')?.source?.combined?.inputs).toEqual(['T1', 'T2']);
  });
});

describe('finding a Save to Folder model in a repo', () => {
  it('a stray database.json above a Tabular Editor model is not a model, and hides no .bim', () => {
    const entries = findSemanticModels([
      'database.json',
      'models/Sales/database.json',
      'models/Sales/tables/A/A.json',
      'other/Finance.bim',
    ]);
    expect(entries.map((e) => [e.name, e.kind, e.root])).toEqual([
      ['Sales', 'folder', 'models/Sales'],
      ['Finance', 'tmsl', 'other'],
    ]);
  });

  it('a big repo with a database.json at its root (db-migrate) and thousands of JSON files still finds its model: only a Save to Folder layout is walked', async () => {
    const tree: Record<string, DirEntries> = {
      '/r': [['database.json', false], ['data', true], ['pbi', true]],
      '/r/data': Array.from({ length: 6000 }, (_, i) => [`f${i}.json`, false] as [string, boolean]),
      '/r/pbi': [['X.SemanticModel', true]],
      '/r/pbi/X.SemanticModel': [['definition', true]],
      '/r/pbi/X.SemanticModel/definition': [['tables', true]],
      '/r/pbi/X.SemanticModel/definition/tables': [['A.tmdl', false]],
    };
    const walk = await walkSemanticModelFiles('/r', async (f) => tree[f] ?? []);
    expect(walk.truncated).toBe(false);
    expect(walk.files).toEqual(['/r/database.json', '/r/pbi/X.SemanticModel/definition/tables/A.tmdl']);
  });
});

describe('TMDL: a merge conflict left in a file', () => {
  it('Git conflict markers are a problem with the file and line, not read silently as if one side won', () => {
    const text = ['table T', '\tcolumn A', '<<<<<<< HEAD', '\t\tdataType: string', '=======', '\t\tdataType: int64', '>>>>>>> feature', '\tcolumn B', '\t\tdataType: string', ''].join('\n');
    const r = readOk([{ path: 'X.SemanticModel/definition/tables/T.tmdl', text }]);
    expect(r.model.tables[0].columns.map((c) => c.name)).toEqual(['A', 'B']);
    expect(problems(r.model.ledger)).toEqual([
      expect.objectContaining({ unit: 'file', what: 'TMDL merge conflict', where: { file: 'X.SemanticModel/definition/tables/T.tmdl', line: 3, table: 'T' } }),
    ]);
    // In the draft's ledger too.
    expect(problems(semanticModelToDbml(r.model).ledger)).toHaveLength(1);
  });
});

describe('Save to Folder: a copy of a table file left in its folder', () => {
  const table = (name: string, column: string): string => JSON.stringify({ name, columns: [{ name: column, dataType: 'string' }] }, null, 2);
  const db = { path: 'M/database.json', text: JSON.stringify({ name: 'M', model: {} }) };

  it('the file named after the folder is the table, even when a copy sorts first; the copy is named as outside the layout', () => {
    const r = readOk([
      db,
      { path: 'M/tables/Sales/Sales - Copy.json', text: table('Sales', 'Old') },
      { path: 'M/tables/Sales/Sales.json', text: table('Sales', 'Current') },
    ]);
    expect(r.model.tables.map((t) => t.columns.map((c) => c.name))).toEqual([['Current']]);
    expect(r.model.ledger).toEqual([expect.objectContaining({ outcome: 'skipped', where: { file: 'M/tables/Sales/Sales - Copy.json' } })]);
  });

  it('when the table\'s own file does not parse, a copy beside it is not imported in its place', () => {
    const r = readSemanticModel([
      db,
      { path: 'M/tables/Sales/Sales.json', text: '{ "name": "Sales", ' },
      { path: 'M/tables/Sales/Sales.bak.json', text: table('Sales', 'Stale') },
      { path: 'M/tables/Other/Other.json', text: table('Other', 'X') },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.problems));
    expect(r.model.tables.map((t) => t.name)).toEqual(['Other']);
    expect(problems(r.model.ledger)).toEqual([expect.objectContaining({ unit: 'table', where: expect.objectContaining({ file: 'M/tables/Sales/Sales.json', table: 'Sales' }) })]);
  });
});

describe('TMDL and Save to Folder: what is named is named under the right table', () => {
  it('columns after a never-closed ``` block are named under the table they are declared in, not the one the block is in', () => {
    const text = "table T\n\tcolumn A = ```\n\t\tx\n\ntable U\n\tcolumn B\n\t\tdataType: string\n";
    const r = readOk([
      { path: 'X.SemanticModel/definition/tables/T.tmdl', text },
      { path: 'X.SemanticModel/definition/tables/V.tmdl', text: 'table V\n\tcolumn A\n\t\tdataType: string\n' },
    ]);
    expect(problems(r.model.ledger).map((e) => [e.unit, e.where?.table, e.where?.column ?? null, e.where?.line])).toEqual([
      ['column', 'T', 'A', 2],
      ['table', 'U', null, 5],
      ['column', 'U', 'B', 6],
    ]);
  });

  it('a table defined twice (TMDL, two files) keeps the first and names the second in the ledger with its file and line', () => {
    const r = readOk([
      { path: 'X.SemanticModel/definition/tables/T.tmdl', text: 'table T\n\tcolumn A\n\t\tdataType: string\n' },
      { path: 'X.SemanticModel/definition/tables/T2.tmdl', text: '\ntable T\n\tcolumn B\n\t\tdataType: string\n' },
    ]);
    expect(r.model.tables.map((t) => t.columns.map((c) => c.name))).toEqual([['A']]);
    expect(semanticModelToDbml(r.model).ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'skipped', unit: 'table', cause: 'duplicate', where: { file: 'X.SemanticModel/definition/tables/T2.tmdl', line: 2, table: 'T' } }),
    ]));
  });

  it('Save to Folder: a copied table folder (Sales - Copy/Sales.json) never wins over the table\'s own folder', () => {
    const table = (column: string): string => JSON.stringify({ name: 'Sales', columns: [{ name: column, dataType: 'string' }] }, null, 2);
    const r = readOk([
      { path: 'M/database.json', text: JSON.stringify({ name: 'M', model: {} }) },
      { path: 'M/tables/Sales - Copy/Sales.json', text: table('Stale') },
      { path: 'M/tables/Sales/Sales.json', text: table('Current') },
    ]);
    expect(r.model.tables.map((t) => t.columns.map((c) => c.name))).toEqual([['Current']]);
    expect(r.model.ledger).toEqual([
      expect.objectContaining({ outcome: 'skipped', unit: 'table', cause: 'duplicate', where: { file: 'M/tables/Sales - Copy/Sales.json', line: 1, table: 'Sales' } }),
    ]);
  });
});
