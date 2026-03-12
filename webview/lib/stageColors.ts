/**
 * Stage colour constants.
 *
 * Fixed colour scheme for the two design stages.
 *
 * CSS classes use `var(--stage-*)` custom properties defined in theme.css.
 * This module provides raw hex values for contexts that cannot use CSS
 * variables (e.g., React Flow MiniMap `nodeColor` callback).
 */

/** Hex border colours keyed by stage name (or 'ghost' for missing nodes). */
export const STAGE_HEX: Record<string, string> = {
  logical:    '#60a5fa',  // Blue-400
  physical:   '#22c55e',  // Green-500
  ghost:      '#9ca3af',  // Gray-400
};

/**
 * Return the hex border colour for a node given its stage and ghost state.
 * Used by MiniMap's `nodeColor` callback which needs raw colour values.
 */
export function stageNodeColor(stage: string, isGhost?: boolean): string {
  if (isGhost) return STAGE_HEX.ghost;
  return STAGE_HEX[stage] ?? STAGE_HEX.ghost;
}
