// onboard/sample · "No dbt project? Open the sample in GitHub Codespaces. / Nothing to install."
// A browser window on github.com/liam-machine/erd-studio-sample (repo title, the README's real
// description, the top-level files) with one big generic green "Open in GitHub Codespaces"
// button. The pointer clicks it on "…GitHub Codespaces"; the same window becomes the codespace:
// tab "erd-studio-sample [Codespaces]", address bar "<name>.github.dev" (tab and URL always
// agree), with the orders diagram already open (the four-table layout from onboard/canvas at the
// same size, shifted under the address bar). On `nothing` a green "Runs in your browser" pill
// lands in the toolbar row (the caption says "Nothing to install.", so the pill adds, not repeats).
//
// o_nodbt word timings (silencedetect): "No dbt project?" 0.00–1.50 · "Open the sample in GitHub
// Codespaces" 1.86–4.10 ("GitHub Codespaces" ≈ +2.8). o_nothing: "Nothing to install." 0.00–1.06.
import { COLORS, ICON, appIcon, appear, card, easeOut, edge, node, path, pointer, seg, spinner, toolbar } from '../../lib.js';

// ---- browser window: the whole stage, like the canvas card in onboard/canvas ----
const WX = 64, WY = 300, WW = 952, WH = 786;        // 300..1086
const HEAD = 64, ADDR = 56;                          // card head, address bar row (both phases)
const BY = WY + HEAD;                                // body top (frame)
// the green button (frame coordinates)
const BTN = { x: WX + 40, y: BY + ADDR + 170, w: WW - 80, h: 88 };

// ---- ORDERS_LAYOUT: copied from onboard/canvas.js (frame coordinates there) ----
// Same node boxes, same edge routes, scale 1.0 (22 px rows, as in scenes 4 and 5). Here the
// whole layout sits DY lower, under the codespace's editor tab strip.
const ORDERS_LAYOUT = (() => {
  const LX = 84, LW = 410, RX = 552, RW = 424, TOP = 480, BOT = 820;
  const models = [
    { name: 'dim_customers', x: LX, y: TOP, w: LW, cols: [{ key: 'PK', name: 'customer_id', type: 'VARCHAR' }, { name: 'customer_name', type: 'VARCHAR' }] },
    { name: 'fct_orders', x: RX, y: TOP, w: RW, cols: [{ key: 'PK', name: 'order_id', type: 'VARCHAR' }, { key: 'FK', name: 'customer_id', type: 'VARCHAR' }, { name: 'order_date', type: 'DATE' }, { name: 'order_total', type: 'DECIMAL(16,2)' }] },
    { name: 'fct_order_items', x: RX, y: BOT, w: RW, cols: [{ key: 'PK', name: 'order_item_id', type: 'VARCHAR' }, { key: 'FK', name: 'order_id', type: 'VARCHAR' }, { key: 'FK', name: 'product_id', type: 'VARCHAR' }] },
    { name: 'dim_products', x: LX, y: BOT, w: LW, cols: [{ key: 'PK', name: 'product_id', type: 'VARCHAR' }, { name: 'product_name', type: 'VARCHAR' }, { name: 'product_price', type: 'DECIMAL(16,2)' }] },
  ];
  return { toolbar: { x: 88, y: 380 }, models, midX: (LX + LW + RX) / 2, right: RX + RW + 22 };
})();
const DY = ADDR;                                     // canvas starts under the address bar

/** The orders diagram at scene-4 geometry (shifted by `dy`); nodes land from `at`, edges from `at + 0.25`. */
function ordersDiagram(t, at, dy) {
  const L = ORDERS_LAYOUT, ry = (top, i) => top + dy + 62 + i * 46 + 23;
  let h = toolbar({ x: L.toolbar.x, y: L.toolbar.y + dy, domain: 'orders', layer: 'GLD', stage: 'logical', style: appear(t, at, { dy: 8 }) });
  const ep = easeOut(seg(t, at + 0.25, at + 0.75));
  if (ep > 0) {
    const [dc, fo, fi, dp] = L.models;
    h += edge([[fo.x, ry(fo.y, 1)], [L.midX, ry(fo.y, 1)], [L.midX, ry(dc.y, 0)], [dc.x + dc.w, ry(dc.y, 0)]], { progress: ep, many: [fo.x - 22, ry(fo.y, 1) - 8], one: [dc.x + dc.w + 8, ry(dc.y, 0) - 10] });
    h += edge([[fi.x + fi.w, ry(fi.y, 1)], [L.right, ry(fi.y, 1)], [L.right, ry(fo.y, 0)], [fo.x + fo.w, ry(fo.y, 0)]], { progress: ep, many: [fi.x + fi.w + 4, ry(fi.y, 1) - 8], one: [fo.x + fo.w + 6, ry(fo.y, 0) - 10] });
    h += edge([[fi.x, ry(fi.y, 2)], [L.midX, ry(fi.y, 2)], [L.midX, ry(dp.y, 0)], [dp.x + dp.w, ry(dp.y, 0)]], { progress: ep, many: [fi.x - 22, ry(fi.y, 2) - 8], one: [dp.x + dp.w + 8, ry(dp.y, 0) - 10] });
  }
  L.models.forEach((m, i) => {
    h += node({ x: m.x, y: m.y + dy, w: m.w, name: m.name, layer: 'GLD', cols: m.cols, style: appear(t, at + i * 0.04, { dy: 10, dur: 0.3 }) });
  });
  return h;
}

// small inline icons (the font has no glyphs for these)
const repoIcon = (s) => `<svg class="icon" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/></svg>`;
const codeIcon = (s) => `<svg class="icon" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>`;
const padlock = (s) => ICON.lock({ size: s });

export default {
  render(t, { beats }) {
    const n = beats.nodbt.t, no = beats.nothing.t;
    const btnAt = 0.1;                     // the button is the page's hero from the first frame
    const moveAt = n + 1.7;                // "Open the sample…": the pointer heads for the button
    const pressAt = n + 2.75;              // +2.8 → "GitHub Codespaces": click
    const swapAt = n + 3.15;               // the window becomes the Codespaces tab
    const loadEnd = swapAt + 0.45;         // brief "opening" spinner, then the canvas is already there
    const pillAt = no + 0.1;               // "Nothing to install." → Runs in your browser

    const b = easeOut(seg(t, swapAt, swapAt + 0.3));   // 0 = github.com, 1 = Codespaces
    const aOp = (1 - b).toFixed(3), bOp = b.toFixed(3);

    // ---- window chrome: tab title and address swap on the click ----
    const tabLabel = `<span style="position:relative;display:inline-block;min-width:390px;height:30px">
      <span class="abs" style="left:0;top:0;opacity:${aOp}">liam-machine/erd-studio-sample</span>
      <span class="abs" style="left:0;top:0;opacity:${bOp};color:var(--text)">erd-studio-sample [Codespaces]</span></span>`;
    let body = '';
    // address bar, both phases: the URL crossfades with the tab title so the two always agree
    body += `<div class="abs" style="left:0;right:0;top:0;height:${ADDR}px;border-bottom:1px solid var(--card-border);background:var(--card-head)">
      <div class="abs" style="left:24px;right:24px;top:8px;height:40px;border-radius:20px;background:#0f1114;border:1px solid var(--card-border);display:flex;align-items:center;gap:12px;padding:0 18px;font-size:26px;color:var(--text-2);white-space:nowrap">
        <span style="color:var(--text-3)">${padlock(20)}</span>
        <span style="position:relative;flex:1;height:32px">
          <span class="abs" style="left:0;top:0;opacity:${aOp}">github.com/<span style="color:var(--text)">liam-machine/erd-studio-sample</span></span>
          <span class="abs" style="left:0;top:0;opacity:${bOp}"><span style="color:var(--text)">fluffy-space-waddle-q7r4</span>.github.dev</span></span></div></div>`;

    // ---- phase A: the repo page ----
    if (b < 1) {
      let a = '';
      const top = ADDR + 30;
      a += `<div class="abs" style="left:40px;top:${top}px;display:flex;align-items:center;gap:14px;font-size:36px;white-space:nowrap">
        <span style="color:var(--text-2)">${repoIcon(34)}</span><span style="color:var(--link)">liam-machine</span><span style="color:var(--text-3)">/</span><b style="color:var(--link);font-weight:700">erd-studio-sample</b>
        <span class="pill" style="font-size:24px;font-weight:600;padding:3px 14px;border:1px solid #3a3d45;color:var(--text-2)">Public</span></div>`;
      a += `<div class="abs" style="left:40px;top:${top + 58}px;font-size:28px;color:var(--text-2);white-space:nowrap">Jaffle Shop, Kimball edition · a small dbt project</div>`;
      // file list
      const files = [['.erd-studio', 1], ['models', 1], ['seeds', 1], ['target', 1], ['dbt_project.yml', 0]];
      const fy = BTN.y - BY + BTN.h + 40, rowH = 58;
      a += `<div class="abs" style="left:40px;right:40px;top:${fy}px;height:${files.length * rowH}px;border:1px solid var(--card-border);border-radius:12px;overflow:hidden">${files
        .map(([f, dir], i) => `<div style="height:${rowH}px;display:flex;align-items:center;gap:14px;padding:0 20px;font-size:26px;${i ? 'border-top:1px solid var(--row-line);' : ''}white-space:nowrap">
            <span style="color:${dir ? '#7d8ea8' : 'var(--text-3)'}">${dir ? ICON.folder({ size: 26 }) : ICON.file({ size: 24 })}</span><span class="mono" style="font-size:25px">${f}</span></div>`)
        .join('')}</div>`;
      body += `<div class="abs" style="left:0;top:0;right:0;bottom:0;opacity:${aOp}">${a}</div>`;
    }

    // ---- phase B: the codespace, the diagram already open ----
    if (b > 0) {
      let e = '';
      e += `<div class="abs grid-bg" style="left:0;right:0;top:${ADDR}px;bottom:0"></div>`;
      if (t < loadEnd + 0.2) {
        e += `<div class="abs" style="left:0;right:0;top:330px;display:flex;justify-content:center;align-items:center;gap:14px;font-size:26px;color:var(--text-2);opacity:${(1 - seg(t, loadEnd, loadEnd + 0.2)).toFixed(3)}">${spinner(t, 28)}Opening codespace</div>`;
      }
      body += `<div class="abs" style="left:0;top:0;right:0;bottom:0;opacity:${bOp}">${e}</div>`;
    }

    let html = card({
      x: WX, y: WY, w: WW, h: WH, dots: true, headStyle: 'font-size:24px',
      tabs: [{ label: tabLabel, on: true, icon: `<span style="color:var(--text-3)">${ICON.globe({ size: 22 })}</span>` }],
      body,
    });

    // ---- the button (frame space, so it can press and fade on the swap) ----
    if (b < 1) {
      const pr = seg(t, pressAt, pressAt + 0.18);
      const sc = 1 - 0.035 * Math.sin(Math.PI * pr);
      const lit = t >= pressAt ? 1 : 0;
      html += `<div class="abs" style="left:${BTN.x}px;top:${BTN.y}px;width:${BTN.w}px;height:${BTN.h}px;border-radius:14px;background:${lit ? '#16a34a' : '#15803d'};border:2px solid ${lit ? '#4ade80' : '#22c55e'};
        color:#fff;display:flex;align-items:center;justify-content:center;gap:16px;font-size:34px;font-weight:700;white-space:nowrap;box-shadow:0 10px 30px #0008;
        transform:scale(${sc.toFixed(4)});${appear(t, btnAt, { dy: 12 })}opacity:${(Math.min(easeOut(seg(t, btnAt, btnAt + 0.35)), 1 - b)).toFixed(3)}">${codeIcon(36)}Open in GitHub Codespaces</div>`;
    }

    // ---- pointer: in from the lower right, clicks the button, then leaves with the page ----
    if (t >= moveAt && t < swapAt + 0.3) {
      const bx = BTN.x + BTN.w - 110, byy = BTN.y + BTN.h / 2 + 6;
      const p = path(t, [{ t: moveAt, x: 930, y: 1040 }, { t: pressAt - 0.05, x: bx, y: byy }]);
      html += `<div class="abs" style="left:0;top:0;opacity:${(1 - seg(t, swapAt, swapAt + 0.25)).toFixed(3)}">${pointer(p.x, p.y, seg(t, pressAt, pressAt + 0.45))}</div>`;
    }

    // ---- the diagram, at exactly the scene-4 size and positions (frame space) ----
    if (t >= loadEnd) html += `<div class="abs" style="left:0;top:0;opacity:${bOp}">${ordersDiagram(t, loadEnd, DY)}</div>`;

    // ---- "Nothing to install." → a pill in the toolbar row, where scene 4 put "Auto layout" ----
    if (t >= pillAt) {
      html += `<span class="abs pill" style="right:${1080 - (WX + WW - 24)}px;top:${ORDERS_LAYOUT.toolbar.y + DY + 6}px;font-size:26px;padding:9px 20px;gap:12px;background:#13301f;color:var(--green);border:2px solid var(--green);${appear(t, pillAt, { dy: 8 })}">${ICON.globe({ size: 26 })}Runs in your browser</span>`;
    }
    return html;
  },
};
