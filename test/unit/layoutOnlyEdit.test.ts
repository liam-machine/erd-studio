/**
 * Moving a table is cheap, and its save never comes back as an external change
 * (Lane A step 2):
 *
 * - a layout-only edit (positions, sticky-note boxes) writes a DBML diagram's
 *   `.dbdiagram` alone, with a one-character undo anchor on the `.dbml`, and
 *   plans nothing against the table library; a JSON diagram's write is its own
 *   file, as before; `onDidWriteSubjectArea` carries `layoutOnly`;
 * - `applyFileWrites` leaves out a replace that changes nothing;
 * - drags that queue up while the host is busy are saved as one edit;
 * - the watchers take the saves for our own however late their debounced
 *   callback runs, and wait for a save that is still in flight.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  _appliedEdits,
  _clearMockFileWatchers,
  _fireDidChangeTextDocument,
  TextDocumentChangeReason,
  _mockFileWatchers,
  _resetMockWorkspace,
  createMockTextDocument,
  createMockWebviewPanel,
} from '../__mocks__/vscode';
import type { MockEditOp, WorkspaceEdit as MockWorkspaceEdit } from '../__mocks__/vscode';
import { SemanticEditorProvider, TABLE_REFRESH_BATCH_MS } from '../../src/providers/SemanticEditorProvider';
import type { SubjectAreaWriteEvent } from '../../src/providers/SemanticEditorProvider';
import { applyFileWrites, undoAnchor } from '../../src/providers/applyFileWrites';
import { isLayoutOnlyChange } from '../../src/providers/subjectAreaCodec';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { FileWatcherService } from '../../src/watchers/FileWatcherService';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');

let root: string;
const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const relOf = (abs: string): string => path.relative(path.join(root, '.erd-studio'), abs).split(path.sep).join('/');

interface Harness {
  provider: SemanticEditorProvider;
  tables: TableLibraryService;
  tracker: OwnWriteTracker;
  panel: ReturnType<typeof createMockWebviewPanel>;
  document: ReturnType<typeof createMockTextDocument>;
  events: SubjectAreaWriteEvent[];
  errors(): string[];
}

async function open(diagram = 'gold/sales.dbml', tracker = new OwnWriteTracker()): Promise<Harness> {
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
  } as unknown as vscode.ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  const selectors = new SelectorsService(subjectAreaService, root, '.erd-studio');
  vi.spyOn(selectors, 'scheduleRegenerate').mockImplementation(() => undefined);
  const provider = new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty, getRelationshipTests: () => [] } as unknown as ManifestService,
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    root,
    selectors,
    tables,
    tracker,
  );
  const events: SubjectAreaWriteEvent[] = [];
  provider.onDidWriteSubjectArea((e) => events.push(e));
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
  return {
    provider, tables, tracker, panel, document, events,
    errors: () => panel._postedMessages
      .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
      .map((m) => m.payload.message),
  };
}

const opsOf = (edit: unknown): MockEditOp[] => (edit as MockWorkspaceEdit)._ops;
const pathsOf = (edit: unknown): string[] => [...new Set(opsOf(edit).map((op) => relOf((op as { uri: { fsPath: string } }).uri.fsPath)))].sort();

beforeEach(() => {
  _resetMockWorkspace();
  _clearMockFileWatchers();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-layout-only-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isLayoutOnlyChange', () => {
  const base = {
    schemaVersion: 5, domain: 'd', layer: 'gold',
    logical: { models: ['a', 'b'], relationships: [] },
    viewConfig: { showFkEdges: true, positions: { a: { x: 1, y: 2 } }, annotations: [{ id: 'n1', text: 'hi', x: 0, y: 0, width: 100 }] },
  };
  const clone = (): typeof base => structuredClone(base);

  it('is true for moved tables, moved or resized notes, and a first position', () => {
    const moved = clone(); moved.viewConfig.positions.a = { x: 5, y: 6 };
    expect(isLayoutOnlyChange(base, moved)).toBe(true);
    const note = clone(); note.viewConfig.annotations[0].x = 40; note.viewConfig.annotations[0].width = 240;
    expect(isLayoutOnlyChange(base, note)).toBe(true);
    const bare = { schemaVersion: 5, domain: 'd', layer: 'gold', logical: { models: ['a'] } };
    expect(isLayoutOnlyChange(bare, { ...bare, viewConfig: { positions: { a: { x: 0, y: 0 } } } })).toBe(true);
  });

  it('is false when nothing changed, or anything but the layout changed', () => {
    expect(isLayoutOnlyChange(base, clone())).toBe(false);
    const text = clone(); text.viewConfig.annotations[0].text = 'bye';
    expect(isLayoutOnlyChange(base, text)).toBe(false);
    const member = clone(); member.logical.models.push('c'); member.viewConfig.positions = { ...member.viewConfig.positions, c: { x: 0, y: 0 } } as never;
    expect(isLayoutOnlyChange(base, member)).toBe(false);
    const edges = clone(); edges.viewConfig.showFkEdges = false;
    expect(isLayoutOnlyChange(base, edges)).toBe(false);
    const noteGone = clone(); noteGone.viewConfig.annotations = [];
    expect(isLayoutOnlyChange(base, noteGone)).toBe(false);
  });
});

describe('undo/redo flushes the layout file only when the step rewound it', () => {
  function openLayoutTab(): ReturnType<typeof createMockTextDocument> {
    const layoutPath = at('gold/sales.dbdiagram');
    const layoutDoc = createMockTextDocument(layoutPath, fs.readFileSync(layoutPath, 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(layoutDoc);
    return layoutDoc;
  }

  it('a .dbdiagram with unsaved hand edits the step did not touch is neither saved nor recorded as ours', async () => {
    const h = await open();
    const layoutDoc = openLayoutTab();
    const diskBefore = fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8');
    layoutDoc._setText(diskBefore.replace(/\}\s*$/, ', "handEdit": tr'));
    const recordWrite = vi.spyOn(h.tracker, 'recordWrite');
    await h.panel._simulateMessage({ type: 'undo' });
    expect(fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8')).toBe(diskBefore);
    expect(layoutDoc.isDirty).toBe(true);
    expect(recordWrite.mock.calls.map((c) => relOf(c[0]))).not.toContain('gold/sales.dbdiagram');
  });

  it('a .dbdiagram the undo rewound is saved, even when this canvas never wrote it (the step is from before it opened)', async () => {
    const h = await open();
    const layoutDoc = openLayoutTab();
    const rewound = fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8').replace('"x": ', '"x": 1');
    const undo = vscode.commands.registerCommand('undo', async () => {
      layoutDoc._setText(rewound);
      await _fireDidChangeTextDocument(layoutDoc, TextDocumentChangeReason.Undo);
    });
    try {
      await h.panel._simulateMessage({ type: 'undo' });
    } finally {
      undo.dispose();
    }
    expect(fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8')).toBe(rewound);
    expect(layoutDoc.isDirty).toBe(false);
    // The next undo that does not touch it leaves a later hand edit alone.
    layoutDoc._setText(`${rewound} `);
    await h.panel._simulateMessage({ type: 'undo' });
    expect(fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8')).toBe(rewound);
  });

  /**
   * After a move, a hand edit in the .dbdiagram's own tab, then an undo of
   * the move, which VS Code refuses across files ("Could not undo 'Workspace
   * Edit' across all files because changes were made to …dbdiagram"). What
   * VS Code really emits (UndoRedoService._tryToSplitAndUndo): the hand
   * edit's change event (no reason), then the step SPLIT and this diagram's
   * part undone alone — the one-character anchor, so the .dbml keeps its
   * text but turns dirty, and one Undo event for it. The .dbdiagram gets no
   * Undo event.
   */
  async function refusedUndoAfterMove() {
    const h = await open();
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    const layoutDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === at('gold/sales.dbdiagram')) as unknown as ReturnType<typeof createMockTextDocument>;
    expect(layoutDoc).toBeDefined();
    const diskBefore = fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8');
    const dbmlBefore = fs.readFileSync(at('gold/sales.dbml'), 'utf-8');
    layoutDoc._setText(`${diskBefore}\n`);
    await _fireDidChangeTextDocument(layoutDoc);
    h.events.length = 0;
    h.panel._postedMessages.length = 0;
    const spies = {
      recordWrite: vi.spyOn(h.tracker, 'recordWrite'),
      invalidateIndex: vi.spyOn(h.tables, 'invalidateIndex'),
      invalidatePaths: vi.spyOn(h.tables, 'invalidatePaths'),
    };
    const splitUndo = async (): Promise<void> => {
      h.document._setText(h.document.getText());
      await _fireDidChangeTextDocument(h.document, TextDocumentChangeReason.Undo);
    };
    const expectNothingRefreshed = (): void => {
      expect(fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8')).toBe(diskBefore);
      expect(fs.readFileSync(at('gold/sales.dbml'), 'utf-8')).toBe(dbmlBefore);
      expect(layoutDoc.isDirty).toBe(true);
      expect(h.document.isDirty).toBe(false);
      expect(spies.recordWrite.mock.calls.map((c) => relOf(c[0]))).not.toContain('gold/sales.dbdiagram');
      expect(spies.invalidateIndex).not.toHaveBeenCalled();
      expect(spies.invalidatePaths).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
      expect(h.panel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded')).toEqual([]);
      expect(h.errors()).toEqual([]);
    };
    return { h, splitUndo, expectNothingRefreshed };
  }

  it('after a move, Cmd+Z on the canvas that VS Code refuses across files (the .dbdiagram was hand-edited since) leaves the hand edit unsaved and refreshes nothing', async () => {
    const { splitUndo, expectNothingRefreshed } = await refusedUndoAfterMove();
    await splitUndo();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expectNothingRefreshed();
  });

  it('the same refused undo from the toolbar refreshes nothing either', async () => {
    const { h, splitUndo, expectNothingRefreshed } = await refusedUndoAfterMove();
    const refused = vscode.commands.registerCommand('undo', splitUndo);
    try {
      await h.panel._simulateMessage({ type: 'undo' });
    } finally {
      refused.dispose();
    }
    expectNothingRefreshed();
  });

  it('an anchor-only undo that took away a file this canvas created still refreshes the library', async () => {
    const h = await open();
    // A table this canvas created, which the undo of its create deleted (no text event).
    const created = at('tables/gold/dim_new.dbml');
    (h.provider as unknown as { editedTablePaths: Map<string, Set<string>> }).editedTablePaths
      .set(h.document.uri.toString(), new Set([created]));
    const invalidateIndex = vi.spyOn(h.tables, 'invalidateIndex');
    h.document._setText(h.document.getText());
    await _fireDidChangeTextDocument(h.document, TextDocumentChangeReason.Undo);
    await vi.waitFor(() => expect(invalidateIndex).toHaveBeenCalled());
    expect(h.events).toEqual([{ uri: h.document.uri, modelLibraryChanged: true }]);
  });

  it('the undo of a move is layout-only: one send, no library invalidation, no tree refresh; the save\'s dirty-state event sends nothing', async () => {
    const h = await open();
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    const layoutDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === at('gold/sales.dbdiagram')) as unknown as ReturnType<typeof createMockTextDocument>;
    expect(layoutDoc).toBeDefined();
    const moved = layoutDoc.getText();
    const undoneText = moved.replace('"x": 420, "y": 220', '"x": 40, "y": 20');
    const undo = vscode.commands.registerCommand('undo', async () => {
      // VS Code rewinds the anchor (the .dbml text as on disk) and the layout file.
      h.document._setText(h.document.getText());
      await _fireDidChangeTextDocument(h.document, TextDocumentChangeReason.Undo);
      layoutDoc._setText(undoneText);
      await _fireDidChangeTextDocument(layoutDoc, TextDocumentChangeReason.Undo);
    });
    h.events.length = 0;
    h.panel._postedMessages.length = 0;
    const invalidateIndex = vi.spyOn(h.tables, 'invalidateIndex');
    const invalidatePaths = vi.spyOn(h.tables, 'invalidatePaths');
    try {
      await h.panel._simulateMessage({ type: 'undo' });
    } finally {
      undo.dispose();
    }
    expect(fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8')).toBe(undoneText);
    expect(h.events).toEqual([{ uri: h.document.uri, modelLibraryChanged: false, layoutOnly: true }]);
    expect(invalidateIndex).not.toHaveBeenCalled();
    expect(invalidatePaths).not.toHaveBeenCalled();
    const sends = (): number => h.panel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded').length;
    expect(sends()).toBe(1);
    // The save's dirty-state change events (no content change) arrive after the hold: nothing is sent again.
    await _fireDidChangeTextDocument(h.document, undefined, []);
    expect(sends()).toBe(1);
  });
});

describe('a Cmd+Z that arrives while the canvas is still flushing the last one', () => {
  /**
   * Live at 1,100 tables: two Cmd+Z 78 ms apart after moves. The second
   * undo's events reached the listener while the first one's flush held
   * `pendingUpdates` (it had saved, and was redrawing): they were dropped,
   * so nothing saved the rewound .dbml and .dbdiagram, and VS Code's
   * TextFileEditorTracker opened the dirty .dbdiagram as a tab 800 ms later.
   */
  it('is flushed after it, so neither file is left dirty and the layout holds the second rewind', async () => {
    const h = await open();
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 520, y: 320 } } } });
    const layoutDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === at('gold/sales.dbdiagram')) as unknown as ReturnType<typeof createMockTextDocument>;
    expect(layoutDoc).toBeDefined();
    const second = layoutDoc.getText();
    const first = second.replace('"x": 520, "y": 320', '"x": 420, "y": 220');
    const original = second.replace('"x": 520, "y": 320', '"x": 40, "y": 20');
    expect(first).not.toBe(second);
    const nativeUndo = async (text: string): Promise<void> => {
      // VS Code rewinds the anchor (the .dbml keeps its text, but is dirty) and the layout file.
      h.document._setText(h.document.getText());
      await _fireDidChangeTextDocument(h.document, TextDocumentChangeReason.Undo);
      layoutDoc._setText(text);
      await _fireDidChangeTextDocument(layoutDoc, TextDocumentChangeReason.Undo);
    };
    // The second Cmd+Z lands while the first one's flush redraws the canvas.
    const provider = h.provider as unknown as { sendSubjectAreaData: (...args: unknown[]) => Promise<unknown> };
    const send = provider.sendSubjectAreaData.bind(h.provider);
    let secondFired = false;
    const spy = vi.spyOn(provider, 'sendSubjectAreaData').mockImplementation(async (...args: unknown[]) => {
      if (!secondFired) {
        secondFired = true;
        await nativeUndo(original);
      }
      return send(...args);
    });
    await nativeUndo(first);
    await vi.waitFor(() => expect(secondFired).toBe(true), { timeout: 2000, interval: 10 });
    await vi.waitFor(() => {
      expect(layoutDoc.isDirty).toBe(false);
      expect(h.document.isDirty).toBe(false);
    }, { timeout: 2000, interval: 10 });
    expect(fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8')).toBe(original);
    expect(spy.mock.calls.length).toBe(2);
    expect(h.errors()).toEqual([]);
  });

  it('a rewind that lands while the last flush is saving the layout is saved, though VS Code then reports the layout saved', async () => {
    // Live, the same two quick Cmd+Z: the second rewound the .dbdiagram while
    // the first flush's save of it was in flight. VS Code wrote the earlier
    // text and kept its own copy dirty, but its saved event marked the
    // extension's copy clean (and no dirty event followed), so a flush that
    // skips clean documents left it dirty, and VS Code opened it as a tab.
    const h = await open();
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 520, y: 320 } } } });
    const layoutPath = at('gold/sales.dbdiagram');
    const layoutDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === layoutPath) as unknown as ReturnType<typeof createMockTextDocument>;
    const second = layoutDoc.getText();
    const first = second.replace('"x": 520, "y": 320', '"x": 420, "y": 220');
    const original = second.replace('"x": 520, "y": 320', '"x": 40, "y": 20');
    const nativeUndo = async (text: string): Promise<void> => {
      h.document._setText(h.document.getText());
      await _fireDidChangeTextDocument(h.document, TextDocumentChangeReason.Undo);
      layoutDoc._setText(text);
      await _fireDidChangeTextDocument(layoutDoc, TextDocumentChangeReason.Undo);
    };
    let vsCodeDirty = false;
    let inFlight = true;
    layoutDoc.save = async () => {
      if (inFlight) {
        inFlight = false;
        const snapshot = layoutDoc.getText();
        await nativeUndo(original);
        fs.writeFileSync(layoutPath, snapshot, 'utf-8');
        vsCodeDirty = true;
        layoutDoc.isDirty = false;
        return true;
      }
      fs.writeFileSync(layoutPath, layoutDoc.getText(), 'utf-8');
      vsCodeDirty = false;
      layoutDoc.isDirty = false;
      return true;
    };
    await nativeUndo(first);
    await vi.waitFor(() => expect(inFlight).toBe(false), { timeout: 2000, interval: 10 });
    await vi.waitFor(() => expect(vsCodeDirty).toBe(false), { timeout: 2000, interval: 10 });
    expect(fs.readFileSync(layoutPath, 'utf-8')).toBe(original);
    expect(h.document.isDirty).toBe(false);
    expect(h.errors()).toEqual([]);
  });

  it('the toolbar\'s own Undo is flushed once, by itself', async () => {
    const h = await open();
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    const layoutDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === at('gold/sales.dbdiagram')) as unknown as ReturnType<typeof createMockTextDocument>;
    const undoneText = layoutDoc.getText().replace('"x": 420, "y": 220', '"x": 40, "y": 20');
    const undo = vscode.commands.registerCommand('undo', async () => {
      h.document._setText(h.document.getText());
      await _fireDidChangeTextDocument(h.document, TextDocumentChangeReason.Undo);
      layoutDoc._setText(undoneText);
      await _fireDidChangeTextDocument(layoutDoc, TextDocumentChangeReason.Undo);
    });
    h.panel._postedMessages.length = 0;
    try {
      await h.panel._simulateMessage({ type: 'undo' });
    } finally {
      undo.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8')).toBe(undoneText);
    expect(h.panel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded')).toHaveLength(1);
  });
});

describe('a drag on a DBML diagram writes the layout file alone', () => {
  it('one edit: the .dbdiagram and a one-character undo anchor on the .dbml, whose bytes stay', async () => {
    const h = await open();
    const planTableWrites = vi.spyOn(h.tables, 'planTableWrites');
    const invalidatePaths = vi.spyOn(h.tables, 'invalidatePaths');
    const invalidateCache = vi.spyOn(h.tables, 'invalidateCache');
    const listTables = vi.spyOn(h.tables, 'listTables');
    const dbmlBefore = fs.readFileSync(at('gold/sales.dbml'), 'utf-8');

    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });

    expect(h.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(pathsOf(_appliedEdits[0])).toEqual(['gold/sales.dbdiagram', 'gold/sales.dbml']);
    const anchor = opsOf(_appliedEdits[0]).find((op) => relOf((op as { uri: { fsPath: string } }).uri.fsPath) === 'gold/sales.dbml') as { newText: string };
    expect(anchor.newText).toHaveLength(1);
    expect(fs.readFileSync(at('gold/sales.dbml'), 'utf-8')).toBe(dbmlBefore);
    expect(fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8')).toContain('"name": "fct_order", "schemaName": "public", "x": 420, "y": 220');
    // Nothing planned against, or dropped from, the table library.
    expect(planTableWrites).not.toHaveBeenCalled();
    expect(listTables).not.toHaveBeenCalled();
    expect(invalidatePaths).not.toHaveBeenCalled();
    expect(invalidateCache).not.toHaveBeenCalled();
    expect(h.events).toEqual([{ uri: h.document.uri, modelLibraryChanged: false, layoutOnly: true }]);
    // Saved, not left dirty; the layout is not remembered for Undo, which
    // saves it only when its own step rewound it.
    expect(vscode.workspace.textDocuments.filter((d) => d.isDirty)).toEqual([]);
    const edited = (h.provider as unknown as { editedTablePaths: Map<string, Set<string>> }).editedTablePaths.get(h.document.uri.toString());
    expect([...(edited ?? [])].map(relOf)).not.toContain('gold/sales.dbdiagram');
  });

  it('a note moved in the same drag, and a note resized, are layout-only too', async () => {
    const h = await open();
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_date: { x: 60, y: 380 } }, annotations: [{ id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', x: 1200, y: 80 }] } });
    await h.panel._simulateMessage({ type: 'updateAnnotation', payload: { id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', width: 300, height: 160 } });
    expect(h.errors()).toEqual([]);
    expect(h.events.map((e) => e.layoutOnly)).toEqual([true, true]);
    const layout = fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8');
    expect(layout).toContain('"x": 1200, "y": 80, "width": 300, "height": 160');
  });

  it('a note text change is not layout-only: the .dbml is written and the trees are told', async () => {
    const h = await open();
    await h.panel._simulateMessage({ type: 'updateAnnotation', payload: { id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', text: 'Grain agreed' } });
    expect(h.errors()).toEqual([]);
    expect(h.events).toHaveLength(1);
    expect(h.events[0].layoutOnly).toBeUndefined();
    expect(fs.readFileSync(at('gold/sales.dbml'), 'utf-8')).toContain("'Grain agreed'");
  });

  it('a layout file open with unsaved changes refuses the drag by name, writing nothing', async () => {
    const h = await open();
    const layoutDoc = createMockTextDocument(at('gold/sales.dbdiagram'), fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(layoutDoc);
    layoutDoc._setText(`${layoutDoc.getText()}\n`);
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    expect(h.errors().join(' ')).toContain('gold/sales.dbdiagram has unsaved changes');
    expect(_appliedEdits).toHaveLength(0);
  });

  it('a drop where the table already was writes nothing', async () => {
    const h = await open();
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 400, y: 200 } } } });
    expect(h.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(0);
    expect(h.events).toEqual([]);
  });
});

describe('a drag on a JSON diagram', () => {
  it('writes the diagram (it holds the positions) and is layout-only for the trees', async () => {
    fs.writeFileSync(at('gold/plain.json'), `${JSON.stringify({
      schemaVersion: 5, domain: 'plain', layer: 'gold',
      logical: { models: ['fct_order'], relationships: [] }, viewConfig: { positions: { fct_order: { x: 0, y: 0 } } },
    }, null, 2)}\n`);
    const h = await open('gold/plain.json');
    const planTableWrites = vi.spyOn(h.tables, 'planTableWrites');
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 90, y: 30 } } } });
    expect(h.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(pathsOf(_appliedEdits[0])).toEqual(['gold/plain.json']);
    expect(JSON.parse(fs.readFileSync(at('gold/plain.json'), 'utf-8')).viewConfig.positions.fct_order).toEqual({ x: 90, y: 30 });
    expect(planTableWrites).not.toHaveBeenCalled();
    expect(h.events).toEqual([{ uri: h.document.uri, modelLibraryChanged: false, layoutOnly: true }]);
  });
});

describe('applyFileWrites', () => {
  it('leaves out a replace whose text the file already holds (no edit, no save)', async () => {
    const primary = createMockTextDocument(at('gold/sales.dbml'), fs.readFileSync(at('gold/sales.dbml'), 'utf-8'), { persist: true });
    const same = fs.readFileSync(at('tables/dim_date.dbml'), 'utf-8');
    const applied = await applyFileWrites(
      [{ kind: 'replace', path: at('tables/dim_date.dbml'), text: same }, { kind: 'replace', path: at('gold/sales.dbdiagram'), text: '{}\n' }],
      { primary: { document: primary as unknown as vscode.TextDocument, text: `${primary.getText()}// x\n` } },
    );
    expect(applied.ok).toBe(true);
    expect(applied.replaced.map((u) => relOf(u.fsPath))).toEqual(['gold/sales.dbdiagram']);
    expect(pathsOf(_appliedEdits[0])).toEqual(['gold/sales.dbdiagram', 'gold/sales.dbml']);
    // A changed primary is still replaced whole.
    const full = opsOf(_appliedEdits[0])[0] as { newText: string };
    expect(full.newText.endsWith('// x\n')).toBe(true);
  });

  it('anchors an unchanged primary with one character, skipping line breaks', () => {
    const doc = createMockTextDocument(at('gold/anchor.dbml'), '\r\n\nProject p {}\n');
    const anchor = undoAnchor(doc as unknown as vscode.TextDocument);
    expect(anchor.text).toBe('P');
    expect(doc.offsetAt(anchor.range.start as never)).toBe(3);
    expect(doc.offsetAt(anchor.range.end as never)).toBe(4);
    const blank = createMockTextDocument(at('gold/blank.dbml'), '\n');
    expect(undoAnchor(blank as unknown as vscode.TextDocument).text).toBe('\n');
  });
});

describe('drags that queue up while the host is busy', () => {
  it('are saved as one edit with the later positions winning, and both senders resolve', async () => {
    const h = await open();
    // Hold the queue: the first drag's save waits until released.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realApply = vscode.workspace.applyEdit;
    let first = true;
    const spy = vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => {
      if (first) { first = false; await gate; }
      return realApply(edit);
    });
    const a = h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 401, y: 201 } } } });
    await new Promise((r) => setTimeout(r, 0));
    const b = h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_date: { x: 50, y: 370 } } } });
    const c = h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_date: { x: 55, y: 375 }, dim_region: { x: 700, y: 50 } } } });
    release();
    await Promise.all([a, b, c]);
    expect(h.errors()).toEqual([]);
    // The first drag, then ONE edit for the two that waited.
    expect(spy).toHaveBeenCalledTimes(2);
    const layout = fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8');
    expect(layout).toContain('"name": "fct_order", "schemaName": "public", "x": 401, "y": 201');
    expect(layout).toContain('"name": "dim_date", "schemaName": "public", "x": 55, "y": 375');
    expect(layout).toContain('"name": "dim_region", "schemaName": "public", "x": 700, "y": 50');
  });

  it('are not folded across another edit queued between them, so edits stay in order', async () => {
    const h = await open();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realApply = vscode.workspace.applyEdit;
    let first = true;
    const spy = vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => {
      if (first) { first = false; await gate; }
      return realApply(edit);
    });
    const a = h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 401, y: 201 } } } });
    await new Promise((r) => setTimeout(r, 0));
    const b = h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_date: { x: 50, y: 370 } } } });
    const c = h.panel._simulateMessage({ type: 'updateModelDescription', payload: { modelName: 'dim_region', description: 'Regions' } });
    const d = h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_date: { x: 55, y: 375 } } } });
    release();
    await Promise.all([a, b, c, d]);
    expect(h.errors()).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(4);
    expect(fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8')).toContain('"name": "dim_date", "schemaName": "public", "x": 55, "y": 375');
  });
});

describe('own-write echo after a busy host (watchers)', () => {
  const semanticWatcher = () => _mockFileWatchers.find((w) => JSON.stringify(w._pattern ?? '').includes('dbdiagram'))!;
  const tableWatcher = () => _mockFileWatchers.find((w) => JSON.stringify(w._pattern ?? '').includes('{yml,dbml}'))!;

  it('a drag\'s .dbdiagram and .dbml saves are ours even when the watcher callback runs 12 s later', async () => {
    const tracker = new OwnWriteTracker();
    const h = await open('gold/sales.dbml', tracker);
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    expect(h.errors()).toEqual([]);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const watcher = new FileWatcherService(root, '.erd-studio', undefined, tracker, { dbt: false });
    const changed = vi.fn();
    watcher.onSemanticFileChanged(changed);
    try {
      semanticWatcher()._simulateChange(vscode.Uri.file(at('gold/sales.dbdiagram')));
      semanticWatcher()._simulateChange(vscode.Uri.file(at('gold/sales.dbml')));
      // The host was blocked: the debounced callbacks run long after the 5 s the old tracker allowed.
      vi.setSystemTime(Date.now() + 12_000);
      vi.advanceTimersByTime(300);
      expect(changed).not.toHaveBeenCalled();

      // A real change made afterwards is still reported.
      vi.advanceTimersByTime(5_000);
      fs.appendFileSync(at('gold/sales.dbdiagram'), '\n');
      semanticWatcher()._simulateChange(vscode.Uri.file(at('gold/sales.dbdiagram')));
      vi.advanceTimersByTime(300);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.mock.calls[0][0]).toMatchObject({ layout: true });
    } finally {
      watcher.dispose();
    }
  });

  it('waits for a save still in flight instead of calling it external (a .dbml table)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const tracker = new OwnWriteTracker();
    const watcher = new FileWatcherService(root, '.erd-studio', undefined, tracker, { dbt: false });
    const changed = vi.fn();
    watcher.onTableChanged(changed);
    try {
      const file = at('tables/gold/fct_order.dbml');
      tracker.expectWrite([file]);
      fs.appendFileSync(file, '\n');
      tableWatcher()._simulateChange(vscode.Uri.file(file));
      // The timer fires before the save's completion was processed: it waits.
      vi.advanceTimersByTime(900);
      expect(changed).not.toHaveBeenCalled();
      tracker.recordWrite(file);
      vi.advanceTimersByTime(300);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      watcher.dispose();
    }
  });

  it('a save that never lands stops holding the watcher back (bounded), and the change is reported', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const tracker = new OwnWriteTracker();
    const watcher = new FileWatcherService(root, '.erd-studio', undefined, tracker, { dbt: false });
    const changed = vi.fn();
    watcher.onSemanticFileChanged(changed);
    try {
      const file = at('gold/sales.dbdiagram');
      tracker.expectWrite([file]);
      fs.appendFileSync(file, '\n');
      semanticWatcher()._simulateChange(vscode.Uri.file(file));
      vi.advanceTimersByTime(30_000);
      expect(changed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(31_000);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      watcher.dispose();
    }
  });
});

describe('a canvas whose panel is gone is never refreshed again', () => {
  const panelsOf = (provider: SemanticEditorProvider): Map<string, unknown> =>
    (provider as unknown as { openPanels: Map<string, unknown> }).openPanels;
  const loads = (panel: ReturnType<typeof createMockWebviewPanel>): number =>
    panel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded').length;

  it('VS Code closed the tab (Undo deleted its file) and the dispose never reached us: skipped and forgotten', async () => {
    const h = await open();
    Object.defineProperty(h.panel, 'active', { get() { throw new Error('Webview is disposed'); } });
    await h.provider.refreshAllOpenSubjectAreas();
    await h.provider.refreshSubjectAreasReferencingTable('fct_order');
    await h.provider.refreshSubjectAreaPanel(h.document.uri.fsPath);
    expect(loads(h.panel)).toBe(0);
    expect(panelsOf(h.provider).has(h.document.uri.toString())).toBe(false);
  });

  it('closeCanvasesOf disposes the canvases of those files and forgets them; others still refresh', async () => {
    const h = await open();
    const disposed = vi.fn();
    h.panel.onDidDispose(disposed);
    h.provider.closeCanvasesOf([h.document.uri.fsPath]);
    expect(disposed).toHaveBeenCalled();
    expect(panelsOf(h.provider).has(h.document.uri.toString())).toBe(false);
    await h.provider.refreshAllOpenSubjectAreas();
    expect(loads(h.panel)).toBe(0);
  });
});

describe('outside changes to many table files redraw each canvas once', () => {
  const loads = (panel: ReturnType<typeof createMockWebviewPanel>): number =>
    panel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded').length;

  it('a burst of queued table changes is one refresh per canvas naming any of them, none for a canvas naming none', async () => {
    const h = await open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const send = vi.spyOn(h.provider as unknown as { sendSubjectAreaData: (...a: unknown[]) => Promise<void> }, 'sendSubjectAreaData');
    for (const name of ['fct_order', 'dim_date', 'dim_customer', 'FCT_ORDER', 'not_in_this_diagram']) h.provider.queueTableRefresh(name);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TABLE_REFRESH_BATCH_MS);
    vi.useRealTimers();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(loads(h.panel)).toBe(1);
    send.mockClear();
    await h.provider.refreshSubjectAreasReferencingTables(['not_in_this_diagram']);
    expect(send).not.toHaveBeenCalled();
  });
});
