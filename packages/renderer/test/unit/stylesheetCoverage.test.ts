/**
 * The package stylesheet (`dist/styles.css`, built from `src/styles.css`) is
 * the only CSS a downstream page loads: the build drops the components' own
 * `.css` imports. So every stylesheet a component imports must be in
 * `src/styles.css`, or the viewer draws that component unstyled (the Fields
 * section once was).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('src/styles.css', () => {
  it('imports every stylesheet a component imports', () => {
    const sheet = readFileSync(join(SRC, 'styles.css'), 'utf8');
    const listed = new Set([...sheet.matchAll(/@import '\.\/([^']+\.css)';/g)].map((m) => m[1]));
    const imported = new Set<string>();
    for (const file of walk(SRC).filter((f) => /\.tsx?$/.test(f))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/^import '\.\/([^']+\.css)';/gm)) {
        imported.add(relative(SRC, join(file, '..', m[1])));
      }
    }
    expect(imported.size).toBeGreaterThan(10);
    expect([...imported].filter((css) => !listed.has(css)).sort()).toEqual([]);
  });
});
