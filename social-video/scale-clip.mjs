#!/usr/bin/env node
// The launch cut's scale footage (player/scenes/launch/scale.js): a REAL render of a 2,000-table
// diagram by @erd-studio/renderer's ErdCanvas (built from packages/*/src, with the line-routing
// worker inlined exactly as the extension and the npm package inline it), recorded in Playwright
// Chromium and written as numbered JPEG frames the pure scene composites at 30 fps.
//
//   VARIANT=launch node scale-clip.mjs          (after tts + timeline: it fits the clip to the scene)
//
// Steps (everything under build-launch/, gitignored):
//   1. video/record/bigProject.mjs writes the project (2.0 layer-first DBML, one diagram of
//      ~2,000 positioned tables) into build-launch/big/.
//   2. core's loadDisplaySubjectArea + dbmlStorageReader read that diagram into a DisplaySubjectArea
//      (big.display.json), as the Confluence app and the extension do.
//   3. A page renders it with ErdCanvas in viewer mode (logicalOnly: no dbt project), dark theme.
//   4. The take, ONE real-time CDP screencast in Chrome from page load to the end of the scene (no
//      stepping, no speed-up: what the canvas paints is what the video shows, the last painted
//      frame held until the next), with the actions scheduled on the scene's clock:
//      open   the first draw (onReady) is scene time CLIP_AT; the routed pass (the root's
//             data-edge-routing turns `routed …`) is MEASURED and written to clip/meta.json as
//             routedSec (the scene's routing chip switches then; no seconds on screen). A take whose lines land
//             too late for the scene is re-shot (3 tries).
//      zoom   mouse-wheel steps anchored on the target table, toward an eased target scale.
//      hover  the pointer glides onto the table (its path goes to meta.json: screenshots have no
//             cursor, the scene draws it), and rests: the hover preview fades the rest of the
//             diagram and the arrows flow along the table's lines (EdgeFlow), in real time.
//   No drags anywhere.
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const VARIANT = process.env.VARIANT ?? 'launch';
const BUILD = join(HERE, `build-${VARIANT}`);
const BIG = join(BUILD, 'big');
const WEB = join(BUILD, 'scale-web');
const CLIP = join(BUILD, 'clip');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const FPS = 30;
// The clip box in the frame (scene: launch/scale.js CLIP) and the render's CSS size: the CSS
// viewport is wider than the box so the fitted overview holds the whole diagram above the
// canvas's 0.05 minimum zoom; the device scale factor brings the pixels back to 2x the box.
const BOX = { w: 952, h: 690 };
const CSS = { w: 1360, h: Math.round(1360 * BOX.h / BOX.w) };
const DPR = (2 * BOX.w) / CSS.w;
const TARGET = process.env.TARGET ?? 'dim_store';
const ZOOM_TO = Number(process.env.ZOOM_TO ?? 0.8);
// Where the target table ends up after the zoom, as a fraction of the box.
const LAND = { x: 0.42, y: 0.4 };

// The scene this clip fills: its length and when the hover line starts.
const timeline = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
const scene = timeline.scenes.find((s) => s.module === 'launch/scale');
if (!scene) throw new Error('no launch/scale scene in the timeline');
const CLIP_AT = 0.5;                                       // scene time of the canvas's first draw
const PLAN = {
  zoomAt: 1.3, zoomDur: 1.4,                               // scene seconds: into one corner while the lines are still routing
  moveAt: scene.beats.hover.t - 0.1, moveDur: 0.9,
  end: scene.dur,
};

// ---- 1. the project ----
if (!has('reuse')) {
  rmSync(BIG, { recursive: true, force: true });
  execFileSync('node', [join(ROOT, 'video/record/bigProject.mjs'), BIG], { stdio: 'inherit' });
}

// ---- 2. the DisplaySubjectArea ----
mkdirSync(WEB, { recursive: true });
const DIAGRAM = join(BIG, '.erd-studio/gold/diagrams/enterprise_warehouse.dbml');
writeFileSync(join(WEB, 'display.ts'), `import { readFile, writeFile } from 'node:fs/promises';
import { loadDisplaySubjectArea } from '@erd-studio/core';
import { dbmlStorageReader } from '@erd-studio/core/dbml';
const domain = await loadDisplaySubjectArea({
  domainPath: ${JSON.stringify(DIAGRAM)},
  readFile: (p) => readFile(p, 'utf8').catch(() => null),
  readOnly: true,
  dbml: dbmlStorageReader,
  warn: (m) => console.warn('[load]', m),
});
await writeFile(${JSON.stringify(join(WEB, 'display.json'))}, JSON.stringify(domain));
console.log('display.json:', domain.models.length, 'tables,', domain.relationships.length, 'relationships');
`);
const coreAlias = {
  '@erd-studio/core/dbml': join(ROOT, 'packages/core/src/dbml/index.ts'),
  '@erd-studio/core': join(ROOT, 'packages/core/src/index.ts'),
};
await build({
  entryPoints: [join(WEB, 'display.ts')], bundle: true, outfile: join(WEB, 'display.mjs'), format: 'esm', platform: 'node',
  logLevel: 'warning', nodePaths: [join(ROOT, 'node_modules')], alias: coreAlias,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
execFileSync('node', [join(WEB, 'display.mjs')], { stdio: 'inherit' });
const display = JSON.parse(readFileSync(join(WEB, 'display.json'), 'utf8'));
const tables = display.models.length, relationships = display.relationships.length;

// ---- 3. the page ----
writeFileSync(join(WEB, 'entry.tsx'), `import { createRoot } from 'react-dom/client';
import { ErdCanvas } from '@erd-studio/renderer';
import '@erd-studio/renderer/styles.css';
(async () => {
  const domain = await (await fetch('display.json')).json();
  const root = document.getElementById('root')!;
  // The routed pass lands as data-edge-routing="routed <ms>ms <n>" on the React Flow root.
  new MutationObserver(() => {
    const flow = root.querySelector('.react-flow') as HTMLElement | null;
    const r = flow?.dataset.edgeRouting;
    if (r && r.startsWith('routed') && !(window as any).__routedAt) { (window as any).__routedAt = Date.now(); (window as any).__routing = r; }
  }).observe(root, { attributes: true, subtree: true, attributeFilter: ['data-edge-routing'] });
  (window as any).__mountAt = Date.now();
  createRoot(root).render(
    <ErdCanvas domain={domain} logicalOnly onReady={() => { (window as any).__readyAt = Date.now(); }} />,
  );
})();
`);
// A dark VS Code theme, as the extension's canvas looks in Dark Modern, tuned to the video's cards.
const VARS = {
  'editor-background': '#16171b', 'editor-foreground': '#e9ecef', 'sideBar-background': '#1a1b1f',
  'panel-border': '#2c2c30', 'editorGroup-border': '#2c2c30', 'button-background': '#0e639c',
  'button-foreground': '#ffffff', 'button-hoverBackground': '#1177bb', 'input-background': '#1f2126',
  'input-foreground': '#e9ecef', 'input-border': '#3a3d45', 'focusBorder': '#0e639c',
  'editor-selectionBackground': '#264f78', 'editor-inactiveSelectionBackground': '#3a3d41',
  'errorForeground': '#f48771', 'editorWarning-foreground': '#cca700', 'descriptionForeground': '#8b9099',
  'font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 'font-size': '13px', 'font-weight': '400',
  'editor-font-family': "'SF Mono', Menlo, Consolas, monospace", 'charts-green': '#89d185', 'charts-purple': '#b180d7',
  'editorHoverWidget-background': '#202126', 'editorHoverWidget-border': '#3a3d45', 'editorHoverWidget-foreground': '#e9ecef',
  'editorWidget-background': '#202126', 'list-activeSelectionBackground': '#04395e', 'list-activeSelectionForeground': '#ffffff',
  'textLink-foreground': '#3794ff', 'textLink-activeForeground': '#3794ff',
};
writeFileSync(join(WEB, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="out.css">
<style>html,body,#root{margin:0;padding:0;width:100%;height:100vh;overflow:hidden;background:${VARS['editor-background']}}
:root{${Object.entries(VARS).map(([k, v]) => `--vscode-${k}:${v}`).join(';')}}</style></head>
<body data-vscode-theme-kind="vscode-dark"><div id="root"></div><script src="out.js"></script></body></html>`);
const require = createRequire(import.meta.url);
const { edgeRoutingWorkerDefine } = require(join(ROOT, 'packages/renderer/scripts/edgeRoutingWorker.cjs'));
await build({
  entryPoints: [join(WEB, 'entry.tsx')], bundle: true, outfile: join(WEB, 'out.js'), format: 'iife', platform: 'browser',
  jsx: 'automatic', loader: { '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'warning', minify: true,
  nodePaths: [join(ROOT, 'node_modules')], tsconfig: join(ROOT, 'tsconfig.webview.json'),
  define: { 'process.env.NODE_ENV': '"production"', __ELK_WORKER_CODE__: '""', ...edgeRoutingWorkerDefine() },
  alias: {
    '@erd-studio/renderer/styles.css': join(ROOT, 'packages/renderer/src/styles.css'),
    '@erd-studio/renderer': join(ROOT, 'packages/renderer/src/index.ts'),
    ...coreAlias,
  },
});

// ---- 4. the take: one real-time screencast, actions scheduled on the scene's clock ----
// Served over http (fetch of display.json; a worker from a blob URL needs a real origin).
const { startServer } = await import('./serve.mjs');
const server = await startServer(0);
const url = `http://127.0.0.1:${server.address().port}/social-video/build-${VARIANT}/scale-web/index.html`;
const browser = await chromium.launch({ channel: process.env.CHANNEL ?? 'chrome', args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
const sleepUntil = (at) => new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const scaleNow = (page) => page.evaluate(() => Number(/scale\(([\d.]+)\)/.exec(document.querySelector('.react-flow__viewport').style.transform)?.[1] ?? 1));
const rectOf = (page, id) => page.evaluate((id) => {
  const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}, id);

// B: zoom, real time. The pointer is parked off the tables (a pointer resting on a table starts its
// hover preview, which stalls a zoom at this size); each step is one wheel event dispatched to the
// pane as a trackpad sends it, toward an eased target scale, as fast as the canvas paints (React
// Flow / d3-zoom: scale *= 2^(-deltaY * 0.002), deltaMode 0). Every step is anchored on the one
// point that carries the target table to LAND in the box: zooming by k about A moves T to
// A + k (T - A), so A = (k T - C) / (k - 1), re-aimed from the table's current box while the
// remaining zoom is large.
async function zoomInto(page) {
  return page.evaluate(async ({ target, zoomTo, dur, land }) => {
    const vp = document.querySelector('.react-flow__viewport');
    const pane = document.querySelector('.react-flow__pane');
    const node = document.querySelector(`.react-flow__node[data-id="${CSS.escape(target)}"]`);
    const scale = () => Number(/scale\(([\d.]+)\)/.exec(vp.style.transform)?.[1] ?? 1);
    const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
    const z0 = scale(), k = zoomTo / z0;
    const C = { x: innerWidth * land.x, y: innerHeight * land.y };
    let A = null;
    const start = Date.now(), steps = [];
    for (;;) {
      const p = Math.min(1, (Date.now() - start) / dur);
      const want = z0 * Math.pow(k, ease(p));
      // Re-aim while plenty of zoom is left (the anchor is unstable as the remaining zoom nears 1).
      const kr = zoomTo / scale();
      if (!A || kr > 1.6) {
        const r = node.getBoundingClientRect();
        const T = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        A = { x: (kr * T.x - C.x) / (kr - 1), y: (kr * T.y - C.y) / (kr - 1) };
      }
      const s = performance.now();
      const dy = -Math.log2(want / scale()) / 0.002;
      if (Math.abs(dy) > 0.5) pane.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: A.x, clientY: A.y, bubbles: true, cancelable: true }));
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      steps.push(performance.now() - s);
      if (p >= 1) break;
    }
    steps.sort((a, b) => a - b);
    return { z0, z1: scale(), n: steps.length, median: Math.round(steps[steps.length >> 1]) };
  }, { target: TARGET, zoomTo: ZOOM_TO, dur: PLAN.zoomDur * 1000, land: LAND });
}

async function take() {
  const page = await browser.newPage({ viewport: { width: CSS.w, height: CSS.h }, deviceScaleFactor: DPR });
  page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
  const cdp = await page.context().newCDPSession(page);
  const shots = [];   // { at: epoch ms, data: base64 jpeg }
  cdp.on('Page.screencastFrame', (f) => {
    shots.push({ at: f.metadata.timestamp * 1000, data: f.data });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 2 * BOX.w, maxHeight: 2 * BOX.h, everyNthFrame: 1 });
  const navAt = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.__readyAt, null, { timeout: 120000 });
  // B, while the lines are still routing, so they settle in the zoomed view.
  const readyAt0 = await page.evaluate(() => window.__readyAt);
  await page.mouse.move(4, 4);
  await sleepUntil(readyAt0 + (PLAN.zoomAt - CLIP_AT) * 1000);
  const zoom = await zoomInto(page);
  await page.waitForFunction(() => window.__routedAt, null, { timeout: 120000 });
  const marks = await page.evaluate(() => ({ readyAt: window.__readyAt, routedAt: window.__routedAt, routing: window.__routing }));
  const at = (x) => marks.readyAt + (x - CLIP_AT) * 1000;          // scene seconds -> epoch ms
  const routedSec = (marks.routedAt - marks.readyAt) / 1000;
  console.log(`take: first draw ${((marks.readyAt - navAt) / 1000).toFixed(2)} s after navigation; lines routed ${routedSec.toFixed(2)} s after it (${marks.routing})`);
  if (marks.routedAt > at(PLAN.moveAt) - 1000) {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await page.close();
    return { retry: true, routedSec };
  }

  const zoomStepMs = zoom.median;
  console.log(`zoom: ${zoom.z0.toFixed(3)} -> ${zoom.z1.toFixed(3)} in ${zoom.n} steps (median ${zoom.median} ms a step, real time)`);

  // C: the pointer. The scene draws it gliding in (screenshots have no cursor); the real pointer
  // arrives on the table the moment the drawn one does, and rests there: the hover preview and
  // the flowing arrows follow in real time.
  const r = await rectOf(page, TARGET);
  const from = { x: CSS.w * 0.86, y: CSS.h * 0.9 };
  const to = { x: r.x + Math.min(r.w * 0.55, 150), y: r.y + Math.min(30, r.h * 0.25) };
  const moves = [];
  for (let k = 0; k <= 30; k++) {
    const e = ease(k / 30);
    moves.push({ at: at(PLAN.moveAt + (PLAN.moveDur * k) / 30), x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
  }
  await sleepUntil(at(PLAN.moveAt + PLAN.moveDur));
  await page.mouse.move(to.x, to.y);
  await page.waitForFunction(() => document.querySelector('.erd-flow--hover-focus'), null, { timeout: 5000 }).catch(() => console.warn('no hover-focus class seen'));
  const hoverAt = Date.now();
  const flows = await page.evaluate(() => document.querySelectorAll('animateMotion').length);
  await sleepUntil(at(PLAN.end) + 300);
  await cdp.send('Page.stopScreencast');
  await page.close();
  return { marks, routedSec, shots, moves, zoomStepMs, flows, hoverAt, navAt };
}

let res;
for (let attempt = 1; attempt <= 3; attempt++) {
  res = await take();
  if (!res.retry) break;
  console.warn(`attempt ${attempt}: the lines landed at ${res.routedSec.toFixed(2)} s, too late for the scene's hover at ${PLAN.moveAt} s; again`);
}
if (res.retry) throw new Error('the routed pass never landed in time for the hover; is the machine busy?');

// ---- 5. frames: the screencast placed on the scene clock, the last painted frame held ----
rmSync(CLIP, { recursive: true, force: true });
mkdirSync(CLIP, { recursive: true });
const { marks, shots, moves } = res;
const total = Math.round((PLAN.end - CLIP_AT) * FPS);
const toBox = (pt) => ({ x: +((pt.x * BOX.w) / CSS.w).toFixed(1), y: +((pt.y * BOX.h) / CSS.h).toFixed(1) });
const pointer = [];
let used = 0;
for (let k = 0; k < total; k++) {
  const t = marks.readyAt + (k * 1000) / FPS;
  let shot = shots.find((s) => s.at >= marks.readyAt - 50) ?? shots[0];
  for (const s of shots) if (s.at <= t && s.at >= shot.at) shot = s;
  writeFileSync(join(CLIP, `f${String(k).padStart(4, '0')}.jpg`), Buffer.from(shot.data, 'base64'));
  let m = null;
  for (const mv of moves) if (mv.at <= t) m = mv;
  pointer.push(m && toBox(m));
  used++;
}
const distinct = new Set(shots.filter((s) => s.at >= marks.readyAt && s.at <= marks.readyAt + total * 1000 / FPS).map((s) => s.at)).size;
const meta = {
  fps: FPS, frames: used, clipAt: CLIP_AT, box: BOX, css: CSS, dpr: +DPR.toFixed(4), target: TARGET,
  tables, relationships,
  routedSec: +res.routedSec.toFixed(2), routing: marks.routing,
  firstDrawSec: +((marks.readyAt - res.navAt) / 1000).toFixed(2),
  zoomStepMs: res.zoomStepMs, flows: res.flows, hoverSec: +((res.hoverAt - marks.readyAt) / 1000 + CLIP_AT).toFixed(2),
  paintedFrames: distinct, plan: PLAN, pointer,
  recordedAt: new Date().toISOString(),
};
writeFileSync(join(CLIP, 'meta.json'), JSON.stringify(meta));
console.log(`clip: ${used} frames (${distinct} painted) -> ${CLIP}; lines routed ${res.routedSec.toFixed(2)} s after the first draw; ${res.flows} moving arrows on ${TARGET}`);
await browser.close();
server.close();
