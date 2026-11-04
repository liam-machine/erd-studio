// The first 60 seconds in a project made with an ERD Studio before 2.0
// (YAML tables, a JSON diagram), on a machine that never had ERD Studio,
// realistic: every VS Code prompt on, ERD Studio installed in the window as
// from the Marketplace. There is no draft here: the one prompt is the
// opening notice, Convert to DBML… first. One click opens the Convert panel
// (what will change, nothing written yet). Nothing else may interrupt in the
// first minute.

import { givenVSCode, installStep, quietFirstMinute, theOneInterruption } from '../lib/firstMinute.mjs';
import { story } from '../lib/story.mjs';

const NOTICE = 'from an older ERD Studio';

export default story({
  id: 'first-minute-pre-2-0-project',
  title: 'The first minute, in a project from before 2.0',
  persona: 'As someone opening a project a teammate made with an older ERD Studio',
  want: 'I want to be told once what to do with it',
  soThat: 'so that the project keeps working without a pile of pop-ups',
  workspace: 'yaml-project',
  realistic: true,
  steps: async (s) => {
    await givenVSCode(s, 'yaml-project', { caption: 'Given VS Code as I use it, with an older ERD Studio project open' });
    await installStep(s);

    await s.step('It offers to convert the project to DBML: the one thing that pops up', async () => {
      const event = await theOneInterruption(s, 'notification', new RegExp(NOTICE));
      s.expect(event.text.startsWith('This project has 1 ERD Studio diagram, from an older ERD Studio.'), `the notice: ${event.text}`);
      const buttons = await s.wb.ev(`[...${s.sel.notification(NOTICE)}.querySelectorAll('.monaco-button')].map(b => b.textContent.trim()).filter(Boolean)`);
      s.assert.equal(buttons[0], 'Convert to DBML…', 'the notice leads with Convert');
      await s.wb.highlight(s.sel.notification(NOTICE));
      await s.pause(1800);
      await s.wb.unhighlight();
    }, { at: 'left' });

    await s.step('One click on "Convert to DBML…": what will change, before anything does', async () => {
      s.noise.expect(/^Convert to DBML$/, { kind: 'tab', why: 'Convert to DBML…' });
      s.noise.expect(/^Convert Project to DBML: /, { kind: 'notification', why: 'Convert to DBML… (its progress)' });
      await s.oneClick(() => s.ui.notificationButton(NOTICE, 'Convert to DBML…'));
      await s.ui.waitForActiveTab('Convert to DBML');
      const panel = await s.webview();
      await panel.waitFor(`doc.body.innerText.includes('Convert this project to DBML?')`, { what: 'the Convert panel' });
      s.expectNoFile('.erd-studio/gold/diagrams/sales.dbml');
      await s.wb.highlight(s.sel.activeEditor);
      await s.pause(2500);
      await s.wb.unhighlight();
      panel.close();
    }, { say: 'One click on Convert to DBML: it shows what will change, before anything does.', at: 'left' });

    await quietFirstMinute(s);
  },
});
