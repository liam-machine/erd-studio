/**
 * Writing a NEW subject area and the table files it needs, all or nothing —
 * the one write path **Draw from dbt…** (`src/commands/drawFromDbt.ts`) and
 * **Import DBML…** (`src/commands/importDbml.ts`) share.
 *
 * In order: the default `layers.json` when the project has no ERD folder yet
 * (as Set Up Semantic Domains Directory writes it), the layer folder, each new
 * table file (`saveTable`, in the folder the caller chose), the subject area
 * file (created with the `wx` flag, so a name taken since it was checked is
 * never overwritten), and last the existing library tables that gained a
 * relationship. Every write is recorded as an own write after its bytes land.
 * Any failure puts everything back: new table files deleted, the subject area
 * file removed, changed library files restored to the text they held, and a
 * folder the write created removed again.
 *
 * Neither a direct `fs` write in a provider handler nor a canvas edit: these
 * are new files a command creates, which is why they are not an
 * `applySubjectAreaEdit` (the same as `createDomain`). What a failure means to
 * the user — and its message — stays with each command; this returns what
 * happened. No `vscode` import.
 */

import * as fs from 'fs';
import * as path from 'path';

import { ownWrites } from './ownWriteTracker';
import { classifyWriteFailure, failedPath, projectRelative } from './commandErrors';
import {
  DuplicateKeyWriteRefused,
  RelationshipsRewriteRefused,
  TableNamingWriteRefused,
  type TableLibraryService,
} from './logicalModelService';
import type { LayerService } from './layerService';
import type { SemanticTable } from '../types/semantic';

export interface NewSubjectAreaWrite {
  workspaceRoot: string;
  semanticDir: string;
  /** The new subject area file: `<workspaceRoot>/<semanticDir>/<layer>/<name>.json`. */
  domainPath: string;
  /** Table files to create, each with `saveTable(table, folder)`. */
  newTables: readonly SemanticTable[];
  /** The library folder new tables go in (a layer folder), or undefined for the top level. */
  folder?: string;
  /**
   * Existing library tables that gained relationships, saved after the
   * subject area file is on disk. One that is also in `newTables` is skipped
   * (it was saved with them).
   */
  changedTables: readonly SemanticTable[];
  /**
   * The subject area file's text. `tableNaming` is whether the project
   * writes the v6 naming (#182), asked before the first table file lands.
   * Called inside the write, so a throw is rolled back like any failure.
   */
  documentText(tableNaming: boolean): string;
}

export interface NewSubjectAreaWriteServices {
  layerService: Pick<LayerService, 'getAllLayers' | 'saveConfig'>;
  tableLibraryService: Pick<TableLibraryService, 'saveTable' | 'deleteTable' | 'tablePath' | 'writesTableNaming'>
    /** Every file a save writes (a DBML table's relationships files too), to snapshot before it. */
    & Partial<Pick<TableLibraryService, 'planTableWrites'>>;
}

export type NewSubjectAreaWriteResult =
  | {
    ok: true;
    /** The new tables' names, as saved. */
    written: string[];
    /**
     * The existing library tables saved with a new relationship, by name.
     * Their writes were own writes too, so the caller refreshes what shows them.
     */
    changed: string[];
  }
  | {
    ok: false;
    error: unknown;
    /** Every file was put back (true), or some may already have changed. */
    undone: boolean;
    /** The subject area file's own exclusive create failed: its name was taken after it was checked. */
    nameTaken: boolean;
  };

/** Write everything, or nothing. Never throws for a failed write; see the result. */
export async function writeNewSubjectArea(
  write: NewSubjectAreaWrite,
  services: NewSubjectAreaWriteServices,
): Promise<NewSubjectAreaWriteResult> {
  const { layerService, tableLibraryService } = services;
  const { domainPath } = write;
  const layerDir = path.dirname(domainPath);
  const written: string[] = [];
  const changed: string[] = [];
  let domainWritten = false;
  // What each library file held before the write changed it (null: it was
  // not there), to put back on failure.
  const before = new Map<string, string | null>();
  // Asked before any table file lands: the subject area is written in the naming the project writes (#182).
  const tableNaming = tableLibraryService.writesTableNaming();
  // Folders the write creates, removed again if it fails (a new project's layers.json with them).
  const semanticRoot = path.join(write.workspaceRoot, write.semanticDir);
  const createdRoot = !fs.existsSync(semanticRoot);
  const createdLayerDir = !fs.existsSync(layerDir);
  try {
    if (createdRoot) {
      await layerService.saveConfig(layerService.getAllLayers());
    }
    fs.mkdirSync(layerDir, { recursive: true });

    for (const table of write.newTables) {
      tableLibraryService.saveTable(table, write.folder);
      written.push(table.name);
    }

    fs.writeFileSync(domainPath, write.documentText(tableNaming), { encoding: 'utf-8', flag: 'wx' });
    domainWritten = true;
    ownWrites.recordWrite(domainPath);
    // Existing library tables that gained a relationship, once the subject area is on disk.
    for (const table of write.changedTables) {
      if (write.newTables.includes(table)) continue;
      // A DBML table's save also writes its folder's relationships file (and
      // moves misplaced Refs home): snapshot every file the save plans.
      const paths = tableLibraryService.planTableWrites
        ? tableLibraryService.planTableWrites({ save: [{ model: table }] }).writes.map((w) => w.path)
        : [tableLibraryService.tablePath(table.name)];
      for (const filePath of paths) {
        if (before.has(filePath)) continue;
        before.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null);
      }
      tableLibraryService.saveTable(table);
      changed.push(table.name);
    }
  } catch (error) {
    // Leave nothing behind: no orphan table files, no subject area naming
    // tables that were just removed, no library file half way through.
    let undone = true;
    for (const name of written) {
      try { tableLibraryService.deleteTable(name); } catch { undone = false; }
    }
    if (domainWritten) {
      try { fs.unlinkSync(domainPath); ownWrites.recordDelete(domainPath); } catch { undone = false; }
    }
    for (const [filePath, text] of before) {
      try {
        if (text !== null) {
          fs.writeFileSync(filePath, text, 'utf-8');
          ownWrites.recordWrite(filePath);
        } else if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          ownWrites.recordDelete(filePath);
        }
      } catch { undone = false; }
    }
    if (undone && createdRoot) {
      try { fs.rmSync(semanticRoot, { recursive: true, force: true }); } catch { undone = false; }
    } else if (undone && createdLayerDir) {
      try { fs.rmdirSync(layerDir); } catch { /* not empty, or never made: leave it */ }
    }
    // EEXIST from the subject area's own exclusive write: the name was taken since it was checked.
    const nameTaken = !domainWritten && !!error && typeof error === 'object' && 'code' in error
      && error.code === 'EEXIST' && failedPath(error) === domainPath;
    return { ok: false, error, undone, nameTaken };
  }
  return { ok: true, written, changed };
}

/** A write refused because of what is in the user's file, which names file and line. */
export type RefusedWrite = DuplicateKeyWriteRefused | RelationshipsRewriteRefused | TableNamingWriteRefused;

export function isRefusedWrite(err: unknown): err is RefusedWrite {
  return err instanceof DuplicateKeyWriteRefused || err instanceof RelationshipsRewriteRefused
    || err instanceof TableNamingWriteRefused;
}

/** The sentence that ends every failed write's message. */
export function writeOutcome(undone: boolean, semanticDir: string): string {
  return undone ? 'Nothing was changed.' : `Some files in ${semanticDir}/ may already have changed.`;
}

/**
 * Why a write failed, in words the user can act on, when the environment
 * refused it (a folder they may not write, a full disk); undefined when the
 * failure is ERD Studio's (`classifyWriteFailure` → `'other'`). The folder is
 * named project-relative, never as an absolute path.
 */
export function environmentWriteProblem(err: unknown, workspaceRoot: string, fallbackFolder: string): string | undefined {
  const failure = classifyWriteFailure(err);
  if (failure === 'other') return undefined;
  const failedAt = failedPath(err);
  const folder = failedAt ? projectRelative(workspaceRoot, path.dirname(failedAt)) : fallbackFolder;
  return failure === 'permission'
    ? `ERD Studio isn't allowed to write to ${folder}/. Check the folder's permissions, then try again.`
    : 'the disk is full. Free up some space, then try again.';
}
