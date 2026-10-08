// @vitest-environment jsdom
/**
 * The detail panel's relationship rows (#133): the hover text names the file
 * the relationship is stored in, the × sends the stored ends, a row spelt in
 * other case still belongs to the model, and the viewer's rows stay plain.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { DisplayDomain, DisplayRelationship } from '@erd-studio/core';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { CanvasEnvironmentProvider, type CanvasHost } from '../../src/host/canvasEnvironment';
import { DetailPanel } from '../../src/components/DetailPanel/DetailPanel';

afterEach(cleanup);

const STORED = { fromModel: 'orders', fromColumn: 'customer_id', toModel: 'customers', toColumn: 'customer_id' };

function domain(relationships: DisplayRelationship[]): DisplayDomain {
  return {
    schemaVersion: 5, domain: 'sales', layer: 'silver', stage: 'logical', description: '',
    models: [
      { name: 'orders', schema: 'sales', description: '', columns: [
        { name: 'order_id', dataType: 'bigint', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false },
        { name: 'customer_id', dataType: 'bigint', description: '', isPrimaryKey: false, isForeignKey: true, isNaturalKey: false },
      ] },
      { name: 'customers', schema: 'sales', description: '', columns: [
        { name: 'customer_id', dataType: 'bigint', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false },
      ] },
    ],
    relationships, viewConfig: {}, readOnly: false, positionDraggable: true,
  };
}

function renderPanel(relationships: DisplayRelationship[], opts: { viewer?: boolean } = {}) {
  const host: CanvasHost = { postMessage: vi.fn() };
  const store = createCanvasStore({ domain: domain(relationships), selectedNode: 'orders', detailPanelOpen: true });
  const view = render(
    <CanvasEnvironmentProvider host={host} viewer={opts.viewer ?? false}>
      <CanvasStoreProvider store={store}>
        <ReactFlowProvider>
          <DetailPanel />
        </ReactFlowProvider>
      </CanvasStoreProvider>
    </CanvasEnvironmentProvider>,
  );
  return { ...view, host, store };
}

const LIBRARY_REL: DisplayRelationship = {
  ...STORED, cardinality: 'many-to-one', stored: STORED, source: { kind: 'library', model: 'orders', index: 0 },
};

describe('DetailPanel relationship rows (#133)', () => {
  it('says which model file stores the relationship', () => {
    const { container } = renderPanel([LIBRARY_REL]);
    const row = container.querySelector('.detail-panel__relationship--clickable')!;
    expect(row.getAttribute('title')).toBe('Click to edit cardinality\nStored in orders.yml (model library)');
  });

  it('says when the diagram file stores it', () => {
    const { container } = renderPanel([{ ...LIBRARY_REL, source: { kind: 'domain', index: 0 } }]);
    expect(container.querySelector('.detail-panel__relationship--clickable')!.getAttribute('title'))
      .toBe('Click to edit cardinality\nStored in silver/sales.json (this diagram)');
  });

  it('× removes with the stored ends', () => {
    const { container, host } = renderPanel([LIBRARY_REL]);
    fireEvent.click(container.querySelector('.detail-panel__rel-delete')!);
    expect(host.postMessage).toHaveBeenCalledWith({ type: 'removeRelationship', payload: { ...STORED, stored: STORED } });
  });

  it('a click opens the edge menu with the stored ends and provenance', () => {
    const { container, store } = renderPanel([{ ...LIBRARY_REL, issues: ['REL001'] }]);
    fireEvent.click(container.querySelector('.detail-panel__relationship--clickable')!);
    const menu = store.getState().contextMenu;
    expect(menu?.type).toBe('edge');
    expect(menu && menu.type === 'edge' ? menu.data : null).toMatchObject({
      stored: STORED, source: { kind: 'library', model: 'orders', index: 0 }, issues: ['REL001'],
    });
  });

  it('lists a relationship whose model name differs only in case', () => {
    const { container } = renderPanel([{ ...LIBRARY_REL, fromModel: 'ORDERS' }]);
    expect(container.querySelectorAll('.detail-panel__relationship')).toHaveLength(1);
  });

  it('never lists another model\'s relationships under a model whose name differs only in case', () => {
    const host: CanvasHost = { postMessage: vi.fn() };
    const d = domain([
      { ...LIBRARY_REL },
      { fromModel: 'Orders', fromColumn: 'customer_id', toModel: 'customers', toColumn: 'customer_id', cardinality: 'many-to-one' },
    ]);
    d.models.push({ ...d.models[0], name: 'Orders' });
    const store = createCanvasStore({ domain: d, selectedNode: 'Orders', detailPanelOpen: true });
    const { container } = render(
      <CanvasEnvironmentProvider host={host} viewer={false}>
        <CanvasStoreProvider store={store}>
          <ReactFlowProvider>
            <DetailPanel />
          </ReactFlowProvider>
        </CanvasStoreProvider>
      </CanvasEnvironmentProvider>,
    );
    // Only Orders' own relationship: orders' is drawn on the orders node.
    expect(container.querySelectorAll('.detail-panel__relationship')).toHaveLength(1);
  });

  it('the viewer keeps plain rows with no hover text, provenance or not', () => {
    const { container } = renderPanel([LIBRARY_REL], { viewer: true });
    const row = container.querySelector('.detail-panel__relationship')!;
    expect(row.getAttribute('title')).toBeNull();
    expect(container.querySelector('.detail-panel__relationship--clickable')).toBeNull();
  });
});

describe('DetailPanel — a relationship whose other end is not in the diagram (#133 review)', () => {
  it('says it is not drawn', () => {
    const gone = { fromModel: 'orders', fromColumn: 'customer_id', toModel: 'gone', toColumn: 'id' };
    const { container } = renderPanel([{ ...gone, cardinality: 'many-to-one', stored: gone, source: { kind: 'domain', index: 0 }, issues: ['REL003'] }]);
    expect(container.querySelector('.detail-panel__relationship--clickable')!.getAttribute('title'))
      .toBe("Not drawn: gone is not one of this diagram's models\nClick to edit cardinality\nStored in silver/sales.json (this diagram)");
  });
});


describe('the FK key toggle acts on the declared flag, not the badge (#133 review 8, D2)', () => {
  it('a column whose FK badge comes only from a drawn relationship is declared on the first click', () => {
    const { container, host } = renderPanel([LIBRARY_REL]);
    // orders' second column, customer_id: the badge is on (it starts a relationship), nothing is declared.
    const triggers = container.querySelectorAll('.key-badge-group__trigger');
    expect(triggers).toHaveLength(2);
    fireEvent.click(triggers[1]);
    const fk = [...document.querySelectorAll('.key-badge-group__option')].find((o) => o.textContent?.includes('FK'))!;
    fireEvent.click(fk);
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'toggleColumnKey', payload: { modelName: 'orders', columnName: 'customer_id', keyType: 'FK', value: true },
    });
  });
});

describe('the FK option ticks what its toggle flips (#133 review 8)', () => {
  const fkOption = (): Element =>
    [...document.querySelectorAll('.key-badge-group__option')].find((o) => o.textContent?.includes('FK'))!;

  it('a badge lit only by a drawn relationship is shown unticked, saying where it comes from', () => {
    const { container } = renderPanel([LIBRARY_REL]);
    // The row still shows the FK badge…
    const triggers = container.querySelectorAll('.key-badge-group__trigger');
    expect(triggers[1].textContent).toContain('FK');
    fireEvent.click(triggers[1]);
    // …but the option the toggle flips (the declared flag) is not ticked, so
    // the first click — which declares it — visibly ticks it.
    expect(fkOption().getAttribute('aria-checked')).toBe('false');
    expect(fkOption().textContent).toContain('Shown because a relationship starts here');
  });

  it('a declared foreign key is ticked, and its click removes it', () => {
    const declared = domain([LIBRARY_REL]);
    declared.models[0].columns[1] = { ...declared.models[0].columns[1], isForeignKeyDeclared: true };
    const host: CanvasHost = { postMessage: vi.fn() };
    const store = createCanvasStore({ domain: declared, selectedNode: 'orders', detailPanelOpen: true });
    const { container } = render(
      <CanvasEnvironmentProvider host={host} viewer={false}>
        <CanvasStoreProvider store={store}>
          <ReactFlowProvider>
            <DetailPanel />
          </ReactFlowProvider>
        </CanvasStoreProvider>
      </CanvasEnvironmentProvider>,
    );
    fireEvent.click(container.querySelectorAll('.key-badge-group__trigger')[1]);
    expect(fkOption().getAttribute('aria-checked')).toBe('true');
    expect(fkOption().textContent).not.toContain('Shown because a relationship starts here');
    fireEvent.click(fkOption());
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'toggleColumnKey', payload: { modelName: 'orders', columnName: 'customer_id', keyType: 'FK', value: false },
    });
  });
});
