// Re-shoots player/assets/confluence-sales.png and confluence-sales-before.png (the same diagram
// without fct_order's `status`, before the scene's commit lands), the diagram on the README cut's Confluence page
// (player/scenes/readme/confluence.js): @erd-studio/renderer's ErdCanvas in viewer mode, as the
// ERD Studio for Confluence macro draws it, rendered from this repo's own packages (no Confluence
// app code) with a light theme, 880x555 at 2x.
//
//   node confluence-shot.mjs           (needs the repo root's npm install for esbuild and React)
//   node confluence-shot.mjs --launch  the launch cut's page instead: confluence-launch.display.json
//                                      (the six-table sales schema it imports) -> confluence-launch.png
//
// The diagram is player/assets/confluence-sales.display.json: the story's `sales` diagram
// (scenes/readme/story.js, R): dim_customer and fct_order in the gold layer, fct_order with the
// `status` column the canvas and PR scenes add. fct_order sits higher than dim_customer so the
// minimap (bottom right) never covers its footer.
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'build-confluence');
const ASSETS = join(HERE, 'player/assets');
mkdirSync(OUT, { recursive: true });
const LAUNCH = process.argv.includes('--launch');
const DISPLAY = LAUNCH ? 'confluence-launch.display.json' : 'confluence-sales.display.json';
const SHOTS = LAUNCH ? [['', 'confluence-launch.png']] : [['', 'confluence-sales.png'], ['#before', 'confluence-sales-before.png']];

writeFileSync(join(OUT, 'entry.tsx'), `import { createRoot } from 'react-dom/client';
import { ErdCanvas } from '@erd-studio/renderer';
import '@erd-studio/renderer/styles.css';
import domain from ${JSON.stringify(join(ASSETS, DISPLAY))};
// #before: the diagram before the commit that adds fct_order's status column.
const before = location.hash === '#before';
const shown = before
  ? { ...domain, models: domain.models.map((m: any) => (m.name === 'fct_order' ? { ...m, columns: m.columns.filter((c: any) => c.name !== 'status') } : m)) }
  : domain;
createRoot(document.getElementById('root')!).render(
  <ErdCanvas domain={shown as never} onReady={() => { (window as any).__ready = true; }} />,
);
`);

// A light page, as Confluence shows the macro (the README's --vscode-* list).
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
<body data-vscode-theme-kind="vscode-light"><div id="root"></div><script src="out.js"></script></body></html>`);

await build({
  entryPoints: [join(OUT, 'entry.tsx')], bundle: true, outfile: join(OUT, 'out.js'), format: 'iife', platform: 'browser',
  jsx: 'automatic', loader: { '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'warning',
  nodePaths: [join(ROOT, 'node_modules')], tsconfig: join(ROOT, 'tsconfig.webview.json'),
  define: { 'process.env.NODE_ENV': '"production"', __ELK_WORKER_CODE__: '""' },
  alias: {
    '@erd-studio/renderer/styles.css': join(ROOT, 'packages/renderer/src/styles.css'),
    '@erd-studio/renderer': join(ROOT, 'packages/renderer/src/index.ts'),
    '@erd-studio/core': join(ROOT, 'packages/core/src/index.ts'),
  },
});

const browser = await chromium.launch();
for (const [hash, file] of SHOTS) {
  const page = await browser.newPage({ viewport: { width: 880, height: 555 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => { console.error(e); process.exitCode = 1; });
  await page.goto('file://' + join(OUT, 'index.html') + hash);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(ASSETS, file) });
  await page.close();
  console.log(`confluence-shot: player/assets/${file} (1760x1110)`);
}
await browser.close();
