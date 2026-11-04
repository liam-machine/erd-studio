// The first 60 seconds in a folder of CREATE TABLE scripts, realistic: every
// VS Code prompt on, ERD Studio installed in the window as from the
// Marketplace. ERD Studio activates on install (workspaceContains *.sql),
// finds the scripts and asks once: the start suggestion. Its walkthrough does
// not open beside it (VS Code opens it on install only when its `when`
// holds: with no folder, or once ERD Studio has started). Show Me is one
// click to the draft. Nothing else may interrupt in the first minute.

import { waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, quietFirstMinute, theOneInterruption } from '../lib/firstMinute.mjs';
import { story } from '../lib/story.mjs';

const FOUND = 'ERD Studio found CREATE TABLE scripts in this folder';

export default story({
  id: 'first-minute-sql-scripts',
  title: 'The first minute, in a folder of SQL scripts',
  persona: 'As someone whose database schema is a folder of SQL scripts',
  want: 'I want ERD Studio to find them and ask me once',
  soThat: 'so that I see my model without a pile of pop-ups',
  workspace: { name: 'shop-database', add: { database: 'test/fixtures/sql-ddl/postgres' } },
  realistic: true,
  steps: async (s) => {
    await givenVSCode(s, 'shop-database');
    await installStep(s);

    await s.step('It finds my scripts and asks once: the one thing that pops up', async () => {
      await theOneInterruption(s, 'notification', new RegExp(`^${FOUND}`));
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { at: 'left' });

    await s.step('One click on "Show Me": the draft of my model', async () => {
      s.noise.expect(/^Draft: /, { kind: 'tab', why: 'Show Me' });
      await s.oneClick(() => s.ui.notificationButton(FOUND, 'Show Me'));
      const draft = await waitForDraft(s, 'Draft: sales', { tables: 4 });
      s.assert.deepEqual(draft.primary, ['Keep as Diagram']);
      s.expectNoFile('.erd-studio');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
      draft.page.close();
    }, { say: 'One click on Show Me: the draft of my model. Nothing is saved until I keep it.', at: 'left' });

    await quietFirstMinute(s);
  },
});
