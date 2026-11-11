// @vitest-environment jsdom
/**
 * The toolbar search's hint: a search that finds no table on this diagram
 * but some in the project says "Not on this diagram — N in the project", and
 * clicking it posts `goToTable` with the search (Go to Table… opens with it
 * typed in). No hint while the search finds a table here, on the physical
 * stage, or when nothing in the project matches.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
}));

vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useReactFlow: () => ({ zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: vi.fn(), getNode: vi.fn() }),
  useStore: () => 1,
  useNodesInitialized: () => true,
}));

vi.mock('../../webview/components/Toolbar/StageTabs', () => ({
  StageTabs: () => <div data-testid="stage-tabs" />,
}));

const noop = vi.fn();
const mockStoreState: Record<string, unknown> = {
  setDomain: vi.fn(),
  setNewModelDialogOpen: noop,
  setNewFkDialogOpen: noop,
  setAddExistingModelDialogOpen: noop,
  searchQuery: '',
  setSearchQuery: noop,
  selectNode: noop,
  setDetailPanelOpen: noop,
  registerSearchFocus: noop,
  registerAutoLayout: noop,
  pendingAutoLayout: false,
  setPendingAutoLayout: noop,
  discrepancyVisible: false,
  discrepancyCompareStage: null,
  setDiscrepancyVisible: noop,
  setDiscrepancyCompareStage: noop,
  setToastMessage: vi.fn(),
  setFeedbackDialogOpen: vi.fn(),
  logicalOnly: false,
};

vi.mock('../../webview/store/editorStore', () => ({
  useEditorStore: (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

import { Toolbar } from '../../webview/components/Toolbar/Toolbar';
import type { TableFlowNode } from '@erd-studio/renderer/editor';

const library = (name: string) => ({ name, schema: '', description: '', columnCount: 0, source: 'logical', sourcePath: '' });
const node = (id: string): TableFlowNode =>
  ({ id, type: 'model', position: { x: 0, y: 0 }, data: { modelName: id, stage: 'logical', layer: 'gold', columns: [] } }) as unknown as TableFlowNode;

function renderToolbar(search: string, stage: 'logical' | 'physical' = 'logical') {
  mockStoreState.searchQuery = search;
  mockStoreState.domain = {
    domain: 'sales',
    layer: 'gold',
    stage,
    models: [{ name: 'fct_order', columns: [] }],
    relationships: [],
    viewConfig: { positions: {}, layoutOptions: {} },
    readOnly: stage === 'physical',
    existingModels: [library('dim_customer'), library('dim_region'), library('fct_return')],
  };
  return render(<Toolbar nodes={[node('fct_order')]} edges={[]} />);
}

afterEach(() => {
  cleanup();
  mockPostMessage.mockClear();
});

describe('the toolbar search\'s "Not on this diagram" hint', () => {
  it('counts the project\'s matches and opens Go to Table with the search', () => {
    renderToolbar(' dim ');
    const hint = screen.getByRole('button', { name: 'Not on this diagram — 2 in the project' });
    fireEvent.click(hint);
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'goToTable', payload: { query: 'dim' } });
  });

  it('is not shown while a table here matches, or nothing in the project does', () => {
    renderToolbar('fct');
    expect(screen.queryByText(/Not on this diagram/)).toBeNull();
    cleanup();
    renderToolbar('zzz');
    expect(screen.queryByText(/Not on this diagram/)).toBeNull();
  });

  it('is not shown on the physical stage', () => {
    renderToolbar('dim', 'physical');
    expect(screen.queryByText(/Not on this diagram/)).toBeNull();
  });
});
