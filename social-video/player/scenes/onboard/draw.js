// onboard/draw · "Click Draw from dbt. / Pick a folder, like your marts."
// Continues from onboard/install's last frame (same window, same walkthrough) and zooms onto the
// open step "Draw your dbt project — no AI needed". The pointer clicks its blue Draw from dbt
// button on "Draw from dbt"; the step ticks itself done (its completionEvent is
// onCommand:erdStudio.drawFromDbt) and the command's "Reading your dbt project…" progress
// notification flashes. On `pick` the real QuickPick drops from the top (title "Draw from dbt",
// placeholder "Which dbt models should the diagram start from?", one row per folder with the
// first model names as detail, then "Choose models…"); the pointer lands on `marts` on "…your
// marts" and the row holds pressed. marts maps to the Gold layer by itself, so the only follow-up
// is the name box ("Name the diagram. It is saved in the Gold layer."): the same box swaps its
// contents in place (no crossfade), "orders" is typed over the suggestion and confirmed, and the
// green gold/orders.json chip lands.
import { ICON, appear, card, caret, easeInOut, easeOut, lerp, path, pointer, seg, spinner, typed } from '../../lib.js';
import { BODY, DRAW_BTN, DRAW_ROW, WIN, activityBar, walkthrough } from './install.js';

const ZOOM = 1.36;
const ACT = 64;
// zoom target: the open step centred horizontally in the Welcome area; the whole step list (its
// first row at walkthrough y 160, the last ending at 682) fits the body with the description
// just above the top edge and the last row clear of the bottom
const TX = 507 - (DRAW_ROW.x + DRAW_ROW.w / 2) * ZOOM;
const TY = 8 - 160 * ZOOM;

// QuickPick box (frame px)
const QP = { x: 104, y: 378, w: 872 };
const QP_TITLE = 50, QP_INPUT = 60;
const LIST_Y = QP_TITLE + QP_INPUT + 24;     // first row, relative to QP.y
const ROW2 = 102, ROWC = 64;

const checklist = (size) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5l1.8 1.8 3-3M3.5 13.5l1.8 1.8 3-3M11 7h9.5M11 14h9.5M11 20h9.5"/></svg>`;

function quickPickShell(inner, h, style) {
  return `<div class="abs" style="left:${QP.x}px;top:${QP.y}px;width:${QP.w}px;height:${h}px;border-radius:10px;background:#252526;border:1px solid #454545;box-shadow:0 18px 50px #000c;overflow:hidden;${style}">
    <div class="abs" style="left:0;right:0;top:0;height:${QP_TITLE}px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:600;color:var(--text-2);background:#1f1f20;border-bottom:1px solid #3a3a3c">Draw from dbt</div>
    ${inner}</div>`;
}

export default {
  render(t, { beats }) {
    const C = beats.click.t, P = beats.pick.t;
    // zoom onto the step before the line starts
    const z = easeInOut(seg(t, 0.0, 0.6));
    const s = lerp(1, ZOOM, z), tx = lerp(0, TX, z), ty = lerp(0, TY, z);
    // o_click: "Click Draw from dbt." (+0.0–1.34)
    const click = C + 0.6;                 // lands on "Draw from dbt"
    const doneAt = click + 0.25;           // step ticks itself done
    const readAt = click + 0.2, readEnd = P - 0.1;   // "Reading your dbt project…"
    // o_pick: "Pick a folder,"(+0.0–0.74) "like your marts."(+0.84–1.57)
    const qpAt = P + 0.0;
    const onMarts = P + 1.3;               // pointer reaches marts on "…marts"
    const pressAt = P + 1.4;               // presses marts
    const swapAt = pressAt + 0.45;         // marts held pressed ~0.45 s, then the SAME box swaps to the name input (no crossfade)
    const typeAt = swapAt + 0.12;          // empty input, "orders" typed quickly
    const NAME = 'orders';
    const typedEnd = typeAt + NAME.length / 16;
    const enterAt = typedEnd + 0.2;
    const qpOut = enterAt + 0.2;           // box closes on a single frame
    const nameOut = qpOut;

    // ---- window + zoomed walkthrough ----
    const btnPress = seg(t, click, click + 0.4);
    const done = t >= doneAt ? ['openProject', 'draw'] : ['openProject'];
    const glow = 1 - 0.6 * seg(t, doneAt, doneAt + 0.5);
    let body = `<div class="abs" style="left:${ACT}px;top:0;right:0;bottom:0;background:var(--card)"></div>`;
    body += `<div class="abs" style="left:0;top:0;right:0;bottom:0;overflow:hidden"><div class="abs" style="left:0;top:0;width:${BODY.w}px;height:${BODY.h}px;transform-origin:0 0;transform:translate(${tx.toFixed(1)}px,${ty.toFixed(1)}px) scale(${s.toFixed(4)})">${walkthrough({ done, glow, press: btnPress })}</div></div>`;
    body += activityBar('files', { erd: true });
    let html = card({ ...WIN, tabs: [{ label: 'Extension: ERD Studio' }, { label: 'Welcome', on: true }], crumb: 'jaffle-shop', headStyle: 'font-size:24px', body });

    // dim the window behind the QuickPick while it is open
    const dim = t < qpOut ? easeOut(seg(t, qpAt, qpAt + 0.25)) : 0;
    if (dim > 0) html += `<div class="abs" style="left:${WIN.x}px;top:${WIN.y + 64}px;width:${WIN.w}px;height:${WIN.h - 64}px;border-radius:0 0 20px 20px;background:rgba(10,11,14,${(0.62 * dim).toFixed(3)})"></div>`;

    // ---- progress notification (bottom-right of the window) ----
    if (t >= readAt && t < readEnd + 0.3) {
      const op = Math.min(easeOut(seg(t, readAt, readAt + 0.25)), 1 - seg(t, readEnd, readEnd + 0.3));
      html += `<div class="abs" style="right:${1080 - (WIN.x + WIN.w - 18)}px;top:${WIN.y + WIN.h - 96}px;height:74px;padding:0 26px;border-radius:10px;background:#252526;border:1px solid #454545;box-shadow:0 12px 36px #000c;display:flex;align-items:center;gap:14px;font-size:26px;white-space:nowrap;opacity:${op.toFixed(3)}">${spinner(t, 28, '#3794ff')}Reading your dbt project…</div>`;
    }

    // ---- QuickPick: which models, then (same box, swapped in place) the diagram name ----
    const btnX = BODY.x + tx + (DRAW_BTN.x + DRAW_BTN.w / 2) * ZOOM;
    const btnY = BODY.y + ty + (DRAW_BTN.y + DRAW_BTN.h / 2) * ZOOM;
    const martsY = QP.y + LIST_Y + 34;
    if (t >= qpAt && t < qpOut) {
      const pIn = easeOut(seg(t, qpAt, qpAt + 0.3));
      const boxStyle = `opacity:${pIn.toFixed(3)};transform:translateY(${(-24 * (1 - pIn)).toFixed(1)}px)`;
      if (t < swapAt) {
        const pressed = t >= pressAt;
        const row = (y, h, icon, label, desc, detail, focus) =>
          `<div class="abs" style="left:8px;right:8px;top:${y}px;height:${h}px;border-radius:6px;${focus ? `background:${pressed ? '#0e639c' : '#04395e'};box-shadow:inset 0 0 0 ${pressed ? 3 : 2}px ${pressed ? '#60a5fa' : '#0e639c'};` : ''}">
            <div class="abs" style="left:16px;top:${detail ? 12 : 16}px;right:16px;display:flex;align-items:center;gap:14px;white-space:nowrap">
              <span style="color:${focus && pressed ? '#fff' : 'var(--text-2)'}">${icon}</span><span style="font-size:30px;font-weight:600">${label}</span>${desc ? `<span style="font-size:25px;color:${focus && pressed ? '#cfe3ff' : 'var(--text-2)'}">${desc}</span>` : ''}</div>
            ${detail ? `<div class="abs" style="left:60px;right:20px;top:58px;font-size:24px;color:${focus && pressed ? '#cfe3ff' : 'var(--text-2)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${detail}</div>` : ''}</div>`;
        let inner = `<div class="abs" style="left:14px;right:14px;top:${QP_TITLE + 12}px;height:${QP_INPUT}px;border-radius:6px;background:#3c3c3c;border:2px solid #0e639c;display:flex;align-items:center;padding-left:18px;font-size:25px;color:#9a9ea6;white-space:nowrap">Which dbt models should the diagram start from?</div>`;
        // detail = the first model names, most relationship tests first (byConnectedness in dbtDraft.ts)
        inner += row(LIST_Y, ROW2, ICON.folder({ size: 30 }), 'marts', '6 models', 'fct_order_items, fct_orders, dim_customers, dim_dates and 2 more', true);
        inner += row(LIST_Y + ROW2 + 4, ROW2, ICON.folder({ size: 30 }), 'staging', '6 models', 'stg_customers, stg_locations, stg_order_items, stg_orders and 2 more', false);
        inner += row(LIST_Y + 2 * ROW2 + 8, ROWC, checklist(30), 'Choose models…', '', '', false);
        html += quickPickShell(inner, LIST_Y + 2 * ROW2 + 8 + ROWC + 10, boxStyle);
      } else {
        const val = `${typed(NAME, t, typeAt, 16)}${t < enterAt ? caret(t, typedEnd, '#e9ecef') : ''}`;
        const flash = t >= enterAt;
        let inner = `<div class="abs" style="left:14px;right:14px;top:${QP_TITLE + 12}px;height:${QP_INPUT}px;border-radius:6px;background:${flash ? '#1f3a57' : '#3c3c3c'};border:2px solid #0e639c;display:flex;align-items:center;padding-left:18px;font-size:28px;color:var(--text);white-space:nowrap">${val}</div>`;
        inner += `<div class="abs" style="left:20px;right:20px;top:${QP_TITLE + QP_INPUT + 24}px;font-size:26px;line-height:36px;color:var(--text-2)">Name the diagram. It is saved in the <b style="color:var(--text);font-weight:700">Gold</b> layer.</div>`;
        html += quickPickShell(inner, QP_TITLE + QP_INPUT + 24 + 36 + 22, '');
      }
    }

    // ---- pointer: clicks Draw from dbt, then lands on marts and presses ----
    const endAt = swapAt;
    if (t >= 0.25 && t < endAt) {
      const pt = path(t, [
        { t: 0.25, x: 860, y: 1060 },
        { t: click - 0.1, x: btnX, y: btnY },
        { t: P + 0.2, x: btnX, y: btnY },
        { t: onMarts, x: 470, y: martsY },
      ]);
      const op = Math.min(seg(t, 0.25, 0.5), 1 - seg(t, pressAt + 0.25, swapAt));   // fades during the held press
      const press = t < P ? seg(t, click, click + 0.4) : seg(t, pressAt, pressAt + 0.4);
      html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, press)}</div>`;
    }

    // after Enter: the diagram's domain file is written (.erd-studio/gold/orders.json), shown beside the
    // button that made it; onboard/canvas opens it
    if (t >= nameOut + 0.1) {
      const chipX = BODY.x + tx + (DRAW_BTN.x + DRAW_BTN.w) * ZOOM + 26;
      html += `<div class="abs pill" style="left:${chipX.toFixed(0)}px;top:${(btnY - 28).toFixed(0)}px;height:56px;box-shadow:0 12px 36px #000c;font-size:26px;padding:0 22px 0 12px;background:#13301f;color:#dff7e8;border:2px solid var(--green);${appear(t, nameOut + 0.1, { dy: 8 })}"><span class="tick tick--ok" style="width:34px;height:34px">${ICON.check({ size: 22 })}</span><span class="mono" style="font-size:25px">gold/<b style="color:var(--green)">orders.json</b></span></div>`;
    }
    return html;
  },
};
