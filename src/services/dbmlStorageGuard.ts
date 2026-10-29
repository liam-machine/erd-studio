/**
 * Stable guard for projects stored as DBML by a newer ERD Studio.
 *
 * ERD Studio 2.0 (first shipped as the 1.9 pre-release) can keep a project's
 * tables, relationships and diagrams as `.dbml` files: tables at
 * `tables/[<folder>/]<name>.dbml`, relationships in
 * `tables/[<folder>/]_relationships.dbml`, diagrams at `<layer>/<name>.dbml`
 * with a `<name>.dbdiagram` layout beside them. This version reads none of
 * that. Opened on such a project it would show an empty Table Library and no
 * diagrams, and its create paths could write YAML and JSON files beside the
 * DBML ones (a `tables/x.yml` next to `tables/x.dbml`, a `silver/x.json` next
 * to `silver/x.dbml`), which the newer version would then report as
 * conflicts. So when this detector finds DBML storage, the extension says so
 * and refuses every action that writes into the ERD Studio folder.
 *
 * This file is the detector and the shared wording only. It imports no
 * `vscode` (the `erd-studio` CLI's `doctor` uses it too); the editor side is
 * `src/providers/dbmlStorageGuardUi.ts`.
 *
 * ERD Studio 2.0 reads DBML, so when this branch meets the 2.0 code the guard
 * must go: delete both files and their call sites (search for
 * `dbmlStorageGuard`). Until someone does, it switches itself off: core's
 * {@link CURRENT_SCHEMA_VERSION} is 7 from the core that reads DBML on, and
 * {@link detectDbmlStorage} then finds nothing (`dbmlStorageGuard.test.ts`
 * fails there, to say the guard should be deleted).
 */

import * as fs from 'fs';
import * as path from 'path';

import { CURRENT_SCHEMA_VERSION, LOGICAL_MODELS_DIR, NON_SUBJECT_AREA_DIRS, TABLES_DIR } from '@erd-studio/core';
import { tablesDirIsLayer } from './logicalModelService';

/** What the user is told, everywhere: views, refusals, the notification and `doctor`. */
export const DBML_STORAGE_MESSAGE =
  'This project is stored as DBML by a newer ERD Studio (the 1.9 pre-release or 2.0). Update ERD Studio to open it.';

/**
 * The first core schema version that reads DBML storage (2.0's). Running on
 * that core, this guard is stale code from a merge and stands down.
 */
export const DBML_READING_SCHEMA_VERSION = 7;

/** The Marketplace / Open VSX id the update button opens. */
export const ERD_STUDIO_EXTENSION_ID = 'liamwynne.erd-studio';

/** The file name of a library folder's relationships file in DBML storage. */
const RELATIONSHIPS_FILE_STEM = '_relationships';

/**
 * The first line of the single-file DBML export (`toDbml`), in every version.
 * An export saved into the ERD Studio folder is not DBML storage.
 */
const EXPORT_HEADER_PREFIX = '// erd-studio dbml-export';

/** How much of a `.dbml` file is read to tell storage from an export. */
const HEAD_BYTES = 64 * 1024;

/** The key a newer ERD Studio writes on a DBML diagram's `Project`. */
const DIAGRAM_VERSION_KEY = /^\s*erd_schema_version\s*:/m;

export type DbmlStorageEvidenceKind = 'table' | 'relationships' | 'diagram';

/** The first file that shows the project is stored as DBML. */
export interface DbmlStorageEvidence {
  kind: DbmlStorageEvidenceKind;
  /** Relative to the ERD Studio folder, with forward slashes. */
  file: string;
}

/** Up to {@link HEAD_BYTES} of a file, without a BOM; `null` when it cannot be read. */
function readHead(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.toString('utf-8', 0, read).replace(/^﻿/, '');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function isExport(head: string): boolean {
  return head.trimStart().startsWith(EXPORT_HEADER_PREFIX);
}

function dirEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function stemOf(fileName: string): string {
  return fileName.slice(0, -'.dbml'.length);
}

function isDbmlFile(entry: fs.Dirent): boolean {
  return entry.isFile() && !entry.name.startsWith('.') && entry.name.toLowerCase().endsWith('.dbml') && entry.name.length > '.dbml'.length;
}

/**
 * A DBML table or relationships file directly in `dir` (a library folder),
 * or null. A relationships file counts on its name alone; a table file
 * counts unless it is a saved export.
 */
function libraryEvidenceIn(dir: string, relDir: string): DbmlStorageEvidence | null {
  for (const entry of dirEntries(dir)) {
    if (!isDbmlFile(entry)) { continue; }
    const file = `${relDir}/${entry.name}`;
    if (stemOf(entry.name).toLowerCase() === RELATIONSHIPS_FILE_STEM) {
      return { kind: 'relationships', file };
    }
    const head = readHead(path.join(dir, entry.name));
    if (head !== null && !isExport(head)) {
      return { kind: 'table', file };
    }
  }
  return null;
}

/**
 * A DBML diagram directly in a layer folder, or null: a `.dbml` file that
 * declares `erd_schema_version` (which only a newer ERD Studio's diagrams
 * carry) and is not a saved export.
 */
function diagramEvidenceIn(dir: string, relDir: string): DbmlStorageEvidence | null {
  for (const entry of dirEntries(dir)) {
    if (!isDbmlFile(entry) || stemOf(entry.name).toLowerCase() === RELATIONSHIPS_FILE_STEM) { continue; }
    const head = readHead(path.join(dir, entry.name));
    if (head !== null && !isExport(head) && DIAGRAM_VERSION_KEY.test(head)) {
      return { kind: 'diagram', file: `${relDir}/${entry.name}` };
    }
  }
  return null;
}

/**
 * Whether the ERD Studio folder at `semanticRoot` holds DBML storage written
 * by a newer ERD Studio, and the first file that shows it.
 *
 * - a `.dbml` file in the table library `tables/` (top level or one folder
 *   down), unless `tables/` is a layer folder or the file is a saved export;
 * - a `_relationships.dbml` there;
 * - a `.dbml` diagram in a layer folder that declares `erd_schema_version`.
 *
 * Reads folder listings and at most the first 64 KB of a few `.dbml` files,
 * fresh on every call, so it stays right after a git checkout or an
 * assistant's edit without relying on file-watcher events. Writes nothing.
 * A missing or unreadable folder is not DBML storage, and nothing is when
 * core itself reads DBML ({@link DBML_READING_SCHEMA_VERSION}).
 */
export function detectDbmlStorage(semanticRoot: string): DbmlStorageEvidence | null {
  // This core reads DBML itself: never lock a project it can open.
  if (CURRENT_SCHEMA_VERSION >= DBML_READING_SCHEMA_VERSION) { return null; }
  const top = dirEntries(semanticRoot);
  if (top.length === 0) { return null; }

  const hasTablesDir = top.some((d) => d.isDirectory() && d.name === TABLES_DIR);
  const tablesIsLayer = hasTablesDir && tablesDirIsLayer(semanticRoot);
  if (hasTablesDir && !tablesIsLayer) {
    const tablesDir = path.join(semanticRoot, TABLES_DIR);
    const atTop = libraryEvidenceIn(tablesDir, TABLES_DIR);
    if (atTop) { return atTop; }
    for (const folder of dirEntries(tablesDir)) {
      if (!folder.isDirectory() || folder.name.startsWith('.')) { continue; }
      const inFolder = libraryEvidenceIn(path.join(tablesDir, folder.name), `${TABLES_DIR}/${folder.name}`);
      if (inFolder) { return inFolder; }
    }
  }

  for (const dir of top) {
    if (!dir.isDirectory() || dir.name.startsWith('.') || NON_SUBJECT_AREA_DIRS.has(dir.name) || dir.name === LOGICAL_MODELS_DIR) { continue; }
    if (dir.name === TABLES_DIR && !tablesIsLayer) { continue; }
    const diagram = diagramEvidenceIn(path.join(semanticRoot, dir.name), dir.name);
    if (diagram) { return diagram; }
  }
  return null;
}
