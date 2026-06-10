import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TreeItemCollapsibleState, ThemeIcon, MarkdownString } from 'vscode';
import { ModelLibraryTreeProvider, type ModelLibraryNode } from '../../src/providers/ModelLibraryTreeProvider';
import type { LogicalModelService } from '../../src/services/logicalModelService';
import type { DomainService } from '../../src/services/domainService';
import type { DomainSummary } from '../../src/types/semantic';

// Mock fs — readFileSync returns domain JSON for cross-referencing
const mockReadFileSync = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  };
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockLogicalModelService(
  modelNames: string[] = [],
  modelsDir = '/project/.erd-studio/logical-models',
): LogicalModelService {
  return {
    dirExists: vi.fn(() => modelNames.length > 0),
    listModelNames: vi.fn(() => modelNames),
    modelPath: vi.fn((name: string) => `${modelsDir}/${name}.yml`),
    deleteModel: vi.fn(),
  } as unknown as LogicalModelService;
}

function createMockDomainService(summaries: DomainSummary[] = []): DomainService {
  return {
    listDomains: vi.fn().mockReturnValue(summaries),
  } as unknown as DomainService;
}

/** Helper to build a raw v5 domain JSON string. */
function v5DomainJson(modelNames: string[]): string {
  return JSON.stringify({
    schemaVersion: 5,
    domain: 'test',
    layer: 'silver',
    logical: { models: modelNames, relationships: [] },
    viewConfig: {},
  });
}

/** Helper to build a raw v4 domain JSON string with inline model objects. */
function v4DomainJson(modelNames: string[]): string {
  return JSON.stringify({
    schemaVersion: 4,
    domain: 'legacy',
    layer: 'silver',
    logical: {
      models: modelNames.map(name => ({ name, columns: [] })),
      relationships: [],
    },
    viewConfig: {},
  });
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SUMMARIES: DomainSummary[] = [
  { domain: 'customer-360', layer: 'silver', filePath: '/project/.erd-studio/silver/customer-360.json' },
  { domain: 'reporting', layer: 'gold', filePath: '/project/.erd-studio/gold/reporting.json' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelLibraryTreeProvider', () => {
  let provider: ModelLibraryTreeProvider;
  let mockLogicalModelService: LogicalModelService;
  let mockDomainService: DomainService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogicalModelService = createMockLogicalModelService(
      ['dim_customer', 'dim_date', 'fct_orders'],
    );
    mockDomainService = createMockDomainService(SUMMARIES);

    // Default: customer-360 references dim_customer and fct_orders,
    // reporting references dim_customer only
    mockReadFileSync.mockImplementation((filePath: string) => {
      if (filePath.includes('customer-360')) {
        return v5DomainJson(['dim_customer', 'fct_orders']);
      }
      if (filePath.includes('reporting')) {
        return v5DomainJson(['dim_customer']);
      }
      throw new Error(`Unexpected file: ${filePath}`);
    });

    provider = new ModelLibraryTreeProvider(
      mockLogicalModelService,
      mockDomainService,
      '/project',
      '.erd-studio',
    );
  });

  // -------------------------------------------------------------------------
  // getChildren
  // -------------------------------------------------------------------------

  describe('getChildren', () => {
    it('returns flat list of all models sorted alphabetically', () => {
      const children = provider.getChildren();
      expect(children).toHaveLength(3);
      expect(children!.map(c => c.name)).toEqual(['dim_customer', 'dim_date', 'fct_orders']);
    });

    it('returns undefined for child elements (flat list)', () => {
      const children = provider.getChildren();
      expect(provider.getChildren(children![0])).toBeUndefined();
    });

    it('returns empty array when logical-models dir does not exist', () => {
      mockLogicalModelService = createMockLogicalModelService([]);
      provider = new ModelLibraryTreeProvider(
        mockLogicalModelService,
        mockDomainService,
        '/project',
        '.erd-studio',
      );
      expect(provider.getChildren()).toEqual([]);
    });

    it('populates referencingDomains correctly', () => {
      const children = provider.getChildren()!;
      const customer = children.find(c => c.name === 'dim_customer')!;
      const date = children.find(c => c.name === 'dim_date')!;
      const orders = children.find(c => c.name === 'fct_orders')!;

      expect(customer.referencingDomains).toEqual(['customer-360', 'reporting']);
      expect(date.referencingDomains).toEqual([]);
      expect(orders.referencingDomains).toEqual(['customer-360']);
    });

    it('handles v4 domain files with inline model objects', () => {
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes('customer-360')) {
          return v4DomainJson(['dim_customer', 'fct_orders']);
        }
        if (filePath.includes('reporting')) {
          return v4DomainJson(['dim_customer']);
        }
        throw new Error(`Unexpected file: ${filePath}`);
      });

      const children = provider.getChildren()!;
      const customer = children.find(c => c.name === 'dim_customer')!;
      expect(customer.referencingDomains).toEqual(['customer-360', 'reporting']);
    });

    it('skips unreadable domain files gracefully', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const children = provider.getChildren()!;
      expect(children).toHaveLength(3);
      // All models should be orphans since no domains could be read
      expect(children.every(c => c.referencingDomains.length === 0)).toBe(true);
    });

    it('sets correct filePath on each node', () => {
      const children = provider.getChildren()!;
      expect(children[0].filePath).toBe('/project/.erd-studio/logical-models/dim_customer.yml');
      expect(children[1].filePath).toBe('/project/.erd-studio/logical-models/dim_date.yml');
    });
  });

  // -------------------------------------------------------------------------
  // getTreeItem
  // -------------------------------------------------------------------------

  describe('getTreeItem', () => {
    it('renders orphan model with warning icon and (unused) description', () => {
      const node: ModelLibraryNode = {
        type: 'model',
        name: 'dim_date',
        filePath: '/project/.erd-studio/logical-models/dim_date.yml',
        referencingDomains: [],
      };

      const item = provider.getTreeItem(node);
      expect(item.label).toBe('dim_date');
      expect(item.description).toBe('(unused)');
      expect(item.tooltip).toBe('Not referenced by any domain');
      expect((item.iconPath as ThemeIcon).id).toBe('warning');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect(item.contextValue).toBe('logicalModel');
    });

    it('renders referenced model with domain count and tooltip', () => {
      const node: ModelLibraryNode = {
        type: 'model',
        name: 'dim_customer',
        filePath: '/project/.erd-studio/logical-models/dim_customer.yml',
        referencingDomains: ['customer-360', 'reporting'],
      };

      const item = provider.getTreeItem(node);
      expect(item.label).toBe('dim_customer');
      expect(item.description).toBe('2 domains');
      expect((item.iconPath as ThemeIcon).id).toBe('symbol-class');
      expect(item.tooltip).toBeInstanceOf(MarkdownString);
      expect((item.tooltip as MarkdownString).value).toContain('customer-360');
      expect((item.tooltip as MarkdownString).value).toContain('reporting');
    });

    it('renders singular "domain" for single reference', () => {
      const node: ModelLibraryNode = {
        type: 'model',
        name: 'fct_orders',
        filePath: '/project/.erd-studio/logical-models/fct_orders.yml',
        referencingDomains: ['customer-360'],
      };

      const item = provider.getTreeItem(node);
      expect(item.description).toBe('1 domain');
    });

    it('sets click command to open the .yml file', () => {
      const node: ModelLibraryNode = {
        type: 'model',
        name: 'dim_customer',
        filePath: '/project/.erd-studio/logical-models/dim_customer.yml',
        referencingDomains: [],
      };

      const item = provider.getTreeItem(node);
      expect(item.command?.command).toBe('vscode.open');
      expect(item.command?.arguments?.[0]?.fsPath).toContain('dim_customer.yml');
    });
  });

  // -------------------------------------------------------------------------
  // refresh
  // -------------------------------------------------------------------------

  describe('refresh', () => {
    it('fires onDidChangeTreeData event', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      provider.refresh();
      expect(listener).toHaveBeenCalledWith(undefined);
    });
  });
});
