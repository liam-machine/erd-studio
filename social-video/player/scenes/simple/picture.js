// simple/picture · "ERD Studio turns that file into a picture anyone can read. / Change the picture,
// the file changes. And the other way round." Opens on the plain-text orders.yml exactly where
// simple/flip left it; on "turns that file" it folds down into a strip under the real ERD Studio
// canvas (toolbar(), node() for customers + orders, edge()) whose edge lands on "picture", with a
// plain callout "the same map, as a picture". On `both`: a `status` row grows in the orders card
// (on "picture") and `- name: status` lands in the file (on "the file changes"), both green; on
// "the other way round" a two-way pill "picture ⇄ file".
import { COLORS, ICON, NODE, SIMPLE, appIcon, appear, card, caret, easeInOut, easeOut, edge, lerp, node, nodeHeight, rowY, seg, toolbar, typed, yamlLine } from '../../lib.js';

// canvas (same geometry as the pro canvas scene)
const CX = 64, CY = 300, CW = 952, CH = 550;
const TBX = CX + 24, TBY = CY + 64 + 16;
const NY = CY + 186;
const DX = CX + 20, DW = 350;
const FX = DX + DW + 82, FW = 490;
const MIDX = (DX + DW + FX) / 2;
// the file: starts where simple/flip's text card ended, folds into the strip under the canvas
const F0 = { x: 64, y: 716, w: 560, h: 374 };
const F1 = { x: 64, y: 874, w: 952, h: 212 };
const PITCH0 = 31, TOP0 = 16;
const P1 = 38, T1 = 12;

const swapIcon = (size, col) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4"/></svg>`;

export default {
  render(t, { beats }) {
    const d = beats.draw.t, b = beats.both.t;
    // x_draw: "ERD Studio(+0.0..0.8) turns that file(+0.82..1.5) into a picture(+2.16), anyone can read(+2.9..3.7)."
    const canvasAt = d + 0.45;
    const foldAt = d + 0.85, foldEnd = foldAt + 0.6;
    const nodesAt = d + 1.35;
    const edgeAt = d + 1.8, edgeEnd = d + 2.25;          // lands on "picture"
    const calloutAt = d + 2.35;
    // x_both: "Change the picture(+0.42), the file changes(+1.1..1.9). And the other way round(+2.2..3.2)."
    const growAt = b + 0.45;                             // the picture changes…
    const L1 = '  - name: status', L2 = '    dataType: VARCHAR';
    const typeAt = b + 1.0, l1End = typeAt + L1.length / 34, l2At = l1End + 0.05; // …the file changes
    const swapAt = b + 2.3;                              // "…the other way round"
    const grow = easeOut(seg(t, growAt, growAt + 0.35));
    const hotNode = 1 - 0.55 * seg(t, b + 2.6, b + 3.3);
    const hotFile = t >= typeAt ? 1 - 0.55 * seg(t, b + 2.6, b + 3.3) : 0;

    let html = '';

    // ---------------- canvas ----------------
    if (t >= canvasAt) {
      html += card({
        x: CX, y: CY, w: CW, h: CH,
        tabs: [{ label: 'ERD Studio', on: true, icon: appIcon(30, 'box-shadow:none;border-radius:7px') }],
        headStyle: 'font-size:24px', bodyCls: 'grid-bg', style: appear(t, canvasAt, { dy: 20 }),
      });
      html += toolbar({ x: TBX, y: TBY, domain: 'orders', layer: 'SLV', stage: 'logical', style: appear(t, canvasAt + 0.2) });

      const esy = NY + rowY(0), ecy = NY + rowY(1);
      html += edge([[DX + DW, esy], [MIDX, esy], [MIDX, ecy], [FX, ecy]], {
        color: COLORS.logical, progress: easeOut(seg(t, edgeAt, edgeEnd)), one: [DX + DW + 8, esy - 10], many: [FX - 22, ecy - 8],
      });
      const cu = SIMPLE.customers, or = SIMPLE.orders;
      html += node({ x: DX, y: NY, w: DW, name: cu.name, layer: 'SLV', grain: cu.grain, cols: cu.cols, style: appear(t, nodesAt, { dy: 18 }) });
      const cols = or.cols.slice();
      if (grow > 0) {
        cols.push({ name: 'status', type: 'VARCHAR', row: 'green', rowStyle: `height:${(NODE.row * grow).toFixed(1)}px;overflow:hidden;opacity:${grow.toFixed(3)};background:rgba(19,48,31,${hotNode.toFixed(3)})` });
      }
      html += node({ x: FX, y: NY, w: FW, name: or.name, layer: 'SLV', grain: or.grain, cols, style: appear(t, nodesAt + 0.2, { dy: 18 }) });

      // Plain reading of the join line's "1" and "*": under the customers card, on "anyone can read".
      const joinAt = d + 2.95;
      if (t >= joinAt) {
        const jx = DX + 18, jy = NY + nodeHeight(cu.cols.length) + 22;
        html += `<div class="abs" style="left:${jx}px;top:${jy}px;display:flex;align-items:center;gap:14px;white-space:nowrap;${appear(t, joinAt, { dy: 8 })}">
          <span class="mono" style="display:inline-flex;align-items:center;gap:6px;font-size:28px;font-weight:800;color:${COLORS.logical}">1${ICON.arrow({ size: 24 })}*</span>
          <span style="font-size:27px;font-weight:700;line-height:1.1">one customer,<br><span style="color:var(--text-2)">many orders</span></span></div>`;
      }

      // Plain callout, top-right of the canvas: what this is.
      if (t >= calloutAt) {
        html += `<div class="abs" style="right:${1080 - (CX + CW - 26)}px;top:${TBY - 4}px;text-align:right;white-space:nowrap;line-height:1.12;${appear(t, calloutAt, { dy: 0, dx: 12 })}">
          <div style="font-size:32px;font-weight:800;color:var(--blue)">the same map,</div>
          <div style="font-size:32px;font-weight:800;color:var(--blue)">as a picture</div></div>`;
      }
    }

    // ---------------- the file ----------------
    const fp = easeInOut(seg(t, foldAt, foldEnd));
    const fx = lerp(F0.x, F1.x, fp), fy = lerp(F0.y, F1.y, fp), fw = lerp(F0.w, F1.w, fp), fh = lerp(F0.h, F1.h, fp);
    let body = '';
    // the whole file (as in simple/flip) fades out as it folds…
    if (fp < 1) {
      const op = 1 - seg(fp, 0, 0.6);
      body += `<div class="abs mono" style="left:0;top:0;right:0;bottom:0;font-size:26px;line-height:${PITCH0}px;white-space:pre;opacity:${op.toFixed(3)}">${SIMPLE.ordersYml.map((ln, i) => `<div class="abs" style="left:28px;top:${TOP0 + i * PITCH0}px">${yamlLine(ln)}</div>`).join('')}</div>`;
    }
    // …and its tail fades in: the part the next edit lands after.
    if (fp > 0) {
      const op = seg(fp, 0.5, 1);
      let lines = `<div class="abs" style="left:26px;top:${T1}px;opacity:.55">${yamlLine('    dataType: DECIMAL(12,2)')}</div>`;
      let hl = '';
      if (t >= typeAt) {
        hl = `<div class="abs" style="left:0;top:${T1 + P1}px;width:${F1.w - 2}px;height:${2 * P1}px;background:rgba(19,48,31,${hotFile.toFixed(3)});border-left:5px solid var(--green)"></div>`;
        const tl = typed(L1, t, typeAt, 34);
        lines += `<div class="abs" style="left:26px;top:${T1 + P1}px">${tl.length === L1.length ? yamlLine(L1) : `<span class="p">${tl}</span>`}${t < l2At ? caret(t, l1End, 'var(--green)') : ''}</div>`;
      }
      if (t >= l2At) lines += `<div class="abs" style="left:26px;top:${T1 + 2 * P1}px;${appear(t, l2At, { dy: 0, dx: -6, dur: 0.15 })}">${yamlLine(L2)}</div>`;
      body += `${hl}<div class="abs mono" style="left:0;top:0;right:0;bottom:0;font-size:26px;line-height:${P1}px;white-space:pre;opacity:${op.toFixed(3)}">${lines}</div>`;
    }
    if (t >= swapAt) {
      body += `<div class="abs" style="right:28px;top:${T1 + P1 + 8}px;height:60px;padding:0 26px;border-radius:999px;background:#13301f;border:2px solid var(--green);color:var(--green);display:flex;align-items:center;gap:14px;font-size:30px;font-weight:800;white-space:nowrap;${appear(t, swapAt, { dy: 0, dx: 12 })}">picture${swapIcon(34, '#22c55e')}file</div>`;
    }
    html += card({
      x: fx, y: fy, w: fw, h: fh,
      tabs: [{ label: 'orders.yml', on: true, icon: `<span style="color:#22c55e">${ICON.file({ size: 22 })}</span>` }],
      headStyle: 'font-size:24px', body,
    });
    // "plain text" tag rides the file's head, as in simple/flip
    html += `<span class="abs pill" style="left:${(fx + fw - 18).toFixed(1)}px;top:${(fy + 13).toFixed(1)}px;transform:translateX(-100%);font-size:24px;padding:4px 16px;background:#13301f;color:var(--green);border:1px solid #22c55e88">plain text</span>`;
    return html;
  },
};
