// onboard/team · "And when a teammate opens the repo, the diagrams are already there."
// A teammate (a plain initial avatar, "Priya opens the repo", in the window's title bar) opens
// the project. The proof comes first: the explorer shows the committed .erd-studio/ folder with
// its three domain files, and the status bar carries the plain "ERD 3" item (type-hierarchy
// icon, normal status-bar styling). Second, on the pause after "opens the repo", the one-time
// notification slides in ("This project has 3 ERD Studio diagrams." · Open orders · Not now —
// src/extension.ts). On "…already there" the pointer clicks "Open orders": the window stays put,
// the editor pane crossfades to the orders canvas at exactly the scene-4 size and positions
// while the sidebar slides shut, and the tab and crumb read orders.json · .erd-studio › gold like
// every other canvas card. The hold ends on a green "Committed with the code" pill at the
// right end of the status bar, clear of every node and edge.
//
// o_team word timings (silencedetect): "And when a teammate" 0.00–0.76 · "opens the repo"
// 0.85–1.42 · pause · "the diagrams are already there" 2.03–3.50 ("already there" ≈ +2.8).
import { COLORS, ICON, appIcon, appear, easeInOut, easeOut, edge, node, path, pointer, seg, toolbar } from '../../lib.js';

// ---- window: the whole stage, the same box as the canvas card in onboard/canvas ----
const WX = 64, WY = 300, WW = 952, WH = 790;        // 300..1090: the full stage (window-local coords below)
const HEAD = 64, SIDE = 300, STATUS = 52;
const NOTE = { w: 640, h: 170 };
NOTE.x = WW - NOTE.w - 20; NOTE.y = WH - STATUS - NOTE.h - 18;
const OPEN_BTN = { x: NOTE.x + 68, y: NOTE.y + 96, w: 190, h: 52 };  // "Open orders"

// ---- ORDERS_LAYOUT: copied from onboard/canvas.js (frame coordinates, scale 1.0) ----
const ORDERS_LAYOUT = (() => {
  const LX = 84, LW = 410, RX = 552, RW = 424, TOP = 480, BOT = 820;
  const models = [
    { name: 'dim_customers', x: LX, y: TOP, w: LW, cols: [{ key: 'PK', name: 'customer_id', type: 'VARCHAR' }, { name: 'customer_name', type: 'VARCHAR' }] },
    { name: 'fct_orders', x: RX, y: TOP, w: RW, cols: [{ key: 'PK', name: 'order_id', type: 'VARCHAR' }, { key: 'FK', name: 'customer_id', type: 'VARCHAR' }, { name: 'order_date', type: 'DATE' }, { name: 'order_total', type: 'DECIMAL(16,2)' }] },
    { name: 'fct_order_items', x: RX, y: BOT, w: RW, cols: [{ key: 'PK', name: 'order_item_id', type: 'VARCHAR' }, { key: 'FK', name: 'order_id', type: 'VARCHAR' }, { key: 'FK', name: 'product_id', type: 'VARCHAR' }] },
    { name: 'dim_products', x: LX, y: BOT, w: LW, cols: [{ key: 'PK', name: 'product_id', type: 'VARCHAR' }, { name: 'product_name', type: 'VARCHAR' }, { name: 'product_price', type: 'DECIMAL(16,2)' }] },
  ];
  return { toolbar: { x: 88, y: 380 }, models, midX: (LX + LW + RX) / 2, right: RX + RW + 22, gap: { x: LX, w: LW, y: 640, h: 180 } };
})();

/** The orders diagram in frame coordinates; nodes land from `at`, edges draw from `at + 0.3`. */
function ordersDiagram(t, at) {
  const L = ORDERS_LAYOUT, ry = (top, i) => top + 62 + i * 46 + 23;
  let h = toolbar({ x: L.toolbar.x, y: L.toolbar.y, domain: 'orders', layer: 'GLD', stage: 'logical', style: appear(t, at, { dy: 8 }) });
  const ep = easeOut(seg(t, at + 0.3, at + 0.8));
  if (ep > 0) {
    const [dc, fo, fi, dp] = L.models;
    h += edge([[fo.x, ry(fo.y, 1)], [L.midX, ry(fo.y, 1)], [L.midX, ry(dc.y, 0)], [dc.x + dc.w, ry(dc.y, 0)]], { progress: ep, many: [fo.x - 22, ry(fo.y, 1) - 8], one: [dc.x + dc.w + 8, ry(dc.y, 0) - 10] });
    h += edge([[fi.x + fi.w, ry(fi.y, 1)], [L.right, ry(fi.y, 1)], [L.right, ry(fo.y, 0)], [fo.x + fo.w, ry(fo.y, 0)]], { progress: ep, many: [fi.x + fi.w + 4, ry(fi.y, 1) - 8], one: [fo.x + fo.w + 6, ry(fo.y, 0) - 10] });
    h += edge([[fi.x, ry(fi.y, 2)], [L.midX, ry(fi.y, 2)], [L.midX, ry(dp.y, 0)], [dp.x + dp.w, ry(dp.y, 0)]], { progress: ep, many: [fi.x - 22, ry(fi.y, 2) - 8], one: [dp.x + dp.w + 8, ry(dp.y, 0) - 10] });
  }
  L.models.forEach((m, i) => {
    h += node({ x: m.x, y: m.y, w: m.w, name: m.name, layer: 'GLD', cols: m.cols, style: appear(t, at + i * 0.04, { dy: 8, dur: 0.3 }) });
  });
  return h;
}

// codicon-like "type-hierarchy" (the status bar item's icon), a small info mark, a commit mark
const hierarchy = (s, col) => `<svg class="icon" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round"><rect x="8.5" y="3" width="7" height="5" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><path d="M12 8v4M6.5 16v-4h11v4"/></svg>`;
const info = (s) => `<svg class="icon" width="${s}" height="${s}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#3794ff"/><path d="M12 10.5v6.5" stroke="#0f1114" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="7.2" r="1.5" fill="#0f1114"/></svg>`;
const commit = (s) => `<svg class="icon" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/></svg>`;
const chev = (open) => (open ? ICON.chevDown({ size: 20 }) : ICON.chevRight({ size: 20 }));

export default {
  render(t, { beats }) {
    const b = beats.team.t;
    const winAt = 0.0;                     // the window, with Priya in its title bar, from the first frame
    const repoAt = b + 0.2;                // explorer + status bar fill in under "…opens the repo" (+0.85)
    const noteAt = b + 1.45;               // the pause after "repo": the notification, second
    const moveAt = b + 2.1;                // "the diagrams…": pointer heads for Open orders
    const pressAt = b + 2.9;               // +2.8 → "already there": click
    const openAt = pressAt + 0.2;          // the editor pane crossfades to the canvas
    const shut = easeInOut(seg(t, openAt + 0.1, openAt + 0.6));    // the (emptied) sidebar slides shut
    const pillAt = b + 3.75;               // the caption ends (+3.58): one small beat for the hold

    const opened = t >= openAt;
    const note = easeOut(seg(t, noteAt, noteAt + 0.35));
    const noteOut = 1 - seg(t, openAt - 0.05, openAt + 0.2);

    let w = '';   // window-local HTML (origin = the window's top-left corner)

    // ---- title bar: tab + crumb, Priya on the right ----
    const tabs = opened
      ? `<div class="card__tab card__tab--on">${appIcon(24, 'box-shadow:none;border-radius:6px')}orders.json</div><div class="card__crumb">.erd-studio › gold</div>`
      : `<div class="card__tab card__tab--on"><span style="color:var(--text-3);display:flex">${ICON.file({ size: 20 })}</span>README.md</div><div class="card__crumb">jaffle-shop</div>`;
    w += `<div class="card__head abs" style="left:0;right:0;top:0;font-size:24px"><div class="card__dots"><i></i><i></i><i></i></div>${tabs}
      <div style="margin-left:auto;display:flex;align-items:center;gap:12px;padding:0 22px;white-space:nowrap">
        <div style="width:40px;height:40px;border-radius:50%;background:#13301f;border:2px solid var(--green);color:var(--green);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800">P</div>
        <span style="font-size:26px;font-weight:700;color:var(--text)">Priya <span style="color:var(--text-2);font-weight:500">opens the repo</span></span></div></div>`;

    // ---- editor pane: README, crossfading to the canvas ----
    const readmeOp = (1 - seg(t, openAt, openAt + 0.15)) * seg(t, repoAt, repoAt + 0.3);
    if (readmeOp > 0) {
      w += `<div class="abs mono" style="left:${SIDE + 36}px;top:${HEAD + 34}px;font-size:26px;line-height:44px;white-space:pre;opacity:${readmeOp.toFixed(3)}"><span class="k"># jaffle-shop</span>\n<span style="color:var(--text-2)">dbt project · Kimball marts</span>\n\n<span style="color:var(--text-3)">## Getting started</span>\n<span style="color:var(--text-2)">dbt deps &amp;&amp; dbt build</span>\n\n<span style="color:var(--text-3)">## Data model</span>\n<span style="color:var(--text-2)">See .erd-studio/</span></div>`;
    }
    if (opened) {
      const cOp = appear(t, openAt, { dy: 0, dur: 0.3 });
      w += `<div class="abs grid-bg" style="left:0;right:0;top:${HEAD}px;bottom:${STATUS}px;background-color:var(--card);${appear(t, openAt, { dy: 0, dur: 0.15 })}"></div>`;
      w += `<div class="abs" style="left:${-WX}px;top:${-WY}px;${cOp}">${ordersDiagram(t, openAt + 0.05)}</div>`;
    }

    // ---- sidebar (explorer): slides shut once the canvas is open ----
    if (shut < 1) {
      const rows = [
        [0, 'dir', '.erd-studio', true, true],
        [1, 'dir', 'gold', true],
        [2, 'json', 'orders.json'],
        [2, 'json', 'customers.json'],
        [1, 'dir', 'silver', true],
        [2, 'json', 'locations.json'],
        [1, 'dir', 'logical-models', false],
        [0, 'dir', 'models', false],
        [0, 'file', 'dbt_project.yml'],
      ];
      const RH = 52, RY0 = 62;
      let ex = `<div class="abs" style="left:22px;top:16px;font-size:24px;font-weight:700;letter-spacing:.08em;color:var(--text-2)">EXPLORER</div>`;
      rows.forEach(([ind, kind, label, open, hi], i) => {
        const inErd = i <= 6;
        const icon = kind === 'dir'
          ? `<span style="color:var(--text-2);display:flex">${chev(open)}</span><span style="color:${hi ? COLORS.green : '#7d8ea8'};display:flex">${ICON.folder({ size: 24 })}</span>`
          : `<span style="width:20px"></span>${kind === 'json' ? appIcon(22, 'box-shadow:none;border-radius:5px') : `<span style="color:var(--text-3);display:flex">${ICON.file({ size: 22 })}</span>`}`;
        const sel = i === 2 && t >= pressAt ? 'background:#1b2a40;' : '';
        ex += `<div class="abs" style="left:0;width:${SIDE}px;top:${RY0 + i * RH}px;height:${RH}px;${sel}display:flex;align-items:center;gap:8px;padding-left:${14 + ind * 22}px;font-size:24px;white-space:nowrap;color:${inErd ? 'var(--text)' : 'var(--text-2)'};${hi ? `color:${COLORS.green};font-weight:700;` : ''}${appear(t, repoAt + 0.1 + i * 0.04, { dy: 0, dx: -8, dur: 0.25 })}">${icon}<span>${label}</span></div>`;
      });
      w += `<div class="abs" style="left:0;top:${HEAD}px;width:${SIDE}px;bottom:${STATUS}px;background:#131619;border-right:1px solid var(--card-border);overflow:hidden;transform:translateX(${(-(SIDE + 2) * shut).toFixed(1)}px)"><div class="abs" style="left:0;top:0;right:0;bottom:0;opacity:${(1 - seg(t, openAt, openAt + 0.18)).toFixed(3)}">${ex}</div></div>`;
    }

    // ---- status bar: plain styling; the item is simply there because the repo has diagrams ----
    w += `<div class="abs" style="left:0;right:0;bottom:0;height:${STATUS}px;background:#131619;border-top:1px solid var(--card-border);display:flex;align-items:center;gap:30px;padding:0 22px;font-size:28px;color:var(--text-2);white-space:nowrap">
      <span style="${appear(t, repoAt, { dy: 0, dur: 0.3 })}">main</span>
      <span style="display:flex;align-items:center;gap:8px;${appear(t, repoAt + 0.3, { dy: 0, dur: 0.3 })}">${hierarchy(26, '#aab0ba')}<span style="color:var(--text)">ERD 3</span></span></div>`;

    // ---- notification (bottom-right, VS Code-style) ----
    if (t >= noteAt && noteOut > 0) {
      const press = seg(t, pressAt, pressAt + 0.18);
      w += `<div class="abs" style="left:${NOTE.x}px;top:${NOTE.y}px;width:${NOTE.w}px;height:${NOTE.h}px;border-radius:10px;background:#202126;border:1px solid #3a3d45;box-shadow:0 18px 50px #000c;
        opacity:${Math.min(note, noteOut).toFixed(3)};transform:translateY(${(24 * (1 - note)).toFixed(1)}px)">
        <div class="abs" style="left:22px;top:26px;display:flex;align-items:center;gap:14px;font-size:28px;white-space:nowrap">${info(30)}This project has 3 ERD Studio diagrams.</div>
        <div class="abs" style="left:68px;top:96px;display:flex;gap:16px">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:${OPEN_BTN.w}px;height:${OPEN_BTN.h}px;border-radius:6px;background:${press > 0 ? '#1177bb' : '#0e639c'};color:#fff;font-size:27px;font-weight:600;white-space:nowrap;transform:scale(${(1 - 0.04 * Math.sin(Math.PI * press)).toFixed(4)})">Open orders</span>
          <span style="display:inline-flex;align-items:center;height:${OPEN_BTN.h}px;padding:0 24px;border-radius:6px;background:#3a3d41;color:var(--text);font-size:27px;white-space:nowrap">Not now</span></div></div>`;
    }

    // the window: fixed on the stage for the whole scene
    let html = `<div class="abs" style="left:${WX}px;top:${WY}px;width:${WW}px;height:${WH}px;border-radius:20px;overflow:hidden;background:var(--card);box-shadow:0 30px 80px #000a;${appear(t, winAt, { dy: 0, dur: 0.01 })}">${w}
      <div class="abs" style="left:0;top:0;right:0;bottom:0;border:1px solid var(--card-border);border-radius:20px"></div></div>`;

    // ---- pointer: aimed at the button's lower-right corner so "Open orders" stays readable ----
    if (t >= moveAt && t < openAt + 0.2) {
      const tx = WX + OPEN_BTN.x + OPEN_BTN.w - 14, ty = WY + OPEN_BTN.y + OPEN_BTN.h - 6;
      const p = path(t, [{ t: moveAt, x: 760, y: 700 }, { t: pressAt - 0.05, x: tx, y: ty }]);
      html += `<div class="abs" style="left:0;top:0;opacity:${Math.min(seg(t, moveAt, moveAt + 0.2), 1 - seg(t, openAt - 0.05, openAt + 0.2)).toFixed(3)}">${pointer(p.x, p.y, seg(t, pressAt, pressAt + 0.45))}</div>`;
    }

    // ---- the hold: "Committed with the code", at the right end of the status bar (clear space,
    // and where git state lives), clear of every node and edge ----
    if (t >= pillAt) {
      html += `<span class="abs pill" style="right:${1080 - (WX + WW - 16)}px;top:${WY + WH - STATUS + 4}px;height:${STATUS - 8}px;box-sizing:border-box;font-size:26px;padding:0 20px;gap:12px;background:#13301f;color:var(--green);border:2px solid var(--green);white-space:nowrap;${appear(t, pillAt, { dy: 6 })}">${commit(28)}Committed with the code</span>`;
    }
    return html;
  },
};
