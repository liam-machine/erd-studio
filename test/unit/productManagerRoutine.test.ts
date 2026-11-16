/**
 * .claude/routines/product-manager.md is the scheduled product manager's whole
 * brief: the routine reads it from origin/develop and reports only what it
 * asks for. #326: every digest carries a Use block (active installs on final
 * rows beside reporting installs, and the rest), the journal's baselines name
 * reporting installs as such, and the launch watch's bar is a suggestion
 * until Liam confirms it.
 *
 * The Use block's SQL runs unattended against D1, so a renamed or mistyped
 * feature key or column would silently read 0. These tests hold its keys to
 * FEATURES, its columns to telemetry/schema.sql, and its output to
 * aggregates: never an install id.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../src/services/telemetryPayload';

const routine = readFileSync(resolve(__dirname, '../../.claude/routines/product-manager.md'), 'utf8');
const schema = readFileSync(resolve(__dirname, '../../telemetry/schema.sql'), 'utf8');

function section(text: string, start: RegExp, end: RegExp): string {
  const from = text.search(start);
  if (from < 0) return '';
  const rest = text.slice(from + 1);
  const to = rest.search(end);
  return to < 0 ? text.slice(from) : text.slice(from, from + 1 + to);
}

const step5 = section(routine, /^### STEP 5\b/m, /^### /m);
const useBlock = section(step5, /^#### Use\b/m, /^#### /m);
const journal = section(routine, /^## Journal\b/m, /^## /m);
const stepL = section(routine, /^### STEP L\b/m, /^### /m);
const step4 = section(routine, /^### STEP 4\b/m, /^### /m);

const sqlFences = [...useBlock.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);

/** The query text with string literals and line comments taken out. */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
}

/** The text of the outermost query's select list: after the last SELECT at depth 0, up to its FROM. */
function topSelectList(sql: string): string {
  const text = code(sql);
  let depth = 0;
  let lastSelect = -1;
  const depthAt: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    depthAt.push(depth);
  }
  for (const m of text.matchAll(/\bSELECT\b/gi)) if (depthAt[m.index!] === 0) lastSelect = m.index!;
  expect(lastSelect, 'no top-level SELECT').toBeGreaterThanOrEqual(0);
  for (const m of text.slice(lastSelect).matchAll(/\bFROM\b/gi)) {
    const at = lastSelect + m.index!;
    if (depthAt[at] === 0) return text.slice(lastSelect, at);
  }
  return text.slice(lastSelect);
}

/** Removes every COUNT( … ) call, balanced. */
function withoutCounts(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const m = /\bCOUNT\s*\(/i.exec(text.slice(i));
    if (!m) return out + text.slice(i);
    out += text.slice(i, i + m.index);
    let j = i + m.index + m[0].length;
    let depth = 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '(') depth++;
      if (text[j] === ')') depth--;
      j++;
    }
    i = j;
  }
  return out;
}

const heartbeatColumns = new Set(
  [...(section(schema, /CREATE TABLE IF NOT EXISTS heartbeats/, /^\);/m).matchAll(/^\s+([a-z_0-9]+)\s+(?:TEXT|INTEGER)\b/gm))].map((m) => m[1]),
);

describe('product manager routine: the Use block (#326)', () => {
  it('STEP 5 opens with a Use block of queries, and the journal keeps it in Metric baselines', () => {
    expect(step5).not.toBe('');
    expect(useBlock, 'STEP 5 has no "#### Use" subsection').not.toBe('');
    expect(sqlFences.length).toBeGreaterThanOrEqual(6);
    expect(journal).toMatch(/\*\*Metric baselines\*\*[^\n]*\*\*Use\*\*/);
    expect(journal).toMatch(/digest[^\n]*Use block/);
  });

  it('cites the README definition of active and reporting installs', () => {
    expect(useBlock).toContain('*What "active" means*');
    expect(useBlock).toMatch(/\*\*active\*\* when it opened a diagram/);
    expect(useBlock).toMatch(/\*\*reporting\*\*/);
  });

  it('every feature key its SQL reads is one the extension sends', () => {
    const keys = new Set<string>();
    for (const sql of sqlFences) {
      for (const m of sql.matchAll(/'\$\.([A-Za-z0-9]+)'/g)) keys.add(m[1]);
      for (const list of sql.matchAll(/\bj\.key\s+IN\s*\(([^)]*)\)/g)) {
        for (const k of list[1].matchAll(/'([A-Za-z0-9]+)'/g)) keys.add(k[1]);
      }
    }
    // The team-sharing keys (#332) and the design-edit keys must all be there.
    for (const k of ['sharedModelFirstOpened', 'modelInGit', 'modelNotInGit', 'modelRepoHasRemote', 'modelChangedExternalGit', 'editModel', 'addRelationship']) {
      expect(keys).toContain(k);
    }
    expect(keys).not.toContain('editLayout');
    const known = new Set<string>(FEATURES);
    expect([...keys].filter((k) => !known.has(k))).toEqual([]);
  });

  it('every column its SQL reads exists in telemetry/schema.sql', () => {
    expect(heartbeatColumns.has('canvas_days_28')).toBe(true);
    const unknown = new Set<string>();
    for (const sql of sqlFences) {
      const text = code(sql);
      const aliases = new Set<string>([
        ...[...text.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]),
        ...[...text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi)].map((m) => m[1]),
      ]);
      for (const m of text.matchAll(/\b([a-z][a-z0-9]*_[a-z0-9_]+)\b(\s*\()?/g)) {
        if (m[2] || aliases.has(m[1])) continue; // a function, or a name the query made
        if (!heartbeatColumns.has(m[1])) unknown.add(m[1]);
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it('every query leaves out dev rows and returns aggregates, never an install id', () => {
    for (const sql of sqlFences) {
      expect(sql).toContain('COALESCE(dev,0)=0');
      expect(withoutCounts(topSelectList(sql)), sql).not.toMatch(/install_id/);
    }
  });

  it('reads canvas_days_28 buckets by name, never by comparing text', () => {
    const repeat = sqlFences.filter((s) => s.includes('canvas_days_28'));
    expect(repeat.length).toBeGreaterThan(0);
    for (const sql of repeat) {
      expect(sql).toContain("IN ('2-3','4-7','8-14','15-28')");
      expect(sql).not.toMatch(/canvas_days_28\s*[<>]/);
    }
  });

  it('calls a heartbeat alone reporting, everywhere', () => {
    // The journal's old baseline label (a count of installs that sent a heartbeat) may only
    // appear where the routine is told to rename it.
    for (const line of routine.split('\n').filter((l) => /"Active installs"|Active installs:/.test(l))) {
      expect(line).toContain('Reporting installs');
    }
    expect(step4).not.toMatch(/share of active installs/);
    expect(step4).toMatch(/share of reporting installs/);
  });

  it('the launch watch bar is a suggestion until Liam confirms it, and never raises an alert', () => {
    const bar = section(stepL, /^\*\*The closing digest's bar/m, /^### |^The week of 11-23/m);
    expect(bar, 'STEP L has no bar paragraph').not.toBe('');
    expect(bar).toMatch(/nothing in this bar ever opens, edits or labels a `launch-alert` issue/);
    // Once Liam writes "Confirmed by Liam on <date>" into the paragraph, it is his bar.
    if (/Confirmed by Liam on \d/.test(bar)) return;
    expect(bar).toMatch(/SUGGESTED, NOT confirmed\. Liam sets it/);
    expect(bar).toContain('(suggested bar, not confirmed)');
    expect(journal).toMatch(/Decisions waiting on Liam[^\n]*suggested bar/);
  });
});
