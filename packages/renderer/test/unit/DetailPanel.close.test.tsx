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

  it('viewer: a long composite row breaks after _ . and ", " (<wbr>), and keeps each arrow with the name it points at', () => {
    const d = domain(true);
    d.models.push({ name: 'dim_warehouse_location', schema: 'gold', description: '', columns: [col('site_id', true), col('bin_id', true)] } as never);
    d.relationships.push(
      { fromModel: 'fct_order_line_with_a_very_long_name', fromColumn: 'site_id', toModel: 'dim_warehouse_location', toColumn: 'site_id', cardinality: 'many-to-one', compositeKey: 'loc' },
      { fromModel: 'fct_order_line_with_a_very_long_name', fromColumn: 'bin_id', toModel: 'dim_warehouse_location', toColumn: 'bin_id', cardinality: 'many-to-one', compositeKey: 'loc' },
      // Incoming, so the other row's arrow is checked too.
      { fromModel: 'dim_date', fromColumn: 'first_order_line_key', toModel: 'fct_order_line_with_a_very_long_name', toColumn: 'order_line_key', cardinality: 'many-to-one' },
    );
    const store = createCanvasStore({ domain: d, selectedNode: 'fct_order_line_with_a_very_long_name', detailPanelOpen: true });
    const { container } = render(
      <CanvasStoreProvider store={store}>
        <CanvasEnvironmentProvider host={{ postMessage: vi.fn() }} viewer>
          <ReactFlowProvider><DetailPanel /></ReactFlowProvider>
        </CanvasEnvironmentProvider>
      </CanvasStoreProvider>,
    );
    const rows = [...container.querySelectorAll('.detail-panel__relationship')];
    const composite = rows.find((r) => r.textContent!.includes('dim_warehouse_location'))!;
    const target = composite.querySelector('.detail-panel__rel-target')!;
    // Break points after "dim_", "warehouse_", "location.", "(site_id, " and "site_", "bin_".
    expect(target.querySelectorAll('wbr').length).toBeGreaterThanOrEqual(5);
    expect(target.textContent).toBe('\u2192\u00a0dim_warehouse_location.(site_id, bin_id)');
    expect(target.getAttribute('title')).toBe('dim_warehouse_location.(site_id, bin_id)');
    // The arrow is inside the target, never a flex item of its own.
    expect(target.querySelector(':scope > .detail-panel__rel-arrow')).not.toBeNull();
    expect(composite.querySelector('.detail-panel__rel-columns > .detail-panel__rel-arrow')).toBeNull();
    expect(composite.querySelector('.detail-panel__rel-local')!.querySelectorAll('wbr').length).toBeGreaterThan(0);

    const incoming = rows.find((r) => r.textContent!.includes('first_order_line_key'))!;
    const local = incoming.querySelector('.detail-panel__rel-local')!;
    expect(local.querySelector(':scope > .detail-panel__rel-arrow')).not.toBeNull();
    expect(incoming.querySelector('.detail-panel__rel-columns > .detail-panel__rel-arrow')).toBeNull();
    expect(incoming.querySelector('.detail-panel__rel-target')!.querySelectorAll('wbr').length).toBeGreaterThan(0);
  });

  it('editor: the clickable rows it always had, without the role line', () => {
    const { container } = renderPanel(false);
    expect(container.querySelector('.detail-panel')!.className).not.toContain('detail-panel--viewer');
    const row = container.querySelector('.detail-panel__relationship')!;
    expect(row.className).toBe('detail-panel__relationship detail-panel__relationship--clickable');
    expect(row.querySelector('.detail-panel__rel-role')).toBeNull();
    // Its arrow is still the flex item between the two names, and no <wbr>.
    expect(row.querySelector('.detail-panel__rel-columns > .detail-panel__rel-arrow')).not.toBeNull();
    expect(row.querySelectorAll('wbr')).toHaveLength(0);
    expect(row.querySelector('.detail-panel__rel-target')!.textContent).toBe('dim_date.date_key');
  });
});

describe('DetailPanel.css (viewer)', () => {
  it('keeps the viewer panel above the minimap, never scrolling sideways, and wraps a long header value', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, '../../src/components/DetailPanel/DetailPanel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string) => {
      const m = css.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
      return m ? m[1] : '';
    };
    const panel = rule('.detail-panel--viewer');
    expect(panel).toMatch(/max-height:\s*min\(calc\(100vh - 100px\),\s*calc\(100% - 192px\)\)/);
    expect(panel).toMatch(/overflow-x:\s*hidden/);
    const value = rule('.detail-panel--viewer .detail-panel__value');
    expect(value).toMatch(/overflow-wrap:\s*anywhere/);
    expect(value).toMatch(/min-width:\s*0/);
    // The editor's own rules are untouched.
    expect(rule('.detail-panel__value')).not.toMatch(/overflow-wrap/);
  });

  it('the viewer: a 38-character warehouse name is in a value the wrapping rule applies to', () => {
    const d = domain(true);
    (d.models[0] as { alias?: string }).alias = 'shipment_line_items_daily_snapshot_v2';
    const store = createCanvasStore({ domain: d, selectedNode: 'fct_order_line_with_a_very_long_name', detailPanelOpen: true });
    const { container } = render(
      <CanvasStoreProvider store={store}>
        <CanvasEnvironmentProvider host={{ postMessage: vi.fn() }} viewer>
          <ReactFlowProvider><DetailPanel /></ReactFlowProvider>
        </CanvasEnvironmentProvider>
      </CanvasStoreProvider>,
    );
    const value = [...container.querySelectorAll('.detail-panel--viewer .detail-panel__value')]
      .find((v) => v.textContent === 'shipment_line_items_daily_snapshot_v2');
    expect(value).toBeDefined();
  });
});
