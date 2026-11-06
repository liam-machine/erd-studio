#!/usr/bin/env node
// Renders player/assets/confluence-sales.png, the diagram on the default cut's Confluence page
// (player/scenes/tour/confluence.js): the tour's own `sales` diagram (record/fixtures.erd.mjs, the
// .erd-studio a plain take wrote: the Snowflake import, the table added by hand and the one Claude
// Code added) loaded by @erd-studio/core's loadDisplaySubjectArea with its DBML reader and drawn by
// @erd-studio/renderer's ErdCanvas, which the ERD Studio for Confluence macro runs in viewer mode
// (read-only, no editing affordance). Built from this repo's own packages, no Confluence app code;
// a light page (the --vscode-* variables the renderer's README lists), 1200x640 at 2x.
//
//   node confluence-shot.mjs        (needs the repo root's npm install for esbuild and React)
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBT_ERD } from './record/fixtures.erd.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'build', 'confluence');
export const SHOT = { file: join(HERE, 'player', 'assets', 'confluence-sales.png'), width: 1200, height: 560 };
if (!Object.keys(DBT_ERD).length) throw new Error('record/fixtures.erd.mjs is empty: run `node record/fixtures.mjs --capture` after a plain take');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

writeFileSync(join(OUT, 'files.json'), JSON.stringify(Object.fromEntries(Object.entries(DBT_ERD).map(([k, v]) => [`.erd-studio/${k}`, v]))));
writeFileSync(join(OUT, 'entry.tsx'), `import { createRoot } from 'react-dom/client';
import { ErdCanvas } from '@erd-studio/renderer';
import { loadDisplaySubjectArea } from '@erd-studio/core';
import { dbmlStorageReader } from '@erd-studio/core/dbml';
import '@erd-studio/renderer/styles.css';
import files from './files.json';
const domain = await loadDisplaySubjectArea({
  domainPath: '.erd-studio/main/diagrams/sales.dbml', readOnly: true, dbml: dbmlStorageReader,
  readFile: async (p) => (files as Record<string, string>)[p] ?? null,
});
createRoot(document.getElementById('root')!).render(
  <ErdCanvas domain={domain} viewer onReady={() => { (window as any).__ready = true; }} />,
);
`);

// A light page, as Confluence shows the macro (the renderer README's --vscode-* list).
const VARS = {
  'editor-background': '#ffffff', 'editor-foreground': '#172b4d', 'sideBar-background': '#f3f4f6',
  'panel-border': '#dfe1e6', 'editorGroup-border': '#dfe1e6', 'button-background': '#1868db',
  'button-foreground': '#ffffff', 'button-hoverBackground': '#0c66e4', 'input-background': '#ffffff',
  'input-foreground': '#172b4d', 'input-border': '#dfe1e6', 'focusBorder': '#1868db',
  'editor-selectionBackground': '#cce0ff', 'editor-inactiveSelectionBackground': '#e9f2ff',
  'errorForeground': '#c9372c', 'editorWarning-foreground': '#b38600', 'descriptionForeground': '#626f86',
  'font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 'font-size': '13px', 'font-weight': '400',
  'editor-font-family': "'SF Mono', Menlo, Consolas, monospace", 'charts-green': '#22a06b', 'charts-purple': '#8f7ee7',
  'editorHoverWidget-background': '#ffffff', 'editorHoverWidget-border': '#dfe1e6', 'editorHoverWidget-foreground': '#172b4d',
  'editorWidget-background': '#ffffff', 'list-activeSelectionBackground': '#e9f2ff', 'list-activeSelectionForeground': '#172b4d',
  'textLink-foreground': '#1868db', 'textLink-activeForeground': '#0c66e4',
};
writeFileSync(join(OUT, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="out.css">
<style>html,body,#root{margin:0;padding:0;width:100%;height:100vh;overflow:hidden;background:#fff}
:root{${Object.entries(VARS).map(([k, v]) => `--vscode-${k}:${v}`).join(';')}}</style></head>
<body data-vscode-theme-kind="vscode-light"><div id="root"></div><script type="module" src="out.js"></script></body></html>`);

await build({
  entryPoints: [join(OUT, 'entry.tsx')], bundle: true, outfile: join(OUT, 'out.js'), format: 'esm', platform: 'browser', target: 'es2022',
  jsx: 'automatic', loader: { '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'warning',
  nodePaths: [join(ROOT, 'node_modules')], tsconfig: join(ROOT, 'tsconfig.webview.json'),
  define: { 'process.env.NODE_ENV': '"production"', __ELK_WORKER_CODE__: '""' },
  alias: {
    '@erd-studio/renderer/styles.css': join(ROOT, 'packages/renderer/src/styles.css'),
    '@erd-studio/renderer': join(ROOT, 'packages/renderer/src/index.ts'),
    '@erd-studio/core/dbml': join(ROOT, 'packages/core/src/dbml/index.ts'),
    '@erd-studio/core': join(ROOT, 'packages/core/src/index.ts'),
  },
});

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: SHOT.width, height: SHOT.height }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => { console.error(e); process.exitCode = 1; });
  // a module script needs http, not file://
  const { startServer } = await import('./serve.mjs');
  const server = await startServer(0);
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/video/build/confluence/index.html`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: SHOT.file });
  } finally { server.close(); }
} finally { await browser.close(); }
console.log(`confluence-shot: ${SHOT.file} (${SHOT.width * 2}x${SHOT.height * 2})`);
