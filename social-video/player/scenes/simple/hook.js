// simple/1 · Hook. The feed thumbnail: fully drawn at t = 0. A friendly data map (customers,
// orders, payments as icon cards, joined by lines) with a big amber OUT OF DATE rubber stamp on
// it; its customers card still lists a fax number (lit amber) and the lines are broken amber dashes.
// On `fix` (+0.3) the stamp lifts off, the lines redraw solid blue and the wrong fields turn
// into green ticks: the map "heals". No pill: the caption carries the words.
import { COLORS, ICON, clamp, easeInOut, easeOut, edge, esc, mix, seg } from '../../lib.js';

// ---------- shared map geometry (simple/map uses the same layout) ----------
const CW = 380, HEAD = 96, ROW = 62;
const cardH = (n) => HEAD + n * ROW + 12;
const CARDS = {
  customers: { x: 64, y: 330, icon: 'person', title: 'customers', fields: [['name', 'Ana Silva'], ['email', 'ana@mail.com']] },
  orders: { x: 636, y: 470, icon: 'receipt', title: 'orders', fields: [['date', '12 March'], ['total', '$84.00']] },
  payments: { x: 64, y: 820, icon: 'card', title: 'payments', fields: [['amount', '$84.00'], ['paid on', '13 March']] },
};
// Lines: customers -> orders ("places"), payments -> orders ("pays for"), through the gap column.
const GX = 540;
const L1 = [[CARDS.customers.x + CW, 445], [GX, 445], [GX, 545], [CARDS.orders.x, 545]];
const L2 = [[CARDS.payments.x + CW, 935], [GX, 935], [GX, 640], [CARDS.orders.x, 640]];

const ic = (d, size = 34, sw = 2.2) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  person: ic('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4.3-7 8-7s7 2.5 8 7"/>'),
  receipt: ic('<path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5z"/><path d="M9 8h6M9 12h6M9 16h4"/>'),
  card: ic('<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>'),
};

/**
 * One friendly icon card. `hot` maps a field index to { amber: 0..1, green: 0..1 }.
 * `border` is the card border colour.
 */
function iconCard(c, { border = '#34363c', hot = {}, style = '' } = {}) {
  const rows = c.fields.map(([label, value], i) => {
    const h = hot[i] ?? { amber: 0, green: 0 };
    const a = h.amber * (1 - h.green), g = h.green;
    const bg = g > 0 ? `rgba(19,48,31,${g.toFixed(3)})` : `rgba(56,48,28,${a.toFixed(3)})`;
    const bar = g > 0 ? COLORS.green : COLORS.amber;
    const barOp = Math.max(a, g);
    const valCol = g > 0.5 ? '#bff3d0' : a > 0.5 ? COLORS.amber : 'var(--text)';
    // Round status badge, half outside the card's right edge.
    let badge = '';
    if (a > 0.01 || g > 0.01) {
      const warn = `<div class="abs" style="inset:0;display:flex;align-items:center;justify-content:center;border-radius:50%;background:#3d3113;color:var(--amber);box-shadow:0 0 0 3px #17181c;opacity:${(1 - g).toFixed(3)}">${ICON.warn({ size: 26 })}</div>`;
      const sc = 0.6 + 0.4 * easeOut(clamp(g * 1.4));
      const ok = `<div class="abs" style="inset:0;display:flex;align-items:center;justify-content:center;border-radius:50%;background:${COLORS.green};color:#06210f;box-shadow:0 0 0 3px #17181c, 0 0 24px #22c55e66;opacity:${g.toFixed(3)};transform:scale(${sc.toFixed(3)})">${ICON.check({ size: 26 })}</div>`;
      badge = `<div class="abs" style="right:-22px;top:${ROW / 2 - 22}px;width:44px;height:44px">${warn}${ok}</div>`;
    }
    return `<div style="position:relative;height:${ROW}px;display:flex;align-items:center;gap:14px;padding:0 30px 0 26px;border-top:1px solid var(--row-line);background:${bg};white-space:nowrap">
      <div class="abs" style="left:0;top:0;bottom:0;width:6px;background:${bar};opacity:${barOp.toFixed(3)}"></div>
      <span style="font-size:28px;color:var(--text-2);flex:1">${esc(label)}</span>
      <span style="font-size:30px;font-weight:600;color:${valCol}">${esc(value)}</span>${badge}</div>`;
  }).join('');
  return `<div class="abs" style="left:${c.x}px;top:${c.y}px;width:${CW}px;height:${cardH(c.fields.length)}px;${style}">
    <div class="abs" style="inset:0;background:#17181c;border:3px solid ${border};border-radius:20px;box-shadow:0 18px 44px #0009"></div>
    <div class="abs" style="inset:3px;border-radius:17px;overflow:visible">
      <div style="height:${HEAD - 3}px;display:flex;align-items:center;gap:18px;padding:0 24px">
        <span style="width:58px;height:58px;border-radius:16px;background:#1b2a40;color:${COLORS.logical};display:flex;align-items:center;justify-content:center">${ICONS[c.icon]}</span>
        <span style="font-size:38px;font-weight:800;letter-spacing:-.015em">${c.title}</span></div>
      ${rows}</div></div>`;
}

const MUTED = '#5c5140';                        // desaturated amber border while the map is wrong

export default {
  render(t, { beats }) {
    const lift = beats.fix.t + 0.3;             // "+0.3 → 'Here's why'": the stamp lifts off
    const drawAt = lift + 0.15;                 // lines redraw blue
    const tick1 = beats.fix.t + 0.68;           // "…and the simple…"
    const tick2 = beats.fix.t + 0.9;            // "…fix"

    const heal = seg(t, drawAt, drawAt + 0.7);
    const border = mix(MUTED, COLORS.logical, heal);

    // Soft glow behind the map: amber while wrong, blue once healed.
    const glow = mix('#34280d', '#132440', heal);
    let html = `<div class="abs" style="left:20px;top:300px;width:1040px;height:790px;background:radial-gradient(closest-side, ${glow} 0%, transparent 100%);opacity:.95"></div>`;

    // Lines: broken amber dashes at t = 0, then solid blue drawing over them.
    const dashOp = 1 - seg(t, lift, lift + 0.3);
    if (dashOp > 0) {
      html += edge(L1, { color: '#8a6d2a', dash: true, width: 4, opacity: dashOp });
      html += edge(L2, { color: '#8a6d2a', dash: true, width: 4, opacity: dashOp });
    }
    const p1 = easeInOut(seg(t, drawAt, drawAt + 0.55));
    const p2 = easeInOut(seg(t, drawAt + 0.15, drawAt + 0.7));
    if (p1 > 0) html += edge(L1, { color: COLORS.logical, progress: p1, width: 5 });
    if (p2 > 0) html += edge(L2, { color: COLORS.logical, progress: p2, width: 5 });
    // Joint dots where the lines meet the cards (blue once drawn).
    const dot = (x, y, op, col) => `<div class="abs" style="left:${x - 8}px;top:${y - 8}px;width:16px;height:16px;border-radius:50%;background:${col};opacity:${op.toFixed(3)}"></div>`;
    for (const [pts, p] of [[L1, p1], [L2, p2]]) {
      const a = pts[0], b = pts[pts.length - 1];
      html += dot(a[0], a[1], 1, mix('#8a6d2a', COLORS.logical, heal));
      html += dot(b[0], b[1], p >= 1 ? 1 : dashOp, p >= 1 ? COLORS.logical : '#8a6d2a');
    }

    const g1 = easeOut(seg(t, tick1, tick1 + 0.35));
    const g2 = easeOut(seg(t, tick2, tick2 + 0.35));
    // One unmistakably stale field: the map still lists a FAX number (anyone reads that as out of
    // date at a glance). On "simple" it turns into the email the app really keeps, then goes green
    // on "fix". The orders total gets a tick on "simple" too (it was right all along: no warning).
    const fixed = g1 > 0.5;
    const customers = { ...CARDS.customers, fields: [CARDS.customers.fields[0], fixed ? CARDS.customers.fields[1] : ['fax', '555 0199']] };
    html += iconCard(customers, { border, hot: { 1: { amber: 1, green: g2 } } });
    html += iconCard(CARDS.orders, { border });
    html += iconCard(CARDS.payments, { border });

    // The rubber stamp: on the map at t = 0, lifted off on `fix`.
    const sp = easeOut(seg(t, lift, lift + 0.45));
    const sop = 1 - seg(t, lift, lift + 0.4);
    if (sop > 0) {
      const sc = 1 + 0.14 * sp, dy = -40 * sp;
      html += `<div class="abs" style="left:0;width:1080px;top:${768 - 80}px;height:160px;display:flex;align-items:center;justify-content:center;opacity:${sop.toFixed(3)};transform:translateY(${dy.toFixed(1)}px) rotate(7deg) scale(${sc.toFixed(3)});filter:drop-shadow(0 ${(18 + 30 * sp).toFixed(0)}px ${(30 + 30 * sp).toFixed(0)}px #000c)">
        <div style="padding:6px;border:6px solid var(--amber);border-radius:22px;background:#1a1405ee">
          <div style="padding:12px 44px 14px;border:3px solid #f4b42c99;border-radius:14px;color:var(--amber);font-size:92px;line-height:1;font-weight:800;letter-spacing:.05em;white-space:nowrap">OUT OF DATE</div></div></div>`;
    }
    return html;
  },
};
