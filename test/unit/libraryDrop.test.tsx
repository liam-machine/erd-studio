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
  DROP_REFUSED_READ_ONLY,
  LIBRARY_DRAG_HINT_MS,
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
const HINT = 'Hold Shift and drop to add dim_customer to this diagram. Pressed Shift over the diagram? Move the mouse a little, then let go.';
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
