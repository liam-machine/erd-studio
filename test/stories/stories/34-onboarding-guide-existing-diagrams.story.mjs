// The onboarding guide, Show Me Around, in a project that already has ERD
// Studio diagrams (a teammate's clone of the Kimball bus matrix example, as
// story 21), realistic: every VS Code prompt on, ERD Studio installed in the
// window as from the Marketplace. Such a project shows no draft, so the
// guide's draft part never runs here; the one prompt is the notice "This
// project has 4 ERD Studio diagrams." and its Show Me Around button opens the
// newest diagram (retail sales: I worked on it last) with the guide's canvas
// part on it: a table (the best-connected, fct_retail_sales), one of its
// relationships, the toolbar, the sidebar (revealed), the files and the AI
// helper, and the finish, whose Star on GitHub is proved by the host's log
// line (ERD_STUDIO_STORIES_NO_BROWSER keeps the machine's browser shut).
// Every callout is checked to sit on the page, clear of what it points at.

import fs from 'node:fs';

import { givenVSCode, installStep, theOneInterruption } from '../lib/firstMinute.mjs';
import { markButton, nextMark, restOnEmptyCanvas, waitForMark } from '../lib/guide.mjs';
import { story } from '../lib/story.mjs';

const NOTICE = 'This project has';
const STAR_URL = 'https://github.com/liam-machine/erd-studio';

export default story({
  id: 'onboarding-guide-existing-diagrams',
  title: 'Show me around a project that already has diagrams',
  persona: 'As someone who cloned a teammate\'s project that already has ERD Studio diagrams',
  want: 'I want to be shown around on the team\'s own diagram',
  soThat: 'so that I can find my way around their model and change it',
  workspace: { name: 'retail-warehouse', from: 'docs/examples/kimball-bus-matrix' },
  realistic: true,
  // Star on GitHub is proved by the host's log line, never by opening the machine's browser.
  env: { ERD_STUDIO_STORIES_NO_BROWSER: '1' },
  steps: async (s) => {
    // Cloned yesterday, and retail sales is the diagram I opened and changed since: the
    // notice offers the newest one (a fresh checkout, all one age, offers the first).
    const diagrams = s.path('.erd-studio/presentation/diagrams');
    const yesterday = new Date(Date.now() - 86_400_000);
    for (const f of fs.readdirSync(diagrams)) fs.utimesSync(`${diagrams}/${f}`, yesterday, yesterday);
    fs.utimesSync(`${diagrams}/retail-sales.dbml`, new Date(), new Date());

    await givenVSCode(s, 'retail-warehouse', { say: 'Given VS Code as I use it, with a clone of my team\'s retail warehouse project open. It already has diagrams.' });
    await installStep(s);

    await s.step('It says the project has 4 diagrams, and offers Show Me Around', async () => {
      const event = await theOneInterruption(s, 'notification', new RegExp(`^${NOTICE}`));
      s.assert.equal(event.text, 'This project has 4 ERD Studio diagrams.');
      const toast = await s.ui.waitForNotification(NOTICE);
      s.assert.deepEqual(toast.buttons, ['Open retail-sales', 'Show Me Around', 'Not now'], 'the notice\'s buttons');
      await s.wb.highlight(s.sel.notificationButton(NOTICE, 'Show Me Around'));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { at: 'left', say: 'There is no draft here: the project already has diagrams. ERD Studio says so, and offers to show me around.' });

    let canvas;
    await s.step('Show Me Around: retail sales opens, and the guide names fct_retail_sales, one of its 5 tables', async () => {
      await s.ui.notificationButton(NOTICE, 'Show Me Around');
      await s.ui.waitForActiveTab('retail-sales.dbml', { timeout: 45000 });
      canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length === 5`, { what: 'five tables on the canvas' });
      const mark = await waitForMark(s, canvas, 'A table', { progress: '1 of 6' });
      s.assert.equal(mark.text, "fct_retail_sales is one of your 5 tables. Click a table to change its columns, types and keys, or to add a column, in the panel that opens. Double-click a column's name or type to change it in place.");
      s.expect(mark.side !== 'centre', 'the callout is anchored to the table');
      s.expect(s.erdLog().includes('Onboarding guide: phase B on the canvas'), 'the guide\'s canvas part started');
      s.expect(!s.erdLog().includes('Onboarding guide: phase A'), 'no draft part in a project with diagrams');
      await s.pause(2000);
    }, { say: 'I press Show Me Around. The newest diagram, retail sales, opens, and the guide starts on it. Fact retail sales is one of its 5 tables. Click a table to change its columns, types and keys.' });

    await s.step('A relationship: fct_retail_sales → dim_date (many-to-one)', async () => {
      const mark = await nextMark(s, canvas, 'A relationship', { progress: '2 of 6' });
      s.assert.equal(mark.text, 'fct_retail_sales → dim_date (many-to-one). Press and hold a column, then drag it onto a column of another table to add a relationship.');
      s.expect(mark.side !== 'centre', 'the callout is anchored to the line');
      await s.pause(2000);
    }, { say: 'Next, one of its relationships: fact retail sales to dim date, many to one. To add one, I drag a column onto a column of another table.' });

    await s.step('Add and arrange: + Add and Layout', async () => {
      const mark = await nextMark(s, canvas, 'Add and arrange', { progress: '3 of 6' });
      s.assert.equal(mark.text, '+ Add puts a new table, tables from your Table Library, a relationship or a note on the diagram. Layout arranges the tables for you (Shift+L).');
      s.expect(mark.side !== 'centre', 'anchored to the toolbar');
      await s.pause(1500);
    }, { say: 'Next. Plus Add puts a new table, tables from the Table Library, a relationship or a note on the diagram. Layout arranges the tables for me.' });

    await s.step('The ERD Studio sidebar opens on the left: the team\'s diagrams, tables and relationships', async () => {
      const mark = await nextMark(s, canvas, 'The ERD Studio sidebar', { progress: '4 of 6' });
      s.assert.equal(mark.text, 'On the left, in ERD Studio: Diagrams lists your diagrams, Table Library every table, Relationships every link. Use + on Diagrams to start a diagram, a layer or an import.');
      s.assert.equal(mark.side, 'right', 'it points left, out of the canvas, at the sidebar');
      await s.eventually(async () => (await s.ui.sidebarText()).toUpperCase().includes('TABLE LIBRARY'), { message: 'the ERD Studio sidebar was not revealed' });
      await s.wb.highlight(s.sel.sidebar);
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'Next, the ERD Studio sidebar opens on the left. Diagrams lists the team\'s 4 diagrams, Table Library every table, and Relationships every link.' });

    await s.step('The files and my AI helper: plain DBML in .erd-studio/', async () => {
      const mark = await nextMark(s, canvas, 'Your files and your AI', { progress: '5 of 6' });
      s.assert.equal(mark.text, 'Your model is plain DBML in .erd-studio/ — commit it with your code. Your AI assistant can read and edit it; Set Up My AI Helper teaches it the format.');
      s.assert.deepEqual(mark.buttons, ['Set Up My AI Helper', 'Back', 'Next', 'Skip guide']);
      await s.pause(2000);
    }, { say: 'Next. The model is plain DBML in the project, committed with the code. My AI assistant can read and edit it, and Set Up My AI Helper teaches it the format.' });

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
