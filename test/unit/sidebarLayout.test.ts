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
    // Help starts collapsed: its header is always there, its rows out of the way.
    expect(views[3].visibility).toBe('collapsed');
  });

  it('give each view at most one title-bar icon; everything else is in the + menu or under …', () => {
    const titles = contributes.menus['view/title'];
    for (const view of contributes.views['erd-studio']) {
      const icons = titles.filter((m) => m.when?.startsWith(`view == ${view.id}`) && m.group?.startsWith('navigation'));
      expect(icons.length, view.id).toBeLessThanOrEqual(1);
    }
    expect(titles.filter((m) => m.when?.startsWith('view == erdStudio.domainTree') && m.group?.startsWith('navigation')))
      .toEqual([{ submenu: 'erdStudio.newMenu', when: 'view == erdStudio.domainTree && erdStudio.hasProject', group: 'navigation@0' }]);
  });

  it('put every way to start a diagram, and New Layer, in the + menu', () => {
    expect(contributes.submenus).toContainEqual({ id: 'erdStudio.newMenu', label: 'New…', icon: '$(add)' });
    expect(contributes.menus['erdStudio.newMenu'].map((m) => m.command)).toEqual([
      'erdStudio.createDomain', 'erdStudio.drawFromDbt', 'erdStudio.importDbml', 'erdStudio.addLayer',
    ]);
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
    // A relationship row's click already opens the diagram, so its icon is the other way in: the file.
    expect(entries('erdStudio.openInDiagram')).toEqual([
      // A Table Library table too: its click opens its file, so the diagram is the icon.
      ['inline', 'view == erdStudio.modelLibrary && viewItem == logicalModel'],
      ['navigation@0', 'view == erdStudio.modelLibrary && viewItem =~ /^logicalModel(Duplicate|ReadOnly)?$/'],
      ['inline', 'view == erdStudio.relationships && viewItem == relationshipsTable'],
      ['navigation@1', 'view == erdStudio.relationships && viewItem =~ /^(relationship|relationshipsTable)$/'],
    ]);
    expect(entries('erdStudio.openRelationshipSource')).toEqual([
      ['inline', 'view == erdStudio.relationships && viewItem == relationship'],
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
      'Set Up My AI Helper', 'Watch Getting Started Video', 'Send Feedback', 'Show Logs',
    ]);
    const contributed = new Set(contributes.commands.map((c) => c.command));
    for (const action of HELP_ACTIONS) expect(contributed.has(action.command), action.command).toBe(true);
    provider.dispose();
  });

  it('adds My Reports after Send Feedback once there is a report, with the open count', () => {
    const provider = new HelpTreeProvider(tracking([report(2), report(1, 'closed')]));
    const rows = provider.getChildren();
    expect(rows[3]).toEqual({ type: 'reports' });
    const item = provider.getTreeItem(rows[3]);
    expect([item.label, item.description, item.contextValue]).toEqual(['My Reports', '1 open', 'myReports']);
    expect(provider.getChildren(rows[3]).map((r) => provider.getTreeItem(r).label)).toEqual(['#2 Issue 2', '#1 Issue 1']);
    provider.dispose();
  });
});
