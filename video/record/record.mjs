#!/usr/bin/env node
// Records the default cut's footage in the real VS Code (see README.md, "Recording"):
//
//   node record/record.mjs                 every take (plain, big, then dbt)
//   node record/record.mjs --take dbt      one take
//   node record/record.mjs --dry           drive the scenes without filming (selectors, timing)
//   node record/record.mjs --dry --take plain --skip aiRun   the same, leaving scenes out (aiRun runs Claude Code)
//
// Needs build/timeline.json (npm run timeline) and the isolated profile (node record/vscode.mjs
// setup). For each take: its fixture folder written fresh (the dbt take's from the plain take's
// files), a fresh window, the take's off-camera prep, then each scene filmed for exactly its
// timeline duration with its clicks on its beats; a scene with props.fastForward is filmed for as
// long as its wait takes, and composite.mjs speeds that wait up (takeClock). Writes
// build/rec/<take>/ (frames, frames.jsonl, scenes.json, pointer.json) and record/takes.json (committed: each
// scene's filmed duration, how late its clicks ran, and the text that was on screen, which
// `npm test` checks).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { driver, sleep } from './driver.mjs';
import { makeBig, makeDbt, makePlain } from './fixtures.mjs';
import { SCENES, TAKES } from './scenes.mjs';
import { startScreencast } from './screencast.mjs';
import { takeClock } from './composite.mjs';
import { launch, quit } from './vscode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..', 'build');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const only = argv.includes('--take') ? argv[argv.indexOf('--take') + 1] : null;
// --dry --skip aiRun: a dry run that leaves scenes out (aiRun runs Claude Code, on your login)
const skip = argv.includes('--skip') ? argv[argv.indexOf('--skip') + 1].split(',') : [];
if (skip.length && !DRY) throw new Error('--skip is for --dry runs only: a take films every scene');

// Only the default cut is filmed: the logical cut plays its takes (script.logical.yaml recording.footage).
if (process.env.VARIANT) throw new Error(`VARIANT=${process.env.VARIANT}: only the default cut is recorded; this cut plays its footage (recording.footage). Run \`npm run record\` without VARIANT.`);
const timeline = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
if (!timeline.recording) throw new Error('build/timeline.json is not a recorded cut: run `npm run timeline` for script.yaml');
const { w: WIDTH, h: HEIGHT } = timeline.recording.inset;
const byId = Object.fromEntries(timeline.scenes.map((s) => [s.id, s]));

const takesFile = join(HERE, 'takes.json');
const takes = existsSync(takesFile) ? JSON.parse(readFileSync(takesFile, 'utf8')) : {};

for (const [name, take] of Object.entries(TAKES)) {
  if (only && only !== name) continue;
  const folder = { plain: makePlain, big: makeBig, dbt: makeDbt }[take.folder]();
  await launch(folder, take.chromiumFlags ?? []);
  const d = await driver();
  await take.prep?.(d);
  const dir = join(BUILD, 'rec', name);
  const cast = DRY ? null : await startScreencast(dir, { width: WIDTH, height: HEIGHT });
  const filmed = [];
  try {
    for (const id of take.scenes) {
      if (skip.includes(id)) continue;
      const scene = byId[id];
      if (!scene) throw new Error(`scene ${id} is not in build/timeline.json`);
      const spec = SCENES[id];
      await spec.prep?.(d);
      await cast?.poke();
      await sleep(120);
      const t0 = Date.now() / 1000;
      const now = () => Date.now() / 1000 - t0;
      let late = 0;
      // the fast-forward, when the scene has one: a and b in take time, o in the video's
      const until = scene.props?.fastForward?.until;
      const o = until ? scene.beats[until[0]].t + until[1] : null;
      let ff = null;
      let clock = takeClock(null);
      /** Wait until s seconds into the scene, in the video's time. */
      const at = async (s) => {
        if (ff === 'running') throw new Error(`${id}: at(${s}) during the fast-forward`);
        const target = clock(s);
        const wait = (t0 + target) * 1000 - Date.now();
        if (wait > 0) await sleep(wait); else late = Math.max(late, -wait / 1000);
      };
      const fastForward = {
        start() {
          if (o === null) throw new Error(`${id}: ff.start() but the scene has no props.fastForward`);
          const a = now();
          if (a > o - 0.5) throw new Error(`${id}: the fast-forward starts at ${a.toFixed(2)}s, too close to its end (${o.toFixed(2)}s)`);
          ff = 'running';
          fastForward.a = a;
        },
        async end() {
          const a = fastForward.a;
          let b = now();
          // done sooner than the video's window: no speed-up, it plays in real time
          if (b < o) { await sleep((o - b) * 1000); b = o; }
          ff = { a: +a.toFixed(3), b: +b.toFixed(3), o: +o.toFixed(3) };
          clock = takeClock(ff);
        },
      };
      const text = new Set();
      const term = new Set();
      // what is on screen, sampled about every 0.6 s while the scene runs (in parallel with the clicks),
      // the terminal's rows apart (the privacy check reads them)
      let sampling = true;
      const sampler = (async () => { while (sampling) {
        try { for (const x of await d.screenText()) text.add(x); } catch {}
        try { for (const x of await d.terminalText()) term.add(x.trim()); } catch {}
        await sleep(600); } })();
      // what a scene measured on camera (the scale scene's routing time), kept in record/takes.json
      const notes = {};
      const note = (o) => Object.assign(notes, o);
      // REC_SHOTS=<dir>: a dry run's look at the window mid-scene (no-op otherwise)
      const shot = async (label) => { if (!process.env.REC_SHOTS || !DRY) return; mkdirSync(process.env.REC_SHOTS, { recursive: true }); writeFileSync(join(process.env.REC_SHOTS, `${name}-${id}-${label}.png`), Buffer.from(await d.screenshot(), 'base64')); };
      /** Wait until s seconds into the scene unless it is already past (no lateness counted: the step it waits for has no fixed time). */
      const notBefore = async (s) => { if (!ff || ff !== 'running') { const target = clock(s); const wait = (t0 + target) * 1000 - Date.now(); if (wait > 0) await sleep(wait); } };
      await spec.run(d, { at, notBefore, beats: scene.beats, dur: scene.dur, scene, ff: fastForward, note, shot });
      if (ff === 'running') throw new Error(`${id}: ff.start() without ff.end()`);
      const busyTake = now();
      // the clicks' end, in the video's time
      const busyUntil = !ff ? busyTake : busyTake >= ff.b ? ff.o + (busyTake - ff.b) : ff.o;
      await at(scene.dur - 0.15);
      sampling = false;
      await sampler;
      await at(scene.dur);
      const over = Math.max(0, busyUntil - scene.dur);
      const speed = ff ? (ff.b - ff.a) / (ff.o - ff.a) : 1;
      console.log(`${id.padEnd(11)} ${scene.dur.toFixed(2)}s  actions done at ${busyUntil.toFixed(2)}s${ff ? `  (sped up ${speed.toFixed(1)}x from ${ff.a}s)` : ''}${late ? `  (a click ran ${late.toFixed(2)}s late)` : ''}${over ? '  OVER' : ''}${Object.keys(notes).length ? `  ${JSON.stringify(notes)}` : ''}`);
      filmed.push({ id, t0, dur: scene.dur, filmed: +clock(scene.dur).toFixed(3), ...(ff ? { ff } : {}), busy: +busyUntil.toFixed(2), late: +late.toFixed(2), notes, text: [...text].sort(), term: [...term] });
      await cast?.poke();
      // REC_SHOTS=<dir> (a dry run's check): the window at the end of each scene
      if (process.env.REC_SHOTS && DRY) { mkdirSync(process.env.REC_SHOTS, { recursive: true }); writeFileSync(join(process.env.REC_SHOTS, `${name}-${id}.png`), Buffer.from(await d.screenshot(), 'base64')); }
    }
  } finally {
    const n = await cast?.stop();
    d.close();
    await quit();
    if (cast) console.log(`${name}: ${n} frames -> ${dir}`);
  }
  if (DRY) continue;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scenes.json'), JSON.stringify(filmed.map(({ text, term, notes, ...s }) => s), null, 1));
  // the pointer's path (composite.mjs draws the pointer from it)
  writeFileSync(join(dir, 'pointer.json'), JSON.stringify(d.trail));
  for (const s of filmed) takes[s.id] = { take: name, dur: s.dur, busy: s.busy, late: s.late, ...(s.ff ? { ff: s.ff } : {}), ...(Object.keys(s.notes).length ? { notes: s.notes } : {}), screenText: s.text, ...(s.term.length ? { terminalText: s.term } : {}) };
}
if (!DRY) {
  // only this timeline's recorded scenes (a scene the script no longer has is dropped)
  const order = timeline.scenes.filter((s) => s.module.startsWith('rec/')).map((s) => s.id);
  const sorted = Object.fromEntries(Object.entries(takes).filter(([id]) => order.includes(id)).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)));
  writeFileSync(takesFile, JSON.stringify(sorted, null, 1) + '\n');
  console.log(`wrote ${takesFile}`);
}
