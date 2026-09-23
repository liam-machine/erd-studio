import { defineConfig } from 'vitest/config';

// Runs this package's tests on their own (`npm test -w @erd-studio/core`).
// The repo-root vitest config also picks up packages/*/test, so `npm test` at
// the root runs them too.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    passWithNoTests: true,
  },
  esbuild: {
    jsx: 'automatic',
  },
});
