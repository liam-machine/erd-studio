/**
 * Sample rows (D37 of the native DBML storage spec): a Table's nested
 * `records` block, as the parser's syntax tree holds it, and the splices
 * that keep it in step with a column edit.
 *
 * A block is the keyword, an optional column list (`records (id, name)`, a
 * one-name `records (name)`, an empty `records ()`, or none: `records {`,
 * meaning every column in file order) and its rows, one per line, values
 * separated by commas. ERD Studio never adds, edits or reorders a row: a
 * column edit changes only what it forces (a rename re-spells the list name;
 * a drop cuts the name and that value from every row), and a block whose
 * values go by position gets its column list written once before an add or
 * a reorder.
 *
 * Every cut is made at comma tokens, never at a value's own offsets: an empty
 * field has no token (the parser gives it a zero-width `<dummy>`), and the
 * one at the start of a row sits at the end of the row before.
 *
 * Privacy: a cell may hold real data. Nothing here puts source text in a
 * message. Every throw is a {@link DbmlEditRefused} naming only the file,
 * line and row numbers and the table's own column names, or an `Error` whose
 * text is fixed apart from the file and a line number.
 */

import { dbmlName } from '../dbmlText.js';
import { SAMPLE_ROWS_LIMIT, type SampleCell, type SampleData } from '../types/semantic.js';
import { DbmlEditRefused } from './errors.js';
import type { DbmlParserModule } from './parserModule.js';
import { PINNED_PARSER, elementType, lineAt, nameFragments, parseSyntax, stripBom, topLevel, type AstNode } from './parser.js';
import { cutEdit, type TextEdit } from './splice.js';

// ---------------------------------------------------------------------------
// The blocks in a syntax tree
// ---------------------------------------------------------------------------

/** How a block names its columns. */
export type RecordsListForm =
  /** `records (a, b) {`: two or more names. */
  | 'tuple'
  /** `records (a) {`: one name (a group, not a tuple, in the syntax tree). */
  | 'group'
  /** `records {`: every column of the Table, in file order. */
  | 'none'
  /** `records () {`: never touched. */
  | 'empty'
  /** Anything else (a top-level `Records t(a, b)`, a qualified list): never touched. */
  | 'other';

/** A comma-separated run of elements: a column list or one row. */
export interface RecordsSequence {
  /** The elements, a `<dummy>` for an empty field. */
  elements: AstNode[];
  /** The comma tokens between them (one fewer than the elements). */
  commas: AstNode[];
}

/** One `records` element, nested in a Table or at the top level. */
export interface RecordsBlock {
  /** The element declaration (its `type` is the keyword token). */
  node: AstNode;
  /** Inside a Table, the form a table file may hold. */
  nested: boolean;
  form: RecordsListForm;
  /** The column list, for `tuple` and `group`. */
  list?: RecordsSequence;
  /** The rows, in file order. */
  rows: RecordsSequence[];
}

function isRecords(node: AstNode | undefined): boolean {
  return elementType(node as AstNode)?.toLowerCase() === 'records';
}

/** The elements and commas of a row's callee or of a column list. */
function sequenceOf(node: AstNode | undefined): RecordsSequence {
  if (!node) return { elements: [], commas: [] };
  if (node.kind === '<comma-expression>' || node.kind === '<tuple-expression>' || node.kind === '<group-expression>') {
    return {
      elements: Array.isArray(node.elementList) ? (node.elementList as AstNode[]) : [],
      commas: Array.isArray(node.commaList) ? (node.commaList as AstNode[]) : [],
    };
  }
  return { elements: [node], commas: [] };
}

function blockOf(node: AstNode, nested: boolean): RecordsBlock {
  const name = node.name as AstNode | undefined;
  let form: RecordsListForm;
  if (!name) form = 'none';
  else if (name.kind === '<tuple-expression>') form = Array.isArray(name.elementList) && name.elementList.length > 0 ? 'tuple' : 'empty';
  else if (name.kind === '<group-expression>') form = 'group';
  else form = 'other';
  const body: AstNode[] = Array.isArray(node.body?.body) ? node.body.body : [];
  return {
    node,
    nested,
    form,
    ...(form === 'tuple' || form === 'group' ? { list: sequenceOf(name) } : {}),
    rows: body.filter((n) => n?.kind === '<function-application>').map((row) => sequenceOf(row.callee)),
  };
}

/**
 * Every `records` element of a program's syntax tree: those nested in a
 * Table (in body order) and those at the top level, in file order. Internal:
 * the nodes are the parser's.
 */
export function recordsBlocksOf(ast: AstNode | undefined): RecordsBlock[] {
  const out: RecordsBlock[] = [];
  for (const node of topLevel(ast)) {
    if (isRecords(node)) {
      out.push(blockOf(node, false));
      continue;
    }
    if (elementType(node)?.toLowerCase() !== 'table') continue;
    for (const inner of Array.isArray(node.body?.body) ? (node.body.body as AstNode[]) : []) {
      if (isRecords(inner)) out.push(blockOf(inner, true));
    }
  }
  return out.sort((a, b) => a.node.start - b.node.start);
}

/** Where a `records` block sits in a text: the shapes a message sanitiser needs, no parser types. */
export interface RecordsSpan {
  /** Offset of the `records` keyword. */
  start: number;
  /** Offset of the body's `{` (the header is `[start, bodyStart)`); the span's end when there is no body. */
  bodyStart: number;
  /** Just past the closing `}`, or the end of the text when the block is not closed. */
  end: number;
  /** 1-based line of the keyword. */
  line: number;
  /** Nested in a Table (the form a table file may hold), not a top-level `Records`. */
  nested: boolean;
}

/**
 * Every `records` block of a DBML text, nested or top-level, read from a lex
 * and parse alone (so a text with binding errors, or a syntax error inside a
 * block, still gives its spans). Offsets are into `text` as given: a leading
 * byte-order mark is counted. `parser` is the pinned one unless a test
 * passes another.
 */
export function recordsSpansOf(text: string, parser: DbmlParserModule = PINNED_PARSER): RecordsSpan[] {
  if (!/records/i.test(text)) return [];
  const stripped = stripBom(text);
  const shift = text.length - stripped.length;
  let ast: AstNode | undefined;
  try {
    ast = parseSyntax(stripped, parser).ast;
  } catch {
    return [];
  }
  return recordsBlocksOf(ast).map(({ node, nested }) => {
    const close = node.body?.blockCloseBrace as AstNode | undefined;
    const end = close && typeof close.end === 'number' ? close.end : stripped.length;
    const bodyStart = typeof node.body?.start === 'number' ? Math.min(node.body.start, end) : end;
    return { start: node.start + shift, bodyStart: bodyStart + shift, end: end + shift, line: lineAt(stripped, node.start), nested };
  });
}

// ---------------------------------------------------------------------------
// Reading a block's cells (uncapped)
// ---------------------------------------------------------------------------

const isDummy = (node: AstNode | undefined): boolean => node?.kind === '<dummy>';

/** A cell's source text: the value as written, or `''` for an empty field. */
function cellText(text: string, node: AstNode): string {
  return isDummy(node) ? '' : text.slice(node.start, node.end);
}

/** A list element's column name (unquoted), or its source text when it is not a plain name. */
function listName(text: string, node: AstNode): string {
  const fragments = nameFragments(node);
  return fragments && fragments.length === 1 && typeof fragments[0] === 'string' ? fragments[0] : `\u0000${text.slice(node.start, node.end)}`;
}

/** A block's header and rows as text: what the safety net compares. */
export interface RecordsCells {
  /** The list's names; `[]` for `records ()`; null for no list. */
  header: string[] | null;
  /** Every row (no cap), each cell's source text, `''` for an empty field. */
  rows: string[][];
}

/** The cells of `block` in `text`, every row (no cap). */
export function recordsCellsOf(text: string, block: RecordsBlock): RecordsCells {
  const header = block.form === 'none' ? null
    : block.form === 'empty' ? []
      : block.form === 'other' ? [`\u0000${text.slice(block.node.name?.start ?? block.node.start, block.node.name?.end ?? block.node.start)}`]
        : block.list!.elements.map((e) => listName(text, e));
  return { header, rows: block.rows.map((row) => row.elements.map((e) => cellText(text, e))) };
}

// ---------------------------------------------------------------------------
// Reading a block's rows for display (capped)
// ---------------------------------------------------------------------------

const BOOLEAN_WORDS: ReadonlySet<string> = new Set(['true', 'false']);

/**
 * One value as {@link SampleData} holds it, read from the source text by its
 * token (never from the interpreted database, which turns `007` into 7,
 * rounds a 20-digit integer and empties an enum reference). The kind comes
 * from the token: a string literal or a double-quoted name is a `string`
 * (its text as the parser reads it, a line break inside a `'''` string read
 * as `\n` in a CRLF file too); `null` (any case) and an empty field are
 * null; `true` / `false` (any case) are a `boolean`; a number, signed or
 * not, is a `number`; a backtick expression an `expression` (backticks
 * kept); a dotted name an `enum` reference. Every kind but `string` keeps
 * its source text exactly as written.
 */
export function sampleCellOf(text: string, node: AstNode): SampleCell | null {
  if (isDummy(node)) return null;
  const source = text.slice(node.start, node.end);
  if (node.kind === '<primary-expression>') {
    const expression = node.expression as AstNode | undefined;
    const token = (expression?.literal ?? expression?.variable) as AstNode | undefined;
    if (token?.kind === '<string>' || token?.kind === '<variable>') {
      return { text: typeof token.value === 'string' ? token.value.replace(/\r\n/g, '\n') : source, kind: 'string' };
    }
    if (token?.kind === '<number>') return { text: source, kind: 'number' };
    if (token?.kind === '<identifier>' && typeof token.value === 'string') {
      const word = token.value.toLowerCase();
      if (word === 'null') return null;
      if (BOOLEAN_WORDS.has(word)) return { text: source, kind: 'boolean' };
    }
  }
  if (node.kind === '<prefix-expression>') return { text: source, kind: 'number' };
  if (node.kind === '<infix-expression>' && node.op?.value === '.') return { text: source, kind: 'enum' };
  // A backtick expression, or (in a block the parser did not refuse) anything else: as written.
  return { text: source, kind: 'expression' };
}

/**
 * A nested block's rows for display: its list's names (or, for `records {`,
 * `tableColumns`, the Table's columns in file order) and at most
 * {@link SAMPLE_ROWS_LIMIT} rows, with `totalRows` counting every row.
 * Undefined for `records ()`, any other form, a block with no column or no
 * row: there is nothing to show.
 */
export function sampleDataOf(text: string, block: RecordsBlock, tableColumns: readonly string[]): SampleData | undefined {
  let columns: string[];
  if (block.form === 'none') columns = [...tableColumns];
  else if (block.form === 'tuple' || block.form === 'group') columns = block.list!.elements.map((e) => listName(text, e));
  else return undefined;
  if (columns.length === 0 || columns.some((c) => c.startsWith('\u0000')) || block.rows.length === 0) return undefined;
  const rows = block.rows.slice(0, SAMPLE_ROWS_LIMIT).map((row) => row.elements.map((e) => sampleCellOf(text, e)));
  return { columns, rows, totalRows: block.rows.length };
}

/** A `records` block as Import reads it: where it is and its rows, never its column list (the caller has the parser's). */
export interface RecordsBlockReading {
  /** Offset of the `records` keyword in the text given (a leading byte-order mark counted). */
  start: number;
  /** 1-based line of the keyword. */
  line: number;
  /** Nested in a Table, not a top-level `Records`. */
  nested: boolean;
  /** At most `limit` rows, in file order, one cell per value ({@link sampleCellOf}). */
  rows: Array<Array<SampleCell | null>>;
  /** Rows in the block, counting any past the limit. */
  totalRows: number;
}

/**
 * Every `records` block of a DBML text, nested or top-level, with each
 * value read from its token as {@link sampleCellOf} reads it, at most
 * `limit` rows per block. The column list is not read here: a top-level
 * block names its table and columns in its header, and `records {` names
 * none, so a caller matches each block (by {@link RecordsBlockReading.start})
 * to the parser's own reading of it. A text the parser cannot lex gives [].
 */
export function readRecordsBlocks(text: string, limit = SAMPLE_ROWS_LIMIT, parser: DbmlParserModule = PINNED_PARSER): RecordsBlockReading[] {
  if (!/records/i.test(text)) return [];
  const stripped = stripBom(text);
  const shift = text.length - stripped.length;
  let ast: AstNode | undefined;
  try {
    ast = parseSyntax(stripped, parser).ast;
  } catch {
    return [];
  }
  return recordsBlocksOf(ast).map((block) => ({
    start: block.node.start + shift,
    line: lineAt(stripped, block.node.start),
    nested: block.nested,
    rows: block.rows.slice(0, Math.max(0, limit)).map((row) => row.elements.map((e) => sampleCellOf(stripped, e))),
    totalRows: block.rows.length,
  }));
}

/**
 * The reader's problem for a nested block that does not read
 * (`recordsUnreadable`): the line of its keyword, no value.
 */
export function recordsUnreadableMessage(line: number): string {
  return `Line ${line}: the sample data (records) does not read as DBML, so it is not shown. Other DBML tools reject this file, and ERD Studio will not edit this table until the rows are fixed or removed.`;
}

/** The writer's refusal (R1) for a table read with a block that does not read: the file and the block's line, no value. */
export function recordsUnreadableRefusal(file: string, line: number | undefined): string {
  return `${file}: the sample data (records)${line !== undefined ? ` on line ${line}` : ''} does not read as DBML. Fix or remove it in the file; ERD Studio will not edit this table until it reads.`;
}

// ---------------------------------------------------------------------------
// Keeping a block in step with a column edit
// ---------------------------------------------------------------------------

/** What a column edit does to a block: enough to say what the block must read as afterwards. */
export interface RecordsPlan {
  /** 1-based line of the block's keyword. */
  line: number;
  form: RecordsListForm;
  /** The whole block goes: no listed column is left. */
  cutBlock: boolean;
  /** The value positions (and list positions) cut from every row (and the list). */
  removeAt: number[];
  /** List positions renamed: position → the new name. */
  renameAt: Map<number, string>;
  /** For a block with no list: the column list written after the keyword, or null. */
  insertHeader: string[] | null;
}

/** What {@link planRecordsSplices} is given. */
export interface RecordsSpliceInput {
  /** The table file without a byte-order mark: the text the block's offsets are into. */
  text: string;
  block: RecordsBlock;
  /** The table's columns as the file reads them, in file order. */
  current: readonly string[];
  /** The columns the edit wants, in order. */
  desired: readonly string[];
  /** Which current column each desired column is (desired index → current index): `matchColumns`. */
  matchOf: ReadonlyMap<number, number>;
  /** The file, as messages name it. */
  file: string;
}

/** The fixed message of a cut that would cross a line break (a writer bug, never something to show a value with). */
export function recordsCutCrossedLineMessage(file: string, line: number): string {
  return `ERD Studio stopped this edit: a sample data (records) cut in ${file} at line ${line} crossed a line break. Nothing was changed.`;
}

/** The fixed refusal of an edit that would leave a block out of step with its columns (the safety net's). */
export function recordsOutOfStepMessage(file: string, line: number): string {
  return `ERD Studio stopped this edit: it would not keep the sample data (records, line ${line}) of ${file} in step. Nothing was changed.`;
}

/** Index of the column a list name names: the same spelling, else the same name in another case. */
function columnIndexOf(current: readonly string[], name: string): number {
  const exact = current.indexOf(name);
  return exact >= 0 ? exact : current.findIndex((c) => c.toLowerCase() === name.toLowerCase());
}

/**
 * The comma-slot cut rule, for one sequence (a row or the list). Each
 * element's slot is bounded by comma tokens: an element after the first is
 * cut from the comma before it to the end of its slot; the first from the
 * start of its slot to the start of the next kept element. A `<dummy>`'s
 * offsets are never used. Returns the merged cut spans (none when nothing
 * is cut).
 */
function sequenceCuts(text: string, seq: RecordsSequence, remove: ReadonlySet<number>): Array<{ start: number; end: number }> {
  const { elements: e, commas: c } = seq;
  const n = e.length;
  /** Where element k's own text starts (its first token), or where its empty slot is. */
  const startOf = (k: number): number => (!isDummy(e[k]) ? e[k].start : k < n - 1 ? c[k].start : c[k - 1].end);
  /** Where element k's slot ends: the comma after it, or its own end (an empty last field: the comma before). */
  const slotEnd = (k: number): number => (k < n - 1 ? c[k].start : !isDummy(e[k]) ? e[k].end : c[k - 1].end);
  const spans: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < n; i++) {
    if (!remove.has(i)) continue;
    if (i > 0) {
      spans.push({ start: c[i - 1].start, end: slotEnd(i) });
      continue;
    }
    let next = -1;
    for (let j = 1; j < n; j++) if (!remove.has(j)) { next = j; break; }
    if (next < 0) continue; // nothing kept: the caller cuts the whole block
    spans.push({ start: startOf(0), end: startOf(next) });
  }
  spans.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  // A cut that ends the sequence takes the spaces before its comma too, so no row is left ending in a space.
  const last = merged[merged.length - 1];
  if (last && n > 1 && last.end === slotEnd(n - 1) && last.start > 0) {
    while (last.start > 0 && (text[last.start - 1] === ' ' || text[last.start - 1] === '\t')) last.start--;
  }
  return merged;
}

/**
 * Plan the splices that keep a nested `records` block in step with a column
 * edit (§3.3 of the sample-rows plan): rename (case-only included) re-spells
 * each list name with `dbmlName`; a drop cuts the name from the list and
 * that value from every row (a row left with one empty field gets `null`,
 * which the parser already reads an empty field as); the whole block goes
 * when no listed column is left; a block with no list gets the old column
 * list written after its keyword once on an add or a reorder, and no row is
 * touched; `records ()` and any other form are never touched.
 *
 * Throws {@link DbmlEditRefused} for a drop that would start a row after the
 * first with `-` or `+` (DBML 9 and 10 reject it), and an `Error` with a
 * fixed message for a cut that would cross a line break.
 */
export function planRecordsSplices(input: RecordsSpliceInput): { edits: TextEdit[]; plan: RecordsPlan } {
  const { text, block, current, desired, matchOf, file } = input;
  const plan: RecordsPlan = {
    line: lineAt(text, block.node.start),
    form: block.form,
    cutBlock: false,
    removeAt: [],
    renameAt: new Map(),
    insertHeader: null,
  };
  if (block.form === 'empty' || block.form === 'other') return { edits: [], plan };

  const kept = new Set<number>(matchOf.values());
  const removedColumns = new Set<number>(current.map((_, i) => i).filter((i) => !kept.has(i)));
  const newNameOf = new Map<number, string>(); // current index → its new spelling
  for (const [di, ci] of matchOf) if (desired[di] !== current[ci]) newNameOf.set(ci, desired[di]);

  /** Each value position's column (current index); -1 for a name the table lacks. */
  let columnAt: number[];
  if (block.form === 'none') {
    columnAt = current.map((_, i) => i);
  } else {
    columnAt = block.list!.elements.map((e) => columnIndexOf(current, listName(text, e)));
  }
  const removeAt = new Set<number>(columnAt.map((ci, i) => (ci >= 0 && removedColumns.has(ci) ? i : -1)).filter((i) => i >= 0));
  plan.removeAt = [...removeAt].sort((a, b) => a - b);

  if (columnAt.length > 0 && removeAt.size === columnAt.length) {
    plan.cutBlock = true;
    return { edits: [cutEdit(text, block.node)], plan };
  }

  const edits: TextEdit[] = [];
  if (block.form === 'none') {
    const matched = desired.map((_, di) => matchOf.get(di)).filter((ci): ci is number => ci !== undefined);
    const reordered = matched.some((ci, i) => i > 0 && ci < matched[i - 1]);
    const added = desired.length > matchOf.size;
    if ((reordered || added) && current.length > 0) {
      plan.insertHeader = current.map((name, ci) => newNameOf.get(ci) ?? name).filter((_, ci) => !removedColumns.has(ci));
      const keyword = block.node.type as AstNode;
      edits.push({ start: keyword.end, end: keyword.end, text: ` (${plan.insertHeader.map(dbmlName).join(', ')})` });
    }
  } else {
    const list = block.list!;
    list.elements.forEach((element, i) => {
      if (removeAt.has(i)) return;
      const to = columnAt[i] >= 0 ? newNameOf.get(columnAt[i]) : undefined;
      if (to === undefined) return;
      plan.renameAt.set(i, to);
      edits.push({ start: element.start, end: element.end, text: dbmlName(to) });
    });
    // The list is a header, never a row: a line break inside it is any list's own layout.
    for (const span of sequenceCuts(text, list, removeAt)) edits.push({ ...span, text: '' });
  }

  if (removeAt.size === 0) return { edits, plan };
  const keptCount = columnAt.length - removeAt.size;
  block.rows.forEach((row, r) => {
    const { elements, commas } = row;
    // A block that compiled has one value per position in every row; anything else is not cut by position.
    if (elements.length !== columnAt.length || commas.length !== elements.length - 1) {
      throw new DbmlEditRefused(file, recordsOutOfStepMessage(file, plan.line), plan.line);
    }
    const firstKept = elements.findIndex((_, i) => !removeAt.has(i));
    if (keptCount === 1 && isDummy(elements[firstKept])) {
      // A one-value row left with an empty field would be a blank line (the row lost): write `null`.
      const start = isDummy(elements[0]) ? commas[0].start : elements[0].start;
      const last = elements.length - 1;
      const end = isDummy(elements[last]) ? commas[last - 1].end : elements[last].end;
      guard(text, file, { start, end }, elements.filter((e) => !isDummy(e)));
      edits.push({ start, end, text: 'null' });
      return;
    }
    if (r > 0 && removeAt.has(0) && !isDummy(elements[firstKept]) && /^[-+]/.test(cellText(text, elements[firstKept]))) {
      const column = columnAt[0] >= 0 ? current[columnAt[0]] : 'the first listed column';
      const line = lineAt(text, elements[firstKept].start);
      throw new DbmlEditRefused(
        file,
        `${file}: removing ${column} would start sample row ${r + 1} (records, line ${line}) with a minus or plus sign, which DBML 9 and 10 tools reject. Edit that row in the file first.`,
        line,
      );
    }
    for (const span of sequenceCuts(text, row, removeAt)) {
      guard(text, file, span, elements.filter((e, i) => removeAt.has(i) && !isDummy(e)));
      edits.push({ ...span, text: '' });
    }
  });
  return { edits, plan };
}

/**
 * Whether trivia (commas, spaces and comments: no string, which is always a
 * value's own text) holds a line break outside its block comments. A `//`
 * comment runs to its line break, which counts.
 */
function breaksLine(trivia: string): boolean {
  for (let i = 0; i < trivia.length; i++) {
    if (trivia[i] === '\n') return true;
    if (trivia[i] !== '/') continue;
    if (trivia[i + 1] === '/') {
      const eol = trivia.indexOf('\n', i);
      if (eol < 0) return false;
      i = eol - 1;
    } else if (trivia[i + 1] === '*') {
      const close = trivia.indexOf('*/', i + 2);
      if (close < 0) return trivia.includes('\n', i);
      i = close + 1;
    }
  }
  return false;
}

/**
 * Refuse (as a writer bug, with a fixed message) a row cut that holds a
 * line break outside the text of the values it removes and of the block
 * comments in its slots (a `/* … *\/` over two lines between values is still
 * one row to the parser): it would join two rows, or cut a row away.
 */
function guard(text: string, file: string, span: { start: number; end: number }, own: readonly AstNode[]): void {
  let at = span.start;
  let rest = '';
  for (const node of [...own].sort((a, b) => a.start - b.start)) {
    if (node.end <= span.start || node.start >= span.end) continue;
    rest += text.slice(at, Math.max(at, node.start));
    at = Math.max(at, node.end);
  }
  rest += text.slice(at, span.end);
  if (breaksLine(rest)) throw new Error(recordsCutCrossedLineMessage(file, lineAt(text, span.start)));
}

/**
 * What a block reads as once a {@link RecordsPlan} is applied, from the
 * block as it was: the list with renamed names re-spelled and dropped names
 * gone (or the inserted list), the same rows with the dropped values gone,
 * each kept value's text unchanged but a lone kept empty field read as
 * `null`; null when the whole block goes.
 */
export function expectedSampleRows(before: RecordsCells, plan: RecordsPlan): RecordsCells | null {
  if (plan.cutBlock) return null;
  const removed = new Set(plan.removeAt);
  const header = plan.form === 'none'
    ? plan.insertHeader ? [...plan.insertHeader] : null
    : plan.form === 'tuple' || plan.form === 'group'
      ? (before.header ?? []).map((name, i) => plan.renameAt.get(i) ?? name).filter((_, i) => !removed.has(i))
      : before.header;
  const rows = before.rows.map((row) => {
    const kept = row.filter((_, i) => !removed.has(i));
    return removed.size > 0 && kept.length === 1 && kept[0] === '' ? ['null'] : kept;
  });
  return { header, rows };
}
