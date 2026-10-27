/**
 * Read one `.dbml` table file (§2.2 of the native DBML storage spec) into a
 * {@link SemanticTable}, on its own: a table file needs no other file, so a
 * deleted neighbour never breaks it. A `use` line, a `Ref` or a column
 * `[ref: …]` is blanked out before compiling (offsets kept) and reported:
 * the table still loads, but writes are refused until the line moves to the
 * folder's relationships file.
 */

import type { ColumnDef, Rationale, SemanticTable } from '../types/semantic.js';
import type { DbmlProblem, DbmlTableReading } from '../types/dbmlStorage.js';
import {
  DBML_RICH_COLUMN_PROPERTIES,
  DBML_RICH_META_JSON_PROPERTY,
  DBML_RICH_META_PREFIX,
  DBML_RICH_PLACEHOLDER_COLUMN,
  DBML_RICH_PLACEHOLDER_PROPERTY,
  DBML_RICH_TABLE_PROPERTIES,
  DBML_RICH_PROPERTY_PREFIX,
  bareDbmlProperty,
  rationaleKeyOf,
} from '../dbmlRichProperties.js';
import { dbmlName } from '../dbmlText.js';
import { readMeta } from '../meta.js';
import { findConflictMarkers } from '../mergeConflict.js';
import { DBML_QUOTE_HINT, DBML_TABLE_QUOTE_HINT_CODES, classifyDbmlTableError, type DbmlTableStructureRule } from '../domain.js';
import type { DbmlMetadataTarget, TableLoadError } from '../types/semantic.js';
import type { DbmlParserModule } from './parserModule.js';
import {
  PINNED_PARSER,
  attributeName,
  attributeRemovalSpans,
  blankSpans,
  compileOne,
  elementType,
  isUseDeclaration,
  lineAt,
  lineStartOf,
  nameFragments,
  plainNames,
  propertyText,
  stripBom,
  topLevel,
  type AstNode,
  type ParserDiagnostic,
} from './parser.js';

/** Top-level elements a table file may hold besides its one Table (D25: `Metadata` blocks a person wrote). */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set(['table', 'enum', 'metadata']);

type Failure = Extract<DbmlTableReading, { ok: false }>;

function failure(
  message: string,
  error: { dbmlCode?: number; rule?: DbmlTableStructureRule; line?: number; column?: number; mergeConflict?: boolean; target?: DbmlMetadataTarget },
): Failure {
  const classified: TableLoadError & { column?: number } = classifyDbmlTableError(error);
  return { ok: false, error: { ...classified, message } };
}

/** The failure for a parser diagnostic, with the quote hint for an unquoted table or column value. */
function diagnosticFailure(d: ParserDiagnostic): Failure {
  const hint = DBML_TABLE_QUOTE_HINT_CODES.has(String(d.code)) ? ` ${DBML_QUOTE_HINT}` : '';
  return failure(`Line ${d.line}, column ${d.column}: ${d.message} [${d.code}].${hint}`, {
    dbmlCode: d.code, line: d.line, column: d.column,
  });
}

/** One line of the source, collapsed to single spaces, for a message. */
function sourceOf(text: string, node: AstNode): string {
  return text.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
}

/** The Ref line a column `[ref: <op> <target>]` stands for, as the writer would write it (FK end marked, D18). */
function refLineFor(tableRef: string, column: string, attribute: AstNode, text: string): string | undefined {
  const value = attribute.value;
  if (value?.kind !== '<prefix-expression>' || typeof value.op?.value !== 'string' || !value.expression) return undefined;
  const op = value.op.value.replace(/\?/g, '');
  const target = text.slice(value.expression.start, value.expression.end).trim();
  const own = `${tableRef}.${dbmlName(column)}`;
  switch (op) {
    case '>': return `Ref: ${own} >? ${target}`;
    case '<': return `Ref: ${target} >? ${own}`;
    case '-': return `Ref: ${target} ?- ${own}`;
    case '<>': return `Ref: ${own} <>? ${target}`;
    default: return undefined;
  }
}

const isTrue = (value: string | undefined): boolean => value !== undefined && value.trim().toLowerCase() === 'true';

const ADDITIVE_TYPES: ReadonlySet<string> = new Set(['additive', 'semi-additive', 'non-additive']);

/** A property map read as text, `erd_<x>` winning over `<x>`, each 11.0 typed value reported once. */
function readProperties(
  metadata: unknown,
  text: string,
  where: string,
  problems: DbmlProblem[],
): Map<string, string> {
  const out = new Map<string, string>();
  const prefixed = new Set<string>();
  if (!metadata || typeof metadata !== 'object') return out;
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    const read = propertyText(value, text);
    if (!read) continue;
    if (read.typed) {
      const token = (value as AstNode)?.token;
      const offset = typeof token?.start?.offset === 'number' ? token.start.offset : undefined;
      problems.push({
        code: 'unquotedValue',
        severity: 'warning',
        ...(offset !== undefined ? { line: lineAt(text, offset) } : {}),
        message: `${where}: \`${key}: ${read.text}\` reads only in DBML 11+; quote it, as in \`${key}: '${read.text}'\`, so DBML 9 and 10 tools can read the file`,
      });
    }
    const bare = bareDbmlProperty(key);
    const isPrefixed = bare !== key;
    if (!isPrefixed && prefixed.has(bare)) continue;
    if (isPrefixed) prefixed.add(bare);
    out.set(bare, read.text);
  }
  return out;
}

/** `meta` from `meta_json` and `meta_<key>` properties (a `meta_<key>` wins over the same key in the JSON). */
function readMetaProperties(props: ReadonlyMap<string, string>, where: string, problems: DbmlProblem[]): ReturnType<typeof readMeta> {
  const raw: Record<string, unknown> = {};
  const set = (key: string, value: unknown): void => {
    Object.defineProperty(raw, key, { value, enumerable: true, writable: true, configurable: true });
  };
  const json = props.get(DBML_RICH_META_JSON_PROPERTY);
  if (json !== undefined) {
    let parsed: unknown;
    let ok = false;
    try {
      parsed = JSON.parse(json);
      ok = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      ok = false;
    }
    if (ok) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) set(key, value);
    } else {
      problems.push({ code: 'metaJson', severity: 'warning', message: `${where}: meta_json is not a JSON object; it is kept as the text of meta "json"` });
      set('json', json);
    }
  }
  for (const [key, value] of props) {
    if (key === DBML_RICH_META_JSON_PROPERTY || !key.startsWith(DBML_RICH_META_PREFIX)) continue;
    const metaKey = key.slice(DBML_RICH_META_PREFIX.length);
    if (metaKey !== '') set(metaKey, value);
  }
  return readMeta(raw);
}

function noteText(value: unknown): string {
  if (typeof value === 'string') return value;
  return value && typeof value === 'object' && typeof (value as AstNode).value === 'string' ? (value as AstNode).value : '';
}

/**
 * Read a `.dbml` table file. `fileStem` is the file name without `.dbml`,
 * as the directory listing spells it; the Table's declared name must equal
 * it but for case (D2), and is the table's name.
 *
 * Never throws for bad DBML: a file that cannot be read comes back as
 * `{ ok: false }` with the `TableLoadError` the canvas shows and a message
 * for logs. `parser` is the pinned `@dbml/parse` unless a test passes another.
 */
export function parseTableDbml(rawText: string, fileStem: string, parser: DbmlParserModule = PINNED_PARSER): DbmlTableReading {
  const text = stripBom(rawText);
  if (text.trim() === '') {
    return { ok: false, error: { kind: 'read', message: `${fileStem}.dbml is empty` } };
  }
  let first;
  try {
    first = compileOne(text, parser);
  } catch (err) {
    return failure(`The DBML parser stopped: ${err instanceof Error ? err.message : String(err)}`, { dbmlCode: 1000, line: 1, column: 1 });
  }
  const syntax = first.errors.filter((d) => d.errorClass === 'syntax');
  if (first.errors.length > 0) {
    const conflict = findConflictMarkers(text);
    if (conflict !== null) {
      return failure(`${fileStem}.dbml has unresolved git merge conflicts (first at line ${conflict})`, { mergeConflict: true, line: conflict });
    }
  }
  if (syntax.length > 0) return diagnosticFailure(syntax[0]);

  // Structure (§2.2): exactly one Table, named as the file, and nothing a table file may not hold.
  const problems: DbmlProblem[] = [];
  const blanks: Array<{ start: number; end: number }> = [];
  const tables: AstNode[] = [];
  let writable = true;
  for (const node of topLevel(first.ast)) {
    if (isUseDeclaration(node)) {
      blanks.push({ start: node.start, end: node.end });
      writable = false;
      problems.push({
        code: 'useInTableFile', severity: 'warning', line: lineAt(text, node.start),
        message: `A table file needs no other file: remove \`${sourceOf(text, node)}\`. ERD Studio will not edit the file until it is gone.`,
      });
      continue;
    }
    const type = elementType(node)?.toLowerCase();
    if (type === 'ref') {
      blanks.push({ start: node.start, end: node.end });
      writable = false;
      problems.push({
        code: 'refInTableFile', severity: 'warning', line: lineAt(text, node.start),
        message: `Relationships live in the folder's _relationships.dbml: move \`${sourceOf(text, node)}\` there. It is not drawn from here, and ERD Studio will not edit the file until it is moved.`,
      });
      continue;
    }
    if (type === 'table') tables.push(node);
    if (type === undefined || !ALLOWED_ELEMENTS.has(type)) {
      const line = lineAt(text, node.start);
      return failure(
        `Line ${line}: a table file holds one Table and no ${elementType(node) ?? 'other'} block; move it out of ${fileStem}.dbml`,
        { rule: 'unsupportedElement', line, column: node.start - lineStartOf(text, node.start) + 1 },
      );
    }
  }
  if (tables.length !== 1) {
    const at = tables[1] ?? undefined;
    const line = at ? lineAt(text, at.start) : undefined;
    return failure(
      tables.length === 0 ? `${fileStem}.dbml declares no Table` : `${fileStem}.dbml declares ${tables.length} Tables; a table file holds exactly one`,
      { rule: 'notOneTable', ...(line !== undefined ? { line } : {}) },
    );
  }
  const tableNode = tables[0];
  const nameParts = plainNames(tableNode.name);
  if (!nameParts || nameParts.length === 0 || nameParts.length > 2) {
    return failure(`${fileStem}.dbml: the Table's name is not a table name`, { rule: 'nameMismatch', line: lineAt(text, tableNode.start) });
  }
  const declaredName = nameParts[nameParts.length - 1];
  if (declaredName.toLowerCase() !== fileStem.toLowerCase()) {
    return failure(
      `${fileStem}.dbml declares Table ${declaredName}; name the Table as its file (or rename the file)`,
      { rule: 'nameMismatch', line: lineAt(text, tableNode.start) },
    );
  }
  const qualifier = nameParts.length === 2 ? nameParts[0] : undefined;
  const declaredReference = nameParts.map(dbmlName).join('.');
  const aliasParts = plainNames(tableNode.alias);
  const dbmlAlias = aliasParts && aliasParts.length === 1 ? aliasParts[0] : undefined;

  // Inline `[ref: …]` settings on columns: blanked, each with the Ref line to write instead.
  const body: AstNode[] = Array.isArray(tableNode.body?.body) ? tableNode.body.body : [];
  for (const field of body) {
    if (field?.kind !== '<function-application>') continue;
    const columnName = plainNames(field.callee)?.[0];
    const args: AstNode[] = Array.isArray(field.args) ? field.args : [];
    const settings = args.length > 0 && args[args.length - 1]?.kind === '<list-expression>' ? args[args.length - 1] : undefined;
    if (!settings || columnName === undefined) continue;
    const elements: AstNode[] = Array.isArray(settings.elementList) ? settings.elementList : [];
    const remove = new Set<number>();
    elements.forEach((attribute, i) => {
      if (attribute?.kind !== '<attribute>' || attributeName(attribute) !== 'ref') return;
      remove.add(i);
      const line = refLineFor(declaredReference, columnName, attribute, text);
      problems.push({
        code: 'inlineRefInTableFile', severity: 'warning', line: lineAt(text, attribute.start),
        message: line
          ? `Move \`${sourceOf(text, attribute)}\` on ${declaredName}.${columnName} to the folder's _relationships.dbml as \`${line}\`, then remove it here. It is not drawn from here, and ERD Studio will not edit the file until it is moved.`
          : `Move \`${sourceOf(text, attribute)}\` on ${declaredName}.${columnName} to the folder's _relationships.dbml as a Ref line, then remove it here.`,
      });
    });
    if (remove.size > 0) {
      blanks.push(...attributeRemovalSpans(settings, remove));
      writable = false;
    }
  }

  let compiled = first;
  if (blanks.length > 0) {
    try {
      compiled = compileOne(blankSpans(text, blanks), parser);
    } catch (err) {
      return failure(`The DBML parser stopped: ${err instanceof Error ? err.message : String(err)}`, { dbmlCode: 1000, line: 1, column: 1 });
    }
  }
  if (compiled.errors.length > 0) {
    const errors = [...compiled.errors].sort((a, b) => a.start - b.start);
    const firstError = errors.find((d) => d.errorClass === 'syntax') ?? errors[0];
    if (firstError.errorClass === 'binding') {
      // A Metadata block whose table or column the file does not declare (D25).
      const block = topLevel(compiled.ast).find((n) => elementType(n)?.toLowerCase() === 'metadata'
        && n.start <= firstError.start && firstError.start < n.end);
      if (block) {
        const kind = String(block.targetKind?.value ?? '').toLowerCase();
        const parts = plainNames(block.name) ?? [];
        const element: 'table' | 'column' = kind === 'column' || (kind === '' && parts.length > 1) ? 'column' : 'table';
        const name = parts.length > 0 ? parts[parts.length - 1] : '';
        const line = lineAt(text, block.start);
        return failure(
          `A Metadata block on line ${line} targets ${element} '${name}', which this table does not have; rename or remove the block`,
          { rule: 'metadataTarget', line, column: block.start - lineStartOf(text, block.start) + 1, target: { element, name } },
        );
      }
    }
    return diagnosticFailure(firstError);
  }

  const db = compiled.rawDb();
  const rawTable = Array.isArray(db?.tables) ? (db!.tables[0] as AstNode | undefined) : undefined;
  if (!rawTable) {
    return failure(`${fileStem}.dbml declares no Table`, { rule: 'notOneTable' });
  }
  const table = mapTable(rawTable, declaredName, qualifier, text, problems);
  return {
    ok: true,
    table,
    declaredName,
    declaredReference,
    ...(dbmlAlias !== undefined ? { alias: dbmlAlias } : {}),
    schemaQualified: qualifier !== undefined,
    writable,
    problems,
  };
}

/** The raw Table as a {@link SemanticTable}, the way `yamlToTable` normalises a model file (§2.2 field mapping). */
function mapTable(raw: AstNode, name: string, qualifier: string | undefined, text: string, problems: DbmlProblem[]): SemanticTable {
  const props = readProperties(raw.metadata, text, `Table ${name}`, problems);
  const table: SemanticTable = { name };
  const schema = props.get(DBML_RICH_TABLE_PROPERTIES.schema) ?? qualifier;
  const alias = props.get(DBML_RICH_TABLE_PROPERTIES.alias)?.trim();
  const description = noteText(raw.note);
  const grain = props.get('grain');
  const role = props.get(DBML_RICH_TABLE_PROPERTIES.role);
  if (schema) table.schema = schema;
  if (alias) table.alias = alias;
  if (description) table.description = description;
  if (grain) table.grain = grain;
  if (role) table.modelRole = role as SemanticTable['modelRole'];

  const rationale: Rationale = {};
  for (const [key, value] of props) {
    const rationaleKey = rationaleKeyOf(key);
    if (rationaleKey && value) rationale[rationaleKey] = value;
  }
  if (Object.keys(rationale).length > 0) table.rationale = rationale;
  const meta = readMetaProperties(props, `Table ${name}`, problems);
  if (meta) table.meta = meta;

  // A composite primary key is an `indexes { (a, b) [pk] }` line.
  const indexPk = new Set<string>();
  for (const index of Array.isArray(raw.indexes) ? raw.indexes : []) {
    if (!index?.pk) continue;
    for (const c of Array.isArray(index.columns) ? index.columns : []) {
      if (c?.type === 'column' && typeof c.value === 'string') indexPk.add(c.value.toLowerCase());
    }
  }

  const columns: ColumnDef[] = [];
  for (const field of Array.isArray(raw.fields) ? raw.fields : []) {
    const fieldName = typeof field?.name === 'string' ? field.name : '';
    const where = `${name}.${fieldName}`;
    const fieldProps = readProperties(field?.metadata, text, where, problems);
    if (fieldName === DBML_RICH_PLACEHOLDER_COLUMN && fieldProps.has(DBML_RICH_PLACEHOLDER_PROPERTY)) continue;
    const column: ColumnDef = {
      name: fieldName,
      dataType: typeof field?.type?.type_name === 'string' ? field.type.type_name : '',
      description: noteText(field?.note),
    };
    if (field?.pk === true || indexPk.has(fieldName.toLowerCase())) column.isPrimaryKey = true;
    if (isTrue(fieldProps.get(DBML_RICH_COLUMN_PROPERTIES.foreignKey))) column.isForeignKey = true;
    if (isTrue(fieldProps.get(DBML_RICH_COLUMN_PROPERTIES.naturalKey))) column.isNaturalKey = true;
    const scd = fieldProps.get(DBML_RICH_COLUMN_PROPERTIES.scdType);
    if (scd !== undefined && scd.trim() !== '') {
      const scdType = Number(scd);
      if (scdType === 0 || scdType === 1 || scdType === 2) column.scdType = scdType;
    }
    const additive = fieldProps.get(DBML_RICH_COLUMN_PROPERTIES.additiveType);
    if (additive !== undefined && ADDITIVE_TYPES.has(additive)) column.additiveType = additive as ColumnDef['additiveType'];
    const columnMeta = readMetaProperties(fieldProps, where, problems);
    if (columnMeta) column.meta = columnMeta;
    columns.push(column);
  }
  table.columns = columns;
  return table;
}

/** The prefix `erd_` property names may carry; re-exported for the writers. */
export const DBML_PROPERTY_PREFIX = DBML_RICH_PROPERTY_PREFIX;

// `nameFragments` is used by the other readers; keep the import list honest here.
void nameFragments;
