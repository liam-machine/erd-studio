/**
 * OwnWriteTracker — records files the extension itself has just written or
 * deleted so file-system watchers can tell an own write apart from an
 * external change (git checkout, another editor, an AI agent).
 *
 * Without this, every save the extension makes bounces back through the
 * watcher ~300 ms later and triggers a second, identical refresh (for
 * example a second `domainLoaded` after a v5 model edit).
 *
 * Usage:
 *   const expected = ownWrites.expectWrite([filePath]); // optional: before a save that is about to land
 *   ownWrites.recordWrite(filePath);      // right after the bytes land (fs write, document save)
 *   ownWrites.recordDelete(filePath);     // right after unlink / fs.delete
 *   ownWrites.settleWrites(expected);     // after the saves, whether or not they landed
 *   if (ownWrites.isPending(path)) { wait and ask again }   // in the watcher callback
 *   if (ownWrites.consume(uri.fsPath)) { return; }          // in the watcher callback
 *
 * A recorded write is matched by CONTENT: the size and a hash of the bytes
 * on disk right after the write. The watcher's event is the extension's own
 * exactly when the file still holds those bytes (or, for a delete, is still
 * gone), however long the extension host was busy before the debounced
 * watcher callback ran — there is no short time limit a long stall could
 * outlive (the old 5 s TTL did, and a 10 s stall turned every save into an
 * "external change" that redrew the canvas again).
 *
 * Bounds, so nothing is suppressed that should not be:
 * - A file that holds different bytes is never matched, at any age: an
 *   external edit is always reported. An event whose file holds exactly the
 *   bytes ERD Studio last wrote changes nothing ERD Studio does not already
 *   know, so suppressing it is safe even if that event was not ours.
 * - A match consumes every older record for the path. The path's newest
 *   record stays matchable, consumed or not, while the file holds its bytes:
 *   a second event of two back-to-back saves may be decided long after the
 *   first consumed it. Only a newer record or a content mismatch retires it.
 *   A consumed record that a newer one superseded matches for
 *   {@link CONSUMED_GRACE_MS} more (a duplicate event of the same save).
 * - A record is dropped after {@link MAX_RECORD_AGE_MS} (it only bounds
 *   memory), and at most {@link MAX_RECORDS_PER_PATH} are kept per path.
 * - An expected write ({@link expectWrite}) is pending until it is recorded
 *   or its operation settles, or for {@link MAX_PENDING_MS} at most, so a save
 *   that never finishes cannot hold a watcher back for ever. Settling clears
 *   only that operation's announcements: another operation writing the same
 *   file at the same time (another canvas) keeps its own.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** A record nothing consumed is dropped after this long (memory bound only: matching is by content). */
export const MAX_RECORD_AGE_MS = 10 * 60_000;
/** A consumed record a newer one superseded still matches a duplicate event of the same save for this long. */
export const CONSUMED_GRACE_MS = 2_000;
/** Records kept per path (oldest dropped first). */
export const MAX_RECORDS_PER_PATH = 8;
/** An expected write that is never recorded or settled stops holding watchers back after this long. */
export const MAX_PENDING_MS = 60_000;

interface OwnWriteEntry {
  /** What the file held after the write; null when the entry records a deletion (or a write that left no file). */
  readonly content: { size: number; hash: string } | null;
  readonly recordedAt: number;
  /** When an event consumed it (once superseded, it then matches only within {@link CONSUMED_GRACE_MS}). */
  consumedAt?: number;
}

function contentOf(filePath: string): { size: number; hash: string } | null {
  try {
    const bytes = fs.readFileSync(filePath);
    return { size: bytes.length, hash: crypto.createHash('sha1').update(bytes).digest('hex') };
  } catch {
    return null;
  }
}

function sizeOf(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

/** What one {@link OwnWriteTracker.expectWrite} announced, for {@link OwnWriteTracker.settleWrites}. */
export interface ExpectedWrites {
  readonly token: number;
  readonly paths: readonly string[];
}

interface PendingWrite {
  readonly at: number;
  readonly token: number;
}

export class OwnWriteTracker {
  private readonly entries = new Map<string, OwnWriteEntry[]>();
  /** Writes announced by {@link expectWrite} that have not landed yet: path → one per announcement. */
  private readonly pending = new Map<string, PendingWrite[]>();
  private nextToken = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  private key(filePath: string): string {
    return path.normalize(filePath);
  }

  /**
   * Announce writes that are about to land (a WorkspaceEdit and its saves):
   * until each is recorded or settled, {@link isPending} tells the watcher to
   * wait rather than decide, so an event handled before the save finished
   * (the host was busy) is never taken for an external change.
   */
  expectWrite(filePaths: Iterable<string>): ExpectedWrites {
    const at = this.now();
    const token = this.nextToken++;
    const paths: string[] = [];
    for (const filePath of filePaths) {
      const key = this.key(filePath);
      paths.push(key);
      const list = this.pending.get(key) ?? [];
      list.push({ at, token });
      this.pending.set(key, list);
    }
    return { token, paths };
  }

  /**
   * Clear what is left of one {@link expectWrite}'s announcements (call once
   * its saves are done, landed or not). Another operation's announcements
   * for the same paths stay pending.
   */
  settleWrites(expected: ExpectedWrites): void {
    for (const key of new Set(expected.paths)) {
      const list = this.pending.get(key);
      if (!list) continue;
      const rest = list.filter((p) => p.token !== expected.token);
      if (rest.length === 0) this.pending.delete(key);
      else this.pending.set(key, rest);
    }
  }

  /** Whether an announced write to `filePath` has not landed yet (and was announced less than {@link MAX_PENDING_MS} ago). */
  isPending(filePath: string): boolean {
    const key = this.key(filePath);
    const list = this.pending.get(key);
    if (!list) return false;
    const cutoff = this.now() - MAX_PENDING_MS;
    const live = list.filter((p) => p.at >= cutoff);
    if (live.length === 0) {
      this.pending.delete(key);
      return false;
    }
    if (live.length !== list.length) this.pending.set(key, live);
    return true;
  }

  /**
   * Record that the extension has just written `filePath`.
   * Call right after the bytes land: the record is what the file holds now.
   */
  recordWrite(filePath: string): void {
    this.push(filePath, contentOf(filePath));
  }

  /**
   * Record that the extension has just deleted `filePath`.
   */
  recordDelete(filePath: string): void {
    this.push(filePath, null);
  }

  /**
   * Returns true when the pending watcher event for `filePath` was caused by
   * a write/delete recorded via recordWrite/recordDelete, i.e. the file on
   * disk holds exactly what was written (or is still gone after a delete).
   * A match consumes that record and every older one for the path; a
   * mismatch forgets the path's records (the file changed outside ERD Studio),
   * so a later external change is never masked.
   */
  consume(filePath: string): boolean {
    const key = this.key(filePath);
    const list = this.live(key);
    if (!list) return false;
    const size = sizeOf(filePath);
    let current: { size: number; hash: string } | null | undefined;
    const holds = (entry: OwnWriteEntry): boolean => {
      if (entry.content === null) return size === null;
      if (size === null || size !== entry.content.size) return false;
      if (current === undefined) current = contentOf(filePath);
      return current !== null && current.hash === entry.content.hash;
    };
    let match = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (holds(list[i])) { match = i; break; }
    }
    if (match < 0) {
      this.entries.delete(key);
      return false;
    }
    const kept = list.slice(match);
    if (kept[0].consumedAt === undefined) kept[0].consumedAt = this.now();
    this.entries.set(key, kept);
    return true;
  }

  /** Whether a record that can still match exists for `filePath` (does not consume). */
  has(filePath: string): boolean {
    return this.live(this.key(filePath)) !== undefined;
  }

  /** Drop all records (tests, disposal). */
  clear(): void {
    this.entries.clear();
    this.pending.clear();
  }

  private push(filePath: string, content: OwnWriteEntry['content']): void {
    this.prune();
    const key = this.key(filePath);
    const list = this.live(key) ?? [];
    list.push({ content, recordedAt: this.now() });
    while (list.length > MAX_RECORDS_PER_PATH) list.shift();
    this.entries.set(key, list);
    // It landed: a watcher waiting on it may decide now.
    const waiting = this.pending.get(key);
    if (waiting) {
      waiting.shift();
      if (waiting.length === 0) this.pending.delete(key);
    }
  }

  /**
   * The path's records that can still match: younger than the age bound, and
   * either unconsumed, the newest, or consumed within the grace.
   */
  private live(key: string): OwnWriteEntry[] | undefined {
    const list = this.entries.get(key);
    if (!list) return undefined;
    const now = this.now();
    const newest = list[list.length - 1];
    const live = list.filter((e) => now - e.recordedAt <= MAX_RECORD_AGE_MS &&
      (e.consumedAt === undefined || e === newest || now - e.consumedAt <= CONSUMED_GRACE_MS));
    if (live.length === 0) {
      this.entries.delete(key);
      return undefined;
    }
    if (live.length !== list.length) this.entries.set(key, live);
    return live;
  }

  private lastPrune = -Infinity;

  /** Drop records that can no longer match, at most once a second (a bulk write records thousands of paths). */
  private prune(): void {
    const now = this.now();
    if (now - this.lastPrune < 1_000) return;
    this.lastPrune = now;
    for (const key of [...this.entries.keys()]) this.live(key);
  }
}

/** Process-wide tracker shared by services that write and watchers that read. */
export const ownWrites = new OwnWriteTracker();
