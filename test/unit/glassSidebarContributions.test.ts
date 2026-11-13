/**
 * The glass sidebar's reading of package.json contributions
 * (`src/providers/glassSidebar/contributions.ts`): which row menu, title
 * actions and welcome content each view gets for a given context, ordered and
 * grouped the way VS Code draws them. First against the real manifest (so a
 * menu change reaches both sidebars and this test says what moved), then
 * against a synthetic one that pins the grouping rules on their own.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  codiconId,
  compareGroups,
  ContributionIndex,
  isAllowedWelcomeCommand,
  parseCommandLink,
  parseGroup,
  parseWelcomeContents,
  withoutGlassClause,
  type Contributions,
  type MenuAction,
} from '../../src/providers/glassSidebar/contributions';
import { evaluateWhen, type ContextLookup, type ContextValue } from '../../src/providers/glassSidebar/whenClause';

const ROOT = path.join(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { contributes: Contributions };
const index = new ContributionIndex(manifest.contributes);

const DIAGRAMS = 'erdStudio.domainTree';
const TABLES = 'erdStudio.modelLibrary';
const RELATIONSHIPS = 'erdStudio.relationships';
const HELP = 'erdStudio.help';

/** A context as the provider builds it: `view` / `viewItem` plus the extension's context keys. */
function ctx(view: string | undefined, viewItem: string | undefined, keys: Record<string, ContextValue> = {}): ContextLookup {
  return (key) => {
    if (key === 'view') return view;
    if (key === 'viewItem') return viewItem;
    return Object.prototype.hasOwnProperty.call(keys, key) ? keys[key] : undefined;
  };
}

const titles = (actions: MenuAction[]) => actions.map((a) => a.title);
const groupTitles = (groups: MenuAction[][]) => groups.map(titles);
/** The context menu as VS Code draws it: navigation first, then the other groups. */
function contextMenu(view: string, viewItem: string, keys: Record<string, ContextValue> = {}): string[][] {
  const m = index.resolve('view/item/context', ctx(view, viewItem, keys));
  return groupTitles([m.navigation, ...m.groups].filter((g) => g.length > 0));
}
function inline(view: string, viewItem: string, keys: Record<string, ContextValue> = {}): string[] {
  return titles(index.resolve('view/item/context', ctx(view, viewItem, keys)).inline);
}

const PROJECT = { 'erdStudio.hasProject': true, 'erdStudio.hasSemanticDir': true, 'erdStudio.hasLogicalModelsDir': true };

describe('real package.json: row context menus', () => {
  it('a diagram row: Reveal in Explorer (as a table row has), Export / Rename / Delete; Move only with dbml or mixed storage', () => {
    expect(contextMenu(DIAGRAMS, 'domain', { 'erdStudio.storage': 'yaml' })).toEqual([
      ['Reveal in Explorer'],
      ['Export Diagram…'],
      ['Rename Diagram…', 'Delete Diagram'],
    ]);
    expect(contextMenu(DIAGRAMS, 'domain')).toEqual([
      ['Reveal in Explorer'],
      ['Export Diagram…'],
      ['Rename Diagram…', 'Delete Diagram'],
    ]);
    for (const storage of ['dbml', 'mixed']) {
      expect(contextMenu(DIAGRAMS, 'domain', { 'erdStudio.storage': storage })).toEqual([
        ['Reveal in Explorer'],
        ['Export Diagram…'],
        ['Rename Diagram…', 'Move Diagram to Layer…', 'Delete Diagram'],
      ]);
    }
    expect(inline(DIAGRAMS, 'domain')).toEqual([]);
  });

  it('a diagram row menu belongs to the Diagrams view only', () => {
    expect(contextMenu(TABLES, 'domain', { 'erdStudio.storage': 'dbml' })).toEqual([]);
  });

  it('layer rows: New Diagram inline and first; Edit / Remove for every layer kind', () => {
    expect(inline(DIAGRAMS, 'layerCreatable')).toEqual(['New Diagram…']);
    expect(contextMenu(DIAGRAMS, 'layerCreatable')).toEqual([['New Diagram…'], ['Edit Layer…', 'Remove Layer']]);
    expect(inline(DIAGRAMS, 'layer')).toEqual([]);
    expect(contextMenu(DIAGRAMS, 'layer')).toEqual([['Edit Layer…', 'Remove Layer']]);
  });

  it('a table in the Table Library: Add to Open Diagram inline (its click goes to the diagram), then Open File / Reveal, then Add, then Move / Delete', () => {
    const dbml = { 'erdStudio.storage': 'dbml' };
    const row = index.resolve('view/item/context', ctx(TABLES, 'logicalModel', dbml));
    // The native tree's hover buttons: the + alone (Open in Diagram… is the click now).
    expect(titles(row.inline)).toEqual(['Add to Open Diagram']);
    expect(row.inline.map((a) => a.icon)).toEqual(['add']);
    expect(titles(row.navigation)).toEqual(['Open File', 'Reveal in Explorer']);
    expect(groupTitles(row.groups)).toEqual([['Add to Open Diagram', 'Add to Diagram…'], ['Move Table…', 'Delete Table']]);
    // Shown by two or more diagrams: Show on Another Diagram… after Open File.
    const several = index.resolve('view/item/context', ctx(TABLES, 'logicalModelOnSeveral', dbml));
    expect(titles(several.navigation)).toEqual(['Open File', 'Show on Another Diagram…', 'Reveal in Explorer']);
    // A file that needs fixing opens on click: the diagram is the other way in.
    const broken = index.resolve('view/item/context', ctx(TABLES, 'logicalModelBroken', dbml));
    expect(titles(broken.navigation)).toEqual(['Open in Diagram…', 'Reveal in Explorer']);

    // Nothing in the row menus depends on the glass sidebar being on.
    const glass = index.resolve('view/item/context', ctx(TABLES, 'logicalModel', { ...dbml, 'erdStudio.glassSidebar': true }));
    expect(glass).toEqual(row);

    expect(contextMenu(TABLES, 'logicalModel', { 'erdStudio.storage': 'yaml' })).toEqual([
      ['Open File', 'Reveal in Explorer'],
      ['Add to Open Diagram', 'Add to Diagram…'],
      ['Delete Table'],
    ]);
  });

  it('read-only and duplicate tables get their own subsets', () => {
    expect(inline(TABLES, 'logicalModelReadOnly')).toEqual([]);
    expect(contextMenu(TABLES, 'logicalModelReadOnly', { 'erdStudio.storage': 'dbml' })).toEqual([['Open in Diagram…']]);

    expect(inline(TABLES, 'logicalModelDuplicate')).toEqual(['Give Duplicate Table Its Own Name…']);
    expect(contextMenu(TABLES, 'logicalModelDuplicate', { 'erdStudio.storage': 'dbml' })).toEqual([
      ['Open in Diagram…', 'Reveal in Explorer'],
      ['Give Duplicate Table Its Own Name…'],
    ]);
  });

  it('Table Library layer and schema rows: New Table (and New Schema on a layer) with dbml or mixed storage', () => {
    for (const storage of ['dbml', 'mixed']) {
      expect(inline(TABLES, 'tableLibraryLayer', { 'erdStudio.storage': storage })).toEqual(['New Table…']);
      expect(contextMenu(TABLES, 'tableLibraryLayer', { 'erdStudio.storage': storage })).toEqual([['Reveal in Explorer'], ['New Table…', 'New Schema…'], ['Edit Layer…']]);
      expect(contextMenu(TABLES, 'tableLibrarySchema', { 'erdStudio.storage': storage })).toEqual([['Reveal in Explorer'], ['New Table…']]);
    }
    expect(inline(TABLES, 'tableLibraryLayer', { 'erdStudio.storage': 'yaml' })).toEqual([]);
    expect(contextMenu(TABLES, 'tableLibraryLayer', { 'erdStudio.storage': 'yaml' })).toEqual([['Reveal in Explorer'], ['Edit Layer…']]);
    // A YAML library's folder row: its folder in the Explorer.
    expect(contextMenu(TABLES, 'logicalModelFolder', { 'erdStudio.storage': 'yaml' })).toEqual([['Reveal in Explorer']]);
  });

  it('relationship rows: the button and the menu are the way in the click does not take (the row value says which)', () => {
    // Grouped by table: the click goes to the diagram.
    expect(inline(RELATIONSHIPS, 'relationship')).toEqual(['Open in File']);
    expect(contextMenu(RELATIONSHIPS, 'relationship')).toEqual([['Open in File']]);
    // Grouped by file, or a problem: the click opens the file.
    expect(inline(RELATIONSHIPS, 'relationshipInFile')).toEqual(['Open in Diagram…']);
    expect(contextMenu(RELATIONSHIPS, 'relationshipInFile')).toEqual([['Open in Diagram…']]);
    // The grouping's context key no longer decides it.
    for (const grouping of [undefined, 'table', 'file']) {
      expect(inline(RELATIONSHIPS, 'relationship', { 'erdStudio.relationshipsGrouping': grouping })).toEqual(['Open in File']);
    }
    expect(inline(RELATIONSHIPS, 'relationshipsTable')).toEqual(['Open in Diagram…']);
    expect(contextMenu(RELATIONSHIPS, 'relationshipsTable')).toEqual([['Open in Diagram…']]);
  });

  it('Help: My Reports refreshes inline; other rows have no menu', () => {
    const row = index.resolve('view/item/context', ctx(HELP, 'myReports'));
    expect(titles(row.inline)).toEqual(['Refresh My Reports']);
    expect(row.inline[0].icon).toBe('refresh');
    expect(row.navigation).toEqual([]);
    expect(row.groups).toEqual([]);
    expect(contextMenu(HELP, 'helpLink')).toEqual([]);
  });

  it("each action's (menu, index) names the entry it was drawn from", () => {
    const row = index.resolve('view/item/context', ctx(TABLES, 'logicalModel', { 'erdStudio.storage': 'dbml' }));
    for (const action of [...row.inline, ...row.navigation, ...row.groups.flat()]) {
      expect(action.menu).toBe('view/item/context');
      const entry = manifest.contributes.menus?.['view/item/context'][action.index];
      expect(index.command(entry?.command as string)?.title).toBe(action.title);
    }
  });
});

describe('real package.json: title actions', () => {
  it('Diagrams, no project: only Watch the Tour', () => {
    const t = index.resolve('view/title', ctx(DIAGRAMS, undefined));
    expect(titles(t.navigation)).toEqual(['Watch the Tour']);
    expect(t.navigation[0].icon).toBe('play-circle');
    expect(t.groups).toEqual([]);
  });

  it('Diagrams with a project: the New… submenu and Filter as icons; Export All and row details in the … menu', () => {
    const t = index.resolve('view/title', ctx(DIAGRAMS, undefined, PROJECT));
    expect(titles(t.navigation)).toEqual(['New…', 'Filter Diagrams…']);
    expect(t.navigation.map((a) => a.icon)).toEqual(['add', 'filter']);
    expect(groupTitles(t.groups)).toEqual([['Export All Diagrams…'], ['Show Row Details']]);
  });

  it('the New… submenu resolves its own groups from erdStudio.newMenu', () => {
    const newMenu = index.resolve('view/title', ctx(DIAGRAMS, undefined, PROJECT)).navigation[0];
    expect(newMenu.menu).toBe('view/title');
    expect(groupTitles(newMenu.submenu ?? [])).toEqual([
      ['New Diagram…', 'Import DBML…', 'Import SQL DDL…', 'Import Power BI or Fabric Semantic Model…'],
      ['Bring In Your Data Model…'],
      ['New Layer…'],
    ]);
    expect(newMenu.submenu?.flat().every((a) => a.menu === 'erdStudio.newMenu')).toBe(true);

    const dbt = index.resolve('view/title', ctx(DIAGRAMS, undefined, { ...PROJECT, 'erdStudio.hasDbtProject': true })).navigation[0];
    expect(titles(dbt.submenu?.[0] ?? [])).toEqual([
      'New Diagram…', 'Import from dbt…', 'Import DBML…', 'Import SQL DDL…', 'Import Power BI or Fabric Semantic Model…',
    ]);
  });

  it('Diagrams with several dbt projects, filtered: Clear Filter as the icon, Filter… first in the … menu', () => {
    const t = index.resolve('view/title', ctx(DIAGRAMS, undefined, {
      ...PROJECT,
      'erdStudio.hasDbtProject': true,
      'erdStudio.hasMultipleDbtProjects': true,
      'erdStudio.diagramsFiltered': true,
      'erdStudio.sidebarRowDetails': 'full',
    }));
    expect(titles(t.navigation)).toEqual(['New…', 'Clear Diagrams Filter']);
    expect(t.navigation[1].icon).toBe('filter-filled');
    expect(groupTitles(t.groups)).toEqual([
      ['Filter Diagrams…'],
      ['Select dbt Project…'],
      ['Export All Diagrams…'],
      ['Hide Row Details'],
    ]);
  });

  it('Table Library: storage decides between New Table / Schema and the organise actions', () => {
    const dbml = index.resolve('view/title', ctx(TABLES, undefined, { ...PROJECT, 'erdStudio.storage': 'dbml' }));
    expect(titles(dbml.navigation)).toEqual(['Go to Table…', 'Filter Table Library…']);
    expect(dbml.navigation.map((a) => a.icon)).toEqual(['search', 'filter']);
    expect(groupTitles(dbml.groups)).toEqual([['New Table…', 'New Schema…'], ['Show Row Details']]);

    const yaml = index.resolve('view/title', ctx(TABLES, undefined, { ...PROJECT, 'erdStudio.storage': 'yaml' }));
    expect(groupTitles(yaml.groups)).toEqual([
      ['Organise Table Library by Layer', 'Move Relationships to Table Library', 'Migrate to the New File Naming', 'Convert Project to DBML'],
      ['Show Row Details'],
    ]);

    const mixed = index.resolve('view/title', ctx(TABLES, undefined, { ...PROJECT, 'erdStudio.storage': 'mixed' }));
    expect(groupTitles(mixed.groups)).toEqual([
      ['New Table…', 'New Schema…'],
      ['Organise Table Library by Layer', 'Move Relationships to Table Library', 'Convert Project to DBML'],
      ['Show Row Details'],
    ]);
  });

  it('Relationships: the grouping toggle and Filter, in @order', () => {
    const byTable = index.resolve('view/title', ctx(RELATIONSHIPS, undefined, PROJECT));
    expect(titles(byTable.navigation)).toEqual(['Group by Relationships File', 'Filter Relationships…']);
    expect(byTable.navigation.map((a) => a.icon)).toEqual(['files', 'filter']);

    const byFile = index.resolve('view/title', ctx(RELATIONSHIPS, undefined, { ...PROJECT, 'erdStudio.relationshipsGrouping': 'file' }));
    expect(titles(byFile.navigation)).toEqual(['Group by Table', 'Filter Relationships…']);
    expect(byFile.navigation[0].icon).toBe('list-tree');
  });

  it('Help: Refresh My Reports only once reports are tracked; no row-details toggle', () => {
    expect(index.resolve('view/title', ctx(HELP, undefined, PROJECT))).toEqual({ inline: [], navigation: [], groups: [] });
    const t = index.resolve('view/title', ctx(HELP, undefined, { ...PROJECT, 'erdStudio.hasTrackedReports': true }));
    expect(groupTitles(t.groups)).toEqual([['Refresh My Reports']]);
  });

  it('commands without an icon have none', () => {
    const t = index.resolve('view/title', ctx(DIAGRAMS, undefined, PROJECT));
    expect(t.groups.flat().find((a) => a.title === 'Show Row Details')?.icon).toBeUndefined();
  });
});

describe('real package.json: running an action', () => {
  const diagramsCtx = ctx(DIAGRAMS, undefined, PROJECT);
  const titleMenus = new Set(['view/title', ...index.submenusOf('view/title', diagramsCtx)]);

  it('submenusOf lists the submenus a visible title entry opens', () => {
    expect(index.submenusOf('view/title', diagramsCtx)).toEqual(['erdStudio.newMenu']);
    expect(index.submenusOf('view/title', ctx(TABLES, undefined, PROJECT))).toEqual([]);
    expect(index.submenusOf('view/title', ctx(DIAGRAMS, undefined))).toEqual([]);
  });

  it('commandFor returns the command of a visible entry', () => {
    const t = index.resolve('view/title', diagramsCtx);
    const exportAll = t.groups.flat().find((a) => a.title === 'Export All Diagrams…') as MenuAction;
    expect(index.commandFor(exportAll.menu, exportAll.index, diagramsCtx, titleMenus)).toBe('erdStudio.exportAllDiagrams');
    const newDiagram = t.navigation[0].submenu?.[0][0] as MenuAction;
    expect(index.commandFor(newDiagram.menu, newDiagram.index, diagramsCtx, titleMenus)).toBe('erdStudio.createDomain');
  });

  it('commandFor refuses hidden entries, other menus, submenu entries and bad indices', () => {
    const items = manifest.contributes.menus?.['view/item/context'] ?? [];
    const moveDiagram = items.findIndex((e) => e.command === 'erdStudio.moveDiagram');
    const itemMenus = new Set(['view/item/context']);
    expect(index.commandFor('view/item/context', moveDiagram, ctx(DIAGRAMS, 'domain', { 'erdStudio.storage': 'dbml' }), itemMenus)).toBe('erdStudio.moveDiagram');
    expect(index.commandFor('view/item/context', moveDiagram, ctx(DIAGRAMS, 'domain', { 'erdStudio.storage': 'yaml' }), itemMenus)).toBeUndefined();
    expect(index.commandFor('view/item/context', moveDiagram, ctx(DIAGRAMS, 'domain', { 'erdStudio.storage': 'dbml' }), titleMenus)).toBeUndefined();

    const submenuEntry = (manifest.contributes.menus?.['view/title'] ?? []).findIndex((e) => e.submenu);
    expect(index.commandFor('view/title', submenuEntry, diagramsCtx, titleMenus)).toBeUndefined();
    for (const bad of [-1, 1.5, Number.NaN, 10_000]) {
      expect(index.commandFor('view/title', bad, diagramsCtx, titleMenus)).toBeUndefined();
    }
    expect(index.commandFor('constructor', 0, diagramsCtx, new Set(['constructor']))).toBeUndefined();
    expect(index.commandFor('erdStudio.newMenu', 0, ctx(TABLES, undefined, PROJECT), new Set(['view/title']))).toBeUndefined();
  });
});

describe('real package.json: views and welcome content', () => {
  it('lists the four sidebar views in order, each when readable with the glass clause taken out', () => {
    const views = index.views().filter((v) => v.type !== 'webview');
    expect(views.map((v) => v.id)).toEqual([DIAGRAMS, TABLES, RELATIONSHIPS, HELP]);
    const shown = (keys: Record<string, ContextValue>) =>
      views.filter((v) => evaluateWhen(withoutGlassClause(v.when), ctx(undefined, undefined, keys))).map((v) => v.id);
    expect(shown({})).toEqual([DIAGRAMS]);
    expect(shown({ 'erdStudio.hasProject': true })).toEqual([DIAGRAMS, HELP]);
    expect(shown({ ...PROJECT, 'erdStudio.glassSidebar': true })).toEqual([DIAGRAMS, TABLES, RELATIONSHIPS, HELP]);
  });

  const welcomeOf = (view: string, keys: Record<string, ContextValue>) =>
    index.welcome(view, ctx(undefined, undefined, keys)).map((w) => w.contents.split('\n')[0]);

  it('no folder open: Open Folder', () => {
    expect(welcomeOf(DIAGRAMS, { workspaceFolderCount: 0 })).toEqual([
      'Design your data model in Git, as DBML files: an open format, no lock-in.',
    ]);
  });

  it('a project still deciding: Loading diagrams…', () => {
    const base = { workspaceFolderCount: 1, 'erdStudio.hasProject': true };
    expect(welcomeOf(DIAGRAMS, base)).toEqual(['Loading diagrams…']);
    expect(welcomeOf(DIAGRAMS, { ...base, 'erdStudio.storage': 'dbml' })).toEqual(['Loading diagrams…']);
    expect(welcomeOf(DIAGRAMS, { ...base, 'erdStudio.diagramsLoading': true, 'erdStudio.storage': 'yaml' })).toEqual(['Loading diagrams…']);
  });

  it('an older (yaml / mixed) project: Convert to DBML', () => {
    for (const storage of ['yaml', 'mixed']) {
      expect(welcomeOf(DIAGRAMS, { workspaceFolderCount: 1, 'erdStudio.hasProject': true, 'erdStudio.storage': storage })).toEqual([
        'This project is from an older ERD Studio. Convert it once to DBML: nothing is lost.',
      ]);
      expect(welcomeOf(DIAGRAMS, { 'erdStudio.hasProject': true, 'erdStudio.hasDbtProject': true, 'erdStudio.storage': storage })).toEqual([
        "This dbt project's ERD Studio files are older. Convert them once to DBML: nothing is lost.",
      ]);
    }
  });

  it('an empty DBML project: the entry its start intent names', () => {
    const base = { workspaceFolderCount: 1, 'erdStudio.hasProject': true, 'erdStudio.storage': 'dbml' };
    expect(welcomeOf(DIAGRAMS, { ...base, 'erdStudio.startIntent': 'blank' })).toEqual(['No diagrams yet.']);
    expect(welcomeOf(DIAGRAMS, { ...base, 'erdStudio.startIntent': 'importSqlDdl' })).toEqual(['No diagrams yet. This folder has CREATE TABLE scripts.']);
    expect(welcomeOf(DIAGRAMS, { ...base, 'erdStudio.startIntent': 'importDbmlFile' })).toEqual(['No diagrams yet. This folder has a DBML file.']);
    expect(welcomeOf(DIAGRAMS, { ...base, 'erdStudio.startIntent': 'importSemanticModel' })).toEqual([
      'No diagrams yet. This folder has a Power BI or Fabric semantic model.',
    ]);
  });

  it('a dbt project: Import from dbt, plus Select dbt Project when there are several', () => {
    const base = { workspaceFolderCount: 1, 'erdStudio.hasProject': true, 'erdStudio.hasDbtProject': true, 'erdStudio.storage': 'dbml' };
    expect(welcomeOf(DIAGRAMS, base)).toEqual(['No diagrams yet. This folder is a dbt project.']);
    expect(welcomeOf(DIAGRAMS, { ...base, 'erdStudio.hasMultipleDbtProjects': true })).toEqual([
      'No diagrams yet. This folder is a dbt project.',
      'This workspace has more than one dbt project.',
    ]);
  });

  it('Table Library and Relationships', () => {
    expect(welcomeOf(TABLES, { 'erdStudio.tablesLoading': true })).toEqual(['Loading tables…']);
    expect(welcomeOf(TABLES, {})).toEqual(['No tables yet.']);
    expect(welcomeOf(RELATIONSHIPS, {})).toEqual(['No relationships yet.']);
    expect(welcomeOf(HELP, {})).toEqual([]);
  });

  it('welcome indices point back into viewsWelcome', () => {
    const shown = index.welcome(DIAGRAMS, ctx(undefined, undefined, { workspaceFolderCount: 0 }));
    expect(shown).toHaveLength(1);
    expect(index.welcomeEntry(shown[0].index)?.contents).toBe(shown[0].contents);
    expect(index.welcomeEntry(-1)).toBeUndefined();
    expect(index.welcomeEntry(0.5)).toBeUndefined();
  });

  it('the no-folder entry parses into buttons with runnable command links', () => {
    const [entry] = index.welcome(DIAGRAMS, ctx(undefined, undefined, { workspaceFolderCount: 0 }));
    const { paragraphs, links } = parseWelcomeContents(entry.contents);
    expect(paragraphs.map((p) => p.button)).toEqual([false, true, false]);
    expect(links.map((l) => l.label)).toEqual(['Open Folder…', 'More ways to start…']);
    expect(parseCommandLink(links[0].href)).toEqual({ command: 'workbench.action.files.openFolder', args: [] });
    expect(parseCommandLink(links[1].href)).toEqual({ command: 'erdStudio.start', args: [{ from: 'sidebar' }] });
    expect(paragraphs[2].parts).toEqual([{ kind: 'text', text: 'Or: ' }, { kind: 'link', label: 'More ways to start…', link: 1 }]);
  });

  it('every command link in the sidebar welcome content parses and is allowed', () => {
    for (const w of manifest.contributes.viewsWelcome ?? []) {
      if (![DIAGRAMS, TABLES, RELATIONSHIPS, HELP].includes(w.view)) continue;
      for (const link of parseWelcomeContents(w.contents).links) {
        expect(parseCommandLink(link.href), link.href).toBeDefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Synthetic manifest: the grouping rules on their own
// ---------------------------------------------------------------------------

describe('synthetic manifest', () => {
  const contributes: Contributions = {
    commands: [
      { command: 'x.alpha', title: 'Alpha', icon: '$(add)' },
      { command: 'x.beta', title: 'Beta', icon: '$(sync~spin)' },
      { command: 'x.gamma', title: 'Gamma', icon: { light: 'l.svg', dark: 'd.svg' } },
      { command: 'x.delta', title: 'Delta' },
      { command: 'x.epsilon', title: 'Epsilon' },
      { command: 'x.zeta', title: 'Zeta' },
    ],
    submenus: [
      { id: 'x.sub', label: 'More', icon: '$(ellipsis)' },
      { id: 'x.empty', label: 'Empty' },
      { id: 'x.nested', label: 'Nested' },
    ],
    menus: {
      'view/title': [
        /* 0 */ { command: 'x.zeta' },                                   // ungrouped: last
        /* 1 */ { command: 'x.delta', group: 'b_group@2' },
        /* 2 */ { command: 'x.epsilon', group: 'b_group@1' },
        /* 3 */ { command: 'x.beta', group: 'navigation@1' },
        /* 4 */ { command: 'x.alpha', group: 'navigation@1' },            // same order: by title
        /* 5 */ { command: 'x.gamma', group: 'a_group' },
        /* 6 */ { command: 'x.alpha', group: 'inline' },
        /* 7 */ { command: 'x.missing', group: 'navigation@0' },          // not contributed: dropped
        /* 8 */ { submenu: 'x.sub', group: 'navigation@9', when: 'flag' },
        /* 9 */ { submenu: 'x.empty', group: 'navigation@3' },            // nothing visible: dropped
        /* 10 */ { submenu: 'x.unknown', group: 'navigation@4' },         // not contributed: dropped
        /* 11 */ { command: 'x.delta', group: 'navigation@0', when: 'a &&' }, // unparseable: hidden
        /* 12 */ { command: 'x.epsilon', group: 'Z_upper' },
      ],
      'x.sub': [
        { command: 'x.delta', group: 'inline' },
        { command: 'x.beta' },
        { command: 'x.alpha', group: 'navigation' },
        { submenu: 'x.nested', group: 'z' },
      ],
      'x.empty': [{ command: 'x.alpha', when: 'false' }],
      'x.nested': [{ command: 'x.gamma' }],
    },
    viewsWelcome: [
      { view: 'v', contents: 'one', when: 'k == 1' },
      { view: 'v', contents: 'always' },
      { view: 'w', contents: 'other view' },
      { view: 'v', contents: 'broken', when: '(' },
    ],
    views: { 'erd-studio': [{ id: 'v', name: 'V' }], other: [{ id: 'w', name: 'W' }] },
  };
  const synthetic = new ContributionIndex(contributes);

  it('navigation first, named groups by name, ungrouped last; @order then title within a group', () => {
    const t = synthetic.resolve('view/title', () => undefined);
    expect(titles(t.navigation)).toEqual(['Alpha', 'Beta']);
    expect(groupTitles(t.groups)).toEqual([['Gamma'], ['Epsilon', 'Delta'], ['Epsilon'], ['Zeta']]);
    expect(titles(t.inline)).toEqual(['Alpha']);
    expect(t.navigation.map((a) => a.index)).toEqual([4, 3]);
  });

  it('icons: $(id) and $(id~modifier) resolve, a light/dark path icon has no codicon', () => {
    const t = synthetic.resolve('view/title', () => undefined);
    expect(t.navigation.map((a) => a.icon)).toEqual(['add', 'sync']);
    expect(t.groups[0][0]).toEqual({ index: 5, menu: 'view/title', title: 'Gamma' });
  });

  it('a submenu resolves its groups in VS Code order, inline being just another group name', () => {
    const t = synthetic.resolve('view/title', (k) => (k === 'flag' ? true : undefined));
    const sub = t.navigation.find((a) => a.title === 'More') as MenuAction;
    expect(sub).toMatchObject({ index: 8, menu: 'view/title', icon: 'ellipsis' });
    expect(sub.submenu?.map((g) => g.map((a) => [a.menu, a.title, ...(a.submenu ? [groupTitles(a.submenu)] : [])]))).toEqual([
      [['x.sub', 'Alpha']],
      [['x.sub', 'Delta']],
      [['x.sub', 'Nested', [['Gamma']]]],
      [['x.sub', 'Beta']],
    ]);
    expect(synthetic.submenusOf('view/title', (k) => (k === 'flag' ? true : undefined))).toEqual(['x.sub', 'x.empty']);
    expect(synthetic.submenusOf('view/title', () => undefined)).toEqual(['x.empty']);
  });

  it('commandFor follows the same rules as resolve', () => {
    const all = new Set(['view/title', 'x.sub']);
    expect(synthetic.commandFor('view/title', 4, () => undefined, all)).toBe('x.alpha');
    expect(synthetic.commandFor('view/title', 7, () => undefined, all)).toBeUndefined(); // not contributed
    expect(synthetic.commandFor('view/title', 11, () => true, all)).toBeUndefined(); // unparseable when
    expect(synthetic.commandFor('x.sub', 2, () => undefined, all)).toBe('x.alpha');
    expect(synthetic.commandFor('x.sub', 2, () => undefined, new Set(['view/title']))).toBeUndefined();
  });

  it('welcome keeps manifest order, filters by view and fails a broken clause closed', () => {
    expect(synthetic.welcome('v', (k) => (k === 'k' ? 1 : undefined))).toEqual([
      { index: 0, contents: 'one' },
      { index: 1, contents: 'always' },
    ]);
    expect(synthetic.welcome('v', () => undefined)).toEqual([{ index: 1, contents: 'always' }]);
    expect(synthetic.welcome('nope', () => true)).toEqual([]);
  });

  it('views by container; unknown menus and prototype keys are empty', () => {
    expect(synthetic.views().map((v) => v.id)).toEqual(['v']);
    expect(synthetic.views('other').map((v) => v.id)).toEqual(['w']);
    expect(synthetic.menu('nope')).toEqual([]);
    expect(synthetic.menu('constructor')).toEqual([]);
    expect(synthetic.menu('__proto__')).toEqual([]);
    expect(new ContributionIndex({}).resolve('view/title', () => true)).toEqual({ inline: [], navigation: [], groups: [] });
  });

  it('the resolved menus are plain JSON', () => {
    const t = synthetic.resolve('view/title', () => true);
    expect(JSON.parse(JSON.stringify(t))).toEqual(t);
  });
});

describe('helpers', () => {
  it('parseGroup', () => {
    expect(parseGroup('navigation@2')).toEqual({ group: 'navigation', order: 2 });
    expect(parseGroup('1_new@1')).toEqual({ group: '1_new', order: 1 });
    expect(parseGroup('inline')).toEqual({ group: 'inline', order: 0 });
    expect(parseGroup('g@x')).toEqual({ group: 'g', order: 0 });
    expect(parseGroup(undefined)).toEqual({ group: '', order: 0 });
  });

  it('compareGroups sorts as VS Code does', () => {
    expect(['b', '', 'navigation', 'a', '9_x', 'inline'].sort(compareGroups)).toEqual(['navigation', '9_x', 'a', 'b', 'inline', '']);
  });

  it('codiconId', () => {
    expect(codiconId('$(add)')).toBe('add');
    expect(codiconId(' $(filter-filled) ')).toBe('filter-filled');
    expect(codiconId('$(sync~spin)')).toBe('sync');
    expect(codiconId('add')).toBeUndefined();
    expect(codiconId('$(bad id)')).toBeUndefined();
    expect(codiconId({ light: 'a', dark: 'b' })).toBeUndefined();
    expect(codiconId(undefined)).toBeUndefined();
  });

  it('withoutGlassClause takes out only the glass sidebar clause', () => {
    expect(withoutGlassClause(undefined)).toBeUndefined();
    expect(withoutGlassClause('!erdStudio.glassSidebar')).toBeUndefined();
    expect(withoutGlassClause('erdStudio.hasProject && !erdStudio.glassSidebar')).toBe('erdStudio.hasProject');
    expect(withoutGlassClause('!erdStudio.glassSidebar && erdStudio.hasProject')).toBe('erdStudio.hasProject');
    expect(withoutGlassClause('a && ! erdStudio.glassSidebar && b')).toBe('a && b');
    expect(withoutGlassClause('a && !erdStudio.glassSidebarX')).toBe('a && !erdStudio.glassSidebarX');
  });

  it('parseCommandLink accepts only ERD Studio commands and Open Folder, with JSON arguments', () => {
    expect(parseCommandLink('command:erdStudio.start')).toEqual({ command: 'erdStudio.start', args: [] });
    expect(parseCommandLink('command:erdStudio.start?%7B%22a%22%3A1%7D')).toEqual({ command: 'erdStudio.start', args: [{ a: 1 }] });
    expect(parseCommandLink('command:erdStudio.start?%5B1%2C2%5D')).toEqual({ command: 'erdStudio.start', args: [1, 2] });
    expect(parseCommandLink('command:erdStudio.start?not-json')).toBeUndefined();
    expect(parseCommandLink('command:workbench.action.terminal.new')).toBeUndefined();
    expect(parseCommandLink('https://example.com')).toBeUndefined();
    expect(isAllowedWelcomeCommand('erdStudio.x.y')).toBe(true);
    expect(isAllowedWelcomeCommand('erdStudio.')).toBe(false);
    expect(isAllowedWelcomeCommand('workbench.action.files.openFolder')).toBe(true);
  });

  it('parseWelcomeContents: paragraphs, inline links, single-link buttons', () => {
    const { paragraphs, links } = parseWelcomeContents('Hello\nthere [a](command:erdStudio.a) end.\n\n[B](command:erdStudio.b)\n\n  \n\nplain');
    expect(paragraphs).toEqual([
      { button: false, parts: [{ kind: 'text', text: 'Hello there ' }, { kind: 'link', label: 'a', link: 0 }, { kind: 'text', text: ' end.' }] },
      { button: true, parts: [{ kind: 'link', label: 'B', link: 1 }] },
      { button: false, parts: [{ kind: 'text', text: 'plain' }] },
    ]);
    expect(links).toEqual([{ label: 'a', href: 'command:erdStudio.a' }, { label: 'B', href: 'command:erdStudio.b' }]);
  });
});
