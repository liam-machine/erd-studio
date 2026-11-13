// Shared pieces of the VS Code window the README GIF (hero.js) draws: the activity bar, an Explorer
// file tree, the DBML syntax colours, and the product copy the end card and the tests use. (The getting-started tours themselves are recordings of the real VS
// Code: record/.)
//
// Product copy here is verbatim: `npm test` checks each constant against its source (package.json,
// src/providers/HelpTreeProvider.ts).
import { esc, ICON } from './lib.js';

export const ACT = 72;          // activity bar width

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
 * [depth, kind ('folder' | 'dbml' | 'json' | 'md' | 'sql' | 'other'), label, closed?] (a closed folder's chevron points
 * right); `lit(i)` 0..1 highlights row i,
 * `badge(i)` returns HTML at its right (the Source Control "U"). Rows are `rowH` apart from `top`.
 */
export function fileTree(rows, { top = 58, rowH = 40, width = 560, indent = 26, font = 22, lit = () => 0, badge = () => '', style = () => '', colour = () => null } = {}) {
  const ICOL = { folder: '#d9b35a', json: '#e8c46a', dbml: '#5ca2f8', md: '#8b9099', sql: '#e0a458', other: '#8b9099' };
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
