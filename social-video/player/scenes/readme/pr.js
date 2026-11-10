// readme · 6 · pr — "A design change, a readable diff." The pull request for the column the
// canvas scene just added: fct_order.dbml gains one line (`status VARCHAR`, aligned with its
// neighbours, nothing else moves), lit on "readable diff". On "same pull request" the SQL that
// builds it joins the PR and one green outline wraps both: design + code, one PR.
import { appear, card, easeOut, esc, ICON, lerp, seg } from '../../lib.js';
import { dbmlLine, FCT_DBML, FCT_STATUS_LINE, PATH, R, wordAt } from './story.js';

const CX = 64, CW = 952, CY = 300, CH = 640;
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
    return `<div style="position:absolute;left:0;right:0;top:${HEAD + 4 + i * LINE}px;height:${LINE}px;background:${bg};box-shadow:${g > 0 ? `inset 5px 0 0 rgba(34,197,94,${g.toFixed(3)})` : 'none'};display:flex;align-items:center;white-space:pre;font-family:var(--mono);font-size:24px;${l.ctx ? 'opacity:.55' : `opacity:${lerp(0.25, 1, a).toFixed(3)}`}">
      <span style="width:44px;text-align:center;color:var(--green);font-weight:700">${l.ctx ? ' ' : '+'}</span><span>${fmt(l.s)}</span></div>`;
  }).join('');
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:12px;border:2px solid var(--card-border);background:#15161a;overflow:hidden;${appear(t, at)}">
    <div style="height:${HEAD}px;display:flex;align-items:center;gap:12px;padding:0 18px;background:var(--card-head);border-bottom:1px solid var(--card-border);white-space:nowrap">
      <span style="color:var(--text-2)">${ICON.file({ size: 22 })}</span><span class="mono" style="font-size:22px;color:var(--text)">${path}</span>
      <span style="flex:1"></span>${tag}</div>${rows}</div>`;
}

const sqlFmt = (s) => `<span style="color:var(--text)">${esc(s)}</span>`;

export default {
  render(t, { beats, scene }) {
    const D = beats.diff.t, S = beats.same.t;
    const addAt = D + 0.3;
    const readAt = wordAt(scene, 'diff', 'readable');
    const sqlAt = S - 0.1;
    const one = wordAt(scene, 'same', 'pull');
    const builds = wordAt(scene, 'same', 'builds');
    const glow = hump(t, readAt, 0.25, 0.9);

    let pr = card({ x: CX, y: CY, w: CW, h: CH, tabs: [{ label: 'Pull request', on: true }], crumb: `${R.repo}`, style: appear(t, 0, { dy: 20 }) });
    const by = CY + 64;
    pr += `<div class="abs" style="left:${CX + 28}px;top:${by + 18}px;font-size:34px;font-weight:700;letter-spacing:-.01em;white-space:nowrap"><span style="color:var(--text-3)">#${R.pr.number}</span> ${R.pr.title}</div>`;
    const nFiles = t >= sqlAt ? 2 : 1;
    pr += `<div class="abs" style="left:${CX + 28}px;right:${1080 - CX - CW + 28}px;top:${by + 74}px;display:flex;align-items:center;gap:18px;white-space:nowrap">
      <span class="pill" style="font-size:24px;padding:6px 18px;border:2px solid var(--green);color:var(--green)">Open</span>
      <span class="mono" style="font-size:23px;color:var(--text-2)">${R.pr.branch}</span><span style="color:var(--text-3)">${ICON.arrow({ size: 22 })}</span><span class="mono" style="font-size:23px;color:var(--text-2)">main</span>
      <span style="flex:1"></span><span style="font-size:24px;color:var(--text-2)">Files changed</span>
      <span style="min-width:40px;height:36px;border-radius:18px;background:#2a2c33;display:inline-flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;transform:scale(${(1 + 0.2 * hump(t, sqlAt, 0.12, 0.3)).toFixed(3)})">${nFiles}</span></div>`;

    const y1 = by + 140, h1 = HEAD + DBML.length * LINE + 8;
    const y2 = y1 + h1 + 16, h2 = HEAD + SQL.length * LINE + 8;
    const og = easeOut(seg(t, one, one + 0.4));
    if (og > 0) {
      pr += `<div class="abs" style="left:${BX - 10}px;top:${y1 - 10}px;width:${BW + 20}px;height:${y2 + h2 - y1 + 20}px;border-radius:18px;border:2px solid rgba(34,197,94,${(0.9 * og).toFixed(2)});box-shadow:0 0 ${(30 * hump(t, one, 0.2, 0.8)).toFixed(1)}px rgba(34,197,94,.45)"></div>`;
    }
    pr += fileBlock({ x: BX, y: y1, w: BW, path: PATH.fct, lines: DBML, fmt: dbmlLine, t, at: 0.15, addAt, glow,
      tag: `<span class="pill" style="font-size:22px;padding:4px 14px;background:#1b2a40;color:var(--logical)">design</span>` });
    // "+1 line" beside the added line, on "readable diff".
    if (t >= readAt) {
      pr += `<div class="abs" style="right:${1080 - BX - BW + 22}px;top:${y1 + HEAD + 4 + 2 * LINE + 2}px;${appear(t, readAt, { dy: 0, dx: 10 })}"><span class="pill" style="font-size:21px;padding:3px 14px;background:#13301f;color:var(--green);border:1px solid #1f6b3a">+1 line</span></div>`;
    }
    if (t >= sqlAt) {
      pr += fileBlock({ x: BX, y: y2, w: BW, path: R.pr.sql, lines: SQL, fmt: sqlFmt, t, at: sqlAt, addAt: sqlAt + 0.3,
        tag: `<span class="pill" style="font-size:22px;padding:4px 14px;background:#2a2c33;color:var(--text)">code</span>` });
    }
    const pillY = y2 + h2 + 26;
    if (t >= builds) {
      pr += `<div class="abs" style="left:${CX}px;width:${CW}px;top:${pillY}px;display:flex;justify-content:center;${appear(t, builds, { dy: 10 })}">
        <span class="pill" style="font-size:26px;padding:9px 24px;background:#13301f;color:var(--green);border:1px solid #1f5a35">${ICON.check({ size: 22 })}1 PR <span style="color:var(--text-3)">·</span> design + code</span></div>`;
    }
    return pr;
  },
};
