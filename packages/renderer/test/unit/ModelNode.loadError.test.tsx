// @vitest-environment jsdom
/**
 * ModelNode load error (#110) — a model whose logical-models file exists but
 * has a YAML error shows the error and an "Open file" button instead of the
 * misleading "No columns". The button is an editing affordance, so the
 * read-only viewer drops it.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

import type { CanvasEditMessage } from '@erd-studio/core';
import { ModelNode } from '../../src/components/Graph/ModelNode';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import type { ModelFlowNode } from '../../src/types/graph';

function renderNode(extra: Partial<ModelFlowNode['data']> = {}, viewer = false) {
  const posted: CanvasEditMessage[] = [];
  const data: ModelFlowNode['data'] = {
    modelName: 'dim_broken',
    stage: 'logical',
    layer: 'silver',
    columns: [],
    isStub: false,
    ...extra,
  };
  const Node = ModelNode as unknown as React.ComponentType<{ data: ModelFlowNode['data']; selected: boolean }>;
  const utils = render(
    <CanvasEnvironmentProvider host={{ postMessage: (m) => posted.push(m) }} viewer={viewer}>
      <Node data={data} selected={false} />
    </CanvasEnvironmentProvider>,
  );
  return { ...utils, posted };
}

describe('ModelNode load error', () => {
  it('shows the YAML error line and an Open file button instead of "No columns"', () => {
    const { container, posted } = renderNode({ loadError: { kind: 'yamlScalar', line: 4 } });
    expect(screen.getByText("YAML error on line 4 — ERD Studio can't read this file.")).toBeTruthy();
    expect(container.querySelector('.model-node__empty')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect(posted).toEqual([{ type: 'openModelFile', payload: { modelName: 'dim_broken' } }]);
  });

  it('keeps the message but drops the button in viewer mode', () => {
    renderNode({ loadError: { kind: 'yamlIndent', line: 2 } }, true);
    expect(screen.getByText("YAML error on line 2 — ERD Studio can't read this file.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull();
  });

  it('says the file could not be read for a read failure, and omits an unknown line', () => {
    const { unmount } = renderNode({ loadError: { kind: 'read' } });
    expect(screen.getByText("ERD Studio can't read this file.")).toBeTruthy();
    unmount();
    renderNode({ loadError: { kind: 'yamlOther' } });
    expect(screen.getByText("YAML error — ERD Studio can't read this file.")).toBeTruthy();
  });

  it('names an unresolved git merge conflict, with the line of its first marker (#145)', () => {
    const { unmount } = renderNode({ loadError: { kind: 'yamlOther', line: 7, mergeConflict: true } });
    expect(screen.getByText("Unresolved git merge conflict on line 7 — ERD Studio can't read this file.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open file' })).toBeTruthy();
    unmount();
    renderNode({ loadError: { kind: 'yamlOther', mergeConflict: true } });
    expect(screen.getByText("Unresolved git merge conflict — ERD Studio can't read this file.")).toBeTruthy();
  });

  it('still says "No columns" for an empty model without a load error', () => {
    const { container } = renderNode();
    expect(container.querySelector('.model-node__empty')?.textContent).toBe('No columns');
    expect(container.querySelector('.model-node__load-error')).toBeNull();
  });
});
