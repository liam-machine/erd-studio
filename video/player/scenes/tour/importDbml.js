// 6 · "Export to DBML or Mermaid any time. / Already have DBML? Import it, then keep the draft."
// The window as the folder shows it now it has a diagram:
// ERD Studio's side bar (Diagrams: Gold › orders) beside the orders canvas. On `export` the Export
// Diagram command's format QuickPick drops in with its real rows (src/commands/exportDiagram.ts).
// On `import` the pointer opens the Diagrams view's + menu (erdStudio.newMenu) and picks Import
// DBML…, the step-by-step path (src/commands/importDbml.ts): a sales.dbml is picked, then, quickly,
// the layer (asked here: the project has a diagram and two layers, so there is no default) and the
// name box with the file's name. Its draft opens (src/services/draftModel.ts draftFromImportPlan):
// the banner's headline and detail, Show details, Keep as Diagram, More ways to start, Discard,
// over the diagram it would keep, drawn read-only. Nothing is written until Keep.
// Shared by both cuts; the README GIF draws the same draft page.
import { easeOut, edge, ICON, node, path, pointer, seg, toolbar } from '../../lib.js';
import { ED, ORDERS_TREE, QP, SALES_DRAFT, WIN, activityBar, draftPage, editorWindow, erdSide, newMenu, newMenuRow, quickPick } from '../../editor.js';
import { TABLES, relEdge } from './tables.js';

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

// Import DBML…'s own questions (importDbml.ts: TITLE, the layer pick's placeholder
// WHICH_LAYER_FOR_DIAGRAM from layerWording.ts, the name box's prompt and its suggested name).
export const IMPORT_STEPS = {
  title: 'Import DBML',
  layerPlaceholder: 'Which layer is this diagram for? A layer is a stage of your warehouse, such as Staging or Gold; a diagram can show tables from any layer.',
  layers: ['Silver', 'Gold'],
  namePrompt: 'Name the diagram. It is saved in the Gold layer.',
  name: 'sales',
};

const LIST_Y = QP.title + QP.input + 22, ROW = 88;
/** The orders canvas in the editor area beside the side bar: the tables scene's diagram, scaled. */
export function ordersCanvas({ scale = 0.8, from = { x: 150, y: 470 } } = {}) {
  const [pts, many, one] = relEdge();
  const inner = edge(pts, { many, one }) + TABLES.map((m) => node({ ...m, layer: 'GLD' })).join('');
  return `<div class="abs grid-bg" style="left:${ED}px;top:0;right:0;bottom:0;background-color:var(--card)"></div>
    <div class="abs" style="left:${ED + 40}px;top:110px;transform-origin:0 0;transform:scale(${scale}) translate(${-from.x}px,${-from.y}px)">${inner}</div>
    ${toolbar({ x: ED + 24, y: 16, logicalOnly: true, layout: 'idle', add: 'idle' })}`;
}

export default {
  render(t, { beats }) {
    const E = beats.export.t, EE = beats.export.end, M = beats.import.t;
    // m_export: "Export to DBML"(+0.0–1.26) "or Mermaid any time."(+1.5–2.62)
    const pickAt = E + 0.4, pickOut = EE + 0.1;
    // m_import: "Already have DBML?"(+0.0–1.25) "Import it,"(+1.6–2.1) "then keep the draft."(+2.2–3.09)
    const plusClick = M + 0.55, menuAt = plusClick + 0.1;
    const rowClick = M + 1.05;              // Import DBML…
    const fileAt = rowClick + 0.1;          // the file it picks
    const layerAt = M + 1.45, layerHot = M + 1.62, layerOut = M + 1.82;   // the layer: Gold
    const nameAt = M + 1.85, nameEnter = M + 2.12, nameOut = M + 2.2;     // the name: sales, Enter
    const draftAt = M + 2.25;
    const keepGlow = M + 2.65;              // "…keep the draft"

    const drafting = t >= draftAt;
    const side = erdSide({ diagrams: ORDERS_TREE, selected: drafting ? null : 'orders', plusHot: t >= plusClick - 0.25 && t < menuAt + 0.6 ? 1 : 0 });
    let body = drafting
      ? draftPage(SALES_DRAFT, { op: easeOut(seg(t, draftAt, draftAt + 0.35)), glow: easeOut(seg(t, keepGlow, keepGlow + 0.4)) }).html
      : ordersCanvas();
    body += side.html;
    body += activityBar('erd');
    const tabs = [{ label: 'orders.dbml', on: !drafting }];
    if (drafting) tabs.push({ label: SALES_DRAFT.tab, on: true });
    let html = editorWindow({ tabs, body });

    // the Export Diagram format pick
    if (t >= pickAt && t < pickOut + 0.2) {
      const out = 1 - seg(t, pickOut, pickOut + 0.2);
      const dim = easeOut(seg(t, pickAt, pickAt + 0.25)) * out;
      html += `<div class="abs" style="left:${WIN.x}px;top:${WIN.y}px;width:${WIN.w}px;height:${WIN.h}px;border-radius:20px;background:rgba(10,11,14,${(0.55 * dim).toFixed(3)})"></div>`;
      const pIn = easeOut(seg(t, pickAt, pickAt + 0.3)) * out;
      let inner = `<div class="abs" style="left:14px;right:14px;top:${QP.title + 10}px;height:${QP.input}px;border-radius:5px;background:#3c3c3c;border:2px solid #0e639c;display:flex;align-items:center;padding-left:18px;font-size:23px;color:#9a9ea6;white-space:nowrap">${EXPORT_PICK.placeholder}</div>`;
      EXPORT_PICK.rows.forEach((r, i) => {
        const focus = i === 0;
        inner += `<div class="abs" style="left:8px;right:8px;top:${LIST_Y + i * (ROW + 4)}px;height:${ROW}px;border-radius:6px;${focus ? 'background:#04395e;box-shadow:inset 0 0 0 2px #0e639c;' : ''}">
          <div class="abs" style="left:20px;top:10px;right:16px;display:flex;align-items:center;gap:14px;white-space:nowrap"><span style="font-size:26px;font-weight:600">${r.label}</span><span style="font-size:22px;color:var(--text-2)">${r.description}</span></div>
          <div class="abs" style="left:20px;right:20px;top:52px;font-size:21px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.detail}</div></div>`;
      });
      html += quickPick(EXPORT_PICK.title, inner, LIST_Y + 3 * (ROW + 4) + 10, `opacity:${pIn.toFixed(3)};transform:translateY(${(-20 * (1 - pIn)).toFixed(1)}px)`);
    }

    // the + menu, Import DBML…, and the file it reads
    const plus = side.geo.plus;
    const importRow = newMenuRow(plus, 1);
    if (t >= menuAt && t < rowClick + 0.2) {
      html += newMenu(plus, { hot: t >= rowClick - 0.3 ? 1 : -1, op: easeOut(seg(t, menuAt, menuAt + 0.12)) * (1 - seg(t, rowClick + 0.05, rowClick + 0.2)) });
    }
    if (t >= fileAt && t < layerAt + 0.2) {
      const op = Math.min(1, seg(t, fileAt, fileAt + 0.12)) * (1 - seg(t, layerAt, layerAt + 0.2));
      html += `<div class="abs pill" style="left:${importRow.x - 60}px;top:${importRow.y - 26}px;height:52px;padding:0 20px 0 14px;font-size:22px;background:#1b2a40;color:#cfe3ff;border:2px solid var(--logical);box-shadow:0 12px 36px #000c;opacity:${op.toFixed(3)}"><span style="color:#5ca2f8;display:flex">${ICON.file({ size: 22 })}</span><span class="mono">${SALES_DRAFT.file}</span></div>`;
    }

    // the layer pick, then the name box (Enter takes each)
    const dimOp = Math.min(easeOut(seg(t, layerAt, layerAt + 0.12)), 1 - seg(t, nameOut, nameOut + 0.1));
    if (dimOp > 0) html += `<div class="abs" style="left:${WIN.x}px;top:${WIN.y}px;width:${WIN.w}px;height:${WIN.h}px;border-radius:20px;background:rgba(10,11,14,${(0.45 * dimOp).toFixed(3)})"></div>`;
    if (t >= layerAt && t < layerOut + 0.1) {
      const pIn = easeOut(seg(t, layerAt, layerAt + 0.12)) * (1 - seg(t, layerOut, layerOut + 0.1));
      let inner = `<div class="abs" style="left:14px;right:14px;top:${QP.title + 10}px;height:${QP.input}px;border-radius:5px;background:#3c3c3c;border:2px solid #0e639c;display:flex;align-items:center;padding:0 18px;font-size:21px;color:#9a9ea6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${IMPORT_STEPS.layerPlaceholder}</div>`;
      IMPORT_STEPS.layers.forEach((label, i) => {
        const focus = t >= layerHot ? i === 1 : i === 0;
        inner += `<div class="abs" style="left:8px;right:8px;top:${LIST_Y + i * 50}px;height:46px;border-radius:6px;display:flex;align-items:center;padding-left:20px;font-size:24px;${focus ? 'background:#04395e;box-shadow:inset 0 0 0 2px #0e639c;' : ''}">${label}</div>`;
      });
      html += quickPick(IMPORT_STEPS.title, inner, LIST_Y + 2 * 50 + 10, `opacity:${pIn.toFixed(3)}`);
    }
    if (t >= nameAt && t < nameOut + 0.08) {
      const pIn = easeOut(seg(t, nameAt, nameAt + 0.1)) * (1 - seg(t, nameOut, nameOut + 0.08));
      const flash = t >= nameEnter;
      const inner = `<div class="abs" style="left:14px;right:14px;top:${QP.title + 10}px;height:${QP.input}px;border-radius:5px;background:${flash ? '#1f3a57' : '#3c3c3c'};border:2px solid #0e639c;display:flex;align-items:center;padding-left:18px;font-size:25px;white-space:nowrap"><span style="background:#264f78">${IMPORT_STEPS.name}</span></div>
        <div class="abs" style="left:20px;right:20px;top:${QP.title + QP.input + 22}px;font-size:21px;color:var(--text-2);white-space:nowrap">${IMPORT_STEPS.namePrompt}</div>`;
      html += quickPick(IMPORT_STEPS.title, inner, QP.title + QP.input + 22 + 46 + 18, `opacity:${pIn.toFixed(3)}`);
    }

    // pointer: onto the +, then Import DBML… (the questions after it are answered with Enter)
    if (t >= M - 0.2 && t < layerAt + 0.3) {
      const pt = path(t, [{ t: M, x: 1100, y: 860 }, { t: plusClick - 0.1, ...plus }, { t: rowClick - 0.15, ...importRow }]);
      const op = Math.min(seg(t, M - 0.2, M + 0.1), 1 - seg(t, fileAt + 0.1, layerAt + 0.2));
      const press = Math.max(t >= plusClick && t < plusClick + 0.4 ? seg(t, plusClick, plusClick + 0.4) : 0, t >= rowClick && t < rowClick + 0.4 ? seg(t, rowClick, rowClick + 0.4) : 0);
      if (op > 0) html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, press)}</div>`;
    }
    return html;
  },
};
