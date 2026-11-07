/**
 * Which file naming a project writes (#182): core's `detectProjectNaming`,
 * fed with what is on disk. The one host answer, shared by the canvas, the
 * commands, the naming prompt and `erd-studio doctor`, so they never
 * disagree. No `vscode`: the CLI bundles it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { NON_SUBJECT_AREA_DIRS, TABLES_DIR, detectProjectNaming, detectSubjectAreaFormat } from '@erd-studio/core';
import type { ProjectNaming, SubjectAreaFormat } from '@erd-studio/core';

/**
 * The format of every subject area file (`{layer}/*.json`) under
 * `semanticRoot`; an unreadable one says nothing. A `.dbml` diagram has no
 * naming and is ignored: storage is `projectStorageOf`'s answer.
 */
export function subjectAreaFormatsIn(semanticRoot: string, tablesIsLibrary: boolean): SubjectAreaFormat[] {
  const formats: SubjectAreaFormat[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(semanticRoot, { withFileTypes: true });
  } catch {
    return formats;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name.startsWith('.') || NON_SUBJECT_AREA_DIRS.has(dir.name)) continue;
    if (dir.name === TABLES_DIR && tablesIsLibrary) continue;
    let files: string[];
    try {
      files = fs.readdirSync(path.join(semanticRoot, dir.name));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      try {
        // A BOM is no reason to ignore a file: the migration planner reads it too.
        formats.push(detectSubjectAreaFormat(JSON.parse(fs.readFileSync(path.join(semanticRoot, dir.name, file), 'utf-8').replace(/^\uFEFF/, ''))));
      } catch {
        // Not readable JSON: says nothing about the naming.
      }
    }
  }
  return formats;
}

/** What the table library knows, as {@link projectNamingOf} needs it. */
export interface NamingLibraryView {
  /** `logical-models/` holds a table file. */
  hasV5TableFiles(): boolean;
  /** `logical-models/` exists, empty or not. */
  hasV5Folder(): boolean;
  /** `tables/` is the v6 library. */
  hasTablesLibrary(): boolean;
}

/**
 * The project's naming: `v5`, `v6` (a new project with no library folder
 * too) or `mixed`. An empty `logical-models/` keeps a project v5 — an older
 * version made it, and its files go there — unless `tables/` is the
 * library, when it is a leftover of the migration and says nothing.
 */
export function projectNamingOf(semanticRoot: string, library: NamingLibraryView): ProjectNaming {
  const hasTablesLibrary = library.hasTablesLibrary();
  return detectProjectNaming({
    hasLogicalModelsDir: library.hasV5TableFiles() || (!hasTablesLibrary && library.hasV5Folder()),
    hasTablesLibrary,
    subjectAreaFormats: subjectAreaFormatsIn(semanticRoot, hasTablesLibrary),
  });
}
