// simple/2 · "What's a data map?" Grounds the idea in two things everyone has seen: an online
// shop and a spreadsheet. shop → "Picture an online shop." (a shopfront); lists → "It keeps three
// lists: customers, orders and payments. Like tabs in a spreadsheet." (a spreadsheet whose tabs
// appear, and switch, on each spoken name; the tab bar glows on "tabs"); map → "A data map is a
// drawing of those lists, and how they link up." (the tabs lift off and become the map cards —
// the same cards and layout as simple/hook); link → "Every order belongs to a customer. Every
// payment is for an order." (each line draws as its sentence is spoken).
// Word times measured in the clips with silencedetect (see each const).
import { COLORS, ICON, clamp, easeInOut, easeOut, edge, esc, lerp, seg, mix, appear } from '../../lib.js';

// ---------- shared map geometry (the same layout as simple/hook, so the map "comes back") ----------
const CW = 380, HEAD = 96, ROW = 62;
const cardH = (n) => HEAD + n * ROW + 12;
const CARDS = {
  customers: { x: 64, y: 330, icon: 'person', title: 'customers', fields: [['name', 'Ana Silva'], ['email', 'ana@mail.com']] },
  orders: { x: 636, y: 470, icon: 'receipt', title: 'orders', fields: [['date', '12 March'], ['total', '$84.00']] },
  payments: { x: 64, y: 820, icon: 'card', title: 'payments', fields: [['amount', '$84.00'], ['paid on', '13 March']] },
};
// Lines: customers -> orders ("belongs to"), payments -> orders ("is for"), through the gap column.
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

const label = (x, y, text, op) => `<div class="abs" style="left:${x - 120}px;width:240px;top:${y - 26}px;display:flex;justify-content:center;opacity:${op.toFixed(3)}">
  <span class="pill" style="font-size:28px;padding:7px 18px;background:#1b2a40;color:#cfe3ff;box-shadow:0 0 0 2px ${COLORS.logical}88, 0 8px 22px #0009">${text}</span></div>`;

// ---------- the shop and the spreadsheet ----------
const shopIcon = (size) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 120 100" fill="none" stroke-linejoin="round">
  <path d="M14 40h92v52H14z" fill="#1a1b1f" stroke="#cfe3ff" stroke-width="4"/>
  <path d="M8 18h104l-6 22H14z" fill="#1b2a40" stroke="#cfe3ff" stroke-width="4"/>
  ${[0, 1, 2, 3, 4].map((i) => `<path d="M${8 + i * 20.8 + (i % 2 ? 0 : 0)} 18h10.4l-1.2 22h-10.4z" fill="${COLORS.logical}" opacity=".85"/>`).join('')}
  <path d="M26 54h30v24H26z" fill="#13301f" stroke="#cfe3ff" stroke-width="3"/>
  <path d="M70 54h22v38H70z" fill="#2a2c33" stroke="#cfe3ff" stroke-width="3"/><circle cx="87" cy="74" r="2.4" fill="#cfe3ff"/>
  <path d="M40 8h40v10H40z" fill="#16181c" stroke="#cfe3ff" stroke-width="3"/></svg>`;

const SHEETS = {
  customers: { head: ['name', 'email'], rows: [['Ana Silva', 'ana@mail.com'], ['Ben Carter', 'ben@mail.com'], ['Chloe Ng', 'chloe@mail.com']] },
  orders: { head: ['date', 'customer', 'total'], rows: [['12 March', 'Ana Silva', '$84.00'], ['14 March', 'Ben Carter', '$22.50'], ['15 March', 'Ana Silva', '$39.90']] },
  payments: { head: ['paid on', 'for order', 'amount'], rows: [['13 March', '12 March', '$84.00'], ['14 March', '14 March', '$22.50'], ['16 March', '15 March', '$39.90']] },
};
const TABS = ['customers', 'orders', 'payments'];
// Spreadsheet window geometry.
const SX = 64, SY = 470, SW = 952, TITLE = 64, COLH = 40, HEADH = 58, RH = 58, TABH = 78;
const SH = TITLE + COLH + HEADH + 3 * RH + TABH;
const TAB_W = 250, TAB_X0 = SX + 70, TAB_Y = SY + SH - TABH + 12;
const tabX = (i) => TAB_X0 + i * (TAB_W + 12);

function sheetGrid(name) {
  const { head, rows } = SHEETS[name];
  const cols = head.length;
  const RN = 64;                                                   // row-number gutter
  const colW = (SW - RN) / cols;
  const letters = head.map((_, i) => `<div style="width:${colW}px;text-align:center">${'ABC'[i]}</div>`).join('');
  const cell = (v, bold) => `<div style="width:${colW}px;padding:0 22px;overflow:hidden;white-space:nowrap;border-left:1px solid #2c2d33;${bold ? 'font-weight:700;color:#e9ecef' : ''}">${esc(v)}</div>`;
  const line = (n, cells, bold, bg = '') => `<div style="display:flex;align-items:center;height:${bold ? HEADH : RH}px;border-top:1px solid #2c2d33;${bg}">
      <div style="width:${RN}px;text-align:center;font-size:20px;color:var(--text-3)">${n}</div>${cells.map((c) => cell(c, bold)).join('')}</div>`;
  return `<div style="display:flex;align-items:center;height:${COLH}px;padding-left:${RN}px;font-size:20px;color:var(--text-3);background:#15161a">${letters}</div>
    ${line(1, head, true, 'background:#1d1f24')}${rows.map((r, i) => line(i + 2, r, false)).join('')}`;
}

export default {
  render(t, { beats }) {
    const sh = beats.shop.t, li = beats.lists.t, m = beats.map.t, lk = beats.link.t;
    const shopAt = sh - 0.25;                  // up as the scene fades in: "Picture an online shop"
    const sheetAt = li - 0.1;                  // "It keeps three lists:"
    const tabAt = [li + 1.21, li + 1.83, li + 2.40];   // "customers," "orders" "and payments"
    const tabsGlow = li + 3.4;                 // "Like tabs…"
    const liftAt = m + 0.15;                   // "A data map is a drawing of those lists"
    const tagAt = m + 2.4;                     // "…and how they link up"
    const l1At = lk + 0.25, l2At = lk + 2.2;   // "Every order belongs to a customer." / "Every payment is for an order."

    const blue = seg(t, liftAt + 0.3, liftAt + 0.8);
    let html = `<div class="abs" style="left:20px;top:300px;width:1040px;height:790px;background:radial-gradient(closest-side, #132440 0%, transparent 100%);opacity:${(0.3 + 0.6 * blue).toFixed(3)}"></div>`;

    // 1 · the shop (centre), handing over to the spreadsheet.
    const shopOut = seg(t, sheetAt, sheetAt + 0.45);
    if (shopOut < 1) {
      const sp = easeOut(seg(t, shopAt, shopAt + 0.45));
      html += `<div class="abs" style="left:0;width:1080px;top:470px;display:flex;flex-direction:column;align-items:center;gap:26px;opacity:${(sp * (1 - shopOut)).toFixed(3)};transform:translateY(${(lerp(18, 0, sp) - 60 * shopOut).toFixed(1)}px) scale(${lerp(1, 0.8, shopOut).toFixed(3)})">
        <div style="filter:drop-shadow(0 20px 40px #000c)">${shopIcon(360)}</div>
        <div style="display:flex;gap:14px">${[ICONS.person, ICONS.receipt, ICONS.card].map((ico) => `<span style="width:64px;height:64px;border-radius:18px;background:#1b2a40;color:${COLORS.logical};display:flex;align-items:center;justify-content:center">${ico}</span>`).join('')}</div></div>`;
    }

    // 2 · the spreadsheet: its tabs appear, and switch, on each spoken name.
    const sheetOut = seg(t, liftAt, liftAt + 0.4);
    if (t >= sheetAt && sheetOut < 1) {
      const active = t >= tabAt[2] ? 2 : t >= tabAt[1] ? 1 : 0;
      const showGrid = t >= tabAt[0];
      const glow = seg(t, tabsGlow, tabsGlow + 0.3) * (1 - seg(t, liftAt - 0.4, liftAt));
      const tabs = TABS.map((name, i) => {
        if (t < tabAt[i]) return '';
        const on = i === active;
        return `<div class="abs" style="left:${tabX(i) - SX}px;top:${TAB_Y - SY}px;width:${TAB_W}px;height:${TABH - 24}px;border-radius:0 0 12px 12px;display:flex;align-items:center;justify-content:center;gap:12px;font-size:28px;font-weight:${on ? 800 : 600};white-space:nowrap;
          background:${on ? '#1b2a40' : '#202126'};color:${on ? '#e3eeff' : 'var(--text-2)'};border:2px solid ${on ? COLORS.logical : '#34363c'};border-top:none;${appear(t, tabAt[i], { dy: -8, dur: 0.25 })}">
          <span style="color:${on ? COLORS.logical : 'var(--text-3)'};display:flex">${ICONS[CARDS[name].icon].replace('width="34" height="34"', 'width="26" height="26"')}</span>${name}</div>`;
      }).join('');
      html += `<div class="abs" style="left:${SX}px;top:${SY}px;width:${SW}px;height:${SH}px;opacity:${(1 - sheetOut).toFixed(3)};transform:scale(${lerp(1, 0.94, sheetOut).toFixed(3)});${appear(t, sheetAt, { dy: 16 })}">
        <div class="abs" style="inset:0;border-radius:20px;background:#1a1b1f;border:1px solid var(--card-border);box-shadow:0 30px 80px #000a"></div>
        <div class="abs" style="left:0;right:0;top:0;height:${TITLE}px;display:flex;align-items:center;gap:14px;padding:0 24px;border-bottom:1px solid var(--card-border);background:#131619;border-radius:20px 20px 0 0;font-size:26px;font-weight:700;white-space:nowrap">
          <span style="display:flex">${shopIcon(40)}</span>Online shop<span style="color:var(--text-3);font-weight:500">· spreadsheet</span></div>
        <div class="abs" style="left:0;right:0;top:${TITLE}px;height:${COLH + HEADH + 3 * RH}px;overflow:hidden;font-size:26px;color:#c9ccd2">${showGrid ? sheetGrid(TABS[active]) : ''}</div>
        <div class="abs" style="left:0;right:0;bottom:0;height:${TABH}px;border-top:2px solid #34363c;background:#15161a;border-radius:0 0 20px 20px;box-shadow:${glow > 0 ? `inset 0 0 0 ${(3 * glow).toFixed(2)}px ${COLORS.logical}, 0 0 ${Math.round(40 * glow)}px rgba(96,165,250,${(0.45 * glow).toFixed(3)})` : 'none'}"></div>
        ${tabs}</div>`;
    }

    // 3 · the tabs lift off and become the map's cards.
    const border = mix('#34363c', COLORS.logical, blue);
    TABS.forEach((name, i) => {
      const at = liftAt + 0.25 + i * 0.12;   // after the sheet has started to fade
      const p = easeInOut(seg(t, at, at + 0.7));
      if (p <= 0) return;
      const c = CARDS[name];
      const cx = c.x + CW / 2, cy = c.y + cardH(c.fields.length) / 2;
      const fx = tabX(i) + TAB_W / 2, fy = TAB_Y + (TABH - 24) / 2;
      const dx = (fx - cx) * (1 - p), dy = (fy - cy) * (1 - p), sc = lerp(0.62, 1, p);
      html += `<div class="abs" style="left:0;top:0;opacity:${Math.min(1, p * 2).toFixed(3)};transform:translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)">
        <div style="position:absolute;left:0;top:0;transform-origin:${cx}px ${cy}px;transform:scale(${sc.toFixed(4)})">${iconCard(c, { border })}</div></div>`;
    });

    // 4 · how they link: one line per sentence, with plain labels.
    const p1 = easeInOut(seg(t, l1At, l1At + 0.6));
    const p2 = easeInOut(seg(t, l2At, l2At + 0.6));
    const dot = (x, y, op) => `<div class="abs" style="left:${x - 8}px;top:${y - 8}px;width:16px;height:16px;border-radius:50%;background:${COLORS.logical};opacity:${op.toFixed(3)}"></div>`;
    if (p1 > 0) html += edge(L1, { color: COLORS.logical, progress: p1, width: 5 }) + dot(L1[0][0], L1[0][1], 1) + dot(L1[3][0], L1[3][1], p1 >= 1 ? 1 : 0);
    if (p2 > 0) html += edge(L2, { color: COLORS.logical, progress: p2, width: 5 }) + dot(L2[0][0], L2[0][1], 1) + dot(L2[3][0], L2[3][1], p2 >= 1 ? 1 : 0);
    if (p1 > 0) html += label(GX, (L1[1][1] + L1[2][1]) / 2, 'belongs to', seg(t, l1At + 0.45, l1At + 0.75));
    if (p2 > 0) html += label(GX, (L2[1][1] + L2[2][1]) / 2 + 40, 'is for', seg(t, l2At + 0.45, l2At + 0.75));

    // "a data map" tag, bottom-right (the empty corner), once the caption has said it.
    if (t >= tagAt) {
      html += `<div class="abs" style="left:636px;width:380px;top:800px;display:flex;justify-content:center;${appear(t, tagAt, { dy: 12 })}">
        <div style="display:flex;align-items:center;gap:16px;padding:16px 30px;border-radius:999px;background:#1b2a40;color:#e3eeff;font-size:40px;font-weight:800;letter-spacing:-.01em;white-space:nowrap;box-shadow:0 0 0 3px ${COLORS.logical}, 0 14px 36px #000a">
          <span style="color:${COLORS.logical}">${mapIcon}</span>a data map</div></div>`;
    }
    return html;
  },
};
