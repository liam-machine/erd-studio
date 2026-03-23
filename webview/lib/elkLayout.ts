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
import type { NodePosition, LayoutOptions, ModelRole } from '../../src/types/semantic';

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

function estimateNodeHeight(columnCount: number, hasGrain: boolean): number {
  const grainHeight = hasGrain ? NODE_GRAIN_HEIGHT : 0;

  const columnsHeight =
    columnCount > 0
      ? NODE_COLUMNS_PADDING + columnCount * NODE_COLUMN_HEIGHT
      : NODE_COLUMNS_PADDING + NODE_EMPTY_ROW_HEIGHT;

  return NODE_BORDER + NODE_HEADER_HEIGHT + grainHeight + columnsHeight + NODE_FOOTER_HEIGHT;
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

/** Layer badge approximate width. */
const LAYER_BADGE_WIDTH = 36;

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

  const rawWidth = Math.max(headerWidth, maxColWidth) + WIDTH_SAFETY_MARGIN;
  return Math.round(Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, rawWidth)));
}

// ---------------------------------------------------------------------------
// Role-aware partitioning
// ---------------------------------------------------------------------------

/**
 * Map a model's dimensional role to an ELK partition index.
 *
 * Partitions place related model types into spatial bands when ELK's
 * partitioning feature is active. Lower indices appear earlier in the
 * layout direction (left for RIGHT direction):
 *
 *   0 — Dimensions (conformed-dim, domain-dim)
 *   1 — Reference / lookup tables
 *   2 — Facts (transaction, periodic, accumulating) + unassigned models
 *   3 — Factless facts / bridge tables
 *   4 — Gold aggregates (gold-dim, gold-fact)
 */
export function roleToPartition(role: ModelRole | undefined): number {
  switch (role) {
    case 'conformed-dim':
    case 'domain-dim':
      return 0;
    case 'reference':
      return 1;
    case 'transaction-fact':
    case 'periodic-snapshot':
    case 'accumulating-snapshot':
      return 2;
    case 'factless-fact':
      return 3;
    case 'gold-dim':
    case 'gold-fact':
      return 4;
    default:
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Depth-based partitioning (structural fallback when no roles are assigned)
// ---------------------------------------------------------------------------

/**
 * Compute partition indices for nodes based on their topological depth in the
 * relationship graph, using the longest path from each source node (nodes
 * with no incoming edges).
 *
 * This naturally groups tables by their position in the data flow:
 *   - Lookup / reference tables with no incoming FKs → depth 0 (leftmost)
 *   - Intermediate tables referenced by some, referencing others → middle
 *   - Terminal derived tables → deepest (rightmost)
 *
 * Depths are bucketed into 5 groups (0–4) so the partition count stays
 * stable regardless of how deep the graph is.
 *
 * Nodes that form cycles (uncommon but possible) or are otherwise unreachable
 * from any source are assigned depth 0.
 */
export function computeDepthPartitions(
  nodes: ModelFlowNode[],
  edges: FkFlowEdge[],
): Map<string, number> {
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Build outgoing adjacency list and track in-degree for each node
  const outEdges = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of nodes) {
    outEdges.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      outEdges.get(edge.source)!.push(edge.target);
      inDegree.set(edge.target, inDegree.get(edge.target)! + 1);
    }
  }

  // Longest-path via Kahn's topological sort.
  // Processing nodes in topological order guarantees that when we visit a
  // node, all its predecessors have already been processed — so the depth
  // stored at that point is already the maximum across all incoming paths.
  const depth = new Map<string, number>();
  const remainingIn = new Map(inDegree);
  const queue: string[] = [];

  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      depth.set(id, 0);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depth.get(id)!;

    for (const neighbor of outEdges.get(id)!) {
      const newD = d + 1;
      if (newD > (depth.get(neighbor) ?? -1)) {
        depth.set(neighbor, newD);
      }
      const rem = remainingIn.get(neighbor)! - 1;
      remainingIn.set(neighbor, rem);
      if (rem === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Assign cycle members and isolated nodes depth 0
  for (const node of nodes) {
    if (!depth.has(node.id)) {
      depth.set(node.id, 0);
    }
  }

  // Bucket into 5 partitions (0–4) relative to the deepest node
  const maxDepth = Math.max(...depth.values(), 1);
  const partitions = new Map<string, number>();
  for (const [id, d] of depth) {
    partitions.set(id, Math.min(4, Math.round((d / maxDepth) * 4)));
  }

  return partitions;
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
 *
 * separateConnectedComponents keeps disconnected sub-graphs (unrelated table
 * clusters) in their own visual group rather than scattering them through
 * the main layout.
 */
export const DEFAULT_ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.aspectRatio': '2.5',
  'elk.spacing.nodeNode': '70',
  'elk.layered.spacing.nodeNodeBetweenLayers': '160',
  'elk.portConstraints': 'FIXED_ORDER',
  // Keep disconnected table clusters visually separate
  'elk.separateConnectedComponents': 'true',
  // Limit nodes per layer to prevent tall single-column stacking.
  // Lower bound = fewer nodes per column = more columns = wider layout.
  'elk.layered.layering.strategy': 'COFFMAN_GRAHAM',
  'elk.layered.layering.coffmanGraham.layerBound': '5',
  // Better node placement for star-schema graphs with hub nodes
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  // Post-compaction to minimize edge lengths
  'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
};

/**
 * Spacing presets — map a human-readable tier to ELK node/layer gap values.
 *
 *   S (Tight)  — fits more tables on screen; good for large overviews
 *   M (Normal) — default, balances readability and density
 *   L (Wide)   — extra breathing room; useful on large displays
 */
export const SPACING_PRESETS = {
  S: { 'elk.spacing.nodeNode': '40', 'elk.layered.spacing.nodeNodeBetweenLayers': '100' },
  M: { 'elk.spacing.nodeNode': '70', 'elk.layered.spacing.nodeNodeBetweenLayers': '160' },
  L: { 'elk.spacing.nodeNode': '110', 'elk.layered.spacing.nodeNodeBetweenLayers': '240' },
} as const;

export type SpacingPreset = keyof typeof SPACING_PRESETS;

/** Valid ELK layout directions exposed in the toolbar. */
export const LAYOUT_DIRECTIONS = ['RIGHT', 'DOWN'] as const;
export type LayoutDirection = (typeof LAYOUT_DIRECTIONS)[number];

/**
 * Role-aware ELK options — extends defaults with partition activation.
 *
 * When active, each node is assigned to a spatial band based on its
 * `modelRole`, grouping dimensions left, facts center, and gold right.
 * Used as the default; callers can still override via `viewConfig.layoutOptions`.
 */
export const ROLE_AWARE_ELK_OPTIONS: Record<string, string> = {
  ...DEFAULT_ELK_OPTIONS,
  'elk.partitioning.activate': 'true',
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
 * column count and whether a grain subtitle is present) so the layered layout
 * reserves the correct amount of space.
 *
 * When `partitions` is provided, each node gets a `layoutOptions` entry
 * assigning it to the given spatial partition index.
 */
function toElkChildren(
  nodes: ModelFlowNode[],
  partitions: Map<string, number> | null,
): ElkNode[] {
  return nodes.map((node) => {
    const elkNode: ElkNode = {
      id: node.id,
      width: estimateNodeWidth(node),
      height: estimateNodeHeight(node.data.columns.length, !!node.data.grain),
    };
    if (partitions !== null) {
      elkNode.layoutOptions = {
        'elk.partitioning.partition': String(partitions.get(node.id) ?? 0),
      };
    }
    return elkNode;
  });
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
 * Controls how nodes are assigned to spatial partition bands before ELK runs.
 *
 *   auto  — detect automatically: role-based when ≥2 distinct role-bands are
 *            present, depth-based when edges exist, otherwise none.
 *   role  — group by modelRole (dims left, facts centre, gold right).
 *   depth — group by topological depth in the relationship graph.
 *   none  — no partitioning; let ELK decide placement freely.
 */
export type PartitionStrategy = 'auto' | 'role' | 'depth' | 'none';

/** Roles that produce a meaningful partition index (i.e. not the default). */
const PARTITIONABLE_ROLES = new Set<string>([
  'conformed-dim', 'domain-dim',
  'transaction-fact', 'periodic-snapshot', 'accumulating-snapshot',
  'factless-fact', 'reference',
  'gold-fact', 'gold-dim',
]);

/**
 * Detect the best partition strategy for the given nodes and edges when
 * `partitionStrategy` is 'auto'.
 */
export function detectStrategy(
  nodes: ModelFlowNode[],
  edges: FkFlowEdge[],
): 'role' | 'depth' | 'none' {
  const distinctRoleBands = new Set(
    nodes
      .filter((n) => n.data.modelRole !== undefined && PARTITIONABLE_ROLES.has(n.data.modelRole))
      .map((n) => roleToPartition(n.data.modelRole)),
  );
  if (distinctRoleBands.size >= 2) return 'role';
  if (edges.length > 0) return 'depth';
  return 'none';
}

/**
 * Run ELK layout on a set of React Flow nodes and edges.
 *
 * @param nodes — current React Flow model nodes.
 * @param edges — current React Flow FK edges.
 * @param layoutOptions — optional per-domain ELK options from
 *   `viewConfig.layoutOptions`. Merged on top of defaults.
 * @param partitionStrategy — how to assign nodes to spatial bands.
 *   Defaults to 'auto' (auto-detect from graph structure).
 * @returns a positions map keyed by model name, ready for
 *   `viewConfig.positions`.
 */
export async function runElkLayout(
  nodes: ModelFlowNode[],
  edges: FkFlowEdge[],
  layoutOptions?: LayoutOptions,
  partitionStrategy: PartitionStrategy = 'auto',
): Promise<Record<string, NodePosition>> {
  const elk = getElk();

  const resolved = partitionStrategy === 'auto'
    ? detectStrategy(nodes, edges)
    : partitionStrategy;

  let partitions: Map<string, number> | null = null;
  let baseOptions: Record<string, string>;

  switch (resolved) {
    case 'role':
      baseOptions = ROLE_AWARE_ELK_OPTIONS;
      partitions = new Map(nodes.map((n) => [n.id, roleToPartition(n.data.modelRole)]));
      break;
    case 'depth':
      baseOptions = { ...DEFAULT_ELK_OPTIONS, 'elk.partitioning.activate': 'true' };
      partitions = computeDepthPartitions(nodes, edges);
      break;
    default:
      baseOptions = DEFAULT_ELK_OPTIONS;
  }

  const mergedOptions: Record<string, string> = {
    ...baseOptions,
    ...layoutOptions,
  };

  // Re-derive partitions if the caller explicitly disabled partitioning
  if (mergedOptions['elk.partitioning.activate'] !== 'true') {
    partitions = null;
  }

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: mergedOptions,
    children: toElkChildren(nodes, partitions),
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
