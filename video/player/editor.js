// Shared pieces of the VS Code window the scenes play in: the window frame, the activity bar, the
// Explorer, ERD Studio's own side bar (Diagrams with its start entry, Table Library, Relationships,
// Help & Feedback), the draft page an import or the example opens, VS Code's QuickPick shell and
// the product copy every scene shows.
//
// Product copy here is verbatim: `npm test` checks each constant against its source (package.json,
// src/types/startActions.ts, src/providers/HelpTreeProvider.ts, src/services/draftModel.ts,
// webview-draft/, src/extension.ts).
import { card, edge, esc, ICON, node } from './lib.js';

// ---------- the window (frame px) ----------
export const WIN = { x: 96, y: 322, w: 1728, h: 600 };
/** Frame position of the window body's top-left (card border 1 px + 64 px head). */
export const BODY = { x: WIN.x + 1, y: WIN.y + 65, w: WIN.w - 2, h: WIN.h - 66 };
export const ACT = 72;          // activity bar width
export const SIDE = 400;        // side bar width
/** Left edge of the editor area beside the side bar, in body px. */
export const ED = ACT + SIDE;

export const editorWindow = ({ tabs, crumb = 'shop-analytics', body, style = '', bodyCls = '', win = WIN }) =>
  card({ ...win, tabs, crumb, body, style, bodyCls });

// ---------- activity bar ----------
const ai = (d) => `<svg class="icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ACT_ICONS = {
  files: ai('<path d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9z"/><path d="M13 3v6h6"/>'),
  search: ai('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>'),
  ext: ai('<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/><rect x="14.5" y="2.5" width="7" height="7" rx="1" transform="rotate(12 18 6)"/>'),
  erd: ai('<rect x="3" y="4" width="8" height="6" rx="1.2"/><rect x="13" y="14" width="8" height="6" rx="1.2"/><path d="M7 10v7h6"/>'),
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

// ---------- the Explorer side bar (body coordinates) ----------
// Every cut opens a plain folder: no dbt_project.yml (the dbt beat at the end of the default cut
// is the only place a dbt project appears).
export const PLAIN_EXPLORER = {
  root: 'SHOP-ANALYTICS',
  rows: [['docs', true], ['src', true], ['.gitignore', false], ['README.md', false]],
};
export function explorerSide({ op = 1, tree = PLAIN_EXPLORER } = {}) {
  const row = (y, label, folder) =>
    `<div class="abs" style="left:0;top:${y}px;width:${SIDE}px;height:44px;display:flex;align-items:center;gap:10px;padding-left:${folder ? 18 : 50}px;font-size:23px;white-space:nowrap">
      ${folder ? `<span style="color:var(--text-2)">${ICON.chevRight({ size: 20 })}</span><span style="color:#d9b35a">${ICON.folder({ size: 24 })}</span>` : `<span style="color:#c490e8">${ICON.file({ size: 24 })}</span>`}${label}</div>`;
  return `<div class="abs" style="left:${ACT}px;top:0;width:${SIDE}px;bottom:0;background:#16181b;border-right:1px solid var(--card-border)"></div>
    <div class="abs" style="left:${ACT}px;top:0;width:${SIDE}px;bottom:0;opacity:${op.toFixed(3)}">
    <div class="abs" style="left:24px;top:20px;font-size:20px;font-weight:700;letter-spacing:.08em;color:var(--text-2)">EXPLORER</div>
    <div class="abs" style="left:14px;top:62px;display:flex;align-items:center;gap:6px;font-size:21px;font-weight:800;letter-spacing:.04em">${ICON.chevDown({ size: 20 })}${tree.root}</div>
    ${tree.rows.map(([label, folder], i) => row(100 + i * 44, label, folder)).join('')}</div>`;
}

/**
 * An Explorer file tree (for the files scene and the README GIF). `rows` are
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
};
/**
 * The listing's description up to (not including) the first sentence that names dbt: what the
 * videos show (the listing's own words, fewer of them), so nothing before the default cut's last
 * beat names dbt. The description itself is read from package.json at runtime (main.js sets
 * window.PACKAGE_DESCRIPTION) and by the tests.
 */
export const descriptionWithoutDbt = (d = globalThis.PACKAGE_DESCRIPTION ?? '') => {
  const sentences = d.match(/[^.]+(?:\.|$)\s*/g) ?? [d];
  const i = sentences.findIndex((x) => /\bdbt\b/i.test(x));
  return (i < 0 ? sentences : sentences.slice(0, i)).join('').trim();
};

// ---------- ERD Studio's side bar (package.json views + viewsWelcome, HelpTreeProvider) ----------
/** The views of the ERD Studio container, in order (package.json contributes.views['erd-studio']). */
export const ERD_VIEWS = ['Diagrams', 'Table Library', 'Relationships', 'Help & Feedback'];
/**
 * The Diagrams view's start entry in a folder with no diagram and nothing to import (viewsWelcome,
 * `erdStudio.startIntent == blank`): one sentence, one button, one quiet link.
 */
export const SIDEBAR_START = { text: 'No diagrams yet.', button: 'New Diagram…', or: 'Or:', more: 'More ways to start…' };
/** The Help & Feedback view's rows (HELP_ACTIONS). */
export const HELP_ROWS = ['Set Up My AI Helper', 'Watch the One-Minute Tour', 'Show Me Around', 'Send Feedback', 'Show Logs'];
/** The Diagrams view's + (New…) menu in a folder without dbt (erdStudio.newMenu; Draw from dbt… shows only in a dbt project). */
export const NEW_MENU = ['New Diagram…', 'Import DBML…', 'Import SQL DDL…', 'Import Power BI or Fabric Semantic Model…', 'New Layer…'];

const SB = { head: 40, row: 38 };
/** A new project's layers (packages/core/src/types/layer.ts, a fresh folder's two): label, colour. */
export const LAYERS = { Silver: '#a0a0a0', Gold: '#d4a800' };
/** The layer row's swatch (src/providers/layerSwatch.ts: three stacked diamonds in the layer's colour). */
const layerSwatch = (c, size = 20) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 16 16"><path d="M8 1.5 14.5 5 8 8.5 1.5 5Z" fill="${c}"/><path d="M3.4 7.6 1.5 8.6 8 12.1 14.5 8.6 12.6 7.6 8 10.1Z" fill="${c}" fill-opacity=".55"/><path d="M3.4 11 1.5 12 8 15.5 14.5 12 12.6 11 8 13.5Z" fill="${c}" fill-opacity=".3"/></svg>`;
const filterGlyph = (size = 18) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16l-6 7.5V19l-4 1.5v-8z"/></svg>`;
const newFolderGlyph = (size = 20) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 10.5v5M9.5 13h5"/></svg>`;
/** The Diagrams view's rows for a new project with one diagram (DomainTreeProvider rootChildren, compact rows). */
export const ORDERS_TREE = [['Silver', []], ['Gold', ['orders']]];
/** The Table Library's welcome text before its first table (package.json viewsWelcome, its two paragraphs). */
export const LIBRARY_EMPTY = ['No tables yet.', "Each table is a file in .erd-studio/ you can commit and review like code. Add one on a diagram's canvas, or ask your AI assistant."];
/** The Table Library's rows for the tour's two tables (ModelLibraryTreeProvider: the layer, then its tables). */
export const ORDERS_LIBRARY = [['Gold', ['dim_customer', 'fct_order']]];

/**
 * The ERD Studio side bar, in body coordinates. `diagrams` null shows the start entry (startGlow /
 * startPress on its button); otherwise the Diagrams tree as DomainTreeProvider draws it, every
 * layer of layers.json ([[layer, [diagram, ...]], ...]): a layer row with its swatch and "Layer",
 * its diagrams, "New Diagram…  none in this layer yet" under a layer with none, and "New Layer…"
 * last. Table Library and Relationships exist only once .erd-studio does (`library`, by default
 * when there are diagrams; erdStudio.hasLogicalModelsDir): Table Library opens expanded with
 * `tables` unless `libraryOpen` is false (a scene that needs the room), Relationships collapsed.
 * `help` opens Help & Feedback with its rows (`helpHot` = index lit, `helpPress` 0..1). The
 * Diagrams header always has its + (New…) and filter actions (a folder is open). Returns
 * { html, geo } where geo holds frame-space points the scenes aim the pointer at.
 */
export function erdSide({ diagrams = null, library = diagrams !== null, libraryOpen = true, tables = ORDERS_LIBRARY, startGlow = 0, startPress = 0, help = false, helpHot = -1, helpPress = 0, plusHot = 0, selected = null, op = 1 } = {}) {
  const x0 = ACT;
  const geo = {};
  const icon = (inner, hot = 0) => `<span style="width:30px;height:30px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--text);${hot > 0 ? `background:rgba(90,93,100,${(0.6 * hot).toFixed(3)});` : ''}">${inner}</span>`;
  const header = (y, label, open, actions = '') => `<div class="abs" style="left:0;top:${y}px;width:${SIDE}px;height:${SB.head}px;display:flex;align-items:center;gap:6px;padding-left:10px;font-size:18px;font-weight:800;letter-spacing:.05em;border-top:1px solid #2a2c31;white-space:nowrap">
      <span style="color:var(--text-2);display:flex">${open ? ICON.chevDown({ size: 18, sw: 2.6 }) : ICON.chevRight({ size: 18, sw: 2.6 })}</span>${label.toUpperCase()}
      ${actions ? `<span style="margin-left:auto;margin-right:10px;display:flex;gap:6px">${actions}</span>` : ''}</div>`;
  const row = (y, indent, glyph, label, desc = '', sel = false) => `${sel ? `<div class="abs" style="left:0;top:${y}px;width:${SIDE}px;height:${SB.row}px;background:#04395e"></div>` : ''}
      <div class="abs" style="left:${indent}px;top:${y}px;height:${SB.row}px;display:flex;align-items:center;gap:10px;font-size:20px;white-space:nowrap">${glyph}${label}${desc ? `<span style="font-size:17px;color:var(--text-3);margin-left:4px">${desc}</span>` : ''}</div>`;
  const chev = (open) => `<span style="color:var(--text-2);display:flex">${open ? ICON.chevDown({ size: 18, sw: 2.6 }) : ICON.chevRight({ size: 18, sw: 2.6 })}</span>`;
  let h = `<div class="abs" style="left:0;top:0;width:${SIDE}px;height:52px;display:flex;align-items:center;padding-left:24px;font-size:20px;font-weight:700;letter-spacing:.08em;color:var(--text-2)">ERD STUDIO</div>`;
  let y = 52;
  // view/title: the + (New…) submenu (navigation@0), then Filter Diagrams… (navigation@1)
  h += header(y, ERD_VIEWS[0], true, icon(ICON.plus({ size: 18, sw: 2.6 }), plusHot) + icon(filterGlyph()));
  geo.plus = { x: BODY.x + x0 + SIDE - 10 - 30 - 6 - 15, y: BODY.y + y + SB.head / 2 };
  y += SB.head;
  if (diagrams === null) {
    h += `<div class="abs" style="left:24px;top:${y + 14}px;font-size:20px;color:var(--text-2);white-space:nowrap">${SIDEBAR_START.text}</div>`;
    const by = y + 54;
    const bg = startPress > 0 && startPress < 1 ? '#0b4f7d' : '#0e639c';
    h += `<div class="abs" style="left:20px;right:20px;top:${by}px;height:44px;border-radius:4px;background:${bg};color:#fff;font-size:20px;font-weight:600;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 ${(3 * startGlow).toFixed(1)}px rgba(55,148,255,${(0.6 * startGlow).toFixed(3)}),0 0 ${(24 * startGlow).toFixed(1)}px rgba(55,148,255,${(0.5 * startGlow).toFixed(3)})">${SIDEBAR_START.button}</div>`;
    geo.start = { x: BODY.x + x0 + SIDE / 2, y: BODY.y + by + 22 };
    h += `<div class="abs" style="left:24px;top:${by + 60}px;font-size:19px;color:var(--text-2);white-space:nowrap">${SIDEBAR_START.or} <span style="color:#3794ff">${SIDEBAR_START.more}</span></div>`;
    y = by + 108;
  } else {
    for (const [layer, items] of diagrams) {
      h += row(y, 14, `${chev(true)}<span style="display:flex">${layerSwatch(LAYERS[layer] ?? '#8a94a3')}</span>`, layer, 'Layer');
      y += SB.row;
      for (const d of items) {
        h += row(y, 52, `<span style="color:#5ca2f8;display:flex">${ICON.erdMark({ size: 20 })}</span>`, d, '', d === selected);
        y += SB.row;
      }
      if (items.length === 0) {
        h += row(y, 52, `<span style="color:var(--text-2);display:flex">${ICON.plus({ size: 18, sw: 2.4 })}</span>`, 'New Diagram…', 'none in this layer yet');
        y += SB.row;
      }
    }
    h += row(y, 22, `<span style="color:var(--text-2);display:flex">${newFolderGlyph()}</span>`, 'New Layer…');
    y += SB.row + 6;
  }
  if (library) {
    h += header(y, ERD_VIEWS[1], libraryOpen); y += SB.head;
    if (libraryOpen && tables.length === 0) {
      // its welcome text while the library is empty (viewsWelcome, the pane clips what does not fit)
      h += `<div class="abs" style="left:24px;right:20px;top:${y + 8}px;font-size:19px;color:var(--text-2);white-space:nowrap">${LIBRARY_EMPTY[0]}</div>
        <div class="abs" style="left:24px;right:20px;top:${y + 38}px;height:48px;overflow:hidden;font-size:16px;line-height:24px;color:var(--text-3)">${LIBRARY_EMPTY[1]}</div>`;
      y += 94;
    } else if (libraryOpen) {
      for (const [layer, names] of tables) {
        h += row(y, 14, `${chev(true)}<span style="display:flex">${layerSwatch(LAYERS[layer] ?? '#8a94a3')}</span>`, layer, 'Layer');
        y += SB.row;
        for (const n of names) {
          h += row(y, 52, `<span style="color:#5ca2f8;display:flex">${ICON.table({ size: 20 })}</span>`, n);
          y += SB.row;
        }
      }
      y += 6;
    }
    h += header(y, ERD_VIEWS[2], false); y += SB.head;
  }
  h += header(y, ERD_VIEWS[3], help); y += SB.head;
  if (help) {
    HELP_ROWS.forEach((label, i) => {
      const hot = i === helpHot;
      h += `<div class="abs" style="left:0;top:${y}px;width:${SIDE}px;height:${SB.row}px;${hot ? `background:${helpPress > 0 && helpPress < 1 ? '#0b4f7d' : '#04395e'};` : ''}"></div>
        <div class="abs" style="left:34px;top:${y}px;height:${SB.row}px;display:flex;align-items:center;gap:12px;font-size:20px;white-space:nowrap;color:var(--text)"><span style="color:${i === 0 ? '#c490e8' : 'var(--text-2)'};display:flex">${i === 0 ? ICON.sparkle({ size: 20 }) : i === 1 ? ICON.playCircle({ size: 20 }) : ICON.dot({ size: 20 })}</span>${label}</div>`;
      if (i === 0) geo.aiHelper = { x: BODY.x + x0 + 150, y: BODY.y + y + SB.row / 2 };
      y += SB.row;
    });
  }
  const html = `<div class="abs" style="left:${x0}px;top:0;width:${SIDE}px;bottom:0;background:#16181b;border-right:1px solid var(--card-border)"></div>
    <div class="abs" style="left:${x0}px;top:0;width:${SIDE}px;bottom:0;overflow:hidden;opacity:${op.toFixed(3)}">${h}</div>`;
  return { html, geo };
}

/** The + (New…) menu under the Diagrams view's title, at frame point `at` (the + icon). `hot` = row lit. */
export function newMenu(at, { hot = -1, op = 1 } = {}) {
  const items = NEW_MENU.map((label, i) => `${i === NEW_MENU.length - 1 ? '<div style="height:1px;margin:6px 0;background:#3a3c42"></div>' : ''}<div style="height:40px;display:flex;align-items:center;padding:0 16px;border-radius:4px;font-size:19px;white-space:nowrap;${i === hot ? 'background:#04395e;' : ''}">${label}</div>`).join('');
  return `<div class="abs" style="left:${at.x - 24}px;top:${at.y + 22}px;width:470px;padding:6px;border-radius:8px;background:#252526;border:1px solid #454545;box-shadow:0 14px 40px #000c;opacity:${op.toFixed(3)}">${items}</div>`;
}
/** Frame centre of menu row i, for a menu opened at `at`. */
export const newMenuRow = (at, i) => ({ x: at.x + 160, y: at.y + 22 + 6 + i * 40 + 20 });

// ---------- the draft page (webview-draft: DraftBanner, a read-only canvas) ----------
// What opens when a start reads something in (src/services/draftModel.ts): the banner's
// headline and detail, its buttons, and the diagram it would keep, drawn read-only. Nothing is
// written until Keep.
/** The coffee-shop example a plain folder's first visit opens (the automatic example draft). */
export const EXAMPLE_DRAFT = {
  tab: 'Example: Coffee shop',
  headline: 'Example: a coffee-shop star schema · 6 tables, 8 relationships · not saved',
  detail: 'Keep saves it as coffee-shop in the Gold layer (.erd-studio/gold/diagrams/coffee-shop.dbml).',
  scope: { label: 'Example', value: 'Coffee shop · 6 tables' },
  // [label, kind]: the one primary (New Diagram…), the guide beside it, Keep (quiet), the menu, Discard.
  buttons: [['New Diagram…', 'primary'], ['Bring In Your Data Model…', 'secondary'], ['Keep This Example', 'quiet'], ['More ways to start', 'menu'], ['Discard', 'secondary']],
  // The example's six tables and all eight of its relationships (openExampleDiagram.ts EXAMPLE_DBML:
  // fct_orders has three refs, fct_order_items five), a few columns each.
  details: true,
  tables: [
    { name: 'dim_customers', x: 0, y: 0, cols: [['PK', 'customer_id', 'varchar'], [null, 'customer_name', 'varchar'], [null, 'customer_type', 'varchar']] },
    { name: 'dim_locations', x: 0, y: 330, cols: [['PK', 'location_id', 'varchar'], [null, 'location_name', 'varchar']] },
    { name: 'fct_orders', x: 520, y: 40, cols: [['PK', 'order_id', 'varchar'], ['FK', 'customer_id', 'varchar'], ['FK', 'location_id', 'varchar'], ['FK', 'order_date', 'date'], [null, 'order_total', 'decimal']] },
    { name: 'dim_dates', x: 1560, y: 420, cols: [['PK', 'date_day', 'date'], [null, 'month_name', 'varchar']] },
    { name: 'fct_order_items', x: 1040, y: 260, cols: [['PK', 'order_item_id', 'varchar'], ['FK', 'order_id', 'varchar'], ['FK', 'customer_id', 'varchar'], ['FK', 'location_id', 'varchar'], ['FK', 'product_id', 'varchar'], ['FK', 'order_date', 'date']] },
    { name: 'dim_products', x: 1560, y: 0, cols: [['PK', 'product_id', 'varchar'], [null, 'product_name', 'varchar'], [null, 'product_price', 'decimal']] },
  ],
  // [from table, from row, to table, to row]
  rels: [[2, 1, 0, 0], [2, 2, 1, 0], [2, 3, 3, 0], [4, 1, 2, 0], [4, 2, 0, 0], [4, 3, 1, 0], [4, 4, 5, 0], [4, 5, 3, 0]],
};
/** What Import DBML… shows for a sales.dbml before anything is written (draftFromImportPlan). */
export const SALES_DRAFT = {
  tab: 'Draft: sales',
  file: 'sales.dbml',
  headline: 'Draft from sales.dbml · 5 tables, 4 relationships · not saved',
  detail: 'Keep saves it as sales in the Gold layer (.erd-studio/gold/diagrams/sales.dbml).',
  // Keep is the primary; the other starts (FIND_STARTS) sit in the menu.
  buttons: [['Keep as Diagram', 'primary'], ['More ways to start', 'menu'], ['Discard', 'secondary']],
  // An import's draft always carries its review (draftModel detailsFromImportReview): "Show details".
  details: true,
  // No name the tour's library already has (dim_customer, fct_order, nor the README GIF's dim_date):
  // a name that is would be reused, and the detail would say so.
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
    h += node({ x: t.x, y: t.y, w: MINI_W, name: t.name, layer: 'GLD', cols: t.cols.map(([key, name, type]) => ({ key: key ?? undefined, name, type })), style: `opacity:${op.toFixed(3)};` });
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

// ---------- the canvas ----------
export const CANVAS = { toolbarX: BODY.x + 24, toolbarY: BODY.y + 16 };

// ---------- VS Code QuickPick ----------
export const QP = { x: WIN.x + (WIN.w - 900) / 2, y: WIN.y + 8, w: 900, title: 46, input: 56 };
/** QuickPick box with its title bar; `inner` is positioned inside it. */
export const quickPick = (title, inner, h, style = '') =>
  `<div class="abs" style="left:${QP.x}px;top:${QP.y}px;width:${QP.w}px;height:${h}px;border-radius:10px;background:#252526;border:1px solid #454545;box-shadow:0 18px 50px #000c;overflow:hidden;${style}">
    <div class="abs" style="left:0;right:0;top:0;height:${QP.title}px;display:flex;align-items:center;justify-content:center;font-size:21px;font-weight:600;color:var(--text-2);background:#1f1f20;border-bottom:1px solid #3a3a3c">${title}</div>
    ${inner}</div>`;

// ---------- New Diagram (erdStudio.createDomain), the first diagram ----------
// The name box as a fresh DBML project shows it: no diagrams yet, so the first one goes in the
// last creatable layer (Gold) by itself and the prompt says where (src/extension.ts). The
// validator's Info message says what the typed name is saved as (src/commands/diagramName.ts).
export const NEW_DIAGRAM = {
  title: 'New Diagram',
  placeholder: 'e.g. Customer 360, Sales, Orders',
  prompt: 'Name the diagram. Saved in the Gold layer — Move Diagram to Layer… changes it later.',
  savedAs: (slug) => `Saved as ${slug}`,
  name: 'Orders',
  /** The diagram file it writes, relative to the folder (`<layer>/diagrams/<slug>.dbml`). */
  file: '.erd-studio/gold/diagrams/orders.dbml',
};
