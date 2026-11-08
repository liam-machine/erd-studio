// @vitest-environment jsdom
/**
 * EdgeLabels: an edge's HTML labels go into React Flow's label layer, as
 * <EdgeLabelRenderer> puts them, but the layer is found once per canvas
 * rather than by a DOM search per edge on every store update.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const state: { domNode: HTMLElement | null } = { domNode: null };
vi.mock('@xyflow/react', () => ({
  useStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

import { EdgeLabels, labelLayerOf } from '../../src/components/Graph/EdgeLabels';

function canvasRoot(): { root: HTMLElement; layer: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'react-flow';
  const viewport = document.createElement('div');
  viewport.className = 'react-flow__viewport';
  const edges = document.createElement('div');
  for (let i = 0; i < 50; i++) edges.appendChild(document.createElement('span'));
  const layer = document.createElement('div');
  layer.className = 'react-flow__edgelabel-renderer';
  viewport.append(edges, layer);
  root.appendChild(viewport);
  document.body.appendChild(root);
  return { root, layer };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  state.domNode = null;
  vi.restoreAllMocks();
});

describe('EdgeLabels', () => {
  it('renders its children in the canvas label layer', () => {
    const { root, layer } = canvasRoot();
    state.domNode = root;
    const { container } = render(
      <EdgeLabels>
        <span className="fk-edge__label">*</span>
      </EdgeLabels>,
    );
    expect(layer.querySelector('.fk-edge__label')?.textContent).toBe('*');
    expect(container.querySelector('.fk-edge__label')).toBeNull();
  });

  it('searches the canvas once, however many edges and store updates ask', () => {
    const { root, layer } = canvasRoot();
    const search = vi.spyOn(root, 'querySelector');
    for (let i = 0; i < 2743 * 3; i++) expect(labelLayerOf(root)).toBe(layer);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('finds the layer again when React Flow replaces it', () => {
    const { root, layer } = canvasRoot();
    expect(labelLayerOf(root)).toBe(layer);
    const replacement = layer.cloneNode() as HTMLElement;
    layer.replaceWith(replacement);
    expect(labelLayerOf(root)).toBe(replacement);
  });

  it('renders nothing before the canvas (or its layer) exists, and finds the layer once it does', () => {
    expect(labelLayerOf(null)).toBeNull();
    const root = document.createElement('div');
    document.body.appendChild(root);
    expect(labelLayerOf(root)).toBeNull();
    const layer = document.createElement('div');
    layer.className = 'react-flow__edgelabel-renderer';
    root.appendChild(layer);
    expect(labelLayerOf(root)).toBe(layer);
    state.domNode = null;
    const { container } = render(<EdgeLabels><span className="x">1</span></EdgeLabels>);
    expect(container.innerHTML).toBe('');
    expect(document.querySelector('.x')).toBeNull();
  });
});
