/**
 * ColumnTooltip — hover tooltip showing column details on the canvas.
 *
 * Renders via a React Portal to document.body so it is never clipped by
 * the ModelNode's `overflow: hidden`. Positioned with `position: fixed`
 * using the anchor element's bounding rect. Automatically flips below
 * the row if there isn't enough space above.
 *
 * Uses a callback ref (not useLayoutEffect + setState) to measure and
 * position the tooltip exactly once when it mounts — avoiding infinite
 * render loops.
 */

import { useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { ColumnDisplay } from '../../types/graph';
import './ColumnTooltip.css';

// ---------------------------------------------------------------------------
// Human-readable labels
// ---------------------------------------------------------------------------

const SCD_LABELS: Record<number, string> = {
  0: 'Type 0 — Fixed (never changes)',
  1: 'Type 1 — Overwrite',
  2: 'Type 2 — Track history',
};

const ADDITIVE_LABELS: Record<string, string> = {
  'additive': 'Additive — can be summed across all dimensions',
  'semi-additive': 'Semi-additive — can be summed across some dimensions',
  'non-additive': 'Non-additive — cannot be summed',
};

/** Minimum space (px) above anchor before the tooltip flips below. */
const FLIP_THRESHOLD = 80;

/** Gap (px) between anchor and tooltip. */
const TOOLTIP_GAP = 6;

// ---------------------------------------------------------------------------
// Content check — exported so parent can skip hover timer when there's nothing
// ---------------------------------------------------------------------------

/** Returns true if this column has tooltip-worthy metadata. */
export function hasTooltipContent(column: ColumnDisplay): boolean {
  return !!(
    column.description ||
    column.isPrimaryKey ||
    column.isForeignKey ||
    column.isNaturalKey ||
    column.scdType != null ||
    column.additiveType
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ColumnTooltipProps {
  column: ColumnDisplay;
  /** The column row element used to calculate position. */
  anchorRef: React.RefObject<HTMLDivElement | null>;
  /** Whether the tooltip should be visible. */
  visible: boolean;
}

export function ColumnTooltip({ column, anchorRef, visible }: ColumnTooltipProps) {
  // Build content data
  const keys: string[] = [];
  if (column.isPrimaryKey) keys.push('Primary Key');
  if (column.isForeignKey) keys.push('Foreign Key');
  if (column.isNaturalKey) keys.push('Natural Key');

  const hasExtras = keys.length > 0 || column.scdType != null || column.additiveType;
  const hasDescription = !!column.description;
  const hasContent = hasDescription || hasExtras;

  /**
   * Callback ref — fires once when the tooltip div mounts into the portal.
   * Reads the anchor's bounding rect, measures the tooltip, and sets
   * position directly on the DOM element. No setState, no re-render.
   */
  const positionRef = useCallback(
    (tooltip: HTMLDivElement | null) => {
      if (!tooltip || !anchorRef.current) return;

      const anchorRect = anchorRef.current.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();

      // Centre horizontally on the anchor
      let left = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;

      // Clamp to viewport edges (8px padding)
      left = Math.max(8, Math.min(left, window.innerWidth - tooltipRect.width - 8));

      // Default: above. Flip below if not enough space above.
      const flipped = anchorRect.top < FLIP_THRESHOLD + tooltipRect.height;
      const top = flipped
        ? anchorRect.bottom + TOOLTIP_GAP
        : anchorRect.top - tooltipRect.height - TOOLTIP_GAP;

      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${left}px`;

      if (flipped) {
        tooltip.classList.add('column-tooltip--flipped');
      }

      // Fade in after positioning (avoids flash at 0,0)
      tooltip.classList.add('column-tooltip--visible');
    },
    [anchorRef],
  );

  // Nothing to show — bail before portal
  if (!hasContent || !visible) return null;

  return createPortal(
    <div ref={positionRef} className="column-tooltip">
      <div className="column-tooltip__header">
        <span className="column-tooltip__name">{column.name}</span>
        <span className="column-tooltip__type">{column.dataType}</span>
      </div>

      {hasDescription && (
        <div className="column-tooltip__description">{column.description}</div>
      )}

      {hasExtras && (
        <div className="column-tooltip__details">
          {keys.length > 0 && (
            <div className="column-tooltip__row">
              <span className="column-tooltip__label">Keys</span>
              <span className="column-tooltip__value">{keys.join(', ')}</span>
            </div>
          )}
          {column.scdType != null && (
            <div className="column-tooltip__row">
              <span className="column-tooltip__label">SCD</span>
              <span className="column-tooltip__value">{SCD_LABELS[column.scdType] ?? `Type ${column.scdType}`}</span>
            </div>
          )}
          {column.additiveType && (
            <div className="column-tooltip__row">
              <span className="column-tooltip__label">Measure</span>
              <span className="column-tooltip__value">{ADDITIVE_LABELS[column.additiveType] ?? column.additiveType}</span>
            </div>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
