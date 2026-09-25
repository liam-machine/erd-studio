// @vitest-environment jsdom
/**
 * With a store but no CanvasEnvironmentProvider, the shared components render
 * exactly as the VS Code extension shows them: every editing affordance is
 * present — even on a read-only (physical-stage) domain, where upstream keeps
 * the relationship rows clickable and the key-badge menus open.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { DisplayDomain } from '@erd-studio/core';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { DetailPanel } from '../../src/components/DetailPanel/DetailPanel';

function domain(readOnly: boolean): DisplayDomain {
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
  const store = createCanvasStore({ domain: domain(readOnly), selectedNode: 'orders', detailPanelOpen: true });
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

      it('offers "+ Add Rationale" for a model without one', () => {
        renderPanel(readOnly);
        expect(screen.getByText('+ Add Rationale')).toBeTruthy();
      });
    });
  }
});
