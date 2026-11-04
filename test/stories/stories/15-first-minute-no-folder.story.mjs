// The first 60 seconds, with no folder open (realistic: every VS Code prompt
// on, ERD Studio installed in the window as from the Marketplace). VS Code
// opens an extension's walkthrough when it is installed
// (workbench.welcomePage.walkthroughs.openOnInstall): with no folder open
// that is ERD Studio's "Get started" walkthrough, and it is the one thing
// that pops up. Its first step's Open Folder… is the next step, one click
// away (VS Code's folder dialog). Nothing else may interrupt in the first
// minute (lib/noise.mjs counts notifications, tabs, walkthroughs, modals and
// quick picks nobody asked for).

import { givenVSCode, installStep, quietFirstMinute, theOneInterruption } from '../lib/firstMinute.mjs';
import { story } from '../lib/story.mjs';

export default story({
  id: 'first-minute-no-folder',
  title: 'The first minute, with no folder open',
  persona: 'As someone who just found ERD Studio in the Marketplace, with no folder open',
  want: 'I want one clear next step, not a pile of pop-ups',
  soThat: 'so that I can start in seconds',
  workspace: 'empty',
  realistic: true,
  steps: async (s) => {
    await givenVSCode(s);
    await installStep(s);

    await s.step('Its walkthrough opens: the one thing that pops up', async () => {
      await theOneInterruption(s, 'walkthrough', /Get started with ERD Studio/);
      const step = s.sel.walkthroughStep('Open the folder your data model lives in');
      await s.expectVisible(step, { what: 'the walkthrough\'s "Open the folder your data model lives in" step' });
      await s.expectVisible(s.sel.walkthroughLink('Open Folder…'), { what: 'its Open Folder… button' });
      await s.wb.highlight(step);
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'Its walkthrough opens. That is the one thing that pops up.' });

    await s.step('One click on "Open Folder…" is my next step', async () => {
      await s.oneClick(() => s.wb.click(s.sel.walkthroughLink('Open Folder…')));
      const dialog = await s.ui.waitForQuickPick({ title: 'Open Folder' });
      s.expect(/Open Folder/.test(dialog.title), `VS Code's folder dialog should open: ${dialog.title}`);
      await s.pause(1800);
      await s.wb.press('Escape');
    }, { say: 'One click on Open Folder is my next step.' });

    await quietFirstMinute(s);
  },
});
