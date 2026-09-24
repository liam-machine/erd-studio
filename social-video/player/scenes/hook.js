// 1 · Hook. The thumbnail frame: a real ERD (dim_customer <- fct_order) drawn upside down, dim
// and faintly amber: "we've built the data model backwards". On `loop` it turns the right way up,
// its borders go logical blue, and a pill says why this matters for AI.
// Fully drawn at t = 0 (no entrance on the diagram: this frame is the feed thumbnail).
import { COLORS, ICON, STORY, appear, easeInOut, edge, mix, node, nodeHeight, rowY, seg } from '../lib.js';

// Diagram group, in its own (unscaled) coordinates; rotated/scaled about its centre.
const GW = 780, GH = 564, SCALE = 1.15;
const CX = 540, CY = 640;                       // visual centre of the diagram on the frame
const DC = { x: 0, y: 0, w: 380 };
const FO = { x: 320, y: 270, w: 460 };
const MUTED = '#8a7442';                        // desaturated amber: the "wrong way" border

export default {
  render(t, { beats }) {
    const turn = beats.loop.t + 0.3;            // "+0.3 → 'Here's the fix'"
    const p = easeInOut(seg(t, turn, turn + 0.9));
    const colour = mix(MUTED, COLORS.logical, seg(t, turn + 0.35, turn + 0.9));
    const rot = 180 * (1 - p);
    // Largest scale at which the rotated box still fits between the headline and the pill row,
    // so the diagram pulls back as it turns and settles full size (pure function of the angle).
    const th = (rot * Math.PI) / 180, hw = GW / 2, hh = GH / 2;
    const vert = hw * Math.abs(Math.sin(th)) + hh * Math.abs(Math.cos(th));
    const horz = hw * Math.abs(Math.cos(th)) + hh * Math.abs(Math.sin(th));
    const sc = Math.min(SCALE, (CY - 300) / vert, 470 / horz);
    const grey = 0.7 * (1 - p), bright = 0.8 + 0.2 * p;

    // Relationship edge: down from dim_customer, across into fct_order.customer_id (the FK row).
    const sx = DC.x + DC.w / 2, sy = DC.y + nodeHeight(STORY.dim_customer.cols.length);
    const ty = FO.y + rowY(1);
    const e = edge([[sx, sy], [sx, ty], [FO.x, ty]], { color: colour, one: [sx + 12, sy + 30], many: [FO.x - 26, ty - 6] });

    const nodeStyle = `border-color:${colour};`;
    const dc = node({ ...DC, name: 'dim_customer', layer: STORY.layer, grain: STORY.dim_customer.grain, cols: STORY.dim_customer.cols, style: nodeStyle });
    const fo = node({ ...FO, name: 'fct_order', layer: STORY.layer, grain: STORY.fct_order.grain, cols: STORY.fct_order.cols, style: nodeStyle });

    // Soft glow behind the diagram: amber while it is wrong, blue once it is right.
    const glow = mix('#3a2c0e', '#132440', p);
    let html = `<div class="abs" style="left:${CX - 520}px;top:${CY - 400}px;width:1040px;height:800px;background:radial-gradient(closest-side, ${glow} 0%, transparent 100%);opacity:.9"></div>`;

    html += `<div class="abs" style="left:${CX - GW / 2}px;top:${CY - GH / 2}px;width:${GW}px;height:${GH}px;transform:rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(4)});transform-origin:50% 50%;filter:grayscale(${grey.toFixed(3)}) brightness(${bright.toFixed(3)})">${e}${dc}${fo}</div>`;

    // Thumbnail tag: what is wrong, in amber, until the diagram turns.
    const tagOp = 1 - seg(t, turn, turn + 0.3);
    if (tagOp > 0) {
      html += `<div class="abs" style="left:0;width:1080px;top:1010px;display:flex;justify-content:center;opacity:${tagOp.toFixed(3)}">
        <span class="pill" style="font-size:30px;padding:12px 28px;gap:14px;background:#2a2414;color:var(--amber);box-shadow:0 0 0 2px #f4b42c55, 0 12px 30px #0008">
          ${ICON.warn({ size: 28 })}drawn the wrong way up</span></div>`;
    }

    // The payoff pill, once the diagram has settled.
    const pillAt = turn + 0.85;                 // lands with "…why your AI needs it" (the caption says that; the pill names the fix)
    if (t >= pillAt) {
      html += `<div class="abs" style="left:0;width:1080px;top:1010px;display:flex;justify-content:center;${appear(t, pillAt, { dy: 10 })}">
        <span class="pill" style="font-size:30px;padding:12px 28px;gap:14px;background:#1b2a40;color:#cfe3ff;box-shadow:0 0 0 2px ${COLORS.logical}66, 0 12px 30px #0008">
          <span style="color:${COLORS.logical}">${ICON.check({ size: 28 })}</span>the right way up</span></div>`;
    }
    return html;
  },
};
