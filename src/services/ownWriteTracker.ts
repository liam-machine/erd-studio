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
 *   ownWrites.recordWrite(filePath);      // right after fs.writeFileSync
 *   ownWrites.recordDelete(filePath);     // right after unlink / fs.delete
 *   if (ownWrites.consume(uri.fsPath)) { return; }   // in the watcher callback
 *
 * A recorded write is matched against the file's current mtime + size, so an
 * external edit that lands after our write (different mtime) is still
 * reported. Entries expire after a short TTL to keep the map bounded.
 */

import * as fs from 'fs';
import * as path from 'path';

/** How long a recorded own write stays eligible for suppression. */
const OWN_WRITE_TTL_MS = 5_000;

interface OwnWriteEntry {
  /** mtime + size after the write, or null when the entry records a deletion. */
  readonly signature: string | null;
  readonly recordedAt: number;
}

function statSignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

export class OwnWriteTracker {
  private readonly entries = new Map<string, OwnWriteEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private key(filePath: string): string {
    return path.normalize(filePath);
  }

  /**
   * Record that the extension has just written `filePath`.
   * Call immediately after the write completes.
   */
  recordWrite(filePath: string): void {
    this.prune();
    this.entries.set(this.key(filePath), {
      signature: statSignature(filePath),
      recordedAt: this.now(),
    });
  }

  /**
   * Record that the extension has just deleted `filePath`.
   */
  recordDelete(filePath: string): void {
    this.prune();
    this.entries.set(this.key(filePath), { signature: null, recordedAt: this.now() });
  }

  /**
   * Returns true when the pending watcher event for `filePath` was caused by
   * a write/delete recorded via recordWrite/recordDelete, i.e. the file on
   * disk still looks exactly like what we wrote. The entry is consumed either
   * way so a later external change is never masked.
   */
  consume(filePath: string): boolean {
    const key = this.key(filePath);
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    this.entries.delete(key);
    if (this.now() - entry.recordedAt > OWN_WRITE_TTL_MS) {
      return false;
    }
    return statSignature(filePath) === entry.signature;
  }

  /** Whether an unexpired record exists for `filePath` (does not consume). */
  has(filePath: string): boolean {
    const entry = this.entries.get(this.key(filePath));
    return !!entry && this.now() - entry.recordedAt <= OWN_WRITE_TTL_MS;
  }

  /** Drop all records (tests, disposal). */
  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const cutoff = this.now() - OWN_WRITE_TTL_MS;
    for (const [key, entry] of this.entries) {
      if (entry.recordedAt < cutoff) {
        this.entries.delete(key);
      }
    }
  }
}

/** Process-wide tracker shared by services that write and watchers that read. */
export const ownWrites = new OwnWriteTracker();
