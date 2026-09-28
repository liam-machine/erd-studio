// 9 · pr — one pull request carries the design change (fct_order.yml) and the SQL change
// (fct_order.sql). "same pull request" wraps both files in one green outline; "Reviewed
// together" flips Open to Approved; "Tracked together" adds the "1 PR · design + code" pill;
// "Shipped together" merges it (then "It's just common sense…" plays over the merged PR).
// On the AI line the PR slides up and a compact Claude Code strip reads the model file (the
// yml block lights blue as it is read) before it writes the SQL.
import { appear, card, COLORS, easeInOut, easeOut, esc, ICON, lerp, seg, spinner, STORY, tick, yamlLine } from '../lib.js';

const CX = 64, CW = 952, CY = 300, CH = 598;
const BX = CX + 24, BW = CW - 48;                   // file blocks
const HEAD = 50, LINE = 38;
const hump = (t, a, up, down) => (t < a ? 0 : t < a + up ? seg(t, a, a + up) : 1 - seg(t, a + up, a + up + down));

const PR = STORY.pr;
const YML = [
  { ctx: true, s: '    dataType: DECIMAL(12,2)' },
  { s: `  - name: ${PR.column}` },
  { s: `    dataType: ${PR.type}` },
];
const SQL = [
  { ctx: true, s: '    order_total,' },
  { s: `    ${PR.column},` },
];

function fileBlock({ x, y, w, path, tag, lines, html: fmt, t, at, addAt, glow = 0, glowColor = COLORS.logical }) {
  const h = HEAD + lines.length * LINE + 8;
  const border = glow > 0 ? `rgba(96,165,250,${(0.25 + 0.75 * glow).toFixed(2)})` : 'var(--card-border)';
  const rows = lines.map((l, i) => {
    const on = !l.ctx && t >= addAt + i * 0.15;
    const a = on ? easeOut(seg(t, addAt + i * 0.15, addAt + i * 0.15 + 0.3)) : 0;
    const bg = l.ctx ? 'transparent' : `rgba(19,48,31,${a.toFixed(3)})`;
    const sign = l.ctx ? ' ' : '+';
    return `<div style="position:absolute;left:0;right:0;top:${HEAD + 4 + i * LINE}px;height:${LINE}px;background:${bg};display:flex;align-items:center;white-space:pre;font-family:var(--mono);font-size:25px;${l.ctx ? 'opacity:.55' : `opacity:${lerp(0.25, 1, a).toFixed(3)}`}">
      <span style="width:44px;text-align:center;color:var(--green);font-weight:700">${sign}</span><span>${fmt(l.s)}</span></div>`;
  }).join('');
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:12px;border:2px solid ${border};background:#15161a;overflow:hidden;box-shadow:0 0 ${(28 * glow).toFixed(1)}px rgba(96,165,250,${(0.35 * glow).toFixed(2)});${appear(t, at)}">
    <div style="height:${HEAD}px;display:flex;align-items:center;gap:12px;padding:0 18px;background:var(--card-head);border-bottom:1px solid var(--card-border);white-space:nowrap">
      <span style="color:var(--text-2)">${ICON.file({ size: 22 })}</span><span class="mono" style="font-size:24px;color:var(--text)">${path}</span>
      <span style="flex:1"></span>${tag}</div>${rows}</div>`;
}

const sqlFmt = (s) => `<span style="color:var(--text)">${esc(s)}</span>`;

export default {
  render(t, { beats }) {
    const S = beats.same.t, R = beats.review.t, A = beats.ai.t;
    const ymlAt = S;                // "The design change"
    const sqlAt = S + 1.15;         // clip 1.23 s → "and the SQL change"
    const one = S + 2.55;           // "…in the same pull request"
    const approved = R + 0.05;      // "Reviewed together."
    const tracked = R + 1.0;        // clip 0.96 s → "Tracked together."
    const shipped = R + 1.8;        // clip 1.80 s → "Shipped together."
    const read = A + 1.05;          // clip 1.10 s → "reads the model"
    const readDone = A + 1.55;
    const write = A + 2.45;         // "…before it writes a single line"
    const written = A + 3.0;

    // The PR sits centred in the stage, then slides up to make room for the Claude strip.
    const lift = easeInOut(seg(t, A - 0.15, A + 0.4));
    const off = lerp(100, 0, lift);

    const isApproved = t >= approved;
    let pr = card({ x: CX, y: CY, w: CW, h: CH, tabs: [{ label: 'Pull request', on: true }], crumb: 'acme/analytics' });
    const by = CY + 64;
    pr += `<div class="abs" style="left:${CX + 28}px;top:${by + 18}px;font-size:34px;font-weight:700;letter-spacing:-.01em;white-space:nowrap"><span style="color:var(--text-3)">#${PR.number}</span> ${PR.title}</div>`;
    const ap = seg(t, approved, approved + 0.3);
    const mergeIcon = `<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="6" cy="5" r="2.4"/><circle cx="6" cy="19" r="2.4"/><circle cx="18" cy="12" r="2.4"/><path d="M6 7.4v9.2M6 9c0 3 3 3 9.6 3"/></svg>`;
    const status = t >= shipped
      ? `<span class="pill" style="font-size:24px;padding:7px 18px;background:#8957e5;color:#fff;transform:scale(${(1 + 0.1 * hump(t, shipped, 0.12, 0.3)).toFixed(3)})">${mergeIcon}Merged</span>`
      : isApproved
      ? `<span class="pill" style="font-size:24px;padding:7px 18px;background:var(--green);color:#06210f;transform:scale(${(1 + 0.08 * hump(t, approved, 0.12, 0.3)).toFixed(3)});opacity:${lerp(0.4, 1, ap).toFixed(3)}">${ICON.check({ size: 20 })}Approved</span>`
      : `<span class="pill" style="font-size:24px;padding:6px 18px;border:2px solid var(--green);color:var(--green)">Open</span>`;
    const nFiles = t >= sqlAt ? 2 : 1;
    pr += `<div class="abs" style="left:${CX + 28}px;right:${1080 - CX - CW + 28}px;top:${by + 74}px;display:flex;align-items:center;gap:18px;white-space:nowrap">${status}
      <span class="mono" style="font-size:24px;color:var(--text-2)">${PR.branch}</span><span style="color:var(--text-3)">${ICON.arrow({ size: 22 })}</span><span class="mono" style="font-size:24px;color:var(--text-2)">main</span>
      <span style="flex:1"></span><span style="font-size:24px;color:var(--text-2)">Files changed</span>
      <span style="min-width:40px;height:36px;border-radius:18px;background:#2a2c33;display:inline-flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;transform:scale(${(1 + 0.2 * hump(t, sqlAt, 0.12, 0.3)).toFixed(3)})">${nFiles}</span></div>`;

    // "same pull request": one green outline around both files.
    const y1 = by + 134, h1 = HEAD + YML.length * LINE + 8;
    const y2 = y1 + h1 + 14, h2 = HEAD + SQL.length * LINE + 8;
    const og = easeOut(seg(t, one, one + 0.4));
    if (og > 0) {
      pr += `<div class="abs" style="left:${BX - 10}px;top:${y1 - 10}px;width:${BW + 20}px;height:${y2 + h2 - y1 + 20}px;border-radius:18px;border:2px solid rgba(34,197,94,${(0.9 * og).toFixed(2)});box-shadow:0 0 ${(30 * hump(t, one, 0.2, 0.8)).toFixed(1)}px rgba(34,197,94,.45)"></div>`;
    }
    const readGlow = hump(t, read, 0.2, 1.2);
    pr += fileBlock({ x: BX, y: y1, w: BW, path: `${STORY.modelDir}/fct_order.yml`, lines: YML, html: yamlLine, t, at: ymlAt, addAt: ymlAt + 0.35, glow: readGlow,
      tag: `<span class="pill" style="font-size:22px;padding:4px 14px;background:#1b2a40;color:var(--logical)">design</span>` });
    pr += fileBlock({ x: BX, y: y2, w: BW, path: STORY.sql.fct_order, lines: SQL, html: sqlFmt, t, at: sqlAt, addAt: sqlAt + 0.35,
      tag: `<span class="pill" style="font-size:22px;padding:4px 14px;background:#2a2c33;color:var(--text)">code</span>` });

    // "Tracked together": the pill under the outline.
    const pillY = y2 + h2 + 22;
    pr += `<div class="abs" style="left:${CX}px;width:${CW}px;top:${pillY}px;display:flex;justify-content:center;${appear(t, tracked, { dy: 10 })}">
      <span class="pill" style="font-size:26px;padding:9px 24px;background:#13301f;color:var(--green);border:1px solid #1f5a35">${ICON.check({ size: 22 })}1 PR <span style="color:var(--text-3)">·</span> design + code</span></div>`;

    let html = `<div class="abs" style="left:0;top:0;transform:translateY(${off.toFixed(1)}px)">${pr}</div>`;

    // Claude Code strip: reads the model, then writes the SQL.
    const SY = CY + CH + 14, SH = 1088 - SY;
    if (t >= A - 0.15) {
      const rows = [
        { at: read, kind: 'tool', text: 'Read(fct_order.yml)', done: readDone },
        { at: readDone, kind: 'res', text: `grain: one row per order <span style="color:var(--text-3)">·</span> PK order_id` },
        { at: write, kind: 'tool', text: 'Write(models/marts/fct_order.sql)', done: written },
      ];
      const inner = rows.map((r, i) => {
        if (t < r.at) return '';
        const y = 56 + i * 40;
        const body = r.kind === 'tool'
          ? `<span class="dot" style="background:${t >= r.done ? 'var(--green)' : 'var(--text)'}"></span><span class="mono" style="font-size:24px;color:var(--text)">${r.text}</span>${t >= r.done ? tick('ok') : spinner(t, 24)}`
          : `<span style="width:14px"></span><span style="color:var(--text-3)">${ICON.chevRight({ size: 20 })}</span><span style="font-size:24px;color:var(--logical);font-weight:600">${r.text}</span>`;
        return `<div class="abs" style="left:28px;top:${y}px;height:38px;display:flex;align-items:center;gap:14px;white-space:nowrap;${appear(t, r.at, { dy: 0, dx: -10 })}">${body}</div>`;
      }).join('');
      html += `<div class="abs" style="left:${CX}px;top:${SY}px;width:${CW}px;height:${SH}px;border-radius:20px;background:var(--card);border:1px solid var(--card-border);box-shadow:0 30px 80px #000a;overflow:hidden;${appear(t, A - 0.05, { dy: 40, dur: 0.45 })}">
        <div style="height:44px;display:flex;align-items:center;gap:12px;padding:0 20px;background:var(--card-head);border-bottom:1px solid var(--card-border);font-size:22px;color:var(--text);white-space:nowrap">
          <div class="card__dots" style="padding:0 8px 0 0"><i></i><i></i><i></i></div><span style="color:var(--claude)">${ICON.claude({ size: 20 })}</span>Claude Code</div>${inner}</div>`;
    }
    return html;
  },
};
