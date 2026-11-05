// readme · 1 · hook — "Where does your data model live?" Frame 0 is finished (the first scene
// never fades in): the logical diagram dim_customer ← fct_order, drawn the way the canvas draws
// it. On `design` the four things a logical model holds light up one by one on their words
// (tables, grain, keys, joins). On `apart` the diagram is packed off into a separate,
// light-themed browser tool at the top; the repo with the code arrives below it, the link
// between the two snaps on "drifts", and on "your AI can't see it" the assistant in the repo
// finds no data model.
import { appear, card, COLORS, easeInOut, easeOut, edge, ICON, lerp, node, rowY, seg } from '../../lib.js';
import { R, wordAt } from './story.js';

const X = 64, W = 952;
// Phase A: the diagram, centred in the stage.
const NY = 450;
const DX = 84, DW = 360;
const FX = 524, FW = 472;
const MIDX = (DX + DW + FX) / 2;
const PILLS_Y = 850;
// Phase B: the tool (top) and the repo (bottom).
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

export default {
  render(t, { beats, scene }) {
    const A = beats.apart.t;
    // ---- `design`: tables, grain, keys, joins ----
    const lit = [
      wordAt(scene, 'design', 'tables'), wordAt(scene, 'design', 'grain'),
      wordAt(scene, 'design', 'keys'), wordAt(scene, 'design', 'joins'),
    ];
    const on = lit.map((at) => easeOut(seg(t, at, at + 0.3)));
    // ---- `apart` ----
    const toolAt = wordAt(scene, 'apart', 'separate') - 0.15;
    const driftAt = wordAt(scene, 'apart', 'drifts');
    const aiAt = wordAt(scene, 'apart', 'AI');
    const away = easeInOut(seg(t, toolAt - 0.1, toolAt + 0.45));

    let html = '';

    // ================= phase A: the logical diagram =================
    if (away < 1) {
      const op = 1 - away;
      const sc = lerp(1, 0.82, away);
      let d = '';
      const sy = NY + rowY(0), fy = NY + rowY(1);
      d += edge([[DX + DW, sy], [MIDX, sy], [MIDX, fy], [FX, fy]], { color: COLORS.logical, width: 3 + 2 * on[3], one: [DX + DW + 8, sy - 10], many: [FX - 22, fy - 8] });
      if (on[3] > 0) d += `<svg class="abs" style="left:0;top:0;overflow:visible;opacity:${(0.5 * on[3]).toFixed(3)}" width="1" height="1"><path d="M${DX + DW} ${sy} H${MIDX} V${fy} H${FX}" fill="none" stroke="#60a5fa" stroke-width="14" stroke-linejoin="round" style="filter:blur(6px)"/></svg>`;
      const keyGlow = on[2];
      const cols = (cs) => cs.map((c) => (c.key && keyGlow > 0 ? { ...c, rowStyle: `background:rgba(244,180,44,${(0.16 * keyGlow).toFixed(3)})` } : c));
      const headGlow = (p) => (p > 0 ? `box-shadow:0 0 0 ${(6 * p).toFixed(1)}px rgba(96,165,250,${(0.35 * p).toFixed(3)}),0 18px 44px #0009;` : '');
      d += node({ x: DX, y: NY, w: DW, name: R.dim_customer.name, layer: R.badge, grain: R.dim_customer.grain, cols: cols(R.dim_customer.cols), style: headGlow(on[0]) });
      d += node({ x: FX, y: NY, w: FW, name: R.fct_order.name, layer: R.badge, grain: R.fct_order.grain, cols: cols(R.fct_order.cols), style: headGlow(on[0]) });
      // Grain rows glow green.
      if (on[1] > 0) {
        [[DX, DW], [FX, FW]].forEach(([x, w]) => {
          d += `<div class="abs" style="left:${x + 3}px;top:${NY + 62 + 3}px;width:${w - 6}px;height:40px;background:rgba(34,197,94,${(0.16 * on[1]).toFixed(3)});box-shadow:inset 5px 0 0 rgba(34,197,94,${on[1].toFixed(3)})"></div>`;
        });
      }
      // The four pills under the diagram.
      const P = [['Tables', '96,165,250'], ['Grain', '34,197,94'], ['Keys', '244,180,44'], ['Joins', '96,165,250']];
      d += `<div class="abs" style="left:${X}px;width:${W}px;top:${PILLS_Y}px;display:flex;justify-content:center;gap:18px">${P.map(([label, rgb], i) => {
        const p = on[i];
        return `<span class="pill" style="font-size:30px;padding:12px 28px;background:rgba(${rgb},${(0.06 + 0.12 * p).toFixed(3)});border:2px solid rgba(${rgb},${(0.25 + 0.7 * p).toFixed(3)});color:${p > 0.5 ? `rgb(${rgb})` : 'var(--text-3)'};transform:scale(${(1 + 0.08 * Math.sin(Math.PI * seg(t, lit[i], lit[i] + 0.35))).toFixed(3)})">${p > 0.5 ? ICON.check({ size: 24 }) : ''}${label}</span>`;
      }).join('')}</div>`;
      html += `<div class="abs" style="left:0;top:0;width:1080px;height:1350px;opacity:${op.toFixed(3)};transform:scale(${sc.toFixed(4)});transform-origin:540px 300px">${d}</div>`;
    }

    // ================= phase B: a separate tool, the repo below =================
    if (t >= toolAt - 0.1) {
      const brk = easeOut(seg(t, driftAt + 0.2, driftAt + 0.6));
      const hotP = seg(t, driftAt, driftAt + 0.4);
      const dc = R.dim_customer.cols.slice(0, 2).map(({ key, name }) => ({ key, name }));
      const fo = R.fct_order.cols.map(({ key, name }) => ({ key, name }));
      const DCX = 30, FOX = 360, BY = 24;
      const conn = `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><path d="M${DCX + 270} ${BY + HEAD + ROW * 0.5} H${FOX - 22} V${BY + HEAD + ROW * 1.5} H${FOX}" fill="none" stroke="#9aa3ae" stroke-width="2.5"/></svg>`;
      const body = `<div class="abs" style="inset:0;background:#f4f6f9;background-image:radial-gradient(#d7dce3 1.2px, transparent 1.3px);background-size:24px 24px;opacity:${(1 - 0.3 * brk).toFixed(3)}">
        ${conn}${box({ x: DCX, y: BY, w: 270, name: 'dim_customer', cols: dc })}${box({ x: FOX, y: BY, w: 360, name: 'fct_order', cols: fo, hot: 2, hotP })}</div>`;
      html += card({
        x: X, y: TOP.y, w: W, h: TOP.h, dots: true,
        tabs: [{ label: 'modeller.app', on: true, icon: `<span style="color:var(--text-2)">${ICON.globe({ size: 22 })}</span>` }],
        crumb: 'a separate tool', body, style: appear(t, toolAt, { dy: -30, dur: 0.45 }),
      });
      if (t >= driftAt) {
        html += `<div class="abs" style="right:${1080 - X - W + 18}px;top:${TOP.y + 13}px;${appear(t, driftAt, { dy: 6 })}">
          <span class="pill" style="font-size:23px;background:#3d3113;color:var(--amber);padding:6px 16px">${ICON.warn({ size: 22 })}Last updated 14 months ago</span></div>`;
      }

      // The repo, with the code and the AI assistant.
      const repoAt = toolAt + 0.35;
      if (t >= repoAt) {
        const files = [
          { name: 'customers.sql', msg: 'add email column', when: '3 days ago' },
          { name: 'orders.sql', msg: `change ${R.drift.typeCol} to ${R.drift.typePhysical}`, when: '2 hours ago', hot: true },
        ];
        let rb = `<div class="abs" style="left:30px;top:14px;display:flex;align-items:center;gap:14px;font-size:24px;color:var(--text-2);white-space:nowrap">
          <span style="color:#7aa7e0">${ICON.folder({ size: 26 })}</span><span class="mono" style="color:var(--text);font-size:25px">sql/</span>
          <span style="color:var(--text-3)">·</span><span style="color:var(--green)">2 commits this week</span></div>`;
        files.forEach((f, i) => {
          const hot = f.hot ? hotP : 0;
          rb += `<div class="abs" style="left:0;right:0;top:${62 + i * 70}px;height:70px;display:flex;align-items:center;gap:18px;padding:0 30px;border-top:1px solid var(--row-line);background:rgba(56,48,28,${hot.toFixed(3)});white-space:nowrap;${appear(t, repoAt + 0.15 + i * 0.12, { dy: 8 })}">
            <span style="color:${'#78c0f4'}">${ICON.file({ size: 26 })}</span>
            <span class="mono" style="font-size:25px;width:220px;color:var(--text)">${f.name}</span>
            <span style="flex:1;font-size:23px;color:${hot > 0.5 ? 'var(--amber)' : 'var(--text-2)'};overflow:hidden;text-overflow:ellipsis">${f.msg}</span>
            <span style="font-size:22px;color:var(--text-3)">${f.when}</span></div>`;
        });
        // The assistant: looks for the design, finds none.
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
          crumb: 'your repo', body: rb, style: appear(t, repoAt, { dy: 30, dur: 0.4 }),
        });

        // The link between them, which snaps on "drifts".
        const ax = 540, y0 = TOP.y + TOP.h + 8, y1 = BOT.y - 10, mid = (y0 + y1) / 2;
        const grow = easeOut(seg(t, repoAt + 0.2, repoAt + 0.6));
        const colour = brk > 0 ? 'var(--amber)' : '#8b9099';
        const g = 14 * brk;
        const line = brk <= 0
          ? `<path d="M${ax} ${y0} V${y0 + (y1 - y0) * grow}" stroke="${colour}" stroke-width="4" fill="none" stroke-dasharray="7 6"/>`
          : `<path d="M${ax} ${y0} V${mid - g}" stroke="${colour}" stroke-width="4" stroke-dasharray="7 6" fill="none"/><path d="M${ax} ${mid + g} V${y1}" stroke="${colour}" stroke-width="4" stroke-dasharray="7 6" fill="none"/>`;
        html += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1">${line}</svg>`;
        if (brk > 0) {
          html += `<div class="abs" style="left:${ax - 17}px;top:${mid - 17}px;width:34px;height:34px;border-radius:50%;background:#3d3113;color:var(--amber);display:flex;align-items:center;justify-content:center;opacity:${brk.toFixed(3)}">${ICON.x({ size: 18 })}</div>`;
          html += `<div class="abs" style="left:${ax + 34}px;top:${mid - 22}px;${appear(t, driftAt + 0.3, { dy: 0, dx: -10 })}"><span class="pill" style="font-size:25px;padding:6px 18px;background:#3d3113;color:var(--amber)">drifts from the code</span></div>`;
        }
      }
    }
    return html;
  },
};
