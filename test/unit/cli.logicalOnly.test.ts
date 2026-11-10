import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCliContext, resolveProjectRoot } from '../../src/cli/context';
import { DIFF_NEEDS_DBT_MESSAGE } from '../../src/cli/diff';
import { runDoctor } from '../../src/cli/doctor';
import { main } from '../../src/cli/index';
import { runInventory } from '../../src/cli/inventory';

/**
 * The CLI on a logical-only root (#PR3 B): a folder holding `.erd-studio`
 * and no dbt_project.yml. doctor runs the logical checks and skips the dbt
 * ones, inventory and export read the logical files, diff refuses.
 */

const FIXTURES = path.resolve(__dirname, '../fixtures');
const LOGICAL = path.join(FIXTURES, 'logical-only');
const DBT = path.join(FIXTURES, 'dbt-project');

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-cli-logical-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function copyLogical(): string {
  const dest = path.join(tmp, 'logical-only');
  fs.cpSync(LOGICAL, dest, { recursive: true });
  return dest;
}

async function run(argv: string[], cwd = tmp): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io = {
    stdout: { write: (s: string) => { out += s; } },
    stderr: { write: (s: string) => { err += s; } },
    cwd,
    env: { PATH: '' },
  };
  const code = await main(argv, io);
  return { code, out, err };
}

describe('project resolution', () => {
  it('accepts --project at a folder holding .erd-studio and no dbt_project.yml', () => {
    expect(resolveProjectRoot(LOGICAL, tmp)).toBe(LOGICAL);
    expect(fs.existsSync(path.join(LOGICAL, 'dbt_project.yml'))).toBe(false);
  });

  it('refuses --project at a folder with neither', () => {
    expect(resolveProjectRoot(tmp, tmp)).toBeNull();
  });

  it('honours --semantic-dir when deciding a folder is a project', () => {
    expect(resolveProjectRoot(LOGICAL, tmp, 'design')).toBeNull();
    fs.mkdirSync(path.join(tmp, 'design'));
    expect(resolveProjectRoot(tmp, tmp, 'design')).toBe(tmp);
  });

  it('finds the .erd-studio folder from inside it, walking up', () => {
    expect(resolveProjectRoot(undefined, path.join(LOGICAL, '.erd-studio', 'gold'))).toBe(LOGICAL);
    expect(resolveProjectRoot(undefined, LOGICAL)).toBe(LOGICAL);
  });

  it('a dbt project still wins over a plain folder holding .erd-studio', () => {
    fs.mkdirSync(path.join(tmp, '.erd-studio'));
    fs.mkdirSync(path.join(tmp, 'warehouse'));
    fs.writeFileSync(path.join(tmp, 'warehouse', 'dbt_project.yml'), "name: 'w'\n");
    expect(resolveProjectRoot(undefined, tmp)).toBe(path.join(tmp, 'warehouse'));
  });

  it('a design folder inside a dbt repo is its own root, as the extension opens it, not the dbt project above', async () => {
    fs.writeFileSync(path.join(tmp, 'dbt_project.yml'), "name: 'nest'\n");
    const child = path.join(tmp, 'child');
    fs.mkdirSync(path.join(child, '.erd-studio', 'gold'), { recursive: true });
    expect(resolveProjectRoot(undefined, child)).toBe(child);
    expect(resolveProjectRoot(undefined, path.join(child, '.erd-studio', 'gold'))).toBe(child);
    // Elsewhere in the repo, the dbt project above still resolves.
    fs.mkdirSync(path.join(tmp, 'models'));
    expect(resolveProjectRoot(undefined, path.join(tmp, 'models'))).toBe(tmp);
    const r = await run(['doctor', '--no-dbt', '--json'], child);
    const doc = JSON.parse(r.out);
    expect(doc.projectRoot).toBe(child);
    expect(doc.dbtProject).toBe(false);
    expect(doc.skippedChecks?.reason).toBe('not-dbt-project');
  });

  it('a dbt project folder holding .erd-studio is found from inside its .erd-studio', () => {
    fs.writeFileSync(path.join(tmp, 'dbt_project.yml'), "name: 'd'\n");
    fs.mkdirSync(path.join(tmp, '.erd-studio', 'gold'), { recursive: true });
    expect(resolveProjectRoot(undefined, path.join(tmp, '.erd-studio', 'gold'))).toBe(tmp);
  });

  it('builds a context with the dbt services off: the decoy models/ yml is never read', async () => {
    const ctx = await buildCliContext({ project: LOGICAL, semanticDir: '.erd-studio' });
    expect(ctx.hasDbt).toBe(false);
    expect(ctx.envelope.dbtProject).toBe(false);
    expect(ctx.ymlData.models.size).toBe(0);
    expect(ctx.manifest.models.size).toBe(0);
    expect(ctx.catalog).toBeUndefined();
    expect(ctx.manifestInfo.status).toBe('missing');
    expect(ctx.catalogInfo.status).toBe('missing');
  });

  it('a dbt project reports dbtProject: true', async () => {
    const ctx = await buildCliContext({ project: DBT, semanticDir: '.erd-studio' });
    expect(ctx.hasDbt).toBe(true);
    expect(ctx.envelope.dbtProject).toBe(true);
  });

  it('in a folder with neither, the no-project error names only the .erd-studio/ folder (logical first)', async () => {
    for (const argv of [['inventory'], ['export', '--all', '--format', 'mermaid'], ['changes', '--base', 'HEAD'], ['inventory', '--project', '.']]) {
      const { code, err } = await run(argv, tmp);
      expect(code, argv.join(' ')).toBe(3);
      expect(err, argv.join(' ')).toContain('No .erd-studio/ folder found');
      expect(err, argv.join(' ')).not.toMatch(/\bdbt\b|dbt_project/);
    }
  });

  it('diff, which compares with dbt, names both things it looked for', async () => {
    const { code, err } = await run(['diff', '--all'], tmp);
    expect(code).toBe(3);
    expect(err).toContain('No dbt project or .erd-studio/ folder found');
    const withProject = await run(['diff', '--all', '--project', '.'], tmp);
    expect(withProject.err).toContain('No dbt_project.yml or .erd-studio/ folder found');
  });

  it('doctor in a folder with neither names no dbt, unless a dbt flag was passed', async () => {
    const plain = await run(['doctor'], tmp);
    expect(plain.out).toContain('No .erd-studio/ folder found (looked near');
    expect(plain.out).not.toMatch(/\bdbt\b|dbt_project/);
    const flagged = await run(['doctor', '--no-dbt'], tmp);
    expect(flagged.out).toContain('No dbt project or .erd-studio/ folder found');
  });
});

describe('doctor on a logical-only root', () => {
  it('runs the logical checks, skips the dbt ones, and never probes dbt', async () => {
    let probed = 0;
    const r = await runDoctor({
      project: LOGICAL, semanticDir: '.erd-studio', env: { PATH: '' }, homeDir: tmp,
      runVersion: async () => { probed++; return { code: 0, stdout: '', stderr: '' } as never; },
    });
    expect(probed).toBe(0);
    expect(r.projectRoot).toBe(LOGICAL);
    expect(r.dbtProject).toBe(false);
    expect(r.skippedChecks).toEqual({ reason: 'not-dbt-project', checks: ['dbt', 'profiles', 'artifacts', 'projectFiles', 'deps'] });
    expect(r.project.found).toBe(false);
    expect(r.dbt).toMatchObject({ found: false, checked: false });
    expect(r.profiles.required).toBe(false);
    expect(r.projectFiles).toEqual({ schemaYmlFiles: 0, sourceFiles: 0, modelsDiscovered: 0 });
    expect(r.erd).toMatchObject({ semanticDirExists: true, layers: ['silver', 'gold'], domains: 1, logicalModels: 1, naming: 'v6' });
    expect(r.nextSteps.map((s) => s.id)).toEqual(['ready']);
    // Logical first: the prose says nothing about dbt; skippedChecks carries the reason for machines.
    expect(r.nextSteps[0].why).toBe('Your ERD Studio files are in place.');
  });

  it('still reports a logical problem as a next step, and no dbt step', async () => {
    const root = copyLogical();
    fs.writeFileSync(path.join(root, '.erd-studio/tables/broken.yml'), 'name: broken\ncolumns: [\n');
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', env: { PATH: '' }, homeDir: tmp });
    const ids = r.nextSteps.map((s) => s.id);
    expect(ids).toContain('fix-model-yaml');
    for (const dbtStep of ['install-dbt', 'create-profile', 'run-deps', 'run-parse', 'refresh-parse', 'run-catalog', 'confirm-venv']) {
      expect(ids).not.toContain(dbtStep);
    }
  });

  it('a subject area mixing the key names is pointed at export, never at diff (which needs dbt)', async () => {
    const root = copyLogical();
    const file = path.join(root, '.erd-studio/gold/sales.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"schemaVersion": 6', '"schemaVersion": 5'));
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', env: { PATH: '' }, homeDir: tmp });
    const step = r.nextSteps.find((s) => s.id === 'fix-subject-area-naming');
    expect(step?.why).toContain('`erd-studio export --domain <file> --format dbml`');
    expect(step?.why).not.toContain('erd-studio diff');
  });

  it('exits 0 and names no dbt check in human mode (the JSON still lists them as skipped)', async () => {
    const human = await run(['doctor', '--project', LOGICAL]);
    expect(human.code).toBe(0);
    expect(human.out).toContain(`ERD Studio project at ${LOGICAL}`);
    // (The worktree path itself may say dbt; only ERD Studio's own words count.)
    expect(human.out.split(LOGICAL).join('<root>')).not.toMatch(/dbt|profiles\.yml|manifest|catalog/i);

    const json = await run(['doctor', '--json', '--project', LOGICAL]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ dbtProject: false, skippedChecks: { reason: 'not-dbt-project' } });
  });

  it('a dbt project has no skippedChecks', async () => {
    const r = await runDoctor({ project: DBT, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: tmp });
    expect(r.dbtProject).toBe(true);
    expect(r.skippedChecks).toBeUndefined();
  });
});

describe('inventory on a logical-only root', () => {
  it('lists the logical tables and no dbt models', async () => {
    const ctx = await buildCliContext({ project: LOGICAL, semanticDir: '.erd-studio' });
    const r = runInventory(ctx);
    expect(r.dbtProject).toBe(false);
    expect(r.models).toEqual([]);
    expect(r.relationships).toEqual([]);
    expect(r.clusters).toEqual([]);
    expect(r.inputs).toEqual({ manifest: 'missing', catalog: 'missing' });
    expect(r.domains).toEqual([{ file: '.erd-studio/gold/sales.json', layer: 'gold', domain: 'sales', models: ['customer'], format: 'json' }]);
    expect(r.logicalTables).toEqual([{
      name: 'customer',
      file: '.erd-studio/tables/customer.yml',
      format: 'yaml',
      folder: '',
      description: 'One row per customer.',
      grain: 'customer_id',
      columnCount: 3,
      primaryKey: ['customer_id'],
      columns: [
        { name: 'customer_id', dataType: 'INT' },
        { name: 'customer_name', dataType: 'VARCHAR' },
        { name: 'signed_up_at', dataType: 'TIMESTAMP' },
      ],
      domains: ['.erd-studio/gold/sales.json'],
    }]);
    expect(r.conventions.layering.style).toBe('none');
  });

  it('--summary drops the columns and --models filters the tables', async () => {
    const ctx = await buildCliContext({ project: LOGICAL, semanticDir: '.erd-studio' });
    expect(runInventory(ctx, { summary: true }).logicalTables[0].columns).toBeUndefined();
    expect(runInventory(ctx, { models: ['CUSTOMER'] }).logicalTables.map((t) => t.name)).toEqual(['customer']);
    expect(runInventory(ctx, { models: ['nope'] }).logicalTables).toEqual([]);
  });

  it('prints the tables in human mode and exits 0', async () => {
    const { code, out } = await run(['inventory', '--summary', '--project', LOGICAL]);
    expect(code).toBe(0);
    expect(out).toContain('1 table in 1 diagram (your ERD Studio files)');
    expect(out).toContain('customer  3 columns');
    expect(out).not.toMatch(/dbt/i);
  });

  it('a dbt project lists its logical tables too', async () => {
    const ctx = await buildCliContext({ project: DBT, semanticDir: '.erd-studio' });
    const r = runInventory(ctx, { summary: true });
    expect(r.models.length).toBeGreaterThan(0);
    expect(r.logicalTables.map((t) => t.name)).toContain('dim_customer');
  });
});

describe('a logical-only DBML project (test/fixtures/dbml-native)', () => {
  const NATIVE = path.join(FIXTURES, 'dbml-native');

  it('doctor reports storage dbml, every diagram, no DBML problem and Ready', async () => {
    const r = await runDoctor({ project: NATIVE, semanticDir: '.erd-studio', noDbt: true });
    expect(r.dbtProject).toBe(false);
    expect(r.erd.storage).toBe('dbml');
    // In layers.json order (silver, then gold).
    expect(r.erd.diagrams).toEqual([
      { file: '.erd-studio/silver/diagrams/staging.dbml', format: 'dbml' },
      { file: '.erd-studio/gold/diagrams/sales.dbml', format: 'dbml' },
    ]);
    expect(r.erd.dbmlProblems).toEqual([]);
    expect(r.erd.dbmlConversion).toBeUndefined();
    expect(r.nextSteps.map((s) => s.id)).toEqual(['ready']);
  });

  it('inventory lists DBML tables and diagrams with their format and use-line members', async () => {
    const ctx = await buildCliContext({ project: NATIVE, semanticDir: '.erd-studio' });
    const r = runInventory(ctx, { summary: true });
    expect(r.domains.map((d) => [d.file, d.format, d.models])).toEqual([
      ['.erd-studio/silver/diagrams/staging.dbml', 'dbml', ['fct_order', 'dim_date']],
      ['.erd-studio/gold/diagrams/sales.dbml', 'dbml', ['fct_order', 'dim_customer', 'dim_date', 'dim_region', 'customer_profile', 'bridge_empty']],
    ]);
    expect(r.logicalTables.every((t) => t.format === 'dbml' && t.file.endsWith('.dbml'))).toBe(true);
    expect(r.logicalTables.find((t) => t.name === 'fct_order')).toMatchObject({
      file: '.erd-studio/gold/tables/gold/fct_order.dbml', folder: 'gold', primaryKey: ['order_line_id'],
    });
  });

  it('exports each DBML diagram, and diff still needs dbt', async () => {
    const one = await run(['export', '--project', NATIVE, '--domain', '.erd-studio/gold/diagrams/sales.dbml', '--format', 'dbml']);
    expect(one.code).toBe(0);
    expect(one.out).toContain('Table gold.fct_order {');
    const all = await run(['export', '--project', NATIVE, '--all', '--format', 'mermaid', '--json']);
    expect(all.code).toBe(0);
    expect((JSON.parse(all.out) as { files: Array<{ fileName: string }> }).files.map((f) => f.fileName).sort()).toEqual(['sales.mmd', 'staging.mmd']);
    const diff = await run(['diff', '--json', '--project', NATIVE, '--all']);
    expect(diff.code).toBe(3);
    expect(JSON.parse(diff.out).error.code).toBe('not-dbt-project');
  });
});

describe('export on a logical-only root', () => {
  it('exports one subject area from the logical files', async () => {
    const { code, out } = await run(['export', '--project', LOGICAL, '--domain', '.erd-studio/gold/sales.json', '--format', 'dbml']);
    expect(code).toBe(0);
    expect(out).toContain('Table customer {');
    expect(out).toContain('customer_id INT [pk]');
  });

  it('exports every subject area with --all', async () => {
    const { code, out } = await run(['export', '--project', LOGICAL, '--all', '--format', 'mermaid', '--json']);
    expect(code).toBe(0);
    const json = JSON.parse(out) as { files: Array<{ fileName: string }>; skipped: unknown[] };
    expect(json.files.map((f) => f.fileName)).toEqual(['sales.mmd']);
    expect(json.skipped).toEqual([]);
  });
});

describe('diff on a logical-only root', () => {
  it('explains it needs a dbt project and exits 3', async () => {
    for (const args of [['--all'], ['--domain', '.erd-studio/gold/sales.json']]) {
      const json = await run(['diff', '--json', '--project', LOGICAL, ...args]);
      expect(json.code).toBe(3);
      expect(JSON.parse(json.out)).toEqual({ cliVersion: expect.any(String), error: { code: 'not-dbt-project', message: DIFF_NEEDS_DBT_MESSAGE } });
    }
    const human = await run(['diff', '--all', '--project', LOGICAL]);
    expect(human.code).toBe(3);
    expect(human.err).toContain('needs a dbt project');
    expect(human.err).not.toMatch(/install dbt/i);
  });
});

describe('logical first: no dbt wording in human output on a logical-only root', () => {
  it('doctor, inventory and export say nothing about dbt; a dbt project still does', async () => {
    const root = copyLogical();
    // A yml table spelling dbt's data_type key, so doctor has a warning to word.
    fs.writeFileSync(path.join(root, '.erd-studio/tables/order.yml'),
      'name: order\ncolumns:\n  - name: order_id\n    data_type: INT\n');
    for (const argv of [
      ['doctor', '--project', root],
      ['inventory', '--project', root],
      ['inventory', '--summary', '--project', root],
    ]) {
      const r = await run(argv, root);
      expect(r.code, argv.join(' ')).toBeLessThanOrEqual(1);
      expect((r.out + r.err).split(root).join('<root>'), argv.join(' ')).not.toMatch(/\bdbt\b/i);
    }
    // export's own lines (the fixture's description is the user's text, and mentions dbt).
    const exported = await run(['export', '--domain', '.erd-studio/gold/sales.json', '--format', 'dbml', '--project', root], root);
    expect(exported.code).toBe(0);
    expect(exported.out.split('\n').filter((l) => l.startsWith('//')).join('\n')).not.toMatch(/\bdbt\b/i);
    const doctor = await run(['doctor', '--project', root]);
    expect(doctor.out).toContain("uses data_type");

    const dbt = await run(['doctor', '--no-dbt', '--project', DBT]);
    expect(dbt.out).toMatch(/dbt project .* at /);
    expect(dbt.out).toMatch(/manifest/);
    const inventory = await run(['inventory', '--summary', '--project', DBT]);
    expect(inventory.out).toMatch(/manifest/);
  });

  it("doctor's Convert preview words a table kept as missing without Add from dbt; a dbt root keeps it", async () => {
    const root = copyLogical();
    const diagram = path.join(root, '.erd-studio/gold/sales.json');
    const doc = JSON.parse(fs.readFileSync(diagram, 'utf-8'));
    doc.logical.tables.push('gone');
    fs.writeFileSync(diagram, JSON.stringify(doc, null, 2));
    const preview = async (): Promise<string> =>
      (JSON.parse((await run(['doctor', '--json', '--no-dbt', '--project', root])).out).erd.dbmlConversion?.preview ?? '') as string;

    const logical = await preview();
    expect(logical).toContain('Kept as missing on their diagrams');
    expect(logical).toContain('give each a table file later');
    expect(logical).not.toMatch(/\bdbt\b/i);

    fs.writeFileSync(path.join(root, 'dbt_project.yml'), "name: shop\nversion: '1.0.0'\n");
    expect(await preview()).toContain('create them later with Add from dbt');
  });

  it('the --json shape keeps its dbt keys on a logical-only root', async () => {
    const json = JSON.parse((await run(['doctor', '--json', '--project', LOGICAL])).out);
    expect(json).toMatchObject({ dbtProject: false, skippedChecks: { reason: 'not-dbt-project' } });
    for (const key of ['dbt', 'profiles', 'artifacts', 'projectFiles']) {
      expect(json, key).toHaveProperty(key);
    }
  });
});
