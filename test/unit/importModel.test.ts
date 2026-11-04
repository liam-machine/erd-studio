/**
 * Import… (`erdStudio.importModel`), the start screen's Import: the three
 * sources, the one the folder seems to hold first (DBML when none), the
 * funnel keys, and the bounded look at the folder behind that order. Also
 * the pure helpers the converting imports share (src/services/importSources.ts).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DETECT_SQL_FILES,
  FOUND_HERE,
  IMPORT_MODEL_COMMAND,
  IMPORT_PICK_FEATURES,
  IMPORT_SOURCE_COMMANDS,
  SEMANTIC_MODEL_GLOB,
  detectExcludeGlob,
  detectImportSources,
  importSourceItems,
  readFileStart,
  runImportModel,
  type DetectImportIo,
  type ImportSourceItem,
} from '../../src/commands/importModel';
import { NO_LEGACY_ALIAS, PRE_REGISTERED_COMMANDS } from '../../src/extension';
import {
  convertedFileName,
  sqlImportFileName,
  describeImportProblems,
  looksLikeSqlDdl,
  orderImportSources,
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
    const ran: string[] = [];
    await runImportModel({
      detect: detect ?? (async () => new Set(found)),
      pick: async (items) => { shown.push([...items]); return items.find((i) => i.source === answer); },
      executeCommand: async (command) => { ran.push(command); },
      detectTimeoutMs: 50,
    });
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

describe('detectImportSources', () => {
  const io = (files: Record<string, string[]>, texts: Record<string, string> = {}): DetectImportIo & { calls: Array<[string, string, number]> } => {
    const calls: Array<[string, string, number]> = [];
    return {
      calls,
      findFiles: async (include, exclude, max) => { calls.push([include, exclude, max]); return (files[include] ?? []).slice(0, max); },
      readStart: async (file) => texts[file] ?? '',
    };
  };

  it('finds a semantic model, a .dbml file and a .sql file holding CREATE TABLE, skipping the ERD Studio folder', async () => {
    const lookups = io({
      [SEMANTIC_MODEL_GLOB]: ['/w/Sales.SemanticModel/definition.pbism'],
      '**/*.dbml': ['/w/schema.dbml'],
      '**/*.sql': ['/w/models/stg.sql', '/w/ddl/tables.sql'],
    }, {
      '/w/models/stg.sql': 'select * from {{ ref("raw") }}',
      '/w/ddl/tables.sql': '-- the warehouse\nCREATE TABLE IF NOT EXISTS sales.orders (\n  id int\n);',
    });
    expect([...await detectImportSources(lookups, '.erd-studio')].sort()).toEqual(['dbml', 'semanticModel', 'sqlDdl']);
    // Bounded: one file for each existence check, at most DETECT_SQL_FILES .sql files, none from tool or ERD Studio folders.
    expect(lookups.calls.map(([, , max]) => max).sort((a, b) => a - b)).toEqual([1, 1, DETECT_SQL_FILES]);
    for (const [, exclude] of lookups.calls) expect(exclude).toBe(detectExcludeGlob('.erd-studio'));
    expect(detectExcludeGlob('.erd-studio')).toBe('**/{node_modules,.git,.venv,venv,target,dbt_packages,.erd-studio}/**');
  });

  it('a dbt project\'s SELECT models are not SQL DDL; a failed lookup is nothing found', async () => {
    const lookups = io({ '**/*.sql': ['/w/a.sql'] }, { '/w/a.sql': 'with x as (select 1) select * from x' });
    expect([...await detectImportSources(lookups, '.erd-studio')]).toEqual([]);
    const broken: DetectImportIo = { findFiles: () => Promise.reject(new Error('gone')), readStart: () => Promise.reject(new Error('gone')) };
    expect([...await detectImportSources(broken, '.erd-studio')]).toEqual([]);
  });

  it('a bare .pbip (a report-only project, live-connected to a published model) is not a semantic model', () => {
    // Every shape findSemanticModels reads holds one of these; a thin report has only X.pbip + X.Report/.
    expect(SEMANTIC_MODEL_GLOB).toBe('**/{*.bim,definition.pbism,model.tmdl,database.tmdl}');
    expect(SEMANTIC_MODEL_GLOB).not.toMatch(/pbip/);
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
    for (const no of ['CREATE VIEW v AS SELECT 1', 'select * from t', '-- CREATE TABLE t (id int)\nselect 1', '/* CREATE TABLE t (id int) */']) {
      expect(looksLikeSqlDdl(no), no).toBe(false);
    }
  });

  it('walks a folder in reading order, bounded, skipping tool and dot folders and unreadable ones', async () => {
    const tree: Record<string, Array<[string, boolean]>> = {
      '/r': [['10_b.sql', false], ['2_a.sql', false], ['sub', true], ['node_modules', true], ['.git', true], ['locked', true], ['x.txt', false]],
      '/r/sub': [['c.sql', false]],
      '/r/node_modules': [['d.sql', false]],
      '/r/.git': [['e.sql', false]],
    };
    const readDir = async (f: string) => { if (!tree[f]) throw new Error('EACCES'); return tree[f]; };
    const all = await walkFiles('/r', readDir, { include: (n) => n.endsWith('.sql'), limit: 10 });
    expect(all).toEqual({ files: ['/r/2_a.sql', '/r/10_b.sql', '/r/sub/c.sql'], truncated: false });
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
