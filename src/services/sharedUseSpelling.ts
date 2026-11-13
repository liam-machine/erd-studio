/**
 * `use` lines of one DBML file that import two different table files under
 * the same spelling (Gerhard, photo-2):
 *
 *   use { table adresse } from '../tables/bqs/adresse.dbml'
 *   use { table adresse } from '../tables/ccc/adresse.dbml'
 *
 * Both table files declare `Table adresse` with no schema, which DBML reads
 * as `public.adresse`, so every DBML parser refuses the second import with
 * [3003] and other DBML tools draw one table. ERD Studio tells the two apart
 * by their schema folders, but a Ref end spelled `adresse` names neither.
 * The fix is to declare each in its folder's schema (`Table bqs.adresse`)
 * and spell the specifiers and Ref ends the same way, which ERD Studio's
 * Qualify does in one edit.
 *
 * Pure text scan (no parser), so the editor can check every file an edit
 * writes and `doctor` every file of a project cheaply. Never imports
 * `vscode`: the CLI bundles it.
 */

import { dirnamePosix, normalisePosix, resolvePosix, tableIdKey, tableIdOfPath } from '@erd-studio/core';
import type { TableId } from '@erd-studio/core';

/** One `use` specifier of a {@link SharedUseSpelling}. */
export interface SharedUse {
  /** 1-based line of the `use` line. */
  line: number;
  /** The line's path as written. */
  path: string;
  /** The path resolved against the file's folder, posix, relative to the semantic dir. */
  resolved: string;
  /** The table file's identity, when the path is a table file's. */
  id?: TableId;
}

/** A spelling two or more `use` lines of one file import from different table files. */
export interface SharedUseSpelling {
  /** The specifier as written on its first line (`adresse`, `bqs.adresse`). */
  spelling: string;
  /** Every line importing it, in file order (two or more table identities among them). */
  uses: SharedUse[];
}

const lower = (s: string): string => s.toLowerCase();

/** `a`, `a and b`, `a, b and c`. */
export const listInWords = (words: readonly string[]): string =>
  words.length > 2 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words.join(' and ');

/** A specifier's name parts with DBML's double quotes removed: `"a b".c` → [`a b`, `c`]. */
function nameParts(text: string): string[] {
  const parts: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^."\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) parts.push(m[1] ?? m[2]);
  return parts;
}

/**
 * The spellings `text`'s own selective `use` lines import from two or more
 * table files of different identities (a specifier with `as <alias>` is
 * spelled by its alias). `filePath`: the file, posix, relative to the
 * semantic dir. In order of each spelling's first line.
 */
export function sharedUseSpellings(text: string, filePath: string): SharedUseSpelling[] {
  const folder = dirnamePosix(filePath);
  const bySpelling = new Map<string, { spelling: string; uses: SharedUse[]; ids: Set<string> }>();
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const re = /^[ \t]*use[ \t]*\{([^}]*)\}[ \t]*from[ \t]*(['"])(.*?)\2/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [, list, , importPath] = m;
    const withExt = lower(importPath).endsWith('.dbml') ? importPath : `${importPath}.dbml`;
    const resolved = normalisePosix(resolvePosix(folder, withExt));
    const id = tableIdOfPath(resolved);
    const line = lineAt(m.index);
    for (const raw of list.split(',')) {
      const spec = /^\s*table\s+(.+?)(?:\s+as\s+(.+?))?\s*$/i.exec(raw);
      if (!spec) continue;
      const spelling = (spec[2] ?? spec[1]).trim();
      const key = nameParts(spelling).map(lower).join('.');
      if (key === '') continue;
      const entry = bySpelling.get(key) ?? { spelling, uses: [], ids: new Set<string>() };
      bySpelling.set(key, entry);
      entry.uses.push({ line, path: importPath, resolved, ...(id !== undefined ? { id } : {}) });
      entry.ids.add(id !== undefined ? tableIdKey(id) : lower(resolved));
    }
  }
  return [...bySpelling.values()].filter((e) => e.ids.size > 1).map(({ spelling, uses }) => ({ spelling, uses }));
}

/** A stable key for a group: its spelling and its table identities, so an edit can tell a group it adds from one already there. */
export function sharedUseSpellingKey(group: SharedUseSpelling): string {
  const ids = [...new Set(group.uses.map((u) => (u.id !== undefined ? tableIdKey(u.id) : lower(u.resolved))))].sort();
  return `${nameParts(group.spelling).map(lower).join('.')}\u0000${ids.join('\u0001')}`;
}

/**
 * The sentence that says what is wrong with a group and how to write it, for
 * `doctor`, the canvas and the edit prompt: `at` is the line the user should
 * look at (a later import of the spelling), `others` the lines before it.
 */
export function sharedUseSpellingMessage(group: SharedUseSpelling, at: SharedUse, where: 'doctor' | 'canvas' = 'doctor'): string {
  const name = nameParts(group.spelling).pop() ?? group.spelling;
  const others = group.uses.filter((u) => u !== at && (u.id === undefined || at.id === undefined || tableIdKey(u.id) !== tableIdKey(at.id)));
  const earlier = others.map((u) => `line ${u.line} (${u.path})`).join(' and ');
  const qualified = (u: SharedUse): string => (u.id !== undefined ? `${u.id.schema}.${name}` : group.spelling);
  const schemas = [at, ...others].map(qualified);
  return `Line ${at.line} imports ${group.spelling} from ${at.path}, as ${earlier} ${others.length === 1 ? 'does' : 'do'} from another file. `
    + `DBML reads both as one table, so dbdiagram.io and other DBML tools refuse this import ([3003]) and show only one ${name}, and a Ref end spelled ${group.spelling} names neither. `
    + `Declare each table in its schema folder's schema (${schemas.map((s) => `Table ${s}`).join(', ')}) and spell the use lines and Refs the same way`
    + (at.id !== undefined ? ` (use { table ${qualified(at)} } from '${at.path}')` : '')
    + (where === 'canvas' ? '. Qualify Tables does all of it in one edit.' : ': opening the diagram in ERD Studio offers Qualify Tables, which does all of it in one edit.');
}

/** `spelling` as a regular expression over DBML text: each name part bare or double-quoted, any case. */
function spellingPattern(spelling: string): string {
  return nameParts(spelling)
    .map((part) => {
      const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return `(?:${escaped}|"${escaped}")`;
    })
    .join('\\s*\\.\\s*');
}

/**
 * Whether `after` has a line naming `spelling` that `before` does not have
 * as many times: a Ref end (`adresse.id`) or a `use { table adresse }`
 * specifier. Lines compared trimmed, so an edit that only moves a line or
 * re-indents it adds nothing; a line the edit leaves as it was never counts.
 */
/** The 1-based lines of `text` whose Ref (a line with a Ref operator) has an end spelled `spelling`. */
export function refLinesNamingSpelling(text: string, spelling: string): Set<number> {
  const name = spellingPattern(spelling);
  const out = new Set<number>();
  if (name === '') return out;
  const asEnd = new RegExp(`(^|[\\s:<>\\-,(])${name}\\s*\\.`, 'i');
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line.startsWith('//') && !/^use\b/i.test(line) && /[<>-]/.test(line) && asEnd.test(line)) out.add(i + 1);
  });
  return out;
}

export function addsLineNamingSpelling(before: string, after: string, spelling: string): boolean {
  const name = spellingPattern(spelling);
  if (name === '') return false;
  const asEnd = new RegExp(`(^|[\\s:<>\\-,(])${name}\\s*\\.`, 'i');
  const asUse = new RegExp(`^\\s*use\\s*\\{[^}]*\\btable\\s+${name}(\\s|,|\\})`, 'i');
  const naming = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('//') || !(asUse.test(line) || (/^Ref\b/i.test(line) || /[<>-]/.test(line)) && asEnd.test(line))) continue;
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return counts;
  };
  const was = naming(before);
  for (const [line, count] of naming(after)) if (count > (was.get(line) ?? 0)) return true;
  return false;
}
