// @vitest-environment jsdom
/**
 * SyncMergeModal — decided rows stay where they are (dev-host finding 4).
 *
 *  - Picking a side on a relationship row leaves the row in place with that
 *    side shown as chosen; nothing moves into a "resolved" section, so the row
 *    under the pointer is still the one just clicked.
 *  - Clicking the chosen side again clears the decision.
 *  - Reset clears every decision.
 *  - "Apply Changes (N)" and "N differences still need a decision" follow.
 *  - The inferred decision for a table that exists on one side only follows
 *    its columns: cleared when a column is cleared.
 *
 * Runs against the real editor store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const postMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage, getState: vi.fn(), setState: vi.fn() }),
}));

import { useEditorStore } from '../../webview/store/editorStore';
import { SyncMergeModal } from '../../webview/components/SyncMergeModal/SyncMergeModal';
import type { DiscrepancyReport } from '../../src/types/discrepancy';

const state = () => useEditorStore.getState();

function report(): DiscrepancyReport {
  return {
    domain: 'showcase',
    layer: 'silver',
    sourceStage: 'logical',
    targetStage: 'physical',
    models: [
      {
        name: 'fct_task_event',
        status: 'matched',
        columns: [
          { name: 'project_key', status: 'extra', sourceDataType: 'INT' },
          { name: 'loaded_at', status: 'missing', targetDataType: 'timestamp' },
        ],
      },
      {
        // Exists in logical only: one table key + its column keys.
        name: 'dim_region',
        status: 'extra',
        columns: [
          { name: 'region_key', status: 'extra', sourceDataType: 'INT' },
          { name: 'region_name', status: 'extra', sourceDataType: 'VARCHAR' },
        ],
      },
    ],
    relationships: [
      { fromModel: 'fct_task_event', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', status: 'extra' },
      { fromModel: 'fct_task_event', fromColumn: 'project_key', toModel: 'dim_project', toColumn: 'project_key', status: 'extra' },
      { fromModel: 'dim_project', fromColumn: 'parent_project_key', toModel: 'dim_project', toColumn: 'project_key', status: 'extra' },
    ],
    summary: {
      totalModels: 2, matchedModels: 1, extraModels: 1, missingModels: 0,
      totalColumns: 4, matchedColumns: 0, extraColumns: 3, missingColumns: 1,
      dataTypeMismatches: 0, undeclaredColumns: 0,
    },
  } as DiscrepancyReport;
}

// 2 + 2 columns, 1 table key (dim_region), 3 relationships.
const TOTAL = 8;

/** The relationship rows, in document order, as their label text. */
function relationshipRowLabels(): string[] {
  return Array.from(document.querySelectorAll('.sync-modal__rel-label')).map((el) => el.textContent ?? '');
}

function rowFor(label: string): HTMLElement {
  const el = Array.from(document.querySelectorAll('.sync-modal__rel-label')).find((n) => n.textContent === label);
  if (!el) throw new Error(`no row ${label}`);
  return el.closest('tr') as HTMLElement;
}

function sideButton(row: HTMLElement, side: 'Logical' | 'Physical'): HTMLElement {
  return within(row).getByRole('button', { name: new RegExp(`^(✓ )?${side}$`) });
}

function applyButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Apply Changes/ });
}

beforeEach(() => {
  act(() => {
    state().clearSyncSelections();
    state().setDiscrepancyReport(report());
    state().setSyncMode(true);
  });
});

afterEach(() => {
  cleanup();
  postMessage.mockClear();
  act(() => {
    state().setSyncMode(false);
    state().setDiscrepancyReport(null);
    state().clearSyncSelections();
  });
});

describe('SyncMergeModal: decided rows stay in place', () => {
  it('a decided relationship row keeps its position and shows the chosen side', () => {
    render(<SyncMergeModal />);
    const before = relationshipRowLabels();
    expect(before).toHaveLength(3);

    const first = rowFor(before[0]);
    fireEvent.click(sideButton(first, 'Logical'));

    // Same rows, same order: the next row did not slide under the pointer.
    expect(relationshipRowLabels()).toEqual(before);
    const decided = rowFor(before[0]);
    const chosen = sideButton(decided, 'Logical');
    expect(chosen.textContent).toBe('✓ Logical');
    expect(chosen.getAttribute('aria-pressed')).toBe('true');
    expect(chosen.className).toContain('sync-modal__accept-btn--selected');
    expect(sideButton(decided, 'Physical').getAttribute('aria-pressed')).toBe('false');

    // No collapsed "resolved" section any more.
    expect(document.querySelector('.sync-modal__resolved-section-header')).toBeNull();
    expect(screen.queryByText(/resolved item/)).toBeNull();
  });

  it('deciding every column of a table leaves its rows expanded (no auto-collapse)', () => {
    vi.useFakeTimers();
    try {
      render(<SyncMergeModal />);
      const rowsBefore = document.querySelectorAll('tbody tr').length;
      const colRow = (name: string) => screen.getByText(name, { selector: '.sync-modal__col-name' }).closest('tr') as HTMLElement;
      fireEvent.click(within(colRow('project_key')).getByRole('button', { name: 'Physical' }));
      fireEvent.click(within(colRow('loaded_at')).getByRole('button', { name: 'Physical' }));
      act(() => { vi.advanceTimersByTime(2000); });
      expect(document.querySelectorAll('tbody tr').length).toBe(rowsBefore);
      expect(screen.getByText('project_key', { selector: '.sync-modal__col-name' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicking the chosen side again clears the decision', () => {
    render(<SyncMergeModal />);
    const label = relationshipRowLabels()[1];
    fireEvent.click(sideButton(rowFor(label), 'Physical'));
    expect(applyButton().textContent).toBe('Apply Changes (1)');

    fireEvent.click(sideButton(rowFor(label), 'Physical'));
    expect(sideButton(rowFor(label), 'Physical').getAttribute('aria-pressed')).toBe('false');
    expect(Object.keys(state().syncSelections)).toHaveLength(0);
    expect(applyButton().textContent).toBe('Apply Changes');
    expect((applyButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('the chosen side says how to undo it', () => {
    render(<SyncMergeModal />);
    const row = rowFor(relationshipRowLabels()[0]);
    fireEvent.click(sideButton(row, 'Logical'));
    expect(sideButton(row, 'Logical').getAttribute('title')).toMatch(/Click again to clear this choice$/);
  });

  it('Reset clears every decision, and is disabled with nothing decided', () => {
    render(<SyncMergeModal />);
    const reset = screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'All Physical' }));
    expect(applyButton().textContent).toBe(`Apply Changes (${TOTAL})`);
    expect(reset.disabled).toBe(false);

    fireEvent.click(reset);
    expect(state().syncSelections).toEqual({});
    expect(applyButton().textContent).toBe('Apply Changes');
    expect(screen.getByText(`0/${TOTAL}`)).toBeTruthy();
    expect(reset.disabled).toBe(true);
  });

  it('the Apply count and the "still need a decision" hint follow picks and un-picks', () => {
    render(<SyncMergeModal />);
    const labels = relationshipRowLabels();
    fireEvent.click(sideButton(rowFor(labels[0]), 'Logical'));
    fireEvent.click(sideButton(rowFor(labels[2]), 'Physical'));
    expect(applyButton().textContent).toBe('Apply Changes (2)');
    expect(screen.getByText(`${TOTAL - 2} differences still need a decision`)).toBeTruthy();

    fireEvent.click(sideButton(rowFor(labels[0]), 'Logical'));
    expect(applyButton().textContent).toBe('Apply Changes (1)');
    expect(screen.getByText(`${TOTAL - 1} differences still need a decision`)).toBeTruthy();

    fireEvent.click(applyButton());
    expect(postMessage).toHaveBeenCalledWith({
      type: 'generateSyncPlan',
      payload: { selections: { 'rel:dim_project:parent_project_key:dim_project:project_key': 'physical' } },
    });
  });

  it('a decision left over from an earlier report is neither counted nor sent', () => {
    act(() => { state().setSyncSelection('col:gone_table:gone_column', 'logical'); });
    render(<SyncMergeModal />);
    expect(applyButton().textContent).toBe('Apply Changes');

    fireEvent.click(sideButton(rowFor(relationshipRowLabels()[0]), 'Logical'));
    expect(applyButton().textContent).toBe('Apply Changes (1)');
    fireEvent.click(applyButton());
    const sent = postMessage.mock.calls.at(-1)?.[0];
    expect(Object.keys(sent.payload.selections)).toEqual([
      'rel:fct_task_event:customer_key:dim_customer:customer_key',
    ]);
  });

  it('the inferred table decision is set with its columns and cleared with them', () => {
    render(<SyncMergeModal />);
    const colRow = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
    fireEvent.click(within(colRow('region_key')).getByRole('button', { name: 'Logical' }));
    fireEvent.click(within(colRow('region_name')).getByRole('button', { name: 'Logical' }));
    expect(state().syncSelections['model:dim_region']).toBe('logical');
    expect(applyButton().textContent).toBe('Apply Changes (3)');

    // Un-pick one column: the table is no longer decided either.
    fireEvent.click(within(colRow('region_name')).getByRole('button', { name: '✓ Logical' }));
    expect(state().syncSelections['model:dim_region']).toBeUndefined();
    expect(applyButton().textContent).toBe('Apply Changes (1)');
  });

  it('a table decided with "Keep all" keeps its decision when one column is un-picked', () => {
    render(<SyncMergeModal />);
    const header = screen.getByText('dim_region').closest('tr') as HTMLElement;
    fireEvent.click(within(header).getAllByRole('button', { name: 'Keep all' })[1]);
    expect(state().syncSelections['model:dim_region']).toBe('physical');

    const colRow = screen.getByText('region_key').closest('tr') as HTMLElement;
    fireEvent.click(within(colRow).getByRole('button', { name: '✓ Physical' }));
    expect(state().syncSelections['model:dim_region']).toBe('physical');
    expect(state().syncSelections['col:dim_region:region_key']).toBeUndefined();
  });
});
