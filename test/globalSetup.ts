/**
 * Vitest global setup — builds dist/manifestWorker.js from src before any
 * test runs.
 *
 * ManifestService parses manifests in a worker thread. Under vitest (unbundled)
 * it resolves that worker from `<root>/dist/manifestWorker.js`, so on a fresh
 * clone (no dist/) every manifest test fails, and a stale dist/ would silently
 * exercise old worker code. Only the worker entry is built here (milliseconds);
 * `npm run build` still owns the extension + webview bundles.
 *
 * Keep these options in sync with `workerConfig` in esbuild.js.
 */
import * as path from 'path';
import { build } from 'esbuild';

export default async function globalSetup(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  await build({
    entryPoints: [path.join(root, 'src', 'workers', 'manifestWorker.ts')],
    bundle: true,
    outfile: path.join(root, 'dist', 'manifestWorker.js'),
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    treeShaking: true,
    logLevel: 'warning',
  });
}
