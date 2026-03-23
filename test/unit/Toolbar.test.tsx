// @vitest-environment jsdom
/**
 * Toolbar component tests — focused on the layout-dirty button behaviour.
 *
 * Verifies that:
 *  - The button starts clean (⊞ icon, no dirty class)
 *  - Changing any layout option marks it dirty (↺ icon, dirty class)
 *  - Running the layout clears the dirty flag
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that transitively loads them
// ---------------------------------------------------------------------------

// Hoist mockRunElkLayout so it's accessible inside vi.mock factories (which are hoisted)
const mockRunElkLayout = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ model_a: { x: 10, y: 20 } }),
);

// Prevent acquireVsCodeApi() from throwing at module load time
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
  }),
}));

// Minimal React Flow surface used by Toolbar
vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useReactFlow: () => ({
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fitView: vi.fn(),
    getNode: vi.fn(),
  }),
  useStore: () => 1, // zoom level
}));

vi.mock('../../webview/components/Toolbar/StageTabs', () => ({
  StageTabs: () => null,
}));

vi.mock('../../webview/lib/elkLayout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../webview/lib/elkLayout')>();
  return { ...actual, runElkLayout: mockRunElkLayout };
});

// ---------------------------------------------------------------------------
// Minimal store state — selectors are applied to this object
// ---------------------------------------------------------------------------

const noop = vi.fn();

const mockDomain = {
  domain: 'test',
  layer: 'silver',
  stage: 'logical' as const,
  models: [{ name: 'model_a', columns: [], relationships: [] }],
  relationships: [],
  viewConfig: { positions: {}, layoutOptions: {} },
  readOnly: false,
};

const mockStoreState: Record<string, unknown> = {
  domain: mockDomain,
  setDomain: vi.fn(),
  setNewModelDialogOpen: noop,
  setNewFkDialogOpen: noop,
  setAddExistingModelDialogOpen: noop,
  searchQuery: '',
  setSearchQuery: noop,
  selectNode: noop,
  setDetailPanelOpen: noop,
  registerSearchFocus: noop,
  discrepancyVisible: false,
  discrepancyCompareStage: null,
  setDiscrepancyVisible: noop,
  setDiscrepancyCompareStage: noop,
};

vi.mock('../../webview/store/editorStore', () => ({
  useEditorStore: (selector: (s: typeof mockStoreState) => unknown) =>
    selector(mockStoreState),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

import { Toolbar } from '../../webview/components/Toolbar/Toolbar';
import type { ModelFlowNode, FkFlowEdge } from '../../webview/types/graph';

function makeNode(id: string): ModelFlowNode {
  return {
    id,
    type: 'model',
    position: { x: 0, y: 0 },
    data: {
      modelName: id,
      stage: 'logical',
      layer: 'silver',
      columns: [],
    },
  };
}

const defaultProps = {
  nodes: [makeNode('model_a')],
  edges: [] as FkFlowEdge[],
  allExpanded: false,
  onExpandAll: vi.fn(),
  onCollapseAll: vi.fn(),
};

function layoutButton() {
  return screen.getByRole('button', { name: /auto-layout nodes/i });
}

function caretButton() {
  return screen.getByRole('button', { name: /layout settings/i });
}

function openOptionsPanel() {
  fireEvent.click(caretButton());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Toolbar layout-dirty button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunElkLayout.mockResolvedValue({ model_a: { x: 10, y: 20 } });
  });

  it('starts clean — shows ⊞ and no dirty class', () => {
    render(<Toolbar {...defaultProps} />);
    const btn = layoutButton();
    expect(btn.textContent).toContain('⊞');
    expect(btn.className).not.toContain('dirty');
  });

  it('becomes dirty when cluster-by option changes', () => {
    render(<Toolbar {...defaultProps} />);
    openOptionsPanel();
    // "Join depth" is the text of the depth strategy button
    fireEvent.click(screen.getByRole('button', { name: 'Join depth' }));
    const btn = layoutButton();
    expect(btn.textContent).toContain('↺');
    expect(btn.className).toContain('dirty');
  });

  it('becomes dirty when direction changes', () => {
    render(<Toolbar {...defaultProps} />);
    openOptionsPanel();
    fireEvent.click(screen.getByRole('button', { name: '↓ Top to bottom' }));
    expect(layoutButton().className).toContain('dirty');
  });

  it('becomes dirty when spacing preset changes', () => {
    render(<Toolbar {...defaultProps} />);
    openOptionsPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Tight' }));
    expect(layoutButton().className).toContain('dirty');
  });

  it('becomes dirty when tables-per-column changes', () => {
    render(<Toolbar {...defaultProps} />);
    openOptionsPanel();
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '3' } });
    expect(layoutButton().className).toContain('dirty');
  });

  it('clears dirty flag after layout runs successfully', async () => {
    render(<Toolbar {...defaultProps} />);
    openOptionsPanel();
    fireEvent.click(screen.getByRole('button', { name: '↓ Top to bottom' }));
    expect(layoutButton().className).toContain('dirty');

    await act(async () => {
      fireEvent.click(layoutButton());
    });

    expect(layoutButton().textContent).toContain('⊞');
    expect(layoutButton().className).not.toContain('dirty');
  });

  it('dirty button title changes to warn about pending options', () => {
    render(<Toolbar {...defaultProps} />);
    openOptionsPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Tight' }));
    expect(layoutButton().title).toMatch(/options changed/i);
  });

  it('clean button title describes auto-layout', () => {
    render(<Toolbar {...defaultProps} />);
    expect(layoutButton().title).toMatch(/auto-layout/i);
  });
});
