/**
 * `erd-studio check` (issue #133): the project's relationship checks, run on
 * real files in a temp project and through `main()`, so the exit codes, the
 * JSON shape and the human output are what an assistant or CI actually sees.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkKey } from '@erd-studio/core';

import { runCheck, type CheckResult } from '../../src/cli/check';
import { runDoctor } from '../../src/cli/doctor';
import { buildCliContext } from '../../src/cli/context';
import { runDiff } from '../../src/cli/diff';
import { main } from '../../src/cli/index';
import { parseArgs } from '../../src/cli/args';
import { LogicalModelService } from '../../src/services/logicalModelService';

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
    expect(r.relationships).toEqual({ checked: false, mode: null, stored: 0, errors: 0, warnings: 0, info: 0, byCode: {}, unchecked: 0, uncheckedFiles: [] });
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

describe('check — domain files are never skipped without a word', () => {
  const ENTRY = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
  const models = { 'dim_customer.yml': DIM_CUSTOMER, 'dim_date.yml': DIM_DATE, 'fct_order.yml': fact('  []\n') };

  it('reports a domain entry with a misspelt or missing cardinality, or a missing end, as REL008 — and exits 1', async () => {
    const root = makeProject(models, {
      'silver/orders.json': domain(['fct_order', 'dim_customer', 'dim_date'], [
        { ...ENTRY, cardinality: 'one_to_many' },
        { fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'dim_date' },
        { fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key' },
      ]),
    });
    const { result, exitCode } = runCheck({ project: root, semanticDir: '.erd-studio' });
    expect(exitCode).toBe(1);
    expect(result.clean).toBe(false);
    const rel008 = result.findings.filter((f) => f.code === 'REL008');
    expect(rel008.map((f) => f.message)).toEqual([
      expect.stringMatching(/silver\/orders\.json: Relationship entry 1 of diagram silver\/orders has cardinality "one_to_many", which is not one of .*read as many-to-one/),
      expect.stringMatching(/silver\/orders\.json: Relationship entry 2 of diagram silver\/orders has no toColumn and was skipped/),
      expect.stringMatching(/silver\/orders\.json: Relationship entry 3 of diagram silver\/orders has no cardinality; read as many-to-one/),
    ]);
    for (const f of rel008) expect(f).toMatchObject({ severity: 'error', files: ['.erd-studio/silver/orders.json'], fix: 'open-file' });
  });

  it('names a domain record by its place in the file, counting the entries that could not be read', async () => {
    const root = makeProject(models, {
      'silver/orders.json': domain(['fct_order', 'dim_customer'], [
        'not a relationship',
        { ...ENTRY, toColumn: 'nope' },
      ]),
    });
    const { result } = runCheck({ project: root, semanticDir: '.erd-studio' });
    const rel004 = result.findings.find((f) => f.code === 'REL004')!;
    expect(rel004.records?.[0].source).toEqual({ kind: 'domain', index: 1 });
  });

  it('a domain file that cannot be read makes the run not clean, exit 1, and is named', async () => {
    const root = makeProject(models, {
      'silver/orders.json': domain(['fct_order', 'dim_customer'], [ENTRY]),
    });
    fs.mkdirSync(path.join(root, '.erd-studio', 'gold'), { recursive: true });
    fs.writeFileSync(path.join(root, '.erd-studio', 'gold', 'broken.json'), '{ "broken');
    const { result, exitCode } = runCheck({ project: root, semanticDir: '.erd-studio' });
    expect(exitCode).toBe(1);
    expect(result.clean).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.unchecked).toEqual([{ file: '.erd-studio/gold/broken.json', reason: expect.stringMatching(/^it could not be read/), kind: 'domain' }]);
    const { code, out } = await run(['check', '--project', root], tmp);
    expect(code).toBe(1);
    expect(out).toMatch(/1 diagram file could not be checked/);
    expect(out).toMatch(/\.erd-studio\/gold\/broken\.json was not checked: it could not be read/);
  });

  it('a hybrid (unloadable) domain file is named too, pointing at the migration', async () => {
    const root = makeProject(models, {
      'silver/orders.json': domain(['fct_order', 'dim_customer'], [ENTRY]),
      'gold/mixed.json': { schemaVersion: 5, domain: 'mixed', layer: 'gold', logical: { models: ['fct_order', { name: 'x', columns: [] }], relationships: [] } },
    });
    const { result, exitCode } = runCheck({ project: root, semanticDir: '.erd-studio' });
    expect(exitCode).toBe(1);
    expect(result.unchecked).toEqual([{ file: '.erd-studio/gold/mixed.json', reason: expect.stringMatching(/Migrate Domains to Central Model Store/), kind: 'domain' }]);
  });

  it('says Repair Relationships… does not change a v4 diagram, and points at the migration', async () => {
    const root = makeProject(models, {
      'gold/legacy.json': {
        schemaVersion: 4, domain: 'legacy', layer: 'gold',
        logical: {
          models: [{ name: 'a', columns: [{ name: 'id', dataType: 'INT' }] }, { name: 'b', columns: [{ name: 'a_id', dataType: 'INT' }] }],
          relationships: [{ fromModel: 'b', fromColumn: 'nope', toModel: 'a', toColumn: 'id', cardinality: 'many-to-one' }],
        },
      },
    });
    const { result } = runCheck({ project: root, semanticDir: '.erd-studio' });
    expect(result.olderFormat).toEqual(['.erd-studio/gold/legacy.json']);
    expect(result.findings.map((f) => f.code)).toEqual(['REL004']);
    const { out } = await run(['check', '--project', root], tmp);
    expect(out).toMatch(/does not change diagrams still in the older format \(\.erd-studio\/gold\/legacy\.json\)/);
  });
});

describe('doctor and diff — a relationship check that could not run is said, never shown as nothing to check', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('doctor names the failure and keeps exit 0', async () => {
    const root = makeProject({ 'dim_customer.yml': DIM_CUSTOMER }, { 'silver/orders.json': domain(['dim_customer']) });
    vi.spyOn(LogicalModelService.prototype, 'relationshipCheckModels').mockImplementation(() => { throw new Error('boom'); });
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: tmp });
    expect(r.relationships).toMatchObject({ checked: false, failed: 'boom' });
    const { code, out } = await run(['doctor', '--no-dbt', '--project', root], tmp);
    expect(code).toBe(0);
    expect(out).toMatch(/relationships: not checked — boom \(run erd-studio check\)/);
  });

  it('diff carries integrityError and says so in its output', async () => {
    const root = path.join(tmp, 'dbt-project');
    fs.cpSync(PROJECT, root, { recursive: true });
    const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
    vi.spyOn(LogicalModelService.prototype, 'relationshipCheckModels').mockImplementation(() => { throw new Error('boom'); });
    const { result } = runDiff(ctx, { domains: ['.erd-studio/silver/showcase.json'], cwd: root });
    expect(result.integrityError).toBe('boom');
    const { out } = await run(['diff', '--project', root, '--domain', '.erd-studio/silver/showcase.json'], tmp);
    expect(out).toMatch(/relationship checks not run — boom/);
  });
});

describe('check — nothing it could not read passes as clean (#133 review)', () => {
  const BROKEN_FACT = `name: fct_order
description: Orders: one row: per order
columns:
  - name: customer_key
    dataType: INT
relationships:
  - fromColumn: customer_key
    toModel: dim_ghost
    toColumn: nope
    cardinality: many-to-one
`;

  it('a model file that does not parse makes the run not clean, exit 1, and is named with its line', async () => {
    const root = makeProject({ 'fct_order.yml': BROKEN_FACT });
    const { result, exitCode } = runCheck({ project: root, semanticDir: '.erd-studio' });
    expect(exitCode).toBe(1);
    expect(result.clean).toBe(false);
    expect(result.unchecked).toEqual([{
      file: '.erd-studio/logical-models/fct_order.yml',
      reason: expect.stringMatching(/^it has a YAML error on line \d+, so the relationships in it were not checked$/),
      kind: 'model',
    }]);
    const { code, out } = await run(['check', '--project', root], tmp);
    expect(code).toBe(1);
    expect(out).toMatch(/1 model file could not be checked/);
    expect(out).not.toContain('No relationship problems');
  });

  it.each([
    ['no `name:`', `columns:
  - name: customer_key
    dataType: INT
relationships:
  - fromColumn: customer_key
    toModel: dim_nope
    toColumn: nope
    cardinality: bogus
`],
    ['empty', ''],
    ['a top-level list', '- a\n- b\n'],
  ])('a model file that holds no model (%s) makes the run not clean, exit 1, and is named', async (_label, text) => {
    const root = makeProject({ 'fct_order.yml': text });
    const { result, exitCode } = runCheck({ project: root, semanticDir: '.erd-studio' });
    expect(exitCode).toBe(1);
    expect(result.clean).toBe(false);
    expect(result.unchecked).toEqual([{
      file: '.erd-studio/logical-models/fct_order.yml',
      reason: 'it holds no model (it is empty, not a mapping, or has no `name:`), so the relationships in it were not checked',
      kind: 'model',
    }]);
    const { code, out } = await run(['check', '--project', root], tmp);
    expect(code).toBe(1);
    expect(out).not.toContain('No relationship problems');
  });

  it('a layers.json that cannot be used makes the run not clean, so a skipped layer folder is never a pass', async () => {
    const root = makeProject({ 'dim_customer.yml': DIM_CUSTOMER }, {
      'marts/o.json': domain(['dim_customer'], [{ fromModel: 'dim_customer' }]),
    });
    fs.writeFileSync(path.join(root, '.erd-studio', 'layers.json'), '{ "schemaVersion": 1, "layers": [], }');
    const { result, exitCode } = runCheck({ project: root, semanticDir: '.erd-studio' });
    expect(exitCode).toBe(1);
    expect(result.clean).toBe(false);
    expect(result.unchecked).toEqual([expect.objectContaining({ file: '.erd-studio/layers.json', kind: 'layers' })]);
    expect(result.unchecked[0].reason).toMatch(/diagrams in layer folders it names may not have been checked/);
  });

  it('a project whose only domain file cannot be read is exit 1 with the file named, not "nothing to check"', async () => {
    const root = makeProject({});
    fs.mkdirSync(path.join(root, '.erd-studio', 'silver'), { recursive: true });
    fs.writeFileSync(path.join(root, '.erd-studio', 'silver', 'o.json'), '{ not json');
    const { result, exitCode } = runCheck({ project: root, semanticDir: '.erd-studio' });
    expect(exitCode).toBe(1);
    expect(result.unchecked.map((u) => u.file)).toEqual(['.erd-studio/silver/o.json']);
  });

  it('a library record\'s source.index in the JSON is its place in the file, counting an entry the reader skipped', () => {
    const fct = `name: fct_order
columns:
  - name: customer_key
    dataType: INT
relationships:
  - { fromColumn: customer_key, toModel: dim_customer, toColumn: customer_key, cardinality: many-to-one }
  - { fromColumn: customer_key, toColumn: customer_key }
  - { fromColumn: customer_key, toModel: dim_customer, toColumn: customer_key, cardinality: many-to-one }
`;
    const root = makeProject({ 'dim_customer.yml': DIM_CUSTOMER, 'fct_order.yml': fct });
    const { result } = runCheck({ project: root, semanticDir: '.erd-studio' });
    const dup = result.findings.find((f) => f.code === 'REL001')!;
    expect(dup.records!.map((r) => r.source.index)).toEqual([0, 2]);
    expect(dup.message).toMatch(/entry 1, .*entry 3\)/);
  });
});

describe('doctor — never "Ready" when the relationship checks did not cover everything (#133 review)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('a domain file the checks could not read gets its own next step', async () => {
    const root = makeProject({ 'dim_customer.yml': DIM_CUSTOMER }, { 'silver/orders.json': domain(['dim_customer']) });
    fs.writeFileSync(path.join(root, '.erd-studio', 'silver', 'broken.json'), '{ broken');
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: tmp });
    expect(r.relationships.unchecked).toBe(1);
    const ids = r.nextSteps.map((s) => s.id);
    expect(ids).toContain('check-relationships');
    expect(ids).not.toContain('ready');
    expect(r.nextSteps.find((s) => s.id === 'check-relationships')!.why).toContain('.erd-studio/silver/broken.json');
  });

  it('a model file that holds no model (no `name:`) gets a next step: there is no parse error to fix-model-yaml', async () => {
    const root = makeProject({ 'dim_customer.yml': DIM_CUSTOMER, 'fct_order.yml': 'columns:\n  - name: customer_key\n' }, { 'silver/orders.json': domain(['dim_customer']) });
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: tmp });
    expect(r.relationships.unchecked).toBe(1);
    const ids = r.nextSteps.map((s) => s.id);
    expect(ids).not.toContain('fix-model-yaml');
    expect(ids).toContain('check-relationships');
    expect(ids).not.toContain('ready');
    expect(r.nextSteps.find((s) => s.id === 'check-relationships')!.why).toContain('.erd-studio/logical-models/fct_order.yml: it holds no model');
  });

  it('checks that could not run get a next step too', async () => {
    const root = makeProject({ 'dim_customer.yml': DIM_CUSTOMER }, { 'silver/orders.json': domain(['dim_customer']) });
    vi.spyOn(LogicalModelService.prototype, 'relationshipCheckModels').mockImplementation(() => { throw new Error('boom'); });
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: tmp });
    expect(r.nextSteps.map((s) => s.id)).toContain('check-relationships');
    expect(r.nextSteps.map((s) => s.id)).not.toContain('ready');
  });
});

describe('check — the same gate the canvas and diff load through (#133 review)', () => {
  const models = { 'dim_customer.yml': DIM_CUSTOMER, 'fct_order.yml': fact('  []\n') };
  const ENTRY = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };

  it('a domain file with no numeric schemaVersion, or a newer one, is named as unchecked and fails the run', async () => {
    const { schemaVersion: _drop, ...noVersion } = domain(['fct_order', 'dim_customer'], [ENTRY]) as Record<string, unknown>;
    const root = makeProject(models, {
      'gold/nover.json': noVersion,
      'gold/future.json': { ...(domain(['fct_order', 'dim_customer'], [{ ...ENTRY, toColumn: 'nope' }]) as Record<string, unknown>), schemaVersion: 99 },
    });
    const { result, exitCode } = runCheck({ project: root, semanticDir: '.erd-studio' });
    expect(exitCode).toBe(1);
    expect(result.clean).toBe(false);
    expect(result.checked.domains).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.unchecked).toEqual([
      { file: '.erd-studio/gold/future.json', reason: expect.stringMatching(/schemaVersion 99, newer than this version of ERD Studio reads \(up to 5\)/), kind: 'domain' },
      { file: '.erd-studio/gold/nover.json', reason: expect.stringMatching(/no numeric "schemaVersion"/), kind: 'domain' },
    ]);
  });

  it('a v4 record\'s source.index is its place in the file, counting an entry the reader skipped', () => {
    const root = makeProject(models, {
      'silver/bob.json': {
        schemaVersion: 4, domain: 'bob', layer: 'silver',
        logical: {
          models: [{ name: 'a', columns: [{ name: 'b_id', dataType: 'INT' }] }, { name: 'b', columns: [{ name: 'id', dataType: 'INT' }] }],
          relationships: [
            { fromModel: 'a', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one' },
            { fromModel: 'a', fromColumn: 'b_id', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one' },
            { fromModel: 'a', fromColumn: 'b_id', toModel: 'b', toColumn: 'id', cardinality: 'one-to-one' },
          ],
        },
      },
    });
    const { result } = runCheck({ project: root, semanticDir: '.erd-studio' });
    const dup = result.findings.find((f) => f.code === 'REL001')!;
    expect(dup.message).toMatch(/entry 2; .*entry 3\)/);
    expect(dup.records!.map((r) => r.source.index)).toEqual([1, 2]);
  });

  it('diff gives a v4 diagram only its own file\'s findings, never the model library\'s', async () => {
    const root = makeProject({
      'dim_customer.yml': `${DIM_CUSTOMER}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n  - { fromColumn: customer_key }\n`,
      'fct_order.yml': fact('  []\n'),
    }, {
      'gold/finance.json': {
        schemaVersion: 4, domain: 'finance', layer: 'gold',
        logical: {
          models: [{ name: 'dim_customer', columns: [{ name: 'customer_key', dataType: 'INT' }] }, { name: 'fct_order', columns: [{ name: 'customer_key', dataType: 'INT' }] }],
          relationships: [{ ...ENTRY, toColumn: 'nope' }],
        },
      },
    });
    const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
    const all = runCheck({ project: root, semanticDir: '.erd-studio' }).result.findings.map((f) => f.code).sort();
    expect(all).toEqual(['REL002', 'REL004', 'REL008']);
    const { result } = runDiff(ctx, { domains: ['.erd-studio/gold/finance.json'], cwd: root });
    const d = result.domains[0];
    expect(d.needsMigration).toBe(true);
    expect(d.integrity.map((f) => f.code)).toEqual(['REL004']);
    expect(d.integrity.every((f) => f.files.includes('.erd-studio/gold/finance.json'))).toBe(true);
  });
});
