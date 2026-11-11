/**
 * Which table a sidebar row or command means, and which diagrams show it:
 * the Table Library's "on 2 diagrams", Go to Table's rows, Add to Diagram…,
 * Open in Diagram, the Relationships view's actions and the Explorer's
 * tooltips all ask through one {@link TableUsageKeys}, so they agree.
 *
 * Two rules, picked once by the library:
 *
 * - **By name** (the rule every project has had): a table is its name,
 *   without case, and a diagram shows it when one of its members has that
 *   name. {@link tableUsageByName}.
 * - **By identity** (`TableLibraryService.schemaScopedNames`: two tables of
 *   one name may sit in different schema folders): a table is the file it
 *   lives in, its schema folder and name (`tableIdKey`), and a diagram shows
 *   it when a member's `use` line reads that file. A member named by name
 *   alone (a JSON diagram's, an unlinked one) is the table that name reads
 *   in the library: the first listed, as the canvas draws it. A member whose
 *   `use` line names a file the library does not list (moved or deleted
 *   outside the extension) is the one table of its name, or none when
 *   several share it (owner decision B: never guessed).
 *   {@link tableUsageByIdentity}.
 *
 * A key is only ever compared, never shown or written. Never writes, no `vscode`.
 */

import * as path from 'path';

import { tableIdKey } from '@erd-studio/core';

import type { TableFileEntry, TableLibraryService } from './logicalModelService';
import type { DiagramMemberId, DiagramMembers } from './diagramMembers';
import { tableIdOfEntry } from './tableLibraryIndex';
import { normaliseName } from './nameUtils';

/**
 * A table as a sidebar row or a command names it: its name (or, from the
 * Relationships view, its library reference: `<schema>.<name>` where two
 * schema folders share the name), and its file when the row knows it.
 */
export interface SidebarTable {
  readonly name: string;
  /** The table's file, absolute. */
  readonly filePath?: string;
}

/** How tables and diagram members are matched (see the module comment). */
export interface TableUsageKeys {
  /** Whether tables are told apart by identity (their files), not by name. */
  readonly byIdentity: boolean;
  /** The key of the table `table` names. */
  keyOf(table: SidebarTable | string): string;
  /** The keys of the members of the diagram at `diagramPath`, each once; null when it does not parse. Throws when it cannot be read. */
  membersOf(diagramPath: string): string[] | null;
  /**
   * What the diagram at `diagramPath` calls `table` (the member's reference,
   * `<schema>.<name>` where it shows two tables of the name); by name, the
   * name as given. Undefined when, told apart by identity, it does not show it.
   */
  refOn(diagramPath: string, table: SidebarTable | string): string | undefined;
  /** The table `table` names, with its file when the library lists one (by name: as given). */
  tableOf(table: SidebarTable | string): SidebarTable;
}

const asTable = (table: SidebarTable | string): SidebarTable => (typeof table === 'string' ? { name: table } : table);

/** The rule every project has had: a table is its name, without case. */
export function tableUsageByName(memberNames: (diagramPath: string) => string[] | null): TableUsageKeys {
  const keyOf = (table: SidebarTable | string): string => normaliseName(asTable(table).name);
  return {
    byIdentity: false,
    keyOf,
    membersOf: (diagramPath) => {
      const names = memberNames(diagramPath);
      return names === null ? null : [...new Set(names.map(normaliseName))];
    },
    refOn: (_diagramPath, table) => asTable(table).name,
    tableOf: asTable,
  };
}

/**
 * Tables told apart by identity: `entries` is the library's listing, in its
 * lookup order; `memberIds` a diagram's members with the files their `use`
 * lines read (`DiagramMembers.idsOf`); `resolveLibraryRef` turns a library
 * reference (`<schema>.<name>`, or a name) into its entry.
 */
export function tableUsageByIdentity(input: {
  entries: readonly TableFileEntry[];
  memberIds: (diagramPath: string) => DiagramMemberId[] | null;
  resolveLibraryRef?: (text: string) => TableFileEntry | undefined;
}): TableUsageKeys {
  const byPath = new Map<string, TableFileEntry>();
  const listed = new Set<string>();
  const firstNamed = new Map<string, TableFileEntry>();
  const identitiesNamed = new Map<string, Set<string>>();
  for (const entry of input.entries) {
    byPath.set(path.resolve(entry.filePath), entry);
    if (entry.shadowedBy) continue;
    const key = tableIdKey(tableIdOfEntry(entry));
    listed.add(key);
    const name = normaliseName(entry.name);
    if (!firstNamed.has(name)) firstNamed.set(name, entry);
    const keys = identitiesNamed.get(name) ?? new Set<string>();
    keys.add(key);
    identitiesNamed.set(name, keys);
  }
  const entryKey = (entry: TableFileEntry): string => tableIdKey(tableIdOfEntry(entry));
  // A name alone: the table it reads in the library (the first listed), else the name itself.
  const byName = (name: string): string => {
    const entry = firstNamed.get(normaliseName(name));
    return entry ? entryKey(entry) : normaliseName(name);
  };
  const entryOf = (table: SidebarTable): TableFileEntry | undefined => {
    if (table.filePath !== undefined) {
      const atPath = byPath.get(path.resolve(table.filePath));
      if (atPath) return atPath;
    }
    return input.resolveLibraryRef?.(table.name) ?? firstNamed.get(normaliseName(table.name));
  };
  const keyOf = (table: SidebarTable | string): string => {
    const entry = entryOf(asTable(table));
    return entry ? entryKey(entry) : normaliseName(asTable(table).name);
  };
  const memberKey = (member: DiagramMemberId): string => {
    if (member.id === undefined) return byName(member.ref);
    const key = tableIdKey(member.id);
    if (listed.has(key)) return key;
    // Its file is not listed: the one table of its name, never one of several.
    const named = identitiesNamed.get(normaliseName(member.id.name));
    return named?.size === 1 ? [...named][0] : key;
  };
  return {
    byIdentity: true,
    keyOf,
    membersOf: (diagramPath) => {
      const members = input.memberIds(diagramPath);
      return members === null ? null : [...new Set(members.map(memberKey))];
    },
    refOn: (diagramPath, table) => {
      const wanted = keyOf(table);
      return input.memberIds(diagramPath)?.find((member) => memberKey(member) === wanted)?.ref;
    },
    tableOf: (table) => {
      const given = asTable(table);
      const entry = entryOf(given);
      return entry ? { name: entry.name, filePath: entry.filePath } : given;
    },
  };
}

/**
 * The rule the library `library` follows, over the diagrams' members
 * (`members`, cached by file version): by identity when it tells tables
 * apart by their schema folders, else by name.
 */
export function tableUsageOf(
  library: Pick<TableLibraryService, 'listTableFiles' | 'resolveLibraryRef'> & { readonly schemaScopedNames?: boolean },
  members: Pick<DiagramMembers, 'of' | 'idsOf'>,
): TableUsageKeys {
  if (library.schemaScopedNames !== true) return tableUsageByName((p) => members.of(p));
  return tableUsageByIdentity({
    entries: library.listTableFiles(),
    memberIds: (p) => members.idsOf(p),
    resolveLibraryRef: (text) => {
      const match = library.resolveLibraryRef(text);
      return match.kind === 'found' ? match.entry : undefined;
    },
  });
}
