/**
 * UI wording (#179, part 1 of #162): what a user reads says "table",
 * "Table Library" and "subject area", never "model" for one table or
 * "domain" for a diagram. "dbt model" stays where it means the dbt model.
 *
 * Only the words change: ids, `when` clauses, on-disk paths and the feedback
 * settings (where "model" is a language model) are left out of the scan.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));

/** Keys whose values are ids, conditions or paths, not words. */
const NOT_WORDS = new Set(['command', 'id', 'when', 'url', 'fileMatch', 'view', 'viewType', 'filenamePattern', 'icon', 'image', 'markdown', 'svg', 'group', 'enablement', 'completionEvents']);

/**
 * The literal dbt `domain:*` tag the command strips is its name, not a diagram.
 * "Data model" is the whole design (the logical-first copy: "Design your data
 * model in Git"), never one table.
 */
const ALLOWED = [/\bLegacy Domain Tags\b/g, /\bdbt models?\b/gi, /\bdbt Model\b/g, /\bdata models?\b/gi];

function userText(node: unknown, at: string, out: Array<[string, string]>): void {
  if (typeof node === 'string') { out.push([at, node]); return; }
  if (!node || typeof node !== 'object') { return; }
  for (const [key, value] of Object.entries(node)) {
    if (NOT_WORDS.has(key) || key.startsWith('erdStudio.feedback.')) { continue; }
    userText(value, `${at}.${key}`, out);
  }
}

function oldTerms(text: string): string[] {
  let words = text
    .replace(/`[^`]*`/g, '')               // code spans: keys and folders keep their on-disk names
    .replace(/\(command:[^)]*\)/g, '')      // link targets are command ids
    .replace(/\S*\/\S*/g, '');              // paths such as .erd-studio/logical-models/
  for (const allowed of ALLOWED) { words = words.replace(allowed, ''); }
  return words.match(/\b(domains?|models?)\b/gi) ?? [];
}

describe('package.json wording (#179)', () => {
  const texts: Array<[string, string]> = [];
  userText({ description: pkg.description, displayName: pkg.displayName }, 'package', texts);
  userText(pkg.contributes, 'contributes', texts);

  it('says table / subject area, not model / domain, in what users read', () => {
    const offenders = texts.filter(([, text]) => oldTerms(text).length > 0).map(([at, text]) => `${at}: ${text}`);
    expect(offenders).toEqual([]);
  });

  it('renames the commands and views the issue names, keeping their ids', () => {
    const title = (id: string) => pkg.contributes.commands.find((c: { command: string }) => c.command === id)?.title;
    expect(title('erdStudio.createDomain')).toBe('New Subject Area');
    expect(title('erdStudio.moveRelationshipsToLibrary')).toBe('Move Relationships to Table Library');
    const views = Object.values(pkg.contributes.views).flat() as Array<{ id: string; name: string }>;
    expect(views.find(v => v.id === 'erdStudio.modelLibrary')?.name).toBe('Table Library');
  });
});
