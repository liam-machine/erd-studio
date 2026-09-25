import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  classifyDbtVersion,
  dbtCommands,
  dbtExecutableCandidates,
  dbtInvocation,
  dbtVersionSpawn,
  detectDepsStatus,
  isUntrustedProjectExecutable,
  displayPath,
  findDbtProjectDir,
  findProfiles,
  findVenvActivate,
  findVenvDir,
  probeDbt,
  readDbtProjectIdentity,
  runDbtVersion,
  venvActivateCommand,
} from '../../src/services/dbtEnv';

const CORE_19 = `Core:
  - installed: 1.9.4
  - latest:    1.9.4 - Up to date!

Plugins:
  - snowflake: 1.9.1 - Up to date!

`;
const CLOUD_CLI = 'dbt Cloud CLI - 0.40.14 (5c0fa6a 2025-01-15T18:05:14Z)\n';
const FUSION = 'dbt 2.0.1\n';
const FUSION_PREVIEW = 'dbt-fusion 2.0.0-preview.92\n';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-env-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content = '', mode?: number): string {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
  return file;
}

describe('classifyDbtVersion', () => {
  it('recognises dbt Core 1.x', () => {
    expect(classifyDbtVersion(CORE_19)).toEqual({ flavour: 'core-v1', version: '1.9.4' });
  });
  it('recognises the dbt Cloud CLI', () => {
    expect(classifyDbtVersion(CLOUD_CLI)).toEqual({ flavour: 'cloud-cli', version: '0.40.14' });
    expect(classifyDbtVersion('Cloud CLI - 0.38.0 (abc)')).toEqual({ flavour: 'cloud-cli', version: '0.38.0' });
  });
  it('recognises dbt Fusion', () => {
    expect(classifyDbtVersion(FUSION)).toEqual({ flavour: 'fusion-v2', version: '2.0.1' });
    expect(classifyDbtVersion(FUSION_PREVIEW)).toEqual({ flavour: 'fusion-v2', version: '2.0.0-preview.92' });
  });
  it('ignores colour codes and CRLF', () => {
    expect(classifyDbtVersion('\u001b[32mCore:\u001b[0m\r\n  - installed: 1.8.0\r\n')).toEqual({ flavour: 'core-v1', version: '1.8.0' });
  });
  it('recognises pre-1.5 Core output', () => {
    expect(classifyDbtVersion('installed version: 1.3.2\n   latest version: 1.9.0\n')).toEqual({ flavour: 'core-v1', version: '1.3.2' });
  });
  it('calls anything else unknown', () => {
    expect(classifyDbtVersion('command not found: dbt')).toEqual({ flavour: 'unknown', version: null });
    expect(classifyDbtVersion('')).toEqual({ flavour: 'unknown', version: null });
  });
});

describe('dbtCommands', () => {
  it('uses docs generate for Core and compile --write-catalog for Fusion', () => {
    expect(dbtCommands('core-v1', '.venv/bin/dbt')).toEqual({
      parse: '.venv/bin/dbt parse', catalog: '.venv/bin/dbt docs generate', debug: '.venv/bin/dbt debug',
    });
    expect(dbtCommands('fusion-v2', 'dbt').catalog).toBe('dbt compile --write-catalog');
  });
  it('has no debug for the Cloud CLI and nothing without dbt', () => {
    expect(dbtCommands('cloud-cli', 'dbt')).toEqual({ parse: 'dbt parse', catalog: 'dbt docs generate', debug: null });
    expect(dbtCommands(null, 'dbt')).toEqual({ parse: null, catalog: null, debug: null });
  });
});

describe('venv detection', () => {
  it('finds a POSIX venv by bin/activate in candidate order', () => {
    write('env/bin/activate');
    write('venv/bin/activate');
    expect(findVenvDir(tmp, 'darwin')).toBe(path.join(tmp, 'venv'));
    expect(findVenvDir(tmp, 'linux')).toBe(path.join(tmp, 'venv'));
    write('.venv/bin/activate');
    expect(findVenvDir(tmp, 'linux')).toBe(path.join(tmp, '.venv'));
  });

  it('finds a Windows venv only by Scripts/activate.bat', () => {
    write('.venv/bin/activate');
    expect(findVenvDir(tmp, 'win32')).toBeNull();
    write('venv/Scripts/activate.bat');
    expect(findVenvDir(tmp, 'win32')).toBe(path.join(tmp, 'venv'));
  });

  it('returns null with no venv', () => {
    expect(findVenvDir(tmp, 'linux')).toBeNull();
    expect(findVenvActivate(tmp, 'linux')).toBeNull();
  });

  it('builds the activate command per platform, escaping quotes', () => {
    expect(venvActivateCommand('/p/.venv', 'linux')).toBe("source '/p/.venv/bin/activate'");
    expect(venvActivateCommand("/it's/.venv", 'darwin')).toBe("source '/it'\\''s/.venv/bin/activate'");
    expect(venvActivateCommand('C:\\p\\.venv', 'win32')).toBe('"C:\\p\\.venv\\Scripts\\activate.bat"');
  });

  it('findVenvActivate matches the provider\'s previous output', () => {
    write('.venv/bin/activate');
    expect(findVenvActivate(tmp, 'linux')).toBe(`source '${path.join(tmp, '.venv', 'bin', 'activate')}'`);
  });
});

describe('dbtExecutableCandidates', () => {
  it('orders override, venv, VIRTUAL_ENV, CONDA_PREFIX, PATH, then shims', () => {
    const exe = 0o755;
    const override = write('tools/dbt', '', exe);
    const venv = write('proj/.venv/bin/dbt', '', exe);
    const virtualEnv = write('ve/bin/dbt', '', exe);
    const conda = write('conda/bin/dbt', '', exe);
    const onPath1 = write('path1/dbt', '', exe);
    write('path2/dbt', '', exe);
    const pyenv = write('home/.pyenv/shims/dbt', '', exe);
    const pipx = write('home/.local/bin/dbt', '', exe);

    const got = dbtExecutableCandidates(path.join(tmp, 'proj'), {
      platform: 'linux',
      homeDir: path.join(tmp, 'home'),
      override: path.join(tmp, 'tools'),
      env: {
        VIRTUAL_ENV: path.join(tmp, 've'),
        CONDA_PREFIX: path.join(tmp, 'conda'),
        PATH: [path.join(tmp, 'nothing'), path.join(tmp, 'path1'), path.join(tmp, 'path2')].join(':'),
      },
    });
    expect(got).toEqual([
      { executable: override, source: 'override' },
      { executable: venv, source: 'venv' },
      { executable: virtualEnv, source: 'virtual-env' },
      { executable: conda, source: 'conda' },
      { executable: onPath1, source: 'path' },
      { executable: pyenv, source: 'shim' },
      { executable: pipx, source: 'shim' },
    ]);
  });

  it('de-duplicates and skips non-executable files', () => {
    write('proj/.venv/bin/dbt', '', 0o644);
    const onPath = write('bin/dbt', '', 0o755);
    const got = dbtExecutableCandidates(path.join(tmp, 'proj'), {
      platform: 'linux', homeDir: path.join(tmp, 'home'),
      env: { PATH: path.join(tmp, 'bin'), VIRTUAL_ENV: path.join(tmp, '.none') },
      override: onPath,
    });
    // The override is also the first dbt on PATH, so a shell runs it as bare `dbt`.
    expect(got).toEqual([{ executable: onPath, source: 'override', onPath: true }]);
    expect(dbtInvocation(got[0], path.join(tmp, 'proj'), 'linux')).toBe('dbt');
  });

  it('an activated project venv is on PATH, so it is trusted and invoked as bare dbt', () => {
    const venvDbt = write('proj/.venv/bin/dbt', '', 0o755);
    const root = path.join(tmp, 'proj');
    const activated = dbtExecutableCandidates(root, {
      platform: 'linux', homeDir: path.join(tmp, 'home'), env: { PATH: path.join(root, '.venv', 'bin') },
    });
    expect(activated).toEqual([{ executable: venvDbt, source: 'venv', onPath: true }]);
    expect(isUntrustedProjectExecutable(activated[0])).toBe(false);
    expect(dbtInvocation(activated[0], root, 'linux')).toBe('dbt');

    const cloned = dbtExecutableCandidates(root, { platform: 'linux', homeDir: path.join(tmp, 'home'), env: { PATH: '' } });
    expect(cloned).toEqual([{ executable: venvDbt, source: 'venv' }]);
    expect(isUntrustedProjectExecutable(cloned[0])).toBe(true);
    expect(isUntrustedProjectExecutable({ executable: venvDbt, source: 'override' })).toBe(false);
  });

  it('uses Scripts and PATHEXT on Windows', () => {
    const present = new Set([
      'C:\\proj\\.venv\\Scripts\\dbt.exe',
      'C:\\tools\\dbt.CMD'.toLowerCase(),
    ]);
    const got = dbtExecutableCandidates('C:\\proj', {
      platform: 'win32',
      homeDir: 'C:\\Users\\me',
      env: { Path: 'C:\\tools', PATHEXT: '.EXE;.CMD' },
      isExecutable: (f) => present.has(f) || present.has(f.toLowerCase()),
    });
    expect(got).toEqual([
      { executable: 'C:\\proj\\.venv\\Scripts\\dbt.exe', source: 'venv' },
      { executable: 'C:\\tools\\dbt.cmd', source: 'path' },
    ]);
  });
});

describe('dbtInvocation', () => {
  it('is bare dbt for PATH, project-relative inside, absolute outside, quoted when needed', () => {
    expect(dbtInvocation({ executable: '/usr/bin/dbt', source: 'path' }, '/proj', 'linux')).toBe('dbt');
    expect(dbtInvocation({ executable: '/proj/.venv/bin/dbt', source: 'venv' }, '/proj', 'linux')).toBe('.venv/bin/dbt');
    expect(dbtInvocation({ executable: '/opt/conda/bin/dbt', source: 'conda' }, '/proj', 'linux')).toBe('/opt/conda/bin/dbt');
    expect(dbtInvocation({ executable: '/my envs/bin/dbt', source: 'virtual-env' }, '/proj', 'linux')).toBe("'/my envs/bin/dbt'");
    expect(dbtInvocation({ executable: 'C:\\proj\\.venv\\Scripts\\dbt.exe', source: 'venv' }, 'C:\\proj', 'win32'))
      .toBe('.venv/Scripts/dbt.exe');
  });
});

describe('probeDbt / runDbtVersion', () => {
  it('returns the first candidate that prints anything, classified', async () => {
    const outputs: Record<string, string | null> = { '/a/dbt': null, '/b/dbt': CORE_19, '/c/dbt': FUSION };
    const result = await probeDbt(
      [
        { executable: '/a/dbt', source: 'venv' },
        { executable: '/b/dbt', source: 'path' },
        { executable: '/c/dbt', source: 'shim' },
      ],
      async (exe) => ({ output: outputs[exe] }),
    );
    expect(result).toMatchObject({ candidate: { executable: '/b/dbt' }, flavour: 'core-v1', version: '1.9.4', rawOutput: CORE_19 });
  });

  it('returns null when nothing runs', async () => {
    expect(await probeDbt([{ executable: '/x', source: 'path' }], async () => ({ output: null }))).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('runs a real executable and never rejects', async () => {
    const fake = write('bin/dbt', `#!/bin/sh\nprintf '%s' '${FUSION_PREVIEW.trim()}'\n`, 0o755);
    const ok = await runDbtVersion(fake);
    expect(classifyDbtVersion(ok.output!)).toEqual({ flavour: 'fusion-v2', version: '2.0.0-preview.92' });
    const missing = await runDbtVersion(path.join(tmp, 'nope'));
    expect(missing.output).toBeNull();
    expect(missing.error).toBeTruthy();
  });
});

describe('dbtVersionSpawn (cmd.exe quoting for .cmd / .bat shims)', () => {
  it('spawns ordinary executables directly, with no shell', () => {
    expect(dbtVersionSpawn('/home/John Smith/.venv/bin/dbt')).toEqual({ file: '/home/John Smith/.venv/bin/dbt', args: ['--version'], shell: false });
    expect(dbtVersionSpawn('C:\\a b\\dbt.exe')).toMatchObject({ shell: false });
  });

  it('double-quotes a .bat / .cmd path so a space or & cannot split it', () => {
    expect(dbtVersionSpawn('C:\\Users\\John Smith\\.pyenv\\pyenv-win\\shims\\dbt.bat')).toEqual({
      file: '"C:\\Users\\John Smith\\.pyenv\\pyenv-win\\shims\\dbt.bat"', args: ['--version'], shell: true,
    });
    expect(dbtVersionSpawn('C:\\proj\\a&calc\\dbt.CMD')).toMatchObject({ file: '"C:\\proj\\a&calc\\dbt.CMD"', shell: true });
  });

  it('refuses a .bat / .cmd path cmd.exe cannot quote safely', () => {
    expect(dbtVersionSpawn('C:\\%PATH%\\dbt.bat')).toBeNull();
    expect(dbtVersionSpawn('C:\\a"b\\dbt.cmd')).toBeNull();
    expect(dbtVersionSpawn('C:\\a\nb\\dbt.cmd')).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('runs an executable whose path has a space', async () => {
    const fake = write('John Smith/bin/dbt', `#!/bin/sh\nprintf '%s' '${FUSION_PREVIEW.trim()}'\n`, 0o755);
    expect(classifyDbtVersion((await runDbtVersion(fake)).output!)).toMatchObject({ flavour: 'fusion-v2' });
    expect(await runDbtVersion(path.join(tmp, '%X%', 'dbt.bat'))).toEqual({ output: null, error: expect.stringContaining('unsupported path') });
  });
});

describe('findDbtProjectDir', () => {
  it('finds the start dir, then an ancestor', () => {
    write('proj/dbt_project.yml', 'name: p\n');
    fs.mkdirSync(path.join(tmp, 'proj', 'models', 'staging'), { recursive: true });
    expect(findDbtProjectDir(path.join(tmp, 'proj'))).toBe(path.join(tmp, 'proj'));
    expect(findDbtProjectDir(path.join(tmp, 'proj', 'models', 'staging'))).toBe(path.join(tmp, 'proj'));
  });

  it('searches down (shallowest, then name order) and skips excluded dirs', () => {
    write('mono/node_modules/x/dbt_project.yml');
    write('mono/.hidden/dbt_project.yml');
    write('mono/b/dbt_project.yml');
    write('mono/a/deep/dbt_project.yml');
    expect(findDbtProjectDir(path.join(tmp, 'mono'))).toBe(path.join(tmp, 'mono', 'b'));
  });

  it('stops at depth 3 and returns null', () => {
    write('mono/a/b/c/d/dbt_project.yml');
    expect(findDbtProjectDir(path.join(tmp, 'mono'))).toBeNull();
    write('mono2/a/b/c/dbt_project.yml');
    expect(findDbtProjectDir(path.join(tmp, 'mono2'))).toBe(path.join(tmp, 'mono2', 'a', 'b', 'c'));
  });
});

describe('readDbtProjectIdentity', () => {
  it('reads name, profile and packages-install-path', () => {
    write('dbt_project.yml', 'name: shop\nprofile: warehouse\npackages-install-path: ./vendor/\n');
    expect(readDbtProjectIdentity(tmp)).toEqual({ name: 'shop', profile: 'warehouse', packagesInstallPath: 'vendor' });
  });
  it('defaults when missing or malformed', () => {
    expect(readDbtProjectIdentity(tmp)).toEqual({ name: null, profile: null, packagesInstallPath: 'dbt_packages' });
    write('dbt_project.yml', ': : [');
    expect(readDbtProjectIdentity(tmp)).toEqual({ name: null, profile: null, packagesInstallPath: 'dbt_packages' });
  });
});

describe('findProfiles', () => {
  const home = () => path.join(tmp, 'home');
  const root = () => path.join(tmp, 'proj');

  it('searches DBT_PROFILES_DIR, DBT_ENGINE_PROFILES_DIR, the project, then ~/.dbt', () => {
    const env = { DBT_PROFILES_DIR: path.join(tmp, 'p1'), DBT_ENGINE_PROFILES_DIR: path.join(tmp, 'p2') };
    const none = findProfiles(root(), { env, homeDir: home(), profileName: 'wh' });
    expect(none).toEqual({
      required: true, found: false, path: null, profileDefined: null,
      searched: [
        path.join(tmp, 'p1', 'profiles.yml'),
        path.join(tmp, 'p2', 'profiles.yml'),
        'profiles.yml',
        '~/.dbt/profiles.yml',
      ],
    });

    write('home/.dbt/profiles.yml', 'other: {}\n');
    expect(findProfiles(root(), { env, homeDir: home(), profileName: 'wh' }))
      .toMatchObject({ found: true, path: '~/.dbt/profiles.yml', profileDefined: false });

    write('proj/profiles.yml', 'wh:\n  target: dev\n');
    expect(findProfiles(root(), { env, homeDir: home(), profileName: 'wh' }))
      .toMatchObject({ found: true, path: 'profiles.yml', profileDefined: true });

    write('p2/profiles.yml', 'wh: {}\n');
    expect(findProfiles(root(), { env, homeDir: home(), profileName: 'wh' }).path).toBe(path.join(tmp, 'p2', 'profiles.yml'));

    write('p1/profiles.yml', 'x: {}\n');
    expect(findProfiles(root(), { env, homeDir: home(), profileName: 'wh' }))
      .toMatchObject({ path: path.join(tmp, 'p1', 'profiles.yml'), profileDefined: false });
  });

  it('leaves profileDefined null without a profile name or when unparsable', () => {
    write('proj/profiles.yml', 'wh: [');
    expect(findProfiles(root(), { env: {}, homeDir: home(), profileName: 'wh' }).profileDefined).toBeNull();
    expect(findProfiles(root(), { env: {}, homeDir: home() }).profileDefined).toBeNull();
  });

  it('is not required for the Cloud CLI', () => {
    expect(findProfiles(root(), { flavour: 'cloud-cli', env: {}, homeDir: home() }))
      .toEqual({ required: false, found: false, path: null, searched: [], profileDefined: null });
  });
});

describe('detectDepsStatus', () => {
  it('needs deps when packages.yml lists packages and nothing is installed', () => {
    write('packages.yml', 'packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.1.1\n');
    expect(detectDepsStatus(tmp)).toEqual({ packagesFile: 'packages.yml', installPath: 'dbt_packages', installed: false, needsDeps: true });
    fs.mkdirSync(path.join(tmp, 'dbt_packages'));
    expect(detectDepsStatus(tmp).needsDeps).toBe(true); // empty dir
    fs.mkdirSync(path.join(tmp, 'dbt_packages', 'dbt_utils'));
    expect(detectDepsStatus(tmp)).toMatchObject({ installed: true, needsDeps: false });
  });

  it('reads dependencies.yml packages but not a projects-only (Mesh) file', () => {
    write('dependencies.yml', 'projects:\n  - name: core\n');
    expect(detectDepsStatus(tmp)).toMatchObject({ packagesFile: null, needsDeps: false });
    write('dependencies.yml', 'packages:\n  - package: x/y\n');
    expect(detectDepsStatus(tmp)).toMatchObject({ packagesFile: 'dependencies.yml', needsDeps: true });
  });

  it('honours packages-install-path', () => {
    write('dbt_project.yml', 'name: p\npackages-install-path: vendor\n');
    write('packages.yml', 'packages:\n  - package: x/y\n');
    write('vendor/y/dbt_project.yml');
    expect(detectDepsStatus(tmp)).toMatchObject({ installPath: 'vendor', installed: true, needsDeps: false });
  });

  it('needs nothing without a packages file', () => {
    expect(detectDepsStatus(tmp)).toEqual({ packagesFile: null, installPath: 'dbt_packages', installed: false, needsDeps: false });
  });
});

describe('displayPath', () => {
  it('prefers project-relative, then ~/, then absolute', () => {
    expect(displayPath('/home/me/proj/profiles.yml', '/home/me/proj', '/home/me')).toBe('profiles.yml');
    expect(displayPath('/home/me/.dbt/profiles.yml', '/home/me/proj', '/home/me')).toBe('~/.dbt/profiles.yml');
    expect(displayPath('/etc/dbt/profiles.yml', '/home/me/proj', '/home/me')).toBe('/etc/dbt/profiles.yml');
  });
});
