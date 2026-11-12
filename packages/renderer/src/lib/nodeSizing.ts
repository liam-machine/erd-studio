/**
 * Model node size estimation (matches TableNode CSS).
 *
 * The width and height a model node will render at, estimated from its
 * content, for code that needs node sizes before React Flow has measured the
 * DOM: edge handle placement in the graph transformer and the extension's ELK
 * auto-layout, which imports these from `@erd-studio/renderer/sizing`.
 *
 * Kept free of elkjs and React Flow runtime imports so it can be loaded on its
 * own.
 */

import type { TableFlowNode, TableNodeData } from '../types/graph';
import { resolveVisibleColumns } from './tableDetail';
import { headerName } from './modelLabels';

// ---------------------------------------------------------------------------
// Node size estimation (matches TableNode CSS)
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
 *
 * `bare` is a card with no body at all (see `isBareTableBody`): header and
 * footer only. Without it, zero rows means the "No columns" line.
 */
export function estimateNodeHeight(rowCount: number, hasGrain: boolean, bare = false): number {
  const grainHeight = hasGrain ? NODE_GRAIN_HEIGHT : 0;

  const columnsHeight =
    rowCount > 0
      ? NODE_COLUMNS_PADDING + rowCount * NODE_COLUMN_HEIGHT
      : bare ? 0 : NODE_COLUMNS_PADDING + NODE_EMPTY_ROW_HEIGHT;

  return NODE_BORDER + NODE_HEADER_HEIGHT + grainHeight + columnsHeight + NODE_FOOTER_HEIGHT;
}

/** What the row and width estimates read to know which rows a table draws. */
type VisibleRowsData =
  Pick<TableNodeData, 'columns' | 'isStub' | 'isExpanded'>
  & Partial<Pick<TableNodeData, 'tableDetail' | 'loadError'>>;

/**
 * Number of rows TableNode actually renders in its columns section: the
 * column rows `resolveVisibleColumns` picks (the same call `ModelNode.tsx`
 * makes) plus one for the expand / collapse button when it is a row of its
 * own (at the `name` level a closed table's footer is the button instead).
 *
 * With a table detail level (`tableDetail`): no rows at `name`, the key
 * columns at `keys`, every column at `all` or when the table is opened.
 * Without one (older callers), as before the levels: at most the first five
 * columns plus the "...and N more" row, or every column plus "Show less".
 */
export function countVisibleColumnRows(data: VisibleRowsData): number {
  const visible = resolveVisibleColumns(data);
  return visible.columns.length + (visible.toggle && !visible.toggleInFooter ? 1 : 0);
}

/**
 * Whether the card has no body: no column row, no button and no "No columns"
 * line. Only a table at a detail level can be bare (every closed table at
 * `name`, a stub with no key columns): header and footer, nothing between.
 */
export function isBareTableBody(data: VisibleRowsData): boolean {
  if (data.tableDetail == null) return false;
  const visible = resolveVisibleColumns(data);
  return visible.columns.length === 0 && (!visible.toggle || visible.toggleInFooter) && !visible.placeholder;
}

/**
 * Best-known size for a model node: React Flow's measured DOM size when
 * available, otherwise an estimate from the rows that will be rendered.
 */
export function resolveNodeDimensions(
  node: Pick<TableFlowNode, 'data' | 'measured'>,
): { width: number; height: number } {
  return {
    width: node.measured?.width ?? estimateNodeWidth(node.data),
    height: node.measured?.height
      ?? estimateNodeHeight(countVisibleColumnRows(node.data), !!node.data.grain, isBareTableBody(node.data)),
  };
}

// --- Width estimation constants (approximates TableNode CSS rendering) ---

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
 *
 * At a table detail level (`tableDetail`) only the rows the table draws are
 * measured; without one every column is, as before.
 */
export function estimateNodeWidth(
  data: Pick<TableNodeData, 'modelName' | 'label' | 'columns' | 'provenance'> & Partial<Pick<TableNodeData, 'tableName' | 'tableLayer' | 'shownSchema' | 'alias' | 'singleLayer' | 'isStub' | 'isExpanded' | 'tableDetail'>>,
): number {
  const { modelName, label, provenance, shownSchema, alias, singleLayer } = data;
  // The name the header prints after its schema (the table's own name for one of two same-named tables).
  const shownName = headerName(data);
  const columns = data.tableDetail == null ? data.columns : resolveVisibleColumns(data).columns;

  // Header: the name as drawn + layer badge (none in a single-layer project)
  // + provenance chip (physical only) + padding. With a schema prefix or an
  // alias it reads `schema.name  as alias`; otherwise the label, with the
  // model name beside it when they differ.
  const nameWidth = shownSchema || alias
    ? ((shownSchema ? shownSchema.length + 1 : 0) + shownName.length) * CHAR_WIDTH_BODY
      + (alias ? ID_GAP + (alias.length + 3) * CHAR_WIDTH_ID : 0)
    : label ? label.length * CHAR_WIDTH_BODY + ID_GAP + modelName.length * CHAR_WIDTH_ID : modelName.length * CHAR_WIDTH_BODY;
  const headerWidth =
    HEADER_PADDING
    + nameWidth
    + (singleLayer ? 0 : LAYER_BADGE_WIDTH)
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
