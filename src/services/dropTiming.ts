/**
 * How long a table drop takes to show, stage by stage.
 *
 * Users on large libraries see a drop from the Table Library take many
 * seconds before the table appears, while the same add runs in tens of
 * milliseconds in our tests. This times every drop in the user's own window
 * so the slow stage can be named: one line in the ERD Studio log with the
 * time of each stage (Send Feedback's "Include recent ERD Studio log" carries
 * it), and, for usage telemetry, fixed keys only: how the drop arrived, how
 * long it took to show (a range) and which stage was slowest.
 *
 * A drop is timed from the moment the host learns of it (`dropSeen`), by
 * whichever route it arrived:
 *
 * - `canvas`: a drop event reached the canvas (`dropTables`);
 * - `afterDrag`: no drop event came, and the canvas's first pointer event
 *   after the drag said it ended over the diagram (`dropTables`, `afterDrag`);
 * - `missedDrop`: the editor group took the drop and opened the table file,
 *   and the host added it from the tab it saw open (`missedCanvasDrop.ts`);
 * - `diagramsRow`: the drop landed on a diagram's row in the Diagrams view.
 *
 * Then, in order, each mark is the first time the add reached that point:
 *
 * | Stage     | From → to            | What it covers                                                   |
 * |-----------|----------------------|------------------------------------------------------------------|
 * | `open`    | dropSeen → opened    | bringing the diagram forward (missed drop, Diagrams row)          |
 * | `wait`    | opened → started     | the canvas's edit queue, a stage switch, a canvas still loading  |
 * | `prepare` | started → prepared   | dbt data, which tables, their relationships                       |
 * | `plan`    | prepared → planned   | the files the edit writes: library plan, every diagram it settles |
 * | `edit`    | planned → applied    | the WorkspaceEdit: files opened, `applyEdit`                      |
 * | `save`    | applied → saved      | saving every document the edit touched                          |
 * | `redraw`  | saved → posted       | building the diagram again and posting it to the canvas           |
 * | `canvas`  | posted → shown       | the message's trip, the canvas's render, its first paint after it |
 *
 * `shown` is the canvas's answer (`dropShown`) to the `dropTrace` posted
 * right after the redrawn diagram: it is sent after the next paint, so it
 * comes once the table is on screen (a hidden canvas paints when it is shown
 * again). The canvas also says how long it took from receiving the diagram
 * to that paint (`renderMs`), which splits the `canvas` stage into the
 * render and everything else (the trip, a busy host). A stage the drop did
 * not pass through has no time; the time before `dropSeen` (the drag itself)
 * is logged but never counted as a stage, as it is the user's hand.
 *
 * Pure and vscode-free: the clock, timers, path comparison and both sinks
 * are injected (`SemanticEditorProvider` wires the log and telemetry). The
 * keys come from fixed tables of literals, so a name, a path or a count can
 * never become one.
 */

import type { TelemetryFeature } from './telemetryPayload';

/** How the host learned of a drop. */
export type DropRoute = 'canvas' | 'afterDrag' | 'missedDrop' | 'diagramsRow';

/** The points an add passes, in order (`dropSeen` is the start). */
export type DropMark = 'opened' | 'started' | 'prepared' | 'planned' | 'applied' | 'saved' | 'posted' | 'shown';

/** The stages between marks, in order: also the tie order for the slowest (the first listed wins a tie). */
export const DROP_STAGES = ['open', 'wait', 'prepare', 'plan', 'edit', 'save', 'redraw', 'canvas'] as const;
export type DropStage = (typeof DROP_STAGES)[number];

/** Each stage's end mark (its start is the previous stage's end, or `dropSeen`). */
const STAGE_END: Record<DropStage, DropMark> = {
  open: 'opened',
  wait: 'started',
  prepare: 'prepared',
  plan: 'planned',
  edit: 'applied',
  save: 'saved',
  redraw: 'posted',
  canvas: 'shown',
};

/** How a timed drop ended. */
export type DropOutcome =
  /** The canvas painted the redrawn diagram. */
  | 'shown'
  /** The add finished without writing (all there already, refused, failed): nothing to show. */
  | 'nothingAdded'
  /** The diagram was redrawn and posted, but the canvas never said it painted it within {@link DROP_TRACE_TIMEOUT_MS}. */
  | 'notShown'
  /** The add never finished within {@link DROP_TRACE_TIMEOUT_MS}. */
  | 'timedOut'
  /** Another drop started before this one finished. */
  | 'superseded';

/** A drag that started longer ago than this is not the one a drop ends (the host forgets its drag as late). */
export const DROP_DRAG_FRESH_MS = 60_000;

/** How long a drop is followed before it is logged as it stands. */
export const DROP_TRACE_TIMEOUT_MS = 60_000;

/** A drop that took at least this long to show also counts its slowest stage. */
export const SLOW_DROP_MS = 1_000;

/** What a finished drop is reported as. */
export interface DropSummary {
  readonly id: number;
  readonly route: DropRoute;
  readonly outcome: DropOutcome;
  /** How many tables the drag carried (0 when no Table Library drag was remembered). */
  readonly tables: number;
  /** The diagram's file. */
  readonly target: string;
  /** From the drag starting to the drop being seen: the user's hand, not a stage. */
  readonly dragMs?: number;
  /** Each stage the drop passed through, in ms. */
  readonly stages: Partial<Record<DropStage, number>>;
  /** From the drop being seen to the last mark reached. */
  readonly totalMs: number;
  /** The longest stage, when the drop took at least {@link SLOW_DROP_MS}. */
  readonly slowest?: DropStage;
  /** The canvas's own time from receiving the redrawn diagram to its next paint. */
  readonly renderMs?: number;
  /** How late a timer queued right after the redrawn diagram was posted ran: the host's own work after the post. */
  readonly hostBusyMs?: number;
}

export interface DropTimerDeps {
  /** A monotonic clock in ms (`performance.now`). */
  now(): number;
  /** Whether two file paths are the same file. */
  samePath(a: string, b: string): boolean;
  /** Told every finished drop (the log line and the telemetry keys are made from it). */
  report(summary: DropSummary): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface Trace {
  readonly id: number;
  readonly route: DropRoute;
  readonly target: string;
  readonly tables: number;
  readonly seenAt: number;
  readonly dragAt?: number;
  readonly marks: Partial<Record<DropMark, number>>;
  renderMs?: number;
  hostBusyMs?: number;
  guard: unknown;
}

/** Follows one drop at a time, from {@link dropSeen} to its {@link DropSummary}. */
export class DropTimer {
  private nextId = 1;
  private drag: { at: number; tables: number } | undefined;
  private trace: Trace | undefined;

  constructor(private readonly deps: DropTimerDeps) {}

  /** A Table Library drag started: the drop that ends it is timed from here too (`dragMs`). */
  dragStarted(tables: number): void {
    this.drag = { at: this.deps.now(), tables };
  }

  /**
   * The host learned of a drop on the diagram at `target`, by `route`: start
   * following it. A drop still followed is reported as `superseded`. Returns
   * the new drop's id.
   */
  dropSeen(route: DropRoute, target: string): number {
    if (this.trace) this.finish('superseded');
    const now = this.deps.now();
    const drag = this.drag !== undefined && now - this.drag.at <= DROP_DRAG_FRESH_MS ? this.drag : undefined;
    this.drag = undefined;
    const id = this.nextId++;
    const trace: Trace = {
      id,
      route,
      target,
      tables: drag?.tables ?? 0,
      seenAt: now,
      ...(drag ? { dragAt: drag.at } : {}),
      marks: {},
      guard: undefined,
    };
    trace.guard = this.deps.setTimeout(() => {
      if (this.trace === trace) this.finish(trace.marks.posted !== undefined ? 'notShown' : 'timedOut');
    }, DROP_TRACE_TIMEOUT_MS);
    this.trace = trace;
    return id;
  }

  /** Whether a drop on the diagram at `target` is being followed. */
  following(target: string): boolean {
    return this.trace !== undefined && this.deps.samePath(this.trace.target, target);
  }

  /** The add of the drop on `target` reached `mark` (only its first time counts; anything else is ignored). */
  mark(mark: Exclude<DropMark, 'posted' | 'shown'>, target: string): void {
    const trace = this.trace;
    if (!trace || !this.deps.samePath(trace.target, target) || trace.marks[mark] !== undefined) return;
    trace.marks[mark] = this.deps.now();
  }

  /**
   * The redrawn diagram of `target` was posted to its canvas: returns the
   * drop's id for the `dropTrace` that follows it, or undefined when no drop
   * on `target` is followed (or this one was posted already).
   */
  posted(target: string): number | undefined {
    const trace = this.trace;
    if (!trace || !this.deps.samePath(trace.target, target) || trace.marks.posted !== undefined) return undefined;
    const at = this.deps.now();
    trace.marks.posted = at;
    this.deps.setTimeout(() => {
      trace.hostBusyMs = Math.max(0, this.deps.now() - at);
    }, 0);
    return trace.id;
  }

  /** The canvas painted the diagram posted for drop `id`, `renderMs` after it received it. */
  shown(id: number, renderMs?: number): void {
    const trace = this.trace;
    if (!trace || trace.id !== id || trace.marks.posted === undefined) return;
    trace.marks.shown = this.deps.now();
    if (renderMs !== undefined && Number.isFinite(renderMs) && renderMs >= 0) trace.renderMs = renderMs;
    this.finish('shown');
  }

  /**
   * The add of the drop on `target` returned. One that posted nothing
   * finished without a change to show; one that did waits for the canvas.
   */
  settle(target: string): void {
    const trace = this.trace;
    if (!trace || !this.deps.samePath(trace.target, target) || trace.marks.posted !== undefined) return;
    this.finish('nothingAdded');
  }

  /** Stop following (the window closes): nothing is reported. */
  dispose(): void {
    if (this.trace) this.deps.clearTimeout(this.trace.guard);
    this.trace = undefined;
    this.drag = undefined;
  }

  private finish(outcome: DropOutcome): void {
    const trace = this.trace;
    if (!trace) return;
    this.trace = undefined;
    this.deps.clearTimeout(trace.guard);
    this.deps.report(summarise(trace, outcome));
  }
}

/** A trace's stages and totals (exported for tests through {@link DropTimer}). */
function summarise(trace: Trace, outcome: DropOutcome): DropSummary {
  const stages: Partial<Record<DropStage, number>> = {};
  let from = trace.seenAt;
  let last = trace.seenAt;
  for (const stage of DROP_STAGES) {
    const at = trace.marks[STAGE_END[stage]];
    if (at === undefined) continue;
    stages[stage] = Math.max(0, Math.round(at - from));
    from = at;
    last = Math.max(last, at);
  }
  const totalMs = Math.max(0, Math.round(last - trace.seenAt));
  let slowest: DropStage | undefined;
  if (totalMs >= SLOW_DROP_MS) {
    for (const stage of DROP_STAGES) {
      const ms = stages[stage];
      if (ms !== undefined && (slowest === undefined || ms > (stages[slowest] ?? 0))) slowest = stage;
    }
  }
  return {
    id: trace.id,
    route: trace.route,
    outcome,
    tables: trace.tables,
    target: trace.target,
    ...(trace.dragAt !== undefined ? { dragMs: Math.max(0, Math.round(trace.seenAt - trace.dragAt)) } : {}),
    stages,
    totalMs,
    ...(slowest ? { slowest } : {}),
    ...(trace.renderMs !== undefined ? { renderMs: Math.round(trace.renderMs) } : {}),
    ...(trace.hostBusyMs !== undefined ? { hostBusyMs: Math.round(trace.hostBusyMs) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Telemetry keys
// ---------------------------------------------------------------------------

export const DROP_ROUTE_FEATURES: Record<DropRoute, TelemetryFeature> = {
  canvas: 'dropRouteCanvas',
  afterDrag: 'dropRouteAfterDrag',
  missedDrop: 'dropRouteMissedDrop',
  diagramsRow: 'dropRouteDiagramsRow',
};

export const DROP_SLOWEST_FEATURES: Record<DropStage, TelemetryFeature> = {
  open: 'dropSlowOpen',
  wait: 'dropSlowWait',
  prepare: 'dropSlowPrepare',
  plan: 'dropSlowPlan',
  edit: 'dropSlowEdit',
  save: 'dropSlowSave',
  redraw: 'dropSlowRedraw',
  canvas: 'dropSlowCanvas',
};

/** The range a shown drop's time falls in. */
export function dropShownFeature(totalMs: number): TelemetryFeature {
  if (totalMs < 1_000) return 'dropShownUnder1s';
  if (totalMs < 5_000) return 'dropShown1to5s';
  if (totalMs < 15_000) return 'dropShown5to15s';
  return 'dropShownOver15s';
}

/**
 * A finished drop's telemetry keys: its route; for one that wrote, how long
 * it took to show (a range, or `dropShownNever`); and, for one that took at
 * least {@link SLOW_DROP_MS}, its slowest stage. Superseded drops count
 * their route only. Takes the summary's fixed fields only.
 */
export function dropTimingFeatures(summary: Pick<DropSummary, 'route' | 'outcome' | 'totalMs' | 'slowest'>): TelemetryFeature[] {
  const keys: TelemetryFeature[] = [DROP_ROUTE_FEATURES[summary.route]];
  if (summary.outcome === 'shown') keys.push(dropShownFeature(summary.totalMs));
  else if (summary.outcome === 'notShown' || summary.outcome === 'timedOut') keys.push('dropShownNever');
  if (summary.slowest && summary.outcome !== 'superseded' && summary.outcome !== 'nothingAdded') keys.push(DROP_SLOWEST_FEATURES[summary.slowest]);
  return keys;
}

// ---------------------------------------------------------------------------
// The log line
// ---------------------------------------------------------------------------

const ROUTE_WORDS: Record<DropRoute, string> = {
  canvas: 'dropped on the canvas',
  afterDrag: 'drag ended over the canvas, no drop event',
  missedDrop: 'drop opened the file, added from its tab',
  diagramsRow: "dropped on the diagram's row",
};

const OUTCOME_WORDS: Record<DropOutcome, string> = {
  shown: 'shown',
  nothingAdded: 'nothing added',
  notShown: 'written, but the canvas never said it was shown',
  timedOut: 'the add had not finished',
  superseded: 'another drop started first',
};

/** A duration for the log: `840 ms`, `4.2 s`, `18 s`. */
export function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms / 1_000)} s`;
}

/**
 * The ERD Studio log's line for a finished drop: the route, the outcome and
 * total, every stage with its time, the canvas's render and the host's busy
 * time after the post, and the slowest stage. `diagram` is the diagram's
 * file name (the summary's target is a path and is not printed).
 */
export function dropTimingLogLine(summary: DropSummary, diagram: string): string {
  const what = summary.tables > 0 ? `${summary.tables} table${summary.tables === 1 ? '' : 's'}` : 'Tables';
  const head = `${what} onto ${diagram} (${ROUTE_WORDS[summary.route]}): ${OUTCOME_WORDS[summary.outcome]} after ${formatMs(summary.totalMs)}.`;
  const stages = DROP_STAGES.filter((s) => summary.stages[s] !== undefined).map((s) => `${s} ${formatMs(summary.stages[s]!)}`);
  const extra = [
    summary.renderMs !== undefined ? `canvas render ${formatMs(summary.renderMs)}` : '',
    summary.hostBusyMs !== undefined ? `host busy after posting ${formatMs(summary.hostBusyMs)}` : '',
    summary.dragMs !== undefined ? `drag before the drop ${formatMs(summary.dragMs)}` : '',
  ].filter(Boolean);
  return [
    head,
    stages.length > 0 ? `Stages: ${stages.join(' · ')}.` : 'No stage reached.',
    extra.length > 0 ? `${extra.join(' · ')}.` : '',
    summary.slowest ? `Slowest: ${summary.slowest}.` : '',
  ].filter(Boolean).join(' ');
}
