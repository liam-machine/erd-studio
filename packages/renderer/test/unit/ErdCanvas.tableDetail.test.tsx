// @vitest-environment jsdom
/**
 * ErdCanvas's optional `tableDetail` prop: `name`, `keys` or `all` decides
 * the rows every table draws, the canvas follows a prop change, a reader can
 * still open one table, and nothing is posted. Without the prop (or with a
 * value it does not know) the viewer draws exactly as it did before: every
 * column under 30 tables, the first five columns from 30 up.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, act, cleanup, fireEvent } from '@testing-library/react';
import type { DisplaySubjectArea } from '@erd-studio/core';
import { ErdCanvas } from '../../src/ErdCanvas';
import { NOOP_CANVAS_HOST } from '../../src/host/canvasEnvironment';
import type { TableDetail } from '../../src/index';

// React Flow needs a ResizeObserver, and draws nodes once they have a size.
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

const col = (name: string, key: '' | 'pk' | 'fk' = '') => ({
  name, dataType: 'bigint', description: '', isPrimaryKey: key === 'pk', isForeignKey: key === 'fk', isNaturalKey: false,
});

/** `tables` tables of eight columns each: a PK, an FK and six plain columns. */
function domain(tables = 2): DisplaySubjectArea {
  const models = Array.from({ length: tables }, (_, i) => ({
    name: `t${i}`,
    schema: 'sales',
    description: '',
    columns: [col('id', 'pk'), col('a'), col('parent_id', 'fk'), col('b'), col('c'), col('d'), col('e'), col('f')],
  }));
  return {
    schemaVersion: 5,
    domain: 'sales',
    layer: 'silver',
    stage: 'logical',
    description: '',
    models,
    relationships: [],
    viewConfig: { positions: Object.fromEntries(models.map((m, i) => [m.name, { x: i * 400, y: 0 }])) },
    readOnly: true,
    positionDraggable: false,
  };
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 20));
  });

const card = (root: ParentNode, name: string) => root.querySelector(`.model-node[data-model-name="${name}"]`)!;
const rows = (root: ParentNode, name: string) =>
  [...card(root, name).querySelectorAll('.model-node__column .model-node__col-name')].map((e) => e.textContent);
const button = (root: ParentNode, name: string) => card(root, name).querySelector('.model-node__expand-button');
const footerToggle = (root: ParentNode, name: string) => card(root, name).querySelector('button.model-node__footer--toggle');

describe('ErdCanvas tableDetail', () => {
  it('draws the header only at name, the keys at keys and every column at all, following the prop', async () => {
    const d = domain();
    const { container, rerender } = render(<ErdCanvas domain={d} tableDetail="name" />);
    await settle();
    expect(rows(container, 't0')).toEqual([]);
    expect(button(container, 't0')).toBeNull();
    expect(footerToggle(container, 't0')!.getAttribute('aria-label')).toBe('Show all 8 columns');

    rerender(<ErdCanvas domain={d} tableDetail="keys" />);
    await settle();
    expect(rows(container, 't0')).toEqual(['id', 'parent_id']);
    expect(rows(container, 't1')).toEqual(['id', 'parent_id']);

    rerender(<ErdCanvas domain={d} tableDetail="all" />);
    await settle();
    expect(rows(container, 't0')).toHaveLength(8);
    expect(button(container, 't0')).toBeNull();
  });

  it('lets a reader open one table and close it again, posting nothing', async () => {
    const post = vi.spyOn(NOOP_CANVAS_HOST, 'postMessage');
    const { container } = render(<ErdCanvas domain={domain()} tableDetail="keys" />);
    await settle();

    fireEvent.click(button(container, 't0')!);
    await settle();
    expect(rows(container, 't0')).toHaveLength(8);
    expect(rows(container, 't1')).toEqual(['id', 'parent_id']);
    expect(button(container, 't0')!.textContent).toBe('Show keys only');

    fireEvent.click(button(container, 't0')!);
    await settle();
    expect(rows(container, 't0')).toEqual(['id', 'parent_id']);
    expect(post).not.toHaveBeenCalled();
  });

  it('at name the footer opens one table, and "Show name only" closes it, posting nothing', async () => {
    const post = vi.spyOn(NOOP_CANVAS_HOST, 'postMessage');
    const { container } = render(<ErdCanvas domain={domain()} tableDetail="name" />);
    await settle();

    fireEvent.click(footerToggle(container, 't0')!);
    await settle();
    expect(rows(container, 't0')).toHaveLength(8);
    expect(rows(container, 't1')).toEqual([]);
    expect(footerToggle(container, 't0')).toBeNull();
    expect(button(container, 't0')!.textContent).toBe('Show name only');

    fireEvent.click(button(container, 't0')!);
    await settle();
    expect(rows(container, 't0')).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it('a level holds on a large diagram too (no first-five view)', async () => {
    const { container } = render(<ErdCanvas domain={domain(30)} tableDetail="all" />);
    await settle();
    expect(rows(container, 't29')).toHaveLength(8);
  });

  it('without the prop draws as before: every column under 30 tables', async () => {
    const { container } = render(<ErdCanvas domain={domain(2)} />);
    await settle();
    expect(rows(container, 't0')).toHaveLength(8);
    expect(button(container, 't0')!.textContent).toBe('Show less');
  });

  it('without the prop draws as before: the first five columns from 30 tables up', async () => {
    const { container } = render(<ErdCanvas domain={domain(30)} />);
    await settle();
    expect(rows(container, 't0')).toEqual(['id', 'a', 'parent_id', 'b', 'c']);
    expect(button(container, 't0')!.textContent).toBe('...and 3 more');
    expect(footerToggle(container, 't0')).toBeNull();
  });

  it('reads a value it does not know as no prop', async () => {
    const { container } = render(<ErdCanvas domain={domain(30)} tableDetail={'everything' as unknown as TableDetail} />);
    await settle();
    expect(rows(container, 't0')).toEqual(['id', 'a', 'parent_id', 'b', 'c']);
  });

  it('goes back to the older view when the prop is taken away', async () => {
    const d = domain(2);
    const { container, rerender } = render(<ErdCanvas domain={d} tableDetail="name" />);
    await settle();
    expect(rows(container, 't0')).toEqual([]);

    rerender(<ErdCanvas domain={d} />);
    await settle();
    expect(rows(container, 't0')).toHaveLength(8);
    expect(button(container, 't0')!.textContent).toBe('Show less');
  });
});
