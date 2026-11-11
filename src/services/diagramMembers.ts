/**
 * Each diagram's member table names (`subjectAreaTableNames`), read through
 * a cache checked against the file's mtime + size: a refresh after one
 * diagram changed reads that diagram only, not every diagram of the project.
 * Shared by the Table Library's "on 2 diagrams" and the Explorer's tooltips.
 *
 * {@link DiagramMembers.idsOf} gives each member's identity too: the table
 * file a DBML diagram's `use` line reads (its schema folder and name), so
 * two tables of one name in different schema folders are counted apart.
 *
 * No `vscode`. Never writes.
 */

import * as fs from 'fs';

import { subjectAreaStorageOf, tableIdOfPath } from '@erd-studio/core';
import type { TableFileId } from '@erd-studio/core';
import { diagramSummaryDbml } from '@erd-studio/core/dbml';

import { subjectAreaTableNames } from './domainService';

/** A diagram member with its identity: `id` is the table file its `use` line reads; absent for a member named by name alone. */
export interface DiagramMemberId {
  /** The member as the diagram names it: its name, or `<schema>.<name>` where another member has its name. */
  readonly ref: string;
  readonly id?: TableFileId;
}

export class DiagramMembers {
  private readonly cache = new Map<string, { signature: string; names: string[] | null }>();
  private readonly idCache = new Map<string, { signature: string; ids: DiagramMemberId[] | null }>();

  /** A diagram's member names; read afresh (uncached) when the file cannot be stat'ed. Throws when it cannot be read. */
  of(filePath: string): string[] | null {
    const signature = signatureOf(filePath);
    const cached = signature === null ? undefined : this.cache.get(filePath);
    if (cached && cached.signature === signature) return cached.names;
    const names = subjectAreaTableNames(fs.readFileSync(filePath, 'utf-8'), filePath);
    if (signature !== null) this.cache.set(filePath, { signature, names });
    return names;
  }

  /**
   * A diagram's members with their identities, in member order: a DBML
   * diagram's `use` members each with the schema folder, name and layer of
   * the file its line reads (none for a path outside the layer-first tree),
   * then its `erd_unlinked_tables` members, and a JSON diagram's members, by
   * name alone. Null when the file does not parse; cached like {@link of}.
   * Throws when it cannot be read.
   */
  idsOf(filePath: string): DiagramMemberId[] | null {
    const signature = signatureOf(filePath);
    const cached = signature === null ? undefined : this.idCache.get(filePath);
    if (cached && cached.signature === signature) return cached.ids;
    const text = fs.readFileSync(filePath, 'utf-8');
    let ids: DiagramMemberId[] | null;
    if (subjectAreaStorageOf(filePath) === 'dbml') {
      const summary = diagramSummaryDbml(text, filePath);
      ids = summary === null ? null : [
        ...summary.members.map((ref, i) => {
          const id = tableIdOfPath(summary.memberUses[i]?.resolved ?? '');
          return id ? { ref, id } : { ref };
        }),
        ...summary.unlinked.map((ref) => ({ ref })),
      ];
    } else {
      ids = subjectAreaTableNames(text, filePath)?.map((ref) => ({ ref })) ?? null;
    }
    if (signature !== null) this.idCache.set(filePath, { signature, ids });
    return ids;
  }

  /** Forget every diagram not in `listed` (one that was deleted or moved). */
  keepOnly(listed: ReadonlySet<string>): void {
    for (const cache of [this.cache, this.idCache]) {
      for (const filePath of cache.keys()) {
        if (!listed.has(filePath)) cache.delete(filePath);
      }
    }
  }

  clear(): void {
    this.cache.clear();
    this.idCache.clear();
  }
}

/** A file's `mtime:size`, or null when it cannot be stat'ed (a virtual path in tests: read without caching). */
function signatureOf(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}
