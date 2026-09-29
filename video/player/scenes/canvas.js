// 4 · "It reads your models and their relationship tests, / and lays out the diagram for you."
// The canvas opens on the new orders.json: the four drafted models land piled at one spot (a
// fresh domain paints before its first layout) while two source chips feed in from below. On
// `layout` the toolbar's Layout button spins (the canvas runs the same auto layout by itself on
// a fresh domain), the cards glide into place and the relationship edges draw in with 1 / *.
// Geometry is editor.js' MODELS, shared with the design and physical scenes.
import { appear, COLORS, easeInOut, easeOut, edge, ICON, lerp, seg, toolbar } from '../lib.js';
import { CANVAS, MODELS, editorWindow, orderEdges, orderNode } from '../editor.js';

const PILE = [{ x: 700, y: 480 }, { x: 740, y: 520 }, { x: 780, y: 560 }, { x: 820, y: 600 }];
const linkIcon = (size, col) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="7" height="6" rx="1.5"/><rect x="14.5" y="14" width="7" height="6" rx="1.5"/><path d="M9.5 7H12v10h2.5"/></svg>`;

export default {
  render(t, { beats }) {
    const R = beats.reads.t, L = beats.layout.t;
    // c_reads: "It reads your models"(+0.0–1.1) "and their relationship tests,"(+1.2–2.7)
    const nodeAt = (i) => R + 0.15 + i * 0.15;
    const chip1 = R + 0.5, chip2 = R + 1.4;
    const chipsOut = L + 0.1;
    // c_layout: "and lays out"(+0.0–0.7) "the diagram for you."(+0.7–1.66)
    const busyAt = L + 0.15;
    const glide = L + 0.35, glideEnd = glide + 1.0;
    const edgesAt = glideEnd - 0.1;

    let html = editorWindow({ tabs: [{ label: 'orders.json', on: true }], crumb: '.erd-studio › gold › orders.json', bodyCls: 'grid-bg' });
    const layout = t >= busyAt && t < glideEnd + 0.2 ? 'busy' : 'idle';
    html += toolbar({ x: CANVAS.toolbarX, y: CANVAS.toolbarY, stage: 'logical', layout, t });

    // source chips, feeding up into the pile
    const chipOp = 1 - seg(t, chipsOut, chipsOut + 0.3);
    if (chipOp > 0) {
      const chips = [
        { at: chip1, x: 560, w: 260, label: 'schema.yml', icon: `<span style="color:#d9b35a">${ICON.file({ size: 24 })}</span>` },
        { at: chip2, x: 860, w: 360, label: 'relationships tests', icon: linkIcon(26, COLORS.logical) },
      ];
      const chipY = 830;
      for (const c of chips) {
        if (t < c.at) continue;
        const lp = easeOut(seg(t, c.at + 0.15, c.at + 0.5));
        const mx = c.x + c.w / 2, y0 = chipY - 6, y1 = 790, yy = lerp(y0, y1, lp);
        html += `<svg class="abs" style="left:0;top:0;overflow:visible;opacity:${chipOp.toFixed(3)}" width="1" height="1"><path d="M${mx} ${y0} L${mx} ${yy.toFixed(1)}" stroke="${COLORS.logical}" stroke-width="3" stroke-linecap="round"/>${lp > 0.95 ? `<path d="M${mx - 10} ${y1 + 11} L${mx} ${y1} L${mx + 10} ${y1 + 11}" fill="none" stroke="${COLORS.logical}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : ''}</svg>`;
        html += `<div class="abs" style="left:${c.x}px;top:${chipY}px;width:${c.w}px;height:58px;border-radius:14px;background:#1b2a40;border:2px solid #2d4a70;color:#cfe3ff;font:500 24px var(--mono);display:flex;align-items:center;justify-content:center;gap:12px;white-space:nowrap;${appear(t, c.at, { dy: 20 })}${chipOp < 1 ? `opacity:${chipOp.toFixed(3)};` : ''}">${c.icon}${c.label}</div>`;
      }
    }

    // edges once the cards have landed
    const ep = easeOut(seg(t, edgesAt, edgesAt + 0.6));
    if (ep > 0) for (const [pts, many, one] of orderEdges()) html += edge(pts, { progress: ep, many, one });

    // the four cards: piled, then laid out
    MODELS.forEach((m, i) => {
      if (t < nodeAt(i)) return;
      const p = easeInOut(seg(t, glide + i * 0.07, glideEnd + i * 0.07));
      html += orderNode({ ...m, x: Math.round(lerp(PILE[i].x, m.x, p)), y: Math.round(lerp(PILE[i].y, m.y, p)) }, { style: appear(t, nodeAt(i), { dy: 16 }) });
    });
    return html;
  },
};
