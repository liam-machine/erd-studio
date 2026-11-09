/**
 * Import… (`erdStudio.importModel`), the start screen's Import: the three
 * sources, the one the folder seems to hold first (DBML when none), the
 * funnel keys, and the bounded look at the folder behind that order. Also
 * the pure helpers the converting imports share (src/services/importSources.ts).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DETECT_SQL_FILES,
  FOUND_HERE,
  IMPORT_GUIDE_ITEM,
  IMPORT_MODEL_COMMAND,
  IMPORT_PICK_FEATURES,
  IMPORT_SOURCE_COMMANDS,
  IMPORT_SOURCE_ITEMS,
  detectExcludeGlob,
  detectImportFindings,
  findImportDbmlFile,
  detectImportSources,
  vscodeDetectImportIo,
  importSourceItems,
  readFileStart,
  runImportModel,
  type DetectImportIo,
  type ImportGuideItem,
  type ImportSourceItem,
} from '../../src/commands/importModel';
import { NO_LEGACY_ALIAS, PRE_REGISTERED_COMMANDS } from '../../src/extension';
import {
  MAX_SQL_FILE_BYTES,
  convertedFileName,
  sqlImportFileName,
  describeImportProblems,
  isSemanticModelMarker,
  listImportFiles,
  looksLikeSqlDdl,
  orderImportSources,
  rankSqlFiles,
  semanticModelSkippedSummary,
  walkFiles,
  type ImportModelSource,
} from '../../src/services/importSources';
import { telemetry } from '../../src/services/telemetryService';
import { START_ACTION_COMMANDS } from '../../src/types/startActions';
import packageJson from '../../package.json';

afterEach(() => vi.restoreAllMocks());

describe('Import… — contributed', () => {
  const pkg = packageJson as unknown as {
    contributes: { commands: Array<{ command: string; title: string; category?: string }>; menus: Record<string, Array<{ command?: string; when?: string }>> };
  };

  it('is the start screen\'s Import, a palette command with no legacy alias, and not pre-registered (an empty window gets the open-a-folder stub)', () => {
    expect(START_ACTION_COMMANDS.import).toBe(IMPORT_MODEL_COMMAND);
    expect(pkg.contributes.commands.find((c) => c.command === IMPORT_MODEL_COMMAND)).toEqual({ command: IMPORT_MODEL_COMMAND, title: 'Import…', category: 'ERD Studio' });
    expect(NO_LEGACY_ALIAS.has(IMPORT_MODEL_COMMAND)).toBe(true);
    expect(PRE_REGISTERED_COMMANDS.has(IMPORT_MODEL_COMMAND)).toBe(false);
    expect(pkg.contributes.menus.commandPalette.filter((m) => m.command === IMPORT_MODEL_COMMAND)).toEqual([{ command: IMPORT_MODEL_COMMAND, when: 'erdStudio.hasProject' }]);
  });

  it('runs a contributed command for every source', () => {
    const contributed = pkg.contributes.commands.map((c) => c.command);
    expect(IMPORT_SOURCE_COMMANDS).toEqual({ dbml: 'erdStudio.importDbml', sqlDdl: 'erdStudio.importSqlDdl', semanticModel: 'erdStudio.importSemanticModel' });
    for (const command of Object.values(IMPORT_SOURCE_COMMANDS)) expect(contributed).toContain(command);
  });
});

describe('runImportModel', () => {
  const run = async (found: ImportModelSource[], answer?: ImportModelSource, detect?: () => Promise<ReadonlySet<ImportModelSource>>) => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown: ImportSourceItem[][] = [];
    const lastItems: Array<ImportSourceItem | ImportGuideItem> = [];
    const ran: string[] = [];
    await runImportModel({
      detect: detect ?? (async () => new Set(found)),
      pick: async (items) => {
        // The sources, then the import guide, always last.
        shown.push(items.filter((i): i is ImportSourceItem => 'source' in i));
        lastItems.push(items[items.length - 1]);
        return items.find((i) => 'source' in i && i.source === answer);
      },
      executeCommand: async (command) => { ran.push(command); },
      detectTimeoutMs: 50,
    });
    expect(lastItems[0]).toEqual(IMPORT_GUIDE_ITEM);
    return { shown: shown[0], ran, features: feature.mock.calls.map((c) => c[0]) };
  };

  it('offers DBML first when the folder suggests nothing, and runs the picked source\'s command, counted', async () => {
    const { shown, ran, features } = await run([], 'sqlDdl');
    expect(shown.map((i) => i.source)).toEqual(['dbml', 'sqlDdl', 'semanticModel']);
    expect(shown.map((i) => i.label)).toEqual(['$(file-code) DBML file', '$(database) SQL DDL scripts', '$(graph) Power BI or Fabric semantic model']);
    expect(shown.every((i) => i.description === undefined)).toBe(true);
    // DBML stays "an open format", never an open standard.
    expect(shown[0].detail).toContain('an open format');
    expect(ran).toEqual(['erdStudio.importSqlDdl']);
    expect(features).toEqual(['importPickSqlDdl']);
  });

  it('puts what the folder holds first, marked', async () => {
    const { shown } = await run(['semanticModel'], 'semanticModel');
    expect(shown.map((i) => i.source)).toEqual(['semanticModel', 'dbml', 'sqlDdl']);
    expect(shown[0].description).toBe(FOUND_HERE);
    expect((await run(['sqlDdl', 'semanticModel'])).shown.map((i) => i.source)).toEqual(['sqlDdl', 'semanticModel', 'dbml']);
  });

  it('ends with the import guide: it opens the guide from the picker, counted by the guide, not as a source', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const ran: unknown[][] = [];
    let items: ReadonlyArray<ImportSourceItem | ImportGuideItem> = [];
    await runImportModel({
      detect: async () => new Set(['sqlDdl']),
      pick: async (shown) => { items = shown; return shown[shown.length - 1]; },
      executeCommand: async (...args) => { ran.push(args); },
      detectTimeoutMs: 50,
    });
    expect(items.map((i) => i.label)).toEqual([
      '$(database) SQL DDL scripts', '$(file-code) DBML file', '$(graph) Power BI or Fabric semantic model',
      '$(question) Bring In Your Data Model…',
    ]);
    expect(ran).toEqual([['erdStudio.showImportGuide', { from: 'picker' }]]);
    expect(feature).not.toHaveBeenCalled();
  });

  it('closing the picker runs nothing and counts importPickCancelled', async () => {
    const { ran, features } = await run(['dbml']);
    expect(ran).toEqual([]);
    expect(features).toEqual(['importPickCancelled']);
  });

  it('never waits long for the look: a slow or failing one shows the fixed order', async () => {
    const slow = await run([], 'dbml', () => new Promise((resolve) => setTimeout(() => resolve(new Set(['semanticModel'])), 2000)));
    expect(slow.shown.map((i) => i.source)).toEqual(['dbml', 'sqlDdl', 'semanticModel']);
    expect(slow.ran).toEqual(['erdStudio.importDbml']);
    const failing = await run([], undefined, () => Promise.reject(new Error('no workspace')));
    expect(failing.shown.map((i) => i.source)).toEqual(['dbml', 'sqlDdl', 'semanticModel']);
  });

  it('counts each pick with its own key', () => {
    expect(IMPORT_PICK_FEATURES).toEqual({ dbml: 'importPickDbml', sqlDdl: 'importPickSqlDdl', semanticModel: 'importPickSemanticModel' });
    expect(importSourceItems(new Set(['dbml'])).map((i) => i.description)).toEqual([FOUND_HERE, undefined, undefined]);
  });
});

/** An in-memory folder: `files` maps paths under `root` to their text. */
function memIo(files: Record<string, string>, root = '/w', more: Partial<DetectImportIo> = {}): DetectImportIo & { opened: string[]; listed: string[] } {
  const opened: string[] = [];
  const listed: string[] = [];
  const dirs = new Map<string, Map<string, boolean>>();
  const add = (dir: string, name: string, isDir: boolean): void => {
    if (!dirs.has(dir)) dirs.set(dir, new Map());
    dirs.get(dir)!.set(name, isDir || (dirs.get(dir)!.get(name) ?? false));
  };
  dirs.set(root, new Map());
  for (const rel of Object.keys(files)) {
    const parts = rel.split('/');
    let dir = root;
    parts.forEach((part, i) => {
      add(dir, part, i < parts.length - 1);
      dir = `${dir}/${part}`;
    });
  }
  return {
    root,
    opened,
    listed,
    readDirectory: async (folder) => {
      listed.push(folder);
      const entries = dirs.get(folder);
      if (!entries) throw new Error('ENOENT');
      return [...entries];
    },
    readStart: async (file, chars) => {
      opened.push(file);
      const text = files[file.slice(root.length + 1)];
      if (text === undefined) throw new Error('ENOENT');
      return text.slice(0, chars);
    },
    size: async (file) => files[file.slice(root.length + 1)]?.length,
    ...more,
  };
}

describe('findImportDbmlFile (the quick DBML import\'s file: the one the look counted)', () => {
  it('takes the first listed .dbml that is not ERD Studio\'s own export, from the same listing as the look', async () => {
    const io = memIo({
      'exports/sales.dbml': '// erd-studio dbml-export v1\nTable a {\n  id int\n}\n',
      'model/schema.dbml': 'Table b {\n  id int\n}\n',
      '.erd-studio/silver/x.dbml': 'Table x {\n  id int\n}\n',
    });
    expect(await findImportDbmlFile(io, '.erd-studio')).toBe('/w/model/schema.dbml');
    expect((await detectImportFindings(io, '.erd-studio')).sources.has('dbml')).toBe(true);
    expect(io.listed.some((f) => f.includes('.erd-studio'))).toBe(false);
  });

  it('finds nothing when every .dbml is an export (the look offers no DBML either)', async () => {
    const io = memIo({ 'exports/sales.dbml': '// erd-studio dbml-export v1\nTable a {\n  id int\n}\n' });
    expect(await findImportDbmlFile(io, '.erd-studio')).toBeUndefined();
    expect((await detectImportFindings(io, '.erd-studio')).sources.has('dbml')).toBe(false);
  });
});

describe('detectImportSources', () => {
  it('finds a semantic model, a .dbml file and a .sql file holding CREATE TABLE, skipping the ERD Studio folder', async () => {
    const lookups = memIo({
      'Sales.SemanticModel/definition.pbism': '{}',
      'schema.dbml': 'Table a {\n  id int\n}\n',
      'models/stg.sql': 'select * from {{ ref("raw") }}',
      'ddl/tables.sql': '-- the warehouse\nCREATE TABLE IF NOT EXISTS sales.orders (\n  id int\n);',
      '.erd-studio/silver/x.dbml': 'Table x {\n  id int\n}\n',
      '.erd-studio/old.sql': 'CREATE TABLE x (id int);',
    });
    expect([...await detectImportSources(lookups, '.erd-studio')].sort()).toEqual(['dbml', 'semanticModel', 'sqlDdl']);
    // The ERD Studio folder is never listed, nor read.
    expect(lookups.listed.some((f) => f.includes('.erd-studio'))).toBe(false);
    expect(lookups.opened.some((f) => f.includes('.erd-studio'))).toBe(false);
    expect(detectExcludeGlob('.erd-studio')).toBe('**/{node_modules,.git,.venv,venv,target,dbt_packages,.erd-studio}/**');
  });

  it('a dbt project\'s SELECT models are not SQL DDL; a failed lookup is nothing found', async () => {
    expect([...await detectImportSources(memIo({ 'a.sql': 'with x as (select 1) select * from x' }), '.erd-studio')]).toEqual([]);
    const broken: DetectImportIo = { root: '/w', readDirectory: () => Promise.reject(new Error('gone')), readStart: () => Promise.reject(new Error('gone')) };
    expect([...await detectImportSources(broken, '.erd-studio')]).toEqual([]);
  });

  it('never offers what the import refuses or cannot read: a dbt macro, a CTAS, a Databricks notebook, ERD Studio\'s own DBML export, a file too big to read', async () => {
    const notOffered = {
      'macros/materializations.sql': '{% macro create_table_as(temporary, relation, sql) -%}\n  create or replace table {{ relation }}\n  as (\n    {{ sql }}\n  );\n{%- endmacro %}\n',
      'analyses/backfill.sql': 'create table tmp_backfill as (\n  select * from {{ ref(\'dim_customer\') }}\n);\n',
      'src/gold.sql': '-- Databricks notebook source\n-- COMMAND ----------\nCREATE TABLE gold.x (id INT);\n',
      'docs/sales.dbml': '// erd-studio dbml-export v2 (DBML 9.1+)\nTable a {\n  id int\n}\n',
    };
    expect([...await detectImportSources(memIo(notOffered), '.erd-studio')]).toEqual([]);
    // Oracle DDL reads as Oracle: offered.
    expect([...await detectImportSources(memIo({ 'oracle/hr.sql': 'CREATE TABLE HR.EMPLOYEES (\n  ID NUMBER(6) NOT NULL,\n  EMAIL VARCHAR2(25 BYTE)\n);\n' }), '.erd-studio')]).toEqual(['sqlDdl']);
    const huge = memIo({ 'dump.sql': 'CREATE TABLE a (id int);' }, '/w', { size: async () => MAX_SQL_FILE_BYTES + 1 });
    expect([...await detectImportSources(huge, '.erd-studio')]).toEqual([]);
  });

  it('finds what a case-sensitive glob missed: .SQL and .DBML, a UTF-16 script (decoded by its byte order mark), a hidden folder that is not a tool\'s', async () => {
    expect([...await detectImportSources(memIo({ 'DDL/TABLES.SQL': 'CREATE TABLE a (id int);' }), '.erd-studio')]).toEqual(['sqlDdl']);
    expect([...await detectImportSources(memIo({ 'MODEL.DBML': 'Table a {\n  id int\n}\n' }), '.erd-studio')]).toEqual(['dbml']);
    expect([...await detectImportSources(memIo({ '.devcontainer/initdb/01.sql': 'CREATE TABLE a (id int);' }), '.erd-studio')]).toEqual(['sqlDdl']);
    expect([...await detectImportSources(memIo({ '.git/x.sql': 'CREATE TABLE a (id int);', '.venv/y.sql': 'CREATE TABLE b (id int);' }), '.erd-studio')]).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-utf16-'));
    try {
      const file = path.join(dir, 'Sales_schema.sql');
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('CREATE TABLE [dbo].[Customer](\r\n\t[Id] [int] NOT NULL\r\n)\r\nGO\r\n', 'utf16le')]));
      const io = vscodeDetectImportIo(dir);
      expect(await io.readStart(file, 100)).toMatch(/^CREATE TABLE \[dbo\]/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the .sql files whose names usually hold table definitions first, so hundreds of queries do not hide the one schema script', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i++) files[`reports/q${String(i).padStart(3, '0')}.sql`] = `select ${i};`;
    files['zz_admin/schema/ddl/create_tables.sql'] = 'CREATE TABLE a (id int);';
    const lookups = memIo(files);
    expect([...await detectImportSources(lookups, '.erd-studio')]).toEqual(['sqlDdl']);
    expect(lookups.opened[0]).toBe('/w/zz_admin/schema/ddl/create_tables.sql');
    expect(lookups.opened.length).toBeLessThanOrEqual(DETECT_SQL_FILES);
  });

  it('notes a dbt_project.yml it saw', async () => {
    expect((await detectImportFindings(memIo({ 'transform/dbt_project.yml': 'name: x\n' }), '.erd-studio')).dbtProject).toBe(true);
    expect((await detectImportFindings(memIo({ 'a.sql': 'select 1' }), '.erd-studio')).dbtProject).toBeUndefined();
  });

  it('a bare .pbip (a report-only project, live-connected to a published model) is not a semantic model', async () => {
    // Every shape findSemanticModels reads holds one of these; a thin report has only X.pbip + X.Report/.
    for (const name of ['Model.bim', 'definition.pbism', 'model.tmdl', 'database.tmdl', 'database.json']) expect(isSemanticModelMarker(name), name).toBe(true);
    expect(isSemanticModelMarker('Sales.pbip')).toBe(false);
    expect((await detectImportFindings(memIo({ 'Sales.pbip': '{}', 'Sales.Report/report.json': '{}' }), '.erd-studio')).sources.has('semanticModel')).toBe(false);
  });

  it('finds a Tabular Editor Save to Folder model (database.json with a tables/ folder beside it), and ranks Power BI first', async () => {
    const io = memIo({ 'Model/database.json': '{}', 'Model/tables/Sales/Sales.json': '{}' });
    const found = await detectImportFindings(io, '.erd-studio');
    expect(found.sources.has('semanticModel')).toBe(true);
    expect(importSourceItems(found.sources)[0]).toMatchObject({ source: 'semanticModel', description: FOUND_HERE });
    expect((await listImportFiles('/w', io.readDirectory, { semanticDir: '.erd-studio' })).semanticModel).toEqual(['/w/Model/database.json']);
  });

  it('a database.json of another tool (db-migrate\'s, no tables/ folder beside it) is not a semantic model', async () => {
    const io = memIo({ 'database.json': '{"dev":{}}', 'migrations/1.js': '' });
    expect((await detectImportFindings(io, '.erd-studio')).sources.has('semanticModel')).toBe(false);
  });

  it('the source picker says a Save to Folder model is read too', () => {
    expect(IMPORT_SOURCE_ITEMS.semanticModel.detail).toMatch(/Tabular Editor/);
  });

  it('reads only the start of a file, however big it is', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-detect-'));
    try {
      const file = path.join(dir, 'dump.sql');
      fs.writeFileSync(file, 'CREATE TABLE t (id int);\n' + 'x'.repeat(200_000));
      const start = await readFileStart(file, 1024);
      expect(start.length).toBe(1024);
      expect(Buffer.from(start).toString('utf-8')).toMatch(/^CREATE TABLE t \(id int\);/);
      const small = path.join(dir, 'small.sql');
      fs.writeFileSync(small, 'select 1');
      expect(Buffer.from(await readFileStart(small, 1024)).toString('utf-8')).toBe('select 1');
      await expect(readFileStart(path.join(dir, 'gone.sql'), 10)).rejects.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('importSources helpers', () => {
  it('orders found sources first, in the fixed order', () => {
    expect(orderImportSources(new Set())).toEqual(['dbml', 'sqlDdl', 'semanticModel']);
    expect(orderImportSources(new Set(['semanticModel', 'sqlDdl']))).toEqual(['sqlDdl', 'semanticModel', 'dbml']);
  });

  it('recognises CREATE TABLE with a column list in each dialect, not a view, a CTAS behind a comment, or a SELECT', () => {
    for (const yes of [
      'CREATE TABLE t (id int);',
      'create or replace transient table db.s.t (id number)',
      'CREATE TEMPORARY TABLE IF NOT EXISTS `shop`.`orders` (`id` INT)',
      'CREATE TABLE [dbo].[Orders] ([Id] INT)',
      'CREATE EXTERNAL TABLE x (a int) LOCATION \'s3://b\'',
    ]) expect(looksLikeSqlDdl(yes), yes).toBe(true);
    for (const no of [
      'CREATE VIEW v AS SELECT 1', 'select * from t', '-- CREATE TABLE t (id int)\nselect 1', '/* CREATE TABLE t (id int) */',
      // A CTAS whose SELECT has parentheses later on, and one in parentheses.
      'CREATE OR REPLACE TABLE gold.x AS SELECT id, count(*) n FROM s GROUP BY id',
      'create table tmp_backfill as (\n  select * from {{ ref(\'dim_customer\') }}\n);',
      'CREATE TABLE t (a, b) AS SELECT 1, 2',
      // A dbt macro: Jinja where the name goes.
      'create or replace table {{ relation }}\n as (\n {{ sql }} );',
      'CREATE TABLE t2 LIKE t1;', 'CREATE TABLE t2 CLONE t1;',
      "SELECT 'create table foo (' AS s",
    ]) {
      expect(looksLikeSqlDdl(no), no).toBe(false);
    }
  });

  it('lists the open folder once for every look: .sql and .dbml in any case, semantic model files, dbt_project.yml; never the ERD Studio folder', async () => {
    const io = memIo({
      'a/X.SQL': '', 'b/y.Dbml': '', 'M.SemanticModel/definition/model.tmdl': '', 'dbt/dbt_project.yml': '',
      '.erd-studio/t.dbml': '', 'erd-studio/u.dbml': '', 'node_modules/p/q.sql': '', '.github/sql/r.sql': '',
    });
    const listing = await listImportFiles('/w', io.readDirectory, { semanticDir: '.erd-studio' });
    expect(listing).toEqual({
      sql: ['/w/.github/sql/r.sql', '/w/a/X.SQL'],
      dbml: ['/w/b/y.Dbml'],
      semanticModel: ['/w/M.SemanticModel/definition/model.tmdl'],
      dbtProject: true,
      truncated: false,
    });
    expect((await listImportFiles('/w', io.readDirectory, { semanticDir: '.erd-studio', limit: 2 })).truncated).toBe(true);
  });

  it('ranks .sql names that usually hold table definitions first, by the path under the open folder only', () => {
    expect(rankSqlFiles(['/w/q1.sql', '/w/db/migration/V2__add.sql', '/w/q2.sql', '/w/sql/schema.sql', '/w/x/create_tables.sql'], '/w'))
      .toEqual(['/w/db/migration/V2__add.sql', '/w/sql/schema.sql', '/w/x/create_tables.sql', '/w/q1.sql', '/w/q2.sql']);
    // The open folder's own name ("schema-tools") says nothing.
    expect(rankSqlFiles(['/home/schema-tools/b.sql', '/home/schema-tools/ddl/a.sql'], '/home/schema-tools'))
      .toEqual(['/home/schema-tools/ddl/a.sql', '/home/schema-tools/b.sql']);
  });

  it('walks a folder in reading order, bounded, skipping tool folders (not other hidden ones) and unreadable ones', async () => {
    const tree: Record<string, Array<[string, boolean]>> = {
      '/r': [['10_b.sql', false], ['2_a.sql', false], ['sub', true], ['node_modules', true], ['.git', true], ['locked', true], ['x.txt', false], ['.devcontainer', true]],
      '/r/sub': [['c.sql', false]],
      '/r/.devcontainer': [['init.sql', false]],
      '/r/node_modules': [['d.sql', false]],
      '/r/.git': [['e.sql', false]],
    };
    const readDir = async (f: string) => { if (!tree[f]) throw new Error('EACCES'); return tree[f]; };
    const all = await walkFiles('/r', readDir, { include: (n) => n.endsWith('.sql'), limit: 10 });
    expect(all).toEqual({ files: ['/r/.devcontainer/init.sql', '/r/2_a.sql', '/r/10_b.sql', '/r/sub/c.sql'], truncated: false });
    expect(await walkFiles('/r', readDir, { include: (n) => n.endsWith('.sql'), limit: 2 })).toMatchObject({ truncated: true });
  });

  it('words problems with file and line, the first three, the rest counted', () => {
    const message = describeImportProblems('Import SQL DDL', [
      { file: 'a.sql', line: 3, message: 'CREATE TABLE x could not be read: bad' },
      { file: 'a.sql', line: 9, message: 'Table y is defined twice (also in b.sql, line 1).' },
      { file: '', message: 'No SQL files to import.' },
      { file: 'c.sql', message: 'Another' },
      { file: 'c.sql', message: 'Another' },
      { file: 'd.sql', message: 'And another' },
    ], 'They were read as MySQL / MariaDB.');
    expect(message).toBe('Import SQL DDL: nothing was imported. a.sql line 3: CREATE TABLE x could not be read: bad. a.sql line 9: Table y is defined twice (also in b.sql, line 1). No SQL files to import. And 2 more problems. They were read as MySQL / MariaDB.');
  });

  it('names converted DBML after the one file, else the folder', () => {
    expect(convertedFileName(['/x/ddl/warehouse.sql'])).toBe('warehouse.dbml');
    expect(convertedFileName(['/x/ddl/a.sql', '/x/ddl/b.sql'])).toBe('ddl.dbml');
    expect(convertedFileName(['/x/ddl/a.sql'], '/x/ddl')).toBe('ddl.dbml');
    expect(convertedFileName(['C:\\db\\shop\\orders.sql'])).toBe('orders.dbml');
  });

  it('names converted SQL from a generic folder after the schema its tables share, else the project folder (onboarding story 04)', () => {
    const sales = 'Table sales.dim_customer {\n}\nTable sales.fct_order_line {\n}\nTable public.audit {\n}\n';
    expect(sqlImportFileName('database.dbml', sales, '/home/me/shop-database')).toBe('sales.dbml');
    // Only default schemas, or a tie: the project folder.
    expect(sqlImportFileName('ddl.dbml', 'Table public.a {\n}\nTable dbo.b {\n}\n', '/home/me/shop')).toBe('shop.dbml');
    expect(sqlImportFileName('scripts.dbml', 'Table x.a {\n}\nTable y.b {\n}\n', 'C:\\work\\billing')).toBe('billing.dbml');
    expect(sqlImportFileName('ddl.dbml', 'Table "Sales Ops".a {\n}\n', '/w')).toBe('sales ops.dbml');
    // A name that already says something is kept.
    expect(sqlImportFileName('warehouse.dbml', sales, '/home/me/shop')).toBe('warehouse.dbml');
    // Nothing better: as it was.
    expect(sqlImportFileName('database.dbml', 'Table a {\n}\n', '/home/me/src')).toBe('database.dbml');
  });

  it('summarises a semantic model\'s skips by kind, leaving out kinds with none', () => {
    expect(semanticModelSkippedSummary({ measures: 1, autoDateTables: 0, calculationGroups: 2, relationships: 1 })).toEqual([
      '1 measure: DAX calculations, not columns.',
      '2 calculation groups: they hold DAX, not data.',
      '1 relationship with an end that is missing, skipped or already joined.',
    ]);
    expect(semanticModelSkippedSummary({ measures: 0, autoDateTables: 0, calculationGroups: 0, relationships: 0 })).toEqual([]);
  });
});
