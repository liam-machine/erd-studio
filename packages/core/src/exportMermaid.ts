/**
 * `toMermaid` — a diagram as a Mermaid `erDiagram`
 * (https://mermaid.js.org/syntax/entityRelationshipDiagram.html), one way.
 *
 * The output is a contract: the same `DisplayDomain` always gives the same
 * text, its second line (after `erDiagram`) is a version line, and every
 * mapping change is a deliberate golden update plus a CHANGELOG line. The
 * syntax used is the
 * subset every Mermaid release from 10.0.0 to the current one parses (GitHub,
 * GitLab and wikis render with older releases than the latest; the tests hold
 * each output to 10.0.0 and to the current release), which is why `erDiagram`
 * is the first line (10.0 to 10.4 reject a comment before it), why types and
 * names are reduced to letters, digits and `_` and why nothing uses entity
 * aliases, `accTitle` or a `title` line.
 *
 * | ERD Studio                        | Mermaid                                                                  |
 * |-----------------------------------|--------------------------------------------------------------------------|
 * | (header)                          | `erDiagram`, then `%% erd-studio mermaid-export v1` and `%%` lines naming what is left out |
 * | domain name, layer, description   | `%% Diagram: …` and `%% Description: …` lines                            |
 * | model                             | entity `"name" { … }` — always quoted (so `end`, `style` and other keywords work; Mermaid 10.0.0 already reads quoted names), the model name, never the alias; `"`, `%` and `\` become `'`, `_` and `/` (a `%%` line gives the original) |
 * | schema, alias, role, grain, description, rationale, meta | `%%` lines above the entity: `%%   grain: …`, `%%   Purpose: …`, `%%   meta owner: …` |
 * | column                            | `type name KEYS "comment"`                                               |
 * | type                              | letters, digits and `_` only (`decimal(10,2)` → `decimal_10_2`); `t_` before a leading digit; empty → `unknown`; the original in the comment when it differs |
 * | column name                       | letters, digits and `_` only; `_` before a leading digit or a bare `PK`/`FK`/`UK`; the original in the comment when it differs |
 * | isPrimaryKey / isForeignKey / isNaturalKey | `PK` / `FK` / `UK` markers, comma-separated                     |
 * | description, scdType, additiveType | the comment: `description; type …; SCD type 2; additive`, `"` turned into `'` |
 * | column meta (plain text, yes/no)  | `%%   <column> meta <key>: …` above the entity                           |
 * | many-to-one / one-to-many         | `"from" }o--|| "to"` / `"from" ||--o{ "to"`                               |
 * | one-to-one / many-to-many         | `"from" ||--|| "to"` / `"from" }o--o{ "to"`                               |
 * | relationship columns              | a `%% from.col -> to.col, cardinality` line above the relationship       |
 * | relationship role                 | the label; without a role, the foreign-key column(s)                     |
 * | composite foreign key             | one relationship, label (or comment) naming every column                 |
 * | sticky note                       | `%% Sticky note <n>: …` lines at the end                                 |
 *
 * Mermaid has no column-level relationships, so the comment line above each
 * relationship keeps its exact columns. Models without columns (or whose file
 * could not be read) are empty entities. A model whose entity name an earlier
 * model already took is left out with a comment. Relationships are left out,
 * with a comment saying why, exactly as the DBML export leaves them out: an
 * end that is not in the diagram (or not exported), a self-pointing column, a
 * second copy of a link. Every `%%` in free text — comment lines, labels and
 * column comments — is written `% %`: Mermaid reads `%%{…}%%` anywhere in
 * the text as a directive (so a description could restyle the diagram), and
 * 10.x refuses a label that starts with `%%`. A `~` in a column comment is
 * written `∼` (U+223C): Mermaid reads `~…~` in an attribute as a generic type.
 * Positions, sizes, sticky-note colours and nested meta values are never
 * exported.
 */

import type { DisplayDomain } from './types/display.js';
import { describeEnds, foreignKeyColumns, oneLine, prepareDomain } from './exportShared.js';
import type { ExportColumn, ExportLink, ExportModel } from './exportShared.js';

export const MERMAID_EXPORT_HEADER = '%% erd-studio mermaid-export v1';

const KEY_WORD = /^(pk|fk|uk)$/i;

/** `value` with every `%%` broken up (`% %`), so neither a directive (`%%{…}%%`) nor a comment can start inside it. */
function breakPercents(value: string): string {
  return value.replace(/%(?=%)/g, '% ');
}

/** Text safe inside a Mermaid double-quoted string: one line, no `"`, no `%%`. */
function quotedText(value: string): string {
  return breakPercents(oneLine(value).replace(/"/g, "'"));
}

/** A model name every Mermaid release reads inside quotes: one line, `"` → `'`, `%` → `_`, `\` → `/`. */
function entityName(name: string): string {
  return oneLine(name).replace(/"/g, "'").replace(/%/g, '_').replace(/\\/g, '/');
}

function entity(model: ExportModel): string {
  return `"${entityName(model.name)}"`;
}

/** A type token every Mermaid release reads. */
export function mermaidType(dataType: string): string {
  let type = dataType.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+$/, '');
  if (type === '') return 'unknown';
  if (/^[0-9]/.test(type) || KEY_WORD.test(type)) type = `t_${type}`;
  return type;
}

/** An attribute name every Mermaid release reads. */
export function mermaidName(name: string): string {
  let out = name.trim().replace(/[^A-Za-z0-9_]+/g, '_');
  if (out === '' || /^[0-9]/.test(out) || KEY_WORD.test(out)) out = `_${out}`;
  return out;
}

/** `%% label value` comment lines, one per line of `value`; none when it is blank. */
function commentLines(indent: string, label: string, value: string): string[] {
  const lines = value.split(/\r\n|\r|\n/).map(oneLine).filter((l) => l !== '');
  if (lines.length === 0) return [];
  return [`${indent}%% ${label}${lines[0]}`, ...lines.slice(1).map((l) => `${indent}%%     ${l}`)];
}

function attributeLine(column: ExportColumn): string {
  const type = mermaidType(column.dataType);
  const name = mermaidName(column.name);
  const keys = [column.isPrimaryKey && 'PK', column.isForeignKey && 'FK', column.isNaturalKey && 'UK'].filter(Boolean);
  const parts: string[] = [];
  if (oneLine(column.description)) parts.push(quotedText(column.description));
  if (type !== column.dataType.trim() && column.dataType.trim() !== '') parts.push(`type ${quotedText(column.dataType)}`);
  if (name !== column.name) parts.push(`name ${quotedText(column.name)}`);
  if (column.scdType !== undefined) parts.push(`SCD type ${column.scdType}`);
  if (column.additiveType) parts.push(quotedText(column.additiveType));
  // Mermaid reads `~…~` in an attribute as generic-type syntax, even inside the comment, so a
  // tilde is written as `∼` (U+223C), which every release reads as text.
  const comment = parts.length > 0 ? ` "${parts.join('; ').replace(/~/g, '∼')}"` : '';
  return `    ${type} ${name}${keys.length > 0 ? ` ${keys.join(', ')}` : ''}${comment}`;
}

function modelLines(model: ExportModel): string[] {
  const lines: string[] = [`  %% Model ${oneLine(model.name)}`];
  if (entityName(model.name) !== model.name) {
    lines.push(`  %%   written as ${entity(model)}: Mermaid entity names cannot hold ", % or \\`);
  }
  const add = (label: string, value: string | undefined): void => {
    if (value) lines.push(...commentLines('  ', `  ${label}: `, value));
  };
  add('schema', model.schema);
  add('alias', model.alias);
  add('role', model.modelRole);
  add('grain', model.grain);
  add('description', model.description);
  for (const [label, value] of model.rationale) add(label, value);
  for (const [key, value] of model.meta.text) add(`meta ${oneLine(key)}`, value);
  if (model.meta.other.length > 0) {
    lines.push(`  %%   meta not exported (a list, a map or empty): ${model.meta.other.map(oneLine).join(', ')}`);
  }
  for (const column of model.columns) {
    for (const [key, value] of column.meta.text) add(`${oneLine(column.name)} meta ${oneLine(key)}`, value);
    if (column.meta.other.length > 0) {
      lines.push(`  %%   ${oneLine(column.name)} meta not exported (a list, a map or empty): ${column.meta.other.map(oneLine).join(', ')}`);
    }
  }
  for (const sentence of model.skippedColumns) lines.push(`  %%   ${sentence}; not exported`);
  if (model.loadError) {
    const error = model.loadError;
    lines.push(`  %%   its model file could not be read (${oneLine(error.kind)}${error.line !== undefined ? `, line ${error.line}` : ''})`);
  } else if (model.columns.length === 0) {
    lines.push('  %%   no columns yet');
  }
  lines.push(`  ${entity(model)} {`, ...model.columns.map(attributeLine), '  }');
  return lines;
}

const CONNECTORS = { 'many-to-one': '}o--||', 'one-to-many': '||--o{', 'one-to-one': '||--||', 'many-to-many': '}o--o{' } as const;

function relationshipLines(link: ExportLink): string[] {
  const label = link.role ?? foreignKeyColumns(link).columns.join(', ');
  return [
    `  %% ${describeEnds(link.from.name, link.fromColumns, link.to.name, link.toColumns)}, ${link.cardinality}`,
    `  ${entity(link.from)} ${CONNECTORS[link.cardinality]} ${entity(link.to)} : "${quotedText(label)}"`,
  ];
}

/** The diagram as a Mermaid `erDiagram`. Deterministic; never throws on a valid `DisplayDomain`, however minimal. */
export function toMermaid(domain: DisplayDomain): string {
  const prepared = prepareDomain(domain);
  const about = [prepared.layer && `layer ${oneLine(prepared.layer)}`, prepared.stage && `${oneLine(prepared.stage)} stage`].filter(Boolean);
  const out: string[] = [
    // `erDiagram` first: Mermaid 10.0 to 10.4 reject any line before it, comments included.
    'erDiagram',
    MERMAID_EXPORT_HEADER,
    '%% Not exported: canvas positions and sizes, sticky-note colours, nested meta values (lists and maps).',
    '%% Types and column names keep only letters, digits and _; a column comment gives the original when it differs.',
    `%% Diagram: ${oneLine(prepared.name) || '(unnamed)'}${about.length > 0 ? ` (${about.join(', ')})` : ''}`,
    ...commentLines('', 'Description: ', prepared.description),
  ];

  const entities = new Set<string>();
  const exported = new Set<ExportModel>();
  for (const item of prepared.models) {
    if (item.kind === 'skipped') {
      out.push(`  %% Not exported: ${item.text}.`);
      continue;
    }
    const name = entity(item.model);
    if (entities.has(name)) {
      out.push(`  %% Not exported: ${oneLine(item.model.name)} is written as ${name}, the name of an earlier entity.`);
      continue;
    }
    entities.add(name);
    exported.add(item.model);
    out.push('', ...modelLines(item.model));
  }

  if (prepared.links.length > 0) out.push('');
  for (const item of prepared.links) {
    if (item.kind === 'skipped') {
      out.push(`  %% Not exported: ${item.text} (${item.reason}).`);
      continue;
    }
    const { link } = item;
    if (!exported.has(link.from) || !exported.has(link.to)) {
      out.push(`  %% Not exported: ${describeEnds(link.from.name, link.fromColumns, link.to.name, link.toColumns)} (a model it joins is not exported).`);
      continue;
    }
    out.push(...relationshipLines(link));
  }

  if (prepared.stickies.length > 0) out.push('');
  prepared.stickies.forEach((sticky, i) => {
    const linked = sticky.linkedModel ? ` (linked to ${oneLine(sticky.linkedModel)})` : '';
    out.push(...commentLines('  ', `Sticky note ${i + 1}${linked}: `, sticky.text));
  });

  // Comment lines carry free text (names, descriptions, notes): no `%%` may form inside them.
  return out.map((line) => line.replace(/^(\s*%%)(.*)$/, (_, marker: string, rest: string) => marker + breakPercents(rest))).join('\n') + '\n';
}
