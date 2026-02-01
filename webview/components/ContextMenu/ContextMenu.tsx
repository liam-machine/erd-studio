/**
 * ContextMenu — context menu for graph elements.
 *
 * Currently supports FK edges only.
 * Shows relationship details, cardinality editing, and delete option.
 * Positioned at cursor location, closes on click-outside or Escape.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import type { FkEdgeData } from '../../types/graph';
import type { Cardinality } from '../../../src/types/semantic';
import './ContextMenu.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Padding from viewport edge when repositioning. */
const VIEWPORT_PADDING = 8;

/** All supported cardinality types with display labels. */
const CARDINALITY_OPTIONS: { value: Cardinality; label: string }[] = [
  { value: 'many-to-one', label: 'Many → One' },
  { value: 'one-to-one', label: 'One → One' },
  { value: 'one-to-many', label: 'One → Many' },
  { value: 'many-to-many', label: 'Many → Many' },
];

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

    // Reset confirmation state when menu opens at new position
    setConfirmingDelete(false);

    const menu = menuRef.current;
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let newX = contextMenu.x;
    let newY = contextMenu.y;

    // Check if menu overflows right edge - flip to left of click point
    if (contextMenu.x + menuRect.width > viewportWidth - VIEWPORT_PADDING) {
      // Position menu to the left of the click point
      newX = contextMenu.x - menuRect.width;
    }

    // Check if menu overflows bottom edge - flip to above click point
    if (contextMenu.y + menuRect.height > viewportHeight - VIEWPORT_PADDING) {
      // Position menu above the click point
      newY = contextMenu.y - menuRect.height;
    }

    // Final safety: ensure menu is within bounds
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

    // Check if dropdown would overflow bottom of viewport
    const spaceBelow = viewportHeight - buttonRect.bottom;
    const spaceAbove = buttonRect.top;
    const dropdownHeight = dropdownRect.height;

    // Flip upward if not enough space below but enough space above
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
      // First click: show confirmation
      setConfirmingDelete(true);
    } else {
      // Second click: actually delete
      const { fromModel, fromColumn, toModel, toColumn } = contextMenu.data;
      vscode.postMessage({
        type: 'removeRelationship',
        payload: { fromModel, fromColumn, toModel, toColumn },
      });
      closeContextMenu();
    }
  }, [contextMenu, vscode, closeContextMenu, confirmingDelete]);

  // Handle cardinality change
  const handleCardinalityChange = useCallback(
    (newCardinality: Cardinality) => {
      if (!contextMenu || contextMenu.type !== 'edge') return;

      const { fromModel, fromColumn, toModel, toColumn } = contextMenu.data;
      vscode.postMessage({
        type: 'updateRelationship',
        payload: { fromModel, fromColumn, toModel, toColumn, cardinality: newCardinality },
      });
      setCardinalityOpen(false);
      closeContextMenu();
    },
    [contextMenu, vscode, closeContextMenu],
  );

  // --- Early return if not visible ---
  if (!contextMenu) return null;

  // Currently only edge context menus are supported
  if (contextMenu.type !== 'edge') return null;

  const edge = contextMenu.data as FkEdgeData;
  const isDesign = edge.status === 'design';

  // Get current cardinality label
  const currentOption = CARDINALITY_OPTIONS.find((opt) => opt.value === edge.cardinality);
  const cardinalityLabel = currentOption?.label ?? edge.cardinality;

  // Use adjusted position if available, otherwise use original position
  const displayX = adjustedPosition?.x ?? contextMenu.x;
  const displayY = adjustedPosition?.y ?? contextMenu.y;

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        left: displayX,
        top: displayY,
        // Hide until position is calculated to prevent flash at wrong position
        visibility: adjustedPosition ? 'visible' : 'hidden',
      }}
      role="menu"
    >
      {/* Relationship details header */}
      <div className="context-menu__header">
        <span className="context-menu__title">Relationship</span>
        <div className="context-menu__header-actions">
          {isDesign && (
            <button
              className={`context-menu__delete-link${confirmingDelete ? ' context-menu__delete-link--confirming' : ''}`}
              onClick={handleDeleteClick}
              role="menuitem"
            >
              {confirmingDelete ? 'Confirm?' : 'Remove'}
            </button>
          )}
          <span className={`context-menu__status context-menu__status--${edge.status}`}>
            {edge.status}
          </span>
        </div>
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

        {/* Cardinality with dropdown */}
        <div className="context-menu__row context-menu__row--cardinality">
          <span className="context-menu__label">Cardinality</span>
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
        </div>
      </div>

    </div>
  );
}
