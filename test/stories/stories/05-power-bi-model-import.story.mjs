// A Power BI project saved as PBIP (the semantic model as TMDL files). ERD
// Studio's quick look at the folder finds the model, so the empty Diagrams
// view leads with "Import your Power BI semantic model" (its one button, with
// the reason "This folder has a Power BI or Fabric semantic model."), which
// goes straight to the folder dialog; it starts in the project, which holds
// AdventureSales.SemanticModel, so one press of Import reads it, and the name
// is suggested as adventure-sales (not adventuresales). Proves the four model tables (Sales,
// Customer, Product and the 'Date Table') become DBML tables in snake_case,
// the measures, calculation group and auto date table are left out (and the
// dry run says so), and the diagram opens with the four tables and the four
// relationships, the inactive one included.

import { story } from '../lib/story.mjs';

const TABLES = ['sales', 'customer', 'product', 'date_table'];

export default story({
  id: 'power-bi-model-import',
  title: 'Import a Power BI semantic model',
  persona: 'As a Power BI developer with my report saved as a PBIP project',
  want: 'I want to see my semantic model as a diagram',
  soThat: 'so that I can design the model behind the report in Git',
  workspace: { name: 'adventure-sales', from: 'test/fixtures/semantic-model/pbip-tmdl' },
  steps: async (s) => {
    await s.step('Given my Power BI project folder (AdventureSales.pbip)', async () => {
      s.expectNoFile('.erd-studio');
      await s.expectFile('AdventureSales.pbip');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('adventure-sales'), { message: 'the adventure-sales folder did not open' });
    });

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

    await s.step('When I click it, I import straight from my project folder', async () => {
      await s.wb.click(s.sel.welcomeLink(START));
      const dialog = await s.ui.waitForQuickPick({ title: 'Import Semantic Model' });
      s.assert.equal(dialog.value, `${s.workspace}/`, 'the folder dialog should start in my project folder');
      s.expect(dialog.items.includes('AdventureSales.SemanticModel'), `the folder should list AdventureSales.SemanticModel: ${dialog.items.join(', ')}`);
      await s.wb.highlight(s.sel.quickPickRow('AdventureSales.SemanticModel'));
      await s.pause(1200);
      await s.wb.unhighlight();
      await s.ui.quickInputButton('Import');
    });

    await s.step('I keep the suggested name, "adventure-sales"', async () => {
      const box = await s.ui.waitForQuickPick({ title: 'Import Semantic Model' });
      s.expect(/Name the diagram/.test(box.message), `expected the name box, but it says "${box.message}"`);
      s.assert.equal(box.value, 'adventure-sales', 'the model AdventureSales should suggest adventure-sales');
      await s.wb.highlight(s.sel.quickInputBox);
      await s.pause(1000);
      await s.wb.unhighlight();
      await s.wb.press('Enter');
    });

    await s.step('It shows what it will import, and what it leaves out', async () => {
      const dialog = await s.ui.waitForDialog();
      s.expect(/^Import 4 tables from the semantic model AdventureSales/.test(dialog.message), `the dry run's headline is "${dialog.message}"`);
      s.expect(dialog.detail.includes('4 relationships'), `the dry run should name 4 relationships: ${dialog.detail}`);
      s.expect(/3 measures/.test(dialog.detail), `the dry run should say the measures are not imported: ${dialog.detail}`);
      s.expectNoFile('.erd-studio/main/diagrams/adventure-sales.dbml');
      await s.wb.highlight(s.sel.dialog);
      await s.pause(3500);
      await s.wb.unhighlight();
    });

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
    });
  },
});
