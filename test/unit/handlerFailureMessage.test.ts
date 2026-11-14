/**
 * What the canvas is told when a handler fails (#319).
 *
 * A failure of ours (any throw that is not a refusal written for the user,
 * nor the user's own diagram file) says so in plain words and never shows
 * the exception's text, a local path or an internal message type. A refusal
 * written for the user keeps its text.
 *
 * Run on a copy of the `dbml-native` fixture through the real
 * SemanticEditorProvider.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _appliedEdits, _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';
import { telemetry } from '../../src/services/telemetryService';
import { handlerFailureMessage, oursMessage } from '../../src/services/commandErrors';
import { editFailureTag, newEditCursor, tagEditFailure, type EditStage } from '../../src/services/editFailureStage';
import { handlerFailureKeys } from '../../src/services/runtimeTelemetry';
import { ERROR_CODES } from '../../src/services/telemetryPayload';
import { AmbiguousTableName } from '../../src/services/ambiguousTableName';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');

let root: string;
const at = (rel: string): string => path.join(root, '.erd-studio', rel);

type MockPanel = ReturnType<typeof createMockWebviewPanel>;

function buildProvider(): SemanticEditorProvider {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tables = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tables);
  const context = {
    extensionUri: vscode.Uri.file(path.join(root, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  const selectors = new SelectorsService(subjectAreaService, root, '.erd-studio');
  vi.spyOn(selectors, 'scheduleRegenerate').mockImplementation(() => undefined);
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty, getRelationshipTests: () => [] } as unknown as ManifestService,
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    root,
    selectors,
    tables,
    new OwnWriteTracker(),
  );
}

interface ErrorPayload { message: string; feedback?: { kind: string; title: string; description: string } }

/** Open `diagram` on the canvas; `errors()` is every `error` message posted since, `payloads()` their whole payloads. */
async function open(diagram = 'gold/diagrams/sales.dbml'): Promise<{ provider: SemanticEditorProvider; panel: MockPanel; errors: () => string[]; payloads: () => ErrorPayload[] }> {
  const provider = buildProvider();
  const document = createMockTextDocument(at(diagram), fs.readFileSync(at(diagram), 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    document as unknown as vscode.TextDocument,
    panel as unknown as vscode.WebviewPanel,
    {} as vscode.CancellationToken,
  );
  _appliedEdits.length = 0;
  panel._postedMessages.length = 0;
  const payloads = (): ErrorPayload[] => panel._postedMessages
    .filter((m): m is { type: 'error'; payload: ErrorPayload } => (m as { type: string }).type === 'error')
    .map((m) => m.payload);
  const errors = (): string[] => payloads().map((p) => p.message);
  return { provider, panel, errors, payloads };
}

const RAW = 'boom at /home/x/secret.dbml';
const MOVE = { type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } };
const ADD_COLUMN = { type: 'addColumn', payload: { modelName: 'fct_order', column: { name: 'discount', dataType: 'DECIMAL', description: '' } } };
const SEND_US = "This isn't something you did. Please send us a report.";

/** The error codes recorded since `spy` was made, in order. */
const codes = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-handler-msg-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // A test may have locked a folder.
  try { fs.chmodSync(at('silver/tables'), 0o755); } catch { /* not there */ }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('#319: a handler failure of ours never shows the exception', () => {
  it('updatePositions: the layout write throws a plain Error', async () => {
    const { provider, panel, payloads } = await open();
    vi.spyOn(provider as never, 'applyLayoutOnlyEdit' as never).mockRejectedValue(new Error(RAW) as never);
    const error = vi.spyOn(telemetry, 'error');
    await panel._simulateMessage(MOVE);
    expect(payloads()).toHaveLength(1);
    const [{ message, feedback }] = payloads();
    expect(message).toBe(
      `Saving this diagram's layout hit a problem in ERD Studio while writing the positions, so the tables you moved were not saved. ${SEND_US}`,
    );
    expect(message).not.toContain('boom');
    expect(message).not.toContain('secret.dbml');
    // The exception goes in the report, with its path reduced to a shape.
    expect(feedback?.kind).toBe('bug');
    expect(feedback?.description).toContain('boom at');
    expect(feedback?.description).not.toContain('/home/x');
    // Telemetry says which step threw and on which storage, once.
    expect(codes(error)).toEqual(['handlerFailed', 'handlerFailedLayout', 'handlerFailedAtLayoutWrite', 'handlerFailedDbml']);
  });

  it('the boundary: a handler that throws past its own catch names neither the exception nor the message type', async () => {
    const { provider, panel, payloads } = await open();
    vi.spyOn(provider as never, 'handleUndoRedo' as never).mockRejectedValue(new Error(RAW) as never);
    const error = vi.spyOn(telemetry, 'error');
    await panel._simulateMessage({ type: 'undo' });
    expect(payloads()).toHaveLength(1);
    const [{ message, feedback }] = payloads();
    expect(message).toBe(`That action hit a problem in ERD Studio while handling it, so it may not have been done. ${SEND_US}`);
    expect(message).not.toContain('undo');
    // The report says which canvas message it was; the toast never does.
    expect(feedback?.description).toContain('Canvas message: undo');
    expect(feedback?.description).toContain('boom at');
    expect(feedback?.description).not.toContain('/home/x');
    expect(codes(error)).toEqual(['handlerFailed', 'handlerFailedUndo', 'handlerFailedAtOther']);
  });

  it("a refusal written for the user keeps today's text and gets no button (a table file open with unsaved changes)", async () => {
    const { panel, payloads } = await open();
    const doc = createMockTextDocument(at('gold/tables/gold/fct_order.dbml'), fs.readFileSync(at('gold/tables/gold/fct_order.dbml'), 'utf-8'));
    doc._setText(`${doc.getText()}// typing\n`);
    (vscode.workspace.textDocuments as unknown[]).push(doc);
    const error = vi.spyOn(telemetry, 'error');
    await panel._simulateMessage(ADD_COLUMN);
    expect(payloads()).toEqual([
      { message: 'Failed to add column: .erd-studio/gold/tables/gold/fct_order.dbml has unsaved changes. Save or revert it, then try again.' },
    ]);
    expect(_appliedEdits).toHaveLength(0);
    expect(codes(error)).toEqual([]);
  });

  it('a refusal that reaches the boundary is shown in its own words, without the message type', async () => {
    const { provider, panel, payloads } = await open();
    vi.spyOn(provider as never, 'handleUndoRedo' as never).mockRejectedValue(new AmbiguousTableName('adresse', [{ schema: 'bqs', name: 'adresse' }, { schema: 'ccc', name: 'adresse' }]) as never);
    await panel._simulateMessage({ type: 'undo' });
    expect(payloads()).toEqual([
      { message: 'More than one table is named adresse (bqs.adresse, ccc.adresse), and this change does not say which one; nothing was changed.' },
    ]);
  });

  it('a name that is already taken is still said in its own words (never "a problem in ERD Studio")', async () => {
    const { panel, payloads } = await open();
    const error = vi.spyOn(telemetry, 'error');
    const taken = fs.readFileSync(at('gold/tables/gold/fct_order.dbml'), 'utf-8').match(/^\s+(\w+)\s+\w+/m)![1];
    await panel._simulateMessage({ type: 'addColumn', payload: { modelName: 'fct_order', column: { name: taken, dataType: 'INT', description: '' } } });
    expect(payloads()).toEqual([{ message: `Failed to add column: Column "${taken}" already exists.` }]);
    expect(codes(error)).toEqual([]);
  });
});

describe('#319: what the toast says was left behind follows how far the edit got', () => {
  it('a failure AFTER the edit was saved says the change was made, and counts handlerFailedAtOther', async () => {
    const { provider, panel, payloads } = await open();
    const before = fs.readFileSync(at('gold/tables/gold/fct_order.dbml'), 'utf-8');
    // The redraw that follows the save throws: the column is on disk by then.
    vi.spyOn(provider as never, 'sendSubjectAreaData' as never).mockRejectedValue(new Error(RAW) as never);
    const error = vi.spyOn(telemetry, 'error');
    await panel._simulateMessage(ADD_COLUMN);
    const after = fs.readFileSync(at('gold/tables/gold/fct_order.dbml'), 'utf-8');
    expect(after).not.toBe(before);
    expect(after).toContain('discount');
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0].message).toBe(
      `Adding the column hit a problem in ERD Studio after making the change, so the change was made, but the diagram may not show it yet. ${SEND_US}`,
    );
    expect(payloads()[0].feedback?.description).toContain('boom at');
    expect(codes(error)).toEqual(['handlerFailed', 'handlerFailedColumn', 'handlerFailedAtOther', 'handlerFailedDbml']);
  });

  it('a folder that may not be written is the user\'s to fix: plain words, no errno, no absolute path, no button', async () => {
    const { panel, payloads } = await open('silver/diagrams/staging.dbml');
    fs.chmodSync(at('silver/tables'), 0o555);
    await panel._simulateMessage({ type: 'addModel', payload: { name: 'dim_store', description: '', columns: [{ name: 'store_key', dataType: 'INT', description: '', isPrimaryKey: true }] } });
    expect(payloads()).toEqual([
      { message: "Failed to add table: ERD Studio isn't allowed to write to .erd-studio/silver/tables. Check the folder's permissions, then try again." },
    ]);
  });

  it.each([
    ['parseSubjectAreaFile', 'handlerFailedAtRead', 'while reading the diagram', false],
    ['applyStorageEdit', 'handlerFailedAtStorageWrite', 'while writing the change', true],
  ] as const)('a throw in %s counts %s', async (method, code, doing, storageKnown) => {
    const { provider, panel, payloads } = await open();
    const spy = vi.spyOn(provider as never, method as never);
    if (method === 'parseSubjectAreaFile') spy.mockImplementation((() => { throw new Error(RAW); }) as never);
    else spy.mockRejectedValue(new Error(RAW) as never);
    const error = vi.spyOn(telemetry, 'error');
    await panel._simulateMessage({ type: 'addAnnotation', payload: { text: 'note', x: 10, y: 10 } });
    expect(payloads()[0].message).toBe(`Adding the note hit a problem in ERD Studio ${doing}, so nothing was changed. ${SEND_US}`);
    expect(codes(error)).toEqual(['handlerFailed', 'handlerFailedAnnotation', code, ...(storageKnown ? ['handlerFailedDbml'] : [])]);
  });
});

describe('#319: handlerFailureMessage (the one rule)', () => {
  const words = { label: 'Failed to add column', title: 'Adding the column' };

  it('explained: the label and the failure\'s own words, no prefill', () => {
    expect(handlerFailureMessage(new Error('x.yml has unsaved changes.'), words, { explained: true, stage: 'jsonWrite', applied: false }))
      .toEqual({ message: 'Failed to add column: x.yml has unsaved changes.' });
  });

  it('ours: oursMessage by stage, and the exception only in the prefill, redacted', () => {
    const err = new Error('ENOENT-ish at /Users/someone/proj/.erd-studio/gold/sales.json');
    const stages: EditStage[] = ['read', 'mutate', 'layoutWrite', 'storageWrite', 'jsonWrite', 'save', 'other'];
    for (const stage of stages) {
      const toast = handlerFailureMessage(err, words, { explained: false, stage, applied: false });
      expect(toast.message, stage).toMatch(/^Adding the column hit a problem in ERD Studio while .+, so nothing was changed\. This isn't something you did\. Please send us a report\.$/);
      expect(toast.message, stage).not.toContain('someone');
      expect(toast.feedback?.title).toBe('Adding the column failed');
      expect(toast.feedback?.description, stage).toContain('ENOENT-ish');
      expect(toast.feedback?.description, stage).not.toContain('/Users/someone');
    }
  });

  it('ours, outside the edit pipeline: says the change may not have been made, or the handler\'s own words', () => {
    expect(handlerFailureMessage(new Error('x'), words, { explained: false }).message)
      .toBe(oursMessage('Adding the column', 'while making the change', 'the change may not have been made'));
    expect(handlerFailureMessage(new Error('x'), { title: 'Generating the sync plan', doing: 'while writing the plan', outcome: 'no plan was generated' }, { explained: false }).message)
      .toBe(oursMessage('Generating the sync plan', 'while writing the plan', 'no plan was generated'));
  });

  it('a thrown value that is not an Error is still never shown', () => {
    const toast = handlerFailureMessage('raw string /home/x/a.json', words, { explained: false });
    expect(toast.message).not.toContain('raw string');
    expect(toast.feedback?.description).toContain('raw string');
  });

  it('a full disk is said in plain words', () => {
    const err = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    expect(handlerFailureMessage(err, words, { explained: false, stage: 'storageWrite', applied: false }))
      .toEqual({ message: 'Failed to add column: the disk is full. Free up some space, then try again.' });
  });
});

describe('#319: the stage tag and its keys', () => {
  it('the first tag wins, and a value that is not an object reads as untagged', () => {
    const err = new Error('x');
    const at = newEditCursor();
    at.stage = 'mutate';
    at.storage = 'dbml';
    tagEditFailure(err, at);
    at.stage = 'other';
    tagEditFailure(err, { stage: 'save', storage: 'json', applied: true });
    expect(editFailureTag(err)).toEqual({ stage: 'mutate', storage: 'dbml', applied: false });
    tagEditFailure('text', at);
    expect(editFailureTag('text')).toBeUndefined();
  });

  it.each([
    ['read', 'handlerFailedAtRead'], ['mutate', 'handlerFailedAtMutate'], ['layoutWrite', 'handlerFailedAtLayoutWrite'],
    ['storageWrite', 'handlerFailedAtStorageWrite'], ['jsonWrite', 'handlerFailedAtJsonWrite'], ['save', 'handlerFailedAtSave'],
    ['other', 'handlerFailedAtOther'],
  ] as const)('stage %s is %s, exactly one beside the total and its group', (stage, code) => {
    expect(handlerFailureKeys('layout', { explained: false, overlap: false, stage, storage: 'dbml' }).errors)
      .toEqual(['handlerFailed', 'handlerFailedLayout', code, 'handlerFailedDbml']);
    expect(handlerFailureKeys('model', { explained: false, overlap: false, stage, storage: 'json' }).errors)
      .toEqual(['handlerFailed', 'handlerFailedModel', code, 'handlerFailedJson']);
    expect(ERROR_CODES).toContain(code);
  });

  it('untagged is handlerFailedAtOther with no storage key; a refusal, a file problem and a relationship failure get none', () => {
    expect(handlerFailureKeys('details', { explained: false, overlap: false }).errors).toEqual(['handlerFailed', 'handlerFailedDetails', 'handlerFailedAtOther']);
    expect(handlerFailureKeys('layout', { explained: true, overlap: false, stage: 'layoutWrite', storage: 'dbml' })).toEqual({ errors: [], features: ['editRefused'] });
    expect(handlerFailureKeys('stage', { explained: false, overlap: false, userFile: true, stage: 'read', storage: 'json' })).toEqual({ errors: [], features: ['handlerFileProblem'] });
    expect(handlerFailureKeys('relationship', { explained: false, overlap: false, stage: 'storageWrite', storage: 'dbml' }).errors).toEqual(['relHandlerFailed']);
    expect(ERROR_CODES).toContain('handlerFailedDbml');
    expect(ERROR_CODES).toContain('handlerFailedJson');
  });
});
