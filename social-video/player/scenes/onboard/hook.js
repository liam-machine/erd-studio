// onboard/hook · "Your dbt project, as a diagram, in under a minute. / No setup. No AI required."
// The thumbnail: finished at t = 0. Top left, the dbt files (a models/marts file list); top right,
// a "60 s" stopwatch tile whose ring sweeps round on "…in under a minute"; below, the finished
// blue ERD of the four marts tables from the real sample, in the same dims-left / facts-right
// arrangement onboard/canvas lands on (rows pulled closer so the whole stack fits the stage). The
// columns are untyped, as a first Draw from dbt of the sample really is (its schema yml declares
// no data_type). Under the ERD, in their own row (never over an edge): "Runs locally, no AI" is
// there from frame 0 (the strongest muted promise), centred; on "No setup" it slides left and
// "Reads your dbt project" lands beside it; on "No AI required" the first one pulses.
// Both add to the captions instead of repeating them.
import { ICON, appear, easeInOut, edge, node, seg } from '../../lib.js';

// ---- geometry (frame px) ----
// top row: files card + timer tile, 36 px apart; then the ERD panel; then the pill row
const FILES = { x: 64, y: 300, w: 700, h: 180 };
const TIMER = { x: 800, y: 300, w: 216, h: 180 };
const PANEL = { x: 64, y: 494, w: 952, h: 514 };      // ends at y 1008
const PILL_Y = 1026;                                   // 58 px pills, end at y 1084 (stage ends 1090)

// ---- ORDERS_LAYOUT: canvas.js's x geometry; rows tightened so the stack fits between the rows ----
const LX = 84, LW = 410, RX = 552, RW = 424, TOP = PANEL.y + 16, BOT = TOP + 246 + 30;
const MIDX = (LX + LW + RX) / 2;
const RIGHT = RX + RW + 22;
const ry = (top, i) => top + 62 + i * 46 + 23;        // row centre, no grain line (a draft has none)
const ORDERS_LAYOUT = [
  { name: 'dim_customers', x: LX, y: TOP, w: LW, cols: [{ key: 'PK', name: 'customer_id' }, { name: 'customer_name' }] },
  { name: 'fct_orders', x: RX, y: TOP, w: RW, cols: [{ key: 'PK', name: 'order_id' }, { key: 'FK', name: 'customer_id' }, { name: 'order_date' }, { name: 'order_total' }] },
  { name: 'fct_order_items', x: RX, y: BOT, w: RW, cols: [{ key: 'PK', name: 'order_item_id' }, { key: 'FK', name: 'order_id' }, { key: 'FK', name: 'product_id' }] },
  { name: 'dim_products', x: LX, y: BOT, w: LW, cols: [{ key: 'PK', name: 'product_id' }, { name: 'product_name' }, { name: 'product_price' }] },
];

const FILE_LIST = [
  ['dim_customers.sql', 'dim_products.sql', 'schema.yml'],
  ['fct_orders.sql', 'fct_order_items.sql'],
];

/** Stopwatch: a ring that sweeps to `p` (0..1), a crown on top. */
function stopwatch(size, p, color) {
  const r = 9, c = 2 * Math.PI * r;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
    <path d="M10 1.8h4M12 1.8v2.4" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="12" cy="13.4" r="${r}" stroke="#2a3a52" stroke-width="2.6"/>
    <circle cx="12" cy="13.4" r="${r}" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="${(c * p).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 12 13.4)"/>
    <path d="M12 13.4l${(5 * Math.sin(2 * Math.PI * p)).toFixed(2)} ${(-5 * Math.cos(2 * Math.PI * p)).toFixed(2)}" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>
  </svg>`;
}

const pillTick = (label, left, style = '') =>
  `<div class="abs" style="left:${left.toFixed(1)}px;top:${PILL_Y}px;height:58px;padding:0 22px 0 12px;border-radius:999px;background:#13301f;border:2px solid #22c55e;color:#dff7e8;display:flex;align-items:center;gap:12px;font-size:27px;font-weight:800;white-space:nowrap;${style}">
    <span class="tick tick--ok" style="width:36px;height:36px">${ICON.check({ size: 22 })}</span>${label}</div>`;

export default {
  render(t, { beats }) {
    const m = beats.minute.t, n = beats.noai.t;
    // o_minute: "Your dbt project,"(+0.0–1.35) "as a diagram,"(+1.54–2.31) "in under a minute"(+2.49–3.11)
    const sweep = 0.12 + 0.88 * easeInOut(seg(t, m + 0.2, m + 3.1));   // ring closes on "…a minute"
    const pulse = 1 + 0.05 * Math.sin(Math.PI * seg(t, m + 2.5, m + 3.2));
    // o_noai: "No setup."(+0.0–0.58) "No AI required."(+0.88–2.06)
    const readsAt = n + 0.05;            // "Reads your dbt project" lands on "No setup"
    const aiPulse = 1 + 0.06 * Math.sin(Math.PI * seg(t, n + 0.85, n + 1.45));   // "No AI required"
    const aiGlow = Math.sin(Math.PI * seg(t, n + 0.85, n + 1.45));

    let html = '';

    // ---------- the dbt files ----------
    const rows = FILE_LIST.map((col, ci) => col.map((f, ri) => {
      const yml = f.endsWith('.yml');
      return `<div class="abs mono" style="left:${28 + ci * 330}px;top:${8 + ri * 36}px;display:flex;align-items:center;gap:12px;font-size:26px;color:var(--text);white-space:nowrap">
        <span style="color:${yml ? '#c490e8' : '#d9b35a'}">${ICON.file({ size: 26 })}</span>${f}</div>`;
    }).join('')).join('');
    html += `<div class="card" style="left:${FILES.x}px;top:${FILES.y}px;width:${FILES.w}px;height:${FILES.h}px">
      <div class="card__head" style="font-size:24px"><div class="card__tab card__tab--on"><span style="color:#d9b35a">${ICON.folder({ size: 26 })}</span>models/marts</div><div class="card__crumb">jaffle-shop</div></div>
      <div class="card__body">${rows}</div></div>`;

    // ---------- the 60 s stopwatch tile ----------
    html += `<div class="abs" style="left:${TIMER.x}px;top:${TIMER.y}px;width:${TIMER.w}px;height:${TIMER.h}px;border-radius:20px;background:#10192a;border:3px solid #60a5fa;box-shadow:0 30px 80px #000a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;transform:scale(${pulse.toFixed(3)})">
      ${stopwatch(84, sweep, '#60a5fa')}<span style="font-size:56px;line-height:64px;font-weight:800;letter-spacing:-.02em;color:#fff;white-space:nowrap">60 s</span></div>`;

    // ---------- the finished ERD (ORDERS_LAYOUT) ----------
    html += `<div class="abs grid-bg" style="left:${PANEL.x}px;top:${PANEL.y}px;width:${PANEL.w}px;height:${PANEL.h}px;border-radius:20px;border:1px solid #2d4a70;background-color:#13161b;box-shadow:0 30px 80px #000a"></div>`;
    const [dc, fo, fi, dp] = ORDERS_LAYOUT;
    // fct_orders.customer_id -> dim_customers.customer_id
    html += edge([[fo.x, ry(fo.y, 1)], [MIDX, ry(fo.y, 1)], [MIDX, ry(dc.y, 0)], [dc.x + dc.w, ry(dc.y, 0)]], { many: [fo.x - 22, ry(fo.y, 1) - 8], one: [dc.x + dc.w + 8, ry(dc.y, 0) - 10] });
    // fct_order_items.order_id -> fct_orders.order_id (down the right side)
    html += edge([[fi.x + fi.w, ry(fi.y, 1)], [RIGHT, ry(fi.y, 1)], [RIGHT, ry(fo.y, 0)], [fo.x + fo.w, ry(fo.y, 0)]], { many: [fi.x + fi.w + 4, ry(fi.y, 1) - 8], one: [fo.x + fo.w + 6, ry(fo.y, 0) - 10] });
    // fct_order_items.product_id -> dim_products.product_id
    html += edge([[fi.x, ry(fi.y, 2)], [MIDX, ry(fi.y, 2)], [MIDX, ry(dp.y, 0)], [dp.x + dp.w, ry(dp.y, 0)]], { many: [fi.x - 22, ry(fi.y, 2) - 8], one: [dp.x + dp.w + 8, ry(dp.y, 0) - 10] });
    for (const m2 of ORDERS_LAYOUT) {
      html += node({ x: m2.x, y: m2.y, w: m2.w, name: m2.name, layer: 'GLD', cols: m2.cols.map((c) => ({ ...c, type: '' })), stage: 'logical' });
    }

    // ---------- the two pills, in their own row under the ERD ----------
    // widths measured from the stills: 27 px / 800 Inter + 36 px tick + padding
    const W1 = 330, W2 = 386, GAPX = 22;
    const rowL = 540 - (W1 + GAPX + W2) / 2;
    const slide = easeInOut(seg(t, readsAt - 0.1, readsAt + 0.35));   // "No setup": first pill moves over
    const x1 = 540 - W1 / 2 + (rowL - (540 - W1 / 2)) * slide;
    html += pillTick('Runs locally, no AI', x1, `transform:scale(${aiPulse.toFixed(3)});box-shadow:0 0 ${(28 * aiGlow).toFixed(1)}px rgba(34,197,94,${(0.55 * aiGlow).toFixed(2)}),0 12px 30px #000a`);
    if (t >= readsAt) {
      html += pillTick('Reads your dbt project', rowL + W1 + GAPX, `${appear(t, readsAt + 0.05, { dy: 12 })};box-shadow:0 12px 30px #000a`);
    }
    return html;
  },
};
