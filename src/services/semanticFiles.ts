/**
 * Every file under a semantic dir, classified (`classifySemanticFile`):
 * the one walk `doctor`'s stray-file check and Convert's input listing use,
 * so they agree on what each file is.
 *
 * Path-only: it lists directories and reads no file. It skips dot entries,
 * `node_modules` and symbolic links to directories, and lists files at most
 * five segments deep (`<layer>/tables/<schema>/<table>.dbml` is four).
 *
 * No `vscode`: the CLI bundles it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { classifySemanticFile } from '@erd-studio/core';
import type { SemanticFileClass } from '@erd-studio/core';
import { listDir } from './tableLibraryIndex';

/** The deepest file the walk lists, in path segments. */
const MAX_DEPTH = 5;

/** Code-unit order (`<`). */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether a symbolic link points at a directory (a broken link does not). */
function linksToDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every file under `semanticRoot` with its class, by its posix path
 * relative to the semantic dir, byte-sorted. `tablesDirIsLayer` is the
 * project's answer for a `tables/` folder (`TableLibraryService.tablesDirIsLayer`).
 */
export function listSemanticFiles(semanticRoot: string, opts: { tablesDirIsLayer: boolean }): Array<{ rel: string; cls: SemanticFileClass }> {
  const out: Array<{ rel: string; cls: SemanticFileClass }> = [];
  const visit = (relDir: string, depth: number): void => {
    const abs = relDir === '' ? semanticRoot : path.join(semanticRoot, ...relDir.split('/'));
    for (const entry of listDir(abs) ?? []) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const isDir = entry.dir || (entry.link ? linksToDirectory(path.join(abs, entry.name)) : false);
      if (isDir) {
        if (!entry.link && depth < MAX_DEPTH) visit(rel, depth + 1);
        continue;
      }
      if (!entry.file && !entry.link) continue;
      out.push({ rel, cls: classifySemanticFile(rel, { tablesDirIsLayer: opts.tablesDirIsLayer }) });
    }
  };
  visit('', 1);
  return out.sort((a, b) => byteOrder(a.rel, b.rel));
}
