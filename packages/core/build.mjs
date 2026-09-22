// Bundles src/index.ts into a single ESM file (dist/index.js) so Node ESM,
// vitest and webpack-based consumers can all load it. `yaml` stays external.
// Declarations are emitted separately by `tsc -p tsconfig.build.json`.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2020',
  external: ['yaml'],
  outfile: 'dist/index.js',
  sourcemap: true,
  logLevel: 'warning',
});
