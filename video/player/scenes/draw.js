// 3 · "Click Draw from dbt, / and pick a folder, like your marts." Continues from the install
// scene's last frame. The pointer clicks the open step's Draw from dbt button; the step ticks
// itself done (its completionEvent is onCommand:erdStudio.drawFromDbt) and the command's
// "Reading your dbt project…" progress notification shows. On `pick` the real QuickPick drops
// from the top (title, placeholder, one row per folder with the first model names as detail,
// then "Choose models…"); the pointer lands on marts on "…your marts" and presses it. marts maps
// to the Gold layer by itself, so the only follow-up is the name box: the same box swaps its
// contents in place, "orders" is typed over the selected suggestion and confirmed, and the
// diagram's file, gold/orders.json, lands beside the button.
import { appear, caret, easeOut, ICON, path, pointer, seg, spinner, typed } from '../lib.js';
import { ACT, DRAW_PICK, QP, SIDE, WIN, activityBar, editorWindow, explorerSide, quickPick, walkButton, walkthrough } from '../editor.js';

const ED = ACT + SIDE;
const LIST_Y = QP.title + QP.input + 22;    // first row, relative to the box top
const ROW2 = 88, ROWC = 54;

const checklist = (size) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5l1.8 1.8 3-3M3.5 13.5l1.8 1.8 3-3M11 7h9.5M11 14h9.5M11 20h9.5"/></svg>`;

export default {
  render(t, { beats }) {
    const C = beats.click.t, P = beats.pick.t;
    // d_click: "Click"(+0.0–0.35) "Draw from dbt,"(+0.4–1.4)
    const click = C + 0.6;
    const doneAt = click + 0.25;
    const readAt = click + 0.2, readEnd = P + 0.1;
    // d_pick: "and pick a folder,"(+0.0–0.9) "like your marts."(+1.0–1.8)
    const onMarts = P + 1.3, pressAt = P + 1.45;
    const swapAt = pressAt + 0.45;              // the SAME box swaps to the name input
    const typeAt = swapAt + 0.35;               // the suggestion shows selected, then is typed over
    const typedEnd = typeAt + DRAW_PICK.name.length / 16;
    const enterAt = typedEnd + 0.2;
    const qpOut = enterAt + 0.2;

    const done = t >= doneAt ? ['openProject', 'draw'] : ['openProject'];
    const glow = 1 - 0.6 * seg(t, doneAt, doneAt + 0.5);
    let body = explorerSide({ hot: 1 });
    body += `<div class="abs" style="left:${ED}px;top:0;right:0;bottom:0">${walkthrough({ done, glow, press: seg(t, click, click + 0.4) })}</div>`;
    body += activityBar('files');
    let html = editorWindow({ tabs: [{ label: 'Extension: ERD Studio' }, { label: 'Welcome', on: true }], body });

    // dim the window behind the QuickPick
    const dim = t < qpOut ? easeOut(seg(t, P, P + 0.25)) : 0;
    if (dim > 0) html += `<div class="abs" style="left:${WIN.x}px;top:${WIN.y}px;width:${WIN.w}px;height:${WIN.h}px;border-radius:20px;background:rgba(10,11,14,${(0.55 * dim).toFixed(3)})"></div>`;

    // progress notification, bottom right of the window
    if (t >= readAt && t < readEnd + 0.3) {
      const op = Math.min(easeOut(seg(t, readAt, readAt + 0.25)), 1 - seg(t, readEnd, readEnd + 0.3));
      html += `<div class="abs" style="right:${1920 - (WIN.x + WIN.w - 20)}px;top:${WIN.y + WIN.h - 92}px;height:68px;padding:0 26px;border-radius:10px;background:#252526;border:1px solid #454545;box-shadow:0 12px 36px #000c;display:flex;align-items:center;gap:14px;font-size:23px;white-space:nowrap;opacity:${op.toFixed(3)}">${spinner(t, 26, '#3794ff')}${DRAW_PICK.progress}</div>`;
    }

    // the QuickPick, then (same box) the name input
    const martsY = QP.y + LIST_Y + 30;
    if (t >= P && t < qpOut) {
      const pIn = easeOut(seg(t, P, P + 0.3));
      const boxStyle = `opacity:${pIn.toFixed(3)};transform:translateY(${(-20 * (1 - pIn)).toFixed(1)}px)`;
      if (t < swapAt) {
        const pressed = t >= pressAt;
        const row = (y, h, icon, label, desc, detail, focus) =>
          `<div class="abs" style="left:8px;right:8px;top:${y}px;height:${h}px;border-radius:6px;${focus ? `background:${pressed ? '#0e639c' : '#04395e'};box-shadow:inset 0 0 0 ${pressed ? 3 : 2}px ${pressed ? '#60a5fa' : '#0e639c'};` : ''}">
            <div class="abs" style="left:16px;top:${detail ? 10 : 12}px;right:16px;display:flex;align-items:center;gap:14px;white-space:nowrap">
              <span style="color:${focus && pressed ? '#fff' : 'var(--text-2)'}">${icon}</span><span style="font-size:26px;font-weight:600">${label}</span><span style="font-size:22px;color:${focus && pressed ? '#cfe3ff' : 'var(--text-2)'}">${desc}</span></div>
            ${detail ? `<div class="abs" style="left:58px;right:20px;top:52px;font-size:21px;color:${focus && pressed ? '#cfe3ff' : 'var(--text-2)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${detail}</div>` : ''}</div>`;
        let inner = `<div class="abs" style="left:14px;right:14px;top:${QP.title + 10}px;height:${QP.input}px;border-radius:5px;background:#3c3c3c;border:2px solid #0e639c;display:flex;align-items:center;padding-left:18px;font-size:23px;color:#9a9ea6;white-space:nowrap">${DRAW_PICK.placeholder}</div>`;
        DRAW_PICK.rows.forEach((r, i) => { inner += row(LIST_Y + i * (ROW2 + 4), ROW2, ICON.folder({ size: 28 }), r.label, r.description, r.detail, i === 0); });
        inner += row(LIST_Y + 2 * (ROW2 + 4), ROWC, checklist(28), DRAW_PICK.choose.label, DRAW_PICK.choose.description, '', false);
        html += quickPick(DRAW_PICK.title, inner, LIST_Y + 2 * (ROW2 + 4) + ROWC + 10, boxStyle);
      } else {
        const val = t < typeAt
          ? `<span style="background:#264f78">${DRAW_PICK.suggested}</span>`
          : `${typed(DRAW_PICK.name, t, typeAt, 16)}${t < enterAt ? caret(t, typedEnd, '#e9ecef') : ''}`;
        const flash = t >= enterAt;
        let inner = `<div class="abs" style="left:14px;right:14px;top:${QP.title + 10}px;height:${QP.input}px;border-radius:5px;background:${flash ? '#1f3a57' : '#3c3c3c'};border:2px solid #0e639c;display:flex;align-items:center;padding-left:18px;font-size:25px;color:var(--text);white-space:nowrap">${val}</div>`;
        inner += `<div class="abs" style="left:20px;right:20px;top:${QP.title + QP.input + 22}px;font-size:22px;color:var(--text-2);white-space:nowrap">${DRAW_PICK.namePrompt}</div>`;
        html += quickPick(DRAW_PICK.title, inner, QP.title + QP.input + 22 + 32 + 20, '');
      }
    }

    // pointer: clicks Draw from dbt, then lands on marts and presses
    const btn = walkButton();
    if (t < swapAt) {
      const pt = path(t, [
        { t: 0.0, x: 1500, y: 860 },
        { t: click - 0.1, x: btn.x, y: btn.y },
        { t: P + 0.2, x: btn.x, y: btn.y },
        { t: onMarts, x: QP.x + 300, y: martsY },
      ]);
      const op = Math.min(seg(t, 0, 0.25), 1 - seg(t, pressAt + 0.25, swapAt));
      const press = t < P ? seg(t, click, click + 0.4) : seg(t, pressAt, pressAt + 0.4);
      html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, press)}</div>`;
    }

    // the diagram's domain file is written; the canvas scene opens it
    if (t >= qpOut + 0.1) {
      html += `<div class="abs pill" style="left:${(btn.x + 150).toFixed(0)}px;top:${(btn.y - 28).toFixed(0)}px;height:56px;box-shadow:0 12px 36px #000c;font-size:24px;padding:0 22px 0 12px;background:#13301f;color:#dff7e8;border:2px solid var(--green);${appear(t, qpOut + 0.1, { dy: 8 })}"><span class="tick tick--ok">${ICON.check({ size: 22 })}</span><span class="mono" style="font-size:23px">.erd-studio/gold/<b style="color:var(--green)">orders.json</b></span></div>`;
    }
    return html;
  },
};
