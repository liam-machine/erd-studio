import { configDefaults, defineConfig } from 'vitest/config';
import fs from 'fs';
import path from 'path';
// The same reader esbuild.js uses for the extension bundle's `__ERD_EXAMPLES__`.
import { exampleBundleDefine } from './scripts/exampleBundle.cjs';
import { TEST_SETS, TIMING_TEST_FILES, type TestSet } from './test/timingTests';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };
// The workspace packages resolve to their TypeScript source here, the same way
// tsconfig `paths` resolve them for tsc and esbuild. Their package.json
// `exports` point only at the built dist/, which the extension never needs.
// Exact-match regexes, so e.g. `@erd-studio/renderer/styles.css` is not caught.
const alias = [
  { find: 'vscode', replacement: path.resolve(__dirname, 'test/__mocks__/vscode.ts') },
  { find: /^@erd-studio\/core\/dbml$/, replacement: path.resolve(__dirname, 'packages/core/src/dbml/index.ts') },
  { find: /^@erd-studio\/core$/, replacement: path.resolve(__dirname, 'packages/core/src/index.ts') },
  { find: /^@erd-studio\/renderer$/, replacement: path.resolve(__dirname, 'packages/renderer/src/index.ts') },
  {
    find: /^@erd-studio\/renderer\/(editor|store|sizing)$/,
    replacement: path.resolve(__dirname, 'packages/renderer/src') + '/$1.ts',
  },
];

// Which test files run (test/timingTests.ts): unset, all of them; `main`, all
// but the wall-clock-budget files (CI's four shards); `timing`, only those,
// one file at a time (CI's test-timing job).
const testSet = process.env.ERD_TEST_SET || undefined;
if (testSet !== undefined && !(TEST_SETS as readonly string[]).includes(testSet)) {
  throw new Error(`ERD_TEST_SET must be unset or one of ${TEST_SETS.join(', ')}; got "${testSet}"`);
}
const testFiles = [
  'test/unit/**/*.test.ts',
  'test/unit/**/*.test.tsx',
  'packages/*/test/**/*.test.ts',
  'packages/*/test/**/*.test.tsx',
];
// Unset changes nothing else, so a plain `vitest run` is exactly as before.
const selection: Record<TestSet, { include: string[]; exclude?: string[]; fileParallelism?: boolean }> = {
  main: { include: testFiles, exclude: [...configDefaults.exclude, ...TIMING_TEST_FILES] },
  timing: { include: [...TIMING_TEST_FILES], fileParallelism: false },
};
const tests = testSet ? selection[testSet as TestSet] : { include: testFiles };

export default defineConfig({
  plugins: [
    // Mirrors esbuild's `loader: { '.md': 'text' }` — a markdown import is its text.
    {
      name: 'md-text',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('.md')) return { code: 'export default ' + JSON.stringify(code) + ';', map: null };
        return undefined;
      },
    },
  ],
  // Mirrors the esbuild `define`s: the CLI bundle's version (cliConfig) and
  // the extension bundle's example projects (extensionConfig).
  define: {
    __ERD_CLI_VERSION__: JSON.stringify(pkg.version),
    __ERD_EXAMPLES__: exampleBundleDefine(),
  },
  test: {
    globals: true,
    environment: 'node',
    ...tests,
    // Builds dist/manifestWorker.js so ManifestService tests pass on a fresh clone.
    globalSetup: ['test/globalSetup.ts'],
    alias,
  },
  resolve: {
    alias,
  },
  esbuild: {
    jsx: 'automatic',
  },
});
