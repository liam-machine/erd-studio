// @vitest-environment jsdom
/**
 * ErdCanvas presents the diagram read-only: whatever the domain's `readOnly`
 * flag says, no editing affordance is rendered and no canvas interaction is
 * captured for an edit (right-click and double-click reach the page).
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import type { DisplaySubjectArea } from '@erd-studio/core';
import { ErdCanvas } from '../../src/ErdCanvas';
import { toRenderableSubjectArea } from '../../src/ErdCanvas';
import { NOOP_CANVAS_HOST } from '../../src/host/canvasEnvironment';

beforeAll(() => {
  // React Flow measures nodes with a ResizeObserver, which jsdom lacks.
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;
});

afterEach(cleanup);

function makeSubjectArea(readOnly: boolean): DisplaySubjectArea {
  return {
    schemaVersion: 5,
    domain: 'sales',
    layer: 'silver',
    stage: 'logical',
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
        // Hand-built domains may leave the data type out.
        columns: [
          { name: 'customer_id', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false } as DisplaySubjectArea['models'][number]['columns'][number],
        ],
        rationale: { purpose: 'Who buys', design: '' },
      },
    ],
    relationships: [
      { fromModel: 'orders', fromColumn: 'customer_id', toModel: 'customers', toColumn: 'customer_id', cardinality: 'many-to-one' },
    ],
    viewConfig: {
      positions: { orders: { x: 0, y: 0 }, customers: { x: 600, y: 0 } },
      annotations: [{ id: 'n1', text: 'A note', x: 0, y: 400 }],
    },
    readOnly,
    positionDraggable: true,
  };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

async function renderCanvas(readOnly: boolean) {
  const view = render(
    <div style={{ width: 1200, height: 800 }}>
      <ErdCanvas domain={makeSubjectArea(readOnly)} nodesDraggable />
    </div>,
  );
  await flush();
  return view;
}

function tableNode(container: HTMLElement, name: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`.react-flow__node-model[data-id="${name}"]`);
  if (!node) throw new Error(`model node ${name} not rendered`);
  return node;
}

async function openPanel(container: HTMLElement, name: string): Promise<HTMLElement> {
  fireEvent.click(tableNode(container, name));
  await flush();
  const panel = container.querySelector<HTMLElement>('.detail-panel');
  if (!panel) throw new Error('detail panel did not open');
  return panel;
}

for (const readOnly of [false, true]) {
  describe(`ErdCanvas viewer (domain readOnly: ${readOnly})`, () => {
    it('renders the models, the annotation and a column without a data type', async () => {
      const { container } = await renderCanvas(readOnly);
      expect(container.querySelectorAll('.react-flow__node-model')).toHaveLength(2);
      expect(container.querySelectorAll('.react-flow__node-annotation')).toHaveLength(1);
      expect(tableNode(container, 'customers').textContent).toContain('customer_id');
    });

    it('opens the detail panel on a click, without editing controls', async () => {
      const { container } = await renderCanvas(readOnly);
      const panel = await openPanel(container, 'orders');

      expect(panel.querySelector('.detail-panel__title')!.textContent).toBe('orders');
      expect(panel.querySelector('.detail-panel__title--editable')).toBeNull();
      expect(panel.querySelector('.detail-panel__title-edit-btn')).toBeNull();
      expect(panel.textContent).not.toContain('Remove from Diagram');
      expect(panel.textContent).not.toContain('+ Add Column');
      expect(panel.querySelector('.column-row-editor--editable')).toBeNull();
    });

    it('shows relationship rows as plain rows', async () => {
      const { container } = await renderCanvas(readOnly);
      const panel = await openPanel(container, 'orders');

      const rows = panel.querySelectorAll('.detail-panel__relationship');
      expect(rows).toHaveLength(1);
      expect(panel.querySelector('.detail-panel__relationship--clickable')).toBeNull();
      expect(rows[0].getAttribute('role')).toBeNull();
      expect(rows[0].getAttribute('tabindex')).toBeNull();
      expect(rows[0].getAttribute('title')).toBeNull();
      expect(panel.querySelector('.detail-panel__rel-delete')).toBeNull();
    });

    it('shows readers no ⚠ or Turn round on a relationship drawn backwards (#163)', async () => {
      const domain = makeSubjectArea(readOnly);
      domain.relationships = domain.relationships.map((r) => ({ ...r, keysContradict: true as const }));
      const { container } = render(
        <div style={{ width: 1200, height: 800 }}>
          <ErdCanvas domain={domain} nodesDraggable />
        </div>,
      );
      await flush();
      expect(container.querySelector('.fk-edge__backwards')).toBeNull();
      const panel = await openPanel(container, 'orders');
      expect(panel.querySelector('.detail-panel__rel-backwards')).toBeNull();
      expect(panel.textContent).not.toContain('Turn round');
    });

    it('keeps the key-badge arrows hidden but in place, and the menu closed', async () => {
      const { container } = await renderCanvas(readOnly);
      const panel = await openPanel(container, 'orders');

      const arrows = panel.querySelectorAll<HTMLElement>('.key-badge-group__arrow');
      expect(arrows).toHaveLength(2);
      for (const arrow of arrows) {
        expect(arrow.style.visibility).toBe('hidden');
        expect(arrow.getAttribute('aria-hidden')).toBe('true');
      }
      expect(panel.querySelector('.key-badge-group--editable')).toBeNull();

      fireEvent.click(panel.querySelector('.key-badge-group__trigger')!);
      expect(document.querySelector('.key-badge-group__dropdown')).toBeNull();
    });

    it('omits the Fields section for a model with no field value', async () => {
      const { container } = await renderCanvas(readOnly);
      const panel = await openPanel(container, 'orders');
      expect(panel.textContent).not.toContain('+ Add field');
      expect(panel.querySelector('.fields-section')).toBeNull();
    });

    it('shows only the filled fields, read-only', async () => {
      const { container } = await renderCanvas(readOnly);
      const panel = await openPanel(container, 'customers');

      const section = panel.querySelector('.fields-section')!;
      // Folded to its heading and count until the reader opens it.
      const toggle = section.querySelector<HTMLButtonElement>('.fields-section__toggle')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(section.querySelector('.fields-section__count')!.textContent).toBe('1');
      expect(section.querySelector<HTMLElement>('.fields-section__list')!.hidden).toBe(true);
      fireEvent.click(toggle);
      expect(section.querySelector<HTMLElement>('.fields-section__list')!.hidden).toBe(false);

      const labels = [...section.querySelectorAll('.fields-section__name')].map((h) => h.textContent);
      expect(labels).toEqual(['Purpose']);
      expect(section.textContent).toContain('Who buys');
      expect(panel.textContent).not.toMatch(/\+ Add/);
      expect(panel.textContent).not.toContain('Customise fields');
      expect(section.querySelectorAll('button:not(.fields-section__toggle), input, select, textarea')).toHaveLength(0);

      fireEvent.doubleClick(section.querySelector('.fields-section__row')!);
      expect(panel.querySelector('textarea')).toBeNull();
    });

    it('leaves a right-click on a model to the browser', async () => {
      const { container } = await renderCanvas(readOnly);
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      tableNode(container, 'orders').querySelector('.model-node')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it('lets a double-click on an annotation propagate, and opens no editor', async () => {
      const { container } = await renderCanvas(readOnly);
      const seen = vi.fn();
      document.addEventListener('dblclick', seen);
      try {
        fireEvent.doubleClick(container.querySelector('.annotation-node')!);
        await flush();
        expect(seen).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.annotation-node textarea')).toBeNull();
      } finally {
        document.removeEventListener('dblclick', seen);
      }
    });
  });
}

describe('ErdCanvas onReady', () => {
  it('fires once for a domain with nothing to draw', async () => {
    const onReady = vi.fn();
    const empty: DisplaySubjectArea = { ...makeSubjectArea(true), models: [], relationships: [], viewConfig: {} };
    const { rerender } = render(<ErdCanvas domain={empty} onReady={onReady} />);
    await flush();
    rerender(<ErdCanvas domain={empty} onReady={onReady} />);
    await flush();
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});

describe('ErdCanvas with a domain that has no layer', () => {
  it('draws the model without a layer badge, as there is no layer to name', async () => {
    const { layer: _omitted, ...rest } = makeSubjectArea(true);
    const domain = {
      ...rest,
      models: [{ ...rest.models[0], schema: '' }],
      relationships: [],
      viewConfig: { positions: { orders: { x: 0, y: 0 } } },
    } as unknown as DisplaySubjectArea;
    const { container } = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={domain} />
      </div>,
    );
    await flush();
    const node = tableNode(container, 'orders');
    expect(node).not.toBeNull();
    expect(node.querySelector('.model-node__badge')).toBeNull();
  });
});

describe('toRenderableSubjectArea', () => {
  it('forces readOnly and fills in what a partial domain leaves out', () => {
    const partial = {
      schemaVersion: 5,
      domain: 'bare',
      description: '',
      models: [{ name: 'm', schema: '', description: '' }],
      readOnly: false,
      positionDraggable: false,
    } as unknown as DisplaySubjectArea;

    expect(toRenderableSubjectArea(partial)).toEqual({
      ...partial,
      layer: '',
      stage: 'logical',
      models: [{ name: 'm', schema: '', description: '', columns: [] }],
      relationships: [],
      viewConfig: {},
      readOnly: true,
    });
  });

  it('gives a column without a data type an empty one, leaving other objects alone', () => {
    const domain = makeSubjectArea(true);
    const renderable = toRenderableSubjectArea(domain);
    expect(renderable).not.toBe(domain);
    expect(renderable.models[0]).toBe(domain.models[0]);
    expect(renderable.models[1].columns[0]).toEqual({ ...domain.models[1].columns[0], dataType: '' });
    expect(renderable.relationships).toBe(domain.relationships);
    expect(renderable.viewConfig).toBe(domain.viewConfig);
  });

  it('returns a complete read-only domain unchanged', () => {
    const domain = makeSubjectArea(true);
    domain.models[1].columns[0] = { ...domain.models[1].columns[0], dataType: 'bigint' };
    expect(toRenderableSubjectArea(domain)).toBe(domain);
  });
});

describe('ErdCanvas — hover preview and relationship flow', () => {
  // Edges only render once React Flow has measured their nodes, which needs a
  // ResizeObserver that reports and elements with a size.
  const saved: { ro?: unknown; matrix?: unknown; w?: PropertyDescriptor; h?: PropertyDescriptor } = {};
  beforeAll(() => {
    saved.ro = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    saved.matrix = (window as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly;
    // React Flow reads the zoom from the viewport's transform matrix.
    (window as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= class { m22 = 1; };
    saved.w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    saved.h = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    class MeasuringResizeObserver {
      constructor(private readonly cb: (entries: { target: Element }[], ro: unknown) => void) {}
      observe(target: Element) { setTimeout(() => this.cb([{ target }], this), 0); }
      unobserve() {}
      disconnect() {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = MeasuringResizeObserver;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 240 });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 120 });
  });
  afterAll(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = saved.ro;
    (window as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly = saved.matrix;
    if (saved.w) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', saved.w);
    if (saved.h) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', saved.h);
  });

  const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  for (const readOnly of [false, true]) {
    it(`fades the rest and flows the hovered table's lines, posting nothing (readOnly: ${readOnly})`, async () => {
      const post = vi.spyOn(NOOP_CANVAS_HOST, 'postMessage');
      const { container } = await renderCanvas(readOnly);
      await wait(20);
      const root = container.querySelector('.react-flow')!;
      expect(root.classList.contains('erd-flow')).toBe(true);
      expect(root.classList.contains('erd-flow--hover-focus')).toBe(false);
      expect(container.querySelector('path.fk-edge')).not.toBeNull();

      fireEvent.mouseEnter(tableNode(container, 'customers'));
      await wait(200);

      expect(root.classList.contains('erd-flow--hover-focus')).toBe(true);
      expect(tableNode(container, 'customers').querySelector('.model-node--focus-origin')).not.toBeNull();
      expect(tableNode(container, 'orders').querySelector('.model-node--focus-related')).not.toBeNull();
      expect(container.querySelector('.fk-edge__flow')).not.toBeNull();
      expect(container.querySelector('.fk-edge__swap-btn')).toBeNull();
      expect(container.querySelector('.fk-edge__swap-zone')).toBeNull();
      expect(container.querySelector('.fk-edge__backwards-btn')).toBeNull();
      expect(container.textContent).not.toContain('Turn round');

      fireEvent.mouseLeave(tableNode(container, 'customers'));
      await wait(250);
      expect(root.classList.contains('erd-flow--hover-focus')).toBe(false);
      expect(container.querySelector('.fk-edge__flow')).toBeNull();
      expect(post).not.toHaveBeenCalled();
      post.mockRestore();
    });
  }

  it('keeps a clicked table\'s lines flowing after its panel is closed, until the canvas is clicked', async () => {
    const { container } = await renderCanvas(true);
    await wait(20);
    fireEvent.click(tableNode(container, 'orders'));
    await wait(20);
    expect(container.querySelector('.fk-edge__flow')).not.toBeNull();

    fireEvent.click(container.querySelector('.detail-panel__close')!);
    await wait(20);
    expect(container.querySelector('.detail-panel')).toBeNull();
    expect(container.querySelector('.fk-edge__flow')).not.toBeNull();

    fireEvent.click(container.querySelector('.react-flow__pane')!);
    await wait(20);
    expect(container.querySelector('.fk-edge__flow')).toBeNull();
  });
});

describe('ErdCanvas logicalOnly', () => {
  it('keeps the stage colours by default, as before', async () => {
    const { container } = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={makeSubjectArea(true)} />
      </div>,
    );
    await flush();
    expect(container.querySelector('.editor-canvas')!.className).toBe('editor-canvas');
  });

  it('draws a project without dbt with the neutral canvas, and follows the prop', async () => {
    const domain = makeSubjectArea(true);
    const view = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={domain} logicalOnly className="host" />
      </div>,
    );
    await flush();
    expect(view.container.querySelector('.editor-canvas')!.className).toBe('editor-canvas editor-canvas--neutral host');

    view.rerender(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={domain} className="host" />
      </div>,
    );
    await flush();
    expect(view.container.querySelector('.editor-canvas')!.className).toBe('editor-canvas host');
  });
});

// ---------------------------------------------------------------------------
// Closing the panel keeps the selection; the legend and the counts
// ---------------------------------------------------------------------------

/** orders → customers, and products, which relates to neither. */
function threeTables(): DisplaySubjectArea {
  const domain = makeSubjectArea(true);
  return {
    ...domain,
    models: [
      ...domain.models,
      { name: 'products', schema: 'sales', description: '', columns: [{ name: 'product_id', dataType: 'bigint', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false }] },
    ],
    viewConfig: { ...domain.viewConfig, positions: { ...domain.viewConfig.positions, products: { x: 1200, y: 0 } } },
  };
}

describe('ErdCanvas — closing the detail panel keeps the table selected', () => {
  async function renderThree() {
    const view = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={threeTables()} />
      </div>,
    );
    await flush();
    return view;
  }
  const card = (container: HTMLElement, name: string) => tableNode(container, name).querySelector('.model-node')!;

  it('hides the panel and keeps the highlight: the selected table and its neighbour bright, the rest dimmed, nothing posted', async () => {
    const post = vi.spyOn(NOOP_CANVAS_HOST, 'postMessage');
    const { container } = await renderThree();
    const panel = await openPanel(container, 'orders');
    expect(card(container, 'products').classList.contains('model-node--dimmed')).toBe(true);

    fireEvent.click(panel.querySelector('.detail-panel__close')!);
    await flush();

    expect(container.querySelector('.detail-panel')).toBeNull();
    expect(card(container, 'orders').classList.contains('model-node--selected')).toBe(true);
    expect(card(container, 'orders').classList.contains('model-node--dimmed')).toBe(false);
    expect(card(container, 'customers').classList.contains('model-node--dimmed')).toBe(false);
    expect(card(container, 'products').classList.contains('model-node--dimmed')).toBe(true);
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  });

  it('opens the panel again on a click on the selected table, or on another one', async () => {
    const { container } = await renderThree();
    const panel = await openPanel(container, 'orders');
    fireEvent.click(panel.querySelector('.detail-panel__close')!);
    await flush();

    expect((await openPanel(container, 'orders')).querySelector('.detail-panel__title')!.textContent).toBe('orders');
    fireEvent.click(container.querySelector('.detail-panel__close')!);
    await flush();
    expect((await openPanel(container, 'products')).querySelector('.detail-panel__title')!.textContent).toBe('products');
  });

  it('clears the selection on a click on the empty canvas', async () => {
    const { container } = await renderThree();
    const panel = await openPanel(container, 'orders');
    fireEvent.click(panel.querySelector('.detail-panel__close')!);
    await flush();

    fireEvent.click(container.querySelector('.react-flow__pane')!);
    await flush();
    expect(card(container, 'products').classList.contains('model-node--dimmed')).toBe(false);
    expect(container.querySelector('.model-node--selected')).toBeNull();
  });

  it('clears the selection on Escape, with the panel open or closed', async () => {
    const { container } = await renderThree();
    await openPanel(container, 'orders');
    fireEvent.keyDown(tableNode(container, 'orders'), { key: 'Escape' });
    await flush();
    expect(container.querySelector('.detail-panel')).toBeNull();
    expect(container.querySelector('.model-node--selected')).toBeNull();
    expect(card(container, 'products').classList.contains('model-node--dimmed')).toBe(false);

    const panel = await openPanel(container, 'orders');
    fireEvent.click(panel.querySelector('.detail-panel__close')!);
    await flush();
    // The close button is gone, so nothing in the page has the focus.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await flush();
    expect(container.querySelector('.model-node--selected')).toBeNull();
    expect(card(container, 'products').classList.contains('model-node--dimmed')).toBe(false);
  });

  it('leaves Escape alone when it is pressed elsewhere on the page', async () => {
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    try {
      const { container } = await renderThree();
      await openPanel(container, 'orders');
      fireEvent.keyDown(outside, { key: 'Escape' });
      await flush();
      expect(container.querySelector('.detail-panel')).not.toBeNull();
      expect(card(container, 'orders').classList.contains('model-node--selected')).toBe(true);
    } finally {
      outside.remove();
    }
  });
});

describe('ErdCanvas — relationship rows in the detail panel', () => {
  it('wrap instead of cutting names off, and show the role', async () => {
    const domain = makeSubjectArea(true);
    domain.relationships = domain.relationships.map((r) => ({ ...r, role: 'bill to' }));
    const { container } = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={domain} />
      </div>,
    );
    await flush();
    const panel = await openPanel(container, 'orders');
    const row = panel.querySelector('.detail-panel__relationship')!;
    expect(row.classList.contains('detail-panel__relationship--wrap')).toBe(true);
    expect(row.querySelector('.detail-panel__rel-target')!.getAttribute('title')).toBe('customers.customer_id');
    expect(row.querySelector('.detail-panel__rel-role')!.textContent).toBe('bill to');
    expect(panel.classList.contains('detail-panel--viewer')).toBe(true);
  });
});

describe('ErdCanvas — legend entries for the stage shown', () => {
  async function openLegend(domain: DisplaySubjectArea) {
    const view = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={domain} />
      </div>,
    );
    await flush();
    fireEvent.click(view.container.querySelector('.legend-toggle__button')!);
    await flush();
    return view.container.querySelector<HTMLElement>('.legend')!;
  }

  it('a logical diagram: no Physical, ghost, provenance, line-colour or comparison entries', async () => {
    const legend = await openLegend(makeSubjectArea(true));
    expect(legend.querySelector('.legend__model-card--logical')).not.toBeNull();
    expect(legend.querySelector('.legend__model-card--physical')).toBeNull();
    expect(legend.querySelector('.legend__model-card--ghost')).toBeNull();
    expect(legend.querySelector('.legend__items--sources')).toBeNull();
    expect(legend.querySelector('.legend__edge--physical')).toBeNull();
    expect(legend.querySelector('.legend__swatch')).toBeNull();
    expect(legend.textContent).not.toContain('Line colour follows the stage');
    expect(legend.textContent).not.toContain('Comparing Stages');
    // What a logical diagram does draw is still explained.
    expect(legend.querySelectorAll('.legend__items--cardinality .legend__item')).toHaveLength(4);
    expect(legend.querySelectorAll('.legend__items--flow .legend__item')).toHaveLength(3);
    expect(legend.querySelector('.legend__annotation-card')).not.toBeNull();
    for (const label of ['PK', 'FK', 'NK']) expect(legend.textContent).toContain(label);
    // Not the neutral look: the stage colours are kept.
    expect(legend.closest('.editor-canvas')!.classList.contains('editor-canvas--neutral')).toBe(false);
    expect(legend.classList.contains('legend--stage-physical')).toBe(false);
  });

  it('a physical diagram: Physical, ghosts and provenance, but no Logical, line-colour or comparison entries', async () => {
    const legend = await openLegend({ ...makeSubjectArea(true), stage: 'physical' });
    expect(legend.querySelector('.legend__model-card--physical')).not.toBeNull();
    expect(legend.querySelector('.legend__model-card--ghost')).not.toBeNull();
    expect(legend.querySelector('.legend__items--sources')).not.toBeNull();
    expect(legend.querySelector('.legend__model-card--logical')).toBeNull();
    expect(legend.textContent).not.toContain('Line colour follows the stage');
    expect(legend.querySelector('.legend__swatch')).toBeNull();
    // Its line samples take the physical stage's colour, as the canvas draws them.
    expect(legend.classList.contains('legend--stage-physical')).toBe(true);
  });
});

describe('ErdCanvas — the counts beside the legend', () => {
  it('shows the tables and relationships, a composite foreign key counted once, with the legend button', async () => {
    const domain = threeTables();
    domain.relationships = [
      ...domain.relationships,
      { fromModel: 'orders', fromColumn: 'product_id', toModel: 'products', toColumn: 'product_id', cardinality: 'many-to-one', compositeKey: 'p' },
      { fromModel: 'orders', fromColumn: 'product_version', toModel: 'products', toColumn: 'version', cardinality: 'many-to-one', compositeKey: 'p' },
    ];
    const post = vi.spyOn(NOOP_CANVAS_HOST, 'postMessage');
    const { container } = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={domain} />
      </div>,
    );
    await flush();
    const bar = container.querySelector('.status-bar')!;
    expect(bar).not.toBeNull();
    expect([...bar.querySelectorAll('.status-bar__item')].map((i) => i.textContent)).toEqual(['3 tables', '2 relationships']);
    expect(container.querySelector('.legend-toggle__button')).not.toBeNull();
    expect(bar.querySelectorAll('button')).toHaveLength(0);
    expect(bar.classList.contains('status-bar--viewer')).toBe(true);

    // Still in sight beside the open legend.
    fireEvent.click(container.querySelector('.legend-toggle__button')!);
    await flush();
    expect(container.querySelector('.legend')).not.toBeNull();
    expect(container.querySelector('.status-bar')!.classList.contains('status-bar--beside-legend')).toBe(true);
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  });
});
