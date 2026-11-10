/**
 * The zoom the draft's canvas fitted the diagram at (usage telemetry, 2.0
 * B17), read from React Flow's viewport element (`transform: translate(…)
 * scale(z)`), so the renderer needs no new prop. Undefined when it cannot be
 * read.
 */

/** The `scale(z)` of a CSS transform, or undefined. */
export function zoomFromTransform(transform: string | null | undefined): number | undefined {
  if (!transform) return undefined;
  const match = /scale\(\s*([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)\s*\)/i.exec(transform);
  if (!match) return undefined;
  const zoom = Number(match[1]);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : undefined;
}

/** The fitted zoom of the React Flow canvas inside `container`, or undefined. */
export function fittedZoomOf(container: ParentNode | null | undefined): number | undefined {
  const viewport = container?.querySelector<HTMLElement>('.react-flow__viewport');
  return zoomFromTransform(viewport?.style.transform);
}
