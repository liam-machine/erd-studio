import * as path from 'path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

/**
 * dist/cli.js runs outside VS Code, so nothing it bundles may import 'vscode'.
 * Bundle it in memory the way esbuild.js does (no `external`) and fail if any
 * import resolves to 'vscode' — naming the chain, not just "bundle failed".
 */
describe('CLI bundle', () => {
  it('never imports vscode', async () => {
    const vscodeImporters: string[] = [];
    const result = await build({
      entryPoints: [path.join(ROOT, 'src/cli/index.ts')],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      loader: { '.md': 'text' },
      define: { __ERD_CLI_VERSION__: JSON.stringify('0.0.0-test') },
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
    expect(inputs.some((i) => i.includes('src/cli/index.ts'))).toBe(true);
    expect(inputs.some((i) => /(^|\/)vscode(\/|$)/.test(i))).toBe(false);
    // Self-contained: no worker file is needed at run time.
    expect(inputs.some((i) => i.includes('manifestWorker'))).toBe(false);
  });
});
