// A folder holding a single-file DBML export from dbdiagram.io (written from
// its public syntax docs: inline and block refs, a composite ref, a table
// partial, an enum, records, a second schema). ERD Studio's quick look finds
// the file, so the empty Diagrams view leads with "Import your DBML file" (its
// one button, with the reason "This folder has a DBML file."), which goes
// straight to the file dialog with that file already chosen, so Import takes
// it in one press. Proves the file is
// split into one DBML file per table (by schema), its references land in one
// relationships file, the dry run counts six relationships as the canvas does
// (the composite once), says they are saved as optional (?) as the file then
// shows, names what ERD Studio leaves out (records, the database type) in
// plain words, and the diagram opens with all six tables.

import { story } from '../lib/story.mjs';

const TABLES = ['users', 'countries', 'ecommerce.merchants', 'ecommerce.products', 'orders', 'order_items'];

export default story({
  id: 'dbml-file-import',
  title: 'Import a dbdiagram.io DBML file',
  persona: 'As someone who drew my schema on dbdiagram.io',
  want: 'I want to bring its DBML export into ERD Studio',
  soThat: 'so that the diagram lives in Git next to my code',
  workspace: { name: 'online-shop', add: { 'ecommerce.dbml': 'test/fixtures/dbml/foreign/ecommerce.dbml' } },
  steps: async (s) => {
    await s.step('Given my project folder with ecommerce.dbml from dbdiagram.io', async () => {
      s.expectNoFile('.erd-studio');
      await s.expectFile('ecommerce.dbml', { contains: 'Project ecommerce' });
      await s.eventually(async () => (await s.ui.windowTitle()).includes('online-shop'), { message: 'the online-shop folder did not open' });
    });

    const START = 'Import your DBML file';
    await s.step('When I open the ERD Studio sidebar, it leads with "Import your DBML file"', async () => {
      await s.ui.openSidebar('ERD Studio');
      const button = s.sel.welcomeLink(START);
      await s.expectVisible(button, { what: `the "${START}" button in the empty Diagrams view (the folder's suggested start)` });
      s.assert.deepEqual(await s.wb.ev(s.sel.welcomeButtons), [START], 'the suggested start should be the one button in the empty Diagrams view');
      const text = await s.ui.sidebarText();
      s.expect(text.includes('This folder has a DBML file.'), `the view should say why it suggests this: ${text}`);
      await s.wb.highlight(button);
      await s.pause(1500);
      await s.wb.unhighlight();
    });

    await s.step('When I click it, ecommerce.dbml is already chosen: I press Import', async () => {
      await s.wb.click(s.sel.welcomeLink(START));
      const dialog = await s.ui.waitForQuickPick({ title: 'Import DBML' });
      s.assert.equal(dialog.value, `${s.workspace}/ecommerce.dbml`, 'the file dialog should start on the DBML file the folder holds');
      await s.wb.highlight(s.sel.quickInputBox);
      await s.pause(1200);
      await s.wb.unhighlight();
      await s.ui.chooseInFileDialog(undefined, 'Import');
    });

    await s.step('I keep the suggested name, "ecommerce"', async () => {
      const box = await s.ui.waitForQuickPick({ title: 'Import DBML' });
      s.expect(/Name the diagram/.test(box.message), `expected the name box, but it says "${box.message}"`);
      s.assert.equal(box.value, 'ecommerce', "the name should be suggested from the file's Project");
      await s.wb.highlight(s.sel.quickInputBox);
      await s.pause(1000);
      await s.wb.unhighlight();
      await s.wb.press('Enter');
    });

    await s.step('It shows what it will import, and what it leaves out', async () => {
      const dialog = await s.ui.waitForDialog();
      s.expect(/^Import 6 tables into a new diagram "ecommerce"/.test(dialog.message), `the dry run's headline is "${dialog.message}"`);
      s.expect(/Records for countries/.test(dialog.detail), `the dry run should say the sample rows are left out: ${dialog.detail}`);
      // As the canvas counts them (the composite fk_merchant once), and as the files will say (>?).
      s.expect(/• 6 relationships\b/.test(dialog.detail), `the dry run should count 6 relationships, as the canvas does: ${dialog.detail}`);
      s.expect(dialog.detail.includes('Every relationship is saved as optional (?'), `the dry run should say the relationships are saved as optional: ${dialog.detail}`);
      s.expect(!/plain relationships|\bmeta\b|under "dbml"/.test(dialog.detail), `the dry run should use plain words: ${dialog.detail}`);
      s.expectNoFile('.erd-studio/main/diagrams/ecommerce.dbml');
      await s.wb.highlight(s.sel.dialog);
      await s.pause(3500);
      await s.wb.unhighlight();
    });

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
