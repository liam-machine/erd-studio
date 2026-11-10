// launch · 4 · draft — "A draft first, then DBML in Git." The file from the export scene goes
// through the product, briefly:
//   import  ERD Studio's Import… picker (src/commands/importModel.ts: title, placeholder,
//           IMPORT_SOURCE_ITEMS labels and details, then the guide), SQL DDL scripts picked; on
//           "draft" the draft preview replaces it (src/services/draftModel.ts): the banner's
//           "Draft from 1 SQL file (PostgreSQL) · 6 tables, 5 relationships · not saved", where
//           Keep saves it, Change options…, then Keep as Diagram · More ways to start ▾ · Discard,
//           over the drafted tables (dashed: not saved).
//   keep    the pointer presses Keep as Diagram on its words; the tab becomes sales.dbml, the
//           tables turn solid, and on "DBML files in your repo" what Keep wrote shows in the
//           corner: the diagram file, one .dbml per table and the layer's relationships file.
import { appear, card, easeOut, ICON, path, pointer, seg } from '../../lib.js';
import { FILE_COL, quickPick, wordAt } from '../readme/story.js';
import { DRAFT, S } from './story.js';

const X = 64, W = 952;
const tile = (inner, size = 52) => `<span style="flex:none;width:${size}px;height:${size}px;border-radius:12px;background:#f4f5f7;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px #ffffff1f">${inner}</span>`;
const dbGlyph = tile(`<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#3b4250" stroke-width="2"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>`);
const dbmlBadge = tile('<span style="font:800 15px/1 Inter;letter-spacing:.02em;color:#b06a12">DBML</span>');
const pbi = tile('<img src="/social-video/player/assets/logos/power-bi.svg" width="40" height="40" style="display:block">');
const guide = tile('<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#3b4250" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01"/></svg>');
// Import…'s rows, as the product labels them (importModel.ts IMPORT_SOURCE_ITEMS + the guide item).
const SOURCES = [
  { label: 'DBML file', detail: 'A .dbml file from dbdiagram.io or any DBML tool (an open format)', icon: dbmlBadge },
  { label: 'SQL DDL scripts', detail: 'CREATE TABLE .sql files: PostgreSQL, MySQL, SQL Server, Snowflake, Databricks, Oracle, BigQuery, Redshift or SQLite', icon: dbGlyph },
  { label: 'Power BI or Fabric semantic model', detail: 'A <Name>.SemanticModel folder (TMDL or model.bim), or a Tabular Editor Save to Folder model', icon: pbi },
  { label: 'Bring In Your Data Model…', detail: 'How to export from Databricks, Snowflake, Power BI, Fabric and more', icon: guide },
];

// The drafted sales schema: six tables, five relationships (orders in the middle).
const TABLES = [
  { n: 'customers', x: 30, y: 40 }, { n: 'stores', x: 30, y: 210 },
  { n: 'orders', x: 330, y: 125 },
  { n: 'order_items', x: 620, y: 40 }, { n: 'products', x: 620, y: 250 }, { n: 'payments', x: 330, y: 330 },
];
const LINKS = [['orders', 'customers'], ['orders', 'stores'], ['order_items', 'orders'], ['payments', 'orders'], ['order_items', 'products']];
const TW = 250, TH = 66;

export default {
  render(t, { beats, scene }) {
    const I = beats.import.t, K = beats.keep.t;
    const pickAt = I + 0.35;                          // SQL DDL scripts is picked as "Import…" is said
    const draftAt = wordAt(scene, 'import', 'draft') - 0.35;
    const keepAt = K + 0.25;                          // "Keep as Diagram" — the press
    const filesAt = wordAt(scene, 'keep', 'DBML files') - 0.2;
    const kept = t >= keepAt + 0.15;
    let html = '';

    // ---- Import… ----
    const pickOut = easeOut(seg(t, draftAt - 0.1, draftAt + 0.25));
    if (pickOut < 1) {
      html += `<div class="abs" style="left:0;top:0;opacity:${(1 - pickOut).toFixed(3)};transform:translateY(${(-20 * pickOut).toFixed(1)}px)">${quickPick({
        x: X, y: 300, w: W, title: 'Import', placeholder: 'What would you like to start your data model from?',
        items: SOURCES.map((s) => ({ ...s, indent: 64 })), sel: t >= pickAt ? 1 : -1, rowH: 92,
      })}</div>`;
    }
    if (t < draftAt - 0.1) return html;

    // ---- the draft ----
    const BY = 300, BH = 1088 - BY;
    let body = '';
    const press = seg(t, keepAt, keepAt + 0.12) * (1 - seg(t, keepAt + 0.3, keepAt + 0.5));
    const bannerOp = 1 - seg(t, keepAt + 0.35, keepAt + 0.7);
    const [h1, h2, h3] = DRAFT.headline;
    if (bannerOp > 0) body += `<div class="abs" style="left:0;right:0;top:0;padding:18px 24px 18px;background:#1f2a3a;border-bottom:1px solid #2d4a70;opacity:${bannerOp.toFixed(3)}">
      <div style="font-size:23px;font-weight:700;line-height:1.3;white-space:nowrap">${h1} <span style="color:var(--text-2)">·</span> ${h2} <span style="color:var(--text-2)">·</span> <span style="color:var(--amber)">${h3}</span></div>
      <div style="margin-top:6px;font-size:20px;color:var(--text-2);white-space:nowrap">${DRAFT.detail}</div>
      <div style="margin-top:6px;font-size:20px;white-space:nowrap"><span style="color:var(--blue)">Change options…</span></div>
      <div style="margin-top:14px;display:flex;align-items:center;gap:12px">
        <span class="btn btn--primary" style="font-size:22px;${press > 0 ? 'background:#1177bb;transform:scale(.97);' : ''}">Keep as Diagram</span>
        <span class="btn" style="font-size:22px;background:#2a2c33;color:var(--text);border:1px solid #3a3d45">More ways to start <span style="font-size:16px;color:var(--text-2)">▾</span></span>
        <span class="btn" style="font-size:22px;background:#2a2c33;color:var(--text);border:1px solid #3a3d45">Discard</span></div></div>`;
    const pos = Object.fromEntries(TABLES.map((tb) => [tb.n, tb]));
    const oy = 236;
    let lines = '';
    LINKS.forEach(([a, b], i) => {
      const A = pos[a], B = pos[b];
      const p = easeOut(seg(t, draftAt + 0.3 + i * 0.08, draftAt + 0.7 + i * 0.08));
      let d;
      if (Math.abs(A.x - B.x) < 10) {             // one above the other: bottom to top
        const [U, D] = A.y < B.y ? [A, B] : [B, A];
        const x = U.x + TW / 2, y0 = oy + U.y + TH, y1 = oy + D.y;
        d = `M${x} ${y0} V${y1}`;
      } else {
        const ax = A.x < B.x ? A.x + TW : A.x, bx = A.x < B.x ? B.x : B.x + TW;
        d = `M${ax} ${oy + A.y + TH / 2} C${(ax + bx) / 2} ${oy + A.y + TH / 2} ${(ax + bx) / 2} ${oy + B.y + TH / 2} ${bx} ${oy + B.y + TH / 2}`;
      }
      lines += `<path d="${d}" fill="none" stroke="${kept ? '#60a5fa' : '#6c7f99'}" stroke-width="3" ${kept ? '' : 'stroke-dasharray="8 7"'} opacity="${p.toFixed(3)}"/>`;
    });
    body += `<svg class="abs" style="left:24px;top:0;overflow:visible" width="1" height="1">${lines}</svg>`;
    TABLES.forEach((tb, i) => {
      body += `<div class="abs" style="left:${24 + tb.x}px;top:${oy + tb.y}px;width:${TW}px;height:${TH}px;border-radius:12px;background:#17181c;border:3px ${kept ? 'solid var(--logical)' : 'dashed #6c7f99'};display:flex;align-items:center;gap:10px;padding:0 16px;font-size:25px;font-weight:700;white-space:nowrap;${appear(t, draftAt + 0.1 + i * 0.06, { dy: 10 })}">${ICON.table({ size: 22 })}${tb.n}</div>`;
    });
    // What Keep wrote, where the banner was.
    if (t >= filesAt) {
      const f = (name, k, extra = '') => `<div style="display:flex;align-items:center;gap:12px;height:40px;white-space:nowrap;${appear(t, filesAt + k * 0.12, { dy: 0, dx: -10 })}"><span style="color:${FILE_COL.dbml};display:flex">${ICON.file({ size: 22 })}</span><span class="mono" style="font-size:23px">${name}</span>${extra}</div>`;
      const n = (s) => `<span style="font-size:21px;color:var(--text-2)">${s}</span>`;
      body += `<div class="abs" style="left:24px;top:24px;padding:14px 22px;border-radius:14px;background:#1c1e23;border:1px solid #34363d;box-shadow:0 18px 44px #000a;${appear(t, filesAt, { dy: 10 })}">
        <div style="font-size:19px;font-weight:700;letter-spacing:.08em;color:var(--text-2);margin-bottom:6px">.ERD-STUDIO/GOLD/ · SAVED AS DBML</div>
        ${f('diagrams/sales.dbml', 0)}
        ${f(`tables/${S.schema}/&lt;table&gt;.dbml`, 1, n('× 6'))}
        ${f('relationships/gold.dbml', 2)}</div>`;
    }
    html += card({
      x: X, y: BY, w: W, h: BH, tabs: [{ label: kept ? 'sales.dbml' : 'Draft: sales', on: true, icon: kept ? `<span style="color:${FILE_COL.dbml}">${ICON.file({ size: 20 })}</span>` : '' }],
      crumb: kept ? '.erd-studio › gold › diagrams' : 'nothing is written until you keep it',
      bodyCls: 'grid-bg', body, style: appear(t, draftAt - 0.1, { dy: 16 }),
    });
    // Pointer onto Keep as Diagram.
    const kx = X + 24 + 110, ky = BY + 64 + 18 + 30 + 26 + 32 + 14 + 26;
    if (t >= keepAt - 0.9 && t < keepAt + 1.3) {
      const pt = path(t, [{ t: keepAt - 0.9, x: 700, y: 900 }, { t: keepAt - 0.05, x: kx, y: ky }, { t: keepAt + 0.6, x: kx, y: ky }, { t: keepAt + 1.2, x: kx + 160, y: ky + 220 }]);
      const op = Math.min(seg(t, keepAt - 0.9, keepAt - 0.6), 1 - seg(t, keepAt + 0.7, keepAt + 1.2));
      html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, keepAt, keepAt + 0.35))}</div>`;
    }
    return html;
  },
};
