// 2 · Physical is what you built, logical is what you mean: two canvases side by side.
import { appear, card, edge, node, nodeHeight, rowY, seg, COLORS, ICON } from '../lib.js';

const Y = 322, H = 600, GAP = 36, CW = (1728 - GAP) / 2;
const LX = 96, RX = 96 + CW + GAP;

function label(x, colour, bg, title, sub, style) {
  return `<div class="abs" style="left:${x + 32}px;top:${Y + 64 + 26}px;display:flex;align-items:center;gap:16px;white-space:nowrap;${style}">
    <span class="pill" style="background:${bg};color:${colour};letter-spacing:.08em">${title}</span>
    <span style="font-size:23px;color:var(--text-2)">${sub}</span></div>`;
}

export default {
  render(t, { beats }) {
    const pA = beats.physical.t - 0.1, lA = beats.logical.t - 0.1;

    // Physical: what dbt builds — one table, columns and types, read-only (no keys of our own).
    const left = card({ x: LX, y: Y, w: CW, h: H, tabs: [{ label: 'Physical view', on: true, icon: `<span style="color:${COLORS.physical}">${ICON.lock({ size: 18 })}</span>` }], bodyCls: 'grid-bg', style: appear(t, pA) })
      + label(LX, '#b4f4cc', '#10502c', 'PHYSICAL', 'what your dbt project builds', appear(t, pA + 0.15))
      + node({ x: LX + 200, y: Y + 250, w: 440, name: 'fct_order', stage: 'physical', lock: true, grain: null,
        cols: [{ name: 'order_id', type: 'INTEGER' }, { name: 'customer_key', type: 'INTEGER' }, { name: 'order_date', type: 'DATE' }, { name: 'order_total', type: 'DECIMAL(18,2)' }],
        style: appear(t, pA + 0.35) })
      + `<div class="abs" style="left:${LX + 32}px;top:${Y + H - 62}px;font-size:20px;color:var(--text-2);white-space:nowrap;${appear(t, pA + 0.9)}">Read from your <span class="mono" style="color:var(--text)">.sql</span>, <span class="mono" style="color:var(--text)">.yml</span>, manifest and catalog</div>`;

    // Logical: the design — keys, grain and the relationship to dim_customer.
    const dc = { x: RX + 40, y: Y + 176 }, fo = { x: RX + 452, y: Y + 262 };
    const w = 350;
    const cy = fo.y + rowY(1);
    const right = card({ x: RX, y: Y, w: CW, h: H, tabs: [{ label: 'Logical view', on: true }], bodyCls: 'grid-bg', style: appear(t, lA) })
      + label(RX, '#cfe3ff', '#1c3c6c', 'LOGICAL', 'your design', appear(t, lA + 0.15))
      + edge([[dc.x + w / 2, dc.y + nodeHeight(2)], [dc.x + w / 2, cy], [fo.x, cy]], { progress: seg(t, lA + 1.3, lA + 1.8), one: [dc.x + w / 2 + 12, dc.y + nodeHeight(2) + 28], many: [fo.x - 26, cy - 6] })
      + node({ x: dc.x, y: dc.y, w, name: 'dim_customer', grain: 'One row per customer',
        cols: [{ key: 'PK', name: 'customer_key', type: 'INT' }, { name: 'email', type: 'VARCHAR' }], style: appear(t, lA + 0.35) })
      + node({ x: fo.x, y: fo.y, w, name: 'fct_order', grain: 'One row per order',
        cols: [{ key: 'PK', name: 'order_id', type: 'INT' }, { key: 'FK', name: 'customer_key', type: 'INT' }, { name: 'order_total', type: 'DECIMAL' }], style: appear(t, lA + 0.6) })
      + `<div class="abs" style="left:${RX + 32}px;top:${Y + H - 62}px;font-size:20px;color:var(--text-2);white-space:nowrap;${appear(t, lA + 2.0)}">Tables, keys, grain and relationships, in <span class="mono" style="color:var(--text)">.erd-studio/</span></div>`;

    // Once the logical side is on screen, the physical side steps back a little.
    const dim = 1 - 0.35 * seg(t, lA + 0.2, lA + 0.7);
    return `<div class="abs" style="inset:0;opacity:${dim.toFixed(3)}">${left}</div>${right}`;
  },
};
