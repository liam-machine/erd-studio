// 1 · The hook: "Your data model, as a diagram, saved as DBML files in your repo. / No AI needed,
// and nothing to configure." A plain folder's Explorer: its .erd-studio folder holds one .dbml file
// per table (the 2.0 layer-first layout: <layer>/tables/<schema>/<table>.dbml, beside
// <layer>/diagrams/ and <layer>/relationships/), and those table files fly into three nodes on
// "…as a diagram", which then connect. The claims land on "…DBML files", "No AI" and
// "…nothing to configure". Shared by both cuts.
//
// `hookScene(data)` draws the scene from any tree, nodes and claims.
import { appear, appIcon, card, easeInOut, edge, ICON, lerp, node, nodeHeight, rowY, seg } from '../../lib.js';

const TREE_X = 96, TREE_Y = 322, TREE_W = 560, ROW = 44, ROW0 = TREE_Y + 64 + 26;

const CANVAS_BOX = { x: 704, y: 322, w: 1120, h: 600 };
const W = 350;

/**
 * The hook scene for one cut. `tree` rows ({ d, icon, label, open?, fly? }; a `fly: k` row's
 * chip flies to node k), three `nodes` (the middle one has FKs in rows 1 and 2), the canvas card's
 * `tab` and `crumb`, the `beat` the files start flying on (+0.9 s, "…as a diagram") and `claims`
 * ([label, beat, offset]).
 */
export function hookScene({ tree: TREE, nodes: NODES, tab, crumb, beat, claims: CLAIMS }) {
  return {
  render(t, { beats }) {
    const flyAt = (k) => beats[beat].t + 0.9 + k * 0.38;   // from "…as a diagram"
    const FLY = 0.62;

    // Explorer tree
    let rows = '';
    TREE.forEach((r, i) => {
      const y = ROW0 + i * ROW;
      const at = 0.15 + i * 0.07;
      const hot = r.fly !== undefined ? seg(t, flyAt(r.fly) - 0.15, flyAt(r.fly)) : 0;
      const colour = r.icon === 'folder' ? '#7f8792' : '#5ca2f8';
      const chev = r.open ? ICON.chevDown({ size: 18, sw: 2.6 }) : '<span style="width:18px"></span>';
      rows += `<div class="abs" style="left:${TREE_X + 12}px;top:${y - 22}px;width:${TREE_W - 24}px;height:${ROW}px;border-radius:8px;background:rgba(92,162,248,${(0.16 * hot).toFixed(3)});${appear(t, at, { dy: 0, dx: -10 })}"></div>
        <div class="abs" style="left:${TREE_X + 28 + r.d * 30}px;top:${y - 16}px;display:flex;align-items:center;gap:10px;font-size:23px;color:${r.icon === 'folder' ? 'var(--text)' : '#c9ced6'};white-space:nowrap;${appear(t, at, { dy: 0, dx: -10 })}">
          <span style="color:var(--text-3)">${r.icon === 'folder' ? chev : '<span style="display:inline-block;width:18px"></span>'}</span>
          <span style="color:${colour}">${ICON[r.icon]({ size: 24 })}</span>${r.label}</div>`;
    });
    const tree = card({ x: TREE_X, y: TREE_Y, w: TREE_W, h: 600, tabs: [{ label: 'EXPLORER', on: true }], headStyle: 'letter-spacing:.08em;font-size:19px' });

    // Canvas + nodes
    const canvas = card({ x: CANVAS_BOX.x, y: CANVAS_BOX.y, w: CANVAS_BOX.w, h: CANVAS_BOX.h, tabs: [{ label: tab, on: true }], crumb, bodyCls: 'grid-bg', style: appear(t, 0.2) });

    // Until the first model lands, the empty canvas carries the app mark.
    const markOut = 1 - seg(t, flyAt(0), flyAt(0) + 0.4);
    const mark = markOut > 0
      ? `<div class="abs" style="left:${CANVAS_BOX.x}px;top:${CANVAS_BOX.y + 64}px;width:${CANVAS_BOX.w}px;height:${CANVAS_BOX.h - 64}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;opacity:${markOut.toFixed(3)}">
          <div style="${appear(t, beats[beat].t - 0.25, { dy: 12, dur: 0.5 })}">${appIcon(132)}</div>
          <div style="font-size:52px;font-weight:800;letter-spacing:-.03em;${appear(t, beats[beat].t - 0.05, { dy: 12, dur: 0.5 })}">ERD Studio</div></div>`
      : '';
    let nodes = mark, chips = '';
    NODES.forEach((n, k) => {
      const t0 = flyAt(k);
      const p = easeInOut(seg(t, t0, t0 + FLY));
      // file chip flies from its tree row to the node header
      const srcRow = TREE.findIndex((r) => r.fly === k);
      const sx = TREE_X + 28 + TREE[srcRow].d * 30 + 26, sy = ROW0 + srcRow * ROW - 22;
      const tx = n.x + 16, ty = n.y + 12;
      if (p > 0 && p < 1) {
        const x = lerp(sx, tx, p), y = lerp(sy, ty, p) - Math.sin(p * Math.PI) * 24;
        chips += `<div class="abs pill" style="left:${x}px;top:${y}px;background:#1b2a40;color:#cfe3ff;border:2px solid var(--logical);box-shadow:0 10px 30px #000a;opacity:${Math.min(1, p * 6, (1 - p) * 4).toFixed(2)}">${ICON.table({ size: 20 })}${n.name}</div>`;
      }
      const landed = t0 + FLY - 0.12;
      if (t >= landed) nodes += node({ x: n.x, y: n.y, w: W, name: n.name, cols: n.cols, style: appear(t, landed, { dur: 0.35, dy: 10 }) });
    });

    // Edges once all three nodes are down
    const eAt = flyAt(2) + FLY + 0.1;
    const f = NODES[1];
    const c1y = f.y + rowY(1, false), c2y = f.y + rowY(2, false);
    const dc = NODES[0], dp = NODES[2];
    const dh = nodeHeight(dc.cols.length, false), ph = nodeHeight(dp.cols.length, false);
    const e1 = edge([[dc.x + 60, dc.y + dh], [dc.x + 60, c1y], [f.x, c1y]], { progress: seg(t, eAt, eAt + 0.55), one: [dc.x + 72, dc.y + dh + 26], many: [f.x - 26, c1y - 6] });
    const e2 = edge([[dp.x + W - 60, dp.y + ph], [dp.x + W - 60, c2y], [f.x + W, c2y]], { progress: seg(t, eAt + 0.2, eAt + 0.75), one: [dp.x + W - 50, dp.y + ph + 26], many: [f.x + W + 10, c2y - 6] });

    // "No AI needed, and nothing to configure." — three claims, top right above the canvas
    // "…DBML files" (+2.4 s into the first line), then "No AI needed" and "nothing to configure"
    const claims = CLAIMS.map(([label, b, offset]) => [label, beats[b].t + offset])
      .map(([label, at]) => `<span class="pill" style="font-size:26px;padding:12px 24px;background:#13301f;border:2px solid #1f6b3a;color:#dff7e8;${appear(t, at, { dy: 10 })}"><span style="color:var(--green);display:flex">${ICON.check({ size: 24 })}</span>${label}</span>`)
      .join('');
    const pills = `<div class="abs" style="right:96px;top:236px;display:flex;gap:16px">${claims}</div>`;

    return `${tree}${rows}${canvas}${e1}${e2}${nodes}${chips}${pills}`;
  },
  };
}


const TREE = [
  { d: 0, icon: 'folder', label: 'shop-analytics', open: true },
  { d: 1, icon: 'folder', label: '.erd-studio', open: true },
  { d: 2, icon: 'folder', label: 'main', open: true },
  { d: 3, icon: 'folder', label: 'diagrams', open: true },
  { d: 4, icon: 'file', label: 'orders.dbml' },
  { d: 3, icon: 'folder', label: 'relationships', open: true },
  { d: 4, icon: 'file', label: 'main.dbml' },
  { d: 3, icon: 'folder', label: 'tables', open: true },
  { d: 4, icon: 'folder', label: 'main', open: true },
  // VS Code's order; each file flies to its own node (fct_order is the middle one)
  { d: 5, icon: 'file', label: 'dim_customer.dbml', fly: 0 },
  { d: 5, icon: 'file', label: 'dim_product.dbml', fly: 2 },
  { d: 5, icon: 'file', label: 'fct_order.dbml', fly: 1 },
];

const CANVAS = { x: 704, y: 322 };
const NODES = [
  { name: 'dim_customer', x: CANVAS.x + 20, y: CANVAS.y + 92,
    cols: [{ key: 'PK', name: 'customer_key', type: 'INTEGER' }, { name: 'customer_id', type: 'VARCHAR' }, { name: 'name', type: 'VARCHAR' }] },
  { name: 'fct_order', x: CANVAS.x + 385, y: CANVAS.y + 222,
    cols: [{ key: 'PK', name: 'order_id', type: 'INTEGER' }, { key: 'FK', name: 'customer_key', type: 'INTEGER' }, { key: 'FK', name: 'product_key', type: 'INTEGER' }, { name: 'amount', type: 'DECIMAL' }] },
  { name: 'dim_product', x: CANVAS.x + 750, y: CANVAS.y + 92,
    cols: [{ key: 'PK', name: 'product_key', type: 'INTEGER' }, { name: 'product_name', type: 'VARCHAR' }, { name: 'price', type: 'DECIMAL' }] },
];

export default hookScene({
  tree: TREE, nodes: NODES, tab: 'orders.dbml', crumb: '.erd-studio › main › diagrams › orders.dbml', beat: 'model',
  // h_model: "Your data model,"(+0.0–0.8) "as a diagram,"(+1.1–1.8) "saved as DBML files"(+2.1–3.1)
  // "in your repo."(+3.1–4.0); h_noai: "No AI needed,"(+0.0–1.09) "and nothing to configure."(+1.36–2.58)
  claims: [['DBML files in Git', 'model', 2.4], ['No AI needed', 'noai', 0.1], ['Nothing to configure', 'noai', 1.4]],
});
