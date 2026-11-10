// @vitest-environment jsdom
/**
 * TableNode load error for a `.dbml` table file (native DBML storage): the
 * node says "DBML error" instead of "YAML error". An older core never sends
 * a `dbml*` kind, so its nodes read exactly as before.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type React from 'react';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
}));

const noop = vi.fn();
const mockStoreState: Record<string, unknown> = {
  highlightedColumns: new Set<string>(),
  startDragLine: noop,
  updateDragLineMouse: noop,
  endDragLine: noop,
  dragLineState: null,
  openNodeContextMenu: noop,
};

vi.mock('../../src/store/editorStore', () => ({
  useEditorStore: (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

import { TableNode } from '../../src/components/Graph/ModelNode';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import type { TableFlowNode } from '../../src/types/graph';

function renderNode(extra: Partial<TableFlowNode['data']> = {}) {
  const data: TableFlowNode['data'] = { modelName: 'fct_order', stage: 'logical', layer: 'gold', columns: [], isStub: false, ...extra };
  const Node = TableNode as unknown as React.ComponentType<{ data: TableFlowNode['data']; selected: boolean }>;
  return render(
    <CanvasEnvironmentProvider host={{ postMessage: () => {} }}>
      <Node data={data} selected={false} />
    </CanvasEnvironmentProvider>,
  );
}

describe('TableNode load error for a .dbml table file', () => {
  it('names a DBML error, with its line', () => {
    const { unmount } = renderNode({ loadError: { kind: 'dbmlSyntax', line: 3 } });
    expect(screen.getByText("DBML error on line 3 — ERD Studio can't read this file.")).toBeTruthy();
    unmount();
    renderNode({ loadError: { kind: 'dbmlInvalid', code: '3025' } });
    expect(screen.getByText("DBML error — ERD Studio can't read this file.")).toBeTruthy();
  });

  it('still names a conflict as a conflict', () => {
    renderNode({ loadError: { kind: 'dbmlSyntax', line: 5, mergeConflict: true } });
    expect(screen.getByText(/Unresolved git merge conflict on line 5/)).toBeTruthy();
  });
});
