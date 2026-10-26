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
} as const);

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

/** The hex each sticky-note colour is exported as (DBML colours must be hex), and read back from. */
export const DBML_RICH_STICKY_COLOURS: Readonly<Record<AnnotationColor, string>> = Object.freeze({
  yellow: '#fef08a',
  blue: '#bfdbfe',
  green: '#bbf7d0',
  pink: '#fbcfe8',
  orange: '#fed7aa',
});
