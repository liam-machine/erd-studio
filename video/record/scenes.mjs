// What the pointer does in each recorded scene of the default cut, keyed to the narration's beats
// (build/timeline.json, from the real voice clips). record.mjs runs each scene's `prep` off camera,
// then films `run`: `at(s)` waits until s seconds into the scene, so a click lands on the word that
// names it, and the scene is filmed for exactly its timeline duration.
//
// Takes: `plain` is one continuous session in a plain folder (record/fixtures.mjs); its scenes are
// filmed in the order below, which is not the video's: the hook (the finished diagram) is filmed
// after `files` and cut to the front. `dbt` is a second session, in the dbt project.
//
// Every label clicked here is the product's own (the pipeline test reads them back out of
// record/takes.json, the text that was on screen while each scene was filmed).
import { addSalesDbml } from './fixtures.mjs';
import { sleep, wb, wv } from './driver.mjs';

const ERD_ICON = wb('.activitybar [aria-label^="ERD Studio"]');
const EXPLORER_ICON = wb('.activitybar [aria-label^="Explorer"]');
const sideRow = (text, extra = '') => wb(`.part.sidebar .monaco-list-row${extra}`, { text });
const button = (text) => wv('button', { text });
const ADD = wv('button', { re: '^\\+ Add' });
const STARTER = wv('select.new-model-dialog__select');

/** New Table on the canvas: the name, a starter-columns template, Create Table (`fast`: the second one, quicker). */
async function newTable(d, name, template, { fast = false } = {}) {
  await d.click(wv('input[placeholder="table_name"]'), { ms: fast ? 300 : 380 });
  await d.type(name, fast ? 22 : 30);
  await sleep(fast ? 40 : 80);
  await d.pick(STARTER, template, { ms: fast ? 300 : 380 });
  await sleep(fast ? 120 : 220);
  await d.click(button('Create Table'), { ms: fast ? 340 : 420 });
}

/** Picks a New Relationship field by the label above its <select> ("Source Table", "Target Table"). */
async function relPick(d, label, value) {
  const ok = await d.inWebview(`(() => { const l = [...D.querySelectorAll('label')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    const s = l && l.parentElement.querySelector('select'); if (!s) return false; s.setAttribute('data-rec', ${JSON.stringify(label)}); return true; })()`, 'D.querySelector("label")');
  if (!ok?.value) throw new Error(`no ${label} field`);
  await d.pick(wv(`select[data-rec="${label}"]`), value, { ms: 320 });
}

export const TAKES = {
  plain: {
    folder: 'plain',
    /** Before the first scene: the Extensions view, filtered to what is installed (ERD Studio). */
    async prep(d) {
      await d.click(wb('.activitybar [aria-label^="Extensions"]'), { ms: 1 });
      await sleep(800);
      await d.click(wb('.extensions-viewlet .suggest-input-container'), { ms: 1 });
      await d.type('@installed', 10);
      await sleep(400);
      await d.escape();   // close the filter's suggestion list
      await sleep(1200);
      await d.place({ x: 1000, y: 330 });
      await d.glide({ x: 1000, y: 330 }, 50);
    },
    scenes: ['install', 'newDiagram', 'tables', 'files', 'hook', 'importDbml', 'enrich'],
  },
  dbt: {
    folder: 'dbt',
    async prep(d) {
      await d.click(ERD_ICON, { ms: 1 });
      await d.click(sideRow('orders'), { ms: 1 });
      await d.waitFor(button('Compare with dbt'), 20000);
      await sleep(1500);
      // the first-open toast ("This project has 1 ERD Studio diagram") is not part of the tour
      for (const label of ['Not now']) await d.click(wb('.notifications-toasts .monaco-button', { text: label }), { ms: 1 }).catch(() => {});
      await d.click(button('Fit'), { ms: 1 });
      await sleep(800);
      await d.place({ x: 1180, y: 560 });
      await d.glide({ x: 1180, y: 560 }, 50);
    },
    scenes: ['dbt'],
  },
};

export const SCENES = {
  // "Install ERD Studio, open your folder, and click its icon." The installed extension, the
  // folder in the Explorer, then ERD Studio's icon: the side bar's start entry and, on a folder's
  // first visit, the example.
  install: {
    async run(d, { at, beats }) {
      const b = beats.install.t;
      await at(b + 0.1);
      await d.moveTo(wb('.extensions-viewlet .extensions-list .monaco-list-row', { re: '^ERD Studio' }), { ms: 700 });
      await at(b + 1.25);   // "…open your folder"
      await d.click(EXPLORER_ICON, { ms: 600 });
      await at(b + 2.3);    // "…and click its icon"
      await d.click(ERD_ICON, { ms: 550 });
      await d.waitFor(button('Keep This Example'));
    },
  },
  // "Click New Diagram, and give it a name."
  newDiagram: {
    async run(d, { at, beats }) {
      await at(beats.click.t);
      await d.click(wb('.part.sidebar .monaco-button', { text: 'New Diagram…' }), { ms: 600 });
      await d.waitFor(wb('.quick-input-widget input'));
      await at(beats.name.t + 0.2);
      await d.type('orders', 70);
      await sleep(250);
      await d.enter();
      await d.waitFor(button('New Table'));
    },
  },
  // "Add a table, with starter columns if you like. Add another, then link the two with a
  // relationship." The link line is its own cue (beat rel), spoken as New Relationship opens.
  tables: {
    async run(d, { at, beats }) {
      await at(beats.table.t);
      await d.click(button('New Table'), { ms: 480 });
      await newTable(d, 'dim_date', 'dimension');
      await at(beats.more.t);
      await d.click(ADD, { ms: 320 });
      await d.click(button('New Table'), { ms: 260 });
      await newTable(d, 'fct_order', 'fact', { fast: true });
      await at(beats.rel.t - 0.15);   // "…then link the two with a relationship"
      await d.click(ADD, { ms: 320 });
      await d.click(button('New Relationship'), { ms: 260 });
      await d.waitFor(wv('label', { text: 'Source Table' }));
      await relPick(d, 'Source Table', 'fct_order');
      await sleep(60);
      await relPick(d, 'Target Table', 'dim_date');   // both columns fill in: date_key → date_key
      await sleep(180);
      await d.click(button('Create Relationship'), { ms: 340 });
      await sleep(250);
      // the whole diagram in view (the minimap covered the new table's foot)
      await d.click(button('Fit'), { ms: 450 });
    },
  },
  // "Each table is a DBML file, to commit and review like code."
  files: {
    async run(d, { at, beats }) {
      await at(beats.files.t);
      await d.click(EXPLORER_ICON, { ms: 550 });
      await sleep(250);
      await d.click(wb('.explorer-folders-view .monaco-list-row', { text: 'tables' }), { ms: 450 });
      await sleep(450);
      // VS Code opens a folder's only subfolder with it (tables/main); open it by hand only if it did not
      const fct = wb('.explorer-folders-view .monaco-list-row', { text: 'fct_order.dbml' });
      if (!(await d.locate(fct))) await d.click(wb('.explorer-folders-view .monaco-list-row[aria-level="4"]', { text: 'main' }), { ms: 350 });
      await d.waitFor(fct);
      await sleep(200);
      await d.click(wb('.explorer-folders-view .monaco-list-row', { text: 'fct_order.dbml' }), { ms: 400 });
    },
  },
  // "Your data model, as a diagram, saved as DBML files in your repo. No AI needed, and nothing to
  // configure." Filmed after `files`: the diagram beside its files in the Explorer.
  hook: {
    async prep(d) {
      await d.click(wb('.tabs-container .tab[data-resource-name="orders.dbml"]'), { ms: 1 });
      await d.waitFor(button('Fit'));
      await sleep(600);
      // spread the two tables, so the relationship between them reads at a glance, then fit
      await d.drag(wv('.model-node__name', { text: 'fct_order' }), { dx: 130, ms: 400, glideMs: 1 });
      await sleep(500);
      await d.click(button('Fit'), { ms: 1 });
      await sleep(900);
      await d.click({ x: 450, y: 470 }, { ms: 1 });   // an empty spot on the canvas: nothing selected
      await sleep(400);
      await d.place({ x: 1250, y: 520 });
      await d.glide({ x: 1250, y: 520 }, 50);
    },
    async run(d, { at, beats }) {
      await at(beats.model.t + 2.2);   // "…saved as DBML files"
      // the drawn pointer points at the files; the real mouse stays on the canvas, so no Explorer
      // row opens its path tooltip over the diagram
      await d.moveTo(wb('.explorer-folders-view .monaco-list-row', { text: 'dim_date.dbml' }), { ms: 700, hover: false });
      await sleep(500);
      await d.moveTo(wb('.explorer-folders-view .monaco-list-row', { text: 'fct_order.dbml' }), { ms: 400, hover: false });
      await at(beats.noai.t + 0.4);
      await d.glide({ x: 1250, y: 520 }, 900, { hover: false });
    },
  },
  // "Export to DBML or Mermaid any time. Already have DBML? Import it, then keep the draft."
  importDbml: {
    async prep(d) {
      addSalesDbml();
      await d.click(ERD_ICON, { ms: 1 });
      await sleep(900);
    },
    async run(d, { at, beats }) {
      await at(beats.export.t);
      await d.click(sideRow('orders'), { ms: 550, button: 'right' });
      await d.waitFor(wb('.action-label', { text: 'Export Diagram…' }));
      await sleep(150);
      await d.click(wb('.action-label', { text: 'Export Diagram…' }), { ms: 400 });
      await d.waitFor(wb('.quick-input-widget .monaco-list-row'));
      await at(beats.import.t - 0.35);
      await d.escape();
      await d.click(wb('.part.sidebar .pane-header .action-label[aria-label="New…"]'), { ms: 500, synthetic: true });
      await d.waitFor(wb('.action-label', { text: 'Import DBML…' }));
      await sleep(150);
      await d.click(wb('.action-label', { text: 'Import DBML…' }), { ms: 400 });
      await d.waitFor(wb('.quick-input-widget .monaco-button', { text: 'Import' }));
      await sleep(250);
      await d.click(wb('.quick-input-widget .monaco-button', { text: 'Import' }), { ms: 400 });
      await d.waitFor(wb('.quick-input-message', { re: '^Name the diagram' }));
      await sleep(350);
      await d.enter();
      await d.waitFor(button('Keep as Diagram'), 20000);
      await sleep(500);
      await d.click(button('Keep as Diagram'), { ms: 450 });
    },
  },
  // "Want the why behind each table? Click Set Up My AI Helper, then start the guided setup in your
  // assistant." The pointer leaves the row for its toast (which says to start the guided setup), so no
  // tree tooltip opens over the Help rows.
  enrich: {
    async run(d, { at, beats }) {
      await at(beats.want.t + 0.3);
      await d.click(wb('.part.sidebar .pane-header', { re: '^Help' }), { ms: 700 });
      await at(beats.setup.t + 0.25);   // "Click Set Up My AI Helper"
      await d.click(sideRow('Set Up My AI Helper'), { ms: 550 });
      const toast = wb('.notifications-toasts .notification-list-item-message', { re: '^AI helper ready' });
      await d.waitFor(toast, 20000);
      await d.moveTo(toast, { ms: 650, dx: 0.5, dy: 0.3 });   // onto its text, clear of its buttons
    },
  },
  // "Using dbt? Then a Physical tab shows what dbt has. Click Compare with dbt to mark every difference."
  dbt: {
    async run(d, { at, beats }) {
      await at(beats.tabs.t + 1.0);    // "…a Physical tab"
      await d.click(wv('button', { re: '^Physical' }), { ms: 650 });
      await at(beats.compare.t - 0.5);
      await d.click(wv('button', { re: '^Logical' }), { ms: 450 });
      await at(beats.compare.t + 0.35); // "Click Compare with dbt"
      await d.click(button('Compare with dbt'), { ms: 550 });
    },
  },
};
