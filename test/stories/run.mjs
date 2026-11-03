#!/usr/bin/env node
// Onboarding stories: user stories as code, run against a real VS Code with
// the extension, each optionally filmed as a captioned MP4.
//
//   node test/stories/run.mjs [--record] [--only <id|substring>] [--keep] [--headed-slow] [--no-build] [--list]
//
//   --record       film each story: test/stories/out/<id>.mp4 (+ .srt)
//   --only X       run the stories whose id or file name contains X (repeatable, or comma-separated)
//   --keep         keep each story's temp folder (/tmp/erds-…: profile, workspace, frames) and print it
//   --headed-slow  slow pacing, to watch a story run (implies the record pacing, slower)
//   --no-build     skip `npm run build` (use the dist/ already there)
//   --list         list the stories and exit
//
// Every story runs in its own fresh profile, workspace copy and CDP port; its
// VS Code processes are killed by --user-data-dir whatever happens. Writes
// out/<id>.log, out/<id>.vscode.log, out/<id>-failure.jpg and out/<id>-logs/
// (VS Code's own logs) on failure, and out/summary.json. Exits 1 on any failure.
// See docs/dev/onboarding-stories.md.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { sleep } from './lib/act.mjs';
import { REPO, buildExtension, freePort, killByProfile, launchVSCode, shortTempDir, stageExtension } from './lib/launch.mjs';
import { Recorder } from './lib/recorder.mjs';
import { PACES, StepFailure, StoryContext, failureScreenshot } from './lib/story.mjs';
import { encode } from './lib/video.mjs';
import { prepareWorkspace } from './lib/workspaces.mjs';

const HERE = path.join(REPO, 'test/stories');
const OUT = path.join(HERE, 'out');
const STORIES = path.join(HERE, 'stories');

function parseArgs(argv) {
  const opts = { record: false, only: [], keep: false, slow: false, build: true, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--record') opts.record = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--headed-slow') opts.slow = true;
    else if (a === '--no-build') opts.build = false;
    else if (a === '--list') opts.list = true;
    else if (a === '--only') opts.only.push(...String(argv[++i] ?? '').split(',').filter(Boolean));
    else if (a.startsWith('--only=')) opts.only.push(...a.slice(7).split(',').filter(Boolean));
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
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
function killAll() {
  for (const ud of live) killByProfile(ud);
  live.clear();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { killAll(); process.exit(130); });
}
process.on('exit', killAll);

async function runOne({ def, file }, { extDir, opts }) {
  const pace = opts.slow ? PACES.slow : opts.record ? PACES.record : PACES.fast;
  const logFile = path.join(OUT, `${def.id}.log`);
  for (const f of fs.readdirSync(OUT)) if (f === `${def.id}.mp4` || f.startsWith(`${def.id}.`) || f.startsWith(`${def.id}-`)) fs.rmSync(path.join(OUT, f), { recursive: true, force: true });
  const t0 = Date.now();
  const log = (m) => fs.appendFileSync(logFile, `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}\n`);
  log(`story ${def.id} (${file}): ${def.title}`);
  log(`${def.persona}, ${def.want}, ${def.soThat}.`);

  const root = shortTempDir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const result = { id: def.id, file, title: def.title, status: 'failed', failedStep: null, error: null, durationMs: 0, steps: [], video: null, screenshot: null, log: path.relative(REPO, logFile), tempDir: opts.keep ? root : undefined };
  let handle;
  let recorder;
  let ctx;
  const marks = [];
  try {
    const workspace = await prepareWorkspace(def.workspace, home);
    const port = await freePort(9400);
    log(`profile ${root}, port ${port}, workspace ${workspace ?? '(empty window)'}`);
    live.add(path.join(root, 'ud'));
    handle = await launchVSCode({ extDir, folder: workspace, root, port, settings: def.settings, logFile: path.join(root, 'code.log') });
    ctx = new StoryContext({ def, port, home, workspace, marks, pace, log, outDir: OUT });
    if (opts.record) {
      recorder = new Recorder({ port, dir: path.join(root, 'frames') });
      recorder.start();
      await ctx.eventually(() => recorder.frames.length > 0, { timeout: 15000, message: 'the recorder took no frames' });
    }
    ctx.mark(`${def.title}\n${def.persona},\n${def.want},\n${def.soThat}.`, 'intro');
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
    if (recorder) {
      const frames = await recorder.stop(pace.tail);
      try {
        const v = encode({ frames, marks, outFile: path.join(OUT, `${def.id}.mp4`), workDir: path.join(root, 'video') });
        result.video = path.relative(REPO, v.file);
        log(`video ${result.video}: ${frames.length} frames, ${v.seconds.toFixed(1)} s, captions ${v.burned ? 'burned in' : 'as a subtitle track'}`);
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
    if (!opts.keep) fs.rmSync(root, { recursive: true, force: true });
    result.durationMs = Date.now() - t0;
  }
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
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
  const extRoot = shortTempDir('erds-ext-');
  const extDir = stageExtension(path.join(extRoot, 'ext'));

  const results = [];
  try {
    for (const s of stories) {
      process.stdout.write(`[stories] ${s.def.id} … `);
      const r = await runOne(s, { extDir, opts });
      results.push(r);
      const secs = (r.durationMs / 1000).toFixed(1);
      if (r.status === 'passed') console.log(`PASS (${secs} s)${r.video ? `  ${r.video}` : ''}`);
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
    fs.rmSync(extRoot, { recursive: true, force: true });
  }
  const failed = results.filter((r) => r.status !== 'passed');
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), record: opts.record, passed: results.length - failed.length, failed: failed.length, stories: results }, null, 2) + '\n');
  console.log(`[stories] ${results.length - failed.length} passed, ${failed.length} failed — test/stories/out/summary.json`);
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`[stories] ${err?.stack ?? err}`);
  killAll();
  process.exit(1);
});
