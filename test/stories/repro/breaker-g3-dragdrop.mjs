// BREAKER (gerhard-feedback-3, stage 3): real VS Code scenarios the fixer did not run.
//   npm run build && node test/stories/repro/breaker-g3-dragdrop.mjs <evidence dir>
// S4 shows a DEFECT: with the only diagram on screen in a non-active editor group (README active in
// group 1, showcase in group 2), the inline + (Add to Open Diagram) adds to showcase but opens a SECOND
// showcase tab in group 1 (erdStudio.openDomain -> vscode.openWith with no viewColumn opens in the
// active group). Observed in VS Code 1.145.2: tabs after = README (g1), showcase (g1, new), showcase (g2).
// S1 (mixed multi-select onto a Diagrams row), S2 (schema row onto a row), S3 (onto a layer row) pass.
import fs from 'node:fs';
import path from 'node:path';

import { REPO, launchVSCode, stageExtension, shortTempDir, killByProfile } from '../lib/launch.mjs';
import { Workbench, Webview, sleep } from '../lib/act.mjs';
import { VSCodeUI, sel } from '../lib/vscode.mjs';

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const root = shortTempDir('g3brk-');
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
const tabs = () => wb.ev(`[...document.querySelectorAll('.tabs-container .tab')].map(t => (t.getAttribute('aria-label')||'') + (t.classList.contains('active')?' [active]':''))`);
const groups = () => wb.ev(`document.querySelectorAll('.editor-group-container').length`);

const openDiagram = async (file) => {
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

const dragOnto = async (rowExpr, targetExpr, modifiers = 0) => {
  const from = await wb.center(rowExpr);
  await wb.send('Input.setInterceptDrags', { enabled: true });
  const c = await wb.client();
  const got = new Promise((res) => { const off = c.on('Input.dragIntercepted', (p) => { off(); res(p.data); }); });
  await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await wb.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, modifiers });
  for (let i = 1; i <= 8; i++) { await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 4, y: from.y + i, button: 'left', buttons: 1, modifiers }); await sleep(30); }
  const data = await Promise.race([got, sleep(5000).then(() => null)]);
  if (!data) throw new Error('drag never started');
  note('drag data types', { types: data.items.map((i) => `${i.mimeType}=${String(i.data).slice(0, 80)}`) });
  const to = await wb.center(targetExpr);
  await wb.send('Input.dispatchDragEvent', { type: 'dragEnter', x: to.x, y: to.y, data });
  for (let i = 0; i < 5; i++) { await wb.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x + (i % 2), y: to.y, data }); await sleep(60); }
  await wb.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
  await wb.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await wb.send('Input.setInterceptDrags', { enabled: false });
  await sleep(2500);
};

try {
  await ui.openSidebar('ERD Studio');
  await openDiagram('showcase.dbml');
  let canvas = await Webview.find(wb, { timeout: 60000 });
  await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length >= 6`, { timeout: 60000, what: 'showcase tables' });
  await sleep(1500);
  const notices = async () => { try { const cv = await Webview.find(wb, { timeout: 5000 }); return await cv.ev(`[...doc.querySelectorAll('[role=status], [role=alert]')].map(n => n.textContent.trim()).filter(Boolean)`); } catch (e) { return `ERR ${e.message}`; } };
  for (let i = 0; i < 6; i++) {
    const k = await wb.ev(`(() => { let k=0; const v=${pane('/TABLE LIBRARY/i')}; if (!v) return -1; for (const r of v.querySelectorAll('.monaco-list-row[aria-expanded="false"]')) { r.querySelector('.monaco-tl-twistie')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); k++; } return k; })()`);
    if (k === 0) break;
    await sleep(500);
  }
  for (let i = 0; i < 4; i++) {
    const k = await wb.ev(`(() => { let k=0; const v=${pane('/^\\s*DIAGRAMS/i')}; if (!v) return -1; for (const r of v.querySelectorAll('.monaco-list-row[aria-expanded="false"]')) { r.querySelector('.monaco-tl-twistie')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); k++; } return k; })()`);
    if (k === 0) break;
    await sleep(500);
  }
  note('library rows', { rows: await wb.ev(`[...(${pane('/TABLE LIBRARY/i')}).querySelectorAll('.monaco-list-row')].map(r => r.getAttribute('aria-label'))`) });
  note('diagram rows', { rows: await wb.ev(`[...(${pane('/^\\s*DIAGRAMS/i')}).querySelectorAll('.monaco-list-row')].map(r => r.getAttribute('aria-label'))`) });

  // S4. showcase in group 1, README in a new group to the right (active). + on fct_sale.
  await openDiagram('README.md');
  await sleep(1500);
  await openDiagram('showcase.dbml');
  await sleep(1500);
  await ui.runCommand('View: Move Editor into Right Group', 'View: Move Editor into Right Group');
  await sleep(2000);
  await ui.runCommand('View: Focus First Editor Group', 'View: Focus First Editor Group');
  await sleep(1000);
  note('S4 before', { tabs: await tabs(), groups: await groups() });
  await shot('s4-split-before');
  const beforeS4 = fs.readFileSync(showcase, 'utf8');
  await ensureRow('fct_sale');
  await wb.hover(libRow('fct_sale'));
  await sleep(400);
  await wb.click(`(${libRow('fct_sale')}).querySelector('.action-label[aria-label="Add to Open Diagram"]')`);
  await sleep(3000);
  const quickPick = await wb.ev(`!!document.querySelector('.quick-input-widget:not([style*="display: none"])')`);
  note('S4 + on fct_sale with showcase in a non-active group', { added: !beforeS4.includes('fct_sale') && fs.readFileSync(showcase, 'utf8').includes('fct_sale'), quickPick, status: await statusText(), tabs: await tabs(), groups: await groups() });
  await shot('s4-split-after');
  if (quickPick) { await wb.press('Escape'); await sleep(500); }
  // back to a single group
  await ui.runCommand('View: Join All Editor Groups', 'View: Join All Editor Groups');
  await sleep(1500);
  await openDiagram('showcase.dbml');
  await sleep(2500);
  note('after join', { tabs: await tabs(), groups: await groups() });

  // S1. multi-select dim_date (on showcase) + dim_location (new), drag onto showcase row
  await ensureRow('dim_date');
  const q1 = await wb.center(libRow('dim_date'));
  await wb.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: q1.x, y: q1.y, button: 'left', buttons: 1, clickCount: 1 });
  await wb.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: q1.x, y: q1.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(300);
  const q2 = await wb.center(libRow('dim_location'));
  await wb.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: q2.x, y: q2.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 4 });
  await wb.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: q2.x, y: q2.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 4 });
  await sleep(400);
  note('S1 selected', { selected: await wb.ev(`[...(${pane('/TABLE LIBRARY/i')}).querySelectorAll('.monaco-list-row.selected')].map(r => r.getAttribute('aria-label'))`) });
  const beforeS1 = fs.readFileSync(showcase, 'utf8');
  await dragOnto(libRow('dim_location'), diagRow('showcase'));
  const afterS1 = fs.readFileSync(showcase, 'utf8');
  note('S1 mixed multi-select onto showcase row', { addedLocation: !beforeS1.includes('dim_location') && afterS1.includes('dim_location'), dimDateCount: (afterS1.match(/dim_date/g) || []).length, canvasNotices: await notices(), notifications: await ui.notifications(), tabs: await tabs() });
  await shot('s1-mixed');

  // S2. schema row "public" onto ttt row
  const beforeS2 = fs.readFileSync(ttt, 'utf8');
  for (let i = 0; i < 6; i++) { const c = await wb.ev(`(() => { const b = (${pane('/TABLE LIBRARY/i')}).querySelector('.pane-body').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`); await wb.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: -200 }); await sleep(150); }
  await ensureRow('public');
  await dragOnto(libRow('public'), diagRow('ttt'));
  const afterS2 = fs.readFileSync(ttt, 'utf8');
  note('S2 schema row public onto ttt', { addedFctOrder: !beforeS2.includes('fct_order') && afterS2.includes('fct_order'), diff: afterS2.split('\n').filter((l) => !beforeS2.includes(l)).slice(0, 8), notifications: await ui.notifications(), tabs: await tabs() });
  await shot('s2-schema-row');

  // S3. dim_customer onto the "Silver" layer row in Diagrams
  const silverRow = diagRow('Silver');
  if (await wb.ev(`!!(${silverRow})`)) {
    await ensureRow('dim_customer');
    await dragOnto(libRow('dim_customer'), silverRow);
    note('S3 onto a layer row', { notifications: await ui.notifications() });
    await shot('s3-layer-row');
  } else note('S3 skipped: no Silver row');

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
