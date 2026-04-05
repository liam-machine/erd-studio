/**
 * AnnotationNode — custom React Flow node for canvas build notes (post-it notes).
 *
 * Renders a coloured sticky note with inline text editing. Annotations are
 * temporary build notes — visible while constructing a model, then removed
 * once the work is done.
 *
 * Features:
 * - Inline toolbar (ellipsis button) with colour picker, link dropdown, delete
 * - Drag handle to link the note to a model (drag the chain icon to a model node)
 * - Handles on all 4 sides for closest-side edge routing
 */

import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AnnotationFlowNode } from '../../types/graph';
import { useEditorStore } from '../../store/editorStore';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import { ANNOTATION_COLORS } from '../../lib/annotationColors';
import type { AnnotationColor } from '../../../src/types/semantic';
import './AnnotationNode.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Invisible handles for edge routing (same pattern as ModelNode). */
const HANDLE_STYLE: CSSProperties = {
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  opacity: 0,
  pointerEvents: 'none',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function AnnotationNodeInner({ data }: NodeProps<AnnotationFlowNode>) {
  const vscode = useVsCodeApi();
  const editingAnnotationId = useEditorStore((s) => s.editingAnnotationId);
  const setEditingAnnotationId = useEditorStore((s) => s.setEditingAnnotationId);
  const domain = useEditorStore((s) => s.domain);
  const startAnnotationLinkDrag = useEditorStore((s) => s.startAnnotationLinkDrag);
  const selectedAnnotation = useEditorStore((s) => s.selectedAnnotation);
  const isSelected = selectedAnnotation === data.annotationId;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toolbarPanelRef = useRef<HTMLDivElement>(null);
  const toolbarToggleRef = useRef<HTMLButtonElement>(null);
  const [localText, setLocalText] = useState(data.text);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const isEditing = editingAnnotationId === data.annotationId;

  // Sync local text when data changes from extension
  useEffect(() => {
    if (!isEditing) {
      setLocalText(data.text);
    }
  }, [data.text, isEditing]);

  // Auto-focus when this annotation enters editing mode.
  // Use requestAnimationFrame to ensure the textarea is mounted after React commit.
  useEffect(() => {
    if (!isEditing) return;
    const tryFocus = () => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.select();
      }
    };
    // Immediate attempt + deferred attempt for newly created notes
    tryFocus();
    requestAnimationFrame(tryFocus);
  }, [isEditing]);

  // Close toolbar on click outside (capture phase to beat React Flow's event handling)
  useEffect(() => {
    if (!toolbarOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        toolbarPanelRef.current && !toolbarPanelRef.current.contains(e.target as Node) &&
        toolbarToggleRef.current && !toolbarToggleRef.current.contains(e.target as Node)
      ) {
        setToolbarOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside, true);
    return () => window.removeEventListener('mousedown', handleClickOutside, true);
  }, [toolbarOpen]);

  const commitText = useCallback(() => {
    setEditingAnnotationId(null);
    if (localText !== data.text) {
      vscode.postMessage({
        type: 'updateAnnotation',
        payload: { id: data.annotationId, text: localText },
      });
    }
  }, [localText, data.text, data.annotationId, vscode, setEditingAnnotationId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commitText();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setLocalText(data.text);
        setEditingAnnotationId(null);
      }
      // Stop propagation so React Flow doesn't handle keys while editing
      e.stopPropagation();
    },
    [commitText, data.text, setEditingAnnotationId],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!data.readOnly) {
        setEditingAnnotationId(data.annotationId);
      }
    },
    [data.readOnly, data.annotationId, setEditingAnnotationId],
  );

  const handleColorChange = useCallback(
    (color: AnnotationColor) => {
      vscode.postMessage({ type: 'updateAnnotation', payload: { id: data.annotationId, color } });
      setToolbarOpen(false);
    },
    [data.annotationId, vscode],
  );

  const handleLinkChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      e.stopPropagation();
      const val = e.target.value;
      vscode.postMessage({
        type: 'updateAnnotation',
        payload: { id: data.annotationId, linkedModel: val || null },
      });
    },
    [data.annotationId, vscode],
  );

  const handleDelete = useCallback(() => {
    vscode.postMessage({ type: 'removeAnnotation', payload: { id: data.annotationId } });
    setToolbarOpen(false);
  }, [data.annotationId, vscode]);

  // Drag-to-link: start drag from the link handle
  const handleLinkDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      startAnnotationLinkDrag(data.annotationId, e.clientX, e.clientY);
    },
    [data.annotationId, startAnnotationLinkDrag],
  );

  // Resize handle — drag from bottom-right corner
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState<{ startX: number; startY: number; startW: number; startH: number } | null>(null);
  const [resizeSize, setResizeSize] = useState<{ width: number; height: number } | null>(null);

  const handleResizePointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (data.readOnly) return;
      e.stopPropagation();
      e.preventDefault();
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setResizing({ startX: e.clientX, startY: e.clientY, startW: rect.width, startH: rect.height });
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [data.readOnly],
  );

  const handleResizePointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!resizing) return;
      const newW = Math.max(120, resizing.startW + (e.clientX - resizing.startX));
      const newH = Math.max(60, resizing.startH + (e.clientY - resizing.startY));
      setResizeSize({ width: Math.round(newW), height: Math.round(newH) });
    },
    [resizing],
  );

  const handleResizePointerUp = useCallback(
    (e: ReactPointerEvent) => {
      if (!resizing) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      const finalW = Math.max(120, resizing.startW + (e.clientX - resizing.startX));
      const finalH = Math.max(60, resizing.startH + (e.clientY - resizing.startY));
      vscode.postMessage({
        type: 'updateAnnotation',
        payload: { id: data.annotationId, width: Math.round(finalW), height: Math.round(finalH) },
      });
      setResizing(null);
      setResizeSize(null);
    },
    [resizing, data.annotationId, vscode],
  );

  const handleResizePointerCancel = useCallback(
    (e: ReactPointerEvent) => {
      if (!resizing) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      setResizing(null);
      setResizeSize(null);
    },
    [resizing],
  );

  const colorClass = `annotation-node--${data.color}`;
  const style: React.CSSProperties = {};
  if (resizeSize) {
    style.width = resizeSize.width;
    style.height = resizeSize.height;
  } else {
    if (data.width) style.width = data.width;
    if (data.height) style.height = data.height;
  }

  const modelNames = domain?.models.map((m) => m.name) ?? [];

  return (
    <div
      ref={containerRef}
      className={`annotation-node ${colorClass}${data.readOnly ? ' annotation-node--readonly' : ''}${isSelected ? ' annotation-node--selected' : ''}`}
      style={style}
      onDoubleClick={handleDoubleClick}
    >
      {/* Inline toolbar — visible on hover */}
      {!data.readOnly && (
        <div className="annotation-node__toolbar">
          {/* Drag-to-link handle */}
          <div
            className="annotation-node__link-handle nodrag"
            onMouseDown={handleLinkDragStart}
            title="Drag to a model to link"
          >
            &#x1F517;
          </div>
          <button
            ref={toolbarToggleRef}
            className="annotation-node__toolbar-toggle"
            onClick={(e) => { e.stopPropagation(); setToolbarOpen(!toolbarOpen); }}
            title="Note options"
          >
            &#x22EF;
          </button>
          {toolbarOpen && (
            <div ref={toolbarPanelRef} className="annotation-node__toolbar-panel nodrag nowheel" onClick={(e) => e.stopPropagation()}>
              {/* Colour swatches */}
              <div className="annotation-node__color-row">
                {ANNOTATION_COLORS.map((opt) => (
                  <button
                    key={opt.value}
                    className={`annotation-node__color-swatch${data.color === opt.value ? ' annotation-node__color-swatch--active' : ''}`}
                    style={{ backgroundColor: opt.swatch }}
                    onClick={() => handleColorChange(opt.value)}
                    title={opt.label}
                  />
                ))}
              </div>
              {/* Link to model (fallback dropdown) */}
              <div className="annotation-node__link-row">
                <select
                  className="annotation-node__link-select nodrag"
                  value={data.linkedModel ?? ''}
                  onChange={handleLinkChange}
                >
                  <option value="">No link</option>
                  {modelNames.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
              {/* Delete */}
              <button className="annotation-node__delete-btn" onClick={handleDelete}>
                Remove note
              </button>
            </div>
          )}
        </div>
      )}

      {/* Text area — nodrag prevents React Flow drag when interacting with textarea/resize */}
      {isEditing && !data.readOnly ? (
        <textarea
          ref={textareaRef}
          className="annotation-node__textarea nodrag nowheel"
          value={localText}
          onChange={(e) => setLocalText(e.target.value)}
          onBlur={commitText}
          onKeyDown={handleKeyDown}
          placeholder="Type a build note..."
        />
      ) : (
        <div className="annotation-node__text">
          {data.text || (
            <span className="annotation-node__placeholder">
              Double-click to edit...
            </span>
          )}
        </div>
      )}

      {/* Linked model badge */}
      {data.linkedModel && (
        <div className="annotation-node__link-badge" title={`Linked to ${data.linkedModel}`}>
          &#x1F517; {data.linkedModel}
        </div>
      )}

      {/* Resize handle (bottom-right corner) */}
      {!data.readOnly && (
        <div
          className="annotation-node__resize-handle nodrag"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerCancel}
        />
      )}

      {/* Invisible handles on all 4 sides for closest-side edge routing */}
      <Handle type="source" position={Position.Top} id="node-top-src" style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} id="node-right-src" style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} id="node-bottom-src" style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Left} id="node-left-src" style={HANDLE_STYLE} />
    </div>
  );
}

export const AnnotationNode = memo(AnnotationNodeInner);
