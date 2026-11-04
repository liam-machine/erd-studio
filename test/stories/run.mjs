#!/usr/bin/env node
// Onboarding stories: user stories as code, run against a real VS Code with
// the extension, each optionally filmed as a captioned MP4.
//
//   node test/stories/run.mjs [--record] [--narrate] [--only <id|substring>] [--keep] [--headed-slow] [--no-build] [--list]
//
//   --record       film each story: test/stories/out/<id>.mp4 (+ .srt)
//   --narrate      with --record: speak each caption (or the step's `say`) in the getting-started tour's voice
//                  (Kokoro via uv: test/stories/lib/tts.py, lines cached in test/stories/.cache/); a frame is held
//                  wherever a line runs past the next caption. Needs uv; nothing else does
//   --only X       run the stories whose id or file name contains X (repeatable, or comma-separated)
//   --keep         keep each story's temp folder (/tmp/erds-…: profile, workspace, frames) and print it
//   --headed-slow  slow pacing, to watch a story run (implies the record pacing, slower)
//   --no-build     skip `npm run build` (use the dist/ already there)
//   --list         list the stories and exit
//
// Every story runs in its own fresh profile, workspace copy and CDP port; its
// VS Code processes are killed by --user-data-dir, and its temp folders removed
// (unless --keep), whatever happens, Ctrl+C included. Writes
// out/<id>.log, out/<id>.vscode.log, out/<id>-failure.jpg and out/<id>-logs/
// (VS Code's own logs) on failure, and out/summary.json. Exits 1 on any failed story.
// See docs/dev/onboarding-stories.md.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { sleep } from './lib/act.mjs';
import { REPO, buildExtension, killByProfile, launchVSCode, packageVsix, shortTempDir, stageExtension } from './lib/launch.mjs';
import { Recorder } from './lib/recorder.mjs';
import { PACES, StepFailure, StoryContext, failureScreenshot } from './lib/story.mjs';
import { narratorProblem } from './lib/narrate.mjs';
import { encode } from './lib/video.mjs';
import { prepareWorkspace } from './lib/workspaces.mjs';

const HERE = path.join(REPO, 'test/stories');
const OUT = path.join(HERE, 'out');
const STORIES = path.join(HERE, 'stories');

function parseArgs(argv) {
  const opts = { record: false, narrate: false, only: [], keep: false, slow: false, build: true, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--record') opts.record = true;
    else if (a === '--narrate') opts.narrate = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--headed-slow') opts.slow = true;
    else if (a === '--no-build') opts.build = false;
    else if (a === '--list') opts.list = true;
    else if (a === '--only') opts.only.push(...String(argv[++i] ?? '').split(',').filter(Boolean));
    else if (a.startsWith('--only=')) opts.only.push(...a.slice(7).split(',').filter(Boolean));
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
    else { console.error(`unknown option ${a} (see --help)`); process.exit(2); }
  }
  return opts;
}

async function loadStories(only) {
  const files = fs.readdirSync(STORIES).filter((f) => f.endsWith('.story.mjs')).sort();
  const stories = [];
  for (const file of files) {
    const def = (await import(pathToFileURL(path.join(STORIES, file)).href)).default;
    if (!def?.id) throw new Error(`${file}: export default story({ … })`);
    stories.push({ file, def });
  }
  const ids = new Set();
  for (const { def, file } of stories) {
    if (ids.has(def.id)) throw new Error(`${file}: duplicate story id ${def.id}`);
    ids.add(def.id);
  }
  return only.length ? stories.filter(({ file, def }) => only.some((o) => def.id.includes(o) || file.includes(o))) : stories;
}

/** Profiles of the VS Code instances still running, killed on any exit. */
const live = new Set();
/** Temp folders still on disk → whether --keep keeps them (a story's) or not (the staged extension). */
const temps = new Map();
let keepTemps = false;
function killAll() {
  for (const ud of live) killByProfile(ud);
  live.clear();
}
/** Remove the temp folders a run still holds (a signal skips the `finally` blocks that would). */
function removeTemps() {
  for (const [dir, keepable] of temps) {
    if (keepable && keepTemps) console.log(`[stories] kept ${dir}`);
    else fs.rmSync(dir, { recursive: true, force: true });
  }
  temps.clear();
}
/** A temp folder that is removed on any exit unless `keepable` and --keep. */
function tempDir(prefix, keepable) {
  const dir = shortTempDir(prefix);
  temps.set(dir, keepable);
  return dir;
}
function dropTemp(dir, { keep = false } = {}) {
  temps.delete(dir);
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { killAll(); removeTemps(); process.exit(130); });
}
process.on('exit', () => { killAll(); removeTemps(); });

async function runOne({ def, file }, { extDir, vsix, opts }) {
  const pace = opts.slow ? PACES.slow : opts.record && opts.narrate ? PACES.narrate : opts.record ? PACES.record : PACES.fast;
  const logFile = path.join(OUT, `${def.id}.log`);
  for (const f of fs.readdirSync(OUT)) if (f === `${def.id}.mp4` || f.startsWith(`${def.id}.`) || f.startsWith(`${def.id}-`)) fs.rmSync(path.join(OUT, f), { recursive: true, force: true });
  const t0 = Date.now();
  const log = (m) => fs.appendFileSync(logFile, `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}\n`);
  log(`story ${def.id} (${file}): ${def.title}`);
  log(`${def.persona}, ${def.want}, ${def.soThat}.`);

  const root = tempDir('erds-', true);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const result = { id: def.id, file, title: def.title, status: 'failed', failedStep: null, error: null, durationMs: 0, steps: [], video: null, screenshot: null, log: path.relative(REPO, logFile), tempDir: opts.keep ? root : undefined };
  let handle;
  let recorder;
  let ctx;
  const marks = [];
  try {
    const workspace = await prepareWorkspace(def.workspace, home);
    if (def.realistic) {
      // As from the Marketplace: the packaged VSIX, downloaded, installed in the window by the story.
      if (!vsix) throw new Error('no VSIX to install (packaging failed: see the runner\'s output)');
      fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
      fs.copyFileSync(vsix, path.join(home, 'Downloads/erd-studio.vsix'));
    }
    live.add(path.join(root, 'ud'));
    handle = await launchVSCode({ extDir: def.realistic ? undefined : extDir, folder: workspace, root, settings: def.settings, env: def.env, logFile: path.join(root, 'code.log'), realistic: def.realistic });
    const port = handle.port;
    log(`profile ${root}, port ${port}, workspace ${workspace ?? '(empty window)'}${def.realistic ? ', realistic (no ERD Studio until the story installs it)' : ''}`);
    ctx = new StoryContext({ def, port, home, workspace, marks, pace, log, outDir: OUT, ud: handle.ud });
    if (def.realistic) {
      // VS Code's own first launch of a brand-new profile (sign in, theme) was answered long
      // before anyone installs ERD Studio: closed before the story, and its clock, start.
      const closed = await ctx.ui.dismissVSCodeFirstLaunch({ waitMs: 8000 });
      log(`closed VS Code's first-launch welcome (${closed})`);
    }
    if (opts.record) {
      recorder = new Recorder({ port, dir: path.join(root, 'frames') });
      recorder.start();
      ctx.wb.recorder = recorder;
      await ctx.eventually(() => recorder.frames.length > 0, { timeout: 15000, message: 'the recorder took no frames' });
    }
    // The title card: the story's title and its persona.
    ctx.mark(`${def.title}\n${def.persona},\n${def.want},\n${def.soThat}.`, 'intro', def.say);
    await sleep(pace.intro);
    await def.steps(ctx);
    result.status = 'passed';
    ctx.mark(`Done: ${def.title}`, 'pass');
    log('PASSED');
  } catch (err) {
    const step = err instanceof StepFailure ? err.step : '(setup)';
    const cause = err instanceof StepFailure ? err.cause : err;
    result.failedStep = step;
    result.error = String(cause?.message ?? cause).split('\n')[0];
    log(`FAILED at ${step}: ${cause?.stack ?? cause}`);
    marks.push({ t: Date.now(), text: `FAILED: ${step}\n${result.error.slice(0, 160)}`, kind: 'fail' });
    if (ctx) {
      const shot = await failureScreenshot(ctx, path.join(OUT, `${def.id}-failure.jpg`));
      if (shot) result.screenshot = path.relative(REPO, shot);
    }
  } finally {
    result.steps = ctx?.steps ?? [];
    ctx?.noise.stop();
    if (ctx?.noise.events.length) result.interruptions = ctx.noise.events;
    if (recorder) {
      const frames = await recorder.stop(pace.tail);
      try {
        const v = encode({ frames, marks, outFile: path.join(OUT, `${def.id}.mp4`), workDir: path.join(root, 'video'), narrate: opts.narrate, log });
        result.video = path.relative(REPO, v.file);
        result.seconds = Number(v.seconds.toFixed(2));
        const n = v.narration;
        if (n) result.narration = { lines: n.lines, speechSeconds: Number(n.speechSeconds.toFixed(2)), heldSeconds: Number(n.heldSeconds.toFixed(2)) };
        log(`video ${result.video}: ${frames.length} frames, ${v.seconds.toFixed(1)} s, captions ${v.burned ? 'burned in' : 'as a subtitle track'}${n ? `, narrated: ${n.lines} lines, ${n.speechSeconds.toFixed(1)} s of speech, frames held ${n.heldSeconds.toFixed(1)} s at ${n.holds} caption(s)` : ''}`);
      } catch (e) {
        log(`video not written: ${e.message}`);
      }
    }
    ctx?.wb.close();
    if (handle) handle.kill();
    live.delete(path.join(root, 'ud'));
    try { fs.copyFileSync(path.join(root, 'code.log'), path.join(OUT, `${def.id}.vscode.log`)); } catch { /* never started */ }
    if (result.status !== 'passed') {
      try { fs.cpSync(path.join(root, 'ud/logs'), path.join(OUT, `${def.id}-logs`), { recursive: true }); } catch { /* no logs */ }
    }
    dropTemp(root, { keep: opts.keep });
    result.durationMs = Date.now() - t0;
  }
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  keepTemps = opts.keep;
  if (opts.narrate && !opts.record && !opts.list) {
    console.error('--narrate narrates a recording: add --record');
    return 2;
  }
  if (opts.narrate && !opts.list) {
    const problem = narratorProblem();
    if (problem) {
      console.error(`[stories] ${problem}`);
      return 2;
    }
  }
  const stories = await loadStories(opts.only);
  if (opts.list) {
    for (const { def, file } of stories) console.log(`${def.id.padEnd(40)} ${file}  ${def.title}`);
    return 0;
  }
  if (stories.length === 0) {
    console.error(`no stories match ${opts.only.join(', ')}`);
    return 2;
  }
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`[stories] ${opts.build ? 'building' : 'using the existing build'}…`);
  buildExtension({ skip: !opts.build });
  const extRoot = tempDir('erds-ext-', false);
  const extDir = stageExtension(path.join(extRoot, 'ext'));
  // The first-60-seconds stories install the extension as from the Marketplace: package it once.
  let vsix;
  if (stories.some((s) => s.def.realistic)) {
    try {
      vsix = packageVsix(path.join(extRoot, 'erd-studio.vsix'));
      console.log(`[stories] packaged ${path.relative(extRoot, vsix)} for the realistic stories`);
    } catch (e) {
      console.log(`[stories] could not package the VSIX: ${e.message}`);
    }
  }

  const results = [];
  try {
    for (const s of stories) {
      process.stdout.write(`[stories] ${s.def.id} … `);
      const r = await runOne(s, { extDir, vsix, opts });
      results.push(r);
      const secs = (r.durationMs / 1000).toFixed(1);
      if (r.status === 'passed') console.log(`PASS (${secs} s)${r.video ? `  ${r.video} (${r.seconds} s${r.narration ? ', narrated' : ''})` : ''}`);
      else {
        console.log(`FAIL (${secs} s)`);
        console.log(`    step:  ${r.failedStep}`);
        console.log(`    error: ${r.error}`);
        console.log(`    log:   ${r.log}${r.screenshot ? `\n    shot:  ${r.screenshot}` : ''}${r.video ? `\n    video: ${r.video}` : ''}`);
      }
      if (r.tempDir) console.log(`    kept:  ${r.tempDir}`);
    }
  } finally {
    killAll();
    dropTemp(extRoot);
  }
  const failed = results.filter((r) => r.status !== 'passed');
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), record: opts.record, narrate: opts.narrate, passed: results.length - failed.length, failed: failed.length, stories: results }, null, 2) + '\n');
  console.log(`[stories] ${results.length - failed.length} passed, ${failed.length} failed — test/stories/out/summary.json`);
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`[stories] ${err?.stack ?? err}`);
  killAll();
  process.exit(1);
});
