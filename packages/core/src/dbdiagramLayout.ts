/**
 * The canvas layout of a rich DBML export (`toDbmlRich`), as dbdiagram's own
 * `<name>.dbdiagram` file: `dbdiagram push silver.dbml` reads `silver.dbdiagram`
 * from beside it, so the diagram opens in dbdiagram where it was on the
 * canvas, and `dbdiagram pull` writes one that ERD Studio's DBML import reads
 * back ({@link readDbdiagramLayout}).
 *
 * Built only from a file `dbdiagram pull` wrote from our own diagram and
 * dbdiagram's public documentation. The shape (version `"3.0.0"`):
 *
 * ```json
 * {
 *   "version": "3.0.0",
 *   "gridEnabling": false,
 *   "currentViewName": null,
 *   "defaultView": {
 *     "detailLevel": "All",
 *     "relationshipMode": "All",
 *     "tablePositions": [{ "name": "fct_order", "schemaName": "public", "x": 540.33, "y": 557 }],
 *     "tableGroupCollapseStates": [],
 *     "stickyNoteLayouts": [],
 *     "referencePaths": []
 *   },
 *   "views": {}
 * }
 * ```
 *
 * - `tablePositions` names each table exactly as `toDbmlRich` writes it; a
 *   table with no schema is in `"public"`, as dbdiagram writes it. Only tables
 *   the export writes and the canvas has placed are listed, in the export's
 *   table order. Coordinates are canvas pixels (both tools place a table by
 *   its top-left corner), rounded to two decimals.
 * - Sticky notes keep no layout: the shape of a `stickyNoteLayouts` entry is
 *   not documented, so the list is written empty (the reader accepts the
 *   obvious one). Relationship paths, collapsed groups and dark mode are
 *   dbdiagram's own and are left to it.
 *
 * Pure and deterministic; never throws.
 */

import type { DisplaySubjectArea } from './types/display.js';
import type { Annotation, NodePosition } from './types/semantic.js';
import { prepareSubjectArea } from './exportShared.js';
import { exportFileBase } from './exportFileName.js';

/** The `.dbdiagram` format version written. */
export const DBDIAGRAM_LAYOUT_VERSION = '3.0.0';

/** The schema dbdiagram gives a table that names none. */
export const DBDIAGRAM_DEFAULT_SCHEMA = 'public';

/** One table's place in a `.dbdiagram` file. */
export interface DbdiagramTablePosition {
  name: string;
  /** `"public"` for a table that names no schema. */
  schemaName: string;
  x: number;
  y: number;
}

/** A sticky note's place, as far as a `.dbdiagram` file says it. */
export interface DbdiagramStickyLayout {
  name: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** The `.dbdiagram` file ERD Studio writes. */
export interface DbdiagramLayout {
  version: string;
  gridEnabling: boolean;
  currentViewName: string | null;
  defaultView: {
    detailLevel: string;
    relationshipMode: string;
    tablePositions: DbdiagramTablePosition[];
    tableGroupCollapseStates: unknown[];
    stickyNoteLayouts: unknown[];
    referencePaths: unknown[];
  };
  views: Record<string, unknown>;
}

/** What {@link readDbdiagramLayout} could read, and what it could not. */
export interface DbdiagramLayoutReading {
  /** Every readable table position, in file order; a table listed twice keeps its first. `schemaName` as written. */
  tables: DbdiagramTablePosition[];
  stickies: DbdiagramStickyLayout[];
  /** Plain-English sentences, one per thing that could not be read (empty when everything was). */
  problems: string[];
}

/** The `.dbdiagram` file beside the rich export of `area`: `showcase.dbdiagram` beside `showcase.dbml`. */
export function dbdiagramLayoutFileName(area: Pick<DisplaySubjectArea, 'domain'>): string {
  return `${exportFileBase(area)}.dbdiagram`;
}

/** `value` rounded to two decimals, with no `-0`. */
function round(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The canvas position of `name`: its own entry, else one spelled in another case. */
function positionOf(positions: Record<string, unknown>, name: string): NodePosition | undefined {
  const own = Object.prototype.hasOwnProperty.call(positions, name) ? positions[name] : undefined;
  const entry = own ?? Object.entries(positions).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (!entry || typeof entry !== 'object') return undefined;
  const { x, y } = entry as Record<string, unknown>;
  return isFiniteNumber(x) && isFiniteNumber(y) ? { x, y } : undefined;
}

/** The layout of `area`'s rich DBML export, as dbdiagram's `.dbdiagram` JSON. */
export function toDbdiagramLayout(area: DisplaySubjectArea): DbdiagramLayout {
  const input = (area && typeof area === 'object' ? area : {}) as unknown as Record<string, unknown>;
  const viewConfig = input.viewConfig && typeof input.viewConfig === 'object' ? (input.viewConfig as Record<string, unknown>) : {};
  const positions =
    viewConfig.positions && typeof viewConfig.positions === 'object' && !Array.isArray(viewConfig.positions)
      ? (viewConfig.positions as Record<string, unknown>)
      : {};
  const tablePositions: DbdiagramTablePosition[] = [];
  for (const item of prepareSubjectArea(area).models) {
    if (item.kind !== 'model') continue;
    const position = positionOf(positions, item.model.name);
    if (!position) continue;
    tablePositions.push({
      name: item.model.name,
      schemaName: item.model.schema || DBDIAGRAM_DEFAULT_SCHEMA,
      x: round(position.x),
      y: round(position.y),
    });
  }
  return {
    version: DBDIAGRAM_LAYOUT_VERSION,
    gridEnabling: false,
    currentViewName: null,
    defaultView: {
      detailLevel: 'All',
      relationshipMode: 'All',
      tablePositions,
      tableGroupCollapseStates: [],
      stickyNoteLayouts: [],
      referencePaths: [],
    },
    views: {},
  };
}

/** {@link toDbdiagramLayout} as the file's text: two-space JSON and a final line break. */
export function serializeDbdiagramLayout(area: DisplaySubjectArea): string {
  return JSON.stringify(toDbdiagramLayout(area), null, 2) + '\n';
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Read a `.dbdiagram` file for import. Tolerant: reads every table position
 * and sticky-note layout it can from `defaultView` and reports, in
 * `problems`, what it could not — the file is not JSON, a version other than
 * 3.x (read anyway), an entry without a name or numeric x / y. Never throws.
 */
export function readDbdiagramLayout(text: string): DbdiagramLayoutReading {
  const reading: DbdiagramLayoutReading = { tables: [], stickies: [], problems: [] };
  try {
    readInto(reading, text);
  } catch {
    reading.problems.push('The layout file could not be read.');
  }
  return reading;
}

function readInto(reading: DbdiagramLayoutReading, text: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '');
  } catch {
    reading.problems.push('The layout file is not JSON.');
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reading.problems.push('The layout file is not a JSON object.');
    return;
  }
  const file = parsed as Record<string, unknown>;
  const version = file.version;
  if (version === undefined) {
    reading.problems.push('The layout file has no version (read anyway).');
  } else if ((typeof version !== 'string' && typeof version !== 'number') || !/^3(\.|$)/.test(String(version))) {
    reading.problems.push(`The layout file has version ${JSON.stringify(version)}, not 3.x (read anyway).`);
  }
  const view = file.defaultView;
  if (!view || typeof view !== 'object' || Array.isArray(view)) {
    reading.problems.push('The layout file has no defaultView, so it places nothing.');
    return;
  }
  const { tablePositions, stickyNoteLayouts } = view as Record<string, unknown>;

  if (tablePositions !== undefined && !Array.isArray(tablePositions)) {
    reading.problems.push('Its tablePositions is not a list, so no table is placed.');
  }
  let unreadable = 0;
  let repeated = 0;
  const seen = new Set<string>();
  for (const entry of Array.isArray(tablePositions) ? tablePositions : []) {
    const raw = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const { name, schemaName, x, y } = raw;
    if (typeof name !== 'string' || name === '' || !isFiniteNumber(x) || !isFiniteNumber(y)) {
      unreadable++;
      continue;
    }
    const schema = typeof schemaName === 'string' && schemaName !== '' ? schemaName : DBDIAGRAM_DEFAULT_SCHEMA;
    const key = `${schema}\u0000${name}`;
    if (seen.has(key)) {
      repeated++;
      continue;
    }
    seen.add(key);
    reading.tables.push({ name, schemaName: schema, x, y });
  }
  if (unreadable > 0) {
    reading.problems.push(`${plural(unreadable, 'table position has', 'table positions have')} no name or no numeric x and y, so ${unreadable === 1 ? 'it was' : 'they were'} skipped.`);
  }
  if (repeated > 0) {
    reading.problems.push(`${plural(repeated, 'table is', 'tables are')} placed more than once; the first place is used.`);
  }

  if (stickyNoteLayouts !== undefined && !Array.isArray(stickyNoteLayouts)) {
    reading.problems.push('Its stickyNoteLayouts is not a list, so no sticky note is placed.');
  }
  let unreadableStickies = 0;
  const stickyNames = new Set<string>();
  for (const entry of Array.isArray(stickyNoteLayouts) ? stickyNoteLayouts : []) {
    const raw = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const { name, x, y, width, height } = raw;
    if (typeof name !== 'string' || name === '' || !isFiniteNumber(x) || !isFiniteNumber(y)) {
      unreadableStickies++;
      continue;
    }
    if (stickyNames.has(name)) continue;
    stickyNames.add(name);
    reading.stickies.push({
      name,
      x,
      y,
      ...(isFiniteNumber(width) && width > 0 ? { width } : {}),
      ...(isFiniteNumber(height) && height > 0 ? { height } : {}),
    });
  }
  if (unreadableStickies > 0) {
    reading.problems.push(`${plural(unreadableStickies, 'sticky-note layout was', 'sticky-note layouts were')} not in a shape ERD Studio reads, so ${unreadableStickies === 1 ? 'it was' : 'they were'} skipped.`);
  }
}

// ---------------------------------------------------------------------------
// Native DBML storage: a diagram's layout file
// ---------------------------------------------------------------------------

/**
 * A layout file ERD Studio will not rewrite: its text is not a JSON object.
 * It is read with a warning (nothing placed from it) and never regenerated;
 * the user fixes or deletes it.
 */
export class DbdiagramLayoutRefused extends Error {
  constructor(message = 'The layout file is not a JSON object. Fix it or delete it first: ERD Studio never rewrites a file it cannot read.') {
    super(message);
    this.name = 'DbdiagramLayoutRefused';
  }
}

/** A sticky note's layout in a diagram's layout file, from its annotation: the size only when set and positive. */
export function stickyLayoutsOf(annotations: ReadonlyArray<Pick<Annotation, 'id' | 'x' | 'y' | 'width' | 'height'>> | undefined): DbdiagramStickyLayout[] {
  const out: DbdiagramStickyLayout[] = [];
  for (const annotation of annotations ?? []) {
    if (!annotation || typeof annotation.id !== 'string' || annotation.id === '') continue;
    if (!isFiniteNumber(annotation.x) || !isFiniteNumber(annotation.y)) continue;
    out.push({
      name: annotation.id,
      x: round(annotation.x),
      y: round(annotation.y),
      ...(isFiniteNumber(annotation.width) && annotation.width > 0 ? { width: round(annotation.width) } : {}),
      ...(isFiniteNumber(annotation.height) && annotation.height > 0 ? { height: round(annotation.height) } : {}),
    });
  }
  return out;
}

/** The `tablePositions` of `positions`, in its order: `schemaName` `"public"` (names are unqualified), x and y to two decimals. */
function tablePositionsOf(positions: Record<string, NodePosition>): DbdiagramTablePosition[] {
  const out: DbdiagramTablePosition[] = [];
  for (const [name, position] of Object.entries(positions ?? {})) {
    if (!position || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) continue;
    out.push({ name, schemaName: DBDIAGRAM_DEFAULT_SCHEMA, x: round(position.x), y: round(position.y) });
  }
  return out;
}

/** Structural equality of two JSON values (key order ignored). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/**
 * The new text of a DBML diagram's layout file (`<name>.dbdiagram`), or
 * `null` when nothing needs writing. ERD Studio owns two lists in it,
 * `defaultView.tablePositions` and `defaultView.stickyNoteLayouts`; every
 * other key and value is kept as parsed. An existing file keeps its own
 * style ({@link jsonStyleOf}): compact on one line or indented by its own
 * width (spaces or tabs), its line endings, its byte-order mark and whatever
 * it ends with. The two lists are merged into the file's entries, in its
 * order, so an entry that did not move keeps its keys, their order and
 * any key ERD Studio does not own: moving one table changes that table's
 * lines and nothing else. A new file is two-space JSON with a final line
 * break (so a file ERD Studio wrote round-trips byte for byte).
 *
 * - `oldText` `null` (no file): created only when there is at least one
 *   position or sticky layout.
 * - Both merged lists deep-equal to what is there: `null`, no write. A
 *   missing list, or a missing `defaultView`, counts as an empty list.
 * - `oldText` that is not a JSON object: throws {@link DbdiagramLayoutRefused}.
 *
 * Pure, parser-free and deterministic.
 */
export function editDiagramLayout(
  oldText: string | null,
  positions: Record<string, NodePosition>,
  stickies: readonly DbdiagramStickyLayout[],
): string | null {
  const tablePositions = tablePositionsOf(positions);
  const stickyNoteLayouts = stickies.map((s) => ({
    name: s.name,
    x: round(s.x),
    y: round(s.y),
    ...(isFiniteNumber(s.width) && s.width > 0 ? { width: round(s.width) } : {}),
    ...(isFiniteNumber(s.height) && s.height > 0 ? { height: round(s.height) } : {}),
  }));

  if (oldText === null) {
    if (tablePositions.length === 0 && stickyNoteLayouts.length === 0) return null;
    const fresh: DbdiagramLayout = {
      version: DBDIAGRAM_LAYOUT_VERSION,
      gridEnabling: false,
      currentViewName: null,
      defaultView: {
        detailLevel: 'All',
        relationshipMode: 'All',
        tablePositions,
        tableGroupCollapseStates: [],
        stickyNoteLayouts,
        referencePaths: [],
      },
      views: {},
    };
    return JSON.stringify(fresh, null, 2) + '\n';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(oldText.replace(/^﻿/, ''));
  } catch {
    throw new DbdiagramLayoutRefused();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DbdiagramLayoutRefused();
  }
  const file = parsed as Record<string, unknown>;
  const existingView = file.defaultView;
  const hasView = !!existingView && typeof existingView === 'object' && !Array.isArray(existingView);
  // A missing list (or a missing defaultView) holds nothing: comparing it as
  // `[]` keeps a no-op edit a no-op (D7), so an older or hand-written layout
  // file is not reformatted by an edit that changed no position or note.
  if ((existingView === undefined || existingView === null) && tablePositions.length === 0 && stickyNoteLayouts.length === 0) {
    return null;
  }
  const view: Record<string, unknown> = hasView
    ? (existingView as Record<string, unknown>)
    : { detailLevel: 'All', relationshipMode: 'All', tablePositions: [], tableGroupCollapseStates: [], stickyNoteLayouts: [], referencePaths: [] };
  const mergedTables = mergeEntries(view.tablePositions, tablePositions, TABLE_POSITION_KEYS);
  const mergedStickies = mergeEntries(view.stickyNoteLayouts, stickyNoteLayouts, STICKY_LAYOUT_KEYS);
  if (
    hasView &&
    jsonEqual(view.tablePositions === undefined ? [] : view.tablePositions, mergedTables) &&
    jsonEqual(view.stickyNoteLayouts === undefined ? [] : view.stickyNoteLayouts, mergedStickies)
  ) {
    return null;
  }
  view.tablePositions = mergedTables;
  view.stickyNoteLayouts = mergedStickies;
  file.defaultView = view;
  return stringifyInStyle(file, jsonStyleOf(oldText));
}

/** The keys ERD Studio owns in a `tablePositions` entry and a `stickyNoteLayouts` entry. */
const TABLE_POSITION_KEYS = ['name', 'schemaName', 'x', 'y'] as const;
const STICKY_LAYOUT_KEYS = ['name', 'x', 'y', 'width', 'height'] as const;

/**
 * `wanted` (the whole new list, by `name`) laid over the file's `existing`
 * list: an existing entry still wanted stays where it is, keeps its other
 * keys and their order, and takes the owned keys' new values (an owned key
 * the new entry lacks is removed); one no longer wanted, unnamed or listed
 * twice is dropped; a new name is appended, in `wanted` order.
 */
function mergeEntries(
  existing: unknown,
  wanted: ReadonlyArray<{ name: string }>,
  owned: readonly string[],
): Array<Record<string, unknown>> {
  const byName = new Map<string, Record<string, unknown>>();
  for (const entry of wanted) if (!byName.has(entry.name)) byName.set(entry.name, entry as unknown as Record<string, unknown>);
  const out: Array<Record<string, unknown>> = [];
  const placed = new Set<string>();
  for (const entry of Array.isArray(existing) ? existing : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const old = entry as Record<string, unknown>;
    const name = old.name;
    if (typeof name !== 'string' || placed.has(name)) continue;
    const next = byName.get(name);
    if (!next) continue;
    // Owned keys keep their place; one the old entry lacked goes after its own keys.
    const merged: Record<string, unknown> = { ...old };
    for (const key of owned) {
      if (Object.prototype.hasOwnProperty.call(next, key)) merged[key] = next[key];
      else delete merged[key];
    }
    out.push(merged);
    placed.add(name);
  }
  for (const [name, entry] of byName) {
    if (!placed.has(name)) out.push({ ...entry });
  }
  return out;
}

/** How an existing JSON file is laid out, so an edit writes it the same way. */
interface JsonTextStyle {
  /** `undefined`: compact, on one line. Otherwise one level's indent (`'  '`, `'\t'`, …). */
  indent: string | undefined;
  /** `'\r\n'` when the file uses CRLF line breaks, else `'\n'`. */
  eol: '\n' | '\r\n';
  /** Whatever came before the opening brace (a byte-order mark, white space). */
  leading: string;
  /** Whatever came after the closing brace: usually `'\n'`, or nothing. */
  trailing: string;
}

/**
 * The style of `text`, a JSON document: compact when its value is on one
 * line, else the indent of its first indented line (capped at ten
 * characters, as `JSON.stringify` caps it), its line endings, and the text
 * around the value kept as it is.
 */
function jsonStyleOf(text: string): JsonTextStyle {
  const leading = /^[\uFEFF\s]*/.exec(text)![0];
  const trailing = /\s*$/.exec(text.slice(leading.length))![0];
  const body = text.slice(leading.length, text.length - trailing.length);
  const eol = body.includes('\r\n') || (!body.includes('\n') && trailing.includes('\r\n')) ? '\r\n' : '\n';
  if (!body.includes('\n')) return { indent: undefined, eol, leading, trailing };
  const first = /\n([ \t]+)\S/.exec(body);
  const indent = first ? first[1].slice(0, 10) : '  ';
  return { indent, eol, leading, trailing };
}

/** `value` as JSON in `style` (see {@link jsonStyleOf}). */
function stringifyInStyle(value: unknown, style: JsonTextStyle): string {
  const json = style.indent === undefined ? JSON.stringify(value) : JSON.stringify(value, null, style.indent);
  return style.leading + (style.eol === '\r\n' ? json.replace(/\n/g, '\r\n') : json) + style.trailing;
}

/** Where {@link placeUnlaidNotes} assumes a table's right edge is: the canvas's default node width. */
const UNLAID_TABLE_WIDTH = 280;
/** The canvas's default sticky-note size, for a note whose layout gives none. */
const UNLAID_NOTE_WIDTH = 160;
const UNLAID_NOTE_HEIGHT = 80;
/** The gap between the column of placed notes and everything left of it, and between notes. */
const UNLAID_NOTE_GAP = 40;

/**
 * Places for the sticky notes a DBML diagram declares but its layout file
 * does not place (an assistant added a `Note`), so they never stack on the
 * origin: one column to the right of every laid-out table position and note,
 * 40 px apart, in file order, starting level with the highest laid-out item.
 * Deterministic and parser-free; it never writes (the next layout write
 * persists whatever the canvas holds).
 *
 * @param noteIds  every Note in file order; ids already in `stickies` keep their layout and get no entry
 * @returns a place for each unlaid id
 */
export function placeUnlaidNotes(
  noteIds: readonly string[],
  positions: Record<string, NodePosition>,
  stickies: readonly DbdiagramStickyLayout[],
): Record<string, NodePosition> {
  const laid = new Set(stickies.map((s) => s.name));
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
  const x = right === -Infinity ? 0 : round(right + UNLAID_NOTE_GAP);
  let y = top === Infinity ? 0 : round(top);
  for (const id of pending) {
    placed[id] = { x, y };
    y = round(y + UNLAID_NOTE_HEIGHT + UNLAID_NOTE_GAP);
  }
  return placed;
}
