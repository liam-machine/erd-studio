// The example projects in docs/examples/, read for the extension bundle.
//
// Open an Example Project… (src/commands/openExampleProject.ts) writes one of
// these into a folder of the user's choosing. The VSIX is capped at 60 files,
// so the projects are not shipped as files: esbuild.js inlines them into
// dist/extension.js as the `__ERD_EXAMPLES__` define, and vitest.config.ts
// defines the same value for the tests. Both call this, so they agree.
// docs/examples stays the single source of truth; nothing generated is committed.
//
// Shape: { [exampleId]: { [posixPathInsideTheExample]: text } }, one entry per
// folder under docs/examples that holds a `.erd-studio/` folder, every file in
// it (dotfiles such as `.erd-studio/` and `.github/CODEOWNERS` included), OS
// junk aside. Ids and paths are sorted so the bundle is the same on every machine.

const fs = require('fs');
const path = require('path');

const EXAMPLES_DIR = path.resolve(__dirname, '..', 'docs', 'examples');

/** File names that are never part of an example. */
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Every file under `dir`, as posix paths relative to it, sorted. */
function filesUnder(dir, rel = '') {
  const out = [];
  const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (JUNK.has(entry.name)) continue;
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(dir, p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/** The ids of the example projects: each folder under `examplesDir` that holds `.erd-studio/`. */
function exampleIds(examplesDir = EXAMPLES_DIR) {
  return fs.readdirSync(examplesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(examplesDir, e.name, '.erd-studio')))
    .map((e) => e.name)
    .sort();
}

/** `{ [exampleId]: { [posixRelPath]: text } }` for every example project. */
function readExampleBundle(examplesDir = EXAMPLES_DIR) {
  const bundle = {};
  for (const id of exampleIds(examplesDir)) {
    const root = path.join(examplesDir, id);
    const files = {};
    for (const rel of filesUnder(root)) files[rel] = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf-8');
    bundle[id] = files;
  }
  return bundle;
}

/** The bundle as the `define` value: a string literal holding its JSON (parsed once, on first use). */
function exampleBundleDefine(examplesDir = EXAMPLES_DIR) {
  return JSON.stringify(JSON.stringify(readExampleBundle(examplesDir)));
}

module.exports = { EXAMPLES_DIR, exampleIds, readExampleBundle, exampleBundleDefine };
