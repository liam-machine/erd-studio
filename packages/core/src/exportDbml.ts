/**
 * `toDbml` — a diagram as DBML (https://dbml.dbdiagram.io), one way.
 *
 * The output is a contract: the same `DisplayDomain` always gives the same
 * text, it opens with a version line, and every mapping change is a
 * deliberate golden update plus a CHANGELOG line. ERD Studio's own files stay
 * the source of truth; nothing reads this back.
 *
 * **Portable DBML only.** The text uses nothing a DBML parser from
 * `@dbml/core` 2.4.2 (June 2022) onwards rejects: it is held to `@dbml/core`
 * 2.4.2, 2.6.1 and 3.13.4 (the old parser most DBML tools still embed) as well
 * as the current `@dbml/parse`. (2.3 and older reject a schema-qualified table
 * name, 2.4.0 and 2.4.1 a many-to-many `<>`.) So there are no custom
 * properties (`[erd_grain: …]` needs `@dbml/parse` 9.1 or later; every older
 * parser rejects the whole file as an unknown setting) and no standalone
 * `Note` blocks (also newer than those parsers): ERD Studio's own fields
 * travel as readable lines in the notes all of them read.
 *
 * | ERD Studio                         | DBML                                                                    |
 * |------------------------------------|-------------------------------------------------------------------------|
 * | (header)                           | `// erd-studio dbml-export v1`, then `//` lines naming what is left out  |
 * | domain name                        | `Project <name> { … }` (`Project { … }` when it has none)               |
 * | layer, stage, description          | the Project `Note`: `Layer: …`, `Stage: …`, a blank line, the description |
 * | model (+ schema)                   | `Table [schema.]name` — the model name, never the alias                 |
 * | modelRole, grain, alias            | table `Note` lines `Role: …`, `Grain: …`, `Warehouse table (alias): …` — never `Table x as y` (DBML aliases are unique; ours are not) |
 * | description                        | the table `Note`, after a blank line                                    |
 * | rationale                          | table `Note` lines `Purpose: …`, `Design: …`, …, after a blank line      |
 * | model meta (plain text, yes/no)    | table `Note` lines `Meta – <key>: <value>`, after a blank line          |
 * | column                             | `name type` — type unquoted when a plain word, else `"…"`; empty → `unknown` |
 * | single primary key                 | column `[pk]`                                                            |
 * | composite primary key              | `indexes { (a, b) [pk] }`                                               |
 * | column description                 | column `[note: '…']`                                                    |
 * | isNaturalKey, scdType, additiveType, FK flag with no exported Ref, column meta | after the description in the column note: `(natural key; SCD type 2; semi-additive; foreign key; meta unit: EUR)` |
 * | many-to-one / one-to-many          | `Ref: from.col > to.col` / `Ref: from.col < to.col` (written from the from end) |
 * | one-to-one / many-to-many          | `Ref: from.col - to.col` / `Ref: from.col <> to.col`                    |
 * | composite foreign key              | one `Ref: a.(x, y) > b.(u, v)`                                          |
 * | relationship role                  | the Ref's name: `Ref "ship date": …`; a `// Role: …` line above the Ref when the role holds `"` or `\` |
 * | sticky note                        | `// Sticky note <n>: …` lines at the end, a linked model named          |
 *
 * Strings: a one-line note without a backslash is single-quoted with `\'`
 * escapes; any other is triple-quoted (`'''…'''`) with `\'` and `\\`
 * escapes, because older parsers keep `\n`, `\t` and `\\` in single quotes
 * as written. No escape reads alike in old and new parsers for a backslash
 * before another backslash or before `'` (the old ones read a run of
 * backslashes as one fewer, and refuse a note ending in `\'`), so such a
 * backslash is followed by a space, with a comment saying so. White space at
 * either end of a note is dropped (old and new parsers trim it differently). Names are bare when they are plain
 * identifiers, else double-quoted; the old `@dbml/core` parser has no escape
 * for `"` or `\` inside a quoted name, so those become `'` and `/` (a comment,
 * or the column note, gives the original). DBML rejects a table without columns, so
 * a model with none (or whose file could not be read) becomes a comment. A
 * relationship whose ends are not in the diagram, a self-pointing column and a
 * second copy of a link are left out with a comment saying why. Positions,
 * sizes, sticky-note colours and nested meta values are never exported.
 */

import type { DisplayDomain } from './types/display.js';
import { describeEnds, foreignKeyColumns, oneLine, prepareDomain } from './exportShared.js';
import type { ExportColumn, ExportLink, ExportMeta, ExportModel } from './exportShared.js';

export const DBML_EXPORT_HEADER = '// erd-studio dbml-export v1';

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Note text every DBML parser reads back alike: `\n` line ends, no white space at either end (parsers trim it differently). */
function noteText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

/**
 * `value` with a space after each backslash that comes before another
 * backslash or a `'`: in a triple-quoted string the old `@dbml/core` parsers
 * read a run of backslashes as one fewer and drop a backslash before a `'`,
 * the current one reads both as written, and no escape satisfies both.
 */
function spacedBackslashes(value: string): string {
  return value.replace(/\\(?=[\\'])/g, '\\ ');
}

/** The comment for a note {@link spacedBackslashes} changes, else `null`. */
function backslashComment(subject: string, note: string): string | null {
  return spacedBackslashes(note) === note
    ? null
    : `// ${subject}: a space follows each \\ that comes before another \\ or a ' in its note (DBML parsers read those differently)`;
}

/** A DBML string that every parser reads back alike: `value` (already through {@link noteText}) after {@link spacedBackslashes}. */
function str(value: string): string {
  if (!/[\n\\]/.test(value)) return `'${value.replace(/'/g, "\\'")}'`;
  return `'''${spacedBackslashes(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'''`;
}

/** `value` with what no old parser reads inside a quoted name made readable: `"` → `'`, `\` → `/`, control characters → space. */
function portableName(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/"/g, "'").replace(/\\/g, '/').replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

/** A DBML name: bare when it is a plain identifier, else double-quoted. */
function ident(value: string): string {
  return PLAIN_IDENTIFIER.test(value) ? value : `"${portableName(value)}"`;
}

/** Whether `ident(value)` reads back as something other than `value`. */
function nameChanged(value: string): boolean {
  return !PLAIN_IDENTIFIER.test(value) && portableName(value) !== value;
}

function tableName(model: ExportModel): string {
  return model.schema ? `${ident(model.schema)}.${ident(model.name)}` : ident(model.name);
}

function columnType(dataType: string): string {
  return dataType.trim() === '' ? 'unknown' : ident(dataType);
}

function metaNotExported(meta: ExportMeta): string | null {
  return meta.other.length > 0 ? `meta not exported (a list, a map or empty): ${meta.other.map(oneLine).join(', ')}` : null;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The column note: its description, then the ERD fields DBML has no place for, in brackets. */
function columnNote(column: ExportColumn, fkCovered: boolean): string {
  const extras: string[] = [];
  if (column.isNaturalKey) extras.push('natural key');
  if (column.scdType !== undefined) extras.push(`SCD type ${column.scdType}`);
  if (column.additiveType) extras.push(oneLine(column.additiveType));
  if (column.isForeignKey && !fkCovered) extras.push('foreign key');
  for (const [key, value] of column.meta.text) extras.push(`meta ${oneLine(key)}: ${oneLine(value)}`);
  if (column.dataType.trim() !== '' && nameChanged(column.dataType)) extras.push(`type ${oneLine(column.dataType)}`);
  if (nameChanged(column.name)) extras.push(`name ${oneLine(column.name)}`);

  const description = noteText(column.description);
  const list = extras.filter((e) => e !== '').join('; ');
  if (!list) return description;
  if (!description.trim()) return capitalise(list);
  return `${description}${description.includes('\n') ? '\n' : ' '}(${list})`;
}

/** The table note: the ERD fields, the description, the rationale and the meta, a blank line between each. */
function tableNote(model: ExportModel): string {
  const facts: string[] = [];
  if (model.modelRole) facts.push(`Role: ${model.modelRole}`);
  if (model.grain) facts.push(`Grain: ${model.grain}`);
  if (model.alias) facts.push(`Warehouse table (alias): ${model.alias}`);
  const sections = [
    facts.join('\n'),
    model.description,
    model.rationale.map(([label, value]) => `${label}: ${value}`).join('\n'),
    model.meta.text.map(([key, value]) => `Meta – ${oneLine(key)}: ${value}`).join('\n'),
  ];
  return sections
    .map(noteText)
    .filter((s) => s.trim() !== '')
    .join('\n\n');
}

function loadErrorText(model: ExportModel): string {
  const error = model.loadError!;
  return `its model file could not be read (${oneLine(error.kind)}${error.line !== undefined ? `, line ${error.line}` : ''})`;
}

const columnKey = (model: ExportModel, column: string): string => `${model.name}\u0000${column}`.toLowerCase();

/**
 * A table's lines. Records each column it writes in `written`; a column whose
 * DBML name another column of the table already took is left out with a
 * comment.
 */
function tableBlock(model: ExportModel, fkColumns: Set<string>, written: Set<string>): string[] {
  const lines: string[] = [];
  if (nameChanged(model.name) || nameChanged(model.schema)) {
    const original = model.schema ? `${oneLine(model.schema)}.${oneLine(model.name)}` : oneLine(model.name);
    lines.push(`// ${original} is written as ${tableName(model)}: DBML names cannot hold " or \\ in every parser`);
  }
  const modelMeta = metaNotExported(model.meta);
  if (modelMeta) lines.push(`// ${oneLine(model.name)}: ${modelMeta}`);
  for (const sentence of model.skippedColumns) lines.push(`// ${oneLine(model.name)}: ${sentence}; not exported`);
  if (model.loadError) lines.push(`// ${oneLine(model.name)}: ${loadErrorText(model)}; only the columns shown are exported`);
  const tableNoteText = tableNote(model);
  const tableBackslashes = backslashComment(oneLine(model.name), tableNoteText);
  if (tableBackslashes) lines.push(tableBackslashes);
  lines.push(`Table ${tableName(model)} {`);

  const names = new Set<string>();
  const columns = model.columns.filter((c) => {
    const name = ident(c.name);
    if (names.has(name)) {
      lines.push(`  // ${oneLine(c.name)}: written as ${name}, the name of an earlier column; not exported`);
      return false;
    }
    names.add(name);
    return true;
  });

  const pks = columns.filter((c) => c.isPrimaryKey);
  const singlePk = pks.length === 1;
  for (const c of columns) {
    written.add(columnKey(model, c.name));
    const meta = metaNotExported(c.meta);
    if (meta) lines.push(`  // ${oneLine(c.name)}: ${meta}`);
    const note = columnNote(c, fkColumns.has(columnKey(model, c.name)));
    const backslashes = backslashComment(oneLine(c.name), note);
    if (backslashes) lines.push(`  ${backslashes}`);
    const settings: string[] = [];
    if (singlePk && c.isPrimaryKey) settings.push('pk');
    if (note.trim()) settings.push(`note: ${str(note)}`);
    lines.push(`  ${ident(c.name)} ${columnType(c.dataType)}${settings.length > 0 ? ` [${settings.join(', ')}]` : ''}`);
  }
  if (pks.length > 1) {
    lines.push('  indexes {', `    (${pks.map((c) => ident(c.name)).join(', ')}) [pk]`, '  }');
  }
  if (tableNoteText) lines.push(`  Note: ${str(tableNoteText)}`);
  lines.push('}');
  return lines;
}

function refEnd(model: ExportModel, columns: string[]): string {
  return columns.length === 1
    ? `${tableName(model)}.${ident(columns[0])}`
    : `${tableName(model)}.(${columns.map(ident).join(', ')})`;
}

const OPERATORS = { 'many-to-one': '>', 'one-to-many': '<', 'one-to-one': '-', 'many-to-many': '<>' } as const;

function refLines(link: ExportLink): string[] {
  const ref = `${refEnd(link.from, link.fromColumns)} ${OPERATORS[link.cardinality]} ${refEnd(link.to, link.toColumns)}`;
  if (!link.role) return [`Ref: ${ref}`];
  // A Ref name in quotes cannot hold `"` or `\` for the older parsers; such a role is a comment instead.
  if (/["\\]/.test(link.role)) return [`// Role: ${link.role}`, `Ref: ${ref}`];
  return [`Ref ${ident(link.role)}: ${ref}`];
}

/** `// label text` lines, one per line of `value`; the later ones indented under the label. */
function commentLines(label: string, value: string): string[] {
  const lines = value.split(/\r\n|\r|\n/).map(oneLine).filter((l) => l !== '');
  if (lines.length === 0) return [];
  return [`// ${label}${lines[0]}`, ...lines.slice(1).map((l) => `//     ${l}`)];
}

/** The diagram as DBML. Deterministic; never throws on a valid `DisplayDomain`, however minimal. */
export function toDbml(domain: DisplayDomain): string {
  const prepared = prepareDomain(domain);
  const out: string[] = [
    DBML_EXPORT_HEADER,
    '// Not exported: canvas positions and sizes, sticky-note colours, nested meta values (lists and maps).',
    "// ERD Studio's own fields (role, grain, alias, rationale, natural keys, SCD type, additivity, meta) are in the notes.",
  ];

  const about: string[] = [];
  if (prepared.layer.trim()) about.push(`Layer: ${oneLine(prepared.layer)}`);
  if (prepared.stage.trim()) about.push(`Stage: ${oneLine(prepared.stage)}`);
  const projectNote = [about.join('\n'), prepared.description]
    .map(noteText)
    .filter((s) => s.trim() !== '')
    .join('\n\n');
  if (prepared.name.trim() || projectNote) {
    out.push('');
    const backslashes = backslashComment('Project', projectNote);
    if (backslashes) out.push(backslashes);
    out.push(prepared.name.trim() ? `Project ${ident(prepared.name)} {` : 'Project {');
    if (projectNote) out.push(`  Note: ${str(projectNote)}`);
    out.push('}');
  }

  // The foreign-key columns of exported links (the to end of a one-to-many): their FK flag needs no note.
  const fkColumns = new Set<string>();
  for (const item of prepared.links) {
    if (item.kind !== 'link') continue;
    const fk = foreignKeyColumns(item.link);
    for (const c of fk.columns) fkColumns.add(columnKey(fk.model, c));
  }

  const tables = new Set<string>();
  const written = new Set<string>();
  for (const item of prepared.models) {
    out.push('');
    if (item.kind === 'skipped') {
      out.push(`// Not exported: ${item.text}.`);
      continue;
    }
    const model = item.model;
    if (model.columns.length === 0) {
      const why = model.loadError ? loadErrorText(model) : 'it has no columns, and a DBML table needs at least one';
      out.push(`// Table ${oneLine(model.name)} is not exported: ${why}.`);
      continue;
    }
    const name = tableName(model);
    if (tables.has(name)) {
      out.push(`// Table ${oneLine(model.name)} is not exported: it is written as ${name}, the name of an earlier table.`);
      continue;
    }
    tables.add(name);
    out.push(...tableBlock(model, fkColumns, written));
  }

  if (prepared.links.length > 0) out.push('');
  for (const item of prepared.links) {
    if (item.kind === 'skipped') {
      out.push(`// Not exported: ${item.text} (${item.reason}).`);
      continue;
    }
    const { link } = item;
    const ends = [
      ...link.fromColumns.map((c) => columnKey(link.from, c)),
      ...link.toColumns.map((c) => columnKey(link.to, c)),
    ];
    if (ends.some((key) => !written.has(key))) {
      out.push(`// Not exported: ${describeEnds(link.from.name, link.fromColumns, link.to.name, link.toColumns)} (a table or column it joins is not exported).`);
      continue;
    }
    out.push(...refLines(link));
  }

  if (prepared.stickies.length > 0) out.push('');
  prepared.stickies.forEach((sticky, i) => {
    const linked = sticky.linkedModel ? ` (linked to ${oneLine(sticky.linkedModel)})` : '';
    out.push(...commentLines(`Sticky note ${i + 1}${linked}: `, sticky.text));
  });

  return out.join('\n') + '\n';
}
