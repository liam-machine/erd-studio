// @vitest-environment jsdom
/**
 * DiscrepancyPanel and the Detail Panel side by side (dev-host finding 6).
 *
 * Clicking a table in the Compare panel opens the Detail Panel (top-right).
 * The Compare panel then moves left of it (`disc-panel--beside-detail`)
 * instead of sitting underneath, and the zoom leaves the table in the part of
 * the canvas the two panels and the toolbar do not cover.
 *
 * Runs against the real editor store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockFitView = vi.hoisted(() => vi.fn());
vi.mock('@xyflow/react', () => ({
  Panel: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={`react-flow__panel ${className ?? ''}`}>{children}</div>
  ),
  useReactFlow: () => ({ fitView: mockFitView }),
}));
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }),
}));

import { useEditorStore } from '../../webview/store/editorStore';
import { DiscrepancyPanel } from '../../webview/components/DiscrepancyPanel/DiscrepancyPanel';
import {
  DETAIL_PANEL_WIDTH_PX,
  FALLBACK_TOP_INSET_PX,
  MIN_FREE_CANVAS_PX,
  PANEL_MARGIN_PX,
} from '../../webview/lib/fitViewPadding';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { DisplaySubjectArea } from '../../src/types/display';

const state = () => useEditorStore.getState();

const subjectArea = {
  schemaVersion: 5, domain: 'showcase', layer: 'silver', stage: 'logical', description: '',
  models: [{ name: 'fct_task_event', schema: 'gold', description: '', columns: [] }],
  relationships: [], viewConfig: {}, readOnly: false,
} as unknown as DisplaySubjectArea;

const report = {
  domain: 'showcase', layer: 'silver', sourceStage: 'logical', targetStage: 'physical',
  models: [{ name: 'fct_task_event', status: 'matched', columns: [{ name: 'loaded_at', status: 'missing', targetDataType: 'timestamp' }] }],
  relationships: [],
  summary: {
    totalModels: 1, matchedModels: 1, extraModels: 0, missingModels: 0, totalColumns: 1,
    matchedColumns: 0, extraColumns: 0, missingColumns: 1, dataTypeMismatches: 0, undeclaredColumns: 0,
  },
} as DiscrepancyReport;

function panel(): HTMLElement {
  return document.querySelector('.disc-panel') as HTMLElement;
}

beforeEach(() => {
  act(() => {
    state().setDomain(subjectArea);
    state().setDiscrepancyVisible(true);
    state().setDiscrepancyReport(report);
    state().setDetailPanelOpen(false);
  });
});

afterEach(() => {
  cleanup();
  mockFitView.mockClear();
  act(() => {
    state().setDiscrepancyVisible(false);
    state().setDiscrepancyReport(null);
    state().setDetailPanelOpen(false);
  });
});

describe('DiscrepancyPanel beside the Detail Panel', () => {
  it('sits in its own corner while the Detail Panel is closed', () => {
    render(<DiscrepancyPanel />);
    expect(panel().className).not.toContain('disc-panel--beside-detail');
  });

  it('clicking a table opens the Detail Panel and moves this panel left of it', () => {
    render(<DiscrepancyPanel />);
    fireEvent.click(screen.getByText('fct_task_event'));

    expect(state().selectedNode).toBe('fct_task_event');
    expect(state().detailPanelOpen).toBe(true);
    expect(panel().className).toContain('disc-panel--beside-detail');
  });

  it('the zoom keeps the table clear of the toolbar and of both panels', () => {
    render(<DiscrepancyPanel />);
    panel().getBoundingClientRect = () => ({ width: 300, height: 360, top: 0, left: 0, right: 300, bottom: 360 }) as DOMRect;
    fireEvent.click(screen.getByText('fct_task_event'));

    expect(mockFitView).toHaveBeenCalledTimes(1);
    const opts = mockFitView.mock.calls[0][0];
    expect(opts.nodes).toEqual([{ id: 'fct_task_event' }]);
    const right = DETAIL_PANEL_WIDTH_PX + PANEL_MARGIN_PX + 12 + 300 + PANEL_MARGIN_PX;
    expect(opts.padding).toEqual({ top: `${FALLBACK_TOP_INSET_PX}px`, right: `${right}px`, bottom: 0.1, left: 0.1 });
  });

  it('on a narrow canvas it stays in its corner, and the zoom still leaves room for the table', () => {
    // A split editor: the canvas is 750px wide.
    const flow = document.createElement('div');
    flow.className = 'react-flow';
    flow.getBoundingClientRect = () => ({ width: 750, height: 700, top: 0, left: 0, right: 750, bottom: 700 }) as DOMRect;
    document.body.appendChild(flow);
    try {
      render(<DiscrepancyPanel />, { container: flow.appendChild(document.createElement('div')) });
      panel().getBoundingClientRect = () => ({ width: 320, height: 360, top: 0, left: 0, right: 320, bottom: 360 }) as DOMRect;
      fireEvent.click(screen.getByText('fct_task_event'));

      expect(state().detailPanelOpen).toBe(true);
      expect(panel().className).not.toContain('disc-panel--beside-detail');
      const right = parseFloat(mockFitView.mock.calls[0][0].padding.right);
      expect(right).toBeLessThanOrEqual(DETAIL_PANEL_WIDTH_PX + 2 * PANEL_MARGIN_PX);
      expect(750 * 0.9 - right).toBeGreaterThanOrEqual(MIN_FREE_CANVAS_PX);
    } finally {
      cleanup();
      flow.remove();
    }
  });

  it('stays in its corner when the selected node is not a table of this diagram', () => {
    act(() => {
      state().selectNode('not_a_table');
      state().setDetailPanelOpen(true);
    });
    render(<DiscrepancyPanel />);
    expect(panel().className).not.toContain('disc-panel--beside-detail');
  });
});
