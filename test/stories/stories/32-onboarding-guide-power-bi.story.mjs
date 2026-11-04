// The onboarding guide, Show Me Around, the whole first-time walkthrough in a
// Power BI project saved as PBIP (the semantic model as TMDL files, as story
// 18), realistic: every VS Code prompt on, ERD Studio installed in the window
// as from the Marketplace. The start suggestion's Show Me opens the draft of
// the semantic model, and because it is the first draft on this machine the
// guide walks through it: the banner naming the model and the counts, More
// ways to start (where else a data model can come from), and Keep as Diagram,
// which the guide waits for. Keep opens the diagram, and the guide carries on
// there with the model's own tables (the best-connected, sales, and one of
// its relationships), the toolbar, the sidebar (revealed), the files and the
// AI helper, and the finish, whose Star on GitHub is proved by the host's log
// line (ERD_STUDIO_STORIES_NO_BROWSER keeps the machine's browser shut).
// Every callout is checked to sit on the page, clear of what it points at.

import { waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, theOneInterruption } from '../lib/firstMinute.mjs';
import { GUIDE_TARGET, markButton, nextMark, restOnEmptyCanvas, waitForMark } from '../lib/guide.mjs';
import { story } from '../lib/story.mjs';

const FOUND = 'ERD Studio found a Power BI or Fabric semantic model in this folder';
const STAR_URL = 'https://github.com/liam-machine/erd-studio';

export default story({
  id: 'onboarding-guide-power-bi',
  title: 'Show me around, with my Power BI model',
  persona: 'As a Power BI developer with my report saved as a PBIP project, new to ERD Studio',
  want: 'I want to be shown where to click, with my own semantic model\'s tables',
  soThat: 'so that I can keep my model as a logical design in Git and change it',
  workspace: { name: 'adventure-sales', from: 'test/fixtures/semantic-model/pbip-tmdl' },
  realistic: true,
  // Star on GitHub is proved by the host's log line, never by opening the machine's browser.
  env: { ERD_STUDIO_STORIES_NO_BROWSER: '1' },
  steps: async (s) => {
    await givenVSCode(s, 'adventure-sales', { say: 'Given VS Code as I use it, with my Power BI project open, saved as PBIP.' });
    await installStep(s);

    await s.step('It finds my semantic model and asks once: Show Me', async () => {
      const event = await theOneInterruption(s, 'notification', new RegExp(`^${FOUND}`));
      s.assert.equal(event.text, `${FOUND}. Show it as a diagram? Nothing is saved until you keep it.`);
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { at: 'left', say: 'ERD Studio finds my semantic model, and asks once if I want to see it as a diagram.' });

    let draft;
    await s.step('Show Me: the draft of my model, and the guide starts on it (1 of 3)', async () => {
      await s.ui.notificationButton(FOUND, 'Show Me');
      draft = await waitForDraft(s, 'Draft: adventure-sales', { tables: 4 });
      const mark = await waitForMark(s, draft.page, 'Your draft', { progress: '1 of 3' });
      s.assert.equal(mark.text, 'This is a draft of your model, drawn from the semantic model AdventureSales: 4 tables, 4 relationships. Nothing is saved yet.');
      s.assert.equal(mark.side, 'below', 'the first callout points at the banner, below it');
      s.assert.deepEqual(mark.buttons, ['Next', 'Skip guide']);
      s.expectNoFile('.erd-studio');
      await s.pause(2000);
    }, { say: 'I press Show Me. A draft of my semantic model opens, and a short guide starts on it: 4 tables and 4 relationships. Nothing is saved yet.' });

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
    await s.step('Keep as Diagram: my diagram opens, and the guide names sales, one of my 4 tables', async () => {
      await draft.page.click(GUIDE_TARGET('draft-keep'));
      draft.page.close();
      await s.ui.waitForActiveTab('adventure-sales.dbml', { timeout: 45000 });
      canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length === 4`, { what: 'four tables on the canvas' });
      const mark = await waitForMark(s, canvas, 'A table', { progress: '1 of 6' });
      s.assert.equal(mark.text, "sales is one of your 4 tables. Click a table to change its columns, types and keys, or to add a column, in the panel that opens. Double-click a column's name or type to change it in place.");
      s.expect(mark.side !== 'centre', 'the callout is anchored to the table');
      await s.expectFile('.erd-studio/main/diagrams/adventure-sales.dbml');
      await s.pause(2000);
    }, { say: 'I press Keep as Diagram. My diagram opens, and the guide carries on with my own tables. Sales is one of my 4 tables. Click a table to change its columns, types and keys.' });

    await s.step('A relationship: sales → customer (many-to-one)', async () => {
      const mark = await nextMark(s, canvas, 'A relationship', { progress: '2 of 6' });
      s.assert.equal(mark.text, 'sales → customer (many-to-one). Press and hold a column, then drag it onto a column of another table to add a relationship.');
      s.expect(mark.side !== 'centre', 'the callout is anchored to the line');
      await s.pause(2000);
    }, { say: 'Next, one of my relationships: sales to customer, many to one, as in my semantic model. To add one, I drag a column onto a column of another table.' });

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
    }, { say: 'Next. My model is plain DBML in my project, to commit beside the report. My AI assistant can read and edit it, and Set Up My AI Helper teaches it the format.' });

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
