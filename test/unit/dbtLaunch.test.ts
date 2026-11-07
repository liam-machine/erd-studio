/**
 * dbtLaunch — Run dbt parse / compile / deps spawn the candidate's own dbt
 * executable with a computed environment. Never an activate line: the
 * Windows bug was `"…\activate.bat" && dbt parse` typed into PowerShell.
 */
import { describe, expect, it } from 'vitest';

import type { DbtCandidate } from '../../src/services/dbtEnv';
import {
  childEnv,
  dbtArgs,
  LOG_ARGS,
  logArgs,
  planDbtSpawn,
  THROWAWAY_MARKER_ENV,
  toTerminalText,
  type DbtCommandKind,
  type DbtRunMode,
  type DbtSpawnPlan,
} from '../../src/services/dbtLaunch';

const posixVenv: DbtCandidate = { executable: '/proj/.venv/bin/dbt', source: 'venv' };
const winVenv: DbtCandidate = { executable: 'C:\\proj\\.venv\\Scripts\\dbt.exe', source: 'venv' };

describe('dbtArgs', () => {
  it('builds each command', () => {
    expect(dbtArgs('parse', 'normal')).toEqual(['parse']);
    expect(dbtArgs('parse', 'noCreds', '/s/p')).toEqual(['parse', '--profiles-dir', '/s/p', '--profile', 'erd_studio', '--target', 'erd_studio']);
    expect(dbtArgs('compile', 'normal')).toEqual(['compile']);
    expect(dbtArgs('deps', 'normal')).toEqual(['deps']);
    expect(dbtArgs('deps', 'noCreds')).toEqual(['deps']);
    expect(dbtArgs('deps', 'noCreds', '/s/p')).toEqual(['deps']);
  });

  it('appends the log flags after the subcommand (and after the profile flags)', () => {
    expect(LOG_ARGS).toEqual(['--log-format', 'text', '--log-level', 'info', '--no-quiet']);
    expect(dbtArgs('parse', 'normal', undefined, LOG_ARGS)).toEqual(['parse', ...LOG_ARGS]);
    expect(dbtArgs('compile', 'normal', undefined, LOG_ARGS)).toEqual(['compile', ...LOG_ARGS]);
    expect(dbtArgs('deps', 'noCreds', '/s/p', LOG_ARGS)).toEqual(['deps', ...LOG_ARGS]);
    expect(dbtArgs('parse', 'noCreds', '/s/p', LOG_ARGS))
      .toEqual(['parse', '--profiles-dir', '/s/p', '--profile', 'erd_studio', '--target', 'erd_studio', ...LOG_ARGS]);
  });

  it('logArgs keeps a debug log level the user asked for (never less output)', () => {
    expect(logArgs({}, 'linux')).toEqual([...LOG_ARGS]);
    expect(logArgs({ DBT_LOG_LEVEL: 'warn' }, 'linux')).toEqual([...LOG_ARGS]);
    expect(logArgs({ DBT_LOG_LEVEL: 'debug' }, 'linux')).toEqual(['--log-format', 'text', '--no-quiet']);
    expect(logArgs({ DBT_ENGINE_LOG_LEVEL: ' DEBUG ' }, 'darwin')).toEqual(['--log-format', 'text', '--no-quiet']);
    expect(logArgs({ dbt_log_level: 'debug' }, 'win32')).toEqual(['--log-format', 'text', '--no-quiet']);
    expect(logArgs({ dbt_log_level: 'debug' }, 'linux')).toEqual([...LOG_ARGS]);
  });

  it('refuses noCreds without a dir, and noCreds compile', () => {
    expect(() => dbtArgs('parse', 'noCreds')).toThrow();
    expect(() => dbtArgs('compile', 'noCreds', '/s/p')).toThrow();
  });
});

describe('childEnv', () => {
  it('posix venv: bin dir first on PATH, VIRTUAL_ENV, no PYTHONHOME', () => {
    const env = childEnv(posixVenv, 'normal', { PATH: '/usr/bin:/bin', PYTHONHOME: '/x', HOME: '/home/u', UNSET: undefined }, 'linux');
    expect(env.PATH).toBe('/proj/.venv/bin:/usr/bin:/bin');
    expect(env.VIRTUAL_ENV).toBe('/proj/.venv');
    expect(env.PYTHONHOME).toBeUndefined();
    expect(env.HOME).toBe('/home/u');
    expect('UNSET' in env).toBe(false);
    expect(env.PYTHONUNBUFFERED).toBe('1');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
    expect(env.NoDefaultCurrentDirectoryInExePath).toBeUndefined();
  });

  it('does not repeat a bin dir already first on PATH', () => {
    expect(childEnv(posixVenv, 'normal', { PATH: '/proj/.venv/bin:/usr/bin' }, 'darwin').PATH).toBe('/proj/.venv/bin:/usr/bin');
  });

  it('a venv executable not under bin / Scripts sets no VIRTUAL_ENV', () => {
    const env = childEnv({ executable: '/opt/tools/dbt', source: 'virtual-env' }, 'normal', { PATH: '/usr/bin' }, 'linux');
    expect(env.PATH).toBe('/opt/tools:/usr/bin');
    expect(env.VIRTUAL_ENV).toBeUndefined();
    const win = childEnv({ executable: 'C:\\tools\\dbt.exe', source: 'venv' }, 'normal', { Path: 'C:\\Windows' }, 'win32');
    expect(win.VIRTUAL_ENV).toBeUndefined();
  });

  it('win32 venv updates the existing Path key in place (no duplicate PATH)', () => {
    const env = childEnv(winVenv, 'normal', { Path: 'C:\\Windows;C:\\Windows\\System32', pythonhome: 'C:\\py' }, 'win32');
    expect(env.Path).toBe('C:\\proj\\.venv\\Scripts;C:\\Windows;C:\\Windows\\System32');
    expect(env.PATH).toBeUndefined();
    expect(env.VIRTUAL_ENV).toBe('C:\\proj\\.venv');
    expect(env.pythonhome).toBeUndefined();
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1');
  });

  it('win32 with no PATH key adds PATH', () => {
    expect(childEnv(winVenv, 'normal', {}, 'win32').PATH).toBe('C:\\proj\\.venv\\Scripts');
  });

  it('conda on win32 prepends conda\'s activation dirs in order', () => {
    const env = childEnv(
      { executable: 'C:\\conda\\envs\\d\\Scripts\\dbt.exe', source: 'conda' }, 'normal',
      { Path: 'C:\\Windows', CONDA_PREFIX: 'C:\\conda\\envs\\d' }, 'win32',
    );
    expect(env.Path.split(';')).toEqual([
      'C:\\conda\\envs\\d',
      'C:\\conda\\envs\\d\\Library\\mingw-w64\\bin',
      'C:\\conda\\envs\\d\\Library\\usr\\bin',
      'C:\\conda\\envs\\d\\Library\\bin',
      'C:\\conda\\envs\\d\\Scripts',
      'C:\\conda\\envs\\d\\bin',
      'C:\\Windows',
    ]);
    const posix = childEnv({ executable: '/c/envs/d/bin/dbt', source: 'conda' }, 'normal', { PATH: '/usr/bin', CONDA_PREFIX: '/c/envs/d' }, 'linux');
    expect(posix.PATH).toBe('/c/envs/d/bin:/usr/bin');
  });

  it('path and shim candidates leave PATH as it is', () => {
    for (const source of ['path', 'shim', 'override'] as const) {
      const env = childEnv({ executable: '/usr/local/bin/dbt', source }, 'normal', { PATH: '/usr/bin', PYTHONHOME: '/py' }, 'linux');
      expect(env.PATH, source).toBe('/usr/bin');
      expect(env.PYTHONHOME, source).toBe('/py');
      expect(env.VIRTUAL_ENV, source).toBeUndefined();
    }
  });

  it('drops the log-format and project-dir overrides in both modes', () => {
    const inherited = { DBT_LOG_FORMAT: 'json', DBT_ENGINE_LOG_FORMAT: 'json', DBT_PROJECT_DIR: '/x', DBT_ENGINE_PROJECT_DIR: '/x', DBT_TARGET_PATH: 'out', DBT_USE_COLORS: 'true' };
    for (const mode of ['normal', 'noCreds'] as const) {
      const env = childEnv(posixVenv, mode, inherited, 'linux');
      expect(env.DBT_LOG_FORMAT).toBeUndefined();
      expect(env.DBT_ENGINE_LOG_FORMAT).toBeUndefined();
      expect(env.DBT_PROJECT_DIR).toBeUndefined();
      expect(env.DBT_ENGINE_PROJECT_DIR).toBeUndefined();
      expect(env.DBT_TARGET_PATH).toBe('out');
      expect(env.DBT_USE_COLORS).toBe('true');
    }
  });

  it('drops a log level of none (it prints nothing, so a failure has no cause), and keeps every other level', () => {
    for (const mode of ['normal', 'noCreds'] as const) {
      const silenced = childEnv(posixVenv, mode, { DBT_LOG_LEVEL: ' None ', DBT_ENGINE_LOG_LEVEL: 'none' }, 'linux');
      expect(silenced.DBT_LOG_LEVEL).toBeUndefined();
      expect(silenced.DBT_ENGINE_LOG_LEVEL).toBeUndefined();
      const kept = childEnv(posixVenv, mode, { DBT_LOG_LEVEL: 'error', DBT_ENGINE_LOG_LEVEL: 'warn', DBT_QUIET: 'true' }, 'linux');
      expect(kept).toMatchObject({ DBT_LOG_LEVEL: 'error', DBT_ENGINE_LOG_LEVEL: 'warn', DBT_QUIET: 'true' });
    }
    // Windows keys are case-insensitive.
    expect(childEnv(winVenv, 'normal', { dbt_log_level: 'NONE' }, 'win32').dbt_log_level).toBeUndefined();
  });

  it('normal mode removes an inherited placeholder marker and keeps the user\'s profile settings', () => {
    const env = childEnv(posixVenv, 'normal', { [THROWAWAY_MARKER_ENV]: '1', DBT_PROFILES_DIR: '/p', DATABRICKS_HOST: 'h', DBT_SEND_ANONYMOUS_USAGE_STATS: 'true' }, 'linux');
    expect(env[THROWAWAY_MARKER_ENV]).toBeUndefined();
    expect(env.DBT_PROFILES_DIR).toBe('/p');
    expect(env.DATABRICKS_HOST).toBe('h');
    expect(env.DBT_SEND_ANONYMOUS_USAGE_STATS).toBe('true');
  });

  it('noCreds mode marks the run, turns usage stats off and strips Databricks and profile overrides', () => {
    const env = childEnv(winVenv, 'noCreds', {
      Path: 'C:\\Windows', DATABRICKS_HOST: 'h', databricks_token: 't', Databricks_Config_Profile: 'p',
      DBT_PROFILES_DIR: 'C:\\p', DBT_TARGET: 'prod', DBT_PROFILE: 'x', DBT_ENGINE_PROFILES_DIR: 'C:\\q', dbt_engine_target: 'y',
    }, 'win32');
    expect(env[THROWAWAY_MARKER_ENV]).toBe('1');
    expect(env.DBT_SEND_ANONYMOUS_USAGE_STATS).toBe('false');
    for (const k of Object.keys(env)) {
      expect(k.toUpperCase()).not.toMatch(/^DATABRICKS_|^DBT_(ENGINE_)?(PROFILES_DIR|PROFILE|TARGET)$/);
    }
  });
});

describe('planDbtSpawn', () => {
  it('Windows venv runs the venv\'s own Scripts\\dbt.exe, no shell, no activate line', () => {
    const plan = planDbtSpawn(winVenv, 'parse', 'normal', { root: 'C:\\proj', env: { Path: 'C:\\Windows' }, platform: 'win32' }) as DbtSpawnPlan;
    expect(plan.file).toBe('C:\\proj\\.venv\\Scripts\\dbt.exe');
    expect(plan.shell).toBe(false);
    expect(plan.args).toEqual(['parse']);
    expect(plan.cwd).toBe('C:\\proj');
    expect(plan.display).toBe('.venv/Scripts/dbt.exe parse');
  });

  it('logFlags adds the log flags to the args and the header; without it nothing is added', () => {
    const plan = planDbtSpawn(posixVenv, 'parse', 'normal', { root: '/proj', env: {}, platform: 'darwin', logFlags: true }) as DbtSpawnPlan;
    expect(plan.args).toEqual(['parse', ...LOG_ARGS]);
    expect(plan.display).toBe('.venv/bin/dbt parse --log-format text --log-level info --no-quiet');
    const deps = planDbtSpawn(posixVenv, 'deps', 'normal', { root: '/proj', env: { DBT_LOG_LEVEL: 'debug' }, platform: 'darwin', logFlags: true }) as DbtSpawnPlan;
    expect(deps.args).toEqual(['deps', '--log-format', 'text', '--no-quiet']);
    expect((planDbtSpawn(posixVenv, 'compile', 'normal', { root: '/proj', env: {}, platform: 'darwin' }) as DbtSpawnPlan).args).toEqual(['compile']);
  });

  it('noCreds parse carries the profile flags and shows the profiles dir', () => {
    const plan = planDbtSpawn(posixVenv, 'parse', 'noCreds', { root: '/proj', profilesDir: '/s/dbt-parse-profile/duckdb', env: {}, platform: 'darwin' }) as DbtSpawnPlan;
    expect(plan.args).toEqual(['parse', '--profiles-dir', '/s/dbt-parse-profile/duckdb', '--profile', 'erd_studio', '--target', 'erd_studio']);
    expect(plan.env[THROWAWAY_MARKER_ENV]).toBe('1');
    expect(plan.display).toBe('.venv/bin/dbt parse --profiles-dir /s/dbt-parse-profile/duckdb --profile erd_studio --target erd_studio');
  });

  it('a shim is spawned through cmd.exe quoted, and refused when a path holds %', () => {
    const shim: DbtCandidate = { executable: 'C:\\Users\\J S\\.pyenv\\pyenv-win\\shims\\dbt.bat', source: 'shim' };
    const plan = planDbtSpawn(shim, 'parse', 'noCreds', { root: 'C:\\p', profilesDir: 'C:\\Users\\J S\\AppData\\x', env: {}, platform: 'win32' }) as DbtSpawnPlan;
    expect(plan.shell).toBe(true);
    expect(plan.file).toBe('"C:\\Users\\J S\\.pyenv\\pyenv-win\\shims\\dbt.bat"');
    expect(plan.args[2]).toBe('"C:\\Users\\J S\\AppData\\x"');
    expect(planDbtSpawn(shim, 'parse', 'noCreds', { root: 'C:\\p', profilesDir: 'C:\\%APPDATA%\\x', env: {}, platform: 'win32' }))
      .toEqual({ refused: 'unquotable' });
  });

  it('never runs an activate script, source, call or && (every source × platform × kind × mode)', () => {
    const roots = { linux: '/home/u/source/repos/proj', win32: 'C:\\Users\\x\\source\\repos\\proj' } as const;
    const candidates = (platform: 'linux' | 'win32'): DbtCandidate[] => {
      const root = roots[platform];
      return platform === 'win32'
        ? [
          { executable: `${root}\\.venv\\Scripts\\dbt.exe`, source: 'venv' },
          { executable: 'C:\\envs\\v\\Scripts\\dbt.exe', source: 'virtual-env' },
          { executable: 'C:\\conda\\Scripts\\dbt.exe', source: 'conda' },
          { executable: 'C:\\Python\\Scripts\\dbt.exe', source: 'path', onPath: true },
          { executable: 'C:\\Users\\x\\.pyenv\\pyenv-win\\shims\\dbt.bat', source: 'shim' },
          { executable: 'C:\\tools\\dbt.exe', source: 'override' },
        ]
        : [
          { executable: `${root}/.venv/bin/dbt`, source: 'venv' },
          { executable: '/envs/v/bin/dbt', source: 'virtual-env' },
          { executable: '/conda/bin/dbt', source: 'conda' },
          { executable: '/usr/local/bin/dbt', source: 'path', onPath: true },
          { executable: '/home/u/.pyenv/shims/dbt', source: 'shim' },
          { executable: '/opt/dbt', source: 'override' },
        ];
    };
    const runs: Array<[DbtCommandKind, DbtRunMode]> = [['parse', 'normal'], ['parse', 'noCreds'], ['compile', 'normal'], ['deps', 'normal'], ['deps', 'noCreds']];
    for (const platform of ['linux', 'win32'] as const) {
      for (const candidate of candidates(platform)) {
        for (const [kind, mode] of runs) {
          const plan = planDbtSpawn(candidate, kind, mode, {
            root: roots[platform], profilesDir: platform === 'win32' ? 'C:\\Users\\x\\AppData\\s' : '/home/u/.config/s', env: { CONDA_PREFIX: '/conda' }, platform,
          }) as DbtSpawnPlan;
          const label = `${platform} ${candidate.source} ${kind} ${mode}`;
          const exe = candidate.executable;
          expect(plan.file === exe || plan.file === `"${exe}"`, label).toBe(true);
          expect(plan.args[0], label).toBe(kind);
          for (const a of plan.args) {
            expect(['&&', 'source', 'call'], label).not.toContain(a);
            expect(a, label).not.toMatch(/(activate|activate\.bat|Activate\.ps1)"?$/);
          }
          const tokens = plan.display.split(/\s+/);
          expect(tokens, label).not.toContain('&&');
          for (const t of tokens) expect(t, label).not.toMatch(/activate/i);
        }
      }
    }
  });
});

describe('toTerminalText', () => {
  it('turns every line feed into CRLF', () => {
    expect(toTerminalText('a\nb\r\nc\n')).toBe('a\r\nb\r\nc\r\n');
    expect(toTerminalText('no newline')).toBe('no newline');
  });
});
