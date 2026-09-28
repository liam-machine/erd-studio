/**
 * Model node size estimation (matches ModelNode CSS).
 *
 * The width and height a model node will render at, estimated from its
 * content, for code that needs node sizes before React Flow has measured the
 * DOM: edge handle placement in the graph transformer and the extension's ELK
 * auto-layout, which imports these from `@erd-studio/renderer/sizing`.
 *
 * Kept free of elkjs and React Flow runtime imports so it can be loaded on its
 * own.
 */

import type { ModelFlowNode, ModelNodeData } from '../types/graph';
import { COLLAPSED_COLUMN_LIMIT } from '../hooks/useColumnExpansion';

// ---------------------------------------------------------------------------
// Node size estimation (matches ModelNode CSS)
// ---------------------------------------------------------------------------

/** Default width — used as fallback by edgeDistribution.ts. */
export const NODE_WIDTH = 280;

// --- Height estimation constants ---

/** Height of the header section (name + layer badge). */
const NODE_HEADER_HEIGHT = 29;

/** Height of a single column row. */
const NODE_COLUMN_HEIGHT = 25;

/** Padding around the columns section. */
const NODE_COLUMNS_PADDING = 4;

/** Height of the "No columns" placeholder. */
const NODE_EMPTY_ROW_HEIGHT = 33;

/** Height of the footer (column count). */
const NODE_FOOTER_HEIGHT = 25;

/** Card border width (top + bottom). */
const NODE_BORDER = 4;

/** Height of the grain subtitle row (padding: 1px 10px 4px + 10px font ≈ 15px). */
const NODE_GRAIN_HEIGHT = 15;

/**
 * Estimate a node's rendered height from the number of column rows actually
 * drawn (see `countVisibleColumnRows`) and whether a grain subtitle is shown.
 */
export function estimateNodeHeight(rowCount: number, hasGrain: boolean): number {
  const grainHeight = hasGrain ? NODE_GRAIN_HEIGHT : 0;

  const columnsHeight =
    rowCount > 0
      ? NODE_COLUMNS_PADDING + rowCount * NODE_COLUMN_HEIGHT
      : NODE_COLUMNS_PADDING + NODE_EMPTY_ROW_HEIGHT;

  return NODE_BORDER + NODE_HEADER_HEIGHT + grainHeight + columnsHeight + NODE_FOOTER_HEIGHT;
}

/**
 * Number of rows ModelNode actually renders in its columns section.
 *
 * Mirrors the rendering rules in `ModelNode.tsx`:
 *   - stub models show only PK/NK columns
 *   - collapsed nodes show at most `COLLAPSED_COLUMN_LIMIT` columns plus a
 *     "...and N more" button row
 *   - expanded nodes with more than the limit also render a "Show less" row
 *
 * Using the full column count (the old behaviour) over-reserved
 * `(columns - 5) * rowHeight` per node on auto-collapsed domains (≥30 models).
 */
export function countVisibleColumnRows(
  data: Pick<ModelNodeData, 'columns' | 'isStub' | 'isExpanded'>,
): number {
  const visible = data.isStub
    ? data.columns.filter((c) => c.isPrimaryKey || c.isNaturalKey)
    : data.columns;
  const expanded = data.isExpanded ?? false;

  if (expanded) {
    return visible.length + (data.columns.length > COLLAPSED_COLUMN_LIMIT ? 1 : 0);
  }
  if (visible.length > COLLAPSED_COLUMN_LIMIT) {
    return COLLAPSED_COLUMN_LIMIT + 1;
  }
  return visible.length;
}

/**
 * Best-known size for a model node: React Flow's measured DOM size when
 * available, otherwise an estimate from the rows that will be rendered.
 */
export function resolveNodeDimensions(
  node: Pick<ModelFlowNode, 'data' | 'measured'>,
): { width: number; height: number } {
  return {
    width: node.measured?.width ?? estimateNodeWidth(node.data),
    height: node.measured?.height ?? estimateNodeHeight(countVisibleColumnRows(node.data), !!node.data.grain),
  };
}

// --- Width estimation constants (approximates ModelNode CSS rendering) ---

/** Average pixel width per character in 12px system sans-serif (body text). */
const CHAR_WIDTH_BODY = 7.5;

/** Average pixel width per character in 11px monospace (data type labels). */
const CHAR_WIDTH_MONO = 7.2;

/** Width of a single key badge (PK / FK / NK). */
const KEY_BADGE_WIDTH = 20;

/** Horizontal padding inside a column row (10px left + 10px right). */
const COL_ROW_PADDING = 20;

/**
 * Approximate total flex gap between items in a column row.
 * A full row has: reorder handle + indicators + name + type + up to 2 badges
 * with gap: 6px between each — worst case ~5 gaps = 30px, plus reorder handle ~16px.
 */
const COL_ROW_GAPS = 46;

/** Width of an SCD or additive type badge. */
const EXTRA_BADGE_WIDTH = 30;

/** Header horizontal padding (10px each side) + layer badge + gap. */
const HEADER_PADDING = 20;

/** Width per character of the smaller model-name text shown beside an alias label. */
const CHAR_WIDTH_ID = 6;

/** Gap between an alias label and the model name beside it. */
const ID_GAP = 8;

/** Layer badge approximate width. */
const LAYER_BADGE_WIDTH = 36;

/**
 * Provenance chip approximate width (3 uppercase characters plus padding).
 *
 * Under-reserving here only ever shows up on the auto-layout path, for nodes
 * React Flow has not measured yet — i.e. never on a canvas that is already
 * open, which is why it has to be reserved rather than discovered.
 */
const SOURCE_BADGE_WIDTH = 30;

/**
 * Safety margin added to the raw estimated width before clamping.
 * Absorbs font-rendering variation and ensures ELK reserves slightly
 * more space than the minimum, preventing overlap on wide field names.
 */
const WIDTH_SAFETY_MARGIN = 24;

/** Minimum node width (matches CSS min-width). */
const MIN_NODE_WIDTH = 220;

/** Maximum node width — raised above CSS max-width to accommodate long field names. */
const MAX_NODE_WIDTH = 560;

/**
 * Estimate the pixel width a node needs to display its content without
 * truncation. Examines the header and each column row, returning the
 * widest value clamped to [MIN_NODE_WIDTH, MAX_NODE_WIDTH].
 *
 * A safety margin is added before clamping so ELK always reserves
 * slightly more space than the minimum estimate, preventing overlap
 * when font rendering or badge widths differ from the approximation.
 */
export function estimateNodeWidth(data: Pick<ModelNodeData, 'modelName' | 'label' | 'columns' | 'provenance'>): number {
  const { modelName, label, columns, provenance } = data;

  // Header: label (+ the model name beside it when they differ) + layer badge
  // + provenance chip (physical only) + padding
  const headerWidth =
    HEADER_PADDING
    + (label ? label.length * CHAR_WIDTH_BODY + ID_GAP + modelName.length * CHAR_WIDTH_ID : modelName.length * CHAR_WIDTH_BODY)
    + LAYER_BADGE_WIDTH
    + (provenance ? SOURCE_BADGE_WIDTH : 0);

  // Find the widest column row
  let maxColWidth = 0;
  for (const col of columns) {
    const keyBadges =
      (col.isPrimaryKey ? 1 : 0) +
      (col.isForeignKey ? 1 : 0) +
      (col.isNaturalKey ? 1 : 0);

    const extraBadges =
      (col.scdType !== undefined ? 1 : 0) +
      (col.additiveType !== undefined ? 1 : 0);

    const colWidth =
      COL_ROW_PADDING +
      keyBadges * KEY_BADGE_WIDTH +
      col.name.length * CHAR_WIDTH_BODY +
      col.dataType.length * CHAR_WIDTH_MONO +
      extraBadges * EXTRA_BADGE_WIDTH +
      COL_ROW_GAPS;

    if (colWidth > maxColWidth) {
      maxColWidth = colWidth;
    }
  }

  const rawWidth = Math.max(headerWidth, maxColWidth) + WIDTH_SAFETY_MARGIN;
  return Math.round(Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, rawWidth)));
}
