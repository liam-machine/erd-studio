// The README cut's one example (script.readme.yaml, scenes/readme/*): a gold layer with two
// tables and one diagram, stored the way ERD Studio 2.0 writes a new project — layer-first DBML
// (docs/semantic-domain-json-reference.md → "DBML project"):
//
//   .erd-studio/gold/tables/gold/<table>.dbml     one Table each, schema = the folder
//   .erd-studio/gold/relationships/gold.dbml      the layer's default relationships file
//   .erd-studio/gold/diagrams/sales.dbml          use lines + Project sales { erd_layout }
//
// Every file excerpt below follows the writer's layout (two-space indents, aligned columns, a
// Table with two settings lists them one per line, every custom value quoted, Refs `>?`). Not a
// scene module: the scenes import it.
import { esc, ICON } from '../../lib.js';

export const R = {
  root: '.erd-studio',
  layer: 'gold', layerLabel: 'Gold', badge: 'GLD', schema: 'gold', diagram: 'sales',
  repo: 'acme-analytics',
  dim_customer: {
    name: 'dim_customer', grain: 'One row per customer',
    cols: [{ key: 'PK', name: 'customer_id', type: 'INT' }, { name: 'customer_name', type: 'VARCHAR' }, { name: 'email', type: 'VARCHAR' }],
  },
  fct_order: {
    name: 'fct_order', grain: 'One row per order',
    cols: [{ key: 'PK', name: 'order_id', type: 'INT' }, { key: 'FK', name: 'customer_id', type: 'INT' }, { name: 'order_date', type: 'DATE' }, { name: 'order_total', type: 'DECIMAL(12,2)' }],
  },
  /** The table the AI adds (scenes/readme/ai.js). */
  dim_date: {
    name: 'dim_date', grain: 'One row per day',
    cols: [{ key: 'PK', name: 'date_day', type: 'DATE' }, { name: 'month_name', type: 'VARCHAR' }, { name: 'year', type: 'INT' }],
  },
  /** The column the canvas / PR scenes add. Short enough not to re-align the column block. */
  newCol: { name: 'status', type: 'VARCHAR' },
  pr: { number: 128, title: 'Add status to fct_order', branch: 'feat/order-status', sql: 'sql/orders.sql' },
  /**
   * What dbt has (scenes/readme/dbt.js): the drift Compare with dbt marks — three differences, as
   * the product counts them (no rename detection): a type diff, a column only in physical (a load
   * audit column the design never named) and the relationship dbt has no relationships test for.
   */
  drift: { typeCol: 'order_date', typeLogical: 'DATE', typePhysical: 'TIMESTAMP', physOnly: { name: 'loaded_at', type: 'TIMESTAMP' } },
};

export const PATH = {
  tableDir: '.erd-studio/gold/tables/gold',
  fct: '.erd-studio/gold/tables/gold/fct_order.dbml',
  dim: '.erd-studio/gold/tables/gold/dim_customer.dbml',
  date: '.erd-studio/gold/tables/gold/dim_date.dbml',
  rels: '.erd-studio/gold/relationships/gold.dbml',
  diagram: '.erd-studio/gold/diagrams/sales.dbml',
};

/** .erd-studio/gold/tables/gold/fct_order.dbml (the hand-written comment survives every save). */
export const FCT_DBML = [
  '// Owned by the sales data team',
  'Table gold.fct_order [',
  "  role: 'transaction-fact',",
  "  grain: 'One row per order'",
  '] {',
  '  order_id    INT [pk]',
  "  customer_id INT [foreign_key: 'true']",
  '  order_date  DATE',
  '  order_total "DECIMAL(12,2)"',
  '}',
];
/** fct_order.dbml once `status` is added (the canvas and PR scenes). */
export const FCT_STATUS_LINE = '  status      VARCHAR';

/** .erd-studio/gold/relationships/gold.dbml */
export const RELS_DBML = [
  '// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.',
  "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'",
  "use { table gold.fct_order }    from '../tables/gold/fct_order.dbml'",
  '',
  'Ref: gold.fct_order.customer_id >? gold.dim_customer.customer_id',
];

/** .erd-studio/gold/diagrams/sales.dbml */
export const DIAGRAM_DBML = [
  "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'",
  "use { table gold.fct_order }    from '../tables/gold/fct_order.dbml'",
  "use * from '../relationships/gold.dbml'",
  '',
  'Project sales {',
  "  erd_schema_version: '7'",
  "  erd_layout: '''",
  '    dim_customer 40 60',
  '    fct_order 520 60',
  "  '''",
  '}',
];

// ---------- DBML syntax colouring (VS Code dark-ish, the classes in style.css) ----------
const KW = new Set(['Table', 'Ref', 'use', 'from', 'table', 'Project', 'Note', 'indexes', 'Enum']);
const COMMENT = '#6a9955';

function tokens(s) {
  return s.replace(/('''|'(?:[^'\\]|\\.)*'|"[^"]*")|\b([A-Za-z_]\w*)\b(\s*:(?!:))?|(\b\d+\b)|([[\]{}():,<>?*.\-])/g, (m, str, word, colon, num, punc) => {
    if (str) return `<span class="s">${esc(str)}</span>`;
    if (word) {
      if (KW.has(word)) return `<span class="kw">${word}</span>${colon ? `<span class="p">${colon}</span>` : ''}`;
      if (colon) return `<span class="v">${word}</span><span class="p">${colon}</span>`;
      if (word === 'pk') return '<span class="v">pk</span>';
      return word;
    }
    if (num) return `<span class="kw">${num}</span>`;
    return `<span class="p">${esc(punc)}</span>`;
  });
}

/** One DBML line, coloured: comments, keywords, column name + type, settings, strings. */
export function dbmlLine(s) {
  if (/^\s*\/\//.test(s)) return `<span style="color:${COMMENT}">${esc(s)}</span>`;
  const col = s.match(/^(\s+)([A-Za-z_]\w*)(\s+)("[^"]*"|[A-Za-z][\w()]*)(.*)$/);
  if (col && !KW.has(col[2])) {
    const [, ind, name, sp, type, rest] = col;
    return `${ind}<span style="color:var(--text)">${name}</span>${sp}<span class="k">${esc(type)}</span>${tokens(rest)}`;
  }
  return tokens(s);
}

/**
 * When a word is spoken: the narration clip's start + its share of the line's characters
 * (sentence ends and commas weighted as pauses, as build-timeline.mjs times caption chunks).
 * `n` picks the n-th occurrence. Scene-local seconds.
 */
export function wordAt(scene, beat, word, n = 1) {
  const ln = scene.lines.find((l) => l.beat === beat);
  if (!ln) return 0;
  const s = ln.caption;
  let idx = -1;
  for (let k = 0; k < n; k++) idx = s.indexOf(word, idx + 1);
  if (idx < 0) return ln.t;
  const w = (x) => x.length + (x.match(/[.?!]/g) ?? []).length * 6 + (x.match(/[,:;]/g) ?? []).length * 3;
  return ln.t + ((ln.end - ln.t) * w(s.slice(0, idx))) / w(s);
}

// ---------- small shared visuals ----------
export const FILE_COL = { dbml: '#e8a24a', json: '#e2c08d', md: '#5ca2f8', sql: '#78c0f4' };

/**
 * The 2.0 canvas toolbar (webview/components/Toolbar/Toolbar.tsx): row 1 is the diagram name +
 * layer badge, Compare with dbt (dbt projects only) and + Add ▾ (hidden only while the canvas is
 * read-only, i.e. on the Physical tab). Row 2, attached below it, is StageTabs — only in a dbt
 * project: "Logical · your design" and "Physical · read from dbt", a lock on the active
 * read-only tab. `stage` null = a plain folder (no row 2).
 */
export const TB = { h: 64, tabsDy: 70, tabsH: 50 };
export function toolbar2({ x, y, name = R.diagram, badge = R.badge, stage = null, compare = null, style = '', tabsStyle = '' }) {
  const add = stage === 'physical' ? '' : '<span class="tb__diff" style="color:var(--text)">+ Add <span style="font-size:16px;color:var(--text-2)">▾</span></span>';
  const cmp = compare === null ? ''
    : compare === 'on'
      ? '<span class="tb__diff tb__diff--amber">Stop comparing</span>'
      : `<span class="tb__diff"${compare === 'press' ? ' style="background:#0e639c;color:#fff;border-color:#1177bb"' : ''}>${stage === 'physical' ? 'Compare with design' : 'Compare with dbt'}</span>`;
  let html = `<div class="tb" style="left:${x}px;top:${y}px;${style}"><span class="tb__domain">${name}</span><span class="badge badge--gld">${badge}</span>${cmp}${add}</div>`;
  if (stage) {
    const tab = (s, label, hint) => {
      const on = stage === s;
      const lock = on && s === 'physical' ? ICON.lock({ size: 17 }) : '';
      return `<span class="tb__tab${on ? ` tb__tab--${s}` : ''}" style="padding:6px 16px;border-radius:8px">${lock}${label}<span style="font-weight:400;opacity:.8">\u00b7 ${hint}</span></span>`;
    };
    html += `<div class="tb" style="left:${x}px;top:${y + TB.tabsDy}px;height:${TB.tabsH}px;padding:4px 8px;gap:4px;font-size:21px;${tabsStyle}">${tab('logical', 'Logical', 'your design')}${tab('physical', 'Physical', 'read from dbt')}</div>`;
  }
  return html;
}

/** The canvas's top-right corner action, `{ } View File`. */
export const viewFileBtn = (x, y, style = '') =>
  `<div class="abs" style="left:${x}px;top:${y}px;height:50px;padding:0 18px;border-radius:10px;border:1px solid var(--card-border);background:var(--card-head);display:flex;align-items:center;gap:10px;font-size:22px;font-weight:600;white-space:nowrap;${style}"><span class="mono" style="font-weight:700;letter-spacing:-.05em">{ }</span>View File</div>`;

/** A VS Code quick pick. items: [{ label, desc?, detail?, icon? }]; sel = index highlighted (or -1). */
export function quickPick({ x, y, w, title = '', placeholder = '', query = '', items, sel = -1, hot = [], style = '', rowH = 84 }) {
  const head = title ? `<div style="height:48px;display:flex;align-items:center;justify-content:center;font-size:21px;font-weight:600;color:var(--text-2);border-bottom:1px solid #2c2e34">${esc(title)}</div>` : '';
  const input = `<div style="margin:12px 14px;height:52px;border-radius:8px;border:2px solid #0e639c;background:#16181c;display:flex;align-items:center;padding:0 16px;font-size:23px;white-space:nowrap;overflow:hidden;color:${query ? 'var(--text)' : 'var(--text-2)'}">${query ? esc(query) : esc(placeholder)}</div>`;
  const rows = items.map((it, i) => {
    const on = i === sel;
    const glow = hot[i] ?? 0;
    return `<div style="margin:0 10px;height:${rowH}px;border-radius:8px;display:flex;flex-direction:column;justify-content:center;padding:0 18px;white-space:nowrap;overflow:hidden;${on ? 'background:#04395e;box-shadow:inset 0 0 0 1px #0e639c;' : glow > 0 ? `background:rgba(244,180,44,${(0.14 * glow).toFixed(3)});` : ''}">
      <div style="display:flex;align-items:center;gap:12px;font-size:25px;font-weight:600">${it.icon ?? ''}${esc(it.label)}${it.desc ? `<span style="font-size:20px;font-weight:400;color:var(--text-2)">${esc(it.desc)}</span>` : ''}</div>
      ${it.detail ? `<div style="margin-top:4px;font-size:19px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis">${esc(it.detail)}</div>` : ''}</div>`;
  }).join('');
  return `<div class="abs" style="left:${x}px;top:${y}px;width:${w}px;border-radius:14px;background:#1f2126;border:1px solid #3a3d45;box-shadow:0 24px 60px #000c;padding-bottom:10px;overflow:hidden;${style}">${head}${input}${rows}</div>`;
}

/**
 * VS Code Explorer rows inside a card body. rows: [{ d, name, dir?, open?, col?, q? (0..1, an
 * inserting row unrolls), hl? ('r,g,b'), hlA? (0..1), fg?, after? (html after the name) }].
 * Returns { html, ys } — ys[i] is row i's top (frame space) for tags and brackets.
 */
export function explorerRows(rows, { x, y, w, pitch = 54, indentW = 34, hlW = null }) {
  let html = '', at = y;
  const ys = [];
  for (const row of rows) {
    const q = row.q ?? 1;
    ys.push(at);
    if (q <= 0) continue;
    const h = pitch * q;
    const indent = x + 26 + row.d * indentW;
    if (row.hl && (row.hlA ?? 1) > 0) {
      const a = row.hlA ?? 1;
      html += `<div class="abs" style="left:${x + 2}px;top:${(at + 3).toFixed(1)}px;width:${hlW ?? w - 4}px;height:${(h - 6).toFixed(1)}px;background:rgba(${row.hl},${(0.14 * a).toFixed(3)});border-left:5px solid rgba(${row.hl},${(0.95 * a).toFixed(3)});opacity:${q.toFixed(3)}"></div>`;
    }
    const icon = row.dir
      ? `<span style="color:var(--text-3)">${row.open === false ? ICON.chevRight({ size: 20, sw: 2.6 }) : ICON.chevDown({ size: 20, sw: 2.6 })}</span><span style="color:${row.col ?? '#7f8792'}">${ICON.folder({ size: 28 })}</span>`
      : `<span style="display:inline-block;width:20px"></span><span style="color:${row.col ?? 'var(--text-2)'}">${ICON.file({ size: 26 })}</span>`;
    const label = row.dir
      ? `<span style="font-size:27px;font-weight:600;color:${row.fg ?? 'var(--text)'}">${row.name}</span>`
      : `<span class="mono" style="font-size:26px;color:${row.fg ?? 'var(--text)'}">${row.name}</span>`;
    html += `<div class="abs" style="left:${indent}px;top:${at.toFixed(1)}px;width:${x + w - indent}px;height:${h.toFixed(1)}px;overflow:hidden"><div class="abs" style="left:0;top:${(pitch - 44) / 2}px;height:44px;display:flex;align-items:center;gap:12px;white-space:nowrap;opacity:${q.toFixed(3)};transform:translateX(${(-14 * (1 - q)).toFixed(1)}px)">${icon}${label}${row.after ?? ''}</div></div>`;
    at += h;
  }
  ys.push(at);
  return { html, ys };
}
