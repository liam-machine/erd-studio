#!/usr/bin/env node
// Renders the README's hero GIF, media/demo.gif, from player/hero.html: ERD Studio in a plain
// folder (no stage tabs) under a caption band, one caption per beat: the Explorer's layer-first
// .erd-studio tree beside the orders diagram, one beat of Import DBML…'s draft, the pointer
// hovering fct_order and dim_customer with the moving arrows on their lines, then the toolbar's line
// style switch: Hops and back to Curved. Deterministic: hero.js's render(t) is pure, so every run
// gives the same frames. Laid out at HERO's size (1440 wide) and scaled to 800 px wide (the README
// shows it at width="800"), HERO.fps, the loop's length (HERO.loop) seamless, one palette for the
// whole loop.
//
//   node hero-gif.mjs                 (npm run gif)
//   node hero-gif.mjs --frames 0,8    only PNG stills of those times, into build/hero/
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'media', 'demo.gif');
const WORK = join(HERE, 'build', 'hero');
const WIDTH = 800;
/** The README hero's budget. The GIF was 0.5 MB as four stills; animated, keep it under 2 MB. */
const MAX_BYTES = 2 * 1024 * 1024;
const argv = process.argv.slice(2);
const i = argv.indexOf('--frames');
const STILLS = i < 0 ? null : argv[i + 1].split(',').map(Number);

const { HERO } = await import('./player/hero.js');
const server = await startServer(0);
const browser = await chromium.launch({ args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'] });
try {
  const page = await browser.newPage({ viewport: { width: HERO.w, height: HERO.h } });
  page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
  await page.goto(`http://127.0.0.1:${server.address().port}/video/player/hero.html`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  await page.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load())); await document.fonts.ready; });
  const { fps, loop } = await page.evaluate(() => window.HERO);
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const times = STILLS ?? Array.from({ length: Math.round(loop * fps) }, (_, k) => k / fps);
  for (const [k, t] of times.entries()) {
    await page.evaluate((t) => window.render(t), t);
    writeFileSync(join(WORK, STILLS ? `t${t.toFixed(2)}.png` : `f${String(k).padStart(4, '0')}.png`), await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
  }
  if (STILLS) {
    console.log(`stills -> ${WORK}`);
  } else {
    // One palette for the loop (stats_mode=full), no dithering (flat UI colours stay flat), and
    // only the changed rectangle of each frame stored (diff_mode=rectangle).
    const filter = `fps=${fps},scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
    const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', join(WORK, 'f%04d.png'), '-filter_complex', filter, '-loop', '0', OUT], { stdio: 'inherit' });
    if (ff.status !== 0) throw new Error('ffmpeg failed');
    const size = statSync(OUT).size;
    console.log(JSON.stringify({ out: OUT, frames: times.length, fps, seconds: loop, width: WIDTH, bytes: size }));
    if (size > MAX_BYTES) throw new Error(`${OUT} is ${size} bytes, over ${MAX_BYTES}`);
  }
} finally {
  await browser.close();
  server.close();
}
