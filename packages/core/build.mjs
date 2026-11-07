// Bundles the two entries — src/index.ts (parser-free) and src/dbml/index.ts
// (the `@erd-studio/core/dbml` subpath, the only one that loads @dbml/parse) —
// in ONE esbuild call with code splitting, so the modules both use (domain.ts
// and its error classes) land in one shared chunk: `instanceof
// SubjectAreaFileError` holds for an error the DBML readers throw. Output:
// dist/index.js and dist/dbml/index.js, ESM, for Node ESM, vitest and
// webpack-based consumers. `yaml` and `@dbml/parse` stay external.
// Declarations are emitted separately by `tsc -p tsconfig.build.json`.
// ERD_CORE_OUTDIR (absolute) builds somewhere else, for the test that loads
// the built entries (test/unit/coreDistEntries.test.ts).
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const outdir = process.env.ERD_CORE_OUTDIR || 'dist';
rmSync(new URL(outdir === 'dist' ? './dist' : `file://${outdir}`, import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ['src/index.ts', 'src/dbml/index.ts'],
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2020',
  external: ['yaml', '@dbml/parse'],
  outdir,
  absWorkingDir: here,
  outbase: 'src',
  entryNames: '[dir]/[name]',
  chunkNames: 'chunks/[name]-[hash]',
  sourcemap: true,
  logLevel: 'warning',
});
