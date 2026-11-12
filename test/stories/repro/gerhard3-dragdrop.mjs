// REPRO (gerhard-feedback-3, stage 1 diagnosis): Table Library drag and drop.
//
// Drives a real, isolated VS Code (fresh profile under /tmp, --use-mock-keychain,
// a COPY of test/fixtures/dbt-project-dbml in /tmp) over CDP and records what
// each drop actually does:
//
//   A. a Table Library row dropped on a diagram's row in the Diagrams view
//   B. a Table Library row dropped on the canvas, Shift pressed BEFORE the
//      pointer reaches the canvas, held through the drop
//   C. the same, Shift pressed only AFTER the pointer is already over the canvas
//   D. Shift held, but released just before the mouse button
//   E. B again with a table that is already on the diagram ("already on" message?)
//
// The drag is a real drag started on the tree row (mouse press + move), caught
// with Input.setInterceptDrags so it can be replayed with Input.dispatchDragEvent
// (dragEnter / dragOver / drop, with or without the Shift modifier) at points on
// the workbench. Chromium routes each dispatched event to the frame under the
// point, so the webview iframe receives it only when VS Code has not set
// `pointer-events: none` on it. One difference from a person's drag: no `drag`
// events fire on the source row (there is no OS drag loop), so VS Code's
// webview drag monitor sees only the `dragover` events that land in the
// workbench (see the stage-1 report).
//
// FINDING (VS Code 1.145.2, macOS): A reproduces (no write, no message, on
// v2.0.4 and develop; gerhard3-control-layer.mjs shows the same mechanism
// does deliver a tree drop). B–F are NOT a valid test of the canvas: a
// dispatched drag event never reaches the out-of-process webview frame even
// with its pointer-events back on (neither the webview page nor the workbench
// sees it), so they only show VS Code's gating state (pointer-events, drop
// overlay). gerhard3-canvas-direct.mjs covers what happens once a drop does
// reach the canvas; gerhard3-realdrag.mjs posts real OS drags for the timing.
//
//   node test/stories/repro/gerhard3-dragdrop.mjs [--out <dir>] [--keep] [--ext <extension dir>]
//
// --ext defaults to this checkout (dist/ must be built). Screenshots and a JSON
// log land in --out (default: a new /tmp/g3dd-* folder).

import fs from 'node:fs';
import path from 'node:path';

import { REPO, launchVSCode, stageExtension, shortTempDir, killByProfile } from '../lib/launch.mjs';
import { Workbench, Webview, MOD, sleep } from '../lib/act.mjs';
import { VSCodeUI, sel } from '../lib/vscode.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const keep = args.includes('--keep');
const only = opt('--only', 'ABCDEF');
const root = shortTempDir('g3dd-');
const out = opt('--out', path.join(root, 'evidence'));
fs.mkdirSync(out, { recursive: true });
const extSource = opt('--ext', REPO);

const log = [];
const note = (what, data) => { const line = { t: new Date().toISOString(), what, ...(data ?? {}) }; log.push(line); console.log(JSON.stringify(line)); };

// The extension: a staged copy of the build, so a rebuild in the repo never changes it mid-run.
const extDir = extSource === REPO ? stageExtension(path.join(root, 'ext')) : extSource;
const proj = path.join(root, 'proj');
fs.cpSync(path.join(REPO, 'test/fixtures/dbt-project-dbml'), proj, { recursive: true });
const diagramFile = path.join(proj, '.erd-studio/silver/diagrams/showcase.dbml');
const emptyDiagramFile = path.join(proj, '.erd-studio/silver/diagrams/ttt.dbml');

const vs = await launchVSCode({
  extDir, folder: proj, root, logFile: path.join(root, 'code.log'),
  settings: { 'workbench.editor.enablePreview': false, 'erdStudio.checkKnownFixes': false },
});
note('launched', { port: vs.port, root, extDir });
const wb = new Workbench({ port: vs.port, pace: { glide: 0, settle: 150 }, home: vs.home });
const ui = new VSCodeUI(wb);
const shot = async (name) => { const f = path.join(out, `${String(log.length).padStart(2, '0')}-${name}.jpg`); await wb.screenshot(f); note('screenshot', { file: f }); };

try {
  await ui.openSidebar('ERD Studio');
  // Open the showcase diagram (Quick Open), as a person would.
  await wb.click(sel.commandCenter);
  await ui.waitForQuickPick();
  await wb.type('showcase.dbml');
  await sleep(1200);
  await wb.press('Enter');
  const canvas = await Webview.find(wb, { timeout: 60000 });
  await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length >= 6`, { timeout: 60000, what: 'the six showcase tables' });
  await sleep(1500);
  note('diagram open', { nodes: await canvas.ev(`[...doc.querySelectorAll('.react-flow__node')].map(n => n.dataset.id)`) });

  // Expand the Table Library until the table rows show.
  const expandAll = async () => {
    for (let i = 0; i < 6; i++) {
      const n = await wb.ev(`(() => { let n=0; const view=[...document.querySelectorAll('.part.sidebar .pane')].find(p => /TABLE LIBRARY/i.test(p.querySelector('.pane-header')?.textContent ?? ''));
        if (!view) return -1; if (view.querySelector('.pane-header')?.getAttribute('aria-expanded') === 'false') { view.querySelector('.pane-header').click(); return 99; }
        for (const r of view.querySelectorAll('.monaco-list-row[aria-expanded="false"]')) { r.querySelector('.monaco-tl-twistie')?.dispatchEvent(new MouseEvent('click', {bubbles:true})); n++; } return n; })()`);
      if (n === 0) break;
      await sleep(500);
    }
  };
  await expandAll();
  await shot('sidebar-expanded');

  const libraryRow = (name) => `[...document.querySelectorAll('.part.sidebar .pane')].find(p => /TABLE LIBRARY/i.test(p.querySelector('.pane-header')?.textContent ?? ''))?.querySelector ? [...[...document.querySelectorAll('.part.sidebar .pane')].find(p => /TABLE LIBRARY/i.test(p.querySelector('.pane-header')?.textContent ?? '')).querySelectorAll('.monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(name)}) : null`;
  const diagramRow = (name) => `[...[...document.querySelectorAll('.part.sidebar .pane')].find(p => /^\\s*DIAGRAMS/i.test(p.querySelector('.pane-header h3')?.textContent ?? '')).querySelectorAll('.monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(name)})`;

  /** Start a real drag on a Table Library row; resolves the intercepted drag data. */
  const startDrag = async (tableName) => {
    const from = await wb.center(libraryRow(tableName));
    if (!from) throw new Error(`no Table Library row ${tableName}`);
    await wb.send('Input.setInterceptDrags', { enabled: true });
    const c = await wb.client();
    const got = new Promise((res) => { const off = c.on('Input.dragIntercepted', (p) => { off(); res(p.data); }); });
    await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await wb.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 4, y: from.y + i, button: 'left', buttons: 1 });
      await sleep(30);
    }
    const data = await Promise.race([got, sleep(5000).then(() => null)]);
    if (!data) throw new Error('the drag never started');
    note('drag started', { table: tableName, types: data.items.map((i) => i.mimeType), items: data.items.map((i) => ({ type: i.mimeType, data: i.data.slice(0, 200) })) });
    return { data, from };
  };

  const drag = (type, p, data, modifiers = 0) => wb.send('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data, modifiers });
  const iframeState = () => wb.ev(`(() => { const f=[...document.querySelectorAll('iframe.webview, .webview iframe, iframe')].find(f => (f.src||'').includes('${canvas.id}'));
    const el = f?.closest('.webview') ?? f; return { iframePointerEvents: el ? (el.style.pointerEvents || '(unset)') : null, overlay: !!document.getElementById('monaco-workbench-editor-drop-overlay') }; })()`);
  const canvasPoint = async () => { const r = await canvas.rect(`doc.querySelector('.react-flow__pane')`); return { x: r.x + r.width * 0.55, y: r.y + r.height * 0.75 }; };
  // Listen in the webview: which drag events reach the canvas, and whether the drop posted.
  const armProbe = () => canvas.ev(`(() => { win.__dd = []; for (const t of ['dragenter','dragover','dragleave','drop']) win.addEventListener(t, (e) => { const l = win.__dd; if (t === 'dragover' && l.length && l[l.length-1].t === 'dragover') { l[l.length-1].n++; return; } l.push({ t, n: 1, shift: e.shiftKey, prevented: e.defaultPrevented, types: [...(e.dataTransfer?.types ?? [])] }); }, true); return true; })()`);
  const probe = () => canvas.ev(`win.__dd`);
  // And in the workbench: where the dispatched drag events land there (an iframe target means the webview's element in the parent page).
  const armWbProbe = () => wb.ev(`(() => { window.__wbdd = []; if (!window.__wbddOn) { window.__wbddOn = true; for (const t of ['dragenter','dragover','dragleave','drop']) window.addEventListener(t, (e) => { const l = window.__wbdd; const tg = (e.target?.tagName ?? '') + (e.target?.id ? '#' + e.target.id : '') + (e.target?.className && typeof e.target.className === 'string' ? '.' + e.target.className.split(' ')[0] : ''); const k = t + ' ' + tg + (e.shiftKey ? ' +shift' : ''); if (l.length && l[l.length-1].k === k) { l[l.length-1].n++; return; } l.push({ k, n: 1 }); }, true); } return true; })()`);
  const wbProbe = () => wb.ev(`window.__wbdd`);
  const endMouse = (p) => wb.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
  const fileText = (f) => fs.readFileSync(f, 'utf8');
  const notifications = () => wb.ev(`[...document.querySelectorAll('.notification-toast-container .notification-list-item-message, .notifications-toasts .notification-list-item-message')].map(n => n.textContent.trim())`);
  const canvasToast = () => canvas.ev(`[...doc.querySelectorAll('[role=alert], [role=status], .toast, .canvas-notice, .editor-notice')].map(n => n.textContent.trim()).filter(Boolean)`);
  const clearNotifications = () => wb.ev(`[...document.querySelectorAll('.notification-toast-container .codicon-notifications-clear, .notification-toast-container .codicon-close')].forEach(b => b.click())`);

  // ---- A: drop on a diagram's row in the Diagrams view ---------------------------------------
  if (only.includes('A')) {
    // Show the ttt row (expand the Silver layer if needed).
    await wb.ev(`(() => { const v=[...document.querySelectorAll('.part.sidebar .pane')].find(p => /^\\s*DIAGRAMS/i.test(p.querySelector('.pane-header h3')?.textContent ?? '')); for (const r of v?.querySelectorAll('.monaco-list-row[aria-expanded="false"]') ?? []) r.querySelector('.monaco-tl-twistie')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); })()`);
    await sleep(600);
    const before = fileText(emptyDiagramFile);
    const { data } = await startDrag('dim_location');
    const to = await wb.center(diagramRow('ttt'));
    if (!to) throw new Error('no Diagrams row "ttt"');
    await drag('dragEnter', to, data);
    for (let i = 0; i < 5; i++) { await drag('dragOver', { x: to.x + (i % 2), y: to.y }, data); await sleep(60); }
    await shot('A-over-diagram-row');
    await drag('drop', to, data);
    await endMouse(to);
    await wb.send('Input.setInterceptDrags', { enabled: false });
    await sleep(2500);
    const after = fileText(emptyDiagramFile);
    note('A result: dim_location dropped on Diagrams row "ttt"', { fileChanged: before !== after, after: after.slice(0, 300), notifications: await notifications(), activeTab: await wb.ev(`document.querySelector('.tabs-container .tab.active')?.getAttribute('aria-label')`) });
    await shot('A-after-drop');
    await clearNotifications();
    // Back to the showcase canvas (A may have opened ttt).
    await wb.click(sel.tab('showcase.dbml')).catch(() => {});
    await sleep(800);
  }

  /** One canvas drop: Shift timing given as a list of [where, shift] dragover steps. */
  const canvasDrop = async (label, table, steps, dropShift) => {
    await clearNotifications();
    await armProbe();
    await armWbProbe();
    const before = fileText(diagramFile);
    const { data, from } = await startDrag(table);
    const sidebarPoint = { x: from.x + 40, y: from.y + 10 };
    const cp = await canvasPoint();
    const states = [];
    await drag('dragEnter', sidebarPoint, data, steps[0]?.[1] ? MOD.shift : 0);
    for (const [where, shift] of steps) {
      const p = where === 'canvas' ? cp : sidebarPoint;
      for (let i = 0; i < 4; i++) { await drag('dragOver', { x: p.x + i, y: p.y }, data, shift ? MOD.shift : 0); await sleep(70); }
      states.push({ where, shift, ...(await iframeState()) });
    }
    await shot(`${label}-before-drop`);
    await drag('drop', cp, data, dropShift ? MOD.shift : 0);
    await endMouse(cp);
    await wb.send('Input.setInterceptDrags', { enabled: false });
    await sleep(2500);
    const after = fileText(diagramFile);
    const result = {
      states,
      webviewEvents: await probe(),
      workbenchEvents: await wbProbe(),
      fileChanged: before !== after,
      notifications: await notifications(),
      canvasToast: await canvasToast().catch(() => []),
      activeTab: await wb.ev(`document.querySelector('.tabs-container .tab.active')?.getAttribute('aria-label')`),
    };
    note(`${label} result`, result);
    await shot(`${label}-after-drop`);
    // Undo an add so the next experiment starts from the same diagram; return to the canvas tab.
    if (result.fileChanged) fs.writeFileSync(diagramFile, before);
    if (!/showcase/.test(result.activeTab ?? '')) { await wb.click(sel.tab('showcase.dbml')).catch(() => {}); await sleep(800); }
    await sleep(1500);
    return result;
  };

  if (only.includes('B')) await canvasDrop('B-shift-before', 'dim_location', [['sidebar', true], ['canvas', true], ['canvas', true]], true);
  if (only.includes('C')) await canvasDrop('C-shift-after', 'dim_location', [['sidebar', false], ['canvas', false], ['canvas', true], ['canvas', true]], true);
  if (only.includes('D')) await canvasDrop('D-shift-released-before-drop', 'dim_location', [['sidebar', true], ['canvas', true], ['canvas', false]], false);
  if (only.includes('E')) await canvasDrop('E-already-on-diagram-shift-before', 'dim_date', [['sidebar', true], ['canvas', true], ['canvas', true]], true);
  if (only.includes('F')) await canvasDrop('F-already-on-diagram-shift-after', 'dim_date', [['sidebar', false], ['canvas', false], ['canvas', true], ['canvas', true]], true);
} catch (err) {
  note('FAILED', { error: String(err?.stack ?? err) });
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, 'log.json'), JSON.stringify(log, null, 2));
  console.log(`evidence: ${out}`);
  wb.close();
  if (!keep) killByProfile(vs.ud);
  else console.log(`kept running: CDP port ${vs.port}, profile ${vs.ud}`);
  // Open CDP sockets (the canvas's) would keep node alive.
  process.exit(process.exitCode ?? 0);
}
