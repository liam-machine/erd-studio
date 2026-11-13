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
 *  - Without a dbt project (`logicalOnly`) the stage tabs, Diff and the
 *    manifest refresh are not rendered
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that transitively loads them
// ---------------------------------------------------------------------------

// Hoist mockRunElkLayout so it's accessible inside vi.mock factories (which are hoisted)
const mockRunElkLayout = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ model_a: { x: 10, y: 20 } }),
);

// Prevent acquireVsCodeApi() from throwing at module load time. One shared
// postMessage so a test can see what the toolbar sent.
const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: vi.fn(),
    setState: vi.fn(),
  }),
}));

// Minimal React Flow surface used by Toolbar. One shared fitView so a test
// can see the padding Fit asked for.
const mockFitView = vi.hoisted(() => vi.fn());
vi.mock('@xyflow/react', () => ({
  Panel: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
  useReactFlow: () => ({
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fitView: mockFitView,
    getNode: vi.fn(),
  }),
  useStore: () => 1, // zoom level
  useNodesInitialized: () => true, // useRevealRelationship
}));

vi.mock('../../webview/components/Toolbar/StageTabs', () => ({
  StageTabs: () => <div data-testid="stage-tabs" />,
}));

vi.mock('../../webview/lib/elkLayout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../webview/lib/elkLayout')>();
  return { ...actual, runElkLayout: mockRunElkLayout };
});

// ---------------------------------------------------------------------------
// Minimal store state — selectors are applied to this object
// ---------------------------------------------------------------------------

const noop = vi.fn();

const mockSubjectArea = {
  domain: 'test',
  layer: 'silver',
  stage: 'logical' as const,
  models: [{ name: 'model_a', columns: [], relationships: [] }],
  relationships: [],
  viewConfig: { positions: {}, layoutOptions: {} },
  readOnly: false,
};

const mockStoreState: Record<string, unknown> = {
  domain: mockSubjectArea,
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
  recordError: vi.fn(),
  setFeedbackDialogOpen: vi.fn(),
  logicalOnly: false,
};

vi.mock('../../webview/store/editorStore', () => ({
  useEditorStore: (selector: (s: typeof mockStoreState) => unknown) =>
    selector(mockStoreState),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

import { Toolbar, NO_TABLES_FOR_RELATIONSHIP, compareButtonWording, layerBoundWording } from '../../webview/components/Toolbar/Toolbar';
import type { TableFlowNode, FkFlowEdge } from '@erd-studio/renderer/editor';

function makeNode(id: string): TableFlowNode {
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

  it('a failed layout reports its class and size buckets, and leaves a fixed line for Send Feedback', async () => {
    mockRunElkLayout.mockRejectedValueOnce(new Error('org.eclipse.elk.graph.json.JsonImportException: Referenced shape does not exist: dim_customer'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPostMessage.mockClear();
    mockStoreState.recordError.mockClear();
    render(<Toolbar {...defaultProps} />);

    await act(async () => {
      fireEvent.click(layoutButton());
    });

    const finished = mockPostMessage.mock.calls.map(([m]) => m).find((m) => m?.type === 'layoutFinished');
    expect(finished.payload).toMatchObject({ ok: false, failure: 'input', tableBucket: 'under50', relBucket: 'under100' });
    expect(finished.payload.exhausted).toBeUndefined();
    expect(finished.payload.rung).toBeUndefined();
    // The message and the real counts travel in `log` only (the extension's own log).
    expect(finished.payload.log.message).toContain('JsonImportException');
    expect(Number.isInteger(finished.payload.log.tables)).toBe(true);
    const { log: _log, ...telemetryBound } = finished.payload;
    expect(JSON.stringify(telemetryBound)).not.toMatch(/dim_customer|JsonImportException/);
    // Send Feedback's recent canvas errors: class, buckets and how far the fallbacks got, in fixed words.
    expect(mockStoreState.recordError).toHaveBeenCalledTimes(1);
    const [source, line] = mockStoreState.recordError.mock.calls[0];
    expect(source).toBe('layout');
    expect(line).toMatch(/^Auto layout failed \(class input, tables under50, relationships under100, no fallback tried, ran (under1s|1to5s)\)$/);
    consoleSpy.mockRestore();
  });

  // Gerhard (2026-11-12): a degraded layout must say so, on the canvas and in the ERD Studio output.
  it('a layout that dropped the grouping says so, and sends what happened for the log', async () => {
    mockRunElkLayout.mockImplementationOnce(async (_nodes, _edges, _options, _strategy, hooks) => {
      hooks?.onFallbackRung?.(3);
      hooks?.onOutcome?.({ step: 'ungrouped', grouping: 'depth', bands: 'off', reason: 'Maximum call stack size exceeded' });
      return {};
    });
    mockPostMessage.mockClear();
    mockStoreState.setToastMessage.mockClear();
    render(<Toolbar {...defaultProps} />);

    await act(async () => {
      fireEvent.click(layoutButton());
    });

    const finished = mockPostMessage.mock.calls.map(([m]) => m).find((m) => m?.type === 'layoutFinished');
    expect(finished.payload).toMatchObject({ ok: true, rung: 3 });
    expect(finished.payload.log.message).toBe('used the fallback with grouping off (asked for grouping depth); the default layout failed: Maximum call stack size exceeded');
    expect(mockStoreState.setToastMessage).toHaveBeenCalledWith(expect.stringMatching(/^Grouping by Join depth failed on this diagram, so it was laid out with no grouping/));
  });

  it('a layout that worked as asked shows no notice and sends no log', async () => {
    mockRunElkLayout.mockImplementationOnce(async (_nodes, _edges, _options, _strategy, hooks) => {
      hooks?.onOutcome?.({ step: 'default', grouping: 'depth', bands: 'partitioned' });
      return {};
    });
    mockPostMessage.mockClear();
    mockStoreState.setToastMessage.mockClear();
    render(<Toolbar {...defaultProps} />);

    await act(async () => {
      fireEvent.click(layoutButton());
    });

    const finished = mockPostMessage.mock.calls.map(([m]) => m).find((m) => m?.type === 'layoutFinished');
    expect(finished.payload.ok).toBe(true);
    expect(finished.payload.log).toBeUndefined();
    expect(mockStoreState.setToastMessage).not.toHaveBeenCalled();
  });

  // "None works but I don't know if it actually does something": picking a
  // grouping only marks the layout as changed until Re-apply Layout is pressed.
  it('after a grouping is picked, the description says to press Re-apply Layout', () => {
    render(<Toolbar {...defaultProps} />);
    openOptionsPanel();
    expect(screen.queryByText(/Press Re-apply Layout/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(screen.getByText(/No grouping\. Tables are placed freely to reduce line crossings\..*Press Re-apply Layout to use these choices\./)).toBeTruthy();
  });

  // Real-app check (2026-11-12): Table type -> None -> Re-apply moved nothing
  // and said nothing, because with no table types the two are the same layout.
  it('picking Table type or None on tables with no table types says they arrange the same way', () => {
    render(<Toolbar {...defaultProps} />);
    openOptionsPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Table type' }));
    expect(screen.getByText(/These tables have no table types to group by, so Table type and None arrange them the same way\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(screen.getByText(/These tables have no table types to group by, so Table type and None arrange them the same way\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Join depth' }));
    expect(screen.queryByText(/no table types to group by/)).toBeNull();
  });

  it('does not say so when the tables have two table types', () => {
    const typed = [
      { ...makeNode('dim_a'), data: { ...makeNode('dim_a').data, modelRole: 'conformed-dim' as const } },
      { ...makeNode('fct_b'), data: { ...makeNode('fct_b').data, modelRole: 'transaction-fact' as const } },
    ];
    render(<Toolbar {...defaultProps} nodes={typed} />);
    openOptionsPanel();
    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(screen.queryByText(/no table types to group by/)).toBeNull();
  });

  it('a re-applied layout that moved no table says so instead of looking like it never ran', async () => {
    mockRunElkLayout.mockImplementationOnce(async (_nodes, _edges, _options, _strategy, hooks) => {
      hooks?.onOutcome?.({ step: 'default', grouping: 'none', bands: 'off' });
      return { model_a: { x: 0, y: 0 } };
    });
    mockStoreState.setToastMessage.mockClear();
    render(<Toolbar {...defaultProps} />);

    await act(async () => {
      fireEvent.click(layoutButton());
    });

    expect(mockStoreState.setToastMessage).toHaveBeenCalledWith(
      'Layout re-applied (grouping: None); nothing moved. These tables have no table types to group by, so Table type and None arrange them the same way.',
    );
  });

  it('a re-applied layout that moved a table shows no notice', async () => {
    mockRunElkLayout.mockImplementationOnce(async (_nodes, _edges, _options, _strategy, hooks) => {
      hooks?.onOutcome?.({ step: 'default', grouping: 'none', bands: 'off' });
      return { model_a: { x: 40, y: 0 } };
    });
    mockStoreState.setToastMessage.mockClear();
    render(<Toolbar {...defaultProps} />);

    await act(async () => {
      fireEvent.click(layoutButton());
    });

    expect(mockStoreState.setToastMessage).not.toHaveBeenCalled();
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
describe('logical-only mode (no dbt project)', () => {
  const diffButton = () => screen.queryByRole('button', { name: /^(compare with dbt|compare with design|stop comparing)$/i });
  const refreshButton = () => screen.queryByRole('button', { name: /refresh manifest data/i });

  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.logicalOnly = false;
  });

  afterEach(() => {
    mockStoreState.logicalOnly = false;
  });

  it('shows the stage tabs, Diff and the manifest refresh in a dbt project', () => {
    render(<Toolbar {...defaultProps} />);
    expect(screen.getByTestId('stage-tabs')).toBeTruthy();
    expect(diffButton()).toBeTruthy();
    expect(refreshButton()).toBeTruthy();
  });

  it('hides the stage tabs, Diff (and with it Sync) and the manifest refresh', () => {
    mockStoreState.logicalOnly = true;
    render(<Toolbar {...defaultProps} />);
    expect(screen.queryByTestId('stage-tabs')).toBeNull();
    expect(diffButton()).toBeNull();
    expect(screen.queryByText(/Diff|Compare with/)).toBeNull();
    expect(refreshButton()).toBeNull();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('keeps editing, layout and Export, with the open-formats tooltip', () => {
    mockStoreState.logicalOnly = true;
    render(<Toolbar {...defaultProps} />);
    expect(screen.getByRole('button', { name: /add table or relationship/i })).toBeTruthy();
    expect(layoutButton()).toBeTruthy();
    const exportButton = screen.getByRole('button', { name: /export diagram as mermaid or dbml/i });
    expect(exportButton.getAttribute('title')).toBe('Export as DBML or Mermaid');
  });
});

describe('the top-right corner actions', () => {
  /** Width of the corner in its labelled form, as a real browser reports it. */
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
    expect(screen.getByRole('button', { name: /open the diagram's file in a text editor/i })).toBeTruthy();
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
    expect(screen.getByRole('menuitem', { name: /Export as Mermaid or DBML/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Send feedback/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Open file/ })).toBeTruthy();
  });

  it('posts exportDiagram (no payload) from the labelled button', () => {
    layout({ toolbarRight: 900, cornerRight: 1400 });
    render(<Toolbar {...defaultProps} />);
    const button = screen.getByRole('button', { name: /export diagram as mermaid or dbml/i });
    expect(button.className).toBe('toolbar__corner-button toolbar__corner-button--icon');
    expect(button.getAttribute('title')).toBe('Export as DBML or Mermaid');

    fireEvent.click(button);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'exportDiagram' });
  });

  // A third labelled button would make the corner collapse to ⋯ about 155px of
  // window sooner, hiding the Feedback and View File labels at common widths;
  // as a glyph the size of the ⋯ trigger, Export costs far less of that room.
  it('shows Export as a glyph beside the two labelled buttons, its name in the tooltip', () => {
    layout({ toolbarRight: 900, cornerRight: 1400 });
    render(<Toolbar {...defaultProps} />);
    const buttons = Array.from(document.querySelectorAll('.toolbar__corner-actions > button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['⤓', '💬 Feedback', '{ } View File']);
    expect(buttons[0].getAttribute('aria-label')).toBe('Export diagram as Mermaid or DBML');
  });

  it('posts exportDiagram from the overflow menu and closes it', () => {
    layout({ toolbarRight: 900, cornerRight: 1000 });
    render(<Toolbar {...defaultProps} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitem', { name: /Export as Mermaid or DBML/ }));

    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'exportDiagram' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows Export on the physical stage too, saying it exports the logical design', () => {
    const saved = mockStoreState.domain;
    mockStoreState.domain = { ...mockSubjectArea, stage: 'physical' as const, readOnly: true };
    try {
      layout({ toolbarRight: 900, cornerRight: 1400 });
      render(<Toolbar {...defaultProps} />);
      const button = screen.getByRole('button', { name: /export diagram as mermaid or dbml/i });
      expect(button.getAttribute('title')).toMatch(/logical design/);
      fireEvent.click(button);
      expect(mockPostMessage).toHaveBeenCalledWith({ type: 'exportDiagram' });
    } finally {
      mockStoreState.domain = saved;
    }
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

describe('+ Add → New Relationship', () => {
  const openAddMenu = () => fireEvent.click(screen.getByRole('button', { name: /add table or relationship/i }));
  const newRelationship = () => screen.getByRole('menuitem', { name: 'New Relationship' }) as HTMLButtonElement;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockStoreState.domain = mockSubjectArea;
    mockStoreState.setNewFkDialogOpen = noop;
  });

  it('opens the dialog on a diagram with tables', () => {
    const setNewFkDialogOpen = vi.fn();
    mockStoreState.setNewFkDialogOpen = setNewFkDialogOpen;
    render(<Toolbar {...defaultProps} />);
    openAddMenu();
    expect(newRelationship().disabled).toBe(false);
    expect(newRelationship().getAttribute('title')).toBeNull();
    fireEvent.click(newRelationship());
    expect(setNewFkDialogOpen).toHaveBeenCalledWith(true);
  });

  it('is disabled, saying why, on a diagram with no tables', () => {
    const setNewFkDialogOpen = vi.fn();
    mockStoreState.setNewFkDialogOpen = setNewFkDialogOpen;
    mockStoreState.domain = { ...mockSubjectArea, models: [] };
    render(<Toolbar {...defaultProps} nodes={[]} />);
    openAddMenu();
    expect(newRelationship().disabled).toBe(true);
    expect(newRelationship().getAttribute('title')).toBe(NO_TABLES_FOR_RELATIONSHIP);
    expect(NO_TABLES_FOR_RELATIONSHIP).toMatch(/diagram/);
    expect(NO_TABLES_FOR_RELATIONSHIP).not.toMatch(/\b(models?|domains?|subject areas?)\b/i);
    fireEvent.click(newRelationship());
    expect(setNewFkDialogOpen).not.toHaveBeenCalled();
  });
});

describe('plain labels', () => {
  afterEach(() => {
    mockStoreState.domain = mockSubjectArea;
    mockStoreState.discrepancyVisible = false;
  });

  it('the Compare button says what it compares, on each stage', () => {
    render(<Toolbar {...defaultProps} />);
    const button = screen.getByRole('button', { name: 'Compare with dbt' });
    expect(button.textContent).toContain('Compare with dbt');
    expect(button.getAttribute('title')).toBe('Compare this design with the dbt project');
    expect(compareButtonWording('physical', false)).toEqual({ label: 'Compare with design', title: 'Compare what dbt has with your design' });
    expect(compareButtonWording('logical', true, 'physical')).toEqual({ label: 'Stop comparing', title: 'Comparing with dbt — click to stop' });
  });

  it('+ Add offers New Table and Add Existing Tables', () => {
    render(<Toolbar {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /add table or relationship/i }));
    expect(screen.getByRole('menuitem', { name: 'New Table' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Add Existing Tables' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Design Table/ })).toBeNull();
  });

  it('the layout row counts columns for a left-to-right flow and rows for top-to-bottom', () => {
    expect(layerBoundWording('RIGHT')).toEqual({ label: 'Max per column', unit: 'per column', hint: 'lower = wider layout, higher = taller layout' });
    expect(layerBoundWording('DOWN')).toEqual({ label: 'Max per row', unit: 'per row', hint: 'lower = taller layout, higher = wider layout' });
    render(<Toolbar {...defaultProps} />);
    openOptionsPanel();
    expect(screen.getByText('Max per column')).toBeTruthy();
    expect(screen.getByText(/^auto — \d+ per column for 1 tables$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '↓' }));
    expect(screen.getByText('Max per row')).toBeTruthy();
    expect(screen.queryByText('Max per layer')).toBeNull();
  });
});

describe('Toolbar Fit leaves room for itself (dev-host finding 7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pads the top by the toolbar\'s bottom edge, not a flat 0.1', () => {
    const { container } = render(<div className="react-flow"><Toolbar {...defaultProps} /></div>);
    const flow = container.querySelector('.react-flow') as HTMLElement;
    const toolbar = container.querySelector('.toolbar-container') as HTMLElement;
    flow.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 1440, width: 1440, height: 800 }) as DOMRect;
    toolbar.getBoundingClientRect = () => ({ top: 15, bottom: 87, left: 400, right: 1000, width: 600, height: 72 }) as DOMRect;

    fireEvent.click(screen.getByRole('button', { name: 'Fit view to show all nodes' }));

    expect(mockFitView).toHaveBeenCalledTimes(1);
    expect(mockFitView.mock.calls[0][0]).toEqual({
      padding: { top: '99px', right: 0.1, bottom: 0.1, left: 0.1 },
      maxZoom: 1,
      duration: 200,
    });
  });
});

describe('Toolbar table detail switch', () => {
  afterEach(() => {
    cleanup();
    mockStoreState.domain = mockSubjectArea;
    delete mockStoreState.tableDetail;
  });

  it('offers Names / Keys / All in place of the Expand All / Collapse All button', () => {
    mockStoreState.tableDetail = 'keys';
    render(<Toolbar {...defaultProps} />);
    const group = screen.getByRole('radiogroup', { name: 'Table detail' });
    expect([...group.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual(['Names', 'Keys', 'All']);
    expect(screen.getByRole('radio', { name: 'Key columns only' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('button', { name: /expand all columns|collapse all columns/i })).toBeNull();
  });

  it('is there on a read-only diagram too (a view preference, not an edit)', () => {
    mockStoreState.domain = { ...mockSubjectArea, stage: 'physical' as const, readOnly: true };
    render(<Toolbar {...defaultProps} />);
    expect(screen.getByRole('radiogroup', { name: 'Table detail' })).toBeTruthy();
  });
});
