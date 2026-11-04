// A folder that already holds CREATE TABLE scripts (a pg_dump --schema-only
// split in two files, the foreign keys in the second), opened for the first
// time. ERD Studio's quick look finds them, and its one activation prompt is
// the start suggestion: "ERD Studio found CREATE TABLE scripts in this folder
// (4 tables). Show them as a diagram? Nothing is saved until you keep it."
// with Show Me / Don't Ask Again for This Folder. Show Me is Draft-first:
// asked nothing (no file, dialect, layer or name question: asserted), it
// opens a read-only draft of the model ("Draft: sales") whose banner says
// where it came from, what it holds and where Keep saves it, and nothing is
// on disk. Keep as Diagram runs the import's own writer: one DBML file per
// table, the relationships from both files in one relationships file, and the
// diagram opens with all four tables and three relationships drawn.

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const TABLES = ['dim_customer', 'dim_product', 'dim_date', 'fct_order_line'];
const FOUND = 'ERD Studio found CREATE TABLE scripts in this folder';

export default story({
  id: 'sql-scripts-import',
  title: 'Import a database from its CREATE TABLE scripts',
  persona: 'As someone whose database schema is a folder of SQL scripts',
  want: 'I want to see the CREATE TABLE scripts as a diagram before anything is saved',
  soThat: 'so that I can design the model without drawing it again',
  workspace: { name: 'shop-database', add: { database: 'test/fixtures/sql-ddl/postgres' } },
  steps: async (s) => {
    await s.step('Given I open my project folder, with SQL scripts in database/', async () => {
      s.expectNoFile('.erd-studio');
      await s.expectFile('database/01_tables.sql', { contains: 'CREATE TABLE sales.fct_order_line' });
      await s.eventually(async () => (await s.ui.windowTitle()).includes('shop-database'), { message: 'the shop-database folder did not open' });
    }, { say: 'Given I open my project folder, with SQL scripts in a database folder.' });

    await s.step('ERD Studio finds the scripts and offers to show them as a diagram', async () => {
      const toast = await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      s.assert.equal(toast.message, `${FOUND} (4 tables). Show them as a diagram? Nothing is saved until you keep it.`);
      s.assert.deepEqual(toast.buttons, ['Show Me', "Don't Ask Again for This Folder"], 'the suggestion\'s buttons');
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { at: 'left' });

    let draft;
    await s.step('I click "Show Me": a draft of my model, with nothing to answer first', async () => {
      await s.ui.notificationButton(FOUND, 'Show Me');
      draft = await waitForDraft(s, 'Draft: sales', { tables: 4 });
      for (const t of TABLES) s.expect(draft.tables.some((n) => n.endsWith(t)), `the draft should draw ${t}, but draws ${draft.tables.join(', ')}`);
      await draft.page.waitFor(`${DRAFT.edges} === 3`, { what: 'three relationship lines in the draft' });
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { say: "I click Show Me. I don't have to answer anything: a draft of my model opens straight away.", at: 'left' });

    await s.step('It says what it read and where Keep will save it; nothing is saved yet', async () => {
      s.assert.equal(draft.headline, 'Draft from 2 SQL files (PostgreSQL) · 4 tables, 3 relationships · not saved');
      s.assert.equal(draft.detail, 'Keep saves it as sales in the Main layer (.erd-studio/main/diagrams/sales.dbml).');
      s.assert.deepEqual(draft.primary, ['Keep as Diagram'], 'Keep as Diagram is the one primary button');
      s.expect(draft.buttons.includes('Discard') && draft.buttons.includes('More ways to start'), `the draft's buttons: ${draft.buttons.join(', ')}`);
      s.expectNoFile('.erd-studio');
      await draft.page.highlight(DRAFT.banner);
      await s.pause(3000);
      await s.wb.unhighlight();
    }, { say: 'It says what it read: two SQL files, as PostgreSQL. And where Keep will save it. Nothing is saved yet.' });

    await s.step('When I press "Keep as Diagram", the diagram opens with the four tables', async () => {
      await draft.page.click(DRAFT.button('Keep as Diagram'));
      draft.page.close();
      await s.ui.waitForActiveTab('sales.dbml', { timeout: 45000 });
      const canvas = await s.webview();
      const names = await canvas.waitFor(`(() => { const n=[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText.split('\\n')[0]); return n.length === 4 && n; })()`, { what: 'four tables on the canvas' });
      for (const t of TABLES) s.expect(names.some((n) => n.endsWith(t)), `the canvas should show ${t}, but shows ${names.join(', ')}`);
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__edge').length === 3`, { what: 'three relationship lines' });
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2000);
      await s.wb.unhighlight();
      canvas.close();
    }, { say: 'When I press Keep as Diagram, the diagram opens with the four tables.' });

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
