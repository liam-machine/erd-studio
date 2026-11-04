/**
 * The draft's layout (docs/dev/draft-first.md §2.5): the canvas's own ELK
 * layout with the options its first-open layout uses
 * (`webview/lib/firstOpenLayout.ts`), so the preview shows the diagram the
 * canvas draws when it first opens what Keep wrote.
 */

import { transformSubjectArea } from '@erd-studio/renderer';
import { NODE_THRESHOLD, type FkFlowEdge, type TableFlowNode } from '@erd-studio/renderer/editor';

import { runElkLayout } from '../../webview/lib/elkLayout';
import { FIRST_OPEN_LAYOUT, firstOpenLayoutOptions } from '../../webview/lib/firstOpenLayout';
import type { DisplaySubjectArea } from '../../src/types/display';
import type { NodePosition } from '../../src/types/semantic';

/** Lay `display`'s tables out; positions keyed by table name. Rejects when ELK fails. */
export async function layoutDraft(display: DisplaySubjectArea): Promise<Record<string, NodePosition>> {
  // Sized as ErdCanvas draws them: every table's columns open below NODE_THRESHOLD.
  const expanded = display.models.length < NODE_THRESHOLD;
  const { nodes, edges } = transformSubjectArea(display, { isExpanded: () => expanded });
  const tableNodes = nodes.filter((n): n is TableFlowNode => n.type === 'model');
  const fkEdges = edges.filter((e): e is FkFlowEdge => e.type === 'fk');
  if (tableNodes.length === 0) return {};
  return runElkLayout(
    tableNodes,
    fkEdges,
    firstOpenLayoutOptions(tableNodes.length, display.viewConfig.layoutOptions),
    FIRST_OPEN_LAYOUT.partitionStrategy,
  );
}

/** `display` drawn at `positions` (the tables ELK placed; the rest keep theirs). */
export function withPositions(display: DisplaySubjectArea, positions: Record<string, NodePosition>): DisplaySubjectArea {
  return { ...display, viewConfig: { ...display.viewConfig, positions: { ...display.viewConfig.positions, ...positions } } };
}
