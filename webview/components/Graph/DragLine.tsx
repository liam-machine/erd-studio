/**
 * DragLine — visual feedback for drag-to-connect operations.
 *
 * Renders either:
 * - A dashed line in the relationship colour for column drag-to-connect (FK
 *   relationship creation), with a dot where it starts
 * - A dashed grey line for annotation drag-to-link (annotation linking)
 *
 * Both use fixed-position SVG overlays that follow the cursor.
 */

import { useEditorStore } from '../../store/editorStore';
import './DragLine.css';

export function DragLine() {
  const dragLineState = useEditorStore((s) => s.dragLineState);
  const annotationLinkDrag = useEditorStore((s) => s.annotationLinkDrag);

  if (!dragLineState && !annotationLinkDrag) return null;

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
          markerWidth="5"
          markerHeight="5"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge-design)" />
        </marker>
      </defs>

      {/* FK column drag line */}
      {dragLineState && (
        <>
          <line
            x1={dragLineState.sourceX}
            y1={dragLineState.sourceY}
            x2={dragLineState.currentX}
            y2={dragLineState.currentY}
            className="drag-line__path"
            markerEnd="url(#drag-line-arrow)"
          />
          <circle
            cx={dragLineState.sourceX}
            cy={dragLineState.sourceY}
            r={4}
            className="drag-line__origin"
          />
        </>
      )}

      {/* Annotation link drag line */}
      {annotationLinkDrag && (
        <>
          <line
            x1={annotationLinkDrag.sourceX}
            y1={annotationLinkDrag.sourceY}
            x2={annotationLinkDrag.currentX}
            y2={annotationLinkDrag.currentY}
            className="drag-line__path drag-line__path--annotation"
          />
          <circle
            cx={annotationLinkDrag.sourceX}
            cy={annotationLinkDrag.sourceY}
            r={3}
            className="drag-line__origin drag-line__origin--annotation"
          />
        </>
      )}
    </svg>
  );
}
