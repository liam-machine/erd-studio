// A Power BI project saved as PBIP (the semantic model as TMDL files). ERD
// Studio's quick look at the folder finds the model, so the empty Diagrams
// view leads with "Import your Power BI semantic model" (its one button, with
// the reason "This folder has a Power BI or Fabric semantic model."). That
// button is the quick import: no folder dialog, layer pick or name box
// (asserted: no quick input shows before the confirm); it takes the folder's
// one model, the Main layer and the name adventure-sales (not adventuresales),
// and asks once. Proves the four model tables (Sales, Customer, Product and
// the 'Date Table') become DBML tables in snake_case, the measures,
// calculation group and auto date table are left out (and the confirm says
// so), and the diagram opens with the four tables and the four
// relationships, the inactive one included. The start suggestion (the popup)
// is off here: this story is the sidebar's path (04 and 06 are the popup's).

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

    let dialog;
    await s.step('When I click it, it asks me nothing: it shows what it will import', async () => {
      await s.wb.click(s.sel.welcomeLink(START));
      // No folder dialog, layer or name question: the confirm is the first thing it shows.
      dialog = await s.ui.waitForDialogAskingNothingFirst();
    }, { say: "When I click it, I don't have to answer anything: it finds the model, and picks the layer and the name for me." });

    await s.step('4 tables and 4 relationships into "adventure-sales", and what it leaves out', async () => {
      s.assert.equal(dialog.message, 'Import 4 tables and 4 relationships from the semantic model AdventureSales into a new diagram "adventure-sales" in the Main layer.', 'the confirm\'s headline');
      s.assert.deepEqual([...dialog.buttons].sort(), ['Cancel', 'Change Options…', 'Import', 'Review All…'], 'the confirm\'s buttons (VS Code orders them by platform)');
      s.expect(/3 measures/.test(dialog.detail), `the confirm should say the measures are not imported: ${dialog.detail}`);
      s.expectNoFile('.erd-studio/main/diagrams/adventure-sales.dbml');
      await s.wb.highlight(s.sel.dialog);
      await s.pause(3500);
      await s.wb.unhighlight();
    }, { say: 'Four tables and four relationships, into a new diagram called adventure sales. And it says what it leaves out, like the measures.' });

    await s.step('When I press Import, the diagram opens: Sales, Customer, Product and Date', async () => {
      await s.ui.dialogButton('Import');
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
