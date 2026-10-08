// @vitest-environment jsdom
/**
 * A self-reference (employee.manager_id → employee.employee_id) is one
 * relationship of its model: listed once, counted once (#133 L3).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { DisplayDomain } from '@erd-studio/core';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { DetailPanel } from '../../src/components/DetailPanel/DetailPanel';

const col = (name: string, isPrimaryKey = false) => ({ name, dataType: 'bigint', description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });

describe('DetailPanel — self-reference (#133 L3)', () => {
  it('lists a self-reference once, under outgoing, marked ↻, and counts it once', () => {
    const domain = {
      schemaVersion: 5, domain: 'hr', layer: 'silver', stage: 'logical', description: '', viewConfig: {}, readOnly: false, positionDraggable: true,
      models: [{ name: 'employee', schema: '', description: '', columns: [col('employee_id', true), col('manager_id')] }],
      relationships: [{ fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id', cardinality: 'many-to-one' }],
    } as DisplayDomain;
    const store = createCanvasStore({ domain, selectedNode: 'employee', detailPanelOpen: true });
    const { container } = render(<CanvasStoreProvider store={store}><ReactFlowProvider><DetailPanel /></ReactFlowProvider></CanvasStoreProvider>);
    expect(container.querySelectorAll('.detail-panel__relationship')).toHaveLength(1);
    expect(screen.getByText('Relationships (1)')).toBeTruthy();
    expect(container.querySelector('.detail-panel__rel-direction')?.textContent?.trim()).toBe('↻');
  });
});

describe('DetailPanel — composite foreign key (#133 L2)', () => {
  it('lists a composite as one row naming every pair, which opens the menu and deletes by its first pair', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const member = (fromColumn: string, toColumn: string) =>
      ({ fromModel: 'pit_customer', fromColumn, toModel: 'sat_customer', toColumn, cardinality: 'many-to-one' as const, compositeKey: 'fk_sat_customer' });
    const domain = {
      schemaVersion: 5, domain: 'dv', layer: 'silver', stage: 'logical', description: '', viewConfig: {}, readOnly: false, positionDraggable: true,
      models: [
        { name: 'pit_customer', schema: '', description: '', columns: [col('customer_hk'), col('as_of_date')] },
        { name: 'sat_customer', schema: '', description: '', columns: [col('customer_hk', true), col('load_date', true)] },
      ],
      relationships: [member('customer_hk', 'customer_hk'), member('as_of_date', 'load_date')],
    } as DisplayDomain;
    const store = createCanvasStore({ domain, selectedNode: 'pit_customer', detailPanelOpen: true });
    const postMessage = vi.fn();
    const { CanvasEnvironmentProvider } = await import('../../src/host/canvasEnvironment');
    const { container } = render(
      <CanvasEnvironmentProvider host={{ postMessage }}>
        <CanvasStoreProvider store={store}><ReactFlowProvider><DetailPanel /></ReactFlowProvider></CanvasStoreProvider>
      </CanvasEnvironmentProvider>,
    );
    const rows = container.querySelectorAll('.detail-panel__relationship');
    expect(rows).toHaveLength(1);
    expect(screen.getByText('Relationships (1)')).toBeTruthy();
    expect(rows[0].textContent).toContain('(customer_hk, as_of_date)');
    expect(rows[0].textContent).toContain('sat_customer.(customer_hk, load_date)');

    fireEvent.click(rows[0], { clientX: 5, clientY: 6 });
    const menu = store.getState().contextMenu as { data: { pairs?: unknown[]; fromColumn: string } };
    expect(menu.data).toMatchObject({ fromColumn: 'customer_hk', compositeKey: 'fk_sat_customer' });
    expect(menu.data.pairs).toHaveLength(2);

    fireEvent.click(container.querySelector('.detail-panel__rel-delete')!);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'removeRelationship',
      payload: { fromModel: 'pit_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk' },
    });
  });
});
