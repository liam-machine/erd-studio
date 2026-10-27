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
import type { NodePosition } from './types/semantic.js';
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
