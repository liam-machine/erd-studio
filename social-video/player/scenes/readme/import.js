// readme · 8 · import — "Bring in what you have." Two real screens, each source's official logo in
// place of its codicon (assets/logos/, see LOGOS.md).
// `from`, on "dbt": the empty Diagrams view of a dbt project, as package.json's viewsWelcome draws
// it — "No diagrams yet. This folder is a dbt project.", the Draw from dbt button and "Or: More ways
// to start…" (src/types/startActions.ts labels; the view header carries the extension's own
// activity-bar icon, media/icon-sidebar.svg). On "import": ERD Studio's Import… picker
// (src/commands/importModel.ts: title Import, its placeholder, IMPORT_SOURCE_ITEMS' labels and
// details in IMPORT_MODEL_SOURCES order, then the import guide's item), the SQL row carrying the
// five dialects its detail names (src/services/sqlDdlImport.ts). Power BI, SQL and DBML light on
// their words; it settles on SQL DDL scripts. MySQL's chip has no logo: Oracle allows the MySQL
// logo only under a written agreement (LOGOS.md). `draft`: the draft preview
// (src/services/draftModel.ts) — the banner's "Draft from … · 6 tables, 5 relationships · not
// saved", where Keep saves it, Keep as Diagram, Change options… — over the drafted tables; the
// pointer presses Keep on "keep it". `export`: Export Diagram's format picker (Mermaid, DBML, Rich
// DBML) over the saved diagram.
import { appear, appearFade, card, easeOut, ICON, lerp, path, pointer, seg } from '../../lib.js';
import { FILE_COL, quickPick, wordAt } from './story.js';

const X = 64, W = 952;
const INDENT = 64;   // tile 52 + gap 12: the detail sits under the label, as VS Code indents it past the icon
const LOGO = (f) => `/social-video/player/assets/logos/${f}`;
// A brand mark on a light tile, so every logo keeps its own colours on the dark picker.
const tile = (inner, size = 52) => `<span style="flex:none;width:${size}px;height:${size}px;border-radius:12px;background:#f4f5f7;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px #ffffff1f">${inner}</span>`;
const logo = (f, size = 42, tileSize = 52) => tile(`<img src="${LOGO(f)}" width="${size}" height="${size}" style="display:block;width:${size}px;height:${size}px">`, tileSize);
// DBML has no official mark of its own (dbdiagram.io's is its product's): a plain text badge.
const dbmlBadge = tile('<span style="font:800 15px/1 Inter;letter-spacing:.02em;color:#b06a12">DBML</span>');
const dbGlyph = tile(`<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#3b4250" stroke-width="2"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>`);
// The CREATE TABLE dialects the SQL import reads, in its detail's order (no file: no logo).
const DIALECTS = [['postgresql.svg', 'PostgreSQL'], [null, 'MySQL'], ['sql-server.svg', 'SQL Server'], ['snowflake.svg', 'Snowflake'], ['databricks.svg', 'Databricks']];
// Import…'s rows: IMPORT_SOURCE_ITEMS in IMPORT_MODEL_SOURCES order (nothing found here), then the guide.
const SOURCES = [
  { label: 'DBML file', detail: 'A .dbml file from dbdiagram.io or any DBML tool (an open format)', word: 'DBML', icon: dbmlBadge },
  { label: 'SQL DDL scripts', detail: 'CREATE TABLE .sql files: PostgreSQL, MySQL, SQL Server, Snowflake or Databricks', word: 'SQL', icon: dbGlyph, sql: true },
  { label: 'Power BI or Fabric semantic model', detail: 'A <Name>.SemanticModel folder, saved as TMDL or as model.bim', word: 'Power', icon: logo('power-bi.svg', 44) },
  { label: 'Bring In Your Data Model…', detail: 'How to export from Databricks, Snowflake, Power BI, Fabric and more' },
];
const SQL_I = SOURCES.findIndex((s) => s.sql);
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

const question = `<svg class="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01"/></svg>`;
const fileCode = `<svg class="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M10 13l-2 2 2 2M14 13l2 2-2 2"/></svg>`;
const guideIcon = tile(`<span style="color:#3b4250;display:flex">${question.replace('width="24" height="24"', 'width="30" height="30"')}</span>`);

/** The SQL row's dialect chips: shown dimmed, each lights with a small pop after `at`, one by one. */
function dialectStrip(t, at) {
  const chips = DIALECTS.map(([f, name], k) => {
    const p = easeOut(seg(t, at + k * 0.1, at + 0.3 + k * 0.1));
    const pop = Math.sin(Math.PI * p) * 0.06;
    const mark = f ? `<img src="${LOGO(f)}" width="28" height="28" style="display:block;width:28px;height:28px">` : '';
    return `<span style="display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 14px 0 ${f ? 8 : 14}px;border-radius:20px;background:#f4f5f7;color:#22262e;font-size:19px;font-weight:600;opacity:${lerp(0.5, 1, p).toFixed(3)};transform:scale(${(1 + pop).toFixed(3)})">${mark}${name}</span>`;
  }).join('');
  return `<div style="margin-top:12px;margin-left:${INDENT}px;display:flex;gap:10px">${chips}</div>`;
}

export default {
  render(t, { beats, scene }) {
    const F = beats.from.t, Dr = beats.draft.t, E = beats.export.t;
    let html = '';

    // ================= from: the Diagrams view's dbt start, then Import… =================
    const pickOut = seg(t, Dr - 0.45, Dr - 0.2);
    if (pickOut < 1) {
      const dbtAt = wordAt(scene, 'from', 'dbt');
      const importAt = wordAt(scene, 'from', 'import') - 0.15;
      // The empty Diagrams view of a dbt project (package.json viewsWelcome); Draw from dbt lights on "dbt".
      const glow = easeOut(seg(t, dbtAt, dbtAt + 0.25)) * (1 - 0.7 * seg(t, importAt, importAt + 0.4));
      const dim = seg(t, importAt, importAt + 0.3);
      // The activity bar (the extension's own icon, active) beside the sidebar's Diagrams view.
      const actIcon = `<span style="width:32px;height:32px;background:#e9ecef;-webkit-mask:url(/media/icon-sidebar.svg) center/contain no-repeat;mask:url(/media/icon-sidebar.svg) center/contain no-repeat"></span>`;
      html += `<div class="abs" style="left:${X}px;top:300px;width:${W}px;height:240px;border-radius:14px;background:#1f2126;border:1px solid #3a3d45;box-shadow:0 24px 60px #000c;overflow:hidden;display:flex;${appearFade(t, 0.05, 1 - pickOut, { dy: -10 })}${dim > 0 ? `filter:brightness(${lerp(1, 0.6, dim).toFixed(3)});` : ''}">
        <div style="flex:none;width:68px;background:#18191c;border-right:1px solid #2c2e34;position:relative">
          <div style="position:absolute;left:0;top:10px;width:4px;height:52px;background:#e9ecef"></div>
          <div style="position:absolute;left:0;right:0;top:10px;height:52px;display:flex;align-items:center;justify-content:center">${actIcon}</div></div>
        <div style="flex:1;min-width:0">
          <div style="height:42px;display:flex;align-items:center;padding:0 20px;font-size:16px;font-weight:600;letter-spacing:.08em;color:var(--text-2)">ERD STUDIO</div>
          <div style="height:36px;display:flex;align-items:center;gap:6px;padding:0 12px;border-top:1px solid #2c2e34;font-size:16px;font-weight:700;letter-spacing:.06em;color:var(--text)">${ICON.chevDown({ size: 18, sw: 2.6 })}DIAGRAMS</div>
          <div style="padding:12px 24px 0">
            <div style="font-size:23px;color:var(--text);white-space:nowrap">No diagrams yet. This folder is a dbt project.</div>
            <div style="margin-top:12px;display:flex;align-items:center;gap:14px">${logo('dbt.svg', 40)}
              <span class="btn btn--primary" style="flex:1;justify-content:center;font-size:23px;height:52px;padding:0 20px;box-shadow:0 0 0 ${(3 * glow).toFixed(2)}px rgba(244,180,44,${(0.9 * glow).toFixed(3)}), 0 0 ${Math.round(30 * glow)}px rgba(244,180,44,${(0.45 * glow).toFixed(3)})">Draw from dbt</span></div>
            <div style="margin-top:10px;font-size:21px;color:var(--text-2);white-space:nowrap">Or: <span style="color:var(--blue)">More ways to start…</span></div>
          </div></div></div>`;

      // ERD Studio's Import… picker, on "import": each source lights on its word.
      if (t >= importAt) {
        const at = SOURCES.map((s) => (s.word ? wordAt(scene, 'from', s.word) : Infinity));
        const hot = at.map((a, i) => (i === SQL_I ? 0 : easeOut(seg(t, a, a + 0.25)) * (1 - 0.6 * seg(t, a + 0.9, a + 1.3))));
        const sel = t >= at[SQL_I] ? SQL_I : -1;
        html += quickPick({
          x: X, y: 556, w: W, title: 'Import', placeholder: 'What would you like to start your data model from?',
          items: SOURCES.map((s, i) => ({
            label: s.label, detail: s.detail, icon: s.icon ?? guideIcon, indent: INDENT,
            ...(s.sql ? { h: 134, extra: dialectStrip(t, at[i]) } : {}),
          })), sel, hot, rowH: 84,
          style: appearFade(t, importAt, 1 - pickOut, { dy: -12 }),
        });
      }
    }

    // ================= draft: the preview, then Keep =================
    const keepAt = wordAt(scene, 'draft', 'keep');
    if (t >= Dr - 0.25) {
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
        bodyCls: 'grid-bg', body, style: `${appear(t, Dr - 0.25, { dy: 24 })}${expOn > 0 ? `filter:brightness(${lerp(1, 0.55, expOn).toFixed(3)});` : ''}`,
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
