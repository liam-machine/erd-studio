// CHECK (glass sidebar -> canvas drop, no real mouse): the whole chain from the
// glass page's dragend to the tables on the canvas, driven with CDP mouse moves
// (they reach the pages as a mouse's would, so each page learns where it sits)
// and DOM drag events dispatched in the glass page (dragstart on the selected
// rows, then a dragend whose clientX / clientY are the release point in the
// glass page, as Chromium reports a real one: see glass-dragprobe.mjs). It
// never moves the real pointer. What it cannot show is the OS drag itself.
//
//   node test/stories/repro/reporter3-dragdrop.mjs --only X --keep --ext <built extension dir>   # prints the CDP port
//   node test/stories/repro/glass-dropsynth.mjs --port <port> [--diagram bob] [--n 3] [--window-zoom 0] [--canvas-zoom-out 1]
//        [--at 0.3,0.6] [--learn-canvas yes|no]
//
// Per run it prints: whether the diagram file changed, the React Flow viewport
// (x, y, zoom) before and after, the first table's box against the release
// point (the add puts its top-left NODE_WIDTH / 2 left of and 20 above the drop
// point, in flow units), which nodes are selected, and whether the detail panel
// is open. The diagram file and the window zoom are restored after.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Workbench, Webview, sleep } from '../lib/act.mjs';
import { sel } from '../lib/vscode.mjs';
import { attach } from '../lib/cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const port = Number(opt('--port'));
const diagram = opt('--diagram', 'bob');
const n = Number(opt('--n', '3'));
const windowZoom = Number(opt('--window-zoom', '0'));
const zoomOuts = Number(opt('--canvas-zoom-out', '1'));
const [fx, fy] = opt('--at', '0.3,0.6').split(',').map(Number);
const learnCanvas = opt('--learn-canvas', 'yes') === 'yes';
const TABLES = opt('--tables', 'dim_location,fct_sale,dim_customer,dim_date,dim_project,dim_task,fct_order,fct_task_event').split(',');

const wb = new Workbench({ port, pace: { glide: 0, settle: 100 } });
const proc = spawnSync('bash', ['-c', `ps -axo pid=,command= | grep -- '--remote-debugging-port' | grep -v grep | grep -v Helper`], { encoding: 'utf8' }).stdout
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => ({ pid: Number(l.split(' ')[0]), ud: /--user-data-dir=(\S+)/.exec(l)?.[1] }))
  .find((p) => p.ud && fs.existsSync(path.join(p.ud, 'DevToolsActivePort')) && fs.readFileSync(path.join(p.ud, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim() === String(port));
if (!proc) throw new Error(`no VS Code main process with CDP port ${port}`);
const proj = path.join(path.dirname(proc.ud), 'proj');
const diagramFile = path.join(proj, `.erd-studio/silver/diagrams/${diagram}.dbml`);
const settingsFile = path.join(proc.ud, 'User/settings.json');
const pristine = fs.readFileSync(diagramFile, 'utf8');
const settingsBefore = fs.readFileSync(settingsFile, 'utf8');

const setWindowZoom = async (z) => {
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  if (s['window.zoomLevel'] === z) return;
  s['window.zoomLevel'] = z;
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  await sleep(2500);
};

async function openDiagram() {
  if (!(await wb.ev(`!!(${sel.tab(diagram + '.dbml')})`))) {
    await wb.click(sel.commandCenter);
    await sleep(600);
    await wb.type(diagram + '.dbml');
    await sleep(1200);
    await wb.press('Enter');
    await sleep(2000);
  } else {
    await wb.click(sel.tab(diagram + '.dbml'));
    await sleep(800);
  }
}

async function findGlass() {
  for (const t of await Webview.list(port)) {
    const c = await attach(t).catch(() => null);
    if (!c) continue;
    const yes = await c.evaluate(`!!document.querySelector('iframe#active-frame')?.contentDocument?.querySelector('.gs-sections')`).catch(() => false);
    c.close();
    if (yes) return new Webview(wb, t);
  }
  throw new Error('no glass sidebar webview');
}

/** A page's (0, 0) in workbench coordinates. */
async function pageOrigin(view) {
  const outer = await wb.ev(`(() => { const f=[...document.querySelectorAll('iframe')].find(f => (f.src||'').includes(${JSON.stringify(view.id)})); const r=f.getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  const c = await attach(view.target);
  const inner = await c.evaluate(`(() => { const r=document.querySelector('iframe#active-frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  c.close();
  return { x: outer.x + inner.x, y: outer.y + inner.y };
}

const viewport = (canvas) => canvas.ev(`(() => { const t = doc.querySelector('.react-flow__viewport')?.style.transform ?? ''; const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)\\s*scale\\(([-\\d.]+)\\)/.exec(t); return m ? { x: +m[1], y: +m[2], zoom: +m[3] } : t; })()`);

try {
  await setWindowZoom(windowZoom);
  await openDiagram();
  const canvas = await Webview.find(wb, { timeout: 30000 });
  await canvas.waitFor(`doc.querySelector('.react-flow__pane')`, { timeout: 30000, what: 'the canvas pane' });
  await sleep(1500);
  const glass = await findGlass();
  const rowExpr = (name) => `[...doc.querySelectorAll('.gs-row[data-section="tables"][data-id]')].find(r => (r.querySelector('.gs-row__label')?.textContent ?? '').trim() === ${JSON.stringify(name)})`;
  await glass.ev(`(() => { for (const key of ['diagrams', 'relationships', 'help']) { const h = doc.getElementById('gs-head-' + key); if (h && h.getAttribute('aria-expanded') === 'true') h.click(); } const t = doc.getElementById('gs-head-tables'); if (t && t.getAttribute('aria-expanded') === 'false') t.click(); return 1; })()`);
  for (let i = 0; i < 6; i++) {
    const k = await glass.ev(`(() => { let k = 0; for (const r of doc.querySelectorAll('.gs-row[data-section="tables"][aria-expanded="false"]')) { r.querySelector('[data-role="twistie"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })); k++; } return k; })()`);
    if (!k) break;
    await sleep(500);
  }
  // Select N rows (Cmd-click; never runs a row).
  for (let i = 0; i < 30; i++) {
    const left = await glass.ev(`(() => { const r = doc.querySelector('.gs-row[data-section="tables"].is-selected'); if (!r) return 0; r.querySelector('.gs-row__label').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, detail: 1 })); return 1; })()`);
    if (!left) break;
    await sleep(30);
  }
  const names = TABLES.slice(0, n);
  if (n > 1) for (const name of names) await glass.ev(`(() => { ${rowExpr(name)}.querySelector('.gs-row__label').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, detail: 1 })); return 1; })()`);

  // A non-default canvas zoom: the toolbar's Zoom out.
  for (let i = 0; i < zoomOuts; i++) {
    await canvas.ev(`(() => { const b=[...doc.querySelectorAll('button')].find(b => /zoom out/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.title||''))); b?.click(); return !!b; })()`);
    await sleep(400);
  }
  const pane = await canvas.rect(`doc.querySelector('.react-flow__pane')`);
  const target = { x: pane.x + pane.width * fx, y: pane.y + pane.height * fy };
  // The canvas sees the pointer cross it (as a hand does on its way to the sidebar): it learns where it sits.
  if (learnCanvas) for (const f of [0.7, 0.5, 0.35]) { await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pane.x + pane.width * f, y: pane.y + pane.height * 0.4 }); await sleep(60); }
  // Then over the sidebar to the row.
  const row = await glass.rect(rowExpr(names[0]));
  for (const dx of [140, 80, 30]) { await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x + dx, y: row.y + row.height / 2 }); await sleep(60); }
  await sleep(300);

  const before = await viewport(canvas);
  const glassOrigin = await pageOrigin(glass);
  const canvasOrigin = await pageOrigin(canvas);
  const release = { x: target.x - glassOrigin.x, y: target.y - glassOrigin.y };
  const releaseInCanvas = { x: target.x - canvasOrigin.x, y: target.y - canvasOrigin.y };
  await canvas.ev(`(() => { win.__firstBox = null; const id = ${JSON.stringify(names[0])}; const t0 = Date.now(); const watch = () => { const node = [...doc.querySelectorAll('.react-flow__node')].find(n => n.dataset.id === id); if (node) { const r = node.getBoundingClientRect(); win.__firstBox = { x: r.x, y: r.y, w: r.width, h: r.height, t: Date.now() - t0 }; return; } if (Date.now() - t0 < 8000) win.requestAnimationFrame(watch); }; win.requestAnimationFrame(watch); return 1; })()`);
  // The drag, as the glass page sees it: dragstart on the row, then a dragend at the release point.
  await glass.ev(`(() => { const r = ${rowExpr(names[0])}; r.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })); return 1; })()`);
  await sleep(700);
  const t0 = Date.now();
  await glass.ev(`(() => { const r = ${rowExpr(names[0])}; r.dispatchEvent(new DragEvent('dragend', { bubbles: true, clientX: ${release.x}, clientY: ${release.y}, dataTransfer: new DataTransfer() })); return 1; })()`);
  let changedAt;
  while (Date.now() - t0 < 4000) {
    if (changedAt === undefined && fs.readFileSync(diagramFile, 'utf8') !== pristine) changedAt = Date.now() - t0;
    await sleep(10);
  }
  const after = await viewport(canvas);
  const box = await canvas.ev(`win.__firstBox`);
  const selected = await canvas.ev(`[...doc.querySelectorAll('.react-flow__node.selected')].map(n => n.dataset.id)`);
  const panel = await canvas.ev(`!!doc.querySelector('.detail-panel, [class*="detail-panel"], [class*="DetailPanel"]')`);
  const zoom = typeof before === 'object' ? before.zoom : NaN;
  console.log(JSON.stringify({
    diagram, n, windowZoom, fileChangedAfterMs: changedAt,
    viewportBefore: before, viewportAfter: after,
    viewportUnchanged: JSON.stringify(before) === JSON.stringify(after),
    firstTable: names[0], releaseInCanvas, firstBox: box,
    // The add: left = drop.x - NODE_WIDTH / 2 (140), top = drop.y - 20, in flow units; times the canvas zoom on the page.
    placementError: box ? { left: Math.round((box.x - (releaseInCanvas.x - 140 * zoom)) * 10) / 10, top: Math.round((box.y - (releaseInCanvas.y - 20 * zoom)) * 10) / 10 } : undefined,
    selected, detailPanelOpen: panel,
  }, null, 1));
  if (fs.readFileSync(diagramFile, 'utf8') !== pristine) {
    const base = await canvas.ev(`doc.querySelectorAll('.react-flow__node').length`);
    fs.writeFileSync(diagramFile, pristine);
    // Wait for the canvas to follow the restore, or say so (a later run would find the tables still there).
    await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length < ${base}`, { timeout: 10000, what: 'the restored diagram' })
      .catch(() => console.log('WARNING: the canvas did not follow the restored diagram file within 10 s'));
  }
  canvas.close();
  glass.close();
} finally {
  if (fs.readFileSync(diagramFile, 'utf8') !== pristine) fs.writeFileSync(diagramFile, pristine);
  fs.writeFileSync(settingsFile, settingsBefore);
  process.exit(0);
}
