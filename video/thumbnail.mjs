#!/usr/bin/env node
// Renders the README's play-button thumbnail, docs/assets/getting-started-play.jpg (1280x720
// JPEG), from player/thumbnail.html: the video's own laid-out diagram behind a large play button,
// "Get started in N seconds" and the real duration. Needs build/timeline.json (npm run timeline).
//
//   node thumbnail.mjs            (npm run thumbnail)
import { chromium } from 'playwright';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'docs', 'assets', 'getting-started-play.jpg');
const MAX_BYTES = 300 * 1024;

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
