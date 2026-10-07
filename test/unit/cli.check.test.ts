/**
 * `erd-studio check` (issue #133): the project's relationship checks, run on
 * real files in a temp project and through `main()`, so the exit codes, the
 * JSON shape and the human output are what an assistant or CI actually sees.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkKey } from '@erd-studio/core';

import { runCheck, type CheckResult } from '../../src/cli/check';
import { runDoctor } from '../../src/cli/doctor';
import { buildCliContext } from '../../src/cli/context';
import { runDiff } from '../../src/cli/diff';
import { main } from '../../src/cli/index';
import { parseArgs } from '../../src/cli/args';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const PROJECT = path.join(FIXTURES, 'dbt-project');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-cli-check-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function run(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(argv, {
    stdout: { write: (s: string) => { out += s; } },
    stderr: { write: (s: string) => { err += s; } },
    cwd,
    env: {},
  });
  return { code, out, err };
}

const LAYERS = JSON.stringify({
  schemaVersion: 1,
  layers: [
    { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 0 },
    { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 1 },
  ],
}, null, 2);

/**
 * A minimal project: `dbt_project.yml`, the layer config, the given model
 * files (text, relative to `logical-models/`) and domain files (JSON,
 * relative to the semantic dir).
 */
function makeProject(models: Record<string, string>, domains: Record<string, unknown> = {}): string {
  const root = path.join(tmp, 'proj');
  const semantic = path.join(root, '.erd-studio');
  fs.mkdirSync(path.join(semantic, 'logical-models'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dbt_project.yml'), "name: 'p'\nversion: '1.0.0'\nconfig-version: 2\nprofile: 'p'\n");
  fs.writeFileSync(path.join(semantic, 'layers.json'), LAYERS);
  for (const [file, text] of Object.entries(models)) {
    const target = path.join(semantic, 'logical-models', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  for (const [file, doc] of Object.entries(domains)) {
    const target = path.join(semantic, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(doc, null, 2));
  }
  return root;
}

const DIM_CUSTOMER = `name: dim_customer
columns:
  - name: customer_key
    dataType: INT
    isPrimaryKey: true
  - name: customer_name
    dataType: VARCHAR
`;

const DIM_DATE = `name: dim_date
columns:
  - name: date_key
    dataType: INT
    isPrimaryKey: true
`;

function fact(relationships: string): string {
  return `name: fct_order
columns:
  - name: order_key
    dataType: INT
    isPrimaryKey: true
  - name: customer_key
    dataType: INT
    isForeignKey: true
  - name: order_date_key
    dataType: INT
    isForeignKey: true
relationships:
${relationships}`;
}

function domain(models: string[], relationships: unknown[] = []): unknown {
  return { schemaVersion: 5, domain: 'orders', layer: 'silver', logical: { models, relationships }, viewConfig: {} };
}

const SOUND_FACT = fact(`  - fromColumn: customer_key
    toModel: dim_customer
    toColumn: customer_key
    cardinality: many-to-one
  - fromColumn: order_date_key
    toModel: dim_date
    toColumn: date_key
    cardinality: many-to-one
    role: order date
`);

describe('erd-studio check', () => {
  it('parses: --strict and the shared flags only; --all and --domain are diff options', () => {
    expect(parseArgs(['check']).command).toBe('check');
    expect(parseArgs(['check', '--strict', '--json']).strict).toBe(true);
    expect(() => parseArgs(['check', '--all'])).toThrow(/--all is not an option of "check"/);
    expect(() => parseArgs(['check', '--domain', 'x.json'])).toThrow(/not an option of "check"/);
  });

  it('the fixture project is clean: exit 0 with an empty findings list', async () => {
    const { code, out } = await run(['check', '--json', '--project', PROJECT], tmp);
    expect(code).toBe(0);
    const r = JSON.parse(out) as CheckResult;
    expect(r).toMatchObject({ clean: true, strict: false, counts: { errors: 0, warnings: 0, info: 0 }, findings: [] });
    expect(r.checked.modelFiles).toBe(9);
    expect(r.checked.domains).toBe(7);
    expect(r.cliVersion).toBeTruthy();

    const human = await run(['check', '--project', PROJECT], tmp);
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/No relationship problems/);
  });

  it('a sound library project passes, with the mode named', async () => {
    const root = makeProject(
      { 'dim_customer.yml': DIM_CUSTOMER, 'dim_date.yml': DIM_DATE, 'fct_order.yml': SOUND_FACT },
      { 'silver/orders.json': domain(['fct_order', 'dim_customer', 'dim_date']) },
    );
    const { result, exitCode } = runCheck({ project: root, semanticDir: '.erd-studio' });
    expect(exitCode).toBe(0);
    expect(result).toMatchObject({ clean: true, mode: 'library', checked: { modelFiles: 3, domains: 1, relationships: 2 } });
  });

  it('reports every stable code with project-relative files, errors first, and exits 1', async () => {
    const root = makeProject({
      'dim_customer.yml': DIM_CUSTOMER,
      'dim_date.yml': `${DIM_DATE}relationships:
  - fromColumn: date_key
    toModel: fct_order
    toColumn: order_date_key
    cardinality: one-to-many
`,
      // Stored twice (here and, turned round, nowhere else would be fine — but
      // the second entry below repeats the first), a missing model, a missing
      // column, a case-only match and an entry with no cardinality.
      'gold/fct_order.yml': fact(`  - fromColumn: customer_key
    toModel: dim_customer
    toColumn: customer_key
    cardinality: many-to-one
  - fromColumn: customer_key
    toModel: dim_customer
    toColumn: customer_key
    cardinality: one-to-one
  - fromColumn: order_key
    toModel: dim_ghost
    toColumn: ghost_key
    cardinality: many-to-one
  - fromColumn: order_key
    toModel: dim_customer
    toColumn: no_such_column
    cardinality: many-to-one
  - fromColumn: order_key
    toModel: DIM_DATE
    toColumn: date_key
    cardinality: many-to-one
  - fromColumn: customer_key
    toModel: dim_date
    toColumn: date_key
`),
    }, { 'silver/orders.json': domain(['fct_order', 'dim_customer', 'dim_date']) });

    const { code, out } = await run(['check', '--json', '--project', root], tmp);
    expect(code).toBe(1);
    const r = JSON.parse(out) as CheckResult;
    expect(r.clean).toBe(false);
    const codes = new Set(r.findings.map((f) => f.code));
    for (const c of ['REL001', 'REL002', 'REL003', 'REL004', 'REL005', 'REL008'] as const) {
      expect(codes, c).toContain(c);
    }
    // Errors first.
    const severities = r.findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)));
    expect(r.counts.errors).toBe(r.findings.filter((f) => f.severity === 'error').length);
    expect(r.counts.byCode.REL002).toBe(1);
    // REL001 with disagreeing copies is an error.
    expect(r.findings.find((f) => f.code === 'REL001')).toMatchObject({ severity: 'error', fix: 'choose' });
    // REL008 names the file and the line of the entry.
    const unreadable = r.findings.find((f) => f.code === 'REL008')!;
    expect(unreadable.files).toEqual(['.erd-studio/logical-models/gold/fct_order.yml']);
    expect(unreadable.line).toBeGreaterThan(0);
    // REL002 names both files: where it is, and where it belongs.
    expect(r.findings.find((f) => f.code === 'REL002')!.files).toEqual([
      '.erd-studio/logical-models/dim_date.yml', '.erd-studio/logical-models/gold/fct_order.yml',
    ]);
    // Nothing absolute leaves the CLI in a finding.
    expect(JSON.stringify(r.findings)).not.toContain(root);

    const human = await run(['check', '--project', root], tmp);
    expect(human.code).toBe(1);
    expect(human.out).toMatch(/✗ REL003 /);
    expect(human.out).toMatch(/Repair Relationships…/);
  });

  it('a domain copy of a library link that says the same is REL009 (info), found by link', async () => {
    const root = makeProject({
      'dim_customer.yml': DIM_CUSTOMER,
      'dim_date.yml': DIM_DATE,
      'fct_order.yml': SOUND_FACT,
    }, {
      'silver/orders.json': domain(['fct_order', 'dim_customer', 'dim_date'], [
        // A domain copy of a library link, saying the same: REL009 (info).
        { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
      ]),
    });
    const { result } = runCheck({ project: root, semanticDir: '.erd-studio' });
    expect(result.findings.map((f) => f.code)).toEqual(['REL009']);
    const f = result.findings[0];
    expect(f.link).toBe(linkKey({ fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' }));
  });

  it('warnings pass unless --strict; info never fails, not even with --strict', async () => {
    const warnOnly = makeProject({
      'dim_customer.yml': DIM_CUSTOMER,
      'dim_date.yml': DIM_DATE,
      'fct_order.yml': fact(`  - fromColumn: customer_key
    toModel: Dim_Customer
    toColumn: customer_key
    cardinality: many-to-one
`),
    }, { 'silver/orders.json': domain(['fct_order', 'dim_customer', 'dim_date']) });
    expect((await run(['check', '--project', warnOnly], tmp)).code).toBe(0);
    const strict = await run(['check', '--strict', '--json', '--project', warnOnly], tmp);
    expect(strict.code).toBe(1);
    expect(JSON.parse(strict.out)).toMatchObject({ clean: false, strict: true, counts: { errors: 0, warnings: 1 } });

    fs.rmSync(path.join(tmp, 'proj'), { recursive: true, force: true });
    const infoOnly = makeProject(
      { 'dim_customer.yml': DIM_CUSTOMER, 'dim_date.yml': DIM_DATE, 'fct_order.yml': SOUND_FACT },
      { 'silver/orders.json': domain(['fct_order', 'dim_customer', 'dim_date'], [
        { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
      ]) },
    );
    const info = await run(['check', '--strict', '--json', '--project', infoOnly], tmp);
    expect(info.code).toBe(0);
    expect(JSON.parse(info.out)).toMatchObject({ clean: true, counts: { errors: 0, warnings: 0, info: 1 } });
  });

  it('per-domain projects: the same link in two diagrams is not a duplicate', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const root = makeProject(
      { 'dim_customer.yml': DIM_CUSTOMER, 'fct_order.yml': fact('  []\n').replace('relationships:\n  []\n', '') },
      {
        'silver/a.json': domain(['fct_order', 'dim_customer'], [rel]),
        'gold/b.json': { ...(domain(['fct_order', 'dim_customer'], [rel]) as object), domain: 'b', layer: 'gold' },
      },
    );
    const { result, exitCode } = runCheck({ project: root, semanticDir: '.erd-studio' });
    expect(result.mode).toBe('domain');
    expect(result.findings).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it('a missing ERD Studio folder is exit 3, never a pass', async () => {
    const root = path.join(tmp, 'bare');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'dbt_project.yml'), "name: 'p'\n");
    const { code, out } = await run(['check', '--json', '--project', root], tmp);
    expect(code).toBe(3);
    expect(JSON.parse(out).error.code).toBe('no-semantic-dir');
    expect(out).not.toContain(root);

    const wrongDir = await run(['check', '--json', '--project', PROJECT, '--semantic-dir', 'elsewhere'], tmp);
    expect(wrongDir.code).toBe(3);
  });

  it('an empty ERD Studio folder is exit 3 (nothing to check)', async () => {
    const root = makeProject({});
    const { code, out } = await run(['check', '--json', '--project', root], tmp);
    expect(code).toBe(3);
    expect(JSON.parse(out).error.code).toBe('nothing-to-check');
  });

  it('writes nothing', async () => {
    const root = makeProject({
      'dim_customer.yml': DIM_CUSTOMER,
      'dim_date.yml': `${DIM_DATE}relationships:\n  - fromColumn: date_key\n    toModel: fct_order\n    toColumn: order_date_key\n    cardinality: one-to-many\n`,
      'fct_order.yml': fact('  []\n'),
    }, { 'silver/orders.json': domain(['fct_order', 'dim_customer', 'dim_date']) });
    const snapshot = (): Record<string, string> => {
      const out: Record<string, string> = {};
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else out[path.relative(root, p)] = fs.readFileSync(p, 'utf-8');
        }
      };
      walk(root);
      return out;
    };
    const before = snapshot();
    await run(['check', '--project', root], tmp);
    await run(['doctor', '--no-dbt', '--project', root], tmp);
    expect(snapshot()).toEqual(before);
  });
});

describe('doctor — relationships', () => {
  it('counts the findings and adds a fix-relationships step, still exit 0', async () => {
    const root = makeProject({
      'dim_customer.yml': DIM_CUSTOMER,
      'dim_date.yml': `${DIM_DATE}relationships:\n  - fromColumn: date_key\n    toModel: fct_order\n    toColumn: order_date_key\n    cardinality: one-to-many\n`,
      'fct_order.yml': fact(`  - fromColumn: order_key
    toModel: dim_ghost
    toColumn: ghost_key
    cardinality: many-to-one
`),
    }, { 'silver/orders.json': domain(['fct_order', 'dim_customer', 'dim_date']) });
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: tmp });
    expect(r.relationships).toMatchObject({ checked: true, mode: 'library', stored: 2, errors: 1, warnings: 1, byCode: { REL002: 1, REL003: 1 } });
    const step = r.nextSteps.find((s) => s.id === 'fix-relationships')!;
    expect(step.title).toBe('Fix 2 relationship problems');
    expect(step.why).toMatch(/1 saved in the file of the model it points at; 1 pointing at a model that is not in the model library/);
    expect(step.why).toMatch(/erd-studio check/);
    expect(step.command).toBeNull();

    const { code, out } = await run(['doctor', '--no-dbt', '--project', root], tmp);
    expect(code).toBe(0);
    expect(out).toMatch(/relationships: 2 stored entries, 1 error, 1 warning/);
  });

  it('no ERD Studio folder: not checked, no step', async () => {
    const root = path.join(tmp, 'bare');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'dbt_project.yml'), "name: 'p'\n");
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: tmp });
    expect(r.relationships).toEqual({ checked: false, mode: null, stored: 0, errors: 0, warnings: 0, info: 0, byCode: {} });
    expect(r.nextSteps.map((s) => s.id)).not.toContain('fix-relationships');
  });
});

describe('diff — advisory integrity', () => {
  it('lists the findings for the domain without changing clean, the counts or the exit code', async () => {
    const root = path.join(tmp, 'dbt-project');
    fs.cpSync(PROJECT, root, { recursive: true });
    const ctx0 = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
    const before = runDiff(ctx0, { domains: ['.erd-studio/silver/showcase.json'], cwd: root });

    // A relationship in a model file that points at a model the library does not have.
    const fct = path.join(root, '.erd-studio/logical-models/fct_order.yml');
    fs.appendFileSync(fct, 'relationships:\n  - fromColumn: customer_key\n    toModel: dim_nowhere\n    toColumn: customer_key\n    cardinality: many-to-one\n');
    const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
    const after = runDiff(ctx, { domains: ['.erd-studio/silver/showcase.json'], cwd: root });

    const d = after.result.domains[0];
    expect(d.integrity.map((f) => f.code)).toContain('REL003');
    expect(d.integrity.every((f) => !f.files.some((file) => path.isAbsolute(file)))).toBe(true);
    // Advisory: the comparison itself decides clean and the exit code.
    expect(d.clean).toBe(d.counts.blocking === 0);
    expect(after.exitCode).toBe(before.exitCode);
    expect(before.result.domains[0].integrity).toEqual([]);

    const human = await run(['diff', '--domain', '.erd-studio/silver/showcase.json', '--project', root], tmp);
    expect(human.out).toMatch(/relationship checks \(not part of the comparison/);
    expect(human.out).toMatch(/REL003/);
  });

  it('a domain with no models in common with a finding gets none', async () => {
    const root = path.join(tmp, 'dbt-project');
    fs.cpSync(PROJECT, root, { recursive: true });
    fs.appendFileSync(path.join(root, '.erd-studio/logical-models/fct_large_table.yml'),
      'relationships:\n  - fromColumn: id\n    toModel: dim_nowhere\n    toColumn: id\n    cardinality: many-to-one\n');
    const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
    const { result } = runDiff(ctx, { domains: ['.erd-studio/silver/showcase.json'], cwd: root });
    expect(result.domains[0].integrity).toEqual([]);
  });
});
