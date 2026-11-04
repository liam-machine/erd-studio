// A folder of my own, no data model yet, and the Get Started walkthrough.
// Its "New Diagram…" button is a command link with JSON arguments
// (command:erdStudio.start?[{"action":"blank","from":"walkthrough"}]): this
// story proves the argument reaches erdStudio.start from a walkthrough step.
// Without it, erdStudio.start shows its fallback quick pick ("More ways to
// start") instead of the name box, and step 4 fails. In a folder the walkthrough is
// listed once ERD Studio has started there (the sidebar, here): its `when`
// keeps VS Code from opening it on install beside the start suggestion.

import { story } from '../lib/story.mjs';

export default story({
  id: 'walkthrough-starts-a-blank-diagram',
  title: 'Start a blank diagram from the walkthrough',
  persona: 'As someone trying ERD Studio in a folder of my own',
  want: 'I want the Get Started walkthrough to start my first diagram',
  soThat: 'so that I can begin modelling without reading the docs',
  workspace: 'plain',
  // Not about the start-suggestion popup (a plain folder has none to offer; off, so it never could).
  settings: { 'erdStudio.startSuggestions': false },
  steps: async (s) => {
    await s.step('Given my project folder with no data model yet', async () => {
      s.expectNoFile('.erd-studio');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('plain'), { message: 'the plain folder did not open' });
    });

    await s.step('When I open the ERD Studio walkthrough from the Command Palette', async () => {
      // Listed once ERD Studio has started in this window (its \`when\`: never opened on install in a folder).
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(s.sel.welcomeLink('New Diagram…'), { what: 'the empty Diagrams view' });
      await s.ui.runCommand('Welcome: Open Walkthrough', 'Welcome: Open Walkthrough');
      await s.ui.waitForQuickPick();
      await s.ui.pick('Get started with ERD Studio');
    });

    await s.step('Then it offers "New Diagram…" as its first step', async () => {
      const step = s.sel.walkthroughStep('New Diagram');
      await s.expectVisible(step, { what: 'the "New Diagram" step' });
      const expanded = await s.wb.ev(`${step}.classList.contains('expanded')`);
      if (!expanded) await s.wb.click(`${step}.querySelector('.step-title')`);
      await s.expectVisible(s.sel.walkthroughLink('New Diagram…'), { what: 'the New Diagram… button' });
      // A folder with nothing to import: New Diagram… is the step's one button.
      s.assert.deepEqual(await s.wb.ev(s.sel.walkthroughButtons), ['New Diagram…'], 'New Diagram… should be the walkthrough step\'s one button');
      await s.wb.highlight(step);
      await s.pause(1500);
      await s.wb.unhighlight();
    });

    await s.step('When I click "New Diagram…", I am asked to name it', async () => {
      await s.wb.click(s.sel.walkthroughLink('New Diagram…'));
      const box = await s.ui.waitForQuickPick();
      s.expect(
        !box.title.includes('More ways to start'),
        'the walkthrough link\'s argument did not reach erdStudio.start: it showed its fallback quick pick ("More ways to start") instead of the name box',
      );
      s.assert.equal(box.title, 'New Diagram');
      s.expect(/Name the diagram/.test(box.message), `the name box should ask for a name, but says "${box.message}"`);
    });

    await s.step('When I name it "Orders"', async () => {
      await s.wb.type('Orders');
      await s.pause(600);
      await s.wb.press('Enter');
    });

    await s.step('Then the Orders diagram opens, saved as a DBML file in my project', async () => {
      await s.expectFile('.erd-studio/main/diagrams/orders.dbml');
      await s.ui.waitForActiveTab('orders.dbml');
      const canvas = await s.webview();
      await canvas.waitFor(`doc.querySelector('.react-flow')`, { what: 'the canvas' });
      await s.wb.highlight(`document.querySelector('.editor-group-container.active .editor-container')`);
      await s.pause(2000);
      await s.wb.unhighlight();
      canvas.close();
    });
  },
});
