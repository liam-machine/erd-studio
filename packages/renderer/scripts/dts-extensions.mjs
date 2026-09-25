// Adds file extensions to the relative imports in the emitted declarations.
//
// The sources import each other without extensions (`./lib/nodeSizing`),
// which bundlers and `moduleResolution: bundler` accept, and tsc copies those
// specifiers into dist/types as written. A consumer type-checking with
// `moduleResolution: node16` or `nodenext` needs `./lib/nodeSizing.js` (or
// `./dir/index.js`), so this rewrites every relative specifier in the .d.ts
// files to the declaration it resolves to. A specifier that resolves to no
// declaration fails the build.
//
// Usage: node scripts/dts-extensions.mjs [dir]   (default dist/types)
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `from './x'`, `import('./x')` and `import './x'`, with either quote.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\2/g;

function withExtension(fromDir, specifier, file) {
  if (/\.(js|mjs|cjs|json|css)$/.test(specifier)) {
    return specifier;
  }
  const target = resolve(fromDir, specifier);
  if (existsSync(`${target}.d.ts`)) {
    return `${specifier}.js`;
  }
  if (existsSync(join(target, 'index.d.ts'))) {
    return `${specifier.replace(/\/$/, '')}/index.js`;
  }
  throw new Error(`${file}: cannot resolve '${specifier}' to a declaration file`);
}

/** Rewrite every .d.ts under `dir` in place; returns how many files changed. */
export function addDtsExtensions(dir) {
  let changed = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const file = join(current, entry);
      if (statSync(file).isDirectory()) {
        walk(file);
      } else if (file.endsWith('.d.ts')) {
        const text = readFileSync(file, 'utf8');
        const next = text.replace(SPECIFIER, (_match, lead, quote, specifier) =>
          `${lead}${quote}${withExtension(dirname(file), specifier, file)}${quote}`);
        if (next !== text) {
          writeFileSync(file, next);
          changed++;
        }
      }
    }
  };
  walk(dir);
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('../dist/types', import.meta.url)));
  addDtsExtensions(dir);
}
