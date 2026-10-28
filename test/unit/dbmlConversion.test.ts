/**
 * Convert Project to DBML's pure planner (native DBML storage §6.1, §9.6):
 * one test per refusal, the notes for what ERD Studio does not read (the
 * comment block's content asserted), moved relationships, v4 files, each
 * normalisation of §6.1 step 3, a mixed project, a half-applied run, a
 * library folder that is not a layer, and the self-check's named refusal.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';

import { classifySemanticFile, detectProjectStorage, loadDisplaySubjectArea } from '@erd-studio/core';
import type { DisplaySubjectArea } from '@erd-studio/core';
import { compileDbmlProject, dbmlStorageReader, parseTableDbml, readRelationshipsDbml } from '@erd-studio/core/dbml';
import type { DbmlParserModule } from '@erd-studio/core/dbml';

import { dbmlConversionIsEmpty, describeDbmlConversion, keptFromLine, planDbmlConversion } from '../../src/services/dbmlConversion';
import type { DbmlConversionInput, DbmlConversionPlan } from '../../src/services/dbmlConversion';
import { readDbmlConversionInput } from '../../src/services/dbmlConversionFiles';
import { runDoctor } from '../../src/cli/doctor';
import { formatDoctor, makePaint } from '../../src/cli/format';

const CORE_FIXTURES = path.resolve(__dirname, '../../packages/core/test/fixtures');
const FIXTURES = path.resolve(__dirname, '../fixtures/dbml-convert');

const PARSERS: Array<[string, DbmlParserModule | undefined]> = [
  ['9.1.1', v9 as unknown as DbmlParserModule],
  ['10.3.1', v10 as unknown as DbmlParserModule],
  ['11.0.0', undefined],
];

const LAYERS = JSON.stringify({
  schemaVersion: 1,
  layers: [
    { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 1 },
    { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 2 },
  ],
}, null, 2);

/** The planner's input for in-memory files (paths relative to the semantic dir). */
function inputOf(files: Record<string, string>, options: { tablesDirIsLayer?: boolean } = {}): DbmlConversionInput {
  const all = { 'layers.json': LAYERS, ...files };
  return {
    semanticDir: '.erd-studio',
    layers: ['silver', 'gold'],
    tablesDirIsLayer: options.tablesDirIsLayer ?? false,
    files: Object.entries(all).flatMap(([p, text]) => {
      const cls = classifySemanticFile(p, { tablesDirIsLayer: false, firstLine: text.split('\n')[0] });
      if (cls.kind === 'other' || cls.kind === 'template') return [];
      return [{ path: p, text, hadBom: false, kind: cls.kind, ...(cls.storage ? { storage: cls.storage } : {}) }];
    }),
  };
}

/** A table file in YAML. */
function yml(name: string, columns: Array<string | [string, string, boolean?]>, relationships: Array<Record<string, string>> = []): string {
  const cols = columns.map((c) => (typeof c === 'string' ? [c, 'INT', false] as const : c));
  return [
    `name: ${name}`,
    'columns:',
    ...cols.flatMap(([n, t, pk]) => [`  - name: ${n}`, `    dataType: ${t}`, ...(pk ? ['    isPrimaryKey: true'] : [])]),
    ...(relationships.length > 0 ? ['relationships:', ...relationships.flatMap((r) => Object.entries(r).map(([k, v], i) => `${i === 0 ? '  - ' : '    '}${k}: ${v}`))] : []),
    '',
  ].join('\n');
}

/** A v5 JSON diagram. */
function diagram(name: string, layer: string, models: string[], relationships: Array<Record<string, string>> = [], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 5, domain: name, layer, description: `${name} diagram`,
    logical: { models, relationships },
    viewConfig: { positions: Object.fromEntries(models.map((m, i) => [m, { x: 40 + i * 300, y: 40 }])) },
    ...extra,
  }, null, 2);
}

const DIM = yml('dim', [['dim_key', 'INT', true], 'label']);
const FCT_REL = { fromColumn: 'dim_key', toModel: 'dim', toColumn: 'dim_key', cardinality: 'many-to-one' };

const created = (plan: DbmlConversionPlan, p: string): string | undefined => plan.creates.find((c) => c.path === p)?.text;
const written = (plan: DbmlConversionPlan, p: string): string | undefined => created(plan, p) ?? plan.replaces.find((r) => r.path === p)?.text;
const refLines = (text: string | undefined): string[] => (text ?? '').split('\n').filter((l) => l.startsWith('Ref'));

/** Every DBML file after the plan compiles with no errors in 9.1.1, 10.3.1 and 11.0.0. */
function expectCompilesEverywhere(input: DbmlConversionInput, plan: DbmlConversionPlan): void {
  const after: Record<string, string> = {};
  for (const f of input.files) after[f.path] = f.text;
  for (const d of plan.deletes) delete after[d];
  for (const c of [...plan.creates, ...plan.replaces]) after[c.path] = c.text;
  const dbml = Object.fromEntries(Object.entries(after).filter(([p]) => p.endsWith('.dbml')));
  for (const [label, parser] of PARSERS) {
    const result = compileDbmlProject(dbml, Object.keys(dbml), parser);
    const errors = Object.entries(result).flatMap(([file, list]) => list.map((d) => `${label} ${file}:${d.line} ${d.message}`));
    expect(errors).toEqual([]);
  }
}

/** A file left as it is, with its problem (and line). */
const leftOf = (plan: DbmlConversionPlan, p: string): DbmlConversionPlan['leftAsIs'][number] | undefined => plan.leftAsIs.find((l) => l.path === p);

describe('planDbmlConversion: the two refusals left (D26/D27)', () => {
  it('a layer called tables', async () => {
    const plan = await planDbmlConversion(inputOf({ 'logical-models/dim.yml': DIM }, { tablesDirIsLayer: true }));
    expect(plan.refusals).toEqual([expect.stringMatching(/layer called "tables"/)]);
    expect(plan.creates).toEqual([]);
  });

  it('a self-check failure is a named refusal, and nothing is planned', async () => {
    const plan = await planDbmlConversion(inputOf({ 'logical-models/dim.yml': DIM }), {
      compile: (_files, entries) => Object.fromEntries(entries.map((e) => [e, e === 'tables/dim.dbml' ? [{ code: 4000, message: 'Forced', line: 2, column: 1 }] : []])),
    });
    expect(plan.refusals).toEqual(['Convert would write DBML that does not compile: tables/dim.dbml:2 Forced [4000]. Nothing was changed; please report this with the file.']);
    expect(plan.creates).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(describeDbmlConversion(plan)).toMatch(/^Can't convert yet:/);
  });
});

describe('planDbmlConversion: a file it cannot convert stays as it is, and the rest converts (D26/D27)', () => {
  it('a table named _relationships stays YAML', async () => {
    const plan = await planDbmlConversion(inputOf({ 'logical-models/_relationships.yml': yml('_relationships', ['id']), 'logical-models/dim.yml': DIM }));
    expect(plan.refusals).toEqual([]);
    expect(leftOf(plan, 'logical-models/_relationships.yml')?.problem).toMatch(/‘_relationships’ is the name of the relationships file/);
    expect(plan.creates.map((c) => c.path)).toEqual(['tables/dim.dbml']);
  });

  it.each([
    ['in both libraries', { 'logical-models/dim.yml': DIM, 'tables/dim.yml': DIM }],
    ['in two library folders', { 'logical-models/gold/dim.yml': DIM, 'logical-models/silver/dim.yml': DIM }],
    ['in two cases', { 'logical-models/dim.yml': DIM, 'logical-models/gold/Dim.yml': yml('Dim', ['dim_key']) }],
  ])('a name %s: every copy stays YAML (Convert never picks one)', async (_label, files) => {
    const plan = await planDbmlConversion(inputOf({ ...files, 'logical-models/other.yml': yml('other', ['id']) }));
    expect(plan.refusals).toEqual([]);
    // The fix names the command as the palette lists it.
    for (const p of Object.keys(files)) expect(leftOf(plan, p)?.problem).toMatch(/^One table has 2 files: .*\(ERD Studio: Give Duplicate Table Its Own Name, or delete the others\)\.$/);
    expect(plan.creates.map((c) => c.path)).toEqual(['tables/other.dbml']);
  });

  it('a relationship to a name left in two files stays pending, and its note names both files (not only the last one read)', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/gold/dim.yml': DIM,
      'logical-models/silver/dim.yml': yml('dim', [['dim_key', 'INT', true], 'other_label']),
      'logical-models/gold/fct.yml': yml('fct', ['fct_id', 'dim_key'], [FCT_REL]),
    }));
    expect(plan.refusals).toEqual([]);
    expect(plan.notes).toContain(
      'logical-models/gold/fct.yml: the relationship fct.dim_key → dim.dim_key is kept as a pending line in tables/gold/_relationships.dbml '
        + '(dim stays a YAML table until its files (logical-models/gold/dim.yml, logical-models/silver/dim.yml) are made one). '
        + 'It draws as before, and becomes a live Ref when both ends have table files with those columns.',
    );
  });

  it('a .yml that does not parse, and one with a duplicate key with different values, stay YAML', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/broken.yml': 'name: broken\ncolumns:\n  - name: a\n    dataType: [INT\n',
      'logical-models/twice.yml': 'name: twice\nname: again\ncolumns: []\n',
      'logical-models/dim.yml': DIM,
    }));
    expect(plan.refusals).toEqual([]);
    expect(leftOf(plan, 'logical-models/broken.yml')?.problem).toMatch(/^It does not parse as YAML/);
    expect(leftOf(plan, 'logical-models/twice.yml')).toEqual({ path: 'logical-models/twice.yml', line: 2, problem: 'The key name is written twice with different values (line 2). Keep the one you mean.' });
    expect(plan.deletes).toEqual(['logical-models/dim.yml']);
  });

  it('a .yml with git merge conflicts or tab indentation stays YAML with what to do, at its line', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/merged.yml': 'name: merged\n<<<<<<< HEAD\ncolumns:\n  - name: a\n=======\ncolumns:\n  - name: b\n>>>>>>> branch\n',
      'logical-models/tabbed.yml': 'name: tabbed\ncolumns:\n  - name: a\n\tdataType: INT\n',
      'logical-models/dim.yml': DIM,
    }));
    expect(plan.refusals).toEqual([]);
    expect(leftOf(plan, 'logical-models/merged.yml')).toEqual({
      path: 'logical-models/merged.yml', line: 2,
      problem: 'It has unresolved git merge conflicts (first at line 2). Resolve them (keep one side), then convert again.',
    });
    expect(leftOf(plan, 'logical-models/tabbed.yml')).toEqual({
      path: 'logical-models/tabbed.yml', line: 4,
      problem: 'It does not parse as YAML: line 4 is indented with a tab, and YAML indents with spaces only. Replace the tab with spaces, then convert again.',
    });
  });

  it('a .json diagram that is hybrid or legacy stays JSON, saying what is wrong and how to repair it', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'gold/hybrid.json': JSON.stringify({ schemaVersion: 5, domain: 'h', logical: { models: ['dim', { name: 'inline' }] } }),
      'gold/legacy.json': JSON.stringify({ schemaVersion: 1, models: [] }),
    }));
    expect(plan.refusals).toEqual([]);
    expect(plan.leftAsIs.map((l) => [l.path, l.problem])).toEqual([
      ['gold/hybrid.json', 'It does not load, so it is not converted: it mixes inline table objects with table name references '
        + '(or declares schemaVersion 5 with inline tables). Run "ERD Studio: Migrate Subject Areas to the Central Table Library" to repair it, '
        + 'or edit the file so every entry in "logical.models" is a table name string. Then convert again.'],
      ['gold/legacy.json', 'It does not load, so it is not converted: it uses a pre-v4 layout (schemaVersion < 4 or a top-level "models" array) '
        + 'that is no longer supported. Run "ERD Studio: Migrate Subject Areas to the Central Table Library" to convert it, or move '
        + '"models"/"relationships" under a "logical" section and set "schemaVersion" to 5. Then convert again.'],
    ]);
    // Neither names the format by its internal name.
    for (const l of plan.leftAsIs) expect(l.problem).not.toMatch(/hybrid|legacy file/);
    expect(plan.deletes).toEqual(['logical-models/dim.yml']);
  });

  it('a target table file that exists with other bytes: the .yml stays', async () => {
    const plan = await planDbmlConversion(inputOf({ 'logical-models/dim.yml': DIM, 'tables/dim.dbml': 'Table dim {\n  dim_key INT [pk]\n}\n' }));
    expect(plan.refusals).toEqual([]);
    expect(leftOf(plan, 'logical-models/dim.yml')?.problem).toMatch(/^tables\/dim\.dbml already exists, with other contents than this file converts to/);
    expect(plan.deletes).toEqual([]);
  });

  it('x.json and x.dbml in one layer: x.json stays, unless x.dbml is what x.json converts to', async () => {
    const files = { 'logical-models/dim.yml': DIM, 'gold/sales.json': diagram('sales', 'gold', ['dim']) };
    const clean = await planDbmlConversion(inputOf(files));
    const plan = await planDbmlConversion(inputOf({ ...files, 'gold/sales.dbml': 'Project other {\n}\n' }));
    expect(plan.refusals).toEqual([]);
    expect(leftOf(plan, 'gold/sales.json')?.problem).toMatch(/^gold\/sales\.dbml is also in gold\//);
    expect(plan.deletes).toEqual(['logical-models/dim.yml']);
    const resumed = await planDbmlConversion(inputOf({ ...files, 'gold/sales.dbml': created(clean, 'gold/sales.dbml')! }));
    expect(resumed.refusals).toEqual([]);
    expect(resumed.resumed).toContain('gold/sales.dbml');
    expect(created(resumed, 'gold/sales.dbml')).toBeUndefined();
    expect(resumed.deletes).toContain('gold/sales.json');
  });

  it('relationships two diagrams define differently: both diagrams stay JSON, the tables convert', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key']),
      'gold/a.json': diagram('a', 'gold', ['fct', 'dim'], [{ fromModel: 'fct', ...FCT_REL }]),
      'gold/b.json': diagram('b', 'gold', ['fct', 'dim'], [{ fromModel: 'fct', ...FCT_REL, cardinality: 'one-to-one' }]),
    }));
    expect(plan.refusals).toEqual([]);
    expect(plan.leftAsIs.map((l) => l.path)).toEqual(['gold/a.json', 'gold/b.json']);
    expect(plan.leftAsIs[0].problem).toMatch(/Diagrams define the relationship fct\.dim_key → dim\.dim_key in different ways/);
    expect(plan.deletes).toEqual(['logical-models/dim.yml', 'logical-models/fct.yml']);
  });

  it.each([
    ['target', yml('dim', [['dim_key', 'INT', true], 'label']), { fromColumn: 'k', toModel: 'other', toColumn: 'k', cardinality: 'many-to-one', compositeKey: 'fk_x' }],
    ['cardinality', yml('dim', [['dim_key', 'INT', true], ['label', 'INT', true]]), { fromColumn: 'label', toModel: 'dim', toColumn: 'label', cardinality: 'one-to-one', compositeKey: 'fk_x' }],
  ])('a composite group whose members disagree on the %s: its table stays YAML', async (_label, dim, second) => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': dim,
      'logical-models/other.yml': yml('other', [['k', 'INT', true]]),
      'logical-models/fct.yml': yml('fct', ['dim_key', 'k', 'label'], [{ ...FCT_REL, compositeKey: 'fk_x' }, second]),
    }));
    expect(plan.refusals).toEqual([]);
    expect(leftOf(plan, 'logical-models/fct.yml')?.problem).toMatch(/the composite relationship "fk_x" from fct disagree about the table they point at or their cardinality/);
    expect(plan.deletes).toEqual(['logical-models/dim.yml', 'logical-models/other.yml']);
  });

  it('a relationship whose two ends are the same columns: its table stays YAML', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/employee.yml': yml('employee', [['employee_id', 'INT', true]], [{ fromColumn: 'employee_id', toModel: 'employee', toColumn: 'EMPLOYEE_ID', cardinality: 'many-to-one' }]),
    }));
    expect(plan.refusals).toEqual([]);
    expect(leftOf(plan, 'logical-models/employee.yml')?.problem).toMatch(/employee\.employee_id → employee\.employee_id joins a column to itself/);
    expect(dbmlConversionIsEmpty(plan)).toBe(true);
    expect(describeDbmlConversion(plan)).toMatch(/Nothing else to convert until those files are fixed\.$/);
  });

  it('a diagram whose layer key disagrees with its folder stays JSON', async () => {
    const plan = await planDbmlConversion(inputOf({ 'logical-models/dim.yml': DIM, 'gold/sales.json': diagram('sales', 'silver', ['dim']) }));
    expect(plan.refusals).toEqual([]);
    expect(leftOf(plan, 'gold/sales.json')?.problem).toMatch(/^It says its layer is "silver", but it is in the gold\/ folder/);
  });

  it('an existing DBML table file that does not read: a Ref to it is pending, a diagram keeps it unlinked, and it is listed', async () => {
    const broken = 'Table broken {\n  id INT [pk\n}\n';
    const input = inputOf({
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'id'], [{ fromColumn: 'id', toModel: 'broken', toColumn: 'id', cardinality: 'many-to-one' }]),
      'tables/broken.dbml': broken,
      'gold/s.json': diagram('s', 'gold', ['fct', 'broken']),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(created(plan, 'tables/_relationships.dbml')).toContain('// erd-studio pending: Ref: fct.id >? broken.id\n');
    expect(created(plan, 'gold/s.dbml')).toContain("erd_unlinked_tables: 'broken'");
    expect(leftOf(plan, 'tables/broken.dbml')?.problem).toMatch(/^It is not readable DBML/);
    expect(plan.keptMissing).toEqual([]);
    const untouched = await planDbmlConversion(inputOf({ 'logical-models/dim.yml': DIM, 'tables/broken.dbml': broken }));
    expect(untouched.leftAsIs).toEqual([]);
    expect([...untouched.creates, ...untouched.replaces].map((w) => w.path)).toEqual(['tables/dim.dbml']);
  });

  it('an existing relationships file that does not read: the tables whose relationships go there stay YAML', async () => {
    const files = {
      'logical-models/dim.yml': DIM,
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key'], [FCT_REL]),
    };
    const needed = await planDbmlConversion(inputOf({ ...files, 'tables/_relationships.dbml': 'Ref: a.b >\n' }));
    expect(needed.refusals).toEqual([]);
    expect(leftOf(needed, 'logical-models/fct.yml')?.problem).toMatch(/^Its relationships go in tables\/_relationships\.dbml, which does not read/);
    expect(needed.creates.map((c) => c.path)).toEqual(['tables/dim.dbml']);
    expect(needed.replaces).toEqual([]);
    const elsewhere = await planDbmlConversion(inputOf({ ...files, 'tables/other/_relationships.dbml': 'Ref: a.b >\n' }));
    expect(elsewhere.leftAsIs).toEqual([]);
    expect(elsewhere.replaces).toEqual([]);
  });

  it('an existing DBML diagram that is not writable is left as it is, and draws the same', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'gold/sales.dbml': "Project sales {\n  erd_schema_version: '7'\n}\n\nProject again {\n}\n\nuse { table dim } from '../tables/dim.dbml'\n",
    }));
    expect(plan.refusals).toEqual([]);
    expect(leftOf(plan, 'gold/sales.dbml')?.problem).toMatch(/^It should gain use lines for the converted tables, and ERD Studio can't edit it/);
    expect(plan.creates.map((c) => c.path)).toEqual(['tables/dim.dbml']);
  });
});

describe('planDbmlConversion: what ERD Studio does not read is kept as a // block, with a note', () => {
  it('YAML comments (whole-line and trailing)', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': '# The date dimension.\nname: dim # one row per day\ncolumns:\n  - name: dim_key\n    dataType: INT\n    isPrimaryKey: true\n',
    }));
    expect(created(plan, 'tables/dim.dbml')).toBe([
      keptFromLine('logical-models/dim.yml'),
      '// # The date dimension.',
      '// name: dim # one row per day',
      'Table dim {',
      '  dim_key INT [pk]',
      '}',
      '',
    ].join('\n'));
    expect(plan.notes).toContain('logical-models/dim.yml: its comments are kept as // lines above the Table in tables/dim.dbml; ERD Studio does not read them.');
  });

  it('unknown keys, at the top, on a column and on a relationship', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/fct.yml': [
        'name: fct',
        'owner: data-team',
        'columns:',
        '  - name: dim_key',
        '    dataType: INT',
        '    tests:',
        '      - not_null',
        'relationships:',
        '  - fromColumn: dim_key',
        '    toModel: dim',
        '    toColumn: dim_key',
        '    cardinality: many-to-one',
        '    reviewed: yes',
        '',
      ].join('\n'),
    }));
    expect(created(plan, 'tables/fct.dbml')).toMatch(new RegExp(`^${keptFromLine('logical-models/fct.yml')}\\n// owner: data-team\\n//   - name: dim_key\\n//     tests:\\n//       - not_null\\n//   - fromColumn: dim_key\\n//     reviewed: yes\\nTable fct`));
    expect(plan.notes).toContain('logical-models/fct.yml: keys ERD Studio does not read (owner, columns[].tests, relationships[].reviewed) are kept as // lines above the Table in tables/fct.dbml.');
  });

  it('YAML anchors and aliases: written out in full, the lines that held them kept', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': 'name: dim\ncolumns:\n  - name: dim_key\n    dataType: &key INT\n    isPrimaryKey: true\n  - name: other_key\n    dataType: *key\n',
    }));
    const text = created(plan, 'tables/dim.dbml')!;
    // Each kept line comes with its column's first line, so the comment says which column held it.
    expect(text.split('\n').slice(0, 5)).toEqual([
      keptFromLine('logical-models/dim.yml'), '//   - name: dim_key', '//     dataType: &key INT', '//   - name: other_key', '//     dataType: *key',
    ]);
    expect(text).toContain('  other_key INT\n');
    expect(plan.notes).toContain('logical-models/dim.yml: its YAML anchors and aliases are written out in full; the lines that held them are kept as // lines above the Table in tables/dim.dbml.');
  });

  it('unknown JSON keys above the Project', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'gold/sales.json': diagram('sales', 'gold', ['dim'], [], { $schema: 'https://example.com/s.json', owner: { team: 'bi' } }),
    }));
    expect(created(plan, 'gold/sales.dbml')!.split('\n').slice(0, 4)).toEqual([
      keptFromLine('gold/sales.json'),
      '// "$schema": "https://example.com/s.json"',
      '// "owner": {"team":"bi"}',
      'Project sales {',
    ]);
    expect(plan.notes).toContain('gold/sales.json: keys a DBML diagram does not store ($schema, owner) are kept as // lines above the Project in gold/sales.dbml.');
  });
});

describe('planDbmlConversion: diagram-held relationships and v4 files', () => {
  it('lists each moved relationship with the other diagrams it will now draw in', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key']),
      'gold/a.json': diagram('a', 'gold', ['fct', 'dim'], [{ fromModel: 'fct', ...FCT_REL }]),
      'gold/b.json': diagram('b', 'gold', ['dim', 'fct']),
      'silver/c.json': diagram('c', 'silver', ['dim']),
    }));
    expect(plan.refusals).toEqual([]);
    expect(plan.movedRelationships).toEqual([{ from: 'fct.dim_key', to: 'dim.dim_key', diagrams: ['gold/b.json'] }]);
    expect(refLines(created(plan, 'tables/_relationships.dbml'))).toEqual(['Ref: fct.dim_key >? dim.dim_key']);
    // Neither diagram holds a Ref (D5).
    expect(created(plan, 'gold/a.dbml')).not.toMatch(/^Ref/m);
    expect(describeDbmlConversion(plan)).toContain('Relationships kept in diagram files move to the table library and will also show in these diagrams:\n• fct.dim_key → dim.dim_key: gold/b.json');
  });

  it('surfaces v4 diagrams instead of refusing them', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'gold/old.json': JSON.stringify({ schemaVersion: 4, domain: 'old', logical: { models: [{ name: 'inline', columns: [] }], relationships: [] } }),
    }));
    expect(plan.refusals).toEqual([]);
    expect(plan.v4SubjectAreas).toEqual(['gold/old.json']);
    expect(plan.deletes).not.toContain('gold/old.json');
    expect(describeDbmlConversion(plan)).toContain('Run the v4 → v5 step first (the command does it for you): gold/old.json.');
  });
});

describe('planDbmlConversion: the normalisations of §6.1 step 3, each with its note', () => {
  it('respells ends to the real table and column spelling (composite-and-self employee.yml)', async () => {
    const plan = await planDbmlConversion(readDbmlConversionInput(path.join(CORE_FIXTURES, 'composite-and-self'), '.erd-studio'));
    expect(plan.refusals).toEqual([]);
    expect(refLines(created(plan, 'tables/gold/_relationships.dbml'))).toContain('Ref: employee.mentor_id >? employee.employee_id');
    expect(plan.notes).toContain('logical-models/gold/employee.yml: employee.Mentor_ID → Employee.EMPLOYEE_ID is written as employee.mentor_id → employee.employee_id, the tables\' and columns\' own spelling (DBML compares names exactly).');
  });

  it('a dangling target table: a pending line (D27), read back as the relationship, never a live Ref', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'x_key'], [{ fromColumn: 'x_key', toModel: 'dim_x', toColumn: 'x_key', cardinality: 'many-to-one' }]),
    }));
    expect(plan.refusals).toEqual([]);
    const text = created(plan, 'tables/_relationships.dbml')!;
    expect(text).toContain('// erd-studio pending: Ref: fct.x_key >? dim_x.x_key\n');
    expect(refLines(text)).toEqual([]);
    const reading = readRelationshipsDbml(text);
    expect(reading.refs).toEqual([]);
    expect(reading.pending?.map((r) => r.relationships)).toEqual([[{ fromModel: 'fct', fromColumn: 'x_key', toModel: 'dim_x', toColumn: 'x_key', cardinality: 'many-to-one' }]]);
    expect(plan.notes).toEqual([expect.stringMatching(/^logical-models\/fct\.yml: the relationship fct\.x_key → dim_x\.x_key is kept as a pending line in tables\/_relationships\.dbml \(dim_x has no table file\)\. It draws as before/)]);
    expect(plan.summary.pending).toBe(1);
  });

  it('a dangling target column, beside live Refs in the same file', async () => {
    const input = inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key', 'gone_key'], [
        FCT_REL,
        { fromColumn: 'gone_key', toModel: 'dim', toColumn: 'gone', cardinality: 'many-to-one' },
      ]),
    });
    const plan = await planDbmlConversion(input);
    const text = created(plan, 'tables/_relationships.dbml')!;
    expect(refLines(text)).toEqual(['Ref: fct.dim_key >? dim.dim_key']);
    expect(text).toMatch(/\n\n\/\/ erd-studio pending: Ref: fct\.gone_key >\? dim\.gone\n$/);
    expectCompilesEverywhere(input, plan);
  });

  it.each([
    ['many-to-one, and its backwards copy on the other end', FCT_REL, { fromColumn: 'dim_key', toModel: 'fct', toColumn: 'dim_key', cardinality: 'many-to-one' }, 'Ref: fct.dim_key >? dim.dim_key'],
    ['one-to-one, stored reversed (-)', { ...FCT_REL, cardinality: 'one-to-one' }, { fromColumn: 'dim_key', toModel: 'fct', toColumn: 'dim_key', cardinality: 'one-to-one' }, 'Ref: dim.dim_key ?- fct.dim_key'],
    ['many-to-many, stored reversed (<>)', { ...FCT_REL, cardinality: 'many-to-many' }, { fromColumn: 'dim_key', toModel: 'fct', toColumn: 'dim_key', cardinality: 'many-to-many' }, 'Ref: fct.dim_key <>? dim.dim_key'],
  ])('a link stored in both ends\' files: %s', async (_label, inFct, inDim, ref) => {
    const input = inputOf({
      'logical-models/dim.yml': yml('dim', [['dim_key', 'INT', true], 'label'], [inDim]),
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key'], [inFct]),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(refLines(created(plan, 'tables/_relationships.dbml'))).toEqual([ref]);
    expect(plan.notes).toEqual([expect.stringMatching(/is stored twice \(also in logical-models\/fct\.yml\); it is written once/)]);
    expectCompilesEverywhere(input, plan);
  });

  it('a link stored twice in one file is written once', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key'], [FCT_REL, FCT_REL]),
    }));
    expect(refLines(created(plan, 'tables/_relationships.dbml'))).toEqual(['Ref: fct.dim_key >? dim.dim_key']);
    expect(plan.notes).toEqual([expect.stringMatching(/stored twice/)]);
  });

  it('a library one-to-many is stored canonically, in the many side\'s folder', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': yml('dim', [['dim_key', 'INT', true]], [{ fromColumn: 'dim_key', toModel: 'fct', toColumn: 'dim_key', cardinality: 'one-to-many' }]),
      'logical-models/gold/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key']),
    }));
    expect(created(plan, 'tables/_relationships.dbml')).toBeUndefined();
    expect(refLines(created(plan, 'tables/gold/_relationships.dbml'))).toEqual(['Ref: fct.dim_key >? dim.dim_key']);
    expect(plan.notes).toEqual([expect.stringMatching(/^logical-models\/dim\.yml: the one-to-many dim\.dim_key → fct\.dim_key is stored as the many-to-one fct\.dim_key → dim\.dim_key/)]);
  });

  it('a composite group whose roles disagree takes its first member\'s role', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': yml('dim', [['dim_key', 'INT', true], ['day', 'DATE', true]]),
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key', ['day', 'DATE']], [
        { ...FCT_REL, compositeKey: 'fk_dim', role: 'as of' },
        { fromColumn: 'day', toModel: 'dim', toColumn: 'day', cardinality: 'many-to-one', compositeKey: 'fk_dim', role: 'other' },
      ]),
    }));
    expect(refLines(created(plan, 'tables/_relationships.dbml'))).toEqual(['Ref "as of": fct.(dim_key, day) >? dim.(dim_key, day)']);
    expect(plan.notes).toEqual([expect.stringMatching(/the columns of the composite relationship "fk_dim" from fct have different roles; it takes its first column's role \("as of"\)/)]);
  });

  it('a second sticky note with a used id gets a new one, the same on every plan', async () => {
    const note = (text: string) => ({ id: 'n1', text, x: 10, y: 10, width: 160, height: 80 });
    const input = inputOf({
      'logical-models/dim.yml': DIM,
      'gold/sales.json': JSON.stringify({
        schemaVersion: 5, domain: 'sales', layer: 'gold', logical: { models: ['dim'], relationships: [] },
        viewConfig: { positions: { dim: { x: 0, y: 0 } }, annotations: [note('first'), note('second')] },
      }),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    const names = [...created(plan, 'gold/sales.dbml')!.matchAll(/^Note (\S+)/gm)].map((m) => m[1]);
    expect(names).toHaveLength(2);
    expect(names[0]).toBe('n1');
    expect(names[1]).not.toBe('n1');
    expect(plan.notes).toContain('gold/sales.json: a second sticky note with the id n1 gets a new id (DBML names each Note once).');
    expect(created(await planDbmlConversion(input), 'gold/sales.dbml')).toBe(created(plan, 'gold/sales.dbml'));
    expectCompilesEverywhere(input, plan);
  });
});

describe('planDbmlConversion: mixed, half-converted and library-folder projects', () => {
  it('a mixed project: replaces the existing relationships file and DBML diagram, and compiles clean', async () => {
    const input = readDbmlConversionInput(path.join(FIXTURES, 'mixed'), '.erd-studio');
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(plan.replaces.map((r) => r.path).sort()).toEqual(['gold/sales.dbml', 'tables/gold/_relationships.dbml']);
    expect(refLines(written(plan, 'tables/gold/_relationships.dbml'))).toEqual([
      'Ref: fct_order.customer_key >? dim_customer.customer_key',
      'Ref: fct_refund.order_line_id >? fct_order.order_line_id',
    ]);
    // The diagram gains the use line of the relationships file this run creates (its member dim_region lives there).
    expect(written(plan, 'gold/sales.dbml')).toContain("use * from '../tables/_relationships.dbml'\n");
    expect(plan.creates.map((c) => c.path)).toEqual([
      'tables/_relationships.dbml', 'tables/fct_visit.dbml', 'tables/gold/fct_refund.dbml', 'silver/visits.dbml', 'silver/visits.dbdiagram',
    ]);
    expect(plan.deletes.sort()).toEqual(['silver/visits.json', 'tables/fct_visit.yml', 'tables/gold/fct_refund.yml']);
    expectCompilesEverywhere(input, plan);
  });

  it('a Ref already written against a YAML table gets its use line when that table is converted', async () => {
    // The header Convert and the canvas write (a comment right above a use line belongs to that line).
    const header = '// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.\n';
    const input = inputOf({
      'tables/gold/fct_order.dbml': 'Table fct_order {\n  id INT [pk]\n  new_key INT\n}\n',
      'tables/gold/dim_new.yml': yml('dim_new', [['new_key', 'INT', true]]),
      'tables/gold/_relationships.dbml': `${header}use { table fct_order } from './fct_order.dbml'\n\nRef: fct_order.new_key > dim_new.new_key // written before converting\n`,
      'gold/sales.dbml': "Project sales {\n  erd_schema_version: '7'\n}\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\nuse * from '../tables/gold/_relationships.dbml'\n",
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(created(plan, 'tables/gold/dim_new.dbml')).toBeDefined();
    expect(written(plan, 'tables/gold/_relationships.dbml')).toBe(
      `${header}use { table dim_new } from './dim_new.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\nRef: fct_order.new_key > dim_new.new_key // written before converting\n`,
    );
    expectCompilesEverywhere(input, plan);
  });

  it('a half-applied run: plans the rest, lists what is already there, and doctor says to finish it', async () => {
    const input = readDbmlConversionInput(path.join(FIXTURES, 'half-converted'), '.erd-studio');
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    // The relationships file the earlier run wrote first (D23) holds what this run would write there.
    expect(plan.resumed).toEqual(['tables/gold/employee.dbml', 'tables/gold/_relationships.dbml']);
    expect(plan.creates.map((c) => c.path)).toEqual(['tables/gold/pit_customer.dbml', 'tables/gold/sat_customer.dbml', 'gold/vault.dbml', 'gold/vault.dbdiagram']);
    expect(plan.replaces).toEqual([]);
    expect(plan.deletes).toContain('logical-models/gold/employee.yml');
    // The rest is exactly what a fresh run writes (the twin).
    const twin = path.join(CORE_FIXTURES, 'dbml', 'composite-and-self', '.erd-studio');
    for (const c of plan.creates) expect(c.text).toBe(fs.readFileSync(path.join(twin, c.path), 'utf-8'));
    expect(describeDbmlConversion(plan)).toContain('Already converted by an earlier run: tables/gold/employee.dbml, tables/gold/_relationships.dbml.');

    const doctor = await runDoctor({ project: path.join(FIXTURES, 'half-converted'), semanticDir: '.erd-studio', noDbt: true });
    expect(doctor.erd.dbmlConversion?.resumed).toEqual(['tables/gold/employee.dbml', 'tables/gold/_relationships.dbml']);
    expect(doctor.nextSteps.map((s) => s.id)).toContain('finish-dbml-conversion');
    // The yml beside the DBML file the earlier run wrote is no conflict to settle by hand.
    expect(doctor.erd.namingConflicts.map((c) => c.name)).toEqual(['employee']);
    expect(doctor.nextSteps.map((s) => s.id)).not.toContain('resolve-naming-conflicts');
    // Nor a format conflict: the DBML file holds exactly what Convert writes, so finishing settles the pair.
    expect(doctor.erd.dbmlProblems.filter((p) => p.code === 'formatConflict').length).toBeGreaterThan(0);
    expect(doctor.nextSteps.map((s) => s.id)).not.toContain('resolve-format-conflicts');
    expect(doctor.nextSteps.find((s) => s.id === 'finish-dbml-conversion')).toMatchObject({
      why: 'A conversion to DBML stopped part way. Run ERD Studio: Convert Project to DBML again to finish it; it checks every file first.',
      command: null,
    });
  });

  it('doctor previews the conversion when storage is not dbml, and the naming migration only in a YAML project', async () => {
    const yaml = await runDoctor({ project: path.join(CORE_FIXTURES, 'composite-and-self'), semanticDir: '.erd-studio', noDbt: true });
    expect(yaml.erd.storage).toBe('yaml');
    expect(yaml.erd.dbmlConversion).toMatchObject({ tables: 3, diagrams: 1, relationshipsFiles: 1, relationships: 4, refusals: [], v4SubjectAreas: [], resumed: [] });
    expect(yaml.erd.dbmlConversion!.preview).toMatch(/^Write 3 tables, 1 diagram and 4 relationships \(in 1 relationships file\) as DBML:/);
    expect(yaml.erd.namingMigration).toBeDefined();
    expect(yaml.nextSteps.map((s) => s.id)).not.toContain('finish-dbml-conversion');

    const mixed = await runDoctor({ project: path.join(FIXTURES, 'mixed'), semanticDir: '.erd-studio', noDbt: true });
    expect(mixed.erd.storage).toBe('mixed');
    expect(mixed.erd.dbmlConversion).toMatchObject({ tables: 2, diagrams: 1, refusals: [] });
    expect(mixed.erd.namingMigration).toBeUndefined();

    const left = await runDoctor({ project: path.join(CORE_FIXTURES, 'library-relationships'), semanticDir: '.erd-studio', noDbt: true });
    expect(left.erd.dbmlConversion!.refusals).toEqual([]);
    expect(left.erd.dbmlConversion!.leftAsIs).toEqual([expect.objectContaining({ path: 'gold/sales.json' })]);
    expect(left.erd.dbmlConversion!.preview).toMatch(/^Left as JSON until fixed/);

    const dbml = await runDoctor({ project: path.join(CORE_FIXTURES, 'dbml', 'showcase'), semanticDir: '.erd-studio', noDbt: true });
    expect(dbml.erd.storage).toBe('dbml');
    expect(dbml.erd.dbmlConversion).toBeUndefined();
  });

  it('a DBML project whose pending lines and unlinked members are ready: doctor says to run Convert, and Convert settles them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-settle-'));
    try {
      const dir = path.join(root, '.erd-studio');
      const write = (rel: string, text: string): void => {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
      };
      write('layers.json', LAYERS);
      write('tables/dim.dbml', 'Table dim {\n  dim_key INT [pk]\n}\n');
      write('tables/fct.dbml', 'Table fct {\n  fct_key INT [pk]\n  dim_key INT\n}\n');
      // Add from dbt made fct after Convert: its pending lines can be live now.
      write('tables/_relationships.dbml', "// ERD Studio relationships.\nuse { table dim } from './dim.dbml'\n\n// erd-studio pending: Ref: fct.dim_key >? dim.dim_key\n");
      write('gold/c.dbml', "Project c {\n  erd_schema_version: '7'\n  erd_unlinked_tables: 'fct'\n}\n\nuse { table dim } from '../tables/dim.dbml'\nuse * from '../tables/_relationships.dbml'\n");
      const doctor = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true });
      expect(doctor.erd.storage).toBe('dbml');
      expect(doctor.erd.dbmlConversion?.refusals).toEqual([]);
      expect(doctor.nextSteps.find((x) => x.id === 'finish-dbml-conversion')?.why).toMatch(/^Some pending relationships or diagram members are ready to settle.*Run ERD Studio: Convert Project to DBML/);
      const plan = await planDbmlConversion(readDbmlConversionInput(root, '.erd-studio'));
      expect(plan.refusals).toEqual([]);
      const rel = plan.replaces.find((r) => r.path === 'tables/_relationships.dbml')!.text;
      expect(rel).toContain('Ref: fct.dim_key >? dim.dim_key\n');
      expect(rel).not.toContain('erd-studio pending');
      const diagramText = plan.replaces.find((r) => r.path === 'gold/c.dbml')!.text;
      expect(diagramText).toContain("use { table fct } from '../tables/fct.dbml'");
      expect(diagramText).not.toContain('erd_unlinked_tables');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a half-applied run whose target has other bytes: that .yml stays, the rest finishes', async () => {
    const input = readDbmlConversionInput(path.join(FIXTURES, 'half-converted'), '.erd-studio');
    const changed = { ...input, files: input.files.map((f) => (f.path === 'tables/gold/employee.dbml' ? { ...f, text: `${f.text}// edited\n` } : f)) };
    const plan = await planDbmlConversion(changed);
    expect(plan.refusals).toEqual([]);
    expect(plan.leftAsIs.map((l) => [l.path, l.problem])).toEqual([[
      'logical-models/gold/employee.yml', expect.stringMatching(/^tables\/gold\/employee\.dbml already exists, with other contents than this file converts to/),
    ]]);
    expect(plan.deletes).not.toContain('logical-models/gold/employee.yml');
  });

  it('a library folder that is not a layer gives no false self-check refusal', async () => {
    const input = inputOf({
      'logical-models/finance/dim_account.yml': yml('dim_account', [['account_key', 'INT', true]]),
      'logical-models/finance/fct_ledger.yml': yml('fct_ledger', [['ledger_key', 'INT', true], 'account_key'], [{ fromColumn: 'account_key', toModel: 'dim_account', toColumn: 'account_key', cardinality: 'many-to-one' }]),
      'gold/ledger.json': diagram('ledger', 'gold', ['fct_ledger', 'dim_account']),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(refLines(created(plan, 'tables/finance/_relationships.dbml'))).toEqual(['Ref: fct_ledger.account_key >? dim_account.account_key']);
    expect(created(plan, 'gold/ledger.dbml')).toContain("use * from '../tables/finance/_relationships.dbml'");
    expectCompilesEverywhere(input, plan);
  });

  it('a project already stored as DBML plans nothing', async () => {
    const plan = await planDbmlConversion(readDbmlConversionInput(path.join(CORE_FIXTURES, 'dbml', 'showcase'), '.erd-studio'));
    expect(plan.refusals).toEqual([]);
    expect([...plan.creates, ...plan.replaces, ...plan.deletes]).toEqual([]);
    expect(describeDbmlConversion(plan)).toBe('Nothing to convert: this project is already stored as DBML.');
  });

  it('reads a byte-order mark off a source and still converts it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-convert-bom-'));
    try {
      fs.mkdirSync(path.join(root, '.erd-studio', 'logical-models'), { recursive: true });
      fs.writeFileSync(path.join(root, '.erd-studio', 'logical-models', 'dim.yml'), `﻿${DIM}`);
      const input = readDbmlConversionInput(root, '.erd-studio');
      expect(input.files.find((f) => f.path === 'logical-models/dim.yml')).toMatchObject({ hadBom: true, text: DIM });
      const plan = await planDbmlConversion(input);
      expect(created(plan, 'tables/dim.dbml')).toBe('Table dim {\n  dim_key INT [pk]\n  label INT\n}\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('planDbmlConversion: S7 review, round 1', () => {
  /** The project after `plan` is applied, as the planner's input. */
  const applied = (input: DbmlConversionInput, plan: DbmlConversionPlan, options: { deletes?: boolean; only?: string[] } = {}): DbmlConversionInput => {
    const files: Record<string, string> = {};
    for (const f of input.files) files[f.path] = f.text;
    for (const w of [...plan.creates, ...plan.replaces]) if (!options.only || options.only.includes(w.path)) files[w.path] = w.text;
    if (options.deletes) for (const d of plan.deletes) delete files[d];
    return inputOf(Object.fromEntries(Object.entries(files).filter(([p]) => p !== 'layers.json')));
  };
  const SELF_CHECK = /please report this/;

  it('a dangling target column whose owner a diagram draws: no false self-check refusal, the mark named in the note', async () => {
    const input = inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key'], [{ fromColumn: 'dim_key', toModel: 'dim', toColumn: 'nope', cardinality: 'many-to-one' }]),
      'gold/d.json': diagram('d', 'gold', ['fct', 'dim']),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(created(plan, 'tables/_relationships.dbml')).toContain('// erd-studio pending: Ref: fct.dim_key >? dim.nope\n');
    expect(plan.notes).toEqual(['logical-models/fct.yml: the relationship fct.dim_key → dim.nope is kept as a pending line in tables/_relationships.dbml (dim has no column nope). '
      + 'It draws as before, and becomes a live Ref when both ends have table files with those columns.']);
    expectCompilesEverywhere(input, plan);
  });

  it('a dangling target column on a column that declares isForeignKey keeps its mark (and the note says nothing of it)', async () => {
    const fct = 'name: fct\ncolumns:\n  - name: dim_key\n    dataType: INT\n    isForeignKey: true\nrelationships:\n  - fromColumn: dim_key\n    toModel: dim\n    toColumn: nope\n';
    const plan = await planDbmlConversion(inputOf({ 'logical-models/dim.yml': DIM, 'logical-models/fct.yml': fct, 'gold/d.json': diagram('d', 'gold', ['fct', 'dim']) }));
    expect(plan.refusals).toEqual([]);
    expect(created(plan, 'tables/fct.dbml')).toContain("foreign_key: 'true'");
    expect(plan.notes).toEqual([expect.stringMatching(/kept as a pending line .* It draws as before/)]);
  });

  it('a dangling from column (renamed in the yml, not in its relationship) whose tables a diagram draws: no false self-check refusal (S7 review, round 2)', async () => {
    const input = inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/fct.yml': yml('fct', ['k'], [{ fromColumn: 'gone', toModel: 'dim', toColumn: 'dim_key', cardinality: 'many-to-one' }]),
      'gold/d.json': diagram('d', 'gold', ['fct', 'dim']),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(created(plan, 'tables/_relationships.dbml')).toContain('// erd-studio pending: Ref: fct.gone >? dim.dim_key\n');
    expect(plan.notes).toEqual([
      'logical-models/fct.yml: the relationship fct.gone → dim.dim_key is kept as a pending line in tables/_relationships.dbml (fct has no column gone). '
        + 'It draws as before, and becomes a live Ref when both ends have table files with those columns.',
    ]);
    expectCompilesEverywhere(input, plan);
  });

  it('a dangling from column on a one-to-many and in a diagram file\'s own list: no false self-check refusal', async () => {
    const input = inputOf({
      'logical-models/dim.yml': yml('dim', [['dim_key', 'INT', true], 'label'], [{ fromColumn: 'dim_key', toModel: 'fct', toColumn: 'gone', cardinality: 'one-to-many' }]),
      'logical-models/fct.yml': yml('fct', ['k', 'dim_key'], [{ fromColumn: 'dim_key', toModel: 'dim', toColumn: 'dim_key', cardinality: 'many-to-one' }]),
      'gold/d.json': diagram('d', 'gold', ['fct', 'dim'], [{ fromModel: 'fct', fromColumn: 'old_key', toModel: 'dim', toColumn: 'dim_key', cardinality: 'many-to-one' }]),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    const text = created(plan, 'tables/_relationships.dbml')!;
    expect(refLines(text)).toEqual(['Ref: fct.dim_key >? dim.dim_key']);
    expect(text).toContain('// erd-studio pending: Ref: fct.old_key >? dim.dim_key\n');
    expectCompilesEverywhere(input, plan);
  });

  it('a composite with one dangling member, drawn in a diagram', async () => {
    const input = inputOf({
      'logical-models/dim.yml': yml('dim', [['a', 'INT', true], ['b', 'INT', true]]),
      'logical-models/fct.yml': yml('fct', ['a', 'b'], [
        { fromColumn: 'a', toModel: 'dim', toColumn: 'a', cardinality: 'many-to-one', compositeKey: 'fk' },
        { fromColumn: 'b', toModel: 'dim', toColumn: 'gone', cardinality: 'many-to-one', compositeKey: 'fk' },
      ]),
      'gold/s.json': diagram('s', 'gold', ['fct', 'dim']),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals.filter((r) => SELF_CHECK.test(r))).toEqual([]);
  });

  it('a diagram-held relationship to a missing column: pending in the library, no false self-check refusal', async () => {
    const input = inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key']),
      'gold/d.json': diagram('d', 'gold', ['fct', 'dim'], [{ fromModel: 'fct', fromColumn: 'dim_key', toModel: 'dim', toColumn: 'nope', cardinality: 'many-to-one' }]),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(created(plan, 'tables/_relationships.dbml')).toContain('// erd-studio pending: Ref: fct.dim_key >? dim.nope\n');
    expect(plan.notes).toEqual([expect.stringMatching(/^gold\/d\.json: the relationship fct\.dim_key → dim\.nope is kept as a pending line/)]);
    expectCompilesEverywhere(input, plan);
  });

  it('a diagram-held relationship from a table with no file: a pending line in the diagram itself, drawn as before (D27)', async () => {
    const input = inputOf({
      'logical-models/gold/dim.yml': DIM,
      'gold/d.json': diagram('d', 'gold', ['dim', 'gone'], [{ fromModel: 'gone', fromColumn: 'dim_key', toModel: 'dim', toColumn: 'dim_key', cardinality: 'many-to-one' }]),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(created(plan, 'tables/gold/_relationships.dbml')).toBeUndefined();
    const text = created(plan, 'gold/d.dbml')!;
    expect(text).toContain("erd_unlinked_tables: 'gone'");
    expect(text).toMatch(/\n\n\/\/ erd-studio pending: Ref: gone\.dim_key >\? dim\.dim_key\n$/);
    expect(plan.keptMissing).toEqual([{ diagram: 'gold/d.dbml', tables: ['gone'] }]);
    expect(plan.notes).toEqual(['gold/d.json: 1 relationship whose foreign-key table has no table file is kept in gold/d.dbml as pending lines; it draws as before.']);
    expectCompilesEverywhere(input, plan);
  });

  it('a resume with a dangling relationship writes nothing twice, and the relationships file counts as resumed', async () => {
    const input = inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key', 'gone_key'], [
        FCT_REL,
        { fromColumn: 'gone_key', toModel: 'gone', toColumn: 'gone_key', cardinality: 'many-to-one' },
      ]),
      'gold/d.json': diagram('d', 'gold', ['fct', 'dim']),
    });
    const first = await planDbmlConversion(input);
    expect(first.refusals).toEqual([]);
    const relationships = created(first, 'tables/_relationships.dbml')!;
    expect(relationships.match(/\/\/ erd-studio pending:/g)).toHaveLength(1);

    // Every create landed, no delete: the re-plan is the rest of the first plan, byte for byte.
    const all = await planDbmlConversion(applied(input, first));
    expect(all.refusals).toEqual([]);
    expect(all.creates).toEqual([]);
    expect(all.replaces).toEqual([]);
    expect(all.resumed.sort()).toEqual(first.creates.map((c) => c.path).sort());
    expect(all.deletes.sort()).toEqual(first.deletes.sort());

    // Only the relationships file landed (D23 writes it first).
    const some = await planDbmlConversion(applied(input, first, { only: ['tables/_relationships.dbml'] }));
    expect(some.refusals).toEqual([]);
    expect(some.replaces).toEqual([]);
    expect(some.resumed).toEqual(['tables/_relationships.dbml']);
    expect(some.creates.map((c) => c.path).sort()).toEqual(first.creates.map((c) => c.path).filter((p) => p !== 'tables/_relationships.dbml').sort());
  });

  it('doctor raises finish-dbml-conversion when only the relationships file of an earlier run landed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-convert-resume-'));
    try {
      const files = {
        'logical-models/dim.yml': DIM,
        'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key'], [FCT_REL]),
        'gold/d.json': diagram('d', 'gold', ['fct', 'dim']),
      };
      const first = await planDbmlConversion(inputOf(files));
      const write = (p: string, text: string): void => {
        fs.mkdirSync(path.dirname(path.join(root, '.erd-studio', p)), { recursive: true });
        fs.writeFileSync(path.join(root, '.erd-studio', p), text);
      };
      write('layers.json', LAYERS);
      for (const [p, text] of Object.entries(files)) write(p, text);
      write('tables/_relationships.dbml', created(first, 'tables/_relationships.dbml')!);
      const doctor = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true });
      expect(doctor.erd.dbmlConversion?.resumed).toEqual(['tables/_relationships.dbml']);
      expect(doctor.nextSteps.map((s) => s.id)).toContain('finish-dbml-conversion');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a half-applied run, then a YAML relationship edit: the YAML list wins, with no self-check refusal', async () => {
    const files = {
      'logical-models/dim.yml': DIM,
      'logical-models/other.yml': yml('other', [['other_key', 'INT', true]]),
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key', 'other_key'], [
        FCT_REL,
        { fromColumn: 'other_key', toModel: 'other', toColumn: 'other_key', cardinality: 'many-to-one' },
      ]),
      'gold/d.json': diagram('d', 'gold', ['fct', 'dim', 'other']),
    };
    const first = await planDbmlConversion(inputOf(files));
    expect(first.refusals).toEqual([]);
    const half = applied(inputOf(files), first, { only: ['tables/_relationships.dbml'] });
    const edit = (from: string, to: string): DbmlConversionInput => ({
      ...half,
      files: half.files.map((f) => (f.path === 'logical-models/fct.yml' ? { ...f, text: f.text.replace(from, to) } : f)),
    });

    // The user removes a relationship from the yml the canvas still reads.
    const removed = await planDbmlConversion(edit('  - fromColumn: other_key\n    toModel: other\n    toColumn: other_key\n    cardinality: many-to-one\n', ''));
    expect(removed.refusals).toEqual([]);
    expect(refLines(written(removed, 'tables/_relationships.dbml'))).toEqual(['Ref: fct.dim_key >? dim.dim_key']);
    expect(removed.notes).toContain('tables/_relationships.dbml: the Ref fct.other_key → other.other_key belongs to fct, which is still a YAML table (logical-models/fct.yml), so ERD Studio never drew it; logical-models/fct.yml\'s relationships replace it.');
    expect(removed.resumed).not.toContain('tables/_relationships.dbml');

    // Or changes a cardinality: written as the yml has it, never "stored twice".
    const changed = await planDbmlConversion(edit('toColumn: dim_key\n    cardinality: many-to-one', 'toColumn: dim_key\n    cardinality: one-to-one'));
    expect(changed.refusals).toEqual([]);
    expect(refLines(written(changed, 'tables/_relationships.dbml'))).toEqual(['Ref: dim.dim_key ?- fct.dim_key', 'Ref: fct.other_key >? other.other_key']);
    expect(changed.notes.filter((n) => /stored twice/.test(n))).toEqual([]);
  });

  it('a stale layout file beside a diagram with no positions: the diagram stays JSON', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'gold/d.json': JSON.stringify({ schemaVersion: 5, domain: 'd', layer: 'gold', logical: { models: ['dim'], relationships: [] }, viewConfig: {} }),
      'gold/d.dbdiagram': JSON.stringify({ version: 1, tablePositions: [{ name: 'dim', schemaName: 'public', x: 999, y: 999 }] }),
    }));
    expect(plan.refusals).toEqual([]);
    expect(plan.leftAsIs).toEqual([{ path: 'gold/d.json', problem: expect.stringMatching(/^gold\/d\.dbdiagram already exists, and this diagram has no positions or sticky notes to put in it/) }]);
    expect(plan.deletes).toEqual(['logical-models/dim.yml']);
  });

  it('values the reader ignores are kept as // lines with a note, never dropped silently', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/fct.yml': 'name: fct\ncolumns:\n  - name: dim_key\n    dataType: INT\nrelationships:\n  - fromColumn: dim_key\n    toModel: dim\n',
      'logical-models/t.yml': [
        'name: t',
        'rationale: Chosen because finance asked for daily grain',
        'meta: owner-team-x',
        'columns:',
        '  - name: a',
        '    dataType: INT',
        '    scdType: two',
        '  - b_column_as_string',
        'relationships:',
        '  - fromModel: other_table',
        '    fromColumn: a',
        '    toModel: dim',
        '    toColumn: dim_key',
        '    cardinality: lots-to-one',
        '',
      ].join('\n'),
    }));
    expect(plan.refusals).toEqual([]);
    expect(created(plan, 'tables/fct.dbml')).toBe([
      keptFromLine('logical-models/fct.yml'),
      '//   - fromColumn: dim_key',
      '//     toModel: dim',
      'Table fct {',
      '  dim_key INT',
      '}',
      '',
    ].join('\n'));
    expect(plan.notes).toContain('logical-models/fct.yml: values ERD Studio does not read (relationships[0]) are kept as // lines above the Table in tables/fct.dbml; they were not drawn before and are not drawn now.');
    const t = created(plan, 'tables/t.dbml')!;
    for (const line of ['rationale: Chosen because finance asked for daily grain', 'meta: owner-team-x', '    scdType: two', '  - b_column_as_string', '  - fromModel: other_table', '    cardinality: lots-to-one']) {
      expect(t).toContain(`// ${line}\n`);
    }
    expect(plan.notes).toContain('logical-models/t.yml: values ERD Studio does not read (rationale, meta, columns[0].scdType, columns[1], relationships[0].fromModel, relationships[0].cardinality) are kept as // lines above the Table in tables/t.dbml; they were not drawn before and are not drawn now.');
  });

  it.each([
    ['the no-layers core fixture (logical.viewConfig)', () => readDbmlConversionInput(path.join(CORE_FIXTURES, 'no-layers'), '.erd-studio')],
    ['an inline stage-level viewConfig', () => inputOf({
      'logical-models/dim.yml': DIM,
      'gold/d.json': JSON.stringify({ schemaVersion: 5, domain: 'd', layer: 'gold', logical: { models: ['dim'], relationships: [], viewConfig: { positions: { dim: { x: 520, y: 40 } }, annotations: [{ id: 'a1', text: 'Note', x: 1, y: 2 }] } } }),
    })],
  ])('the stage-level view config older versions wrote: %s', async (_label, inputFn) => {
    const input = inputFn();
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    const layout = plan.creates.find((c) => c.path.endsWith('.dbdiagram'));
    expect(layout?.text).toContain('"x": 520');
    expect(plan.creates.find((c) => c.path.endsWith('.dbml') && !c.path.startsWith('tables/'))!.text).toMatch(/^Note a1/m);
    expect(plan.notes.join('\n')).not.toMatch(/logical\.viewConfig/);
    expectCompilesEverywhere(input, plan);
  });

  it('a diagram member spelled in another case than its table: written with the table\'s spelling, under Handled for you (D26)', async () => {
    const input = inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key']),
      'gold/sales.json': JSON.stringify({
        schemaVersion: 5, domain: 'sales', layer: 'gold',
        logical: { models: ['Dim', 'FCT'], relationships: [{ fromModel: 'FCT', fromColumn: 'DIM_KEY', toModel: 'Dim', toColumn: 'dim_key', cardinality: 'many-to-one' }] },
        // The canvas draws each table at the position keyed by its own spelling: dim's here, FCT's never.
        viewConfig: { positions: { dim: { x: 10, y: 20 }, Dim: { x: 500, y: 500 }, FCT: { x: 900, y: 900 } } },
      }),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(plan.handled).toEqual([
      { path: 'gold/sales.json', text: 'It lists Dim, which is the table dim; the DBML diagram names it dim.' },
      { path: 'gold/sales.json', text: 'It lists FCT, which is the table fct; the DBML diagram names it fct.' },
    ]);
    const text = created(plan, 'gold/sales.dbml')!;
    expect(text).toContain("use { table dim } from '../tables/dim.dbml'\nuse { table fct } from '../tables/fct.dbml'\n");
    // Positions keep their keys: renaming FCT's to fct would move fct from where the canvas places it today.
    expect(JSON.parse(created(plan, 'gold/sales.dbdiagram')!).defaultView.tablePositions.map((p: { name: string }) => p.name)).toEqual(['dim', 'Dim', 'FCT']);
    expect(describeDbmlConversion(plan)).toMatch(/^Handled for you:\n• gold\/sales\.json: It lists Dim/);
    expectCompilesEverywhere(input, plan);
  });

  it('an empty rationale (or one with only keys ERD Studio does not read) converts', async () => {
    for (const rationale of ['rationale: {}', 'rationale:\n  grain: because']) {
      const plan = await planDbmlConversion(inputOf({
        'logical-models/t.yml': `name: t\n${rationale}\ncolumns:\n  - name: a\n    dataType: INT\n`,
        'gold/s.json': diagram('s', 'gold', ['t']),
      }));
      expect(plan.refusals).toEqual([]);
    }
  });

  it('an existing DBML table the plan must change that is not writable (an inline ref:) is refused, by name', async () => {
    const plan = await planDbmlConversion(inputOf({
      'tables/dim.dbml': 'Table dim {\n  dim_key INT [pk]\n  other_key INT [ref: > other.other_key]\n}\n',
      'logical-models/other.yml': yml('other', [['other_key', 'INT', true]]),
      'logical-models/fct.yml': yml('fct', ['dim_key']),
      'gold/d.json': diagram('d', 'gold', ['fct', 'dim'], [{ fromModel: 'dim', fromColumn: 'dim_key', toModel: 'fct', toColumn: 'dim_key', cardinality: 'one-to-one' }]),
    }));
    expect(plan.refusals).toEqual([expect.stringMatching(/^Convert can't write the table library: tables\/dim\.dbml: Move `ref: > other\.other_key`/)]);
    expect(plan.creates).toEqual([]);
    // Untouched by the plan, it is no refusal.
    const untouched = await planDbmlConversion(inputOf({
      'tables/dim.dbml': 'Table dim {\n  dim_key INT [pk]\n  other_key INT [ref: > other.other_key]\n}\n',
      'logical-models/other.yml': yml('other', [['other_key', 'INT', true]]),
    }));
    expect(untouched.refusals).toEqual([]);
  });

  it('two columns of one name: the .yml stays, named, never the file Convert would write', async () => {
    const plan = await planDbmlConversion(inputOf({ 'logical-models/t.yml': 'name: t\ncolumns:\n  - name: a\n    dataType: INT\n  - name: a\n    dataType: TEXT\n' }));
    expect(plan.refusals).toEqual([]);
    expect(plan.leftAsIs).toEqual([{ path: 'logical-models/t.yml', line: 5, problem: 'It lists the column a more than once, and a DBML table names each column once. Remove or rename the copy.' }]);
  });

  it('a file left as it is carries the line to open: the name: that is not the filename, the JSON mistake, the first conflict marker', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim_store_format.yml': '# store formats\nname: dim_store_type\ncolumns:\n  - name: a\n    dataType: INT\n',
      'gold/trailing.json': '{\n  "schemaVersion": 5,\n  "domain": "trailing",\n  "layer": "gold",\n  "logical": { "models": ["x",\n  ] }\n}\n',
      'gold/conflicted.json': '{\n  "schemaVersion": 5,\n<<<<<<< HEAD\n  "domain": "conflicted",\n=======\n  "domain": "c2",\n>>>>>>> other\n  "layer": "gold"\n}\n',
    }));
    expect(plan.refusals).toEqual([]);
    expect(leftOf(plan, 'logical-models/dim_store_format.yml')).toMatchObject({ line: 2 });
    expect(leftOf(plan, 'gold/trailing.json')).toEqual({
      path: 'gold/trailing.json', line: 5,
      problem: 'It is not valid JSON: at line 5, column 30: there is a comma after the last item, before a closing } or ]. Fix it, then convert again.',
    });
    expect(leftOf(plan, 'gold/conflicted.json')).toEqual({
      path: 'gold/conflicted.json', line: 3,
      problem: 'It has unresolved git merge conflicts (first at line 3). Resolve them (keep one side; if only positions conflict, either is safe), then convert again.',
    });
  });

  it('sticky notes the canvas never drew (no id, or no position) are kept as // lines, and doctor still runs', async () => {
    const files = {
      'logical-models/dim.yml': DIM,
      'gold/sales.json': JSON.stringify({
        schemaVersion: 5, domain: 'sales', layer: 'gold', logical: { models: ['dim'], relationships: [] },
        viewConfig: { positions: { dim: { x: 1, y: 2 }, bad: { x: 'a', y: 2 } }, annotations: [{ text: 'no id', x: 5, y: 5 }, { id: 'n1', text: 'no xy' }, { id: 'n2', text: 'kept', x: 3, y: 4 }] },
      }),
    };
    const plan = await planDbmlConversion(inputOf(files));
    expect(plan.refusals).toEqual([]);
    const text = created(plan, 'gold/sales.dbml')!;
    expect(text).toContain('// "viewConfig.annotations[0]": {"text":"no id","x":5,"y":5}\n');
    expect(text).toContain('// "viewConfig.annotations[1]": {"id":"n1","text":"no xy"}\n');
    expect(text).toContain('// "viewConfig.positions.bad": {"x":"a","y":2}\n');
    expect([...text.matchAll(/^Note (\S+)/gm)].map((m) => m[1])).toEqual(['n2']);
    expect(plan.notes).toContain('gold/sales.json: positions and sticky notes ERD Studio does not draw (viewConfig.positions.bad, viewConfig.annotations[0], viewConfig.annotations[1]: no id, or no numeric x and y) are kept as // lines above the Project in gold/sales.dbml.');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-convert-notes-'));
    try {
      for (const [p, t] of Object.entries({ 'layers.json': LAYERS, ...files })) {
        fs.mkdirSync(path.dirname(path.join(root, '.erd-studio', p)), { recursive: true });
        fs.writeFileSync(path.join(root, '.erd-studio', p), t);
      }
      const doctor = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true });
      expect(doctor.erd.dbmlConversion?.refusals).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('planDbmlConversion: smoother and deterministic (D26/D27, pre-release 1.9.0 feedback)', () => {
  /** The files of `input` after `plan` is applied (creates, replaces and deletes). */
  const after = (input: DbmlConversionInput, plan: DbmlConversionPlan): Record<string, string> => {
    const files: Record<string, string> = {};
    for (const f of input.files) files[f.path] = f.text;
    for (const d of plan.deletes) delete files[d];
    for (const w of [...plan.creates, ...plan.replaces]) files[w.path] = w.text;
    delete files['layers.json'];
    return files;
  };
  /** A diagram's display through core's loader (case-insensitive paths, every library folder probed). */
  const displayOf = async (files: Record<string, string>, domainPath: string): Promise<DisplaySubjectArea> => {
    const all: Record<string, string> = { 'layers.json': LAYERS, ...files };
    const lower = new Map(Object.keys(all).map((k) => [k.toLowerCase(), k]));
    return loadDisplaySubjectArea({
      domainPath, readOnly: true, warn: () => {}, dbml: dbmlStorageReader,
      readFile: async (p) => all[p] ?? all[lower.get(p.toLowerCase()) ?? ''] ?? null,
    });
  };
  const DUPLICATE_SAME = 'name: fct\ncolumns:\n  - name: fct_key\n    dataType: INT\n    isPrimaryKey: true\n    isPrimaryKey: true\n  - name: dim_key\n    dataType: INT\nrelationships:\n  - fromColumn: dim_key\n    toModel: dim\n    toColumn: dim_key\n    cardinality: many-to-one\n';
  const DUPLICATE_DIFFERENT = 'name: other\ndescription: one\ndescription: two\ncolumns:\n  - name: other_key\n    dataType: INT\n  - name: dim_key\n    dataType: INT\nrelationships:\n  - fromColumn: dim_key\n    toModel: dim\n    toColumn: dim_key\n    cardinality: many-to-one\n';

  it('a YAML table whose duplicate keys all hold the same value converts as if each were written once (Handled for you)', async () => {
    const input = inputOf({ 'logical-models/dim.yml': DIM, 'logical-models/fct.yml': DUPLICATE_SAME, 'gold/s.json': diagram('s', 'gold', ['fct', 'dim']) });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(plan.leftAsIs).toEqual([]);
    expect(plan.handled).toEqual([{ path: 'logical-models/fct.yml', text: 'The key isPrimaryKey is written twice with the same value (line 6); converted as if written once.' }]);
    expect(created(plan, 'tables/fct.dbml')).toBe('Table fct {\n  fct_key INT [pk]\n  dim_key INT\n}\n');
    expect(plan.deletes).toContain('logical-models/fct.yml');
    expectCompilesEverywhere(input, plan);
  });

  it('a YAML table whose duplicate keys differ stays YAML, untouched; its relationships stay in it and draw as before; the rest converts', async () => {
    const input = inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/other.yml': DUPLICATE_DIFFERENT,
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key', 'other_key'], [FCT_REL, { fromColumn: 'other_key', toModel: 'other', toColumn: 'other_key', cardinality: 'many-to-one' }]),
      'gold/s.json': diagram('s', 'gold', ['fct', 'dim', 'other']),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(plan.leftAsIs).toEqual([{ path: 'logical-models/other.yml', line: 3, problem: 'The key description is written twice with different values (line 3). Keep the one you mean.' }]);
    expect(plan.deletes).not.toContain('logical-models/other.yml');
    expect(plan.keptMissing).toEqual([]);
    const diagramText = created(plan, 'gold/s.dbml')!;
    expect(diagramText).toContain("erd_unlinked_tables: 'other'");
    expect(diagramText).not.toContain("tables/other.dbml");
    // The Ref to the YAML table is pending (a live one would break the file); the YAML table's own one stays in its file.
    const relationships = created(plan, 'tables/_relationships.dbml')!;
    expect(refLines(relationships)).toEqual(['Ref: fct.dim_key >? dim.dim_key']);
    expect(relationships).toContain('// erd-studio pending: Ref: fct.other_key >? other.other_key\n');
    expectCompilesEverywhere(input, plan);
    // What the diagram draws: the same three tables and three lines, other.yml's own included.
    const before = await displayOf(after(input, { ...plan, creates: [], replaces: [], deletes: [] }), 'gold/s.json');
    const now = await displayOf(after(input, plan), 'gold/s.dbml');
    const lines = (d: DisplaySubjectArea): string[] => d.relationships.map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}`).sort();
    expect(lines(now)).toEqual(lines(before));
    expect(lines(now)).toHaveLength(3);
    expect(now.models.map((m) => m.name)).toEqual(['fct', 'dim', 'other']);
    expect(now.models.find((m) => m.name === 'other')!.loadWarning).toEqual(before.models.find((m) => m.name === 'other')!.loadWarning);
  });

  it('a relationship to a missing table, from a converted table, draws to the missing table as before', async () => {
    const input = inputOf({
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'x_key'], [{ fromColumn: 'x_key', toModel: 'dim_x', toColumn: 'x_key', cardinality: 'many-to-one' }]),
      'gold/s.json': diagram('s', 'gold', ['fct', 'dim_x']),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(plan.keptMissing).toEqual([{ diagram: 'gold/s.dbml', tables: ['dim_x'] }]);
    const before = await displayOf(after(input, { ...plan, creates: [], replaces: [], deletes: [] }), 'gold/s.json');
    const now = await displayOf(after(input, plan), 'gold/s.dbml');
    expect(before.relationships).toHaveLength(1);
    expect(now.relationships).toEqual(before.relationships);
    expect(now.models).toEqual(before.models);
    expect(now.viewConfig.positions).toEqual(before.viewConfig.positions);
  });

  it('Liam\'s gold/commercial shape: members with no table file stay missing, their relationships pending in the diagram, positions kept', async () => {
    const missing = ['gld_fct_risk_child', 'gld_fct_risk_parent'];
    const input = inputOf({
      'logical-models/gold/gld_dim_project.yml': yml('gld_dim_project', [['project_id', 'INT', true]]),
      'gold/commercial.json': diagram('commercial', 'gold', ['gld_dim_project', ...missing], missing.map((m) => ({ fromModel: m, fromColumn: 'project_id', toModel: 'gld_dim_project', toColumn: 'project_id', cardinality: 'many-to-one' }))),
    });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(plan.keptMissing).toEqual([{ diagram: 'gold/commercial.dbml', tables: missing }]);
    expect(created(plan, 'gold/commercial.dbml')).toBe([
      'Project commercial {',
      "  Note: 'commercial diagram'",
      "  erd_schema_version: '7'",
      "  erd_unlinked_tables: 'gld_fct_risk_child, gld_fct_risk_parent'",
      '}',
      '',
      "use { table gld_dim_project } from '../tables/gold/gld_dim_project.dbml'",
      "use * from '../tables/gold/_relationships.dbml'",
      '',
      '// erd-studio pending: Ref: gld_fct_risk_child.project_id >? gld_dim_project.project_id',
      '// erd-studio pending: Ref: gld_fct_risk_parent.project_id >? gld_dim_project.project_id',
      '',
    ].join('\n').replace("use * from '../tables/gold/_relationships.dbml'\n", ''));
    const positions = JSON.parse(created(plan, 'gold/commercial.dbdiagram')!).defaultView.tablePositions.map((p: { name: string; x: number }) => [p.name, p.x]);
    expect(positions).toEqual([['gld_dim_project', 40], ['gld_fct_risk_child', 340], ['gld_fct_risk_parent', 640]]);
    expect(plan.placedDiagrams).toEqual(['gold/commercial.dbml']);
    expectCompilesEverywhere(input, plan);
    const before = await displayOf(after(input, { ...plan, creates: [], replaces: [], deletes: [] }), 'gold/commercial.json');
    const now = await displayOf(after(input, plan), 'gold/commercial.dbml');
    expect(now.relationships).toEqual(before.relationships);
    expect(now.models).toEqual(before.models);
  });

  it('the same project gives the same plan, byte for byte', async () => {
    const files = {
      'logical-models/dim.yml': DIM,
      'logical-models/other.yml': DUPLICATE_DIFFERENT,
      'logical-models/fct.yml': DUPLICATE_SAME,
      'logical-models/broken.yml': 'name: broken\ncolumns: [\n',
      'gold/s.json': diagram('s', 'gold', ['fct', 'Dim', 'other', 'gone'], [{ fromModel: 'gone', fromColumn: 'k', toModel: 'dim', toColumn: 'dim_key', cardinality: 'many-to-one' }]),
      'gold/t.json': diagram('t', 'gold', ['broken', 'dim']),
    };
    const one = await planDbmlConversion(inputOf(files));
    const two = await planDbmlConversion(inputOf(files));
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(describeDbmlConversion(two)).toBe(describeDbmlConversion(one));
    expect(one.refusals).toEqual([]);
    expect(one.leftAsIs.map((l) => l.path)).toEqual(['logical-models/broken.yml', 'logical-models/other.yml']);
    expect(one.handled.map((h) => h.path)).toEqual(['logical-models/fct.yml', 'gold/s.json']);
  });

  it('finishing: after the YAML file is fixed, Convert converts it, moves its name to a use line and makes its pending Refs live', async () => {
    const input = inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/other.yml': DUPLICATE_DIFFERENT,
      'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key', 'other_key'], [FCT_REL, { fromColumn: 'other_key', toModel: 'other', toColumn: 'other_key', cardinality: 'many-to-one' }]),
      'gold/s.json': diagram('s', 'gold', ['fct', 'dim', 'other'], [{ fromModel: 'other', fromColumn: 'other_key', toModel: 'fct', toColumn: 'fct_key', cardinality: 'many-to-one' }]),
    });
    const first = await planDbmlConversion(input);
    expect(first.leftAsIs.map((l) => l.path)).toEqual(['logical-models/other.yml']);
    const mixed = after(input, first);
    // The diagram's own relationship from the YAML table is pending in the diagram.
    expect(mixed['gold/s.dbml']).toContain('// erd-studio pending: Ref: other.other_key >? fct.fct_key\n');
    expect(classifyStorage(mixed)).toBe('mixed');
    // Nothing more to convert until it is fixed: the plan lists the file and writes nothing.
    const waiting = await planDbmlConversion(inputOf(mixed));
    expect(waiting.refusals).toEqual([]);
    expect(waiting.leftAsIs.map((l) => l.path)).toEqual(['logical-models/other.yml']);
    expect([...waiting.creates, ...waiting.replaces, ...waiting.deletes]).toEqual([]);

    // Fixed: the second run finishes the job.
    const fixed = { ...mixed, 'logical-models/other.yml': DUPLICATE_DIFFERENT.replace('description: one\n', '') };
    const finish = await planDbmlConversion(inputOf(fixed));
    expect(finish.refusals).toEqual([]);
    expect(finish.leftAsIs).toEqual([]);
    expect(finish.creates.map((c) => c.path)).toEqual(['tables/other.dbml']);
    expect(finish.deletes).toEqual(['logical-models/other.yml']);
    const done = after(inputOf(fixed), finish);
    expect(done['gold/s.dbml']).not.toContain('erd_unlinked_tables');
    expect(done['gold/s.dbml']).not.toContain('erd-studio pending');
    expect(done['gold/s.dbml']).toContain("use { table other } from '../tables/other.dbml'\n");
    const relationships = done['tables/_relationships.dbml'];
    expect(relationships).not.toContain('erd-studio pending');
    expect(refLines(relationships)).toEqual([
      'Ref: fct.dim_key >? dim.dim_key',
      'Ref: fct.other_key >? other.other_key',
      'Ref: other.dim_key >? dim.dim_key',
      'Ref: other.other_key >? fct.fct_key',
    ]);
    expect(finish.movedRelationships).toEqual([{ from: 'other.other_key', to: 'fct.fct_key', diagrams: [] }]);
    expect(relationships).toContain("use { table other } from './other.dbml'\n");
    expect(classifyStorage(done)).toBe('dbml');
    expectCompilesEverywhere(inputOf(fixed), finish);
  });

  it('a YAML table left behind in the middle of a diagram (its name: is not its file, or is written twice): no false self-check refusal', async () => {
    for (const left of ['name: bar\ncolumns: []\n', 'name: foo\nname: other\ncolumns: []\n']) {
      const input = inputOf({
        'logical-models/dim.yml': DIM,
        'logical-models/foo.yml': left,
        'logical-models/fct.yml': yml('fct', [['fct_key', 'INT', true], 'dim_key'], [FCT_REL]),
        'gold/c.json': diagram('c', 'gold', ['dim', 'foo', 'fct']),
      });
      const plan = await planDbmlConversion(input);
      expect(plan.refusals, left).toEqual([]);
      expect(plan.leftAsIs.map((l) => l.path), left).toEqual(['logical-models/foo.yml']);
      expect(created(plan, 'gold/c.dbml'), left).toContain("erd_unlinked_tables: 'foo'");
      const before = await displayOf(after(input, { ...plan, creates: [], replaces: [], deletes: [] }), 'gold/c.json');
      const now = await displayOf(after(input, plan), 'gold/c.dbml');
      const byName = (d: DisplaySubjectArea) => d.models.map((m) => m.name).sort();
      expect(byName(now), left).toEqual(byName(before));
    }
  });

  it('a missing table listed twice in different case draws twice: that diagram stays JSON, the rest converts', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'gold/c.json': diagram('c', 'gold', ['dim', 'miss', 'MISS']),
    }));
    expect(plan.refusals).toEqual([]);
    expect(plan.leftAsIs).toEqual([{ path: 'gold/c.json', problem: 'It lists miss and MISS, which differ only in case and have no table file, so it draws two tables where a DBML diagram can name one. Remove one of them.' }]);
    expect(plan.creates.map((c) => c.path)).toEqual(['tables/dim.dbml']);
  });

  it('finishing a diagram that keeps other missing members: the fixed table gains its use line ahead of them, with no false self-check refusal', async () => {
    // As on Liam's gold/commercial: members with no table file at all stay unlinked for good, and the
    // fixed table is not the first unlinked name, so its place in the member list changes.
    const files = {
      'logical-models/dim.yml': DIM,
      'logical-models/other.yml': DUPLICATE_DIFFERENT,
      'logical-models/risk.yml': 'name: risk\nname: risk2\ncolumns: []\n',
      'gold/c.json': diagram('c', 'gold', ['gone_a', 'dim', 'risk', 'gone_b', 'other', 'gone_c']),
    };
    const first = await planDbmlConversion(inputOf(files));
    expect(first.refusals).toEqual([]);
    const mixed = after(inputOf(files), first);
    expect(mixed['gold/c.dbml']).toContain("erd_unlinked_tables: 'gone_a, risk, gone_b, other, gone_c'");
    // One fixed, then the other: each run finishes what it can.
    const oneFixed = { ...mixed, 'logical-models/other.yml': DUPLICATE_DIFFERENT.replace('description: one\n', '') };
    const second = await planDbmlConversion(inputOf(oneFixed));
    expect(second.refusals).toEqual([]);
    expect(second.leftAsIs.map((l) => l.path)).toEqual(['logical-models/risk.yml']);
    const done1 = after(inputOf(oneFixed), second);
    expect(done1['gold/c.dbml']).toContain("erd_unlinked_tables: 'gone_a, risk, gone_b, gone_c'");
    expect(done1['gold/c.dbml']).toContain("use { table other } from '../tables/other.dbml'");
    const bothFixed = { ...done1, 'logical-models/risk.yml': 'name: risk\ncolumns: []\n' };
    const third = await planDbmlConversion(inputOf(bothFixed));
    expect(third.refusals).toEqual([]);
    expect(third.leftAsIs).toEqual([]);
    const done2 = after(inputOf(bothFixed), third);
    expect(done2['gold/c.dbml']).toContain("erd_unlinked_tables: 'gone_a, gone_b, gone_c'");
    expect(classifyStorage(done2)).toBe('dbml');
  });
});

/** The project storage the files say (§3.2), from their kinds alone. */
function classifyStorage(files: Record<string, string>): 'yaml' | 'dbml' | 'mixed' {
  const kinds = Object.keys(files).map((p) => classifySemanticFile(p, { tablesDirIsLayer: false }));
  return detectProjectStorage({
    hasYamlTables: kinds.some((k) => k.kind === 'table' && k.storage === 'yaml'),
    hasV5Folder: Object.keys(files).some((p) => p.startsWith('logical-models/')),
    hasDbmlTables: kinds.some((k) => (k.kind === 'table' && k.storage === 'dbml') || k.kind === 'relationships'),
    subjectAreaStorages: kinds.filter((k) => k.kind === 'diagram').map((k) => (k.storage === 'dbml' ? 'dbml' : 'json')),
  });
}

describe('planDbmlConversion: stress round 1 (a 100-table demo project with 38 planted problems)', () => {
  it('meta keeps its key order: a text entry before a true/false one reads back first', async () => {
    const table = 'name: dim\nmeta:\n  owner: people\n  contains_pii: true\n  exposure: crm\ncolumns:\n  - name: dim_key\n    dataType: INT\n    isPrimaryKey: true\n';
    const plan = await planDbmlConversion(inputOf({ 'logical-models/dim.yml': table, 'gold/d.json': diagram('d', 'gold', ['dim']) }));
    expect(plan.refusals).toEqual([]);
    const text = created(plan, 'tables/dim.dbml')!;
    const reading = parseTableDbml(text, 'dim');
    expect(reading.ok).toBe(true);
    if (reading.ok) expect(Object.keys(reading.table.meta ?? {})).toEqual(['owner', 'contains_pii', 'exposure']);
  });

  it('an empty .yml and a dbt schema file in the library stay as they are, each with what it is', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'logical-models/silver/dim_sales_rep.yml': '',
      'logical-models/silver/schema.yml': 'version: 2\nmodels:\n  - name: dim_store\n    columns:\n      - name: store_key\n',
      'logical-models/silver/nameless.yml': 'columns: []\n',
    }));
    expect(plan.refusals).toEqual([]);
    expect(leftOf(plan, 'logical-models/silver/dim_sales_rep.yml')?.problem).toMatch(/^It is empty, so ERD Studio does not read it as a table/);
    expect(leftOf(plan, 'logical-models/silver/schema.yml')?.problem).toMatch(/^It is a dbt schema file \(version: and models: or sources:\), not an ERD Studio table\. Move it out of the table library/);
    expect(leftOf(plan, 'logical-models/silver/nameless.yml')?.problem).toMatch(/^It has no name: key/);
    expect(created(plan, 'tables/dim.dbml')).toBeDefined();
  });

  it('a diagram in a folder layers.json does not list stays JSON (it does not open, so Convert cannot check it)', async () => {
    const plan = await planDbmlConversion(inputOf({
      'logical-models/dim.yml': DIM,
      'gold/d.json': diagram('d', 'gold', ['dim']),
      'platinum/exec.json': diagram('exec', 'platinum', ['dim']),
    }));
    expect(plan.refusals).toEqual([]);
    expect(leftOf(plan, 'platinum/exec.json')?.problem).toBe(
      'It is in the platinum/ folder, which is not a layer in layers.json, so ERD Studio does not open it. Add the layer platinum to layers.json (or move the file into a layer\'s folder), then convert again.',
    );
    expect(plan.deletes).not.toContain('platinum/exec.json');
    expect(plan.creates.map((c) => c.path)).not.toContain('platinum/exec.dbml');
    expect(plan.deletes).toContain('gold/d.json');
  });

  it('a table file named .yaml or .YML is left with the name to give it, and its member is not called missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-misnamed-'));
    try {
      const sd = path.join(root, '.erd-studio');
      const put = (rel: string, text: string): void => {
        fs.mkdirSync(path.dirname(path.join(sd, rel)), { recursive: true });
        fs.writeFileSync(path.join(sd, rel), text);
      };
      put('layers.json', LAYERS);
      put('logical-models/dim.yml', DIM);
      put('logical-models/gold/dim_a.yaml', yml('dim_a', ['a_key']));
      put('logical-models/gold/dim_b.YML', yml('dim_b', ['b_key']));
      // A dbt schema file named .yaml is not a table: never listed, as before.
      put('logical-models/gold/_models.yaml', 'version: 2\nmodels:\n  - name: dim_a\n');
      put('gold/d.json', diagram('d', 'gold', ['dim', 'dim_a', 'dim_b']));
      const input = readDbmlConversionInput(root, '.erd-studio');
      expect(input.misnamedTables).toEqual([
        { path: 'logical-models/gold/dim_a.yaml', name: 'dim_a' },
        { path: 'logical-models/gold/dim_b.YML', name: 'dim_b' },
      ]);
      const plan = await planDbmlConversion(input);
      expect(plan.refusals).toEqual([]);
      expect(leftOf(plan, 'logical-models/gold/dim_a.yaml')?.problem).toBe(
        'It is named dim_a.yaml, and ERD Studio reads a table file only when its name ends in .yml, so it does not read this one '
          + '(a diagram that lists dim_a draws it as missing). Rename it to dim_a.yml, then convert again.',
      );
      expect(leftOf(plan, 'logical-models/gold/dim_b.YML')?.problem).toBe(
        'It is named dim_b.YML, and ERD Studio reads a table file only when its name ends in .yml, in lower case: the table library does not list it, '
          + 'and a diagram finds it only on a file system that ignores case. Rename it to dim_b.yml, then convert again.',
      );
      // Not "create them later with Add from dbt": each has a file, under the wrong name.
      expect(plan.keptMissing).toEqual([]);
      expect(created(plan, 'gold/d.dbml')).toContain("erd_unlinked_tables: 'dim_a, dim_b'");
      expect(plan.deletes).not.toContain('logical-models/gold/dim_a.yaml');
      // The same plan twice.
      expect(JSON.stringify(await planDbmlConversion(readDbmlConversionInput(root, '.erd-studio')))).toBe(JSON.stringify(plan));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a diagram whose folder can never be a layer, or whose layers.json does not read, says so instead of "add the layer"', async () => {
    // Gold_Ext is listed, but layers.json skips an id with capitals: adding it again would not help.
    const listed = JSON.stringify({ schemaVersion: 1, layers: [...JSON.parse(LAYERS).layers, { id: 'Gold_Ext', label: 'Gold Ext', abbreviation: 'GEX', color: '#123456', creatable: true, order: 9 }] });
    const capitals = await planDbmlConversion(inputOf({
      'layers.json': listed,
      'logical-models/dim.yml': DIM,
      'Gold_Ext/ext.json': diagram('ext', 'Gold_Ext', ['dim']),
    }));
    expect(capitals.refusals).toEqual([]);
    expect(leftOf(capitals, 'Gold_Ext/ext.json')?.problem).toBe(
      'It is in the Gold_Ext/ folder, and a layer id (its folder\'s name) is lower-case letters, digits, - and _, starting with a letter, so ERD Studio does not open it. '
        + 'Move it into a layer\'s folder (or rename the folder and its id in layers.json to such a name), then convert again.',
    );
    // platinum is listed in a layers.json that does not read: the default layers apply.
    const broken = await planDbmlConversion(inputOf({
      'layers.json': '{ "layers": [ { "id": "platinum", "label": "Platinum" } ] }',
      'logical-models/dim.yml': DIM,
      'platinum/exec.json': diagram('exec', 'platinum', ['dim']),
    }));
    expect(broken.refusals).toEqual([]);
    expect(leftOf(broken, 'platinum/exec.json')?.problem).toBe(
      'It is in the platinum/ folder, and layers.json does not read (Layers config missing schemaVersion field), so ERD Studio uses its default layers and does not open it. '
        + 'Fix layers.json, then convert again.',
    );
  });

  it('a composite relationship of one column pair is written as a single-column Ref, with a note', async () => {
    const fct = yml('fct', ['id', 'dim_key'], [{ ...FCT_REL, compositeKey: 'fk_dim' }]);
    const input = inputOf({ 'logical-models/dim.yml': DIM, 'logical-models/fct.yml': fct, 'gold/d.json': diagram('d', 'gold', ['dim', 'fct']) });
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(refLines(written(plan, 'tables/_relationships.dbml'))).toEqual(['Ref: fct.dim_key >? dim.dim_key']);
    expect(plan.notes).toContain(
      'logical-models/fct.yml: the composite relationship "fk_dim" from fct has only one column pair (fct.dim_key → dim.dim_key), so it is written as a single-column Ref ' +
        'without its compositeKey, as ERD Studio already drew it. Add the other columns on the canvas if it is meant to be composite.',
    );
    expectCompilesEverywhere(input, plan);
  });

  it('doctor says Convert fixes a key written twice with the same value, so the two never disagree', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-stress-dup-'));
    try {
      const sem = path.join(root, '.erd-studio');
      fs.mkdirSync(path.join(sem, 'logical-models'), { recursive: true });
      fs.mkdirSync(path.join(sem, 'gold'), { recursive: true });
      fs.writeFileSync(path.join(sem, 'layers.json'), LAYERS);
      fs.writeFileSync(path.join(sem, 'logical-models', 'dim.yml'), 'name: dim\ncolumns:\n  - name: dim_key\n    dataType: INT\n    dataType: INT\n');
      fs.writeFileSync(path.join(sem, 'gold', 'd.json'), diagram('d', 'gold', ['dim']));
      const result = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true });
      expect(result.erd.dbmlConversion!.handled).toEqual([expect.objectContaining({ path: 'logical-models/dim.yml' })]);
      expect(formatDoctor(result, makePaint(false))).toMatch(
        /✗ .*dim\.yml line 5: .*written twice.* \("Convert Project to DBML" fixes it: The key dataType is written twice with the same value \(line 5\); converted as if written once\)/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('doctor lists each file Convert would leave as it is, with its problem', async () => {
    const left = await runDoctor({ project: path.join(CORE_FIXTURES, 'library-relationships'), semanticDir: '.erd-studio', noDbt: true });
    expect(formatDoctor(left, makePaint(false))).toContain(
      '! .erd-studio/gold/sales.json: Convert leaves it as it is until fixed — It defines the relationship fct_order.customer_key → dim_customer.customer_key as one-to-one',
    );
  });
});
