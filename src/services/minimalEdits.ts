/**
 * Surgical text edits for the relationship move (#126 follow-up).
 *
 * The move must change only what it moves: a model file gains (or loses) its
 * top-level `relationships:` block and nothing else — not its comments, quoting,
 * folded scalars, key order or line endings — and a domain file loses only the
 * moved entries of `logical.relationships`. Pure: no `vscode`, no `fs`.
 */

import { isMap, isPair, isScalar, isSeq, parseDocument, stringify, visit } from 'yaml';
import type { Node, Pair } from 'yaml';

import { VALID_CARDINALITIES, normaliseCompositeKey, normaliseRelationshipRole } from '@erd-studio/core';

import type { ModelRelationship, Relationship } from '../types/semantic';
import { detectEol, keepLineEndings } from './lineEndings';

const BOM = '﻿';

/** Split a leading BOM off `text`. */
function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(1) } : { bom: '', body: text };
}

/** Index of the start of the line containing `offset`. */
function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/** Index just past the line break ending the line containing `offset` (or text.length). */
function afterLineEnd(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset);
  return nl === -1 ? text.length : nl + 1;
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/** YAML 1.1 booleans: plain in YAML 1.2, but a 1.1 reader would take them as true/false. */
const YAML11_BOOLEAN = /^(?:y|n|yes|no|on|off)$/i;

/** A string as a YAML scalar on one line: plain when YAML allows it, quoted otherwise. */
function yamlScalar(value: string): string {
  if (YAML11_BOOLEAN.test(value)) return JSON.stringify(value);
  const out = stringify(value, { lineWidth: 0 }).replace(/\n$/, '');
  return out.includes('\n') ? JSON.stringify(value) : out;
}

/**
 * Column of the `- ` marker of the file's other top-level block sequences
 * (`columns:` items at 0, 2 or 4), or 2 when there are none.
 */
function detectSeqIndent(text: string, pairs: readonly Pair[]): number {
  for (const pair of pairs) {
    const value = pair.value as Node | null;
    if (!isSeq(value) || value.flow || value.items.length === 0) continue;
    const first = value.items[0] as Node | null;
    const start = first?.range?.[0];
    if (start === undefined) continue;
    const line = text.slice(lineStart(text, start), start);
    const m = /^( *)- /.exec(line);
    if (m) return m[1].length;
  }
  return 2;
}

function renderYamlBlock(relationships: readonly ModelRelationship[], indent: number, eol: string): string {
  const dash = ' '.repeat(indent);
  const body = ' '.repeat(indent + 2);
  const lines = ['relationships:'];
  for (const r of relationships) {
    lines.push(`${dash}- fromColumn: ${yamlScalar(r.fromColumn)}`);
    lines.push(`${body}toModel: ${yamlScalar(r.toModel)}`);
    lines.push(`${body}toColumn: ${yamlScalar(r.toColumn)}`);
    lines.push(`${body}cardinality: ${yamlScalar(r.cardinality)}`);
    if (r.role) lines.push(`${body}role: ${yamlScalar(r.role)}`);
    if (r.compositeKey) lines.push(`${body}compositeKey: ${yamlScalar(r.compositeKey)}`);
  }
  return lines.join(eol);
}

const ENTRY_KEYS = new Set(['fromColumn', 'toModel', 'toColumn', 'cardinality', 'role', 'compositeKey']);

/**
 * Whether re-rendering `text`'s `relationships:` block would lose something:
 * a comment in it, or an entry the reader skips, defaults or changes (an
 * unknown key, a typo'd cardinality). Such a file is left for the user.
 */
export function relationshipsRewriteLoses(text: string): boolean {
  const doc = parseDocument(splitBom(text).body);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return true;
  const pair = (doc.contents.items as Pair[]).find((p) => isScalar(p.key) && p.key.value === 'relationships');
  if (!pair?.value) return false;
  let commented = Boolean((pair.key as Node).comment);
  visit(pair.value as Node, { Node: (_, n) => { if (n.comment || n.commentBefore) commented = true; } });
  const list: unknown = (pair.value as Node).toJSON() ?? [];
  return commented || !Array.isArray(list) || list.some((entry: Record<string, unknown> | null) =>
    !entry || typeof entry !== 'object' || Object.keys(entry).some((k) => !ENTRY_KEYS.has(k))
    || ['fromColumn', 'toModel', 'toColumn'].some((k) => typeof entry[k] !== 'string' || entry[k] === '')
    || !VALID_CARDINALITIES.has(entry.cardinality as never)
    || (entry.role !== undefined && normaliseRelationshipRole(entry.role) !== entry.role)
    || (entry.compositeKey !== undefined && normaliseCompositeKey(entry.compositeKey) !== entry.compositeKey));
}

/**
 * Return `text` (a model yml) with its top-level `relationships:` block set to
 * `relationships` — added at the end when absent, replaced in place when
 * present, removed when `relationships` is empty — and every other byte
 * unchanged. Line endings follow the file's own (CRLF stays CRLF); a BOM is
 * kept. Throws if `text` is not a YAML mapping.
 */
export function setYamlRelationships(text: string, relationships: readonly ModelRelationship[]): string {
  const { bom, body } = splitBom(text);
  const doc = parseDocument(body);
  if (doc.errors.length > 0) throw new Error(`setYamlRelationships: ${doc.errors[0].message}`);
  const root = doc.contents;
  if (!isMap(root)) throw new Error('setYamlRelationships: the model file is not a YAML mapping');

  if (root.flow) {
    // `{ name: x, columns: [...] }` on one line: there is no block to splice
    // into, so let the document re-emit itself. Not written by ERD Studio or
    // any assistant; supported only so the move does not fail on it.
    if (relationships.length === 0) doc.delete('relationships');
    else doc.set('relationships', relationships.map((r) => ({
      fromColumn: r.fromColumn, toModel: r.toModel, toColumn: r.toColumn, cardinality: r.cardinality,
      ...(r.role ? { role: r.role } : {}),
      ...(r.compositeKey ? { compositeKey: r.compositeKey } : {}),
    })));
    return bom + keepLineEndings(doc.toString(), body);
  }

  const pairs = root.items.filter(isPair) as Pair[];
  const eol = detectEol(body);
  const endsWithEol = body.endsWith('\n');
  const block = renderYamlBlock(relationships, detectSeqIndent(body, pairs), eol);
  const existing = pairs.find((p) => isScalar(p.key) && p.key.value === 'relationships');

  if (!existing) {
    if (relationships.length === 0) return text;
    return bom + (endsWithEol || body === '' ? body + block + eol : body + eol + block);
  }

  const key = existing.key as Node;
  const value = existing.value as Node | null;
  const start = lineStart(body, key.range![0]);
  const valueEnd = value?.range?.[1] ?? key.range![1];
  // A block value's range already ends past its last line break; a scalar or
  // flow value ends on its own line, which goes too (with any trailing comment).
  const end = valueEnd > 0 && body[valueEnd - 1] === '\n' ? valueEnd : afterLineEnd(body, valueEnd);
  const blockEndsWithEol = body[end - 1] === '\n';

  if (relationships.length === 0) {
    let before = body.slice(0, start);
    // Removing the last line of a file without a final newline: drop the line
    // break before it as well, so the file still ends without one.
    if (!blockEndsWithEol && end === body.length) before = before.replace(/\r?\n$/, '');
    return bom + before + body.slice(end);
  }
  return bom + body.slice(0, start) + block + (blockEndsWithEol ? eol : '') + body.slice(end);
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

interface JsonMember {
  key: string;
  keyStart: number;
  /** Index just past the key's closing quote. */
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
}

interface JsonObjectSpan {
  open: number;
  close: number;
  members: JsonMember[];
}

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function skipWs(text: string, i: number): number {
  while (isWs(text[i])) i++;
  return i;
}

/** End (exclusive) of the string starting at the quote `i`. */
function scanString(text: string, i: number): number {
  i++;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') i += 2;
    else if (ch === '"') return i + 1;
    else i++;
  }
  throw new Error('setDomainRelationships: unterminated string');
}

/** End (exclusive) of the JSON value starting at `i` (already validated text). */
function scanValue(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"') return scanString(text, i);
  if (ch === '{' || ch === '[') {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') { i = scanString(text, i); continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    throw new Error('setDomainRelationships: unterminated container');
  }
  while (i < text.length && !isWs(text[i]) && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i++;
  return i;
}

/** The members of the object whose `{` is at `open`. */
function scanObject(text: string, open: number): JsonObjectSpan {
  const members: JsonMember[] = [];
  let i = skipWs(text, open + 1);
  if (text[i] === '}') return { open, close: i, members };
  for (;;) {
    const keyStart = i;
    const keyEnd = scanString(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipWs(text, keyEnd);
    i = skipWs(text, i + 1); // past ':'
    const valueStart = i;
    const valueEnd = scanValue(text, i);
    members.push({ key, keyStart, keyEnd, valueStart, valueEnd });
    i = skipWs(text, valueEnd);
    if (text[i] === '}') return { open, close: i, members };
    i = skipWs(text, i + 1); // past ','
  }
}

/** Leading whitespace of the line holding `offset`, when `offset` is the first thing on it. */
function indentIfFirstOnLine(text: string, offset: number): string | null {
  const prefix = text.slice(lineStart(text, offset), offset);
  return /^[ \t]*$/.test(prefix) ? prefix : null;
}

/** The file's indent unit: the leading whitespace of its first indented line, else two spaces. */
function detectIndentUnit(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1] : '  ';
}

function renderJsonArray(
  relationships: readonly Relationship[],
  indent: string | null,
  unit: string,
  eol: string,
): string {
  if (relationships.length === 0) return '[]';
  if (indent === null) return JSON.stringify(relationships);
  const itemIndent = indent + unit;
  const items = relationships.map((r) =>
    itemIndent + JSON.stringify(r, null, unit).replace(/\n/g, eol + itemIndent));
  return '[' + eol + items.join(',' + eol) + eol + indent + ']';
}

/**
 * Return `text` (a domain JSON) with `logical.relationships` set to
 * `relationships`, changing only that array's text (indentation matched to the
 * file) and every other byte unchanged. Throws if `text` is not a JSON object
 * with a `logical` object.
 */
export function setDomainRelationships(text: string, relationships: readonly Relationship[]): string {
  const { bom, body } = splitBom(text);
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('setDomainRelationships: the domain file is not a JSON object');
  }
  const logicalValue = (parsed as Record<string, unknown>).logical;
  if (!logicalValue || typeof logicalValue !== 'object' || Array.isArray(logicalValue)) {
    throw new Error('setDomainRelationships: the domain file has no "logical" object');
  }

  const eol = detectEol(body);
  const unit = detectIndentUnit(body);
  const root = scanObject(body, skipWs(body, 0));
  // JSON.parse keeps the last of duplicate keys; so does this.
  const logicalMember = [...root.members].reverse().find((m) => m.key === 'logical')!;
  const logical = scanObject(body, logicalMember.valueStart);
  const existing = [...logical.members].reverse().find((m) => m.key === 'relationships');

  if (existing) {
    const indent = indentIfFirstOnLine(body, existing.keyStart);
    const rendered = renderJsonArray(relationships, indent, unit, eol);
    return bom + body.slice(0, existing.valueStart) + rendered + body.slice(existing.valueEnd);
  }

  const logicalIndent = indentIfFirstOnLine(body, logicalMember.keyStart);
  if (logical.members.length === 0) {
    if (logicalIndent === null) {
      const rendered = renderJsonArray(relationships, null, unit, eol);
      return bom + body.slice(0, logical.open + 1) + `"relationships":${rendered}` + body.slice(logical.close);
    }
    const memberIndent = logicalIndent + unit;
    const rendered = renderJsonArray(relationships, memberIndent, unit, eol);
    return bom + body.slice(0, logical.open + 1)
      + eol + memberIndent + `"relationships": ${rendered}` + eol + logicalIndent
      + body.slice(logical.close);
  }

  const anchor = logical.members.find((m) => m.key === 'models') ?? logical.members[logical.members.length - 1];
  const separator = body.slice(anchor.keyEnd, anchor.valueStart);
  const anchorIndent = indentIfFirstOnLine(body, anchor.keyStart);
  const rendered = renderJsonArray(relationships, anchorIndent, unit, eol);
  const lead = anchorIndent === null ? ',' : ',' + eol + anchorIndent;
  return bom + body.slice(0, anchor.valueEnd)
    + lead + '"relationships"' + separator + rendered
    + body.slice(anchor.valueEnd);
}

/** The element spans of the array whose `[` is at `open`. */
function scanArrayElements(text: string, open: number): Array<{ start: number; end: number }> {
  const elements: Array<{ start: number; end: number }> = [];
  let i = skipWs(text, open + 1);
  if (text[i] === ']') return elements;
  for (;;) {
    const end = scanValue(text, i);
    elements.push({ start: i, end });
    i = skipWs(text, end);
    if (text[i] === ']') return elements;
    i = skipWs(text, i + 1); // past ','
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Return `text` (a JSON document) turned into `updated` by rewriting only the
 * scalars that differ and the object keys renamed in place — every other
 * byte, the layout and the line endings stay as they were (#133 L5: a rename
 * reaching another diagram's file). Null when `updated` differs in shape (a
 * member or element added or removed, an object where there was a scalar):
 * the caller renders the file instead.
 */
export function rewriteJsonScalars(text: string, updated: unknown): string | null {
  const { bom, body } = splitBom(text);
  const edits: Array<{ start: number; end: number; text: string }> = [];

  const walk = (i: number, next: unknown): boolean => {
    const ch = body[i];
    if (ch === '{') {
      if (!isPlainObject(next)) return false;
      const { members } = scanObject(body, i);
      const keys = members.map((m) => m.key);
      const nextKeys = Object.keys(next);
      if (new Set(keys).size !== keys.length || keys.length !== nextKeys.length) return false;
      // A key gone and a key new, in the same order, are renames in place.
      const removed = keys.filter((k) => !Object.prototype.hasOwnProperty.call(next, k));
      const added = nextKeys.filter((k) => !keys.includes(k));
      if (removed.length !== added.length) return false;
      for (const m of members) {
        const at = removed.indexOf(m.key);
        const key = at === -1 ? m.key : added[at];
        if (at !== -1) edits.push({ start: m.keyStart, end: m.keyEnd, text: JSON.stringify(key) });
        if (!walk(m.valueStart, next[key])) return false;
      }
      return true;
    }
    if (ch === '[') {
      if (!Array.isArray(next)) return false;
      const elements = scanArrayElements(body, i);
      if (elements.length !== next.length) return false;
      return elements.every((el, k) => walk(el.start, next[k]));
    }
    if (next !== null && typeof next === 'object') return false;
    const end = scanValue(body, i);
    if (!Object.is(JSON.parse(body.slice(i, end)), next)) {
      if (next === undefined) return false;
      edits.push({ start: i, end, text: JSON.stringify(next) });
    }
    return true;
  };

  if (!walk(skipWs(body, 0), updated)) return null;
  let out = body;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return bom + out;
}
