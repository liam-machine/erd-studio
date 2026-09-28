// 2 · The problem. Top: a separate browser-based modelling tool (light theme, so it reads as
// "not your editor") with the diagram the business looks at. Bottom: the repo the developers
// actually work in. On `back` an arrow runs from the picture down to the code ("work
// backwards"); on `drift` that link breaks, the diagram is stamped stale, its column list
// disagrees with the code, and finally "Nobody trusts it".
import { ICON, STORY, appear, card, easeOut, seg } from '../lib.js';

const X = 64, W = 952;
const TOP = { y: 300, h: 364 };           // modelling tool 300..664
const BOT = { y: 744, h: 346 };           // repo 744..1090
const GAP_MID = (TOP.y + TOP.h + BOT.y) / 2;

// ---- the SaaS tool's own diagram style (light, generic) ----
const ROW = 42, HEAD = 50;
function box({ x, y, w, name, cols, style = '', hot = -1, hotP = 0, tag = '' }) {
  const rows = cols.map((c, i) => {
    const on = i === hot && hotP > 0;
    const bg = on ? `rgba(244,180,44,${(0.32 * hotP).toFixed(3)})` : 'transparent';
    return `<div style="height:${ROW}px;display:flex;align-items:center;gap:10px;padding:0 16px;border-top:1px solid #e3e6ea;background:${bg};font-size:24px;color:#1f2328;white-space:nowrap">
      <span style="width:34px;font-size:15px;font-weight:800;color:#8a6d1f">${c.key ?? ''}</span><span style="flex:1">${c.name}</span>${on && tag ? tag : ''}</div>`;
  }).join('');
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;background:#fff;border:2px solid #c9ced6;border-radius:10px;overflow:hidden;box-shadow:0 6px 18px #0002;${style}">
    <div style="height:${HEAD}px;display:flex;align-items:center;padding:0 16px;background:#e8edf7;font-size:25px;font-weight:700;color:#1f2a44">${name}</div>${rows}</div>`;
}

const person = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="#f3dfb4"/><circle cx="24" cy="19" r="8" fill="#8a6d1f"/><path d="M9 40c2.5-8 8.5-12 15-12s12.5 4 15 12" fill="#8a6d1f"/></svg>`;

export default {
  render(t, { beats }) {
    const drawn = beats.drawn.t, back = beats.back.t, drift = beats.drift.t;
    const bizAt = drawn + 1.3;              // "…for business users"
    const repoAt = drawn + 2.2;             // "…in a separate tool"
    const arrowAt = back + 0.15;            // "Developers work backwards…"
    const staleAt = drift + 0.5;            // "…the design drifts"
    const breakAt = drift + 0.9;
    const stampAt = drift + 1.5;            // "…and nobody trusts the diagram"

    let html = '';

    // ---------- top: the modelling tool ----------
    const bodyH = TOP.h - 64;
    const brk = easeOut(seg(t, breakAt, breakAt + 0.45));
    const stamped = seg(t, stampAt, stampAt + 0.35);
    const hotP = seg(t, staleAt + 0.3, staleAt + 0.7);
    const fo = STORY.fct_order.cols.map(({ key, name }) => ({ key, name }));
    const dc = STORY.dim_customer.cols.slice(0, 2).map(({ key, name }) => ({ key, name }));
    const DCX = 28, DCY = 26, FOX = 322, FOY = 26, DCW = 270, FOW = 400, BIZW = 206;
    // The tool's own connector (grey, orthogonal)
    const conn = `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><path d="M${DCX + DCW} ${DCY + HEAD + ROW * 0.5} H${FOX - 20} V${FOY + HEAD + ROW * 1.5} H${FOX}" fill="none" stroke="#9aa3ae" stroke-width="2.5"/></svg>`;
    // Column mismatch tag inside the order_total row (the code renamed it to order_amt).
    const notInCode = `<span class="pill" style="font-size:24px;padding:2px 14px;background:var(--amber);color:#1a1405;opacity:${hotP.toFixed(3)}">not in code</span>`;
    const diagram = `<div class="abs" style="inset:0;background:#f4f6f9;background-image:radial-gradient(#d7dce3 1.2px, transparent 1.3px);background-size:24px 24px;opacity:${(1 - 0.35 * stamped).toFixed(3)}">
      ${conn}
      ${box({ x: DCX, y: DCY, w: DCW, name: 'dim_customer', cols: dc, style: appear(t, drawn + 0.2) })}
      ${box({ x: FOX, y: FOY, w: FOW, name: 'fct_order', cols: fo, hot: 3, hotP, style: appear(t, drawn + 0.4), tag: notInCode })}
    </div>`;
    // Business user, right of the diagram
    const biz = `<div class="abs" style="left:${W - BIZW}px;top:0;width:${BIZW}px;height:${bodyH}px;border-left:1px solid #dde1e6;background:#fbfbfc;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;${appear(t, bizAt)}">
      ${person(96)}<div style="font-size:28px;font-weight:800;color:#1f2328">Business</div><div style="font-size:24px;color:#6b7280;margin-top:-10px">views only</div></div>`;
    html += card({
      x: X, y: TOP.y, w: W, h: TOP.h, dots: true,
      tabs: [{ label: 'modeller.app', on: true, icon: `<span style="color:var(--text-2)">${ICON.globe({ size: 22 })}</span>` }],
      crumb: 'Orders diagram',
      body: diagram + biz,
      style: appear(t, 0),
    });
    // "Last updated 14 months ago", in the tool's header
    if (t >= staleAt) {
      html += `<div class="abs" style="right:${1080 - X - W + 18}px;top:${TOP.y + 13}px;${appear(t, staleAt, { dy: 6 })}">
        <span class="pill" style="font-size:24px;background:#3d3113;color:var(--amber);padding:6px 16px">${ICON.warn({ size: 22 })}Last updated 14 months ago</span></div>`;
    }
    // ---------- bottom: the repo ----------
    const files = [
      { name: STORY.sql.dim_customer.split('/').pop(), msg: 'add email column', when: '3 days ago' },
      { name: STORY.sql.fct_order.split('/').pop(), msg: `rename order_total to ${STORY.drift.renamed.physical}`, when: '2 hours ago', hot: true },
      { name: 'schema.yml', msg: 'add not_null tests', when: '2 hours ago' },
    ];
    const rowsHtml = files.map((f, i) => {
      const hot = f.hot ? hotP : 0;
      const y = 62 + i * 72;
      return `<div class="abs" style="left:0;right:0;top:${y}px;height:72px;display:flex;align-items:center;gap:18px;padding:0 30px;border-top:1px solid var(--row-line);background:rgba(56,48,28,${hot.toFixed(3)});white-space:nowrap;${appear(t, repoAt + 0.2 + i * 0.12, { dy: 8 })}">
        <span style="color:var(--text-2)">${ICON.file({ size: 26 })}</span>
        <span class="mono" style="font-size:26px;width:250px;color:var(--text)">${f.name}</span>
        <span style="flex:1;font-size:24px;color:${hot > 0.5 ? 'var(--amber)' : 'var(--text-2)'};overflow:hidden;text-overflow:ellipsis">${f.msg}</span>
        <span style="font-size:24px;color:var(--text-3)">${f.when}</span></div>`;
    }).join('');
    const repoHead = `<div class="abs" style="left:30px;top:14px;display:flex;align-items:center;gap:14px;font-size:24px;color:var(--text-2);white-space:nowrap">
      <span style="color:#7aa7e0">${ICON.folder({ size: 26 })}</span><span class="mono" style="color:var(--text);font-size:25px">models/marts/</span>
      <span style="color:var(--text-3)">·</span><span style="color:var(--green)">3 commits today</span></div>`;
    html += card({
      x: X, y: BOT.y, w: W, h: BOT.h, dots: true,
      tabs: [{ label: 'analytics', on: true, icon: `<span style="color:var(--text-2)">${ICON.folder({ size: 22 })}</span>` }],
      crumb: 'the dbt repo',
      body: repoHead + rowsHtml,
      style: appear(t, repoAt),
    });

    // ---------- the link between them ----------
    if (t >= arrowAt) {
      const ax = X + FOX + FOW / 2;           // under fct_order
      const y0 = TOP.y + TOP.h + 6, y1 = BOT.y - 8;
      const grow = easeOut(seg(t, arrowAt, arrowAt + 0.5));
      const colour = brk > 0 ? 'var(--amber)' : 'var(--text)';
      const len = (y1 - y0) * grow;
      let line;
      if (brk <= 0) {
        line = `<path d="M${ax} ${y0} V${y0 + len}" stroke="${colour}" stroke-width="4" fill="none"/>`
          + (grow > 0.95 ? `<path d="M${ax - 11} ${y1 - 12} L${ax} ${y1} L${ax + 11} ${y1 - 12}" stroke="${colour}" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : '');
      } else {
        // The link snaps: two dashed halves pull apart around a gap.
        const mid = (y0 + y1) / 2, g = 14 * brk;
        line = `<path d="M${ax} ${y0} V${mid - g}" stroke="${colour}" stroke-width="4" stroke-dasharray="7 6" fill="none"/>
          <path d="M${ax} ${mid + g} V${y1}" stroke="${colour}" stroke-width="4" stroke-dasharray="7 6" fill="none"/>`;
      }
      html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1">${line}</svg>`;
      if (brk > 0) html += `<div class="abs" style="left:${ax - 17}px;top:${GAP_MID - 17}px;width:34px;height:34px;border-radius:50%;background:#3d3113;color:var(--amber);display:flex;align-items:center;justify-content:center;opacity:${brk.toFixed(3)}">${ICON.x({ size: 18 })}</div>`;
      // Label to the left of the arrow
      const label = brk > 0.5 ? 'out of sync' : 'work backwards';
      html += `<div class="abs" style="right:${1080 - ax + 30}px;top:${GAP_MID - 22}px;${appear(t, arrowAt + 0.3, { dy: 0, dx: 10 })}">
        <span class="pill" style="font-size:26px;padding:6px 18px;background:${brk > 0.5 ? '#3d3113' : '#26282e'};color:${brk > 0.5 ? 'var(--amber)' : 'var(--text)'}">${label}</span></div>`;
    }

    // ---------- "Nobody trusts it" ----------
    if (t >= stampAt) {
      const sc = 1.25 - 0.25 * easeOut(stamped);
      html += `<div class="abs" style="left:${X + 60}px;top:${TOP.y + 170}px;width:640px;display:flex;justify-content:center;opacity:${stamped.toFixed(3)};transform:rotate(-7deg) scale(${sc.toFixed(3)})">
        <div style="padding:14px 34px;border:5px solid var(--amber);border-radius:14px;background:#1a1405e6;color:var(--amber);font-size:50px;font-weight:800;letter-spacing:.02em;white-space:nowrap;box-shadow:0 14px 40px #000a">Nobody trusts it</div></div>`;
    }
    return html;
  },
};
