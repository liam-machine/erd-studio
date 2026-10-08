// @vitest-environment jsdom
/**
 * A self-reference (employee.manager_id → employee.employee_id) is one
 * relationship of its model: listed once, counted once (#133 L3).
 */
import { describe, it, expect } from 'vitest';
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
