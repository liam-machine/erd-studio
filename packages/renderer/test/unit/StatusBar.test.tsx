// @vitest-environment jsdom
/**
 * StatusBar — the diagram's counts and its layer key, shared by the
 * extension's editor and the viewer (moved here from the webview, unchanged).
 *
 *  - A composite foreign key is one line on the canvas, so one relationship,
 *    however many column pairs it has.
 *  - The layer key names each layer as the table badges do: "[GLD] Gold 4".
 *  - A single-layer project has no key.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { DisplaySubjectArea } from '@erd-studio/core';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { CanvasEnvironmentProvider, NOOP_CANVAS_HOST } from '../../src/host/canvasEnvironment';
import { StatusBar, statusBarStats } from '../../src/components/StatusBar/StatusBar';

const GOLD = { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', order: 2, creatable: true };
const SILVER = { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', order: 1, creatable: true };

function rel(fromColumn: string, toColumn: string, extra: Record<string, unknown> = {}) {
  return { fromModel: 'fct_order', fromColumn, toModel: 'dim_customer', toColumn, cardinality: 'many-to-one', ...extra };
}

function domainOf(domain: Record<string, unknown>): DisplaySubjectArea {
  return { layer: 'gold', models: [], relationships: [], ...domain } as unknown as DisplaySubjectArea;
}

function renderBar(domain: Record<string, unknown>) {
  const store = createCanvasStore({ domain: domainOf(domain) });
  return render(
    <CanvasStoreProvider store={store}>
      <ReactFlowProvider><StatusBar /></ReactFlowProvider>
    </CanvasStoreProvider>,
  );
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
      models: [{ name: 'fct_order' }, { name: 'dim_customer' }],
      relationships: [
        rel('a1', 'a1', { compositeKey: 'a' }),
        rel('a2', 'a2', { compositeKey: 'a' }),
        rel('b1', 'b1', { compositeKey: 'b' }),
        rel('b2', 'b2', { compositeKey: 'b' }),
      ],
    });
    expect(container.textContent).toContain('2 relationships');
  });

  it('says "1 relationship" and "1 table" for one', () => {
    const { container } = renderBar({
      models: [{ name: 'fct_order' }],
      relationships: [{ fromModel: 'fct_order', fromColumn: 'parent_id', toModel: 'fct_order', toColumn: 'order_id', cardinality: 'many-to-one' }],
    });
    expect(container.textContent).toContain('1 relationship');
    expect(container.textContent).not.toContain('1 relationships');
    expect(container.textContent).toContain('1 table');
    expect(container.textContent).not.toContain('1 tables');
  });

  it('renders the bar the editor always had: items, dividers, a bottom-left panel', () => {
    const { container } = renderBar({ models: [{ name: 'a' }, { name: 'b' }], relationships: [] });
    const bar = container.querySelector('.status-bar')!;
    expect(bar.classList.contains('react-flow__panel')).toBe(true);
    expect(bar.classList.contains('bottom')).toBe(true);
    expect(bar.classList.contains('left')).toBe(true);
    // The counts are one group (so they never wrap apart); inside it, the
    // items and divider the editor always had.
    expect([...bar.children].map((c) => c.className)).toEqual(['status-bar__counts']);
    expect([...bar.querySelector('.status-bar__counts')!.children].map((c) => `${c.className}:${c.textContent}`)).toEqual([
      'status-bar__item:2 tables',
      'status-bar__divider:|',
      'status-bar__item:0 relationships',
    ]);
  });

  it('does not count a relationship whose other end is not on the diagram, as the canvas does not draw it', async () => {
    const { transformSubjectArea } = await import('../../src/lib/graphTransformer');
    const domain = domainOf({
      stage: 'logical',
      viewConfig: { positions: {} },
      models: [{ name: 'a', columns: [] }, { name: 'b', columns: [] }],
      relationships: [
        { fromModel: 'a', fromColumn: 'b_id', toModel: 'b', toColumn: 'b_id', cardinality: 'many-to-one' },
        { fromModel: 'a', fromColumn: 'gone_id', toModel: 'gone', toColumn: 'gone_id', cardinality: 'many-to-one' },
      ],
    });
    const stats = statusBarStats(domain);
    expect(stats.relationships).toBe(1);
    const drawn = transformSubjectArea(domain).edges.filter((e) => e.type === 'fk').length;
    expect(stats.relationships).toBe(drawn);
  });
});

describe('StatusBar placement', () => {
  function renderIn(viewer: boolean, legendOpen: boolean) {
    const store = createCanvasStore({ domain: domainOf({ models: [{ name: 'a' }] }), legendOpen });
    return render(
      <CanvasStoreProvider store={store}>
        <CanvasEnvironmentProvider host={NOOP_CANVAS_HOST} viewer={viewer}>
          <ReactFlowProvider><StatusBar /></ReactFlowProvider>
        </CanvasEnvironmentProvider>
      </CanvasStoreProvider>,
    );
  }
  const classes = (container: HTMLElement) =>
    [...container.querySelector('.status-bar')!.classList].filter((c) => c.startsWith('status-bar'));

  it('the editor: the one class it always had, legend open or not', () => {
    expect(classes(renderIn(false, false).container)).toEqual(['status-bar']);
    cleanup();
    expect(classes(renderIn(false, true).container)).toEqual(['status-bar']);
  });

  it('the viewer: clear of the legend button, and beside the legend while it is open', () => {
    expect(classes(renderIn(true, false).container)).toEqual(['status-bar', 'status-bar--viewer']);
    cleanup();
    expect(classes(renderIn(true, true).container)).toEqual(['status-bar', 'status-bar--viewer', 'status-bar--beside-legend']);
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

describe('statusBarStats', () => {
  it('orders the diagram\'s own layer first, then layers.json order, then by name', () => {
    const stats = statusBarStats(domainOf({
      layer: 'gold',
      layerConfigs: [SILVER, GOLD],
      models: [{ name: 'x', layer: 'zeta' }, { name: 'a', layer: 'silver' }, { name: 'b', layer: 'gold' }, { name: 'y', layer: 'alpha' }],
    }));
    expect(stats.layers.map((l) => l.id)).toEqual(['gold', 'silver', 'alpha', 'zeta']);
    expect(stats.tables).toBe(4);
    expect(stats.relationships).toBe(0);
  });

  it('copes with a partial domain (no models or relationships)', () => {
    expect(statusBarStats({ layer: 'gold' } as unknown as DisplaySubjectArea)).toEqual({ tables: 0, relationships: 0, layers: [] });
  });
});

describe('StatusBar.css', () => {
  it('uses theme tokens only, and is part of the package stylesheet', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, '../../src/components/StatusBar/StatusBar.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i);
    expect(css).not.toMatch(/--vscode-/);
    expect(readFileSync(join(__dirname, '../../src/styles.css'), 'utf8')).toContain("@import './components/StatusBar/StatusBar.css';");
  });
});
