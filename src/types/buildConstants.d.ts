// Constants baked in at build time by esbuild `define` (esbuild.js, cliConfig)
// and mirrored by vitest.config.ts. Only the CLI bundle defines them — never
// reference them from the extension host or the webview.

/** package.json `version` of the build that produced dist/cli.js. */
declare const __ERD_CLI_VERSION__: string;
