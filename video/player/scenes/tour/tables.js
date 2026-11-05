// 4 · "Add a table, with starter columns if you like. / Add another, then link the two with a
// relationship." The new orders diagram opens on a blank canvas: a plain folder (logicalOnly), so the
// toolbar has no stage tabs and nothing to compare, and the empty-canvas card offers New Table
// first (webview EmptyCanvas, logicalOnly). The pointer clicks New Table; the New Table dialog
// takes "dim_customer" (its Schema field's "Creates …" line follows the name) and the Dimension
// starter columns, and Create Table drops the node. On `more` fct_order joins it, then the
// toolbar's "+ Add" menu opens New Relationship, its fields fill (fct_order.customer_key →
// dim_customer.customer_key, many to one) and Create Relationship draws the edge with * and 1.
// Every label is the webview's own (npm test checks them).
import { appear, easeOut, edge, ICON, node, path, pointer, seg, toolbar, typed } from '../../lib.js';
import { BODY, CANVAS, editorWindow } from '../../editor.js';

// webview/components/EmptyCanvas/EmptyCanvas.tsx, for a plain folder (logicalOnly) and an
// empty Table Library.
export const EMPTY_CANVAS = {
  title: 'This diagram is empty',
  body: 'Add your first table.',
  button: 'New Table',
  hint: 'Or let your AI assistant draw it:',
  link: 'set it up in the Welcome panel',
};
// webview/components/NewModelDialog/NewModelDialog.tsx (a DBML diagram's New Table: Schema field
// and its "Creates …" preview, newTablePathPreview) and the Dimension template
// (src/services/templateService.ts, {name} = "customer").
export const NEW_TABLE = {
  title: 'New Table',
  name: 'Table Name',
  schema: 'Schema',
  starter: 'Starter columns (optional)',
  blank: 'Blank — no columns yet',
  dimension: 'Dimension — something you describe (customer, product)',
  prefixHint: 'Table names start with dim_',
  noColumns: 'No columns yet. Click "Add Column" to add columns to this table.',
  addColumn: '+ Add Column',
  fromTemplate: 'From template',
  cancel: 'Cancel',
  create: 'Create Table',
  table: 'dim_customer',
  schemaValue: 'main',
  creates: (name) => `Creates .erd-studio/main/tables/main/${name || 'table_name'}.dbml`,
};
// The toolbar's "+ Add" menu (webview/components/Toolbar/Toolbar.tsx).
export const ADD_MENU = ['New Table', 'Add Existing Tables', 'New Relationship', 'New Note'];
// webview/components/NewFkDialog/NewFkDialog.tsx and webview/lib/relationshipDialog.ts.
export const NEW_RELATIONSHIP = {
  title: 'New Relationship',
  // [label, value, the select's empty option]
  fields: [
    ['Source Table', 'fct_order', 'Select table...'],
    ['Source Column (FK)', 'customer_key', 'Select column...'],
    ['Target Table', 'dim_customer', 'Select table...'],
    ['Target Column (PK)', 'customer_key', 'Select column...'],
    ['How many?', 'Many fct_order rows → one dim_customer', 'Many → one'],
  ],
  preview: 'Preview:',
  previewText: 'fct_order.customer_key → dim_customer.customer_key',
  previewCardinality: '(many → one)',
  cancel: 'Cancel',
  create: 'Create Relationship',
};

// The two tables: dim_customer as the Dimension template makes it, fct_order as typed in (its
// customer_key is an FK once the relationship exists; this is the state after it). Drawn neutral:
// a plain folder has no stage colours.
export const TABLES = [
  { name: 'dim_customer', x: 210, y: 486, w: 470, cols: [
    { key: 'PK', name: 'customer_key', type: 'INTEGER' }, { name: 'customer_id', type: 'VARCHAR' }, { name: 'name', type: 'VARCHAR' },
    { name: 'description', type: 'VARCHAR' }, { name: 'is_active', type: 'BOOLEAN' },
    { name: 'dwh_inserted_at', type: 'TIMESTAMP_NTZ' }, { name: 'dwh_updated_at', type: 'TIMESTAMP_NTZ' },
  ] },
  { name: 'fct_order', x: 1150, y: 520, w: 420, cols: [
    { key: 'PK', name: 'order_id', type: 'INTEGER' }, { key: 'FK', name: 'customer_key', type: 'INTEGER' },
    { name: 'order_date', type: 'DATE' }, { name: 'amount', type: 'DECIMAL(18,2)' },
  ] },
];
const ry = (top, i) => top + 62 + i * 46 + 23;
/** fct_order.customer_key (row 1) → dim_customer.customer_key (row 0): [points, many, one]. */
export function relEdge() {
  const [dc, fo] = TABLES;
  const x0 = fo.x, y0 = ry(fo.y, 1), x1 = dc.x + dc.w, y1 = ry(dc.y, 0), mx = (x0 + x1) / 2;
  return [[[x0, y0], [mx, y0], [mx, y1], [x1, y1]], [x0 - 22, y0 - 8], [x1 + 8, y1 - 10]];
}

const DLG = { w: 660, x: BODY.x + (BODY.w - 660) / 2, y: BODY.y + 4 };
const field = (y, label, value, { focus = false, mono = false, placeholder = false } = {}) =>
  `<div class="abs" style="left:24px;top:${y}px;font-size:17px;font-weight:600;color:var(--text-2);white-space:nowrap">${label}</div>
   <div class="abs" style="left:24px;right:24px;top:${y + 26}px;height:42px;border-radius:4px;background:#2a2b30;border:1px solid ${focus ? '#3794ff' : '#3c3d44'};display:flex;align-items:center;padding:0 14px;font-size:20px;white-space:nowrap;overflow:hidden;${mono ? 'font-family:var(--mono);font-size:19px;' : ''}color:${placeholder ? 'var(--text-3)' : 'var(--text)'}">${value}</div>`;
const panel = (h, title, inner, op) =>
  `<div class="abs" style="left:${DLG.x}px;top:${DLG.y}px;width:${DLG.w}px;height:${h}px;border-radius:10px;background:#202126;border:1px solid #3a3c42;box-shadow:0 24px 60px #000c;overflow:hidden;opacity:${op.toFixed(3)};transform:translateY(${(-14 * (1 - op)).toFixed(1)}px)">
    <div class="abs" style="left:0;right:0;top:0;height:52px;border-bottom:1px solid #3a3c42;display:flex;align-items:center;justify-content:space-between;padding:0 22px;font-size:22px;font-weight:700">${title}<span style="color:var(--text-2);font-size:26px;font-weight:400">×</span></div>${inner}</div>`;
const footer = (h, cancel, create, press) =>
  `<div class="abs" style="right:24px;top:${h - 60}px;display:flex;gap:12px">
    <span style="display:flex;align-items:center;height:42px;padding:0 20px;border-radius:4px;background:#3a3d44;font-size:19px;font-weight:600">${cancel}</span>
    <span style="display:flex;align-items:center;height:42px;padding:0 20px;border-radius:4px;background:${press > 0 && press < 1 ? '#0b4f7d' : '#0e639c'};color:#fff;font-size:19px;font-weight:600">${create}</span></div>`;

export default {
  render(t, { beats }) {
    const T = beats.table.t, M = beats.more.t;
    // t_table: "Add a table,"(+0.0–0.67) "with starter columns if you like."(+0.9–2.3)
    const newClick = T + 0.35;
    const dlgAt = newClick + 0.15;
    const typeAt = dlgAt + 0.15, cps = 30;
    const typeEnd = typeAt + NEW_TABLE.table.length / cps;
    const starterAt = T + 1.3;                   // "…starter columns"
    const createAt = T + 2.25;
    const dlgOut = createAt + 0.2;
    const dimAt = dlgOut + 0.05;
    // t_more: "Add another,"(+0.0–0.57) "then link the two with a relationship."(+0.8–2.4)
    const fctAt = M + 0.15;
    const addClick = M + 0.95, menuAt = addClick + 0.1;
    const relClick = M + 1.35, relAt = relClick + 0.1;
    const fill = (i) => relAt + 0.12 + i * 0.1;
    const relCreate = M + 2.3, relOut = relCreate + 0.2;
    const edgeAt = relOut + 0.05;

    let html = editorWindow({ tabs: [{ label: 'orders.dbml', on: true }], crumb: '.erd-studio › main › diagrams › orders.dbml', bodyCls: 'grid-bg' });
    const menuOpen = t >= menuAt && t < relAt;
    html += toolbar({ x: CANVAS.toolbarX, y: CANVAS.toolbarY, logicalOnly: true, layout: 'idle', add: menuOpen ? 'open' : 'idle' });
    const ADD = { x: CANVAS.toolbarX + 481, y: CANVAS.toolbarY + 33 };   // the "+ Add" button's centre (measured)

    // ---- the empty-canvas card, until the first table lands ----
    const cardOp = 1 - seg(t, newClick + 0.05, newClick + 0.25);
    const CARD = { w: 600, y: BODY.y + 150 };
    const btnY = CARD.y + 137;                   // the New Table button's centre (measured)
    if (cardOp > 0) {
      const pressed = t >= newClick && t < newClick + 0.3;
      html += `<div class="abs" style="left:${BODY.x + (BODY.w - CARD.w) / 2}px;top:${CARD.y}px;width:${CARD.w}px;padding:26px 30px;border-radius:10px;background:#202126;border:1px solid #3a3c42;text-align:center;opacity:${cardOp.toFixed(3)};${appear(t, 0.05, { dy: 8 })}">
        <div style="font-size:26px;font-weight:700">${EMPTY_CANVAS.title}</div>
        <div style="margin-top:12px;font-size:20px;color:var(--text-2)">${EMPTY_CANVAS.body}</div>
        <div style="margin-top:20px;display:flex;justify-content:center"><span style="display:flex;align-items:center;height:46px;padding:0 24px;border-radius:5px;background:${pressed ? '#0b4f7d' : '#0e639c'};color:#fff;font-size:20px;font-weight:600">${EMPTY_CANVAS.button}</span></div>
        <div style="margin-top:18px;font-size:18px;color:var(--text-2)">${EMPTY_CANVAS.hint} <span style="color:#3794ff">${EMPTY_CANVAS.link}</span></div></div>`;
    }

    // ---- the tables and the relationship ----
    const [dc, fo] = TABLES;
    if (t >= edgeAt) {
      const [pts, many, one] = relEdge();
      html += edge(pts, { progress: easeOut(seg(t, edgeAt, edgeAt + 0.55)), many, one });
    }
    if (t >= dimAt) html += node({ ...dc, style: appear(t, dimAt, { dy: 12 }) });
    // fct_order as typed in has no FK yet: customer_key gets its FK badge with the relationship.
    const fkShown = t >= edgeAt + 0.25;
    if (t >= fctAt) html += node({ ...fo, cols: fo.cols.map((c) => (c.key === 'FK' && !fkShown ? { ...c, key: undefined } : c)), style: appear(t, fctAt, { dy: 12 }) });

    // ---- the New Table dialog ----
    if (t >= dlgAt && t < dlgOut + 0.15) {
      const op = easeOut(seg(t, dlgAt, dlgAt + 0.2)) * (1 - seg(t, dlgOut, dlgOut + 0.15));
      const name = typed(NEW_TABLE.table, t, typeAt, cps);
      const dim = t >= starterAt;
      const H = 528;
      let inner = field(64, NEW_TABLE.name, name || 'table_name', { focus: t < typeEnd + 0.1, placeholder: !name });
      inner += field(146, NEW_TABLE.schema, NEW_TABLE.schemaValue);
      inner += `<div class="abs mono" style="left:24px;top:220px;font-size:16px;color:var(--text-2);white-space:nowrap">${NEW_TABLE.creates(name)}</div>`;
      inner += field(250, NEW_TABLE.starter, `${dim ? NEW_TABLE.dimension : NEW_TABLE.blank}<span style="flex:1"></span>${ICON.chevDown({ size: 18 })}`, { focus: t >= starterAt - 0.2 && t < starterAt + 0.3 });
      if (dim) inner += `<div class="abs" style="left:24px;top:324px;font-size:16px;color:var(--text-2);${appear(t, starterAt, { dy: 4, dur: 0.2 })}">${NEW_TABLE.prefixHint}</div>`;
      const cols = dim ? dc.cols : [];
      inner += `<div class="abs" style="left:24px;right:24px;top:356px;display:flex;align-items:center;justify-content:space-between"><span style="font-size:18px;font-weight:700">Columns (${cols.length})</span><span style="font-size:17px;color:#3794ff">${NEW_TABLE.addColumn}</span></div>`;
      if (dim) {
        inner += `<div class="abs" style="left:24px;top:390px;font-size:14px;font-weight:700;letter-spacing:.06em;color:var(--text-3)">${NEW_TABLE.fromTemplate.toUpperCase()}</div>`;
        cols.slice(0, 2).forEach((c, i) => {
          inner += `<div class="abs" style="left:24px;right:24px;top:${410 + i * 28}px;height:28px;display:flex;align-items:center;gap:12px;font-size:18px;white-space:nowrap;${appear(t, starterAt + 0.05 * i, { dy: 4, dur: 0.2 })}">
            <span style="width:40px;display:flex">${c.key ? `<span class="badge badge--${c.key.toLowerCase()}">${c.key}</span>` : ''}</span><span style="flex:1">${c.name}</span><span class="mono" style="font-size:16px;color:var(--type)">${c.type}</span></div>`;
        });
        inner += `<div class="abs" style="left:24px;right:24px;top:466px;font-size:16px;color:var(--text-3)">+ ${cols.length - 2} more</div>`;
      } else {
        inner += `<div class="abs" style="left:24px;right:24px;top:396px;font-size:17px;color:var(--text-3)">${NEW_TABLE.noColumns}</div>`;
      }
      inner += footer(H, NEW_TABLE.cancel, NEW_TABLE.create, seg(t, createAt, createAt + 0.3));
      html += panel(H, NEW_TABLE.title, inner, op);
    }

    // ---- the "+ Add" menu ----
    if (menuOpen) {
      const op = easeOut(seg(t, menuAt, menuAt + 0.12));
      const items = ADD_MENU.map((label, i) => `${i === 3 ? '<div style="height:1px;margin:6px 0;background:#3a3c42"></div>' : ''}<div style="height:42px;display:flex;align-items:center;padding:0 18px;border-radius:4px;font-size:19px;white-space:nowrap;${i === 2 && t >= relClick - 0.2 ? 'background:#04395e;' : ''}">${label}</div>`).join('');
      html += `<div class="abs" style="left:${ADD.x - 60}px;top:${ADD.y + 36}px;width:260px;padding:6px;border-radius:8px;background:#252526;border:1px solid #454545;box-shadow:0 14px 40px #000c;opacity:${op.toFixed(3)}">${items}</div>`;
    }

    // ---- the New Relationship dialog: its fields fill, then Create Relationship ----
    if (t >= relAt && t < relOut + 0.15) {
      const op = easeOut(seg(t, relAt, relAt + 0.2)) * (1 - seg(t, relOut, relOut + 0.15));
      const H = 528;
      let inner = '';
      NEW_RELATIONSHIP.fields.forEach(([label, value, empty], i) => {
        const set = t >= fill(i);
        inner += field(62 + i * 78, label, set ? value : empty, { placeholder: !set, mono: set && i < 4, focus: set && t < fill(i) + 0.12 });
      });
      if (t >= fill(4)) {
        inner += `<div class="abs" style="left:24px;right:24px;top:${62 + 5 * 78}px;font-size:17px;white-space:nowrap;${appear(t, fill(4), { dy: 4, dur: 0.2 })}"><span style="color:var(--text-2)">${NEW_RELATIONSHIP.preview}</span> <span class="mono" style="font-size:16px">${NEW_RELATIONSHIP.previewText}</span> <span style="color:var(--text-2)">${NEW_RELATIONSHIP.previewCardinality}</span></div>`;
      }
      inner += footer(H, NEW_RELATIONSHIP.cancel, NEW_RELATIONSHIP.create, seg(t, relCreate, relCreate + 0.3));
      html += panel(H, NEW_RELATIONSHIP.title, inner, op);
    }

    // ---- pointer: New Table, Create Table, then + Add → New Relationship → Create Relationship ----
    const cx = BODY.x + BODY.w / 2;
    const createBtn = { x: DLG.x + DLG.w - 24 - 70, y: DLG.y + 528 - 60 + 21 };
    const relCreateBtn = { x: DLG.x + DLG.w - 24 - 100, y: DLG.y + 528 - 60 + 21 };
    const relItem = { x: ADD.x + 40, y: ADD.y + 36 + 6 + 2 * 42 + 21 };
    const pts = [
      { t: 0, x: 1400, y: 880 },
      { t: newClick - 0.1, x: cx, y: btnY },
      { t: dlgAt + 0.2, x: cx, y: btnY },
      { t: createAt - 0.1, ...createBtn },
      { t: M + 0.2, ...createBtn },
      { t: addClick - 0.1, ...ADD },
      { t: relClick - 0.1, ...relItem },
      { t: relAt + 0.2, ...relItem },
      { t: relCreate - 0.1, ...relCreateBtn },
      { t: relOut + 0.6, x: relCreateBtn.x + 160, y: relCreateBtn.y + 120 },
    ];
    const pt = path(t, pts);
    const press = Math.max(...[newClick, createAt, addClick, relClick, relCreate].map((at) => (t >= at && t < at + 0.4 ? seg(t, at, at + 0.4) : 0)));
    const op = Math.min(seg(t, 0, 0.25), 1 - seg(t, relOut + 0.3, relOut + 0.7));
    if (op > 0) html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, press)}</div>`;
    return html;
  },
};
