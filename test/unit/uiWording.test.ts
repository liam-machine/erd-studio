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

describe('package.json storage wording (native DBML storage, 2.0)', () => {
  const texts: Array<[string, string]> = [];
  userText({ description: pkg.description, displayName: pkg.displayName }, 'package', texts);
  userText(pkg.contributes, 'contributes', texts);

  it('describes new projects as DBML, an open format, and says YAML/JSON projects keep working, on the Marketplace', () => {
    expect(pkg.description).toBe(
      'Logical data modeling in Git: draw ERDs in VS Code as plain files your AI assistant can read. New projects are DBML, an open format; YAML/JSON projects keep working. Import from dbdiagram.io, compare with dbt.',
    );
    // Not "saved as DBML" for every project: a YAML/JSON project keeps writing YAML and JSON.
    expect(pkg.description).not.toMatch(/saved as DBML/);
    expect(pkg.keywords).toContain('dbml editor');
    expect(pkg.keywords.length).toBeLessThanOrEqual(30);
  });

  it('never says "open standard", and never calls the storage YAML or JSON', () => {
    expect(texts.filter(([, text]) => /open standard/i.test(text)).map(([at]) => at)).toEqual([]);
    // Welcome views and walkthrough steps can show in a YAML project too, so they stay format-neutral
    // ("Each table is a file in .erd-studio/") or say DBML; none of them says the storage is YAML or JSON.
    const storageClaims = texts.filter(([at, text]) => /^contributes\.(viewsWelcome|walkthroughs)/.test(at) && /(YAML|JSON)/.test(text));
    expect(storageClaims.map(([at, text]) => `${at}: ${text}`)).toEqual([]);
  });

  it('keeps "an open format, no lock-in" where DBML import and export are offered', () => {
    const welcome = pkg.contributes.viewsWelcome as Array<{ contents: string; when?: string }>;
    for (const entry of welcome.filter((w) => w.contents.includes('command:erdStudio.importDbml'))) {
      expect(entry.contents).toContain('an open format, no lock-in');
    }
    const library = welcome.find((w) => w.contents.startsWith('No tables yet.'));
    expect(library?.contents).toContain('Each table is a file in .erd-studio/ you can commit.');
  });

  it('the Table Library says "Loading tables…" while it loads, and its empty state only once loaded', () => {
    const library = (pkg.contributes.viewsWelcome as Array<{ view: string; contents: string; when?: string }>)
      .filter((w) => w.view === 'erdStudio.modelLibrary');
    expect(library.map((w) => [w.contents.split('\n')[0], w.when])).toEqual([
      ['Loading tables…', 'erdStudio.tablesLoading'],
      ['No tables yet.', '!erdStudio.tablesLoading'],
    ]);
    // True in a DBML and a YAML project alike: no format, no folder, no "subject area" or "ERD editor".
    const empty = library[1].contents;
    expect(empty).not.toMatch(/YAML|DBML|logical-models|tables\/|subject area|ERD editor/i);
    expect(empty).toContain('diagram');
  });

  it('walkthrough and welcome views never claim every project is saved as DBML', () => {
    const claims = texts.filter(([at, text]) => /^contributes\.(viewsWelcome|walkthroughs)/.test(at) && /saved as DBML/i.test(text));
    expect(claims.map(([at]) => at)).toEqual([]);
  });
});

describe('package.json: commands for older projects and the AI helper files', () => {
  const commands = pkg.contributes.commands as Array<{ command: string; title: string }>;
  const palette = pkg.contributes.menus.commandPalette as Array<{ command: string; when?: string }>;

  it('hides Migrate Subject Areas to the Central Table Library in a DBML project, as the other YAML-only commands', () => {
    for (const id of ['erdStudio.migrateToV5', 'erdStudio.moveRelationshipsToLibrary', 'erdStudio.migrateToTableNaming']) {
      expect(palette.find((m) => m.command === id)?.when, id).toBe('erdStudio.storage != dbml');
    }
  });

  it('names the AI helper install command in plain words, never "harness", keeping its id', () => {
    const title = commands.find((c) => c.command === 'erdStudio.installCodingHarness')?.title;
    expect(title).toBe('Install AI Helper Files…');
    expect(commands.filter((c) => /harness/i.test(c.title)).map((c) => c.command)).toEqual([]);
  });
});
