// The first 60 seconds in a project that already has DBML diagrams (a
// teammate's clone of the Kimball bus matrix example), on a machine that
// never had ERD Studio, realistic: every VS Code prompt on, ERD Studio
// installed in the window as from the Marketplace. No draft and no
// walkthrough: the one prompt names the project's diagrams and opens the
// latest in one click. Nothing else may interrupt in the first minute.

import { givenVSCode, installStep, quietFirstMinute, theOneInterruption } from '../lib/firstMinute.mjs';
import { story } from '../lib/story.mjs';

const NOTICE = 'This project has';

export default story({
  id: 'first-minute-existing-diagrams',
  title: 'The first minute, in a project with diagrams',
  persona: 'As someone who cloned a teammate\'s project that already has ERD Studio diagrams',
  want: 'I want to see them in one click',
  soThat: 'so that I can catch up on the model without a pile of pop-ups',
  workspace: { name: 'retail-warehouse', from: 'docs/examples/kimball-bus-matrix' },
  realistic: true,
  steps: async (s) => {
    await givenVSCode(s, 'retail-warehouse');
    await installStep(s);

    let open;
    await s.step('It says the project has diagrams: the one thing that pops up', async () => {
      const event = await theOneInterruption(s, 'notification', new RegExp(`^${NOTICE}`));
      s.expect(/ERD Studio diagrams?/.test(event.text), `the notice: ${event.text}`);
      const buttons = await s.wb.ev(`[...${s.sel.notification(NOTICE)}.querySelectorAll('.monaco-button')].map(b => b.textContent.trim()).filter(Boolean)`);
      open = buttons.find((b) => b.startsWith('Open '));
      s.expect(open, `the notice should offer to open a diagram: ${buttons.join(', ')}`);
      await s.wb.highlight(s.sel.notification(NOTICE));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { at: 'left' });

    await s.step('One click opens the latest diagram on the canvas', async () => {
      s.noise.expect(/\.dbml$/, { kind: 'tab', why: open });
      await s.oneClick(() => s.ui.notificationButton(NOTICE, open));
      const name = open.slice('Open '.length);
      await s.ui.waitForActiveTab(`${name}.dbml`, { timeout: 45000 });
      const canvas = await s.webview();
      await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length > 0`, { what: 'tables on the canvas' });
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
      canvas.close();
    }, { at: 'left' });

    await quietFirstMinute(s);
  },
});
