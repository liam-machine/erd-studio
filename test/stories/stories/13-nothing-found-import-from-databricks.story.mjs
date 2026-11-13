// A data engineer whose tables live in Databricks opens a folder of their own
// with nothing ERD Studio can bring in yet (a README), and turns to ERD
// Studio: the ERD Studio icon opens the example draft (Draft-first: nothing
// found, so a finished example, once per machine, written nowhere), whose
// Import Your Data Model… opens the import guide (its own webview). There
// the Databricks card's Copy puts the notebook cell on the clipboard
// (asserted: the clipboard holds the snippet, and the button says Copied).
//
// The export itself happens in Databricks, outside VS Code: the story puts
// test/fixtures/sql-ddl/databricks-notebook/schema.sql (what the cell prints)
// into the folder only once the guide is open. Its CREATE TABLEs would make
// the folder's look find SQL scripts (the start suggestion's "found" case,
// and their own draft instead of the example), so it must not be there
// before; step 1 asserts it is not.
//
// The card's Import Databricks DDL… reads the picked script as Databricks
// without asking the dialect (asserted: no dialect pick shows), the
// step-by-step flow names the diagram (the name box, kept as suggested), and
// it ends in a draft: "Draft from 1 SQL file (Databricks / Spark SQL) · …".
// Keep proves customers and orders and their relationship land on the
// canvas and on disk.

import fs from 'node:fs';

import { sleep } from '../lib/act.mjs';
import { REPO } from '../lib/launch.mjs';
import { DRAFT, waitForDraft, waitForDraftKeepingName } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const GUIDE_TAB = 'Import Your Data Model';
const CARD = `doc.querySelector('[data-card="databricks"]')`;
const COPY = `${CARD}.querySelector('[data-action="copy"][data-snippet="databricksSchema"]')`;
const IMPORT = `${CARD}.querySelector('[data-action="run"][data-guide-action="databricks"]')`;
const EXPORTED = 'test/fixtures/sql-ddl/databricks-notebook/schema.sql';

export default story({
  id: 'nothing-found-import-from-databricks',
  title: 'Bring my Databricks tables into ERD Studio',
  persona: 'As a data engineer whose tables live in Databricks',
  want: 'I want ERD Studio to show me how to get my model in',
  soThat: 'so that I can see it as a diagram',
  workspace: { name: 'sales-lakehouse', add: { 'README.md': 'test/stories/workspaces/plain/README.md' } },
  steps: async (s) => {
    await s.step('Given my project folder, with nothing in it to bring in yet', async () => {
      s.expectNoFile('.erd-studio');
      s.expectNoFile('schema.sql');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('sales-lakehouse'), { message: 'the sales-lakehouse folder did not open' });
    });

    let draft;
    await s.step('When I open ERD Studio, it shows me an example, and how to bring my own in', async () => {
      await s.ui.openSidebar('ERD Studio');
      // Nothing found: the example draft, once per machine, the Diagrams view keeping the focus.
      draft = await waitForDraft(s, 'Example: Coffee shop');
      s.assert.deepEqual(draft.primary, ['New Diagram…'], 'New Diagram… is the example draft\'s primary');
      s.expect(draft.buttons.includes('Import Your Data Model…'), `the draft should offer Import Your Data Model…: ${draft.buttons.join(', ')}`);
      s.expectNoFile('.erd-studio');
      await draft.page.highlight(DRAFT.button('Import Your Data Model…'));
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'When I open ERD Studio, it shows me an example diagram, and offers to bring my own model in. Nothing is saved.' });

    let guide;
    await s.step('I click "Import Your Data Model…": a guide for each place my model can come from', async () => {
      await draft.page.click(DRAFT.button('Import Your Data Model…'));
      draft.page.close();
      await s.ui.waitForActiveTab(GUIDE_TAB);
      guide = await s.webview();
      const heading = await guide.waitFor(`doc.querySelector('.ig__heading')?.textContent.trim()`, { what: 'the guide\'s heading' });
      s.assert.equal(heading, 'Import Your Data Model');
      const cards = await guide.ev(`[...doc.querySelectorAll('.ig-card')].map(c => c.dataset.card)`);
      // Nothing found here: no "Found in this folder" card, and no dbt card outside a dbt project.
      s.assert.deepEqual(cards, ['databricks', 'snowflake', 'powerBi', 'fabric', 'sqlServer', 'postgres', 'mysql', 'dbml', 'otherTools', 'notYet'], 'the guide\'s cards');
      await guide.highlight(`doc.querySelector('.ig__cards')`);
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'I click Import Your Data Model: a card for each place my model can come from.' });

    await s.step('My tables are in Databricks: its card says what to export', async () => {
      await guide.ev(`(${CARD}.scrollIntoView({ block: 'start', behavior: 'smooth' }), true)`);
      await sleep(600);
      s.assert.equal(await guide.ev(`${CARD}.querySelector('.ig-card__title').textContent.trim()`), 'Databricks (Unity Catalog)');
      const what = await guide.ev(`${CARD}.querySelector('.ig-card__what').textContent`);
      s.expect(what.includes('FOREIGN KEY constraints become keys and relationships'), `the card should say what becomes relationships: ${what}`);
      s.assert.equal(await guide.ev(`${IMPORT}.textContent.trim()`), 'Import Databricks DDL…');
      await guide.highlight(CARD);
      await s.pause(2000);
      await s.wb.unhighlight();
    });

    await s.step('I copy the notebook cell that prints a whole schema', async () => {
      await guide.click(COPY);
      await guide.waitFor(`${COPY}.textContent.trim() === 'Copied'`, { what: 'the Copy button to say Copied' });
      const text = await s.eventually(async () => {
        const t = await s.ui.clipboardText();
        return t.startsWith('catalog, schema = "main", "sales"') && t;
      }, { message: 'the clipboard never held the notebook cell' });
      s.expect(text.includes('SHOW CREATE TABLE'), `the copied cell should run SHOW CREATE TABLE: ${text}`);
      await guide.highlight(`${COPY}.closest('.ig-snippet')`);
      await s.pause(1500);
      await s.wb.unhighlight();
    });

    await s.step('I run it in Databricks, and save what it prints as schema.sql in my folder', async () => {
      // The export happens in Databricks: here, its output lands in the folder.
      fs.copyFileSync(`${REPO}/${EXPORTED}`, s.path('schema.sql'));
      await s.expectFile('schema.sql', { contains: 'CREATE TABLE main.sales.orders' });
      await s.pause(1200);
    }, { say: 'I run it in Databricks, and save what it prints as a SQL file in my folder.' });

    await s.step('Back in the guide, I click "Import Databricks DDL…" and pick schema.sql', async () => {
      await guide.click(IMPORT);
      await s.ui.waitForQuickPick({ title: 'Import SQL DDL' });
      await s.ui.chooseInFileDialog('schema.sql', 'Import');
    }, { say: 'Back in the guide, I click Import Databricks DDL, and pick my file.' });

    let draft2;
    await s.step('No dialect question: a draft of 2 tables and 1 relationship, as Databricks', async () => {
      // The step-by-step flow names the diagram (kept as suggested); no dialect pick may show.
      const { tab } = await waitForDraftKeepingName(s, { never: /dialect/i });
      draft2 = await waitForDraft(s, tab, { tables: 2 });
      s.expect(/^Draft from 1 SQL file \(Databricks \/ Spark SQL\) · 2 tables, 1 relationship · not saved$/.test(draft2.headline), `the headline: ${draft2.headline}`);
      s.expectNoFile('.erd-studio/main/tables');
      await draft2.page.highlight(DRAFT.banner);
      await s.pause(2500);
      await s.wb.unhighlight();
    }, { say: 'No dialect question: I chose Databricks. A draft: two tables and one relationship.' });

    await s.step('When I press "Keep as Diagram", customers and orders are on the canvas, joined', async () => {
      const diagram = (await s.ui.tabs()).find((t) => t.active).label.slice('Draft: '.length);
      await draft2.page.click(DRAFT.button('Keep as Diagram'));
      draft2.page.close();
      guide.close();
      await s.ui.waitForActiveTab(`${diagram}.dbml`, { timeout: 45000 });
      const canvas = await s.webview();
      const names = await canvas.waitFor(`(() => { const n=[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText.split('\\n')[0]); return n.length === 2 && n; })()`, { what: 'two tables on the canvas' });
      for (const t of ['customers', 'orders']) s.expect(names.some((n) => n.endsWith(t)), `the canvas should show ${t}, but shows ${names.join(', ')}`);
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__edge').length === 1`, { what: 'one relationship line' });
      // Each table and the relationship are DBML files in the project.
      await s.expectFile('.erd-studio/main/tables/sales/customers.dbml', { contains: /^Table sales\.customers\b/m });
      await s.expectFile('.erd-studio/main/tables/sales/orders.dbml', { contains: /^Table sales\.orders\b/m });
      await s.expectFile('.erd-studio/main/relationships/main.dbml', { contains: /^Ref: sales\.orders\.customer_id >\? sales\.customers\.customer_id$/m });
      await s.expectFile(`.erd-studio/main/diagrams/${diagram}.dbml`, { contains: "use * from '../relationships/main.dbml'" });
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2200);
      await s.wb.unhighlight();
      canvas.close();
    }, { say: 'I press Keep as Diagram: customers and orders, joined, and saved in my project.' });
  },
});
