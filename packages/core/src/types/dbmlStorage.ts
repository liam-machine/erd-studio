/**
 * The shapes native DBML storage reads into: what the readers of
 * `@erd-studio/core/dbml` return, and the reader object
 * `loadDisplaySubjectArea` is handed (its `dbml` option). Types only, so the
 * main entry can name them without importing the parser.
 */

import type { LoaderWarningCode, Relationship, SemanticTable, TableLoadError, TableRelationship } from './semantic.js';

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
      /**
       * Every setting that holds a context field (a rationale-home built-in
       * or a `meta` key), inline or in a same-file Metadata block, and every
       * `meta_json` entry, in the order they stand: how `doctor` counts old
       * spellings and fields spelled twice. Absent when there is none. Never
       * a problem: nothing here stops a read or a write.
       */
      fieldSpellings?: DbmlFieldSpelling[];
    }
  | { ok: false; error: TableLoadError & { column?: number; message: string } };

/**
 * One spelling of a context field found in a table file (`fieldSpellings`).
 * The same name set inline and in a same-file Metadata block is one spelling.
 */
export interface DbmlFieldSpelling {
  /** `''` for the table, else the column's name as declared. */
  owner: string;
  /** Where the field's value lives: `rationale` (a table built-in) or `meta`. */
  home: 'rationale' | 'meta';
  /** The field's key: snake case for a rationale-home field (`open_questions`), the `meta` key otherwise. */
  key: string;
  /**
   * How it is spelled: `bare` (`purpose`, `owner`), `erd` (any `erd_`
   * prefixed name), `rationale` (`rationale_<key>`), `meta` (`meta_<key>`),
   * or `json` (an entry of `meta_json`).
   */
  spelling: 'bare' | 'erd' | 'rationale' | 'meta' | 'json';
  /**
   * The setting's name as the file writes it (`erd_rationale_purpose`,
   * `meta_owner`; for a `json` entry, the `meta_json` or `erd_meta_json`
   * setting that holds it). Optional: a reading from an older core has none.
   */
  name?: string;
  /** This is the spelling the value is read from (an empty or shadowed one is not). */
  used: boolean;
  /**
   * A new file would spell this field another way: `rationale_<key>` of a
   * built-in, or a `meta` key held as `meta_<key>`, `rationale_<key>` or a
   * text `meta_json` entry where a new file writes it bare. `erd_` and bare
   * spellings, `meta_<key>` of a reserved key or a built-in kept elsewhere,
   * and non-text `meta_json` entries are never old.
   */
  old: boolean;
}

/** How a one-to-one (`-`) Ref was oriented: by its `?` mark, by keys, or by position (the second end is the foreign key). */
export type DbmlOneToOneDirection = 'mark' | 'keys' | 'position';

/** One Ref as a relationships file stores it. */
export interface DbmlStoredRef {
  /** The owner's (foreign-key end's) table part as spelled in the file: qualifier removed, a DBML alias kept for the attach step. */
  owner: string;
  /** The other end's table part, spelled the same way. */
  target: string;
  /** The owner end's schema qualifier as written (`gold` in `gold.x.id`); absent for an unqualified end. It tells two tables of one name apart (`attachRelationships`). */
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
  /**
   * Each `use` line's path as written, in file order: resolved against the
   * file's folder, they name the tables the file imports, so a planner can
   * find a line naming a table no Ref names any more. Optional: absent when
   * there is none, and from a reader older than 2.0's.
   */
  uses?: string[];
  /**
   * Each table a selective `use { table … }` line imports, in file order:
   * the specifier's table name and schema qualifier as written (unquoted),
   * and the line's path as written. Resolved against the file's folder, the
   * path names the table file a Ref end spelled like the specifier means
   * (`attachRelationships`, rule 1). Optional: absent when there is none,
   * and from a reader older than schema-scoped identity.
   */
  useTables?: DbmlUseTable[];
}

/** A table a relationships file's selective `use` line imports ({@link DbmlRelationshipsReading.useTables}). */
export interface DbmlUseTable {
  /** The specifier's table name, as written. */
  table: string;
  /** The specifier's schema qualifier, as written; absent for an unqualified one. */
  qualifier?: string;
  /** The line's path, as written. */
  path: string;
}

/** A table `use` line of a diagram: the member it names and where its path points. */
export interface DbmlMemberUse {
  /** The member's table name: the path's stem. */
  name: string;
  /** The path as written. */
  path: string;
  /** The path resolved against the diagram's folder, posix and relative to the semantic dir (it may leave it: `../x`). */
  resolved: string;
  /** 1-based. */
  line: number;
  /**
   * What the diagram calls the member: its `name`, unless another member of
   * the diagram (another schema folder) has the same name, then
   * `<schema>.<name>` (core's `assignTableRefs`). It is the member's entry in
   * `members`, `logical.models`, positions and relationship ends. Optional:
   * absent from a reader older than schema-scoped identity, which means
   * `name`. Set, with the three below, by `parseSubjectAreaDbml`; the lighter
   * `diagramSummaryDbml` leaves them unset (its `members` holds each reference).
   */
  ref?: string;
  /**
   * The schema folder of the table file the path names (`<layer>/tables/<schema>/`),
   * spelled as the path spells it; absent when the path is not a table file's.
   */
  schema?: string;
  /** The layer folder of the table file the path names; absent when the path is not a table file's. */
  layer?: string;
  /** The schema qualifier the line's table specifier writes (`ccc` in `use { table ccc.addresse }`); absent when it writes none. */
  qualifier?: string;
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
  /**
   * Each warning's fixed code, index for index with `warnings` (2.0), so a
   * host can count or log them without the text. Optional: absent from a
   * reader older than 2.0's; a missing entry is `other`.
   */
  warningCodes?: LoaderWarningCode[];
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
  /**
   * Members placed by an `erd_layout` line that names them by a bare name
   * another member shares (one line kept for two tables by an older
   * version): the first of them in use order took it. A loader that finds
   * that one missing gives the place to the other. Optional: absent when
   * there is none, and from a reader older than schema-scoped identity.
   */
  layoutSharedBare?: string[];
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
  /**
   * The same specifiers in their case as written, each part re-rendered as
   * DBML writes a name (`gold.fct_order`, `"SAP FI".afih`; `"gold"."x"` is
   * `gold.x`), in order, for an exact-case compare with a table's declared
   * reference that quoting alone never fails. Optional: an older core leaves
   * it unset.
   */
  specifiers?: string[];
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
   * column block, the schema written before the table (`qualifier`, when there
   * is one), and its 1-based line. Optional: an older core leaves it unset.
   */
  metadata?: Array<{ table: string; column?: string; qualifier?: string; line: number }>;
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
  /**
   * The table as read: its `name` is the real spelling, its columns give the
   * real column spellings and the key, and its `schema` (when set) is the
   * qualifier its file declares, which a Ref end may write.
   */
  table: Pick<SemanticTable, 'name' | 'columns'> & Partial<Pick<SemanticTable, 'schema'>>;
  storage: 'yaml' | 'dbml';
  /** A DBML alias (`Table fct_order as FO`) Ref ends may use. */
  dbmlAlias?: string;
  /**
   * What relationship ends name the table by, in the caller's scope: its
   * name, or `<schema>.<name>` where another table of the scope has the same
   * name (`assignTableRefs`). Absent: `table.name`.
   */
  ref?: string;
  /** The table file's path, posix and relative to the semantic dir, which a relationships file's `use` line can name. */
  path?: string;
  /** The table file's schema folder (`<layer>/tables/<schema>/`), which a Ref end's qualifier can name. */
  schema?: string;
}

/**
 * What one Ref end says about its table, beside its name, for a
 * `dbmlTableLookup` to tell same-named tables apart: the schema qualifier the
 * end writes, and the table file the relationships file's own `use` line for
 * that spelling names (resolved, relative to the semantic dir).
 */
export interface DbmlRefEndHint {
  qualifier?: string;
  usePath?: string;
  /**
   * Set instead of `usePath` when the file's `use` lines give this exact
   * spelling to two or more different table files (`use { table adresse }`
   * from `tables/bqs/` and from `tables/ccc/`, which every DBML parser
   * refuses with [3003]): each such file, resolved, in line order. No one
   * line is the end's own, so the end is the one of those tables that has
   * every column in `columns`, and none when that is not exactly one.
   * Optional: absent from an older core.
   */
  usePaths?: readonly string[];
  /** The end's columns as written, given with `usePaths`. */
  columns?: readonly string[];
}

/** Where one Ref is, for the attach step's reports. */
export interface DbmlRefLocation {
  /** The relationships file, as the caller named it. */
  path: string;
  line: number;
  /** The owner as resolved (its reference), or as spelled when no table has that name. */
  owner: string;
  target: string;
  /** The owner's table file, when it resolved to a table whose path the caller gave. Optional. */
  ownerPath?: string;
  /** The other end's table file, when it resolved to a table whose path the caller gave. Optional. */
  targetPath?: string;
}

/** What {@link DbmlAttachTable}s gained from the relationships files read. */
export interface DbmlAttachResult {
  /**
   * Each DBML owner's relationships (its lower-case reference → list: its
   * name, unless the scope holds another table of that name), in file order,
   * with `compositeKey`s derived.
   */
  byOwner: Map<string, TableRelationship[]>;
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
  /**
   * Refs not drawn because of what their ends name: an end that tables in
   * more than one schema folder could be and nothing decides (`ambiguous`,
   * with those tables' schema folders), or two ends that land on one table
   * with the same columns (`selfJoin`: a stale qualifier). Each also has its
   * sentence in `warnings`. Optional: an attach step older than this field
   * leaves it unset.
   */
  unresolved?: DbmlUnresolvedRef[];
}

/** A Ref {@link DbmlAttachResult.unresolved} names: where it is written, why it is not drawn, and the end that says so. */
export interface DbmlUnresolvedRef {
  /** The relationships file, as the caller named it. */
  path: string;
  /** 1-based line of the Ref. */
  line: number;
  kind: 'ambiguous' | 'selfJoin';
  /** The end's table as written (ambiguous), or the one table both ends land on (selfJoin). */
  table: string;
  /** Ambiguous: the schema folders of the tables it could be, in listing order. */
  schemas?: string[];
  /** Ambiguous: the schema the end wrote before the table (`zzz` in `zzz.addresse`), when it wrote one. */
  qualifier?: string;
}
