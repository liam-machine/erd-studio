/**
 * TableLibraryService — reads and writes canonical model definitions
 * stored as YAML files in .erd-studio/logical-models/.
 *
 * Each model is a single YAML file, either at the top of the library
 * (logical-models/{model_name}.yml) or one folder down
 * (logical-models/{folder}/{model_name}.yml). The folder is purely
 * organisational — by convention the layer id of the domain the model was
 * created in — and never part of the model's identity: domain JSON files
 * reference models by name (string[]), so names stay unique across the whole
 * library, exactly as dbt requires of model names across a project.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Document, Pair, YAMLMap, YAMLSeq, parseDocument, isAlias, isMap, isNode, isPair, isScalar, isSeq, visit } from 'yaml';
import type { Alias, Node, Scalar, ScalarTag, Tags } from 'yaml';

import {
  DBML_RELATIONSHIPS_FILE_NAME, LAYERS_CONFIG_FILE, LOGICAL_MODELS_DIR, RATIONALE_KEYS, RELATIONSHIPS_DIR, TABLES_DIR, TableDbmlError, classifySemanticFile, classifyTableLoadError,
  dbmlName, dbmlTablePath, isDbmlLayerName, isLibraryFolderName, tableLoadWarningOf, parseTableText, writesDbml, writesTableNaming,
} from '@erd-studio/core';
import { attachRelationships, dbmlTableLookup, parseTableDbml, readRelationshipsDbml } from '@erd-studio/core/dbml';
import { projectNamingOf } from './projectNaming';
import { projectStorageIn } from './projectStorage';
import type {
  DbmlAttachResult, DbmlAttachTable, DbmlProblem, DbmlMetadataTarget, DbmlRelationshipsReading, DbmlTableReading, DbmlTableStructureRule, ProjectStorage, TableLoadErrorKind,
} from '@erd-studio/core';
import type { ColumnDef, TableRelationship, SemanticTable } from '../types/semantic';
import type { YmlModelInfo } from '../types/ymlData';
import type { ManifestData, ManifestModelInfo } from '../types/manifest';
import { OwnWriteTracker, ownWrites } from './ownWriteTracker';
import { sameName } from '../types/naming';
import { keepLineEndings } from './lineEndings';
import type { FileWrite } from './fileWrites';
import { writeFilesWithRollback } from './fsFileWrites';
import { planDbmlLibraryWrites } from './dbmlLibraryWrites';
import type { DbmlLibraryOps, DbmlLibrarySnapshot, DbmlLibraryWritePlan, DbmlSnapshotTable } from './dbmlLibraryWrites';
import { dropRelationshipsTo } from './libraryRelationships';
import { memberAttachment } from './memberAttachment';
import { TableLibraryIndex, foldersOf, holdsTableFiles, isLayerFolder, layersListTables, listDir } from './tableLibraryIndex';
import { log } from './logger';

/** Table file writes an editor edit bundles with its diagram change (one WorkspaceEdit). */
export interface TableFileOps {
  /** Tables whose file is written in full (created if missing); `fromName` renames. */
  save?: Array<{ model: SemanticTable; fromName?: string }>;
  /** Table names whose file is deleted. */
  delete?: string[];
}

// The directory name and the YAML -> SemanticTable parsing live in
// @erd-studio/core; re-exported so existing imports of this module keep working.
export { LOGICAL_MODELS_DIR, TABLES_DIR } from '@erd-studio/core';

/** The names in `dir`, or null when it cannot be listed. */
function listNamesOrNull(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

/**
 * Whether `{semanticRoot}/tables/` is a layer folder rather than v6's table
 * library (#162). A project made before v6 may have a layer called `tables`:
 * it is one when `layers.json` lists a layer with that id, or when the folder
 * holds a subject area file (`tables/*.json`). A library folder holds only
 * `*.yml`, at the top or one folder down. A folder that is a layer keeps the
 * project on v5 (it is never read as a library) until it is renamed. A
 * `.dbml` there is a 1.9 pre-release leftover and changes nothing: the DBML
 * tree lives under the layer folders. `TableLibraryService` answers the same
 * from its index (`tableLibraryIndex.ts`, the same rules over one listing).
 */
export function tablesDirIsLayer(semanticRoot: string): boolean {
  return isLayerFolder(listDir(path.join(semanticRoot, TABLES_DIR)), layersListTables(semanticRoot));
}

/**
 * Whether `{semanticRoot}/tables/` is the v6 table library: it holds a table
 * file (`*.yml`, top level or one folder down) and is not a layer folder
 * (see {@link tablesDirIsLayer}).
 */
export function hasTablesLibrary(semanticRoot: string): boolean {
  const dir = path.join(semanticRoot, TABLES_DIR);
  if (!fs.existsSync(dir) || tablesDirIsLayer(semanticRoot)) return false;
  // A folder made by hand (or by an assistant) is not a library until it holds a table file.
  return holdsTableFiles(listDir(dir), (folder) => listNamesOrNull(path.join(dir, folder)));
}

/** Parsed model cached against the file's mtime + size. */
interface CachedTable {
  readonly signature: string;
  readonly model: SemanticTable;
}

/**
 * Stringify options for model files. `lineWidth: 0` disables folding so
 * long descriptions are never re-wrapped, keeping diffs limited to the
 * fields that actually changed.
 */
const STRINGIFY_OPTIONS = { lineWidth: 0 } as const;

/**
 * The `yaml` library prints a number from its value, not from the text it was
 * parsed from, so every save rewrote `007`, `1e3`, `.5` and `+1` as `7`,
 * `1e+3`, `0.5` and `1` — though core's reader takes a number's text, so a
 * `meta` value of `007` then read "7" (#157). A number that still holds the
 * text it was parsed from, and that text reads as its value, prints as that
 * text. One changed by {@link setScalarValue} has no text left, and prints as
 * usual. Given to every document parsed for editing.
 */
function keepNumberText(tags: Tags): Tags {
  const NUMBER_TAGS = new Set(['tag:yaml.org,2002:int', 'tag:yaml.org,2002:float']);
  return tags.map((tag) => {
    if (typeof tag === 'string' || !NUMBER_TAGS.has(tag.tag)) return tag;
    const print = (tag as ScalarTag).stringify;
    if (typeof print !== 'function') return tag;
    const keep: ScalarTag['stringify'] = (item, ...rest) => {
      const { value, source } = item as Scalar;
      const asWritten = typeof value === 'number' && typeof source === 'string'
        && source !== '' && source.trim() === source && Number(source) === value;
      return asWritten ? source : print(item, ...rest);
    };
    return { ...tag, stringify: keep } as ScalarTag;
  });
}

/**
 * Folders the extension itself may create under logical-models/: the layer id
 * format (`LayerService` / core `validateLayersConfig` use the same pattern).
 * Reading is more tolerant — any one-level, non-dot folder a user made by hand
 * is indexed — but a new file only ever lands in a folder with a layer-shaped
 * name, so nothing a domain file says can make the extension write elsewhere.
 */
const TABLE_FOLDER_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** One model file found in the library. */
/**
 * Why a model file that exists could not be read. A fixed set, derived from
 * the `yaml` library's own error code (never the message text), so it is safe
 * to count in usage telemetry and to branch on in the UI.
 */
export type TableFileErrorKind = TableLoadErrorKind;

/**
 * A model file that exists but cannot be read or parsed. `message` is the
 * parser's own text and may quote the file — show it locally, never send it.
 */
export interface TableFileError {
  name: string;
  filePath: string;
  kind: TableFileErrorKind;
  /** 1-based, when the parser reported a position. */
  line?: number;
  column?: number;
  /** The parser's code: the `yaml` library's (`BLOCK_AS_IMPLICIT_KEY`) or a DBML diagnostic's (`3025`, `structure:notOneTable`). */
  code?: string;
  /** The file holds unresolved git merge conflicts (#145); `line` is the first `<<<<<<<`. */
  mergeConflict?: true;
  /** A `.dbml` table's `Metadata` block whose table or column is missing (D25). */
  target?: DbmlMetadataTarget;
  /**
   * The model was still read (#164): a key written twice, whose last value is
   * used. The file is refused for writing until one copy is removed.
   */
  readable?: true;
  /** For a readable duplicate key: the key written twice, as the file spells it. */
  key?: string;
  message: string;
}

/** Describe a failure thrown while reading or parsing a model file. */
export function describeTableFileError(name: string, filePath: string, err: unknown): TableFileError {
  const message = err instanceof Error ? err.message : String(err);
  // The classification is core's, so the extension and loadDisplaySubjectArea agree.
  return { name, filePath, ...classifyTableLoadError(err), message };
}

/** The {@link TableFileError} for a model read from a file with a key written twice (#164). */
function duplicateKeyFileError(name: string, filePath: string, warning: { key: string; line: number }): TableFileError {
  return {
    name,
    filePath,
    kind: 'yamlDuplicateKey',
    line: warning.line,
    code: 'DUPLICATE_KEY',
    readable: true,
    ...(warning.key ? { key: warning.key } : {}),
    message: `${warning.key ? `"${warning.key}"` : 'A key'} is written twice in one block (line ${warning.line}); the last value is used`,
  };
}

export interface TableFileEntry {
  /** Model name: the file stem as listed (a `.dbml` file's declared name may differ in case, D2). */
  readonly name: string;
  /**
   * Sub-folder under its library folder (`''` for a file at the top level);
   * a DBML table's schema folder (`<layer>/tables/<schema>/`).
   */
  readonly folder: string;
  /** A DBML table's layer folder (`<layer>/tables/<schema>/<name>.dbml`); absent for YAML. */
  readonly layer?: string;
  /** Absolute path to the yml file. */
  readonly filePath: string;
  /**
   * Set when another file with the same name wins the lookup (top level
   * first, then folders alphabetically; `logical-models/` before `tables/`):
   * the path of the file that is used. A shadowed file is never read for a
   * domain.
   */
  readonly shadowedBy?: string;
  /**
   * Set on a file in v6's `tables/` library (#162), which is read but never
   * written by this version. Absent for `logical-models/`.
   */
  readonly library?: typeof TABLES_DIR;
  /**
   * How the file stores the table: `yaml` (`*.yml`, in `logical-models/` or
   * `tables/`) or `dbml` (`<layer>/tables/<schema>/*.dbml`).
   */
  readonly storage: 'yaml' | 'dbml';
}

/** One table as the Add Existing Table dialog lists it ({@link TableLibraryService.tablePreviews}). */
export interface TablePreview {
  /** The table's name (as declared; the file name for a `pending` row). */
  name: string;
  /** Its file, absolute. */
  filePath: string;
  schema: string;
  description: string;
  columnCount: number;
  /** The file has not been read yet: `schema` and `description` are empty and `columnCount` is 0. */
  pending?: true;
}

/** A `.dbml` table file read through the cache: the reader's answer for its text. */
interface CachedDbmlTable {
  readonly signature: string;
  readonly reading: DbmlTableReading;
}

/** A relationships file read through the cache. */
interface CachedRelationships {
  readonly signature: string;
  readonly reading: DbmlRelationshipsReading;
}

/**
 * The message a YAML write of a `.dbml` table file gets: DBML tables are
 * written only by the DBML writer (`planTableWrites`), so reaching this is a bug.
 */
export const DBML_TABLE_EDITING_NOT_AVAILABLE = 'A DBML table file is written by the DBML writer, never as YAML (an ERD Studio bug; nothing was changed).';

/** Refused: a YAML render of a `.dbml` table file (never written as YAML). */
export class DbmlTableWriteRefused extends Error {
  readonly filePath?: string;
  constructor(message: string = DBML_TABLE_EDITING_NOT_AVAILABLE, filePath?: string) {
    super(message);
    this.name = 'DbmlTableWriteRefused';
    if (filePath !== undefined) this.filePath = filePath;
  }
}

/** Whether `filePath` is a `.dbml` file. */
function isDbmlFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.dbml');
}

/** A file's `mtime:size`, or null when it cannot be stat'ed. */
function fileSignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** A `.dbml` file name's stem (`_relationships.dbml` → `_relationships`). */
function dbmlStem(fileName: string): string {
  return fileName.slice(0, -'.dbml'.length);
}

/** The {@link TableDbmlError} for a reading that failed, so `classifyTableLoadError` classifies it as core's loader does. */
function dbmlReadingError(error: Extract<DbmlTableReading, { ok: false }>['error']): Error {
  if (error.kind === 'read') {
    // An empty file: a read failure, as the YAML reader's is.
    return Object.assign(new Error(error.message), { code: 'EEMPTY' });
  }
  const code = error.code;
  const rule = code?.startsWith('structure:') ? code.slice('structure:'.length) : undefined;
  const dbmlCode = code !== undefined && /^\d+$/.test(code) ? Number(code) : undefined;
  return new TableDbmlError(error.message, {
    ...(dbmlCode !== undefined ? { dbmlCode } : {}),
    ...(rule !== undefined ? { rule: rule as DbmlTableStructureRule } : {}),
    ...(error.line !== undefined ? { line: error.line } : {}),
    ...(error.column !== undefined ? { column: error.column } : {}),
    ...(error.mergeConflict ? { mergeConflict: true } : {}),
    ...(error.target !== undefined ? { target: error.target } : {}),
    ...(dbmlCode === undefined && rule === undefined && error.kind === 'dbmlSyntax' ? { dbmlCode: 1000 } : {}),
  });
}

/**
 * A table whose name (ignoring case) has a file in both `logical-models/`
 * and `tables/` (#162): a project half-way between the v5 and v6 naming.
 * `kept` is the file that is read (the `logical-models/` one); `ignored` is
 * never read. Reported, never resolved silently.
 */
export interface TableNamingConflict {
  readonly name: string;
  readonly kept: string;
  readonly ignored: string;
}

/** Keys ERD Studio owns on a model file. Unknown keys are left untouched. */
// `relationships` is synced on its own, entry by entry (syncRelationships).
const TABLE_KEYS = ['name', 'schema', 'alias', 'description', 'grain', 'modelRole', 'rationale', 'meta', 'columns'] as const;
const RELATIONSHIP_KEYS = ['fromColumn', 'toModel', 'toColumn', 'cardinality', 'role', 'compositeKey'] as const;
/** A non-empty top-level `relationships:` list, as text (for a file that does not parse). */
const RELATIONSHIPS_IN_TEXT = /^relationships[ \t]*:(?:\s*#.*)*\s*(?:-|\[\s*[^\s\]])/m;
const COLUMN_KEYS = [
  'name', 'dataType', 'description',
  'isPrimaryKey', 'isForeignKey', 'isNaturalKey',
  'scdType', 'additiveType', 'meta',
] as const;
/** dbt's spelling of a column's `dataType`, which core reads as an alias (#144). */
const DATA_TYPE_ALIAS = 'data_type';
/** Whether a pair's key is `key`, as a plain or scalar key. */
function keyIs(pair: Pair, key: string): boolean {
  return isScalar(pair.key) ? pair.key.value === key : pair.key === key;
}
/**
 * Set a parsed scalar's value in place, keeping its style and comments. The
 * `yaml` library keeps the text it parsed the node from in `source`, and
 * that text is what a number is read as (core's `scalarValue`, and this
 * service's), so it goes too: left behind, `scdType: &s 2` changed to 1 would
 * still read as 2 to this save while it prints 1.
 */
function setScalarValue(node: Scalar, value: unknown): void {
  node.value = value;
  node.source = undefined;
}
/** What core's reader fills in for a column key the file leaves out or leaves empty. */
const COLUMN_READ_DEFAULTS: Readonly<Record<string, unknown>> = { name: '', dataType: 'unknown' };
/**
 * The text each editable document was parsed from. The `yaml` library keeps
 * node offsets but not the source, and one question needs it: whether a key
 * that a write drops really had a blank line after it (see
 * {@link TableLibraryService.renameDataTypeAlias}).
 */
const SOURCE_TEXT = new WeakMap<Document, string>();
/**
 * Every alias a save in progress judged to read as the model already has it,
 * with a detached copy of what it read then (see
 * {@link TableLibraryService.confirmAliases}).
 */
const KEPT_ALIASES = new WeakMap<Document, Map<Alias, Node>>();
/** A line holding nothing but whitespace. */
const BLANK_LINE = /\n[ \t]*\r?\n/;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Where a refused write's file is, when the refusal knows it (#189): the
 * absolute path, and the 1-based line to put the cursor on. A command that
 * shows the refusal offers Open File with it.
 */
export interface RefusedFileLocation {
  filePath: string;
  line?: number;
}

/**
 * A model file's `relationships:` list that cannot be rewritten in place
 * (not a list, an alias, an entry the reader cannot use): the edit is refused,
 * naming file and line, rather than lose what is written there.
 */
export class RelationshipsRewriteRefused extends Error {
  readonly location?: RefusedFileLocation;

  constructor(message: string, location?: RefusedFileLocation) {
    super(message);
    this.name = 'RelationshipsRewriteRefused';
    if (location) this.location = location;
  }
}

/**
 * A model file that holds a key written twice (#164): it is read (the last
 * copy wins) but never written, because an in-place edit would change the
 * first copy, which nothing reads. The edit is refused, naming file and line.
 */
export class DuplicateKeyWriteRefused extends Error {
  readonly location?: RefusedFileLocation;

  constructor(message: string, location?: RefusedFileLocation) {
    super(message);
    this.name = 'DuplicateKeyWriteRefused';
    if (location) this.location = location;
  }
}

/**
 * A write to a table file that holds a key in both namings (#162) —
 * `modelRole` and `tableRole`, or a relationship's `toModel` and `toTable`.
 * Only the v6 one is read, so which one an edit should change is the
 * user's call: refused, by file and key.
 */
export class TableNamingWriteRefused extends Error {
  readonly location?: RefusedFileLocation;

  constructor(message: string, location?: RefusedFileLocation) {
    super(message);
    this.name = 'TableNamingWriteRefused';
    if (location) this.location = location;
  }
}

/** The v6 name of each table file key the naming renames (#162), at the root and in a relationship entry. */
const V6_TABLE_KEYS: Readonly<Record<string, string>> = { modelRole: 'tableRole' };
const V6_RELATIONSHIP_KEYS: Readonly<Record<string, string>> = { fromModel: 'fromTable', toModel: 'toTable' };

/** Each map whose keys the naming renames: the root, and every `relationships:` entry. */
function namingMaps(root: YAMLMap): Array<{ map: YAMLMap; keys: Readonly<Record<string, string>> }> {
  const maps = [{ map: root, keys: V6_TABLE_KEYS }];
  const relationships = root.items.find((pair) => keyIs(pair, 'relationships'))?.value;
  if (isSeq(relationships)) {
    for (const item of relationships.items) {
      if (isMap(item)) maps.push({ map: item, keys: V6_RELATIONSHIP_KEYS });
    }
  }
  return maps;
}

/** Whether a table file's root map uses a v6 key (#162): `tableRole`, or a relationship's `fromTable` / `toTable`. */
function usesTableNamingKeys(root: YAMLMap): boolean {
  return namingMaps(root).some(({ map, keys }) =>
    Object.values(keys).some((v6) => map.items.some((pair) => keyIs(pair, v6))));
}

/**
 * Rename the naming's keys of a table file in place (#182), keeping each
 * key's style and comments: `toV5` before a save edits it under the keys
 * this service manages, `toV6` after, so a v6 file is written in v6. Throws
 * {@link TableNamingWriteRefused} for a map holding a key in both namings.
 */
function renameNamingKeys(root: YAMLMap, direction: 'toV5' | 'toV6', file: string, filePath?: string): void {
  for (const { map, keys } of namingMaps(root)) {
    for (const [v5, v6] of Object.entries(keys)) {
      const [from, to] = direction === 'toV5' ? [v6, v5] : [v5, v6];
      const pair = map.items.find((p) => keyIs(p, from));
      if (!pair) continue;
      if (map.items.some((p) => keyIs(p, to))) {
        throw new TableNamingWriteRefused(
          `${file} holds both "${v5}" and "${v6}", so ERD Studio cannot tell which one to change. Remove "${v5}" (only "${v6}" is read), then try again.`,
          filePath ? { filePath } : undefined,
        );
      }
      if (isScalar(pair.key)) setScalarValue(pair.key, to);
      else pair.key = to;
    }
  }
}

export class TableLibraryService {
  private readonly tablesDir: string;
  /** v6's library folder (`tables/`, #162): read after `tablesDir`, never written. */
  private readonly v6TablesDir: string;
  private readonly semanticRoot: string;

  /**
   * In-memory parse cache keyed by file path. Each entry is validated against
   * the file's current mtime + size on read, so an external edit (or a change
   * missed by the watcher) is never served stale; invalidateCache() drops
   * entries eagerly when the logical-model watcher fires.
   */
  private readonly cache = new Map<string, CachedTable>();
  /** `.dbml` table files' readings, keyed by path and checked against mtime + size like {@link cache}. */
  private readonly dbmlCache = new Map<string, CachedDbmlTable>();
  /**
   * Every relationships file's reading (§5.1), keyed by path and checked
   * against mtime + size. Not part of a table's cache entry: a relationships
   * file changing needs no table re-read.
   */
  private readonly relationshipsCache = new Map<string, CachedRelationships>();
  /**
   * The last {@link libraryAttachment}, against two keys. `key`: every
   * relationships file's signature, the listed table files and
   * {@link tableCacheGeneration}. `quickKey`: the same relationships files,
   * `layers.json` and every library directory's own signature (a file added,
   * removed or renamed in a directory changes its mtime), with the
   * generation; checked first, with a few stats and no directory listing.
   */
  private attachMemo: {
    key: string;
    quickKey: string;
    relFiles: readonly string[];
    dirs: readonly string[];
    result: DbmlAttachResult;
  } | undefined;
  /**
   * Bumped whenever a table's cache entry changes (a file read anew, dropped,
   * or the caches invalidated), so {@link libraryAttachment} can tell that a
   * table it read changed without re-stat'ing the whole library on every
   * read: the memo is checked against the set of cache keys (§5.1).
   */
  private tableCacheGeneration = 0;
  /**
   * The mtime + size each `.yml` was last read at, whether it parsed or not
   * (a file that throws keeps no {@link cache} entry), so
   * {@link peekTableFileError} can tell a file read in this version from one
   * never read.
   */
  private readonly yamlReadSignatures = new Map<string, string>();
  /** DBML reader warnings already logged, by path and signature, so a refresh does not repeat them. */
  private readonly loggedDbmlProblems = new Set<string>();

  /**
   * Told when a model file exists but cannot be read or parsed, or was read
   * with a key written twice (`readable`, #164) — at most
   * **once per file path per session** (#113), even if the file is fixed and
   * breaks again (an AI assistant's edit loop does exactly that). The
   * extension host counts these for usage telemetry and warns the user; other
   * callers (the MCP server, the CLI) leave it unset and ask
   * {@link getTableFileError}, which always reflects the live state.
   */
  onParseFailure?: (error: TableFileError) => void;
  /**
   * Told each time a save is refused because a model file's `relationships:`
   * list cannot be rewritten in place ({@link RelationshipsRewriteRefused}).
   * Set by the extension host for usage telemetry; unset elsewhere.
   */
  onSyncRefused?: () => void;
  /** The last failure per file path, until the file reads cleanly again. */
  private readonly failedPaths = new Map<string, TableFileError>();
  /** Paths already reported to {@link onParseFailure}; never cleared in a session. */
  private readonly reportedPaths = new Set<string>();
  /**
   * While a pass over many aliases runs (see {@link withAliasTargets}), every
   * alias in the document mapped to the node its anchor names. `Alias.resolve`
   * walks the whole document on each call, so a file with thousands of aliases
   * made a save quadratic. Never held across a change to the document.
   */
  private aliasTargets: Map<Alias, Node | undefined> | null = null;
  /**
   * The name → file index of both library folders (`tableLibraryIndex.ts`):
   * every lookup, listing and "is `tables/` a layer?" answer comes from one
   * listing, re-validated by the directories' signatures on each use.
   */
  private readonly index: TableLibraryIndex;
  /**
   * Each table's attach fingerprint (what `attachRelationships` reads of it:
   * name, folder, storage, DBML alias, column names and keys), by the parsed
   * object the cache holds, so an unchanged table is not re-fingerprinted.
   */
  private readonly attachFingerprints = new WeakMap<object, string>();
  /**
   * While {@link readingTables} runs: the tables being read (lower-case
   * names) and, once worked out, the relationships they own
   * ({@link scopedAttachment}).
   */
  private memberScope: { keys: ReadonlySet<string>; computed: boolean; attachment?: DbmlAttachResult } | undefined;

  constructor(
    workspaceRoot: string,
    semanticDir = '.erd-studio',
    private readonly ownWriteTracker: OwnWriteTracker = ownWrites,
  ) {
    this.semanticRoot = path.join(workspaceRoot, semanticDir);
    this.tablesDir = path.join(this.semanticRoot, LOGICAL_MODELS_DIR);
    this.v6TablesDir = path.join(this.semanticRoot, TABLES_DIR);
    this.index = new TableLibraryIndex(this.semanticRoot, this.tablesDir, this.v6TablesDir);
  }

  /** How many times the library index was built (tests and benchmarks). */
  get indexBuilds(): number {
    return this.index.builds;
  }

  /** Whether the next lookup lists the library from scratch (no index yet, or a directory changed). */
  indexIsCold(): boolean {
    return this.index.isCold();
  }

  /** Whether `tables/` is a layer folder (`tablesDirIsLayer`), from the index. */
  tablesDirIsLayer(): boolean {
    return this.index.get().v6IsLayer;
  }

  /** Whether `tables/` is read as the v6 library (it exists and is not a layer folder). */
  hasTablesLibrary(): boolean {
    return this.index.get().v6IsLibrary;
  }

  /** Whether `filePath` is inside v6's `tables/` library (not a layer folder of that name), whose files are written in v6 (#182). */
  isTableNamingFile(filePath: string): boolean {
    const rel = path.relative(path.resolve(this.v6TablesDir), path.resolve(filePath));
    return !rel.startsWith('..') && !path.isAbsolute(rel) && !this.tablesDirIsLayer();
  }

  /**
   * Whether a shadowed `entry` is a copy, in another kind of library, of a
   * name an earlier library has: a `tables/` file shadowed by
   * `logical-models/` (#181, the naming migration's conflict), or a DBML
   * table shadowed by a YAML file (a project part-way through Convert).
   * Reported with "keep one of the two files", never renamed by Give
   * Duplicate Its Own Name. False for a duplicate within one library.
   */
  isCrossLibraryDuplicate(entry: Pick<TableFileEntry, 'shadowedBy' | 'library' | 'layer'>): boolean {
    if (entry.shadowedBy === undefined) return false;
    if (entry.layer !== undefined) return !/\.dbml$/i.test(entry.shadowedBy);
    return entry.library === TABLES_DIR && !this.isTableNamingFile(entry.shadowedBy);
  }

  /**
   * `logical-models/…` or `tables/…`: a library file's path as messages name
   * it, relative to the semantic dir with `/` separators.
   */
  libraryRelativePath(filePath: string): string {
    return path.relative(this.semanticRoot, filePath).split(path.sep).join('/');
  }

  /**
   * The library file holding `name`, relative to the semantic dir
   * (`logical-models/gold/x.yml`, `tables/x.yml`), or null when there is none
   * or the name is not path-safe.
   */
  tableLibraryFile(name: string): string | null {
    try {
      const filePath = this.findTableFile(name);
      return filePath === null ? null : this.libraryRelativePath(filePath);
    } catch {
      return null;
    }
  }

  /** Whether `logical-models/` holds a table file (an empty leftover folder says nothing, #182). */
  hasV5TableFiles(): boolean {
    return this.listTableFiles().some((e) => e.storage === 'yaml' && !e.library);
  }

  /** Whether `logical-models/` exists, empty or not. */
  hasV5Folder(): boolean {
    return this.index.get().v5Exists;
  }

  /**
   * Whether a new table file goes to `tables/` in the v6 naming (#182): the
   * project's naming (`projectNamingOf`) is `v6` — a new, empty project too —
   * or `mixed`. A v5 project keeps writing `logical-models/` until it migrates.
   */
  writesTableNaming(): boolean {
    // Read paths ask too (a missing table's would-be path), so a burst of
    // them scans the subject areas once; any write or invalidation re-asks.
    const now = Date.now();
    if (this.namingMemo === undefined || now - this.namingMemo.at > 1000) {
      this.namingMemo = { at: now, v6: writesTableNaming(projectNamingOf(this.semanticRoot, this)) };
    }
    return this.namingMemo.v6;
  }

  /** {@link writesTableNaming}'s last answer, briefly. */
  private namingMemo: { at: number; v6: boolean } | undefined;

  /**
   * The project's storage to write (§3.2): `projectStorageIn` over this
   * library and the project's diagrams, memoised briefly like
   * {@link writesTableNaming} and invalidated the same way. The one host
   * answer (`projectStorageOf`).
   */
  projectStorage(): ProjectStorage {
    const now = Date.now();
    if (this.storageMemo === undefined || now - this.storageMemo.at > 1000) {
      this.storageMemo = { at: now, storage: projectStorageIn(this.semanticRoot, this, this.tablesDirIsLayer()) };
    }
    return this.storageMemo.storage;
  }

  /** {@link projectStorage}'s last answer, briefly. */
  private storageMemo: { at: number; storage: ProjectStorage } | undefined;

  /**
   * Whether a NEW table file is written as DBML (§3.2, the one switch-over):
   * the project's storage is `dbml` (a new, empty project too) or `mixed`.
   * `projectStorage` already answers `yaml` when `tables/` is a layer.
   * An existing table always keeps its own format.
   */
  writesDbml(): boolean {
    return writesDbml(this.projectStorage());
  }

  /** The library new table files are created in (see {@link writesTableNaming}; a DBML project's is always `tables/`). */
  private newTablesDir(): string {
    if (this.writesDbml()) return this.v6TablesDir;
    return this.writesTableNaming() && !this.tablesDirIsLayer() ? this.v6TablesDir : this.tablesDir;
  }

  /** The folder name (`tables` or `logical-models`) new table files are created in, as sync plans report it. */
  newTableLibraryDirName(): string {
    return this.newTablesDir() === this.v6TablesDir ? TABLES_DIR : LOGICAL_MODELS_DIR;
  }

  /** Every table name with a file in both `logical-models/` and `tables/`, ignoring case. */
  tableNamingConflicts(): TableNamingConflict[] {
    return this.listTableFiles()
      .filter((e) => e.library === TABLES_DIR && e.shadowedBy !== undefined && !this.isTableNamingFile(e.shadowedBy))
      .map((e) => ({ name: e.name, kept: e.shadowedBy!, ignored: e.filePath }));
  }

  /**
   * Drop cached parses. Pass a model name to drop that table's entry only
   * ({@link invalidatePaths} of its file), or nothing to clear everything —
   * every parse, the attach memo and the library index (a bulk change on
   * disk, such as Convert or a migration).
   */
  invalidateCache(name?: string): void {
    if (name === undefined) {
      log.debug('[Table Library] Every cached table read dropped (a bulk change)');
      this.namingMemo = undefined;
      this.storageMemo = undefined;
      this.attachMemo = undefined;
      this.tableCacheGeneration++;
      this.cache.clear();
      this.dbmlCache.clear();
      this.relationshipsCache.clear();
      this.yamlReadSignatures.clear();
      this.index.invalidate();
      return;
    }
    this.invalidateTables([name]);
  }

  /**
   * {@link invalidateCache} of each of `names` (a watcher's batch of table
   * files changed outside ERD Studio), against one look at the library: the
   * names are resolved inside one index snapshot, then their files dropped
   * together, so the index is listed again at most once for the batch.
   * Resolving them one by one while the files are still changing (Edit >
   * Undo of Convert deleting 1,100) listed it again for every name.
   */
  invalidateTables(names: readonly string[]): void {
    if (names.length === 0) return;
    // An unsafe name was never cached (nothing was read for it), so there is
    // nothing to drop — and dropping a cache entry must never throw.
    const filePaths = this.index.withSnapshot(() => names.map((name) => this.resolveTablePath(name)));
    this.namingMemo = undefined;
    this.storageMemo = undefined;
    const found = filePaths.filter((p): p is string => p !== null);
    if (found.length > 0) this.invalidatePaths(found);
    if (found.length < filePaths.length) this.tableCacheGeneration++;
  }

  /**
   * Drop what is cached for exactly these files, after ERD Studio wrote,
   * created or deleted them (or a watcher saw them change): a table's parse
   * (which tells the attach memo to re-check, keeping its result when no
   * table's name, columns or keys changed), a relationships file's reading
   * (and the attach memo with it), and the library index when a file
   * appeared in or left the library. Anything else stays cached; the parse
   * caches are checked against mtime + size on every read regardless.
   */
  invalidatePaths(paths: Iterable<string>): void {
    this.namingMemo = undefined;
    this.storageMemo = undefined;
    const index = this.index.peek();
    let indexStale = false;
    for (const given of paths) {
      const resolved = path.resolve(given);
      let dropped = false;
      for (const key of new Set([given, resolved])) {
        if (this.cache.delete(key)) dropped = true;
        if (this.dbmlCache.delete(key)) dropped = true;
        this.yamlReadSignatures.delete(key);
        if (this.relationshipsCache.delete(key)) this.attachMemo = undefined;
      }
      const inLibrary = this.isLibraryPath(resolved);
      // A library file told to have changed always moves the generation, so
      // the attach memo re-checks its tables: one that did not read before
      // (and so had no cache entry to drop) may read now.
      if (dropped || inLibrary) this.tableCacheGeneration++;
      if (!inLibrary) continue;
      const kind = this.classifyLibraryFile(resolved).kind;
      if (kind === 'relationships') {
        this.attachMemo = undefined;
        if (index && index.relationshipsFiles.some((f) => path.resolve(f) === resolved) !== fs.existsSync(resolved)) indexStale = true;
      } else if (kind === 'table') {
        if (index && index.tableFiles.has(resolved) !== fs.existsSync(resolved)) indexStale = true;
      } else {
        // A folder, or a file that is neither: list the library again.
        indexStale = true;
      }
    }
    // The index re-validates itself by the directories' signatures; a write
    // in the same clock tick as its build could leave those unchanged.
    if (indexStale) this.index.invalidate();
  }

  /** List the library again on the next lookup (the parses stay cached; they are checked against mtime + size). */
  invalidateIndex(): void {
    this.namingMemo = undefined;
    this.storageMemo = undefined;
    this.index.invalidate();
  }

  /**
   * Whether `filePath` (absolute) is inside `logical-models/` or `tables/`,
   * or inside a DBML layer's `tables/` or `relationships/` folder.
   */
  private isLibraryPath(filePath: string): boolean {
    const inYaml = [this.tablesDir, this.v6TablesDir].some((dir) => {
      const rel = path.relative(path.resolve(dir), filePath);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (inYaml) return true;
    const rel = path.relative(path.resolve(this.semanticRoot), filePath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const segments = rel.split(path.sep);
    return segments.length >= 2 && isDbmlLayerName(segments[0]) && (segments[1] === TABLES_DIR || segments[1] === RELATIONSHIPS_DIR);
  }

  /** Drop every relationships file's cached reading (a relationships file changed on disk). */
  invalidateRelationships(): void {
    this.relationshipsCache.clear();
    this.attachMemo = undefined;
  }

  /**
   * Read + parse a YAML model file, serving from the cache when the file on
   * disk is unchanged. Returns a fresh deep copy so callers may mutate freely.
   * Returns null when the file is missing, empty, not a mapping, or has no
   * `name`; throws on read/parse failure.
   */
  private readTableFile(filePath: string, fallbackName: string, options: { clone?: boolean } = {}): SemanticTable | null {
    const clone = options.clone !== false;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      if (this.cache.delete(filePath)) this.tableCacheGeneration++;
      return null;
    }
    const signature = `${stat.mtimeMs}:${stat.size}`;
    const cached = this.cache.get(filePath);
    if (cached && cached.signature === signature) {
      return clone ? structuredClone(cached.model) : cached.model;
    }
    // The cache entry changes now whatever the read finds (a file that
    // throws keeps no entry), and only then: a file that stays broken does
    // not bump the generation on every read.
    if (this.cache.delete(filePath)) this.tableCacheGeneration++;
    // This version of the file has been read now, whatever the read finds (`peekTableFileError`).
    this.yamlReadSignatures.set(filePath, signature);
    const content = fs.readFileSync(filePath, 'utf-8');
    // A key written twice is read as dbt reads it, the last copy winning; the
    // model carries a loadWarning and writes are refused (loadEditableDocument).
    const model = parseTableText(content, fallbackName, { duplicateKeys: 'last' });
    if (!model) return null;
    const cachedModel = structuredClone(model);
    this.cache.set(filePath, { signature, model: cachedModel });
    this.tableCacheGeneration++;
    return clone ? model : cachedModel;
  }

  /**
   * The one place a table file is read (§5.1): a `.yml` through
   * {@link readTableFile}, a `.dbml` through core's `parseTableDbml`, both
   * cached against the file's mtime + size. A DBML table gets the
   * relationships it owns from the library's relationships files
   * ({@link libraryAttachment}), which are not part of its cache entry.
   * Returns a fresh copy; null when the file is missing; throws on a file
   * that cannot be read.
   */
  private readTableEntry(filePath: string, fallbackName: string, options: { relationships?: boolean } = {}): SemanticTable | null {
    if (!isDbmlFile(filePath)) return this.readTableFile(filePath, fallbackName);
    const reading = this.readDbmlTableFile(filePath);
    if (reading === null) return null;
    if (!reading.ok) throw dbmlReadingError(reading.error);
    const model = structuredClone(reading.table);
    if (options.relationships !== false) this.attachOwned(model, this.attachmentFor(model.name));
    return model;
  }

  /** Give a DBML table the relationships it owns in `attachment`. */
  private attachOwned(model: SemanticTable, attachment: DbmlAttachResult | undefined): void {
    const relationships = attachment?.byOwner.get(model.name.toLowerCase());
    if (relationships && relationships.length > 0) model.relationships = structuredClone(relationships);
  }

  /** A `.dbml` table file's reading, through {@link dbmlCache}; null when the file is gone. Never throws. */
  private readDbmlTableFile(filePath: string): DbmlTableReading | null {
    const signature = fileSignature(filePath);
    if (signature === null) {
      if (this.dbmlCache.delete(filePath)) this.tableCacheGeneration++;
      return null;
    }
    const cached = this.dbmlCache.get(filePath);
    if (cached && cached.signature === signature) return cached.reading;
    this.tableCacheGeneration++;
    let reading: DbmlTableReading;
    try {
      reading = parseTableDbml(fs.readFileSync(filePath, 'utf-8'), dbmlStem(path.basename(filePath)));
    } catch (err) {
      reading = { ok: false, error: { kind: 'read', message: err instanceof Error ? err.message : String(err) } };
    }
    this.dbmlCache.set(filePath, { signature, reading });
    if (reading.ok) this.logDbmlProblems(filePath, signature, reading.problems);
    return reading;
  }

  /** Log a DBML reader's warnings once per file version. */
  private logDbmlProblems(filePath: string, signature: string, problems: readonly DbmlProblem[]): void {
    if (problems.length === 0) return;
    const key = `${filePath}\0${signature}`;
    if (this.loggedDbmlProblems.has(key)) return;
    this.loggedDbmlProblems.add(key);
    for (const problem of problems) {
      log.warn(`[LogicalModelService] ${this.libraryRelativePath(filePath)}${problem.line !== undefined ? ` line ${problem.line}` : ''}: ${problem.message}`);
    }
  }

  /**
   * Every relationships file of the DBML library (`<layer>/relationships/*.dbml`
   * of every DBML layer folder), by path in byte order, from the index.
   */
  listRelationshipsFiles(): string[] {
    return [...this.index.get().relationshipsFiles];
  }

  /** A relationships file's reading, through {@link relationshipsCache}; null when it is gone. */
  readRelationshipsFile(filePath: string): DbmlRelationshipsReading | null {
    const signature = fileSignature(filePath);
    if (signature === null) {
      this.relationshipsCache.delete(filePath);
      return null;
    }
    const cached = this.relationshipsCache.get(filePath);
    if (cached && cached.signature === signature) return cached.reading;
    let reading: DbmlRelationshipsReading;
    try {
      reading = readRelationshipsDbml(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      reading = { readable: false, refs: [], problems: [{ severity: 'error', message: err instanceof Error ? err.message : String(err) }] };
    }
    this.relationshipsCache.set(filePath, { signature, reading });
    this.logDbmlProblems(filePath, signature, reading.problems);
    return reading;
  }

  /**
   * Run `fn`, which only reads, with `members` (a diagram's tables) in view:
   * the library index is checked once rather than on every lookup
   * (`TableLibraryIndex.withSnapshot`), and a member's relationships come
   * from the Refs that name the members ({@link scopedAttachment}) instead of
   * an attach over the whole library, so opening a diagram reads its own
   * tables, not every table file. Nothing inside `fn` may write.
   */
  readingTables<T>(members: Iterable<string>, fn: () => T): T {
    const outer = this.memberScope;
    this.memberScope = { keys: new Set([...members].map((m) => m.toLowerCase())), computed: false };
    try {
      return this.index.withSnapshot(fn);
    } finally {
      this.memberScope = outer;
    }
  }

  /** Run `fn`, which only reads, against one check of the library index (see {@link readingTables}). */
  withIndexSnapshot<T>(fn: () => T): T {
    return this.index.withSnapshot(fn);
  }

  /** Whether any table file of the library is YAML (listed, not read). */
  hasYamlTableFiles(): boolean {
    return this.index.get().entries.some((e) => e.storage === 'yaml');
  }

  /** The attachment `name`'s relationships come from: the scoped one for a member being read, else the whole library's. */
  private attachmentFor(name: string): DbmlAttachResult | undefined {
    const scope = this.memberScope;
    if (!scope || !scope.keys.has(name.toLowerCase())) return this.libraryAttachment();
    if (!scope.computed) {
      scope.attachment = this.scopedAttachment(scope.keys);
      scope.computed = true;
    }
    return scope.attachment;
  }

  /**
   * What the tables `keys` (lower-case names) own, as {@link libraryAttachment}
   * would attach it, from the Refs that name them (`memberAttachment`):
   * reads those tables and the other ends of their Refs, not the whole
   * library. The whole library's attachment instead when its memo is still
   * good (it costs a few stats then), when the library holds a YAML table (a
   * yml's own `name:` may differ from its file name, so a name cannot be
   * resolved from the listing), or when an end needs the whole library's
   * lookup (a dangling end, an alias, a file that does not read).
   */
  private scopedAttachment(keys: ReadonlySet<string>): DbmlAttachResult | undefined {
    const memo = this.attachMemo;
    if (memo && memo.quickKey === this.attachQuickKey(memo.relFiles, memo.dirs)) return memo.result;
    const relFiles = this.listRelationshipsFiles();
    if (relFiles.length === 0) return undefined;
    const entries = this.index.get().entries;
    if (entries.some((e) => !e.shadowedBy && e.storage !== 'dbml')) return this.libraryAttachment();
    const readings: Array<{ path: string; reading: DbmlRelationshipsReading }> = [];
    for (const filePath of relFiles) {
      const reading = this.readRelationshipsFile(filePath);
      if (reading !== null) readings.push({ path: this.libraryRelativePath(filePath), reading });
    }
    // As `dbmlTableLookup` resolves a name over the whole library: the first
    // unshadowed entry of that name (a `.dbml` stem equals its Table's name
    // but for case, D2), when its file reads.
    const byKey = new Map<string, TableFileEntry>();
    for (const entry of entries) {
      const key = entry.name.toLowerCase();
      if (!entry.shadowedBy && !byKey.has(key)) byKey.set(key, entry);
    }
    const resolved = new Map<string, DbmlAttachTable | undefined>();
    const resolve = (key: string): DbmlAttachTable | undefined => {
      if (resolved.has(key)) return resolved.get(key);
      const entry = byKey.get(key);
      const reading = entry ? this.readDbmlTableFile(entry.filePath) : null;
      const table: DbmlAttachTable | undefined = entry && reading?.ok && reading.table.name.toLowerCase() === key
        ? {
          table: { name: reading.table.name, columns: reading.table.columns },
          folder: entry.folder,
          storage: 'dbml',
          ...(reading.alias !== undefined ? { dbmlAlias: reading.alias } : {}),
        }
        : undefined;
      resolved.set(key, table);
      return table;
    };
    return memberAttachment(readings, keys, resolve) ?? this.libraryAttachment();
  }

  /**
   * One `attachRelationships` over every relationships file of the library
   * onto every table that reads (§2.4, §5.1): what each DBML table owns,
   * misplaced Refs included, duplicates removed, orphans reported. Memoised
   * against the signatures of every file it read, so it is recomputed at
   * call time when any of them changed. Undefined when the library has no
   * relationships file (no DBML table owns anything then).
   */
  libraryAttachment(): DbmlAttachResult | undefined {
    const memo = this.attachMemo;
    if (memo && memo.quickKey === this.attachQuickKey(memo.relFiles, memo.dirs)) return memo.result;
    const relFiles = this.listRelationshipsFiles();
    if (relFiles.length === 0) {
      this.attachMemo = undefined;
      return undefined;
    }
    const dirs = this.libraryDirs();
    const keyParts: string[] = [];
    const readings: Array<{ path: string; reading: DbmlRelationshipsReading }> = [];
    for (const filePath of relFiles) {
      const reading = this.readRelationshipsFile(filePath);
      if (reading === null) continue;
      keyParts.push(`${filePath}\0${this.relationshipsCache.get(filePath)?.signature ?? ''}`);
      readings.push({ path: this.libraryRelativePath(filePath), reading });
    }
    // The memo is checked against what attachRelationships reads of each
    // table (its fingerprint), not against the table's file: a table read
    // anew (the generation moved) whose name, columns and keys are what
    // they were — a description, a note, a position elsewhere — keeps the
    // result, and only the tables themselves are read (through the caches,
    // one stat each), never attached again (§7.6 budgets).
    const tables: DbmlAttachTable[] = [];
    for (const entry of this.listTableFiles()) {
      if (entry.shadowedBy) continue;
      let model: SemanticTable | null = null;
      let alias: string | undefined;
      try {
        if (entry.storage === 'dbml') {
          const reading = this.readDbmlTableFile(entry.filePath);
          if (reading?.ok) {
            model = reading.table;
            alias = reading.alias;
          }
        } else {
          model = this.readTableFile(entry.filePath, entry.name, { clone: false });
        }
      } catch {
        model = null;
      }
      if (!model) {
        keyParts.push(`${entry.filePath}\0-`);
        continue;
      }
      const table: DbmlAttachTable = {
        table: { name: model.name, columns: model.columns },
        folder: entry.folder,
        storage: entry.storage,
        ...(alias !== undefined ? { dbmlAlias: alias } : {}),
      };
      tables.push(table);
      keyParts.push(`${entry.filePath}\0${this.attachFingerprint(model, table)}`);
    }
    const key = keyParts.join('\n');
    if (memo && memo.key === key) {
      // Something listed or read anew changed nothing the attachment reads.
      this.attachMemo = { ...memo, relFiles, dirs, quickKey: this.attachQuickKey(relFiles, dirs) };
      return memo.result;
    }
    const result = attachRelationships(readings, dbmlTableLookup(tables));
    for (const warning of result.warnings) log.warn(`[LogicalModelService] ${warning}`);
    // Keyed after the reads above, which bump the generation for any table they found changed.
    this.attachMemo = { key, quickKey: this.attachQuickKey(relFiles, dirs), relFiles, dirs, result };
    return result;
  }

  /** What {@link libraryAttachment} reads of a table, as one string; cached by the parsed object. */
  private attachFingerprint(model: SemanticTable, table: DbmlAttachTable): string {
    const place = `${table.folder}\0${table.storage}\0${table.dbmlAlias ?? ''}`;
    let own = this.attachFingerprints.get(model);
    if (own === undefined) {
      own = [
        model.name,
        ...(model.columns ?? []).map((c) => c && typeof c === 'object'
          ? `${String(c.name)}\u0001${c.isPrimaryKey ? 1 : 0}${c.isNaturalKey ? 1 : 0}${(c as { dbtKey?: unknown }).dbtKey !== undefined ? JSON.stringify((c as { dbtKey?: unknown }).dbtKey) : ''}`
          : String(c)),
      ].join('\u0002');
      this.attachFingerprints.set(model, own);
    }
    return `${place}\0${own}`;
  }

  /**
   * Every directory whose listing {@link libraryAttachment} depends on: both
   * YAML libraries and their folders, the semantic dir and each DBML layer
   * folder (a new layer, `tables/` or `relationships/`), and each layer's
   * `tables/`, schema folders and `relationships/`.
   */
  private libraryDirs(): string[] {
    const index = this.index.get();
    return [
      this.tablesDir, ...index.v5Folders.map((f) => path.join(this.tablesDir, f)),
      this.v6TablesDir, ...index.v6Folders.map((f) => path.join(this.v6TablesDir, f)),
      this.semanticRoot,
      ...index.dbmlLayers.flatMap((l) => {
        const layerDir = path.join(this.semanticRoot, l.layer);
        const tablesDir = path.join(layerDir, TABLES_DIR);
        return [
          layerDir,
          ...(l.hasTables ? [tablesDir, ...l.schemas.map((schema) => path.join(tablesDir, schema))] : []),
          ...(l.hasRelationships ? [path.join(layerDir, RELATIONSHIPS_DIR)] : []),
        ];
      }),
    ];
  }

  /** {@link attachMemo}'s quick key: signatures only, no listing. */
  private attachQuickKey(relFiles: readonly string[], dirs: readonly string[]): string {
    const sig = (p: string): string => fileSignature(p) ?? '-';
    return [
      ...relFiles.map(sig),
      sig(path.join(this.semanticRoot, LAYERS_CONFIG_FILE)),
      ...dirs.map(sig),
      `#${this.tableCacheGeneration}`,
    ].join('\n');
  }

  /** How `name`'s file stores it: `yaml`, `dbml`, or undefined when there is no file (or the name is unsafe). */
  tableStorage(name: string): 'yaml' | 'dbml' | undefined {
    try {
      const filePath = this.findTableFile(name);
      return filePath === null ? undefined : isDbmlFile(filePath) ? 'dbml' : 'yaml';
    } catch {
      return undefined;
    }
  }

  /**
   * The relationships file that holds the Refs `tableName` owns, for a DBML
   * table (its folder's `_relationships.dbml`, which may not exist yet), else
   * undefined.
   */
  relationshipsFileFor(tableName: string): string | undefined {
    try {
      const filePath = this.findTableFile(tableName);
      if (filePath === null || !isDbmlFile(filePath)) return undefined;
      // The folder's relationships file as listed (any case, `_Relationships.dbml`), else the name a new one gets.
      const dir = path.dirname(filePath);
      return this.listRelationshipsFiles().find((f) => path.dirname(f).toLowerCase() === dir.toLowerCase())
        ?? path.join(dir, DBML_RELATIONSHIPS_FILE_NAME);
    } catch {
      return undefined;
    }
  }

  /** Whether the library holds a DBML table or a relationships file (`usesLibraryRelationships`' DBML clause, §5.1). */
  hasDbmlLibrary(): boolean {
    return this.listRelationshipsFiles().length > 0 || this.listTableFiles().some((e) => e.storage === 'dbml');
  }

  /** A path relative to the semantic dir, posix. */
  private semanticRelative(filePath: string): string {
    return path.relative(this.semanticRoot, filePath).split(path.sep).join('/');
  }

  /** An absolute path from one relative to the semantic dir. */
  semanticAbsolute(relPath: string): string {
    return path.join(this.semanticRoot, ...relPath.split('/'));
  }

  /**
   * What `planDbmlLibraryWrites` reads (§4.6): every listed table (winners)
   * with its real spelling, declared reference, columns and key; every
   * relationships file's reading; every table and relationships file path.
   * `readText` reads a file by absolute path (the editor passes one that
   * prefers an open document); by default the disk, byte-order mark stripped.
   */
  dbmlSnapshot(readText?: (filePath: string) => string | null): DbmlLibrarySnapshot {
    const tables = new Map<string, DbmlSnapshotTable>();
    const files = new Set<string>();
    for (const entry of this.listTableFiles()) {
      files.add(this.semanticRelative(entry.filePath));
      if (entry.shadowedBy) continue;
      let model: SemanticTable | null = null;
      let reference: string | undefined;
      let alias: string | undefined;
      try {
        if (entry.storage === 'dbml') {
          const reading = this.readDbmlTableFile(entry.filePath);
          if (reading?.ok) {
            model = reading.table;
            reference = reading.declaredReference;
            alias = reading.alias;
          }
        } else {
          model = this.readTableFile(entry.filePath, entry.name, { clone: false });
        }
      } catch {
        model = null;
      }
      const name = model?.name ?? entry.name;
      const columns = (model?.columns ?? []).map((c) => c.name);
      // A DBML table its file does not declare (it does not read) is spelled as its writer would: `<schema>.<name>`.
      const dbmlTree = entry.storage === 'dbml' && entry.layer !== undefined;
      const fallbackReference = dbmlTree ? `${dbmlName(entry.folder)}.${dbmlName(name)}` : dbmlName(name);
      tables.set(name.toLowerCase(), {
        name,
        reference: reference ?? fallbackReference,
        path: this.semanticRelative(entry.filePath),
        storage: entry.storage,
        folder: entry.folder,
        ...(dbmlTree ? { layer: entry.layer, schema: entry.folder } : {}),
        columns,
        primaryKey: (model?.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name),
        ...(alias !== undefined ? { dbmlAlias: alias } : {}),
      });
    }
    const relationshipsFiles = new Map<string, DbmlRelationshipsReading>();
    for (const filePath of this.listRelationshipsFiles()) {
      const reading = this.readRelationshipsFile(filePath);
      if (reading === null) continue;
      const rel = this.semanticRelative(filePath);
      relationshipsFiles.set(rel, reading);
      files.add(rel);
    }
    const read = readText ?? ((filePath: string): string | null => {
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch {
        return null;
      }
    });
    return {
      semanticDir: this.semanticRoot,
      tables,
      relationshipsFiles,
      files,
      readText: (rel) => {
        const text = read(this.semanticAbsolute(rel));
        return text === null ? null : text.replace(/^\uFEFF/, '');
      },
    };
  }

  /**
   * The table file writes for `ops` (§5.1), with absolute paths: YAML tables
   * as today (`serializeTable`, in place), DBML tables through
   * `planDbmlLibraryWrites`. A new table is DBML when `options.dbml` (it is
   * added through a DBML diagram, D20), else YAML. `plan` is set whenever a
   * DBML table is written, or `options.dbml` asks for the DBML resolver.
   */
  planTableWrites(
    ops: TableFileOps | undefined,
    layerFolder?: string,
    options: { dbml?: boolean; readText?: (filePath: string) => string | null } = {},
  ): { writes: FileWrite[]; plan?: DbmlLibraryWritePlan } {
    const writes: FileWrite[] = [];
    const dbmlOps: DbmlLibraryOps = { save: [], delete: [] };
    const storageOf = (name: string): 'yaml' | 'dbml' | undefined => this.tableStorage(name);
    for (const name of ops?.delete ?? []) {
      if (storageOf(name) === 'dbml') {
        dbmlOps.delete!.push(name);
        continue;
      }
      if (!this.tableExists(name)) continue;
      writes.push({ kind: 'delete', path: this.tablePath(name) });
    }
    for (const save of ops?.save ?? []) {
      const { model, fromName } = save;
      // A new table is DBML when it joins a DBML diagram (D20), or when the
      // project writes DBML (§3.2); an existing one keeps its format.
      const storage = storageOf(fromName ?? model.name) ?? (options.dbml || this.writesDbml() ? 'dbml' : 'yaml');
      if (storage === 'dbml') {
        dbmlOps.save!.push(save);
        continue;
      }
      // A renamed file stays in its own library and folder (#182).
      const renamed = fromName !== undefined && fromName !== model.name;
      const modelPath = renamed ? this.renamedTablePath(fromName, model.name) : this.tablePath(model.name, layerFolder);
      const text = this.serializeTable(model, fromName);
      writes.push(this.tableExists(model.name) ? { kind: 'replace', path: modelPath, text } : { kind: 'create', path: modelPath, text });
    }
    const anyDbml = dbmlOps.save!.length > 0 || dbmlOps.delete!.length > 0;
    if (!anyDbml && !options.dbml) return { writes };
    const plan = planDbmlLibraryWrites(this.dbmlSnapshot(options.readText), { ...dbmlOps, newTableFolder: this.dbmlNewTableFolder(layerFolder) });
    for (const w of plan.writes) writes.push({ ...w, path: this.semanticAbsolute(w.path) } as FileWrite);
    return { writes, plan };
  }

  /**
   * The DBML library folder a new table in `layerFolder` goes in: a folder
   * already on disk as it is spelled there (`Gold` for the layer `gold`),
   * else the layer when it is folder-shaped, else the top level (`''`).
   */
  private dbmlNewTableFolder(layerFolder: string | undefined): string {
    const listedFolder = layerFolder ? this.index.get().v6Folders.find((f) => f.toLowerCase() === layerFolder.toLowerCase()) : undefined;
    return listedFolder ?? (layerFolder && TABLE_FOLDER_PATTERN.test(layerFolder) ? layerFolder : '');
  }

  /**
   * `planDbmlLibraryWrites` over this library for any ops (moves included),
   * with absolute paths: Organise Table Library's moves (§5.7).
   */
  planDbmlLibraryOps(ops: DbmlLibraryOps, readText?: (filePath: string) => string | null): { writes: FileWrite[]; plan: DbmlLibraryWritePlan } {
    const plan = planDbmlLibraryWrites(this.dbmlSnapshot(readText), ops);
    return { writes: plan.writes.map((w) => ({ ...w, path: this.semanticAbsolute(w.path) }) as FileWrite), plan };
  }

  /**
   * Apply DBML library writes straight to disk (the non-editor paths), all
   * or nothing (`writeFilesWithRollback`), recording own writes and dropping
   * caches once the bytes land.
   */
  private applyDbmlOps(ops: DbmlLibraryOps): void {
    const plan = planDbmlLibraryWrites(this.dbmlSnapshot(), ops);
    writeFilesWithRollback(plan.writes.map((w) => ({ ...w, path: this.semanticAbsolute(w.path) }) as FileWrite), {
      onWritten: (filePath, kind) => {
        if (kind === 'delete') this.ownWriteTracker.recordDelete(filePath);
        else this.ownWriteTracker.recordWrite(filePath);
      },
    });
    this.invalidateCache();
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Returns the path to the logical-models directory.
   */
  getTablesDir(): string {
    return this.tablesDir;
  }

  /**
   * Whether the project has a table library folder: `logical-models/`, v6's
   * `tables/` (#182) when it is not a layer folder, or a DBML layer's
   * `tables/` (`<layer>/tables/`).
   */
  dirExists(): boolean {
    const index = this.index.get();
    return index.v5Exists || (index.v6Exists && !index.v6IsLayer) || index.dbmlLayers.some((l) => l.hasTables);
  }

  /**
   * Ensure the logical-models directory exists, creating it if necessary.
   * Pass a model file path (from {@link tablePath}) to create its layer
   * folder as well; a path outside the library is refused. A file of the
   * DBML tree creates its `<layer>/tables/<schema>/` or
   * `<layer>/relationships/` folder.
   */
  ensureDir(forFile?: string): void {
    const inside = (root: string, dir: string): boolean => {
      const rel = path.relative(root, dir);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    const target = forFile === undefined ? undefined : path.dirname(path.resolve(forFile));
    if (target !== undefined && this.isDbmlTreeDir(target)) {
      if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
      return;
    }
    // Either library (#182): a v6 project's files are created in `tables/`.
    const root = [this.tablesDir, this.v6TablesDir].map((d) => path.resolve(d)).find((d) => target !== undefined && inside(d, target))
      ?? path.resolve(this.newTablesDir());
    const dir = target ?? root;
    if (!inside(root, dir)) {
      throw new Error(`Refusing to create ${dir}: outside the Table Library.`);
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** Whether `dir` (absolute) is a folder of the DBML tree: `<layer>/tables/<schema>` or `<layer>/relationships`. */
  private isDbmlTreeDir(dir: string): boolean {
    const rel = path.relative(path.resolve(this.semanticRoot), dir);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const segments = rel.split(path.sep);
    if (!isDbmlLayerName(segments[0])) return false;
    return (segments.length === 3 && segments[1] === TABLES_DIR && isLibraryFolderName(segments[2]))
      || (segments.length === 2 && segments[1] === RELATIONSHIPS_DIR);
  }

  /**
   * The layer a new DBML table goes to when no diagram gives one (§2.4): the
   * first layer `layers.json` lists, else the first DBML layer folder on
   * disk (sorted), else `main`.
   */
  defaultDbmlLayer(): string {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(this.semanticRoot, LAYERS_CONFIG_FILE), 'utf-8')) as { layers?: unknown };
      if (Array.isArray(config.layers)) {
        for (const l of config.layers) {
          const id = !!l && typeof l === 'object' ? (l as { id?: unknown }).id : undefined;
          if (typeof id === 'string' && isDbmlLayerName(id)) return id;
        }
      }
    } catch {
      // No (readable) layers.json: the folders decide.
    }
    return this.index.get().dbmlLayers[0]?.layer ?? 'main';
  }

  /**
   * `schema` as `<layer>/tables/` lists it (§1.2 One spelling): an existing
   * schema folder that matches case-insensitively wins, else `schema` itself.
   */
  schemaAsListed(layer: string, schema: string): string {
    const listed = this.index.get().dbmlLayers.find((l) => l.layer === layer)?.schemas ?? [];
    return listed.find((s) => s === schema) ?? listed.find((s) => s.toLowerCase() === schema.toLowerCase()) ?? schema;
  }

  /**
   * Resolve a model name to its file path without throwing.
   *
   * Read paths must degrade rather than fail: a hand-edited or AI-written
   * domain file can reference a name that is not path-safe, and one bad entry
   * must show as one broken-reference node, not take down the whole canvas.
   * Write paths keep using {@link tablePath}, which throws.
   */
  resolveTablePath(name: string): string | null {
    try {
      return this.tablePath(name);
    } catch (err) {
      log.warn(`[LogicalModelService] Unsafe model name: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Check if a model file exists. An unsafe name has no file (and is never
   * looked up on disk), so this returns false rather than throwing.
   */
  tableExists(name: string): boolean {
    const filePath = this.resolveTablePath(name);
    return filePath !== null && fs.existsSync(filePath);
  }

  /**
   * The library's spelling of a model whose name matches `name` ignoring
   * case, or null when there is none. {@link tableExists} asks the file
   * system, which ignores case on macOS/Windows but not on Linux; this lists
   * the files, so `dimdate.yml` blocks a new `DimDate` on every platform —
   * the two would be one file on a teammate's Mac and one table in dbt.
   */
  findTableNameIgnoringCase(name: string): string | null {
    if (typeof name !== 'string') return null;
    return this.index.get().firstNameByKey.get(name.trim().toLowerCase()) ?? null;
  }

  /**
   * Read a single model from its YAML file.
   * Returns null if the name is not path-safe, or the file doesn't exist or is
   * invalid — callers render a broken-reference placeholder for null.
   */
  getTable(name: string): SemanticTable | null {
    const filePath = this.resolveTablePath(name);
    if (filePath === null) {
      return null;
    }
    try {
      const model = this.readTableEntry(filePath, name);
      const warning = model ? tableLoadWarningOf(model) : undefined;
      if (warning) {
        this.recordFailure(filePath, duplicateKeyFileError(name, filePath, warning), null);
      } else {
        this.failedPaths.delete(filePath);
      }
      return model;
    } catch (err) {
      this.recordFailure(filePath, describeTableFileError(name, filePath, err), err);
      return null;
    }
  }

  /** Remember why `filePath` is broken, and report it once per session. */
  private recordFailure(filePath: string, error: TableFileError, cause: unknown): void {
    // Once per broken file, not once per canvas refresh that re-reads it
    // (nor for getTableFileError's own re-read).
    const known = this.failedPaths.has(filePath);
    this.failedPaths.set(filePath, error);
    if (!known) {
      // Where, for the log reader: the file and, when the parser said, its line.
      const where = `${filePath}${error.line !== undefined ? `:${error.line}${error.column !== undefined ? `:${error.column}` : ''}` : ''}`;
      if (error.readable) {
        log.warn(`[LogicalModelService] ${where}: Model "${error.name}": ${error.message}`);
      } else {
        log.error(`[LogicalModelService] ${where}: Failed to read model "${error.name}":`, cause);
      }
      if (!this.reportedPaths.has(filePath)) {
        this.reportedPaths.add(filePath);
        this.onParseFailure?.(error);
      }
    }
  }

  /**
   * Why `name`'s file could not be read (or, with `readable`, what is wrong in
   * a file that was read), or null when it reads cleanly, is
   * missing, or its name is unsafe. Reads the file (through the cache), so the
   * answer is current — a file fixed since the last read reports null.
   */
  getTableFileError(name: string): TableFileError | null {
    const filePath = this.resolveTablePath(name);
    if (filePath === null || !fs.existsSync(filePath)) {
      return null;
    }
    // getTable's bookkeeping without its copy and relationships: only the
    // file's own reading decides whether it is broken.
    try {
      let model: SemanticTable | null;
      if (isDbmlFile(filePath)) {
        const reading = this.readDbmlTableFile(filePath);
        if (reading !== null && !reading.ok) throw dbmlReadingError(reading.error);
        model = reading?.ok ? reading.table : null;
      } else {
        model = this.readTableFile(filePath, name, { clone: false });
      }
      const warning = model ? tableLoadWarningOf(model) : undefined;
      if (warning) {
        this.recordFailure(filePath, duplicateKeyFileError(name, filePath, warning), null);
      } else {
        this.failedPaths.delete(filePath);
      }
    } catch (err) {
      this.recordFailure(filePath, describeTableFileError(name, filePath, err), err);
    }
    return this.failedPaths.get(filePath) ?? null;
  }

  /**
   * {@link getTableFileError} when the file has already been read in its
   * current version (the answer then costs a stat and the cache), else
   * undefined: the Table Library shows a large library at once and reads
   * the files it has not read yet afterwards, in the background.
   */
  peekTableFileError(name: string): TableFileError | null | undefined {
    const filePath = this.resolveTablePath(name);
    if (filePath === null) return null;
    const signature = fileSignature(filePath);
    if (signature === null) return null;
    const read = isDbmlFile(filePath)
      ? this.dbmlCache.get(filePath)?.signature === signature
      : this.yamlReadSignatures.get(filePath) === signature;
    return read ? this.getTableFileError(name) : undefined;
  }

  /**
   * Every model file in the library: the top level first, then each
   * one-level sub-folder in alphabetical order, files sorted by name inside
   * each. A name that appears more than once is flagged `shadowedBy` on every
   * copy but the first (the one {@link findTableFile} resolves to).
   * Dot-folders, deeper nesting and symlinked folders are not scanned.
   */
  listTableFiles(): TableFileEntry[] {
    return [...this.index.get().entries];
  }

  /**
   * What a file in the library is, by the single classifier (D10, §3.5):
   * its path relative to the semantic dir, with `tables/` read as the
   * library (callers list `tables/` only while it is one).
   */
  private classifyLibraryFile(filePath: string): ReturnType<typeof classifySemanticFile> {
    return classifySemanticFile(path.relative(this.semanticRoot, filePath).split(path.sep).join('/'), { tablesDirIsLayer: false });
  }

  /**
   * One-level sub-folders of logical-models/ that are scanned for models,
   * sorted alphabetically. Dot-folders (`.git`, editor state) are skipped.
   */
  listFolders(): string[] {
    return [...this.index.get().v5Folders];
  }

  /** A library's folders, from the index (either library) or a listing. */
  private listFoldersOf(dir: string): string[] {
    const resolved = path.resolve(dir);
    if (resolved === path.resolve(this.tablesDir)) return this.listFolders();
    if (resolved === path.resolve(this.v6TablesDir)) return [...this.index.get().v6Folders];
    return foldersOf(listDir(dir));
  }

  /**
   * Read all model files from the logical-models directory (top level and
   * one folder down). A shadowed duplicate is skipped, and so are files that
   * fail to parse.
   */
  listTables(): SemanticTable[] {
    const models: SemanticTable[] = [];
    const dbmlModels: SemanticTable[] = [];
    for (const entry of this.listTableFiles()) {
      if (entry.shadowedBy) continue;
      try {
        // The relationships are attached once below, not once per table.
        const model = this.readTableEntry(entry.filePath, entry.name, { relationships: false });
        if (model) {
          models.push(model);
          if (entry.storage === 'dbml') dbmlModels.push(model);
        }
      } catch {
        // Skip invalid files
      }
    }
    if (dbmlModels.length > 0) {
      const attachment = this.libraryAttachment();
      for (const model of dbmlModels) this.attachOwned(model, attachment);
    }
    return models;
  }

  /**
   * What the Add Existing Table dialog shows of each table in the library
   * (shadowed copies skipped, as {@link listTables} skips them), without
   * attaching relationships or copying the cached tables. A file not read in
   * its current version is read now — unless more than `readAtMost` are
   * unread: then each of those is only its file name and path, `pending`, and
   * none is read, so a diagram on a large library opens without reading
   * every table file. A file that does not read is left out, as
   * {@link listTables} leaves it out.
   */
  tablePreviews(options: { readAtMost?: number } = {}): TablePreview[] {
    const entries = this.index.get().entries.filter((e) => !e.shadowedBy);
    const unread = new Set(entries.filter((e) => !this.isReadNow(e.filePath)));
    const readUnread = unread.size <= (options.readAtMost ?? Infinity);
    const previews: TablePreview[] = [];
    for (const entry of entries) {
      if (!readUnread && unread.has(entry)) {
        previews.push({ name: entry.name, filePath: entry.filePath, schema: '', description: '', columnCount: 0, pending: true });
        continue;
      }
      let model: SemanticTable | null = null;
      try {
        if (entry.storage === 'dbml') {
          const reading = this.readDbmlTableFile(entry.filePath);
          model = reading?.ok ? reading.table : null;
        } else {
          model = this.readTableFile(entry.filePath, entry.name, { clone: false });
        }
      } catch {
        model = null;
      }
      if (!model) continue;
      previews.push({
        name: model.name,
        filePath: entry.filePath,
        schema: model.schema ?? '',
        description: model.description ?? '',
        columnCount: (model.columns ?? []).length,
      });
    }
    return previews;
  }

  /** The library's table files (shadowed copies skipped) not read in their current version. */
  unreadTableFiles(): TableFileEntry[] {
    return this.index.get().entries.filter((e) => !e.shadowedBy && !this.isReadNow(e.filePath));
  }

  /**
   * Read one table file into the cache, as a lookup would, without
   * relationships, a copy, or a report of a file that does not read (the
   * read that needs the table reports it). Never throws. For background
   * reads that make the next open of a diagram find its tables read.
   */
  warmTableFile(entry: Pick<TableFileEntry, 'filePath' | 'name' | 'storage'>): void {
    try {
      if (entry.storage === 'dbml') this.readDbmlTableFile(entry.filePath);
      else this.readTableFile(entry.filePath, entry.name, { clone: false });
    } catch {
      // Reported by the read that needs it.
    }
  }

  /**
   * Work out every relationship of the library once (`libraryAttachment`),
   * so the next edit of a table finds it worked out. Never throws.
   */
  warmLibraryAttachment(): void {
    try {
      if (this.index.get().entries.some((e) => e.storage === 'dbml')) this.libraryAttachment();
    } catch {
      // A relationships file that does not read is reported where it is used.
    }
  }

  /** Whether `filePath` was read (or found unreadable) in its current version. */
  private isReadNow(filePath: string): boolean {
    const signature = fileSignature(filePath);
    if (signature === null) return true;
    return isDbmlFile(filePath)
      ? this.dbmlCache.get(filePath)?.signature === signature
      : this.yamlReadSignatures.get(filePath) === signature;
  }

  /**
   * List model names (without reading full content), each once even when a
   * name is present in more than one folder.
   */
  listTableNames(): string[] {
    return this.listTableFiles().filter((e) => !e.shadowedBy).map((e) => e.name);
  }

  /**
   * Whether a model file that fails to parse still shows a non-empty
   * `relationships:` list, so a broken file cannot switch the project's
   * relationship mode (`usesLibraryRelationships`).
   */
  hasUnreadableRelationships(): boolean {
    // A relationships file that does not read holds Refs nobody can see (§4.3).
    if (this.listRelationshipsFiles().some((filePath) => this.readRelationshipsFile(filePath)?.readable === false)) return true;
    return this.listTableFiles().some((entry) => {
      // A `.dbml` table holds no relationships of its own (they are in relationships files).
      if (entry.shadowedBy || entry.storage === 'dbml') return false;
      try {
        this.readTableFile(entry.filePath, entry.name, { clone: false });
        return false;
      } catch {
        try { return RELATIONSHIPS_IN_TEXT.test(fs.readFileSync(entry.filePath, 'utf-8')); } catch { return false; }
      }
    });
  }

  /**
   * Whether new models should be created in layer folders. Folders are
   * opt-in per project: true once any model file lives in a LAYER folder
   * (someone ran "Organise Model Library by Layer", or organised by hand),
   * and for an empty library, which has no flat convention to keep. A flat
   * library stays flat — a new file in a folder would switch every teammate's
   * view to the grouped layout, and hide the model from anyone still on an
   * extension version that only reads the top level.
   *
   * `layerIds` (the layers in layers.json) keeps a hand-made folder such as
   * `Staging/` from counting as opting in. Without it any folder counts.
   */
  groupsByFolder(layerIds?: ReadonlySet<string>): boolean {
    const entries = this.listTableFiles();
    return entries.length === 0 ||
      entries.some((e) => e.folder !== '' && (layerIds === undefined || layerIds.has(e.folder)));
  }

  /**
   * The folder a model's file lives in: `''` for the top level, the folder
   * name for a file one level down, or null when there is no file.
   */
  tableFolder(name: string): string | null {
    const filePath = this.findTableFile(name);
    if (filePath === null) return null;
    const dir = path.dirname(filePath);
    return dir === path.resolve(this.tablesDir) || dir === path.resolve(this.v6TablesDir) ? '' : path.basename(dir);
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Save a model to its YAML file. Creates the file if it doesn't exist.
   *
   * When the file already exists it is edited in place: only the keys that
   * actually changed are touched, so comments, key order, unknown keys and
   * scalar styles that a user or AI agent put in the file survive UI edits.
   * (One caveat of the `yaml` Document API: folded `>` block scalars are
   * re-emitted on a single line — their value is unchanged.) A file that
   * fails to parse is rewritten from scratch.
   *
   * The write is atomic: content goes to a sibling temp file first and is then
   * renamed over the target, so a crash mid-write never leaves a truncated yml.
   *
   * Note: this bypasses VS Code's undo stack. Editor-driven mutations should
   * go through the SemanticEditorProvider's WorkspaceEdit path instead (which
   * uses `serializeTable()`), so the yml change is undoable together with the
   * domain change. Use this for non-editor callers (migration, seeding, CLI).
   */
  saveTable(model: SemanticTable, folder?: string): void {
    // A DBML table is spliced in place and its relationships placed in its
    // folder's file (§5.1); a new table in a project that writes DBML is
    // created as one (§3.2).
    const storage = this.tableStorage(model.name);
    if (storage === 'dbml' || (storage === undefined && this.writesDbml())) {
      this.applyDbmlOps({ save: [{ model }], newTableFolder: this.dbmlNewTableFolder(folder) });
      return;
    }
    const filePath = this.tablePath(model.name, folder);
    this.ensureDir(filePath);
    this.writeAtomic(filePath, this.renderTable(model, filePath));
  }

  /**
   * Serialize a model to the YAML text that `saveModel` would write, without
   * touching disk. Used by the editor to route yml writes through a
   * WorkspaceEdit so they share an undo step with the domain file change.
   * When the model file already exists on disk the text is produced by the
   * same in-place edit `saveModel` performs, so hand-written comments, key
   * order and unknown keys survive editor-driven saves too.
   *
   * `fromName` names the model file whose existing document supplies those
   * comments / key order / unknown keys. It exists for renames: the target
   * file does not exist yet, so without it the document would be regenerated
   * from scratch and everything hand-written in the old file would be lost.
   */
  serializeTable(model: SemanticTable, fromName?: string): string {
    return this.renderTable(model, this.tablePath(fromName ?? model.name));
  }

  /**
   * Like {@link serializeTable}, but the document that supplies comments, key
   * order and unknown keys is the file at `sourcePath`. Name lookups resolve to
   * the file that WINS a duplicated name, so the copy that is ignored can only
   * be addressed by its path.
   */
  serializeTableAt(model: SemanticTable, sourcePath: string): string {
    return this.renderTable(model, sourcePath);
  }

  /**
   * Produce the full YAML text for a model: the existing document at
   * `filePath` edited in place when it can be parsed, otherwise a fresh
   * document generated from the model. Line endings follow the file's own.
   */
  private renderTable(model: SemanticTable, filePath: string): string {
    // A `.dbml` table is never written as YAML: it is spliced by the DBML
    // writer (`planTableWrites`). Refused before anything is built.
    if (isDbmlFile(filePath)) throw new DbmlTableWriteRefused(undefined, filePath);
    const existing = this.loadEditableDocument(filePath);
    // A model read from a file with a key written twice is never written, even
    // when that key is `name:` and so points the write at another file (#164).
    const warning = tableLoadWarningOf(model);
    if (warning) {
      // No location: `loadEditableDocument` refuses `filePath` itself when it
      // holds the duplicate, so the warning's line is in another file (#189).
      throw new DuplicateKeyWriteRefused(
        `Can't change "${model.name}": ${warning.key ? `"${warning.key}"` : 'a key'} is written twice in one block of its table file ` +
          `(line ${warning.line}). Remove one copy, then try again.`,
      );
    }
    const doc = existing ?? new Document(this.tableToPlain(model));
    if (isMap(doc.contents)) {
      // A v6 file (#182) — in `tables/`, or using a v6 key — is edited under
      // the keys this service manages and written back in v6.
      const v6 = this.isTableNamingFile(filePath) || (existing !== null && usesTableNamingKeys(doc.contents));
      if (v6) renameNamingKeys(doc.contents, 'toV5', this.libraryRelativePath(filePath), filePath);
      this.applyTable(doc, doc.contents, model, filePath);
      if (v6) renameNamingKeys(doc.contents, 'toV6', this.libraryRelativePath(filePath), filePath);
    }
    return keepLineEndings(doc.toString(STRINGIFY_OPTIONS), this.readExisting(filePath));
  }

  /** The text of `filePath`, or undefined when there is none to read. */
  private readExisting(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  }

  /**
   * Atomically write `content` to `filePath` (temp file + rename), record it
   * as our own write so the logical-model watcher does not bounce it back as
   * an external change (which would trigger a second identical domainLoaded),
   * and drop what is cached for the path (the index too, when the file is new).
   */
  private writeAtomic(filePath: string, content: string): void {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
      throw err;
    }
    this.ownWriteTracker.recordWrite(filePath);
    // The watchers swallow our own writes, so the index is told here: on a
    // file system with whole-second times a create in the same second as the
    // last build leaves the directory's signature as it was.
    this.invalidatePaths([filePath]);
  }

  /**
   * Delete a model's YAML file.
   */
  deleteTable(name: string): void {
    const filePath = this.tablePath(name);
    if (isDbmlFile(filePath)) {
      // D16: the file, the Refs it owns and other DBML owners' Refs to it, in
      // one go. A YAML table's relationship to it stays in its yml, as a YAML
      // delete leaves it (the planner writes DBML tables only).
      this.applyDbmlOps(this.dbmlDeleteCascadeOps([name]));
      return;
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this.ownWriteTracker.recordDelete(filePath);
    }
    this.invalidatePaths([filePath]);
  }

  /**
   * The library half of Delete Table for DBML tables (D16), shared by the
   * canvas and every other caller so they cannot disagree: delete the
   * tables, and save each other DBML owner without its relationships to
   * them. A YAML owner keeps its relationship in its yml (the planner writes
   * DBML tables only), as deleting a YAML table leaves it today.
   */
  dbmlDeleteCascadeOps(names: readonly string[]): { delete: string[]; save: Array<{ model: SemanticTable }> } {
    const gone = new Set(names.map((n) => n.toLowerCase()));
    const saves: SemanticTable[] = [];
    for (const model of this.listTables()) {
      if (gone.has(model.name.toLowerCase()) || this.tableStorage(model.name) !== 'dbml') continue;
      let copy = model;
      for (const name of names) copy = dropRelationshipsTo([copy], name)[0] ?? copy;
      if (copy !== model) saves.push(copy);
    }
    return { delete: [...names], save: saves.map((model) => ({ model })) };
  }

  /**
   * Rename a model file and update the name field inside the YAML, carrying
   * the existing document (comments, key order, extra keys) across.
   * Throws if the target name already exists — a model file may be shared by
   * several domains, so it must never be silently overwritten. The renamed
   * file stays in the old file's folder.
   *
   * Like `saveModel`, this bypasses VS Code's undo stack, so it is for
   * non-editor callers. The editor renames through a WorkspaceEdit and gets
   * the same document carry-over via `serializeTable(model, fromName)`.
   */
  renameTable(oldName: string, newName: string): void {
    const model = this.getTable(oldName);
    if (!model) {
      throw new Error(`Table "${oldName}" not found in the Table Library`);
    }
    if (newName !== oldName && this.tableExists(newName)) {
      throw new Error(`Table "${newName}" already exists in the Table Library`);
    }
    if (this.tableStorage(oldName) === 'dbml') {
      // The file is renamed with its Table name spliced; every Ref naming it is re-spelled (§4.6).
      this.applyDbmlOps({ save: [{ model: { ...model, name: newName }, fromName: oldName }] });
      return;
    }
    // Carry the existing document (comments, key order, extra keys) across
    // to the new file rather than regenerating it from the parsed model.
    // The renamed file stays in the folder the old one was in.
    const oldPath = this.tablePath(oldName);
    const oldText = this.readExisting(oldPath);
    const doc = this.loadEditableDocument(oldPath);
    const target = this.renamedTablePath(oldName, newName);
    this.ensureDir(target);
    if (doc) {
      doc.set('name', newName);
      this.writeAtomic(target, keepLineEndings(doc.toString(STRINGIFY_OPTIONS), oldText));
    } else {
      // Regenerated, but with the old file's line endings.
      model.name = newName;
      this.writeAtomic(target, keepLineEndings(this.renderTable(model, target), oldText));
    }
    this.deleteTable(oldName);
  }

  // -------------------------------------------------------------------------
  // Seeding from manifest
  // -------------------------------------------------------------------------

  /**
   * Create a new logical model file seeded from manifest data.
   * Returns the created SemanticTable.
   * If the model file already exists, returns the existing model without overwriting.
   */
  createFromManifest(name: string, manifest: ManifestData, folder?: string): SemanticTable | null {
    if (this.tableExists(name)) {
      return this.getTable(name);
    }

    const manifestModel = manifest.models.get(name);
    if (!manifestModel) {
      return null;
    }

    const model = this.manifestToSemanticTable(manifestModel);
    this.saveTable(model, folder);
    return model;
  }

  /**
   * Create a new logical model file seeded from dbt .yml source data.
   * Returns true if the model was created, false if the yml model was not found.
   * If the model file already exists, returns true without overwriting.
   */
  createFromYml(name: string, ymlModel: YmlModelInfo, folder?: string): boolean {
    if (this.tableExists(name)) {
      return true;
    }

    this.saveTable(this.ymlToSemanticTable(ymlModel), folder);
    return true;
  }

  /**
   * Convert dbt .yml model info to a SemanticTable, without touching disk.
   * Used by `createFromYml` and by the editor, which seeds a new library file
   * through a WorkspaceEdit instead of writing it directly.
   */
  ymlToSemanticTable(ymlModel: YmlModelInfo): SemanticTable {
    const columns: ColumnDef[] = ymlModel.columns.map((col) => ({
      name: col.name,
      dataType: col.dataType ?? 'unknown',
      description: col.description ?? '',
    }));

    return {
      name: ymlModel.name,
      description: ymlModel.description,
      columns,
    };
  }

  // -------------------------------------------------------------------------
  // Conversion helpers
  // -------------------------------------------------------------------------

  /**
   * Convert manifest model info to a SemanticTable.
   * Columns get name, dataType, and description from manifest.
   * Design metadata (keys, SCD, etc.) are left unset for the user to fill in.
   */
  manifestToSemanticTable(manifestModel: ManifestModelInfo): SemanticTable {
    const columns: ColumnDef[] = manifestModel.columns.map((col) => ({
      name: col.name,
      dataType: col.data_type ?? 'unknown',
      description: col.description ?? '',
    }));

    return {
      name: manifestModel.name,
      schema: manifestModel.schema,
      description: manifestModel.description,
      columns,
    };
  }

  /**
   * Get the file path for a model: the file that already holds it (top level
   * first, then each folder alphabetically — see {@link findTableFile}), or,
   * when there is none, where a new one would be created — in
   * `logical-models/{folder}/` when `folder` is given and layer-shaped,
   * otherwise at the top level.
   *
   * The name is used verbatim as a file name, so anything that would resolve
   * outside `logical-models/` (path separators, `..`, absolute paths) is
   * rejected rather than silently written elsewhere in the workspace.
   */
  tablePath(name: string, folder?: string): string {
    return this.findTableFile(name) ?? this.newTablePath(name, folder);
  }

  /**
   * Where `fromName`'s file goes when it is renamed to `newName`: the same
   * library and folder (#182), so a rename in a mixed project never moves a
   * `logical-models/` file into `tables/`. Throws on an unsafe name.
   */
  renamedTablePath(fromName: string, newName: string): string {
    const from = this.findTableFile(fromName);
    if (from === null) return this.tablePath(newName);
    const existing = this.findTableFile(newName);
    if (existing !== null && path.resolve(existing) !== path.resolve(from)) return existing;
    const library = this.isTableNamingFile(from) ? this.v6TablesDir : this.tablesDir;
    return this.newTablePath(newName, this.tableFolder(fromName) || undefined, library);
  }

  /**
   * The path of the file that holds `name`, or null when no file does.
   * Throws on a name that is not path-safe (like {@link tablePath}).
   */
  findTableFile(name: string): string | null {
    // Throws on a name that is not path-safe.
    this.newTablePath(name, undefined, this.tablesDir);
    // §3.4's order, resolved from the directory listing (the index), never
    // with `existsSync` (which ignores case on macOS and Windows, so the
    // looked-up spelling would leak into paths): `logical-models/` top level
    // then folders, then `tables/` top level then folders, `.dbml` before
    // `.yml` in each. The listed file is returned (an exact spelling first,
    // then any case), so callers get the file's real name.
    return this.index.find(name);
  }

  /**
   * Where a new file for `name` goes. A `folder` that is neither layer-shaped
   * (see TABLE_FOLDER_PATTERN) nor an existing library folder is ignored and
   * the top level used instead. In a project that writes DBML (§3.2) the
   * file is `<layer>/tables/<schema>/<name>.dbml` (`dbmlTablePath`): `folder`
   * is the layer when it is a layer id, else {@link defaultDbmlLayer}, and
   * the schema is the layer's name as its `tables/` lists it.
   */
  private newTablePath(name: string, folder?: string, libraryDir?: string): string {
    if (typeof name !== 'string' || !name.trim() || name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error(`Invalid table name "${String(name)}": must not contain path separators.`);
    }
    // A renamed YAML file passes its own library and stays YAML.
    if (libraryDir === undefined && this.writesDbml()) {
      const layer = folder !== undefined && isDbmlLayerName(folder) ? folder : this.defaultDbmlLayer();
      return this.semanticAbsolute(dbmlTablePath(layer, this.schemaAsListed(layer, layer), name));
    }
    const ext = '.yml';
    const modelsDir = path.resolve(libraryDir ?? this.newTablesDir());
    const resolved = path.resolve(modelsDir, `${name}${ext}`);
    if (path.dirname(resolved) !== modelsDir) {
      throw new Error(`Invalid table name "${name}": resolves outside the Table Library.`);
    }
    // A layer-shaped name may be created; any folder already in the library
    // (listed by readdir, so it cannot hold a separator) may be written into —
    // that is what keeps a renamed file in a hand-made `Staging/` folder.
    if (folder) {
      const listed = this.listFoldersOf(modelsDir);
      const existing = listed.find((f) => f === folder);
      if (existing !== undefined) return path.join(modelsDir, existing, `${name}${ext}`);
      if (TableLibraryService.isTableFolderName(folder)) return path.join(modelsDir, folder, `${name}${ext}`);
    }
    return resolved;
  }

  /**
   * Where a new table file for `name` goes, for callers outside this service
   * such as sync plans and `diff`: `<layer>/tables/<schema>/<name>.dbml` when
   * the project writes DBML (§3.2; `folder` is the layer), else today's rule
   * (the library new files go to, `{folder}/` when given and allowed).
   * Throws on an unsafe name.
   */
  pathForNewTable(name: string, folder?: string): string {
    return this.newTablePath(name, folder);
  }

  /** Whether `folder` may be created under logical-models/ (the layer id format). */
  static isTableFolderName(folder: string): boolean {
    return TABLE_FOLDER_PATTERN.test(folder);
  }

  // -------------------------------------------------------------------------
  // YAML ↔ SemanticTable conversion
  // -------------------------------------------------------------------------

  /** Resolved value for strings/booleans/null; original source text for anything else. */
  private scalarValue(node: { value: unknown; source?: string }): unknown {
    const v = node.value;
    if (typeof v === 'string' || typeof v === 'boolean' || v === null || v === undefined) {
      return v ?? null;
    }
    return node.source ?? String(v);
  }

  /**
   * Parse an existing model file for in-place editing. Returns null when the
   * file is missing, malformed, or its root is not a mapping — callers then
   * fall back to regenerating the file. Throws {@link DuplicateKeyWriteRefused}
   * for a file whose only errors are keys written twice: it is read (so it is
   * on the canvas), and regenerating it would drop its comments and unknown
   * keys while editing it in place would change the copy nothing reads.
   */
  private loadEditableDocument(filePath: string): Document | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    let text: string;
    let doc: Document;
    try {
      text = fs.readFileSync(filePath, 'utf-8');
      doc = parseDocument(text, { customTags: keepNumberText });
    } catch (err) {
      log.warn(`[LogicalModelService] Rewriting unparseable model file ${filePath}:`, err);
      return null;
    }
    if (doc.errors.length > 0 && doc.errors.every((e) => e.code === 'DUPLICATE_KEY')) {
      throw this.duplicateKeyRefusal(filePath, text, doc.errors[0].linePos?.[0]?.line);
    }
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
      return null;
    }
    SOURCE_TEXT.set(doc, text);
    return doc;
  }

  /** The refusal for writing `filePath`, which holds a key written twice. */
  private duplicateKeyRefusal(filePath: string, text: string, fallbackLine: number | undefined): DuplicateKeyWriteRefused {
    let warning: { key: string; line: number } | undefined;
    try {
      const model = parseTableText(text, 'probe', { duplicateKeys: 'last' });
      warning = model ? tableLoadWarningOf(model) : undefined;
    } catch {
      // The refusal stands without the key's name.
    }
    const line = warning?.line ?? fallbackLine;
    const what = warning?.key ? `"${warning.key}" is written twice in one block` : 'a key is written twice in one block';
    return new DuplicateKeyWriteRefused(
      `${path.basename(filePath)}${line !== undefined ? `, line ${line}` : ''}: ${what}, so ERD Studio cannot change this file. ` +
        'Remove one copy, then try again.',
      { filePath, ...(line !== undefined ? { line } : {}) },
    );
  }

  /**
   * Apply a model onto an existing document, touching only managed keys
   * whose value differs. Keys ERD Studio does not know about are preserved.
   */
  private applyTable(doc: Document, root: YAMLMap, model: SemanticTable, filePath: string): void {
    const plain = this.tableToPlain(model);
    // Every alias starts out kept as it reads now — under a key ERD Studio
    // does not manage too (`x-note: *g`), and as a key (`*k: …`) — so none
    // follows an anchor this save rewrites or removes (#157). The sync below
    // re-keeps a managed alias as it judges it, or replaces it.
    const kept = new Map<Alias, Node>();
    this.withAliasTargets(doc, () => {
      visit(doc, { Alias: (_, alias) => { kept.set(alias, this.detach(doc, alias)); } });
    });
    KEPT_ALIASES.set(doc, kept);
    try {
      this.syncMap(doc, root, plain, TABLE_KEYS);
      this.syncRelationships(doc, root, (plain.relationships ?? []) as Record<string, unknown>[], filePath);
      this.settleKeptAliases(doc);
    } finally {
      KEPT_ALIASES.delete(doc);
    }
  }

  /**
   * Note every alias in `node` (itself, or anywhere inside a map or list) as
   * reading what the model wants, with a copy of what it reads now. Keys are
   * synced in a fixed order, not file order, so a later write may still
   * change the anchor such an alias points at — `description: *g` kept, then
   * `grain: &g` edited in place; {@link settleKeptAliases} undoes that.
   */
  private confirmAliases(doc: Document, node: unknown): void {
    const kept = KEPT_ALIASES.get(doc);
    if (!kept || !isNode(node)) return;
    if (isAlias(node)) {
      kept.set(node, this.detach(doc, node));
      return;
    }
    visit(node, {
      Alias: (key, alias) => {
        if (key !== 'key') kept.set(alias, this.detach(doc, alias));
      },
    });
  }

  /**
   * After every write of a save: a kept alias (see {@link confirmAliases} and
   * {@link applyTable}) that no longer reads what it read when it was kept —
   * its anchor was rewritten, or dropped, by this same save, or no longer
   * comes before it — becomes a plain copy of that value, keeping the line's
   * comments, so no key the canvas did not change reads differently and no
   * alias is left pointing at nothing. An alias whose anchor did not change
   * stays an alias.
   */
  private settleKeptAliases(doc: Document): void {
    const kept = KEPT_ALIASES.get(doc);
    if (!kept || kept.size === 0) return;
    const reads = (node: unknown): string => JSON.stringify(this.plainOf(doc, node)) ?? 'undefined';
    const changed = new Map<Alias, Node>();
    this.withAliasTargets(doc, (targets) => {
      for (const [alias, was] of kept) {
        if (!targets.has(alias)) continue; // replaced or removed by this save
        if (targets.get(alias) === undefined || reads(alias) !== reads(was)) changed.set(alias, was);
      }
    });
    if (changed.size === 0) return;
    visit(doc, {
      Alias: (_, alias) => {
        const was = changed.get(alias);
        return was ? this.withCommentsOf(alias, was) : undefined;
      },
    });
  }

  /**
   * Run `pass` with every alias of `doc` resolved up front, in one walk of the
   * document (see {@link aliasTargets}). `pass` must not change the document.
   */
  private withAliasTargets(doc: Document, pass: (targets: Map<Alias, Node | undefined>) => void): void {
    const targets = new Map<Alias, Node | undefined>();
    const anchors = new Map<string, Node>();
    // The rule `Alias.resolve` applies: the last node with that anchor before
    // the alias, in document order.
    visit(doc, {
      Node: (_, node) => {
        if (isAlias(node)) targets.set(node, anchors.get(node.source));
        else if (node.anchor) anchors.set(node.anchor, node);
      },
    });
    const outer = this.aliasTargets;
    this.aliasTargets = targets;
    try {
      pass(targets);
    } finally {
      this.aliasTargets = outer;
    }
  }

  /** The node `alias` points at, from {@link aliasTargets} while a pass has them. */
  private resolveAlias(doc: Document, alias: Alias): unknown {
    return this.aliasTargets?.has(alias) ? this.aliasTargets.get(alias) : alias.resolve(doc);
  }

  /**
   * A copy of what `node` reads as, sharing nothing with the document: aliases
   * resolved into copies, anchors and the top node's comments left out, and a
   * number keeps its source text (`007`), which it prints as in a document
   * parsed with {@link keepNumberText}. A self-referencing alias reads null.
   */
  private detach(doc: Document, node: unknown, top = true, path = new Set<unknown>()): Node {
    if (isAlias(node)) {
      const target = this.resolveAlias(doc, node);
      if (target === undefined || path.has(target)) return doc.createNode(null) as Node;
      return this.detach(doc, target, top, path);
    }
    let copy: Node;
    if (isScalar(node)) {
      copy = node.clone() as Scalar;
    } else if (isMap(node) || isSeq(node)) {
      path.add(node);
      const part = (n: unknown): unknown => (isNode(n) ? this.detach(doc, n, false, path) : n);
      if (isMap(node)) {
        const map = new YAMLMap();
        map.items = node.items.map((pair) => new Pair(part(pair.key), part(pair.value)));
        copy = map;
      } else {
        const seq = new YAMLSeq();
        seq.items = node.items.map((item) => (isPair(item) ? item.clone() : part(item)));
        copy = seq;
      }
      path.delete(node);
      (copy as YAMLMap | YAMLSeq).flow = node.flow;
      if (!top) {
        copy.commentBefore = node.commentBefore;
        copy.comment = node.comment;
      }
    } else {
      return doc.createNode(isNode(node) ? this.plainOf(doc, node) : node) as Node;
    }
    copy.anchor = undefined;
    if (top) {
      copy.comment = undefined;
      copy.commentBefore = undefined;
      copy.spaceBefore = undefined;
    }
    return copy;
  }

  /**
   * Bring `relationships:` in line with `desired` entry by entry. An entry the
   * reader skipped stays where it is; a kept entry keeps its node (comments,
   * unknown keys); an unchanged list is not touched at all.
   * A change ERD Studio cannot make in place is refused, naming file and line.
   */
  private syncRelationships(doc: Document, root: YAMLMap, desired: Record<string, unknown>[], filePath: string): void {
    const existing = root.get('relationships', true);
    if (existing === undefined || (isScalar(existing) && existing.value === null)) {
      if (desired.length > 0) root.set('relationships', doc.createNode(desired));
      return;
    }
    const list = isAlias(existing) ? existing.resolve(doc) : existing;
    const refuse = (node: unknown, why: string): Error => {
      const offset = isNode(node) ? node.range?.[0] ?? 0 : 0;
      const line = fs.readFileSync(filePath, 'utf-8').slice(0, offset).split('\n').length;
      const file = this.libraryRelativePath(filePath);
      this.onSyncRefused?.();
      return new RelationshipsRewriteRefused(
        `${file}, line ${line}: ${why}, so ERD Studio cannot change it. Fix it by hand first.`,
        { filePath, line },
      );
    };
    if (!isSeq(list)) {
      if (desired.length === 0) return; // nothing was read from it, so nothing changed
      throw refuse(existing, '"relationships:" is not a list');
    }
    const read = list.items.map((item) => this.readRelationshipEntry(doc, item));
    const same = (r: TableRelationship | null | undefined, want: Record<string, unknown>): boolean =>
      !!r && RELATIONSHIP_KEYS.every((k) => r[k] === want[k]);
    const claimed = new Set<number>();
    const claim = (i: number): number => (i === -1 ? i : (claimed.add(i), i));
    const matchOf = desired.map((want) => claim(read.findIndex((r, i) => !claimed.has(i) && same(r, want))));
    claimed.forEach((i) => this.confirmAliases(doc, list.items[i]));
    if (matchOf.every((i) => i !== -1) && read.every((r, i) => r === null || claimed.has(i))) {
      if (isAlias(existing)) this.confirmAliases(doc, existing);
      return;
    }
    const unknown = read.findIndex((r) => r === undefined);
    if (unknown !== -1) throw refuse(list.items[unknown], 'this relationship entry cannot be read');
    if (isAlias(existing)) throw refuse(existing, '"relationships:" is an alias of a list written elsewhere');

    // A changed entry keeps its node (comments, unknown keys): first one with
    // the same ends (a cardinality change), then — only when as many entries
    // changed as went, as in a column or model rename — the rest in order,
    // each only from an entry that shares one of its ends (a rename changes
    // one end; an unrelated link must not inherit another's comment or role).
    // Without case: an entry respelled to the real names (#133 L4) keeps its node.
    const sameEnds = (r: TableRelationship | null | undefined, want: Record<string, unknown>): boolean =>
      !!r && sameName(r.fromColumn, String(want.fromColumn)) && sameName(r.toModel, String(want.toModel))
      && sameName(r.toColumn, String(want.toColumn));
    const shareAnEnd = (r: TableRelationship | null | undefined, want: Record<string, unknown>): boolean =>
      !!r && (sameName(r.fromColumn, String(want.fromColumn))
        || (sameName(r.toModel, String(want.toModel)) && sameName(r.toColumn, String(want.toColumn))));
    const takeOver = (d: number, at: number): void => {
      const node = list.items[at];
      if (!isMap(node)) throw refuse(node, 'this relationship entry is not written out in full');
      // A field that reads the same is left as written: a missing (or unknown)
      // cardinality reads as many-to-one, and is not written out by a rename.
      const unchanged = new Set(RELATIONSHIP_KEYS.filter((k) => read[at]?.[k] === desired[d][k]));
      this.syncMap(doc, node, desired[d], RELATIONSHIP_KEYS, unchanged);
      matchOf[d] = claim(at);
    };
    matchOf.forEach((i, d) => {
      if (i !== -1) return;
      const at = read.findIndex((r, j) => !claimed.has(j) && sameEnds(r, desired[d]));
      if (at !== -1) takeOver(d, at);
    });
    const gone = read.flatMap((r, j) => (r && !claimed.has(j) ? [j] : []));
    const changed = matchOf.flatMap((i, d) => (i === -1 ? [d] : []));
    if (gone.length === changed.length) {
      changed.forEach((d, k) => { if (shareAnEnd(read[gone[k]], desired[d])) takeOver(d, gone[k]); });
    }

    const items = list.items.filter((_, i) => read[i] === null || claimed.has(i));
    desired.forEach((want, d) => { if (matchOf[d] === -1) items.push(doc.createNode(want)); });
    if (items.length === 0) {
      root.delete('relationships');
      return;
    }
    if (list.items.length === 0) list.flow = false; // `relationships: []` gains its first entry
    list.items = items;
  }

  /**
   * What the reader makes of one `relationships:` entry — null when it skips
   * it, undefined when that cannot be told. Read through core's own parser so
   * the answer is exactly what the canvas draws. The entry is copied with its
   * aliases resolved against this document: a plain copy took `role: *r`
   * along with no anchor to point at, so it never read, and every save of
   * the model was refused (#157).
   */
  private readRelationshipEntry(doc: Document, item: unknown): TableRelationship | null | undefined {
    try {
      const probe = new Document({ name: 'probe', relationships: [] }, { customTags: keepNumberText });
      (probe.get('relationships', true) as YAMLSeq).items.push(isNode(item) ? this.detach(doc, item) : item);
      return parseTableText(probe.toString(), 'probe')?.relationships?.[0] ?? null;
    } catch {
      return undefined;
    }
  }

  /**
   * Bring `map` in line with `desired` for the given managed keys:
   * absent keys are removed, unchanged keys are left alone (preserving
   * comments and scalar style), nested `rationale` maps and `columns`
   * sequences are merged recursively.
   */
  private syncMap(
    doc: Document,
    map: YAMLMap,
    desired: Record<string, unknown>,
    managedKeys: readonly string[],
    leaveAlone: ReadonlySet<string> = new Set(),
  ): void {
    for (const key of managedKeys) {
      if (leaveAlone.has(key)) {
        this.confirmAliases(doc, map.get(key, true));
        continue;
      }
      if (!(key in desired)) {
        if (map.has(key)) map.delete(key);
        continue;
      }
      const value = desired[key];
      const existing = map.get(key, true);

      if (isAlias(existing)) {
        // `key: *x` that already reads as `value` stays an alias, comments
        // and all; one that changed becomes the new value, keeping its comments.
        if (this.aliasReadsAs(doc, key, existing, value)) {
          this.confirmAliases(doc, existing);
          continue;
        }
        map.set(key, this.withCommentsOf(existing, doc.createNode(value) as Node));
        continue;
      }
      if (key === 'rationale' && isMap(existing) && value && typeof value === 'object' && !Array.isArray(value)) {
        this.syncMap(doc, existing, value as Record<string, unknown>, RATIONALE_KEYS);
        continue;
      }
      if (key === 'columns' && isSeq(existing) && Array.isArray(value)) {
        this.syncColumns(doc, existing, value as Record<string, unknown>[]);
        continue;
      }
      if (key === 'meta' && isMap(existing) && value && typeof value === 'object' && !Array.isArray(value)) {
        this.syncMeta(doc, existing, value as Record<string, unknown>);
        continue;
      }
      if (isScalar(existing)) {
        // Left exactly as written when core's reader already reads it as
        // `value`: `description: true` is the text "true", `name: 007` is
        // "007" (a number prints as its own text, see keepNumberText), so
        // neither is quoted by a save that did not change it (#157).
        if (existing.value === value || this.readsAs(key, this.scalarValue(existing), value)) continue;
        if (this.isScalarLike(value)) {
          setScalarValue(existing, value);
          continue;
        }
        // A plain value becoming a map or list keeps the line's comments.
        map.set(key, this.withCommentsOf(existing, doc.createNode(value) as Node));
        continue;
      }
      map.set(key, this.isScalarLike(value) ? value : doc.createNode(value));
    }
  }

  /**
   * Bring a `meta` map in line with `desired`. Unlike the managed keys, every
   * key here is the user's: a key missing from `desired` was removed, any
   * other is kept. A value whose text is unchanged is never touched — not
   * even re-pinned the way `syncMap` pins a coerced scalar — so `tier: 1`
   * stays an unquoted number and a nested map keeps its comments. Only a value
   * that really changed is replaced.
   */
  private syncMeta(doc: Document, map: YAMLMap, desired: Record<string, unknown>): void {
    // Keys are compared as the parser reads them (`2024:` is the key '2024'),
    // never through YAMLMap.get/set, whose strict match would miss a numeric or
    // boolean key and append a duplicate — which the next parse rejects.
    const keyOf = (pair: Pair): string =>
      isScalar(pair.key) ? String(this.scalarValue(pair.key)) : String(pair.key);
    const wanted = (key: string): boolean => Object.prototype.hasOwnProperty.call(desired, key);
    map.items = map.items.filter((pair) => wanted(keyOf(pair)));
    for (const [key, value] of Object.entries(desired)) {
      const pair = map.items.find((p) => keyOf(p) === key);
      if (!pair) {
        map.items.push(doc.createPair(key, value));
        continue;
      }
      if (this.sameMetaValue(doc, pair.value, value)) {
        this.confirmAliases(doc, pair.value);
        continue;
      }
      if (isScalar(pair.value) && this.isScalarLike(value)) {
        // Keep the node, and with it any trailing comment on the line.
        setScalarValue(pair.value, value);
      } else if (isAlias(pair.value) || isScalar(pair.value)) {
        pair.value = this.withCommentsOf(pair.value, doc.createNode(value) as Node);
      } else {
        pair.value = doc.createNode(value);
      }
    }
  }

  /**
   * Whether the alias `node`, the value of managed key `key`, already reads as
   * `value` — compared the way core's reader reads that key, so an unchanged
   * save leaves `dataType: *x # note` exactly as written. Text keys compare
   * as `String()` of the scalar's source (`str()`), flags by the reader's
   * `bool()`, `scdType` by `Number()`; a map or list (`meta`, `rationale`,
   * `columns`) is read through core's own parser on both sides. A value the
   * reader cannot see as the same is reported as changed, so it is written.
   */
  private aliasReadsAs(doc: Document, key: string, node: Alias, value: unknown): boolean {
    const target = node.resolve(doc);
    if (target === undefined) return false;
    if (value === null || value === undefined) return isScalar(target) && this.scalarValue(target) === null;
    if (typeof value === 'object') {
      const read = (v: unknown): string | undefined => {
        try {
          const probe = parseTableText(new Document({ name: 'probe', [key]: v }).toString(), 'probe');
          return JSON.stringify((probe as unknown as Record<string, unknown> | null)?.[key]);
        } catch {
          return undefined;
        }
      };
      const was = read(this.plainOf(doc, target));
      return was !== undefined && was === read(value);
    }
    return isScalar(target) && this.readsAs(key, this.scalarValue(target), value);
  }

  /**
   * Whether a scalar core's reader sees as `read` ({@link scalarValue}) reads
   * as the managed value `value` of `key`: text as `String()`, flags by the
   * reader's `bool()`, `scdType` by `Number()` — except a relationship
   * entry's keys, which the reader takes only as text (`role: true` is no
   * role at all), so they must be that very text. An empty value never does.
   */
  private readsAs(key: string, read: unknown, value: unknown): boolean {
    if (read === null || read === undefined) return false;
    if ((RELATIONSHIP_KEYS as readonly string[]).includes(key)) return read === value;
    if (typeof value === 'boolean') {
      return value === (read === true || (typeof read === 'string' && /^(true|yes|on)$/i.test(read.trim())));
    }
    if (typeof value === 'number') return Number(read) === value;
    return String(read) === String(value);
  }

  /**
   * A node tree as core's reader turns it into plain values: aliases resolved,
   * scalars as their source text, a raw `!!pairs` entry as its `String()`.
   */
  private plainOf(doc: Document, node: unknown, path = new Set<unknown>()): unknown {
    if (isAlias(node)) {
      const target = this.resolveAlias(doc, node);
      return path.has(target) ? null : this.plainOf(doc, target, path);
    }
    if (isMap(node)) {
      path.add(node);
      const obj: Record<string, unknown> = {};
      for (const pair of node.items) {
        Object.defineProperty(obj, String(this.plainOf(doc, pair.key, path)), {
          value: this.plainOf(doc, pair.value, path), enumerable: true, writable: true, configurable: true,
        });
      }
      path.delete(node);
      return obj;
    }
    if (isSeq(node)) {
      path.add(node);
      const items = node.items.map((item) => this.plainOf(doc, item, path));
      path.delete(node);
      return items;
    }
    if (isScalar(node)) return this.scalarValue(node);
    if (isPair(node)) return String(node);
    return node ?? null;
  }

  /** `node`, to stand in place of the alias or plain value `old`, carrying the line's comments. */
  private withCommentsOf(old: Alias | Scalar, node: Node): Node {
    if (isScalar(node)) {
      if (old.commentBefore) node.commentBefore = old.commentBefore;
      if (old.comment) node.comment = old.comment;
    } else {
      // A block map or list would print a trailing comment after its last
      // line; the line's comment goes first in the block instead.
      const lines = [old.commentBefore, old.comment].filter((c): c is string => Boolean(c));
      if (lines.length > 0) node.commentBefore = lines.join('\n');
    }
    if (old.spaceBefore) node.spaceBefore = true;
    return node;
  }

  /**
   * Whether a YAML node holds `value`, reading it the way the parser does:
   * scalars as their source text, an alias as what it points at (so `*shared`
   * is left an alias rather than expanded into a copy), and a raw `!!pairs`
   * entry as the text the model reads it as.
   */
  private sameMetaValue(doc: Document, node: unknown, value: unknown): boolean {
    if (isAlias(node)) return this.sameMetaValue(doc, node.resolve(doc), value);
    if (isPair(node)) return String(node) === value;
    if (isScalar(node)) return this.scalarValue(node) === (value ?? null);
    if (isMap(node)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const obj = value as Record<string, unknown>;
      if (node.items.length !== Object.keys(obj).length) return false;
      return node.items.every((pair) => {
        const key = isScalar(pair.key) ? String(this.scalarValue(pair.key)) : String(pair.key);
        return key in obj && this.sameMetaValue(doc, pair.value, obj[key]);
      });
    }
    if (isSeq(node)) {
      return Array.isArray(value)
        && node.items.length === value.length
        && node.items.every((item, i) => this.sameMetaValue(doc, item, value[i]));
    }
    return false;
  }

  /**
   * Merge desired columns into an existing sequence. Columns are matched by
   * name (falling back to position for renames) so per-column comments and
   * unknown keys follow the column; order follows the model.
   */
  private syncColumns(doc: Document, seq: YAMLSeq, desired: Record<string, unknown>[]): void {
    const existing: (YAMLMap | null)[] = seq.items.map((item) => (isMap(item) ? item : null));
    const claimed = new Set<number>();

    const nameOf = (item: YAMLMap): string | undefined => {
      const nameNode = item.get('name', true);
      if (isScalar(nameNode)) {
        const v = this.scalarValue(nameNode);
        return v === null ? undefined : String(v);
      }
      return nameNode === undefined || nameNode === null ? undefined : String(nameNode);
    };

    // Pass 1: match by name.
    const matches: (YAMLMap | null)[] = desired.map((col) => {
      const idx = existing.findIndex((item, i) => item !== null && !claimed.has(i) && nameOf(item) === String(col.name));
      if (idx === -1) return null;
      claimed.add(idx);
      return existing[idx];
    });

    // Pass 2: unmatched desired columns reuse an unclaimed existing node at
    // the same position (a rename keeps its comments).
    desired.forEach((_, i) => {
      if (matches[i] !== null) return;
      const candidate = existing[i];
      if (candidate && !claimed.has(i)) {
        claimed.add(i);
        matches[i] = candidate;
      }
    });

    seq.items = desired.map((col, i) => {
      const node = matches[i];
      if (node) {
        this.renameDataTypeAlias(doc, node);
        const leaveAlone = this.readDefaultsLeftOut(doc, node, col);
        if (this.dataTypeAliasFate(doc, node) === 'anchored') {
          leaveAlone.add('dataType');
          this.syncKeptDataType(doc, node, col);
        }
        this.syncMap(doc, node, col, COLUMN_KEYS, leaveAlone);
        return node;
      }
      return doc.createNode(col);
    });
  }

  /**
   * Turn dbt's `data_type:` into `dataType:` on a column whose type the reader
   * takes from `data_type` (#144) — see {@link dataTypeAliasFate}. Renaming
   * the key where it stands — same position, value, style and comments — is
   * what lets the sync that follows find the type it is about to write
   * instead of adding a second key beside it. An empty `dataType:` beside it
   * holds nothing, so it gives way, and every comment on it moves to the
   * renamed key: see {@link foldEmptyDataType}. A `data_type` next to a
   * `dataType` that holds a value is left alone: the reader ignores it, and
   * it is the user's.
   */
  private renameDataTypeAlias(doc: Document, node: YAMLMap): void {
    if (this.dataTypeAliasFate(doc, node) !== 'rename') return;
    const pair = node.items.find((p) => keyIs(p, DATA_TYPE_ALIAS))!;
    if (!isScalar(pair.key)) pair.key = doc.createNode(pair.key);
    const empty = node.items.findIndex((p) => keyIs(p, 'dataType'));
    if (empty !== -1) this.foldEmptyDataType(doc, node, empty, pair);
    setScalarValue(pair.key as Scalar, 'dataType');
  }

  /**
   * Drop the empty `dataType:` at `node.items[index]` in favour of `pair`
   * (the `data_type` about to be renamed), keeping every comment either key
   * carried. The dropped key's come first, then the renamed key's own: they
   * all become comment lines above the renamed key, except that the dropped
   * key's one-line trailing comment (`dataType: # TODO`) stays on the line
   * when the renamed key has none of its own.
   *
   * The `yaml` library hands an empty value every comment line below it, up
   * to the next key (`# about data_type` above `data_type:` is stored on the
   * empty `dataType:`), and then marks that next key as having a blank line
   * before it whether or not there was one. So the key that follows the
   * dropped one gets a blank line only when the file had one there, read
   * from the source text.
   */
  private foldEmptyDataType(doc: Document, node: YAMLMap, index: number, pair: Pair): void {
    const [gone] = node.items.splice(index, 1);
    const commentsOf = (n: unknown): { before?: string; trailing?: string } =>
      isNode(n) ? { before: n.commentBefore ?? undefined, trailing: n.comment ?? undefined } : {};
    const goneKey = commentsOf(gone.key);
    const goneValue = commentsOf(gone.value);
    const key = pair.key as Scalar;
    const lines: (string | undefined)[] = [goneKey.before, goneKey.trailing, goneValue.before];
    let trailing = goneValue.trailing;
    // Only a comment written on the dropped key's own line (`dataType: # TODO`)
    // can stay on the line; one on a line of its own below it stays a line.
    const source = SOURCE_TEXT.get(doc);
    const valueRange = isNode(gone.value) ? gone.value.range : undefined;
    const onKeyLine = source === undefined || !valueRange
      || !/^[ \t]*\r?\n/.test(source.slice(valueRange[0], valueRange[2]));
    if (trailing !== undefined && !trailing.includes('\n') && onKeyLine && isNode(pair.value) && !pair.value.comment) {
      pair.value.comment = trailing;
      trailing = undefined;
    }
    lines.push(trailing, key.commentBefore ?? undefined);
    const merged = lines.filter((line): line is string => line !== undefined && line !== '');
    if (merged.length > 0) key.commentBefore = merged.join('\n');

    // The key now first after the dropped one's place, if any.
    const next = node.items[index];
    if (!next || !isScalar(next.key)) return;
    const from = isScalar(gone.key) ? gone.key.range?.[0] : undefined;
    const to = next.key.range?.[0];
    const blankInside = source !== undefined && from !== undefined && to !== undefined
      ? BLANK_LINE.test(source.slice(from, to))
      : Boolean(next.key.spaceBefore) && !goneValue.trailing;
    next.key.spaceBefore = (isScalar(gone.key) && gone.key.spaceBefore) || blankInside || undefined;
  }

  /**
   * What a write of this column does with its `data_type:` key (#144) — the
   * one rule {@link renameDataTypeAlias} and doctor share, matching core's
   * reader (`dataType` read as a plain value, aliases resolved, else
   * `data_type`): `'rename'` when the reader takes the type from it (no
   * `dataType`, or an empty one — also an alias of an empty value), `'ignored'`
   * when a `dataType` holding a value (even `''`) wins and the key is kept as
   * written, null with no `data_type`.
   *
   * `'anchored'` is a `'rename'` that would touch a YAML anchor: the empty
   * `dataType` (its key or its value) or the `data_type` key carries one
   * (`dataType: &x`). Dropping that node leaves every `*x` pointing at
   * nothing, so the file stops parsing; renaming the anchored key renames
   * every `*k:` key too; and writing the type into the empty anchored value
   * would retype every column that says `*x`. So both keys stay exactly as
   * written and the type is kept in `data_type`, where the reader already
   * takes it from ({@link syncKeptDataType}) — no column reads differently.
   */
  private dataTypeAliasFate(doc: Document, node: YAMLMap): 'rename' | 'ignored' | 'anchored' | null {
    const alias = node.items.find((p) => keyIs(p, DATA_TYPE_ALIAS));
    if (!alias) return null;
    const own = node.items.find((p) => keyIs(p, 'dataType'));
    const value = own && isAlias(own.value) ? own.value.resolve(doc) : own?.value;
    const empty = value === null || value === undefined || (isScalar(value) && value.value === null);
    if (!empty) return 'ignored';
    const anchored = (n: unknown): boolean => isNode(n) && !isAlias(n) && Boolean(n.anchor);
    return anchored(alias.key) || (own !== undefined && (anchored(own.key) || anchored(own.value))) ? 'anchored' : 'rename';
  }

  /**
   * Write `desired.dataType` into the `data_type` of an `'anchored'` column
   * (see {@link dataTypeAliasFate}) — the key the reader takes it from — and
   * only when it reads differently, so a save that changes nothing leaves the
   * file byte-identical. A type the reader would fill in anyway (`unknown`
   * over an empty `data_type`) is not written.
   */
  private syncKeptDataType(doc: Document, node: YAMLMap, desired: Record<string, unknown>): void {
    if (!('dataType' in desired)) return;
    const wanted = desired.dataType;
    const raw = node.get(DATA_TYPE_ALIAS, true);
    const existing = isAlias(raw) ? raw.resolve(doc) : raw;
    const read = isScalar(existing) ? this.scalarValue(existing) : existing;
    if (isNode(read)) return; // a list or map: the user's, never overwritten
    if (read === null || read === undefined ? wanted === COLUMN_READ_DEFAULTS.dataType : String(read) === String(wanted)) {
      this.confirmAliases(doc, raw);
      return;
    }
    this.syncMap(doc, node, { [DATA_TYPE_ALIAS]: wanted }, [DATA_TYPE_ALIAS]);
  }

  /**
   * The columns of `name`'s file that spell their type dbt's way
   * (`data_type:`), in file order (#144); `erd-studio doctor` lists them.
   * Read from the same YAML document a write edits: `columns` are the keys
   * {@link renameDataTypeAlias} renames the next time ERD Studio writes this
   * file, `ignored` the `data_type` keys beside a `dataType` that wins (kept
   * as written, so they stay listed until the user deletes them), `anchored`
   * the `data_type` keys a write keeps because renaming would touch a YAML
   * anchor (see {@link dataTypeAliasFate}). All empty for a missing,
   * unparseable or unsafe file — those are reported elsewhere.
   */
  dataTypeAliasColumns(name: string): { columns: string[]; ignored: string[]; anchored: string[] } {
    const found = { columns: [] as string[], ignored: [] as string[], anchored: [] as string[] };
    const filePath = this.resolveTablePath(name);
    // `data_type:` is a YAML spelling; a `.dbml` table has none.
    if (filePath !== null && isDbmlFile(filePath)) return found;
    let doc: Document | null;
    try {
      doc = filePath === null ? null : this.loadEditableDocument(filePath);
    } catch {
      return found; // a key written twice: reported elsewhere
    }
    if (!doc || !isMap(doc.contents)) return found;
    const resolve = (node: unknown): unknown => (isAlias(node) ? node.resolve(doc) : node);
    const columns = resolve(doc.contents.get('columns', true));
    if (!isSeq(columns)) return found;
    columns.items.forEach((item, i) => {
      const col = resolve(item);
      const fate = isMap(col) ? this.dataTypeAliasFate(doc, col) : null;
      if (!isMap(col) || fate === null) return;
      const nameNode = col.get('name', true);
      const value = isScalar(nameNode) ? this.scalarValue(nameNode) : nameNode;
      const label = value === undefined || value === null || value === '' ? `#${i + 1}` : String(value);
      ({ rename: found.columns, ignored: found.ignored, anchored: found.anchored })[fate].push(label);
    });
    return found;
  }

  /**
   * Keys `node` leaves out (or empty) whose desired value is only what the
   * reader fills in for them — `dataType: unknown` for a column with no type.
   * A save leaves those alone, so it never adds a default nobody typed. An
   * alias is read through, as the reader does, so `dataType: *x` of an empty
   * anchor stays an alias rather than turning into `unknown`.
   */
  private readDefaultsLeftOut(doc: Document, node: YAMLMap, desired: Record<string, unknown>): Set<string> {
    const keys = new Set<string>();
    for (const [key, fallback] of Object.entries(COLUMN_READ_DEFAULTS)) {
      const raw = node.get(key, true);
      const existing = isAlias(raw) ? raw.resolve(doc) : raw;
      const empty = existing === undefined || existing === null || (isScalar(existing) && existing.value === null);
      if (empty && desired[key] === fallback) keys.add(key);
    }
    return keys;
  }

  private isScalarLike(value: unknown): boolean {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
  }

  /**
   * Build a clean plain object for serialisation, omitting undefined/empty
   * fields. Key order here defines the order used for new files.
   */
  private tableToPlain(model: SemanticTable): Record<string, unknown> {
    const obj: Record<string, unknown> = { name: model.name };

    if (model.schema) obj.schema = model.schema;
    if (model.alias) obj.alias = model.alias;
    if (model.description) obj.description = model.description;
    if (model.grain) obj.grain = model.grain;
    if (model.modelRole) obj.modelRole = model.modelRole;

    if (model.rationale) {
      const rat: Record<string, string> = {};
      if (model.rationale.purpose) rat.purpose = model.rationale.purpose;
      if (model.rationale.design) rat.design = model.rationale.design;
      if (model.rationale.grainChoice) rat.grainChoice = model.rationale.grainChoice;
      if (model.rationale.roleChoice) rat.roleChoice = model.rationale.roleChoice;
      if (model.rationale.scdStrategy) rat.scdStrategy = model.rationale.scdStrategy;
      if (model.rationale.measures) rat.measures = model.rationale.measures;
      if (Object.keys(rat).length > 0) obj.rationale = rat;
    }

    if (model.meta && Object.keys(model.meta).length > 0) obj.meta = model.meta;

    if (model.columns && model.columns.length > 0) {
      obj.columns = model.columns.map((col) => {
        const yamlCol: Record<string, unknown> = {
          name: col.name,
          dataType: col.dataType,
        };
        if (col.description) yamlCol.description = col.description;
        if (col.isPrimaryKey) yamlCol.isPrimaryKey = true;
        if (col.isForeignKey) yamlCol.isForeignKey = true;
        if (col.isNaturalKey) yamlCol.isNaturalKey = true;
        if (col.scdType !== undefined) yamlCol.scdType = col.scdType;
        if (col.additiveType) yamlCol.additiveType = col.additiveType;
        if (col.meta && Object.keys(col.meta).length > 0) yamlCol.meta = col.meta;
        return yamlCol;
      });
    }

    if (model.relationships && model.relationships.length > 0) {
      obj.relationships = model.relationships.map((rel) => ({
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        cardinality: rel.cardinality,
        ...(rel.role ? { role: rel.role } : {}),
        ...(rel.compositeKey ? { compositeKey: rel.compositeKey } : {}),
      }));
    }

    return obj;
  }
}
