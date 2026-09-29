// Shared pieces of the VS Code window the scenes play in: the window frame, activity bar, the
// real "Get started with ERD Studio" walkthrough page, the orders canvas every canvas scene
// shares (so cuts between them are seamless) and VS Code's QuickPick shell.
//
// Product copy here is verbatim: `npm test` checks each constant against its source
// (package.json, src/commands/drawFromDbt.ts, src/providers/dbtDraftPicker.ts, the webview).
import { card, COLORS, ICON, esc, node } from './lib.js';

// ---------- the window (frame px) ----------
export const WIN = { x: 96, y: 322, w: 1728, h: 600 };
/** Frame position of the window body's top-left (card border 1 px + 64 px head). */
export const BODY = { x: WIN.x + 1, y: WIN.y + 65, w: WIN.w - 2, h: WIN.h - 66 };
export const ACT = 72;          // activity bar width
export const SIDE = 400;        // side bar width

export const editorWindow = ({ tabs, crumb = 'jaffle-shop', body, style = '', bodyCls = '' }) =>
  card({ ...WIN, tabs, crumb, body, style, bodyCls });

// ---------- activity bar ----------
const ai = (d) => `<svg class="icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ACT_ICONS = {
  files: ai('<path d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9z"/><path d="M13 3v6h6"/>'),
  search: ai('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>'),
  ext: ai('<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/><rect x="14.5" y="2.5" width="7" height="7" rx="1" transform="rotate(12 18 6)"/>'),
  erd: ai('<rect x="3" y="4" width="8" height="6" rx="1.2"/><rect x="13" y="14" width="8" height="6" rx="1.2"/><path d="M7 10v7h6"/>'),
};
/** Activity bar in body coordinates; `erd` adds ERD Studio's icon (fading in with erdOp). */
export function activityBar(active, { erd = true, erdOp = 1 } = {}) {
  const items = [['files', 20], ['search', 84], ['ext', 148]];
  if (erd) items.push(['erd', 212]);
  let h = `<div class="abs" style="left:0;top:0;width:${ACT}px;bottom:0;background:#131619;border-right:1px solid var(--card-border)"></div>`;
  for (const [k, y] of items) {
    const on = k === active;
    h += `<div class="abs" style="left:0;top:${y}px;width:${ACT}px;height:48px;display:flex;align-items:center;justify-content:center;color:${on ? 'var(--text)' : 'var(--text-3)'};${k === 'erd' ? `opacity:${erdOp.toFixed(3)};` : ''}">${ACT_ICONS[k]}</div>`;
    if (on) h += `<div class="abs" style="left:0;top:${y}px;width:3px;height:48px;background:var(--text)"></div>`;
  }
  return h;
}

// ---------- the Explorer side bar of the jaffle-shop project (body coordinates) ----------
export function explorerSide({ hot = 0, op = 1 } = {}) {
  const row = (y, label, { folder = false, lit = 0 } = {}) =>
    `<div class="abs" style="left:0;top:${y}px;width:${SIDE}px;height:44px;background:rgba(27,42,64,${lit.toFixed(3)});${lit > 0 ? `box-shadow:inset 4px 0 0 rgba(96,165,250,${lit.toFixed(3)});` : ''}display:flex;align-items:center;gap:10px;padding-left:${folder ? 18 : 50}px;font-size:23px;white-space:nowrap">
      ${folder ? `<span style="color:var(--text-2)">${ICON.chevRight({ size: 20 })}</span><span style="color:#d9b35a">${ICON.folder({ size: 24 })}</span>` : `<span style="color:#c490e8">${ICON.file({ size: 24 })}</span>`}${label}</div>`;
  return `<div class="abs" style="left:${ACT}px;top:0;width:${SIDE}px;bottom:0;background:#16181b;border-right:1px solid var(--card-border)"></div>
    <div class="abs" style="left:${ACT}px;top:0;width:${SIDE}px;bottom:0;opacity:${op.toFixed(3)}">
    <div class="abs" style="left:24px;top:20px;font-size:20px;font-weight:700;letter-spacing:.08em;color:var(--text-2)">EXPLORER</div>
    <div class="abs" style="left:14px;top:62px;display:flex;align-items:center;gap:6px;font-size:21px;font-weight:800;letter-spacing:.04em">${ICON.chevDown({ size: 20 })}JAFFLE-SHOP</div>
    ${row(100, 'models', { folder: true })}${row(144, 'seeds', { folder: true })}${row(188, 'target', { folder: true })}
    ${row(232, 'dbt_project.yml', { lit: hot })}${row(276, 'packages.yml')}</div>`;
}

// ---------- the extension listing (package.json) ----------
export const EXTENSION = {
  name: 'ERD Studio',
  publisher: 'liamwynne',
  description: 'Visual ERD designer for dbt: draw your models on a canvas, keep the design as YAML in your repo, compare it with dbt.',
};

// ---------- the walkthrough (package.json contributes.walkthroughs, id erdStudio.getStarted) ----------
// VS Code renders a step's command link that sits on its own line as a button; `text` is the
// rest of the description.
export const WALKTHROUGH = {
  title: 'Get started with ERD Studio',
  description: 'Draw your dbt project as an ERD in a minute, then enrich it with your AI assistant.',
  steps: [
    { id: 'watch', title: 'Watch the one-minute tour', svg: 'watch' },
    { id: 'sample', title: 'No dbt project? Try the sample', text: 'A small dbt project to try ERD Studio on.', button: 'Try the sample project', svg: 'sample' },
    { id: 'openProject', title: 'Open your dbt project', svg: 'open-project' },
    {
      id: 'draw', title: 'Draw your dbt project — no AI needed', svg: 'draw', button: 'Draw from dbt',
      text: 'Pick a folder of dbt models. ERD Studio copies their columns and relationship tests into a diagram you can edit, and lays it out for you.',
    },
    {
      id: 'enrich', title: 'Enrich it with your AI assistant', svg: 'enrich', button: 'Set Up My AI Helper',
      text: "Add grain, keys, rationale and your team's modelling style. This installs a guide for Claude Code, GitHub Copilot, Codex, Gemini CLI or Cursor; then type /erd-studio-setup in your assistant.",
    },
  ],
};

// The step images are the real media/walkthrough/*.svg files, inlined (an <img> could not use the
// page's fonts, and the video uses OFL fonts only). Fetched once, before the first frame.
const SVG_NAMES = ['watch', 'sample', 'open-project', 'draw', 'enrich'];
export const WALK_SVG = Object.fromEntries(await Promise.all(SVG_NAMES.map(async (n) => {
  const txt = await (await fetch(`/media/walkthrough/${n}.svg`, { cache: 'no-store' })).text();
  return [n, txt.replace(/font-family="[^"]*"/, 'font-family="Inter, sans-serif"')];
})));
/** A walkthrough image at width w (the sources are 480x300). */
export const walkSvg = (name, w) =>
  WALK_SVG[name].replace(/width="480" height="300"/, `width="${w}" height="${Math.round((w * 300) / 480)}"`);

/**
 * Geometry of the walkthrough page, in coordinates relative to its own left edge / the body top.
 * `wide` (no side bar) gives the step column and the image more room.
 */
export function wtGeom({ wide = false, open = 'draw' } = {}) {
  const W = wide ? BODY.w - ACT : BODY.w - ACT - SIDE;
  const g = { W, SX: 48, SW: wide ? 760 : 640, ROW: 48, STEPS_Y: 104, INDENT: 52, TEXT_W: wide ? 680 : 560, TEXT_LH: 28, BTN_H: 46 };
  g.IMG_X = g.SX + g.SW + 44;
  g.IMG_W = Math.min(W - g.IMG_X - 48, wide ? 760 : 520);
  const idx = WALKTHROUGH.steps.findIndex((s) => s.id === open);
  g.OPEN_Y = g.STEPS_Y + idx * g.ROW;
  const step = WALKTHROUGH.steps[idx];
  const perLine = g.TEXT_W / 9.6;                      // ~characters per line at 19 px Inter
  g.TEXT_LINES = step?.text ? Math.ceil(step.text.length / perLine) : 0;
  g.BTN_Y = 54 + g.TEXT_LINES * g.TEXT_LH + 14;         // relative to the open step's top
  g.OPEN_H = g.BTN_Y + g.BTN_H + 18;
  return g;
}

const doneDot = (size) =>
  `<span style="width:${size}px;height:${size}px;border-radius:50%;background:#3794ff;color:#0b1422;display:flex;align-items:center;justify-content:center;flex:none">${ICON.check({ size: Math.round(size * 0.68) })}</span>`;
const openDot = (size) => `<span style="width:${size}px;height:${size}px;border-radius:50%;display:block;border:2.5px solid #6c6f76;flex:none;box-sizing:border-box"></span>`;

/**
 * The Welcome editor's walkthrough page (origin = its top-left inside the body).
 * @param o.open   id of the expanded step   @param o.done  completed step ids
 * @param o.glow   0..1 highlight on the open step   @param o.press 0..1 click on its button
 * @param o.img    0..1 opacity of the step's image
 */
export function walkthrough({ open = 'draw', done = ['openProject'], glow = 0, press = 0, wide = false, img = 1 } = {}) {
  const g = wtGeom({ wide, open });
  let h = `<div class="abs" style="left:0;top:0;width:${g.W}px;bottom:0;background:var(--card)"></div>`;
  h += `<div class="abs" style="left:${g.SX}px;top:18px;font-size:32px;font-weight:800;letter-spacing:-.01em;white-space:nowrap">${WALKTHROUGH.title}</div>`;
  h += `<div class="abs" style="left:${g.SX}px;top:62px;font-size:20px;color:var(--text-2);white-space:nowrap">${WALKTHROUGH.description}</div>`;
  let y = g.STEPS_Y;
  for (const s of WALKTHROUGH.steps) {
    const dot = done.includes(s.id) ? doneDot(26) : openDot(26);
    if (s.id === open) {
      const bw = `rgba(55,148,255,${(0.3 + 0.7 * glow).toFixed(2)})`;
      const btnBg = press > 0 && press < 1 ? '#0b4f7d' : '#0e639c';
      h += `<div class="abs" style="left:${g.SX}px;top:${y}px;width:${g.SW}px;height:${g.OPEN_H}px;border-radius:10px;background:#ffffff0c;border:2px solid ${bw};box-shadow:0 0 ${(26 * glow).toFixed(1)}px rgba(55,148,255,${(0.35 * glow).toFixed(2)})">
        <div class="abs" style="left:13px;top:14px">${dot}</div>
        <div class="abs" style="left:${g.INDENT}px;top:10px;font-size:23px;line-height:34px;font-weight:700;white-space:nowrap">${esc(s.title)}</div>
        <div class="abs" style="left:${g.INDENT}px;top:54px;width:${g.TEXT_W}px;font-size:19px;line-height:${g.TEXT_LH}px;color:var(--text-2)">${esc(s.text)}</div>
        <div class="abs" style="left:${g.INDENT}px;top:${g.BTN_Y}px;height:${g.BTN_H}px;padding:0 22px;border-radius:5px;background:${btnBg};color:#fff;font-size:21px;font-weight:600;display:flex;align-items:center;white-space:nowrap">${s.button}</div>
      </div>`;
      y += g.OPEN_H + 6;
    } else {
      h += `<div class="abs" style="left:${g.SX}px;top:${y}px;width:${g.SW}px;height:${g.ROW}px;display:flex;align-items:center;gap:14px;padding-left:13px;font-size:21px;white-space:nowrap;color:${done.includes(s.id) ? 'var(--text-2)' : 'var(--text)'}">${dot}${esc(s.title)}</div>`;
      y += g.ROW;
    }
  }
  const step = WALKTHROUGH.steps.find((s) => s.id === open);
  if (step && img > 0) {
    h += `<div class="abs" style="left:${g.IMG_X}px;top:${g.STEPS_Y}px;opacity:${img.toFixed(3)}">${walkSvg(step.svg, g.IMG_W)}</div>`;
  }
  return h;
}
/** Frame-space centre of the open step's button. `left` = the walkthrough's left edge in body px. */
export function walkButton({ wide = false, open = 'draw', left = ACT + SIDE } = {}) {
  const g = wtGeom({ wide, open });
  const step = WALKTHROUGH.steps.find((s) => s.id === open);
  const w = 22 * 2 + step.button.length * 11.2;
  return { x: BODY.x + left + g.SX + g.INDENT + w / 2, y: BODY.y + g.OPEN_Y + g.BTN_Y + g.BTN_H / 2 };
}

// ---------- the orders canvas (Draw from dbt on a small jaffle-shop project's marts folder) ----------
// Four marts models, so the picker's "4 models" and the canvas agree. Keys come from the unique
// and relationship tests (markDraftKeys), types from each column's data_type in the schema .yml.
export const CANVAS = { toolbarX: BODY.x + 24, toolbarY: BODY.y + 16 };
export const MODELS = [
  { name: 'dim_customers', x: 135, y: 530, w: 350, cols: [{ key: 'PK', name: 'customer_id', type: 'VARCHAR' }, { name: 'customer_name', type: 'VARCHAR' }] },
  { name: 'fct_orders', x: 560, y: 490, w: 350, cols: [{ key: 'PK', name: 'order_id', type: 'VARCHAR' }, { key: 'FK', name: 'customer_id', type: 'VARCHAR' }, { name: 'ordered_at', type: 'DATE' }, { name: 'order_total', type: 'DECIMAL' }] },
  { name: 'fct_order_items', x: 985, y: 530, w: 370, cols: [{ key: 'PK', name: 'order_item_id', type: 'VARCHAR' }, { key: 'FK', name: 'order_id', type: 'VARCHAR' }, { key: 'FK', name: 'product_id', type: 'VARCHAR' }] },
  { name: 'dim_products', x: 1430, y: 510, w: 350, cols: [{ key: 'PK', name: 'product_id', type: 'VARCHAR' }, { name: 'product_name', type: 'VARCHAR' }, { name: 'product_price', type: 'DECIMAL' }] },
];
/** Frame y of the centre of column row i of a node at `top` (no grain line: a draft has none). */
export const ry = (top, i) => top + 62 + i * 46 + 23;
export const nodeH = (m) => 62 + m.cols.length * 46 + 6;

/**
 * The three relationship edges as orthogonal paths: [points, manyMark, oneMark].
 * `pos` overrides model positions (for the layout glide).
 */
export function orderEdges(pos = MODELS) {
  const [dc, fo, fi, dp] = pos.map((p, i) => ({ ...MODELS[i], ...p }));
  const jog = (a, b) => (a + b) / 2;
  const e = (from, fr, to, tr, dir) => {
    // from.side: the many end; dir -1 = to the left, +1 = to the right
    const x0 = dir < 0 ? from.x : from.x + from.w;
    const x1 = dir < 0 ? to.x + to.w : to.x;
    const y0 = ry(from.y, fr), y1 = ry(to.y, tr);
    const mx = jog(x0, x1);
    return [[[x0, y0], [mx, y0], [mx, y1], [x1, y1]], [dir < 0 ? x0 - 22 : x0 + 6, y0 - 8], [dir < 0 ? x1 + 8 : x1 - 20, y1 - 10]];
  };
  return [e(fo, 1, dc, 0, -1), e(fi, 1, fo, 0, -1), e(fi, 2, dp, 0, +1)];
}

/** A node with the canvas' layer badge. */
export const orderNode = (m, opts = {}) => node({ x: m.x, y: m.y, w: m.w, name: m.name, layer: 'GLD', cols: m.cols, ...opts });

export const STAGE_BLUE = COLORS.logical;

// ---------- VS Code QuickPick ----------
// The first QuickPick, as the command lists this project (dbtDraft.ts listDraftScopes: one row per
// folder, presentation folders first; detail = the first names, best-connected first).
export const DRAW_PICK = {
  title: 'Draw from dbt',
  placeholder: 'Which dbt models should the diagram start from?',
  rows: [
    { label: 'marts', description: '4 models', detail: 'fct_order_items, fct_orders, dim_customers, dim_products' },
    { label: 'staging', description: '4 models', detail: 'stg_customers, stg_order_items, stg_orders, stg_products' },
  ],
  choose: { label: 'Choose models…', description: 'pick up to 15 of 8' },
  progress: 'Reading your dbt project…',
  namePrompt: 'Name the diagram. It is saved in the Gold layer.',
  suggested: 'marts',
  name: 'orders',
};

export const QP = { x: WIN.x + (WIN.w - 900) / 2, y: WIN.y + 8, w: 900, title: 46, input: 56 };
/** QuickPick box with its title bar; `inner` is positioned inside it. */
export const quickPick = (title, inner, h, style = '') =>
  `<div class="abs" style="left:${QP.x}px;top:${QP.y}px;width:${QP.w}px;height:${h}px;border-radius:10px;background:#252526;border:1px solid #454545;box-shadow:0 18px 50px #000c;overflow:hidden;${style}">
    <div class="abs" style="left:0;right:0;top:0;height:${QP.title}px;display:flex;align-items:center;justify-content:center;font-size:21px;font-weight:600;color:var(--text-2);background:#1f1f20;border-bottom:1px solid #3a3a3c">${title}</div>
    ${inner}</div>`;
