// Films the workbench page by screenshotting it over CDP as fast as it will go
// (about 8–15 fps), in-process, until stopped. Screenshots, not screen capture:
// it films only the VS Code window (webviews included), needs no
// screen-recording permission, and works under Xvfb. It survives window
// reloads by reconnecting. Ported from the issue-to-pr skill's recorder.mjs.

import fs from 'node:fs';
import path from 'node:path';

import { WORKBENCH, attach, findTarget } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Recorder {
  constructor({ port, dir }) {
    this.port = port;
    this.dir = dir;
    /** `[{ file, t }]`, t in epoch ms. */
    this.frames = [];
    this.running = false;
    this.loop = null;
  }

  start() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.running = true;
    this.loop = this.run();
  }

  async run() {
    let c = null;
    let clip;
    while (this.running) {
      try {
        if (!c || c.closed) {
          c = await attach(await findTarget(this.port, { match: WORKBENCH, timeoutMs: 5000 }));
          clip = undefined;
        }
        if (clip === undefined) {
          // Film at CSS-pixel size whatever the display's pixel ratio.
          const m = await c.evaluate('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
          clip = m.dpr === 1 ? null : { x: 0, y: 0, width: m.w, height: m.h, scale: 1 / m.dpr };
        }
        const r = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 85, ...(clip ? { clip } : {}) }, 4000);
        const file = path.join(this.dir, `f${String(this.frames.length).padStart(5, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        this.frames.push({ file, t: Date.now() });
        await sleep(30);
      } catch {
        // The window is reloading (or busy): reconnect and keep going.
        try { c?.close(); } catch { /* gone */ }
        c = null;
        await sleep(250);
      }
    }
    try { c?.close(); } catch { /* gone */ }
  }

  /** Stop after `tailMs` more of filming (so the last caption is readable). */
  async stop(tailMs = 0) {
    if (tailMs) await sleep(tailMs);
    this.running = false;
    await this.loop;
    return this.frames;
  }
}
