// onboard/canvas · "It reads your models and your relationship tests, / and lays out the diagram
// for you. Nothing to drag." The hero moment of the DRAW chapter. On `copies` the canvas tab
// orders.json (.erd-studio › gold) opens and the four drafted models land stacked at one spot,
// as a fresh domain paints before its first layout, while two source chips ("schema.yml",
// "tests: relationships") feed into them from below. On `layout` the cards glide into a clean
// layout (the same ELK pass the canvas runs by itself on a fresh domain), the relationship
// edges draw in with their 1 / * marks and an "Auto layout" pill lands. On "Nothing to drag"
// the pointer rests still on empty canvas beside a struck-through move icon (no text: the caption says it).
//
// Canvas geometry is shared with onboard/check.js (same card, toolbar and node boxes) so the
// cut between the two scenes is seamless.
import { appear, card, COLORS, easeInOut, easeOut, edge, ICON, lerp, node, pointer, seg, toolbar } from '../../lib.js';

// Types: Draw from dbt copies each column's `data_type` from the schema .yml or the manifest and
// never reads catalog.json, so a project whose yml declares no types (the sample's marts do not)
// drafts every column as `unknown`. The real canvas prints that word; here it is drawn dim, and
// onboard/check fills the real types in on the Physical switch, where catalog.json supplies them.
//
// ---- geometry: ORDERS_LAYOUT (mirrored in onboard/check.js) ----
const CX = 64, CY = 300, CW = 952, CH = 786;          // editor card: the whole stage
const TBX = CX + 24, TBY = CY + 64 + 16;
const LX = 84, LW = 410;                              // left column: dim_customers, dim_products
const RX = 552, RW = 424;                             // right column: fct_orders, fct_order_items
const TOP = 500, BOT = 850;                           // row tops (clear of the physical lock tabs)
const MIDX = (LX + LW + RX) / 2;
const RIGHT = RX + RW + 22;                           // fct_order_items -> fct_orders runs down the right side
const ry = (top, i) => top + 62 + i * 46 + 23;        // row centre, no grain line (a draft has none yet)

const U = 'unknown';
const MODELS = [
  { name: 'dim_customers', x: LX, y: TOP, w: LW, cols: [{ key: 'PK', name: 'customer_id', type: U }, { name: 'customer_name', type: U }] },
  { name: 'fct_orders', x: RX, y: TOP, w: RW, cols: [{ key: 'PK', name: 'order_id', type: U }, { key: 'FK', name: 'customer_id', type: U }, { name: 'order_date', type: U }, { name: 'order_total', type: U }] },
  { name: 'fct_order_items', x: RX, y: BOT, w: RW, cols: [{ key: 'PK', name: 'order_item_id', type: U }, { key: 'FK', name: 'order_id', type: U }, { key: 'FK', name: 'product_id', type: U }] },
  { name: 'dim_products', x: LX, y: BOT, w: LW, cols: [{ key: 'PK', name: 'product_id', type: U }, { name: 'product_name', type: U }, { name: 'product_price', type: U }] },
];
// Where a fresh domain paints them before layout: piled up at one spot.
const PILE = [{ x: 250, y: 486 }, { x: 290, y: 528 }, { x: 330, y: 570 }, { x: 370, y: 612 }];

const moveIcon = (size, col) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>`;
const linkIcon = (size, col) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="7" height="6" rx="1.5"/><rect x="14.5" y="14" width="7" height="6" rx="1.5"/><path d="M9.5 7H12v10h2.5"/></svg>`;

export default {
  render(t, { beats }) {
    const C = beats.copies.t, L = beats.layout.t;
    const tabAt = C - 0.15;                 // the tab is open as the line starts
    const nodeAt = (i) => C + 0.25 + i * 0.16;  // "It reads your models" (clip 0.0-1.0 s)
    const chip1 = C + 0.45;                 // "…models"
    const chip2 = C + 1.3;                  // clip 1.2 s → "and your relationship tests"
    const chipsOut = L - 0.05;              // gone before the cards glide down over them
    const glide = L + 0.4;                  // clip 0.5 s → "lays out the diagram"
    const glideEnd = glide + 1.0;
    const edgesAt = glide + 0.85;
    const pillAt = L + 1.5;                 // clip 1.5 s → "…for you"
    const dragAt = L + 1.95;                // clip ~1.9 s → "Nothing to drag"

    let html = card({ x: CX, y: CY, w: CW, h: CH, tabs: [{ label: 'orders.json', on: true }], crumb: '.erd-studio › gold', bodyCls: 'grid-bg', style: appear(t, tabAt, { dy: 20 }) });
    html += toolbar({ x: TBX, y: TBY, domain: 'orders', layer: 'GLD', stage: 'logical', style: appear(t, tabAt + 0.2) });

    // ---- source chips, feeding up into the pile ----
    const chipOp = 1 - seg(t, chipsOut, chipsOut + 0.3);
    if (chipOp > 0) {
      const chips = [
        { at: chip1, x: 150, w: 250, label: 'schema.yml', icon: `<span style="color:#d9b35a">${ICON.file({ size: 24 })}</span>`, mono: true },
        { at: chip2, x: 430, w: 420, label: 'tests: relationships', icon: linkIcon(26, COLORS.logical), mono: true },
      ];
      const chipY = 978;
      chips.forEach((c) => {
        if (t < c.at) return;
        const lp = easeOut(seg(t, c.at + 0.15, c.at + 0.55));
        const mx = c.x + c.w / 2, y0 = chipY - 6, y1 = 870, yy = lerp(y0, y1, lp);
        html += `<svg class="abs" style="left:0;top:0;overflow:visible;opacity:${chipOp.toFixed(3)}" width="1" height="1"><path d="M${mx} ${y0} L${mx} ${yy.toFixed(1)}" stroke="${COLORS.logical}" stroke-width="3" stroke-linecap="round"/>${lp > 0.95 ? `<path d="M${mx - 10} ${y1 + 11} L${mx} ${y1} L${mx + 10} ${y1 + 11}" fill="none" stroke="${COLORS.logical}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : ''}</svg>`;
        html += `<div class="abs" style="left:${c.x}px;top:${chipY}px;width:${c.w}px;height:62px;border-radius:14px;background:#1b2a40;border:2px solid #2d4a70;color:#cfe3ff;font-size:26px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:12px;white-space:nowrap;${c.mono ? 'font-family:var(--mono);font-weight:500;' : ''}${appear(t, c.at, { dy: 22 })}${chipOp < 1 ? `opacity:${chipOp.toFixed(3)};` : ''}">${c.icon}${c.label}</div>`;
      });
    }

    // ---- edges (drawn once the cards have landed) ----
    const ep = easeOut(seg(t, edgesAt, edgesAt + 0.6));
    if (ep > 0) {
      const [dc, fo, fi, dp] = MODELS;
      // fct_orders.customer_id -> dim_customers.customer_id
      html += edge([[fo.x, ry(fo.y, 1)], [MIDX, ry(fo.y, 1)], [MIDX, ry(dc.y, 0)], [dc.x + dc.w, ry(dc.y, 0)]], { progress: ep, many: [fo.x - 22, ry(fo.y, 1) - 8], one: [dc.x + dc.w + 8, ry(dc.y, 0) - 10] });
      // fct_order_items.order_id -> fct_orders.order_id (down the right side)
      html += edge([[fi.x + fi.w, ry(fi.y, 1)], [RIGHT, ry(fi.y, 1)], [RIGHT, ry(fo.y, 0)], [fo.x + fo.w, ry(fo.y, 0)]], { progress: ep, many: [fi.x + fi.w + 4, ry(fi.y, 1) - 8], one: [fo.x + fo.w + 6, ry(fo.y, 0) - 10] });
      // fct_order_items.product_id -> dim_products.product_id
      html += edge([[fi.x, ry(fi.y, 2)], [MIDX, ry(fi.y, 2)], [MIDX, ry(dp.y, 0)], [dp.x + dp.w, ry(dp.y, 0)]], { progress: ep, many: [fi.x - 22, ry(fi.y, 2) - 8], one: [dp.x + dp.w + 8, ry(dp.y, 0) - 10] });
    }

    // ---- the four cards: piled, then laid out ----
    MODELS.forEach((m, i) => {
      if (t < nodeAt(i)) return;
      const p = easeInOut(seg(t, glide + i * 0.07, glideEnd + i * 0.07));
      const x = lerp(PILE[i].x, m.x, p), y = lerp(PILE[i].y, m.y, p);
      html += dimUnknown(node({ x: Math.round(x), y: Math.round(y), w: m.w, name: m.name, layer: 'GLD', cols: m.cols, style: appear(t, nodeAt(i), { dy: 18 }) }));
    });

    // ---- "Auto layout" pill, right of the toolbar ----
    if (t >= pillAt) {
      html += `<span class="abs pill" style="right:${1080 - (CX + CW - 24)}px;top:${TBY + 10}px;font-size:24px;padding:8px 18px;background:#1b2a40;color:#cfe3ff;border:1px solid #2d4a70;${appear(t, pillAt, { dy: 8 })}">${ICON.check({ size: 22, style: 'color:var(--logical)' })}Auto layout</span>`;
    }

    // ---- "Nothing to drag": the pointer rests on empty canvas, beside a struck-through move
    // icon (no text: the caption says it) ----
    if (t >= dragAt) {
      const px = 250, py = 712;               // empty canvas in the gap under dim_customers
      const ix = 290, iy = 742;               // the icon, just under the pointer
      html += `<div class="abs" style="left:${ix}px;top:${iy}px;${appear(t, dragAt, { dy: 8 })}">
        <span style="position:relative;display:flex;width:60px;height:60px;border-radius:50%;border:2px solid #4a5060;background:#1a1b1f;align-items:center;justify-content:center">${moveIcon(34, '#c9ced6')}
          <svg class="abs" style="left:0;top:0" width="60" height="60" viewBox="0 0 60 60"><path d="M12 48L48 12" stroke="${COLORS.amber}" stroke-width="4" stroke-linecap="round"/></svg></span></div>`;
      html += `<div class="abs" style="left:0;top:0;${appear(t, dragAt - 0.35, { dy: 0 })}">${pointer(px, py)}</div>`;
    }
    return html;
  },
};

/** The canvas prints a drafted column's `unknown` type; draw it dim so the empty slot reads as "not known yet". */
function dimUnknown(h) {
  return h.replaceAll('<span class="node__type">unknown</span>', '<span class="node__type" style="color:var(--text-3);font-style:italic">unknown</span>');
}
