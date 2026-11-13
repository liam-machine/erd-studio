// Verification of the fix (reporter-feedback-3, stage 2). Usage, after npm run build:
//   node test/stories/repro/reporter3-verify-fix.mjs <evidence dir>
// Launches an isolated VS Code (fresh /tmp profile, --use-mock-keychain via launch.mjs): in a real isolated VS Code, on a /tmp copy of
// test/fixtures/dbt-project-dbml:
//   1. the Table Library row's inline + (Add to Open Diagram) adds dim_location to the open showcase, no pick
//   2. the + on dim_date (already on showcase) says so on the canvas, writes nothing
//   3. dim_date dragged onto the Diagrams row "showcase" says it is already there, on the canvas
//   4. dim_location dragged onto the Diagrams row "ttt" adds it (the 2.0.4 bug)
import fs from 'node:fs';
import path from 'node:path';

import { REPO, launchVSCode, stageExtension, shortTempDir, killByProfile } from '../lib/launch.mjs';
import { Workbench, Webview, sleep } from '../lib/act.mjs';
import { VSCodeUI, sel } from '../lib/vscode.mjs';

const out = process.argv[2] ?? fs.mkdtempSync('/tmp/g3vf-out-');
fs.mkdirSync(out, { recursive: true });
const root = shortTempDir('g3vf-');
const log = [];
const note = (what, data) => { const l = { what, ...(data ?? {}) }; log.push(l); console.log(JSON.stringify(l)); };
const extDir = stageExtension(path.join(root, 'ext'));
const proj = path.join(root, 'proj');
fs.cpSync(path.join(REPO, 'test/fixtures/dbt-project-dbml'), proj, { recursive: true });
const showcase = path.join(proj, '.erd-studio/silver/diagrams/showcase.dbml');
const ttt = path.join(proj, '.erd-studio/silver/diagrams/ttt.dbml');

const vs = await launchVSCode({ extDir, folder: proj, root, logFile: path.join(root, 'code.log'),
  settings: { 'workbench.editor.enablePreview': false, 'erdStudio.checkKnownFixes': false } });
const wb = new Workbench({ port: vs.port, pace: { glide: 0, settle: 150 }, home: vs.home });
const ui = new VSCodeUI(wb);
let n = 0;
const shot = async (name) => { const f = path.join(out, `${String(++n).padStart(2, '0')}-${name}.jpg`); await wb.screenshot(f); note('screenshot', { file: f }); };
const pane = (re) => `[...document.querySelectorAll('.part.sidebar .pane')].find(p => ${re}.test(p.querySelector('.pane-header')?.textContent ?? ''))`;
const libRow = (name) => `[...(${pane('/TABLE LIBRARY/i')}).querySelectorAll('.monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(name)})`;
const diagRow = (name) => `[...(${pane('/^\\s*DIAGRAMS/i')}).querySelectorAll('.monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(name)})`;
const statusText = () => wb.ev(`[...document.querySelectorAll('.statusbar-item')].map(s => s.textContent.trim()).filter(t => /ERD Studio: Added/.test(t))`);
const notifications = () => wb.ev(`[...document.querySelectorAll('.notification-list-item-message')].map(n => n.textContent.trim())`);

try {
  await ui.openSidebar('ERD Studio');
  await wb.click(sel.commandCenter);
  await ui.waitForQuickPick();
  await wb.type('showcase.dbml');
  await sleep(1200);
  await wb.press('Enter');
  const canvas = await Webview.find(wb, { timeout: 60000 });
  await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length >= 6`, { timeout: 60000, what: 'showcase tables' });
  await sleep(1500);
  const notices = () => canvas.ev(`[...doc.querySelectorAll('[role=status], [role=alert]')].map(n => n.textContent.trim()).filter(Boolean)`);
  for (let i = 0; i < 6; i++) {
    const k = await wb.ev(`(() => { let k=0; const v=${pane('/TABLE LIBRARY/i')}; if (!v) return -1; for (const r of v.querySelectorAll('.monaco-list-row[aria-expanded="false"]')) { r.querySelector('.monaco-tl-twistie')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); k++; } return k; })()`);
    if (k === 0) break;
    await sleep(500);
  }

  // 1. inline + on dim_location
  // Focus the sidebar row first (as a person hovering it would): the active tab stays showcase.
  await wb.hover(libRow('dim_location'));
  await sleep(400);
  const actions = await wb.ev(`[...(${libRow('dim_location')}).querySelectorAll('.action-label')].map(a => a.getAttribute('aria-label'))`);
  note('row actions', { actions });
  await shot('plus-on-row');
  const before1 = fs.readFileSync(showcase, 'utf8');
  await wb.click(`(${libRow('dim_location')}).querySelector('.action-label[aria-label="Add to Open Diagram"]')`);
  await sleep(2500);
  const after1 = fs.readFileSync(showcase, 'utf8');
  note('1. + on dim_location', { added: !before1.includes('dim_location') && after1.includes('dim_location'), status: await statusText(),
    quickPickOpen: await wb.ev(`!!document.querySelector('.quick-input-widget:not([style*="display: none"])')`), nodes: await canvas.ev(`doc.querySelectorAll('.react-flow__node').length`) });
  await shot('plus-added');

  // 2. inline + on dim_date (already there)
  await sleep(6500); // let the status message go
  await wb.hover(libRow('dim_date'));
  await sleep(300);
  const before2 = fs.readFileSync(showcase, 'utf8');
  await wb.click(`(${libRow('dim_date')}).querySelector('.action-label[aria-label="Add to Open Diagram"]')`);
  await sleep(1500);
  note('2. + on dim_date (already there)', { unchanged: before2 === fs.readFileSync(showcase, 'utf8'), canvasNotices: await notices(), notifications: await notifications(), status: await statusText() });
  await shot('plus-already');

  // Drags on the Diagrams rows (caught with Input.setInterceptDrags and replayed: a drop inside the workbench).
  const dragOnto = async (table, row) => {
    const from = await wb.center(libRow(table));
    await wb.send('Input.setInterceptDrags', { enabled: true });
    const c = await wb.client();
    const got = new Promise((res) => { const off = c.on('Input.dragIntercepted', (p) => { off(); res(p.data); }); });
    await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await wb.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) { await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 4, y: from.y + i, button: 'left', buttons: 1 }); await sleep(30); }
    const data = await Promise.race([got, sleep(5000).then(() => null)]);
    if (!data) throw new Error('drag never started');
    const to = await wb.center(diagRow(row));
    await wb.send('Input.dispatchDragEvent', { type: 'dragEnter', x: to.x, y: to.y, data });
    for (let i = 0; i < 5; i++) { await wb.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x + (i % 2), y: to.y, data }); await sleep(60); }
    await wb.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
    await wb.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    await wb.send('Input.setInterceptDrags', { enabled: false });
    await sleep(2500);
  };

  // 3. dim_date onto the showcase row (already there)
  const before3 = fs.readFileSync(showcase, 'utf8');
  await dragOnto('dim_date', 'showcase');
  note('3. dim_date dropped on Diagrams row showcase', { unchanged: before3 === fs.readFileSync(showcase, 'utf8'), canvasNotices: await notices(), notifications: await notifications() });
  await shot('row-drop-already');

  // 4. dim_location onto ttt
  const before4 = fs.readFileSync(ttt, 'utf8');
  await dragOnto('dim_location', 'ttt');
  const after4 = fs.readFileSync(ttt, 'utf8');
  note('4. dim_location dropped on Diagrams row ttt', { added: !before4.includes('dim_location') && after4.includes('dim_location'), activeTab: await wb.ev(`document.querySelector('.tabs-container .tab.active')?.getAttribute('aria-label')`) });
  await shot('row-drop-added');
} catch (err) {
  note('FAILED', { error: String(err?.stack ?? err) });
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, 'log.json'), JSON.stringify(log, null, 2));
  wb.close();
  killByProfile(vs.ud);
  process.exit(process.exitCode ?? 0);
}
