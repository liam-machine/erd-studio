// A folder that already holds CREATE TABLE scripts (a pg_dump --schema-only
// split in two files, the foreign keys in the second). ERD Studio's quick look
// at the folder finds them, so the empty Diagrams view leads with "Import your
// SQL scripts" (its one button, with the reason "This folder has CREATE TABLE
// scripts."), which goes straight to the folder dialog (no Import… picker);
// then the dialect (PostgreSQL, marked "detected"), the name (suggested from
// the schema the tables share, "sales", not the folder's name "database"; typed
// "Sales" is taken and saved as sales) and the dry run. Proves
// the scripts become one DBML file per table, the relationships from both
// files land in one relationships file, and the diagram opens with all four
// tables and three relationships drawn.

import { story } from '../lib/story.mjs';

const TABLES = ['dim_customer', 'dim_product', 'dim_date', 'fct_order_line'];

export default story({
  id: 'sql-scripts-import',
  title: 'Import a database from its CREATE TABLE scripts',
  persona: 'As someone whose database schema is a folder of SQL scripts',
  want: 'I want to turn the CREATE TABLE scripts into a diagram',
  soThat: 'so that I can see and design the model without drawing it again',
  workspace: { name: 'shop-database', add: { database: 'test/fixtures/sql-ddl/postgres' } },
  steps: async (s) => {
    await s.step('Given my project folder with SQL scripts in database/', async () => {
      s.expectNoFile('.erd-studio');
      await s.expectFile('database/01_tables.sql', { contains: 'CREATE TABLE sales.fct_order_line' });
      await s.eventually(async () => (await s.ui.windowTitle()).includes('shop-database'), { message: 'the shop-database folder did not open' });
    });

    const START = 'Import your SQL scripts';
    await s.step('When I open the ERD Studio sidebar, it leads with "Import your SQL scripts"', async () => {
      await s.ui.openSidebar('ERD Studio');
      const button = s.sel.welcomeLink(START);
      await s.expectVisible(button, { what: `the "${START}" button in the empty Diagrams view (the folder's suggested start)` });
      s.assert.deepEqual(await s.wb.ev(s.sel.welcomeButtons), [START], 'the suggested start should be the one button in the empty Diagrams view');
      const text = await s.ui.sidebarText();
      s.expect(text.includes('This folder has CREATE TABLE scripts.'), `the view should say why it suggests this: ${text}`);
      await s.wb.highlight(button);
      await s.pause(1500);
      await s.wb.unhighlight();
    });

    await s.step('When I click it, it asks for the scripts\' folder straight away', async () => {
      await s.wb.click(s.sel.welcomeLink(START));
      const dialog = await s.ui.waitForQuickPick({ title: 'Import SQL DDL' });
      s.expect(!dialog.items.includes('SQL DDL scripts'), 'the suggested start should skip the Import… picker');
      s.assert.equal(dialog.value, `${s.workspace}/`, 'the folder dialog should start in my project folder');
      s.expect(dialog.items.includes('database'), `the folder dialog should list database/, but lists ${dialog.items.join(', ')}`);
      await s.pause(600);
      await s.ui.chooseInFileDialog('database/', 'Import');
    });

    await s.step('It asks for the SQL dialect, with PostgreSQL detected', async () => {
      const pick = await s.ui.waitForQuickPick({ title: 'Import SQL DDL' });
      s.expect(/dialect/.test(pick.placeholder), `expected the dialect question, but got "${pick.placeholder}"`);
      s.assert.equal(pick.items[0], 'PostgreSQL', `the detected dialect should come first, but the order is ${pick.items.join(', ')}`);
      const first = await s.wb.ev(`${s.sel.quickPickRow('PostgreSQL')}.getAttribute('aria-label')`);
      s.expect(first.includes('detected'), `PostgreSQL should be marked "detected", but reads "${first}"`);
      await s.wb.highlight(s.sel.quickPickRow('PostgreSQL'));
      await s.pause(1200);
      await s.wb.unhighlight();
      await s.ui.pick('PostgreSQL');
    });

    await s.step('It suggests "sales", the tables\' schema; I type "Sales"', async () => {
      const box = await s.ui.waitForQuickPick({ title: 'Import SQL DDL' });
      s.expect(/Name the diagram/.test(box.message), `expected the name box, but it says "${box.message}"`);
      s.assert.equal(box.value, 'sales', 'the name should be suggested from the schema the tables share, not the database/ folder');
      await s.ui.setQuickInput('Sales');
      // Taken as typed, as New Diagram takes it: no "Use lowercase letters" refusal.
      const typed = await s.eventually(async () => { const q = await s.ui.quickPick(); return q?.message.includes('Saved as sales') && q; }, { message: 'the name box never said "Saved as sales"' });
      s.expect(!/lowercase/i.test(typed.message), `"Sales" should be accepted, but the box says "${typed.message}"`);
      await s.pause(900);
      await s.wb.press('Enter');
    });

    await s.step('It shows what it will import before writing anything', async () => {
      const dialog = await s.ui.waitForDialog();
      s.expect(/^Import 4 tables from 2 SQL files \(PostgreSQL\)/.test(dialog.message), `the dry run's headline is "${dialog.message}"`);
      s.expect(dialog.detail.includes('3 relationships'), `the dry run should name 3 relationships: ${dialog.detail}`);
      s.expectNoFile('.erd-studio/main/diagrams/sales.dbml');
      await s.wb.highlight(s.sel.dialog);
      await s.pause(3000);
      await s.wb.unhighlight();
    });

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
    });
  },
});
