/**
 * Edge routing — shared types.
 *
 * Every FK line on the canvas is routed in one pass over the whole graph
 * (`routeAll`), so the router can see every table (obstacles) and every other
 * line (crossings, shared channels). An `FkEdge` reads its routed path from
 * the canvas store and falls back to the smooth-step path when there is none.
 *
 * Coordinates are React Flow flow coordinates (the same space as node
 * `positionAbsolute`).
 */

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface Point {
  x: number;
  y: number;
}

/** A node's box on the canvas. Tables and sticky notes are both obstacles. */
export interface Rect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 'model' for a table card, 'annotation' for a sticky note. */
  kind: 'model' | 'annotation';
}

/** Where a line meets a table: the point on the card's border and which side. */
export interface Anchor extends Point {
  side: Side;
}

/** How far (px) the drawn line stops short of the card, leaving room for the `*` / `1`. */
export const PATH_GAP = 20;
/** How far (px) from the card border the `*` / `1` label sits. */
export const LABEL_OFFSET = 8;

/** One FK line to route, as the graph transformer + edge distribution placed it. */
export interface EdgeSpec {
  id: string;
  source: string;
  target: string;
  /** The current (smooth-step) anchors: handle side + distributed slot. */
  sourceAnchor: Anchor;
  targetAnchor: Anchor;
  isSelfLoop: boolean;
  loopIndex: number;
  /** 'many-to-one' | 'one-to-one' | 'one-to-many' | 'many-to-many'. */
  cardinality: string;
}

export interface RoutingInput {
  obstacles: Rect[];
  edges: EdgeSpec[];
}

/**
 * A router's answer for one line. `points` is an orthogonal-or-not polyline
 * from the source stub to the target stub (each stub is the anchor pushed
 * out by PATH_GAP along its side); the first and last segments should leave
 * / enter perpendicular to the side. A router may move the anchors (choose
 * another side or slot); the `*` / `1` labels follow the anchors.
 */
export interface RoutedLine {
  sourceAnchor: Anchor;
  targetAnchor: Anchor;
  points: Point[];
}

/** What the canvas draws for one line, after crossings and tunnels are worked out. */
export interface RoutedEdge extends RoutedLine {
  /** The SVG path. */
  d: string;
  /** Midpoint along the drawn path (role label, swap button, badges). */
  mid: Point;
  /** Draw a background-coloured casing under the line (crossings = 'halo'). */
  halo?: boolean;
  /**
   * crossings = 'halo', on a line that passes under another: `d` with the
   * breaks cut out. FkEdge draws the visible stroke and its casing with it;
   * `d` stays whole for the moving arrows and the hit area.
   */
  strokeD?: string;
  /**
   * Stretches of the line that pass under a table card (not its own two
   * ends): polylines, drawn above the cards as a faint "x-ray" dashed line.
   */
  tunnels?: Point[][];
}

export type CrossingMode =
  | 'none'
  /** A small semicircle bridge where one line hops over another. */
  | 'hops'
  /** Every line has a canvas-coloured casing, and the line underneath is cut where it passes under another. */
  | 'halo';

export type UnderTablesMode =
  /** The card hides the line. */
  | 'hidden'
  /** The hidden stretch is drawn faintly over the card, with portal rings where it enters and leaves. */
  | 'xray';

export type CornerMode = 'rounded' | 'curved' | 'sharp';

/** How the router's polylines are drawn: one line style's settings. */
export interface LineStyleOptions {
  crossings: CrossingMode;
  underTables: UnderTablesMode;
  corners: CornerMode;
}

/** What `routeAll` needs of a router (the route-around router is the one the canvas uses). */
export interface LineRouter {
  route(input: RoutingInput): { lines: Map<string, RoutedLine> };
  /** Drop anything kept from earlier passes. */
  reset(): void;
}

export interface RouteResult {
  edges: Map<string, RoutedEdge>;
  /** How long the pass took (ms), for the performance guard. */
  millis: number;
}
