// The onboarding guide, Show Me Around, in a folder of CREATE TABLE scripts
// (as story 04): Show Me opens the draft, and because it is the first draft on
// this machine the guide's coach marks walk through it — the banner naming the
// two SQL files and the counts, More ways to start (where to import from), and
// Keep as Diagram, which the guide waits for. Keep opens the diagram, and the
// guide carries on there with the real tables: a table, a relationship, the
// toolbar, the sidebar (revealed), the files and the AI helper, and the finish,
// whose Star on GitHub asks the host to open the repository's fixed page. The
// story proves that through the host's log line; ERD_STUDIO_STORIES_NO_BROWSER
// keeps the machine's browser shut.

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const TABLES = ['dim_customer', 'dim_product', 'dim_date', 'fct_order_line'];
const FOUND = 'ERD Studio found CREATE TABLE scripts in this folder';
const STAR_URL = 'https://github.com/liam-machine/erd-studio';

/** The coach mark on show: `{ title, text, progress, buttons }`, or null. */
const MARK = `(() => { const m=doc.querySelector('.guide-mark'); if (!m) return null;
  return { title: m.querySelector('.guide-mark__title')?.textContent.trim(), text: m.querySelector('.guide-mark__text')?.textContent.trim(),
    progress: m.querySelector('.guide-mark__progress')?.textContent.trim(), side: m.getAttribute('data-side'),
    buttons: [...m.querySelectorAll('button')].map(b => b.textContent.trim()) }; })()`;
const markButton = (label) => `[...doc.querySelectorAll('.guide-mark button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;

/** Wait for the coach mark titled `title`; resolves its state. */
async function waitForMark(page, title, what = `the "${title}" coach mark`) {
  return page.waitFor(`(() => { const m=${MARK}; return m && m.title === ${JSON.stringify(title)} && m; })()`, { timeout: 20000, what });
}

export default story({
  id: 'onboarding-guide-sql',
  title: 'Show me around, with my own SQL scripts',
  persona: 'As someone whose database schema is a folder of SQL scripts, new to ERD Studio',
  want: 'I want to be shown where to click to make my first logical model, with my own tables',
  soThat: 'so that I know how to bring my data in, edit it and keep it',
  workspace: { name: 'shop-database', add: { database: 'test/fixtures/sql-ddl/postgres' } },
  // Star on GitHub is proved by the host's log line, never by opening the machine's browser.
  env: { ERD_STUDIO_STORIES_NO_BROWSER: '1' },
  steps: async (s) => {
    let draft;
    await s.step('Show Me opens the draft, and the guide starts on it: my two SQL files, my counts', async () => {
      await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      // Let the toast finish sliding in before the click (as story 04 does).
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1500);
      await s.wb.unhighlight();
      await s.ui.notificationButton(FOUND, 'Show Me');
      draft = await waitForDraft(s, 'Draft: sales', { tables: 4 });
      const mark = await waitForMark(draft.page, 'Your draft');
      s.assert.equal(mark.text, 'This is a draft of your model, drawn from 2 SQL files (PostgreSQL): 4 tables, 3 relationships. Nothing is saved yet.');
      s.assert.equal(mark.progress, '1 of 3');
      s.assert.equal(mark.side, 'below', 'the first callout points at the banner, below it');
      s.expect(mark.buttons.includes('Next') && mark.buttons.includes('Skip guide'), `its buttons: ${mark.buttons.join(', ')}`);
      s.expectNoFile('.erd-studio');
      await draft.page.highlight(`doc.querySelector('.guide-mark')`);
      await s.pause(1500);
      await s.wb.unhighlight();
    });

    await s.step('Next: where to bring a data model in from (More ways to start)', async () => {
      await draft.page.click(markButton('Next'));
      const mark = await waitForMark(draft.page, 'More ways to start');
      s.expect(mark.text.startsWith('Is your data model somewhere else? Import… reads SQL scripts, Power BI and Fabric models, and DBML.'), mark.text);
      s.expect(mark.text.includes('Bring In Your Data Model… shows how to get it out of Databricks'), mark.text);
      s.assert.equal(mark.progress, '2 of 3');
      // It points at the real menu.
      s.expect(await draft.page.ev(`!!doc.querySelector('[data-guide="draft-more"]')`), 'the More ways to start button is on the page');
      await s.pause(1200);
    });

    await s.step('Next: Keep as Diagram — the guide waits for me to press it', async () => {
      await draft.page.click(markButton('Next'));
      const mark = await waitForMark(draft.page, 'Keep it');
      s.assert.equal(mark.text, 'Keep as Diagram makes it your first logical model: one DBML file per table in .erd-studio/, ready to commit. Press it to continue.');
      s.expect(!mark.buttons.includes('Next'), `no Next on the Keep step: ${mark.buttons.join(', ')}`);
      await draft.page.click(`doc.querySelector('[data-guide="draft-keep"]')`);
      draft.page.close();
    }, { say: 'The last step on the draft waits for me to press Keep as Diagram.' });

    let canvas;
    let first;
    await s.step('The diagram opens, and the guide carries on there with one of my real tables', async () => {
      await s.ui.waitForActiveTab('sales.dbml', { timeout: 45000 });
      canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length === 4`, { what: 'four tables on the canvas' });
      first = await waitForMark(canvas, 'A table');
      s.expect(TABLES.some((t) => first.text.startsWith(`${t} is one of your 4 tables.`)), `the first step should name one of my tables: ${first.text}`);
      s.expect(first.text.includes('Click a table to change its columns, types and keys'), first.text);
      s.expect(first.side !== 'centre', 'the callout is anchored to the table');
      await s.expectFile('.erd-studio/main/diagrams/sales.dbml');
    });

    await s.step('A real relationship, then + Add and Layout', async () => {
      await canvas.click(markButton('Next'));
      const rel = await waitForMark(canvas, 'A relationship');
      s.expect(/^\w+ → \w+ \((many-to-one|one-to-one|one-to-many|many-to-many)\)\. Press and hold a column/.test(rel.text), rel.text);
      s.expect(TABLES.some((t) => rel.text.startsWith(`${t} →`)), rel.text);
      await canvas.click(markButton('Next'));
      const tools = await waitForMark(canvas, 'Add and arrange');
      s.expect(tools.text.startsWith('+ Add puts a new table'), tools.text);
      s.expect(tools.side !== 'centre', 'anchored to the toolbar');
      // No dbt here: no Logical / Physical step.
      s.expect(!/\bdbt\b/i.test(`${first.text} ${rel.text} ${tools.text}`), 'no dbt word in a folder without dbt');
    });

    await s.step('The sidebar step reveals ERD Studio on the left', async () => {
      await canvas.click(markButton('Next'));
      const side = await waitForMark(canvas, 'The ERD Studio sidebar');
      s.expect(side.text.startsWith('On the left, in ERD Studio: Diagrams lists your diagrams'), side.text);
      await s.eventually(async () => (await s.ui.sidebarText()).toUpperCase().includes('TABLE LIBRARY'), { message: 'the ERD Studio sidebar was not revealed' });
      await s.wb.highlight(s.sel.sidebar);
      await s.pause(1200);
      await s.wb.unhighlight();
    });

    await s.step('My files and my AI helper, then the finish: Star on GitHub opens the repository\'s page', async () => {
      await canvas.click(markButton('Next'));
      const files = await waitForMark(canvas, 'Your files and your AI');
      s.assert.equal(files.text, 'Your model is plain DBML in .erd-studio/ — commit it with your code. Your AI assistant can read and edit it; Set Up My AI Helper teaches it the format.');
      s.expect(files.buttons.includes('Set Up My AI Helper'), files.buttons.join(', '));
      await canvas.click(markButton('Next'));
      const finish = await waitForMark(canvas, 'One last thing');
      s.assert.equal(finish.text, "You're set up. If ERD Studio helps you, a star on GitHub helps other modellers find it.");
      s.expect(finish.buttons.includes('Star on GitHub') && finish.buttons.includes('Done'), finish.buttons.join(', '));
      await canvas.click(markButton('Star on GitHub'));
      await canvas.waitFor(`!doc.querySelector('.guide-mark')`, { what: 'the guide to close' });
      await s.eventually(() => s.erdLog().includes(`Onboarding guide: Star on GitHub opens ${STAR_URL}`), { timeout: 15000, message: `the host never asked to open ${STAR_URL}` });
      s.expect(s.erdLog().includes('Onboarding guide: finished'), 'the guide finished');
      canvas.close();
    }, { say: 'At the end, Star on GitHub opens the ERD Studio repository.' });
  },
});
