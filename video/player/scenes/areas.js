// 7 · Choosing a business area (the skill's Stage 3a): the assistant lists what it found and
// proposes ONE concrete default the user accepts with "yes" — a first run works best with one
// domain. The area is chosen here but not written yet: the domain file is written after the
// modelling-style step (Stage 4), so this scene only names it.
import { appear, card, edge, ICON, seg, COLORS } from '../lib.js';

const Y = 322, H = 600;
const LX = 96, LW = 930, RX = LX + LW + 36, RW = 1824 - RX;

export default {
  render(t, { beats }) {
    const asks = beats.asks.t, dom = beats.domain.t;
    const yesAt = asks + 1.4, pickAt = asks + 1.9;
    let html = card({ x: LX, y: Y, w: LW, h: H, tabs: [{ label: 'Claude Code', on: true, icon: `<span style="color:var(--claude)">${ICON.claude({ size: 20 })}</span>` }], style: appear(t, 0) });
    // The proposal, worded the way SKILL.md Stage 3a words it.
    html += `<div class="abs" style="left:${LX + 44}px;top:${Y + 64 + 34}px;display:flex;gap:16px;font-size:27px;line-height:1.4;white-space:nowrap;${appear(t, 0.35)}"><span class="dot" style="margin-top:12px"></span>
      <div>I found <b>42 models</b> in 3 folders.<br><span style="color:var(--text-2)">Let's start with <b style="color:var(--text)">orders</b> (12 models) in the gold layer. OK?</span></div></div>`;
    // The user's answer.
    html += `<div class="abs" style="right:${1920 - (LX + LW - 44)}px;top:${Y + 64 + 128}px;height:54px;display:flex;align-items:center;padding:0 26px;border-radius:14px;background:#1b2a40;border:1px solid #2f4f7a;font-size:25px;color:#e6f0ff;${appear(t, yesAt, { dy: 8, dur: 0.25 })}">yes</div>`;
    // The chosen area.
    const checked = t >= pickAt;
    const pop = seg(t, pickAt, pickAt + 0.15);
    html += `<div class="abs" style="left:${LX + 44}px;top:${Y + 64 + 214}px;width:${LW - 88}px;height:64px;border-radius:12px;background:${checked ? '#1b2a40' : 'var(--card-inner)'};border:1px solid ${checked ? '#2f4f7a' : 'var(--card-border)'};display:flex;align-items:center;gap:18px;padding:0 22px;${appear(t, 0.9, { dy: 8 })}">
      <span class="chk${checked ? ' chk--on' : ''}" style="transform:scale(${(1 + 0.15 * Math.sin(pop * Math.PI)).toFixed(3)})">${checked ? ICON.check({ size: 20, sw: 3.4 }) : ''}</span>
      <span style="font-size:27px;font-weight:600;flex:1">Orders</span><span style="font-size:22px;color:var(--text-2)">12 models</span></div>`;
    html += `<div class="abs" style="left:${LX + 44}px;top:${Y + 64 + 298}px;font-size:22px;color:var(--text-3);white-space:nowrap;${appear(t, 1.15, { dy: 6 })}">Or name another: customers (8), finance (22)</div>`;
    // Chosen, not yet written: the file comes after the modelling-style step.
    html += `<div class="abs" style="left:${LX + 44}px;top:${Y + 64 + 392}px;display:flex;align-items:center;gap:14px;font-size:25px;white-space:nowrap;${appear(t, dom + 0.2)}">
        <span class="tick tick--ok" style="width:30px;height:30px">${ICON.check({ size: 18 })}</span>Domain: <b class="mono" style="color:var(--blue)">orders</b><span style="color:var(--text-2)">· gold layer</span></div>`;

    // Right: what the domain will hold, as a focused diagram (a preview: nothing is written yet).
    const dA = dom + 0.5;
    const showDomain = t >= dA;
    html += card({ x: RX, y: Y, w: RW, h: H, tabs: [{ label: showDomain ? 'orders' : 'my_dbt_project', on: true }], crumb: showDomain ? 'domain · gold layer' : 'models/', bodyCls: showDomain ? 'grid-bg' : '', style: appear(t, 0.2) });
    // Before the domain exists: the folders Claude found, which the choices map onto.
    const out = 1 - seg(t, dA - 0.3, dA);
    if (out > 0) {
      [['customers', 8, null], ['orders', 12, pickAt], ['finance', 22, null]].forEach(([f, n, pick], i) => {
        const picked = pick !== null && t >= pick;
        html += `<div class="abs" style="left:${RX + 34}px;top:${Y + 64 + 40 + i * 92}px;width:${RW - 68}px;height:74px;border-radius:12px;background:${picked ? '#1b2a40' : 'var(--card-inner)'};border:1px solid ${picked ? '#2f4f7a' : 'var(--card-border)'};display:flex;align-items:center;gap:16px;padding:0 22px;${appear(t, 0.5 + i * 0.2, { dy: 8 })}${out < 1 ? `opacity:${out.toFixed(3)};` : ''}">
          <span style="color:${picked ? 'var(--blue)' : '#7f8792'}">${ICON.folder({ size: 28 })}</span><span class="mono" style="font-size:24px;flex:1">models/${f}/</span>
          <span style="display:flex;gap:6px">${Array.from({ length: Math.min(n, 8) }, () => `<span style="width:12px;height:16px;border-radius:3px;background:${picked ? '#3b6aa8' : '#353841'}"></span>`).join('')}</span></div>`;
      });
    }
    const mini = (x, y, name, colour, at) => `<div class="abs" style="left:${x}px;top:${y}px;width:230px;border:3px solid ${colour};border-radius:12px;background:#17181c;overflow:hidden;${appear(t, at, { dy: 10 })}">
        <div style="padding:12px 16px;font-size:22px;font-weight:700;border-bottom:1px solid var(--row-line)">${name}</div>
        <div style="padding:10px 16px;display:flex;flex-direction:column;gap:9px">${[70, 110, 90].map((w) => `<span style="height:9px;width:${w}px;border-radius:5px;background:#2e3139"></span>`).join('')}</div></div>`;
    const bx = RX + 34, by = Y + 64 + 40;
    const nodes = [[bx, by, 'dim_customer'], [bx + 460, by, 'dim_product'], [bx + 230, by + 250, 'fct_order']];
    const eP = seg(t, dA + 1.1, dA + 1.6);
    html += edge([[bx + 115, by + 118], [bx + 115, by + 330], [bx + 230, by + 330]], { progress: eP, width: 3 });
    html += edge([[bx + 575, by + 118], [bx + 575, by + 330], [bx + 460, by + 330]], { progress: eP, width: 3 });
    nodes.forEach(([x, y, n], i) => { html += mini(x, y, n, COLORS.logical, dA + 0.3 + i * 0.2); });
    html += `<div class="abs" style="left:${RX + 34}px;top:${Y + H - 70}px;font-size:21px;color:var(--text-2);white-space:nowrap;${appear(t, dA + 1.5)}">A domain is a focused diagram of related tables.</div>`;
    return html;
  },
};
