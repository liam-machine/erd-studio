// 4 · "Then ask your AI assistant to start." Beside the headline, the five supported assistants
// light up as they are named; the terminal is the worked example, in Claude Code.
// Terminal: `claude` starts in the project folder, the user types /erd-studio-setup (the
// slash-command menu offers it with the skills' own descriptions), and Claude answers the way
// the skill's Stage 0 says to: a greeting, the two views in plain words, the promise that
// nothing changes without asking, then "Ready?" (it does not run anything before that).
import { appear, card, caret, ICON, seg, typed, typedEnd } from '../lib.js';

const X = 96, Y = 322, W = 1728, H = 600;
const L = X + 44, T = Y + 64 + 30, PITCH = 46;
const CMD = '/erd-studio-setup';
// GEMINI_SETUP_SENTENCE in src/types/aiAssistants.ts — the words the panel's Copy button copies
// (npm test checks they match).
export const GEMINI_SENTENCE = 'Set up ERD Studio for this dbt project';
// When each name is spoken, seconds into the s04_open clip (silencedetect on build/voice/
// s04_open.wav: "…project folder: | Claude Code, | GitHub Copilot, | Codex, Gemini CLI or Cursor").
// Re-measure if that line is re-voiced.
const NAMED = [['Claude Code', 3.2], ['GitHub Copilot', 4.2], ['Codex', 5.45], ['Gemini CLI', 6.2], ['Cursor', 7.3]];

// The five supported assistants as plain text chips (no logos) beside the headline, each lit as
// the narration names it; below them, the two that start the guide differently (the same rows
// the Welcome panel's step 3 shows).
function assistants(t, open, type) {
  const chips = NAMED.map(([name, at], i) => {
    const lit = seg(t, open + at, open + at + 0.25);
    const border = lit > 0 ? `rgba(92,162,248,${(0.35 + 0.65 * lit).toFixed(2)})` : '#34363d';
    const bg = lit > 0 ? `rgba(27,42,64,${lit.toFixed(2)})` : 'transparent';
    return `<span class="pill" style="font-size:25px;font-weight:600;padding:10px 22px;border:2px solid ${border};background:${bg};color:${lit > 0.5 ? '#cfe3ff' : 'var(--text-2)'};${appear(t, 0.25 + i * 0.08, { dy: 8 })}">${name}</span>`;
  }).join('');
  const code = (s) => `<span class="mono" style="color:var(--text);font-size:19px">${s}</span>`;
  return `<div class="abs" style="right:96px;top:128px;width:720px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:14px">${chips}</div>
    <div class="abs" style="right:96px;top:262px;font-size:20px;color:var(--text-2);white-space:nowrap;${appear(t, type + 0.4, { dy: 6 })}">In Codex: ${code('$erd-studio-setup')} · In Gemini CLI: <span style="color:var(--text)">"${GEMINI_SENTENCE}"</span></div>`;
}

export default {
  render(t, { beats }) {
    const shellAt = beats.open.t + 0.25;
    const shellEnd = typedEnd('claude', shellAt, 16);
    const bannerAt = shellEnd + 0.45;
    const typeAt = beats.type.t + 0.55;
    const typeEnd = typedEnd(CMD, typeAt, 22);
    const enterAt = typeEnd + 0.55;
    const replyAt = beats.explains.t - 0.1;

    const term = card({ x: X, y: Y, w: W, h: H, dots: true, tabs: [{ label: 'zsh — my_dbt_project', on: true }], style: appear(t, 0) });
    const mono = 'font-family:var(--mono);font-size:27px;white-space:pre';

    // $ claude
    let html = `<div class="abs" style="left:${L}px;top:${T}px;${mono}"><span style="color:var(--green)">~/my_dbt_project</span> <span style="color:var(--text-2)">$</span> ${typed('claude', t, shellAt, 16)}${t < bannerAt ? caret(t, shellEnd) : ''}</div>`;

    // Claude Code banner
    if (t >= bannerAt) {
      html += `<div class="abs" style="left:${L}px;top:${T + PITCH + 14}px;width:720px;height:112px;border:2px solid var(--claude);border-radius:12px;padding:18px 26px;${appear(t, bannerAt, { dy: 8 })}">
        <div style="display:flex;align-items:center;gap:14px;font-size:26px;font-weight:700;color:var(--text)"><span style="color:var(--claude)">${ICON.claude({ size: 26 })}</span>Welcome to Claude Code</div>
        <div style="margin-top:8px;font-family:var(--mono);font-size:20px;color:var(--text-2)">cwd: ~/my_dbt_project</div></div>`;
    }

    // Prompt box; the typed command moves into history on Enter.
    const promptY = T + PITCH + 160;
    if (t >= bannerAt + 0.3) {
      const box = (inner) => `<div class="abs" style="left:${L}px;top:${promptY}px;width:${W - 88}px;height:70px;border:2px solid #3a3d45;border-radius:12px;display:flex;align-items:center;padding:0 24px;${mono};${appear(t, bannerAt + 0.3, { dy: 8 })}">${inner}</div>`;
      if (t < enterAt) {
        const text = typed(CMD, t, typeAt, 22);
        html += box(`<span style="color:var(--text-2)">&gt; </span><span style="color:var(--blue)">${text}</span>${caret(t, typeEnd)}`);
        // Slash-command menu while typing
        if (t >= typeAt + 0.05) {
          const m = `left:${L + 24}px;top:${promptY + 84}px;`;
          html += `<div class="abs" style="${m}display:flex;flex-direction:column;gap:6px;font-size:23px;${appear(t, typeAt + 0.05, { dy: -6, dur: 0.2 })}">
            <div style="display:flex;gap:40px;padding:8px 16px;border-radius:8px;background:#1b2a40"><span class="mono" style="color:var(--blue);width:320px">/erd-studio-setup</span><span style="color:#cfe3ff">Friendly, step-by-step setup for ERD Studio in an existing dbt project…</span></div>
            <div style="display:flex;gap:40px;padding:8px 16px;color:var(--text-3)"><span class="mono" style="width:320px">/erd-studio</span><span>Schema rules for ERD Studio data model files…</span></div></div>`;
        }
      } else {
        html += `<div class="abs" style="left:${L}px;top:${promptY + 12}px;${mono}"><span style="color:var(--text-2)">&gt; </span><span style="color:var(--blue)">${CMD}</span></div>`;
      }
    }

    // Reply
    if (t >= enterAt) {
      const r1 = Math.max(enterAt + 0.25, replyAt);
      html += `<div class="abs" style="left:${L}px;top:${promptY + 84}px;display:flex;align-items:center;gap:18px;font-size:29px;font-weight:500;${appear(t, r1, { dy: 8 })}">
          <span class="dot"></span>Hi! I'll set up ERD Studio with you, step by step.</div>
        <div class="abs" style="left:${L + 32}px;top:${promptY + 138}px;font-size:24px;line-height:1.5;color:var(--text-2);${appear(t, r1 + 0.8, { dy: 8 })}">
          <b style="color:var(--text);font-weight:600">Physical</b> is what your dbt project really builds. <b style="color:var(--text);font-weight:600">Logical</b> is the design: tables, keys, how they connect.<br>
          We'll build logical from what exists, the way your project is already modelled, then check it against physical.<br>Six steps, and nothing in your dbt project changes unless you say so. Ready?</div>`;
      if (t < r1) html += `<div class="abs" style="left:${L}px;top:${promptY + 88}px;display:flex;align-items:center;gap:14px;font-size:24px;color:var(--claude)">${ICON.claude({ size: 24, style: `transform:rotate(${Math.round(t * 180)}deg)` })}<span style="color:var(--text-2)">Thinking…</span></div>`;
    }
    return term + html + assistants(t, beats.open.t, beats.type.t);
  },
};
