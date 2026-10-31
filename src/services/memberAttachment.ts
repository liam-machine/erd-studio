/**
 * The relationships a set of tables owns, worked out from the Refs that touch
 * them only: what opening one diagram needs, without reading every table
 * file in the library (§5.1, §7.6).
 *
 * `attachRelationships` over the whole library (`TableLibraryService.libraryAttachment`)
 * resolves the two ends of every Ref, so it reads every table a Ref names —
 * on a large library, nearly all of them. A diagram only needs what its own
 * tables own. Which list a table owns depends only on the Refs that name it
 * (by name or by its DBML alias): a link stored twice is the same pair of
 * tables, and a composite is one Ref. So attaching just those Refs, with
 * both ends resolved exactly as the whole-library lookup resolves them,
 * gives each member the same list, in the same order, as the whole-library
 * attach.
 *
 * When an end cannot be resolved by its name to a table that reads (a
 * dangling end, a DBML alias, a broken file), the whole-library lookup may
 * fall back to aliases declared anywhere in the library, so this gives up
 * and returns null: the caller then attaches the whole library, as before.
 *
 * No `vscode`, no file access: the caller resolves names.
 */

import { attachRelationships } from '@erd-studio/core/dbml';
import type { DbmlAttachResult, DbmlAttachTable, DbmlRelationshipsReading } from '@erd-studio/core';

/** Thrown inside {@link memberAttachment} when an end needs the whole library. */
class NeedsWholeLibrary extends Error {}

/**
 * The attachment of the Refs in `readings` that name a table of `memberKeys`
 * (lower-case names) or one of their DBML aliases. `resolve(lowerName)`
 * answers as the whole-library lookup would by name: the first readable,
 * unshadowed table of that name, or undefined when there is none (or its
 * file does not read). Null when the whole library is needed.
 *
 * Only the members' lists in `byOwner` are complete; the reports
 * (`orphaned`, `duplicates`, `warnings`) cover only the Refs
 * read here.
 */
export function memberAttachment(
  readings: ReadonlyArray<{ path: string; reading: DbmlRelationshipsReading }>,
  memberKeys: ReadonlySet<string>,
  resolve: (lowerName: string) => DbmlAttachTable | undefined,
): DbmlAttachResult | null {
  const touching = new Set(memberKeys);
  for (const key of memberKeys) {
    const alias = resolve(key)?.dbmlAlias;
    if (alias) touching.add(alias.toLowerCase());
  }
  const names = (rels: ReadonlyArray<{ fromModel: string; toModel: string }>): boolean =>
    rels.length > 0 && (touching.has(rels[0].fromModel.toLowerCase()) || touching.has(rels[0].toModel.toLowerCase()));
  const filtered = readings.map(({ path, reading }) => ({
    path,
    reading: {
      ...reading,
      refs: reading.refs.filter((ref) => names(ref.relationships)),
      ...(reading.pending ? { pending: reading.pending.filter((ref) => names(ref.relationships)) } : {}),
    },
  }));
  const lookup = (name: string): DbmlAttachTable => {
    const table = resolve(name.toLowerCase());
    if (!table) throw new NeedsWholeLibrary();
    return table;
  };
  try {
    return attachRelationships(filtered, lookup);
  } catch (err) {
    if (err instanceof NeedsWholeLibrary) return null;
    throw err;
  }
}
