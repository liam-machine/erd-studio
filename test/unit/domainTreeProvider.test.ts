import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TreeItemCollapsibleState } from 'vscode';
import { SubjectAreaTreeProvider, type TreeElement } from '../../src/providers/DomainTreeProvider';
import { dbmlFileIcon, type DbmlFileKind } from '../../src/providers/dbmlFileKinds';
import type { SubjectAreaService } from '../../src/services/domainService';
import { LayersFileUnreadableError, type LayerService } from '../../src/services/layerService';
import type { LayerConfig } from '../../src/types/layer';
import type { SubjectAreaSummary, UnifiedSubjectArea, StageData } from '../../src/types/semantic';

/**
 * The tests here check the full rows (`erdStudio.sidebar.rowDetails: full`,
 * today's text); the compact rows have tests of their own.
 */
function fullRows<T extends { setRowDetails(mode: 'compact' | 'full'): void }>(provider: T): T {
  provider.setRowDetails('full');
  return provider;
}

// Must be at module level for vitest to hoist correctly
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (typeof p === 'string' && p.includes('test-project') && p.includes('.erd-studio')) return true;
      return actual.existsSync(p as any);
    }),
  };
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockLayerService(): LayerService {
  const layers: LayerConfig[] = [
    { id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: false, order: 0 },
    { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 1 },
    { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 2 },
  ];
  return {
    getAllLayers: () => layers,
    getLayer: (id: string) => layers.find(l => l.id === id),
    hasLayer: (id: string) => layers.some(l => l.id === id),
    getValidLayerIds: () => layers.map(l => l.id),
    getCreatableLayers: () => layers.filter(l => l.creatable),
    getLabel: (id: string) => layers.find(l => l.id === id)?.label ?? id,
    getAbbreviation: (id: string) => layers.find(l => l.id === id)?.abbreviation ?? id.substring(0, 3).toUpperCase(),
    getColor: (id: string) => layers.find(l => l.id === id)?.color ?? '#808080',
    isCreatable: (id: string) => layers.find(l => l.id === id)?.creatable ?? false,
    getConfigPath: () => path.join(PROJECT_PATH, '.erd-studio', 'layers.json'),
  } as LayerService;
}

const emptyStageData: StageData = { models: [], relationships: [] };

function makeUnifiedSubjectArea(overrides: Partial<UnifiedSubjectArea> = {}): UnifiedSubjectArea {
  return {
    schemaVersion: 4,
    domain: 'test',
    layer: 'silver',
    description: '',
    logical: { ...emptyStageData },
    viewConfig: { positions: {} },
    ...overrides,
  };
}

function createMockSubjectAreaService(
  summaries: SubjectAreaSummary[] = [],
  domains: Map<string, UnifiedSubjectArea> = new Map(),
): SubjectAreaService {
  const getSubjectArea = vi.fn((filePath: string) => {
    const d = domains.get(filePath);
    if (!d) throw new Error(`Not found: ${filePath}`);
    return d;
  });
  return {
    listSubjectAreas: vi.fn().mockReturnValue(summaries),
    getSubjectArea,
    // The tree counts from the diagram file alone; the mock counts what getSubjectArea would resolve.
    countSubjectAreaTables: vi.fn((filePath: string) => getSubjectArea(filePath).logical.models.length),
  } as unknown as SubjectAreaService;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SILVER_SUBJECT_AREAS: SubjectAreaSummary[] = [
  { domain: 'customer-360', layer: 'silver', filePath: '/project/.erd-studio/silver/customer-360.json' },
  { domain: 'orders', layer: 'silver', filePath: '/project/.erd-studio/silver/orders.json' },
];

const GOLD_SUBJECT_AREAS: SubjectAreaSummary[] = [
  { domain: 'reporting', layer: 'gold', filePath: '/project/.erd-studio/gold/reporting.json' },
];

const ALL_SUMMARIES = [...SILVER_SUBJECT_AREAS, ...GOLD_SUBJECT_AREAS];

function buildSubjectAreaMap(): Map<string, UnifiedSubjectArea> {
  const map = new Map<string, UnifiedSubjectArea>();
  map.set('/project/.erd-studio/silver/customer-360.json', makeUnifiedSubjectArea({
    domain: 'customer-360',
    layer: 'silver',
    logical: {
      models: [{ name: 'dim_customer' }, { name: 'fct_orders' }] as any,
      relationships: [],
    },
  }));
  map.set('/project/.erd-studio/silver/orders.json', makeUnifiedSubjectArea({
    domain: 'orders',
    layer: 'silver',
    logical: {
      models: [{ name: 'fct_order_lines' }] as any,
      relationships: [],
    },
  }));
  map.set('/project/.erd-studio/gold/reporting.json', makeUnifiedSubjectArea({
    domain: 'reporting',
    layer: 'gold',
    logical: {
      models: [] as any,
      relationships: [],
    },
  }));
  return map;
}

// Use a real project path that exists on disk for the semantic dir check.
// We mock SubjectAreaService so no real files are read, but getChildren checks
// fs.existsSync for the semantic directory.
const PROJECT_PATH = '/tmp/test-project';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubjectAreaTreeProvider', () => {
  let layerService: LayerService;
  let subjectAreaService: SubjectAreaService;
  let provider: SubjectAreaTreeProvider;

  beforeEach(() => {
    layerService = createMockLayerService();
    subjectAreaService = createMockSubjectAreaService(ALL_SUMMARIES, buildSubjectAreaMap());
    provider = fullRows(new SubjectAreaTreeProvider(subjectAreaService, layerService, PROJECT_PATH));
  });

  describe('getChildren (root)', () => {
    it('returns the three layer nodes at root (no stage header), then New Layer…', () => {
      const children = provider.getChildren(undefined);

      expect(children).toEqual([
        { type: 'layer', layer: 'bronze', diagramCount: 0 },
        { type: 'layer', layer: 'silver', diagramCount: 2 },
        { type: 'layer', layer: 'gold', diagramCount: 1 },
        { type: 'newLayer' },
      ]);
      // Each layer row says it is a layer, and how many diagrams it holds.
      const silver = provider.getTreeItem(children![1]);
      expect(silver.label).toBe('Silver');
      expect(silver.description).toBe('Layer · 2 diagrams');
      expect(silver.id).toBe('erdStudio.diagrams.layer:silver');
      expect((silver.tooltip as vscode.MarkdownString).value).toContain('**Silver** — a layer');
      expect((silver.tooltip as vscode.MarkdownString).value).toContain('`.erd-studio/silver/`');
      expect(provider.getTreeItem(children![0]).description).toBe('Layer · no diagrams');
      const item = provider.getTreeItem({ type: 'newLayer' });
      expect([item.label, item.contextValue, (item.iconPath as { id: string }).id]).toEqual(['New Layer…', 'newLayer', 'new-folder']);
      expect(item.command).toEqual({ command: 'erdStudio.addLayer', title: 'New Layer…' });
    });

    it('returns empty array when semantic directory does not exist (F408 welcome)', () => {
      const providerNoSemantic = fullRows(new SubjectAreaTreeProvider(subjectAreaService, layerService, '/nonexistent/path'));
      const children = providerNoSemantic.getChildren(undefined);

      expect(children).toHaveLength(0);
      expect(children).toEqual([]);
    });

    it('stays empty while no layer holds a diagram, so the welcome view\'s start buttons show (and loading clears)', () => {
      const loading: boolean[] = [];
      const empty = fullRows(new SubjectAreaTreeProvider(createMockSubjectAreaService([], new Map()), layerService, PROJECT_PATH, undefined, (l) => loading.push(l)));
      expect(empty.getChildren(undefined)).toEqual([]);
      expect(loading).toEqual([false]);
      // A project row (several projects to switch between) is still shown alone, as with no layers.
      empty.setProjectRow({ name: 'jaffle', location: 'here' });
      expect(empty.getChildren(undefined)).toEqual([{ type: 'project', name: 'jaffle', location: 'here' }]);
      // The first diagram brings the layers back, empty ones included.
      expect(provider.getChildren(undefined)).toHaveLength(4);
    });
  });

  describe('Convert to DBML… row (a project from before 2.0, onboarding story 08)', () => {
    it('leads the layers while the rule says so, and runs the start screen\'s Convert from the sidebar', () => {
      let shows = true;
      provider.setConvertRow(() => shows);
      const children = provider.getChildren(undefined)!;
      expect(children.map((c) => c.type)).toEqual(['convert', 'layer', 'layer', 'layer', 'newLayer']);
      const item = provider.getTreeItem(children[0]);
      expect([item.label, item.description, item.contextValue, (item.iconPath as { id: string }).id])
        .toEqual(['Convert to DBML…', 'from an older ERD Studio', 'convertProject', 'arrow-swap']);
      expect(String(item.tooltip)).toContain('DBML, an open format');
      expect(item.command).toEqual({ command: 'erdStudio.start', title: 'Convert to DBML…', arguments: [{ action: 'convert', from: 'sidebar' }] });
      // Converted, declined or turned off: gone on the next listing.
      shows = false;
      expect(provider.getChildren(undefined)!.map((c) => c.type)).toEqual(['layer', 'layer', 'layer', 'newLayer']);
    });

    it('is not a row of an empty tree (the welcome view\'s Convert entry shows there), and a failing rule hides it', () => {
      const empty = fullRows(new SubjectAreaTreeProvider(createMockSubjectAreaService([], new Map()), layerService, PROJECT_PATH));
      empty.setConvertRow(() => true);
      expect(empty.getChildren(undefined)).toEqual([]);
      provider.setConvertRow(() => { throw new Error('boom'); });
      expect(provider.getChildren(undefined)!.map((c) => c.type)).not.toContain('convert');
    });

    it('comes after the project row', () => {
      provider.setConvertRow(() => true);
      provider.setProjectRow({ name: 'jaffle', location: 'here' });
      expect(provider.getChildren(undefined)!.slice(0, 2).map((c) => c.type)).toEqual(['project', 'convert']);
    });
  });

  describe('project row (#82)', () => {
    it('leads the tree with a clickable project row when there is more than one project', () => {
      const fired = vi.fn();
      provider.onDidChangeTreeData(fired);
      provider.setProjectRow({ name: 'datamodels', location: 'workspace folder' });

      const children = provider.getChildren(undefined)!;
      expect(children[0]).toEqual({ type: 'project', name: 'datamodels', location: 'workspace folder' });
      expect(children.slice(1).map((c) => c.type)).toEqual(['layer', 'layer', 'layer', 'newLayer']);
      expect(fired).toHaveBeenCalled();

      const item = provider.getTreeItem(children[0]);
      expect(item.label).toBe('datamodels');
      expect(item.description).toBe('dbt project · Switch…');
      expect(item.contextValue).toBe('dbtProject');
      expect(item.command).toMatchObject({ command: 'erdStudio.selectDbtProject' });
    });

    it('is removed again with undefined', () => {
      provider.setProjectRow({ name: 'datamodels', location: 'workspace folder' });
      provider.setProjectRow(undefined);
      expect(provider.getChildren(undefined)!.some((c) => c.type === 'project')).toBe(false);
    });

    it('never makes an empty tree non-empty, so the welcome view still shows', () => {
      const providerNoSemantic = fullRows(new SubjectAreaTreeProvider(subjectAreaService, layerService, '/nonexistent/path'));
      providerNoSemantic.setProjectRow({ name: 'finance-dbt', location: 'workspace folder' });
      expect(providerNoSemantic.getChildren(undefined)).toEqual([]);
    });
  });

  describe('getChildren (layer)', () => {
    it('returns domain nodes for silver layer', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'silver' })!;

      // 2 silver domains, then New Diagram… (silver is creatable)
      expect(children.map((c) => c.type)).toEqual(['domain', 'domain', 'newDomain']);
    });

    it('returns domain nodes for gold layer', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'gold' })!;

      // 1 gold domain, then New Diagram…
      expect(children.map((c) => c.type)).toEqual(['domain', 'newDomain']);
    });

    it('returns empty array for bronze (no domains, not creatable)', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'bronze' })!;

      expect(children).toHaveLength(0);
    });

    it('returns correct logical model counts', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'silver' })!;
      const customer = children.find(c => c.type === 'domain' && c.summary.domain === 'customer-360');

      expect(customer).toBeDefined();
      if (customer?.type === 'domain') {
        expect(customer.modelCount).toBe(2);
      }
    });

    it('ends every creatable layer with a New Diagram… row, saying so when the layer has none yet', () => {
      expect(provider.getChildren({ type: 'layer', layer: 'silver' })!.at(-1)).toEqual({ type: 'newDomain', layer: 'silver', first: false });
      expect(provider.getTreeItem({ type: 'newDomain', layer: 'silver', first: false }).description).toBeUndefined();
      layerService.isCreatable = () => true;
      expect(provider.getChildren({ type: 'layer', layer: 'bronze' })).toEqual([{ type: 'newDomain', layer: 'bronze', first: true }]);
    });

    it('hides New Domain node for non-creatable layers', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'bronze' })!;
      const hasNewDomain = children.some(c => c.type === 'newDomain');

      expect(hasNewDomain).toBe(false);
    });

    it('handles getSubjectArea errors gracefully with 0 model count', () => {
      const failService = createMockSubjectAreaService(
        [{ domain: 'broken', layer: 'silver', filePath: '/broken.json' }],
        new Map(), // empty — getSubjectArea will throw
      );
      const failProvider = fullRows(new SubjectAreaTreeProvider(failService, layerService, PROJECT_PATH));
      const children = failProvider.getChildren({ type: 'layer', layer: 'silver' })!;

      const domain = children.find(c => c.type === 'domain');
      expect(domain).toBeDefined();
      if (domain?.type === 'domain') {
        expect(domain.modelCount).toBe(0);
      }
    });
  });

  describe('getChildren (leaf)', () => {
    it('returns undefined for domain nodes', () => {
      const children = provider.getChildren({
        type: 'domain',
        summary: { domain: 'test', layer: 'silver', filePath: '/test.json' },
        modelCount: 0,
      });
      expect(children).toBeUndefined();
    });

    it('returns undefined for newDomain nodes', () => {
      const children = provider.getChildren({ type: 'newDomain', layer: 'silver', first: false });
      expect(children).toBeUndefined();
    });
  });

  describe('getTreeItem', () => {
    it('creates layer item with folder icon and expanded state', () => {
      const item = provider.getTreeItem({ type: 'layer', layer: 'silver' });

      expect(item.label).toBe('Silver');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
      // Creatable: the row offers New Diagram (inline + and right-click).
      expect(item.contextValue).toBe('layerCreatable');
      expect(provider.getTreeItem({ type: 'layer', layer: 'bronze' }).contextValue).toBe('layer');
    });

    it('creates domain item with its table count', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'orders', layer: 'silver', filePath: '/test.json' },
        modelCount: 12,
      };
      const item = provider.getTreeItem(element);

      expect(item.label).toBe('orders');
      expect(item.description).toBe('12 tables');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect(item.contextValue).toBe('domain');
    });

    it('shows the table count alone', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'finance', layer: 'gold', filePath: '/test.json' },
        modelCount: 5,
      };
      const item = provider.getTreeItem(element);

      expect(item.description).toBe('5 tables');
    });

    it('uses singular "table" when count is 1', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'test', layer: 'gold', filePath: '/test.json' },
        modelCount: 1,
      };
      const item = provider.getTreeItem(element);

      expect(item.description).toBe('1 table');
    });

    it('sets openDomain command on domain items with only filePath', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'test', layer: 'silver', filePath: '/path/to/test.json' },
        modelCount: 0,
      };
      const item = provider.getTreeItem(element);

      expect(item.command).toEqual({
        command: 'erdStudio.openDomain',
        title: 'Open Diagram',
        arguments: ['/path/to/test.json'],
      });
    });

    it('creates New Domain item with add icon and createDomain command', () => {
      const item = provider.getTreeItem({ type: 'newDomain', layer: 'gold', first: true });

      expect(item.label).toBe('New Diagram…');
      expect(item.description).toBe('none in this layer yet');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect(item.contextValue).toBe('newDomain');
      expect(item.command).toEqual({
        command: 'erdStudio.createDomain',
        title: 'New Diagram…',
        arguments: ['gold'],
      });
    });

    it('sets tooltip on domain items', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'orders', layer: 'silver', filePath: '/test.json' },
        modelCount: 2,
      };
      const item = provider.getTreeItem(element);

      const tip = (item.tooltip as vscode.MarkdownString).value;
      expect(tip).toContain('**orders** — a diagram in the Silver layer');
      expect(tip).toContain('File: `test.json`');
      expect(tip).toContain('2 tables');
    });

    it('says how many of a diagram\'s tables come from other layers', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'reporting', layer: 'gold', filePath: '/project/.erd-studio/gold/reporting.json' },
        modelCount: 5,
        otherLayers: [{ layer: 'silver', count: 2 }, { layer: 'bronze', count: 1 }],
      };
      const item = provider.getTreeItem(element);
      expect(item.description).toBe('5 tables · 2 from Silver, 1 from Bronze');
      expect((item.tooltip as vscode.MarkdownString).value).toContain('5 tables: 2 from Gold, 2 from Silver, 1 from Bronze');
    });
  });

  describe('diagram icons', () => {
    const EXTENSION = vscode.Uri.file('/ext');
    const icons = (kind: DbmlFileKind) => dbmlFileIcon(EXTENSION, kind);
    const dbmlRow: TreeElement = {
      type: 'domain',
      summary: { domain: 'sales', layer: 'gold', filePath: '/project/.erd-studio/gold/diagrams/sales.dbml', storage: 'dbml' },
      modelCount: 2,
    };
    const jsonRow: TreeElement = {
      type: 'domain',
      summary: { domain: 'orders', layer: 'gold', filePath: '/project/.erd-studio/gold/orders.json', storage: 'json' },
      modelCount: 2,
    };

    it('gives a DBML diagram row the DBML Diagram icon pair, from the extension\'s media/file-icons', () => {
      const withIcons = fullRows(new SubjectAreaTreeProvider(subjectAreaService, layerService, PROJECT_PATH, undefined, undefined, icons));
      const item = withIcons.getTreeItem(dbmlRow);
      expect(item.iconPath).toBe(dbmlFileIcon(EXTENSION, 'diagram'));
      const { light, dark } = item.iconPath as { light: vscode.Uri; dark: vscode.Uri };
      expect(light.fsPath).toBe('/ext/media/file-icons/dbml-diagram-light.svg');
      expect(dark.fsPath).toBe('/ext/media/file-icons/dbml-diagram-dark.svg');
      // An icon of its own, not one from the user's icon theme: no resourceUri.
      expect(item.resourceUri).toBeUndefined();
    });

    it('keeps the json codicon for a JSON diagram row, and a summary with no storage', () => {
      const withIcons = fullRows(new SubjectAreaTreeProvider(subjectAreaService, layerService, PROJECT_PATH, undefined, undefined, icons));
      for (const row of [jsonRow, { ...jsonRow, summary: { domain: 'x', layer: 'gold', filePath: '/x.json' } } as TreeElement]) {
        const item = withIcons.getTreeItem(row);
        expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
        expect((item.iconPath as vscode.ThemeIcon).id).toBe('json');
        expect(item.resourceUri).toBeUndefined();
      }
    });

    it('falls back to the json codicon for a DBML row without a resolver', () => {
      const item = provider.getTreeItem(dbmlRow);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('json');
      expect(item.resourceUri).toBeUndefined();
    });

    it('draws a layer row\'s icon in its layers.json colour, and leaves New Diagram\'s codicon alone', () => {
      const withIcons = fullRows(new SubjectAreaTreeProvider(subjectAreaService, layerService, PROJECT_PATH, undefined, undefined, icons));
      const layerIcon = withIcons.getTreeItem({ type: 'layer', layer: 'gold' }).iconPath as vscode.Uri;
      expect(layerIcon.toString()).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(Buffer.from(layerIcon.toString().split(',')[1], 'base64').toString()).toContain('fill="#d4a800"');
      // The label keeps the theme's colour: no file decoration recolours it.
      expect(withIcons.getTreeItem({ type: 'layer', layer: 'gold' }).resourceUri).toBeUndefined();
      expect((withIcons.getTreeItem({ type: 'newDomain', layer: 'gold', first: false }).iconPath as vscode.ThemeIcon).id).toBe('add');
    });
  });

  describe('refresh', () => {
    it('fires onDidChangeTreeData event', () => {
      let fired = false;
      provider.onDidChangeTreeData(() => {
        fired = true;
      });

      provider.refresh();
      expect(fired).toBe(true);
    });
  });

  describe('handleDrop', () => {
    it('surfaces a refused reorder (unreadable layers.json, H18) to the user, in words with Open File (#229)', async () => {
      const vscode = await import('vscode');
      const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
      (layerService as { reorderLayers: (ids: string[]) => Promise<void> }).reorderLayers =
        vi.fn(async () => { throw new LayersFileUnreadableError('Invalid JSON'); });

      const transfer = new vscode.DataTransfer();
      transfer.set('application/vnd.code.tree.dbtsemantic.layer', new vscode.DataTransferItem('gold'));
      const target: TreeElement = { type: 'layer', layer: 'bronze' };

      await provider.handleDrop(target, transfer as never, {} as never);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]).toEqual([
        "Reorder Layers: .erd-studio/layers.json has a mistake in it, so the layers weren't reordered. Fix the file, then try again.",
        'Open File',
      ]);
      errorSpy.mockRestore();
    });
  });

  describe('domain summary cache (H11)', () => {
    let tempDir: string;
    let domainPath: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-tree-'));
      fs.mkdirSync(path.join(tempDir, '.erd-studio', 'silver'), { recursive: true });
      domainPath = path.join(tempDir, '.erd-studio', 'silver', 'orders.json');
      fs.writeFileSync(domainPath, '{}');
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function realFileProvider(models: unknown[]): { provider: SubjectAreaTreeProvider; getSubjectArea: ReturnType<typeof vi.fn> } {
      const summaries: SubjectAreaSummary[] = [{ domain: 'orders', layer: 'silver', filePath: domainPath }];
      const domains = new Map<string, UnifiedSubjectArea>();
      domains.set(domainPath, makeUnifiedSubjectArea({
        domain: 'orders',
        logical: { models: models as any, relationships: [] },
      }));
      const svc = createMockSubjectAreaService(summaries, domains);
      return {
        provider: fullRows(new SubjectAreaTreeProvider(svc, layerService, tempDir)),
        getSubjectArea: svc.countSubjectAreaTables as unknown as ReturnType<typeof vi.fn>,
      };
    }

    it('parses each domain file once while it is unchanged on disk', () => {
      const { provider: p, getSubjectArea } = realFileProvider([{ name: 'a' }, { name: 'b' }]);

      const first = p.getChildren({ type: 'layer', layer: 'silver' })!;
      p.refresh();
      const second = p.getChildren({ type: 'layer', layer: 'silver' })!;
      p.getChildren({ type: 'layer', layer: 'silver' });

      expect(getSubjectArea).toHaveBeenCalledTimes(1);
      expect((first[0] as any).modelCount).toBe(2);
      expect((second[0] as any).modelCount).toBe(2);
    });

    it('re-parses when the file changes on disk (mtime/size)', () => {
      const { provider: p, getSubjectArea } = realFileProvider([{ name: 'a' }]);
      p.getChildren({ type: 'layer', layer: 'silver' });
      expect(getSubjectArea).toHaveBeenCalledTimes(1);

      fs.writeFileSync(domainPath, '{"changed": true}');
      const t = new Date(Date.now() + 5000);
      fs.utimesSync(domainPath, t, t);

      p.getChildren({ type: 'layer', layer: 'silver' });
      expect(getSubjectArea).toHaveBeenCalledTimes(2);
    });

    it('re-parses after invalidateSubjectArea(filePath)', () => {
      const { provider: p, getSubjectArea } = realFileProvider([{ name: 'a' }]);
      p.getChildren({ type: 'layer', layer: 'silver' });
      p.invalidateSubjectArea(domainPath);
      p.getChildren({ type: 'layer', layer: 'silver' });
      expect(getSubjectArea).toHaveBeenCalledTimes(2);
    });

    it('re-parses everything after invalidateSubjectArea() with no argument', () => {
      const { provider: p, getSubjectArea } = realFileProvider([{ name: 'a' }]);
      p.getChildren({ type: 'layer', layer: 'silver' });
      p.invalidateSubjectArea();
      p.getChildren({ type: 'layer', layer: 'silver' });
      expect(getSubjectArea).toHaveBeenCalledTimes(2);
    });

    it('reads a diagram once for its count and member names, and works out the homes once per listing', () => {
      fs.mkdirSync(path.join(tempDir, '.erd-studio', 'gold'), { recursive: true });
      const goldPath = path.join(tempDir, '.erd-studio', 'gold', 'sales.json');
      fs.writeFileSync(goldPath, JSON.stringify({ schemaVersion: 5, domain: 'sales', logical: { models: ['fct_order', 'dim_customer'] } }));
      fs.writeFileSync(domainPath, JSON.stringify({ schemaVersion: 5, domain: 'orders', logical: { models: ['dim_customer'] } }));
      const summaries: SubjectAreaSummary[] = [
        { domain: 'orders', layer: 'silver', filePath: domainPath },
        { domain: 'sales', layer: 'gold', filePath: goldPath },
      ];
      const svc = {
        listSubjectAreas: vi.fn().mockReturnValue(summaries),
        countSubjectAreaTables: vi.fn(() => 0),
        countSubjectAreaTablesInText: vi.fn((raw: string) => (JSON.parse(raw) as { logical: { models: string[] } }).logical.models.length),
      } as unknown as SubjectAreaService;
      const homes = vi.fn(() => new Map([['dim_customer', { layer: 'silver', schema: 'crm' }], ['fct_order', { layer: 'gold', schema: 'sales' }]]));
      const p = fullRows(new SubjectAreaTreeProvider(svc, layerService, tempDir, '.erd-studio', undefined, undefined, homes));
      const readSpy = vi.spyOn(fs, 'readFileSync');
      const roots = p.getChildren()!;
      const layerRows = roots.filter((r) => r.type === 'layer');
      const children = layerRows.map((l) => p.getChildren(l)!);
      const sales = children.flat().find((c) => c.type === 'domain' && c.summary.domain === 'sales') as { modelCount: number; otherLayers?: unknown };
      expect(sales.modelCount).toBe(2);
      expect(sales.otherLayers).toEqual([{ layer: 'silver', count: 1 }]);
      expect(homes).toHaveBeenCalledTimes(1);
      expect(svc.countSubjectAreaTables).not.toHaveBeenCalled();
      expect(readSpy.mock.calls.filter(([f]) => f === goldPath)).toHaveLength(1);
      readSpy.mockRestore();
    });

    it('reads no member names when no table has a layer (a YAML project)', () => {
      const summaries: SubjectAreaSummary[] = [{ domain: 'orders', layer: 'silver', filePath: domainPath }];
      const svc = {
        listSubjectAreas: vi.fn().mockReturnValue(summaries),
        countSubjectAreaTables: vi.fn(() => 3),
        countSubjectAreaTablesInText: vi.fn(() => 3),
      } as unknown as SubjectAreaService;
      const p = fullRows(new SubjectAreaTreeProvider(svc, layerService, tempDir, '.erd-studio', undefined, undefined, () => new Map()));
      const readSpy = vi.spyOn(fs, 'readFileSync');
      const [row] = p.getChildren({ type: 'layer', layer: 'silver' })!;
      expect((row as { modelCount: number }).modelCount).toBe(3);
      expect(svc.countSubjectAreaTablesInText).not.toHaveBeenCalled();
      expect(readSpy.mock.calls.filter(([f]) => f === domainPath)).toHaveLength(0);
      readSpy.mockRestore();
    });

    it('does not cache a failed parse', () => {
      const summaries: SubjectAreaSummary[] = [{ domain: 'orders', layer: 'silver', filePath: domainPath }];
      const svc = createMockSubjectAreaService(summaries, new Map()); // getSubjectArea throws
      const p = fullRows(new SubjectAreaTreeProvider(svc, layerService, tempDir));

      p.getChildren({ type: 'layer', layer: 'silver' });
      p.getChildren({ type: 'layer', layer: 'silver' });

      expect(svc.countSubjectAreaTables).toHaveBeenCalledTimes(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Compact rows (`erdStudio.sidebar.rowDetails: compact`, the default)
// ---------------------------------------------------------------------------

describe('SubjectAreaTreeProvider: compact rows (the default)', () => {
  let layerService: LayerService;
  let provider: SubjectAreaTreeProvider;
  const tipOf = (item: vscode.TreeItem): string => (item.tooltip as vscode.MarkdownString).value;

  beforeEach(() => {
    layerService = createMockLayerService();
    provider = new SubjectAreaTreeProvider(createMockSubjectAreaService(ALL_SUMMARIES, buildSubjectAreaMap()), layerService, PROJECT_PATH);
  });

  it('is compact until told otherwise, and lists again only when the mode changes', () => {
    expect(provider.getRowDetails()).toBe('compact');
    const fired = vi.fn();
    provider.onDidChangeTreeData(fired);
    provider.setRowDetails('compact');
    expect(fired).not.toHaveBeenCalled();
    provider.setRowDetails('full');
    expect(fired).toHaveBeenCalledTimes(1);
    expect(provider.getRowDetails()).toBe('full');
  });

  it('a layer row says "Layer" and nothing else; its hover has the count and the + action', () => {
    const [bronze, silver] = provider.getChildren()!;
    const silverItem = provider.getTreeItem(silver);
    expect(silverItem.description).toBe('Layer');
    expect(tipOf(silverItem)).toContain('2 diagrams');
    expect(tipOf(silverItem)).toContain('**+** on this row starts a new diagram in Silver.');
    const bronzeItem = provider.getTreeItem(bronze);
    expect(bronzeItem.description).toBe('Layer');
    expect(tipOf(bronzeItem)).toContain('No diagrams yet.');
    // Bronze takes no new diagrams: no + to point at.
    expect(tipOf(bronzeItem)).not.toContain('**+**');
    // The inline + shows on a creatable layer row (package.json: viewItem == layerCreatable).
    expect(silverItem.contextValue).toBe('layerCreatable');
  });

  it('shows New Diagram… only in a creatable layer with no diagram, where it is the call to action; New Layer… stays', () => {
    expect(provider.getChildren({ type: 'layer', layer: 'silver' })!.map((c) => c.type)).toEqual(['domain', 'domain']);
    expect(provider.getChildren({ type: 'layer', layer: 'gold' })!.map((c) => c.type)).toEqual(['domain']);
    layerService.isCreatable = () => true;
    expect(provider.getChildren({ type: 'layer', layer: 'bronze' })).toEqual([{ type: 'newDomain', layer: 'bronze', first: true }]);
    expect(provider.getTreeItem({ type: 'newDomain', layer: 'bronze', first: true }).description).toBe('none in this layer yet');
    expect(provider.getChildren()!.at(-1)).toEqual({ type: 'newLayer' });
    // Full rows keep today's New Diagram… under every creatable layer.
    provider.setRowDetails('full');
    expect(provider.getChildren({ type: 'layer', layer: 'silver' })!.map((c) => c.type)).toEqual(['domain', 'domain', 'newDomain']);
  });

  it('a diagram row drops its table count (the hover has it) and keeps only the cross-layer exception', () => {
    const plain = provider.getTreeItem({ type: 'domain', summary: { domain: 'orders', layer: 'silver', filePath: '/test.json' }, modelCount: 8 });
    expect(plain.description).toBeUndefined();
    expect(tipOf(plain)).toContain('8 tables');

    const borrowed = provider.getTreeItem({
      type: 'domain',
      summary: { domain: 'sales', layer: 'gold', filePath: '/project/.erd-studio/gold/sales.json' },
      modelCount: 8,
      otherLayers: [{ layer: 'silver', count: 5 }],
    });
    expect(borrowed.description).toBe('5 from Silver');
    expect(tipOf(borrowed)).toContain('8 tables: 3 from Gold, 5 from Silver');

    const several = provider.getTreeItem({
      type: 'domain',
      summary: { domain: 'reporting', layer: 'gold', filePath: '/r.json' },
      modelCount: 5,
      otherLayers: [{ layer: 'silver', count: 2 }, { layer: 'bronze', count: 1 }],
    });
    expect(several.description).toBe('2 from Silver, 1 from Bronze');
  });

  it('keeps the (DBML) / (JSON) tag of a name both formats use in one layer', () => {
    const summary = { domain: 'sales', layer: 'gold', filePath: '/x/sales.dbml', storage: 'dbml' as const, conflict: true };
    expect(provider.getTreeItem({ type: 'domain', summary, modelCount: 3 }).description).toBe('(DBML)');
    expect(provider.getTreeItem({ type: 'domain', summary, modelCount: 3, otherLayers: [{ layer: 'silver', count: 1 }] }).description)
      .toBe('(DBML) · 1 from Silver');
    provider.setRowDetails('full');
    expect(provider.getTreeItem({ type: 'domain', summary, modelCount: 3, otherLayers: [{ layer: 'silver', count: 1 }] }).description)
      .toBe('3 tables (DBML) · 1 from Silver');
  });

  it('keeps the project row\'s Switch… (a call to action)', () => {
    provider.setProjectRow({ name: 'datamodels', location: 'workspace folder' });
    expect(provider.getTreeItem(provider.getChildren()![0]).description).toBe('dbt project · Switch…');
  });

  it('gives the view\'s total for its title: none before a listing, singular for one, none for an empty project', () => {
    expect(provider.headerTotal()).toBeUndefined();
    provider.getChildren();
    expect(provider.headerTotal()).toBe('3 diagrams');
    const one = new SubjectAreaTreeProvider(createMockSubjectAreaService([GOLD_SUBJECT_AREAS[0]], buildSubjectAreaMap()), layerService, PROJECT_PATH);
    one.getChildren();
    expect(one.headerTotal()).toBe('1 diagram');
    const empty = new SubjectAreaTreeProvider(createMockSubjectAreaService([], new Map()), layerService, PROJECT_PATH);
    empty.getChildren();
    expect(empty.headerTotal()).toBeUndefined();
  });

  it('reports each unfiltered listing (undefined), so the view can show its total', () => {
    const seen: unknown[] = [];
    provider.onDidFilter((o) => seen.push(o));
    provider.getChildren();
    expect(seen).toEqual([undefined]);
  });
});
