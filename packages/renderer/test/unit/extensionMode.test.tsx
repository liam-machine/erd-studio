// @vitest-environment jsdom
/**
 * With a store but no CanvasEnvironmentProvider, the shared components render
 * exactly as the VS Code extension shows them: every editing affordance is
 * present — even on a read-only (physical-stage) domain, where upstream keeps
 * the relationship rows clickable and the key-badge menus open. The table's
 * Fields are the exception: a read-only domain shows only the fields that
 * have a value, with nothing to edit (the host rejects a physical edit).
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { DisplaySubjectArea } from '@erd-studio/core';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { DetailPanel } from '../../src/components/DetailPanel/DetailPanel';

function subjectArea(readOnly: boolean): DisplaySubjectArea {
  return {
    schemaVersion: 5,
    domain: 'sales',
    layer: 'silver',
    stage: readOnly ? 'physical' : 'logical',
    description: '',
    models: [
      {
        name: 'orders',
        schema: 'sales',
        description: 'One row per order',
        columns: [
          { name: 'order_id', dataType: 'bigint', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false },
          { name: 'customer_id', dataType: 'bigint', description: '', isPrimaryKey: false, isForeignKey: true, isNaturalKey: false },
        ],
      },
      {
        name: 'customers',
        schema: 'sales',
        description: '',
        columns: [
          { name: 'customer_id', dataType: 'bigint', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false },
        ],
      },
    ],
    relationships: [
      { fromModel: 'orders', fromColumn: 'customer_id', toModel: 'customers', toColumn: 'customer_id', cardinality: 'many-to-one' },
    ],
    viewConfig: {},
    readOnly,
    positionDraggable: true,
  };
}

function renderPanel(readOnly: boolean) {
  const store = createCanvasStore({ domain: subjectArea(readOnly), selectedNode: 'orders', detailPanelOpen: true });
  return render(
    <CanvasStoreProvider store={store}>
      <ReactFlowProvider>
        <DetailPanel />
      </ReactFlowProvider>
    </CanvasStoreProvider>,
  );
}

describe('shared components outside a CanvasEnvironmentProvider', () => {
  for (const readOnly of [false, true]) {
    describe(readOnly ? 'read-only domain' : 'editable domain', () => {
      it('renders relationship rows as clickable buttons', () => {
        const { container } = renderPanel(readOnly);
        const rows = container.querySelectorAll('.detail-panel__relationship--clickable');
        expect(rows).toHaveLength(1);
        expect(rows[0].getAttribute('role')).toBe('button');
        expect(rows[0].getAttribute('title')).toBe('Click to edit cardinality');
      });

      it('shows the key-badge menu arrow on every column', () => {
        const { container } = renderPanel(readOnly);
        const arrows = container.querySelectorAll('.key-badge-group__arrow');
        expect(arrows).toHaveLength(2);
        for (const arrow of arrows) {
          expect(arrow.getAttribute('aria-hidden')).toBeNull();
          expect((arrow as HTMLElement).style.visibility).toBe('');
        }
      });

    });
  }

  it('editable domain: offers the empty fields and "+ Add field" under "Modelling detail (optional)"', () => {
    renderPanel(false);
    // Folded while none of its fields has a value; one click opens it.
    expect(screen.queryByLabelText('Add Purpose')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Modelling detail/ }));
    expect(screen.getByLabelText('Add Purpose')).toBeTruthy();
    expect(screen.getByText('+ Add field')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Customise fields' })).toBeTruthy();
  });

  it('read-only domain: no Fields to add, and no fold for a table with no field value', () => {
    const { container } = renderPanel(true);
    expect(screen.queryByRole('button', { name: /Modelling detail/ })).toBeNull();
    expect(container.querySelector('.fields-section')).toBeNull();
    expect(container.textContent).not.toContain('+ Add field');
  });
});
