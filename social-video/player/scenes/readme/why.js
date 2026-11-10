// readme · 2 · why — "So why is it kept away from the code?" The challenge. The diagram the hook
// drew opens the scene, then on "separate tool" it is packed off into a separate, light-themed
// browser tool at the top ("remote database" and "its own version history" tag it on their
// words) while the repo with the code that builds it arrives below. `cost`: on "switching
// context" a pointer hops between the two windows; on "drifts" the link between them snaps
// ("Last updated 14 months ago"; orders.sql added a loaded_at column — the same drift the dbt beat
// finds); on "AI" the assistant in the repo finds no data model. The tool's window is labelled
// generically ("Modelling tool"), never with a name or domain a real product could own.
import { appear, appearFade, card, COLORS, easeInOut, easeOut, edge, ICON, lerp, node, path, pointer, rowY, seg } from '../../lib.js';
import { R, wordAt } from './story.js';
import { HOOK } from './hook.js';

const X = 64, W = 952;
const { NY, DX, DW, FX, FW } = HOOK;
const MIDX = (DX + DW + FX) / 2;
const TOP = { y: 300, h: 372 }, BOT = { y: 744, h: 346 };

// Light, generic diagram-tool boxes (not ERD Studio's look).
const ROW = 40, HEAD = 46;
function box({ x, y, w, name, cols, hot = -1, hotP = 0 }) {
  const rows = cols.map((c, i) => {
    const bg = i === hot ? `rgba(244,180,44,${(0.32 * hotP).toFixed(3)})` : 'transparent';
    return `<div style="height:${ROW}px;display:flex;align-items:center;gap:10px;padding:0 14px;border-top:1px solid #e3e6ea;background:${bg};font-size:22px;color:#1f2328;white-space:nowrap">
      <span style="width:32px;font-size:14px;font-weight:800;color:#8a6d1f">${c.key ?? ''}</span><span style="flex:1">${c.name}</span></div>`;
  }).join('');
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;background:#fff;border:2px solid #c9ced6;border-radius:10px;overflow:hidden;box-shadow:0 6px 18px #0002">
    <div style="height:${HEAD}px;display:flex;align-items:center;padding:0 14px;background:#e8edf7;font-size:23px;font-weight:700;color:#1f2a44">${name}</div>${rows}</div>`;
}
const dbIcon = (size = 22) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>`;
const clockIcon = (size = 22) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

export default {
  render(t, { scene }) {
    const toolAt = wordAt(scene, 'ask', 'separate') - 0.15;
    const dbAt = wordAt(scene, 'ask', 'remote');
    const verAt = wordAt(scene, 'ask', 'versioned');
    const codeAt = wordAt(scene, 'ask', 'from the code') - 0.2;
    const ctxAt = wordAt(scene, 'cost', 'switching') - 0.1;
    const driftAt = wordAt(scene, 'cost', 'drifts');
    const aiAt = wordAt(scene, 'cost', 'AI');
    const away = easeInOut(seg(t, toolAt - 0.1, toolAt + 0.45));

    let html = '';
    // ================= the diagram the hook drew, packed away =================
    if (away < 1) {
      let d = '';
      const sy = NY + rowY(0), fy = NY + rowY(1);
      d += edge([[DX + DW, sy], [MIDX, sy], [MIDX, fy], [FX, fy]], { color: COLORS.logical, one: [DX + DW + 8, sy - 10], many: [FX - 22, fy - 8] });
      d += node({ x: DX, y: NY, w: DW, name: R.dim_customer.name, layer: R.badge, grain: R.dim_customer.grain, cols: R.dim_customer.cols });
      d += node({ x: FX, y: NY, w: FW, name: R.fct_order.name, layer: R.badge, grain: R.fct_order.grain, cols: R.fct_order.cols });
      html += `<div class="abs" style="left:0;top:0;width:1080px;height:1350px;opacity:${(1 - away).toFixed(3)};transform:scale(${lerp(1, 0.82, away).toFixed(4)});transform-origin:540px 300px">${d}</div>`;
    }
    if (t < toolAt - 0.1) return html;

    // ================= the separate tool (top) =================
    const brk = easeOut(seg(t, driftAt + 0.2, driftAt + 0.6));
    const hotP = seg(t, driftAt, driftAt + 0.4);
    const dc = R.dim_customer.cols.slice(0, 2).map(({ key, name }) => ({ key, name }));
    const fo = R.fct_order.cols.map(({ key, name }) => ({ key, name }));
    const DCX = 30, FOX = 360, BY = 24;
    const conn = `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><path d="M${DCX + 270} ${BY + HEAD + ROW * 0.5} H${FOX - 22} V${BY + HEAD + ROW * 1.5} H${FOX}" fill="none" stroke="#9aa3ae" stroke-width="2.5"/></svg>`;
    let body = `<div class="abs" style="inset:0;background:#f4f6f9;background-image:radial-gradient(#d7dce3 1.2px, transparent 1.3px);background-size:24px 24px;opacity:${(1 - 0.3 * brk).toFixed(3)}">
      ${conn}${box({ x: DCX, y: BY, w: 270, name: 'dim_customer', cols: dc })}${box({ x: FOX, y: BY, w: 360, name: 'fct_order', cols: fo })}</div>`;
    // Tags on the right of the tool's canvas: where it lives, how it is versioned.
    const tagCol = `<div class="abs" style="left:30px;top:252px;display:flex;align-items:center;gap:12px;white-space:nowrap">
      ${t >= dbAt ? `<span class="pill" style="font-size:22px;padding:6px 16px;gap:8px;background:#fff;color:#1f2a44;border:2px solid #c9ced6;${appear(t, dbAt, { dy: 6 })}">${dbIcon(22)}remote database</span>` : ''}
      ${t >= verAt ? `<span class="pill" style="font-size:22px;padding:6px 16px;gap:8px;background:#fff;color:#1f2a44;border:2px solid #c9ced6;${appear(t, verAt, { dy: 6 })}">${clockIcon(22)}its own version history</span>` : ''}</div>`;
    body += tagCol;
    // The pointer: hops between the windows on "switching context".
    const toolTab = { x: X + 150, y: TOP.y + 32 }, repoTab = { x: X + 160, y: BOT.y + 32 };
    html += card({
      x: X, y: TOP.y, w: W, h: TOP.h, dots: true,
      tabs: [{ label: 'Modelling tool', on: true, icon: `<span style="color:var(--text-2)">${ICON.globe({ size: 22 })}</span>` }],
      crumb: 'a separate tool', body, style: appear(t, toolAt, { dy: -30, dur: 0.45 }),
    });
    if (t >= driftAt) {
      html += `<div class="abs" style="right:${1080 - X - W + 18}px;top:${TOP.y + 13}px;${appear(t, driftAt, { dy: 6 })}">
        <span class="pill" style="font-size:23px;background:#3d3113;color:var(--amber);padding:6px 16px">${ICON.warn({ size: 22 })}Last updated 14 months ago</span></div>`;
    }

    // ================= the repo, with the code and the AI (bottom) =================
    if (t >= codeAt) {
      const files = [
        { name: 'customers.sql', msg: 'add email column', when: '3 days ago' },
        { name: 'orders.sql', msg: `add ${R.drift.physOnly.name} column`, when: '2 hours ago', hot: true },
      ];
      let rb = `<div class="abs" style="left:30px;top:14px;display:flex;align-items:center;gap:14px;font-size:24px;color:var(--text-2);white-space:nowrap">
        <span style="color:#7aa7e0">${ICON.folder({ size: 26 })}</span><span class="mono" style="color:var(--text);font-size:25px">sql/</span>
        <span style="color:var(--text-3)">·</span><span style="color:var(--green)">versioned in Git · 2 commits this week</span></div>`;
      files.forEach((f, i) => {
        const hot = f.hot ? hotP : 0;
        rb += `<div class="abs" style="left:0;right:0;top:${62 + i * 70}px;height:70px;display:flex;align-items:center;gap:18px;padding:0 30px;border-top:1px solid var(--row-line);background:rgba(56,48,28,${hot.toFixed(3)});white-space:nowrap;${appear(t, codeAt + 0.15 + i * 0.12, { dy: 8 })}">
          <span style="color:#78c0f4">${ICON.file({ size: 26 })}</span>
          <span class="mono" style="font-size:25px;width:220px;color:var(--text)">${f.name}</span>
          <span style="flex:1;font-size:23px;color:${hot > 0.5 ? 'var(--amber)' : 'var(--text-2)'};overflow:hidden;text-overflow:ellipsis">${f.msg}</span>
          <span style="font-size:22px;color:var(--text-3)">${f.when}</span></div>`;
      });
      if (t >= aiAt - 0.1) {
        const found = t >= aiAt + 0.5;
        rb += `<div class="abs" style="left:0;right:0;top:${62 + 2 * 70}px;height:78px;display:flex;align-items:center;gap:16px;padding:0 30px;border-top:1px solid var(--row-line);background:#16171b;white-space:nowrap;${appear(t, aiAt - 0.1, { dy: 8 })}">
          <span style="color:var(--claude)">${ICON.claude({ size: 26 })}</span><span style="font-size:24px;font-weight:600">Your AI</span>
          <span class="mono" style="font-size:22px;color:var(--text-2)">looking for the design…</span><span style="flex:1"></span>
          ${found ? `<span class="pill" style="font-size:22px;background:#3d3113;color:var(--amber);padding:5px 16px;${appear(t, aiAt + 0.5, { dy: 0, dx: 10 })}">${ICON.warn({ size: 20 })}no data model here</span>` : ''}</div>`;
      }
      html += card({
        x: X, y: BOT.y, w: W, h: BOT.h, dots: true,
        tabs: [{ label: R.repo, on: true, icon: `<span style="color:var(--text-2)">${ICON.folder({ size: 22 })}</span>` }],
        crumb: 'your repo', body: rb, style: appear(t, codeAt, { dy: 30, dur: 0.4 }),
      });

      // The link between them: a context switch on "switching context", then it snaps on "drifts".
      const ax = 540, y0 = TOP.y + TOP.h + 8, y1 = BOT.y - 10, mid = (y0 + y1) / 2;
      const grow = easeOut(seg(t, codeAt + 0.2, codeAt + 0.6));
      const colour = brk > 0 ? 'var(--amber)' : '#8b9099';
      const g = 14 * brk;
      const line = brk <= 0
        ? `<path d="M${ax} ${y0} V${y0 + (y1 - y0) * grow}" stroke="${colour}" stroke-width="4" fill="none" stroke-dasharray="7 6"/>`
        : `<path d="M${ax} ${y0} V${mid - g}" stroke="${colour}" stroke-width="4" stroke-dasharray="7 6" fill="none"/><path d="M${ax} ${mid + g} V${y1}" stroke="${colour}" stroke-width="4" stroke-dasharray="7 6" fill="none"/>`;
      html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1">${line}</svg>`;
      if (t >= ctxAt && t < driftAt + 0.3) {
        html += `<div class="abs" style="left:${ax + 34}px;top:${mid - 24}px;${appearFade(t, ctxAt, 1 - seg(t, driftAt, driftAt + 0.3), { dy: 0, dx: -10 })}"><span class="pill" style="font-size:25px;padding:6px 18px;gap:10px;background:#1c1e23;border:2px solid #4a4e57;color:var(--text)"><svg class="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4"/></svg>switching context</span></div>`;
      }
      if (brk > 0) {
        html += `<div class="abs" style="left:${ax - 17}px;top:${mid - 17}px;width:34px;height:34px;border-radius:50%;background:#3d3113;color:var(--amber);display:flex;align-items:center;justify-content:center;opacity:${brk.toFixed(3)}">${ICON.x({ size: 18 })}</div>`;
        html += `<div class="abs" style="left:${ax + 34}px;top:${mid - 22}px;${appear(t, driftAt + 0.3, { dy: 0, dx: -10 })}"><span class="pill" style="font-size:25px;padding:6px 18px;background:#3d3113;color:var(--amber)">drifts from the code</span></div>`;
      }
      // The pointer hopping: repo → tool → repo → tool, then away.
      if (t >= ctxAt - 0.3 && t < driftAt + 0.4) {
        const pts = [{ t: ctxAt - 0.3, ...repoTab }, { t: ctxAt + 0.25, ...toolTab }, { t: ctxAt + 0.7, ...repoTab }, { t: ctxAt + 1.15, ...toolTab }, { t: driftAt + 0.4, x: toolTab.x + 200, y: toolTab.y + 160 }];
        const pt = path(t, pts);
        const tap = (at) => (t >= at && t < at + 0.3 ? seg(t, at, at + 0.3) : 0);
        const op = Math.min(seg(t, ctxAt - 0.3, ctxAt - 0.1), 1 - seg(t, driftAt, driftAt + 0.4));
        html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, Math.max(tap(ctxAt + 0.25), tap(ctxAt + 0.7), tap(ctxAt + 1.15)))}</div>`;
      }
    }
    return html;
  },
};
