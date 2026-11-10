// readme · 9 · draft — "A draft first, then DBML in Git." Whichever import is picked, the draft
// preview (src/services/draftModel.ts) comes first: the banner's "Draft from 4 SQL files
// (Snowflake) · 6 tables, 5 relationships · not saved", where Keep saves it, Change options…,
// then Keep as Diagram · More ways to start ▾ · Discard, over the drafted tables (dashed: not
// saved). The pointer presses Keep as Diagram on "keep it"; the tab becomes shop.dbml and the
// tables turn solid. `keep`: what Keep wrote, as the Explorer shows it — the diagram file plus
// one .dbml per table and the layer's relationships file — then "edit by hand" and "or with your
// AI" on their words.
import { appear, card, easeOut, ICON, path, pointer, seg } from '../../lib.js';
import { FILE_COL, wordAt } from './story.js';

const X = 64, W = 952;
// The drafted shop: six tables, five relationships (orders hub).
const TABLES = [
  { n: 'customers', x: 40, y: 40 }, { n: 'stores', x: 40, y: 200 },
  { n: 'orders', x: 330, y: 120 },
  { n: 'order_items', x: 610, y: 40 }, { n: 'payments', x: 610, y: 200 }, { n: 'products', x: 610, y: 330 },
];
const LINKS = [['orders', 'customers'], ['orders', 'stores'], ['order_items', 'orders'], ['payments', 'orders'], ['order_items', 'products']];
const TW = 230, TH = 64;

export default {
  render(t, { beats, scene }) {
    const Dr = beats.draft.t, K = beats.keep.t;
    const keepAt = wordAt(scene, 'draft', 'keep');
    const BY = 300, BH = 1088 - BY;
    const kept = t >= keepAt + 0.15;
    let body = '';
    // Banner
    const press = seg(t, keepAt, keepAt + 0.12) * (1 - seg(t, keepAt + 0.3, keepAt + 0.5));
    const bannerOp = 1 - seg(t, keepAt + 0.35, keepAt + 0.7);
    if (bannerOp > 0) body += `<div class="abs" style="left:0;right:0;top:0;padding:18px 26px 18px;background:#1f2a3a;border-bottom:1px solid #2d4a70;opacity:${bannerOp.toFixed(3)}">
      <div style="font-size:24px;font-weight:700;line-height:1.3;white-space:nowrap">Draft from 4 SQL files (Snowflake) <span style="color:var(--text-2)">·</span> 6 tables, 5 relationships <span style="color:var(--text-2)">·</span> <span style="color:var(--amber)">not saved</span></div>
      <div style="margin-top:6px;font-size:20px;color:var(--text-2);white-space:nowrap">Keep saves it as shop in the Gold layer (.erd-studio/gold/diagrams/shop.dbml).</div>
      <div style="margin-top:6px;font-size:20px;white-space:nowrap"><span style="color:var(--blue)">Change options…</span></div>
      <div style="margin-top:14px;display:flex;align-items:center;gap:12px">
        <span class="btn btn--primary" style="font-size:22px;${press > 0 ? 'background:#1177bb;transform:scale(.97);' : ''}">Keep as Diagram</span>
        <span class="btn" style="font-size:22px;background:#2a2c33;color:var(--text);border:1px solid #3a3d45">More ways to start <span style="font-size:16px;color:var(--text-2)">▾</span></span>
        <span class="btn" style="font-size:22px;background:#2a2c33;color:var(--text);border:1px solid #3a3d45">Discard</span></div></div>`;
    // Drafted tables
    const pos = Object.fromEntries(TABLES.map((tb) => [tb.n, tb]));
    const oy = 236;
    let lines = '';
    LINKS.forEach(([a, b], i) => {
      const A = pos[a], B = pos[b];
      const ax = A.x < B.x ? A.x + TW : A.x, bx = A.x < B.x ? B.x : B.x + TW;
      const p = easeOut(seg(t, Dr + 0.3 + i * 0.08, Dr + 0.7 + i * 0.08));
      lines += `<path d="M${ax} ${oy + A.y + TH / 2} C${(ax + bx) / 2} ${oy + A.y + TH / 2} ${(ax + bx) / 2} ${oy + B.y + TH / 2} ${bx} ${oy + B.y + TH / 2}" fill="none" stroke="${kept ? '#60a5fa' : '#6c7f99'}" stroke-width="3" ${kept ? '' : 'stroke-dasharray="8 7"'} opacity="${p.toFixed(3)}"/>`;
    });
    body += `<svg class="abs" style="left:24px;top:0;overflow:visible" width="1" height="1">${lines}</svg>`;
    TABLES.forEach((tb, i) => {
      body += `<div class="abs" style="left:${24 + tb.x}px;top:${oy + tb.y}px;width:${TW}px;height:${TH}px;border-radius:12px;background:#17181c;border:3px ${kept ? 'solid var(--logical)' : 'dashed #6c7f99'};display:flex;align-items:center;gap:10px;padding:0 16px;font-size:24px;font-weight:700;white-space:nowrap;${appear(t, Dr + 0.1 + i * 0.06, { dy: 10 })}">${ICON.table({ size: 22 })}${tb.n}</div>`;
    });
    // `keep`: what Keep wrote, top of the canvas where the banner was.
    if (t >= K - 0.2) {
      const f = (ic, name, k, extra = '') => `<div style="display:flex;align-items:center;gap:12px;height:38px;white-space:nowrap;${appear(t, K + k * 0.12, { dy: 0, dx: -10 })}"><span style="color:${FILE_COL.dbml};display:flex">${ic}</span><span class="mono" style="font-size:22px">${name}</span>${extra}</div>`;
      const n = (s) => `<span style="font-size:20px;color:var(--text-2)">${s}</span>`;
      body += `<div class="abs" style="left:24px;top:22px;padding:14px 22px;border-radius:14px;background:#1c1e23;border:1px solid #34363d;box-shadow:0 18px 44px #000a;${appear(t, K - 0.2, { dy: 10 })}">
        <div style="font-size:18px;font-weight:700;letter-spacing:.08em;color:var(--text-2);margin-bottom:6px">.ERD-STUDIO/GOLD/ · SAVED AS DBML</div>
        ${f(ICON.file({ size: 22 }), 'diagrams/shop.dbml', 0)}
        ${f(ICON.file({ size: 22 }), 'tables/…/&lt;table&gt;.dbml', 1, n('× 6'))}
        ${f(ICON.file({ size: 22 }), 'relationships/gold.dbml', 2)}</div>`;
      const handAt = wordAt(scene, 'keep', 'hand'), aiAt = wordAt(scene, 'keep', 'AI');
      body += `<div class="abs" style="right:24px;top:40px;display:flex;flex-direction:column;align-items:flex-end;gap:12px">
        ${t >= handAt - 0.15 ? `<span class="pill" style="font-size:25px;padding:8px 20px;gap:10px;background:#1b2a40;color:#cfe3ff;border:1px solid #2d4a70;${appear(t, handAt - 0.15, { dy: 8 })}">${ICON.check({ size: 20 })}edit by hand</span>` : ''}
        ${t >= aiAt - 0.25 ? `<span class="pill" style="font-size:25px;padding:8px 20px;gap:10px;background:#2a1d17;color:#f3c3ab;border:1px solid #6b3f2a;${appear(t, aiAt - 0.25, { dy: 8 })}"><span style="color:var(--claude);display:flex">${ICON.claude({ size: 22 })}</span>or with your AI</span>` : ''}</div>`;
    }
    let html = card({
      x: X, y: BY, w: W, h: BH, tabs: [{ label: kept ? 'shop.dbml' : 'Draft: shop', on: true, icon: kept ? `<span style="color:${FILE_COL.dbml}">${ICON.file({ size: 20 })}</span>` : '' }],
      crumb: kept ? '.erd-studio › gold › diagrams' : 'nothing is written until you keep it',
      bodyCls: 'grid-bg', body,
    });
    // Pointer onto Keep as Diagram.
    const kx = X + 26 + 110, ky = BY + 64 + 18 + 32 + 26 + 32 + 14 + 26;
    if (t >= keepAt - 0.9 && t < keepAt + 1.3) {
      const pt = path(t, [{ t: keepAt - 0.9, x: 700, y: 900 }, { t: keepAt - 0.05, x: kx, y: ky }, { t: keepAt + 0.6, x: kx, y: ky }, { t: keepAt + 1.2, x: kx + 160, y: ky + 220 }]);
      const op = Math.min(seg(t, keepAt - 0.9, keepAt - 0.6), 1 - seg(t, keepAt + 0.7, keepAt + 1.2));
      html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, keepAt, keepAt + 0.35))}</div>`;
    }
    return html;
  },
};
