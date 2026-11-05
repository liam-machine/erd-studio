// The default cut's dbt beat, its last content scene: "Using dbt? Then a Physical tab shows what
// dbt has. / Click Compare with dbt to mark every difference." The orders canvas from the tour,
// now in a dbt project: on "Using dbt?" a dbt_project.yml chip lands, the canvas takes the
// logical stage's blue (a plain folder's canvas is neutral grey) and the toolbar gains its dbt
// controls (webview Toolbar.tsx: the Compare button, compareButtonWording, and the Logical ·
// Physical tabs with their hints as a second row under it, StageTabs.tsx). The pointer clicks
// Physical on "…a Physical tab": it turns green with the lock, "+ Add" goes (the stage is
// read-only), the cards blend blue -> green, each gets its read-only tab and shows the columns and
// types dbt has. Back on Logical ("Compare with dbt" in the toolbar again), the pointer clicks it
// as the voice names it: the rows that differ turn amber (a column only the design has, badged
// "only here"; a type that differs, as "logical:" / "physical:" lines, ModelNode.tsx) and the
// discrepancy panel opens with its own words (DiscrepancyPanel.tsx). The only scene of either cut that names
// dbt (npm test holds the rest of both cuts to none).
import { appear, COLORS, COMPARE_WORDS, easeInOut, easeOut, edge, ICON, mix, node, path, pointer, seg, toolbar } from '../../lib.js';
import { BODY, CANVAS, editorWindow } from '../../editor.js';
import { TABLES, relEdge } from '../tour/tables.js';

// The discrepancy panel's header and summary (DiscrepancyPanel.tsx).
export const DISC = { current: '(current)', target: '(target)', vs: 'vs', sync: '⊕ Sync', matched: 'matched', typeDiff: 'type diff', colDiff: 'col diff', only: 'only here' };
// What the dbt project has for the two tables: one column fewer and one type that differs.
const PHYSICAL_TYPES = { amount: 'NUMBER(38,2)' };
const ONLY_IN_DESIGN = 'description';

// Toolbar hit points, measured from the rendered toolbar at CANVAS.toolbarX/Y (dbt controls on:
// the Compare button in the first row, the stage tabs in the second).
export const TB = {
  logical: { x: CANVAS.toolbarX + 298, y: CANVAS.toolbarY + 96 },
  // on the Physical tab the row has no "+ Add", so it is narrower and the tabs pill sits further left
  logicalFromPhysical: { x: CANVAS.toolbarX + 234, y: CANVAS.toolbarY + 96 },
  physical: { x: CANVAS.toolbarX + 535, y: CANVAS.toolbarY + 96 },
  compare: { x: CANVAS.toolbarX + 531, y: CANVAS.toolbarY + 33 },
};
const PANEL = { x: 1135, w: 455, h: 118 };
// The diagram is drawn at 85% about the window body's bottom centre, so the toolbar's second row
// (the stage tabs) clears the tables and their read-only tabs.
const DIAGRAM_SCALE = 0.85;

export default {
  render(t, { beats }) {
    const K = beats.tabs.t, C = beats.compare.t;
    // k_tabs: "Using dbt?"(+0.0–1.06) "Then a Physical tab"(+1.46–2.6) "shows what dbt has."(+2.6–3.98)
    const chipAt = K + 0.45;
    const tabsAt = K + 1.2;
    const clickPhys = K + 2.0;
    // k_compare: "Click"(+0.0–0.17) "Compare with dbt"(+0.27–1.44) "to mark every difference."(+1.64–2.87)
    // Back on Logical as "…what dbt has" ends, so "Compare with dbt" shows while the voice names it.
    const clickLog = C - 0.55;
    const clickCmp = C + 1.45;
    const panelAt = clickCmp + 0.2;

    const toPhys = easeInOut(seg(t, clickPhys, clickPhys + 0.6));
    const toLog = easeInOut(seg(t, clickLog, clickLog + 0.4));
    const p = toPhys * (1 - toLog);                     // 0 logical .. 1 physical
    const physical = t >= clickPhys && t < clickLog;
    const comparing = t >= clickCmp;

    let html = editorWindow({ tabs: [{ label: 'orders.dbml', on: true }], crumb: '.erd-studio › gold › diagrams › orders.dbml', bodyCls: 'grid-bg' });
    // the toolbar: logical-only, then (cross-faded) with the dbt controls
    const dbtOp = easeOut(seg(t, tabsAt, tabsAt + 0.35));
    let toolbars = '';
    if (dbtOp < 1) toolbars += toolbar({ x: CANVAS.toolbarX, y: CANVAS.toolbarY, logicalOnly: true, layout: 'idle', add: 'idle', style: `opacity:${(1 - dbtOp).toFixed(3)};` });
    if (dbtOp > 0) toolbars += toolbar({ x: CANVAS.toolbarX, y: CANVAS.toolbarY, logicalOnly: false, stage: physical ? 'physical' : 'logical', compare: comparing ? 'on' : 'off', layout: 'idle', add: 'idle', style: `opacity:${dbtOp.toFixed(3)};` });

    // the dbt project: its dbt_project.yml lands in the window's title bar
    if (t >= chipAt) {
      html += `<div class="abs pill" style="right:${1920 - BODY.x - BODY.w + 24}px;top:${BODY.y - 54}px;height:44px;font-size:20px;padding:0 18px 0 12px;background:#13301f;border:2px solid #1f6b3a;color:#dff7e8;${appear(t, chipAt, { dy: 8 })}"><span style="color:#d9b35a;display:flex">${ICON.file({ size: 20 })}</span><span class="mono" style="font-size:19px">dbt_project.yml</span></div>`;
    }

    // the diagram: neutral (the plain folder it was), then blue (the design) once dbt is there, green
    // (what dbt has) on Physical, amber where they differ
    const toBlue = (c) => mix(COLORS.neutralLine, c, dbtOp);
    const edgeCol = toBlue(mix(COLORS.logical, COLORS.physical, p));
    const border = mix(COLORS.neutralBorder, mix(COLORS.logical, COLORS.physical, p), dbtOp);
    const [pts, many, one] = relEdge();
    let diagram = edge(pts, { color: edgeCol, many, one });
    for (const m of TABLES) {
      const cols = m.cols
        .filter((c) => !(physical && c.name === ONLY_IN_DESIGN))
        .map((c) => {
          if (comparing && c.name === ONLY_IN_DESIGN) {
            return { ...c, row: 'amber', pill: `<span class="badge badge--only" style="margin-left:10px">${DISC.only}</span>`, rowStyle: appear(t, panelAt, { dy: 0, dur: 0.25 }) };
          }
          if (PHYSICAL_TYPES[c.name] && comparing) {
            return { ...c, row: 'amber', types: [['logical:', c.type, COLORS.logical], ['physical:', PHYSICAL_TYPES[c.name], COLORS.physical]] };
          }
          if (PHYSICAL_TYPES[c.name] && physical) return { ...c, type: PHYSICAL_TYPES[c.name] };
          return c;
        });
      diagram += node({ ...m, layer: 'GLD', cols, border, lock: physical && toPhys > 0.4, style: physical ? `opacity:${seg(toPhys, 0.4, 1).toFixed(3)};` : '' }).replace(/(<div class="node" style="[^"]*?)opacity:[\d.]+;/, '$1');
    }

    html += `<div class="abs" style="left:0;top:0;width:1920px;height:1080px;transform-origin:${BODY.x + BODY.w / 2}px ${BODY.y + BODY.h}px;transform:scale(${DIAGRAM_SCALE})">${diagram}</div>`;
    html += toolbars;

    // the discrepancy panel
    if (t >= panelAt) {
      const x = PANEL.x, y = BODY.y + BODY.h - PANEL.h - 6;
      const stat = (n, label, col) => `<span style="display:flex;align-items:baseline;gap:8px"><b style="font-size:30px;color:${col}">${n}</b><span style="font-size:18px;color:var(--text-2)">${label}</span></span>`;
      html += `<div class="abs" style="left:${x}px;top:${y}px;width:${PANEL.w}px;height:${PANEL.h}px;border-radius:12px;background:#1d1e22;border:1px solid #3a3c42;box-shadow:0 18px 50px #000b;${appear(t, panelAt, { dy: 18 })}">
        <div class="abs" style="left:18px;right:18px;top:10px;display:flex;align-items:center;gap:8px;font-size:19px;white-space:nowrap">
          <b style="color:${COLORS.logical}">Logical</b><span style="color:var(--text-3);font-size:16px">${DISC.current}</span><span style="color:var(--text-2)">${DISC.vs}</span><b style="color:${COLORS.physical}">Physical</b><span style="color:var(--text-3);font-size:16px">${DISC.target}</span>
          <span style="flex:1"></span><span style="padding:4px 10px;border-radius:6px;border:1px solid #4a4d55;font-size:16px;color:var(--text)">${DISC.sync}</span></div>
        <div class="abs" style="left:18px;right:18px;top:50px;height:1px;background:var(--card-border)"></div>
        <div class="abs" style="left:18px;top:62px;display:flex;gap:26px;white-space:nowrap">${stat(2, DISC.matched, 'var(--text)')}${stat(1, DISC.typeDiff, 'var(--amber)')}${stat(1, DISC.colDiff, 'var(--amber)')}</div>
      </div>`;
    }

    // pointer: Physical, then Logical, then Compare with dbt
    if (t >= K + 1.0 && t < clickCmp + 1.0) {
      const pt = path(t, [
        { t: K + 1.1, x: 1100, y: 860 },
        { t: clickPhys - 0.1, ...TB.physical },
        { t: clickPhys + 0.5, ...TB.physical },
        { t: clickPhys + 1.1, x: TB.physical.x + 40, y: 560 },
        { t: clickLog - 0.45, x: TB.physical.x + 40, y: 560 },
        { t: clickLog - 0.1, ...TB.logicalFromPhysical },
        { t: clickLog + 0.2, ...TB.logicalFromPhysical },
        { t: clickLog + 0.9, ...TB.compare },
        { t: clickCmp - 0.05, ...TB.compare },
        { t: clickCmp + 1.0, x: TB.compare.x + 120, y: TB.compare.y + 180 },
      ]);
      const press = Math.max(...[clickPhys, clickLog, clickCmp].map((at) => (t >= at && t < at + 0.4 ? seg(t, at, at + 0.4) : 0)));
      const op = Math.min(seg(t, K + 1.0, K + 1.3), 1 - seg(t, clickCmp + 0.5, clickCmp + 1.0));
      html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, press)}</div>`;
    }
    return html;
  },
};

export { COMPARE_WORDS };
