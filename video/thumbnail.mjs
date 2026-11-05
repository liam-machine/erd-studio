#!/usr/bin/env node
// Renders the README's play-button thumbnail, docs/assets/getting-started-play.jpg (1280x720
// JPEG), from player/thumbnail.html: the video's own diagram (a real recorded frame for a recorded
// cut, build/thumb-bg.png; else the tables scene drawn in HTML) behind a large play button,
// "Get started in N seconds" and the real duration. Needs build/timeline.json (npm run timeline).
//
//   node thumbnail.mjs            (npm run thumbnail)
//   node thumbnail.mjs --out x.jpg   a review copy somewhere else
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const outAt = process.argv.indexOf('--out');
const OUT = outAt < 0 ? join(HERE, '..', 'docs', 'assets', 'getting-started-play.jpg') : process.argv[outAt + 1];
const MAX_BYTES = 300 * 1024;

// A recorded cut's thumbnail shows a real frame: the end of the tables scene (two tables and their
// relationship on the real canvas), taken from the footage composite.mjs laid out on the clock.
const timeline = JSON.parse(readFileSync(join(HERE, 'build', 'timeline.json'), 'utf8'));
if (timeline.recording) {
  const sc = timeline.scenes.find((s) => s.id === 'tables');
  const rec = join(HERE, 'build', 'recording.mkv');
  if (!existsSync(rec)) throw new Error('no build/recording.mkv: run `npm run composite` first');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', (sc.start + sc.dur - 0.1).toFixed(3), '-i', rec, '-frames:v', '1', join(HERE, 'build', 'thumb-bg.png')]);
}

const server = await startServer(0);
const browser = await chromium.launch({ args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'] });
try {
  // Laid out at 1920x1080 like the video, captured at 2/3 scale = 1280x720.
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 / 3 });
  page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
  await page.goto(`http://127.0.0.1:${server.address().port}/video/player/thumbnail.html`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  await page.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load())); await document.fonts.ready; });
  for (const quality of [88, 82, 76]) {
    await page.screenshot({ path: OUT, type: 'jpeg', quality });
    const size = statSync(OUT).size;
    console.log(`quality ${quality} -> ${size} bytes`);
    if (size <= MAX_BYTES) break;
  }
  if (statSync(OUT).size > MAX_BYTES) throw new Error(`${OUT} is over ${MAX_BYTES} bytes`);
  console.log(`ok: ${OUT}`);
} finally {
  await browser.close();
  server.close();
}
