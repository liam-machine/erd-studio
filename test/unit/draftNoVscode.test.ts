/**
 * The draft services are pure (docs/dev/draft-first.md §1 rule 6): bundling
 * them the way esbuild bundles the extension must never resolve `vscode`.
 * As `cli.noVscode.test.ts` does for the CLI, a failure names the importer.
 */
import * as path from 'path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const MODULES = ['src/services/draftModel.ts', 'src/services/draftDisplay.ts', 'src/services/draftTriggers.ts'];

describe('draft services', () => {
  it.each(MODULES)('%s never imports vscode', async (entry) => {
    const vscodeImporters: string[] = [];
    const result = await build({
      entryPoints: [path.join(ROOT, entry)],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      loader: { '.md': 'text' },
      define: { __ERD_EXAMPLES__: JSON.stringify('{}'), __ERD_CLI_VERSION__: JSON.stringify('0.0.0-test') },
      metafile: true,
      logLevel: 'silent',
      plugins: [{
        name: 'no-vscode',
        setup(b) {
          b.onResolve({ filter: /^vscode$/ }, (args) => {
            vscodeImporters.push(path.relative(ROOT, args.importer));
            return { path: 'vscode', external: true };
          });
        },
      }],
    });
    expect(vscodeImporters).toEqual([]);
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.some((i) => i.endsWith(entry))).toBe(true);
    expect(inputs.some((i) => /(^|\/)vscode(\/|$)/.test(i))).toBe(false);
  });
});
