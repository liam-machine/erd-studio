// A big schema: eight CREATE TABLE scripts, 257 tables in eight schemas
// (test/fixtures/sql-ddl/large, copied without its generate.mjs). The start
// suggestion counts them ("…(257 tables). Show them as a diagram? …"), and
// Show Me opens a large draft (Draft-first §2.3): the schema panel open
// (All tables (257), then each schema with its count), the canvas on the
// biggest schema only ("Showing sales: 80 of 257 tables"), a click on another
// schema redraws it; Show details lists every table by schema, every
// relationship and what is left out. Nothing is written until Keep, which
// keeps every table (the panel is a view only): 257 table files, and the
// diagram opens laid out (a position saved for every table: ELK's default
// node placement overflowed the webview worker's stack on this graph until
// the layout learned to fall back), with no second confirm.

import fs from 'node:fs';
import path from 'node:path';

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const TABLES = 257;
const SCHEMAS = 8;
const FOUND = 'ERD Studio found CREATE TABLE scripts in this folder';

/** Every `.dbml` file under `dir`, recursively. */
function dbmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? dbmlFiles(path.join(dir, e.name)) : e.name.endsWith('.dbml') ? [path.join(dir, e.name)] : []);
}

export default story({
  id: 'large-import-review',
  title: 'Look through a large import before it is written',
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
      s.assert.equal(toast.message, `${FOUND} (${TABLES} tables). Show them as a diagram? Nothing is saved until you keep it.`);
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'Given I open my warehouse folder: eight SQL scripts, with two hundred and fifty-seven tables. ERD Studio offers to show them as a diagram.', at: 'left' });

    let draft;
    let diagram;
    await s.step('I click "Show Me": a draft opens on my biggest schema, the others listed beside it', async () => {
      await s.ui.notificationButton(FOUND, 'Show Me');
      await s.eventually(async () => (await s.ui.tabs()).some((t) => t.active && t.label.startsWith('Draft: ')), { timeout: 60000, message: 'no draft tab opened' });
      const tab = (await s.ui.tabs()).find((t) => t.active).label;
      diagram = tab.slice('Draft: '.length);
      draft = await waitForDraft(s, tab, { timeout: 90000 });
      const m = /^Draft from 8 SQL files \(PostgreSQL\) · 257 tables, ([\d,]+) relationships · not saved$/.exec(draft.headline);
      s.expect(m, `the headline: ${draft.headline}`);
      // A large draft: the schema panel open, the canvas on the biggest schema only.
      await draft.page.waitFor(DRAFT.schemas, { what: 'the schema panel' });
      s.assert.equal(await draft.page.ev(DRAFT.showing), 'Showing sales: 80 of 257 tables');
      const items = await draft.page.ev(DRAFT.schemaItems);
      s.assert.equal(items[0], 'All tables (257)');
      s.assert.equal(items.length, SCHEMAS + 1, `All tables, then a row per schema: ${items.join(' | ')}`);
      s.assert.equal(draft.tables.length, 80, 'the canvas draws the sales schema\'s 80 tables');
      s.expectNoFile('.erd-studio');
      await draft.page.highlight(DRAFT.schemas);
      await s.pause(2500);
      await s.wb.unhighlight();
    }, { say: 'I click Show Me. A draft opens on my biggest schema, sales, with every schema listed beside it. Nothing is saved yet.' });

    await s.step('I look at the finance schema', async () => {
      await draft.page.click(DRAFT.schemaItem('finance'));
      await draft.page.waitFor(`${DRAFT.showing}.startsWith('Showing finance:') && !${DRAFT.busy} && doc.querySelectorAll('.react-flow__node').length > 0`, { timeout: 45000, what: 'the finance schema drawn' });
      const names = await draft.page.ev(DRAFT.tables);
      s.expect(names.every((n) => /finance/.test(n)), `only finance tables should be drawn: ${names.slice(0, 8).join(', ')}`);
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2000);
      await s.wb.unhighlight();
    });

    await s.step('"Show details" lists every table by schema, every relationship, and what it leaves out', async () => {
      await draft.page.click(DRAFT.link('Show details'));
      await draft.page.waitFor(DRAFT.drawer, { what: 'the details drawer' });
      const titles = await draft.page.ev(DRAFT.drawerSections);
      s.expect(titles.some((t) => /^Relationships/.test(t)), `the details should list the relationships: ${titles.join(' | ')}`);
      const text = await draft.page.ev(`${DRAFT.drawer}.innerText`);
      s.expect(text.includes('finance_t002'), 'the details should list each table');
      s.expect(/view/i.test(text), `the details should say the views are left out: ${text.slice(-600)}`);
      await draft.page.highlight(DRAFT.drawer);
      await s.pause(2500);
      await s.wb.unhighlight();
    }, { say: 'Show details lists every table by schema, every relationship, and what it leaves out, like views.' });

    await s.step('When I press "Keep as Diagram", the diagram opens: all 257 tables are kept', async () => {
      await draft.page.click(DRAFT.button('Keep as Diagram'));
      draft.page.close();
      await s.ui.waitForActiveTab(`${diagram}.dbml`, { timeout: 90000 });
      s.expect(!(await s.wb.ev(`!!${s.sel.dialog}`)), 'Keep should not ask again');
      const canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length > 0`, { timeout: 60000, what: 'tables on the canvas' });
      await s.eventually(() => dbmlFiles(s.path('.erd-studio/main/tables')).length === TABLES, { message: `expected ${TABLES} table files under .erd-studio/main/tables/` });
      // Laid out and saved: a position for every table in the diagram file, and no layout failure toast
      // (#294: a timeout also saves the grid, so the positions alone would not catch it).
      const file = s.path(`.erd-studio/main/diagrams/${diagram}.dbml`);
      await s.eventually(() => fs.existsSync(file) && (fs.readFileSync(file, 'utf8').match(/^\s+\w+ -?\d+ -?\d+$/gm) ?? []).length >= TABLES, { timeout: 60000, message: `the diagram file never held a position for each of the ${TABLES} tables (auto layout)` });
      const failed = await canvas.ev(`/too large to arrange automatically|couldn't arrange this diagram/.test(doc.body.innerText)`);
      s.expect(!failed, 'the canvas says Auto Layout could not arrange the diagram');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
      canvas.close();
    }, { say: 'When I press Keep as Diagram, the diagram opens, with all two hundred and fifty-seven tables saved in my project.' });
  },
});
