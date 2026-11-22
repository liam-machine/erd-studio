// No folder open, and ERD Studio's tour tab ("ERD Studio Tour", the Getting
// Started panel, a webview of its own), opened from the Diagrams section's
// "…" menu: Watch the Tour, its one entry with no folder open. (The native
// Diagrams view drew it as a ▶ in its title bar; the glass sidebar keeps a
// section header to a "+", Collapse All and "…", and every other title icon
// is in the "…": glassSidebar/titleActions.ts.)
// With no folder it offers Open Folder… and, under "Or see a finished data
// model first:", Open an Example… — a start button that posts `start` /
// `example` to the host, which opens the example draft. Proves the button
// reaches the example draft (not the fallback "More ways to start" pick),
// that the switcher offers the Kimball bus matrix, that Save This Example…
// writes it to a folder of its own, and that the window opens it on its
// first diagram, retail sales, with the star's tables on the canvas. The
// tab also offers Show Me Around (the interactive guide).

import fs from 'node:fs';
import path from 'node:path';

import { DRAFT, chooseScope, waitForDraft } from '../lib/draft.mjs';
import { SIDEBAR } from '../lib/sidebar.mjs';
import { story } from '../lib/story.mjs';

const OPEN_EXAMPLE = `[...doc.querySelectorAll('[data-action="start"][data-start="example"]')].find(b => b.offsetParent)`;

export default story({
  id: 'welcome-tab-example',
  title: 'Open the Kimball example from the tour',
  persona: 'As someone new to data modelling with no project of my own yet',
  want: 'I want to open a finished example from the tour',
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

    const MORE = SIDEBAR.moreActions('Diagrams');
    const TOUR = SIDEBAR.menuItem('Watch the Tour');
    await s.step('When I open the ERD Studio sidebar and choose "Watch the Tour" from the Diagrams menu', async () => {
      await s.ui.openSidebar('ERD Studio');
      // The header's icons show while the pointer is on it.
      await s.sidebar.hover(SIDEBAR.sectionHeader('Diagrams'));
      await s.sidebar.expectVisible(MORE, { what: 'the "…" (more actions) button on the Diagrams section' });
      await s.sidebar.highlight(MORE);
      await s.pause(1200);
      await s.wb.unhighlight();
      await s.sidebar.click(MORE);
      await s.sidebar.expectVisible(TOUR, { what: 'Watch the Tour in the Diagrams section\'s menu' });
      // With no folder open there is nothing else to offer there.
      s.assert.deepEqual(await s.sidebar.ev(SIDEBAR.menuItems), ['Watch the Tour'], 'Watch the Tour should be the Diagrams menu\'s one entry with no folder open');
      await s.sidebar.highlight(TOUR);
      await s.pause(1200);
      await s.wb.unhighlight();
      await s.sidebar.click(TOUR);
      await s.ui.waitForActiveTab('ERD Studio Tour');
    }, { say: 'When I open the ERD Studio sidebar and choose Watch the Tour from the Diagrams menu.' });

    let tour;
    await s.step('Then the tour offers "Open an Example…" to see a finished data model first', async () => {
      tour = await s.webview();
      await tour.waitFor(`doc.body.innerText.includes('The tour') && ${OPEN_EXAMPLE}`, { what: 'the tour tab with its "Open an Example…" button' });
      const text = await tour.ev('doc.body.innerText');
      s.expect(text.includes('Or see a finished data model first:'), 'the tour tab should say "Or see a finished data model first:"');
      s.expect(!/\bdbt\b/i.test(text), 'with no folder open the tour tab must show no dbt word');
      // Show Me Around (the interactive guide) is offered here too, in place of the old short videos.
      await tour.waitFor(`(() => { const b=doc.querySelector('[data-action="showMeAround"]'); return !!b && !b.closest('[hidden]') && b.textContent.trim() === 'Show Me Around'; })()`, { what: 'the Show Me Around button' });
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
