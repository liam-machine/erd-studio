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
      expect(panel.textContent).not.toContain('Remove from Subject Area');
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

    it('omits the rationale section for a model without rationale', async () => {
      const { container } = await renderCanvas(readOnly);
      const panel = await openPanel(container, 'orders');
      expect(panel.textContent).not.toContain('+ Add Rationale');
      expect(panel.querySelector('.detail-panel__rationale-section')).toBeNull();
    });

    it('shows only the filled rationale fields, read-only', async () => {
      const { container } = await renderCanvas(readOnly);
      const panel = await openPanel(container, 'customers');

      fireEvent.click(panel.querySelector('.detail-panel__rationale-toggle')!);
      await flush();

      const body = panel.querySelector('.detail-panel__rationale-body')!;
      const labels = [...body.querySelectorAll('.detail-panel__section-title')].map((h) => h.textContent);
      expect(labels).toEqual(['Purpose']);
      expect(body.textContent).toContain('Who buys');
      expect(panel.textContent).not.toMatch(/\+ Add/);
      expect(panel.querySelector('.detail-panel__rationale-edit-btn')).toBeNull();

      fireEvent.doubleClick(panel.querySelector('.detail-panel__rationale-field')!);
      expect(panel.querySelector('.detail-panel__rationale-textarea')).toBeNull();
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
  it('leaves the layer badge of a model without a schema empty', async () => {
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
    const badge = tableNode(container, 'orders').querySelector('.model-node__badge--layer');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('');
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
});
