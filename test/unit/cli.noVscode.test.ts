import * as path from 'path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

/**
 * dist/cli.js runs outside VS Code, so nothing it bundles may import 'vscode'.
 * It reads native DBML storage, so it bundles the pinned DBML parser (one copy).
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
    // Native DBML storage (§7.1): the CLI reads `.dbml` files, so it bundles
    // the DBML parser — the root's pinned `@dbml/parse`, never a test alias.
    const parserInputs = inputs.filter((i) => /@dbml|dbml-parse/.test(i));
    expect(parserInputs.some((i) => i.startsWith('node_modules/@dbml/parse/'))).toBe(true);
    expect(parserInputs.filter((i) => /dbml-parse-v\d/.test(i) || /node_modules\/.+\/node_modules\/@dbml\/parse\//.test(i))).toEqual([]);
  });
});

/**
 * One parser copy in every bundle that reads DBML (§4.1 rule 5, §7.6): a
 * drift between core's pin and the root's would bundle two copies of about
 * 435 KB. The marker string occurs a fixed number of times inside one copy
 * (3 in 10.3.1 and 11.0.0, minified), so the baseline is measured from a
 * bundle of the parser alone, never written as a literal.
 */
describe('one DBML parser copy per bundle', () => {
  const MARKER = 'UNEXPECTED_ELEMENT_DECLARATION';
  const count = (text: string): number => text.split(MARKER).length - 1;
  const bundle = async (options: Parameters<typeof build>[0]): Promise<string> => {
    const result = await build({ bundle: true, write: false, platform: 'node', logLevel: 'silent', loader: { '.md': 'text' }, ...options });
    return result.outputFiles!.map((f) => f.text).join('\n');
  };
  let baseline = 0;

  it('measures one copy of the pinned parser', async () => {
    baseline = count(await bundle({ stdin: { contents: "export * from '@dbml/parse';", resolveDir: ROOT, loader: 'js' }, format: 'cjs' }));
    expect(baseline).toBeGreaterThan(0);
  });

  it('dist/cli.js, dist/extension.js and the MCP server each hold exactly that one copy', async () => {
    const cli = await bundle({
      entryPoints: [path.join(ROOT, 'src/cli/index.ts')], format: 'cjs', target: 'node18',
      define: { __ERD_CLI_VERSION__: JSON.stringify('0.0.0-test') },
    });
    const extension = await bundle({ entryPoints: [path.join(ROOT, 'src/extension.ts')], format: 'cjs', external: ['vscode'] });
    const mcp = await bundle({
      entryPoints: [path.join(ROOT, 'mcp-server/src/index.ts')], format: 'esm', target: 'node18',
      tsconfig: path.join(ROOT, 'mcp-server/tsconfig.json'),
      external: ['@modelcontextprotocol/sdk', 'zod', 'yaml'],
    });
    expect({ cli: count(cli), extension: count(extension), mcp: count(mcp) }).toEqual({ cli: baseline, extension: baseline, mcp: baseline });
  }, 60_000);
});

