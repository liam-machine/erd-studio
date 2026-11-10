// A folder holding a single-file DBML export from dbdiagram.io (written from
// its public syntax docs: inline and block refs, a composite ref, a table
// partial, an enum, records, a second schema), opened for the first time.
// ERD Studio's quick look finds the file, and the window's one prompt is the
// start suggestion: "ERD Studio found a DBML file in this folder. Show it as
// a diagram? Nothing is saved until you keep it." Show Me is Draft-first: no
// file dialog, layer pick or name box, a read-only "Draft: ecommerce" (the
// name from the file's Project) of all six tables and six relationships (the
// composite once), and nothing on disk; the banner counts what ERD Studio
// leaves out and the details drawer lists it in plain words. Keep as Diagram
// splits the file into one DBML file per table (by schema), its references
// into one relationships file, saved as optional (?), and opens the diagram.

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const TABLES = ['users', 'countries', 'ecommerce.merchants', 'ecommerce.products', 'orders', 'order_items'];

export default story({
  id: 'dbml-file-import',
  title: 'Import a dbdiagram.io DBML file',
  say: 'Import a DBML file from dbdiagram dot io.', // --narrate's line for the title card
  persona: 'As someone who drew my schema on dbdiagram.io',
  want: 'I want to bring its DBML export into ERD Studio',
  soThat: 'so that the diagram lives in Git next to my code',
  workspace: { name: 'online-shop', add: { 'ecommerce.dbml': 'test/fixtures/dbml/foreign/ecommerce.dbml' } },
  steps: async (s) => {
    await s.step('Given I open my project folder, with ecommerce.dbml from dbdiagram.io', async () => {
      s.expectNoFile('.erd-studio');
      await s.expectFile('ecommerce.dbml', { contains: 'Project ecommerce' });
      await s.eventually(async () => (await s.ui.windowTitle()).includes('online-shop'), { message: 'the online-shop folder did not open' });
    }, { say: 'Given I open my project folder, with an e-commerce DBML file from dbdiagram dot io.' });

    const FOUND = 'ERD Studio found a DBML file in this folder';
    await s.step('ERD Studio finds the file and offers to show it as a diagram', async () => {
      const toast = await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      s.assert.equal(toast.message, `${FOUND}. Show it as a diagram? Nothing is saved until you keep it.`);
      s.assert.deepEqual(toast.buttons, ['Show Me', "Don't Ask Again for This Folder"], 'the suggestion\'s buttons');
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { at: 'left' });

    let draft;
    await s.step('I click "Show Me": no file to pick, no name to type, just the draft', async () => {
      await s.ui.notificationButton(FOUND, 'Show Me');
      draft = await waitForDraft(s, 'Draft: ecommerce', { tables: 6 });
      s.assert.deepEqual([...draft.tables].sort(), [...TABLES].sort(), `the draft should draw ${TABLES.join(', ')}, but draws ${draft.tables.join(', ')}`);
      // Six references, the composite one (two column pairs) drawn as one line.
      await draft.page.waitFor(`${DRAFT.edges} === 6`, { what: 'six relationship lines in the draft' });
      s.assert.equal(draft.headline, 'Draft from ecommerce.dbml · 6 tables, 6 relationships · not saved');
      s.assert.equal(draft.detail, 'Keep saves it as ecommerce in the Main layer (.erd-studio/main/diagrams/ecommerce.dbml).');
      s.expectNoFile('.erd-studio');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: "I click Show Me. There's no file to pick and no name to type: the draft opens, with its six tables.", at: 'left' });

    await s.step('Its details say what ERD Studio leaves out, in plain words', async () => {
      // What is left out (the database type, the sample rows, …): counted in the banner, listed in the drawer.
      s.expect(/left out: Show details$/.test(draft.links), `the banner should count what is left out: ${draft.links}`);
      await draft.page.click(DRAFT.link('Show details'));
      await draft.page.waitFor(DRAFT.drawer, { what: 'the details drawer' });
      const text = await draft.page.ev(`${DRAFT.drawer}.innerText`);
      s.expect(!/plain relationships|\bmeta\b|under "dbml"/.test(text), `the details should use plain words: ${text.slice(0, 600)}`);
      await draft.page.highlight(DRAFT.drawer);
      await s.pause(3000);
      await s.wb.unhighlight();
    }, { say: 'Its details say what ERD Studio leaves out, in plain words.' });

    await s.step('When I press "Keep as Diagram", the diagram opens with all six tables', async () => {
      await draft.page.click(DRAFT.button('Keep as Diagram'));
      draft.page.close();
      await s.ui.waitForActiveTab('ecommerce.dbml', { timeout: 45000 });
      const canvas = await s.webview();
      const names = await canvas.waitFor(`(() => { const n=[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText.split('\\n')[0]); return n.length === 6 && n; })()`, { what: 'six tables on the canvas' });
      s.assert.deepEqual([...names].sort(), [...TABLES].sort(), `the canvas should show ${TABLES.join(', ')}, but shows ${names.join(', ')}`);
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__edge').length === 6`, { what: 'six relationship lines' });
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
      canvas.close();
    });

    await s.step('And each table is its own DBML file, by schema', async () => {
      for (const t of ['users', 'countries', 'orders', 'order_items']) await s.expectFile(`.erd-studio/main/tables/main/${t}.dbml`, { contains: new RegExp(`^Table main\\.${t}\\b`, 'm') });
      for (const t of ['merchants', 'products']) await s.expectFile(`.erd-studio/main/tables/ecommerce/${t}.dbml`, { contains: new RegExp(`^Table ecommerce\\.${t}\\b`, 'm') });
      const rel = await s.expectFile('.erd-studio/main/relationships/main.dbml');
      for (const ref of ['main.orders.user_id >?', 'main.users.country_code >?', 'Ref fk_merchant: ecommerce.products.(merchant_id, country_code) >?']) {
        await s.expectFile(rel, { contains: ref });
      }
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(s.sel.sidebarRow('merchants'), { what: 'merchants in the Table Library' });
      await s.wb.highlight(s.sel.sidebarRow('merchants'));
      await s.pause(2000);
      await s.wb.unhighlight();
    });
  },
});
