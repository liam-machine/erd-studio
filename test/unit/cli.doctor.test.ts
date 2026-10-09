import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
      + 'the next edit of this model on the canvas writes it back as dataType',
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
      + 'the next edit of this model on the canvas writes them back as dataType',
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
  function writeConflictedDomain(root: string): void {
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
    writeConflictedDomain(root);

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
    writeConflictedDomain(root);
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
    writeConflictedDomain(root);
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
