// readme · 8 · import — "Already have a model? Bring it in." The ways to build the logical model
// from what a team already has, one at a time, each source's official logo in place of its
// codicon (assets/logos/, see LOGOS.md).
//
// The top is ERD Studio's Import… picker (src/commands/importModel.ts: title Import, its
// placeholder, IMPORT_SOURCE_ITEMS' labels and details in IMPORT_MODEL_SOURCES order, then the
// import guide's item), the SQL row carrying the five dialects its detail names
// (src/services/sqlDdlImport.ts). Under it, one panel at a time shows what each source takes in:
//   open   the sources as logos (what you use)
//   dbml   a .dbml file from any DBML tool
//   sql    CREATE TABLE .sql files — including the DDL exported from Snowflake or Databricks
//          (the import guide's own route for both: export the DDL, save it as .sql)
//   pbi    a <Name>.SemanticModel folder (TMDL or model.bim), from Power BI or Fabric
//   dbt    the empty Diagrams view of a dbt project (package.json viewsWelcome): "No diagrams
//          yet. This folder is a dbt project.", Import from dbt, "Or: More ways to start…" — the
//          picker dims, because Import from dbt is its own start, not an Import… source
//   guide  Bring In Your Data Model… (src/services/importGuide.ts): its card titles
// MySQL has no logo (Oracle allows its mark only under a written agreement) and DBML has none of
// its own: LOGOS.md. draft.js picks up with the draft preview.
import { appear, appearFade, easeOut, ICON, lerp, seg } from '../../lib.js';
import { dbmlLine, quickPick, wordAt } from './story.js';

const X = 64, W = 952;
const INDENT = 64;   // tile 52 + gap 12: the detail sits under the label, as VS Code indents it past the icon
const LOGO = (f) => `/social-video/player/assets/logos/${f}`;
// A brand mark on a light tile, so every logo keeps its own colours on the dark picker.
const tile = (inner, size = 52) => `<span style="flex:none;width:${size}px;height:${size}px;border-radius:12px;background:#f4f5f7;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px #ffffff1f">${inner}</span>`;
const logo = (f, size = 42, tileSize = 52) => tile(`<img src="${LOGO(f)}" width="${size}" height="${size}" style="display:block;width:${size}px;height:${size}px">`, tileSize);
const dbmlBadge = (size = 52) => tile(`<span style="font:800 ${Math.round(size * 0.29)}px/1 Inter;letter-spacing:.02em;color:#b06a12">DBML</span>`, size);
const dbGlyph = (size = 52) => tile(`<svg width="${Math.round(size * 0.58)}" height="${Math.round(size * 0.58)}" viewBox="0 0 24 24" fill="none" stroke="#3b4250" stroke-width="2"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>`, size);
const question = (size) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#3b4250" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01"/></svg>`;
const guideIcon = tile(question(30));
const folderIcon = (col, size = 26) => `<span style="color:${col};display:flex">${ICON.folder({ size })}</span>`;
const fileIcon = (col, size = 24) => `<span style="color:${col};display:flex">${ICON.file({ size })}</span>`;

// The CREATE TABLE dialects the SQL import reads, in its detail's order (no file: no logo).
const DIALECTS = [['postgresql.svg', 'PostgreSQL'], [null, 'MySQL'], ['sql-server.svg', 'SQL Server'], ['snowflake.svg', 'Snowflake'], ['databricks.svg', 'Databricks']];
// Import…'s rows: IMPORT_SOURCE_ITEMS in IMPORT_MODEL_SOURCES order (nothing found here), then the guide.
const SOURCES = [
  { label: 'DBML file', detail: 'A .dbml file from dbdiagram.io or any DBML tool (an open format)', beat: 'dbml', icon: dbmlBadge() },
  { label: 'SQL DDL scripts', detail: 'CREATE TABLE .sql files: PostgreSQL, MySQL, SQL Server, Snowflake or Databricks', beat: 'sql', icon: dbGlyph(), sql: true },
  { label: 'Power BI or Fabric semantic model', detail: 'A <Name>.SemanticModel folder, saved as TMDL or as model.bim', beat: 'pbi', icon: logo('power-bi.svg', 44) },
  { label: 'Bring In Your Data Model…', detail: 'How to export from Databricks, Snowflake, Power BI, Fabric and more', beat: 'guide', icon: guideIcon },
];
const BEATS = ['open', 'dbml', 'sql', 'pbi', 'dbt', 'guide'];

/** The SQL row's dialect chips: dimmed, PostgreSQL/MySQL/SQL Server light as the row is picked, Snowflake and Databricks on their words. */
function dialectStrip(t, ats) {
  const chips = DIALECTS.map(([f, name], k) => {
    const p = easeOut(seg(t, ats[k], ats[k] + 0.3));
    const pop = Math.sin(Math.PI * p) * 0.08;
    const mark = f ? `<img src="${LOGO(f)}" width="28" height="28" style="display:block;width:28px;height:28px">` : '';
    return `<span style="display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 14px 0 ${f ? 8 : 14}px;border-radius:20px;background:#f4f5f7;color:#22262e;font-size:19px;font-weight:600;opacity:${lerp(0.45, 1, p).toFixed(3)};transform:scale(${(1 + pop).toFixed(3)})">${mark}${name}</span>`;
  }).join('');
  return `<div style="margin-top:12px;margin-left:${INDENT}px;display:flex;gap:10px">${chips}</div>`;
}

// ---------- the panel under the picker: what each source takes in ----------
const PY = 846, PH = 242;
const panelBox = (inner, style = '') => `<div class="abs" style="left:${X}px;top:${PY}px;width:${W}px;height:${PH}px;border-radius:16px;background:var(--card);border:1px solid var(--card-border);box-shadow:0 24px 60px #000a;overflow:hidden;${style}">${inner}</div>`;
const heading = (icon, title, sub) => `<div style="display:flex;align-items:center;gap:14px;padding:18px 24px 0;white-space:nowrap">${icon}<div><div style="font-size:26px;font-weight:700">${title}</div><div style="font-size:20px;color:var(--text-2)">${sub}</div></div></div>`;
const chip = (inner, extra = '') => `<span style="display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 14px;border-radius:20px;background:#24262c;border:1px solid #3a3d45;font-size:20px;font-weight:600;white-space:nowrap;${extra}">${inner}</span>`;
const mini = (f, size = 26) => `<img src="${LOGO(f)}" width="${size}" height="${size}" style="display:block;width:${size}px;height:${size}px;background:#f4f5f7;border-radius:6px;padding:2px">`;

const DBML_SAMPLE = ['Table orders {', '  order_id    int [pk]', '  customer_id int [ref: > customers.customer_id]', '}'];
const SQL_SAMPLE = ['CREATE TABLE orders (', '  order_id    INT PRIMARY KEY,', '  customer_id INT REFERENCES customers (customer_id)', ');'];
const sqlLine = (s) => s.replace(/\b(CREATE|TABLE|PRIMARY|KEY|REFERENCES|INT)\b/g, '<span class="kw">$1</span>');
const code = (lines, fmt, x, y, size = 21) => `<div class="abs mono" style="left:${x}px;top:${y}px;font-size:${size}px;line-height:1.5;white-space:pre;color:var(--text-2)">${lines.map(fmt).join('\n')}</div>`;

function panel(which, t, at) {
  switch (which) {
    case 'open': {
      // What you use: the sources, as their marks.
      const marks = [dbmlBadge(64), dbGlyph(64), logo('snowflake.svg', 48, 64), logo('databricks.svg', 48, 64), logo('power-bi.svg', 52, 64), logo('dbt.svg', 46, 64)];
      const names = ['DBML', 'SQL', 'Snowflake', 'Databricks', 'Power BI', 'dbt'];
      return panelBox(`<div style="padding:22px 24px 0;font-size:22px;font-weight:700;letter-spacing:.08em;color:var(--text-2)">FROM WHAT YOU USE</div>
        <div style="display:flex;justify-content:space-around;padding:22px 20px 0">${marks.map((m, i) => `<div style="display:flex;flex-direction:column;align-items:center;gap:10px;${appear(t, at + 0.15 + i * 0.1, { dy: 10 })}">${m}<span style="font-size:20px;font-weight:600;color:var(--text)">${names[i]}</span></div>`).join('')}</div>`);
    }
    case 'dbml':
      return panelBox(`${heading(dbmlBadge(52), 'shop.dbml', 'one file, from any DBML tool')}${code(DBML_SAMPLE, dbmlLine, 100, 106)}`);
    case 'sql':
      return panelBox(`${heading(dbGlyph(52), '4 .sql files', 'CREATE TABLE scripts')}${code(SQL_SAMPLE, sqlLine, 100, 106, 20)}
        <div class="abs" style="right:22px;top:24px;display:flex;flex-direction:column;align-items:flex-end;gap:10px">
          <span style="font-size:19px;color:var(--text-2)">exported from</span>
          ${chip(`${mini('snowflake.svg')}Snowflake`)}${chip(`${mini('databricks.svg')}Databricks`)}</div>`);
    case 'pbi': {
      const rows = [
        [0, folderIcon('#d9b35a'), 'Sales.SemanticModel'],
        [1, folderIcon('#7f8792', 24), 'definition'],
        [2, fileIcon('#e2c08d', 22), 'tables/*.tmdl, relationships.tmdl'],
        [1, fileIcon('#e2c08d', 22), 'or model.bim'],
      ];
      return panelBox(`${heading(logo('power-bi.svg', 44), 'A semantic model', 'from Power BI Desktop (.pbip) or Fabric’s Git integration')}
        <div class="abs" style="left:100px;top:104px;display:flex;flex-direction:column;gap:4px">${rows.map(([d, ic, name]) => `<div style="display:flex;align-items:center;gap:10px;margin-left:${d * 30}px;height:30px;white-space:nowrap">${ic}<span class="mono" style="font-size:21px">${name}</span></div>`).join('')}</div>`);
    }
    case 'dbt': {
      // The empty Diagrams view of a dbt project (package.json viewsWelcome), beside the activity bar.
      const glow = easeOut(seg(t, at + 0.6, at + 0.9));
      const actIcon = `<span style="width:32px;height:32px;background:#e9ecef;-webkit-mask:url(/media/icon-sidebar.svg) center/contain no-repeat;mask:url(/media/icon-sidebar.svg) center/contain no-repeat"></span>`;
      return `<div class="abs" style="left:${X}px;top:${PY}px;width:${W}px;height:${PH}px;border-radius:14px;background:#1f2126;border:1px solid #3a3d45;box-shadow:0 24px 60px #000c;overflow:hidden;display:flex">
        <div style="flex:none;width:68px;background:#18191c;border-right:1px solid #2c2e34;position:relative">
          <div style="position:absolute;left:0;top:10px;width:4px;height:52px;background:#e9ecef"></div>
          <div style="position:absolute;left:0;right:0;top:10px;height:52px;display:flex;align-items:center;justify-content:center">${actIcon}</div></div>
        <div style="flex:1;min-width:0">
          <div style="height:42px;display:flex;align-items:center;padding:0 20px;font-size:16px;font-weight:600;letter-spacing:.08em;color:var(--text-2)">ERD STUDIO</div>
          <div style="height:36px;display:flex;align-items:center;gap:6px;padding:0 12px;border-top:1px solid #2c2e34;font-size:16px;font-weight:700;letter-spacing:.06em;color:var(--text)">${ICON.chevDown({ size: 18, sw: 2.6 })}DIAGRAMS</div>
          <div style="padding:12px 24px 0">
            <div style="font-size:23px;color:var(--text);white-space:nowrap">No diagrams yet. This folder is a dbt project.</div>
            <div style="margin-top:12px;display:flex;align-items:center;gap:14px">${logo('dbt.svg', 40)}
              <span class="btn btn--primary" style="flex:1;justify-content:center;font-size:23px;height:52px;padding:0 20px;box-shadow:0 0 0 ${(3 * glow).toFixed(2)}px rgba(244,180,44,${(0.9 * glow).toFixed(3)}), 0 0 ${Math.round(30 * glow)}px rgba(244,180,44,${(0.45 * glow).toFixed(3)})">Import from dbt</span></div>
            <div style="margin-top:10px;font-size:21px;color:var(--text-2);white-space:nowrap">Or: <span style="color:var(--blue)">More ways to start…</span></div>
          </div></div></div>`;
    }
    case 'guide': {
      // The guide's cards (importGuide.ts SOURCE_CARDS titles), the marks we have beside them.
      const cards = [['dbt.svg', 'dbt'], ['databricks.svg', 'Databricks (Unity Catalog)'], ['snowflake.svg', 'Snowflake'], ['power-bi.svg', 'Power BI'],
        [null, 'Microsoft Fabric'], ['sql-server.svg', 'SQL Server and Azure SQL'], ['postgresql.svg', 'PostgreSQL'], [null, 'MySQL and MariaDB']];
      return panelBox(`${heading(guideIcon, 'Bring In Your Data Model', 'how to export it, tool by tool')}
        <div class="abs" style="left:24px;right:24px;top:100px;display:flex;flex-wrap:wrap;gap:10px">${cards.map(([f, name], i) => chip(`${f ? mini(f) : ''}${name}`, appear(t, at + 0.2 + i * 0.07, { dy: 8 }))).join('')}</div>`);
    }
    default: return '';
  }
}

export default {
  render(t, { beats, scene }) {
    const at = Object.fromEntries(BEATS.map((b) => [b, beats[b].t]));
    // The current panel: the last beat started (each one cross-fades over 0.3 s, just before its line).
    const lead = 0.15;
    let cur = 0;
    BEATS.forEach((b, i) => { if (t >= at[b] - lead) cur = i; });
    let html = '';

    // ---- the Import… picker ----
    const pickerAt = 0.1;
    // Import from dbt is its own start, not an Import… source: the picker dims while it shows.
    const dbtDim = BEATS[cur] === 'dbt' ? easeOut(seg(t, at.dbt - lead, at.dbt + 0.2))
      : BEATS[cur] === 'guide' ? 1 - easeOut(seg(t, at.guide - lead, at.guide + 0.2)) : 0;
    if (t >= pickerAt) {
      const sel = SOURCES.findIndex((s) => s.beat === BEATS[cur]);
      // Dialect chips: the three engines as the SQL row is picked, Snowflake and Databricks on their words.
      const chipAt = [at.sql + 0.5, at.sql + 0.65, at.sql + 0.8, wordAt(scene, 'sql', 'Snowflake'), wordAt(scene, 'sql', 'Databricks')];
      html += quickPick({
        x: X, y: 300, w: W, title: 'Import', placeholder: 'What would you like to start your data model from?',
        items: SOURCES.map((s) => ({
          label: s.label, detail: s.detail, icon: s.icon, indent: INDENT,
          ...(s.sql ? { h: 134, extra: dialectStrip(t, chipAt) } : {}),
        })), sel, rowH: 84,
        style: `${appear(t, pickerAt, { dy: -12 })}${dbtDim > 0 ? `filter:brightness(${lerp(1, 0.5, dbtDim).toFixed(3)});` : ''}`,
      });
    }

    // ---- the panel under it ----
    // A dip, not a dissolve: the old panel is gone (0.18 s) before the new one rises, so two
    // panels' text never sit on top of each other.
    const k = cur;
    const swapAt = at[BEATS[k]] - lead;
    const out = easeOut(seg(t, swapAt, swapAt + 0.18));
    if (k > 0 && out < 1) html += `<div class="abs" style="left:0;top:0;opacity:${(1 - out).toFixed(3)}">${panel(BEATS[k - 1], t, at[BEATS[k - 1]])}</div>`;
    const firstAt = k === 0 ? wordAt(scene, 'open', 'what you use') - 0.3 : swapAt + 0.12;
    html += `<div class="abs" style="left:0;top:0;${appearFade(t, firstAt, 1, { dy: 12, dur: 0.28 })}">${panel(BEATS[k], t, at[BEATS[k]])}</div>`;
    return html;
  },
};
