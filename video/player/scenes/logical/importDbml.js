// 6 · "Already have DBML? Import it, and export back any time." The walkthrough as the folder
// shows it now that it has a diagram (openDiagram in place of newDiagram), with "Start from a
// DBML file" open and its real image (a .dbml file becoming a diagram); the pointer rests on its
// Import DBML… button on "Import it". On "…export back any time" the Export Diagram command's
// format QuickPick drops in with its real rows (src/commands/exportDiagram.ts FORMAT_ITEMS).
import { easeOut, path, pointer, seg } from '../../lib.js';
import { ACT, PLAIN_FOLDER_WITH_DIAGRAM, QP, WIN, activityBar, editorWindow, quickPick, walkButton, walkthrough } from '../../editor.js';

// Export Diagram… (EXPORT_TITLE, its placeholder for this diagram, FORMAT_ITEMS).
export const EXPORT_PICK = {
  title: 'Export Diagram (logical design)',
  placeholder: 'Export the design of "orders" as…',
  rows: [
    { label: 'Mermaid', description: '.mmd', detail: 'Renders in GitHub, GitLab and Markdown docs' },
    { label: 'DBML', description: '.dbml', detail: "Opens in any DBML tool. ERD Studio's fields go in notes; no table positions" },
    { label: 'Rich DBML', description: '.dbml', detail: 'Every ERD Studio field, positions in erd_layout. Needs DBML 9.1 or later, as dbdiagram.io and dbdocs read' },
  ],
};

const WT = { open: 'importDbml', ctx: PLAIN_FOLDER_WITH_DIAGRAM, wide: true };
const LIST_Y = QP.title + QP.input + 22, ROW = 88;

export default {
  render(t, { beats }) {
    const I = beats.import.t;
    // m_import: "Already have DBML?"(+0.0–1.36) "Import it,"(+1.74–2.23) "and export back any time."(+2.37–3.74)
    const glowAt = I + 0.1;
    const hoverAt = I + 1.7;
    const pickAt = I + 2.4;

    const hover = t >= hoverAt && t < pickAt;
    let body = `<div class="abs" style="left:${ACT}px;top:0;right:0;bottom:0">${walkthrough({ ...WT, done: [], glow: easeOut(seg(t, glowAt, glowAt + 0.4)), press: hover ? 0.5 : 0 })}</div>`;
    body += activityBar('erd');
    let html = editorWindow({ tabs: [{ label: 'orders.dbml' }, { label: 'Welcome', on: true }], crumb: 'shop-analytics', body });

    // the Export Diagram format pick
    if (t >= pickAt) {
      const dim = easeOut(seg(t, pickAt, pickAt + 0.25));
      html += `<div class="abs" style="left:${WIN.x}px;top:${WIN.y}px;width:${WIN.w}px;height:${WIN.h}px;border-radius:20px;background:rgba(10,11,14,${(0.55 * dim).toFixed(3)})"></div>`;
      const pIn = easeOut(seg(t, pickAt, pickAt + 0.3));
      let inner = `<div class="abs" style="left:14px;right:14px;top:${QP.title + 10}px;height:${QP.input}px;border-radius:5px;background:#3c3c3c;border:2px solid #0e639c;display:flex;align-items:center;padding-left:18px;font-size:23px;color:#9a9ea6;white-space:nowrap">${EXPORT_PICK.placeholder}</div>`;
      EXPORT_PICK.rows.forEach((r, i) => {
        const focus = i === 0;
        inner += `<div class="abs" style="left:8px;right:8px;top:${LIST_Y + i * (ROW + 4)}px;height:${ROW}px;border-radius:6px;${focus ? 'background:#04395e;box-shadow:inset 0 0 0 2px #0e639c;' : ''}">
          <div class="abs" style="left:20px;top:10px;right:16px;display:flex;align-items:center;gap:14px;white-space:nowrap"><span style="font-size:26px;font-weight:600">${r.label}</span><span style="font-size:22px;color:var(--text-2)">${r.description}</span></div>
          <div class="abs" style="left:20px;right:20px;top:52px;font-size:21px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.detail}</div></div>`;
      });
      html += quickPick(EXPORT_PICK.title, inner, LIST_Y + 3 * (ROW + 4) + 10, `opacity:${pIn.toFixed(3)};transform:translateY(${(-20 * (1 - pIn)).toFixed(1)}px)`);
    }

    // pointer onto Import DBML…
    const btn = walkButton({ ...WT, left: ACT });
    if (t < pickAt + 0.3) {
      const pt = path(t, [{ t: I + 0.4, x: 1300, y: 880 }, { t: hoverAt - 0.05, x: btn.x, y: btn.y }]);
      const op = Math.min(seg(t, I + 0.2, I + 0.5), 1 - seg(t, pickAt, pickAt + 0.3));
      if (op > 0) html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y)}</div>`;
    }
    return html;
  },
};
