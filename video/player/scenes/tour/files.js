// 5 · "Each table is a DBML file, to commit and review like code." The orders
// canvas from the tables scene; on `files` the Explorer slides in over it with the .erd-studio
// folder as ERD Studio 2.0 writes it (layer first: gold/diagrams/orders.dbml,
// gold/relationships/gold.dbml, gold/tables/gold/<table>.dbml, plus the layers.json and README.md
// New Diagram writes when it starts the project); the two table
// files light on "Each table". Their text opens beside it (fct_order.dbml, then the
// relationships file with the Ref the canvas drew), and on "…to commit" each new file gets the
// Source Control "U" (untracked) badge.
import { appear, easeOut, edge, esc, ICON, node, seg, toolbar } from '../../lib.js';
import { BODY, CANVAS, editorWindow } from '../../editor.js';
import { TABLES, relEdge } from './tables.js';

// The files, byte for byte as ERD Studio writes them: the DBML writers' text (packages/core/src/dbml:
// renderNewTableDbml, editRelationshipsDbml, and the relationships file's header line in
// dbmlRichProperties.ts) after the host's formatDbml pass (src/services/dbmlWriters.ts
// formatWrittenDbml), which aligns the column types and the `from` clauses. `npm test` runs the
// formatter over them.
export const FILES = {
  'gold/tables/gold/fct_order.dbml': [
    'Table gold.fct_order {',
    '  order_id     INTEGER [pk]',
    "  customer_key INTEGER [foreign_key: 'true']",
    '  order_date   DATE',
    '  amount       "DECIMAL(18,2)"',
    '}',
  ],
  'gold/relationships/gold.dbml': [
    '// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.',
    "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'",
    "use { table gold.fct_order }    from '../tables/gold/fct_order.dbml'",
    '',
    'Ref: gold.fct_order.customer_key >? gold.dim_customer.customer_key',
  ],
};
// The Explorer rows, in VS Code's default order (folders first, then names without regard to
// case): [depth, kind, label, lit on "Each table", new (untracked)].
export const TREE = [
  [0, 'folder', '.erd-studio'],
  [1, 'folder', 'gold'],
  [2, 'folder', 'diagrams'],
  [3, 'dbml', 'orders.dbml', false, true],
  [2, 'folder', 'relationships'],
  [3, 'dbml', 'gold.dbml', false, true],
  [2, 'folder', 'tables'],
  [3, 'folder', 'gold'],
  [4, 'dbml', 'dim_customer.dbml', true, true],
  [4, 'dbml', 'fct_order.dbml', true, true],
  [1, 'json', 'layers.json', false, true],
  [1, 'md', 'README.md', false, true],
];

/** Light DBML colouring: comments, keywords, quoted strings and [settings]. */
export function dbmlLine(s) {
  if (s.trim().startsWith('//')) return `<span style="color:var(--text-3)">${esc(s)}</span>`;
  const col = (c, x) => `<span style="color:var(${c})">${esc(x)}</span>`;
  // tokens: a keyword at the start, quoted strings, brackets; everything else plain
  return s.split(/('[^']*'|"[^"]*"|[[\]]|^\s*(?:Table|Ref|use)\b)/).filter(Boolean).map((tok) => {
    if (/^\s*(Table|Ref|use)$/.test(tok)) return col('--syn-kw', tok);
    if (/^'.*'$/.test(tok)) return col('--syn-str', tok);
    if (/^".*"$/.test(tok)) return col('--syn-val', tok);
    if (tok === '[' || tok === ']') return col('--syn-punc', tok);
    return esc(tok);
  }).join('');
}

export default {
  render(t, { beats }) {
    const F = beats.files.t;
    // f_files: "Each table"(+0.0–0.7) "is a DBML file,"(+0.7–1.94) "to commit"(+2.28–2.79)
    // "and review like code."(+2.9–3.99)
    const treeAt = F + 0.05;
    const litAt = F + 0.35;
    const code1At = F + 0.9, code2At = F + 1.7;
    const newAt = F + 2.3;

    let html = editorWindow({ tabs: [{ label: 'orders.dbml', on: true }], crumb: '.erd-studio › gold › diagrams › orders.dbml', bodyCls: 'grid-bg' });
    html += toolbar({ x: CANVAS.toolbarX, y: CANVAS.toolbarY, logicalOnly: true, layout: 'idle', add: 'idle' });
    const [pts, many, one] = relEdge();
    html += edge(pts, { many, one });
    for (const m of TABLES) html += node({ ...m, layer: 'GLD' });

    // ---- the Explorer ----
    if (t >= treeAt) {
      const W = 560;
      const lit = easeOut(seg(t, litAt, litAt + 0.35));
      const colour = { folder: '#d9b35a', json: '#e8c46a', dbml: '#5ca2f8', md: '#8b9099' };
      let r = '';
      TREE.forEach(([d, kind, label, hot, fresh], i) => {
        const y = 54 + i * 38;
        const at = treeAt + 0.08 + i * 0.04;
        const h = hot ? lit : 0;
        const badge = fresh && t >= newAt ? `<span style="margin-left:auto;margin-right:22px;color:#73c991;font-weight:700;${appear(t, newAt + i * 0.02, { dy: 0, dur: 0.2 })}">U</span>` : '';
        r += `<div class="abs" style="left:0;top:${y}px;width:${W}px;height:38px;background:rgba(96,165,250,${(0.16 * h).toFixed(3)});${h > 0 ? `box-shadow:inset 4px 0 0 rgba(96,165,250,${h.toFixed(3)});` : ''}${appear(t, at, { dy: 0, dx: -10 })}"></div>
          <div class="abs" style="left:${20 + d * 26}px;right:0;top:${y + 5}px;display:flex;align-items:center;gap:10px;font-size:22px;white-space:nowrap;color:${kind === 'folder' ? 'var(--text)' : fresh && t >= newAt ? '#73c991' : '#c9ced6'};${appear(t, at, { dy: 0, dx: -10 })}">
            <span style="color:var(--text-3);width:18px;display:flex">${kind === 'folder' ? ICON.chevDown({ size: 18, sw: 2.6 }) : ''}</span>
            <span style="color:${colour[kind]};display:flex">${kind === 'folder' ? ICON.folder({ size: 22 }) : ICON.file({ size: 22 })}</span>${label}${badge}</div>`;
      });
      const p = easeOut(seg(t, treeAt, treeAt + 0.4));
      html += `<div class="abs" style="left:${BODY.x}px;top:${BODY.y}px;width:${W}px;height:${BODY.h}px;background:#16181b;border-right:1px solid var(--card-border);box-shadow:20px 0 50px #0009;border-radius:0 0 0 20px;overflow:hidden;opacity:${p.toFixed(3)};transform:translateX(${(-50 * (1 - p)).toFixed(1)}px)">
        <div class="abs" style="left:22px;top:16px;font-size:19px;font-weight:700;letter-spacing:.08em;color:var(--text-2)">EXPLORER</div>${r}</div>`;
    }

    // ---- the files' text, beside it ----
    const X = BODY.x + 600, W = BODY.x + BODY.w - 24 - X;
    const codeCard = (at, y, file) => {
      if (t < at) return '';
      const lines = FILES[file];
      const body = lines.map((l, i) => `<div style="display:flex;height:30px;align-items:center"><span style="width:34px;flex:none;text-align:right;margin-right:18px;color:var(--line-no)">${i + 1}</span><span style="white-space:pre">${dbmlLine(l)}</span></div>`).join('');
      return `<div class="abs" style="left:${X}px;top:${y}px;width:${W}px;border-radius:12px;background:#1b1c20;border:1px solid #3a3c42;box-shadow:0 18px 48px #000c;overflow:hidden;${appear(t, at, { dy: 14 })}">
        <div style="height:44px;display:flex;align-items:center;gap:10px;padding:0 18px;border-bottom:1px solid #2c2c30;font-size:19px;color:var(--text-2);white-space:nowrap"><span style="color:#5ca2f8;display:flex">${ICON.file({ size: 20 })}</span>.erd-studio/${file}</div>
        <div class="mono" style="padding:8px 0 10px 4px;font-size:18px;white-space:nowrap;overflow:hidden">${body}</div></div>`;
    };
    // the canvas behind the text steps back, so nothing peeks between the two files
    const back = easeOut(seg(t, code1At, code1At + 0.35));
    if (back > 0) html += `<div class="abs" style="left:${BODY.x + 560}px;top:${BODY.y}px;right:${1920 - BODY.x - BODY.w}px;height:${BODY.h}px;border-radius:0 0 20px 0;background:rgba(22,23,27,${(0.88 * back).toFixed(3)})"></div>`;
    html += codeCard(code1At, BODY.y + 22, 'gold/tables/gold/fct_order.dbml');
    html += codeCard(code2At, BODY.y + 22 + 44 + 6 * 30 + 18 + 18, 'gold/relationships/gold.dbml');
    return html;
  },
};
