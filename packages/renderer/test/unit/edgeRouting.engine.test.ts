/**
 * The routing engine each canvas holds (`createEdgeRoutingEngine`): the two
 * line styles, the performance guard (a slow diagram holds its routes while
 * a card is dragged and routes again when the drag ends; a very slow or very
 * large one is not routed at all), errors, and router isolation between
 * canvases. Time comes from an injected clock, so nothing here is timing-
 * sensitive.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LINE_STYLE,
  DRAG_HOLD_AFTER_MS,
  DRAG_REROUTE_BUDGET_MS,
  LINE_STYLES,
  LINE_STYLE_OPTIONS,
  MAX_ROUTED_LINES,
  ROUTING_HARD_LIMIT_MS,
  createAvoidRouter,
  createEdgeRoutingEngine,
  isLineStyle,
  lineStyleOptions,
  routeAll,
  type RoutingInput,
  type RoutingRequest,
} from '../../src/lib/edgeRouting';
import { scenarioRoutingInput } from '../fixtures/edgeRouting/scenarios';

/**
 * A clock whose passes take `ms` each: routeAll reads it twice a pass (start,
 * end), so every odd call starts a pass and the next ends it `ms` later.
 */
function fakeClock(ms = 1) {
  let t = 0;
  let calls = 0;
  const clock = {
    ms,
    now: () => {
      calls++;
      if (calls % 2 === 0) t += clock.ms;
      return t;
    },
  };
  return clock;
}

const NO_DRAG: ReadonlySet<string> = new Set();

function requestFor(input: RoutingInput, extra: Partial<RoutingRequest> = {}): RoutingRequest & { built: () => number } {
  let built = 0;
  return {
    input: () => {
      built++;
      return input;
    },
    lineCount: input.edges.length,
    style: 'curved',
    dragging: NO_DRAG,
    ...extra,
    built: () => built,
  };
}

/** The input with one card moved by (dx, dy), its lines' anchors with it. */
function moved(input: RoutingInput, id: string, dx: number, dy: number): RoutingInput {
  const shift = <T extends { x: number; y: number }>(p: T, owner: string): T => (owner === id ? { ...p, x: p.x + dx, y: p.y + dy } : p);
  return {
    obstacles: input.obstacles.map((o) => shift(o, o.id)),
    edges: input.edges.map((e) => ({ ...e, sourceAnchor: shift(e.sourceAnchor, e.source), targetAnchor: shift(e.targetAnchor, e.target) })),
  };
}

/** The card with the most lines, and the ids of its lines. */
function busiestCard(input: RoutingInput): { card: string; lines: Set<string> } {
  const degree = new Map<string, number>();
  for (const e of input.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const card = [...degree.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  return { card, lines: new Set(input.edges.filter((e) => e.source === card || e.target === card).map((e) => e.id)) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('line styles', () => {
  it('are curved and hops, curved by default', () => {
    expect(LINE_STYLES).toEqual(['curved', 'hops']);
    expect(DEFAULT_LINE_STYLE).toBe('curved');
    expect(isLineStyle('hops')).toBe(true);
    expect(isLineStyle('gaps')).toBe(false);
    expect(isLineStyle(undefined)).toBe(false);
  });

  it('curved: soft corners, a halo at crossings, x-ray under tables; hops: rounded corners, hops, hidden', () => {
    expect(LINE_STYLE_OPTIONS.curved).toEqual({ crossings: 'halo', underTables: 'xray', corners: 'curved' });
    expect(LINE_STYLE_OPTIONS.hops).toEqual({ crossings: 'hops', underTables: 'hidden', corners: 'rounded' });
    expect(lineStyleOptions('nonsense')).toBe(LINE_STYLE_OPTIONS.curved);
  });

  it('each style draws what it says on every line it routes', () => {
    const input = scenarioRoutingInput('star');
    const curved = routeAll(input, LINE_STYLE_OPTIONS.curved);
    const hops = routeAll(input, LINE_STYLE_OPTIONS.hops);
    expect(curved.edges.size).toBeGreaterThan(0);
    for (const e of curved.edges.values()) expect(e.halo).toBe(true);
    for (const e of hops.edges.values()) {
      expect(e.halo).toBeUndefined();
      expect(e.tunnels).toBeUndefined();
    }
    // Some crossing in the star gets a hop (two cubics) in the hops style.
    expect([...hops.edges.values()].some((e) => (e.d.match(/C /g) ?? []).length > 0)).toBe(true);
  });
});

describe('the routing engine — performance guard', () => {
  it('a fast diagram routes every frame of a drag', () => {
    const clock = fakeClock(3);
    const engine = createEdgeRoutingEngine(clock.now);
    const input = scenarioRoutingInput('star');
    const { card } = busiestCard(input);
    expect(engine.update(requestFor(input)).pass).toBe('routed');
    for (let f = 1; f <= 5; f++) {
      const update = engine.update(requestFor(moved(input, card, f * 4, 0), { dragging: new Set([card]) }));
      expect(update.pass).toBe('routed');
      expect(update.routes!.size).toBe(input.edges.filter((e) => !e.isSelfLoop).length);
    }
  });

  it('a slow diagram holds its routes while a card is dragged: the dragged card\'s lines fall back, the rest stay', () => {
    const clock = fakeClock(DRAG_HOLD_AFTER_MS + 10);
    const engine = createEdgeRoutingEngine(clock.now);
    const input = scenarioRoutingInput('star');
    const { card, lines } = busiestCard(input);
    const before = engine.update(requestFor(input));
    expect(before.pass).toBe('routed');

    const dragging = new Set([card]);
    const frames = [1, 2, 3].map((f) => requestFor(moved(input, card, f * 10, 0), { dragging }));
    const updates = frames.map((r) => engine.update(r));
    for (const [i, update] of updates.entries()) {
      expect(update.pass).toBe('held');
      expect(frames[i].built()).toBe(0); // no input built, nothing routed
    }
    const held = updates[0].routes!;
    // One map for the whole drag, so lines that did not change do not re-render.
    expect(updates[1].routes).toBe(held);
    expect(updates[2].routes).toBe(held);
    for (const [id, route] of before.routes!) {
      if (lines.has(id)) expect(held.has(id), id).toBe(false);
      else expect(held.get(id), id).toBe(route);
    }

    // The drag ends: everything is routed again, once.
    const end = requestFor(moved(input, card, 30, 0));
    const after = engine.update(end);
    expect(after.pass).toBe('routed');
    expect(end.built()).toBe(1);
    for (const id of lines) expect(after.routes!.has(id)).toBe(true);
  });

  it('a drag frame over the budget holds the rest of that drag; the next drag tries again', () => {
    const clock = fakeClock(5);
    const engine = createEdgeRoutingEngine(clock.now);
    const input = scenarioRoutingInput('star');
    const { card } = busiestCard(input);
    const dragging = new Set([card]);
    engine.update(requestFor(input));

    clock.ms = DRAG_REROUTE_BUDGET_MS + 1;
    expect(engine.update(requestFor(moved(input, card, 4, 0), { dragging })).pass).toBe('routed');
    clock.ms = 1;
    expect(engine.update(requestFor(moved(input, card, 8, 0), { dragging })).pass).toBe('held');
    expect(engine.update(requestFor(moved(input, card, 12, 0), { dragging })).pass).toBe('held');
    expect(engine.update(requestFor(moved(input, card, 12, 0))).pass).toBe('routed');
    // A new drag routes its first frame again (and this one is fast, so it keeps routing).
    expect(engine.update(requestFor(moved(input, card, 16, 0), { dragging })).pass).toBe('routed');
    expect(engine.update(requestFor(moved(input, card, 20, 0), { dragging })).pass).toBe('routed');
  });

  it('a pass over the hard limit turns routing off for diagrams that size, without building the input again', () => {
    const clock = fakeClock(ROUTING_HARD_LIMIT_MS + 1);
    const engine = createEdgeRoutingEngine(clock.now);
    const input = scenarioRoutingInput('star');
    const first = engine.update(requestFor(input));
    expect(first).toMatchObject({ routes: null, pass: 'off' });
    clock.ms = 1;
    const again = requestFor(input);
    expect(engine.update(again)).toMatchObject({ routes: null, pass: 'off' });
    expect(again.built()).toBe(0);
    // A smaller diagram (a line removed) is tried again.
    const smaller = { ...input, edges: input.edges.slice(1) };
    expect(engine.update(requestFor(smaller)).pass).toBe('routed');
  });

  it(`a diagram with more than ${MAX_ROUTED_LINES} lines is never routed`, () => {
    const engine = createEdgeRoutingEngine(fakeClock().now);
    const input = scenarioRoutingInput('star');
    const request = requestFor(input, { lineCount: MAX_ROUTED_LINES + 1 });
    expect(engine.update(request)).toMatchObject({ routes: null, pass: 'off' });
    expect(request.built()).toBe(0);
  });

  it('logs nothing on a normal pass, and a failure once however many frames fail', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const engine = createEdgeRoutingEngine(fakeClock().now);
    const input = scenarioRoutingInput('star');
    for (let i = 0; i < 3; i++) engine.update(requestFor(input));
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    const broken = requestFor(input, {
      input: () => {
        throw new Error('measured nothing');
      },
    });
    for (let i = 0; i < 5; i++) expect(engine.update(broken)).toMatchObject({ routes: null, pass: 'off' });
    expect(warn).toHaveBeenCalledTimes(1);
    // And it recovers on the next good frame.
    expect(engine.update(requestFor(input)).pass).toBe('routed');
  });
});

describe('routeAll never throws', () => {
  it('a router that throws gives no routes (every line on the fallback) and reports the error', () => {
    const onError = vi.fn();
    const reset = vi.fn();
    const result = routeAll(
      scenarioRoutingInput('star'),
      LINE_STYLE_OPTIONS.curved,
      {
        router: {
          route: () => {
            throw new Error('boom');
          },
          reset,
        },
        onError,
      },
    );
    expect(result.edges.size).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('router isolation (one router per canvas)', () => {
  it('two routers never share their memory of the last pass', () => {
    const input = scenarioRoutingInput('star');
    const a = createAvoidRouter();
    const b = createAvoidRouter();
    expect(a.route(input).stats.reused).toBe(0);
    // b has never seen this diagram: it routes every line, whatever a did.
    expect(b.route(input).stats.reused).toBe(0);
    // a remembers its own pass: nothing changed, every line is kept.
    expect(a.route(input).stats.reused).toBeGreaterThan(0);
  });

  it('a second canvas routing another diagram does not change the first canvas\'s lines', () => {
    const first = scenarioRoutingInput('star');
    const other = scenarioRoutingInput('tangle');
    const { card } = busiestCard(first);
    const nudge = moved(first, card, 6, 3);

    const alone = createEdgeRoutingEngine(fakeClock().now);
    alone.update(requestFor(first));
    const expected = alone.update(requestFor(nudge)).routes;

    const shared = createEdgeRoutingEngine(fakeClock().now);
    const neighbour = createEdgeRoutingEngine(fakeClock().now);
    shared.update(requestFor(first));
    neighbour.update(requestFor(other));
    expect(shared.update(requestFor(nudge)).routes).toEqual(expected);
  });
});
