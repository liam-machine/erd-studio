import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/unit/**/*.test.tsx'],
    // Builds dist/manifestWorker.js so ManifestService tests pass on a fresh clone.
    globalSetup: ['test/globalSetup.ts'],
    alias: {
      vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts'),
    },
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts'),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
});
