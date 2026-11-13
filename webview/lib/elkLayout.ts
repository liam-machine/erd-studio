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
import type { TableFlowNode, FkFlowEdge } from '@erd-studio/renderer/editor';
import type { NodePosition, LayoutOptions, TableRole } from '../../src/types/semantic';
import {
  classifyLayoutErrorText,
  isStackOverflowText,
  layoutRelBucket,
  layoutTableBucket,
  LAYOUT_LOG_COUNT_MAX,
  LAYOUT_LOG_MESSAGE_MAX,
  type LayoutFailure,
  type LayoutFailureDetail,
  type LayoutFallbackRung,
} from '../../src/types/webviewError';
import { NODE_WIDTH, resolveNodeDimensions } from '@erd-studio/renderer/sizing';

// ---------------------------------------------------------------------------
// Node size estimation — lives in @erd-studio/renderer (lib/nodeSizing.ts) so
// the canvas can size nodes without elkjs. Re-exported for existing callers.
// ---------------------------------------------------------------------------

export {
  NODE_WIDTH,
  estimateNodeHeight,
  countVisibleColumnRows,
  resolveNodeDimensions,
  estimateNodeWidth,
} from '@erd-studio/renderer/sizing';

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
export function roleToPartition(role: TableRole | undefined): number {
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
// The relationship graph: strongly connected components and depths
// ---------------------------------------------------------------------------
//
// Everything here is iterative (no recursion), so a diagram of any size or
// shape (long chains, cycles, two-way relationships) cannot overflow the
// stack of the Web Worker or the page that runs it.

/** A diagram's relationships as adjacency lists over table indices. Self-references and relationships to a table not in the diagram are left out. */
interface TableGraph {
  ids: string[];
  out: number[][];
}

function tableGraph(nodes: TableFlowNode[], edges: FkFlowEdge[]): TableGraph {
  const ids = nodes.map((n) => n.id);
  const index = new Map<string, number>();
  ids.forEach((id, i) => { if (!index.has(id)) index.set(id, i); });
  const out: number[][] = ids.map(() => []);
  for (const edge of edges) {
    const s = index.get(edge.source);
    const t = index.get(edge.target);
    if (s === undefined || t === undefined || s === t) continue;
    out[s].push(t);
  }
  return { ids, out };
}

/**
 * Each table's strongly connected component (tables that reach each other
 * through relationships: a two-way pair, a circular chain), numbered in
 * topological order of the components, sources first. Tarjan's algorithm
 * with an explicit stack.
 */
function componentOrder(graph: TableGraph): Int32Array {
  const n = graph.ids.length;
  const idx = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const work: Array<[number, number]> = [];
  let next = 0;
  let emitted = 0;
  for (let root = 0; root < n; root++) {
    if (idx[root] !== -1) continue;
    idx[root] = low[root] = next++;
    stack.push(root); onStack[root] = 1;
    work.push([root, 0]);
    while (work.length > 0) {
      const top = work[work.length - 1];
      const v = top[0];
      const succ = graph.out[v];
      if (top[1] < succ.length) {
        const w = succ[top[1]++];
        if (idx[w] === -1) {
          idx[w] = low[w] = next++;
          stack.push(w); onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], idx[w]);
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low[parent] = Math.min(low[parent], low[v]);
      }
      if (low[v] === idx[v]) {
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp[w] = emitted;
        } while (w !== v);
        emitted++;
      }
    }
  }
  // Tarjan emits components sinks first: reverse to sources first.
  for (let i = 0; i < n; i++) comp[i] = emitted - 1 - comp[i];
  return comp;
}

/**
 * Each table's depth: the longest chain of relationships leading to it, where
 * the tables of one cycle (a two-way pair, a circular chain) share one depth
 * and count as one step. Tables with no incoming relationship are at depth 0.
 */
function graphDepths(graph: TableGraph): { depth: Int32Array; comp: Int32Array } {
  const n = graph.ids.length;
  const comp = componentOrder(graph);
  const compDepth = new Int32Array(n);
  // Every relationship between components goes from a lower to a higher
  // component number, so visiting tables by component number settles each
  // component's depth before it is passed on.
  const byComp = Array.from({ length: n }, (_, i) => i).sort((a, b) => comp[a] - comp[b]);
  for (const v of byComp) {
    const d = compDepth[comp[v]] + 1;
    for (const w of graph.out[v]) {
      if (comp[w] !== comp[v] && d > compDepth[comp[w]]) compDepth[comp[w]] = d;
    }
  }
  const depth = new Int32Array(n);
  for (let i = 0; i < n; i++) depth[i] = compDepth[comp[i]];
  return { depth, comp };
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
 * The tables of a cycle (a two-way relationship, a circular chain) share one
 * depth and count as one step, so they and every table downstream of them
 * get a real depth. Isolated tables are at depth 0.
 */
export function computeDepthPartitions(
  nodes: TableFlowNode[],
  edges: FkFlowEdge[],
): Map<string, number> {
  const graph = tableGraph(nodes, edges);
  const { depth } = graphDepths(graph);
  // Bucket into 5 partitions (0–4) relative to the deepest node. A loop, not
  // Math.max(...depths), which overflows the stack on a very large diagram.
  let maxDepth = 1;
  for (const d of depth) if (d > maxDepth) maxDepth = d;
  const partitions = new Map<string, number>();
  graph.ids.forEach((id, i) => {
    partitions.set(id, Math.min(4, Math.round((depth[i] / maxDepth) * 4)));
  });
  return partitions;
}

/**
 * The tables in one order that every relationship can follow: by band (when
 * grouping), then by dependency (the components of {@link graphDepths}, so
 * a referenced table comes before the tables that point at it, and a cycle's
 * tables sit together), then by position in the diagram. Returns each table
 * id's rank and the tables' depths.
 */
function dependencyOrder(
  nodes: TableFlowNode[],
  edges: FkFlowEdge[],
  partitions: Map<string, number> | null,
): { order: number[]; depth: Int32Array; comp: Int32Array; graph: TableGraph } {
  const graph = tableGraph(nodes, edges);
  const { depth, comp } = graphDepths(graph);
  const band = graph.ids.map((id) => partitions?.get(id) ?? 0);
  const order = Array.from({ length: graph.ids.length }, (_, i) => i)
    .sort((a, b) => (band[a] - band[b]) || (depth[a] - depth[b]) || (comp[a] - comp[b]) || (a - b));
  return { order, depth, comp, graph };
}

/**
 * The relationships as ELK gets them when grouping (partitioning) is on:
 * every one points along {@link dependencyOrder}, so the graph ELK lays out
 * has no cycle and no relationship pointing back to an earlier band.
 *
 * Why: with partitioning on, ELK reverses a relationship that points to an
 * earlier band, its greedy cycle breaker may then reverse one more that
 * crosses bands, and its partition step joins every table of a band to every
 * table of the next. Together those can close a cycle, and the Coffman–Graham
 * layering walks round it until the stack overflows ("Maximum call stack size
 * exceeded", on any machine and any stack size). Only positions are read
 * back, so turning a relationship round changes nothing but which side ELK
 * puts it on, which it was choosing anyway. Self-references are kept as they
 * are; a relationship to a table not in the diagram is left out.
 */
export function orientEdgesForPartitions(
  nodes: TableFlowNode[],
  edges: FkFlowEdge[],
  partitions: Map<string, number>,
): ElkExtendedEdge[] {
  const { order, graph } = dependencyOrder(nodes, edges, partitions);
  const rank = new Map<string, number>();
  order.forEach((v, r) => { if (!rank.has(graph.ids[v])) rank.set(graph.ids[v], r); });
  const oriented: ElkExtendedEdge[] = [];
  for (const edge of edges) {
    const s = rank.get(edge.source);
    const t = rank.get(edge.target);
    if (s === undefined || t === undefined) continue;
    oriented.push(s <= t
      ? { id: edge.id, sources: [edge.source], targets: [edge.target] }
      : { id: edge.id, sources: [edge.target], targets: [edge.source] });
  }
  return oriented;
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
 * (like a dim_customer with 20+ incoming FKs) from stacking all dependents
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

/** The Worker backing `elkInstance`, so a crashed worker can be terminated. */
let elkWorker: Worker | null = null;

/**
 * Rejecters for layouts that are currently in flight. elkjs only listens for
 * `onmessage`, so an uncaught worker error (OOM, termination, DataCloneError
 * while posting the error object) would otherwise leave `elk.layout()` pending
 * forever — and the Layout button disabled with a spinner.
 */
const pendingRejecters = new Set<(err: Error) => void>();

/** Give up on a layout after this long and recycle the worker. */
export const LAYOUT_TIMEOUT_MS = 30_000;

/** The class each guard error carries, for usage telemetry (2.0 B17): read by {@link classifyLayoutFailure}. */
const LAYOUT_FAILURE = Symbol('layoutFailure');

function guardError(message: string, failure: LayoutFailure): Error {
  return Object.assign(new Error(message), { [LAYOUT_FAILURE]: failure });
}

/**
 * Why a layout failed, from the known shapes of this module's errors and the
 * engine's own fixed text (never sent as text): the timeout guard, the worker
 * dying, an unusable result, and, by `classifyLayoutErrorText`, a stack
 * overflow, memory running out, an ELK exception by its class, or anything
 * else.
 */
export function classifyLayoutFailure(err: unknown): LayoutFailure {
  const tagged = typeof err === 'object' && err !== null ? (err as { [LAYOUT_FAILURE]?: LayoutFailure })[LAYOUT_FAILURE] : undefined;
  if (tagged) return tagged;
  return err instanceof Error ? classifyLayoutErrorText(err.name, err.message) : classifyLayoutErrorText('', String(err));
}

/** How the fallbacks went for a layout that failed after trying them, carried by the error thrown. */
const LAYOUT_LADDER = Symbol('layoutLadder');

interface LadderOutcome {
  /** The class of the last fallback's failure. */
  lastFailure: LayoutFailure;
}

function clampCount(n: number): number {
  return Number.isFinite(n) ? Math.min(LAYOUT_LOG_COUNT_MAX, Math.max(0, Math.round(n))) : 0;
}

/**
 * What a page reports about a failed layout (`layoutFinished` on the canvas,
 * `layoutFailed` on the draft page): its class, the diagram's size as buckets
 * (worked out here, so the counts are in no field telemetry reads), whether
 * every fallback was tried and how the last one failed, and, for the
 * extension's own log only, the counts and the error's message.
 */
export function layoutFailureReport(err: unknown, size: { tables: number; relationships: number }): LayoutFailureDetail {
  const ladder = typeof err === 'object' && err !== null ? (err as { [LAYOUT_LADDER]?: LadderOutcome })[LAYOUT_LADDER] : undefined;
  const message = err instanceof Error
    ? (err.name && err.name !== 'Error' && !err.message.startsWith(err.name) ? `${err.name}: ${err.message}` : err.message)
    : String(err);
  return {
    failure: classifyLayoutFailure(err),
    tableBucket: layoutTableBucket(size.tables),
    relBucket: layoutRelBucket(size.relationships),
    ...(ladder ? { exhausted: true as const, lastFailure: ladder.lastFailure } : {}),
    log: {
      tables: clampCount(size.tables),
      relationships: clampCount(size.relationships),
      message: message.slice(0, LAYOUT_LOG_MESSAGE_MAX),
    },
  };
}

/**
 * Discard the current ELK instance/worker and fail every in-flight layout.
 * The next `runElkLayout()` call spins up a fresh worker.
 */
function resetElk(err: Error): void {
  elkInstance = null;
  const worker = elkWorker;
  elkWorker = null;
  try {
    worker?.terminate();
  } catch {
    // Worker may already be dead — nothing to do.
  }
  const rejecters = [...pendingRejecters];
  pendingRejecters.clear();
  for (const reject of rejecters) {
    reject(err);
  }
}

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
        worker.onerror = (event: ErrorEvent) => {
          const detail = event?.message ? `: ${event.message}` : '';
          resetElk(guardError(`ELK layout worker crashed${detail}`, 'worker'));
        };
        elkWorker = worker;
        return worker;
      },
    });
  }
  return elkInstance;
}

/** The node placement a layout falls back to when the default one overflows the worker's stack. */
export const STACK_SAFE_NODE_PLACEMENT = 'BRANDES_KOEPF';

/** The post-compaction option, which the last fallback leaves out. */
const POST_COMPACTION = 'elk.layered.compaction.postCompaction.strategy';

/**
 * The layouts tried, in order, after one overflows the worker's stack. Each
 * drops one deeply recursive step of the layered algorithm:
 *
 * 1. NETWORK_SIMPLEX node placement (a large connected diagram) gives way to
 *    Brandes–Köpf, which needs little stack.
 * 2. EDGE_LENGTH post-compaction runs a network simplex of its own over every
 *    line segment, so a diagram with many relationships (130 tables, 1,500
 *    lines) still overflows with Brandes–Köpf: it is left out too. The
 *    tables keep their columns; the result is only a little less tight.
 *
 * A step that would change nothing (the diagram's own options already ask for
 * it) is skipped.
 */
export function stackSafeFallbacks(options: LayoutOptions): LayoutOptions[] {
  return stackSafeFallbackRungs(options).map((step) => step.options);
}

/**
 * {@link stackSafeFallbacks}, each with its rung: 2 for Brandes–Köpf, 3 for
 * the one that leaves post-compaction out. A rung is named by what it drops,
 * so a diagram whose own options already use Brandes–Köpf has only rung 3.
 */
export function stackSafeFallbackRungs(options: LayoutOptions): Array<{ rung: LayoutFallbackRung; options: LayoutOptions }> {
  const steps: Array<{ rung: LayoutFallbackRung; options: LayoutOptions }> = [];
  let current = options;
  if (current['elk.layered.nodePlacement.strategy'] !== STACK_SAFE_NODE_PLACEMENT) {
    current = { ...current, 'elk.layered.nodePlacement.strategy': STACK_SAFE_NODE_PLACEMENT };
    steps.push({ rung: 2, options: current });
  }
  if (current[POST_COMPACTION] !== undefined && current[POST_COMPACTION] !== 'NONE') {
    current = { ...current, [POST_COMPACTION]: 'NONE' };
    steps.push({ rung: 3, options: current });
  }
  return steps;
}

/** A layout that failed because the worker ran out of stack (V8: RangeError, Firefox: InternalError). */
export function isStackOverflow(err: unknown): boolean {
  return isStackOverflowText(err instanceof Error ? err.message : String(err));
}

/**
 * Refuse a layout ELK returned without a usable place for every table: a
 * table missing from the result, or one whose x or y is missing or not a
 * finite number. Saving such a result would stack the tables on one spot (or
 * be refused by the host), so it fails as its own class and the next
 * fallback, if any, is tried.
 */
function assertUsableLayout(layouted: ElkNode, tableCount: number): void {
  const children = layouted?.children ?? [];
  const usable = children.length >= tableCount
    && children.every((child) => Number.isFinite(child.x) && Number.isFinite(child.y));
  if (!usable) throw guardError('ELK returned a layout with a table left unplaced', 'result');
}

/**
 * Run `elk.layout()` but guarantee the promise settles: it rejects if the
 * worker raises an uncaught error or the layout exceeds `LAYOUT_TIMEOUT_MS`,
 * in both cases recycling the worker so the next attempt starts clean.
 */
function layoutWithGuard(elk: IELK, graph: ElkNode): Promise<ElkNode> {
  return new Promise<ElkNode>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = <T,>(fn: (value: T) => void) => (value: T) => {
      if (settled) return;
      settled = true;
      pendingRejecters.delete(rejectOnce);
      if (timer !== null) clearTimeout(timer);
      fn(value);
    };
    const rejectOnce = finish<Error>(reject);
    const resolveOnce = finish<ElkNode>(resolve);

    pendingRejecters.add(rejectOnce);
    timer = setTimeout(() => {
      resetElk(guardError(`ELK layout timed out after ${LAYOUT_TIMEOUT_MS / 1000}s`, 'timeout'));
    }, LAYOUT_TIMEOUT_MS);

    elk.layout(graph).then(resolveOnce, (err: unknown) => {
      rejectOnce(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

// ---------------------------------------------------------------------------
// Graph conversion
// ---------------------------------------------------------------------------

/**
 * Convert React Flow nodes into ELK children nodes.
 * Each node uses its measured DOM size when React Flow has one; otherwise an
 * estimated width (based on content) and height (based on the rows actually
 * rendered — collapsed/stub aware — and whether a grain subtitle is present)
 * so the layered layout reserves the correct amount of space.
 *
 * When `partitions` is provided, each node gets a `layoutOptions` entry
 * assigning it to the given spatial partition index.
 */
export function toElkChildren(
  nodes: TableFlowNode[],
  partitions: Map<string, number> | null,
): ElkNode[] {
  return nodes.map((node) => {
    const { width, height } = resolveNodeDimensions(node);
    const elkNode: ElkNode = {
      id: node.id,
      width,
      height,
    };
    if (partitions !== null) {
      elkNode.layoutOptions = {
        'elk.partitioning.partition': String(partitions.get(node.id) ?? 0),
      };
    }
    return elkNode;
  });
}

/**
 * Convert React Flow edges into ELK extended edges, leaving out a
 * relationship to a table that is not in the layout (ELK refuses the whole
 * graph for one).
 */
function toElkEdges(nodes: TableFlowNode[], edges: FkFlowEdge[]): ElkExtendedEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  return edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({
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
 * Compute an optimal layer bound (max models per column) based on graph size.
 *
 * Uses √n as the base — this produces a roughly square layout which balances
 * width and height naturally:
 *   4 nodes → 2,  9 → 3,  16 → 4,  25 → 5,  36 → 6
 *
 * Clamped to [2, 10] to avoid degenerate layouts.
 */
export function detectLayerBound(nodeCount: number): number {
  return Math.max(2, Math.min(10, Math.ceil(Math.sqrt(nodeCount))));
}

/**
 * Detect the best partition strategy for the given nodes and edges when
 * `partitionStrategy` is 'auto'.
 */
export function detectStrategy(
  nodes: TableFlowNode[],
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
 * What produced a layout's positions:
 *
 *   default      — ELK's layout with the options asked for.
 *   brandesKoepf — ELK with Brandes–Köpf node placement (fallback rung 2).
 *   noCompaction — that, with post-compaction left out too (rung 3).
 *   ungrouped    — that, with grouping (ELK partitioning) turned off, as None lays out.
 *   grid         — {@link gridLayout}: no ELK, the tables in dependency order in
 *                  tidy columns (rows for Down), for a diagram ELK cannot lay out
 *                  or one too large to try ({@link GRID_LAYOUT_MIN_TABLES}).
 */
export type LayoutStep = 'default' | 'brandesKoepf' | 'noCompaction' | 'ungrouped' | 'grid';

/** How a layout that worked was produced (the toolbar's log line and notice). */
export interface LayoutOutcome {
  step: LayoutStep;
  /** The grouping laid out, resolved from `auto`. */
  grouping: 'role' | 'depth' | 'none';
  /**
   * Whether the grouping became ELK's bands (`partitioned`), was kept by the
   * relationships' direction alone because the diagram is too large for ELK's
   * bands ({@link PARTITION_JOIN_LIMIT}), or was not used (`off`: None, a
   * single band, or the `ungrouped` step).
   */
  bands: 'partitioned' | 'direction' | 'off';
  /** Why the default layout was not used: the diagram's size, or the first error's text (for the local log only). */
  reason?: 'size' | string;
  /** The class of the default layout's failure, when it failed (what the user is told: {@link layoutFailureNotice}). */
  failure?: LayoutFailure;
}

/** What a caller may hear about a layout as it runs (usage telemetry). */
export interface LayoutHooks {
  /** The layout overflowed the worker's stack and is being laid out again with the {@link stackSafeFallbacks} (told once). */
  onStackFallback?: () => void;
  /**
   * The default layout failed (for any reason) and this fallback produced the
   * layout (told once). The steps after rung 3 (grouping off, the grid) are
   * told as 3 until telemetry has keys of their own.
   */
  onFallbackRung?: (rung: LayoutFallbackRung) => void;
  /** How the layout that worked was produced (told once, on success). */
  onOutcome?: (outcome: LayoutOutcome) => void;
}

/**
 * At or above this many tables, or {@link GRID_LAYOUT_MIN_RELATIONSHIPS}
 * relationships, ELK is not tried: in a Web Worker it runs out of time
 * (30 s), stack or memory long before it finishes, so the diagram goes
 * straight to the {@link gridLayout}.
 */
export const GRID_LAYOUT_MIN_TABLES = 1000;
export const GRID_LAYOUT_MIN_RELATIONSHIPS = 2000;

/**
 * ELK's partitioning joins every table of one band to every table of the
 * next (|band i| × |band i+1| constraint edges), and its layering then costs
 * far more than the diagram itself: 300 tables in five bands took over a
 * minute. Above this many joins the bands are kept by the relationships'
 * direction alone ({@link orientEdgesForPartitions}): every relationship
 * still points from an earlier band to a later one, but unrelated tables are
 * placed freely.
 */
export const PARTITION_JOIN_LIMIT = 3000;

/**
 * Above this many tables a layout starts with Brandes–Köpf node placement
 * rather than network simplex (see {@link planElkLayout}).
 */
export const NETWORK_SIMPLEX_MAX_TABLES = 150;

/** How many constraint edges ELK's partitioning would add for these bands. */
export function partitionJoinCount(partitions: Map<string, number>): number {
  const sizes = new Map<number, number>();
  for (const band of partitions.values()) sizes.set(band, (sizes.get(band) ?? 0) + 1);
  const bands = [...sizes.keys()].sort((a, b) => a - b);
  let joins = 0;
  for (let i = 0; i + 1 < bands.length; i++) joins += sizes.get(bands[i])! * sizes.get(bands[i + 1])!;
  return joins;
}

function positiveOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The last-resort layout, without ELK: the tables in dependency order (by
 * band when grouping, then by depth, a cycle's tables together), filled into
 * columns (rows for Down) of a length that gives the diagram ELK's aspect
 * ratio, a new column starting at each band. Iterative, linear apart from one
 * sort: 5,000 tables take milliseconds on any machine. Uses the same node
 * sizes and spacing as ELK, so nothing overlaps.
 */
export function gridLayout(
  nodes: TableFlowNode[],
  edges: FkFlowEdge[],
  options: LayoutOptions = {},
  partitions: Map<string, number> | null = null,
): Record<string, NodePosition> {
  const n = nodes.length;
  if (n === 0) return {};
  const { order } = dependencyOrder(nodes, edges, partitions);
  const gap = positiveOr(options['elk.spacing.nodeNode'], 70);
  const layerGap = positiveOr(options['elk.layered.spacing.nodeNodeBetweenLayers'], 160);
  const ratio = positiveOr(options['elk.aspectRatio'], 2.5);
  const down = options['elk.direction'] === 'DOWN';
  const sizes = nodes.map((node) => {
    const { width, height } = resolveNodeDimensions(node);
    return { w: positiveOr(width, NODE_WIDTH), h: positiveOr(height, 120) };
  });
  // "along" runs down a column (across a row for Down); "across" steps to the next one.
  const alongOf = (i: number) => (down ? sizes[i].w : sizes[i].h);
  const acrossOf = (i: number) => (down ? sizes[i].h : sizes[i].w);
  let sumAlong = 0;
  let sumAcross = 0;
  for (let i = 0; i < n; i++) { sumAlong += alongOf(i) + gap; sumAcross += acrossOf(i) + layerGap; }
  const along = sumAlong / n;
  const across = sumAcross / n;
  // k tables per line, n / k lines: width / height = ratio.
  const perLine = down ? Math.sqrt((ratio * n * across) / along) : Math.sqrt((n * across) / (ratio * along));
  const k = Math.max(1, Math.min(n, Math.round(perLine)));
  const band = (i: number) => partitions?.get(nodes[i].id) ?? 0;

  const positions: Record<string, NodePosition> = {};
  let lineStart = 0; // position of the current line, across
  let lineThickness = 0;
  let cursor = 0; // position within the line, along
  let count = 0;
  let lastBand = order.length > 0 ? band(order[0]) : 0;
  for (const i of order) {
    if (count > 0 && (count >= k || band(i) !== lastBand)) {
      lineStart += lineThickness + layerGap;
      lineThickness = 0;
      cursor = 0;
      count = 0;
    }
    lastBand = band(i);
    const a = Math.round(cursor);
    const b = Math.round(lineStart);
    positions[nodes[i].id] = down ? { x: a, y: b } : { x: b, y: a };
    cursor += alongOf(i) + gap;
    lineThickness = Math.max(lineThickness, acrossOf(i));
    count++;
  }
  return positions;
}

/** A layout step's failure that no other ELK step can do better on: the grid takes over at once. */
function goStraightToGrid(failure: LayoutFailure): boolean {
  return failure === 'timeout' || failure === 'worker' || failure === 'memory';
}

/** What {@link planElkLayout} works out before ELK runs. */
export interface ElkLayoutPlan {
  /** The grouping, resolved from `auto`. */
  grouping: 'role' | 'depth' | 'none';
  /** How the grouping reaches ELK (see {@link LayoutOutcome.bands}). */
  bands: LayoutOutcome['bands'];
  /** The bands the {@link gridLayout} starts columns at, if any. */
  gridBands: Map<string, number> | null;
  /** The options of the default layout. */
  options: Record<string, string>;
  /** The default layout's graph. */
  graph: ElkNode;
  /** The lighter ELK layouts tried in turn when the default one fails, before the grid. */
  fallbacks: Array<{ step: LayoutStep; rung: LayoutFallbackRung; graph: ElkNode }>;
}

/**
 * The graph and options ELK gets for a layout, and the fallbacks after it.
 * Pure: {@link runElkLayout} runs it; the repro scripts hand the same graphs
 * to a real browser worker.
 */
export function planElkLayout(
  nodes: TableFlowNode[],
  edges: FkFlowEdge[],
  layoutOptions?: LayoutOptions,
  partitionStrategy: PartitionStrategy = 'auto',
): ElkLayoutPlan {
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

  // Bands: ELK's own partitioning, or (a large diagram) the relationships'
  // direction alone, or none. Either way every relationship ELK gets points
  // forward along one order, so ELK is never handed a cycle across bands.
  let bands: LayoutOutcome['bands'] = 'off';
  let edgeBands: Map<string, number> | null = partitions;
  if (partitions !== null && new Set(partitions.values()).size > 1) {
    if (partitionJoinCount(partitions) > PARTITION_JOIN_LIMIT) {
      bands = 'direction';
      mergedOptions['elk.partitioning.activate'] = 'false';
      partitions = null;
    } else {
      bands = 'partitioned';
    }
  }
  if (edgeBands !== null && bands === 'off') edgeBands = null;

  // Network-simplex node placement takes seconds to minutes on a large
  // diagram, and overflows a worker's stack on larger ones: in a Chromium
  // worker 150 tables took 5 s, 200 took 14 s and 300 ran past the 30 s guard,
  // where Brandes–Köpf takes well under a second. A large diagram, or one
  // whose bands are kept by direction, starts with Brandes–Köpf, unless the
  // diagram's own options choose.
  if ((nodes.length > NETWORK_SIMPLEX_MAX_TABLES || bands === 'direction')
    && layoutOptions?.['elk.layered.nodePlacement.strategy'] === undefined) {
    mergedOptions['elk.layered.nodePlacement.strategy'] = STACK_SAFE_NODE_PLACEMENT;
  }

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: mergedOptions,
    children: toElkChildren(nodes, partitions),
    edges: edgeBands !== null ? orientEdgesForPartitions(nodes, edges, edgeBands) : toElkEdges(nodes, edges),
  };

  const fallbacks: ElkLayoutPlan['fallbacks'] = [];
  let lastOptions = mergedOptions;
  for (const fallback of stackSafeFallbackRungs(mergedOptions)) {
    fallbacks.push({ step: fallback.rung === 2 ? 'brandesKoepf' : 'noCompaction', rung: fallback.rung, graph: { ...graph, layoutOptions: fallback.options } });
    lastOptions = fallback.options;
  }
  if (bands !== 'off') {
    // Grouping off: what None lays out, on the lightest options so far.
    fallbacks.push({
      step: 'ungrouped',
      rung: 3,
      graph: {
        ...graph,
        layoutOptions: { ...lastOptions, 'elk.partitioning.activate': 'false' },
        children: toElkChildren(nodes, null),
        edges: toElkEdges(nodes, edges),
      },
    });
  }

  return { grouping: resolved, bands, gridBands: partitions ?? edgeBands, options: mergedOptions, graph, fallbacks };
}

/**
 * Run ELK layout on a set of React Flow nodes and edges.
 *
 * Never fails on a diagram's size or shape: the default layout gives way to
 * lighter ELK layouts ({@link stackSafeFallbackRungs}), then to ELK with the
 * grouping off, then to the {@link gridLayout}, which needs no ELK. A diagram
 * of {@link GRID_LAYOUT_MIN_TABLES} tables or more goes to the grid at once.
 *
 * @param nodes — current React Flow model nodes.
 * @param edges — current React Flow FK edges.
 * @param layoutOptions — optional per-domain ELK options from
 *   `viewConfig.layoutOptions`. Merged on top of defaults.
 * @param partitionStrategy — how to assign nodes to spatial bands.
 *   Defaults to 'auto' (auto-detect from graph structure).
 * @param hooks — told when the layout falls back, and how it was produced.
 * @returns a positions map keyed by model name, ready for
 *   `viewConfig.positions`.
 */
export async function runElkLayout(
  nodes: TableFlowNode[],
  edges: FkFlowEdge[],
  layoutOptions?: LayoutOptions,
  partitionStrategy: PartitionStrategy = 'auto',
  hooks: LayoutHooks = {},
): Promise<Record<string, NodePosition>> {
  const plan = planElkLayout(nodes, edges, layoutOptions, partitionStrategy);
  const { grouping: resolved, bands, graph } = plan;

  const tell = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // Telemetry never stops a layout.
    }
  };
  const finish = (positions: Record<string, NodePosition>, outcome: LayoutOutcome): Record<string, NodePosition> => {
    tell(() => hooks.onOutcome?.(outcome));
    return positions;
  };

  // A diagram this large goes to the grid without trying ELK.
  if (nodes.length >= GRID_LAYOUT_MIN_TABLES || edges.length >= GRID_LAYOUT_MIN_RELATIONSHIPS) {
    const positions = gridLayout(nodes, edges, plan.options, plan.gridBands);
    tell(() => hooks.onFallbackRung?.(3));
    return finish(positions, { step: 'grid', grouping: resolved, bands: bands === 'off' ? 'off' : 'direction', reason: 'size' });
  }

  // One attempt: a layout, refused when it leaves a table unplaced.
  const attempt = async (attemptGraph: ElkNode): Promise<ElkNode> => {
    const result = await layoutWithGuard(getElk(), attemptGraph);
    assertUsableLayout(result, nodes.length);
    return result;
  };
  const elkPositions = (layouted: ElkNode): Record<string, NodePosition> => {
    const positions: Record<string, NodePosition> = {};
    for (const child of layouted.children ?? []) {
      positions[child.id] = {
        x: Math.round(child.x ?? 0),
        y: Math.round(child.y ?? 0),
      };
    }
    return positions;
  };

  let firstError: unknown;
  try {
    return finish(elkPositions(await attempt(graph)), { step: 'default', grouping: resolved, bands });
  } catch (err) {
    firstError = err;
  }

  // The default layout failed. On a large or densely related diagram its
  // node placement and its post-compaction recurse deeply and overflow the
  // worker's stack, and the compaction can throw on what it is given (ELK's
  // "Invalid hitboxes for scanline", seen with two-way relationships). Lay it
  // out again with each lighter ELK step in turn, then with the grouping off,
  // then with the grid, rather than fail. A layout that ran out of time or
  // memory, or whose worker died, goes straight to the grid: the user has
  // waited long enough, and another ELK run would fail the same way.
  const err = firstError;
  const reason = err instanceof Error ? (err.message || err.name) : String(err);
  const failure = classifyLayoutFailure(err);
  if (isStackOverflow(err)) tell(() => hooks.onStackFallback?.());

  const steps = plan.fallbacks;
  let lastError: unknown = err;
  if (!goStraightToGrid(failure)) {
    for (const step of steps) {
      try {
        const positions = elkPositions(await attempt(step.graph));
        tell(() => hooks.onFallbackRung?.(step.rung));
        return finish(positions, { step: step.step, grouping: resolved, bands: step.step === 'ungrouped' ? 'off' : bands, reason, failure });
      } catch (stepErr) {
        lastError = stepErr;
        if (goStraightToGrid(classifyLayoutFailure(stepErr))) break;
      }
    }
  }

  try {
    const positions = gridLayout(nodes, edges, plan.options, plan.gridBands);
    assertUsableLayout({ id: 'root', children: Object.entries(positions).map(([id, p]) => ({ id, ...p })) }, nodes.length);
    tell(() => hooks.onFallbackRung?.(3));
    return finish(positions, { step: 'grid', grouping: resolved, bands: bands === 'off' ? 'off' : 'direction', reason, failure });
  } catch (gridErr) {
    lastError = gridErr;
  }

  // Even the grid failed: the first error is the one thrown, carrying how the last step failed (telemetry).
  if (typeof err === 'object' && err !== null) {
    const outcome: LadderOutcome = { lastFailure: classifyLayoutFailure(lastError) };
    try {
      Object.defineProperty(err, LAYOUT_LADDER, { value: outcome, configurable: true });
    } catch {
      // A frozen error keeps its class; only the ladder's outcome is lost.
    }
  }
  throw err;
}

/**
 * A button a layout notice's toast can offer: `retryLayout` runs Auto Layout
 * again, `layoutFeedback` opens Send Feedback filled in with the toast's
 * words. The editor store re-exports it as its toast's buttons.
 */
export type ToastAction = 'retryLayout' | 'layoutFeedback';

/** What the canvas tells the user about a layout: the toast's words and its buttons. */
export interface LayoutNotice {
  message: string;
  actions: ToastAction[];
}

/**
 * What the canvas says when the full layout failed (#294), by the failure's
 * class: never the engine's name or the error's own text, whose problem it is,
 * and what to do next. `arranged`: the tables were put in the grid's tidy
 * columns; otherwise they stay where they were. A diagram too large to finish
 * in time or memory is a limit, and trying again would only wait again, so it
 * offers Send Feedback alone. A refused layout setting (`unsupported`) may be
 * the diagram file's own `viewConfig.layoutOptions`, so it names them rather
 * than saying whose problem it is, and offers no Try Again (the same settings
 * fail the same way). Anything else is a bug and offers Try Again too.
 */
export function layoutFailureNotice(failure: LayoutFailure, arranged: boolean): LayoutNotice {
  const where = arranged ? 'in tidy columns in relationship order' : 'where they were';
  if (failure === 'timeout' || failure === 'memory') {
    const stopped = failure === 'timeout' ? `stopped after ${LAYOUT_TIMEOUT_MS / 1000} seconds` : 'ran out of memory';
    return {
      message: `This diagram is too large to arrange automatically (ERD Studio ${stopped}). Your tables are all here, ${where}. This is a limit in ERD Studio, not a problem with your files.`,
      actions: ['layoutFeedback'],
    };
  }
  if (failure === 'unsupported') {
    return {
      message: `ERD Studio couldn't arrange this diagram with its layout settings. Your tables are all here, ${where}. If the diagram file sets viewConfig.layoutOptions, check them; if it doesn't, this is a bug in ERD Studio.`,
      actions: ['layoutFeedback'],
    };
  }
  return {
    message: arranged
      ? "ERD Studio couldn't arrange this diagram automatically, so your tables are in tidy columns in relationship order. This is a bug in ERD Studio, not a problem with your files."
      : "ERD Studio couldn't arrange this diagram. Your tables are where they were. This is a bug in ERD Studio, not a problem with your files.",
    actions: ['retryLayout', 'layoutFeedback'],
  };
}

/**
 * What the canvas says about a layout that worked but not as asked (for the
 * user, as a notice), or `undefined` when it laid out as asked. The grouping
 * names are the layout popover's.
 */
export function layoutOutcomeNotice(outcome: LayoutOutcome, tables: number): LayoutNotice | undefined {
  const grouping = outcome.grouping === 'role' ? 'Table type' : outcome.grouping === 'depth' ? 'Join depth' : 'None';
  if (outcome.step === 'grid') {
    return outcome.reason === 'size'
      ? { message: `This diagram (${tables} tables) is too large for the full auto layout, so the tables were arranged in tidy columns in relationship order.`, actions: [] }
      : layoutFailureNotice(outcome.failure ?? 'other', true);
  }
  if (outcome.step === 'ungrouped') {
    return { message: `Grouping by ${grouping} failed on this diagram, so it was laid out with no grouping. Details are in the ERD Studio output.`, actions: [] };
  }
  return undefined;
}

/**
 * How many Table type bands these tables fall into. Under two, Table type has
 * nothing to group by and lays the tables out exactly as None does (an
 * imported diagram usually has no table types at all).
 */
export function tableTypeBandCount(nodes: TableFlowNode[]): number {
  return new Set(nodes.map((n) => roleToPartition(n.data.modelRole))).size;
}

/**
 * Whether a layout put every table back where it already was (within a
 * pixel), so the canvas visibly did nothing.
 */
export function layoutLeftTablesInPlace(
  nodes: TableFlowNode[],
  positions: Record<string, { x: number; y: number }>,
): boolean {
  if (nodes.length === 0) return false;
  return nodes.every((n) => {
    const p = positions[n.id];
    return p !== undefined
      && Math.abs(p.x - n.position.x) < 1
      && Math.abs(p.y - n.position.y) < 1;
  });
}

/**
 * What the canvas says when a re-applied layout moved nothing, so the user
 * does not take it for a layout that never ran (the reporter, 2026-11-12: "None
 * does not fail but I cannot tell whether it did anything"). With no table
 * types set, Table type and None produce the same arrangement.
 */
export function layoutUnchangedNotice(outcome: LayoutOutcome | undefined, tableTypeBands: number): string {
  const grouping = outcome?.grouping;
  if (tableTypeBands < 2 && (grouping === 'none' || grouping === 'role')) {
    const asked = grouping === 'none' ? 'None' : 'Table type';
    return `Layout re-applied (grouping: ${asked}); nothing moved. These tables have no table types to group by, so Table type and None arrange them the same way.`;
  }
  return 'Layout re-applied; nothing moved. The tables were already laid out this way with these settings.';
}

/**
 * One line for the extension's own log about a layout that worked but not as
 * asked (a fallback produced it, or the grouping was kept by direction only),
 * or `undefined` when it laid out as asked. Local only.
 */
export function layoutOutcomeLogMessage(outcome: LayoutOutcome): string | undefined {
  const grouping = `grouping ${outcome.grouping}`;
  const why = outcome.reason === undefined ? '' : outcome.reason === 'size' ? '; too large to try ELK' : `; the default layout failed: ${outcome.reason}`;
  switch (outcome.step) {
    case 'default':
      return outcome.bands === 'direction' ? `laid out with ${grouping} kept by relationship direction only (too many tables for ELK bands)` : undefined;
    case 'brandesKoepf':
      return `used fallback rung 2 (Brandes-Koepf node placement), ${grouping}${why}`;
    case 'noCompaction':
      return `used fallback rung 3 (no post-compaction), ${grouping}${why}`;
    case 'ungrouped':
      return `used the fallback with grouping off (asked for ${grouping})${why}`;
    case 'grid':
      return `used the grid fallback (no ELK), ${grouping}${why}`;
  }
}
