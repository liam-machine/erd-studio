/**
 * `erd_layout` in a DBML diagram: reading it from the first Project (the
 * FIRST entry of the key, in any case, where the parser's own database keeps
 * the last), and the layout-only edit a canvas drag makes, which splices one
 * span of the file and never formats it. The value's format and the
 * canonical form every write produces are `../erdLayout.ts`.
 *
 * The value is the parser's decoded string literal, taken from the AST,
 * never re-decoded by a regex. A line inside it must never end with `\`:
 * DBML joins it with the next line (the writer writes `\` as `\\`).
 */

import { dbmlName, dbmlString } from '../dbmlText.js';
import {
  erdLayoutOf,
  readErdLayout,
  renderErdLayoutValue,
  sameErdLayout,
  withMemberSpelling,
  type ErdLayout,
  type ErdLayoutReading,
} from '../erdLayout.js';
import { DBML_DIAGRAM_PROPERTIES } from '../dbmlRichProperties.js';
import type { Annotation, NodePosition } from '../types/semantic.js';
import { DbmlEditRefused } from './errors.js';
import type { DbmlParserModule } from './parserModule.js';
import { diagramMembersFromAst } from './readDiagram.js';
import { PINNED_PARSER, elementType, lineAt, lineStartOf, parseSyntax, plainNames, stripBom, topLevel, type AstNode } from './parser.js';
import { applyTextEdits, cutEdit, eolOf, indentAt, nextLineStart, startsItsLine, type TextEdit } from './splice.js';

/** One `erd_layout` problem, with its file line where it has one. */
export interface ErdLayoutProblem {
  code: 'layoutBadLine' | 'layoutDuplicateKey' | 'layoutBadValue' | 'layoutMergeConflict';
  /** 1-based file line (exact unless the value uses `\n` escapes or line continuations). */
  line?: number;
  message: string;
}

/** `erd_layout` as read from a diagram's text. */
export interface ErdLayoutDbmlReading extends ErdLayoutReading {
  /** The `erd_layout` entries in the first Project (any case). Only the first is read and written. */
  keyCount: number;
  /** 1-based file line of the first entry's value (where its opening quote is). */
  valueLine?: number;
  /** 1-based file line of the value's first git conflict marker. */
  conflictLine?: number;
  problemsAt: ErdLayoutProblem[];
}

const LAYOUT_KEY = DBML_DIAGRAM_PROPERTIES.layout;

const lower = (s: string): string => s.toLowerCase();

function firstProject(ast: AstNode): AstNode | undefined {
  return topLevel(ast).find((n) => lower(elementType(n) ?? '') === 'project');
}

function projectBody(project: AstNode | undefined): AstNode[] {
  return Array.isArray(project?.body?.body) ? (project!.body.body as AstNode[]) : [];
}

/** The first Project's `erd_layout` entries (any case), in file order. */
function layoutEntries(project: AstNode | undefined): AstNode[] {
  return projectBody(project).filter((n) => lower(String(n?.type?.value ?? '')) === LAYOUT_KEY);
}

/** The decoded string of an entry's value, or undefined when it is not one string literal. */
function stringValue(entry: AstNode): string | undefined {
  const body = entry?.body;
  if (body?.kind !== '<function-application>' || (Array.isArray(body.args) && body.args.length > 0)) return undefined;
  const callee = body.callee;
  if (callee?.kind !== '<primary-expression>' || callee.expression?.kind !== '<literal>') return undefined;
  const literal = callee.expression.literal;
  return literal?.kind === '<string>' && typeof literal.value === 'string' ? literal.value as string : undefined;
}

/** The names of the diagram's `Note` blocks, which settle a note line with four numbers. */
function noteIdsOf(ast: AstNode): Set<string> {
  const ids = new Set<string>();
  for (const node of topLevel(ast)) {
    if (lower(elementType(node) ?? '') !== 'note') continue;
    const parts = plainNames(node.name);
    if (parts && parts.length > 0) ids.add(parts.join('.'));
  }
  return ids;
}

/**
 * `erd_layout` from a parsed diagram (`ast` of `text`, without its
 * byte-order mark). `noteIds` are the diagram's Note names; read from the
 * AST when omitted. Internal to the diagram reader and writers.
 */
export function readErdLayoutFromAst(ast: AstNode, text: string, noteIds?: ReadonlySet<string>): ErdLayoutDbmlReading {
  const entries = layoutEntries(firstProject(ast));
  const problemsAt: ErdLayoutProblem[] = [];
  if (entries.length === 0) return { positions: {}, stickies: [], problems: [], keyCount: 0, problemsAt };
  if (entries.length > 1) {
    problemsAt.push({
      code: 'layoutDuplicateKey',
      line: lineAt(text, entries[1].start),
      message: `erd_layout appears ${entries.length} times; ERD Studio reads and rewrites only the first`,
    });
  }
  const entry = entries[0];
  const valueNode = entry.body && typeof entry.body.start === 'number' ? entry.body as AstNode : entry;
  const valueLine = lineAt(text, valueNode.start);
  const value = stringValue(entry);
  if (value === undefined) {
    problemsAt.push({
      code: 'layoutBadValue',
      line: valueLine,
      message: "erd_layout is not a string, so its positions are not read: other DBML tools reject the file; write positions as a '''…''' string",
    });
    return { positions: {}, stickies: [], problems: [], keyCount: entries.length, valueLine, problemsAt };
  }
  const reading = readErdLayout(value, noteIds ?? noteIdsOf(ast));
  for (const problem of reading.problems) {
    const line = valueLine + problem.index;
    problemsAt.push({
      code: 'layoutBadLine',
      line,
      message: problem.kind === 'badLine'
        ? `line ${line} of erd_layout is not <name> <x> <y>; it is skipped and that table is placed automatically`
        : problem.message,
    });
  }
  const conflictLine = reading.conflictIndex !== undefined ? valueLine + reading.conflictIndex : undefined;
  if (conflictLine !== undefined) {
    problemsAt.push({
      code: 'layoutMergeConflict',
      line: conflictLine,
      message: `erd_layout has an unresolved git merge conflict (line ${conflictLine}). Only positions differ: keep either side`,
    });
  }
  return {
    ...reading,
    keyCount: entries.length,
    valueLine,
    ...(conflictLine !== undefined ? { conflictLine } : {}),
    problemsAt,
  };
}

/**
 * `erd_layout` from a diagram's text, from a syntax parse alone (no `use`
 * line is bound): for Import and `doctor`. Null when the text does not parse.
 */
export function readErdLayoutDbml(rawText: string, parser: DbmlParserModule = PINNED_PARSER): ErdLayoutDbmlReading | null {
  const text = stripBom(rawText);
  const parsed = parseSyntax(text, parser);
  if (parsed.errors.length > 0) return null;
  return readErdLayoutFromAst(parsed.ast, text);
}

/**
 * The first `erd_layout` entry's whole line(s), as offsets into `rawText`
 * (a byte-order mark counted): from the start of its line to the end of the
 * line holding its value's closing quote, that line break included.
 * `{ start: 0, end: 0 }` when there is no entry; null when the text does not parse.
 */
export function erdLayoutEntrySpan(rawText: string, parser: DbmlParserModule = PINNED_PARSER): { start: number; end: number } | null {
  const text = stripBom(rawText);
  const shift = rawText.length - text.length;
  const parsed = parseSyntax(text, parser);
  if (parsed.errors.length > 0) return null;
  const span = erdLayoutSpanInAst(parsed.ast, text);
  return span.end > span.start ? { start: shift + span.start, end: shift + span.end } : span;
}

/** {@link erdLayoutEntrySpan} of a text already parsed (`ast` of `text`, without its byte-order mark). Internal. */
export function erdLayoutSpanInAst(ast: AstNode, text: string): { start: number; end: number } {
  const entry = layoutEntries(firstProject(ast))[0];
  if (!entry) return { start: 0, end: 0 };
  const end = Math.max(entry.end as number, typeof entry.body?.end === 'number' ? entry.body.end as number : 0);
  return { start: lineStartOf(text, entry.start), end: nextLineStart(text, end - 1) };
}

/** The indent of a Project's entries: the first entry's, when it starts its line; else two spaces. */
function bodyIndent(text: string, project: AstNode | undefined): string {
  const first = projectBody(project)[0];
  return first && startsItsLine(text, first.start) ? indentAt(text, first.start) : '  ';
}

/** A diagram's file name without its folder or `.dbml`: the name of a Project the writer adds. */
function stemOf(file: string): string {
  const base = file.replace(/\\/g, '/').split('/').pop() ?? '';
  const stem = base.replace(/\.dbml$/i, '');
  return stem === '' ? 'diagram' : stem;
}

/**
 * The one edit that makes the diagram's `erd_layout` say `desired`, or null
 * when it already does (canonical lines equal). `text` has no byte-order
 * mark; `ast` is its parse. Each member's line is spelled as the member is
 * and its case variants are dropped (`withMemberSpelling`); the members are
 * the diagram's own (`use` stems, then `erd_unlinked_tables`) unless
 * `members` gives the ones an edit leaves.
 *
 * The whole value is rewritten in canonical form. An empty layout cuts the
 * first entry, or empties it when the key is repeated (cutting it would make
 * the next one the first); with no entry the key goes in as the Project's
 * last entry, and with no Project one is appended at the end of the text
 * (Project last). Later entries of the key are never touched.
 *
 * Throws {@link DbmlEditRefused} when the edit would change a value that
 * holds a git merge conflict: positions are not saved until one side is
 * kept. A null result never throws, so a conflicted diagram whose layout
 * the edit leaves alone still writes.
 */
export function erdLayoutTextEdit(
  text: string,
  ast: AstNode,
  desired: ErdLayout,
  eol: string,
  file: string,
  members?: readonly string[],
): TextEdit | null {
  const project = firstProject(ast);
  const current = readErdLayoutFromAst(ast, text);
  const wanted = withMemberSpelling(desired, members ?? diagramMembersFromAst(ast, text));
  if (sameErdLayout(current, wanted)) return null;
  if (current.conflictLine !== undefined) {
    throw new DbmlEditRefused(
      file,
      `${file} has a merge conflict in erd_layout (line ${current.conflictLine}). Only positions differ: keep either side, then try again. Positions are not saved until then.`,
      current.conflictLine,
    );
  }
  const entry = layoutEntries(project)[0];
  const indent = bodyIndent(text, project);
  const value = renderErdLayoutValue(wanted, { eol, indent });
  // Cutting the first of a repeated key would make the next one the first, and its stale lines read.
  if (value === undefined && current.keyCount <= 1) return entry ? cutEdit(text, entry) : null;
  const literal = dbmlString(value ?? '');
  if (entry) {
    const node = entry.body as AstNode | undefined;
    if (!node || typeof node.start !== 'number' || typeof node.end !== 'number') {
      throw new DbmlEditRefused(file, `${file}: erd_layout has no value ERD Studio can replace; fix it by hand.`, lineAt(text, entry.start));
    }
    if (node.kind === '<function-application>') return { start: node.start, end: node.end, text: literal };
    // Any other form (`erd_layout { … }`) is replaced from the end of the key, so the entry becomes `key: '''…'''`.
    const keyEnd = typeof entry.type?.end === 'number' ? entry.type.end as number : node.start;
    return { start: keyEnd, end: node.end, text: `: ${literal}` };
  }
  const line = `${indent}${LAYOUT_KEY}: ${literal}`;
  if (project) {
    const close = project.body?.blockCloseBrace as AstNode | undefined;
    if (!close || typeof close.start !== 'number') {
      throw new DbmlEditRefused(file, `${file}: the Project has no closing brace ERD Studio can find; fix it by hand.`, lineAt(text, project.start));
    }
    const closeAt = lineStartOf(text, close.start);
    const closeAlone = /^[ \t]*$/.test(text.slice(closeAt, close.start));
    const at = closeAlone ? closeAt : close.start;
    return { start: at, end: at, text: `${closeAlone ? '' : eol}${line}${eol}` };
  }
  // No Project: one goes at the end, after a blank line (§1.4, Project last).
  const end = text.replace(/\s+$/, '').length;
  const lead = end > 0 ? `${eol}${eol}` : '';
  return { start: end, end: text.length, text: `${lead}Project ${dbmlName(stemOf(file))} {${eol}${line}${eol}}${eol}` };
}

/** What a layout-only edit writes: the canvas's positions and sticky notes, and the members whose spelling wins. */
export interface DiagramLayoutEdit {
  /** The diagram's path, as messages name it; its stem names a Project the edit adds. */
  filePath: string;
  positions: Record<string, NodePosition>;
  annotations: readonly Annotation[];
  /** The members whose lines are spelled as they are, their case variants dropped; the diagram's own when omitted. */
  members?: readonly string[];
  parser?: DbmlParserModule;
}

/**
 * The layout-only edit (a drag, a resize, auto-placing new tables): the
 * diagram's text with `erd_layout` rewritten to the positions and sticky
 * boxes given, every byte outside that one span kept, never formatted. A
 * no-op returns the text unchanged; a byte-order mark is kept.
 *
 * Throws {@link DbmlEditRefused} for a text that does not parse, a second
 * Project, and a change to a value that holds a merge conflict.
 */
export function editDiagramLayoutDbml(oldText: string, edit: DiagramLayoutEdit): string {
  const file = edit.filePath;
  const hadBom = oldText.charCodeAt(0) === 0xfeff;
  const text = stripBom(oldText);
  const parsed = parseSyntax(text, edit.parser ?? PINNED_PARSER);
  if (parsed.errors.length > 0) {
    const first = [...parsed.errors].sort((a, b) => a.start - b.start)[0];
    throw new DbmlEditRefused(
      file,
      `Fix the DBML in ${file} first (line ${first.line}: ${first.message}). ERD Studio never rewrites a file it cannot read.`,
      first.line,
    );
  }
  const projects = topLevel(parsed.ast).filter((n) => lower(elementType(n) ?? '') === 'project');
  if (projects.length > 1) {
    const line = lineAt(text, projects[1].start);
    throw new DbmlEditRefused(file, `${file}: the diagram has a second Project (line ${line}); ERD Studio will not edit the file until there is one.`, line);
  }
  const desired = erdLayoutOf(edit.positions, edit.annotations);
  const change = erdLayoutTextEdit(text, parsed.ast, desired, eolOf(text), file, edit.members);
  if (!change) return oldText;
  const out = applyTextEdits(text, [change]);
  return hadBom ? `﻿${out}` : out;
}
