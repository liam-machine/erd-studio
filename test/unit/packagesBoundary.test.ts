/**
 * Guard rails for the workspace packages (packages/core, packages/renderer).
 *
 * Both are published to npm and consumed outside the extension, so their
 * source must not reach back into the extension (vscode, the webview, the ELK
 * runner) or, for core, into Node or the browser. These checks read the
 * source as text, so a violation fails here rather than in a consumer's build.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// (f) below: the extension store and the ELK runner must load without React
// Flow's runtime. Any import of it — not just a use — fails the test.
vi.mock('@xyflow/react', () => {
  throw new Error('@xyflow/react was loaded at runtime');
});

const ROOT = path.resolve(__dirname, '../..');
const PACKAGES = path.join(ROOT, 'packages');
const CORE_SRC = path.join(PACKAGES, 'core/src');
const RENDERER = path.join(PACKAGES, 'renderer');
const RENDERER_SRC = path.join(RENDERER, 'src');

/** Every file under `dir`, skipping installed and built output. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const isSource = (f: string) => /\.(ts|tsx)$/.test(f);

/** Module specifiers a TS/TSX/CSS file imports, re-exports or requires. */
function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /@import\s+(?:url\()?['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

const rel = (f: string) => path.relative(ROOT, f);

describe('workspace package boundaries', () => {
  it('(a) core source imports no Node built-ins, vscode, React or React Flow', () => {
    const banned = /^(fs|path|crypto|vscode|react|react-dom)(\/|$)|^node:|^@xyflow\//;
    const violations: string[] = [];
    for (const file of walk(CORE_SRC).filter(isSource)) {
      for (const spec of importsOf(file)) {
        if (banned.test(spec)) violations.push(`${rel(file)} imports ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('(b) renderer source imports nothing from vscode, elkjs or the webview, and stays inside the package', () => {
    const violations: string[] = [];
    for (const file of walk(RENDERER_SRC).filter((f) => isSource(f) || f.endsWith('.css'))) {
      for (const spec of importsOf(file)) {
        if (/^vscode(\/|$)|^elkjs(\/|$)|(^|\/)webview(\/|$)/.test(spec)) {
          violations.push(`${rel(file)} imports ${spec}`);
        }
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(file), spec);
          if (!target.startsWith(RENDERER + path.sep)) {
            violations.push(`${rel(file)} reaches outside the package: ${spec}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('(c) every package ships a byte-identical copy of the root LICENSE', () => {
    const license = fs.readFileSync(path.join(ROOT, 'LICENSE'));
    const packages = fs.readdirSync(PACKAGES, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(packages.map((d) => d.name).sort()).toEqual(['core', 'renderer']);
    for (const dir of packages) {
      const copy = fs.readFileSync(path.join(PACKAGES, dir.name, 'LICENSE'));
      expect(copy.equals(license), `packages/${dir.name}/LICENSE`).toBe(true);
    }
  });

  it('(d) no package source calls acquireVsCodeApi', () => {
    const offenders = [...walk(CORE_SRC), ...walk(RENDERER_SRC)]
      .filter((f) => fs.readFileSync(f, 'utf8').includes('acquireVsCodeApi'))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('(e) package files and the new test files name no downstream product', () => {
    // Assembled from pieces so this file does not trip its own check.
    const forbidden = new RegExp(
      [
        'erd-' + 'renderer',
        'erd-studio-' + 'pro',
        'Conflu' + 'ence',
        'For' + 'ge',
        'Atlas' + 'sian',
        'mac' + 'ro',
      ].join('|'),
      'i',
    );
    const files = [
      ...walk(PACKAGES),
      path.join(ROOT, 'test/unit/packagesBoundary.test.ts'),
      path.join(ROOT, 'test/unit/vscodeCanvasHost.test.ts'),
      path.join(ROOT, 'test/unit/elkLayoutSizing.test.ts'),
      path.join(ROOT, 'test/unit/displayDomainGolden.test.ts'),
      path.join(ROOT, 'test/unit/domainFormatPalette.test.ts'),
      path.join(ROOT, 'test/unit/packagesNodeNext.test.ts'),
      path.join(ROOT, 'src/services/positionService.ts'),
      path.join(ROOT, 'webview/host/vscodeCanvasHost.ts'),
      path.join(ROOT, 'webview/styles/host.css'),
    ];
    const hits: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (forbidden.test(line)) hits.push(`${rel(file)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  // Native DBML storage (§4.1 bundle rules 1–3): the parser stays behind the
  // `@erd-studio/core/dbml` subpath, so the webview and the renderer never load it.
  it('(g) only packages/core/src/dbml/ (and the host\'s Import DBML parser) import @dbml/parse', () => {
    const allowed = new Set([
      path.join(ROOT, 'src/services/dbmlImportParse.ts'),
    ]);
    const roots = [CORE_SRC, RENDERER_SRC, path.join(ROOT, 'src'), path.join(ROOT, 'webview'), path.join(ROOT, 'mcp-server/src')];
    const violations: string[] = [];
    for (const file of roots.flatMap((r) => walk(r)).filter(isSource)) {
      if (file.startsWith(path.join(CORE_SRC, 'dbml') + path.sep) || allowed.has(file)) continue;
      for (const spec of importsOf(file)) {
        if (/^@dbml\/parse(\/|$)/.test(spec)) violations.push(`${rel(file)} imports ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('(h) nothing reachable from core\'s main entry makes a value import from ./dbml/', () => {
    /** Relative imports that load a module at runtime (`import type` / `export type` load nothing). */
    const valueImports = (file: string): string[] => {
      const text = fs.readFileSync(file, 'utf8');
      const specs: string[] = [];
      for (const m of text.matchAll(/\b(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) {
        if (!m[2]) specs.push(m[3]);
      }
      for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
      return specs.filter((s) => s.startsWith('.'));
    };
    const resolve = (from: string, spec: string): string => {
      const base = path.resolve(path.dirname(from), spec).replace(/\.js$/, '');
      for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(candidate)) return candidate;
      return base;
    };
    const seen = new Set<string>();
    const queue = [path.join(CORE_SRC, 'index.ts')];
    const violations: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of valueImports(file)) {
        const target = resolve(file, spec);
        if (target.startsWith(path.join(CORE_SRC, 'dbml') + path.sep)) violations.push(`${rel(file)} imports ${spec}`);
        else if (fs.existsSync(target)) queue.push(target);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    expect(violations).toEqual([]);
  });

  it('(i) the webview and the renderer never import @erd-studio/core/dbml, and the webview tsconfig has no path for it', () => {
    const violations: string[] = [];
    for (const file of [...walk(path.join(ROOT, 'webview')), ...walk(RENDERER_SRC)].filter(isSource)) {
      for (const spec of importsOf(file)) {
        if (spec === '@erd-studio/core/dbml' || /packages\/core\/src\/dbml/.test(spec)) violations.push(`${rel(file)} imports ${spec}`);
      }
    }
    expect(violations).toEqual([]);
    const webviewConfig = fs.readFileSync(path.join(ROOT, 'tsconfig.webview.json'), 'utf8');
    expect(webviewConfig).not.toContain('@erd-studio/core/dbml');
  });

  it('(f) the extension store and the ELK runner load without React Flow', async () => {
    const store = await import('../../webview/store/editorStore');
    const elk = await import('../../webview/lib/elkLayout');
    expect(typeof store.useEditorStore.getState).toBe('function');
    expect(typeof elk.runElkLayout).toBe('function');
    expect(typeof elk.estimateNodeWidth).toBe('function');
  });
});
