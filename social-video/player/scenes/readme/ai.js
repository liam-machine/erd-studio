// readme · 10 · ai — "Set Up My AI Helper adds a skill." `setup`: the Command Palette runs
// ERD Studio: Set Up My AI Helper (package.json erdStudio.setupAiHelper); the five assistants it
// sets up tick in on their names, each with where its skill lands (.claude/skills/ for Claude
// Code, .agents/skills/ for the rest — docs/ai-assistants.md). skill.js opens the skill itself;
// aiwrite.js shows an assistant using it.
import { appear, card, caret, COLORS, easeInOut, easeOut, edge, ICON, lerp, node, rowY, seg, spinner, tick, typed } from '../../lib.js';
import { FILE_COL, PATH, R, wordAt } from './story.js';

const X = 64, W = 952;
const PROMPT = 'add a date dimension and link order_date to it';
const ASSISTANTS = [
  { name: 'Claude Code', word: 'Claude', dir: '.claude/skills/', hook: true },
  { name: 'GitHub Copilot', word: 'Copilot', dir: '.agents/skills/' },
  { name: 'Codex', word: 'Codex', dir: '.agents/skills/' },
  { name: 'Gemini CLI', word: 'Gemini', dir: '.agents/skills/' },
  { name: 'Cursor', word: 'Cursor', dir: '.agents/skills/' },
];

export default {
  render(t, { beats, scene }) {
    const out = 0;
    let html = '';

    // ================= setup =================
    if (out < 1) {
      const op = 1 - out;
      let s = '';
      // Command palette
      const q = 'Set Up My AI Helper';
      const typeAt = 0.1, typedEnd = typeAt + q.length / 30;
      const runAt = wordAt(scene, 'setup', 'adds') - 0.2;
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
          <span class="mono" style="font-size:24px;color:var(--text-3)">${a.dir}erd-studio/</span>${a.hook ? '<span class="pill" style="margin-left:auto;font-size:19px;padding:3px 12px;background:#2a1d17;color:#f3c3ab;border:1px solid #6b3f2a">+ hook</span>' : ''}</div>`;
      });
      const filesAt = wordAt(scene, 'setup', 'skill');
      if (t >= filesAt - 0.2) {
        s += `<div class="abs" style="left:${X}px;width:${W}px;top:${LY + ASSISTANTS.length * RH + 46}px;display:flex;justify-content:center;${appear(t, filesAt - 0.2, { dy: 10 })}">
          <span class="pill" style="font-size:28px;padding:10px 26px;background:#1b2a40;color:#cfe3ff;border:1px solid #2d4a70">${ICON.sparkle({ size: 24 })}one skill: the <span class="mono" style="font-weight:600">erd-studio</span> file format</span></div>`;
      }
      html += `<div class="abs" style="left:0;top:0;width:1080px;height:1350px;opacity:${op.toFixed(3)};transform:translateY(${(-30 * out).toFixed(1)}px)">${s}</div>`;
    }

    return html;
  },
};
