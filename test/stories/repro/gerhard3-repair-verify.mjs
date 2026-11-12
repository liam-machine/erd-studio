// REPAIR check (gerhard-feedback-3, stage 4): the Breaker's findings, in real VS Code.
//   npm run build && node test/stories/repro/gerhard3-repair-verify.mjs <evidence dir>
// R1  Breaker S4: the only diagram on screen in a non-active group; the inline + adds there with no second tab.
// R2  A Table Library drag let go over the canvas WITHOUT Shift (a drop inside the workbench, replayed over CDP):
//     VS Code opens the file; the notice says so and its "Add to showcase" button adds the table.
//     The canvas's "Hold Shift and drop" hint is read before the drop and after (libraryDragEnded).
// R3  Right-click a table (window.menuStyle custom, so the menu is DOM): Add to Open Diagram and Add to Diagram… both
//     listed; Add to Diagram… asks, showcase (open, not showing fct_large_table) first.
// R4  The same canvas drag WITH Shift held (CDP modifiers): recorded as-is. CDP's drag events are not an OS drag,
//     so this says nothing about a real mouse either way.
import fs from 'node:fs';
import path from 'node:path';

import { REPO, launchVSCode, stageExtension, shortTempDir, killByProfile } from '../lib/launch.mjs';
import { Workbench, Webview, sleep } from '../lib/act.mjs';
import { VSCodeUI, sel } from '../lib/vscode.mjs';

const out = process.argv[2] ?? fs.mkdtempSync('/tmp/g3rv-out-');
fs.mkdirSync(out, { recursive: true });
const root = shortTempDir('g3rv-');
const log = [];
const note = (what, data) => { const l = { what, ...(data ?? {}) }; log.push(l); console.log(JSON.stringify(l)); };
const extDir = stageExtension(path.join(root, 'ext'));
const proj = path.join(root, 'proj');
fs.cpSync(path.join(REPO, 'test/fixtures/dbt-project-dbml'), proj, { recursive: true });
const showcase = path.join(proj, '.erd-studio/silver/diagrams/showcase.dbml');

const vs = await launchVSCode({ extDir, folder: proj, root, logFile: path.join(root, 'code.log'),
  settings: { 'erdStudio.checkKnownFixes': false, 'window.menuStyle': 'custom' } });
const wb = new Workbench({ port: vs.port, pace: { glide: 0, settle: 150 }, home: vs.home });
const ui = new VSCodeUI(wb);
let n = 0;
const shot = async (name) => { const f = path.join(out, `${String(++n).padStart(2, '0')}-${name}.jpg`); await wb.screenshot(f); note('screenshot', { file: f }); };
const pane = (re) => `[...document.querySelectorAll('.part.sidebar .pane')].find(p => ${re}.test(p.querySelector('.pane-header')?.textContent ?? ''))`;
const libRow = (name) => `[...(${pane('/TABLE LIBRARY/i')}).querySelectorAll('.monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(name)})`;
const statusText = () => wb.ev(`[...document.querySelectorAll('.statusbar-item')].map(s => s.textContent.trim()).filter(t => /ERD Studio: Added/.test(t))`);
const notifications = () => wb.ev(`[...document.querySelectorAll('.notification-list-item-message')].map(n => n.textContent.trim())`);
const tabs = () => wb.ev(`[...document.querySelectorAll('.tabs-container .tab')].map(t => (t.getAttribute('aria-label')||'') + (t.classList.contains('active')?' [active]':'') + (t.classList.contains('preview')?' [preview]':''))`);
const groups = () => wb.ev(`document.querySelectorAll('.editor-group-container').length`);
const canvasTexts = async () => { try { const cv = await Webview.find(wb, { timeout: 5000 }); return await cv.ev(`[...doc.querySelectorAll('[role=status], [role=alert]')].map(n => n.textContent.trim()).filter(Boolean)`); } catch (e) { return `ERR ${e.message}`; } };
const clearNotifications = () => wb.ev(`[...document.querySelectorAll('.notification-toast-container .codicon-notifications-clear, .notification-toast-container .codicon-close')].forEach(b => b.click())`);

const openQuick = async (file) => {
  await wb.click(sel.commandCenter);
  await ui.waitForQuickPick();
  await wb.type(file);
  await sleep(1200);
  await wb.press('Enter');
};
const ensureRow = async (name) => {
  for (let i = 0; i < 12; i++) {
    const vis = await wb.ev(`(() => { const r = ${libRow(name)}; if (!r) return false; const b = r.getBoundingClientRect(); const p = (${pane('/TABLE LIBRARY/i')}).querySelector('.pane-body').getBoundingClientRect(); return b.top >= p.top && b.bottom <= p.bottom; })()`);
    if (vis) return;
    const c = await wb.ev(`(() => { const b = (${pane('/TABLE LIBRARY/i')}).querySelector('.pane-body').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await wb.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: 60 });
    await sleep(250);
  }
  throw new Error('row never visible: ' + name);
};
/** Start a real drag on a Table Library row (caught by Input.setInterceptDrags), then replay it over `to` and drop. */
const dragTo = async (table, to, modifiers = 0, { hintProbe } = {}) => {
  const from = await wb.center(libRow(table));
  await wb.send('Input.setInterceptDrags', { enabled: true });
  const c = await wb.client();
  const got = new Promise((res) => { const off = c.on('Input.dragIntercepted', (p) => { off(); res(p.data); }); });
  await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await wb.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) { await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 4, y: from.y + i, button: 'left', buttons: 1 }); await sleep(30); }
  const data = await Promise.race([got, sleep(5000).then(() => null)]);
  if (!data) throw new Error('drag never started');
  await sleep(600);
  const hint = hintProbe ? await canvasTexts() : undefined;
  await wb.send('Input.dispatchDragEvent', { type: 'dragEnter', x: to.x, y: to.y, data, modifiers });
  for (let i = 0; i < 6; i++) { await wb.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x + (i % 2), y: to.y, data, modifiers }); await sleep(80); }
  const overlay = await wb.ev(`!!document.getElementById('monaco-workbench-editor-drop-overlay')`);
  await wb.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data, modifiers });
  await wb.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await wb.send('Input.setInterceptDrags', { enabled: false });
  await sleep(2500);
  return { hint, overlayWhileOver: overlay };
};

try {
  await ui.openSidebar('ERD Studio');
  await openQuick('showcase.dbml');
  let canvas = await Webview.find(wb, { timeout: 60000 });
  await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length >= 6`, { timeout: 60000, what: 'showcase tables' });
  await sleep(1500);
  for (let i = 0; i < 6; i++) {
    const k = await wb.ev(`(() => { let k=0; const v=${pane('/TABLE LIBRARY/i')}; if (!v) return -1; for (const r of v.querySelectorAll('.monaco-list-row[aria-expanded="false"]')) { r.querySelector('.monaco-tl-twistie')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); k++; } return k; })()`);
    if (k === 0) break;
    await sleep(500);
  }

  // R1. README active in group 1, showcase alone in group 2; + on fct_sale.
  await openQuick('README.md');
  await sleep(1500);
  await openQuick('showcase.dbml');
  await sleep(1500);
  await ui.runCommand('View: Move Editor into Right Group', 'View: Move Editor into Right Group');
  await sleep(2000);
  await ui.runCommand('View: Focus First Editor Group', 'View: Focus First Editor Group');
  await sleep(1000);
  note('R1 before', { tabs: await tabs(), groups: await groups() });
  await shot('r1-split-before');
  const beforeR1 = fs.readFileSync(showcase, 'utf8');
  await ensureRow('fct_sale');
  await wb.hover(libRow('fct_sale'));
  await sleep(400);
  await wb.click(`(${libRow('fct_sale')}).querySelector('.action-label[aria-label="Add to Open Diagram"]')`);
  await sleep(3000);
  const tabsR1 = await tabs();
  note('R1 + on fct_sale, showcase in the non-active group', {
    added: !beforeR1.includes('fct_sale') && fs.readFileSync(showcase, 'utf8').includes('fct_sale'),
    showcaseTabs: tabsR1.filter((t) => /showcase/.test(t)).length,
    quickPick: await wb.ev(`!!document.querySelector('.quick-input-widget:not([style*="display: none"])')`),
    status: await statusText(), tabs: tabsR1, groups: await groups(),
  });
  await shot('r1-split-after');
  await ui.runCommand('View: Join All Editor Groups', 'View: Join All Editor Groups');
  await sleep(1500);
  await ui.runCommand('View: Close All Editors', 'View: Close All Editors');
  await sleep(1500);
  await openQuick('showcase.dbml');
  canvas = await Webview.find(wb, { timeout: 60000 });
  await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length >= 6`, { timeout: 60000, what: 'showcase tables' });
  await sleep(1500);
  await clearNotifications();

  // R2. dim_location dragged onto the canvas without Shift.
  const editorCentre = await wb.center(`document.querySelector('.part.editor .editor-group-container.active .editor-container')`);
  await ensureRow('dim_location');
  const beforeR2 = fs.readFileSync(showcase, 'utf8');
  const r2 = await dragTo('dim_location', editorCentre, 0, { hintProbe: true });
  const missedNotice = (await notifications()).find((t) => /opened as a file instead of being added/.test(t));
  note('R2 plain drop on the canvas', {
    canvasHintDuringDrag: r2.hint, vsCodeOverlayWhileOver: r2.overlayWhileOver,
    tabs: await tabs(), notice: missedNotice ?? null, unchangedSoFar: beforeR2 === fs.readFileSync(showcase, 'utf8'),
  });
  await shot('r2-missed-drop-notice');
  if (missedNotice) {
    await ui.notificationButton('opened as a file instead of being added', 'Add to showcase');
    await sleep(3000);
    canvas = await Webview.find(wb, { timeout: 30000 });
    note('R2 after "Add to showcase"', {
      added: !beforeR2.includes('dim_location') && fs.readFileSync(showcase, 'utf8').includes('dim_location'),
      tabs: await tabs(), canvasTexts: await canvasTexts(), status: await statusText(),
    });
    await shot('r2-added-from-notice');
  }

  // R4. The same canvas drag with Shift (CDP modifiers = 8).
  await clearNotifications();
  await ensureRow('dim_location');
  const beforeR4 = fs.readFileSync(showcase, 'utf8');
  const r4 = await dragTo('dim_location', editorCentre, 8);
  note('R4 CDP drag with Shift modifiers over the canvas', {
    vsCodeOverlayWhileOver: r4.overlayWhileOver, unchanged: beforeR4 === fs.readFileSync(showcase, 'utf8'),
    tabs: await tabs(), notifications: await notifications(), canvasTexts: await canvasTexts(),
  });
  await shot('r4-shift-cdp');
  // R3. Right-click a table row: both adds are listed; Add to Diagram… asks, the open diagram first.
  await clearNotifications();
  await ensureRow('fct_large_table');
  const rc = await wb.center(libRow('fct_large_table'));
  await wb.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rc.x, y: rc.y, button: 'right', buttons: 2, clickCount: 1 });
  await wb.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rc.x, y: rc.y, button: 'right', buttons: 0, clickCount: 1 });
  await sleep(800);
  const menuItems = await wb.ev(`[...document.querySelectorAll('.context-view .action-label, .monaco-menu .action-label')].map(a => a.textContent.trim()).filter(Boolean)`);
  note('R3 right-click menu', { menuItems });
  await shot('r3-context-menu');
  const pickItem = await wb.ev(`(() => { const a = [...document.querySelectorAll('.context-view .action-label, .monaco-menu .action-label')].find(a => a.textContent.trim() === 'Add to Diagram…'); if (!a) return false; const b = a.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (pickItem) {
    await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pickItem.x, y: pickItem.y });
    await wb.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pickItem.x, y: pickItem.y, button: 'left', buttons: 1, clickCount: 1 });
    await wb.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pickItem.x, y: pickItem.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(1200);
    note('R3 Add to Diagram… with showcase open', {
      quickPick: await wb.ev(`!!document.querySelector('.quick-input-widget:not([style*="display: none"])')`),
      rows: await wb.ev(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].map(r => r.textContent.trim()).slice(0, 6)`),
    });
    await shot('r3-add-to-diagram-asks');
    await wb.press('Escape');
    await sleep(500);
  } else {
    await wb.press('Escape');
  }

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
