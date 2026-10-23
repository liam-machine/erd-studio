/**
 * physicalTooling — which tools build a workspace's physical tables, for usage
 * telemetry. Driven against an in-memory workspace through the same globs the
 * host passes to `vscode.workspace.findFiles`, so the include and exclude
 * patterns are exercised too. The last suites hold the privacy promise: only
 * allowlisted values come back, never a path, name or file content.
 */

import { describe, expect, it } from 'vitest';

import {
  TOOLING_EXCLUDE,
  classifyMarkerFiles,
  detectPhysicalTooling,
  hasCreateTable,
  isDatabricksNotebook,
  isSqlmeshConfig,
  platformFromDbtAdapter,
  platformFromManifestHead,
  platformFromSqlproj,
  platformsFromRequirements,
  type ToolingProbe,
} from '../../src/services/physicalTooling';
import { PHYSICAL_TOOLS, PLATFORMS } from '../../src/services/telemetryPayload';

const ROOT = '/Users/jane.doe/work/acme-lakehouse/';

/** Enough of VS Code's glob syntax for the patterns the detector uses. */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith('**/', i)) { out += '(?:.*/)?'; i += 2; }
    else if (glob.startsWith('/**', i) && i + 3 === glob.length) { out += '/.*'; i += 2; }
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') out += '(?:';
    else if (c === '}') out += ')';
    else if (c === ',') out += '|';
    else if (c === '[') { const end = glob.indexOf(']', i); out += glob.slice(i, end + 1); i = end; }
    else out += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** A workspace of `relative path → content`; the manifest lives under the excluded `target/`. */
function workspace(files: Record<string, string>): ToolingProbe & { reads: string[] } {
  const exclude = globToRegExp(TOOLING_EXCLUDE);
  const reads: string[] = [];
  return {
    reads,
    find: async (include, max) => {
      const re = globToRegExp(include);
      return Object.keys(files).filter(f => re.test(f) && !exclude.test(f)).slice(0, max).map(f => ROOT + f);
    },
    readHead: async (file, bytes) => {
      reads.push(file);
      const content = files[file.slice(ROOT.length)];
      return content === undefined ? undefined : content.slice(0, bytes);
    },
    manifestPathFor: file => file.replace(/dbt_project\.yml$/, 'target/manifest.json'),
  };
}

describe('detectPhysicalTooling', () => {
  it('reads the dbt warehouse from the head of manifest.json, never profiles.yml', async () => {
    const probe = workspace({
      'dbt_project.yml': 'name: acme',
      'profiles.yml': 'acme:\n  outputs:\n    prod:\n      type: snowflake\n      password: hunter2',
      'target/manifest.json': '{"metadata": {"dbt_schema_version": "v12", "adapter_type": "databricks"}, "nodes": {}}',
      'models/dim_customer.sql': 'select * from {{ ref("stg_customer") }}',
    });
    expect(await detectPhysicalTooling(probe)).toEqual({ tools: ['dbt'], platforms: ['databricks'] });
    expect(probe.reads.some(f => f.endsWith('profiles.yml'))).toBe(false);
  });

  it('tells a Fabric workspace from a Power BI project by the item folder', async () => {
    expect(await detectPhysicalTooling(workspace({
      'Sales.Lakehouse/.platform': '{}',
      'Load Sales.Notebook/.platform': '{}',
      'Sales.SemanticModel/.platform': '{}',
      'Sales.SemanticModel/definition.pbism': '{}',
      'Sales.Report/.platform': '{}',
      'Sales.pbip': '{}',
    }))).toEqual({ tools: ['fabric', 'powerBi'], platforms: ['fabric'] });

    expect(await detectPhysicalTooling(workspace({
      'Sales.SemanticModel/.platform': '{}',
      'Sales.Report/.platform': '{}',
    }))).toEqual({ tools: ['powerBi'], platforms: [] });
  });

  it('finds a Databricks bundle and its notebooks, in Python and SQL', async () => {
    expect(await detectPhysicalTooling(workspace({
      'databricks.yml': 'bundle:\n  name: acme',
      'src/ingest.py': '# Databricks notebook source\nspark.table("x")',
      'src/report.sql': '-- Databricks notebook source\nSELECT 1',
    }))).toEqual({ tools: ['databricksBundle', 'notebooks'], platforms: ['databricks'] });

    // A folder the Databricks extension created is enough for the platform.
    expect(await detectPhysicalTooling(workspace({ '.databricks/project.json': '{}' })))
      .toEqual({ tools: [], platforms: ['databricks'] });
  });

  it('reads a SQL project\'s target platform and spots DDL scripts', async () => {
    expect(await detectPhysicalTooling(workspace({
      'db/Warehouse.sqlproj': '<Project><PropertyGroup><DSP>Microsoft.Data.Tools.Schema.Sql.SqlDwUnifiedDatabaseSchemaProvider</DSP></PropertyGroup></Project>',
      'db/Tables/DimCustomer.sql': 'CREATE TABLE [dbo].[DimCustomer] ([Id] INT NOT NULL)',
    }))).toEqual({ tools: ['sqlProject', 'ddlScripts'], platforms: ['fabric'] });
  });

  it('finds SQLMesh by its config keys, and the warehouse by the dbt adapter package', async () => {
    expect(await detectPhysicalTooling(workspace({
      'config.yaml': 'gateways:\n  local:\n    connection:\n      type: duckdb\nmodel_defaults:\n  dialect: duckdb',
      'requirements.txt': 'sqlmesh==0.140\ndbt-core==1.9\ndbt-snowflake==1.9.1\n',
      'app/config.yaml': 'port: 8080',
    }))).toEqual({ tools: ['sqlmesh'], platforms: ['snowflake'] });
  });

  it('finds the migration and app frameworks by their files', async () => {
    expect(await detectPhysicalTooling(workspace({
      'flyway.conf': 'flyway.url=jdbc:postgresql://db.internal:5432/acme',
      'liquibase/liquibase.properties': 'changeLogFile=db.changelog-master.yaml',
      'alembic.ini': '[alembic]',
      'prisma/schema.prisma': 'datasource db { provider = "postgresql" }',
      'web/manage.py': 'import django',
      'shop/db/schema.rb': 'ActiveRecord::Schema.define',
      'analysis/explore.ipynb': '{}',
    }))).toEqual({
      tools: ['flyway', 'liquibase', 'alembic', 'prisma', 'django', 'rails', 'notebooks'],
      platforms: [],
    });
    // Flyway's versioned migrations alone count; a schema.rb outside db/ does not.
    expect(await detectPhysicalTooling(workspace({
      'sql/V1__init.sql': 'select 1',
      'lib/schema.rb': '',
    }))).toEqual({ tools: ['flyway'], platforms: [] });
  });

  it('counts a DBML file, unless it is one of ERD Studio\'s own saved exports', async () => {
    expect((await detectPhysicalTooling(workspace({
      'docs/sales.dbml': '// erd-studio dbml-export v1\nTable dim_customer {}',
    }))).tools).toEqual([]);
    expect((await detectPhysicalTooling(workspace({
      'docs/sales.dbml': '// erd-studio dbml-export v1\nTable dim_customer {}',
      'schema/warehouse.dbml': 'Table customers {\n  id int [pk]\n}',
    }))).tools).toEqual(['dbml']);
  });

  it('ignores dependencies, virtual environments, dbt macros and ERD Studio\'s own folder', async () => {
    expect(await detectPhysicalTooling(workspace({
      'dbt_project.yml': 'name: acme',
      'dbt_packages/dbt_utils/dbt_project.yml': 'name: dbt_utils',
      'node_modules/prisma/schema.prisma': '',
      '.venv/lib/site-packages/django/manage.py': '',
      'macros/materialize.sql': '{% macro m() %} create table {{ this }} as ( {{ sql }} ) {% endmacro %}',
      '.erd-studio/gold/sales.dbml': 'Table x {}',
    }))).toEqual({ tools: ['dbt'], platforms: [] });
  });

  it('treats every probe failure as "not found" and never throws', async () => {
    const failing: ToolingProbe = {
      find: async () => { throw new Error(`${ROOT} is not readable`); },
      readHead: async () => { throw new Error('EACCES'); },
      manifestPathFor: () => { throw new Error('bad dbt_project.yml'); },
    };
    expect(await detectPhysicalTooling(failing)).toEqual({ tools: [], platforms: [] });

    const unreadable = workspace({ 'dbt_project.yml': 'name: acme' });
    unreadable.readHead = async () => { throw new Error('EACCES'); };
    expect(await detectPhysicalTooling(unreadable)).toEqual({ tools: ['dbt'], platforms: [] });
  });
});

describe('the pieces', () => {
  it('maps dbt adapters to platforms, unknown well-formed ones to other', () => {
    expect(platformFromDbtAdapter('fabricspark')).toBe('fabric');
    expect(platformFromDbtAdapter('glue')).toBe('spark');
    expect(platformFromDbtAdapter('Snowflake')).toBe('snowflake');
    expect(platformFromDbtAdapter('teradata')).toBe('other');
    expect(platformFromDbtAdapter('')).toBeUndefined();
    expect(platformFromDbtAdapter('not an adapter')).toBeUndefined();
    expect(platformFromManifestHead('{"metadata":{"adapter_type":"bigquery"}}')).toBe('bigquery');
    expect(platformFromManifestHead('{"metadata":{}}')).toBeUndefined();
  });

  it('reads every adapter a requirements file installs', () => {
    expect(platformsFromRequirements('dbt-postgres>=1.8\ndbt-duckdb\n# dbt-core only\n').sort()).toEqual(['duckdb', 'postgres']);
    expect(platformsFromRequirements('dependencies = ["dbt-fabric==1.9", "dbt-fabricspark"]')).toEqual(['fabric']);
    expect(platformsFromRequirements('dbt-core==1.9\nsqlfluff')).toEqual([]);
  });

  it('reads a SQL project\'s schema provider', () => {
    const dsp = (p: string): string => `<DSP>Microsoft.Data.Tools.Schema.Sql.${p}DatabaseSchemaProvider</DSP>`;
    expect(platformFromSqlproj(dsp('Sql160'))).toBe('sqlserver');
    expect(platformFromSqlproj(dsp('SqlAzureV12'))).toBe('sqlserver');
    expect(platformFromSqlproj(dsp('SqlDw'))).toBe('synapse');
    expect(platformFromSqlproj(dsp('SqlServerless'))).toBe('synapse');
    expect(platformFromSqlproj(dsp('SqlDwUnified'))).toBe('fabric');
    expect(platformFromSqlproj('<Project />')).toBeUndefined();
  });

  it('knows a CREATE TABLE in its common spellings, and not a SELECT', () => {
    for (const ddl of [
      'CREATE TABLE dim (id int)',
      'create or replace transient table x as select 1',
      'CREATE GLOBAL TEMPORARY TABLE t (a int)',
      'create external table ext (a string)',
    ]) expect(hasCreateTable(ddl), ddl).toBe(true);
    expect(hasCreateTable('select * from created_tables')).toBe(false);
  });

  it('knows SQLMesh configs and Databricks notebook headers', () => {
    expect(isSqlmeshConfig('config.yaml', 'model_defaults:\n  dialect: snowflake')).toBe(true);
    expect(isSqlmeshConfig('config.yaml', 'models:\n  defaults: {}')).toBe(false);
    expect(isSqlmeshConfig('config.py', 'from sqlmesh.core.config import Config')).toBe(true);
    expect(isDatabricksNotebook('\uFEFF# Databricks notebook source\n')).toBe(true);
    expect(isDatabricksNotebook('import databricks\n')).toBe(false);
  });

  it('classifies Windows paths too', () => {
    expect(classifyMarkerFiles(['C:\\work\\acme\\Sales.Lakehouse\\.platform', 'C:\\work\\acme\\db\\schema.rb']))
      .toEqual({ tools: ['fabric', 'rails'], platforms: ['fabric'] });
  });
});

describe('nothing identifying comes back', () => {
  it('returns only allowlisted values, whatever the workspace holds', async () => {
    const result = await detectPhysicalTooling(workspace({
      'jane-secret-project/dbt_project.yml': 'name: jane_secret',
      'jane-secret-project/target/manifest.json': '{"metadata":{"adapter_type":"jane_secret_adapter"}}',
      'Customer Secrets.Lakehouse/.platform': '{"displayName":"Customer Secrets"}',
      'requirements.txt': 'dbt-acme-internal\n',
      'secret.dbml': 'Table jane_secret_table {}',
    }));
    const json = JSON.stringify(result);
    for (const leak of ['jane', 'secret', 'Secrets', 'acme', 'Customer', '/', '\\\\']) expect(json).not.toContain(leak);
    for (const tool of result.tools) expect(PHYSICAL_TOOLS).toContain(tool);
    for (const platform of result.platforms) expect(PLATFORMS).toContain(platform);
    // An adapter it has no name for is just "other".
    expect(result.platforms).toEqual(['fabric', 'other']);
  });
});
