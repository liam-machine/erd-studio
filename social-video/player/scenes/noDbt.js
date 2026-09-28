// 11 · No dbt: two rows. "With dbt" lights all three stages (Logical, Physical, Diff).
// "Without dbt" lights Logical only — the hero lands on "logical model today" — with Physical
// and Diff dimmed. On `more` a dashed "+ more tools" chip appears and the dimmed tags read
// "coming". No future tool is named.
import { appear, easeOut, ICON, seg } from '../lib.js';

const X = 64, W = 952;
const ROW_H = 240;
const A_Y = 350, B_Y = A_Y + ROW_H + 36;               // rows: 350..590, 626..866
const CHIP_GAP = 20, PAD = 30;
const CHIP_W = (W - 2 * PAD - 2 * CHIP_GAP) / 3, CHIP_H = 96;
const STAGES = [
  { label: 'Logical', color: 'var(--logical)', bg: '#16243a', border: '#2c4f7c' },
  { label: 'Physical', color: 'var(--green)', bg: '#13301f', border: '#1f6b3a' },
  { label: 'Diff', color: 'var(--amber)', bg: '#33291a', border: '#6b5320' },
];

/** One stage chip. `lit` 0..1 fades in its colour and tick; `dim` draws it as unavailable. */
function chip(x, y, s, { lit = 1, dim = false, tag = '', tagOp = 0, glow = 0, style = '' }) {
  if (dim) {
    return `<div class="abs" style="left:${x}px;top:${y}px;width:${CHIP_W}px;height:${CHIP_H}px;border-radius:16px;border:2px dashed #3a3d45;background:#16171b;display:flex;align-items:center;gap:14px;padding:0 22px;white-space:nowrap;${style}">
      <span style="width:30px;height:30px;border-radius:50%;border:2px solid #3f424a;flex:none"></span>
      <span style="display:flex;flex-direction:column;line-height:1.1"><span style="font-size:28px;font-weight:700;color:var(--text-3)">${s.label}</span>
      <span style="position:relative;height:29px;margin-top:2px">${tag}</span></span></div>`;
  }
  const p = lit;
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${CHIP_W}px;height:${CHIP_H}px;border-radius:16px;border:2px solid ${p > 0.5 ? s.border : '#34363d'};background:${p > 0.5 ? s.bg : '#1c1e23'};display:flex;align-items:center;gap:14px;padding:0 22px;white-space:nowrap;box-shadow:0 0 ${Math.round(40 * glow)}px ${s.border};${style}">
    <span style="width:32px;height:32px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;background:${s.color};color:#0d1117;opacity:${p.toFixed(3)};transform:scale(${(0.6 + 0.4 * easeOut(p)).toFixed(3)})">${ICON.check({ size: 22, sw: 3.4 })}</span>
    <span style="font-size:28px;font-weight:700;color:${p > 0.5 ? 'var(--text)' : 'var(--text-2)'}">${s.label}</span></div>`;
}

function rowCard(y, title, sub, style) {
  return `<div class="abs" style="left:${X}px;top:${y}px;width:${W}px;height:${ROW_H}px;border-radius:20px;background:var(--card);border:1px solid var(--card-border);box-shadow:0 24px 60px #0009;${style}">
    <div class="abs" style="left:${PAD}px;top:26px;display:flex;align-items:baseline;gap:16px;white-space:nowrap">
      <span style="font-size:36px;font-weight:800;letter-spacing:-.015em">${title}</span>
      <span style="font-size:24px;color:var(--text-2)">${sub}</span></div></div>`;
}

export default {
  render(t, { beats }) {
    const dbt = beats.dbt.t, more = beats.more.t;
    const aAt = 0.05;                 // "Not on dbt?" — the with-dbt row is the baseline
    const bAt = dbt + 0.95;           // "Use it for your…"
    const heroAt = dbt + 1.95;        // "…logical model today."
    const moreAt = more + 0.15;       // "Support for more tools…"
    const chipsY = (y) => y + 112;
    const cx = (i) => X + PAD + i * (CHIP_W + CHIP_GAP);

    let html = rowCard(A_Y, 'With dbt', 'the full workflow', appear(t, aAt));
    STAGES.forEach((s, i) => {
      const at = aAt + 0.3 + i * 0.15;
      html += chip(cx(i), chipsY(A_Y), s, { lit: seg(t, at, at + 0.3), style: appear(t, aAt + 0.1 + i * 0.08, { dy: 8 }) });
    });

    // Without dbt: Logical lights on the hero beat; Physical and Diff stay dimmed.
    html += rowCard(B_Y, 'Without dbt', 'start today', appear(t, bAt));
    const hero = seg(t, heroAt, heroAt + 0.3);
    const glow = seg(t, heroAt, heroAt + 0.3) * (1 - 0.6 * seg(t, heroAt + 0.5, heroAt + 1.4));
    html += chip(cx(0), chipsY(B_Y), STAGES[0], { lit: hero, glow, style: appear(t, bAt + 0.1, { dy: 8 }) + `transform:scale(${(1 + 0.04 * Math.sin(Math.PI * seg(t, heroAt, heroAt + 0.45))).toFixed(4)});` });
    const tagOut = seg(t, moreAt + 0.3, moreAt + 0.45), tagOp = seg(t, moreAt + 0.45, moreAt + 0.7);
    [1, 2].forEach((i) => {
      const s = STAGES[i];
      const tagCss = 'left:0;top:0;font-size:24px;font-weight:600;white-space:nowrap;';
      const needs = `<span class="abs" style="${tagCss}color:var(--text-3);opacity:${(1 - tagOut).toFixed(3)}">needs dbt</span>`;
      const coming = `<span class="abs" style="${tagCss}color:#7fd6a0;opacity:${tagOp.toFixed(3)}">coming</span>`;
      html += chip(cx(i), chipsY(B_Y), s, { dim: true, tag: needs + coming, style: appear(t, bAt + 0.18 + i * 0.06, { dy: 8 }) });
    });

    // "+ more tools" chip
    if (t >= moreAt) {
      const w = 540, y = B_Y + ROW_H + 52;
      html += `<div class="abs" style="left:${540 - w / 2}px;top:${y}px;width:${w}px;height:96px;border-radius:20px;border:2.5px dashed #3f7d57;background:#12201a;display:flex;align-items:center;justify-content:center;gap:18px;white-space:nowrap;${appear(t, moreAt, { dy: 14 })}">
        <span style="width:44px;height:44px;border-radius:50%;background:#1a3a26;color:var(--green);display:flex;align-items:center;justify-content:center">${ICON.plus({ size: 26 })}</span>
        <span style="font-size:32px;font-weight:800;color:var(--text)">more tools</span>
        <span style="font-size:26px;color:var(--text-2)">on the way</span></div>`;
    }
    return html;
  },
};
