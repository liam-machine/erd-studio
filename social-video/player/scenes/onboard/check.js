// onboard/check · "Switch to Physical to see what dbt really built, / and Compare to spot where
// the design and the code disagree." The laid-out canvas from onboard/canvas, as the first run
// really behaves.
//
// On `physical` the pointer clicks the Physical tab: it turns green with the lock, the node
// borders and edges blend blue -> green, read-only tabs appear over the nodes, and the column
// types the draft left `unknown` fill in (the Physical stage reads catalog.json; Draw from dbt
// does not). A note says where Physical is read from. On `compare` we stay on Physical (the
// headline is about what dbt built): the pointer hovers Diff, whose real tooltip reads
// "Compare across stages" (so a muted viewer can map the narration's "Compare" to the button),
// and clicks it. With one comparison on offer the real button toggles straight to "⊘ Diff" (no
// dropdown: Toolbar.tsx calls handleDiscrepancySelect directly when discrepancyOptions has one
// entry), amber while on. A freshly drawn design is a copy of the same dbt project, so the
// result is the discrepancy panel's own "All matched": a green pass sweeps the four nodes, each
// gets a tick, and the frame holds on a slow push-in.
//
// Canvas geometry mirrors onboard/canvas.js exactly (ORDERS_LAYOUT).
import { appear, card, COLORS, easeInOut, easeOut, edge, ICON, lerp, mix, node, path, pointer, seg, toolbar } from '../../lib.js';

// ---- geometry: ORDERS_LAYOUT (mirrors onboard/canvas.js) ----
const CX = 64, CY = 300, CW = 952, CH = 786;
const TBX = CX + 24, TBY = CY + 64 + 16;
const LX = 84, LW = 410;
const RX = 552, RW = 424;
const TOP = 500, BOT = 850;
const MIDX = (LX + LW + RX) / 2;
const RIGHT = RX + RW + 22;
const ry = (top, i) => top + 62 + i * 46 + 23;
const nh = (rows) => 62 + rows * 46 + 6;
// the notes sit in the clear gap between dim_customers (ends TOP + nh(2)) and dim_products' lock tab (BOT - 36)
const GAP_Y = TOP + nh(2) + 20;

// Toolbar hit points (measured from the rendered toolbar at TBX/TBY).
const TAB_PHYSICAL = { x: 432, y: 414 };
const DIFF_BTN = { x: 562, y: 414 };

// The four models: the draft's `unknown` types (logical) and what catalog.json reports (physical).
const MODELS = [
  { name: 'dim_customers', x: LX, y: TOP, w: LW, cols: [['PK', 'customer_id', 'VARCHAR'], ['', 'customer_name', 'VARCHAR']] },
  { name: 'fct_orders', x: RX, y: TOP, w: RW, cols: [['PK', 'order_id', 'VARCHAR'], ['FK', 'customer_id', 'VARCHAR'], ['', 'order_date', 'DATE'], ['', 'order_total', 'DECIMAL(16,2)']] },
  { name: 'fct_order_items', x: RX, y: BOT, w: RW, cols: [['PK', 'order_item_id', 'VARCHAR'], ['FK', 'order_id', 'VARCHAR'], ['FK', 'product_id', 'VARCHAR']] },
  { name: 'dim_products', x: LX, y: BOT, w: LW, cols: [['PK', 'product_id', 'VARCHAR'], ['', 'product_name', 'VARCHAR'], ['', 'product_price', 'DECIMAL(16,2)']] },
];

const hump = (t, a, up, down) => (t < a ? 0 : t < a + up ? seg(t, a, a + up) : 1 - seg(t, a + up, a + up + down));

export default {
  render(t, { beats, dur }) {
    const P = beats.physical.t, C = beats.compare.t;
    // o_physical: "Switch to Physical"(+0.0-0.90) "to see what dbt really built"(+1.07-2.70)
    const clickPhys = P + 0.5;          // "…Physical"
    const typesAt = clickPhys + 0.45;   // types fill in as the stage settles
    const readAt = P + 1.2;             // "to see what dbt really built"
    const readOut = C - 0.35;           // gone before the Diff moment
    // o_compare: "and"(+0.0-0.68) "Compare"(+0.74-0.93) "to spot where … disagree"(+1.13-2.87)
    const hoverAt = C + 0.1;            // pointer arrives on Diff: tooltip "Compare across stages"
    const clickDiff = C + 0.8;          // "Compare" ends
    const sweepAt = C + 1.2;            // "to spot where…": the green pass over the nodes
    const matchedAt = C + 1.55;         // the "All matched" result
    const pushAt = C + 2.0;             // slow push-in over the hold

    // stage blend: 0 logical .. 1 physical
    const p = easeInOut(seg(t, clickPhys, clickPhys + 0.6));
    const physical = t >= clickPhys;
    const diffOn = t >= clickDiff;
    const edgeCol = mix(COLORS.logical, COLORS.physical, p);
    const typeP = easeOut(seg(t, typesAt, typesAt + 0.5));

    let html = card({ x: CX, y: CY, w: CW, h: CH, tabs: [{ label: 'orders.json', on: true }], crumb: '.erd-studio › gold', bodyCls: 'grid-bg' });
    html += toolbar({ x: TBX, y: TBY, domain: 'orders', layer: 'GLD', stage: physical ? 'physical' : 'logical', diff: diffOn ? 'amber' : 'off' });

    // ---- everything on the canvas below the toolbar, in one group for the push-in ----
    let g = '';
    // edges: the relationship tests, so they stay in Physical too
    g += edge([[RX, ry(TOP, 1)], [MIDX, ry(TOP, 1)], [MIDX, ry(TOP, 0)], [LX + LW, ry(TOP, 0)]], { color: edgeCol, many: [RX - 22, ry(TOP, 1) - 8], one: [LX + LW + 8, ry(TOP, 0) - 10] });
    g += edge([[RX + RW, ry(BOT, 1)], [RIGHT, ry(BOT, 1)], [RIGHT, ry(TOP, 0)], [RX + RW, ry(TOP, 0)]], { color: edgeCol, many: [RX + RW + 4, ry(BOT, 1) - 8], one: [RX + RW + 6, ry(TOP, 0) - 10] });
    g += edge([[RX, ry(BOT, 2)], [MIDX, ry(BOT, 2)], [MIDX, ry(BOT, 0)], [LX + LW, ry(BOT, 0)]], { color: edgeCol, many: [RX - 22, ry(BOT, 2) - 8], one: [LX + LW + 8, ry(BOT, 0) - 10] });

    const lock = p > 0.02;
    const lockOp = lock ? `opacity:${seg(p, 0.4, 1).toFixed(3)};` : '';
    MODELS.forEach((m, i) => {
      const cols = m.cols.map(([key, name, type], r) => ({ key: key || undefined, name, type: `@@${i}_${r}@@` }));
      let h = stripNodeOpacity(node({ x: m.x, y: m.y, w: m.w, name: m.name, layer: 'GLD', stage: p, lock, style: lockOp, cols }));
      // the type cell: `unknown` (dim) cross-fades to the catalog's type, row by row
      m.cols.forEach(([, , type], r) => {
        const q = easeOut(seg(typeP, r * 0.12, r * 0.12 + 0.6));
        const cell = q <= 0
          ? `<span style="color:var(--text-3);font-style:italic">unknown</span>`
          : q >= 1 ? type
            : `<span style="display:inline-grid;justify-items:end"><span style="grid-area:1/1;color:var(--text-3);font-style:italic;opacity:${(1 - q).toFixed(3)}">unknown</span><span style="grid-area:1/1;opacity:${q.toFixed(3)}">${type}</span></span>`;
        h = h.replace(`@@${i}_${r}@@`, cell);
      });
      g += h;
    });

    // green pass over the nodes, then a tick on each (the comparison found them all matched)
    MODELS.forEach((m, i) => {
      const at = sweepAt + i * 0.12;
      const a = hump(t, at, 0.2, 0.7);
      const hh = nh(m.cols.length);
      if (a > 0) g += `<div class="abs" style="left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${hh}px;border-radius:16px;box-sizing:border-box;border:3px solid rgba(34,197,94,${a.toFixed(3)});background:rgba(34,197,94,${(0.1 * a).toFixed(3)});box-shadow:0 0 ${(36 * a).toFixed(1)}px rgba(34,197,94,${(0.55 * a).toFixed(3)})"></div>`;
      if (t >= at + 0.1) {
        g += `<span class="abs" style="left:${m.x + m.w - 22}px;top:${m.y - 18}px;width:40px;height:40px;border-radius:50%;background:${COLORS.green};color:#06210f;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px #000a;${appear(t, at + 0.1, { dy: 0, dur: 0.25 })}">${ICON.check({ size: 26 })}</span>`;
      }
    });

    // where Physical comes from: in the gap under dim_customers
    const readOp = Math.min(easeOut(seg(t, readAt, readAt + 0.35)), 1 - seg(t, readOut, readOut + 0.3));
    if (readOp > 0) {
      g += `<div class="abs" style="left:${LX}px;top:${GAP_Y}px;width:${RX - 30 - LX}px;box-sizing:border-box;padding:14px 20px;border-radius:14px;background:#13301f;border:2px solid #1f5a35;opacity:${readOp.toFixed(3)};transform:translateY(${(10 * (1 - easeOut(seg(t, readAt, readAt + 0.35)))).toFixed(1)}px)">
        <div style="display:flex;align-items:center;gap:10px;font-size:27px;font-weight:700;color:var(--green);white-space:nowrap">${ICON.lock({ size: 22 })}Read from your dbt project</div>
        <div style="margin-top:6px;font-size:26px;color:#d9fbe5;white-space:nowrap">schema .yml · manifest · catalog</div></div>`;
    }

    // the result, in the same gap: the discrepancy panel's own words
    if (t >= matchedAt) {
      const pop = 1 + 0.05 * hump(t, matchedAt + 0.1, 0.15, 0.3);
      g += `<div class="abs" style="left:${LX}px;top:${GAP_Y}px;width:${RX - 30 - LX}px;box-sizing:border-box;padding:16px 20px;border-radius:14px;background:#13301f;border:2px solid var(--green);transform:scale(${pop.toFixed(3)});transform-origin:50% 50%;${appear(t, matchedAt, { dy: 12 })}">
        <div style="display:flex;align-items:center;gap:12px;font-size:32px;font-weight:800;color:var(--green);white-space:nowrap"><span style="width:38px;height:38px;border-radius:50%;background:var(--green);color:#06210f;display:flex;align-items:center;justify-content:center">${ICON.check({ size: 26 })}</span>All matched</div>
        <div style="margin-top:6px;font-size:26px;color:#d9fbe5;white-space:nowrap">The design matches dbt</div></div>`;
    }

    // slow push-in over the hold (about the canvas centre; stays inside the card)
    const push = 1 + 0.03 * easeInOut(seg(t, pushAt, dur));
    html += `<div class="abs" style="left:0;top:0;width:1080px;height:1350px;transform:scale(${push.toFixed(4)});transform-origin:540px 752px">${g}</div>`;

    // ---- the Diff tooltip (the button's real title) ----
    const tipOp = Math.min(seg(t, hoverAt + 0.1, hoverAt + 0.3), 1 - seg(t, clickDiff, clickDiff + 0.15));
    if (tipOp > 0) {
      html += `<div class="abs" style="left:${DIFF_BTN.x - 60}px;top:${DIFF_BTN.y + 44}px;padding:10px 18px;border-radius:8px;background:#252629;border:1px solid #454545;box-shadow:0 8px 24px #000c;font-size:26px;color:var(--text);white-space:nowrap;opacity:${tipOp.toFixed(3)}">Compare across stages</div>`;
    }

    // ---- pointer: Physical, then Diff ----
    if (t < clickDiff + 1.2) {
      const pt = path(t, [
        { t: 0.05, x: 700, y: 760 },
        { t: clickPhys - 0.1, ...TAB_PHYSICAL },
        { t: clickPhys + 0.6, ...TAB_PHYSICAL },
        { t: clickPhys + 1.3, x: 800, y: 784 },
        { t: C - 0.45, x: 800, y: 784 },
        { t: hoverAt, ...DIFF_BTN },
        { t: clickDiff + 0.3, ...DIFF_BTN },
        { t: clickDiff + 1.2, x: DIFF_BTN.x + 120, y: DIFF_BTN.y + 150 },
      ]);
      const press = t < C ? seg(t, clickPhys, clickPhys + 0.4) : seg(t, clickDiff, clickDiff + 0.4);
      const op = Math.min(seg(t, 0.05, 0.3), 1 - seg(t, clickDiff + 0.5, clickDiff + 1.1));
      html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, press)}</div>`;
    }
    return html;
  },
};

/** node() puts `style` on the lock tab and the node; keep the node box itself opaque. */
function stripNodeOpacity(h) {
  return h.replace(/(<div class="node" style="[^"]*?)opacity:[\d.]+;/, '$1');
}
