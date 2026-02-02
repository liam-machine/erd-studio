/**
 * DragLine — visual feedback for column drag-to-connect relationships.
 *
 * Renders a dashed orange line from the source column to the current cursor
 * position while dragging. Uses design edge styling to indicate this will
 * create a design relationship.
 */

import { useEditorStore } from '../../store/editorStore';
import './DragLine.css';

export function DragLine() {
  const dragLineState = useEditorStore((s) => s.dragLineState);

  if (!dragLineState) return null;

  const { sourceX, sourceY, currentX, currentY } = dragLineState;

  return (
    <svg
      className="drag-line"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 1000,
      }}
    >
      <defs>
        <marker
          id="drag-line-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge-design)" />
        </marker>
      </defs>
      <line
        x1={sourceX}
        y1={sourceY}
        x2={currentX}
        y2={currentY}
        className="drag-line__path"
        markerEnd="url(#drag-line-arrow)"
      />
    </svg>
  );
}
