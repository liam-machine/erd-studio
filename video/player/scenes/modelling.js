// 7b · The modelling style (the skill's Stage 3b): the assistant never asks cold. It shows what
// it found in the project (the inventory's `conventions` evidence), says the style it detected in
// the skill's own confirmation sentence (verbatim from SKILL.md), the user types "yes", and it
// looks the standard up, plays the rules back as a checklist and saves them to
// .erd-studio/modelling-approach.md — the file every later AI edit reads.
import { appear, card, caret, esc, ICON, seg, spinner, typed, typedEnd } from '../lib.js';

const X = 96, Y = 322, W = 1728, H = 600;
const L = X + 44, TOP = Y + 64;

// SKILL.md Stage 3b, the confident-detection sentence. `code` spans render in mono.
export const CONFIRM = "Your project looks like a medallion layout (bronze → silver → gold) with Kimball-style marts — `dim_`/`fct_` tables, and snapshots keep customer history. I'll model it that way. Sound right? Or describe how your team does it.";
export const LOOKUP = "Looking up Kimball's dimensional modelling standards on kimballgroup.com";
export const PLAYBACK = "Here's how I'll apply that:";
const EVIDENCE = [
  ['folder', 'models/bronze · silver · gold'],
  ['table', '12 dim_ / fct_ tables'],
  ['file', '2 snapshots'],
];
const ANSWER = 'yes';
const RULES = ['Facts at the lowest grain', 'Conformed dimensions', 'Surrogate keys on dimensions', 'Customer history as SCD Type 2'];
const CPS = 10;

const withCode = (s) => esc(s).replace(/`([^`]+)`/g, '<span class="mono" style="font-size:22px;color:var(--text);padding:1px 7px;border-radius:5px;background:var(--card-inner)">$1</span>');

export default {
  render(t, { beats }) {
    const d = beats.detects.t;
    // Chips land on the words: "…medallion layers" (~2.9 s into s07b_detects), "Kimball" (~4.1 s),
    // "…and shows you the evidence" (~5.3 s); the sentence follows as the line ends.
    const chipAt = [d + 2.8, d + 4.0, d + 5.2];
    const sayAt = Math.min(beats.detects.end - 0.5, beats.confirm.t - 0.6);
    const typeAt = beats.confirm.t + 0.35;               // "Say yes…"
    const typeEnd = typedEnd(ANSWER, typeAt, CPS);
    const lookAt = Math.max(typeEnd + 0.35, beats.lookup.t - 0.3);
    const doneAt = beats.lookup.t + 1.2;                 // "…plays it back to you"
    const savedAt = beats.lookup.t + 2.9;                // "…and applies it to the tables it writes" (phrase starts 2.73 s into s07b_lookup)

    let html = card({ x: X, y: Y, w: W, h: H, tabs: [{ label: 'Claude Code', on: true, icon: `<span style="color:var(--claude)">${ICON.claude({ size: 20 })}</span>` }], style: appear(t, 0) });

    // What it found: reading first, then the evidence chips.
    const reading = t < chipAt[0];
    html += `<div class="abs" style="left:${L}px;top:${TOP + 22}px;height:48px;display:flex;align-items:center;gap:14px;white-space:nowrap;${appear(t, d + 0.2, { dy: 8 })}">
      ${reading
        ? `<span style="width:28px;display:flex;justify-content:center">${spinner(t, 24, 'var(--blue)')}</span><span style="font-size:22px;color:var(--text-2)">Reading your project's folders and model names…</span>`
        : `<span style="font-size:21px;color:var(--text-3);margin-right:4px">What I found</span>${EVIDENCE.map(([icon, label], i) =>
          `<span class="pill" style="height:46px;gap:10px;padding:0 18px;background:#1b2a40;color:#cfe3ff;font-size:21px;${appear(t, chipAt[i], { dy: 8 })}"><span style="display:inline-flex;color:#8fc0ff">${ICON[icon]({ size: 20 })}</span><span class="mono" style="font-size:20px">${esc(label)}</span></span>`).join('')}`}</div>`;

    // The confirmation, in the skill's words.
    html += `<div class="abs" style="left:${L}px;top:${TOP + 96}px;width:${W - 110}px;display:flex;gap:16px;${appear(t, sayAt, { dy: 8 })}"><span class="dot" style="margin-top:14px;flex:none"></span>
      <div style="font-size:25px;line-height:1.5">${withCode(CONFIRM)}</div></div>`;

    // The user's answer.
    if (t >= typeAt - 0.25) {
      const text = typed(ANSWER, t, typeAt, CPS);
      html += `<div class="abs" style="right:${1920 - (X + W - 44)}px;top:${TOP + 184}px;height:56px;min-width:96px;display:flex;align-items:center;padding:0 26px;border-radius:14px;background:#1b2a40;border:1px solid #2f4f7a;font-size:25px;color:#e6f0ff;white-space:pre;${appear(t, typeAt - 0.25, { dy: 8, dur: 0.25 })}">${text}${t < typeEnd + 0.6 ? caret(t, typeEnd, '#cfe3ff') : ''}</div>`;
    }

    // Looking the standard up, then playing it back.
    if (t >= lookAt) {
      const done = t >= doneAt;
      const icon = done
        ? `<span class="tick tick--ok" style="width:32px;height:32px">${ICON.check({ size: 19 })}</span>`
        : `<span style="width:32px;display:flex;justify-content:center;color:var(--blue)">${spinner(t, 26, 'var(--blue)')}</span>`;
      html += `<div class="abs" style="left:${L - 8}px;top:${TOP + 258}px;display:flex;align-items:center;gap:14px;font-size:24px;white-space:nowrap;${appear(t, lookAt, { dy: 8 })}">
        ${icon}<span style="color:var(--text-2);display:inline-flex">${ICON.globe({ size: 24 })}</span><span>${LOOKUP}${done ? '' : '…'}</span></div>`;
    }
    if (t >= doneAt) {
      html += `<div class="abs" style="left:${L}px;top:${TOP + 310}px;display:flex;gap:16px;align-items:center;font-size:24px;white-space:nowrap;${appear(t, doneAt, { dy: 8 })}"><span class="dot"></span>${PLAYBACK}</div>`;
      RULES.forEach((r, i) => {
        const at = doneAt + 0.25 + i * 0.25;
        const x = L + 30 + (i % 2) * 800, y = TOP + 356 + Math.floor(i / 2) * 60;
        html += `<div class="abs" style="left:${x}px;top:${y}px;width:760px;height:50px;display:flex;align-items:center;gap:14px;padding:0 18px;border-radius:12px;background:var(--card-inner);border:1px solid var(--card-border);font-size:24px;font-weight:600;white-space:nowrap;${appear(t, at, { dy: 8 })}">
          <span class="tick tick--ok" style="width:30px;height:30px">${ICON.check({ size: 18 })}</span>${r}</div>`;
      });
    }

    // Saved for every later AI edit.
    const pulse = 1 - seg(t, savedAt + 0.4, savedAt + 1.6);
    html += `<div class="abs" style="left:${L}px;top:${TOP + 488}px;display:flex;align-items:center;gap:12px;font-size:22px;color:var(--text-2);white-space:nowrap;${appear(t, savedAt, { dy: 8 })}">
      <span style="color:#c9a24b">${ICON.file({ size: 22 })}</span>Saved to <span class="mono" style="font-size:21px;color:var(--text);padding:3px 10px;border-radius:6px;background:rgba(34,197,94,${(0.1 + 0.18 * pulse).toFixed(3)})">.erd-studio/modelling-approach.md</span>
      <span style="color:var(--text-3)">· future AI edits follow it</span></div>`;
    return html;
  },
};
