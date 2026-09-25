#!/usr/bin/env node
// Tiny static server for the player: loopback only, GET only, rooted at the repo so the page
// can reach /media/icon.png and /video/build/timeline.json. `npm run preview` runs it standalone;
// capture.mjs imports startServer() and uses an ephemeral port.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2',
  '.wav': 'audio/wav', '.svg': 'image/svg+xml',
};

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (req.method !== 'GET' || !file.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startServer(Number(process.env.PORT ?? 4173));
  const base = `http://127.0.0.1:${server.address().port}/video/player/index.html`;
  console.log(`preview (click to play with narration): ${base}?preview=1`);
  console.log(`single frame:                           ${base}?t=12.5`);
}
