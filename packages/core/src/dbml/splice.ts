/**
 * The splicer every DBML writer builds its output with (§4.5 of the native
 * DBML storage spec): text edits at parser node offsets, applied in one
 * pass, and the line, indent and end-of-line helpers they share. A writer
 * never regenerates a file; it replaces, inserts and cuts spans of the text
 * it read, so every byte outside the spans it changes stays as it was.
 *
 * Offsets are into the text without a leading byte-order mark (the writers
 * strip it before parsing and put it back after).
 */

import { DbmlEditRefused } from './errors.js';
import type { AstNode } from './parser.js';
import { lineAt, lineStartOf } from './parser.js';

/** Replace `text.slice(start, end)` with `text`; `start === end` inserts. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Apply `edits` to `text` in one pass. Edits are sorted by offset (inserts
 * at one offset keep the order they were given in, and go before a
 * replacement that starts there); two edits that overlap throw, since that
 * is a writer bug, never something a file can cause.
 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return text;
  const sorted = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => a.edit.start - b.edit.start
      || (a.edit.end - a.edit.start) - (b.edit.end - b.edit.start)
      || a.index - b.index)
    .map(({ edit }) => edit);
  let out = '';
  let at = 0;
  for (const edit of sorted) {
    if (edit.start < at || edit.end < edit.start || edit.end > text.length) {
      throw new Error(`DBML writer: overlapping or out-of-range edit [${edit.start}, ${edit.end}) after ${at}`);
    }
    out += text.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return out + text.slice(at);
}

/**
 * Run a writer so that an overlap of its edits (a writer bug two valid edits
 * can still meet) is refused as a {@link DbmlEditRefused} naming `file`: the
 * host shows it as a message and writes nothing, instead of failing with an
 * unexpected error.
 */
export function refuseOverlaps<T>(file: string, write: () => T): T {
  try {
    return write();
  } catch (err) {
    if (err instanceof Error && !(err instanceof DbmlEditRefused) && err.message.startsWith('DBML writer: overlapping')) {
      throw new DbmlEditRefused(file, `ERD Studio could not apply this change to ${file} safely, so nothing was written. Make the change in the file by hand.`);
    }
    throw err;
  }
}

/** `\r\n` when the file holds any, else `\n` (§2.2: the EOL comes from the file). */
export function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** The offset just past the line break of the line holding `offset` (the text's length on the last line). */
export function nextLineStart(text: string, offset: number): number {
  const at = text.indexOf('\n', Math.max(0, offset));
  return at < 0 ? text.length : at + 1;
}

/** The offset of the line break ending the line holding `offset` (`\r\n` counts from its `\r`), or the text's length. */
export function lineEndOf(text: string, offset: number): number {
  const at = text.indexOf('\n', Math.max(0, offset));
  if (at < 0) return text.length;
  return at > 0 && text[at - 1] === '\r' ? at - 1 : at;
}

/** The white space at the start of the line holding `offset`. */
export function indentAt(text: string, offset: number): string {
  const start = lineStartOf(text, offset);
  let end = start;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
  return text.slice(start, end);
}

/** Whether only spaces and tabs sit between the start of its line and `offset`. */
export function startsItsLine(text: string, offset: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStartOf(text, offset), offset));
}

/** Whether the line holding `offset` holds only white space. */
function isBlankLine(text: string, offset: number): boolean {
  return /^[ \t\r]*$/.test(text.slice(lineStartOf(text, offset), lineEndOf(text, offset)));
}

/** Whether the line holding `offset` is a `//` comment line. */
function isCommentLine(text: string, offset: number): boolean {
  return /^[ \t]*\/\//.test(text.slice(lineStartOf(text, offset), lineEndOf(text, offset)));
}

/** The node's own end: its `end`, or, when the parser gave none, its `fullEnd`. */
function nodeEnd(node: AstNode): number {
  return typeof node.end === 'number' ? node.end : node.fullEnd;
}

/**
 * The span that deletes `node` (§4.5 cut rule): from the start of the line
 * of its `start` to its `fullEnd` (its trailing same-line comment and line
 * break included). Never from `fullStart`, which covers the comment lines
 * above a node and, for a file's first element, the file's header. When
 * something else shares the line before the node, the cut starts at the
 * node itself.
 */
export function cutSpan(text: string, node: AstNode): { start: number; end: number } {
  const start = startsItsLine(text, node.start) ? lineStartOf(text, node.start) : node.start;
  const fullEnd = typeof node.fullEnd === 'number' ? node.fullEnd : nodeEnd(node);
  return { start, end: Math.max(fullEnd, nodeEnd(node)) };
}

/** A {@link TextEdit} that deletes `node` by the cut rule. */
export function cutEdit(text: string, node: AstNode): TextEdit {
  const { start, end } = cutSpan(text, node);
  return { start, end, text: '' };
}

/**
 * Where to insert a line before `node` without separating it from the
 * comment lines directly above it (no blank line between): the start of the
 * first of those lines, never earlier than `floor`.
 */
export function attachedStart(text: string, node: AstNode, floor = 0): number {
  let start = lineStartOf(text, node.start);
  if (!startsItsLine(text, node.start)) return node.start;
  while (start > floor) {
    const previous = lineStartOf(text, start - 1);
    if (previous < floor || !isCommentLine(text, previous)) break;
    start = previous;
  }
  return start;
}

/**
 * The end of a file's header comment (§4.5 step 5): when the file starts
 * with `//` comment lines that are followed by a blank line, the offset of
 * that blank line (where a block inserted after the header goes); else 0, so
 * a block never lands between a comment and the element it describes.
 */
export function headerEnd(text: string): number {
  if (!isCommentLine(text, 0)) return 0;
  let at = 0;
  while (at < text.length && isCommentLine(text, at)) {
    const next = nextLineStart(text, at);
    if (next === at || next >= text.length) return next >= text.length && text.endsWith('\n') ? next : 0;
    at = next;
  }
  return isBlankLine(text, at) ? at : 0;
}

/**
 * `text` without the edits' effect outside `[start, end)`: the slice of the
 * text in the range with every edit inside it applied (used to move a
 * column's block whole, with its own edits, when columns are reordered).
 */
export function sliceWithEdits(text: string, edits: readonly TextEdit[], start: number, end: number): string {
  const inside = edits
    .filter((e) => e.start >= start && e.end <= end)
    .map((e) => ({ start: e.start - start, end: e.end - start, text: e.text }));
  return applyTextEdits(text.slice(start, end), inside);
}

/** Lines joined with `eol`, each ending with it. */
export function linesOf(lines: readonly string[], eol: string): string {
  return lines.map((l) => l + eol).join('');
}

/** What happens to one attribute list (a table's, or one column's settings). */
export interface ListPlan {
  /** The list, or null when there is none yet and settings are added. */
  list: AstNode | null;
  /** Where a new list goes when there is none. */
  anchor: number;
  /** One per element: undefined = unchanged, null = removed, text = replaced. */
  elements: Array<string | null | undefined>;
  /** New settings, in the order to write them. */
  added: Array<{ order: number; text: string }>;
  /** A table's new list goes one setting per line when it holds more than one. */
  multiLineWhenNew: boolean;
}

/**
 * The edits for one attribute list. A list on one line is rebuilt from its
 * kept elements (each with its own text) and the new ones, `, `-separated;
 * a list over several lines is edited line by line, so its comments and
 * layout stay: a removed setting loses its line, a new one gets its own line
 * before `]`, and commas are kept exactly where a later element needs one.
 * A list left empty is removed with the space before it.
 */
export function renderListPlan(text: string, plan: ListPlan, eol: string): TextEdit[] {
  const added = [...plan.added].sort((a, b) => a.order - b.order).map((a) => a.text);
  const changed = plan.elements.some((e) => e !== undefined) || added.length > 0;
  if (!changed) return [];
  const list = plan.list;
  if (!list) {
    if (added.length === 0) return [];
    const before = plan.anchor > 0 && !/\s/.test(text[plan.anchor - 1]) ? ' ' : '';
    const atBody = text[plan.anchor] === '{';
    if (plan.multiLineWhenNew && added.length > 1) {
      return [{ start: plan.anchor, end: plan.anchor, text: `${before}[${eol}${added.map((a, i) => `  ${a}${i < added.length - 1 ? ',' : ''}`).join(eol)}${eol}]${atBody ? ' ' : ''}` }];
    }
    return [{ start: plan.anchor, end: plan.anchor, text: atBody ? `${before}[${added.join(', ')}] ` : ` [${added.join(', ')}]` }];
  }
  const elements: AstNode[] = Array.isArray(list.elementList) ? list.elementList : [];
  const commas: AstNode[] = Array.isArray(list.commaList) ? list.commaList : [];
  const kept = elements.map((_, i) => plan.elements[i] !== null);
  const elementText = (i: number): string => {
    const replaced = plan.elements[i];
    return typeof replaced === 'string' ? replaced : text.slice(elements[i].start, elements[i].end);
  };
  const keptCount = kept.filter(Boolean).length;
  if (keptCount === 0 && added.length === 0) {
    // The list goes with the white space before it: `Table x [a] {` → `Table x {`, `a int [pk]` → `a int`.
    let start = list.start as number;
    while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
    return [{ start, end: list.end, text: '' }];
  }
  // One setting per line: a line break between the elements (or by a bracket), not only inside a value.
  const gaps: string[] = [];
  let at = (list.listOpenBracket?.end ?? list.start + 1) as number;
  for (const element of elements) {
    gaps.push(text.slice(at, element.start));
    at = element.end;
  }
  gaps.push(text.slice(at, (list.listCloseBracket?.start ?? list.end - 1) as number));
  const multiLine = gaps.some((g) => g.includes('\n'));
  // A one-line list is rebuilt from its elements unless a `/* … */` comment sits between them (Law 4):
  // then it is spliced element by element, as a multi-line list is.
  if (!multiLine && !gaps.some((g) => g.includes('/*'))) {
    const parts: string[] = [];
    elements.forEach((_, i) => { if (kept[i]) parts.push(elementText(i)); });
    parts.push(...added);
    return [{ start: list.start, end: list.end, text: `[${parts.join(', ')}]` }];
  }
  const edits: TextEdit[] = [];
  const cuts: Array<{ start: number; end: number }> = [];
  elements.forEach((element, i) => {
    const replaced = plan.elements[i];
    if (typeof replaced === 'string') edits.push({ start: element.start, end: element.end, text: replaced });
    if (replaced !== null) return;
    const comma = commas[i];
    const lastEnd = comma && lineAt(text, comma.end) === lineAt(text, element.end) ? comma.end : element.end;
    const rest = text.slice(lastEnd, nextLineStart(text, lastEnd));
    const alone = startsItsLine(text, element.start) && /^[ \t]*(\/\/[^\n]*)?\r?\n?$/.test(rest) && !rest.includes(']');
    if (alone) {
      const start = text.lastIndexOf('\n', element.start - 1) + 1;
      const span = { start, end: nextLineStart(text, lastEnd) };
      cuts.push(span);
      edits.push({ ...span, text: '' });
    } else {
      cuts.push({ start: element.start, end: element.end });
      edits.push({ start: element.start, end: element.end, text: '' });
    }
  });
  const inCut = (node: AstNode): boolean => cuts.some((c) => node.start >= c.start && node.end <= c.end);
  const lastKept = kept.lastIndexOf(true);
  commas.forEach((comma, j) => {
    const needed = kept[j] && (kept.slice(j + 1).some(Boolean) || added.length > 0);
    if (!needed && !inCut(comma)) edits.push({ start: comma.start, end: comma.end, text: '' });
  });
  if (added.length > 0) {
    const close = list.listCloseBracket as AstNode;
    const indent = elements.length > 0 ? indentAt(text, elements[0].start) : '  ';
    if (lastKept >= 0 && !commas[lastKept]) edits.push({ start: elements[lastKept].end, end: elements[lastKept].end, text: ',' });
    if (!multiLine) {
      // One line: after the last kept element (and its comma), or straight after `[`.
      const comma = lastKept >= 0 ? commas[lastKept] : undefined;
      const at = lastKept < 0 ? (list.listOpenBracket?.end ?? list.start + 1) as number : comma ? comma.end : elements[lastKept].end;
      const lead = lastKept < 0 ? '' : ' ';
      edits.push({ start: at, end: at, text: `${lead}${added.join(', ')}${lastKept < 0 && keptCount === 0 && elements.length > 0 ? ' ' : ''}` });
    } else if (startsItsLine(text, close.start)) {
      const at = text.lastIndexOf('\n', close.start - 1) + 1;
      edits.push({ start: at, end: at, text: added.map((a, i) => `${indent}${a}${i < added.length - 1 ? ',' : ''}${eol}`).join('') });
    } else {
      const at = lastKept >= 0 ? elements[lastKept].end : close.start;
      edits.push({ start: at, end: at, text: added.map((a, i) => `${i === 0 && lastKept < 0 ? '' : eol}${indent}${a}${i < added.length - 1 ? ',' : ''}`).join('') });
    }
  }
  return edits;
}
