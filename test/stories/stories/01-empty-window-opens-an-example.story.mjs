// The first five minutes, from nothing: ERD Studio installed, no folder open.
// The empty Diagrams view's "Open an example" is a command link with JSON
// arguments (command:erdStudio.start?[{"action":"example","from":"sidebar"}]):
// this story proves the argument reaches erdStudio.start in a real VS Code.
// Without it, erdStudio.start shows its fallback quick pick ("Start your data
// model") instead of the example list, and step 5 fails.

import fs from 'node:fs';
import path from 'node:path';

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

    await s.step('Then I see "Open an example" in the empty Diagrams view', async () => {
      const link = s.sel.welcomeLink('Open an example');
      await s.expectVisible(link, { what: 'the "Open an example" link' });
      const href = await s.wb.ev(`${link}.getAttribute('href') ?? ''`);
      s.assert.deepEqual(
        JSON.parse(decodeURIComponent(href.replace(/^command:erdStudio\.start\?/, ''))),
        [{ action: 'example', from: 'sidebar' }],
        `the link should run erdStudio.start with the example action, but its href is ${href}`,
      );
      await s.wb.highlight(link);
      await s.pause(1200);
      await s.wb.unhighlight();
    });

    await s.step('When I click it', async () => {
      await s.wb.click(s.sel.welcomeLink('Open an example'));
    });

    await s.step('Then the example picker opens, with "Enterprise warehouse" first', async () => {
      const pick = await s.ui.waitForQuickPick();
      s.expect(
        !pick.title.includes('Start your data model'),
        'the command link\'s argument did not reach erdStudio.start: it showed its fallback quick pick ("Start your data model") instead of the examples',
      );
      s.assert.equal(pick.title, 'Open an Example Project');
      s.assert.equal(pick.items[0], 'Enterprise warehouse');
      s.expect(pick.items.includes('Medallion lakehouse'), `Medallion lakehouse is not offered: ${pick.items.join(', ')}`);
      await s.wb.highlight(s.sel.quickPickRow('Enterprise warehouse'));
      await s.pause(1500);
      await s.wb.unhighlight();
    });

    let page;
    await s.step('When I pick "Medallion lakehouse" and save it in my Projects folder', async () => {
      await s.ui.pick('Medallion lakehouse');
      const dialog = await s.ui.waitForQuickPick({ title: 'choose where to save it' });
      // VS Code's own folder dialog opens in my home folder: I go into Projects.
      s.assert.equal(dialog.value, `${s.home}/`, 'the folder dialog should start in my home folder');
      await s.ui.appendQuickInput('Projects/');
      const { value } = await s.ui.quickPick();
      s.assert.equal(value, `${projects}/`, 'the folder box should hold my Projects folder');
      await s.pause(800);
      page = await s.wb.tagPage();
      await s.ui.quickInputButton('Save Example Here');
    });

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
