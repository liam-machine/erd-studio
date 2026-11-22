// The first 60 seconds in a dbt project that has never had ERD Studio,
// realistic: every VS Code prompt on, ERD Studio installed in the window as
// from the Marketplace. ERD Studio activates on install (workspaceContains
// dbt_project.yml) and, on this first run, opens a draft of the top-ranked
// models folder without asking: the one thing that opens by itself. Nothing
// else may interrupt in the first minute.

import { waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, quietFirstMinute, theOneInterruption } from '../lib/firstMinute.mjs';
import { story } from '../lib/story.mjs';

export default story({
  id: 'first-minute-dbt-project',
  title: 'The first minute, in a dbt project',
  persona: 'As an analytics engineer with a dbt project',
  want: 'I want ERD Studio to find my models and ask me once',
  soThat: 'so that I see my warehouse as a diagram in one click',
  workspace: { name: 'analytics', from: 'test/fixtures/dbt-project', skip: ['.erd-studio', '.claude'] },
  realistic: true,
  steps: async (s) => {
    await givenVSCode(s, 'analytics');
    await installStep(s);

    await s.step('It finds my dbt project and opens a draft of my gold models: the one thing that opens by itself', async () => {
      await theOneInterruption(s, 'tab', /^Draft: /);
      const draft = await waitForDraft(s, 'Draft: gold');
      s.assert.deepEqual(draft.primary, ['Keep as Diagram']);
      s.expectNoFile('.erd-studio');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
      draft.page.close();
    }, { say: 'It finds my dbt project and opens a draft of my gold models, without asking. Nothing is saved until I keep it.', at: 'left' });

    await quietFirstMinute(s);
  },
});
