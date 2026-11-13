// @vitest-environment jsdom
/**
 * Dropping tables on the canvas, webview side (`useLibraryDrop`,
 * `LibraryDropOverlay`, wired in App.tsx): the host's `libraryDragStarted`
 * shows "Drop to add … to this diagram" until the drop, a
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
  FRAME_SAMPLE_MIN_PX,
  frameOfPointers,
  pageMetrics,
  releaseInPage,
  sameFrame,
  snapScale,
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
const HINT = 'Drop to add dim_customer to this diagram';
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
    expect(libraryDragHintText(['a', 'b', 'c'])).toBe('Drop to add 3 tables to this diagram');
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
    expect(screen.queryByText(/^Drop to add/)).toBeNull();
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

describe('placing a glass sidebar release on the canvas (frameOfPointers, releaseInPage)', () => {
  const metrics = { windowX: 40, windowY: 40, width: 1000, height: 700, pixelRatio: 2 };
  /** A pointer event at page point (x, y) of a page whose corner is at (ox, oy) on screen, at `scale` screen px per page px. */
  const at = (x: number, y: number, ox: number, oy: number, scale = 1) => ({ clientX: x, clientY: y, screenX: ox + x * scale, screenY: oy + y * scale });

  it('measures the page\'s scale and place on screen from two pointer events far enough apart (VS Code\'s zoom included)', () => {
    expect(frameOfPointers(at(100, 100, 433, 170), at(130, 104, 433, 170), metrics)).toEqual({ originX: 433, originY: 170, scale: 1, ...metrics });
    // Zoom level 1: screen px are 1.2 page px (measured in VS Code 1.145: screenX - clientX grows with clientX).
    const zoomed = frameOfPointers(at(168.5, 125.5, 294.5, 22.5, 1.2), at(252.7, 188.2, 294.5, 22.5, 1.2), metrics)!;
    expect(zoomed.scale).toBe(snapScale(1.2));
    expect(zoomed.originX).toBeCloseTo(294.5, 6);
    expect(zoomed.originY).toBeCloseTo(22.5, 6);
    // Too close together, or the axes disagree: nothing.
    expect(frameOfPointers(at(100, 100, 0, 0), at(100 + FRAME_SAMPLE_MIN_PX - 1, 102, 0, 0), metrics)).toBeNull();
    expect(frameOfPointers({ ...at(100, 100, 0, 0), screenY: 100 }, { ...at(150, 150, 0, 0), screenY: 200 }, metrics)).toBeNull();
    expect(frameOfPointers(at(100, 100, 0, 0), { ...at(150, 100, 0, 0), screenX: Number.NaN }, metrics)).toBeNull();
    expect(snapScale(1.2004)).toBe(1.2 ** 1);
    expect(snapScale(1.1)).toBe(1.1);
    const f = frameOfPointers(at(100, 100, 433, 170), at(130, 104, 433, 170), metrics)!;
    expect(sameFrame(f, { ...f, originX: f.originX + 0.2 })).toBe(true);
    expect(sameFrame(f, { ...f, originX: f.originX + 1 })).toBe(false);
    expect(sameFrame(null, null)).toBe(true);
  });

  // The glass page at (48, 68) on screen saw its last pointer at page (30, 40); the drag was let go at its page point (x, y).
  const release = (x: number, y: number, scale = 1, extra: Record<string, number> = {}) =>
    ({ x, y, refX: 30, refY: 40, refScreenX: 48 + 30 * scale, refScreenY: 68 + 40 * scale, windowX: 40, windowY: 40, ...extra });

  it('maps the release through the page\'s own frame, else the given one, only while every measure still matches', () => {
    // The canvas page sits at (433, 170) on screen: a release at glass page (520, 449) is canvas page (135, 347).
    const own = { originX: 433, originY: 170, scale: 1, ...metrics };
    expect(releaseInPage(release(520, 449), metrics, own)).toEqual({ x: 135, y: 347 });
    const given = { ...own, originX: 413 };
    expect(releaseInPage(release(520, 449), metrics, null, given)).toEqual({ x: 155, y: 347 });
    expect(releaseInPage(release(520, 449), metrics, own, given)).toEqual({ x: 135, y: 347 });
    // Zoomed: both pages at 1.2 screen px per page px.
    const zoomed = { ...own, scale: 1.2 };
    const p = releaseInPage(release(520, 449, 1.2), metrics, zoomed)!;
    expect(p.x).toBeCloseTo((48 + 520 * 1.2 - 433) / 1.2, 6);
    expect(p.y).toBeCloseTo((68 + 449 * 1.2 - 170) / 1.2, 6);
    // A window move, a resize, a zoom since: unknown. A release from another window: never.
    for (const changed of [{ windowX: 41 }, { windowY: 0 }, { width: 999 }, { height: 701 }, { pixelRatio: 1 }]) {
      expect(releaseInPage(release(520, 449, 1, changed.windowX !== undefined || changed.windowY !== undefined ? changed : {}), { ...metrics, ...changed }, own, given)).toBeNull();
    }
    expect(releaseInPage(release(520, 449, 1, { windowX: 900 }), metrics, own)).toBeNull();
    expect(releaseInPage(release(520, 449), metrics, null)).toBeNull();
    expect(releaseInPage(release(520, 449), metrics, null, { originX: 1 })).toBeNull();
    expect(releaseInPage({ ...release(520, 449), x: Number.NaN }, metrics, own)).toBeNull();
    expect(releaseInPage({ x: 1, y: 2 }, metrics, own)).toBeNull();
  });
});

describe('a glass sidebar drag let go over the canvas (libraryDragReleased): the drop lands without a pointer move', () => {
  /** A pointer move over `target` at page point `client`, with the screen point a real one carries (the page at (1000, 500) on screen). */
  function pointerAt2(target: Element, client: { x: number; y: number }, origin = { x: 1000, y: 500 }) {
    act(() => { target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: client.x, clientY: client.y, screenX: origin.x + client.x, screenY: origin.y + client.y })); });
  }
  const frames = () => sent().filter((m) => m.type === 'canvasFrame');
  /** The release of a glass page whose last pointer event was at screen (sx, sy), let go at screen point (x, y). */
  const releaseAtScreen = (x: number, y: number, frame?: unknown) => ({
    x: 20 + (x - 100), y: 30 + (y - 100), refX: 20, refY: 30, refScreenX: 100, refScreenY: 100,
    windowX: window.screenX, windowY: window.screenY, ...(frame ? { frame } : {}),
  });
  let restore: (() => void) | undefined;
  /** What is under a page point: the pane, unless `under` says otherwise. */
  function underPoint(under: (x: number, y: number) => Element | null) {
    restore?.();
    const had = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', { value: under, configurable: true });
    restore = () => { if (had) Object.defineProperty(document, 'elementFromPoint', had); else delete (document as { elementFromPoint?: unknown }).elementFromPoint; };
  }
  afterEach(() => { restore?.(); restore = undefined; });

  function setUpCanvas(stage: 'logical' | 'physical' = 'logical') {
    const view = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea(stage) });
    const pane = (view.container.querySelector('.react-flow__pane') ?? view.container.querySelector('.react-flow'))!;
    underPoint(() => pane);
    return { ...view, pane };
  }

  it('learns where it sits from two of its pointer events (reported once per change), and drops at the release point at once', () => {
    const { pane } = setUpCanvas();
    pointerAt2(pane, { x: 300, y: 200 });
    expect(frames()).toEqual([]);
    pointerAt2(pane, { x: 302, y: 201 });
    pointerAt2(pane, { x: 320, y: 205 });
    pointerAt2(pane, { x: 340, y: 215 });
    expect(frames()).toEqual([{ type: 'canvasFrame', payload: { originX: 1000, originY: 500, scale: 1, ...pageMetrics() } }]);
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    postFromHost({ type: 'libraryDragReleased', payload: releaseAtScreen(1400, 800) });
    expect(drops()).toEqual([{ type: 'dropTables', payload: { position: { x: 400, y: 300 }, uris: [], fromLibrary: true, afterDrag: true } }]);
    expect(screen.queryByText(HINT)).toBeNull();
    // Done: the pointer's next move, or another release, posts nothing more.
    pointerAt2(pane, { x: 402, y: 301 });
    postFromHost({ type: 'libraryDragReleased', payload: releaseAtScreen(1400, 800) });
    expect(drops()).toHaveLength(1);
  });

  it('with no frame of its own, uses the one its editor group reported (the host passes it) while every measure matches', () => {
    setUpCanvas();
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    const frame = { originX: 1000, originY: 500, scale: 1, ...pageMetrics() };
    postFromHost({ type: 'libraryDragReleased', payload: releaseAtScreen(1400, 800, { ...frame, width: 1 }) });
    expect(drops()).toEqual([]);
    postFromHost({ type: 'libraryDragReleased', payload: releaseAtScreen(1400, 800, frame) });
    expect(drops()).toEqual([{ type: 'dropTables', payload: { position: { x: 400, y: 300 }, uris: [], fromLibrary: true, afterDrag: true } }]);
  });

  it('ignores a release it cannot place or that is not on its diagram, and the pointer path still finishes the drag', () => {
    const { pane, container } = setUpCanvas();
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    // No frame yet.
    postFromHost({ type: 'libraryDragReleased', payload: releaseAtScreen(1400, 800) });
    expect(drops()).toEqual([]);
    expect(screen.getByText(HINT)).toBeTruthy();
    pointerAt2(pane, { x: 400, y: 300 });
    // That first pointer move finished it the old way.
    expect(drops()).toHaveLength(1);
    pointerAt2(pane, { x: 450, y: 320 });

    mockVsCode.postMessage.mockClear();
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    // Near the edge (the tab bar, the sidebar beside it), outside the page, from another window, or over a toolbar: not here.
    postFromHost({ type: 'libraryDragReleased', payload: releaseAtScreen(1005, 800) });
    postFromHost({ type: 'libraryDragReleased', payload: releaseAtScreen(900, 450) });
    postFromHost({ type: 'libraryDragReleased', payload: { ...releaseAtScreen(1400, 800), windowX: window.screenX + 500 } });
    underPoint(() => container.querySelector('.editor-canvas')?.parentElement ?? document.body);
    postFromHost({ type: 'libraryDragReleased', payload: releaseAtScreen(1400, 800) });
    expect(drops()).toEqual([]);
    expect(screen.getByText(HINT)).toBeTruthy();
  });

  it('a release with no drag announced, or after the drag was used up, does nothing', () => {
    const { pane } = setUpCanvas();
    pointerAt2(pane, { x: 300, y: 200 });
    pointerAt2(pane, { x: 340, y: 215 });
    postFromHost({ type: 'libraryDragReleased', payload: releaseAtScreen(1400, 800) });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    postFromHost({ type: 'libraryDragEnded' });
    postFromHost({ type: 'libraryDragReleased', payload: releaseAtScreen(1400, 800) });
    expect(drops()).toEqual([]);
  });

  it('on the physical stage it says why instead of posting', () => {
    const { pane } = setUpCanvas('physical');
    pointerAt2(pane, { x: 300, y: 200 });
    pointerAt2(pane, { x: 340, y: 215 });
    postFromHost({ type: 'libraryDragStarted', payload: { tables: ['dim_customer'] } });
    postFromHost({ type: 'libraryDragReleased', payload: releaseAtScreen(1400, 800) });
    expect(drops()).toEqual([]);
    expect(screen.getByText(DROP_REFUSED_READ_ONLY)).toBeTruthy();
  });
});

describe('after a drop on the canvas the view stays as it was', () => {
  it('the hook says it posted a drop, so the canvas turns React Flow\'s first-open fit off (a diagram that opened empty still has it queued)', () => {
    useEditorStore.setState({ domain: subjectArea('logical') });
    const wrapper = ({ children }: { children: React.ReactNode }) => <ReactFlowProvider>{children}</ReactFlowProvider>;
    const { result } = renderHook(() => useLibraryDrop(), { wrapper });
    expect(result.current.dropPosted).toBe(false);
    act(() => result.current.libraryDragStarted(['dim_customer']));
    act(() => result.current.dropHandlers!.onDrop({ dataTransfer: transfer({}), clientX: 10, clientY: 20, preventDefault: () => undefined } as unknown as React.DragEvent));
    expect(drops()).toHaveLength(1);
    expect(result.current.dropPosted).toBe(true);
  });

  it('the host\'s selectTables is taken as names to select (useSelectTables), never as a reveal; junk is ignored', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'selectTables', payload: { modelNames: ['dim_customer', 42, '', 'dim_region'] } });
    expect(useEditorStore.getState().pendingTableSelection).toEqual(['dim_customer', 'dim_region']);
    expect(useEditorStore.getState().pendingTableReveal).toBeNull();
    act(() => useEditorStore.getState().setPendingTableSelection(null));
    postFromHost({ type: 'selectTables', payload: { modelNames: 'dim_customer' } });
    postFromHost({ type: 'selectTables' });
    expect(useEditorStore.getState().pendingTableSelection).toBeNull();
  });
});
