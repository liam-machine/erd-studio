/**
 * Generated tests: the rules every importer meets on every input, as checks
 * a property calls. Each returns a list of violations (empty: none), so a
 * property can report them all at once with the input that broke them.
 *
 * - **No echo**: no string a user reads holds more than {@link MAX_ECHO}
 *   characters of the source verbatim (names aside: a table's own name is
 *   shown, cut by the importer where it is long).
 * - **Located**: every problem says its file and a line inside it.
 * - **Linear time**: {@link timeRatio} times sizes n and k·n.
 */
import { performance } from 'perf_hooks';
import { ledgerLeftOut, ledgerLogLines, ledgerNotes, type LedgerEntry } from '../../../src/services/importLedger';

/** The most characters of the source a shown string may hold verbatim: a short snippet. */
export const MAX_ECHO = 100;

/**
 * The longest run of `message` found verbatim in `source`, once every name in
 * `names` is taken out of the message (names are shown; the importer cuts the
 * long ones), when it is longer than {@link MAX_ECHO}; else undefined.
 */
export function echoedRun(message: string, source: string, names: readonly string[] = []): string | undefined {
  let m = message;
  for (const name of [...names].filter((n) => n.length >= 8).sort((a, b) => b.length - a.length)) {
    m = m.split(name).join('\u0000');
    // A long name the importer cut (`a0_a0_…_a0…`): its longest prefix in the message is the name too.
    if (name.length < 24) continue;
    for (let at = m.indexOf(name.slice(0, 24)); at >= 0; at = m.indexOf(name.slice(0, 24), at + 1)) {
      let len = 24;
      while (len < name.length && m[at + len] === name[len]) len++;
      m = `${m.slice(0, at)}\u0000${m.slice(at + len)}`;
    }
  }
  if (m.length <= MAX_ECHO) return undefined;
  for (let i = 0; i + MAX_ECHO < m.length; i++) {
    const window = m.slice(i, i + MAX_ECHO + 1);
    if (window.includes('\u0000')) continue;
    if (source.includes(window)) {
      let end = i + MAX_ECHO + 1;
      while (end < m.length && source.includes(m.slice(i, end + 1))) end++;
      return m.slice(i, end);
    }
  }
  return undefined;
}

/** Violations of the no-echo rule over `shown`. */
export function echoViolations(shown: readonly string[], sources: readonly string[], names: readonly string[]): string[] {
  const out: string[] = [];
  const source = sources.join('\n\u0001\n');
  for (const s of new Set(shown)) {
    const run = echoedRun(s, source, names);
    if (run) out.push(`echoes ${run.length} characters of the source: ${JSON.stringify(s.slice(0, 160))}…`);
  }
  return out;
}

/** Every string the ledger renders (notes, Not imported, the log). */
export function ledgerStrings(ledger: readonly LedgerEntry[]): string[] {
  return [...ledgerNotes(ledger), ...ledgerLeftOut(ledger), ...ledgerLogLines(ledger, 'Import', { everySkipped: true })];
}

/** The number of lines an editor shows for `text` (after a final line break, an empty last line). */
export function lineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

/**
 * Violations of "every problem says where": each problem names a file the
 * input has (when `files` has more than one), and a line within it.
 */
export function locationViolations(
  problems: ReadonlyArray<{ file?: string; line?: number; message: string }>,
  files: ReadonlyArray<{ name: string; text: string }>,
  opts: { lineRequired?: (p: { file?: string; line?: number; message: string }) => boolean } = {},
): string[] {
  const out: string[] = [];
  const byName = new Map(files.map((f) => [f.name, f.text]));
  for (const p of problems) {
    const text = p.file !== undefined ? byName.get(p.file) : files.length === 1 ? files[0].text : undefined;
    if (files.length > 1 && (p.file === undefined || !byName.has(p.file))) { out.push(`no file: ${p.message}`); continue; }
    const required = opts.lineRequired ? opts.lineRequired(p) : true;
    if (p.line === undefined) { if (required) out.push(`no line: ${p.file ?? ''} ${p.message}`); continue; }
    if (text !== undefined && (p.line < 1 || p.line > lineCount(text))) out.push(`line ${p.line} outside ${p.file ?? 'the file'} (${lineCount(text)} lines): ${p.message}`);
  }
  return out;
}

/** Violations of "every problem in the ledger says where": a `problem` entry with a file has a line, unless it is about a whole file. */
export function ledgerLocationViolations(ledger: readonly LedgerEntry[], files: ReadonlyArray<{ name: string; text: string }>): string[] {
  const out: string[] = [];
  const byName = new Map(files.map((f) => [f.name, f.text]));
  for (const e of ledger) {
    if (e.outcome !== 'problem') continue;
    if (!e.where?.file) { out.push(`ledger problem with no file: ${e.unit} ${e.what}`); continue; }
    if (e.where.line === undefined) {
      if (e.unit !== 'file' && e.cause !== 'cancelled' && e.cause !== 'timeLimit') out.push(`ledger problem with no line: ${e.where.file} ${e.unit} ${e.what}`);
      continue;
    }
    const text = byName.get(e.where.file);
    if (text !== undefined && (e.where.line < 1 || e.where.line > lineCount(text))) out.push(`ledger line ${e.where.line} outside ${e.where.file}: ${e.unit} ${e.what}`);
  }
  return out;
}

/** Sum of ledger counts matching `pred`. */
export const ledgerCount = (ledger: readonly LedgerEntry[], pred: (e: LedgerEntry) => boolean): number =>
  ledger.filter(pred).reduce((n, e) => n + e.count, 0);

/** The fastest of `tries` runs of `fn`, in ms (the minimum is the least disturbed by machine load). */
export function fastest(fn: () => unknown, tries = 3): number {
  let best = Infinity;
  for (let i = 0; i < tries; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/**
 * How time grows from size n to size k·n: the fastest run of each, and the
 * ratio of the big one to k times the small one (1: exactly linear). A floor
 * on the small time keeps a sub-millisecond run from making noise a ratio.
 * Robust to machine load: the runs alternate (a busy spell slows both), and
 * when the ratio is at `limit` or above it is measured again, up to
 * `attempts` times, keeping the best (a real superlinear step stays above
 * the limit every time; a busy machine does not).
 */
export function timeRatio(
  small: () => unknown, big: () => unknown, k: number,
  opts: { tries?: number; floorMs?: number; limit?: number; attempts?: number } = {},
): { small: number; big: number; ratio: number; attempts: number } {
  small(); // Warm up: the first run pays for loading grammars.
  let best = { small: Infinity, big: Infinity, ratio: Infinity, attempts: 0 };
  const attempts = opts.attempts ?? 3;
  for (let a = 1; a <= attempts; a++) {
    let s = Infinity;
    let b = Infinity;
    for (let i = 0; i < (opts.tries ?? 2); i++) {
      s = Math.min(s, fastest(small, 1));
      b = Math.min(b, fastest(big, 1));
    }
    const ratio = b / (k * Math.max(s, opts.floorMs ?? 5));
    if (ratio < best.ratio) best = { small: s, big: b, ratio, attempts: a };
    if (best.ratio < (opts.limit ?? 4)) break;
  }
  return best;
}
