// The first 60 seconds in a folder of CREATE TABLE scripts, realistic: every
// VS Code prompt on, ERD Studio installed in the window as from the
// Marketplace. ERD Studio activates on install (workspaceContains *.sql),
// finds the scripts and, this being its first run, opens a draft of them: the
// one thing that opens by itself, with no question first (the start
// suggestion's notification is for later windows and for upgraders). Its
// walkthrough does not open beside it (VS Code opens it on install only when
// its `when` holds: with no folder, or once ERD Studio has started). Nothing
// is saved, and nothing else may interrupt in the first minute.

import { waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, quietFirstMinute, theOneInterruption } from '../lib/firstMinute.mjs';
import { story } from '../lib/story.mjs';

const FOUND = 'ERD Studio found CREATE TABLE scripts in this folder';

export default story({
  id: 'first-minute-sql-scripts',
  title: 'The first minute, in a folder of SQL scripts',
  persona: 'As someone whose database schema is a folder of SQL scripts',
  want: 'I want ERD Studio to find them and show me my model',
  soThat: 'so that I see my model without a pile of pop-ups',
  workspace: { name: 'shop-database', add: { database: 'test/fixtures/sql-ddl/postgres' } },
  realistic: true,
  steps: async (s) => {
    await givenVSCode(s, 'shop-database');
    await installStep(s);

    await s.step('It finds my scripts and opens a draft of my model: the one thing that opens by itself', async () => {
      await theOneInterruption(s, 'tab', /^Draft: /);
      const draft = await waitForDraft(s, 'Draft: sales', { tables: 4 });
      s.assert.deepEqual(draft.primary, ['Keep as Diagram']);
      s.expectNoFile('.erd-studio');
      // No question beside it: a first run is not asked "Show them as a diagram?".
      const toasts = await s.ui.notifications();
      s.expect(!toasts.some((t) => t.includes(FOUND)), `the start suggestion should not show beside the first run's draft: ${toasts.join(' | ')}`);
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
      draft.page.close();
    }, { say: 'It finds my scripts and opens a draft of my model, without asking. Nothing is saved until I keep it.', at: 'left' });

    await quietFirstMinute(s);
  },
});
