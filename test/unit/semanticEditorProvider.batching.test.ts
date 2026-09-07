/**
 * SemanticEditorProvider batching + edit-pipeline tests (H27, H35).
 *
 *  - A multi-select delete of annotations / relationships is ONE WorkspaceEdit,
 *    one save and one `domainLoaded` (the same guarantee `removeModels` gives).
 *  - A drag that moves models and notes together persists in ONE WorkspaceEdit.
 *  - undo / redo save + re-send exactly once even though the change listener
 *    fires while VS Code rewinds the document.
 *  - `applyDomainEdit` releases `pendingUpdates` when `applyEdit` throws, so
 *    the change listener is never permanently muted for the panel.
 *  - Dead protocol types (`updateViewConfig`, `toggleStubColumns`,
 *    `updateAnnotationPosition`) are no longer handled.
 *
 * Drives the real provider over a temp copy of the fixture dbt project.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');

type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
type Posted = { type: string; payload?: any };
type ChangeListener = (e: { document: unknown }) => Promise<void> | void;

interface MockDoc {
  uri: ReturnType<typeof vscode.Uri.file>;
  isDirty: boolean;
  isClosed: boolean;
  getText: () => string;
  positionAt: (offset: number) => { offset: number };
  save: ReturnType<typeof vi.fn>;
  _setText: (text: string) => void;
}

const docs = new Map<string, MockDoc>();

function makeDoc(fsPath: string): MockDoc {
  let text = fs.readFileSync(fsPath, 'utf-8');
  const doc: MockDoc = {
    uri: vscode.Uri.file(fsPath),
    isDirty: false,
    isClosed: false,
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
    save: vi.fn(async () => {
      fs.writeFileSync(fsPath, text);
      doc.isDirty = false;
      return true;
    }),
    _setText: (t: string) => {
      text = t;
      doc.isDirty = true;
    },
  };
  docs.set(fsPath, doc);
  return doc;
}

function buildProvider(root: string) {
  const layerService = new LayerService(root, '.erd-studio');
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(root, '.erd-studio');
  domainService.setLogicalModelService(logicalModelService);
  const manifestService = new ManifestService();
  const ymlParserService = new YmlParserService();
  const templateService = new TemplateService();
  const selectorsService = new SelectorsService(domainService, root, '.erd-studio');
  vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;

  return new SemanticEditorProvider(
    context,
    domainService,
    manifestService,
    ymlParserService,
    templateService,
    layerService,
    root,
    selectorsService,
    logicalModelService,
  );
}

const posted = (panel: MockPanel) => panel._postedMessages as Posted[];
const countType = (panel: MockPanel, type: string) => posted(panel).filter((m) => m.type === type).length;
const lastError = (panel: MockPanel) =>
  posted(panel).filter((m) => m.type === 'error').at(-1)?.payload?.message as string | undefined;

const readDomain = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));

let root: string;
let applyEditSpy: ReturnType<typeof vi.spyOn>;
/** The onDidChangeTextDocument listener the provider registered for the open panel. */
let changeListener: ChangeListener | undefined;

const realApplyEdit = vscode.workspace.applyEdit;

async function openShowcase() {
  const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
  const provider = buildProvider(root);
  const doc = makeDoc(file);
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  await panel._simulateMessage({ type: 'ready' });
  await vi.waitFor(() => expect(countType(panel, 'domainLoaded')).toBeGreaterThanOrEqual(1));
  return { provider, doc, panel, file };
}

/** Snapshot the counters a batch must move by exactly one. */
function counters(panel: MockPanel, doc: MockDoc) {
  return {
    edits: applyEditSpy.mock.calls.length,
    saves: doc.save.mock.calls.length,
    loads: countType(panel, 'domainLoaded'),
  };
}

const REL_A = { fromModel: 'fct_task_event', fromColumn: 'task_id', toModel: 'dim_task', toColumn: 'task_id' };
const REL_B = { fromModel: 'dim_task', fromColumn: 'project_id', toModel: 'dim_project', toColumn: 'project_id' };
const REL_MISSING = { fromModel: 'nope', fromColumn: 'x', toModel: 'dim_project', toColumn: 'project_id' };

async function addAnnotations(panel: MockPanel, ids: string[]) {
  for (const id of ids) {
    await panel._simulateMessage({ type: 'addAnnotation', payload: { id, text: id, x: 10, y: 10 } });
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-batching-'));
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  docs.clear();
  changeListener = undefined;
  vscode._resetMockWorkspace();
  applyEditSpy = vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit: any) => {
    const rest = new vscode.WorkspaceEdit();
    for (const op of edit._ops ?? []) {
      const own = op.kind === 'replace' ? docs.get(op.uri.fsPath) : undefined;
      if (own) {
        own._setText(op.newText);
      } else {
        rest._ops.push(op);
      }
    }
    return rest._ops.length > 0 ? realApplyEdit(rest as any) : true;
  });
  vi.spyOn(vscode.workspace, 'onDidChangeTextDocument').mockImplementation(((listener: ChangeListener) => {
    changeListener = listener;
    return { dispose: () => {} };
  }) as any);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// H27 — batched deletes
// ---------------------------------------------------------------------------

describe('removeAnnotations (H27)', () => {
  it('removes every listed annotation in ONE edit, one save and one domainLoaded', async () => {
    const { doc, panel, file } = await openShowcase();
    await addAnnotations(panel, ['n1', 'n2', 'n3', 'keep']);
    expect(readDomain(file).viewConfig.annotations).toHaveLength(4);

    const before = counters(panel, doc);
    await panel._simulateMessage({ type: 'removeAnnotations', payload: { ids: ['n1', 'n2', 'n3', 'ghost'] } });

    const after = counters(panel, doc);
    expect(after.edits - before.edits).toBe(1);
    expect(after.saves - before.saves).toBe(1);
    expect(after.loads - before.loads).toBe(1);
    expect(readDomain(file).viewConfig.annotations.map((a: { id: string }) => a.id)).toEqual(['keep']);
    expect(lastError(panel)).toBeUndefined();
  });

  it('single removeAnnotation still works through the batch handler', async () => {
    const { doc, panel, file } = await openShowcase();
    await addAnnotations(panel, ['solo', 'other']);

    const before = counters(panel, doc);
    await panel._simulateMessage({ type: 'removeAnnotation', payload: { id: 'solo' } });

    expect(counters(panel, doc).edits - before.edits).toBe(1);
    expect(readDomain(file).viewConfig.annotations.map((a: { id: string }) => a.id)).toEqual(['other']);
  });

  it('ignores an empty or malformed ids list', async () => {
    const { doc, panel } = await openShowcase();
    const before = counters(panel, doc);
    await panel._simulateMessage({ type: 'removeAnnotations', payload: { ids: [] } });
    await panel._simulateMessage({ type: 'removeAnnotations', payload: { ids: 'n1' } });
    expect(counters(panel, doc).edits).toBe(before.edits);
  });

  it('is allowed while viewing the physical stage (annotations are shared canvas metadata)', async () => {
    const { panel, file } = await openShowcase();
    await addAnnotations(panel, ['p1', 'p2']);
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical' } });
    await panel._simulateMessage({ type: 'removeAnnotations', payload: { ids: ['p1', 'p2'] } });
    expect(readDomain(file).viewConfig.annotations).toHaveLength(0);
    expect(lastError(panel)).toBeUndefined();
  });
});

describe('removeRelationships (H27)', () => {
  it('removes every listed relationship in ONE edit, one save and one domainLoaded', async () => {
    const { doc, panel, file } = await openShowcase();
    const initial = readDomain(file).logical.relationships.length;

    const before = counters(panel, doc);
    await panel._simulateMessage({ type: 'removeRelationships', payload: { relationships: [REL_A, REL_B] } });

    const after = counters(panel, doc);
    expect(after.edits - before.edits).toBe(1);
    expect(after.saves - before.saves).toBe(1);
    expect(after.loads - before.loads).toBe(1);
    const rels = readDomain(file).logical.relationships;
    expect(rels).toHaveLength(initial - 2);
    expect(rels.some((r: any) => r.fromModel === REL_A.fromModel && r.fromColumn === REL_A.fromColumn && r.toModel === REL_A.toModel)).toBe(false);
    expect(rels.some((r: any) => r.fromModel === REL_B.fromModel && r.fromColumn === REL_B.fromColumn && r.toModel === REL_B.toModel)).toBe(false);
    expect(lastError(panel)).toBeUndefined();
  });

  it('skips keys that no longer exist but still removes the rest', async () => {
    const { panel, file } = await openShowcase();
    const initial = readDomain(file).logical.relationships.length;
    await panel._simulateMessage({ type: 'removeRelationships', payload: { relationships: [REL_MISSING, REL_A] } });
    expect(readDomain(file).logical.relationships).toHaveLength(initial - 1);
    expect(lastError(panel)).toBeUndefined();
  });

  it('reports an error (and writes nothing) when none of the keys match', async () => {
    const { doc, panel } = await openShowcase();
    const before = counters(panel, doc);
    await panel._simulateMessage({ type: 'removeRelationships', payload: { relationships: [REL_MISSING] } });
    expect(counters(panel, doc).edits).toBe(before.edits);
    expect(lastError(panel)).toMatch(/Failed to remove relationship: Relationship not found\./);
  });

  it('keeps the single removeRelationship contract (not-found is an error)', async () => {
    const { panel } = await openShowcase();
    await panel._simulateMessage({ type: 'removeRelationship', payload: REL_MISSING });
    expect(lastError(panel)).toMatch(/Failed to remove relationship: Relationship not found\./);
  });

  it('is rejected while viewing the physical stage (schema mutation)', async () => {
    const { doc, panel } = await openShowcase();
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical' } });
    const before = counters(panel, doc);
    await panel._simulateMessage({ type: 'removeRelationships', payload: { relationships: [REL_A] } });
    expect(counters(panel, doc).edits).toBe(before.edits);
    expect(lastError(panel)).toMatch(/read-only/);
  });
});

// ---------------------------------------------------------------------------
// H27 — batched drag
// ---------------------------------------------------------------------------

describe('updatePositions with annotations (H27)', () => {
  it('writes model and annotation positions in ONE edit without re-sending the domain', async () => {
    const { doc, panel, file } = await openShowcase();
    await addAnnotations(panel, ['note']);

    const before = counters(panel, doc);
    await panel._simulateMessage({
      type: 'updatePositions',
      payload: {
        positions: { dim_task: { x: 1, y: 2 } },
        annotations: [{ id: 'note', x: 10.4, y: 20.6 }, { id: 'ghost', x: 1, y: 1 }],
      },
    });

    const after = counters(panel, doc);
    expect(after.edits - before.edits).toBe(1);
    expect(after.saves - before.saves).toBe(1);
    expect(after.loads).toBe(before.loads);

    const domain = readDomain(file);
    expect(domain.viewConfig.positions.dim_task).toEqual({ x: 1, y: 2 });
    expect(domain.viewConfig.annotations).toEqual([expect.objectContaining({ id: 'note', x: 10, y: 21 })]);
    expect(lastError(panel)).toBeUndefined();
  });

  it('rejects a malformed annotations list before touching the document', async () => {
    const { doc, panel } = await openShowcase();
    const before = counters(panel, doc);
    await panel._simulateMessage({
      type: 'updatePositions',
      payload: { positions: {}, annotations: [{ id: 'note', x: NaN, y: 0 }] },
    });
    await panel._simulateMessage({
      type: 'updatePositions',
      payload: { positions: {}, annotations: [{ id: '', x: 0, y: 0 }] },
    });
    expect(counters(panel, doc).edits).toBe(before.edits);
    expect(lastError(panel)).toMatch(/Failed to move annotation/);
  });
});

// ---------------------------------------------------------------------------
// H27 — undo / redo single save + send
// ---------------------------------------------------------------------------

describe('undo / redo (H27)', () => {
  it('saves and re-sends exactly once even though the change listener fires during the command', async () => {
    const { doc, panel } = await openShowcase();
    expect(changeListener).toBeDefined();

    // Simulate VS Code: the undo command rewinds the document and fires
    // onDidChangeTextDocument synchronously before the command resolves.
    vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (cmd: string) => {
      if (cmd === 'undo' || cmd === 'redo') {
        doc._setText(doc.getText());
        await changeListener!({ document: doc });
      }
      return undefined;
    }) as any);

    for (const command of ['undo', 'redo'] as const) {
      const before = counters(panel, doc);
      await panel._simulateMessage({ type: command });
      const after = counters(panel, doc);
      expect(after.saves - before.saves).toBe(1);
      expect(after.loads - before.loads).toBe(1);
    }
  });

  it('the change listener still refreshes on its own for external edits', async () => {
    const { doc, panel } = await openShowcase();
    const before = counters(panel, doc);
    doc._setText(doc.getText());
    await changeListener!({ document: doc });
    const after = counters(panel, doc);
    expect(after.saves - before.saves).toBe(1);
    expect(after.loads - before.loads).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// H35 — the single edit pipeline
// ---------------------------------------------------------------------------

describe('applyDomainEdit pipeline (H35)', () => {
  it('releases pendingUpdates when applyEdit throws so the change listener is not muted', async () => {
    const { doc, panel } = await openShowcase();
    applyEditSpy.mockRejectedValueOnce(new Error('disk on fire'));

    await panel._simulateMessage({ type: 'addAnnotation', payload: { id: 'boom', text: '', x: 0, y: 0 } });
    expect(lastError(panel)).toMatch(/Failed to add annotation: disk on fire/);

    // An external change after the failure must still be picked up.
    const before = counters(panel, doc);
    doc._setText(doc.getText());
    await changeListener!({ document: doc });
    expect(counters(panel, doc).loads - before.loads).toBe(1);
  });

  it('posts the handler error label when VS Code rejects the edit', async () => {
    const { doc, panel } = await openShowcase();
    applyEditSpy.mockResolvedValueOnce(false);
    const before = counters(panel, doc);
    await panel._simulateMessage({ type: 'removeAnnotations', payload: { ids: ['a', 'b'] } });
    expect(lastError(panel)).toBe('Failed to remove annotations.');
    expect(counters(panel, doc).saves).toBe(before.saves);
  });

  it('a V4 handler that aborts inside the mutator reports its own reason and writes nothing', async () => {
    // Downgrade the showcase to a v4 inline-model domain so the V4 branch runs.
    const { doc, panel, file } = await openShowcase();
    const v4 = readDomain(file);
    v4.schemaVersion = 4;
    v4.logical.models = v4.logical.models.map((name: string) => ({ name, schema: '', description: '', columns: [] }));
    fs.writeFileSync(file, JSON.stringify(v4, null, 2) + '\n');
    doc._setText(fs.readFileSync(file, 'utf-8'));
    doc.isDirty = false;

    const before = counters(panel, doc);
    await panel._simulateMessage({
      type: 'addColumn',
      payload: { modelName: 'does_not_exist', column: { name: 'c', dataType: 'string', description: '' } },
    });
    expect(lastError(panel)).toBe('Model "does_not_exist" not found.');
    expect(counters(panel, doc).edits).toBe(before.edits);

    // …and a valid one goes through the shared pipeline: one edit, one save, one refresh.
    await panel._simulateMessage({
      type: 'addColumn',
      payload: { modelName: 'dim_task', column: { name: 'new_col', dataType: 'string', description: '' } },
    });
    const after = counters(panel, doc);
    expect(after.edits - before.edits).toBe(1);
    expect(after.saves - before.saves).toBe(1);
    expect(after.loads - before.loads).toBe(1);
    const model = readDomain(file).logical.models.find((m: { name: string }) => m.name === 'dim_task');
    expect(model.columns.map((c: { name: string }) => c.name)).toEqual(['new_col']);
  });
});

describe('dead protocol surface (H35)', () => {
  it.each(['updateViewConfig', 'toggleStubColumns', 'updateAnnotationPosition', 'runAutoLayout'])(
    '%s is no longer handled — logged as unknown, nothing written',
    async (type) => {
      const { doc, panel } = await openShowcase();
      const before = counters(panel, doc);
      await panel._simulateMessage({ type, payload: { modelName: 'dim_task', stub: true, id: 'x', x: 0, y: 0 } });
      expect(counters(panel, doc).edits).toBe(before.edits);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`unknown webview message type "${type}"`));
      expect(lastError(panel)).toBeUndefined();
    },
  );
});
