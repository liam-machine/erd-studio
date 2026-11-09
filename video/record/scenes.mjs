// What the pointer does in each recorded scene of the default cut, keyed to the narration's beats
// (build/timeline.json, from the real voice clips). record.mjs runs each scene's `prep` off camera,
// then films `run`: `at(s)` waits until s seconds into the scene, so a click lands on the word that
// names it, and the scene is filmed for exactly its timeline duration (a scene with a fast-forward:
// for as long as its wait takes, then sped up to fit; `ff.start()` / `ff.end()` mark the wait).
//
// Takes: `plain` is one continuous session in the project folder (record/fixtures.mjs); its scenes
// are filmed in the order below, which is not the video's: the hook (the finished diagram) is filmed
// last and cut to the front. `big` is a second session, in a 2,000-table project (the scale scene,
// one uncut take). `dbt` is a third, in the dbt project that holds the files the plain take wrote.
//
// Every label clicked here is the product's own (the pipeline test reads them back out of
// record/takes.json, the text that was on screen while each scene was filmed).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, wb, wv } from './driver.mjs';
import { PG_DUMP, plainFolder } from './fixtures.mjs';

const ERD_ICON = wb('.activitybar [aria-label^="ERD Studio"]');
const EXPLORER_ICON = wb('.activitybar [aria-label^="Explorer"]');
const sideRow = (text, extra = '') => wb(`.part.sidebar .monaco-list-row${extra}`, { text });
const explorerRow = (text) => wb('.explorer-folders-view .monaco-list-row', { text });
const pickRow = (re) => wb('.quick-input-widget .monaco-list-row', { re });
const button = (text) => wv('button', { text });
const ADD = wv('button', { re: '^\\+ Add' });
const LAYOUT = wv('button', { re: 'Layout$' });
const STARTER = wv('select.new-model-dialog__select');
const TERMINAL = wb('.part.panel .xterm');
/** Where the drawn pointer waits off camera: past the window's right edge (composite clips it there). */
const OFF_WINDOW = { x: 1480, y: 300 };
/** An empty spot of the editor's tab bar, where the real mouse rests when it must not hover anything on the canvas. */
const TAB_BAR = { x: 1100, y: 48 };
/** The Diagrams view's New… menu (its title bar's +) and its Import from dbt… item. */
const NEW_MENU = wb('.part.sidebar .pane-header .action-label[aria-label^="New…"]');
const menuItem = (re) => wb('.monaco-menu .action-label', { re });

/** The schema the shop's tables are in (the PostgreSQL database's `sales`, record/fixtures.mjs): the import keeps it, so each table's file is under tables/<schema>/. */
export const SCHEMA = 'sales';
/** The diagram the import makes, named from the folder it imported (the name box's default). */
export const DIAGRAM = 'shop-analytics';

/** The scale take's diagram (record/bigProject.mjs): 2,000 tables, about 2,700 relationships. */
export const BIG_DIAGRAM = 'enterprise_warehouse';

/** The table the scale scene hovers, and how far it zooms in on it (wheel steps and their size). */
export const HOVER_TABLE = 'fct_site_search';
const ZOOM_STEPS = 5;
const ZOOM_DELTA = 358;

/** What Claude Code is asked, typed into its prompt. */
export const CLAUDE_REQUEST = 'Add a dim_customer table, linked to fct_order';
/** The table added by hand. */
export const HAND_TABLE = 'dim_promotion';

/** The terminal's visible rows (the DOM renderer: record/vscode.mjs turns GPU rendering off). */
const terminalRows = (d) => d.ev("[...document.querySelectorAll('.part.panel .xterm-rows > div')].map((r) => r.textContent)");

/** Cmd+K in the terminal: VS Code's Terminal: Clear (the scrollback, Claude Code's banner with it). */
const clearTerminal = (d) => d.key('k', { code: 'KeyK', keyCode: 75, modifiers: 4 });
/** Ctrl+`: the terminal panel (record/vscode.mjs puts the panel on the right). */
const toggleTerminal = (d) => d.key('`', { code: 'Backquote', keyCode: 192, modifiers: 2 });
/** Cmd+B: the primary side bar. */
const toggleSideBar = (d) => d.key('b', { code: 'KeyB', keyCode: 66, modifiers: 4 });
/** The panel's Hide Panel button (a key would go to whichever webview has the focus). */
const closePanel = (d, ms = 1) => d.click(wb('.part.panel .action-label.codicon-panel-close'), { ms });
const SIDE_BAR_VISIBLE = "!!document.querySelector('.part.sidebar') && document.querySelector('.part.sidebar').getBoundingClientRect().width > 10";
const sideBarVisible = (d) => d.ev(SIDE_BAR_VISIBLE);
const panelVisible = (d) => d.ev("!!document.querySelector('.part.panel') && document.querySelector('.part.panel').getBoundingClientRect().width > 10");

/** The panel's left edge (the sash between the editor and the panel on the right), in workbench px. */
async function panelSash(d) {
  return d.ev(`(() => { const p = document.querySelector('.part.panel').getBoundingClientRect();
    const s = [...document.querySelectorAll('.monaco-sash.vertical')].map((e) => e.getBoundingClientRect()).find((r) => r.height > 300 && Math.abs(r.left + r.width / 2 - p.left) < 8);
    return s ? { x: s.left + s.width / 2, y: s.top + s.height / 2 } : null; })()`);
}

/** New Table on the canvas: the name, a starter-columns template, Create Table. */
async function newTable(d, name, template) {
  await d.click(wv('input[placeholder="table_name"]'), { ms: 380 });
  await d.type(name, 30);
  await sleep(80);
  await d.pick(STARTER, template, { ms: 380 });
  await sleep(220);
  await d.click(button('Create Table'), { ms: 420 });
}

/**
 * Whether a table on the canvas sits under (or against) the minimap, which React Flow draws in the
 * canvas's bottom-right corner over whatever is there; and the canvas's top-left, in workbench px.
 */
async function minimapOverlap(d) {
  const r = await d.inWebview(`(() => {
    const m = D.querySelector('.react-flow__minimap'), pane = D.querySelector('.react-flow');
    if (!m || !pane) return null;
    const mr = m.getBoundingClientRect(), pr = pane.getBoundingClientRect(), pad = 18;
    const hit = [...D.querySelectorAll('.react-flow__node')].some((n) => { const b = n.getBoundingClientRect();
      return b.width > 0 && b.right > mr.left - pad && b.bottom > mr.top - pad && b.left < mr.right && b.top < mr.bottom; });
    return { hit, x: pr.left, y: pr.top };
  })()`, "D.querySelector('.react-flow__minimap')");
  return r?.value ? { hit: r.value.hit, x: r.x + r.value.x, y: r.y + r.value.y } : null;
}

/**
 * Zooms the canvas out about its top-left corner, a small wheel step at a time (so on camera it reads
 * as one short zoom), until no table sits under the minimap: the diagram stays whole and in the open.
 * The real mouse ends on the canvas's top-left margin; the drawn pointer does not move.
 */
async function clearOfMinimap(d, { step = 40, every = 45, max = 16 } = {}) {
  for (let i = 0; i < max; i++) {
    const m = await minimapOverlap(d);
    if (!m || !m.hit) return i;
    await d.wheel({ x: m.x + 20, y: m.y + 70 }, step);
    await sleep(every);
  }
  return max;
}

/**
 * Scrolls the active text editor (showing `file`, read from disk to find the line) so the first line
 * matching `re` is near its top: a few wheel steps, so on camera it reads as one scroll. The real
 * mouse ends over the editor.
 */
async function scrollEditorTo(d, file, re, { steps = 5, every = 50, above = 1 } = {}) {
  const line = readFileSync(file, 'utf8').split('\n').findIndex((l) => re.test(l)) + 1;
  if (line < 1) return;
  const top = () => d.ev(`(() => { const nums = [...document.querySelectorAll('.editor-group-container.active .margin-view-overlays .line-numbers')]
    .filter((n) => n.getBoundingClientRect().top >= document.querySelector('.editor-group-container.active .monaco-scrollable-element.editor-scrollable').getBoundingClientRect().top - 2)
    .map((n) => +n.textContent).filter((n) => n > 0); return nums.length ? Math.min(...nums) : null; })()`);
  const ed = await d.ev(`(() => { const e = document.querySelector('.editor-group-container.active .monaco-scrollable-element.editor-scrollable'); const r = e?.getBoundingClientRect();
    const row = document.querySelector('.editor-group-container.active .view-lines .view-line'); return r ? { x: r.left + 200, y: r.top + 150, lh: row ? row.getBoundingClientRect().height : 19 } : null; })()`);
  if (!ed) return;
  // Monaco's wheel step is not one pixel per deltaY pixel: scroll, see where it got, and close the rest
  for (let round = 0; round < 4; round++) {
    const at = await top();
    if (at === null) return;
    const left = line - above - at;
    if (Math.abs(left) < 1) return;
    for (let i = 0; i < steps; i++) { await d.wheel(ed, (left * ed.lh) / steps); await sleep(every); }
    await sleep(100);
    steps = 2;
  }
}

/**
 * Where a table's card is on screen (workbench px), at (fx, fy) of its box, found by its node id
 * with one querySelector: the driver's general finder reads every element of the page (shadow roots,
 * text), which takes seconds with 2,000 cards drawn.
 */
async function cardAt(d, id, fx, fy) {
  const r = await d.inWebview(`(() => { const b = D.querySelector('.react-flow__node[data-id="${id}"]')?.getBoundingClientRect();
    return b ? { x: b.left + b.width * ${fx}, y: b.top + b.height * ${fy} } : null; })()`, "D.querySelector('.react-flow')");
  if (!r?.value) throw new Error(`no card ${id} on the canvas`);
  return { x: r.x + r.value.x, y: r.y + r.value.y };
}

/**
 * What the canvas says of its line routing: its tables, and the renderer's own note of its last
 * routing pass (`.react-flow`'s data-edge-routing, packages/renderer EdgeRouting.tsx: "routed
 * 2291ms 2719" once the worker's routes are applied, "pending …" before). Cheap to read, so the
 * polling does not slow the canvas it times.
 */
const EDGE_PRINT = `({ nodes: D.querySelectorAll('.react-flow__node').length, routing: D.querySelector('.react-flow')?.dataset.edgeRouting ?? '' })`;

/**
 * Watches the canvas from `t0` (ms, when the diagram was clicked open) until its lines are routed:
 * when the first tables showed, when the routed lines were applied (both ms after t0; on screen,
 * the routed lines replace the first, straight ones then), and the routing pass's own time.
 */
async function watchRouting(d, t0, { max = 40000, every = 150 } = {}) {
  let first = null;
  for (;;) {
    const r = await d.inWebview(EDGE_PRINT, "D.querySelector('.react-flow')").catch(() => null);
    const now = Date.now() - t0;
    const v = r?.value;
    if (v && v.nodes > 0 && first === null) first = now;
    const m = v && /^routed (\d+)ms (\d+)/.exec(v.routing);
    if (m) return { firstTablesMs: first, linesRoutedMs: now, onScreenAfterTablesMs: first === null ? null : now - first, passMs: +m[1], lines: +m[2], tables: v.nodes };
    if (now > max) return { firstTablesMs: first, timedOut: true };
    await sleep(every);
  }
}

/** The diagram's canvas tab in front, the whole diagram in view and clear of the minimap, nothing selected. */
async function canvasInView(d, { click = { x: 0, y: 0 } } = {}) {
  await d.click(wb(`.tabs-container .tab[data-resource-name="${DIAGRAM}.dbml"]`), { ms: 1 });
  await d.waitFor(button('Fit'));
  await sleep(500);
  await d.click(button('Fit'), { ms: 1 });
  await sleep(700);
  await clearOfMinimap(d);
  await sleep(200);
  if (click.x) await d.click(click, { ms: 1 });
}

/** The terminal panel's left edge for the export scene (workbench px): wide enough for the pg_dump command on one line. */
const EXPORT_SASH_X = 760;

export const TAKES = {
  plain: {
    folder: 'plain',
    /**
     * Before the first scene: the folder in the Explorer (no DDL yet), and the terminal open on the
     * right, wide enough for the pg_dump command, at its `$ ` prompt.
     */
    async prep(d) {
      // the Explorer in the side bar (its icon would close the side bar if it is already showing)
      if (!(await d.ev(`!!document.querySelector('.activitybar .action-item.checked [aria-label^="Explorer"], .activitybar .action-item.checked[aria-label^="Explorer"]') && (${SIDE_BAR_VISIBLE})`))) await d.click(EXPLORER_ICON, { ms: 1 });
      await sleep(400);
      if (!(await panelVisible(d))) await toggleTerminal(d);
      await d.waitFor(TERMINAL);
      await sleep(800);
      const sash = await panelSash(d);
      if (sash) await d.drag(sash, { dx: EXPORT_SASH_X - sash.x, ms: 300, glideMs: 1 });
      await sleep(400);
      await d.click(TERMINAL, { ms: 1 });
      await clearTerminal(d);
      await sleep(400);
      await d.place({ x: 560, y: 330 });
      await d.glide({ x: 560, y: 330 }, 50);
      await d.parkMouse({ x: 560, y: 330 });
    },
    scenes: ['export', 'importSql', 'draft', 'files', 'byHand', 'aiSetup', 'aiRun', 'hook'],
  },
  big: {
    folder: 'big',
    async prep(d) {
      await d.click(ERD_ICON, { ms: 1 });
      await d.waitFor(sideRow(BIG_DIAGRAM), 20000);
      // a first-open toast ("This project has 1 ERD Studio diagram") is not part of the tour
      const notNow = wb('.notifications-toasts .monaco-button', { text: 'Not now' });
      await d.waitFor(notNow, 10000).then(() => d.click(notNow, { ms: 1 })).catch(() => {});
      await sleep(800);
      await d.place({ x: 900, y: 330 });
      await d.glide({ x: 900, y: 330 }, 50);
    },
    scenes: ['scale'],
  },
  dbt: {
    folder: 'dbt',
    async prep(d) {
      await d.click(ERD_ICON, { ms: 1 });
      await d.click(sideRow(DIAGRAM), { ms: 1 });
      await d.waitFor(button('Run dbt parse'), 20000);
      await sleep(1500);
      // a first-open toast ("This project has 1 ERD Studio diagram", which can take a few seconds) is not part of the tour
      const notNow = wb('.notifications-toasts .monaco-button', { text: 'Not now' });
      await d.waitFor(notNow, 8000).then(() => d.click(notNow, { ms: 1 })).catch(() => {});
      // the side bar stays open (its New… menu is where Import from dbt is); the scene hides it before
      // Run dbt parse, so the comparison's marks and panel get the window's width
      await d.click(button('Fit'), { ms: 1 });
      await sleep(800);
      await clearOfMinimap(d);
      await sleep(200);
      await d.place({ x: 1000, y: 420 });
      await d.glide({ x: 1000, y: 420 }, 50);
    },
    scenes: ['dbt'],
  },
};

export const SCENES = {
  // "Getting the DDL out is one step, for a whole schema or database. From PostgreSQL, pg_dump writes
  // it to a file. From Snowflake, it's one query, GET_DDL, saved as a .sql file." The terminal (opened
  // off camera, on the right) runs pg_dump against the shop database for real; sales.sql lands in the
  // Explorer and opens, scrolled to its CREATE TABLEs. Snowflake's query is a card beside the window
  // (player/scenes/rec/window.js props.query), not filmed.
  export: {
    async run(d, { at, beats, shot }) {
      await at(beats.pg.t + 0.15);
      await d.click(TERMINAL, { ms: 600, dx: 0.3, dy: 0.06 });
      await d.type(PG_DUMP, 24);
      await sleep(200);
      await d.enter();
      const file = explorerRow('sales.sql');
      await d.waitFor(file, 10000);
      await shot('dumped');
      await at(beats.pg.end + 0.4);   // the file it wrote, in the folder (as the punch-in on the terminal lets go)
      await d.click(file, { ms: 650 });
      await d.waitFor(wb('.tabs-container .tab[data-resource-name="sales.sql"]'));
      await sleep(300);
      if (await panelVisible(d)) await closePanel(d, 450);   // the dump gets the window's width
      await sleep(250);
      // the drawn pointer to the editor; the dump scrolled down to its first CREATE TABLE
      await d.moveTo({ x: 820, y: 330 }, { ms: 500, hover: false });
      await d.parkMouse({ x: 820, y: 330 });
      await scrollEditorTo(d, join(plainFolder(), 'sales.sql'), /^CREATE TABLE /);
      // the pointer runs down the CREATE TABLE lines (the query card is beside the window by now)
      await d.moveTo({ x: 700, y: 420 }, { ms: 1100, hover: false });
    },
  },
  // "Then click New, Import SQL DDL, and import the folder. It works out the dialect: PostgreSQL, one
  // of the nine it reads." The Diagrams view's New… menu, Import SQL DDL…, the file dialog opened on
  // the project folder (sales.sql in it) and its Import (every .sql file in the folder), the dialect
  // pick (all nine, PostgreSQL first, marked as detected), then the name box (the folder's name).
  importSql: {
    async run(d, { at, beats, shot }) {
      await at(0.05);
      await d.click(ERD_ICON, { ms: 350 });
      await d.waitFor(NEW_MENU);
      await at(beats.import.t + 0.35);   // "click New" (each click lands at the end of its glide)
      await d.click(NEW_MENU, { ms: 450, synthetic: true });
      const item = menuItem('^Import SQL DDL');
      await d.waitFor(item, 5000);
      await at(beats.import.t + 1.1);    // "Import SQL DDL"
      await d.click(item, { ms: 400 });
      await d.parkMouse({ x: 1300, y: 560 });
      // the file dialog opens on the project folder: Import takes the folder, every .sql file in it
      const importFolder = wb('.quick-input-widget .monaco-button', { text: 'Import' });
      await d.waitFor(importFolder, 10000);
      await d.waitFor(pickRow('^.?sales\\.sql$'), 10000);
      await at(beats.import.t + 2.55);   // "import the folder"
      await d.click(importFolder, { ms: 500 });
      await d.parkMouse({ x: 1300, y: 560 });
      const pg = pickRow('PostgreSQL');
      await d.waitFor(pg, 20000);
      // the drawn pointer runs down the nine dialects (the real mouse stays put: no tooltip)
      await at(beats.dialect.t + 0.3);
      const last = await d.locate(pickRow('^SQLite'), { dx: 0.25 }).catch(() => null);
      if (last) await d.moveTo({ x: last.x, y: last.y }, { ms: 900, hover: false });
      await shot('dialects');
      await at(beats.dialect.t + 1.5);   // "PostgreSQL" (the click lands at the end of its glide)
      await d.click(pg, { ms: 600, dx: 0.25 });
      await d.waitFor(wb('.quick-input-message', { re: '^Name the diagram' }), 20000);
    },
  },
  // "You get a draft of every table and relationship. Keep it, and it's your diagram."
  draft: {
    async run(d, { at, beats }) {
      await at(beats.draft.t);
      await d.enter();   // the name box: the folder's name
      await d.waitFor(button('Keep as Diagram'), 20000);
      await at(beats.keep.t + 0.3);
      await d.click(button('Keep as Diagram'), { ms: 600 });
      await d.waitFor(button('Fit'), 20000);
    },
  },
  // "Each table is now a DBML file, an open format, next to the code that builds it. Change it, and
  // Git shows exactly what changed."
  files: {
    async run(d, { at, beats }) {
      await at(beats.files.t);
      await d.click(EXPLORER_ICON, { ms: 550 });
      await sleep(250);
      // each folder clicked open only if it is not already (Keep as Diagram reveals its file, which may have opened some)
      for (const [level, label] of [[1, '.erd-studio'], [2, 'main'], [3, 'tables'], [4, SCHEMA]]) {
        const row = wb(`.explorer-folders-view .monaco-list-row[aria-level="${level}"]`, { text: label });
        await d.waitFor(row);
        const open = await d.ev(`[...document.querySelectorAll('.explorer-folders-view .monaco-list-row[aria-level="${level}"]')].find((r) => r.innerText.trim() === ${JSON.stringify(label)})?.getAttribute('aria-expanded') === 'true'`);
        if (!open) { await d.click(row, { ms: level === 1 ? 450 : 350 }); await sleep(250); }
      }
      const fct = explorerRow('fct_order.dbml');
      await d.waitFor(fct);
      await sleep(200);
      await d.click(fct, { ms: 400 });
      await at(beats.files.t + 4.2);   // "…next to the code that builds it"
      await d.moveTo(explorerRow('pipelines'), { ms: 650, hover: false });
      await at(beats.review.t + 0.6);
      await d.moveTo({ x: 900, y: 300 }, { ms: 800, hover: false });
    },
  },
  // "It handles big models too: this one has 2,000 tables and 2,700 relationships. Its lines are routed
  // in the background, in about two seconds. Zoom in, and hover a table: arrows flow along its
  // relationships." One uncut take in the 2,000-table project: the diagram opened from the side bar
  // and fitted, its lines settling as the routing worker finishes (timed: `routing`, saved in
  // record/takes.json), a zoom into one area, then a table hovered so its lines' arrows flow. No drags.
  scale: {
    async run(d, { at, notBefore, beats, note, shot }) {
      await at(beats.big.t + 0.1);
      const t0 = Date.now() + 500;   // the click lands at the end of its glide
      await d.click(sideRow(BIG_DIAGRAM), { ms: 500 });
      // timed from the click: the first tables, and the routed lines replacing the first, straight ones
      const routing = watchRouting(d, t0);
      await d.waitFor(button('Fit'), 20000);
      await sleep(400);
      // the side bar closes (its view's icon), so the canvas gets the window's width; the lines settle on the opened group
      await d.click(ERD_ICON, { ms: 450 });
      await d.moveTo({ x: 900, y: 360 }, { ms: 500, hover: false });
      await d.parkMouse(TAB_BAR);   // the real mouse off the canvas: no table or column tooltip
      await shot('opened');
      const r = await routing;
      note({ routing: r });
      await shot('routed');
      // the whole diagram, 2,000 tables, once the settled lines have been seen for a moment (no
      // fixed beat: how long routing takes is what is being shown)
      await sleep(400);
      await d.click(button('Fit'), { ms: 550 });
      await d.parkMouse(TAB_BAR);   // the real mouse off the canvas: no table or column tooltip
      await sleep(800);
      await shot('fitted');
      // zoom into one area, a wheel step at a time (each takes a while to draw: 2,000 cards), about
      // the table the pointer will hover: on "Zoom in", or as soon as the overview has been seen
      await notBefore(beats.hover.t - 0.2);
      const focus = await cardAt(d, HOVER_TABLE, 0.5, 0.5);
      await d.moveTo({ x: focus.x + 40, y: focus.y + 50 }, { ms: 450, hover: false });
      for (let i = 0; i < ZOOM_STEPS; i++) { await d.wheel({ x: focus.x, y: focus.y }, -ZOOM_DELTA); await sleep(30); }
      await sleep(450);
      await shot('zoomed');
      // the table hovered with the real mouse, on its card's footer (clear of its name's tooltip): its
      // lines' arrows flow (renderer edgeFlow.ts), the rest of the diagram dims
      await d.moveTo(await cardAt(d, HOVER_TABLE, 0.5, 0.96), { ms: 700 });
      await sleep(1200);
      await shot('hover');
    },
  },
  // "Edit it by hand, on the canvas. Add a table, with starter columns if you like, and lay it out.
  // Every edit is saved to its file."
  byHand: {
    async prep(d) {
      await d.click(ERD_ICON, { ms: 1 });
      await canvasInView(d, { click: { x: 760, y: 560 } });
      await d.place({ x: 1000, y: 420 });
      await d.glide({ x: 1000, y: 420 }, 50);
    },
    async run(d, { at, beats }) {
      await at(beats.hand.t + 1.6);
      await d.click(ADD, { ms: 500 });
      await d.click(button('New Table'), { ms: 300 });
      await newTable(d, HAND_TABLE, 'dimension');
      await at(beats.hand.t + 5.0);   // "…and lay it out"
      await d.click(LAYOUT, { ms: 500 });
      await sleep(800);
      await d.click(button('Fit'), { ms: 400 });
      await sleep(250);
      await clearOfMinimap(d);
    },
  },
  // "Or ask your AI assistant. Click Set Up My AI Helper. It adds a skill: plain markdown files that
  // teach your assistant ERD Studio's format." The helper's toast names the assistant it set up.
  aiSetup: {
    async run(d, { at, beats }) {
      await at(beats.or.t + 0.4);
      await d.click(wb('.part.sidebar .pane-header', { re: '^Help' }), { ms: 700 });
      await at(beats.or.t + 1.9);   // "Click Set Up My AI Helper"
      await d.click(sideRow('Set Up My AI Helper'), { ms: 550 });
      const toast = wb('.notifications-toasts .notification-list-item-message', { re: '^AI helper ready' });
      await d.waitFor(toast, 20000);
      await d.moveTo(toast, { ms: 650, dx: 0.5, dy: 0.3 });   // onto its text, clear of its buttons
    },
  },
  // "Ask Claude Code for a change, in plain words. It loads the ERD Studio skill by itself, and a
  // pre-tool hook makes sure it has, before any edit, so what it writes is a diagram you can see,
  // right away." Off camera: the terminal on the right, Claude Code started there and its banner
  // cleared (it names the plan the login is on). On camera: the request typed, the wait sped up
  // (with a badge), the diagram updating as the files land.
  aiRun: {
    async prep(d) {
      await d.click(wb('.notifications-toasts .codicon-notifications-clear'), { ms: 1 }).catch(() => {});
      if (await sideBarVisible(d)) await toggleSideBar(d);
      await canvasInView(d);
      if (!(await panelVisible(d))) await toggleTerminal(d);
      await d.waitFor(TERMINAL);
      await sleep(800);
      // the panel a little narrower than half the window: the diagram keeps the larger side
      const sash = await panelSash(d);
      if (sash) await d.drag(sash, { dx: 900 - sash.x, ms: 300, glideMs: 1 });
      await sleep(500);
      await d.click(TERMINAL, { ms: 1 });
      await d.type('claude', 10);
      await d.enter();
      for (let i = 0; i < 60 && !(await terminalRows(d)).some((r) => /accept edits on/.test(r)); i++) await sleep(250);
      await sleep(1500);
      await clearTerminal(d);
      await sleep(600);
      await d.click(button('Fit'), { ms: 1 });
      await sleep(600);
      await d.click({ x: 120, y: 520 }, { ms: 1 });   // an empty spot on the canvas: nothing selected
      await sleep(300);
      await d.place({ x: 1000, y: 300 });
      await d.glide({ x: 1000, y: 300 }, 50);
    },
    async run(d, { at, beats, ff }) {
      await at(beats.ask.t + 0.3);
      await d.click(TERMINAL, { ms: 500, dx: 0.4, dy: 0.08 });
      await d.type(CLAUDE_REQUEST, 26);
      await sleep(250);
      await d.enter();
      ff.start();
      // done: the footer no longer offers "esc to interrupt", after its reply
      const t0 = Date.now();
      for (;;) {
        await sleep(300);
        const rows = await terminalRows(d);
        const busy = rows.some((r) => /esc to interrupt/.test(r));
        if (!busy && Date.now() - t0 > 4000 && rows.some((r) => /^⏺ /.test(r))) break;
        if (Date.now() - t0 > 180000) throw new Error('Claude Code did not finish within 3 minutes');
      }
      await sleep(800);
      await ff.end();
      await at(beats.live.t + 0.9);
      await d.click(LAYOUT, { ms: 550 });
      await sleep(700);
      await d.click(button('Fit'), { ms: 400 });
      await sleep(200);
      await clearOfMinimap(d);   // the new table in the open, not under the minimap
      await at(beats.live.t + 3.0);   // the new table, on the tidied canvas (held to the scene's end)
      await d.moveTo(wv('.model-node__name', { re: '(^|\\.)dim_customer$' }), { ms: 600, hover: false });
    },
  },
  // "Your data model as a diagram, saved as DBML files in your repo. Edit it by hand, or with your AI
  // assistant, through a built-in skill it uses by itself." Filmed last: the finished diagram beside
  // its files in the Explorer.
  hook: {
    async prep(d) {
      if (await panelVisible(d)) await closePanel(d);
      await sleep(300);
      if (!(await sideBarVisible(d))) await toggleSideBar(d);
      await d.click(EXPLORER_ICON, { ms: 1 });
      await sleep(500);
      await canvasInView(d);
      await d.click({ x: 1300, y: 300 }, { ms: 1 });   // an empty spot on the canvas: nothing selected
      await sleep(400);
      // the drawn pointer waits off the window's right edge (composite clips it), so the hook opens,
      // and ends on its poster frame, with no pointer over the diagram; the real mouse rests on an
      // empty spot of the canvas
      await d.place(OFF_WINDOW);
      await d.parkMouse({ x: 1300, y: 300 });
    },
    async run(d, { at, beats }) {
      await at(beats.model.t + 2.2);   // "…saved as DBML files"
      // the drawn pointer points at the files; the real mouse stays on the canvas, so no Explorer
      // row opens its path tooltip over the diagram
      await d.moveTo(explorerRow('dim_customer.dbml'), { ms: 800, hover: false });
      await sleep(400);
      await d.moveTo(explorerRow('fct_order.dbml'), { ms: 500, hover: false });
      await at(beats.ai.t + 0.4);
      await d.glide(OFF_WINDOW, 1000, { hover: false });
    },
  },
  // "Using dbt? Import from dbt turns your models into a diagram. To check your design against them,
  // click Run dbt parse. It writes manifest.json, a description of every model your project builds.
  // The Physical tab shows what it describes, as a diagram. Compare with dbt marks every difference
  // from your design." The side bar's New… menu, its Import from dbt… item pointed at (not run: this
  // project's diagram exists already), the side bar hidden; then dbt runs for real in its terminal
  // (sped up while it does, if it takes longer than its line), the terminal closed as it finishes,
  // Open Physical view held while its line plays, back to Logical and Compare with dbt.
  dbt: {
    async run(d, { at, beats, ff }) {
      await at(beats.draw.t + 0.9);
      await d.click(NEW_MENU, { ms: 600, synthetic: true });
      const draw = menuItem('^Import from dbt');
      await d.waitFor(draw, 5000);
      await at(beats.draw.t + 1.9);   // "Import from dbt"
      await d.moveTo(draw, { ms: 550, dx: 0.6 });   // past the label's end: the pointer does not cover it
      await at(beats.draw.end + 0.1);
      await d.escape();
      await sleep(150);
      await at(beats.parse.t + 0.1);
      await d.click(ERD_ICON, { ms: 550 });   // the active view's icon: the side bar closes, the canvas takes the width
      await sleep(250);
      await d.click(button('Fit'), { ms: 400 });   // the diagram across that width
      await sleep(200);
      await clearOfMinimap(d);
      await at(beats.parse.t + 2.2);   // "click Run dbt parse"
      await d.click(button('Run dbt parse'), { ms: 600 });
      ff.start();
      const done = wb('.notifications-toasts .notification-list-item-message', { re: '^dbt parse finished' });
      await d.waitFor(done, 120000);
      await sleep(300);
      if (await panelVisible(d)) await closePanel(d, 350);   // the terminal closes as soon as dbt is done
      await ff.end();
      await at(beats.physical.t + 0.1);   // "The Physical tab…"
      await d.click(wb('.notifications-toasts .monaco-button', { text: 'Open Physical view' }), { ms: 450 });
      await sleep(200);
      if (await panelVisible(d)) await closePanel(d, 350);
      await at(beats.compare.t - 0.3);
      await d.click(wv('button', { re: '^Logical' }), { ms: 350 });
      await at(beats.compare.t + 0.4);   // "Compare with dbt"
      await d.click(button('Compare with dbt'), { ms: 550 });
    },
  },
};
