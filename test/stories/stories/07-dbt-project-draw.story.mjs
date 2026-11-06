// A dbt project (dbt_project.yml, models/ with schema yml, target/manifest.json
// and catalog.json) that has never had ERD Studio: no .erd-studio/ folder.
// What every new dbt user now sees first: the start suggestion, "ERD Studio
// found a dbt project in this folder. Show its models as a diagram? Nothing
// is saved until you keep it." (Show Me / Don't Ask Again for This Folder),
// while the empty Diagrams view leads with "Import from dbt" (its one button).
// Show Me is Draft-first: no picker, no name box, a read-only draft of the
// top-ranked models folder (gold) with a Folder switcher over the others.
// Switching to silver redraws it ("Draft: silver"), still nothing on disk.
// Keep as Diagram runs Import from dbt's writer: the drawn tables become DBML
// files in the layer of their folder, the dbt relationship tests become Refs,
// the diagram file keeps a laid-out position for every table, and the canvas
// shows the Logical / Physical switch dbt brings.

import { DRAFT, chooseScope, draftState, waitForDraft } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const MODELS = ['dim_customer', 'dim_project', 'dim_task', 'fct_order', 'fct_sale'];

export default story({
  id: 'dbt-project-draw',
  title: 'Draw my dbt project',
  persona: 'As an analytics engineer with a dbt project',
  want: 'I want a diagram of my models and their relationships without drawing it',
  soThat: 'so that I can see and improve the design of my warehouse',
  // The dbt fixture as a project that has never met ERD Studio.
  workspace: { name: 'analytics', from: 'test/fixtures/dbt-project', skip: ['.erd-studio', '.claude'] },
  steps: async (s) => {
    await s.step('Given I open my dbt project, never opened with ERD Studio', async () => {
      s.expectNoFile('.erd-studio');
      await s.expectFile('dbt_project.yml');
      await s.expectFile('target/manifest.json');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('analytics'), { message: 'the analytics folder did not open' });
    });

    const FOUND = 'ERD Studio found a dbt project in this folder';
    await s.step('ERD Studio offers to show its models as a diagram', async () => {
      const toast = await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      s.assert.equal(toast.message, `${FOUND}. Show its models as a diagram? Nothing is saved until you keep it.`);
      s.assert.deepEqual(toast.buttons, ['Show Me', "Don't Ask Again for This Folder"], 'the suggestion\'s buttons');
      // The same start in the sidebar: Import from dbt is the empty Diagrams view's one button.
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(s.sel.welcomeLink('Import from dbt'), { what: 'the Import from dbt button in the empty Diagrams view' });
      s.assert.deepEqual(await s.wb.ev(s.sel.welcomeButtons), ['Import from dbt'], 'Import from dbt should be the one button in the empty Diagrams view');
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { at: 'left' });

    let draft;
    await s.step('I click "Show Me": a draft of my top models folder, and a switcher for the others', async () => {
      await s.ui.notificationButton(FOUND, 'Show Me');
      draft = await waitForDraft(s, 'Draft: gold');
      s.assert.equal(await draft.page.ev(DRAFT.scopeLabel), 'Folder');
      for (const folder of ['gold', 'silver']) s.expect(draft.scopes.some((o) => o.startsWith(folder)), `the switcher should offer models/${folder}: ${draft.scopes.join(' | ')}`);
      s.expect(draft.scope.startsWith('gold'), `the draft should start on gold, the top-ranked folder: ${draft.scope}`);
      s.expect(/^Draft from your dbt models in gold · /.test(draft.headline), `the headline: ${draft.headline}`);
      s.expectNoFile('.erd-studio');
      await draft.page.highlight(DRAFT.banner);
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'I click Show Me. A draft of my gold models opens, with a switcher for my other model folders.', at: 'left' });

    await s.step('I switch it to my silver models', async () => {
      await chooseScope(s, draft.page, 'silver');
      await draft.page.waitFor(`(${DRAFT.headline} ?? '').startsWith('Draft from your dbt models in silver') && !${DRAFT.busy} && doc.querySelectorAll('.react-flow__node').length === ${MODELS.length}`, { timeout: 45000, what: 'the silver draft' });
      await s.ui.waitForActiveTab('Draft: silver');
      const state = await draftState(draft.page);
      s.assert.deepEqual([...state.tables].sort(), MODELS, `the draft should draw the silver models, but draws ${state.tables.join(', ')}`);
      s.expect(/Keep saves it as silver in the Silver layer/.test(state.detail), `the detail: ${state.detail}`);
      s.expectNoFile('.erd-studio');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2000);
      await s.wb.unhighlight();
    });

    await s.step('I press "Keep as Diagram"', async () => {
      await draft.page.click(DRAFT.button('Keep as Diagram'));
      draft.page.close();
    });

    let canvas;
    await s.step('Then the diagram opens, laid out, with the relationships from my dbt tests', async () => {
      await s.ui.waitForActiveTab('silver.dbml', { timeout: 45000 });
      canvas = await s.webview();
      const names = await canvas.waitFor(`(() => { const n=[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText.split('\\n')[0]); return n.length === ${MODELS.length} && n; })()`, { what: `${MODELS.length} tables on the canvas` });
      s.assert.deepEqual([...names].sort(), MODELS, `the canvas should show the silver models, but shows ${names.join(', ')}`);
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__edge').length === 5`, { what: 'five relationship lines' });
      // Laid out: no two tables in the same place.
      const spots = await canvas.ev(`[...doc.querySelectorAll('.react-flow__node')].map(n => n.style.transform)`);
      s.assert.equal(new Set(spots).size, spots.length, `two tables share a position: ${spots.join(' | ')}`);
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
    });

    await s.step('And it shows my design (Logical) beside what dbt built (Physical)', async () => {
      const tabs = await canvas.waitFor(`doc.body.innerText.includes('Physical') && [...doc.querySelectorAll('button')].filter(b => /^(Logical|Physical)/.test(b.textContent.trim())).map(b => b.textContent.trim())`, { what: 'the Logical / Physical switch' });
      s.expect(tabs.some((t) => t.startsWith('Logical')) && tabs.some((t) => t.startsWith('Physical')), `expected Logical and Physical tabs, got ${tabs.join(', ')}`);
      await canvas.highlight(`[...doc.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Logical')).parentElement`);
      await s.pause(2000);
      await s.wb.unhighlight();
      canvas.close();
    });

    await s.step('And each model is a DBML table file, positions kept in the diagram', async () => {
      for (const m of MODELS) await s.expectFile(`.erd-studio/silver/tables/silver/${m}.dbml`, { contains: new RegExp(`^Table silver\\.${m}\\b`, 'm') });
      await s.expectFile('.erd-studio/silver/relationships/silver.dbml', { contains: /^Ref/m });
      const diagram = await s.expectFile('.erd-studio/silver/diagrams/silver.dbml', { contains: 'erd_layout' });
      for (const m of MODELS) await s.expectFile(diagram, { contains: new RegExp(`^\\s+${m} -?\\d+ -?\\d+$`, 'm') });
      await s.expectVisible(s.sel.sidebarRow('fct_order'), { what: 'fct_order in the Table Library' });
      await s.wb.highlight(s.sel.sidebarRow('fct_order'));
      await s.pause(1800);
      await s.wb.unhighlight();
    });
  },
});
