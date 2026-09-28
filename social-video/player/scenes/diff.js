// 8 · diff — the payoff. The physical canvas from the previous scene; a pointer clicks Diff
// and the three kinds of drift in STORY.drift light up one by one, each on the word that names
// it, drawn the way the real canvas draws them: a physical-only row highlighted with an
// "only in dbt" pill plus the logical-only row struck through, a type mismatch with both
// stages' types stacked, and the logical relationship ghosted as a dashed amber edge because
// dbt has no relationships test for it. A numbered list under the canvas names each one.
import { appear, card, COLORS, easeOut, edge, ICON, lerp, node, path, pointer, rowY, seg, STORY, toolbar } from '../lib.js';

// Canvas geometry: identical to physical.js so the cut between the scenes is seamless.
const CX = 64, CY = 300, CW = 952, CH = 550;
const TBX = CX + 24, TBY = CY + 64 + 16;
const NY = CY + 186;
const DX = CX + 20, DW = 350;
const FX = DX + DW + 82, FW = 490;
const MIDX = (DX + DW + FX) / 2;
const DIFF_BTN = { x: 584, y: 416 };                 // centre of the toolbar's Diff button

const D = STORY.drift;
const hump = (t, a, up, down) => (t < a ? 0 : t < a + up ? seg(t, a, a + up) : 1 - seg(t, a + up, a + up + down));

/** Numbered amber marker (canvas gutter and list). */
function marker(n, cx, cy, t, at, glow) {
  const p = easeOut(seg(t, at, at + 0.3));
  if (p <= 0) return '';
  const s = lerp(0.6, 1, p);
  return `<div class="abs" style="left:${cx - 18}px;top:${cy - 18}px;width:36px;height:36px;border-radius:50%;background:var(--amber);color:#1a1405;font-size:22px;font-weight:800;display:flex;align-items:center;justify-content:center;opacity:${p.toFixed(3)};transform:scale(${s.toFixed(3)});box-shadow:0 0 0 ${(4 + 8 * glow).toFixed(1)}px rgba(244,180,44,${(0.18 + 0.3 * glow).toFixed(2)})">${n}</div>`;
}

const mono = (s, c) => `<span class="mono" style="color:${c};font-size:25px">${s}</span>`;

export default {
  render(t, { beats }) {
    const B = beats.best.t, P = beats.press.t, L = beats.lights.t;
    const click = P + 0.3;          // "Press Diff." — the click lands on "Diff"
    const r1 = L + 0.1;             // clip 0.00 s → "A renamed column"
    const r2 = L + 1.3;             // clip 1.26 s → "a wrong type"
    const r3 = L + 2.25;            // clip 2.19 s → "a missing relationship"
    const lit = L + 4.45;           // clip ~4.5 s → "…lights up"
    const ships = L + 5.05;         // clip 5.10 s → "before it ships"
    const glow = hump(t, lit, 0.25, 0.7);

    const diffOn = t >= click;
    let html = card({ x: CX, y: CY, w: CW, h: CH, tabs: [{ label: 'orders.json', on: true }], crumb: '.erd-studio › silver', bodyCls: 'grid-bg' });
    html += toolbar({ x: TBX, y: TBY, domain: STORY.domain, layer: STORY.layer, stage: 'physical', diff: diffOn ? 'amber' : 'off' });

    // Right of the toolbar: "What dbt builds" (carried over), replaced by the running count.
    const pillY = TBY + 12, pillR = 1080 - (CX + CW - 24);
    const n = (t >= r1) + (t >= r2) + (t >= r3);
    if (n === 0) {
      html += `<span class="abs pill" style="right:${pillR}px;top:${pillY}px;font-size:24px;padding:8px 18px;background:#13301f;color:var(--green);border:1px solid #1f5a35;opacity:${(1 - seg(t, click, click + 0.25)).toFixed(3)}">${ICON.lock({ size: 20 })}What dbt builds</span>`;
    } else {
      const pop = 1 + 0.06 * hump(t, [r1, r2, r3][n - 1], 0.12, 0.25) + 0.08 * glow;
      html += `<span class="abs pill" style="right:${pillR}px;top:${pillY}px;font-size:24px;padding:8px 18px;background:var(--amber-row);color:var(--amber);border:1px solid #6b5420;transform:scale(${pop.toFixed(3)});transform-origin:100% 50%;${appear(t, r1, { dy: 6 })}">${ICON.warn({ size: 22 })}${n} difference${n > 1 ? 's' : ''}</span>`;
    }

    // 3 · the logical relationship, missing from dbt (no relationships test): dashed amber ghost.
    const sy = NY + rowY(0), cy = NY + rowY(1);
    if (t >= r3) {
      html += edge([[DX + DW, sy], [MIDX, sy], [MIDX, cy], [FX, cy]], {
        color: COLORS.amber, dash: true, width: 3.5, one: [DX + DW + 8, sy - 10], many: [FX - 22, cy - 8], opacity: easeOut(seg(t, r3, r3 + 0.35)),
      });
    }

    // Row highlight: amber background + left bar, fading in on the reveal.
    const hot = (at) => {
      const a = easeOut(seg(t, at, at + 0.3));
      const f = 0.35 * hump(t, at, 0.15, 0.5) + 0.35 * glow;
      return a > 0 ? `background:rgba(${Math.round(lerp(56, 92, f))},${Math.round(lerp(48, 74, f))},${Math.round(lerp(28, 30, f))},${a.toFixed(3)});box-shadow:inset 5px 0 0 rgba(244,180,44,${a.toFixed(3)});` : '';
    };
    const pill = (label, at, style) => `<span class="pill" style="font-size:17px;padding:3px 9px;margin-left:4px;${style};${appear(t, at + 0.1, { dy: 0, dx: 10 })}">${label}</span>`;

    // 1 · renamed: physical has order_amt (only in dbt); logical's order_total appears struck through.
    const grow = easeOut(seg(t, r1 + 0.05, r1 + 0.4));
    const cols = [
      { key: 'PK', name: 'order_id', type: 'INT' },
      { key: 'FK', name: 'customer_id', type: 'INT' },
      t >= r2
        ? { name: D.type.column, types: [['logical', D.type.logical, COLORS.logical], ['physical', D.type.physical, COLORS.physical]], rowStyle: hot(r2) }
        : { name: D.type.column, type: D.type.physical },
      t >= r1
        ? { name: D.renamed.physical, type: 'DECIMAL(12,2)', rowStyle: hot(r1), pill: pill('only in dbt', r1, 'background:var(--amber);color:#1a1405') }
        : { name: D.renamed.physical, type: 'DECIMAL(12,2)' },
    ];
    if (t >= r1) {
      cols.push({ name: D.renamed.logical, type: '', strike: true, rowStyle: `height:${(46 * grow).toFixed(1)}px;overflow:hidden;opacity:${grow.toFixed(3)};${hot(r1)}`,
        pill: `<span class="pill" style="font-size:17px;padding:3px 11px;border:1.5px solid var(--logical);color:var(--logical)">logical only</span>` });
    }
    html += node({ x: DX, y: NY, w: DW, name: 'dim_customer', layer: STORY.layer, grain: STORY.dim_customer.grain, cols: STORY.dim_customer.cols, stage: 'physical', lock: true });
    html += node({ x: FX, y: NY, w: FW, name: 'fct_order', layer: STORY.layer, grain: STORY.fct_order.grain, cols, stage: 'physical', lock: true });

    // Gutter markers: 3 on the ghost edge, 2 on order_date, 1 between order_amt / order_total.
    html += marker(3, MIDX, sy - 46, t, r3 + 0.1, glow);   // above the ghost edge, clear of it
    html += marker(2, MIDX, NY + rowY(2), t, r2 + 0.1, glow);
    html += marker(1, MIDX, NY + rowY(3) + 23 * grow, t, r1 + 0.1, glow);

    // "Caught before it ships" under dim_customer.
    html += `<div class="abs" style="left:${DX}px;top:${NY + 264}px;width:${DW}px;padding:12px 20px;border-radius:14px;border:2px solid #1f5a35;background:#132a1c;display:flex;align-items:center;gap:14px;${appear(t, ships, { dy: 10 })}">
      <span class="tick tick--ok" style="width:40px;height:40px">${ICON.check({ size: 24 })}</span>
      <div style="font-size:26px;font-weight:700;line-height:1.2;color:var(--text)">Caught before<br><span style="color:var(--green)">it ships</span></div></div>`;

    // Numbered list under the canvas, one row per reveal.
    const rows = [
      { at: r1, title: 'Renamed column', detail: `${mono(D.renamed.logical, COLORS.logical)}<span style="color:var(--text-3)">${ICON.arrow({ size: 24 })}</span>${mono(D.renamed.physical, COLORS.physical)}` },
      { at: r2, title: 'Wrong type', detail: `${mono(D.type.column, 'var(--text)')}${mono(D.type.logical, COLORS.logical)}<span style="color:var(--amber)">${ICON.neq({ size: 24 })}</span>${mono(D.type.physical, COLORS.physical)}` },
      { at: r3, title: 'Missing relationship', detail: `<span style="font-size:25px;color:var(--text-2)">no relationships test in dbt</span>` },
    ];
    rows.forEach((r, i) => {
      const y = CY + CH + 18 + i * 74;
      const f = 0.5 * hump(t, r.at, 0.15, 0.6) + glow;
      html += `<div class="abs" style="left:${CX}px;top:${y}px;width:${CW}px;height:64px;border-radius:14px;background:var(--amber-row);border:1px solid rgba(244,180,44,${(0.28 + 0.5 * f).toFixed(2)});box-shadow:0 0 ${(24 * f).toFixed(1)}px rgba(244,180,44,${(0.35 * f).toFixed(2)});display:flex;align-items:center;gap:16px;padding:0 22px;white-space:nowrap;${appear(t, r.at, { dy: 12 })}">
        <span style="width:36px;height:36px;border-radius:50%;background:var(--amber);color:#1a1405;font-size:22px;font-weight:800;display:flex;align-items:center;justify-content:center;flex:none">${i + 1}</span>
        <span style="width:300px;flex:none;font-size:27px;font-weight:700;color:var(--amber)">${r.title}</span>
        <span style="display:flex;align-items:center;gap:12px">${r.detail}</span></div>`;
    });

    // The pointer: in on "Now the best part", clicks Diff on "Diff", then leaves.
    if (t >= B + 0.2 && t < click + 1.1) {
      const pt = path(t, [{ t: B + 0.2, x: 860, y: 800 }, { t: click - 0.12, x: DIFF_BTN.x, y: DIFF_BTN.y }, { t: click + 0.5, x: DIFF_BTN.x }, { t: click + 1.1, x: DIFF_BTN.x + 90, y: DIFF_BTN.y + 170 }].map((w) => ({ y: DIFF_BTN.y, ...w })));
      const op = Math.min(seg(t, B + 0.2, B + 0.45), 1 - seg(t, click + 0.6, click + 1.1));
      html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, click, click + 0.4))}</div>`;
    }
    return html;
  },
};
