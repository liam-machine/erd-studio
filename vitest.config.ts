import { defineConfig } from 'vitest/config';
import fs from 'fs';
import path from 'path';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };

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
  // Mirrors the CLI bundle's esbuild `define` (esbuild.js, cliConfig).
  define: {
    __ERD_CLI_VERSION__: JSON.stringify(pkg.version),
  },
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
