/**
 * The one walk of the open folder. Every look that needs to know what the
 * folder holds (a dbt project below it? `.sql` files? a semantic model? a
 * `.dbml` file?) reads this walk instead of making its own.
 *
 * It replaces three walks that, on a large repository on Windows, ran out of
 * time at startup (#347): one was synchronous and held the extension host,
 * another listed a folder at a time through a VS Code API (a round trip to
 * another process per folder), had no limit on folders and started again from
 * the top when its deadline passed. So this walk is:
 *
 * - **Asynchronous, with at most two listings in flight** (`concurrency`). A
 *   listing is one `fs.promises.readdir` on the host's own thread pool, and
 *   the host is free between listings.
 * - **Bounded by folders listed** (`maxFolders`), not by a deadline that
 *   throws the work away: a walk that stops says so (`capped`) and keeps what
 *   it found. `maxMs` is a second bound, and a listing that never answers
 *   cannot hold the walk past it. What it holds in memory is bounded too: of
 *   a depth of a million folders, only those it can still list are kept.
 * - **Breadth first, strictly depth by depth**, so a bound keeps the
 *   shallowest folders, and **the same on every run**: each folder's listing
 *   goes into the folder's own slot and slots are read in order, so which
 *   listing answers first changes nothing.
 * - **Demand-driven.** Nothing is listed until a caller asks (`reach`), and
 *   only as deep as some caller has asked: finding a dbt project six folders
 *   down never pays for sixteen. A caller can also bound its own wait by
 *   folders listed; when nobody wants another folder the walk pauses, even
 *   in the middle of a depth, rather than run on for nobody. What was found
 *   is kept, so a later ask carries on from the next folder and no folder is
 *   listed twice.
 * - **Each real folder once.** Symbolic links to folders (and Windows
 *   junctions) are followed, but a folder already reached another way is not
 *   walked again, which also ends a link that loops back on its parent.
 *
 * Nothing here throws or rejects: a folder that cannot be listed is skipped.
 *
 * Pure Node (`fs`, `path`): no `vscode` and no other module of `src/`, so the
 * extension host, the CLI and a worker can all bundle it.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * The next turn of the event loop, taken when the module loads: a turn of the
 * loop is not a timer, and a test's fake clock must not be able to hold the
 * walk's notifications.
 */
const nextTurn: (callback: () => void) => unknown = setImmediate;

/** One entry of a folder: `link` is a symbolic link (or a Windows junction / reparse point), not yet resolved. */
export interface ScanEntry { name: string; kind: 'file' | 'dir' | 'link' }

/** How the walk reads the disk (injected, so tests count listings). */
export interface ScanReader {
  /** One folder's entries. Rejects when the folder cannot be listed. */
  readDir(folder: string): Promise<readonly ScanEntry[]>;
  /** What a symbolic link points at: a folder (with its real path) or a file; undefined when it dangles. */
  resolveLink(linkPath: string): Promise<{ isDirectory: boolean; realPath: string } | undefined>;
  /** A folder's real path (the walk asks once, for its root). */
  realPath(folder: string): Promise<string>;
}

/** The real disk, through `fs.promises` (no VS Code API: a listing never leaves the extension host). */
export const nodeScanReader: ScanReader = {
  async readDir(folder) {
    const entries = await fs.promises.readdir(folder, { withFileTypes: true });
    return entries.map((entry): ScanEntry => ({
      name: entry.name,
      // The link test comes first: a link to a folder is not `isDirectory()`,
      // and on Windows a junction is reported as a link too.
      kind: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : 'file',
    }));
  },
  async resolveLink(linkPath) {
    let isDirectory: boolean;
    try {
      // `stat` follows the link: it rejects for one that dangles (or loops on itself).
      isDirectory = (await fs.promises.stat(linkPath)).isDirectory();
    } catch {
      return undefined;
    }
    if (!isDirectory) return { isDirectory: false, realPath: linkPath };
    try {
      return { isDirectory: true, realPath: await fs.promises.realpath(linkPath) };
    } catch {
      return { isDirectory: true, realPath: linkPath };
    }
  },
  realPath: (folder) => fs.promises.realpath(folder),
};

/** One folder's entries as `[name, isDirectory]`, a link to a folder counting as a folder and a dangling link left out (`fs.promises`; rejects when the folder cannot be listed). */
export async function nodeReadDirEntries(folder: string): Promise<Array<readonly [name: string, isDirectory: boolean]>> {
  const entries: Array<readonly [name: string, isDirectory: boolean]> = [];
  for (const entry of await nodeScanReader.readDir(folder)) {
    if (entry.kind !== 'link') {
      entries.push([entry.name, entry.kind === 'dir']);
      continue;
    }
    const target = await nodeScanReader.resolveLink(path.join(folder, entry.name));
    if (target) entries.push([entry.name, target.isDirectory]);
  }
  return entries;
}

export interface FolderScanOptions {
  /** Folder names never entered (compared exactly). */
  ignoredFolders: ReadonlySet<string>;
  /** Folders never entered, by their path under the root (`/`-joined, e.g. `.erd-studio`). */
  skipFolder?: (relPath: string) => boolean;
  /** File names collected into `files` (at most `maxFiles`). */
  include: (name: string, folder: string) => boolean;
  /** Entries noted in `marked` whatever `maxFiles` says (a file or a folder; a marked folder is still entered or skipped by the usual rules). */
  mark?: (name: string, isDirectory: boolean, folder: string) => boolean;
  /** Most folders listed in all. */
  maxFolders: number;
  /** The deepest folder listed (the root is 0). */
  maxDepth: number;
  /** Most files kept in `files`; more sets `truncated` (the shallowest are kept). */
  maxFiles: number;
  /** Listings in flight at once. Default 2. */
  concurrency?: number;
  /** Which folders of one depth are listed first: lower first (default 0 for all). Called with the folder's path under the root. */
  rank?: (relPath: string) => number;
  /** Orders names within one rank (default: code-unit order). */
  compare?: (a: string, b: string) => number;
  /** Stop listing after this many milliseconds of walking (default: no limit). */
  maxMs?: number;
  /** The clock (tests). Default Date.now. */
  now?: () => number;
}

export interface ScanSnapshot {
  /** Files `include` accepted, as paths under the root (`/`-joined), in the order found (depth by depth). */
  files: string[];
  /** Entries `mark` accepted, as paths under the root (`/`-joined). */
  marked: string[];
  /** Folders listed so far (a folder that could not be listed counts). */
  folders: number;
  /** Every folder down to this depth has been listed (-1 before the root is). */
  depthDone: number;
  /** The walk is over (finished, stopped by a limit, or cancelled). */
  done: boolean;
  /** It stopped at `maxFolders` or `maxMs` with folders left unlisted. */
  capped: boolean;
  /** More than `maxFiles` files matched. */
  truncated: boolean;
}

/** A folder waiting for its depth's turn. */
interface QueuedFolder {
  /** Its path under the root (`''` for the root). */
  rel: string;
  /** Its real path: what tells two ways into one folder apart. */
  real: string;
  /** Its place among the folders of its depth (`rank`, asked once). */
  rank: number;
}

/** One `reach` still waiting. */
interface Waiter {
  /** The depth it asked for. */
  depth: number;
  /** Its own bound on folders listed in all (`Infinity`: none). */
  maxFolders: number;
  resolve: () => void;
}

/** What one folder's listing yielded (`files` and `marked` in order). It waits in the folder's slot until every slot before it has answered. */
interface Listing {
  files: string[];
  marked: string[];
  folders: FoundFolder[];
}

/** A folder a listing found for the next depth: `linked` when it was reached through a symbolic link. */
interface FoundFolder { rel: string; real: string; linked: boolean }

/** How far past a limit a list may grow before {@link keepFirst} cuts it back. */
const KEEP_SLACK = 256;

/**
 * Cuts `items` back to its first `keep` in `order` once it holds far more
 * than that. A limit drops the rest anyway, so a folder of a million entries
 * is never held, or sorted, in full. Which items survive does not depend on
 * the order they arrived in.
 */
function keepFirst<T>(items: T[], keep: number, order: (a: T, b: T) => number, onDrop?: (item: T) => void): void {
  if (items.length <= 2 * keep + KEEP_SLACK) return;
  items.sort(order);
  if (onDrop) for (let i = keep; i < items.length; i++) onDrop(items[i]);
  items.length = keep;
}

/** The answer of a read that was abandoned because the walk ended first. */
const STOPPED = Symbol('stopped');
/** The answer of a read the disk refused. */
const FAILED = Symbol('failed');
type Guarded<T> = T | typeof STOPPED | typeof FAILED;

/** The longest delay a timer takes; a longer one would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Code-unit order: the same on every machine, in every locale. */
function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A limit as a whole number no lower than `least` (anything that is not a number counts as `least`). */
function wholeLimit(value: number, least: number): number {
  return typeof value === 'number' && !Number.isNaN(value) ? Math.max(least, Math.floor(value)) : least;
}

/** `name` inside `folder`, joined with `/` whatever the platform (`C:\repo` gives `C:\repo/a`, which Windows reads). */
function below(folder: string, name: string): string {
  return folder.endsWith('/') || folder.endsWith('\\') ? `${folder}${name}` : `${folder}/${name}`;
}

/**
 * One walk of one folder, shared by everyone who asks about it: `reach(depth)`
 * (or `finish()`) to have it listed that deep, `snapshot()` for what it has
 * found, `onProgress` to hear as it finds more.
 *
 * - `depthDone` is `maxDepth` once nothing is left to list, however shallow
 *   the folder turned out to be.
 * - The option `maxFolders` bounds the walk; `reach(depth, maxFolders)` bounds
 *   one caller's wait. A walk nobody wants more of is paused, not over
 *   (`done` and `capped` stay false), and carries on from the next folder
 *   when somebody asks again.
 * - `maxMs` counts time spent walking. A pause is not walking, so a look made
 *   long after startup still has whatever time startup left.
 * - `compare` is given paths under the root (two entries of one folder differ
 *   only in their last part); what it calls equal is settled by code-unit
 *   order, so the order never depends on the disk's.
 * - A folder reached both directly and through a link at the same depth keeps
 *   its own path; reached at two depths, the shallower way in is the one walked.
 */
export class FolderScan {
  private readonly maxFolders: number;
  private readonly maxDepth: number;
  private readonly maxFiles: number;
  private readonly maxMs: number | undefined;
  private readonly concurrency: number;

  private readonly files: string[] = [];
  private readonly marked: string[] = [];
  private folders = 0;
  private depthDone = -1;
  private done = false;
  private capped = false;
  /** `maxMs` ended the walk. Recorded when it does: a timer may fire a millisecond before the clock agrees. */
  private timedOut = false;
  private truncated = false;

  private started = false;
  /** The `reach` calls still waiting, each for its depth and with its own bound on folders. */
  private waiters: Waiter[] = [];
  /** Wake the workers that found nobody wanting another folder. */
  private wakers: Array<() => void> = [];
  /** Folders whose listing has been read into `files` and `marked`: always the first ones in walk order. */
  private foldersMerged = 0;
  /** Listings in flight. */
  private busy = 0;

  /** Real paths of every folder queued so far: a folder is walked once, however many links lead to it. */
  private readonly seen = new Set<string>();
  /** The depth being listed, or about to be (`openDepth`). */
  private depth = 0;
  /** That depth's folders, in listing order. */
  private level: QueuedFolder[] = [];
  /** One slot per folder of `level`, filled as its listing answers. */
  private slots: Array<Listing | undefined> = [];
  /** Slots whose listing has started (always the first ones: folders are taken in order). */
  private slotsTaken = 0;
  /** Slots already read into `files`, `marked` and `next` (always the first ones: slots are read in order). */
  private slotsMerged = 0;
  /** The folders found for the next depth (put in order when the depth ends). */
  private next: QueuedFolder[] = [];
  /** Links to folders found for the next depth. They wait for the depth to end, so a folder also reached directly keeps its own path. */
  private nextLinked: QueuedFolder[] = [];
  /** How many folders of the next depth are worth keeping: those `maxFolders` still allows, and one more to know some were left. */
  private nextKept = Infinity;

  /** Reads in flight, each as the function that abandons it. */
  private readonly inFlight = new Set<() => void>();
  /** Time spent walking before the last pause. */
  private walkedMs = 0;
  /** When the walk last started or carried on (undefined while it is paused, or with no `maxMs`). */
  private walkingSince: number | undefined;

  private readonly listeners = new Set<{ call: () => void }>();
  private notifyQueued = false;

  constructor(
    private readonly root: string,
    private readonly reader: ScanReader,
    private readonly options: FolderScanOptions,
  ) {
    this.maxFolders = wholeLimit(options.maxFolders, 0);
    this.maxDepth = wholeLimit(options.maxDepth, 0);
    this.maxFiles = wholeLimit(options.maxFiles, 0);
    this.maxMs = typeof options.maxMs === 'number' && Number.isFinite(options.maxMs) ? options.maxMs : undefined;
    this.concurrency = options.concurrency === undefined ? 2 : wholeLimit(options.concurrency, 1);
  }

  /**
   * List folders down to `depth`; resolves when every folder at that depth and above has been listed,
   * or `maxFolders` folders have been listed in all (default: no limit of its own), or the walk is over.
   *
   * The walk starts on the first call and never goes back up. It lists a
   * folder only while some call still waiting wants it, so with this caller
   * alone exactly `maxFolders` folders are listed and the walk then pauses
   * (it is not `done`); what `snapshot()` holds is those folders, the first
   * in walk order. Never rejects.
   */
  reach(depth: number, maxFolders?: number): Promise<void> {
    const waiter: Waiter = {
      depth: Math.min(this.maxDepth, wholeLimit(depth, 0)),
      maxFolders: maxFolders === undefined ? Infinity : wholeLimit(maxFolders, 0),
      resolve: () => undefined,
    };
    if (this.served(waiter)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      waiter.resolve = resolve;
      this.waiters.push(waiter);
      this.wakeWorkers();
      if (!this.started) {
        this.started = true;
        // Whatever goes wrong inside, the walk ends: a waiting caller is never left waiting.
        this.walk().catch(() => undefined).then(() => this.end(false));
      }
    });
  }

  /** `reach(maxDepth)`: the whole walk. */
  finish(): Promise<void> {
    return this.reach(this.maxDepth);
  }

  /** What has been found so far. */
  snapshot(): ScanSnapshot {
    const files = this.files.slice();
    const marked = this.marked.slice();
    let truncated = this.truncated;
    // Mid-depth: the listings that answered ahead of an earlier folder's, in slot order.
    for (let slot = this.slotsMerged; slot < this.slotsTaken; slot++) {
      const listing = this.slots[slot];
      if (!listing) continue;
      for (const rel of listing.marked) marked.push(rel);
      for (const rel of listing.files) {
        if (files.length >= this.maxFiles) { truncated = true; break; }
        files.push(rel);
      }
    }
    return { files, marked, folders: this.folders, depthDone: this.depthDone, done: this.done, capped: this.capped, truncated };
  }

  /**
   * The folders found but not yet listed, as paths under the root: the rest of the depth being
   * listed (in listing order), then the folders queued for the next depth (links to folders
   * included). Empty once the walk is over. A snapshot: what it holds changes as the walk goes on.
   *
   * "Not yet listed" is a listing not yet started; the next depth's folders
   * are those of the listings already read (`snapshot()`'s `folders`, less
   * any still in flight), given in the order they would be listed. A link is
   * left out when the folder it points at is already listed or queued, as it
   * will be when its depth ends. Nothing is read from the disk.
   */
  pending(): string[] {
    if (this.done) return [];
    const paths: string[] = [];
    for (let slot = this.slotsTaken; slot < this.level.length; slot++) paths.push(this.level[slot].rel);
    const queued = this.next.slice();
    const linkedTo = new Set<string>();
    for (const linked of this.nextLinked.slice().sort(this.listingOrder)) {
      if (this.seen.has(linked.real) || linkedTo.has(linked.real)) continue;
      linkedTo.add(linked.real);
      queued.push(linked);
    }
    for (const folder of queued.sort(this.listingOrder)) paths.push(folder.rel);
    return paths;
  }

  /** Called (at most once per event-loop turn) after new files or marks were found, and once when the walk is over. Returns the function that removes the listener. */
  onProgress(listener: () => void): () => void {
    const entry = { call: listener };
    this.listeners.add(entry);
    return () => { this.listeners.delete(entry); };
  }

  /** Stop: no more listings start; `done` becomes true and every waiting `reach` resolves. */
  cancel(): void {
    this.end(false);
  }

  // ── The walk ────────────────────────────────────────────────────────────

  /** Depth by depth from the root, each folder only once somebody wants it (`listDepth` waits to be asked). */
  private async walk(): Promise<void> {
    this.startClock();
    const real = await this.guarded(() => this.reader.realPath(this.root));
    if (this.done) return;
    const rootReal = typeof real === 'string' ? real : this.root;
    this.seen.add(rootReal);
    this.openDepth([{ rel: '', real: rootReal, rank: 0 }], 0);
    // `depthListed` opens the next depth, or ends the walk when there is none.
    while (!this.done) {
      const level = this.level;
      const complete = await this.listDepth(level, this.depth);
      if (this.done) return;
      if (!complete) this.end(true);
      // A depth that was listed has been replaced by the next one. Should it ever not be, end: never list it again.
      else if (this.level === level) this.end(false);
    }
  }

  /** Makes `level` the depth being listed: a slot per folder, none taken yet. */
  private openDepth(level: QueuedFolder[], depth: number): void {
    this.level = level;
    this.depth = depth;
    this.slots = new Array<Listing | undefined>(level.length);
    this.slotsTaken = 0;
    this.slotsMerged = 0;
    this.nextKept = Math.max(0, this.maxFolders - this.folders - level.length) + 1;
  }

  /**
   * The depth's last folder has been read: every folder down to this depth
   * has now been listed. Opens the next depth, or ends the walk when nothing
   * is left. Done in the same step as that last read, so whoever it lets go
   * finds `depthDone`, `done` and `pending()` already saying so.
   */
  private depthListed(): void {
    // Ordinary folders are all queued by now: a link to one of them is dropped, never the folder itself.
    // Of two links to one folder, the one that would be listed first is kept.
    for (const linked of this.nextLinked.sort(this.listingOrder)) this.queue(linked);
    this.nextLinked = [];
    this.depthDone = this.depth;
    const level = this.next.sort(this.listingOrder);
    if (level.length > this.nextKept) level.length = this.nextKept;
    this.next = [];
    if (level.length > 0) {
      this.openDepth(level, this.depth + 1);
      return;
    }
    // Nothing is left to list, so every depth the walk may go to is done.
    this.depthDone = this.maxDepth;
    this.end(false);
  }

  /**
   * Lists the open depth's folders, in order, `concurrency` at a time, each only
   * while somebody wants it: a worker that finds nobody asking waits (no
   * polling) before taking its next folder, and carries on with the same
   * depth when a later `reach` asks for more. False when `maxFolders`
   * stopped it with folders left: the listings already started are waited
   * for, so the folders visited are the same on every run.
   */
  private async listDepth(level: readonly QueuedFolder[], depth: number): Promise<boolean> {
    let complete = true;
    const worker = async (): Promise<void> => {
      // `this.level` is another list once this depth has been listed: its workers have nothing more to take.
      while (!this.done && complete && this.level === level && this.slotsTaken < level.length) {
        if (!this.wanted(depth)) {
          this.restIfUnwanted();
          await new Promise<void>((resolve) => { this.wakers.push(resolve); });
          continue;
        }
        if (this.folders >= this.maxFolders) {
          complete = false;
          return;
        }
        this.startClock();
        const msLeft = this.msLeft();
        if (msLeft !== undefined && msLeft <= 0) {
          this.endOutOfTime();
          return;
        }
        const slot = this.slotsTaken++;
        this.folders++;
        this.busy++;
        const listing = await this.listFolder(level[slot], depth, msLeft);
        this.busy--;
        // Over while this was in flight (cancelled, or out of time): what had answered by then is all that counts.
        if (this.done) return;
        this.slots[slot] = listing;
        this.mergeSlots();
        // Before whoever that let go runs: a clock they read (or move) must already be stopped.
        this.restIfUnwanted();
        if (listing.files.length > 0 || listing.marked.length > 0) this.notifySoon();
      }
    };
    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < Math.min(this.concurrency, level.length); i++) workers.push(worker());
    await Promise.all(workers);
    return complete;
  }

  /**
   * One folder's listing, sorted. Empty when the folder cannot be listed (or
   * the walk ended first). `msLeft` is the time the caller just found left, so
   * a folder counted as listed is always asked for.
   */
  private async listFolder(folder: QueuedFolder, depth: number, msLeft: number | undefined): Promise<Listing> {
    const listing: Listing = { files: [], marked: [], folders: [] };
    const folderPath = folder.rel === '' ? this.root : below(this.root, folder.rel);
    const entries = await this.guarded(() => this.reader.readDir(folderPath), msLeft);
    if (entries === STOPPED || entries === FAILED) return listing;
    try {
      for (const entry of entries) {
        const name = entry.name;
        if (name === '' || name === '.' || name === '..') continue;
        let isDirectory = entry.kind === 'dir';
        let real: string | undefined;
        if (entry.kind === 'link') {
          // Only a link is asked about: a plain file or folder costs no system call.
          const target = await this.guarded(() => this.reader.resolveLink(below(folderPath, name)));
          if (target === STOPPED) return listing;
          if (target === FAILED || !target) continue;
          isDirectory = target.isDirectory === true;
          real = target.realPath;
        }
        const rel = folder.rel === '' ? name : `${folder.rel}/${name}`;
        if (!isDirectory) {
          if (this.marks(name, false, folder.rel)) listing.marked.push(rel);
          if (this.includes(name, folder.rel)) {
            listing.files.push(rel);
            // One more than can be kept is enough to know there were more.
            keepFirst(listing.files, this.maxFiles + 1, this.pathOrder);
          }
          continue;
        }
        if (this.options.ignoredFolders.has(name)) continue;
        if (this.marks(name, true, folder.rel)) listing.marked.push(rel);
        if (depth >= this.maxDepth || this.skips(rel)) continue;
        // An ordinary folder's real path is its parent's plus its name (no system call); a link's is where it points.
        listing.folders.push(typeof real === 'string'
          ? { rel, real, linked: true }
          : { rel, real: path.join(folder.real, name), linked: false });
      }
    } catch {
      // A listing that is not a list of entries: keep what was read of it.
    }
    // The disk's own order differs between machines; this one does not.
    // (The folders are put in order with the rest of their depth.)
    listing.files.sort(this.pathOrder);
    listing.marked.sort(this.pathOrder);
    if (listing.files.length > this.maxFiles + 1) listing.files.length = this.maxFiles + 1;
    return listing;
  }

  /**
   * Reads every slot that has answered and has no unanswered slot before it,
   * one folder at a time: a caller waiting for its own number of folders is
   * let go at exactly that many, the first in walk order.
   */
  private mergeSlots(): void {
    while (this.slotsMerged < this.slotsTaken) {
      const listing = this.slots[this.slotsMerged];
      if (!listing) return;
      this.slots[this.slotsMerged++] = undefined;
      this.merge(listing);
      this.foldersMerged++;
      if (this.slotsMerged === this.slots.length) this.depthListed();
      this.releaseWaiters();
    }
  }

  private merge(listing: Listing): void {
    for (const rel of listing.marked) this.marked.push(rel);
    for (const rel of listing.files) {
      // Past `maxFiles` the walk goes on: marks and deeper folders still matter to other callers.
      if (this.files.length >= this.maxFiles) { this.truncated = true; break; }
      this.files.push(rel);
    }
    // Once the walk is over there is no next depth to queue for.
    if (this.done) return;
    for (const child of listing.folders) {
      const folder: QueuedFolder = { rel: child.rel, real: child.real, rank: this.rankOf(child.rel) };
      if (child.linked) this.nextLinked.push(folder);
      else this.queue(folder);
    }
  }

  /**
   * Queues a folder for the next depth unless its real path is already
   * queued: that ends a link that loops back, and keeps a link from walking a
   * folder a second time. Two ordinary folders never share a real path, and
   * links are queued in listing order once their depth has ended, so two ways
   * into one folder resolve the same way on every run.
   *
   * Only the folders `maxFolders` can still reach are kept: a depth of a
   * million folders is not held in full to list the first few thousand.
   */
  private queue(folder: QueuedFolder): void {
    if (this.seen.has(folder.real)) return;
    this.seen.add(folder.real);
    this.next.push(folder);
    keepFirst(this.next, this.nextKept, this.listingOrder, (dropped) => this.seen.delete(dropped.real));
  }

  // ── Ending, waiting, telling ────────────────────────────────────────────

  /** `maxMs` ran out: the walk is over, and has no time left whatever the clock reads when it is next asked. */
  private endOutOfTime(): void {
    if (!this.done) this.timedOut = true;
    this.end(true);
  }

  /** The walk is over. Reads still in flight are abandoned, and whoever waits is let go. */
  private end(capped: boolean): void {
    if (this.done) return;
    this.done = true;
    if (capped) this.capped = true;
    this.stopClock();
    for (const abandon of [...this.inFlight]) abandon();
    // Listings that answered ahead of an abandoned one were still found.
    for (let slot = this.slotsMerged; slot < this.slotsTaken; slot++) {
      const listing = this.slots[slot];
      if (listing) this.merge(listing);
    }
    this.slots = [];
    this.slotsTaken = 0;
    this.slotsMerged = 0;
    this.next = [];
    this.nextLinked = [];
    this.level = [];
    this.releaseWaiters();
    this.wakeWorkers();
    this.notifySoon();
  }

  /** Whether a `reach` has what it asked for: its depth, its own number of folders, or a walk that is over. */
  private served(waiter: Waiter): boolean {
    return this.done || waiter.depth <= this.depthDone || this.foldersMerged >= waiter.maxFolders;
  }

  /**
   * Whether some call still waiting wants another folder of `depth` listed.
   * Counted in listings started, so a caller's own bound is never overshot
   * by the listings in flight.
   */
  private wanted(depth: number): boolean {
    return this.waiters.some((waiter) => waiter.depth >= depth && this.folders < waiter.maxFolders);
  }

  private releaseWaiters(): void {
    if (!this.waiters.some((waiter) => this.served(waiter))) return;
    const waiting = this.waiters;
    this.waiters = [];
    for (const waiter of waiting) {
      if (this.served(waiter)) waiter.resolve();
      else this.waiters.push(waiter);
    }
  }

  /** Every waiting worker looks again: somebody new is asking, or the walk is over. */
  private wakeWorkers(): void {
    const waking = this.wakers;
    this.wakers = [];
    for (const wake of waking) wake();
  }

  /** One notification for everything found in this turn of the event loop. */
  private notifySoon(): void {
    if (this.notifyQueued || this.listeners.size === 0) return;
    this.notifyQueued = true;
    nextTurn(() => {
      this.notifyQueued = false;
      for (const listener of [...this.listeners]) {
        try {
          listener.call();
        } catch {
          // A listener's failure is its own.
        }
      }
    });
  }

  // ── Time ────────────────────────────────────────────────────────────────

  private clock(): number {
    try {
      return this.options.now ? this.options.now() : Date.now();
    } catch {
      return Date.now();
    }
  }

  /**
   * Stops the clock when no listing is in flight and nobody wants another
   * folder: the walk is paused, and a pause is not walking.
   */
  private restIfUnwanted(): void {
    if (this.busy === 0 && !this.wanted(this.depthDone + 1)) this.stopClock();
  }

  /** Starts the clock, or leaves it running. */
  private startClock(): void {
    if (this.maxMs !== undefined && this.walkingSince === undefined) this.walkingSince = this.clock();
  }

  private stopClock(): void {
    if (this.walkingSince === undefined) return;
    this.walkedMs += Math.max(0, this.clock() - this.walkingSince);
    this.walkingSince = undefined;
  }

  /**
   * Milliseconds of `maxMs` left, never below 0 (undefined: no limit): what a
   * countdown shows. A pause uses none. 0 once `maxMs` has ended the walk,
   * which is how a caller tells that limit from `maxFolders`: the timer that
   * ends it can fire a millisecond early by the clock, and the time walked
   * then adds up to just under `maxMs`.
   */
  timeLeftMs(): number | undefined {
    if (this.timedOut) return 0;
    const left = this.msLeft();
    return left === undefined ? undefined : Math.max(0, left);
  }

  /** Milliseconds of `maxMs` left (undefined: no limit). A pause, waiting for somebody to ask for more, uses none. */
  private msLeft(): number | undefined {
    if (this.maxMs === undefined) return undefined;
    const walking = this.walkingSince === undefined ? 0 : Math.max(0, this.clock() - this.walkingSince);
    return this.maxMs - this.walkedMs - walking;
  }

  /**
   * One read of the disk that can hold nothing up: it answers `FAILED` when
   * the read is refused, and `STOPPED` when the walk ends first (cancelled,
   * or `maxMs` ran out while it was in flight, which ends the walk). A read
   * abandoned that way may still answer later; nobody is listening, and its
   * rejection is already handled.
   */
  private guarded<T>(read: () => Promise<T>, left: number | undefined = this.msLeft()): Promise<Guarded<T>> {
    if (this.done) return Promise.resolve(STOPPED);
    if (left !== undefined && left <= 0) {
      this.endOutOfTime();
      return Promise.resolve(STOPPED);
    }
    return new Promise<Guarded<T>>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (answer: Guarded<T>): void => {
        if (!this.inFlight.delete(abandon)) return;
        if (timer !== undefined) clearTimeout(timer);
        resolve(answer);
      };
      const abandon = (): void => settle(STOPPED);
      this.inFlight.add(abandon);
      if (left !== undefined && left <= MAX_TIMER_MS) timer = setTimeout(() => this.endOutOfTime(), left);
      let pending: Promise<T>;
      try {
        pending = Promise.resolve(read());
      } catch {
        settle(FAILED);
        return;
      }
      pending.then(settle, () => settle(FAILED));
    });
  }

  // ── The caller's functions, none of which can stop the walk ─────────────

  private includes(name: string, folder: string): boolean {
    try {
      return Boolean(this.options.include(name, folder));
    } catch {
      return false;
    }
  }

  private marks(name: string, isDirectory: boolean, folder: string): boolean {
    if (!this.options.mark) return false;
    try {
      return Boolean(this.options.mark(name, isDirectory, folder));
    } catch {
      return false;
    }
  }

  private skips(relPath: string): boolean {
    if (!this.options.skipFolder) return false;
    try {
      return Boolean(this.options.skipFolder(relPath));
    } catch {
      return false;
    }
  }

  private rankOf(relPath: string): number {
    if (!this.options.rank) return 0;
    try {
      const rank = this.options.rank(relPath);
      return typeof rank === 'number' && !Number.isNaN(rank) ? rank : 0;
    } catch {
      return 0;
    }
  }

  /** The caller's order, with code-unit order settling whatever it leaves equal: two different paths never tie. */
  private readonly pathOrder = (a: string, b: string): number => {
    if (this.options.compare) {
      try {
        const result = this.options.compare(a, b);
        if (result < 0 || result > 0) return result;
      } catch {
        // Fall through to code-unit order.
      }
    }
    return codeUnitOrder(a, b);
  };

  /** The order one depth's folders are listed in: lower rank first, then by path. */
  private readonly listingOrder = (a: QueuedFolder, b: QueuedFolder): number =>
    (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : this.pathOrder(a.rel, b.rel));
}
