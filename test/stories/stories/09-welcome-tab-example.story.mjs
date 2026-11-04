// No folder open, and ERD Studio's tour tab ("ERD Studio Tour", the Getting
// Started panel, a webview of its own), opened from the Diagrams view's ▶
// (Watch the One-Minute Tour, its one title-bar icon with no folder open).
// With no folder it offers Open Folder… and, under "Or see a finished data
// model first:", Open an Example… — a start button that posts `start` /
// `example` to the host, which opens the example draft. Proves the button
// reaches the example draft (not the fallback "More ways to start" pick),
// that the switcher offers the Kimball bus matrix, that Save This Example…
// writes it to a folder of its own, and that the window opens it on its
// first diagram, retail sales, with the star's tables on the canvas. The
// tab's short videos include the example's clip, waiting for a click.

import fs from 'node:fs';
import path from 'node:path';

import { DRAFT, chooseScope, waitForDraft } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const OPEN_EXAMPLE = `[...doc.querySelectorAll('[data-action="start"][data-start="example"]')].find(b => b.offsetParent)`;

export default story({
  id: 'welcome-tab-example',
  title: 'Open the Kimball example from the tour',
  persona: 'As someone new to data modelling with no project of my own yet',
  want: 'I want to open a finished example from the one-minute tour',
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

    const PLAY = s.sel.viewAction('Watch the One-Minute Tour');
    await s.step('When I open the ERD Studio sidebar and press its ▶ button', async () => {
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(PLAY, { what: 'the ▶ (Watch the One-Minute Tour) button on the Diagrams view' });
      await s.wb.highlight(PLAY);
      await s.pause(1200);
      await s.wb.unhighlight();
      await s.wb.click(PLAY);
      await s.ui.waitForActiveTab('ERD Studio Tour');
    }, { say: 'When I open the ERD Studio sidebar and press its play button.' });

    let tour;
    await s.step('Then the tour offers "Open an Example…" to see a finished data model first', async () => {
      tour = await s.webview();
      await tour.waitFor(`doc.body.innerText.includes('The one-minute tour') && ${OPEN_EXAMPLE}`, { what: 'the tour tab with its "Open an Example…" button' });
      const text = await tour.ev('doc.body.innerText');
      s.expect(text.includes('Or see a finished data model first:'), 'the tour tab should say "Or see a finished data model first:"');
      s.expect(!/\bdbt\b/i.test(text), 'with no folder open the tour tab must show no dbt word');
      // The short videos: the example's clip among them, not playing (it has sound: a click plays it).
      const clip = await tour.waitFor(`(() => { const v=doc.querySelector('.gs-howto [data-clip="example"]'); return v && !v.closest('[hidden]') && { muted: v.muted, paused: v.paused }; })()`, { what: 'the example\'s short video' });
      s.expect(!clip.muted && clip.paused, `the clip should wait, with its sound on, for a click: ${JSON.stringify(clip)}`);
      await tour.ev(`(${OPEN_EXAMPLE}.scrollIntoView({ block: 'center' }), true)`);
      await tour.highlight(`${OPEN_EXAMPLE}.closest('section') ?? ${OPEN_EXAMPLE}`);
      await s.pause(2000);
      await s.wb.unhighlight();
    });

    let draft;
    await s.step('When I click it, an example opens, with a switcher for the others', async () => {
      await tour.click(OPEN_EXAMPLE);
      tour.close();
      draft = await waitForDraft(s, 'Example: Coffee shop');
      s.expect(draft.scopes.some((o) => o.startsWith('Kimball bus matrix')), `Kimball bus matrix is not offered: ${draft.scopes.join(' | ')}`);
      await draft.page.highlight(DRAFT.select);
      await s.pause(1500);
      await s.wb.unhighlight();
    });

    await s.step('I switch to "Kimball bus matrix": the retail sales star', async () => {
      await chooseScope(s, draft.page, 'Kimball bus matrix');
      await s.ui.waitForActiveTab('Example: Kimball bus matrix', { timeout: 45000 });
      draft.page.close();
      draft = await waitForDraft(s, 'Example: Kimball bus matrix');
      for (const name of ['fct_retail_sales', 'dim_date', 'dim_product', 'dim_store', 'dim_promotion']) {
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
      s.assert.equal(dialog.value, `${s.home}/`, 'the folder dialog should start in my home folder');
      await s.ui.appendQuickInput('Projects/');
      await s.wb.waitFor(`${s.sel.quickInputBox}?.value === ${JSON.stringify(`${projects}/`)}`, { what: 'the Projects folder in the dialog' });
      await s.pause(800);
      page = await s.wb.tagPage();
      await s.ui.quickInputButton('Save Example Here');
    }, { say: 'I press Save This Example, and save it in my Projects folder.' });

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
