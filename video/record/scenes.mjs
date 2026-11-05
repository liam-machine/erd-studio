// What the pointer does in each recorded scene of the default cut, keyed to the narration's beats
// (build/timeline.json, from the real voice clips). record.mjs runs each scene's `prep` off camera,
// then films `run`: `at(s)` waits until s seconds into the scene, so a click lands on the word that
// names it, and the scene is filmed for exactly its timeline duration (a scene with a fast-forward:
// for as long as its wait takes, then sped up to fit; `ff.start()` / `ff.end()` mark the wait).
//
// Takes: `plain` is one continuous session in the project folder (record/fixtures.mjs); its scenes
// are filmed in the order below, which is not the video's: the hook (the finished diagram) is filmed
// last and cut to the front. `dbt` is a second session, in the dbt project that holds the files the
// plain take wrote.
//
// Every label clicked here is the product's own (the pipeline test reads them back out of
// record/takes.json, the text that was on screen while each scene was filmed).
import { sleep, wb, wv } from './driver.mjs';

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
/** The Diagrams view's New… menu (its title bar's +) and its Draw from dbt… item. */
const NEW_MENU = wb('.part.sidebar .pane-header .action-label[aria-label^="New…"]');
const menuItem = (re) => wb('.monaco-menu .action-label', { re });

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
const sideBarVisible = (d) => d.ev("!!document.querySelector('.part.sidebar') && document.querySelector('.part.sidebar').getBoundingClientRect().width > 10");
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

/** The diagram's canvas tab in front, the whole diagram in view and clear of the minimap, nothing selected. */
async function canvasInView(d, { click = { x: 0, y: 0 } } = {}) {
  await d.click(wb('.tabs-container .tab[data-resource-name="sales.dbml"]'), { ms: 1 });
  await d.waitFor(button('Fit'));
  await sleep(500);
  await d.click(button('Fit'), { ms: 1 });
  await sleep(700);
  await clearOfMinimap(d);
  await sleep(200);
  if (click.x) await d.click(click, { ms: 1 });
}

export const TAKES = {
  plain: {
    folder: 'plain',
    /** Before the first scene: the folder in the Explorer, and its exported DDL open beside it. */
    async prep(d) {
      await d.click(explorerRow('sales.sql'), { ms: 1 });
      await sleep(1200);
      await d.click({ x: 900, y: 420 }, { ms: 1 });   // the editor: no Explorer row stays focused
      await d.place({ x: 980, y: 330 });
      await d.glide({ x: 980, y: 330 }, 50);
    },
    scenes: ['bring', 'importSql', 'draft', 'files', 'byHand', 'aiSetup', 'aiRun', 'hook'],
  },
  dbt: {
    folder: 'dbt',
    async prep(d) {
      await d.click(ERD_ICON, { ms: 1 });
      await d.click(sideRow('sales'), { ms: 1 });
      await d.waitFor(button('Run dbt parse'), 20000);
      await sleep(1500);
      // a first-open toast ("This project has 1 ERD Studio diagram", which can take a few seconds) is not part of the tour
      const notNow = wb('.notifications-toasts .monaco-button', { text: 'Not now' });
      await d.waitFor(notNow, 8000).then(() => d.click(notNow, { ms: 1 })).catch(() => {});
      // the side bar stays open (its New… menu is where Draw from dbt is); the scene hides it before
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
  // "Most teams already have one, in Snowflake, Databricks, dbt, Power BI or SQL. Open your project,
  // and click Import." The exported DDL in the editor, then ERD Studio's start entry, More ways to
  // start…, and Import…, whose picker the next scene walks through.
  bring: {
    async run(d, { at, beats }) {
      await at(beats.have.t + 1.2);
      // the drawn pointer runs down the DDL's CREATE TABLE lines (the real mouse stays put: no hover)
      await d.moveTo({ x: 640, y: 150 }, { ms: 900, hover: false });
      await d.moveTo({ x: 640, y: 330 }, { ms: 1400, hover: false });
      await at(beats.have.t + 4.6);
      await d.click(ERD_ICON, { ms: 600 });
      await d.waitFor(wb('.part.sidebar a', { text: 'More ways to start…' }));
      await at(beats.open.t + 0.5);
      await d.click(wb('.part.sidebar a', { text: 'More ways to start…' }), { ms: 550 });
      await d.waitFor(pickRow('^.?Import…'));
      await at(beats.open.t + 1.7);   // "…click Import"
      await d.click(pickRow('^.?Import…'), { ms: 450 });
      // the real mouse off the picker: resting on a row opens its tooltip over the next one
      await d.parkMouse({ x: 1300, y: 560 });
      await d.waitFor(pickRow('SQL DDL scripts'));
    },
  },
  // "Import reads DBML, SQL scripts, or a Power BI or Fabric model. From Snowflake or Databricks,
  // import the exported DDL. It works out the dialect." The picker's rows, then SQL DDL scripts, the
  // file, and the dialect it detected.
  importSql: {
    async run(d, { at, beats }) {
      const row = async (re, ms) => { const p = await d.locate(pickRow(re), { dx: 0.3 }); await d.moveTo({ x: p.x, y: p.y }, { ms, hover: false }); };
      await at(beats.sources.t + 0.9);   // "DBML"
      await row('^.?DBML file', 600);
      await at(beats.sources.t + 1.6);   // "SQL scripts"
      await row('SQL DDL scripts', 450);
      await at(beats.sources.t + 2.7);   // "Power BI or Fabric"
      await row('Power BI or Fabric', 500);
      await at(beats.ddl.t + 0.2);
      await d.click(pickRow('SQL DDL scripts'), { ms: 550 });
      await d.parkMouse({ x: 1300, y: 560 });
      await d.waitFor(pickRow('^.?sales\\.sql$'));
      await at(beats.ddl.t + 1.6);   // "…import the exported DDL"
      await d.click(pickRow('^.?sales\\.sql$'), { ms: 500 });
      await d.parkMouse({ x: 1300, y: 560 });
      await d.waitFor(pickRow('^Snowflake'));
      await at(beats.ddl.t + 3.6);   // "It works out the dialect"
      await d.click(pickRow('^Snowflake'), { ms: 600 });
      await d.waitFor(wb('.quick-input-message', { re: '^Name the diagram' }));
    },
  },
  // "You get a draft of every table and relationship. Keep it, and it's your diagram."
  draft: {
    async run(d, { at, beats }) {
      await at(beats.draft.t);
      await d.enter();   // the name box: "sales", from the file's name
      await d.waitFor(button('Keep as Diagram'), 20000);
      await at(beats.keep.t + 0.3);
      await d.click(button('Keep as Diagram'), { ms: 600 });
      await d.waitFor(button('Fit'), 20000);
    },
  },
  // "Each table is now a DBML file, an open format, next to the code that builds it. Review a change
  // to the model in the same pull request."
  files: {
    async run(d, { at, beats }) {
      await at(beats.files.t);
      await d.click(EXPLORER_ICON, { ms: 550 });
      await sleep(250);
      // each folder clicked open only if it is not already (Keep as Diagram reveals its file, which may have opened some)
      for (const [level, label] of [[1, '.erd-studio'], [2, 'main'], [3, 'tables'], [4, 'main']]) {
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
      await d.moveTo(wv('.model-node__name', { text: 'dim_customer' }), { ms: 600, hover: false });
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
  // "Using dbt? Draw from dbt turns your models into a diagram. To check your design against them,
  // click Run dbt parse. It writes manifest.json, a description of every model your project builds.
  // The Physical tab shows what it describes, as a diagram. Compare with dbt marks every difference
  // from your design." The side bar's New… menu, its Draw from dbt… item pointed at (not run: this
  // project's diagram exists already), the side bar hidden; then dbt runs for real in its terminal
  // (sped up while it does, if it takes longer than its line), the terminal closed as it finishes,
  // Open Physical view held while its line plays, back to Logical and Compare with dbt.
  dbt: {
    async run(d, { at, beats, ff }) {
      await at(beats.draw.t + 0.9);
      await d.click(NEW_MENU, { ms: 600, synthetic: true });
      const draw = menuItem('^Draw from dbt');
      await d.waitFor(draw, 5000);
      await at(beats.draw.t + 1.9);   // "Draw from dbt"
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
