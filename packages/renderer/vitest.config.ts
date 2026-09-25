import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Runs this package's tests on their own (`npm test -w @erd-studio/renderer`).
// The repo-root vitest config also picks up packages/*/test, so `npm test` at
// the root runs them too. `@erd-studio/core` resolves to its source, as it does
// at the root, so no build is needed first.
const coreSource = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    passWithNoTests: true,
    alias: [{ find: /^@erd-studio\/core$/, replacement: coreSource }],
  },
  resolve: {
    alias: [{ find: /^@erd-studio\/core$/, replacement: coreSource }],
  },
  esbuild: {
    jsx: 'automatic',
  },
});
