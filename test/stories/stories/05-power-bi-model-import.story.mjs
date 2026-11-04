// A Power BI project saved as PBIP (the semantic model as TMDL files). ERD
// Studio's quick look at the folder finds the model, so the empty Diagrams
// view leads with "Import your Power BI semantic model" (its one button, with
// the reason "This folder has a Power BI or Fabric semantic model."). That
// button is the quick path, ending in Draft-first's preview: no folder
// dialog, layer pick or name box, a read-only "Draft: adventure-sales" of the
// four model tables (Sales, Customer, Product and the 'Date Table', in
// snake_case) and the four relationships, the inactive one included, and
// nothing on disk. Its details drawer says what is left out (the measures,
// calculation group and auto date table). Keep as Diagram writes the DBML
// files and opens the diagram. The start suggestion (the popup) is off here:
// this story is the sidebar's path (04 and 06 are the popup's).

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const TABLES = ['sales', 'customer', 'product', 'date_table'];

export default story({
  id: 'power-bi-model-import',
  title: 'Import a Power BI semantic model',
  persona: 'As a Power BI developer with my report saved as a PBIP project',
  want: 'I want to see my semantic model as a diagram',
  soThat: 'so that I can design the model behind the report in Git',
  workspace: { name: 'adventure-sales', from: 'test/fixtures/semantic-model/pbip-tmdl' },
  // The sidebar's path: no start-suggestion popup.
  settings: { 'erdStudio.startSuggestions': false },
  steps: async (s) => {
    await s.step('Given my Power BI project folder (AdventureSales.pbip)', async () => {
      s.expectNoFile('.erd-studio');
      await s.expectFile('AdventureSales.pbip');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('adventure-sales'), { message: 'the adventure-sales folder did not open' });
    }, { say: 'Given my Power BI project folder, Adventure Sales.' });

    const START = 'Import your Power BI semantic model';
    await s.step('When I open the ERD Studio sidebar, it leads with "Import your Power BI semantic model"', async () => {
      await s.ui.openSidebar('ERD Studio');
      const button = s.sel.welcomeLink(START);
      await s.expectVisible(button, { what: `the "${START}" button in the empty Diagrams view (the folder's suggested start)` });
      s.assert.deepEqual(await s.wb.ev(s.sel.welcomeButtons), [START], 'the suggested start should be the one button in the empty Diagrams view');
      const text = await s.ui.sidebarText();
      s.expect(text.includes('This folder has a Power BI or Fabric semantic model.'), `the view should say why it suggests this: ${text}`);
      await s.wb.highlight(button);
      await s.pause(1500);
      await s.wb.unhighlight();
    });

    let draft;
    await s.step('When I click it, it asks me nothing: a draft of my model opens', async () => {
      await s.wb.click(s.sel.welcomeLink(START));
      // No folder dialog, layer or name question: the draft is the first thing it shows.
      draft = await waitForDraft(s, 'Draft: adventure-sales', { tables: 4 });
      s.assert.deepEqual([...draft.tables].sort(), [...TABLES].sort(), `the draft should draw ${TABLES.join(', ')}, but draws ${draft.tables.join(', ')}`);
      await draft.page.waitFor(`${DRAFT.edges} === 4`, { what: 'four relationship lines in the draft' });
      s.assert.equal(draft.headline, 'Draft from the semantic model AdventureSales · 4 tables, 4 relationships · not saved');
      s.assert.equal(draft.detail, 'Keep saves it as adventure-sales in the Main layer (.erd-studio/main/diagrams/adventure-sales.dbml).');
      s.assert.deepEqual(draft.primary, ['Keep as Diagram']);
      s.expectNoFile('.erd-studio');
      await draft.page.highlight(DRAFT.banner);
      await s.pause(2500);
      await s.wb.unhighlight();
    }, { say: "When I click it, I don't have to answer anything: a draft of my model opens, with its four tables and four relationships." });

    await s.step('"Show details" says what it leaves out, like the measures', async () => {
      await draft.page.click(DRAFT.link('Show details'));
      await draft.page.waitFor(DRAFT.drawer, { what: 'the details drawer' });
      const text = await draft.page.ev(`${DRAFT.drawer}.innerText`);
      s.expect(/measure/i.test(text), `the details should say the measures are left out: ${text.slice(0, 600)}`);
      await draft.page.highlight(DRAFT.drawer);
      await s.pause(3000);
      await s.wb.unhighlight();
    }, { say: 'Show details says what it leaves out, like the measures, which stay in Power BI.' });

    await s.step('When I press "Keep as Diagram", it opens: Sales, Customer, Product and Date', async () => {
      await draft.page.click(DRAFT.button('Keep as Diagram'));
      draft.page.close();
      await s.ui.waitForActiveTab('adventure-sales.dbml');
      const canvas = await s.webview();
      const names = await canvas.waitFor(`(() => { const n=[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText.split('\\n')[0]); return n.length === 4 && n; })()`, { what: 'four tables on the canvas' });
      s.assert.deepEqual([...names].sort(), [...TABLES].sort(), `the canvas should show ${TABLES.join(', ')}, but shows ${names.join(', ')}`);
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__edge').length === 4`, { what: 'four relationship lines' });
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
      canvas.close();
    });

    await s.step('And each table and the relationships are DBML files in .erd-studio/', async () => {
      for (const t of TABLES) await s.expectFile(`.erd-studio/main/tables/main/${t}.dbml`, { contains: new RegExp(`^Table main\\.${t}\\b`, 'm') });
      const rel = await s.expectFile('.erd-studio/main/relationships/main.dbml');
      for (const ref of [
        'main.sales.customer_key >? main.customer.customer_key',
        'main.sales.product_key >? main.product.product_key',
        'main.sales.order_date_key >? main.date_table.date_key',
        '"inactive in Power BI": main.sales.ship_date_key >? main.date_table.date_key',
      ]) await s.expectFile(rel, { contains: ref });
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(s.sel.sidebarRow('date_table'), { what: 'date_table in the Table Library' });
      await s.wb.highlight(s.sel.sidebarRow('date_table'));
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'And each table, and the relationships, are DBML files in my project.' });
  },
});
