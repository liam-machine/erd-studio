// The onboarding guide, Show Me Around, the whole first-time walkthrough in a
// dbt project that has never had ERD Studio (the dbt fixture without
// .erd-studio/, as stories 07 and 19), realistic: every VS Code prompt on,
// ERD Studio installed in the window as from the Marketplace. The start
// suggestion's Show Me drafts the top-ranked models folder (gold: 2 tables,
// no relationships), and the guide starts on it. The Folder switcher moves
// the draft to silver and the guide's first step follows it (5 tables, 5
// relationships). More ways to start names Import… (no import guide in a dbt
// project), Keep as Diagram is the step that waits, and on the canvas the
// guide names a real model and relationship, then + Add and Layout, the
// Logical / Physical switch (a dbt project's own step: Physical is what dbt
// builds), the sidebar, the files and the AI helper, and the finish: Star on
// GitHub, proved by the host's log line (ERD_STUDIO_STORIES_NO_BROWSER keeps
// the browser shut). Every callout is checked to sit on the page, clear of
// what it points at.

import { DRAFT, chooseScope, waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, theOneInterruption } from '../lib/firstMinute.mjs';
import { GUIDE_TARGET, markButton, nextMark, restOnEmptyCanvas, waitForMark } from '../lib/guide.mjs';
import { story } from '../lib/story.mjs';

const FOUND = 'ERD Studio found a dbt project in this folder';
const STAR_URL = 'https://github.com/liam-machine/erd-studio';
const SILVER = ['dim_customer', 'dim_project', 'dim_task', 'fct_order', 'fct_sale'];
const stageTab = (name) => `[...doc.querySelectorAll('[data-guide="canvas-stages"] button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(name)}))`;

export default story({
  id: 'onboarding-guide-dbt',
  title: 'Show me around, in my dbt project',
  persona: 'As an analytics engineer with a dbt project, new to ERD Studio',
  want: 'I want to be shown around with my own models',
  soThat: 'so that I know how to keep my design, edit it and compare it with what dbt builds',
  workspace: { name: 'analytics', from: 'test/fixtures/dbt-project', skip: ['.erd-studio', '.claude'] },
  realistic: true,
  env: { ERD_STUDIO_STORIES_NO_BROWSER: '1' },
  steps: async (s) => {
    await givenVSCode(s, 'analytics', { say: 'Given VS Code as I use it, with my dbt project open.' });
    await installStep(s);

    await s.step('It finds my dbt project and asks once: Show Me', async () => {
      const event = await theOneInterruption(s, 'notification', new RegExp(`^${FOUND}`));
      s.assert.equal(event.text, `${FOUND}. Show its models as a diagram? Nothing is saved until you keep it.`);
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { at: 'left', say: 'ERD Studio finds my dbt project, and asks once if I want to see its models as a diagram.' });

    let draft;
    await s.step('Show Me: a draft of my gold models, and the guide starts on it (1 of 3)', async () => {
      await s.ui.notificationButton(FOUND, 'Show Me');
      draft = await waitForDraft(s, 'Draft: gold');
      const mark = await waitForMark(s, draft.page, 'Your draft', { progress: '1 of 3' });
      s.assert.equal(mark.text, 'This is a draft of your model, drawn from your dbt models in gold: 2 tables, no relationships. Nothing is saved yet.');
      s.expectNoFile('.erd-studio');
      await s.pause(1800);
    }, { say: 'I press Show Me. A draft of my gold models opens, and a short guide starts on it: 2 tables, no relationships yet. Nothing is saved.' });

    await s.step('I switch the folder to silver, and the guide follows: 5 tables, 5 relationships', async () => {
      await draft.page.highlight(DRAFT.select);
      await s.pause(800);
      await s.wb.unhighlight();
      await chooseScope(s, draft.page, 'silver');
      await draft.page.waitFor(`(${DRAFT.headline} ?? '').startsWith('Draft from your dbt models in silver') && !${DRAFT.busy} && doc.querySelectorAll('.react-flow__node').length === ${SILVER.length}`, { timeout: 45000, what: 'the silver draft' });
      await s.ui.waitForActiveTab('Draft: silver');
      const mark = await waitForMark(s, draft.page, 'Your draft', { progress: '1 of 3' });
      s.assert.equal(mark.text, 'This is a draft of your model, drawn from your dbt models in silver: 5 tables, 5 relationships. Nothing is saved yet.');
      s.expectNoFile('.erd-studio');
      await s.pause(2000);
    }, { say: 'My silver folder holds more, so I switch the draft to it. The guide follows: 5 tables and 5 relationships, from my dbt models.' });

    await s.step('2 of 3, More ways to start: Import… for a model kept somewhere else', async () => {
      const mark = await nextMark(s, draft.page, 'More ways to start', { progress: '2 of 3' });
      s.assert.equal(mark.text, 'Is your data model somewhere else? Import… reads SQL scripts, Power BI and Fabric models, and DBML.');
      await s.pause(1800);
    }, { say: 'Next. If part of my model lives somewhere else, Import reads SQL scripts, Power BI and Fabric models, and DBML.' });

    await s.step('3 of 3, Keep it: the guide waits for me to press Keep as Diagram', async () => {
      const mark = await nextMark(s, draft.page, 'Keep it', { progress: '3 of 3' });
      s.assert.equal(mark.text, 'Keep as Diagram makes it your first logical model: one DBML file per table in .erd-studio/, ready to commit. Press it to continue.');
      s.expect(!mark.buttons.includes('Next'), `no Next on the Keep step: ${mark.buttons.join(', ')}`);
      await s.pause(1800);
    }, { say: 'Next. Keep as Diagram makes it my first logical model: one DBML file per table, ready to commit. The guide waits for me to press it.' });

    let canvas;
    await s.step('Keep as Diagram: my diagram opens, and the guide names dim_project, one of my 5 tables', async () => {
      await draft.page.click(GUIDE_TARGET('draft-keep'));
      draft.page.close();
      await s.ui.waitForActiveTab('silver.dbml', { timeout: 45000 });
      canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length === ${SILVER.length}`, { what: `${SILVER.length} tables on the canvas` });
      const mark = await waitForMark(s, canvas, 'A table', { progress: '1 of 7' });
      s.assert.equal(mark.text, "dim_project is one of your 5 tables. Click a table to change its columns, types and keys, or to add a column, in the panel that opens. Double-click a column's name or type to change it in place.");
      s.expect(mark.side !== 'centre', 'the callout is anchored to the table');
      for (const m of SILVER) await s.expectFile(`.erd-studio/silver/tables/silver/${m}.dbml`);
      await s.pause(2000);
    }, { say: 'I press Keep as Diagram. My diagram opens, and the guide carries on with my own models. Dim project is one of my 5 tables. Click a table to change its columns, types and keys.' });

    await s.step('A relationship from my dbt tests: dim_task → dim_project (many-to-one)', async () => {
      const mark = await nextMark(s, canvas, 'A relationship', { progress: '2 of 7' });
      s.assert.equal(mark.text, 'dim_task → dim_project (many-to-one). Press and hold a column, then drag it onto a column of another table to add a relationship.');
      s.expect(mark.side !== 'centre', 'the callout is anchored to the line');
      await s.pause(2000);
    }, { say: 'Next, a relationship from my dbt tests: dim task to dim project, many to one. To add one, I drag a column onto a column of another table.' });

    await s.step('Add and arrange: + Add and Layout', async () => {
      const mark = await nextMark(s, canvas, 'Add and arrange', { progress: '3 of 7' });
      s.assert.equal(mark.text, '+ Add puts a new table, tables from your Table Library, a relationship or a note on the diagram. Layout arranges the tables for you (Shift+L).');
      s.expect(mark.side !== 'centre', `anchored to the toolbar, not a centred card: ${JSON.stringify(mark.ring)}`);
      await s.pause(1500);
    }, { say: 'Next. Plus Add puts a new table, a relationship or a note on the diagram. Layout arranges the tables for me.' });

    await s.step('Logical and Physical: my design, and what my dbt project builds', async () => {
      const mark = await nextMark(s, canvas, 'Logical and Physical', { progress: '4 of 7' });
      s.assert.equal(mark.text, 'Logical is your design. Physical is what your dbt project builds; switch to compare them and sync the differences.');
      s.expect(mark.side !== 'centre', 'anchored to the Logical / Physical switch');
      s.expect(await canvas.ev(`!!${stageTab('Logical')} && !!${stageTab('Physical')}`), 'the Logical and Physical tabs are on the canvas');
      await s.pause(2500);
    }, { say: 'Next, a step for dbt projects. Logical is my design. Physical is what my dbt project builds. I switch between them to compare, and sync the differences.' });

    await s.step('The ERD Studio sidebar opens on the left: Diagrams, Table Library, Relationships', async () => {
      const mark = await nextMark(s, canvas, 'The ERD Studio sidebar', { progress: '5 of 7' });
      s.assert.equal(mark.text, 'On the left, in ERD Studio: Diagrams lists your diagrams, Table Library every table, Relationships every link. Use + on Diagrams to start a diagram, a layer or an import.');
      s.assert.equal(mark.side, 'right', 'it points left, out of the canvas, at the sidebar');
      await s.eventually(async () => (await s.ui.sidebarText()).toUpperCase().includes('TABLE LIBRARY'), { message: 'the ERD Studio sidebar was not revealed' });
      await s.wb.highlight(s.sel.sidebar);
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'Next, the ERD Studio sidebar opens on the left. Diagrams lists my diagrams, Table Library every table, and Relationships every link.' });

    await s.step('My files and my AI helper: plain DBML in .erd-studio/', async () => {
      const mark = await nextMark(s, canvas, 'Your files and your AI', { progress: '6 of 7' });
      s.assert.equal(mark.text, 'Your model is plain DBML in .erd-studio/ — commit it with your code. Your AI assistant can read and edit it; Set Up My AI Helper teaches it the format.');
      s.assert.deepEqual(mark.buttons, ['Set Up My AI Helper', 'Back', 'Next', 'Skip guide']);
      await s.pause(2000);
    }, { say: 'Next. My model is plain DBML in my project, to commit beside my dbt code. My AI assistant can read and edit it, and Set Up My AI Helper teaches it the format.' });

    await s.step('One last thing: a star on GitHub, if ERD Studio helps me', async () => {
      const mark = await nextMark(s, canvas, 'One last thing', { progress: '7 of 7' });
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
