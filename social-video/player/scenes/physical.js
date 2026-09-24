// 7 · physical — the same canvas flips from Logical (blue, the design) to Physical (green,
// read-only, derived from the dbt project). Physical shows what dbt actually has: the renamed
// column, the real type and no edge (there is no relationships test) — quietly, so the Diff
// scene can light those up. On "read straight from your project" the four sources the physical
// stage reads feed up into the canvas.
import { appear, card, COLORS, easeInOut, easeOut, edge, ICON, lerp, node, rowY, seg, STORY, toolbar } from '../lib.js';

// Canvas geometry (shared by eye with diff.js so the cut between the scenes is seamless).
const CX = 64, CY = 300, CW = 952, CH = 550;
const TBX = CX + 24, TBY = CY + 64 + 16;
const NY = CY + 186;                                // node tops (clear of the read-only tabs)
const DX = CX + 20, DW = 350;                       // dim_customer
const FX = DX + DW + 82, FW = 490;                  // fct_order
const MIDX = (DX + DW + FX) / 2;

const CHIPS = ['models/*.sql', 'schema.yml', 'manifest.json', 'catalog.json'];

export default {
  render(t, { beats }) {
    const L = beats.logical.t, P = beats.physical.t;
    const mean = L + 1.25;          // "…what you mean"
    const flip = P + 0.05;          // "Physical…"
    const read = P + 2.55;          // clip +2.68 s → "read straight from your project"
    const p = easeInOut(seg(t, flip, flip + 0.6));
    const physical = t >= flip;

    let html = card({ x: CX, y: CY, w: CW, h: CH, tabs: [{ label: 'orders.json', on: true }], crumb: '.erd-studio › silver', bodyCls: 'grid-bg' });
    html += toolbar({ x: TBX, y: TBY, domain: STORY.domain, layer: STORY.layer, stage: physical ? 'physical' : 'logical' });

    // Stage pill at the right of the toolbar: blue "what you mean", then green "what dbt builds".
    const pillY = TBY + 12;
    if (!physical || p < 1) {
      html += `<span class="abs pill" style="right:${1080 - (CX + CW - 24)}px;top:${pillY}px;font-size:24px;padding:8px 18px;background:#1b2a40;color:var(--logical);border:1px solid #2d4a70;${appear(t, mean, { dy: 8 })}opacity:${(Math.min(easeOut(seg(t, mean, mean + 0.35)), 1 - p)).toFixed(3)}">${ICON.sparkle({ size: 20 })}What you mean</span>`;
    }
    if (physical) {
      html += `<span class="abs pill" style="right:${1080 - (CX + CW - 24)}px;top:${pillY}px;font-size:24px;padding:8px 18px;background:#13301f;color:var(--green);border:1px solid #1f5a35;${appear(t, flip + 0.3, { dy: 8 })}">${ICON.lock({ size: 20 })}What dbt builds</span>`;
    }

    // The logical relationship; the physical stage has none (no dbt relationships test).
    const sy = NY + rowY(0), cy = NY + rowY(1);
    html += edge([[DX + DW, sy], [MIDX, sy], [MIDX, cy], [FX, cy]], {
      color: COLORS.logical, one: [DX + DW + 8, sy - 10], many: [FX - 22, cy - 8], opacity: 1 - p,
    });

    // Rows cross-fade to what dbt has once the border is half way to green.
    const swap = p >= 0.5;
    const fade = swap ? seg(p, 0.5, 1) : 1 - seg(p, 0, 0.5);
    const cell = `opacity:${lerp(0.25, 1, fade).toFixed(3)}`;
    const lockOp = `opacity:${seg(p, 0.4, 1).toFixed(3)};`;
    const dimCols = STORY.dim_customer.cols.map((c) => ({ ...c }));
    const fctCols = [
      { key: 'PK', name: 'order_id', type: 'INT' },
      { key: 'FK', name: 'customer_id', type: 'INT' },
      { name: 'order_date', type: swap ? 'TIMESTAMP' : 'DATE', rowStyle: cell },
      { name: swap ? 'order_amt' : 'order_total', type: 'DECIMAL(12,2)', rowStyle: cell },
    ];
    const lock = p > 0.02;
    html += fixNodeOpacity(node({ x: DX, y: NY, w: DW, name: 'dim_customer', layer: STORY.layer, grain: STORY.dim_customer.grain, cols: dimCols, stage: p, lock, style: lock ? lockOp : '' }));
    html += fixNodeOpacity(node({ x: FX, y: NY, w: FW, name: 'fct_order', layer: STORY.layer, grain: STORY.fct_order.grain, cols: fctCols, stage: p, lock, style: lock ? lockOp : '' }));

    // Sources feed up into the canvas.
    const chipY = CY + CH + 70, chipH = 58, gap = 12;
    const widths = CHIPS.map((s) => Math.round(s.length * 14.4 + 50));
    const total = widths.reduce((a, b) => a + b, 0) + gap * (CHIPS.length - 1);
    let x = 540 - total / 2;
    CHIPS.forEach((label, i) => {
      const at = read + i * 0.14;
      const w = widths[i], mx = x + w / 2;
      const lp = easeOut(seg(t, at + 0.15, at + 0.55));
      if (t >= at) {
        // connector: chip top -> card bottom, with an arrow head at the card
        const y0 = chipY - 4, y1 = CY + CH + 6, yy = lerp(y0, y1, lp);
        html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><path d="M${mx} ${y0} L${mx} ${yy.toFixed(1)}" stroke="${COLORS.green}" stroke-width="3" stroke-linecap="round"/>${lp > 0.95 ? `<path d="M${mx - 9} ${y1 + 10} L${mx} ${y1} L${mx + 9} ${y1 + 10}" fill="none" stroke="${COLORS.green}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : ''}</svg>`;
      }
      html += `<div class="abs mono" style="left:${x.toFixed(1)}px;top:${chipY}px;width:${w}px;height:${chipH}px;border-radius:14px;background:#13301f;border:2px solid #1f5a35;color:#d9fbe5;font-size:24px;display:flex;align-items:center;justify-content:center;gap:10px;white-space:nowrap;${appear(t, at, { dy: 22 })}"><span style="color:var(--green)">${ICON.file({ size: 20 })}</span>${label}</div>`;
      x += w + gap;
    });
    html += `<div class="abs" style="left:${CX}px;width:${CW}px;top:${chipY + chipH + 26}px;text-align:center;font-size:28px;font-weight:600;color:var(--text-2);white-space:nowrap;${appear(t, read + 0.7)}">Read from your dbt project <span style="color:var(--text-3)">·</span> <span style="color:var(--green)">nothing to maintain</span></div>`;
    return html;
  },
};

/** node() puts `style` on the lock tab and the node; strip the opacity from the node box. */
function fixNodeOpacity(h) {
  return h.replace(/(<div class="node" style="[^"]*?)opacity:[\d.]+;/, '$1');
}
