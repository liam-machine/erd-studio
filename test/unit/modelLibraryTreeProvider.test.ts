import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TreeItemCollapsibleState, ThemeIcon, ThemeColor, MarkdownString } from 'vscode';
import type { ModelLibraryFolderNode, ModelLibraryModelNode } from '../../src/providers/ModelLibraryTreeProvider';
import { ModelLibraryTreeProvider, type ModelLibraryNode } from '../../src/providers/ModelLibraryTreeProvider';
import type { LogicalModelService, ModelFileEntry } from '../../src/services/logicalModelService';
import type { LayerConfig } from '../../src/types/layer';
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
  return createMockLogicalModelServiceFromEntries(
    modelNames.map(name => ({ name, folder: '', filePath: `${modelsDir}/${name}.yml` })),
    modelsDir,
  );
}

/** A mock backed by explicit file entries (top level and folders). */
function createMockLogicalModelServiceFromEntries(
  entries: ModelFileEntry[],
  modelsDir = '/project/.erd-studio/logical-models',
): LogicalModelService {
  return {
    dirExists: vi.fn(() => entries.length > 0),
    getModelsDir: vi.fn(() => modelsDir),
    listModelFiles: vi.fn(() => entries),
    listModelNames: vi.fn(() => entries.filter(e => !e.shadowedBy).map(e => e.name)),
    modelPath: vi.fn((name: string) => entries.find(e => e.name === name && !e.shadowedBy)?.filePath ?? `${modelsDir}/${name}.yml`),
    deleteModel: vi.fn(),
  } as unknown as LogicalModelService;
}

const DIR = '/project/.erd-studio/logical-models';
const entry = (name: string, folder = '', shadowedBy?: string): ModelFileEntry => ({
  name,
  folder,
  filePath: folder ? `${DIR}/${folder}/${name}.yml` : `${DIR}/${name}.yml`,
  ...(shadowedBy ? { shadowedBy } : {}),
});

const LAYERS: LayerConfig[] = [
  { id: 'bronze', label: 'Bronze', abbreviation: 'B' },
  { id: 'silver', label: 'Silver', abbreviation: 'S' },
  { id: 'gold', label: 'Gold', abbreviation: 'G' },
  { id: 'marts', label: 'Data Marts', abbreviation: 'M' },
] as LayerConfig[];

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
  // Layer folders (issue #76)
  // -------------------------------------------------------------------------

  describe('layer folders', () => {
    const build = (entries: ModelFileEntry[], layers: LayerConfig[] = LAYERS) => new ModelLibraryTreeProvider(
      createMockLogicalModelServiceFromEntries(entries),
      mockDomainService,
      '/project',
      '.erd-studio',
      () => layers,
    );
    const folders = (nodes: ModelLibraryNode[] | undefined) =>
      (nodes ?? []).filter((n): n is ModelLibraryFolderNode => n.type === 'folder');

    it('stays a flat list when no folder holds models, even with layers configured', () => {
      const p = build([entry('fct_orders'), entry('dim_customer')]);
      const children = p.getChildren()!;
      expect(children.every(c => c.type === 'model')).toBe(true);
      expect(children.map(c => (c as ModelLibraryModelNode).name)).toEqual(['dim_customer', 'fct_orders']);
    });

    it('groups models by folder, folders first then top-level models', () => {
      const p = build([
        entry('zz_top'),
        entry('aa_top'),
        entry('dim_customer', 'silver'),
        entry('fct_orders', 'silver'),
        entry('rpt_sales', 'gold'),
      ]);
      const children = p.getChildren()!;
      expect(children.map(c => c.type === 'folder' ? `folder:${c.folder}` : c.name)).toEqual([
        'folder:silver',
        'folder:gold',
        'aa_top',
        'zz_top',
      ]);
    });

    it('orders folders by layers.json order, not alphabetically', () => {
      const p = build([
        entry('a', 'gold'),
        entry('b', 'bronze'),
        entry('c', 'silver'),
        entry('d', 'marts'),
      ]);
      expect(folders(p.getChildren()).map(f => f.folder)).toEqual(['bronze', 'silver', 'gold', 'marts']);
    });

    it('sorts folders unknown to layers.json after the known ones, alphabetically', () => {
      const p = build([
        entry('a', 'zeta'),
        entry('b', 'gold'),
        entry('c', 'alpha'),
        entry('d', 'bronze'),
      ]);
      expect(folders(p.getChildren()).map(f => f.folder)).toEqual(['bronze', 'gold', 'alpha', 'zeta']);
    });

    it('sorts folders alphabetically when no layers are supplied (default getLayers)', () => {
      const p = new ModelLibraryTreeProvider(
        createMockLogicalModelServiceFromEntries([entry('a', 'silver'), entry('b', 'gold')]),
        mockDomainService,
        '/project',
        '.erd-studio',
      );
      expect(folders(p.getChildren()).map(f => f.folder)).toEqual(['gold', 'silver']);
    });

    it('getChildren(folder) returns the folder\'s models sorted, with usage and file paths', () => {
      const p = build([
        entry('fct_orders', 'silver'),
        entry('dim_customer', 'silver'),
        entry('dim_date', 'gold'),
      ]);
      const silver = folders(p.getChildren()).find(f => f.folder === 'silver')!;
      expect(silver.filePath).toBe(`${DIR}/silver`);
      const kids = p.getChildren(silver)! as ModelLibraryModelNode[];
      expect(kids.map(k => k.name)).toEqual(['dim_customer', 'fct_orders']);
      expect(kids[0].filePath).toBe(`${DIR}/silver/dim_customer.yml`);
      expect(kids[0].folder).toBe('silver');
      expect(kids[0].referencingDomains).toEqual(['customer-360', 'reporting']);
      expect(kids[1].referencingDomains).toEqual(['customer-360']);
      // A model node inside a folder is a leaf.
      expect(p.getChildren(kids[0])).toBeUndefined();
    });

    it('renders a folder as an expanded item labelled with the layer, a model count and a layer-coloured folder icon', () => {
      const p = build([entry('a', 'silver'), entry('b', 'silver'), entry('c', 'marts')]);
      const [silver, marts] = folders(p.getChildren());

      const item = p.getTreeItem(silver);
      expect(item.label).toBe('Silver');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
      expect(item.description).toBe('2 models');
      expect(item.contextValue).toBe('logicalModelFolder');
      const icon = item.iconPath as ThemeIcon;
      expect(icon.id).toBe('folder');
      expect((icon.color as ThemeColor).id).toBe('erdStudio.layer.silver');
      expect(item.command).toBeUndefined();

      // A configured layer without its own colour uses the custom layer colour,
      // and "1 model" is singular.
      const martsItem = p.getTreeItem(marts);
      expect(martsItem.label).toBe('Data Marts');
      expect(martsItem.description).toBe('1 model');
      expect(((martsItem.iconPath as ThemeIcon).color as ThemeColor).id).toBe('erdStudio.layer.custom');
    });

    it('renders a folder unknown to layers.json with its folder name and an uncoloured icon', () => {
      const p = build([entry('a', 'scratch')]);
      const [scratch] = folders(p.getChildren());
      const item = p.getTreeItem(scratch);
      expect(item.label).toBe('scratch');
      expect((item.iconPath as ThemeIcon).id).toBe('folder');
      expect((item.iconPath as ThemeIcon).color).toBeUndefined();
      expect(item.tooltip).toBe('logical-models/scratch/');
    });

    it('a built-in layer folder is coloured even when layers.json does not list it', () => {
      const p = build([entry('a', 'gold')], []);
      const item = p.getTreeItem(folders(p.getChildren())[0]);
      expect(item.label).toBe('gold');
      expect(((item.iconPath as ThemeIcon).color as ThemeColor).id).toBe('erdStudio.layer.gold');
    });

    it('shows a shadowed duplicate with an error icon, no usage, and a context value Delete Model does not match', () => {
      const winner = `${DIR}/dim_customer.yml`;
      const p = build([
        entry('dim_customer'),
        entry('dim_customer', 'silver', winner),
        entry('fct_orders', 'silver'),
      ]);
      const silver = folders(p.getChildren()).find(f => f.folder === 'silver')!;
      const dupe = (p.getChildren(silver) as ModelLibraryModelNode[]).find(k => k.name === 'dim_customer')!;
      expect(dupe.shadowedBy).toBe(winner);
      expect(dupe.referencingDomains).toEqual([]);

      const item = p.getTreeItem(dupe);
      expect(item.contextValue).toBe('logicalModelDuplicate');
      expect((item.iconPath as ThemeIcon).id).toBe('error');
      expect(item.description).toBe('(duplicate — ignored)');
      expect(String(item.tooltip)).toContain(winner);
      // Clicking opens the duplicate itself, so the user can fix it.
      expect(item.command?.command).toBe('vscode.open');
      expect(item.command?.arguments?.[0]?.fsPath).toBe(`${DIR}/silver/dim_customer.yml`);

      // The winning top-level copy keeps its usage and normal rendering.
      const top = (p.getChildren()!).find(c => c.type === 'model' && c.name === 'dim_customer') as ModelLibraryModelNode;
      expect(top.shadowedBy).toBeUndefined();
      expect(top.referencingDomains).toEqual(['customer-360', 'reporting']);
      expect(p.getTreeItem(top).contextValue).toBe('logicalModel');
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
