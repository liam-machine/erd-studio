/**
 * dbtAdapters — Parse without your credentials: which dbt adapters it
 * supports, the placeholder `profiles.yml` for each, which adapters a dbt
 * install has, and which one a project uses.
 *
 * The placeholder outputs were verified offline (network blocked, an empty
 * HOME) on dbt-core 1.10.23 for all ten adapters and on 1.8.10 for eight
 * (1.8 Fabric and SQL Server could not import pyodbc on a Mac without
 * unixODBC, which classifies as `adapterDeps`). Every value is a placeholder:
 * nothing here connects anywhere.
 *
 * **Never reads a profiles.yml.** `profilesYmlWouldBeFound` checks that one
 * exists (a stat), the hints read only requirements files and the start of
 * manifest.json. `findProfiles` (dbtEnv.ts, which parses the file for the
 * CLI's `doctor`) is not used here.
 *
 * vscode-free; the only file access is `coreInstallOf`'s injectable `InstallFs`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { stripAnsi } from './dbtEnv';
import { THROWAWAY_PROFILE_NAME, THROWAWAY_TARGET_NAME } from './dbtLaunch';
import type { TelemetryFeature } from './telemetryPayload';

export const THROWAWAY_ADAPTERS = [
  'duckdb', 'postgres', 'redshift', 'snowflake', 'databricks', 'bigquery', 'fabric', 'sqlserver', 'trino', 'spark',
] as const;
export type ThrowawayAdapter = (typeof THROWAWAY_ADAPTERS)[number];

export const ADAPTER_LABELS: Record<ThrowawayAdapter, string> = {
  duckdb: 'DuckDB',
  postgres: 'Postgres',
  redshift: 'Redshift',
  snowflake: 'Snowflake',
  databricks: 'Databricks',
  bigquery: 'BigQuery',
  fabric: 'Microsoft Fabric',
  sqlserver: 'SQL Server',
  trino: 'Trino',
  spark: 'Spark',
};

/** Which placeholder adapter a Parse without your credentials run used (a fixed product name). */
export const NO_CREDS_ADAPTER_FEATURES: Record<ThrowawayAdapter, TelemetryFeature> = {
  duckdb: 'dbtNoCredsDuckdb',
  postgres: 'dbtNoCredsPostgres',
  redshift: 'dbtNoCredsRedshift',
  snowflake: 'dbtNoCredsSnowflake',
  databricks: 'dbtNoCredsDatabricks',
  bigquery: 'dbtNoCredsBigquery',
  fabric: 'dbtNoCredsFabric',
  sqlserver: 'dbtNoCredsSqlserver',
  trino: 'dbtNoCredsTrino',
  spark: 'dbtNoCredsSpark',
};

const PH = 'erd_studio_placeholder';
const PH_DASH = 'erd-studio-placeholder';
const PH_HOST = 'erd-studio-placeholder.invalid';

/** The verified placeholder outputs. Order is the YAML key order. */
export const THROWAWAY_OUTPUTS: Record<ThrowawayAdapter, ReadonlyArray<readonly [string, string | number]>> = {
  duckdb: [['type', 'duckdb'], ['path', ':memory:']],
  postgres: [
    ['type', 'postgres'], ['host', PH_HOST], ['port', 5432], ['user', PH], ['password', PH_DASH], ['dbname', PH], ['schema', PH],
  ],
  redshift: [
    ['type', 'redshift'], ['host', PH_HOST], ['port', 5439], ['user', PH], ['password', PH_DASH], ['dbname', PH], ['schema', PH],
  ],
  snowflake: [
    ['type', 'snowflake'], ['account', PH_DASH], ['user', PH], ['password', PH_DASH],
    ['database', 'ERD_STUDIO_PLACEHOLDER'], ['schema', 'ERD_STUDIO_PLACEHOLDER'],
  ],
  // `token` is essential: without it the Databricks SDK falls back to browser auth and hangs.
  databricks: [
    ['type', 'databricks'], ['host', 'erd-studio-placeholder.cloud.databricks.com'],
    ['http_path', '/sql/1.0/warehouses/erd-studio-placeholder'], ['token', PH_DASH], ['schema', PH],
  ],
  bigquery: [['type', 'bigquery'], ['method', 'oauth'], ['project', PH_DASH], ['dataset', PH]],
  fabric: [
    ['type', 'fabric'], ['driver', 'ODBC Driver 18 for SQL Server'], ['server', PH_HOST], ['port', 1433],
    ['database', PH], ['schema', PH], ['authentication', 'CLI'],
  ],
  // `database` is required, or the manifest gets the string "None".
  sqlserver: [
    ['type', 'sqlserver'], ['driver', 'ODBC Driver 18 for SQL Server'], ['server', PH_HOST], ['port', 1433],
    ['database', PH], ['schema', PH], ['user', PH], ['password', PH_DASH],
  ],
  trino: [
    ['type', 'trino'], ['method', 'none'], ['host', PH_HOST], ['port', 443], ['user', PH], ['database', PH], ['schema', PH],
  ],
  spark: [['type', 'spark'], ['method', 'thrift'], ['host', PH_HOST], ['port', 10001], ['schema', PH]],
};

/** The whole placeholder profiles.yml for `adapter`. Strings are JSON-quoted (valid YAML), numbers bare. */
export function throwawayProfileYaml(adapter: ThrowawayAdapter): string {
  const lines = [
    '# Written by ERD Studio for "Parse without your credentials". Placeholder values only: nothing here connects anywhere.',
    `${THROWAWAY_PROFILE_NAME}:`,
    `  target: ${THROWAWAY_TARGET_NAME}`,
    '  outputs:',
    `    ${THROWAWAY_TARGET_NAME}:`,
    ...THROWAWAY_OUTPUTS[adapter].map(([k, v]) => `      ${k}: ${typeof v === 'number' ? String(v) : JSON.stringify(v)}`),
  ];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Installed adapters
// ---------------------------------------------------------------------------

/** The file access `coreInstallOf` needs (sync; `readStart` is only ever called on the executable). */
export interface InstallFs {
  realpath(p: string): string;
  readdir(p: string): string[];
  isDir(p: string): boolean;
  isFile(p: string): boolean;
  size(p: string): number;
  readStart(p: string, bytes: number): Uint8Array;
}

export const nodeInstallFs: InstallFs = {
  realpath: (p) => fs.realpathSync(p),
  readdir: (p) => fs.readdirSync(p),
  isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
  size: (p) => fs.statSync(p).size,
  readStart: (p, bytes) => {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  },
};

/** A pip / uv console-script launcher is ~100–600 KB; the Go Cloud CLI and the Rust Fusion binary are tens of MB. */
const MAX_WIN_LAUNCHER_BYTES = 4 * 1024 * 1024;
const NOT_ADAPTERS = new Set(['global_project', 'starter_project', '__pycache__']);

/**
 * dbt Core found by stat alone (never runs anything, never throws; null when
 * this cannot be told without running `dbt --version`):
 *
 * 1. the executable's real path (pipx symlinks resolved) is in a `bin` dir
 *    (`Scripts` on Windows) whose parent is the environment prefix;
 * 2. it is a Python console script: it starts with `#!` (POSIX), or is under
 *    4 MiB (Windows), so a Fusion or Cloud CLI binary never passes;
 * 3. a site-packages beside it (`Lib\site-packages`; `lib/python3.*\/site-packages`)
 *    holds dbt-core's own `dbt/cli/main.py` **and** `dbt/include/global_project`
 *    (that one ships in dbt-adapters, so alone it does not prove dbt Core).
 *
 * The adapters are the folders of `dbt/include` other than dbt's own, sorted;
 * this also finds an adapter `--version` hides (one whose import fails).
 */
export function coreInstallOf(
  executable: string,
  platform: NodeJS.Platform,
  installFs: InstallFs = nodeInstallFs,
): { adapters: string[] } | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  try {
    const exe = installFs.realpath(executable);
    const binDir = p.dirname(exe);
    const binName = p.basename(binDir);
    if (platform === 'win32' ? binName.toLowerCase() !== 'scripts' : binName !== 'bin') return null;
    const prefix = p.dirname(binDir);

    if (platform === 'win32') {
      if (!(installFs.size(exe) < MAX_WIN_LAUNCHER_BYTES)) return null;
    } else {
      const start = installFs.readStart(exe, 2);
      if (start.length < 2 || start[0] !== 0x23 || start[1] !== 0x21) return null;
    }

    const sitePackages = platform === 'win32'
      ? [p.join(prefix, 'Lib', 'site-packages')]
      : installFs.readdir(p.join(prefix, 'lib'))
        .filter((e) => /^python3\.\d+$/.test(e))
        .sort()
        .map((e) => p.join(prefix, 'lib', e, 'site-packages'));

    for (const sp of sitePackages) {
      if (!installFs.isFile(p.join(sp, 'dbt', 'cli', 'main.py'))) continue;
      const include = p.join(sp, 'dbt', 'include');
      if (!installFs.isDir(p.join(include, 'global_project'))) continue;
      const adapters = installFs.readdir(include)
        .filter((e) => !NOT_ADAPTERS.has(e) && !e.startsWith('_') && !e.startsWith('.') && installFs.isDir(p.join(include, e)))
        .sort();
      return { adapters };
    }
    return null;
  } catch {
    return null;
  }
}

/** The adapters in `dbt --version`'s `Plugins:` block (ANSI stripped). */
export function pluginsFromVersionOutput(output: string): string[] {
  const lines = stripAnsi(output).replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((l) => /^\s*Plugins:\s*$/.test(l));
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const m = /^\s+-\s+([a-z][a-z0-9_]*):\s+\S+/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Which adapter the project uses
// ---------------------------------------------------------------------------

/** Supported adapters named as `dbt-<adapter>` in a requirements-style file, deduped. */
export function adapterHintsFromText(text: string): ThrowawayAdapter[] {
  const out: ThrowawayAdapter[] = [];
  const re = /\bdbt-(duckdb|postgres|redshift|snowflake|databricks|bigquery|fabric|sqlserver|trino|spark)\b/gi;
  for (const m of text.matchAll(re)) {
    const a = m[1].toLowerCase() as ThrowawayAdapter;
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** `metadata.adapter_type` from the start of a manifest.json. */
export function adapterTypeFromManifestStart(text: string): string | null {
  return /"adapter_type"\s*:\s*"([a-z][a-z0-9_]*)"/.exec(text)?.[1] ?? null;
}

/** Requirements-style files at the project root (plus every `requirements/*.txt`), read for adapter hints. */
export const REQUIREMENTS_FILES: readonly string[] = [
  'requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt', 'dev-requirements.txt',
  'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg', 'environment.yml', 'environment.yaml',
];

export type AdapterChoice =
  | { kind: 'one'; adapter: ThrowawayAdapter }
  | { kind: 'ask'; options: ThrowawayAdapter[] }
  | { kind: 'none'; unsupportedInstalled: boolean };

/**
 * `[parent, child]`: installing `parent` installs `child` as a dependency, so
 * an installed `child` says nothing about the project when `parent` is there
 * too. synapse, glue and materialize are not supported themselves: their
 * projects must not get another adapter's placeholder by way of a dependency.
 */
const IMPLIED: ReadonlyArray<readonly [string, ThrowawayAdapter]> = [
  ['databricks', 'spark'], ['redshift', 'postgres'], ['sqlserver', 'fabric'],
  ['synapse', 'fabric'], ['glue', 'spark'], ['materialize', 'postgres'],
];

function isThrowawayAdapter(a: string | null): a is ThrowawayAdapter {
  return a !== null && (THROWAWAY_ADAPTERS as readonly string[]).includes(a);
}

/** Which placeholder adapter to use, given the installed adapters and the project's hints. */
export function chooseThrowawayAdapter(
  installed: readonly string[],
  hints: { manifest: string | null; files: readonly ThrowawayAdapter[] },
): AdapterChoice {
  let supported = installed.filter(isThrowawayAdapter).filter((a, i, all) => all.indexOf(a) === i);
  for (const [parent, child] of IMPLIED) {
    if (installed.includes(parent) && supported.includes(child)) {
      const hintedAlone = hints.files.includes(child) && !hints.files.includes(parent as ThrowawayAdapter);
      if (!hintedAlone) supported = supported.filter((a) => a !== child);
    }
  }
  if (supported.length === 0) return { kind: 'none', unsupportedInstalled: installed.length > 0 };
  if (isThrowawayAdapter(hints.manifest) && supported.includes(hints.manifest)) {
    return { kind: 'one', adapter: hints.manifest };
  }
  const hinted = supported.filter((a) => hints.files.includes(a));
  if (hinted.length === 1) return { kind: 'one', adapter: hinted[0] };
  if (supported.length === 1) return { kind: 'one', adapter: supported[0] };
  const options = (hinted.length > 0 ? hinted : supported)
    .slice()
    .sort((a, b) => ADAPTER_LABELS[a].localeCompare(ADAPTER_LABELS[b]));
  return { kind: 'ask', options };
}

/**
 * Whether a normal `dbt parse` in `root` would find a profiles.yml: by stat
 * only, **never read**. dbt has no fallback: `$DBT_PROFILES_DIR` (or
 * `$DBT_ENGINE_PROFILES_DIR`) is the only place looked when set; otherwise
 * the cwd (`root`), then `~/.dbt`.
 */
export function profilesYmlWouldBeFound(
  root: string,
  opts: { env?: NodeJS.ProcessEnv; homeDir?: string; isFile?: (p: string) => boolean } = {},
): boolean {
  const env = opts.env ?? process.env;
  const isFile = opts.isFile ?? ((p: string) => nodeInstallFs.isFile(p));
  const dir = [env.DBT_PROFILES_DIR, env.DBT_ENGINE_PROFILES_DIR].find((d) => typeof d === 'string' && d.trim() !== '');
  if (dir) return isFile(path.resolve(root, dir, 'profiles.yml'));
  const homeDir = opts.homeDir ?? os.homedir();
  return isFile(path.join(root, 'profiles.yml')) || isFile(path.join(homeDir, '.dbt', 'profiles.yml'));
}
