import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCmdShim,
  buildPosixShim,
  cmdEscape,
  CliLauncherService,
  launcherPaths,
  NODE_PROBE_SCRIPT,
  readLauncherRecord,
  shSingleQuote,
  verifyElectronRuntime,
  writeFileAtomic,
  type CliLauncherOptions,
} from '../../src/services/cliLauncherService';

// Pass-through wrappers so individual tests can observe or fail renames and writes.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

let home: string;
let cliSource: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-launcher-'));
  cliSource = path.join(home, 'ext', 'dist', 'cli.js');
  fs.mkdirSync(path.dirname(cliSource), { recursive: true });
  fs.writeFileSync(cliSource, "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function options(overrides: Partial<CliLauncherOptions> = {}): CliLauncherOptions {
  return {
    homeDir: home,
    extensionVersion: '1.2.0',
    execPath: process.execPath,
    cliSourcePath: cliSource,
    platform: process.platform,
    ...overrides,
  };
}

const alwaysVerified = () => Promise.resolve(true);

describe('shim text', () => {
  it('POSIX shim prefers node >= 18, then the verified runtime, then exits 5', () => {
    const text = buildPosixShim({ cliPath: '/h/.erd-studio-cli/lib/cli.js', runtime: '/Apps/Code', version: '1.2.0', platform: 'darwin' });
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).toContain("CLI='/h/.erd-studio-cli/lib/cli.js'");
    expect(text).toContain(`node -e '${NODE_PROBE_SCRIPT}'`);
    expect(text).toContain('exec node "$CLI" "$@"');
    expect(text).toContain("RUNTIME='/Apps/Code'");
    expect(text).toContain('ELECTRON_RUN_AS_NODE=1 exec "$RUNTIME" "$CLI" "$@"');
    expect(text).not.toMatch(/export\s+ELECTRON_RUN_AS_NODE/);
    expect(text).toContain('"code":"launcher-stale"');
    expect(text.trimEnd().endsWith('exit 5')).toBe(true);
    expect(text).toContain('v1.2.0');
  });

  it('POSIX shim omits the Electron branch when the runtime was not verified', () => {
    const text = buildPosixShim({ cliPath: '/h/cli.js', runtime: null, version: '1.2.0', platform: 'linux' });
    expect(text).not.toContain('RUNTIME=');
    expect(text).not.toContain('ELECTRON_RUN_AS_NODE');
    expect(text).toContain('exit 5');
  });

  it('single-quote escapes paths with spaces and quotes', () => {
    expect(shSingleQuote("/Users/o'neil/My Apps/Code")).toBe("'/Users/o'\\''neil/My Apps/Code'");
    const text = buildPosixShim({ cliPath: "/Users/o'neil/x y/cli.js", runtime: '/A B/Code', version: '1', platform: 'darwin' });
    expect(text).toContain("CLI='/Users/o'\\''neil/x y/cli.js'");
    expect(text).toContain("RUNTIME='/A B/Code'");
  });

  it('uses forward slashes in the POSIX shim on Windows', () => {
    const text = buildPosixShim({
      cliPath: 'C:\\Users\\me\\.erd-studio-cli\\lib\\cli.js',
      runtime: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      version: '1',
      platform: 'win32',
    });
    expect(text).toContain("CLI='C:/Users/me/.erd-studio-cli/lib/cli.js'");
    expect(text).toContain("RUNTIME='C:/Program Files/Microsoft VS Code/Code.exe'");
  });

  it('rejects paths containing line breaks', () => {
    expect(() => buildPosixShim({ cliPath: '/a\nrm -rf /', runtime: null, version: '1' })).toThrow(/line break/);
    expect(() => buildCmdShim({ cliPath: 'C:\\a\r\nb', runtime: null, version: '1' })).toThrow(/line break/);
    expect(() => buildCmdShim({ cliPath: 'C:\\a"b', runtime: null, version: '1' })).toThrow(/double quote/);
  });

  it('never prints an unsafe version into the comment', () => {
    const text = buildPosixShim({ cliPath: '/c', runtime: null, version: '1.0\nrm -rf ~' });
    expect(text).toContain('extension vunknown.');
    expect(text).not.toContain('rm -rf');
  });

  it('.cmd shim: goto labels, no %errorlevel% inside parentheses, bare exit /b, CRLF', () => {
    const text = buildCmdShim({
      cliPath: 'C:\\Users\\me\\.erd-studio-cli\\lib\\cli.js',
      runtime: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
      version: '1.2.0',
    });
    expect(text).toContain('\r\n');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('@echo off');
    expect(lines).toContain('setlocal');
    expect(lines).toContain('if errorlevel 1 goto electron');
    expect(lines).toContain(`node -e "${NODE_PROBE_SCRIPT}" >nul 2>nul`);
    expect(lines).toContain('node "%CLI%" %*');
    expect(lines).toContain(':electron');
    expect(lines).toContain(':stale');
    expect(lines).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(lines).toContain('exit /b 5');
    // Every call is followed by a bare exit /b so its exit code passes through.
    expect(lines[lines.indexOf('node "%CLI%" %*') + 1]).toBe('exit /b');
    expect(lines[lines.indexOf('"%RUNTIME%" "%CLI%" %*') + 1]).toBe('exit /b');
    // No parenthesised blocks at all, so %errorlevel% can never be expanded early.
    for (const line of lines) {
      expect(line.trim().endsWith('(')).toBe(false);
      expect(line.trim()).not.toBe(')');
    }
    expect(text.toLowerCase()).not.toContain('%errorlevel%');
  });

  it('.cmd shim doubles % in embedded paths', () => {
    expect(cmdEscape('C:\\100%\\x')).toBe('C:\\100%%\\x');
    const text = buildCmdShim({ cliPath: 'C:\\Users\\50%off\\cli.js', runtime: 'C:\\A%PATH%\\Code.exe', version: '1' });
    expect(text).toContain('set "CLI=C:\\Users\\50%%off\\cli.js"');
    expect(text).toContain('set "RUNTIME=C:\\A%%PATH%%\\Code.exe"');
  });

  it('.cmd shim without a verified runtime goes straight to the stale message', () => {
    const lines = buildCmdShim({ cliPath: 'C:\\c.js', runtime: null, version: '1' }).split('\r\n');
    expect(lines).not.toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(lines.indexOf(':stale')).toBe(lines.indexOf(':electron') + 1);
  });
});

describe('node probe (C1)', () => {
  it('exits 0 under the test runner\'s own node', () => {
    const result = spawnSync(process.execPath, ['-e', NODE_PROBE_SCRIPT]);
    expect(result.status).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('POSIX shim end to end', () => {
  it('runs the copied CLI through node and passes arguments through', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    const result = await svc.install(options());
    expect(result.ok).toBe(true);
    const out = execFileSync(result.binPath, ['diff', '--domain', 'a b.json'], { encoding: 'utf-8' });
    expect(JSON.parse(out)).toEqual({ argv: ['diff', '--domain', 'a b.json'] });
  });

  it('falls back to the recorded runtime with ELECTRON_RUN_AS_NODE when node is not on PATH', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    const result = await svc.install(options());
    fs.writeFileSync(cliSource, 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE || "unset");\n');
    fs.copyFileSync(cliSource, launcherPaths(home).cli);
    const run = spawnSync('/bin/sh', [result.binPath], { env: { PATH: '/nonexistent' }, encoding: 'utf-8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('1');
  });

  it('exits 5 with the launcher-stale JSON when no runtime is available', async () => {
    const svc = new CliLauncherService({ verifyRuntime: () => Promise.resolve(false) });
    const result = await svc.install(options());
    const run = spawnSync('/bin/sh', [result.binPath], { env: { PATH: '/nonexistent' }, encoding: 'utf-8' });
    expect(run.status).toBe(5);
    expect(JSON.parse(run.stdout).error.code).toBe('launcher-stale');
  });
});

describe('install', () => {
  it('writes cli.js, the shim (0755) and launcher.json with runtimeVerified', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified, now: () => new Date('2026-09-23T00:00:00Z') });
    const result = await svc.install(options());
    const paths = launcherPaths(home);
    expect(result.ok).toBe(true);
    expect(result.runtimeVerified).toBe(true);
    expect(fs.readFileSync(paths.cli, 'utf-8')).toBe(fs.readFileSync(cliSource, 'utf-8'));
    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.shim).mode & 0o777).toBe(0o755);
    }
    const record = readLauncherRecord(home)!;
    expect(record).toMatchObject({ extensionVersion: '1.2.0', execPath: process.execPath, runtimeVerified: true, writtenAt: '2026-09-23T00:00:00.000Z' });
    expect(record.cliSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.filesWritten[result.filesWritten.length - 1]).toBe(paths.record);
    expect(fs.existsSync(paths.cmdShim)).toBe(process.platform === 'win32');
  });

  it('writes the .cmd shim when the platform is win32', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    await svc.install(options({ platform: 'win32' }));
    const cmd = fs.readFileSync(launcherPaths(home).cmdShim, 'utf-8');
    expect(cmd.startsWith('@echo off\r\n')).toBe(true);
  });

  it('records runtimeVerified false and omits the Electron branch when verification fails', async () => {
    const svc = new CliLauncherService({ verifyRuntime: () => Promise.resolve(false) });
    const result = await svc.install(options());
    expect(result.runtimeVerified).toBe(false);
    expect(readLauncherRecord(home)!.runtimeVerified).toBe(false);
    expect(fs.readFileSync(launcherPaths(home).shim, 'utf-8')).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('reports failure without throwing when the CLI source is missing', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    const result = await svc.install(options({ cliSourcePath: path.join(home, 'nope.js') }));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(fs.existsSync(launcherPaths(home).record)).toBe(false);
  });

  it('leaves no temp files behind', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    await svc.install(options());
    await svc.install(options({ extensionVersion: '1.3.0' }));
    const all = fs.readdirSync(launcherPaths(home).root, { recursive: true }) as string[];
    expect(all.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('writeFileAtomic', () => {
  it('writes through a uniquely named temp file and renames it into place', () => {
    const target = path.join(home, 'x', 'file.txt');
    const renameSpy = vi.mocked(fs.renameSync);
    renameSpy.mockClear();
    writeFileAtomic(target, 'one');
    writeFileAtomic(target, 'two');
    expect(fs.readFileSync(target, 'utf-8')).toBe('two');
    const temps = renameSpy.mock.calls.map((c) => String(c[0]));
    expect(temps).toHaveLength(2);
    expect(new Set(temps).size).toBe(2);
    for (const t of temps) {
      expect(t.startsWith(`${target}.${process.pid}.`)).toBe(true);
      expect(t.endsWith('.tmp')).toBe(true);
    }
  });

  it('removes its temp file and keeps the old content when the rename fails', () => {
    const target = path.join(home, 'file.txt');
    fs.writeFileSync(target, 'old');
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('EPERM'); });
    expect(() => writeFileAtomic(target, 'new')).toThrow('EPERM');
    expect(fs.readFileSync(target, 'utf-8')).toBe('old');
    expect(fs.readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('refreshIfInstalled', () => {
  it('writes nothing when the launcher was never installed', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    const result = await svc.refreshIfInstalled(options());
    expect(result.outcome).toBe('not-installed');
    expect(fs.existsSync(launcherPaths(home).root)).toBe(false);
  });

  it('does not rewrite when nothing changed', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    await svc.install(options());
    const before = fs.statSync(launcherPaths(home).record).mtimeMs;
    const writeSpy = vi.mocked(fs.writeFileSync);
    writeSpy.mockClear();
    const result = await svc.refreshIfInstalled(options());
    expect(result.outcome).toBe('unchanged');
    expect(writeSpy).not.toHaveBeenCalled();
    expect(fs.statSync(launcherPaths(home).record).mtimeMs).toBe(before);
  });

  it('rewrites for a newer extension version', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    await svc.install(options());
    const result = await svc.refreshIfInstalled(options({ extensionVersion: '1.3.0' }));
    expect(result.outcome).toBe('refreshed');
    expect(readLauncherRecord(home)!.extensionVersion).toBe('1.3.0');
  });

  it('rewrites when the CLI bytes changed at the same version', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    await svc.install(options());
    fs.writeFileSync(cliSource, '// rebuilt\n');
    const result = await svc.refreshIfInstalled(options());
    expect(result.outcome).toBe('refreshed');
    expect(fs.readFileSync(launcherPaths(home).cli, 'utf-8')).toBe('// rebuilt\n');
  });

  it('repairs a launcher whose files were deleted', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    await svc.install(options());
    fs.rmSync(launcherPaths(home).shim);
    expect((await svc.refreshIfInstalled(options())).outcome).toBe('refreshed');
    expect(fs.existsSync(launcherPaths(home).shim)).toBe(true);
  });

  it('never downgrades a launcher written by a newer extension whose runtime still exists', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    await svc.install(options({ extensionVersion: '2.0.0' }));
    const result = await svc.refreshIfInstalled(options({ extensionVersion: '1.9.0', execPath: path.join(home, 'OtherCode') }));
    expect(result.outcome).toBe('skipped-newer');
    expect(readLauncherRecord(home)!.extensionVersion).toBe('2.0.0');
  });

  it('takes over from a newer extension whose runtime no longer exists', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    const gone = path.join(home, 'UninstalledCode');
    await svc.install(options({ extensionVersion: '2.0.0', execPath: gone }));
    const result = await svc.refreshIfInstalled(options({ extensionVersion: '1.9.0' }));
    expect(result.outcome).toBe('refreshed');
    expect(readLauncherRecord(home)!.execPath).toBe(process.execPath);
  });

  it('does not ping-pong between two installs of the same version', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    const other = path.join(home, 'Insiders');
    fs.writeFileSync(other, '');
    await svc.install(options({ execPath: other }));
    expect((await svc.refreshIfInstalled(options())).outcome).toBe('unchanged');
  });

  it('never throws and logs failures', async () => {
    const log = vi.fn();
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified, log });
    await svc.install(options());
    const result = await svc.refreshIfInstalled(options({ extensionVersion: '9.9.9', cliSourcePath: path.join(home, 'missing.js') }));
    expect(result.outcome).toBe('failed');
    expect(log).toHaveBeenCalled();
  });
});

describe('status', () => {
  it('missing → ready → stale', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    expect(svc.status(options())).toBe('missing');
    await svc.install(options());
    expect(svc.status(options())).toBe('ready');
    expect(svc.status(options({ extensionVersion: '1.3.0' }))).toBe('stale');
    fs.writeFileSync(cliSource, '// changed\n');
    expect(svc.status(options())).toBe('stale');
  });

  it('is stale when the recorded runtime is gone, missing when a file is', async () => {
    const svc = new CliLauncherService({ verifyRuntime: alwaysVerified });
    await svc.install(options({ execPath: path.join(home, 'gone') }));
    expect(svc.status(options())).toBe('stale');
    fs.rmSync(launcherPaths(home).cli);
    expect(svc.status(options())).toBe('missing');
  });
});

describe('verifyElectronRuntime', () => {
  it('accepts a runtime that runs a script with ELECTRON_RUN_AS_NODE', async () => {
    expect(await verifyElectronRuntime(process.execPath)).toBe(true);
  });

  it('rejects a path that does not run', async () => {
    expect(await verifyElectronRuntime(path.join(home, 'no-such-binary'))).toBe(false);
  });
});
