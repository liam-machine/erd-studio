// 8 · Claude writes the logical model: dim_customer.yml types in line by line (real v5 model
// shape), then the tab flips to the domain file that references it; the files it created
// tick in on the right.
import { appear, card, esc, ICON, seg, yamlLine } from '../lib.js';

const Y = 322, H = 600;
const LX = 96, LW = 1150, RX = LX + LW + 36, RW = 1824 - RX;
const CODE_X = LX + 30, CODE_Y = Y + 64 + 58, PITCH = 38;

// Real v5 model shape (compare test/fixtures/dbt-project/.erd-studio/logical-models/dim_customer.yml).
// The lines the modelling style sets — role, grain, rationale, the surrogate/natural keys and
// SCD history — are marked with `style: true` and get a blue gutter as they land.
const YML = [
  ['name: dim_customer'],
  ['modelRole: conformed-dim', true],
  ['grain: One row per customer', true],
  ['rationale:', true],
  ['  design: Kimball conformed dim; history from customers snapshot', true],
  ['columns:'],
  ['  - name: customer_key'],
  ['    isPrimaryKey: true', true],
  ['  - name: customer_id'],
  ['    isNaturalKey: true', true],
  ['  - name: customer_name'],
  ['    scdType: 2', true], // dbt keeps this history (a snapshot); the skill writes 2 only when it does
];
const PK_LINE = 7;
const JSON_LINES = [
  ['{', ''],
  ['  ', '"schemaVersion": 5,'],
  ['  ', '"domain": "orders",'],
  ['  ', '"layer": "gold",'],
  ['  ', '"logical": {'],
  ['    ', '"models": ["dim_customer", "fct_order"],'],
  ['    ', '"relationships": [{'],
  ['      ', '"fromModel": "fct_order", "fromColumn": "customer_key",'],
  ['      ', '"toModel": "dim_customer", "toColumn": "customer_key",'],
  ['      ', '"cardinality": "many-to-one"'],
  ['    ', '}]'],
];
const jsonLine = ([ind, s]) => ind + esc(s)
  .replace(/(&quot;|")([\w-]+)"(?=:)/g, '<span class="k">"$2"</span>')
  .replace(/: ("[^"]*")/g, ': <span class="s">$1</span>')
  .replace(/(\["[^\]]*\])/g, '<span class="s">$1</span>')
  .replace(/: (\d+)/g, ': <span class="kw">$1</span>');

export default {
  render(t, { beats }) {
    const w0 = beats.writes.t + 0.4, flip = beats.details.t + 2.3;
    const showJson = t >= flip;
    const tabs = [
      { label: 'dim_customer.yml', on: !showJson, icon: `<span style="color:#c9a24b">${ICON.file({ size: 20 })}</span>` },
      { label: 'fct_order.yml' },
      { label: 'orders.json', on: showJson, icon: showJson ? `<span style="color:var(--syn-val)">${ICON.file({ size: 20 })}</span>` : '' },
    ];
    let html = card({ x: LX, y: Y, w: LW, h: H, tabs, style: appear(t, 0) });
    html += `<div class="abs" style="left:${LX + 30}px;top:${Y + 64 + 16}px;font-size:19px;color:var(--text-3);white-space:nowrap">${showJson ? '.erd-studio › gold › orders.json' : '.erd-studio › logical-models › dim_customer.yml'}</div>`;

    const lines = showJson ? JSON_LINES.map(jsonLine) : YML.map(([l]) => yamlLine(l));
    const per = showJson ? 0.07 : 0.2;
    const start = showJson ? flip + 0.05 : w0;
    let code = '';
    lines.forEach((ln, i) => {
      const at = start + i * per;
      if (t < at) return;
      code += `<div class="code__ln" style="top:${i * PITCH}px">${i + 1}</div><div class="code__tx" style="top:${i * PITCH}px;${appear(t, at, { dur: 0.18, dy: 0, dx: -6 })}">${ln}</div>`;
    });
    // The lines the modelling style set get a blue gutter as they land; the PK line an amber one.
    if (!showJson) {
      YML.forEach(([, styled], i) => {
        const at = start + i * per;
        if (!styled || t < at) return;
        const rgb = i === PK_LINE ? '244,180,44' : '92,162,248';
        const glow = 1 - seg(t, at + 0.8, at + 2.2) * 0.55;
        code = `<div class="abs" style="left:-24px;width:${LW - 8}px;top:${i * PITCH}px;height:${PITCH}px;background:rgba(${rgb},${(0.1 * glow).toFixed(3)});border-left:4px solid rgba(${rgb},${glow.toFixed(2)})"></div>` + code;
      });
    }
    html += `<div class="code" style="left:${CODE_X}px;top:${CODE_Y}px;width:${LW - 60}px;font-size:25px;line-height:${PITCH}px">${code}</div>`;

    // Right: files created, and what each model file holds.
    html += card({ x: RX, y: Y, w: RW, h: H, tabs: [{ label: 'Files written', on: true }], style: appear(t, 0.1) });
    const files = [
      ['logical-models/', null, 0], ['dim_customer.yml', '#c9a24b', w0 + 0.3], ['fct_order.yml', '#c9a24b', w0 + 1.6],
      ['gold/', null, 0], ['orders.json', 'var(--syn-val)', flip - 0.2],
    ];
    files.forEach(([name, col, at], i) => {
      const y = Y + 64 + 34 + i * 58;
      const dir = col === null;
      html += `<div class="abs" style="left:${RX + 34 + (dir ? 0 : 34)}px;top:${y}px;width:${RW - 68 - (dir ? 0 : 34)}px;display:flex;align-items:center;gap:12px;font-size:23px;white-space:nowrap;${dir ? appear(t, 0.3) : appear(t, at, { dy: 0, dx: -10 })}">
        <span style="color:${dir ? '#7f8792' : col}">${dir ? ICON.folder({ size: 24 }) : ICON.file({ size: 22 })}</span><span class="${dir ? '' : 'mono'}" style="flex:1;${dir ? 'color:var(--text-2)' : 'font-size:22px'}">${name}</span>
        ${dir ? '' : `<span class="pill" style="background:#13301f;color:var(--green);font-size:17px;padding:4px 12px">${ICON.plus({ size: 14 })}new</span>`}</div>`;
    });
    const tags = ['columns', 'data types', 'keys', 'grain & role', 'SCD history'];
    html += `<div class="abs" style="left:${RX + 34}px;top:${Y + 64 + 350}px;font-size:20px;color:var(--text-2);${appear(t, beats.details.t)}">Each model file holds</div>`;
    html += `<div class="abs" style="left:${RX + 34}px;top:${Y + 64 + 392}px;width:${RW - 68}px;display:flex;flex-wrap:wrap;gap:14px 12px">${tags.map((g, i) =>
      `<span class="pill" style="background:#1b2a40;color:#cfe3ff;font-size:21px;${appear(t, beats.details.t + 0.35 + i * 0.3, { dy: 8 })}">${ICON.check({ size: 18 })}${g}</span>`).join('')}</div>`;
    return html;
  },
};
