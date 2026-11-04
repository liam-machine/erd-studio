// A big schema: eight CREATE TABLE scripts, 257 tables in eight schemas
// (test/fixtures/sql-ddl/large, copied without its generate.mjs). The start
// suggestion counts them ("…(257 tables). Create a diagram from them?"), and
// Create Diagram's one confirm stays short whatever the size: a headline with
// the counts and at most ten lines (the schemas counted, never a table
// listed). Review All… opens the Review Import tab (a webview of its own):
// every table grouped by schema in a collapsible section, every relationship,
// what is left out, and a footer whose Import answers the waiting import.
// Proves the confirm is short, the page lists all 257 tables by schema and
// every relationship, and Import on the page writes all 257 table files and
// opens the diagram, laid out (a position saved for every table: ELK's
// default node placement overflowed the webview worker's stack on this graph
// until the layout learned to fall back), with no second confirm.

import fs from 'node:fs';
import path from 'node:path';

import { sleep } from '../lib/act.mjs';
import { story } from '../lib/story.mjs';

const TABLES = 257;
const SCHEMAS = 8;
const FOUND = 'ERD Studio found CREATE TABLE scripts in this folder';
const LIST = `doc.querySelector('.cdb__list')`;
const SECTION = (id) => `doc.querySelector('.cdb-section[data-section="${id}"]')`;

/** Every `.dbml` file under `dir`, recursively. */
function dbmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? dbmlFiles(path.join(dir, e.name)) : e.name.endsWith('.dbml') ? [path.join(dir, e.name)] : []);
}

export default story({
  id: 'large-import-review',
  title: 'Review a large import before it is written',
  persona: 'As someone with a warehouse of hundreds of tables in SQL scripts',
  want: 'I want to see everything an import will create before I say yes',
  soThat: 'so that I trust what lands in my project',
  workspace: {
    name: 'company-warehouse',
    add: { warehouse: 'test/fixtures/sql-ddl/large' },
    // The fixture's generator is not part of anyone's warehouse.
    fill: (dir) => fs.rmSync(path.join(dir, 'warehouse/generate.mjs'), { force: true }),
  },
  steps: async (s) => {
    await s.step('Given I open my warehouse folder: 8 SQL scripts, 257 tables', async () => {
      s.expectNoFile('.erd-studio');
      s.expectNoFile('warehouse/generate.mjs');
      s.assert.equal(fs.readdirSync(s.path('warehouse')).filter((f) => f.endsWith('.sql')).length, 8);
      await s.eventually(async () => (await s.ui.windowTitle()).includes('company-warehouse'), { message: 'the company-warehouse folder did not open' });
      const toast = await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      s.assert.equal(toast.message, `${FOUND} (${TABLES} tables). Create a diagram from them?`);
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'Given I open my warehouse folder: eight SQL scripts, with two hundred and fifty-seven tables. ERD Studio offers to create a diagram.', at: 'left' });

    let dialog;
    let diagram;
    await s.step('I click "Create Diagram": one short message, not 257 lines', async () => {
      await s.ui.notificationButton(FOUND, 'Create Diagram');
      dialog = await s.ui.waitForDialogAskingNothingFirst();
      const m = /^Import 257 tables and (\d+) relationships from 8 SQL files \(PostgreSQL\) into a new diagram "([^"]+)" in the Main layer\.$/.exec(dialog.message);
      s.expect(m, `the confirm's headline is "${dialog.message}"`);
      diagram = m[2];
      s.assert.deepEqual([...dialog.buttons].sort(), ['Cancel', 'Change Options…', 'Import', 'Review All…'], 'the confirm\'s buttons (VS Code orders them by platform)');
      const lines = dialog.detail.split('\n').map((l) => l.trim()).filter(Boolean);
      s.expect(lines.length <= 10, `the confirm should be at most ten lines, but has ${lines.length}: ${dialog.detail}`);
      s.expect(lines[0].startsWith(`• ${TABLES} new tables by schema: sales 80,`), `the first line should count the tables by schema: ${lines[0]}`);
      s.expect(!/_t\d{3}/.test(dialog.detail), `the confirm should never list the tables: ${dialog.detail}`);
      await s.wb.highlight(s.sel.dialog);
      await s.pause(2500);
      await s.wb.unhighlight();
    }, { say: 'I click Create Diagram. It sums the import up in one short message: the tables by schema, not two hundred and fifty-seven lines.' });

    let page;
    await s.step('I want to see everything first: "Review All…" opens every table, by schema', async () => {
      await s.ui.dialogButton('Review All…');
      await s.ui.waitForActiveTab('Review Import');
      page = await s.webview();
      const sections = await page.waitFor(`(() => { const s=[...doc.querySelectorAll('.cdb-section[data-section^="schema:"]')]; return s.length === ${SCHEMAS} && s.map(x => [x.dataset.section, x.querySelectorAll('.cdb-item').length]); })()`, { what: `${SCHEMAS} schema sections on the Review Import page` });
      s.assert.equal(sections.reduce((n, [, c]) => n + c, 0), TABLES, `the schema sections should list every table: ${JSON.stringify(sections)}`);
      s.assert.equal(await page.ev(`doc.querySelector('.cdb__heading').textContent.trim()`), dialog.message, 'the page leads with the confirm\'s headline');
      s.expect(await page.ev(`doc.body.innerText.includes('finance_t002') && doc.body.innerText.includes('5 columns · primary key id · 1 foreign key')`), 'each table shows its columns and keys');
      s.assert.deepEqual(await page.ev(`[...doc.querySelectorAll('.cdb__actions .cdb__button')].map(b => b.textContent.trim())`), ['Cancel', 'Change Options…', 'Import'], 'the page\'s own buttons');
      await page.highlight(`doc.querySelector('.cdb__header')`);
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'I want to see everything first. Review All opens a page with every table, grouped by schema.' });

    await s.step('I scroll through the sales schema, then fold it away', async () => {
      for (let i = 0; i < 6; i++) {
        await page.ev(`(${LIST}.scrollBy({ top: 260, behavior: 'smooth' }), true)`);
        await sleep(s.pace.glide > 300 ? 450 : 50);
      }
      await page.ev(`(${LIST}.scrollTo({ top: 0, behavior: 'smooth' }), true)`);
      await sleep(600);
      await page.click(`${SECTION('schema:sales')}.querySelector('summary')`);
      await page.waitFor(`!${SECTION('schema:sales')}.open`, { what: 'the sales section to fold' });
      await page.highlight(`${SECTION('schema:sales')}`);
      await s.pause(1200);
      await s.wb.unhighlight();
    });

    await s.step('And every relationship, and what it leaves out', async () => {
      const rels = await page.waitFor(`${SECTION('relationships')}?.querySelectorAll('.cdb-item').length`, { what: 'the Relationships section' });
      s.expect(rels > 200, `the page should list every relationship, but lists ${rels}`);
      await page.ev(`(${SECTION('relationships')}.scrollIntoView({ block: 'start', behavior: 'smooth' }), true)`);
      await sleep(900);
      await page.highlight(`${SECTION('relationships')}.querySelector('summary')`);
      await s.pause(1500);
      await page.ev(`(${SECTION('left')}.scrollIntoView({ block: 'start', behavior: 'smooth' }), true)`);
      await sleep(900);
      const left = await page.ev(`${SECTION('left')}.innerText`);
      s.expect(/01_sales\.sql: skipped .*view/.test(left), `the page should say what is left out: ${left.slice(0, 300)}`);
      await page.highlight(SECTION('left'));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { say: 'And every relationship, and what it leaves out, like views and indexes.' });

    await s.step('When I press Import on the page, the diagram opens with all 257 tables', async () => {
      await page.click(`doc.querySelector('.cdb__actions .cdb__button[data-action="import"]')`);
      page.close();
      await s.ui.waitForActiveTab(`${diagram}.dbml`, { timeout: 60000 });
      // No second confirm: the page's Import answered it.
      s.expect(!(await s.wb.ev(`!!${s.sel.dialog}`)), 'Import on the page should not ask again');
      const canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length > 0`, { timeout: 60000, what: 'tables on the canvas' });
      await s.eventually(() => dbmlFiles(s.path('.erd-studio/main/tables')).length === TABLES, { message: `expected ${TABLES} table files under .erd-studio/main/tables/` });
      // Laid out and saved: a position for every table in the diagram file, and no "Auto layout failed".
      const file = s.path(`.erd-studio/main/diagrams/${diagram}.dbml`);
      await s.eventually(() => fs.existsSync(file) && (fs.readFileSync(file, 'utf8').match(/^\s+\w+ -?\d+ -?\d+$/gm) ?? []).length >= TABLES, { timeout: 60000, message: `the diagram file never held a position for each of the ${TABLES} tables (auto layout)` });
      const failed = await canvas.ev(`doc.body.innerText.includes('Auto layout failed')`);
      s.expect(!failed, 'the canvas says "Auto layout failed"');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
      canvas.close();
    }, { say: 'When I press Import on the page, the diagram opens, with all two hundred and fifty-seven tables saved in my project.' });
  },
});
