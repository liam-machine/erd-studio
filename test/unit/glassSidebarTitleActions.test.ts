/**
 * The glass sidebar's section headers (titleActions.ts): every section shows
 * at most `+` then `…`, the per-view finders are left out (one search field
 * covers them) and nothing else is lost.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContributionIndex, type MenuAction } from '../../src/providers/glassSidebar/contributions';
import { consistentTitleActions } from '../../src/providers/glassSidebar/titleActions';

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
const index = new ContributionIndex(pkg.contributes);
const commandOf = (a: MenuAction) => (a.submenu ? undefined : index.menu(a.menu)[a.index]?.command);

function header(view: string, extra: Record<string, unknown> = {}) {
  const ctx: Record<string, unknown> = {
    view,
    'erdStudio.hasProject': true,
    'erdStudio.hasSemanticDir': true,
    'erdStudio.hasLogicalModelsDir': true,
    'erdStudio.storage': 'dbml',
    'erdStudio.glassSidebar': true,
    ...extra,
  };
  const raw = index.resolve('view/title', (key) => ctx[key]);
  return { raw, shaped: consistentTitleActions(raw, commandOf) };
}
const commands = (actions: MenuAction[]) => actions.map(commandOf);
const flat = (t: { navigation: MenuAction[]; groups: MenuAction[][] }) => [
  ...t.navigation.flatMap((a) => (a.submenu ? a.submenu.flat() : [a])),
  ...t.groups.flat(),
];

describe('consistentTitleActions', () => {
  it('Diagrams: the New… menu, then …, with no filter button', () => {
    const { shaped } = header('erdStudio.domainTree');
    expect(shaped.navigation.map((a) => a.title)).toEqual(['New…']);
    expect(commands(flat(shaped))).not.toContain('erdStudio.filterDiagrams');
    expect(shaped.groups.length).toBeGreaterThan(0);
  });

  it('Table Library: New Table… and New Schema… become its +, and Go to Table / Filter are gone', () => {
    const { shaped } = header('erdStudio.modelLibrary');
    expect(shaped.navigation).toHaveLength(1);
    expect(shaped.navigation[0]).toMatchObject({ title: 'New…', icon: 'add' });
    expect(commands(shaped.navigation[0].submenu!.flat())).toEqual(['erdStudio.newTable', 'erdStudio.newSchema']);
    const all = commands(flat(shaped));
    expect(all).not.toContain('erdStudio.goToTable');
    expect(all).not.toContain('erdStudio.filterTableLibrary');
    // No longer repeated under ….
    expect(commands(shaped.groups.flat())).not.toContain('erdStudio.newTable');
  });

  it('Relationships: no icons, the grouping toggle leads the … menu', () => {
    const { shaped } = header('erdStudio.relationships');
    expect(shaped.navigation).toEqual([]);
    expect(commands(shaped.groups[0])).toEqual(['erdStudio.groupRelationshipsByFile']);
  });

  it('keeps Clear Filter as an icon while a filter is in force', () => {
    const { shaped } = header('erdStudio.relationships', { 'erdStudio.relationshipsFiltered': true });
    expect(commands(shaped.navigation)).toEqual(['erdStudio.clearRelationshipsFilter']);
    expect(commands(flat(shaped))).not.toContain('erdStudio.filterRelationships');
  });

  it('loses nothing but the finders, and every action keeps its (menu, index)', () => {
    for (const view of ['erdStudio.domainTree', 'erdStudio.modelLibrary', 'erdStudio.relationships', 'erdStudio.help']) {
      const { raw, shaped } = header(view);
      const hidden = /^erdStudio\.(goToTable|filter(Diagrams|TableLibrary|Relationships))$/;
      const key = (a: MenuAction) => `${a.menu}#${a.index}`;
      const before = flat(raw).filter((a) => !hidden.test(commandOf(a) ?? '')).map(key).sort();
      expect(flat(shaped).map(key).sort()).toEqual(before);
    }
  });
});
