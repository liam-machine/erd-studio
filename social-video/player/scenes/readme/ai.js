// readme · 7 · ai — "Your AI writes the same files." `setup`: the Command Palette runs
// ERD Studio: Set Up My AI Helper (package.json erdStudio.setupAiHelper); the five assistants it
// sets up tick in on their names, each with where it reads the instructions (.claude/skills/ for
// Claude Code, .agents/skills/ for the rest — docs/ai-assistants.md). `write`: a Claude Code
// session is asked for a date dimension; it writes dim_date.dbml and edits the relationships
// and diagram files (the real files an added, linked table touches), and the canvas below shows
// the new table and its relationship before anything is committed.
import { appear, card, caret, COLORS, easeInOut, easeOut, edge, ICON, lerp, node, rowY, seg, spinner, tick, typed } from '../../lib.js';
import { FILE_COL, PATH, R, wordAt } from './story.js';

const X = 64, W = 952;
const PROMPT = 'add a date dimension and link order_date to it';
const ASSISTANTS = [
  { name: 'Claude Code', word: 'Claude', dir: '.claude/skills/' },
  { name: 'GitHub Copilot', word: 'Copilot', dir: '.agents/skills/' },
  { name: 'Codex', word: 'Codex', dir: '.agents/skills/' },
  { name: 'Gemini CLI', word: 'Gemini', dir: '.agents/skills/' },
  { name: 'Cursor', word: 'Cursor', dir: '.agents/skills/' },
];

export default {
  render(t, { beats, scene }) {
    const S = beats.setup.t, Wr = beats.write.t;
    const out = easeInOut(seg(t, Wr - 0.35, Wr + 0.1));      // setup gives way to the session
    let html = '';

    // ================= setup =================
    if (out < 1) {
      const op = 1 - out;
      let s = '';
      // Command palette
      const q = 'Set Up My AI Helper';
      const typeAt = 0.1, typedEnd = typeAt + q.length / 30;
      const runAt = wordAt(scene, 'setup', 'teaches') - 0.2;
      s += `<div class="abs" style="left:${X + 60}px;top:300px;width:${W - 120}px;border-radius:14px;background:#1f2126;border:1px solid #3a3d45;box-shadow:0 24px 60px #000c;overflow:hidden;${appear(t, 0, { dy: -10 })}">
        <div style="margin:12px 14px;height:54px;border-radius:8px;border:2px solid #0e639c;background:#16181c;display:flex;align-items:center;padding:0 16px;font-size:25px;white-space:nowrap"><span style="color:var(--text-2)">&gt;&nbsp;</span>${typed(q, t, typeAt, 30)}${t < runAt ? caret(t, typedEnd) : ''}</div>
        <div style="margin:0 10px 10px;height:58px;border-radius:8px;display:flex;align-items:center;gap:14px;padding:0 18px;font-size:25px;white-space:nowrap;${t >= typedEnd ? `background:${t >= runAt ? '#0e639c' : '#04395e'};` : 'opacity:0;'}"><span style="color:var(--text-2)">ERD Studio:</span><span style="font-weight:600">Set Up My AI Helper</span></div></div>`;
      // The assistants, each ticking in on its name.
      const LY = 480, RH = 82;
      s += `<div class="abs" style="left:${X}px;top:${LY - 6}px;width:${W}px;height:${ASSISTANTS.length * RH + 28}px;border-radius:20px;background:var(--card);border:1px solid var(--card-border);box-shadow:0 30px 80px #000a;${appear(t, runAt, { dy: 20 })}"></div>`;
      ASSISTANTS.forEach((a, i) => {
        const at = wordAt(scene, 'setup', a.word);
        const y = LY + 8 + i * RH;
        s += `<div class="abs" style="left:${X + 30}px;width:${W - 60}px;top:${y}px;height:${RH - 8}px;display:flex;align-items:center;gap:20px;white-space:nowrap;border-bottom:${i < ASSISTANTS.length - 1 ? '1px solid var(--row-line)' : 'none'};${appear(t, Math.min(at, runAt + 0.1 + i * 0.08), { dy: 8 })}">
          ${t >= at ? tick('ok') : `<span class="tick" style="border:2px solid #3a3d45"></span>`}
          <span style="font-size:30px;font-weight:700;width:300px;color:${t >= at ? 'var(--text)' : 'var(--text-2)'}">${a.name}</span>
          <span class="mono" style="font-size:24px;color:var(--text-3)">${a.dir}erd-studio/</span></div>`;
      });
      const filesAt = wordAt(scene, 'setup', 'files');
      if (t >= filesAt - 0.2) {
        s += `<div class="abs" style="left:${X}px;width:${W}px;top:${LY + ASSISTANTS.length * RH + 46}px;display:flex;justify-content:center;${appear(t, filesAt - 0.2, { dy: 10 })}">
          <span class="pill" style="font-size:28px;padding:10px 26px;background:#1b2a40;color:#cfe3ff;border:1px solid #2d4a70">${ICON.sparkle({ size: 24 })}teaches your assistant the <span class="mono" style="font-weight:600">.erd-studio</span> DBML files</span></div>`;
      }
      html += `<div class="abs" style="left:0;top:0;width:1080px;height:1350px;opacity:${op.toFixed(3)};transform:translateY(${(-30 * out).toFixed(1)}px)">${s}</div>`;
    }

    // ================= write =================
    if (t >= Wr - 0.3) {
      const pAt = Wr - 0.1, pEnd = pAt + PROMPT.length / 45;
      const steps = [
        { at: pEnd + 0.25, verb: 'Write', path: PATH.date },
        { at: pEnd + 0.75, verb: 'Edit', path: PATH.rels },
        { at: pEnd + 1.25, verb: 'Edit', path: PATH.diagram },
      ];
      const TY = 300, TH = 330;
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
        crumb: R.repo, headStyle: 'font-size:22px', body: tb, style: appear(t, Wr - 0.3, { dy: 30, dur: 0.4 }),
      });

      // The canvas: the new table and its relationship, not committed yet.
      const CY = TY + TH + 20, CH = 1088 - CY;
      const canvasAt = Wr + 0.3;
      const newAt = steps[2].at + 0.3;
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
      if (np > 0) {
        g += edge([[FX + FW, ey1], [mid, ey1], [mid, ey2], [DX, ey2]], { color: COLORS.logical, progress: easeOut(seg(t, newAt + 0.3, newAt + 0.8)), many: [FX + FW + 6, ey1 - 10], one: [DX - 20, ey2 - 10] });
      }
      g += node({ x: CUX, y: ny, w: CUW, name: R.dim_customer.name, layer: R.badge, grain: R.dim_customer.grain, cols: R.dim_customer.cols });
      g += node({ x: FX, y: ny, w: FW, name: R.fct_order.name, layer: R.badge, grain: R.fct_order.grain, cols: fcols });
      if (np > 0) {
        g += node({ x: DX, y: ny, w: DW, name: R.dim_date.name, layer: R.badge, grain: R.dim_date.grain, cols: R.dim_date.cols,
          style: `opacity:${np.toFixed(3)};transform:translateY(${lerp(18, 0, np).toFixed(1)}px);box-shadow:0 0 0 ${(6 * (1 - 0.5 * seg(t, newAt + 1, newAt + 2))).toFixed(1)}px rgba(34,197,94,.45),0 18px 44px #0009;border-color:var(--green)` });
        g += `<div class="abs" style="left:${DX + DW - 120}px;top:${ny - 50}px;${appear(t, newAt + 0.2, { dy: 6 })}"><span class="pill" style="font-size:24px;padding:4px 14px;background:#13301f;color:var(--green);border:1px solid #1f6b3a">${ICON.plus({ size: 18 })}new</span></div>`;
      }
      cv += `<div class="abs" style="left:${ox}px;top:${oy}px;width:1260px;height:420px;transform:scale(${S8});transform-origin:0 0">${g}</div>`;
      const reviewAt = wordAt(scene, 'write', 'canvas');
      if (t >= reviewAt) {
        cv += `<div class="abs" style="left:${X + W - 24}px;top:${CY + CH - 76}px;transform:translateX(-100%);${appear(t, reviewAt, { dy: 10 })}"><span class="pill" style="font-size:24px;padding:8px 20px;background:#1b2a40;color:#cfe3ff;border:1px solid #2d4a70">${ICON.check({ size: 20 })}review it, then commit</span></div>`;
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
