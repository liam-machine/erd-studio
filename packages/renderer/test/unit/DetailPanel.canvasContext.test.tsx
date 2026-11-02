// @vitest-environment jsdom
/**
 * The detail panel with the editing host's canvas context: the table's File
 * line (with Open), "Reviewed by", and "Not on this diagram (n)" with "+ Add"
 * and "Add all related". None of it in the viewer, on the physical stage, or
 * without a context. The modelling fields fold under "Modelling detail
 * (optional)", open by themselves once one is set; the viewer keeps its old
 * layout, every section in the old order.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { CanvasContext, CanvasEditMessage, DisplaySubjectArea, DisplayTable } from '@erd-studio/core';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import { DetailPanel, hasModellingDetail } from '../../src/components/DetailPanel/DetailPanel';

afterEach(cleanup);

const col = (name: string, isPrimaryKey = false) => ({ name, dataType: 'bigint', description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });

function domain(options: { stage?: 'logical' | 'physical'; viewerReadOnly?: boolean; sale?: Partial<DisplayTable>; extra?: string[] } = {}): DisplaySubjectArea {
  const stage = options.stage ?? 'logical';
  return {
    schemaVersion: 7, domain: 'sales', layer: 'gold', stage, description: '', viewConfig: {},
    readOnly: stage === 'physical' || options.viewerReadOnly === true, positionDraggable: true,
    models: [
      { name: 'fct_sale', schema: 'gold', description: 'One row per sale line', columns: [col('sale_key', true), col('store_key')], ...options.sale },
      ...(options.extra ?? []).map((name) => ({ name, schema: 'gold', description: '', columns: [col(`${name}_key`, true)] })),
    ],
    relationships: [],
  } as DisplaySubjectArea;
}

const CONTEXT: CanvasContext = {
  tableFiles: { fct_sale: '.erd-studio/gold/tables/gold/fct_sale.dbml' },
  offDiagram: {
    fct_sale: [
      { otherTable: 'dim_store', otherLayer: 'Silver', columns: 'store_key', cardinality: 'many-to-one', direction: 'out' },
      { otherTable: 'fct_return', columns: 'sale_ref → sale_key', cardinality: 'many-to-one', direction: 'in' },
    ],
  },
  owners: { fct_sale: '@acme/sales' },
};

function renderPanel(options: { domain?: DisplaySubjectArea; context?: CanvasContext | null; viewer?: boolean } = {}) {
  const posted: CanvasEditMessage[] = [];
  const host = { postMessage: vi.fn((m: CanvasEditMessage) => { posted.push(m); }) };
  const store = createCanvasStore({
    domain: options.domain ?? domain(),
    selectedNode: 'fct_sale',
    detailPanelOpen: true,
    canvasContext: options.context === undefined ? CONTEXT : options.context,
  });
  const utils = render(
    <CanvasStoreProvider store={store}>
      <CanvasEnvironmentProvider host={host} viewer={options.viewer ?? false}>
        <ReactFlowProvider><DetailPanel /></ReactFlowProvider>
      </CanvasEnvironmentProvider>
    </CanvasStoreProvider>,
  );
  return { ...utils, posted, store };
}

/** The section titles and toggles, top to bottom. */
function sectionOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.detail-panel__section-title, .column-editor__title, .detail-panel__rationale-toggle, .detail-panel__modelling-toggle, .detail-panel__button--danger')]
    .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
}

describe('DetailPanel — File line', () => {
  it('shows the project-relative file and opens it through openModelFile', () => {
    const { container, posted } = renderPanel();
    const row = container.querySelector('.detail-panel__metadata-row--file')!;
    expect(row.textContent).toContain('File');
    expect(row.textContent).toContain('.erd-studio/gold/tables/gold/fct_sale.dbml');
    // The first row of the metadata.
    expect(container.querySelector('.detail-panel__metadata')!.firstElementChild).toBe(row);
    fireEvent.click(screen.getByRole('button', { name: "Open this table's file" }));
    expect(posted).toEqual([{ type: 'openModelFile', payload: { modelName: 'fct_sale' } }]);
  });

  it('names who reviews the file', () => {
    renderPanel();
    expect(screen.getByText('Reviewed by')).toBeTruthy();
    expect(screen.getByText('@acme/sales')).toBeTruthy();
  });

  it('is not there without a context, or in the viewer', () => {
    for (const options of [{ context: null }, { viewer: true }]) {
      const { container } = renderPanel(options);
      expect(container.querySelector('.detail-panel__metadata-row--file')).toBeNull();
      expect(container.textContent).not.toContain('Reviewed by');
      cleanup();
    }
  });
});

describe('DetailPanel — Not on this diagram', () => {
  it('lists each relationship to a table not on the diagram, with its columns, cardinality and layer', () => {
    const { container } = renderPanel();
    expect(screen.getByText('Not on this diagram (2)')).toBeTruthy();
    const rows = [...container.querySelectorAll('.detail-panel__off-row')].map((r) => r.textContent);
    expect(rows).toEqual([
      '→dim_store · store_key · Many-to-one · in Silver+ Add',
      '←fct_return · sale_ref → sale_key · Many-to-one+ Add',
    ]);
  });

  it('"+ Add" adds that table; "Add all related" adds every one in one request', () => {
    const { posted } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add dim_store to this diagram' }));
    expect(posted).toEqual([{ type: 'addExistingModel', payload: { modelName: 'dim_store' } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Add all related' }));
    expect(posted[1]).toEqual({ type: 'addExistingModels', payload: { modelNames: ['dim_store', 'fct_return'] } });
  });

  it('"Add all related" with one table names it once', () => {
    const { posted } = renderPanel({
      context: { ...CONTEXT, offDiagram: { fct_sale: [CONTEXT.offDiagram.fct_sale[0], { ...CONTEXT.offDiagram.fct_sale[0], columns: 'other_store_key' }] } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add all related' }));
    expect(posted).toEqual([{ type: 'addExistingModel', payload: { modelName: 'dim_store' } }]);
  });

  it('drops a table once it is on the diagram, and the list once it is empty', () => {
    const { store } = renderPanel();
    act(() => { store.getState().setDomain(domain({ extra: ['dim_store'] })); store.getState().selectNode('fct_sale'); });
    expect(screen.getByText('Not on this diagram (1)')).toBeTruthy();
    act(() => { store.getState().setDomain(domain({ extra: ['dim_store', 'fct_return'] })); });
    expect(screen.queryByText(/Not on this diagram/)).toBeNull();
  });

  it('is not there in the viewer, on the physical stage, or without a context', () => {
    for (const options of [{ viewer: true }, { domain: domain({ stage: 'physical' }) }, { context: null }]) {
      const { container } = renderPanel(options);
      expect(container.textContent).not.toContain('Not on this diagram');
      expect(container.textContent).not.toContain('Add all related');
      cleanup();
    }
  });
});

describe('DetailPanel — Modelling detail (optional)', () => {
  it('puts Description and Columns first and folds the modelling fields when none is set', () => {
    const { container } = renderPanel({ context: null });
    expect(screen.getByRole('button', { name: 'Modelling detail (optional)' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('combobox', { name: 'Table type' })).toBeNull();
    const order = sectionOrder(container);
    expect(order.findIndex((t) => t.endsWith('Modelling detail (optional)'))).toBeGreaterThan(order.findIndex((t) => /^Columns/.test(t)));
    expect(order.at(-1)).toBe('Remove from Diagram');
  });

  it('opens by itself when any of the fields is set', () => {
    for (const sale of [{ modelRole: 'transaction-fact' as const }, { grain: 'One row per sale line' }, { meta: { owner: 'sales' } }, { rationale: { purpose: 'Sales' } }]) {
      renderPanel({ domain: domain({ sale }), context: null });
      expect(screen.getByRole('button', { name: /Modelling detail/ }).getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('combobox', { name: 'Table type' })).toBeTruthy();
      cleanup();
    }
  });

  it('stays open while it is being filled in, and folds again for a table with nothing set', () => {
    const { store } = renderPanel({ context: null });
    fireEvent.click(screen.getByRole('button', { name: /Modelling detail/ }));
    // A role set, then cleared again: still open while editing.
    act(() => { store.getState().setDomain(domain({ sale: { modelRole: 'transaction-fact' } })); });
    act(() => { store.getState().setDomain(domain()); });
    expect(screen.getByRole('button', { name: /Modelling detail/ }).getAttribute('aria-expanded')).toBe('true');
    // Another table: folded again.
    act(() => { store.getState().setDomain(domain({ extra: ['dim_store'] })); store.getState().selectNode('dim_store'); });
    expect(screen.getByRole('button', { name: /Modelling detail/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('the viewer keeps its old layout: no fold, sections in the old order', () => {
    const { container } = renderPanel({
      viewer: true,
      domain: domain({ viewerReadOnly: true, sale: { meta: { owner: 'sales' }, rationale: { purpose: 'Sales' } } }),
    });
    expect(screen.queryByRole('button', { name: /Modelling detail/ })).toBeNull();
    const order = sectionOrder(container);
    const columns = order.findIndex((t) => /^Columns/.test(t));
    const designRationale = order.findIndex((t) => /Design Rationale/i.test(t));
    expect(designRationale).toBeGreaterThan(-1);
    expect(designRationale).toBeLessThan(columns);
  });

  it('hasModellingDetail: a blank grain or an empty meta is nothing', () => {
    expect(hasModellingDetail({})).toBe(false);
    expect(hasModellingDetail({ grain: '   ', meta: {} })).toBe(false);
    expect(hasModellingDetail({ grain: 'x' })).toBe(true);
  });
});
