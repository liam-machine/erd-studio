// The README's hero GIF (media/demo.gif), drawn by ../hero-gif.mjs from player/hero.html with the
// video's own pieces (editor.js, lib.js): ERD Studio in a plain folder (no stage tabs, nothing to
// compare, neutral tables and lines), the orders diagram beside its .erd-studio files, under a
// caption band that says one short thing per beat (CAPTIONS). An ad that loops: the diagram moving
// first, then the three ways to change it, then who reads it.
//   1. "Data modelling in VS Code": the pointer rests on fct_order and the canvas does what the
//      product's hover preview does (HOVER): its lines light in the layer colour and carry the moving
//      arrows.
//   2. "Draw a relationship": the pointer presses fct_return's date_key, drags the dashed line to
//      dim_date's date_key and lets go; the New Relationship dialog opens filled in (a picture of the
//      real one), Create Relationship, and the line is there.
//   3. "Type it: plain DBML files": fct_order.dbml's text, one column typed into it, and the column
//      lands on the table.
//   4. "Or ask your AI": Claude Code in the terminal is asked for a table in plain words; it loads
//      the erd-studio skill and edits the DBML files; the table and its relationship land.
//   5. "Business reads it in Confluence": a Confluence page carrying a real render of the same
//      files, as ERD Studio for Confluence draws them from GitHub.
// Beats 2 to 5 are staged from a real run (record/heroRun.mjs → record/hero-run.json): the drag was
// made in the real canvas and the dialog is its picture, the typed line is read back by
// @erd-studio/core, and the prompt, the files Claude Code wrote, the table and where it put it are
// that run's. `npm test` checks every constant here against the record.
// A seamless loop. render(t) is pure, like the video's.
import { appIcon, card, caret, clamp, COLORS, easeInOut, easeOut, esc, ICON, node, nodeHeight, path, pointer, seg, toolbar, typed } from './lib.js';
import { activityBar, dbmlLine, fileTree } from './editor.js';

/** The frame: a caption band (CAP_H) over the VS Code window. */
export const HERO = { w: 1440, h: 1010, fps: 12, loop: 22.5 };
const CAP_H = 130;
const WIN = { x: 20, y: CAP_H, w: HERO.w - 40, h: HERO.h - CAP_H - 20 };
const ACTW = 72, SIDEW = 420;
const EDX = ACTW + SIDEW;                       // editor area left, in body px
const BODYW = WIN.w - 2, BODYH = WIN.h - 66;    // the window's body (card border, 64 px head)

// ---- The loop -----------------------------------------------------------------------------------
const CLICK = 0.22;
/** By hand: the press on the FK column, the long press that starts the drag (ModelNode.tsx: 220 ms), the drop, and the click on Create Relationship. */
export const PRESS_AT = 3.5, LONG_PRESS = 0.22, DROP_AT = 5.05, CREATE_CLICK = 6.2;
const DRAG_FROM = PRESS_AT + LONG_PRESS;
/** The relationship is on the canvas from the click's mouse-up. */
export const CREATE_ON = CREATE_CLICK + CLICK;
/** As text: fct_order.dbml's card, the line typed into it, and the moment it is saved and the canvas follows. */
const TEXT_IN = 7.8, TYPE_FROM = 8.4, TYPE_CPS = 16, TEXT_OUT = 11.3;
export const TYPED_AT = 10;
/** With AI: the terminal opens, the prompt is typed, each step lands, the canvas follows the last. */
export const AI = { open: 11.7, type: 12.05, cps: 40, steps: [13.5, 13.9, 14.3, 14.7, 15.1], done: 15.5, close: 16.25 };
/**
 * The Confluence page covers the window from CONF_IN to CONF_OUT; behind it the project goes back
 * to its start. Both are cuts: a cross-fade of the whole window costs the GIF more bytes than a
 * beat does.
 */
const CONF_IN = 17.7, CONF_OUT = 21.8;

/** One caption per beat, ≤ 5 words, from `at` (the first also runs into the seam); `em` is lit in blue. */
export const CAPTIONS = [
  { at: 0, text: 'Data modelling in VS Code', em: 'VS Code' },
  { at: 3.3, text: 'Draw a relationship', em: 'Draw' },
  { at: 7.6, text: 'Type it: plain DBML files', em: 'DBML files' },
  { at: 11.6, text: 'Or ask your AI', em: 'AI' },
  { at: 17.7, text: 'Business reads it in Confluence', em: 'Confluence' },
  { at: 21.8, text: 'Data modelling in VS Code', em: 'VS Code' },
];
const CAP_FADE = 0.3;

function captionBand(t) {
  let i = 0;
  while (i + 1 < CAPTIONS.length && CAPTIONS[i + 1].at <= t) i++;
  const one = (c, op, dy) => {
    const [pre, post] = c.text.split(c.em);
    return `<div class="abs" style="left:0;right:0;top:${(30 + dy).toFixed(1)}px;text-align:center;font-size:58px;font-weight:800;letter-spacing:-.02em;line-height:1.15;white-space:nowrap;color:var(--text);opacity:${op.toFixed(3)}">${pre}<span style="color:var(--blue)">${c.em}</span>${post}</div>`;
  };
  const c = CAPTIONS[i];
  const p = i === 0 ? 1 : easeOut(seg(t, c.at, c.at + CAP_FADE));
  let h = one(c, p, 10 * (1 - p));
  if (p < 1) h += one(CAPTIONS[i - 1], 1 - seg(t, c.at, c.at + CAP_FADE * 0.6), 0);
  return h;
}

// ---- The real run (record/hero-run.json; `npm test` checks every constant here against it) ------
/** By hand: the column dragged and the one it was dropped on (record/heroRun.mjs DRAG), [table, column]. */
export const DRAG = { from: ['fct_return', 'date_key'], to: ['dim_date', 'date_key'] };
/** The dialog the real canvas opened on the drop, as it drew it (record/heroRun.mjs DIALOG_SHOT, at 2x), and its primary button. */
export const DIALOG = { file: 'hero-new-relationship.png', w: 420, h: 660, button: 'Create Relationship', buttonAt: { x: 333, y: 633 } };
/** As text: the line typed into fct_order.dbml (record/heroRun.mjs TYPED_LINE), and the column the canvas reads from it. */
export const TYPED_LINE = '  quantity     INTEGER';
export const TYPED_COLUMN = { table: 'fct_order', after: 'product_key', col: [null, 'quantity', 'INTEGER'] };
/** What Claude Code was asked, word for word (record/heroRun.mjs PROMPT). */
export const AI_PROMPT = 'Add a dim_store table and link fct_order to it.';
/**
 * What it did, as Claude Code lists it: the skill it loaded, then each file it changed, in the
 * run's order. Left out: the files it only read, a second edit to a file already listed, and its
 * first try at dim_store.dbml, which the helper's hook paused once before letting it through.
 */
export const AI_STEPS = [
  ['Skill', 'erd-studio'],
  ['Update', '.erd-studio/main/tables/main/fct_order.dbml'],
  ['Update', '.erd-studio/main/relationships/main.dbml'],
  ['Update', '.erd-studio/main/diagrams/orders.dbml'],
  ['Write', '.erd-studio/main/tables/main/dim_store.dbml'],
];
/** The table it added (its dim_store.dbml: the grain and the natural key are its own) and where its diagram edit put it (erd_layout), and the key it added to fct_order, after product_key. */
export const AI_TABLE = { name: 'dim_store', x: 0, y: 320, grain: 'One row per store', cols: [['PK', 'store_key', 'INTEGER'], ['NK', 'store_id', 'VARCHAR'], [null, 'name', 'VARCHAR']] };
export const AI_COLUMN = { table: 'fct_order', after: 'product_key', col: ['FK', 'store_key', 'INTEGER'] };

/** Where the project is at t: as it started, with the relationship drawn by hand, with the typed column, or with the AI's table. */
export const phaseAt = (t) => (t < CREATE_ON || t >= CONF_IN ? 'start' : t < TYPED_AT ? 'dragged' : t < AI.done ? 'typed' : 'after');

// ---- The Explorer ---------------------------------------------------------------------------------
/**
 * The folder's rows, in VS Code's order (folders first, then names without regard to case):
 * [depth, kind, label, closed?, id]; depth 0 is the folder's top level. `store`: Claude Code has
 * written dim_store.dbml. The folder is the one record/heroRun.mjs makes: the design beside the
 * code that loads the warehouse; .claude holds the helper's skill.
 */
export function heroTree({ store = false } = {}) {
  const f = (d, kind, label, id) => [d, kind, label, false, id ?? label];
  return [
    [0, 'folder', '.claude', true, '.claude'],
    f(0, 'folder', '.erd-studio'),
    f(1, 'folder', 'main'),
    f(2, 'folder', 'diagrams'),
    f(3, 'dbml', 'orders.dbml', 'diagram'),
    f(2, 'folder', 'relationships'),
    f(3, 'dbml', 'main.dbml', 'rels'),
    f(2, 'folder', 'tables'),
    f(3, 'folder', 'main', 'tables/main'),
    f(4, 'dbml', 'dim_customer.dbml', 't:dim_customer'),
    f(4, 'dbml', 'dim_date.dbml', 't:dim_date'),
    f(4, 'dbml', 'dim_product.dbml', 't:dim_product'),
    ...(store ? [f(4, 'dbml', 'dim_store.dbml', 't:dim_store')] : []),
    f(4, 'dbml', 'fct_order.dbml', 't:fct_order'),
    f(4, 'dbml', 'fct_return.dbml', 't:fct_return'),
    f(1, 'json', 'layers.json'),
    f(1, 'md', 'README.md', 'erd-readme'),
    f(0, 'folder', 'pipelines'),
    f(1, 'other', 'load_orders.py'),
    f(1, 'sql', 'orders.sql'),
    f(0, 'other', '.gitignore'),
    f(0, 'md', 'README.md'),
  ];
}
/** The folder at the loop's start. */
export const HERO_TREE = heroTree();
const ROW_H = 32, TREE_TOP = 84;
/** When Claude Code's Write of dim_store.dbml lands (its row appears). */
const STORE_FILE_AT = AI.steps[4] + 0.25;
/** Source Control's letters: what each edit left uncommitted ([id, letter, from]). */
const GIT = [
  ['rels', 'M', CREATE_ON], ['t:fct_order', 'M', TYPED_AT],
  ['diagram', 'M', AI.steps[3] + 0.25], ['t:dim_store', 'U', STORE_FILE_AT],
];
const GIT_COLOUR = { U: '#73c991', M: '#e2c08d' };

// ---- The orders diagram -----------------------------------------------------------------------------
// Full node scale, local coordinates (the diagram file's erd_layout), drawn scaled by CS.
const T = [
  { name: 'dim_customer', x: 0, y: 0, cols: [['PK', 'customer_key', 'INTEGER'], [null, 'customer_id', 'VARCHAR'], [null, 'name', 'VARCHAR']] },
  { name: 'dim_date', x: 0, y: 640, cols: [['PK', 'date_key', 'INTEGER'], [null, 'date_day', 'DATE'], [null, 'month_name', 'VARCHAR']] },
  { name: 'fct_order', x: 520, y: 170, cols: [['PK', 'order_id', 'INTEGER'], ['FK', 'customer_key', 'INTEGER'], ['FK', 'date_key', 'INTEGER'], ['FK', 'product_key', 'INTEGER'], [null, 'amount', 'DECIMAL(18,2)']] },
  { name: 'dim_product', x: 1040, y: 0, cols: [['PK', 'product_key', 'INTEGER'], [null, 'product_name', 'VARCHAR'], [null, 'price', 'DECIMAL(10,2)']] },
  { name: 'fct_return', x: 1040, y: 540, cols: [['PK', 'return_id', 'INTEGER'], ['FK', 'order_id', 'INTEGER'], ['FK', 'date_key', 'INTEGER'], [null, 'refunded', 'DECIMAL(18,2)']] },
];
const withColumn = (tables, { table, after, col }) => tables.map((tb) => {
  if (tb.name !== table) return tb;
  const at = tb.cols.findIndex(([, n]) => n === after) + 1;
  return { ...tb, cols: [...tb.cols.slice(0, at), col, ...tb.cols.slice(at)] };
});
/** The tables in each phase: the typed column, then the AI's key (which it put before it) and table. */
const T_TYPED = withColumn(T, TYPED_COLUMN);
const TABLES = { start: T, dragged: T, typed: T_TYPED, after: [...withColumn(T_TYPED, AI_COLUMN), AI_TABLE] };
const NW = 350;
/** The canvas: local coordinates drawn at CS from (CX, CY) in body px. One body px is one flow px. */
const CX = EDX + 24, CY = 104, CS = 0.62;

/** fct_order.dbml as ERD Studio writes it, at the start (formatDbml aligns the types; `npm test` checks it). */
export const FCT_DBML = [
  'Table main.fct_order {',
  '  order_id     INTEGER [pk]',
  "  customer_key INTEGER [foreign_key: 'true']",
  "  date_key     INTEGER [foreign_key: 'true']",
  "  product_key  INTEGER [foreign_key: 'true']",
  '  amount       "DECIMAL(18,2)"',
  '}',
];
/** The line of FCT_DBML the typed line goes under (product_key's). */
const TYPED_UNDER = 4;

// ---- The lines, routed and drawn as packages/renderer draws them --------------------------------
// (`npm test` checks every number here against the renderer's source.)
//   - The router (EdgeRouting) takes every line around the tables, orthogonally; a line meets a table
//     at a side slot (not a column row), stops PATH_GAP px short of it, and its `*` / `1` sits
//     LABEL_OFFSET px from the card. The polylines here (RELS) are laid by hand that way.
//   - lineStyle.ts LINE_STYLE_OPTIONS: Curved (the default, the style drawn throughout) = curved
//     corners + a halo where lines cross; Hops = rounded corners + a hop where lines cross.
//   - corners.ts: rounded corners up to 8 px (a quadratic); curved up to 40 px each way (a cubic
//     quarter, KAPPA), the stub segments given wholly to their corner (less 4 px), at most 2:1, and
//     shrunk to keep 6 px from a card.
//   - pathRender.ts: at a crossing the more horizontal line is "over". Curved: every line has a
//     casing (7 px, the canvas colour) and the under line is cut 4.5 px either side. A treatment
//     keeps 3 px from a corner and 4 px from the line's ends, and goes to the other line when it has
//     no room.
//   - FkEdge.css: lines 2 px, 2.5 px while their table is hovered, in the neutral line colour (a
//     plain folder has no stage colours). Drawn here 1.25×, as the rest of this frame, and the
//     hover's arrows sized as the product sizes them at 50 % zoom (glyphScaleForZoom(0.5)).
export const ROUTE = {
  pathGap: 20, labelOffset: 8,
  roundedRadius: 8, curveRadius: 40, curveRatio: 2, curveEndKeep: 4, curveClearance: 6, kappa: 0.5523,
  hopRadius: 12, haloCutHalf: 4.5, haloWidth: 7, cornerClear: 3, stubClear: 4, mergeSlack: 4,
};
export const LINE_STYLE_OPTIONS = {
  curved: { crossings: 'halo', corners: 'curved' },
  hops: { crossings: 'hops', corners: 'rounded' },
};
const STROKE_K = 1.25;

/** Flow px of each table's box. */
const rectsOf = (tables) => tables.map((tb) => ({ id: tb.name, x: tb.x * CS, y: tb.y * CS, w: NW * CS, h: nodeHeight(tb.cols.length, !!tb.grain) * CS }));
const RECTS = Object.fromEntries(Object.entries(TABLES).map(([k, tables]) => [k, rectsOf(tables)]));
/** A point on a table's side, `at` flow px along it from its top or left end. */
function anchor(rects, name, side, at) {
  const r = rects.find((x) => x.id === name);
  if (side === 'left' || side === 'right') return { x: side === 'left' ? r.x : r.x + r.w, y: r.y + at, side };
  return { x: r.x + at, y: side === 'top' ? r.y : r.y + r.h, side };
}
const OUT = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const push = (a, d) => ({ x: a.x + OUT[a.side][0] * d, y: a.y + OUT[a.side][1] * d });

/**
 * The relationships: each from the FK's table (`*`, the path's start) to the key's table (`1`), by
 * the sides the product's router takes for this layout in each phase (seen in the real canvas with
 * the run's files: fct_order's side to dim_customer's bottom, its top to dim_product's side, its
 * bottom to dim_date; fct_return's side to fct_order's bottom, and to its side from fct_return's
 * top once dim_store is there; the two straight lines). One corner each, where the two ends'
 * directions meet; none when they face each other on one level.
 */
const MID = NW * CS / 2;
const R_CUSTOMER = { from: ['fct_order', 'left', 70], to: ['dim_customer', 'bottom', MID] };
const R_PRODUCT = { from: ['fct_order', 'top', MID], to: ['dim_product', 'left', 64] };
const R_DATE = { from: ['fct_order', 'bottom', 88], to: ['dim_date', 'right', 85] };
const R_RETURN = { from: ['fct_return', 'left', 50], to: ['fct_order', 'bottom', 128] };
/** The one drawn by hand: straight across, fct_return's side to dim_date's. */
const R_DRAWN = { from: ['fct_return', 'left', 105], to: ['dim_date', 'right', 43] };
/** The AI's: straight across, fct_order's side to dim_store's. */
const R_STORE = { from: ['fct_order', 'left', 170], to: ['dim_store', 'right', 77] };
const RELS = {
  start: [R_CUSTOMER, R_PRODUCT, R_DATE, R_RETURN],
  dragged: [R_CUSTOMER, R_PRODUCT, R_DATE, R_RETURN, R_DRAWN],
  typed: [R_CUSTOMER, R_PRODUCT, R_DATE, R_RETURN, R_DRAWN],
  after: [R_CUSTOMER, R_PRODUCT, R_DATE, { from: ['fct_return', 'top', MID], to: ['fct_order', 'right', 150] }, R_DRAWN, R_STORE],
};
const buildLines = (rels, rects) => rels.map((r) => {
  const [fn, fs, fa] = r.from;
  const [tn, ts, ta] = r.to;
  const sa = anchor(rects, fn, fs, fa), ea = anchor(rects, tn, ts, ta);
  const s = push(sa, ROUTE.pathGap), e = push(ea, ROUTE.pathGap);
  const horizontal = (side) => side === 'left' || side === 'right';
  const pts = horizontal(fs) !== horizontal(ts) ? [s, horizontal(fs) ? { x: e.x, y: s.y } : { x: s.x, y: e.y }, e] : [s, e];
  return { id: `${fn}-${tn}`, from: fn, to: tn, cardinality: 'many-to-one', pts, many: push(sa, ROUTE.labelOffset), one: push(ea, ROUTE.labelOffset) };
});
/** Each phase's lines, and how they are drawn. */
export const LINES = Object.fromEntries(Object.keys(RELS).map((k) => [k, buildLines(RELS[k], RECTS[k])]));

/** corners.ts cornerRadii: how much of each segment each corner takes. */
function cornerRadii(pts, mode, rects) {
  const n = pts.length;
  const segLen = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  const rIn = new Array(n).fill(0), rOut = new Array(n).fill(0);
  for (let v = 1; v < n - 1; v++) {
    const inLen = segLen[v - 1], outLen = segLen[v];
    if (mode === 'rounded') { rIn[v] = rOut[v] = Math.min(ROUTE.roundedRadius, inLen / 2, outLen / 2); continue; }
    let a = Math.max(0, Math.min(ROUTE.curveRadius, v - 1 === 0 ? inLen - ROUTE.curveEndKeep : inLen / 2));
    let b = Math.max(0, Math.min(ROUTE.curveRadius, v === n - 2 ? outLen - ROUTE.curveEndKeep : outLen / 2));
    const small = Math.min(a, b);
    a = Math.min(a, small * ROUTE.curveRatio);
    b = Math.min(b, small * ROUTE.curveRatio);
    if (a > ROUTE.roundedRadius) [a, b] = clearOfCards(pts[v - 1], pts[v], pts[v + 1], a, b, rects);
    rIn[v] = a; rOut[v] = b;
  }
  return { segLen, rIn, rOut };
}
function cornerCurve(prev, cur, next, rIn, rOut) {
  const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y) || 1, outLen = Math.hypot(next.x - cur.x, next.y - cur.y) || 1;
  const a = { x: cur.x - ((cur.x - prev.x) / inLen) * rIn, y: cur.y - ((cur.y - prev.y) / inLen) * rIn };
  const b = { x: cur.x + ((next.x - cur.x) / outLen) * rOut, y: cur.y + ((next.y - cur.y) / outLen) * rOut };
  const K = ROUTE.kappa;
  return { a, b, c1: { x: a.x + (cur.x - a.x) * K, y: a.y + (cur.y - a.y) * K }, c2: { x: b.x + (cur.x - b.x) * K, y: b.y + (cur.y - b.y) * K } };
}
function clearOfCards(prev, cur, next, rIn, rOut, rects) {
  const C = ROUTE.curveClearance;
  const inside = (x, y, r) => x > r.x - C && x < r.x + r.w + C && y > r.y - C && y < r.y + r.h + C;
  const near = rects.filter((r) => !inside(cur.x, cur.y, r));
  for (let attempt = 0; attempt < 5; attempt++) {
    const { a, c1, c2, b } = cornerCurve(prev, cur, next, rIn, rOut);
    const hit = [0.2, 0.35, 0.5, 0.65, 0.8].some((t) => {
      const u = 1 - t;
      const x = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x;
      const y = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y;
      return near.some((r) => inside(x, y, r));
    });
    if (!hit) return [rIn, rOut];
    rIn *= 0.7; rOut *= 0.7;
    if (Math.max(rIn, rOut) <= ROUTE.roundedRadius) break;
  }
  return [Math.min(rIn, ROUTE.roundedRadius), Math.min(rOut, ROUTE.roundedRadius)];
}

/** Where two lines cross: [{ a: { line, seg, d }, b: … }], d along the segment (pathRender's findCrossings). */
function findCrossings(polys) {
  const out = [];
  for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) {
    for (let s = 0; s + 1 < polys[i].length; s++) for (let u = 0; u + 1 < polys[j].length; u++) {
      const [p, p2] = [polys[i][s], polys[i][s + 1]], [q, q2] = [polys[j][u], polys[j][u + 1]];
      const r = { x: p2.x - p.x, y: p2.y - p.y }, w = { x: q2.x - q.x, y: q2.y - q.y };
      const den = r.x * w.y - r.y * w.x;
      if (Math.abs(den) < 1e-9) continue;
      const ta = ((q.x - p.x) * w.y - (q.y - p.y) * w.x) / den, tb = ((q.x - p.x) * r.y - (q.y - p.y) * r.x) / den;
      if (ta <= 0 || ta >= 1 || tb <= 0 || tb >= 1) continue;
      out.push({ a: { line: i, seg: s, d: ta * Math.hypot(r.x, r.y) }, b: { line: j, seg: u, d: tb * Math.hypot(w.x, w.y) } });
    }
  }
  return out;
}

/** pathRender.ts: corners, then the crossing treatment, as SVG paths in flow px. */
function renderLines(style, lines = LINES, rects = RECTS) {
  const { crossings, corners } = LINE_STYLE_OPTIONS[style];
  const polys = lines.map((l) => l.pts);
  const radii = polys.map((p) => cornerRadii(p, corners, rects));
  const treatment = crossings === 'hops' ? 'hop' : 'cut';
  const half = treatment === 'hop' ? ROUTE.hopRadius : ROUTE.haloCutHalf;
  const other = treatment === 'hop' ? ROUTE.hopRadius : 2;
  const events = polys.map(() => []);
  const freeSpan = (line, s) => {
    const R = radii[line], last = R.segLen.length - 1;
    return [R.rOut[s] + (s === 0 ? ROUTE.stubClear : ROUTE.cornerClear), R.segLen[s] - R.rIn[s + 1] - (s === last ? ROUTE.stubClear : ROUTE.cornerClear)];
  };
  const fits = (e, reach) => { const [lo, hi] = freeSpan(e.line, e.seg); return e.d - reach >= lo && e.d + reach <= hi; };
  const horiz = (e) => { const a = polys[e.line][e.seg], b = polys[e.line][e.seg + 1]; return Math.abs(b.x - a.x) / (Math.hypot(b.x - a.x, b.y - a.y) || 1); };
  for (const c of findCrossings(polys)) {
    const ha = horiz(c.a), hb = horiz(c.b);
    const aOver = Math.abs(ha - hb) > 1e-3 ? ha > hb : lines[c.a.line].id > lines[c.b.line].id;
    const over = aOver ? c.a : c.b, under = aOver ? c.b : c.a;
    const [first, second] = treatment === 'hop' ? [over, under] : [under, over];
    const add = (e) => { (events[e.line][e.seg] ??= []).push(e.d); };
    if (fits(first, half) && fits(second, other)) add(first);
    else if (fits(second, half) && fits(first, other)) add(second);
  }
  return polys.map((pts, li) => renderOne(pts, corners, radii[li], treatment, events[li], half));
}

const f2 = (v) => String(Math.round(v * 100) / 100);
const P = (p) => `${f2(p.x)},${f2(p.y)}`;
/** pathRender.ts renderOne: `d` (one subpath: the arrows follow it), `strokeD` (cut where it passes
 * under: the stroke and casing are drawn with it), and a flattened copy for the arrows. */
function renderOne(pts, corners, radii, treatment, segEvents, half) {
  let d = `M ${P(pts[0])}`, sd = null;
  const flat = [pts[0]];
  const emit = (cmd) => { d += cmd; if (sd !== null) sd += cmd; };
  const bez = (p0, c1, c2, p1) => { for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; flat.push({ x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x, y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y }); } };
  let last = pts[0];
  for (let s = 0; s + 1 < pts.length; s++) {
    const a = pts[s], b = pts[s + 1], len = radii.segLen[s];
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const at = (t) => ({ x: a.x + ux * t, y: a.y + uy * t });
    if (s > 0 && (radii.rIn[s] > 0 || radii.rOut[s] > 0)) {
      const cc = cornerCurve(pts[s - 1], a, b, radii.rIn[s], radii.rOut[s]);
      if (corners === 'rounded') {
        emit(` Q ${P(a)} ${P(cc.b)}`);
        bez(last, { x: last.x + (a.x - last.x) * 2 / 3, y: last.y + (a.y - last.y) * 2 / 3 }, { x: cc.b.x + (a.x - cc.b.x) * 2 / 3, y: cc.b.y + (a.y - cc.b.y) * 2 / 3 }, cc.b);
      } else {
        emit(` C ${P(cc.c1)} ${P(cc.c2)} ${P(cc.b)}`);
        bez(last, cc.c1, cc.c2, cc.b);
      }
      last = cc.b;
    }
    let cursor = radii.rOut[s];
    const straightTo = (t) => { if (t <= cursor + 1e-6) return; const to = at(t); emit(` L ${P(to)}`); flat.push(to); cursor = t; last = to; };
    const list = (segEvents[s] ?? []).slice().sort((p, q) => p - q);
    const merged = [];
    for (const c of list) {
      const prev = merged.at(-1);
      if (prev && c - half - prev[1] < ROUTE.mergeSlack) prev[1] = Math.max(prev[1], c + half);
      else merged.push([c - half, c + half]);
    }
    for (const [lo, hi] of merged) {
      straightTo(lo);
      const A = at(lo), B = at(hi);
      if (treatment === 'cut') {
        if (sd === null) sd = d;
        d += ` L ${P(B)}`;
        sd += ` M ${P(B)}`;
        flat.push(B);
      } else {
        // hopNormal: up for anything not vertical, right for a vertical
        let nx = uy, ny = -ux;
        if (Math.abs(ny) > 0.05) { if (ny > 0) { nx = -nx; ny = -ny; } } else if (nx < 0) { nx = -nx; ny = -ny; }
        const r = ROUTE.hopRadius, k = ROUTE.kappa * r;
        const up = (p, along, out) => ({ x: p.x + ux * along + nx * out, y: p.y + uy * along + ny * out });
        const arc = (p0, c1, c2, p1) => { emit(` C ${P(c1)} ${P(c2)} ${P(p1)}`); bez(p0, c1, c2, p1); };
        if (hi - lo <= 2 * r + 0.01) {
          const T2 = up(A, r, r);
          arc(A, up(A, 0, k), up(T2, -k, 0), T2);
          arc(T2, up(T2, k, 0), up(B, 0, k), B);
        } else {
          const TL = up(A, r, r), TR = up(B, -r, r);
          arc(A, up(A, 0, k), up(TL, -k, 0), TL);
          emit(` L ${P(TR)}`); flat.push(TR);
          arc(TR, up(TR, k, 0), up(B, 0, k), B);
        }
      }
      cursor = hi;
      last = B;
    }
    straightTo(len - radii.rIn[s + 1]);
  }
  let length = 0;
  for (let i = 1; i < flat.length; i++) length += Math.hypot(flat[i].x - flat[i - 1].x, flat[i].y - flat[i - 1].y);
  return { d, strokeD: sd, flat, length };
}
/** The line style in use throughout: the default (the toolbar's switch shows it chosen). */
export const LINE_STYLE = 'curved';
export const LINE_STYLES = ['curved', 'hops'];
export const DRAWN = Object.fromEntries(Object.keys(LINES).map((k) => [k, renderLines(LINE_STYLE, LINES[k], RECTS[k])]));

// ---- The hover preview, as packages/renderer draws it in a plain folder -----------------------
//   - hoverIntent.ts: a table becomes the focus 120 ms after the pointer comes to rest on it, 60 ms
//     when switching from another table; leaving clears it after 150 ms, unless the pointer is on
//     one of the focus's lines (useHoverFocus.ts: following a bright line off the table keeps it).
//   - canvasFocus.ts (`ownLinesOnly`): the table, every table one line away and the table's own
//     lines stay bright; ModelNode.css / FkEdge.css fade the other tables to 0.22, the other lines
//     to 0.15 and their `*` / `1` to 0.2, over 0.15 s (the casing under a line does not fade). The
//     hovered table gets a 3 px ring in the neutral ring colour (no blue: a plain folder's canvas has
//     no stage colours).
//   - EdgeRouting.css "Colour on hover": the focused lines, their `*` / `1` and their arrows take
//     the diagram's layer colour (Main: layerService.ts #6366f1); the lines go 2 → 2.5 px. Colour
//     and width change at once (only opacity is transitioned).
//   - edgeFlow.ts / EdgeFlow.tsx: the arrows follow the drawn path from fct_order's end (`*`) to the
//     key's table (`1`); many-to-one is `reverse`, so they travel from the `1` end into the `*` end.
//     56 px/s, one per 90 px (2–4), each fading in and out over the first and last 10 % of its
//     pass, a filled notched chevron with a halo in the canvas colour.
export const HOVER = {
  enterDelay: 0.12, switchDelay: 0.06, leaveGrace: 0.15, fade: 0.15,
  tableOpacity: 0.22, lineOpacity: 0.15, labelOpacity: 0.2,
  layerColour: '#6366f1', ring: 'rgba(138,148,163,0.3)',
};
export const FLOW = { speed: 56, spacing: 90, minGlyphs: 2, maxGlyphs: 4, minDur: 1.6, maxDur: 7, durBucket: 0.5 };
/** EdgeFlow.tsx CHEVRON_D: 8 × 9 flow px, pointing along +x. */
export const CHEVRON_D = 'M -4,-4.5 L 4,0 L -4,4.5 L -1.75,0 Z';
const GLYPH_SCALE = 2;


// ---- The pointer ------------------------------------------------------------------------------------
/** A column row's centre in body px. */
const rowAt = (tables, [table, column]) => {
  const tb = tables.find((x) => x.name === table), i = tb.cols.findIndex(([, n]) => n === column);
  return { x: CX + tb.x * CS + NW * CS / 2, y: CY + (tb.y + 62 + (tb.grain ? 42 : 0) + 46 * i + 23) * CS };
};
const SRC = rowAt(T, DRAG.from), DST = rowAt(T, DRAG.to);
/** The dialog: the real one's picture, drawn DIALOG_K× at the top centre of the canvas, as the product places it. */
const DIALOG_K = 1.12;
const DLG = { x: Math.round(EDX + (BODYW - EDX) / 2 - DIALOG.w * DIALOG_K / 2), y: 26, w: DIALOG.w * DIALOG_K, h: DIALOG.h * DIALOG_K };
export const CREATE_AT = { x: DLG.x + DIALOG.buttonAt.x * DIALOG_K, y: DLG.y + DIALOG.buttonAt.y * DIALOG_K };
const ON_FACT = { x: CX + 520 * CS + 150, y: CY + 170 * CS + 20 };
/**
 * The pointer (body px), one visit: in from below the window, a rest on fct_order's header (the
 * hover), across to fct_return's date_key (pressed as it arrives), the drag to dim_date's date_key,
 * the drop, down to Create Relationship, its click, and out past the right edge under the tables.
 */
export const HOVER_PATH = [
  { t: 0.25, x: 1250, y: 860 }, { t: 0.95, ...ON_FACT }, { t: 2.75, ...ON_FACT },
  { t: PRESS_AT, x: SRC.x - 90, y: SRC.y + 4 }, { t: DRAG_FROM + 0.1, x: SRC.x - 90, y: SRC.y + 4 },
  { t: DROP_AT - 0.25, x: DST.x + 20, y: DST.y + 4 }, { t: DROP_AT + 0.2, x: DST.x + 20, y: DST.y + 4 },
  { t: CREATE_CLICK - 0.2, x: CREATE_AT.x + 14, y: CREATE_AT.y + 6 }, { t: CREATE_CLICK + 0.45, x: CREATE_AT.x + 14, y: CREATE_AT.y + 6 },
  { t: 7.4, x: 1470, y: 770 },
];
const press = (t) => (t >= CREATE_CLICK && t < CREATE_ON ? (t - CREATE_CLICK) / CLICK : 0);
/** True while the column is being dragged: from the long press to the drop. */
const draggingAt = (t) => t >= DRAG_FROM && t < DROP_AT;
/** True while the dialog is up: from the drop to the click's mouse-up. */
const dialogAt = (t) => t >= DROP_AT && t < CREATE_ON;

/** Body px → flow px of the canvas. */
const toFlow = (p) => ({ x: p.x - CX, y: p.y - CY });
const tableAt = (p) => { const q = toFlow(p); return RECTS.start.find((r) => q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h)?.id ?? null; };
/** True when the pointer is on a line's 16 px hit area (FkEdge's invisible wider path), off the tables. */
function onLine(p, li) {
  const q = toFlow(p), pts = DRAWN.start[li].flat;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const k = l2 ? clamp(((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / l2) : 0;
    if (Math.hypot(q.x - (a.x + k * (b.x - a.x)), q.y - (a.y + k * (b.y - a.y))) <= 8) return true;
  }
  return false;
}
/** The tables and lines a table's hover preview keeps bright (computeCanvasFocus, ownLinesOnly). */
function focusOf(id) {
  if (!id) return null;
  const lines = LINES.start.filter((l) => l.from === id || l.to === id);
  return { node: id, nodes: new Set([id, ...lines.flatMap((l) => [l.from, l.to])]), lines: new Set(lines.map((l) => l.id)) };
}

/**
 * When the focus changes: hoverIntent.ts's timers run against the pointer's path, sampled at 240 Hz.
 * Computed once, so render(t) stays a pure lookup. [{ t, id }], id null when the preview clears.
 */
export const FOCUS_CHANGES = (() => {
  const changes = [];
  let current = null, enter = null, leave = null, inTable = null, onLines = new Set();
  const commit = (t, id) => { if (id !== current) { current = id; changes.push({ t: +t.toFixed(4), id }); } };
  const t0 = HOVER_PATH[0].t, t1 = PRESS_AT;   // a press ends the preview (and none shows while a column is dragged)
  for (let k = 0; t0 + k / 240 <= t1; k++) {
    const t = t0 + k / 240;
    if (enter && t >= enter.at) { commit(enter.at, enter.id); enter = null; }
    if (leave && t >= leave.at) { commit(leave.at, null); leave = null; }
    const p = path(t, HOVER_PATH);
    const table = tableAt(p);
    // tables sit above the lines: a line under a table takes no pointer events
    const lines = new Set(table ? [] : LINES.start.map((l, i) => (onLine(p, i) ? l.id : null)).filter(Boolean));
    const bright = focusOf(current)?.lines ?? new Set();
    if (table !== inTable) {
      if (inTable) {                     // mouseleave: drop a pending enter, clear after the grace
        enter = null;
        leave = current ? { at: t + HOVER.leaveGrace } : null;
      }
      if (table) {                       // mouseenter
        leave = null;
        if (table === current) enter = null;
        else if (!enter || enter.id !== table) enter = { id: table, at: t + (current ? HOVER.switchDelay : HOVER.enterDelay) };
      }
      inTable = table;
    }
    for (const id of lines) if (!onLines.has(id) && bright.has(id)) leave = null;                          // hold()
    for (const id of onLines) if (!lines.has(id) && bright.has(id) && !table && current) leave = { at: t + HOVER.leaveGrace };   // leave()
    onLines = lines;
  }
  commit(PRESS_AT, null);
  return changes;
})();

/** The focus at t, and the one before it with when it changed (for the 0.15 s fades). */
function focusAt(t) {
  let i = -1;
  while (i + 1 < FOCUS_CHANGES.length && FOCUS_CHANGES[i + 1].t <= t) i++;
  return { now: focusOf(i >= 0 ? FOCUS_CHANGES[i].id : null), before: focusOf(i >= 1 ? FOCUS_CHANGES[i - 1].id : null), since: i >= 0 ? FOCUS_CHANGES[i].t : -Infinity };
}
/** CSS `ease` (cubic-bezier(.25,.1,.25,1)), close enough for a 0.15 s fade. */
const ease = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : 1 - Math.pow(1 - p, 2.2));
/** An opacity the hover preview transitions: from its value under the previous focus to the current. */
function faded(t, f, value) {
  const a = value(f.before), b = value(f.now);
  return a + (b - a) * ease((t - f.since) / HOVER.fade);
}

/** planEdgeFlow's moving chevrons for one drawn line: [{ at: 0..1 along the path, opacity, reverse }] at t. */
export function flowGlyphs(drawn, line, t) {
  const flowLen = Math.round(drawn.length / 8) * 8;   // EdgeFlow buckets the measured length
  const dur = clamp(Math.round(flowLen / FLOW.speed / FLOW.durBucket) * FLOW.durBucket, FLOW.minDur, FLOW.maxDur);
  const n = clamp(Math.round(flowLen / FLOW.spacing), FLOW.minGlyphs, FLOW.maxGlyphs);
  const reverse = line.cardinality !== 'one-to-many';   // flowModeFor: many-to-one → reverse
  const out = [];
  for (let i = 0; i < n; i++) {
    // begin = -(i·dur/n): glyph i runs i/n of a pass ahead; keyPoints 0;1 or 1;0, opacity 0;1;1;0 at 0;.1;.9;1
    const p = ((((t + (i * dur) / n) / dur) % 1) + 1) % 1;
    out.push({ at: reverse ? 1 - p : p, opacity: Math.min(1, p / 0.1, (1 - p) / 0.1), reverse });
  }
  return out;
}
/** The point `at` (0..1) along a flattened path, and the path's direction there in degrees. */
export function poseAt(pts, at) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let d = at * total;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (d <= l || i === pts.length - 1) {
      const k = l ? Math.min(1, d / l) : 0;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI };
    }
    d -= l;
  }
  return { x: pts[0].x, y: pts[0].y, angle: 0 };
}

/** One relationship line as FkEdge draws it (flow px): casing (Curved), stroke, arrows, `*` / `1`. */
function drawLine(line, drawn, { halo, colour, width, lineOp, labelOp, glyphs }) {
  const stroke = drawn.strokeD ?? drawn.d;
  let h = '';
  if (halo) h += `<path d="${stroke}" fill="none" stroke="var(--card)" stroke-width="${ROUTE.haloWidth * STROKE_K}"/>`;
  h += `<path d="${stroke}" fill="none" stroke="${colour}" stroke-width="${width * STROKE_K}" opacity="${lineOp.toFixed(3)}"/>`;
  for (const g of glyphs) {
    const pose = poseAt(drawn.flat, g.at);
    h += `<g transform="translate(${f2(pose.x)} ${f2(pose.y)}) rotate(${(pose.angle + (g.reverse ? 180 : 0)).toFixed(1)}) scale(${GLYPH_SCALE})" opacity="${g.opacity.toFixed(3)}"><path d="${CHEVRON_D}" fill="${colour}" stroke="var(--card)" stroke-width="1.5" paint-order="stroke fill" stroke-linejoin="round"/></g>`;
  }
  const label = (txt, p, size) => `<text x="${f2(p.x)}" y="${f2(p.y)}" fill="${colour}" font-size="${size}" font-weight="800" font-family="JetBrains Mono" text-anchor="middle" dominant-baseline="central" opacity="${labelOp.toFixed(3)}">${txt}</text>`;
  return h + label('*', { x: line.many.x, y: line.many.y + 3 }, 24) + label('1', line.one, 17);
}


/** The canvas's lines at t (flow px, under the tables), with the hover's colour and arrows while it is on. */
function linesSvg(t, f) {
  const phase = phaseAt(t);
  const lines = LINES[phase], drawn = DRAWN[phase];
  let h = '';
  for (const [i, line] of lines.entries()) {
    const on = !!f.now?.lines.has(line.id);
    // a line just made: by hand (from the click), by the AI (as its last edit lands)
    const since = line.to === AI_TABLE.name ? AI.done : line.from === DRAG.from[0] && line.to === DRAG.to[0] ? CREATE_ON : null;
    const fresh = since === null ? 0 : Math.sin(Math.PI * seg(t, since, since + 1.5));
    if (fresh > 0) h += `<path d="${drawn[i].d}" fill="none" stroke="${since === AI.done ? '#22c55e' : '#60a5fa'}" stroke-width="${(9 * fresh).toFixed(2)}" stroke-linecap="round" opacity="${(0.55 * fresh).toFixed(3)}"/>`;
    h += drawLine(line, drawn[i], {
      halo: true,
      colour: on ? HOVER.layerColour : COLORS.neutralLine,
      width: on ? 2.5 : 2,
      lineOp: faded(t, f, (x) => (!x || x.lines.has(line.id) ? 1 : HOVER.lineOpacity)) * (since === null ? 1 : easeOut(seg(t, since, since + 0.3))),
      labelOp: faded(t, f, (x) => (!x || x.lines.has(line.id) ? 1 : HOVER.labelOpacity)) * (since === null ? 1 : easeOut(seg(t, since, since + 0.3))),
      glyphs: on ? flowGlyphs(drawn[i], line, t) : [],
    });
  }
  return `<svg class="abs" style="left:${CX}px;top:${CY}px;overflow:visible" width="1" height="1">${h}</svg>`;
}

// ---- By hand: the drag, as the canvas draws it ----------------------------------------------------
//   - ModelNode.tsx: a long press on a column (220 ms) starts the drag; the pressed row gets a 2 px
//     inset outline in the focus colour (ModelNode.css `--dragging`), the row under the pointer the
//     drop target's fill and glow (`--drop-target`).
//   - DragLine.tsx / .css: a straight dashed line (8 4, 2 px, --edge-design: the Logical blue, on a
//     neutral canvas too) from the pressed row's centre to the pointer, with an arrow head.
//   - The drop opens New Relationship filled in (NewFkDialog.tsx), top centre of the canvas; its
//     Create Relationship button adds the relationship. Seen and photographed in the real canvas
//     (record/heroRun.mjs).
export const DRAG_LINE = { colour: '#60a5fa', dash: '8 4', width: 2, focus: '#007fd4' };
function dragLine(t) {
  if (!draggingAt(t)) return '';
  const p = path(t, HOVER_PATH);
  const a = Math.atan2(p.y - SRC.y, p.x - SRC.x), len = Math.hypot(p.x - SRC.x, p.y - SRC.y);
  if (len < 12) return '';
  const head = `M0 0 L-13 -6 L-13 6 Z`;
  return `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><line x1="${SRC.x.toFixed(1)}" y1="${SRC.y.toFixed(1)}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="${DRAG_LINE.colour}" stroke-width="${DRAG_LINE.width * STROKE_K * 1.2}" stroke-dasharray="${DRAG_LINE.dash.split(' ').map((d) => d * 1.6).join(' ')}" opacity=".9"/>
    <path d="${head}" fill="${DRAG_LINE.colour}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${(a * 180 / Math.PI).toFixed(1)})"/></svg>`;
}
function dialog(t) {
  if (!dialogAt(t)) return '';
  const op = easeOut(seg(t, DROP_AT, DROP_AT + 0.2));
  return `<div class="abs" style="left:${DLG.x}px;top:${(DLG.y + 10 * (1 - op)).toFixed(1)}px;width:${DLG.w}px;height:${DLG.h}px;border-radius:9px;overflow:hidden;box-shadow:0 24px 60px #000c;opacity:${op.toFixed(3)}"><img src="/video/player/assets/${DIALOG.file}" width="${DLG.w}" height="${DLG.h}" style="display:block;width:${DLG.w}px;height:${DLG.h}px"></div>`;
}

/** The terminal panel's height: its tab row, the prompt and one row per step. */
const TERM = { head: 36, row: 26, pad: 16 };
const TERM_H = TERM.head + TERM.pad + TERM.row * (1 + AI_STEPS.length) + 6;
/** How far the terminal is open at t (0..1). */
const termOpen = (t) => easeOut(seg(t, AI.open, AI.open + 0.3)) * (1 - easeInOut(seg(t, AI.close, AI.close + 0.35)));
const PROMPT_END = AI.type + AI_PROMPT.length / AI.cps;

/** Claude Code in the integrated terminal: the prompt typed, then the skill and each file it changed. */
function terminal(t) {
  const open = termOpen(t);
  if (open <= 0) return '';
  let rows = `<div style="display:flex;align-items:center;gap:10px;height:${TERM.row}px;white-space:pre"><span style="color:var(--text-2)">&gt;</span><span>${esc(typed(AI_PROMPT, t, AI.type, AI.cps))}</span>${t < AI.steps[0] ? caret(t, PROMPT_END) : ''}</div>`;
  AI_STEPS.forEach(([verb, target], i) => {
    const at = AI.steps[i];
    if (t < at) return;
    const done = t >= at + 0.3;
    rows += `<div style="display:flex;align-items:center;gap:10px;height:${TERM.row}px;white-space:pre;opacity:${easeOut(seg(t, at, at + 0.2)).toFixed(3)}"><span style="width:9px;height:9px;border-radius:50%;background:${done ? 'var(--green)' : 'var(--text-2)'}"></span><span>${verb}<span style="color:var(--text-2)">(${esc(target)})</span></span></div>`;
  });
  return `<div class="abs" style="left:${EDX}px;right:0;bottom:${(-(1 - open) * TERM_H).toFixed(1)}px;height:${TERM_H}px;background:#131517;border-top:1px solid #34363d;box-shadow:0 -14px 34px #0007">
      <div style="height:${TERM.head}px;display:flex;align-items:center;gap:26px;padding:0 20px;font-size:15px;font-weight:600;letter-spacing:.06em;color:var(--text-3);white-space:nowrap">
        <span>PROBLEMS</span><span>OUTPUT</span><span style="color:var(--text);box-shadow:0 2px 0 var(--text);padding:8px 0">TERMINAL</span><span style="flex:1"></span>
        <span style="display:flex;align-items:center;gap:8px;letter-spacing:0;font-size:16px;color:var(--text-2)"><span style="color:var(--claude);display:flex">${ICON.claude({ size: 18 })}</span>Claude Code</span></div>
      <div class="mono" style="padding:${TERM.pad / 2}px 20px 0;font-size:18px;color:var(--text)">${rows}</div></div>`;
}

/** fct_order.dbml's text in a card at the canvas's bottom right, the new line typed into it. */
function textCard(t) {
  if (t < TEXT_IN || t >= TEXT_OUT + 0.3) return '';
  const op = Math.min(1, easeOut(seg(t, TEXT_IN, TEXT_IN + 0.3))) * (1 - seg(t, TEXT_OUT, TEXT_OUT + 0.3));
  const typing = t >= TYPE_FROM, end = TYPE_FROM + TYPED_LINE.length / TYPE_CPS, saved = t >= TYPED_AT;
  const lines = [...FCT_DBML.slice(0, TYPED_UNDER + 1), ...(typing ? [null] : []), ...FCT_DBML.slice(TYPED_UNDER + 1)];
  const body = lines.map((l, i) => {
    const mine = l === null;
    const text = mine ? `${dbmlLine(typed(TYPED_LINE, t, TYPE_FROM, TYPE_CPS))}${saved ? '' : caret(t, end)}` : dbmlLine(l);
    return `<div style="display:flex;height:28px;align-items:center;${mine ? `background:rgba(96,165,250,${saved ? '.2' : '.1'});box-shadow:inset 4px 0 0 #60a5fa` : ''}"><span style="width:26px;text-align:right;margin-right:16px;color:var(--line-no)">${i + 1}</span><span style="white-space:pre">${text}</span></div>`;
  }).join('');
  const dot = typing && !saved ? '<span style="width:10px;height:10px;border-radius:50%;background:var(--text-2)"></span>' : saved ? `<span style="color:${GIT_COLOUR.M};font-weight:700">M</span>` : '';
  return `<div class="abs" style="right:24px;bottom:22px;width:560px;border-radius:12px;background:#1b1c20;border:1px solid #3a3c42;box-shadow:0 18px 48px #000c;overflow:hidden;opacity:${op.toFixed(3)};transform:translateY(${(12 * (1 - op)).toFixed(1)}px)">
      <div style="height:40px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid #2c2c30;font-size:18px;color:var(--text-2);white-space:nowrap"><span style="color:#5ca2f8;display:flex">${ICON.file({ size: 18 })}</span>.erd-studio/main/tables/main/fct_order.dbml<span style="flex:1"></span>${dot}</div>
      <div class="mono" style="padding:8px 0 10px 4px;font-size:17px">${body}</div></div>`;
}

function ordersCanvas(t) {
  const phase = phaseAt(t);
  const f = focusAt(t);
  // what an edit just put on the canvas: lit as it lands, then at rest
  const lit = (since, hold) => (t >= since ? 0.3 + 0.7 * (1 - seg(t, since + hold, since + hold + 0.8)) : 0);
  const typedGlow = phase === 'typed' || phase === 'after' ? lit(TYPED_AT, 1) * (phase === 'after' ? 0 : 1) : 0;
  const aiGlow = phase === 'after' ? lit(AI.done, 1.2) : 0;
  const aiIn = phase === 'after' ? easeOut(seg(t, AI.done, AI.done + 0.35)) : 0;
  const dragging = draggingAt(t), pressed = t >= PRESS_AT && t < DROP_AT;
  const p = path(t, HOVER_PATH);
  const overTarget = dragging && Math.abs(p.x - DST.x) <= NW * CS / 2 && Math.abs(p.y - DST.y) <= 23 * CS;
  let inner = '';
  for (const tb of TABLES[phase]) {
    const isNew = tb.name === AI_TABLE.name;
    const shadow = isNew ? `0 0 0 ${(5 * aiGlow).toFixed(1)}px rgba(34,197,94,${(0.6 * aiGlow).toFixed(3)}),`
      : f.now?.node === tb.name ? `0 0 0 ${(3 / CS).toFixed(1)}px ${HOVER.ring},` : '';
    const op = isNew ? aiIn : faded(t, f, (x) => (!x || x.nodes.has(tb.name) ? 1 : HOVER.tableOpacity));
    const cols = tb.cols.map(([key, name, type]) => {
      const is = ([table, column]) => table === tb.name && column === name;
      const rowStyle = is(DRAG.from) && pressed ? `box-shadow:inset 0 0 0 ${(2 / CS).toFixed(1)}px ${DRAG_LINE.focus};opacity:${dragging ? 0.6 : 1}`
        : is(DRAG.to) && overTarget ? `background:rgba(0,127,212,.18);box-shadow:inset 0 0 0 ${(2 / CS).toFixed(1)}px ${DRAG_LINE.focus}`
        : is([TYPED_COLUMN.table, TYPED_COLUMN.col[1]]) && typedGlow > 0 ? `background:rgba(96,165,250,${(0.22 * typedGlow).toFixed(3)});box-shadow:inset 5px 0 0 rgba(96,165,250,${typedGlow.toFixed(3)})`
        : is([AI_COLUMN.table, AI_COLUMN.col[1]]) && aiGlow > 0 ? `background:rgba(34,197,94,${(0.2 * aiGlow).toFixed(3)});box-shadow:inset 5px 0 0 rgba(34,197,94,${aiGlow.toFixed(3)})` : undefined;
      return { key: key ?? undefined, name, type, rowStyle };
    });
    const style = `${shadow ? `box-shadow:${shadow}0 18px 44px #0009;` : ''}${op < 1 ? `opacity:${op.toFixed(3)};` : ''}`;
    inner += node({ x: tb.x, y: tb.y, w: NW, name: tb.name, grain: tb.grain, cols, style });
  }
  return `<div class="abs grid-bg" style="left:${EDX}px;top:0;right:0;bottom:0;background-color:var(--card)"></div>
    ${linesSvg(t, f)}
    <div class="abs" style="left:${CX}px;top:${CY}px;transform-origin:0 0;transform:scale(${CS})">${inner}</div>
    ${toolbar({ x: EDX + 20, y: 16, logicalOnly: true, layout: 'idle', add: 'idle', lineStyle: LINE_STYLE })}
    ${dragLine(t)}${dialog(t)}${textCard(t)}${terminal(t)}`;
}

function explorer(t) {
  const live = t < CONF_IN;
  const rows = heroTree({ store: live && t >= STORE_FILE_AT });
  const at = (id) => rows.findIndex((r) => r[4] === id);
  const pulse = (from, hold) => easeOut(seg(t, from, from + 0.25)) * (1 - seg(t, from + hold, from + hold + 0.4));
  const lights = new Map();
  const add = (id, v) => { const i = at(id); if (i >= 0 && v > 0) lights.set(i, Math.max(lights.get(i) ?? 0, v)); };
  if (live) {
    add('t:fct_order', pulse(TEXT_IN, TEXT_OUT - TEXT_IN));
    for (const [id, , from] of GIT) add(id, pulse(from, id === 't:dim_store' ? 2 : 1.1));
    for (const [i, id] of [[1, 't:fct_order'], [2, 'rels']]) add(id, pulse(AI.steps[i] + 0.25, 0.9));
  }
  const git = new Map(GIT.filter(([, , from]) => live && t >= from).map(([id, letter]) => [at(id), letter]));
  const tree = fileTree(rows, {
    top: 0, rowH: ROW_H, width: SIDEW - 10, indent: 22, font: 19,
    lit: (i) => lights.get(i) ?? 0,
    colour: (i) => (git.has(i) ? GIT_COLOUR[git.get(i)] : null),
    badge: (i) => (git.has(i) ? `<span style="flex:1"></span><span style="margin-right:22px;font-size:17px;font-weight:700;color:${GIT_COLOUR[git.get(i)]}">${git.get(i)}</span>` : ''),
  });
  return `<div class="abs" style="left:${ACTW}px;top:0;width:${SIDEW}px;bottom:0;background:#16181b;border-right:1px solid var(--card-border)">
    <div class="abs" style="left:22px;top:16px;font-size:18px;font-weight:700;letter-spacing:.08em;color:var(--text-2)">EXPLORER</div>
    <div class="abs" style="left:14px;top:50px;display:flex;align-items:center;gap:6px;font-size:19px;font-weight:800;letter-spacing:.04em">${ICON.chevDown({ size: 18 })}SHOP-ANALYTICS</div>
    <div class="abs" style="left:10px;top:${TREE_TOP}px;right:0;bottom:0;overflow:hidden">${tree}</div></div>`;
}

// ---- The Confluence page ---------------------------------------------------------------------------
// ERD Studio for Confluence (the Atlassian Marketplace app, docs/dev/compatibility.md) is a read-only
// viewer: a macro that reads the committed .erd-studio files from the team's GitHub repo and draws
// the diagram on a Confluence page. Nothing here claims more: no editing in Confluence, no sync
// back, no price. The diagram is a real render (assets/confluence-hero.png, `npm run confluence:hero`):
// the files the real run left (record/hero-run.json, design.after) loaded by @erd-studio/core and
// drawn by @erd-studio/renderer's ErdCanvas in viewer mode, as the macro runs it, on a light page.
export const CONFLUENCE = {
  shot: { file: 'confluence-hero.png', w: 1300, h: 560 },   // confluence-shot.mjs SHOT (at 2x)
  app: 'ERD Studio for Confluence', readOnly: 'Read-only', title: 'Orders data model',
  repo: 'shop-analytics', file: '.erd-studio/main/diagrams/orders.dbml',
  pill: 'For business users: no VS Code needed',
};
const L = { page: '#ffffff', bar: '#f7f8f9', line: '#dfe1e6', text: '#172b4d', text2: '#44546f', text3: '#626f86', blue: '#1868db' };
const LOGO = (f) => `/video/player/assets/logos/${f}`;
function confluencePage(t) {
  if (t < CONF_IN || t >= CONF_OUT) return '';
  const BAR = 56, MHEAD = 50, MX = 28, MW = WIN.w - 2 * MX;
  const ih = Math.round(MW * CONFLUENCE.shot.h / CONFLUENCE.shot.w), MY = BAR + 96;
  const land = (at) => easeOut(seg(t, at, at + 0.4));
  const biz = land(CONF_IN + 1.3), src = Math.sin(Math.PI * seg(t, CONF_IN + 2.2, CONF_IN + 2.9));
  const chev = `<span style="color:${L.text3};display:flex">${ICON.chevRight({ size: 18, sw: 2.6 })}</span>`;
  return `<div class="abs" style="left:${WIN.x}px;top:${WIN.y}px;width:${WIN.w}px;height:${WIN.h}px;border-radius:20px;background:${L.page};overflow:hidden;box-shadow:0 30px 80px #000a">
      <div class="abs" style="left:0;right:0;top:0;height:${BAR}px;background:${L.bar};border-bottom:1px solid ${L.line};display:flex;align-items:center;gap:12px;padding:0 24px;font-size:21px;color:${L.text2};white-space:nowrap">
        <img src="${LOGO('confluence.svg')}" width="30" height="30" style="display:block;width:30px;height:30px"><span style="font-weight:700;color:${L.text}">Confluence</span>${chev}Data team${chev}Data models</div>
      <div class="abs" style="left:${MX}px;top:${BAR + 22}px;font-size:40px;font-weight:800;letter-spacing:-.02em;color:${L.text};white-space:nowrap">${CONFLUENCE.title}</div>
      <div class="abs" style="right:${MX}px;top:${BAR + 28}px;opacity:${biz.toFixed(3)};transform:scale(${(0.9 + 0.1 * biz).toFixed(3)});transform-origin:100% 50%"><span class="pill" style="font-size:22px;padding:7px 18px;gap:9px;background:#dcfff1;border:2px solid #4bce97;color:#216e4e">${ICON.check({ size: 20 })}${CONFLUENCE.pill}</span></div>
      <div class="abs" style="left:${MX}px;top:${MY}px;width:${MW}px;height:${MHEAD + ih}px;border-radius:10px;overflow:hidden;border:1px solid ${L.line};background:#fff">
        <div style="height:${MHEAD}px;display:flex;align-items:center;gap:10px;padding:0 10px;background:${L.bar};border-bottom:1px solid ${L.line}">
          <span class="pill" style="font-size:20px;padding:5px 14px 5px 6px;gap:9px;background:#0b1422;color:#fff">${appIcon(26, 'box-shadow:none;border-radius:6px')}${CONFLUENCE.app}</span><span style="flex:1"></span>
          <span class="pill" style="font-size:18px;padding:4px 12px;gap:7px;background:#fff;color:${L.text2};border:1px solid ${L.line}">${ICON.lock({ size: 15 })}${CONFLUENCE.readOnly}</span></div>
        <img src="/video/player/assets/${CONFLUENCE.shot.file}" width="${MW}" height="${ih}" style="display:block;width:${MW}px;height:${ih}px"></div>
      <div class="abs" style="left:${MX}px;top:${MY + MHEAD + ih + 12}px;display:flex;align-items:center;gap:10px;font-size:20px;color:${L.text3};white-space:nowrap">
        <img src="${LOGO('github.svg')}" width="24" height="24" style="display:block;width:24px;height:24px;transform:scale(${(1 + 0.3 * src).toFixed(3)})">
        <span>Drawn from GitHub: ${CONFLUENCE.repo} · main ·</span><span class="mono" style="font-size:18px;color:${L.text2}">${CONFLUENCE.file}</span></div></div>`;
}

export function render(t) {
  t = ((t % HERO.loop) + HERO.loop) % HERO.loop;
  let body = ordersCanvas(t) + explorer(t) + activityBar('files');
  // the pointer, on top of everything (the window clips it as it comes in and goes out)
  if (t >= HOVER_PATH[0].t && t <= HOVER_PATH.at(-1).t) {
    const p = path(t, HOVER_PATH);
    body += pointer(p.x, p.y, press(t));
  }
  return `<div class="abs" style="left:0;top:0;width:${HERO.w}px;height:${CAP_H}px">${captionBand(t)}</div>`
    + card({ ...WIN, tabs: [{ label: 'orders.dbml', on: true }], crumb: '.erd-studio › main › diagrams › orders.dbml', body })
    + confluencePage(t);
}

if (typeof document !== 'undefined') {
  const stage = document.getElementById('stage');
  let last = '';
  window.render = (t) => { const h = render(t); if (h !== last) { stage.innerHTML = h; last = h; } };
  window.HERO = HERO;
  window.render(0);
  window.__ready = true;
}
