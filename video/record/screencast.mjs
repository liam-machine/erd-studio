// Films the VS Code window with CDP's Page.startScreencast: the compositor pushes a JPEG every
// time the window repaints (up to the display's rate), so the pointer's glide is smooth; while
// nothing moves no frame arrives and the last one holds. Frames are already scaled to the inset
// size the frame shows them at. Each frame is written to <dir>/fNNNNN.jpg and logged in
// <dir>/frames.jsonl as { f, t } (t: epoch seconds, the compositor's own timestamp).
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workbench } from './driver.mjs';

export async function startScreencast(dir, { width, height, quality = 95 } = {}) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'frames.jsonl');
  writeFileSync(log, '');
  const w = await workbench();
  let n = 0;
  let skew = null;
  const onFrame = (m) => {
    if (m.method !== 'Page.screencastFrame') return;
    const { data, metadata, sessionId } = m.params;
    w.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    const now = Date.now() / 1000;
    // the compositor's timestamp is epoch seconds; fall back to arrival time if it is not
    const ts = metadata.timestamp && Math.abs(metadata.timestamp - now) < 2 ? metadata.timestamp : now;
    skew ??= now - ts;
    const f = `f${String(n++).padStart(5, '0')}.jpg`;
    writeFileSync(join(dir, f), Buffer.from(data, 'base64'));
    appendFileSync(log, JSON.stringify({ f, t: ts }) + '\n');
  };
  w.on(onFrame);
  await w.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  return {
    get frames() { return n; },
    get skew() { return skew; },
    /** Make the compositor paint once (a still window sends no frames). */
    async poke() { await w.evaluate('document.body.style.outline = document.body.style.outline ? "" : "0px solid transparent"'); },
    async stop() { await w.send('Page.stopScreencast').catch(() => {}); w.off(onFrame); w.close(); return n; },
  };
}
