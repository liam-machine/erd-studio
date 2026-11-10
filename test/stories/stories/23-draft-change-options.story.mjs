// A draft's "Change options…": the quick path answered everything for me
// (the scripts, the dialect, the layer, the name), and the link in the
// banner asks those questions again, step by step, each preselected with
// the quick path's answer. The folder holds CREATE TABLE scripts
// (test/fixtures/sql-ddl/postgres) and a project that already has two layers
// (Main and Reporting, in .erd-studio/layers.json, no diagram yet), so the
// start suggestion still offers the scripts. Show Me → "Draft: sales" in the
// Reporting layer (New Diagram's default: the last creatable layer). Change
// options… → the scripts (every one picked), the dialect (PostgreSQL first),
// the layer (Reporting first, Main picked) and the name ("Shop Orders") →
// the draft comes back as "Draft: shop-orders", saving to the Main layer,
// still nothing on disk. Keep as Diagram writes it there,
// and nothing is written under the first name or layer.

import fs from 'node:fs';
import path from 'node:path';

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const FOUND = 'ERD Studio found CREATE TABLE scripts in this folder';
const LAYERS = {
  schemaVersion: 1,
  layers: [
    { id: 'main', label: 'Main', abbreviation: 'MAIN', color: '#6366f1', creatable: true, order: 1 },
    { id: 'reporting', label: 'Reporting', abbreviation: 'RPT', color: '#d4a800', creatable: true, order: 2 },
  ],
};

export default story({
  id: 'draft-change-options',
  title: 'Change where a draft is saved before I keep it',
  persona: 'As someone importing CREATE TABLE scripts',
  want: 'I want to choose the diagram\'s name and layer myself before anything is saved',
  soThat: 'so that the quick draft lands where my project keeps it',
  workspace: {
    name: 'shop-database',
    add: { database: 'test/fixtures/sql-ddl/postgres' },
    fill: (dir) => {
      fs.mkdirSync(path.join(dir, '.erd-studio'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.erd-studio/layers.json'), `${JSON.stringify(LAYERS, null, 2)}\n`);
    },
  },
  steps: async (s) => {
    await s.step('Given my project, with two layers and SQL scripts in database/', async () => {
      await s.expectFile('database/01_tables.sql', { contains: 'CREATE TABLE sales.dim_customer' });
      await s.expectFile('.erd-studio/layers.json', { contains: '"reporting"' });
      s.expectNoFile('.erd-studio/main');
      s.expectNoFile('.erd-studio/reporting');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('shop-database'), { message: 'the shop-database folder did not open' });
    }, { say: 'Given my project, with two layers, and SQL scripts in a database folder.' });

    let draft;
    await s.step('I click "Show Me": a draft, with a name and layer chosen for me', async () => {
      await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1200);
      await s.wb.unhighlight();
      await s.ui.notificationButton(FOUND, 'Show Me');
      draft = await waitForDraft(s, 'Draft: sales', { tables: 4 });
      s.assert.equal(draft.detail, 'Keep saves it as sales in the Reporting layer (.erd-studio/reporting/diagrams/sales.dbml).');
      s.expect(draft.links.startsWith('Change options…'), `the banner's second line should start with Change options…: ${draft.links}`);
      await draft.page.highlight(`doc.querySelector('.draft-banner__detail')`);
      await s.pause(2200);
      await s.wb.unhighlight();
    }, { say: 'I click Show Me. A draft opens, saving as sales, in the Reporting layer.' });

    await s.step('I click "Change options…": the scripts it found, every one picked', async () => {
      await draft.page.highlight(DRAFT.link('Change options…'));
      await s.pause(900);
      await s.wb.unhighlight();
      await draft.page.click(DRAFT.link('Change options…'));
      const pick = await s.ui.waitForQuickPick({ title: 'Import SQL DDL' });
      s.expect(/Which scripts\?/.test(pick.placeholder), `the first question should be which scripts: ${pick.placeholder}`);
      for (const f of ['database/01_tables.sql', 'database/02_constraints.sql']) s.expect(pick.items.includes(f), `the scripts should list ${f}: ${pick.items.join(', ')}`);
      const checked = await s.wb.ev(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].filter(r => r.getAttribute('aria-checked') === 'true').map(r => r.querySelector('.label-name')?.textContent.trim())`);
      s.assert.deepEqual(checked, ['database/01_tables.sql', 'database/02_constraints.sql'], 'both scripts are picked');
      await s.wb.highlight(s.sel.quickInput);
      await s.pause(1800);
      await s.wb.unhighlight();
      await s.wb.press('Enter');
    }, { say: 'I click Change options. It lists the scripts it found, every one picked.' });

    await s.step('The dialect it read them as comes first', async () => {
      const pick = await s.ui.waitForQuickPick({ title: 'Import SQL DDL' });
      s.expect(/dialect/i.test(pick.placeholder), `the second question should be the dialect: ${pick.placeholder}`);
      s.expect(pick.items[0].startsWith('PostgreSQL'), `PostgreSQL should come first: ${pick.items.join(', ')}`);
      await s.wb.highlight(s.sel.quickPickRow(pick.items[0]));
      await s.pause(1500);
      await s.wb.unhighlight();
      await s.wb.press('Enter');
    });

    await s.step('I choose the Main layer instead', async () => {
      const pick = await s.ui.waitForQuickPick({ title: 'Import' });
      s.expect(/Which layer/.test(pick.placeholder), `the next question should be the layer: ${pick.placeholder}`);
      s.assert.deepEqual([...pick.items].sort(), ['Main', 'Reporting'], 'the layers on offer');
      s.assert.equal(pick.items[0], 'Reporting', 'the layer the draft used comes first');
      await s.pause(800);
      await s.ui.pick('Main');
    });

    await s.step('And I name it "Shop Orders"', async () => {
      const box = await s.ui.waitForQuickPick();
      s.expect(/Name the diagram\. It is saved in the Main layer\./.test(box.message), `the name box: ${box.message}`);
      s.assert.equal(box.value, 'sales', 'the name box starts with the draft\'s name');
      await s.ui.setQuickInput('Shop Orders');
      await s.pause(700);
      await s.wb.press('Enter');
    });

    await s.step('The draft comes back under the new name, saving to Main; nothing is saved yet', async () => {
      draft.page.close();
      draft = await waitForDraft(s, 'Draft: shop-orders', { tables: 4 });
      s.assert.equal(draft.detail, 'Keep saves it as shop-orders in the Main layer (.erd-studio/main/diagrams/shop-orders.dbml).');
      s.assert.equal(draft.headline, 'Draft from 2 SQL files (PostgreSQL) · 4 tables, 3 relationships · not saved');
      s.expectNoFile('.erd-studio/main');
      s.expectNoFile('.erd-studio/reporting');
      await draft.page.highlight(DRAFT.banner);
      await s.pause(2500);
      await s.wb.unhighlight();
    }, { say: 'The draft comes back as shop orders, saving to the Main layer. Nothing is saved yet.' });

    await s.step('When I press "Keep as Diagram", it is saved in the Main layer as shop-orders', async () => {
      await draft.page.click(DRAFT.button('Keep as Diagram'));
      draft.page.close();
      await s.ui.waitForActiveTab('shop-orders.dbml', { timeout: 45000 });
      const canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length === 4 && doc.querySelectorAll('.react-flow__edge').length === 3`, { what: 'four tables and three relationships on the canvas' });
      await s.expectFile('.erd-studio/main/diagrams/shop-orders.dbml', { contains: "use * from '../relationships/main.dbml'" });
      await s.expectFile('.erd-studio/main/tables/sales/fct_order_line.dbml', { contains: /^Table sales\.fct_order_line\b/m });
      s.expectNoFile('.erd-studio/reporting');
      s.expectNoFile('.erd-studio/main/diagrams/sales.dbml');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2200);
      await s.wb.unhighlight();
      canvas.close();
    }, { say: 'When I press Keep as Diagram, it is saved in the Main layer, as shop orders.' });
  },
});
