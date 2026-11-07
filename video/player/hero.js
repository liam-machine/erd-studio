// The README's hero GIF (media/demo.gif), drawn by ../hero-gif.mjs from player/hero.html with the
// video's own pieces (editor.js, lib.js): ERD Studio in a plain folder (no
// stage tabs, nothing to compare), the Explorer showing the layer-first .erd-studio tree beside the
// orders diagram, a fct_order star schema with its keys, drawn neutral (a plain folder has no
// stage colours). The table files light one by one with their tables, fct_order.dbml's text
// shows, then sales.dbml (in the folder's top level) lights and the editor switches to the draft an
// Import DBML… of it opens (its summary, before anything is written; none of its tables is in the
// library), and back: a seamless loop.
// render(t) is pure, like the video's.
import { card, easeOut, edge, ICON, node, seg, toolbar } from './lib.js';
import { SALES_DRAFT, activityBar, dbmlLine, draftPage, fileTree } from './editor.js';

export const HERO = { w: 1440, h: 900, fps: 12, loop: 12 };
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
// The loop: files light 1.0–4.6 s, fct_order.dbml's text 3.9–6.6 s, the draft 7.0–11.2 s.
const LIGHT0 = 1.0, LIGHT_STEP = 0.9;
const CODE_IN = 3.9, CODE_OUT = 6.6;
const DRAFT_IN = 7.0, DRAFT_OUT = 11.2;

function ordersCanvas(t) {
  const lit = (name) => {
    const k = Object.keys(FILE_ROW).indexOf(name);
    const at = LIGHT0 + k * LIGHT_STEP;
    return Math.min(easeOut(seg(t, at, at + 0.25)), 1 - seg(t, at + LIGHT_STEP, at + LIGHT_STEP + 0.3) * (k < 3 ? 1 : 0)) * (1 - seg(t, CODE_OUT, CODE_OUT + 0.3));
  };
  let inner = '';
  const f = T[3];
  for (const [fr, d] of RELS) {
    const D = T[d];
    const right = D.x > f.x;
    const x0 = right ? f.x + NW : f.x, x1 = right ? D.x : D.x + NW;
    const y0 = rowY(f.y, fr), y1 = rowY(D.y, 0), mx = (x0 + x1) / 2;
    inner += edge([[x0, y0], [mx, y0], [mx, y1], [x1, y1]], { width: 4, many: right ? [x0 + 8, y0 - 10] : [x0 - 26, y0 - 10], one: right ? [x1 - 22, y1 - 12] : [x1 + 10, y1 - 12] });
  }
  for (const tb of T) {
    const g = lit(tb.name);
    const ring = g > 0 ? `box-shadow:0 0 0 ${(5 * g).toFixed(1)}px rgba(96,165,250,${(0.55 * g).toFixed(3)}),0 18px 44px #0009;` : '';
    inner += node({ x: tb.x, y: tb.y, w: NW, name: tb.name, cols: tb.cols.map(([key, name, type]) => ({ key: key ?? undefined, name, type })), style: ring });
  }
  let h = `<div class="abs grid-bg" style="left:${EDX}px;top:0;right:0;bottom:0;background-color:var(--card)"></div>
    <div class="abs" style="left:${EDX + 40}px;top:120px;transform-origin:0 0;transform:scale(0.62)">${inner}</div>
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
