/**
 * The extension host and the CLI on the v6 file naming (#162 parts 3 and 4,
 * #181, #182): `tables/` beside `logical-models/`, a `tables` layer made
 * before v6, a table in both folders, and every write landing in the naming
 * its file already uses.
 *
 * Drives the real provider and services over a temp copy of the fixture dbt
 * project, turned (wholly or partly) into the v6 naming by `toTableNaming`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService, renameSubjectAreaInRaw } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService, TableNamingWriteRefused, tablesDirIsLayer } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { MigrationService } from '../../src/services/migrationService';
import { moveRelationshipsToLibrary } from '../../src/commands/moveRelationshipsToLibrary';
import { redactPaths } from '../../src/types/feedback';
import { runDoctor } from '../../src/cli/doctor';
import { formatDoctor, makePaint } from '../../src/cli/format';
import { allSelections } from '../../src/services/syncPlanBuilder';
import { detectSubjectAreaFormat } from '@erd-studio/core';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');

type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
type Posted = { type: string; payload?: any };

const posted = (panel: MockPanel) => panel._postedMessages as Posted[];
const errors = (panel: MockPanel) => posted(panel).filter((m) => m.type === 'error');

let root: string;
let erd: string;

/** Rename a domain file's v5 keys to v6, as part 4's migration will. */
function domainToV6(file: string): void {
  const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const { domain, logical, ...rest } = doc;
  const { models, relationships, ...logicalRest } = logical;
  fs.writeFileSync(file, JSON.stringify({
    ...rest,
    schemaVersion: 6,
    ...(domain !== undefined ? { subjectArea: domain } : {}),
    logical: {
      ...logicalRest,
      tables: models,
      relationships: (relationships ?? []).map(({ fromModel, toModel, ...r }: Record<string, unknown>) =>
        ({ fromTable: fromModel, toTable: toModel, ...r })),
    },
  }, null, 2) + '\n');
}

/** Move model files from `logical-models/` to `tables/`, renaming their v5 keys. */
function tablesToV6(names: readonly string[]): void {
  fs.mkdirSync(path.join(erd, 'tables'), { recursive: true });
  for (const name of names) {
    const from = path.join(erd, 'logical-models', `${name}.yml`);
    const text = fs.readFileSync(from, 'utf-8')
      .replace(/^(\s*)modelRole:/m, '$1tableRole:')
      .replace(/^(\s*(?:- )?)toModel:/gm, '$1toTable:');
    fs.writeFileSync(path.join(erd, 'tables', `${name}.yml`), text);
    fs.rmSync(from);
  }
}

function allTables(): string[] {
  return fs.readdirSync(path.join(erd, 'logical-models')).filter((f) => f.endsWith('.yml')).map((f) => f.replace(/\.yml$/, ''));
}

/** The whole project in the v6 naming. */
function toTableNaming(): void {
  tablesToV6(allTables());
  fs.rmdirSync(path.join(erd, 'logical-models'));
  for (const layer of ['silver', 'gold']) {
    for (const f of fs.readdirSync(path.join(erd, layer))) domainToV6(path.join(erd, layer, f));
  }
}

function makeDoc(fsPath: string) {
  const text = fs.readFileSync(fsPath, 'utf-8');
  return {
    uri: vscode.Uri.file(fsPath),
    isDirty: false,
    isClosed: false,
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
    save: vi.fn(async () => true),
  };
}

function buildProvider() {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const selectorsService = new SelectorsService(subjectAreaService, root, '.erd-studio');
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: { get: () => true, update: async () => {} },
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  const provider = new SemanticEditorProvider(
    context, subjectAreaService, new ManifestService(), new YmlParserService(), new TemplateService(),
    layerService, root, selectorsService, tableLibraryService,
  );
  return { provider, subjectAreaService, tableLibraryService, layerService };
}

async function open(relative: string) {
  const file = path.join(erd, relative);
  const { provider } = buildProvider();
  const doc = makeDoc(file);
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  await panel._simulateMessage({ type: 'ready' });
  await vi.waitFor(
    () => expect(posted(panel).some((m) => m.type === 'domainLoaded' || m.type === 'error')).toBe(true),
    { timeout: 4000, interval: 20 },
  );
  return { doc, panel };
}

/** Open `relative` on a canvas whose edits really land: applyEdit and save write the files (#182). */
async function openWritable(relative: string) {
  vi.mocked(vscode.workspace.applyEdit).mockRestore();
  const file = path.join(erd, relative);
  const { provider, tableLibraryService } = buildProvider();
  const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  await panel._simulateMessage({ type: 'ready' });
  await vi.waitFor(
    () => expect(posted(panel).some((m) => m.type === 'domainLoaded' || m.type === 'error')).toBe(true),
    { timeout: 4000, interval: 20 },
  );
  return { doc, panel, tableLibraryService };
}

/** The v5 keys a v6 file must never hold, wherever they are written (#182). */
const V5_JSON_KEYS = /"(domain|models|fromModel|toModel|linkedModel)"\s*:/;
const V5_YML_KEYS = /^\s*(?:- )?(modelRole|toModel|fromModel)\s*:/m;

/** Every subject area file is still v6 and every table file in `tables/` uses only v6 keys; `logical-models/` never comes back. */
function expectStillV6(): void {
  for (const [file, text] of snapshot()) {
    const rel = path.relative(erd, file).split(path.sep).join('/');
    if (/^(silver|gold)\/[^/]+\.json$/.test(rel)) {
      expect(detectSubjectAreaFormat(JSON.parse(text)), rel).toBe('v6');
      expect(text, rel).not.toMatch(V5_JSON_KEYS);
    } else if (rel.startsWith('tables/')) {
      expect(text, rel).not.toMatch(V5_YML_KEYS);
    }
  }
  expect(fs.existsSync(path.join(erd, 'logical-models'))).toBe(false);
}

/** Every file under the semantic dir, path → bytes. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.set(p, fs.readFileSync(p, 'utf-8'));
    }
  };
  walk(erd);
  return out;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-table-naming-'));
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  erd = path.join(root, '.erd-studio');
  vscode._resetMockWorkspace();
  vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// The same routes semanticEditorProvider.conflictedEdit.test.ts drives (#151).
const EDITS: Array<[string, { type: string; payload?: unknown }]> = [
  ['addModel', { type: 'addModel', payload: { name: 'dim_new', schema: '', description: '', columns: [] } }],
  ['updatePositions', { type: 'updatePositions', payload: { positions: { dim_task: { x: 1, y: 2 } } } }],
  ['removeModel', { type: 'removeModel', payload: { modelName: 'dim_task' } }],
  ['renameModel', { type: 'renameModel', payload: { oldName: 'dim_task', newName: 'dim_job' } }],
  ['addColumn', { type: 'addColumn', payload: { modelName: 'dim_task', column: { name: 'extra', dataType: 'INT' } } }],
  ['removeColumn', { type: 'removeColumn', payload: { modelName: 'dim_task', columnName: 'name' } }],
  ['updateModelDescription', { type: 'updateModelDescription', payload: { modelName: 'dim_task', description: 'x' } }],
  ['updateModelAlias', { type: 'updateModelAlias', payload: { modelName: 'dim_task', alias: 'task' } }],
  ['addAnnotation', { type: 'addAnnotation', payload: { id: 'note', text: 'note', x: 1, y: 1 } }],
  ['addRelationship', {
    type: 'addRelationship',
    payload: { fromModel: 'fct_task_event', fromColumn: 'project_key', toModel: 'dim_project', toColumn: 'project_key', cardinality: 'many-to-one' },
  }],
  ['removeRelationship', {
    type: 'removeRelationship',
    payload: { fromModel: 'fct_task_event', fromColumn: 'task_key', toModel: 'dim_task', toColumn: 'task_key' },
  }],
];

describe('a project in the v6 naming on the canvas', () => {
  it('opens the showcase diagram editable, with every table and relationship, and writes nothing', async () => {
    toTableNaming();
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const before = snapshot();
    const { panel } = await open('silver/showcase.json');

    expect(errors(panel)).toEqual([]);
    const loaded = posted(panel).find((m) => m.type === 'domainLoaded')!.payload;
    expect(loaded.readOnly).toBe(false);
    expect(loaded.schemaVersion).toBe(6);
    expect(loaded.models.map((m: { name: string }) => m.name).sort()).toEqual(
      ['dim_customer', 'dim_date', 'dim_project', 'dim_task', 'fct_order', 'fct_task_event'],
    );
    expect(loaded.models.every((m: { columns: unknown[] }) => m.columns.length > 0)).toBe(true);
    expect(loaded.relationships.length).toBeGreaterThan(0);
    expect(info.mock.calls.some(([m]) => /read-only|cannot edit/.test(m as string))).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    // The first-load usage survey reads it as v5 does, without an error.
    expect(vi.mocked(console.error).mock.calls.map(([m]) => String(m))).not.toContain('[SemanticEditorProvider] relationship survey failed:');
  });

  // addRelationship's fixture link is already drawn; the next test adds a new one.
  it.each(EDITS.filter(([name]) => name !== 'addRelationship'))('%s lands, and every file stays in the v6 naming (#182)', async (_name, message) => {
    toTableNaming();
    const { panel } = await openWritable('silver/showcase.json');
    const before = snapshot();
    panel._postedMessages.length = 0;

    await panel._simulateMessage(message);

    expect(errors(panel)).toEqual([]);
    expect(snapshot()).not.toEqual(before);
    expectStillV6();
  });

  it('a new table goes to tables/, and a relationship added to it is stored with fromTable / toTable', async () => {
    toTableNaming();
    const { panel } = await openWritable('silver/showcase.json');
    await panel._simulateMessage({ type: 'addModel', payload: { name: 'dim_new', schema: '', description: '', columns: [{ name: 'k', dataType: 'INT', isPrimaryKey: true }] } });
    await panel._simulateMessage({ type: 'addColumn', payload: { modelName: 'fct_task_event', column: { name: 'new_key', dataType: 'INT' } } });
    await panel._simulateMessage({ type: 'updateModelRole', payload: { modelName: 'dim_new', modelRole: 'reference' } });
    await panel._simulateMessage({
      type: 'addRelationship',
      payload: { fromModel: 'fct_task_event', fromColumn: 'new_key', toModel: 'dim_new', toColumn: 'k', cardinality: 'many-to-one' },
    });
    expect(errors(panel)).toEqual([]);
    const showcase = JSON.parse(fs.readFileSync(path.join(erd, 'silver', 'showcase.json'), 'utf-8'));
    expect(showcase.logical.tables).toContain('dim_new');
    expect(fs.existsSync(path.join(erd, 'tables', 'dim_new.yml'))).toBe(true);
    // This project keeps relationships in its diagrams.
    expect(showcase.logical.relationships).toContainEqual(expect.objectContaining({ fromTable: 'fct_task_event', toTable: 'dim_new', fromColumn: 'new_key' }));
    expect(fs.readFileSync(path.join(erd, 'tables', 'dim_new.yml'), 'utf-8')).toMatch(/^tableRole: reference$/m);
    expectStillV6();
  });

  it('a rename reaches another v6 diagram, which stays v6', async () => {
    toTableNaming();
    const other = path.join(erd, 'silver', 'tasks_v6.json');
    fs.writeFileSync(other, JSON.stringify({
      schemaVersion: 6, subjectArea: 'tasks_v6', layer: 'silver', logical: { tables: ['dim_task'], relationships: [] }, viewConfig: {},
    }, null, 2) + '\n');
    const { panel } = await openWritable('silver/showcase.json');
    await panel._simulateMessage({ type: 'renameModel', payload: { oldName: 'dim_task', newName: 'dim_job' } });
    expect(errors(panel)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(other, 'utf-8')).logical.tables).toEqual(['dim_job']);
    expect(fs.existsSync(path.join(erd, 'tables', 'dim_job.yml'))).toBe(true);
    expectStillV6();
  });
});

describe('a mixed project (#181)', () => {
  it('a v5 diagram draws a table from tables/, and an edit to it keeps that file in v6', async () => {
    tablesToV6(['dim_task']);
    const { panel } = await openWritable('silver/showcase.json');
    const loaded = posted(panel).find((m) => m.type === 'domainLoaded')!.payload;
    expect(loaded.readOnly).toBe(false);
    const task = loaded.models.find((m: { name: string }) => m.name === 'dim_task');
    expect(task.columns.length).toBeGreaterThan(0);
    // tableRole is read as the role it renames.
    expect(task.modelRole).toBe('domain-dim');

    const showcaseBefore = fs.readFileSync(path.join(erd, 'silver', 'showcase.json'), 'utf-8');
    panel._postedMessages.length = 0;
    await panel._simulateMessage({ type: 'updateModelDescription', payload: { modelName: 'dim_task', description: 'x' } });
    await panel._simulateMessage({ type: 'updateModelRole', payload: { modelName: 'dim_task', modelRole: 'reference' } });
    expect(errors(panel)).toEqual([]);
    const text = fs.readFileSync(path.join(erd, 'tables', 'dim_task.yml'), 'utf-8');
    expect(text).toMatch(/^tableRole: reference$/m);
    expect(text).not.toMatch(V5_YML_KEYS);
    // The v5 diagram stays v5.
    expect(fs.readFileSync(path.join(erd, 'silver', 'showcase.json'), 'utf-8')).toBe(showcaseBefore);
  });

  it('a rename that a v6 diagram follows rewrites it in v6, and the v5 diagram in v5', async () => {
    const v6 = path.join(erd, 'silver', 'tasks_v6.json');
    fs.writeFileSync(v6, JSON.stringify({
      schemaVersion: 6, subjectArea: 'tasks_v6', layer: 'silver', logical: { tables: ['dim_task'], relationships: [] }, viewConfig: {},
    }, null, 2) + '\n');
    const { panel } = await openWritable('silver/showcase.json');

    await panel._simulateMessage({ type: 'renameModel', payload: { oldName: 'dim_task', newName: 'dim_job' } });

    expect(errors(panel)).toEqual([]);
    expect(fs.readFileSync(v6, 'utf-8')).toBe(JSON.stringify({
      schemaVersion: 6, subjectArea: 'tasks_v6', layer: 'silver', logical: { tables: ['dim_job'], relationships: [] }, viewConfig: {},
    }, null, 2) + '\n');
    const showcase = JSON.parse(fs.readFileSync(path.join(erd, 'silver', 'showcase.json'), 'utf-8'));
    expect(detectSubjectAreaFormat(showcase)).toBe('v5');
    expect(showcase.logical.models).toContain('dim_job');
  });

  it('a rename keeps a logical-models/ file in logical-models/, under its v5 keys (#182)', async () => {
    tablesToV6(['dim_task']);
    const { panel } = await openWritable('silver/showcase.json');
    await panel._simulateMessage({ type: 'renameModel', payload: { oldName: 'dim_customer', newName: 'dim_client' } });
    expect(errors(panel)).toEqual([]);
    expect(fs.existsSync(path.join(erd, 'logical-models', 'dim_client.yml'))).toBe(true);
    expect(fs.existsSync(path.join(erd, 'tables', 'dim_client.yml'))).toBe(false);
  });

  it('a table in both folders is drawn from logical-models/ and reported, ignoring case', async () => {
    fs.mkdirSync(path.join(erd, 'tables'));
    fs.writeFileSync(path.join(erd, 'tables', 'DIM_TASK.yml'), 'name: DIM_TASK\ncolumns:\n  - name: only_in_v6\n    dataType: INT\n');
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const { panel } = await open('silver/showcase.json');

    const task = posted(panel).find((m) => m.type === 'domainLoaded')!.payload.models.find((m: { name: string }) => m.name === 'dim_task');
    expect(task.columns.map((c: { name: string }) => c.name)).not.toContain('only_in_v6');
    const toast = warn.mock.calls.map(([m]) => m as string).find((m) => m.includes('old and the new table folder'));
    expect(toast).toBe(
      '"DIM_TASK" has a file in both the old and the new table folder. silver/showcase uses logical-models/dim_task.yml; '
      + "tables/DIM_TASK.yml is ignored. Delete the copy you don't want.",
    );
    // No "Fix…": that fix rewrites files, and the v6 one is not written. Open Both Files is the way to them (#205).
    expect(warn.mock.calls.find(([m]) => (m as string).includes('old and the new'))!.slice(1)).toEqual(['Open Both Files']);
  });

  it('a table in both folders only half-way through a held migration or Convert is not reported', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const { provider, tableLibraryService } = buildProvider();
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      makeDoc(path.join(erd, 'silver', 'showcase.json')) as unknown as import('vscode').TextDocument,
      panel as unknown as import('vscode').WebviewPanel,
      {} as import('vscode').CancellationToken,
    );
    await panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(posted(panel).some((m) => m.type === 'domainLoaded')).toBe(true), { timeout: 4000, interval: 20 });
    const bothFolders = (): string[] => warn.mock.calls.map(([m]) => m as string).filter((m) => m.includes('old and the new'));

    // Mid-apply: the new file exists, the old one is not deleted yet, and the watcher refreshes.
    const release = provider.holdRefreshes();
    fs.mkdirSync(path.join(erd, 'tables'));
    fs.writeFileSync(path.join(erd, 'tables', 'dim_task.yml'), 'name: dim_task\ncolumns:\n  - name: id\n    dataType: INT\n');
    tableLibraryService.invalidateCache();
    await provider.refreshSubjectAreasReferencingTable('dim_task');
    await provider.refreshAllOpenSubjectAreas();
    await provider.refreshSubjectAreaPanel(path.join(erd, 'silver', 'showcase.json'));
    expect(bothFolders()).toEqual([]);

    // Released with both files really there: the warning is still given.
    release();
    release();
    await provider.refreshAllOpenSubjectAreas();
    expect(bothFolders()).toHaveLength(1);
  });
});

describe('TableLibraryService with tables/', () => {
  it('lists both folders, logical-models/ first, and finds a table in either', () => {
    tablesToV6(['dim_task', 'dim_date']);
    const lib = new TableLibraryService(root, '.erd-studio');
    const files = lib.listTableFiles();
    expect(files.filter((f) => f.library === 'tables').map((f) => f.name)).toEqual(['dim_date', 'dim_task']);
    expect(files.filter((f) => !f.library).map((f) => f.name)).not.toContain('dim_task');
    expect(lib.getTable('dim_task')?.modelRole).toBe('domain-dim');
    expect(lib.tableLibraryFile('dim_task')).toBe('tables/dim_task.yml');
    expect(lib.tableLibraryFile('fct_order')).toBe('logical-models/fct_order.yml');
    expect(lib.tableFolder('dim_task')).toBe('');
    expect(lib.hasTablesLibrary()).toBe(true);
  });

  it('writes, renames and deletes a file in tables/ under the v6 keys (#182)', () => {
    tablesToV6(['dim_task']);
    const lib = new TableLibraryService(root, '.erd-studio');
    const model = lib.getTable('dim_task')!;
    lib.saveTable({ ...model, description: 'x', modelRole: 'reference' });
    const saved = fs.readFileSync(path.join(erd, 'tables', 'dim_task.yml'), 'utf-8');
    expect(saved).toMatch(/^tableRole: reference$/m);
    expect(saved).not.toMatch(V5_YML_KEYS);
    lib.renameTable('dim_task', 'dim_job');
    expect(fs.existsSync(path.join(erd, 'tables', 'dim_job.yml'))).toBe(true);
    expect(fs.existsSync(path.join(erd, 'tables', 'dim_task.yml'))).toBe(false);
    lib.deleteTable('dim_job');
    expect(fs.existsSync(path.join(erd, 'tables', 'dim_job.yml'))).toBe(false);
  });

  it('writes new tables to logical-models/ while the project is v5, and to tables/ once it is mixed or v6', () => {
    const lib = new TableLibraryService(root, '.erd-studio');
    lib.saveTable({ name: 'dim_new', columns: [] });
    expect(fs.existsSync(path.join(erd, 'logical-models', 'dim_new.yml'))).toBe(true);
    tablesToV6(['dim_task']);
    lib.invalidateCache();
    lib.saveTable({ name: 'dim_newer', columns: [], modelRole: 'reference' });
    const text = fs.readFileSync(path.join(erd, 'tables', 'dim_newer.yml'), 'utf-8');
    expect(text).toMatch(/^tableRole: reference$/m);
  });

  it('a project with no library folder at all writes its first table to tables/ as DBML (native DBML storage, §3.2)', () => {
    fs.rmSync(erd, { recursive: true });
    const lib = new TableLibraryService(root, '.erd-studio');
    lib.saveTable({ name: 'dim_first', columns: [], modelRole: 'reference' });
    expect(fs.readFileSync(path.join(erd, 'tables', 'dim_first.dbml'), 'utf-8')).toMatch(/^Table dim_first \[role: 'reference'\]/m);
    expect(fs.existsSync(path.join(erd, 'tables', 'dim_first.yml'))).toBe(false);
    expect(fs.existsSync(path.join(erd, 'logical-models'))).toBe(false);
  });

  it('reports a table in both folders, ignoring case', () => {
    fs.mkdirSync(path.join(erd, 'tables', 'gold'), { recursive: true });
    fs.writeFileSync(path.join(erd, 'tables', 'gold', 'Dim_Task.yml'), 'name: Dim_Task\n');
    const lib = new TableLibraryService(root, '.erd-studio');
    expect(lib.tableNamingConflicts()).toEqual([{
      name: 'Dim_Task',
      kept: path.join(erd, 'logical-models', 'dim_task.yml'),
      ignored: path.join(erd, 'tables', 'gold', 'Dim_Task.yml'),
    }]);
    expect(lib.listTableNames().filter((n) => n.toLowerCase() === 'dim_task')).toEqual(['dim_task']);
  });
});

describe('the Breaker\'s cases (#181)', () => {
  it('a logical-models/ file that uses a v6 key is written in v6, so the edit is not lost on the next read', () => {
    const file = path.join(erd, 'logical-models', 'dim_task.yml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(/^modelRole:/m, 'tableRole:'));
    const lib = new TableLibraryService(root, '.erd-studio');
    const model = lib.getTable('dim_task')!;
    expect(model.modelRole).toBe('domain-dim');
    const text = lib.serializeTable({ ...model, modelRole: 'reference' });
    expect(text).toMatch(/^tableRole: reference$/m);
    expect(text).not.toMatch(/modelRole/);
  });

  it('refuses a file that holds a key in both namings, naming the file and both keys', () => {
    const file = path.join(erd, 'logical-models', 'dim_task.yml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(/^modelRole:(.*)$/m, 'modelRole:$1\ntableRole: reference'));
    const lib = new TableLibraryService(root, '.erd-studio');
    const model = lib.getTable('dim_task')!;
    expect(() => lib.serializeTable({ ...model, description: 'y' })).toThrow(TableNamingWriteRefused);
    expect(() => lib.serializeTable({ ...model, description: 'y' })).toThrow(/holds both "modelRole" and "tableRole"/);
  });

  it('an empty tables/ folder is not a library: the project stays v5', async () => {
    fs.mkdirSync(path.join(erd, 'tables'));
    expect(new TableLibraryService(root, '.erd-studio').hasTablesLibrary()).toBe(false);
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: path.join(root, 'home') });
    expect(r.erd.naming).toBe('v5');
  });

  it('reads the logical-models/ copy of a name that differs only in case, as doctor reports, on every file system', () => {
    fs.mkdirSync(path.join(erd, 'tables'));
    fs.writeFileSync(path.join(erd, 'tables', 'DIM_TASK.yml'), 'name: DIM_TASK\n');
    const lib = new TableLibraryService(root, '.erd-studio');
    // The same file whatever the case of its spelling (macOS hands back the name as asked).
    const found = lib.findTableFile('DIM_TASK')!;
    expect(path.dirname(found)).toBe(path.join(erd, 'logical-models'));
    expect(path.basename(found).toLowerCase()).toBe('dim_task.yml');
    expect(lib.tableNamingConflicts()[0].kept.toLowerCase()).toBe(found.toLowerCase());
  });

  it('the physical stage of a v6 diagram drags tables like a v5 one (#182)', async () => {
    toTableNaming();
    const { panel } = await open('silver/showcase.json');
    panel._postedMessages.length = 0;
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await vi.waitFor(() => expect(posted(panel).some((m) => m.type === 'stageData')).toBe(true), { timeout: 4000, interval: 20 });
    expect(posted(panel).find((m) => m.type === 'stageData')!.payload.positionDraggable).not.toBe(false);
    panel._postedMessages.length = 0;
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'logical', requestId: 2 } });
    await vi.waitFor(() => expect(posted(panel).some((m) => m.type === 'stageData')).toBe(true), { timeout: 4000, interval: 20 });
    expect(posted(panel).find((m) => m.type === 'stageData')!.payload.readOnly).toBe(false);
  });
});

describe('code review follow-ups (#191)', () => {
  it('a sync plan from a v6 diagram is named after its subjectArea, as the CLI names it', async () => {
    toTableNaming();
    const { panel } = await open('silver/showcase.json');
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'logical' } });
    const report = posted(panel).filter((m) => m.type === 'discrepancyReport').at(-1)?.payload;
    expect(report).toBeTruthy();
    await panel._simulateMessage({ type: 'generateSyncPlan', payload: { selections: allSelections(report, 'logical') } });
    const plan = JSON.parse(fs.readFileSync(path.join(erd, '.sync-plan.json'), 'utf-8'));
    expect(plan.domain).toBe('showcase');
    expect(plan.modelContext.dim_task.logicalModelPath).toBe('.erd-studio/tables/dim_task.yml');
  });

  it('a table lookup never lists the whole library', () => {
    tablesToV6(['dim_task']);
    const lib = new TableLibraryService(root, '.erd-studio');
    const list = vi.spyOn(lib, 'listTableFiles');
    expect(lib.findTableFile('dim_task')).toBe(path.join(erd, 'tables', 'dim_task.yml'));
    expect(lib.findTableFile('no_such_table')).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('an empty tables/ layer folder stays a layer when layers come from the folders', () => {
    fs.rmSync(path.join(erd, 'layers.json'));
    fs.mkdirSync(path.join(erd, 'tables'));
    expect(new LayerService(root, '.erd-studio').detectLayersFromFilesystem().map((l) => l.id)).toContain('tables');
  });

  it('doctor sends v5 names under schemaVersion 6 to the naming step, and the migration leaves the file alone', async () => {
    fs.writeFileSync(path.join(erd, 'silver', 'six.json'), JSON.stringify({ schemaVersion: 6, domain: 'six', layer: 'silver', logical: { models: ['dim_task'] } }));
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: path.join(root, 'home') });
    expect(r.erd.domainFormatIssues.find((i) => i.file.endsWith('six.json'))?.namingMix).toBe(true);
    const migration = new MigrationService(root, new LayerService(root, '.erd-studio'), new TableLibraryService(root, '.erd-studio'), '.erd-studio');
    expect(migration.findV4SubjectAreas().map((p) => path.basename(p))).not.toContain('six.json');
  });

  it('an empty leftover logical-models/ does not make a v6 project mixed', async () => {
    toTableNaming();
    fs.mkdirSync(path.join(erd, 'logical-models'));
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: path.join(root, 'home') });
    expect(r.erd.naming).toBe('v6');
  });

  it('a stray fromTable in a logical-models/ relationship does not block edits (nothing reads it)', () => {
    const file = path.join(erd, 'logical-models', 'fct_task_event.yml');
    fs.appendFileSync(file, 'relationships:\n  - fromTable: fct_task_event\n    fromColumn: task_key\n    toModel: dim_task\n    toColumn: task_key\n    cardinality: many-to-one\n');
    const lib = new TableLibraryService(root, '.erd-studio');
    const model = lib.getTable('fct_task_event')!;
    expect(() => lib.serializeTable({ ...model, description: 'changed' })).not.toThrow();
  });
});

describe('a project with a layer called tables (made before v6)', () => {
  function addTablesLayer(): void {
    const layers = JSON.parse(fs.readFileSync(path.join(erd, 'layers.json'), 'utf-8'));
    layers.layers.push({ id: 'tables', label: 'Tables', abbreviation: 'TBL', color: '#888888', creatable: true, order: 9 });
    fs.writeFileSync(path.join(erd, 'layers.json'), JSON.stringify(layers, null, 2));
    fs.mkdirSync(path.join(erd, 'tables'));
    const showcase = JSON.parse(fs.readFileSync(path.join(erd, 'silver', 'showcase.json'), 'utf-8'));
    fs.writeFileSync(path.join(erd, 'tables', 'orders.json'), JSON.stringify({ ...showcase, domain: 'orders', layer: 'tables' }, null, 2));
  }

  it('keeps the layer, loads its diagram, and never reads the folder as the table library', async () => {
    addTablesLayer();
    expect(tablesDirIsLayer(erd)).toBe(true);
    const { layerService, tableLibraryService, subjectAreaService } = buildProvider();
    expect(layerService.getAllLayers().map((l) => l.id)).toContain('tables');
    expect(tableLibraryService.hasTablesLibrary()).toBe(false);
    expect(tableLibraryService.listTableFiles().some((f) => f.library)).toBe(false);
    expect(subjectAreaService.listSubjectAreas(root, '.erd-studio').map((s) => `${s.layer}/${s.domain}`)).toContain('tables/orders');

    const { panel } = await open('tables/orders.json');
    expect(errors(panel)).toEqual([]);
    const loaded = posted(panel).find((m) => m.type === 'domainLoaded')!.payload;
    expect(loaded.readOnly).toBe(false);
    expect(loaded.models.length).toBe(6);
  });

  it('is a layer when it holds a diagram, even without layers.json listing it', () => {
    fs.rmSync(path.join(erd, 'layers.json'));
    fs.mkdirSync(path.join(erd, 'tables'));
    fs.writeFileSync(path.join(erd, 'tables', 'orders.json'), '{}');
    expect(tablesDirIsLayer(erd)).toBe(true);
    expect(new LayerService(root, '.erd-studio').detectLayersFromFilesystem().map((l) => l.id)).toContain('tables');
  });

  it('is the library when it holds only table files, top level or one folder down', () => {
    fs.rmSync(path.join(erd, 'layers.json'));
    fs.mkdirSync(path.join(erd, 'tables', 'gold'), { recursive: true });
    fs.writeFileSync(path.join(erd, 'tables', 'gold', 'fct_x.yml'), 'name: fct_x\n');
    expect(tablesDirIsLayer(erd)).toBe(false);
    // Not auto-detected as a layer, though its top level holds no yml.
    expect(new LayerService(root, '.erd-studio').detectLayersFromFilesystem().map((l) => l.id)).not.toContain('tables');
  });
});

describe('doctor reports the naming (#181)', () => {
  const run = () => runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: path.join(root, 'home') });

  it('v5 for the fixture project', async () => {
    const r = await run();
    expect(r.erd.naming).toBe('v5');
    expect(r.erd.namingConflicts).toEqual([]);
    expect(r.erd.tablesFolderIsLayer).toBe(false);
  });

  it('v6 for a project in the new naming, with every table counted and no format issue', async () => {
    toTableNaming();
    const r = await run();
    expect(r.erd.naming).toBe('v6');
    expect(r.erd.logicalModels).toBe(9);
    expect(r.erd.domainFormatIssues).toEqual([]);
    expect(formatDoctor(r, makePaint(false))).toContain('9 tables — storage YAML, file naming v6');
  });

  it('mixed, with the table in both folders as a finding and the first step after any merge conflict', async () => {
    fs.mkdirSync(path.join(erd, 'tables'));
    fs.writeFileSync(path.join(erd, 'tables', 'dim_task.yml'), 'name: dim_task\n');
    const r = await run();
    expect(r.erd.naming).toBe('mixed');
    expect(r.erd.namingConflicts).toEqual([
      { name: 'dim_task', kept: '.erd-studio/logical-models/dim_task.yml', ignored: '.erd-studio/tables/dim_task.yml' },
    ]);
    expect(r.nextSteps[0].id).toBe('resolve-naming-conflicts');
    expect(formatDoctor(r, makePaint(false))).toContain(
      '✗ dim_task is in both .erd-studio/logical-models/dim_task.yml and .erd-studio/tables/dim_task.yml — .erd-studio/logical-models/dim_task.yml is used; keep one',
    );
  });

  it('names a file mixing the v5 and v6 names with its own step, not the v4 migration', async () => {
    fs.writeFileSync(path.join(erd, 'silver', 'mix.json'), JSON.stringify({ schemaVersion: 5, layer: 'silver', logical: { tables: ['dim_task'] } }));
    const r = await run();
    expect(r.erd.domainFormatIssues.find((i) => i.file.endsWith('mix.json'))).toEqual({ file: '.erd-studio/silver/mix.json', format: 'hybrid', namingMix: true });
    const step = r.nextSteps.find((s) => s.id === 'fix-subject-area-naming')!;
    expect(step.why).toContain('.erd-studio/silver/mix.json');
    // The fixture's own v4 files still get the migration step, counted without mix.json.
    expect(r.nextSteps.find((s) => s.id === 'migrate-v5')!.why).toMatch(new RegExp(`^${r.erd.domainFormatIssues.length - 1} subject area file`));
  });

  it('v5 with a tables layer, and says so', async () => {
    fs.mkdirSync(path.join(erd, 'tables'));
    fs.writeFileSync(path.join(erd, 'tables', 'orders.json'), fs.readFileSync(path.join(erd, 'silver', 'showcase.json')));
    const r = await run();
    expect(r.erd.naming).toBe('v5');
    expect(r.erd.tablesFolderIsLayer).toBe(true);
    expect(formatDoctor(r, makePaint(false))).toContain('file naming v5 (tables/ is a layer folder)');
  });
});

describe('other writers keep the v6 naming (#182)', () => {
  it('Rename Subject Area renames subjectArea in a v6 file, never writing "domain" into it', () => {
    toTableNaming();
    const text = fs.readFileSync(path.join(erd, 'silver', 'showcase.json'), 'utf-8');
    const out = JSON.parse(renameSubjectAreaInRaw(text, 'renamed'));
    expect(out.subjectArea).toBe('renamed');
    expect('domain' in out).toBe(false);
    expect(detectSubjectAreaFormat(out)).toBe('v6');
  });

  it('the v5 migration skips a file mixing the v5 and v6 names', () => {
    const file = path.join(erd, 'silver', 'mix.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 5, domain: 'mix', layer: 'silver', logical: { tables: ['dim_task'], relationships: [] } }));
    const layerService = new LayerService(root, '.erd-studio');
    const migration = new MigrationService(root, layerService, new TableLibraryService(root, '.erd-studio'), '.erd-studio');
    expect(migration.findV4SubjectAreas().map((p) => path.basename(p))).not.toContain('mix.json');
  });

  it('Move Relationships to Table Library moves a v6 diagram\'s relationships into tables/, under the v6 keys', async () => {
    toTableNaming();
    const showcase = path.join(erd, 'silver', 'showcase.json');
    expect(JSON.parse(fs.readFileSync(showcase, 'utf-8')).logical.relationships.length).toBeGreaterThan(0);
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(async (...args: unknown[]) => args.at(-1) as never);
    const layerService = new LayerService(root, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    const tableLibraryService = new TableLibraryService(root, '.erd-studio');
    subjectAreaService.setTableLibraryService(tableLibraryService);
    await moveRelationshipsToLibrary({
      workspaceRoot: root, semanticDir: '.erd-studio', subjectAreaService, tableLibraryService, onWritten: async () => {},
    });
    expect(JSON.parse(fs.readFileSync(showcase, 'utf-8')).logical.relationships).toEqual([]);
    expect(fs.readFileSync(path.join(erd, 'tables', 'fct_task_event.yml'), 'utf-8')).toMatch(/toTable: /);
    expectStillV6();
  });

  it('feedback redaction names a tables/ file by its role', () => {
    expect(redactPaths(`${erd}/tables/gold/dim_task.yml`)).not.toContain('dim_task');
  });
});
