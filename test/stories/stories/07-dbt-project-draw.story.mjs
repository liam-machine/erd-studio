// A dbt project (dbt_project.yml, models/ with schema yml, target/manifest.json
// and catalog.json) that has never had ERD Studio: no .erd-studio/ folder.
// What every new dbt user now sees first: the start suggestion, "ERD Studio
// found a dbt project in this folder. Create a diagram from its models?"
// (Create Diagram / More Options… / Don't Ask Again for This Folder), while
// the empty Diagrams view leads with "Draw from dbt" (its one button, the
// same start). Create Diagram is Draw from dbt: it asks which models to start
// from, offering each models/ folder (there is no one obvious answer), then a
// name, and draws them. Proves the drawn tables become DBML files in the
// layer of their folder, the dbt relationship tests become Refs in a
// relationships file, the diagram file keeps a laid-out position for every
// table, and the canvas shows the Logical / Physical switch dbt brings.

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
    await s.step('ERD Studio offers to create a diagram from its models', async () => {
      const toast = await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      s.assert.equal(toast.message, `${FOUND}. Create a diagram from its models?`);
      s.assert.deepEqual(toast.buttons, ['Create Diagram', 'More Options…', "Don't Ask Again for This Folder"], 'the suggestion\'s buttons');
      // The same start in the sidebar: Draw from dbt is the empty Diagrams view's one button.
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(s.sel.welcomeLink('Draw from dbt'), { what: 'the Draw from dbt button in the empty Diagrams view' });
      s.assert.deepEqual(await s.wb.ev(s.sel.welcomeButtons), ['Draw from dbt'], 'Draw from dbt should be the one button in the empty Diagrams view');
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { at: 'left' });

    await s.step('I click "Create Diagram": it asks which models to start from', async () => {
      await s.ui.notificationButton(FOUND, 'Create Diagram');
      const pick = await s.ui.waitForQuickPick({ title: 'Draw from dbt' });
      s.expect(/Which dbt models/.test(pick.placeholder), `expected "Which dbt models…", got "${pick.placeholder}"`);
      for (const folder of ['gold', 'silver', 'staging']) s.expect(pick.items.includes(folder), `the models/${folder} folder should be offered: ${pick.items.join(', ')}`);
      await s.wb.highlight(s.sel.quickPickRow('silver'));
      await s.pause(1500);
      await s.wb.unhighlight();
    });

    await s.step('I pick my silver models and keep the name "silver"', async () => {
      await s.ui.pick('silver');
      const box = await s.ui.waitForQuickPick({ title: 'Draw from dbt' });
      s.expect(/Name the diagram/.test(box.message), `expected the name box, but it says "${box.message}"`);
      s.assert.equal(box.value, 'silver');
      await s.pause(900);
      await s.wb.press('Enter');
    });

    let canvas;
    await s.step('Then the diagram opens, laid out, with the relationships from my dbt tests', async () => {
      await s.ui.waitForActiveTab('silver.dbml');
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
