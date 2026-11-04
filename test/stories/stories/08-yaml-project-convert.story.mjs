// A project from before 2.0: tables as YAML (.erd-studio/tables/customer.yml)
// and a JSON diagram (.erd-studio/gold/sales.json). Opening it, the one
// prompt offers Convert first ("This project has 1 ERD Studio diagram, from an
// older ERD Studio", Convert to DBML… then Open sales), and the Diagrams view
// leads with a "Convert to DBML…" row above its layers (its empty-view Convert
// entry is gone once there are diagrams). The row opens the Convert panel:
// what will be written and removed, nothing on disk yet. Its Convert button
// sits bottom-left, so the opening notice (bottom-right, left on screen here
// on purpose) never covers it. Proves Convert writes the DBML table and
// diagram, removes the YAML and JSON, and the converted diagram opens with its
// table, so the project keeps working.

import { story } from '../lib/story.mjs';

export default story({
  id: 'yaml-project-convert',
  title: 'Move an older project to DBML',
  persona: 'As someone whose project was made with an ERD Studio before 2.0',
  want: 'I want to convert its YAML and JSON files to DBML',
  soThat: 'so that my model is in an open format and my diagrams keep working',
  workspace: 'yaml-project',
  steps: async (s) => {
    const NOTICE = 'from an older ERD Studio';
    await s.step('Given my project from an older ERD Studio: it offers to convert it to DBML', async () => {
      await s.expectFile('.erd-studio/tables/customer.yml');
      await s.expectFile('.erd-studio/gold/sales.json');
      s.expectNoFile('.erd-studio/gold/diagrams');
      // The window's one prompt leads with Convert, the diagram second.
      const notice = s.sel.notification(NOTICE);
      await s.expectVisible(notice, { what: 'the opening notice offering Convert', timeout: 30000 });
      const text = await s.wb.ev(`${notice}.querySelector('.notification-list-item-message').textContent`);
      s.expect(text.startsWith('This project has 1 ERD Studio diagram, from an older ERD Studio.') && text.includes('DBML, an open format'), `the notice says: ${text}`);
      const buttons = await s.wb.ev(`[...${notice}.querySelectorAll('.monaco-button')].map(b => b.textContent.trim()).filter(Boolean)`);
      s.assert.deepEqual(buttons, ['Convert to DBML…', 'Open sales'], 'the notice should lead with Convert');
      await s.wb.highlight(notice);
      await s.pause(1800);
      await s.wb.unhighlight();
    });

    const ROW = s.sel.sidebarRow('Convert to DBML…');
    await s.step('And the ERD Studio sidebar leads with "Convert to DBML…"', async () => {
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(ROW, { what: 'the Convert to DBML… row in the Diagrams view' });
      await s.expectVisible(s.sel.sidebarRow('sales'), { what: 'the sales diagram in the Diagrams view' });
      const rows = await s.wb.ev(`[...document.querySelectorAll('.part.sidebar .pane-body .monaco-list-row')].filter(r => r.offsetParent).map(r => (r.querySelector('.label-name')?.textContent ?? '').trim())`);
      s.assert.equal(rows[0], 'Convert to DBML…', `the Diagrams view's first row should be Convert, but the rows are: ${rows.join(' | ')}`);
      await s.wb.highlight(ROW);
      await s.pause(1800);
      await s.wb.unhighlight();
    });

    let panel;
    await s.step('When I click it, it shows what will change first', async () => {
      await s.wb.click(ROW);
      await s.ui.waitForActiveTab('Convert to DBML');
      panel = await s.webview();
      const text = await panel.waitFor(`doc.body.innerText.includes('Convert this project to DBML?') && doc.body.innerText`, { what: 'the Convert panel' });
      s.expect(text.includes('1 table and 1 diagram convert to DBML.'), `the panel should sum up the change: ${text.slice(0, 300)}`);
      for (const f of ['.erd-studio/gold/tables/public/customer.dbml', '.erd-studio/gold/diagrams/sales.dbml', '.erd-studio/tables/customer.yml', '.erd-studio/gold/sales.json']) {
        s.expect(text.includes(f), `the panel should list ${f}`);
      }
      s.expectNoFile('.erd-studio/gold/diagrams/sales.dbml');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(3000);
      await s.wb.unhighlight();
    });

    await s.step('When I press Convert, my diagram opens again, now as DBML', async () => {
      // Bottom-left: the opening notice, if it is still on screen, stacks bottom-right
      // and must not be what this click lands on.
      const convert = `[...doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Convert')`;
      const button = await panel.rect(convert);
      const notice = await s.wb.ev(`(() => { const n=${s.sel.notification(NOTICE)}; if(!n) return null; const r=n.getBoundingClientRect(); return {x:r.left,y:r.top,width:r.width,height:r.height}; })()`);
      if (notice) {
        const overlaps = button.x < notice.x + notice.width && notice.x < button.x + button.width && button.y < notice.y + notice.height && notice.y < button.y + button.height;
        s.expect(!overlaps, 'the opening notice covers the Convert panel\'s Convert button');
      }
      await panel.click(convert);
      panel.close();
      await s.ui.waitForActiveTab('sales.dbml');
      const canvas = await s.webview();
      const node = await canvas.waitFor(`[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText).find(t => t.includes('customer'))`, { what: 'the customer table on the canvas' });
      s.expect(node.includes('customer_name'), `the converted table should keep its columns: ${node}`);
      await s.eventually(async () => (await s.ui.notifications()).some((n) => n.startsWith('Converted to DBML: 1 table, 1 diagram.')), { message: 'no "Converted to DBML" message' });
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
      canvas.close();
    });

    await s.step('And the YAML and JSON files are now DBML files', async () => {
      await s.expectFile('.erd-studio/gold/tables/public/customer.dbml', { contains: /^Table public\.customer\b[\s\S]*customer_name/m });
      await s.expectFile('.erd-studio/gold/diagrams/sales.dbml', { contains: "use { table public.customer } from '../tables/public/customer.dbml'" });
      s.expectNoFile('.erd-studio/tables/customer.yml');
      s.expectNoFile('.erd-studio/gold/sales.json');
      await s.expectVisible(s.sel.sidebarRow('sales'), { what: 'the sales diagram in the Diagrams view' });
      await s.wb.highlight(s.sel.sidebarRow('sales'));
      await s.pause(2000);
      await s.wb.unhighlight();
    });
  },
});
