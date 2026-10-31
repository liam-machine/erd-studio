/**
 * Moving a table is cheap, and its save never comes back as an external change
 * (Lane A step 2, §2.7 of the 2.0 design):
 *
 * - a layout-only edit (positions, sticky-note boxes) rewrites a DBML
 *   diagram's `erd_layout` alone, as ONE minimal-range edit of the `.dbml`
 *   (never formatted), and plans nothing against the table library; native
 *   Cmd+Z rewinds that edit and is layout-only too; a JSON diagram's write is
 *   its own file, a full-range replace, as before; `onDidWriteSubjectArea`
 *   carries `layoutOnly`;
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
  _mockFormatOnSave,
  _resetMockWorkspace,
  createMockTextDocument,
  createMockWebviewPanel,
} from '../__mocks__/vscode';
import type { MockEditOp, WorkspaceEdit as MockWorkspaceEdit } from '../__mocks__/vscode';
import { SemanticEditorProvider, TABLE_REFRESH_BATCH_MS } from '../../src/providers/SemanticEditorProvider';
import type { SubjectAreaWriteEvent } from '../../src/providers/SemanticEditorProvider';
import { applyFileWrites, minimalReplace, undoAnchor } from '../../src/providers/applyFileWrites';
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
import { formatWrittenDbml } from '../../src/services/dbmlWriters';
import { clearDbmlDiagramReadings } from '../../src/services/dbmlDiagramReadings';
import { erdLayoutEntrySpan } from '@erd-studio/core/dbml';
import { registerDbmlFormatting } from '../../src/providers/dbmlFormattingProvider';

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

async function open(diagram = 'gold/diagrams/sales.dbml', tracker = new OwnWriteTracker()): Promise<Harness> {
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
  clearDbmlDiagramReadings();
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

/** The diagram's text with its erd_layout entry cut out: what a drag must leave byte for byte. */
function outsideLayout(text: string): string {
  const span = erdLayoutEntrySpan(text)!;
  return text.slice(0, span.start) + text.slice(span.end);
}

/** The erd_layout entry of a diagram's text (its whole lines). */
function layoutEntry(text: string): string {
  const span = erdLayoutEntrySpan(text)!;
  return text.slice(span.start, span.end);
}

describe('a drag on a DBML diagram rewrites its erd_layout alone', () => {
  it('one edit of the diagram, a minimal-range replace inside erd_layout; every other byte and file stays', async () => {
    const h = await open();
    const planTableWrites = vi.spyOn(h.tables, 'planTableWrites');
    const invalidatePaths = vi.spyOn(h.tables, 'invalidatePaths');
    const invalidateCache = vi.spyOn(h.tables, 'invalidateCache');
    const listTables = vi.spyOn(h.tables, 'listTables');
    const dbmlBefore = fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8');
    // The fixture is not in the canonical layout, so a formatted write would show: a move never formats.
    expect(formatWrittenDbml(dbmlBefore, 'gold/diagrams/sales.dbml')).not.toBe(dbmlBefore);
    const othersBefore = new Map(['gold/tables/gold/fct_order.dbml', 'gold/relationships/gold.dbml', 'silver/diagrams/staging.dbml'].map((p) => [p, fs.readFileSync(at(p), 'utf-8')]));

    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });

    expect(h.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(pathsOf(_appliedEdits[0])).toEqual(['gold/diagrams/sales.dbml']);
    const ops = opsOf(_appliedEdits[0]) as Array<{ kind: string; range: { start: unknown; end: unknown }; newText: string }>;
    expect(ops).toHaveLength(1);
    // The replaced range lies inside the erd_layout entry, and is far smaller than the file.
    const span = erdLayoutEntrySpan(dbmlBefore)!;
    const start = h.document.offsetAt(ops[0].range.start as never);
    expect(start).toBeGreaterThanOrEqual(span.start);
    expect(ops[0].newText.length).toBeLessThan(40);
    const after = fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8');
    expect(outsideLayout(after)).toBe(outsideLayout(dbmlBefore));
    expect(layoutEntry(after)).toContain('    fct_order 420 220\n');
    // A Project-first diagram keeps its order (§1.4).
    expect(after.startsWith('Project sales {')).toBe(true);
    for (const [p, text] of othersBefore) expect(fs.readFileSync(at(p), 'utf-8'), p).toBe(text);
    // Nothing planned against, or dropped from, the table library.
    expect(planTableWrites).not.toHaveBeenCalled();
    expect(listTables).not.toHaveBeenCalled();
    expect(invalidatePaths).not.toHaveBeenCalled();
    expect(invalidateCache).not.toHaveBeenCalled();
    expect(h.events).toEqual([{ uri: h.document.uri, modelLibraryChanged: false, layoutOnly: true }]);
    expect(vscode.workspace.textDocuments.filter((d) => d.isDirty)).toEqual([]);
  });

  it('with editor.formatOnSave on, the drag\'s save does not format the .dbml; the user\'s own save still formats', async () => {
    const subscriptions: vscode.Disposable[] = [];
    registerDbmlFormatting({ subscriptions } as unknown as vscode.ExtensionContext);
    _mockFormatOnSave.enabled = true;
    try {
      const h = await open();
      const dbmlBefore = fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8');
      expect(formatWrittenDbml(dbmlBefore, 'gold/diagrams/sales.dbml')).not.toBe(dbmlBefore);

      await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });

      expect(h.errors()).toEqual([]);
      const after = fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8');
      expect(outsideLayout(after)).toBe(outsideLayout(dbmlBefore));
      expect(h.document.getText()).toBe(after);
      expect(vscode.workspace.textDocuments.filter((d) => d.isDirty)).toEqual([]);

      // The format-on-save participant is live: a save that is not ERD Studio's formats.
      h.document._setText(after);
      await h.document.save();
      expect(fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8')).toBe(formatWrittenDbml(after, 'gold/diagrams/sales.dbml'));
    } finally {
      for (const d of subscriptions) d.dispose();
    }
  });

  it('a note moved in the same drag, and a note resized, are layout-only too', async () => {
    const h = await open();
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_date: { x: 60, y: 380 } }, annotations: [{ id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', x: 1200, y: 80 }] } });
    await h.panel._simulateMessage({ type: 'updateAnnotation', payload: { id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', width: 300, height: 160 } });
    expect(h.errors()).toEqual([]);
    expect(h.events.map((e) => e.layoutOnly)).toEqual([true, true]);
    expect(_appliedEdits.every((e) => pathsOf(e).join() === 'gold/diagrams/sales.dbml')).toBe(true);
    const layout = layoutEntry(fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8'));
    expect(layout).toContain('    dim_date 60 380\n');
    expect(layout).toContain('    note/3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c 1200 80 300 160\n');
  });

  it('a note text change is not layout-only: the .dbml is written and the trees are told', async () => {
    const h = await open();
    await h.panel._simulateMessage({ type: 'updateAnnotation', payload: { id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', text: 'Grain agreed' } });
    expect(h.errors()).toEqual([]);
    expect(h.events).toHaveLength(1);
    expect(h.events[0].layoutOnly).toBeUndefined();
    expect(fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8')).toContain("'Grain agreed'");
  });

  it('a drop where the table already was writes nothing: no edit, no save, no undo step', async () => {
    const h = await open();
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 400, y: 200 } } } });
    // A sub-pixel move that rounds to the same erd_layout line is no edit either.
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 400.001, y: 200 } } } });
    expect(h.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(0);
    expect(h.events).toEqual([]);
  });

  it('a git conflict in erd_layout refuses the drag with the §1.6 text, and writes nothing', async () => {
    const conflicted = fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8')
      .replace('    fct_order 400 200\n', '<<<<<<< HEAD\n    fct_order 400 200\n=======\n    fct_order 500 200\n>>>>>>> theirs\n');
    fs.writeFileSync(at('gold/diagrams/sales.dbml'), conflicted);
    const h = await open();
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_date: { x: 1, y: 2 } } } });
    expect(h.errors().join(' ')).toContain('gold/diagrams/sales.dbml has a merge conflict in erd_layout (line 12). Only positions differ: keep either side, then try again. Positions are not saved until then.');
    expect(_appliedEdits).toHaveLength(0);
    expect(fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8')).toBe(conflicted);
  });

  it('the next drag, and the next open, read the diagram without compiling it (the drag\'s reading is remembered)', async () => {
    const h = await open();
    await h.panel._simulateMessage({ type: 'ready' });
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    const core = await import('@erd-studio/core/dbml');
    const compiles = vi.spyOn(core, 'parseSubjectAreaDbml');
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 430, y: 230 } } } });
    h.panel._postedMessages.length = 0;
    await h.panel._simulateMessage({ type: 'ready' });
    expect(compiles).not.toHaveBeenCalled();
    const loaded = h.panel._postedMessages.find((m) => (m as { type: string }).type === 'domainLoaded') as { payload: { viewConfig: { positions: Record<string, unknown> } } };
    expect(loaded.payload.viewConfig.positions.fct_order).toEqual({ x: 430, y: 230 });
    expect(h.errors()).toEqual([]);
  });
});

describe('undo and redo of a drag', () => {
  async function dragged() {
    const h = await open();
    const original = fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8');
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    const moved = fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8');
    expect(moved).not.toBe(original);
    h.events.length = 0;
    h.panel._postedMessages.length = 0;
    return { h, original, moved };
  }
  const sends = (h: Harness): number => h.panel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded').length;

  it('Cmd+Z rewinds the diagram\'s own edit and is layout-only: saved, one send, no library invalidation, no tree refresh', async () => {
    const { h, original } = await dragged();
    const invalidateIndex = vi.spyOn(h.tables, 'invalidateIndex');
    const invalidatePaths = vi.spyOn(h.tables, 'invalidatePaths');
    h.document._setText(original);
    await _fireDidChangeTextDocument(h.document, TextDocumentChangeReason.Undo);
    await vi.waitFor(() => expect(h.events).toHaveLength(1), { timeout: 2000, interval: 10 });
    expect(h.events).toEqual([{ uri: h.document.uri, modelLibraryChanged: false, layoutOnly: true }]);
    expect(fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8')).toBe(original);
    expect(h.document.isDirty).toBe(false);
    expect(invalidateIndex).not.toHaveBeenCalled();
    expect(invalidatePaths).not.toHaveBeenCalled();
    expect(sends(h)).toBe(1);
    // The save's dirty-state change event (no content change) sends nothing again.
    await _fireDidChangeTextDocument(h.document, undefined, []);
    expect(sends(h)).toBe(1);
    expect(h.errors()).toEqual([]);
  });

  it('the toolbar\'s Undo is the same layout-only flush, by itself', async () => {
    const { h, original } = await dragged();
    const invalidateIndex = vi.spyOn(h.tables, 'invalidateIndex');
    const undo = vscode.commands.registerCommand('undo', async () => {
      h.document._setText(original);
      await _fireDidChangeTextDocument(h.document, TextDocumentChangeReason.Undo);
    });
    try {
      await h.panel._simulateMessage({ type: 'undo' });
    } finally {
      undo.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8')).toBe(original);
    expect(h.events).toEqual([{ uri: h.document.uri, modelLibraryChanged: false, layoutOnly: true }]);
    expect(invalidateIndex).not.toHaveBeenCalled();
    expect(sends(h)).toBe(1);
  });

  it('an undo that changes more than erd_layout refreshes the library as before', async () => {
    const { h, original } = await dragged();
    const invalidateIndex = vi.spyOn(h.tables, 'invalidateIndex');
    h.document._setText(original.replace("Note: 'Sales star schema'", "Note: 'Edited'"));
    await _fireDidChangeTextDocument(h.document, TextDocumentChangeReason.Undo);
    await vi.waitFor(() => expect(invalidateIndex).toHaveBeenCalled(), { timeout: 2000, interval: 10 });
    expect(h.events).toEqual([{ uri: h.document.uri, modelLibraryChanged: true }]);
  });

  it('an anchor-only undo that took away a file this canvas created still refreshes the library', async () => {
    const h = await open();
    // A table this canvas created, which the undo of its create deleted (no text event).
    const created = at('gold/tables/gold/dim_new.dbml');
    (h.provider as unknown as { editedTablePaths: Map<string, Set<string>> }).editedTablePaths
      .set(h.document.uri.toString(), new Set([created]));
    const invalidateIndex = vi.spyOn(h.tables, 'invalidateIndex');
    h.document._setText(h.document.getText());
    await _fireDidChangeTextDocument(h.document, TextDocumentChangeReason.Undo);
    await vi.waitFor(() => expect(invalidateIndex).toHaveBeenCalled());
    expect(h.events).toEqual([{ uri: h.document.uri, modelLibraryChanged: true }]);
  });

  it('an anchor-only undo with nothing rewound (VS Code split a refused step) saves and refreshes nothing', async () => {
    const { h, moved } = await dragged();
    const invalidateIndex = vi.spyOn(h.tables, 'invalidateIndex');
    h.document._setText(h.document.getText());
    await _fireDidChangeTextDocument(h.document, TextDocumentChangeReason.Undo);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8')).toBe(moved);
    expect(h.document.isDirty).toBe(false);
    expect(invalidateIndex).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(sends(h)).toBe(0);
  });
});

describe('a Cmd+Z that arrives while the canvas is still flushing the last one', () => {
  /**
   * Live at 1,100 tables: two Cmd+Z 78 ms apart after moves. The second
   * undo's events reached the listener while the first one's flush held
   * `pendingUpdates` (it had saved, and was redrawing): they were dropped,
   * so nothing saved the rewound diagram.
   */
  it('is flushed after it, so the diagram is not left dirty and holds the second rewind', async () => {
    const h = await open();
    const original = fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8');
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    const first = fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8');
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 520, y: 320 } } } });
    expect(first).not.toBe(original);
    const nativeUndo = async (text: string): Promise<void> => {
      h.document._setText(text);
      await _fireDidChangeTextDocument(h.document, TextDocumentChangeReason.Undo);
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
      expect(h.document.isDirty).toBe(false);
      expect(fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8')).toBe(original);
    }, { timeout: 2000, interval: 10 });
    expect(spy.mock.calls.length).toBe(2);
    expect(h.errors()).toEqual([]);
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
    // A JSON diagram is still replaced whole (full range), as every caller but the DBML drag.
    const op = opsOf(_appliedEdits[0])[0] as { range: { start: unknown; end: unknown }; newText: string };
    expect(h.document.offsetAt(op.range.start as never)).toBe(0);
    expect(op.newText).toBe(fs.readFileSync(at('gold/plain.json'), 'utf-8'));
    expect(JSON.parse(fs.readFileSync(at('gold/plain.json'), 'utf-8')).viewConfig.positions.fct_order).toEqual({ x: 90, y: 30 });
    expect(planTableWrites).not.toHaveBeenCalled();
    expect(h.events).toEqual([{ uri: h.document.uri, modelLibraryChanged: false, layoutOnly: true }]);
  });
});

describe('applyFileWrites', () => {
  it('leaves out a replace whose text the file already holds (no edit, no save)', async () => {
    const primary = createMockTextDocument(at('gold/diagrams/sales.dbml'), fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8'), { persist: true });
    const same = fs.readFileSync(at('silver/tables/calendar/dim_date.dbml'), 'utf-8');
    const staging = fs.readFileSync(at('silver/diagrams/staging.dbml'), 'utf-8');
    const applied = await applyFileWrites(
      [{ kind: 'replace', path: at('silver/tables/calendar/dim_date.dbml'), text: same }, { kind: 'replace', path: at('silver/diagrams/staging.dbml'), text: `${staging}// y\n` }],
      { primary: { document: primary as unknown as vscode.TextDocument, text: `${primary.getText()}// x\n` } },
    );
    expect(applied.ok).toBe(true);
    expect(applied.replaced.map((u) => relOf(u.fsPath))).toEqual(['silver/diagrams/staging.dbml']);
    expect(pathsOf(_appliedEdits[0])).toEqual(['gold/diagrams/sales.dbml', 'silver/diagrams/staging.dbml']);
    // A changed primary is still replaced whole.
    const full = opsOf(_appliedEdits[0])[0] as { newText: string; range: { start: unknown } };
    expect(full.newText.endsWith('// x\n')).toBe(true);
    expect(primary.offsetAt(full.range.start as never)).toBe(0);
  });

  it('minimalPrimary replaces only the primary\'s changed range; the document ends up with the new text', async () => {
    const text = fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8');
    const primary = createMockTextDocument(at('gold/diagrams/sales.dbml'), text, { persist: true });
    const next = text.replace('    fct_order 400 200\n', '    fct_order 401 200\n');
    const applied = await applyFileWrites([], { primary: { document: primary as unknown as vscode.TextDocument, text: next }, minimalPrimary: true });
    expect(applied.ok).toBe(true);
    const op = opsOf(_appliedEdits[0])[0] as { newText: string; range: { start: unknown; end: unknown } };
    expect(op.newText).toBe('1');
    expect(primary.getText()).toBe(next);
  });

  it('minimalReplace never splits a CRLF or a surrogate pair', () => {
    const crlf = createMockTextDocument(at('gold/crlf.dbml'), 'a\r\nb');
    const change = minimalReplace(crlf as unknown as vscode.TextDocument, 'a\nb');
    const start = crlf.offsetAt(change.range.start as never);
    const end = crlf.offsetAt(change.range.end as never);
    expect('a\r\nb'.slice(0, start) + change.text + 'a\r\nb'.slice(end)).toBe('a\nb');
    expect(start).toBeLessThanOrEqual(1);
    const emoji = createMockTextDocument(at('gold/emoji.dbml'), 'x\u{1F600}y');
    const swap = minimalReplace(emoji as unknown as vscode.TextDocument, 'x\u{1F601}y');
    const s0 = emoji.offsetAt(swap.range.start as never);
    const s1 = emoji.offsetAt(swap.range.end as never);
    expect(s0).toBe(1);
    expect(s1).toBe(3);
    expect(swap.text).toBe('\u{1F601}');
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
    const layout = layoutEntry(fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8'));
    expect(layout).toContain('    fct_order 401 201\n');
    expect(layout).toContain('    dim_date 55 375\n');
    expect(layout).toContain('    dim_region 700 50\n');
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
    expect(layoutEntry(fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8'))).toContain('    dim_date 55 375\n');
  });
});

describe('own-write echo after a busy host (watchers)', () => {
  const semanticWatcher = () => _mockFileWatchers.find((w) => JSON.stringify(w._pattern ?? '').includes('{json,dbml}'))!;
  const tableWatcher = () => _mockFileWatchers.find((w) => JSON.stringify(w._pattern ?? '').includes('/tables/*/*.dbml'))!;

  it('a drag\'s .dbml save (its only write) is ours even when the watcher callback runs 12 s later', async () => {
    const tracker = new OwnWriteTracker();
    const h = await open('gold/diagrams/sales.dbml', tracker);
    await h.panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    expect(h.errors()).toEqual([]);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const watcher = new FileWatcherService(root, '.erd-studio', undefined, tracker, { dbt: false });
    const changed = vi.fn();
    watcher.onSemanticFileChanged(changed);
    try {
      semanticWatcher()._simulateChange(vscode.Uri.file(at('gold/diagrams/sales.dbml')));
      // The host was blocked: the debounced callbacks run long after the 5 s the old tracker allowed.
      vi.setSystemTime(Date.now() + 12_000);
      vi.advanceTimersByTime(300);
      expect(changed).not.toHaveBeenCalled();

      // A real change made afterwards is still reported.
      vi.advanceTimersByTime(5_000);
      fs.appendFileSync(at('gold/diagrams/sales.dbml'), '\n');
      semanticWatcher()._simulateChange(vscode.Uri.file(at('gold/diagrams/sales.dbml')));
      vi.advanceTimersByTime(300);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(Object.keys(changed.mock.calls[0][0])).toEqual(['uri']);
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
      const file = at('gold/tables/gold/fct_order.dbml');
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
      const file = at('gold/diagrams/sales.dbml');
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
