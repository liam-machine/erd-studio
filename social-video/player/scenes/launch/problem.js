// launch · 2 · problem — "Drawn for the business. Invisible to the code." The README cut's `why`
// scene (readme/why.js) retold for the pro arc: a separate, light-themed modelling tool on top
// (labelled generically, "Modelling tool", never a product a real company could own) with the
// diagram drawn for the business; the repo with the code that builds it below.
//   drawn  the tool is there from the start; "for the business" tags it; "separate tool" lights
//          its window.
//   back   the repo arrives on "Developers"; on "backwards" a dashed arrow runs from the picture
//          down into the code, "working backwards".
//   drift  on "drifts" the link snaps (amber), the tool says "Last updated 14 months ago" and the
//          repo's orders.sql shows the column the picture never got; on "nobody trusts" an amber
//          stamp lands on the diagram.
import { appear, card, easeOut, ICON, seg } from '../../lib.js';
import { R, wordAt } from '../readme/story.js';

const X = 64, W = 952;
const TOP = { y: 300, h: 380 }, BOT = { y: 752, h: 336 };
const ROW = 40, HEAD = 46;

// Light, generic diagram-tool boxes (not ERD Studio's look).
function box({ x, y, w, name, cols, hot = -1, hotP = 0 }) {
  const rows = cols.map((c, i) => {
    const bg = i === hot ? `rgba(244,180,44,${(0.32 * hotP).toFixed(3)})` : 'transparent';
    return `<div style="height:${ROW}px;display:flex;align-items:center;gap:10px;padding:0 14px;border-top:1px solid #e3e6ea;background:${bg};font-size:22px;color:#1f2328;white-space:nowrap">
      <span style="width:32px;font-size:14px;font-weight:800;color:#8a6d1f">${c.key ?? ''}</span><span style="flex:1">${c.name}</span></div>`;
  }).join('');
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;background:#fff;border:2px solid #c9ced6;border-radius:10px;overflow:hidden;box-shadow:0 6px 18px #0002">
    <div style="height:${HEAD}px;display:flex;align-items:center;padding:0 14px;background:#e8edf7;font-size:23px;font-weight:700;color:#1f2a44">${name}</div>${rows}</div>`;
}
const people = (size = 22) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.2c2.3.2 4.1 1.8 4.6 4.8"/></svg>`;

export default {
  render(t, { scene }) {
    const bizAt = wordAt(scene, 'drawn', 'business');
    const toolAt = wordAt(scene, 'drawn', 'separate');
    const devAt = wordAt(scene, 'back', 'Developers') - 0.15;
    const backAt = wordAt(scene, 'back', 'backwards');
    const driftAt = wordAt(scene, 'drift', 'drifts');
    const trustAt = wordAt(scene, 'drift', 'nobody') - 0.05;
    const brk = easeOut(seg(t, driftAt + 0.2, driftAt + 0.6));
    const hotP = seg(t, driftAt, driftAt + 0.4);
    const lit = easeOut(seg(t, toolAt, toolAt + 0.3)) * (1 - 0.6 * seg(t, toolAt + 1.2, toolAt + 1.8));

    // ================= the separate tool (top) =================
    const dc = R.dim_customer.cols.slice(0, 2).map(({ key, name }) => ({ key, name }));
    const fo = R.fct_order.cols.map(({ key, name }) => ({ key, name }));
    const DCX = 30, FOX = 360, BY = 24;
    const conn = `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><path d="M${DCX + 270} ${BY + HEAD + ROW * 0.5} H${FOX - 22} V${BY + HEAD + ROW * 1.5} H${FOX}" fill="none" stroke="#9aa3ae" stroke-width="2.5"/></svg>`;
    let body = `<div class="abs" style="inset:0;background:#f4f6f9;background-image:radial-gradient(#d7dce3 1.2px, transparent 1.3px);background-size:24px 24px;opacity:${(1 - 0.3 * brk).toFixed(3)}">
      ${conn}${box({ x: DCX, y: BY, w: 270, name: 'dim_customer', cols: dc })}${box({ x: FOX, y: BY, w: 360, name: 'fct_order', cols: fo })}</div>`;
    if (t >= bizAt) {
      body += `<div class="abs" style="left:30px;top:254px;${appear(t, bizAt, { dy: 6 })}"><span class="pill" style="font-size:22px;padding:6px 16px;gap:8px;background:#fff;color:#1f2a44;border:2px solid #c9ced6">${people(22)}drawn for the business</span></div>`;
    }
    if (t >= trustAt) {
      const p = easeOut(seg(t, trustAt, trustAt + 0.35));
      body += `<div class="abs" style="left:530px;top:200px;opacity:${p.toFixed(3)};transform:rotate(-8deg) scale(${(1.4 - 0.4 * p).toFixed(3)});transform-origin:50% 50%">
        <span style="display:inline-block;padding:8px 22px;border:4px solid #d9822b;border-radius:10px;color:#c96f16;font-size:32px;font-weight:900;letter-spacing:.06em;background:#fff8ee;white-space:nowrap">NOBODY TRUSTS IT</span></div>`;
    }
    let html = card({
      x: X, y: TOP.y, w: W, h: TOP.h, dots: true,
      tabs: [{ label: 'Modelling tool', on: true, icon: `<span style="color:var(--text-2)">${ICON.globe({ size: 22 })}</span>` }],
      crumb: 'a separate tool', body,
      style: `${appear(t, 0.05, { dy: -20, dur: 0.4 })}box-shadow:0 0 0 ${(3 * lit).toFixed(2)}px rgba(244,180,44,${(0.8 * lit).toFixed(3)}),0 30px 80px #000a;`,
    });
    if (t >= driftAt) {
      html += `<div class="abs" style="right:${1080 - X - W + 18}px;top:${TOP.y + 13}px;${appear(t, driftAt, { dy: 6 })}">
        <span class="pill" style="font-size:23px;background:#3d3113;color:var(--amber);padding:6px 16px">${ICON.warn({ size: 22 })}Last updated 14 months ago</span></div>`;
    }

    // ================= the repo, with the code (bottom) =================
    if (t >= devAt) {
      const files = [
        { name: 'customers.sql', msg: 'add email column', when: '3 days ago' },
        { name: 'orders.sql', msg: `add ${R.drift.physOnly.name} column`, when: '2 hours ago', hot: true },
        { name: 'payments.sql', msg: 'new model', when: 'yesterday' },
      ];
      let rb = `<div class="abs" style="left:30px;top:14px;display:flex;align-items:center;gap:14px;font-size:24px;color:var(--text-2);white-space:nowrap">
        <span style="color:#7aa7e0">${ICON.folder({ size: 26 })}</span><span class="mono" style="color:var(--text);font-size:25px">sql/</span>
        <span style="color:var(--text-3)">·</span><span style="color:var(--green)">versioned in Git · 3 commits this week</span></div>`;
      files.forEach((f, i) => {
        const hot = f.hot ? hotP : 0;
        rb += `<div class="abs" style="left:0;right:0;top:${62 + i * 70}px;height:70px;display:flex;align-items:center;gap:18px;padding:0 30px;border-top:1px solid var(--row-line);background:rgba(56,48,28,${hot.toFixed(3)});white-space:nowrap;${appear(t, devAt + 0.15 + i * 0.12, { dy: 8 })}">
          <span style="color:#78c0f4">${ICON.file({ size: 26 })}</span>
          <span class="mono" style="font-size:25px;width:220px;color:var(--text)">${f.name}</span>
          <span style="flex:1;font-size:23px;color:${hot > 0.5 ? 'var(--amber)' : 'var(--text-2)'};overflow:hidden;text-overflow:ellipsis">${f.msg}</span>
          <span style="font-size:22px;color:var(--text-3)">${f.when}</span></div>`;
      });
      html += card({
        x: X, y: BOT.y, w: W, h: BOT.h, dots: true,
        tabs: [{ label: R.repo, on: true, icon: `<span style="color:var(--text-2)">${ICON.folder({ size: 22 })}</span>` }],
        crumb: 'the code', body: rb, style: appear(t, devAt, { dy: 30, dur: 0.4 }),
      });

      // The link between them: "working backwards" down from the picture, then it snaps on "drifts".
      const ax = 540, y0 = TOP.y + TOP.h + 8, y1 = BOT.y - 10, mid = (y0 + y1) / 2;
      const grow = easeOut(seg(t, backAt - 0.1, backAt + 0.4));
      const colour = brk > 0 ? 'var(--amber)' : '#8b9099';
      const g = 12 * brk;
      let line;
      if (brk <= 0) {
        const yEnd = y0 + (y1 - y0) * grow;
        line = `<path d="M${ax} ${y0} V${yEnd}" stroke="${colour}" stroke-width="4" fill="none" stroke-dasharray="7 6"/>`;
        if (grow > 0.95) line += `<path d="M${ax - 10} ${y1 - 12} L${ax} ${y1} L${ax + 10} ${y1 - 12}" stroke="${colour}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
      } else {
        line = `<path d="M${ax} ${y0} V${mid - g}" stroke="${colour}" stroke-width="4" stroke-dasharray="7 6" fill="none"/><path d="M${ax} ${mid + g} V${y1}" stroke="${colour}" stroke-width="4" stroke-dasharray="7 6" fill="none"/>`;
      }
      if (grow > 0) html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1">${line}</svg>`;
      if (t >= backAt && t < driftAt + 0.3) {
        const op = 1 - seg(t, driftAt, driftAt + 0.3);
        html += `<div class="abs" style="left:${ax + 30}px;top:${mid - 22}px;opacity:${op.toFixed(3)}"><span class="pill" style="font-size:24px;padding:5px 16px;gap:10px;background:#1c1e23;border:2px solid #4a4e57;color:var(--text);${appear(t, backAt, { dy: 0, dx: -10 })}">working backwards from the picture</span></div>`;
      }
      if (brk > 0) {
        html += `<div class="abs" style="left:${ax - 16}px;top:${mid - 16}px;width:32px;height:32px;border-radius:50%;background:#3d3113;color:var(--amber);display:flex;align-items:center;justify-content:center;opacity:${brk.toFixed(3)}">${ICON.x({ size: 18 })}</div>`;
        html += `<div class="abs" style="left:${ax + 30}px;top:${mid - 21}px;${appear(t, driftAt + 0.3, { dy: 0, dx: -10 })}"><span class="pill" style="font-size:24px;padding:5px 16px;background:#3d3113;color:var(--amber)">drifts from the code</span></div>`;
      }
    }
    return html;
  },
};
