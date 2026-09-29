#!/usr/bin/env node
// README poster for a cut: one frame of the player, dimmed, with the title, a large play button
// dead centre and the real running time. Rendered in the player page itself (same fonts, same
// frame), so it needs only a built timeline (tts + timeline), not a capture or an encode.
//
//   VARIANT=readme node thumb.mjs                      -> ../docs/assets/how-it-works-play.jpg
//   VARIANT=readme node thumb.mjs --t 77.2 --out x.jpg  another frame / another file
//
// The JPEG quality steps down from 88 until the file is under --max-kb (default 250), because
// the README serves it through jsDelivr on every page view.
import { chromium } from 'playwright';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VARIANT = process.env.VARIANT ?? 'readme';
const BUILD = join(HERE, VARIANT === 'pro' ? 'build' : `build-${VARIANT}`);
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i < 0 ? dflt : argv[i + 1]; };

const timeline = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
// Default frame: the Diff scene once all three differences are lit (its `lights` beat + 5 s).
const diff = timeline.scenes.find((s) => s.id === 'diff');
const T = Number(opt('t', diff ? diff.start + diff.beats.lights.t + 5 : timeline.total / 2));
const OUT = opt('out', join(HERE, '..', 'docs', 'assets', 'how-it-works-play.jpg'));
const TITLE = opt('title', 'How ERD Studio works');
const SUB = opt('sub', 'Logical design, dbt reality, and the diff between them');
const MAX_KB = Number(opt('max-kb', 250));
const secs = Math.round(timeline.total);
const DURATION = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

const server = await startServer(0);
const browser = await chromium.launch({ args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: timeline.width, height: timeline.height } });
page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
await page.goto(`http://127.0.0.1:${server.address().port}/social-video/player/index.html?variant=${VARIANT}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
await page.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load())); await document.fonts.ready; });

await page.evaluate(async ({ t, title, sub, duration }) => {
  window.render(t);
  await Promise.all([...document.images].map((im) => im.decode().catch(() => {})));
  // The frame's own caption and chapter chrome would compete with the title: drop them, and
  // push the rest back so the button and the title read first.
  // The scene's own headline gives way to the title, and the scene moves down to make room.
  for (const id of ['caption', 'chapters', 'kicker', 'hud', 'headline']) document.getElementById(id).style.display = 'none';
  const stage = document.getElementById('stage');
  stage.style.filter = 'blur(1.2px) brightness(.62) saturate(.95)';
  stage.style.transform = 'translateY(64px)';
  const tri = '<svg width="92" height="92" viewBox="0 0 24 24" style="display:block;margin-left:10px"><path d="M7 4.2v15.6c0 .8.9 1.3 1.6.9l12.2-7.8c.6-.4.6-1.4 0-1.8L8.6 3.3C7.9 2.9 7 3.4 7 4.2z" fill="#0f1114"/></svg>';
  const clock = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" style="display:block"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>';
  const o = document.createElement('div');
  o.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  o.innerHTML = `
    <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,11,13,.97) 0%,rgba(10,11,13,.9) 22%,rgba(10,11,13,.3) 36%,rgba(10,11,13,.3) 80%,rgba(10,11,13,.8) 100%)"></div>
    <div style="position:absolute;left:0;right:0;top:64px;display:flex;justify-content:center;align-items:center;gap:20px">
      <img src="/media/icon.png" width="64" height="64" style="display:block;border-radius:14px;box-shadow:0 8px 24px #0009">
      <span style="font-size:30px;font-weight:800;letter-spacing:.22em;color:var(--text-2)">ERD STUDIO</span></div>
    <div style="position:absolute;left:0;right:0;top:166px;text-align:center;white-space:nowrap;font-size:90px;line-height:1.02;font-weight:800;letter-spacing:-.035em;color:var(--text);text-shadow:0 4px 30px #000c">${title.replace(/ (\S+)$/, ' <span style="color:var(--green)">$1</span>')}</div>
    <div style="position:absolute;left:0;right:0;top:280px;text-align:center;white-space:nowrap;font-size:34px;font-weight:600;color:#c9ced6;text-shadow:0 2px 16px #000">${sub}</div>
    <div style="position:absolute;left:50%;top:50%;width:300px;height:300px;margin:-150px 0 0 -150px;border-radius:50%;background:radial-gradient(closest-side,rgba(34,197,94,.35),rgba(34,197,94,0))"></div>
    <div style="position:absolute;left:50%;top:50%;width:216px;height:216px;margin:-108px 0 0 -108px;border-radius:50%;background:var(--green);box-shadow:0 0 0 14px rgba(34,197,94,.22),0 24px 60px #000c;display:flex;align-items:center;justify-content:center">${tri}</div>
    <div style="position:absolute;left:0;right:0;bottom:52px;display:flex;justify-content:center">
      <span style="display:inline-flex;align-items:center;gap:14px;height:72px;padding:0 32px;border-radius:999px;background:rgba(19,22,25,.92);border:2px solid #34363d;color:var(--text);font-size:34px;font-weight:700;font-variant-numeric:tabular-nums">${clock}${duration}</span></div>`;
  document.body.appendChild(o);
  await Promise.all([...document.images].map((im) => im.decode().catch(() => {})));
}, { t: T, title: TITLE, sub: SUB, duration: DURATION });

let q = 88, bytes = 0;
for (; q >= 50; q -= 4) {
  const buf = await page.screenshot({ type: 'jpeg', quality: q, animations: 'disabled', caret: 'hide' });
  writeFileSync(OUT, buf);
  bytes = statSync(OUT).size;
  if (bytes <= MAX_KB * 1024) break;
}
console.log(`thumb: ${OUT} (t=${T.toFixed(2)}s, ${DURATION}, q${q}, ${Math.round(bytes / 1024)} KB)`);
if (bytes > MAX_KB * 1024) { console.error(`thumb.mjs: over ${MAX_KB} KB even at q50`); process.exitCode = 1; }
await browser.close();
server.close();
