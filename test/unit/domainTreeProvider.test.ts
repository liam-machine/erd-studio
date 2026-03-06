import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';
import { TreeItemCollapsibleState } from 'vscode';
import { DomainService } from '../../src/services/domainService';
import { DomainTreeProvider, type TreeElement } from '../../src/providers/DomainTreeProvider';
import type { LayerService } from '../../src/services/layerService';
import type { LayerConfig } from '../../src/types/layer';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const FIXTURE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project');

// Mock LayerService that returns the classic bronze/silver/gold layers
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

/** Create a minimal mock ExtensionContext with in-memory workspaceState. */
function createMockContext(): vscode.ExtensionContext {
  const state = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, defaultValue?: T) => (state.get(key) as T) ?? defaultValue,
      update: async (key: string, value: unknown) => { state.set(key, value); },
      keys: () => [...state.keys()],
    },
  } as unknown as vscode.ExtensionContext;
}

describe('DomainTreeProvider', () => {
  let service: DomainService;
  let layerService: LayerService;
  let provider: DomainTreeProvider;
  let mockContext: vscode.ExtensionContext;

  beforeEach(async () => {
    layerService = createMockLayerService();
    service = new DomainService(layerService);
    mockContext = createMockContext();
    provider = new DomainTreeProvider(service, layerService, FIXTURE_PROJECT_PATH, mockContext);
    // Fixture domains are under conceptual/
    await provider.setStage('conceptual');
  });

  describe('getChildren (root)', () => {
    it('returns stage header plus three layer nodes at root', () => {
      const children = provider.getChildren(undefined);

      expect(children).toHaveLength(4);
      expect(children).toEqual([
        { type: 'stageHeader' },
        { type: 'layer', layer: 'bronze' },
        { type: 'layer', layer: 'silver' },
        { type: 'layer', layer: 'gold' },
      ]);
    });

    it('returns empty array when semantic directory does not exist (F408 welcome)', () => {
      const providerNoSemantic = new DomainTreeProvider(service, layerService, '/nonexistent/path', mockContext);
      const children = providerNoSemantic.getChildren(undefined);

      expect(children).toHaveLength(0);
      expect(children).toEqual([]);
    });
  });

  describe('getChildren (layer)', () => {
    it('returns domain nodes for silver layer', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'silver' })!;

      // 5 silver domains (bob, ncr, ppw-work-lot, sdd, ttt) + "New Domain..." item
      expect(children).toHaveLength(6);
      // All but last should be domain nodes
      for (let i = 0; i < 5; i++) {
        expect(children[i].type).toBe('domain');
      }
      expect(children[5].type).toBe('newDomain');
    });

    it('returns domain nodes for gold layer', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'gold' })!;

      // finance domain + "New Domain..." item
      expect(children).toHaveLength(2);
      expect(children[0].type).toBe('domain');
      expect(children[1].type).toBe('newDomain');
    });

    it('returns empty array for bronze (no domains, no New Domain item)', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'bronze' })!;

      expect(children).toHaveLength(0);
    });

    it('returns correct model counts for ppw-work-lot domain', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'silver' })!;
      // Find ppw-work-lot domain node
      const domain = children.find(
        (c) => c.type === 'domain' && c.summary.domain === 'ppw-work-lot',
      );

      expect(domain).toBeDefined();
      expect(domain!.type).toBe('domain');
      if (domain!.type === 'domain') {
        expect(domain!.modelCount).toBe(39);
        expect(domain!.designCount).toBe(0);
      }
    });

    it('returns correct model counts for finance domain (no design models)', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'gold' })!;
      const domain = children[0];

      expect(domain.type).toBe('domain');
      if (domain.type === 'domain') {
        expect(domain.modelCount).toBe(1);
        expect(domain.designCount).toBe(0);
      }
    });

    it('passes layer to NewDomain node', () => {
      const children = provider.getChildren({ type: 'layer', layer: 'silver' })!;
      const newDomain = children[children.length - 1];

      expect(newDomain).toEqual({ type: 'newDomain', layer: 'silver' });
    });

    it('hides New Domain node when stage is physical', async () => {
      await provider.setStage('physical');
      // Physical mirrors logical — fixtures only have conceptual so no domains will show
      // but the key assertion is that newDomain items are never added for physical
      const children = provider.getChildren({ type: 'layer', layer: 'silver' })!;
      const hasNewDomain = children.some(c => c.type === 'newDomain');
      expect(hasNewDomain).toBe(false);
    });
  });

  describe('getChildren (leaf)', () => {
    it('returns undefined for domain nodes', () => {
      const children = provider.getChildren({
        type: 'domain',
        summary: { domain: 'test', layer: 'silver', stage: 'conceptual', filePath: '/test.json' },
        modelCount: 0,
        designCount: 0,
        openAsStage: 'conceptual',
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
        summary: { domain: 'work-lots', layer: 'silver', stage: 'conceptual', filePath: '/test.json' },
        modelCount: 12,
        designCount: 3,
        openAsStage: 'conceptual',
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
        summary: { domain: 'finance', layer: 'gold', stage: 'conceptual', filePath: '/test.json' },
        modelCount: 5,
        designCount: 0,
        openAsStage: 'conceptual',
      };
      const item = provider.getTreeItem(element);

      expect(item.description).toBe('5 models');
    });

    it('uses singular "model" when count is 1', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'test', layer: 'gold', stage: 'conceptual', filePath: '/test.json' },
        modelCount: 1,
        designCount: 0,
        openAsStage: 'conceptual',
      };
      const item = provider.getTreeItem(element);

      expect(item.description).toBe('1 model');
    });

    it('sets openDomain command on domain items with stage argument', () => {
      const element: TreeElement = {
        type: 'domain',
        summary: { domain: 'test', layer: 'silver', stage: 'conceptual', filePath: '/path/to/test.json' },
        modelCount: 0,
        designCount: 0,
        openAsStage: 'conceptual',
      };
      const item = provider.getTreeItem(element);

      expect(item.command).toEqual({
        command: 'dbtSemantic.openDomain',
        title: 'Open Domain',
        arguments: ['/path/to/test.json', 'conceptual'],
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
        summary: { domain: 'work-lots', layer: 'silver', stage: 'conceptual', filePath: '/test.json' },
        modelCount: 2,
        designCount: 1,
        openAsStage: 'conceptual',
      };
      const item = provider.getTreeItem(element);

      expect(item.tooltip).toBe('Silver / work-lots');
    });
  });

  describe('stage management', () => {
    it('defaults to logical when workspace state is empty', () => {
      const freshContext = createMockContext();
      const freshProvider = new DomainTreeProvider(service, layerService, FIXTURE_PROJECT_PATH, freshContext);
      expect(freshProvider.getStage()).toBe('logical');
    });

    it('reads persisted stage from workspace state', () => {
      // beforeEach called setStage('conceptual'), so mockContext has it persisted
      const freshProvider = new DomainTreeProvider(service, layerService, FIXTURE_PROJECT_PATH, mockContext);
      expect(freshProvider.getStage()).toBe('conceptual');
    });

    it('persists stage selection to workspace state', async () => {
      await provider.setStage('physical');
      expect(provider.getStage()).toBe('physical');

      // New provider reads persisted value
      const freshProvider = new DomainTreeProvider(service, layerService, FIXTURE_PROJECT_PATH, mockContext);
      expect(freshProvider.getStage()).toBe('physical');
    });

    it('filters domains by current stage', async () => {
      // conceptual has fixtures
      await provider.setStage('conceptual');
      const conceptualChildren = provider.getChildren({ type: 'layer', layer: 'silver' })!;
      const conceptualDomains = conceptualChildren.filter(c => c.type === 'domain');
      expect(conceptualDomains.length).toBeGreaterThan(0);

      // logical has no fixtures
      await provider.setStage('logical');
      const logicalChildren = provider.getChildren({ type: 'layer', layer: 'silver' })!;
      const logicalDomains = logicalChildren.filter(c => c.type === 'domain');
      expect(logicalDomains.length).toBe(0);
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
