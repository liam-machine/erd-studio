// 5 · Claude checks the dbt setup: a checklist lands line by line; the manifest and catalog each
// get an explainer card on their beat.
import { appear, card, esc, ICON, seg, tick } from '../lib.js';

const Y = 322, H = 600;
const LX = 96, LW = 1000, RX = LX + LW + 36, RW = 1824 - (LX + LW + 36);
const ROW0 = Y + 64 + 128, PITCH = 76;

function row(i, t, at, doneAt, label, detail) {
  if (t < at) return '';
  const done = t >= doneAt;
  return `<div class="abs" style="left:${LX + 44}px;top:${ROW0 + i * PITCH}px;display:flex;align-items:center;gap:18px;font-size:27px;white-space:nowrap;${appear(t, at, { dy: 0, dx: -12 })}">
    ${tick(done ? 'ok' : 'wait', t)}<span style="font-weight:600">${label}</span>${detail ? `<span style="color:var(--text-2);display:flex;align-items:center;gap:10px">${detail}</span>` : ''}</div>`;
}

export default {
  render(t, { beats }) {
    const c0 = beats.checks.t;
    const parse = beats.parse.t, cat = beats.catalog.t;
    const arrow = ICON.arrow({ size: 22 });

    let html = card({ x: LX, y: Y, w: LW, h: H, tabs: [{ label: 'Claude Code', on: true, icon: `<span style="color:var(--claude)">${ICON.claude({ size: 20 })}</span>` }], style: appear(t, 0) });
    html += `<div class="abs" style="left:${LX + 44}px;top:${Y + 64 + 30}px;display:flex;align-items:center;gap:16px;font-size:26px;white-space:nowrap;${appear(t, c0)}"><span class="dot"></span>Checking your dbt setup</div>
      <div class="abs tool" style="left:${LX + 74}px;top:${Y + 64 + 72}px;${appear(t, c0 + 0.3)}">Bash(erd-studio doctor --json)</div>`;
    html += row(0, t, c0 + 0.8, c0 + 1.25, 'dbt Core 1.9', 'found in .venv');
    html += row(1, t, c0 + 1.35, c0 + 1.8, 'profiles.yml', 'found');
    html += row(2, t, parse + 0.15, parse + 1.3, '<span class="mono" style="font-size:25px">dbt parse</span>', `${arrow}<span class="mono" style="font-size:23px">target/manifest.json</span>`);
    html += row(3, t, cat + 0.15, cat + 1.9, '<span class="mono" style="font-size:25px">dbt docs generate</span>', `${arrow}<span class="mono" style="font-size:23px">target/catalog.json</span>`);

    // Explainer cards
    const mA = parse + 0.6;
    const chips = ['dim_customer', 'fct_order', 'dim_product', 'stg_orders', 'stg_customers'];
    html += `<div class="card" style="left:${RX}px;top:${Y}px;width:${RW}px;height:282px;padding:30px 34px;${appear(t, mA)}">
      <div style="display:flex;align-items:center;gap:14px;font:600 24px var(--mono);color:var(--syn-val)">${ICON.file({ size: 26 })}manifest.json</div>
      <div style="margin-top:12px;font-size:26px;font-weight:700">A map of every model</div>
      <div style="margin-top:22px;display:flex;flex-wrap:wrap;gap:10px">${chips.map((c, i) => `<span class="pill" style="background:#23262e;color:#cfd3da;font:500 19px var(--mono);padding:6px 14px;${appear(t, mA + 0.25 + i * 0.1, { dy: 6 })}">${c}</span>`).join('')}
        <span class="pill" style="background:none;color:var(--text-3);font-size:19px;${appear(t, mA + 0.8, { dy: 6 })}">+ 37 more</span></div></div>`;

    const cA = cat + 0.9;
    const types = [['order_total', 'DECIMAL(18,2)'], ['order_date', 'DATE'], ['customer_key', 'INTEGER']];
    html += `<div class="card" style="left:${RX}px;top:${Y + 318}px;width:${RW}px;height:282px;padding:30px 34px;${appear(t, cA)}">
      <div style="display:flex;align-items:center;gap:14px;font:600 24px var(--mono);color:var(--syn-val)">${ICON.file({ size: 26 })}catalog.json</div>
      <div style="margin-top:12px;font-size:26px;font-weight:700">Real column types from your warehouse</div>
      <div style="margin-top:16px">${types.map(([c, ty], i) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--row-line);font-size:21px;${appear(t, cA + 0.25 + i * 0.12, { dy: 6 })}"><span>${c}</span><span class="mono" style="color:var(--type)">${esc(ty)}</span></div>`).join('')}</div></div>`;
    return html;
  },
};
