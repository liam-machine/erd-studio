// A service whose schema is a folder of Flyway migrations
// (src/main/resources/db/migration/V1__create.sql, V2__add_columns.sql, from
// test/fixtures/sql-ddl/flyway). V1 creates customer, product and orders;
// V2 renames customer.email to email_address, adds customer.loyalty_tier and
// orders.product_id, and a foreign key from that added column to product.
// The start suggestion finds the scripts (V2 has no CREATE TABLE but changes
// the tables V1 creates, so it is taken too), and Show Me draws the schema as
// it is after every migration, in file order: email_address (no email),
// loyalty_tier, product_id, and both relationships (the inline one from V1,
// and the one to the column V2 added). Keep writes the final columns.

import fs from 'node:fs';

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { story } from '../lib/story.mjs';

const FOUND = 'ERD Studio found CREATE TABLE scripts in this folder';
const MIGRATIONS = 'src/main/resources/db/migration';
const NODE = (name) => `[...doc.querySelectorAll('.react-flow__node')].find(n => n.innerText.split('\\n')[0].trim().split('.').pop() === ${JSON.stringify(name)})`;
const TEXT = (name) => `(${NODE(name)}?.innerText ?? '')`;

export default story({
  id: 'migrations-applied',
  title: 'See my schema after every migration',
  persona: 'As a developer whose schema lives in Flyway migrations',
  want: 'I want the diagram to show my tables as they are after the last migration',
  soThat: 'so that renamed and added columns, and their relationships, are right',
  workspace: { name: 'orders-service', add: { [MIGRATIONS]: 'test/fixtures/sql-ddl/flyway' } },
  steps: async (s) => {
    await s.step('Given my service, with two Flyway migrations', async () => {
      await s.expectFile(`${MIGRATIONS}/V1__create.sql`, { contains: 'CREATE TABLE customer' });
      await s.expectFile(`${MIGRATIONS}/V2__add_columns.sql`, { contains: 'RENAME COLUMN email TO email_address' });
      s.expectNoFile('.erd-studio');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('orders-service'), { message: 'the orders-service folder did not open' });
    }, { say: 'Given my service, with two Flyway migrations. The second renames a column, adds columns, and a foreign key.' });

    await s.step('ERD Studio finds the migrations and offers to show them as a diagram', async () => {
      const toast = await s.ui.waitForNotification(FOUND, { timeout: 30000 });
      s.assert.equal(toast.message, `${FOUND} (3 tables). Show them as a diagram? Nothing is saved until you keep it.`);
      await s.wb.highlight(s.sel.notification(FOUND));
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { at: 'left' });

    let draft;
    await s.step('I click "Show Me": both migrations, read in order', async () => {
      await s.ui.notificationButton(FOUND, 'Show Me');
      draft = await waitForDraft(s, 'Draft: orders-service', { tables: 3 });
      s.expect(/^Draft from 2 SQL files \(PostgreSQL\) · 3 tables, 2 relationships · not saved$/.test(draft.headline), `the headline: ${draft.headline}`);
      s.assert.equal(draft.edges, 2, 'two relationship lines');
      s.assert.equal(draft.detail, 'Keep saves it as orders-service in the Main layer (.erd-studio/main/diagrams/orders-service.dbml).');
      s.expectNoFile('.erd-studio');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(1500);
      await s.wb.unhighlight();
    }, { say: 'I click Show Me. The draft reads both migrations, in order: three tables, two relationships.', at: 'left' });

    await s.step('customer has email_address, not email, and the added loyalty_tier', async () => {
      const text = await draft.page.ev(TEXT('customer'));
      const lines = text.split('\n').map((l) => l.trim());
      s.expect(lines.includes('email_address'), `customer should have email_address: ${lines.join(' | ')}`);
      s.expect(!lines.includes('email'), `customer should no longer have email: ${lines.join(' | ')}`);
      s.expect(lines.includes('loyalty_tier'), `customer should have loyalty_tier: ${lines.join(' | ')}`);
      await draft.page.highlight(NODE('customer'));
      await s.pause(2500);
      await s.wb.unhighlight();
    }, { say: 'The customer table has the renamed email address column, and the added loyalty tier.' });

    await s.step('orders has the added product_id, joined to product', async () => {
      const lines = (await draft.page.ev(TEXT('orders'))).split('\n').map((l) => l.trim());
      s.expect(lines.includes('product_id'), `orders should have product_id: ${lines.join(' | ')}`);
      // Both foreign keys are marked: customer_id (V1, inline) and product_id (V2, on the added column).
      s.assert.equal(lines.filter((l) => l === 'FK').length, 2, `orders should have two foreign keys: ${lines.join(' | ')}`);
      await draft.page.highlight(NODE('orders'));
      await s.pause(2500);
      await s.wb.unhighlight();
    }, { say: 'And orders has the added product column, with its relationship to product.' });

    await s.step('When I keep it, the saved tables have the final columns', async () => {
      await draft.page.click(DRAFT.button('Keep as Diagram'));
      draft.page.close();
      await s.ui.waitForActiveTab('orders-service.dbml', { timeout: 45000 });
      const canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length === 3 && doc.querySelectorAll('.react-flow__edge').length === 2`, { what: 'three tables and two relationships on the canvas' });
      await s.expectFile('.erd-studio/main/tables/main/customer.dbml', { contains: /^\s+email_address\s+TEXT\b/m });
      await s.expectFile('.erd-studio/main/tables/main/customer.dbml', { contains: /^\s+loyalty_tier\b/m });
      s.expect(!/^\s+email\s/m.test(fs.readFileSync(s.path('.erd-studio/main/tables/main/customer.dbml'), 'utf8')), 'the saved customer has no email column');
      await s.expectFile('.erd-studio/main/tables/main/orders.dbml', { contains: /^\s+product_id\s+INTEGER\b/m });
      const rel = '.erd-studio/main/relationships/main.dbml';
      await s.expectFile(rel, { contains: 'Ref: main.orders.customer_id >? main.customer.customer_id' });
      await s.expectFile(rel, { contains: 'Ref: main.orders.product_id >? main.product.product_id' });
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2000);
      await s.wb.unhighlight();
      canvas.close();
    }, { say: 'When I keep it, the saved tables have the final columns and both relationships.' });
  },
});
