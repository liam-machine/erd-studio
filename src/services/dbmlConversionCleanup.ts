/**
 * Convert Project to DBML's folder clean-up (step 10): the YAML library's
 * folders the conversion emptied go, so a converted project holds only the
 * layer-first tree. Shared by the command and the e2e and twin scripts
 * (`scripts/convert-fixture.ts`, `scripts/regen-dbml-twins.ts`). No `vscode`.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LOGICAL_MODELS_DIR, TABLES_DIR } from '@erd-studio/core';

/**
 * Remove the YAML library's folders a conversion emptied: every folder of a
 * deleted `.yml` under `logical-models/` or the v6 `tables/` library, then
 * those two, deepest first, each only when it holds nothing at all now. A
 * folder still holding a file (a table left as it is, a dotfile) stays.
 * `deletes` are the plan's, relative to `semanticRoot`. Convert never runs
 * with a `tables` layer (it is reserved), so `tables/` here is the library.
 */
export function removeEmptiedLibraryFolders(semanticRoot: string, deletes: readonly string[]): void {
  const roots = [LOGICAL_MODELS_DIR, TABLES_DIR].map((dir) => path.join(semanticRoot, dir));
  const inLibrary = (dir: string): boolean => roots.some((root) => dir === root || dir.startsWith(`${root}${path.sep}`));
  const emptied = new Set(deletes
    .filter((d) => /\.ya?ml$/i.test(d))
    .map((d) => path.dirname(path.join(semanticRoot, ...d.split('/'))))
    .filter(inLibrary));
  for (const folder of [...emptied, ...roots].sort((a, b) => b.length - a.length)) {
    try { if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder); } catch { /* already gone, or not empty */ }
  }
}
