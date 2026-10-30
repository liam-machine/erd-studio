/**
 * Convert's self-check compile, file by file (`compileDbmlFilesSeparately`):
 * it must report exactly what the whole-project compile (`compileDbmlProject`)
 * reports, on a clean project and on every kind of broken output the
 * self-check exists to catch, including the ones that cross files (Refs with
 * the same endpoints in two files a diagram reads together, a clash between
 * two `use` lines in different chunks, a TableGroup or inline `ref:`).
 */

import { describe, expect, it } from 'vitest';

import type { DbmlDiagnostic } from '@erd-studio/core';
import { compileDbmlProject } from '@erd-studio/core/dbml';

import { DbmlFileCompileMemo, codeOf, compileDbmlFilesSeparately, compileDbmlFilesSeparatelyAsync } from '../../src/services/dbmlFileCompile';
import { planDbmlConversion } from '../../src/services/dbmlConversion';
import type { DbmlConversionInput } from '../../src/services/dbmlConversion';
import { classifySemanticFile } from '@erd-studio/core';

/**
 * A converted project shaped like Convert's output: tables in two library
 * folders, one relationships file per folder with enough Refs and `use`
 * lines to be compiled in chunks, and diagrams that read both relationships
 * files with `use *` (one with enough `use` lines to be chunked too).
 */
function project(): Record<string, string> {
  const files: Record<string, string> = {};
  const folders = ['gold', 'silver'];
  const names: Record<string, string[]> = {};
  for (const folder of folders) {
    names[folder] = [];
    for (let i = 0; i < 40; i++) {
      const name = `${folder}_t${String(i).padStart(2, '0')}`;
      names[folder].push(name);
      files[`tables/${folder}/${name}.dbml`] =
        `Table ${name} [note: 'table ${i}'] {\n  ${name}_key int [pk]\n  other_key int\n  label varchar [note: 'a label']\n}\n`;
    }
  }
  for (const folder of folders) {
    const other = folder === 'gold' ? 'silver' : 'gold';
    const lines = ['// ERD Studio relationships.'];
    const used = new Set<string>();
    const refs: string[] = [];
    names[folder].forEach((name, i) => {
      const target = i % 3 === 0 ? names[other][i] : names[folder][(i + 1) % names[folder].length];
      refs.push(`Ref: ${name}.other_key >? ${target}.${target}_key`);
      used.add(name);
      used.add(target);
    });
    for (const name of [...used].sort()) {
      const inFolder = names[folder].includes(name);
      lines.push(`use { table ${name} } from '${inFolder ? `./${name}.dbml` : `../${other}/${name}.dbml`}'`);
    }
    files[`tables/${folder}/_relationships.dbml`] = `${[...lines, ...refs].join('\n')}\n`;
  }
  const diagramOf = (name: string, members: string[]): string => [
    `Project ${name} {`,
    "  erd_schema_version: '7'",
    '}',
    '',
    ...members.map((m) => `use { table ${m} } from '../tables/${m.split('_')[0]}/${m}.dbml'`),
    "use * from '../tables/gold/_relationships.dbml'",
    "use * from '../tables/silver/_relationships.dbml'",
    '',
  ].join('\n');
  files['gold/big.dbml'] = diagramOf('big', [...names.gold, ...names.silver.slice(0, 20)]);
  files['gold/small.dbml'] = diagramOf('small', names.gold.slice(0, 5));
  files['silver/area.dbml'] = diagramOf('area', names.silver.slice(10, 30));
  return files;
}

type Mutation = (files: Record<string, string>) => void;

const GOLD_REL = 'tables/gold/_relationships.dbml';
const SILVER_REL = 'tables/silver/_relationships.dbml';
const firstRef = (text: string): string => text.split('\n').find((l) => l.startsWith('Ref'))!;
const lastRef = (text: string): string => text.split('\n').filter((l) => l.startsWith('Ref')).pop()!;

const MUTATIONS: Record<string, Mutation> = {
  'a syntax error in a table': (f) => { f['tables/gold/gold_t00.dbml'] = f['tables/gold/gold_t00.dbml'].replace('{', '{ ((('); },
  'a table a diagram uses is gone': (f) => { delete f['tables/gold/gold_t01.dbml']; },
  'a table only a relationships file uses is gone': (f) => { delete f['tables/silver/silver_t39.dbml']; },
  'a table renamed inside its file': (f) => { f['tables/gold/gold_t02.dbml'] = f['tables/gold/gold_t02.dbml'].replace('Table gold_t02', 'Table gold_t02_x'); },
  'a Ref to a column that does not exist': (f) => { f[GOLD_REL] = f[GOLD_REL].replace(firstRef(f[GOLD_REL]), firstRef(f[GOLD_REL]).replace('.other_key', '.nope')); },
  'a Ref to a table with no use line': (f) => { f[GOLD_REL] += 'Ref: gold_t00.other_key > nowhere.id\n'; },
  'two use lines import one name from two files (in different chunks)': (f) => {
    f['tables/silver/clash.dbml'] = 'Table gold_t00 { id int }\n';
    f[GOLD_REL] += "use { table gold_t00 } from '../silver/clash.dbml'\n";
  },
  'a diagram declares a table it imports': (f) => { f['gold/small.dbml'] += 'Table gold_t00 { id int }\n'; },
  'a use line names a table its file does not declare': (f) => { f['gold/small.dbml'] = f['gold/small.dbml'].replace('use { table gold_t00 }', 'use { table not_here }'); },
  'a relationships file a diagram reads is gone': (f) => { delete f[SILVER_REL]; },
  'the same Ref twice in one file, chunks apart': (f) => { f[GOLD_REL] += `${firstRef(f[GOLD_REL])}\n`; },
  'the same Ref reversed in one file': (f) => {
    const m = firstRef(f[GOLD_REL]).match(/Ref: (\S+) >\? (\S+)/)!;
    f[GOLD_REL] += `Ref: ${m[2]} < ${m[1]}\n`;
  },
  'a diagram Ref that repeats a relationships file Ref': (f) => { f['gold/small.dbml'] += `${firstRef(f[GOLD_REL])}\n`; },
  'the same Ref in two relationships files a diagram reads together': (f) => {
    const ref = firstRef(f[GOLD_REL]);
    const uses = f[GOLD_REL].split('\n').filter((l) => l.startsWith('use')).map((l) => l.replace("'./", "'../gold/"));
    f[SILVER_REL] = `${uses.join('\n')}\n${f[SILVER_REL]}${ref}\n`;
  },
  'a Ref block over several lines': (f) => { f[GOLD_REL] += `Ref {\n  ${lastRef(f[GOLD_REL]).replace('Ref: ', '')}\n}\n`; },
  'an inline ref that repeats a relationships file Ref': (f) => {
    const m = firstRef(f[GOLD_REL]).match(/Ref: (\w+)\.(\w+) >\? (\w+)\.(\w+)/)!;
    const file = `tables/gold/${m[1]}.dbml`;
    f[file] = f[file].replace(`  ${m[2]} int`, `  ${m[2]} int [ref: > ${m[3]}.${m[4]}]`);
  },
  'one table in two TableGroups in two files': (f) => {
    f['gold/small.dbml'] += 'TableGroup g1 { gold_t00 }\n';
    f['tables/gold/gold_t00.dbml'] += 'TableGroup g2 { gold_t00 }\n';
  },
  'a reuse line': (f) => { f[GOLD_REL] = f[GOLD_REL].replace('use { table', 'reuse { table'); },
  'a syntax error in a relationships file': (f) => { f[GOLD_REL] = f[GOLD_REL].replace('Ref:', 'Ref:: ((('); },
  'a use line whose path differs only in case': (f) => {
    f['gold/small.dbml'] = f['gold/small.dbml'].replace('/gold_t00.dbml', '/GOLD_T00.dbml');
  },
  'a byte-order mark': (f) => { f['tables/gold/gold_t03.dbml'] = `﻿${f['tables/gold/gold_t03.dbml']}`; },
};

const keys = (result: Record<string, DbmlDiagnostic[]>): string[] =>
  Object.entries(result).flatMap(([file, list]) => list.map((d) => `${file}|${d.code}|${d.line}|${d.message}`)).sort();

function expectSameAsWholeProject(files: Record<string, string>): void {
  const entries = Object.keys(files);
  expect(keys(compileDbmlFilesSeparately(files, entries))).toEqual(keys(compileDbmlProject(files, entries)));
}

describe('compileDbmlFilesSeparately reports what the whole-project compile reports', () => {
  it('a clean converted project: nothing, and every entry present', () => {
    const files = project();
    const result = compileDbmlFilesSeparately(files, Object.keys(files));
    expect(Object.keys(result).sort()).toEqual(Object.keys(files).sort());
    expect(Object.values(result).flat()).toEqual([]);
    expectSameAsWholeProject(files);
  });

  for (const [name, mutate] of Object.entries(MUTATIONS)) {
    it(name, () => {
      const files = project();
      mutate(files);
      const whole = keys(compileDbmlProject(files, Object.keys(files)));
      expect(whole.length).toBeGreaterThanOrEqual(0);
      expectSameAsWholeProject(files);
    });
  }

  it('every mutation that breaks the project is reported (so the test above is not vacuous)', () => {
    const silent = ['a reuse line', 'a byte-order mark'];
    for (const [name, mutate] of Object.entries(MUTATIONS)) {
      const files = project();
      mutate(files);
      const found = keys(compileDbmlFilesSeparately(files, Object.keys(files)));
      if (silent.includes(name)) continue;
      expect({ name, found: found.length > 0 }).toEqual({ name, found: true });
    }
  });

  it('only the entries asked for, and the files they reach, are compiled', () => {
    const files = project();
    files['gold/unrelated.dbml'] = 'Table broken {\n';
    const result = compileDbmlFilesSeparately(files, ['gold/small.dbml']);
    expect(result['gold/unrelated.dbml']).toBeUndefined();
    expect(keys(result)).toEqual(keys(compileDbmlProject(files, ['gold/small.dbml'])));
  });

  it('an entry that is not in the set is reported missing, as the whole-project compile does', () => {
    expect(keys(compileDbmlFilesSeparately({}, ['gold/none.dbml']))).toEqual(keys(compileDbmlProject({}, ['gold/none.dbml'])));
  });

  it('a memo reuses the compiles of files that did not change', () => {
    const files = project();
    let calls = 0;
    const counting = (subset: Readonly<Record<string, string>>, entries: readonly string[]): Record<string, DbmlDiagnostic[]> => {
      calls++;
      return compileDbmlProject(subset, entries);
    };
    const memo = new DbmlFileCompileMemo();
    compileDbmlFilesSeparately(files, Object.keys(files), counting, memo);
    const first = calls;
    expect(first).toBeGreaterThan(0);
    compileDbmlFilesSeparately(files, Object.keys(files), counting, memo);
    expect(calls).toBe(first);
    files['gold/small.dbml'] += '// changed\n';
    compileDbmlFilesSeparately(files, Object.keys(files), counting, memo);
    expect(calls).toBe(first + 1);
  });

  it('the asynchronous form gives the same result, pausing as it works, and stops when the pause throws', async () => {
    const files = project();
    files['tables/gold/gold_t05.dbml'] = files['tables/gold/gold_t05.dbml'].replace('{', '{ (((');
    let pauses = 0;
    const slow = (subset: Readonly<Record<string, string>>, entries: readonly string[]): Record<string, DbmlDiagnostic[]> => {
      const until = Date.now() + 3;
      while (Date.now() < until) { /* a slow compile, so the slices end */ }
      return compileDbmlProject(subset, entries);
    };
    const result = await compileDbmlFilesSeparatelyAsync(files, Object.keys(files), async () => { pauses++; }, slow);
    expect(keys(result)).toEqual(keys(compileDbmlFilesSeparately(files, Object.keys(files))));
    expect(pauses).toBeGreaterThan(0);
    await expect(compileDbmlFilesSeparatelyAsync(files, Object.keys(files), async () => { throw new Error('cancelled'); }, slow)).rejects.toThrow('cancelled');
  });

  it('compiles many small layouts, never the whole project at once', () => {
    const files = project();
    let largest = 0;
    compileDbmlFilesSeparately(files, Object.keys(files), (subset, entries) => {
      largest = Math.max(largest, Object.keys(subset).length);
      return compileDbmlProject(subset, entries);
    });
    expect(largest).toBeLessThan(Object.keys(files).length * 0.75);
  });
});

describe('hand-written shapes the reader accepts: the same diagnostics as the whole-project compile', () => {
  const dim = 'Table dim {\n  dim_key int [pk]\n}\n';
  const fct = 'Table fct {\n  id int [pk]\n  dim_key int\n}\n';
  const cases: Record<string, Record<string, string>> = {
    'a duplicate Ref across files whose tables a diagram imports with use * (plain table files)': {
      'tables/dim.dbml': dim,
      'tables/fct.dbml': fct,
      'tables/_relationships.dbml': "use { table dim } from './dim.dbml'\nuse { table fct } from './fct.dbml'\nRef: fct.dim_key > dim.dim_key\n",
      'gold/sales.dbml': "use * from '../tables/dim.dbml'\nuse * from '../tables/fct.dbml'\nuse * from '../tables/_relationships.dbml'\nRef: fct.dim_key > dim.dim_key\n",
    },
    'a duplicate Ref between schema-qualified tables': {
      'tables/a.dbml': 'Table gold.a {\n  id int [pk]\n  b_id int\n}\n',
      'tables/b.dbml': 'Table gold.b {\n  id int [pk]\n}\n',
      'tables/_relationships.dbml': "use { table gold.a } from './a.dbml'\nuse { table gold.b } from './b.dbml'\nRef: gold.a.b_id > gold.b.id\n",
      'gold/x.dbml': "use { table gold.a } from '../tables/a.dbml'\nuse { table gold.b } from '../tables/b.dbml'\nuse * from '../tables/_relationships.dbml'\nRef: gold.a.b_id > gold.b.id\n",
    },
    'a duplicate Ref written once with public. and once without': {
      'tables/dim.dbml': dim,
      'tables/fct.dbml': fct,
      'tables/_relationships.dbml': "use { table dim } from './dim.dbml'\nuse { table fct } from './fct.dbml'\nRef: public.fct.dim_key > public.dim.dim_key\n",
      'gold/sales.dbml': "use { table dim } from '../tables/dim.dbml'\nuse { table fct } from '../tables/fct.dbml'\nuse * from '../tables/_relationships.dbml'\nRef: fct.dim_key > dim.dim_key\n",
    },
    'a duplicate Ref through a use line that renames a table (as)': {
      'tables/dim.dbml': dim,
      'tables/fct.dbml': fct,
      'tables/_relationships.dbml': "use { table dim } from './dim.dbml'\nuse { table fct } from './fct.dbml'\nRef: fct.dim_key > dim.dim_key\n",
      'gold/sales.dbml': "use { table dim as d } from '../tables/dim.dbml'\nuse { table fct } from '../tables/fct.dbml'\nuse * from '../tables/_relationships.dbml'\nRef: fct.dim_key > d.dim_key\n",
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    it(name, () => {
      expect(keys(compileDbmlProject(files, Object.keys(files))).length).toBeGreaterThanOrEqual(0);
      expectSameAsWholeProject(files);
    });
  }

  it('the use * case is a real error the file-by-file compile reports (so the case above is not vacuous)', () => {
    const files = cases['a duplicate Ref across files whose tables a diagram imports with use * (plain table files)'];
    expect(keys(compileDbmlFilesSeparately(files, Object.keys(files))).some((k) => k.includes('|5001|'))).toBe(true);
  });
});

describe('notes and comments that mention reuse or ref: are not code', () => {
  /** How many compiles a check makes. */
  function compilesFor(files: Record<string, string>): number {
    let calls = 0;
    compileDbmlFilesSeparately(files, Object.keys(files), (subset, entries) => { calls++; return compileDbmlProject(subset, entries); });
    return calls;
  }
  const withNote = (note: string): Record<string, string> => {
    const files = project();
    files['tables/gold/gold_t00.dbml'] = files['tables/gold/gold_t00.dbml'].replace("note: 'a label'", `note: '${note}'`);
    files['tables/gold/gold_t01.dbml'] = `// ${note}\n${files['tables/gold/gold_t01.dbml']}`;
    files['tables/gold/gold_t02.dbml'] = files['tables/gold/gold_t02.dbml'].replace("[note: 'table 2']", `[note: '''${note}''']`);
    return files;
  };

  for (const note of ['kept for reuse', 'FK, ref: SAP', 'see TableGroup sales', 'use { table x as y }']) {
    it(`"${note}" in a note or comment costs no more compiles than a plain note, with the same result`, () => {
      const plain = compilesFor(withNote('a plain note'));
      const files = withNote(note);
      expect(compilesFor(files)).toBe(plain);
      expectSameAsWholeProject(files);
    });
  }

  it('codeOf blanks comments and strings, keeping every line and column', () => {
    const text = "Table a [note: 'reuse ref: x'] { // reuse\n  id int /* TableGroup */ [note: '''x\nref: y''']\n}\n";
    const code = codeOf(text);
    expect(code).toHaveLength(text.length);
    expect(code.split('\n')).toHaveLength(text.split('\n').length);
    expect(code).not.toMatch(/reuse|ref:|TableGroup/);
    expect(code).toContain('Table a [note:');
  });
});

describe('the self-check refuses broken output with the file-by-file compile', () => {
  const LAYERS = JSON.stringify({ schemaVersion: 1, layers: [{ id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 1 }] });
  const inputOf = (files: Record<string, string>): DbmlConversionInput => ({
    semanticDir: '.erd-studio',
    layers: ['gold'],
    tablesDirIsLayer: false,
    files: Object.entries({ 'layers.json': LAYERS, ...files }).flatMap(([p, text]) => {
      const cls = classifySemanticFile(p, { tablesDirIsLayer: false });
      if (cls.kind === 'other' || cls.kind === 'template') return [];
      return [{ path: p, text, hadBom: false, kind: cls.kind, ...(cls.storage ? { storage: cls.storage } : {}) }];
    }),
  });
  const yamlProject = {
    'logical-models/dim.yml': 'name: dim\ncolumns:\n  - name: dim_key\n    dataType: INT\n    isPrimaryKey: true\n',
    'logical-models/fct.yml': 'name: fct\ncolumns:\n  - name: dim_key\n    dataType: INT\nrelationships:\n  - fromColumn: dim_key\n    toModel: dim\n    toColumn: dim_key\n    cardinality: many-to-one\n',
    'gold/sales.json': JSON.stringify({ schemaVersion: 5, domain: 'sales', layer: 'gold', logical: { models: ['dim', 'fct'], relationships: [] }, viewConfig: { positions: { dim: { x: 0, y: 0 }, fct: { x: 300, y: 0 } } } }),
  };

  it('a clean conversion passes', async () => {
    const plan = await planDbmlConversion(inputOf(yamlProject));
    expect(plan.refusals).toEqual([]);
    expect(plan.creates.length).toBeGreaterThan(0);
  });

  it('a Ref to a column the table does not have is refused, by file and line', async () => {
    const plan = await planDbmlConversion(inputOf(yamlProject), {
      compile: (files, entries) => {
        const broken = { ...files };
        for (const p of Object.keys(broken)) if (p.endsWith('_relationships.dbml')) broken[p] = broken[p].replace(/fct\.dim_key/, 'fct.nope');
        return compileDbmlFilesSeparately(broken, entries);
      },
    });
    expect(plan.refusals).toEqual([expect.stringMatching(/^Convert would write DBML that does not compile: tables\/_relationships\.dbml:\d+ Column 'nope' does not exist/)]);
    expect(plan.creates).toEqual([]);
  });

  it('a Ref written twice across two files a diagram reads is refused', async () => {
    const plan = await planDbmlConversion(inputOf(yamlProject), {
      compile: (files, entries) => {
        const broken = { ...files };
        const rel = Object.keys(broken).find((p) => p.endsWith('_relationships.dbml'))!;
        const ref = broken[rel].split('\n').find((l) => l.startsWith('Ref'))!;
        const diagram = Object.keys(broken).find((p) => p.startsWith('gold/') && p.endsWith('.dbml'))!;
        broken[diagram] += `\n${ref}\n`;
        return compileDbmlFilesSeparately(broken, entries);
      },
    });
    expect(plan.refusals).toEqual([expect.stringMatching(/References with same endpoints exist \[5001\]/)]);
  });
});
