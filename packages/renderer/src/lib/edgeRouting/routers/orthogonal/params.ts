/**
 * Route-around router — tuning knobs, in flow px (or px-equivalent costs).
 *
 *   card ┃<- PATH_GAP 20 ->● stub end ── MIN_LEG 10 ──┐ first bend (≥ 30 out)
 *        ┃<- MARGIN 16  -> routes keep this far from every card
 *        ┃<- ZONE 42    -> no other line runs in front of a side with stubs
 *
 * The values were tuned against hand-placed scenarios
 * (`test/fixtures/edgeRouting/scenarios.ts`): screenshots, crossings / bends /
 * length, and A* expansions.
 */

/** Routes keep at least this far from every card (the routing grid pads each card by it). */
export const MARGIN = 16;
/** Nudging parallel lines apart never brings a line closer than this to a card. */
export const CLEAR = 16;
/** Gap between parallel lines that share a channel (fit-to-view often draws at ~0.7×). */
export const LINE_SEP = 12;
/** Gap between twins (two lines joining the same two cards): their role labels must clear each other. */
export const TWIN_SEP = 30;
/** Gap between two anchors on one card side: room for the `*` / `1` of each. */
export const ANCHOR_SEP = 24;
/** Anchors keep this far from a card's corners. */
export const ANCHOR_INSET = 20;
/** Straight run past the stub before a line may bend. */
export const MIN_LEG = 10;
/** Shortest run the centring pass leaves next to a bend. */
export const MIN_RUN = 10;
/**
 * A line keeps this far from its own two cards everywhere but along its two
 * stubs (PATH_GAP + MIN_LEG - 1): it never runs between a card and its stubs.
 */
export const OWN_CLEAR = 29;
/**
 * Depth of the anchor zone in front of a card side that has lines attached:
 * the stubs, their `*` / `1` and their first bends live there, and a line
 * running past inside it reads as joined to them. Other lines pay ZONE_COST
 * to run there; a line's own two cards' zones are open to it.
 */
export const ZONE = 42;
/**
 * Extra cost per px of running inside another card side's anchor zone (< 0:
 * zones are closed outright). Closed zones send lines in a crowded diagram on
 * long detours round the whole thing; at 2 a line cuts through only when the
 * way round is about three times as long.
 */
export const ZONE_COST = 2;

/** Cost of one bend, in px of length. */
export const BEND = 40;
/**
 * Cost of crossing a line routed earlier: a crossing is worth a two-bend
 * detour (at 40 the tangle scenario had twice the crossings).
 */
export const CROSS = 80;
/**
 * A crossing on another line's stub (inside an anchor zone, or on this line's
 * own leg) costs this many times CROSS: right next to a `*` / `1` it reads as
 * a T junction, as if the lines joined there.
 */
export const STUB_CROSS = 3;
/** Extra cost per px of grid edge earlier lines already use (spreads lines over the channels). */
export const SHARE = 0.25;
/**
 * Cost of an anchor slot right on top of another line's anchor on the same
 * side (falling to 0 at ANCHOR_SEP away): a side has only so much room, so a
 * later line takes a free slot or another side. Twins are exempt (they pair up).
 */
export const SLOT = 400;
/**
 * Hysteresis for a line routed again (its card moved, or a card came near it):
 * taking a side other than the one it had costs STICK_SIDE (more than a bend,
 * less than two), and a slot on its old side costs STICK_SLOT per px away from
 * where its anchor was (carried along with the card). Without these a drag
 * re-plans every line on the moved card from scratch each frame, and a 1 px
 * move can swap the grid line a slot sits on: anchors jumped 20-50 px and
 * lines flipped sides on ~10% of drag frames in the tangle and 40-card scenarios.
 */
export const STICK_SIDE = 100;
export const STICK_SLOT = 2;
/** …applied only when at most this many boxes changed since the last pass (`changed` holds each moved box twice: old and new). */
export const STICK_MAX_CHANGED = 8;
/** Cost per px an anchor sits off the centre of its side: a straight line is worth a shift… */
export const SHIFT = 1.1;
/** …plus this per px², so an aligned straight line settles in the middle of the overlap. */
export const SHIFT_SQ = 0.002;

/** Grid lines closer than this are one line. */
export const MERGE_EPS = 1;
/**
 * A soft grid line (side centre, midline, straight-line option) within this
 * of another line is dropped: a cluster of near-identical lines adds A* nodes,
 * not routing choices (on the 40-card scenario this alone cut expansions by 3×).
 */
export const SOFT_EPS = 12;
/** Parallel segments closer than this share a channel: they are ordered by where they go. */
export const NEAR = 3;
/** Segments this close that a group's spreading swapped are re-solved together. */
export const RELATE_WINDOW = 40;
/** The furthest the nudging pass moves a segment. */
export const MAX_SHIFT = 120;
/**
 * Weighted A*: the heuristic is scaled by this. Crossing and sharing costs
 * make the length + bends estimate loose, and an unweighted search floods
 * the channels; 1.1 keeps the routes a designer would draw (1.2 already
 * sends the odd long line the long way round).
 */
export const HEURISTIC_WEIGHT = 1.1;
/**
 * Lines spanning more than LONG_FROM px (centre to centre, Manhattan) get up
 * to LONG_EXTRA more weight, reached LONG_RAMP px further on: on the 40-card
 * scenario a quarter fewer expansions for a few more crossings, while every
 * line of a normal diagram (the star's longest spans 1,600 px) stays at 1.1.
 */
export const LONG_FROM = 1600;
export const LONG_RAMP = 1200;
export const LONG_EXTRA = 0.3;
/**
 * …and their crossings cost up to this much less: across a whole diagram
 * most are unavoidable, and pricing them in full doubles the search.
 */
export const LONG_CROSS_CUT = 0.7;
/** A* gives up (and the line falls back) after this many expansions. */
export const MAX_POPS = 40000;

/**
 * Diagrams with more cards (and self-loops) than this route each line on its
 * own local grid (router.ts, `localGrid`): one grid over the whole diagram
 * grows with the square of its size (every card's edges cross every other
 * card's), to millions of nodes on an uneven 1,000-card layout.
 */
export const LOCAL_FROM_CARDS = 150;
/** A local grid starts this far (px) round its line's two cards: about one card and a gap. */
export const LOCAL_MARGIN = 400;
/** …and its margin grows by this factor each time the route runs along its edge. */
export const LOCAL_GROWTH = 2.5;
/** A local grid larger than this (nodes) is not built: the line keeps what it found, or falls back. */
export const LOCAL_MAX_NODES = 1_500_000;
/**
 * On local grids (large diagrams), long lines are greedier still: from
 * LOCAL_LONG_FROM px they get up to LOCAL_LONG_EXTRA more heuristic weight
 * and crossings up to LOCAL_LONG_CROSS_CUT cheaper. A line across a 2,000-card
 * layered diagram otherwise runs out of MAX_POPS among the other lines and
 * falls back (161 of 2,732 did); with these none do, for ~2.5% more crossings.
 */
export const LOCAL_LONG_FROM = 1200;
export const LOCAL_LONG_EXTRA = 0.9;
export const LOCAL_LONG_CROSS_CUT = 0.85;
/**
 * On local grids, a line whose search runs out of MAX_POPS gets one greedy
 * retry before it falls back: this heuristic weight, and crossings at this
 * fraction of CROSS. A few more crossings beat a line drawn through every card
 * between its two ends (lines between neighbouring columns 5,000 px apart).
 */
export const RESCUE_WEIGHT = 3;
export const RESCUE_CROSS = 0.1;

