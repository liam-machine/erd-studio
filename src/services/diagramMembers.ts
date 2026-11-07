/**
 * Each diagram's member table names (`subjectAreaTableNames`), read through
 * a cache checked against the file's mtime + size: a refresh after one
 * diagram changed reads that diagram only, not every diagram of the project.
 * Shared by the Table Library's "on 2 diagrams" and the Explorer's tooltips.
 *
 * No `vscode`. Never writes.
 */

import * as fs from 'fs';

import { subjectAreaTableNames } from './domainService';

export class DiagramMembers {
  private readonly cache = new Map<string, { signature: string; names: string[] | null }>();

  /** A diagram's member names; read afresh (uncached) when the file cannot be stat'ed. Throws when it cannot be read. */
  of(filePath: string): string[] | null {
    let signature: string | null = null;
    try {
      const stat = fs.statSync(filePath);
      signature = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // No stat (a virtual path in tests): read without caching.
    }
    const cached = signature === null ? undefined : this.cache.get(filePath);
    if (cached && cached.signature === signature) return cached.names;
    const names = subjectAreaTableNames(fs.readFileSync(filePath, 'utf-8'), filePath);
    if (signature !== null) this.cache.set(filePath, { signature, names });
    return names;
  }

  /** Forget every diagram not in `listed` (one that was deleted or moved). */
  keepOnly(listed: ReadonlySet<string>): void {
    for (const filePath of this.cache.keys()) {
      if (!listed.has(filePath)) this.cache.delete(filePath);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
