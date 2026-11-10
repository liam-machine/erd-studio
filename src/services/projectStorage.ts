/**
 * How the project stores its logical model (native DBML storage, §3.2):
 * core's `detectProjectStorage`, fed with what is on disk. The one host
 * answer, shared by the canvas, the commands, the offers, the
 * `erdStudio.storage` context key and `erd-studio doctor`, so they never
 * disagree. No `vscode`: the CLI bundles it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { DIAGRAMS_DIR, classifySemanticFile, detectProjectStorage, isDbmlLayerName } from '@erd-studio/core';
import type { ProjectStorage } from '@erd-studio/core';

/** What the table library knows, as {@link projectStorageIn} needs it. */
export interface StorageLibraryView {
  /** Every table file: YAML (`logical-models/`, `tables/`) or DBML (`<layer>/tables/<schema>/`). */
  listTableFiles(): ReadonlyArray<{ readonly storage: 'yaml' | 'dbml' }>;
  /** Every relationships file of the DBML library (`<layer>/relationships/*.dbml`). */
  listRelationshipsFiles(): readonly string[];
  /** `logical-models/` exists, empty or not. */
  hasV5Folder(): boolean;
  /** `tables/` is the table library (it holds a table file and is not a layer). */
  hasTablesLibrary(): boolean;
}

/**
 * The storage of every subject area file under `semanticRoot`: each
 * `{layer}/*.json` and each DBML diagram `{layer}/diagrams/*.dbml`, by the
 * single classifier (path only). `diagrams/` is listed only when the
 * layer's own listing shows it.
 */
export function subjectAreaStoragesIn(semanticRoot: string, tablesIsLayer: boolean): Array<'json' | 'dbml'> {
  const storages: Array<'json' | 'dbml'> = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(semanticRoot, { withFileTypes: true });
  } catch {
    return storages;
  }
  const add = (rel: string): void => {
    const kind = classifySemanticFile(rel, { tablesDirIsLayer: tablesIsLayer });
    if (kind.kind === 'diagram' && (kind.storage === 'json' || kind.storage === 'dbml')) storages.push(kind.storage);
  };
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(path.join(semanticRoot, dir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.name.endsWith('.json')) add(`${dir.name}/${file.name}`);
    }
    if (!files.some((f) => f.isDirectory() && f.name === DIAGRAMS_DIR) || !isDbmlLayerName(dir.name)) continue;
    let diagrams: string[];
    try {
      diagrams = fs.readdirSync(path.join(semanticRoot, dir.name, DIAGRAMS_DIR));
    } catch {
      continue;
    }
    for (const file of diagrams) {
      if (file.endsWith('.dbml')) add(`${dir.name}/${DIAGRAMS_DIR}/${file}`);
    }
  }
  return storages;
}

/**
 * The project's storage, to **write**: `yaml` whenever `tables/` is a layer
 * folder (a pre-v6 YAML project), else core's answer from the library's
 * files (DBML evidence: any DBML table or relationships file of the
 * layer-first tree) and every subject area's storage. A project with no
 * library and no diagrams is `dbml`.
 */
export function projectStorageIn(semanticRoot: string, library: StorageLibraryView, tablesIsLayer: boolean): ProjectStorage {
  if (tablesIsLayer) return 'yaml';
  const files = library.listTableFiles();
  // DBML evidence: any DBML table or relationships file the library lists.
  const hasDbmlTables = files.some((f) => f.storage === 'dbml') || library.listRelationshipsFiles().length > 0;
  return detectProjectStorage({
    hasYamlTables: files.some((f) => f.storage === 'yaml'),
    // An empty `logical-models/` beside a library says nothing (a migration leftover).
    hasV5Folder: library.hasV5Folder() && !library.hasTablesLibrary() && !hasDbmlTables,
    hasDbmlTables,
    subjectAreaStorages: subjectAreaStoragesIn(semanticRoot, tablesIsLayer),
  });
}

/** The table library's memoised {@link projectStorageIn} (`TableLibraryService.projectStorage`). */
export function projectStorageOf(tableLibraryService: { projectStorage(): ProjectStorage }): ProjectStorage {
  return tableLibraryService.projectStorage();
}
