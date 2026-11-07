#!/usr/bin/env node
/**
 * Runs the AI sync eval (`eval.ts`, see the README beside it):
 * `npm run eval:sync-ai` (pass `-- --self-check` to check the checks for free).
 *
 * The eval reuses `test/unit/syncPlanApply.harness.ts`, which imports
 * `vscode` (the test mock), `vitest` and markdown as text, so it is bundled
 * with esbuild first, like `scripts/regen-dbt-dbml-fixture.ts`: `.md` as text,
 * `vscode` → `test/__mocks__/vscode.ts`, `vitest` → `vitest-shim.ts`. The
 * bundle is compiled in memory under a file name in `test/unit/` (never
 * written there), because the harness finds the fixtures from its own
 * `__dirname`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const REDIRECT = {
  vscode: path.join(ROOT, 'test', '__mocks__', 'vscode.ts'),
  vitest: path.join(HERE, 'vitest-shim.ts'),
};
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

const result = await esbuild.build({
  entryPoints: [path.join(HERE, 'eval.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  write: false,
  outfile: path.join(ROOT, 'test', 'unit', '.sync-apply-ai-eval.cjs'),
  loader: { '.md': 'text' },
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  // Mirrors the CLI bundle's define (esbuild.js): doctor reads it.
  define: { __ERD_CLI_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: 'inline',
  logLevel: 'warning',
  plugins: [{
    name: 'redirect',
    setup(build) {
      build.onResolve({ filter: /^(vscode|vitest)$/ }, (args) => ({ path: REDIRECT[args.path] }));
    },
  }],
});

const code = result.outputFiles.find((f) => f.path.endsWith('.cjs')).text;
const filename = path.join(ROOT, 'test', 'unit', '.sync-apply-ai-eval.cjs');
process.setSourceMapsEnabled(true);
const mod = new Module(filename);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(path.dirname(filename));
mod._compile(code, filename);

const exitCode = await mod.exports.main(process.argv.slice(2));
process.exit(exitCode);
