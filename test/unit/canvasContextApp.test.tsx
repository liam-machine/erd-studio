// @vitest-environment jsdom
/**
 * The webview keeps the host's `canvasContext` in the editor store while the
 * logical stage shows, and drops it on the physical stage (the host sends
 * none there; a late one for the logical stage is ignored). Also: App hands
 * `domainLoaded`'s first-open layout flags (`autoLayout`, `saveLayout`) to the store.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

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
import type { DisplaySubjectArea } from '../../src/types/display';
import type { CanvasContext } from '../../src/types/messages';

const initialStoreState = useEditorStore.getState();

const subjectArea = (stage: 'logical' | 'physical') => ({
  schemaVersion: 7, domain: 'sales', layer: 'gold', stage, description: '',
  models: [], relationships: [], viewConfig: {}, readOnly: stage === 'physical', positionDraggable: true,
}) as unknown as DisplaySubjectArea;

const CONTEXT: CanvasContext = {
  tableFiles: { fct_sale: '.erd-studio/gold/tables/gold/fct_sale.dbml' },
  offDiagram: { fct_sale: [{ otherTable: 'dim_store', columns: 'store_key', cardinality: 'many-to-one', direction: 'out' }] },
};

function postFromHost(data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState(initialStoreState, true);
});

afterEach(() => cleanup());

describe('canvasContext in the webview', () => {
  it('is stored after a logical payload and kept across the next logical refresh', () => {
    render(<App />);
    expect(useEditorStore.getState().canvasContext).toBeNull();
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'canvasContext', payload: CONTEXT });
    expect(useEditorStore.getState().canvasContext).toEqual(CONTEXT);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    expect(useEditorStore.getState().canvasContext).toEqual(CONTEXT);
  });

  it('is dropped on the physical stage, and a late one is ignored there', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    postFromHost({ type: 'canvasContext', payload: CONTEXT });
    postFromHost({ type: 'stageData', payload: subjectArea('physical') });
    expect(useEditorStore.getState().canvasContext).toBeNull();
    postFromHost({ type: 'canvasContext', payload: CONTEXT });
    expect(useEditorStore.getState().canvasContext).toBeNull();
  });
});

// The host says whether a first-open layout is the user's own (`saveLayout`):
// App hands both flags to the store, whose `pendingAutoLayoutSaves` decides
// whether the layout is posted saved or `unsaved` (firstOpenAutoLayout.test.tsx).
describe('domainLoaded: the first-open layout flags reach the store', () => {
  it('saveLayout makes the pending layout a saved one; without it, the layout is unsaved; a payload with neither cancels it', () => {
    const setPendingAutoLayout = vi.fn();
    render(<App />);
    useEditorStore.setState({ setPendingAutoLayout });
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical'), autoLayout: true, saveLayout: true });
    expect(setPendingAutoLayout).toHaveBeenLastCalledWith(true, true);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical'), autoLayout: true });
    expect(setPendingAutoLayout).toHaveBeenLastCalledWith(true, false);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    expect(setPendingAutoLayout).toHaveBeenLastCalledWith(false, false);
  });

  it('the store keeps saveLayout as pendingAutoLayoutSaves', () => {
    useEditorStore.getState().setPendingAutoLayout(true, true);
    expect(useEditorStore.getState()).toMatchObject({ pendingAutoLayout: true, pendingAutoLayoutSaves: true });
    useEditorStore.getState().setPendingAutoLayout(true, false);
    expect(useEditorStore.getState()).toMatchObject({ pendingAutoLayout: true, pendingAutoLayoutSaves: false });
  });
});
