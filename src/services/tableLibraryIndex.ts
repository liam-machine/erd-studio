/**
 * The table library's name → file index: one listing of `logical-models/`
 * and `tables/` (the YAML libraries: the top level and one folder down) and
 * of the layer-first DBML tree (`<layer>/tables/<schema>/` and
 * `<layer>/relationships/` of every DBML layer folder), from which every
 * lookup `TableLibraryService` makes is answered without touching the disk
 * again — which file holds a name (§3.4's order), every table file with its
 * folder, storage and duplicates (`listTableFiles`), the relationships
 * files, the library folders, and whether `tables/` is a layer.
 *
 * Self-validating: the index keeps the signature (inode, mtime, size) of
 * every directory it listed, of each DBML layer folder (so a later
 * `mkdir <layer>/tables` is seen) and of `layers.json`, taken just before
 * each was read. A file added, removed or renamed in a library directory
 * changes that directory's mtime, so a lookup re-stats that handful of paths
 * and rebuilds the index when any differs — an AI assistant writing files, a
 * `git checkout` or another window is seen without any watcher event. A
 * directory changed within {@link RACY_MS} of a build ({@link COARSE_RACY_MS}
 * on a whole-second file system) is "racy" (a file system's clock may give
 * two changes in one tick the same mtime), and the index is rebuilt on its
 * next use until no directory is ({@link isRacyBuild}).
 *
 * Listing cost: the semantic dir once; a library folder only when it exists
 * (a `stat` says so), so a YAML project lists no DBML folder and a DBML
 * project lists `1 + layers × (2 + schemas)` directories.
 *
 * No `vscode`: the CLI bundles it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LAYERS_CONFIG_FILE, LOGICAL_MODELS_DIR, RELATIONSHIPS_DIR, TABLES_DIR, classifySemanticFile, isDbmlLayerName, isLibraryFolderName } from '@erd-studio/core';
import type { TableFileEntry } from './logicalModelService';
import { createLogger } from './logger';

const indexLog = createLogger('Table Library');

/** One directory entry as listed (`readdirSync` with file types). */
export interface ListedName {
  readonly name: string;
  readonly file: boolean;
  readonly dir: boolean;
  readonly link: boolean;
}

/** The entries of `dir`, or null when it cannot be listed. */
export function listDir(dir: string): ListedName[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, file: d.isFile(), dir: d.isDirectory(), link: d.isSymbolicLink() }));
  } catch {
    return null;
  }
}

/**
 * `a.localeCompare(b)`'s order, from one collator: `localeCompare` builds a
 * collator per call, which made sorting a 10,000-file library folder slow.
 */
export const compareNames = new Intl.Collator().compare;

/** The one-level folders a library lists (no dot-folders, no symlinked folders), sorted as the lookup walks them. */
export function foldersOf(listing: readonly ListedName[] | null): string[] {
  return (listing ?? []).filter((d) => d.dir && !d.name.startsWith('.')).map((d) => d.name).sort((a, b) => a.localeCompare(b));
}

/**
 * `tablesDirIsLayer`'s rule over a listing of `tables/` (see that function):
 * it holds a subject area file (`tables/*.json`) or `layers.json` lists a
 * `tables` layer. A `.dbml` there (a 1.9 pre-release leftover) changes nothing.
 */
export function isLayerFolder(top: readonly ListedName[] | null, layersListTables: boolean): boolean {
  if (top === null) return false;
  return top.some((d) => d.file && d.name.endsWith('.json')) || layersListTables;
}

/**
 * `hasTablesLibrary`'s rule: `tables/` exists, is not a layer, and holds a
 * `*.yml` table file at the top or one folder down. A folder that cannot be
 * listed answers false, as the reader that threw did.
 */
export function holdsTableFiles(top: readonly ListedName[] | null, namesIn: (folder: string) => readonly string[] | null): boolean {
  if (top === null) return false;
  const isTableFile = (name: string): boolean => name.endsWith('.yml');
  for (const d of top) {
    if (d.file && isTableFile(d.name)) return true;
    if (d.dir && !d.name.startsWith('.')) {
      const names = namesIn(d.name);
      if (names === null) return false;
      if (names.some(isTableFile)) return true;
    }
  }
  return false;
}

/** Whether `layers.json` under `semanticRoot` lists a layer called `tables`. */
export function layersListTables(semanticRoot: string): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(semanticRoot, LAYERS_CONFIG_FILE), 'utf-8')) as { layers?: unknown };
    return Array.isArray(config.layers) &&
      config.layers.some((l) => !!l && typeof l === 'object' && (l as { id?: unknown }).id === TABLES_DIR);
  } catch {
    return false;
  }
}

/** {@link statSignature}'s signature for a path that does not exist. */
const ABSENT_SIGNATURE = '-';

/** A directory's or file's signature (inode, mtime, size), or `-` when it cannot be stat'ed. */
function statSignature(filePath: string): { sig: string; mtimeMs: number; dir: boolean } {
  try {
    const stat = fs.statSync(filePath);
    return { sig: `${stat.ino}:${stat.mtimeMs}:${stat.size}`, mtimeMs: stat.mtimeMs, dir: stat.isDirectory() };
  } catch {
    return { sig: ABSENT_SIGNATURE, mtimeMs: 0, dir: false };
  }
}

/** Whether `p` is a directory (a `stat`, never a listing). */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * How long after a directory changed an index built from it is not trusted
 * on its signature alone: a change in the same clock tick could leave the
 * mtime as it was. Covers coarse kernel clocks (Linux's jiffy).
 */
export const RACY_MS = 50;

/**
 * The window for a file system that records whole-second (HFS+) or
 * two-second (FAT) times, seen as a newest mtime on a whole second.
 */
export const COARSE_RACY_MS = 2000;

/**
 * Whether an index built at `startedAt` from directories whose newest mtime
 * is `newestMtimeMs` must be listed again on its next use: the newest change
 * falls inside the racy window around the build. A whole-second mtime widens
 * the window to {@link COARSE_RACY_MS}. An mtime well ahead of the clock (a
 * VM or WSL2 clock behind the machine that stamped the files, a network
 * share, a restored archive) is outside the window and still a valid
 * signature: any later change stamps the directory again.
 */
export function isRacyBuild(newestMtimeMs: number, startedAt: number): boolean {
  if (newestMtimeMs <= 0) return false;
  const window = newestMtimeMs % 1000 === 0 ? COARSE_RACY_MS : RACY_MS;
  return Math.abs(newestMtimeMs - startedAt) <= window;
}

/** A table-file candidate in one directory, for the §3.4 lookup. */
interface Candidate {
  readonly file: string;
  /** A symbolic link: a candidate only while it points at a file (checked at lookup). */
  readonly link: boolean;
}

/** One directory of the lookup order with its candidates for one extension. */
interface LookupDir {
  readonly dir: string;
  readonly ext: '.yml' | '.dbml';
  /** File name → candidate (an exact spelling wins first). */
  readonly exact: Map<string, Candidate>;
  /** Trimmed lower-case stem → candidates in `compareNames` order. */
  readonly byKey: Map<string, Candidate[]>;
}

/** One library directory as listed. */
interface LibraryScan {
  readonly dir: string;
  /** The path exists (a `stat`). */
  readonly exists: boolean;
  readonly top: ListedName[] | null;
  readonly folders: string[];
  /** Each folder's listing (null when it cannot be listed). */
  readonly folderListings: Map<string, ListedName[] | null>;
}

/** One DBML layer folder of the semantic dir, as the index listed it. */
export interface DbmlLayerListing {
  /** The layer folder, as listed (a layer id: `isDbmlLayerName`). */
  readonly layer: string;
  /** `<layer>/tables/`'s schema folders, sorted (`compareNames`); empty when it has none or does not exist. */
  readonly schemas: readonly string[];
  /** `<layer>/tables/` exists. */
  readonly hasTables: boolean;
  /** `<layer>/relationships/` exists. */
  readonly hasRelationships: boolean;
}

/** A DBML layer's scan: its `tables/` library (one schema folder deep) and its `relationships/` listing. */
interface LayerScan {
  readonly layer: string;
  readonly tables: LibraryScan | null;
  readonly relationshipsDir: string;
  readonly relationships: ListedName[] | null;
}

/** Everything the index answers, built from one listing. */
export interface TableLibraryIndexData {
  readonly v5Exists: boolean;
  readonly v6Exists: boolean;
  /** `logical-models/`'s folders (`listFolders`). */
  readonly v5Folders: readonly string[];
  /** `tables/`'s folders. */
  readonly v6Folders: readonly string[];
  /** `tablesDirIsLayer`. */
  readonly v6IsLayer: boolean;
  /** `hasTablesLibrary`. */
  readonly v6IsLibrary: boolean;
  /** `listTableFiles`. */
  readonly entries: readonly TableFileEntry[];
  /** `listRelationshipsFiles`: every `<layer>/relationships/*.dbml`, by path in byte order. */
  readonly relationshipsFiles: readonly string[];
  /** Every DBML layer folder of the semantic dir (`isDbmlLayerName`), sorted (`compareNames`). */
  readonly dbmlLayers: readonly DbmlLayerListing[];
  /** Every listed table file's absolute path (shadowed ones included). */
  readonly tableFiles: ReadonlySet<string>;
  /** Trimmed lower-case name → the first entry's spelling (`findTableNameIgnoringCase`). */
  readonly firstNameByKey: ReadonlyMap<string, string>;
  /** The §3.4 lookup order. */
  readonly lookup: readonly LookupDir[];
}

/** Whether `filePath` (a symbolic link) points at a file. */
function isFileTarget(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

const nameKey = (name: string): string => name.trim().toLowerCase();

/**
 * The index of one semantic dir's table library. `get()` answers from the
 * last build while every directory it listed is unchanged; `invalidate()`
 * forces the next `get()` to list again.
 */
export class TableLibraryIndex {
  private data: TableLibraryIndexData | undefined;
  /** The paths whose signatures validate {@link data}, and those signatures. */
  private validation: { paths: string[]; sigs: string[]; racy: boolean } | undefined;
  /** How many times the index was built (tests and benchmarks). */
  builds = 0;
  /** How deep {@link withSnapshot} calls are nested (0 = none running). */
  private snapshotDepth = 0;
  /** Inside a snapshot: the index was validated (or built) once already, so `get()` trusts it. */
  private snapshotChecked = false;

  constructor(
    private readonly semanticRoot: string,
    private readonly v5Dir: string,
    private readonly v6Dir: string,
  ) {}

  /** Drop the index: the next lookup lists the library again. */
  invalidate(): void {
    this.data = undefined;
    this.validation = undefined;
    this.snapshotChecked = false;
  }

  /**
   * Run `fn` against one validated index: the first lookup inside it checks
   * the directories' signatures (or lists the library), and every later one
   * trusts that answer until `fn` returns. For read-only work that makes
   * hundreds of lookups in one go (opening a diagram resolves each table):
   * one look at the disk instead of one per lookup. Nothing inside `fn` may
   * write the library; `invalidate()` still drops the index at once.
   */
  withSnapshot<T>(fn: () => T): T {
    if (this.snapshotDepth === 0) this.snapshotChecked = false;
    this.snapshotDepth++;
    try {
      return fn();
    } finally {
      this.snapshotDepth--;
      if (this.snapshotDepth === 0) this.snapshotChecked = false;
    }
  }

  /** The last index built, without validating it (undefined when there is none). */
  peek(): TableLibraryIndexData | undefined {
    return this.data;
  }

  /** Whether the next {@link get} lists the library (no index yet, or one known to be stale). */
  isCold(): boolean {
    return this.data === undefined || this.validation === undefined || this.validation.racy || !this.signaturesHold();
  }

  /** The index, rebuilt first when a directory it listed changed. */
  get(): TableLibraryIndexData {
    if (this.snapshotChecked && this.data !== undefined) return this.data;
    const data = this.data !== undefined && this.validation !== undefined && !this.validation.racy && this.signaturesHold()
      ? this.data
      : this.build();
    if (this.snapshotDepth > 0) this.snapshotChecked = true;
    return data;
  }

  /** Whether `filePath` is a table file the current index lists. */
  listsTableFile(filePath: string): boolean {
    return this.get().tableFiles.has(path.resolve(filePath));
  }

  /**
   * The file holding `name` in §3.4's order: `logical-models/` top level then
   * folders, then `tables/` top level then folders (YAML), then each DBML
   * layer's schema folders (`<layer>/tables/<schema>/`, layers and schemas
   * in `compareNames` order); the exact spelling first, then any case. Null
   * when none does. The caller has checked that `name` is path-safe.
   */
  find(name: string): string | null {
    const exactFile = (ext: string): string => `${name}${ext}`;
    const key = nameKey(name);
    for (const dir of this.get().lookup) {
      const exact = dir.exact.get(exactFile(dir.ext));
      if (exact !== undefined && (!exact.link || isFileTarget(path.join(dir.dir, exact.file)))) return path.join(dir.dir, exact.file);
      for (const candidate of dir.byKey.get(key) ?? []) {
        if (!candidate.link || isFileTarget(path.join(dir.dir, candidate.file))) return path.join(dir.dir, candidate.file);
      }
    }
    return null;
  }

  private signaturesHold(): boolean {
    const v = this.validation!;
    for (let i = 0; i < v.paths.length; i++) {
      if (statSignature(v.paths[i]).sig !== v.sigs[i]) return false;
    }
    return true;
  }

  private build(): TableLibraryIndexData {
    const startedAt = Date.now();
    const paths: string[] = [];
    const sigs: string[] = [];
    let newest = 0;
    const root = path.resolve(this.semanticRoot);
    // Each path is stat'ed just BEFORE it is read, so a change made while the
    // index is being built shows as a different signature on the next use.
    // The semantic dir is stat'ed first, so an absent direct child of it
    // (`layers.json`, `logical-models/`, `tables/`) needs no signature of its
    // own: creating it changes the semantic dir's. That keeps a YAML
    // project's per-lookup check at about its pre-2.0 size.
    const record = (p: string): boolean => {
      const { sig, mtimeMs, dir } = statSignature(p);
      if (sig === ABSENT_SIGNATURE && paths.length > 0 && path.resolve(path.dirname(p)) === root) return dir;
      paths.push(p);
      sigs.push(sig);
      newest = Math.max(newest, mtimeMs);
      return dir;
    };
    // The layer-first DBML tree's top level: a new layer folder changes it.
    record(root);
    record(path.join(this.semanticRoot, LAYERS_CONFIG_FILE));
    const listsTables = layersListTables(this.semanticRoot);
    // A library folder: listed (and its non-dot folders) only when the stat says it is a directory.
    const scan = (dir: string, foldersShown: (name: string) => boolean = (n) => !n.startsWith('.')): LibraryScan => {
      const exists = record(dir);
      const top = exists ? listDir(dir) : null;
      const folders = foldersOf(top).filter(foldersShown);
      const folderListings = new Map<string, ListedName[] | null>();
      for (const folder of folders) {
        const folderDir = path.join(dir, folder);
        record(folderDir);
        folderListings.set(folder, listDir(folderDir));
      }
      return { dir, exists, top, folders, folderListings };
    };
    const v5 = scan(this.v5Dir);
    const v6 = scan(this.v6Dir);
    const namesIn = (folder: string): string[] | null => v6.folderListings.get(folder)?.map((d) => d.name) ?? null;
    const v6IsLayer = isLayerFolder(v6.top, listsTables);
    const v6IsLibrary = v6.exists && !v6IsLayer && holdsTableFiles(v6.top, namesIn);

    // The layer-first DBML tree: every top-level folder with a layer's name
    // (the semantic dir was stat'ed first, above).
    const layerNames = (listDir(root) ?? []).filter((d) => d.dir && isDbmlLayerName(d.name)).map((d) => d.name).sort(compareNames);
    const layers: LayerScan[] = [];
    for (const layer of layerNames) {
      const layerDir = path.join(root, layer);
      // A stat of the layer: a `tables/` or `relationships/` made later changes it.
      record(layerDir);
      const tablesDir = path.join(layerDir, TABLES_DIR);
      const tables = isDirectory(tablesDir) ? scan(tablesDir, isLibraryFolderName) : null;
      const relationshipsDir = path.join(layerDir, RELATIONSHIPS_DIR);
      let relationships: ListedName[] | null = null;
      if (isDirectory(relationshipsDir)) {
        record(relationshipsDir);
        relationships = listDir(relationshipsDir);
      }
      layers.push({ layer, tables, relationshipsDir, relationships });
    }

    const data: TableLibraryIndexData = {
      v5Exists: v5.exists,
      v6Exists: v6.exists,
      v5Folders: v5.folders,
      v6Folders: v6.folders,
      v6IsLayer,
      v6IsLibrary,
      ...this.entriesOf(v5, v6, v6IsLibrary, layers),
      relationshipsFiles: this.relationshipsFilesOf(layers),
      dbmlLayers: layers.map((l) => ({
        layer: l.layer,
        schemas: l.tables?.folders ?? [],
        hasTables: l.tables !== null,
        hasRelationships: l.relationships !== null,
      })),
      lookup: this.lookupOf(v5, v6, v6.exists && !v6IsLayer, layers),
    };
    this.data = data;
    this.validation = { paths, sigs, racy: isRacyBuild(newest, startedAt) };
    this.builds++;
    indexLog.debug(`Library index built: ${data.tableFiles.size} table file(s), ${paths.length} folder(s) watched, ${Date.now() - startedAt} ms`);
    return data;
  }

  /** The listing of `folder` (`''` = the top) of `scan`. */
  private listingOf(scan: LibraryScan, folder: string): ListedName[] | null {
    return folder === '' ? scan.top : scan.folderListings.get(folder) ?? null;
  }

  /**
   * What the single classifier says of a file in a library: `library` is the
   * library's path relative to the semantic dir (`logical-models`, `tables`,
   * `<layer>/tables`), with `tables/` read as the YAML library.
   */
  private classify(library: string, folder: string, file: string): ReturnType<typeof classifySemanticFile> {
    return classifySemanticFile(folder === '' ? `${library}/${file}` : `${library}/${folder}/${file}`, { tablesDirIsLayer: false });
  }

  /**
   * `listTableFiles`: `logical-models/` (the top level first, then each
   * folder in order), then `tables/` (listed only while it is the YAML
   * library), then each DBML layer's schema folders (`<layer>/tables/<schema>/`,
   * layers and schemas in `compareNames` order); a name seen before is
   * `shadowedBy` the first file.
   */
  private entriesOf(v5: LibraryScan, v6: LibraryScan, v6IsLibrary: boolean, layers: readonly LayerScan[]): Pick<TableLibraryIndexData, 'entries' | 'tableFiles' | 'firstNameByKey'> {
    const entries: TableFileEntry[] = [];
    // Exact name → winner (within the YAML libraries a name matches exactly),
    // and lower-case name → the first winner: a `tables/` file of the same
    // name in any case is shadowed by `logical-models/` (#162), and a `.dbml`
    // table's name is compared without case (D2) against every file before it.
    const winners = new Map<string, string>();
    const v5Winners = new Map<string, string>();
    const anyWinners = new Map<string, string>();
    const add = (scan: LibraryScan, libraryName: string, folder: string, phase: 'v5' | 'v6' | 'dbml', layer?: string): void => {
      const listing = this.listingOf(scan, folder);
      if (listing === null) return;
      const dir = folder === '' ? scan.dir : path.join(scan.dir, folder);
      const files = listing
        .filter((d) => d.file)
        .flatMap((d): Array<{ file: string; name: string; storage: 'yaml' | 'dbml' }> => {
          // The single classifier (D10): a `.yml` in a YAML library, a `.dbml` in a schema folder.
          const kind = this.classify(libraryName, folder, d.name);
          return kind.kind === 'table' && kind.name !== undefined && (kind.storage === 'yaml' || kind.storage === 'dbml')
            ? [{ file: d.name, name: kind.name, storage: kind.storage }]
            : [];
        })
        .sort((a, b) => compareNames(a.file, b.file));
      for (const { file, name, storage } of files) {
        const filePath = path.join(dir, file);
        const lower = name.toLowerCase();
        const winner = winners.get(name)
          ?? (phase === 'v6' ? v5Winners.get(lower) : phase === 'dbml' ? anyWinners.get(lower) : undefined);
        const tag: Pick<TableFileEntry, 'library' | 'layer'> = phase === 'v6' ? { library: TABLES_DIR } : layer !== undefined ? { layer } : {};
        if (winner === undefined) {
          winners.set(name, filePath);
          if (phase === 'v5') v5Winners.set(lower, filePath);
          if (!anyWinners.has(lower)) anyWinners.set(lower, filePath);
          entries.push({ name, folder, filePath, storage, ...tag });
        } else {
          entries.push({ name, folder, filePath, shadowedBy: winner, storage, ...tag });
        }
      }
    };
    if (v5.exists) {
      add(v5, LOGICAL_MODELS_DIR, '', 'v5');
      for (const folder of v5.folders) add(v5, LOGICAL_MODELS_DIR, folder, 'v5');
    }
    if (v6IsLibrary) {
      add(v6, TABLES_DIR, '', 'v6');
      for (const folder of v6.folders) add(v6, TABLES_DIR, folder, 'v6');
    }
    for (const { layer, tables } of layers) {
      if (tables === null) continue;
      for (const schema of tables.folders) add(tables, `${layer}/${TABLES_DIR}`, schema, 'dbml', layer);
    }
    const firstNameByKey = new Map<string, string>();
    for (const entry of entries) {
      const key = nameKey(entry.name);
      if (!firstNameByKey.has(key)) firstNameByKey.set(key, entry.name);
    }
    return { entries, tableFiles: new Set(entries.map((e) => path.resolve(e.filePath))), firstNameByKey };
  }

  /** `listRelationshipsFiles`: every DBML layer's `relationships/*.dbml` (flat), by semantic-relative path in byte order. */
  private relationshipsFilesOf(layers: readonly LayerScan[]): string[] {
    const out: Array<{ rel: string; filePath: string }> = [];
    for (const { layer, relationships, relationshipsDir } of layers) {
      for (const d of relationships ?? []) {
        if (!d.file && !d.link) continue;
        const rel = `${layer}/${RELATIONSHIPS_DIR}/${d.name}`;
        if (classifySemanticFile(rel, { tablesDirIsLayer: false }).kind !== 'relationships') continue;
        out.push({ rel, filePath: path.join(relationshipsDir, d.name) });
      }
    }
    return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)).map((r) => r.filePath);
  }

  /** The §3.4 lookup order, each directory's candidates indexed by exact file name and by name key. */
  private lookupOf(v5: LibraryScan, v6: LibraryScan, readV6: boolean, layers: readonly LayerScan[]): LookupDir[] {
    const out: LookupDir[] = [];
    const add = (scan: LibraryScan, libraryName: string, folder: string, ext: '.yml' | '.dbml'): void => {
      const dir = path.join(path.resolve(scan.dir), folder);
      const exact = new Map<string, Candidate>();
      const byKey = new Map<string, Candidate[]>();
      const listing = this.listingOf(scan, folder) ?? [];
      const names = listing
        .filter((d) => d.name.endsWith(ext) && (d.file || d.link))
        .filter((d) => this.classify(libraryName, folder, d.name).kind === 'table')
        .sort((a, b) => compareNames(a.name, b.name));
      for (const d of names) {
        const candidate: Candidate = { file: d.name, link: !d.file };
        exact.set(d.name, candidate);
        const key = nameKey(d.name.slice(0, -ext.length));
        const list = byKey.get(key);
        if (list) list.push(candidate);
        else byKey.set(key, [candidate]);
      }
      out.push({ dir, ext, exact, byKey });
    };
    if (v5.exists) for (const folder of ['', ...v5.folders]) add(v5, LOGICAL_MODELS_DIR, folder, '.yml');
    if (readV6) for (const folder of ['', ...v6.folders]) add(v6, TABLES_DIR, folder, '.yml');
    for (const { layer, tables } of layers) {
      if (tables === null) continue;
      for (const schema of tables.folders) add(tables, `${layer}/${TABLES_DIR}`, schema, '.dbml');
    }
    return out;
  }
}
