// PROBE (glass sidebar -> canvas drop latency): REAL OS drags (macOS only) of
// N selected Table Library rows from the glass sidebar (a WebviewView) onto an
// open diagram's canvas (another webview), with everything recorded on one
// clock: realdrag2.swift's phases (it MOVES THE REAL POINTER), the glass page's
// drag and pointer events and the messages it posts, the canvas page's pointer
// and drag events, the messages it posts and receives, the diagram file on disk
// (polled every 10 ms) and the canvas's table nodes (count and positions,
// sampled every frame).
//
//   node test/stories/repro/reporter3-dragdrop.mjs --only X --keep [--ext <built extension dir>]   # prints the CDP port
//   node test/stories/repro/glass-dragprobe.mjs --port <port> [--ns 1,3,8] [--variants still,move] [--diagram bob]
//        [--target canvas|sidebar|tabbar] [--repeat 1] [--out dir] [--verbose]
//
// Variants are realdrag2.swift's glass-still (let go, hold still 3 s, then move)
// and glass-move (let go and move on at once). --target sidebar / tabbar let go
// back in the sidebar or on the editor tab bar instead (nothing may be added).
// The diagram file is restored after every run.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Workbench, Webview, sleep } from '../lib/act.mjs';
import { sel } from '../lib/vscode.mjs';
import { attach } from '../lib/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const port = Number(opt('--port'));
const ns = opt('--ns', '1,3,8').split(',').map(Number);
const variants = opt('--variants', 'still,move').split(',');
const diagram = opt('--diagram', 'bob');
const targetKind = opt('--target', 'canvas');
const repeat = Number(opt('--repeat', '1'));
const verbose = args.includes('--verbose');
const out = opt('--out', fs.mkdtempSync('/tmp/glassprobe-'));
fs.mkdirSync(out, { recursive: true });
// The tables, in the order they are selected (the first is the row dragged): none is on an empty diagram.
const TABLES = opt('--tables', 'dim_location,fct_sale,dim_customer,dim_date,dim_project,dim_task,fct_order,fct_task_event').split(',');

const bin = '/tmp/g3-realdrag2';
if (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(path.join(here, 'realdrag2.swift')).mtimeMs) {
  const r = spawnSync('swiftc', ['-O', path.join(here, 'realdrag2.swift'), '-o', bin], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`swiftc failed: ${r.stderr}`);
}

const wb = new Workbench({ port, pace: { glide: 0, settle: 100 } });
const proc = spawnSync('bash', ['-c', `ps -axo pid=,command= | grep -- '--remote-debugging-port' | grep -v grep | grep -v Helper`], { encoding: 'utf8' }).stdout
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => ({ pid: Number(l.split(' ')[0]), ud: /--user-data-dir=(\S+)/.exec(l)?.[1] }))
  .find((p) => p.ud && fs.existsSync(path.join(p.ud, 'DevToolsActivePort')) && fs.readFileSync(path.join(p.ud, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim() === String(port));
if (!proc) throw new Error(`no VS Code main process with CDP port ${port}`);
const proj = path.join(path.dirname(proc.ud), 'proj');
const diagramFile = path.join(proj, `.erd-studio/silver/diagrams/${diagram}.dbml`);
if (!fs.existsSync(diagramFile)) throw new Error(`no diagram file ${diagramFile}`);
const pristine = fs.readFileSync(diagramFile, 'utf8');

// ---------------------------------------------------------------- recorders
// Event recorder for a window (capture phase). Consecutive identical keys fold (n, last).
const RECORDER = `(w, frame) => {
  w.__probe = [];
  if (w.__probeOn) return 1;
  w.__probeOn = true;
  const desc = (el) => !el || !el.tagName ? String(el && el.constructor && el.constructor.name) : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/)[0] : '');
  const push = (k, t) => {
    const l = w.__probe; const last = l[l.length - 1];
    if (last && last.k === k) { last.n++; last.last = t; return; }
    l.push({ t, frame, k, n: 1 });
  };
  for (const type of ['dragstart', 'drag', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) {
    w.addEventListener(type, (e) => {
      const t = Date.now();
      const coords = (type === 'drag' || type === 'dragend' || type === 'drop') ? ' scr=' + e.screenX + ',' + e.screenY + ' cli=' + e.clientX + ',' + e.clientY : '';
      setTimeout(() => push(type + ' ' + desc(e.target) + (e.defaultPrevented ? ' prevented' : '') + (e.dataTransfer ? ' de=' + e.dataTransfer.dropEffect : '') + (type === 'drag' ? '' : coords), t), 0);
      if (type === 'drag' || type === 'dragend') w.__lastDragCoords = { type, t, screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY };
    }, true);
  }
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointerover', 'mousemove']) {
    w.addEventListener(type, (e) => push(type + ' buttons=' + e.buttons + ' @' + Math.round(e.clientX) + ',' + Math.round(e.clientY), Date.now()), true);
  }
  // Messages from the host (the inner page gets each as a message event whose data is the message).
  w.addEventListener('message', (e) => { const d = e.data; if (d && typeof d === 'object' && typeof d.type === 'string') push('recv ' + d.type, Date.now()); }, true);
  return 1;
}`;

// In a webview's outer page: what its inner page posts to the host (acquireVsCodeApi's postMessage goes through here).
const POSTS = `(frame) => {
  window.__posts = [];
  if (window.__postsOn) return 1;
  window.__postsOn = true;
  window.addEventListener('message', (e) => {
    const f = document.querySelector('iframe#active-frame');
    if (!f || e.source !== f.contentWindow) return;
    const d = e.data; const msg = d && d.data && (d.data.message ?? d.data);
    const type = msg && typeof msg === 'object' && typeof msg.type === 'string' ? msg.type : null;
    if (!type) return;
    window.__posts.push({ t: Date.now(), frame, k: 'post ' + type + (type === 'dropTables' ? ' ' + JSON.stringify(msg.payload) : type === 'dragStart' ? ' ids=' + (msg.ids || []).length : ''), n: 1 });
  }, true);
  return 1;
}`;

// The canvas's table nodes, every frame: count and a signature of their positions.
const NODES = `(w) => {
  w.__nodes = [];
  w.__firstBoxes = null;
  w.__offsets = [];
  if (!w.__offOn2) { w.__offOn2 = true; w.addEventListener('pointermove', (e) => { w.__offsets.push({ x: e.screenX - e.clientX, y: e.screenY - e.clientY }); }, true); }
  if (w.__nodesOn2) return 1;
  w.__nodesOn2 = true;
  const d = w.document;
  let lastN = -1, lastSig = '';
  const sample = () => {
    const nodes = d.querySelectorAll('.react-flow__node');
    let sig = '';
    for (const n of nodes) sig += n.dataset.id + ':' + n.style.transform + (n.offsetWidth ? '' : ':0w') + ';';
    if (nodes.length !== lastN || sig !== lastSig) {
      // The first time tables appear: each one's box on the page, and the zoom (before any reveal pans the view).
      if (lastN >= 0 && nodes.length > lastN && !w.__firstBoxes) {
        const vp = d.querySelector('.react-flow__viewport');
        const zoom = vp ? Number((/scale\(([^)]+)\)/.exec(vp.style.transform) || [])[1] || 1) : 1;
        w.__firstBoxes = { zoom, boxes: [...nodes].map((n) => { const r = n.getBoundingClientRect(); return { id: n.dataset.id, x: r.x, y: r.y, w: r.width, h: r.height }; }) };
      }
      w.__nodes.push({ t: Date.now(), n: nodes.length, moved: nodes.length === lastN });
      lastN = nodes.length; lastSig = sig;
    }
  };
  setInterval(sample, 8);
  const raf = () => { sample(); w.requestAnimationFrame(raf); };
  w.requestAnimationFrame(raf);
  return 1;
}`;

// ---------------------------------------------------------------- set up
const toScreen = async (p) => {
  const w = await wb.ev(`({ x: window.screenX, y: window.screenY, top: window.outerHeight - window.innerHeight })`);
  return { x: Math.round(w.x + p.x), y: Math.round(w.y + w.top + p.y) };
};
const closeOtherTabs = () => wb.ev(`(() => { let n=0; for (const t of document.querySelectorAll('.tabs-container .tab')) { if (!${JSON.stringify(diagram + '.dbml')}.length || (t.getAttribute('aria-label') ?? '').split(',')[0].trim() !== ${JSON.stringify(diagram + '.dbml')}) { t.querySelector('.tab-actions .action-label, .codicon-close')?.click(); n++; } } return n; })()`);

async function openDiagram() {
  const open = await wb.ev(`!!(${sel.tab(diagram + '.dbml')})`);
  if (!open) {
    await wb.click(sel.commandCenter);
    await sleep(600);
    await wb.type(diagram + '.dbml');
    await sleep(1200);
    await wb.press('Enter');
    await sleep(1500);
  } else {
    await wb.click(sel.tab(diagram + '.dbml'));
    await sleep(500);
  }
  await closeOtherTabs();
  await sleep(500);
}

async function findGlass() {
  for (const t of await Webview.list(port)) {
    const c = await attach(t).catch(() => null);
    if (!c) continue;
    const yes = await c.evaluate(`!!document.querySelector('iframe#active-frame')?.contentDocument?.querySelector('.gs-sections')`).catch(() => false);
    c.close();
    if (yes) return new Webview(wb, t);
  }
  throw new Error('no glass sidebar webview (a webview whose page has .gs-sections)');
}

await openDiagram();
const canvas = await Webview.find(wb, { timeout: 30000 });
await canvas.waitFor(`doc.querySelector('.react-flow__pane')`, { timeout: 30000, what: 'the canvas pane' });
const glass = await findGlass();
const glassRowExpr = (name) => `[...doc.querySelectorAll('.gs-row[data-section="tables"][data-id]')].find(r => (r.querySelector('.gs-row__label')?.textContent ?? '').trim() === ${JSON.stringify(name)})`;

// Room for the Table Library: fold Diagrams and Relationships, open the Table Library and every row in it.
await glass.ev(`(() => {
  for (const key of ['diagrams', 'relationships', 'help']) { const h = doc.getElementById('gs-head-' + key); if (h && h.getAttribute('aria-expanded') === 'true') h.click(); }
  const t = doc.getElementById('gs-head-tables'); if (t && t.getAttribute('aria-expanded') === 'false') t.click();
  return 1; })()`);
for (let i = 0; i < 6; i++) {
  const n = await glass.ev(`(() => { let n = 0; for (const r of doc.querySelectorAll('.gs-row[data-section="tables"][aria-expanded="false"]')) { r.querySelector('[data-role="twistie"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })); n++; } return n; })()`);
  if (!n) break;
  await sleep(500);
}
await sleep(500);
const missing = [];
for (const t of TABLES) if (!(await glass.ev(`!!(${glassRowExpr(t)})`))) missing.push(t);
if (missing.length) throw new Error(`glass Table Library rows not found: ${missing.join(', ')}`);

/** Select exactly these rows (Cmd-click, as a person does; a Cmd-click never runs a row). */
async function selectRows(names) {
  // One at a time: a toggle may redraw the rows.
  for (let i = 0; i < 30; i++) {
    const left = await glass.ev(`(() => { const r = doc.querySelector('.gs-row[data-section="tables"].is-selected'); if (!r) return 0; r.querySelector('.gs-row__label').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, detail: 1 })); return 1; })()`);
    if (!left) break;
    await sleep(30);
  }
  for (const name of names) {
    await glass.ev(`(() => { const r = ${glassRowExpr(name)}; r.querySelector('.gs-row__label').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, detail: 1 })); return 1; })()`);
  }
  await sleep(150);
  return glass.ev(`[...doc.querySelectorAll('.gs-row[data-section="tables"].is-selected')].map(r => r.querySelector('.gs-row__label').textContent.trim())`);
}

// ---------------------------------------------------------------- one run
const results = [];
const ms = (a, b) => (a === undefined || b === undefined ? '   -' : String(Math.round(b - a)).padStart(5));

async function oneRun(round, n, variant) {
  await openDiagram();
  // Clean diagram, every time.
  if (fs.readFileSync(diagramFile, 'utf8') !== pristine) { fs.writeFileSync(diagramFile, pristine); await sleep(1500); }
  const baseNodes = await canvas.ev(`doc.querySelectorAll('.react-flow__node').length`);
  const names = TABLES.slice(0, n);
  const selected = n === 1 ? await selectRows([]) : await selectRows(names);
  if (n > 1 && selected.length !== n) throw new Error(`selected ${selected.length} rows, wanted ${n}: ${selected}`);

  const glassOuter = await attach(glass.target);
  const canvasOuter = await attach(canvas.target);
  await wb.ev(`[...document.querySelectorAll('.notification-toast-container .codicon-notifications-clear, .notification-toast-container .codicon-close')].forEach(b => b.click())`);
  await glassOuter.evaluate(`(${RECORDER})(document.querySelector('iframe#active-frame').contentWindow, 'glass')`);
  await glassOuter.evaluate(`(${POSTS})('glass')`);
  await canvasOuter.evaluate(`(${RECORDER})(document.querySelector('iframe#active-frame').contentWindow, 'canvas')`);
  await canvasOuter.evaluate(`(${POSTS})('canvas')`);
  await canvasOuter.evaluate(`(${NODES})(document.querySelector('iframe#active-frame').contentWindow)`);

  const rowRect = await glass.rect(glassRowExpr(names[0]));
  if (!rowRect) throw new Error(`the ${names[0]} row is not on screen`);
  const from = await toScreen({ x: rowRect.x + Math.min(rowRect.width / 2, 120), y: rowRect.y + rowRect.height / 2 });
  let toPoint;
  if (targetKind === 'canvas') {
    const r = await canvas.rect(`doc.querySelector('.react-flow__pane')`);
    toPoint = { x: r.x + r.width * 0.2, y: r.y + r.height * 0.55 };
  } else if (targetKind === 'sidebar') {
    const r = await glass.rect(`doc.querySelector('.gs-sections')`);
    toPoint = { x: r.x + r.width * 0.5, y: r.y + Math.min(r.height - 20, 520) };
  } else if (targetKind === 'tabbar') {
    toPoint = await wb.ev(`(() => { const t = document.querySelector('.tabs-and-actions-container') ?? document.querySelector('.tabs-container'); const b = t.getBoundingClientRect(); return { x: b.right - 260, y: b.top + b.height / 2 }; })()`);
  } else throw new Error(`unknown --target ${targetKind}`);
  const to = await toScreen(toPoint);
  if (args.includes('--dry')) { console.log(`dry: N=${n} selected=${JSON.stringify(selected)} from=${JSON.stringify(from)} to=${JSON.stringify(to)} base=${baseNodes}`); glassOuter.close(); canvasOuter.close(); return; }

  // The posted events go to whatever window is under the pointer: this VS Code must be in front, or nothing is dragged.
  const lock = spawnSync('bash', ['-c', `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked | grep -c '<true/>'`], { encoding: 'utf8' }).stdout.trim();
  if (lock !== '0') throw new Error('the screen is locked: no real drag can reach VS Code');
  let front = '';
  for (let tries = 0; tries < 40 && front !== String(proc.pid); tries++) {
    if (tries > 0) await sleep(3000);
    spawnSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${proc.pid}) to true`]);
    await sleep(400);
    front = spawnSync('osascript', ['-e', 'tell application "System Events" to get unix id of first process whose frontmost is true'], { encoding: 'utf8' }).stdout.trim();
  }
  if (front !== String(proc.pid)) throw new Error(`the scripted VS Code (pid ${proc.pid}) is not in front (pid ${front} is): not dragging`);

  // The diagram file, polled while the helper runs.
  const fileEvents = [];
  let lastStat = fs.statSync(diagramFile);
  const poll = setInterval(() => {
    try {
      const s = fs.statSync(diagramFile);
      if (s.mtimeMs !== lastStat.mtimeMs || s.size !== lastStat.size) { fileEvents.push({ t: Date.now(), frame: 'disk', k: `file changed (${s.size} bytes)`, n: 1 }); lastStat = s; }
    } catch { /* mid-write */ }
  }, 10);
  const mode = `glass-${variant}`;
  const phases = await new Promise((resolve) => {
    const p = spawn(bin, [String(proc.pid), String(from.x), String(from.y), String(to.x), String(to.y), mode]);
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.on('close', () => resolve(buf.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))));
  });
  await sleep(1500);
  clearInterval(poll);

  const tUp = phases.find((p) => p.phase === 'mouse-up')?.t;
  const glassEvents = await glassOuter.evaluate(`document.querySelector('iframe#active-frame').contentWindow.__probe`).catch(() => []);
  const glassPosts = await glassOuter.evaluate(`window.__posts`).catch(() => []);
  const glassLast = await glassOuter.evaluate(`document.querySelector('iframe#active-frame').contentWindow.__lastDragCoords`).catch(() => null);
  const canvasEvents = await canvasOuter.evaluate(`document.querySelector('iframe#active-frame').contentWindow.__probe`).catch(() => []);
  const canvasPosts = await canvasOuter.evaluate(`window.__posts`).catch(() => []);
  const nodeSamples = await canvasOuter.evaluate(`document.querySelector('iframe#active-frame').contentWindow.__nodes`).catch(() => []);
  // The host's own timing lines (ERD Studio log; local time stamps to epoch ms).
  const hostEvents = [];
  for (const f of spawnSync('bash', ['-c', `find ${JSON.stringify(path.join(proc.ud, 'logs'))} -name 'ERD Studio.log'`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3}) \[\w+\] (.*(Table Library drag|Table drop).*)$/.exec(line);
      if (!m) continue;
      const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
      if (t < phases[0].t - 1000 || t > Date.now()) continue;
      const took = /in (\d+) ms$/.exec(m[8]);
      hostEvents.push({ t, frame: 'host', k: m[8].replace('[SemanticEditorProvider] ', ''), n: 1, received: took ? t - Number(took[1]) : undefined });
    }
  }
  const firstBoxes = await canvasOuter.evaluate(`document.querySelector('iframe#active-frame').contentWindow.__firstBoxes`).catch(() => null);
  const offsets = await canvasOuter.evaluate(`document.querySelector('iframe#active-frame').contentWindow.__offsets`).catch(() => []);
  const after = fs.readFileSync(diagramFile, 'utf8');
  const expected = targetKind === 'canvas' ? baseNodes + n : baseNodes;

  const first = (list, pred) => list.find((e) => e.t >= (tUp ?? 0) - 5 && pred(e));
  const dragend = first(glassEvents, (e) => e.k.startsWith('dragend'));
  const canvasPointer = first(canvasEvents, (e) => /^pointer(move|down)/.test(e.k));
  // The canvas's post cannot be hooked (the page binds its post function at load); the host's receipt stands in.
  const hostDrop = hostEvents.find((e) => e.received !== undefined && e.received >= (tUp ?? 0) - 5);
  const drop = first(canvasPosts, (e) => e.k.startsWith('post dropTables')) ?? (hostDrop ? { t: hostDrop.received } : undefined);
  const fileAt = fileEvents[0]?.t;
  const inDom = nodeSamples.find((s) => s.n >= baseNodes + n && s.t >= (tUp ?? 0) - 5);
  const settled = inDom ? [...nodeSamples].reverse().find((s) => s.t >= inDom.t) : undefined;
  const timeline = [
    ...phases.map((p) => ({ t: p.t, frame: 'os', k: p.phase, n: 1 })),
    ...glassEvents, ...glassPosts, ...canvasEvents, ...canvasPosts, ...fileEvents, ...hostEvents,
    ...hostEvents.filter((e) => e.received !== undefined).map((e) => ({ t: e.received, frame: 'host', k: 'drop received (from the line above)', n: 1 })),
    ...nodeSamples.map((s) => ({ t: s.t, frame: 'nodes', k: `${s.n} nodes${s.moved ? ' (moved)' : ''}`, n: 1 })),
  ].filter((e) => verbose || !/^(pointerover|mousemove)/.test(e.k))
    .sort((x, y) => x.t - y.t);
  // Fold runs of node moves for reading.
  const lines = [];
  for (const e of timeline) {
    const prev = lines[lines.length - 1];
    if (prev && prev.frame === 'nodes' && e.frame === 'nodes' && prev.k === e.k) { prev.n++; prev.last = e.t; continue; }
    lines.push({ ...e });
  }
  const text = lines.map((e) => `${String(e.t - tUp).padStart(6)}ms ${e.frame.padEnd(6)} ${e.k}${e.n > 1 ? ` x${e.n}${e.last ? ` (to ${e.last - tUp}ms)` : ''}` : ''}`);
  const res = {
    round, n, variant, target: targetKind, selected, from, to,
    fileChanged: after !== pristine, nodesBefore: baseNodes, nodesAfter: nodeSamples[nodeSamples.length - 1]?.n ?? baseNodes, expected,
    glassLastDrag: glassLast,
    upToDragend: dragend ? dragend.t - tUp : undefined,
    upToCanvasPointer: canvasPointer ? canvasPointer.t - tUp : undefined,
    upToDropTables: drop ? drop.t - tUp : undefined,
    dropToFile: drop && fileAt ? fileAt - drop.t : undefined,
    fileToDom: fileAt && inDom ? inDom.t - fileAt : undefined,
    domToSettled: inDom && settled ? settled.t - inDom.t : undefined,
    upToVisible: inDom ? inDom.t - tUp : undefined,
    upToSettled: settled ? settled.t - tUp : undefined,
    // Where the first table landed against where the button came up, in canvas page pixels (the canvas's own
    // screen offset from its pointer events after the release): the add centres the first table on the drop point.
    placement: (() => {
      const off = offsets[0];
      const box = firstBoxes?.boxes.find((b) => b.id === names[0]);
      if (!off || !box) return undefined;
      const release = { x: to.x - off.x, y: to.y - off.y };
      return { release, tableCentreX: Math.round(box.x + box.w / 2), tableTop: Math.round(box.y), zoom: firstBoxes.zoom, dx: Math.round(box.x + box.w / 2 - release.x), dyTop: Math.round(box.y - release.y) };
    })(),
    layout: (/erd_layout: '''([\s\S]*?)'''/.exec(after)?.[1] ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean),
    phases: Object.fromEntries(phases.map((p) => [p.phase, p.t - tUp])),
    timeline: text,
  };
  results.push(res);
  console.log(`\n=== round ${round} N=${n} ${variant} -> ${targetKind}: fileChanged=${res.fileChanged} nodes ${baseNodes}->${res.nodesAfter} (want ${expected})`);
  console.log(`selected: ${JSON.stringify(selected)}  glass last drag event: ${JSON.stringify(glassLast)}`);
  console.log(`placement: ${JSON.stringify(res.placement)}  layout: ${JSON.stringify(res.layout)}`);
  console.log(text.join('\n'));
  console.log(`derived (ms from mouse-up): dragend ${res.upToDragend} | first canvas pointer ${res.upToCanvasPointer} | drop received by host ${res.upToDropTables} | drop->file ${res.dropToFile} | file->DOM ${res.fileToDom} | DOM->settled ${res.domToSettled} | VISIBLE ${res.upToVisible} | settled ${res.upToSettled}`);
  await wb.screenshot(path.join(out, `${round}-n${n}-${variant}-${targetKind}.jpg`));
  glassOuter.close();
  canvasOuter.close();
  // Put the diagram back and wait for the canvas to follow.
  if (after !== pristine) {
    fs.writeFileSync(diagramFile, pristine);
    await canvas.waitFor(`doc.querySelectorAll('.react-flow__node').length === ${baseNodes}`, { timeout: 10000, what: 'the restored diagram' }).catch(() => console.log('(the canvas did not return to the restored diagram in 10 s)'));
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  await sleep(1200);
}

try {
  for (let round = 0; round < repeat; round++) {
    for (const n of ns) for (const v of variants) await oneRun(round, n, v);
  }
} finally {
  if (fs.readFileSync(diagramFile, 'utf8') !== pristine) fs.writeFileSync(diagramFile, pristine);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log('\nsummary (ms from mouse-up; - = never):');
  console.log('round  N variant  target   dragend canvasPtr hostDrop   drop->file file->DOM DOM->settled VISIBLE settled  nodes');
  for (const r of results) {
    console.log(`${String(r.round).padStart(5)} ${String(r.n).padStart(2)} ${r.variant.padEnd(8)} ${r.target.padEnd(7)} ${ms(0, r.upToDragend)}   ${ms(0, r.upToCanvasPointer)}     ${ms(0, r.upToDropTables)}      ${ms(0, r.dropToFile)}     ${ms(0, r.fileToDom)}       ${ms(0, r.domToSettled)}   ${ms(0, r.upToVisible)}   ${ms(0, r.upToSettled)}  ${r.nodesBefore}->${r.nodesAfter}`);
  }
  console.log(`evidence: ${out}`);
  wb.close?.();
  canvas.close();
  glass.close();
  process.exit(0);
}
