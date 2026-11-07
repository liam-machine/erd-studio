// @vitest-environment jsdom
/**
 * The lines of a focused table carry direction glyphs along their own path:
 * chevrons from the `1` end to the `*` end, two lanes for many-to-many, two
 * dots for one-to-one, still glyphs (a plain transform, no SMIL) without
 * motion, larger glyphs when zoomed out, and nothing on a
 * `missing` line, below zoom 0.35 or while an end is being dragged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type React from 'react';

const xy = vi.hoisted(() => ({
  transform: undefined as [number, number, number] | undefined,
  dragging: new Set<string>(),
}));

vi.mock('@xyflow/react', () => ({
  getSmoothStepPath: () => ['M 0,0 L 100,100'],
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ edges: [], nodeLookup: new Map(), ...(xy.transform ? { transform: xy.transform } : {}) }),
  useStoreApi: () => ({ getState: () => ({ nodeLookup: new Map() }) }),
  useInternalNode: (id: string) => (xy.dragging.has(id) ? { id, dragging: true } : undefined),
}));

import { FkEdge } from '../../src/components/Graph/FkEdge';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import { CanvasStoreProvider, createCanvasStore } from '../../src/store/editorStore';
import { computeCanvasFocus, type CanvasFocus } from '../../src/lib/canvasFocus';
import type { FkEdgeData, FkFlowEdge } from '../../src/types/graph';

afterEach(() => {
  cleanup();
  xy.transform = undefined;
  xy.dragging.clear();
  vi.unstubAllGlobals();
});

const ORDER_CUSTOMER: FkEdgeData = {
  fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id',
  cardinality: 'many-to-one', stage: 'logical',
};

function focusOn(data: FkEdgeData, node = data.fromModel): CanvasFocus {
  const edge = { id: 'e', type: 'fk', source: data.fromModel, target: data.toModel, data } as FkFlowEdge;
  return computeCanvasFocus([edge], { node })!;
}

interface Options {
  flowFocus?: CanvasFocus | null;
  hoverFocus?: CanvasFocus | null;
  viewer?: boolean;
}

function renderEdge(data: FkEdgeData, { flowFocus = null, hoverFocus = null, viewer = false }: Options = {}) {
  const postMessage = vi.fn();
  const store = createCanvasStore({ flowFocus, hoverFocus });
  const Edge = FkEdge as unknown as React.ComponentType<Record<string, unknown>>;
  const { container } = render(
    <CanvasStoreProvider store={store}>
      <CanvasEnvironmentProvider host={{ postMessage }} viewer={viewer}>
        <svg>
          <Edge id="e" sourceX={0} sourceY={0} targetX={300} targetY={100} sourcePosition="right" targetPosition="left"
            sourceHandleId="node-right-src" targetHandleId="node-left-tgt" data={data} />
        </svg>
      </CanvasEnvironmentProvider>
    </CanvasStoreProvider>,
  );
  return { container, postMessage };
}

const motions = (c: HTMLElement) => Array.from(c.querySelectorAll('animateMotion'));
const stillGlyphs = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('.fk-edge__flow-glyph'))
    .map((g) => g.getAttribute('transform'))
    .filter((t): t is string => t !== null);

describe('FkEdge — relationship flow', () => {
  it('draws no glyphs without a focus', () => {
    const { container } = renderEdge(ORDER_CUSTOMER);
    expect(container.querySelector('.fk-edge__flow')).toBeNull();
    expect(container.querySelector('.fk-edge--flowing')).toBeNull();
  });

  it('many-to-one: chevrons along the visible path, from the 1 end to the * end', () => {
    const { container } = renderEdge(ORDER_CUSTOMER, { flowFocus: focusOn(ORDER_CUSTOMER) });
    const flow = container.querySelector('.fk-edge__flow--logical');
    expect(flow).not.toBeNull();
    const visible = container.querySelector('path.fk-edge')!;
    expect(visible.getAttribute('class')).toContain('fk-edge--flowing');
    const ms = motions(container);
    expect(ms.length).toBeGreaterThan(0);
    for (const m of ms) {
      expect(m.getAttribute('path')).toBe(visible.getAttribute('d'));
      expect(m.getAttribute('calcMode')).toBe('linear');
      expect(m.getAttribute('keyPoints')).toBe('1;0');
      expect(m.getAttribute('rotate')).toBe('auto-reverse');
      expect(m.getAttribute('repeatCount')).toBe('indefinite');
    }
    expect(container.querySelector('mpath')).toBeNull();
    expect(container.querySelectorAll('.fk-edge__flow-chevron').length).toBe(ms.length);
  });

  it('one-to-many runs source → target', () => {
    const data = { ...ORDER_CUSTOMER, cardinality: 'one-to-many' as const };
    const { container } = renderEdge(data, { flowFocus: focusOn(data) });
    for (const m of motions(container)) {
      expect(m.getAttribute('keyPoints')).toBe('0;1');
      expect(m.getAttribute('rotate')).toBe('auto');
    }
  });

  it('one-to-one: two dots meeting, no chevrons', () => {
    const data = { ...ORDER_CUSTOMER, cardinality: 'one-to-one' as const };
    const { container } = renderEdge(data, { flowFocus: focusOn(data) });
    expect(container.querySelectorAll('.fk-edge__flow-dot')).toHaveLength(2);
    expect(container.querySelector('.fk-edge__flow-chevron')).toBeNull();
    const [a, b] = motions(container).map((m) => m.getAttribute('keyPoints')!.split(';'));
    // Each glides in from its own end and stops just short of the middle.
    expect([a[0], b[0]]).toEqual(['0', '1']);
    expect(parseFloat(a[1])).toBeLessThan(0.5);
    expect(parseFloat(b[1])).toBeGreaterThan(0.5);
    expect(parseFloat(a[1]) + parseFloat(b[1])).toBeCloseTo(1, 3);
  });

  it('many-to-many: two lanes running opposite ways, each offset from the line', () => {
    const data = { ...ORDER_CUSTOMER, cardinality: 'many-to-many' as const };
    const { container } = renderEdge(data, { flowFocus: focusOn(data) });
    const points = new Set(motions(container).map((m) => m.getAttribute('keyPoints')));
    expect(points).toEqual(new Set(['0;1', '1;0']));
    for (const glyph of container.querySelectorAll('.fk-edge__flow-chevron')) {
      expect(glyph.parentElement!.getAttribute('transform')).toBe('translate(0,-3.5)');
    }
  });

  it('a missing line never flows', () => {
    const data = { ...ORDER_CUSTOMER, discrepancyStatus: 'missing' as const };
    const focus = { ...focusOn(ORDER_CUSTOMER), flowEdges: new Set(['e']) };
    const { container } = renderEdge(data, { flowFocus: focus });
    expect(container.querySelector('.fk-edge__flow')).toBeNull();
  });

  it('flows in the discrepancy colour on an extra line', () => {
    const data = { ...ORDER_CUSTOMER, discrepancyStatus: 'extra' as const };
    const { container } = renderEdge(data, { flowFocus: focusOn(data) });
    expect(container.querySelector('.fk-edge__flow--discrepancy-extra')).not.toBeNull();
  });

  it('stands still when too many lines flow (flow-static): plain transforms, no SMIL', () => {
    const focus = { ...focusOn(ORDER_CUSTOMER), animate: false };
    const { container } = renderEdge(ORDER_CUSTOMER, { flowFocus: focus });
    expect(motions(container)).toHaveLength(0);
    expect(container.querySelector('animate')).toBeNull();
    const glyphs = stillGlyphs(container);
    // The mock path is one straight diagonal (0,0 → 100,100): thirds, and a
    // many-to-one points back toward the source (45° + 180°).
    expect(glyphs).toEqual([
      'translate(33.3,33.3) rotate(225)',
      'translate(66.7,66.7) rotate(225)',
    ]);
  });

  it('a still arrow turns round when the line is swapped (no stale frozen frame)', () => {
    const focus = { ...focusOn(ORDER_CUSTOMER), animate: false };
    const postMessage = vi.fn();
    const store = createCanvasStore({ flowFocus: focus, hoverFocus: null });
    const Edge = FkEdge as unknown as React.ComponentType<Record<string, unknown>>;
    const tree = (data: FkEdgeData) => (
      <CanvasStoreProvider store={store}>
        <CanvasEnvironmentProvider host={{ postMessage }} viewer={false}>
          <svg>
            <Edge id="e" sourceX={0} sourceY={0} targetX={300} targetY={100} sourcePosition="right" targetPosition="left"
              sourceHandleId="node-right-src" targetHandleId="node-left-tgt" data={data} />
          </svg>
        </CanvasEnvironmentProvider>
      </CanvasStoreProvider>
    );
    const { container, rerender } = render(tree(ORDER_CUSTOMER));
    expect(stillGlyphs(container).every((t) => t.endsWith('rotate(225)'))).toBe(true);
    rerender(tree({ ...ORDER_CUSTOMER, cardinality: 'one-to-many' }));
    expect(stillGlyphs(container).every((t) => t.endsWith('rotate(45)'))).toBe(true);
    // And back to moving: fresh SMIL elements running source → target.
    store.setState({ flowFocus: { ...focus, animate: true } });
    rerender(tree({ ...ORDER_CUSTOMER, cardinality: 'one-to-many' }));
    expect(stillGlyphs(container)).toHaveLength(0);
    expect(motions(container).every((m) => m.getAttribute('keyPoints') === '0;1')).toBe(true);
  });

  it('scales the glyphs up as the canvas zooms out', () => {
    xy.transform = [0, 0, 0.5];
    const { container } = renderEdge(ORDER_CUSTOMER, { flowFocus: focusOn(ORDER_CUSTOMER) });
    for (const chevron of container.querySelectorAll('.fk-edge__flow-chevron')) {
      expect(chevron.parentElement!.getAttribute('transform')).toBe('scale(2)');
    }
    cleanup();
    xy.transform = [0, 0, 1.5];
    const big = renderEdge(ORDER_CUSTOMER, { flowFocus: focusOn(ORDER_CUSTOMER) }).container;
    for (const chevron of big.querySelectorAll('.fk-edge__flow-chevron')) {
      expect(chevron.parentElement!.getAttribute('transform')).toBeNull();
    }
  });

  it('stands still under the reduce-motion setting', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'), media: query,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    const { container } = renderEdge(ORDER_CUSTOMER, { flowFocus: focusOn(ORDER_CUSTOMER) });
    expect(motions(container)).toHaveLength(0);
    expect(container.querySelector('[repeatCount="indefinite"]')).toBeNull();
    expect(stillGlyphs(container)).toHaveLength(2);
  });

  it('a lit-only line is bright with its labels, but carries no glyphs', () => {
    const lit: CanvasFocus = {
      node: 'other', edge: null,
      nodes: new Set(['other', 'fct_order', 'dim_customer']),
      edges: new Set(['e']), flowEdges: new Set(), animate: true,
    };
    const { container } = renderEdge(ORDER_CUSTOMER, { flowFocus: lit, hoverFocus: lit });
    const visible = container.querySelector('path.fk-edge')!;
    expect(visible.getAttribute('class')).toContain('fk-edge--lit');
    expect(visible.getAttribute('class')).not.toContain('fk-edge--flowing');
    expect(container.querySelector('.fk-edge__flow')).toBeNull();
    const labels = container.querySelectorAll('.fk-edge__label');
    expect(labels).toHaveLength(2);
    for (const l of labels) expect(l.getAttribute('class')).toContain('fk-edge__adornment--lit');
  });

  it('labels outside the focus are adornments that the hover preview fades', () => {
    const { container } = renderEdge(ORDER_CUSTOMER);
    for (const l of container.querySelectorAll('.fk-edge__label')) {
      expect(l.getAttribute('class')).toContain('fk-edge__adornment');
      expect(l.getAttribute('class')).not.toContain('fk-edge__adornment--lit');
    }
  });

  it('draws nothing below zoom 0.35; a store without transform counts as zoom 1', () => {
    xy.transform = [0, 0, 0.2];
    expect(renderEdge(ORDER_CUSTOMER, { flowFocus: focusOn(ORDER_CUSTOMER) }).container.querySelector('.fk-edge__flow')).toBeNull();
    cleanup();
    xy.transform = undefined;
    expect(renderEdge(ORDER_CUSTOMER, { flowFocus: focusOn(ORDER_CUSTOMER) }).container.querySelector('.fk-edge__flow')).not.toBeNull();
  });

  it('hides the glyphs while an end is being dragged', () => {
    xy.dragging.add('dim_customer');
    const { container } = renderEdge(ORDER_CUSTOMER, { flowFocus: focusOn(ORDER_CUSTOMER) });
    expect(container.querySelector('.fk-edge__flow')).toBeNull();
    expect(container.querySelector('path.fk-edge')!.getAttribute('class')).toContain('fk-edge--flowing');
  });

  it('is hidden from assistive technology and from the pointer', () => {
    const flow = renderEdge(ORDER_CUSTOMER, { flowFocus: focusOn(ORDER_CUSTOMER) }).container.querySelector('.fk-edge__flow')!;
    expect(flow.getAttribute('aria-hidden')).toBe('true');
    expect(flow.getAttribute('pointer-events')).toBe('none');
  });

  it('flows for a reader too, and posts nothing', () => {
    const { container, postMessage } = renderEdge(ORDER_CUSTOMER, { flowFocus: focusOn(ORDER_CUSTOMER), viewer: true });
    expect(container.querySelector('.fk-edge__flow')).not.toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
