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
    provider = new SubjectAreaTreeProvider(subjectAreaService, layerService, PROJECT_PATH);
  });

  describe('getChildren (root)', () => {
    it('returns three layer nodes at root (no stage header)', () => {
      const children = provider.getChildren(undefined);

      expect(children).toHaveLength(3);
      expect(children).toEqual([
        { type: 'layer', layer: 'bronze' },
        { type: 'layer', layer: 'silver' },
        { type: 'layer', layer: 'gold' },
      ]);
    });

    it('returns empty array when semantic directory does not exist (F408 welcome)', () => {
      const providerNoSemantic = new SubjectAreaTreeProvider(subjectAreaService, layerService, '/nonexistent/path');
      const children = providerNoSemantic.getChildren(undefined);

      expect(children).toHaveLength(0);
      expect(children).toEqual([]);
    });
  });

  describe('project row (#82)', () => {
    it('leads the tree with a clickable project row when there is more than one project', () => {
      const fired = vi.fn();
      provider.onDidChangeTreeData(fired);
      provider.setProjectRow({ name: 'datamodels', location: 'workspace folder' });

      const children = provider.getChildren(undefined)!;
      expect(children[0]).toEqual({ type: 'project', name: 'datamodels', location: 'workspace folder' });
      expect(children.slice(1).map((c) => c.type)).toEqual(['layer', 'layer', 'layer']);
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
      expect(provider.getChildren(undefined)!.every((c) => c.type === 'layer')).toBe(true);
    });

    it('never makes an empty tree non-empty, so the welcome view still shows', () => {
      const providerNoSemantic = new SubjectAreaTreeProvider(subjectAreaService, layerService, '/nonexistent/path');
      providerNoSemantic.setProjectRow({ name: 'finance-dbt', location: 'workspace folder' });
      expect(providerNoSemantic.getChildren(undefined)).toEqual([]);
    });
  });

  describe('getChildren (layer)', () => {
    it('returns domain nodes for silver layer', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'silver' })!;

      // 2 silver domains + "New Domain..."
      expect(children).toHaveLength(3);
      expect(children[0].type).toBe('domain');
      expect(children[1].type).toBe('domain');
      expect(children[2].type).toBe('newDomain');
    });

    it('returns domain nodes for gold layer', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'gold' })!;

      // 1 gold domain + "New Domain..."
      expect(children).toHaveLength(2);
      expect(children[0].type).toBe('domain');
      expect(children[1].type).toBe('newDomain');
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
        expect(customer.designCount).toBe(0);
      }
    });

    it('shows New Domain node for creatable layers', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'silver' })!;
      const newDomain = children[children.length - 1];

      expect(newDomain).toEqual({ type: 'newDomain', layer: 'silver' });
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
      const failProvider = new SubjectAreaTreeProvider(failService, layerService, PROJECT_PATH);
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
        designCount: 0,
      });
      expect(children).toBeUndefined();
    });

    it('returns undefined for newDomain nodes', () => {
      const children = provider.getChildren({ type: 'newDomain', layer: 'silver' });
      expect(children).toBeUndefined();
    });
  });

  describe('getTreeItem', () => {
    it('creates layer item with folder icon and expanded state', () => {
      const item = provider.getTreeItem({ type: 'layer', layer: 'silver' });

      expect(item.label).toBe('Silver');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
      expect(item.contextValue).toBe('layer');
    });

    it('creates domain item with badge showing design count', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'orders', layer: 'silver', filePath: '/test.json' },
        modelCount: 12,
        designCount: 3,
      };
      const item = provider.getTreeItem(element);

      expect(item.label).toBe('orders');
      expect(item.description).toBe('12 tables, 3 designs');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect(item.contextValue).toBe('domain');
    });

    it('creates domain item with badge omitting design when zero', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'finance', layer: 'gold', filePath: '/test.json' },
        modelCount: 5,
        designCount: 0,
      };
      const item = provider.getTreeItem(element);

      expect(item.description).toBe('5 tables');
    });

    it('uses singular "table" when count is 1', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'test', layer: 'gold', filePath: '/test.json' },
        modelCount: 1,
        designCount: 0,
      };
      const item = provider.getTreeItem(element);

      expect(item.description).toBe('1 table');
    });

    it('sets openDomain command on domain items with only filePath', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'test', layer: 'silver', filePath: '/path/to/test.json' },
        modelCount: 0,
        designCount: 0,
      };
      const item = provider.getTreeItem(element);

      expect(item.command).toEqual({
        command: 'erdStudio.openDomain',
        title: 'Open Subject Area',
        arguments: ['/path/to/test.json'],
      });
    });

    it('creates New Domain item with add icon and createDomain command', () => {
      const item = provider.getTreeItem({ type: 'newDomain', layer: 'gold' });

      expect(item.label).toBe('New Subject Area...');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect(item.contextValue).toBe('newDomain');
      expect(item.command).toEqual({
        command: 'erdStudio.createDomain',
        title: 'New Subject Area',
        arguments: ['gold'],
      });
    });

    it('sets tooltip on domain items', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'orders', layer: 'silver', filePath: '/test.json' },
        modelCount: 2,
        designCount: 1,
      };
      const item = provider.getTreeItem(element);

      expect(item.tooltip).toBe('Silver / orders');
    });
  });

  describe('diagram icons', () => {
    const EXTENSION = vscode.Uri.file('/ext');
    const icons = (kind: DbmlFileKind) => dbmlFileIcon(EXTENSION, kind);
    const dbmlRow: TreeElement = {
      type: 'domain',
      summary: { domain: 'sales', layer: 'gold', filePath: '/project/.erd-studio/gold/diagrams/sales.dbml', storage: 'dbml' },
      modelCount: 2,
      designCount: 0,
    };
    const jsonRow: TreeElement = {
      type: 'domain',
      summary: { domain: 'orders', layer: 'gold', filePath: '/project/.erd-studio/gold/orders.json', storage: 'json' },
      modelCount: 2,
      designCount: 0,
    };

    it('gives a DBML diagram row the DBML Diagram icon pair, from the extension\'s media/file-icons', () => {
      const withIcons = new SubjectAreaTreeProvider(subjectAreaService, layerService, PROJECT_PATH, undefined, undefined, icons);
      const item = withIcons.getTreeItem(dbmlRow);
      expect(item.iconPath).toBe(dbmlFileIcon(EXTENSION, 'diagram'));
      const { light, dark } = item.iconPath as { light: vscode.Uri; dark: vscode.Uri };
      expect(light.fsPath).toBe('/ext/media/file-icons/dbml-diagram-light.svg');
      expect(dark.fsPath).toBe('/ext/media/file-icons/dbml-diagram-dark.svg');
      // An icon of its own, not one from the user's icon theme: no resourceUri.
      expect(item.resourceUri).toBeUndefined();
    });

    it('keeps the json codicon for a JSON diagram row, and a summary with no storage', () => {
      const withIcons = new SubjectAreaTreeProvider(subjectAreaService, layerService, PROJECT_PATH, undefined, undefined, icons);
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

    it('leaves the layer and New Subject Area rows\' codicons alone', () => {
      const withIcons = new SubjectAreaTreeProvider(subjectAreaService, layerService, PROJECT_PATH, undefined, undefined, icons);
      expect((withIcons.getTreeItem({ type: 'layer', layer: 'gold' }).iconPath as vscode.ThemeIcon).id).toBe('folder');
      expect((withIcons.getTreeItem({ type: 'newDomain', layer: 'gold' }).iconPath as vscode.ThemeIcon).id).toBe('add');
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
        provider: new SubjectAreaTreeProvider(svc, layerService, tempDir),
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

    it('does not cache a failed parse', () => {
      const summaries: SubjectAreaSummary[] = [{ domain: 'orders', layer: 'silver', filePath: domainPath }];
      const svc = createMockSubjectAreaService(summaries, new Map()); // getSubjectArea throws
      const p = new SubjectAreaTreeProvider(svc, layerService, tempDir);

      p.getChildren({ type: 'layer', layer: 'silver' });
      p.getChildren({ type: 'layer', layer: 'silver' });

      expect(svc.countSubjectAreaTables).toHaveBeenCalledTimes(2);
    });
  });
});
