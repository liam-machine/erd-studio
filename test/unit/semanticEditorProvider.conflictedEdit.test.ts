/**
 * A canvas edit on a diagram whose file git has just filled with conflict
 * markers (issue #151).
 *
 * The canvas was open before the merge, so it is still drawing the old
 * document when the user edits. The write was always refused — the document
 * cannot be parsed — but the toast read as a raw JSON parser error. Every edit
 * must now refuse with the load path's own words (#145): "…has unresolved git
 * merge conflicts (first at line N)…", once, with nothing written.
 *
 * Drives the real provider with the real services over a temp copy of the
 * fixture dbt project, as semanticEditorProvider.domainFile.test.ts does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { allSelections } from '../../src/services/syncPlanBuilder';
import { telemetry } from '../../src/services/telemetryService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');

type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
type Posted = { type: string; payload?: any };

const posted = (panel: MockPanel) => panel._postedMessages as Posted[];
const errors = (panel: MockPanel) => posted(panel).filter((m) => m.type === 'error');

function makeDoc(fsPath: string) {
  let text = fs.readFileSync(fsPath, 'utf-8');
  return {
    uri: vscode.Uri.file(fsPath),
    isDirty: false,
    isClosed: false,
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
    save: vi.fn(async () => true),
    _setText: (t: string) => { text = t; },
  };
}

function buildProvider(rootDir: string) {
  const layerService = new LayerService(rootDir, '.erd-studio');
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(rootDir, '.erd-studio');
  domainService.setLogicalModelService(logicalModelService);
  const selectorsService = new SelectorsService(domainService, rootDir, '.erd-studio');
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(rootDir, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;

  return new SemanticEditorProvider(
    context,
    domainService,
    new ManifestService(),
    new YmlParserService(),
    new TemplateService(),
    layerService,
    rootDir,
    selectorsService,
    logicalModelService,
  );
}

/** Every file under the semantic dir, path → bytes. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.set(p, fs.readFileSync(p, 'utf-8'));
    }
  };
  walk(dir);
  return out;
}

/**
 * The showcase diagram open and loaded, then git rewrites its file with a
 * conflict in the positions block — on disk and in the open document — before
 * the canvas has refreshed. `beforeConflict` runs on the valid diagram first
 * (a comparison the sync plan needs).
 */
async function openThenConflict(
  rootDir: string,
  conflicted: (text: string) => string,
  beforeConflict?: (panel: MockPanel) => Promise<void>,
) {
  const file = path.join(rootDir, '.erd-studio', 'silver', 'showcase.json');
  const provider = buildProvider(rootDir);
  const doc = makeDoc(file);
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  await panel._simulateMessage({ type: 'ready' });
  await vi.waitFor(
    () => expect(posted(panel).some((m) => m.type === 'domainLoaded')).toBe(true),
    { timeout: 4000, interval: 20 },
  );
  expect(errors(panel)).toEqual([]);
  if (beforeConflict) await beforeConflict(panel);

  conflictNow(file, doc, conflicted);
  panel._postedMessages.length = 0;
  vi.mocked(vscode.workspace.applyEdit).mockClear();
  doc.save.mockClear();
  return { file, doc, panel, before: snapshot(path.join(rootDir, '.erd-studio')) };
}

/** Git writes the conflicted text, on disk and into the open document. */
function conflictNow(file: string, doc: ReturnType<typeof makeDoc>, conflicted: (text: string) => string) {
  const text = conflicted(doc.getText());
  fs.writeFileSync(file, text);
  doc._setText(text);
}

/** One plain merge-conflict toast, and nothing written anywhere. */
function expectRefused(panel: MockPanel, doc: ReturnType<typeof makeDoc>, before: Map<string, string>) {
  const errs = errors(panel);
  expect(errs).toHaveLength(1);
  const text = errs[0].payload.message as string;
  expect(text).toContain('has unresolved git merge conflicts (first at line');
  expect(text).toContain('either side is safe to keep');
  expect(text).not.toMatch(/SyntaxError|Unexpected token|Expected property name|in JSON at position/);
  // Named as the user knows it, not by this machine's absolute path.
  expect(text).toContain('.erd-studio/silver/showcase.json');
  expect(text).not.toContain(root);

  expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  expect(doc.save).not.toHaveBeenCalled();
  expect(snapshot(path.join(root, '.erd-studio'))).toEqual(before);
  expect(posted(panel).some((m) => m.type === 'domainLoaded')).toBe(false);
}

/** A git conflict over one model's position, as a merge of two layouts leaves it. */
function conflictPositions(text: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.includes('"dim_task": {'));
  expect(at).toBeGreaterThan(0);
  return [
    ...lines.slice(0, at),
    '<<<<<<< HEAD',
    lines[at],
    '=======',
    lines[at],
    '>>>>>>> feature/layout',
    ...lines.slice(at + 1),
  ].join('\n');
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-conflicted-edit-'));
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  vscode._resetMockWorkspace();
  vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// Each reaches the document through a different route: applyDomainEdit
// alone, a handler's own read first, the relationship planner and the model
// library (v5). Add from dbt and the sync plan have tests of their own below.
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

describe('an edit on a diagram git left in conflict (#151)', () => {
  it.each(EDITS)('%s refuses with the merge-conflict message and writes nothing', async (_name, message) => {
    const { doc, panel, before } = await openThenConflict(root, conflictPositions);

    await panel._simulateMessage(message);

    expectRefused(panel, doc, before);
  });

  it('Add models from dbt refuses before the picker opens, and is not counted as a failure', async () => {
    const { doc, panel, before } = await openThenConflict(root, conflictPositions);
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    const error = vi.spyOn(telemetry, 'error');

    await panel._simulateMessage({ type: 'addModelsFromDbt' });

    expectRefused(panel, doc, before);
    expect(pick).not.toHaveBeenCalled();
    // A refusal the toast explains is not a breakage (CLAUDE.md, Usage telemetry).
    expect(error).not.toHaveBeenCalledWith('addFromDbtFailed');
  });

  it('Add models from dbt refuses when git conflicts the diagram while the picker is open', async () => {
    // The queued half re-reads the document after the picker closes.
    const { file, doc, panel, before } = await openThenConflict(root, (t) => t);
    const error = vi.spyOn(telemetry, 'error');
    let conflictedBefore = before;
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementationOnce(async (items: any) => {
      conflictNow(file, doc, conflictPositions);
      conflictedBefore = snapshot(path.join(root, '.erd-studio'));
      return (await items).find((i: any) => i.scope?.id === 'folder:silver');
    });

    await panel._simulateMessage({ type: 'addModelsFromDbt' });

    expect(pick).toHaveBeenCalledTimes(1);
    expectRefused(panel, doc, conflictedBefore);
    expect(error).not.toHaveBeenCalledWith('addFromDbtFailed');
  });

  it('the sync plan (physical stage) refuses and writes no plan file', async () => {
    // The fixture ships a plan; start without one so a write would show.
    const planFile = path.join(root, '.erd-studio', '.sync-plan.json');
    fs.rmSync(planFile, { force: true });
    let report: any;
    const { doc, panel, before } = await openThenConflict(root, conflictPositions, async (p) => {
      await p._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
      await p._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'logical' } });
      report = posted(p).filter((m) => m.type === 'discrepancyReport').at(-1)?.payload;
      expect(report).toBeTruthy();
    });

    await panel._simulateMessage({ type: 'generateSyncPlan', payload: { selections: allSelections(report, 'logical') } });

    expectRefused(panel, doc, before);
    expect(posted(panel).some((m) => m.type === 'syncPlanGenerated')).toBe(false);
    expect(fs.existsSync(planFile)).toBe(false);
  });

  it('names the line of the first marker', async () => {
    const { doc, panel } = await openThenConflict(root, conflictPositions);
    const line = doc.getText().split('\n').findIndex((l) => l.startsWith('<<<<<<<')) + 1;

    await panel._simulateMessage(EDITS[1][1]);

    expect(errors(panel)[0].payload.message).toContain(`(first at line ${line})`);
  });

  it('refuses an invalid but unconflicted document in plain words, writing nothing', async () => {
    const { doc, panel, before } = await openThenConflict(root, (t) => t.replace('{', '{,'));

    await panel._simulateMessage(EDITS[0][1]);

    const errs = errors(panel);
    expect(errs).toHaveLength(1);
    const text = errs[0].payload.message as string;
    expect(text).toContain('Invalid JSON in domain file .erd-studio/silver/showcase.json');
    expect(text).not.toContain('SyntaxError');
    expect(text).not.toContain('merge conflict');
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
    expect(snapshot(path.join(root, '.erd-studio'))).toEqual(before);
  });

  it('refuses an emptied document as empty, writing nothing', async () => {
    const { doc, panel, before } = await openThenConflict(root, () => '');

    await panel._simulateMessage(EDITS[1][1]);

    expect(errors(panel)).toHaveLength(1);
    expect(errors(panel)[0].payload.message).toContain('Domain file is empty: .erd-studio/silver/showcase.json');
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
    expect(snapshot(path.join(root, '.erd-studio'))).toEqual(before);
  });

  it('leaves an edit on a valid document exactly as it was', async () => {
    // The same route, unconflicted: one edit, the text it always wrote.
    const { doc, panel } = await openThenConflict(root, (t) => t);
    const original = doc.getText();

    await panel._simulateMessage(EDITS[1][1]);

    expect(errors(panel)).toEqual([]);
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
    const expected = JSON.parse(original);
    expected.viewConfig.positions.dim_task = { x: 1, y: 2 };
    const edit = vi.mocked(vscode.workspace.applyEdit).mock.calls[0][0] as unknown as vscode.WorkspaceEdit;
    const ops = (edit as unknown as { _ops: Array<{ kind: string; newText?: string }> })._ops;
    expect(ops).toHaveLength(1);
    expect(ops[0].newText).toBe(JSON.stringify(expected, null, 2) + '\n');
  });
});
