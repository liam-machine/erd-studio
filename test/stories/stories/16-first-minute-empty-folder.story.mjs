// The first 60 seconds in a folder with nothing ERD Studio can bring in (a
// README), realistic: every VS Code prompt on, ERD Studio installed in the
// window as from the Marketplace. Nothing pops up: no walkthrough on install
// (its `when` lists it only once ERD Studio has started in a folder; Draft-
// first §3.4), no notification. One click on the ERD Studio icon is the
// start: a finished example as a read-only draft (once per machine), its
// primary New Diagram…, nothing written. Nothing else may interrupt in the
// first minute.

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, nothingPopsUp, quietFirstMinute } from '../lib/firstMinute.mjs';
import { story } from '../lib/story.mjs';

export default story({
  id: 'first-minute-empty-folder',
  title: 'The first minute, in an empty folder',
  persona: 'As someone who installs ERD Studio in a new, empty project folder',
  want: 'I want to see what it does without being asked anything',
  soThat: 'so that I can decide in seconds whether it is for me',
  workspace: { name: 'new-project', add: { 'README.md': 'test/stories/workspaces/plain/README.md' } },
  realistic: true,
  steps: async (s) => {
    await givenVSCode(s, 'new-project');
    await installStep(s);
    await nothingPopsUp(s);

    await s.step('One click on the ERD Studio icon: a finished example, as a draft', async () => {
      s.noise.expect(/^Example: /, { kind: 'tab', why: 'the ERD Studio icon' });
      await s.oneClick(() => s.ui.openSidebar('ERD Studio'));
      const draft = await waitForDraft(s, 'Example: Coffee shop');
      s.assert.deepEqual(draft.primary, ['New Diagram…'], 'New Diagram… is the example draft\'s one primary button');
      s.expectNoFile('.erd-studio');
      await draft.page.highlight(DRAFT.banner);
      await s.pause(2500);
      await s.wb.unhighlight();
      draft.page.close();
    }, { say: 'One click on the ERD Studio icon: a finished example opens, as a draft. Nothing is saved.' });

    await quietFirstMinute(s, { max: 0 });
  },
});
