// The README's hero GIF (media/demo.gif), drawn by ../hero-gif.mjs from player/hero.html with the
// video's own pieces (editor.js, lib.js): ERD Studio in a plain folder (no
// stage tabs, nothing to compare), the Explorer showing the layer-first .erd-studio tree beside the
// orders diagram, a fct_order star schema with its keys, drawn neutral (a plain folder has no
// stage colours). The table files light one by one with their tables, fct_order.dbml's text
// shows, then sales.dbml (in the folder's top level) lights and the editor switches to the draft an
// Import DBML… of it opens (its summary, before anything is written; none of its tables is in the
// library), and back. Then the pointer rests on fct_order and on dim_customer, and the canvas does
// what the product's hover preview does (see HOVER below): the table's own lines light in the
// diagram's layer colour and carry the moving arrows, from the `1` end to the `*` end, and every
// table and line it does not touch fades. The pointer leaves: a seamless loop.
// render(t) is pure, like the video's.
import { card, clamp, COLORS, easeOut, ICON, node, nodeHeight, path, pointer, seg, toolbar } from './lib.js';
import { SALES_DRAFT, activityBar, dbmlLine, draftPage, fileTree } from './editor.js';

export const HERO = { w: 1440, h: 900, fps: 12, loop: 16 };
const WIN = { x: 20, y: 20, w: HERO.w - 40, h: HERO.h - 40 };
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
  [1, 'json', 'layers.json'],
  [1, 'md', 'README.md'],
  [0, 'folder', 'docs', true],   // collapsed
  [0, 'md', 'README.md'],
  [0, 'dbml', 'sales.dbml'],
];

// The orders star (full node scale, local coordinates; drawn scaled).
const T = [
  { name: 'dim_customer', x: 0, y: 0, cols: [['PK', 'customer_key', 'INTEGER'], [null, 'customer_id', 'VARCHAR'], [null, 'name', 'VARCHAR']] },
  { name: 'dim_date', x: 0, y: 420, cols: [['PK', 'date_key', 'INTEGER'], [null, 'date_day', 'DATE'], [null, 'month_name', 'VARCHAR']] },
  { name: 'dim_product', x: 940, y: 210, cols: [['PK', 'product_key', 'INTEGER'], [null, 'product_name', 'VARCHAR'], [null, 'price', 'DECIMAL(10,2)']] },
  { name: 'fct_order', x: 470, y: 170, cols: [['PK', 'order_id', 'INTEGER'], ['FK', 'customer_key', 'INTEGER'], ['FK', 'date_key', 'INTEGER'], ['FK', 'product_key', 'INTEGER'], [null, 'amount', 'DECIMAL(18,2)']] },
];
const NW = 400;
const rowY = (top, i) => top + 62 + i * 46 + 23;
/** The canvas: local coordinates drawn at CS from (CX, CY) in body px. One body px is one flow px. */
const CX = EDX + 40, CY = 120, CS = 0.62;
/** [fct_order row, dimension index] */
const RELS = [[1, 0], [2, 1], [3, 2]];
/** Which tree row is which table (the files light in this order). */
const FILE_ROW = { dim_customer: 8, dim_date: 9, dim_product: 10, fct_order: 11 };

const SALES_ROW = 16;
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
// The loop: files light 0.6–4.0 s, fct_order.dbml's text 3.35–6.0 s, the draft 6.4–10.2 s, the
// hover 10.6–15.4 s (HOVER_PATH), and 0.6 s of the plain canvas either side of the seam.
const LIGHT0 = 0.6, LIGHT_STEP = 0.85;
const CODE_IN = 3.35, CODE_OUT = 6.0;
const DRAFT_IN = 6.4, DRAFT_OUT = 10.2;

// ---- The hover preview, as packages/renderer draws it in a plain folder -----------------------
// (`npm test` checks every number here against the renderer's source.)
//   - hoverIntent.ts: a table becomes the focus 120 ms after the pointer comes to rest on it, 60 ms
//     when switching from another table; leaving clears it after 150 ms, unless the pointer is on
//     one of the focus's lines (useHoverFocus.ts: following a bright line off the table keeps it).
//   - canvasFocus.ts (`ownLinesOnly`): the table, every table one line away and the table's own
//     lines stay bright; ModelNode.css / FkEdge.css fade the other tables to 0.22, the other lines
//     to 0.15 and their `*` / `1` to 0.2, over 0.15 s. The hovered table gets a 3 px ring in the
//     neutral ring colour (no blue: a plain folder's canvas has no stage colours).
//   - EdgeRouting.css "Colour on hover": the focused lines, their `*` / `1` and their arrows take
//     the diagram's layer colour (Main: layerService.ts #6366f1); the lines go 2 → 2.5 px. Colour
//     and width change at once (only opacity is transitioned).
//   - edgeFlow.ts / EdgeFlow.tsx: the arrows. Each line's path runs from fct_order (the FK, `*`
//     end) to the dimension (`1` end); many-to-one is `reverse`, so the chevrons travel from the
//     dimension into fct_order. 56 px/s, one per 90 px (2–4), each fading in and out over the
//     first and last 10 % of its pass, a filled notched chevron with a halo in the canvas colour.
export const HOVER = {
  enterDelay: 0.12, switchDelay: 0.06, leaveGrace: 0.15, fade: 0.15,
  tableOpacity: 0.22, lineOpacity: 0.15, labelOpacity: 0.2,
  layerColour: '#6366f1', ring: 'rgba(138,148,163,0.3)',
};
export const FLOW = { speed: 56, spacing: 90, minGlyphs: 2, maxGlyphs: 4, minDur: 1.6, maxDur: 7, durBucket: 0.5 };
/** EdgeFlow.tsx CHEVRON_D: 8 × 9 flow px, pointing along +x. */
export const CHEVRON_D = 'M -4,-4.5 L 4,0 L -4,4.5 L -1.75,0 Z';
/** Glyph size factor, as EdgeFlow scales them up on a zoomed-out canvas (the README shows the GIF at 800 px). */
const GLYPH_SCALE = 2;
/** The pointer (body px): in from below the window, rests on fct_order's header, then on
 * dim_customer's, then out past the right edge, clear of the other tables. */
export const HOVER_PATH = [
  { t: 10.6, x: 1250, y: 840 }, { t: 11.3, x: 966, y: 248 }, { t: 13.0, x: 966, y: 248 },
  { t: 13.5, x: 693, y: 142 }, { t: 14.9, x: 693, y: 142 }, { t: 15.4, x: 1470, y: 176 },
];

/** The lines: the path from fct_order's FK row to the dimension's key, with its end labels. */
export const LINES = RELS.map(([fr, d]) => {
  const f = T[3], D = T[d];
  const right = D.x > f.x;
  const x0 = right ? f.x + NW : f.x, x1 = right ? D.x : D.x + NW;
  const y0 = rowY(f.y, fr), y1 = rowY(D.y, 0), mx = (x0 + x1) / 2;
  const pts = [[x0, y0], [mx, y0], [mx, y1], [x1, y1]];
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return {
    id: D.name, from: f.name, to: D.name, cardinality: 'many-to-one', pts, len,
    many: right ? [x0 + 8, y0 - 10] : [x0 - 26, y0 - 10], one: right ? [x1 - 22, y1 - 12] : [x1 + 10, y1 - 12],
  };
});

/** flowModeFor (edgeFlow.ts): one-to-many runs with the path, many-to-one against it. */
const flowMode = (cardinality) => (cardinality === 'one-to-many' ? 'forward' : 'reverse');

/** planEdgeFlow's moving chevrons for one line: [{ at: 0..1 along the path, opacity, reverse }] at t. */
export function flowGlyphs(line, t) {
  const flowLen = Math.round((line.len * CS) / 8) * 8;   // EdgeFlow buckets the measured length
  const dur = clamp(Math.round(flowLen / FLOW.speed / FLOW.durBucket) * FLOW.durBucket, FLOW.minDur, FLOW.maxDur);
  const n = clamp(Math.round(flowLen / FLOW.spacing), FLOW.minGlyphs, FLOW.maxGlyphs);
  const reverse = flowMode(line.cardinality) === 'reverse';
  const out = [];
  for (let i = 0; i < n; i++) {
    // begin = -(i·dur/n): glyph i runs i/n of a pass ahead; keyPoints 0;1 or 1;0, opacity 0;1;1;0 at 0;.1;.9;1
    const p = ((((t + (i * dur) / n) / dur) % 1) + 1) % 1;
    out.push({ at: reverse ? 1 - p : p, opacity: Math.min(1, p / 0.1, (1 - p) / 0.1), reverse });
  }
  return out;
}

/** The point `at` (0..1) along a polyline, and the direction of the path there in degrees. */
function poseAt(pts, len, at) {
  let d = at * len;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const l = Math.hypot(bx - ax, by - ay);
    if (d <= l || i === pts.length - 1) {
      const k = l ? Math.min(1, d / l) : 0;
      return { x: ax + (bx - ax) * k, y: ay + (by - ay) * k, angle: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI };
    }
    d -= l;
  }
  return { x: pts[0][0], y: pts[0][1], angle: 0 };
}

const toBody = ([x, y]) => [CX + x * CS, CY + y * CS];
const RECTS = T.map((tb) => ({ id: tb.name, x0: CX + tb.x * CS, y0: CY + tb.y * CS, x1: CX + (tb.x + NW) * CS, y1: CY + (tb.y + nodeHeight(tb.cols.length, false)) * CS }));
/** The table under the pointer, if any. */
const tableAt = (p) => RECTS.find((r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1)?.id ?? null;
/** True when the pointer is on a line's 16 px hit area (FkEdge's invisible wider path), off the tables. */
function onLine(p, line) {
  const pts = line.pts.map(toBody);
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const k = l2 ? clamp(((p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay)) / l2) : 0;
    if (Math.hypot(p.x - (ax + k * (bx - ax)), p.y - (ay + k * (by - ay))) <= 8) return true;
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
    const lines = new Set(table ? [] : LINES.filter((l) => onLine(p, l)).map((l) => l.id));
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

/** One relationship line: path, `*` / `1`, and (while flowing) its chevrons. */
function relLine(line, { colour, width, lineOp, labelOp, glyphs }) {
  const d = line.pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  const k = GLYPH_SCALE / CS;   // flow px → local units
  const chevrons = glyphs.map((g) => {
    const pose = poseAt(line.pts, line.len, g.at);
    return `<g transform="translate(${pose.x.toFixed(2)} ${pose.y.toFixed(2)}) rotate(${(pose.angle + (g.reverse ? 180 : 0)).toFixed(1)}) scale(${k.toFixed(3)})" opacity="${g.opacity.toFixed(3)}"><path d="${CHEVRON_D}" fill="${colour}" stroke="var(--card)" stroke-width="1.5" paint-order="stroke fill" stroke-linejoin="round"/></g>`;
  }).join('');
  const label = (txt, [x, y], size) => `<text x="${x}" y="${y}" fill="${colour}" font-size="${size}" font-weight="800" font-family="JetBrains Mono" opacity="${labelOp.toFixed(3)}">${txt}</text>`;
  return `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><path d="${d}" fill="none" stroke="${colour}" stroke-width="${width}" stroke-linejoin="round" opacity="${lineOp.toFixed(3)}"/>${chevrons}${label('1', line.one, 24)}${label('*', line.many, 28)}</svg>`;
}

function ordersCanvas(t) {
  const lit = (name) => {
    const k = Object.keys(FILE_ROW).indexOf(name);
    const at = LIGHT0 + k * LIGHT_STEP;
    return Math.min(easeOut(seg(t, at, at + 0.25)), 1 - seg(t, at + LIGHT_STEP, at + LIGHT_STEP + 0.3) * (k < 3 ? 1 : 0)) * (1 - seg(t, CODE_OUT, CODE_OUT + 0.3));
  };
  const f = focusAt(t);
  const fc = f.now;
  let inner = '';
  for (const line of LINES) {
    const on = !!fc?.lines.has(line.id);
    inner += relLine(line, {
      colour: on ? HOVER.layerColour : COLORS.neutralLine,
      width: on ? 5 : 4,   // 2 → 2.5 flow px, drawn at 1/0.62 × 1.25 like the rest of the canvas
      lineOp: faded(t, f, (x) => (!x || x.lines.has(line.id) ? 1 : HOVER.lineOpacity)),
      labelOp: faded(t, f, (x) => (!x || x.lines.has(line.id) ? 1 : HOVER.labelOpacity)),
      glyphs: on ? flowGlyphs(line, t) : [],
    });
  }
  for (const tb of T) {
    const g = lit(tb.name);
    const shadow = g > 0
      ? `0 0 0 ${(5 * g).toFixed(1)}px rgba(96,165,250,${(0.55 * g).toFixed(3)}),`
      : fc?.node === tb.name ? `0 0 0 ${(3 / CS).toFixed(1)}px ${HOVER.ring},` : '';
    const op = faded(t, f, (x) => (!x || x.nodes.has(tb.name) ? 1 : HOVER.tableOpacity));
    const style = `${shadow ? `box-shadow:${shadow}0 18px 44px #0009;` : ''}${op < 1 ? `opacity:${op.toFixed(3)};` : ''}`;
    inner += node({ x: tb.x, y: tb.y, w: NW, name: tb.name, cols: tb.cols.map(([key, name, type]) => ({ key: key ?? undefined, name, type })), style });
  }
  let h = `<div class="abs grid-bg" style="left:${EDX}px;top:0;right:0;bottom:0;background-color:var(--card)"></div>
    <div class="abs" style="left:${CX}px;top:${CY}px;transform-origin:0 0;transform:scale(${CS})">${inner}</div>
    ${toolbar({ x: EDX + 20, y: 16, logicalOnly: true, layout: 'idle', add: 'idle' })}`;
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
    const k = Object.values(FILE_ROW).indexOf(i);
    if (k < 0) return 0;
    const at = LIGHT0 + k * LIGHT_STEP;
    return Math.min(easeOut(seg(t, at, at + 0.25)), 1 - seg(t, at + LIGHT_STEP, at + LIGHT_STEP + 0.3) * (k < 3 ? 1 : 0)) * (1 - seg(t, CODE_OUT, CODE_OUT + 0.3));
  };
  return `<div class="abs" style="left:${ACTW}px;top:0;width:${SIDEW}px;bottom:0;background:#16181b;border-right:1px solid var(--card-border)">
    <div class="abs" style="left:22px;top:16px;font-size:18px;font-weight:700;letter-spacing:.08em;color:var(--text-2)">EXPLORER</div>
    <div class="abs" style="left:14px;top:50px;display:flex;align-items:center;gap:6px;font-size:19px;font-weight:800;letter-spacing:.04em">${ICON.chevDown({ size: 18 })}SHOP-ANALYTICS</div>
    <div class="abs" style="left:10px;top:0;right:0;bottom:0">${fileTree(HERO_TREE, { top: 84, rowH: 39, width: SIDEW - 10, indent: 24, font: 20, lit })}</div></div>`;
}

export function render(t) {
  t = ((t % HERO.loop) + HERO.loop) % HERO.loop;
  const d = easeOut(seg(t, DRAFT_IN, DRAFT_IN + 0.35)) * (1 - seg(t, DRAFT_OUT, DRAFT_OUT + 0.35));
  let body = ordersCanvas(t);
  if (d > 0) body += draftPage(SALES_DRAFT, { left: EDX, width: BODYW - EDX, op: d, glow: easeOut(seg(t, DRAFT_IN + 1.2, DRAFT_IN + 1.6)), scale: 0.6, font: 16 }).html;
  body += explorer(t) + activityBar('files');
  // the pointer, on top of everything (the window clips it as it comes in and goes out)
  if (t >= HOVER_PATH[0].t && t <= HOVER_PATH.at(-1).t) {
    const p = path(t, HOVER_PATH);
    body += pointer(p.x, p.y);
  }
  const tabs = [{ label: 'orders.dbml', on: d < 0.5 }];
  if (d > 0) tabs.push({ label: SALES_DRAFT.tab, on: d >= 0.5 });
  const html = card({ ...WIN, tabs, crumb: d < 0.5 ? '.erd-studio › main › diagrams › orders.dbml' : 'shop-analytics', body });
  return html;
}

if (typeof document !== 'undefined') {
  const stage = document.getElementById('stage');
  let last = '';
  window.render = (t) => { const h = render(t); if (h !== last) { stage.innerHTML = h; last = h; } };
  window.HERO = HERO;
  window.render(0);
  window.__ready = true;
}
