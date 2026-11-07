// The first five minutes, from nothing: ERD Studio installed, no folder open.
// The empty Diagrams view's one button is Open Folder…; "More ways to start…"
// is a command link with JSON arguments (command:erdStudio.start?[{"from":"sidebar"}])
// that opens the other starts in a quick pick: this story proves the argument
// reaches erdStudio.start in a real VS Code. Open an Example… shows a finished
// example as a read-only draft (the coffee shop first, an Example switcher
// over the bundled projects); switching to the Medallion lakehouse offers
// Save This Example…, which copies it to a folder of its own and opens it
// there, on its gold sales diagram.

import fs from 'node:fs';
import path from 'node:path';

import { DRAFT, chooseScope, waitForDraft } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

export default story({
  id: 'empty-window-opens-an-example',
  title: 'Open an example from an empty window',
  persona: 'As someone who just installed ERD Studio with no folder open',
  want: 'I want to see a finished data model in one click',
  soThat: 'so that I understand what the tool does',
  workspace: 'empty',
  steps: async (s) => {
    const projects = path.join(s.home, 'Projects');
    const example = path.join(projects, 'medallion');

    await s.step('Given VS Code with no folder open', async () => {
      fs.mkdirSync(projects, { recursive: true }); // somewhere of my own to keep it
      const title = await s.ui.windowTitle();
      s.expect(!title.includes(' — '), `expected an empty window, but the title is "${title}"`);
      await s.wb.highlight(s.sel.activity('ERD Studio'));
      await s.pause(1200);
      await s.wb.unhighlight();
    });

    await s.step('When I open the ERD Studio sidebar', async () => {
      await s.ui.openSidebar('ERD Studio');
    });

    const MORE = s.sel.welcomeLink('More ways to start…');
    await s.step('It offers "Open Folder…", and "More ways to start…"', async () => {
      await s.expectVisible(MORE, { what: 'the "More ways to start…" link' });
      // No folder, no suggestion: Open Folder… is the one button, the other starts a link beside it.
      s.assert.deepEqual(await s.wb.ev(s.sel.welcomeButtons), ['Open Folder…'], 'Open Folder… should be the one button in an empty window');
      const href = await s.wb.ev(`${MORE}.getAttribute('href') ?? ''`);
      s.assert.deepEqual(
        JSON.parse(decodeURIComponent(href.replace(/^command:erdStudio\.start\?/, ''))),
        [{ from: 'sidebar' }],
        `the link should run erdStudio.start from the sidebar, but its href is ${href}`,
      );
      await s.wb.highlight(MORE);
      await s.pause(1200);
      await s.wb.unhighlight();
    });

    await s.step('I click it, and choose "Open an Example…"', async () => {
      await s.wb.click(MORE);
      const pick = await s.ui.waitForQuickPick({ title: 'More ways to start' });
      s.expect(pick.items.includes('Open an Example…'), `the quick pick should offer Open an Example…: ${pick.items.join(' | ')}`);
      await s.wb.highlight(s.sel.quickPickRow('Open an Example…'));
      await s.pause(1000);
      await s.wb.unhighlight();
      await s.ui.pick('Open an Example…');
    });

    let draft;
    await s.step('A finished example opens, and I can switch to others', async () => {
      draft = await waitForDraft(s, 'Example: Coffee shop');
      s.assert.equal(await draft.page.ev(DRAFT.scopeLabel), 'Example');
      s.expect(draft.scopes.some((o) => o.startsWith('Medallion lakehouse')), `the switcher should offer Medallion lakehouse: ${draft.scopes.join(' | ')}`);
      s.assert.deepEqual(draft.primary, ['Open Folder…'], 'with no folder open, Open Folder… is the draft\'s primary');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'A finished example opens, a coffee shop. And I can switch to others.' });

    await s.step('I switch to "Medallion lakehouse"', async () => {
      await chooseScope(s, draft.page, 'Medallion lakehouse');
      await s.ui.waitForActiveTab('Example: Medallion lakehouse', { timeout: 45000 });
      draft.page.close();
      draft = await waitForDraft(s, 'Example: Medallion lakehouse');
      s.assert.deepEqual(draft.primary, ['Save This Example…']);
      for (const name of ['fct_order_line', 'dim_customer', 'dim_date', 'dim_product']) {
        s.expect(draft.tables.some((t) => t.endsWith(name)), `the example should draw ${name}: ${draft.tables.join(', ')}`);
      }
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(1800);
      await s.wb.unhighlight();
    });

    let page;
    await s.step('I press "Save This Example…" and save it in my Projects folder', async () => {
      await draft.page.click(DRAFT.button('Save This Example…'));
      draft.page.close();
      const dialog = await s.ui.waitForQuickPick({ title: 'choose where to save it' });
      // VS Code's own folder dialog opens in my home folder: I go into Projects.
      s.assert.equal(dialog.value, `${s.home}/`, 'the folder dialog should start in my home folder');
      await s.ui.appendQuickInput('Projects/');
      const { value } = await s.ui.quickPick();
      s.assert.equal(value, `${projects}/`, 'the folder box should hold my Projects folder');
      await s.pause(800);
      page = await s.wb.tagPage();
      await s.ui.quickInputButton('Save Example Here');
    }, { say: 'I press Save This Example, and save it in my Projects folder.' });

    await s.step('Then the window opens the medallion folder', async () => {
      // An empty window opens the folder in itself: VS Code reloads the window.
      await s.wb.waitForReload(page);
      await s.expectFile(path.join(example, '.erd-studio/gold/diagrams/sales.dbml'), { contains: 'Project' });
      await s.eventually(async () => (await s.ui.windowTitle()).includes('medallion'), { message: 'the window title never named the medallion folder' });
    });

    await s.step('And the gold sales diagram opens on the canvas', async () => {
      await s.ui.waitForActiveTab('sales.dbml');
      const canvas = await s.webview();
      const tables = await canvas.waitFor(`[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText).join('\\n')`, { what: 'tables on the canvas' });
      for (const name of ['fct_order_line', 'dim_customer', 'dim_date', 'dim_product']) {
        s.expect(tables.includes(name), `the canvas should show ${name}`);
      }
      await s.wb.highlight(`document.querySelector('.editor-group-container.active .editor-container')`);
      await s.pause(2500);
      await s.wb.unhighlight();
      canvas.close();
    });
  },
});
