// @vitest-environment jsdom
/**
 * The detail panel's close button, and its relationship rows, in the viewer
 * and in the editor.
 *
 *  - Viewer: closing hides the panel and keeps the table selected (its
 *    relationships stay lit); the rows wrap and show the role.
 *  - Editor: closing clears the selection, as it always has; the rows are the
 *    clickable, single-line rows they always were.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { CanvasEditMessage, DisplaySubjectArea } from '@erd-studio/core';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import { DetailPanel } from '../../src/components/DetailPanel/DetailPanel';

afterEach(cleanup);

const col = (name: string, isPrimaryKey = false) => ({ name, dataType: 'bigint', description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });

function domain(readOnly: boolean): DisplaySubjectArea {
  return {
    schemaVersion: 7, domain: 'sales', layer: 'gold', stage: 'logical', description: '', viewConfig: {},
    readOnly, positionDraggable: true,
    models: [
      { name: 'fct_order_line_with_a_very_long_name', schema: 'gold', description: '', columns: [col('order_line_key', true), col('ship_date_key')] },
      { name: 'dim_date', schema: 'gold', description: '', columns: [col('date_key', true)] },
    ],
    relationships: [
      { fromModel: 'fct_order_line_with_a_very_long_name', fromColumn: 'ship_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'ship date' },
    ],
  } as DisplaySubjectArea;
}

function renderPanel(viewer: boolean) {
  const posted: CanvasEditMessage[] = [];
  const store = createCanvasStore({
    domain: domain(viewer),
    selectedNode: 'fct_order_line_with_a_very_long_name',
    detailPanelOpen: true,
  });
  const utils = render(
    <CanvasStoreProvider store={store}>
      <CanvasEnvironmentProvider host={{ postMessage: vi.fn((m: CanvasEditMessage) => { posted.push(m); }) }} viewer={viewer}>
        <ReactFlowProvider><DetailPanel /></ReactFlowProvider>
      </CanvasEnvironmentProvider>
    </CanvasStoreProvider>,
  );
  return { ...utils, store, posted };
}

describe('DetailPanel close', () => {
  it('viewer: hides the panel and keeps the table selected', () => {
    const { container, store, posted } = renderPanel(true);
    fireEvent.click(container.querySelector('.detail-panel__close')!);
    expect(container.querySelector('.detail-panel')).toBeNull();
    expect(store.getState().detailPanelOpen).toBe(false);
    expect(store.getState().selectedNode).toBe('fct_order_line_with_a_very_long_name');
    expect(posted).toEqual([]);
  });

  it('editor: closes the panel and clears the selection, as before', () => {
    const { container, store } = renderPanel(false);
    expect(container.querySelector('.detail-panel__close')!.getAttribute('title')).toBe('Close detail panel');
    fireEvent.click(container.querySelector('.detail-panel__close')!);
    expect(store.getState().detailPanelOpen).toBe(false);
    expect(store.getState().selectedNode).toBeNull();
  });
});

describe('DetailPanel relationship rows', () => {
  it('viewer: rows wrap, keep their full-text tooltips and show the role; the panel fits its canvas', () => {
    const { container } = renderPanel(true);
    expect(container.querySelector('.detail-panel')!.classList.contains('detail-panel--viewer')).toBe(true);
    const row = container.querySelector('.detail-panel__relationship')!;
    expect(row.className).toBe('detail-panel__relationship detail-panel__relationship--wrap');
    expect(row.querySelector('.detail-panel__rel-target')!.getAttribute('title')).toBe('dim_date.date_key');
    expect(row.querySelector('.detail-panel__rel-role')!.textContent).toBe('ship date');
  });

  it('editor: the clickable rows it always had, without the role line', () => {
    const { container } = renderPanel(false);
    expect(container.querySelector('.detail-panel')!.className).not.toContain('detail-panel--viewer');
    const row = container.querySelector('.detail-panel__relationship')!;
    expect(row.className).toBe('detail-panel__relationship detail-panel__relationship--clickable');
    expect(row.querySelector('.detail-panel__rel-role')).toBeNull();
  });
});
