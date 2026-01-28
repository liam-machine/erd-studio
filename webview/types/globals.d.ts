/**
 * Build-time constants injected by esbuild via the `define` option.
 *
 * These are replaced at compile time with their actual values.
 */

/**
 * ELK Web Worker source code (minified), injected from
 * `node_modules/elkjs/lib/elk-worker.min.js` at build time.
 *
 * Used by `elkLayout.ts` to create a blob URL Worker for non-blocking
 * graph layout computation.
 */
declare const __ELK_WORKER_CODE__: string;
