/**
 * Surgical text edits for the relationship move (#126 follow-up).
 *
 * The move must change only what it moves: a model file gains (or loses) its
 * top-level `relationships:` block and nothing else — not its comments, quoting,
 * folded scalars, key order or line endings — and a domain file loses only the
 * moved entries of `logical.relationships`. Pure: no `vscode`, no `fs`.
 */

import { isMap, isPair, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import type { Node, Pair } from 'yaml';

import type { ModelRelationship, Relationship } from '../types/semantic';

const BOM = '﻿';

/** Split a leading BOM off `text`. */
function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(1) } : { bom: '', body: text };
}

/** The file's own line ending: CRLF when it uses one anywhere, else LF. */
function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
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
  }
  return lines.join(eol);
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
    })));
    return bom + doc.toString();
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

/** The elements of the array whose `[` is at `open`: each element's span. */
function scanArray(text: string, open: number): { open: number; close: number; elements: Array<[number, number]> } {
  const elements: Array<[number, number]> = [];
  let i = skipWs(text, open + 1);
  if (text[i] === ']') return { open, close: i, elements };
  for (;;) {
    const start = i;
    const end = scanValue(text, i);
    elements.push([start, end]);
    i = skipWs(text, end);
    if (text[i] === ']') return { open, close: i, elements };
    i = skipWs(text, i + 1); // past ','
  }
}

/** Where `logical.relationships` is in `body`, or null when it is absent or not an array. */
function domainRelationshipsArray(body: string): { open: number; close: number; elements: Array<[number, number]> } | null {
  const root = scanObject(body, skipWs(body, 0));
  // JSON.parse keeps the last of duplicate keys; so does this.
  const logicalMember = [...root.members].reverse().find((m) => m.key === 'logical');
  if (!logicalMember || body[logicalMember.valueStart] !== '{') return null;
  const logical = scanObject(body, logicalMember.valueStart);
  const member = [...logical.members].reverse().find((m) => m.key === 'relationships');
  if (!member || body[member.valueStart] !== '[') return null;
  return scanArray(body, member.valueStart);
}

/**
 * The source text of each element of a domain file's `logical.relationships`,
 * exactly as written, or null when the file is not JSON or the list is not an
 * array. What a repair compares to prove it left an entry alone.
 */
export function domainRelationshipElementTexts(text: string): string[] | null {
  const { body } = splitBom(text);
  try {
    JSON.parse(body);
    const array = domainRelationshipsArray(body);
    return array ? array.elements.map(([start, end]) => body.slice(start, end)) : null;
  } catch {
    return null;
  }
}

/** The fields of a relationship entry an edit sets, in the order they are added when missing. */
const RELATIONSHIP_FIELDS = ['fromModel', 'fromColumn', 'toModel', 'toColumn', 'cardinality', 'role'] as const;

/**
 * One entry's object text with its relationship fields set to `rel`, value by
 * value: every other key, and the bytes of every value that does not change,
 * are kept as written. A missing field is added after the last member; a role
 * `rel` does not have is removed.
 */
function editEntryObject(objectText: string, rel: Relationship, eol: string): string {
  const span = scanObject(objectText, 0);
  const lastOf = (key: string): JsonMember | undefined => [...span.members].reverse().find((m) => m.key === key);
  const splices: Array<{ start: number; end: number; text: string }> = [];
  const additions: string[] = [];
  for (const field of RELATIONSHIP_FIELDS) {
    const want = rel[field];
    const member = lastOf(field);
    if (want === undefined || want === '') {
      if (!member) continue;
      // Removed (every copy of the key) with the separator before it, or
      // after it when it is the first member.
      for (const m of span.members.filter((x) => x.key === field)) {
        const at = span.members.indexOf(m);
        if (at > 0) splices.push({ start: span.members[at - 1].valueEnd, end: m.valueEnd, text: '' });
        else if (span.members.length > 1) splices.push({ start: m.keyStart, end: span.members[1].keyStart, text: '' });
        else splices.push({ start: m.keyStart, end: m.valueEnd, text: '' });
      }
      continue;
    }
    if (member) {
      let current: unknown;
      try { current = JSON.parse(objectText.slice(member.valueStart, member.valueEnd)); } catch { current = undefined; }
      if (current !== want) splices.push({ start: member.valueStart, end: member.valueEnd, text: JSON.stringify(want) });
    } else {
      additions.push(`"${field}": ${JSON.stringify(want)}`);
    }
  }
  if (additions.length > 0) {
    const last = span.members[span.members.length - 1];
    const indent = last ? indentIfFirstOnLine(objectText, last.keyStart) : null;
    const lead = indent === null ? ', ' : ',' + eol + indent;
    const at = last ? last.valueEnd : span.open + 1;
    splices.push({ start: at, end: at, text: (last ? lead : '') + additions.join(lead) });
  }
  let out = objectText;
  for (const s of [...splices].sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }
  return out;
}

/**
 * Return `text` (a domain JSON) with entries of `logical.relationships`
 * removed (`remove`, by position as written) or changed (`update`), entry by
 * entry: every other entry keeps its exact bytes — its layout, number
 * spelling, escapes and keys — and a changed entry keeps everything but the
 * values that change. Throws when the file is not JSON or the list is not
 * an array.
 */
export function editDomainRelationshipEntries(
  text: string,
  edits: { remove: ReadonlySet<number>; update: ReadonlyMap<number, Relationship> },
): string {
  const { bom, body } = splitBom(text);
  JSON.parse(body);
  const array = domainRelationshipsArray(body);
  if (!array) throw new Error('editDomainRelationshipEntries: "logical.relationships" is not a list');
  const eol = detectEol(body);
  const { elements } = array;
  const kept = elements.map((_, i) => i).filter((i) => !edits.remove.has(i));
  const elementText = (i: number): string => {
    const [start, end] = elements[i];
    const original = body.slice(start, end);
    const update = edits.update.get(i);
    if (!update) return original;
    if (original[0] !== '{') throw new Error(`editDomainRelationshipEntries: entry ${i + 1} is not an object`);
    return editEntryObject(original, update, eol);
  };
  if (kept.length === 0) return bom + body.slice(0, array.open) + '[]' + body.slice(array.close + 1);
  let inner = body.slice(array.open + 1, elements[0][0]);
  kept.forEach((i, n) => {
    inner += elementText(i);
    if (n < kept.length - 1) inner += body.slice(elements[i][1], elements[i + 1][0]);
  });
  inner += body.slice(elements[elements.length - 1][1], array.close);
  return bom + body.slice(0, array.open + 1) + inner + body.slice(array.close);
}
