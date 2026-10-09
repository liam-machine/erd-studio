// @vitest-environment jsdom
/**
 * Dragging a column onto another column of the same model draws a
 * self-reference (#133 L3); only dropping it on itself is refused.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, fireEvent, cleanup } from '@testing-library/react';
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

import { ModelNode } from '../../src/components/Graph/ModelNode';
import type { ModelFlowNode } from '../../src/types/graph';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function dragWithin(from: string, onto: string): Array<{ type: string; detail: unknown }> {
  vi.useFakeTimers();
  const data: ModelFlowNode['data'] = {
    modelName: 'employee', stage: 'logical', layer: 'silver', isStub: false, readOnly: false,
    columns: ['employee_id', 'manager_id'].map((name, i) => ({ name, dataType: 'int', isPrimaryKey: i === 0, isForeignKey: false, isNaturalKey: false })),
  };
  const Node = ModelNode as unknown as React.ComponentType<{ data: ModelFlowNode['data']; selected: boolean }>;
  const { container } = render(<Node data={data} selected={false} />);
  const row = (name: string) => container.querySelector(`[data-column-name="${name}"]`) as HTMLElement;
  const seen: Array<{ type: string; detail: unknown }> = [];
  const listen = (type: string) => (e: Event) => seen.push({ type, detail: (e as CustomEvent).detail });
  const onDrop = listen('drop');
  const onSelf = listen('self-drop');
  window.addEventListener('column-relationship-drop', onDrop);
  window.addEventListener('column-relationship-self-drop', onSelf);
  try {
    fireEvent.mouseDown(row(from), { button: 0 });
    act(() => { vi.advanceTimersByTime(250); });
    document.elementFromPoint = () => row(onto);
    act(() => { window.dispatchEvent(new MouseEvent('mouseup', { clientX: 1, clientY: 1 })); });
  } finally {
    window.removeEventListener('column-relationship-drop', onDrop);
    window.removeEventListener('column-relationship-self-drop', onSelf);
  }
  return seen;
}

describe('ModelNode — dragging within one model (#133 L3)', () => {
  it('a drop on another column of the same node dispatches column-relationship-drop', () => {
    expect(dragWithin('manager_id', 'employee_id')).toEqual([{
      type: 'drop', detail: { fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id' },
    }]);
  });
  it('a drop on the same column dispatches the self-drop refusal', () => {
    expect(dragWithin('manager_id', 'manager_id')).toEqual([{ type: 'self-drop', detail: null }]);
  });
});
