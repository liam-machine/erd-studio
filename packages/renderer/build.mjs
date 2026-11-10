// Builds the published package:
//   1. JS  — src/{index,editor,store,sizing}.ts as ESM with shared chunks, so
//      every entry point sees the same module instances (one store context,
//      one set of components). Component `.css` imports are dropped here
//      (`empty` loader); consumers load the single dist/styles.css instead.
//      The line-routing worker is bundled into a string and inlined
//      (`__ERD_EDGE_ROUTING_WORKER__`, scripts/edgeRoutingWorker.cjs), and
//      the same code is written as dist/edge-routing-worker.js (export
//      `./edge-routing-worker.js`) for hosts whose CSP refuses a blob worker:
//      they serve it themselves and pass its URL to ErdCanvas
//      (`routingWorkerUrl`).
//   2. CSS — src/styles.css, bundled in its explicit order into
//      dist/styles.css. The React Flow base stylesheet stays an `@import` for
//      the consumer's bundler to resolve.
// Declarations are emitted afterwards by `tsc -p tsconfig.build.json`, which
// resolves `@erd-studio/core` through its built dist, so core is built first
// when its declarations are missing.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import workerBuild from './scripts/edgeRoutingWorker.cjs';

const coreDir = fileURLToPath(new URL('../core/', import.meta.url));
if (!existsSync(new URL('../core/dist/index.d.ts', import.meta.url))) {
  execSync('npm run build', { cwd: coreDir, stdio: 'inherit' });
}

rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });

// The worker's code, built once: inlined into the canvas and written as its own file.
const workerCode = workerBuild.edgeRoutingWorkerCode();

await build({
  entryPoints: ['src/index.ts', 'src/editor.ts', 'src/store.ts', 'src/sizing.ts'],
  bundle: true,
  splitting: true,
  format: 'esm',
  outdir: 'dist',
  target: 'es2020',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime', '@xyflow/react', 'zustand', '@erd-studio/core'],
  // The line-routing worker, inlined (scripts/edgeRoutingWorker.cjs).
  define: { __ERD_EDGE_ROUTING_WORKER__: JSON.stringify(workerCode) },
  logLevel: 'warning',
});

// The same worker as a classic script, for hosts that serve it themselves (ErdCanvas `routingWorkerUrl`).
writeFileSync(new URL('./dist/edge-routing-worker.js', import.meta.url), workerCode);

await build({
  entryPoints: ['src/styles.css'],
  bundle: true,
  outfile: 'dist/styles.css',
  external: ['@xyflow/react/dist/style.css'],
  logLevel: 'warning',
});
