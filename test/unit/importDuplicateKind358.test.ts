/**
 * #358: a SQL import that meets a table defined twice says, beside
 * `importCauseDuplicate`, what the second definition was: a copy of the kept
 * one (`importDuplicateSame`) or not (`importDuplicateDiffers`), one that
 * differed with both in the dialect's default schema, where a second
 * database's table of the same name lands (`importDuplicateDiffersDefaultSchema`),
 * and a partial import whose only problems were those (`importPartialDuplicateOnly`).
 * Each at most once per import, off the trail (`featureQuiet`), automatic
 * draft included. What the import does and says is unchanged: the first
 * definition is kept, Partial is still Partial, the message is word for word
 * the same.
 *
 * The rule tests run end to end through Import SQL DDL… on a folder, with the
 * real engine. They are red on origin/develop 535270c8, where a copy and a
 * differing version record exactly the same keys.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import { fakeDraftPreview } from './helpers/draftDriver';
import type { ImportDbmlUi } from '../../src/commands/importDbml';
import { importSqlDdl, quickImportSqlDdl, sqlPartialNotice, type ImportSqlDdlDeps, type ImportSqlDdlUi, type SqlSources } from '../../src/commands/importSqlDdl';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import type { SqlDialect } from '../../src/services/sqlDdlImport';
import * as engine from '../../src/services/sqlImportEngine';
import { sqlDdlToDbml } from '../../src/services/sqlImportEngine';
import { FEATURES } from '../../src/services/telemetryPayload';
import { telemetry } from '../../src/services/telemetryService';

const NEW_KEYS = ['importDuplicateSame', 'importDuplicateDiffers', 'importDuplicateDiffersDefaultSchema', 'importPartialDuplicateOnly'];

let tmp: string;
let quiet: ReturnType<typeof vi.spyOn>;
let feature: ReturnType<typeof vi.spyOn>;
const quietKeys = (): string[] => quiet.mock.calls.map((c: unknown[]) => String(c[0]));
const trailKeys = (): string[] => feature.mock.calls.map((c: unknown[]) => String(c[0]));
/** The #358 keys recorded, in order. */
const dupKeys = (): string[] => quietKeys().filter((k) => NEW_KEYS.includes(k));

function sqlUi(sources: SqlSources, dialect: SqlDialect): ImportSqlDdlUi {
  return {
    pickSources: async () => sources,
    readDirectory: async (folder) => fs.readdirSync(folder, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
    readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
    pickDialect: async (items) => items.find((i) => i.dialect === dialect),
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    openFileAt: async () => {},
    sendFeedback: async () => {},
  };
}

function importUi(): ImportDbmlUi {
  return {
    pickFile: async () => undefined,
    readFile: async () => { throw new Error('unused'); },
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) =>
      (items as unknown as Array<{ id: string }>).find((i) => i.id === 'gold') as unknown as T | undefined,
    showInputBox: async (options) => options.value,
    confirm: async () => true,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    openFileAt: async () => {},
    showFile: async () => {},
    openDiagram: async () => {},
    addLayer: async () => {},
    sendFeedback: async () => {},
  };
}

function deps(sql: ImportSqlDdlUi, more: Partial<ImportSqlDdlDeps> = {}): ImportSqlDdlDeps {
  const layerService = new LayerService(tmp, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return {
    workspaceRoot: tmp, semanticDir: '.erd-studio', layerService, subjectAreaService, tableLibraryService,
    validateDomainName: () => undefined, onWritten: () => {},
    extensionPath: '/nowhere', sqlUi: sql, ui: importUi(), loadSqlImport: () => engine,
    ...more,
  };
}

/** Writes `files` (relative path → SQL) under a fresh `scripts/` folder and imports the folder. */
async function importFolder(dialect: SqlDialect, files: Record<string, string>): Promise<Awaited<ReturnType<typeof importSqlDdl>>> {
  const folder = path.join(tmp, 'scripts');
  fs.rmSync(folder, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, rel)), { recursive: true });
    fs.writeFileSync(path.join(folder, rel), text);
  }
  return importSqlDdl(deps(sqlUi({ folder }, dialect)));
}

/** The converter alone: its duplicate problems' telemetry-only flags. */
function duplicateFlags(dialect: SqlDialect, files: Record<string, string>): unknown[] {
  const r = sqlDdlToDbml({ dialect, files: Object.entries(files).map(([name, text]) => ({ name, text })) });
  return (r.problems ?? []).filter((p) => p.kind === 'duplicateTable').map((p) => p.duplicate);
}

const ORDERS = 'CREATE TABLE orders (\n  id int PRIMARY KEY,\n  total numeric(10,2)\n);\n';
const ORDERS_V2 = 'CREATE TABLE orders (\n  id int PRIMARY KEY,\n  total numeric(10,2),\n  customer_id int\n);\n';

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-358-'));
  quiet = vi.spyOn(telemetry, 'featureQuiet');
  feature = vi.spyOn(telemetry, 'feature');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('#358 what kind of table was defined twice (red on origin/develop)', () => {
  it('the four keys exist in FEATURES and the Worker list, appended last, in the same order', () => {
    const worker = fs.readFileSync(path.join(__dirname, '../../telemetry/src/index.js'), 'utf8');
    for (const key of NEW_KEYS) {
      expect((FEATURES as readonly string[]).includes(key), `FEATURES has ${key}`).toBe(true);
      expect(worker.includes(`'${key}'`), `Worker has ${key}`).toBe(true);
    }
    expect(FEATURES.slice(FEATURES.indexOf('importDuplicateSame'))).toEqual(NEW_KEYS);
    expect(Math.max(...NEW_KEYS.map((k) => k.length))).toBeLessThanOrEqual(35);
  });

  it('an identical copy in two files, unqualified: importDuplicateSame and importPartialDuplicateOnly, off the trail', async () => {
    await importFolder('postgres', { 'a.sql': ORDERS, 'backup/a.sql': ORDERS });
    expect(quietKeys()).toEqual(['importOutcomeSqlDdlPartial', 'importSqlOutcomePostgresPartial', 'importCauseDuplicate', 'importDuplicateSame', 'importPartialDuplicateOnly']);
    expect(trailKeys().filter((k) => NEW_KEYS.includes(k))).toEqual([]);
  });

  it('a differing version (v1/ and v2/), unqualified: importDuplicateDiffers and importDuplicateDiffersDefaultSchema', async () => {
    await importFolder('postgres', { 'v1/orders.sql': ORDERS, 'v2/orders.sql': ORDERS_V2 });
    expect(dupKeys()).toEqual(['importDuplicateDiffers', 'importDuplicateDiffersDefaultSchema', 'importPartialDuplicateOnly']);
  });

  it('a copy in a schema that is not the default, in both files: Same and never DefaultSchema; a differing one there is Differs alone', async () => {
    const q = ORDERS.replace('CREATE TABLE orders', 'CREATE TABLE sales.orders');
    await importFolder('postgres', { 'a.sql': q, 'b.sql': q });
    expect(dupKeys()).toEqual(['importDuplicateSame', 'importPartialDuplicateOnly']);
    quiet.mockClear();
    await importFolder('postgres', { 'a.sql': q, 'b.sql': ORDERS_V2.replace('CREATE TABLE orders', 'CREATE TABLE sales.orders') });
    expect(dupKeys()).toEqual(['importDuplicateDiffers', 'importPartialDuplicateOnly']);
  });

  it('pg_dump: public.orders in two dumps, differing, is in the default schema', async () => {
    const dump = (body: string): string => `SET search_path = public;\n${body.replace('CREATE TABLE orders', 'CREATE TABLE public.orders')}`;
    await importFolder('postgres', { 'db1.sql': dump(ORDERS), 'db2.sql': dump(ORDERS_V2) });
    expect(dupKeys()).toEqual(['importDuplicateDiffers', 'importDuplicateDiffersDefaultSchema', 'importPartialDuplicateOnly']);
  });

  it('SQL Server: USE db1 / USE db2 with [dbo].[t] that differ lands in DiffersDefaultSchema (two databases merged), and so does a three-part name', async () => {
    await importFolder('sqlserver', {
      'db1.sql': 'USE [db1];\nGO\nCREATE TABLE [dbo].[t] (id int, a_only int);\nGO\n',
      'db2.sql': 'USE [db2];\nGO\nCREATE TABLE [dbo].[t] (id int, b_only int);\nGO\n',
    });
    expect(dupKeys()).toEqual(['importDuplicateDiffers', 'importDuplicateDiffersDefaultSchema', 'importPartialDuplicateOnly']);
    expect(duplicateFlags('sqlserver', {
      'db1.sql': 'CREATE TABLE db1.dbo.t (id int, a_only int);\n',
      'db2.sql': 'CREATE TABLE db2.dbo.t (id int, b_only int);\n',
    })).toEqual([{ same: false, defaultSchema: true }]);
  });

  it('MySQL: USE db1 / USE db2 keep both tables, so no duplicate and none of the keys', async () => {
    await importFolder('mysql', {
      'db1.sql': 'USE db1;\nCREATE TABLE orders (id int, a_only int);\n',
      'db2.sql': 'USE db2;\nCREATE TABLE orders (id int, b_only int);\n',
    });
    expect(quietKeys()).not.toContain('importCauseDuplicate');
    expect(dupKeys()).toEqual([]);
  });

  it('column order, and a type\'s case and spacing, do not make a copy differ', () => {
    expect(duplicateFlags('postgres', {
      'a.sql': 'CREATE TABLE orders (id int PRIMARY KEY, name VARCHAR (50) NOT NULL);\n',
      'b.sql': 'CREATE TABLE orders (Name varchar(50) NOT NULL, ID INT PRIMARY KEY);\n',
    })).toEqual([{ same: true, defaultSchema: true }]);
    // An inline key and the same key as a table constraint are one key.
    expect(duplicateFlags('postgres', {
      'a.sql': 'CREATE TABLE orders (id int PRIMARY KEY, total int);\n',
      'b.sql': 'CREATE TABLE orders (id int, total int, PRIMARY KEY (id));\n',
    })).toEqual([{ same: true, defaultSchema: true }]);
    // A key column is NOT NULL whether or not it says so.
    expect(duplicateFlags('postgres', {
      'a.sql': 'CREATE TABLE t (id int PRIMARY KEY, x int);\n',
      'b.sql': 'CREATE TABLE t (id int NOT NULL PRIMARY KEY, x int);\n',
    })).toEqual([{ same: true, defaultSchema: true }]);
    expect(duplicateFlags('postgres', {
      'a.sql': 'CREATE TABLE ol (a int, b int, PRIMARY KEY (a, b));\n',
      'b.sql': 'CREATE TABLE ol (a int NOT NULL, b int NOT NULL, PRIMARY KEY (b, a));\n',
    })).toEqual([{ same: true, defaultSchema: true }]);
  });

  it('an identical copy of a script that ALTERs its table is still Same: each definition is compared as its own CREATE left it', async () => {
    const script = 'CREATE TABLE t (id int, x int);\nALTER TABLE t ADD COLUMN y int;\n';
    await importFolder('postgres', { 'a.sql': script, 'backup/a.sql': script });
    expect(dupKeys()).toEqual(['importDuplicateSame', 'importPartialDuplicateOnly']);

    const copy = (dialect: SqlDialect, text: string): unknown[] => duplicateFlags(dialect, { 'a.sql': text, 'backup/a.sql': text });
    const create = 'CREATE TABLE t (id int, x int);\n';
    for (const alter of [
      'ALTER TABLE t ADD COLUMN y int;',
      'ALTER TABLE t DROP COLUMN x;',
      'ALTER TABLE t ALTER COLUMN x TYPE bigint;',
      'ALTER TABLE t ALTER COLUMN x SET NOT NULL;',
    ]) expect(copy('postgres', `${create}${alter}\n`), alter).toEqual([{ same: true, defaultSchema: true }]);
    expect(copy('mysql', `${create}ALTER TABLE t ADD y int;\n`)).toEqual([{ same: true, defaultSchema: true }]);
    expect(copy('sqlserver', 'CREATE TABLE dbo.t (id int, x int);\nALTER TABLE dbo.t ADD y int;\n')).toEqual([{ same: true, defaultSchema: true }]);
    // pg_dump's deferred key on both copies still reads Same.
    expect(copy('postgres', `${create}ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (id);\n`)).toEqual([{ same: true, defaultSchema: true }]);
    // A CREATE that already has the column an ALTER added to the other is written differently: Differs.
    expect(duplicateFlags('postgres', {
      'a.sql': `${create}ALTER TABLE t ADD COLUMN y int;\n`,
      'b.sql': 'CREATE TABLE t (id int, x int, y int);\n',
    })).toEqual([{ same: false, defaultSchema: true }]);
  });

  it('a primary key, a NOT NULL, a type or a column name alone makes it differ', () => {
    const differs = (a: string, b: string): unknown[] => duplicateFlags('postgres', { 'a.sql': a, 'b.sql': b });
    const base = 'CREATE TABLE orders (id int PRIMARY KEY, total int);\n';
    expect(differs(base, 'CREATE TABLE orders (id int, total int);\n')).toEqual([{ same: false, defaultSchema: true }]);
    expect(differs(base, 'CREATE TABLE orders (id int PRIMARY KEY, total int NOT NULL);\n')).toEqual([{ same: false, defaultSchema: true }]);
    expect(differs(base, 'CREATE TABLE orders (id int PRIMARY KEY, total bigint);\n')).toEqual([{ same: false, defaultSchema: true }]);
    expect(differs(base, 'CREATE TABLE orders (id int PRIMARY KEY, amount int);\n')).toEqual([{ same: false, defaultSchema: true }]);
    // A composite key on other columns.
    expect(differs('CREATE TABLE ol (a int, b int, PRIMARY KEY (a, b));\n', 'CREATE TABLE ol (a int, b int, PRIMARY KEY (a));\n')).toEqual([{ same: false, defaultSchema: true }]);
  });

  it('CREATE OR REPLACE alone meets importCauseDuplicate (a changed entry) and none of the four keys', async () => {
    await importFolder('snowflake', {
      'a.sql': 'CREATE TABLE orders (id int, total int);\n',
      'b.sql': 'CREATE OR REPLACE TABLE orders (id int, total int, note varchar);\n',
    });
    expect(quietKeys()).toContain('importCauseDuplicate');
    expect(dupKeys()).toEqual([]);
  });

  it('a duplicate beside a statement that did not read: Partial, with Same but without importPartialDuplicateOnly', async () => {
    await importFolder('postgres', { 'a.sql': ORDERS, 'b.sql': ORDERS, 'c.sql': 'CREATE TABLE broken (id int,, x int);\n' });
    expect(quietKeys()).toContain('importOutcomeSqlDdlPartial');
    expect(dupKeys()).toEqual(['importDuplicateSame']);
  });

  it('two copies and a differing version in one import: each key once', async () => {
    await importFolder('postgres', { 'a.sql': ORDERS, 'b.sql': ORDERS, 'c.sql': ORDERS_V2, 'd.sql': ORDERS_V2 });
    expect(dupKeys()).toEqual(['importDuplicateSame', 'importDuplicateDiffers', 'importDuplicateDiffersDefaultSchema', 'importPartialDuplicateOnly']);
  });

  it('the automatic draft (quiet) records them too, with featureQuiet, as it does importCauseDuplicate', async () => {
    fs.writeFileSync(path.join(tmp, 'a.sql'), ORDERS);
    fs.writeFileSync(path.join(tmp, 'b.sql'), ORDERS_V2);
    const preview = fakeDraftPreview(['discard']);
    const draft = { preview, trigger: 'sidebar' as const, quiet: true, quietDrop: () => {} };
    await quickImportSqlDdl(deps(sqlUi({ folder: tmp }, 'postgres'), { draft }));
    expect(preview.drafts).toHaveLength(1);
    expect(quietKeys()).toContain('importCauseDuplicate');
    expect(dupKeys()).toEqual(['importDuplicateDiffers', 'importDuplicateDiffersDefaultSchema', 'importPartialDuplicateOnly']);
    expect(trailKeys().filter((k) => NEW_KEYS.includes(k))).toEqual([]);
  });

  it('the flags are plain data: the import worker\'s structured clone carries them', () => {
    const r = sqlDdlToDbml({ dialect: 'postgres', files: [{ name: 'a.sql', text: ORDERS }, { name: 'b.sql', text: ORDERS_V2 }] });
    expect(structuredClone(r).problems?.[0].duplicate).toEqual({ same: false, defaultSchema: true });
  });
});

describe('#358 what the import does and says is unchanged (green on both builds)', () => {
  it('a duplicate-only import (every table read) is still counted Partial', async () => {
    const result = await importFolder('mysql', { 'a.sql': ORDERS, 'b.sql': ORDERS });
    expect(result?.plan.newTables.map((t) => t.name)).toEqual(['orders']);
    expect(quietKeys().slice(0, 2)).toEqual(['importOutcomeSqlDdlPartial', 'importSqlOutcomeMysqlPartial']);
  });

  it('v1/ before v2/: the first definition is still the one kept', async () => {
    const result = await importFolder('postgres', { 'v1/orders.sql': ORDERS, 'v2/orders.sql': ORDERS_V2 });
    const orders = result?.plan.newTables.find((t) => t.name === 'orders');
    expect(orders?.columns.map((c) => c.name)).toEqual(['id', 'total']);
  });

  it('the message and the draft\'s notice are word for word the same', () => {
    const r = sqlDdlToDbml({ dialect: 'postgres', files: [{ name: 'a.sql', text: ORDERS }, { name: 'backup/a.sql', text: ORDERS }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.problems.map((p) => p.message)).toEqual(['Table orders is defined twice (also in a.sql, line 1); the first definition is kept.']);
    expect(sqlPartialNotice(r)).toMatch(/defined twice \(the first definition is kept\)/);
  });

  it('SQL Server: two databases\' orders tables are still merged into one (a product follow-up, not changed here)', () => {
    const r = sqlDdlToDbml({
      dialect: 'sqlserver',
      files: [
        { name: 'db1.sql', text: 'USE db1;\nCREATE TABLE orders (id int, a_only int);\n' },
        { name: 'db2.sql', text: 'USE db2;\nCREATE TABLE orders (id int, b_only int);\n' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tableCount).toBe(1);
    expect(r.dbml).toContain('a_only');
    expect(r.dbml).not.toContain('b_only');
    expect(r.problems.map((p) => [p.kind, p.cause])).toEqual([['duplicateTable', 'duplicate']]);
  });
});
