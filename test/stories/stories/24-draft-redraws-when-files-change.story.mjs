// A draft never saves a stale picture of the project. The folder holds
// CREATE TABLE scripts (test/fixtures/sql-ddl/postgres); Show Me opens
// "Draft: sales", four new tables. While it is open, something outside ERD
// Studio (here: my AI assistant, or a git pull) writes a table into the
// project's .erd-studio/ folder: dim_customer, with a loyalty_tier column the
// scripts do not have. The draft does not change under me, but Keep checks
// first: the project changed since the draft was planned (Draft-first §5.1,
// staleness, `generation()`), so it plans again, and the plan is another
// one now (dim_customer is already in the project, so it is reused, not
// created). Keep does not save; the draft is redrawn with the notice "Your
// files changed, so the draft was redrawn. Check it and keep it again." and
// dim_customer drawn as the project has it (loyalty_tier shows). Keep again
// saves: the diagram uses the project's dim_customer, whose file still has
// loyalty_tier (the scripts did not overwrite it), and the other three
// tables are new files.
//
// What it watches is the project's ERD Studio folder, not the scripts: an
// edit to a .sql file while the draft is open is not picked up (the draft
// is the scripts as they were read when it opened).

import fs from 'node:fs';
import path from 'node:path';

import { DRAFT, draftState, waitForDraft } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const FOUND = 'ERD Studio found CREATE TABLE scripts in this folder';
const TEAMMATE_TABLE = `Table sales.dim_customer {
  customer_id integer [pk]
  customer_name text [not null]
  email varchar(255) [unique]
  loyalty_tier varchar(20) [note: 'Bronze, silver or gold']
  created_at timestamptz [not null]
}
`;
const NODE_TEXT = (name) => `([...doc.querySelectorAll('.react-flow__node')].find(n => n.innerText.split('\\n')[0].trim().endsWith(${JSON.stringify(name)}))?.innerText ?? '')`;
const NODE = (name) => `[...doc.querySelectorAll('.react-flow__node')].find(n => n.innerText.split('\\n')[0].trim().endsWith(${JSON.stringify(name)}))`;

export default story({
  id: 'draft-redraws-when-files-change',
  title: 'A draft is redrawn when my project changes',
  persona: 'As someone whose AI assistant also edits my data model',
  want: 'I want Keep to save what my project holds now, not what it held when the draft opened',
  soThat: 'so that a draft never overwrites a newer change',
  workspace: { name: 'shop-database', add: { database: 'test/fixtures/sql-ddl/postgres' } },
  steps: async (s) => {
    let draft;
    await s.step('Given a draft of my SQL scripts, four new tables, nothing saved', async () => {
      await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1200);
      await s.wb.unhighlight();
      await s.ui.notificationButton(FOUND, 'Show Me');
      draft = await waitForDraft(s, 'Draft: sales', { tables: 4 });
      s.assert.equal(draft.headline, 'Draft from 2 SQL files (PostgreSQL) · 4 tables, 3 relationships · not saved');
      s.assert.equal(draft.notice, '', 'no notice yet');
      const customer = await draft.page.ev(NODE_TEXT('dim_customer'));
      s.expect(!customer.includes('loyalty_tier'), `the scripts have no loyalty_tier: ${customer}`);
      s.expectNoFile('.erd-studio');
      await draft.page.highlight(NODE('dim_customer'));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { say: 'Given a draft of my SQL scripts: four new tables, and nothing saved.' });

    const tableFile = s.path('.erd-studio/main/tables/sales/dim_customer.dbml');
    await s.step('Meanwhile my assistant adds dim_customer to the project, with a new column', async () => {
      // An outside write (not ERD Studio's own), as an assistant or a git pull makes it.
      fs.mkdirSync(path.dirname(tableFile), { recursive: true });
      fs.writeFileSync(tableFile, TEAMMATE_TABLE);
      await s.expectFile(tableFile, { contains: 'loyalty_tier' });
      // The watcher sees it (its batch settles) before I press Keep.
      await s.pause(2500);
    }, { say: 'Meanwhile, my AI assistant saves the customer table into my project, with a new loyalty tier column.' });

    await s.step('When I press "Keep as Diagram", the draft is redrawn instead, and says why', async () => {
      await draft.page.click(DRAFT.button('Keep as Diagram'));
      await draft.page.waitFor(`${DRAFT.notice} === 'Your files changed, so the draft was redrawn. Check it and keep it again.' && !${DRAFT.busy}`, { timeout: 30000, what: 'the redrawn notice' });
      const state = await draftState(draft.page);
      s.assert.equal(state.notice, 'Your files changed, so the draft was redrawn. Check it and keep it again.');
      s.expect(state.primary.includes('Keep as Diagram'), `Keep as Diagram is still the primary: ${state.primary.join(', ')}`);
      // Nothing was saved by that Keep: only the assistant's table is on disk.
      s.expectNoFile('.erd-studio/main/diagrams');
      s.expectNoFile('.erd-studio/main/tables/sales/fct_order_line.dbml');
      await draft.page.highlight(`doc.querySelector('.draft-banner__notice')`);
      await s.pause(2500);
      await s.wb.unhighlight();
    }, { say: 'When I press Keep as Diagram, it does not save. The draft is redrawn, and says my files changed.' });

    await s.step('The redrawn draft shows dim_customer as my project has it now', async () => {
      const customer = await draft.page.waitFor(`(() => { const t=${NODE_TEXT('dim_customer')}; return t.includes('loyalty_tier') && t; })()`, { what: 'loyalty_tier in dim_customer' });
      s.expect(customer.includes('5 columns'), `dim_customer should have its five columns: ${customer}`);
      const state = await draftState(draft.page);
      s.assert.equal(state.detail, 'Keep saves it as sales in the Main layer (.erd-studio/main/diagrams/sales.dbml). 1 table is already in your Table Library and is used as it is.');
      s.assert.equal(state.tables.length, 4, 'still four tables');
      await draft.page.highlight(NODE('dim_customer'));
      await s.pause(2500);
      await s.wb.unhighlight();
    }, { say: 'The redrawn draft uses the customer table my project has now, loyalty tier and all.' });

    await s.step('I keep it again: saved, and the new column is kept', async () => {
      await draft.page.click(DRAFT.button('Keep as Diagram'));
      draft.page.close();
      await s.ui.waitForActiveTab('sales.dbml', { timeout: 45000 });
      const canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length === 4`, { what: 'four tables on the canvas' });
      await s.expectFile('.erd-studio/main/diagrams/sales.dbml');
      await s.expectFile(tableFile, { contains: "loyalty_tier varchar(20) [note: 'Bronze, silver or gold']" });
      for (const t of ['dim_product', 'dim_date', 'fct_order_line']) await s.expectFile(`.erd-studio/main/tables/sales/${t}.dbml`, { contains: new RegExp(`^Table sales\\.${t}\\b`, 'm') });
      const customer = await canvas.waitFor(`(() => { const n=${NODE('dim_customer')}; return n && n.innerText.includes('loyalty_tier') && n.innerText; })()`, { what: 'loyalty_tier on the canvas' });
      s.expect(customer.includes('loyalty_tier'), 'the canvas shows loyalty_tier');
      await canvas.highlight(NODE('dim_customer'));
      await s.pause(2500);
      await s.wb.unhighlight();
      canvas.close();
    }, { say: 'I keep it again. It is saved, and the new column is kept.' });
  },
});
