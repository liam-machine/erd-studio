/**
 * Read one relationships file (`<layer>/relationships/<f>.dbml`, §1.3 of the
 * 2.0 tree design) Ref by Ref, from the AST alone. Binding
 * errors — a `use` target that is gone, a deleted table file, a wrong-case
 * name — never hide a Ref: the AST still holds every Ref node with its
 * offsets, so each one is read on its own. Only a syntax error or git
 * conflict markers make the file unreadable.
 *
 * The Refs come back canonical (the foreign-key end is `fromModel`) with
 * their table parts as spelled in the file and each end's schema qualifier
 * as written (ends are matched by table name alone); `attachRelationships`
 * (main entry) maps them onto tables, orients the one-to-ones that need keys,
 * respells and dedupes.
 */

import type { Cardinality, Relationship } from '../types/semantic.js';
import type { DbmlOneToOneDirection, DbmlProblem, DbmlRelationshipsReading, DbmlStoredRef } from '../types/dbmlStorage.js';
import { findConflictMarkers } from '../mergeConflict.js';
import { DBML_PENDING_REF_PATTERN } from '../dbmlRichProperties.js';
import { normaliseRelationshipRole } from '../relationships.js';
import type { DbmlParserModule } from './parserModule.js';
import {
  PINNED_PARSER,
  compileOne,
  elementType,
  isUseDeclaration,
  lineAt,
  nameFragments,
  plainNames,
  stripBom,
  topLevel,
  type AstNode,
  type CompiledFile,
} from './parser.js';

/** One end of a Ref: its table part (qualifier removed), the qualifier as written, and its columns. */
interface RefEnd {
  table: string;
  qualifier?: string;
  columns: string[];
}

/** `gold.x.col`, `x.col`, `x.(a, b)` → the table part, its qualifier and its columns; null for anything else. */
function refEnd(expr: AstNode | undefined): RefEnd | null {
  const fragments = nameFragments(expr);
  if (!fragments || fragments.length < 2 || fragments.length > 3) return null;
  const last = fragments[fragments.length - 1];
  const table = fragments[fragments.length - 2];
  if (typeof table !== 'string' || table === '') return null;
  if (fragments.length === 3 && typeof fragments[0] !== 'string') return null;
  const columns = typeof last === 'string' ? [last] : last;
  if (columns.length === 0 || columns.some((c) => c === '')) return null;
  return fragments.length === 3 ? { table, qualifier: fragments[0] as string, columns } : { table, columns };
}

/** The `<function-application>` holding a Ref's ends: the short form's body, or the block form's one line. */
function refApplication(node: AstNode): AstNode | undefined {
  const body = node.body;
  if (body?.kind === '<function-application>') return body;
  if (body?.kind === '<block-expression>' && Array.isArray(body.body)) {
    const lines = (body.body as AstNode[]).filter((n) => n?.kind === '<function-application>');
    return lines.length === 1 ? lines[0] : undefined;
  }
  return undefined;
}

/** A Ref name (its role), as written, or undefined when it has none. */
function refName(node: AstNode): string | undefined {
  if (!node.name) return undefined;
  const names = plainNames(node.name);
  return names && names.length > 0 ? names.join('.') : undefined;
}

interface Oriented {
  from: RefEnd;
  to: RefEnd;
  cardinality: Cardinality;
  oneToOneDirection?: DbmlOneToOneDirection;
}

/**
 * The canonical reading of `left <op> right` (§2.3): `>` from = left;
 * `<` many-to-one from = right; `<>` from = left; `-` by its one `?` mark
 * (`?-` marks the right end, `-?` the left), else the second end, left to
 * the keys (`attachRelationships`). A `?` never changes the cardinality.
 */
function orient(op: string, left: RefEnd, right: RefEnd): Oriented | null {
  const marksRight = op.startsWith('?');
  const marksLeft = op.endsWith('?');
  const bare = op.replace(/\?/g, '');
  switch (bare) {
    case '>':
      return { from: left, to: right, cardinality: 'many-to-one' };
    case '<':
      return { from: right, to: left, cardinality: 'many-to-one' };
    case '<>':
      return { from: left, to: right, cardinality: 'many-to-many' };
    case '-':
      if (marksRight !== marksLeft) {
        return marksRight
          ? { from: right, to: left, cardinality: 'one-to-one', oneToOneDirection: 'mark' }
          : { from: left, to: right, cardinality: 'one-to-one', oneToOneDirection: 'mark' };
      }
      return { from: right, to: left, cardinality: 'one-to-one', oneToOneDirection: 'keys' };
    default:
      return null;
  }
}

/** The source of a node, collapsed to one line, for a message. */
function sourceOf(text: string, node: AstNode): string {
  return text.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
}

/**
 * Read a relationships file. Never throws: a file that cannot be read is
 * `{ readable: false }` with a problem saying why, and a single Ref that
 * cannot be read is skipped with a problem. `parser` is the pinned
 * DBML parser unless a test passes another.
 */
export function readRelationshipsDbml(rawText: string, parser: DbmlParserModule = PINNED_PARSER): DbmlRelationshipsReading {
  const text = stripBom(rawText);
  const problems: DbmlProblem[] = [];
  const conflict = findConflictMarkers(text);
  if (conflict !== null) {
    return {
      readable: false,
      refs: [],
      problems: [{
        line: conflict, severity: 'error', mergeConflict: true, code: 'mergeConflict',
        message: `The relationships file has unresolved git merge conflicts (first at line ${conflict}); resolve them in the file. No relationship is read from it until then.`,
      }],
    };
  }
  let compiled: CompiledFile;
  try {
    compiled = compileOne(text, parser);
  } catch (err) {
    return {
      readable: false,
      refs: [],
      problems: [{ severity: 'error', code: 1000, message: `The DBML parser stopped: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
  const syntax = compiled.errors.filter((d) => d.errorClass === 'syntax').sort((a, b) => a.start - b.start);
  if (syntax.length > 0) {
    const d = syntax[0];
    return {
      readable: false,
      refs: [],
      problems: [{
        line: d.line, column: d.column, code: d.code, severity: 'error',
        message: `Line ${d.line}, column ${d.column}: ${d.message} [${d.code}]. No relationship is read from the file until it is fixed.`,
      }],
    };
  }

  const refs = refsOf(text, compiled, problems);
  const pending = readPendingRefs(text, parser, problems, topLevel(compiled.ast));
  const otherElements = otherElementsOf(text, compiled);
  const uses = useImportsOf(compiled);
  return {
    readable: true,
    refs,
    problems,
    ...(pending.length > 0 ? { pending } : {}),
    ...(otherElements.length > 0 ? { otherElements } : {}),
    ...(uses.length > 0 ? { uses } : {}),
  };
}

/** Each `use` line's path as written, in file order (an index resolves them against the file's folder). */
function useImportsOf(compiled: CompiledFile): string[] {
  const out: string[] = [];
  for (const node of topLevel(compiled.ast)) {
    if (!isUseDeclaration(node)) continue;
    const importPath = node.importPath?.value;
    if (typeof importPath === 'string') out.push(importPath);
  }
  return out;
}

/**
 * The top-level elements a relationships file should not hold (§1.3):
 * anything but `use` lines and Refs, each with its kind as written.
 */
function otherElementsOf(text: string, compiled: CompiledFile): Array<{ kind: string; line: number }> {
  const out: Array<{ kind: string; line: number }> = [];
  for (const node of topLevel(compiled.ast)) {
    if (isUseDeclaration(node)) continue;
    const kind = elementType(node);
    if (kind?.toLowerCase() === 'ref') continue;
    out.push({ kind: kind ?? 'element', line: lineAt(text, node.start) });
  }
  return out;
}

/** Every Ref of a compiled text, Ref by Ref (a Ref that cannot be read is skipped with a problem). */
function refsOf(text: string, compiled: CompiledFile, problems: DbmlProblem[], lineOffset = 0, what = ''): DbmlStoredRef[] {
  const refs: DbmlStoredRef[] = [];
  for (const node of topLevel(compiled.ast)) {
    if (elementType(node)?.toLowerCase() !== 'ref') continue;
    const line = lineAt(text, node.start) + lineOffset;
    const skip = (why: string): void => {
      problems.push({ line, severity: 'warning', code: 'unreadableRef', message: `Line ${line}: ${what}\`${sourceOf(text, node)}\` ${why}; it is not drawn.` });
    };
    const application = refApplication(node);
    const callee = application?.callee;
    const op = callee?.kind === '<infix-expression>' && typeof callee.op?.value === 'string' ? callee.op.value as string : undefined;
    if (!callee || op === undefined) {
      skip('is not one `Ref: a.x > b.y` line');
      continue;
    }
    const left = refEnd(callee.leftExpression);
    const right = refEnd(callee.rightExpression);
    if (!left || !right) {
      skip('does not name a table and column at each end');
      continue;
    }
    if (left.columns.length !== right.columns.length) {
      skip('has a different number of columns at each end');
      continue;
    }
    const oriented = orient(op, left, right);
    if (!oriented) {
      skip(`uses the operator \`${op}\`, which is not a relationship`);
      continue;
    }
    const sameColumns = left.table.toLowerCase() === right.table.toLowerCase()
      && left.columns.every((c, i) => c.toLowerCase() === right.columns[i].toLowerCase());
    if (sameColumns) {
      skip('joins a column set to itself');
      continue;
    }
    const role = normaliseRelationshipRole(refName(node));
    const relationships: Relationship[] = oriented.from.columns.map((fromColumn, i) => ({
      fromModel: oriented.from.table,
      fromColumn,
      toModel: oriented.to.table,
      toColumn: oriented.to.columns[i],
      cardinality: oriented.cardinality,
      ...(role !== undefined ? { role } : {}),
    }));
    refs.push({
      owner: oriented.from.table,
      target: oriented.to.table,
      ...(oriented.from.qualifier !== undefined ? { ownerQualifier: oriented.from.qualifier } : {}),
      ...(oriented.to.qualifier !== undefined ? { targetQualifier: oriented.to.qualifier } : {}),
      relationships,
      start: node.start,
      fullEnd: typeof node.fullEnd === 'number' ? node.fullEnd : node.end,
      line,
      ...(oriented.oneToOneDirection !== undefined ? { oneToOneDirection: oriented.oneToOneDirection } : {}),
    });
  }
  return refs;
}

/**
 * The pending relationships of a file (D27): each whole-line
 * `// erd-studio pending: Ref …` comment, its Ref compiled on its own (so
 * one that does not read never hides another), with the comment line's
 * span and line. Shared by the relationships reader and the diagram reader.
 */
export function readPendingRefs(text: string, parser: DbmlParserModule, problems: DbmlProblem[], nodes: readonly AstNode[]): DbmlStoredRef[] {
  if (!/erd-studio pending:/i.test(text)) return [];
  // Only a comment between top-level elements: never text inside one (a Note's body, a Ref block), nor
  // inside a /* … */ block comment (lines a user commented out are not read).
  const blocks = blockCommentSpans(text);
  const inside = (offset: number): boolean => nodes.some((n) => typeof n.start === 'number' && typeof n.end === 'number' && n.start <= offset && offset < n.end)
    || blocks.some((b) => b.start <= offset && offset < b.end);
  const out: DbmlStoredRef[] = [];
  let offset = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const start = offset;
    offset += raw.length + 1;
    const match = DBML_PENDING_REF_PATTERN.exec(raw.replace(/\r$/, ''));
    if (!match || inside(start + raw.indexOf('/'))) continue;
    const line = i + 1;
    const refText = match[1];
    let compiled: CompiledFile;
    try {
      compiled = compileOne(refText, parser);
    } catch {
      problems.push({ line, severity: 'warning', code: 'unreadableRef', message: `Line ${line}: the pending relationship \`${refText}\` is not one \`Ref: a.x > b.y\` line; it is not drawn.` });
      continue;
    }
    if (compiled.errors.some((d) => d.errorClass === 'syntax') || !topLevel(compiled.ast).some((n) => elementType(n)?.toLowerCase() === 'ref')) {
      problems.push({ line, severity: 'warning', code: 'unreadableRef', message: `Line ${line}: the pending relationship \`${refText}\` is not one \`Ref: a.x > b.y\` line; it is not drawn.` });
      continue;
    }
    for (const ref of refsOf(refText, compiled, problems, line - 1, 'the pending relationship ')) {
      out.push({ ...ref, start, fullEnd: Math.min(offset, text.length), pending: true });
    }
  }
  return out;
}


/**
 * The `/* … *\/` block comments of a DBML text, as offset spans (an
 * unclosed one runs to the end). Strings (`'…'`, `'''…'''`, `"…"`, backticks)
 * and `//` line comments are skipped, so a `/*` inside them opens nothing.
 */
export function blockCommentSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? text.length : close + 2;
      spans.push({ start: i, end });
      i = end;
      continue;
    }
    if (c === "'" && text.startsWith("'''", i)) {
      const close = text.indexOf("'''", i + 3);
      i = close < 0 ? text.length : close + 3;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    i++;
  }
  return spans;
}
