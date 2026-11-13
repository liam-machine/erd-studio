/**
 * Drop timing (`src/services/dropTiming.ts`): a drop is followed from the
 * moment the host learns of it to the canvas painting it, stage by stage;
 * each finished drop is reported once, as a log line (every stage's time)
 * and fixed telemetry keys (its route, a time range, its slowest stage).
 * Also the canvas's half (`webview/lib/dropTrace.ts`) and the `dropShown`
 * payload check. The provider's wiring is in `dropTables.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  DROP_ROUTE_FEATURES,
  DROP_SLOWEST_FEATURES,
  DROP_DRAG_FRESH_MS,
  DROP_STAGES,
  DROP_TRACE_TIMEOUT_MS,
  DropTimer,
  dropShownFeature,
  dropTimingFeatures,
  dropTimingLogLine,
  formatMs,
  type DropSummary,
} from '../../src/services/dropTiming';
import { FEATURES } from '../../src/services/telemetryPayload';
import { DROP_SHOWN_MAX_RENDER_MS, validateDropShownPayload } from '../../src/providers/payloadValidation';
import { _resetDropTraceForTests, answerDropTrace, noteDomainLoaded } from '../../webview/lib/dropTrace';

/** A timer on a fake clock with fake timers; `reports` collects what it reports. */
function harness() {
  let clock = 0;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let nextTimer = 1;
  const reports: DropSummary[] = [];
  const timer = new DropTimer({
    now: () => clock,
    samePath: (a, b) => a.toLowerCase() === b.toLowerCase(),
    report: (s) => reports.push(s),
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.push({ fn, at: clock + ms, id }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  });
  /** Move the clock on by `ms`, running every timer due on the way. */
  const advance = (ms: number): void => {
    const until = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      clock = next.at;
      next.fn();
    }
    clock = until;
  };
  return { timer, reports, advance };
}

const D = '/p/.erd-studio/gold/diagrams/small.dbml';

describe('DropTimer', () => {
  it('times every stage of a drop that missed the canvas, from the drop to the paint, and names the slowest', () => {
    const { timer, reports, advance } = harness();
    timer.dragStarted(1);
    advance(2_000); // the user's hand
    timer.dropSeen('missedDrop', D);
    advance(300); timer.mark('opened', D);
    advance(17_000); timer.mark('started', D);
    advance(15); timer.mark('prepared', D);
    advance(40); timer.mark('planned', D);
    advance(20); timer.mark('applied', D);
    advance(120); timer.mark('saved', D);
    advance(35);
    const id = timer.posted(D);
    expect(id).toBe(1);
    advance(2); // the host's own work after the post
    advance(500);
    timer.shown(id!, 280);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      id: 1,
      route: 'missedDrop',
      outcome: 'shown',
      tables: 1,
      target: D,
      dragMs: 2_000,
      stages: { open: 300, wait: 17_000, prepare: 15, plan: 40, edit: 20, save: 120, redraw: 35, canvas: 502 },
      totalMs: 18_032,
      slowest: 'wait',
      renderMs: 280,
      hostBusyMs: 0,
    });
    expect(dropTimingFeatures(reports[0])).toEqual(['dropRouteMissedDrop', 'dropShownOver15s', 'dropSlowWait']);
  });

  it('a stage a drop does not pass through has no time, and the next stage runs from the last mark reached', () => {
    const { timer, reports, advance } = harness();
    timer.dropSeen('canvas', D);
    advance(10); timer.mark('started', D);
    advance(5); timer.mark('prepared', D);
    advance(5); timer.mark('planned', D);
    advance(5); timer.mark('applied', D);
    advance(5); timer.mark('saved', D);
    advance(5); const id = timer.posted(D)!;
    advance(5); timer.shown(id);
    expect(reports[0].stages).toEqual({ wait: 10, prepare: 5, plan: 5, edit: 5, save: 5, redraw: 5, canvas: 5 });
    expect(reports[0].totalMs).toBe(40);
    // Under a second: no slowest stage; a drop with no remembered drag carries no table count or drag time.
    expect(reports[0].slowest).toBeUndefined();
    expect(reports[0].tables).toBe(0);
    expect(reports[0].dragMs).toBeUndefined();
    expect(dropTimingFeatures(reports[0])).toEqual(['dropRouteCanvas', 'dropShownUnder1s']);
  });

  it('counts only the first time a mark is reached, only for the diagram being followed, and nothing with no drop followed', () => {
    const { timer, reports, advance } = harness();
    timer.mark('started', D);
    expect(timer.posted(D)).toBeUndefined();
    timer.dropSeen('canvas', D);
    advance(10); timer.mark('started', '/p/other.dbml');
    advance(10); timer.mark('started', D.toUpperCase());
    advance(10); timer.mark('started', D);
    advance(10);
    const id = timer.posted(D)!;
    expect(timer.posted(D)).toBeUndefined();
    timer.shown(id + 1);
    expect(reports).toEqual([]);
    timer.shown(id);
    expect(reports[0].stages).toEqual({ wait: 20, redraw: 20, canvas: 0 });
  });

  it('a drop whose add wrote nothing finishes when the add returns; one that wrote waits for the canvas', () => {
    const { timer, reports, advance } = harness();
    timer.dropSeen('canvas', D);
    advance(30); timer.mark('started', D);
    timer.settle(D);
    expect(reports.map((r) => r.outcome)).toEqual(['nothingAdded']);
    expect(dropTimingFeatures(reports[0])).toEqual(['dropRouteCanvas']);
    timer.dropSeen('afterDrag', D);
    timer.posted(D);
    timer.settle(D);
    expect(reports).toHaveLength(1);
  });

  it('a drop the canvas never answers is reported after a minute as not shown; an add that never finished as timed out', () => {
    const { timer, reports, advance } = harness();
    timer.dropSeen('diagramsRow', D);
    advance(4_000); timer.mark('started', D);
    timer.posted(D);
    advance(DROP_TRACE_TIMEOUT_MS);
    expect(reports.map((r) => r.outcome)).toEqual(['notShown']);
    expect(dropTimingFeatures(reports[0])).toEqual(['dropRouteDiagramsRow', 'dropShownNever', 'dropSlowWait']);
    timer.dropSeen('missedDrop', D);
    advance(DROP_TRACE_TIMEOUT_MS);
    expect(reports.map((r) => r.outcome)).toEqual(['notShown', 'timedOut']);
    expect(dropTimingFeatures(reports[1])).toEqual(['dropRouteMissedDrop', 'dropShownNever']);
  });

  it('a new drop before the last one finished reports the last one as superseded, and the timeout of the old one is gone', () => {
    const { timer, reports, advance } = harness();
    timer.dropSeen('canvas', D);
    advance(1_500);
    timer.dropSeen('canvas', D);
    expect(reports.map((r) => r.outcome)).toEqual(['superseded']);
    expect(dropTimingFeatures(reports[0])).toEqual(['dropRouteCanvas']);
    advance(DROP_TRACE_TIMEOUT_MS - 1);
    expect(reports).toHaveLength(1);
    advance(1);
    expect(reports.map((r) => r.outcome)).toEqual(['superseded', 'timedOut']);
  });

  it('the host busy time is how late a timer queued at the post ran', () => {
    const { timer, reports, advance } = harness();
    timer.dropSeen('canvas', D);
    const id = timer.posted(D)!;
    advance(0); // the timer runs on time
    advance(900);
    timer.shown(id, 50);
    expect(reports[0].hostBusyMs).toBe(0);
    expect(reports[0].renderMs).toBe(50);
  });

  it('a drag older than a minute is not the one the drop ends: no table count or drag time', () => {
    const { timer, reports, advance } = harness();
    timer.dragStarted(2);
    advance(DROP_DRAG_FRESH_MS + 1);
    timer.dropSeen('canvas', D);
    timer.settle(D);
    expect(reports[0].tables).toBe(0);
    expect(reports[0].dragMs).toBeUndefined();
  });

  it('dispose stops following without a report', () => {
    const { timer, reports, advance } = harness();
    timer.dropSeen('canvas', D);
    timer.dispose();
    advance(DROP_TRACE_TIMEOUT_MS * 2);
    expect(reports).toEqual([]);
  });
});

describe('drop timing keys', () => {
  it('are fixed allowlisted literals: one per route and per stage, and five time ranges', () => {
    const keys = [
      ...Object.values(DROP_ROUTE_FEATURES),
      ...Object.values(DROP_SLOWEST_FEATURES),
      'dropShownUnder1s', 'dropShown1to5s', 'dropShown5to15s', 'dropShownOver15s', 'dropShownNever',
    ];
    for (const key of keys) expect(FEATURES as readonly string[]).toContain(key);
    expect(Object.keys(DROP_SLOWEST_FEATURES)).toEqual([...DROP_STAGES]);
    // The drop keys are appended as one run, in this order, after #305's.
    const at = FEATURES.indexOf('dropRouteCanvas');
    expect(at).toBe(FEATURES.indexOf('suggestPromptShownAgain') + 1);
    expect(FEATURES.slice(at, at + 17)).toEqual([
      'dropRouteCanvas', 'dropRouteAfterDrag', 'dropRouteMissedDrop', 'dropRouteDiagramsRow',
      'dropShownUnder1s', 'dropShown1to5s', 'dropShown5to15s', 'dropShownOver15s', 'dropShownNever',
      'dropSlowOpen', 'dropSlowWait', 'dropSlowPrepare', 'dropSlowPlan', 'dropSlowEdit', 'dropSlowSave', 'dropSlowRedraw', 'dropSlowCanvas',
    ]);
  });

  it('puts a time in its range at the edges', () => {
    expect([0, 999, 1_000, 4_999, 5_000, 14_999, 15_000, 120_000].map(dropShownFeature)).toEqual([
      'dropShownUnder1s', 'dropShownUnder1s', 'dropShown1to5s', 'dropShown1to5s', 'dropShown5to15s', 'dropShown5to15s', 'dropShownOver15s', 'dropShownOver15s',
    ]);
  });

  it('only a drop that wrote and took a second or more names its slowest stage', () => {
    expect(dropTimingFeatures({ route: 'afterDrag', outcome: 'shown', totalMs: 3_000, slowest: 'save' })).toEqual(['dropRouteAfterDrag', 'dropShown1to5s', 'dropSlowSave']);
    expect(dropTimingFeatures({ route: 'afterDrag', outcome: 'nothingAdded', totalMs: 3_000, slowest: 'prepare' })).toEqual(['dropRouteAfterDrag']);
    expect(dropTimingFeatures({ route: 'afterDrag', outcome: 'superseded', totalMs: 3_000, slowest: 'wait' })).toEqual(['dropRouteAfterDrag']);
  });
});

describe('the log line', () => {
  it('names the route, the outcome and total, every stage reached, the canvas render, the busy host, the drag, and the slowest stage', () => {
    const summary: DropSummary = {
      id: 3, route: 'missedDrop', outcome: 'shown', tables: 1, target: '/p/x.dbml', dragMs: 2_100,
      stages: { open: 300, wait: 17_900, prepare: 12, plan: 45, edit: 30, save: 120, redraw: 40, canvas: 310 },
      totalMs: 18_757, slowest: 'wait', renderMs: 280, hostBusyMs: 3,
    };
    expect(dropTimingLogLine(summary, 'small.dbml')).toBe(
      '1 table onto small.dbml (drop opened the file, added from its tab): shown after 19 s. '
      + 'Stages: open 300 ms · wait 18 s · prepare 12 ms · plan 45 ms · edit 30 ms · save 120 ms · redraw 40 ms · canvas 310 ms. '
      + 'canvas render 280 ms · host busy after posting 3 ms · drag before the drop 2.1 s. Slowest: wait.',
    );
  });

  it('says so when nothing was reached, and never prints the path', () => {
    const line = dropTimingLogLine({ id: 1, route: 'canvas', outcome: 'nothingAdded', tables: 0, target: '/secret/path/a.dbml', stages: {}, totalMs: 4 }, 'a.dbml');
    expect(line).toBe('Tables onto a.dbml (dropped on the canvas): nothing added after 4 ms. No stage reached.');
    expect(line).not.toContain('/secret');
  });

  it('formats a duration in ms, then tenths of a second, then whole seconds', () => {
    expect([0, 999.4, 1_000, 9_949, 10_000, 18_757].map(formatMs)).toEqual(['0 ms', '999 ms', '1.0 s', '9.9 s', '10 s', '19 s']);
  });
});

describe('validateDropShownPayload', () => {
  it('takes a whole trace id from 1 and an optional render time within ten minutes, and nothing else', () => {
    expect(validateDropShownPayload({ trace: 1 })).toBe(true);
    expect(validateDropShownPayload({ trace: 7, renderMs: 0 })).toBe(true);
    expect(validateDropShownPayload({ trace: 7, renderMs: 12.5 })).toBe(true);
    expect(validateDropShownPayload({ trace: 7, renderMs: DROP_SHOWN_MAX_RENDER_MS })).toBe(true);
    for (const bad of [undefined, null, [], 1, {}, { trace: 0 }, { trace: 1.5 }, { trace: '1' }, { trace: -1 },
      { trace: 1, renderMs: -1 }, { trace: 1, renderMs: Number.NaN }, { trace: 1, renderMs: '5' }, { trace: 1, renderMs: DROP_SHOWN_MAX_RENDER_MS + 1 }]) {
      expect(validateDropShownPayload(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the canvas answers a dropTrace after its next paint', () => {
  beforeEach(() => _resetDropTraceForTests());

  function fakeFrames() {
    let clock = 0;
    const frames: Array<() => void> = [];
    const tasks: Array<() => void> = [];
    return {
      deps: { now: () => clock, frame: (cb: () => void) => { frames.push(cb); }, later: (cb: () => void) => { tasks.push(cb); } },
      tick: (ms: number) => { clock += ms; },
      paint: () => { for (const f of frames.splice(0)) f(); },
      runTasks: () => { for (const t of tasks.splice(0)) t(); },
    };
  }

  it('posts dropShown with the trace and its render time from the last domainLoaded, only after the frame and the task after it', () => {
    const f = fakeFrames();
    const sent: unknown[] = [];
    noteDomainLoaded(0);
    f.tick(40);
    answerDropTrace(3, (m) => sent.push(m), f.deps);
    expect(sent).toEqual([]);
    f.tick(200);
    f.paint();
    expect(sent).toEqual([]);
    f.runTasks();
    expect(sent).toEqual([{ type: 'dropShown', payload: { trace: 3, renderMs: 240 } }]);
  });

  it('without a domainLoaded seen, posts no render time; a bad trace is ignored', () => {
    const f = fakeFrames();
    const sent: unknown[] = [];
    answerDropTrace(2, (m) => sent.push(m), f.deps);
    answerDropTrace('2', (m) => sent.push(m), f.deps);
    answerDropTrace(0, (m) => sent.push(m), f.deps);
    f.paint();
    f.runTasks();
    expect(sent).toEqual([{ type: 'dropShown', payload: { trace: 2 } }]);
  });
});
