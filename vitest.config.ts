import { defineConfig } from 'vitest/config';
import path from 'path';

// The workspace packages resolve to their TypeScript source here, the same way
// tsconfig `paths` resolve them for tsc and esbuild. Their package.json
// `exports` point only at the built dist/, which the extension never needs.
// Exact-match regexes, so e.g. `@erd-studio/renderer/styles.css` is not caught.
const alias = [
  { find: 'vscode', replacement: path.resolve(__dirname, 'test/__mocks__/vscode.ts') },
  { find: /^@erd-studio\/core$/, replacement: path.resolve(__dirname, 'packages/core/src/index.ts') },
  { find: /^@erd-studio\/renderer$/, replacement: path.resolve(__dirname, 'packages/renderer/src/index.ts') },
  {
    find: /^@erd-studio\/renderer\/(editor|store|sizing)$/,
    replacement: path.resolve(__dirname, 'packages/renderer/src') + '/$1.ts',
  },
];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'test/unit/**/*.test.ts',
      'test/unit/**/*.test.tsx',
      'packages/*/test/**/*.test.ts',
      'packages/*/test/**/*.test.tsx',
    ],
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
