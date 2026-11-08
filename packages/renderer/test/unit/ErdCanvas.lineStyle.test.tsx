// @vitest-environment jsdom
/**
 * ErdCanvas's `lineStyle` prop: lines are routed around the tables in the
 * `curved` style by default (a halo casing under each line) or in `hops`
 * (no casing), the canvas follows a prop change, anything unknown reads as
 * `curved`, and routing posts nothing to the host. Two canvases on a page
 * each route their own diagram.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import type { DisplaySubjectArea } from '@erd-studio/core';
import { ErdCanvas } from '../../src/ErdCanvas';
import { NOOP_CANVAS_HOST } from '../../src/host/canvasEnvironment';
import * as renderer from '../../src/index';

// Edges only render once React Flow has measured their nodes: a
// ResizeObserver that reports, and elements with a size (every card 240 x 120).
const saved: { ro?: unknown; matrix?: unknown; w?: PropertyDescriptor; h?: PropertyDescriptor } = {};
beforeAll(() => {
  saved.ro = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  saved.matrix = (window as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly;
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function domain(name = 'sales'): DisplaySubjectArea {
  const col = (n: string, pk: boolean, fk: boolean) => ({ name: n, dataType: 'bigint', description: '', isPrimaryKey: pk, isForeignKey: fk, isNaturalKey: false });
  return {
    schemaVersion: 5,
    domain: name,
    layer: 'silver',
    stage: 'logical',
    description: '',
    models: [
      { name: 'orders', schema: 'sales', description: '', columns: [col('order_id', true, false), col('customer_id', false, true)] },
      { name: 'customers', schema: 'sales', description: '', columns: [col('customer_id', true, false)] },
      { name: 'blocker', schema: 'sales', description: '', columns: [col('blocker_id', true, false)] },
    ],
    relationships: [
      { fromModel: 'orders', fromColumn: 'customer_id', toModel: 'customers', toColumn: 'customer_id', cardinality: 'many-to-one' },
    ],
    viewConfig: {
      // A table between the two ends, so the routed line must go around it.
      positions: { orders: { x: 0, y: 0 }, blocker: { x: 400, y: 0 }, customers: { x: 800, y: 0 } },
    },
    readOnly: true,
    positionDraggable: false,
  };
}

/** Let React Flow mount and the router's animation frame run. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 20));
  });

const halos = (root: ParentNode) => root.querySelectorAll('.fk-edge__halo').length;
const lines = (root: ParentNode) => root.querySelectorAll('path.fk-edge').length;

describe('ErdCanvas lineStyle', () => {
  it('is exported from the viewer entry with its two values', () => {
    expect(renderer.LINE_STYLES).toEqual(['curved', 'hops']);
    expect(renderer.DEFAULT_LINE_STYLE).toBe('curved');
  });

  it('routes the lines in the curved style by default: each line draws its halo casing', async () => {
    const { container } = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={domain()} />
      </div>,
    );
    await settle();
    expect(lines(container)).toBe(1);
    expect(halos(container)).toBe(1);
  });

  it('draws hops with no casing, follows the prop, and reads an unknown value as curved', async () => {
    const d = domain();
    const view = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={d} lineStyle="hops" />
      </div>,
    );
    await settle();
    expect(lines(view.container)).toBe(1);
    expect(halos(view.container)).toBe(0);

    view.rerender(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={d} lineStyle="curved" />
      </div>,
    );
    await settle();
    expect(halos(view.container)).toBe(1);

    view.rerender(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={d} lineStyle={'wavy' as never} />
      </div>,
    );
    await settle();
    expect(halos(view.container)).toBe(1);
  });

  it('routes around the table in the way rather than straight through it', async () => {
    const { container } = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={domain()} lineStyle="hops" />
      </div>,
    );
    await settle();
    const d = container.querySelector('path.fk-edge')!.getAttribute('d')!;
    const ys = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]));
    // Leaves the row of cards (above or below the blocker) somewhere on the way.
    expect(Math.min(...ys) < 0 || Math.max(...ys) > 120).toBe(true);
  });

  it('hands the diagram\'s layer colour to the CSS (colour on hover), and clears it without one', async () => {
    const coloured: DisplaySubjectArea = {
      ...domain(),
      layerConfig: { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: 'var(--layer-silver)' } as DisplaySubjectArea['layerConfig'],
    };
    const view = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={coloured} logicalOnly />
      </div>,
    );
    await settle();
    const root = () => view.container.querySelector<HTMLElement>('.react-flow')!;
    expect(root().style.getPropertyValue('--diagram-layer-color')).toBe('var(--layer-silver)');
    view.rerender(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={domain()} logicalOnly />
      </div>,
    );
    await settle();
    expect(root().style.getPropertyValue('--diagram-layer-color')).toBe('');
  });

  it('posts nothing, with two canvases on a page each routing its own diagram', async () => {
    const post = vi.spyOn(NOOP_CANVAS_HOST, 'postMessage');
    const view = render(
      <>
        <div className="one" style={{ width: 1200, height: 800 }}>
          <ErdCanvas domain={domain('one')} />
        </div>
        <div className="two" style={{ width: 1200, height: 800 }}>
          <ErdCanvas domain={domain('two')} lineStyle="hops" />
        </div>
      </>,
    );
    await settle();
    expect(halos(view.container.querySelector('.one')!)).toBe(1);
    expect(halos(view.container.querySelector('.two')!)).toBe(0);
    expect(lines(view.container.querySelector('.two')!)).toBe(1);
    expect(post).not.toHaveBeenCalled();
  });
});
