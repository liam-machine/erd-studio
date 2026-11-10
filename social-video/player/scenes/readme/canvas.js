// readme · 5 · canvas — "The files become a diagram." The diagram file opens on the canvas (the
// tab is sales.dbml; a folder without dbt, so no Logical/Physical tabs): toolbar, then the two
// tables land, each labelled with its .dbml file, and the relationship draws in on "diagram".
// `sync`: fct_order.dbml opens under the canvas; `status VARCHAR` is typed into the file and the
// fct_order node grows the row on "follows", and "file ⇄ diagram" holds to the end of the scene
// (the README poster frame).
import { appear, appearFade, appIcon, card, caret, COLORS, easeOut, edge, ICON, node, NODE, rowY, seg, typed } from '../../lib.js';
import { dbmlLine, FCT_DBML, FCT_STATUS_LINE, FILE_COL, R, toolbar2, viewFileBtn, wordAt } from './story.js';

export const GEO = { CX: 64, CY: 300, CW: 952, CH: 560 };
const { CX, CY, CW, CH } = GEO;
const TBX = CX + 24, TBY = CY + 64 + 16;
const NY = CY + 186;
const DX = CX + 20, DW = 350;
const FX = DX + DW + 82, FW = 490;
const MIDX = (DX + DW + FX) / 2;
const dbmlIcon = (size = 20) => `<span style="color:${FILE_COL.dbml}">${ICON.file({ size })}</span>`;
const swapIcon = (size, col) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4"/></svg>`;

export default {
  render(t, { beats, scene }) {
    const d = beats.draw.t, sy = beats.sync.t;
    const nodesAt = d + 0.6;
    const edgeAt = wordAt(scene, 'draw', 'diagram') - 0.1;
    const vsAt = wordAt(scene, 'draw', 'VS Code');
    const panelAt = sy - 0.15;
    const typeAt = sy + 0.25;
    const typedEnd = typeAt + FCT_STATUS_LINE.length / 24;
    // The canvas follows the file on save (the watcher reads it from disk): the tab's dirty dot
    // clears and a "saved" tick shows just before the node grows.
    const saveAt = typedEnd + 0.2;
    const growAt = Math.max(saveAt + 0.15, wordAt(scene, 'sync', 'follows') - 0.1);
    const grow = easeOut(seg(t, growAt, growAt + 0.3));
    const hot = 1 - 0.6 * seg(t, growAt + 0.9, growAt + 1.6);

    let html = card({
      x: CX, y: CY, w: CW, h: CH, tabs: [{ label: 'sales.dbml', on: true, icon: dbmlIcon(20) }],
      crumb: '.erd-studio › gold › diagrams', bodyCls: 'grid-bg', style: appear(t, 0, { dy: 20 }),
    });
    html += toolbar2({ x: TBX, y: TBY, style: appear(t, 0.2) });
    html += viewFileBtn(CX + CW - 24 - 196, TBY + 4, appear(t, 0.3));

    // File each node comes from, above it.
    const label = (name, x, at) => `<div class="abs mono" style="left:${x}px;top:${NY - 34}px;display:flex;align-items:center;gap:8px;font-size:22px;color:var(--text-3);white-space:nowrap;${appear(t, at, { dy: 6 })}">${dbmlIcon(20)}${name}</div>`;
    html += label('dim_customer.dbml', DX + 6, nodesAt);
    html += label('fct_order.dbml', FX + 6, nodesAt + 0.2);

    const esy = NY + rowY(0), ecy = NY + rowY(1);
    html += edge([[DX + DW, esy], [MIDX, esy], [MIDX, ecy], [FX, ecy]], {
      color: COLORS.logical, progress: easeOut(seg(t, edgeAt, edgeAt + 0.6)), one: [DX + DW + 8, esy - 10], many: [FX - 22, ecy - 8],
    });
    html += node({ x: DX, y: NY, w: DW, name: R.dim_customer.name, layer: R.badge, grain: R.dim_customer.grain, cols: R.dim_customer.cols, style: appear(t, nodesAt, { dy: 18 }) });
    const cols = R.fct_order.cols.slice();
    if (grow > 0) cols.push({ name: R.newCol.name, type: R.newCol.type, row: 'green', rowStyle: `height:${(NODE.row * grow).toFixed(1)}px;overflow:hidden;opacity:${grow.toFixed(3)};background:rgba(19,48,31,${hot.toFixed(3)})` });
    html += node({ x: FX, y: NY, w: FW, name: R.fct_order.name, layer: R.badge, grain: R.fct_order.grain, cols, style: appear(t, nodesAt + 0.2, { dy: 18 }) });

    // "in VS Code", bottom left of the canvas, until the file opens.
    if (t >= vsAt && t < panelAt + 0.3) {
      const op = Math.min(easeOut(seg(t, vsAt, vsAt + 0.35)), 1 - seg(t, panelAt - 0.1, panelAt + 0.2));
      html += `<span class="abs pill" style="left:${DX}px;top:${NY + 290}px;font-size:24px;padding:6px 18px 6px 8px;background:#1b2a40;color:#cfe3ff;border:1px solid #2d4a70;opacity:${op.toFixed(3)}">${appIcon(32, 'box-shadow:none')}in VS Code</span>`;
    }

    // ---- the table file, under the canvas ----
    if (t >= panelAt) {
      const sY = CY + CH + 18, sh = 1088 - sY, P = 34, T0 = 10;
      // Lines shown: 1 (the comment), 8, 9 and the new 10.
      const shown = [
        { n: 1, s: FCT_DBML[0] },
        { n: 8, s: FCT_DBML[7] },
        { n: 9, s: FCT_DBML[8] },
        { n: 10, s: FCT_STATUS_LINE, isNew: true },
      ];
      let body = '';
      let row = 0;
      shown.forEach((ln) => {
        if (ln.isNew && t < typeAt) return;
        const y = T0 + row * P;
        row += 1;
        if (ln.isNew) body += `<div class="abs" style="left:0;top:${y}px;width:${CW - 2}px;height:${P}px;background:rgba(19,48,31,${hot.toFixed(3)});border-left:5px solid var(--green)"></div>`;
        const text = ln.isNew
          ? (t < typedEnd ? `<span style="color:var(--text)">${typed(ln.s, t, typeAt, 24)}</span>${caret(t, typedEnd, 'var(--green)')}` : dbmlLine(ln.s))
          : dbmlLine(ln.s);
        body += `<div class="abs mono" style="left:18px;top:${y}px;width:40px;text-align:right;font-size:22px;line-height:${P}px;color:var(--line-no)">${ln.n}</div>`;
        body += `<div class="abs mono" style="left:84px;top:${y}px;font-size:22px;line-height:${P}px;white-space:pre">${text}</div>`;
      });
      // "file ⇄ diagram" once the node has grown.
      if (t >= growAt) {
        body += `<div class="abs" style="right:24px;top:${T0 + 2 * P - 12}px;height:52px;padding:0 22px;border-radius:999px;background:#13301f;border:2px solid var(--green);color:var(--green);display:flex;align-items:center;gap:12px;font-size:25px;font-weight:800;white-space:nowrap;${appear(t, growAt + 0.1, { dy: 0, dx: 12 })}">file${swapIcon(28, '#22c55e')}diagram</div>`;
      }
      const dirty = t >= typeAt && t < saveAt;
      const dot = dirty ? '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--text);margin-left:12px"></span>' : '';
      if (t >= saveAt && t < growAt + 1.2) {
        html += `<div class="abs" style="z-index:3;right:${1080 - CX - CW + 20}px;top:${sY + 12}px;${appearFade(t, saveAt, 1 - seg(t, growAt + 0.8, growAt + 1.2), { dy: 0, dx: 10, dur: 0.2 })}"><span class="pill" style="font-size:21px;padding:4px 14px;background:#1c1e23;border:1px solid #34363d;color:var(--text-2)">${ICON.check({ size: 18 })}saved</span></div>`;
      }
      html += card({
        x: CX, y: sY, w: CW, h: sh, tabs: [{ label: `fct_order.dbml${dot}`, on: true, icon: dbmlIcon(20) }],
        crumb: '.erd-studio › gold › tables › gold', headStyle: 'font-size:22px', body, style: appear(t, panelAt, { dy: 30, dur: 0.4 }),
      });
    }
    return html;
  },
};
