/**
 * The `erd_layout` codec: a DBML diagram's table positions and sticky-note
 * boxes, held as one triple-quoted string in its Project (the last key), one
 * line per table or note:
 *
 * ```
 *   erd_layout: '''
 *     dim_customer 40 60
 *     fct_order 400 200
 *     note/3f2b 720 40 220 120
 *   '''
 * ```
 *
 * This module is the parser-free half: the decoded value read into an
 * {@link ErdLayout} and written back from one. The DBML half (finding the
 * entry in a Project, splicing a new value in) is `dbml/erdLayoutDbml.ts`.
 *
 * Every write rewrites the whole value in one canonical form (tables sorted
 * by name, then notes by id, in code-unit order; numbers rounded to two
 * decimals), so two layouts are equal exactly when their canonical lines are.
 *
 * A hand edit must never end a line inside the value with `\`: DBML joins it
 * with the next line. The writer never does, since it writes `\` as `\\`.
 *
 * Pure and parser-free.
 */

import { findConflictMarkers } from './mergeConflict.js';
import type { Annotation, NodePosition } from './types/semantic.js';

/** A note line's prefix: `note/<id> x y` or `note/<id> x y w h`. A table name never starts with it. */
export const ERD_LAYOUT_NOTE_PREFIX = 'note/';

/** A sticky note's box in `erd_layout`: no width or height means the canvas's default size. */
export interface ErdLayoutSticky {
  id: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** What `erd_layout` holds: table positions by name, and sticky-note boxes. */
export interface ErdLayout {
  positions: Record<string, NodePosition>;
  stickies: ErdLayoutSticky[];
}

/** A line of the value that was not read: a bad line, or a name listed again. */
export interface ErdLayoutLineProblem {
  /** 0-based line of the decoded value (line 0 is the rest of the key's own line). */
  index: number;
  /** `badLine`: not `<name> <x> <y>`; `duplicate`: a name an earlier line already placed. */
  kind: 'badLine' | 'duplicate';
  message: string;
}

/** A decoded value, read: what it places, the lines it could not read, and the first conflict marker. */
export interface ErdLayoutReading extends ErdLayout {
  problems: ErdLayoutLineProblem[];
  /** 0-based line of the value's first `<<<<<<<` that opens a complete git conflict. */
  conflictIndex?: number;
}

/** A number as `erd_layout` reads it: an optional sign, digits with an optional fraction, an optional exponent. */
const NUM = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const TWO_NUMBERS = new RegExp(`^(.*?\\S)\\s+(${NUM})\\s+(${NUM})$`);
const FOUR_NUMBERS = new RegExp(`^(.*?\\S)\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})$`);
/** Git's conflict marker lines (trimmed): skipped silently, so a conflicted value still reads best effort. */
const MARKER_LINE = /^(?:<{7,}|={7,}\s*$|>{7,}|\|{7,})/;

/** Above this, positions are whole numbers: two decimals no longer survive a write and a read unchanged. */
const WHOLE_NUMBERS_FROM = 1e12;

/**
 * `n` as `erd_layout` writes it: rounded to two decimals, with no `-0`.
 * Idempotent, so a value read back rounds to itself (from 1e12 up, to a
 * whole number, where two decimals would drift on every write).
 */
export function roundLayoutNumber(n: number): number {
  const rounded = Math.abs(n) < WHOLE_NUMBERS_FROM ? Math.round(n * 100) / 100 : Math.round(n);
  return rounded === 0 ? 0 : rounded;
}

/**
 * Whether `name` can be a line of `erd_layout`: a non-empty string with no
 * white space at either end and no line break. A table name must also not
 * start with {@link ERD_LAYOUT_NOTE_PREFIX} (checked by the callers that
 * write table lines).
 */
export function isErdLayoutName(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && name === name.trim() && !/[\r\n]/.test(name);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A positive size, rounded; undefined for a missing, non-finite or non-positive one (or one that rounds to 0). */
function sizeOf(value: unknown): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  const rounded = roundLayoutNumber(value);
  return rounded > 0 ? rounded : undefined;
}

/** Set an own property, so a name such as `__proto__` is an entry like any other. */
function setEntry<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The layout `erd_layout` would hold for these canvas positions and sticky
 * notes: only the representable entries (a name `erd_layout` can hold,
 * finite `x` and `y`), every number rounded, tables sorted by name and notes
 * by id in code-unit order. A note's width or height that is not a positive
 * finite number is left out (the canvas's default size). A repeated note id
 * keeps its first box.
 */
export function erdLayoutOf(
  positions: Record<string, NodePosition> | undefined,
  annotations: readonly Annotation[] | undefined,
): ErdLayout {
  const out: Record<string, NodePosition> = {};
  const record = positions && typeof positions === 'object' ? positions : {};
  for (const name of Object.keys(record).sort(byCodeUnits)) {
    const position = record[name];
    if (!isErdLayoutName(name) || name.startsWith(ERD_LAYOUT_NOTE_PREFIX)) continue;
    if (!position || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) continue;
    setEntry(out, name, { x: roundLayoutNumber(position.x), y: roundLayoutNumber(position.y) });
  }
  const stickies: ErdLayoutSticky[] = [];
  const seen = new Set<string>();
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    if (!annotation || !isErdLayoutName(annotation.id) || seen.has(annotation.id)) continue;
    if (!isFiniteNumber(annotation.x) || !isFiniteNumber(annotation.y)) continue;
    seen.add(annotation.id);
    const width = sizeOf(annotation.width);
    const height = sizeOf(annotation.height);
    stickies.push({
      id: annotation.id,
      x: roundLayoutNumber(annotation.x),
      y: roundLayoutNumber(annotation.y),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    });
  }
  stickies.sort((a, b) => byCodeUnits(a.id, b.id));
  return { positions: out, stickies };
}

/** The value's lines for `layout`, canonical: representable entries only, rounded and sorted. */
function canonicalLines(layout: ErdLayout): string[] {
  const canonical = erdLayoutOf(layout.positions, layout.stickies.map((s) => ({ ...s, text: '' })));
  const n = (v: number): string => String(v);
  const lines = Object.keys(canonical.positions).sort(byCodeUnits).map((name) => {
    const p = canonical.positions[name];
    return `${name} ${n(p.x)} ${n(p.y)}`;
  });
  for (const s of canonical.stickies) {
    const sized = s.width !== undefined || s.height !== undefined;
    lines.push(`${ERD_LAYOUT_NOTE_PREFIX}${s.id} ${n(s.x)} ${n(s.y)}${sized ? ` ${n(s.width ?? 0)} ${n(s.height ?? 0)}` : ''}`);
  }
  return lines;
}

/** Whether two layouts write the same `erd_layout` (equal canonical lines). */
export function sameErdLayout(a: ErdLayout, b: ErdLayout): boolean {
  const left = canonicalLines(a);
  const right = canonicalLines(b);
  return left.length === right.length && left.every((line, i) => line === right[i]);
}

/**
 * The decoded value of `erd_layout` for `layout` (before DBML string
 * escaping): `<eol><indent>  <line><eol>…<indent>`, so the key line is
 * `<indent>erd_layout: '''`, each entry is indented two more, and the closing
 * `'''` sits at `indent`. Undefined when there is nothing to place (the key
 * is then cut, or never written).
 */
export function renderErdLayoutValue(layout: ErdLayout, format: { eol: string; indent: string }): string | undefined {
  const lines = canonicalLines(layout);
  if (lines.length === 0) return undefined;
  const { eol, indent } = format;
  return `${lines.map((line) => `${eol}${indent}  ${line}`).join('')}${eol}${indent}`;
}

/**
 * `layout` with each member's table line spelled as the member is, for a
 * write: a member's own entry wins and every other entry whose name equals
 * it case-insensitively is dropped (so a drag never leaves `Dim_Customer`
 * beside `dim_customer`); a member with no entry of its own takes the first
 * case variant (in code-unit order). Entries that match no member (strays)
 * and the notes are kept as they are.
 */
export function withMemberSpelling(layout: ErdLayout, members: readonly string[]): ErdLayout {
  const positions: Record<string, NodePosition> = {};
  const names = Object.keys(layout.positions).sort(byCodeUnits);
  const present = new Set(names);
  const memberOf = new Map<string, string>();
  for (const member of members) {
    if (typeof member !== 'string') continue;
    const key = member.toLowerCase();
    const earlier = memberOf.get(key);
    // Members differ in more than case; if two do not, the one with an entry of its own wins.
    if (earlier === undefined || (!present.has(earlier) && present.has(member))) memberOf.set(key, member);
  }
  const placed = new Set<string>();
  // Exact member entries first, so a case variant never takes a member's place.
  for (const name of names) {
    const member = memberOf.get(name.toLowerCase());
    if (member === name) {
      setEntry(positions, name, layout.positions[name]);
      placed.add(name.toLowerCase());
    }
  }
  for (const name of names) {
    const key = name.toLowerCase();
    const member = memberOf.get(key);
    if (member === undefined) {
      setEntry(positions, name, layout.positions[name]);
      continue;
    }
    if (member === name || placed.has(key)) continue;
    setEntry(positions, member, layout.positions[name]);
    placed.add(key);
  }
  return { positions, stickies: layout.stickies };
}

function badLineMessage(line: number): string {
  return `line ${line} of erd_layout is not <name> <x> <y>; it is skipped and that table is placed automatically`;
}

/** Numbers that are all finite, or null. */
function finite(values: readonly string[]): number[] | null {
  const numbers = values.map(Number);
  return numbers.every((v) => Number.isFinite(v)) ? numbers : null;
}

/**
 * Read a decoded `erd_layout` value (the parser's literal, never re-decoded
 * here). Tolerant: each line is trimmed; empty lines and git conflict-marker
 * lines are skipped silently; a line that is neither `<name> <x> <y>` nor
 * `note/<id> <x> <y> [<w> <h>]` is a `badLine` problem, and a name placed by
 * an earlier line is a `duplicate` (the first wins). Names are read from the
 * right, so they may hold spaces.
 *
 * A note line with four trailing numbers can also be read as a two-number
 * line whose id ends in two numbers (`note/q 1 2 3 4`: `q` sized, or `q 1 2`
 * unsized). `noteIds` (the diagram's Note names) settles it: the reading whose
 * id is a Note and whose other id is not wins; otherwise the sized one. A
 * width or height of 0 or less is no size.
 *
 * Table names are returned as written: mapping them to the diagram's members
 * (exact first, then case-insensitively) is the diagram reader's job.
 */
export function readErdLayout(value: string, noteIds?: ReadonlySet<string>): ErdLayoutReading {
  const positions: Record<string, NodePosition> = {};
  const stickies: ErdLayoutSticky[] = [];
  const problems: ErdLayoutLineProblem[] = [];
  const seen = new Set<string>();
  const lines = String(value ?? '').split(/\r?\n/);
  const duplicate = (index: number, name: string): void => {
    problems.push({ index, kind: 'duplicate', message: `${name} is listed twice in erd_layout; the first is read` });
  };
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || MARKER_LINE.test(line)) return;
    if (line.startsWith(ERD_LAYOUT_NOTE_PREFIX)) {
      const rest = line.slice(ERD_LAYOUT_NOTE_PREFIX.length);
      const four = FOUR_NUMBERS.exec(rest);
      const two = TWO_NUMBERS.exec(rest);
      const fourNumbers = four ? finite(four.slice(2, 6)) : null;
      const twoNumbers = two ? finite(two.slice(2, 4)) : null;
      let sized: boolean;
      if (four && fourNumbers && two && twoNumbers) {
        const isNote4 = noteIds?.has(four[1]) ?? false;
        const isNote2 = noteIds?.has(two[1]) ?? false;
        sized = !(isNote2 && !isNote4);
      } else if (four && fourNumbers) {
        sized = true;
      } else if (two && twoNumbers) {
        sized = false;
      } else {
        problems.push({ index, kind: 'badLine', message: badLineMessage(index + 1) });
        return;
      }
      const id = sized ? four![1] : two![1];
      const [x, y, width, height] = sized ? fourNumbers! : twoNumbers!;
      if (seen.has(ERD_LAYOUT_NOTE_PREFIX + id)) {
        duplicate(index, ERD_LAYOUT_NOTE_PREFIX + id);
        return;
      }
      seen.add(ERD_LAYOUT_NOTE_PREFIX + id);
      stickies.push({
        id,
        x,
        y,
        ...(sized && width > 0 ? { width } : {}),
        ...(sized && height > 0 ? { height } : {}),
      });
      return;
    }
    const table = TWO_NUMBERS.exec(line);
    const numbers = table ? finite(table.slice(2, 4)) : null;
    if (!table || !numbers) {
      problems.push({ index, kind: 'badLine', message: badLineMessage(index + 1) });
      return;
    }
    const name = table[1];
    if (seen.has(name)) {
      duplicate(index, name);
      return;
    }
    seen.add(name);
    setEntry(positions, name, { x: numbers[0], y: numbers[1] });
  });
  const conflict = findConflictMarkers(String(value ?? ''));
  return { positions, stickies, problems, ...(conflict !== null ? { conflictIndex: conflict - 1 } : {}) };
}

/** Where {@link placeUnlaidStickies} assumes a table's right edge is: the canvas's default node width. */
const UNLAID_TABLE_WIDTH = 280;
/** The canvas's default sticky-note size, for a note whose layout gives none. */
const UNLAID_NOTE_WIDTH = 160;
const UNLAID_NOTE_HEIGHT = 80;
/** The gap between the column of placed notes and everything left of it, and between notes. */
const UNLAID_NOTE_GAP = 40;

/**
 * Places for the sticky notes a DBML diagram declares but its `erd_layout`
 * does not place (an assistant added a `Note`), so they never stack on the
 * origin: one column to the right of every laid-out table position and note,
 * 40 px apart, in file order, starting level with the highest laid-out item.
 * Deterministic and parser-free; it never writes (the next layout write
 * persists whatever the canvas holds).
 *
 * @param noteIds  every Note in file order; ids already in `stickies` keep their layout and get no entry
 * @returns a place for each unlaid id
 */
export function placeUnlaidStickies(
  noteIds: readonly string[],
  positions: Record<string, NodePosition>,
  stickies: readonly ErdLayoutSticky[],
): Record<string, NodePosition> {
  const laid = new Set(stickies.map((s) => s.id));
  const pending = noteIds.filter((id, i) => !laid.has(id) && noteIds.indexOf(id) === i);
  const placed: Record<string, NodePosition> = {};
  if (pending.length === 0) return placed;

  let right = -Infinity;
  let top = Infinity;
  for (const position of Object.values(positions ?? {})) {
    if (!position || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) continue;
    right = Math.max(right, position.x + UNLAID_TABLE_WIDTH);
    top = Math.min(top, position.y);
  }
  for (const sticky of stickies) {
    if (!isFiniteNumber(sticky.x) || !isFiniteNumber(sticky.y)) continue;
    right = Math.max(right, sticky.x + (isFiniteNumber(sticky.width) && sticky.width > 0 ? sticky.width : UNLAID_NOTE_WIDTH));
    top = Math.min(top, sticky.y);
  }
  const x = right === -Infinity ? 0 : roundLayoutNumber(right + UNLAID_NOTE_GAP);
  let y = top === Infinity ? 0 : roundLayoutNumber(top);
  for (const id of pending) {
    setEntry(placed, id, { x, y });
    y = roundLayoutNumber(y + UNLAID_NOTE_HEIGHT + UNLAID_NOTE_GAP);
  }
  return placed;
}

/** What a diagram shows from its `erd_layout` ({@link erdLayoutView}). */
export interface ErdLayoutView {
  /** Table positions, keyed by member where a line names one (in any case); a stray keeps its own name. */
  positions: Record<string, NodePosition>;
  /** A box for each Note id: its sticky line, else a place beside everything laid out. */
  boxes: Record<string, ErdLayoutSticky>;
}

/**
 * A layout as the diagram reader maps it onto the diagram: each table line
 * is matched to a member exactly first, then case-insensitively (a member is
 * a file stem, which may differ in case from the declared name, D2), and
 * re-keyed to the member's spelling. An exact line wins over a case variant,
 * which then stays a stray under its own name, as does a line that matches
 * no member (strays are kept: the next write keeps them too). Each Note in
 * `noteIds` (file order) gets its sticky line's box, else a place from
 * {@link placeUnlaidStickies}. Pure and parser-free.
 */
export function erdLayoutView(layout: ErdLayout, members: readonly string[], noteIds: readonly string[]): ErdLayoutView {
  const memberOf = new Map<string, string>();
  for (const member of members) {
    if (typeof member === 'string' && !memberOf.has(member.toLowerCase())) memberOf.set(member.toLowerCase(), member);
  }
  const names = Object.keys(layout.positions);
  const taken = new Set(names.filter((name) => memberOf.get(name.toLowerCase()) === name).map((name) => name.toLowerCase()));
  const positions: Record<string, NodePosition> = {};
  for (const name of names) {
    const key = name.toLowerCase();
    const member = memberOf.get(key);
    if (member !== undefined && member !== name && !taken.has(key)) {
      taken.add(key);
      setEntry(positions, member, layout.positions[name]);
    } else {
      setEntry(positions, name, layout.positions[name]);
    }
  }
  const laid = new Map(layout.stickies.map((s) => [s.id, s] as const));
  const placed = placeUnlaidStickies(noteIds, positions, layout.stickies);
  const boxes: Record<string, ErdLayoutSticky> = {};
  for (const id of noteIds) {
    if (Object.prototype.hasOwnProperty.call(boxes, id)) continue;
    const sticky = laid.get(id);
    const place = sticky ?? placed[id] ?? { x: 0, y: 0 };
    setEntry(boxes, id, {
      id,
      x: place.x,
      y: place.y,
      ...(sticky?.width !== undefined ? { width: sticky.width } : {}),
      ...(sticky?.height !== undefined ? { height: sticky.height } : {}),
    });
  }
  return { positions, boxes };
}
