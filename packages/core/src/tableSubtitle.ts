/**
 * The one line under a table's name on the canvas: which of a table's values
 * it shows. A reader's view preference (the extension's
 * `erdStudio.canvas.tableSubtitle` setting, `ErdCanvas`'s `tableSubtitle`
 * prop), never part of a project file.
 *
 * A choice is one string:
 *
 * - `field:<key>`: the table field `<key>` — a built-in (`field:grain`,
 *   `field:purpose`), one of the team's own from `fields.yml`
 *   (`field:owner`), or a value a table carries that no list names;
 * - `description`: the table's description;
 * - `none`: no line.
 *
 * Field keys are prefixed because `description` and `none` are both legal
 * field keys: a team's own `description` field is `field:description`, and
 * can never be taken for the table's description. Anything that is not one
 * of the three shapes reads as {@link DEFAULT_TABLE_SUBTITLE}, the grain,
 * which is what every canvas drew before the choice existed.
 *
 * Pure: no Node built-ins, no `yaml`, no parser.
 */

import { builtInField, fieldRowId, metaFieldDefinition, resolveTableFields, type FieldList, type FieldRow } from './fields.js';
import type { DisplayTable } from './types/display.js';
import type { SemanticTable } from './types/semantic.js';

/** The prefix of a field choice (`field:grain`). */
export const TABLE_SUBTITLE_FIELD_PREFIX = 'field:';
/** The table's description. */
export const TABLE_SUBTITLE_DESCRIPTION = 'description';
/** No line. */
export const TABLE_SUBTITLE_NONE = 'none';
/** The grain: the line every canvas drew before the choice existed. */
export const DEFAULT_TABLE_SUBTITLE = `${TABLE_SUBTITLE_FIELD_PREFIX}grain`;
/** The longest field key a choice may name. */
export const TABLE_SUBTITLE_KEY_MAX = 128;

/** The choice for the table field `key`. */
export function tableSubtitleOfField(key: string): string {
  return `${TABLE_SUBTITLE_FIELD_PREFIX}${key}`;
}

/**
 * The field key a choice names, or undefined for the description, for no
 * line and for anything that is not a choice. The key is taken as written
 * (a `meta` key can be spelled any way a file spells it): not blank, no
 * space at either end, no control character, at most
 * {@link TABLE_SUBTITLE_KEY_MAX} characters.
 */
export function tableSubtitleFieldKey(choice: unknown): string | undefined {
  if (typeof choice !== 'string' || !choice.startsWith(TABLE_SUBTITLE_FIELD_PREFIX)) return undefined;
  const key = choice.slice(TABLE_SUBTITLE_FIELD_PREFIX.length);
  if (key === '' || key.length > TABLE_SUBTITLE_KEY_MAX || key !== key.trim()) return undefined;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(key) ? undefined : key;
}

/** Whether `value` is a choice exactly as it is stored. */
export function isTableSubtitle(value: unknown): value is string {
  return value === TABLE_SUBTITLE_DESCRIPTION || value === TABLE_SUBTITLE_NONE || tableSubtitleFieldKey(value) !== undefined;
}

/** `value` when it is a choice, else {@link DEFAULT_TABLE_SUBTITLE}. Never throws. */
export function normaliseTableSubtitle(value: unknown): string {
  return isTableSubtitle(value) ? value : DEFAULT_TABLE_SUBTITLE;
}

/**
 * The row id ({@link FieldRow.id}) of the field a key names: the built-in of
 * that key when there is one (`purpose` is always the Purpose field, never a
 * `meta.purpose` beside it), else the `meta` key.
 */
function rowIdOfKey(key: string): string {
  return fieldRowId(builtInField(key, 'table') ?? metaFieldDefinition(key, 'table'));
}

/**
 * The field row a `field:<key>` choice shows for `table`: the row of
 * {@link resolveTableFields} for that field, whether the list names it or
 * the table only carries a value for it. Undefined for the description, for
 * no line, and when the table has no such row. The row may hold no value.
 */
export function tableSubtitleRow(
  table: DisplayTable | SemanticTable,
  choice: unknown,
  list?: FieldList,
): FieldRow | undefined {
  const key = tableSubtitleFieldKey(choice);
  if (key === undefined) return undefined;
  const id = rowIdOfKey(key);
  return resolveTableFields(table, list).find((row) => row.id === id);
}

/**
 * Whether a choice names the field of `row`: `field:purpose` and the row
 * `rationale:purpose`, `field:owner` and `meta:owner`.
 */
export function tableSubtitleIsRow(choice: unknown, row: Pick<FieldRow, 'id'>): boolean {
  const key = tableSubtitleFieldKey(choice);
  return key !== undefined && rowIdOfKey(key) === row.id;
}
