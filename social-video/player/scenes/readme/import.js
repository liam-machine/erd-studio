// readme · 8 · import — "Bring in what you have." `from`: ERD Studio's Import… picker (title
// Import, its real placeholder and the three sources' real labels and details from
// src/commands/importModel.ts, then the import guide) lights each source on its word and settles
// on SQL DDL scripts. `draft`: the draft preview (src/services/draftModel.ts) — the banner's
// "Draft from … · 6 tables, 5 relationships · not saved", where Keep saves it, Keep as Diagram,
// Change options… — over the drafted tables; the pointer presses Keep on "keep it". `export`:
// Export Diagram's format picker (Mermaid, DBML, Rich DBML) over the saved diagram.
import { appear, appearFade, card, easeOut, ICON, lerp, path, pointer, seg } from '../../lib.js';
import { FILE_COL, quickPick, wordAt } from './story.js';

const X = 64, W = 952;
const SOURCES = [
  { label: 'DBML file', detail: 'A .dbml file from dbdiagram.io or any DBML tool (an open format)', word: 'DBML' },
  { label: 'SQL DDL scripts', detail: 'CREATE TABLE .sql files: PostgreSQL, MySQL, SQL Server, Snowflake or Databricks', word: 'SQL' },
  { label: 'Power BI or Fabric semantic model', detail: 'A <Name>.SemanticModel folder, saved as TMDL or as model.bim', word: 'Power' },
  { label: 'Bring In Your Data Model…', detail: 'How to export from Databricks, Snowflake, Power BI, Fabric and more' },
];
const FORMATS = [
  { label: 'Mermaid', desc: '.mmd', detail: 'Renders in GitHub, GitLab and Markdown docs' },
  { label: 'DBML', desc: '.dbml', detail: "Opens in any DBML tool. ERD Studio's fields go in notes; no table positions" },
  { label: 'Rich DBML', desc: '.dbml', detail: 'Every ERD Studio field, positions in erd_layout. Needs DBML 9.1 or later, as dbdiagram.io and dbdocs read' },
];
// The drafted shop: six tables, five relationships (orders hub).
const TABLES = [
  { n: 'customers', x: 40, y: 40 }, { n: 'stores', x: 40, y: 200 },
  { n: 'orders', x: 330, y: 120 },
  { n: 'order_items', x: 610, y: 40 }, { n: 'payments', x: 610, y: 200 }, { n: 'products', x: 610, y: 330 },
];
const LINKS = [['orders', 'customers'], ['orders', 'stores'], ['order_items', 'orders'], ['payments', 'orders'], ['order_items', 'products']];
const TW = 230, TH = 64;

const icon = (svg) => `<span style="color:var(--text-2);display:flex">${svg}</span>`;
const fileCode = `<svg class="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M10 13l-2 2 2 2M14 13l2 2-2 2"/></svg>`;
const db = `<svg class="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>`;
const graph = `<svg class="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/></svg>`;
const question = `<svg class="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01"/></svg>`;
const ICONS = [fileCode, db, graph, question];

export default {
  render(t, { beats, scene }) {
    const F = beats.from.t, Dr = beats.draft.t, E = beats.export.t;
    let html = '';

    // ================= from: the Import picker =================
    const pickOut = seg(t, Dr - 0.4, Dr - 0.05);
    if (pickOut < 1) {
      const at = SOURCES.map((s) => (s.word ? wordAt(scene, 'from', s.word) : Infinity));
      const hot = at.map((a, i) => (i === 1 ? 0 : easeOut(seg(t, a, a + 0.25)) * (1 - 0.6 * seg(t, a + 0.9, a + 1.3))));
      const sel = t >= at[1] ? 1 : -1;
      html += quickPick({
        x: X, y: 300, w: W, title: 'Import', placeholder: 'What would you like to start your data model from?',
        items: SOURCES.map((s, i) => ({ label: s.label, detail: s.detail, icon: icon(ICONS[i]) })), sel, hot, rowH: 90,
        style: appearFade(t, 0.05, 1 - pickOut, { dy: -10 }),
      });
    }

    // ================= draft: the preview, then Keep =================
    const keepAt = wordAt(scene, 'draft', 'keep');
    if (t >= Dr - 0.4) {
      const expOn = seg(t, E - 0.3, E);
      const BY = 300, BH = 1088 - BY;
      const kept = t >= keepAt + 0.15;
      let body = '';
      // Banner
      const press = seg(t, keepAt, keepAt + 0.12) * (1 - seg(t, keepAt + 0.3, keepAt + 0.5));
      const bannerOp = 1 - seg(t, keepAt + 0.35, keepAt + 0.7);
      if (bannerOp > 0) body += `<div class="abs" style="left:0;right:0;top:0;padding:18px 26px 18px;background:#1f2a3a;border-bottom:1px solid #2d4a70;opacity:${bannerOp.toFixed(3)}">
        <div style="font-size:24px;font-weight:700;line-height:1.3;white-space:nowrap">Draft from 4 SQL files (PostgreSQL) <span style="color:var(--text-2)">·</span> 6 tables, 5 relationships <span style="color:var(--text-2)">·</span> <span style="color:var(--amber)">not saved</span></div>
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
      html += card({
        x: X, y: BY, w: W, h: BH, tabs: [{ label: kept ? 'shop.dbml' : 'Draft: shop', on: true, icon: kept ? `<span style="color:${FILE_COL.dbml}">${ICON.file({ size: 20 })}</span>` : '' }],
        crumb: kept ? '.erd-studio › gold › diagrams' : 'nothing is written until you keep it',
        bodyCls: 'grid-bg', body, style: `${appear(t, Dr - 0.4, { dy: 24 })}${expOn > 0 ? `filter:brightness(${lerp(1, 0.55, expOn).toFixed(3)});` : ''}`,
      });
      // Pointer onto Keep as Diagram.
      const kx = X + 26 + 110, ky = BY + 64 + 18 + 32 + 26 + 32 + 14 + 26;
      if (t >= keepAt - 0.9 && t < E - 0.2) {
        const pt = path(t, [{ t: keepAt - 0.9, x: 700, y: 900 }, { t: keepAt - 0.05, x: kx, y: ky }, { t: keepAt + 0.6, x: kx, y: ky }, { t: keepAt + 1.2, x: kx + 160, y: ky + 220 }]);
        const op = Math.min(seg(t, keepAt - 0.9, keepAt - 0.6), 1 - seg(t, keepAt + 0.7, keepAt + 1.2));
        html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, keepAt, keepAt + 0.35))}</div>`;
      }
    }

    // ================= export =================
    if (t >= E - 0.3) {
      const dbmlAt = wordAt(scene, 'export', 'DBML'), merAt = wordAt(scene, 'export', 'Mermaid');
      const sel = t >= merAt ? 0 : t >= dbmlAt ? 1 : -1;
      html += quickPick({
        x: X + 40, y: 420, w: W - 80, title: 'Export Diagram (logical design)', placeholder: 'Export the design of "shop" as…',
        items: FORMATS.map((f) => ({ label: f.label, desc: f.desc, detail: f.detail, icon: `<span style="color:${f.label === 'Mermaid' ? '#ff3670' : FILE_COL.dbml};display:flex">${fileCode}</span>` })),
        sel, rowH: 86, style: appear(t, E - 0.3, { dy: -12 }),
      });
    }
    return html;
  },
};
