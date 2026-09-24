// 6 · The files become a diagram. The editor card (tab orders.json, crumb .erd-studio › silver)
// opens the logical canvas: toolbar, then dim_customer and fct_order land (each labelled with
// the file it comes from) and the relationship edge draws in on "…as a diagram"; an "in VS Code"
// pill follows. On "Edit either one…" a fct_order.yml panel under the card gains
// `- name: order_status` and, in the same beat, the fct_order node grows the row: both green,
// with a "files ⇄ diagram" pill.
//
// Canvas geometry matches physical.js / diff.js exactly (card, toolbar, node positions), so the
// cut into the next scene is seamless.
import { appear, appIcon, card, caret, COLORS, easeOut, edge, ICON, node, NODE, rowY, seg, STORY, toolbar, typed, yamlLine } from '../lib.js';

const CX = 64, CY = 300, CW = 952, CH = 550;
const TBX = CX + 24, TBY = CY + 64 + 16;
const NY = CY + 186;
const DX = CX + 20, DW = 350;
const FX = DX + DW + 82, FW = 490;
const MIDX = (DX + DW + FX) / 2;

const swapIcon = (size, col) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4"/></svg>`;

export default {
  render(t, { beats }) {
    const d = beats.draw.t, sy = beats.sync.t;
    const nodesAt = d + 0.75;             // "…draws those files"
    const edgeAt = d + 1.6;               // edge lands on "…as a diagram"
    const vsAt = d + 3.0;                 // "…inside VS Code"
    const stripAt = sy + 0.0;             // "Edit either one"
    const typeAt = sy + 0.3;
    const L1 = '  - name: order_status', L2 = '    dataType: VARCHAR';
    const l1End = typeAt + L1.length / 30;
    const l2At = l1End + 0.05;
    const growAt = l2At + 0.05;           // "…and the other updates"
    const grow = easeOut(seg(t, growAt, growAt + 0.3));
    const hot = 1 - 0.6 * seg(t, growAt + 0.9, growAt + 1.6);

    let html = card({ x: CX, y: CY, w: CW, h: CH, tabs: [{ label: 'orders.json', on: true }], crumb: '.erd-studio › silver', bodyCls: 'grid-bg', style: appear(t, 0, { dy: 20 }) });
    html += toolbar({ x: TBX, y: TBY, domain: STORY.domain, layer: STORY.layer, stage: 'logical', style: appear(t, 0.25) });

    // Right of the toolbar (where physical.js puts its stage pill): "in VS Code", gone by the edit.
    if (t >= vsAt && t < stripAt + 0.3) {
      const op = Math.min(easeOut(seg(t, vsAt, vsAt + 0.35)), 1 - seg(t, stripAt - 0.1, stripAt + 0.2));
      html += `<span class="abs pill" style="right:${1080 - (CX + CW - 24)}px;top:${TBY + 12}px;font-size:24px;padding:6px 18px 6px 8px;background:#1b2a40;color:#cfe3ff;border:1px solid #2d4a70;opacity:${op.toFixed(3)};transform:translateY(${(8 * (1 - easeOut(seg(t, vsAt, vsAt + 0.35)))).toFixed(1)}px)">${appIcon(32, 'box-shadow:none')}in VS Code</span>`;
    }

    // File each node comes from, above it.
    const label = (name, x, at) => `<div class="abs mono" style="left:${x}px;top:${NY - 34}px;display:flex;align-items:center;gap:8px;font-size:24px;color:var(--text-3);white-space:nowrap;${appear(t, at, { dy: 6 })}"><span style="color:#d9b35a">${ICON.file({ size: 20 })}</span>${name}</div>`;
    html += label('dim_customer.yml', DX + 6, nodesAt);
    html += label('fct_order.yml', FX + 6, nodesAt + 0.25);

    // Edge + nodes (same geometry as physical.js).
    const esy = NY + rowY(0), ecy = NY + rowY(1);
    html += edge([[DX + DW, esy], [MIDX, esy], [MIDX, ecy], [FX, ecy]], {
      color: COLORS.logical, progress: easeOut(seg(t, edgeAt, edgeAt + 0.6)), one: [DX + DW + 8, esy - 10], many: [FX - 22, ecy - 8],
    });
    const dcm = STORY.dim_customer, fom = STORY.fct_order;
    html += node({ x: DX, y: NY, w: DW, name: dcm.name, layer: STORY.layer, grain: dcm.grain, cols: dcm.cols, style: appear(t, nodesAt, { dy: 18 }) });
    const cols = fom.cols.slice();
    if (grow > 0) {
      cols.push({ name: 'order_status', type: 'VARCHAR', row: 'green', rowStyle: `height:${(NODE.row * grow).toFixed(1)}px;overflow:hidden;opacity:${grow.toFixed(3)};background:rgba(19,48,31,${hot.toFixed(3)})` });
    }
    html += node({ x: FX, y: NY, w: FW, name: fom.name, layer: STORY.layer, grain: fom.grain, cols, style: appear(t, nodesAt + 0.25, { dy: 18 }) });

    // ---- sync: fct_order.yml panel under the canvas ----
    if (t >= stripAt) {
      const sx = CX, sY = CY + CH + 24, sw = CW, sh = 1086 - sY, P = 38, T0 = 12;
      let body = '';
      if (t >= typeAt) body += `<div class="abs" style="left:0;top:${T0 + P}px;width:${sw - 2}px;height:${2 * P}px;background:rgba(19,48,31,${hot.toFixed(3)});border-left:5px solid var(--green)"></div>`;
      let lines = `<div class="abs" style="left:26px;top:${T0}px;opacity:.55">${yamlLine('    dataType: DECIMAL(12,2)')}</div>`;
      if (t >= typeAt) {
        const tl = typed(L1, t, typeAt, 30);
        lines += `<div class="abs" style="left:26px;top:${T0 + P}px">${tl.length === L1.length ? yamlLine(L1) : `<span class="p">${tl}</span>`}${t < l2At ? caret(t, l1End, 'var(--green)') : ''}</div>`;
      }
      if (t >= l2At) lines += `<div class="abs" style="left:26px;top:${T0 + 2 * P}px;${appear(t, l2At, { dy: 0, dx: -6, dur: 0.15 })}">${yamlLine(L2)}</div>`;
      body += `<div class="abs mono" style="left:0;top:0;right:0;bottom:0;font-size:26px;line-height:${P}px;white-space:pre">${lines}</div>`;
      if (t >= growAt) {
        body += `<div class="abs" style="right:28px;top:${T0 + P + 9}px;height:58px;padding:0 26px;border-radius:999px;background:#13301f;border:2px solid var(--green);color:var(--green);display:flex;align-items:center;gap:14px;font-size:28px;font-weight:800;white-space:nowrap;${appear(t, growAt + 0.1, { dy: 0, dx: 12 })}">files${swapIcon(32, '#22c55e')}diagram</div>`;
      }
      html += card({
        x: sx, y: sY, w: sw, h: sh, tabs: [{ label: 'fct_order.yml', on: true, icon: `<span style="color:#d9b35a">${ICON.file({ size: 20 })}</span>` }],
        crumb: '.erd-studio › logical-models', headStyle: 'font-size:24px', body, style: appear(t, stripAt, { dy: 30, dur: 0.4 }),
      });
    }
    return html;
  },
};
