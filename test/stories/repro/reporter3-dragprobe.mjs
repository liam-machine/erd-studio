// PROBE (reporter-feedback-3, Shift-drop): REAL OS drags (macOS only) from the
// Table Library onto the canvas, with every drag event recorded in all three
// frames on one clock: the workbench page, the webview's outer page (VS Code's
// index.html, an out-of-process iframe target) and the canvas page inside it
// (iframe#active-frame). Uses realdrag2.swift, which MOVES THE REAL POINTER.
//
//   node test/stories/repro/reporter3-dragdrop.mjs --only X --keep [--ext <built extension dir>]   # prints the CDP port
//   node test/stories/repro/reporter3-dragprobe.mjs --port <port> [--modes before,after,...] [--table dim_location] [--repeat 1] [--out dir] [--verbose]
//
// Modes are realdrag2.swift's (before, before-still, after, after-still,
// after-wiggle, after-out-in, early, none). Per drag it records: the helper's
// phases (mouse-down, shift-down, over-target, mouse-up, ...), each frame's drag
// events (target, shiftKey, defaultPrevented, dropEffect), pointer / mouse
// events that reach the canvas page after the drop, the webview element's
// pointer-events and VS Code's drop overlay, whether the diagram file changed
// (restored after), the notifications, the canvas notice and the active tab.
// `landed` = the diagram file changed or the canvas said the table is already
// on the diagram.

import { spawnSync } from 'node:child_process';
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
const modes = opt('--modes', 'before,after,early,none').split(',');
const table = opt('--table', 'dim_location');
const repeat = Number(opt('--repeat', '1'));
const verbose = args.includes('--verbose');
const out = opt('--out', fs.mkdtempSync('/tmp/g3probe-'));
fs.mkdirSync(out, { recursive: true });

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
const diagramFile = path.join(proj, '.erd-studio/silver/diagrams/showcase.dbml');

// One recorder, installed in a window: drag events (capture phase, so a
// handler's stopPropagation cannot hide one), with defaultPrevented / dropEffect
// read once the dispatch is over; key and pointer events too. Consecutive
// identical entries are folded (n, last).
const RECORDER = `(w, frame) => {
  w.__probe = [];
  if (w.__probeOn) return 1;
  w.__probeOn = true;
  const desc = (el) => !el || !el.tagName ? String(el && el.constructor && el.constructor.name) : el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const push = (e, extra) => {
    const l = w.__probe;
    const k = e.type + ' ' + desc(e.target) + (e.shiftKey ? ' +shift' : '') + (extra || '');
    const t = Date.now();
    const last = l[l.length - 1];
    if (last && last.k === k) { last.n++; last.last = t; return; }
    l.push({ t, frame, k, n: 1 });
  };
  for (const type of ['dragstart', 'drag', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) {
    w.addEventListener(type, (e) => {
      setTimeout(() => push(e, (e.defaultPrevented ? ' prevented' : '') + (e.dataTransfer ? ' de=' + e.dataTransfer.dropEffect : '')), 0);
    }, true);
  }
  for (const type of ['keydown', 'keyup']) w.addEventListener(type, (e) => { if (e.key === 'Shift') push(e); }, true);
  for (const type of ['pointerover', 'pointerenter', 'pointermove', 'pointerup', 'pointerdown', 'mousemove', 'mouseup', 'mouseover']) {
    w.addEventListener(type, (e) => push(e, ' buttons=' + e.buttons + (frame === 'wb' ? '' : ' @' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' mv=' + e.movementX + ',' + e.movementY + ' in ' + w.innerWidth + 'x' + w.innerHeight)), true);
  }
  return 1;
}`;

const results = [];
const libraryRow = `[...[...document.querySelectorAll('.part.sidebar .pane')].find(p => /TABLE LIBRARY/i.test(p.querySelector('.pane-header')?.textContent ?? '')).querySelectorAll('.monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(table)})`;
const toScreen = async (p) => {
  const w = await wb.ev(`({ x: window.screenX, y: window.screenY, top: window.outerHeight - window.innerHeight })`);
  return { x: Math.round(w.x + p.x), y: Math.round(w.y + w.top + p.y) };
};
// The Table Library's sticky rows (layer, schema) cover the rows under them when the list is scrolled: give it room.
await wb.ev(`(() => { const h=[...document.querySelectorAll('.part.sidebar .pane-header')].find(h => /^\\s*DIAGRAMS/i.test(h.querySelector('h3')?.textContent ?? '')); if (h && h.getAttribute('aria-expanded') === 'true') h.click(); })()`);
await sleep(600);
/** The row's centre, if a press there lands on the row itself (not a sticky row over it). */
const rowPoint = async () => wb.ev(`(() => { const r=${libraryRow}; if (!r) return null; const b=r.getBoundingClientRect(); const p={ x: b.x + Math.min(b.width/2, 160), y: b.y + b.height/2 }; const el=document.elementFromPoint(p.x, p.y); return el && r.contains(el) ? p : null; })()`);
const closeOtherTabs = () => wb.ev(`(() => { let n=0; for (const t of document.querySelectorAll('.tabs-container .tab')) { if (!/showcase/.test(t.getAttribute('aria-label') ?? '')) { t.querySelector('.tab-actions .action-label, .codicon-close')?.click(); n++; } } return n; })()`);

for (let round = 0; round < repeat; round++) {
  for (const mode of modes) {
    await closeOtherTabs();
    await wb.click(sel.tab('showcase.dbml')).catch(() => {});
    await sleep(700);
    const canvas = await Webview.find(wb);
    const outer = await attach(canvas.target);
    await wb.ev(`(${RECORDER})(window, 'wb')`);
    await outer.evaluate(`(${RECORDER})(window, 'outer')`);
    await outer.evaluate(`(${RECORDER})(document.querySelector('iframe#active-frame').contentWindow, 'canvas')`);
    // The webview element's pointer-events and the editor drop overlay, sampled.
    await wb.ev(`(() => { window.__samples=[]; clearInterval(window.__sampler); window.__sampler=setInterval(() => { const f=[...document.querySelectorAll('iframe')].find(f => (f.src||'').includes(${JSON.stringify(canvas.id)})); const s=(f?.style.pointerEvents||'unset')+(document.getElementById('monaco-workbench-editor-drop-overlay')?' +overlay':''); const l=window.__samples; if (!l.length || l[l.length-1].s!==s) l.push({s, t: Date.now()}); }, 15); return 1; })()`);
    await wb.ev(`[...document.querySelectorAll('.notification-toast-container .codicon-notifications-clear, .notification-toast-container .codicon-close')].forEach(b => b.click())`);
    const before = fs.readFileSync(diagramFile, 'utf8');
    const rowAt = await rowPoint();
    if (!rowAt) throw new Error(`the ${table} row is hidden (under a sticky row, or scrolled away): not dragging`);
    const from = await toScreen(rowAt);
    const r = await canvas.rect(`doc.querySelector('.react-flow__pane')`);
    const to = await toScreen({ x: r.x + r.width * 0.55, y: r.y + r.height * 0.75 });
    // The posted events go to whatever window is under the pointer: this VS Code must be in front, or nothing is dragged.
    const lock = spawnSync('bash', ['-c', `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked | grep -c '<true/>'`], { encoding: 'utf8' }).stdout.trim();
    if (lock !== '0') throw new Error('the screen is locked: no real drag can reach VS Code');
    // Another scripted window may hold the front for a while: wait for it (up to 2 minutes), never drag into it.
    let front = '';
    for (let tries = 0; tries < 40 && front !== String(proc.pid); tries++) {
      if (tries > 0) await sleep(3000);
      spawnSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${proc.pid}) to true`]);
      await sleep(400);
      front = spawnSync('osascript', ['-e', 'tell application "System Events" to get unix id of first process whose frontmost is true'], { encoding: 'utf8' }).stdout.trim();
    }
    if (front !== String(proc.pid)) throw new Error(`the scripted VS Code (pid ${proc.pid}) is not in front (pid ${front} is): not dragging`);
    const run = spawnSync(bin, [String(proc.pid), String(from.x), String(from.y), String(to.x), String(to.y), mode], { encoding: 'utf8' });
    const phases = run.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    await sleep(2500);
    const after = fs.readFileSync(diagramFile, 'utf8');
    const t0 = phases[0]?.t ?? Date.now();
    const wbEvents = await wb.ev(`window.__probe`);
    const outerEvents = await outer.evaluate(`window.__probe`).catch(() => []);
    const canvasEvents = await outer.evaluate(`document.querySelector('iframe#active-frame').contentWindow.__probe`).catch(() => []);
    const samples = await wb.ev(`(clearInterval(window.__sampler), window.__samples)`);
    const timeline = [
      ...phases.map((p) => ({ t: p.t, frame: 'os', k: `${p.phase}${p.osShift ? ' (os shift)' : ''}`, n: 1 })),
      ...samples.map((s) => ({ t: s.t, frame: 'pe', k: s.s, n: 1 })),
      ...wbEvents, ...outerEvents, ...canvasEvents,
    ].filter((e) => verbose || !/^(pointermove|mousemove|pointerover|mouseover)/.test(e.k) || e.frame !== 'wb')
      .sort((x, y) => x.t - y.t)
      .map((e) => `${String(e.t - t0).padStart(5)}ms ${e.frame.padEnd(6)} ${e.k}${e.n > 1 ? ` x${e.n} (to ${e.last - t0}ms)` : ''}`);
    const canvasNotice = await canvas.ev(`[...doc.querySelectorAll('[role=alert], [role=status]')].map(n => n.textContent.trim()).filter(Boolean)`).catch(() => []);
    const res = {
      round, mode, table, diagramFile,
      landed: before !== after || canvasNotice.some((n) => /already on/i.test(n)),
      fileChanged: before !== after,
      notifications: await wb.ev(`[...document.querySelectorAll('.notification-toast-container .notification-list-item-message')].map(n => n.textContent.trim())`),
      canvasNotice,
      activeTab: await wb.ev(`document.querySelector('.tabs-container .tab.active')?.getAttribute('aria-label')`),
      timeline,
    };
    results.push(res);
    console.log(`\n=== round ${round} ${mode} ${table}: landed=${res.landed} fileChanged=${res.fileChanged} tab=${res.activeTab}`);
    console.log(`notifications: ${JSON.stringify(res.notifications)}\ncanvasNotice: ${JSON.stringify(res.canvasNotice)}`);
    console.log(timeline.join('\n'));
    // --recover: after a drop nothing took, do what a person does next (move, then click the canvas) and record what arrives.
    if (args.includes('--recover') && !res.landed) {
      await outer.evaluate(`(${RECORDER})(window, 'outer')`).catch(() => {});
      await outer.evaluate(`(${RECORDER})(document.querySelector('iframe#active-frame').contentWindow, 'canvas')`).catch(() => {});
      await wb.ev(`(${RECORDER})(window, 'wb')`);
      const rec = spawnSync(bin, [String(proc.pid), String(to.x), String(to.y), String(to.x), String(to.y), 'recover'], { encoding: 'utf8' });
      const rphases = rec.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      await sleep(2000);
      const r0 = rphases[0]?.t ?? Date.now();
      const evs = [
        ...rphases.map((p) => ({ t: p.t, frame: 'os', k: p.phase, n: 1 })),
        ...await wb.ev(`window.__probe`), ...await outer.evaluate(`window.__probe`).catch(() => []),
        ...await outer.evaluate(`document.querySelector('iframe#active-frame').contentWindow.__probe`).catch(() => []),
      ].sort((x, y) => x.t - y.t).map((e) => `${String(e.t - r0).padStart(5)}ms ${e.frame.padEnd(6)} ${e.k}${e.n > 1 ? ` x${e.n}` : ''}`);
      const afterRecover = fs.readFileSync(diagramFile, 'utf8');
      res.recover = { landedAfter: afterRecover !== before, canvasNotice: await canvas.ev(`[...doc.querySelectorAll('[role=alert], [role=status]')].map(n => n.textContent.trim()).filter(Boolean)`).catch(() => []), timeline: evs };
      res.fileChanged = res.fileChanged || afterRecover !== before;
      console.log(`recover: landedAfter=${res.recover.landedAfter} notice=${JSON.stringify(res.recover.canvasNotice)}`);
      console.log(evs.join('\n'));
    }
    await wb.screenshot(path.join(out, `${round}-${mode}-${table}.jpg`));
    // --no-restore (a recording): leave the add on screen; the caller puts the diagram back from diagram-before.dbml.
    if (args.includes('--no-restore')) fs.writeFileSync(path.join(out, 'diagram-before.dbml'), before);
    else if (res.fileChanged) fs.writeFileSync(diagramFile, before);
    outer.close();
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    await sleep(1500);
  }
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
const tally = {};
for (const r of results) { tally[r.mode] ??= { landed: 0, runs: 0 }; tally[r.mode].runs++; if (r.landed) tally[r.mode].landed++; }
console.log(`\nsummary (${table}): ${Object.entries(tally).map(([m, v]) => `${m} ${v.landed}/${v.runs}`).join(', ')}`);
console.log(`evidence: ${out}`);
process.exit(0);
