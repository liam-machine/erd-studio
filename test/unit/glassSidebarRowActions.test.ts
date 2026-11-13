/**
 * The glass sidebar's rows (rowActions.ts), against the real package.json:
 * every row kind in Diagrams, the Table Library and Relationships gets at
 * most one hover button (then `…`), and its menu in one verb order — open,
 * add / create, rename / move, export, other, delete last on its own — with
 * nothing lost and every action keeping its (menu, index).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContributionIndex, type MenuAction } from '../../src/providers/glassSidebar/contributions';
import { consistentRowActions, rowVerb, ROW_VERB_ORDER, type RowVerb } from '../../src/providers/glassSidebar/rowActions';

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
const index = new ContributionIndex(pkg.contributes);
const commandOf = (a: MenuAction) => (a.submenu ? undefined : index.menu(a.menu)[a.index]?.command);

const DIAGRAMS = 'erdStudio.domainTree';
const TABLES = 'erdStudio.modelLibrary';
const RELATIONSHIPS = 'erdStudio.relationships';
const HELP = 'erdStudio.help';

function rowOf(view: string, viewItem: string, extra: Record<string, unknown> = {}) {
  const ctx: Record<string, unknown> = {
    view,
    viewItem,
    'erdStudio.hasProject': true,
    'erdStudio.hasSemanticDir': true,
    'erdStudio.hasLogicalModelsDir': true,
    'erdStudio.storage': 'dbml',
    'erdStudio.glassSidebar': true,
    ...extra,
  };
  const raw = index.resolve('view/item/context', (key) => ctx[key]);
  return { raw, shaped: consistentRowActions(raw, commandOf) };
}
const titles = (actions: MenuAction[]) => actions.map((a) => a.title);
const shape = (view: string, viewItem: string, extra: Record<string, unknown> = {}) => {
  const { shaped } = rowOf(view, viewItem, extra);
  return { hover: titles(shaped.inline), menu: shaped.groups.map(titles) };
};

describe('consistentRowActions: Diagrams', () => {
  it('a layer that takes diagrams: + New Diagram…, then New / Edit / Remove', () => {
    expect(shape(DIAGRAMS, 'layerCreatable')).toEqual({
      hover: ['New Diagram…'],
      menu: [['New Diagram…'], ['Edit Layer'], ['Remove Layer']],
    });
  });

  it('any other layer: Edit, then Remove on its own', () => {
    expect(shape(DIAGRAMS, 'layer')).toEqual({ hover: [], menu: [['Edit Layer'], ['Remove Layer']] });
  });

  it('a diagram: Rename / Move, then Export, then Delete last (not Export first)', () => {
    expect(shape(DIAGRAMS, 'domain')).toEqual({
      hover: [],
      menu: [['Rename Diagram…', 'Move Diagram to Layer…'], ['Export Diagram…'], ['Delete Diagram']],
    });
    expect(shape(DIAGRAMS, 'domain', { 'erdStudio.storage': 'yaml' })).toEqual({
      hover: [],
      menu: [['Rename Diagram…'], ['Export Diagram…'], ['Delete Diagram']],
    });
  });

  it('the New… rows and the project rows only run their own click', () => {
    for (const cv of ['newDomain', 'newLayer', 'dbtProject', 'convertProject']) {
      expect(shape(DIAGRAMS, cv)).toEqual({ hover: [], menu: [] });
    }
  });
});

describe('consistentRowActions: Table Library', () => {
  it('a layer and a schema: + New Table…, and the menu is the create group', () => {
    expect(shape(TABLES, 'tableLibraryLayer')).toEqual({ hover: ['New Table…'], menu: [['New Table…', 'New Schema…']] });
    expect(shape(TABLES, 'tableLibrarySchema')).toEqual({ hover: ['New Table…'], menu: [['New Table…']] });
    expect(shape(TABLES, 'tableLibraryLayer', { 'erdStudio.storage': 'yaml' })).toEqual({ hover: [], menu: [] });
    expect(shape(TABLES, 'logicalModelFolder')).toEqual({ hover: [], menu: [] });
  });

  it('a table: one hover button, the + (Add to Open Diagram); Open in Diagram… leads the menu', () => {
    const { shaped } = rowOf(TABLES, 'logicalModel');
    expect(shaped.inline.map((a) => [a.title, a.icon])).toEqual([['Add to Open Diagram', 'add']]);
    expect(shaped.groups.map(titles)).toEqual([
      ['Open in Diagram…', 'Reveal in Explorer'],
      ['Add to Open Diagram', 'Add to Diagram…'],
      ['Move Table…'],
      ['Delete Table'],
    ]);
    expect(shape(TABLES, 'logicalModel', { 'erdStudio.storage': 'yaml' }).menu).toEqual([
      ['Open in Diagram…', 'Reveal in Explorer'],
      ['Add to Open Diagram', 'Add to Diagram…'],
      ['Delete Table'],
    ]);
  });

  it('a duplicate table: its fix as the hover button, after Open / Reveal in the menu', () => {
    expect(shape(TABLES, 'logicalModelDuplicate')).toEqual({
      hover: ['Give Duplicate Table Its Own Name…'],
      menu: [['Open in Diagram…', 'Reveal in Explorer'], ['Give Duplicate Table Its Own Name…']],
    });
  });

  it('a read-only table: Open in Diagram… only', () => {
    expect(shape(TABLES, 'logicalModelReadOnly')).toEqual({ hover: [], menu: [['Open in Diagram…']] });
  });
});

describe('consistentRowActions: Relationships', () => {
  it('a relationship: the open its click does not do as the button; both opens in the menu', () => {
    expect(shape(RELATIONSHIPS, 'relationship')).toEqual({ hover: ['Open in File'], menu: [['Open in Diagram…', 'Open in File']] });
    expect(shape(RELATIONSHIPS, 'relationship', { 'erdStudio.relationshipsGrouping': 'file' })).toEqual({
      hover: ['Open in Diagram…'],
      menu: [['Open in Diagram…', 'Open in File']],
    });
  });

  it('a table group: Open in Diagram…; layer, file and attention rows have none', () => {
    expect(shape(RELATIONSHIPS, 'relationshipsTable')).toEqual({ hover: ['Open in Diagram…'], menu: [['Open in Diagram…']] });
    for (const cv of ['relationshipsLayer', 'relationshipsFile', 'relationshipsAttention']) {
      expect(shape(RELATIONSHIPS, cv)).toEqual({ hover: [], menu: [] });
    }
  });
});

describe('consistentRowActions: Help', () => {
  it('My Reports: Refresh as the button, and in a menu now, so the keyboard reaches it too', () => {
    expect(shape(HELP, 'myReports')).toEqual({ hover: ['Refresh My Reports'], menu: [['Refresh My Reports']] });
  });
});

describe('consistentRowActions: the rules', () => {
  const ROWS: Array<[string, string, Record<string, unknown>?]> = [
    [DIAGRAMS, 'layerCreatable'], [DIAGRAMS, 'layer'], [DIAGRAMS, 'domain'], [DIAGRAMS, 'domain', { 'erdStudio.storage': 'yaml' }],
    [TABLES, 'tableLibraryLayer'], [TABLES, 'tableLibrarySchema'], [TABLES, 'logicalModel'], [TABLES, 'logicalModel', { 'erdStudio.storage': 'yaml' }],
    [TABLES, 'logicalModelDuplicate'], [TABLES, 'logicalModelReadOnly'],
    [RELATIONSHIPS, 'relationship'], [RELATIONSHIPS, 'relationship', { 'erdStudio.relationshipsGrouping': 'file' }], [RELATIONSHIPS, 'relationshipsTable'],
    [HELP, 'myReports'],
  ];
  const verb = (a: MenuAction) => rowVerb(commandOf(a), a.title);

  it('loses no command: every inline and menu entry of a row is still in its menu, each once', () => {
    for (const [view, cv, extra] of ROWS) {
      const { raw, shaped } = rowOf(view, cv, extra);
      const before = new Set([...raw.inline, ...raw.navigation, ...raw.groups.flat()].map(commandOf));
      const after = shaped.groups.flat().map(commandOf);
      expect(new Set(after), `${view} ${cv}`).toEqual(before);
      expect(after.length, `${view} ${cv}: no command twice`).toBe(new Set(after).size);
    }
  });

  it('at most one hover button, never a delete, and it is one of the row\'s own inline entries', () => {
    for (const [view, cv, extra] of ROWS) {
      const { raw, shaped } = rowOf(view, cv, extra);
      expect(shaped.inline.length).toBeLessThanOrEqual(1);
      for (const a of shaped.inline) {
        expect(raw.inline).toContain(a);
        expect(verb(a)).not.toBe('delete');
      }
    }
  });

  it('one group per verb, in the one order, with delete always last', () => {
    for (const [view, cv, extra] of ROWS) {
      const { shaped } = rowOf(view, cv, extra);
      const verbs = shaped.groups.map((g) => {
        const vs = new Set(g.map(verb));
        expect(vs.size, `${view} ${cv}: one verb per group`).toBe(1);
        return [...vs][0];
      });
      const order = verbs.map((v) => ROW_VERB_ORDER.indexOf(v));
      expect(order, `${view} ${cv}`).toEqual([...order].sort((a, b) => a - b));
      expect(new Set(verbs).size).toBe(verbs.length);
    }
  });

  it('every action keeps the (menu, index) it was resolved from, so the host re-checks it', () => {
    for (const [view, cv, extra] of ROWS) {
      const { raw, shaped } = rowOf(view, cv, extra);
      const offered = new Set([...raw.inline, ...raw.navigation, ...raw.groups.flat()]);
      for (const a of [...shaped.inline, ...shaped.groups.flat()]) {
        expect(offered.has(a)).toBe(true);
        expect(a.menu).toBe('view/item/context');
      }
    }
  });

  it('every row command package.json contributes has a verb of its own (a new one must pick a place)', () => {
    const rowCommands = new Set<string>(
      (pkg.contributes.menus['view/item/context'] as Array<{ command?: string; when?: string }>)
        .filter((e) => e.command && /view == erdStudio\.(domainTree|modelLibrary|relationships)\b/.test(e.when ?? ''))
        .map((e) => e.command as string),
    );
    const unplaced = [...rowCommands].filter((c) => rowVerb(c, '') === 'other');
    expect(unplaced).toEqual([]);
  });

  it('a command it does not know is placed by its title, else under other, before delete', () => {
    const a = (index: number, title: string): MenuAction => ({ index, menu: 'm', title });
    const known: Record<number, string> = {};
    const result = consistentRowActions(
      { inline: [a(9, 'Sparkle'), a(8, 'Remove Thing')], navigation: [a(1, 'Remove Thing'), a(2, 'Open Thing')], groups: [[a(3, 'Copy Name'), a(4, 'Sparkle')]] },
      (x) => known[x.index] ?? `x.${x.title}`,
    );
    expect(result.inline.map((x) => x.title)).toEqual(['Sparkle']);
    expect(result.groups.map(titles)).toEqual([['Open Thing'], ['Copy Name'], ['Sparkle'], ['Remove Thing']]);
    const verbs: RowVerb[] = result.groups.map((g) => rowVerb(undefined, g[0].title));
    expect(verbs).toEqual(['open', 'export', 'other', 'delete']);
  });
});
