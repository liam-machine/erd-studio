// 3 · "Click New Diagram, / and give it a name." Continues from the install scene's last frame
// (ERD Studio's side bar with its start entry, the example draft beside it). The pointer clicks
// the side bar's New Diagram… button and VS Code's name box drops from the top: the real title,
// placeholder and prompt (editor.js NEW_DIAGRAM). "Orders" is typed, the validator's Info line
// follows it ("Saved as orders"), Enter, and the diagram's file lands beside the button. Then
// the window follows: the side bar becomes the Diagrams tree (Silver, Gold › orders, New Layer…,
// and the Table Library and Relationships views now .erd-studio exists), the example draft gives
// way to the new orders diagram's empty canvas, and the tables scene takes it from there.
// Shared by both cuts.
import { appear, caret, easeOut, ICON, path, pointer, seg, typed } from '../../lib.js';
import { ACT, ACT_Y, BODY, ED, EXAMPLE_DRAFT, NEW_DIAGRAM, ORDERS_TREE, QP, WIN, erdSide, quickPick } from '../../editor.js';
import { EMPTY_CANVAS } from './tables.js';
import { installedWindow } from './install.js';

const FILE_DIR = NEW_DIAGRAM.file.slice(0, NEW_DIAGRAM.file.lastIndexOf('/') + 1);
const FILE_NAME = NEW_DIAGRAM.file.slice(FILE_DIR.length);

export default {
  render(t, { beats }) {
    const C = beats.click.t, N = beats.name.t;
    // n_click: "Click"(+0.0–0.3) "New Diagram,"(+0.3–1.0)
    const click = C + 0.7;
    const boxAt = click + 0.3;
    // n_name: "and give it a name."(+0.0–0.9): the name is typed under it
    const typeAt = N + 0.2;
    const cps = 14;
    const typedEnd = typeAt + NEW_DIAGRAM.name.length / cps;
    const enterAt = typedEnd + 0.35;
    const boxOut = enterAt + 0.2;

    const glow = 1 - seg(t, click, click + 0.5);
    const swapAt = boxOut + 0.1;
    const swap = easeOut(seg(t, swapAt, swapAt + 0.4));
    const tabs = swap > 0 ? [{ label: 'Extension: ERD Studio' }, { label: EXAMPLE_DRAFT.tab }, { label: 'orders.dbml', on: true }] : null;
    let { html, geo } = installedWindow({ startGlow: glow, startPress: seg(t, click, click + 0.4), draftOp: 1 - swap, sideOp: 1 - swap, tabs });
    if (swap > 0) {
      // the new diagram opens (an empty canvas) and the side bar lists it
      const side = erdSide({ diagrams: ORDERS_TREE, tables: [], selected: 'orders', op: swap });
      const empty = `<div class="abs grid-bg" style="left:${ED}px;top:0;right:0;bottom:0;opacity:${swap.toFixed(3)}"></div>
        <div class="abs" style="left:${ED + (BODY.w - ED - 520) / 2}px;top:150px;width:520px;padding:22px 26px;border-radius:10px;background:#202126;border:1px solid #3a3c42;text-align:center;opacity:${swap.toFixed(3)}">
          <div style="font-size:24px;font-weight:700">${EMPTY_CANVAS.title}</div><div style="margin-top:10px;font-size:19px;color:var(--text-2)">${EMPTY_CANVAS.body}</div>
          <div style="margin-top:16px;display:flex;justify-content:center"><span style="display:flex;align-items:center;height:42px;padding:0 22px;border-radius:5px;background:#0e639c;color:#fff;font-size:19px;font-weight:600">${EMPTY_CANVAS.button}</span></div></div>`;
      html += `<div class="abs" style="left:${BODY.x}px;top:${BODY.y}px;width:${BODY.w}px;height:${BODY.h}px;overflow:hidden;border-radius:0 0 20px 20px">${empty}${side.html}</div>`;
    }

    // dim the window behind the name box
    const dim = t < boxOut ? easeOut(seg(t, boxAt, boxAt + 0.25)) : 0;
    if (dim > 0) html += `<div class="abs" style="left:${WIN.x}px;top:${WIN.y}px;width:${WIN.w}px;height:${WIN.h}px;border-radius:20px;background:rgba(10,11,14,${(0.55 * dim).toFixed(3)})"></div>`;

    // the name box: title, input (placeholder, then the typed name), and the line under it
    if (t >= boxAt && t < boxOut) {
      const pIn = easeOut(seg(t, boxAt, boxAt + 0.3));
      const val = typed(NEW_DIAGRAM.name, t, typeAt, cps);
      const flash = t >= enterAt;
      const input = val
        ? `<span style="color:var(--text)">${val}</span>${t < enterAt ? caret(t, typedEnd, '#e9ecef') : ''}`
        : `<span style="color:#9a9ea6">${NEW_DIAGRAM.placeholder}</span>`;
      // VS Code shows the prompt under the input until the validator returns a message.
      const msg = val
        ? `<div class="abs" style="left:14px;right:14px;top:${QP.title + QP.input + 14}px;padding:8px 14px;border-radius:4px;background:#063b49;border:1px solid #1a85ff;font-size:21px;color:var(--text);white-space:nowrap">${NEW_DIAGRAM.savedAs(val.toLowerCase())}</div>`
        : `<div class="abs" style="left:20px;right:20px;top:${QP.title + QP.input + 22}px;font-size:21px;color:var(--text-2);white-space:nowrap">${NEW_DIAGRAM.prompt}</div>`;
      const inner = `<div class="abs" style="left:14px;right:14px;top:${QP.title + 10}px;height:${QP.input}px;border-radius:5px;background:${flash ? '#1f3a57' : '#3c3c3c'};border:2px solid #0e639c;display:flex;align-items:center;padding-left:18px;font-size:25px;white-space:nowrap">${input}</div>${msg}`;
      html += quickPick(NEW_DIAGRAM.title, inner, QP.title + QP.input + 22 + 46 + 18, `opacity:${pIn.toFixed(3)};transform:translateY(${(-20 * (1 - pIn)).toFixed(1)}px)`);
    }

    // pointer: from where the install scene left it (the activity bar), onto New Diagram…
    const btn = geo.start;
    if (t < boxAt + 0.3) {
      const pt = path(t, [{ t: 0.0, x: BODY.x + ACT / 2, y: BODY.y + ACT_Y.erd + 24 }, { t: click - 0.1, x: btn.x, y: btn.y }]);
      const op = Math.min(seg(t, 0, 0.25), 1 - seg(t, boxAt, boxAt + 0.3));
      if (op > 0) html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, click, click + 0.4))}</div>`;
    }

    // the diagram's file is written; the tables scene opens it
    if (t >= boxOut + 0.1) {
      html += `<div class="abs pill" style="left:${(btn.x + 260).toFixed(0)}px;top:${(btn.y + 262).toFixed(0)}px;height:56px;box-shadow:0 12px 36px #000c;font-size:24px;padding:0 22px 0 12px;background:#13301f;color:#dff7e8;border:2px solid var(--green);${appear(t, boxOut + 0.1, { dy: 8 })}"><span class="tick tick--ok">${ICON.check({ size: 22 })}</span><span class="mono" style="font-size:23px">${FILE_DIR}<b style="color:var(--green)">${FILE_NAME}</b></span></div>`;
    }
    return html;
  },
};
