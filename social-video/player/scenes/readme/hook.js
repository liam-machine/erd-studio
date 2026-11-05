// readme · 1 · hook — "ERD Studio: free to use in VS Code." Frame 0 is finished (the first scene
// never fades in): the ERD Studio brand row above the logical diagram dim_customer ← fct_order,
// drawn the way the canvas draws it. `free`: "VS Code extension" and "Free to use" light on their
// words, then the four things a logical data model holds (tables, grain, keys, joins) light one
// by one under the diagram as "logical data model" is said. why.js then packs the diagram off
// into a separate tool.
import { appIcon, COLORS, easeOut, edge, ICON, node, rowY, seg } from '../../lib.js';
import { R, wordAt } from './story.js';

const X = 64, W = 952;
export const HOOK = { NY: 470, DX: 84, DW: 360, FX: 524, FW: 472 };
const { NY, DX, DW, FX, FW } = HOOK;
const MIDX = (DX + DW + FX) / 2;
const PILLS_Y = 860;

export default {
  render(t, { scene }) {
    const vsAt = wordAt(scene, 'free', 'VS Code');
    const freeAt = wordAt(scene, 'free', 'free');
    const modelAt = wordAt(scene, 'free', 'logical');
    const lit = [0, 1, 2, 3].map((k) => modelAt + 0.1 + k * 0.32);
    const on = lit.map((at) => easeOut(seg(t, at, at + 0.3)));
    const vs = easeOut(seg(t, vsAt, vsAt + 0.3)), free = easeOut(seg(t, freeAt, freeAt + 0.3));

    let html = '';
    // ---- brand row ----
    const pill = (label, p, rgb) => `<span class="pill" style="font-size:27px;padding:9px 22px;gap:10px;background:rgba(${rgb},${(0.05 + 0.13 * p).toFixed(3)});border:2px solid rgba(${rgb},${(0.25 + 0.7 * p).toFixed(3)});color:${p > 0.5 ? `rgb(${rgb})` : 'var(--text-3)'};transform:scale(${(1 + 0.07 * Math.sin(Math.PI * p)).toFixed(3)})">${p > 0.5 ? ICON.check({ size: 22 }) : ''}${label}</span>`;
    html += `<div class="abs" style="left:${X}px;width:${W}px;top:318px;display:flex;align-items:center;gap:18px;white-space:nowrap">
      ${appIcon(72)}<span style="font-size:44px;font-weight:800;letter-spacing:-.02em">ERD Studio</span><span style="flex:1"></span>
      ${pill('VS Code extension', vs, '96,165,250')}${pill('Free to use', free, '34,197,94')}</div>`;

    // ---- the logical diagram ----
    const sy = NY + rowY(0), fy = NY + rowY(1);
    html += edge([[DX + DW, sy], [MIDX, sy], [MIDX, fy], [FX, fy]], { color: COLORS.logical, width: 3 + 2 * on[3], one: [DX + DW + 8, sy - 10], many: [FX - 22, fy - 8] });
    if (on[3] > 0) html += `<svg class="abs" style="left:0;top:0;overflow:visible;opacity:${(0.5 * on[3]).toFixed(3)}" width="1" height="1"><path d="M${DX + DW} ${sy} H${MIDX} V${fy} H${FX}" fill="none" stroke="#60a5fa" stroke-width="14" stroke-linejoin="round" style="filter:blur(6px)"/></svg>`;
    const cols = (cs) => cs.map((c) => (c.key && on[2] > 0 ? { ...c, rowStyle: `background:rgba(244,180,44,${(0.16 * on[2]).toFixed(3)})` } : c));
    const headGlow = (p) => (p > 0 ? `box-shadow:0 0 0 ${(6 * p).toFixed(1)}px rgba(96,165,250,${(0.35 * p).toFixed(3)}),0 18px 44px #0009;` : '');
    html += node({ x: DX, y: NY, w: DW, name: R.dim_customer.name, layer: R.badge, grain: R.dim_customer.grain, cols: cols(R.dim_customer.cols), style: headGlow(on[0]) });
    html += node({ x: FX, y: NY, w: FW, name: R.fct_order.name, layer: R.badge, grain: R.fct_order.grain, cols: cols(R.fct_order.cols), style: headGlow(on[0]) });
    if (on[1] > 0) {
      [[DX, DW], [FX, FW]].forEach(([x, w]) => {
        html += `<div class="abs" style="left:${x + 3}px;top:${NY + 62 + 3}px;width:${w - 6}px;height:40px;background:rgba(34,197,94,${(0.16 * on[1]).toFixed(3)});box-shadow:inset 5px 0 0 rgba(34,197,94,${on[1].toFixed(3)})"></div>`;
      });
    }
    const P = [['Tables', '96,165,250'], ['Grain', '34,197,94'], ['Keys', '244,180,44'], ['Joins', '96,165,250']];
    html += `<div class="abs" style="left:${X}px;width:${W}px;top:${PILLS_Y}px;display:flex;justify-content:center;gap:18px">${P.map(([label, rgb], i) => {
      const p = on[i];
      return `<span class="pill" style="font-size:30px;padding:12px 28px;background:rgba(${rgb},${(0.06 + 0.12 * p).toFixed(3)});border:2px solid rgba(${rgb},${(0.25 + 0.7 * p).toFixed(3)});color:${p > 0.5 ? `rgb(${rgb})` : 'var(--text-3)'};transform:scale(${(1 + 0.08 * Math.sin(Math.PI * seg(t, lit[i], lit[i] + 0.35))).toFixed(3)})">${p > 0.5 ? ICON.check({ size: 24 }) : ''}${label}</span>`;
    }).join('')}</div>`;
    return html;
  },
};
