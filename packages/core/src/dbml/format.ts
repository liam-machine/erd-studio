/**
 * The DBML formatter: ERD Studio's one canonical layout for a `.dbml` file,
 * run at the end of every DBML write and behind Format Document.
 *
 * It changes **whitespace only**. The file is lexed and parsed once (the
 * pinned parser's `parseFile`: no binding, so a diagram's hundreds of `use`
 * lines cost nothing extra); every token and comment is then re-emitted in
 * order with recomputed whitespace between them, and the result is checked:
 * re-lexed, its token sequence (kind and exact text, comments included) and
 * its syntax tree's shape must equal the input's, or the input comes back
 * unchanged with `skipped: 'self-check'`. A file with a syntax error comes
 * back unchanged with `skipped: 'parse-errors'`. Nothing inside a token is
 * ever touched: string literals (a `'''` note keeps its inner indentation,
 * which is part of its value), block comments, backtick expressions and
 * quoted names stay byte for byte.
 *
 * A line break is significant in DBML (it ends a column, a Project field,
 * an Enum value), so line breaks are only ever added or removed inside a
 * settings list (`[ … ]` after a column, an index, a Ref, an Enum value or
 * in an element header), where the parsers ignore them. Everywhere else a
 * line break stays a line break; only blank-line runs and indentation change.
 *
 * The layout:
 *
 * - Two-space indent per open bracket whose content starts on a new line;
 *   the input's dominant line ending (LF unless CRLF is the majority); no
 *   trailing whitespace; exactly one final line break; no leading blank
 *   lines; runs of blank lines collapse to one; no blank line straight after
 *   `{` / `[` or straight before `}` / `]`. A single blank line is kept.
 * - An own-line comment stays on its own line, indented like the line after
 *   it (or, before a closing bracket, like the lines inside that bracket); a
 *   trailing comment stays trailing, one space after the code.
 * - Columns on consecutive lines of a `Table` (or `TablePartial`) body,
 *   with no blank line or own-line comment between them, are aligned: names
 *   padded to the group's longest name (a name over {@link NAME_CAP} code
 *   points does not widen the group), types padded to the longest type of a
 *   column with settings (cap {@link TYPE_CAP}), then the settings. A type's
 *   own spacing is normalised (`decimal( 10,2 )` → `decimal(10, 2)`).
 * - A settings list reads `[a, b: c]`, or one setting per line (`[`
 *   ending the line, `]` alone at the line's depth). A column's or an
 *   index's list goes one per line when its line would pass
 *   {@link MAX_WIDTH} code points, a `Table` header's also when it holds two
 *   or more settings; any other list (a Ref's, an Enum value's, a Note's)
 *   keeps the input's choice. Any list holding a `//` comment, an own-line
 *   comment, a multi-line string or a line break inside one setting goes one
 *   per line.
 * - Element headers read `Keyword name as alias [settings] {` and
 *   `Keyword name: value`; Ref relations have one space each side of the
 *   operator; tuples read `(a, b)`.
 * - Consecutive one-line selective `use` / `reuse` lines align their
 *   `from` (a `use { … }` part over {@link USE_CAP} code points does not
 *   widen the run); inside the braces there is one space each side.
 * - Anything else keeps its spacing within a line and is only re-indented.
 */

import type { DbmlDiagnostic } from '../types/dbmlStorage.js';
import type { DbmlParserModule } from './parserModule.js';
import { PINNED_PARSER, parseSyntax, type AstNode } from './parser.js';

/** Why {@link formatDbml} returned its input unchanged. */
export type DbmlFormatSkipReason = 'parse-errors' | 'self-check';

/** Options of {@link formatDbml}. */
export interface DbmlFormatOptions {
  /** The parser to lex and check with; the pinned 11.0.0 by default. */
  parser?: DbmlParserModule;
}

/** What {@link formatDbml} returns. */
export interface DbmlFormatResult {
  /** The formatted text, or the input itself when `skipped` is set. */
  text: string;
  /** Whether `text` differs from the input. */
  changed: boolean;
  /** Set when the input came back unchanged because it could not be formatted safely. */
  skipped?: DbmlFormatSkipReason;
  /** The syntax errors, when `skipped` is `'parse-errors'`. */
  errors?: DbmlDiagnostic[];
  /** What the self-check found, when `skipped` is `'self-check'`. */
  detail?: string;
}

/** The longest line, in code points, before a settings list goes one setting per line. */
export const MAX_WIDTH = 100;
/** A column name longer than this many code points does not widen its alignment group. */
export const NAME_CAP = 32;
/** A column type longer than this many code points does not widen its alignment group. */
export const TYPE_CAP = 24;
/**
 * A `use { … }` part longer than this many code points does not widen its
 * `from` alignment (room for `reuse { table <a 32-character name> }`), so one
 * long table name cannot re-pad every import of a 500-table diagram.
 */
export const USE_CAP = 48;

const INDENT = '  ';

const LINE_COMMENT = '<single-line-comment>';
const BLOCK_COMMENT = '<multiline-comment>';
const OPENERS = new Set(['<lbrace>', '<lbracket>', '<lparen>']);
const CLOSERS = new Set(['<rbrace>', '<rbracket>', '<rparen>']);
/** A relation operator, with the optional `?` of 11.0 on either side. */
const RELATION_OP = /^\??(<>|<|>|-)\??$/;
/** Element types whose body holds columns. */
const TABLE_ELEMENTS = new Set(['table', 'tablepartial']);
/** Keys of a parser node that point back up the tree, or at things that are not children. */
const NOT_CHILDREN = new Set(['parent', 'parentNode', 'parentElement', 'symbol', 'referee', 'filepath', 'startPos', 'endPos']);

/** One token or comment of the file, in order. */
interface Item {
  kind: string;
  text: string;
  start: number;
  end: number;
}

/**
 * Format `text` in ERD Studio's canonical DBML layout (whitespace only).
 * Never throws for bad DBML: a file with a syntax error, or one whose
 * formatted form fails the self-check, comes back unchanged with `skipped`
 * set. Idempotent: formatting the result again changes nothing.
 */
export function formatDbml(text: string, options: DbmlFormatOptions = {}): DbmlFormatResult {
  const parser = options.parser ?? PINNED_PARSER;
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const body = bom ? text.slice(1) : text;
  const unchanged = (extra: Partial<DbmlFormatResult>): DbmlFormatResult => ({ text, changed: false, ...extra });

  const parsed = parseSyntax(body, parser);
  if (parsed.errors.length > 0) {
    return unchanged({ skipped: 'parse-errors', errors: parsed.errors.map(({ code, message, line, column }) => ({ code, message, line, column })) });
  }
  const items = itemsOf(parsed.tokens, body);
  if (items === undefined) return unchanged({ skipped: 'parse-errors', errors: [] });
  if (!gapsAreWhitespace(items, body)) return unchanged({ skipped: 'self-check', detail: 'text between two tokens is not whitespace' });

  let formatted: string;
  try {
    formatted = new Layout(body, items, parsed.ast).render();
  } catch (error) {
    return unchanged({ skipped: 'self-check', detail: `the layout failed: ${error instanceof Error ? error.message : String(error)}` });
  }

  if (formatted !== body) {
    const problem = selfCheck(items, parsed.ast, formatted, parser);
    if (problem) return unchanged({ skipped: 'self-check', detail: problem });
  }
  const out = bom + formatted;
  return { text: out, changed: out !== text };
}

// ---------------------------------------------------------------------------
// Tokens

function isComment(item: Item | undefined): boolean {
  return item !== undefined && (item.kind === LINE_COMMENT || item.kind === BLOCK_COMMENT);
}

function isToken(value: unknown): value is AstNode {
  return !!value && typeof value === 'object' && Array.isArray((value as AstNode).leadingTrivia);
}

function isNode(value: unknown): value is AstNode {
  return !!value && typeof value === 'object' && typeof (value as AstNode).kind === 'string' && !isToken(value);
}

/** Every token and comment, in order; undefined when the lexer marked anything invalid. */
function itemsOf(tokens: readonly AstNode[], text: string): Item[] | undefined {
  const items: Item[] = [];
  const push = (t: AstNode): void => {
    let end = t.end as number;
    // A `//` comment runs to the `\n`: the `\r` of a CRLF line ending, and any whitespace
    // before it, are the line's, not the comment's.
    if (t.kind === LINE_COMMENT) while (end > t.start && /[ \t\r]/.test(text[end - 1])) end--;
    items.push({ kind: String(t.kind), text: text.slice(t.start, end), start: t.start, end });
  };
  for (const token of tokens) {
    if (token.isInvalid || (token.leadingInvalid?.length ?? 0) > 0 || (token.trailingInvalid?.length ?? 0) > 0) return undefined;
    for (const trivia of token.leadingTrivia ?? []) if (trivia.kind === LINE_COMMENT || trivia.kind === BLOCK_COMMENT) push(trivia);
    if (token.kind !== '<eof>') push(token);
    for (const trivia of token.trailingTrivia ?? []) if (trivia.kind === LINE_COMMENT || trivia.kind === BLOCK_COMMENT) push(trivia);
  }
  return items;
}

/** Whether everything between (and around) the items is spaces, tabs and line breaks. */
function gapsAreWhitespace(items: readonly Item[], text: string): boolean {
  let at = 0;
  for (const item of items) {
    if (item.start < at || !/^[ \t\r\n]*$/.test(text.slice(at, item.start))) return false;
    at = item.end;
  }
  return /^[ \t\r\n]*$/.test(text.slice(at));
}

/** Length in Unicode code points. */
function width(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) n--;
  }
  return n;
}

/** The syntax tree's shape: every node kind and array length, in order. */
function shapeOf(ast: AstNode): string {
  const out: string[] = [];
  const seen = new Set<AstNode>();
  const walk = (node: AstNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    out.push(node.kind);
    for (const key in node) {
      if (NOT_CHILDREN.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        out.push(`${key}[${value.length}`);
        for (const v of value) if (isNode(v)) walk(v);
        out.push(']');
      } else if (isNode(value)) {
        out.push(key);
        walk(value);
      }
    }
  };
  if (isNode(ast)) walk(ast);
  return out.join(' ');
}

/** Why `formatted` is not a whitespace-only change of `original`, or undefined when it is. */
function selfCheck(items: readonly Item[], ast: AstNode, formatted: string, parser: DbmlParserModule): string | undefined {
  const again = parseSyntax(formatted, parser);
  if (again.errors.length > 0) return `the formatted text has a syntax error: [${again.errors[0].code}] ${again.errors[0].message}`;
  const after = itemsOf(again.tokens, formatted);
  if (!after) return 'the formatted text has an invalid token';
  if (after.length !== items.length) return `the token count changed (${items.length} → ${after.length})`;
  for (let i = 0; i < items.length; i++) {
    if (after[i].kind !== items[i].kind || after[i].text !== items[i].text) return `token ${i + 1} changed (${JSON.stringify(items[i].text)} → ${JSON.stringify(after[i].text)})`;
  }
  if (!gapsAreWhitespace(after, formatted)) return 'the formatted text holds something between its tokens';
  if (shapeOf(ast) !== shapeOf(again.ast)) return 'the syntax tree changed shape';
  return undefined;
}

// ---------------------------------------------------------------------------
// Layout

/** A settings list the layout may put on one line or one setting per line. */
interface SettingsList {
  open: number;
  close: number;
  /** `[first, last]` item index of each setting. */
  elements: Array<[number, number]>;
  commas: Set<number>;
  /** First item of each setting. */
  starts: Set<number>;
  /** Gaps inside settings the attribute rules set: item index → separator. */
  inner: Map<number, string>;
  /** Item indexes inside a setting (not its first). */
  internal: Set<number>;
  /**
   * `width`: a column's or an index's settings, one per line past
   * {@link MAX_WIDTH}; `table-header`: also one per line from two settings;
   * `keep`: any other list (a Ref's, an Enum value's, a Note's), on one
   * line or one setting per line as the input had it.
   */
  rule: 'width' | 'table-header' | 'keep';
}

/** A column line that can be aligned. */
interface Column {
  name: number;
  typeFirst: number;
  typeLast: number;
  /** The settings list's `[`, when the column has one. */
  open?: number;
}

/** A one-line selective `use`: its keyword, its closing brace, its `from` and its last item. */
interface UseLine {
  first: number;
  closeBrace: number;
  from: number;
  last: number;
}

class Layout {
  private readonly n: number;
  /** Line breaks in the input before each item (0, 1, or 2 for a blank line); index n is the end. */
  private readonly origNl: Uint8Array;
  /** Line breaks the output puts before each item. */
  private readonly nl: Uint8Array;
  /** The separator before each item that stays on its line. */
  private readonly sp: string[];
  private readonly byStart = new Map<number, number>();
  private readonly byEnd = new Map<number, number>();
  private readonly lists: SettingsList[] = [];
  /** The column lines of each table body, in order; undefined for a body line that is not one. */
  private readonly columnBodies: Array<Array<Column | undefined>> = [];
  private readonly listsByOpen = new Map<number, SettingsList>();
  private readonly uses: Array<UseLine | undefined> = [];
  private readonly eol: string;

  constructor(
    text: string,
    private readonly items: readonly Item[],
    private readonly ast: AstNode,
  ) {
    const n = items.length;
    this.n = n;
    this.origNl = new Uint8Array(n + 1);
    this.nl = new Uint8Array(n + 1);
    this.sp = new Array<string>(n + 1).fill('');
    let crlf = 0;
    let lf = 0;
    for (let k = text.indexOf('\n'); k !== -1; k = text.indexOf('\n', k + 1)) {
      if (k > 0 && text.charCodeAt(k - 1) === 13) crlf++;
      else lf++;
    }
    for (let i = 0; i <= n; i++) {
      const gap = text.slice(i === 0 ? 0 : items[i - 1].end, i === n ? text.length : items[i].start);
      let breaks = 0;
      for (let k = gap.indexOf('\n'); k !== -1; k = gap.indexOf('\n', k + 1)) breaks++;
      this.origNl[i] = Math.min(breaks, 2);
      this.nl[i] = this.origNl[i];
      // An inline gap keeps its own spacing unless a rule says otherwise; a lone `\r` is not kept.
      this.sp[i] = breaks === 0 ? gap.replace(/\r/g, '') || (gap ? ' ' : '') : '';
    }
    this.eol = crlf > lf ? '\r\n' : '\n';
    items.forEach((item, i) => {
      this.byStart.set(item.start, i);
      this.byEnd.set(item.end, i);
    });
  }

  render(): string {
    const { n } = this;
    if (n === 0) return '';
    this.visit(this.ast, undefined);
    this.alignColumns();
    this.alignUses();
    this.commentSpacing();
    // Settings lists: forced ones one per line; the rest on one line, then broken where too wide.
    for (const list of this.lists) this.layoutList(list, this.mustBreak(list));
    const depths = this.lineDepths();
    for (const list of this.lists) {
      if (list.rule === 'keep' || this.isBroken(list)) continue;
      if ((list.rule === 'table-header' && list.elements.length >= 2) || this.singleLineWidth(list, depths) > MAX_WIDTH) this.layoutList(list, true);
    }
    this.commentSpacing();
    this.blankLines();

    const out: string[] = [];
    const stack: number[] = [];
    let depth = 0;
    for (let i = 0; i < n; i++) {
      const item = this.items[i];
      if (i === 0 || this.nl[i] > 0) {
        if (i > 0) out.push(this.nl[i] >= 2 ? this.eol + this.eol : this.eol);
        depth = CLOSERS.has(item.kind) ? (stack.length > 0 ? stack[stack.length - 1] : 0) : stack.length > 0 ? stack[stack.length - 1] + 1 : 0;
        out.push(INDENT.repeat(depth));
      } else {
        out.push(this.sp[i]);
      }
      out.push(item.text);
      if (OPENERS.has(item.kind)) stack.push(depth);
      else if (CLOSERS.has(item.kind)) stack.pop();
    }
    out.push(this.eol);
    return out.join('');
  }

  // -- lookups --------------------------------------------------------------

  private first(node: AstNode | undefined): number | undefined {
    return node && typeof node.start === 'number' ? this.byStart.get(node.start) : undefined;
  }

  private last(node: AstNode | undefined): number | undefined {
    return node && typeof node.end === 'number' ? this.byEnd.get(node.end) : undefined;
  }

  /** Set the separator before item `i` when it stays on its line. */
  private inline(i: number | undefined, separator: string): void {
    if (i === undefined || i <= 0 || i >= this.n || this.nl[i] > 0) return;
    this.sp[i] = separator;
  }

  // -- the tree -------------------------------------------------------------

  private children(node: AstNode, fn: (child: AstNode) => void): void {
    for (const key in node) {
      if (NOT_CHILDREN.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const v of value) if (isNode(v)) fn(v);
      } else if (isNode(value)) fn(value);
    }
  }

  /** Walk the tree; `element` is the lower-cased type of the enclosing element declaration. */
  private visit(node: AstNode, element: string | undefined): void {
    switch (node.kind) {
      case '<element-declaration>':
        this.elementDeclaration(node, element);
        return;
      case '<block-expression>':
        this.block(node, element);
        break;
      case '<function-application>':
        this.functionApplication(node, element);
        break;
      case '<tuple-expression>':
      case '<group-expression>':
        this.tuple(node);
        break;
      case '<use-declaration>':
        this.useDeclaration(node);
        break;
      default:
        break;
    }
    this.children(node, (child) => this.visit(child, element));
  }

  private elementDeclaration(node: AstNode, outer: string | undefined): void {
    const type = typeof node.type?.value === 'string' ? (node.type.value as string).toLowerCase() : undefined;
    // `Keyword name as alias [settings] {` / `Keyword name: value`: one space between header parts, none before `:`.
    const parts: number[] = [];
    const add = (i: number | undefined): void => {
      if (i !== undefined) parts.push(i);
    };
    add(this.first(node.type));
    if (node.name) add(this.first(node.name));
    if (node.as) add(this.first(node.as));
    if (node.alias) add(this.first(node.alias));
    if (node.attributeList) add(this.first(node.attributeList));
    const colon = node.bodyColon ? this.first(node.bodyColon) : undefined;
    const body = node.body as AstNode | undefined;
    const bodyStart = body ? this.first(body) : undefined;
    for (let k = 1; k < parts.length; k++) this.inline(parts[k], ' ');
    if (colon !== undefined) {
      this.inline(colon, '');
      this.inline(bodyStart, ' ');
    } else if (bodyStart !== undefined && body?.kind === '<block-expression>' && parts.length > 0) {
      this.inline(bodyStart, ' ');
    }
    if (node.attributeList?.kind === '<list-expression>') this.registerList(node.attributeList, type !== undefined && TABLE_ELEMENTS.has(type) ? 'table-header' : 'keep');
    // The header's own parts (a dotted name, an alias) keep their spacing; the body is the element's.
    for (const key of ['name', 'alias', 'attributeList']) {
      if (isNode(node[key])) this.visit(node[key], outer);
    }
    if (isNode(body)) this.visit(body, type);
  }

  private block(node: AstNode, element: string | undefined): void {
    const open = this.first(node.blockOpenBrace);
    const close = this.first(node.blockCloseBrace);
    if (open !== undefined && close !== undefined && close > open + 1) {
      // `{ x }` on one line: one space inside each brace.
      this.inline(open + 1, ' ');
      this.inline(close, ' ');
    }
    if (element !== undefined && TABLE_ELEMENTS.has(element) && Array.isArray(node.body)) {
      this.columnBodies.push((node.body as AstNode[]).map((child) => (isNode(child) ? this.columnOf(child) : undefined)));
    }
  }

  private functionApplication(node: AstNode, element: string | undefined): void {
    const args: AstNode[] = Array.isArray(node.args) ? node.args : [];
    for (const arg of args) {
      if (arg?.kind === '<list-expression>') {
        this.inline(this.first(arg), ' ');
        this.registerList(arg, element !== undefined && (TABLE_ELEMENTS.has(element) || element === 'indexes') ? 'width' : 'keep');
      }
    }
    const callee = node.callee as AstNode | undefined;
    if (element === 'ref' && callee?.kind === '<infix-expression>' && RELATION_OP.test(String(callee.op?.value ?? ''))) {
      const op = this.first(callee.op);
      if (op !== undefined) {
        this.inline(op, ' ');
        this.inline(op + 1, ' ');
      }
    }
  }

  private tuple(node: AstNode): void {
    const open = this.first(node.tupleOpenParen);
    const close = this.first(node.tupleCloseParen);
    if (open !== undefined) this.inline(open + 1, '');
    if (close !== undefined && open !== undefined && close > open) this.inline(close, '');
    for (const comma of Array.isArray(node.commaList) ? node.commaList : []) {
      const c = this.first(comma);
      if (c === undefined) continue;
      this.inline(c, '');
      this.inline(c + 1, ' ');
    }
  }

  private useDeclaration(node: AstNode): void {
    const keyword = this.first(node.useKeyword);
    const from = this.first(node.fromKeyword);
    const path = this.first(node.importPath);
    const specifiers = node.specifiers as AstNode | undefined;
    const specStart = this.first(specifiers);
    this.inline(specStart, ' ');
    this.inline(from, ' ');
    this.inline(path, ' ');
    let closeBrace: number | undefined;
    if (specifiers?.kind === '<use-specifier-list>') {
      const open = this.first(specifiers.openBrace);
      closeBrace = this.first(specifiers.closeBrace);
      if (open !== undefined && closeBrace !== undefined && closeBrace > open + 1) {
        this.inline(open + 1, ' ');
        this.inline(closeBrace, ' ');
      }
      for (const spec of Array.isArray(specifiers.specifiers) ? (specifiers.specifiers as AstNode[]) : []) {
        // `table x`, `table x as y`: one space between the parts; a dotted name keeps its own.
        const parts = [spec?.importKind, spec?.name, spec?.as, spec?.alias].map((p) => (isNode(p) || isToken(p) ? this.first(p) : undefined));
        for (let k = 1; k < parts.length; k++) this.inline(parts[k], ' ');
      }
    }
    // A one-line selective import joins the `from` alignment.
    let one: UseLine | undefined;
    const last = this.last(node);
    if (keyword !== undefined && from !== undefined && closeBrace !== undefined && last !== undefined) {
      let flat = true;
      for (let k = keyword + 1; k <= last; k++) {
        if (this.origNl[k] > 0 || isComment(this.items[k])) {
          flat = false;
          break;
        }
      }
      if (flat) one = { first: keyword, closeBrace, from, last };
    }
    this.uses.push(one); // undefined: a break in the run
  }

  /** A column line whose name, type and `[` share a line, with no comment among them. */
  private columnOf(node: AstNode): Column | undefined {
    if (node.kind !== '<function-application>') return undefined;
    const args: AstNode[] = Array.isArray(node.args) ? node.args : [];
    if (args.length < 1 || args.length > 2) return undefined;
    const callee = node.callee as AstNode | undefined;
    if (callee?.kind !== '<primary-expression>' || callee.expression?.kind !== '<variable>') return undefined;
    const typeNode = args[0];
    if (!isNode(typeNode) || typeNode.kind === '<list-expression>') return undefined;
    const list = args.length === 2 ? args[1] : undefined;
    if (list && list.kind !== '<list-expression>') return undefined;
    const name = this.first(callee);
    const typeFirst = this.first(typeNode);
    const typeLast = this.last(typeNode);
    if (name === undefined || this.last(callee) !== name || typeFirst !== name + 1 || typeLast === undefined) return undefined;
    for (let k = typeFirst; k <= typeLast; k++) {
      if (this.origNl[k] > 0 || isComment(this.items[k]) || this.items[k].text.includes('\n')) return undefined;
    }
    let open: number | undefined;
    if (list) {
      open = this.first(list);
      if (open !== typeLast + 1 || this.origNl[open] > 0) return undefined;
    }
    // A type's own spacing: `decimal(10, 2)`, no space before the `(`.
    this.normaliseType(typeNode);
    return { name, typeFirst, typeLast, ...(open !== undefined ? { open } : {}) };
  }

  private normaliseType(node: AstNode): void {
    if (node.kind === '<call-expression>') this.inline(this.first(node.argumentList), '');
    this.children(node, (child) => this.normaliseType(child));
  }

  private registerList(node: AstNode, rule: SettingsList['rule']): void {
    const open = this.first(node.listOpenBracket);
    const close = this.first(node.listCloseBracket);
    if (open === undefined || close === undefined || close <= open) return;
    const elements: Array<[number, number]> = [];
    const starts = new Set<number>();
    const internal = new Set<number>();
    const inner = new Map<number, string>();
    for (const element of Array.isArray(node.elementList) ? (node.elementList as AstNode[]) : []) {
      const a = this.first(element);
      const b = this.last(element);
      if (a === undefined || b === undefined || b < a) return;
      elements.push([a, b]);
      starts.add(a);
      for (let k = a + 1; k <= b; k++) internal.add(k);
      if (element.kind === '<attribute>') {
        // `not null`: one space between a name's words; `key: value`: none before the colon, one after.
        const ids: AstNode[] = Array.isArray(element.name?.identifiers) ? element.name.identifiers : [];
        ids.forEach((id, j) => {
          const k = this.first(id);
          if (j > 0 && k !== undefined) inner.set(k, ' ');
        });
        const colon = this.first(element.colon);
        if (colon !== undefined) {
          inner.set(colon, '');
          const value = this.first(element.value);
          if (value !== undefined && value > colon) inner.set(value, ' ');
        }
      }
    }
    const commas = new Set<number>();
    for (const comma of Array.isArray(node.commaList) ? node.commaList : []) {
      const c = this.first(comma);
      if (c === undefined) return;
      commas.add(c);
    }
    const list: SettingsList = { open, close, elements, commas, starts, inner, internal, rule };
    this.lists.push(list);
    this.listsByOpen.set(open, list);
  }

  // -- alignment ------------------------------------------------------------

  /** The text from item `a` to item `b` on one line, with the separators set so far. */
  private span(a: number, b: number): string {
    let s = this.items[a].text;
    for (let k = a + 1; k <= b; k++) s += this.sp[k] + this.items[k].text;
    return s;
  }

  /**
   * Whether item `b` starts the line straight after item `a`'s line: one
   * line break, with only trailing comments of `a`'s line between them.
   */
  private nextLine(a: number, b: number): boolean {
    for (let k = a + 1; k < b; k++) if (!isComment(this.items[k]) || this.origNl[k] > 0) return false;
    return this.origNl[b] === 1;
  }

  private alignColumns(): void {
    for (const body of this.columnBodies) {
      let group: Column[] = [];
      const flush = (): void => {
        this.padGroup(group);
        group = [];
      };
      let previousEnd = -1;
      for (const column of body) {
        if (!column) {
          flush();
          previousEnd = -1;
          continue;
        }
        if (group.length > 0 && !this.nextLine(previousEnd, column.name)) flush();
        group.push(column);
        previousEnd = this.lastOfColumn(column);
      }
      flush();
    }
  }

  private lastOfColumn(column: Column): number {
    if (column.open === undefined) return column.typeLast;
    return this.listsByOpen.get(column.open)?.close ?? column.typeLast;
  }

  private padGroup(group: readonly Column[]): void {
    if (group.length === 0) return;
    const names = group.map((c) => width(this.items[c.name].text));
    const types = group.map((c) => width(this.span(c.typeFirst, c.typeLast)));
    let nameWidth = 0;
    let typeWidth = 0;
    group.forEach((c, i) => {
      if (names[i] <= NAME_CAP) nameWidth = Math.max(nameWidth, names[i]);
      if (c.open !== undefined && types[i] <= TYPE_CAP) typeWidth = Math.max(typeWidth, types[i]);
    });
    group.forEach((c, i) => {
      this.sp[c.typeFirst] = ' '.repeat(1 + (names[i] <= NAME_CAP ? nameWidth - names[i] : 0));
      if (c.open !== undefined) this.sp[c.open] = ' '.repeat(1 + (types[i] <= TYPE_CAP ? Math.max(typeWidth - types[i], 0) : 0));
    });
  }

  private alignUses(): void {
    let group: UseLine[] = [];
    const flush = (): void => {
      const widths = group.map((u) => width(this.span(u.first, u.closeBrace)));
      const most = Math.max(0, ...widths.filter((w) => w <= USE_CAP));
      group.forEach((u, i) => {
        this.sp[u.from] = ' '.repeat(1 + (widths[i] <= USE_CAP ? most - widths[i] : 0));
      });
      group = [];
    };
    for (const use of this.uses) {
      if (!use) {
        flush();
        continue;
      }
      if (group.length > 0) {
        const previous = group[group.length - 1];
        if (!this.nextLine(previous.last, use.first)) flush();
      }
      group.push(use);
    }
    flush();
  }

  // -- settings lists -------------------------------------------------------

  private mustBreak(list: SettingsList): boolean {
    for (let k = list.open; k <= list.close; k++) {
      const item = this.items[k];
      if (item.kind === LINE_COMMENT || item.text.includes('\n')) return true;
      if (k > list.open && this.origNl[k] > 0 && (list.rule === 'keep' || list.internal.has(k))) return true;
      // An own-line `/* */` comment stays on its own line (F2), and a comment
      // that ended the line before `]` keeps `]` off it: joining either would
      // leave a space inside a bracket (`[ /* c */ x]`, `[x /* c */ ]`).
      if (k > list.open && this.origNl[k] > 0 && isComment(item)) return true;
      if (k === list.close && this.origNl[k] > 0 && isComment(this.items[k - 1])) return true;
    }
    return false;
  }

  private isBroken(list: SettingsList): boolean {
    return this.nl[list.close] > 0;
  }

  /** Lay `list` out on one line, or one setting per line. */
  private layoutList(list: SettingsList, broken: boolean): void {
    const { items } = this;
    for (let k = list.open + 1; k <= list.close; k++) {
      const prev = items[k - 1];
      const comment = isComment(items[k]);
      const prevComment = isComment(prev);
      const prevLine = prev.kind === LINE_COMMENT;
      let lineBreak = false;
      let separator = '';
      if (!broken) {
        if (comment || prevComment) separator = ' ';
        else if (k === list.close || k === list.open + 1 || list.commas.has(k)) separator = '';
        else if (list.commas.has(k - 1)) separator = ' ';
        else separator = list.inner.get(k) ?? this.sp[k];
      } else if (k === list.close || prevLine) {
        lineBreak = true;
      } else if (comment) {
        if (this.origNl[k] > 0) lineBreak = true;
        else separator = ' ';
      } else if (list.starts.has(k)) {
        lineBreak = true;
      } else if (list.commas.has(k)) {
        separator = prevComment ? ' ' : '';
      } else if (this.origNl[k] > 0) {
        lineBreak = true;
      } else {
        separator = prevComment ? ' ' : list.inner.get(k) ?? this.sp[k];
      }
      this.nl[k] = lineBreak ? 1 : 0;
      this.sp[k] = lineBreak ? '' : separator;
    }
  }

  /** The depth of the line each item is on, from the line breaks set so far. */
  private lineDepths(): Int32Array {
    const depths = new Int32Array(this.n);
    const stack: number[] = [];
    let depth = 0;
    for (let i = 0; i < this.n; i++) {
      const item = this.items[i];
      if (i === 0 || this.nl[i] > 0) {
        depth = CLOSERS.has(item.kind) ? (stack.length > 0 ? stack[stack.length - 1] : 0) : stack.length > 0 ? stack[stack.length - 1] + 1 : 0;
      }
      depths[i] = depth;
      if (OPENERS.has(item.kind)) stack.push(depth);
      else if (CLOSERS.has(item.kind)) stack.pop();
    }
    return depths;
  }

  /** The width of the line holding `list` with the list on one line (trailing comments not counted). */
  private singleLineWidth(list: SettingsList, depths: Int32Array): number {
    let start = list.open;
    while (start > 0 && this.nl[start] === 0) start--;
    let line = INDENT.repeat(depths[start]) + this.span(start, list.close);
    for (let k = list.close + 1; k < this.n && this.nl[k] === 0 && !isComment(this.items[k]); k++) line += this.sp[k] + this.items[k].text;
    const lastBreak = line.lastIndexOf('\n');
    return width(lastBreak === -1 ? line : line.slice(lastBreak + 1));
  }

  // -- whitespace rules -----------------------------------------------------

  /** One space between a comment and what is beside it on its line; a line break after a `//` comment. */
  private commentSpacing(): void {
    for (let i = 1; i < this.n; i++) {
      const prev = this.items[i - 1];
      if (prev.kind === LINE_COMMENT && this.nl[i] === 0) this.nl[i] = 1;
      if (this.nl[i] === 0 && (isComment(this.items[i]) || isComment(prev))) this.sp[i] = ' ';
    }
  }

  /**
   * No blank line at the start, straight after an opening bracket (or the
   * trailing comment on its line) or straight before a closing one.
   */
  private blankLines(): void {
    this.nl[0] = 0;
    for (let i = 1; i < this.n; i++) {
      if (this.nl[i] < 2) continue;
      let before = i - 1;
      while (before > 0 && isComment(this.items[before]) && this.nl[before] === 0) before--;
      if (OPENERS.has(this.items[before].kind) || CLOSERS.has(this.items[i].kind)) this.nl[i] = 1;
    }
  }
}
