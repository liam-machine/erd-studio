/**
 * Generated tests: damage a written source the ways real files are damaged.
 *
 * A writer returns its text with one {@link Span} per table (the table's own
 * statement or block, and the header that names it). {@link applyBreak}
 * applies one {@link Break} inside one table's span (or at the file level)
 * and says which tables it left untouched, so a property can hold every
 * untouched table to a whole import and the touched one to "imported or
 * reported". Each format supplies the pieces that are its own
 * ({@link FormatKit}): the types it writes, an unknown type, a reserved word,
 * a fragment of another dialect's syntax, a very long statement.
 */
import * as fc from 'fast-check';

export interface Span {
  table: string;
  /** Offsets in the text: the table's statement (or block, or file) from start to end. */
  start: number;
  end: number;
  /** The exact text that names the table where it is defined (`CREATE TABLE "a" (`, `table 'A'`): counted to know it is still there. */
  header: string;
  /** The file the span is in (formats with several files). */
  file?: string;
}

export type BreakKind =
  | 'truncate' | 'dropComma' | 'dropParen' | 'dropQuote' | 'unknownType' | 'reservedName' | 'duplicate'
  | 'longStatement' | 'mixedSyntax' | 'garbageLine' | 'deleteLine' | 'badIndent';

export const BREAK_KINDS: readonly BreakKind[] = [
  'truncate', 'dropComma', 'dropParen', 'dropQuote', 'unknownType', 'reservedName', 'duplicate',
  'longStatement', 'mixedSyntax', 'garbageLine', 'deleteLine', 'badIndent',
];

export interface Break {
  kind: BreakKind;
  /** Which table's span (modulo the count). */
  table: number;
  /** Where in it, 0 to 1. */
  at: number;
  /** A free choice among the format's options. */
  pick: number;
}

export function breakArb(kinds: readonly BreakKind[] = BREAK_KINDS): fc.Arbitrary<Break> {
  return fc.record({
    kind: fc.constantFrom(...kinds),
    table: fc.nat({ max: 999 }),
    at: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
    pick: fc.nat({ max: 999 }),
  });
}

export interface FormatKit {
  /** Type spellings the writer uses, any of which `unknownType` replaces (matched as whole words). */
  types: readonly string[];
  unknownTypes: readonly string[];
  reservedWords: readonly string[];
  /** Fragments of other dialects' (or formats') syntax, inserted at the end of a line in the span. */
  foreignFragments: readonly string[];
  /** Lines of noise from other tools (a psql meta-command, `GO`, a stray paste), inserted between spans. */
  garbageLines: readonly string[];
  /** A very long statement's body, inserted after the span's header line (`n` is a size, 1 to 4). */
  longBody: (n: number, eol: string) => string;
  /** Quote characters a `dropQuote` removes one of. */
  quotes: string;
  /** Bracket characters a `dropParen` removes one of (default `()`). */
  brackets?: string;
  /** The span's column (or member) lines: a regex for one, whose group 1 is the name. */
  memberLine: RegExp;
  /** How a `reservedName` writes the reserved word (unquoted, by default). */
  bareName?: (word: string) => string;
}

export interface Broken {
  text: string;
  kind: BreakKind;
  /** The span index the break hit. */
  target: number;
  /** Spans the break did not touch (and that are still in the text). */
  intact: boolean[];
  /** Spans whose text is gone altogether (after a truncation). */
  gone: boolean[];
  /** A copy of a table's statement added (`duplicate`): a second definition that must be reported. */
  duplicated?: string;
}

const positions = (text: string, re: RegExp, start: number, end: number): number[] => {
  const out: number[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  g.lastIndex = start;
  for (let m = g.exec(text); m && m.index < end; m = g.exec(text)) {
    out.push(m.index);
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
};

const choose = <T>(items: readonly T[], at: number): T => items[Math.min(items.length - 1, Math.floor(at * items.length))];

/**
 * `text` with `brk` applied in one span. When the break finds nothing to
 * break there (no comma to drop, say), the text comes back unchanged and
 * every span intact.
 */
export function applyBreak(text: string, spans: readonly Span[], brk: Break, kit: FormatKit, eol = '\n'): Broken {
  const n = spans.length;
  const target = brk.table % n;
  const span = spans[target];
  const intact = spans.map((_s, i) => i !== target);
  const gone = spans.map(() => false);
  const unchanged: Broken = { text, kind: brk.kind, target, intact: spans.map(() => true), gone };
  const splice = (at: number, remove: number, insert: string): string => text.slice(0, at) + insert + text.slice(at + remove);
  const inSpan = (re: RegExp): number[] => positions(text, re, span.start, span.end);
  const lineStarts = inSpan(/^/m).filter((p) => p > span.start);

  switch (brk.kind) {
    case 'truncate': {
      const cut = span.start + Math.floor(brk.at * (span.end - span.start));
      spans.forEach((s, i) => {
        if (s.file !== undefined && s.file !== span.file) return;
        if (s.start >= cut) { gone[i] = true; intact[i] = false; }
      });
      return { text: text.slice(0, cut), kind: brk.kind, target, intact, gone };
    }
    case 'dropComma': {
      const at = inSpan(/,/);
      return at.length ? { ...unchanged, text: splice(choose(at, brk.at), 1, ''), intact } : unchanged;
    }
    case 'dropParen': {
      const at = inSpan(new RegExp(`[${(kit.brackets ?? '()').replace(/[\]\\^-]/g, '\\$&')}]`));
      return at.length ? { ...unchanged, text: splice(choose(at, brk.at), 1, ''), intact } : unchanged;
    }
    case 'dropQuote': {
      const at = inSpan(new RegExp(`[${kit.quotes.replace(/[\]\\^-]/g, '\\$&')}]`));
      return at.length ? { ...unchanged, text: splice(choose(at, brk.at), 1, ''), intact } : unchanged;
    }
    case 'unknownType': {
      const words = kit.types.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
      const re = new RegExp(`(?<=[\\s:"])(?:${words.join('|')})(?![\\w(])`, 'g');
      const at = inSpan(re);
      if (!at.length) return unchanged;
      re.lastIndex = choose(at, brk.at);
      const m = re.exec(text)!;
      return { ...unchanged, text: splice(m.index, m[0].length, kit.unknownTypes[brk.pick % kit.unknownTypes.length]), intact };
    }
    case 'reservedName': {
      const lines = [...text.slice(span.start, span.end).matchAll(new RegExp(kit.memberLine.source, `${kit.memberLine.flags.replace('g', '')}gm`))];
      if (!lines.length) return unchanged;
      const m = choose(lines, brk.at);
      const at = span.start + m.index! + m[0].indexOf(m[1]);
      const word = kit.reservedWords[brk.pick % kit.reservedWords.length];
      return { ...unchanged, text: splice(at, m[1].length, kit.bareName ? kit.bareName(word) : word), intact };
    }
    case 'duplicate': {
      const copy = text.slice(span.start, span.end);
      return { ...unchanged, text: `${text}${text.endsWith(eol) ? '' : eol}${eol}${copy}${eol}`, duplicated: span.table };
    }
    case 'longStatement': {
      const at = lineStarts[0];
      if (at === undefined) return unchanged;
      return { ...unchanged, text: splice(at, 0, kit.longBody(1 + (brk.pick % 4), eol)), intact };
    }
    case 'mixedSyntax': {
      const ends = inSpan(/[^\s,]\s*(?=,?\r?\n)/).map((p) => p + 1);
      if (!ends.length) return unchanged;
      return { ...unchanged, text: splice(choose(ends, brk.at), 0, ` ${kit.foreignFragments[brk.pick % kit.foreignFragments.length]}`), intact };
    }
    case 'garbageLine': {
      // Between statements: before the target's span, which stays whole.
      const line = kit.garbageLines[brk.pick % kit.garbageLines.length];
      // An opened block comment (`/*`) hides what follows up to the next `*/`, by the language's own rules.
      const hides = /\/\*(?![\s\S]*\*\/)/.test(line);
      return { ...unchanged, text: splice(span.start, 0, `${line}${eol}`), ...(hides ? { intact: spans.map((_s, i) => i < target) } : {}) };
    }
    case 'deleteLine': {
      if (!lineStarts.length) return unchanged;
      const at = choose(lineStarts, brk.at);
      const next = text.indexOf('\n', at);
      const end = next < 0 || next >= span.end ? span.end : next + 1;
      return { ...unchanged, text: splice(at, end - at, ''), intact };
    }
    case 'badIndent': {
      if (!lineStarts.length) return unchanged;
      const at = choose(lineStarts, brk.at);
      const indent = /^[ \t]*/.exec(text.slice(at))![0];
      const swapped = brk.pick % 3 === 0 ? '' : brk.pick % 3 === 1 ? indent.replace(/\t/g, '    ') + ' ' : `\t${indent}`;
      return swapped === indent ? unchanged : { ...unchanged, text: splice(at, indent.length, swapped), intact };
    }
  }
}

/** How many times each span's header is in `text`, summed: the definitions a reader can see. */
export function headersIn(text: string, spans: readonly Span[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const s of spans) {
    if (seen.has(s.header)) continue;
    seen.add(s.header);
    for (let i = text.indexOf(s.header); i >= 0; i = text.indexOf(s.header, i + 1)) n++;
  }
  return n;
}

/** A small deterministic PRNG (mulberry32) from a seed fast-check draws. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
