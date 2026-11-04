// A data engineer whose tables live in Databricks opens a folder of their own
// with nothing ERD Studio can import in it yet (a README). Opening the empty
// Diagrams view is what brings the nothing-found notification ("No data model
// found in this folder yet. …"), never activation alone; it offers New
// Diagram, Show Me How and Don't Ask Again for This Folder. Show Me How opens
// the Bring In Your Data Model tab (its own webview), where the Databricks
// card's Copy puts the notebook cell on the clipboard (asserted: the
// clipboard holds the snippet, and the button says Copied).
//
// The export itself happens in Databricks, outside VS Code: the story puts
// test/fixtures/sql-ddl/databricks-notebook/schema.sql (what the cell prints)
// into the folder only after the notification step. Its CREATE TABLEs would
// make the folder's look find SQL scripts (the start suggestion's "found"
// case, and no nothing-found notification), so it must not be there before;
// step 1 asserts it is not.
//
// The card's Import Databricks DDL… reads the picked script as Databricks
// without asking the dialect (asserted: no dialect pick shows), Import DBML's
// step-by-step flow names the diagram (the name box, kept as suggested), and
// the one confirm says "… from 1 SQL file (Databricks / Spark SQL) …".
// Proves customers and orders and their relationship land on the canvas and
// on disk.
//
// A fresh profile is a first run: ERD Studio activates as its sidebar first
// opens, and its Get Started walkthrough takes the window's one prompt, so
// the nothing-found notification waits for a later window (startSuggestion.ts
// → runNothingFoundPrompt). Step 1 is that first visit: the sidebar, the
// walkthrough (closed), and a reload, as someone coming back to the folder.

import fs from 'node:fs';

import { sleep } from '../lib/act.mjs';
import { REPO } from '../lib/launch.mjs';
import { story } from '../lib/story.mjs';

const NOTHING = 'No data model found in this folder yet.';
const NOTHING_MESSAGE = 'No data model found in this folder yet. Start a new diagram, or bring in your data model from Databricks, Snowflake, Power BI, Fabric and more as DBML, an open format. ERD Studio is free to use.';
const GUIDE_TAB = 'Bring In Your Data Model';
const CARD = `doc.querySelector('[data-card="databricks"]')`;
const COPY = `${CARD}.querySelector('[data-action="copy"][data-snippet="databricksSchema"]')`;
const IMPORT = `${CARD}.querySelector('[data-action="run"][data-guide-action="databricks"]')`;
const EXPORTED = 'test/fixtures/sql-ddl/databricks-notebook/schema.sql';

export default story({
  id: 'nothing-found-import-from-databricks',
  title: 'Bring my Databricks tables into ERD Studio',
  persona: 'As a data engineer whose tables live in Databricks',
  want: 'I want ERD Studio to tell me how to get my model in',
  soThat: 'so that I can see it as a diagram',
  workspace: { name: 'sales-lakehouse', add: { 'README.md': 'test/stories/workspaces/plain/README.md' } },
  steps: async (s) => {
    await s.step('Given my project folder, where I have tried ERD Studio before', async () => {
      s.expectNoFile('.erd-studio');
      s.expectNoFile('schema.sql');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('sales-lakehouse'), { message: 'the sales-lakehouse folder did not open' });
      // The first time, ERD Studio activates as its sidebar opens and its first-run walkthrough
      // takes the window's one prompt. Close it, and come back to the folder another day.
      await s.ui.openSidebar('ERD Studio');
      await s.ui.waitForActiveTab('Welcome');
      await s.wb.click(`${s.sel.tab('Welcome')}.querySelector('.tab-actions .action-label')`);
      await s.wb.waitFor(`!${s.sel.tab('Welcome')}`, { what: 'the walkthrough to close' });
      await s.ui.openSidebar('Explorer');
      await s.ui.reloadWindow();
      await s.eventually(async () => (await s.ui.windowTitle()).includes('sales-lakehouse'), { message: 'the sales-lakehouse folder did not reopen' });
      s.expectNoFile('.erd-studio');
    }, { say: 'Given my project folder, where I have tried ERD Studio before. Nothing in it can be imported yet.' });

    await s.step('When I open the ERD Studio sidebar, it says no data model was found', async () => {
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(s.sel.welcomeLink('New Diagram'), { what: 'the empty Diagrams view (its New Diagram button)' });
      const toast = await s.ui.waitForNotification(NOTHING, { timeout: 30000 });
      s.assert.equal(toast.message, NOTHING_MESSAGE, 'the nothing-found notification');
      s.assert.deepEqual(toast.buttons, ['New Diagram', 'Show Me How', "Don't Ask Again for This Folder"], 'its buttons');
      await s.wb.highlight(s.sel.notification(NOTHING));
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'I open the ERD Studio sidebar. It says no data model was found, and offers to show me how.', at: 'left' });

    let guide;
    await s.step('I click "Show Me How": a guide for each place my model can come from', async () => {
      await s.ui.notificationButton(NOTHING, 'Show Me How');
      await s.ui.waitForActiveTab(GUIDE_TAB);
      guide = await s.webview();
      const heading = await guide.waitFor(`doc.querySelector('.ig__heading')?.textContent.trim()`, { what: 'the guide\'s heading' });
      s.assert.equal(heading, 'Bring in your data model');
      const cards = await guide.ev(`[...doc.querySelectorAll('.ig-card')].map(c => c.dataset.card)`);
      // Nothing found here: no "Found in this folder" card, and no dbt card outside a dbt project.
      s.assert.deepEqual(cards, ['databricks', 'snowflake', 'powerBi', 'fabric', 'sqlServer', 'postgres', 'mysql', 'dbml', 'otherTools', 'notYet'], 'the guide\'s cards');
      await guide.highlight(`doc.querySelector('.ig__cards')`);
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'I click Show Me How: a card for each place my model can come from.' });

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

    let dialog;
    let diagram;
    await s.step('Back in the guide, I click "Import Databricks DDL…" and pick schema.sql', async () => {
      await guide.click(IMPORT);
      await s.ui.waitForQuickPick({ title: 'Import SQL DDL' });
      await s.ui.chooseInFileDialog('schema.sql', 'Import');
    }, { say: 'Back in the guide, I click Import Databricks DDL, and pick my file.' });

    await s.step('No dialect question: one message, 2 tables and 1 relationship, as Databricks', async () => {
      // Import DBML's step-by-step flow names the diagram (kept as suggested); no dialect pick may show.
      ({ dialog } = await s.ui.waitForDialogKeepingName({ never: /dialect/i }));
      const m = /^Import 2 tables and 1 relationship from 1 SQL file \(Databricks \/ Spark SQL\) into a new diagram "([^"]+)" in the Main layer\.$/.exec(dialog.message);
      s.expect(m, `the confirm's headline is "${dialog.message}"`);
      diagram = m[1];
      s.expect(dialog.buttons.includes('Import'), `the confirm's buttons: ${dialog.buttons.join(', ')}`);
      s.expectNoFile('.erd-studio/main/tables');
      await s.wb.highlight(s.sel.dialog);
      await s.pause(2500);
      await s.wb.unhighlight();
    }, { say: 'No dialect question: I chose Databricks. One message: two tables and one relationship.' });

    await s.step('When I press Import, customers and orders are on the canvas, joined', async () => {
      await s.ui.dialogButton('Import');
      guide.close();
      await s.ui.waitForActiveTab(`${diagram}.dbml`);
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
    }, { say: 'I press Import: customers and orders, joined, and saved in my project.' });
  },
});
