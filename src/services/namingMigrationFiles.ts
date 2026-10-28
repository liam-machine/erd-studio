/**
 * What the naming migration (#182) reads, from disk: every subject area file
 * and every library table file, by path relative to the semantic dir. Shared
 * by the extension's command and `erd-studio doctor`'s preview. No `vscode`:
 * the CLI bundles it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { TABLES_DIR } from '@erd-studio/core';

import type { SubjectAreaService } from './domainService';
import type { TableLibraryService } from './logicalModelService';
import { tablesDirIsLayer } from './logicalModelService';
import type { NamingMigrationFile, NamingMigrationInput } from './namingMigration';

/** `filePath` relative to `semanticRoot`, `/`-separated. */
export function semanticRelative(semanticRoot: string, filePath: string): string {
  return path.relative(semanticRoot, filePath).split(path.sep).join('/');
}

/** The planner's input for the project at `workspaceRoot`; an unreadable file is left out. */
export function readNamingMigrationInput(
  workspaceRoot: string,
  semanticDir: string,
  subjectAreaService: Pick<SubjectAreaService, 'listSubjectAreas'>,
  tableLibraryService: Pick<TableLibraryService, 'listTableFiles'>,
): NamingMigrationInput {
  const semanticRoot = path.join(workspaceRoot, semanticDir);
  const read = (filePath: string): NamingMigrationFile | null => {
    try {
      return { path: semanticRelative(semanticRoot, filePath), text: fs.readFileSync(filePath, 'utf-8') };
    } catch {
      return null;
    }
  };
  // Only `.json` diagrams and `.yml` tables: DBML texts are never fed to
  // `planNamingMigration` (native DBML storage, §5.7).
  const subjectAreas = subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir)
    .filter((s) => s.filePath.endsWith('.json'))
    .map((s) => read(s.filePath)).filter((f): f is NamingMigrationFile => f !== null);
  const tables = tableLibraryService.listTableFiles()
    .filter((e) => e.filePath.endsWith('.yml'))
    .map((e) => read(e.filePath)).filter((f): f is NamingMigrationFile => f !== null);
  return {
    subjectAreas,
    tables,
    tablesFolderIsLayer: fs.existsSync(path.join(semanticRoot, TABLES_DIR)) && tablesDirIsLayer(semanticRoot),
  };
}
