/**
 * useColumnReorder — drag-to-reorder state machine for column lists.
 *
 * Uses imperative mouse events (matching the existing useLongPressDrag pattern).
 * Returns drag state, handle props for each row, and the optimistic display order.
 *
 * Works in both DetailPanel (ColumnRowEditor rows) and ModelNode (ColumnRow rows)
 * by accepting configurable CSS selectors for the container and row elements.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Column {
  name: string;
}

interface UseColumnReorderOptions<T extends Column> {
  /** Source-of-truth columns from the extension. */
  columns: T[];
  /** Called on drop with the final ordered column names. */
  onReorder: (orderedNames: string[]) => void;
  /** CSS selector for the scrollable list container (walked up from the handle). */
  containerSelector?: string;
  /** CSS selector for individual row elements within the container. */
  rowSelector?: string;
}

interface UseColumnReorderReturn<T extends Column> {
  /** Columns in display order (same as input — reorder applied on drop). */
  orderedColumns: T[];
  /** Index of the row currently being dragged, or null. */
  dragIndex: number | null;
  /** Current insertion point index, or null. */
  dropIndex: number | null;
  /** Props to spread onto the drag handle element for a given row index. */
  getDragHandleProps: (index: number) => {
    onMouseDown: (e: React.MouseEvent) => void;
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useColumnReorder<T extends Column>({
  columns,
  onReorder,
  containerSelector = '.column-editor__list',
  rowSelector = '.column-row-editor',
}: UseColumnReorderOptions<T>): UseColumnReorderReturn<T> {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const isDragging = dragIndex !== null;

  // Mirror dropIndex in a ref so handleMouseUp can read it synchronously
  const dropIndexRef = useRef<number | null>(null);

  // Ref to the list container — found by walking up from the drag handle
  const listRef = useRef<HTMLElement | null>(null);

  // Store onReorder in a ref to avoid stale closures
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  // Store columns in a ref for use in event handlers
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  // Store selectors in refs
  const rowSelectorRef = useRef(rowSelector);
  rowSelectorRef.current = rowSelector;

  // During drag, columns stay in original order — the drop indicator shows where
  // the dragged row will land. Reorder is applied only on drop.
  const orderedColumns = columns;

  // Global mouse/key listeners active during drag
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!listRef.current) return;

      const rows = Array.from(listRef.current.querySelectorAll(rowSelectorRef.current));
      if (rows.length === 0) return;

      // Find which row the mouse is over based on vertical position
      let targetIndex = rows.length - 1;
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
          targetIndex = i;
          break;
        }
      }

      dropIndexRef.current = targetIndex;
      setDropIndex(targetIndex);
    };

    const handleMouseUp = () => {
      const cols = columnsRef.current;
      const from = dragIndex;
      const to = dropIndexRef.current;

      setDragIndex(null);
      setDropIndex(null);
      dropIndexRef.current = null;

      if (from !== null && to !== null && from !== to) {
        const result = cols.slice();
        const [moved] = result.splice(from, 1);
        result.splice(to, 0, moved);
        onReorderRef.current(result.map((c) => c.name));
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDragIndex(null);
        setDropIndex(null);
        dropIndexRef.current = null;
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isDragging, dragIndex]);

  const containerSelectorRef = useRef(containerSelector);
  containerSelectorRef.current = containerSelector;

  const getDragHandleProps = useCallback(
    (index: number) => ({
      onMouseDown: (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Walk up to find the list container
        const handle = e.currentTarget as HTMLElement;
        const list = handle.closest(containerSelectorRef.current);
        if (list) {
          listRef.current = list as HTMLElement;
        }
        setDragIndex(index);
        dropIndexRef.current = index;
        setDropIndex(index);
      },
    }),
    [],
  );

  return {
    orderedColumns,
    dragIndex,
    dropIndex,
    getDragHandleProps,
  };
}
