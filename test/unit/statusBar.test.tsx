// @vitest-environment jsdom
/**
 * StatusBar — the diagram's counts and its layer key.
 *
 *  - A composite foreign key is one line on the canvas, so one relationship,
 *    however many column pairs it has.
 *  - The layer key names each layer as the table badges do: "[GLD] Gold 4".
 *  - A single-layer project has no key.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  Panel: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
}));

const mockStoreState: Record<string, unknown> = {};
vi.mock('../../webview/store/editorStore', () => ({
  useEditorStore: (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

import { StatusBar } from '../../webview/components/Toolbar/StatusBar';

const GOLD = { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', order: 2, creatable: true };
const SILVER = { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', order: 1, creatable: true };

function rel(fromColumn: string, toColumn: string, extra: Record<string, unknown> = {}) {
  return { fromModel: 'fct_order', fromColumn, toModel: 'dim_customer', toColumn, cardinality: 'many-to-one', ...extra };
}

function renderBar(domain: Record<string, unknown>) {
  mockStoreState.domain = { layer: 'gold', models: [], relationships: [], ...domain };
  return render(<StatusBar />);
}

afterEach(cleanup);

describe('StatusBar relationship count', () => {
  it('counts a composite foreign key once, as the one line the canvas draws', () => {
    const { container } = renderBar({
      models: [{ name: 'fct_order' }, { name: 'dim_customer' }],
      relationships: [
        rel('customer_id', 'customer_id', { compositeKey: 'customer' }),
        rel('region_id', 'region_id', { compositeKey: 'customer' }),
        rel('ship_customer_id', 'customer_id'),
      ],
    });
    expect(container.textContent).toContain('2 tables');
    expect(container.textContent).toContain('2 relationships');
  });

  it('keeps two composites between the same tables apart', () => {
    const { container } = renderBar({
      relationships: [
        rel('a1', 'a1', { compositeKey: 'a' }),
        rel('a2', 'a2', { compositeKey: 'a' }),
        rel('b1', 'b1', { compositeKey: 'b' }),
        rel('b2', 'b2', { compositeKey: 'b' }),
      ],
    });
    expect(container.textContent).toContain('2 relationships');
  });

  it('says "1 relationship" for one', () => {
    const { container } = renderBar({ relationships: [rel('customer_id', 'customer_id')] });
    expect(container.textContent).toContain('1 relationship');
    expect(container.textContent).not.toContain('1 relationships');
  });
});

describe('StatusBar layer key', () => {
  it('names each layer with its badge then its label: "[GLD] Gold 2  [SLV] Silver 1"', () => {
    const { container } = renderBar({
      layerConfigs: [SILVER, GOLD],
      models: [{ name: 'a', layer: 'gold' }, { name: 'b', layer: 'gold' }, { name: 'c', layer: 'silver' }],
    });
    const items = [...container.querySelectorAll('.status-bar__layer')];
    expect(items.map((i) => i.textContent)).toEqual(['GLDGold 2', 'SLVSilver 1']);
    const badge = items[0].querySelector('.status-bar__badge') as HTMLElement;
    expect(badge.textContent).toBe('GLD');
    expect(badge.style.color).not.toBe('');
  });

  it('is left off in a single-layer project', () => {
    const { container } = renderBar({ layerConfigs: [GOLD], models: [{ name: 'a', layer: 'gold' }] });
    expect(container.querySelector('.status-bar__layers')).toBeNull();
  });
});
