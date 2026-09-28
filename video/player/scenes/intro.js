// 1 · From your dbt project to a data model: a dbt file tree whose model files fly into
// three logical ERD nodes, which then connect.
import { appear, appIcon, card, easeInOut, edge, ICON, lerp, node, nodeHeight, rowY, seg, COLORS } from '../lib.js';

const TREE = [
  { d: 0, icon: 'folder', label: 'my_dbt_project', open: true },
  { d: 1, icon: 'folder', label: 'models', open: true },
  { d: 2, icon: 'folder', label: 'staging', open: true },
  { d: 3, icon: 'file', label: 'stg_customers.sql' },
  { d: 3, icon: 'file', label: 'stg_orders.sql' },
  { d: 2, icon: 'folder', label: 'marts', open: true },
  { d: 3, icon: 'file', label: 'dim_customer.sql', fly: 0 },
  { d: 3, icon: 'file', label: 'fct_order.sql', fly: 1 },
  { d: 3, icon: 'file', label: 'dim_product.sql', fly: 2 },
  { d: 3, icon: 'file', label: 'schema.yml', yml: true },
  { d: 1, icon: 'file', label: 'dbt_project.yml', yml: true },
];
const TREE_X = 96, TREE_Y = 322, TREE_W = 560, ROW = 44, ROW0 = TREE_Y + 64 + 26;

const CANVAS = { x: 704, y: 322, w: 1120, h: 600 };
const W = 330;
const NODES = [
  { name: 'dim_customer', x: CANVAS.x + 44, y: CANVAS.y + 92, grain: 'One row per customer',
    cols: [{ key: 'PK', name: 'customer_key', type: 'INT' }, { name: 'email', type: 'VARCHAR' }, { name: 'segment', type: 'VARCHAR' }] },
  { name: 'fct_order', x: CANVAS.x + 395, y: CANVAS.y + 222, grain: 'One row per order',
    cols: [{ key: 'PK', name: 'order_id', type: 'INT' }, { key: 'FK', name: 'customer_key', type: 'INT' }, { key: 'FK', name: 'product_id', type: 'INT' }, { name: 'order_total', type: 'DECIMAL' }] },
  { name: 'dim_product', x: CANVAS.x + 746, y: CANVAS.y + 92, grain: 'One row per product',
    cols: [{ key: 'PK', name: 'product_id', type: 'INT' }, { name: 'category', type: 'VARCHAR' }, { name: 'price', type: 'DECIMAL' }] },
];

export default {
  render(t, { beats }) {
    const flyAt = (k) => beats.turn.t + 0.35 + k * 0.42;
    const FLY = 0.62;

    // Explorer tree
    let rows = '';
    TREE.forEach((r, i) => {
      const y = ROW0 + i * ROW;
      const at = 0.15 + i * 0.07;
      const hot = r.fly !== undefined ? seg(t, flyAt(r.fly) - 0.15, flyAt(r.fly)) : 0;
      const colour = r.icon === 'folder' ? '#7f8792' : r.yml ? '#c9a24b' : '#5ca2f8';
      const chev = r.open ? ICON.chevDown({ size: 18, sw: 2.6 }) : '<span style="width:18px"></span>';
      rows += `<div class="abs" style="left:${TREE_X + 12}px;top:${y - 22}px;width:${TREE_W - 24}px;height:${ROW}px;border-radius:8px;background:rgba(92,162,248,${(0.16 * hot).toFixed(3)});${appear(t, at, { dy: 0, dx: -10 })}"></div>
        <div class="abs" style="left:${TREE_X + 28 + r.d * 30}px;top:${y - 16}px;display:flex;align-items:center;gap:10px;font-size:23px;color:${r.icon === 'folder' ? 'var(--text)' : '#c9ced6'};white-space:nowrap;${appear(t, at, { dy: 0, dx: -10 })}">
          <span style="color:var(--text-3)">${r.icon === 'folder' ? chev : '<span style="display:inline-block;width:18px"></span>'}</span>
          <span style="color:${colour}">${ICON[r.icon]({ size: 24 })}</span>${r.label}</div>`;
    });
    const tree = card({ x: TREE_X, y: TREE_Y, w: TREE_W, h: 600, tabs: [{ label: 'EXPLORER', on: true }], headStyle: 'letter-spacing:.08em;font-size:19px' });

    // Canvas + nodes
    const canvas = card({ x: CANVAS.x, y: CANVAS.y, w: CANVAS.w, h: CANVAS.h, tabs: [{ label: 'orders.json', on: true }], crumb: '.erd-studio › gold › orders.json', bodyCls: 'grid-bg', style: appear(t, 0.2) });

    // While the voice says "Welcome to ERD Studio", the empty canvas carries the app mark.
    const markOut = 1 - seg(t, flyAt(0), flyAt(0) + 0.4);
    const mark = markOut > 0
      ? `<div class="abs" style="left:${CANVAS.x}px;top:${CANVAS.y + 64}px;width:${CANVAS.w}px;height:${CANVAS.h - 64}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;opacity:${markOut.toFixed(3)}">
          <div style="${appear(t, beats.welcome.t, { dy: 12, dur: 0.5 })}">${appIcon(132)}</div>
          <div style="font-size:52px;font-weight:800;letter-spacing:-.03em;${appear(t, beats.welcome.t + 0.2, { dy: 12, dur: 0.5 })}">ERD Studio</div></div>`
      : '';
    let nodes = mark, chips = '';
    NODES.forEach((n, k) => {
      const t0 = flyAt(k);
      const p = easeInOut(seg(t, t0, t0 + FLY));
      // file chip flies from its tree row to the node header
      const srcRow = TREE.findIndex((r) => r.fly === k);
      const sx = TREE_X + 28 + 3 * 30 + 26, sy = ROW0 + srcRow * ROW - 22;
      const tx = n.x + 16, ty = n.y + 12;
      if (p > 0 && p < 1) {
        const x = lerp(sx, tx, p), y = lerp(sy, ty, p) - Math.sin(p * Math.PI) * 24;
        chips += `<div class="abs pill" style="left:${x}px;top:${y}px;background:#1b2a40;color:#cfe3ff;border:2px solid var(--logical);box-shadow:0 10px 30px #000a;opacity:${Math.min(1, p * 6, (1 - p) * 4).toFixed(2)}">${ICON.table({ size: 20 })}${n.name}</div>`;
      }
      const landed = t0 + FLY - 0.12;
      if (t >= landed) nodes += node({ x: n.x, y: n.y, w: W, name: n.name, grain: n.grain, cols: n.cols, style: appear(t, landed, { dur: 0.35, dy: 10 }) });
    });

    // Edges once all three nodes are down
    const eAt = flyAt(2) + FLY + 0.1;
    const f = NODES[1];
    const c1y = f.y + rowY(1), c2y = f.y + rowY(2);
    const dc = NODES[0], dp = NODES[2];
    const e1 = edge([[dc.x + 60, dc.y + nodeHeight(3)], [dc.x + 60, c1y], [f.x, c1y]], { progress: seg(t, eAt, eAt + 0.55), one: [dc.x + 72, dc.y + nodeHeight(3) + 26], many: [f.x - 26, c1y - 6] });
    const e2 = edge([[dp.x + W - 60, dp.y + nodeHeight(3)], [dp.x + W - 60, c2y], [f.x + W, c2y]], { progress: seg(t, eAt + 0.2, eAt + 0.75), one: [dp.x + W - 50, dp.y + nodeHeight(3) + 26], many: [f.x + W + 10, c2y - 6] });

    return `${tree}${rows}${canvas}${e1}${e2}${nodes}${chips}`;
  },
};
