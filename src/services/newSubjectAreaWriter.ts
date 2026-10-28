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
 * In a project that writes DBML (§3.2) the subject area is a `.dbml` diagram
 * (`domainPath` ends in `.dbml`): its table files, relationships files,
 * diagram, layout and the settle re-render of other DBML diagrams are planned
 * up front and written by `writeFilesWithRollback`, which restores a snapshot
 * of every file it wrote on failure (§5.7) — never a `deleteTable`, which for
 * DBML is the D16 cascade and would edit other owners' files.
 *
 * Neither a direct `fs` write in a provider handler nor a canvas edit: these
 * are new files a command creates, which is why they are not an
 * `applySubjectAreaEdit` (the same as `createDomain`). What a failure means to
 * the user — and its message — stays with each command; this returns what
 * happened. No `vscode` import.
 */

import * as fs from 'fs';
import * as path from 'path';

import { editDiagramLayout, layoutFilePathOf, stickyLayoutsOf, subjectAreaStorageOf } from '@erd-studio/core';
import type { Annotation, NodePosition } from '@erd-studio/core';
import { DBML_CONVERT_FIRST_MESSAGE, DbmlEditRefused, renderNewSubjectAreaDbml } from '@erd-studio/core/dbml';

import { ownWrites } from './ownWriteTracker';
import { classifyWriteFailure, failedPath, projectRelative } from './commandErrors';
import {
  DuplicateKeyWriteRefused,
  RelationshipsRewriteRefused,
  TableNamingWriteRefused,
  type TableLibraryService,
} from './logicalModelService';
import type { LayerService } from './layerService';
import type { SubjectAreaService } from './domainService';
import type { FileWrite } from './fileWrites';
import { FileWriteExists, FileWriteRollbackFailed, writeFilesWithRollback, type FileWriteIo } from './fsFileWrites';
import { settleDbmlDiagramWrites } from './dbmlDiagramSettle';
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
   * The subject area: a JSON file's text, or (for a `.dbml` `domainPath`)
   * the v5 object a DBML diagram is rendered from (`domain`, `description`,
   * `modelFolder`, `logical.models`, `viewConfig.positions` and
   * `.annotations`; its relationships must already be routed to the
   * library, D5). `tableNaming` is whether the project writes the v6 naming
   * (#182), asked before the first table file lands. Called inside the
   * write, so a throw is rolled back like any failure.
   */
  documentText(tableNaming: boolean): string;
  /** The DBML diagram's v5 object (`domainPath` ends in `.dbml`). */
  document?(): Record<string, unknown>;
}

export interface NewSubjectAreaWriteServices {
  layerService: Pick<LayerService, 'getAllLayers' | 'saveConfig'>;
  tableLibraryService: Pick<TableLibraryService, 'saveTable' | 'deleteTable' | 'tablePath' | 'writesTableNaming'>
    /** Every file a save writes (a DBML table's relationships files too), to snapshot before it; the DBML plan. */
    & Partial<Pick<TableLibraryService, 'planTableWrites' | 'invalidateCache'>>;
  /** The other diagrams, for the DBML settle pass (§5.7). */
  subjectAreaService?: Pick<SubjectAreaService, 'listSubjectAreas'>;
  /** The file operations of the DBML write (a test makes one fail). */
  io?: FileWriteIo;
  /**
   * A file's text for the DBML settle pass: an open document's (unsaved edits
   * included), else the disk's without a byte-order mark; null when there is
   * none. Default: the disk's.
   */
  readText?(filePath: string): string | null;
  /**
   * Those of `filePaths` open with unsaved edits (`dirtyFiles`). Every file
   * the DBML write plans, the settled diagrams included, is checked before the
   * first write; a dirty one refuses with {@link UnsavedFilesRefused}.
   */
  dirtyFiles?(filePaths: readonly string[]): string[];
}

/** A file the DBML write would change is open with unsaved edits; nothing was written. */
export class UnsavedFilesRefused extends Error {
  constructor(readonly filePaths: readonly string[]) {
    super(`${filePaths.length} file(s) have unsaved changes.`);
    this.name = 'UnsavedFilesRefused';
  }
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
  if (subjectAreaStorageOf(write.domainPath) === 'dbml') return writeNewDbmlSubjectArea(write, services);
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

/**
 * {@link writeNewSubjectArea} for a `.dbml` diagram (§5.7): every table file,
 * relationships file, the diagram, its layout (only when something is
 * placed) and the settle re-render of other DBML diagrams, planned before
 * the first write and written all or nothing by `writeFilesWithRollback`
 * (new files with `wx`).
 */
async function writeNewDbmlSubjectArea(
  write: NewSubjectAreaWrite,
  services: NewSubjectAreaWriteServices,
): Promise<NewSubjectAreaWriteResult> {
  const { layerService, tableLibraryService } = services;
  const { domainPath } = write;
  const semanticRoot = path.join(write.workspaceRoot, write.semanticDir);
  const createdRoot = !fs.existsSync(semanticRoot);
  const changedNames = write.changedTables.filter((t) => !write.newTables.includes(t)).map((t) => t.name);
  let writes: FileWrite[];
  try {
    if (createdRoot) await layerService.saveConfig(layerService.getAllLayers());
    if (!tableLibraryService.planTableWrites) throw new Error('A DBML diagram needs the library planner.');
    const saves = [
      ...write.newTables.map((model) => ({ model })),
      ...write.changedTables.filter((t) => !write.newTables.includes(t)).map((model) => ({ model })),
    ];
    const lib = tableLibraryService.planTableWrites({ save: saves }, write.folder, { dbml: true });
    const plan = lib.plan!;
    const rel = path.relative(semanticRoot, domainPath).split(path.sep).join('/');
    const doc = write.document?.() ?? {};
    const logical = (doc.logical ?? {}) as { models?: unknown };
    const names = Array.isArray(logical.models) ? (logical.models as unknown[]).filter((m): m is string => typeof m === 'string') : [];
    // A DBML diagram's members are DBML tables (D20): a `use` line cannot point at a `.yml`.
    const members = names.map((name) => {
      const table = plan.resolveTable(name);
      if (!table || table.storage !== 'dbml') {
        throw new DbmlEditRefused(rel, `"${name}" is a YAML table, and a DBML diagram can only hold DBML tables. ${DBML_CONVERT_FIRST_MESSAGE}.`);
      }
      return { name: table.name, reference: table.reference, path: table.path };
    });
    const view = (doc.viewConfig ?? {}) as { positions?: Record<string, NodePosition>; annotations?: Annotation[] };
    const annotations = Array.isArray(view.annotations) ? view.annotations : [];
    const text = renderNewSubjectAreaDbml({
      filePath: rel,
      domain: typeof doc.domain === 'string' ? doc.domain : path.basename(domainPath, '.dbml'),
      ...(typeof doc.description === 'string' ? { description: doc.description } : {}),
      ...(typeof doc.modelFolder === 'string' ? { modelFolder: doc.modelFolder } : {}),
      members,
      relationshipsFiles: plan.relationshipsFilesFor(members.map((m) => m.name)),
      annotations,
    });
    const layout = editDiagramLayout(null, view.positions ?? {}, stickyLayoutsOf(annotations));
    const readText = services.readText ?? ((filePath: string): string | null => {
      try {
        return fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
      } catch {
        return null;
      }
    });
    const others = (services.subjectAreaService?.listSubjectAreas(write.workspaceRoot, write.semanticDir) ?? [])
      .filter((s) => s.storage === 'dbml' && path.resolve(s.filePath) !== path.resolve(domainPath))
      .map((s) => s.filePath);
    writes = [
      ...lib.writes,
      { kind: 'create', path: domainPath, text },
      ...(layout !== null ? [{ kind: 'create' as const, path: layoutFilePathOf(domainPath), text: layout }] : []),
      ...settleDbmlDiagramWrites({ semanticRoot, diagrams: others, plan, readText }),
    ];
    // Nothing is written under the user's unsaved edits: not a library file,
    // and not another diagram the settle pass re-renders.
    const dirty = services.dirtyFiles?.(writes.map((w) => w.path)) ?? [];
    if (dirty.length > 0) throw new UnsavedFilesRefused(dirty);
  } catch (error) {
    let undone = true;
    if (createdRoot) {
      try { fs.rmSync(semanticRoot, { recursive: true, force: true }); } catch { undone = false; }
    }
    return { ok: false, error, undone, nameTaken: false };
  }
  try {
    writeFilesWithRollback(writes, {
      ...(services.io ? { io: services.io } : {}),
      onWritten: (filePath, kind) => {
        if (kind === 'delete') ownWrites.recordDelete(filePath);
        else ownWrites.recordWrite(filePath);
      },
    });
  } catch (error) {
    const undone = !(error instanceof FileWriteRollbackFailed);
    if (undone && createdRoot) {
      try { fs.rmSync(semanticRoot, { recursive: true, force: true }); } catch { /* leave it */ }
    }
    // The diagram's own exclusive create: the name was taken since it was checked.
    const nameTaken = error instanceof FileWriteExists && path.resolve(error.filePath) === path.resolve(domainPath);
    return { ok: false, error, undone, nameTaken };
  } finally {
    tableLibraryService.invalidateCache?.();
  }
  return { ok: true, written: write.newTables.map((t) => t.name), changed: changedNames };
}

/** A write refused because of what is in the user's file, which names file and line. */
export type RefusedWrite = DuplicateKeyWriteRefused | RelationshipsRewriteRefused | TableNamingWriteRefused | DbmlEditRefused;

export function isRefusedWrite(err: unknown): err is RefusedWrite {
  return err instanceof DuplicateKeyWriteRefused || err instanceof RelationshipsRewriteRefused
    || err instanceof TableNamingWriteRefused || err instanceof DbmlEditRefused;
}

/** Where a refusal points: the file and line to open, when it names them. */
export function refusalLocation(err: RefusedWrite, semanticRoot: string): { filePath: string; line?: number } | undefined {
  if (err instanceof DbmlEditRefused) {
    if (!err.file) return undefined;
    const filePath = path.isAbsolute(err.file) ? err.file : path.join(semanticRoot, ...err.file.split('/'));
    return { filePath, ...(err.line !== undefined ? { line: err.line } : {}) };
  }
  return err.location;
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
