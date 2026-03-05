// esbuild.js — Dual-target build for ERD Studio VS Code extension
// Targets: Extension host (Node.js, CJS) + Webview (Browser, IIFE with React)

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

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
  },
  plugins: [problemMatcherPlugin],
};

async function build() {
  console.log(`Building [${isProduction ? 'production' : 'development'}]...`);

  if (isWatch) {
    const [extCtx, webCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
    console.log('Build complete.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
