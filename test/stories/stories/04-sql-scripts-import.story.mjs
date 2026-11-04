// A folder that already holds CREATE TABLE scripts (a pg_dump --schema-only
// split in two files, the foreign keys in the second), opened for the first
// time. ERD Studio's quick look at the folder finds them, and its one
// activation prompt is the start suggestion: "ERD Studio found CREATE TABLE
// scripts in this folder (4 tables). Create a diagram from them?" with Create
// Diagram / More Options… / Don't Ask Again for This Folder. Create Diagram
// is the quick import: no folder dialog, no dialect pick, no layer pick, no
// name box (asserted: no quick input shows before the confirm). It took every
// script, read them as PostgreSQL, put the diagram in the Main layer and
// named it after the tables' schema ("sales"), and asks once: Import, Review
// All…, Change Options…, Cancel. Proves the scripts become one DBML file per
// table, the relationships from both files land in one relationships file,
// and the diagram opens with all four tables and three relationships drawn.

import { story } from '../lib/story.mjs';

const TABLES = ['dim_customer', 'dim_product', 'dim_date', 'fct_order_line'];
const FOUND = 'ERD Studio found CREATE TABLE scripts in this folder';

export default story({
  id: 'sql-scripts-import',
  title: 'Import a database from its CREATE TABLE scripts',
  persona: 'As someone whose database schema is a folder of SQL scripts',
  want: 'I want to turn the CREATE TABLE scripts into a diagram',
  soThat: 'so that I can see and design the model without drawing it again',
  workspace: { name: 'shop-database', add: { database: 'test/fixtures/sql-ddl/postgres' } },
  steps: async (s) => {
    await s.step('Given I open my project folder, with SQL scripts in database/', async () => {
      s.expectNoFile('.erd-studio');
      await s.expectFile('database/01_tables.sql', { contains: 'CREATE TABLE sales.fct_order_line' });
      await s.eventually(async () => (await s.ui.windowTitle()).includes('shop-database'), { message: 'the shop-database folder did not open' });
    }, { say: 'Given I open my project folder, with SQL scripts in a database folder.' });

    await s.step('ERD Studio finds the scripts and offers to create a diagram', async () => {
      const toast = await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      s.assert.equal(toast.message, `${FOUND} (4 tables). Create a diagram from them?`);
      s.assert.deepEqual(toast.buttons, ['Create Diagram', 'More Options…', "Don't Ask Again for This Folder"], 'the suggestion\'s buttons');
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { at: 'left' });

    let dialog;
    await s.step('I click "Create Diagram": it asks me nothing, it just shows what it will do', async () => {
      await s.ui.notificationButton(FOUND, 'Create Diagram');
      // No folder dialog, dialect, layer or name question: the confirm is the first thing it shows.
      dialog = await s.ui.waitForDialogAskingNothingFirst();
    }, { say: "I click Create Diagram. I don't have to answer anything: it picks the scripts, the dialect, the layer and the name for me.", at: 'left' });

    await s.step('One short message: 4 tables and 3 relationships, PostgreSQL, a new diagram "sales"', async () => {
      s.assert.equal(dialog.message, 'Import 4 tables and 3 relationships from 2 SQL files (PostgreSQL) into a new diagram "sales" in the Main layer.', 'the confirm\'s headline');
      s.assert.deepEqual([...dialog.buttons].sort(), ['Cancel', 'Change Options…', 'Import', 'Review All…'], 'the confirm\'s buttons (VS Code orders them by platform)');
      s.expectNoFile('.erd-studio/main/diagrams/sales.dbml');
      await s.wb.highlight(s.sel.dialog);
      await s.pause(3000);
      await s.wb.unhighlight();
    }, { say: 'One short message: four tables and three relationships, read as PostgreSQL, into a new diagram called sales.' });

    await s.step('When I press Import, the diagram opens with the four tables', async () => {
      await s.ui.dialogButton('Import');
      await s.ui.waitForActiveTab('sales.dbml');
      const canvas = await s.webview();
      const names = await canvas.waitFor(`(() => { const n=[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText.split('\\n')[0]); return n.length === 4 && n; })()`, { what: 'four tables on the canvas' });
      for (const t of TABLES) s.expect(names.some((n) => n.endsWith(t)), `the canvas should show ${t}, but shows ${names.join(', ')}`);
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__edge').length === 3`, { what: 'three relationship lines' });
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2000);
      await s.wb.unhighlight();
      canvas.close();
    });

    await s.step('And each table and the relationships are DBML files in .erd-studio/', async () => {
      for (const t of TABLES) await s.expectFile(`.erd-studio/main/tables/sales/${t}.dbml`, { contains: new RegExp(`^Table sales\\.${t}\\b`, 'm') });
      // Both scripts' foreign keys, the repeated customer_id one once.
      const rel = await s.expectFile('.erd-studio/main/relationships/main.dbml');
      for (const ref of ['sales.fct_order_line.customer_id', 'sales.fct_order_line.product_id', 'sales.fct_order_line.order_date_key']) {
        await s.expectFile(rel, { contains: `Ref: ${ref}` });
      }
      await s.expectFile('.erd-studio/main/diagrams/sales.dbml', { contains: "use * from '../relationships/main.dbml'" });
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(s.sel.sidebarRow('fct_order_line'), { what: 'fct_order_line in the Table Library' });
      await s.wb.highlight(s.sel.sidebarRow('fct_order_line'));
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'And each table, and the relationships, are DBML files in my project.' });
  },
});
