/**
 * Usage telemetry: how the open workspace builds its physical tables, and on
 * which data platform, as fixed flags from `PHYSICAL_TOOLS` / `PLATFORMS`.
 * It shows which non-dbt sources the Physical stage should learn to read first.
 *
 * Pure: no `vscode`, no Node built-ins. The host supplies a {@link ToolingProbe}
 * that finds files and reads the start of one; this module only looks at file
 * names, the name of the folder holding a file, and a fixed pattern in a few
 * file heads. What it returns is a subset of the two allowlists — never a path,
 * a name, a count or any file content. It never asks for dbt's `profiles.yml`
 * (it holds credentials); the dbt warehouse comes from `manifest.json`'s
 * `metadata.adapter_type`, or a `dbt-<adapter>` package a requirements file names.
 */

import {
  PHYSICAL_TOOLS,
  PLATFORMS,
  type TelemetryPhysicalTool,
  type TelemetryPlatform,
} from './telemetryPayload';

export interface ToolingProbe {
  /** Files matching the workspace glob `include` (excluding {@link TOOLING_EXCLUDE}), at most `max`. */
  find(include: string, max: number): Promise<string[]>;
  /** The first `bytes` of `file` as text, or `undefined` when it cannot be read. */
  readHead(file: string, bytes: number): Promise<string | undefined>;
  /** The `manifest.json` path of the dbt project whose `dbt_project.yml` is `dbtProjectFile`. */
  manifestPathFor(dbtProjectFile: string): string | undefined;
}

export interface PhysicalTooling {
  tools: TelemetryPhysicalTool[];
  platforms: TelemetryPlatform[];
}

/** Never searched: dependencies, build output, virtual environments, ERD Studio's own data. */
export const TOOLING_EXCLUDE =
  '**/{node_modules,.git,dbt_packages,dbt_modules,target,.venv,venv,site-packages,__pycache__,.tox,.erd-studio,erd-studio}/**';

/**
 * {@link TOOLING_EXCLUDE} plus the configured semantic dir (`erdStudio.semanticDir`),
 * not only the literal `.erd-studio`: a project whose diagrams and tables are
 * stored as `.dbml` must not count as one whose schema is built from DBML.
 */
export function toolingExclude(semanticDir?: string): string {
  const dir = (semanticDir ?? '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!dir || dir === '.erd-studio' || dir === 'erd-studio' || /[{}*?[\],]/.test(dir)) return TOOLING_EXCLUDE;
  return TOOLING_EXCLUDE.replace('.erd-studio,erd-studio}', `.erd-studio,erd-studio,${dir}}`);
}

/** Files whose name alone says which tool builds the tables. */
const MARKERS =
  '**/{dbt_project.yml,databricks.yml,databricks.yaml,workflow_settings.yaml,dataform.json,*.sqlproj,' +
  'flyway.conf,flyway.toml,liquibase.properties,db.changelog-master.*,alembic.ini,schema.prisma,manage.py,' +
  'schema.rb,*.pbip,definition.pbism,*.dbml}';

const HEAD_BYTES = 16 * 1024;
const MANIFEST_HEAD_BYTES = 8 * 1024;
const NOTEBOOK_HEAD_BYTES = 64;

/** Our own DBML export's first line (`exportDbml.ts`): a saved export is not a DBML-built schema. */
const OWN_DBML_EXPORT = /^\/\/ erd-studio dbml-export v\d+/;
/** dbt's manifest lists `metadata` first, so its head holds the adapter. */
const MANIFEST_ADAPTER = /"adapter_type"\s*:\s*"([A-Za-z0-9_-]{1,40})"/;
const DBT_ADAPTER_PACKAGE =
  /\bdbt-(databricks|snowflake|bigquery|postgres|redshift|fabricspark|fabric|synapse|sqlserver|duckdb|spark|glue|trino|athena|mysql|mariadb|oracle|clickhouse)\b/gi;
const CREATE_TABLE = /\bcreate\s+(?:or\s+replace\s+)?(?:(?:global\s+|local\s+)?(?:temporary|temp)\s+|transient\s+|external\s+)?table\b/i;
const SQLMESH_YAML = /^(?:gateways|model_defaults)\s*:/m;
const SQLMESH_PY = /\bfrom\s+sqlmesh\b|\bModelDefaultsConfig\b|\bGatewayConfig\b/;
const SQLPROJ_PROVIDER = /Microsoft\.Data\.Tools\.Schema\.Sql\.(\w+?)DatabaseSchemaProvider/;
const DATABRICKS_NOTEBOOK = /^(?:#|--)\s*Databricks notebook source/;

/** dbt `adapter_type` → platform. A well-formed adapter not listed is `other`. */
const DBT_ADAPTER_PLATFORMS: Readonly<Record<string, TelemetryPlatform>> = {
  databricks: 'databricks',
  snowflake: 'snowflake',
  bigquery: 'bigquery',
  postgres: 'postgres',
  redshift: 'redshift',
  fabric: 'fabric',
  fabricspark: 'fabric',
  synapse: 'synapse',
  sqlserver: 'sqlserver',
  duckdb: 'duckdb',
  spark: 'spark',
  glue: 'spark',
  trino: 'trino',
  athena: 'athena',
  mysql: 'mysql',
  mariadb: 'mysql',
  oracle: 'oracle',
  clickhouse: 'clickhouse',
};

export function platformFromDbtAdapter(adapter: string): TelemetryPlatform | undefined {
  const key = adapter.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(key)) return undefined;
  return DBT_ADAPTER_PLATFORMS[key] ?? 'other';
}

/** The dbt warehouse named in the head of a `manifest.json`, if any. */
export function platformFromManifestHead(head: string): TelemetryPlatform | undefined {
  const adapter = MANIFEST_ADAPTER.exec(head)?.[1];
  return adapter ? platformFromDbtAdapter(adapter) : undefined;
}

/** Every dbt warehouse a requirements / pyproject file installs an adapter for. */
export function platformsFromRequirements(text: string): TelemetryPlatform[] {
  const found = new Set<TelemetryPlatform>();
  for (const match of text.matchAll(DBT_ADAPTER_PACKAGE)) {
    const platform = platformFromDbtAdapter(match[1]);
    if (platform) found.add(platform);
  }
  return [...found];
}

/** A Visual Studio / SDK-style SQL project's target, from its `<DSP>`. */
export function platformFromSqlproj(text: string): TelemetryPlatform | undefined {
  const provider = SQLPROJ_PROVIDER.exec(text)?.[1];
  if (!provider) return undefined;
  if (provider === 'SqlDwUnified') return 'fabric';
  if (provider.startsWith('SqlDw') || provider === 'SqlServerless') return 'synapse';
  return 'sqlserver';
}

export function hasCreateTable(sql: string): boolean {
  return CREATE_TABLE.test(sql);
}

export function isSqlmeshConfig(fileName: string, text: string): boolean {
  return fileName.endsWith('.py') ? SQLMESH_PY.test(text) : SQLMESH_YAML.test(text);
}

export function isDatabricksNotebook(head: string): boolean {
  return DATABRICKS_NOTEBOOK.test(head.replace(/^﻿/, ''));
}

/** `a/b/c.txt` with forward slashes, whatever the platform wrote. */
function slashed(file: string): string {
  return file.replace(/\\/g, '/');
}

function baseName(file: string): string {
  const s = slashed(file);
  return s.slice(s.lastIndexOf('/') + 1);
}

/** The folder holding `file`, e.g. `Sales.Lakehouse`. */
function parentName(file: string): string {
  const s = slashed(file);
  const dir = s.slice(0, Math.max(s.lastIndexOf('/'), 0));
  return dir.slice(dir.lastIndexOf('/') + 1);
}

/**
 * The tools and platforms the marker files' names alone tell. A `.platform`
 * file sits in a Fabric item folder named `<item>.<Type>`; Power BI projects
 * (PBIP) write the same file for `.SemanticModel` and `.Report` folders.
 */
export function classifyMarkerFiles(files: readonly string[]): PhysicalTooling {
  const tools = new Set<TelemetryPhysicalTool>();
  const platforms = new Set<TelemetryPlatform>();
  for (const file of files) {
    const name = baseName(file).toLowerCase();
    if (name === 'dbt_project.yml') tools.add('dbt');
    else if (name === 'databricks.yml' || name === 'databricks.yaml') {
      tools.add('databricksBundle');
      platforms.add('databricks');
    } else if (name === 'workflow_settings.yaml' || name === 'dataform.json') {
      tools.add('dataform');
      platforms.add('bigquery');
    } else if (name.endsWith('.sqlproj')) tools.add('sqlProject');
    else if (name === 'flyway.conf' || name === 'flyway.toml') tools.add('flyway');
    else if (name === 'liquibase.properties' || name.startsWith('db.changelog-master.')) tools.add('liquibase');
    else if (name === 'alembic.ini') tools.add('alembic');
    else if (name === 'schema.prisma') tools.add('prisma');
    else if (name === 'manage.py') tools.add('django');
    else if (name === 'schema.rb' && parentName(file).toLowerCase() === 'db') tools.add('rails');
    else if (name.endsWith('.pbip') || name === 'definition.pbism') tools.add('powerBi');
    else if (name === '.platform') {
      const type = /\.([A-Za-z]+)$/.exec(parentName(file))?.[1];
      if (type === 'SemanticModel' || type === 'Report') tools.add('powerBi');
      else if (type) {
        tools.add('fabric');
        platforms.add('fabric');
      }
    }
  }
  return ordered(tools, platforms);
}

function ordered(tools: Set<TelemetryPhysicalTool>, platforms: Set<TelemetryPlatform>): PhysicalTooling {
  return {
    tools: PHYSICAL_TOOLS.filter(t => tools.has(t)),
    platforms: PLATFORMS.filter(p => platforms.has(p)),
  };
}

/**
 * Look at the workspace. Every probe failure counts as "not found"; this never
 * throws, so telemetry can never break activation.
 */
export async function detectPhysicalTooling(probe: ToolingProbe): Promise<PhysicalTooling> {
  const tools = new Set<TelemetryPhysicalTool>();
  const platforms = new Set<TelemetryPlatform>();
  const find = async (include: string, max: number): Promise<string[]> => {
    try { return await probe.find(include, max); } catch { return []; }
  };
  const head = async (file: string, bytes: number): Promise<string> => {
    try { return (await probe.readHead(file, bytes)) ?? ''; } catch { return ''; }
  };

  const markers = await find(MARKERS, 500);
  const fromNames = classifyMarkerFiles([...markers, ...await find('**/.platform', 50)]);
  fromNames.tools.forEach(t => tools.add(t));
  fromNames.platforms.forEach(p => platforms.add(p));

  // A .dbml file counts unless it is one of our own exports, saved to disk.
  for (const file of markers.filter(f => baseName(f).toLowerCase().endsWith('.dbml')).slice(0, 5)) {
    if (!OWN_DBML_EXPORT.test(await head(file, 64))) { tools.add('dbml'); break; }
  }
  for (const file of markers.filter(f => baseName(f).toLowerCase().endsWith('.sqlproj')).slice(0, 5)) {
    const platform = platformFromSqlproj(await head(file, HEAD_BYTES));
    if (platform) platforms.add(platform);
  }
  for (const file of markers.filter(f => baseName(f).toLowerCase() === 'dbt_project.yml').slice(0, 3)) {
    let manifest: string | undefined;
    try { manifest = probe.manifestPathFor(file); } catch { manifest = undefined; }
    const platform = manifest ? platformFromManifestHead(await head(manifest, MANIFEST_HEAD_BYTES)) : undefined;
    if (platform) platforms.add(platform);
  }

  if ((await find('**/*.ipynb', 1)).length > 0) tools.add('notebooks');
  if ((await find('**/V[0-9]*__*.sql', 1)).length > 0) tools.add('flyway');
  if ((await find('**/.databricks/**', 1)).length > 0) platforms.add('databricks');

  for (const file of await find('**/*.sql', 40)) {
    const text = await head(file, HEAD_BYTES);
    if (isDatabricksNotebook(text)) {
      tools.add('notebooks');
      platforms.add('databricks');
    } else if (!/\/macros\//i.test(slashed(file)) && hasCreateTable(text)) {
      tools.add('ddlScripts');
    }
  }
  for (const file of await find('**/*.py', 30)) {
    if (isDatabricksNotebook(await head(file, NOTEBOOK_HEAD_BYTES))) {
      tools.add('notebooks');
      platforms.add('databricks');
      break;
    }
  }
  for (const file of await find('**/{config.yaml,config.yml,config.py}', 10)) {
    if (isSqlmeshConfig(baseName(file), await head(file, HEAD_BYTES))) { tools.add('sqlmesh'); break; }
  }
  for (const file of await find('**/{requirements*.txt,pyproject.toml,Pipfile,setup.py,setup.cfg,environment.yml}', 10)) {
    platformsFromRequirements(await head(file, HEAD_BYTES)).forEach(p => platforms.add(p));
  }
  return ordered(tools, platforms);
}
