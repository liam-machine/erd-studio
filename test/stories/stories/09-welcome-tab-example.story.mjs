// No folder open, and ERD Studio's Welcome tab (the Getting Started panel, a
// webview of its own). With no folder open it offers "Open a folder…" and,
// under "Or see a finished data model first:", "Open an example…" — a start
// button that posts `start` / `example` to the host, which runs Open an
// Example Project…. Proves the button reaches the example picker (not the
// fallback "Start your data model" pick), that the Kimball bus matrix is
// written to a folder of its own, and that the window opens it on its first
// diagram, retail sales, with the star's tables on the canvas.
//
// The Welcome tab is opened from the ERD Studio sidebar's ▶ button (the
// Diagrams view's one title-bar icon with no folder open; the tab's footer
// names it), and the tab shows the example's "Watch how" clip beside the
// button.

import fs from 'node:fs';
import path from 'node:path';

import { story } from '../lib/story.mjs';

const OPEN_EXAMPLE = `[...doc.querySelectorAll('[data-action="start"][data-start="example"]')].find(b => b.offsetParent)`;

export default story({
  id: 'welcome-tab-example',
  title: 'Open the Kimball example from the Welcome tab',
  persona: 'As someone new to data modelling with no project of my own yet',
  want: 'I want to open a finished example from the Welcome tab',
  soThat: 'so that I can see what a good data model looks like',
  workspace: 'empty',
  steps: async (s) => {
    const projects = path.join(s.home, 'Projects');
    const example = path.join(projects, 'kimball-bus-matrix');

    await s.step('Given VS Code with no folder open', async () => {
      fs.mkdirSync(projects, { recursive: true }); // somewhere of my own to keep it
      const title = await s.ui.windowTitle();
      s.expect(!title.includes(' — '), `expected an empty window, but the title is "${title}"`);
    });

    const PLAY = s.sel.viewAction('Watch Getting Started Video');
    await s.step('When I open the ERD Studio sidebar and press its ▶ button', async () => {
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(PLAY, { what: 'the ▶ (Watch Getting Started Video) button on the Diagrams view' });
      await s.wb.highlight(PLAY);
      await s.pause(1200);
      await s.wb.unhighlight();
      await s.wb.click(PLAY);
      await s.ui.waitForActiveTab('Welcome to ERD Studio');
    });

    let welcome;
    await s.step('Then it offers "Open an example…" to see a finished data model first', async () => {
      welcome = await s.webview();
      await welcome.waitFor(`doc.body.innerText.includes('Welcome to ERD Studio') && ${OPEN_EXAMPLE}`, { what: 'the Welcome tab with its "Open an example…" button' });
      const text = await welcome.ev('doc.body.innerText');
      s.expect(text.includes('Or see a finished data model first:'), 'the Welcome tab should say "Or see a finished data model first:"');
      s.expect(!/\bdbt\b/i.test(text), 'with no folder open the Welcome tab must show no dbt word');
      // "Watch how": the example's clip, in the open-a-folder card, not playing (it has sound: a click plays it).
      const clip = await welcome.waitFor(`(() => { const v=doc.querySelector('.gs-noproject .gs-howto [data-clip="example"]'); return v && !v.closest('[hidden]') && { muted: v.muted, paused: v.paused }; })()`, { what: 'the example\'s "Watch how" clip in the open-a-folder card' });
      s.expect(!clip.muted && clip.paused, `the clip should wait, with its sound on, for a click: ${JSON.stringify(clip)}`);
      // Into the middle of the page: the bottom of the window is where the captions go.
      // The button is the last thing on the page, so (filming aid only) the page gets
      // room below it to scroll up into.
      await welcome.ev(`(doc.body.style.paddingBottom = '45vh', ${OPEN_EXAMPLE}.scrollIntoView({ block: 'center' }), true)`);
      await welcome.waitFor(`(() => { const r=${OPEN_EXAMPLE}.getBoundingClientRect(); return r.bottom < win.innerHeight * 0.75; })()`, { what: 'the button to scroll into view' });
      await welcome.highlight(`${OPEN_EXAMPLE}.closest('section, .gs-card') ?? ${OPEN_EXAMPLE}`);
      await s.pause(2000);
      await s.wb.unhighlight();
    });

    await s.step('When I click it, the examples are listed', async () => {
      await welcome.click(OPEN_EXAMPLE);
      welcome.close();
      const pick = await s.ui.waitForQuickPick();
      s.expect(!pick.title.includes('Start your data model'), "the Welcome tab's button did not reach Open an Example Project: it showed the fallback start picker");
      s.assert.equal(pick.title, 'Open an Example Project');
      s.expect(pick.items.includes('Kimball bus matrix'), `Kimball bus matrix is not offered: ${pick.items.join(', ')}`);
      await s.wb.highlight(s.sel.quickPickRow('Kimball bus matrix'));
      await s.pause(2000);
      await s.wb.unhighlight();
    });

    let page;
    await s.step('I pick "Kimball bus matrix" and save it in my Projects folder', async () => {
      await s.ui.pick('Kimball bus matrix');
      const dialog = await s.ui.waitForQuickPick({ title: 'choose where to save it' });
      s.assert.equal(dialog.value, `${s.home}/`, 'the folder dialog should start in my home folder');
      await s.ui.appendQuickInput('Projects/');
      await s.wb.waitFor(`${s.sel.quickInputBox}?.value === ${JSON.stringify(`${projects}/`)}`, { what: 'the Projects folder in the dialog' });
      await s.pause(800);
      page = await s.wb.tagPage();
      await s.ui.quickInputButton('Save Example Here');
    });

    await s.step('Then the window opens the example folder', async () => {
      await s.wb.waitForReload(page);
      await s.expectFile(path.join(example, '.erd-studio/presentation/diagrams/retail-sales.dbml'), { contains: 'Project "retail-sales"' });
      await s.eventually(async () => (await s.ui.windowTitle()).includes('kimball-bus-matrix'), { message: 'the window title never named the kimball-bus-matrix folder' });
    });

    await s.step('And the retail sales star opens on the canvas', async () => {
      await s.ui.waitForActiveTab('retail-sales.dbml');
      const canvas = await s.webview();
      const tables = await canvas.waitFor(`(() => { const t=[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText).join('\\n'); return t.includes('fct_retail_sales') && t; })()`, { what: 'the retail sales tables on the canvas' });
      for (const name of ['fct_retail_sales', 'dim_date', 'dim_product', 'dim_store', 'dim_promotion']) {
        s.expect(tables.includes(name), `the canvas should show ${name}`);
      }
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(3000);
      await s.wb.unhighlight();
      canvas.close();
    });
  },
});
