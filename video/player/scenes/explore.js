// 10 · Explore: the ERD Studio sidebar (domains by layer), the pointer opens "orders", the
// canvas draws the logical diagram, then flips to Physical (green, read-only).
import { appear, appIcon, COLORS, edge, ICON, mix, node, path, pointer, rowY, seg, toolbar } from '../lib.js';

const X = 96, Y = 322, W = 1728, H = 600;
const SB = 380;                       // sidebar width
const CX = X + SB, CW = W - SB;       // canvas box

function treeRow(y, depth, label, { icon = 'folder', sel = 0, count, colour = '#7f8792', style = '' } = {}) {
  return `<div class="abs" style="left:${X + 10}px;top:${y}px;width:${SB - 20}px;height:44px;border-radius:8px;background:rgba(92,162,248,${(0.22 * sel).toFixed(3)});${style}"></div>
    <div class="abs" style="left:${X + 22 + depth * 26}px;top:${y + 8}px;display:flex;align-items:center;gap:10px;font-size:22px;white-space:nowrap;${style}">
      <span style="color:var(--text-3)">${icon === 'folder' ? ICON.chevDown({ size: 18, sw: 2.6 }) : '<span style="display:inline-block;width:18px"></span>'}</span>
      <span style="color:${colour}">${icon === 'folder' ? ICON.folder({ size: 22 }) : ICON.table({ size: 22 })}</span>${label}
      ${count ? `<span style="color:var(--text-3);font-size:19px">${count}</span>` : ''}</div>`;
}

export default {
  render(t, { beats }) {
    const open = beats.open.t, sw = beats.switch.t;
    const clickAt = open + 1.5;
    const canvasAt = clickAt + 0.3;
    const physAt = sw + 1.5;          // "…between logical and physical"
    const phys = seg(t, physAt, physAt + 0.35);

    // Window chrome: sidebar + editor area
    let html = `<div class="card" style="left:${X}px;top:${Y}px;width:${W}px;height:${H}px;${appear(t, 0)}">
      <div class="abs" style="left:0;top:0;width:${SB}px;bottom:0;background:#15161a;border-right:1px solid var(--card-border)"></div>
      <div class="abs" style="left:0;top:0;width:${SB}px;height:64px;display:flex;align-items:center;gap:12px;padding:0 22px;border-bottom:1px solid var(--card-border);font-size:18px;font-weight:700;letter-spacing:.1em;color:var(--text-2)">
        ERD STUDIO<span style="flex:1"></span><span style="color:var(--text)">${ICON.playCircle({ size: 24 })}</span><span>${ICON.plus({ size: 20, sw: 2.4 })}</span></div>
      <div class="abs" style="left:${SB}px;right:0;top:0;height:64px;background:var(--card-head);border-bottom:1px solid var(--card-border);display:flex;align-items:stretch;font-size:22px">
        ${t >= canvasAt ? `<div class="card__tab card__tab--on" style="${appear(t, canvasAt, { dy: 0 })}">${appIcon(24)}orders.json</div><div class="card__crumb" style="${appear(t, canvasAt, { dy: 0 })}">.erd-studio › gold › orders.json</div>` : ''}</div>
      <div class="abs grid-bg" style="left:${SB}px;right:0;top:64px;bottom:0"></div></div>`;

    // Sidebar tree
    const y0 = Y + 64 + 16;
    const sel = seg(t, clickAt, clickAt + 0.15);
    html += `<div class="abs" style="left:${X + 22}px;top:${y0 + 4}px;font-size:17px;font-weight:700;letter-spacing:.1em;color:var(--text-3);${appear(t, 0.2)}">DOMAINS</div>`;
    html += treeRow(y0 + 40, 0, 'gold', { style: appear(t, 0.3) });
    html += treeRow(y0 + 88, 1, 'orders', { icon: 'domain', sel, count: '3 models', colour: 'var(--blue)', style: appear(t, 0.4) });
    html += treeRow(y0 + 136, 1, 'customers', { icon: 'domain', count: '5 models', colour: 'var(--blue)', style: appear(t, 0.5) });
    html += treeRow(y0 + 184, 0, 'silver', { style: appear(t, 0.6) });
    html += treeRow(y0 + 232, 1, 'staging', { icon: 'domain', count: '6 models', colour: 'var(--blue)', style: appear(t, 0.7) });
    html += `<div class="abs" style="left:${X + 22}px;top:${y0 + 300}px;font-size:17px;font-weight:700;letter-spacing:.1em;color:var(--text-3);${appear(t, 0.8)}">MODEL LIBRARY</div>`;
    ['dim_customer', 'dim_product', 'fct_order'].forEach((m, i) => {
      html += `<div class="abs" style="left:${X + 48}px;top:${y0 + 340 + i * 40}px;font:400 20px var(--mono);color:var(--text-2);${appear(t, 0.85 + i * 0.06)}">${m}.yml</div>`;
    });

    // Canvas
    if (t >= canvasAt) {
      const stage = phys > 0.5 ? 'physical' : 'logical';
      html += toolbar({ x: CX + (CW - 470) / 2, y: Y + 64 + 22, stage, diff: 'off', style: appear(t, canvasAt) });
      const w = 330;
      const dc = { x: CX + 70, y: Y + 64 + 120 }, dp = { x: CX + CW - 70 - w, y: Y + 64 + 120 }, fo = { x: CX + (CW - w) / 2, y: Y + 64 + 190 };
      const colour = mix(COLORS.logical, COLORS.physical, phys);
      const ep = seg(t, canvasAt + 0.8, canvasAt + 1.3);
      const c1 = fo.y + rowY(1), c2 = fo.y + rowY(2);
      html += edge([[dc.x + w, dc.y + rowY(0)], [dc.x + w + 40, dc.y + rowY(0)], [dc.x + w + 40, c1], [fo.x, c1]], { color: colour, progress: ep, one: [dc.x + w + 8, dc.y + rowY(0) - 10], many: [fo.x - 24, c1 - 8] });
      html += edge([[dp.x, dp.y + rowY(0)], [dp.x - 40, dp.y + rowY(0)], [dp.x - 40, c2], [fo.x + w, c2]], { color: colour, progress: ep, one: [dp.x - 22, dp.y + rowY(0) - 10], many: [fo.x + w + 8, c2 - 8] });
      const keys = true;               // physical keeps key badges (derived from dbt tests), as on the real canvas
      html += node({ x: dc.x, y: dc.y, w, name: 'dim_customer', stage: phys, grain: 'One row per customer',
        cols: [{ key: keys ? 'PK' : undefined, name: 'customer_key', type: 'INT' }, { name: 'email', type: 'VARCHAR' }], style: appear(t, canvasAt + 0.2) });
      html += node({ x: dp.x, y: dp.y, w, name: 'dim_product', stage: phys, grain: 'One row per product',
        cols: [{ key: keys ? 'PK' : undefined, name: 'product_id', type: 'INT' }, { name: 'category', type: 'VARCHAR' }], style: appear(t, canvasAt + 0.35) });
      html += node({ x: fo.x, y: fo.y, w, name: 'fct_order', stage: phys, grain: 'One row per order',
        cols: [{ key: keys ? 'PK' : undefined, name: 'order_id', type: 'INT' }, { key: keys ? 'FK' : undefined, name: 'customer_key', type: 'INT' }, { key: keys ? 'FK' : undefined, name: 'product_id', type: 'INT' }, { name: 'order_total', type: 'DECIMAL' }],
        style: appear(t, canvasAt + 0.5) });
    }

    // Pointer: from the canvas area to "orders", click, then over to the Physical tab.
    const orders = { x: X + 150, y: y0 + 88 + 26 };
    const physTab = { x: CX + (CW - 470) / 2 + 420, y: Y + 64 + 64 };
    const p = path(t, [
      { t: 0.5, x: 1400, y: 900 },
      { t: clickAt - 0.1, x: orders.x, y: orders.y },
      { t: physAt - 0.9, x: orders.x, y: orders.y },
      { t: physAt - 0.1, x: physTab.x, y: physTab.y },
    ]);
    const press = t < physAt ? seg(t, clickAt, clickAt + 0.45) : seg(t, physAt, physAt + 0.45);
    const pOp = seg(t, 0.5, 0.8);
    html += `<div class="abs" style="inset:0;opacity:${pOp.toFixed(2)}">${pointer(p.x, p.y, press >= 1 ? 0 : press)}</div>`;
    return html;
  },
};
