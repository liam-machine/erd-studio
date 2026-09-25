/**
 * The published declarations of the workspace packages must type-check for a
 * consumer on `moduleResolution: nodenext` (a `"type": "module"` project), not
 * only for bundler-style consumers. Node's ESM resolution needs every relative
 * import in a .d.ts to name its file (`./domain.js`), so an extensionless one
 * turns every export behind it into "has no exported member".
 *
 * The declarations are emitted into a temporary node_modules with each
 * package's own build config (the renderer's then go through the same
 * extension rewrite as its build), so this runs without a prior
 * `npm run build:packages`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const TSC = path.join(ROOT, 'node_modules/typescript/bin/tsc');

/** Run tsc; return its output, or throw with that output when it fails. */
function tsc(args: string[]): string {
  try {
    return execFileSync(process.execPath, [TSC, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`tsc ${args.join(' ')} failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
}

const CONSUMER = `
import {
  loadDisplayDomain,
  parseLogicalModelText,
  DomainValidationError,
  TooManyModelsError,
  FileTooLargeError,
  YamlNodeLimitError,
  YamlCharLimitError,
  type DisplayDomain,
  type LoadDisplayDomainOptions,
} from '@erd-studio/core';
import { ErdCanvas, transformDomain, repickHandleSides, type ErdCanvasHandle, type ErdCanvasProps } from '@erd-studio/renderer';
import { createCanvasStore, CanvasStoreProvider, type CanvasStore } from '@erd-studio/renderer/store';
import { estimateNodeHeight, NODE_WIDTH } from '@erd-studio/renderer/sizing';
import { CanvasEnvironmentProvider, ModelNode, useCanvasGraph, type CanvasHost } from '@erd-studio/renderer/editor';

const options: LoadDisplayDomainOptions = { domainPath: 'a/b/c.json', readFile: async () => null, readOnly: true };
export const loaded: Promise<DisplayDomain> = loadDisplayDomain(options);
export const errors = [DomainValidationError, TooManyModelsError, FileTooLargeError, YamlNodeLimitError, YamlCharLimitError];
export const model = parseLogicalModelText('name: a', 'a')?.name;
export const store = createCanvasStore();
export const selected: CanvasStore['selectedNode'] = store.getState().selectedNode;
export const host: CanvasHost = { postMessage: (m) => void m.type };
export const handle: ErdCanvasHandle | null = null;
export const props: Partial<ErdCanvasProps> = { nodesDraggable: true };
export const width: number = NODE_WIDTH + estimateNodeHeight(0, false);
export { ErdCanvas, transformDomain, repickHandleSides, CanvasStoreProvider, CanvasEnvironmentProvider, ModelNode, useCanvasGraph };
`;

describe('published declarations', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-studio-nodenext-'));
    const modules = path.join(tmp, 'node_modules');
    const coreDir = path.join(modules, '@erd-studio/core');
    const rendererDir = path.join(modules, '@erd-studio/renderer');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.mkdirSync(rendererDir, { recursive: true });

    // The packages themselves: package.json (for `exports`) plus declarations.
    fs.copyFileSync(path.join(ROOT, 'packages/core/package.json'), path.join(coreDir, 'package.json'));
    fs.copyFileSync(path.join(ROOT, 'packages/renderer/package.json'), path.join(rendererDir, 'package.json'));
    tsc(['-p', 'packages/core/tsconfig.build.json', '--outDir', path.join(coreDir, 'dist')]);

    // The renderer resolves core through its dist declarations, here the ones just emitted.
    const rendererConfig = path.join(tmp, 'tsconfig.renderer.json');
    fs.writeFileSync(rendererConfig, JSON.stringify({
      extends: path.join(ROOT, 'packages/renderer/tsconfig.build.json'),
      compilerOptions: {
        outDir: path.join(rendererDir, 'dist/types'),
        paths: { '@erd-studio/core': [path.join(coreDir, 'dist/index.d.ts')] },
      },
    }));
    tsc(['-p', rendererConfig]);
    const { addDtsExtensions } = await import('../../packages/renderer/scripts/dts-extensions.mjs');
    addDtsExtensions(path.join(rendererDir, 'dist/types'));

    // Their dependencies, from the repo's install.
    for (const dep of ['react', 'react-dom', 'zustand', 'yaml', '@xyflow', '@types']) {
      const target = path.join(modules, dep);
      if (!fs.existsSync(target)) {
        fs.symlinkSync(path.join(ROOT, 'node_modules', dep), target, 'junction');
      }
    }

    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
    fs.writeFileSync(path.join(tmp, 'consumer.ts'), CONSUMER);
  }, 120_000);

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each(['nodenext', 'node16', 'bundler'])('type-check for a consumer on moduleResolution %s', (resolution) => {
    const config = path.join(tmp, `tsconfig.${resolution}.json`);
    fs.writeFileSync(config, JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        module: resolution === 'bundler' ? 'ESNext' : resolution,
        moduleResolution: resolution,
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      files: ['consumer.ts'],
    }));
    expect(() => tsc(['-p', config])).not.toThrow();
  }, 120_000);
});
