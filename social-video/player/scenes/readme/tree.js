// readme · 3 · tree — "Plain DBML files, an open format." The same Explorer card as flip.js, the
// .erd-studio folder expanded to the real layer-first layout a new project gets
// (docs/semantic-domain-json-reference.md → Layout): gold/tables/gold/<table>.dbml,
// gold/relationships/gold.dbml, gold/diagrams/sales.dbml, then layers.json and README.md.
// `dbml`: the .dbml rows light up, and "DBML · an open format · no lock-in" builds on the right.
// `files`: each group gets its tag on its word — a layer folder, one file per table (with the
// schema folder named), the relationships, the diagrams.
import { appear, card, easeOut, ICON, seg } from '../../lib.js';
import { explorerRows, FILE_COL, R, wordAt } from './story.js';

const X = 64, Y = 300, W = 952, H = 790;
const ROWS_TOP = Y + 64 + 18;
const TAG_X = 640;
const C = { dbml: '232,162,74', layer: '246,213,138', table: '96,165,250', rel: '196,144,232', dia: '34,197,94' };

function tag(label, rgb, x, y, t, at, style = '') {
  return `<div class="abs" style="left:${x}px;top:${y}px;${appear(t, at, { dy: 0, dx: 12, dur: 0.3 })}${style}"><span class="pill" style="background:rgba(${rgb},.16);border:2px solid rgba(${rgb},.9);color:rgb(${rgb});font-size:24px;font-weight:800;letter-spacing:.03em;padding:5px 16px">${label}</span></div>`;
}

export default {
  render(t, { beats, scene }) {
    const D = beats.dbml.t, F = beats.files.t;
    const dbmlAt = wordAt(scene, 'dbml', 'DBML');
    const openAt = wordAt(scene, 'dbml', 'open');
    const lockAt = wordAt(scene, 'dbml', 'lock');
    const layerAt = wordAt(scene, 'files', 'folder') - 0.2;
    const tableAt = wordAt(scene, 'files', 'table');
    const relAt = wordAt(scene, 'files', 'relationships');
    const diaAt = wordAt(scene, 'files', 'diagrams');
    const groupsOn = t >= F;
    const dbmlGlow = easeOut(seg(t, dbmlAt, dbmlAt + 0.3)) * (1 - 0.7 * seg(t, F - 0.2, F + 0.2));
    const on = (at) => easeOut(seg(t, at, at + 0.3));

    // Rows unroll top-down as the scene opens (the card itself is already there from flip.js).
    const rev = (k) => easeOut(seg(t, 0.05 + k * 0.07, 0.3 + k * 0.07));
    const dbmlRow = (k, d, name, hl, hlAt) => ({
      d, name, col: FILE_COL.dbml, q: rev(k),
      hl: groupsOn ? hl : C.dbml, hlA: groupsOn ? on(hlAt) : dbmlGlow,
    });
    const rows = [
      { d: 0, name: '.erd-studio', dir: true, col: 'var(--green)', q: rev(0) },
      { d: 1, name: R.layer, dir: true, col: '#d9b35a', q: rev(1), hl: C.layer, hlA: on(layerAt) },
      { d: 2, name: 'tables', dir: true, q: rev(2), hl: C.table, hlA: on(tableAt) },
      { d: 3, name: R.schema, dir: true, q: rev(3), hl: C.table, hlA: on(tableAt), after: t >= tableAt ? `<span style="margin-left:4px;font-size:22px;color:var(--text-2);${appear(t, tableAt + 0.2, { dy: 0, dx: -6 })}">a schema</span>` : '' },
      dbmlRow(4, 4, 'dim_customer.dbml', C.table, tableAt),
      dbmlRow(5, 4, 'fct_order.dbml', C.table, tableAt),
      { d: 2, name: 'relationships', dir: true, q: rev(6), hl: C.rel, hlA: on(relAt) },
      dbmlRow(7, 3, 'gold.dbml', C.rel, relAt),
      { d: 2, name: 'diagrams', dir: true, q: rev(8), hl: C.dia, hlA: on(diaAt) },
      dbmlRow(9, 3, 'sales.dbml', C.dia, diaAt),
      { d: 1, name: 'layers.json', col: FILE_COL.json, q: rev(10) },
      { d: 1, name: 'README.md', col: FILE_COL.md, q: rev(11) },
    ];
    let html = card({
      x: X, y: Y, w: W, h: H,
      tabs: [{ label: 'Explorer', on: true, icon: `<span style="color:#7f8792">${ICON.folder({ size: 24 })}</span>` }],
      crumb: `${R.repo} · main`, headStyle: 'font-size:24px',
    });
    const { html: rh, ys } = explorerRows(rows, { x: X, y: ROWS_TOP, w: W, hlW: TAG_X - 30 - X });
    html += rh;

    // ---- `dbml`: the format, top right ----
    const fmtOut = 1 - seg(t, F - 0.2, F + 0.2);
    if (t >= dbmlAt && fmtOut > 0) {
      html += `<div class="abs" style="left:${TAG_X}px;top:${ys[0] + 4}px;width:${X + W - 30 - TAG_X}px;opacity:${fmtOut.toFixed(3)};display:flex;flex-direction:column;gap:14px;align-items:flex-start">
        <div style="font-size:64px;font-weight:800;letter-spacing:-.02em;color:rgb(${C.dbml});${appear(t, dbmlAt, { dy: 10 })}">.dbml</div>
        ${t >= openAt ? `<span class="pill" style="font-size:28px;padding:9px 22px;background:#1c1e23;border:2px solid #34363d;color:var(--text);${appear(t, openAt, { dy: 8 })}">${ICON.check({ size: 22 })}an open format</span>` : ''}
        ${t >= lockAt ? `<span class="pill" style="font-size:28px;padding:9px 22px;background:#13301f;border:2px solid #1f6b3a;color:var(--green);${appear(t, lockAt, { dy: 8 })}">${ICON.check({ size: 22 })}no lock-in</span>` : ''}</div>`;
    }

    // ---- `files`: one tag per group ----
    if (groupsOn) {
      const mid = (a, b) => (ys[a] + ys[b]) / 2 - 22;
      if (t >= layerAt) html += tag('A LAYER', C.layer, TAG_X, mid(1, 2), t, layerAt);
      if (t >= tableAt) html += tag('ONE FILE PER TABLE', C.table, TAG_X, mid(4, 6), t, tableAt);
      if (t >= relAt) html += tag('RELATIONSHIPS', C.rel, TAG_X, mid(6, 8), t, relAt);
      if (t >= diaAt) html += tag('DIAGRAMS', C.dia, TAG_X, mid(8, 10), t, diaAt);
    }
    return html;
  },
};
