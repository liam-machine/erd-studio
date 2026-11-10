// The line-routing worker's code, bundled into one string at build time.
//
// The canvas starts the worker from a blob URL (src/lib/edgeRouting/worker/
// client.ts), the way the extension starts the ELK layout worker: a VS Code
// webview cannot load a worker from a file URL, and the published package
// must not depend on the consumer's bundler handling `new Worker(new URL())`.
// build.mjs also writes the same code as dist/edge-routing-worker.js, which a
// host whose CSP refuses blob workers serves itself (ErdCanvas
// `routingWorkerUrl`).
// Both builds that ship the canvas define `__ERD_EDGE_ROUTING_WORKER__` with
// this: the extension's esbuild.js (webview + draft page) and this package's
// build.mjs (the published npm dist). Where it is not defined
// (unit tests), the canvas routes on the main thread.
//
// In `npm run watch` the string is built once, at start: restart the watch
// after changing the router to update the worker.
const esbuild = require('esbuild');
const path = require('path');

const ENTRY = path.resolve(__dirname, '../src/lib/edgeRouting/worker/entry.ts');

/** The worker's code as an IIFE string. */
function edgeRoutingWorkerCode({ minify = true } = {}) {
  const result = esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify,
    write: false,
    logLevel: 'warning',
  });
  return result.outputFiles[0].text;
}

/** The esbuild `define` entry that inlines the worker. */
function edgeRoutingWorkerDefine(options) {
  return { __ERD_EDGE_ROUTING_WORKER__: JSON.stringify(edgeRoutingWorkerCode(options)) };
}

module.exports = { edgeRoutingWorkerCode, edgeRoutingWorkerDefine };
