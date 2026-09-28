#!/usr/bin/env node
// Renders the player frame by frame with Playwright's bundled Chromium and pipes the frames
// into ffmpeg as a lossless master (build/master.mkv). Because render(t) is pure, the timeline
// can be split into ranges rendered by parallel pages and concatenated afterwards.
//
//   node capture.mjs                     lossless PNG pipe, 1920x1080 @ 30 fps
//   node capture.mjs --draft             JPEG q95 pipe (much faster; for reviewing motion)
//   node capture.mjs --jobs 6            parallel pages (default: min(6, cpus/2))
//   node capture.mjs --scale 0.6667      render at 1280x720 (layout identical, deviceScaleFactor)
//   node capture.mjs --stills 3.2,41     just write PNG stills of those times to build/stills/
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, 'build');
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i < 0 ? dflt : argv[i + 1]; };
const DRAFT = argv.includes('--draft');
const SCALE = Number(opt('scale', 1));
const JOBS = Number(opt('jobs', Math.max(1, Math.min(6, Math.floor(cpus().length / 2)))));
const STILLS = opt('stills', null);
const STILLS_DIR = opt('out', join(BUILD, 'stills'));

const timeline = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
const FPS = timeline.fps;
const N = Math.round(timeline.total * FPS);

const server = await startServer(0);
const URL_ = `http://127.0.0.1:${server.address().port}/video/player/index.html`;
const browser = await chromium.launch({ args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'] });

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE });
  page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
  await page.goto(URL_);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  // Every declared face must be decoded before frame 0, or early frames render in a fallback font.
  const faces = await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((f) => f.load()));
    await document.fonts.ready;
    return [...document.fonts].map((f) => `${f.family} ${f.weight}: ${f.status}`);
  });
  const bad = faces.filter((f) => !f.endsWith('loaded'));
  if (bad.length) throw new Error(`fonts not loaded: ${bad.join(', ')}`);
  const ok = await page.evaluate(() => ['400 20px Inter', '500 20px Inter', '600 20px Inter', '700 20px Inter', '800 20px Inter', '400 20px "JetBrains Mono"', '500 20px "JetBrains Mono"'].every((s) => document.fonts.check(s)));
  if (!ok) throw new Error('document.fonts.check failed');
  return page;
}

async function frame(page, t, type) {
  await page.evaluate(async (t) => {
    window.render(t);
    await Promise.all([...document.images].map((im) => im.decode().catch(() => {})));
  }, t);
  return page.screenshot({ type, ...(type === 'jpeg' ? { quality: 95 } : {}), animations: 'disabled', caret: 'hide' });
}

async function renderRange(from, to, out) {
  const page = await openPage();
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', DRAFT ? 'mjpeg' : 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', '-r', String(FPS), out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
  for (let i = from; i < to; i++) {
    const buf = await frame(page, i / FPS, DRAFT ? 'jpeg' : 'png');
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
  await page.close();
}

const t0 = performance.now();
if (STILLS) {
  mkdirSync(STILLS_DIR, { recursive: true });
  const page = await openPage();
  for (const s of STILLS.split(',')) {
    const t = Number(s);
    writeFileSync(join(STILLS_DIR, `t${t.toFixed(2).padStart(6, '0')}.png`), await frame(page, t, 'png'));
  }
  console.log(`stills -> ${STILLS_DIR}`);
} else {
  const parts = join(BUILD, 'parts');
  rmSync(parts, { recursive: true, force: true });
  mkdirSync(parts, { recursive: true });
  const size = Math.ceil(N / JOBS);
  const ranges = Array.from({ length: JOBS }, (_, j) => [j * size, Math.min(N, (j + 1) * size)]).filter(([a, b]) => b > a);
  const files = ranges.map((_, j) => join(parts, `p${j}.mkv`));
  await Promise.all(ranges.map(([a, b], j) => renderRange(a, b, files[j])));
  const list = join(parts, 'list.txt');
  writeFileSync(list, files.map((f) => `file '${f}'`).join('\n'));
  await new Promise((res, rej) => spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', join(BUILD, 'master.mkv')], { stdio: 'inherit' })
    .on('close', (c) => (c === 0 ? res() : rej(new Error('concat failed')))));
  const secs = (performance.now() - t0) / 1000;
  console.log(JSON.stringify({ frames: N, fps: FPS, jobs: ranges.length, draft: DRAFT, scale: SCALE, secs: +secs.toFixed(1), capFps: +(N / secs).toFixed(1) }));
}
await browser.close();
server.close();
