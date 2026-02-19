/**
 * ELK layout engine — runs the Eclipse Layout Kernel in a Web Worker.
 *
 * VS Code webviews cannot use `importScripts()` or load workers from URLs,
 * so the ELK worker code is injected at build time as a string constant
 * (`__ELK_WORKER_CODE__`) and loaded via a blob URL at runtime.
 *
 * Provides a single async function `runElkLayout()` that converts React Flow
 * nodes and edges into an ELK graph, runs the layered layout algorithm in a
 * Web Worker, and returns a positions map ready for `viewConfig.positions`.
 */

import ELK from 'elkjs/lib/elk-api';
import type { ELK as IELK, ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api';
import type { ModelFlowNode, FkFlowEdge } from '../types/graph';
import type { NodePosition, LayoutOptions } from '../../src/types/semantic';

// ---------------------------------------------------------------------------
// Node size estimation (matches ModelNode CSS)
// ---------------------------------------------------------------------------

/** Default width — used as fallback by edgeDistribution.ts. */
export const NODE_WIDTH = 280;

// --- Height estimation constants ---

/** Height of the header section (name + layer badge). */
const NODE_HEADER_HEIGHT = 29;

/** Height of a single column row. */
const NODE_COLUMN_HEIGHT = 23;

/** Padding around the columns section. */
const NODE_COLUMNS_PADDING = 4;

/** Height of the "No columns" placeholder. */
const NODE_EMPTY_ROW_HEIGHT = 33;

/** Height of the footer (column count). */
const NODE_FOOTER_HEIGHT = 25;

/** Card border width (top + bottom). */
const NODE_BORDER = 4;

function estimateNodeHeight(columnCount: number): number {
  const columnsHeight =
    columnCount > 0
      ? NODE_COLUMNS_PADDING + columnCount * NODE_COLUMN_HEIGHT
      : NODE_COLUMNS_PADDING + NODE_EMPTY_ROW_HEIGHT;

  return NODE_BORDER + NODE_HEADER_HEIGHT + columnsHeight + NODE_FOOTER_HEIGHT;
}

// --- Width estimation constants (approximates ModelNode CSS rendering) ---

/** Average pixel width per character in 12px system sans-serif (body text). */
const CHAR_WIDTH_BODY = 7;

/** Average pixel width per character in 11px monospace (data type labels). */
const CHAR_WIDTH_MONO = 6.8;

/** Width of a single key badge (PK / FK / NK). */
const KEY_BADGE_WIDTH = 20;

/** Horizontal padding inside a column row (10px left + 10px right). */
const COL_ROW_PADDING = 20;

/** Approximate total flex gap between items in a column row. */
const COL_ROW_GAPS = 24;

/** Width of an SCD or additive type badge. */
const EXTRA_BADGE_WIDTH = 30;

/** Header horizontal padding (10px each side) + layer badge + gap. */
const HEADER_PADDING = 20;

/** Layer badge approximate width. */
const LAYER_BADGE_WIDTH = 36;

/** Minimum node width (matches CSS min-width). */
const MIN_NODE_WIDTH = 200;

/** Maximum node width (matches CSS max-width). */
const MAX_NODE_WIDTH = 480;

/**
 * Estimate the pixel width a node needs to display its content without
 * truncation. Examines the header and each column row, returning the
 * widest value clamped to [MIN_NODE_WIDTH, MAX_NODE_WIDTH].
 */
function estimateNodeWidth(node: ModelFlowNode): number {
  const { modelName, columns } = node.data;

  // Header: name + layer badge + padding
  const headerWidth =
    HEADER_PADDING + modelName.length * CHAR_WIDTH_BODY + LAYER_BADGE_WIDTH;

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

  const rawWidth = Math.max(headerWidth, maxColWidth);
  return Math.round(Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, rawWidth)));
}

// ---------------------------------------------------------------------------
// Default ELK options
// ---------------------------------------------------------------------------

/**
 * Default ELK layout options.
 *
 * These produce a clean left-to-right layered layout with orthogonal edge
 * routing, 16:9 aspect ratio, and fixed port ordering (handles stay on
 * consistent sides).
 *
 * Coffman-Graham layering with a bound of 10 prevents star-schema hub nodes
 * (like dim_work_lot with 20+ incoming FKs) from stacking all dependents
 * into a single tall column. Network-simplex node placement minimises total
 * edge length, and post-compaction further tightens the result.
 */
export const DEFAULT_ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.aspectRatio': '1.777',
  'elk.spacing.nodeNode': '30',
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.portConstraints': 'FIXED_ORDER',
  // Limit nodes per layer to prevent tall single-column stacking
  'elk.layered.layering.strategy': 'COFFMAN_GRAHAM',
  'elk.layered.layering.coffmanGraham.layerBound': '10',
  // Better node placement for star-schema graphs with hub nodes
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  // Post-compaction to minimize edge lengths
  'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
};

// ---------------------------------------------------------------------------
// ELK instance (lazy singleton)
// ---------------------------------------------------------------------------

let elkInstance: IELK | null = null;

function getElk(): IELK {
  if (!elkInstance) {
    elkInstance = new ELK({
      workerFactory: () => {
        const blob = new Blob([__ELK_WORKER_CODE__], {
          type: 'text/javascript',
        });
        const url = URL.createObjectURL(blob);
        const worker = new Worker(url);
        URL.revokeObjectURL(url);
        return worker;
      },
    });
  }
  return elkInstance;
}

// ---------------------------------------------------------------------------
// Graph conversion
// ---------------------------------------------------------------------------

/**
 * Convert React Flow nodes into ELK children nodes.
 * Each node gets an estimated width (based on content) and height (based on
 * column count) so the layered layout reserves the correct amount of space.
 */
function toElkChildren(nodes: ModelFlowNode[]): ElkNode[] {
  return nodes.map((node) => ({
    id: node.id,
    width: estimateNodeWidth(node),
    height: estimateNodeHeight(node.data.columns.length),
  }));
}

/** Convert React Flow edges into ELK extended edges. */
function toElkEdges(edges: FkFlowEdge[]): ElkExtendedEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    sources: [edge.source],
    targets: [edge.target],
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run ELK layout on a set of React Flow nodes and edges.
 *
 * @param nodes — current React Flow model nodes.
 * @param edges — current React Flow FK edges.
 * @param layoutOptions — optional per-domain ELK options from
 *   `viewConfig.layoutOptions`. Merged on top of defaults.
 * @returns a positions map keyed by model name, ready for
 *   `viewConfig.positions`.
 */
export async function runElkLayout(
  nodes: ModelFlowNode[],
  edges: FkFlowEdge[],
  layoutOptions?: LayoutOptions,
): Promise<Record<string, NodePosition>> {
  const elk = getElk();

  const mergedOptions: Record<string, string> = {
    ...DEFAULT_ELK_OPTIONS,
    ...layoutOptions,
  };

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: mergedOptions,
    children: toElkChildren(nodes),
    edges: toElkEdges(edges),
  };

  const layouted = await elk.layout(graph);

  // Extract positions from the layouted graph
  const positions: Record<string, NodePosition> = {};
  for (const child of layouted.children ?? []) {
    positions[child.id] = {
      x: Math.round(child.x ?? 0),
      y: Math.round(child.y ?? 0),
    };
  }

  return positions;
}
