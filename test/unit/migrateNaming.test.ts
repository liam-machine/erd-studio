/**
 * "Migrate to the New File Naming" (#182) on the real services and the
 * stateful vscode mock: one WorkspaceEdit, the files it leaves, a second run
 * that has nothing to do, its refusals, and the canvas offer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { detectSubjectAreaFormat } from '@erd-studio/core';

import { migrateToTableNaming, planProjectNamingMigration, MIGRATE_NAMING_BUTTON, type MigrateNamingDeps } from '../../src/commands/migrateNaming';
import { SemanticEditorProvider, NAMING_MIGRATION_DECLINED_KEY } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { projectNamingOf } from '../../src/services/projectNaming';
import { runDoctor } from '../../src/cli/doctor';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/dbt-project');

let root: string;
let erd: string;

/** Every file under the semantic dir, relative path → bytes. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.set(path.relative(erd, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf-8'));
    }
  };
  walk(erd);
  return out;
}

function services() {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return { layerService, subjectAreaService, tableLibraryService };
}

function deps(overrides: Partial<MigrateNamingDeps> = {}): MigrateNamingDeps & { onMigrated: ReturnType<typeof vi.fn> } {
  const { subjectAreaService, tableLibraryService } = services();
  return {
    workspaceRoot: root, semanticDir: '.erd-studio', subjectAreaService, tableLibraryService, version: '9.9.9',
    onMigrated: vi.fn(async () => {}), ...overrides,
  } as MigrateNamingDeps & { onMigrated: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-migrate-naming-'));
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  erd = path.join(root, '.erd-studio');
  vscode._resetMockWorkspace();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('migrateToTableNaming (#182)', () => {
  it('asks once, then moves the project in one WorkspaceEdit to exactly what the planner planned, and a second run has nothing to do', async () => {
    const d = deps();
    const plan = planProjectNamingMigration(d);
    const before = snapshot();
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(async (...args: unknown[]) =>
      (args.includes(MIGRATE_NAMING_BUTTON) ? MIGRATE_NAMING_BUTTON : undefined) as never);

    expect(await migrateToTableNaming(d)).toBe('migrated');

    // One dialog naming the teammates' version, then one edit: one undo step.
    const dialog = info.mock.calls.find((c) => c.includes(MIGRATE_NAMING_BUTTON))!;
    expect((dialog[1] as { modal: boolean; detail: string }).modal).toBe(true);
    expect((dialog[1] as { detail: string }).detail).toContain('Teammates need ERD Studio 9.9.9 or later');
    expect(vscode._appliedEdits).toHaveLength(1);
    // Table files move by file operations only, so undo leaves no unsaved buffer behind; never a delete and a create of one path.
    const ops = (vscode._appliedEdits[0] as unknown as { _ops: Array<{ kind: string; uri?: { fsPath: string } }> })._ops;
    expect(ops.filter((o) => o.kind === 'replace').every((o) => o.uri!.fsPath.endsWith('.json'))).toBe(true);
    const created = ops.filter((o) => o.kind === 'createFile').map((o) => o.uri!.fsPath);
    expect(ops.filter((o) => o.kind === 'deleteFile').some((o) => created.includes(o.uri!.fsPath))).toBe(false);

    const after = snapshot();
    const expected = new Map(before);
    for (const m of plan.moves) { expected.set(m.to, m.text ?? before.get(m.from)!); expected.delete(m.from); }
    for (const r of plan.rewrites) expected.set(r.path, r.text);
    expect(after).toEqual(expected);
    expect(fs.existsSync(path.join(erd, 'logical-models'))).toBe(false);
    expect(projectNamingOf(erd, new TableLibraryService(root, '.erd-studio'))).toBe('v6');
    expect(d.onMigrated).toHaveBeenCalledTimes(1);

    info.mockClear();
    expect(await migrateToTableNaming(deps())).toBe('nothing');
    expect(vscode._appliedEdits).toHaveLength(1);
    expect(snapshot()).toEqual(after);
  });

  it('an undo of a subject area saves it, so disk follows the undo', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    const showcase = path.join(erd, 'silver', 'showcase.json');
    const original = fs.readFileSync(showcase, 'utf-8');
    await migrateToTableNaming(deps());
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(showcase)) as unknown as ReturnType<typeof vscode.createMockTextDocument>;
    expect(fs.readFileSync(showcase, 'utf-8')).not.toBe(original);
    // VS Code rewinds the text in memory…
    doc._setText(original);
    await vscode._fireDidChangeTextDocument(doc, vscode.TextDocumentChangeReason.Undo);
    await new Promise((r) => setTimeout(r, 80));
    // …and the file on disk follows.
    expect(doc.isDirty).toBe(false);
    expect(fs.readFileSync(showcase, 'utf-8')).toBe(original);
  });

  it('an undo that empties the tables/ folder it made removes it, so it never reads as a layer', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    await migrateToTableNaming(deps());
    // VS Code's undo moves the files back…
    fs.renameSync(path.join(erd, 'tables'), path.join(erd, 'logical-models'));
    fs.mkdirSync(path.join(erd, 'tables'));
    const showcase = path.join(erd, 'silver', 'showcase.json');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(showcase));
    await vscode._fireDidChangeTextDocument(doc, vscode.TextDocumentChangeReason.Undo);
    await new Promise((r) => setTimeout(r, 80));
    expect(fs.existsSync(path.join(erd, 'tables'))).toBe(false);
  });

  it('holds open canvases\' refreshes while the edit applies, and lets them go before redrawing them', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    const order: string[] = [];
    const d = deps({
      holdRefreshes: () => { order.push('hold'); return () => order.push('release'); },
    });
    d.onMigrated.mockImplementation(async () => { order.push('redraw'); });
    const apply = vscode.workspace.applyEdit;
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => { order.push('apply'); return apply(edit); });
    expect(await migrateToTableNaming(d)).toBe('migrated');
    expect(order).toEqual(['hold', 'apply', 'release', 'redraw']);
  });

  it('writes nothing when the dialog is cancelled', async () => {
    const before = snapshot();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    expect(await migrateToTableNaming(deps())).toBe('cancelled');
    expect(vscode._appliedEdits).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });

  it('writes nothing, and leaves no new folder, when VS Code rejects the edit', async () => {
    const before = snapshot();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    vscode._mockWorkspaceState.applyEditResult = false;
    expect(await migrateToTableNaming(deps())).toBe('failed');
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(erd, 'tables'))).toBe(false);
  });

  it('puts back what landed when VS Code applies only part of the edit (applyFileWrites reconciles)', async () => {
    const before = snapshot();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    // The first three operations land (a rewrite and two file operations), then one fails; the reconcile runs normally.
    vscode._mockWorkspaceState.applyEditPrefixes.push(3, 'ok');
    expect(await migrateToTableNaming(deps())).toBe('failed');
    expect(vscode._appliedEdits).toHaveLength(2);
    // Nothing is left half-moved: every file is back, and no empty tables/ is left to read as a layer.
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(erd, 'tables'))).toBe(false);
    expect(error.mock.calls[0][0]).toMatch(/didn't accept the file moves, so nothing was changed/);
  });

  it('refuses, saying why, a project with a layer called tables', async () => {
    const layers = JSON.parse(fs.readFileSync(path.join(erd, 'layers.json'), 'utf-8'));
    layers.layers.push({ ...layers.layers[0], id: 'tables', label: 'Tables' });
    fs.writeFileSync(path.join(erd, 'layers.json'), JSON.stringify(layers, null, 2));
    fs.mkdirSync(path.join(erd, 'tables'));
    const before = snapshot();
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    expect(await migrateToTableNaming(deps())).toBe('refused');
    expect((warn.mock.calls[0][1] as { detail: string }).detail).toMatch(/layer called "tables"/);
    expect(snapshot()).toEqual(before);
  });

  it('refuses while a file it would change has unsaved edits', async () => {
    const file = path.join(erd, 'logical-models', 'dim_task.yml');
    const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'));
    doc.isDirty = true;
    vscode.workspace.textDocuments.push(doc as never);
    const before = snapshot();
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    expect(await migrateToTableNaming(deps())).toBe('refused');
    expect(String(error.mock.calls[0][0])).toContain('.erd-studio/logical-models/dim_task.yml has unsaved edits');
    expect(snapshot()).toEqual(before);
  });

  it('a v4 project goes through "Migrate to v5" first and then straight on, ending all v6', async () => {
    fs.writeFileSync(path.join(erd, 'gold', 'inline.json'), JSON.stringify({
      schemaVersion: 4, domain: 'inline', layer: 'gold', description: '',
      logical: { models: [{ name: 'dim_inline', columns: [{ name: 'k', dataType: 'INT', isPrimaryKey: true }] }], relationships: [] },
    }, null, 2) + '\n');
    const { layerService, tableLibraryService } = services();
    const { MigrationService } = await import('../../src/services/migrationService');
    const migrateToV5 = vi.fn(async () => { new MigrationService(root, layerService, tableLibraryService, '.erd-studio').migrate(); return true; });
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);

    expect(await migrateToTableNaming(deps({ migrateToV5 }))).toBe('migrated');

    expect(migrateToV5).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(erd, 'tables', 'gold', 'dim_inline.yml')) || fs.existsSync(path.join(erd, 'tables', 'dim_inline.yml'))).toBe(true);
    for (const [rel, text] of snapshot()) {
      if (/^(silver|gold)\/[^/]+\.json$/.test(rel)) expect(detectSubjectAreaFormat(JSON.parse(text)), rel).toBe('v6');
    }
    expect(fs.existsSync(path.join(erd, 'logical-models'))).toBe(false);
  });

  it('doctor previews it, and says nothing once the project is v6', async () => {
    const opts = { project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: path.join(root, 'home') };
    const r = await runDoctor(opts);
    expect(r.erd.naming).toBe('v5');
    expect(r.erd.namingMigration).toMatchObject({ moves: 9, rewrites: 7, refusals: [] });
    expect(r.erd.namingMigration!.preview).toContain('logical-models/dim_task.yml → tables/dim_task.yml');
    expect(snapshot().has('tables/dim_task.yml')).toBe(false);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    await migrateToTableNaming(deps());
    const after = await runDoctor(opts);
    expect(after.erd.naming).toBe('v6');
    expect(after.erd.namingMigration).toBeUndefined();
  });
});

describe('the canvas offer (#182)', () => {
  const OFFER = 'ERD Studio now says "table" and "subject area"';

  function openWith(state: Map<string, unknown>) {
    const { layerService, subjectAreaService, tableLibraryService } = services();
    const selectorsService = new SelectorsService(subjectAreaService, root, '.erd-studio');
    vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
    const context = {
      extensionUri: vscode.Uri.file(root),
      globalState: { get: () => true, update: async () => {} },
      workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } },
      secrets: vscode.createMockSecretStorage(),
    } as unknown as vscode.ExtensionContext;
    const provider = new SemanticEditorProvider(
      context, subjectAreaService, new ManifestService(), new YmlParserService(), new TemplateService(),
      layerService, root, selectorsService, tableLibraryService,
    );
    const run = vi.fn(async () => true);
    provider.setNamingMigration(
      () => planProjectNamingMigration({ workspaceRoot: root, semanticDir: '.erd-studio', subjectAreaService, tableLibraryService }),
      () => projectNamingOf(erd, tableLibraryService),
      run,
      '9.9.9',
    );
    const open = async (relative: string) => {
      const file = path.join(erd, relative);
      const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
      const panel = vscode.createMockWebviewPanel();
      await provider.resolveCustomTextEditor(doc as never, panel as never, {} as vscode.CancellationToken);
      await panel._simulateMessage({ type: 'ready' });
      await new Promise((r) => setTimeout(r, 30));
      return panel;
    };
    return { open, run };
  }

  it('is made once a session on a v5 project, alone on that open, and writes nothing until asked', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Not Now' as never);
    const before = snapshot();
    const { open, run } = openWith(new Map());
    await open('silver/showcase.json');

    const calls = info.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((c) => c.startsWith(OFFER))).toHaveLength(1);
    // At most one prompt per canvas open: #126's and #163's wait for a later one.
    expect(calls).toHaveLength(1);
    expect(info.mock.calls[0].slice(1)).toEqual(['Review the Migration…', 'Not Now', "Don't Ask Again"]);
    expect(calls[0]).toContain('Teammates will need ERD Studio 9.9.9 or later');
    expect(run).not.toHaveBeenCalled();
    expect(vscode._appliedEdits).toHaveLength(0);
    expect(snapshot()).toEqual(before);

    await open('silver/scroll-test.json');
    expect(info.mock.calls.map((c) => String(c[0])).filter((c) => c.startsWith(OFFER))).toHaveLength(1);
  });

  it('Review runs the command; Don\'t Ask Again is remembered for the workspace', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Review the Migration…' as never);
    const first = openWith(new Map());
    await first.open('silver/showcase.json');
    expect(first.run).toHaveBeenCalledTimes(1);

    const state = new Map<string, unknown>();
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue("Don't Ask Again" as never);
    await openWith(state).open('silver/showcase.json');
    expect(state.get(NAMING_MIGRATION_DECLINED_KEY)).toBe(true);
    info.mockClear();
    await openWith(state).open('silver/showcase.json');
    expect(info.mock.calls.map((c) => String(c[0])).filter((c) => c.startsWith(OFFER))).toHaveLength(0);
  });

  it('is not made on a v6 project, nor on one the migration would refuse', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    await migrateToTableNaming(deps());
    info.mockClear();
    info.mockResolvedValue(undefined as never);
    await openWith(new Map()).open('silver/showcase.json');
    expect(info.mock.calls.map((c) => String(c[0])).filter((c) => c.startsWith(OFFER))).toHaveLength(0);
  });
});
