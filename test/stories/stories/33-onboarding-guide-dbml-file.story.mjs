// The onboarding guide, Show Me Around, the whole first-time walkthrough in a
// folder with a single-file DBML export from dbdiagram.io (as story 06),
// realistic: every VS Code prompt on, ERD Studio installed in the window as
// from the Marketplace. The start suggestion's Show Me opens the draft of the
// file, and because it is the first draft on this machine the guide walks
// through it: the banner naming the file and the counts, More ways to start,
// and Keep as Diagram, which the guide waits for. Keep splits the file into
// one DBML file per table and opens the diagram, and the guide carries on
// there with the file's own tables (the best-connected, users, and one of its
// relationships), the toolbar, the sidebar (revealed), the files and the AI
// helper, and the finish, whose Star on GitHub is proved by the host's log
// line (ERD_STUDIO_STORIES_NO_BROWSER keeps the machine's browser shut).
// Every callout is checked to sit on the page, clear of what it points at.

import { waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, theOneInterruption } from '../lib/firstMinute.mjs';
import { GUIDE_TARGET, markButton, nextMark, restOnEmptyCanvas, waitForMark } from '../lib/guide.mjs';
import { story } from '../lib/story.mjs';

const FOUND = 'ERD Studio found a DBML file in this folder';
const STAR_URL = 'https://github.com/liam-machine/erd-studio';

export default story({
  id: 'onboarding-guide-dbml-file',
  title: 'Show me around, with my DBML file',
  say: 'Show me around, with my DBML file from dbdiagram dot io.', // --narrate's line for the title card
  persona: 'As someone who drew my schema on dbdiagram.io, new to ERD Studio',
  want: 'I want to be shown where to click, with the tables from my DBML file',
  soThat: 'so that my diagram lives in Git next to my code, and I know how to change it',
  workspace: { name: 'online-shop', add: { 'ecommerce.dbml': 'test/fixtures/dbml/foreign/ecommerce.dbml' } },
  realistic: true,
  // Star on GitHub is proved by the host's log line, never by opening the machine's browser.
  env: { ERD_STUDIO_STORIES_NO_BROWSER: '1' },
  steps: async (s) => {
    await givenVSCode(s, 'online-shop', { say: 'Given VS Code as I use it, with my online shop folder open. It has my DBML file from dbdiagram dot io.' });
    await installStep(s);

    await s.step('It finds my DBML file and asks once: Show Me', async () => {
      const event = await theOneInterruption(s, 'notification', new RegExp(`^${FOUND}`));
      s.assert.equal(event.text, `${FOUND}. Show it as a diagram? Nothing is saved until you keep it.`);
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { at: 'left', say: 'ERD Studio finds my DBML file, and asks once if I want to see it as a diagram.' });

    let draft;
    await s.step('Show Me: the draft of my file, and the guide starts on it (1 of 3)', async () => {
      await s.ui.notificationButton(FOUND, 'Show Me');
      draft = await waitForDraft(s, 'Draft: ecommerce', { tables: 6 });
      const mark = await waitForMark(s, draft.page, 'Your draft', { progress: '1 of 3' });
      s.assert.equal(mark.text, 'This is a draft of your model, drawn from ecommerce.dbml: 6 tables, 6 relationships. Nothing is saved yet.');
      s.assert.equal(mark.side, 'below', 'the first callout points at the banner, below it');
      s.assert.deepEqual(mark.buttons, ['Next', 'Skip guide']);
      s.expectNoFile('.erd-studio');
      await s.pause(2000);
    }, { say: 'I press Show Me. A draft of my file opens, and a short guide starts on it: 6 tables and 6 relationships. Nothing is saved yet.' });

    await s.step('2 of 3, More ways to start: Import… and Bring In Your Data Model…', async () => {
      const mark = await nextMark(s, draft.page, 'More ways to start', { progress: '2 of 3' });
      s.assert.equal(mark.text, 'Is your data model somewhere else? Import… reads SQL scripts, Power BI and Fabric models, and DBML. Bring In Your Data Model… shows how to get it out of Databricks, Snowflake, SQL Server, Fabric and more, into an open format.');
      s.expect(await draft.page.ev(`!!${GUIDE_TARGET('draft-more')}`), 'the More ways to start button is on the page');
      await s.pause(2000);
    }, { say: 'Next. If my data model lives somewhere else, Import reads SQL scripts, Power BI and Fabric models, and DBML. Bring In Your Data Model shows how to get it out of Databricks, Snowflake, SQL Server and more.' });

    await s.step('3 of 3, Keep it: the guide waits for me to press Keep as Diagram', async () => {
      const mark = await nextMark(s, draft.page, 'Keep it', { progress: '3 of 3' });
      s.assert.equal(mark.text, 'Keep as Diagram makes it your first logical model: one DBML file per table in .erd-studio/, ready to commit. Press it to continue.');
      s.expect(!mark.buttons.includes('Next'), `no Next on the Keep step: ${mark.buttons.join(', ')}`);
      await s.pause(2000);
    }, { say: 'Next. Keep as Diagram makes it my first logical model: one DBML file per table, ready to commit. The guide waits for me to press it.' });

    let canvas;
    await s.step('Keep as Diagram: my diagram opens, and the guide names users, one of my 6 tables', async () => {
      await draft.page.click(GUIDE_TARGET('draft-keep'));
      draft.page.close();
      await s.ui.waitForActiveTab('ecommerce.dbml', { timeout: 45000 });
      canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length === 6`, { what: 'six tables on the canvas' });
      const mark = await waitForMark(s, canvas, 'A table', { progress: '1 of 6' });
      s.assert.equal(mark.text, "users is one of your 6 tables. Click a table to change its columns, types and keys, or to add a column, in the panel that opens. Double-click a column's name or type to change it in place.");
      s.expect(mark.side !== 'centre', 'the callout is anchored to the table');
      await s.expectFile('.erd-studio/main/diagrams/ecommerce.dbml');
      await s.expectFile('.erd-studio/main/tables/main/users.dbml');
      await s.pause(2000);
    }, { say: 'I press Keep as Diagram. Each table becomes its own DBML file, my diagram opens, and the guide carries on with my own tables. Users is one of my 6 tables. Click a table to change its columns, types and keys.' });

    await s.step('A relationship: users → countries (many-to-one)', async () => {
      const mark = await nextMark(s, canvas, 'A relationship', { progress: '2 of 6' });
      s.assert.equal(mark.text, 'users → countries (many-to-one). Press and hold a column, then drag it onto a column of another table to add a relationship.');
      s.expect(mark.side !== 'centre', 'the callout is anchored to the line');
      await s.pause(2000);
    }, { say: 'Next, one of my relationships: users to countries, many to one, as in my file. To add one, I drag a column onto a column of another table.' });

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
