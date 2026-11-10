/**
 * Canvas handler failures in usage telemetry (plan B12): counted at the
 * message boundary or in a handler's own catch, once per error, by the
 * message type's group; a relationship handler keeps only relHandlerFailed;
 * a refusal the user was told about is editRefused, except a DBML writer's
 * own overlap, which is ours (dbmlWriteOverlap). Plus the protocol rejects:
 * an unknown message type, an edit dropped on the Physical stage, and a
 * canvas asking to reload. Fixed keys only, never a message.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { DbmlEditRefused } from '@erd-studio/core/dbml';

import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { telemetry } from '../../src/services/telemetryService';
import { markRecorded } from '../../src/services/telemetryOnce';
import * as recovery from '../../src/services/recoveryService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');

type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
type Posted = { type: string; payload?: { message?: string } };

let root: string;

function buildProvider() {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: vscode.createMockMemento(),
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  return new SemanticEditorProvider(
    context, subjectAreaService, new ManifestService(), new YmlParserService(), new TemplateService(), layerService, root,
    new SelectorsService(subjectAreaService, root, '.erd-studio'), tableLibraryService,
  );
}

async function openShowcase(): Promise<{ provider: SemanticEditorProvider; panel: MockPanel }> {
  const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
  const text = fs.readFileSync(file, 'utf-8');
  const doc = {
    uri: vscode.Uri.file(file), isDirty: false, isClosed: false, getText: () => text,
    positionAt: (offset: number) => ({ offset }), save: vi.fn(async () => true),
  };
  const provider = buildProvider();
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  panel._simulateMessage({ type: 'ready' });
  await waitForType(panel, 'domainLoaded');
  return { provider, panel };
}

const posted = (panel: MockPanel) => panel._postedMessages as Posted[];
async function waitForType(panel: MockPanel, type: string, count = 1) {
  await vi.waitFor(() => expect(posted(panel).filter((m) => m.type === type).length).toBeGreaterThanOrEqual(count), { timeout: 4000, interval: 10 });
}

let error: ReturnType<typeof vi.spyOn>;
let feature: ReturnType<typeof vi.spyOn>;
/** The failure keys recorded since the canvas opened (errors as `!code`). */
const recorded = () => [
  ...error.mock.calls.map((c) => `!${String(c[0])}`),
  ...feature.mock.calls.map((c) => String(c[0])).filter((k) => k === 'editRefused' || k === 'canvasReconnectReload'),
];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-handler-tel-'));
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  vscode._resetMockWorkspace();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Open the canvas, then start counting (opening records its own keys). */
async function opened() {
  const open = await openShowcase();
  error = vi.spyOn(telemetry, 'error');
  feature = vi.spyOn(telemetry, 'feature');
  return open;
}

const ADD_COLUMN = { type: 'addColumn', payload: { modelName: 'dim_customer', column: { name: 'tel_check', dataType: 'STRING', description: '' } } };

describe('B12: canvas handler failures', () => {
  it('a column handler that fails records handlerFailedColumn once (its own catch; the boundary adds nothing)', async () => {
    const { provider, panel } = await opened();
    vi.spyOn(provider as never, 'applyTableEdit' as never).mockRejectedValue(new Error('/home/someone/secret broke') as never);
    panel._simulateMessage(ADD_COLUMN);
    await waitForType(panel, 'error');
    expect(recorded()).toEqual(['!handlerFailed', '!handlerFailedColumn']);
  });

  it('a handler that throws through the boundary records its group once, and the user still sees the error', async () => {
    const { provider, panel } = await opened();
    vi.spyOn(provider as never, 'handleUndoRedo' as never).mockRejectedValue(new Error('undo broke') as never);
    panel._simulateMessage({ type: 'undo' });
    await waitForType(panel, 'error');
    expect(recorded()).toEqual(['!handlerFailed', '!handlerFailedUndo']);
    expect(posted(panel).filter((m) => m.type === 'error').at(-1)?.payload?.message).toMatch(/Failed to handle "undo"/);
  });

  it('an error already counted is not counted again at the boundary', async () => {
    const { provider, panel } = await opened();
    const err = new Error('counted already');
    markRecorded(err);
    vi.spyOn(provider as never, 'handleUndoRedo' as never).mockRejectedValue(err as never);
    panel._simulateMessage({ type: 'redo' });
    await waitForType(panel, 'error');
    expect(recorded()).toEqual([]);
  });

  it('a relationship handler that fails records only relHandlerFailed, not handlerFailed', async () => {
    const { provider, panel } = await opened();
    vi.spyOn(provider as never, 'commitRelationshipWrite' as never).mockRejectedValue(new Error('rel broke') as never);
    panel._simulateMessage({
      type: 'updateRelationship',
      payload: { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' },
    });
    await waitForType(panel, 'error');
    expect(recorded()).toEqual(['!relHandlerFailed']);
  });

  it('a DBML writer overlap is ours: dbmlWriteOverlap beside the failure, though the user is told as for a refusal', async () => {
    const { provider, panel } = await opened();
    const overlap = new DbmlEditRefused('gold/tables/x.dbml', 'ERD Studio could not apply this change safely.', undefined, 'overlap');
    vi.spyOn(provider as never, 'applyTableEdit' as never).mockRejectedValue(overlap as never);
    panel._simulateMessage(ADD_COLUMN);
    await waitForType(panel, 'error');
    expect(recorded()).toEqual(['!dbmlWriteOverlap', '!handlerFailed', '!handlerFailedColumn']);

    error.mockClear();
    feature.mockClear();
    vi.spyOn(provider as never, 'commitRelationshipWrite' as never).mockRejectedValue(
      new DbmlEditRefused('gold/relationships/r.dbml', 'not safely', undefined, 'overlap') as never,
    );
    panel._simulateMessage({
      type: 'updateRelationship',
      payload: { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' },
    });
    await waitForType(panel, 'error', 2);
    expect(recorded()).toEqual(['!dbmlWriteOverlap', '!relHandlerFailed']);
  });

  it('a refusal the user was told about is editRefused, not a failure', async () => {
    const { provider, panel } = await opened();
    vi.spyOn(provider as never, 'applyTableEdit' as never).mockRejectedValue(new DbmlEditRefused('gold/tables/x.dbml', 'Fix the DBML first.') as never);
    panel._simulateMessage(ADD_COLUMN);
    await waitForType(panel, 'error');
    expect(recorded()).toEqual(['editRefused']);
  });
});

describe('B12: protocol rejects', () => {
  it('an unknown message type records messageUnknownType', async () => {
    const { panel } = await opened();
    await panel._simulateMessage({ type: 'fromANewerWebview' });
    await vi.waitFor(() => expect(recorded()).toEqual(['!messageUnknownType']));
  });

  it('an edit reaching the Physical stage records physicalEditDropped', async () => {
    const { panel } = await opened();
    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await waitForType(panel, 'stageData');
    error.mockClear();
    panel._simulateMessage(ADD_COLUMN);
    await waitForType(panel, 'error');
    expect(recorded()).toEqual(['!physicalEditDropped']);
  });

  it('a canvas asking to reload records canvasReconnectReload', async () => {
    const { panel } = await opened();
    const reload = vi.spyOn(recovery, 'saveAllAndReload').mockResolvedValue(true as never);
    await panel._simulateMessage({ type: 'requestReload' });
    await vi.waitFor(() => expect(recorded()).toEqual(['canvasReconnectReload']));
    expect(reload).toHaveBeenCalled();
  });
});
