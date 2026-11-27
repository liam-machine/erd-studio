/**
 * The words a parser diagnostic leaves core with, when the file holds sample
 * rows (D37: a `records` block). A cell may hold real data, and the parser
 * quotes some of it: an unquoted dotted value (`jane.doe`) is read as an enum
 * reference, and [4000] says `Enum 'jane' does not exist`. Every place a
 * parser message leaves a compile (the table reader, the multi-file compile,
 * the formatter's errors, Import DBML) passes it through
 * {@link dbmlMessageSanitiser}, which keeps the code, line and column and
 * replaces the text:
 *
 * - inside a block's header (the keyword and its list): `the header of the
 *   sample data (records) does not read as DBML`;
 * - inside its body: `a value in the sample data (records) does not read as
 *   DBML`;
 * - outside every block, in a file that holds a `records` token, when the
 *   message holds a value segment (a run of 3 or more word characters of the
 *   block's text) or quotes a token the file does not declare as a table,
 *   column, schema or enum name (the value backstop): `this line does not
 *   read as DBML`.
 *
 * Any other message is the parser's own. A false match costs only a plainer
 * message. A reader that quotes a node in its own message (a `use` or `Ref`
 * to move) quotes it through {@link messageSourceOf}. Nothing here reads the parser's data lints (its infos, its
 * warnings or its diagnostics provider): their messages quote values
 * (a boundary test keeps them out of every runtime file).
 */

import type { DbmlParserModule } from './parserModule.js';
import { PINNED_PARSER, elementType, parseSyntax, plainNames, stripBom, topLevel, type AstNode } from './parser.js';
import { recordsBlocksOf } from './records.js';

/** A diagnostic in a block's header. */
export const RECORDS_HEADER_MESSAGE = 'the header of the sample data (records) does not read as DBML';
/** A diagnostic in a block's body. */
export const RECORDS_VALUE_MESSAGE = 'a value in the sample data (records) does not read as DBML';
/** A diagnostic outside every block that may quote a value. */
export const UNREADABLE_LINE_MESSAGE = 'this line does not read as DBML';

/** Whether `text` may hold a `records` token (a cheap test: a comment or a string may match too). */
export function mayHoldRecords(text: string): boolean {
  return /\brecords\b/i.test(text);
}

/**
 * A node's source, collapsed to one line, for a message ERD Studio writes
 * itself (a `use` or `Ref` to move, a Ref that is not drawn). When the
 * slice may hold a `records` block (a parser accepts one nested where no
 * reader looks, such as inside a `Ref r { … }`), only its text up to the
 * first `{` is kept, as in `Ref r {…}`, so no row rides along.
 */
export function messageSourceOf(text: string, node: AstNode): string {
  const slice = text.slice(node.start, node.end);
  const brace = slice.indexOf('{');
  const shown = mayHoldRecords(slice) && brace >= 0 ? `${slice.slice(0, brace + 1)}…}` : slice;
  return shown.replace(/\s+/g, ' ').trim();
}

/**
 * The message for a parser that threw: its own message only when `text`
 * holds no `records` token, so nothing a block holds can ride along.
 */
export function parserStoppedMessage(err: unknown, text: string): string {
  if (mayHoldRecords(text)) return 'The DBML parser stopped.';
  return `The DBML parser stopped: ${err instanceof Error ? err.message : String(err)}`;
}

/** Runs of 3 or more word characters. */
const SEGMENT = /[\p{L}\p{N}_]{3,}/gu;
/** A quoted token in a parser message. */
const QUOTED = /'([^'\n]*)'|`([^`\n]*)`|"([^"\n]*)"/g;

interface Region {
  start: number;
  bodyStart: number;
  end: number;
}

/**
 * Replace a parser message that may hold a value: `message` and the offset
 * of its diagnostic (into `text`; undefined when the parser gave none) in,
 * the words to show out.
 */
export type DbmlMessageSanitiser = (message: string, offset: number | undefined) => string;

const identity: DbmlMessageSanitiser = (message) => message;

/**
 * The sanitiser for the parser messages of `text` (see the module comment).
 * Offsets are into `text` as given (a leading byte-order mark is counted).
 * A text without a `records` token gets the identity, at no cost; otherwise
 * the text is lexed and parsed once (no binding). `parser` is the pinned one
 * unless a test passes another.
 */
export function dbmlMessageSanitiser(text: string, parser: DbmlParserModule = PINNED_PARSER): DbmlMessageSanitiser {
  if (!mayHoldRecords(text)) return identity;
  const stripped = stripBom(text);
  const shift = text.length - stripped.length;
  let ast: AstNode | undefined;
  let tokens: AstNode[] = [];
  try {
    const parsed = parseSyntax(stripped, parser);
    ast = parsed.ast;
    tokens = parsed.tokens;
  } catch {
    // A parser that cannot even lex the text: every message may quote it.
    return () => UNREADABLE_LINE_MESSAGE;
  }
  const holdsRecords = tokens.some((t) => t?.kind === '<identifier>' && typeof t.value === 'string' && t.value.toLowerCase() === 'records');
  if (!holdsRecords) return identity;

  // The blocks, nested and top-level (offsets into `stripped`).
  const regions: Region[] = recordsBlocksOf(ast).map(({ node }) => {
    const close = node.body?.blockCloseBrace as AstNode | undefined;
    const end = close && typeof close.end === 'number' ? close.end : stripped.length;
    const bodyStart = typeof node.body?.start === 'number' ? Math.min(node.body.start, end) : end;
    return { start: node.start, bodyStart, end };
  });

  const declared = declaredNames(ast);
  // Value segments: every run in a block's body, and in its header but for the keyword and declared names.
  const segments = new Set<string>();
  const addRuns = (from: number, to: number, skipDeclared: boolean): void => {
    for (const run of stripped.slice(from, to).match(SEGMENT) ?? []) {
      if (skipDeclared && (declared.has(run) || run.toLowerCase() === 'records')) continue;
      segments.add(run);
    }
  };
  for (const r of regions) {
    addRuns(r.start, r.bodyStart, true);
    addRuns(r.bodyStart, r.end, false);
  }
  // A `records` token the syntax tree holds no block for (a header the parser read as something else):
  // its text, to the brace that closes what follows it, still counts as a block's for the backstop.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t?.kind !== '<identifier>' || typeof t.value !== 'string' || t.value.toLowerCase() !== 'records') continue;
    if (regions.some((r) => r.start <= t.start && t.start < r.end)) continue;
    let end = stripped.length;
    let depth = 0;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].kind === '<lbrace>') depth++;
      else if (tokens[j].kind === '<rbrace>' && --depth <= 0) {
        if (depth < 0) { end = tokens[j].start; break; }
        end = tokens[j].end;
        break;
      }
    }
    addRuns(t.start, end, true);
  }

  const quotesUndeclared = (message: string): boolean => {
    for (const m of message.matchAll(QUOTED)) {
      const quoted = m[1] ?? m[2] ?? m[3] ?? '';
      const parts = quoted.split('.').map((p) => p.trim().replace(/^"(.*)"$/, '$1'));
      if (parts.some((p) => !declared.has(p))) return true;
    }
    return false;
  };
  const holdsSegment = (message: string): boolean => (message.match(SEGMENT) ?? []).some((run) => segments.has(run));

  return (message, offset) => {
    if (offset !== undefined) {
      const at = offset - shift;
      for (const r of regions) {
        const inside = at >= r.start && (at < r.end || (at === r.end && r.end === stripped.length));
        if (!inside) continue;
        return at < r.bodyStart ? RECORDS_HEADER_MESSAGE : RECORDS_VALUE_MESSAGE;
      }
    }
    return holdsSegment(message) || quotesUndeclared(message) ? UNREADABLE_LINE_MESSAGE : message;
  };
}

/**
 * The table, column, schema and enum names `ast` declares (and each
 * element's alias, and each Enum value): the names a message may quote.
 */
function declaredNames(ast: AstNode | undefined): Set<string> {
  const names = new Set<string>();
  const add = (expr: AstNode | undefined): void => {
    for (const name of plainNames(expr) ?? []) names.add(name);
  };
  for (const node of topLevel(ast)) {
    const type = elementType(node)?.toLowerCase();
    if (type === undefined || type === 'records') continue;
    add(node.name);
    add(node.alias);
    if (type !== 'table' && type !== 'enum' && type !== 'tablepartial') continue;
    for (const inner of Array.isArray(node.body?.body) ? (node.body.body as AstNode[]) : []) {
      if (elementType(inner) !== undefined) continue; // a nested element (records, indexes, Note), not a column
      if (inner?.kind === '<function-application>') add(inner.callee);
      else add(inner);
    }
  }
  return names;
}
