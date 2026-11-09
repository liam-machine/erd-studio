// launch · 8 · pr — "One pull request, design + code." The README cut's pull request (readme/pr.js,
// the same example: fct_order.dbml gains `status VARCHAR`, aligned, nothing else moves) keyed to
// the launch lines:
//   same    the design line is there from the start; "the SQL" brings sql/orders.sql into the PR
//           (Files changed 2); "same pull request" wraps both in one green outline.
//   review  "Reviewed together" → Approved; "Shipped together" → Merged.
//   why     "decades" → "1 PR · design + code".
import { appear, card, easeOut, esc, ICON, lerp, seg } from '../../lib.js';
import { dbmlLine, FCT_DBML, FCT_STATUS_LINE, PATH, R, wordAt } from '../readme/story.js';

const CX = 64, CW = 952, CY = 300, CH = 1088 - CY;
const BX = CX + 24, BW = CW - 48;
const HEAD = 50, LINE = 40;
const hump = (t, a, up, down) => (t < a ? 0 : t < a + up ? seg(t, a, a + up) : 1 - seg(t, a + up, a + up + down));

const DBML = [
  { ctx: true, s: FCT_DBML[7] },
  { ctx: true, s: FCT_DBML[8] },
  { s: FCT_STATUS_LINE },
  { ctx: true, s: '}' },
];
const SQL = [
  { ctx: true, s: '    order_total,' },
  { s: `    ${R.newCol.name},` },
];

function fileBlock({ x, y, w, path, tag, lines, fmt, t, at, addAt, glow = 0 }) {
  const h = HEAD + lines.length * LINE + 8;
  const rows = lines.map((l, i) => {
    const a = l.ctx ? 0 : easeOut(seg(t, addAt, addAt + 0.3));
    const g = l.ctx ? 0 : glow;
    const bg = l.ctx ? 'transparent' : `rgba(19,48,31,${Math.min(1, a + 0.4 * g).toFixed(3)})`;
    return `<div style="position:absolute;left:0;right:0;top:${HEAD + 4 + i * LINE}px;height:${LINE}px;line-height:${LINE}px;background:${bg};box-shadow:${g > 0 ? `inset 5px 0 0 rgba(34,197,94,${g.toFixed(3)})` : 'none'};white-space:pre;font-family:var(--mono);font-size:24px;${l.ctx ? 'opacity:.55' : `opacity:${lerp(0.25, 1, a).toFixed(3)}`}"><span style="display:inline-block;width:44px;text-align:center;color:var(--green);font-weight:700">${l.ctx ? ' ' : '+'}</span>${fmt(l.s)}</div>`;
  }).join('');
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:12px;border:2px solid var(--card-border);background:#15161a;overflow:hidden;${appear(t, at)}">
    <div style="height:${HEAD}px;display:flex;align-items:center;gap:12px;padding:0 18px;background:var(--card-head);border-bottom:1px solid var(--card-border);white-space:nowrap">
      <span style="color:var(--text-2)">${ICON.file({ size: 22 })}</span><span class="mono" style="font-size:21px;color:var(--text)">${path}</span>
      <span style="flex:1"></span>${tag}</div>${rows}</div>`;
}
const sqlFmt = (s) => `<span style="color:var(--text)">${esc(s)}</span>`;

export default {
  render(t, { beats, scene }) {
    const S = beats.same.t;
    const addAt = S + 0.4;
    const sqlAt = wordAt(scene, 'same', 'the SQL') - 0.1;
    const oneAt = wordAt(scene, 'same', 'same pull');
    const okAt = wordAt(scene, 'review', 'Reviewed');
    const shipAt = wordAt(scene, 'review', 'Shipped');
    const whyAt = wordAt(scene, 'why', 'decades') - 0.3;
    const glow = hump(t, addAt, 0.25, 0.9);

    let html = card({ x: CX, y: CY, w: CW, h: CH, tabs: [{ label: 'Pull request', on: true }], crumb: R.repo, style: appear(t, 0, { dy: 20 }) });
    const by = CY + 64;
    html += `<div class="abs" style="left:${CX + 28}px;top:${by + 18}px;font-size:34px;font-weight:700;letter-spacing:-.01em;white-space:nowrap"><span style="color:var(--text-3)">#${R.pr.number}</span> ${R.pr.title}</div>`;
    const merged = t >= shipAt;
    const state = merged
      ? `<span class="pill" style="font-size:24px;padding:6px 18px;background:#6e40c9;color:#fff;border:2px solid #8957e5;${appear(t, shipAt, { dy: 0 })}">Merged</span>`
      : '<span class="pill" style="font-size:24px;padding:6px 18px;border:2px solid var(--green);color:var(--green)">Open</span>';
    const nFiles = t >= sqlAt ? 2 : 1;
    html += `<div class="abs" style="left:${CX + 28}px;right:${1080 - CX - CW + 28}px;top:${by + 74}px;display:flex;align-items:center;gap:18px;white-space:nowrap">
      ${state}<span class="mono" style="font-size:23px;color:var(--text-2)">${R.pr.branch}</span><span style="color:var(--text-3)">${ICON.arrow({ size: 22 })}</span><span class="mono" style="font-size:23px;color:var(--text-2)">main</span>
      <span style="flex:1"></span><span style="font-size:24px;color:var(--text-2)">Files changed</span>
      <span style="min-width:40px;height:36px;border-radius:18px;background:#2a2c33;display:inline-flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;transform:scale(${(1 + 0.2 * hump(t, sqlAt, 0.12, 0.3)).toFixed(3)})">${nFiles}</span></div>`;

    const y1 = by + 140, h1 = HEAD + DBML.length * LINE + 8;
    const y2 = y1 + h1 + 16, h2 = HEAD + SQL.length * LINE + 8;
    const og = easeOut(seg(t, oneAt, oneAt + 0.4));
    if (og > 0) {
      html += `<div class="abs" style="left:${BX - 10}px;top:${y1 - 10}px;width:${BW + 20}px;height:${y2 + h2 - y1 + 20}px;border-radius:18px;border:2px solid rgba(34,197,94,${(0.9 * og).toFixed(2)});box-shadow:0 0 ${(30 * hump(t, oneAt, 0.2, 0.8)).toFixed(1)}px rgba(34,197,94,.45)"></div>`;
    }
    html += fileBlock({ x: BX, y: y1, w: BW, path: PATH.fct, lines: DBML, fmt: dbmlLine, t, at: 0.15, addAt, glow,
      tag: `<span class="pill" style="font-size:22px;padding:4px 14px;background:#1b2a40;color:var(--logical)">design</span>` });
    if (t >= sqlAt) {
      html += fileBlock({ x: BX, y: y2, w: BW, path: R.pr.sql, lines: SQL, fmt: sqlFmt, t, at: sqlAt, addAt: sqlAt + 0.3,
        tag: `<span class="pill" style="font-size:22px;padding:4px 14px;background:#2a2c33;color:var(--text)">code</span>` });
    }
    // Review and ship, under the files.
    const ry = y2 + h2 + 18;
    const row = (at, icon, label, colour, bg) => (t >= at
      ? `<div style="display:flex;align-items:center;gap:14px;height:52px;font-size:27px;font-weight:600;white-space:nowrap;${appear(t, at, { dy: 8 })}"><span style="width:40px;height:40px;border-radius:50%;background:${bg};color:${colour};display:inline-flex;align-items:center;justify-content:center">${icon}</span>${label}</div>` : '');
    html += `<div class="abs" style="left:${BX + 8}px;top:${ry}px;display:flex;flex-direction:column;gap:8px">
      ${row(okAt, ICON.check({ size: 22 }), 'Approved: design and code reviewed together', 'var(--green)', '#13301f')}
      ${row(shipAt, ICON.arrow({ size: 22 }), 'Merged: shipped together', '#c9b2ff', '#2c1f4d')}</div>`;
    if (t >= whyAt) {
      html += `<div class="abs" style="left:${CX}px;width:${CW}px;top:${CY + CH - 64}px;display:flex;justify-content:center;${appear(t, whyAt, { dy: 10 })}">
        <span class="pill" style="font-size:27px;padding:9px 26px;background:#13301f;color:var(--green);border:1px solid #1f5a35">${ICON.check({ size: 22 })}1 PR <span style="color:var(--text-3)">·</span> design + code</span></div>`;
    }
    return html;
  },
};
