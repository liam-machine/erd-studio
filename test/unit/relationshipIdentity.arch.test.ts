/**
 * Architecture guard for relationship identity (#133, R1).
 *
 * "Is this the same link?" has exactly one answer: core's `linkKey` /
 * `sameLink` (both ends, either way round, case-insensitive). Before #133
 * about twenty places compared ends with `===`, so a reversed or re-cased copy
 * was "a different relationship": it came back after a delete, was refused as
 * "already exists", or was drawn twice. This test reads the source as text and
 * fails on any new exact comparison of a relationship end.
 *
 * What it flags: `x.fromModel ===`, `fromModel !== y`, `=== r.toColumn` and
 * the like, for all four end fields. What it does not flag: a comparison with
 * a literal, `undefined` or `null`, and `typeof` checks — those test a value's
 * shape, not identity.
 *
 * The allowlist names each remaining comparison and why it is not about link
 * identity. Add to it only with a reason that would convince a reviewer.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src', 'webview', 'packages/core/src', 'packages/renderer/src'];

const END = '(?:fromModel|toModel|fromColumn|toColumn)';
/** `<end> ===|!== <something that is not a literal, undefined or null>` */
const LEFT = new RegExp(`\\b${END}\\s*[!=]==(?!\\s*(?:['"\`]|undefined\\b|null\\b))`);
/** `=== x.<end>` / `!== x?.<end>` */
const RIGHT = new RegExp(`[!=]==\\s*[\\w$.?]*\\.${END}\\b`);

/** `file` (repo-relative, forward slashes) → line substrings allowed there, with the reason. */
const ALLOWED: Record<string, { text: string; why: string }[]> = {
  'src/cli/diff.ts': [
    { text: 'stored.fromModel !== rel.fromModel', why: 'direction check: did canonicalRelationship turn this record round?' },
  ],
  'webview/components/NewFkDialog/NewFkDialog.tsx': [
    { text: 'fromModel === toModel', why: 'self-reference check on the two dropdown values, not link identity' },
  ],
  'packages/renderer/src/lib/graphTransformer.ts': [
    { text: 'isSelfLoop = fromModel === toModel', why: 'self-loop detection on node ids already resolved by nodeIdResolver' },
  ],
  'packages/renderer/src/lib/nodeOverlays.ts': [
    { text: 'fk.fromModel === selectedNode', why: 'edge data carries resolved node ids; compares an edge end with a node id' },
    { text: 'fk.toModel === selectedNode', why: 'edge data carries resolved node ids; compares an edge end with a node id' },
  ],
};

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every `file:line: text` that compares a relationship end exactly and is not allowlisted. */
function violations(): string[] {
  const found: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const allowed = ALLOWED[rel] ?? [];
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/\btypeof\b/.test(code)) return;
        if (!LEFT.test(code) && !RIGHT.test(code)) return;
        if (allowed.some((a) => code.includes(a.text))) return;
        found.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  return found;
}

describe('relationship identity (#133, R1)', () => {
  it('no source file compares relationship ends with === outside the allowlist', () => {
    expect(violations()).toEqual([]);
  });

  it('every allowlist entry still matches a line (no stale exemptions)', () => {
    for (const [rel, entries] of Object.entries(ALLOWED)) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const a of entries) expect(text.includes(a.text), `${rel}: ${a.text}`).toBe(true);
    }
  });

  it('the patterns catch the comparisons #133 removed', () => {
    const flagged = (s: string) => LEFT.test(s) || RIGHT.test(s);
    expect(flagged('rels.filter((r) => r.fromModel === name)')).toBe(true);
    expect(flagged('if (a.toColumn !== b.toColumn) return false;')).toBe(true);
    expect(flagged('m.name === r.toModel')).toBe(true);
    expect(flagged("ends.fromModel !== ''")).toBe(false);
    expect(flagged('if (fromModel === undefined) continue;')).toBe(false);
    expect(flagged('linkKey(a) === linkKey(b)')).toBe(false);
  });
});
