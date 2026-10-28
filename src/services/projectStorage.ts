/**
 * How the project stores its logical model (native DBML storage, §3.2):
 * core's `detectProjectStorage`, fed with what is on disk. The one host
 * answer, shared by the canvas, the commands, the offers, the
 * `erdStudio.storage` context key and `erd-studio doctor`, so they never
 * disagree. No `vscode`: the CLI bundles it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { classifySemanticFile, detectProjectStorage } from '@erd-studio/core';
import type { ProjectStorage } from '@erd-studio/core';

/** What the table library knows, as {@link projectStorageIn} needs it. */
export interface StorageLibraryView {
  listTableFiles(): ReadonlyArray<{ readonly storage: 'yaml' | 'dbml' }>;
  /** Every relationships file of the DBML library. */
  listRelationshipsFiles(): readonly string[];
  /** `logical-models/` exists, empty or not. */
  hasV5Folder(): boolean;
  /** `tables/` is the table library (it holds a table file and is not a layer). */
  hasTablesLibrary(): boolean;
}

/**
 * The storage of every subject area file (`{layer}/*.json`, `{layer}/*.dbml`)
 * under `semanticRoot`, by the single classifier (a `.dbml` saved there by
 * Export, whose first line is the export header, is not a diagram).
 */
export function subjectAreaStoragesIn(semanticRoot: string, tablesIsLayer: boolean): Array<'json' | 'dbml'> {
  const storages: Array<'json' | 'dbml'> = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(semanticRoot, { withFileTypes: true });
  } catch {
    return storages;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let files: string[];
    try {
      files = fs.readdirSync(path.join(semanticRoot, dir.name));
    } catch {
      continue;
    }
    for (const file of files) {
      const rel = `${dir.name}/${file}`;
      if (!file.endsWith('.json') && !file.endsWith('.dbml')) continue;
      const firstLine = file.endsWith('.dbml') ? readFirstLine(path.join(semanticRoot, dir.name, file)) : undefined;
      const kind = classifySemanticFile(rel, { tablesDirIsLayer: tablesIsLayer, ...(firstLine !== undefined ? { firstLine } : {}) });
      if (kind.kind === 'diagram' && (kind.storage === 'json' || kind.storage === 'dbml')) storages.push(kind.storage);
    }
  }
  return storages;
}

/** The first line of `filePath` (at most 512 bytes read), or undefined when it cannot be read. */
export function readFirstLine(filePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf-8').split(/\r?\n/)[0];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * The project's storage, to **write**: `yaml` whenever `tables/` is a layer
 * folder (a DBML project never has one), else core's answer from the
 * library's files and every subject area's storage. A project with no
 * library and no diagrams is `dbml`.
 */
export function projectStorageIn(semanticRoot: string, library: StorageLibraryView, tablesIsLayer: boolean): ProjectStorage {
  if (tablesIsLayer) return 'yaml';
  const files = library.listTableFiles();
  return detectProjectStorage({
    hasYamlTables: files.some((f) => f.storage === 'yaml'),
    hasV5Folder: library.hasV5Folder() && !library.hasTablesLibrary(),
    hasDbmlTables: files.some((f) => f.storage === 'dbml') || library.listRelationshipsFiles().length > 0,
    subjectAreaStorages: subjectAreaStoragesIn(semanticRoot, tablesIsLayer),
  });
}

/** The table library's memoised {@link projectStorageIn} (`TableLibraryService.projectStorage`). */
export function projectStorageOf(tableLibraryService: { projectStorage(): ProjectStorage }): ProjectStorage {
  return tableLibraryService.projectStorage();
}
