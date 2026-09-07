// @vitest-environment jsdom
/**
 * Toolbar component tests — the layout-dirty button, and the top-right corner.
 *
 * Verifies that:
 *  - The button starts clean (⊞ icon, no dirty class)
 *  - Changing any layout option marks it dirty (↺ icon, dirty class)
 *  - Running the layout clears the dirty flag
 *  - The corner actions stay labelled while they fit, and collapse to one
 *    overflow button only when they would actually overlap the top-centre
 *    toolbar — the collision that used to happen on a narrow window
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';

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
  registerAutoLayout: noop,
  discrepancyVisible: false,
  discrepancyCompareStage: null,
  setDiscrepancyVisible: noop,
  setDiscrepancyCompareStage: noop,
  setToastMessage: vi.fn(),
  setFeedbackDialogOpen: vi.fn(),
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
    fireEvent.click(screen.getByRole('button', { name: '↓' }));
    expect(layoutButton().className).toContain('dirty');
  });

  it('becomes dirty when spacing preset changes', () => {
    render(<Toolbar {...defaultProps} />);
    openOptionsPanel();
    fireEvent.click(screen.getByRole('button', { name: 'L' }));
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
    fireEvent.click(screen.getByRole('button', { name: '↓' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'L' }));
    expect(layoutButton().title).toMatch(/options changed/i);
  });

  it('clean button title describes auto-layout', () => {
    render(<Toolbar {...defaultProps} />);
    expect(layoutButton().title).toMatch(/auto-layout/i);
  });

  it('re-enables the button and raises a toast when layout fails (H28)', async () => {
    mockRunElkLayout.mockRejectedValueOnce(new Error('ELK layout worker crashed: boom'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Toolbar {...defaultProps} />);

    await act(async () => {
      fireEvent.click(layoutButton());
    });

    expect(layoutButton().hasAttribute('disabled')).toBe(false);
    expect(layoutButton().textContent).not.toContain('Running');
    expect(mockStoreState.setToastMessage).toHaveBeenCalledWith(
      'Auto layout failed: ELK layout worker crashed: boom',
    );
    consoleSpy.mockRestore();
  });
});

/**
 * The corner collapses on a measured overlap, not on a breakpoint, because the
 * toolbar's width depends on the domain name, the search box and which
 * stage-specific controls are showing.
 *
 * jsdom gives every element a zero-size rect, so these tests supply the
 * geometry themselves: the toolbar row's right edge, and the corner's right
 * edge and natural width. `layout()` stubs `getBoundingClientRect` per element
 * class, which is what the component actually reads.
 */
describe('the top-right corner actions', () => {
  /** Width of the corner with both labels showing, as a real browser reports it. */
  const EXPANDED_WIDTH = 200;

  /**
   * Pretend the canvas is `cornerRight` px wide with the toolbar's right edge
   * at `toolbarRight`. The corner reports its natural width while it is showing
   * labels and the ~28px trigger once it has collapsed, exactly as layout would.
   */
  function layout({ toolbarRight, cornerRight }: { toolbarRight: number; cornerRight: number }) {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.classList.contains('toolbar--attached-bottom')) {
        return { right: toolbarRight, width: toolbarRight, left: 0 } as DOMRect;
      }
      if (this.classList.contains('toolbar__corner-actions')) {
        const collapsed = this.querySelector('.toolbar__corner-trigger') !== null;
        const width = collapsed ? 28 : EXPANDED_WIDTH;
        return { right: cornerRight, width, left: cornerRight - width } as DOMRect;
      }
      return { right: 0, width: 0, left: 0 } as DOMRect;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const trigger = () => screen.getByRole('button', { name: /more actions/i });

  it('keeps both labelled buttons when they clear the toolbar', () => {
    // 1400px of canvas, a toolbar ending at 900: the corner starts at 1200.
    layout({ toolbarRight: 900, cornerRight: 1400 });
    render(<Toolbar {...defaultProps} />);

    expect(screen.getByRole('button', { name: /send feedback/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /open underlying json file/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /more actions/i })).toBeNull();
  });

  it('collapses once the labelled buttons would run into the toolbar', () => {
    // The same corner on a 1000px canvas would start at 800 — inside a toolbar
    // that ends at 900.
    layout({ toolbarRight: 900, cornerRight: 1000 });
    render(<Toolbar {...defaultProps} />);

    expect(trigger().textContent).toBe('⋯');
    expect(screen.queryByRole('button', { name: /send feedback/i })).toBeNull();
  });

  it('collapses on the gap alone, before anything visibly touches', () => {
    // Corner would start at exactly the toolbar's right edge: no overlap yet,
    // but two separately positioned panels flush against each other read as
    // broken, so CORNER_MIN_GAP claims a little room first.
    layout({ toolbarRight: 900, cornerRight: 1100 });
    render(<Toolbar {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeNull();

    cleanup();
    layout({ toolbarRight: 900, cornerRight: 1116 + 1 });
    render(<Toolbar {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /more actions/i })).toBeNull();
  });

  it('stays expanded where nothing can be measured', () => {
    // Every rect is zero in jsdom with no stub — and in a hidden panel, and
    // before layout. Not knowing is not a reason to hide the labels.
    render(<Toolbar {...defaultProps} />);
    expect(screen.getByRole('button', { name: /send feedback/i })).toBeTruthy();
  });

  it('re-collapses when the window narrows, and expands again when it widens', () => {
    // The comparison keeps using the width measured while the labels were
    // showing, so a collapsed corner can still answer "would the full version
    // fit now?".
    layout({ toolbarRight: 900, cornerRight: 1400 });
    render(<Toolbar {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /more actions/i })).toBeNull();

    layout({ toolbarRight: 900, cornerRight: 1000 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeNull();

    layout({ toolbarRight: 900, cornerRight: 1400 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByRole('button', { name: /send feedback/i })).toBeTruthy();
  });

  it('opens the menu and offers both actions when collapsed', () => {
    layout({ toolbarRight: 900, cornerRight: 1000 });
    render(<Toolbar {...defaultProps} />);

    fireEvent.click(trigger());

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menuitem', { name: /Send feedback/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Open as JSON file/ })).toBeTruthy();
  });

  it('opens the feedback dialog from either form', () => {
    layout({ toolbarRight: 900, cornerRight: 1000 });
    const { unmount } = render(<Toolbar {...defaultProps} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitem', { name: /Send feedback/ }));
    expect(mockStoreState.setFeedbackDialogOpen).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('menu')).toBeNull();
    unmount();

    vi.clearAllMocks();
    layout({ toolbarRight: 900, cornerRight: 1400 });
    render(<Toolbar {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect(mockStoreState.setFeedbackDialogOpen).toHaveBeenCalledWith(true);
  });

  it('closes the menu on a click outside and on Escape', () => {
    layout({ toolbarRight: 900, cornerRight: 1000 });
    render(<Toolbar {...defaultProps} />);

    fireEvent.click(trigger());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('drops an open menu when the window grows enough to expand it', () => {
    // The popup hangs off the trigger; leaving it up once the trigger is gone
    // would strand it in the corner.
    layout({ toolbarRight: 900, cornerRight: 1000 });
    render(<Toolbar {...defaultProps} />);
    fireEvent.click(trigger());
    expect(screen.queryByRole('menu')).not.toBeNull();

    layout({ toolbarRight: 900, cornerRight: 1400 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: /send feedback/i })).toBeTruthy();
  });
});
