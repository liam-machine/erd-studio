// esbuild.js — Build for ERD Studio VS Code extension
// Targets: Extension host (Node.js, CJS), Webview (Browser, IIFE with React),
// manifest worker (Node.js worker thread), the standalone `erd-studio` CLI,
// the lazily loaded SQL importer (dist/sqlImport.js), the SQL import worker
// (dist/sqlImportWorker.js) and the draft preview page (dist/draft.js).

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const { exampleBundleDefine } = require('./scripts/exampleBundle.cjs');
const { edgeRoutingWorkerDefine } = require('./packages/renderer/scripts/edgeRoutingWorker.cjs');

const args = process.argv.slice(2);
const isWatch = args.includes('--watch');
const isProduction = args.includes('--production');

/** VS Code problem matcher compatible logging */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      for (const error of result.errors) {
        const loc = error.location;
        console.error(
          `ERROR: ${loc?.file ?? 'unknown'}:${loc?.line ?? 0}:${loc?.column ?? 0}: ${error.text}`
        );
      }
      console.log('[watch] build finished');
    });
  },
};

// Ensure dist/ exists
const distDir = path.resolve(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Read ELK Web Worker code for blob URL injection into the webview bundle.
// VS Code webviews cannot use importScripts() or load workers from URLs,
// so the worker code is inlined as a string constant at build time.
const elkWorkerCode = fs.readFileSync(
  path.resolve(__dirname, 'node_modules/elkjs/lib/elk-worker.min.js'),
  'utf-8',
);

// The line-routing worker (packages/renderer/scripts/edgeRoutingWorker.cjs),
// inlined the same way for the canvas in the webview and the draft page.
// Built once per run: restart `npm run watch` after changing the router.
const edgeRoutingWorker = edgeRoutingWorkerDefine({ minify: isProduction });

// Extension host build — Node.js, CJS, externalize vscode
const extensionConfig = {
  entryPoints: ['./src/extension.ts'],
  bundle: true,
  outfile: './dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !isProduction,
  minify: isProduction,
  treeShaking: true,
  logLevel: 'warning',
  // Harness skill files (src/harness/**/*.md) are bundled as plain strings.
  loader: { '.md': 'text' },
  define: {
    // The example projects in docs/examples/, for Open an Example Project…
    // (src/services/exampleProjects.ts). Inlined because the VSIX is capped
    // at 60 files. Read once per build: `npm run watch` picks up an edit to
    // docs/examples on its next start.
    '__ERD_EXAMPLES__': exampleBundleDefine(),
  },
  plugins: [problemMatcherPlugin],
};

// Manifest worker build — Node.js, CJS, same settings as extension host.
// Runs JSON.parse in a worker thread for non-blocking manifest parsing.
const workerConfig = {
  entryPoints: ['./src/workers/manifestWorker.ts'],
  bundle: true,
  outfile: './dist/manifestWorker.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !isProduction,
  minify: isProduction,
  treeShaking: true,
  logLevel: 'warning',
  plugins: [problemMatcherPlugin],
};

// Standalone CLI build — `node dist/cli.js`, run by the ~/.erd-studio-cli
// launcher outside VS Code. No `external`: it must never import 'vscode', and
// an unresolvable 'vscode' import fails this bundle rather than the runtime.
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const cliConfig = {
  entryPoints: ['./src/cli/index.ts'],
  bundle: true,
  outfile: './dist/cli.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !isProduction,
  minify: isProduction,
  treeShaking: true,
  logLevel: 'warning',
  banner: { js: '#!/usr/bin/env node' },
  loader: { '.md': 'text' },
  define: {
    '__ERD_CLI_VERSION__': JSON.stringify(pkg.version),
  },
  plugins: [problemMatcherPlugin],
};

// SQL importer — `dist/sqlImport.js`, loaded by the host only when an Import
// SQL DDL… runs (src/services/sqlImportLoader.ts), so @dbml/core's SQL
// grammars (several MB) never enter dist/extension.js or dist/cli.js. The
// Oracle grammar is stubbed out: bundled it adds about 5.7 MB to the minified
// file (10.1 MB → 15.8 MB), and the import reads Oracle with the PostgreSQL
// grammar after Oracle's own pre-steps (src/services/sqlDdlDialects.ts). No source map:
// the grammar tables dwarf the converter, which tests run from source.
const ORACLE_GRAMMAR = /[\\/]ANTLR[\\/](parsers[\\/]oraclesql[\\/]|ASTGeneration[\\/]oraclesql[\\/])/;
const stubOracleGrammarPlugin = {
  name: 'stub-oracle-grammar',
  setup(build) {
    build.onResolve({ filter: /oraclesql[\\/]/ }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      if (!ORACLE_GRAMMAR.test(resolved)) return undefined;
      return { path: resolved, namespace: 'oracle-grammar-stub' };
    });
    build.onLoad({ filter: /.*/, namespace: 'oracle-grammar-stub' }, () => ({
      contents: 'export default class OracleGrammarNotBundled { constructor() { throw new Error("The Oracle SQL grammar is not bundled."); } }',
      loader: 'js',
    }));
  },
};
const sqlImportConfig = {
  entryPoints: ['./src/services/sqlImportEngine.ts'],
  bundle: true,
  outfile: './dist/sqlImport.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: false,
  minify: isProduction,
  treeShaking: true,
  logLevel: 'warning',
  plugins: [stubOracleGrammarPlugin, problemMatcherPlugin],
};

// SQL import worker — `dist/sqlImportWorker.js`, the worker thread Import SQL
// DDL… converts in (src/workers/sqlImportWorker.ts, src/services/sqlConverter.ts),
// so a large script never blocks the extension host. Small: it loads the
// converter and grammars from dist/sqlImport.js at run time. No `external`:
// an import of 'vscode' fails this bundle.
const sqlImportWorkerConfig = {
  entryPoints: ['./src/workers/sqlImportWorker.ts'],
  bundle: true,
  outfile: './dist/sqlImportWorker.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !isProduction,
  minify: isProduction,
  treeShaking: true,
  logLevel: 'warning',
  plugins: [problemMatcherPlugin],
};

// Webview build — Browser, IIFE, bundle everything including React
const webviewConfig = {
  entryPoints: ['./webview/index.tsx'],
  bundle: true,
  outfile: './dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: ['es2020', 'chrome114'],
  sourcemap: !isProduction,
  minify: isProduction,
  treeShaking: true,
  logLevel: 'warning',
  jsx: 'automatic',
  loader: {
    '.css': 'css',
    '.svg': 'dataurl',
    '.png': 'dataurl',
  },
  define: {
    'process.env.NODE_ENV': isProduction ? '"production"' : '"development"',
    '__ELK_WORKER_CODE__': JSON.stringify(elkWorkerCode),
    ...edgeRoutingWorker,
  },
  plugins: [problemMatcherPlugin],
};

// Draft preview page — `dist/draft.js` + `dist/draft.css`, shown by
// src/providers/DraftPreviewPanel.ts (docs/dev/draft-first.md). Its own
// bundle, so the editor webview's protocol stays untouched: React, React
// Flow, the renderer and the ELK worker (the page lays a draft out with the
// canvas's own options) are repeated here.
const draftConfig = {
  ...webviewConfig,
  entryPoints: ['./webview-draft/index.tsx'],
  outfile: './dist/draft.js',
  define: {
    'process.env.NODE_ENV': isProduction ? '"production"' : '"development"',
    '__ELK_WORKER_CODE__': JSON.stringify(elkWorkerCode),
    ...edgeRoutingWorker,
  },
};

async function build() {
  console.log(`Building [${isProduction ? 'production' : 'development'}]...`);

  if (isWatch) {
    const contexts = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
      esbuild.context(workerConfig),
      esbuild.context(cliConfig),
      esbuild.context(sqlImportConfig),
      esbuild.context(sqlImportWorkerConfig),
      esbuild.context(draftConfig),
    ]);
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(workerConfig),
      esbuild.build(cliConfig),
      esbuild.build(sqlImportConfig),
      esbuild.build(sqlImportWorkerConfig),
      esbuild.build(draftConfig),
    ]);
    console.log('Build complete.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
