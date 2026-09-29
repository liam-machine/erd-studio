// 7 · The one optional beat. "Want grain, keys and the why behind each table? / Click Set Up My
// AI Helper, then type /erd-studio-setup in your assistant." The walkthrough's last step, open,
// with its real image (a model with key badges and a grain note). The pointer clicks Set Up My
// AI Helper, the step ticks itself done, and a generic AI-assistant chat panel (no vendor name
// or mark) slides in with /erd-studio-setup typed into it.
import { appear, caret, easeOut, ICON, path, pointer, seg, typed, typedEnd } from '../lib.js';
import { ACT, BODY, WIN, activityBar, editorWindow, walkButton, walkthrough } from '../editor.js';

// What the user types: the setup skill's command (src/types/aiAssistants.ts, Claude Code's prompt).
export const PROMPT = '/erd-studio-setup';
// The guide's first line when a diagram already exists: SKILL.md "Enriching an existing diagram"
// step 1, with this diagram's model count.
export const REPLY = "You already have the <b>orders</b> diagram (4 models). I'll add what dbt doesn't record — keys, grain, roles and why — and leave its columns and connections alone. OK?";

export default {
  render(t, { beats }) {
    const W = beats.want.t, S = beats.setup.t;
    // e_want: "Want grain, keys"(+0.0–1.2) "and the why behind each table?"(+1.3–2.7)
    const glowAt = W + 0.2;
    // e_setup: "Click Set Up My AI Helper,"(+0.0–1.9) "then type /erd-studio-setup in your assistant."(+2.1–5.07)
    const clickAt = S + 1.15;
    const doneAt = clickAt + 0.3;
    const chatAt = S + 1.9;
    const typeAt = S + 2.3;                     // "…then type"
    const typeEnd = typedEnd(PROMPT, typeAt, 20);
    const sendAt = typeEnd + 0.25;
    const replyAt = sendAt + 0.45;

    const done = t >= doneAt ? ['openProject', 'draw', 'enrich'] : ['openProject', 'draw'];
    let body = `<div class="abs" style="left:${ACT}px;top:0;right:0;bottom:0">${walkthrough({ open: 'enrich', done, wide: true, glow: easeOut(seg(t, glowAt, glowAt + 0.4)), press: seg(t, clickAt, clickAt + 0.4) })}</div>`;
    body += activityBar('erd');
    let html = editorWindow({ tabs: [{ label: 'orders.json' }, { label: 'Welcome', on: true }], body });

    // the AI assistant's chat panel: the command is typed and sent, and the guide answers with
    // the enrich route's opening line (SKILL.md "Enriching an existing diagram")
    if (t >= chatAt) {
      const p = easeOut(seg(t, chatAt, chatAt + 0.4));
      const x = WIN.x + WIN.w - 720 - 24, y = BODY.y + 16, w = 720, h = BODY.h - 32;
      const sent = t >= sendAt;
      const val = sent ? '' : `<span class="mono" style="color:var(--text)">${typed(PROMPT, t, typeAt, 20)}</span>${caret(t, typeEnd, '#e9ecef')}`;
      let convo = '';
      if (sent) {
        convo += `<div class="abs" style="right:24px;top:88px;padding:10px 18px;border-radius:12px;background:#2b3a52;font:500 24px var(--mono);color:#e6f0ff;white-space:nowrap;${appear(t, sendAt, { dy: 10, dur: 0.25 })}">${PROMPT}</div>`;
      }
      if (t >= replyAt) {
        convo += `<div class="abs" style="left:24px;right:32px;top:160px;display:flex;gap:14px;font-size:23px;line-height:34px;color:var(--text);${appear(t, replyAt, { dy: 10 })}"><span style="color:#c490e8;display:flex;margin-top:5px">${ICON.sparkle({ size: 22 })}</span><span>${REPLY}</span></div>`;
      }
      html += `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:16px;background:#1b1c20;border:1px solid #3a3c42;box-shadow:-24px 24px 60px #000c;opacity:${p.toFixed(3)};transform:translateX(${(60 * (1 - p)).toFixed(1)}px)">
        <div class="abs" style="left:24px;top:18px;display:flex;align-items:center;gap:12px;font-size:23px;font-weight:700;color:var(--text);white-space:nowrap"><span style="color:#c490e8;display:flex">${ICON.sparkle({ size: 26 })}</span>AI assistant</div>
        <div class="abs" style="left:24px;right:24px;top:64px;height:1px;background:var(--card-border)"></div>${convo}
        <div class="abs" style="left:24px;right:24px;bottom:24px;height:70px;border-radius:12px;background:#26272d;border:2px solid ${t >= typeAt && !sent ? '#3794ff' : '#3a3c42'};display:flex;align-items:center;padding:0 22px;font-size:27px;white-space:nowrap">${t < typeAt || sent ? '<span style="color:var(--text-3);font-size:23px">Ask anything</span>' : val}</div>
      </div>`;
    }

    // pointer onto Set Up My AI Helper
    const btn = walkButton({ wide: true, open: 'enrich', left: ACT });
    if (t < chatAt + 0.2) {
      const pt = path(t, [{ t: S - 0.3, x: 900, y: 880 }, { t: clickAt - 0.1, x: btn.x, y: btn.y }]);
      const op = Math.min(seg(t, S - 0.4, S - 0.1), 1 - seg(t, chatAt - 0.2, chatAt + 0.2));
      if (op > 0) html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, clickAt, clickAt + 0.4))}</div>`;
    }
    return html;
  },
};
