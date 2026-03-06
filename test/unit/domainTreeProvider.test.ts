import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TreeItemCollapsibleState } from 'vscode';
import { DomainTreeProvider, type TreeElement } from '../../src/providers/DomainTreeProvider';
import type { DomainService } from '../../src/services/domainService';
import type { LayerService } from '../../src/services/layerService';
import type { LayerConfig } from '../../src/types/layer';
import type { DomainSummary, UnifiedDomain, StageData } from '../../src/types/semantic';

// Must be at module level for vitest to hoist correctly
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (typeof p === 'string' && p.includes('test-project') && p.includes('erd-studio')) return true;
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
  } as LayerService;
}

const emptyStageData: StageData = { models: [], relationships: [], viewConfig: { positions: {} } };

function makeUnifiedDomain(overrides: Partial<UnifiedDomain> = {}): UnifiedDomain {
  return {
    schemaVersion: 3,
    domain: 'test',
    layer: 'silver',
    description: '',
    conceptual: { ...emptyStageData },
    logical: { ...emptyStageData },
    ...overrides,
  };
}

function createMockDomainService(
  summaries: DomainSummary[] = [],
  domains: Map<string, UnifiedDomain> = new Map(),
): DomainService {
  return {
    listDomains: vi.fn().mockReturnValue(summaries),
    getDomain: vi.fn((filePath: string) => {
      const d = domains.get(filePath);
      if (!d) throw new Error(`Not found: ${filePath}`);
      return d;
    }),
  } as unknown as DomainService;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SILVER_DOMAINS: DomainSummary[] = [
  { domain: 'customer-360', layer: 'silver', filePath: '/project/erd-studio/silver/customer-360.json' },
  { domain: 'orders', layer: 'silver', filePath: '/project/erd-studio/silver/orders.json' },
];

const GOLD_DOMAINS: DomainSummary[] = [
  { domain: 'reporting', layer: 'gold', filePath: '/project/erd-studio/gold/reporting.json' },
];

const ALL_SUMMARIES = [...SILVER_DOMAINS, ...GOLD_DOMAINS];

function buildDomainMap(): Map<string, UnifiedDomain> {
  const map = new Map<string, UnifiedDomain>();
  map.set('/project/erd-studio/silver/customer-360.json', makeUnifiedDomain({
    domain: 'customer-360',
    layer: 'silver',
    logical: {
      models: [{ name: 'dim_customer' }, { name: 'fct_orders' }] as any,
      relationships: [],
      viewConfig: { positions: {} },
    },
  }));
  map.set('/project/erd-studio/silver/orders.json', makeUnifiedDomain({
    domain: 'orders',
    layer: 'silver',
    logical: {
      models: [{ name: 'fct_order_lines' }] as any,
      relationships: [],
      viewConfig: { positions: {} },
    },
  }));
  map.set('/project/erd-studio/gold/reporting.json', makeUnifiedDomain({
    domain: 'reporting',
    layer: 'gold',
    logical: {
      models: [] as any,
      relationships: [],
      viewConfig: { positions: {} },
    },
  }));
  return map;
}

// Use a real project path that exists on disk for the semantic dir check.
// We mock DomainService so no real files are read, but getChildren checks
// fs.existsSync for the semantic directory.
const PROJECT_PATH = '/tmp/test-project';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DomainTreeProvider', () => {
  let layerService: LayerService;
  let domainService: DomainService;
  let provider: DomainTreeProvider;

  beforeEach(() => {
    layerService = createMockLayerService();
    domainService = createMockDomainService(ALL_SUMMARIES, buildDomainMap());
    provider = new DomainTreeProvider(domainService, layerService, PROJECT_PATH);
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
      const providerNoSemantic = new DomainTreeProvider(domainService, layerService, '/nonexistent/path');
      const children = providerNoSemantic.getChildren(undefined);

      expect(children).toHaveLength(0);
      expect(children).toEqual([]);
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

    it('handles getDomain errors gracefully with 0 model count', () => {
      const failService = createMockDomainService(
        [{ domain: 'broken', layer: 'silver', filePath: '/broken.json' }],
        new Map(), // empty — getDomain will throw
      );
      const failProvider = new DomainTreeProvider(failService, layerService, PROJECT_PATH);
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
        summary: { domain: 'work-lots', layer: 'silver', filePath: '/test.json' },
        modelCount: 12,
        designCount: 3,
      };
      const item = provider.getTreeItem(element);

      expect(item.label).toBe('work-lots');
      expect(item.description).toBe('12 models, 3 designs');
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

      expect(item.description).toBe('5 models');
    });

    it('uses singular "model" when count is 1', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'test', layer: 'gold', filePath: '/test.json' },
        modelCount: 1,
        designCount: 0,
      };
      const item = provider.getTreeItem(element);

      expect(item.description).toBe('1 model');
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
        command: 'dbtSemantic.openDomain',
        title: 'Open Domain',
        arguments: ['/path/to/test.json'],
      });
    });

    it('creates New Domain item with add icon and createDomain command', () => {
      const item = provider.getTreeItem({ type: 'newDomain', layer: 'gold' });

      expect(item.label).toBe('New Domain...');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect(item.contextValue).toBe('newDomain');
      expect(item.command).toEqual({
        command: 'dbtSemantic.createDomain',
        title: 'Create Domain',
        arguments: ['gold'],
      });
    });

    it('sets tooltip on domain items', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'work-lots', layer: 'silver', filePath: '/test.json' },
        modelCount: 2,
        designCount: 1,
      };
      const item = provider.getTreeItem(element);

      expect(item.tooltip).toBe('Silver / work-lots');
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
});
