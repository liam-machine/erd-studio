// @vitest-environment jsdom
/**
 * The detail panel's "Remove from Diagram" confirmation says what really
 * happens: in a DBML diagram (or any diagram whose relationships are in the
 * Table Library) the table and its relationships stay; only a diagram file
 * that holds relationships itself loses them with the table. The role picker
 * is the "Table role" field, with plain names for the gold roles (keys
 * unchanged).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { TABLE_ROLE_VALUES } from '@erd-studio/core';
import type { DisplaySubjectArea } from '@erd-studio/core';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { DetailPanel, removeConfirmText } from '../../src/components/DetailPanel/DetailPanel';
import { ROLE_OPTIONS } from '../../src/lib/roleOptions';

const col = (name: string, isPrimaryKey = false) => ({ name, dataType: 'bigint', description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });
const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' as const };

function domainWith(extra: Partial<DisplaySubjectArea>, relationships: DisplaySubjectArea['relationships'] = [rel]): DisplaySubjectArea {
  return {
    schemaVersion: 5, domain: 'sales', layer: 'gold', stage: 'logical', description: '', viewConfig: {}, readOnly: false, positionDraggable: true,
    models: [
      { name: 'fct_order', schema: '', description: '', columns: [col('order_key', true), col('customer_key')] },
      { name: 'dim_customer', schema: '', description: '', columns: [col('customer_key', true)] },
    ],
    relationships,
    ...extra,
  } as DisplaySubjectArea;
}

function openConfirm(domain: DisplaySubjectArea): string {
  const store = createCanvasStore({ domain, selectedNode: 'fct_order', detailPanelOpen: true });
  render(<CanvasStoreProvider store={store}><ReactFlowProvider><DetailPanel /></ReactFlowProvider></CanvasStoreProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Remove this table from this diagram' }));
  return document.querySelector('.detail-panel__confirm-label')?.textContent ?? '';
}

afterEach(cleanup);

describe('removeConfirmText', () => {
  it('a diagram whose relationships are all in the Table Library keeps them', () => {
    expect(removeConfirmText('fct_order', false, [{}], [{}])).toBe(
      'Remove fct_order from this diagram? The table and its relationships stay in the Table Library.',
    );
  });

  it('counts only the relationships the diagram file holds itself', () => {
    expect(removeConfirmText('fct_order', true, [{ inDiagramFile: true }, {}], [{ inDiagramFile: true }])).toBe(
      'Remove fct_order from this diagram? Its 2 relationships in this diagram file will also be removed.',
    );
    expect(removeConfirmText('fct_order', true, [{ inDiagramFile: true }], [])).toBe(
      'Remove fct_order from this diagram? Its 1 relationship in this diagram file will also be removed.',
    );
    expect(removeConfirmText('fct_order', true, [{}], [])).toBe('Remove fct_order from this diagram?');
  });

  it('an older core (no flag) keeps the cautious warning, counting every relationship', () => {
    expect(removeConfirmText('fct_order', undefined, [{}], [{}])).toBe(
      'Remove fct_order from this diagram? Its 2 relationships in this diagram file will also be removed.',
    );
  });
});

describe('DetailPanel — Remove from Diagram', () => {
  it('says "diagram", never "subject area"', () => {
    const store = createCanvasStore({ domain: domainWith({ relationshipsInDiagramFile: false }), selectedNode: 'fct_order', detailPanelOpen: true });
    const { container } = render(<CanvasStoreProvider store={store}><ReactFlowProvider><DetailPanel /></ReactFlowProvider></CanvasStoreProvider>);
    expect(screen.getByRole('button', { name: 'Remove this table from this diagram' }).textContent).toBe('Remove from Diagram');
    expect(container.textContent).not.toMatch(/subject area/i);
  });

  it('a DBML diagram does not claim its relationships are removed', () => {
    expect(openConfirm(domainWith({ relationshipsInDiagramFile: false }))).toBe(
      'Remove fct_order from this diagram? The table and its relationships stay in the Table Library.',
    );
  });

  it('a JSON diagram holding the relationship itself warns that it goes too', () => {
    expect(openConfirm(domainWith({ relationshipsInDiagramFile: true }, [{ ...rel, inDiagramFile: true }]))).toBe(
      'Remove fct_order from this diagram? Its 1 relationship in this diagram file will also be removed.',
    );
  });
});

describe('Table role picker', () => {
  it('is labelled "Table role" and names the gold roles plainly, keeping their keys', () => {
    const store = createCanvasStore({ domain: domainWith({}), selectedNode: 'fct_order', detailPanelOpen: true });
    render(<CanvasStoreProvider store={store}><ReactFlowProvider><DetailPanel /></ReactFlowProvider></CanvasStoreProvider>);
    // No type set yet: it sits under the folded "Modelling detail (optional)".
    fireEvent.click(screen.getByRole('button', { name: /Modelling detail/ }));
    const select = screen.getByRole('combobox', { name: 'Table role' }) as HTMLSelectElement;
    const options = [...select.options].map((o) => [o.value, o.textContent]);
    expect(options).toContainEqual(['gold-fact', 'Pre-joined fact']);
    expect(options).toContainEqual(['gold-dim', 'Flattened dimension']);
    expect(options).toContainEqual(['domain-dim', 'Local dimension']);
    expect(ROLE_OPTIONS.map((o) => o.label).join(' ')).not.toMatch(/\bGold\b|\bDomain\b/);
  });

  it('offers the roles in core\'s order (the role field\'s choices)', () => {
    expect(ROLE_OPTIONS.map((o) => o.value)).toEqual([...TABLE_ROLE_VALUES]);
  });
});
