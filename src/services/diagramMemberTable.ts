/**
 * A diagram's members as the editor names them (schema-scoped table
 * identity, the diagram boundary): one row per member, in the diagram's
 * order, with its reference on the diagram, its bare name and, for a DBML
 * `use` member, the identity and path of the table file its `use` line
 * reads. Built from the reader's `uses` on every read, kept beside the
 * parsed object, and the one way a canvas message's table name (a
 * `DisplayTable.name`: the bare name, or `<schema>.<name>` where two members
 * share it) is turned into a table.
 *
 * Text is resolved by core's rule for diagram-scoped text
 * (`matchTableRef`): the member's reference, then its `<folder>.<name>` (or
 * the `use` specifier's qualifier), then a bare name only one member has.
 * Nothing is ever split on a dot. A member's reference changes only when a
 * namesake joins or leaves the diagram; {@link DiagramMemberTable.adding},
 * {@link DiagramMemberTable.removing} and {@link DiagramMemberTable.renaming}
 * say which references change (old → new), and {@link renameMemberRefs}
 * carries them through a v5 object.
 *
 * Pure: no `vscode`, no file access.
 */

import { assignTableRefs, matchTableRef, rekeySubjectArea, tableIdKey, tableIdOfPath } from '@erd-studio/core';
import type { DbmlMemberUse, TableFileId, TableId, TableRefCandidate } from '@erd-studio/core';

/** One member of a diagram. */
export interface DiagramMemberRow {
  /** What the diagram calls it: its name, or `<schema>.<name>` where another member has its name. */
  readonly ref: string;
  /** Its bare name (the table file's stem, or the name an unlinked or JSON member is listed by). */
  readonly name: string;
  /** The schema folder, name and layer of the table file its `use` line reads; absent for a member named by name alone. */
  readonly id?: TableFileId;
  /** That `use` line's path, resolved, relative to the semantic dir (posix); absent for a member with no `use` line. */
  readonly path?: string;
  /** The schema the `use` line's table specifier writes (`ccc` in `use { table ccc.addresse }`). */
  readonly qualifier?: string;
}

export class DiagramMemberTable {
  private readonly candidates: TableRefCandidate[];

  constructor(readonly rows: readonly DiagramMemberRow[]) {
    this.candidates = rows.map((row) => ({
      ref: row.ref,
      schema: row.id?.schema ?? '',
      name: row.name,
      ...(row.qualifier !== undefined && row.qualifier !== '' ? { qualifiers: [row.qualifier] } : {}),
    }));
  }

  /**
   * A DBML diagram's members from its reader's `uses` (each `use` member,
   * with the file its line reads) and `unlinked` (its
   * `erd_unlinked_tables`, by name alone). A use from a reader older than
   * table references is named by its name.
   */
  static fromUses(uses: readonly DbmlMemberUse[], unlinked: readonly string[] = []): DiagramMemberTable {
    return new DiagramMemberTable([
      ...uses.map((use): DiagramMemberRow => {
        const id = tableIdOfPath(use.resolved);
        return {
          ref: use.ref ?? use.name,
          name: use.name,
          ...(id ? { id } : {}),
          path: use.resolved,
          ...(use.qualifier !== undefined ? { qualifier: use.qualifier } : {}),
        };
      }),
      ...unlinked.map((name): DiagramMemberRow => ({ ref: name, name })),
    ]);
  }

  /** A diagram that names its members by name alone (a JSON diagram): each name is its reference. */
  static fromNames(names: readonly string[]): DiagramMemberTable {
    return new DiagramMemberTable(names.map((name) => ({ ref: name, name })));
  }

  /** Every member's reference, in the diagram's order. */
  refs(): string[] {
    return this.rows.map((row) => row.ref);
  }

  /**
   * The member `text` names: its reference, its `<schema>.<name>`, or a bare
   * name only one member has. Undefined when it names no member, or a bare
   * name several members share (never a guess).
   */
  resolve(text: string): DiagramMemberRow | undefined {
    const match = matchTableRef(text, this.candidates);
    return match.kind === 'found' ? this.rows[match.index] : undefined;
  }

  /** The member whose `use` line reads the table file of identity `id` (schema folder and name, any layer), if any. */
  memberOf(id: TableId): DiagramMemberRow | undefined {
    const key = tableIdKey(id);
    return this.rows.find((row) => row.id !== undefined && tableIdKey(row.id) === key);
  }

  /**
   * The references once the tables `ids` join the diagram: `refs`, what
   * each new member is called (in the order given), and `renames`, the
   * existing members whose reference changes (a namesake joined), old → new.
   */
  adding(ids: readonly TableId[]): { refs: string[]; renames: Map<string, string> } {
    const all = [...this.rows.map(identityOf), ...ids];
    const refs = assignTableRefs(all);
    return { refs: refs.slice(this.rows.length), renames: this.renamesTo(refs) };
  }

  /** The members' reference changes (old → new) once the members `refs` leave the diagram (a namesake left). */
  removing(refs: readonly string[]): Map<string, string> {
    const leaving = new Set(refs.map((ref) => ref.toLowerCase()));
    const staying = this.rows.filter((row) => !leaving.has(row.ref.toLowerCase()));
    return renamesBetween(staying, assignTableRefs(staying.map(identityOf)));
  }

  /**
   * The references once the member `ref` is renamed to `newName` (its file
   * keeps its schema folder): `ref`, what it is called then, and `renames`,
   * every member's reference change, itself included (old → new).
   */
  renaming(ref: string, newName: string): { ref: string; renames: Map<string, string> } {
    const at = this.rows.findIndex((row) => row.ref.toLowerCase() === ref.toLowerCase());
    const ids = this.rows.map((row, i) => (i === at ? { schema: row.id?.schema ?? '', name: newName } : identityOf(row)));
    const refs = assignTableRefs(ids);
    return { ref: at < 0 ? newName : refs[at], renames: this.renamesTo(refs) };
  }

  /** Old → new for every member whose reference differs in `refs` (one per member, in order). */
  private renamesTo(refs: readonly string[]): Map<string, string> {
    return renamesBetween(this.rows, refs);
  }
}

/** A member's identity for {@link assignTableRefs}: its file's, or its name with no schema (named by name alone). */
function identityOf(row: DiagramMemberRow): TableId {
  return row.id ?? { schema: '', name: row.name };
}

/** Old → new for each of `rows` whose reference is not `refs[i]`. */
function renamesBetween(rows: readonly DiagramMemberRow[], refs: readonly string[]): Map<string, string> {
  const renames = new Map<string, string>();
  rows.forEach((row, i) => {
    if (refs[i] !== undefined && refs[i] !== row.ref) renames.set(row.ref, refs[i]);
  });
  return renames;
}

/**
 * Carry `renames` (old reference → new) through the v5 object `parsed`, in
 * place: its `logical.models`, `logical.relationships` ends, positions keys,
 * sticky-note links and `stubColumns` (core's `rekeySubjectArea`). The
 * `logical` section object a mutator holds stays the same object.
 */
export function renameMemberRefs(parsed: Record<string, unknown>, renames: ReadonlyMap<string, string>): void {
  if (renames.size === 0) return;
  const rekeyed = rekeySubjectArea(parsed, renames);
  if (rekeyed === parsed) return;
  for (const [key, value] of Object.entries(rekeyed)) {
    const held = parsed[key];
    if (key === 'logical' && held && typeof held === 'object' && !Array.isArray(held) && value && typeof value === 'object') {
      // The section a mutator holds keeps its identity: its fields are replaced.
      Object.assign(held as Record<string, unknown>, value);
    } else {
      parsed[key] = value;
    }
  }
}
