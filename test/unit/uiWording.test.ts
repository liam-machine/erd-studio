/**
 * UI wording (#179, part 1 of #162): what a user reads says "table",
 * "Table Library" and "diagram", never "model" for one table or
 * "domain" for a diagram (string literals in the code: uiWordingSource.test.ts). "dbt model" stays where it means the dbt model.
 *
 * Only the words change: ids, `when` clauses, on-disk paths and the feedback
 * settings (where "model" is a language model) are left out of the scan.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { startCommandLink } from '../../src/types/startActions';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));

/** Keys whose values are ids, conditions or paths, not words. */
const NOT_WORDS = new Set(['command', 'id', 'when', 'url', 'fileMatch', 'view', 'viewType', 'filenamePattern', 'icon', 'image', 'markdown', 'svg', 'group', 'enablement', 'completionEvents']);

/**
 * The literal dbt `domain:*` tag the command strips is its name, not a diagram.
 * "Data model" is the whole design (the logical-first copy: "Design your data
 * model in Git"), never one table. A Power BI / Fabric "semantic model" is
 * Microsoft's name for the thing Import Semantic Model… reads, never one table.
 */
const ALLOWED = [/\bLegacy Domain Tags\b/g, /\bdbt models?\b/gi, /\bdbt Model\b/g, /\bdata models?\b/gi, /\bsemantic models?\b/gi];

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

  it('says table / diagram, not model / domain, in what users read', () => {
    const offenders = texts.filter(([, text]) => oldTerms(text).length > 0).map(([at, text]) => `${at}: ${text}`);
    expect(offenders).toEqual([]);
  });

  it('renames the commands and views the issue names, keeping their ids', () => {
    const title = (id: string) => pkg.contributes.commands.find((c: { command: string }) => c.command === id)?.title;
    expect(title('erdStudio.moveRelationshipsToLibrary')).toBe('Move Relationships to Table Library');
    const views = Object.values(pkg.contributes.views).flat() as Array<{ id: string; name: string }>;
    expect(views.find(v => v.id === 'erdStudio.modelLibrary')?.name).toBe('Table Library');
  });

  it('calls a diagram a diagram in the commands on one; only the two file-format commands keep "Subject Area"', () => {
    const title = (id: string) => pkg.contributes.commands.find((c: { command: string }) => c.command === id)?.title;
    expect(['createDomain', 'openDomain', 'renameDomain', 'deleteDomain'].map((id) => title(`erdStudio.${id}`)))
      .toEqual(['New Diagram…', 'Open Diagram', 'Rename Diagram…', 'Delete Diagram']);
    const subjectArea = (pkg.contributes.commands as Array<{ command: string; title: string }>)
      .filter((c) => /subject area/i.test(c.title)).map((c) => c.command);
    expect(subjectArea).toEqual(['erdStudio.setupSemanticDirectory', 'erdStudio.migrateToV5']);
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
    // The import start (Import…, whose first source is DBML) and any direct Import DBML link.
    const offersImport = welcome.filter((w) => w.contents.includes('command:erdStudio.importDbml') || w.contents.includes(startCommandLink('import', 'sidebar')));
    expect(offersImport.length).toBeGreaterThanOrEqual(2);
    for (const entry of offersImport) {
      expect(entry.contents).toContain('an open format, no lock-in');
      expect(entry.contents).not.toMatch(/open standard/i);
    }
    const steps = pkg.contributes.walkthroughs[0].steps as Array<{ description: string }>;
    for (const step of steps.filter((s) => s.description.includes(startCommandLink('import', 'walkthrough')))) {
      expect(step.description).toContain('an open format, no lock-in');
    }
    const library = welcome.find((w) => w.contents.startsWith('No tables yet.'));
    expect(library?.contents).toContain('Each table is a file in .erd-studio/ you can commit.');
  });

  it('the ERD Studio view says "Loading diagrams…" while it loads, and "No diagrams yet." only once loaded', () => {
    const diagrams = (pkg.contributes.viewsWelcome as Array<{ view: string; contents: string; when?: string }>)
      .filter((w) => w.view === 'erdStudio.domainTree');
    // Also while a folder without dbt waits for its suggested start (test/unit/startActions.test.ts).
    expect(diagrams.find((w) => w.contents === 'Loading diagrams…')?.when).toBe(
      'erdStudio.hasProject && (erdStudio.diagramsLoading || (!erdStudio.hasDbtProject && erdStudio.storage != yaml && erdStudio.storage != mixed && !erdStudio.startIntent))',
    );
    // A folder without dbt (New Diagram, or one per direct import the folder suggests) and a dbt project.
    const empty = diagrams.filter((w) => w.contents.startsWith('No diagrams yet.'));
    expect(empty).toHaveLength(5);
    for (const w of empty) expect(w.when).toMatch(/&& !erdStudio\.diagramsLoading( &&|$)/);
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
    for (const id of ['erdStudio.migrateToV5', 'erdStudio.moveRelationshipsToLibrary']) {
      expect(palette.find((m) => m.command === id)?.when, id).toBe('erdStudio.storage != dbml');
    }
    // Migrate to Table Naming renames YAML files only: never offered in a DBML or mixed project.
    expect(palette.find((m) => m.command === 'erdStudio.migrateToTableNaming')?.when).toBe('erdStudio.storage == yaml');
  });

  it('hides the YAML-era commands in a DBML project, in the palette and the view menus', () => {
    const viewTitle = pkg.contributes.menus['view/title'] as Array<{ command: string; when?: string }>;
    for (const id of ['erdStudio.organizeModelLibrary', 'erdStudio.initializeLayerConfig', 'erdStudio.moveRelationshipsToLibrary']) {
      expect(palette.find((m) => m.command === id)?.when, id).toMatch(/erdStudio\.storage != dbml/);
    }
    // Convert stays in the palette of a DBML project: doctor's finish-dbml-conversion step tells the
    // user to run it there to settle pending relationships and diagram members (its view menu entry is hidden).
    expect(palette.find((m) => m.command === 'erdStudio.convertProjectToDbml')?.when).toBe('erdStudio.hasProject');
    // Setup stays offered before there is any .erd-studio folder (a new project reads as DBML).
    expect(palette.find((m) => m.command === 'erdStudio.setupSemanticDirectory')?.when).toBe('erdStudio.storage != dbml || !erdStudio.hasSemanticDir');
    for (const id of ['erdStudio.organizeModelLibrary', 'erdStudio.convertProjectToDbml', 'erdStudio.moveRelationshipsToLibrary']) {
      for (const entry of viewTitle.filter((m) => m.command === id)) expect(entry.when, id).toContain('erdStudio.storage != dbml');
    }
    // Their ids stay contributed (and so registered, with their dbtSemantic aliases).
    for (const id of ['erdStudio.organizeModelLibrary', 'erdStudio.setupSemanticDirectory', 'erdStudio.initializeLayerConfig', 'erdStudio.convertProjectToDbml']) {
      expect(commands.some((c) => c.command === id), id).toBe(true);
    }
  });

  it('has one AI helper entry in the Help view: Install AI Helper Files… is in the palette only', () => {
    const viewTitle = pkg.contributes.menus['view/title'] as Array<{ command: string; when?: string }>;
    expect(viewTitle.filter((m) => m.command === 'erdStudio.installCodingHarness')).toEqual([]);
    // Still in the Command Palette: no entry hides it there.
    expect(palette.some((m) => m.command === 'erdStudio.installCodingHarness')).toBe(false);
  });

  it('names the AI helper install command in plain words, never "harness", keeping its id', () => {
    const title = commands.find((c) => c.command === 'erdStudio.installCodingHarness')?.title;
    expect(title).toBe('Install AI Helper Files…');
    expect(commands.filter((c) => /harness/i.test(c.title)).map((c) => c.command)).toEqual([]);
  });
});

/**
 * Logical first, dbt as an add-on: in a folder without dbt_project.yml (or with no folder open)
 * nothing VS Code draws from `contributes` names dbt or offers a dbt control. Every dbt word and
 * dbt command stays, gated to `erdStudio.hasDbtProject`. Settings are out of scope: VS Code cannot
 * hide a setting by context.
 */
describe('package.json: dbt shows up only in dbt projects', () => {
  type Entry = { command?: string; submenu?: string; when?: string };
  const DBT_WORDS = /\b(dbt|manifest|catalog|selectors|physical)\b/i;
  /** True only when the clause requires a dbt project (every clause here is a plain `&&` chain). */
  const dbtOnly = (when: string | undefined) => !!when && when.split('&&').map((c) => c.trim()).includes('erdStudio.hasDbtProject');
  const commands = pkg.contributes.commands as Array<{ command: string; title: string }>;
  const menus = pkg.contributes.menus as Record<string, Entry[]>;
  /** dbt-only by what they do, even where the title does not say dbt. */
  const DBT_COMMANDS = new Set([
    ...commands.filter((c) => DBT_WORDS.test(c.title)).map((c) => c.command),
    'erdStudio.trySampleProject',
  ]);

  it('knows the dbt-only commands', () => {
    expect([...DBT_COMMANDS].sort()).toEqual([
      'erdStudio.drawFromDbt', 'erdStudio.refreshManifest', 'erdStudio.selectDbtProject',
      'erdStudio.stripLegacyDomainTags', 'erdStudio.syncDomainTags', 'erdStudio.trySampleProject',
    ]);
  });

  it('hides every dbt-only command from the palette and every menu outside a dbt project', () => {
    for (const id of DBT_COMMANDS) {
      const palette = menus.commandPalette.filter((m) => m.command === id);
      expect(palette, id).toHaveLength(1);
      expect(dbtOnly(palette[0].when), `${id}: ${palette[0].when}`).toBe(true);
    }
    for (const [menu, entries] of Object.entries(menus)) {
      for (const entry of entries.filter((m) => m.command && DBT_COMMANDS.has(m.command))) {
        expect(dbtOnly(entry.when), `${menu} ${entry.command}: ${entry.when}`).toBe(true);
      }
    }
    // The "Select dbt Project…" title button, not only the multi-project flag.
    expect(menus['view/title'].find((m) => m.command === 'erdStudio.selectDbtProject')?.when)
      .toBe('view == erdStudio.domainTree && erdStudio.hasDbtProject && erdStudio.hasMultipleDbtProjects');
  });

  it('keeps dbt words out of welcome views and walkthrough steps that can show without dbt', () => {
    const offenders: string[] = [];
    for (const w of pkg.contributes.viewsWelcome as Array<{ view: string; contents: string; when?: string }>) {
      if (!dbtOnly(w.when) && DBT_WORDS.test(w.contents)) offenders.push(`viewsWelcome ${w.view} [${w.when}]: ${w.contents}`);
    }
    for (const walkthrough of pkg.contributes.walkthroughs as Array<{ id: string; title: string; description: string; steps: Array<{ id: string; title: string; description: string; when?: string; media: { svg: string; altText?: string } }> }>) {
      // A walkthrough's own title and description cannot be gated.
      if (DBT_WORDS.test(`${walkthrough.title} ${walkthrough.description}`)) offenders.push(`walkthrough ${walkthrough.id}`);
      for (const step of walkthrough.steps.filter((s) => !dbtOnly(s.when))) {
        if (DBT_WORDS.test(`${step.title} ${step.description} ${step.media.altText ?? ''}`)) offenders.push(`step ${step.id}`);
        expect(step.description, step.id).not.toContain('erdStudio.trySampleProject');
        // Its picture neither: no dbt project file or dbt folder layout (models/, seeds/, target/).
        const svg = fs.readFileSync(path.join(__dirname, '../..', step.media.svg), 'utf8');
        const svgText = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(' ');
        if (DBT_WORDS.test(svgText) || /\b(models|seeds|target)\/|dbt_project\.yml/.test(svgText)) offenders.push(`step ${step.id} svg ${step.media.svg}: ${svgText}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the dbt text in a dbt project', () => {
    const welcome = pkg.contributes.viewsWelcome as Array<{ contents: string; when?: string }>;
    expect(welcome.find((w) => w.when === 'erdStudio.hasDbtProject && !erdStudio.diagramsLoading && erdStudio.storage != yaml && erdStudio.storage != mixed')?.contents).toContain(`[Draw from dbt](${startCommandLink('drawFromDbt', 'sidebar')})`);
    expect(welcome.find((w) => w.when === 'erdStudio.hasDbtProject && erdStudio.hasMultipleDbtProjects')?.contents).toContain('[Select dbt Project](command:erdStudio.selectDbtProject)');
    const steps = (pkg.contributes.walkthroughs[0].steps as Array<{ id: string; title: string; when?: string }>);
    expect(steps.filter((s) => dbtOnly(s.when)).map((s) => [s.id, s.title])).toEqual([
      ['convertDbt', 'Move this project to DBML'],
      ['draw', 'Draw your dbt project — no AI needed'],
      ['watch', 'Watch the one-minute tour'],
    ]);
  });
});
