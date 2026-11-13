// REPRO (gerhard-feedback-3, stage 1 diagnosis): REAL OS drags (macOS only) from
// the Table Library onto the canvas and onto a Diagrams row, with Shift pressed
// at different moments. CDP's Input.dispatchDragEvent never reaches the canvas
// webview (an out-of-process iframe), so this posts real HID events with
// realdrag.swift: it MOVES THE REAL POINTER for a few seconds per drag.
//
//   node test/stories/repro/gerhard3-dragdrop.mjs --only X --keep   # prints the CDP port
//   node test/stories/repro/gerhard3-realdrag.mjs --port <port> [--modes before,after,early,none] [--table dim_location] [--target canvas|row:ttt] [--repeat 3] [--out dir]
//
// For each drag it records: the drag events the canvas page saw (and whether
// they were preventDefault-ed), the webview element's pointer-events and VS
// Code's editor drop overlay while the pointer rests, whether the diagram file
// changed (restored after), the notifications and the active tab (a file the
// editor group opened instead).
//
// NOT YET RUN SUCCESSFULLY: in stage 1 the Mac's screen was locked
// (frontmost process: loginwindow), so the posted events reached no window.
// Run it with the screen unlocked and nobody touching the mouse.

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
const target = opt('--target', 'canvas');
const repeat = Number(opt('--repeat', '1'));
const out = opt('--out', fs.mkdtempSync('/tmp/g3rd-'));
fs.mkdirSync(out, { recursive: true });

const bin = '/tmp/g3-realdrag';
if (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(path.join(here, 'realdrag.swift')).mtimeMs) {
  const r = spawnSync('swiftc', ['-O', path.join(here, 'realdrag.swift'), '-o', bin], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`swiftc failed: ${r.stderr}`);
}

const wb = new Workbench({ port, pace: { glide: 0, settle: 100 } });
const canvas = await Webview.find(wb);
const outer = await attach(canvas.target);
const projRoot = await wb.ev(`document.title`); // e.g. "showcase.dbml — proj"
const ud = spawnSync('bash', ['-c', `ps -axo pid=,command= | grep -- '--remote-debugging-port' | grep -v grep | grep -v Helper`], { encoding: 'utf8' }).stdout
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => ({ pid: Number(l.split(' ')[0]), ud: /--user-data-dir=(\S+)/.exec(l)?.[1] }))
  .find((p) => p.ud && fs.existsSync(path.join(p.ud, 'DevToolsActivePort')) && fs.readFileSync(path.join(p.ud, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim() === String(port));
if (!ud) throw new Error(`no VS Code main process with CDP port ${port}`);
const proj = path.join(path.dirname(ud.ud), 'proj');
const diagramFile = path.join(proj, '.erd-studio/silver/diagrams/showcase.dbml');
const rowDiagramFile = (name) => path.join(proj, `.erd-studio/silver/diagrams/${name}.dbml`);

const results = [];
const libraryRow = `[...[...document.querySelectorAll('.part.sidebar .pane')].find(p => /TABLE LIBRARY/i.test(p.querySelector('.pane-header')?.textContent ?? '')).querySelectorAll('.monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(table)})`;
const diagramRow = (name) => `[...[...document.querySelectorAll('.part.sidebar .pane')].find(p => /^\\s*DIAGRAMS/i.test(p.querySelector('.pane-header h3')?.textContent ?? '')).querySelectorAll('.monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(name)})`;
/** Workbench CSS px → global screen points. */
const toScreen = async (p) => {
  const w = await wb.ev(`({ x: window.screenX, y: window.screenY, top: window.outerHeight - window.innerHeight })`);
  return { x: Math.round(w.x + p.x), y: Math.round(w.y + w.top + p.y) };
};

for (let round = 0; round < repeat; round++) {
  for (const mode of modes) {
    await wb.click(sel.tab('showcase.dbml')).catch(() => {});
    await sleep(500);
    // Watch: the canvas page's drag events; the workbench's webview pointer-events / drop overlay, sampled.
    await outer.evaluate(`(() => { const w=document.querySelector('iframe#active-frame').contentWindow; w.__dd=[]; if (!w.__ddOn) { w.__ddOn=true; for (const t of ['dragenter','dragover','dragleave','drop']) w.addEventListener(t, (e) => { const l=w.__dd; const k=t+(e.shiftKey?'+shift':'')+(e.defaultPrevented?' prevented':''); if (l.length && l[l.length-1].k===k) { l[l.length-1].n++; return; } l.push({k,n:1}); }, false); } return 1; })()`);
    await wb.ev(`(() => { window.__samples=[]; clearInterval(window.__sampler); window.__sampler=setInterval(() => { const el=document.querySelector('.webview.ready, .webview'); const s=(el?.style.pointerEvents||'unset')+(document.getElementById('monaco-workbench-editor-drop-overlay')?' +overlay':''); const l=window.__samples; if (!l.length || l[l.length-1].s!==s) l.push({s, t: Date.now()}); }, 20); return 1; })()`);
    await wb.ev(`[...document.querySelectorAll('.notification-toast-container .codicon-notifications-clear, .notification-toast-container .codicon-close')].forEach(b => b.click())`);
    const fileFor = target === 'canvas' ? diagramFile : rowDiagramFile(target.slice(4));
    const before = fs.readFileSync(fileFor, 'utf8');
    const from = await toScreen(await wb.center(libraryRow));
    let to;
    if (target === 'canvas') {
      const r = await canvas.rect(`doc.querySelector('.react-flow__pane')`);
      to = await toScreen({ x: r.x + r.width * 0.55, y: r.y + r.height * 0.75 });
    } else {
      to = await toScreen(await wb.center(diagramRow(target.slice(4))));
    }
    const t0 = Date.now();
    const run = spawnSync(bin, [String(ud.pid), String(from.x), String(from.y), String(to.x), String(to.y), mode], { encoding: 'utf8' });
    await sleep(2500);
    const after = fs.readFileSync(fileFor, 'utf8');
    const res = {
      round, mode, table, target,
      helper: (run.stdout + run.stderr).trim(),
      canvasEvents: await outer.evaluate(`document.querySelector('iframe#active-frame').contentWindow.__dd`),
      webviewPointerEvents: (await wb.ev(`(clearInterval(window.__sampler), window.__samples)`)).map((x) => `${x.t - t0}ms ${x.s}`),
      fileChanged: before !== after,
      notifications: await wb.ev(`[...document.querySelectorAll('.notification-toast-container .notification-list-item-message')].map(n => n.textContent.trim())`),
      canvasNotice: await canvas.ev(`[...doc.querySelectorAll('[role=alert], [role=status]')].map(n => n.textContent.trim()).filter(Boolean)`).catch(() => []),
      activeTab: await wb.ev(`document.querySelector('.tabs-container .tab.active')?.getAttribute('aria-label')`),
      title: projRoot,
    };
    results.push(res);
    console.log(JSON.stringify(res));
    await wb.screenshot(path.join(out, `${round}-${mode}-${table}-${target.replace(':', '_')}.jpg`));
    if (res.fileChanged) fs.writeFileSync(fileFor, before);
    await sleep(1500);
  }
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(`evidence: ${out}`);
process.exit(0);
