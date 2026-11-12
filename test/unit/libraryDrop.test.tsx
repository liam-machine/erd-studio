// @vitest-environment jsdom
/**
 * Dropping tables on the canvas, webview side (`useLibraryDrop`,
 * `LibraryDropOverlay`, wired in App.tsx): the host's `libraryDragStarted`
 * shows "Hold Shift and drop to add … to this diagram" until the drop, a
 * pointer move, the diagram changing or {@link LIBRARY_DRAG_HINT_MS}, and
 * "Let go to add …" while an acceptable drag is over the canvas (Shift
 * pressed early or late); an acceptable drag over an
 * editable logical diagram is highlighted and its drop posts `dropTables`
 * with the flow position and the DataTransfer's URIs. Nothing of it on the
 * physical stage or in the viewer. The host side is `test/unit/dropTables.test.ts`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { CanvasEnvironmentProvider } from '@erd-studio/renderer/editor';

const mockVsCode = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
}));

vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => mockVsCode,
  getVsCodeApi: () => mockVsCode,
}));

import { App } from '../../webview/App';
import { useEditorStore } from '../../webview/store/editorStore';
import {
  AFTER_DRAG_EDGE_PX,
  DROP_REFUSED_READ_ONLY,
  LIBRARY_DRAG_HINT_MS,
  dragEndedOverCanvas,
  dropEffectFor,
  acceptsDrop,
  droppedUris,
  isLibraryDrag,
  libraryDragHintText,
  useLibraryDrop,
} from '../../webview/hooks/useLibraryDrop';
import { DROP_TABLES_URI_LIMIT, DROP_TABLES_URI_MAX_LENGTH } from '../../src/types/messages';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const subjectArea = (stage: 'logical' | 'physical'): DisplaySubjectArea => ({
  schemaVersion: 7, domain: 'sales', layer: 'gold', stage, description: '',
  models: [], relationships: [], viewConfig: {}, readOnly: stage === 'physical', positionDraggable: stage === 'logical',
} as unknown as DisplaySubjectArea);

function postFromHost(data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

/** A DataTransfer as a drop over the canvas sees it. */
function transfer(data: Record<string, string>) {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? data[type.toLowerCase()] ?? '',
    dropEffect: 'none',
  };
}

const sent = () => mockVsCode.postMessage.mock.calls.map((c) => c[0] as { type: string; payload?: unknown });
const drops = () => sent().filter((m) => m.type === 'dropTables');
const canvas = (container: HTMLElement) => container.querySelector('.editor-canvas') as HTMLElement;
const HINT = 'Hold Shift and drop to add dim_customer to this diagram. Keep Shift down until you let go.';
const LET_GO = 'Let go to add dim_customer to this diagram';

beforeAll(() => {
  // React Flow measures its container; jsdom has no ResizeObserver.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  // jsdom has no DragEvent: one with a pointer position, as a browser's.
  if (typeof (window as { DragEvent?: unknown }).DragEvent === 'undefined') {
    (window as unknown as { DragEvent: typeof MouseEvent }).DragEvent = class DragEvent extends MouseEvent {};
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState(initialStoreState, true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('droppedUris', () => {
  it('reads text/uri-list and the VS Code URI list (lines, comments out), then ResourceURLs, each once', () => {
    expect(droppedUris(transfer({
      'text/uri-list': '# a comment\r\nfile:///p/a.dbml\r\nfile:///p/b.yml\n',
      'application/vnd.code.uri-list': 'file:///p/b.yml\nfile:///p/c.dbml',
      ResourceURLs: JSON.stringify(['file:///p/c.dbml', 'file:///p/d.dbml', 42]),
    }))).toEqual(['file:///p/a.dbml', 'file:///p/b.yml', 'file:///p/c.dbml', 'file:///p/d.dbml']);
  });

  it('reads a JSON URI list too, skips what cannot be read, and keeps to the limits', () => {
    expect(droppedUris(transfer({ 'application/vnd.code.uri-list': '["file:///p/a.dbml"]', ResourceURLs: '{not json' })))
      .toEqual(['file:///p/a.dbml']);
    const throwing = { types: ['text/uri-list'], getData: () => { throw new Error('protected'); } };
    expect(droppedUris(throwing)).toEqual([]);
    expect(droppedUris(null)).toEqual([]);
    const many = Array.from({ length: DROP_TABLES_URI_LIMIT + 3 }, (_, i) => `file:///p/t${i}.dbml`).join('\n');
    expect(droppedUris(transfer({ 'text/uri-list': many }))).toHaveLength(DROP_TABLES_URI_LIMIT);
    expect(droppedUris(transfer({ 'text/uri-list': `file:///${'x'.repeat(DROP_TABLES_URI_MAX_LENGTH)}` }))).toEqual([]);
  });
});

describe('acceptsDrop', () => {
  it('accepts URIs, a VS Code tree drag, or any drag while the Table Library drag is on', () => {
    expect(acceptsDrop(transfer({ 'text/uri-list': 'x' }), false)).toBe(true);
    expect(acceptsDrop({ types: ['resourceurls'], getData: () => '' }, false)).toBe(true);
    expect(acceptsDrop({ types: ['application/vnd.code.tree.erdstudio.modellibrary'], getData: () => '' }, false)).toBe(true);
    expect(acceptsDrop(transfer({ 'text/plain': 'hello' }), false)).toBe(false);
    expect(acceptsDrop(transfer({ 'text/plain': 'hello' }), true)).toBe(true);
    expect(acceptsDrop(null, true)).toBe(false);
  });

  it('knows a Table Library drag by that view\'s own mime type, in any case', () => {
    expect(isLibraryDrag(transfer({ 'application/vnd.code.tree.erdstudio.modellibrary': '' }))).toBe(true);
    expect(isLibraryDrag(transfer({ 'Application/vnd.code.tree.erdStudio.modelLibrary': '' }))).toBe(true);
    expect(isLibraryDrag(transfer({ 'application/vnd.code.tree.workbench.explorer.fileview': '', ResourceURLs: '[]' }))).toBe(false);
    expect(isLibraryDrag(null)).toBe(false);
  });

  it('words the hint for one table or several, and says "Let go" once the drag is over the canvas', () => {
    expect(libraryDragHintText(['dim_customer'])).toBe(HINT);
    expect(libraryDragHintText(['a', 'b', 'c'])).toMatch(/^Hold Shift and drop to add 3 tables to this diagram\. /);
    expect(libraryDragHintText(['dim_customer'], true)).toBe(LET_GO);
    expect(libraryDragHintText(['a', 'b'], true)).toBe('Let go to add 2 tables to this diagram');
  });
});

/** A pointer event at (x, y) on `target`, as the webview's first one after a drag; `movement` as a real mouse reports it. */
function pointerAt(target: Element, type: 'pointermove' | 'pointerdown', x: number, y: number, movement = { x: 0, y: 0 }) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'movementX', { value: movement.x });
  Object.defineProperty(event, 'movementY', { value: movement.y });
  act(() => { target.dispatchEvent(event); });
}

describe('dragEndedOverCanvas', () => {
  const viewport = { width: 1000, height: 700 };
  it('is a pointer well inside the webview, on the diagram, whose last move started inside too: the drag ended there', () => {
    expect(dragEndedOverCanvas({ x: 500, y: 400, movementX: 2, movementY: 1, onDiagram: true }, viewport)).toBe(true);
    // No movement known (a click, or a mouse that does not report it): the point alone.
    expect(dragEndedOverCanvas({ x: 500, y: 400, onDiagram: true }, viewport)).toBe(true);
    expect(dragEndedOverCanvas({ x: AFTER_DRAG_EDGE_PX, y: AFTER_DRAG_EDGE_PX, onDiagram: true }, viewport)).toBe(true);
  });
  it('is not a pointer coming in from outside: near an edge, or its last move started outside', () => {
    expect(dragEndedOverCanvas({ x: AFTER_DRAG_EDGE_PX - 1, y: 400, onDiagram: true }, viewport)).toBe(false);
    expect(dragEndedOverCanvas({ x: 500, y: 10, onDiagram: true }, viewport)).toBe(false);
    expect(dragEndedOverCanvas({ x: 990, y: 400, onDiagram: true }, viewport)).toBe(false);
    expect(dragEndedOverCanvas({ x: 500, y: 690, onDiagram: true }, viewport)).toBe(false);
    // A fast move in from the sidebar lands well inside, but it started outside.
    expect(dragEndedOverCanvas({ x: 60, y: 400, movementX: 70, movementY: 0, onDiagram: true }, viewport)).toBe(false);
  });
  it('is not a pointer over a toolbar, a panel or a dialog, or one that cannot be read', () => {
    expect(dragEndedOverCanvas({ x: 500, y: 400, onDiagram: false }, viewport)).toBe(false);
    expect(dragEndedOverCanvas({ x: Number.NaN, y: 400, onDiagram: true }, viewport)).toBe(false);
  });
});

describe('the canvas as a drop target', () => {
  it('shows the hint when a Table Library drag starts, as a polite live region, and hides it on a pointer move', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    const hint = screen.getByText(HINT);
    expect(hint.closest('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    act(() => { window.dispatchEvent(new Event('pointermove')); });
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('hides the hint, and stops taking the drag, when the host says the drag was used up elsewhere (libraryDragEnded)', () => {
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    expect(screen.getByText(HINT)).toBeTruthy();
    // Dropped on another diagram's row, or missed this canvas and opened the file: no pointer move ever reaches this webview.
    postFromHost({ type: 'libraryDragEnded' });
    expect(screen.queryByText(HINT)).toBeNull();
    // A later drag with nothing the canvas can read is no longer taken as the library drag.
    const dataTransfer = transfer({});
    expect(fireEvent.dragOver(canvas(container), { dataTransfer })).toBe(true);
    expect(screen.queryByText(LET_GO)).toBeNull();
  });

  it('a drag that ended over the canvas with no drop event: the first pointer move there posts it as an afterDrag drop, once', () => {
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    const pane = container.querySelector('.react-flow__pane') ?? container.querySelector('.react-flow');
    expect(pane).toBeTruthy();
    pointerAt(pane!, 'pointermove', 400, 300, { x: 2, y: 1 });
    expect(drops()).toEqual([{
      type: 'dropTables',
      payload: { position: { x: 400, y: 300 }, uris: [], fromLibrary: true, afterDrag: true },
    }]);
    expect(screen.queryByText(HINT)).toBeNull();
    // The drag is over: later moves post nothing.
    pointerAt(pane!, 'pointermove', 420, 310, { x: 20, y: 10 });
    expect(drops()).toHaveLength(1);
  });

  it('a pointer coming in from outside after the drag (at the edge, or moving in) ends the drag without a drop', () => {
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    const pane = container.querySelector('.react-flow__pane') ?? container.querySelector('.react-flow');
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    pointerAt(pane!, 'pointermove', 5, 300, { x: 8, y: 0 });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    pointerAt(pane!, 'pointermove', 80, 300, { x: 90, y: 0 });
    expect(drops()).toEqual([]);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('no afterDrag drop once a real drop, or the host, ended the drag', () => {
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    const pane = container.querySelector('.react-flow__pane') ?? container.querySelector('.react-flow');
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    postFromHost({ type: 'libraryDragEnded' });
    pointerAt(pane!, 'pointermove', 400, 300);
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    fireEvent.drop(canvas(container), { dataTransfer: transfer({}), clientX: 10, clientY: 20 });
    pointerAt(pane!, 'pointerdown', 400, 300);
    expect(drops()).toEqual([{ type: 'dropTables', payload: { position: { x: 10, y: 20 }, uris: [] } }]);
  });

  it('hides the hint after a while', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['a', 'b'] } });
    expect(screen.getByText(libraryDragHintText(['a', 'b']))).toBeTruthy();
    act(() => { vi.advanceTimersByTime(LIBRARY_DRAG_HINT_MS + 1); });
    expect(screen.queryByText(/Hold Shift and drop/)).toBeNull();
  });

  it('highlights an acceptable drag, and its drop posts the flow position and the URIs, and ends the hint', () => {
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    const target = canvas(container);
    const dataTransfer = transfer({ 'text/uri-list': 'file:///p/.erd-studio/gold/tables/gold/dim_customer.dbml' });

    fireEvent.dragEnter(target, { dataTransfer });
    const accepted = fireEvent.dragOver(target, { dataTransfer, clientX: 120, clientY: 80 });
    expect(accepted).toBe(false); // preventDefault: the drop is allowed
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(screen.getByTestId('library-drop-highlight')).toBeTruthy();
    // Over the canvas, the hint says the drop will land.
    expect(screen.getByText(LET_GO)).toBeTruthy();

    fireEvent.drop(target, { dataTransfer, clientX: 120, clientY: 80 });
    expect(drops()).toEqual([{
      type: 'dropTables',
      payload: { position: { x: 120, y: 80 }, uris: ['file:///p/.erd-studio/gold/tables/gold/dim_customer.dbml'] },
    }]);
    expect(screen.queryByTestId('library-drop-highlight')).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('posts a drop with no URIs while the Table Library drag is on (the host knows its tables)', () => {
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    const dataTransfer = transfer({});
    expect(fireEvent.dragOver(canvas(container), { dataTransfer })).toBe(false);
    fireEvent.drop(canvas(container), { dataTransfer, clientX: 10, clientY: 20 });
    expect(drops()).toEqual([{ type: 'dropTables', payload: { position: { x: 10, y: 20 }, uris: [] } }]);
  });

  it('marks a drop that carries the Table Library mime type, as VS Code hands a tree drag to a webview', () => {
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    // What VS Code 1.9x puts on a drag of one table row and one schema row: the
    // declared types blank, the tree's item handles, and the table row's file.
    const dataTransfer = transfer({
      'text/uri-list': '',
      resourceurls: '',
      'application/vnd.code.tree.erdstudio.modellibrary': '{"id":"erdStudio.modelLibrary","itemHandles":["0/0:fct_order","0/1:sales"]}',
      // The names' own type, declared in dragMimeTypes: blank here too (the real names stay in the workbench).
      'application/vnd.erdstudio.tables+json': '',
      'application/vnd.code.uri-list': 'file:///c%3A/proj/.erd-studio/gold/tables/dbo/fct_order.dbml',
      codefiles: '["c:\\\\proj\\\\.erd-studio\\\\gold\\\\tables\\\\dbo\\\\fct_order.dbml"]',
    });
    expect(fireEvent.dragOver(canvas(container), { dataTransfer })).toBe(false);
    fireEvent.drop(canvas(container), { dataTransfer, clientX: 10, clientY: 20 });
    expect(drops()).toEqual([{
      type: 'dropTables',
      payload: { position: { x: 10, y: 20 }, uris: ['file:///c%3A/proj/.erd-studio/gold/tables/dbo/fct_order.dbml'], fromLibrary: true },
    }]);
  });

  // Shift pressed late (after the hint has gone, or with the pointer already over
  // the diagram): VS Code lets the drag reach the webview from its next drag
  // event on, and the canvas takes it exactly as it takes an early-Shift drag.
  it('Shift pressed late: a drag that reaches the canvas after the hint timed out is taken, named, and dropped', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    act(() => { vi.advanceTimersByTime(LIBRARY_DRAG_HINT_MS + 1); });
    expect(screen.queryByText(HINT)).toBeNull();
    // What the webview sees once Shift is down: VS Code's tree types, blank, and the row's file.
    const dataTransfer = transfer({
      'application/vnd.code.tree.erdstudio.modellibrary': '',
      'application/vnd.code.uri-list': 'file:///p/.erd-studio/gold/tables/gold/dim_customer.dbml',
    });
    fireEvent.dragEnter(canvas(container), { dataTransfer });
    expect(fireEvent.dragOver(canvas(container), { dataTransfer, clientX: 5, clientY: 5 })).toBe(false);
    expect(screen.getByText(LET_GO)).toBeTruthy();
    fireEvent.drop(canvas(container), { dataTransfer, clientX: 5, clientY: 5 });
    expect(drops()).toEqual([{
      type: 'dropTables',
      payload: { position: { x: 5, y: 5 }, uris: ['file:///p/.erd-studio/gold/tables/gold/dim_customer.dbml'], fromLibrary: true },
    }]);
    expect(screen.queryByText(LET_GO)).toBeNull();
  });

  it('Shift pressed early: the first event the canvas sees is a dragover (no dragenter), and the drop still lands', () => {
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    const dataTransfer = transfer({ 'application/vnd.code.tree.erdstudio.modellibrary': '' });
    expect(fireEvent.dragOver(canvas(container), { dataTransfer })).toBe(false);
    fireEvent.drop(canvas(container), { dataTransfer, clientX: 1, clientY: 2 });
    expect(drops()).toEqual([{ type: 'dropTables', payload: { position: { x: 1, y: 2 }, uris: [], fromLibrary: true } }]);
  });

  it('the hint goes when the diagram changes under it (the tables were added by a drop on its row)', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    expect(screen.getByText(HINT)).toBeTruthy();
    postFromHost({ type: 'domainLoaded', payload: { ...subjectArea('logical'), description: 'now with dim_customer' } });
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('the hint goes when the host selects a table (a drop on the row found it already there)', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    expect(screen.getByText(HINT)).toBeTruthy();
    postFromHost({ type: 'revealTable', payload: { modelName: 'dim_customer' } });
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('leaves a plain text drag alone, and drops the highlight when the drag leaves', () => {
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    const target = canvas(container);
    expect(fireEvent.dragOver(target, { dataTransfer: transfer({ 'text/plain': 'x' }) })).toBe(true);
    fireEvent.drop(target, { dataTransfer: transfer({ 'text/plain': 'x' }) });
    expect(drops()).toEqual([]);

    const uris = transfer({ 'text/uri-list': 'file:///p/a.dbml' });
    fireEvent.dragEnter(target, { dataTransfer: uris });
    fireEvent.dragOver(target, { dataTransfer: uris });
    expect(screen.getByTestId('library-drop-highlight')).toBeTruthy();
    fireEvent.dragLeave(target, { dataTransfer: uris });
    expect(screen.queryByTestId('library-drop-highlight')).toBeNull();
  });

  it('adds nothing and shows no hint on the physical stage, and says why when tables are dropped there', () => {
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('physical') });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    expect(screen.queryByText(HINT)).toBeNull();
    const dataTransfer = transfer({ 'text/uri-list': 'file:///p/a.dbml' });
    fireEvent.dragOver(canvas(container), { dataTransfer });
    expect(screen.queryByTestId('library-drop-highlight')).toBeNull();
    expect(screen.queryByText(DROP_REFUSED_READ_ONLY)).toBeNull();
    fireEvent.drop(canvas(container), { dataTransfer, clientX: 1, clientY: 1 });
    expect(drops()).toEqual([]);
    expect(screen.getByText(DROP_REFUSED_READ_ONLY)).toBeTruthy();
    expect(screen.queryByTestId('library-drop-highlight')).toBeNull();
  });

  it('says nothing about a drop that carries no table on the physical stage (plain text)', () => {
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('physical') });
    const text = transfer({ 'text/plain': 'hello' });
    expect(fireEvent.dragOver(canvas(container), { dataTransfer: text })).toBe(true);
    fireEvent.drop(canvas(container), { dataTransfer: text, clientX: 1, clientY: 1 });
    expect(screen.queryByText(DROP_REFUSED_READ_ONLY)).toBeNull();
  });
});

describe('useLibraryDrop in the viewer', () => {
  it('offers no drop handlers and no hint', () => {
    useEditorStore.setState({ domain: subjectArea('logical') });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <CanvasEnvironmentProvider viewer>
        <ReactFlowProvider>{children}</ReactFlowProvider>
      </CanvasEnvironmentProvider>
    );
    const { result } = renderHook(() => useLibraryDrop(), { wrapper });
    act(() => result.current.libraryDragStarted(['dim_customer']));
    expect(result.current.dropHandlers).toBeUndefined();
    expect(result.current.hintTables).toBeNull();
    expect(result.current.dropActive).toBe(false);
    expect(mockVsCode.postMessage).not.toHaveBeenCalled();
  });

  it('the same hook outside the viewer offers them on an editable logical diagram', () => {
    useEditorStore.setState({ domain: subjectArea('logical') });
    const wrapper = ({ children }: { children: React.ReactNode }) => <ReactFlowProvider>{children}</ReactFlowProvider>;
    const { result } = renderHook(() => useLibraryDrop(), { wrapper });
    act(() => result.current.libraryDragStarted(['dim_customer']));
    expect(result.current.dropHandlers).toBeDefined();
    expect(result.current.hintTables).toEqual(['dim_customer']);
  });
});

describe('dropEffectFor', () => {
  it('asks for copy unless the drag allows only move or link', () => {
    expect(dropEffectFor(undefined)).toBe('copy');
    expect(dropEffectFor('uninitialized')).toBe('copy');
    expect(dropEffectFor('all')).toBe('copy');
    expect(dropEffectFor('copyMove')).toBe('copy');
    expect(dropEffectFor('move')).toBe('move');
    expect(dropEffectFor('linkMove')).toBe('move');
    expect(dropEffectFor('link')).toBe('link');
  });
});
