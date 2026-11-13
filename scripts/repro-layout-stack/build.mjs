// Bundles the real webview/lib/elkLayout.ts + firstOpenLayout.ts for Node,
// with elk-api swapped for the in-process engine (elkShim.cjs).
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
await build({
  stdin: {
    contents: `export * from './webview/lib/elkLayout'; export * from './webview/lib/firstOpenLayout';`,
    resolveDir: root, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs',
  outfile: path.join(here, '.out/layout.cjs'),
  tsconfig: path.join(root, 'tsconfig.webview.json'),
  define: { __ELK_WORKER_CODE__: '""' },
  alias: { 'elkjs/lib/elk-api': path.join(here, 'elkShim.cjs') },
  external: ['elkjs/*'],
  logLevel: 'warning',
});
console.log('built', path.join(here, '.out/layout.cjs'));
