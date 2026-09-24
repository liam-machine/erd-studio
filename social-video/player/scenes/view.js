// 6b · view — "No magic. It's just a file." The same logical canvas as canvas.js / physical.js;
// the pointer clicks the real corner action "{ } View File" (webview Toolbar.tsx → `viewFile` →
// vscode.openWith(uri, 'default')) and the SAME tab becomes VS Code's text editor on orders.json.
// While the narration says the extension only renders that file, the JSON lines that make the
// diagram are tagged (models → the tables, relationships → the join). Then VS Code's own
// "Reopen Editor With…" picker — the extension's custom editor is listed under its real
// displayName, "Semantic Domain Editor" (package.json contributes.customEditors) — flips it back.
import { appear, card, COLORS, easeInOut, easeOut, edge, esc, ICON, jsonLine, lerp, node, path, pointer, rowY, seg, STORY, toolbar } from '../lib.js';

// Canvas geometry: identical to physical.js / diff.js, so every cut in this run is seamless.
const CX = 64, CY = 300, CW = 952, CH = 550;
const TBX = CX + 24, TBY = CY + 64 + 16;
const NY = CY + 186;
const DX = CX + 20, DW = 350;
const FX = DX + DW + 82, FW = 490;
const MIDX = (DX + DW + FX) / 2;

// The corner action, top-right of the canvas (the real button: `{ } View File`).
const VF = { w: 206, h: 50 };
VF.x = CX + CW - 24 - VF.w; VF.y = TBY + 6;

// Text editor body.
const LH = 29, FS = 24, TOP = CY + 64 + 16;
const lineY = (i) => TOP + i * LH;               // top of JSON line i (0-based)

// Quick pick ("Reopen Editor With…").
const QP = { x: CX + 90, y: CY + 78, w: CW - 180 };
const QP_ROW = 58;

const braces = (size = 22) => `<span class="mono" style="font-size:${size}px;font-weight:700;letter-spacing:-.05em">{ }</span>`;

export default {
  render(t, { beats }) {
    const c = beats.click.t, f = beats.format.t, b = beats.back.t;
    // Timings measured in the clips (silencedetect):
    const press = c + 0.55;          // "Click View File,"
    const toText = [c + 0.8, c + 1.25]; // the tab flips to the text editor as "…the JSON" lands
    const tagModels = f + 1.3;       // "…just renders that file"
    const tagJoin = f + 1.8;
    const fmt = f + 2.9;             // "…one simple, documented format"
    const pick = b + 0.15;           // "Reopen it…"
    const choose = b + 1.25;         // "…with ERD Studio"
    const toCanvas = [b + 1.45, b + 1.95]; // back to a diagram by "…diagram again"

    const toTextP = easeInOut(seg(t, toText[0], toText[1]));
    const toCanvasP = easeInOut(seg(t, toCanvas[0], toCanvas[1]));
    const textOp = toTextP * (1 - toCanvasP);     // 0 = canvas, 1 = text editor
    const canvasOp = 1 - textOp;
    const inText = textOp > 0.5;

    // ---- the editor card (same tab throughout: it is the same file) ----
    let html = card({
      x: CX, y: CY, w: CW, h: CH,
      tabs: [{ label: 'orders.json', on: true, icon: inText ? `<span style="color:#e2c08d">${braces(20)}</span>` : '' }],
      crumb: inText ? '.erd-studio › silver › orders.json' : '.erd-studio › silver',
      bodyCls: inText ? '' : 'grid-bg',
    });

    // ---- canvas view ----
    if (canvasOp > 0.001) {
      const sc = lerp(1, 0.97, textOp);
      let cv = toolbar({ x: TBX, y: TBY, domain: STORY.domain, layer: STORY.layer, stage: 'logical' });
      // The corner action. Pressed state while the pointer clicks it.
      const pressed = seg(t, press - 0.05, press + 0.1) * (1 - seg(t, press + 0.25, press + 0.5));
      cv += `<div class="abs" style="left:${VF.x}px;top:${VF.y}px;width:${VF.w}px;height:${VF.h}px;border-radius:10px;border:1px solid ${pressed > 0 ? '#1177bb' : 'var(--card-border)'};background:${pressed > 0 ? '#0e639c' : 'var(--card-head)'};color:${pressed > 0 ? '#fff' : 'var(--text)'};display:flex;align-items:center;justify-content:center;gap:10px;font-size:24px;font-weight:600;white-space:nowrap">${braces(22)}View File</div>`;
      const sy = NY + rowY(0), cy = NY + rowY(1);
      cv += edge([[DX + DW, sy], [MIDX, sy], [MIDX, cy], [FX, cy]], { color: COLORS.logical, one: [DX + DW + 8, sy - 10], many: [FX - 22, cy - 8] });
      cv += node({ x: DX, y: NY, w: DW, name: 'dim_customer', layer: STORY.layer, grain: STORY.dim_customer.grain, cols: STORY.dim_customer.cols });
      cv += node({ x: FX, y: NY, w: FW, name: 'fct_order', layer: STORY.layer, grain: STORY.fct_order.grain, cols: STORY.fct_order.cols });
      html += `<div class="abs" style="left:0;top:0;width:1080px;height:1350px;opacity:${canvasOp.toFixed(3)};transform:scale(${sc.toFixed(4)});transform-origin:540px ${CY + CH / 2}px">${cv}</div>`;
    }

    // ---- text editor view: the file itself ----
    if (textOp > 0.001) {
      const models = seg(t, tagModels, tagModels + 0.3);
      const join = seg(t, tagJoin, tagJoin + 0.3);
      const hot = (i) => (i === 5 ? models : i >= 6 && i <= 12 ? join : 0);
      let tx = '';
      STORY.ordersJson.forEach((ln, i) => {
        const h = hot(i);
        const dim = (models > 0 || join > 0) && h === 0 ? 0.55 : 1;
        if (h > 0) tx += `<div class="abs" style="left:${CX + 1}px;top:${lineY(i)}px;width:${CW - 2}px;height:${LH}px;background:rgba(37,99,235,${(0.2 * h).toFixed(3)});box-shadow:inset 4px 0 0 rgba(96,165,250,${h.toFixed(3)})"></div>`;
        tx += `<div class="abs mono" style="left:${CX + 18}px;top:${lineY(i)}px;width:44px;text-align:right;font-size:${FS}px;line-height:${LH}px;color:var(--line-no)">${i + 1}</div>`;
        tx += `<div class="abs mono" style="left:${CX + 88}px;top:${lineY(i)}px;font-size:${FS}px;line-height:${LH}px;white-space:pre;opacity:${dim}">${jsonLine(ln)}</div>`;
      });
      // Tags: what each part of the file becomes on the canvas.
      const tag = (label, y, at, color = COLORS.logical) =>
        `<div class="abs" style="right:${1080 - (CX + CW - 22)}px;top:${y}px;${appear(t, at, { dx: 12, dy: 0 })}">
          <span class="pill" style="font-size:24px;padding:6px 16px;gap:8px;background:#0b1422;border:2px solid ${color};color:#cfe3ff;box-shadow:0 8px 24px #0008">${ICON.arrow({ size: 20 })}${label}</span></div>`;
      if (t >= tagModels) tx += tag('the 2 tables', lineY(4) - 16, tagModels);   // beside the short line above: the models line itself runs to the right edge
      if (t >= tagJoin) tx += tag('the join', lineY(8) + 2, tagJoin);
      html += `<div class="abs" style="left:0;top:0;width:1080px;height:1350px;opacity:${textOp.toFixed(3)}">${tx}</div>`;
    }

    // ---- below the card: the format ----
    if (t >= fmt) {
      const out = 1 - seg(t, toCanvas[0], toCanvas[1]);
      html += `<div class="abs" style="left:${CX}px;width:${CW}px;top:${CY + CH + 44}px;display:flex;flex-direction:column;align-items:center;gap:18px;opacity:${out.toFixed(3)}">
        <div style="display:flex;align-items:center;gap:14px;${appear(t, fmt, { dy: 12 })}">
          <span class="pill" style="font-size:28px;padding:12px 24px;gap:12px;background:#1b2a40;border:2px solid #2d4a70;color:#cfe3ff"><span style="color:#e2c08d">${braces(24)}</span>schemaVersion 5</span>
          <span style="font-size:30px;font-weight:700">one documented format</span></div>
        <div class="mono" style="font-size:24px;color:var(--text-2);${appear(t, fmt + 0.3, { dy: 8 })}">docs/semantic-domain-json-reference.md</div></div>`;
    }

    // ---- "Reopen Editor With…" (VS Code's own picker) ----
    const qpIn = easeOut(seg(t, pick, pick + 0.25));
    const qpOut = seg(t, toCanvas[0] - 0.05, toCanvas[0] + 0.2);
    if (t >= pick && qpOut < 1) {
      const op = qpIn * (1 - qpOut);
      const onPick = t >= choose;
      const row = (i, label, desc, sel) => `<div style="position:absolute;left:10px;right:10px;top:${76 + i * QP_ROW}px;height:${QP_ROW - 6}px;border-radius:8px;display:flex;align-items:center;gap:14px;padding:0 18px;font-size:26px;white-space:nowrap;${sel ? 'background:#04395e;box-shadow:inset 0 0 0 1px #0e639c;' : ''}">
          <span style="font-weight:600">${label}</span><span style="font-size:22px;color:var(--text-2)">${desc}</span></div>`;
      html += `<div class="abs" style="left:${QP.x}px;top:${QP.y}px;width:${QP.w}px;height:${76 + 2 * QP_ROW + 10}px;border-radius:14px;background:#1f2126;border:1px solid #3a3d45;box-shadow:0 24px 60px #000c;opacity:${op.toFixed(3)};transform:translateY(${lerp(-10, 0, qpIn).toFixed(1)}px)">
        <div style="position:absolute;left:14px;right:14px;top:14px;height:50px;border-radius:8px;border:2px solid #0e639c;background:#16181c;display:flex;align-items:center;padding:0 16px;font-size:24px;color:var(--text-2);white-space:nowrap">Select editor for ${esc("'orders.json'")}</div>
        ${row(0, 'Text Editor', 'Built-in · active', !onPick)}
        ${row(1, 'Semantic Domain Editor', 'ERD Studio', onPick)}</div>`;
    }

    // ---- pointer ----
    const vfC = { x: VF.x + VF.w * 0.55, y: VF.y + VF.h * 0.55 };
    const optC = { x: QP.x + 250, y: QP.y + 76 + QP_ROW + 26 };
    const pts = [
      { t: c - 0.2, x: 760, y: 1040 },
      { t: press - 0.05, ...vfC },
      { t: toText[1] + 0.3, ...vfC },
      { t: toText[1] + 1.0, x: 940, y: 1020 },
      { t: pick + 0.2, x: 940, y: 1020 },
      { t: choose - 0.05, ...optC },
      { t: toCanvas[1] + 0.3, ...optC },
      { t: toCanvas[1] + 1.1, x: 900, y: 1040 },
    ];
    const pOp = Math.min(seg(t, c - 0.2, c + 0.1), 1 - seg(t, toText[1] + 0.6, toText[1] + 1.0)) +
      Math.min(seg(t, pick - 0.1, pick + 0.2), 1 - seg(t, toCanvas[1] + 0.5, toCanvas[1] + 0.9));
    if (pOp > 0.01) {
      const at = path(t, pts);
      const click = t < pick ? seg(t, press, press + 0.35) : seg(t, choose, choose + 0.35);
      html += `<div class="abs" style="left:0;top:0;opacity:${Math.min(1, pOp).toFixed(3)}">${pointer(at.x, at.y, click)}</div>`;
    }
    return html;
  },
};
