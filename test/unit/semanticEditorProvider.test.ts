/**
 * SemanticEditorProvider message-boundary tests (H21, H23, H24, H36).
 *
 * Drives the real provider with the real services over a temp copy of the
 * fixture dbt project, simulating webview messages through the vscode mock's
 * `createMockWebviewPanel`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SemanticEditorProvider, PHYSICAL_READ_ONLY_MESSAGE, modelFolderForDomain } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { CatalogService } from '../../src/services/catalogService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { DOMAIN_EDITOR_VIEW_TYPE } from '../../src/services/recoveryService';
import { hostErrorLog } from '../../src/services/feedbackService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');

type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
type Posted = { type: string; payload?: any; requestId?: number };

interface MockDoc {
  uri: ReturnType<typeof vscode.Uri.file>;
  isDirty: boolean;
  isClosed: boolean;
  getText: () => string;
  positionAt: (offset: number) => { offset: number };
  save: ReturnType<typeof vi.fn>;
  _setText: (text: string) => void;
}

/** Documents keyed by fsPath so the applyEdit spy can route edits to them. */
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
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;

  const provider = new SemanticEditorProvider(
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
  return { provider, logicalModelService };
}

const posted = (panel: MockPanel) => panel._postedMessages as Posted[];
const types = (panel: MockPanel) => posted(panel).map((m) => m.type);
const lastError = (panel: MockPanel) =>
  posted(panel).filter((m) => m.type === 'error').at(-1)?.payload?.message as string | undefined;

async function waitForType(panel: MockPanel, type: string, count = 1) {
  await vi.waitFor(
    () => expect(types(panel).filter((t) => t === type).length).toBeGreaterThanOrEqual(count),
    { timeout: 4000, interval: 10 },
  );
}

async function waitForError(panel: MockPanel, pattern: RegExp) {
  await vi.waitFor(() => expect(lastError(panel)).toMatch(pattern), { timeout: 4000, interval: 10 });
}

/** Open the showcase domain in a fresh provider; optionally strip a model's position first. */
async function openShowcase(root: string, opts: { stripPosition?: string; sendReady?: boolean } = {}) {
  const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
  if (opts.stripPosition) {
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    delete json.viewConfig.positions[opts.stripPosition];
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  }
  const built = buildProvider(root);
  const doc = makeDoc(file);
  const panel = vscode.createMockWebviewPanel();
  await built.provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  if (opts.sendReady !== false) {
    panel._simulateMessage({ type: 'ready' });
    await waitForType(panel, 'domainLoaded');
  }
  return { ...built, doc, panel, file };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let root: string;
let applyEditSpy: ReturnType<typeof vi.spyOn>;

/** The mock's own applyEdit (applies text edits to registered docs, file ops to disk). */
const realApplyEdit = vscode.workspace.applyEdit;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-provider-'));
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  docs.clear();
  vscode._resetMockWorkspace();
  applyEditSpy = vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit: any) => {
    // Whole-document replaces aimed at the docs this file created are applied
    // here (they use a minimal positionAt); everything else — yml createFile /
    // deleteFile and edits to documents opened via openTextDocument — goes
    // through the mock's real implementation so it reaches the filesystem.
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
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vscode.window.terminals.length = 0;
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// H24 — auto-positioning only writes from the `ready` path
// ---------------------------------------------------------------------------

describe('auto-positioning (H24)', () => {
  it('persists missing positions once on ready', async () => {
    const { doc, panel, file } = await openShowcase(root, { stripPosition: 'fct_order' });

    expect(applyEditSpy).toHaveBeenCalledTimes(1);
    expect(doc.save).toHaveBeenCalledTimes(1);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.viewConfig.positions.fct_order).toBeDefined();

    const loaded = posted(panel).find((m) => m.type === 'domainLoaded')!;
    expect(loaded.payload.viewConfig.positions.fct_order).toBeDefined();
  });

  it('does not write during a watcher-driven refresh but still sends computed positions', async () => {
    const { provider, doc, panel, file } = await openShowcase(root, {
      stripPosition: 'fct_order',
      sendReady: false,
    });
    const before = fs.readFileSync(file, 'utf-8');

    await provider.refreshAllOpenDomains();
    await waitForType(panel, 'domainLoaded');

    expect(applyEditSpy).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);

    const loaded = posted(panel).find((m) => m.type === 'domainLoaded')!;
    expect(loaded.payload.viewConfig.positions.fct_order).toBeDefined();
    expect(Number.isFinite(loaded.payload.viewConfig.positions.fct_order.x)).toBe(true);

    await provider.refreshDomainsReferencingModel('fct_order');
    await waitForType(panel, 'domainLoaded', 2);
    expect(applyEditSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('does not write when switching stage', async () => {
    const { doc, panel, file } = await openShowcase(root, { stripPosition: 'fct_order', sendReady: false });
    const before = fs.readFileSync(file, 'utf-8');

    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await waitForType(panel, 'stageData');

    expect(applyEditSpy).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// H24 — disposed webviews
// ---------------------------------------------------------------------------

describe('disposed panels (H24)', () => {
  it('drops messages to a disposed webview and skips it during refresh', async () => {
    const { provider, panel } = await openShowcase(root);
    const countBefore = posted(panel).length;

    panel._simulateDispose();

    (provider as unknown as { post: (w: unknown, m: unknown) => void }).post(panel.webview, { type: 'error', payload: { message: 'x' } });
    await provider.refreshAllOpenDomains();
    await new Promise((r) => setTimeout(r, 30));

    expect(posted(panel).length).toBe(countBefore);
  });

  it('post() observes a rejected postMessage instead of surfacing it', async () => {
    const { provider, panel } = await openShowcase(root);
    const rejecting = { postMessage: vi.fn(async () => { throw new Error('gone'); }) };
    expect(() =>
      (provider as unknown as { post: (w: unknown, m: unknown) => void }).post(rejecting, { type: 'x' }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(rejecting.postMessage).toHaveBeenCalledTimes(1);
    expect(posted(panel).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// target/catalog.json reaches the physical stage (and its absence changes nothing)
// ---------------------------------------------------------------------------

describe('catalog injection', () => {
  /** Open showcase on the physical stage, optionally with a catalog reader injected. */
  async function physicalShowcase(opts: { withCatalog: boolean }) {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    const built = buildProvider(root);
    if (opts.withCatalog) {
      built.provider.setCatalogService(new CatalogService());
    }
    const doc = makeDoc(file);
    const panel = vscode.createMockWebviewPanel();
    await built.provider.resolveCustomTextEditor(
      doc as unknown as import('vscode').TextDocument,
      panel as unknown as import('vscode').WebviewPanel,
      {} as import('vscode').CancellationToken,
    );
    panel._simulateMessage({ type: 'ready' });
    await waitForType(panel, 'domainLoaded');
    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await waitForType(panel, 'stageData');
    return posted(panel).find((m) => m.type === 'stageData')!.payload;
  }

  it('produces a physical stage with no catalog when none was injected', async () => {
    // Every other buildProvider() in this suite is in exactly this state, so
    // "purely additive" is proved by the whole file; this makes it explicit.
    const payload = await physicalShowcase({ withCatalog: false });

    expect(payload.physicalSources).toEqual({ yml: true, manifest: true, catalog: false });
    const task = payload.models.find((m: any) => m.name === 'dim_task');
    // The yml's own `data_type: STRING` stands, unchallenged by the warehouse.
    expect(task.columns.find((c: any) => c.name === 'status').dataType).toBe('STRING');
    expect(task.provenance).toEqual({ columns: ['yml'], types: 'yml' });
    const event = payload.models.find((m: any) => m.name === 'fct_task_event');
    expect(event.columns.map((c: any) => c.name)).not.toContain('loaded_at');
  });

  it('reads the fixture catalog once a service is injected', async () => {
    const payload = await physicalShowcase({ withCatalog: true });

    expect(payload.physicalSources).toEqual({ yml: true, manifest: true, catalog: true });

    const task = payload.models.find((m: any) => m.name === 'dim_task');
    // The warehouse says TEXT; the yml asserted STRING.
    expect(task.columns.find((c: any) => c.name === 'status').dataType).toBe('TEXT');
    expect(task.provenance).toEqual({ columns: ['catalog', 'yml'], types: 'catalog' });
    // Manifest-first for the schema: the catalog reports SILVER_SCHEMA.
    expect(task.schema).toBe('silver');
    // Declared spelling wins for display, not the catalog's UPPERCASE keys.
    expect(task.columns.map((c: any) => c.name)).toEqual(['task_key', 'project_key', 'name', 'status']);

    // A column the warehouse has and nothing declares is appended, not hidden.
    const event = payload.models.find((m: any) => m.name === 'fct_task_event');
    expect(event.columns.map((c: any) => c.name)).toContain('loaded_at');
  });
});

// ---------------------------------------------------------------------------
// H23 — physical stage guard & stage switching
// ---------------------------------------------------------------------------

describe('stage switching and the physical guard (H23)', () => {
  it('echoes the requestId on stageData', async () => {
    const { panel } = await openShowcase(root);

    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 42 } });
    await waitForType(panel, 'stageData');

    const reply = posted(panel).find((m) => m.type === 'stageData')!;
    expect(reply.requestId).toBe(42);
    expect(reply.payload.stage).toBe('physical');
    expect(reply.payload.readOnly).toBe(true);
  });

  it('omits requestId when the request carried none', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical' } });
    await waitForType(panel, 'stageData');
    const reply = posted(panel).find((m) => m.type === 'stageData')!;
    expect('requestId' in reply).toBe(false);
  });

  it('rejects an unknown stage with an error and stays on logical', async () => {
    const { panel } = await openShowcase(root);

    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'conceptual' } });
    await waitForError(panel, /unknown stage "conceptual"/);
    expect(types(panel)).not.toContain('stageData');

    // Still logical: a mutation is accepted (no read-only error)
    panel._simulateMessage({ type: 'updateModelGrain', payload: { modelName: 'dim_task', grain: 'one row per task' } });
    await waitForType(panel, 'domainLoaded', 2);
    expect(lastError(panel)).not.toBe(PHYSICAL_READ_ONLY_MESSAGE);
  });

  it('posts an error instead of silently dropping mutations while viewing physical', async () => {
    const { panel, file } = await openShowcase(root);
    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await waitForType(panel, 'stageData');
    const before = fs.readFileSync(file, 'utf-8');

    panel._simulateMessage({
      type: 'updateColumn',
      payload: { modelName: 'dim_task', oldColumnName: 'task_id', column: { name: 'task_key', dataType: 'int' } },
    });
    await waitForError(panel, new RegExp(PHYSICAL_READ_ONLY_MESSAGE.slice(0, 30)));
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('blocks undo/redo while viewing physical', async () => {
    const { panel } = await openShowcase(root);
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await waitForType(panel, 'stageData');

    panel._simulateMessage({ type: 'undo' });
    await waitForError(panel, /read-only/);
    expect(exec).not.toHaveBeenCalledWith('undo');
  });

  it('still allows position writes while viewing physical (shared viewConfig)', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await waitForType(panel, 'stageData');

    panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_task: { x: 5, y: 6 } } } });
    await vi.waitFor(() => expect(applyEditSpy).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(lastError(panel)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// H21 — payload validation
// ---------------------------------------------------------------------------

describe('payload validation (H21)', () => {
  it('rejects a model name that would escape logical-models/', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'addModel', payload: { name: '../evil', columns: [] } });
    await waitForError(panel, /path separators/);
    expect(fs.existsSync(path.join(root, '.erd-studio', 'evil.yml'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.erd-studio', 'logical-models', 'evil.yml'))).toBe(false);
    expect(applyEditSpy).not.toHaveBeenCalled();
  });

  it('rejects a model name with a leading digit (matches the rename rule)', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'addModel', payload: { name: '1dim', columns: [] } });
    await waitForError(panel, /start with a letter/);
  });

  it('rejects duplicate column names on addModel', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({
      type: 'addModel',
      payload: {
        name: 'dim_dupe',
        columns: [
          { name: 'name', dataType: 'string', description: '' },
          { name: 'is_active', dataType: 'boolean', description: '' },
          { name: 'name', dataType: 'string', description: '' },
        ],
      },
    });
    await waitForError(panel, /Duplicate column name "name"/);
    expect(fs.existsSync(path.join(root, '.erd-studio', 'logical-models', 'dim_dupe.yml'))).toBe(false);
  });

  it('accepts a valid addModel and writes the model file into the domain\'s layer folder', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({
      type: 'addModel',
      payload: { name: 'dim_fresh', columns: [{ name: 'fresh_id', dataType: 'int', description: '' }], modelRole: 'domain-dim' },
    });
    // showcase is a silver domain, so the new model lands in logical-models/silver/.
    await vi.waitFor(
      () => expect(fs.existsSync(path.join(root, '.erd-studio', 'logical-models', 'silver', 'dim_fresh.yml'))).toBe(true),
      { timeout: 4000 },
    );
    expect(fs.existsSync(path.join(root, '.erd-studio', 'logical-models', 'dim_fresh.yml'))).toBe(false);
    expect(lastError(panel)).toBeUndefined();
  });

  it('rejects an unknown modelRole on addModel', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'addModel', payload: { name: 'dim_role', columns: [], modelRole: 'dimension' } });
    await waitForError(panel, /unknown role "dimension"/);
  });

  it('rejects an unknown keyType', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({
      type: 'toggleColumnKey',
      payload: { modelName: 'dim_task', columnName: 'task_id', keyType: 'bogus', value: true },
    });
    await waitForError(panel, /Unknown key type "bogus"/);
    const yml = fs.readFileSync(path.join(root, '.erd-studio', 'logical-models', 'dim_task.yml'), 'utf-8');
    expect(yml).not.toContain('undefined');
  });

  it('rejects non-finite positions', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_task: { x: NaN, y: 1 } } } });
    await waitForError(panel, /finite/);
    expect(applyEditSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown cardinality on addRelationship', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({
      type: 'addRelationship',
      payload: { fromModel: 'fct_order', fromColumn: 'task_id', toModel: 'dim_task', toColumn: 'task_id', cardinality: 'lots' },
    });
    await waitForError(panel, /unknown cardinality "lots"/);
    expect(applyEditSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown modelRole on updateModelRole but accepts null', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'updateModelRole', payload: { modelName: 'dim_task', modelRole: 'dimension' } });
    await waitForError(panel, /unknown role "dimension"/);

    panel._simulateMessage({ type: 'updateModelRole', payload: { modelName: 'dim_task', modelRole: null } });
    await waitForType(panel, 'domainLoaded', 2);
  });

  it('rejects a non-finite annotation position', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'addAnnotation', payload: { id: 'n1', text: 'hi', x: Infinity, y: 0 } });
    await waitForError(panel, /Failed to add annotation/);
    expect(applyEditSpy).not.toHaveBeenCalled();
  });

  it('ignores a removeModels payload without a modelNames array', async () => {
    const { panel } = await openShowcase(root);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      panel._simulateMessage({ type: 'removeModels', payload: {} });
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
    expect(applyEditSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid rename target via the shared rule', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'renameModel', payload: { oldName: 'dim_task', newName: '../dim_task' } });
    await waitForError(panel, /path separators/);
    expect(fs.existsSync(path.join(root, '.erd-studio', 'logical-models', 'dim_task.yml'))).toBe(true);
  });

  it('rejects an invalid addExistingModel name before touching disk', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: '../dim_customer' } });
    await waitForError(panel, /path separators/);
    expect(applyEditSpy).not.toHaveBeenCalled();
  });

  it('rejects an updateAnnotation with a non-finite size before touching disk', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({
      type: 'updateAnnotation',
      payload: { id: 'note-1', width: Number.NaN, height: 120 },
    });
    await waitForError(panel, /width must be a finite number/);
    expect(applyEditSpy).not.toHaveBeenCalled();
  });

  it('rejects an updateAnnotation without a string id', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'updateAnnotation', payload: { id: 42, text: 'hi' } });
    await waitForError(panel, /id must be a non-empty string/);
    expect(applyEditSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// H36 — launching Claude Code for a sync plan
// ---------------------------------------------------------------------------

describe('launchClaudeSync (H36)', () => {
  async function flushMicrotasks(rounds = 20) {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
    }
  }

  it('does nothing when the confirmation is dismissed', async () => {
    const { panel } = await openShowcase(root);
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);

    panel._simulateMessage({ type: 'launchClaudeSync' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    await flushMicrotasks();

    expect(vscode.window.terminals).toHaveLength(0);
    const [message, options] = warn.mock.calls[0] as unknown as [string, { modal: boolean; detail: string }];
    expect(message).toMatch(/Launch Claude Code/);
    expect(options.modal).toBe(true);
    expect(options.detail).toContain('Command: claude');
  });

  it('launches plain `claude` by default and types the prompt after the delay', async () => {
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Launch' as never);
    vi.useFakeTimers();

    panel._simulateMessage({ type: 'launchClaudeSync' });
    await flushMicrotasks();

    expect(vscode.window.terminals).toHaveLength(1);
    const terminal = vscode.window.terminals[0];
    expect(terminal._sentText).toEqual(['claude']);

    await vi.advanceTimersByTimeAsync(2000);
    expect(terminal._sentText).toHaveLength(2);
    expect(terminal._sentText[1]).toMatch(/Execute the erd-studio sync plan at \.erd-studio\/\.sync-plan\.json/);
  });

  it('adds --dangerously-skip-permissions only when the setting is enabled and says so in the prompt', async () => {
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: (_k: string, d?: unknown) => d,
      inspect: (key: string) => (key === 'claudeSync.skipPermissions' ? { globalValue: true } : undefined),
    } as never);
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Launch' as never);
    vi.useFakeTimers();

    panel._simulateMessage({ type: 'launchClaudeSync' });
    await flushMicrotasks();

    const [, options] = warn.mock.calls[0] as unknown as [string, { detail: string }];
    expect(options.detail).toContain('--dangerously-skip-permissions');
    expect(vscode.window.terminals[0]._sentText[0]).toBe('claude --dangerously-skip-permissions');
  });

  it('skips the prompt when the terminal was closed before the delay elapsed', async () => {
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Launch' as never);
    vi.useFakeTimers();

    panel._simulateMessage({ type: 'launchClaudeSync' });
    await flushMicrotasks();
    const terminal = vscode.window.terminals[0];
    expect(terminal._sentText).toHaveLength(1);

    terminal.dispose();
    await expect(vi.advanceTimersByTimeAsync(2000)).resolves.not.toThrow();
    expect(terminal._sentText).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// H21 — message boundary: unknown types are logged, handler failures reported
// ---------------------------------------------------------------------------

describe('message boundary (H21)', () => {
  it('logs an unknown message type instead of dropping it silently', async () => {
    const { panel } = await openShowcase(root);
    const warn = vi.mocked(console.warn);
    warn.mockClear();

    panel._simulateMessage({ type: 'renameColumnGroup', payload: {} });
    await vi.waitFor(() =>
      expect(warn.mock.calls.some((c) => String(c[0]).includes('unknown webview message type "renameColumnGroup"'))).toBe(true),
    );
    expect(types(panel)).not.toContain('error');
    expect(applyEditSpy).not.toHaveBeenCalled();
  });

  it('logs a message without a string type', async () => {
    const { panel } = await openShowcase(root);
    const warn = vi.mocked(console.warn);
    warn.mockClear();

    panel._simulateMessage({ payload: { modelName: 'dim_task' } });
    await vi.waitFor(() =>
      expect(warn.mock.calls.some((c) => String(c[0]).includes('without a string "type"'))).toBe(true),
    );
    expect(types(panel)).not.toContain('error');
  });

  it('reports a handler that throws as an error message rather than an unhandled rejection', async () => {
    const { panel, provider } = await openShowcase(root);
    (provider as unknown as { handleUpdateModelGrain: unknown }).handleUpdateModelGrain = vi
      .fn()
      .mockRejectedValue(new Error('boom'));

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      panel._simulateMessage({ type: 'updateModelGrain', payload: { modelName: 'dim_task', grain: 'x' } });
      await waitForError(panel, /Failed to handle "updateModelGrain": boom/);
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);

    // The boundary must not poison the edit queue: a later mutation still runs.
    panel._simulateMessage({ type: 'updateModelRationale', payload: { modelName: 'dim_task', rationale: 'after' } });
    await waitForType(panel, 'domainLoaded', 2);
  });
});

// ---------------------------------------------------------------------------
// Feedback — `submitFeedback` message and requestFeedbackDialog()
// ---------------------------------------------------------------------------

const feedbackPayload = (overrides: Record<string, unknown> = {}) => ({
  kind: 'bug' as const,
  title: 'Edge vanished after rename',
  description: 'Renamed dim_task and the FK edge disappeared.',
  includeDiagnostics: true,
  domain: { stage: 'logical', modelCount: 4, relationshipCount: 3, schemaVersion: 5 },
  ...overrides,
});

const lastSubmitted = (panel: MockPanel) =>
  posted(panel).filter((m) => m.type === 'feedbackSubmitted').at(-1)?.payload as
    | { ok: boolean; commentedOn?: number; error?: string }
    | undefined;

describe('feedback (submitFeedback message)', () => {
  it('opens the prefilled GitHub issue for a valid payload', async () => {
    const { panel } = await openShowcase(root);
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    panel._simulateMessage({ type: 'submitFeedback', payload: feedbackPayload() });

    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const url = String(open.mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/github\.com\/liam-machine\/erd-studio\/issues\/new\?/);
    expect(url).toContain('template=bug_report.yml');
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain('title=Edge vanished after rename');
    expect(decoded).toContain('description=Renamed dim_task and the FK edge disappeared.');
    expect(decoded).toContain('Canvas:     stage=logical, schemaVersion=5');
    // Nothing in the filed issue names the user's own domain.
    expect(decoded).not.toContain('showcase');
    expect(decoded).toContain('ERD Studio: 0.0.0-test');
    await vi.waitFor(() => expect(lastSubmitted(panel)).toEqual({ ok: true }));
    expect(lastError(panel)).toBeUndefined();
  });

  it('is accepted while viewing the physical stage (it is not a schema mutation)', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await waitForType(panel, 'stageData');
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    panel._simulateMessage({ type: 'submitFeedback', payload: feedbackPayload() });

    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(lastError(panel)).not.toBe(PHYSICAL_READ_ONLY_MESSAGE);
  });

  it('answers a malformed payload with feedbackSubmitted { ok: false }, never a bare error', async () => {
    const { panel } = await openShowcase(root);
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    await panel._simulateMessage({ type: 'submitFeedback', payload: { title: 'no kind' } });
    await panel._simulateMessage({ type: 'submitFeedback', payload: null });
    await panel._simulateMessage({ type: 'submitFeedback' });
    await new Promise((r) => setTimeout(r, 20));

    expect(open).not.toHaveBeenCalled();
    expect(lastError(panel)).toBeUndefined();
    expect(posted(panel).filter((m) => m.type === 'feedbackSubmitted')).toHaveLength(3);
    expect(lastSubmitted(panel)?.ok).toBe(false);
    expect(typeof lastSubmitted(panel)?.error).toBe('string');
  });

  it('tells the user when the browser could not be opened, including the link', async () => {
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(false);
    const showError = vi.spyOn(vscode.window, 'showErrorMessage');

    panel._simulateMessage({ type: 'submitFeedback', payload: feedbackPayload() });

    await vi.waitFor(() =>
      expect(showError).toHaveBeenCalledWith(expect.stringMatching(/could not open the browser.*github\.com\/liam-machine\/erd-studio/)),
    );
    await vi.waitFor(() => expect(lastSubmitted(panel)?.ok).toBe(false));
    expect(lastError(panel)).toBeUndefined();
  });

  it('turns a thrown error into a failed reply and records it for later diagnostics', async () => {
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.env, 'openExternal').mockRejectedValue(new Error('EPERM'));

    panel._simulateMessage({ type: 'submitFeedback', payload: feedbackPayload() });

    await vi.waitFor(() => expect(lastSubmitted(panel)).toEqual({ ok: false, error: 'EPERM' }));
    expect(hostErrorLog.recent().at(-1)).toMatch(/\[submitFeedback\] EPERM$/);
    expect(types(panel)).not.toContain('error');
  });

  it('writes nothing to global storage — a report carries no files at all', async () => {
    // The dialog captures no image, so there is nothing to save as the
    // fallback for a refused clipboard, and no folder to reveal.
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    panel._simulateMessage({ type: 'submitFeedback', payload: feedbackPayload() });

    await vi.waitFor(() => expect(lastSubmitted(panel)?.ok).toBe(true));
    expect(fs.existsSync(path.join(root, '.global-storage', 'feedback'))).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('requestFeedbackDialog', () => {
  afterEach(() => {
    vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
  });

  it('routes to the focused canvas and returns true', async () => {
    const { provider, panel, doc } = await openShowcase(root);
    vscode.window.tabGroups.activeTabGroup.activeTab = {
      input: new vscode.TabInputCustom(doc.uri, DOMAIN_EDITOR_VIEW_TYPE),
    };

    expect(provider.requestFeedbackDialog({ kind: 'bug', title: 'From palette' })).toBe(true);

    await vi.waitFor(() =>
      expect(posted(panel).at(-1)).toEqual({
        type: 'openFeedback',
        payload: { kind: 'bug', title: 'From palette' },
      }),
    );
  });

  it('returns false (so the caller falls back to the QuickPick flow) when no canvas of ours is focused', async () => {
    const { provider, panel } = await openShowcase(root);
    const before = posted(panel).length;

    vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
    expect(provider.requestFeedbackDialog()).toBe(false);

    // A text editor tab (not a custom editor input)
    vscode.window.tabGroups.activeTabGroup.activeTab = { input: { uri: vscode.Uri.file('/elsewhere.json') } };
    expect(provider.requestFeedbackDialog()).toBe(false);

    // One of our canvases, but for a document this provider has not opened
    vscode.window.tabGroups.activeTabGroup.activeTab = {
      input: new vscode.TabInputCustom(
        vscode.Uri.file(path.join(root, '.erd-studio', 'silver', 'other.json')),
        DOMAIN_EDITOR_VIEW_TYPE,
      ),
    };
    expect(provider.requestFeedbackDialog()).toBe(false);

    expect(posted(panel).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Layer folders — logical-models/{layer}/{name}.yml (issue #76)
// ---------------------------------------------------------------------------

describe('modelFolderForDomain', () => {
  it('is the layer directory of the domain file', () => {
    expect(modelFolderForDomain('/p/.erd-studio/silver/showcase.json')).toBe('silver');
    expect(modelFolderForDomain('/p/.erd-studio/gold/finance.json')).toBe('gold');
    expect(modelFolderForDomain(path.join('C:', 'p', '.erd-studio', 'bronze', 'x.json'))).toBe('bronze');
  });

  it('returns whatever the parent directory is called (LogicalModelService rejects non-layer names)', () => {
    expect(modelFolderForDomain('/tmp/Some Folder/domain.json')).toBe('Some Folder');
  });
});

describe('layer folders in the edit pipeline (issue #76)', () => {
  const lib = () => path.join(root, '.erd-studio', 'logical-models');

  /** Move a fixture model file from the top level into logical-models/{folder}/. */
  function moveIntoFolder(name: string, folder: string, prependComment?: string): string {
    const from = path.join(lib(), `${name}.yml`);
    const to = path.join(lib(), folder, `${name}.yml`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const text = fs.readFileSync(from, 'utf-8');
    fs.writeFileSync(to, prependComment ? `${prependComment}\n${text}` : text);
    fs.unlinkSync(from);
    return to;
  }

  /** Write an empty v5 domain at {layer}/{domain}.json, open it in a fresh provider and wait for the first load. */
  async function openNewDomain(layer: string, domain: string) {
    const file = path.join(root, '.erd-studio', layer, `${domain}.json`);
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 5,
      domain,
      layer,
      description: '',
      logical: { models: [], relationships: [] },
      viewConfig: { positions: {} },
    }, null, 2) + '\n');
    const built = buildProvider(root);
    const doc = makeDoc(file);
    const panel = vscode.createMockWebviewPanel();
    await built.provider.resolveCustomTextEditor(
      doc as unknown as import('vscode').TextDocument,
      panel as unknown as import('vscode').WebviewPanel,
      {} as import('vscode').CancellationToken,
    );
    panel._simulateMessage({ type: 'ready' });
    await waitForType(panel, 'domainLoaded');
    return { ...built, doc, panel, file };
  }

  it('renaming a model that lives in silver/ writes the new file in silver/ and deletes the old one', async () => {
    moveIntoFolder('dim_task', 'silver', '# hand-written note');
    const { panel, doc } = await openShowcase(root);
    const loads = types(panel).filter((t) => t === 'domainLoaded').length;

    panel._simulateMessage({ type: 'renameModel', payload: { oldName: 'dim_task', newName: 'dim_work_item' } });
    await waitForType(panel, 'domainLoaded', loads + 1);

    const renamed = path.join(lib(), 'silver', 'dim_work_item.yml');
    expect(fs.existsSync(renamed)).toBe(true);
    expect(fs.existsSync(path.join(lib(), 'silver', 'dim_task.yml'))).toBe(false);
    expect(fs.existsSync(path.join(lib(), 'dim_work_item.yml'))).toBe(false);
    const text = fs.readFileSync(renamed, 'utf-8');
    expect(text).toContain('# hand-written note');
    expect(text).toContain('name: dim_work_item');
    expect(JSON.parse(doc.getText()).logical.models).toContain('dim_work_item');
    expect(lastError(panel)).toBeUndefined();
  });

  it('renaming a top-level model keeps it at the top level, even from a silver domain', async () => {
    const { panel } = await openShowcase(root);
    const loads = types(panel).filter((t) => t === 'domainLoaded').length;

    panel._simulateMessage({ type: 'renameModel', payload: { oldName: 'dim_task', newName: 'dim_work_item' } });
    await waitForType(panel, 'domainLoaded', loads + 1);

    expect(fs.existsSync(path.join(lib(), 'dim_work_item.yml'))).toBe(true);
    expect(fs.existsSync(path.join(lib(), 'silver', 'dim_work_item.yml'))).toBe(false);
    expect(fs.existsSync(path.join(lib(), 'dim_task.yml'))).toBe(false);
  });

  it('an edit to a model in silver/ edits that file in place and creates no top-level file', async () => {
    const inFolder = moveIntoFolder('dim_task', 'silver', '# keep this comment');
    const { panel } = await openShowcase(root);

    panel._simulateMessage({
      type: 'updateModelDescription',
      payload: { modelName: 'dim_task', description: 'Edited in its layer folder' },
    });
    await vi.waitFor(
      () => expect(fs.readFileSync(inFolder, 'utf-8')).toContain('description: Edited in its layer folder'),
      { timeout: 4000 },
    );
    expect(fs.readFileSync(inFolder, 'utf-8')).toContain('# keep this comment');
    expect(fs.existsSync(path.join(lib(), 'dim_task.yml'))).toBe(false);

    panel._simulateMessage({
      type: 'addColumn',
      payload: { modelName: 'dim_task', column: { name: 'extra_col', dataType: 'int', description: '' } },
    });
    await vi.waitFor(
      () => expect(fs.readFileSync(inFolder, 'utf-8')).toContain('extra_col'),
      { timeout: 4000 },
    );
    expect(fs.existsSync(path.join(lib(), 'dim_task.yml'))).toBe(false);
    expect(fs.readdirSync(path.join(lib(), 'silver'))).toEqual(['dim_task.yml']);
    expect(lastError(panel)).toBeUndefined();
  });

  it('a model at the top level stays there when edited from a silver domain (no migration on edit)', async () => {
    const topLevel = path.join(lib(), 'dim_customer.yml');
    const { panel } = await openShowcase(root);

    panel._simulateMessage({
      type: 'updateModelDescription',
      payload: { modelName: 'dim_customer', description: 'Still at the top' },
    });
    await vi.waitFor(
      () => expect(fs.readFileSync(topLevel, 'utf-8')).toContain('description: Still at the top'),
      { timeout: 4000 },
    );
    expect(fs.existsSync(path.join(lib(), 'silver', 'dim_customer.yml'))).toBe(false);
    expect(fs.existsSync(path.join(lib(), 'silver'))).toBe(false);
  });

  it('addExistingModel seeds a new library file from the dbt yml into the domain\'s layer folder', async () => {
    // fct_sale is in the dbt project yml but not in showcase; drop its library file so it gets seeded.
    fs.unlinkSync(path.join(lib(), 'fct_sale.yml'));
    const { panel, doc } = await openShowcase(root);
    const loads = types(panel).filter((t) => t === 'domainLoaded').length;

    panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: 'fct_sale' } });
    await waitForType(panel, 'domainLoaded', loads + 1);

    const seeded = path.join(lib(), 'silver', 'fct_sale.yml');
    expect(fs.existsSync(seeded)).toBe(true);
    expect(fs.readFileSync(seeded, 'utf-8')).toContain('name: fct_sale');
    expect(fs.existsSync(path.join(lib(), 'fct_sale.yml'))).toBe(false);
    expect(JSON.parse(doc.getText()).logical.models).toContain('fct_sale');
    expect(lastError(panel)).toBeUndefined();
  });

  it('addExistingModel from a gold domain seeds into gold/', async () => {
    fs.unlinkSync(path.join(lib(), 'fct_sale.yml'));
    const { panel } = await openNewDomain('gold', 'reporting');
    const loads = types(panel).filter((t) => t === 'domainLoaded').length;

    panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: 'fct_sale' } });
    await waitForType(panel, 'domainLoaded', loads + 1);

    expect(fs.existsSync(path.join(lib(), 'gold', 'fct_sale.yml'))).toBe(true);
    expect(fs.existsSync(path.join(lib(), 'silver', 'fct_sale.yml'))).toBe(false);
  });

  it('addExistingModel of a model already in another layer folder references it without moving or copying', async () => {
    const inSilver = moveIntoFolder('fct_sale', 'silver');
    const { panel, doc } = await openNewDomain('gold', 'reporting');
    const loads = types(panel).filter((t) => t === 'domainLoaded').length;

    panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: 'fct_sale' } });
    await waitForType(panel, 'domainLoaded', loads + 1);

    expect(fs.existsSync(inSilver)).toBe(true);
    expect(fs.existsSync(path.join(lib(), 'gold', 'fct_sale.yml'))).toBe(false);
    expect(fs.existsSync(path.join(lib(), 'fct_sale.yml'))).toBe(false);
    expect(JSON.parse(doc.getText()).logical.models).toContain('fct_sale');
  });

  it('names the real folder when addModel collides with a model in a layer folder', async () => {
    moveIntoFolder('fct_sale', 'gold');
    const { panel } = await openShowcase(root);
    panel._simulateMessage({
      type: 'addModel',
      payload: { name: 'fct_sale', columns: [{ name: 'sale_id', dataType: 'int', description: '' }] },
    });
    await waitForError(panel, /already exists in the model library/);
    expect(lastError(panel)).toContain('(logical-models/gold/fct_sale.yml)');
    expect(fs.existsSync(path.join(lib(), 'silver', 'fct_sale.yml'))).toBe(false);
  });

  it('names the real folder when a rename collides with a model in a layer folder', async () => {
    moveIntoFolder('fct_sale', 'gold');
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'renameModel', payload: { oldName: 'dim_task', newName: 'fct_sale' } });
    await waitForError(panel, /already exists in the model library/);
    expect(lastError(panel)).toContain('(logical-models/gold/fct_sale.yml)');
    expect(fs.existsSync(path.join(lib(), 'dim_task.yml'))).toBe(true);
  });
});
