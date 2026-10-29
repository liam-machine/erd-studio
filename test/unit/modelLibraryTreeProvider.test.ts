import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TreeItemCollapsibleState, ThemeIcon, ThemeColor, MarkdownString } from 'vscode';
import type { TableLibraryFolderNode, TableLibraryTableNode } from '../../src/providers/ModelLibraryTreeProvider';
import { TableLibraryTreeProvider, type TableLibraryNode } from '../../src/providers/ModelLibraryTreeProvider';
import type { TableLibraryService, TableFileEntry } from '../../src/services/logicalModelService';
import type { LayerConfig } from '../../src/types/layer';
import type { SubjectAreaService } from '../../src/services/domainService';
import type { SubjectAreaSummary } from '../../src/types/semantic';

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

function createMockTableLibraryService(
  modelNames: string[] = [],
  modelsDir = '/project/.erd-studio/logical-models',
): TableLibraryService {
  return createMockTableLibraryServiceFromEntries(
    modelNames.map(name => ({ name, folder: '', filePath: `${modelsDir}/${name}.yml` })),
    modelsDir,
  );
}

/** A mock backed by explicit file entries (top level and folders). */
function createMockTableLibraryServiceFromEntries(
  entries: TableFileEntry[],
  modelsDir = '/project/.erd-studio/logical-models',
): TableLibraryService {
  return {
    dirExists: vi.fn(() => entries.length > 0),
    getTablesDir: vi.fn(() => modelsDir),
    listTableFiles: vi.fn(() => entries),
    listTableNames: vi.fn(() => entries.filter(e => !e.shadowedBy).map(e => e.name)),
    tablePath: vi.fn((name: string) => entries.find(e => e.name === name && !e.shadowedBy)?.filePath ?? `${modelsDir}/${name}.yml`),
    deleteTable: vi.fn(),
    getTableFileError: vi.fn(() => null),
  } as unknown as TableLibraryService;
}

const DIR = '/project/.erd-studio/logical-models';
const entry = (name: string, folder = '', shadowedBy?: string): TableFileEntry => ({
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

function createMockSubjectAreaService(summaries: SubjectAreaSummary[] = []): SubjectAreaService {
  return {
    listSubjectAreas: vi.fn().mockReturnValue(summaries),
  } as unknown as SubjectAreaService;
}

/** Helper to build a raw v5 domain JSON string. */
function v5SubjectAreaJson(modelNames: string[]): string {
  return JSON.stringify({
    schemaVersion: 5,
    domain: 'test',
    layer: 'silver',
    logical: { models: modelNames, relationships: [] },
    viewConfig: {},
  });
}

/** Helper to build a raw v4 domain JSON string with inline model objects. */
function v4SubjectAreaJson(modelNames: string[]): string {
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

const SUMMARIES: SubjectAreaSummary[] = [
  { domain: 'customer-360', layer: 'silver', filePath: '/project/.erd-studio/silver/customer-360.json' },
  { domain: 'reporting', layer: 'gold', filePath: '/project/.erd-studio/gold/reporting.json' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TableLibraryTreeProvider', () => {
  let provider: TableLibraryTreeProvider;
  let mockTableLibraryService: TableLibraryService;
  let mockSubjectAreaService: SubjectAreaService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTableLibraryService = createMockTableLibraryService(
      ['dim_customer', 'dim_date', 'fct_orders'],
    );
    mockSubjectAreaService = createMockSubjectAreaService(SUMMARIES);

    // Default: customer-360 references dim_customer and fct_orders,
    // reporting references dim_customer only
    mockReadFileSync.mockImplementation((filePath: string) => {
      if (filePath.includes('customer-360')) {
        return v5SubjectAreaJson(['dim_customer', 'fct_orders']);
      }
      if (filePath.includes('reporting')) {
        return v5SubjectAreaJson(['dim_customer']);
      }
      throw new Error(`Unexpected file: ${filePath}`);
    });

    provider = new TableLibraryTreeProvider(
      mockTableLibraryService,
      mockSubjectAreaService,
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
      mockTableLibraryService = createMockTableLibraryService([]);
      provider = new TableLibraryTreeProvider(
        mockTableLibraryService,
        mockSubjectAreaService,
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
          return v4SubjectAreaJson(['dim_customer', 'fct_orders']);
        }
        if (filePath.includes('reporting')) {
          return v4SubjectAreaJson(['dim_customer']);
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
      const node: TableLibraryNode = {
        type: 'model',
        name: 'dim_date',
        filePath: '/project/.erd-studio/logical-models/dim_date.yml',
        referencingDomains: [],
      };

      const item = provider.getTreeItem(node);
      expect(item.label).toBe('dim_date');
      expect(item.description).toBe('(unused)');
      expect(item.tooltip).toBe('Not used in any diagram');
      expect((item.iconPath as ThemeIcon).id).toBe('warning');
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect(item.contextValue).toBe('logicalModel');
    });

    it('renders referenced model with domain count and tooltip', () => {
      const node: TableLibraryNode = {
        type: 'model',
        name: 'dim_customer',
        filePath: '/project/.erd-studio/logical-models/dim_customer.yml',
        referencingDomains: ['customer-360', 'reporting'],
      };

      const item = provider.getTreeItem(node);
      expect(item.label).toBe('dim_customer');
      expect(item.description).toBe('2 diagrams');
      expect((item.iconPath as ThemeIcon).id).toBe('symbol-class');
      expect(item.tooltip).toBeInstanceOf(MarkdownString);
      expect((item.tooltip as MarkdownString).value).toContain('customer-360');
      expect((item.tooltip as MarkdownString).value).toContain('reporting');
    });

    it('renders singular "domain" for single reference', () => {
      const node: TableLibraryNode = {
        type: 'model',
        name: 'fct_orders',
        filePath: '/project/.erd-studio/logical-models/fct_orders.yml',
        referencingDomains: ['customer-360'],
      };

      const item = provider.getTreeItem(node);
      expect(item.description).toBe('1 diagram');
    });

    it('sets click command to open the .yml file', () => {
      const node: TableLibraryNode = {
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
    const build = (entries: TableFileEntry[], layers: LayerConfig[] = LAYERS) => new TableLibraryTreeProvider(
      createMockTableLibraryServiceFromEntries(entries),
      mockSubjectAreaService,
      '/project',
      '.erd-studio',
      () => layers,
    );
    const folders = (nodes: TableLibraryNode[] | undefined) =>
      (nodes ?? []).filter((n): n is TableLibraryFolderNode => n.type === 'folder');

    it('stays a flat list when no folder holds models, even with layers configured', () => {
      const p = build([entry('fct_orders'), entry('dim_customer')]);
      const children = p.getChildren()!;
      expect(children.every(c => c.type === 'model')).toBe(true);
      expect(children.map(c => (c as TableLibraryTableNode).name)).toEqual(['dim_customer', 'fct_orders']);
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
      const p = new TableLibraryTreeProvider(
        createMockTableLibraryServiceFromEntries([entry('a', 'silver'), entry('b', 'gold')]),
        mockSubjectAreaService,
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
      const kids = p.getChildren(silver)! as TableLibraryTableNode[];
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
      expect(item.description).toBe('2 tables');
      expect(item.contextValue).toBe('logicalModelFolder');
      const icon = item.iconPath as ThemeIcon;
      expect(icon.id).toBe('folder');
      expect((icon.color as ThemeColor).id).toBe('erdStudio.layer.silver');
      expect(item.command).toBeUndefined();

      // A configured layer without its own colour uses the custom layer colour,
      // and "1 model" is singular.
      const martsItem = p.getTreeItem(marts);
      expect(martsItem.label).toBe('Data Marts');
      expect(martsItem.description).toBe('1 table');
      expect(((martsItem.iconPath as ThemeIcon).color as ThemeColor).id).toBe('erdStudio.layer.custom');
    });

    it('keeps v6\'s tables/ folders apart from logical-models/ folders, after them (#181)', () => {
      const TDIR = '/project/.erd-studio/tables';
      const v6 = (name: string, folder = ''): TableFileEntry => ({
        name, folder, library: 'tables', filePath: folder ? `${TDIR}/${folder}/${name}.yml` : `${TDIR}/${name}.yml`,
      });
      const provider = build([entry('fct_a', 'gold'), entry('dim_top'), v6('fct_b', 'gold'), v6('dim_c')]);
      const roots = provider.getChildren() as TableLibraryNode[];
      expect(roots.map((n) => (n.type === 'folder' ? `${n.library ?? ''}:${n.folder}` : n.name))).toEqual([':gold', 'tables:', 'tables:gold', 'dim_top']);
      const [v5Gold, v6Top, v6Gold] = roots as TableLibraryFolderNode[];
      expect(v5Gold.children.map((c) => c.name)).toEqual(['fct_a']);
      expect(v6Gold.filePath).toBe(`${TDIR}/gold`);
      expect(v6Gold.children.map((c) => c.name)).toEqual(['fct_b']);
      const top = provider.getTreeItem(v6Top);
      expect(top.label).toBe('tables/');
      expect(top.tooltip).toBe('tables/');
      const gold = provider.getTreeItem(v6Gold);
      expect(gold.label).toBe('Gold');
      expect(gold.description).toBe('1 table · tables/');
      expect(gold.id).not.toBe(provider.getTreeItem(v5Gold).id);
    });

    it('offers Delete on a tables/ file (#182), and no fix on a copy in both libraries, which it names (#181)', () => {
      const t = (name: string, shadowedBy?: string): TableFileEntry => ({
        name, folder: '', library: 'tables', filePath: `/project/.erd-studio/tables/${name}.yml`, ...(shadowedBy ? { shadowedBy } : {}),
      });
      const p = build([entry('dim_a'), t('dim_b'), t('dim_a', `${DIR}/dim_a.yml`)]);
      const [v6Folder] = folders(p.getChildren() as TableLibraryNode[]);
      const items = v6Folder.children.map((c) => p.getTreeItem(c));
      expect(items.map((i) => i.contextValue)).toEqual(['logicalModelReadOnly', 'logicalModel']);
      expect(items[0].description).toBe('(also in logical-models — ignored)');
      expect(items[0].tooltip).toContain('Keep one of the two files');
    });

    it('treats a duplicate within tables/ as an ordinary duplicate, with the fix offered (#182)', () => {
      const V6 = '/project/.erd-studio/tables';
      const p = build([
        { name: 'dim_a', folder: '', library: 'tables', filePath: `${V6}/dim_a.yml` },
        { name: 'dim_a', folder: 'gold', library: 'tables', filePath: `${V6}/gold/dim_a.yml`, shadowedBy: `${V6}/dim_a.yml` },
      ]);
      const gold = folders(p.getChildren() as TableLibraryNode[]).find((f) => f.folder === 'gold')!;
      const item = p.getTreeItem(gold.children[0]);
      expect(item.contextValue).toBe('logicalModelDuplicate');
      expect(item.description).toBe('(duplicate — ignored)');
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
      const dupe = (p.getChildren(silver) as TableLibraryTableNode[]).find(k => k.name === 'dim_customer')!;
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
      const top = (p.getChildren()!).find(c => c.type === 'model' && c.name === 'dim_customer') as TableLibraryTableNode;
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

describe('TableLibraryTreeProvider: a model file that needs fixing (#164)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileSync.mockImplementation(() => v5SubjectAreaJson(['dim_customer', 'fct_orders']));
  });

  function providerWith(errors: Record<string, Partial<import('../../src/services/logicalModelService').TableFileError>>) {
    const service = createMockTableLibraryService(['dim_customer', 'fct_orders']);
    (service.getTableFileError as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      errors[name] ? { name, filePath: `${DIR}/${name}.yml`, message: '', ...errors[name] } : null);
    return new TableLibraryTreeProvider(service, createMockSubjectAreaService(SUMMARIES), '/project', '.erd-studio');
  }

  function itemFor(provider: TableLibraryTreeProvider, name: string) {
    const node = (provider.getChildren() as TableLibraryTableNode[]).find((n) => n.name === name)!;
    return provider.getTreeItem(node);
  }

  it('marks a key written twice with the key and line, and opens the file at that line', () => {
    const provider = providerWith({ dim_customer: { kind: 'yamlDuplicateKey', line: 14, readable: true, key: 'description' } });
    const item = itemFor(provider, 'dim_customer');
    expect((item.iconPath as ThemeIcon).id).toBe('warning');
    expect(item.description).toBe('("description" written twice — line 14)');
    expect(String(item.tooltip)).toContain('uses the last one');
    expect(item.contextValue).toBe('logicalModel');
    const [, options] = item.command!.arguments as [unknown, { selection: { start: { line: number } } }];
    expect(options.selection.start.line).toBe(13);
  });

  it('marks a file that cannot be read with an error icon', () => {
    const provider = providerWith({ dim_customer: { kind: 'yamlScalar', line: 4 } });
    const item = itemFor(provider, 'dim_customer');
    expect((item.iconPath as ThemeIcon).id).toBe('error');
    expect(item.description).toBe('(YAML error — line 4)');
  });

  it('calls a .dbml table file\'s error a DBML error, and keeps the YAML and unreadable wording', () => {
    const provider = providerWith({
      dim_customer: { kind: 'dbmlSyntax', line: 3, filePath: `${DIR}/dim_customer.dbml` },
      fct_orders: { kind: 'dbmlStructure', code: 'structure:notOneTable', filePath: `${DIR}/fct_orders.dbml` },
    });
    const item = itemFor(provider, 'dim_customer');
    expect((item.iconPath as ThemeIcon).id).toBe('error');
    expect(item.description).toBe('(DBML error — line 3)');
    expect(itemFor(provider, 'fct_orders').description).toBe('(DBML error)');
    expect(itemFor(providerWith({ dim_customer: { kind: 'yamlIndent', line: 3 } }), 'dim_customer').description).toBe('(YAML error — line 3)');
    expect(itemFor(providerWith({ dim_customer: { kind: 'read' } }), 'dim_customer').description).toBe('(can\'t be read)');
  });

  it('leaves a clean file as it was', () => {
    const provider = providerWith({ dim_customer: { kind: 'yamlScalar', line: 4 } });
    const item = itemFor(provider, 'fct_orders');
    expect((item.iconPath as ThemeIcon).id).toBe('symbol-class');
    expect(item.description).toBe('2 diagrams');
  });
});


describe('TableLibraryTreeProvider: native DBML storage (§5.5)', () => {
  const TABLES = '/project/.erd-studio/tables';
  const dbmlEntry = (name: string, folder = ''): TableFileEntry => ({
    name, folder, filePath: folder ? `${TABLES}/${folder}/${name}.dbml` : `${TABLES}/${name}.dbml`, storage: 'dbml', library: 'tables',
  });
  const SALES: SubjectAreaSummary = { domain: 'sales', layer: 'gold', filePath: '/project/.erd-studio/gold/sales.dbml', storage: 'dbml' };

  function providerFor(entries: TableFileEntry[], storage: 'yaml' | 'dbml' | 'mixed') {
    const service = createMockTableLibraryServiceFromEntries(entries, '/project/.erd-studio/logical-models');
    (service as unknown as { projectStorage: () => string }).projectStorage = () => storage;
    return new TableLibraryTreeProvider(service, createMockSubjectAreaService([SALES]), '/project', '.erd-studio');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileSync.mockImplementation((p: string) => (String(p).endsWith('.dbml')
      ? "Project sales {\n  erd_schema_version: '7'\n}\n\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\n"
      : '{}'));
  });

  function tableNodes(provider: TableLibraryTreeProvider): TableLibraryTableNode[] {
    return (provider.getChildren() as TableLibraryNode[]).flatMap((n) => (n.type === 'folder' ? n.children : [n]));
  }

  it('opens a .dbml table in the text editor (openWith … default), never the canvas', () => {
    const provider = providerFor([dbmlEntry('fct_order', 'gold')], 'dbml');
    const item = provider.getTreeItem(tableNodes(provider).find((n) => n.name === 'fct_order')!);
    expect(item.command?.command).toBe('vscode.openWith');
    expect(item.command?.arguments?.[1]).toBe('default');
  });

  it('counts a DBML diagram\'s use lines as usage', () => {
    const provider = providerFor([dbmlEntry('fct_order', 'gold'), dbmlEntry('dim_date')], 'dbml');
    const nodes = tableNodes(provider);
    expect(nodes.find((n) => n.name === 'fct_order')?.referencingDomains).toEqual(['sales']);
    expect(nodes.find((n) => n.name === 'dim_date')?.referencingDomains).toEqual([]);
  });

  it('names each table\'s format only while the project is mixed', () => {
    const yml: TableFileEntry = { name: 'dim_old', folder: '', filePath: `${DIR}/dim_old.yml`, storage: 'yaml' };
    const mixed = providerFor([dbmlEntry('fct_order', 'gold'), yml], 'mixed');
    const items = tableNodes(mixed).map((n) => mixed.getTreeItem(n));
    expect(items.find((i) => i.label === 'fct_order')?.description).toBe('1 diagram · DBML');
    expect(items.find((i) => i.label === 'dim_old')?.description).toBe('(unused) · YAML');
    expect(items.find((i) => i.label === 'dim_old')?.command?.command).toBe('vscode.open');

    const dbml = providerFor([dbmlEntry('fct_order', 'gold')], 'dbml');
    expect(dbml.getTreeItem(tableNodes(dbml)[0]).description).toBe('1 diagram');
  });

  it('lists a flat DBML library as the library itself, never as a "tables/" folder', () => {
    const provider = providerFor([dbmlEntry('fct_order'), dbmlEntry('dim_date')], 'dbml');
    const roots = provider.getChildren() as TableLibraryNode[];
    expect(roots.map((n) => n.type)).toEqual(['model', 'model']);
    expect(roots.map((n) => (n as TableLibraryTableNode).name)).toEqual(['dim_date', 'fct_order']);
  });

  it('shows a foldered DBML library\'s folders by layer, with the real tables/ path in the tooltip', () => {
    const provider = new TableLibraryTreeProvider(
      createMockTableLibraryServiceFromEntries([dbmlEntry('fct_order', 'gold'), dbmlEntry('dim_date')]),
      createMockSubjectAreaService([SALES]),
      '/project',
      '.erd-studio',
      () => LAYERS,
    );
    const roots = provider.getChildren() as TableLibraryNode[];
    expect(roots.map((n) => (n.type === 'folder' ? `folder:${n.folder}` : n.name))).toEqual(['folder:gold', 'dim_date']);
    const gold = roots[0] as TableLibraryFolderNode;
    expect(gold.filePath).toBe(`${TABLES}/gold`);
    const item = provider.getTreeItem(gold);
    expect(item.label).toBe('Gold');
    // The only library: no "· tables/" tag, and never "logical-models/" in the tooltip.
    expect(item.description).toBe('1 table');
    expect(item.tooltip).toBe('tables/gold/ — tables created in Gold diagrams');
  });
});
