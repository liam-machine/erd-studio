// Someone whose warehouse is in Microsoft Fabric, in a folder of their own
// with nothing in it to bring in yet. The empty Diagrams view leads with
// "Import Your Data Model…"; this story takes the other way in, Import… from
// the Command Palette, whose picker's last item is "Import Your Data Model…"
// (for a model that is not a file yet).
// It opens the import guide, whose Microsoft Fabric card has two parts: a
// semantic model (Git integration) and a Warehouse or SQL analytics endpoint
// (SQL Server Management Studio's Script Table as …, read as SQL Server).
//
// The scripting happens in SSMS, outside VS Code: the story puts
// test/fixtures/sql-ddl/fabric-warehouse/warehouse.sql into the folder only
// once the guide is open (before it, the folder would suggest its SQL
// scripts instead of the blank start this story begins from). The Warehouse
// part's Import SQL Server DDL… reads the picked script as SQL Server without
// asking the dialect (asserted: no dialect pick shows; the name box is kept
// as suggested), and ends in a draft: "Draft from 1 SQL file (SQL Server /
// Azure SQL) · 2 tables, 1 relationship · not saved". Proves the NOT
// ENFORCED keys and foreign key of a Fabric Warehouse come in, and Keep opens
// the diagram with both tables and their relationship.

import fs from 'node:fs';

import { sleep } from '../lib/act.mjs';
import { REPO } from '../lib/launch.mjs';
import { DRAFT, waitForDraft, waitForDraftKeepingName } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const GUIDE_ITEM = 'Import Your Data Model…';
const GUIDE_TAB = 'Import Your Data Model';
const CARD = `doc.querySelector('[data-card="fabric"]')`;
const WAREHOUSE = `[...${CARD}.querySelectorAll('.ig-section')].find(s => s.querySelector('[data-guide-action="fabricWarehouse"]'))`;
const IMPORT = `${CARD}.querySelector('[data-action="run"][data-guide-action="fabricWarehouse"]')`;
const SCRIPTED = 'test/fixtures/sql-ddl/fabric-warehouse/warehouse.sql';

export default story({
  id: 'import-guide-from-picker-fabric',
  title: 'Bring in my Fabric Warehouse from Import…',
  persona: 'As someone whose warehouse is in Microsoft Fabric',
  want: 'I want Import… to show me how to export it',
  soThat: 'so that my warehouse tables become a diagram',
  workspace: { name: 'fabric-reporting', add: { 'README.md': 'test/stories/workspaces/plain/README.md' } },
  // Import…'s path: no automatic example draft over it (story 13 is that path).
  settings: { 'erdStudio.startSuggestions': false },
  steps: async (s) => {
    await s.step('Given my project folder, with nothing to import yet', async () => {
      s.expectNoFile('.erd-studio');
      s.expectNoFile('warehouse.sql');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('fabric-reporting'), { message: 'the fabric-reporting folder did not open' });
    });

    await s.step('When I open the ERD Studio sidebar it leads with Import Your Data Model…; I run Import… from the Command Palette', async () => {
      await s.ui.openSidebar('ERD Studio');
      // The empty project's one button is the guide itself (story 13's path); this story is Import…'s picker.
      await s.expectVisible(s.sel.welcomeLink(GUIDE_ITEM), { what: 'the empty Diagrams view\'s "Import Your Data Model…" button' });
      s.assert.deepEqual(await s.wb.ev(s.sel.welcomeButtons), [GUIDE_ITEM], 'the empty Diagrams view\'s one button');
      await s.ui.runCommand('ERD Studio: Import…');
    }, { say: 'When I open the ERD Studio sidebar it offers to import my data model. I run Import from the Command Palette instead.' });

    await s.step(`Import… ends with "${GUIDE_ITEM}"`, async () => {
      const pick = await s.ui.waitForQuickPick({ title: 'Import' });
      s.assert.equal(pick.items.at(-1), GUIDE_ITEM, `the picker's last item: ${pick.items.join(' | ')}`);
      s.assert.equal(pick.items.length, 4, `three sources, then the guide: ${pick.items.join(' | ')}`);
      await s.wb.highlight(s.sel.quickPickRow(GUIDE_ITEM));
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'Import offers my files, and last: import your data model, from Databricks, Snowflake, Power BI and more.' });

    let guide;
    await s.step('My model is not a file yet, so I pick it: the guide opens', async () => {
      await s.ui.pick(GUIDE_ITEM);
      await s.ui.waitForActiveTab(GUIDE_TAB);
      guide = await s.webview();
      await guide.waitFor(CARD, { what: 'the Microsoft Fabric card' });
      s.assert.equal(await guide.ev(`${CARD}.querySelector('.ig-card__title').textContent.trim()`), 'Microsoft Fabric');
    });

    await s.step('The Microsoft Fabric card: a Warehouse comes in as its CREATE TABLE scripts', async () => {
      await guide.ev(`(${CARD}.scrollIntoView({ block: 'start', behavior: 'smooth' }), true)`);
      await sleep(600);
      const headings = await guide.ev(`[...${CARD}.querySelectorAll('.ig-section__heading')].map(h => h.textContent.trim())`);
      s.assert.deepEqual(headings, ['Semantic model', 'Warehouse or SQL analytics endpoint'], 'the Fabric card\'s two parts');
      s.assert.deepEqual(await guide.ev(`[...${CARD}.querySelectorAll('[data-action="run"]')].map(b => b.textContent.trim())`), ['Import Semantic Model…', 'Import SQL Server DDL…'], 'a button for each part');
      const step = await guide.ev(`${WAREHOUSE}.querySelector('.ig-step').textContent`);
      s.expect(step.includes('Script Table as') && step.includes('ERD Studio reads it as SQL Server'), `the Warehouse step: ${step}`);
      await guide.highlight(WAREHOUSE);
      await s.pause(2200);
      await s.wb.unhighlight();
    }, { say: 'The Fabric card: a Warehouse comes in as its create table scripts.' });

    await s.step('I script my tables in SQL Server Management Studio, and save warehouse.sql here', async () => {
      // The scripting happens in SSMS: here, its file lands in the folder.
      fs.copyFileSync(`${REPO}/${SCRIPTED}`, s.path('warehouse.sql'));
      await s.expectFile('warehouse.sql', { contains: 'CREATE TABLE [dbo].[fct_order]' });
      await s.pause(1000);
    }, { say: 'I script my tables in SQL Server Management Studio, and save the file in my folder.' });

    await s.step('I click "Import SQL Server DDL…" and pick warehouse.sql', async () => {
      await guide.click(IMPORT);
      await s.ui.waitForQuickPick({ title: 'Import SQL DDL' });
      await s.ui.chooseInFileDialog('warehouse.sql', 'Import');
    }, { say: 'I click Import SQL Server DDL, and pick my file.' });

    let draft;
    await s.step('No dialect question: a draft of 2 tables and 1 relationship, read as SQL Server', async () => {
      // The step-by-step flow names the diagram (kept as suggested); no dialect pick may show.
      const { tab } = await waitForDraftKeepingName(s, { never: /dialect/i });
      draft = await waitForDraft(s, tab, { tables: 2 });
      s.expect(/^Draft from 1 SQL file \(SQL Server \/ Azure SQL\) · 2 tables, 1 relationship · not saved$/.test(draft.headline), `the headline: ${draft.headline}`);
      s.expectNoFile('.erd-studio/main/tables');
      await draft.page.highlight(DRAFT.banner);
      await s.pause(2500);
      await s.wb.unhighlight();
    }, { say: 'It does not ask the dialect. A draft: two tables and one relationship, read as SQL Server.' });

    await s.step('When I press "Keep as Diagram", both tables are on the canvas, joined', async () => {
      const diagram = (await s.ui.tabs()).find((t) => t.active).label.slice('Draft: '.length);
      await draft.page.click(DRAFT.button('Keep as Diagram'));
      draft.page.close();
      guide.close();
      await s.ui.waitForActiveTab(`${diagram}.dbml`, { timeout: 45000 });
      const canvas = await s.webview();
      const names = await canvas.waitFor(`(() => { const n=[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText.split('\\n')[0]); return n.length === 2 && n; })()`, { what: 'two tables on the canvas' });
      for (const t of ['dim_customer', 'fct_order']) s.expect(names.some((n) => n.endsWith(t)), `the canvas should show ${t}, but shows ${names.join(', ')}`);
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__edge').length === 1`, { what: 'one relationship line' });
      await s.expectFile('.erd-studio/main/tables/dbo/dim_customer.dbml', { contains: /^Table dbo\.dim_customer\b/m });
      await s.expectFile('.erd-studio/main/tables/dbo/fct_order.dbml', { contains: /^Table dbo\.fct_order\b/m });
      await s.expectFile('.erd-studio/main/relationships/main.dbml', { contains: /^Ref: dbo\.fct_order\.customer_id >\? dbo\.dim_customer\.customer_id$/m });
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2200);
      await s.wb.unhighlight();
      canvas.close();
    }, { say: 'I press Keep as Diagram: both tables, joined, and saved in my project.' });
  },
});
