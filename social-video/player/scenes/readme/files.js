// readme · 4 · files — "One table, one file." Three real DBML files, in the layout ERD Studio
// writes. `table`: fct_order.dbml reveals line by line; COLUMNS, KEYS and GRAIN tag their lines
// on their words. `ref`: the table file folds to its tab strip and relationships/gold.dbml
// arrives, its Ref line lit ("one Ref line"); then, unnarrated (the tree scene already named the
// diagrams), diagrams/sales.dbml below it — the use lines are its tables, and the erd_layout
// block lights up as "positions".
import { appear, appearFade, card, easeInOut, easeOut, lerp, seg } from '../../lib.js';
import { DIAGRAM_DBML, dbmlLine, FCT_DBML, FILE_COL, RELS_DBML, wordAt } from './story.js';

const X = 64, W = 952;
const fileIcon = `<svg class="icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${FILE_COL.dbml}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/></svg>`;
const rgba = (rgb, a) => `rgba(${rgb},${a.toFixed(3)})`;
// The long header comment runs off the card: fade the right edge, as a wide editor would scroll.
const FADE_RIGHT = '<div class="abs" style="right:0;top:0;bottom:0;width:56px;background:linear-gradient(90deg,transparent,var(--card));z-index:1"></div>';
const C = { green: '34,197,94', purple: '196,144,232', amber: '244,180,44', blue: '96,165,250' };

function pillTag(label, rgb, x, y, t, at) {
  return `<div class="abs" style="left:${x}px;top:${y}px;${appear(t, at, { dy: 0, dx: 12, dur: 0.3 })}"><span class="pill" style="background:${rgba(rgb, 0.16)};border:2px solid ${rgba(rgb, 0.9)};color:rgb(${rgb});font-size:23px;font-weight:800;letter-spacing:.04em;padding:4px 15px">${label}</span></div>`;
}

/** Code body: line numbers + DBML, with per-line highlight { rgb, a } and per-line opacity. */
function code(lines, { font, pitch, top = 18, t, revealAt, per, hl = () => null, dim = 0 }) {
  let html = '';
  lines.forEach((ln, i) => {
    const at = revealAt + i * per;
    if (t < at) return;
    const h = hl(i);
    const a = h ? h.a : 0;
    if (a > 0) html += `<div class="abs" style="left:10px;top:${top + i * pitch}px;right:12px;height:${pitch}px;background:${rgba(h.rgb, 0.14 * a)};border-left:5px solid ${rgba(h.rgb, a)};border-radius:4px"></div>`;
    const op = lerp(1, 0.4, dim) + (1 - lerp(1, 0.4, dim)) * a;
    html += `<div class="abs mono" style="left:22px;top:${top + i * pitch}px;width:44px;text-align:right;font-size:${font}px;line-height:${pitch}px;color:var(--line-no);opacity:${op.toFixed(3)}">${i + 1}</div>`;
    html += `<div class="abs mono" style="left:${22 + 44 + 28}px;top:${top + i * pitch}px;font-size:${font}px;line-height:${pitch}px;white-space:pre;${appearFade(t, at, op, { dur: 0.16, dy: 0, dx: -8 })}">${dbmlLine(ln)}</div>`;
  });
  return html;
}

export default {
  render(t, { beats, scene }) {
    const Rf = beats.ref.t;
    const colsAt = wordAt(scene, 'table', 'columns');
    const keysAt = wordAt(scene, 'table', 'keys');
    const grainAt = wordAt(scene, 'table', 'grain');
    const refAt = wordAt(scene, 'ref', 'Ref');
    // The diagram file follows the Ref line by itself (no line of its own since the cut to ~2:50).
    const L = refAt + 0.7;
    const tablesAt = L + 0.5;
    const posAt = L + 1.1;
    const fold = easeInOut(seg(t, Rf - 0.2, Rf + 0.3));

    let html = '';
    // ================= fct_order.dbml =================
    const FONT = 25, PITCH = 46, TAG_X = 740 - X;
    const tH = lerp(64 + 18 * 2 + FCT_DBML.length * PITCH, 64, fold);
    let body = '';
    if (fold < 1) {
      const lit = (at) => easeOut(seg(t, at, at + 0.3));
      const hlAll = (i) => {
        if ((i === 5 || i === 6) && t >= keysAt) return { rgb: C.amber, a: lit(keysAt) };
        if (i === 3 && t >= grainAt) return { rgb: C.green, a: lit(grainAt) };
        if (i >= 5 && i <= 8 && t >= colsAt) return { rgb: C.purple, a: lit(colsAt) };
        return null;
      };
      const dimP = seg(t, colsAt - 0.1, colsAt + 0.2);
      body += code(FCT_DBML, { font: FONT, pitch: PITCH, t, revealAt: 0.05, per: 0.06, hl: hlAll, dim: dimP });
      const ly = (i) => 18 + i * PITCH + PITCH / 2 - 21;
      if (t >= colsAt) body += pillTag('COLUMNS', C.purple, TAG_X, ly(7.5), t, colsAt + 0.05);
      if (t >= keysAt) body += pillTag('KEYS', C.amber, TAG_X, ly(5.5), t, keysAt + 0.05);
      if (t >= grainAt) body += pillTag('GRAIN', C.green, TAG_X, ly(3), t, grainAt + 0.05);
    }
    html += card({
      x: X, y: 300, w: W, h: tH, tabs: [{ label: 'fct_order.dbml', on: true, icon: fileIcon }],
      crumb: '.erd-studio › gold › tables › gold', headStyle: 'font-size:23px', body,
      style: appearFade(t, 0, lerp(1, 0.75, fold), { dy: 20 }),
    });

    // ================= relationships/gold.dbml =================
    const RF = 18, RP = 31;   // 18 px: the longest use line (72 chars) fits the card
    const rY = 300 + 64 + 16, rH = 64 + 16 * 2 + RELS_DBML.length * RP;
    if (t >= Rf - 0.15) {
      const refLit = easeOut(seg(t, refAt, refAt + 0.3));
      let rb = code(RELS_DBML, { font: RF, pitch: RP, top: 16, t, revealAt: Rf, per: 0.05, hl: (i) => (i === 4 && t >= refAt ? { rgb: C.blue, a: refLit } : null), dim: seg(t, refAt - 0.1, refAt + 0.2) });
      rb += FADE_RIGHT;
      html += card({
        x: X, y: rY, w: W, h: rH, tabs: [{ label: 'gold.dbml', on: true, icon: fileIcon }],
        crumb: '.erd-studio › gold › relationships', headStyle: 'font-size:23px', body: rb,
        style: `z-index:2;${appear(t, Rf - 0.15, { dy: 30, dur: 0.4 })}`,
      });
      if (t >= refAt) html += `<div class="abs" style="z-index:3;right:${1080 - X - W + 20}px;top:${rY + 11}px;${appear(t, refAt + 0.05, { dy: 0, dx: 12 })}"><span class="pill" style="background:${rgba(C.blue, 0.16)};border:2px solid ${rgba(C.blue, 0.9)};color:rgb(${C.blue});font-size:23px;font-weight:800;letter-spacing:.04em;padding:4px 15px">ONE REF LINE</span></div>`;
    }

    // ================= diagrams/sales.dbml =================
    const DF = 18, DP = 30;
    const dY = rY + rH + 16, dH = 1086 - dY;
    if (t >= L - 0.2) {
      const tl = easeOut(seg(t, tablesAt, tablesAt + 0.3));
      const pl = easeOut(seg(t, posAt, posAt + 0.3));
      const hl = (i) => (i <= 1 && t >= tablesAt ? { rgb: C.blue, a: tl * (1 - 0.6 * pl) } : i >= 6 && i <= 9 && t >= posAt ? { rgb: C.green, a: pl } : null);
      let db = code(DIAGRAM_DBML, { font: DF, pitch: DP, top: 14, t, revealAt: L - 0.1, per: 0.04, hl, dim: seg(t, tablesAt - 0.1, tablesAt + 0.2) });
      db += FADE_RIGHT;
      if (t >= posAt) db += pillTag('POSITIONS', C.green, 560, 14 + 7.5 * DP - 21 + DP / 2, t, posAt + 0.05);
      html += card({
        x: X, y: dY, w: W, h: dH, tabs: [{ label: 'sales.dbml', on: true, icon: fileIcon }],
        crumb: '.erd-studio › gold › diagrams', headStyle: 'font-size:23px', body: db,
        style: `z-index:2;${appear(t, L - 0.2, { dy: 30, dur: 0.4 })}`,
      });
      if (t >= tablesAt) html += `<div class="abs" style="z-index:3;right:${1080 - X - W + 20}px;top:${dY + 11}px;${appear(t, tablesAt + 0.05, { dy: 0, dx: 12 })}"><span class="pill" style="background:${rgba(C.blue, 0.16)};border:2px solid ${rgba(C.blue, 0.9)};color:rgb(${C.blue});font-size:23px;font-weight:800;letter-spacing:.04em;padding:4px 15px">ITS TABLES</span></div>`;
    }
    return html;
  },
};
