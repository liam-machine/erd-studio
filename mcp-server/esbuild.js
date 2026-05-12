import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

const dirnamePolyfill =
  'import { fileURLToPath as __ercfu } from "url"; ' +
  'import { dirname as __ercd } from "path"; ' +
  'const __filename = __ercfu(import.meta.url); ' +
  'const __dirname = __ercd(__filename);';

const requirePolyfill =
  'import { createRequire } from "module"; ' +
  'const require = createRequire(import.meta.url);';

// Main entry — the MCP stdio server
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/index.js',
  external: ['@modelcontextprotocol/sdk', 'zod', 'yaml'],
  banner: {
    js: `#!/usr/bin/env node\n${requirePolyfill} ${dirnamePolyfill}`,
  },
  logLevel: 'info',
});
chmodSync('dist/index.js', 0o755);

// Manifest worker — bundled separately, spawned by ManifestService via worker_threads
await build({
  entryPoints: ['../src/workers/manifestWorker.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/manifestWorker.js',
  banner: {
    js: `${requirePolyfill} ${dirnamePolyfill}`,
  },
  logLevel: 'info',
});

console.log('Built dist/index.js + dist/manifestWorker.js');
