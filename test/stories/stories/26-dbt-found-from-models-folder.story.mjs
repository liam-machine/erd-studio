// A dbt project's models/ folder opened on its own (File > Open Folder on
// models/, as people do to keep the Explorer short): dbt_project.yml is one
// folder up, outside the window. ERD Studio still finds the project (project
// discovery looks upward from the opened folder for the nearest
// dbt_project.yml: `findDbtProjectAbove`), so the start suggestion offers the
// dbt draft, and Show Me draws the gold models from the project's manifest.
// Keep writes the diagram into the dbt project's own .erd-studio/ folder (next
// to dbt_project.yml), not into models/.

import path from 'node:path';

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const FOUND = 'ERD Studio found a dbt project in a folder above this one';

export default story({
  id: 'dbt-found-from-models-folder',
  title: 'Open only my dbt models folder',
  persona: 'As an analytics engineer who opens only the models folder of my dbt project',
  want: 'I want ERD Studio to find the dbt project around it',
  soThat: 'so that I can still draw my models without reopening the project',
  // The dbt fixture as a project that has never met ERD Studio, with only models/ opened.
  workspace: { name: 'analytics', from: 'test/fixtures/dbt-project', skip: ['.erd-studio', '.claude'], open: 'models' },
  steps: async (s) => {
    const project = path.dirname(s.workspace);
    await s.step('Given I open only the models folder of my dbt project', async () => {
      s.assert.equal(path.basename(s.workspace), 'models');
      s.expectNoFile('dbt_project.yml');
      await s.expectFile(path.join(project, 'dbt_project.yml'));
      s.expectNoFile(path.join(project, '.erd-studio'));
      await s.eventually(async () => / models$|\] models/.test(await s.ui.windowTitle()), { message: 'the models folder did not open' });
      await s.wb.highlight(`document.querySelector('.part.sidebar')`);
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'Given I open only the models folder of my dbt project. The dbt project file is one folder up.' });

    await s.step('ERD Studio still finds the dbt project and offers its models as a diagram', async () => {
      const toast = await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      s.assert.equal(toast.message, `${FOUND}. Show its models as a diagram? Nothing is saved until you keep it.`);
      s.assert.deepEqual(toast.buttons, ['Show Me', "Don't Ask Again for This Folder"], 'the suggestion\'s buttons');
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(s.sel.welcomeLink('Import Your Data Model…'), { what: 'the Import Your Data Model… button in the empty Diagrams view' });
      s.assert.deepEqual(await s.wb.ev(s.sel.welcomeButtons), ['Import Your Data Model…'], 'Import Your Data Model… should be the one button in the empty Diagrams view (the guide leads with the dbt card)');
      s.expect((await s.ui.sidebarText()).includes('This folder is a dbt project.'), 'the empty Diagrams view should say the folder is a dbt project');
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { at: 'left' });

    let draft;
    await s.step('I click "Show Me": a draft of my gold models', async () => {
      await s.ui.notificationButton(FOUND, 'Show Me');
      draft = await waitForDraft(s, 'Draft: gold');
      s.assert.equal(await draft.page.ev(DRAFT.scopeLabel), 'Folder');
      s.expect(/^Draft from your dbt models in gold · /.test(draft.headline), `the headline: ${draft.headline}`);
      s.expect(draft.scopes.some((o) => o.startsWith('silver')), `the switcher should offer silver too: ${draft.scopes.join(' | ')}`);
      s.expect(draft.tables.length > 0, 'the draft draws models');
      s.expectNoFile(path.join(project, '.erd-studio'));
      await draft.page.highlight(DRAFT.banner);
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'I click Show Me. A draft of my gold models opens, with a switcher for the others.', at: 'left' });

    await s.step('When I keep it, it is saved in my dbt project, beside dbt_project.yml', async () => {
      const count = draft.tables.length;
      await draft.page.click(DRAFT.button('Keep as Diagram'));
      draft.page.close();
      await s.ui.waitForActiveTab('gold.dbml', { timeout: 45000 });
      const canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length === ${count}`, { what: `${count} tables on the canvas` });
      await s.expectFile(path.join(project, '.erd-studio/gold/diagrams/gold.dbml'));
      for (const m of ['dim_date', 'fct_task_event']) await s.expectFile(path.join(project, `.erd-studio/gold/tables/gold/${m}.dbml`), { contains: new RegExp(`^Table gold\\.${m}\\b`, 'm') });
      s.expectNoFile('.erd-studio');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2200);
      await s.wb.unhighlight();
      canvas.close();
    }, { say: 'When I keep it, it is saved in my dbt project, next to its project file.' });
  },
});
