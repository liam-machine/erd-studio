// @vitest-environment jsdom
/**
 * StatusBar — the diagram's counts and its layer key, shared by the
 * extension's editor and the viewer (moved here from the webview, unchanged).
 *
 *  - A composite foreign key is one line on the canvas, so one relationship,
 *    however many column pairs it has.
 *  - The layer key names each layer as the table badges do: "[GLD] Gold 4".
 *  - A single-layer project has no key.
 *  - It is always one line: short of room it drops the layer names, then
 *    folds layers into "+N", then drops the key, keeping the two counts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useLayoutEffect } from 'react';
import { cleanup, render } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
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

/** Set React Flow's pane size, as the canvas measures it. */
function SizeTo({ width, height }: { width: number; height: number }) {
  const api = useStoreApi();
  useLayoutEffect(() => { api.setState({ width, height }); }, [api, width, height]);
  return null;
}

function renderSized(domain: Record<string, unknown>, width: number, height: number, viewer = true, legendOpen = false) {
  const store = createCanvasStore({ domain: domainOf(domain), legendOpen });
  return render(
    <CanvasStoreProvider store={store}>
      <CanvasEnvironmentProvider host={NOOP_CANVAS_HOST} viewer={viewer}>
        <ReactFlowProvider><SizeTo width={width} height={height} /><StatusBar /></ReactFlowProvider>
      </CanvasEnvironmentProvider>
    </CanvasStoreProvider>,
  );
}

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

describe('StatusBar — one line at every size', () => {
  const BRONZE = { id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', order: 0, creatable: true };
  const threeLayers = {
    layerConfigs: [BRONZE, SILVER, GOLD],
    models: [
      { name: 'a', layer: 'gold' }, { name: 'b', layer: 'silver' }, { name: 'c', layer: 'silver' }, { name: 'd', layer: 'bronze' },
    ],
  };
  const bar = (c: HTMLElement) => c.querySelector<HTMLElement>('.status-bar')!;

  it('a wide canvas: counts and every layer with its name', () => {
    const { container } = renderSized(threeLayers, 1600, 900);
    expect(bar(container).getAttribute('data-fit')).toBe('full');
    expect([...container.querySelectorAll('.status-bar__layer')].map((i) => i.textContent)).toEqual(['GLDGold 1', 'BRZBronze 1', 'SLVSilver 2']);
    expect(bar(container).style.maxWidth).not.toBe('');
  });

  it('a short embedded frame (760 × 380): the counts and the whole layer key, on one line', () => {
    const { container } = renderSized(threeLayers, 760, 380);
    expect(bar(container).getAttribute('data-fit')).toBe('full');
    expect(container.querySelectorAll('.status-bar__layer')).toHaveLength(3);
  });

  it('a little narrower: the names go, each badge and count stays, and the tooltips name them', () => {
    const { container } = renderSized(threeLayers, 640, 380);
    expect(bar(container).getAttribute('data-fit')).toBe('badges');
    const chips = [...container.querySelectorAll('.status-bar__layer')];
    expect(chips.map((c) => c.textContent)).toEqual(['GLD1', 'BRZ1', 'SLV2']);
    expect(chips[0].getAttribute('title')).toBe('Gold (GLD): 1 table');
    expect(bar(container).getAttribute('title')).toContain('Silver (SLV): 2 tables');
    expect([...container.querySelectorAll('.status-bar__item')].map((i) => i.textContent)).toEqual(['4 tables', '0 relationships']);
  });

  it('narrower: layers fold into "+N", then go, the two counts always kept', () => {
    const some = renderSized(threeLayers, 480, 600);
    expect(bar(some.container).getAttribute('data-fit')).toBe('some');
    expect(some.container.querySelectorAll('.status-bar__layer')).toHaveLength(1);
    const more = some.container.querySelector('.status-bar__more')!;
    expect(more.textContent).toBe('+2');
    expect(more.getAttribute('title')).toBe('Bronze (BRZ): 1 table\nSilver (SLV): 2 tables');
    cleanup();
    const counts = renderSized(threeLayers, 330, 600);
    expect(bar(counts.container).getAttribute('data-fit')).toBe('counts');
    expect(counts.container.querySelector('.status-bar__layers')).toBeNull();
    expect(counts.container.querySelectorAll('.status-bar__item')).toHaveLength(2);
  });

  it('as a last resort it truncates (still one line); beside the viewer\'s open legend it steps aside', () => {
    const { container } = renderSized(threeLayers, 180, 600);
    expect(bar(container).getAttribute('data-fit')).toBe('truncate');
    cleanup();
    const beside = renderSized(threeLayers, 520, 600, true, true);
    expect(beside.container.querySelector('.status-bar')).toBeNull();
  });

  it('the editor clears its open detail panel too', () => {
    const store = createCanvasStore({
      domain: domainOf({ ...threeLayers, models: threeLayers.models }),
      selectedNode: 'a', detailPanelOpen: true,
    });
    const { container } = render(
      <CanvasStoreProvider store={store}>
        <ReactFlowProvider><SizeTo width={900} height={700} /><StatusBar /></ReactFlowProvider>
      </CanvasStoreProvider>,
    );
    // 900 − the ? button − the 340px panel: no room for the layer names.
    expect(bar(container).getAttribute('data-fit')).not.toBe('full');
    expect(parseInt(bar(container).style.maxWidth, 10)).toBeLessThanOrEqual(900 - 53 - 15 - 340 - 10);
  });

  it('its stylesheet never wraps', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, '../../src/components/StatusBar/StatusBar.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (sel: string) => css.match(new RegExp(`(?:^|\\})\\s*${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('.status-bar')).toMatch(/flex-wrap:\s*nowrap/);
    expect(rule('.status-bar')).toMatch(/white-space:\s*nowrap/);
    expect(rule('.status-bar')).toMatch(/overflow:\s*hidden/);
    expect(css).not.toMatch(/flex-wrap:\s*wrap/);
    expect(css).not.toMatch(/flex-direction:\s*column/);
  });
});
