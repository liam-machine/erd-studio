// simple/2 · "Every app keeps information: customers, orders, payments. / A data map shows what's
// kept, and how it all connects." A phone ("an app") stands in the middle; on each spoken word a
// card flies out of it to its place on the map (customers, orders, payments, each with an icon
// and two everyday fields). On `map` the cards turn map-blue and a "a data map" tag lands; on
// "…how it all connects" the lines draw between them with plain labels ("places", "pays for").
import { COLORS, ICON, clamp, easeInOut, easeOut, edge, esc, seg, mix, appear } from '../../lib.js';

// ---------- shared map geometry (the same layout as simple/hook, so the map "comes back") ----------
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


const mapIcon = ic('<path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>', 40, 2.2);

/** The phone in the gap column: an app with a few rows of "information". */
function phone(t, at, infoAt) {
  const PX = 445, PY = 500, PW = 190, PH = 370;
  const rows = [0, 1, 2, 3, 4].map((i) => {
    const p = easeOut(seg(t, infoAt + i * 0.09, infoAt + i * 0.09 + 0.3));
    const w = [120, 96, 132, 84, 110][i];
    return `<div style="display:flex;align-items:center;gap:10px;height:30px;opacity:${p.toFixed(3)};transform:translateX(${(-10 * (1 - p)).toFixed(1)}px)">
      <span style="width:22px;height:22px;border-radius:6px;background:#1b2a40;flex:none"></span>
      <span style="width:${w}px;height:10px;border-radius:5px;background:#3a3d45"></span></div>`;
  }).join('');
  return `<div class="abs" style="left:${PX}px;top:${PY}px;width:${PW}px;height:${PH}px;${appear(t, at, { dy: 16 })}">
    <div class="abs" style="inset:0;border-radius:34px;background:#101114;border:4px solid #3a3c43;box-shadow:0 24px 60px #000b"></div>
    <div class="abs" style="left:12px;right:12px;top:14px;bottom:14px;border-radius:24px;background:#1a1b1f;overflow:hidden">
      <div style="height:54px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--row-line)"><span style="width:70px;height:12px;border-radius:6px;background:#4a4e56"></span></div>
      <div style="padding:16px 16px;display:flex;flex-direction:column;gap:12px">${rows}</div></div>
    <div class="abs" style="left:-40px;right:-40px;top:${PH + 16}px;text-align:center;font-size:30px;font-weight:700;color:var(--text-2)">an app</div></div>`;
}

/** Card flying out of the phone's centre to its place. */
function flyIn(c, t, at, opts) {
  const p = easeOut(seg(t, at, at + 0.5));
  if (p <= 0) return '';
  const cx = c.x + CW / 2, cy = c.y + cardH(c.fields.length) / 2;
  const dx = (540 - cx) * (1 - p), dy = (685 - cy) * (1 - p), sc = 0.3 + 0.7 * p;
  return `<div class="abs" style="left:0;top:0;opacity:${clamp(p * 1.6).toFixed(3)};transform:translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)">
    <div style="position:absolute;left:0;top:0;transform-origin:${cx}px ${cy}px;transform:scale(${sc.toFixed(4)})">${iconCard(c, opts)}</div></div>`;
}

const label = (x, y, text, op) => `<div class="abs" style="left:${x - 120}px;width:240px;top:${y - 26}px;display:flex;justify-content:center;opacity:${op.toFixed(3)}">
  <span class="pill" style="font-size:28px;padding:7px 18px;background:#1b2a40;color:#cfe3ff;box-shadow:0 0 0 2px ${COLORS.logical}88, 0 8px 22px #0009">${text}</span></div>`;

export default {
  render(t, { beats }) {
    const a = beats.apps.t, m = beats.map.t;
    const phoneAt = 0.05;                      // on screen as the scene fades in, ready for "Every app…"
    const infoAt = a + 0.85;                   // "…keeps information:"
    const cAt = a + 1.72;                      // "customers,"   (clip pause 1.37–1.73)
    const oAt = a + 2.42;                      // "orders,"
    const pAt = a + 2.83;                      // "payments."
    const phoneOut = a + 3.05;
    const blueAt = m + 0.05;                   // "A data map…": the cards become the map
    const tagAt = m + 0.2;
    const linesAt = m + 1.8;                   // "…and how it all connects" (clip pause 1.51–1.80)

    const blue = seg(t, blueAt, blueAt + 0.5);
    const border = mix('#34363c', COLORS.logical, blue);
    let html = `<div class="abs" style="left:20px;top:300px;width:1040px;height:790px;background:radial-gradient(closest-side, #132440 0%, transparent 100%);opacity:${(0.35 + 0.6 * blue).toFixed(3)}"></div>`;

    const phoneOp = 1 - seg(t, phoneOut, phoneOut + 0.4);
    if (phoneOp > 0) html += `<div class="abs" style="left:0;top:0;opacity:${phoneOp.toFixed(3)}">${phone(t, phoneAt, infoAt)}</div>`;

    // Lines + labels
    const p1 = easeInOut(seg(t, linesAt, linesAt + 0.5));
    const p2 = easeInOut(seg(t, linesAt + 0.2, linesAt + 0.7));
    if (p1 > 0) html += edge(L1, { color: COLORS.logical, progress: p1, width: 5 });
    if (p2 > 0) html += edge(L2, { color: COLORS.logical, progress: p2, width: 5 });
    const dot = (x, y, op) => `<div class="abs" style="left:${x - 8}px;top:${y - 8}px;width:16px;height:16px;border-radius:50%;background:${COLORS.logical};opacity:${op.toFixed(3)}"></div>`;
    if (p1 > 0) html += dot(L1[0][0], L1[0][1], 1) + dot(L1[3][0], L1[3][1], p1 >= 1 ? 1 : 0);
    if (p2 > 0) html += dot(L2[0][0], L2[0][1], 1) + dot(L2[3][0], L2[3][1], p2 >= 1 ? 1 : 0);

    html += flyIn(CARDS.customers, t, cAt, { border });
    html += flyIn(CARDS.orders, t, oAt, { border });
    html += flyIn(CARDS.payments, t, pAt, { border });

    if (p1 > 0) html += label(GX, (L1[1][1] + L1[2][1]) / 2, 'places', seg(t, linesAt + 0.3, linesAt + 0.6));
    if (p2 > 0) html += label(GX, (L2[1][1] + L2[2][1]) / 2 + 40, 'pays for', seg(t, linesAt + 0.5, linesAt + 0.8));

    // "a data map" tag, bottom-right (the empty corner of the layout).
    if (t >= tagAt) {
      html += `<div class="abs" style="left:636px;width:380px;top:800px;display:flex;justify-content:center;${appear(t, tagAt, { dy: 12 })}">
        <div style="display:flex;align-items:center;gap:16px;padding:16px 30px;border-radius:999px;background:#1b2a40;color:#e3eeff;font-size:40px;font-weight:800;letter-spacing:-.01em;white-space:nowrap;box-shadow:0 0 0 3px ${COLORS.logical}, 0 14px 36px #000a">
          <span style="color:${COLORS.logical}">${mapIcon}</span>a data map</div></div>`;
    }
    return html;
  },
};
