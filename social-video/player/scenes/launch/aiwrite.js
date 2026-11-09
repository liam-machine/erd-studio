// launch · 6 · aiwrite — "By hand, or with your AI." The README cut's aiwrite (readme/aiwrite.js),
// keyed to the launch line: "by hand" lights a chip, the prompt types on "ask your AI assistant",
// "skill" names the built-in skill Set Up My AI Helper adds, and the new table lands as "appears"
// is said. Otherwise as the README cut — `write`: a Claude Code session is asked
// for a date dimension; it writes dim_date.dbml and edits the relationships and diagram files (the
// real files an added, linked table touches), and the canvas below shows the new table and its
// relationship, with "review it, then commit", before anything is committed. Claude Code is the
// example: on "Whichever assistant" a pill on the session's tab row names the others the same
// skill works in. The scene holds briefly (minDur) on the canvas with the new table lit, and keeps
// moving through the hold — a light runs along the new Ref and the table's glow breathes — so the
// change the AI made reads before the dbt chapter without a still, silent frame.
import { appear, card, caret, COLORS, easeOut, edge, ICON, lerp, node, rowY, seg, spinner, tick, typed } from '../../lib.js';
import { FILE_COL, PATH, R, wordAt } from '../readme/story.js';

const X = 64, W = 952;
const PROMPT = 'add a date dimension and link order_date to it';

export default {
  render(t, { beats, scene }) {
    const Wr = beats.write.t;
    let html = '';
    // ================= write =================
    if (t >= 0) {
      const pAt = wordAt(scene, 'write', 'ask') - 0.2, pEnd = pAt + PROMPT.length / 45;
      // The skill loads first (on "skill"), then the three files a new, linked table touches.
      const s0 = Math.max(pEnd + 0.25, wordAt(scene, 'write', 'skill') - 0.2);
      const steps = [
        { at: s0, verb: 'Skill', path: 'erd-studio' },
        { at: s0 + 0.5, verb: 'Write', path: PATH.date },
        { at: s0 + 1.0, verb: 'Edit', path: PATH.rels },
        { at: s0 + 1.5, verb: 'Edit', path: PATH.diagram },
      ];
      const TY = 300, TH = 386;
      let tb = `<div class="abs" style="left:28px;top:20px;right:28px;display:flex;align-items:center;gap:14px;white-space:nowrap;font-size:26px"><span style="color:var(--text-2)">&gt;</span><span>${typed(PROMPT, t, pAt, 45)}</span>${t < steps[0].at ? caret(t, pEnd) : ''}</div>`;
      steps.forEach((st, i) => {
        if (t < st.at) return;
        const done = t >= st.at + 0.4;
        tb += `<div class="abs" style="left:28px;top:${82 + i * 56}px;height:46px;display:flex;align-items:center;gap:14px;white-space:nowrap;${appear(t, st.at, { dy: 0, dx: -10 })}">
          <span class="dot" style="background:${done ? 'var(--green)' : 'var(--text)'}"></span><span class="mono" style="font-size:22px;color:var(--text)">${st.verb}<span style="color:var(--text-2)">(${st.path})</span></span>${done ? tick('ok') : spinner(t, 24)}</div>`;
      });
      html += card({
        x: X, y: TY, w: W, h: TH, dots: true,
        tabs: [{ label: 'Claude Code', on: true, icon: `<span style="color:var(--claude)">${ICON.claude({ size: 20 })}</span>` }],
        // No repo crumb: the "or GitHub Copilot …" pill sits on the tab row.
        crumb: '', headStyle: 'font-size:22px', body: tb,
        style: appear(t, 0, { dy: 30, dur: 0.4 }),
      });
      const anyAt = wordAt(scene, 'write', 'assistant') - 0.2;
      if (t >= anyAt) {
        html += `<div class="abs" style="right:${1080 - (X + W) + 18}px;top:${TY + 13}px;${appear(t, anyAt, { dy: 0, dx: 10 })}"><span class="pill" style="font-size:18px;padding:5px 14px;background:#1c1e23;color:var(--text-2);border:1px solid #34363d">or GitHub Copilot · Codex · Gemini CLI · Cursor</span></div>`;
      }

      // The canvas: the new table and its relationship, not committed yet.
      const CY = TY + TH + 20, CH = 1088 - CY;
      const canvasAt = Wr + 0.3;
      const newAt = Math.max(steps[3].at + 0.3, wordAt(scene, 'write', 'appears') - 0.3);
      let cv = '';
      // The whole sales diagram, scaled to 0.72 inside the card body: dim_customer and its link as
      // before, fct_order with the status column the canvas and PR scenes added, and the AI's
      // dim_date arriving on the right with its relationship from order_date.
      const S8 = 0.72;
      const ox = X + 24, oy = CY + 80;
      const CUX = 0, CUW = 350, FX = 425, FW = 420, DX = 915, DW = 335;
      const ny = 40;
      const fcols = [...R.fct_order.cols, { name: R.newCol.name, type: R.newCol.type }];
      const cy1 = ny + rowY(0), fy1 = ny + rowY(1);
      const cmid = (CUX + CUW + FX) / 2;
      const ey1 = ny + rowY(2), ey2 = ny + rowY(0);
      const mid = (FX + FW + DX) / 2;
      let g = '';
      g += edge([[CUX + CUW, cy1], [cmid, cy1], [cmid, fy1], [FX, fy1]], { color: COLORS.logical, one: [CUX + CUW + 6, cy1 - 10], many: [FX - 22, fy1 - 8] });
      const np = easeOut(seg(t, newAt, newAt + 0.4));
      const refPts = [[FX + FW, ey1], [mid, ey1], [mid, ey2], [DX, ey2]];
      if (np > 0) {
        g += edge(refPts, { color: COLORS.logical, progress: easeOut(seg(t, newAt + 0.3, newAt + 0.8)), many: [FX + FW + 6, ey1 - 10], one: [DX - 20, ey2 - 10] });
      }
      // Through the hold: a green light runs along the new Ref, order_date → dim_date, every 1.4 s.
      const pulseFrom = newAt + 1.0;
      if (t >= pulseFrom) {
        let len = 0;
        for (let i = 1; i < refPts.length; i++) len += Math.hypot(refPts[i][0] - refPts[i - 1][0], refPts[i][1] - refPts[i - 1][1]);
        const ph = ((t - pulseFrom) % 1.4) / 1.4;
        const head = ph * (len + 90);
        const d = refPts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
        g += `<svg class="abs" style="left:0;top:0;overflow:visible;opacity:${(Math.min(1, seg(t, pulseFrom, pulseFrom + 0.3))).toFixed(3)}" width="1" height="1"><path d="${d}" fill="none" stroke="#4ade80" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="0 ${Math.max(0, head - 90).toFixed(1)} ${Math.min(90, head).toFixed(1)} ${(len + 200).toFixed(1)}" style="filter:drop-shadow(0 0 8px rgba(34,197,94,.8))"/></svg>`;
      }
      g += node({ x: CUX, y: ny, w: CUW, name: R.dim_customer.name, layer: R.badge, grain: R.dim_customer.grain, cols: R.dim_customer.cols });
      g += node({ x: FX, y: ny, w: FW, name: R.fct_order.name, layer: R.badge, grain: R.fct_order.grain, cols: fcols });
      if (np > 0) {
        g += node({ x: DX, y: ny, w: DW, name: R.dim_date.name, layer: R.badge, grain: R.dim_date.grain, cols: R.dim_date.cols,
          style: `opacity:${np.toFixed(3)};transform:translateY(${lerp(18, 0, np).toFixed(1)}px);box-shadow:0 0 0 ${(t < newAt + 1 ? 6 : 4.5 + 1.5 * Math.cos((t - newAt - 1) * Math.PI / 0.7)).toFixed(1)}px rgba(34,197,94,.45),0 18px 44px #0009;border-color:var(--green)` });
        g += `<div class="abs" style="left:${DX + DW - 120}px;top:${ny - 50}px;${appear(t, newAt + 0.2, { dy: 6 })}"><span class="pill" style="font-size:24px;padding:4px 14px;background:#13301f;color:var(--green);border:1px solid #1f6b3a">${ICON.plus({ size: 18 })}new</span></div>`;
      }
      cv += `<div class="abs" style="left:${ox}px;top:${oy}px;width:1260px;height:420px;transform:scale(${S8});transform-origin:0 0">${g}</div>`;
      const reviewAt = wordAt(scene, 'write', 'canvas');
      if (t >= reviewAt) {
        // Anchored from the right: appear() sets its own transform while it animates, so a
        // translateX(-100%) here would be dropped for those frames and the pill would hang off the frame.
        cv += `<div class="abs" style="right:${1080 - (X + W - 18)}px;top:${CY + 7}px;${appear(t, reviewAt, { dy: 10 })}"><span class="pill" style="font-size:24px;padding:8px 20px;background:#1b2a40;color:#cfe3ff;border:1px solid #2d4a70">${ICON.check({ size: 20 })}review it, then commit</span></div>`;
      }
      html += card({
        x: X, y: CY, w: W, h: CH, tabs: [{ label: 'sales.dbml', on: true, icon: `<span style="color:${FILE_COL.dbml}">${ICON.file({ size: 20 })}</span>` }],
        crumb: '.erd-studio › gold › diagrams', headStyle: 'font-size:22px', bodyCls: 'grid-bg', style: appear(t, canvasAt, { dy: 30, dur: 0.4 }),
      });
      html += `<div class="abs" style="left:0;top:0;width:1080px;height:1350px;${appear(t, canvasAt, { dy: 30, dur: 0.4 })}">${cv}</div>`;
    }
    return html;
  },
};
