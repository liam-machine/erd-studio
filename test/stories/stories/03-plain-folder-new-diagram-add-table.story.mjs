// A folder of my own with nothing in it yet: the Diagrams view's own
// "New Diagram" button, the name box, then the empty canvas's "New Table"
// card. Proves the whole first-five-minutes path of a logical-only user ends
// with a table on the canvas and its own .dbml file under
// .erd-studio/main/tables/ (the file the user commits), and that the diagram
// file lists it. Without dbt, so no dbt word or control may appear on the way.

import { story } from '../lib/story.mjs';

/** An Explorer row by its label (and tree depth: the workspace folder's children are level 1). */
const ROW = (label, level) => `[...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').replace(/\\s+/g, '') === ${JSON.stringify(label)}${level ? ` && r.getAttribute('aria-level') === '${level}'` : ''})`;

export default story({
  id: 'plain-folder-new-diagram-add-table',
  title: 'Start a diagram and add a first table',
  persona: 'As someone with an empty project folder and no data model yet',
  want: 'I want to start a diagram and add my first table by hand',
  soThat: 'so that my design lives as files next to my code',
  workspace: { name: 'orders-app', add: { 'README.md': 'test/stories/workspaces/plain/README.md' } },
  steps: async (s) => {
    await s.step('Given my project folder with no data model yet', async () => {
      s.expectNoFile('.erd-studio');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('orders-app'), { message: 'the orders-app folder did not open' });
    });

    await s.step('When I open the ERD Studio sidebar, it offers "New Diagram"', async () => {
      await s.ui.openSidebar('ERD Studio');
      const button = s.sel.welcomeLink('New Diagram');
      await s.expectVisible(button, { what: 'the New Diagram button in the empty Diagrams view' });
      // One obvious start: New Diagram is the one button; Get started, the example and Import… are links.
      s.assert.deepEqual(await s.wb.ev(s.sel.welcomeButtons), ['New Diagram'], 'New Diagram should be the one button in the empty Diagrams view');
      await s.expectVisible(s.sel.welcomeLink('Get started'), { what: 'the "Get started" link' });
      const text = await s.ui.sidebarText();
      s.expect(!/\bdbt\b/i.test(text), `a folder without dbt_project.yml must show no dbt word, but the sidebar says: ${text}`);
      await s.wb.highlight(button);
      await s.pause(1200);
      await s.wb.unhighlight();
    });

    await s.step('When I click "New Diagram", I am asked to name it', async () => {
      await s.wb.click(s.sel.welcomeLink('New Diagram'));
      const box = await s.ui.waitForQuickPick({ title: 'New Diagram' });
      s.expect(/Name the diagram/.test(box.message), `the name box should ask for a name, but says "${box.message}"`);
    });

    await s.step('I name it "Orders"', async () => {
      await s.wb.type('Orders');
      await s.pause(700);
      await s.wb.press('Enter');
    });

    let canvas;
    await s.step('Then the empty Orders diagram opens, with a "New Table" button', async () => {
      await s.expectFile('.erd-studio/main/diagrams/orders.dbml');
      await s.ui.waitForActiveTab('orders.dbml');
      canvas = await s.webview();
      await canvas.waitFor(`doc.querySelector('.empty-canvas__card')`, { what: 'the "This diagram is empty" card' });
      const card = await canvas.ev(`doc.querySelector('.empty-canvas__card').innerText`);
      s.expect(card.includes('This diagram is empty'), `the empty canvas card says: ${card}`);
      s.expect(!/\bdbt\b/i.test(card), `the empty canvas card must not mention dbt in a folder without it: ${card}`);
      await canvas.highlight(`doc.querySelector('.empty-canvas__card')`);
      await s.pause(1500);
      await s.wb.unhighlight();
    });

    const newTable = `[...doc.querySelectorAll('.empty-canvas__button')].find(b => b.textContent.trim() === 'New Table')`;
    await s.step('When I click "New Table" and call it "customer"', async () => {
      await canvas.click(newTable);
      await canvas.waitFor(`doc.querySelector('.new-model-dialog #modelName')`, { what: 'the New Table dialog' });
      await canvas.fill(`doc.querySelector('#modelName')`, 'customer');
      const preview = await canvas.waitFor(`(doc.querySelector('.new-model-dialog__path')?.textContent ?? '').includes('customer.dbml') && doc.querySelector('.new-model-dialog__path').textContent`, { what: 'the path the table will be saved at' });
      s.expect(preview.includes('.erd-studio/main/tables/'), `the dialog should say where the file goes, but says "${preview}"`);
      await canvas.fill(`doc.querySelector('#description')`, 'One row per customer');
    });

    await s.step('And give it a first column, customer_id', async () => {
      await canvas.click(`[...doc.querySelectorAll('.new-model-dialog button')].find(b => b.textContent.trim() === '+ Add Column')`);
      await canvas.waitFor(`doc.querySelector('.new-model-dialog__col-input--name')`, { what: 'a column row' });
      await canvas.fill(`doc.querySelector('.new-model-dialog__col-input--name')`, 'customer_id');
      await s.pause(800);
      await canvas.click(`[...doc.querySelectorAll('.new-model-dialog button')].find(b => b.textContent.trim() === 'Create Table')`);
    });

    await s.step('Then the customer table is on the canvas', async () => {
      const node = await canvas.waitFor(`[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText).find(t => t.startsWith('customer'))`, { what: 'the customer table on the canvas' });
      s.expect(node.includes('customer_id'), `the table on the canvas should show customer_id, but shows: ${node}`);
      await canvas.highlight(`doc.querySelector('.react-flow__node')`);
      await s.pause(1500);
      await s.wb.unhighlight();
    });

    await s.step('And it is its own file under .erd-studio/main/tables/', async () => {
      await s.expectFile('.erd-studio/main/tables/main/customer.dbml', { contains: /Table main\.customer \{[\s\S]*customer_id/ });
      await s.expectFile('.erd-studio/main/tables/main/customer.dbml', { contains: "Note: 'One row per customer'" });
      await s.expectFile('.erd-studio/main/diagrams/orders.dbml', { contains: "use { table main.customer } from '../tables/main/customer.dbml'" });
      canvas.close();
      await s.ui.openSidebar('Explorer');
      // .erd-studio / main / tables / main / customer.dbml (the second main is the table's
      // schema folder; the Explorer shows it compacted as "tables/main" once it knows it is alone).
      for (const [folder, level] of [['.erd-studio', 1], ['main', 2], ['tables', 3]]) {
        await s.wb.waitFor(ROW(folder, level), { what: `the ${folder} folder in the Explorer` });
        const open = await s.wb.ev(`${ROW(folder, level)}.getAttribute('aria-expanded') === 'true'`);
        if (!open) await s.wb.click(ROW(folder, level));
      }
      const file = ROW('customer.dbml');
      await s.eventually(async () => {
        if (await s.wb.ev(`!!${file}`)) return true;
        // Not compacted: the schema folder is its own row, still closed.
        if (await s.wb.ev(`${ROW('main', 4)}?.getAttribute('aria-expanded') === 'false'`)) await s.wb.click(ROW('main', 4));
        return false;
      }, { message: 'customer.dbml never showed under .erd-studio/main/tables/ in the Explorer' });
      await s.expectVisible(file, { what: 'customer.dbml in the Explorer' });
      await s.wb.highlight(file);
      await s.pause(2500);
      await s.wb.unhighlight();
    });
  },
});
