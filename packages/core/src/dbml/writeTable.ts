/**
 * The table-file writer (§2.2, §4.5 and §4.5.x of the native DBML storage
 * spec): a new `.dbml` table file from a {@link SemanticTable}, and an edit
 * of an existing one that splices only the nodes whose values change.
 *
 * The edit diffs at the level of the table as the reader reads it (so a
 * value is compared by what it reads as, never by its spelling, and a no-op
 * edit changes nothing) and writes at the level of parser nodes: a setting's
 * value span, a column's line, an attribute list. Everything else in the
 * file — comments, settings ERD Studio does not model, `Enum`s, other
 * index lines, an 11.0 unquoted value nobody asked to change — stays byte
 * for byte. A file the reader cannot read, or reads with a line that must
 * move first, is refused, never rewritten.
 *
 * A property set by a `Metadata Table` / `Metadata Column` block in the
 * same file (D25) is edited in that block, where it takes effect.
 */

import type { ColumnDef, Meta, Rationale, SemanticTable } from '../types/semantic.js';
import {
  DBML_RICH_COLUMN_PROPERTIES,
  DBML_RICH_META_JSON_PROPERTY,
  DBML_RICH_META_PREFIX,
  DBML_RICH_PLACEHOLDER_COLUMN,
  DBML_RICH_PLACEHOLDER_PROPERTY,
  DBML_RICH_TABLE_PROPERTIES,
  DBML_STORAGE_PLACEHOLDER_NOTE,
  bareDbmlProperty,
  rationaleProperty,
} from '../dbmlRichProperties.js';
import { dbmlColumnType, dbmlName, dbmlNoteText, dbmlString } from '../dbmlText.js';
import { readMeta } from '../meta.js';
import { DbmlEditRefused } from './errors.js';
import type { DbmlParserModule } from './parserModule.js';
import {
  PINNED_PARSER,
  attributeName,
  compileOne,
  elementType,
  lineAt,
  lineStartOf,
  plainNames,
  stripBom,
  topLevel,
  type AstNode,
} from './parser.js';
import { parseTableDbml } from './readTable.js';
import {
  applyTextEdits,
  attachedStart,
  cutEdit,
  eolOf,
  indentAt,
  nextLineStart,
  renderListPlan,
  sliceWithEdits,
  startsItsLine,
  type ListPlan,
  type TextEdit,
} from './splice.js';

// ---------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------

/** The rationale keys, in the order a new file writes them (the export's `RATIONALE_LABELS` order). */
const RATIONALE_KEYS: ReadonlyArray<keyof Rationale> = ['purpose', 'design', 'grainChoice', 'roleChoice', 'scdStrategy', 'measures'];

/** A meta key DBML can carry as `meta_<key>`: DBML lower-cases property names, so only lower-case ones read back exactly. */
const META_KEY = /^[a-z_][a-z0-9_]*$/;
const META_JSON_KEY = DBML_RICH_META_JSON_PROPERTY.slice(DBML_RICH_META_PREFIX.length);

/** Whether a meta entry is written as its own `meta_<key>` property (else it goes into `meta_json`). */
function ownMetaProperty(key: string, value: unknown): value is string {
  return typeof value === 'string' && META_KEY.test(key) && key !== META_JSON_KEY;
}

/** A meta map as properties: `meta_<key>` for each text value under a lower-case key, the rest in one `meta_json`. */
function metaSettings(meta: Meta | undefined): string[] {
  const settings: string[] = [];
  const rest: Record<string, unknown> = {};
  let hasRest = false;
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (value === undefined) continue;
    if (ownMetaProperty(key, value)) {
      settings.push(`${DBML_RICH_META_PREFIX}${key}: ${dbmlString(value)}`);
    } else {
      Object.defineProperty(rest, key, { value, enumerable: true, writable: true, configurable: true });
      hasRest = true;
    }
  }
  if (hasRest) settings.push(`${DBML_RICH_META_JSON_PROPERTY}: ${dbmlString(JSON.stringify(rest))}`);
  return settings;
}

/** Text that reads back as `undefined` (the reader drops an empty value) is no value. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** A description as the reader reads it back: the note text, or none when empty. */
function noteValue(value: string | undefined): string | undefined {
  return present(dbmlNoteText(value ?? ''));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    return ak.length === bk.length && ak.every((k) => Object.prototype.hasOwnProperty.call(b, k)
      && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** The table's settings, in the order a new file writes them. */
function tableSettings(table: SemanticTable): string[] {
  const settings: string[] = [];
  if (present(table.schema)) settings.push(`${DBML_RICH_TABLE_PROPERTIES.schema}: ${dbmlString(table.schema!)}`);
  if (present(table.modelRole)) settings.push(`${DBML_RICH_TABLE_PROPERTIES.role}: ${dbmlString(table.modelRole!)}`);
  if (present(table.grain)) settings.push(`${DBML_RICH_TABLE_PROPERTIES.grain}: ${dbmlString(table.grain!)}`);
  if (present(table.alias)) settings.push(`${DBML_RICH_TABLE_PROPERTIES.alias}: ${dbmlString(table.alias!)}`);
  for (const key of RATIONALE_KEYS) {
    const value = present(table.rationale?.[key]);
    if (value !== undefined) settings.push(`${rationaleProperty(key)}: ${dbmlString(value)}`);
  }
  settings.push(...metaSettings(table.meta));
  return settings;
}

/** A column's settings, in the order a new file writes them. */
function columnSettings(column: ColumnDef, isPk: boolean): string[] {
  const settings: string[] = [];
  if (isPk) settings.push('pk');
  const note = noteValue(column.description);
  if (note !== undefined) settings.push(`note: ${dbmlString(note)}`);
  if (column.isNaturalKey) settings.push(`${DBML_RICH_COLUMN_PROPERTIES.naturalKey}: 'true'`);
  if (column.scdType !== undefined && column.scdType !== null) settings.push(`${DBML_RICH_COLUMN_PROPERTIES.scdType}: ${dbmlString(String(column.scdType))}`);
  if (column.additiveType) settings.push(`${DBML_RICH_COLUMN_PROPERTIES.additiveType}: ${dbmlString(column.additiveType)}`);
  if (column.isForeignKey) settings.push(`${DBML_RICH_COLUMN_PROPERTIES.foreignKey}: 'true'`);
  settings.push(...metaSettings(column.meta));
  return settings;
}

function bracket(settings: readonly string[]): string {
  return settings.length > 0 ? ` [${settings.join(', ')}]` : '';
}

function columnLine(column: ColumnDef, isPk: boolean): string {
  return `${dbmlName(column.name)} ${dbmlColumnType(column.dataType ?? '')}${bracket(columnSettings(column, isPk))}`;
}

const PLACEHOLDER_LINE = `${DBML_RICH_PLACEHOLDER_COLUMN} unknown [${DBML_RICH_PLACEHOLDER_PROPERTY}: 'true', note: ${dbmlString(DBML_STORAGE_PLACEHOLDER_NOTE)}]`;

/**
 * A new table file (§2.2 layout): one Table named exactly as `table.name`,
 * settings inline when there is one and one per line otherwise, one column
 * per line, an `indexes` block only for a composite primary key, the `Note`
 * last, two-space indents and `\n` line endings. A table with no columns
 * gets the placeholder column DBML needs. Relationships are not written:
 * they live in the folder's relationships file.
 */
export function renderNewTableDbml(table: SemanticTable): string {
  const lines: string[] = [];
  const settings = tableSettings(table);
  if (settings.length <= 1) {
    lines.push(`Table ${dbmlName(table.name)}${bracket(settings)} {`);
  } else {
    lines.push(`Table ${dbmlName(table.name)} [`, ...settings.map((s, i) => `  ${s}${i < settings.length - 1 ? ',' : ''}`), '] {');
  }
  const columns = table.columns ?? [];
  if (columns.length === 0) lines.push(`  ${PLACEHOLDER_LINE}`);
  const pks = columns.filter((c) => c.isPrimaryKey);
  for (const column of columns) lines.push(`  ${columnLine(column, pks.length === 1 && column.isPrimaryKey === true)}`);
  if (pks.length > 1) lines.push('  indexes {', `    (${pks.map((c) => dbmlName(c.name)).join(', ')}) [pk]`, '  }');
  const description = noteValue(table.description);
  if (description !== undefined) lines.push(`  Note: ${dbmlString(description)}`);
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// The edit
// ---------------------------------------------------------------------------

/** A Metadata block in another file that sets a property of this table (D25): the edit refuses to change that property. */
export interface ForeignDbmlMetadata {
  /** The file holding the block, as the caller names it. */
  file: string;
  line: number;
  /** The column the block targets, or undefined for `Metadata Table`. */
  column?: string;
  /** The property it sets, as written (`grain`, `note`, `erd_role`, …). */
  property: string;
}

/** Options for {@link editTableDbml}. */
export interface EditTableDbmlOptions {
  /** The edit renames the table (its name changes on purpose); the name is spliced either way. */
  rename?: boolean;
  /** The file, as messages name it (default `<stem>.dbml`). */
  file?: string;
  /** The file's stem now (before a rename). Default: the declared name. */
  fileStem?: string;
  /** Metadata blocks in other files that target this table (D25). */
  foreignMetadata?: readonly ForeignDbmlMetadata[];
  /** The DBML parser; the pinned one unless a test passes another. */
  parser?: DbmlParserModule;
}

/** Where a property is set. */
interface Setter {
  /** The property's bare, lower-case name (`erd_` removed). */
  key: string;
  prefixed: boolean;
  where: 'inline' | 'block' | 'body';
  /** The attribute, block entry or body `Note` element. */
  node: AstNode;
  /** The node whose span is the value text. */
  value: AstNode | undefined;
  /** For an inline attribute: its list and its index there. */
  list?: AstNode;
  index?: number;
}

const TABLE_KEY_ORDER: readonly string[] = [
  'schema', 'role', 'grain', 'alias',
  ...RATIONALE_KEYS.map((k) => rationaleProperty(k)),
];
const COLUMN_KEY_ORDER: readonly string[] = [
  'pk', 'note', DBML_RICH_COLUMN_PROPERTIES.naturalKey, DBML_RICH_COLUMN_PROPERTIES.scdType,
  DBML_RICH_COLUMN_PROPERTIES.additiveType, DBML_RICH_COLUMN_PROPERTIES.foreignKey,
];

function keyOrder(order: readonly string[], key: string): number {
  const at = order.indexOf(key);
  if (at >= 0) return at;
  if (key === DBML_RICH_META_JSON_PROPERTY) return 1001;
  if (key.startsWith(DBML_RICH_META_PREFIX)) return 1000;
  return 999;
}

/** The leaf names of a dotted name, as nodes (`gold.x.c` → the `gold`, `x` and `c` nodes). */
function nameLeaves(expr: AstNode | undefined): AstNode[] {
  if (!expr || typeof expr !== 'object') return [];
  if (expr.kind === '<primary-expression>') return [expr];
  if (expr.kind === '<infix-expression>' && expr.op?.value === '.') return [...nameLeaves(expr.leftExpression), ...nameLeaves(expr.rightExpression)];
  return [];
}

/** The string a literal value node holds (`'x'`, `'''x'''`), or undefined. */
function literalString(node: AstNode | undefined): string | undefined {
  let n = node;
  if (n?.kind === '<function-application>') n = n.callee;
  if (n?.kind === '<primary-expression>') n = n.expression;
  if (n?.kind === '<literal>' && typeof n.literal?.value === 'string') return n.literal.value as string;
  return undefined;
}

/** The value node of a body `Note: …` / `Note { … }` element. */
function noteElementValue(node: AstNode): AstNode | undefined {
  const body = node.body;
  if (body?.kind === '<function-application>') return body;
  if (body?.kind === '<block-expression>' && Array.isArray(body.body)) {
    return (body.body as AstNode[]).find((n) => n?.kind === '<function-application>');
  }
  return undefined;
}

/** A column node of a Table body: a field line with a name. */
interface ColumnNode {
  node: AstNode;
  name: string;
  settings: AstNode | undefined;
  type: AstNode | undefined;
  placeholder: boolean;
}

function columnNodesOf(tableNode: AstNode): ColumnNode[] {
  const body: AstNode[] = Array.isArray(tableNode.body?.body) ? tableNode.body.body : [];
  const columns: ColumnNode[] = [];
  for (const node of body) {
    if (node?.kind !== '<function-application>') continue;
    const name = plainNames(node.callee)?.[0];
    if (name === undefined) continue;
    const args: AstNode[] = Array.isArray(node.args) ? node.args : [];
    const settings = args.length > 0 && args[args.length - 1]?.kind === '<list-expression>' ? args[args.length - 1] : undefined;
    const type = args.length > 0 && args[0]?.kind !== '<list-expression>' ? args[0] : undefined;
    const elements: AstNode[] = Array.isArray(settings?.elementList) ? settings.elementList : [];
    const placeholder = name === DBML_RICH_PLACEHOLDER_COLUMN
      && elements.some((a) => attributeName(a) === DBML_RICH_PLACEHOLDER_PROPERTY);
    columns.push({ node, name, settings, type, placeholder });
  }
  return columns;
}

/** Whether an attribute is a primary-key flag. */
function isPkAttribute(attribute: AstNode): boolean {
  const name = attributeName(attribute);
  return name === 'pk' || name === 'primary key';
}

/** An `indexes` line: its node, the columns it names, and whether it is the primary key. */
interface IndexLine {
  node: AstNode;
  block: AstNode;
  /** The column-name leaves (`a` or the elements of `(a, b)`); empty for an expression index. */
  columns: AstNode[];
  pk: boolean;
}

function indexLinesOf(tableNode: AstNode): { blocks: AstNode[]; lines: IndexLine[] } {
  const body: AstNode[] = Array.isArray(tableNode.body?.body) ? tableNode.body.body : [];
  const blocks = body.filter((n) => elementType(n)?.toLowerCase() === 'indexes');
  const lines: IndexLine[] = [];
  for (const block of blocks) {
    for (const node of Array.isArray(block.body?.body) ? (block.body.body as AstNode[]) : []) {
      if (node?.kind !== '<function-application>') continue;
      const callee = node.callee;
      const columns: AstNode[] = [];
      if (callee?.kind === '<tuple-expression>') {
        for (const element of Array.isArray(callee.elementList) ? callee.elementList : []) {
          if (element?.kind === '<primary-expression>' && element.expression?.kind === '<variable>') columns.push(element);
        }
      } else if (callee?.kind === '<primary-expression>' && callee.expression?.kind === '<variable>') {
        columns.push(callee);
      }
      const args: AstNode[] = Array.isArray(node.args) ? node.args : [];
      const settings = args.find((a) => a?.kind === '<list-expression>');
      const pk = Array.isArray(settings?.elementList) && (settings.elementList as AstNode[]).some(isPkAttribute);
      lines.push({ node, block, columns, pk });
    }
  }
  return { blocks, lines };
}

/** The variable name a leaf node spells. */
function leafName(leaf: AstNode): string {
  const v = leaf?.expression?.variable?.value;
  return typeof v === 'string' ? v : '';
}

function refuse(file: string, message: string, line?: number): never {
  throw new DbmlEditRefused(file, message, line);
}

/**
 * Edit an existing table file so it reads as `desired` (§4.5), splicing
 * only what changes. Laws 1–5 hold: `editTableDbml(t, read(t))` is `t`
 * byte for byte; the edit is idempotent; the result reads back as
 * `desired`; bytes outside changed nodes are kept; and a file that parsed
 * in 9.1.1, 10.3.1 and 11.0.0 still does. A leading byte-order mark is kept.
 *
 * Throws {@link DbmlEditRefused} for a file the reader cannot read or will
 * not let ERD Studio edit (a `use`, `Ref` or inline `ref:` line to move
 * first), a schema change on a schema-qualified name (`Table gold.x`), and a
 * change to a property another file's Metadata block sets.
 */
export function editTableDbml(oldText: string, desired: SemanticTable, options: EditTableDbmlOptions = {}): string {
  const parser = options.parser ?? PINNED_PARSER;
  const hadBom = oldText.charCodeAt(0) === 0xfeff;
  const text = stripBom(oldText);
  const compiled = compileOne(text, parser);
  const tableNodes = topLevel(compiled.ast).filter((n) => elementType(n)?.toLowerCase() === 'table');
  const declared = tableNodes.length > 0 ? plainNames(tableNodes[0].name) : null;
  const stem = options.fileStem ?? (declared && declared.length > 0 ? declared[declared.length - 1] : desired.name);
  const file = options.file ?? `${stem}.dbml`;

  const reading = parseTableDbml(text, stem, parser);
  if (!reading.ok) {
    const line = reading.error.line;
    const where = line !== undefined && !/^line \d/i.test(reading.error.message) ? `line ${line}: ` : '';
    refuse(file, `Fix the DBML in ${file} first (${where}${reading.error.message.replace(/\.$/, '')}). ERD Studio never rewrites a file it cannot read.`, line);
  }
  if (!reading.writable) {
    const problem = reading.problems.find((p) => p.code === 'useInTableFile' || p.code === 'refInTableFile' || p.code === 'inlineRefInTableFile');
    refuse(file, `${file}: ${problem?.message ?? 'move the use, Ref or ref: lines out of the table file first.'}`, problem?.line);
  }
  const tableNode = tableNodes[0];
  const current = reading.table;
  const eol = eolOf(text);
  const edits: TextEdit[] = [];
  const plans = new Map<AstNode | string, ListPlan>();
  const removedNodes = new Set<AstNode>();

  // --- Columns as the file holds them, aligned with the reading -----------
  const allColumnNodes = columnNodesOf(tableNode);
  const columnNodes = allColumnNodes.filter((c) => !c.placeholder);
  const currentColumns = current.columns ?? [];
  if (columnNodes.length !== currentColumns.length
    || columnNodes.some((c, i) => c.name.toLowerCase() !== currentColumns[i].name.toLowerCase())) {
    refuse(file, `ERD Studio could not line up the columns of ${file} with what it read; edit the file by hand.`);
  }
  const indentUnit = allColumnNodes.length > 0 ? indentAt(text, allColumnNodes[0].node.start) || '  ' : '  ';

  // --- Metadata blocks in this file (D25) ---------------------------------
  const tableName = current.name.toLowerCase();
  const metadataBlocks = topLevel(compiled.ast).filter((n) => elementType(n)?.toLowerCase() === 'metadata');
  interface Block { node: AstNode; kind: 'table' | 'column'; column?: string; leaves: AstNode[] }
  const blocks: Block[] = [];
  for (const node of metadataBlocks) {
    const leaves = nameLeaves(node.name);
    const kind = String(node.targetKind?.value ?? '').toLowerCase() === 'column' ? 'column' : 'table';
    const names = leaves.map(leafName);
    if (kind === 'table') {
      if (names.length > 0 && names[names.length - 1].toLowerCase() === tableName) blocks.push({ node, kind, leaves });
    } else if (names.length >= 2 && names[names.length - 2].toLowerCase() === tableName) {
      blocks.push({ node, kind, column: names[names.length - 1], leaves });
    }
  }
  const blockEntries = (block: Block): AstNode[] =>
    (Array.isArray(block.node.body?.body) ? (block.node.body.body as AstNode[]) : []).filter((n) => n?.kind === '<element-declaration>');

  const settersFrom = (list: AstNode | undefined, owner: { column?: string }): Setter[] => {
    const out: Setter[] = [];
    const elements: AstNode[] = Array.isArray(list?.elementList) ? list!.elementList : [];
    elements.forEach((attribute, index) => {
      if (attribute?.kind !== '<attribute>') return;
      const raw = attributeName(attribute);
      out.push({ key: bareDbmlProperty(raw), prefixed: bareDbmlProperty(raw) !== raw, where: 'inline', node: attribute, value: attribute.value, list, index });
    });
    for (const block of blocks) {
      if (owner.column === undefined ? block.kind !== 'table' : block.kind !== 'column' || block.column!.toLowerCase() !== owner.column.toLowerCase()) continue;
      for (const entry of blockEntries(block)) {
        const raw = String(entry.type?.value ?? '').toLowerCase();
        out.push({ key: bareDbmlProperty(raw), prefixed: bareDbmlProperty(raw) !== raw, where: 'block', node: entry, value: entry.body });
      }
    }
    return out;
  };

  const tableSetters = settersFrom(tableNode.attributeList, {});
  for (const node of Array.isArray(tableNode.body?.body) ? (tableNode.body.body as AstNode[]) : []) {
    if (elementType(node)?.toLowerCase() === 'note') {
      tableSetters.push({ key: 'note', prefixed: false, where: 'body', node, value: noteElementValue(node) });
    }
  }

  const planFor = (list: AstNode | undefined, ownerKey: AstNode | string, anchor: number, multiLineWhenNew: boolean): ListPlan => {
    const key = list ?? ownerKey;
    let plan = plans.get(key);
    if (!plan) {
      const count = Array.isArray(list?.elementList) ? list!.elementList.length : 0;
      plan = { list: list ?? null, anchor, elements: new Array(count).fill(undefined), added: [], multiLineWhenNew };
      plans.set(key, plan);
    }
    return plan;
  };

  /** Refuse to change a property a Metadata block in another file sets (D25): the edit would not stick there. */
  const checkForeign = (property: string, column?: string): void => {
    const blocked = (options.foreignMetadata ?? []).find((m) => bareDbmlProperty(m.property.toLowerCase()) === property
      && (column === undefined ? m.column === undefined : m.column !== undefined && m.column.toLowerCase() === column.toLowerCase()));
    if (blocked) {
      refuse(file, `${property} is set by a Metadata block in ${blocked.file}:${blocked.line}; edit it there.`, blocked.line);
    }
  };

  const effective = (setters: readonly Setter[]): Setter | undefined => {
    if (setters.length === 0) return undefined;
    const pool = setters.some((s) => s.prefixed) ? setters.filter((s) => s.prefixed) : [...setters];
    const byWhere = (where: Setter['where']): Setter[] => pool.filter((s) => s.where === where);
    const pick = byWhere('block').length > 0 ? byWhere('block') : byWhere('body').length > 0 ? byWhere('body') : pool;
    return pick[pick.length - 1];
  };

  const setValue = (setter: Setter, valueText: string): void => {
    if (!setter.value) return;
    if (setter.where === 'inline') {
      const plan = planFor(setter.list, setter.list!, 0, false);
      const attribute = setter.node;
      plan.elements[setter.index!] = text.slice(attribute.start, setter.value.start) + valueText + text.slice(setter.value.end, attribute.end);
    } else {
      edits.push({ start: setter.value.start, end: setter.value.end, text: valueText });
    }
  };

  const removeSetter = (setter: Setter): void => {
    if (setter.where === 'inline') {
      planFor(setter.list, setter.list!, 0, false).elements[setter.index!] = null;
    } else if (!removedNodes.has(setter.node)) {
      removedNodes.add(setter.node);
      edits.push(cutEdit(text, setter.node));
    }
  };

  /**
   * Set (or clear, with `undefined`) one property of the table or a column:
   * the effective setter's value is spliced; a cleared property loses every
   * setter, so nothing resurfaces; a new one is appended to the inline list.
   */
  const setProperty = (
    setters: readonly Setter[],
    key: string,
    valueText: string | undefined,
    owner: { column?: string; list: AstNode | undefined; ownerKey: AstNode | string; anchor: number; multiLine: boolean; order: readonly string[] },
    addText?: string,
  ): void => {
    const mine = setters.filter((s) => s.key === key);
    checkForeign(key, owner.column);
    if (valueText === undefined) {
      for (const setter of mine) removeSetter(setter);
      return;
    }
    const target = effective(mine);
    if (target && target.value) {
      setValue(target, valueText);
      return;
    }
    planFor(owner.list, owner.ownerKey, owner.anchor, owner.multiLine).added.push({
      order: keyOrder(owner.order, key),
      text: addText ?? `${key}: ${valueText}`,
    });
  };

  const tableOwner = {
    list: tableNode.attributeList as AstNode | undefined,
    ownerKey: 'table',
    anchor: tableNode.body.start as number,
    multiLine: true,
    order: TABLE_KEY_ORDER,
  };

  // --- Table name ----------------------------------------------------------
  if (desired.name !== reading.declaredName) {
    const leaves = nameLeaves(tableNode.name);
    const last = leaves[leaves.length - 1];
    if (last) edits.push({ start: last.start, end: last.end, text: dbmlName(desired.name) });
    for (const block of blocks) {
      const leaf = block.kind === 'table' ? block.leaves[block.leaves.length - 1] : block.leaves[block.leaves.length - 2];
      if (leaf) edits.push({ start: leaf.start, end: leaf.end, text: dbmlName(desired.name) });
    }
  }

  // --- Table properties ------------------------------------------------------
  const desiredSchema = present(desired.schema);
  if (desiredSchema !== present(current.schema)) {
    const schemaSetters = tableSetters.filter((s) => s.key === DBML_RICH_TABLE_PROPERTIES.schema);
    if (reading.schemaQualified && (desiredSchema === undefined || schemaSetters.length === 0)) {
      const qualifier = declared && declared.length > 1 ? declared.slice(0, -1).join('.') : 'gold';
      refuse(
        file,
        `${file} names its schema in the Table name (\`Table ${reading.declaredReference}\`). Change it there, or remove the qualifier and use \`[schema: '${qualifier}']\`.`,
        lineAt(text, tableNode.start),
      );
    }
    setProperty(tableSetters, DBML_RICH_TABLE_PROPERTIES.schema, desiredSchema === undefined ? undefined : dbmlString(desiredSchema), tableOwner);
  }
  const simple: Array<[string, string | undefined, string | undefined]> = [
    [DBML_RICH_TABLE_PROPERTIES.role, present(desired.modelRole), present(current.modelRole)],
    [DBML_RICH_TABLE_PROPERTIES.grain, present(desired.grain), present(current.grain)],
    [DBML_RICH_TABLE_PROPERTIES.alias, present(desired.alias?.trim()), present(current.alias)],
    ...RATIONALE_KEYS.map((k): [string, string | undefined, string | undefined] => [rationaleProperty(k), present(desired.rationale?.[k]), present(current.rationale?.[k])]),
  ];
  for (const [key, want, have] of simple) {
    if (want === have) continue;
    setProperty(tableSetters, key, want === undefined ? undefined : dbmlString(want), tableOwner);
  }
  planMeta(tableSetters, current.meta, desired.meta, tableOwner, undefined);

  // Description: the effective `note` (a block's, else the body Note, else the header setting).
  const wantDescription = noteValue(desired.description);
  if (wantDescription !== noteValue(current.description)) {
    const mine = tableSetters.filter((s) => s.key === 'note');
    checkForeign('note');
    if (wantDescription === undefined) {
      for (const setter of mine) removeSetter(setter);
    } else {
      const target = effective(mine);
      if (target?.value) {
        setValue(target, dbmlString(wantDescription));
      } else {
        // A new body Note, the last line of the body.
        const close = tableNode.body.blockCloseBrace as AstNode;
        const at = startsItsLine(text, close.start) ? lineStartOf(text, close.start) : close.start;
        const prefix = at === 0 || text[at - 1] === '\n' ? '' : eol;
        edits.push({ start: at, end: at, text: `${prefix}${indentUnit}Note: ${dbmlString(wantDescription)}${eol}` });
      }
    }
  }

  // --- Columns -------------------------------------------------------------
  const desiredColumns = desired.columns ?? [];
  const matchOf = new Map<number, number>(); // desired index → current index
  const used = new Set<number>();
  desiredColumns.forEach((d, di) => {
    const ci = currentColumns.findIndex((c, i) => !used.has(i) && c.name === d.name);
    if (ci >= 0) { matchOf.set(di, ci); used.add(ci); }
  });
  desiredColumns.forEach((d, di) => {
    if (matchOf.has(di)) return;
    const ci = currentColumns.findIndex((c, i) => !used.has(i) && c.name.toLowerCase() === d.name.toLowerCase());
    if (ci >= 0) { matchOf.set(di, ci); used.add(ci); }
  });
  {
    const removed = currentColumns.map((_, i) => i).filter((i) => !used.has(i));
    const added = desiredColumns.map((_, i) => i).filter((i) => !matchOf.has(i));
    if (removed.length === 1 && added.length === 1 && removed[0] === added[0]) {
      matchOf.set(added[0], removed[0]);
      used.add(removed[0]);
    }
  }
  const currentOf = new Map<number, number>(); // current index → desired index
  for (const [di, ci] of matchOf) currentOf.set(ci, di);
  const renamedColumns = new Map<string, string>(); // current real spelling → desired spelling
  for (const [di, ci] of matchOf) {
    if (desiredColumns[di].name !== currentColumns[ci].name) renamedColumns.set(currentColumns[ci].name, desiredColumns[di].name);
  }

  // Primary key: touched only when the set changes (§4.5).
  const currentPk = new Set<string>();
  currentColumns.forEach((c, ci) => {
    if (!c.isPrimaryKey) return;
    const di = currentOf.get(ci);
    currentPk.add(di === undefined ? `\u0000removed:${ci}` : desiredColumns[di].name.toLowerCase());
  });
  const desiredPkColumns = desiredColumns.filter((c) => c.isPrimaryKey);
  const desiredPk = new Set(desiredPkColumns.map((c) => c.name.toLowerCase()));
  const pkChanged = currentPk.size !== desiredPk.size || [...desiredPk].some((n) => !currentPk.has(n));
  const singlePk = desiredPkColumns.length === 1 ? desiredPkColumns[0].name.toLowerCase() : undefined;

  const removedColumnNames = new Set(currentColumns.filter((_, i) => !used.has(i)).map((c) => c.name));
  const columnEdits = new Map<number, TextEdit[]>(); // current index → edits inside the column node

  matchOf.forEach((ci, di) => {
    const want = desiredColumns[di];
    const have = currentColumns[ci];
    const node = columnNodes[ci];
    const own: TextEdit[] = [];
    if (want.name !== have.name) {
      own.push({ start: node.node.callee.start, end: node.node.callee.end, text: dbmlName(want.name) });
      for (const block of blocks) {
        if (block.kind === 'column' && block.column!.toLowerCase() === have.name.toLowerCase()) {
          const leaf = block.leaves[block.leaves.length - 1];
          edits.push({ start: leaf.start, end: leaf.end, text: dbmlName(want.name) });
        }
      }
    }
    if ((want.dataType ?? '') !== (have.dataType ?? '')) {
      if (node.type) {
        own.push({ start: node.type.start, end: node.type.end, text: dbmlColumnType(want.dataType ?? '') });
      } else {
        own.push({ start: node.node.callee.end, end: node.node.callee.end, text: ` ${dbmlColumnType(want.dataType ?? '')}` });
      }
    }
    columnEdits.set(ci, own);
    const setters = settersFrom(node.settings, { column: have.name });
    const anchor = node.type ? node.type.end : node.node.callee.end;
    const owner = { column: have.name, list: node.settings, ownerKey: node.node, anchor, multiLine: false, order: COLUMN_KEY_ORDER };

    if (pkChanged) {
      const isPk = singlePk !== undefined && want.name.toLowerCase() === singlePk;
      const flags = setters.filter((s) => s.where === 'inline' && isPkAttribute(s.node));
      if (isPk && flags.length === 0) {
        planFor(owner.list, owner.ownerKey, owner.anchor, false).added.push({ order: keyOrder(COLUMN_KEY_ORDER, 'pk'), text: 'pk' });
      } else if (!isPk) {
        for (const flag of flags) removeSetter(flag);
      } else {
        for (const flag of flags.slice(1)) removeSetter(flag);
      }
    }
    const wantNote = noteValue(want.description);
    if (wantNote !== noteValue(have.description)) {
      setProperty(setters, 'note', wantNote === undefined ? undefined : dbmlString(wantNote), owner);
    }
    const flag = (key: string, w: boolean | undefined, h: boolean | undefined): void => {
      if (!!w === !!h) return;
      setProperty(setters, key, w ? "'true'" : undefined, owner);
    };
    flag(DBML_RICH_COLUMN_PROPERTIES.naturalKey, want.isNaturalKey, have.isNaturalKey);
    flag(DBML_RICH_COLUMN_PROPERTIES.foreignKey, want.isForeignKey, have.isForeignKey);
    const wantScd = want.scdType === 0 || want.scdType === 1 || want.scdType === 2 ? want.scdType : undefined;
    if (wantScd !== have.scdType) {
      setProperty(setters, DBML_RICH_COLUMN_PROPERTIES.scdType, wantScd === undefined ? undefined : dbmlString(String(wantScd)), owner);
    }
    const wantAdditive = present(want.additiveType);
    if (wantAdditive !== present(have.additiveType)) {
      setProperty(setters, DBML_RICH_COLUMN_PROPERTIES.additiveType, wantAdditive === undefined ? undefined : dbmlString(wantAdditive), owner);
    }
    planMeta(setters, have.meta, want.meta, owner, have.name);
  });

  // Metadata Column blocks of removed columns go with them.
  for (const block of blocks) {
    if (block.kind === 'column' && [...removedColumnNames].some((n) => n.toLowerCase() === block.column!.toLowerCase())) {
      removedNodes.add(block.node);
      edits.push(cutEdit(text, block.node));
    }
  }

  // Index lines: the primary key when its set changed, renamed columns, and lines naming a removed column.
  const { blocks: indexBlocks, lines: indexLines } = indexLinesOf(tableNode);
  const cutIndexLines = new Set<AstNode>();
  const indexEdits: TextEdit[] = [];
  const lateEdits: TextEdit[] = [];
  let pkLineWritten = false;
  const pkTuple = `(${desiredPkColumns.map((c) => dbmlName(c.name)).join(', ')}) [pk]`;
  for (const line of indexLines) {
    if (line.pk && pkChanged) {
      if (desiredPkColumns.length >= 2 && !pkLineWritten) {
        indexEdits.push({ start: line.node.start, end: line.node.end, text: pkTuple });
        pkLineWritten = true;
      } else {
        cutIndexLines.add(line.node);
      }
      continue;
    }
    if (line.columns.map(leafName).some((n) => removedColumnNames.has(n))) {
      cutIndexLines.add(line.node);
      continue;
    }
    for (const leaf of line.columns) {
      const to = renamedColumns.get(leafName(leaf));
      if (to !== undefined) indexEdits.push({ start: leaf.start, end: leaf.end, text: dbmlName(to) });
    }
  }
  let pkBlock: AstNode | undefined;
  if (pkChanged && desiredPkColumns.length >= 2 && !pkLineWritten) {
    pkBlock = indexBlocks[0];
    if (pkBlock) {
      const close = pkBlock.body.blockCloseBrace as AstNode;
      const existing = indexLines.find((l) => l.block === pkBlock && !cutIndexLines.has(l.node));
      const indent = existing ? indentAt(text, existing.node.start) : indentAt(text, pkBlock.start) + indentUnit;
      const alone = startsItsLine(text, close.start);
      const at = alone ? lineStartOf(text, close.start) : close.start;
      indexEdits.push({ start: at, end: at, text: `${alone ? '' : eol}${indent}${pkTuple}${eol}` });
    } else {
      const body: AstNode[] = Array.isArray(tableNode.body?.body) ? tableNode.body.body : [];
      const note = body.find((n) => elementType(n)?.toLowerCase() === 'note');
      const close = tableNode.body.blockCloseBrace as AstNode;
      const at = note ? attachedStart(text, note) : startsItsLine(text, close.start) ? lineStartOf(text, close.start) : close.start;
      const prefix = at === 0 || text[at - 1] === '\n' ? '' : eol;
      // Pushed last, so a new column inserted at the same place comes before it.
      lateEdits.push({ start: at, end: at, text: `${prefix}${indentUnit}indexes {${eol}${indentUnit}${indentUnit}${pkTuple}${eol}${indentUnit}}${eol}` });
    }
  }
  for (const block of indexBlocks) {
    const lines = indexLines.filter((l) => l.block === block);
    const others = (Array.isArray(block.body?.body) ? (block.body.body as AstNode[]) : []).filter((n) => n?.kind !== '<function-application>');
    const emptied = block !== pkBlock && lines.length > 0 && lines.every((l) => cutIndexLines.has(l.node)) && others.length === 0;
    if (emptied) {
      edits.push(cutEdit(text, block));
      continue;
    }
    for (const l of lines) if (cutIndexLines.has(l.node)) edits.push(cutEdit(text, l.node));
  }
  for (const e of indexEdits) {
    const inCutBlock = indexBlocks.some((b) => b !== pkBlock && e.start >= b.start && e.end <= b.end
      && indexLines.filter((l) => l.block === b).every((l) => cutIndexLines.has(l.node)));
    if (!inCutBlock) edits.push(e);
  }

  // --- Render the column changes -------------------------------------------
  // Settings lists first, so a column's block holds all of its own edits.
  const listEditsByOwner = new Map<AstNode | string, TextEdit[]>();
  for (const [key, plan] of plans) {
    listEditsByOwner.set(key, renderListPlan(text, plan, eol));
  }
  const columnOwnEdits = (ci: number): TextEdit[] => {
    const node = columnNodes[ci];
    return [
      ...(columnEdits.get(ci) ?? []),
      ...(node.settings ? listEditsByOwner.get(node.settings) ?? [] : []),
      ...(listEditsByOwner.get(node.node) ?? []),
    ];
  };
  for (const [key, list] of listEditsByOwner) {
    const isColumn = columnNodes.some((c) => c.node === key || (c.settings !== undefined && c.settings === key));
    if (!isColumn) edits.push(...list);
  }

  const placeholderNodes = allColumnNodes.filter((c) => c.placeholder);
  const newLine = (d: number): string =>
    `${indentUnit}${columnLine(desiredColumns[d], singlePk !== undefined && desiredColumns[d].name.toLowerCase() === singlePk)}`;

  const matchedInDesiredOrder = desiredColumns.map((_, di) => matchOf.get(di)).filter((ci): ci is number => ci !== undefined);
  const reordered = matchedInDesiredOrder.some((ci, i) => i > 0 && ci < matchedInDesiredOrder[i - 1]);

  if (!reordered) {
    for (const [ci] of columnNodes.entries()) {
      if (used.has(ci)) edits.push(...columnOwnEdits(ci));
      else edits.push(cutEdit(text, columnNodes[ci].node));
    }
    if (desiredColumns.length > 0) {
      for (const p of placeholderNodes) edits.push(cutEdit(text, p.node));
    }
    // New columns go after the line of the previous desired column; the first before the first kept column.
    const firstKept = columnNodes.find((_, ci) => used.has(ci));
    const brace = tableNode.body.blockOpenBrace as AstNode;
    const afterBrace = (): number => {
      const end = nextLineStart(text, brace.end);
      return /^[ \t]*(\/\/[^\n]*)?\r?\n?$/.test(text.slice(brace.end, end)) ? end : brace.end;
    };
    let anchor: number = firstKept ? attachedStart(text, firstKept.node, afterBrace()) : (placeholderNodes[0] ? attachedStart(text, placeholderNodes[0].node, afterBrace()) : afterBrace());
    desiredColumns.forEach((_, di) => {
      const ci = matchOf.get(di);
      if (ci !== undefined) {
        anchor = columnNodes[ci].node.fullEnd;
        return;
      }
      const needsBreak = anchor > 0 && text[anchor - 1] !== '\n';
      edits.push({ start: anchor, end: anchor, text: `${needsBreak ? eol : ''}${newLine(di)}${eol}` });
    });
    if (desiredColumns.length === 0 && placeholderNodes.length === 0) {
      const at = firstKept ? firstKept.node.start : afterBrace();
      const needsBreak = at > 0 && text[at - 1] !== '\n';
      edits.push({ start: at, end: at, text: `${needsBreak ? eol : ''}${indentUnit}${PLACEHOLDER_LINE}${eol}` });
    }
  } else {
    // Rebuild the column region: each block (its lines and the comment lines above it) in the desired order.
    const floor = (tableNode.body.blockOpenBrace as AstNode).end as number;
    const blockOf = (node: AstNode): { start: number; end: number } => ({
      start: Math.max(lineStartOf(text, node.fullStart), floor),
      end: node.fullEnd,
    });
    const regionNodes = allColumnNodes.map((c) => c.node);
    const regionStart = Math.min(...regionNodes.map((n) => blockOf(n).start));
    const regionEnd = Math.max(...regionNodes.map((n) => blockOf(n).end));
    const body: AstNode[] = Array.isArray(tableNode.body?.body) ? tableNode.body.body : [];
    const strays = body.filter((n) => n?.kind !== '<function-application>' && n.start >= regionStart && n.end <= regionEnd);
    const withEol = (s: string): string => (s.endsWith('\n') ? s : s + eol);
    const pieces: string[] = [];
    desiredColumns.forEach((_, di) => {
      const ci = matchOf.get(di);
      if (ci === undefined) {
        pieces.push(`${newLine(di)}${eol}`);
        return;
      }
      const span = blockOf(columnNodes[ci].node);
      pieces.push(withEol(sliceWithEdits(text, columnOwnEdits(ci), span.start, span.end)));
    });
    // A removed column's block loses its own lines, never the comment lines above them (the cut rule).
    columnNodes.forEach((c, ci) => {
      if (used.has(ci)) return;
      const span = blockOf(c.node);
      const above = text.slice(span.start, Math.max(span.start, lineStartOf(text, c.node.start)));
      if (/\/\//.test(above)) pieces.push(withEol(above.replace(/^(?:[ \t]*\r?\n)+/, '')));
    });
    for (const stray of strays) {
      const span = blockOf(stray);
      pieces.push(withEol(text.slice(span.start, span.end)));
      // Edits inside a stray (an indexes line, the Note) are applied to it here.
      const inside = edits.filter((e) => e.start >= span.start && e.end <= span.end);
      if (inside.length > 0) {
        pieces[pieces.length - 1] = withEol(sliceWithEdits(text, inside, span.start, span.end));
        for (const e of inside) edits.splice(edits.indexOf(e), 1);
      }
    }
    let region = pieces.join('');
    if (!text.slice(regionStart, regionEnd).endsWith('\n') && region.endsWith(eol)) region = region.slice(0, -eol.length);
    edits.push({ start: regionStart, end: regionEnd, text: region });
  }

  const out = applyTextEdits(text, [...edits, ...lateEdits]);
  return hadBom ? `﻿${out}` : out;

  /** Meta for the table or one column: only the entries whose value changed are touched (§4.5). */
  function planMeta(
    setters: readonly Setter[],
    haveRaw: Meta | undefined,
    wantRaw: Meta | undefined,
    owner: { column?: string; list: AstNode | undefined; ownerKey: AstNode | string; anchor: number; multiLine: boolean; order: readonly string[] },
    column: string | undefined,
  ): void {
    const have = haveRaw ?? {};
    const want = readMeta(wantRaw) ?? {};
    if (deepEqual(have, want)) return;
    const attrs = new Map<string, Setter[]>();
    for (const s of setters) {
      if (!s.key.startsWith(DBML_RICH_META_PREFIX) || s.key === DBML_RICH_META_JSON_PROPERTY) continue;
      const metaKey = s.key.slice(DBML_RICH_META_PREFIX.length);
      if (metaKey === '') continue;
      attrs.set(metaKey, [...(attrs.get(metaKey) ?? []), s]);
    }
    const jsonSetters = setters.filter((s) => s.key === DBML_RICH_META_JSON_PROPERTY);
    const jsonSetter = effective(jsonSetters);
    let jsonObject: Record<string, unknown> | null = null;
    if (jsonSetter) {
      const raw = literalString(jsonSetter.value) ?? '';
      try {
        const parsed = JSON.parse(raw) as unknown;
        jsonObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { [META_JSON_KEY]: raw };
      } catch {
        jsonObject = { [META_JSON_KEY]: raw };
      }
    }
    const nextJson: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(jsonObject ?? {})) Object.defineProperty(nextJson, k, { value: v, enumerable: true, writable: true, configurable: true });
    const keys = [...new Set([...Object.keys(have), ...Object.keys(want)])];
    for (const key of keys) {
      const hasWant = Object.prototype.hasOwnProperty.call(want, key);
      const hasHave = Object.prototype.hasOwnProperty.call(have, key);
      const value = want[key];
      if (hasWant && hasHave && deepEqual(have[key], value)) continue;
      const held = attrs.get(key) ?? [];
      const property = `${DBML_RICH_META_PREFIX}${key}`;
      checkForeign(property, column);
      if (!hasWant) {
        for (const s of held) removeSetter(s);
        delete nextJson[key];
      } else if (held.length > 0 && ownMetaProperty(key, value)) {
        setValue(effective(held)!, dbmlString(value));
      } else if (held.length === 0 && jsonObject !== null && Object.prototype.hasOwnProperty.call(jsonObject, key)) {
        // Edited where it is: an entry meta_json holds stays there.
        Object.defineProperty(nextJson, key, { value, enumerable: true, writable: true, configurable: true });
      } else if (ownMetaProperty(key, value)) {
        planFor(owner.list, owner.ownerKey, owner.anchor, owner.multiLine).added.push({
          order: keyOrder(owner.order, property), text: `${property}: ${dbmlString(value)}`,
        });
        delete nextJson[key];
      } else {
        for (const s of held) removeSetter(s);
        Object.defineProperty(nextJson, key, { value, enumerable: true, writable: true, configurable: true });
      }
    }
    if (deepEqual(nextJson, jsonObject ?? {})) return;
    if (Object.keys(nextJson).length === 0) {
      for (const s of jsonSetters) removeSetter(s);
    } else if (jsonSetter) {
      setValue(jsonSetter, dbmlString(JSON.stringify(nextJson)));
    } else {
      planFor(owner.list, owner.ownerKey, owner.anchor, owner.multiLine).added.push({
        order: keyOrder(owner.order, DBML_RICH_META_JSON_PROPERTY),
        text: `${DBML_RICH_META_JSON_PROPERTY}: ${dbmlString(JSON.stringify(nextJson))}`,
      });
    }
  }
}
