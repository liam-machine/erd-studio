/**
 * The DBML custom-property names of the rich DBML export (`toDbmlRich`), in
 * one place so the exporter and ERD Studio's DBML import read and write the
 * same keys. Every value is a quoted string (`scd_type: '2'`): unquoted typed
 * values exist only from DBML 11.0 and break every 9.x / 10.x reader.
 *
 * Export writes the plain names; import also accepts each one with an `erd_`
 * prefix (`erd_grain`), for a team whose own properties already use the
 * plain name.
 */

import type { AnnotationColor, Rationale } from './types/semantic.js';

/** Table properties. */
export const DBML_RICH_TABLE_PROPERTIES = Object.freeze({
  role: 'role',
  grain: 'grain',
  alias: 'alias',
  /**
   * The schema `public`, written also as this property: DBML reads
   * `Table public.x` as a table with no schema (`public` is its default),
   * so without it a model in `public` would come back with none.
   */
  schema: 'schema',
} as const);

/** The schema DBML gives a table that names none, and so reads `public.x` as `x`. */
export const DBML_DEFAULT_SCHEMA = 'public';

/** Column properties. Flags are written as `'true'` and only when set. */
export const DBML_RICH_COLUMN_PROPERTIES = Object.freeze({
  naturalKey: 'natural_key',
  scdType: 'scd_type',
  additiveType: 'additive_type',
  /** An FK flag with no exported Ref to say so. */
  foreignKey: 'foreign_key',
} as const);

/** Sticky-note (`Note sticky_<n>`) properties. */
export const DBML_RICH_NOTE_PROPERTIES = Object.freeze({
  linkedTable: 'linked_table',
} as const);

/** A sticky note's DBML name is this prefix and its 1-based number. */
export const DBML_RICH_STICKY_PREFIX = 'sticky_';

/** The prefix import also accepts before every property name. */
export const DBML_RICH_PROPERTY_PREFIX = 'erd_';

/** `rationale_<snake_case key>`, e.g. `rationale_scd_strategy`. */
export const DBML_RICH_RATIONALE_PREFIX = 'rationale_';

/** A string meta value under an identifier key: `meta_<key>`. */
export const DBML_RICH_META_PREFIX = 'meta_';

/**
 * Every other meta entry (a number, a yes/no, null, a list, a map, or a key
 * that is not a DBML identifier) goes, as JSON of exactly those entries,
 * into this one property, so meta round-trips exactly.
 */
export const DBML_RICH_META_JSON_PROPERTY = 'meta_json';

/**
 * DBML rejects a table without columns, so the export gives such a table
 * this one column, marked with {@link DBML_RICH_PLACEHOLDER_PROPERTY}; import
 * drops it.
 */
export const DBML_RICH_PLACEHOLDER_COLUMN = '_erd_no_columns';
export const DBML_RICH_PLACEHOLDER_PROPERTY = 'erd_placeholder';

/**
 * The note on the placeholder column: shared by the rich export and native
 * DBML storage, which both give a table with no columns that one column.
 */
export const DBML_STORAGE_PLACEHOLDER_NOTE = 'ERD Studio: this table has no columns yet, and DBML needs one';

/**
 * The first line of ERD Studio's rich export starts with this
 * (`DBML_RICH_EXPORT_HEADER` is the whole line). A `.dbml` in a layer folder
 * whose first line starts with it is an export someone saved there, not a
 * diagram (`classifySemanticFile`).
 */
export const ERD_STUDIO_DBML_HEADER_PREFIX = '// erd-studio dbml-export';

// ---------------------------------------------------------------------------
// Native DBML storage (ERD Studio 2.0)
// ---------------------------------------------------------------------------

/**
 * A DBML diagram's Project keys (native DBML storage). Every value is a
 * quoted string: Project custom keys must be quoted in every DBML parser.
 */
export const DBML_DIAGRAM_PROPERTIES = Object.freeze({
  /** The diagram's schema version, `'7'` (`DBML_SCHEMA_VERSION`); 7 when missing. */
  schemaVersion: 'erd_schema_version',
  modelFolder: 'erd_model_folder',
  /** `viewConfig.showFkEdges`: `'true'` / `'false'`. */
  showFkEdges: 'erd_show_fk_edges',
  /** `viewConfig.layoutOptions`, as JSON of the `Record<string, string>`. */
  layoutOptions: 'erd_layout_options',
  /** `stubColumns`, as a JSON array of strings. */
  stubColumns: 'erd_stub_columns',
} as const);

/** The stem reserved for a library folder's relationships file, in any case. */
export const DBML_RELATIONSHIPS_FILE_STEM = '_relationships';

/** One per library folder: `tables/_relationships.dbml`, `tables/<folder>/_relationships.dbml`. */
export const DBML_RELATIONSHIPS_FILE_NAME = `${DBML_RELATIONSHIPS_FILE_STEM}.dbml`;

/** The first line of a relationships file, written only when the writer creates it and never required on read. */
export const DBML_RELATIONSHIPS_FILE_HEADER =
  '// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.';

/** The property for one rationale key: `scdStrategy` → `rationale_scd_strategy`. */
export function rationaleProperty(key: keyof Rationale): string {
  return DBML_RICH_RATIONALE_PREFIX + key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** The rationale key a property names (`rationale_scd_strategy` → `scdStrategy`), or undefined. */
export function rationaleKeyOf(property: string): keyof Rationale | undefined {
  const bare = property.startsWith(DBML_RICH_PROPERTY_PREFIX) ? property.slice(DBML_RICH_PROPERTY_PREFIX.length) : property;
  if (!bare.startsWith(DBML_RICH_RATIONALE_PREFIX)) return undefined;
  const key = bare.slice(DBML_RICH_RATIONALE_PREFIX.length).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return (RATIONALE_KEYS as readonly string[]).includes(key) ? (key as keyof Rationale) : undefined;
}

const RATIONALE_KEYS: ReadonlyArray<keyof Rationale> = ['purpose', 'design', 'grainChoice', 'roleChoice', 'scdStrategy', 'measures'];

/** A property name without the optional `erd_` prefix: what import matches on. */
export function bareDbmlProperty(property: string): string {
  return property.startsWith(DBML_RICH_PROPERTY_PREFIX) && property !== DBML_RICH_PLACEHOLDER_PROPERTY
    ? property.slice(DBML_RICH_PROPERTY_PREFIX.length)
    : property;
}

/**
 * The hex each sticky-note colour is exported as (DBML colours must be hex),
 * and read back from: the swatches of the canvas's colour picker
 * (`ANNOTATION_COLORS` in `@erd-studio/renderer`), so a note looks the same
 * colour in dbdiagram as its swatch does in ERD Studio.
 */
export const DBML_RICH_STICKY_COLOURS: Readonly<Record<AnnotationColor, string>> = Object.freeze({
  yellow: '#f59e0b',
  blue: '#3b82f6',
  green: '#22c55e',
  pink: '#ec4899',
  orange: '#f97316',
});

/** The note backgrounds the canvas paints in a light theme, also read back exactly. */
const STICKY_BACKGROUNDS: Readonly<Record<AnnotationColor, string>> = {
  yellow: '#fef3c7',
  blue: '#dbeafe',
  green: '#dcfce7',
  pink: '#fce7f3',
  orange: '#fed7aa',
};

function rgbOf(hex: string): [number, number, number] | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const digits = m[1].length === 3 ? [...m[1]].map((d) => d + d).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * The sticky-note colour a DBML `Note` colour stands for: an exact swatch (or
 * canvas background) by name, else the swatch nearest to it, so a note
 * coloured in another tool keeps roughly its colour. `undefined` when `hex`
 * is not a `#rgb` / `#rrggbb` colour.
 */
export function stickyColourOfHex(hex: string): AnnotationColor | undefined {
  if (typeof hex !== 'string') return undefined;
  const rgb = rgbOf(hex);
  if (!rgb) return undefined;
  const colours = Object.keys(DBML_RICH_STICKY_COLOURS) as AnnotationColor[];
  const same = (a: [number, number, number], b: string): boolean => {
    const other = rgbOf(b)!;
    return a.every((v, i) => v === other[i]);
  };
  const exact = colours.find((c) => same(rgb, DBML_RICH_STICKY_COLOURS[c]) || same(rgb, STICKY_BACKGROUNDS[c]));
  if (exact) return exact;
  let best: AnnotationColor = colours[0];
  let bestDistance = Infinity;
  for (const colour of colours) {
    for (const candidate of [DBML_RICH_STICKY_COLOURS[colour], STICKY_BACKGROUNDS[colour]]) {
      const other = rgbOf(candidate)!;
      const distance = other.reduce((sum, v, i) => sum + (v - rgb[i]) ** 2, 0);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = colour;
      }
    }
  }
  return best;
}
