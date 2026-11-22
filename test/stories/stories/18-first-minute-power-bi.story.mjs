// The first 60 seconds in a Power BI project saved as PBIP (the semantic
// model as TMDL files), realistic: every VS Code prompt on, ERD Studio
// installed in the window as from the Marketplace. ERD Studio activates on
// install (workspaceContains a model.tmdl), finds the semantic model and, on
// this first run, opens a draft of it without asking: the one thing that
// opens by itself. Nothing else may interrupt in the first minute.

import { waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, quietFirstMinute, theOneInterruption } from '../lib/firstMinute.mjs';
import { story } from '../lib/story.mjs';

export default story({
  id: 'first-minute-power-bi',
  title: 'The first minute, in a Power BI project',
  persona: 'As a Power BI developer with my report saved as a PBIP project',
  want: 'I want ERD Studio to find my semantic model and ask me once',
  soThat: 'so that I see it as a diagram in one click',
  workspace: { name: 'adventure-sales', from: 'test/fixtures/semantic-model/pbip-tmdl' },
  realistic: true,
  steps: async (s) => {
    await givenVSCode(s, 'adventure-sales');
    await installStep(s);

    await s.step('It finds my semantic model and opens a draft of it: the one thing that opens by itself', async () => {
      await theOneInterruption(s, 'tab', /^Draft: /);
      const draft = await waitForDraft(s, 'Draft: adventure-sales', { tables: 4 });
      s.assert.deepEqual(draft.primary, ['Keep as Diagram']);
      s.expectNoFile('.erd-studio');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
      draft.page.close();
    }, { say: 'It finds my semantic model and opens a draft of it, without asking. Nothing is saved until I keep it.', at: 'left' });

    await quietFirstMinute(s);
  },
});
