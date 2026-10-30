import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDoctor, type DoctorResult } from '../../src/cli/doctor';
import { main } from '../../src/cli/index';
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
    const dbmlTexts = ['gold/sales.dbml', 'silver/staging.dbml'].map((f) => fs.readFileSync(path.join(root, '.erd-studio', f), 'utf-8'));
    expect(parse.mock.calls.some(([text]) => dbmlTexts.includes(String(text)))).toBe(false);
    parse.mockRestore();
    expect(code).toBe(0);
    const r = JSON.parse(out) as DoctorResult;
    expect(r.erd.storage).toBe('dbml');
    expect(r.erd.domains).toBe(2);
    expect(r.erd.diagrams.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: '.erd-studio/gold/sales.dbml', format: 'dbml' },
      { file: '.erd-studio/silver/staging.dbml', format: 'dbml' },
    ]);
    expect(r.erd.logicalModels).toBe(6);
    expect(r.erd.domainFormatIssues).toEqual([]);
    expect(r.erd.unreadableModelFiles).toEqual([]);
  });

  it('reports a DBML diagram holding git conflict markers as conflicted', async () => {
    const root = copyFixture('dbml-native');
    const file = path.join(root, '.erd-studio', 'silver', 'staging.dbml');
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf-8')}<<<<<<< HEAD\nNote a {\n  'x'\n}\n=======\n>>>>>>> other\n`);
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.erd.conflictedDomainFiles).toEqual([expect.objectContaining({ file: '.erd-studio/silver/staging.dbml' })]);
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
    const r = await doctor(nativeWith({ 'tables/dim_date.dbml': replace("role: 'conformed-dim'", 'role: conformed') }));
    const [p] = problem(r, 3075);
    expect(p).toMatchObject({ file: '.erd-studio/tables/dim_date.dbml', line: 2, severity: 'error' });
    expect(p.message).toContain("Quote the value, as in grain: 'One row per order line'.");
    expect(ids(r)[0]).toBe('fix-dbml-file');
    expect(r.nextSteps[0].why).toContain('.erd-studio/tables/dim_date.dbml:2 (3075)');
    expect(r.nextSteps[0].why).toContain('(a value to quote is the usual one)');
  });

  it('an unquoted 11.0 number or boolean is a warning with the quoted form, and raises no next step', async () => {
    const r = await doctor(nativeWith({ 'tables/gold/fct_order.dbml': replace("[natural_key: 'true']", '[natural_key: true]') }));
    const [p] = problem(r, 'unquotedValue');
    expect(p).toMatchObject({ file: '.erd-studio/tables/gold/fct_order.dbml', severity: 'warning' });
    expect(p.message).toContain("natural_key: 'true'");
    expect(ids(r)).toEqual(['ready']);
  });

  it('a Ref, use line or inline ref in a table file is an error naming the line to write instead', async () => {
    const r = await doctor(nativeWith({ 'tables/gold/fct_order.dbml': replace("customer_key INT [foreign_key: 'true']", "customer_key INT [foreign_key: 'true', ref: > dim_customer.customer_key]") }));
    const [p] = problem(r, 'inlineRefInTableFile');
    expect(p.severity).toBe('error');
    expect(p.message).toContain('Ref: fct_order.customer_key >? dim_customer.customer_key');
    expect(ids(r)).toContain('fix-dbml-file');
  });

  it('a duplicate Enum across table files is a warning only', async () => {
    const r = await doctor(nativeWith({ 'tables/gold/dim_region.dbml': (t) => `Enum order_status {\n  a\n}\n\n${t}` }));
    expect(problem(r, 'duplicateEnum').map((p) => [p.file, p.severity])).toEqual([
      ['.erd-studio/tables/gold/dim_region.dbml', 'warning'],
      ['.erd-studio/tables/gold/fct_order.dbml', 'warning'],
    ]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('the same Ref twice is an error (duplicateRef), and a missing use line is a warning giving the line', async () => {
    const r = await doctor(nativeWith({
      'tables/gold/_relationships.dbml': (t) => t
        .replace("use { table dim_date } from '../dim_date.dbml'\n", '')
        .replace('Ref: fct_order.customer_key >? dim_customer.customer_key', 'Ref: fct_order.customer_key >? dim_customer.customer_key\nRef: fct_order.customer_key >? dim_customer.customer_key'),
    }));
    expect(problem(r, 'duplicateRef')).toEqual([expect.objectContaining({ file: '.erd-studio/tables/gold/_relationships.dbml', severity: 'error' })]);
    const [missing] = problem(r, 'missingUse');
    expect(missing.severity).toBe('warning');
    expect(missing.message).toContain("Add the line: use { table dim_date } from '../dim_date.dbml'");
    expect(ids(r)).toContain('fix-dbml-file');
  });

  it('a misplaced Ref is a warning naming its home, and raises no next step', async () => {
    // dim_date (top level) owns a Ref placed in the gold file.
    const r = await doctor(nativeWith({
      'tables/gold/_relationships.dbml': (t) => `${t}Ref "alt": dim_date.calendar_date >? dim_date.date_key\n`,
    }));
    expect(problem(r, 'misplacedRef')).toEqual([expect.objectContaining({ severity: 'warning', file: '.erd-studio/tables/gold/_relationships.dbml' })]);
    expect(problem(r, 'misplacedRef')[0].message).toContain('tables/_relationships.dbml');
    expect(ids(r)).toEqual(['ready']);
  });

  it("a dangling or orphaned Ref is ERD Studio's warning, and the parser's binding error on its line raises fix-dbml-file", async () => {
    // A Ref to a gone column, and a Ref from a table with no file: every other DBML tool fails the file.
    const r = await doctor(nativeWith({
      'tables/_relationships.dbml': (t) => `${t}Ref: dim_date.date_key >? dim_date.no_such_column\n`,
      'tables/gold/_relationships.dbml': (t) => `${t}Ref: ghost.x >? dim_date.date_key\n`,
    }));
    const [dangling] = problem(r, 'danglingRef');
    expect(dangling).toMatchObject({ severity: 'warning', file: '.erd-studio/tables/_relationships.dbml', line: 5 });
    expect(dangling.message).toContain('dim_date.no_such_column');
    // The line is still drawn (the loader emits it); saying otherwise would mislead the user.
    expect(dangling.message).toContain('ERD Studio still draws the line between the two tables');
    expect(dangling.message).not.toContain('not drawn');
    // A binding error is no quoting problem: the step does not point at quoting.
    expect(r.nextSteps[0].why).toContain('Fix these lines before anything else, then re-run doctor.');
    expect(r.nextSteps[0].why).not.toContain('a value to quote');
    const [orphaned] = problem(r, 'orphanedRef');
    expect(orphaned).toMatchObject({ severity: 'warning', file: '.erd-studio/tables/gold/_relationships.dbml', line: 15 });
    expect(orphaned.message).toBe("This Ref's foreign-key end is ghost, which has no table file; it is not drawn. Add the table, or delete the Ref.");
    expect(problem(r, 4000).map((p) => [p.file, p.line, p.severity])).toEqual([
      ['.erd-studio/tables/_relationships.dbml', 5, 'error'],
      ['.erd-studio/tables/gold/_relationships.dbml', 15, 'error'],
    ]);
    expect(ids(r)[0]).toBe('fix-dbml-file');
  });

  it('a Ref whose foreign-key end is a YAML table is orphaned, with the move to its file (a mixed project)', async () => {
    const r = await doctor(nativeWith({
      'tables/gold/fct_extra.yml': () => 'name: fct_extra\ncolumns:\n  - name: extra_key\n    dataType: INT\n    isPrimaryKey: true\n  - name: customer_key\n    dataType: INT\n',
      'tables/gold/_relationships.dbml': (t) => `${t}Ref: fct_extra.customer_key >? dim_customer.customer_key\n`,
    }));
    expect(r.erd.storage).toBe('mixed');
    const [orphaned] = problem(r, 'orphanedRef');
    expect(orphaned).toMatchObject({ severity: 'warning', file: '.erd-studio/tables/gold/_relationships.dbml', line: 15 });
    expect(orphaned.message).toContain('fct_extra, a YAML table');
    expect(orphaned.message).toContain('Move it into tables/gold/fct_extra.yml');
    expect(problem(r, 'danglingRef')).toEqual([]);
  });

  describe('a table file that does not read says so once, and its Refs are not blamed', () => {
    const conflict = (t: string): string => `<<<<<<< HEAD\n${t}=======\n${t}>>>>>>> other\n`;
    const cases: Array<[string, Record<string, (t: string) => string | null>, string]> = [
      ['a merge conflict in a foreign-key table', { 'tables/gold/fct_order.dbml': conflict }, 'resolve-merge-conflicts'],
      ['a merge conflict in a referenced table', { 'tables/gold/dim_customer.dbml': conflict }, 'resolve-merge-conflicts'],
      ['a parse error in a table both ends name', { 'tables/dim_date.dbml': replace("role: 'conformed-dim'", 'role: conformed dim') }, 'fix-dbml-file'],
    ];
    for (const [label, edits, step] of cases) {
      it(label, async () => {
        const r = await doctor(nativeWith(edits));
        expect(problem(r, 'danglingRef')).toEqual([]);
        expect(problem(r, 'orphanedRef')).toEqual([]);
        expect(r.erd.dbmlProblems.every((p) => !p.file.endsWith('_relationships.dbml'))).toBe(true);
        expect(ids(r)).toEqual([step]);
      });
    }
  });

  describe('a table file ERD Studio cannot read is an error, and fix-dbml-file names it', () => {
    const cases: Array<[string, (t: string) => string | null, string]> = [
      ['two Tables in one file', (t) => `${t}\nTable other {\n  id int\n}\n`, 'structure:notOneTable'],
      ['a Table not named as its file', (t) => t.replace('Table bridge_empty', 'Table something_else'), 'structure:nameMismatch'],
      ['an empty file', () => '', 'read'],
    ];
    for (const [label, edit, code] of cases) {
      it(label, async () => {
        const r = await doctor(nativeWith({ 'tables/gold/bridge_empty.dbml': edit }));
        expect(problem(r, code)).toEqual([expect.objectContaining({ file: '.erd-studio/tables/gold/bridge_empty.dbml', severity: 'error' })]);
        expect(ids(r)[0]).toBe('fix-dbml-file');
        expect(r.nextSteps[0].why).toContain(`.erd-studio/tables/gold/bridge_empty.dbml`);
        expect(r.nextSteps[0].why).toContain(`(${code})`);
      });
    }
  });

  it('a Metadata block naming an unknown column is a warning with its precise text, once, and raises no next step (D25)', async () => {
    const r = await doctor(nativeWith({ 'tables/gold/fct_order.dbml': (t) => `${t}\nMetadata Column fct_order.nope {\n  note: 'x'\n}\n` }));
    expect(r.erd.dbmlProblems).toEqual([{
      file: '.erd-studio/tables/gold/fct_order.dbml', line: 31, code: 'structure:metadataTarget', severity: 'warning',
      message: "A Metadata block on line 31 targets column 'nope', which this table does not have; rename or remove the block.",
    }]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a use line or a Ref in a table file is an error (useInTableFile, refInTableFile)', async () => {
    const used = await doctor(nativeWith({ 'tables/gold/dim_region.dbml': (t) => `use { table dim_date } from '../dim_date.dbml'\n${t}` }));
    expect(problem(used, 'useInTableFile')).toEqual([expect.objectContaining({ severity: 'error', line: 1 })]);
    expect(ids(used)).toContain('fix-dbml-file');
    const ref = await doctor(nativeWith({ 'tables/gold/dim_region.dbml': (t) => `${t}\nRef: dim_region.region_code > dim_region.region_code\n` }));
    const [p] = problem(ref, 'refInTableFile');
    expect(p).toMatchObject({ severity: 'error', file: '.erd-studio/tables/gold/dim_region.dbml' });
    expect(p.message).toContain("_relationships.dbml");
    expect(ids(ref)).toContain('fix-dbml-file');
  });

  it('a YAML table listed in a DBML diagram is a warning (yamlTableInDbmlDiagram, a mixed project)', async () => {
    const r = await doctor(nativeWith({
      'tables/gold/fct_extra.yml': () => 'name: fct_extra\ncolumns:\n  - name: extra_key\n    dataType: INT\n',
      'silver/staging.dbml': (t) => `${t}use { table fct_extra } from '../tables/gold/fct_extra.dbml'\n`,
    }));
    const [p] = problem(r, 'yamlTableInDbmlDiagram');
    expect(p).toMatchObject({ severity: 'warning', file: '.erd-studio/silver/staging.dbml', line: 10 });
    expect(p.message).toContain('fct_extra is a YAML table (tables/gold/fct_extra.yml)');
  });

  it("erd_layout's bad lines and a repeated key are warnings with their own codes, raising no next step; a .dbdiagram is never read", async () => {
    const r = await doctor(nativeWith({
      'gold/sales.dbml': (t) => t.replace('    fct_order 400 200\n', '    fct_order 400 200\n    not a line\n').replace(/\n\}\n\nuse/, "\n  ERD_LAYOUT: '''\n    fct_order 1 1\n  '''\n}\n\nuse"),
      'gold/sales.dbdiagram': () => 'not json',
    }));
    expect(problem(r, 'layoutBadLine')).toEqual([expect.objectContaining({ severity: 'warning', file: '.erd-studio/gold/sales.dbml', line: 13 })]);
    expect(problem(r, 'layoutDuplicateKey')).toEqual([expect.objectContaining({ severity: 'warning', file: '.erd-studio/gold/sales.dbml', line: 17 })]);
    expect(problem(r, 'diagramWarning')).toEqual([]);
    expect(r.erd.dbmlProblems.filter((p) => p.file.endsWith('.dbdiagram'))).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('an erd_layout that is not a string is a layoutBadValue error: write positions as a \'\'\'…\'\'\' string', async () => {
    const r = await doctor(nativeWith({ 'gold/sales.dbml': (t) => t.replace(/ {2}erd_layout: '''[^]*?'''\n/, '  erd_layout: 42\n') }));
    expect(problem(r, 'layoutBadValue')).toEqual([expect.objectContaining({ severity: 'error', file: '.erd-studio/gold/sales.dbml', line: 6 })]);
    expect(problem(r, 'layoutBadValue')[0].message).toContain("other DBML tools reject the file; write positions as a '''…''' string");
    expect(ids(r)).toContain('fix-dbml-file');
  });

  it('a git conflict only inside erd_layout is layoutMergeConflict (not mergeConflict): the diagram\'s other checks still run', async () => {
    const r = await doctor(nativeWith({
      'gold/sales.dbml': (t) => t
        .replace('    fct_order 400 200\n', '<<<<<<< HEAD\n    fct_order 400 200\n=======\n    fct_order 500 200\n>>>>>>> theirs\n')
        .replace("'../tables/dim_date.dbml'", "'../tables/silver/dim_date.dbml'"),
    }));
    expect(problem(r, 'mergeConflict')).toEqual([]);
    expect(problem(r, 'layoutMergeConflict')).toEqual([expect.objectContaining({ severity: 'error', mergeConflict: true, file: '.erd-studio/gold/sales.dbml', line: 12 })]);
    // Its other checks still run.
    expect(problem(r, 'usePathMismatch').map((p) => p.file)).toEqual(['.erd-studio/gold/sales.dbml']);
    expect(ids(r)[0]).toBe('resolve-merge-conflicts');
    expect(r.nextSteps[0].why).toContain(".erd-studio/gold/sales.dbml:12. This diagram still holds git conflict markers in its erd_layout: only positions differ: keep either side; the diagram still opens, but ERD Studio won't save positions until it is resolved.");
    expect(ids(r)).not.toContain('fix-dbml-file');
  });

  it('a diagram use path that misses its table and a missing relationships use line are warnings with the corrected line', async () => {
    const r = await doctor(nativeWith({
      'silver/staging.dbml': (t) => t
        .replace("use { table dim_date } from '../tables/dim_date.dbml'", "use { table dim_date } from '../tables/gold/dim_date.dbml'")
        .replace("use * from '../tables/gold/_relationships.dbml'\n", ''),
    }));
    const [mismatch] = problem(r, 'usePathMismatch');
    expect(mismatch).toMatchObject({ file: '.erd-studio/silver/staging.dbml', severity: 'warning' });
    expect(mismatch.message).toContain("use { table dim_date } from '../tables/dim_date.dbml'");
    const [rel] = problem(r, 'missingRelationshipsUse');
    expect(rel.message).toContain("use * from '../tables/gold/_relationships.dbml'");
  });

  it("a stale or wrong-case use path is reported once, as a warning: not also as the parser's import errors", async () => {
    const r = await doctor(nativeWith({
      'gold/sales.dbml': (t) => t
        .replace("'../tables/gold/dim_customer.dbml'", "'../tables/gold/Dim_Customer.dbml'")
        .replace("'../tables/dim_date.dbml'", "'../tables/silver/dim_date.dbml'"),
    }));
    expect(problem(r, 'usePathMismatch').map((p) => [p.line, p.severity])).toEqual([[19, 'warning'], [20, 'warning']]);
    expect(r.erd.dbmlProblems.filter((p) => typeof p.code === 'number')).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it("a Ref naming a table the file does not import is one missingUse warning, not also the parser's binding errors", async () => {
    const r = await doctor(nativeWith({ 'tables/gold/_relationships.dbml': (t) => t.replace("use { table dim_region } from './dim_region.dbml'\n", '') }));
    expect(problem(r, 'missingUse')).toEqual([expect.objectContaining({ severity: 'warning', line: 8 })]);
    expect(problem(r, 'missingUse')[0].message).toContain("Add the line: use { table dim_region } from './dim_region.dbml'");
    expect(r.erd.dbmlProblems.filter((p) => typeof p.code === 'number')).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a Metadata block in a diagram or relationships file is one foreignMetadata warning naming its line and target table (D25), raising no next step', async () => {
    const root = nativeWith({
      'gold/sales.dbml': (t) => `${t}\nMetadata Table fct_order {\n  grain: 'One row per order'\n}\n`,
      'tables/gold/_relationships.dbml': (t) => `${t}\nMetadata Column fct_order.customer_key {\n  note: 'The buyer'\n}\n`,
    });
    const r = await doctor(root);
    const lineOf = (rel: string, needle: string): number =>
      fs.readFileSync(path.join(root, '.erd-studio', rel), 'utf-8').split('\n').findIndex((l) => l.startsWith(needle)) + 1;
    const found = problem(r, 'foreignMetadata');
    expect(found.map((p) => [p.file, p.line, p.severity])).toEqual([
      ['.erd-studio/gold/sales.dbml', lineOf('gold/sales.dbml', 'Metadata Table'), 'warning'],
      ['.erd-studio/tables/gold/_relationships.dbml', lineOf('tables/gold/_relationships.dbml', 'Metadata Column'), 'warning'],
    ]);
    expect(found.map((p) => p.message)).toEqual([
      expect.stringMatching(/^This Metadata block sets properties of fct_order from outside its table file \(tables\/gold\/fct_order\.dbml\)\./),
      expect.stringMatching(/^This Metadata block sets properties of fct_order\.customer_key from outside its table file \(tables\/gold\/fct_order\.dbml\)\..*Move them into tables\/gold\/fct_order\.dbml as inline settings, and remove the block\.$/),
    ]);
    // The diagram reader's own note on the same block is not repeated.
    expect(problem(r, 'declaredInDiagram')).toEqual([]);
    expect(r.erd.dbmlProblems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a Metadata block on a Table the same file declares is not foreignMetadata (a single-file DBML in a layer folder)', async () => {
    const r = await doctor(nativeWith({
      'gold/pulled.dbml': () => "Table a {\n  id int [pk]\n}\n\nMetadata Table a {\n  grain: 'x'\n}\n",
    }));
    expect(problem(r, 'foreignMetadata')).toEqual([]);
    expect(problem(r, 'declaresOwnTables')).toEqual([expect.objectContaining({ file: '.erd-studio/gold/pulled.dbml' })]);
    expect(r.erd.dbmlProblems.filter((p) => p.file === '.erd-studio/gold/pulled.dbml' && /Metadata/.test(p.message))).toEqual([]);
  });

  it('a Metadata block on a table with no table file says so, not "move them into its table file"', async () => {
    const r = await doctor(nativeWith({ 'gold/sales.dbml': (t) => `${t}\nMetadata Table nowhere {\n  grain: 'x'\n}\n` }));
    const [p] = problem(r, 'foreignMetadata');
    expect(p.message).toBe('This Metadata block sets properties of nowhere, which has no table file; it is not read. Add the table, or remove the block.');
  });

  it('a Metadata block on a YAML table (a mixed project) words the fix for YAML', async () => {
    const r = await doctor(nativeWith({
      'tables/gold/fct_extra.yml': () => 'name: fct_extra\ncolumns:\n  - name: extra_key\n    dataType: INT\n',
      'tables/gold/_relationships.dbml': (t) => `${t}\nMetadata Table fct_extra {\n  grain: 'x'\n}\n`,
    }));
    const [p] = problem(r, 'foreignMetadata');
    expect(p.message).toContain('fct_extra is a YAML table: set them in tables/gold/fct_extra.yml');
    expect(p.message).not.toMatch(/Move them into tables\/gold\/fct_extra\.yml as inline settings/);
  });

  it("a relationships file's syntax error is reported once (the compile's, not the reader's copy too)", async () => {
    const r = await doctor(nativeWith({ 'tables/_relationships.dbml': (t) => `${t}Ref: dim_date.date_key >\n` }));
    expect(problem(r, 1002)).toEqual([expect.objectContaining({ file: '.erd-studio/tables/_relationships.dbml', line: 6, severity: 'error', message: 'Unexpected EOF' })]);
    expect(ids(r)[0]).toBe('fix-dbml-file');
  });

  it('a table file whose name differs from its stem in case is a warning (nameCaseDrift)', async () => {
    const r = await doctor(nativeWith({ 'tables/dim_date.dbml': replace('Table dim_date', 'Table Dim_Date') }));
    expect(problem(r, 'nameCaseDrift')).toEqual([expect.objectContaining({ severity: 'warning', file: '.erd-studio/tables/dim_date.dbml' })]);
  });

  it('routes every conflicted DBML file to resolve-merge-conflicts, never fix-dbml-file', async () => {
    const conflict = (t: string): string => `<<<<<<< HEAD\n${t}=======\n${t}>>>>>>> other\n`;
    const r = await doctor(nativeWith({ 'tables/gold/_relationships.dbml': conflict, 'gold/sales.dbml': conflict, 'tables/dim_date.dbml': conflict }));
    const conflicted = r.erd.dbmlProblems.filter((p) => p.mergeConflict);
    expect(conflicted.map((p) => p.file).sort()).toEqual([
      '.erd-studio/gold/sales.dbml', '.erd-studio/tables/dim_date.dbml', '.erd-studio/tables/gold/_relationships.dbml',
    ]);
    expect(conflicted.every((p) => p.severity === 'error' && p.line === 1)).toBe(true);
    expect(ids(r)[0]).toBe('resolve-merge-conflicts');
    const step = r.nextSteps[0];
    expect(step.why).toContain('.erd-studio/gold/sales.dbml:1');
    expect(step.why).toContain('.erd-studio/tables/dim_date.dbml:1');
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
    expect(r.erd.dbmlConversion?.leftAsIs?.map((l) => l.problem).join(' ')).toContain('tables/gold/dim_region.dbml already exists, with other contents');
    expect(problem(r, 'formatConflict').map((p) => p.severity)).toEqual(['error', 'error']);
    expect(ids(r)).toEqual(['resolve-format-conflicts']);
    const step = r.nextSteps[0];
    expect(step.title).toBe('Keep one file for 2 tables or diagrams found as both YAML/JSON and DBML');
    expect(step.why).toContain('dim_region exists as both YAML and DBML');
    expect(step.why).toContain('The diagram sales exists as both JSON and DBML');
  });

  it('a diagram member with no table file (erd_unlinked_tables) and pending relationships are warnings naming diagram, table and fix (D26/D27)', async () => {
    const r = await doctor(nativeWith({
      'gold/sales.dbml': replace("  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n", "  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n  erd_unlinked_tables: 'gld_fct_risk_child, dim_region'\n")
        .bind(null) as never,
      'tables/gold/_relationships.dbml': (text) => `${text}\n// erd-studio pending: Ref: fct_order.risk_key >? gld_fct_risk_child.risk_key\n`,
    }));
    expect(problem(r, 'unlinkedTable')).toEqual([
      expect.objectContaining({ file: '.erd-studio/gold/sales.dbml', severity: 'warning', message: expect.stringMatching(/^gld_fct_risk_child is on this diagram but has no table file, so it is drawn as missing .* Add it \(Add from dbt\), or remove it from the diagram\.$/) }),
    ]);
    expect(problem(r, 'pendingRelationship')).toEqual([
      expect.objectContaining({
        file: '.erd-studio/tables/gold/_relationships.dbml', line: 16, severity: 'warning',
        message: expect.stringMatching(/^The pending relationship fct_order\.risk_key → gld_fct_risk_child\.risk_key is drawn by ERD Studio, but other DBML tools see only a comment: gld_fct_risk_child has no table file; fct_order has no column risk_key\./),
      }),
    ]);
    // Warnings only: the project still compiles for every DBML tool, and nothing blocks.
    expect(r.erd.dbmlProblems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a member whose YAML file holds another name is named as that YAML file, not as missing; a pending line to a YAML table points at Convert, not Add from dbt', async () => {
    const r = await doctor(nativeWith({
      'gold/sales.dbml': replace("  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n", "  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n  erd_unlinked_tables: 'dim_store_format'\n"),
      // Convert leaves this file as YAML (its name: is not its filename); the loader still draws it for the member.
      'tables/gold/dim_store_format.yml': () => 'name: dim_store_type\ncolumns:\n  - name: store_type_key\n    dataType: INT\n',
      'tables/gold/_relationships.dbml': (text) => `${text}\n// erd-studio pending: Ref: fct_order.order_id >? dim_store_format.store_type_key\n`,
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
      'gold/sales.dbml': replace("  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n", "  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n  erd_unlinked_tables: 'dim_sales_rep'\n"),
      'tables/gold/dim_sales_rep.yml': () => '',
      'tables/gold/_relationships.dbml': (text) => `${text}\n// erd-studio pending: Ref: fct_order.order_id >? dim_sales_rep.sales_rep_key\n`,
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
      'gold/sales.dbml': replace("  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n", "  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n  erd_unlinked_tables: 'dim_sales_rep'\n"),
      'tables/gold/dim_sales_rep.yaml': () => 'name: dim_sales_rep\ncolumns:\n  - name: sales_rep_key\n    dataType: INT\n',
      'tables/gold/_relationships.dbml': (text) => `${text}\n// erd-studio pending: Ref: fct_order.order_id >? dim_sales_rep.sales_rep_key\n`,
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
      'gold/sales.dbml': replace("  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n", "  erd_layout_options: '{\"elk.direction\":\"RIGHT\"}'\n  erd_unlinked_tables: 'dim_sales_rep'\n"),
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
    const r = await doctor(nativeWith({ 'gold/pulled.dbml': () => 'Table a {\n  id int [pk]\n}\n' }));
    expect(problem(r, 'declaresOwnTables')).toEqual([expect.objectContaining({ file: '.erd-studio/gold/pulled.dbml', severity: 'warning' })]);
    const step = r.nextSteps.find((s) => s.id === 'import-dbml-file')!;
    expect(step.why).toBe('Run ERD Studio: Import DBML… on .erd-studio/gold/pulled.dbml; it is a single-file DBML, not an ERD Studio diagram.');
  });

  it('a Table declared inside an ERD Studio diagram is a warning', async () => {
    const r = await doctor(nativeWith({ 'silver/staging.dbml': (t) => `${t}\nTableGroup g {\n  fct_order\n}\n` }));
    expect(problem(r, 'declaredInDiagram').map((p) => p.severity)).toEqual(['warning']);
  });

  it('tablesLayerConflict is an error and missingLayersConfig a warning', async () => {
    const listed = await doctor(nativeWith({ 'layers.json': (t) => t.replace('"layers": [', '"layers": [\n    { "id": "tables", "label": "Tables", "abbreviation": "TBL", "color": "#a0a0a0", "creatable": true, "order": 0 },') }));
    expect(problem(listed, 'tablesLayerConflict')).toEqual([expect.objectContaining({ severity: 'error', file: '.erd-studio/tables' })]);
    expect(problem(listed, 'tablesLayerConflict')[0].message).toContain('Remove the `tables` layer from layers.json');
    const missing = await doctor(nativeWith({ 'layers.json': () => null }));
    expect(problem(missing, 'missingLayersConfig')).toEqual([expect.objectContaining({ severity: 'warning' })]);
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
    fs.writeFileSync(path.join(root, '.erd-studio', 'gold', 'extra.dbml'), "Project extra {\n  erd_schema_version: '7'\n}\n");
    const r = await doctor(root);
    expect(r.erd.storage).toBe('yaml');
    expect(problem(r, 'dbmlDiagramInYamlProject')).toEqual([expect.objectContaining({ file: '.erd-studio/gold/extra.dbml', severity: 'warning' })]);
  });

  it('turn-round-relationships names the relationships file for a DBML table', async () => {
    // fct_order.order_line_id is its whole key; pointing it at dim_customer's non-key column draws it backwards.
    const r = await doctor(nativeWith({
      'tables/gold/_relationships.dbml': (t) => `${t}Ref: fct_order.order_line_id >? dim_customer.segment\n`,
    }));
    const step = r.nextSteps.find((s) => s.id === 'turn-round-relationships');
    expect(step?.why).toContain("in the relationships file of that column's table (tables/gold/_relationships.dbml)");
  });

  it('prints storage, DBML problems by severity and the newer-helper line in human output', async () => {
    const root = nativeWith({ 'tables/dim_date.dbml': replace("role: 'conformed-dim'", 'role: conformed') });
    let out = '';
    await main(['doctor', '--project', root, '--no-dbt'], { stdout: { write: (s: string) => { out += s; } }, stderr: { write: () => undefined }, cwd: tmp, env: cleanEnv });
    expect(out).toContain('storage DBML');
    expect(out).toContain('.erd-studio/tables/dim_date.dbml line 2:');
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
