/**
 * The file renames ERD Studio's own WorkspaceEdits make, so the
 * Explorer-move listener (`onDidRenameFiles`, `src/commands/explorerMoves.ts`)
 * never takes one for the user's: VS Code fires that event for an
 * extension's `WorkspaceEdit.renameFile` too, not only for a drag or an F2
 * in the Explorer. (Creates and deletes never fire it.)
 *
 * A rename is matched by its exact pair (old path, new path), once: the
 * event that reports it uses the mark up. A mark whose event never came is
 * dropped {@link OWN_FILE_OPERATION_GRACE_MS} after its edit settled. So a
 * user's move of the same file just after (Move It Back, then a drag to the
 * right folder) is never hidden, and neither is an undo of ERD Studio's
 * move, whose pair is the reverse.
 *
 * No `vscode`: tests drive it directly.
 */

import * as path from 'path';

/** How long a settled edit's renames whose event has not come stay marked (a fallback: the event normally comes during the edit). */
export const OWN_FILE_OPERATION_GRACE_MS = 30_000;

/** One edit's renames not yet reported, and when the edit settled (undefined while in flight). */
interface OwnEdit {
  pairs: string[];
  settledAt?: number;
}

const pairKey = (from: string, to: string): string => `${path.resolve(from)}\u0000${path.resolve(to)}`;

export class OwnFileOperations {
  private readonly edits = new Set<OwnEdit>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Announce an edit's renames; call the returned function once it settles (applied or not). */
  begin(renames: Iterable<{ from: string; to: string }>): () => void {
    const own: OwnEdit = { pairs: [...renames].map((r) => pairKey(r.from, r.to)) };
    if (own.pairs.length === 0) return () => {};
    this.edits.add(own);
    return () => {
      if (own.settledAt === undefined) own.settledAt = this.now();
    };
  }

  /**
   * Whether the rename `from` → `to` is one of ERD Studio's own (its edit in
   * flight, or settled in the last {@link OWN_FILE_OPERATION_GRACE_MS}). A
   * match uses the mark up: the same pair reported again is the user's.
   */
  takeOwnRename(from: string, to: string): boolean {
    const key = pairKey(from, to);
    const at = this.now();
    for (const own of [...this.edits]) {
      if (own.settledAt !== undefined && at - own.settledAt > OWN_FILE_OPERATION_GRACE_MS) {
        this.edits.delete(own);
        continue;
      }
      const i = own.pairs.indexOf(key);
      if (i < 0) continue;
      own.pairs.splice(i, 1);
      if (own.pairs.length === 0) this.edits.delete(own);
      return true;
    }
    return false;
  }

  /** Forget everything (tests). */
  clear(): void {
    this.edits.clear();
  }
}

/** Process-wide: `applyFileWrites` and Organise announce, the Explorer-move listener asks. */
export const ownFileOperations = new OwnFileOperations();
