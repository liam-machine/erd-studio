/**
 * The fs twin of the editor's `applyFileWrites` (native DBML storage, §4.1,
 * §5.1): applies planned {@link FileWrite}s straight to disk for the paths
 * that are not editor edits (`TableLibraryService.saveTable` / `renameTable`
 * / `deleteTable`, New Subject Area writers, …), all or nothing.
 *
 * Every target is snapshotted before the first write. On any failure every
 * snapshot is restored (what was created is deleted, what was deleted is
 * re-created, replaced text is put back) and the folders the call made are
 * removed, so table files, relationships files and `use` lines never end up
 * out of step. A replaced file keeps a byte-order mark it had (§2.1).
 *
 * No `vscode`: the CLI and the MCP server may bundle it.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { FileWrite } from './fileWrites';
import { mergeFileWrites, orderFileWrites } from './fileWrites';

const BOM = '﻿';

/** The file operations used, injectable so a test can make the n-th one fail. */
export interface FileWriteIo {
  readFile(p: string): Buffer;
  writeFile(p: string, data: string | Buffer): void;
  rename(from: string, to: string): void;
  unlink(p: string): void;
  exists(p: string): boolean;
  mkdir(p: string): void;
  rmdir(p: string): void;
}

const NODE_IO: FileWriteIo = {
  readFile: (p) => fs.readFileSync(p),
  writeFile: (p, data) => fs.writeFileSync(p, data),
  rename: (from, to) => fs.renameSync(from, to),
  unlink: (p) => fs.unlinkSync(p),
  exists: (p) => fs.existsSync(p),
  mkdir: (p) => fs.mkdirSync(p),
  rmdir: (p) => fs.rmdirSync(p),
};

/** Options for {@link writeFilesWithRollback}. */
export interface WriteFilesOptions {
  /** Told about each path once its bytes have landed (own-write tracking, cache drops). */
  onWritten?(filePath: string, kind: FileWrite['kind']): void;
  /** A create refuses a file that already exists (`wx`); default true. */
  exclusiveCreate?: boolean;
  /** Folders a create may make, up to and not including this one (default: any missing parent). */
  io?: FileWriteIo;
}

/** Refused before anything was written: a create whose file exists. */
export class FileWriteExists extends Error {
  constructor(readonly filePath: string) {
    super(`${filePath} already exists; nothing was changed.`);
    this.name = 'FileWriteExists';
  }
}

/** Some writes failed and the rest could not all be put back (the message names them). */
export class FileWriteRollbackFailed extends Error {
  constructor(readonly cause: unknown, readonly unrestored: string[]) {
    super(`A write failed (${cause instanceof Error ? cause.message : String(cause)}), and ${unrestored.join(', ')} could not be put back. Restore these from source control.`);
    this.name = 'FileWriteRollbackFailed';
  }
}

/** Write `data` to `p` through a temp file and a rename, so a crash never leaves it half written. */
function writeAtomic(io: FileWriteIo, p: string, data: string | Buffer): void {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  try {
    io.writeFile(tmp, data);
    io.rename(tmp, p);
  } catch (err) {
    try { io.unlink(tmp); } catch { /* the temp file may not exist */ }
    throw err;
  }
}

/**
 * Apply `writes` (absolute paths) to disk, all or nothing. Order: creates,
 * then replaces, then deletes (`orderFileWrites`). Returns the paths written.
 * Throws the original error after a full rollback, or
 * {@link FileWriteRollbackFailed} when the rollback itself could not restore
 * every file.
 */
export function writeFilesWithRollback(writes: readonly FileWrite[], options: WriteFilesOptions = {}): string[] {
  const io = options.io ?? NODE_IO;
  const ordered = orderFileWrites(mergeFileWrites(writes));
  const exclusive = options.exclusiveCreate !== false;

  // Snapshots, before the first write.
  const snapshots = new Map<string, Buffer | null>();
  for (const write of ordered) {
    if (snapshots.has(write.path)) continue;
    snapshots.set(write.path, io.exists(write.path) ? io.readFile(write.path) : null);
  }
  for (const write of ordered) {
    if (write.kind === 'create' && exclusive && snapshots.get(write.path) !== null) throw new FileWriteExists(write.path);
  }

  const madeDirs: string[] = [];
  const touched: string[] = [];
  const done: Array<{ path: string; kind: FileWrite['kind'] }> = [];
  try {
    for (const write of ordered) {
      touched.push(write.path);
      if (write.kind === 'delete') {
        if (io.exists(write.path)) io.unlink(write.path);
      } else {
        const missing: string[] = [];
        for (let dir = path.dirname(write.path); !io.exists(dir); dir = path.dirname(dir)) {
          missing.unshift(dir);
          if (path.dirname(dir) === dir) break;
        }
        for (const dir of missing) {
          io.mkdir(dir);
          madeDirs.push(dir);
        }
        const before = snapshots.get(write.path);
        const hadBom = write.kind === 'replace' && before !== null && before !== undefined
          && before.length >= 3 && before[0] === 0xef && before[1] === 0xbb && before[2] === 0xbf;
        const text = hadBom && !write.text.startsWith(BOM) ? BOM + write.text : write.text;
        writeAtomic(io, write.path, text);
      }
      done.push({ path: write.path, kind: write.kind });
    }
  } catch (err) {
    const unrestored: string[] = [];
    for (const p of [...new Set(touched)].reverse()) {
      const snapshot = snapshots.get(p);
      try {
        if (snapshot === null || snapshot === undefined) {
          if (io.exists(p)) io.unlink(p);
        } else {
          const now = io.exists(p) ? io.readFile(p) : null;
          if (now === null || !now.equals(snapshot)) writeAtomic(io, p, snapshot);
        }
      } catch {
        unrestored.push(p);
      }
    }
    for (const dir of madeDirs.reverse()) {
      try { io.rmdir(dir); } catch { /* not empty, or gone: left as it is */ }
    }
    if (unrestored.length > 0) throw new FileWriteRollbackFailed(err, unrestored);
    throw err;
  }
  for (const { path: p, kind } of done) options.onWritten?.(p, kind);
  return done.map((d) => d.path);
}
