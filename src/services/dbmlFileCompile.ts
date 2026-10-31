/**
 * Convert Project to DBML's self-check compile (§6.1 step 8), in time that
 * grows with the project rather than with its square.
 *
 * `compileDbmlProject` mounts every file in one multi-file Compiler, and
 * @dbml/parse 11 resolves each Ref against every file of that layout: 18 s
 * for 1,100 tables, most of a Convert. This gives the same diagnostics,
 * keyed the same way, from small compiles:
 *
 * 1. **Each file on its own** (`compileDbmlProject` with a layout of the file
 *    and the files its own `use` lines name), keeping only the diagnostics in
 *    that file. A file's syntax, its `use` lines, the names it binds and the
 *    clashes between what it imports depend only on its text and on what it
 *    imports, and `use` (unlike `reuse`) imports only a target's own
 *    declarations, which the target's text alone decides. An error inside an
 *    imported file is reported when that file is compiled itself: every
 *    `.dbml` file is an entry. A target the project lacks is missing from the
 *    small layout too, and reported the same.
 *    - A relationships file that holds only `use` lines, Refs and comments
 *      is imported by `use *` with nothing in it (it declares no table, enum,
 *      group, partial or note): a diagram is compiled with an empty file in
 *      its place, which reports the same and binds none of its Refs.
 *    - Such a file with many Refs is compiled in chunks: each keeps the text
 *      in place (the other Refs and `use` lines blanked to spaces, so every
 *      line and column stays) with the `use` lines its Refs need, and `use`
 *      lines naming the same table stay in one chunk, so their clash is seen.
 * 2. **Refs with the same endpoints** ("References with same endpoints
 *    exist") across files, or across chunks of one: the whole-project
 *    compile reports a pair when some file reaches both through `use` lines.
 *    Here every Ref whose two tables its file can see is read with core's
 *    `readRelationshipsDbml`, keyed by its endpoints as the compiler keys
 *    them (both column lists sorted, the pair unordered), and a pair is
 *    reported when the two files share a file that reaches both.
 * 3. **Anything else crossing files** (a TableGroup, a TablePartial, an inline
 *    `ref:`, a `reuse` line, a `use` line renaming a table with `as`, a file
 *    that does not parse or a Ref the reader skips; looked for in the code,
 *    never in comments, notes or other strings): a file whose `use` lines reach one is compiled the old way, with
 *    every file it reaches, and all of that compile's diagnostics are kept.
 *    Convert writes none of these; a project that has them pays only for the
 *    files that reach them.
 *
 * No `vscode`: the CLI may bundle it.
 */

import * as path from 'path';

import type { DbmlDiagnostic, DbmlStoredRef } from '@erd-studio/core';
import { compileDbmlProject, outlineDbmlFile, readRelationshipsDbml } from '@erd-studio/core/dbml';

/** A multi-file compile with `compileDbmlProject`'s contract. */
export type DbmlProjectCompile = (files: Readonly<Record<string, string>>, entries: readonly string[]) => Record<string, DbmlDiagnostic[]>;

/** The compiler's message for two Refs with the same endpoints (CIRCULAR_REF). */
export const SAME_ENDPOINTS_CODE = 5001;
export const SAME_ENDPOINTS_MESSAGE = 'References with same endpoints exist';

/** Most Refs a chunk of a file holds. */
const CHUNK_REFS = 24;
/** Most `use` lines no Ref needs that a chunk of a file holds. */
const CHUNK_USES = 48;

/** What one file is, read once per text. */
interface FileFacts {
  parses: boolean;
  uses: Array<{ line: number; resolved: string; wildcard: boolean; tables: string[] }>;
  /** Lower-case names of the tables it declares (empty when it was not outlined: see {@link outlined}). */
  declares: string[];
  /** Whether {@link declares} was read (a file with no `use`, `Ref` or exotic code is outlined only when a `use *` reaches it). */
  outlined: boolean;
  /** Holds only `use` lines, standalone Refs and comments, all readable. */
  pureRelationships: boolean;
  /** Something whose diagnostics cross files beyond what parts 1 and 2 see. */
  exotic: boolean;
  /** Its standalone Refs (never the pending comments), when it has any. */
  refs: DbmlStoredRef[];
  /** Each Ref's 1-based column, as the compiler reports it. */
  refColumns: number[];
}

/** Results kept between calls (the before and after sets share most files). */
export class DbmlFileCompileMemo {
  readonly facts = new Map<string, FileFacts>();
  readonly results = new Map<string, Record<string, DbmlDiagnostic[]>>();
}

const USE_LINE = /^\s*(?:re)?use\b/m;
/**
 * What crosses files beyond parts 1 and 2, tested on the code alone
 * ({@link codeOf}): a TableGroup, a TablePartial, a `reuse` line, an inline
 * `ref:` setting, or a `use` line that renames a table (`as`), whose Refs
 * part 2 cannot match by name.
 */
const EXOTIC_CODE = /\b(?:TableGroup|TablePartial|reuse)\b|\[[^\]]*\bref\s*:|\buse\s*\{[^}]*\bas\b/i;

/**
 * Comments and string literals (notes, descriptions, quoted names) blanked to
 * spaces, so a note that says "kept for reuse" or "FK, ref: SAP" is not taken
 * for code. Line breaks stay.
 */
export function codeOf(text: string): string {
  return text.replace(/'''[\s\S]*?(?:'''|$)|'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?|`[^`]*`?|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
    (m) => m.replace(/[^\r\n]/g, ' '));
}

function blankRange(chars: string[], start: number, end: number): void {
  for (let i = Math.max(0, start); i < Math.min(chars.length, end); i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
}

/** The offset each line starts at (index 0 is line 1). */
function lineRanges(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function readFacts(filePath: string, text: string): FileFacts {
  const code = codeOf(text);
  const hasUse = USE_LINE.test(code);
  const hasRef = /\bRef\b/.test(code);
  const exoticCode = EXOTIC_CODE.test(code);
  const outline = hasUse || hasRef || exoticCode ? outlineDbmlFile(text, filePath) : null;
  const parses = outline ? outline.parses : true;
  const uses = parses
    ? (outline?.uses ?? []).map((u) => ({ line: u.line, resolved: u.resolved.replace(/^\.\//, ''), wildcard: u.wildcard, tables: u.tables }))
    : usesOfUnparsed(filePath, text);
  const declares = (outline?.tables ?? []).map((t) => t.toLowerCase());
  let refs: DbmlStoredRef[] = [];
  let refsReadable = true;
  if (hasRef && parses) {
    const reading = readRelationshipsDbml(text);
    refs = reading.refs;
    refsReadable = reading.readable && reading.problems.length === 0;
  }
  const exotic = !parses || !refsReadable || exoticCode;
  let pureRelationships = false;
  if (parses && !exotic && declares.length === 0 && (outline?.enums.length ?? 0) === 0 && (outline?.metadata?.length ?? 0) === 0) {
    // Blank the use lines, the Refs and the comments: nothing else may be left.
    const chars = text.split('');
    const starts = lineRanges(text);
    for (const u of uses) {
      const start = starts[u.line - 1] ?? 0;
      const end = starts[u.line] ?? text.length;
      blankRange(chars, start, end);
    }
    for (const r of refs) blankRange(chars, r.start, r.fullEnd);
    const rest = chars.join('').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    pureRelationships = /^\s*$/.test(rest);
  }
  const starts = lineRanges(text);
  const refColumns = refs.map((r) => {
    let at = r.start;
    while (at < text.length && /\s/.test(text[at])) at++;
    const line = starts.findIndex((s, i) => s <= at && (starts[i + 1] ?? Infinity) > at);
    return at - (starts[line] ?? 0) + 1;
  });
  return { parses, uses, declares, outlined: outline !== null, pureRelationships, exotic, refs, refColumns };
}

/** The tables a file declares, outlining it now if it was not (a plain table file a `use *` reaches). */
function declaresOf(filePath: string, text: string, facts: FileFacts): string[] {
  if (!facts.outlined) {
    const outline = outlineDbmlFile(text, filePath);
    facts.declares = outline.parses ? (outline.tables ?? []).map((t) => t.toLowerCase()) : [];
    facts.outlined = true;
  }
  return facts.declares;
}

/**
 * The `use` lines of a file that does not parse, read from the text: the
 * compiler still follows the ones it can, so its old-way compile (part 3)
 * mounts every file one might name.
 */
function usesOfUnparsed(filePath: string, text: string): FileFacts['uses'] {
  const out: FileFacts['uses'] = [];
  const pattern = /\b(?:re)?use\b[^'"\n]*?\bfrom\s+(['"])([^'"\n]+)\1/g;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const withExtension = /\.dbml$/i.test(m[2]) ? m[2] : `${m[2]}.dbml`;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), withExtension));
    out.push({ line: text.slice(0, m.index).split('\n').length, resolved, wildcard: true, tables: [] });
  }
  return out;
}

/** One endpoint as the compiler compares it: the table (`public.` is the default schema) and its sorted columns. */
function sideKey(table: string, columns: readonly string[]): string {
  return `${table.toLowerCase().replace(/^public\./, '')}.(${columns.map((c) => c.toLowerCase()).sort().join(',')})`;
}

function lastPart(name: string): string {
  const parts = name.toLowerCase().split('.');
  return parts[parts.length - 1];
}

/**
 * Each entry's diagnostics as `compileDbmlProject(files, entries)` reports
 * them, keyed by file (see the module comment). Every entry is present
 * (`[]` when clean). `memo` keeps what it read and compiled between calls.
 */
export function compileDbmlFilesSeparately(
  files: Readonly<Record<string, string>>,
  entries: readonly string[],
  compile: DbmlProjectCompile = compileDbmlProject,
  memo: DbmlFileCompileMemo = new DbmlFileCompileMemo(),
): Record<string, DbmlDiagnostic[]> {
  const steps = compileSteps(files, entries, compile, memo);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** How long the asynchronous compile works before it lets the extension host handle other events. */
const SLICE_MS = 50;

/**
 * {@link compileDbmlFilesSeparately}, letting the extension host breathe:
 * after every {@link SLICE_MS} of compiling it awaits `pause` (which yields
 * to the event loop, so a progress notification updates and its Cancel
 * button is heard, and may throw to stop). The same result.
 */
export async function compileDbmlFilesSeparatelyAsync(
  files: Readonly<Record<string, string>>,
  entries: readonly string[],
  pause: () => Promise<void>,
  compile: DbmlProjectCompile = compileDbmlProject,
  memo: DbmlFileCompileMemo = new DbmlFileCompileMemo(),
): Promise<Record<string, DbmlDiagnostic[]>> {
  const steps = compileSteps(files, entries, compile, memo);
  for (;;) {
    const until = Date.now() + SLICE_MS;
    let step = steps.next();
    while (!step.done && Date.now() < until) step = steps.next();
    if (step.done) return step.value;
    await pause();
  }
}

/** The work, one small compile per step. */
function* compileSteps(
  files: Readonly<Record<string, string>>,
  entries: readonly string[],
  compile: DbmlProjectCompile,
  memo: DbmlFileCompileMemo,
): Generator<void, Record<string, DbmlDiagnostic[]>> {
  const clean = (p: string): string => p.replace(/^\/+/, '');
  const set: Record<string, string> = {};
  for (const [p, text] of Object.entries(files)) set[clean(p)] = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const byLower = new Map<string, string[]>();
  for (const p of Object.keys(set)) byLower.set(p.toLowerCase(), [...(byLower.get(p.toLowerCase()) ?? []), p]);

  const factsOf = (p: string): FileFacts => {
    const key = `${p}\u0000${set[p]}`;
    let facts = memo.facts.get(key);
    if (!facts) {
      facts = readFacts(p, set[p]);
      memo.facts.set(key, facts);
    }
    return facts;
  };
  /** The files a `use` line names, as keyed here (the exact path, and any other spelling of it). */
  const targetsOf = (resolved: string): string[] => {
    const out = new Set<string>();
    if (Object.prototype.hasOwnProperty.call(set, resolved)) out.add(resolved);
    for (const other of byLower.get(resolved.toLowerCase()) ?? []) out.add(other);
    return [...out];
  };
  const directTargets = (p: string): string[] => {
    const out = new Set<string>();
    for (const u of factsOf(p).uses) for (const t of targetsOf(u.resolved)) out.add(t);
    out.delete(p);
    return [...out].sort();
  };
  const closureOf = (p: string): string[] => {
    const seen = new Set<string>([p]);
    const queue = [p];
    while (queue.length > 0) {
      const next = queue.shift()!;
      for (const t of directTargets(next)) if (!seen.has(t)) { seen.add(t); queue.push(t); }
    }
    return [...seen];
  };

  const result: Record<string, DbmlDiagnostic[]> = {};
  const seenDiagnostic = new Map<string, Set<string>>();
  const add = (file: string, d: DbmlDiagnostic): void => {
    const keys = seenDiagnostic.get(file) ?? new Set<string>();
    seenDiagnostic.set(file, keys);
    const key = `${d.code}\u0000${d.line}\u0000${d.column}\u0000${d.message}`;
    if (keys.has(key)) return;
    keys.add(key);
    (result[file] ??= []).push({ code: d.code, message: d.message, line: d.line, column: d.column });
  };
  /** One small compile, remembered by its exact layout: every file's diagnostics. */
  const compileOnce = (subset: Record<string, string>, entry: string): Record<string, DbmlDiagnostic[]> => {
    const key = JSON.stringify([entry, Object.keys(subset).sort().map((p) => [p, subset[p]])]);
    let out = memo.results.get(key);
    if (!out) {
      out = compile(subset, [entry]);
      memo.results.set(key, out);
    }
    return out;
  };

  const exoticReach = new Map<string, boolean>();
  const reachesExotic = (p: string): boolean => {
    let known = exoticReach.get(p);
    if (known === undefined) {
      known = closureOf(p).some((f) => factsOf(f).exotic);
      exoticReach.set(p, known);
    }
    return known;
  };

  // Every file an entry reaches: the whole-project compile reports what is in each.
  const entrySet = new Set(entries.map(clean));
  const reached = new Set<string>();
  for (const entry of entrySet) {
    result[entry] ??= [];
    if (!Object.prototype.hasOwnProperty.call(set, entry)) {
      for (const d of compile({}, [entry])[entry] ?? []) add(entry, d);
      continue;
    }
    for (const f of closureOf(entry)) reached.add(f);
  }
  /**
   * Files with no `use` line (tables) mounted, with their own text, in a
   * compile that imports them: what that compile reports in each is what it
   * reports on its own, so it is not compiled again.
   */
  const harvested = new Set<string>();
  const harvest = (subset: Record<string, string>, entry: string, out: Record<string, DbmlDiagnostic[]>): void => {
    for (const [file, text] of Object.entries(subset)) {
      if (file === entry || text !== set[file] || factsOf(file).uses.length > 0 || factsOf(file).exotic) continue;
      for (const d of out[file] ?? []) add(file, d);
      harvested.add(file);
    }
  };
  const importersFirst = [...reached].sort((a, b) => Number(factsOf(a).uses.length === 0) - Number(factsOf(b).uses.length === 0));
  for (const entry of importersFirst) {
    const facts = factsOf(entry);
    // 3. Something crosses files that parts 1 and 2 do not see: the old compile, for this entry.
    if (reachesExotic(entry)) {
      const subset: Record<string, string> = {};
      for (const f of closureOf(entry)) subset[f] = set[f];
      for (const [file, list] of Object.entries(compileOnce(subset, entry))) for (const d of list) add(file, d);
      yield;
      continue;
    }
    if (facts.uses.length === 0 && harvested.has(entry)) continue;
    // 1. On its own, with what it imports (a relationships file imported by `use *` as the empty file it is to an importer).
    const layoutFor = (uses: FileFacts['uses']): Record<string, string> => {
      const subset: Record<string, string> = { [entry]: set[entry] };
      const real = new Set<string>();
      for (const u of uses) {
        for (const t of targetsOf(u.resolved)) {
          if (t === entry) continue;
          if (!u.wildcard || !factsOf(t).pureRelationships) real.add(t);
          subset[t] = real.has(t) ? set[t] : '';
        }
      }
      return subset;
    };
    const chunks = facts.refs.length > CHUNK_REFS || facts.uses.length > CHUNK_USES ? chunksOf(set[entry], facts) : null;
    const layouts = chunks ? chunks.map((chunk) => ({ ...layoutFor(chunk.uses), [entry]: chunk.text })) : [layoutFor(facts.uses)];
    for (const subset of layouts) {
      const out = compileOnce(subset, entry);
      for (const d of out[entry] ?? []) add(entry, d);
      harvest(subset, entry, out);
      yield;
    }
  }

  // 2. Refs with the same endpoints, in files some file reaches together.
  const dbmlFiles = Object.keys(set).filter((p) => p.toLowerCase().endsWith('.dbml'));
  const sides = new Map<string, Array<{ file: string; line: number; column: number }>>();
  for (const file of dbmlFiles) {
    if (!reached.has(file)) continue;
    if (!/\bRef\b/.test(set[file])) continue;
    const facts = factsOf(file);
    if (facts.exotic || facts.refs.length === 0) continue;
    // By last name part: a schema-qualified name (`gold.a`) and its table are one.
    const visible = new Set(facts.declares.map(lastPart));
    for (const u of facts.uses) {
      const targets = targetsOf(u.resolved);
      if (targets.length === 0) continue;
      if (u.wildcard) { for (const t of targets) for (const name of declaresOf(t, set[t], factsOf(t))) visible.add(lastPart(name)); }
      else for (const name of u.tables) visible.add(lastPart(name));
    }
    for (const [index, ref] of facts.refs.entries()) {
      const members = ref.relationships;
      if (members.length === 0) continue;
      const from = members[0].fromModel;
      const to = members[0].toModel;
      if (!visible.has(lastPart(from)) || !visible.has(lastPart(to))) continue;
      const a = sideKey(from, members.map((m) => m.fromColumn));
      const b = sideKey(to, members.map((m) => m.toColumn));
      if (a === b) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      sides.set(key, [...(sides.get(key) ?? []), { file, line: ref.line, column: facts.refColumns[index] }]);
    }
  }
  const importers = new Map<string, string[]>();
  for (const file of dbmlFiles) for (const t of directTargets(file)) importers.set(t, [...(importers.get(t) ?? []), file]);
  const ancestors = new Map<string, Set<string>>();
  const ancestorsOf = (p: string): Set<string> => {
    let known = ancestors.get(p);
    if (!known) {
      known = new Set([p]);
      const queue = [p];
      while (queue.length > 0) for (const i of importers.get(queue.shift()!) ?? []) if (!known.has(i)) { known.add(i); queue.push(i); }
      ancestors.set(p, known);
    }
    return known;
  };
  /** Whether some entry reaches both files (a file reaches itself). */
  const together = (a: string, b: string): boolean => {
    const ofB = ancestorsOf(b);
    for (const x of ancestorsOf(a)) if (ofB.has(x) && entrySet.has(x)) return true;
    return false;
  };
  for (const list of sides.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!together(list[i].file, list[j].file)) continue;
        for (const at of [list[i], list[j]]) add(at.file, { code: SAME_ENDPOINTS_CODE, message: SAME_ENDPOINTS_MESSAGE, line: at.line, column: at.column });
      }
    }
  }
  return result;
}

/** A `use` line that is whole on its line and names only tables, so a chunk may blank it. */
const SPLITTABLE_USE = /^\s*use\s*\{\s*table\s+[^,{}]+(?:,\s*table\s+[^,{}]+)*\s*\}\s*from\s+(['"])[^'"\n]*\1\s*(?:\/\/.*)?$/;
/** Whole on its line, whatever it imports. */
const WHOLE_USE = /^\s*(?:re)?use\b[^\n]*\bfrom\s+(['"])[^'"\n]*\1\s*(?:\/\/.*)?$/;

/**
 * A file in chunks (part 1), or null when it cannot be split: each chunk is
 * the text with the other chunks' Refs and `use` lines blanked to spaces
 * (everything else, and any `use` line that is not `use { table … }` on one
 * line, stays in every chunk), with the `use` lines it keeps. A chunk keeps
 * every `use` line naming a table its Refs name, and `use` lines naming the
 * same table always stay together, so a clash between them is seen.
 */
function chunksOf(text: string, facts: FileFacts): Array<{ text: string; uses: FileFacts['uses'] }> | null {
  const starts = lineRanges(text);
  const lineText = (line: number): string => text.slice(starts[line - 1] ?? 0, starts[line] ?? text.length).replace(/\r?\n$/, '');
  if (!facts.uses.every((u) => WHOLE_USE.test(lineText(u.line)))) return null;
  const splittable = facts.uses.map((u) => !u.wildcard && SPLITTABLE_USE.test(lineText(u.line)));

  // Use lines naming the same table: one group.
  const parent = facts.uses.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const usesOfName = new Map<string, number[]>();
  facts.uses.forEach((u, i) => {
    if (!splittable[i]) return;
    for (const t of u.tables) usesOfName.set(t.toLowerCase(), [...(usesOfName.get(t.toLowerCase()) ?? []), i]);
  });
  for (const ids of usesOfName.values()) for (const id of ids.slice(1)) { const a = find(ids[0]); const b = find(id); if (a !== b) parent[a] = b; }
  const groupOf = (i: number): number => find(i);
  const groupMembers = new Map<number, number[]>();
  facts.uses.forEach((_, i) => { if (splittable[i]) groupMembers.set(groupOf(i), [...(groupMembers.get(groupOf(i)) ?? []), i]); });

  // Refs in order, CHUNK_REFS to a chunk, each with the groups its tables need.
  const chunks: Array<{ refs: Set<number>; groups: Set<number> }> = [];
  facts.refs.forEach((ref, i) => {
    if (i % CHUNK_REFS === 0) chunks.push({ refs: new Set(), groups: new Set() });
    const chunk = chunks[chunks.length - 1];
    chunk.refs.add(i);
    for (const m of ref.relationships) {
      for (const name of [m.fromModel, m.toModel]) {
        for (const id of usesOfName.get(name.toLowerCase()) ?? usesOfName.get(lastPart(name)) ?? []) chunk.groups.add(groupOf(id));
      }
    }
  });
  // Groups no Ref needs: checked once each, CHUNK_USES lines to a chunk.
  const needed = new Set(chunks.flatMap((c) => [...c.groups]));
  let spare: { refs: Set<number>; groups: Set<number> } | undefined;
  let spareLines = 0;
  for (const [group, members] of groupMembers) {
    if (needed.has(group)) continue;
    if (!spare || spareLines + members.length > CHUNK_USES) {
      spare = { refs: new Set(), groups: new Set() };
      chunks.push(spare);
      spareLines = 0;
    }
    spare.groups.add(group);
    spareLines += members.length;
  }
  if (chunks.length <= 1) return null;

  return chunks.map((chunk) => {
    const chars = text.split('');
    facts.refs.forEach((ref, i) => { if (!chunk.refs.has(i)) blankRange(chars, ref.start, ref.fullEnd); });
    const kept = facts.uses.filter((_, i) => !splittable[i] || chunk.groups.has(groupOf(i)));
    facts.uses.forEach((u, i) => {
      if (!splittable[i] || chunk.groups.has(groupOf(i))) return;
      blankRange(chars, starts[u.line - 1] ?? 0, starts[u.line] ?? text.length);
    });
    // A line left only blanks is emptied (its line break stays): every line keeps its number and
    // every kept character its column, and the compiler skips no run of spaces.
    return { text: chars.join('').replace(/^[ \t]+$/gm, ''), uses: kept };
  });
}
