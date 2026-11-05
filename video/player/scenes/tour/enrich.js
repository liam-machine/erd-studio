// 7 · The one optional beat. "Want grain, keys and the why behind each table? / Click Set Up My
// AI Helper, then type /erd-studio-setup in your assistant." ERD Studio's side bar (Table Library
// collapsed for the room) with Help & Feedback open (its real rows, HELP_ACTIONS) beside the orders canvas: its first row, Set Up My
// AI Helper, lights on "Want grain, keys…"; the pointer clicks it and a generic AI-assistant chat
// panel (no vendor name or mark) slides in with /erd-studio-setup typed into it. The guide answers
// with its first line for a diagram in a plain folder (the setup skill's plain-folder route,
// "Enriching existing tables" step 1, for this diagram). Shared by both cuts.
import { appear, caret, easeOut, ICON, path, pointer, seg, typed, typedEnd } from '../../lib.js';
import { BODY, ORDERS_TREE, WIN, activityBar, editorWindow, erdSide } from '../../editor.js';
import { ordersCanvas } from './importDbml.js';

// What the user types: the setup skill's command (src/types/aiAssistants.ts, Claude Code's prompt).
export const PROMPT = '/erd-studio-setup';
// The guide's first line for an existing diagram in a plain folder (the setup skill's reference
// for a folder without a warehouse project; npm test reads it), with this diagram's name and size.
export const REPLY = "You have the <b>orders</b> diagram (2 tables). I'll add what's missing — keys, grain, roles, descriptions and the connections the columns suggest — and leave the rest alone. OK?";

export default {
  render(t, { beats }) {
    const W = beats.want.t, S = beats.setup.t;
    // e_want: "Want grain, keys"(+0.0–1.2) "and the why behind each table?"(+1.3–2.7)
    const hotAt = W + 0.4;
    // e_setup: "Click Set Up My AI Helper,"(+0.0–1.9) "then type /erd-studio-setup in your assistant."(+2.1–5.07)
    const clickAt = S + 1.15;
    const chatAt = S + 1.9;
    const typeAt = S + 2.3;                     // "…then type"
    const typeEnd = typedEnd(PROMPT, typeAt, 20);
    const sendAt = typeEnd + 0.25;
    const replyAt = sendAt + 0.45;

    // Table Library collapsed to make room for Help & Feedback's rows.
    const side = erdSide({ diagrams: ORDERS_TREE, libraryOpen: false, selected: 'orders', help: true, helpHot: t >= hotAt ? 0 : -1, helpPress: seg(t, clickAt, clickAt + 0.4) });
    let body = ordersCanvas() + side.html + activityBar('erd');
    let html = editorWindow({ tabs: [{ label: 'orders.dbml', on: true }], body });

    // the AI assistant's chat panel: the command is typed and sent, and the guide answers
    if (t >= chatAt) {
      const p = easeOut(seg(t, chatAt, chatAt + 0.4));
      const x = WIN.x + WIN.w - 760 - 24, y = BODY.y + 16, w = 760, h = BODY.h - 32;
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
    const btn = side.geo.aiHelper;
    if (t < chatAt + 0.2) {
      const pt = path(t, [{ t: S - 0.3, x: 900, y: 880 }, { t: clickAt - 0.1, x: btn.x, y: btn.y }]);
      const op = Math.min(seg(t, S - 0.4, S - 0.1), 1 - seg(t, chatAt - 0.2, chatAt + 0.2));
      if (op > 0) html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, clickAt, clickAt + 0.4))}</div>`;
    }
    return html;
  },
};
