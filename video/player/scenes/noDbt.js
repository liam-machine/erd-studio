// 6 · No dbt installed: the amber "dbt not found" row gives way to a green "reading your files
// instead" row, the files it reads tick off, and an install card appears.
import { appear, card, ICON, seg, tick } from '../lib.js';

const X = 96, Y = 322, W = 1728, H = 600;
const IN = X + 44, IW = W - 88;

export default {
  render(t, { beats }) {
    const none = beats.none.t, reads = beats.reads.t, later = beats.later.t;
    let html = card({ x: X, y: Y, w: W, h: H, tabs: [{ label: 'Claude Code', on: true, icon: `<span style="color:var(--claude)">${ICON.claude({ size: 20 })}</span>` }], style: appear(t, 0) });

    // Row that swaps from amber to green on the "reads" beat (cross-fade, same slot).
    const rowY = Y + 64 + 58;
    const swap = seg(t, reads + 0.1, reads + 0.45);
    const bar = (colour, bg, icon, text, op) => `<div class="abs" style="left:${IN}px;top:${rowY}px;width:${IW}px;height:84px;border-radius:14px;background:${bg};overflow:hidden;display:flex;align-items:center;gap:20px;padding:0 30px;font-size:29px;font-weight:600;white-space:nowrap;opacity:${op.toFixed(3)}">
        <span class="abs" style="left:0;top:0;bottom:0;width:6px;background:${colour}"></span>${icon}${text}</div>`;
    if (t >= none + 0.2) {
      const inStyle = appear(t, none + 0.2, { dy: 0, dx: -14 });
      html += `<div class="abs" style="inset:0;${inStyle}">${bar('var(--amber)', 'var(--amber-row)', tick('warn'), 'dbt isn’t installed on this machine', 1 - swap)}</div>`;
      if (swap > 0) html += bar('var(--green)', 'var(--green-row)', tick('ok'), 'Reading your .sql and .yml files instead', swap);
    }

    // Files it reads
    const files = [
      ['models/marts/fct_order.sql', '#5ca2f8'], ['models/marts/dim_customer.sql', '#5ca2f8'],
      ['models/marts/schema.yml', '#c9a24b'], ['models/staging/stg_orders.sql', '#5ca2f8'],
    ];
    files.forEach(([f, c], i) => {
      const at = reads + 0.7 + i * 0.3;
      if (t < at) return;
      const col = i % 2, r = Math.floor(i / 2);
      const x = IN + col * (IW / 2 + 10), y = rowY + 116 + r * 72;
      html += `<div class="abs" style="left:${x}px;top:${y}px;width:${IW / 2 - 10}px;height:60px;border-radius:12px;background:var(--card-inner);border:1px solid var(--card-border);display:flex;align-items:center;gap:14px;padding:0 20px;white-space:nowrap;${appear(t, at, { dy: 8 })}">
        <span style="color:${c}">${ICON.file({ size: 24 })}</span><span class="mono" style="font-size:22px;flex:1">${f}</span>
        <span style="color:var(--green);opacity:${seg(t, at + 0.25, at + 0.4).toFixed(2)}">${ICON.check({ size: 24 })}</span></div>`;
    });

    // "When you're ready" install card
    const cA = later + 0.35;
    html += `<div class="abs" style="left:${IN}px;top:${rowY + 290}px;width:${IW}px;height:112px;border-radius:14px;border:1px dashed #3d4452;background:#171a20;display:flex;align-items:center;gap:22px;padding:0 30px;${appear(t, cA)}">
      <span style="color:var(--blue)">${ICON.external({ size: 32 })}</span>
      <div style="flex:1"><div style="font-size:27px;font-weight:700;display:flex;align-items:center;gap:10px">How to install dbt ${ICON.arrow({ size: 24 })}</div>
      <div style="margin-top:6px;font-size:21px;color:var(--text-2)">Step-by-step, whenever you're ready. Everything above works without it.</div></div>
      <span class="pill" style="background:#1b2a40;color:#cfe3ff">Later</span></div>`;
    return html;
  },
};
