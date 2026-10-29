/**
 * The one wrapper around the DBML parser (internal: never exported from the
 * subpath). Every reader compiles one file at a time under a fixed virtual
 * path, never the real one, so a read never depends on where the project
 * lives (10.3.1, which the tests feed, drops the tables of an imported file
 * when any folder in its path holds a space). A file path is read only
 * through `Filepath#absolute`, never the `filepath` JSON, which differs
 * between parser versions.
 *
 * The AST is read loosely: its node shapes (kinds, fields and offsets) are
 * the same in 9.1.1, 10.3.1 and 11.0.0, but typed per release, so nothing
 * here names a parser type.
 */

import { Compiler, Filepath, MemoryProjectLayout } from '@dbml/parse';
import { dbmlErrorClassOf, type DbmlErrorClass } from '../domain.js';
import type { DbmlParserModule } from './parserModule.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** An AST node, read loosely. */
export type AstNode = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The pinned DBML parser (11.0.0). */
export const PINNED_PARSER: DbmlParserModule = { Compiler, MemoryProjectLayout, Filepath };

/** Set while {@link withKeptFilepathKeys} has a parser's method replaced. */
let keepingFilepathKeys = false;

/**
 * Run `work` with each of `parser`'s `Filepath`s computing its cache key
 * once. The 11.0 Compiler rebuilds the key (every path segment through
 * `encodeURIComponent`) for every query it caches, about a third of a
 * compile; a Filepath's root and segments are set in its constructor and
 * never change, so the key is kept for it (in a WeakMap, never on the
 * object). The parser's own method is put back afterwards, also when `work`
 * throws; a parser without the method, or a call nested in another, runs as is.
 */
export function withKeptFilepathKeys<T>(parser: DbmlParserModule, work: () => T): T {
  const proto = (parser.Filepath as { prototype?: { toKey?: () => string } }).prototype;
  const original = proto?.toKey;
  if (!proto || typeof original !== 'function' || keepingFilepathKeys) return work();
  const kept = new WeakMap<object, string>();
  keepingFilepathKeys = true;
  proto.toKey = function keptKey(this: object): string {
    let key = kept.get(this);
    if (key === undefined) {
      key = original.call(this);
      kept.set(this, key);
    }
    return key;
  };
  try {
    return work();
  } finally {
    proto.toKey = original;
    keepingFilepathKeys = false;
  }
}

/** Where a single file is compiled: fixed, and free of spaces. */
export const VIRTUAL_PATH = '/erd-studio/file.dbml';

/** One parser diagnostic: 1-based line and column, the offset, the numeric code and its class. */
export interface ParserDiagnostic {
  code: number;
  message: string;
  line: number;
  column: number;
  /** Offset into the compiled text (equal to the original text's: blanking keeps offsets). */
  start: number;
  errorClass: DbmlErrorClass;
  /** The file it is in (`Filepath#absolute`), when the parser said. */
  file?: string;
}

/** A single-file compile. */
export interface CompiledFile {
  /** The program node: `body` holds the top-level declarations. */
  ast: AstNode;
  errors: ParserDiagnostic[];
  /** The interpreted database, or undefined when the file has errors. */
  rawDb(): AstNode | undefined;
}

/** `text` without a leading byte-order mark, which every parser rejects (`[1000]`). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The offsets just after each `\n` of the last text {@link lineAt} was asked
 * about. A reader asks for the line of every Ref in one file, so scanning
 * from the start each time made reading a 30,000-Ref relationships file
 * quadratic (§7.6).
 */
let lineIndex: { text: string; breaks: number[] } | undefined;

/** 1-based line of `offset` in `text`. */
export function lineAt(text: string, offset: number): number {
  if (lineIndex === undefined || lineIndex.text !== text) {
    const breaks: number[] = [];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) breaks.push(i);
    lineIndex = { text, breaks };
  }
  const end = Math.min(Math.max(offset, 0), text.length);
  // The number of line breaks before `end`, by binary search.
  const { breaks } = lineIndex;
  let lo = 0;
  let hi = breaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (breaks[mid] < end) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/** The offset where the line holding `offset` starts. */
export function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', Math.max(offset - 1, -1)) + 1;
}

/** A parser error as a {@link ParserDiagnostic}, located from its node or token (0-based in the parser). */
export function diagnosticOf(error: unknown, text: string): ParserDiagnostic {
  const e = (error && typeof error === 'object' ? error : {}) as AstNode;
  const node = (e.nodeOrToken && typeof e.nodeOrToken === 'object' ? e.nodeOrToken : {}) as AstNode;
  const code = Number(e.code);
  const start = typeof e.start === 'number' ? e.start : typeof node.start === 'number' ? node.start : 0;
  const pos = node.startPos as { line?: number; column?: number } | undefined;
  let line: number;
  let column: number;
  if (pos && typeof pos.line === 'number' && typeof pos.column === 'number') {
    line = pos.line + 1;
    column = pos.column + 1;
  } else {
    line = lineAt(text, start);
    column = start - lineStartOf(text, start) + 1;
  }
  const filepath = (e.filepath ?? node.filepath) as { absolute?: unknown } | undefined;
  const file = filepath && typeof filepath.absolute === 'string' ? filepath.absolute : undefined;
  const message = typeof e.diagnostic === 'string' && e.diagnostic ? e.diagnostic : e instanceof Error ? e.message : String(e.message ?? error);
  return {
    code: Number.isFinite(code) ? code : 0,
    message,
    line,
    column,
    start,
    errorClass: dbmlErrorClassOf(Number.isFinite(code) ? code : 0),
    ...(file !== undefined ? { file } : {}),
  };
}

// A small cache of compiles, keyed by parser and text: the writers (S3)
// re-read the text the reader just read. Diagrams have their own, so that
// reading a diagram's hundreds of tables does not push the diagram itself
// out before the edit that follows reads it again.
const CACHE_SIZE = 32;
const cache = new Map<string, CompiledFile>();
const DIAGRAM_CACHE_SIZE = 8;
const diagramCache = new Map<string, CompiledFile>();
const parserIds = new WeakMap<object, number>();
let nextParserId = 1;

function parserId(parser: DbmlParserModule): number {
  let id = parserIds.get(parser as object);
  if (id === undefined) {
    id = nextParserId++;
    parserIds.set(parser as object, id);
  }
  return id;
}

/**
 * Compile `text` on its own under `virtualPath`. Never throws for bad DBML
 * (the errors say what is wrong); a parser that throws is passed through.
 * `diagram` keeps the compile in the diagrams' own cache.
 */
export function compileOne(
  text: string,
  parser: DbmlParserModule = PINNED_PARSER,
  virtualPath: string = VIRTUAL_PATH,
  options: { diagram?: boolean } = {},
): CompiledFile {
  const store = options.diagram ? diagramCache : cache;
  const size = options.diagram ? DIAGRAM_CACHE_SIZE : CACHE_SIZE;
  const key = `${parserId(parser)}\u0000${virtualPath}\u0000${text}`;
  const cached = store.get(key);
  if (cached) {
    store.delete(key);
    store.set(key, cached);
    return cached;
  }
  const layout = new parser.MemoryProjectLayout();
  const entry = parser.Filepath.from(virtualPath);
  layout.setSource(entry, text);
  const compiler = new parser.Compiler(layout);
  const [ast, errors] = withKeptFilepathKeys(parser, () => [
    compiler.parse.ast(entry) as AstNode,
    ((compiler.parse.errors(entry) ?? []) as unknown[]).map((d) => diagnosticOf(d, text)),
  ] as const);
  let db: AstNode | undefined | null = null;
  const compiled: CompiledFile = {
    ast: (ast && typeof ast === 'object' && 'ast' in ast && ast.ast ? ast.ast : ast) as AstNode,
    errors,
    rawDb: () => {
      if (db === null) db = errors.length > 0 ? undefined : withKeptFilepathKeys(parser, () => compiler.parse.rawDb(entry) as AstNode | undefined);
      return db;
    },
  };
  store.set(key, compiled);
  if (store.size > size) store.delete(store.keys().next().value as string);
  return compiled;
}

/** The program's top-level declarations. */
export function topLevel(ast: AstNode | undefined): AstNode[] {
  return Array.isArray(ast?.body) ? (ast!.body as AstNode[]) : [];
}

/** An element declaration's keyword (`Table`, `Ref`, `Project`, …), or undefined for a `use` line. */
export function elementType(node: AstNode): string | undefined {
  return node?.kind === '<element-declaration>' && typeof node.type?.value === 'string' ? node.type.value : undefined;
}

/** Whether `node` is a `use` declaration. */
export function isUseDeclaration(node: AstNode): boolean {
  return node?.kind === '<use-declaration>';
}

/** One name of a dotted DBML expression: a name, or a parenthesised list of names (`(a, b)`). */
export type NameFragment = string | string[];

/**
 * The names of a dotted expression, left to right: `gold.x.(a, b)` →
 * `['gold', 'x', ['a', 'b']]`; quoted names unquoted. Null for anything
 * else (a literal, an operator, a call).
 */
export function nameFragments(expr: AstNode | undefined): NameFragment[] | null {
  if (!expr || typeof expr !== 'object') return null;
  switch (expr.kind) {
    case '<primary-expression>':
      return nameFragments(expr.expression);
    case '<variable>': {
      const value = expr.variable?.value;
      return typeof value === 'string' ? [value] : null;
    }
    case '<infix-expression>': {
      if (expr.op?.value !== '.') return null;
      const left = nameFragments(expr.leftExpression);
      const right = nameFragments(expr.rightExpression);
      return left && right ? [...left, ...right] : null;
    }
    case '<tuple-expression>': {
      const names: string[] = [];
      for (const element of Array.isArray(expr.elementList) ? expr.elementList : []) {
        const inner = nameFragments(element);
        if (!inner || inner.length !== 1 || typeof inner[0] !== 'string') return null;
        names.push(inner[0]);
      }
      return names.length > 0 ? [names] : null;
    }
    default:
      return null;
  }
}

/** The plain names of a dotted name (`gold.x` → `['gold', 'x']`), or null when a part is a list or not a name. */
export function plainNames(expr: AstNode | undefined): string[] | null {
  const fragments = nameFragments(expr);
  if (!fragments || fragments.some((f) => typeof f !== 'string')) return null;
  return fragments as string[];
}

/** An attribute's name (`note`, `ref`, `primary key`), lower-cased. */
export function attributeName(attribute: AstNode): string {
  const ids = Array.isArray(attribute?.name?.identifiers) ? attribute.name.identifiers : [];
  return ids.map((i: AstNode) => String(i?.value ?? '')).join(' ').toLowerCase();
}

/**
 * Replace every character of each span with a space, keeping line breaks,
 * so offsets, lines and columns stay where they were.
 */
export function blankSpans(text: string, spans: ReadonlyArray<{ start: number; end: number }>): string {
  if (spans.length === 0) return text;
  const chars = text.split('');
  for (const { start, end } of spans) {
    for (let i = Math.max(0, start); i < Math.min(end, chars.length); i++) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  }
  return chars.join('');
}

/**
 * The spans to blank to remove some attributes of a `[ … ]` list, with the
 * commas between them; the whole list (brackets included) when none is left.
 */
export function attributeRemovalSpans(list: AstNode, remove: ReadonlySet<number>): Array<{ start: number; end: number }> {
  const elements: AstNode[] = Array.isArray(list?.elementList) ? list.elementList : [];
  const commas: AstNode[] = Array.isArray(list?.commaList) ? list.commaList : [];
  if (remove.size === 0) return [];
  if (elements.every((_, i) => remove.has(i))) return [{ start: list.start, end: list.end }];
  const spans: Array<{ start: number; end: number }> = [];
  elements.forEach((element, i) => {
    if (remove.has(i)) spans.push({ start: element.start, end: element.end });
  });
  // Keep one comma before each kept element that has a kept element before it.
  commas.forEach((comma, j) => {
    const keepsNext = !remove.has(j + 1);
    const keptBefore = elements.slice(0, j + 1).some((_, i) => !remove.has(i));
    if (!(keepsNext && keptBefore)) spans.push({ start: comma.start, end: comma.end });
  });
  return spans;
}

/** A custom-property value as text, and whether it was an 11.0 typed (unquoted number or boolean) value. */
export interface PropertyText {
  text: string;
  typed: boolean;
}

/**
 * One custom value, whichever parser read it: a plain string (9.x / 10.x),
 * or `{ value, type, token }` (11.0). For an 11.0 `number` or `bool` it is
 * the literal's own source text (the attribute token's text after its `:`,
 * trimmed), so `007` reads `'007'` and `1.50` reads `'1.50'`, with
 * `typed: true`. Undefined for anything else.
 */
export function propertyText(value: unknown, text: string): PropertyText | undefined {
  if (typeof value === 'string') return { text: value, typed: false };
  if (typeof value === 'number' || typeof value === 'boolean') return { text: String(value), typed: true };
  if (!value || typeof value !== 'object' || !('value' in value)) return undefined;
  const v = value as AstNode;
  const inner = v.value;
  const typed = v.type === 'number' || v.type === 'bool' || typeof inner === 'number' || typeof inner === 'boolean';
  if (!typed) return typeof inner === 'string' ? { text: inner, typed: false } : undefined;
  const start = v.token?.start?.offset;
  const end = v.token?.end?.offset;
  if (typeof start === 'number' && typeof end === 'number' && end > start && end <= text.length) {
    const source = text.slice(start, end);
    const colon = source.indexOf(':');
    if (colon >= 0) {
      const literal = source.slice(colon + 1).trim();
      if (literal !== '') return { text: literal, typed: true };
    }
  }
  return { text: String(inner), typed: true };
}
