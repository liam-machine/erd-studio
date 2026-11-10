// The first 60 seconds in a dbt project that has never had ERD Studio,
// realistic: every VS Code prompt on, ERD Studio installed in the window as
// from the Marketplace. ERD Studio activates on install (workspaceContains
// dbt_project.yml) and asks once; Show Me is one click to the draft of the
// top-ranked models folder. Nothing else may interrupt in the first minute.

import { waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, quietFirstMinute, theOneInterruption } from '../lib/firstMinute.mjs';
import { story } from '../lib/story.mjs';

const FOUND = 'ERD Studio found a dbt project in this folder';

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

    await s.step('It finds my dbt project and asks once: the one thing that pops up', async () => {
      const event = await theOneInterruption(s, 'notification', new RegExp(`^${FOUND}`));
      s.assert.equal(event.text, `${FOUND}. Show its models as a diagram? Nothing is saved until you keep it.`);
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { at: 'left' });

    await s.step('One click on "Show Me": the draft of my gold models', async () => {
      s.noise.expect(/^Draft: /, { kind: 'tab', why: 'Show Me' });
      s.noise.expect(/^Reading your dbt project/, { kind: 'notification', why: 'Show Me (its progress)' });
      await s.oneClick(() => s.ui.notificationButton(FOUND, 'Show Me'));
      const draft = await waitForDraft(s, 'Draft: gold');
      s.assert.deepEqual(draft.primary, ['Keep as Diagram']);
      s.expectNoFile('.erd-studio');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
      draft.page.close();
    }, { say: 'One click on Show Me: a draft of my gold models. Nothing is saved until I keep it.', at: 'left' });

    await quietFirstMinute(s);
  },
});
