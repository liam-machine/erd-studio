/**
 * `toDbmlRich` — a diagram as DBML with ERD Studio's own fields as DBML
 * custom properties (the `dbml-rich` export format, v2).
 *
 * Where `toDbml` (v1) is the portable, notes-only DBML every parser since
 * `@dbml/core` 2.4.2 reads, this one is the round-trip format: ERD Studio's
 * DBML import reads it back field for field, and dbdiagram / dbdocs show the
 * properties as real fields and filters. Custom properties need a DBML 9.1
 * or later parser (`@dbml/parse` 9.1+, what dbdiagram.io runs); older
 * parsers reject the whole file. The canvas positions travel beside the
 * `.dbml` in dbdiagram's own `<name>.dbdiagram` file (`dbdiagramLayout.ts`),
 * which `dbdiagram push` reads.
 *
 * The output is a contract: the same `DisplaySubjectArea` always gives the
 * same text, it opens with {@link DBML_RICH_EXPORT_HEADER}, and every mapping
 * change is a deliberate golden update (`<fixture>.rich.dbml`) plus a
 * CHANGELOG line. Every golden is held to `@dbml/parse` 9.1.1, 10.3.1 and
 * 11.0.0 with no errors or warnings. The property names are
 * `dbmlRichProperties.ts`'s, shared with the importer.
 *
 * | ERD Studio                          | DBML                                                                    |
 * |-------------------------------------|-------------------------------------------------------------------------|
 * | (header)                            | `// erd-studio dbml-export v2 (DBML 9.1+)`, then `//` lines naming the layout file, what `?` on a Ref means and what is left out |
 * | subject area name, description      | `Project <name> { Note: '<description>' }` (`Project {` when it has no name; no Project when it has neither) |
 * | layer (+ layer colour, label)       | `TableGroup <layer> [color: <hex>, note: 'Layer: <label>'] { every exported table }` — the colour only when `layerConfig.color` is `#rgb` / `#rrggbb` |
 * | table (+ schema)                    | `Table [schema.]name` — the model name, never DBML's `as` (DBML aliases are unique; ours are not) |
 * | description                         | the table's `Note: '…'`                                                 |
 * | modelRole, grain, alias             | `role`, `grain`, `alias` table properties                               |
 * | the schema `public`                 | also a `schema: 'public'` property: DBML reads `Table public.x` as a table with no schema |
 * | rationale                           | `rationale_<snake_case key>` table properties (`rationale_scd_strategy`) |
 * | meta: a text value under a lower-case identifier key | `meta_<key>: '<value>'`                                  |
 * | meta: anything else (yes/no, number, null, list, map, any other key) | one `meta_json: '<JSON of exactly those entries>'`, so meta round-trips exactly |
 * | column                              | `name type` — type bare when a plain word, else `"…"`; an empty type is `""` |
 * | single / composite primary key      | column `[pk]` / `indexes { (a, b) [pk] }`                               |
 * | column description                  | column `note: '…'`                                                      |
 * | isNaturalKey, scdType, additiveType | `natural_key: 'true'`, `scd_type: '<0-2>'`, `additive_type: '<value>'` column properties |
 * | the model file's foreign-key flag   | `foreign_key: 'true'` — also on a column the badge marks as a foreign key when no exported Ref says so |
 * | column meta                         | as table meta                                                           |
 * | many-to-one / one-to-many           | `Ref: fk.col >? pk.col` — always from the foreign-key (many) end, so a one-to-many is written with its ends swapped |
 * | one-to-one                          | `Ref: pk.col ?- fk.col` — key end first, since DBML reads a one-to-one's second end as the foreign key — and the FK column gets `unique` (a composite one an `indexes { (x, y) [unique] }`) unless it is already the table's key |
 * | many-to-many                        | `Ref: from.col <> to.col`, with `?` as below                            |
 * | `?` on a Ref                        | a `?` next to the operator marks the end across from it as possibly null (`>?`: the FK may be null). ERD Studio does not record nullability, so every end that is not primary-key columns gets one (DBML 9+ reads a bare `>` as NOT NULL) |
 * | composite foreign key               | one `Ref: a.(x, y) >? b.(u, v)`                                         |
 * | relationship role                   | the Ref's name: `Ref "ship date": …`                                    |
 * | relationship drawn backwards (`keysContradict`) | a `// This starts at …'s key (…), so it was probably drawn backwards.` line above the Ref, which stays as stored |
 * | sticky note                         | `Note sticky_<n> [color: <swatch hex>, linked_table: '<model>'] { '<text>' }` |
 * | table without columns               | one placeholder column `_erd_no_columns unknown [erd_placeholder: 'true', note: …]` (DBML needs one), which import drops |
 * | canvas positions                    | the `.dbdiagram` file beside this one                                   |
 *
 * Strings: custom-property values are always quoted strings (`scd_type:
 * '2'`): unquoted typed values exist only from DBML 11.0. A one-line value is
 * single-quoted, a value with a line break triple-quoted (`'''…'''`); both
 * escape `\` and `'`, and every 9.1+ parser reads them back exactly. DBML
 * trims white space at the start of a note and strips the indent its lines
 * share, so a note's leading white space is dropped (its later lines keep
 * theirs). Names are bare when they are plain identifiers and not DBML
 * keywords, else double-quoted with `\"` and `\\` escapes — a 9.1+ parser
 * reads every name back exactly, so nothing is renamed. Comments say why
 * anything is left out: a relationship whose ends are not in the diagram, a
 * column pointing at itself, a second copy of a link (DBML refuses two Refs
 * between the same columns), meta that cannot be written as JSON, sticky-note
 * positions and sizes (the `.dbdiagram` shape for them is unknown), and the
 * canvas's layout options.
 */

import type { DisplaySubjectArea } from './types/display.js';
import { backwardsNoteOf, describeEnds, oneLine, prepareSubjectArea, text } from './exportShared.js';
import type { ExportColumn, ExportLink, ExportMeta, ExportTable } from './exportShared.js';
import {
  DBML_DEFAULT_SCHEMA,
  DBML_RICH_COLUMN_PROPERTIES,
  DBML_RICH_META_JSON_PROPERTY,
  DBML_RICH_META_PREFIX,
  DBML_RICH_NOTE_PROPERTIES,
  DBML_RICH_PLACEHOLDER_COLUMN,
  DBML_RICH_PLACEHOLDER_PROPERTY,
  DBML_RICH_STICKY_COLOURS,
  DBML_RICH_STICKY_PREFIX,
  DBML_RICH_TABLE_PROPERTIES,
  DBML_STORAGE_PLACEHOLDER_NOTE,
  rationaleProperty,
} from './dbmlRichProperties.js';
import { dbdiagramLayoutFileName } from './dbdiagramLayout.js';
import { dbmlColumnType as columnType, dbmlName as ident, dbmlNoteText as noteText, dbmlString as str } from './dbmlText.js';

/** The first line of every rich DBML export. */
export const DBML_RICH_EXPORT_HEADER = '// erd-studio dbml-export v2 (DBML 9.1+)';

/** Options for {@link toDbmlRich}. */
export interface DbmlRichOptions {
  /**
   * The layout file the header names (it sits beside the `.dbml`). Defaults
   * to {@link dbdiagramLayoutFileName}`(area)`; pass the name actually
   * written when the user saved under another name, or `''` to name none.
   */
  layoutFileName?: string;
}

/** A meta key DBML can carry as `meta_<key>`: DBML lower-cases property names, so only lower-case ones read back exactly. */
const META_KEY = /^[a-z_][a-z0-9_]*$/;

function tableName(model: ExportTable): string {
  return model.schema ? `${ident(model.schema)}.${ident(model.name)}` : ident(model.name);
}

/** How DBML tells tables apart: an unqualified table is in schema `public`. */
function tableKey(model: ExportTable): string {
  return `${model.schema || 'public'}\u0000${model.name}`;
}

const columnKey = (model: ExportTable, column: string): string => `${tableKey(model)}\u0000${column}`;

/** JSON of `entries` as one object, or `null` when they cannot be written as JSON (a cycle). */
function metaJson(entries: Array<readonly [string, unknown]>): string | null {
  try {
    // A bigint (never in a valid domain, but cheap to survive) is written as its digits.
    return JSON.stringify(Object.fromEntries(entries), (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
  } catch {
    return null;
  }
}

/** A meta map as properties: `meta_<key>` for each text value under a lower-case key, the rest in one `meta_json`. */
function metaProperties(meta: ExportMeta): { settings: string[]; problem: string | null } {
  const settings: string[] = [];
  const rest: Array<readonly [string, unknown]> = [];
  const jsonName = DBML_RICH_META_JSON_PROPERTY.slice(DBML_RICH_META_PREFIX.length);
  for (const [key, value] of meta.entries) {
    if (value === undefined) continue;
    if (typeof value === 'string' && META_KEY.test(key) && key !== jsonName) {
      settings.push(`${DBML_RICH_META_PREFIX}${key}: ${str(value)}`);
    } else {
      rest.push([key, value]);
    }
  }
  if (rest.length === 0) return { settings, problem: null };
  const json = metaJson(rest);
  if (json === null) return { settings, problem: `meta not exported (it cannot be written as JSON): ${rest.map(([k]) => oneLine(k)).join(', ')}` };
  settings.push(`${DBML_RICH_META_JSON_PROPERTY}: ${str(json)}`);
  return { settings, problem: null };
}

/** `[a, b]` settings as one bracket, or nothing. */
function bracket(settings: string[]): string {
  return settings.length > 0 ? ` [${settings.join(', ')}]` : '';
}

function loadErrorText(model: ExportTable): string {
  const error = model.loadError!;
  return `its table file could not be read (${oneLine(error.kind)}${error.line !== undefined ? `, line ${error.line}` : ''})`;
}

/** What the table block needs to know about the Refs: the FK columns they cover and the unique keys one-to-ones add. */
interface RefFacts {
  /** Columns at the foreign-key end of an exported Ref. */
  fkCovered: Set<string>;
  /** Single FK columns of exported one-to-ones (they get `unique`). */
  uniqueColumns: Set<string>;
  /** Per table: composite FK column lists of exported one-to-ones (they get a unique index). */
  uniqueIndexes: Map<string, string[][]>;
}

function tableSettings(model: ExportTable): { settings: string[]; problem: string | null } {
  const settings: string[] = [];
  if (model.modelRole) settings.push(`${DBML_RICH_TABLE_PROPERTIES.role}: ${str(model.modelRole)}`);
  if (model.grain) settings.push(`${DBML_RICH_TABLE_PROPERTIES.grain}: ${str(model.grain)}`);
  if (model.alias) settings.push(`${DBML_RICH_TABLE_PROPERTIES.alias}: ${str(model.alias)}`);
  // DBML reads `public.x` as `x`: say so, or the schema comes back empty.
  if (model.schema === DBML_DEFAULT_SCHEMA) settings.push(`${DBML_RICH_TABLE_PROPERTIES.schema}: ${str(model.schema)}`);
  for (const [key, value] of model.rationaleEntries) settings.push(`${rationaleProperty(key)}: ${str(value)}`);
  const meta = metaProperties(model.meta);
  return { settings: [...settings, ...meta.settings], problem: meta.problem };
}

function columnLine(model: ExportTable, column: ExportColumn, singlePk: boolean, facts: RefFacts): string[] {
  const lines: string[] = [];
  const settings: string[] = [];
  if (singlePk && column.isPrimaryKey) settings.push('pk');
  if (facts.uniqueColumns.has(columnKey(model, column.name)) && !(singlePk && column.isPrimaryKey)) settings.push('unique');
  const description = noteText(column.description);
  if (description) settings.push(`note: ${str(description)}`);
  if (column.isNaturalKey) settings.push(`${DBML_RICH_COLUMN_PROPERTIES.naturalKey}: 'true'`);
  if (column.scdType !== undefined) settings.push(`${DBML_RICH_COLUMN_PROPERTIES.scdType}: ${str(String(column.scdType))}`);
  if (column.additiveType) settings.push(`${DBML_RICH_COLUMN_PROPERTIES.additiveType}: ${str(column.additiveType)}`);
  const declared = column.isForeignKeyDeclared === true;
  if (declared || (column.isForeignKey && !facts.fkCovered.has(columnKey(model, column.name)))) {
    settings.push(`${DBML_RICH_COLUMN_PROPERTIES.foreignKey}: 'true'`);
  }
  const meta = metaProperties(column.meta);
  if (meta.problem) lines.push(`  // ${oneLine(column.name)}: ${meta.problem}`);
  settings.push(...meta.settings);
  lines.push(`  ${ident(column.name)} ${columnType(column.dataType)}${bracket(settings)}`);
  return lines;
}

const PLACEHOLDER_NOTE = DBML_STORAGE_PLACEHOLDER_NOTE;

function tableBlock(model: ExportTable, facts: RefFacts): string[] {
  const lines: string[] = [];
  for (const sentence of model.skippedColumns) lines.push(`// ${oneLine(model.name)}: ${sentence}; not exported`);
  if (model.loadError) {
    const shown = model.columns.length > 0 ? 'only the columns shown are exported' : 'exported with no columns';
    lines.push(`// ${oneLine(model.name)}: ${loadErrorText(model)}; ${shown}`);
  }
  const { settings, problem } = tableSettings(model);
  if (problem) lines.push(`// ${oneLine(model.name)}: ${problem}`);
  if (settings.length <= 1) {
    lines.push(`Table ${tableName(model)}${bracket(settings)} {`);
  } else {
    lines.push(`Table ${tableName(model)} [`, ...settings.map((s, i) => `  ${s}${i < settings.length - 1 ? ',' : ''}`), '] {');
  }

  if (model.columns.length === 0) {
    lines.push(`  ${DBML_RICH_PLACEHOLDER_COLUMN} unknown [${DBML_RICH_PLACEHOLDER_PROPERTY}: 'true', note: ${str(PLACEHOLDER_NOTE)}]`);
  }
  const pks = model.columns.filter((c) => c.isPrimaryKey);
  const singlePk = pks.length === 1;
  for (const column of model.columns) lines.push(...columnLine(model, column, singlePk, facts));

  const indexes: string[] = [];
  if (pks.length > 1) indexes.push(`    (${pks.map((c) => ident(c.name)).join(', ')}) [pk]`);
  for (const columns of facts.uniqueIndexes.get(tableKey(model)) ?? []) {
    indexes.push(`    (${columns.map(ident).join(', ')}) [unique]`);
  }
  if (indexes.length > 0) lines.push('  indexes {', ...indexes, '  }');

  const description = noteText(model.description);
  if (description) lines.push(`  Note: ${str(description)}`);
  lines.push('}');
  return lines;
}

/**
 * A Ref as written. A `>` Ref starts at its foreign-key (many) end; a `-` Ref
 * starts at its key end, because DBML reads the second end of a one-to-one as
 * the foreign key (`users.id - user_infos.user_id`), and so does every DBML
 * tool that turns one into SQL.
 */
interface RefPlan {
  link: ExportLink;
  left: { model: ExportTable; columns: string[] };
  right: { model: ExportTable; columns: string[] };
  /** The foreign-key end: `left`, except for a one-to-one. */
  fk: { model: ExportTable; columns: string[] };
  operator: '>' | '-' | '<>';
}

function refPlan(link: ExportLink): RefPlan {
  const from = { model: link.from, columns: link.fromColumns };
  const to = { model: link.to, columns: link.toColumns };
  switch (link.cardinality) {
    case 'one-to-many':
      return { link, left: to, right: from, fk: to, operator: '>' };
    case 'one-to-one':
      return { link, left: to, right: from, fk: from, operator: '-' };
    case 'many-to-many':
      return { link, left: from, right: to, fk: from, operator: '<>' };
    default:
      return { link, left: from, right: to, fk: from, operator: '>' };
  }
}

/** Whether every one of `columns` is a primary-key column: DBML reads those as NOT NULL. */
function allKey(model: ExportTable, columns: string[]): boolean {
  return columns.every((name) => model.columns.find((c) => c.name === name)?.isPrimaryKey === true);
}

function refEnd(end: { model: ExportTable; columns: string[] }): string {
  return end.columns.length === 1
    ? `${tableName(end.model)}.${ident(end.columns[0])}`
    : `${tableName(end.model)}.(${end.columns.map(ident).join(', ')})`;
}

function refLines(plan: RefPlan): string[] {
  // A `?` beside the operator marks the end across from it as possibly null.
  const leftMark = allKey(plan.right.model, plan.right.columns) ? '' : '?';
  const rightMark = allKey(plan.left.model, plan.left.columns) ? '' : '?';
  const ref = `${refEnd(plan.left)} ${leftMark}${plan.operator}${rightMark} ${refEnd(plan.right)}`;
  const lines = plan.link.keysContradict ? [`// ${backwardsNoteOf(plan.link)}`] : [];
  lines.push(plan.link.role ? `Ref ${ident(plan.link.role)}: ${ref}` : `Ref: ${ref}`);
  return lines;
}

/** How DBML tells two Refs' endpoints apart: each end's table and column set, either way round. */
function endpointsKey(plan: RefPlan): string {
  const end = (e: { model: ExportTable; columns: string[] }): string => `${tableKey(e.model)}\u0000${[...e.columns].sort().join('\u0001')}`;
  return [end(plan.left), end(plan.right)].sort().join('\u0002');
}

/** `// label text` lines, one per line of `value`. */
function commentLines(label: string, value: string): string[] {
  const lines = value.split(/\r\n|\r|\n/).map(oneLine).filter((l) => l !== '');
  if (lines.length === 0) return [];
  return [`// ${label}${lines[0]}`, ...lines.slice(1).map((l) => `//     ${l}`)];
}

/** The layer's TableGroup colour: `layerConfig.color` when it is a hex DBML accepts. */
function layerColour(area: Record<string, unknown>): string | undefined {
  const config = area.layerConfig && typeof area.layerConfig === 'object' ? (area.layerConfig as Record<string, unknown>) : {};
  const colour = text(config.color).trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(colour) ? colour.toLowerCase() : undefined;
}

function layerLabel(area: Record<string, unknown>, layer: string): string {
  const config = area.layerConfig && typeof area.layerConfig === 'object' ? (area.layerConfig as Record<string, unknown>) : {};
  return oneLine(text(config.label)) || oneLine(layer);
}

/**
 * The diagram as rich DBML (custom properties, DBML 9.1+). Deterministic;
 * never throws on a valid `DisplaySubjectArea`, however minimal, nor on one
 * from an older core.
 */
export function toDbmlRich(area: DisplaySubjectArea, options: DbmlRichOptions = {}): string {
  const prepared = prepareSubjectArea(area);
  const input = (area && typeof area === 'object' ? area : {}) as unknown as Record<string, unknown>;
  const layoutFile = oneLine(typeof options?.layoutFileName === 'string' ? options.layoutFileName : dbdiagramLayoutFileName(area ?? ({} as DisplaySubjectArea)));

  const out: string[] = [DBML_RICH_EXPORT_HEADER];
  if (layoutFile) out.push(`// Table positions: ${layoutFile}, next to this file (\`dbdiagram push\` reads it).`);
  out.push(
    '// A ? beside a Ref operator marks the end across from it as possibly null: ERD Studio does not record nullability, so only primary-key columns are NOT NULL.',
    '// Not exported: sticky-note positions and sizes, the canvas layout options.',
  );

  // Project.
  const name = prepared.name.trim() ? prepared.name : '';
  const description = noteText(prepared.description);
  if (name || description) {
    out.push('', name ? `Project ${ident(name)} {` : 'Project {');
    if (description) out.push(`  Note: ${str(description)}`);
    out.push('}');
  }

  const models = prepared.models.flatMap((item) => (item.kind === 'model' ? [item.model] : []));

  // Settle the Refs first: the tables need to know which FK columns they cover and which keys one-to-ones add.
  const facts: RefFacts = { fkCovered: new Set(), uniqueColumns: new Set(), uniqueIndexes: new Map() };
  const refItems: Array<{ kind: 'ref'; plan: RefPlan } | { kind: 'comment'; text: string }> = [];
  const endpoints = new Set<string>();
  for (const item of prepared.links) {
    if (item.kind === 'skipped') {
      refItems.push({ kind: 'comment', text: `// Not exported: ${item.text} (${item.reason}).` });
      continue;
    }
    const { link } = item;
    const about = describeEnds(link.from.name, link.fromColumns, link.to.name, link.toColumns);
    const plan = refPlan(link);
    const sameColumns = (a: string[], b: string[]): boolean => a.length === b.length && a.every((c) => b.includes(c));
    if (tableKey(plan.left.model) === tableKey(plan.right.model) && sameColumns(plan.left.columns, plan.right.columns)) {
      refItems.push({ kind: 'comment', text: `// Not exported: ${about} (its two ends are the same columns, which DBML refuses).` });
      continue;
    }
    const key = endpointsKey(plan);
    if (endpoints.has(key)) {
      refItems.push({ kind: 'comment', text: `// Not exported: ${about} (another relationship already joins the same columns, and DBML allows one).` });
      continue;
    }
    endpoints.add(key);
    refItems.push({ kind: 'ref', plan });
    // The FK end is where core puts the FK badge (`foreignKeyEnd`), a
    // many-to-many's included, and where import puts the relationship's FK.
    for (const c of plan.fk.columns) facts.fkCovered.add(columnKey(plan.fk.model, c));
    if (plan.operator === '<>') continue;
    if (plan.operator === '-') {
      const { fk } = plan;
      const pkColumns = fk.model.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
      if (fk.columns.length === 1) {
        facts.uniqueColumns.add(columnKey(fk.model, fk.columns[0]));
      } else if (!sameColumns(fk.columns, pkColumns)) {
        const list = facts.uniqueIndexes.get(tableKey(fk.model)) ?? [];
        if (!list.some((cols) => sameColumns(cols, fk.columns))) list.push([...fk.columns]);
        facts.uniqueIndexes.set(tableKey(fk.model), list);
      }
    }
  }

  // Tables.
  for (const item of prepared.models) {
    out.push('');
    if (item.kind === 'skipped') {
      out.push(`// Not exported: ${item.text}.`);
      continue;
    }
    out.push(...tableBlock(item.model, facts));
  }

  // The layer.
  if (prepared.layer.trim()) {
    const settings: string[] = [];
    const colour = layerColour(input);
    if (colour) settings.push(`color: ${colour}`);
    const label = layerLabel(input, prepared.layer);
    if (label) settings.push(`note: ${str(`Layer: ${label}`)}`);
    out.push('', `TableGroup ${ident(prepared.layer.trim())}${bracket(settings)} {`, ...models.map((m) => `  ${tableName(m)}`), '}');
  }

  // Relationships.
  if (refItems.length > 0) out.push('');
  for (const item of refItems) {
    if (item.kind === 'comment') out.push(item.text);
    else out.push(...refLines(item.plan));
  }

  // Sticky notes.
  prepared.stickies.forEach((sticky, i) => {
    const settings: string[] = [];
    const known = sticky.color !== undefined && Object.prototype.hasOwnProperty.call(DBML_RICH_STICKY_COLOURS, sticky.color);
    if (known) settings.push(`color: ${(DBML_RICH_STICKY_COLOURS as Record<string, string>)[sticky.color!]}`);
    if (sticky.linkedModel) settings.push(`${DBML_RICH_NOTE_PROPERTIES.linkedTable}: ${str(sticky.linkedModel)}`);
    const body = noteText(sticky.text);
    out.push('');
    if (sticky.color !== undefined && !known) {
      out.push(...commentLines(`Sticky note ${i + 1}: colour not exported (not one ERD Studio knows): `, sticky.color));
    }
    out.push(`Note ${DBML_RICH_STICKY_PREFIX}${i + 1}${bracket(settings)} {`, `  ${str(body)}`, '}');
  });

  return out.join('\n') + '\n';
}
