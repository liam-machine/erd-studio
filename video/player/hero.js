// The README's hero GIF (media/demo.gif), drawn by ../hero-gif.mjs from player/hero.html with the
// video's own pieces (editor.js, lib.js). One project, one change, followed from the code to the
// business: shop-analytics, a dbt project whose design lives beside its SQL as DBML files, under a
// caption band that says one short thing per beat (CAPTIONS):
//   1. "Your model, as DBML files": the Explorer's .erd-studio tree beside the orders diagram; the
//      table files light one by one with their tables, then fct_order.dbml's text shows.
//   2. "Import what you have": the Explorer scrolls to sales.dbml and the editor switches to the
//      draft an Import DBML… of it opens (its summary, before anything is written), and back.
//   3. "The SQL changes": in models/, a new dim_store.sql and a store_key in fct_order.sql (its
//      diff shows). "Compare it with dbt": the pointer clicks Compare with dbt, and the canvas marks
//      what dbt has and the design lacks, the way packages/renderer draws it: store_key as a ghost
//      row under "only in physical", and the comparison panel's counts. It clicks Stop comparing.
//   4. "Your AI updates the model": Claude Code in the terminal is asked, in plain words, to bring
//      the design in line; it loads the erd-studio skill and edits the DBML files; the new table and
//      its relationship land on the canvas. "Design and SQL, in sync": Compare with dbt again, and
//      the panel says All matched.
//   5. "Business reads it in Confluence": a Confluence page carrying a real render of the same
//      files, as ERD Studio for Confluence draws them from GitHub.
// Beats 3 and 4 are staged from a real run (record/heroRun.mjs → record/hero-run.json): the SQL
// change, the comparison's results before and after, the prompt, the files Claude Code wrote and
// where it put the table are that run's, and `npm test` checks them against its record.
// A seamless loop. render(t) is pure, like the video's.
import { appIcon, card, caret, COLORS, easeInOut, easeOut, esc, ICON, node, nodeHeight, path, pointer, seg, toolbar, typed } from './lib.js';
import { DRAFT_NODE_W, SALES_DRAFT, activityBar, dbmlLine, draftPage, fileTree } from './editor.js';

/** The frame: a caption band (CAP_H) over the VS Code window. */
export const HERO = { w: 1440, h: 1010, fps: 12, loop: 26 };
const CAP_H = 130;
const WIN = { x: 20, y: CAP_H, w: HERO.w - 40, h: HERO.h - CAP_H - 20 };
const ACTW = 72, SIDEW = 420;
const EDX = ACTW + SIDEW;                       // editor area left, in body px
const BODYW = WIN.w - 2, BODYH = WIN.h - 66;    // the window's body (card border, 64 px head)

// ---- The loop -----------------------------------------------------------------------------------
const LIGHT0 = 0.4, LIGHT_STEP = 0.45;          // the table files light, one by one
const CODE_IN = 2.5, CODE_OUT = 4.0;            // fct_order.dbml's text
const SCROLL_AT = 4.2;                          // the Explorer scrolls down to the rest of the folder
const DRAFT_IN = 4.7, DRAFT_OUT = 7.5;          // Import DBML…'s draft of sales.dbml
/** The dbt side changes: dim_store.sql appears, fct_order.sql gains store_key. Its diff shows until SQL_CARD_OUT. */
export const SQL_AT = 8.1;
const SQL_CARD_OUT = 10.3;
const CLICK = 0.22;
/**
 * The pointer's three presses of the toolbar's Compare button: Compare with dbt (the difference
 * shows), Stop comparing (before the terminal opens), and Compare with dbt again once Claude Code
 * is done (All matched). Each takes effect as the mouse comes up.
 */
export const COMPARE_CLICKS = [10.6, 13.1, 19.3];
const [COMPARE_ON, COMPARE_OFF, COMPARE_AGAIN] = COMPARE_CLICKS.map((c) => c + CLICK);
const MARK_AT = COMPARE_ON + 0.1;
/**
 * The Confluence page covers the window from CONF_IN to CONF_OUT; behind it, at RESET_AT, the project
 * goes back to its start. Both are cuts, like the draft's tab: a cross-fade of the whole window
 * costs the GIF more bytes than a beat does.
 */
const CONF_IN = 21, RESET_AT = CONF_IN, CONF_OUT = 25.2;

/** One caption per beat, ≤ 5 words, from `at` (the first also runs into the seam); `em` is lit in blue. */
export const CAPTIONS = [
  { at: 0, text: 'Your model, as DBML files', em: 'DBML files' },
  { at: 4.2, text: 'Import what you have', em: 'Import' },
  { at: 7.9, text: 'The SQL changes', em: 'SQL' },
  { at: 10.3, text: 'Compare it with dbt', em: 'Compare' },
  { at: 13.6, text: 'Your AI updates the model', em: 'AI' },
  { at: 19.3, text: 'Design and SQL, in sync', em: 'in sync' },
  { at: 21, text: 'Business reads it in Confluence', em: 'Confluence' },
  { at: 25.2, text: 'Your model, as DBML files', em: 'DBML files' },
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
/** What Claude Code was asked, word for word (record/heroRun.mjs PROMPT). */
export const AI_PROMPT = 'dbt has a new dim_store model. Add it to the orders diagram and link fct_order to it.';
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
/** The table it added (its dim_store.dbml) and where its diagram edit put it (erd_layout), and the key it added to fct_order, after product_key. */
export const AI_TABLE = { name: 'dim_store', x: 520, y: 640, cols: [['PK', 'store_key', 'INTEGER'], [null, 'store_name', 'VARCHAR'], [null, 'city', 'VARCHAR']] };
export const AI_COLUMN = { table: 'fct_order', after: 'product_key', col: ['FK', 'store_key', 'INTEGER'] };
/** The comparison (the CLI's diff, which shares the canvas's code): before the AI's edit, and after. */
export const COMPARED = {
  sqlChanged: { matched: 5, colDiffs: 1, table: 'fct_order', column: 'store_key', type: 'integer' },
  afterAi: { matched: 6 },
};
/** models/fct_order.sql after the SQL change, whole; `added` is the line the change added. */
export const SQL_CARD = {
  path: 'models/fct_order.sql',
  lines: ['select', '    order_id,', '    customer_key,', '    date_key,', '    product_key,', '    store_key,', '    amount', "from {{ source('shop', 'orders') }}"],
  added: 5,
};
/** The AI beat's clock: the terminal opens, the prompt is typed, each step lands, the canvas follows the last. */
export const AI = { open: 13.8, type: 14.2, cps: 50, steps: [16.1, 16.55, 16.95, 17.35, 17.75], done: 18.15, close: 18.85 };

/** Where the project is at t: in step with dbt, the SQL ahead of the design, or the design brought in line. */
export const phaseAt = (t) => (t < SQL_AT || t >= RESET_AT ? 'inStep' : t < AI.done ? 'sqlChanged' : 'afterAi');
export const comparingAt = (t) => (t >= COMPARE_ON && t < COMPARE_OFF) || (t >= COMPARE_AGAIN && t < RESET_AT);

// ---- The Explorer ---------------------------------------------------------------------------------
/**
 * The folder's rows, in VS Code's order (folders first, then names without regard to case):
 * [depth, kind, label, closed?, id]; depth 0 is the folder's top level. `sql`: the dbt change has
 * landed (dim_store.sql); `store`: Claude Code has written dim_store.dbml. The folder is the one
 * record/heroRun.mjs makes: .claude holds the helper's skill, logs and target are dbt's.
 */
export function heroTree({ sql = false, store = false } = {}) {
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
    [0, 'folder', 'logs', true, 'logs'],
    f(0, 'folder', 'models'),
    f(1, 'sql', 'dim_customer.sql', 'm:dim_customer'),
    f(1, 'sql', 'dim_date.sql', 'm:dim_date'),
    f(1, 'sql', 'dim_product.sql', 'm:dim_product'),
    ...(sql ? [f(1, 'sql', 'dim_store.sql', 'm:dim_store')] : []),
    f(1, 'sql', 'fct_order.sql', 'm:fct_order'),
    f(1, 'sql', 'fct_return.sql', 'm:fct_return'),
    f(1, 'yml', 'schema.yml', 'm:schema'),
    f(1, 'yml', 'sources.yml', 'm:sources'),
    [0, 'folder', 'target', true, 'target'],
    f(0, 'other', '.gitignore'),
    f(0, 'yml', 'dbt_project.yml'),
    f(0, 'yml', 'profiles.yml'),
    f(0, 'md', 'README.md'),
    f(0, 'dbml', 'sales.dbml', 'sales'),
  ];
}
/** The folder at the loop's start. */
export const HERO_TREE = heroTree();
const ROW_H = 33, TREE_TOP = 84;
/** Rows scrolled off the top once the Explorer has scrolled down (sales.dbml, models/ and the table files all in view). */
const SCROLL_ROWS = HERO_TREE.length - Math.floor((BODYH - TREE_TOP) / ROW_H);
/** When Claude Code's Write of dim_store.dbml lands (its row appears). */
const STORE_FILE_AT = AI.steps[4] + 0.25;
/** Source Control's letters: what the SQL change and then Claude Code left uncommitted ([id, letter, from]). */
const GIT = [
  ['m:dim_store', 'U', SQL_AT], ['m:fct_order', 'M', SQL_AT], ['m:schema', 'M', SQL_AT], ['m:sources', 'M', SQL_AT],
  ['t:fct_order', 'M', AI.steps[1] + 0.25], ['rels', 'M', AI.steps[2] + 0.25], ['diagram', 'M', AI.steps[3] + 0.25], ['t:dim_store', 'U', STORE_FILE_AT],
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
/** The tables once Claude Code's edits are in: fct_order with its new key, and dim_store. */
const T_AFTER = [
  ...T.map((tb) => {
    if (tb.name !== AI_COLUMN.table) return tb;
    const at = tb.cols.findIndex(([, n]) => n === AI_COLUMN.after) + 1;
    return { ...tb, cols: [...tb.cols.slice(0, at), AI_COLUMN.col, ...tb.cols.slice(at)] };
  }),
  AI_TABLE,
];
const NW = 350;
/** The canvas: local coordinates drawn at CS from (CX, CY) in body px, below the toolbar and its stage tabs. One body px is one flow px. */
const CX = EDX + 24, CY = 152, CS = 0.62;
/** The table files, in the order they light (fct_order last: its text shows). */
const FILE_ORDER = ['dim_customer', 'dim_date', 'dim_product', 'fct_return', 'fct_order'];

/** fct_order.dbml as ERD Studio writes it, before the change (formatDbml aligns the types; `npm test` checks it). */
export const FCT_DBML = [
  'Table main.fct_order {',
  '  order_id     INTEGER [pk]',
  "  customer_key INTEGER [foreign_key: 'true']",
  "  date_key     INTEGER [foreign_key: 'true']",
  "  product_key  INTEGER [foreign_key: 'true']",
  '  amount       "DECIMAL(18,2)"',
  '}',
];

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
//   - FkEdge.css: lines 2 px, in the stage's colour (a dbt project's Logical stage: blue). Drawn
//     here 1.25×, as the rest of this frame.
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
const rectsOf = (tables) => tables.map((tb) => ({ id: tb.name, x: tb.x * CS, y: tb.y * CS, w: NW * CS, h: nodeHeight(tb.cols.length, false) * CS }));
const RECTS = rectsOf(T), RECTS_AFTER = rectsOf(T_AFTER);
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
 * the sides the product's router takes for this layout (the Confluence beat's real render of the
 * same files shows them: fct_order's top to dim_customer, its side to dim_product's bottom,
 * fct_return's top to fct_order, and fct_return's line to dim_date dipping under dim_store once
 * that is there). The corner points between are laid by hand in the router's manner (`mids`, flow
 * px: a number is the x of a vertical run, [x, y] a corner, a null y level with the line's start).
 */
const MID = NW * CS / 2;
const RELS = [
  { from: ['fct_order', 'top', MID], to: ['dim_customer', 'right', 64], mids: [] },
  { from: ['fct_order', 'left', 93], to: ['dim_date', 'right', 43], mids: [262] },
  { from: ['fct_order', 'right', 93], to: ['dim_product', 'bottom', MID], mids: [] },
  { from: ['fct_return', 'top', MID], to: ['fct_order', 'right', 135], mids: [] },
  { from: ['fct_return', 'left', 78], to: ['dim_date', 'right', 85], mids: [284] },
];
const RELS_AFTER = [
  ...RELS.slice(0, 4),
  { from: ['fct_return', 'left', 78], to: ['dim_date', 'right', 85], mids: [[592, null], [592, 556], [284, 556]] },
  { from: ['fct_order', 'bottom', MID], to: ['dim_store', 'top', MID], mids: [] },
];
const buildLines = (rels, rects) => rels.map((r) => {
  const [fn, fs, fa] = r.from;
  const [tn, ts, ta] = r.to;
  const sa = anchor(rects, fn, fs, fa), ea = anchor(rects, tn, ts, ta);
  const s = push(sa, ROUTE.pathGap), e = push(ea, ROUTE.pathGap);
  const pts = [s];
  const horizontal = (side) => side === 'left' || side === 'right';
  if (!r.mids.length) {
    // one corner where the two ends' directions meet (none when they face each other on one line)
    if (horizontal(fs) !== horizontal(ts)) pts.push(horizontal(fs) ? { x: e.x, y: s.y } : { x: s.x, y: e.y });
  } else if (typeof r.mids[0] === 'number') {
    pts.push({ x: r.mids[0], y: s.y }, { x: r.mids[0], y: e.y });
  } else {
    for (const [x, y] of r.mids) pts.push({ x, y: y ?? s.y });   // null: level with the line's start
    pts.push({ x: pts.at(-1).x, y: e.y });
  }
  pts.push(e);
  return { id: `${fn}-${tn}`, from: fn, to: tn, cardinality: 'many-to-one', pts, many: push(sa, ROUTE.labelOffset), one: push(ea, ROUTE.labelOffset) };
});
export const LINES = buildLines(RELS, RECTS);
export const LINES_AFTER = buildLines(RELS_AFTER, RECTS_AFTER);

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
/** The drawn lines, worked out once: before the change, and once Claude Code's edits are in. */
export const DRAWN = renderLines(LINE_STYLE, LINES, RECTS);
export const DRAWN_AFTER = renderLines(LINE_STYLE, LINES_AFTER, RECTS_AFTER);

/**
 * The draft page's diagram (Import DBML…'s draft of sales.dbml) is the same renderer in a read-only
 * canvas, so it draws Curved lines too: SALES_DRAFT's tables (editor.js, DRAFT_NODE_W wide, drawn at
 * DRAFT_SCALE), routed around its cards. Its relationships are SALES_DRAFT.rels, in that order.
 */
const DRAFT_SCALE = 0.6;
const DRAFT_RECTS = SALES_DRAFT.tables.map((tb) => ({ id: tb.name, x: tb.x * DRAFT_SCALE, y: tb.y * DRAFT_SCALE, w: DRAFT_NODE_W * DRAFT_SCALE, h: nodeHeight(tb.cols.length, false) * DRAFT_SCALE }));
const dh = (name, k) => DRAFT_RECTS.find((r) => r.id === name).h * k;
const DRAFT_RELS = [
  { from: ['fct_sale', 'left', dh('fct_sale', 0.3)], to: ['dim_branch', 'right', dh('dim_branch', 0.5)], mids: [270] },
  { from: ['fct_sale', 'left', dh('fct_sale', 0.75)], to: ['dim_staff', 'right', dh('dim_staff', 0.5)], mids: [270] },
  { from: ['fct_sale', 'right', dh('fct_sale', 0.3)], to: ['dim_calendar', 'left', dh('dim_calendar', 0.5)], mids: [594] },
  { from: ['fct_refund', 'left', dh('fct_refund', 0.5)], to: ['fct_sale', 'right', dh('fct_sale', 0.75)], mids: [594] },
];
export const DRAFT_LINES = buildLines(DRAFT_RELS, DRAFT_RECTS);
export const DRAFT_DRAWN = renderLines(LINE_STYLE, DRAFT_LINES, DRAFT_RECTS);

/** One relationship line as FkEdge draws it (flow px): the casing (Curved), the stroke, `*` / `1`. */
function drawLine(line, drawn, { colour, op = 1 }) {
  const stroke = drawn.strokeD ?? drawn.d;
  const label = (txt, p, size) => `<text x="${f2(p.x)}" y="${f2(p.y)}" fill="${colour}" font-size="${size}" font-weight="800" font-family="JetBrains Mono" text-anchor="middle" dominant-baseline="central">${txt}</text>`;
  return `<g opacity="${op.toFixed(3)}"><path d="${stroke}" fill="none" stroke="var(--card)" stroke-width="${ROUTE.haloWidth * STROKE_K}"/>
    <path d="${stroke}" fill="none" stroke="${colour}" stroke-width="${2 * STROKE_K}"/>${label('*', { x: line.many.x, y: line.many.y + 3 }, 24)}${label('1', line.one, 17)}</g>`;
}
/** The draft's lines, for draftPage: in its scaled diagram, so drawn at 1 / DRAFT_SCALE in flow px. */
const DRAFT_EDGES = `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><g transform="scale(${(1 / DRAFT_SCALE).toFixed(4)})">${DRAFT_LINES.map((l, i) => drawLine(l, DRAFT_DRAWN[i], { colour: COLORS.logical })).join('')}</g></svg>`;

// ---- The comparison, as the canvas draws it ----------------------------------------------------------
//   - Toolbar.tsx: the button reads "Compare with dbt", and "Stop comparing" while the overlay is on.
//   - ModelNode.tsx / .css: a column the compared stage has and this one lacks is a ghost row under
//     a dashed "only in physical" separator: its name struck through in the ghost colour, the
//     row at 0.45 and italic, dbt's type, and a "physical only" badge (both upper-cased by the CSS).
//   - DiscrepancyPanel.tsx (bottom right of the canvas): "Logical (current) vs Physical (target)",
//     ⊕ Sync while anything differs or "All matched", ×; the counts ("matched", "col diff"); then each
//     table with a difference and its columns ("Only in Physical").
/** The ghost row's ink: the product draws the row at 0.45; a little stronger here, so it survives the GIF's 800 px. */
const GHOST_INK = 0.8;
export const COMPARE = {
  separator: 'only in physical', badge: 'physical only', ghost: '#9ca3af', ghostOpacity: 0.45,
  title: ['Logical', '(current)', 'vs', 'Physical', '(target)'], sync: 'Sync', allMatched: 'All matched',
  matched: 'matched', colDiff: 'col diff', onlyIn: 'Only in Physical',
};
/** The Compare button's centre in body px (measured from a still: re-measure if the toolbar changes). */
export const COMPARE_AT = { x: 977, y: 49 };
const ON_BUTTON = { x: COMPARE_AT.x + 12, y: COMPARE_AT.y + 8 }, PARKED = { x: 1108, y: 302 }, OFF_RIGHT = { x: 1470, y: 250 };
/**
 * The pointer (body px), in two visits: in from below the window to the Compare button, its click,
 * a rest clear of the tables while the difference is read, Stop comparing, and out past the right
 * edge; then back in for the last Compare with dbt, and out again.
 */
export const POINTER = [
  [{ t: 9.6, x: 1250, y: 860 }, { t: COMPARE_CLICKS[0] - 0.15, ...ON_BUTTON }, { t: COMPARE_CLICKS[0] + 0.45, ...ON_BUTTON },
    { t: 11.5, ...PARKED }, { t: 12.5, ...PARKED }, { t: COMPARE_CLICKS[1] - 0.12, ...ON_BUTTON }, { t: COMPARE_CLICKS[1] + 0.4, ...ON_BUTTON }, { t: 14.1, ...OFF_RIGHT }],
  [{ t: 18.6, ...OFF_RIGHT }, { t: COMPARE_CLICKS[2] - 0.12, ...ON_BUTTON }, { t: COMPARE_CLICKS[2] + 0.45, ...ON_BUTTON }, { t: 20.4, ...OFF_RIGHT }],
];
const press = (t) => { const c = COMPARE_CLICKS.find((x) => t >= x && t < x + CLICK); return c === undefined ? 0 : (t - c) / CLICK; };

/** The canvas's lines at t (flow px, under the tables). */
function linesSvg(t) {
  const after = phaseAt(t) === 'afterAi';
  const lines = after ? LINES_AFTER : LINES, drawn = after ? DRAWN_AFTER : DRAWN;
  const fresh = easeOut(seg(t, AI.done, AI.done + 0.4));
  const h = lines.map((l, i) => drawLine(l, drawn[i], { colour: COLORS.logical, op: after && l.to === AI_TABLE.name ? fresh : 1 })).join('');
  return `<svg class="abs" style="left:${CX}px;top:${CY}px;overflow:visible" width="1" height="1">${h}</svg>`;
}

/** The comparison panel (bottom right of the canvas, above the terminal while that is open). */
function comparePanel(t, bottom) {
  const matched = phaseAt(t) === 'afterAi';
  const since = matched ? COMPARE_AGAIN : COMPARE_ON;
  const op = easeOut(seg(t, since, since + 0.3));
  const c = matched ? COMPARED.afterAi : COMPARED.sqlChanged;
  const [a, cur, vs, b, tgt] = COMPARE.title;
  const small = 'font-size:15px;color:var(--text-3)';
  const stat = (v, label, col) => `<span style="display:flex;align-items:baseline;gap:8px"><span style="font-size:28px;font-weight:800;color:${col}">${v}</span><span style="font-size:18px;color:var(--text-2)">${label}</span></span>`;
  const flash = matched ? Math.sin(Math.PI * seg(t, COMPARE_AGAIN + 0.1, COMPARE_AGAIN + 1.3)) : 0;
  const right = matched
    ? `<span style="font-size:19px;font-weight:700;color:${COLORS.physical}">${COMPARE.allMatched}</span>`
    : `<span style="display:flex;align-items:center;gap:6px;padding:3px 12px;border-radius:7px;border:1px solid #3a3d45;font-size:18px;font-weight:600"><svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/></svg>${COMPARE.sync}</span>`;
  const rows = matched ? '' : `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #2c2c30;font-size:18px">
      <div style="display:flex;align-items:center;gap:9px"><span style="width:9px;height:9px;border-radius:50%;background:${COLORS.physical}"></span><span class="mono" style="font-weight:600">${c.table}</span></div>
      <div style="display:flex;align-items:center;gap:9px;margin:5px 0 0 18px"><span style="width:8px;height:8px;border-radius:50%;background:${COMPARE.ghost}"></span><span class="mono" style="color:var(--text-2)">${c.column}</span><span style="flex:1"></span><span style="font-size:16px;color:${COMPARE.ghost}">${COMPARE.onlyIn}</span></div></div>`;
  return `<div class="abs" style="right:16px;bottom:${bottom.toFixed(1)}px;width:478px;border-radius:12px;background:#1c1e23;border:1px solid ${flash > 0 ? `rgba(32,192,90,${(0.35 + 0.65 * flash).toFixed(3)})` : '#3a3d45'};box-shadow:0 18px 44px #000a${flash > 0 ? `,0 0 0 ${(4 * flash).toFixed(1)}px rgba(32,192,90,${(0.3 * flash).toFixed(3)})` : ''};padding:10px 16px 12px;white-space:nowrap;opacity:${op.toFixed(3)};transform:translateY(${(12 * (1 - op)).toFixed(1)}px)">
      <div style="display:flex;align-items:center;gap:7px;font-size:18px">
        <span style="font-weight:700;color:${COLORS.logical}">${a}</span><span style="${small}">${cur}</span><span style="color:var(--text-2)">${vs}</span>
        <span style="font-weight:700;color:${COLORS.physical}">${b}</span><span style="${small}">${tgt}</span><span style="flex:1"></span>${right}
        <span style="color:var(--text-3);display:flex;margin-left:4px">${ICON.x({ size: 16 })}</span></div>
      <div style="margin-top:6px;display:flex;align-items:center;gap:22px">${stat(c.matched, COMPARE.matched, 'var(--text)')}${matched ? '' : stat(c.colDiffs, COMPARE.colDiff, 'var(--amber)')}</div>${rows}</div>`;
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
      <div class="mono" style="padding:${TERM.pad / 2}px 20px 0;font-size:16.5px;color:var(--text)">${rows}</div></div>`;
}

function ordersCanvas(t) {
  const phase = phaseAt(t), comparing = comparingAt(t);
  const lit = (name) => {
    const k = FILE_ORDER.indexOf(name);
    if (k < 0) return 0;
    const at = LIGHT0 + k * LIGHT_STEP;
    const last = k === FILE_ORDER.length - 1;
    return Math.min(easeOut(seg(t, at, at + 0.25)), 1 - seg(t, at + LIGHT_STEP, at + LIGHT_STEP + 0.3) * (last ? 0 : 1)) * (1 - seg(t, CODE_OUT, CODE_OUT + 0.3));
  };
  // what the AI's edit put on the canvas: lit green as it lands, then at rest
  const fresh = phase === 'afterAi' ? easeOut(seg(t, AI.done, AI.done + 0.35)) : 0;
  const glow = phase === 'afterAi' ? 0.35 + 0.65 * (1 - seg(t, AI.done + 1.6, AI.done + 2.4)) : 0;
  const mark = comparing && phase === 'sqlChanged' ? easeOut(seg(t, MARK_AT, MARK_AT + 0.3)) : 0;
  let inner = '';
  for (const tb of phase === 'afterAi' ? T_AFTER : T) {
    const g = lit(tb.name);
    const isNew = tb.name === AI_TABLE.name;
    const found = tb.name === COMPARED.sqlChanged.table ? Math.sin(Math.PI * seg(t, MARK_AT, MARK_AT + 1.4)) * (mark > 0 ? 1 : 0) : 0;
    const shadow = g > 0 ? `0 0 0 ${(5 * g).toFixed(1)}px rgba(96,165,250,${(0.55 * g).toFixed(3)}),`
      : found > 0 ? `0 0 0 ${(5 * found).toFixed(1)}px rgba(244,180,44,${(0.6 * found).toFixed(3)}),`
      : isNew ? `0 0 0 ${(5 * glow).toFixed(1)}px rgba(34,197,94,${(0.6 * glow).toFixed(3)}),` : '';
    const cols = tb.cols.map(([key, name, type]) => ({
      key: key ?? undefined, name, type,
      rowStyle: tb.name === AI_COLUMN.table && name === AI_COLUMN.col[1] ? `background:rgba(34,197,94,${(0.2 * glow).toFixed(3)});box-shadow:inset 5px 0 0 rgba(34,197,94,${glow.toFixed(3)})` : undefined,
    }));
    if (mark > 0 && tb.name === COMPARED.sqlChanged.table) {
      // the ghost row: what dbt has and the design lacks (a ghost row has no key column: its name starts at the card's edge)
      cols.push({ name: `<span style="margin-left:-56px;font-size:16px;font-weight:700;letter-spacing:.06em;color:${COMPARE.ghost}">${COMPARE.separator.toUpperCase()}</span>`, type: '', rowStyle: `height:${(32 * mark).toFixed(1)}px;overflow:hidden;opacity:${mark.toFixed(3)};border-top:1px dashed ${COMPARE.ghost};border-bottom:1px dashed ${COMPARE.ghost};background:rgba(156,163,175,.06)` });
      cols.push({
        name: `<span style="margin-left:-56px;font-size:21px;font-style:italic;text-decoration:line-through;color:${COMPARE.ghost};opacity:${GHOST_INK}">${COMPARED.sqlChanged.column}</span>`,
        types: [['', COMPARED.sqlChanged.type, `rgba(156,163,175,${GHOST_INK})`]],
        pill: `<span style="margin-left:-4px;padding:1px 6px;border-radius:5px;font-size:13px;font-weight:700;background:rgba(156,163,175,.2);color:${COMPARE.ghost}">${COMPARE.badge.toUpperCase()}</span>`,
        rowStyle: `height:${(46 * mark).toFixed(1)}px;overflow:hidden;opacity:${mark.toFixed(3)}`,
      });
    }
    const style = `${shadow ? `box-shadow:${shadow}0 18px 44px #0009;` : ''}${isNew && fresh < 1 ? `opacity:${fresh.toFixed(3)};` : ''}`;
    inner += node({ x: tb.x, y: tb.y, w: NW, name: tb.name, stage: 'logical', cols, style });
  }
  let h = `<div class="abs grid-bg" style="left:${EDX}px;top:0;right:0;bottom:0;background-color:var(--card)"></div>
    ${linesSvg(t)}
    <div class="abs" style="left:${CX}px;top:${CY}px;transform-origin:0 0;transform:scale(${CS})">${inner}</div>
    ${toolbar({ x: EDX + 20, y: 16, logicalOnly: false, stage: 'logical', compare: comparing ? 'on' : 'off', layout: 'idle', add: 'idle', lineStyle: LINE_STYLE })}`;
  if (comparing) h += comparePanel(t, 14);
  // fct_order.dbml's text, bottom right
  if (t >= CODE_IN && t < CODE_OUT + 0.3) {
    const op = Math.min(1, easeOut(seg(t, CODE_IN, CODE_IN + 0.3))) * (1 - seg(t, CODE_OUT, CODE_OUT + 0.3));
    const body = FCT_DBML.map((l, i) => `<div style="display:flex;height:28px;align-items:center"><span style="width:26px;text-align:right;margin-right:16px;color:var(--line-no)">${i + 1}</span><span style="white-space:pre">${dbmlLine(l)}</span></div>`).join('');
    h += codeCard('.erd-studio/main/tables/main/fct_order.dbml', '#5ca2f8', body, op, 560);
  }
  // the SQL change: fct_order.sql's diff, bottom right, until the comparison's panel takes the corner
  if (t >= SQL_AT && t < SQL_CARD_OUT + 0.3) {
    const op = Math.min(1, easeOut(seg(t, SQL_AT + 0.1, SQL_AT + 0.4))) * (1 - seg(t, SQL_CARD_OUT, SQL_CARD_OUT + 0.3));
    const body = SQL_CARD.lines.map((l, i) => {
      const add = i === SQL_CARD.added;
      return `<div style="display:flex;height:28px;align-items:center;${add ? 'background:rgba(34,197,94,.16)' : ''}"><span style="width:26px;text-align:right;margin-right:8px;color:var(--line-no)">${i + 1}</span><span style="width:16px;color:var(--green);font-weight:700">${add ? '+' : ''}</span><span style="white-space:pre;${add ? 'color:#b7f0c9' : ''}">${sqlLine(l)}</span></div>`;
    }).join('');
    h += codeCard(SQL_CARD.path, '#e0a458', body, op, 520, `<span style="flex:1"></span><span style="color:${GIT_COLOUR.M};font-weight:700">M</span>`);
  }
  return h + terminal(t);
}

/** A file's text in a card at the canvas's bottom right. */
function codeCard(file, iconColour, body, op, width, extra = '') {
  return `<div class="abs" style="right:24px;bottom:22px;width:${width}px;border-radius:12px;background:#1b1c20;border:1px solid #3a3c42;box-shadow:0 18px 48px #000c;overflow:hidden;opacity:${op.toFixed(3)};transform:translateY(${(12 * (1 - op)).toFixed(1)}px)">
      <div style="height:40px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid #2c2c30;font-size:18px;color:var(--text-2);white-space:nowrap"><span style="color:${iconColour};display:flex">${ICON.file({ size: 18 })}</span>${file}${extra}</div>
      <div class="mono" style="padding:8px 0 10px 4px;font-size:17px">${body}</div></div>`;
}
/** One line of SQL, lightly coloured: its keywords and the Jinja call. */
function sqlLine(s) {
  return esc(s).replace(/^(select|from)\b/, '<span style="color:var(--syn-kw)">$1</span>').replace(/(\{\{.*\}\})/, '<span style="color:var(--syn-val)">$1</span>');
}

function explorer(t) {
  const phase = phaseAt(t);
  const rows = heroTree({ sql: phase !== 'inStep', store: t >= STORE_FILE_AT && t < RESET_AT });
  const at = (id) => rows.findIndex((r) => r[4] === id);
  const pulse = (from, hold) => easeOut(seg(t, from, from + 0.25)) * (1 - seg(t, from + hold, from + hold + 0.4));
  const lights = new Map();
  FILE_ORDER.forEach((name, k) => {
    const from = LIGHT0 + k * LIGHT_STEP, last = k === FILE_ORDER.length - 1;
    lights.set(at(`t:${name}`), Math.min(easeOut(seg(t, from, from + 0.25)), 1 - seg(t, from + LIGHT_STEP, from + LIGHT_STEP + 0.3) * (last ? 0 : 1)) * (1 - seg(t, CODE_OUT, CODE_OUT + 0.3)));
  });
  const add = (id, v) => { const i = at(id); if (i >= 0 && v > 0) lights.set(i, Math.max(lights.get(i) ?? 0, v)); };
  add('sales', easeOut(seg(t, DRAFT_IN - 0.3, DRAFT_IN)) * (1 - seg(t, DRAFT_OUT, DRAFT_OUT + 0.35)));
  if (t < RESET_AT) for (const [id, , from] of GIT) add(id, pulse(from, id === 'm:dim_store' || id === 'm:fct_order' ? SQL_CARD_OUT - SQL_AT : id === 't:dim_store' ? 2.2 : 0.9));
  const git = new Map(GIT.filter(([, , from]) => t >= from && t < RESET_AT).map(([id, letter]) => [at(id), letter]));
  const scroll = t >= RESET_AT ? 0 : easeInOut(seg(t, SCROLL_AT, SCROLL_AT + 0.3)) * SCROLL_ROWS * ROW_H;
  const tree = fileTree(rows, {
    top: -scroll, rowH: ROW_H, width: SIDEW - 10, indent: 22, font: 19,
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
  const d = t >= DRAFT_IN && t < DRAFT_OUT ? 1 : 0;   // a tab switch: a cut
  let body = ordersCanvas(t);
  if (d > 0) body += draftPage(SALES_DRAFT, { left: EDX, width: BODYW - EDX, op: d, glow: easeOut(seg(t, DRAFT_IN + 1.2, DRAFT_IN + 1.6)), scale: DRAFT_SCALE, font: 16, edges: DRAFT_EDGES, stage: 'logical' }).html;
  body += explorer(t) + activityBar('files');
  // the pointer, on top of everything (the window clips it as it comes in and goes out)
  const visit = POINTER.find((v) => t >= v[0].t && t <= v.at(-1).t);
  if (visit) {
    const p = path(t, visit);
    body += pointer(p.x, p.y, press(t));
  }
  const tabs = [{ label: 'orders.dbml', on: d < 0.5 }];
  if (d > 0) tabs.push({ label: SALES_DRAFT.tab, on: d >= 0.5 });
  return `<div class="abs" style="left:0;top:0;width:${HERO.w}px;height:${CAP_H}px">${captionBand(t)}</div>`
    + card({ ...WIN, tabs, crumb: d < 0.5 ? '.erd-studio › main › diagrams › orders.dbml' : 'shop-analytics', body })
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
