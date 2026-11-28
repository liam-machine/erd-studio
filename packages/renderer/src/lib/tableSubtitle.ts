/**
 * The one line under a table's name: its text for one table, and what a
 * reader can choose it from. The choice itself (`field:<key>`,
 * `description`, `none`) is core's (`@erd-studio/core`'s `tableSubtitle.ts`);
 * this is the one place the renderer turns a choice into words, so the node,
 * its height estimate, the legend and the editor's menu cannot disagree.
 */

import {
  DBML_IMPORT_META_KEY,
  STARTING_FIELD_LIST,
  TABLE_SUBTITLE_DESCRIPTION,
  TABLE_SUBTITLE_NONE,
  builtInField,
  fieldRowId,
  formatMetaValue,
  normaliseTableSubtitle,
  resolveTableFields,
  tableSubtitleFieldKey,
  tableSubtitleIsRow,
  tableSubtitleOfField,
  tableSubtitleRow,
  type DisplaySubjectArea,
  type DisplayTable,
  type FieldDefinition,
  type FieldList,
  type FieldRow,
} from '@erd-studio/core';

import { roleLabel } from './roleOptions';

/** What the menu and the legend call the table's description. */
export const TABLE_SUBTITLE_DESCRIPTION_LABEL = 'Description';
/** What the menu calls no line. */
export const TABLE_SUBTITLE_NONE_LABEL = 'Nothing';

const homeKind = (row: FieldRow): string | undefined => {
  const kind = (row.definition.home as { kind?: unknown } | undefined)?.kind;
  return typeof kind === 'string' ? kind : undefined;
};

/** The text a row's value reads as: Yes / No, a role's label, or the value as written (a list or a map on one line). */
export function fieldValueText(row: FieldRow): string {
  const def = row.definition;
  if (row.choice !== undefined) {
    if (def.type === 'yes-no') return row.choice === 'true' ? 'Yes' : 'No';
    if (homeKind(row) === 'role') return roleLabel(row.choice);
    return row.choice;
  }
  return row.value === undefined ? '' : formatMetaValue(row.value);
}

const lineOf = (text: unknown): string | undefined =>
  typeof text === 'string' && text.trim() !== '' ? text : undefined;

/**
 * The line under `table`'s name for a choice, or undefined for no line: the
 * choice is `none`, or the table has no value for what it names (never
 * another field's value in its place). A field reads as the Detail panel
 * shows it; a yes / no field is prefixed with its label ("PII: Yes"), since
 * the answer alone says nothing. Anything that is not a choice reads as the
 * grain.
 */
export function tableSubtitleText(table: DisplayTable, choice: unknown, list?: FieldList): string | undefined {
  const chosen = normaliseTableSubtitle(choice);
  if (chosen === TABLE_SUBTITLE_NONE) return undefined;
  if (chosen === TABLE_SUBTITLE_DESCRIPTION) return lineOf(table.description);
  const row = tableSubtitleRow(table, chosen, list);
  if (!row || row.value === undefined || row.value === null) return undefined;
  const text = lineOf(fieldValueText(row));
  if (text === undefined) return undefined;
  return row.definition.type === 'yes-no' && row.choice !== undefined ? `${row.definition.label}: ${text}` : text;
}

/** What `nodeSubtitle` reads from a table node's data. */
type SubtitleData = { grain?: string; subtitle?: string | null };

/**
 * The line a table node draws under its name, or undefined for none: the
 * chosen value when the reader chose one (`subtitle`, null being no line),
 * else the grain. The node, its height estimate and the legend all ask here.
 */
export function nodeSubtitle(data: SubtitleData): string | undefined {
  if (data.subtitle === undefined) return data.grain ? data.grain : undefined;
  return data.subtitle === null || data.subtitle === '' ? undefined : data.subtitle;
}

/** Whether a node's line is a value the reader chose in place of the grain (it then never widens the card). */
export function nodeSubtitleIsChosen(data: SubtitleData): boolean {
  return data.subtitle !== undefined;
}

/** One entry of the choice a reader is offered. */
export interface TableSubtitleOption {
  /** The choice as it is stored (`field:owner`, `description`, `none`). */
  value: string;
  label: string;
  /**
   * `list`: a field of the project's list. `carried`: a value some table on
   * the diagram carries that the list does not name. `missing`: the current
   * choice, when it names a field neither the list nor any table here has.
   * `other`: the description and no line.
   */
  group: 'list' | 'carried' | 'missing' | 'other';
}

const usable = (def: unknown): def is FieldDefinition =>
  !!def && typeof def === 'object' && typeof (def as FieldDefinition).key === 'string' && (def as FieldDefinition).key !== '';

/** The table fields of a list, as the resolver reads it (a missing section is the starting set's). */
function listedTableFields(list: FieldList | undefined): FieldDefinition[] {
  const tables = (list as { tables?: unknown } | undefined)?.tables;
  return (Array.isArray(tables) ? tables : STARTING_FIELD_LIST.tables).filter(usable);
}

const labelOf = (def: FieldDefinition): string => (typeof def.label === 'string' && def.label !== '' ? def.label : def.key);

/**
 * Everything the line can be set to on this diagram, in menu order: the
 * list's table fields (retired ones left out), every other value a table
 * here carries, the current choice when nothing here has it, then the
 * description and no line.
 */
export function tableSubtitleOptions(
  domain: Pick<DisplaySubjectArea, 'models' | 'fields'> | null | undefined,
  current?: unknown,
): TableSubtitleOption[] {
  const list = domain?.fields;
  const options: TableSubtitleOption[] = [];
  const seen = new Set<string>();
  const add = (def: FieldDefinition, group: TableSubtitleOption['group']): void => {
    const value = tableSubtitleOfField(def.key);
    // A key the choice cannot spell, or one that would read as another field, is not offered.
    if (seen.has(value) || tableSubtitleFieldKey(value) === undefined) return;
    seen.add(value);
    options.push({ value, label: labelOf(def), group });
  };

  for (const def of listedTableFields(list)) {
    const builtIn = builtInField(def.key, 'table');
    if ((builtIn ?? def).status === 'retired' || def.key === DBML_IMPORT_META_KEY) continue;
    add(builtIn ? { ...builtIn, label: labelOf(def) } : def, 'list');
  }
  for (const model of domain?.models ?? []) {
    for (const row of resolveTableFields(model, list)) {
      if (row.source === 'list' || row.value === undefined || row.value === null) continue;
      if (!tableSubtitleIsRow(tableSubtitleOfField(row.definition.key), row)) continue;
      add(row.definition, 'carried');
    }
  }
  const key = tableSubtitleFieldKey(normaliseTableSubtitle(current));
  if (key !== undefined && !seen.has(tableSubtitleOfField(key))) {
    options.push({ value: tableSubtitleOfField(key), label: builtInField(key, 'table')?.label ?? key, group: 'missing' });
  }
  options.push({ value: TABLE_SUBTITLE_DESCRIPTION, label: TABLE_SUBTITLE_DESCRIPTION_LABEL, group: 'other' });
  options.push({ value: TABLE_SUBTITLE_NONE, label: TABLE_SUBTITLE_NONE_LABEL, group: 'other' });
  return options;
}

/**
 * What a choice is called: the field's label in the list (else the
 * built-in's, else its key), "Description", or "Nothing".
 */
export function tableSubtitleLabel(choice: unknown, list?: FieldList): string {
  const chosen = normaliseTableSubtitle(choice);
  if (chosen === TABLE_SUBTITLE_NONE) return TABLE_SUBTITLE_NONE_LABEL;
  if (chosen === TABLE_SUBTITLE_DESCRIPTION) return TABLE_SUBTITLE_DESCRIPTION_LABEL;
  const key = tableSubtitleFieldKey(chosen) as string;
  const builtIn = builtInField(key, 'table');
  const id = builtIn ? fieldRowId(builtIn) : `meta:${key}`;
  const listed = listedTableFields(list).find((def) => fieldRowId(builtInField(def.key, 'table') ?? def) === id);
  return listed ? labelOf(listed) : builtIn?.label ?? key;
}
