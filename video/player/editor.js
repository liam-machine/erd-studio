// Shared pieces of the VS Code window the README GIF (hero.js) draws: the activity bar, an Explorer
// file tree, the draft page an import opens, the DBML syntax colours, and the product copy the
// end card and the tests use. (The getting-started tours themselves are recordings of the real VS
// Code: record/.)
//
// Product copy here is verbatim: `npm test` checks each constant against its source (package.json,
// src/providers/HelpTreeProvider.ts, src/services/draftModel.ts, webview-draft/).
import { edge, esc, ICON, node } from './lib.js';

// ---------- the window body (frame px; draftPage's default width) ----------
const WIN = { x: 96, y: 322, w: 1728, h: 600 };
/** Frame position of the window body's top-left (card border 1 px + 64 px head). */
export const BODY = { x: WIN.x + 1, y: WIN.y + 65, w: WIN.w - 2, h: WIN.h - 66 };
export const ACT = 72;          // activity bar width
const SIDE = 400;               // side bar width
/** Left edge of the editor area beside the side bar, in body px. */
export const ED = ACT + SIDE;

// ---------- activity bar ----------
/** The body of media/icon-sidebar.svg, verbatim (inside its 24x24 viewBox). */
export const ERD_SIDEBAR_ICON = `<g transform="translate(-2.08 -2.08) scale(.22)">
    <g transform="translate(4 0) skewX(-8)">
      <path d="M16 42H42V51H26V59H40V68H26V77H42V86H16Z" fill="currentColor"/>
      <path fill-rule="evenodd" d="M48 86V42H65C76 42 82 48 82 57C82 64 79 68 73 70L84 86H72L62 71H58V86H48ZM58 51V62H64C69 62 72 60 72 56.5C72 53 69 51 64 51H58Z" fill="currentColor"/>
      <path fill-rule="evenodd" d="M88 42H101C115 42 122 50 122 64C122 78 115 86 101 86H88V42ZM98 51V77H101C108 77 112 73 112 64C112 55 108 51 101 51H98Z" fill="currentColor"/>
    </g>
  </g>`;
const ai = (d) => `<svg class="icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ACT_ICONS = {
  files: ai('<path d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9z"/><path d="M13 3v6h6"/>'),
  search: ai('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>'),
  ext: ai('<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/><rect x="14.5" y="2.5" width="7" height="7" rx="1" transform="rotate(12 18 6)"/>'),
  // The real activity bar icon: media/icon-sidebar.svg (package.json contributes.viewsContainers),
  // inlined so it takes currentColor like VS Code's own monochrome icon. test/pipeline.test.mjs
  // checks these paths still match the file.
  erd: `<svg class="icon" width="32" height="32" viewBox="0 0 24 24" fill="none">${ERD_SIDEBAR_ICON}</svg>`,
};
/** Activity bar row tops (body px): Explorer, Search, Extensions, ERD Studio. */
export const ACT_Y = { files: 20, search: 84, ext: 148, erd: 212 };
/** Activity bar in body coordinates; `erd` adds ERD Studio's icon (fading in with erdOp), `erdGlow` rings it. */
export function activityBar(active, { erd = true, erdOp = 1, erdGlow = 0 } = {}) {
  const items = ['files', 'search', 'ext'];
  if (erd) items.push('erd');
  let h = `<div class="abs" style="left:0;top:0;width:${ACT}px;bottom:0;background:#131619;border-right:1px solid var(--card-border)"></div>`;
  for (const k of items) {
    const y = ACT_Y[k];
    const on = k === active;
    h += `<div class="abs" style="left:0;top:${y}px;width:${ACT}px;height:48px;display:flex;align-items:center;justify-content:center;color:${on ? 'var(--text)' : 'var(--text-3)'};${k === 'erd' ? `opacity:${erdOp.toFixed(3)};` : ''}">${ACT_ICONS[k]}</div>`;
    if (on) h += `<div class="abs" style="left:0;top:${y}px;width:3px;height:48px;background:var(--text)"></div>`;
    if (k === 'erd' && erdGlow > 0) h += `<div class="abs" style="left:10px;top:${y - 2}px;width:52px;height:52px;border-radius:12px;box-shadow:0 0 0 3px rgba(55,148,255,${erdGlow.toFixed(3)}),0 0 22px rgba(55,148,255,${(0.5 * erdGlow).toFixed(3)})"></div>`;
  }
  return h;
}

/**
 * An Explorer file tree (for the README GIF). `rows` are
 * [depth, kind ('folder' | 'dbml' | 'json' | 'md'), label, closed?] (a closed folder's chevron points
 * right); `lit(i)` 0..1 highlights row i,
 * `badge(i)` returns HTML at its right (the Source Control "U"). Rows are `rowH` apart from `top`.
 */
export function fileTree(rows, { top = 58, rowH = 40, width = 560, indent = 26, font = 22, lit = () => 0, badge = () => '', style = () => '', colour = () => null } = {}) {
  const ICOL = { folder: '#d9b35a', json: '#e8c46a', dbml: '#5ca2f8', md: '#8b9099' };
  let r = '';
  rows.forEach(([d, kind, label, closed], i) => {
    const y = top + i * rowH;
    const h = lit(i);
    r += `<div class="abs" style="left:0;top:${y}px;width:${width}px;height:${rowH}px;background:rgba(96,165,250,${(0.16 * h).toFixed(3)});${h > 0 ? `box-shadow:inset 4px 0 0 rgba(96,165,250,${h.toFixed(3)});` : ''}${style(i)}"></div>
      <div class="abs" style="left:${20 + d * indent}px;right:0;top:${y + (rowH - font - 10) / 2}px;display:flex;align-items:center;gap:10px;font-size:${font}px;white-space:nowrap;color:${colour(i) ?? (kind === 'folder' ? 'var(--text)' : '#c9ced6')};${style(i)}">
        <span style="color:var(--text-3);width:18px;display:flex">${kind === 'folder' ? (closed ? ICON.chevRight({ size: 18, sw: 2.6 }) : ICON.chevDown({ size: 18, sw: 2.6 })) : ''}</span>
        <span style="color:${ICOL[kind] ?? '#c9ced6'};display:flex">${kind === 'folder' ? ICON.folder({ size: font }) : ICON.file({ size: font })}</span>${label}${badge(i)}</div>`;
  });
  return r;
}

// ---------- the extension listing (package.json) ----------
export const EXTENSION = {
  name: 'ERD Studio',
  publisher: 'liamwynne',
  /** The Marketplace id (publisher.name): a search for the name alone also lists an unrelated extension. */
  id: 'liamwynne.erd-studio',
};
/** The Help & Feedback view's rows (HELP_ACTIONS), as the recording's aiSetup scene shows them. */
export const HELP_ROWS = ['Set Up My AI Helper', 'Watch the Tour', 'Show Me Around', 'Send Feedback', 'Show Logs'];

// ---------- the draft page (webview-draft: DraftBanner, a read-only canvas) ----------
// What opens when a start reads something in (src/services/draftModel.ts): the banner's
// headline and detail, its buttons, and the diagram it would keep, drawn read-only. Nothing is
// written until Keep.
/** What Import DBML… shows for a sales.dbml before anything is written (draftFromImportPlan). */
export const SALES_DRAFT = {
  tab: 'Draft: sales',
  file: 'sales.dbml',
  headline: 'Draft from sales.dbml · 5 tables, 4 relationships · not saved',
  detail: 'Keep saves it as sales in the Main layer (.erd-studio/main/diagrams/sales.dbml).',
  // Keep is the primary; the other starts (FIND_STARTS) sit in the menu.
  buttons: [['Keep as Diagram', 'primary'], ['More ways to start', 'menu'], ['Discard', 'secondary']],
  // An import's draft always carries its review (draftModel detailsFromImportReview): "Show details".
  details: true,
  // No name the README GIF's library already has (its .erd-studio tables): a name that is would be
  // reused, and the detail would say so.
  tables: [
    { name: 'dim_store', x: 0, y: 0, cols: [['PK', 'store_id', 'int'], [null, 'store_name', 'varchar'], [null, 'region', 'varchar']] },
    { name: 'dim_staff', x: 0, y: 330, cols: [['PK', 'staff_id', 'int'], [null, 'staff_name', 'varchar']] },
    { name: 'fct_sale', x: 520, y: 120, cols: [['PK', 'sale_id', 'int'], ['FK', 'store_id', 'int'], ['FK', 'staff_id', 'int'], ['FK', 'sale_date', 'date'], [null, 'amount', 'decimal(12,2)']] },
    { name: 'dim_calendar', x: 1040, y: 0, cols: [['PK', 'date_day', 'date'], [null, 'month_name', 'varchar']] },
    { name: 'fct_refund', x: 1040, y: 300, cols: [['PK', 'refund_id', 'int'], ['FK', 'sale_id', 'int'], [null, 'refunded', 'decimal(12,2)']] },
  ],
  rels: [[2, 1, 0, 0], [2, 2, 1, 0], [2, 3, 3, 0], [4, 1, 2, 0]],
};

/** DraftBanner's link to the draft's details (webview-draft/lib/wording.ts SHOW_DETAILS). */
export const SHOW_DETAILS = 'Show details';

const MINI_W = 400;
const miniRowY = (top, i) => top + 62 + i * 46 + 23;
/** A draft's diagram at full node scale, in local coordinates (scaled by draftPage). */
function draftDiagram(d, { op = 1 } = {}) {
  let h = '';
  for (const [a, ar, b, br] of d.rels) {
    const A = d.tables[a], B = d.tables[b];
    const rightward = B.x > A.x;
    const x0 = rightward ? A.x + MINI_W : A.x, x1 = rightward ? B.x : B.x + MINI_W;
    const y0 = miniRowY(A.y, ar), y1 = miniRowY(B.y, br), mx = (x0 + x1) / 2;
    h += edge([[x0, y0], [mx, y0], [mx, y1], [x1, y1]], { width: 4, opacity: op });
  }
  for (const t of d.tables) {
    h += node({ x: t.x, y: t.y, w: MINI_W, name: t.name, layer: 'MAIN', cols: t.cols.map(([key, name, type]) => ({ key: key ?? undefined, name, type })), style: `opacity:${op.toFixed(3)};` });
  }
  return h;
}

/**
 * The draft editor, in body coordinates from `left` to the body's right edge: the banner (two
 * rows: the text, then the switcher and buttons) over the draft's read-only diagram. `press` is
 * [buttonIndex, 0..1] for a click, `glow` rings the primary; `diagramOp` fades the diagram in.
 */
export function draftPage(d, { left = ED, op = 1, press = null, glow = 0, diagramOp = 1, scale = 0.52, width = BODY.w - left, font = 17 } = {}) {
  // DraftBanner: the headline, the detail, then (a draft with details) a "Show details" line.
  const BAN = d.details ? 162 : 132;
  const bx = 28;
  const btnHtml = d.buttons.map(([label, kind], i) => {
    const pressed = press && press[0] === i && press[1] > 0 && press[1] < 1;
    const bg = kind === 'primary' ? (pressed ? '#0b4f7d' : '#0e639c') : kind === 'quiet' ? 'transparent' : '#3a3d41';
    const ring = kind === 'primary' && glow > 0 ? `box-shadow:0 0 0 3px rgba(55,148,255,${(0.6 * glow).toFixed(3)}),0 0 22px rgba(55,148,255,${(0.5 * glow).toFixed(3)});` : '';
    return `<span style="height:36px;padding:0 13px;border-radius:4px;background:${bg};${kind === 'quiet' ? 'border:1px solid #4a4d55;' : ''}color:${kind === 'primary' ? '#fff' : 'var(--text)'};font-weight:${kind === 'primary' ? 600 : 500};display:flex;align-items:center;gap:6px;${ring}">${esc(label)}${kind === 'menu' ? ICON.chevDown({ size: 15, sw: 2.6 }) : ''}</span>`;
  }).join('');
  const scope = d.scope
    ? `<span style="display:flex;align-items:center;gap:8px;margin-right:8px"><span style="color:var(--text-2)">${d.scope.label}</span><span style="height:34px;display:flex;align-items:center;gap:8px;padding:0 8px 0 10px;border-radius:4px;background:#2a2b30;border:1px solid #3c3d44">${esc(d.scope.value)}${ICON.chevDown({ size: 15, sw: 2.6 })}</span></span>`
    : '';
  const html = `<div class="abs" style="left:${left}px;top:0;width:${width}px;bottom:0;background:var(--card);opacity:${op.toFixed(3)};overflow:hidden">
      <div class="abs grid-bg" style="left:0;right:0;top:${BAN}px;bottom:0"></div>
      <div class="abs" style="left:${bx + 6}px;top:${BAN + 26}px;transform:scale(${scale});transform-origin:0 0">${draftDiagram(d, { op: diagramOp })}</div>
      <div class="abs" style="left:0;right:0;top:0;height:${BAN}px;background:#1d2633;border-bottom:1px solid #2d4a70"></div>
      <div class="abs" style="left:${bx}px;top:14px;right:20px;font-size:21px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.headline)}</div>
      <div class="abs" style="left:${bx}px;top:46px;right:20px;font-size:17px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.detail)}</div>
      ${d.details ? `<div class="abs" style="left:${bx}px;top:74px;font-size:17px;color:#3794ff;white-space:nowrap">${SHOW_DETAILS}</div>` : ''}
      <div class="abs" style="left:${bx}px;top:${BAN - 52}px;display:flex;align-items:center;gap:8px;font-size:${font}px;white-space:nowrap">${scope}${btnHtml}</div></div>`;
  return { html };
}

// ---------- DBML text, coloured as VS Code's DBML grammar colours it ----------
/** One line of a .dbml file as HTML: a leading keyword, quoted strings, brackets; everything else plain. */
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
