// Builds the published package:
//   1. JS  — src/{index,editor,store,sizing}.ts as ESM with shared chunks, so
//      every entry point sees the same module instances (one store context,
//      one set of components). Component `.css` imports are dropped here
//      (`empty` loader); consumers load the single dist/styles.css instead.
//   2. CSS — src/styles.css, bundled in its explicit order into
//      dist/styles.css. The React Flow base stylesheet stays an `@import` for
//      the consumer's bundler to resolve.
// Declarations are emitted afterwards by `tsc -p tsconfig.build.json`, which
// resolves `@erd-studio/core` through its built dist, so core is built first
// when its declarations are missing.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const coreDir = fileURLToPath(new URL('../core/', import.meta.url));
if (!existsSync(new URL('../core/dist/index.d.ts', import.meta.url))) {
  execSync('npm run build', { cwd: coreDir, stdio: 'inherit' });
}

rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ['src/index.ts', 'src/editor.ts', 'src/store.ts', 'src/sizing.ts'],
  bundle: true,
  splitting: true,
  format: 'esm',
  outdir: 'dist',
  target: 'es2020',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime', '@xyflow/react', 'zustand', '@erd-studio/core'],
  logLevel: 'warning',
});

await build({
  entryPoints: ['src/styles.css'],
  bundle: true,
  outfile: 'dist/styles.css',
  external: ['@xyflow/react/dist/style.css'],
  logLevel: 'warning',
});
