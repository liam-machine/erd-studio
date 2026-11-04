// The onboarding guide, Show Me Around, from a VS Code window with no folder
// open (as story 15), realistic: every VS Code prompt on, ERD Studio
// installed in the window as from the Marketplace. Its walkthrough opens on
// install; its Show Me Around opens the coffee-shop example as a draft, and
// the guide starts on it: "No folder is open, so this is an example", then
// Open your folder, which waits for Open Folder…. VS Code's own folder
// dialog opens my shop database folder (CREATE TABLE scripts) in this
// window, which reloads. There the guide does not start by itself: the
// folder gets its start suggestion, Show Me draws my scripts as a draft (no
// guide on it: the guide's draft part is done) and Keep as Diagram opens the
// diagram, the first one opened since, so the guide's canvas part runs on it
// with my own tables (its progress is per machine, globalState), through to
// Star on GitHub, proved by the host's log line (ERD_STUDIO_STORIES_NO_BROWSER
// keeps the machine's browser shut). Every callout is checked to sit on the
// page, clear of what it points at.

import fs from 'node:fs';
import path from 'node:path';

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, theOneInterruption } from '../lib/firstMinute.mjs';
import { GUIDE_TARGET, markButton, nextMark, restOnEmptyCanvas, waitForMark } from '../lib/guide.mjs';
import { REPO } from '../lib/launch.mjs';
import { story } from '../lib/story.mjs';

const FOUND = 'ERD Studio found CREATE TABLE scripts in this folder';
const STAR_URL = 'https://github.com/liam-machine/erd-studio';

export default story({
  id: 'onboarding-guide-no-folder',
  title: 'Show me around, with no folder open',
  persona: 'As someone who just installed ERD Studio, with no folder open in VS Code',
  want: 'I want to be shown around, then to carry on with my own folder',
  soThat: 'so that I go from nothing to my own first logical model',
  workspace: 'empty',
  realistic: true,
  // Star on GitHub is proved by the host's log line, never by opening the machine's browser.
  env: { ERD_STUDIO_STORIES_NO_BROWSER: '1' },
  steps: async (s) => {
    // My database folder, somewhere in my home folder: not open yet.
    const folder = path.join(s.home, 'shop-database');
    fs.cpSync(path.join(REPO, 'test/fixtures/sql-ddl/postgres'), path.join(folder, 'database'), { recursive: true });

    await givenVSCode(s, undefined, { say: 'Given VS Code as I use it, with no folder open.' });
    await installStep(s);

    const AROUND = 'Watch the One-Minute Tour';
    await s.step('Its walkthrough opens, with Show Me Around', async () => {
      await theOneInterruption(s, 'walkthrough', /Get started with ERD Studio/);
      const step = s.sel.walkthroughStep(AROUND);
      await s.expectVisible(step, { what: `the walkthrough's "${AROUND}" step` });
      await s.wb.click(`${step}.querySelector('.step-title')`);
      await s.expectVisible(s.sel.walkthroughLink('Show Me Around'), { what: 'its Show Me Around link' });
      await s.wb.highlight(s.sel.walkthroughLink('Show Me Around'));
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'Its walkthrough opens. One of its steps has Show Me Around.' });

    let draft;
    await s.step('Show Me Around: an example, because no folder is open (1 of 2)', async () => {
      await s.wb.click(s.sel.walkthroughLink('Show Me Around'));
      draft = await waitForDraft(s, 'Example: Coffee shop');
      s.assert.deepEqual(draft.primary, ['Open Folder…'], 'with no folder open, Open Folder… is the draft\'s primary');
      const mark = await waitForMark(s, draft.page, 'An example', { progress: '1 of 2' });
      s.assert.equal(mark.text, 'No folder is open, so this is an example: 6 tables, 8 relationships. Nothing is saved yet.');
      s.assert.equal(mark.side, 'below', 'the first callout points at the banner, below it');
      s.expect(!fs.existsSync(path.join(folder, '.erd-studio')), 'nothing written');
      await s.pause(2000);
    }, { say: 'I press Show Me Around. With no folder open, it shows me an example as a draft: 6 tables and 8 relationships. Nothing is saved.' });

    await s.step('2 of 2, Open your folder: the guide waits for Open Folder…', async () => {
      const mark = await nextMark(s, draft.page, 'Open your folder', { progress: '2 of 2' });
      s.assert.equal(mark.text, 'Open Folder… opens the folder your data model lives in. ERD Studio draws what it finds there, and keeping it saves your first logical model as DBML files in .erd-studio/, ready to commit. Press it to continue.');
      s.expect(!mark.buttons.includes('Next'), `no Next on the Open your folder step: ${mark.buttons.join(', ')}`);
      await s.pause(2000);
    }, { say: 'Next. Open Folder opens the folder my data model lives in. ERD Studio draws what it finds there, and keeping it saves my first logical model. The guide waits for me to press it.' });

    let page;
    await s.step('Open Folder…: VS Code\'s folder dialog, and I choose my shop database folder', async () => {
      await draft.page.click(GUIDE_TARGET('draft-primary'));
      draft.page.close();
      const dialog = await s.ui.waitForQuickPick({ title: 'Open Folder' });
      s.assert.equal(dialog.value, `${s.home}/`, 'the folder dialog starts in my home folder');
      await s.ui.appendQuickInput('shop-database/');
      await s.wb.waitFor(`${s.sel.quickInputBox}?.value === ${JSON.stringify(`${folder}/`)}`, { what: 'the folder box to hold shop-database' });
      await s.pause(800);
      page = await s.wb.tagPage();
      await s.wb.press('Enter');
    }, { say: 'I press Open Folder. VS Code asks which folder, and I choose my shop database folder of SQL scripts.' });

    await s.step('The window opens my folder, and ERD Studio finds my CREATE TABLE scripts', async () => {
      // An empty window opens the folder in itself: VS Code reloads the window.
      await s.wb.waitForReload(page);
      await s.eventually(async () => (await s.ui.windowTitle()).includes('shop-database'), { message: 'the window never opened shop-database' });
      const toast = await s.ui.waitForNotification(FOUND, { timeout: 45000 });
      s.assert.equal(toast.message, `${FOUND} (4 tables). Show them as a diagram? Nothing is saved until you keep it.`);
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { at: 'left', say: 'The window opens my folder. ERD Studio finds my create table scripts, and asks if I want to see them as a diagram.' });

    await s.step('Show Me: the draft of my scripts (the guide already showed me a draft)', async () => {
      await s.ui.notificationButton(FOUND, 'Show Me');
      draft = await waitForDraft(s, 'Draft: sales', { tables: 4 });
      s.assert.equal(draft.headline, 'Draft from 2 SQL files (PostgreSQL) · 4 tables, 3 relationships · not saved');
      await s.pause(1500);
      s.expect(!(await draft.page.ev(`!!doc.querySelector('.guide-mark')`)), 'no guide on this draft: its draft part is done');
      s.expect(!fs.existsSync(path.join(folder, '.erd-studio')), 'nothing written');
      await draft.page.highlight(DRAFT.button('Keep as Diagram'));
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'I press Show Me. A draft of my own model opens: 4 tables and 3 relationships. I keep it.' });

    let canvas;
    await s.step('Keep as Diagram: my diagram opens, and the guide carries on: fct_order_line, one of my 4 tables', async () => {
      await draft.page.click(DRAFT.button('Keep as Diagram'));
      draft.page.close();
      await s.ui.waitForActiveTab('sales.dbml', { timeout: 45000 });
      canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length === 4`, { what: 'four tables on the canvas' });
      const mark = await waitForMark(s, canvas, 'A table', { progress: '1 of 6' });
      s.assert.equal(mark.text, "fct_order_line is one of your 4 tables. Click a table to change its columns, types and keys, or to add a column, in the panel that opens. Double-click a column's name or type to change it in place.");
      s.expect(mark.side !== 'centre', 'the callout is anchored to the table');
      await s.expectFile(path.join(folder, '.erd-studio/main/diagrams/sales.dbml'));
      await s.pause(2000);
    }, { say: 'I press Keep as Diagram. My first diagram opens, and the guide carries on with my own tables. Fact order line is one of my 4 tables. Click a table to change its columns, types and keys.' });

    await s.step('A relationship: fct_order_line → dim_customer (many-to-one)', async () => {
      const mark = await nextMark(s, canvas, 'A relationship', { progress: '2 of 6' });
      s.assert.equal(mark.text, 'fct_order_line → dim_customer (many-to-one). Press and hold a column, then drag it onto a column of another table to add a relationship.');
      s.expect(mark.side !== 'centre', 'the callout is anchored to the line');
      await s.pause(2000);
    }, { say: 'Next, one of my relationships: fact order line to dim customer, many to one. To add one, I drag a column onto a column of another table.' });

    await s.step('Add and arrange: + Add and Layout', async () => {
      const mark = await nextMark(s, canvas, 'Add and arrange', { progress: '3 of 6' });
      s.assert.equal(mark.text, '+ Add puts a new table, tables from your Table Library, a relationship or a note on the diagram. Layout arranges the tables for you (Shift+L).');
      s.expect(mark.side !== 'centre', 'anchored to the toolbar');
      await s.pause(1500);
    }, { say: 'Next. Plus Add puts a new table, a relationship or a note on the diagram. Layout arranges the tables for me.' });

    await s.step('The ERD Studio sidebar opens on the left: Diagrams, Table Library, Relationships', async () => {
      const mark = await nextMark(s, canvas, 'The ERD Studio sidebar', { progress: '4 of 6' });
      s.assert.equal(mark.text, 'On the left, in ERD Studio: Diagrams lists your diagrams, Table Library every table, Relationships every link. Use + on Diagrams to start a diagram, a layer or an import.');
      s.assert.equal(mark.side, 'right', 'it points left, out of the canvas, at the sidebar');
      await s.eventually(async () => (await s.ui.sidebarText()).toUpperCase().includes('TABLE LIBRARY'), { message: 'the ERD Studio sidebar was not revealed' });
      await s.wb.highlight(s.sel.sidebar);
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'Next, the ERD Studio sidebar opens on the left. Diagrams lists my diagrams, Table Library every table, and Relationships every link.' });

    await s.step('My files and my AI helper: plain DBML in .erd-studio/', async () => {
      const mark = await nextMark(s, canvas, 'Your files and your AI', { progress: '5 of 6' });
      s.assert.equal(mark.text, 'Your model is plain DBML in .erd-studio/ — commit it with your code. Your AI assistant can read and edit it; Set Up My AI Helper teaches it the format.');
      s.assert.deepEqual(mark.buttons, ['Set Up My AI Helper', 'Back', 'Next', 'Skip guide']);
      await s.pause(2000);
    }, { say: 'Next. My model is plain DBML in my project, to commit with my code. My AI assistant can read and edit it, and Set Up My AI Helper teaches it the format.' });

    await s.step('One last thing: a star on GitHub, if ERD Studio helps me', async () => {
      const mark = await nextMark(s, canvas, 'One last thing', { progress: '6 of 6' });
      s.assert.equal(mark.text, "You're set up. If ERD Studio helps you, a star on GitHub helps other modellers find it.");
      s.assert.equal(mark.side, 'centre', 'the finish is a centred card');
      s.assert.deepEqual(mark.buttons, ['Star on GitHub', 'Back', 'Done', 'Skip guide']);
      await s.pause(2000);
    }, { say: "One last thing. I'm set up. If ERD Studio helps me, a star on GitHub helps other modellers find it." });

    await s.step('Star on GitHub: it opens the ERD Studio repository, and the guide is done', async () => {
      await canvas.click(markButton('Star on GitHub'));
      await canvas.waitFor(`!doc.querySelector('.guide-mark')`, { what: 'the guide to close' });
      // The cursor left where the button was would sit on a table's column and open its hover card.
      await restOnEmptyCanvas(s, canvas);
      await s.eventually(() => s.erdLog().includes(`Onboarding guide: Star on GitHub opens ${STAR_URL}`), { timeout: 15000, message: `the host never asked to open ${STAR_URL}` });
      s.expect(s.erdLog().includes('Onboarding guide: finished'), 'the guide finished');
      // Long enough for the film to catch up with the cleared hover before the last frame is held.
      await s.pause(2500);
      canvas.close();
    }, { say: 'I press Star on GitHub. It opens the ERD Studio repository, and the guide is done.' });
  },
});
