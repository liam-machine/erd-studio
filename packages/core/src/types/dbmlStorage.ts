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
   * `repeatedNote`, `secondProject`, `usePathMismatch`, `unsafeUse`, …
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
  /** Canonical (`fromModel` = owner), one per column pair, in the Ref's column order, with no `compositeKey` yet. */
  relationships: Relationship[];
  /** The Ref element's span (writers re-read the file; readers ignore it). */
  start: number;
  fullEnd: number;
  /** 1-based line of the Ref. */
  line: number;
  /** How a `-` Ref was oriented; `'keys'` leaves it to `attachRelationships`, which has the tables. */
  oneToOneDirection?: DbmlOneToOneDirection;
}

/** A relationships file, read Ref by Ref (`readRelationshipsDbml`). */
export interface DbmlRelationshipsReading {
  /** False for a syntax error or conflict markers: no Ref is read, and writes to the file are refused. */
  readable: boolean;
  refs: DbmlStoredRef[];
  problems: DbmlProblem[];
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
  /** Library folders the table `use` lines name (`''` = the top of `tables/`). */
  useFolders: string[];
  /** False with a repeated Note name or a second Project: the writer refuses the file until it is fixed (§2.5). */
  writable: boolean;
  warnings: string[];
  /** Each member's `use` line. Optional: absent from a reader older than this field. */
  uses?: DbmlMemberUse[];
  /** The file declares at least one Table and has no table `use` line: most likely a dropped-in single-file DBML to import. */
  holdsOwnTables?: boolean;
}

/** The DBML readers `loadDisplaySubjectArea` needs; `dbmlStorageReader` from `@erd-studio/core/dbml` is one. */
export interface DbmlStorageReader {
  parseTable(text: string, fileStem: string): DbmlTableReading;
  readRelationships(text: string): DbmlRelationshipsReading;
  /** Throws `SubjectAreaFileError` / `SubjectAreaValidationError`. */
  parseSubjectArea(text: string, filePath: string, layoutText: string | null): DbmlSubjectAreaReading;
  /** The members from the AST only, with no compile; null when the text does not parse. */
  subjectAreaMembers(text: string): string[] | null;
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
  /** Its library folder (`''` = the top of `tables/`). */
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
  /** Refs attached from a file other than their owner's folder's. */
  misplaced: Array<DbmlRefLocation & { home: string }>;
  /** Refs owned by a YAML table or by no table: not attached, never touched. */
  orphaned: DbmlRefLocation[];
  /** Links read more than once; `kept` is the copy attached, `dropped` the other. */
  duplicates: Array<{ link: string; kept: DbmlRefLocation; dropped: DbmlRefLocation }>;
  /** One sentence per misplaced, orphaned or duplicate Ref. */
  warnings: string[];
}
