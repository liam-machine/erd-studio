/**
 * The one look at an open folder (#347): which files it holds that ERD
 * Studio can start a data model from (`.sql`, `.dbml`, a semantic model), and
 * where its dbt projects are. The start screen's suggestion, Import…'s
 * picker, the quick imports and activation's dbt project search all read the
 * same {@link FolderLookRun}, so the folder is gone over once, not once each.
 *
 * Two stages, the fast one first:
 *
 * 1. **Git's index.** Inside a git repository, `.git/index` already lists
 *    every tracked path in one file (`gitIndex.ts`): the answer for tracked
 *    files takes one read, whatever the number of folders and however slow a
 *    listing is. ERD Studio reads the repository's own file and never runs
 *    git. An index it cannot use (an unknown version, too large, damaged)
 *    means stage 2 alone, never a guess.
 * 2. **One walk** (`folderScan.ts`), for files git does not know yet and for
 *    folders outside a repository: breadth first, two listings at a time,
 *    read with Node (a `vscode.workspace.fs` listing waits on a round trip to
 *    VS Code's window for every folder), at most
 *    {@link FOLDER_LOOK_MAX_FOLDERS} folders and {@link FOLDER_LOOK_MAX_MS}.
 *    It goes only as far as someone has asked: the dbt project search needs
 *    {@link DBT_SEARCH_MAX_DEPTH} folders deep and waits for at most
 *    {@link DBT_SEARCH_MAX_DIRS} folders (the bound it has always had), and
 *    the walk stops there until a look for import files asks for the rest
 *    ({@link IMPORT_WALK_MAX_DEPTH} deep). Nothing it has listed is listed
 *    again. The ERD Studio folder is walked like any other (a dbt project
 *    may sit below a folder of that name), but its files are the model
 *    itself, never files to import.
 *
 * Nobody's deadline stops it: a caller that cannot wait reads
 * {@link FolderLookRun.listingSoFar} and the rest lands later.
 *
 * Reads only, and nothing leaves the machine. vscode-free; not for the CLI
 * (which keeps the synchronous `findDbtProjectsBelow`).
 */

import { promises as fsp } from 'fs';
import * as path from 'path';

import { DBT_SEARCH_MAX_DEPTH, DBT_SEARCH_MAX_DIRS } from './dbtProjectSearch';
import { FolderScan, nodeScanReader, type ScanReader } from './folderScan';
import { findGitIndex, readGitIndex, type GitIndexLocation, type GitIndexReadOptions, type GitIndexResult } from './gitIndex';
import {
  IGNORED_IMPORT_FOLDERS,
  IMPORT_LIST_LIMIT,
  IMPORT_WALK_MAX_DEPTH,
  compareNames,
  isSemanticModelMarker,
  type ImportListing,
} from './importSources';
import { pathKey } from './pathKey';

/**
 * Most folders one look lists, so the worst case has a known size on any
 * disk. Four times what the dbt project search waits for: a repository of a
 * few thousand folders is looked through to its end (measured on one of
 * 7,300: at 5,000 the walk never reached scripts five folders down).
 */
export const FOLDER_LOOK_MAX_FOLDERS = 20_000;
/** A look's walk stops after this long spent walking, with what it has found (a disk that stopped answering never holds it). */
export const FOLDER_LOOK_MAX_MS = 60_000;
/** A look is reused for this long from when it began. */
export const FOLDER_LOOK_FRESH_MS = 60_000;
/** Reading git's index may take this long before the walk alone answers. */
export const FOLDER_LOOK_INDEX_MS = 3000;
/** How long the walk's start waits for the index, which says which folders to list first. */
const INDEX_HEAD_START_MS = 250;
/**
 * Outside a repository, where the dbt search's walk stopped at its folder
 * bound: at most this many of the folders it found but did not list are asked
 * for `dbt_project.yml` by name, for at most {@link DBT_BY_NAME_MS}.
 */
const DBT_BY_NAME_MAX = FOLDER_LOOK_MAX_FOLDERS;
const DBT_BY_NAME_MS = 10_000;
/** At most this many tracked `dbt_project.yml` files are looked for on disk before the index stage says none is there. */
const MAX_INDEX_DBT_CHECKS = 5;
/** Listings in flight at once: the file threads are shared with every other extension. */
const LISTINGS_AT_ONCE = 2;
/** The index's paths are gone through this many at a time, the event loop getting a turn between. */
const INDEX_PATHS_AT_ONCE = 2000;
/** The next turn of the event loop, taken when the module loads (a test's fake clock must not hold the look). */
const nextTurn: (callback: () => void) => unknown = setImmediate;
/** At most this many semantic model files from the index are checked on disk. */
const MAX_INDEX_MODEL_CHECKS = 20;

/** What the index is asked for: the import files' endings and names, and `dbt_project.yml`. */
const INDEX_MATCH = {
  suffixes: ['.sql', '.dbml', '.bim'],
  names: ['definition.pbism', 'model.tmdl', 'database.tmdl', 'database.json', 'dbt_project.yml'],
} as const;

/** Folder names that usually hold table definitions or models: listed first within a depth. */
const LIKELY_FOLDER = /^(ddl|sql|db|databases?|schemas?|migrations?|models?|tables?|initdb)$|\.semanticmodel$/i;
/** Build output: listed last within a depth (never skipped). */
const OUTPUT_FOLDER = /^(dist|build|out|bin|obj|vendor)$/i;

/** How the look reads the disk (injected, so tests count listings). */
export interface FolderLookIo {
  reader: ScanReader;
  findGitIndex(folder: string): Promise<GitIndexLocation | undefined>;
  readGitIndex(location: Pick<GitIndexLocation, 'gitDir' | 'indexPath'>, options: GitIndexReadOptions): Promise<GitIndexResult>;
  /** Whether a file is on disk (the index can name a file that is gone). */
  fileExists(filePath: string): Promise<boolean>;
  now(): number;
}

const NODE_IO: FolderLookIo = {
  reader: nodeScanReader,
  findGitIndex,
  readGitIndex,
  fileExists: async (filePath) => {
    try {
      return (await fsp.stat(filePath)).isFile();
    } catch {
      return false;
    }
  },
  now: () => Date.now(),
};

/** What git's index said about a folder. */
export type IndexStage =
  | {
    usable: true;
    /** The tracked import files (never one inside a folder the walk skips). */
    listing: ImportListing;
    /** The tracked folders below the root holding `dbt_project.yml`, at any depth. */
    dbtDirs: string[];
  }
  | {
    usable: false;
    /** The folder is in a repository whose index could not be used (the walk alone answers). */
    repository: boolean;
  };

/** How far a look's walk has got. */
export interface FolderLookStats {
  /** Folders listed so far. */
  folders: number;
  /** The walk is over. */
  finished: boolean;
  /** It stopped at a limit with folders left unlisted. */
  capped: boolean;
}

export interface FolderLooksOptions {
  /** The ERD Studio folder (`erdStudio.semanticDir`): its files are the model itself, never files to import. */
  semanticDir: string;
  io?: Partial<FolderLookIo>;
  maxFolders?: number;
  maxMs?: number;
  indexMs?: number;
}

/** The files of the index stage, kept as paths under the root for merging with the walk's. */
interface IndexFiles {
  files: string[];
  /** `database.json` files with a `tables/` folder beside them. */
  folderModels: Set<string>;
  dbtProject: boolean;
  trackedDirs: Set<string> | undefined;
}

/** One look at one folder: git's index, and the walk as far as anyone has asked. */
export class FolderLookRun {
  /** Stage 1. Never rejects. */
  readonly index: Promise<IndexStage>;
  private indexFiles: IndexFiles | undefined;
  private readonly scan: FolderScan;
  private readonly own: ReadonlySet<string>;
  private readonly listeners = new Set<() => void>();
  private readonly headStart: Promise<void>;
  /** What {@link dbtProjectsNotListedYet} found (or is finding), for the point the walk had reached. */
  private notListed: { folders: number; found: Promise<string[]> } | undefined;
  /** Callers waiting on the walk right now. */
  private waiting = 0;
  /** When the look began: its age counts from here, however often it is read. */
  private readonly beganAt: number;
  private cancelled = false;

  constructor(readonly root: string, private readonly io: FolderLookIo, options: Required<Pick<FolderLooksOptions, 'semanticDir' | 'maxFolders' | 'maxMs' | 'indexMs'>>) {
    this.own = new Set([options.semanticDir.replace(/[\\/]+$/, ''), 'erd-studio'].map((d) => d.replace(/\\/g, '/').toLowerCase()));
    this.beganAt = io.now();
    this.scan = new FolderScan(root, io.reader, {
      ignoredFolders: IGNORED_IMPORT_FOLDERS,
      // The ERD Studio folder is entered (a dbt project may sit below a folder of that name), but its files are the model itself.
      include: (name, folder) => !this.isOwn(folder) && (/\.(sql|dbml)$/i.test(name) || isSemanticModelMarker(name)),
      // dbt_project.yml (any depth the walk reaches) and tables/ folders (a database.json is a model only beside one).
      mark: (name, isDirectory) => (isDirectory ? name.toLowerCase() === 'tables' : isDbtProjectFile(name)),
      maxFolders: options.maxFolders,
      maxDepth: IMPORT_WALK_MAX_DEPTH,
      maxFiles: IMPORT_LIST_LIMIT,
      concurrency: LISTINGS_AT_ONCE,
      rank: (rel) => this.rank(rel),
      compare: compareNames,
      maxMs: options.maxMs,
      now: io.now,
    });
    this.scan.onProgress(() => this.notify());
    this.index = this.readIndex(options.indexMs).then((stage) => {
      this.notify();
      return stage;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.headStart = Promise.race([
      this.index.then(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, INDEX_HEAD_START_MS); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /**
   * The folders below the root that hold `dbt_project.yml`: the tracked ones
   * from the index (any depth) and the ones the walk has met, once it has
   * listed {@link DBT_SEARCH_MAX_DEPTH} folders deep or
   * {@link DBT_SEARCH_MAX_DIRS} folders in all (as far as the dbt project
   * walk has always gone: activation waits on this, never on the rest of the
   * walk). Unsorted (`sortDbtCandidates` orders them).
   */
  async dbtProjects(): Promise<string[]> {
    // The walk starts now (after its short head start), whatever the index read takes.
    const walking = this.walkTo(DBT_SEARCH_MAX_DEPTH, DBT_SEARCH_MAX_DIRS);
    const stage = await this.index;
    await walking;
    const below = [...dbtProjectFolders(this.scan.snapshot().marked), ...await this.dbtProjectsNotListedYet()]
      .map((rel) => path.join(this.root, ...rel.split('/')));
    // The walk's folders first: they are spelled as the disk spells them. The index's spelling
    // (git's letter case and Unicode form) is kept only for a folder the walk did not meet,
    // and one real folder is one project however many ways lead to it.
    const dirs = new Map<string, string>();
    for (const dir of [...below, ...(stage.usable ? stage.dbtDirs : [])]) {
      const key = pathKey(await this.io.reader.realPath(dir).catch(() => dir));
      if (!dirs.has(key)) dirs.set(key, dir);
    }
    return [...dirs.values()];
  }

  /**
   * Where the walk stopped at the dbt search's folder bound: the folders it
   * has found but not listed, each asked for its `dbt_project.yml` by name.
   * The synchronous walk asked every folder it found that way, so this covers
   * what it covered: every folder beside and directly below a listed one. In
   * a repository too: a project not added yet, or in a nested clone, is in
   * no index. In a folder the walk lists to the end (nearly all) nothing is
   * asked.
   */
  private dbtProjectsNotListedYet(): Promise<string[]> {
    const snapshot = this.scan.snapshot();
    if (snapshot.done || snapshot.depthDone >= DBT_SEARCH_MAX_DEPTH) return Promise.resolve([]);
    // One asking per point the walk has reached, shared by whoever asks meanwhile.
    if (this.notListed?.folders !== snapshot.folders) {
      const pending = this.scan.pending()
        .filter((rel) => rel.split('/').length <= DBT_SEARCH_MAX_DEPTH)
        .slice(0, DBT_BY_NAME_MAX);
      this.notListed = { folders: snapshot.folders, found: this.askByName(pending) };
    }
    return this.notListed.found;
  }

  /** Which of `folders` hold a `dbt_project.yml`, two asked at a time, for at most {@link DBT_BY_NAME_MS}. Never rejects. */
  private async askByName(folders: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    let next = 0;
    let stopped = false;
    const ask = async (): Promise<void> => {
      while (next < folders.length && !stopped && !this.cancelled) {
        const rel = folders[next++];
        const there = await this.io.fileExists(joinUnder(this.root, `${rel}/dbt_project.yml`)).catch(() => false);
        if (there && !stopped) found.push(rel);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A disk that stops answering never holds whoever waits (activation does).
    const outOfTime = new Promise<void>((resolve) => { timer = setTimeout(resolve, DBT_BY_NAME_MS); });
    try {
      await Promise.race([Promise.all(Array.from({ length: LISTINGS_AT_ONCE }, ask)), outOfTime]);
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
    return found.sort(compareNames);
  }

  /** Every import file in the folder: resolves when the walk is over. `truncated` when a limit cut it short. */
  async listing(): Promise<ImportListing> {
    // The walk starts now (after its short head start), whatever the index read takes.
    const walking = this.walkTo(IMPORT_WALK_MAX_DEPTH);
    await this.index;
    await walking;
    return this.listingSoFar();
  }

  /** What is known now: the walk's files so far, and the index's wherever the walk has not been. */
  listingSoFar(): ImportListing {
    const snapshot = this.scan.snapshot();
    const complete = snapshot.done && !snapshot.capped && !this.cancelled;
    const files = new Set(snapshot.files);
    const tablesFolders = new Set(snapshot.marked.filter((m) => baseName(m).toLowerCase() === 'tables').map((m) => m.toLowerCase()));
    const folderModels = new Set<string>();
    for (const file of snapshot.files) {
      if (baseName(file).toLowerCase() === 'database.json' && tablesFolders.has(`${withSlash(dirName(file))}tables`.toLowerCase())) folderModels.add(file);
    }
    let dbtProject = snapshot.marked.some((m) => isDbtProjectFile(baseName(m)));
    // The walk, once it has been everywhere, is the truth (a tracked file may be gone from disk).
    // Until then the index stands in for the folders it has not reached.
    if (!complete && this.indexFiles) {
      for (const file of this.indexFiles.files) files.add(file);
      for (const file of this.indexFiles.folderModels) folderModels.add(file);
      dbtProject ||= this.indexFiles.dbtProject;
    }
    return listingOf(this.root, [...files], folderModels, dbtProject, snapshot.truncated || snapshot.capped || this.cancelled);
  }

  /** Called when the index has answered and as the walk finds more. Returns the function that removes the listener. */
  onProgress(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  stats(): FolderLookStats {
    const snapshot = this.scan.snapshot();
    return { folders: snapshot.folders, finished: snapshot.done, capped: snapshot.capped };
  }

  /**
   * Whether a caller may still use this look: someone is waiting on its walk
   * (a folder is walked by one look at a time), or it began less than
   * `maxAgeMs` ago. Reading a look never makes it younger.
   */
  usable(maxAgeMs: number): boolean {
    if (this.cancelled) return false;
    return this.waiting > 0 || this.io.now() - this.beganAt < maxAgeMs;
  }

  /** Stop listing (the window is closing). */
  cancel(): void {
    this.cancelled = true;
    this.scan.cancel();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch { /* a listener never stops the look */ }
    }
  }

  private async walkTo(depth: number, maxFolders?: number): Promise<void> {
    this.waiting++;
    try {
      await this.headStart;
      await this.scan.reach(depth, maxFolders);
    } finally {
      this.waiting--;
    }
  }

  /**
   * Which folders of one depth are listed first: names that usually hold
   * table definitions, then the rest, hidden folders after visible ones,
   * build output last; within each, folders holding a tracked file before
   * folders holding none (in a repository those are mostly ignored output).
   */
  private rank(rel: string): number {
    const parts = rel.split('/');
    if (parts.some((p) => OUTPUT_FOLDER.test(p))) return 6;
    const tracked = this.indexFiles?.trackedDirs;
    const untracked = tracked !== undefined && !tracked.has(rel) ? 1 : 0;
    if (parts.some((p) => LIKELY_FOLDER.test(p))) return untracked;
    return (parts.some((p) => p.startsWith('.')) ? 4 : 2) + untracked;
  }

  /** Whether a folder (a path under the root) is the ERD Studio folder or inside it. */
  private isOwn(folder: string): boolean {
    const lower = folder.toLowerCase();
    for (const own of this.own) {
      if (lower === own || lower.startsWith(`${own}/`)) return true;
    }
    return false;
  }

  /** Whether the walk would reach a tracked path: no skipped folder above it, and not deeper than `maxDepth` folders. */
  private walked(rel: string, maxDepth: number): boolean {
    const folders = rel.split('/').slice(0, -1);
    return folders.length <= maxDepth && !folders.some((f) => IGNORED_IMPORT_FOLDERS.has(f));
  }

  private async readIndex(indexMs: number): Promise<IndexStage> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const outOfTime = new Promise<IndexStage>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve({ usable: false, repository: true }); }, indexMs);
    });
    const read = (async (): Promise<IndexStage> => {
      const location = await this.io.findGitIndex(this.root);
      if (!location) return { usable: false, repository: false };
      const prefix = path.relative(location.workTree, path.resolve(this.root)).split(path.sep).join('/');
      if (prefix.startsWith('..') || path.isAbsolute(prefix)) return { usable: false, repository: true };
      const result = await this.io.readGitIndex(location, {
        prefix,
        prefixIgnoreCase: process.platform === 'win32' || process.platform === 'darwin',
        match: INDEX_MATCH,
        collectDirs: true,
        cancelled: () => this.cancelled || timedOut,
      });
      // Any failure means the walk alone: an index that is missing (nothing added yet, or
      // a file that cannot be read) is never taken to say that nothing is tracked.
      if (!result.ok) return { usable: false, repository: true };
      const paths = result.paths;
      const trackedDirs = result.dirs;
      // A folder inside a repository whose index names nothing below it: new and not added
      // yet, or spelled another way than git has it (letter case, a Unicode form). Either
      // way the index cannot vouch for it.
      if (prefix !== '' && paths.length === 0 && (trackedDirs?.size ?? 0) === 0) return { usable: false, repository: true };
      const lowerDirs = new Set([...(trackedDirs ?? [])].map((d) => d.toLowerCase()));
      const files: string[] = [];
      const folderModels = new Set<string>();
      const dbtDirs: string[] = [];
      const dbtFiles: string[] = [];
      let modelChecks = 0;
      let gone = 0;
      for (const rel of paths) {
        // A repository of 100,000 scripts: never one long hold of the extension host.
        if (++gone % INDEX_PATHS_AT_ONCE === 0) await new Promise<void>((resolve) => { nextTurn(resolve); });
        const name = baseName(rel);
        if (isDbtProjectFile(name)) {
          if (!this.walked(rel, Number.POSITIVE_INFINITY)) continue;
          dbtFiles.push(rel);
          const dir = dirName(rel);
          if (dir !== '') dbtDirs.push(path.join(this.root, ...dir.split('/')));
          continue;
        }
        if (!this.walked(rel, IMPORT_WALK_MAX_DEPTH) || this.isOwn(dirName(rel))) continue;
        if (/\.(sql|dbml)$/i.test(name)) {
          files.push(rel); // read before it counts, so one that is gone from disk never does
        } else if (isSemanticModelMarker(name)) {
          // A database.json is a model only with a tables/ folder beside it: any other (an app's config) costs nothing.
          const folderModel = name.toLowerCase() === 'database.json';
          if (folderModel && !lowerDirs.has(`${withSlash(dirName(rel))}tables`.toLowerCase())) continue;
          // A semantic model counts by its name alone, so see that it is still there.
          if (modelChecks++ >= MAX_INDEX_MODEL_CHECKS || !(await this.io.fileExists(joinUnder(this.root, rel)))) continue;
          files.push(rel);
          if (folderModel) folderModels.add(rel);
        }
      }
      // A tracked dbt_project.yml may be gone from disk: the first few are looked for until one is there.
      let dbtProject = false;
      for (const rel of dbtFiles.slice(0, MAX_INDEX_DBT_CHECKS)) {
        if (await this.io.fileExists(joinUnder(this.root, rel))) {
          dbtProject = true;
          break;
        }
      }
      if (timedOut) return { usable: false, repository: true };
      // Only the shallowest are ever listed: keep those, so nothing later sorts or merges the rest.
      const kept = shallowest(files, IMPORT_LIST_LIMIT + 1);
      this.indexFiles = { files: kept, folderModels, dbtProject, trackedDirs };
      return { usable: true, listing: listingOf(this.root, kept, folderModels, dbtProject, false), dbtDirs };
    })().catch((): IndexStage => ({ usable: false, repository: true }));
    try {
      return await Promise.race([read, outOfTime]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** The looks of one window: one per folder, shared by everything that asks about that folder. */
export class FolderLooks {
  private readonly runs = new Map<string, FolderLookRun>();
  private readonly io: FolderLookIo;
  private readonly settings: Required<Pick<FolderLooksOptions, 'semanticDir' | 'maxFolders' | 'maxMs' | 'indexMs'>>;
  private disposed = false;

  constructor(options: FolderLooksOptions) {
    this.io = { ...NODE_IO, ...options.io };
    this.settings = {
      semanticDir: options.semanticDir,
      maxFolders: options.maxFolders ?? FOLDER_LOOK_MAX_FOLDERS,
      maxMs: options.maxMs ?? FOLDER_LOOK_MAX_MS,
      indexMs: options.indexMs ?? FOLDER_LOOK_INDEX_MS,
    };
  }

  /**
   * The look at `root`: the one a caller is waiting on, or one that began
   * less than `maxAgeMs` ago; otherwise a new one (the folder may have
   * changed). The old one is left as it is for whoever still holds it.
   */
  run(root: string, maxAgeMs = FOLDER_LOOK_FRESH_MS): FolderLookRun {
    const key = pathKey(root);
    const current = this.runs.get(key);
    if (current?.usable(maxAgeMs)) return current;
    const run = new FolderLookRun(root, this.io, this.settings);
    if (this.disposed) run.cancel();
    this.runs.set(key, run);
    return run;
  }

  /** The look at `root` now in use, if any (never starts one). */
  peek(root: string): FolderLookRun | undefined {
    return this.runs.get(pathKey(root));
  }

  /**
   * The folders below `folders` holding `dbt_project.yml` (unsorted): each
   * folder's {@link FolderLookRun.dbtProjects}.
   */
  async dbtProjectsBelow(folders: readonly string[]): Promise<string[]> {
    return (await Promise.all(folders.map((folder) => this.run(folder).dbtProjects()))).flat();
  }

  /**
   * Whether git's index listed the tracked files of every one of `folders`:
   * every tracked `dbt_project.yml` is then known at any depth. (A project
   * git does not track is still the walk's to find, or the host search's.)
   */
  async indexed(folders: readonly string[]): Promise<boolean> {
    if (folders.length === 0) return false;
    const stages = await Promise.all(folders.map((folder) => this.run(folder).index));
    return stages.every((stage) => stage.usable);
  }

  dispose(): void {
    this.disposed = true;
    for (const run of this.runs.values()) run.cancel();
    this.runs.clear();
  }
}

/**
 * `dbt_project.yml`, in any letter case: the synchronous walk asked the disk
 * for it by name, which ignores case on Windows and macOS. Whether the
 * folder really is a project is `hasDbtProjectFile`'s to say, as before.
 */
function isDbtProjectFile(name: string): boolean {
  return name.toLowerCase() === 'dbt_project.yml';
}

/** The folders (paths under the root, never the root itself) of the `dbt_project.yml` files among a walk's marks. */
function dbtProjectFolders(marked: readonly string[]): string[] {
  return marked.filter((m) => isDbtProjectFile(baseName(m))).map(dirName).filter((dir) => dir !== '');
}

/**
 * An {@link ImportListing} from paths under `root`: each kind sorted as the
 * walk always sorted them, the shallowest {@link IMPORT_LIST_LIMIT} kept.
 */
function listingOf(root: string, files: readonly string[], folderModels: ReadonlySet<string>, dbtProject: boolean, truncated: boolean): ImportListing {
  let kept = [...files];
  if (kept.length > IMPORT_LIST_LIMIT) {
    kept = kept
      .map((file) => ({ file, depth: file.split('/').length }))
      .sort((a, b) => a.depth - b.depth || compareNames(a.file, b.file))
      .slice(0, IMPORT_LIST_LIMIT)
      .map((row) => row.file);
    truncated = true;
  }
  const sorted = kept.map((rel) => ({ rel, full: joinUnder(root, rel) })).sort((a, b) => compareNames(a.full, b.full));
  return {
    sql: sorted.filter((f) => /\.sql$/i.test(f.rel)).map((f) => f.full),
    dbml: sorted.filter((f) => /\.dbml$/i.test(f.rel)).map((f) => f.full),
    semanticModel: sorted
      .filter((f) => isSemanticModelMarker(baseName(f.rel)) && (baseName(f.rel).toLowerCase() !== 'database.json' || folderModels.has(f.rel)))
      .map((f) => f.full),
    dbtProject,
    truncated,
  };
}

/** The `keep` shallowest of `files` (paths under the root), by folder depth alone: no sort of names. */
function shallowest(files: readonly string[], keep: number): string[] {
  if (files.length <= keep) return [...files];
  const byDepth: string[][] = [];
  for (const file of files) {
    let depth = 0;
    for (let i = 0; i < file.length; i++) if (file.charCodeAt(i) === 47) depth++;
    (byDepth[depth] ??= []).push(file);
  }
  const kept: string[] = [];
  for (const level of byDepth) {
    if (!level) continue;
    for (const file of level) {
      if (kept.length >= keep) return kept;
      kept.push(file);
    }
  }
  return kept;
}

/** A path under `root`, joined as the walk always has (`/`, whatever the platform). */
function joinUnder(root: string, rel: string): string {
  return root.endsWith('/') || root.endsWith('\\') ? `${root}${rel}` : `${root}/${rel}`;
}

function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** The folder of a path under the root ('' for one directly in it). */
function dirName(rel: string): string {
  const cut = rel.lastIndexOf('/');
  return cut < 0 ? '' : rel.slice(0, cut);
}

/** A folder path ready to have a name appended ('' stays ''). */
function withSlash(dir: string): string {
  return dir === '' ? '' : `${dir}/`;
}

