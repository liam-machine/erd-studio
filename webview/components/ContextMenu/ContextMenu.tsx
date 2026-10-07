/**
 * ContextMenu — context menu for graph elements.
 *
 * Supports FK edges and model nodes.
 * Shows relationship details, cardinality editing, edit option, and delete option.
 * Positioned at cursor location, closes on click-outside or Escape.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import type { FkEdgeData } from '@erd-studio/renderer/editor';
import type { AnnotationColor, Cardinality } from '../../../src/types/semantic';
import type { FkDialogEditData } from '../../store/editorStore';
import { directionFor } from '../../lib/relationshipDirection';
import {
  ANNOTATION_COLORS,
  relationshipSwap,
  removeRelationshipRequest,
  updateCardinalityRequest,
} from '@erd-studio/renderer/editor';
import './ContextMenu.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Padding from viewport edge when repositioning. */
const VIEWPORT_PADDING = 8;

/**
 * The cardinalities the menu offers. No "One → Many": that is the same
 * relationship read from the other end, stored as many-to-one on the other
 * model (#133) — ⇄ makes the other side the many one.
 */
export const CARDINALITY_OPTIONS: { value: Cardinality; label: string }[] = [
  { value: 'many-to-one', label: 'Many → One' },
  { value: 'one-to-one', label: 'One → One' },
  { value: 'many-to-many', label: 'Many → Many' },
];

/** Label for a cardinality, including a one-to-many shown on a read-only stage. */
const CARDINALITY_LABEL: Record<Cardinality, string> = {
  'many-to-one': 'Many → One',
  'one-to-one': 'One → One',
  'one-to-many': 'One → Many',
  'many-to-many': 'Many → Many',
};

/** The Edit dialog's data for an edge, as drawn plus its stored ends. */
function editDataFor(data: FkEdgeData): FkDialogEditData {
  const { fromModel, fromColumn, toModel, toColumn, cardinality, role, stored } = data;
  return {
    fromModel,
    fromColumn,
    toModel,
    toColumn,
    cardinality,
    ...(role ? { role } : {}),
    ...(stored ? { stored } : {}),
  };
}

/**
 * Whether changing an edge to `next` needs the user to say which side has
 * many rows: a many-to-many's ends were never a direction choice (it has no
 * "many" side), so turning it into a many-to-one or one-to-one when the keys
 * do not settle the direction must ask — in the Edit dialog — rather than
 * make whichever model the drag started on the many side (#133).
 */
export function cardinalityChangeNeedsDirection(
  data: Pick<FkEdgeData, 'fromModel' | 'fromColumn' | 'toModel' | 'toColumn' | 'cardinality'>,
  next: Cardinality,
  models: Parameters<typeof directionFor>[0],
): boolean {
  if (data.cardinality !== 'many-to-many' || next === 'many-to-many') return false;
  return directionFor(models, data)?.confidence === 'ambiguous';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ContextMenu() {
  const vscode = useVsCodeApi();
  const menuRef = useRef<HTMLDivElement>(null);
  const cardinalityButtonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLUListElement>(null);

  const contextMenu = useEditorStore((s) => s.contextMenu);
  const closeContextMenu = useEditorStore((s) => s.closeContextMenu);
  const openFkDialogForEdit = useEditorStore((s) => s.openFkDialogForEdit);
  const domain = useEditorStore((s) => s.domain);
  const isReadOnly = domain?.readOnly ?? false;

  // Track whether cardinality dropdown is open
  const [cardinalityOpen, setCardinalityOpen] = useState(false);
  // Track whether dropdown should flip upward
  const [dropdownFlipped, setDropdownFlipped] = useState(false);

  // Track delete confirmation state (two-click pattern)
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Adjusted position to keep menu within viewport
  const [adjustedPosition, setAdjustedPosition] = useState<{ x: number; y: number } | null>(null);

  // Reset state when context menu closes
  useEffect(() => {
    if (!contextMenu) {
      setCardinalityOpen(false);
      setConfirmingDelete(false);
      setAdjustedPosition(null);
    }
  }, [contextMenu]);

  // Adjust position after render to keep menu within viewport bounds
  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) return;

    setConfirmingDelete(false);

    const menu = menuRef.current;
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let newX = contextMenu.x;
    let newY = contextMenu.y;

    if (contextMenu.x + menuRect.width > viewportWidth - VIEWPORT_PADDING) {
      newX = contextMenu.x - menuRect.width;
    }

    if (contextMenu.y + menuRect.height > viewportHeight - VIEWPORT_PADDING) {
      newY = contextMenu.y - menuRect.height;
    }

    newX = Math.max(VIEWPORT_PADDING, Math.min(newX, viewportWidth - menuRect.width - VIEWPORT_PADDING));
    newY = Math.max(VIEWPORT_PADDING, Math.min(newY, viewportHeight - menuRect.height - VIEWPORT_PADDING));

    setAdjustedPosition({ x: newX, y: newY });
  }, [contextMenu]);

  // Adjust cardinality dropdown position when it opens
  useLayoutEffect(() => {
    if (!cardinalityOpen || !cardinalityButtonRef.current || !dropdownRef.current) {
      setDropdownFlipped(false);
      return;
    }

    const buttonRect = cardinalityButtonRef.current.getBoundingClientRect();
    const dropdownRect = dropdownRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;

    const spaceBelow = viewportHeight - buttonRect.bottom;
    const spaceAbove = buttonRect.top;
    const dropdownHeight = dropdownRect.height;

    if (spaceBelow < dropdownHeight + VIEWPORT_PADDING && spaceAbove > dropdownHeight + VIEWPORT_PADDING) {
      setDropdownFlipped(true);
    } else {
      setDropdownFlipped(false);
    }
  }, [cardinalityOpen]);

  // Close on click outside
  useEffect(() => {
    if (!contextMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [contextMenu, closeContextMenu]);

  // Close on Escape key
  useEffect(() => {
    if (!contextMenu) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (cardinalityOpen) {
          setCardinalityOpen(false);
        } else {
          closeContextMenu();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [contextMenu, closeContextMenu, cardinalityOpen]);

  // Handle delete relationship with confirmation
  const handleDeleteClick = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'edge') return;

    if (!confirmingDelete) {
      setConfirmingDelete(true);
    } else {
      // The stored ends travel with it, so the copy on disk is the one removed (#133).
      vscode.postMessage(removeRelationshipRequest(contextMenu.data));
      closeContextMenu();
    }
  }, [contextMenu, vscode, closeContextMenu, confirmingDelete]);

  // Handle cardinality change
  const handleCardinalityChange = useCallback(
    (newCardinality: Cardinality) => {
      if (!contextMenu || contextMenu.type !== 'edge') return;

      if (cardinalityChangeNeedsDirection(contextMenu.data, newCardinality, domain?.models ?? [])) {
        // The direction is the user's to pick: open Edit with this cardinality chosen.
        openFkDialogForEdit({ ...editDataFor(contextMenu.data), pickedCardinality: newCardinality });
      } else {
        vscode.postMessage(updateCardinalityRequest(contextMenu.data, newCardinality));
      }
      setCardinalityOpen(false);
      closeContextMenu();
    },
    [contextMenu, vscode, closeContextMenu, openFkDialogForEdit, domain],
  );

  // Handle ⇄: flip the many side of a many-to-one, or swap the ends of a
  // one-to-one / many-to-many (an edit with the role kept) (#133).
  const handleSwapCardinality = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'edge') return;

    vscode.postMessage(relationshipSwap(contextMenu.data).request);
    closeContextMenu();
  }, [contextMenu, vscode, closeContextMenu]);

  // Handle edit relationship (open the FK dialog in edit mode)
  const handleEditClick = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'edge') return;

    openFkDialogForEdit(editDataFor(contextMenu.data));
    closeContextMenu();
  }, [contextMenu, openFkDialogForEdit, closeContextMenu]);

  // --- Early return if not visible ---
  if (!contextMenu) return null;

  // --- Node context menu ---
  if (contextMenu.type === 'node') {
    const { modelName } = contextMenu;

    const displayX = adjustedPosition?.x ?? contextMenu.x;
    const displayY = adjustedPosition?.y ?? contextMenu.y;

    return (
      <div
        ref={menuRef}
        className="context-menu"
        style={{
          left: displayX,
          top: displayY,
          visibility: adjustedPosition ? 'visible' : 'hidden',
        }}
        role="menu"
      >
        <div className="context-menu__header">
          <span className="context-menu__title">{modelName}</span>
        </div>
      </div>
    );
  }

  // --- Annotation context menu ---
  if (contextMenu.type === 'annotation') {
    const { annotationId } = contextMenu;
    const displayX = adjustedPosition?.x ?? contextMenu.x;
    const displayY = adjustedPosition?.y ?? contextMenu.y;

    // Find annotation's linked model from domain viewConfig
    const annotation = domain?.viewConfig.annotations?.find((a) => a.id === annotationId);
    const isLinked = !!annotation?.linkedModel;

    const handleDeleteAnnotation = () => {
      vscode.postMessage({ type: 'removeAnnotation', payload: { id: annotationId } });
      closeContextMenu();
    };

    const handleColorChange = (color: AnnotationColor) => {
      vscode.postMessage({ type: 'updateAnnotation', payload: { id: annotationId, color } });
      closeContextMenu();
    };

    const handleLinkModel = (modelName: string) => {
      vscode.postMessage({ type: 'updateAnnotation', payload: { id: annotationId, linkedModel: modelName } });
      closeContextMenu();
    };

    const handleUnlink = () => {
      vscode.postMessage({ type: 'updateAnnotation', payload: { id: annotationId, linkedModel: null } });
      closeContextMenu();
    };

    return (
      <div
        ref={menuRef}
        className="context-menu"
        style={{
          left: displayX,
          top: displayY,
          visibility: adjustedPosition ? 'visible' : 'hidden',
        }}
        role="menu"
      >
        <div className="context-menu__header">
          <span className="context-menu__title">Note</span>
          {!isReadOnly && (
            <div className="context-menu__header-actions">
              <button
                className="context-menu__delete-link"
                onClick={handleDeleteAnnotation}
                role="menuitem"
              >
                Remove
              </button>
            </div>
          )}
        </div>

        {!isReadOnly && (
          <div className="context-menu__info">
            {/* Colour picker */}
            <div className="context-menu__row">
              <span className="context-menu__label">Color</span>
              <div className="context-menu__color-swatches">
                {ANNOTATION_COLORS.map((opt) => (
                  <button
                    key={opt.value}
                    className="context-menu__color-swatch"
                    style={{ backgroundColor: opt.swatch }}
                    title={opt.label}
                    onClick={() => handleColorChange(opt.value)}
                    aria-label={`Set color to ${opt.label}`}
                  />
                ))}
              </div>
            </div>

            {/* Link to model */}
            {domain && domain.models.length > 0 && (
              <div className="context-menu__row">
                <span className="context-menu__label">Link to</span>
                <select
                  className="context-menu__link-select"
                  value={annotation?.linkedModel ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val) handleLinkModel(val);
                    else handleUnlink();
                  }}
                >
                  <option value="">None</option>
                  {domain.models.map((m) => (
                    <option key={m.name} value={m.name}>{m.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Unlink shortcut when linked */}
            {isLinked && (
              <div className="context-menu__row">
                <button
                  className="context-menu__edit-link"
                  onClick={handleUnlink}
                  role="menuitem"
                >
                  Unlink from {annotation?.linkedModel}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // --- Edge context menu ---
  const edge = contextMenu.data as FkEdgeData;

  // Ghost edges exist only in the comparison stage — block mutations
  const isGhostEdge = edge.discrepancyStatus === 'missing';
  const isEditable = !isReadOnly && !isGhostEdge;

  // Get current cardinality label
  const cardinalityLabel = CARDINALITY_LABEL[edge.cardinality] ?? edge.cardinality;
  const swap = relationshipSwap(edge);

  const displayX = adjustedPosition?.x ?? contextMenu.x;
  const displayY = adjustedPosition?.y ?? contextMenu.y;

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        left: displayX,
        top: displayY,
        visibility: adjustedPosition ? 'visible' : 'hidden',
      }}
      role="menu"
    >
      {/* Relationship details header */}
      <div className="context-menu__header">
        <span className="context-menu__title">Relationship</span>
        {isEditable && (
          <div className="context-menu__header-actions">
            <button
              className="context-menu__edit-link"
              onClick={handleEditClick}
              role="menuitem"
            >
              Edit...
            </button>
            <button
              className={`context-menu__delete-link${confirmingDelete ? ' context-menu__delete-link--confirming' : ''}`}
              onClick={handleDeleteClick}
              role="menuitem"
            >
              {confirmingDelete ? 'Confirm?' : 'Remove'}
            </button>
          </div>
        )}
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

        {/* Cardinality with dropdown (editable) or label (read-only) */}
        <div className="context-menu__row context-menu__row--cardinality">
          <span className="context-menu__label">Cardinality</span>
          {!isEditable ? (
            <span className="context-menu__value">{cardinalityLabel}</span>
          ) : (
            <div className="context-menu__cardinality-control">
              <div className="context-menu__cardinality-wrapper">
                <button
                  ref={cardinalityButtonRef}
                  className="context-menu__cardinality-button"
                  onClick={() => setCardinalityOpen(!cardinalityOpen)}
                  aria-haspopup="listbox"
                  aria-expanded={cardinalityOpen}
                >
                  {cardinalityLabel}
                  <span className={`context-menu__cardinality-arrow${dropdownFlipped ? ' context-menu__cardinality-arrow--flipped' : ''}`}>▾</span>
                </button>
                {cardinalityOpen && (
                  <ul
                    ref={dropdownRef}
                    className={`context-menu__cardinality-dropdown${dropdownFlipped ? ' context-menu__cardinality-dropdown--flipped' : ''}`}
                    role="listbox"
                  >
                    {CARDINALITY_OPTIONS.map((option) => (
                      <li
                        key={option.value}
                        className={`context-menu__cardinality-option${
                          option.value === edge.cardinality ? ' context-menu__cardinality-option--selected' : ''
                        }`}
                        role="option"
                        aria-selected={option.value === edge.cardinality}
                        onClick={() => handleCardinalityChange(option.value)}
                      >
                        {option.label}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                className="context-menu__swap-btn"
                onClick={handleSwapCardinality}
                title={swap.title}
                aria-label={swap.title}
              >
                &#x21c4;
              </button>
            </div>
          )}
        </div>
      </div>
      {isGhostEdge && (
        <div className="context-menu__ghost-hint">
          Only in comparison stage — use Sync to add
        </div>
      )}
    </div>
  );
}
