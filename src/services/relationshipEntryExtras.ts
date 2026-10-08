/**
 * What taking a stored relationship entry out of its file would lose (issue
 * #133): the keys a relationship does not have (the user's own) and, in a
 * model file, comments inside the entry. Shared by the repair planner, which
 * never takes such an entry out, and the canvas commit path, which refuses to.
 * Pure (Node-free apart from the `yaml` parser), so the CLI can bundle it.
 */

import { isMap, isPair, isScalar, isSeq, parseDocument, Parser, visit } from 'yaml';
import type { Node, Pair } from 'yaml';

const BOM = '\uFEFF';

/** The fields a model file's relationship entry has; anything else is the user's. */
export const MODEL_ENTRY_KEYS = new Set(['fromColumn', 'toModel', 'toColumn', 'cardinality', 'role']);
/** The fields a domain file's relationship entry has. */
export const DOMAIN_ENTRY_KEYS = new Set(['fromModel', 'fromColumn', 'toModel', 'toColumn', 'cardinality', 'role']);
/** How an entry's comments are named among its extras. */
export const COMMENTS = 'comments';

/** The offset of every comment in `body`, from the parser's own tokens (never a `#` inside a scalar). */
function commentOffsets(body: string): number[] {
  const offsets: number[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const token = node as { type?: unknown; offset?: unknown };
    if (token.type === 'comment' && typeof token.offset === 'number') offsets.push(token.offset);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  try {
    for (const token of new Parser().parse(body)) walk(token);
  } catch {
    // The document parser reports the same text's errors; nothing more to find.
  }
  return offsets;
}

/**
 * Where a block sequence entry starts: its `-` indicator, the last one in
 * `[from, valueStart)` with only indentation before it on its line. A flow
 * entry (`relationships: [ … ]`) has none and starts at its value.
 */
function entryStart(body: string, from: number, valueStart: number): number {
  let start = valueStart;
  const indicator = /(^|\n)[ \t]*-(?=[ \t\r\n])/g;
  const region = body.slice(from, valueStart);
  for (let m = indicator.exec(region); m; m = indicator.exec(region)) {
    start = from + m.index + m[0].length - 1;
  }
  return start;
}

/**
 * For each entry of a model file's `relationships:` list (by position as
 * written), what removing it would lose: its unknown keys, and `comments`
 * when a comment is the entry's — on its dash line, between its keys, after
 * any of its values on the same line (a flow entry's trailing comment), or
 * indented under it at its end. A comment on the lines above an entry's dash
 * is not the entry's: removing the entry leaves it where it is
 * (`editYamlRelationships`).
 */
export function yamlEntryExtras(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  const doc = parseDocument(body);
  const root = doc.contents;
  if (!isMap(root)) return out;
  const pair = (root.items as unknown[]).find((p): p is Pair => isPair(p) && isScalar(p.key) && p.key.value === 'relationships');
  if (!pair || !isSeq(pair.value)) return out;
  // A `fromModel:` naming the file's own model (any case) says nothing the
  // entry's place does not: the entry carries no key of the user's for it.
  const nameNode = (root.items as unknown[]).find((p): p is Pair => isPair(p) && isScalar(p.key) && p.key.value === 'name')?.value;
  const ownName = isScalar(nameNode) && typeof nameNode.value === 'string' ? nameNode.value.toLowerCase() : undefined;
  const comments = commentOffsets(body);
  const seqStart = pair.value.range?.[0] ?? 0;
  let previousEnd = seqStart;
  (pair.value.items as Node[]).forEach((item, i) => {
    // The entry's own span: from its dash to the end of the node, which the
    // parser extends over a trailing comment and over comments indented
    // under its last key.
    const range = item.range;
    const ownComment = range
      ? comments.some((at) => at >= entryStart(body, previousEnd, range[0]) && at < range[2])
      : false;
    if (range) previousEnd = range[2];
    const lost: string[] = [];
    if (isMap(item)) {
      for (const p of item.items) {
        if (!isPair(p) || !isScalar(p.key) || MODEL_ENTRY_KEYS.has(String(p.key.value))) continue;
        if (p.key.value === 'fromModel' && ownName !== undefined && isScalar(p.value)
          && typeof p.value.value === 'string' && p.value.value.toLowerCase() === ownName) continue;
        lost.push(String(p.key.value));
      }
    }
    let commented = ownComment || !!(item as { comment?: string }).comment;
    visit(item as Parameters<typeof visit>[0], {
      Node: (_k, n) => {
        if (n === item) return;
        if ((n as { commentBefore?: string }).commentBefore || (n as { comment?: string }).comment) commented = true;
      },
    });
    if (commented) lost.push(COMMENTS);
    if (lost.length > 0) out.set(i, lost);
  });
  return out;
}

/** For each entry of a domain file's `logical.relationships` (by position), the keys a relationship does not have. */
export function domainEntryExtras(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, '')) as { logical?: { relationships?: unknown } };
    const list = raw.logical?.relationships;
    if (!Array.isArray(list)) return out;
    list.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
      const lost = Object.keys(entry).filter((k) => !DOMAIN_ENTRY_KEYS.has(k));
      if (lost.length > 0) out.set(i, lost);
    });
  } catch {
    // An unreadable file is never a repair's to edit.
  }
  return out;
}

/** The keys of a parsed domain-file entry a relationship does not have. */
export function domainObjectExtras(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  return Object.keys(entry).filter((k) => !DOMAIN_ENTRY_KEYS.has(k));
}

/** "its own key description and comments", for a message. */
export function describeExtras(extras: readonly string[]): string {
  const keys = extras.filter((e) => e !== COMMENTS);
  const parts = [
    ...(keys.length > 0 ? [`${keys.length === 1 ? 'its own key' : 'its own keys'} ${keys.join(', ')}`] : []),
    ...(extras.includes(COMMENTS) ? ['comments'] : []),
  ];
  return parts.join(' and ');
}
