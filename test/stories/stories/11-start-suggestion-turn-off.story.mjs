// The start suggestion, turned off for one folder and back on. A folder of
// CREATE TABLE scripts gets the popup ("ERD Studio found CREATE TABLE
// scripts in this folder (4 tables). Show them as a diagram? Nothing is saved
// until you keep it.");
// "Don't Ask Again for This Folder" answers in one line, with Undo ("Start
// suggestions are off for this folder."). Proves the choice
// sticks (a reloaded window shows no popup, though the folder still suggests
// the import in the sidebar), that the palette then offers Turn On and not
// Turn Off (the erdStudio.startSuggestionsOff context key), and that Turn On
// really turns it back on: the next window shows the popup again. Nothing is
// written into the folder (workspace state only).

import { sleep } from '../lib/act.mjs';
import { story } from '../lib/story.mjs';

const FOUND = 'ERD Studio found CREATE TABLE scripts in this folder';
const OFF = 'Start suggestions are off for this folder.';
const TURN_ON = 'ERD Studio: Turn On Start Suggestions for This Folder';
const TURN_OFF = 'ERD Studio: Turn Off Start Suggestions for This Folder';

export default story({
  id: 'start-suggestion-turn-off',
  title: 'Turn off the start suggestion for a folder',
  persona: 'As someone who opens a folder of SQL scripts often',
  want: 'I want to stop ERD Studio offering to import them, and know how to undo it',
  soThat: 'so that it does not ask every time, yet I can get the offer back',
  workspace: { name: 'shop-database', add: { database: 'test/fixtures/sql-ddl/postgres' } },
  steps: async (s) => {
    await s.step('Given I open my folder of SQL scripts, ERD Studio offers to show them as a diagram', async () => {
      await s.eventually(async () => (await s.ui.windowTitle()).includes('shop-database'), { message: 'the shop-database folder did not open' });
      const toast = await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      s.assert.deepEqual(toast.buttons, ['Show Me', "Don't Ask Again for This Folder"], 'the suggestion\'s buttons');
      await s.wb.highlight(s.sel.notificationButton(FOUND, "Don't Ask Again for This Folder"));
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'Given I open my folder of SQL scripts. ERD Studio offers to show them as a diagram.', at: 'left' });

    await s.step('I click "Don\'t Ask Again for This Folder": it says so, with Undo', async () => {
      await s.ui.notificationButton(FOUND, "Don't Ask Again for This Folder");
      const toast = await s.ui.waitForNotification(OFF);
      s.assert.equal(toast.message, OFF);
      s.assert.deepEqual(toast.buttons, ['Undo'], 'the confirmation offers Undo');
      await s.wb.highlight(s.sel.notification(OFF));
      await s.pause(2500);
      await s.wb.unhighlight();
      s.expectNoFile('.erd-studio');
      s.expectNoFile('.vscode');
    }, { say: "I click Don't Ask Again for This Folder. It says so in one line, with Undo.", at: 'left' });

    await s.step('When I reload the window, it does not ask again', async () => {
      await s.ui.reloadWindow();
      // The folder still suggests the import (the sidebar says what it holds, under Import Your Data Model…): only the popup is off.
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(s.sel.welcomeLink('Import Your Data Model…'), { what: 'the sidebar\'s "Import Your Data Model…" button' });
      // The look at the folder has finished: the empty view names what it found.
      await s.eventually(async () => (await s.ui.sidebarText()).includes('This folder has CREATE TABLE scripts.'), { message: 'the sidebar never said the folder has CREATE TABLE scripts' });
      // The popup comes right after that look; give it time to (wrongly) show.
      await sleep(3000);
      const toasts = await s.ui.notifications();
      s.expect(!toasts.some((t) => t.includes(FOUND)), `the popup came back after Don't Ask Again: ${toasts.join(' | ')}`);
      await s.wb.highlight(s.sel.sidebar);
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'When I reload the window, it does not ask again. The sidebar still offers the import, if I want it.' });

    await s.step('The Command Palette offers "Turn On Start Suggestions for This Folder"', async () => {
      const items = await s.ui.paletteItems('Start Suggestions', { expect: TURN_ON });
      s.expect(items.includes(TURN_ON), `the palette should offer ${TURN_ON}: ${items.join(' | ')}`);
      s.expect(!items.includes(TURN_OFF), `the palette should not offer ${TURN_OFF} while they are off: ${items.join(' | ')}`);
      await s.wb.highlight(s.sel.quickPickRow(TURN_ON));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { say: 'The Command Palette offers to turn start suggestions back on for this folder.' });

    await s.step('I run it: suggestions are on again', async () => {
      await s.wb.click(s.sel.quickPickRow(TURN_ON));
      const toast = await s.ui.waitForNotification('Start suggestions are on for this folder');
      s.expect(toast.message.startsWith('Start suggestions are on for this folder'), `the confirmation says: ${toast.message}`);
      await s.wb.highlight(s.sel.notification('Start suggestions are on for this folder'));
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { at: 'left' });

    await s.step('And the next time the folder opens, the offer is back', async () => {
      await s.ui.reloadWindow();
      const toast = await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      s.assert.equal(toast.message, `${FOUND} (4 tables). Show them as a diagram? Nothing is saved until you keep it.`);
      const items = await s.ui.paletteItems('Start Suggestions', { expect: TURN_OFF });
      s.expect(!items.includes(TURN_ON), `with suggestions on, the palette should not offer ${TURN_ON}: ${items.join(' | ')}`);
      await s.wb.press('Escape');
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { at: 'left' });
  },
});
