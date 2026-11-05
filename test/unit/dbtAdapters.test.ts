/**
 * dbtAdapters — Parse without your credentials: the placeholder profiles
 * (verified on real dbt), which adapters a dbt install has (by stat, without
 * running dbt), which one a project uses, and whether dbt would find a
 * profiles.yml (by stat, never read).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  ADAPTER_LABELS,
  adapterHintsFromText,
  adapterTypeFromManifestStart,
  chooseThrowawayAdapter,
  coreInstallOf,
  NO_CREDS_ADAPTER_FEATURES,
  nodeInstallFs,
  pluginsFromVersionOutput,
  profilesYmlWouldBeFound,
  REQUIREMENTS_FILES,
  THROWAWAY_ADAPTERS,
  THROWAWAY_OUTPUTS,
  throwawayProfileYaml,
  type InstallFs,
} from '../../src/services/dbtAdapters';
import { VERSION_C18_SQLSERVER, VERSION_DBT_DATABRICKS } from './dbtOutputFixtures';

/** The prototype's verified profiles (`profiles/rec_*` and `rec18_*`, identical). */
const VERIFIED: Record<string, Record<string, string | number>> = {
  duckdb: { type: 'duckdb', path: ':memory:' },
  postgres: { type: 'postgres', host: 'erd-studio-placeholder.invalid', port: 5432, user: 'erd_studio_placeholder', password: 'erd-studio-placeholder', dbname: 'erd_studio_placeholder', schema: 'erd_studio_placeholder' },
  redshift: { type: 'redshift', host: 'erd-studio-placeholder.invalid', port: 5439, user: 'erd_studio_placeholder', password: 'erd-studio-placeholder', dbname: 'erd_studio_placeholder', schema: 'erd_studio_placeholder' },
  snowflake: { type: 'snowflake', account: 'erd-studio-placeholder', user: 'erd_studio_placeholder', password: 'erd-studio-placeholder', database: 'ERD_STUDIO_PLACEHOLDER', schema: 'ERD_STUDIO_PLACEHOLDER' },
  databricks: { type: 'databricks', host: 'erd-studio-placeholder.cloud.databricks.com', http_path: '/sql/1.0/warehouses/erd-studio-placeholder', token: 'erd-studio-placeholder', schema: 'erd_studio_placeholder' },
  bigquery: { type: 'bigquery', method: 'oauth', project: 'erd-studio-placeholder', dataset: 'erd_studio_placeholder' },
  fabric: { type: 'fabric', driver: 'ODBC Driver 18 for SQL Server', server: 'erd-studio-placeholder.invalid', port: 1433, database: 'erd_studio_placeholder', schema: 'erd_studio_placeholder', authentication: 'CLI' },
  sqlserver: { type: 'sqlserver', driver: 'ODBC Driver 18 for SQL Server', server: 'erd-studio-placeholder.invalid', port: 1433, database: 'erd_studio_placeholder', schema: 'erd_studio_placeholder', user: 'erd_studio_placeholder', password: 'erd-studio-placeholder' },
  trino: { type: 'trino', method: 'none', host: 'erd-studio-placeholder.invalid', port: 443, user: 'erd_studio_placeholder', database: 'erd_studio_placeholder', schema: 'erd_studio_placeholder' },
  spark: { type: 'spark', method: 'thrift', host: 'erd-studio-placeholder.invalid', port: 10001, schema: 'erd_studio_placeholder' },
};
/** Values that are fixed product settings rather than placeholders. */
const FIXED_VALUES = new Set([':memory:', 'oauth', 'ODBC Driver 18 for SQL Server', 'CLI', 'none', 'thrift', ...THROWAWAY_ADAPTERS]);

describe('throwawayProfileYaml', () => {
  for (const adapter of THROWAWAY_ADAPTERS) {
    it(`${adapter}: parses to the verified profile`, () => {
      const text = throwawayProfileYaml(adapter);
      expect(text.startsWith('# Written by ERD Studio for "Parse without your credentials". Placeholder values only: nothing here connects anywhere.\n')).toBe(true);
      const doc = parseYaml(text);
      expect(doc).toEqual({ erd_studio: { target: 'erd_studio', outputs: { erd_studio: VERIFIED[adapter] } } });
      const output = doc.erd_studio.outputs.erd_studio as Record<string, unknown>;
      expect(Object.keys(output)).toEqual(THROWAWAY_OUTPUTS[adapter].map(([k]) => k));
      for (const [key, value] of Object.entries(output)) {
        if (key === 'port') { expect(typeof value).toBe('number'); continue; }
        if (FIXED_VALUES.has(String(value))) continue;
        expect(String(value), `${adapter}.${key}`).toMatch(/erd-studio-placeholder|erd_studio_placeholder|ERD_STUDIO_PLACEHOLDER/);
      }
    });
  }

  it('databricks has a token and sqlserver a database', () => {
    expect(parseYaml(throwawayProfileYaml('databricks')).erd_studio.outputs.erd_studio.token).toBeTruthy();
    expect(parseYaml(throwawayProfileYaml('sqlserver')).erd_studio.outputs.erd_studio.database).toBeTruthy();
  });

  it('labels and telemetry keys cover every adapter', () => {
    expect(Object.keys(ADAPTER_LABELS).sort()).toEqual([...THROWAWAY_ADAPTERS].sort());
    expect(Object.keys(NO_CREDS_ADAPTER_FEATURES)).toEqual([...THROWAWAY_ADAPTERS]);
  });
});

describe('pluginsFromVersionOutput', () => {
  it('reads the Plugins block of real dbt --version output', () => {
    expect(VERSION_DBT_DATABRICKS).toContain('WARNING:thrift');
    expect(pluginsFromVersionOutput(VERSION_DBT_DATABRICKS)).toEqual(['databricks', 'spark']);
    expect(pluginsFromVersionOutput(VERSION_C18_SQLSERVER)).toEqual([]);
    expect(pluginsFromVersionOutput('dbt Cloud CLI - 0.40.14\n')).toEqual([]);
  });
});

/** A fake file system: `files` maps a path to its first bytes and size; `dirs` lists folders and their entries. */
function fakeFs(opts: { links?: Record<string, string>; files: Record<string, { start?: string; size?: number }>; dirs: Record<string, string[]> }): InstallFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    realpath: (p) => opts.links?.[p] ?? p,
    readdir: (p) => { if (!opts.dirs[p]) throw new Error('ENOENT'); return opts.dirs[p]; },
    isDir: (p) => p in opts.dirs,
    isFile: (p) => p in opts.files,
    size: (p) => { if (!opts.files[p]) throw new Error('ENOENT'); return opts.files[p].size ?? 0; },
    readStart: (p, n) => { reads.push(p); if (!opts.files[p]) throw new Error('ENOENT'); return new TextEncoder().encode((opts.files[p].start ?? '').slice(0, n)); },
  };
}

function posixInstall(prefix: string, exeStart = '#!/usr/bin/env python3', withCore = true): ReturnType<typeof fakeFs> {
  const sp = `${prefix}/lib/python3.12/site-packages`;
  return fakeFs({
    files: {
      [`${prefix}/bin/dbt`]: { start: exeStart },
      ...(withCore ? { [`${sp}/dbt/cli/main.py`]: {} } : {}),
    },
    dirs: {
      [`${prefix}/lib`]: ['python3.12'],
      [`${sp}/dbt/include`]: ['__init__.py', '__pycache__', 'global_project', 'starter_project', 'snowflake', 'duckdb', '_private', '.hidden', 'README.md'],
      [`${sp}/dbt/include/global_project`]: [],
      [`${sp}/dbt/include/starter_project`]: [],
      [`${sp}/dbt/include/__pycache__`]: [],
      [`${sp}/dbt/include/snowflake`]: [],
      [`${sp}/dbt/include/duckdb`]: [],
      [`${sp}/dbt/include/_private`]: [],
      [`${sp}/dbt/include/.hidden`]: [],
    },
  });
}

describe('coreInstallOf', () => {
  it('posix venv: dbt/cli/main.py, global_project and a #! script give the adapters', () => {
    expect(coreInstallOf('/proj/.venv/bin/dbt', 'darwin', posixInstall('/proj/.venv'))).toEqual({ adapters: ['duckdb', 'snowflake'] });
  });

  it('follows a pipx symlink', () => {
    const f = posixInstall('/home/u/.local/pipx/venvs/dbt-core');
    const linked: InstallFs = { ...f, realpath: (p) => (p === '/home/u/.local/bin/dbt' ? '/home/u/.local/pipx/venvs/dbt-core/bin/dbt' : p) };
    expect(coreInstallOf('/home/u/.local/bin/dbt', 'linux', linked)).toEqual({ adapters: ['duckdb', 'snowflake'] });
  });

  it('global_project without dbt/cli/main.py (dbt-adapters alone) is not dbt Core', () => {
    expect(coreInstallOf('/proj/.venv/bin/dbt', 'darwin', posixInstall('/proj/.venv', '#!/x', false))).toBeNull();
  });

  it('a binary (no #!) is not called dbt Core even with dbt-core beside it', () => {
    expect(coreInstallOf('/proj/.venv/bin/dbt', 'darwin', posixInstall('/proj/.venv', '\u00cf\u00fa\u00ed\u00fe'))).toBeNull();
  });

  it('a pyenv shim (not in bin) goes to the --version probe', () => {
    const f = posixInstall('/home/u/.pyenv');
    expect(coreInstallOf('/home/u/.pyenv/shims/dbt', 'linux', f)).toBeNull();
  });

  it('win32: Lib\\site-packages and a small Scripts\\dbt.exe', () => {
    const sp = 'C:\\proj\\.venv\\Lib\\site-packages';
    const win = (size: number) => fakeFs({
      files: { 'C:\\proj\\.venv\\Scripts\\dbt.exe': { size }, [`${sp}\\dbt\\cli\\main.py`]: {} },
      dirs: {
        [`${sp}\\dbt\\include`]: ['global_project', 'fabric', 'sqlserver'],
        [`${sp}\\dbt\\include\\global_project`]: [],
        [`${sp}\\dbt\\include\\fabric`]: [],
        [`${sp}\\dbt\\include\\sqlserver`]: [],
      },
    });
    expect(coreInstallOf('C:\\proj\\.venv\\Scripts\\dbt.exe', 'win32', win(200 * 1024))).toEqual({ adapters: ['fabric', 'sqlserver'] });
    expect(coreInstallOf('C:\\proj\\.venv\\Scripts\\dbt.exe', 'win32', win(40 * 1024 * 1024))).toBeNull();
  });

  it('never throws', () => {
    const broken: InstallFs = { ...posixInstall('/x'), realpath: () => { throw new Error('EACCES'); } };
    expect(coreInstallOf('/x/bin/dbt', 'linux', broken)).toBeNull();
  });
});

describe('chooseThrowawayAdapter', () => {
  const none = { manifest: null, files: [] };
  it('one supported adapter', () => {
    expect(chooseThrowawayAdapter(['snowflake'], none)).toEqual({ kind: 'one', adapter: 'snowflake' });
  });
  it('drops an adapter installed as another\'s dependency', () => {
    expect(chooseThrowawayAdapter(['databricks', 'spark'], none)).toEqual({ kind: 'one', adapter: 'databricks' });
    expect(chooseThrowawayAdapter(['postgres', 'redshift'], none)).toEqual({ kind: 'one', adapter: 'redshift' });
    expect(chooseThrowawayAdapter(['fabric', 'sqlserver'], none)).toEqual({ kind: 'one', adapter: 'sqlserver' });
    expect(chooseThrowawayAdapter(['fabric', 'synapse'], none)).toEqual({ kind: 'none', unsupportedInstalled: true });
    expect(chooseThrowawayAdapter(['glue', 'spark'], none)).toEqual({ kind: 'none', unsupportedInstalled: true });
    expect(chooseThrowawayAdapter(['materialize', 'postgres'], none)).toEqual({ kind: 'none', unsupportedInstalled: true });
  });
  it('keeps the child when the project names it alone', () => {
    expect(chooseThrowawayAdapter(['databricks', 'spark'], { manifest: null, files: ['spark'] })).toEqual({ kind: 'one', adapter: 'spark' });
    expect(chooseThrowawayAdapter(['databricks', 'spark'], { manifest: null, files: ['spark', 'databricks'] })).toEqual({ kind: 'one', adapter: 'databricks' });
  });
  it('the manifest hint wins, then a file hint narrows', () => {
    expect(chooseThrowawayAdapter(['duckdb', 'snowflake'], { manifest: 'snowflake', files: ['duckdb'] })).toEqual({ kind: 'one', adapter: 'snowflake' });
    expect(chooseThrowawayAdapter(['duckdb', 'snowflake'], { manifest: 'oracle', files: ['duckdb'] })).toEqual({ kind: 'one', adapter: 'duckdb' });
  });
  it('asks, sorted by label', () => {
    expect(chooseThrowawayAdapter(['trino', 'snowflake', 'bigquery'], none)).toEqual({ kind: 'ask', options: ['bigquery', 'snowflake', 'trino'] });
    expect(chooseThrowawayAdapter(['trino', 'snowflake', 'bigquery'], { manifest: null, files: ['trino', 'snowflake'] }))
      .toEqual({ kind: 'ask', options: ['snowflake', 'trino'] });
  });
  it('none', () => {
    expect(chooseThrowawayAdapter([], none)).toEqual({ kind: 'none', unsupportedInstalled: false });
    expect(chooseThrowawayAdapter(['oracle'], none)).toEqual({ kind: 'none', unsupportedInstalled: true });
  });
});

describe('hints', () => {
  it('adapterHintsFromText', () => {
    expect(adapterHintsFromText('dbt-core==1.10\ndbt-Snowflake>=1.9\ndbt-snowflake\n# dbt-duckdb\ndbt-oracle\nmydbt-trinox')).toEqual(['snowflake', 'duckdb']);
    expect(adapterHintsFromText('[tool.poetry.dependencies]\n"dbt-databricks" = "^1.8"')).toEqual(['databricks']);
  });
  it('adapterTypeFromManifestStart', () => {
    expect(adapterTypeFromManifestStart('{"metadata": {"dbt_schema_version": "x", "adapter_type": "snowflake", "env": {}}')).toBe('snowflake');
    expect(adapterTypeFromManifestStart('{"metadata": {}')).toBeNull();
  });
  it('REQUIREMENTS_FILES never names a profiles.yml', () => {
    expect(REQUIREMENTS_FILES.some((f) => /profiles/i.test(f))).toBe(false);
  });
});

describe('profilesYmlWouldBeFound (stat only)', () => {
  const statted: string[] = [];
  const isFile = (files: string[]) => (p: string) => { statted.push(p); return files.includes(p); };
  it('an env profiles dir is the only place looked', () => {
    expect(profilesYmlWouldBeFound('/proj', { env: { DBT_PROFILES_DIR: '/p' }, homeDir: '/home/u', isFile: isFile(['/home/u/.dbt/profiles.yml']) })).toBe(false);
    expect(profilesYmlWouldBeFound('/proj', { env: { DBT_ENGINE_PROFILES_DIR: 'conf' }, homeDir: '/home/u', isFile: isFile(['/proj/conf/profiles.yml']) })).toBe(true);
  });
  it('the project root, then ~/.dbt', () => {
    expect(profilesYmlWouldBeFound('/proj', { env: {}, homeDir: '/home/u', isFile: isFile(['/proj/profiles.yml']) })).toBe(true);
    expect(profilesYmlWouldBeFound('/proj', { env: {}, homeDir: '/home/u', isFile: isFile(['/home/u/.dbt/profiles.yml']) })).toBe(true);
    expect(profilesYmlWouldBeFound('/proj', { env: { DBT_PROFILES_DIR: '  ' }, homeDir: '/home/u', isFile: isFile([]) })).toBe(false);
  });
  it('only ever stats: no read function is called on a real profiles.yml', () => {
    expect(statted.every((p) => p.endsWith('profiles.yml'))).toBe(true);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-profiles-'));
    try {
      fs.writeFileSync(path.join(tmp, 'profiles.yml'), 'secret: 1\n');
      const readStart = vi.spyOn(nodeInstallFs, 'readStart');
      const readdir = vi.spyOn(nodeInstallFs, 'readdir');
      const isFileSpy = vi.spyOn(nodeInstallFs, 'isFile');
      expect(profilesYmlWouldBeFound(tmp, { env: {}, homeDir: tmp })).toBe(true);
      expect(isFileSpy).toHaveBeenCalled();
      expect(readStart).not.toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
