// The README's hero GIF (media/demo.gif), drawn by ../hero-gif.mjs from player/hero.html with the
// video's own pieces (editor.js, lib.js): ERD Studio in a plain folder (no stage tabs, nothing to
// compare), the Explorer showing the layer-first .erd-studio tree beside the orders diagram, drawn
// neutral (a plain folder has no stage colours), under a caption band that says one short thing per
// beat (CAPTIONS):
//   1. "Your model, as DBML files": the table files light one by one with their tables, then
//      fct_order.dbml's text shows.
//   2. "Import what you have": sales.dbml (in the folder's top level) lights and the editor switches
//      to the draft an Import DBML… of it opens (its summary, before anything is written; none of
//      its tables is in the library), and back.
//   3. "Hover to trace relationships": the pointer rests on fct_order, then on dim_customer, and the
//      canvas does what the product's hover preview does (HOVER): the table's own lines light in the
//      diagram's layer colour and carry the moving arrows, from the `1` end to the `*` end, and every
//      table and line it does not touch fades.
//   4. "Lines: Curved or Hops": the pointer clicks the toolbar's line style switch: Hops (square
//      lines with a hop where two cross), then back to Curved (soft corners, a halo where two cross),
//      the lines drawn the way packages/renderer draws each style (ROUTE). The pointer leaves.
// A seamless loop. render(t) is pure, like the video's.
import { card, clamp, COLORS, easeInOut, easeOut, ICON, node, nodeHeight, path, pointer, seg, toolbar } from './lib.js';
import { DRAFT_NODE_W, SALES_DRAFT, activityBar, dbmlLine, draftPage, fileTree } from './editor.js';

/** The frame: a caption band (CAP_H) over the VS Code window. */
export const HERO = { w: 1440, h: 1010, fps: 12, loop: 22 };
const CAP_H = 130;
const WIN = { x: 20, y: CAP_H, w: HERO.w - 40, h: HERO.h - CAP_H - 20 };
const ACTW = 72, SIDEW = 420;
const EDX = ACTW + SIDEW;                       // editor area left, in body px
const BODYW = WIN.w - 2;

/** The Explorer rows, in VS Code's order (folders first, then names without regard to case):
 * [depth, kind, label]; depth 0 is the folder's top level. sales.dbml is the file the draft reads. */
export const HERO_TREE = [
  [0, 'folder', '.erd-studio'],
  [1, 'folder', 'main'],
  [2, 'folder', 'diagrams'],
  [3, 'dbml', 'orders.dbml'],
  [2, 'folder', 'relationships'],
  [3, 'dbml', 'main.dbml'],
  [2, 'folder', 'tables'],
  [3, 'folder', 'main'],
  [4, 'dbml', 'dim_customer.dbml'],
  [4, 'dbml', 'dim_date.dbml'],
  [4, 'dbml', 'dim_product.dbml'],
  [4, 'dbml', 'fct_order.dbml'],
  [4, 'dbml', 'fct_return.dbml'],
  [1, 'json', 'layers.json'],
  [1, 'md', 'README.md'],
  [0, 'folder', 'docs', true],   // collapsed
  [0, 'md', 'README.md'],
  [0, 'dbml', 'sales.dbml'],
];

// The orders diagram (full node scale, local coordinates; drawn scaled by CS). Laid out like an
// auto layout leaves it: dimensions left and right, the facts between, with room for the lines.
const T = [
  { name: 'dim_customer', x: 0, y: 0, cols: [['PK', 'customer_key', 'INTEGER'], [null, 'customer_id', 'VARCHAR'], [null, 'name', 'VARCHAR']] },
  { name: 'dim_date', x: 0, y: 640, cols: [['PK', 'date_key', 'INTEGER'], [null, 'date_day', 'DATE'], [null, 'month_name', 'VARCHAR']] },
  { name: 'fct_order', x: 520, y: 170, cols: [['PK', 'order_id', 'INTEGER'], ['FK', 'customer_key', 'INTEGER'], ['FK', 'date_key', 'INTEGER'], ['FK', 'product_key', 'INTEGER'], [null, 'amount', 'DECIMAL(18,2)']] },
  { name: 'dim_product', x: 1040, y: 0, cols: [['PK', 'product_key', 'INTEGER'], [null, 'product_name', 'VARCHAR'], [null, 'price', 'DECIMAL(10,2)']] },
  { name: 'fct_return', x: 1040, y: 540, cols: [['PK', 'return_id', 'INTEGER'], ['FK', 'order_id', 'INTEGER'], ['FK', 'date_key', 'INTEGER'], [null, 'refunded', 'DECIMAL(18,2)']] },
];
const NW = 350;
const tableOf = (name) => T.find((tb) => tb.name === name);
/** The canvas: local coordinates drawn at CS from (CX, CY) in body px. One body px is one flow px. */
const CX = EDX + 24, CY = 104, CS = 0.62;
/** Which tree row is which table (the files light in this order: fct_order last, its text shows). */
const FILE_ROW = { dim_customer: 8, dim_date: 9, dim_product: 10, fct_return: 12, fct_order: 11 };

const SALES_ROW = 17;
/** fct_order.dbml as ERD Studio writes it (formatDbml aligns the types; `npm test` checks it). */
export const FCT_DBML = [
  'Table main.fct_order {',
  '  order_id     INTEGER [pk]',
  "  customer_key INTEGER [foreign_key: 'true']",
  "  date_key     INTEGER [foreign_key: 'true']",
  "  product_key  INTEGER [foreign_key: 'true']",
  '  amount       "DECIMAL(18,2)"',
  '}',
];

// ---- The loop -----------------------------------------------------------------------------------
// files light 0.5–3.2 s, fct_order.dbml's text 3.2–6.0 s, the draft 6.4–10.2 s, the hover
// 10.6–14.8 s, the line styles 14.8–20.4 s, then the plain Curved canvas into the seam.
const LIGHT0 = 0.5, LIGHT_STEP = 0.55;
const CODE_IN = 3.2, CODE_OUT = 6.0;
const DRAFT_IN = 6.4, DRAFT_OUT = 10.2;

/** One caption per beat, ≤ 5 words, from `at` (the first also runs into the seam); `em` is lit in blue. */
export const CAPTIONS = [
  { at: 0, text: 'Your model, as DBML files', em: 'DBML files' },
  { at: 6.2, text: 'Import what you have', em: 'Import' },
  { at: 10.4, text: 'Hover to trace relationships', em: 'Hover' },
  { at: 14.9, text: 'Lines: Curved or Hops', em: 'Curved or Hops' },
  { at: 21.2, text: 'Your model, as DBML files', em: 'DBML files' },
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

// ---- The lines, routed and drawn as packages/renderer draws them --------------------------------
// (`npm test` checks every number here against the renderer's source.)
//   - The router (EdgeRouting) takes every line around the tables, orthogonally; a line meets a table
//     at a side slot (not a column row), stops PATH_GAP px short of it, and its `*` / `1` sits
//     LABEL_OFFSET px from the card. The polylines below are what it leaves for this layout.
//   - lineStyle.ts LINE_STYLE_OPTIONS: Curved = curved corners + a halo where lines cross; Hops =
//     rounded corners + a hop where lines cross. Neither line here passes under a table.
//   - corners.ts: rounded corners up to 8 px (a quadratic); curved up to 40 px each way (a cubic
//     quarter, KAPPA), the stub segments given wholly to their corner (less 4 px), at most 2:1, and
//     shrunk to keep 6 px from a card.
//   - pathRender.ts: at a crossing the more horizontal line is "over". Hops: the over line jumps the
//     under one with a semicircle (two cubics); Curved: every line has a casing (7 px, the canvas
//     colour) and the under line is cut 4.5 px either side. A treatment keeps 3 px from a corner and
//     4 px from the line's ends, and goes to the other line when it has no room.
//   - FkEdge.css: lines 2 px, 2.5 px while their table is hovered. Drawn here 1.25× (as the
//     rest of this frame), and the hops and arrows sized as the product sizes them at 50 % zoom
//     (hopRadiusFor(0.5), glyphScaleForZoom(0.5)), so they read at the README's 800 px.
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

/** Flow px of a table's box. */
const RECTS = T.map((tb) => ({ id: tb.name, x: tb.x * CS, y: tb.y * CS, w: NW * CS, h: nodeHeight(tb.cols.length, false) * CS }));
/** A point on a table's side: `at` 0..1 along it. */
function anchor(rects, name, side, at) {
  const r = rects.find((x) => x.id === name);
  if (side === 'left' || side === 'right') return { x: side === 'left' ? r.x : r.x + r.w, y: r.y + r.h * at, side };
  return { x: r.x + r.w * at, y: side === 'top' ? r.y : r.y + r.h, side };
}
const OUT = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const push = (a, d) => ({ x: a.x + OUT[a.side][0] * d, y: a.y + OUT[a.side][1] * d });

/**
 * The relationships: each from the FK table (`*`, the path's start) to the key's table (`1`), with
 * the router's channel x for the line's vertical run. Many-to-one: the arrows run against the path.
 */
const RELS = [
  { from: ['fct_order', 'left', 0.37], to: ['dim_customer', 'right', 0.5], via: 270 },
  { from: ['fct_order', 'left', 0.78], to: ['dim_date', 'right', 0.62], via: 270 },
  { from: ['fct_order', 'right', 0.78], to: ['dim_product', 'left', 0.5], via: 584 },
  { from: ['fct_return', 'left', 0.28], to: ['fct_order', 'right', 0.3], via: 614 },
  { from: ['fct_return', 'left', 0.58], to: ['dim_date', 'right', 0], via: null },   // straight across, level with its start
];
const buildLines = (rels, rects) => rels.map((r) => {
  const [fn, fs, fa] = r.from;
  const [tn, ts, ta] = r.to;
  const sa = anchor(rects, fn, fs, fa), ea = anchor(rects, tn, ts, ta);
  if (r.via === null) ea.y = sa.y;
  const s = push(sa, ROUTE.pathGap), e = push(ea, ROUTE.pathGap);
  const pts = r.via === null ? [s, e] : [s, { x: r.via, y: s.y }, { x: r.via, y: e.y }, e];
  return { id: `${fn}-${tn}`, from: fn, to: tn, cardinality: 'many-to-one', pts, many: push(sa, ROUTE.labelOffset), one: push(ea, ROUTE.labelOffset) };
});
export const LINES = buildLines(RELS, RECTS);

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
/** Each style's drawn lines, worked out once. */
export const DRAWN = { curved: renderLines('curved'), hops: renderLines('hops') };

/**
 * The draft page's diagram (Import DBML…'s draft of sales.dbml) is the same renderer in a read-only
 * canvas, so it draws Curved lines too: SALES_DRAFT's tables (editor.js, DRAFT_NODE_W wide, drawn at
 * DRAFT_SCALE), routed around its cards. Its relationships are SALES_DRAFT.rels, in that order.
 */
const DRAFT_SCALE = 0.6;
const DRAFT_RECTS = SALES_DRAFT.tables.map((tb) => ({ id: tb.name, x: tb.x * DRAFT_SCALE, y: tb.y * DRAFT_SCALE, w: DRAFT_NODE_W * DRAFT_SCALE, h: nodeHeight(tb.cols.length, false) * DRAFT_SCALE }));
const DRAFT_RELS = [
  { from: ['fct_sale', 'left', 0.3], to: ['dim_store', 'right', 0.5], via: 270 },
  { from: ['fct_sale', 'left', 0.75], to: ['dim_staff', 'right', 0.5], via: 270 },
  { from: ['fct_sale', 'right', 0.3], to: ['dim_calendar', 'left', 0.5], via: 594 },
  { from: ['fct_refund', 'left', 0.5], to: ['fct_sale', 'right', 0.75], via: 594 },
];
export const DRAFT_LINES = buildLines(DRAFT_RELS, DRAFT_RECTS);
export const DRAFT_DRAWN = renderLines('curved', DRAFT_LINES, DRAFT_RECTS);
/** The draft's lines, for draftPage: in its scaled diagram, so drawn at 1 / DRAFT_SCALE in flow px. */
const DRAFT_EDGES = (() => {
  let h = '';
  for (const [i, line] of DRAFT_LINES.entries()) h += drawLine(line, DRAFT_DRAWN[i], { halo: true, colour: COLORS.neutralLine, width: 2, lineOp: 1, labelOp: 1, glyphs: [] });
  return `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><g transform="scale(${(1 / DRAFT_SCALE).toFixed(4)})">${h}</g></svg>`;
})();

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

// ---- The line style switch (webview/components/Toolbar/LineStyleSwitch.tsx) ---------------------
// Curved (the default) then Hops, each a 16 px glyph: a line turning a soft corner, a line hopping
// another. The chosen one takes the button colours; the other is at 0.7 until hovered.
export const LINE_STYLES = ['curved', 'hops'];
/** Body px of each option's centre, as the toolbar lays them out (measured from a still). */
export const SWITCH_AT = { curved: { x: 790, y: 49 }, hops: { x: 832, y: 49 } };
const HOPS_CLICK = 15.95, CURVED_CLICK = 18.85, CLICK = 0.22;
/** The line style at t: Hops from the first click (mouse up) to the second. */
export const styleAt = (t) => (t >= HOPS_CLICK + CLICK && t < CURVED_CLICK + CLICK ? 'hops' : 'curved');

/** The pointer (body px): in from below the window, rests on fct_order's header, then on
 * dim_customer's, up to the toolbar's switch (Hops, then Curved), and out past the right edge. */
export const HOVER_PATH = [
  { t: 10.6, x: 1250, y: 860 }, { t: 11.3, x: 960, y: 230 }, { t: 12.9, x: 960, y: 230 },
  { t: 13.4, x: 690, y: 126 }, { t: 14.7, x: 690, y: 126 },
  { t: 15.6, x: SWITCH_AT.hops.x + 10, y: SWITCH_AT.hops.y + 9 }, { t: 18.4, x: SWITCH_AT.hops.x + 10, y: SWITCH_AT.hops.y + 9 },
  { t: 18.7, x: SWITCH_AT.curved.x + 10, y: SWITCH_AT.curved.y + 9 }, { t: 19.5, x: SWITCH_AT.curved.x + 10, y: SWITCH_AT.curved.y + 9 },
  { t: 20.4, x: 1470, y: 70 },
];
const press = (t) => (t >= HOPS_CLICK && t < HOPS_CLICK + CLICK ? (t - HOPS_CLICK) / CLICK : t >= CURVED_CLICK && t < CURVED_CLICK + CLICK ? (t - CURVED_CLICK) / CLICK : 0);

/** Body px → flow px of the canvas. */
const toFlow = (p) => ({ x: p.x - CX, y: p.y - CY });
const tableAt = (p) => { const q = toFlow(p); return RECTS.find((r) => q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h)?.id ?? null; };
/** True when the pointer is on a line's 16 px hit area (FkEdge's invisible wider path), off the tables. */
function onLine(p, li) {
  const q = toFlow(p), pts = DRAWN.curved[li].flat;
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
  const lines = LINES.filter((l) => l.from === id || l.to === id);
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
  const t0 = HOVER_PATH[0].t, t1 = HOVER_PATH.at(-1).t + 1;
  for (let k = 0; t0 + k / 240 <= t1; k++) {
    const t = t0 + k / 240;
    if (enter && t >= enter.at) { commit(enter.at, enter.id); enter = null; }
    if (leave && t >= leave.at) { commit(leave.at, null); leave = null; }
    const p = path(t, HOVER_PATH);
    const table = tableAt(p);
    // tables sit above the lines: a line under a table takes no pointer events
    const lines = new Set(table ? [] : LINES.map((l, i) => (onLine(p, i) ? l.id : null)).filter(Boolean));
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

/** The diagram's lines (in flow px, under the tables), in the style and hover state at t. */
function linesSvg(t, f) {
  const style = styleAt(t);
  const drawn = DRAWN[style];
  const halo = LINE_STYLE_OPTIONS[style].crossings === 'halo';
  let h = '';
  for (const [i, line] of LINES.entries()) {
    const on = !!f.now?.lines.has(line.id);
    h += drawLine(line, drawn[i], {
      halo,
      colour: on ? HOVER.layerColour : COLORS.neutralLine,
      width: on ? 2.5 : 2,
      lineOp: faded(t, f, (x) => (!x || x.lines.has(line.id) ? 1 : HOVER.lineOpacity)),
      labelOp: faded(t, f, (x) => (!x || x.lines.has(line.id) ? 1 : HOVER.labelOpacity)),
      glyphs: on ? flowGlyphs(drawn[i], line, t) : [],
    });
  }
  return `<svg class="abs" style="left:${CX}px;top:${CY}px;overflow:visible" width="1" height="1">${h}</svg>`;
}

function ordersCanvas(t) {
  const lit = (name) => {
    const k = Object.keys(FILE_ROW).indexOf(name);
    const at = LIGHT0 + k * LIGHT_STEP;
    const last = k === Object.keys(FILE_ROW).length - 1;
    return Math.min(easeOut(seg(t, at, at + 0.25)), 1 - seg(t, at + LIGHT_STEP, at + LIGHT_STEP + 0.3) * (last ? 0 : 1)) * (1 - seg(t, CODE_OUT, CODE_OUT + 0.3));
  };
  const f = focusAt(t);
  let inner = '';
  for (const tb of T) {
    const g = lit(tb.name);
    const shadow = g > 0
      ? `0 0 0 ${(5 * g).toFixed(1)}px rgba(96,165,250,${(0.55 * g).toFixed(3)}),`
      : f.now?.node === tb.name ? `0 0 0 ${(3 / CS).toFixed(1)}px ${HOVER.ring},` : '';
    const op = faded(t, f, (x) => (!x || x.nodes.has(tb.name) ? 1 : HOVER.tableOpacity));
    const style = `${shadow ? `box-shadow:${shadow}0 18px 44px #0009;` : ''}${op < 1 ? `opacity:${op.toFixed(3)};` : ''}`;
    inner += node({ x: tb.x, y: tb.y, w: NW, name: tb.name, cols: tb.cols.map(([key, name, type]) => ({ key: key ?? undefined, name, type })), style });
  }
  const p = path(t, HOVER_PATH);
  const overSwitch = t >= HOVER_PATH[0].t && t <= HOVER_PATH.at(-1).t
    ? LINE_STYLES.find((s) => Math.abs(p.x - SWITCH_AT[s].x) <= 20 && Math.abs(p.y - SWITCH_AT[s].y) <= 17) ?? null : null;
  let h = `<div class="abs grid-bg" style="left:${EDX}px;top:0;right:0;bottom:0;background-color:var(--card)"></div>
    ${linesSvg(t, f)}
    <div class="abs" style="left:${CX}px;top:${CY}px;transform-origin:0 0;transform:scale(${CS})">${inner}</div>
    ${toolbar({ x: EDX + 20, y: 16, logicalOnly: true, layout: 'idle', add: 'idle', lineStyle: styleAt(t), lineStyleHover: overSwitch })}`;
  // fct_order.dbml's text, bottom right
  if (t >= CODE_IN && t < CODE_OUT + 0.3) {
    const op = Math.min(1, easeOut(seg(t, CODE_IN, CODE_IN + 0.3))) * (1 - seg(t, CODE_OUT, CODE_OUT + 0.3));
    const body = FCT_DBML.map((l, i) => `<div style="display:flex;height:28px;align-items:center"><span style="width:26px;text-align:right;margin-right:16px;color:var(--line-no)">${i + 1}</span><span style="white-space:pre">${dbmlLine(l)}</span></div>`).join('');
    h += `<div class="abs" style="right:24px;bottom:22px;width:560px;border-radius:12px;background:#1b1c20;border:1px solid #3a3c42;box-shadow:0 18px 48px #000c;overflow:hidden;opacity:${op.toFixed(3)};transform:translateY(${(12 * (1 - op)).toFixed(1)}px)">
      <div style="height:40px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid #2c2c30;font-size:18px;color:var(--text-2);white-space:nowrap"><span style="color:#5ca2f8;display:flex">${ICON.file({ size: 18 })}</span>.erd-studio/main/tables/main/fct_order.dbml</div>
      <div class="mono" style="padding:8px 0 10px 4px;font-size:17px">${body}</div></div>`;
  }
  return h;
}

function explorer(t) {
  const lit = (i) => {
    if (i === SALES_ROW) return easeOut(seg(t, DRAFT_IN - 0.3, DRAFT_IN)) * (1 - seg(t, DRAFT_OUT, DRAFT_OUT + 0.35));
    const names = Object.keys(FILE_ROW);
    const k = names.findIndex((n) => FILE_ROW[n] === i);
    if (k < 0) return 0;
    const at = LIGHT0 + k * LIGHT_STEP;
    return Math.min(easeOut(seg(t, at, at + 0.25)), 1 - seg(t, at + LIGHT_STEP, at + LIGHT_STEP + 0.3) * (k < names.length - 1 ? 1 : 0)) * (1 - seg(t, CODE_OUT, CODE_OUT + 0.3));
  };
  return `<div class="abs" style="left:${ACTW}px;top:0;width:${SIDEW}px;bottom:0;background:#16181b;border-right:1px solid var(--card-border)">
    <div class="abs" style="left:22px;top:16px;font-size:18px;font-weight:700;letter-spacing:.08em;color:var(--text-2)">EXPLORER</div>
    <div class="abs" style="left:14px;top:50px;display:flex;align-items:center;gap:6px;font-size:19px;font-weight:800;letter-spacing:.04em">${ICON.chevDown({ size: 18 })}SHOP-ANALYTICS</div>
    <div class="abs" style="left:10px;top:0;right:0;bottom:0">${fileTree(HERO_TREE, { top: 84, rowH: 38, width: SIDEW - 10, indent: 24, font: 20, lit })}</div></div>`;
}

export function render(t) {
  t = ((t % HERO.loop) + HERO.loop) % HERO.loop;
  const d = easeOut(seg(t, DRAFT_IN, DRAFT_IN + 0.35)) * (1 - seg(t, DRAFT_OUT, DRAFT_OUT + 0.35));
  let body = ordersCanvas(t);
  if (d > 0) body += draftPage(SALES_DRAFT, { left: EDX, width: BODYW - EDX, op: d, glow: easeOut(seg(t, DRAFT_IN + 1.2, DRAFT_IN + 1.6)), scale: DRAFT_SCALE, font: 16, edges: DRAFT_EDGES }).html;
  body += explorer(t) + activityBar('files');
  // the pointer, on top of everything (the window clips it as it comes in and goes out)
  if (t >= HOVER_PATH[0].t && t <= HOVER_PATH.at(-1).t) {
    const p = path(t, HOVER_PATH);
    body += pointer(p.x, p.y, press(t));
  }
  const tabs = [{ label: 'orders.dbml', on: d < 0.5 }];
  if (d > 0) tabs.push({ label: SALES_DRAFT.tab, on: d >= 0.5 });
  return `<div class="abs" style="left:0;top:0;width:${HERO.w}px;height:${CAP_H}px">${captionBand(t)}</div>`
    + card({ ...WIN, tabs, crumb: d < 0.5 ? '.erd-studio › main › diagrams › orders.dbml' : 'shop-analytics', body });
}

if (typeof document !== 'undefined') {
  const stage = document.getElementById('stage');
  let last = '';
  window.render = (t) => { const h = render(t); if (h !== last) { stage.innerHTML = h; last = h; } };
  window.HERO = HERO;
  window.render(0);
  window.__ready = true;
}
