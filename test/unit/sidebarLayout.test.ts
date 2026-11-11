/**
 * The ERD Studio sidebar's shape: four views (Diagrams, Table Library,
 * Relationships, Help & Feedback), title bars that stay uncluttered (one +
 * menu for everything you can create, the rest under …), and the Help &
 * Feedback rows.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { HelpTreeProvider, HELP_ACTIONS } from '../../src/providers/HelpTreeProvider';
import type { ReportTrackingService } from '../../src/services/reportTrackingService';
import type { TrackedReport } from '../../src/types/feedback';

type MenuEntry = { command?: string; submenu?: string; when?: string; group?: string };
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
  contributes: {
    commands: Array<{ command: string; title: string; icon?: string }>;
    submenus: Array<{ id: string; label: string; icon?: string }>;
    views: Record<string, Array<{ id: string; name: string; when?: string; visibility?: string }>>;
    viewsWelcome: Array<{ view: string; contents: string; when?: string }>;
    menus: Record<string, MenuEntry[]>;
  };
};
const { contributes } = pkg;

describe('sidebar views', () => {
  it('are Diagrams, Table Library, Relationships and Help & Feedback, in that order', () => {
    expect(contributes.views['erd-studio'].map((v) => [v.id, v.name])).toEqual([
      ['erdStudio.domainTree', 'Diagrams'],
      ['erdStudio.modelLibrary', 'Table Library'],
      ['erdStudio.relationships', 'Relationships'],
      ['erdStudio.help', 'Help & Feedback'],
    ]);
    // Relationships live in the table library, so the view shows with it.
    const views = contributes.views['erd-studio'];
    expect(views[2].when).toBe(views[1].when);
    // Relationships starts collapsed too: a long list under the Table Library until asked for.
    expect(views[2].visibility).toBe('collapsed');
    // Help starts collapsed: its header is always there, its rows out of the way.
    expect(views[3].visibility).toBe('collapsed');
  });

  it('give each view at most one title-bar icon (plus the filter toggle); everything else is in the + menu or under …', () => {
    // The filter is a toggle of its own: Filter…, or (while filtered) Clear Filter — see the next test.
    const isFilter = (m: MenuEntry): boolean => /^erdStudio\.(filter|clear)\w*(Diagrams|TableLibrary|Relationships)(Filter)?$/.test(m.command ?? '');
    // An empty window's own title bar (no + menu there): its one icon is ▶, the Welcome tab (checked below).
    const emptyWindowOnly = (m: MenuEntry): boolean => (m.when ?? '').includes('!erdStudio.hasProject');
    const titles = contributes.menus['view/title'].filter((m) => !isFilter(m) && !emptyWindowOnly(m));
    for (const view of contributes.views['erd-studio']) {
      // A toggle is one icon: only one of its two states shows at a time.
      const icons = titles.filter((m) => m.when?.startsWith(`view == ${view.id}`) && m.group?.startsWith('navigation')
        && !m.when.includes('erdStudio.relationshipsGrouping == file'));
      expect(icons.length, view.id).toBeLessThanOrEqual(1);
    }
    // The Relationships view's toggle: Group by Relationships File, or (while grouped so) Group by Table.
    expect(titles.filter((m) => m.when?.startsWith('view == erdStudio.relationships'))).toEqual([
      { command: 'erdStudio.groupRelationshipsByFile', when: 'view == erdStudio.relationships && erdStudio.relationshipsGrouping != file', group: 'navigation@1' },
      { command: 'erdStudio.groupRelationshipsByTable', when: 'view == erdStudio.relationships && erdStudio.relationshipsGrouping == file', group: 'navigation@1' },
    ]);
    expect(titles.filter((m) => m.when?.startsWith('view == erdStudio.domainTree') && m.group?.startsWith('navigation')))
      .toEqual([{ submenu: 'erdStudio.newMenu', when: 'view == erdStudio.domainTree && erdStudio.hasProject', group: 'navigation@0' }]);
    // With no folder open, the + menu is gone and the one icon is ▶ (Watch the Tour): the
    // Welcome tab one click away (onboarding story 09). In a project, Help & Feedback has that row.
    expect(contributes.menus['view/title'].filter(emptyWindowOnly)).toEqual([
      { command: 'erdStudio.showGettingStarted', when: 'view == erdStudio.domainTree && !erdStudio.hasProject', group: 'navigation@0' },
    ]);
  });

  it('give Diagrams, the Table Library and Relationships one filter icon: Filter…, or Clear Filter while filtered (Filter… then under …)', () => {
    const titles = contributes.menus['view/title'];
    for (const [view, name, key] of [
      ['erdStudio.domainTree', 'Diagrams', 'erdStudio.diagramsFiltered'],
      ['erdStudio.modelLibrary', 'TableLibrary', 'erdStudio.tableLibraryFiltered'],
      ['erdStudio.relationships', 'Relationships', 'erdStudio.relationshipsFiltered'],
    ] as const) {
      const filter = `erdStudio.filter${name}`;
      const clear = `erdStudio.clear${name}Filter`;
      expect(contributes.commands.find((c) => c.command === filter)?.icon, filter).toBe('$(filter)');
      expect(contributes.commands.find((c) => c.command === clear)?.icon, clear).toBe('$(filter-filled)');
      const entries = titles.filter((m) => m.command === filter || m.command === clear);
      const icons = entries.filter((m) => m.group?.startsWith('navigation'));
      // One slot, two states.
      expect(icons).toHaveLength(2);
      expect(new Set(icons.map((m) => m.group)).size).toBe(1);
      expect(icons.find((m) => m.command === filter)?.when).toMatch(new RegExp(`^view == ${view}( && erdStudio\\.hasProject)? && !${key}$`));
      expect(icons.find((m) => m.command === clear)?.when).toBe(`view == ${view} && ${key}`);
      expect(entries.find((m) => !m.group?.startsWith('navigation'))).toEqual({ command: filter, when: `view == ${view} && ${key}`, group: '0_filter@0' });
    }
  });

  it('put every way to start a diagram, and New Layer, in the + menu', () => {
    expect(contributes.submenus).toContainEqual({ id: 'erdStudio.newMenu', label: 'New…', icon: '$(add)' });
    expect(contributes.menus['erdStudio.newMenu'].map((m) => m.command)).toEqual([
      'erdStudio.createDomain', 'erdStudio.drawFromDbt', 'erdStudio.importDbml', 'erdStudio.importSqlDdl', 'erdStudio.importSemanticModel', 'erdStudio.showImportGuide', 'erdStudio.addLayer',
    ]);
    // The guide to every source sits in a group of its own under the imports, so a project that already has diagrams
    // (no welcome view, no start screen) still has a visible way to it besides the Command Palette.
    expect(contributes.menus['erdStudio.newMenu'].find((m) => m.command === 'erdStudio.showImportGuide'))
      .toEqual({ command: 'erdStudio.showImportGuide', when: 'erdStudio.hasProject', group: '1_import_guide@1' });
    // The imports sit together, after Import DBML…, in the diagram group.
    expect(contributes.menus['erdStudio.newMenu'].filter((m) => m.command?.startsWith('erdStudio.import')).map((m) => m.group))
      .toEqual(['1_diagram@3', '1_diagram@4', '1_diagram@5']);
    expect(contributes.commands.find((c) => c.command === 'erdStudio.addLayer')?.title).toBe('New Layer…');
  });

  it('offer New Diagram on a layer row that takes new diagrams (inline + and right-click)', () => {
    const onLayer = contributes.menus['view/item/context'].filter((m) => m.command === 'erdStudio.createDomain');
    expect(onLayer.map((m) => m.group)).toEqual(['inline', '1_new@1']);
    for (const m of onLayer) expect(m.when).toBe('view == erdStudio.domainTree && viewItem == layerCreatable');
    // Edit and Remove work on any layer row.
    for (const id of ['erdStudio.editLayer', 'erdStudio.removeLayer']) {
      expect(contributes.menus['view/item/context'].find((m) => m.command === id)?.when).toBe('view == erdStudio.domainTree && viewItem =~ /^layer/');
    }
  });

  it('offer Open in Diagram and Open in File on Relationships rows, never in the palette', () => {
    const items = contributes.menus['view/item/context'];
    const entries = (command: string) => items.filter((m) => m.command === command).map((m) => [m.group, m.when]);
    // A relationship row's click follows the grouping (by file: the file; by table: a diagram),
    // so its icon is always the other way in.
    expect(entries('erdStudio.openInDiagram')).toEqual([
      // A Table Library table too: its click opens its file, so the diagram is the icon.
      ['inline', 'view == erdStudio.modelLibrary && viewItem == logicalModel'],
      ['navigation@0', 'view == erdStudio.modelLibrary && viewItem =~ /^logicalModel(Duplicate|ReadOnly)?$/'],
      ['inline', 'view == erdStudio.relationships && viewItem == relationshipsTable'],
      ['inline', 'view == erdStudio.relationships && viewItem == relationship && erdStudio.relationshipsGrouping == file'],
      ['navigation@1', 'view == erdStudio.relationships && viewItem =~ /^(relationship|relationshipsTable)$/'],
    ]);
    expect(entries('erdStudio.openRelationshipSource')).toEqual([
      ['inline', 'view == erdStudio.relationships && viewItem == relationship && erdStudio.relationshipsGrouping != file'],
      ['navigation@2', 'view == erdStudio.relationships && viewItem == relationship'],
    ]);
    for (const command of ['erdStudio.openInDiagram', 'erdStudio.openRelationshipSource']) {
      expect(contributes.menus.commandPalette).toContainEqual({ command, when: 'false' });
    }
  });

  it('end the Diagrams tree with labelled New Diagram… and New Layer… rows (see domainTreeProvider.test.ts)', () => {
    const title = (id: string) => contributes.commands.find((c) => c.command === id)?.title;
    expect([title('erdStudio.createDomain'), title('erdStudio.addLayer')]).toEqual(['New Diagram…', 'New Layer…']);
  });

  it('have an empty-state text for Relationships that says how to add one', () => {
    const welcome = contributes.viewsWelcome.filter((w) => w.view === 'erdStudio.relationships');
    expect(welcome).toHaveLength(1);
    expect(welcome[0].contents).toMatch(/^No relationships yet\./);
    expect(welcome[0].contents).toContain('New Relationship');
  });
});

describe('HelpTreeProvider', () => {
  const report = (n: number, state: 'open' | 'closed' = 'open'): TrackedReport => ({
    number: n, title: `Issue ${n}`, url: `https://github.com/liam-machine/erd-studio/issues/${n}`,
    kind: 'bug', state, comments: 0, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  });
  const tracking = (reports: TrackedReport[]) => ({
    getReports: () => reports,
    onDidChangeReports: () => ({ dispose: () => undefined }),
  }) as unknown as ReportTrackingService;

  it('lists labelled rows, each running a contributed command', () => {
    const provider = new HelpTreeProvider(tracking([]));
    const rows = provider.getChildren();
    expect(rows.map((r) => provider.getTreeItem(r).label)).toEqual([
      'Set Up My AI Helper', 'Watch the Tour', 'Show Me Around', 'Send Feedback', 'Show Logs',
    ]);
    const contributed = new Set(contributes.commands.map((c) => c.command));
    for (const action of HELP_ACTIONS) expect(contributed.has(action.command), action.command).toBe(true);
    provider.dispose();
  });

  it('adds My Reports after Send Feedback once there is a report, with the open count', () => {
    const provider = new HelpTreeProvider(tracking([report(2), report(1, 'closed')]));
    const rows = provider.getChildren();
    expect(rows[4]).toEqual({ type: 'reports' });
    const item = provider.getTreeItem(rows[4]);
    expect([item.label, item.description, item.contextValue]).toEqual(['My Reports', '1 open', 'myReports']);
    expect(provider.getChildren(rows[4]).map((r) => provider.getTreeItem(r).label)).toEqual(['#2 Issue 2', '#1 Issue 1']);
    provider.dispose();
  });
});
