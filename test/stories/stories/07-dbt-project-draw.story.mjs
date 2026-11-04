// A dbt project (dbt_project.yml, models/ with schema yml, target/manifest.json
// and catalog.json) that has never had ERD Studio: no .erd-studio/ folder.
// The empty Diagrams view should lead with "Draw from dbt" (the one primary
// start in a dbt project); it asks which models to start from, offering each
// models/ folder, then a name, and draws them. Proves the drawn tables become
// DBML files in the layer of their folder, the dbt relationship tests become
// Refs in a relationships file, the diagram file keeps a laid-out position for
// every table, and the canvas shows the Logical / Physical switch dbt brings.

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
    await s.step('Given my dbt project, never opened with ERD Studio', async () => {
      s.expectNoFile('.erd-studio');
      await s.expectFile('dbt_project.yml');
      await s.expectFile('target/manifest.json');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('analytics'), { message: 'the analytics folder did not open' });
    });

    await s.step('When I open the ERD Studio sidebar, it leads with "Draw from dbt"', async () => {
      await s.ui.openSidebar('ERD Studio');
      const button = s.sel.welcomeLink('Draw from dbt');
      await s.expectVisible(button, { what: 'the Draw from dbt button in the empty Diagrams view' });
      const first = await s.wb.ev(`[...document.querySelectorAll('.part.sidebar .welcome-view-content a, .part.sidebar .welcome-view-content .monaco-button')].find(a => a.offsetParent)?.textContent.trim()`);
      s.assert.equal(first, 'Draw from dbt', `a dbt project's first start should be Draw from dbt, but the first is "${first}"`);
      s.assert.deepEqual(await s.wb.ev(s.sel.welcomeButtons), ['Draw from dbt'], 'Draw from dbt should be the one button in the empty Diagrams view');
      await s.wb.highlight(button);
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'When I open the ERD Studio sidebar, it leads with: Draw from dbt.' });

    await s.step('When I click it, it asks which models to start from', async () => {
      await s.wb.click(s.sel.welcomeLink('Draw from dbt'));
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
