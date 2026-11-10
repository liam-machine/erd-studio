// The onboarding guide, Show Me Around, the whole first-time walkthrough in a
// folder with nothing ERD Studio can draw from (a README), realistic: every
// VS Code prompt on, ERD Studio installed in the window as from the
// Marketplace (as story 16). Nothing pops up; the ERD Studio icon opens the
// coffee-shop example as a draft, and the guide starts on it: "Nothing here
// to draw from yet, so this is an example", then More ways to start, which
// says how to get your own data model in (Import… for SQL scripts, Power BI,
// Fabric and DBML; Bring In Your Data Model… for Databricks, Snowflake, SQL
// Server and more). The story stays on the guide's path rather than opening
// Bring In Your Data Model… (that replaces the draft, and story 27 shows it):
// Keep This Example makes it a diagram in the folder, and the guide carries
// on there with the example's tables through to Star on GitHub, proved by
// the host's log line (ERD_STUDIO_STORIES_NO_BROWSER keeps the browser shut).
// Every callout is checked to sit on the page, clear of what it points at.

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, nothingPopsUp } from '../lib/firstMinute.mjs';
import { GUIDE_TARGET, markButton, nextMark, restOnEmptyCanvas, waitForMark } from '../lib/guide.mjs';
import { story } from '../lib/story.mjs';

const STAR_URL = 'https://github.com/liam-machine/erd-studio';

export default story({
  id: 'onboarding-guide-empty-folder',
  title: 'Show me around, in an empty folder',
  persona: 'As someone who installs ERD Studio in a new folder with no data model yet',
  want: 'I want to be shown around on an example, and told how to bring my own model in',
  soThat: 'so that I know where to start',
  workspace: { name: 'new-project', add: { 'README.md': 'test/stories/workspaces/plain/README.md' } },
  realistic: true,
  env: { ERD_STUDIO_STORIES_NO_BROWSER: '1' },
  steps: async (s) => {
    await givenVSCode(s, 'new-project', { say: 'Given VS Code as I use it, with a new project folder open. It has no data model yet.' });
    await installStep(s);
    await nothingPopsUp(s, { wait: 4000, caption: 'Nothing pops up: there is nothing here to draw' });

    let draft;
    await s.step('The ERD Studio icon: an example, and the guide says why (1 of 3)', async () => {
      await s.ui.openSidebar('ERD Studio');
      draft = await waitForDraft(s, 'Example: Coffee shop');
      s.assert.deepEqual(draft.buttons, ['New Diagram…', 'Bring In Your Data Model…', 'Keep This Example', 'More ways to start', 'Discard']);
      const mark = await waitForMark(s, draft.page, 'An example', { progress: '1 of 3' });
      s.assert.equal(mark.text, 'Nothing here to draw from yet, so this is an example: 6 tables, 8 relationships. Nothing is saved yet.');
      s.expectNoFile('.erd-studio');
      await s.pause(2000);
    }, { say: 'I click the ERD Studio icon. An example opens as a draft, and a short guide starts on it. There is nothing here to draw from yet, so this is an example: 6 tables and 8 relationships. Nothing is saved.' });

    await s.step('2 of 3, More ways to start: how to bring my own data model in', async () => {
      const mark = await nextMark(s, draft.page, 'More ways to start', { progress: '2 of 3' });
      s.assert.equal(mark.text, 'Is your data model somewhere else? Import… reads SQL scripts, Power BI and Fabric models, and DBML. Bring In Your Data Model… shows how to get it out of Databricks, Snowflake, SQL Server, Fabric and more, into an open format.');
      await s.pause(1500);
      // The other start it names, beside the menu it points at.
      await draft.page.highlight(DRAFT.button('Bring In Your Data Model…'));
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'Next, how to bring my own data model in. Import reads SQL scripts, Power BI and Fabric models, and DBML. Bring In Your Data Model shows how to get it out of Databricks, Snowflake, SQL Server and more, into an open format.' });

    await s.step('3 of 3, Keep it: I keep the example, to learn on it', async () => {
      const mark = await nextMark(s, draft.page, 'Keep it', { progress: '3 of 3' });
      s.assert.equal(mark.text, 'Keep This Example makes it a diagram in this folder: one DBML file per table in .erd-studio/, ready to commit. Press it to continue.');
      s.expect(!mark.buttons.includes('Next'), `no Next on the Keep step: ${mark.buttons.join(', ')}`);
      await s.pause(1800);
    }, { say: 'Next. Keep This Example makes it a diagram in this folder, one DBML file per table. I keep it, to learn on it.' });

    let canvas;
    await s.step('Keep This Example: the diagram opens, and the guide names fct_order_items, one of 6 tables', async () => {
      await draft.page.click(GUIDE_TARGET('draft-keep'));
      draft.page.close();
      await s.ui.waitForActiveTab('coffee-shop.dbml', { timeout: 45000 });
      canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length === 6`, { what: 'six tables on the canvas' });
      const mark = await waitForMark(s, canvas, 'A table', { progress: '1 of 6' });
      s.assert.equal(mark.text, "fct_order_items is one of your 6 tables. Click a table to change its columns, types and keys, or to add a column, in the panel that opens. Double-click a column's name or type to change it in place.");
      s.expect(mark.side !== 'centre', 'the callout is anchored to the table');
      await s.expectFile('.erd-studio/main/diagrams/coffee-shop.dbml');
      await s.pause(2000);
    }, { say: 'I press Keep This Example. The diagram opens, and the guide carries on. Fact order items is one of its 6 tables. Click a table to change its columns, types and keys.' });

    await s.step('A relationship: fct_order_items → dim_customers (many-to-one)', async () => {
      const mark = await nextMark(s, canvas, 'A relationship', { progress: '2 of 6' });
      s.assert.equal(mark.text, 'fct_order_items → dim_customers (many-to-one). Press and hold a column, then drag it onto a column of another table to add a relationship.');
      s.expect(mark.side !== 'centre', 'the callout is anchored to the line');
      await s.pause(2000);
    }, { say: 'Next, a relationship: fact order items to dim customers, many to one. To add one, I drag a column onto a column of another table.' });

    await s.step('Add and arrange: + Add and Layout', async () => {
      const mark = await nextMark(s, canvas, 'Add and arrange', { progress: '3 of 6' });
      s.assert.equal(mark.text, '+ Add puts a new table, tables from your Table Library, a relationship or a note on the diagram. Layout arranges the tables for you (Shift+L).');
      s.expect(mark.side !== 'centre', 'anchored to the toolbar');
      await s.pause(1500);
    }, { say: 'Next. Plus Add puts a new table, a relationship or a note on the diagram. Layout arranges the tables for me.' });

    await s.step('The ERD Studio sidebar opens on the left: its + starts a diagram, a layer or an import', async () => {
      const mark = await nextMark(s, canvas, 'The ERD Studio sidebar', { progress: '4 of 6' });
      s.assert.equal(mark.text, 'On the left, in ERD Studio: Diagrams lists your diagrams, Table Library every table, Relationships every link. Use + on Diagrams to start a diagram, a layer or an import.');
      s.assert.equal(mark.side, 'right', 'it points left, out of the canvas, at the sidebar');
      await s.eventually(async () => (await s.ui.sidebarText()).toUpperCase().includes('TABLE LIBRARY'), { message: 'the ERD Studio sidebar was not revealed' });
      await s.wb.highlight(s.sel.sidebar);
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'Next, the ERD Studio sidebar opens on the left. Its plus, on Diagrams, starts a new diagram, a layer, or an import of my own model.' });

    await s.step('My files and my AI helper: plain DBML in .erd-studio/', async () => {
      const mark = await nextMark(s, canvas, 'Your files and your AI', { progress: '5 of 6' });
      s.assert.equal(mark.text, 'Your model is plain DBML in .erd-studio/ — commit it with your code. Your AI assistant can read and edit it; Set Up My AI Helper teaches it the format.');
      s.assert.deepEqual(mark.buttons, ['Set Up My AI Helper', 'Back', 'Next', 'Skip guide']);
      await s.pause(2000);
    }, { say: 'Next. The model is plain DBML in my project, to commit with my code. My AI assistant can read and edit it, and Set Up My AI Helper teaches it the format.' });

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
