/**
 * The shapes native DBML storage reads into: what the readers of
 * `@erd-studio/core/dbml` return, and the reader object
 * `loadDisplaySubjectArea` is handed (its `dbml` option). Types only, so the
 * main entry can name them without importing the parser.
 */

import type { Relationship, SemanticTable, TableLoadError, TableRelationship } from './semantic.js';

/** One thing a DBML reader noticed: a warning on a file that was read, or why part of it was not. */
export interface DbmlProblem {
  /** The file, when the caller named it (posix, relative to the semantic dir). */
  file?: string;
  /** 1-based. */
  line?: number;
  /** 1-based. */
  column?: number;
  /**
   * A DBML diagnostic's numeric code, or one of ERD Studio's own names:
   * `useInTableFile`, `refInTableFile`, `inlineRefInTableFile`,
   * `unquotedValue`, `metaJson`, `unreadableRef`, `declaredInDiagram`,
   * `repeatedNote`, `secondProject`, `usePathMismatch`, `unsafeUse`,
   * `schemaFolderMismatch`, `unqualifiedTable`, `schemaProperty`, …
   */
  code?: number | string;
  message: string;
  severity: 'error' | 'warning';
  /** The file holds git conflict markers: never pick a side. */
  mergeConflict?: true;
}

/** A `.dbml` table file, read on its own (`parseTableDbml`). */
export type DbmlTableReading =
  | {
      ok: true;
      /** The table: `name` is the declared spelling; `relationships` is never set (they live in relationships files). */
      table: SemanticTable;
      /** The Table's name as declared, without any schema qualifier. */
      declaredName: string;
      /** How Ref ends and `use` specifiers spell the table: `x`, or `gold.x` when the name is qualified, each part as DBML writes a name. */
      declaredReference: string;
      /** A DBML alias (`Table fct_order as FO`), which Refs may use. */
      alias?: string;
      /** The Table names its schema in its name (`Table gold.x`). */
      schemaQualified: boolean;
      /** False while a `use` line, a `Ref` or a column `[ref: …]` is in the file: writes are refused until it is moved (§2.2). */
      writable: boolean;
      problems: DbmlProblem[];
    }
  | { ok: false; error: TableLoadError & { column?: number; message: string } };

/** How a one-to-one (`-`) Ref was oriented: by its `?` mark, by keys, or by position (the second end is the foreign key). */
export type DbmlOneToOneDirection = 'mark' | 'keys' | 'position';

/** One Ref as a relationships file stores it. */
export interface DbmlStoredRef {
  /** The owner's (foreign-key end's) table part as spelled in the file: qualifier removed, a DBML alias kept for the attach step. */
  owner: string;
  /** The other end's table part, spelled the same way. */
  target: string;
  /** The owner end's schema qualifier as written (`gold` in `gold.x.id`); absent for an unqualified end. Ends are matched by table name alone. */
  ownerQualifier?: string;
  /** The other end's schema qualifier as written; absent for an unqualified end. */
  targetQualifier?: string;
  /** Canonical (`fromModel` = owner), one per column pair, in the Ref's column order, with no `compositeKey` yet. */
  relationships: Relationship[];
  /** The Ref element's span (writers re-read the file; readers ignore it). */
  start: number;
  fullEnd: number;
  /** 1-based line of the Ref. */
  line: number;
  /** How a `-` Ref was oriented; `'keys'` leaves it to `attachRelationships`, which has the tables. */
  oneToOneDirection?: DbmlOneToOneDirection;
  /**
   * A pending relationship (D27): read from a `// erd-studio pending: Ref …`
   * comment line, not a live Ref. `start`/`fullEnd` are that line's span
   * (its line break included). Optional: absent on a live Ref.
   */
  pending?: true;
}

/** A relationships file, read Ref by Ref (`readRelationshipsDbml`). */
export interface DbmlRelationshipsReading {
  /** False for a syntax error or conflict markers: no Ref is read, and writes to the file are refused. */
  readable: boolean;
  refs: DbmlStoredRef[];
  problems: DbmlProblem[];
  /**
   * Pending relationships (D27): `// erd-studio pending: Ref …` lines, read
   * like Refs and attached to their owner like them, never compiled as part
   * of the file. Optional: a reader older than 2.0's leaves it unset.
   */
  pending?: DbmlStoredRef[];
  /**
   * Top-level elements that do not belong in a relationships file (anything
   * but `use` lines and Refs: a `Table`, `Enum`, `TableGroup`, …), each with
   * its kind as written and its 1-based line. The writer keeps their bytes;
   * `doctor` reports them, since every diagram importing the file gets them
   * in other DBML tools. Optional: absent when there is none, and from a
   * reader older than 2.0's.
   */
  otherElements?: Array<{ kind: string; line: number }>;
}

/** A table `use` line of a diagram: the member it names and where its path points. */
export interface DbmlMemberUse {
  /** The member: the path's stem. */
  name: string;
  /** The path as written. */
  path: string;
  /** The path resolved against the diagram's folder, posix and relative to the semantic dir (it may leave it: `../x`). */
  resolved: string;
  /** 1-based. */
  line: number;
}

/** A `.dbml` diagram, read into the v5 shape the rest of core reads (`parseSubjectAreaDbml`). */
export interface DbmlSubjectAreaReading {
  /** The v5 subject-area object (§2.5): `schemaVersion` 5 (D8), `layer` the folder, `logical.relationships` always `[]`. */
  obj: Record<string, unknown>;
  /** `erd_schema_version` (7 when missing): applied to the Unified and Display `schemaVersion` only. */
  schemaVersion: number;
  /** The members, in `use` order (= `obj.logical.models`); a table listed twice is listed twice. */
  members: string[];
  /** The distinct table folders (`<layer>/tables/<schema>`) the member `use` lines resolve into, sorted. */
  useTableDirs: string[];
  /**
   * The relationships files the diagram imports (`use * from` a
   * `<layer>/relationships/<f>.dbml`), resolved (posix, relative to the
   * semantic dir), without repeats, in file order.
   */
  relationshipsUses: string[];
  /**
   * Every other `use *` line's path (a relationships file in a subfolder, a
   * shared Enum file, …), resolved, in file order: never a member nor a
   * relationships import, and kept as written by every writer.
   */
  otherUses: string[];
  /** False with a repeated Note name or a second Project: the writer refuses the file until it is fixed (§2.5). */
  writable: boolean;
  warnings: string[];
  /** Each member's `use` line. Optional: absent from a reader older than this field. */
  uses?: DbmlMemberUse[];
  /** The file declares at least one Table and has no table `use` line: most likely a dropped-in single-file DBML to import. */
  holdsOwnTables?: boolean;
  /**
   * Members listed by the Project's `erd_unlinked_tables` (D26), in order:
   * they have no `.dbml` table file to `use`, and come after the `use`
   * members in `members`. Optional: absent from a reader older than 2.0's.
   */
  unlinked?: string[];
  /**
   * The diagram's pending relationships (D27): `// erd-studio pending: Ref …`
   * lines, owned by a table with no `.dbml` file, read into
   * `obj.logical.relationships` (canonical). Each with its 1-based line.
   * Optional: absent from a reader older than 2.0's.
   */
  pending?: Array<{ line: number; relationships: Relationship[] }>;
  /**
   * What reading the Project's `erd_layout` found (§1.6): `layoutBadLine`
   * and `layoutDuplicateKey` (warnings), `layoutBadValue` (an error: other
   * DBML tools reject the file) and `layoutMergeConflict` (an error,
   * `mergeConflict`). Optional: absent when there is none, and from a
   * reader older than 2.0's.
   */
  layoutProblems?: DbmlProblem[];
  /** 1-based file line of the first git conflict marker inside `erd_layout`: positions are not saved until it is resolved. */
  layoutConflictLine?: number;
}

/** The DBML readers `loadDisplaySubjectArea` needs; `dbmlStorageReader` from `@erd-studio/core/dbml` is one. */
export interface DbmlStorageReader {
  /** `schemaFolder`: the table file's schema folder (`<layer>/tables/<schema>/`), its schema when the Table is unqualified. */
  parseTable(text: string, fileStem: string, options?: { schemaFolder?: string }): DbmlTableReading;
  readRelationships(text: string): DbmlRelationshipsReading;
  /** Throws `SubjectAreaFileError` / `SubjectAreaValidationError`. */
  parseSubjectArea(text: string, filePath: string): DbmlSubjectAreaReading;
  /** The members from a syntax parse alone (no binding); null when the text does not parse or `filePath` is not a diagram's. */
  subjectAreaMembers(text: string, filePath: string): string[] | null;
}

/** A `use` line of a `.dbml` file, as `outlineDbmlFile` reads it. */
export interface DbmlUseOutline {
  /** The path as written. */
  path: string;
  /** Resolved against the file's folder, with `.dbml`, posix and relative to the semantic dir (it may leave it: `../x`). */
  resolved: string;
  /** 1-based. */
  line: number;
  /** `use * from …`. */
  wildcard: boolean;
  /** A selective line's table specifiers: each unqualified name, lower-case. */
  tables: string[];
}

/** What `doctor` checks in a `.dbml` file: its `use` lines and the Enums it declares (`outlineDbmlFile`). */
export interface DbmlFileOutline {
  /** False when the file does not parse (a syntax error): nothing else is read. */
  parses: boolean;
  uses: DbmlUseOutline[];
  /** Each Enum's name as declared (`status`, `gold.status`) and its 1-based line. */
  enums: Array<{ name: string; line: number }>;
  /**
   * Each `Metadata Table t` / `Metadata Column t.c` block (D25, DBML 9.1+):
   * the table it targets (its last name part, as written), the column for a
   * column block, and its 1-based line. Optional: an older core leaves it unset.
   */
  metadata?: Array<{ table: string; column?: string; line: number }>;
  /**
   * The last name part of each `Table` the file itself declares (as written),
   * so a `Metadata` block on one of them is not read as a block outside its
   * table's file. Optional: an older core leaves it unset.
   */
  tables?: string[];
}

/** A diagnostic of {@link DbmlStorageReader}-adjacent multi-file compiles (`compileDbmlProject`). */
export interface DbmlDiagnostic {
  code: number;
  message: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

/** A table `attachRelationships` may attach a Ref to, or resolve a Ref's other end against. */
export interface DbmlAttachTable {
  /** The table as read: its `name` is the real spelling, its columns give the real column spellings and the key. */
  table: Pick<SemanticTable, 'name' | 'columns'>;
  /**
   * Its library folder (`''` = the top of `tables/`). Not read: no Ref has a
   * home folder in the layer-first tree.
   * @deprecated 2.0-switch: S6a deletes it.
   */
  folder: string;
  storage: 'yaml' | 'dbml';
  /** A DBML alias (`Table fct_order as FO`) Ref ends may use. */
  dbmlAlias?: string;
}

/** Where one Ref is, for the attach step's reports. */
export interface DbmlRefLocation {
  /** The relationships file, as the caller named it. */
  path: string;
  line: number;
  /** The owner as resolved (real spelling), or as spelled when no table has that name. */
  owner: string;
  target: string;
}

/** What {@link DbmlAttachTable}s gained from the relationships files read. */
export interface DbmlAttachResult {
  /** Each DBML owner's relationships (lower-case name → list), in file order, with `compositeKey`s derived. */
  byOwner: Map<string, TableRelationship[]>;
  /**
   * Always empty: in the layer-first tree a Ref may sit in any relationships
   * file (decision 5), so none is misplaced. Optional, for its one reader.
   * @deprecated 2.0-switch: S8b deletes it with doctor's `misplacedRef`.
   */
  misplaced?: Array<DbmlRefLocation & { home: string }>;
  /** Refs owned by a YAML table or by no table: not attached, never touched. */
  orphaned: DbmlRefLocation[];
  /** Links read more than once; `kept` is the copy attached, `dropped` the other. */
  duplicates: Array<{ link: string; kept: DbmlRefLocation; dropped: DbmlRefLocation }>;
  /** One sentence per orphaned or duplicate Ref. */
  warnings: string[];
  /**
   * Where each attached link is stored (core `linkKey` → the copy kept, the
   * duplicate winner for a link read twice). Optional: an attach step older
   * than 2.0's leaves it unset.
   */
  locations?: Map<string, DbmlRefLocation>;
}
