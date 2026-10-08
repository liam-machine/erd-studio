// @vitest-environment jsdom
/**
 * The New Relationship dialog warns, but still allows "Create anyway", when a
 * many-to-one would make a model's whole key the many side (#133, keys win).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

const postMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage, getState: vi.fn(), setState: vi.fn() }),
  getVsCodeApi: () => ({ postMessage, getState: vi.fn(), setState: vi.fn() }),
}));
vi.mock('@xyflow/react', () => ({ Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { NewFkDialog } from '../../webview/components/NewFkDialog/NewFkDialog';
import { useEditorStore } from '../../webview/store/editorStore';

const col = (name: string, isPrimaryKey = false) => ({ name, dataType: 'string', description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });

afterEach(cleanup);

describe('NewFkDialog keys-win warning', () => {
  it('warns about a dimension key as the many side and offers Create anyway, which still sends the add', () => {
    useEditorStore.setState({
      domain: {
        schemaVersion: 5, domain: 'd', layer: 'silver', stage: 'logical', description: '', readOnly: false, viewConfig: {},
        models: [
          { name: 'dim_customer', columns: [col('customer_key', true)] },
          { name: 'fct_order', columns: [col('order_key', true), col('customer_key')] },
        ],
        relationships: [],
      } as never,
    });
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' });
    render(<NewFkDialog />);
    expect(screen.getByRole('alert').textContent).toContain("dim_customer.customer_key is dim_customer's key");
    fireEvent.click(screen.getByText('Create anyway'));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'addRelationship', payload: expect.objectContaining({ fromModel: 'dim_customer', cardinality: 'many-to-one' }),
    }));
  });
});
