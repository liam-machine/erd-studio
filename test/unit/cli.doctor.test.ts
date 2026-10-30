import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDoctor, type DoctorResult } from '../../src/cli/doctor';
import { main } from '../../src/cli/index';
import { unimportedRelationshipsMessage } from '../../src/services/domainService';
import { HARNESS_VERSION } from '../../src/services/harnessService';

const FIXTURES = path.resolve(__dirname, '../fixtures');

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-cli-doctor-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A copy of a fixture project in the temp dir, so a test can add files to it. */
function copyFixture(name: string): string {
  const dest = path.join(tmp, name);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

/** The dbml-native fixture's files, relative to its .erd-studio (the layer-first tree). */
const SALES = 'gold/diagrams/sales.dbml';
const STAGING = 'silver/diagrams/staging.dbml';
const FCT_ORDER = 'gold/tables/gold/fct_order.dbml';
const DIM_CUSTOMER = 'gold/tables/gold/dim_customer.dbml';
const DIM_REGION = 'gold/tables/gold/dim_region.dbml';
const BRIDGE = 'gold/tables/gold/bridge_empty.dbml';
const DIM_DATE = 'silver/tables/calendar/dim_date.dbml';
const GOLD_REL = 'gold/relationships/gold.dbml';
const CALENDAR_REL = 'silver/relationships/calendar.dbml';

/** An environment with nothing on PATH, so the machine's own dbt and profiles never leak in. */
const cleanEnv: NodeJS.ProcessEnv = { PATH: '' };

const CORE_OUTPUT = `Core:
  - installed: 1.9.4
  - latest:    1.9.4 - Up to date!

Plugins:
  - duckdb: 1.9.1 - Up to date!
`;

function writeFakeDbt(file: string, output: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\n${output}EOF\n`, { mode: 0o755 });
}

describe('doctor', () => {
  it('reports the fixture project with --no-dbt', async () => {
    const r = await runDoctor({ project: path.join(FIXTURES, 'dbt-project'), semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.projectRoot).toBe(path.join(FIXTURES, 'dbt-project'));
    expect(r.project).toEqual({ found: true, name: 'test_project', profile: 'test', modelPaths: ['models'], targetPath: 'target' });
    expect(r.dbt).toMatchObject({ found: false, checked: false, commands: { parse: null, catalog: null, debug: null } });
    expect(r.runtime.kind).toBe('node');
    expect(r.artifacts.manifest.path).toBe('target/manifest.json');
    expect(['ok', 'stale']).toContain(r.artifacts.manifest.status);
    expect(r.artifacts.manifest.models).toBe(4);
    expect(r.artifacts.catalog.path).toBe('target/catalog.json');
    expect(r.artifacts.catalog.nodes).toBe(5);
    expect(r.erd.semanticDirExists).toBe(true);
    expect(r.erd.layers).toEqual(['silver', 'gold']);
    expect(r.erd.domains).toBe(7);
    expect(r.erd.logicalModels).toBe(9);
    expect(r.erd.domainFormatIssues).toContainEqual({ file: '.erd-studio/gold/finance.json', format: 'v4' });
    expect(r.harness.version).toBe(HARNESS_VERSION);
    expect(r.nextSteps.map((s) => s.id)).toContain('migrate-v5');
    expect(r.nextSteps.map((s) => s.id)).not.toContain('install-dbt'); // not checked, so not claimed missing
    expect(r.projectFiles.sourceFiles).toBeGreaterThan(0);
    expect(r.profiles.searched).toEqual(['profiles.yml', '~/.dbt/profiles.yml']);
  });

  it('reports "no project" without failing', async () => {
    const r = await runDoctor({ project: tmp, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.project.found).toBe(false);
    expect(r.nextSteps).toEqual([]);
  });

  it('suggests installing dbt (optional) when it is not found', async () => {
    const root = copyFixture('dbt-project-modern-tests');
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', env: cleanEnv, homeDir: home });
    expect(r.dbt).toMatchObject({ found: false, checked: true, flavour: null });
    const ids = r.nextSteps.map((s) => s.id);
    expect(ids[0]).toBe('install-dbt');
    expect(ids).toContain('run-parse'); // no manifest in this fixture
    expect(r.nextSteps.find((s) => s.id === 'run-parse')!.command).toBeNull();
    expect(r.artifacts.manifest.status).toBe('missing');
    expect(r.erd.semanticDirExists).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('finds dbt Core in the project venv and gives venv-relative commands', async () => {
    const root = copyFixture('dbt-project-modern-tests');
    writeFakeDbt(path.join(root, '.venv', 'bin', 'dbt'), CORE_OUTPUT);
    fs.writeFileSync(path.join(root, '.venv', 'bin', 'activate'), '');
    // Without --trust-venv a dbt the project ships is reported, never run.
    const untrusted = await runDoctor({ project: root, semanticDir: '.erd-studio', env: cleanEnv, homeDir: home });
    expect(untrusted.dbt).toMatchObject({ found: false, checked: true, untrustedVenvDbt: '.venv/bin/dbt', rawVersionOutput: null });
    expect(untrusted.nextSteps[0]).toMatchObject({ id: 'confirm-venv', command: null });
    expect(untrusted.nextSteps[0].why).toContain('.venv/bin/dbt');
    expect(untrusted.nextSteps.map((s) => s.id)).not.toContain('install-dbt');

    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', env: cleanEnv, homeDir: home, trustVenv: true });
    expect(r.dbt).toMatchObject({
      untrustedVenvDbt: null,
      found: true,
      source: 'venv',
      executable: path.join(root, '.venv', 'bin', 'dbt'),
      venvDir: '.venv',
      flavour: 'core-v1',
      version: '1.9.4',
      commands: { parse: '.venv/bin/dbt parse', catalog: '.venv/bin/dbt docs generate', debug: '.venv/bin/dbt debug' },
    });
    expect(r.dbt.rawVersionOutput!.split('\n')).toEqual(['Core:', '  - installed: 1.9.4', '  - latest:    1.9.4 - Up to date!', 'Plugins:', '  - duckdb: 1.9.1 - Up to date!']);
    expect(r.nextSteps.find((s) => s.id === 'run-parse')!.command).toBe('.venv/bin/dbt parse');
    // No profiles.yml anywhere: dbt parse needs one.
    expect(r.profiles).toMatchObject({ required: true, found: false });
    expect(r.nextSteps.map((s) => s.id)).toContain('create-profile');
  });

  it.skipIf(process.platform === 'win32')('honours --dbt <path> and classifies Fusion', async () => {
    const root = copyFixture('dbt-project-modern-tests');
    const fusion = path.join(tmp, 'tools', 'dbt');
    writeFakeDbt(fusion, 'dbt-fusion 2.0.0-preview.92\n');
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', dbt: fusion, env: cleanEnv, homeDir: home });
    expect(r.dbt).toMatchObject({ found: true, source: 'override', flavour: 'fusion-v2', version: '2.0.0-preview.92' });
    expect(r.dbt.commands.catalog).toBe(`${fusion} compile --write-catalog`);
  });

  it('marks a cloud CLI catalog step as not guaranteed locally and does not require profiles', async () => {
    const root = copyFixture('dbt-project-modern-tests');
    const r = await runDoctor({
      project: root,
      semanticDir: '.erd-studio',
      env: { PATH: path.join(tmp, 'bin') },
      homeDir: home,
      runVersion: async () => ({ output: 'dbt Cloud CLI - 0.40.14 (abc123 2025-01-01)\n' }),
      dbt: process.execPath, // any existing executable: runVersion is stubbed
    });
    expect(r.dbt.flavour).toBe('cloud-cli');
    expect(r.profiles.required).toBe(false);
    expect(r.nextSteps.map((s) => s.id)).not.toContain('create-profile');
    expect(r.nextSteps.find((s) => s.id === 'run-catalog')!.why).toMatch(/not guaranteed/);
  });

  it('finds profiles.yml via DBT_PROFILES_DIR and checks the profile is defined', async () => {
    const root = copyFixture('dbt-project');
    const profilesDir = path.join(tmp, 'profiles');
    fs.mkdirSync(profilesDir);
    fs.writeFileSync(path.join(profilesDir, 'profiles.yml'), 'test:\n  target: dev\n');
    const r = await runDoctor({
      project: root, semanticDir: '.erd-studio', env: { PATH: '', DBT_PROFILES_DIR: profilesDir }, homeDir: home,
      runVersion: async () => ({ output: CORE_OUTPUT }), dbt: process.execPath,
    });
    expect(r.profiles).toMatchObject({ required: true, found: true, profileDefined: true });
    expect(r.nextSteps.map((s) => s.id)).not.toContain('create-profile');
  });

  it('emits run-deps when packages.yml is declared but not installed (A6)', async () => {
    const root = copyFixture('dbt-project');
    fs.writeFileSync(path.join(root, 'packages.yml'), 'packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.1.1\n');
    const r = await runDoctor({
      project: root, semanticDir: '.erd-studio', env: cleanEnv, homeDir: home,
      runVersion: async () => ({ output: CORE_OUTPUT }), dbt: process.execPath,
    });
    const deps = r.nextSteps.find((s) => s.id === 'run-deps')!;
    expect(deps.command).toMatch(/ deps$/);
    fs.mkdirSync(path.join(root, 'dbt_packages', 'dbt_utils'), { recursive: true });
    const after = await runDoctor({ project: root, semanticDir: '.erd-studio', env: cleanEnv, homeDir: home, noDbt: true });
    expect(after.nextSteps.map((s) => s.id)).not.toContain('run-deps');
  });

  it('flags a catalog older than the manifest, and a missing manifest', async () => {
    const root = copyFixture('dbt-project');
    // dbt generated this catalog before the manifest (recorded in metadata.generated_at) — file
    // times are deliberately not the evidence, since a git checkout scrambles them.
    const catalogFile = path.join(root, 'target', 'catalog.json');
    fs.writeFileSync(catalogFile, fs.readFileSync(catalogFile, 'utf8')
      .replace(/"generated_at":\s*"[^"]*"/, '"generated_at": "2020-01-01T00:00:00Z"'));
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.artifacts.catalog.status).toBe('older-than-manifest');
    expect(r.nextSteps.map((s) => s.id)).toContain('run-catalog');

    fs.rmSync(path.join(root, 'target', 'manifest.json'));
    const r2 = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r2.artifacts.manifest).toMatchObject({ status: 'missing', models: null, modifiedAt: null });
  });

  it('reports a manifest dbt changed after as stale, a fresh one as ok', async () => {
    const root = copyFixture('dbt-project');
    const past = new Date('2020-01-01T00:00:00Z');
    // Whole seconds: utimes stores seconds as a float, so a millisecond-precise Date can read
    // back 1 ms off (…848Z vs …849Z) and flake an exact timestamp comparison.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); } else { fs.utimesSync(full, past, past); }
      }
    };
    walk(path.join(root, 'models'));
    fs.utimesSync(path.join(root, 'target', 'manifest.json'), now, now);
    fs.utimesSync(path.join(root, 'target', 'catalog.json'), now, now);
    const fresh = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(fresh.artifacts.manifest.status).toBe('ok');
    expect(fresh.artifacts.catalog.status).toBe('ok');

    const later = new Date(now.getTime() + 60_000);
    fs.utimesSync(path.join(root, 'models', 'silver', 'dim_task.yml'), later, later);
    const stale = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(stale.artifacts.manifest.status).toBe('stale');
    expect(stale.artifacts.manifest.newestSourceChange).toBe(later.toISOString());
    expect(stale.nextSteps.map((s) => s.id)).toContain('refresh-parse');
  });

  it('calls a malformed manifest unreadable', async () => {
    const root = copyFixture('dbt-project');
    fs.writeFileSync(path.join(root, 'target', 'manifest.json'), '{ "nodes": ');
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.artifacts.manifest.status).toBe('unreadable');
    expect(r.nextSteps.map((s) => s.id)).toContain('run-parse');
  });

  it('says ready when nothing is left to do', async () => {
    const root = copyFixture('dbt-project-sparse');
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true });
    // Whole seconds: utimes stores seconds as a float, so a millisecond-precise Date can read
    // back 1 ms off (…848Z vs …849Z) and flake an exact timestamp comparison.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.writeFileSync(path.join(root, 'target', 'catalog.json'), JSON.stringify({ metadata: {}, nodes: {}, sources: {} }));
    fs.utimesSync(path.join(root, 'target', 'manifest.json'), now, now);
    const r: DoctorResult = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.nextSteps.map((s) => s.id)).toEqual(['ready']);
  });
});

describe('doctor via main', () => {
  it('reports a model file that does not parse, with its line, and a fix-model-yaml next step', async () => {
    const root = copyFixture('dbt-project');
    fs.writeFileSync(
      path.join(root, '.erd-studio/logical-models/fct_task_event.yml'),
      'name: fct_task_event\ndescription: Status: one of a, b\ncolumns: []\n',
    );
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.erd.unreadableModelFiles).toEqual([expect.objectContaining({
      name: 'fct_task_event',
      file: '.erd-studio/logical-models/fct_task_event.yml',
      line: 2,
      code: 'BLOCK_AS_IMPLICIT_KEY',
      kind: 'yamlScalar',
    })]);
    const step = r.nextSteps.find((s) => s.id === 'fix-model-yaml');
    expect(step).toBeDefined();
    expect(step!.why).toContain('.erd-studio/logical-models/fct_task_event.yml:2');
    expect(step!.why).not.toContain(root);

    let out = '';
    const code = await main(['doctor', '--project', root, '--no-dbt'], {
      stdout: { write: (s: string) => { out += s; } },
      stderr: { write: () => undefined },
      cwd: root,
      env: cleanEnv,
    });
    expect(code).toBe(0);
    expect(out).toContain('fct_task_event.yml line 2: YAML error (BLOCK_AS_IMPLICIT_KEY)');

    const clean = await runDoctor({ project: path.join(FIXTURES, 'dbt-project'), semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(clean.erd.unreadableModelFiles).toEqual([]);
    expect(clean.nextSteps.some((s) => s.id === 'fix-model-yaml')).toBe(false);
  });

  it("says the Convert counts leave out a v4 file's tables and diagram, which the v4 → v5 step adds", async () => {
    let out = '';
    const root = copyFixture('dbt-project');
    fs.writeFileSync(path.join(root, '.erd-studio/silver/legacy.json'), JSON.stringify({
      schemaVersion: 4, domain: 'legacy', layer: 'silver',
      logical: { models: [{ name: 'dim_zone', columns: [{ name: 'zone_key', dataType: 'INT', isPrimaryKey: true }] }], relationships: [] },
    }));
    await main(['doctor', '--project', root, '--no-dbt'], {
      stdout: { write: (s: string) => { out += s; } },
      stderr: { write: () => undefined },
      cwd: root,
      env: cleanEnv,
    });
    expect(out).toMatch(/"Convert Project to DBML" in VS Code would write \d+ tables?, \d+ diagrams? and \d+ relationships? as DBML, after the v4 → v5 step for silver\/legacy\.json, which also adds that file's tables and diagram \(not counted here\)/);
  });

  it('lists a key written twice with its key and line, saying the model still loads (#164)', async () => {
    const root = copyFixture('dbt-project');
    fs.writeFileSync(
      path.join(root, '.erd-studio/logical-models/fct_task_event.yml'),
      'name: fct_task_event\ndescription: one\ndescription: two\ncolumns: []\n',
    );
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.erd.unreadableModelFiles).toEqual([expect.objectContaining({
      name: 'fct_task_event', line: 3, kind: 'yamlDuplicateKey', code: 'DUPLICATE_KEY', readable: true, key: 'description',
    })]);
    const step = r.nextSteps.find((s) => s.id === 'fix-model-yaml')!;
    expect(step.why).toContain('fct_task_event.yml:3');
    expect(step.why).toContain('`description` is written twice in one block');
    expect(step.why).not.toContain('as empty');

    let out = '';
    await main(['doctor', '--project', root, '--no-dbt'], {
      stdout: { write: (s: string) => { out += s; } },
      stderr: { write: () => undefined },
      cwd: root,
      env: cleanEnv,
    });
    expect(out).toContain('fct_task_event.yml line 3: `description` is written twice in one block');
  });

  it('names a relationship drawn backwards, once, with a next step (#163)', async () => {
    const root = copyFixture('dbt-project');
    const before = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(before.erd.backwardsRelationships).toEqual([]);
    expect(before.nextSteps.map((s) => s.id)).not.toContain('turn-round-relationships');

    // 1.6.7's shape: the customer link stored from dim_customer's key into the fact.
    const file = path.join(root, '.erd-studio/silver/showcase.json');
    const domain = JSON.parse(fs.readFileSync(file, 'utf-8'));
    domain.logical.relationships = domain.logical.relationships.map((r: Record<string, string>) =>
      r.fromModel === 'fct_order' && r.toModel === 'dim_customer'
        ? { ...r, fromModel: 'dim_customer', fromColumn: r.toColumn, toModel: 'fct_order', toColumn: r.fromColumn }
        : r);
    fs.writeFileSync(file, JSON.stringify(domain, null, 2) + '\n');

    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.erd.backwardsRelationships).toEqual([{
      fromModel: 'dim_customer', fromColumns: ['customer_key'], toModel: 'fct_order', toColumns: ['customer_key'],
      cardinality: 'many-to-one', domains: ['.erd-studio/silver/showcase.json'],
    }]);
    expect(r.nextSteps.map((s) => s.id)).toContain('turn-round-relationships');
    expect(r.nextSteps.find((s) => s.id === 'turn-round-relationships')!.why).toMatch(/^1 relationship looks drawn backwards/);

    let out = '';
    await main(['doctor', '--project', root, '--no-dbt'], {
      stdout: { write: (s: string) => { out += s; } },
      stderr: { write: () => undefined },
      cwd: root,
      env: cleanEnv,
    });
    expect(out).toContain("dim_customer.customer_key → fct_order.customer_key looks drawn backwards (it starts at dim_customer's key)");
  });

  it('names model files that spell a column type data_type, as a warning and never a next step (#144)', async () => {
    const root = copyFixture('dbt-project');
    const before = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(before.erd.dataTypeAliasFiles).toEqual([]);

    fs.mkdirSync(path.join(root, '.erd-studio/logical-models/gold'));
    fs.writeFileSync(
      path.join(root, '.erd-studio/logical-models/gold/fct_refund.yml'),
      [
        'name: fct_refund',
        'columns:',
        '  - name: refund_id',
        '    dataType: INT',
        '  - name: amount',
        '    data_type: DECIMAL(18,2)',
        '  - name: reason',
        '    dataType: VARCHAR',
        '    data_type: TEXT',
        '',
      ].join('\n'),
    );
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    // `reason` has both keys: its data_type is ignored and never renamed, so it
    // is listed apart from the columns the next write renames.
    expect(r.erd.dataTypeAliasFiles).toEqual([
      { name: 'fct_refund', file: '.erd-studio/logical-models/gold/fct_refund.yml', columns: ['amount'], ignored: ['reason'], anchored: [] },
    ]);
    expect(r.erd.unreadableModelFiles).toEqual([]);
    expect(r.nextSteps).toEqual(before.nextSteps);

    let out = '';
    const code = await main(['doctor', '--project', root, '--no-dbt'], {
      stdout: { write: (s: string) => { out += s; } },
      stderr: { write: () => undefined },
      cwd: root,
      env: cleanEnv,
    });
    expect(code).toBe(0);
    const lines = out.split('\n');
    expect(lines).toContain(
      "! .erd-studio/logical-models/gold/fct_refund.yml: amount uses dbt's data_type — read as dataType; "
      + 'the next edit of this table on the canvas writes it back as dataType',
    );
    expect(lines).toContain(
      '! .erd-studio/logical-models/gold/fct_refund.yml: reason has both dataType and data_type — data_type is ignored; delete it',
    );
    expect(out.split('Next steps:')[1]).not.toContain('data_type');
  });

  it('counts the data_type columns and shortens a long list (#144)', async () => {
    const root = copyFixture('dbt-project');
    const renamed = ['payment_id', 'customer_key', 'order_key', 'amount', 'fee', 'currency', 'paid_at', 'settled_at'];
    fs.writeFileSync(
      path.join(root, '.erd-studio/logical-models/fct_payment.yml'),
      [
        'name: fct_payment',
        'columns:',
        ...renamed.flatMap((c) => [`  - name: ${c}`, '    data_type: TEXT']),
        ...['reason', 'note'].flatMap((c) => [`  - name: ${c}`, '    dataType: VARCHAR', '    data_type: TEXT']),
        '',
      ].join('\n'),
    );
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.erd.dataTypeAliasFiles).toEqual([
      { name: 'fct_payment', file: '.erd-studio/logical-models/fct_payment.yml', columns: renamed, ignored: ['reason', 'note'], anchored: [] },
    ]);

    let out = '';
    await main(['doctor', '--project', root, '--no-dbt'], {
      stdout: { write: (s: string) => { out += s; } },
      stderr: { write: () => undefined },
      cwd: root,
      env: cleanEnv,
    });
    const lines = out.split('\n');
    expect(lines).toContain(
      "! .erd-studio/logical-models/fct_payment.yml: 8 columns use dbt's data_type "
      + '(payment_id, customer_key, order_key, amount, fee and 3 more) — read as dataType; '
      + 'the next edit of this table on the canvas writes them back as dataType',
    );
    expect(lines).toContain(
      '! .erd-studio/logical-models/fct_payment.yml: 2 columns have both dataType and data_type (reason, note) '
      + '— each data_type is ignored; delete them',
    );
  });

  it('lists a data_type kept beside an anchored empty dataType apart, with its own wording (#144)', async () => {
    const root = copyFixture('dbt-project');
    fs.writeFileSync(
      path.join(root, '.erd-studio/logical-models/fct_anchor.yml'),
      'name: fct_anchor\ncolumns:\n  - name: a\n    dataType: &x\n    data_type: INT\n  - name: b\n    dataType: *x\n',
    );
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.erd.dataTypeAliasFiles).toEqual([
      { name: 'fct_anchor', file: '.erd-studio/logical-models/fct_anchor.yml', columns: [], ignored: [], anchored: ['a'] },
    ]);
    let out = '';
    await main(['doctor', '--project', root, '--no-dbt'], {
      stdout: { write: (s: string) => { out += s; } },
      stderr: { write: () => undefined },
      cwd: root,
      env: cleanEnv,
    });
    expect(out.split('\n')).toContain(
      "! .erd-studio/logical-models/fct_anchor.yml: a uses dbt's data_type — read as dataType, but kept as written: "
      + 'a YAML anchor sits on the empty dataType or the data_type key, and renaming would break what refers to it',
    );
  });

  it('prints JSON and exits 0, also for a folder with no project', async () => {
    let out = '';
    const io = { stdout: { write: (s: string) => { out += s; } }, stderr: { write: () => undefined }, cwd: tmp, env: cleanEnv };
    expect(await main(['doctor', '--json', '--no-dbt'], io)).toBe(0);
    expect(JSON.parse(out).project.found).toBe(false);
  });

  /** A diagram whose positions git left conflicted, its first `<<<<<<<` on line 5. */
  function writeConflictedSubjectArea(root: string): void {
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.erd-studio', 'silver'), { recursive: true });
    fs.writeFileSync(path.join(root, '.erd-studio', 'silver', 'orders.json'), [
      '{',
      '  "schemaVersion": 5,',
      '  "logical": { "models": [], "relationships": [] },',
      '  "viewConfig": {',
      '<<<<<<< HEAD',
      '    "positions": {}',
      '=======',
      '    "positions": { "a": { "x": 1, "y": 2 } }',
      '>>>>>>> feature',
      '  }',
      '}',
    ].join('\n'));
  }

  it('lists a diagram holding git merge conflicts with its line, and puts resolving it before every dbt step (#145)', async () => {
    // No dbt on PATH, no manifest and no catalog: install-dbt, run-parse and
    // run-catalog are all due, and the conflict must come before each of them.
    const root = copyFixture('dbt-project-modern-tests');
    writeConflictedSubjectArea(root);

    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', env: cleanEnv, homeDir: home });
    expect(r.erd.conflictedDomainFiles).toEqual([{ file: '.erd-studio/silver/orders.json', line: 5 }]);
    expect(r.erd.domainFormatIssues).toEqual([]);
    const ids = r.nextSteps.map((s) => s.id);
    expect(ids.slice(0, 4)).toEqual(['resolve-merge-conflicts', 'install-dbt', 'run-parse', 'run-catalog']);
    expect(ids).not.toContain('ready');

    const step = r.nextSteps.find((s) => s.id === 'resolve-merge-conflicts')!;
    expect(step.title).toBe('Resolve the git merge conflict in a diagram');
    expect(step.why).toContain('.erd-studio/silver/orders.json:5');
    expect(step.why).toContain('This file still holds git conflict markers');
    // The choice of side is the user's: the assistant shows it and asks.
    expect(step.why).toContain('ask the user which side to keep');
    expect(step.why).toContain("Don't pick a side or run git commands yourself");
    expect(step.why).not.toContain('git add');

    let out = '';
    const code = await main(['doctor', '--project', root, '--no-dbt'], {
      stdout: { write: (s: string) => { out += s; } },
      stderr: { write: () => undefined },
      cwd: root,
      env: cleanEnv,
    });
    expect(code).toBe(0);
    expect(out).toContain('.erd-studio/silver/orders.json line 5: unresolved git merge conflict — resolve it (keep one side), save, then re-run doctor');
  });

  it.skipIf(process.platform === 'win32')('keeps the venv safety question ahead of a conflicted diagram (#145)', async () => {
    const root = copyFixture('dbt-project-modern-tests');
    writeFakeDbt(path.join(root, '.venv', 'bin', 'dbt'), CORE_OUTPUT);
    fs.writeFileSync(path.join(root, '.venv', 'bin', 'activate'), '');
    writeConflictedSubjectArea(root);
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', env: cleanEnv, homeDir: home });
    const ids = r.nextSteps.map((s) => s.id);
    expect(ids.slice(0, 2)).toEqual(['confirm-venv', 'resolve-merge-conflicts']);
    expect(ids.indexOf('run-parse')).toBeGreaterThan(1);
  });

  it('reports a model file holding git merge conflicts as unreadable, flagged, at its first marker (#145)', async () => {
    const root = copyFixture('dbt-project');
    fs.writeFileSync(path.join(root, '.erd-studio/logical-models/fct_task_event.yml'), [
      'name: fct_task_event',
      '<<<<<<< HEAD',
      'description: ours',
      '=======',
      'description: theirs',
      '>>>>>>> feature',
      'columns: []',
      '',
    ].join('\n'));
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.erd.unreadableModelFiles).toEqual([{
      name: 'fct_task_event',
      file: '.erd-studio/logical-models/fct_task_event.yml',
      kind: 'yamlOther',
      line: 2,
      mergeConflict: true,
      message: 'Unresolved git merge conflict (first at line 2)',
    }]);
    expect(r.erd.conflictedDomainFiles).toEqual([]);
    const why = r.nextSteps.find((s) => s.id === 'fix-model-yaml')!.why;
    expect(why).toContain('.erd-studio/logical-models/fct_task_event.yml:2 — unresolved git merge conflict — git left two versions there: '
      + "show the user the file and line and ask which side to keep (don't pick a side or run git commands yourself)");
    expect(why).toContain("A merge conflict is the user's to resolve; once they have saved the file, re-run doctor.");
    expect(why).not.toContain('git add');
  });

  it('puts a model file that does not parse right after a conflicted diagram, before every dbt step (#145)', async () => {
    // No dbt on PATH, no manifest and no catalog: the model renders as empty
    // whatever dbt's state, so fixing it must not wait behind the dbt steps.
    const root = copyFixture('dbt-project-modern-tests');
    writeConflictedSubjectArea(root);
    fs.mkdirSync(path.join(root, '.erd-studio', 'logical-models'), { recursive: true });
    fs.writeFileSync(path.join(root, '.erd-studio', 'logical-models', 'orders.yml'), [
      'name: orders',
      '<<<<<<< HEAD',
      'description: ours',
      '=======',
      'description: theirs',
      '>>>>>>> feature',
      'columns: []',
      '',
    ].join('\n'));
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', env: cleanEnv, homeDir: home });
    expect(r.nextSteps.map((s) => s.id).slice(0, 5)).toEqual([
      'resolve-merge-conflicts', 'fix-model-yaml', 'install-dbt', 'run-parse', 'run-catalog',
    ]);
  });
});

describe('doctor on native DBML storage (§7.1, S4)', () => {
  it('lists every DBML diagram, reports storage dbml and reads no .dbml as JSON', async () => {
    const root = copyFixture('dbml-native');
    const parse = vi.spyOn(JSON, 'parse');
    let out = '';
    const code = await main(['doctor', '--project', root, '--no-dbt', '--json'], {
      stdout: { write: (s: string) => { out += s; } },
      stderr: { write: () => undefined },
      cwd: tmp,
      env: cleanEnv,
    });
    const dbmlTexts = [SALES, STAGING].map((f) => fs.readFileSync(path.join(root, '.erd-studio', f), 'utf-8'));
    expect(parse.mock.calls.some(([text]) => dbmlTexts.includes(String(text)))).toBe(false);
    parse.mockRestore();
    expect(code).toBe(0);
    const r = JSON.parse(out) as DoctorResult;
    expect(r.erd.storage).toBe('dbml');
    expect(r.erd.domains).toBe(2);
    expect(r.erd.diagrams.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: `.erd-studio/${SALES}`, format: 'dbml' },
      { file: `.erd-studio/${STAGING}`, format: 'dbml' },
    ]);
    expect(r.erd.logicalModels).toBe(6);
    expect(r.erd.domainFormatIssues).toEqual([]);
    expect(r.erd.unreadableModelFiles).toEqual([]);
  });

  it('reports a DBML diagram holding git conflict markers as conflicted', async () => {
    const root = copyFixture('dbml-native');
    const file = path.join(root, '.erd-studio', STAGING);
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf-8')}<<<<<<< HEAD\nNote a {\n  'x'\n}\n=======\n>>>>>>> other\n`);
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.erd.conflictedDomainFiles).toEqual([expect.objectContaining({ file: `.erd-studio/${STAGING}` })]);
    expect(r.nextSteps.map((s) => s.id)).toContain('resolve-merge-conflicts');
  });

  it('a project with no .erd-studio yet is storage dbml with no diagrams', async () => {
    const root = path.join(tmp, 'fresh');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: fresh\nversion: "1.0.0"\n');
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.erd.semanticDirExists).toBe(false);
    expect(r.erd.storage).toBe('dbml');
    expect(r.erd.diagrams).toEqual([]);
  });
});

describe('doctor on native DBML storage (§7.1, S8): dbmlProblems, next steps and the helper files', () => {
  /** A copy of the DBML fixture with `edits` applied (paths relative to its .erd-studio). */
  function nativeWith(edits: Record<string, (text: string) => string | null>): string {
    const root = copyFixture('dbml-native');
    for (const [rel, edit] of Object.entries(edits)) {
      const file = path.join(root, '.erd-studio', rel);
      const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
      const after = edit(before);
      if (after === null) fs.rmSync(file);
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, after);
      }
    }
    return root;
  }
  const doctor = (root: string): Promise<DoctorResult> =>
    runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
  const replace = (from: string, to: string) => (text: string): string => {
    expect(text, from).toContain(from);
    return text.replace(from, to);
  };
  const ids = (r: DoctorResult): string[] => r.nextSteps.map((s) => s.id);
  const problem = (r: DoctorResult, code: string | number) => r.erd.dbmlProblems.filter((p) => p.code === code);

  it('a clean DBML project has no problems and is ready', async () => {
    const r = await doctor(copyFixture('dbml-native'));
    expect(r.erd.dbmlProblems).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('an unquoted value is an error with the parser code and the quote hint, raising fix-dbml-file', async () => {
    const r = await doctor(nativeWith({ [DIM_DATE]: replace("role: 'conformed-dim'", 'role: conformed') }));
    const [p] = problem(r, 3075);
    expect(p).toMatchObject({ file: `.erd-studio/${DIM_DATE}`, line: 2, severity: 'error' });
    expect(p.message).toContain("Quote the value, as in grain: 'One row per order line'.");
    expect(ids(r)[0]).toBe('fix-dbml-file');
    expect(r.nextSteps[0].why).toContain(`.erd-studio/${DIM_DATE}:2 (3075)`);
    expect(r.nextSteps[0].why).toContain('(a value to quote is the usual one)');
  });

  it('an unquoted 11.0 number or boolean is a warning with the quoted form, and raises no next step', async () => {
    const r = await doctor(nativeWith({ [FCT_ORDER]: replace("[natural_key: 'true']", '[natural_key: true]') }));
    const [p] = problem(r, 'unquotedValue');
    expect(p).toMatchObject({ file: `.erd-studio/${FCT_ORDER}`, severity: 'warning' });
    expect(p.message).toContain("natural_key: 'true'");
    expect(ids(r)).toEqual(['ready']);
  });

  it('a Ref, use line or inline ref in a table file is an error naming the line to write instead', async () => {
    const r = await doctor(nativeWith({ [FCT_ORDER]: replace("customer_key INT [foreign_key: 'true']", "customer_key INT [foreign_key: 'true', ref: > gold.dim_customer.customer_key]") }));
    const [p] = problem(r, 'inlineRefInTableFile');
    expect(p.severity).toBe('error');
    expect(p.message).toMatch(/Ref: (gold\.)?fct_order\.customer_key >\? gold\.dim_customer\.customer_key/);
    expect(ids(r)).toContain('fix-dbml-file');
  });

  it('a duplicate Enum across table files is a warning only', async () => {
    const r = await doctor(nativeWith({ [DIM_REGION]: (t) => `Enum order_status {\n  a\n}\n\n${t}` }));
    expect(problem(r, 'duplicateEnum').map((p) => [p.file, p.severity])).toEqual([
      [`.erd-studio/${DIM_REGION}`, 'warning'],
      [`.erd-studio/${FCT_ORDER}`, 'warning'],
    ]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('the same Ref twice is an error (duplicateRef), and a missing use line is a warning giving the line', async () => {
    const r = await doctor(nativeWith({
      [GOLD_REL]: (t) => t
        .replace("use { table calendar.dim_date } from '../../silver/tables/calendar/dim_date.dbml'\n", '')
        .replace('Ref: gold.fct_order.customer_key >? gold.dim_customer.customer_key', 'Ref: gold.fct_order.customer_key >? gold.dim_customer.customer_key\nRef: gold.fct_order.customer_key >? gold.dim_customer.customer_key'),
    }));
    expect(problem(r, 'duplicateRef')).toEqual([expect.objectContaining({ file: `.erd-studio/${GOLD_REL}`, severity: 'error' })]);
    const [missing] = problem(r, 'missingUse');
    expect(missing.severity).toBe('warning');
    expect(missing.message).toContain("Add the line: use { table calendar.dim_date } from '../../silver/tables/calendar/dim_date.dbml'");
    expect(ids(r)).toContain('fix-dbml-file');
  });

  it("a Ref in another layer's relationships file is no problem: a file is no table's home (decision 5)", async () => {
    // dim_date (silver) owns a Ref placed in gold's file, which already imports it.
    const r = await doctor(nativeWith({ [GOLD_REL]: (t) => `${t}Ref "alt": calendar.dim_date.calendar_date >? calendar.dim_date.date_key\n` }));
    expect(r.erd.dbmlProblems).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it("a dangling or orphaned Ref is ERD Studio's warning, and the parser's binding error on its line raises fix-dbml-file", async () => {
    // A Ref to a gone column, and a Ref from a table with no file: every other DBML tool fails the file.
    const r = await doctor(nativeWith({
      [CALENDAR_REL]: (t) => `${t}Ref: calendar.dim_date.date_key >? calendar.dim_date.no_such_column\n`,
      [GOLD_REL]: (t) => `${t}Ref: ghost.x >? calendar.dim_date.date_key\n`,
    }));
    const [dangling] = problem(r, 'danglingRef');
    expect(dangling).toMatchObject({ severity: 'warning', file: `.erd-studio/${CALENDAR_REL}`, line: 5 });
    expect(dangling.message).toContain('dim_date.no_such_column');
    // The line is still drawn (the loader emits it); saying otherwise would mislead the user.
    expect(dangling.message).toContain('ERD Studio still draws the line between the two tables');
    expect(dangling.message).not.toContain('not drawn');
    // A binding error is no quoting problem: the step does not point at quoting.
    expect(r.nextSteps[0].why).toContain('Fix these lines before anything else, then re-run doctor.');
    expect(r.nextSteps[0].why).not.toContain('a value to quote');
    const [orphaned] = problem(r, 'orphanedRef');
    expect(orphaned).toMatchObject({ severity: 'warning', file: `.erd-studio/${GOLD_REL}`, line: 11 });
    expect(orphaned.message).toBe("This Ref's foreign-key end is ghost, which has no table file; it is not drawn. Add the table, or delete the Ref.");
    expect(problem(r, 4000).map((p) => [p.file, p.line, p.severity])).toEqual([
      [`.erd-studio/${GOLD_REL}`, 11, 'error'],
      [`.erd-studio/${CALENDAR_REL}`, 5, 'error'],
    ]);
    expect(ids(r)[0]).toBe('fix-dbml-file');
  });

  it('a Ref whose foreign-key end is a YAML table is orphaned, with the move to its file (a mixed project)', async () => {
    const r = await doctor(nativeWith({
      'tables/gold/fct_extra.yml': () => 'name: fct_extra\ncolumns:\n  - name: extra_key\n    dataType: INT\n    isPrimaryKey: true\n  - name: customer_key\n    dataType: INT\n',
      [GOLD_REL]: (t) => `${t}Ref: fct_extra.customer_key >? gold.dim_customer.customer_key\n`,
    }));
    expect(r.erd.storage).toBe('mixed');
    const [orphaned] = problem(r, 'orphanedRef');
    expect(orphaned).toMatchObject({ severity: 'warning', file: `.erd-studio/${GOLD_REL}`, line: 11 });
    expect(orphaned.message).toContain('fct_extra, a YAML table');
    expect(orphaned.message).toContain('Move it into tables/gold/fct_extra.yml');
    expect(problem(r, 'danglingRef')).toEqual([]);
  });

  describe('a table file that does not read says so once, and its Refs are not blamed', () => {
    const conflict = (t: string): string => `<<<<<<< HEAD\n${t}=======\n${t}>>>>>>> other\n`;
    const cases: Array<[string, Record<string, (t: string) => string | null>, string]> = [
      ['a merge conflict in a foreign-key table', { [FCT_ORDER]: conflict }, 'resolve-merge-conflicts'],
      ['a merge conflict in a referenced table', { [DIM_CUSTOMER]: conflict }, 'resolve-merge-conflicts'],
      ['a parse error in a table both ends name', { [DIM_DATE]: replace("role: 'conformed-dim'", 'role: conformed dim') }, 'fix-dbml-file'],
    ];
    for (const [label, edits, step] of cases) {
      it(label, async () => {
        const r = await doctor(nativeWith(edits));
        expect(problem(r, 'danglingRef')).toEqual([]);
        expect(problem(r, 'orphanedRef')).toEqual([]);
        expect(r.erd.dbmlProblems.every((p) => !p.file.includes('/relationships/'))).toBe(true);
        expect(ids(r)).toEqual([step]);
      });
    }
  });

  describe('a table file ERD Studio cannot read is an error, and fix-dbml-file names it', () => {
    const cases: Array<[string, (t: string) => string | null, string]> = [
      ['two Tables in one file', (t) => `${t}\nTable gold.other {\n  id int\n}\n`, 'structure:notOneTable'],
      ['a Table not named as its file', (t) => t.replace('Table gold.bridge_empty', 'Table gold.something_else'), 'structure:nameMismatch'],
      ['an empty file', () => '', 'read'],
    ];
    for (const [label, edit, code] of cases) {
      it(label, async () => {
        const r = await doctor(nativeWith({ [BRIDGE]: edit }));
        expect(problem(r, code)).toEqual([expect.objectContaining({ file: `.erd-studio/${BRIDGE}`, severity: 'error' })]);
        expect(ids(r)[0]).toBe('fix-dbml-file');
        expect(r.nextSteps[0].why).toContain(`.erd-studio/${BRIDGE}`);
        expect(r.nextSteps[0].why).toContain(`(${code})`);
      });
    }
  });

  it('a Metadata block naming an unknown column is a warning with its precise text, once, and raises no next step (D25)', async () => {
    const r = await doctor(nativeWith({ [FCT_ORDER]: (t) => `${t}\nMetadata Column gold.fct_order.nope {\n  note: 'x'\n}\n` }));
    expect(r.erd.dbmlProblems).toEqual([{
      file: `.erd-studio/${FCT_ORDER}`, line: 30, code: 'structure:metadataTarget', severity: 'warning',
      message: "A Metadata block on line 30 targets column 'nope', which this table does not have; rename or remove the block.",
    }]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a use line or a Ref in a table file is an error (useInTableFile, refInTableFile)', async () => {
    const used = await doctor(nativeWith({ [DIM_REGION]: (t) => `use { table calendar.dim_date } from '../../../silver/tables/calendar/dim_date.dbml'\n${t}` }));
    expect(problem(used, 'useInTableFile')).toEqual([expect.objectContaining({ severity: 'error', line: 1 })]);
    expect(ids(used)).toContain('fix-dbml-file');
    const ref = await doctor(nativeWith({ [DIM_REGION]: (t) => `${t}\nRef: gold.dim_region.region_code > gold.dim_region.region_code\n` }));
    const [p] = problem(ref, 'refInTableFile');
    expect(p).toMatchObject({ severity: 'error', file: `.erd-studio/${DIM_REGION}` });
    expect(p.message).toContain('a relationships file (<layer>/relationships/)');
    expect(ids(ref)).toContain('fix-dbml-file');
  });

  it('a YAML table listed in a DBML diagram is a warning (yamlTableInDbmlDiagram, a mixed project)', async () => {
    const r = await doctor(nativeWith({
      'tables/gold/fct_extra.yml': () => 'name: fct_extra\ncolumns:\n  - name: extra_key\n    dataType: INT\n',
      [STAGING]: (t) => `${t}use { table fct_extra } from '../../tables/gold/fct_extra.dbml'\n`,
    }));
    const [p] = problem(r, 'yamlTableInDbmlDiagram');
    expect(p).toMatchObject({ severity: 'warning', file: `.erd-studio/${STAGING}`, line: 10 });
    expect(p.message).toContain('fct_extra is a YAML table (tables/gold/fct_extra.yml)');
  });

  it("erd_layout's bad lines and a repeated key are warnings with their own codes, raising no next step; a .dbdiagram is never read", async () => {
    const r = await doctor(nativeWith({
      [SALES]: (t) => t.replace('    fct_order 400 200\n', '    fct_order 400 200\n    not a line\n').replace(/\n\}\n\nuse/, "\n  ERD_LAYOUT: '''\n    fct_order 1 1\n  '''\n}\n\nuse"),
      // A .dbdiagram beside a diagram is not read (only the 1.9 pre-release wrote one; one in a layer folder would be its tree).
      'gold/diagrams/sales.dbdiagram': () => 'not json',
    }));
    expect(problem(r, 'layoutBadLine')).toEqual([expect.objectContaining({ severity: 'warning', file: `.erd-studio/${SALES}`, line: 13 })]);
    expect(problem(r, 'layoutDuplicateKey')).toEqual([expect.objectContaining({ severity: 'warning', file: `.erd-studio/${SALES}`, line: 17 })]);
    expect(problem(r, 'diagramWarning')).toEqual([]);
    expect(r.erd.dbmlProblems.filter((p) => p.file.endsWith('.dbdiagram')).map((p) => p.code)).toEqual(['unexpectedFileInDbmlFolder']);
    expect(ids(r)).toEqual(['ready']);
  });

  it('an erd_layout that is not a string is a layoutBadValue error: write positions as a \'\'\'…\'\'\' string', async () => {
    const r = await doctor(nativeWith({ [SALES]: (t) => t.replace(/ {2}erd_layout: '''[^]*?'''\n/, '  erd_layout: 42\n') }));
    expect(problem(r, 'layoutBadValue')).toEqual([expect.objectContaining({ severity: 'error', file: `.erd-studio/${SALES}`, line: 6 })]);
    expect(problem(r, 'layoutBadValue')[0].message).toContain("other DBML tools reject the file; write positions as a '''…''' string");
    expect(ids(r)).toContain('fix-dbml-file');
  });

  it('a git conflict only inside erd_layout is layoutMergeConflict (not mergeConflict): the diagram\'s other checks still run', async () => {
    const r = await doctor(nativeWith({
      [SALES]: (t) => t
        .replace('    fct_order 400 200\n', '<<<<<<< HEAD\n    fct_order 400 200\n=======\n    fct_order 500 200\n>>>>>>> theirs\n')
        .replace("'../../silver/tables/calendar/dim_date.dbml'", "'../../silver/tables/silver/dim_date.dbml'"),
    }));
    expect(problem(r, 'mergeConflict')).toEqual([]);
    expect(problem(r, 'layoutMergeConflict')).toEqual([expect.objectContaining({ severity: 'error', mergeConflict: true, file: `.erd-studio/${SALES}`, line: 12 })]);
    // Its other checks still run.
    expect(problem(r, 'usePathMismatch').map((p) => p.file)).toEqual([`.erd-studio/${SALES}`]);
    expect(ids(r)[0]).toBe('resolve-merge-conflicts');
    expect(r.nextSteps[0].why).toContain(`.erd-studio/${SALES}:12. This diagram still holds git conflict markers in its erd_layout: only positions differ: keep either side; the diagram still opens, but ERD Studio won't save positions until it is resolved.`);
    expect(ids(r)).not.toContain('fix-dbml-file');
  });

  it('a diagram use path that misses its table and a missing relationships use line are warnings with the corrected line', async () => {
    const r = await doctor(nativeWith({
      [STAGING]: (t) => t
        .replace("use { table calendar.dim_date } from '../tables/calendar/dim_date.dbml'", "use { table calendar.dim_date } from '../tables/gold/dim_date.dbml'")
        .replace("use * from '../../gold/relationships/gold.dbml'\n", ''),
    }));
    const [mismatch] = problem(r, 'usePathMismatch');
    expect(mismatch).toMatchObject({ file: `.erd-studio/${STAGING}`, severity: 'warning' });
    expect(mismatch.message).toContain("use { table calendar.dim_date } from '../tables/calendar/dim_date.dbml'");
    const [rel] = problem(r, 'missingRelationshipsUse');
    expect(rel.message).toContain("use * from '../../gold/relationships/gold.dbml'");
  });

  it("a stale or wrong-case use path is reported once, as a warning: not also as the parser's import errors", async () => {
    const r = await doctor(nativeWith({
      [SALES]: (t) => t
        .replace("'../tables/gold/dim_customer.dbml'", "'../tables/gold/Dim_Customer.dbml'")
        .replace("'../../silver/tables/calendar/dim_date.dbml'", "'../../silver/tables/silver/dim_date.dbml'"),
    }));
    expect(problem(r, 'usePathMismatch').map((p) => [p.line, p.severity])).toEqual([[19, 'warning'], [20, 'warning']]);
    expect(r.erd.dbmlProblems.filter((p) => typeof p.code === 'number')).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a use line must import a table exactly as its file declares it: a specifier in another case is usePathMismatch in a diagram and missingUse in a relationships file', async () => {
    const r = await doctor(nativeWith({
      [SALES]: replace('use { table gold.dim_region }', 'use { table Gold.Dim_Region }'),
      [GOLD_REL]: replace('use { table gold.dim_region }', 'use { table GOLD.dim_region }'),
    }));
    const [mismatch] = problem(r, 'usePathMismatch');
    expect(mismatch).toMatchObject({ file: `.erd-studio/${SALES}`, line: 21, severity: 'warning' });
    expect(mismatch.message).toContain("use { table gold.dim_region } from '../tables/gold/dim_region.dbml'");
    const [missing] = problem(r, 'missingUse');
    expect(missing).toMatchObject({ file: `.erd-studio/${GOLD_REL}`, severity: 'warning' });
    expect(missing.message).toContain("Add the line: use { table gold.dim_region } from '../tables/gold/dim_region.dbml'");
  });

  it("a Ref naming a table the file does not import is one missingUse warning, not also the parser's binding errors", async () => {
    const r = await doctor(nativeWith({ [GOLD_REL]: replace("use { table gold.dim_region }   from '../tables/gold/dim_region.dbml'\n", '') }));
    expect(problem(r, 'missingUse')).toEqual([expect.objectContaining({ severity: 'warning', line: 9 })]);
    expect(problem(r, 'missingUse')[0].message).toContain("Add the line: use { table gold.dim_region } from '../tables/gold/dim_region.dbml'");
    expect(r.erd.dbmlProblems.filter((p) => typeof p.code === 'number')).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it("a Ref naming a table of a schema the file imports nothing of is missingUse, not also the parser's 'Schema does not exist'", async () => {
    const r = await doctor(nativeWith({
      [GOLD_REL]: (t) => replace("use { table calendar.dim_date } from '../../silver/tables/calendar/dim_date.dbml'\n", '')(
        replace("use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\n", '')(t)),
    }));
    expect(problem(r, 'missingUse').map((p) => p.message.replace(/^.*Add the line: (use \{ table \S+ \}).*$/, '$1')).sort())
      .toEqual(['use { table calendar.dim_date }', 'use { table gold.dim_customer }']);
    expect(r.erd.dbmlProblems.filter((p) => typeof p.code === 'number')).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a use specifier that only quotes a name the file declares unquoted is neither missingUse nor usePathMismatch', async () => {
    const r = await doctor(nativeWith({
      [GOLD_REL]: replace('use { table gold.fct_order }', 'use { table "gold"."fct_order" }'),
      [SALES]: replace('use { table gold.fct_order }', 'use { table gold."fct_order" }'),
    }));
    expect(problem(r, 'missingUse')).toEqual([]);
    expect(problem(r, 'usePathMismatch')).toEqual([]);
    expect(r.erd.dbmlProblems.filter((p) => typeof p.code === 'number')).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a Metadata block in a diagram or relationships file is one foreignMetadata warning naming its line and target table (D25), raising no next step', async () => {
    const root = nativeWith({
      [SALES]: (t) => `${t}\nMetadata Table gold.fct_order {\n  grain: 'One row per order'\n}\n`,
      [GOLD_REL]: (t) => `${t}\nMetadata Column gold.fct_order.customer_key {\n  note: 'The buyer'\n}\n`,
    });
    const r = await doctor(root);
    const lineOf = (rel: string, needle: string): number =>
      fs.readFileSync(path.join(root, '.erd-studio', rel), 'utf-8').split('\n').findIndex((l) => l.startsWith(needle)) + 1;
    const found = problem(r, 'foreignMetadata');
    expect(found.map((p) => [p.file, p.line, p.severity])).toEqual([
      [`.erd-studio/${SALES}`, lineOf(SALES, 'Metadata Table'), 'warning'],
      [`.erd-studio/${GOLD_REL}`, lineOf(GOLD_REL, 'Metadata Column'), 'warning'],
    ]);
    expect(found.map((p) => p.message)).toEqual([
      expect.stringMatching(/^This Metadata block sets properties of fct_order from outside its table file \(gold\/tables\/gold\/fct_order\.dbml\)\./),
      expect.stringMatching(/^This Metadata block sets properties of fct_order\.customer_key from outside its table file \(gold\/tables\/gold\/fct_order\.dbml\)\..*Move them into gold\/tables\/gold\/fct_order\.dbml as inline settings, and remove the block\.$/),
    ]);
    // The diagram reader's own note on the same block is not repeated.
    expect(problem(r, 'declaredInDiagram')).toEqual([]);
    expect(r.erd.dbmlProblems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a Metadata block on a Table the same file declares is not foreignMetadata (a single-file DBML in a diagrams folder)', async () => {
    const r = await doctor(nativeWith({
      'gold/diagrams/pulled.dbml': () => "Table a {\n  id int [pk]\n}\n\nMetadata Table a {\n  grain: 'x'\n}\n",
    }));
    expect(problem(r, 'foreignMetadata')).toEqual([]);
    expect(problem(r, 'declaresOwnTables')).toEqual([expect.objectContaining({ file: '.erd-studio/gold/diagrams/pulled.dbml' })]);
    expect(r.erd.dbmlProblems.filter((p) => p.file === '.erd-studio/gold/diagrams/pulled.dbml' && /Metadata/.test(p.message))).toEqual([]);
  });

  it('a Metadata block on a table with no table file says so, not "move them into its table file"', async () => {
    const r = await doctor(nativeWith({ [SALES]: (t) => `${t}\nMetadata Table nowhere {\n  grain: 'x'\n}\n` }));
    const [p] = problem(r, 'foreignMetadata');
    expect(p.message).toBe('This Metadata block sets properties of nowhere, which has no table file; it is not read. Add the table, or remove the block.');
  });

  it('a Metadata block on a YAML table (a mixed project) words the fix for YAML', async () => {
    const r = await doctor(nativeWith({
      'tables/gold/fct_extra.yml': () => 'name: fct_extra\ncolumns:\n  - name: extra_key\n    dataType: INT\n',
      [GOLD_REL]: (t) => `${t}\nMetadata Table fct_extra {\n  grain: 'x'\n}\n`,
    }));
    const [p] = problem(r, 'foreignMetadata');
    expect(p.message).toContain('fct_extra is a YAML table: set them in tables/gold/fct_extra.yml');
    expect(p.message).not.toMatch(/Move them into tables\/gold\/fct_extra\.yml as inline settings/);
  });

  it("a relationships file's syntax error is reported once (the compile's, not the reader's copy too)", async () => {
    const r = await doctor(nativeWith({ [CALENDAR_REL]: (t) => `${t}Ref: calendar.dim_date.date_key >\n` }));
    expect(problem(r, 1002)).toEqual([expect.objectContaining({ file: `.erd-studio/${CALENDAR_REL}`, line: 6, severity: 'error', message: 'Unexpected EOF' })]);
    expect(ids(r)[0]).toBe('fix-dbml-file');
  });

  it('a table file whose name differs from its stem in case is a warning (nameCaseDrift)', async () => {
    const r = await doctor(nativeWith({ [DIM_DATE]: replace('Table calendar.dim_date', 'Table calendar.Dim_Date') }));
    expect(problem(r, 'nameCaseDrift')).toEqual([expect.objectContaining({ severity: 'warning', file: `.erd-studio/${DIM_DATE}` })]);
  });

  it('routes every conflicted DBML file to resolve-merge-conflicts, never fix-dbml-file', async () => {
    const conflict = (t: string): string => `<<<<<<< HEAD\n${t}=======\n${t}>>>>>>> other\n`;
    const r = await doctor(nativeWith({ [GOLD_REL]: conflict, [SALES]: conflict, [DIM_DATE]: conflict }));
    const conflicted = r.erd.dbmlProblems.filter((p) => p.mergeConflict);
    expect(conflicted.map((p) => p.file).sort()).toEqual([`.erd-studio/${SALES}`, `.erd-studio/${GOLD_REL}`, `.erd-studio/${DIM_DATE}`].sort());
    expect(conflicted.every((p) => p.severity === 'error' && p.line === 1)).toBe(true);
    expect(ids(r)[0]).toBe('resolve-merge-conflicts');
    const step = r.nextSteps[0];
    expect(step.why).toContain(`.erd-studio/${SALES}:1`);
    expect(step.why).toContain(`.erd-studio/${DIM_DATE}:1`);
    // No parser error is reported for a conflicted file, so no fix-dbml-file for it.
    expect(r.erd.dbmlProblems.filter((p) => !p.mergeConflict && conflicted.some((c) => c.file === p.file))).toEqual([]);
    expect(ids(r)).not.toContain('fix-model-yaml');
  });

  it('a table and a diagram beside a DBML twin with other contents raise resolve-format-conflicts, never finish-dbml-conversion', async () => {
    // What a pre-2.0 helper or a 1.x teammate writes into a DBML project: Convert refuses the pair, so only the user can settle it.
    const r = await doctor(nativeWith({
      'tables/gold/dim_region.yml': () => 'name: dim_region\ncolumns:\n  - name: region_code\n    dataType: "VARCHAR"\n',
      'gold/sales.json': () => JSON.stringify({ schemaVersion: 5, domain: 'sales', layer: 'gold', logical: { models: [], relationships: [] }, viewConfig: {} }),
    }));
    expect(r.erd.dbmlConversion?.resumed).toEqual([]);
    expect(r.erd.dbmlConversion?.refusals).toEqual([]);
    expect(r.erd.dbmlConversion?.leftAsIs?.map((l) => l.problem).join(' ')).toContain(`${DIM_REGION} already exists, with other contents`);
    expect(problem(r, 'formatConflict').map((p) => p.severity)).toEqual(['error', 'error']);
    expect(ids(r)).toEqual(['resolve-format-conflicts']);
    const step = r.nextSteps[0];
    expect(step.title).toBe('Keep one file for 2 tables or diagrams found as both YAML/JSON and DBML');
    expect(step.why).toContain('dim_region exists as both YAML and DBML');
    expect(step.why).toContain('The diagram sales exists as both JSON and DBML');
  });

  it('a diagram member with no table file (erd_unlinked_tables) and pending relationships are warnings naming diagram, table and fix (D26/D27)', async () => {
    const r = await doctor(nativeWith({
      [SALES]: replace("  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n", "  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n  erd_unlinked_tables: 'gld_fct_risk_child, dim_region'\n"),
      [GOLD_REL]: (text) => `${text}\n// erd-studio pending: Ref: gold.fct_order.risk_key >? gld_fct_risk_child.risk_key\n`,
    }));
    expect(problem(r, 'unlinkedTable')).toEqual([
      expect.objectContaining({ file: `.erd-studio/${SALES}`, severity: 'warning', message: expect.stringMatching(/^gld_fct_risk_child is on this diagram but has no table file, so it is drawn as missing .* Add it \(Add from dbt\), or remove it from the diagram\.$/) }),
    ]);
    expect(problem(r, 'pendingRelationship')).toEqual([
      expect.objectContaining({
        file: `.erd-studio/${GOLD_REL}`, line: 12, severity: 'warning',
        message: expect.stringMatching(/^The pending relationship fct_order\.risk_key → gld_fct_risk_child\.risk_key is drawn by ERD Studio, but other DBML tools see only a comment: gld_fct_risk_child has no table file; fct_order has no column risk_key\./),
      }),
    ]);
    // Warnings only: the project still compiles for every DBML tool, and nothing blocks.
    expect(r.erd.dbmlProblems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a member whose YAML file holds another name is named as that YAML file, not as missing; a pending line to a YAML table points at Convert, not Add from dbt', async () => {
    const r = await doctor(nativeWith({
      [SALES]: replace("  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n", "  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n  erd_unlinked_tables: 'dim_store_format'\n"),
      // Convert leaves this file as YAML (its name: is not its filename); the loader still draws it for the member.
      'tables/gold/dim_store_format.yml': () => 'name: dim_store_type\ncolumns:\n  - name: store_type_key\n    dataType: INT\n',
      [GOLD_REL]: (text) => `${text}\n// erd-studio pending: Ref: gold.fct_order.order_line_id >? dim_store_format.store_type_key\n`,
    }));
    expect(problem(r, 'unlinkedTable').map((p) => p.message)).toEqual([
      'dim_store_format is on this diagram but is still a YAML table (tables/gold/dim_store_format.yml, which holds the table dim_store_type), so the diagram names it in erd_unlinked_tables instead of a use line. '
        + 'Fix that file if needed, then run ERD Studio: Convert Project to DBML.',
    ]);
    const [pending] = problem(r, 'pendingRelationship');
    expect(pending.message).toContain('dim_store_format is still a YAML table (tables/gold/dim_store_format.yml, which holds the table dim_store_type)');
    expect(pending.message).toContain('(Convert Project to DBML converts a YAML table once its file is fixed)');
    expect(pending.message).not.toContain('Add from dbt');
  });

  it('a member whose YAML file is empty is named as an empty file drawn as missing, not as a YAML table (as Convert\'s plan says)', async () => {
    const r = await doctor(nativeWith({
      [SALES]: replace("  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n", "  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n  erd_unlinked_tables: 'dim_sales_rep'\n"),
      'tables/gold/dim_sales_rep.yml': () => '',
      [GOLD_REL]: (text) => `${text}\n// erd-studio pending: Ref: gold.fct_order.order_line_id >? dim_sales_rep.sales_rep_key\n`,
    }));
    expect(r.erd.dbmlConversion?.leftAsIs?.find((l) => l.path === 'tables/gold/dim_sales_rep.yml')?.problem).toMatch(/^It is empty, so ERD Studio does not read it as a table/);
    expect(problem(r, 'unlinkedTable').map((p) => p.message)).toEqual([
      'dim_sales_rep is on this diagram, but its file tables/gold/dim_sales_rep.yml is empty, so ERD Studio does not read it as a table and draws dim_sales_rep as missing '
        + "(its name is in the Project's erd_unlinked_tables). Write the table in that file, then run ERD Studio: Convert Project to DBML; or delete the file and remove dim_sales_rep from the diagram.",
    ]);
    const [pending] = problem(r, 'pendingRelationship');
    expect(pending.message).toContain("dim_sales_rep's file tables/gold/dim_sales_rep.yml is empty, so it is not a table yet");
    expect(pending.message).toContain('(write the table in that file, then run Convert Project to DBML)');
    expect(pending.message).not.toContain('is still a YAML table');
  });

  it('a member whose table file is named .yaml is named as that file, to rename, not as a table to add from dbt (as Convert\'s plan says)', async () => {
    const r = await doctor(nativeWith({
      [SALES]: replace("  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n", "  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n  erd_unlinked_tables: 'dim_sales_rep'\n"),
      'tables/gold/dim_sales_rep.yaml': () => 'name: dim_sales_rep\ncolumns:\n  - name: sales_rep_key\n    dataType: INT\n',
      [GOLD_REL]: (text) => `${text}\n// erd-studio pending: Ref: gold.fct_order.order_line_id >? dim_sales_rep.sales_rep_key\n`,
    }));
    expect(r.erd.dbmlConversion?.leftAsIs?.find((l) => l.path === 'tables/gold/dim_sales_rep.yaml')?.problem).toBe(
      'It is named dim_sales_rep.yaml, and ERD Studio reads a table file only when its name ends in .yml, so it does not read this one '
        + '(a diagram that lists dim_sales_rep draws it as missing). Rename it to dim_sales_rep.yml, then convert again.',
    );
    expect(r.erd.dbmlConversion?.keptMissing ?? []).toEqual([]);
    expect(problem(r, 'unlinkedTable').map((p) => p.message)).toEqual([
      'dim_sales_rep is on this diagram, but its table file tables/gold/dim_sales_rep.yaml is named dim_sales_rep.yaml, and ERD Studio reads a table file only when its name ends in .yml, '
        + "so it draws dim_sales_rep as missing (its name is in the Project's erd_unlinked_tables). Rename it to dim_sales_rep.yml, then run ERD Studio: Convert Project to DBML.",
    ]);
    const [pending] = problem(r, 'pendingRelationship');
    expect(pending.message).toContain("dim_sales_rep's file tables/gold/dim_sales_rep.yaml is not named .yml, so ERD Studio does not read it as a table yet");
    expect(pending.message).toContain('(rename that file to .yml, then run Convert Project to DBML)');
    expect(pending.message).not.toContain('Add from dbt');
  });

  it('a member whose .yaml file has another stem is told to take its table\'s name, which finishes the job', async () => {
    const r = await doctor(nativeWith({
      [SALES]: replace("  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n", "  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n  erd_unlinked_tables: 'dim_sales_rep'\n"),
      'tables/gold/foo.yaml': () => 'name: dim_sales_rep\ncolumns:\n  - name: sales_rep_key\n    dataType: INT\n',
    }));
    expect(r.erd.dbmlConversion?.leftAsIs?.find((l) => l.path === 'tables/gold/foo.yaml')?.problem).toMatch(/Rename it to dim_sales_rep\.yml, then convert again\.$/);
    expect(problem(r, 'unlinkedTable').map((p) => p.message)).toEqual([
      expect.stringMatching(/its table file tables\/gold\/foo\.yaml is named foo\.yaml, .* Rename it to dim_sales_rep\.yml, then run ERD Studio: Convert Project to DBML\.$/),
    ]);
  });

  it('a project Convert left mixed: finish-dbml-conversion names each file left as it is, with its problem and line', async () => {
    const r = await doctor(nativeWith({
      'tables/gold/dim_other.yml': () => 'name: dim_other\ndescription: one\ndescription: two\ncolumns:\n  - name: id\n    dataType: INT\n',
    }));
    expect(r.erd.storage).toBe('mixed');
    expect(r.erd.dbmlConversion?.refusals).toEqual([]);
    expect(r.erd.dbmlConversion?.leftAsIs).toEqual([{ path: 'tables/gold/dim_other.yml', line: 3, problem: 'The key description is written twice with different values (line 3). Keep the one you mean.' }]);
    const step = r.nextSteps.find((x) => x.id === 'finish-dbml-conversion')!;
    expect(step.why).toBe(
      'The conversion to DBML left a file as it is until fixed: .erd-studio/tables/gold/dim_other.yml:3 (The key description is written twice with different values (line 3). Keep the one you mean). '
        + 'Fix them, then run ERD Studio: Convert Project to DBML again to finish it; it checks every file first.',
    );
  });

  it('a YAML twin in another library folder raises resolve-format-conflicts', async () => {
    const r = await doctor(nativeWith({ 'tables/dim_region.yml': () => 'name: dim_region\ncolumns:\n  - name: region_code\n    dataType: VARCHAR\n' }));
    expect(problem(r, 'formatConflict')).toEqual([expect.objectContaining({ severity: 'error', file: '.erd-studio/tables/dim_region.yml' })]);
    expect(ids(r)).toContain('resolve-format-conflicts');
    expect(ids(r)).not.toContain('finish-dbml-conversion');
  });

  it('a diagram that declares its own Tables raises import-dbml-file, its own step per file', async () => {
    const r = await doctor(nativeWith({ 'gold/diagrams/pulled.dbml': () => 'Table a {\n  id int [pk]\n}\n' }));
    expect(problem(r, 'declaresOwnTables')).toEqual([expect.objectContaining({ file: '.erd-studio/gold/diagrams/pulled.dbml', severity: 'warning' })]);
    const step = r.nextSteps.find((s) => s.id === 'import-dbml-file')!;
    expect(step.why).toBe('Run ERD Studio: Import DBML… on .erd-studio/gold/diagrams/pulled.dbml; it is a single-file DBML, not an ERD Studio diagram.');
  });

  it('a Table declared inside an ERD Studio diagram is a warning', async () => {
    const r = await doctor(nativeWith({ [STAGING]: (t) => `${t}\nTableGroup g {\n  gold.fct_order\n}\n` }));
    expect(problem(r, 'declaredInDiagram').map((p) => p.severity)).toEqual(['warning']);
  });

  it('a layer folder of tables that layers.json does not list is dbmlLayerNotConfigured, and no layers.json is missingLayersConfig (warnings)', async () => {
    const unlisted = await doctor(nativeWith({ 'layers.json': (t) => t.replace(/,\n {4}\{ "id": "gold"[^\n]*\n/, '\n') }));
    expect(problem(unlisted, 'dbmlLayerNotConfigured')).toEqual([{
      file: '.erd-studio/gold', code: 'dbmlLayerNotConfigured', severity: 'warning',
      message: 'gold/ is not in layers.json, but its tables and relationships are part of the project. Add the layer, or move the folder out of .erd-studio if it is a copy.',
    }]);
    const missing = await doctor(nativeWith({ 'layers.json': () => null }));
    expect(problem(missing, 'missingLayersConfig')).toEqual([expect.objectContaining({ severity: 'warning' })]);
    expect(problem(missing, 'dbmlLayerNotConfigured')).toEqual([]);
  });

  it('a backup copy of a layer folder: dbmlLayerNotConfigured, and duplicateTableName errors naming both files', async () => {
    const root = copyFixture('dbml-native');
    fs.cpSync(path.join(root, '.erd-studio', 'gold', 'tables'), path.join(root, '.erd-studio', 'gold-old', 'tables'), { recursive: true });
    const r = await doctor(root);
    expect(problem(r, 'dbmlLayerNotConfigured').map((p) => p.file)).toEqual(['.erd-studio/gold-old']);
    const duplicates = problem(r, 'duplicateTableName');
    expect(duplicates.map((p) => [p.file, p.severity])).toEqual(
      ['bridge_empty', 'customer_profile', 'dim_customer', 'dim_region', 'fct_order'].map((n) => [`.erd-studio/gold/tables/gold/${n}.dbml`, 'error']),
    );
    expect(duplicates[4].message).toBe('fct_order is declared in gold-old/tables/gold/fct_order.dbml and gold/tables/gold/fct_order.dbml; give the tables unique names and keep the warehouse name in alias.');
    expect(ids(r)[0]).toBe('fix-dbml-file');
  });

  it('a .dbml outside the tree is dbmlOutsideKnownFolders, with a hint for its shape', async () => {
    const r = await doctor(nativeWith({
      'gold/loose.dbml': () => 'Table x {\n  id int\n}\n',
      'Bronze/diagrams/y.dbml': () => "Project y {\n  erd_schema_version: '7'\n}\n",
      // Another layer than Bronze/: the two would be one folder on a file system that ignores case.
      'copper/Diagrams/z.dbml': () => "Project z {\n  erd_schema_version: '7'\n}\n",
      'gold/relationships/old/r.dbml': () => '// nothing\n',
      'gold/tables/t.dbml': () => 'Table t {\n  id int\n}\n',
      'sales area/x.dbml': () => 'Table x {\n  id int\n}\n',
      'gold.old/o.dbml': () => 'Table o {\n  id int\n}\n',
      'logical-models/l.dbml': () => 'Table l {\n  id int\n}\n',
      'physical/diagrams/p.dbml': () => "Project p {\n  erd_schema_version: '7'\n}\n",
    }));
    const hints = Object.fromEntries(problem(r, 'dbmlOutsideKnownFolders').map((p) => [p.file.replace('.erd-studio/', ''), p.message]));
    expect(Object.keys(hints).sort()).toEqual([
      'Bronze/diagrams/y.dbml', 'copper/Diagrams/z.dbml', 'gold.old/o.dbml', 'gold/loose.dbml', 'gold/relationships/old/r.dbml', 'gold/tables/t.dbml',
      'logical-models/l.dbml', 'physical/diagrams/p.dbml', 'sales area/x.dbml',
    ]);
    expect(hints['gold/loose.dbml']).toBe('ERD Studio does not read this file: it is outside the folders of a DBML project. A diagram belongs at gold/diagrams/loose.dbml.');
    expect(hints['Bronze/diagrams/y.dbml']).toContain('Layer folders are lower-case ids; rename Bronze/ to bronze/ and set its label in layers.json.');
    expect(hints['copper/Diagrams/z.dbml']).toContain('Rename the folder to diagrams (lower-case).');
    expect(hints['gold/relationships/old/r.dbml']).toContain('Relationships files are flat in gold/relationships/.');
    expect(hints['gold/tables/t.dbml']).toContain('A table belongs in a schema folder: gold/tables/<schema>/t.dbml.');
    // A hint never starts with a folder name, so capitalising it never misspells one.
    expect(hints['sales area/x.dbml']).toContain('The folder sales area/ is not a valid layer name: a layer folder is a lower-case id');
    expect(hints['gold.old/o.dbml']).toContain('The folder gold.old/ is not a valid layer name');
    expect(hints['logical-models/l.dbml']).toContain('The folder logical-models/ holds YAML tables only; a DBML table belongs at <layer>/tables/<schema>/l.dbml.');
    expect(hints['physical/diagrams/p.dbml']).toContain('The folder physical/ cannot be a layer: ERD Studio reserves the name physical. A diagram belongs at <layer>/diagrams/p.dbml');
    expect(problem(r, 'dbmlOutsideKnownFolders').every((p) => p.severity === 'warning')).toBe(true);
    // A loose diagram-shaped file alone is no 1.9 tree.
    expect(problem(r, 'legacyDbmlTree')).toEqual([]);
  });

  it('a use * of a file outside .erd-studio is dbmlOutsideKnownFolders on the diagram', async () => {
    const r = await doctor(nativeWith({ [STAGING]: (t) => `${t}use * from '../../../shared/enums.dbml'\n` }));
    expect(problem(r, 'dbmlOutsideKnownFolders')).toEqual([expect.objectContaining({
      file: `.erd-studio/${STAGING}`, severity: 'warning',
      message: expect.stringContaining('This diagram imports ../shared/enums.dbml with use *, which is outside .erd-studio'),
    })]);
  });

  it('a use * of a file ERD Studio reads as something else (another diagram), or of a missing one, is dbmlOutsideKnownFolders on the diagram line', async () => {
    const r = await doctor(nativeWith({ [SALES]: (t) => `${t}use * from './notes.dbml'\nuse * from '../../silver/diagrams/staging.dbml'\n` }));
    const lines = (t: string): number => t.split('\n').length;
    const salesLines = lines(fs.readFileSync(path.join(FIXTURES, 'dbml-native', '.erd-studio', SALES), 'utf-8'));
    expect(problem(r, 'dbmlOutsideKnownFolders')).toEqual([
      expect.objectContaining({
        file: `.erd-studio/${SALES}`, line: salesLines, severity: 'warning',
        message: 'This diagram imports gold/diagrams/notes.dbml with use *, which does not exist: ERD Studio keeps the line but reads nothing from it, while other DBML tools import all of it.',
      }),
      expect.objectContaining({
        file: `.erd-studio/${SALES}`, line: salesLines + 1,
        message: expect.stringContaining('This diagram imports silver/diagrams/staging.dbml with use *, which is not a relationships file (<layer>/relationships/<name>.dbml)'),
      }),
    ]);
  });

  it('a use * of a stray .dbml in the tree is reported once, on the stray file', async () => {
    const r = await doctor(nativeWith({
      'gold/loose.dbml': () => 'Enum gold.status {\n  a\n}\n',
      [SALES]: (t) => `${t}use * from '../loose.dbml'\n`,
    }));
    expect(problem(r, 'dbmlOutsideKnownFolders').map((p) => p.file)).toEqual(['.erd-studio/gold/loose.dbml']);
  });

  it("the table reader's schema checks are warnings: schemaFolderMismatch, unqualifiedTable, schemaProperty", async () => {
    const r = await doctor(nativeWith({
      [DIM_REGION]: replace('Table gold.dim_region', 'Table sales.dim_region'),
      [BRIDGE]: replace('Table gold.bridge_empty', 'Table bridge_empty'),
      'gold/tables/gold/customer_profile.dbml': replace('Table gold.customer_profile {', "Table gold.customer_profile [schema: 'crm'] {"),
    }));
    expect(problem(r, 'schemaFolderMismatch').map((p) => [p.file, p.severity])).toEqual([[`.erd-studio/${DIM_REGION}`, 'warning']]);
    expect(problem(r, 'unqualifiedTable').map((p) => [p.file, p.severity])).toEqual([[`.erd-studio/${BRIDGE}`, 'warning']]);
    expect(problem(r, 'schemaProperty').map((p) => [p.file, p.severity])).toEqual([['.erd-studio/gold/tables/gold/customer_profile.dbml', 'warning']]);
  });

  it('a relationships file holding a Table or an Enum is relationshipsFileHoldsOther (a warning)', async () => {
    const r = await doctor(nativeWith({ [GOLD_REL]: (t) => `${t}\nEnum status {\n  a\n}\n` }));
    expect(problem(r, 'relationshipsFileHoldsOther')).toEqual([{
      file: `.erd-studio/${GOLD_REL}`, line: 12, code: 'relationshipsFileHoldsOther', severity: 'warning',
      message: `${GOLD_REL} line 12 holds a Enum; relationships files hold only Refs and use lines, and every diagram importing this file gets it too in other DBML tools. Move it into its own file.`,
    }]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a root readme.md in another case is the project README, never unexpectedFileInDbmlFolder', async () => {
    const root = nativeWith({ 'README.md': () => null, 'readme.md': () => '# Model\n' });
    const r = await doctor(root);
    expect(problem(r, 'unexpectedFileInDbmlFolder')).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a YAML project holding a stray .dbml gives no dbmlOutsideKnownFolders (no YAML project changes behaviour)', async () => {
    const root = copyFixture('logical-only');
    fs.writeFileSync(path.join(root, '.erd-studio', 'gold', 'notes.dbml'), 'Table n {\n  id int\n}\n');
    fs.mkdirSync(path.join(root, '.erd-studio', 'exports'));
    fs.writeFileSync(path.join(root, '.erd-studio', 'exports', 'all.dbml'), 'Table a {\n  id int\n}\n');
    const r = await doctor(root);
    expect(r.erd.storage).toBe('yaml');
    expect(r.erd.dbmlProblems).toEqual([]);
  });

  it('a file of no kind ERD Studio knows is unexpectedFileInDbmlFolder in a DBML project, never README.md or modelling-approach.md', async () => {
    const r = await doctor(nativeWith({
      'notes.txt': () => 'x\n',
      'gold/diagrams/sales.png': () => 'png',
      'modelling-approach.md': () => '# Kimball\n',
    }));
    expect(problem(r, 'unexpectedFileInDbmlFolder').map((p) => [p.file, p.severity])).toEqual([
      ['.erd-studio/gold/diagrams/sales.png', 'warning'],
      ['.erd-studio/notes.txt', 'warning'],
    ]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a relationships file a diagram imports for no relationship between its tables is extraRelationshipsUse; a missing one is missingRelationshipsUse, worded as the canvas words it', async () => {
    const r = await doctor(nativeWith({
      [STAGING]: (t) => `${t}use * from '../../gold/relationships/customers.dbml'\n`,
      [SALES]: replace("use * from '../relationships/customers.dbml'\n", ''),
    }));
    expect(problem(r, 'extraRelationshipsUse')).toEqual([expect.objectContaining({ file: `.erd-studio/${STAGING}`, line: 10, severity: 'warning' })]);
    expect(problem(r, 'extraRelationshipsUse')[0].message).toContain('This diagram imports gold/relationships/customers.dbml, which holds no relationship between its tables');
    expect(problem(r, 'missingRelationshipsUse')).toEqual([{
      file: `.erd-studio/${SALES}`, code: 'missingRelationshipsUse', severity: 'warning',
      message: `${unimportedRelationshipsMessage('gold/relationships/customers.dbml')} Add the line: use * from '../relationships/customers.dbml'`,
    }]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a YAML project with a layer named diagrams gives no warning', async () => {
    const root = copyFixture('logical-only');
    const layers = path.join(root, '.erd-studio', 'layers.json');
    fs.writeFileSync(layers, fs.readFileSync(layers, 'utf-8').replace('"layers": [', '"layers": [\n    { "id": "diagrams", "label": "Diagrams", "abbreviation": "DGM", "color": "#a0a0a0", "creatable": true, "order": 2 },'));
    const sales = JSON.parse(fs.readFileSync(path.join(root, '.erd-studio', 'gold', 'sales.json'), 'utf-8')) as Record<string, unknown>;
    fs.mkdirSync(path.join(root, '.erd-studio', 'diagrams'));
    fs.writeFileSync(path.join(root, '.erd-studio', 'diagrams', 'overview.json'), JSON.stringify({ ...sales, layer: 'diagrams', domain: 'overview' }, null, 2));
    const r = await doctor(root);
    expect(r.erd.storage).toBe('yaml');
    expect(r.erd.diagrams.map((d) => d.file)).toContain('.erd-studio/diagrams/overview.json');
    expect(r.erd.dbmlProblems).toEqual([]);
  });

  it('a 1.9 pre-release tree is one legacyDbmlTree error with reconvert-dbml-project, and nothing about each of its files', async () => {
    const r = await doctor(copyFixture('dbml-1.9-tree'));
    expect(r.erd.dbmlProblems).toEqual([{
      file: '.erd-studio', code: 'legacyDbmlTree', severity: 'error',
      message: expect.stringMatching(/^This project's DBML files were written by an ERD Studio 1\.9 pre-release, whose folder layout 2\.0 does not read \(gold\/sales\.dbdiagram, gold\/sales\.dbml, silver\/staging\.dbml and \d+ more\)\./),
    }]);
    expect(ids(r)).toEqual(['reconvert-dbml-project']);
    const step = r.nextSteps[0];
    expect(step.title).toBe('Convert the project to DBML again');
    expect(step.why).toContain('Then run ERD Studio: Convert Project to DBML again.');
    expect(step.why).toContain("don't edit, move or delete the 1.9 files yourself");
  });

  it('a project path with a space is a warning (pathWithSpace)', async () => {
    const root = path.join(tmp, 'My Projects', 'repo');
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.cpSync(path.join(FIXTURES, 'dbml-native'), root, { recursive: true });
    const r = await doctor(root);
    const [p] = problem(r, 'pathWithSpace');
    expect(p.severity).toBe('warning');
    expect(p.message).toContain('DBML 10.x drops imported tables when a folder in the path has a space; 9.1 and 11+ do not. ERD Studio is not affected.');
    expect(p.message).not.toContain(tmp);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a .dbml diagram in a YAML project is a warning', async () => {
    const root = copyFixture('logical-only');
    fs.mkdirSync(path.join(root, '.erd-studio', 'gold', 'diagrams'));
    fs.writeFileSync(path.join(root, '.erd-studio', 'gold', 'diagrams', 'extra.dbml'), "Project extra {\n  erd_schema_version: '7'\n}\n");
    const r = await doctor(root);
    expect(r.erd.storage).toBe('yaml');
    expect(problem(r, 'dbmlDiagramInYamlProject')).toEqual([expect.objectContaining({ file: '.erd-studio/gold/diagrams/extra.dbml', severity: 'warning' })]);
  });

  it('turn-round-relationships names the relationships file that holds a DBML Ref: it is turned round in place', async () => {
    // fct_order.order_line_id is its whole key; pointing it at dim_customer's non-key column draws it backwards.
    const r = await doctor(nativeWith({
      [GOLD_REL]: (t) => `${t}Ref: gold.fct_order.order_line_id >? gold.dim_customer.segment\n`,
    }));
    const step = r.nextSteps.find((s) => s.id === 'turn-round-relationships');
    expect(step?.why).toContain(`in place, in the relationships file that holds it (${GOLD_REL})`);
  });

  it('prints storage, DBML problems by severity and the newer-helper line in human output', async () => {
    const root = nativeWith({ [DIM_DATE]: replace("role: 'conformed-dim'", 'role: conformed') });
    let out = '';
    await main(['doctor', '--project', root, '--no-dbt'], { stdout: { write: (s: string) => { out += s; } }, stderr: { write: () => undefined }, cwd: tmp, env: cleanEnv });
    expect(out).toContain('storage DBML');
    expect(out).toContain(`.erd-studio/${DIM_DATE} line 2:`);
    expect(out).toContain('(3075)');
  });
  describe('update-harness covers every helper target, and a newer marker is never offered', () => {
    const OLD = '<!-- erd-studio-harness: 1 -->';
    const NEWER = `<!-- erd-studio-harness: ${Number(HARNESS_VERSION) + 1} -->`;
    for (const [label, rel, text] of [
      ['.agents', '.agents/skills/erd-studio/SKILL.md', `---\nname: erd-studio\n---\n${OLD}\n`],
      ['Copilot', '.github/instructions/erd-studio.instructions.md', `x\n${OLD}\n`],
      ['Gemini', '.gemini/styleguide.md', `x\n${OLD}\n`],
      ['AGENTS.md', 'AGENTS.md', `<!-- BEGIN erd-studio-harness -->\n## ERD Studio Domain Files\n${OLD}\n<!-- END erd-studio-harness -->\n`],
    ] as const) {
      it(`raises update-harness for an outdated ${label} target alone`, async () => {
        for (const fixture of ['dbml-native', 'logical-only']) {
          const root = copyFixture(fixture);
          fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
          fs.writeFileSync(path.join(root, rel), text);
          const r = await doctor(root);
          const step = r.nextSteps.find((s) => s.id === 'update-harness');
          expect(step, `${label} ${fixture}`).toBeDefined();
          expect(r.harness.outdated.length).toBe(1);
          expect(step!.why).toContain(r.harness.outdated[0]);
          // In a DBML project, an old helper would write YAML into it.
          expect(step!.why.includes('An AI helper set up with an older ERD Studio may write YAML into this DBML project.'), fixture).toBe(fixture === 'dbml-native');
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }

    it("reports a newer marker as 'newer', never as update-harness", async () => {
      const root = copyFixture('dbml-native');
      fs.mkdirSync(path.join(root, '.claude/skills/erd-studio'), { recursive: true });
      fs.writeFileSync(path.join(root, '.claude/skills/erd-studio/SKILL.md'), `x\n${NEWER}\n`);
      fs.writeFileSync(path.join(root, 'AGENTS.md'), `<!-- BEGIN erd-studio-harness -->\n## ERD Studio Domain Files\n${NEWER}\n<!-- END erd-studio-harness -->\n`);
      const r = await doctor(root);
      expect(r.harness.schemaSkill).toBe('newer');
      expect(r.harness.newer).toEqual(['.claude/skills (Claude Code)', 'AGENTS.md (Codex)']);
      expect(r.harness.outdated).toEqual([]);
      expect(ids(r)).not.toContain('update-harness');
      let out = '';
      await main(['doctor', '--project', root, '--no-dbt'], { stdout: { write: (s: string) => { out += s; } }, stderr: { write: () => undefined }, cwd: tmp, env: cleanEnv });
      expect(out).toContain('Update ERD Studio: these helper files are from a newer version: .claude/skills (Claude Code), AGENTS.md (Codex)');
    });
  });
});
