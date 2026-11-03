// 3 · "Click New Diagram, / and give it a name." Continues from the install scene's last frame
// (the walkthrough as a plain folder shows it, "Draw your first data model" open). The pointer
// clicks its New Diagram button; the step ticks itself done (its completionEvent is
// onCommand:erdStudio.createDomain) and VS Code's name box drops from the top: the real title,
// placeholder and prompt (editor.js NEW_DIAGRAM). "Orders" is typed, the validator's Info line
// follows it ("Saved as orders"), Enter, and the diagram's file lands beside the button.
import { appear, caret, easeOut, ICON, path, pointer, seg, typed } from '../../lib.js';
import { ACT, NEW_DIAGRAM, PLAIN_EXPLORER, PLAIN_FOLDER, QP, WIN, activityBar, editorWindow, quickPick, walkButton, walkthrough } from '../../editor.js';

const WT = { open: 'newDiagram', ctx: PLAIN_FOLDER, wide: true, dense: true };
const FILE_DIR = NEW_DIAGRAM.file.slice(0, NEW_DIAGRAM.file.lastIndexOf('/') + 1);
const FILE_NAME = NEW_DIAGRAM.file.slice(FILE_DIR.length);

export default {
  render(t, { beats }) {
    const C = beats.click.t, N = beats.name.t;
    // n_click: "Click"(+0.0–0.3) "New Diagram,"(+0.3–1.0)
    const click = C + 0.7;
    const doneAt = click + 0.25;
    const boxAt = click + 0.3;
    // n_name: "and give it a name."(+0.0–0.9): the name is typed under it
    const typeAt = N + 0.2;
    const cps = 14;
    const typedEnd = typeAt + NEW_DIAGRAM.name.length / cps;
    const enterAt = typedEnd + 0.35;
    const boxOut = enterAt + 0.2;

    const done = t >= doneAt ? ['newDiagram'] : [];
    const glow = 1 - 0.6 * seg(t, doneAt, doneAt + 0.5);
    let body = `<div class="abs" style="left:${ACT}px;top:0;right:0;bottom:0">${walkthrough({ ...WT, done, glow, press: seg(t, click, click + 0.4) })}</div>`;
    body += activityBar('files');
    let html = editorWindow({ tabs: [{ label: 'Extension: ERD Studio' }, { label: 'Welcome', on: true }], crumb: PLAIN_EXPLORER.root.toLowerCase(), body });

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

    // pointer: in from the bottom right, clicks New Diagram, fades as the box opens
    const btn = walkButton({ ...WT, left: ACT });
    if (t < boxAt + 0.3) {
      const pt = path(t, [{ t: 0.0, x: 1500, y: 860 }, { t: click - 0.1, x: btn.x, y: btn.y }]);
      const op = Math.min(seg(t, 0, 0.25), 1 - seg(t, boxAt, boxAt + 0.3));
      if (op > 0) html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, click, click + 0.4))}</div>`;
    }

    // the diagram's file is written; the tables scene opens it
    if (t >= boxOut + 0.1) {
      html += `<div class="abs pill" style="left:${(btn.x + 140).toFixed(0)}px;top:${(btn.y - 28).toFixed(0)}px;height:56px;box-shadow:0 12px 36px #000c;font-size:24px;padding:0 22px 0 12px;background:#13301f;color:#dff7e8;border:2px solid var(--green);${appear(t, boxOut + 0.1, { dy: 8 })}"><span class="tick tick--ok">${ICON.check({ size: 22 })}</span><span class="mono" style="font-size:23px">${FILE_DIR}<b style="color:var(--green)">${FILE_NAME}</b></span></div>`;
    }
    return html;
  },
};
