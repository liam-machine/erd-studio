// simple/flip · "So I moved the map right next to the code, as a simple text file. / Now the AI
// reads it too." A big folder window "your project": three code files, then the map file
// orders.yml slides in beside them on "moved the map" (green, "the map"), a bracket "same place"
// on "next to the code", and on "simple text file" the file pops open as plain text
// (SIMPLE.ordersYml, the real format). On `reads` the AI assistant chip scans it: green tick on
// "reads".
import { ICON, SIMPLE, appear, card, easeOut, lerp, seg, yamlLine } from '../../lib.js';

const L = 64, R = 1016, W = R - L;
// folder window
const FY = 300, FH = 392;
const LABEL_Y = FY + 64 + 22;        // "the code" / "the map" group labels
const TILE_Y = LABEL_Y + 52;         // icon tops
const TILE_W = 180, ICON_H = 118;
const CODE_CX = [196, 386, 576];     // tile centres (frame x)
const MAP_CX = 852;
const BR_Y = TILE_Y + ICON_H + 80;   // bracket line
// text card (pops open from the map tile)
const TX = 64, TY = 716, TW = 560, TH = 374;
const PITCH = 31;
// AI chip
const AX = 656, AY = 772, AW = R - AX, AH = 262;

// ---- local icons ----
function docShape(w, h, stroke, fill, inner) {
  return `<svg class="icon" width="${w}" height="${h}" viewBox="0 0 80 100" fill="none"><path d="M8 4h44l20 20v70a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="${fill}" stroke="${stroke}" stroke-width="3.5" stroke-linejoin="round"/><path d="M52 4v20h20" stroke="${stroke}" stroke-width="3.5" stroke-linejoin="round"/>${inner}</svg>`;
}
const codeGlyph = (c) => `<path d="M30 50l-10 10 10 10M50 50l10 10-10 10M44 44l-8 32" stroke="${c}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`;
const mapGlyph = (c) => `<rect x="17" y="42" width="18" height="14" rx="3" stroke="${c}" stroke-width="3.5"/><rect x="45" y="42" width="18" height="14" rx="3" stroke="${c}" stroke-width="3.5"/><rect x="31" y="70" width="18" height="14" rx="3" stroke="${c}" stroke-width="3.5"/><path d="M35 49h10M40 56v14" stroke="${c}" stroke-width="3.5"/>`;

function tile(cx, name, icon, { mono = false, col = 'var(--text)', style = '' } = {}) {
  return `<div class="abs" style="left:${cx - TILE_W / 2}px;top:${TILE_Y}px;width:${TILE_W}px;display:flex;flex-direction:column;align-items:center;gap:12px;${style}">
    ${icon}<div class="${mono ? 'mono' : ''}" style="font-size:${mono ? 27 : 29}px;font-weight:${mono ? 500 : 600};color:${col};white-space:nowrap">${name}</div></div>`;
}

export default {
  render(t, { beats }) {
    const m = beats.moved.t, r = beats.reads.t;
    // x_moved: "So I moved the map(+0.35..+0.9) right next to the code(+1.3..+2.0), as a simple(+2.6) text file(+3.2)."
    const slideAt = m + 0.3, slideEnd = slideAt + 0.6;
    const mapTagAt = slideEnd - 0.05;
    const bracketAt = m + 1.3, sameAt = bracketAt + 0.25;
    const popAt = m + 2.6, plainAt = popAt + 0.35;
    // x_reads: "Now the AI(+0.48) reads(+0.76) it too."
    const aiAt = r + 0.05, scanAt = r + 0.3, scanEnd = r + 0.8, readAt = r + 0.8;

    let html = '';

    // ---------------- folder window ----------------
    html += card({
      x: L, y: FY, w: W, h: FH,
      tabs: [{ label: 'your project', on: true, icon: `<span style="color:#7f8792">${ICON.folder({ size: 26 })}</span>` }],
      headStyle: 'font-size:26px', style: appear(t, 0, { dy: 18 }),
    });
    // "the code" group label
    html += `<div class="abs" style="left:${CODE_CX[0] - TILE_W / 2}px;top:${LABEL_Y}px;width:${CODE_CX[2] - CODE_CX[0] + TILE_W}px;text-align:center;font-size:26px;font-weight:800;letter-spacing:.14em;color:var(--text-2);${appear(t, 0.1)}">THE CODE</div>`;
    const codeDoc = docShape(94, ICON_H, '#5a6a80', '#1e2633', codeGlyph('#78c0f4'));
    ['customers', 'orders', 'payments'].forEach((n, i) => { html += tile(CODE_CX[i], n, codeDoc, { style: appear(t, 0.1 + i * 0.06) }); });

    // the map file slides in from the right, clipped by the window
    if (t >= slideAt) {
      const p = easeOut(seg(t, slideAt, slideEnd));
      const dx = lerp(260, 0, p);
      const glow = seg(t, slideEnd - 0.1, slideEnd + 0.2);
      const mapDoc = docShape(94, ICON_H, '#22c55e', '#13301f', mapGlyph('#22c55e'));
      html += `<div class="abs" style="left:${L}px;top:${FY + 65}px;width:${W}px;height:${FH - 66}px;overflow:hidden">
        <div class="abs" style="left:${-L}px;top:${-(FY + 65)}px;width:1080px;height:1350px">
          <div class="abs" style="left:${MAP_CX - TILE_W / 2 - 14}px;top:${TILE_Y - 14}px;width:${TILE_W + 28}px;height:${ICON_H + 66}px;border-radius:18px;background:rgba(34,197,94,${(0.1 * glow).toFixed(3)});border:2px solid rgba(34,197,94,${(0.8 * glow).toFixed(3)});transform:translateX(${dx.toFixed(1)}px)"></div>
          ${tile(MAP_CX, 'orders.yml', mapDoc, { mono: true, col: '#d9fbe5', style: `opacity:${p.toFixed(3)};transform:translateX(${dx.toFixed(1)}px)` })}
        </div></div>`;
      if (t >= mapTagAt) {
        html += `<div class="abs" style="left:${MAP_CX - 110}px;top:${LABEL_Y - 6}px;width:220px;display:flex;justify-content:center;${appear(t, mapTagAt, { dy: 8 })}">
          <span class="pill" style="font-size:26px;padding:5px 20px;background:#13301f;color:var(--green);border:2px solid var(--green)">the map</span></div>`;
      }
    }

    // bracket under everything: "same place"
    if (t >= bracketAt) {
      const bp = easeOut(seg(t, bracketAt, bracketAt + 0.45));
      const x0 = CODE_CX[0] - 70, x1 = MAP_CX + 70, mid = (x0 + x1) / 2;
      const a = lerp(mid, x0, bp), b = lerp(mid, x1, bp);
      html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><path d="M${a} ${BR_Y - 16} V${BR_Y} H${b} V${BR_Y - 16} M${mid} ${BR_Y} V${BR_Y + 12}" fill="none" stroke="#22c55e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      html += `<div class="abs" style="left:${mid - 200}px;top:${BR_Y + 8}px;width:400px;text-align:center;font-size:32px;font-weight:800;color:var(--green);white-space:nowrap;${appear(t, sameAt, { dy: 6 })}">same place</div>`;
    }

    // ---------------- the file, opened: plain text ----------------
    if (t >= popAt) {
      const p = easeOut(seg(t, popAt, popAt + 0.4));
      const s = lerp(0.25, 1, p);
      // grows out of the map tile
      const ox = MAP_CX - TX, oy = TILE_Y + ICON_H / 2 - TY;
      let lines = '';
      SIMPLE.ordersYml.forEach((ln, i) => {
        lines += `<div class="abs" style="left:28px;top:${16 + i * PITCH}px;${appear(t, popAt + 0.15 + i * 0.04, { dy: 0, dx: -6, dur: 0.2 })}">${yamlLine(ln)}</div>`;
      });
      // AI read-through: a highlight bar sweeping down the lines
      if (t >= scanAt && t < scanEnd + 0.35) {
        const sp = seg(t, scanAt, scanEnd);
        const op = 1 - seg(t, scanEnd, scanEnd + 0.35);
        const y = 16 + sp * (SIMPLE.ordersYml.length - 1) * PITCH;
        lines = `<div class="abs" style="left:0;right:0;top:${(y - 2).toFixed(1)}px;height:${PITCH + 4}px;background:rgba(92,162,248,${(0.22 * op).toFixed(3)});border-left:5px solid rgba(92,162,248,${op.toFixed(3)})"></div>` + lines;
      }
      const body = `<div class="abs mono" style="left:0;top:0;right:0;bottom:0;font-size:26px;line-height:${PITCH}px;white-space:pre">${lines}</div>`;
      const pill = t >= plainAt
        ? `<span class="abs pill" style="right:18px;top:13px;font-size:24px;padding:4px 16px;background:#13301f;color:var(--green);border:1px solid #22c55e88;${appear(t, plainAt, { dy: 0, dx: 8 })}">plain text</span>`
        : '';
      html += `<div class="abs" style="left:${TX}px;top:${TY}px;width:${TW}px;height:${TH}px;transform-origin:${ox}px ${oy}px;transform:scale(${s.toFixed(4)});opacity:${p.toFixed(3)}">
        ${card({ x: 0, y: 0, w: TW, h: TH, tabs: [{ label: 'orders.yml', on: true, icon: `<span style="color:#22c55e">${ICON.file({ size: 22 })}</span>` }], headStyle: 'font-size:24px', body })}${pill}</div>`;
    }

    // ---------------- the AI reads it ----------------
    if (t >= aiAt) {
      const done = t >= readAt;
      const border = done ? 'var(--green)' : '#2d4a70';
      html += `<div class="abs" style="left:${AX}px;top:${AY}px;width:${AW}px;height:${AH}px;border-radius:22px;background:#171b24;border:3px solid ${border};box-shadow:0 24px 60px #000a;${appear(t, aiAt, { dy: 0, dx: 16 })}">
        <div class="abs" style="left:28px;top:30px;display:flex;align-items:center;gap:18px;white-space:nowrap">
          <span style="width:72px;height:72px;border-radius:50%;background:#1b2a40;border:2px solid #2d4a70;color:var(--blue);display:flex;align-items:center;justify-content:center">${ICON.sparkle({ size: 40 })}</span>
          <span style="font-size:32px;font-weight:800">AI assistant</span></div>
        <div class="abs" style="left:28px;top:140px;right:20px;height:90px;border-radius:16px;background:${done ? '#13301f' : '#1f222a'};display:flex;align-items:center;gap:16px;padding:0 20px;white-space:nowrap">
          ${done ? `<span class="tick tick--ok" style="width:48px;height:48px;background:#1d4a2c">${ICON.check({ size: 30 })}</span>` : `<span style="color:var(--blue)">${ICON.file({ size: 34 })}</span>`}
          <span style="font-size:30px;font-weight:700;color:${done ? 'var(--green)' : 'var(--text-2)'}">${done ? 'reads the map' : 'reading…'}</span></div>
      </div>`;
      // pointer from the chip to the file it is reading
      html += `<div class="abs" style="left:${TX + TW + 2}px;top:${AY + 166}px;width:${AX - TX - TW - 4}px;display:flex;justify-content:center;color:${done ? 'var(--green)' : 'var(--blue)'};${appear(t, aiAt + 0.1, { dy: 0 })}">${ICON.arrow({ size: 30, style: 'transform:scaleX(-1)' })}</div>`;
    }
    return html;
  },
};
