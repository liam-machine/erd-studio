/**
 * The files a git repository tracks, read from its index. A folder look that
 * walks the directories runs out of time on a large Windows repository; when
 * the folder is inside a git repository, `.git/index` already lists every
 * tracked path in ONE file, so "which `.sql`, `.dbml` and `dbt_project.yml`
 * files are here?" is answered in milliseconds whatever the folder count
 * (#347).
 *
 * ERD Studio never runs the `git` binary: this reads the repository's own
 * files (`.git`, `index`, `sharedindex.*`) and nothing else. Anything
 * unexpected is a failure reason, never a guess and never a throw; the caller
 * then falls back to the walk.
 *
 * What the index does not say: a file not yet added is not listed, and a
 * listed file may be gone from disk (deleted, or outside a sparse checkout).
 * Callers check a file exists before using it.
 *
 * The format is git's `Documentation/gitformat-index.txt`: a 12-byte header
 * (`DIRC`, version, entry count), the entries sorted by path, then extensions,
 * then a checksum. Versions 2 and 3 pad each entry to a multiple of 8 bytes;
 * version 4 stores each path as "drop N bytes from the end of the previous
 * path, then append". The object id is 20 bytes (SHA-1) or 32 (SHA-256) and
 * the file does not say which, so it is read as 20 and, when that does not
 * add up, as 32.
 *
 * Pure Node (`fs`, `path`), no `vscode`.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';

/** Where a folder's git index is. */
export interface GitIndexLocation {
  /** The working tree's top folder: the nearest folder at or above the start that holds `.git`. */
  workTree: string;
  /** The git folder: `<workTree>/.git`, or where a `.git` file's `gitdir:` line points. */
  gitDir: string;
  /** `<gitDir>/index`. */
  indexPath: string;
}

export type GitIndexFailure =
  | 'missing'      // no index file (nothing added yet), or it cannot be read
  | 'tooLarge'     // larger than maxBytes
  | 'notIndex'     // does not start with DIRC
  | 'version'      // a version other than 2, 3 or 4
  | 'corrupt'      // the entries or extensions do not add up
  | 'sharedIndex'  // a split index whose shared index is missing, unreadable or itself unusable
  | 'cancelled';

export interface GitIndexMatch {
  /** Path endings kept, compared ASCII case-insensitively (".sql"). */
  suffixes?: readonly string[];
  /** Whole file names kept (the part after the last `/`), ASCII case-insensitively ("database.json"). */
  names?: readonly string[];
}

export interface GitIndexReadOptions {
  /** Keep only paths under this folder of the working tree (`/`-joined, no leading or trailing slash; '' or absent: every path). Returned paths are relative to it. */
  prefix?: string;
  /** Compare `prefix` ASCII case-insensitively (the caller passes true on Windows and macOS). */
  prefixIgnoreCase?: boolean;
  /** Which paths to keep. */
  match: GitIndexMatch;
  /** Also return every folder under the prefix that holds a tracked file, with its ancestors (relative to the prefix, `/`-joined, never ''). */
  collectDirs?: boolean;
  /** The largest index file read, in bytes (the index itself and a shared index each). Default 32 MiB. */
  maxBytes?: number;
  /** Parse for at most this many milliseconds before letting the event loop run. Default 8. */
  sliceMs?: number;
  /** Stop: the result is `cancelled`. */
  cancelled?: () => boolean;
  /** The clock (tests). Default Date.now. */
  now?: () => number;
}

export type GitIndexResult =
  | { ok: true; paths: string[]; dirs?: Set<string>; entries: number; version: 2 | 3 | 4; split: boolean }
  | { ok: false; reason: GitIndexFailure };

export const GIT_INDEX_MAX_BYTES = 32 * 1024 * 1024;

/** How much of a `.git` file is read: it holds one short line. */
const GIT_FILE_MAX_BYTES = 4096;
/** How long parsing runs before the event loop gets a turn. */
const SLICE_MS = 8;
/** How many entries are parsed between two looks at the clock. */
const SLICE_ENTRIES = 512;
/**
 * Runs a callback on the event loop's next turn. The real `setImmediate`,
 * taken once as the module loads: a turn of the event loop is not a timer, and
 * a test's fake clock (which replaces the global) must not be able to hold a
 * read.
 */
const nextTurn: (callback: () => void) => unknown = setImmediate;

const SIGNATURE_DIRC = 0x44495243;
/** The split index extension, `link`. */
const SIGNATURE_LINK = 0x6c696e6b;
const HEADER_BYTES = 12;
/** An entry's ten 4-byte stat fields, which come before its object id. */
const STAT_BYTES = 40;
/** The byte of an entry whose top four bits are the mode's type (the mode is the 32-bit field at 24). */
const MODE_TYPE_AT = 26;
const MODE_TYPE_MASK = 0xf0;
/** A regular file, `0o100000`. */
const MODE_FILE = 0x80;
/** A symbolic link, `0o120000`. Gitlinks (`0o160000`) and sparse folders (`0o040000`) are not files here. */
const MODE_SYMLINK = 0xa0;
const FLAG_EXTENDED = 0x4000;
/** The flags' name length; this value itself means "this long or longer". */
const NAME_LENGTH_MASK = 0x0fff;
/** Every bit of the second flags word but the two git defines (skip-worktree, intent-to-add). */
const EXTENDED_FLAGS_UNKNOWN = 0x9fff;
const SHA1_BYTES = 20;
const SHA256_BYTES = 32;
const SLASH = 0x2f;

/** Each byte with an ASCII capital lowered. */
const LOWER = new Uint8Array(256);
/** Each byte as it is. */
const SAME = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  SAME[i] = i;
  LOWER[i] = i >= 0x41 && i <= 0x5a ? i + 0x20 : i;
}

// ── Finding the index ──────────────────────────────────────────────────────

/** The repository `folder` is in, or undefined (none above it, or a `.git` file that cannot be read). */
export async function findGitIndex(folder: string): Promise<GitIndexLocation | undefined> {
  try {
    let dir = path.resolve(folder);
    for (;;) {
      const dotGit = path.join(dir, '.git');
      const kind = await kindOf(dotGit);
      if (kind === 'dir') return locationOf(dir, dotGit);
      if (kind === 'file') {
        // A linked worktree or a submodule. One we cannot follow is still a
        // repository: the walk does not go on to the repository above it.
        const gitDir = await readGitFile(dotGit, dir);
        return gitDir === undefined ? undefined : locationOf(dir, gitDir);
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

function locationOf(workTree: string, gitDir: string): GitIndexLocation {
  return { workTree, gitDir, indexPath: path.join(gitDir, 'index') };
}

async function kindOf(target: string): Promise<'dir' | 'file' | undefined> {
  try {
    const stat = await fsp.stat(target);
    return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : undefined;
  } catch {
    return undefined;
  }
}

/** Where a `.git` file's `gitdir: <path>` line points (a relative path is relative to the file's folder). */
async function readGitFile(file: string, dir: string): Promise<string | undefined> {
  let text: string;
  let whole: boolean;
  try {
    const handle = await fsp.open(file, 'r');
    try {
      const buffer = Buffer.alloc(GIT_FILE_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, GIT_FILE_MAX_BYTES, 0);
      text = buffer.toString('utf8', 0, bytesRead);
      whole = bytesRead < GIT_FILE_MAX_BYTES;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('gitdir:')) continue;
    // A line the 4 KiB cut through is not a path to trust.
    if (!whole && i === lines.length - 1) return undefined;
    const target = line.slice('gitdir:'.length).trim();
    return target === '' ? undefined : path.resolve(dir, target);
  }
  return undefined;
}

// ── Which paths are kept ───────────────────────────────────────────────────

/** A string's UTF-8 bytes, ASCII capitals lowered when `lower`. */
function bytesOf(text: string, lower: boolean): Uint8Array {
  const bytes = Buffer.from(text, 'utf8');
  if (lower) for (let i = 0; i < bytes.length; i++) bytes[i] = LOWER[bytes[i]];
  return bytes;
}

/** Whether the bytes before `end` are `tail`, ASCII case-insensitively. `tail` is lowered and no longer than the path. */
function endsWith(source: Uint8Array, end: number, tail: Uint8Array): boolean {
  let at = end - 1;
  for (let i = tail.length - 1; i >= 0; i--, at--) {
    if (LOWER[source[at]] !== tail[i]) return false;
  }
  return true;
}

/** The prefix and the match, as bytes: a path is tested where it lies, and only a kept one becomes a string. */
class PathFilter {
  /** `prefix/` (lowered when its case is ignored); empty: every path. */
  readonly prefix: Uint8Array;
  /** What a path's byte is compared as against `prefix`: itself, or lowered. */
  readonly prefixFold: Uint8Array;
  private readonly suffixes: Uint8Array[];
  private readonly names: Uint8Array[];
  /** The last bytes a kept path can have. Nearly every other path is turned away on this one look. */
  private readonly lastBytes = new Uint8Array(256);

  constructor(options: GitIndexReadOptions) {
    const ignoreCase = options.prefixIgnoreCase === true;
    const prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
    this.prefix = prefix === '' ? new Uint8Array(0) : bytesOf(prefix + '/', ignoreCase);
    this.prefixFold = ignoreCase ? LOWER : SAME;
    const tails = (texts: readonly string[] | undefined): Uint8Array[] =>
      (texts ?? []).filter((text) => text !== '').map((text) => bytesOf(text, true));
    this.suffixes = tails(options.match.suffixes);
    // A file name holds no slash, so a name with one matches nothing.
    this.names = tails(options.match.names).filter((name) => !name.includes(SLASH));
    for (const tail of [...this.suffixes, ...this.names]) this.lastBytes[tail[tail.length - 1]] = 1;
  }

  /** Whether the path at `start`..`end` (not empty) ends with a suffix or is, after its last slash, a name. */
  keeps(source: Uint8Array, start: number, end: number): boolean {
    if (this.lastBytes[LOWER[source[end - 1]]] === 0) return false;
    const length = end - start;
    for (const suffix of this.suffixes) {
      if (suffix.length <= length && endsWith(source, end, suffix)) return true;
    }
    for (const name of this.names) {
      const size = name.length;
      if (size > length || (size < length && source[end - size - 1] !== SLASH)) continue;
      if (endsWith(source, end, name)) return true;
    }
    return false;
  }
}

/** What a read gathers. The index and its shared index fill the same sets, so a path in both is returned once. */
interface Found {
  paths: Set<string>;
  dirs: Set<string> | undefined;
}

function newFound(options: GitIndexReadOptions): Found {
  return { paths: new Set<string>(), dirs: options.collectDirs ? new Set<string>() : undefined };
}

// ── The entries ────────────────────────────────────────────────────────────

type Step = 'more' | 'done' | 'bad';

/**
 * Reads an index's entries a batch at a time, under one guess at the object id
 * size. `bad`: something does not add up (a wrong guess, or a damaged file);
 * the reader is then finished with.
 */
class EntryReader {
  /** The first byte not yet read. After `done`: where the extensions start. */
  pos = HEADER_BYTES;
  /** Entries with no path: a split index's stand-ins for entries of its shared index. */
  emptyPaths = 0;
  private left: number;
  /** Where the trailing checksum starts: nothing is read from there on. */
  private readonly end: number;
  /** From an entry's first byte to its flags. */
  private readonly flagsOffset: number;
  /** Version 4: the current path, which each entry cuts and adds to. */
  private path: Buffer;
  private pathLength = 0;
  /** Version 4: where the current path's last slash is, or -1. */
  private pathSlash = -1;
  /** The folder last added to `dirs`: entries are sorted, so most have the folder of the one before. */
  private dir = Buffer.allocUnsafe(256);
  private dirLength = -1;

  constructor(
    private readonly bytes: Buffer,
    private readonly version: 2 | 3 | 4,
    count: number,
    hashSize: number,
    private readonly filter: PathFilter,
    private readonly found: Found,
  ) {
    this.left = count;
    this.end = bytes.length - hashSize;
    this.flagsOffset = STAT_BYTES + hashSize;
    this.path = Buffer.allocUnsafe(version === 4 ? 1024 : 0);
  }

  /** Reads up to `max` entries. */
  read(max: number): Step {
    const count = Math.min(max, this.left);
    const ok = this.version === 4 ? this.readPrefixed(count) : this.readPadded(count);
    if (!ok) return 'bad';
    this.left -= count;
    return this.left > 0 ? 'more' : 'done';
  }

  /** Versions 2 and 3: the whole path, NUL-ended, then NULs up to a multiple of 8 bytes from the entry's start. */
  private readPadded(count: number): boolean {
    const bytes = this.bytes;
    const end = this.end;
    const flagsOffset = this.flagsOffset;
    const extendedAllowed = this.version >= 3;
    let pos = this.pos;
    for (let n = count; n > 0; n--) {
      const flagsAt = pos + flagsOffset;
      if (flagsAt + 2 > end) return false;
      const flags = (bytes[flagsAt] << 8) | bytes[flagsAt + 1];
      let nameAt = flagsAt + 2;
      if (flags & FLAG_EXTENDED) {
        if (!extendedAllowed || nameAt + 2 > end) return false;
        if ((((bytes[nameAt] << 8) | bytes[nameAt + 1]) & EXTENDED_FLAGS_UNKNOWN) !== 0) return false;
        nameAt += 2;
      }
      let nameEnd = nameAt;
      let slash = -1;
      for (; nameEnd < end; nameEnd++) {
        const byte = bytes[nameEnd];
        if (byte === 0) break;
        if (byte === SLASH) slash = nameEnd;
      }
      if (nameEnd >= end) return false;
      const length = nameEnd - nameAt;
      const stated = flags & NAME_LENGTH_MASK;
      if (stated === NAME_LENGTH_MASK ? length < NAME_LENGTH_MASK : length !== stated) return false;
      const next = pos + ((nameEnd - pos + 8) & ~7);
      if (next > end) return false;
      for (let i = nameEnd + 1; i < next; i++) {
        if (bytes[i] !== 0) return false;
      }
      if (length === 0) {
        this.emptyPaths++;
      } else {
        const type = bytes[pos + MODE_TYPE_AT] & MODE_TYPE_MASK;
        if (type === MODE_FILE || type === MODE_SYMLINK) this.take(bytes, nameAt, nameEnd, slash);
      }
      pos = next;
    }
    this.pos = pos;
    return true;
  }

  /** Version 4: how many bytes of the previous path to drop, then the bytes to add, NUL-ended. No padding. */
  private readPrefixed(count: number): boolean {
    const bytes = this.bytes;
    const end = this.end;
    const flagsOffset = this.flagsOffset;
    let path = this.path;
    let length = this.pathLength;
    let slash = this.pathSlash;
    let pos = this.pos;
    for (let n = count; n > 0; n--) {
      const flagsAt = pos + flagsOffset;
      if (flagsAt + 2 > end) return false;
      const flags = (bytes[flagsAt] << 8) | bytes[flagsAt + 1];
      let at = flagsAt + 2;
      if (flags & FLAG_EXTENDED) {
        if (at + 2 > end) return false;
        if ((((bytes[at] << 8) | bytes[at + 1]) & EXTENDED_FLAGS_UNKNOWN) !== 0) return false;
        at += 2;
      }
      // git's "offset" variable-width integer: each further byte adds one before it shifts.
      if (at >= end) return false;
      let byte = bytes[at++];
      let drop = byte & 0x7f;
      while (byte & 0x80) {
        // Already past the path's length once another seven bits follow.
        if (at >= end || drop >= length) return false;
        byte = bytes[at++];
        drop = (drop + 1) * 128 + (byte & 0x7f);
      }
      if (drop > length) return false;
      let write = length - drop;
      if (slash >= write) {
        slash = write - 1;
        while (slash >= 0 && path[slash] !== SLASH) slash--;
      }
      for (;;) {
        const stop = Math.min(end, at + (path.length - write));
        let added = 0;
        while (at < stop && (added = bytes[at]) !== 0) {
          if (added === SLASH) slash = write;
          path[write++] = added;
          at++;
        }
        if (at < stop) break;
        if (at >= end) return false;
        // The path is longer than the buffer: a bigger one, and carry on.
        const bigger = Buffer.allocUnsafe(path.length * 2);
        path.copy(bigger, 0, 0, write);
        path = this.path = bigger;
      }
      length = write;
      const stated = flags & NAME_LENGTH_MASK;
      if (stated === NAME_LENGTH_MASK ? length < NAME_LENGTH_MASK : length !== stated) return false;
      if (length === 0) {
        this.emptyPaths++;
      } else {
        const type = bytes[pos + MODE_TYPE_AT] & MODE_TYPE_MASK;
        if (type === MODE_FILE || type === MODE_SYMLINK) this.take(path, 0, length, slash);
      }
      pos = at + 1;
    }
    this.pos = pos;
    this.pathLength = length;
    this.pathSlash = slash;
    return true;
  }

  /** A tracked file's path, at `start`..`end` of `source`, its last slash at `slash` (or -1). */
  private take(source: Buffer, start: number, end: number, slash: number): void {
    const filter = this.filter;
    const prefix = filter.prefix;
    let from = start;
    if (prefix.length > 0) {
      if (end - start <= prefix.length) return;
      const fold = filter.prefixFold;
      for (let i = 0; i < prefix.length; i++) {
        if (fold[source[start + i]] !== prefix[i]) return;
      }
      from = start + prefix.length;
    }
    if (this.found.dirs !== undefined && slash > from) this.addDir(this.found.dirs, source, from, slash);
    if (filter.keeps(source, from, end)) this.found.paths.add(source.toString('utf8', from, end));
  }

  /** Adds the folder at `start`..`end` and its ancestors, unless it is the folder of the entry before. */
  private addDir(dirs: Set<string>, source: Buffer, start: number, end: number): void {
    const length = end - start;
    let last = this.dir;
    if (length === this.dirLength) {
      // From the end: sorted neighbours differ late.
      let i = length - 1;
      while (i >= 0 && last[i] === source[start + i]) i--;
      if (i < 0) return;
    }
    if (length > last.length) last = this.dir = Buffer.allocUnsafe(Math.max(length, last.length * 2));
    source.copy(last, 0, start, end);
    this.dirLength = length;
    let dir = source.toString('utf8', start, end);
    while (dir !== '' && !dirs.has(dir)) {
      dirs.add(dir);
      const cut = dir.lastIndexOf('/');
      dir = cut < 0 ? '' : dir.slice(0, cut);
    }
  }
}

// ── One index file ─────────────────────────────────────────────────────────

/** Shares the event loop: parsing stops for a turn once a slice is used up. */
class Pace {
  private readonly now: () => number;
  private readonly sliceMs: number;
  private readonly isCancelled: (() => boolean) | undefined;
  private started: number;

  constructor(options: GitIndexReadOptions) {
    this.now = options.now ?? Date.now;
    this.sliceMs = options.sliceMs ?? SLICE_MS;
    this.isCancelled = options.cancelled;
    this.started = this.now();
  }

  cancelled(): boolean {
    return this.isCancelled !== undefined && this.isCancelled();
  }

  /** Whether the slice is used up. */
  due(): boolean {
    return this.now() - this.started >= this.sliceMs;
  }

  /**
   * Lets the event loop run, then starts a slice. False: cancelled meanwhile.
   *
   * Also taken once a file is in, before its first slice: a file read ends in
   * the loop's I/O phase, and a next-turn callback asked for there runs in the
   * same turn, before any timer or message. From the first rest on, each rest
   * is a whole turn, so nothing waits longer than one slice.
   */
  async rest(): Promise<boolean> {
    await new Promise<void>((resolve) => nextTurn(resolve));
    this.started = this.now();
    return !this.cancelled();
  }
}

/** A file's bytes, or why not. The size is asked of the open file, so a file over the limit is never read. */
async function loadFile(file: string, maxBytes: number): Promise<Buffer | 'missing' | 'tooLarge'> {
  try {
    const handle = await fsp.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return 'missing';
      if (stat.size > maxBytes) return 'tooLarge';
      const bytes = Buffer.allocUnsafe(stat.size);
      let read = 0;
      while (read < bytes.length) {
        const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return read === bytes.length ? bytes : bytes.subarray(0, read);
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return 'missing';
  }
}

interface IndexHeader {
  version: 2 | 3 | 4;
  count: number;
}

function readHeader(bytes: Buffer): IndexHeader | 'notIndex' | 'version' | 'corrupt' {
  if (bytes.length < 4 || bytes.readUInt32BE(0) !== SIGNATURE_DIRC) return 'notIndex';
  if (bytes.length < HEADER_BYTES) return 'corrupt';
  const version = bytes.readUInt32BE(4);
  if (version !== 2 && version !== 3 && version !== 4) return 'version';
  return { version, count: bytes.readUInt32BE(8) };
}

interface ParsedIndex {
  /** The shared index's id in hex, when the index is split and has one. */
  shared: string | undefined;
}

/**
 * Reads one index file's entries into `found` and walks its extensions, under
 * one guess at the object id size. `corrupt`: it does not add up under that
 * guess.
 */
async function parseIndex(
  bytes: Buffer,
  header: IndexHeader,
  hashSize: number,
  filter: PathFilter,
  found: Found,
  pace: Pace,
): Promise<ParsedIndex | 'corrupt' | 'cancelled'> {
  const reader = new EntryReader(bytes, header.version, header.count, hashSize, filter, found);
  for (;;) {
    const step = reader.read(SLICE_ENTRIES);
    if (step === 'bad') return 'corrupt';
    if (step === 'done') break;
    if (pace.due() && !(await pace.rest())) return 'cancelled';
  }

  // Extensions: a 4-byte signature, a 4-byte size, that many bytes. They end
  // exactly where the checksum starts, which is what tells a right guess at
  // the id size from a wrong one. Only `link` is read.
  const end = bytes.length - hashSize;
  let pos = reader.pos;
  let split = false;
  let shared: string | undefined;
  while (pos < end) {
    if (pos + 8 > end) return 'corrupt';
    const size = bytes.readUInt32BE(pos + 4);
    const dataAt = pos + 8;
    if (size > end - dataAt) return 'corrupt';
    if (bytes.readUInt32BE(pos) === SIGNATURE_LINK) {
      // A split index: the id of the shared index its entries add to. All zeros: there is none.
      if (size < hashSize) return 'corrupt';
      const id = bytes.subarray(dataAt, dataAt + hashSize);
      split = true;
      if (id.some((byte) => byte !== 0)) shared = id.toString('hex');
    }
    pos = dataAt + size;
  }
  if (pos !== end) return 'corrupt';
  // Only a split index strips a path (an entry that replaces one of the shared index's).
  if (reader.emptyPaths > 0 && !split) return 'corrupt';
  return { shared };
}

// ── Reading ────────────────────────────────────────────────────────────────

function failure(reason: GitIndexFailure): GitIndexResult {
  return { ok: false, reason };
}

/**
 * The tracked paths the index lists that `match` keeps: regular files and
 * symbolic links, each once, in the index's order (a split index: its own
 * entries, then its shared index's). A split index's deleted entries are still
 * listed, which is why callers check a file exists.
 */
export async function readGitIndex(
  location: Pick<GitIndexLocation, 'gitDir' | 'indexPath'>,
  options: GitIndexReadOptions,
): Promise<GitIndexResult> {
  try {
    return await readIndex(location, options);
  } catch {
    return failure('corrupt');
  }
}

async function readIndex(
  location: Pick<GitIndexLocation, 'gitDir' | 'indexPath'>,
  options: GitIndexReadOptions,
): Promise<GitIndexResult> {
  const pace = new Pace(options);
  if (pace.cancelled()) return failure('cancelled');
  const maxBytes = options.maxBytes ?? GIT_INDEX_MAX_BYTES;
  const filter = new PathFilter(options);

  const bytes = await loadFile(location.indexPath, maxBytes);
  if (typeof bytes === 'string') return failure(bytes);
  if (!(await pace.rest())) return failure('cancelled');
  const header = readHeader(bytes);
  if (typeof header === 'string') return failure(header);

  // The file does not say how long its object ids are: SHA-1's 20 bytes first, then SHA-256's 32.
  let hashSize = SHA1_BYTES;
  let found = newFound(options);
  let parsed = await parseIndex(bytes, header, hashSize, filter, found, pace);
  if (parsed === 'corrupt') {
    hashSize = SHA256_BYTES;
    found = newFound(options);
    parsed = await parseIndex(bytes, header, hashSize, filter, found, pace);
  }
  if (typeof parsed === 'string') return failure(parsed);

  let entries = header.count;
  if (parsed.shared !== undefined) {
    // A split index: most entries are in `sharedindex.<id>` beside it. Its
    // delete and replace bitmaps are not applied: a path too many is harmless.
    const sharedBytes = await loadFile(path.join(location.gitDir, `sharedindex.${parsed.shared}`), maxBytes);
    if (typeof sharedBytes === 'string') return failure('sharedIndex');
    if (!(await pace.rest())) return failure('cancelled');
    const sharedHeader = readHeader(sharedBytes);
    if (typeof sharedHeader === 'string') return failure('sharedIndex');
    const sharedParsed = await parseIndex(sharedBytes, sharedHeader, hashSize, filter, found, pace);
    if (sharedParsed === 'cancelled') return failure('cancelled');
    if (sharedParsed === 'corrupt') return failure('sharedIndex');
    entries += sharedHeader.count;
  }

  const result: GitIndexResult = {
    ok: true,
    paths: [...found.paths],
    entries,
    version: header.version,
    split: parsed.shared !== undefined,
  };
  if (found.dirs !== undefined) result.dirs = found.dirs;
  return result;
}
