// Constants baked in at build time by esbuild `define` (esbuild.js) and
// mirrored by vitest.config.ts. Each is defined for one bundle only: reference
// it only from code that bundle owns, and guard a read with `typeof` so a
// bundle without it degrades rather than throwing.

/** package.json `version` of the build that produced dist/cli.js. CLI bundle only. */
declare const __ERD_CLI_VERSION__: string;

/**
 * The example projects in docs/examples/ as JSON text:
 * `{ [exampleId]: { [posixPathInsideTheExample]: text } }`
 * (scripts/exampleBundle.cjs). Extension bundle only; read through
 * `exampleFiles()` in src/services/exampleProjects.ts.
 */
declare const __ERD_EXAMPLES__: string;
