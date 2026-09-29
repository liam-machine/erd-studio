// 6 · "Switch to Physical to see what dbt actually built. / Diff compares the two, and flags
// anywhere they disagree." The same canvas. The pointer clicks the Physical tab: it turns green
// with the lock, node borders and edges blend blue -> green and the read-only tabs appear. On
// `diff` the pointer hovers Diff (its real tooltip, "Compare across stages"), clicks it — with one
// comparison on offer the button toggles straight to "⊘ Diff" — and the discrepancy panel opens
// bottom right with its own words: a freshly drawn design is a copy of the same dbt project, so
// it reads "All matched".
import { appear, COLORS, easeInOut, easeOut, edge, mix, path, pointer, seg, toolbar } from '../lib.js';
import { BODY, CANVAS, MODELS, editorWindow, orderEdges, orderNode } from '../editor.js';

// Webview copy: the Diff button's tooltip (Toolbar.tsx) and the discrepancy panel's header and
// summary (DiscrepancyPanel.tsx).
export const DIFF_TOOLTIP = 'Compare across stages';
export const DISC = { current: '(current)', target: '(target)', vs: 'vs', allMatched: 'All matched', matched: 'matched' };

// Toolbar hit points, measured from the rendered toolbar at CANVAS.toolbarX/Y.
const TAB_PHYSICAL = { x: CANVAS.toolbarX + 335, y: CANVAS.toolbarY + 32 };
const DIFF_BTN = { x: CANVAS.toolbarX + 489, y: CANVAS.toolbarY + 32 };   // once Physical (with its lock) is on

const PANEL = { w: 560, h: 148 };

export default {
  render(t, { beats }) {
    const S = beats.switch.t, D = beats.diff.t;
    // p_switch: "Switch to Physical"(+0.0–0.95) "to see what dbt actually built."(+1.05–3.16)
    const clickPhys = S + 0.65;
    // p_diff: "Diff compares the two,"(+0.0–1.3) "and flags anywhere they disagree."(+1.4–3.05)
    const hoverAt = D - 0.1;
    const clickDiff = D + 0.55;
    const panelAt = clickDiff + 0.25;

    const p = easeInOut(seg(t, clickPhys, clickPhys + 0.6));
    const physical = t >= clickPhys;
    const edgeCol = mix(COLORS.logical, COLORS.physical, p);

    let html = editorWindow({ tabs: [{ label: 'orders.json', on: true }], crumb: '.erd-studio › gold › orders.json', bodyCls: 'grid-bg' });
    html += toolbar({ x: CANVAS.toolbarX, y: CANVAS.toolbarY, stage: physical ? 'physical' : 'logical', diff: t >= clickDiff ? 'amber' : 'off' });

    for (const [pts, many, one] of orderEdges()) html += edge(pts, { color: edgeCol, many, one });
    const lock = p > 0.02;
    for (const m of MODELS) html += orderNode(m, { stage: p, lock, style: lock ? `opacity:${seg(p, 0.4, 1).toFixed(3)};` : '' }).replace(/(<div class="node" style="[^"]*?)opacity:[\d.]+;/, '$1');

    // the discrepancy panel (bottom right of the canvas)
    if (t >= panelAt) {
      const x = BODY.x + BODY.w - PANEL.w - 24, y = BODY.y + BODY.h - PANEL.h - 14;
      const pop = 1 + 0.04 * (seg(t, panelAt + 0.35, panelAt + 0.5) - seg(t, panelAt + 0.5, panelAt + 0.8));
      html += `<div class="abs" style="left:${x}px;top:${y}px;width:${PANEL.w}px;height:${PANEL.h}px;border-radius:12px;background:#1d1e22;border:1px solid #3a3c42;box-shadow:0 18px 50px #000b;${appear(t, panelAt, { dy: 18 })}">
        <div class="abs" style="left:22px;right:22px;top:16px;display:flex;align-items:center;gap:10px;font-size:22px;white-space:nowrap">
          <b style="color:${COLORS.physical}">Physical</b><span style="color:var(--text-3);font-size:18px">${DISC.current}</span><span style="color:var(--text-2)">${DISC.vs}</span><b style="color:${COLORS.logical}">Logical</b><span style="color:var(--text-3);font-size:18px">${DISC.target}</span>
          <span style="flex:1"></span><span class="pill" style="font-size:20px;background:#13301f;color:var(--green);border:2px solid #1f6b3a;transform:scale(${pop.toFixed(3)})">${DISC.allMatched}</span></div>
        <div class="abs" style="left:22px;right:22px;top:66px;height:1px;background:var(--card-border)"></div>
        <div class="abs" style="left:22px;top:84px;display:flex;align-items:baseline;gap:10px;white-space:nowrap"><span style="font-size:34px;font-weight:800">4</span><span style="font-size:20px;color:var(--text-2)">${DISC.matched}</span></div>
      </div>`;
    }

    // the Diff tooltip
    const tipOp = Math.min(seg(t, hoverAt + 0.15, hoverAt + 0.3), 1 - seg(t, clickDiff, clickDiff + 0.15));
    if (tipOp > 0) {
      html += `<div class="abs" style="left:${DIFF_BTN.x + 64}px;top:${DIFF_BTN.y - 22}px;padding:9px 16px;border-radius:6px;background:#252629;border:1px solid #454545;box-shadow:0 8px 24px #000c;font-size:22px;color:var(--text);white-space:nowrap;opacity:${tipOp.toFixed(3)}">${DIFF_TOOLTIP}</div>`;
    }

    // pointer: Physical, then Diff
    if (t < clickDiff + 1.2) {
      const pt = path(t, [
        { t: S - 0.2, x: 1100, y: 860 },
        { t: clickPhys - 0.1, ...TAB_PHYSICAL },
        { t: clickPhys + 0.5, ...TAB_PHYSICAL },
        { t: clickPhys + 1.2, x: TAB_PHYSICAL.x + 60, y: 470 },
        { t: hoverAt - 0.4, x: TAB_PHYSICAL.x + 60, y: 470 },
        { t: hoverAt, ...DIFF_BTN },
        { t: clickDiff + 0.3, ...DIFF_BTN },
        { t: clickDiff + 1.2, x: DIFF_BTN.x + 140, y: DIFF_BTN.y + 180 },
      ]);
      const press = t < D - 0.5 ? seg(t, clickPhys, clickPhys + 0.4) : seg(t, clickDiff, clickDiff + 0.4);
      const op = Math.min(seg(t, S - 0.3, S), 1 - seg(t, clickDiff + 0.5, clickDiff + 1.1));
      html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, press)}</div>`;
    }
    return html;
  },
};
