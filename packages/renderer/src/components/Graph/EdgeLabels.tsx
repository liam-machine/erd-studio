/**
 * Where an edge's HTML labels go: React Flow's label layer
 * (`.react-flow__edgelabel-renderer`), portalled into exactly as
 * `<EdgeLabelRenderer>` does, but found once per canvas.
 *
 * `<EdgeLabelRenderer>` finds the layer with a store selector that runs
 * `domNode.querySelector(...)`, so every edge re-searches the canvas DOM on
 * every React Flow store update. On a 2,000-table diagram that was 2,743
 * searches through ~100,000 elements several times a drag frame: about 45% of
 * the time a drag took. Here the selector is a WeakMap lookup.
 */
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@xyflow/react';

const LABEL_LAYER = '.react-flow__edgelabel-renderer';
const layers = new WeakMap<Element, HTMLElement>();

/** The canvas's label layer, looked up once per canvas root (again only if it left the DOM). */
export function labelLayerOf(root: Element | null | undefined): HTMLElement | null {
  if (!root) return null;
  const cached = layers.get(root);
  if (cached?.isConnected) return cached;
  const found = root.querySelector<HTMLElement>(LABEL_LAYER);
  if (found) layers.set(root, found);
  else layers.delete(root);
  return found;
}

const selectLabelLayer = (s: { domNode: Element | null }) => labelLayerOf(s.domNode);

/** Renders `children` in the canvas's label layer (nothing until the layer exists). */
export function EdgeLabels({ children }: { children: ReactNode }) {
  const layer = useStore(selectLabelLayer);
  return layer ? createPortal(children, layer) : null;
}
