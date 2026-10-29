/**
 * Reading the table library in the background, a few milliseconds at a time.
 *
 * Opening a diagram reads each of its tables; on a large library, the first
 * open after VS Code starts read hundreds of files while the extension host
 * could do nothing else. After activation this reads every table file the
 * caches do not hold yet, in slices of {@link WARM_UP_SLICE_MS}, giving the
 * event loop back between slices, so the first open finds its tables read
 * and the host never blocks for long. Then it reads the relationships files
 * (one per slice) and works out the library's relationships once, so the
 * first table edit finds them worked out too.
 *
 * It steps aside for the user: any foreground work (a canvas message, a
 * diagram opening) pushes the next slice back until the host has been quiet
 * for {@link WARM_UP_QUIET_MS}. Reads go through the library's caches, which
 * check every file's mtime + size, so a file changed meanwhile is simply
 * read again by whoever needs it.
 *
 * No `vscode`.
 */

/** How long one background slice may read before giving the event loop back. */
export const WARM_UP_SLICE_MS = 12;
/** How long the host must be free of foreground work before the next slice runs. */
export const WARM_UP_QUIET_MS = 300;

/**
 * The timer a yield waits on, taken when this module loads: a yield must
 * reach the real event loop (that is where a posted message leaves the
 * host), even under a test's fake timers installed later.
 */
const realSetTimeout = globalThis.setTimeout;

/** Resolve on the next turn of the event loop (after timers and I/O already queued, posted messages included). */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => { realSetTimeout(resolve, 0); });
}

/** What the warm-up reads through (`TableLibraryService`). */
export interface WarmUpLibrary<E> {
  /** Table files not read in their current version. */
  unreadTableFiles(): E[];
  /** Read one into the cache; never throws. */
  warmTableFile(entry: E): void;
  /** The relationships files, each read in a slice of its own before the attach. */
  listRelationshipsFiles?(): string[];
  /** Read one relationships file into the cache. */
  readRelationshipsFile?(filePath: string): unknown;
  /** Work out the library's relationships once; never throws. */
  warmLibraryAttachment(): void;
}

export interface WarmUpOptions {
  sliceMs?: number;
  quietMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

export type WarmUpOutcome = 'done' | 'cancelled';

export class LibraryWarmUp<E> {
  private readonly sliceMs: number;
  private readonly quietMs: number;
  private readonly now: () => number;
  private lastForeground = Number.NEGATIVE_INFINITY;
  private disposed = false;
  private started: Promise<WarmUpOutcome> | undefined;
  /** Files read by the last {@link start} (tests and benchmarks). */
  filesRead = 0;
  /** Slices run by the last {@link start} (tests and benchmarks). */
  slices = 0;

  constructor(private readonly library: WarmUpLibrary<E>, options: WarmUpOptions = {}) {
    this.sliceMs = options.sliceMs ?? WARM_UP_SLICE_MS;
    this.quietMs = options.quietMs ?? WARM_UP_QUIET_MS;
    this.now = options.now ?? Date.now;
  }

  /** Start the pass after `delayMs` (once; later calls return the same pass). Resolves when it finished or was disposed. */
  start(delayMs = 0): Promise<WarmUpOutcome> {
    this.started ??= this.run(delayMs);
    return this.started;
  }

  /** Foreground work started: the next slice waits until the host has been quiet for the quiet period. */
  noteForegroundWork(): void {
    this.lastForeground = this.now();
  }

  /** Stop at the next slice boundary. */
  dispose(): void {
    this.disposed = true;
  }

  private relationshipsFiles(): string[] {
    try {
      return this.library.listRelationshipsFiles?.() ?? [];
    } catch {
      return [];
    }
  }

  private async run(delayMs: number): Promise<WarmUpOutcome> {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    let queue: E[] | undefined;
    let relationshipsFiles: string[] | undefined;
    let attached = false;
    while (!this.disposed) {
      const wait = this.lastForeground + this.quietMs - this.now();
      if (wait > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
        continue;
      }
      // Listed after the first quiet stretch, so files an open just read are not queued.
      queue ??= this.library.unreadTableFiles();
      const started = this.now();
      if (queue.length > 0) {
        this.slices++;
        do {
          this.library.warmTableFile(queue.shift() as E);
          this.filesRead++;
        } while (queue.length > 0 && this.now() - started < this.sliceMs);
      } else if ((relationshipsFiles ??= this.relationshipsFiles()).length > 0) {
        // A relationships file is one parse: one per slice, however long.
        this.slices++;
        const file = relationshipsFiles.shift() as string;
        try {
          this.library.readRelationshipsFile?.(file);
        } catch {
          // Reported where it is used.
        }
      } else if (!attached) {
        attached = true;
        this.library.warmLibraryAttachment();
      } else {
        return 'done';
      }
      await yieldToEventLoop();
    }
    return 'cancelled';
  }
}
