// A folder holding a single-file DBML export from dbdiagram.io (written from
// its public syntax docs: inline and block refs, a composite ref, a table
// partial, an enum, records, a second schema), opened for the first time.
// ERD Studio's quick look finds the file, and the window's one prompt is the
// start suggestion: "ERD Studio found a DBML file in this folder. Create a
// diagram from it?". Create Diagram is the quick import: no file dialog,
// layer pick or name box (asserted: no quick input shows before the
// confirm); the file, the Main layer and the name from its Project
// ("ecommerce") are chosen, and it asks once. Proves the file is split into
// one DBML file per table (by schema), its references land in one
// relationships file, the confirm counts six relationships as the canvas
// does (the composite once), says they are saved as optional (?) as the file
// then shows, says what ERD Studio leaves out (the first thing and a count)
// in plain words, and the diagram opens with all six tables.

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
    await s.step('ERD Studio finds the file and offers to create a diagram from it', async () => {
      const toast = await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      s.assert.equal(toast.message, `${FOUND}. Create a diagram from it?`);
      s.assert.deepEqual(toast.buttons, ['Create Diagram', 'More Options…', "Don't Ask Again for This Folder"], 'the suggestion\'s buttons');
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { at: 'left' });

    let dialog;
    await s.step('I click "Create Diagram": no file to pick, no name to type', async () => {
      await s.ui.notificationButton(FOUND, 'Create Diagram');
      // No file dialog, layer or name question: the confirm is the first thing it shows.
      dialog = await s.ui.waitForDialogAskingNothingFirst();
    }, { say: "I click Create Diagram. There's no file to pick and no name to type: it asks me nothing.", at: 'left' });

    await s.step('It shows what it will import, and what it leaves out', async () => {
      s.assert.equal(dialog.message, 'Import 6 tables and 6 relationships into a new diagram "ecommerce" in the Main layer.', 'the confirm\'s headline');
      s.assert.deepEqual([...dialog.buttons].sort(), ['Cancel', 'Change Options…', 'Import', 'Review All…'], 'the confirm\'s buttons (VS Code orders them by platform)');
      // What is left out, the first thing and a count (the database type, the sample rows, …); Review All… lists them all.
      s.expect(/^• Not imported: .+; and \d+ more\.$/m.test(dialog.detail), `the confirm should say what is left out: ${dialog.detail}`);
      s.expect(dialog.detail.includes('saved as optional (?'), `the confirm should say the relationships are saved as optional: ${dialog.detail}`);
      s.expect(!/plain relationships|\bmeta\b|under "dbml"/.test(dialog.detail), `the confirm should use plain words: ${dialog.detail}`);
      s.expectNoFile('.erd-studio/main/diagrams/ecommerce.dbml');
      await s.wb.highlight(s.sel.dialog);
      await s.pause(3500);
      await s.wb.unhighlight();
    }, { say: 'It shows what it will import, six tables and six relationships, and what it leaves out.' });

    await s.step('When I press Import, the diagram opens with all six tables', async () => {
      await s.ui.dialogButton('Import');
      await s.ui.waitForActiveTab('ecommerce.dbml');
      const canvas = await s.webview();
      const names = await canvas.waitFor(`(() => { const n=[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText.split('\\n')[0]); return n.length === 6 && n; })()`, { what: 'six tables on the canvas' });
      s.assert.deepEqual([...names].sort(), [...TABLES].sort(), `the canvas should show ${TABLES.join(', ')}, but shows ${names.join(', ')}`);
      // Six references, the composite one (two column pairs) drawn as one line.
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
