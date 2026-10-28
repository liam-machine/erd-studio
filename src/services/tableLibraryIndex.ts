/**
 * The table library's name → file index: one listing of `logical-models/`
 * and `tables/` (the top level and one folder down), from which every
 * lookup `TableLibraryService` makes is answered without touching the disk
 * again — which file holds a name (§3.4's order), every table file with its
 * folder, storage and duplicates (`listTableFiles`), the relationships
 * files, the library folders, and whether `tables/` is a layer.
 *
 * Self-validating: the index keeps the signature (inode, mtime, size) of
 * every directory it listed and of `layers.json`, taken just before each was
 * read. A file added, removed or renamed in a library directory changes that
 * directory's mtime, so a lookup re-stats that handful of paths and rebuilds
 * the index when any differs — an AI assistant writing files, a `git
 * checkout` or another window is seen without any watcher event. A
 * directory changed within {@link RACY_MS} of a build is "racy" (a file
 * system's clock may give two changes in one tick the same mtime), and the
 * index is rebuilt on its next use until no directory is.
 *
 * No `vscode`: the CLI bundles it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LAYERS_CONFIG_FILE, LOGICAL_MODELS_DIR, TABLES_DIR, classifySemanticFile, isLibraryFolderName } from '@erd-studio/core';
import type { TableFileEntry } from './logicalModelService';

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
 * Whether `tables/` holds DBML evidence: a `*.dbml` file at the top level or
 * a `*.dbml` entry one folder down (no content sniff). `top` is the listing
 * of `tables/`, `namesIn` lists a folder of it (null when it cannot be).
 */
export function hasDbmlEvidence(top: readonly ListedName[] | null, namesIn: (folder: string) => readonly string[] | null): boolean {
  if (top === null) return false;
  return top.some((d) =>
    (d.file && d.name.endsWith('.dbml')) ||
    (d.dir && isLibraryFolderName(d.name) && (namesIn(d.name) ?? []).some((f) => f.endsWith('.dbml'))));
}

/** `tablesDirIsLayer`'s rule over a listing of `tables/` (see that function). */
export function isLayerFolder(top: readonly ListedName[] | null, hasDbml: boolean, layersListTables: boolean): boolean {
  if (top === null) return false;
  const json = top.some((d) => d.file && d.name.endsWith('.json'));
  return hasDbml ? json && layersListTables : json || layersListTables;
}

/**
 * `hasTablesLibrary`'s rule: `tables/` exists, is not a layer, and holds a
 * table file (`*.yml`, `*.dbml`) at the top or one folder down. A folder that
 * cannot be listed answers false, as the reader that threw did.
 */
export function holdsTableFiles(top: readonly ListedName[] | null, namesIn: (folder: string) => readonly string[] | null): boolean {
  if (top === null) return false;
  const isTableFile = (name: string): boolean => name.endsWith('.yml') || name.endsWith('.dbml');
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

/** A directory's or file's signature (inode, mtime, size), or `-` when it cannot be stat'ed. */
function statSignature(filePath: string): { sig: string; mtimeMs: number } {
  try {
    const stat = fs.statSync(filePath);
    return { sig: `${stat.ino}:${stat.mtimeMs}:${stat.size}`, mtimeMs: stat.mtimeMs };
  } catch {
    return { sig: '-', mtimeMs: 0 };
  }
}

/**
 * How long after a directory changed an index built from it is not trusted
 * on its signature alone: a change in the same clock tick could leave the
 * mtime as it was. Covers coarse kernel clocks (Linux's jiffy); a file
 * system with whole-second times (HFS+, FAT) is covered by the watchers,
 * which invalidate explicitly.
 */
export const RACY_MS = 50;

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
  /** The path exists (`existsSync`). */
  readonly exists: boolean;
  readonly top: ListedName[] | null;
  readonly folders: string[];
  /** Each folder's listing (null when it cannot be listed). */
  readonly folderListings: Map<string, ListedName[] | null>;
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
  /** `listRelationshipsFiles`. */
  readonly relationshipsFiles: readonly string[];
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

  constructor(
    private readonly semanticRoot: string,
    private readonly v5Dir: string,
    private readonly v6Dir: string,
  ) {}

  /** Drop the index: the next lookup lists the library again. */
  invalidate(): void {
    this.data = undefined;
    this.validation = undefined;
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
    if (this.data !== undefined && this.validation !== undefined && !this.validation.racy && this.signaturesHold()) {
      return this.data;
    }
    return this.build();
  }

  /** Whether `filePath` is a table file the current index lists. */
  listsTableFile(filePath: string): boolean {
    return this.get().tableFiles.has(path.resolve(filePath));
  }

  /**
   * The file holding `name` in §3.4's order: `logical-models/` top level then
   * folders, then `tables/` top level then folders, `.dbml` before `.yml` in
   * each; the exact spelling first, then any case. Null when none does.
   * The caller has checked that `name` is path-safe.
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
    // Each path is stat'ed just BEFORE it is read, so a change made while the
    // index is being built shows as a different signature on the next use.
    const record = (p: string): void => {
      const { sig, mtimeMs } = statSignature(p);
      paths.push(p);
      sigs.push(sig);
      newest = Math.max(newest, mtimeMs);
    };
    record(path.join(this.semanticRoot, LAYERS_CONFIG_FILE));
    const listsTables = layersListTables(this.semanticRoot);
    const scan = (dir: string): LibraryScan => {
      record(dir);
      const exists = fs.existsSync(dir);
      const top = listDir(dir);
      const folders = foldersOf(top);
      const folderListings = new Map<string, ListedName[] | null>();
      // Every sub-directory a rule may look into (dot-folders included, for `hasDbmlEvidence`).
      for (const d of top ?? []) {
        if (!d.dir) continue;
        const folderDir = path.join(dir, d.name);
        record(folderDir);
        folderListings.set(d.name, listDir(folderDir));
      }
      return { dir, exists, top, folders, folderListings };
    };
    const v5 = scan(this.v5Dir);
    const v6 = scan(this.v6Dir);
    const namesIn = (folder: string): string[] | null => v6.folderListings.get(folder)?.map((d) => d.name) ?? null;
    const v6HasDbml = hasDbmlEvidence(v6.top, namesIn);
    const v6IsLayer = isLayerFolder(v6.top, v6HasDbml, listsTables);
    const v6IsLibrary = v6.exists && !v6IsLayer && holdsTableFiles(v6.top, namesIn);

    const data: TableLibraryIndexData = {
      v5Exists: v5.exists,
      v6Exists: v6.exists,
      v5Folders: v5.folders,
      v6Folders: v6.folders,
      v6IsLayer,
      v6IsLibrary,
      ...this.entriesOf(v5, v6, v6IsLibrary),
      relationshipsFiles: v6.exists && !v6IsLayer ? this.relationshipsFilesOf(v6) : [],
      lookup: this.lookupOf(v5, v6, v6.exists && !v6IsLayer),
    };
    this.data = data;
    this.validation = { paths, sigs, racy: newest >= startedAt - RACY_MS };
    this.builds++;
    return data;
  }

  /** The listing of `folder` (`''` = the top) of `scan`. */
  private listingOf(scan: LibraryScan, folder: string): ListedName[] | null {
    return folder === '' ? scan.top : scan.folderListings.get(folder) ?? null;
  }

  /** What the single classifier says of a file in a library (with `tables/` read as the library). */
  private classify(library: string, folder: string, file: string): ReturnType<typeof classifySemanticFile> {
    return classifySemanticFile(folder === '' ? `${library}/${file}` : `${library}/${folder}/${file}`, { tablesDirIsLayer: false });
  }

  /**
   * `listTableFiles`: the top level first, then each folder in order,
   * `logical-models/` before `tables/` (listed only while it is the
   * library); a name seen before is `shadowedBy` the first file.
   */
  private entriesOf(v5: LibraryScan, v6: LibraryScan, v6IsLibrary: boolean): Pick<TableLibraryIndexData, 'entries' | 'tableFiles' | 'firstNameByKey'> {
    const entries: TableFileEntry[] = [];
    const winners = new Map<string, string>();
    // `logical-models/`'s files by lower-case name: a `tables/` file of the
    // same name in any case is shadowed by it (#162). Within one library
    // the match stays exact for YAML; a `.dbml` table's name is compared
    // without case (D2), so within `tables/` any pair involving a `.dbml`
    // file is matched by its lower-case name.
    const v5Winners = new Map<string, string>();
    const dbmlWinners = new Map<string, { filePath: string; dbml: boolean }>();
    let library: typeof TABLES_DIR | undefined;
    const add = (scan: LibraryScan, libraryName: string, folder: string): void => {
      const listing = this.listingOf(scan, folder);
      if (listing === null) return;
      const dir = folder === '' ? scan.dir : path.join(scan.dir, folder);
      const files = listing
        .filter((d) => d.file)
        .flatMap((d): Array<{ file: string; name: string; storage: 'yaml' | 'dbml' }> => {
          // The single classifier (D10): a `.yml` in either library, a
          // `.dbml` only in `tables/` and never a relationships file.
          const kind = this.classify(libraryName, folder, d.name);
          return kind.kind === 'table' && kind.name !== undefined && (kind.storage === 'yaml' || kind.storage === 'dbml')
            ? [{ file: d.name, name: kind.name, storage: kind.storage }]
            : [];
        })
        // Within one directory a `.dbml` is listed (and wins) before a `.yml` of the same name (§3.4).
        .sort((a, b) => a.name.toLowerCase() === b.name.toLowerCase() && a.storage !== b.storage
          ? (a.storage === 'dbml' ? -1 : 1)
          : compareNames(a.file, b.file));
      for (const { file, name, storage } of files) {
        const filePath = path.join(dir, file);
        const lower = name.toLowerCase();
        const dbmlWinner = dbmlWinners.get(lower);
        const winner = winners.get(name)
          ?? (library ? v5Winners.get(lower) : undefined)
          ?? (dbmlWinner && (storage === 'dbml' || dbmlWinner.dbml) ? dbmlWinner.filePath : undefined);
        const tag = library ? { library } : {};
        if (winner === undefined) {
          winners.set(name, filePath);
          if (!library) v5Winners.set(lower, filePath);
          else if (!dbmlWinners.has(lower)) dbmlWinners.set(lower, { filePath, dbml: storage === 'dbml' });
          entries.push({ name, folder, filePath, storage, ...tag });
        } else {
          entries.push({ name, folder, filePath, shadowedBy: winner, storage, ...tag });
        }
      }
    };
    if (v5.exists) {
      add(v5, LOGICAL_MODELS_DIR, '');
      for (const folder of v5.folders) add(v5, LOGICAL_MODELS_DIR, folder);
    }
    if (v6IsLibrary) {
      library = TABLES_DIR;
      add(v6, TABLES_DIR, '');
      for (const folder of v6.folders) add(v6, TABLES_DIR, folder);
    }
    const firstNameByKey = new Map<string, string>();
    for (const entry of entries) {
      const key = nameKey(entry.name);
      if (!firstNameByKey.has(key)) firstNameByKey.set(key, entry.name);
    }
    return { entries, tableFiles: new Set(entries.map((e) => path.resolve(e.filePath))), firstNameByKey };
  }

  /** `listRelationshipsFiles`: each `tables/` directory's relationships file (any case; the first sorted), top level first. */
  private relationshipsFilesOf(v6: LibraryScan): string[] {
    const out: string[] = [];
    for (const folder of ['', ...v6.folders]) {
      const file = (this.listingOf(v6, folder) ?? [])
        .map((d) => d.name)
        .filter((f) => this.classify(TABLES_DIR, folder, f).kind === 'relationships')
        .sort(compareNames)[0];
      if (file) out.push(path.join(folder === '' ? v6.dir : path.join(v6.dir, folder), file));
    }
    return out;
  }

  /** The §3.4 lookup order, each directory's candidates indexed by exact file name and by name key. */
  private lookupOf(v5: LibraryScan, v6: LibraryScan, readV6: boolean): LookupDir[] {
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
    for (const folder of ['', ...v5.folders]) add(v5, LOGICAL_MODELS_DIR, folder, '.yml');
    if (readV6) {
      for (const folder of ['', ...v6.folders]) {
        add(v6, TABLES_DIR, folder, '.dbml');
        add(v6, TABLES_DIR, folder, '.yml');
      }
    }
    return out;
  }
}
