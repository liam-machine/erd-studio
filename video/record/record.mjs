#!/usr/bin/env node
// Records the default cut's footage in the real VS Code (see README.md, "Recording"):
//
//   node record/record.mjs                 every take (plain, then dbt)
//   node record/record.mjs --take dbt      one take
//   node record/record.mjs --dry           drive the scenes without filming (selectors, timing)
//
// Needs build/timeline.json (npm run timeline) and the isolated profile (node record/vscode.mjs
// setup). For each take: fresh fixture folders, a fresh window, the take's off-camera prep, then
// each scene filmed for exactly its timeline duration with its clicks on its beats. Writes
// build/rec/<take>/ (frames, frames.jsonl, scenes.json, pointer.json) and record/takes.json (committed: each
// scene's filmed duration, how late its clicks ran, and the text that was on screen, which
// `npm test` checks).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { driver, sleep } from './driver.mjs';
import { makeFixtures } from './fixtures.mjs';
import { SCENES, TAKES } from './scenes.mjs';
import { startScreencast } from './screencast.mjs';
import { launch, quit } from './vscode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..', 'build');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const only = argv.includes('--take') ? argv[argv.indexOf('--take') + 1] : null;

const timeline = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
if (!timeline.recording) throw new Error('build/timeline.json is not a recorded cut: run `npm run timeline` for script.yaml');
const { w: WIDTH, h: HEIGHT } = timeline.recording.inset;
const byId = Object.fromEntries(timeline.scenes.map((s) => [s.id, s]));

const takesFile = join(HERE, 'takes.json');
const takes = existsSync(takesFile) ? JSON.parse(readFileSync(takesFile, 'utf8')) : {};

for (const [name, take] of Object.entries(TAKES)) {
  if (only && only !== name) continue;
  const folders = makeFixtures();
  await launch(folders[take.folder]);
  const d = await driver();
  await take.prep?.(d);
  const dir = join(BUILD, 'rec', name);
  const cast = DRY ? null : await startScreencast(dir, { width: WIDTH, height: HEIGHT });
  const filmed = [];
  try {
    for (const id of take.scenes) {
      const scene = byId[id];
      if (!scene) throw new Error(`scene ${id} is not in build/timeline.json`);
      const spec = SCENES[id];
      await spec.prep?.(d);
      await cast?.poke();
      await sleep(120);
      const t0 = Date.now() / 1000;
      let late = 0;
      const at = async (s) => { const wait = (t0 + s) * 1000 - Date.now(); if (wait > 0) await sleep(wait); else late = Math.max(late, -wait / 1000); };
      const text = new Set();
      // what is on screen, sampled about every 0.6 s while the scene runs (in parallel with the clicks)
      let sampling = true;
      const sampler = (async () => { while (sampling) { try { for (const x of await d.screenText()) text.add(x); } catch {} await sleep(600); } })();
      await spec.run(d, { at, beats: scene.beats, dur: scene.dur, scene });
      const busyUntil = Date.now() / 1000 - t0;
      await at(scene.dur - 0.15);
      sampling = false;
      await sampler;
      await at(scene.dur);
      const over = Math.max(0, busyUntil - scene.dur);
      console.log(`${id.padEnd(11)} ${scene.dur.toFixed(2)}s  actions done at ${busyUntil.toFixed(2)}s${late ? `  (a click ran ${late.toFixed(2)}s late)` : ''}${over ? '  OVER' : ''}`);
      filmed.push({ id, t0, dur: scene.dur, busy: +busyUntil.toFixed(2), late: +late.toFixed(2), text: [...text].sort() });
      await cast?.poke();
    }
  } finally {
    const n = await cast?.stop();
    d.close();
    await quit();
    if (cast) console.log(`${name}: ${n} frames -> ${dir}`);
  }
  if (DRY) continue;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scenes.json'), JSON.stringify(filmed.map(({ text, ...s }) => s), null, 1));
  // the pointer's path (composite.mjs draws the pointer from it)
  writeFileSync(join(dir, 'pointer.json'), JSON.stringify(d.trail));
  for (const s of filmed) takes[s.id] = { take: name, dur: s.dur, busy: s.busy, late: s.late, screenText: s.text };
}
if (!DRY) {
  const order = timeline.scenes.map((s) => s.id);
  const sorted = Object.fromEntries(Object.entries(takes).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)));
  writeFileSync(takesFile, JSON.stringify(sorted, null, 1) + '\n');
  console.log(`wrote ${takesFile}`);
}
