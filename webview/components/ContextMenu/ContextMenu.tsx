/**
 * ContextMenu — minimal context menu for graph elements.
 *
 * Currently supports FK edges only (F401 minimal implementation).
 * Shows relationship details and delete option for design relationships.
 * Positioned at cursor location, closes on click-outside or Escape.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import type { FkEdgeData } from '../../types/graph';
import './ContextMenu.css';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ContextMenu() {
  const vscode = useVsCodeApi();
  const menuRef = useRef<HTMLDivElement>(null);

  const contextMenu = useEditorStore((s) => s.contextMenu);
  const closeContextMenu = useEditorStore((s) => s.closeContextMenu);

  // Close on click outside
  useEffect(() => {
    if (!contextMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };

    // Use mousedown for immediate response
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [contextMenu, closeContextMenu]);

  // Close on Escape key
  useEffect(() => {
    if (!contextMenu) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeContextMenu();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [contextMenu, closeContextMenu]);

  // Handle delete relationship
  const handleDelete = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'edge') return;

    const { fromModel, fromColumn, toModel, toColumn } = contextMenu.data;
    vscode.postMessage({
      type: 'removeRelationship',
      payload: { fromModel, fromColumn, toModel, toColumn },
    });
    closeContextMenu();
  }, [contextMenu, vscode, closeContextMenu]);

  // --- Early return if not visible ---
  if (!contextMenu) return null;

  // Currently only edge context menus are supported
  if (contextMenu.type !== 'edge') return null;

  const edge = contextMenu.data as FkEdgeData;
  const isDesign = edge.status === 'design';

  // Format cardinality for display
  const cardinalityLabel = edge.cardinality === 'many-to-one' ? 'Many → One' : 'One → One';

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        left: contextMenu.x,
        top: contextMenu.y,
      }}
      role="menu"
    >
      {/* Relationship details header */}
      <div className="context-menu__header">
        <span className="context-menu__title">Relationship</span>
        <span className={`context-menu__status context-menu__status--${edge.status}`}>
          {edge.status}
        </span>
      </div>

      {/* Relationship info */}
      <div className="context-menu__info">
        <div className="context-menu__row">
          <span className="context-menu__label">From</span>
          <span className="context-menu__value">
            {edge.fromModel}.<strong>{edge.fromColumn}</strong>
          </span>
        </div>
        <div className="context-menu__row">
          <span className="context-menu__label">To</span>
          <span className="context-menu__value">
            {edge.toModel}.<strong>{edge.toColumn}</strong>
          </span>
        </div>
        <div className="context-menu__row">
          <span className="context-menu__label">Cardinality</span>
          <span className="context-menu__value">{cardinalityLabel}</span>
        </div>
      </div>

      {/* Delete option (design only) */}
      {isDesign && (
        <>
          <div className="context-menu__divider" />
          <button
            className="context-menu__item context-menu__item--danger"
            onClick={handleDelete}
            role="menuitem"
          >
            Delete Relationship
          </button>
        </>
      )}
    </div>
  );
}
