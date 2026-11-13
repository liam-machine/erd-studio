import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TreeItemCollapsibleState, ThemeIcon, ThemeColor, MarkdownString, Uri as vscodeUri } from 'vscode';
import { dbmlFileIcon, type DbmlFileIconResolver } from '../../src/providers/dbmlFileKinds';
import type { TableLibraryFolderNode, TableLibraryLayerNode, TableLibraryTableNode } from '../../src/providers/ModelLibraryTreeProvider';
import { COLLAPSE_LAYERS_OVER, TABLE_CLICK_TOOLTIP, TableLibraryTreeProvider, tableRowContext, type TableLibraryNode } from '../../src/providers/ModelLibraryTreeProvider';
import type { TableLibraryService, TableFileEntry } from '../../src/services/logicalModelService';
import type { LayerConfig } from '../../src/types/layer';
import type { SubjectAreaService } from '../../src/services/domainService';
import type { SubjectAreaSummary } from '../../src/types/semantic';

/**
 * The tests here check the full rows (`erdStudio.sidebar.rowDetails: full`,
 * today's text); the compact rows have tests of their own.
 */
function fullRows<T extends { setRowDetails(mode: 'compact' | 'full'): void }>(provider: T): T {
  provider.setRowDetails('full');
  return provider;
}

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

/** Every table row under `nodes`, at any depth (a DBML layer holds schema folders, or its tables directly). */
function allTables(nodes: readonly TableLibraryNode[] | undefined): TableLibraryTableNode[] {
  return (nodes ?? []).flatMap((n) => (n.type === 'model' ? [n] : allTables(n.children)));
}

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

    provider = fullRows(new TableLibraryTreeProvider(
      mockTableLibraryService,
      mockSubjectAreaService,
      '/project',
      '.erd-studio',
    ));
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
      provider = fullRows(new TableLibraryTreeProvider(
        mockTableLibraryService,
        mockSubjectAreaService,
        '/project',
        '.erd-studio',
      ));
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
    it('says a YAML table on no diagram is on none, with no warning, as a DBML one', () => {
      const node: TableLibraryNode = {
        type: 'model',
        name: 'dim_date',
        filePath: '/project/.erd-studio/logical-models/dim_date.yml',
        referencingDomains: [],
      };

      const item = provider.getTreeItem(node);
      expect(item.label).toBe('dim_date');
      expect(item.description).toBe('on no diagram');
      expect((item.tooltip as MarkdownString).value).toContain('On no diagram yet');
      // A screen reader hears the table's name, not only the tooltip.
      expect(item.accessibilityInformation).toEqual({ label: 'dim_date, not used in any diagram' });
      expect((item.iconPath as ThemeIcon).id).toBe('symbol-class');
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
      expect(item.description).toBe('on 2 diagrams');
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
      expect(item.description).toBe('on 1 diagram');
    });

    it('a click shows the table on a diagram (the file when none shows it), and a double-click opens the .yml file', () => {
      const node: TableLibraryNode = {
        type: 'model',
        name: 'dim_customer',
        filePath: '/project/.erd-studio/logical-models/dim_customer.yml',
        referencingDomains: [],
      };

      const item = provider.getTreeItem(node);
      expect(item.command).toMatchObject({ command: 'erdStudio.openInDiagram', arguments: [node, { fallBackToFile: true, rowClick: true }] });
      expect(item.resourceUri?.fsPath).toContain('dim_customer.yml');
      expect(String((item.tooltip as MarkdownString).value)).toContain(TABLE_CLICK_TOOLTIP);
      // The glass sidebar's double-click: the file, the code.
      expect(provider.secondaryCommand(node)).toEqual({ command: 'erdStudio.openTableFile', title: 'Open File', arguments: [node, { doubleClick: true }] });
      expect(item.contextValue).toBe('logicalModel');
      // Two diagrams show it: its menu offers Show on Another Diagram… (row value).
      expect(provider.getTreeItem({ ...node, referencingDomains: ['a', 'b'] }).contextValue).toBe('logicalModelOnSeveral');
      expect(tableRowContext({ referencingDomains: ['a'] })).toBe('logicalModel');
      expect(tableRowContext({ referencingDomains: ['a', 'b'], fileError: { kind: 'yamlScalar' } })).toBe('logicalModelBroken');
    });
  });

  // -------------------------------------------------------------------------
  // Layer folders (issue #76)
  // -------------------------------------------------------------------------

  describe('layer folders', () => {
    const build = (entries: TableFileEntry[], layers: LayerConfig[] = LAYERS) => fullRows(new TableLibraryTreeProvider(
      createMockTableLibraryServiceFromEntries(entries),
      mockSubjectAreaService,
      '/project',
      '.erd-studio',
      () => layers,
    ));
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
      const p = fullRows(new TableLibraryTreeProvider(
        createMockTableLibraryServiceFromEntries([entry('a', 'silver'), entry('b', 'gold')]),
        mockSubjectAreaService,
        '/project',
        '.erd-studio',
      ));
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
      // The folder on disk, then (what a compact row leaves out) how many tables it holds.
      expect(top.tooltip).toBe('tables/\n1 table');
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

    it('reports a DBML copy of a YAML table (part-way through Convert) with no fix; a DBML copy of a DBML table is an ordinary duplicate', () => {
      const GOLD = '/project/.erd-studio/gold/tables/gold';
      const SALES = '/project/.erd-studio/gold/tables/sales';
      const p = build([
        entry('dim_a'),
        { name: 'dim_a', folder: 'gold', layer: 'gold', storage: 'dbml', filePath: `${GOLD}/dim_a.dbml`, shadowedBy: `${DIR}/dim_a.yml` },
        { name: 'dim_b', folder: 'gold', layer: 'gold', storage: 'dbml', filePath: `${GOLD}/dim_b.dbml` },
        { name: 'dim_b', folder: 'sales', layer: 'gold', storage: 'dbml', filePath: `${SALES}/dim_b.dbml`, shadowedBy: `${GOLD}/dim_b.dbml` },
      ]);
      const items = allTables(p.getChildren() as TableLibraryNode[]).map((c) => p.getTreeItem(c));
      const byPath = (file: string) => items.find((i) => (i.resourceUri as { fsPath: string }).fsPath === file)!;
      expect(byPath(`${GOLD}/dim_a.dbml`).contextValue).toBe('logicalModelReadOnly');
      expect(byPath(`${GOLD}/dim_a.dbml`).description).toBe('(also in logical-models — ignored)');
      expect(byPath(`${GOLD}/dim_a.dbml`).tooltip).toContain('This DBML copy is ignored. Keep one of the two files.');
      expect(byPath(`${SALES}/dim_b.dbml`).contextValue).toBe('logicalModelDuplicate');
    });

    it('a duplicate\'s tooltip names the name Give Duplicate Table Its Own Name offers: its layer for a DBML copy, its folder for a YAML one', () => {
      const SILVER = '/project/.erd-studio/silver/tables/crm';
      const SALES = '/project/.erd-studio/gold/tables/sales';
      const p = build([
        { name: 'dim_c', folder: 'crm', layer: 'silver', storage: 'dbml', filePath: `${SILVER}/dim_c.dbml` },
        { name: 'dim_c', folder: 'sales', layer: 'gold', storage: 'dbml', filePath: `${SALES}/dim_c.dbml`, shadowedBy: `${SILVER}/dim_c.dbml` },
        entry('dim_y'),
        entry('dim_y', 'silver', `${DIR}/dim_y.yml`),
      ]);
      const items = allTables(p.getChildren() as TableLibraryNode[]).map((c) => p.getTreeItem(c));
      const byPath = (file: string) => items.find((i) => (i.resourceUri as { fsPath: string }).fsPath === file)!;
      const dbmlTip = String(byPath(`${SALES}/dim_c.dbml`).tooltip);
      expect(dbmlTip).toContain('to make this copy "gold_dim_c"');
      expect(dbmlTip).not.toContain('sales_dim_c');
      expect(String(byPath(`${DIR}/silver/dim_y.yml`).tooltip)).toContain('to make this copy "silver_dim_y"');
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
      expect(item.tooltip).toBe('logical-models/scratch/\n1 table');
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
      expect(item.accessibilityInformation).toEqual({ label: 'dim_customer, duplicate, ignored' });
      expect(String(item.tooltip)).toContain(winner);
      // Clicking opens the duplicate itself, so the user can fix it.
      expect(item.command?.command).toBe('vscode.open');
      expect(item.command?.arguments?.[0]?.fsPath).toBe(`${DIR}/silver/dim_customer.yml`);

      // The winning top-level copy keeps its usage and normal rendering.
      const top = (p.getChildren()!).find(c => c.type === 'model' && c.name === 'dim_customer') as TableLibraryTableNode;
      expect(top.shadowedBy).toBeUndefined();
      expect(top.referencingDomains).toEqual(['customer-360', 'reporting']);
      // On two diagrams: the row value that offers Show on Another Diagram….
      expect(p.getTreeItem(top).contextValue).toBe('logicalModelOnSeveral');
      // A duplicate's click opens its file already: no double-click of its own.
      expect(p.secondaryCommand(dupe)).toBeUndefined();
    });

    it('a duplicate\'s tooltip names dbt only in a dbt project', () => {
      const entries = [entry('dim_customer'), entry('dim_customer', 'silver', `${DIR}/dim_customer.yml`)];
      const tip = (hasDbt: boolean): string => {
        const p = build(entries);
        p.setHasDbtProject(hasDbt);
        const silver = folders(p.getChildren()).find(f => f.folder === 'silver')!;
        return String(p.getTreeItem((p.getChildren(silver) as TableLibraryTableNode[])[0]).tooltip);
      };
      expect(tip(true)).toContain('A schema holds one table of a name, and a YAML table\'s name is one in the project, as dbt builds one model of a name. Use "Give Duplicate Table Its Own Name"');
      const plain = tip(false);
      expect(plain).toContain('A schema holds one table of a name, and a YAML table\'s name is one in the project. Use "Give Duplicate Table Its Own Name" to make this copy "silver_dim_customer"');
      expect(plain).not.toMatch(/dbt/i);
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
    return fullRows(new TableLibraryTreeProvider(service, createMockSubjectAreaService(SUMMARIES), '/project', '.erd-studio'));
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
    // Its click opens the file at the line (where the fix is), so its menu has Open in Diagram…, not Open File.
    expect(item.contextValue).toBe('logicalModelBroken');
    expect(item.command?.command).toBe('vscode.open');
    const [, options] = item.command!.arguments as [unknown, { selection: { start: { line: number } } }];
    expect(options.selection.start.line).toBe(13);
    const node = (provider.getChildren() as TableLibraryTableNode[]).find((n) => n.name === 'dim_customer')!;
    expect(provider.secondaryCommand(node)).toBeUndefined();
  });

  it('marks a file that cannot be read with an error icon', () => {
    const provider = providerWith({ dim_customer: { kind: 'yamlScalar', line: 4 } });
    const item = itemFor(provider, 'dim_customer');
    expect((item.iconPath as ThemeIcon).id).toBe('error');
    expect(item.description).toBe('(YAML error — line 4)');
    expect(item.accessibilityInformation).toEqual({ label: 'dim_customer, YAML error — line 4' });
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
    expect(item.description).toBe('on 2 diagrams');
  });
});


describe('TableLibraryTreeProvider: native DBML storage, the layer-first tree (§5.5)', () => {
  const SEMANTIC = '/project/.erd-studio';
  const dbmlEntry = (name: string, layer = 'gold', schema = layer): TableFileEntry => ({
    name, folder: schema, layer, filePath: `${SEMANTIC}/${layer}/tables/${schema}/${name}.dbml`, storage: 'dbml',
  });
  const SALES: SubjectAreaSummary = { domain: 'sales', layer: 'gold', filePath: `${SEMANTIC}/gold/diagrams/sales.dbml`, storage: 'dbml' };

  function providerFor(
    entries: TableFileEntry[],
    storage: 'yaml' | 'dbml' | 'mixed',
    layers: () => LayerConfig[] = () => [],
    icons?: DbmlFileIconResolver,
    errors: Record<string, Partial<import('../../src/services/logicalModelService').TableFileError>> = {},
  ) {
    const service = createMockTableLibraryServiceFromEntries(entries, `${SEMANTIC}/logical-models`);
    (service as unknown as { projectStorage: () => string }).projectStorage = () => storage;
    (service.getTableFileError as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      errors[name] ? { name, filePath: `${SEMANTIC}/gold/tables/gold/${name}.dbml`, message: '', ...errors[name] } : null);
    return fullRows(new TableLibraryTreeProvider(service, createMockSubjectAreaService([SALES]), '/project', '.erd-studio', layers, undefined, icons));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileSync.mockImplementation((p: string) => (String(p).endsWith('.dbml')
      ? "use { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nProject sales {\n  erd_schema_version: '7'\n}\n"
      : '{}'));
  });

  function tableNodes(provider: TableLibraryTreeProvider): TableLibraryTableNode[] {
    return allTables(provider.getChildren() as TableLibraryNode[]);
  }

  it('a .dbml table\'s click goes to the diagram; its double-click and Open File open the file (plain vscode.open: the canvas selector never matches a table)', () => {
    const provider = providerFor([dbmlEntry('fct_order')], 'dbml');
    const node = tableNodes(provider).find((n) => n.name === 'fct_order')!;
    const item = provider.getTreeItem(node);
    expect(item.command?.command).toBe('erdStudio.openInDiagram');
    expect(item.resourceUri?.fsPath).toBe(`${SEMANTIC}/gold/tables/gold/fct_order.dbml`);
    expect(provider.secondaryCommand(node)?.command).toBe('erdStudio.openTableFile');
    expect(String((item.tooltip as MarkdownString).value)).toContain('Double-click to open its file.');
  });

  it('counts a DBML diagram\'s use lines as usage', () => {
    const provider = providerFor([dbmlEntry('fct_order'), dbmlEntry('dim_date', 'silver', 'calendar')], 'dbml');
    const nodes = tableNodes(provider);
    expect(nodes.find((n) => n.name === 'fct_order')?.referencingDomains).toEqual(['sales']);
    expect(nodes.find((n) => n.name === 'dim_date')?.referencingDomains).toEqual([]);
  });

  it('names each table\'s format only while the project is mixed', () => {
    const yml: TableFileEntry = { name: 'dim_old', folder: '', filePath: `${DIR}/dim_old.yml`, storage: 'yaml' };
    const mixed = providerFor([dbmlEntry('fct_order'), yml], 'mixed');
    const items = tableNodes(mixed).map((n) => mixed.getTreeItem(n));
    expect(items.find((i) => i.label === 'fct_order')?.description).toBe('on 1 diagram · DBML');
    expect(items.find((i) => i.label === 'dim_old')?.description).toBe('on no diagram · YAML');
    expect(items.find((i) => i.label === 'dim_old')?.command?.command).toBe('erdStudio.openInDiagram');

    const dbml = providerFor([dbmlEntry('fct_order')], 'dbml');
    expect(dbml.getTreeItem(tableNodes(dbml)[0]).description).toBe('on 1 diagram');
  });

  it('says a DBML table on no diagram is on none, with no warning (a staging table often is not drawn)', () => {
    const provider = providerFor([dbmlEntry('fct_order'), dbmlEntry('stg_order', 'gold')], 'dbml');
    const item = provider.getTreeItem(tableNodes(provider).find((n) => n.name === 'stg_order')!);
    expect(item.description).toBe('on no diagram');
    expect((item.iconPath as ThemeIcon).id).toBe('symbol-class');
    expect(String((item.tooltip as MarkdownString).value)).toContain('On no diagram yet');
  });

  it('names a read table\'s warehouse name (alias) and where it lives', () => {
    const provider = providerFor([dbmlEntry('gold_orders', 'gold', 'sales')], 'dbml', () => LAYERS);
    const service = (provider as unknown as { tableLibraryService: Record<string, unknown> }).tableLibraryService;
    service.peekTableFileError = () => null;
    service.peekTableSummary = () => ({ alias: 'orders' });
    // A render answers from the cached reading: never a read, copy or relationships attach.
    service.getTable = vi.fn();
    const item = provider.getTreeItem(tableNodes(provider)[0]);
    expect(item.description).toBe('as orders · on no diagram');
    expect(service.getTable).not.toHaveBeenCalled();
    const tip = String((item.tooltip as MarkdownString).value);
    expect(tip).toContain('**sales.gold_orders** — the warehouse table `orders`');
    expect(tip).toContain('Layer **Gold** · schema **sales**');
    expect(tip).toContain('File: `.erd-studio/gold/tables/sales/gold_orders.dbml`');
  });

  it('groups DBML tables as their files are: layer, then schema, then table, layers in layers.json order', () => {
    const provider = providerFor(
      [dbmlEntry('fct_order'), dbmlEntry('dim_customer'), dbmlEntry('dim_date', 'silver', 'calendar'), dbmlEntry('dim_time', 'silver', 'clock'), dbmlEntry('afih', 'bronze', 'sap')],
      'dbml',
      () => LAYERS,
    );
    const roots = provider.getChildren() as TableLibraryNode[];
    expect(roots.every((n) => n.type === 'layer')).toBe(true);
    const layers = roots as TableLibraryLayerNode[];
    expect(layers.map((l) => l.layer)).toEqual(['bronze', 'silver', 'gold']);

    // A layer with schemas of their own: a row per schema, each saying "Schema".
    const silver = layers[1];
    expect(silver.filePath).toBe(`${SEMANTIC}/silver/tables`);
    expect((silver.children as TableLibraryFolderNode[]).map((f) => f.folder)).toEqual(['calendar', 'clock']);
    const silverItem = provider.getTreeItem(silver);
    expect(silverItem.label).toBe('Silver');
    expect(silverItem.description).toBe('Layer · 2 schemas · 2 tables');
    expect(silverItem.id).toBe('erdStudio.modelLibrary.layer:silver');
    const calendar = provider.getTreeItem(silver.children[0]);
    expect(calendar.label).toBe('calendar');
    expect(calendar.description).toBe('Schema · 1 table');
    expect(calendar.id).toBe('erdStudio.modelLibrary.folder:silver/tables/calendar');
    expect(String((calendar.tooltip as MarkdownString).value)).toContain('`.erd-studio/silver/tables/calendar/`');

    // A layer whose one schema has its own name lists its tables directly, and names the schema.
    const gold = layers[2];
    expect(gold.soleSchema).toBe('gold');
    expect((gold.children as TableLibraryTableNode[]).map((c) => c.name)).toEqual(['dim_customer', 'fct_order']);
    expect(provider.getTreeItem(gold).description).toBe('Layer · 2 tables');
    expect(String((provider.getTreeItem(gold).tooltip as MarkdownString).value)).toContain('Every table is in the schema `gold`');

    // A layer missing from layers.json still gets its row, after the configured ones.
    const extra = providerFor([dbmlEntry('x', 'zeta', 'z'), dbmlEntry('fct_order')], 'dbml', () => LAYERS);
    expect((extra.getChildren() as TableLibraryLayerNode[]).map((l) => l.layer)).toEqual(['gold', 'zeta']);
  });

  describe('table icons', () => {
    const EXTENSION = vscodeUri.file('/ext');
    const icons: DbmlFileIconResolver = (kind) => dbmlFileIcon(EXTENSION, kind);
    const itemOf = (provider: TableLibraryTreeProvider, name: string, folder?: string) =>
      provider.getTreeItem(tableNodes(provider).find((n) => n.name === name && (folder === undefined || n.folder === folder))!);
    const codicon = (item: { iconPath?: unknown }) => (item.iconPath as ThemeIcon).id;

    it('gives a healthy DBML table the DBML Table icon pair from media/file-icons, with the resourceUri it always had', () => {
      const provider = providerFor([dbmlEntry('fct_order')], 'dbml', () => [], icons);
      const item = itemOf(provider, 'fct_order');
      expect(item.iconPath).toBe(dbmlFileIcon(EXTENSION, 'table'));
      const { light, dark } = item.iconPath as { light: { fsPath: string }; dark: { fsPath: string } };
      expect(light.fsPath).toBe('/ext/media/file-icons/dbml-table-light.svg');
      expect(dark.fsPath).toBe('/ext/media/file-icons/dbml-table-dark.svg');
      expect(item.resourceUri?.fsPath).toBe(`${SEMANTIC}/gold/tables/gold/fct_order.dbml`);
      expect(item.contextValue).toBe('logicalModel');
    });

    it('keeps the codicons of a broken and a duplicate DBML table; an unused one keeps its table icon', () => {
      const provider = providerFor([
        dbmlEntry('fct_order'),
        dbmlEntry('dim_unused'),
        { ...dbmlEntry('fct_order', 'gold', 'sales'), shadowedBy: `${SEMANTIC}/gold/tables/gold/fct_order.dbml` },
      ], 'dbml', () => [], icons);
      // On no diagram is not a problem: the table keeps its table icon.
      expect(itemOf(provider, 'dim_unused').iconPath).toBe(dbmlFileIcon(EXTENSION, 'table'));
      expect(codicon(itemOf(provider, 'fct_order', 'sales'))).toBe('error');

      const broken = providerFor([dbmlEntry('fct_order')], 'dbml', () => [], icons, { fct_order: { kind: 'dbmlSyntax', line: 3 } });
      expect(codicon(itemOf(broken, 'fct_order'))).toBe('error');
      const twice = providerFor([dbmlEntry('fct_order')], 'dbml', () => [], icons, { fct_order: { kind: 'dbmlSyntax', line: 3, readable: true, key: 'note' } });
      expect(codicon(itemOf(twice, 'fct_order'))).toBe('warning');
    });

    it('keeps the codicon of a DBML copy of a YAML table (part-way through Convert)', () => {
      const yml: TableFileEntry = { name: 'fct_order', folder: '', filePath: `${SEMANTIC}/logical-models/fct_order.yml`, storage: 'yaml' };
      const provider = providerFor([yml, { ...dbmlEntry('fct_order'), shadowedBy: yml.filePath }], 'mixed', () => [], icons);
      expect(codicon(itemOf(provider, 'fct_order', 'gold'))).toBe('error');
    });

    it('a YAML table keeps symbol-class with the resolver; a DBML table keeps it without one', () => {
      const yml: TableFileEntry = { name: 'fct_order', folder: '', filePath: `${SEMANTIC}/logical-models/fct_order.yml`, storage: 'yaml' };
      expect(codicon(itemOf(providerFor([yml], 'yaml', () => [], icons), 'fct_order'))).toBe('symbol-class');
      expect(codicon(itemOf(providerFor([dbmlEntry('fct_order')], 'dbml'), 'fct_order'))).toBe('symbol-class');
    });

    it('draws a layer row with the layer icon in its layers.json colour, and a schema row with the plain namespace codicon', () => {
      const coloured = LAYERS.map((l) => (l.id === 'silver' ? { ...l, color: '#a0a0a0' } : l));
      const provider = providerFor([dbmlEntry('fct_order'), dbmlEntry('dim_date', 'silver', 'calendar')], 'dbml', () => coloured, icons);
      const [silver, gold] = provider.getChildren() as TableLibraryLayerNode[];
      expect(String((provider.getTreeItem(silver).iconPath as { toString(): string }).toString())).toMatch(/^data:image\/svg\+xml;base64,/);
      // The same layer icon as the Diagrams view, in the layer's colour.
      const svg = Buffer.from((provider.getTreeItem(silver).iconPath as { toString(): string }).toString().split(',')[1], 'base64').toString();
      expect(svg).toContain('#a0a0a0');
      // No colour in layers.json: the layers codicon.
      expect(codicon(provider.getTreeItem(gold))).toBe('layers');
      expect(codicon(provider.getTreeItem(silver.children[0]))).toBe('symbol-namespace');
    });
  });

  it('a mixed project shows the YAML folders first, then the DBML layers', () => {
    const yml: TableFileEntry = { name: 'dim_old', folder: 'gold', filePath: `${DIR}/gold/dim_old.yml`, storage: 'yaml' };
    const provider = providerFor([dbmlEntry('fct_order'), yml], 'mixed', () => LAYERS);
    const roots = provider.getChildren() as Array<TableLibraryFolderNode | TableLibraryLayerNode>;
    expect(roots.map((f) => (f.type === 'layer' ? `layer:${f.layer}` : `yaml:${f.folder}`))).toEqual(['yaml:gold', 'layer:gold']);
    expect(provider.getTreeItem(roots[0]).label).toBe('Gold');
  });
});

describe('TableLibraryTreeProvider: owners', () => {
  const SEMANTIC = '/project/.erd-studio';
  const dbml = (name: string): TableFileEntry => ({
    name, folder: 'orders', layer: 'source_aligned', filePath: `${SEMANTIC}/source_aligned/tables/orders/${name}.dbml`, storage: 'dbml',
  });

  function providerWith(
    entries: TableFileEntry[],
    tables: Record<string, { alias?: string; meta?: Record<string, unknown> }>,
    read: boolean,
    reviewers: (filePath: string) => string[] = () => [],
  ) {
    const service = createMockTableLibraryServiceFromEntries(entries, `${SEMANTIC}/logical-models`);
    const s = service as unknown as Record<string, unknown>;
    s.peekTableFileError = () => (read ? null : undefined);
    s.peekTableSummary = (name: string) => (read ? { ...tables[name] } : undefined);
    return fullRows(new TableLibraryTreeProvider(service, createMockSubjectAreaService([]), '/project', '.erd-studio', () => [], undefined, undefined, { ownersOf: reviewers }));
  }

  /** A library whose files are read only by the background check: `getTableFileError` marks one read. */
  function lazyProvider(entries: TableFileEntry[], tables: Record<string, { alias?: string; meta?: Record<string, unknown> }>) {
    const service = createMockTableLibraryServiceFromEntries(entries, `${SEMANTIC}/logical-models`);
    const s = service as unknown as Record<string, unknown>;
    const read = new Set<string>();
    s.peekTableFileError = (name: string) => (read.has(name) ? null : undefined);
    s.getTableFileError = vi.fn((name: string) => { read.add(name); return null; });
    s.peekTableSummary = (name: string) => (read.has(name) ? { ...tables[name] } : undefined);
    const provider = fullRows(new TableLibraryTreeProvider(service, createMockSubjectAreaService([]), '/project', '.erd-studio', () => [], undefined, undefined, { ownersOf: () => [] }));
    const fired = vi.fn();
    provider.onDidChangeTreeData(fired);
    return { provider, fired };
  }

  it('renders again after the background read for a DBML table\'s warehouse name, never for a YAML alias it does not show', async () => {
    vi.useFakeTimers();
    try {
      const yml: TableFileEntry = { name: 'dim_account', folder: '', filePath: `${SEMANTIC}/logical-models/dim_account.yml` };
      const yaml = lazyProvider([yml], { dim_account: { alias: 'accounts' } });
      yaml.provider.getChildren();
      await vi.runAllTimersAsync();
      expect(yaml.fired).not.toHaveBeenCalled();

      const dbmlTable = lazyProvider([dbml('customer_order')], { customer_order: { alias: 'orders' } });
      dbmlTable.provider.getChildren();
      await vi.runAllTimersAsync();
      expect(dbmlTable.fired).toHaveBeenCalledTimes(1);
      const item = dbmlTable.provider.getTreeItem(allTables(dbmlTable.provider.getChildren() as TableLibraryNode[])[0]);
      expect(item.description).toBe('as orders · on no diagram');
    } finally {
      vi.useRealTimers();
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileSync.mockImplementation(() => '{}');
  });

  it('names a read table\'s owner (meta_owner / owner:) after its warehouse name', () => {
    const provider = providerWith([dbml('customer_order')], { customer_order: { alias: 'orders', meta: { owner: 'orders-team' } } }, true);
    const item = provider.getTreeItem(allTables(provider.getChildren() as TableLibraryNode[])[0]);
    expect(item.description).toBe('as orders · orders-team · on no diagram');
    expect((item.tooltip as MarkdownString).value).toContain('Owner: orders-team');
  });

  it('names no owner before the file has been read, as with the warehouse name', () => {
    const provider = providerWith([dbml('customer_order')], { customer_order: { alias: 'orders', meta: { owner: 'orders-team' } } }, false);
    const item = provider.getTreeItem(allTables(provider.getChildren() as TableLibraryNode[])[0]);
    expect(item.description).toBe('on no diagram');
  });

  it('shows a YAML table\'s owner too, and ignores an owner that is not short text', () => {
    const yml: TableFileEntry = { name: 'dim_account', folder: '', filePath: `${SEMANTIC}/logical-models/dim_account.yml` };
    const other: TableFileEntry = { name: 'dim_odd', folder: '', filePath: `${SEMANTIC}/logical-models/dim_odd.yml` };
    const provider = providerWith([yml, other], { dim_account: { meta: { owner: 'accounts-team' } }, dim_odd: { meta: { owner: { team: 'x' } } } }, true);
    const items = allTables(provider.getChildren() as TableLibraryNode[]).map((n) => provider.getTreeItem(n));
    expect(items.find((i) => i.label === 'dim_account')?.description).toBe('accounts-team · on no diagram');
    expect(items.find((i) => i.label === 'dim_odd')?.description).toBe('on no diagram');
  });

  it('says who reviews a change to the table\'s file, from CODEOWNERS', () => {
    const asked: string[] = [];
    const provider = providerWith([dbml('customer_order')], {}, true, (filePath) => {
      asked.push(filePath);
      return ['@acme/orders-team', '@ana'];
    });
    const item = provider.getTreeItem(allTables(provider.getChildren() as TableLibraryNode[])[0]);
    expect((item.tooltip as MarkdownString).value).toContain('Reviewed by @acme/orders-team, @ana');
    expect(asked).toEqual([`${SEMANTIC}/source_aligned/tables/orders/customer_order.dbml`]);
  });
});

// ---------------------------------------------------------------------------
// Compact rows (`erdStudio.sidebar.rowDetails: compact`, the default)
// ---------------------------------------------------------------------------

describe('TableLibraryTreeProvider: compact rows (the default)', () => {
  const SEMANTIC = '/project/.erd-studio';
  const dbmlEntry = (name: string, layer = 'gold', schema = layer): TableFileEntry => ({
    name, folder: schema, layer, filePath: `${SEMANTIC}/${layer}/tables/${schema}/${name}.dbml`, storage: 'dbml',
  });
  const SALES: SubjectAreaSummary = { domain: 'sales', layer: 'gold', filePath: `${SEMANTIC}/gold/diagrams/sales.dbml`, storage: 'dbml' };
  const tip = (item: { tooltip?: unknown }): string =>
    typeof item.tooltip === 'string' ? item.tooltip : String((item.tooltip as MarkdownString).value);

  function compact(
    entries: TableFileEntry[],
    tables: Record<string, { alias?: string; meta?: Record<string, unknown> }> = {},
    storage: 'yaml' | 'dbml' | 'mixed' = 'dbml',
    errors: Record<string, Partial<import('../../src/services/logicalModelService').TableFileError>> = {},
  ): TableLibraryTreeProvider {
    const service = createMockTableLibraryServiceFromEntries(entries, `${SEMANTIC}/logical-models`);
    const s = service as unknown as Record<string, unknown>;
    s.projectStorage = () => storage;
    s.peekTableFileError = (name: string) => (errors[name] ? { name, filePath: '', message: '', ...errors[name] } : null);
    s.peekTableSummary = (name: string) => ({ ...tables[name] });
    return new TableLibraryTreeProvider(service, createMockSubjectAreaService([SALES]), '/project', '.erd-studio', () => LAYERS);
  }
  const items = (provider: TableLibraryTreeProvider) =>
    new Map(allTables(provider.getChildren() as TableLibraryNode[]).map((n) => [n.name, provider.getTreeItem(n)]));

  beforeEach(() => {
    vi.clearAllMocks();
    // The sales diagram shows fct_order.
    mockReadFileSync.mockImplementation((p: string) => (String(p).endsWith('.dbml')
      ? "use { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nProject sales {\n  erd_schema_version: '7'\n}\n"
      : '{}'));
  });

  it('a table row says only what is unusual: an alias that differs, or "on no diagram"; the owner and the diagrams are in the hover', () => {
    const provider = compact(
      [dbmlEntry('fct_order'), dbmlEntry('dim_store'), dbmlEntry('stg_order'), dbmlEntry('dim_date')],
      {
        fct_order: { alias: 'orders', meta: { owner: 'orders-team' } },
        dim_store: { alias: 'DIM_STORE' },
        dim_date: { meta: { owner: 'calendar-team' } },
      },
    );
    expect(provider.getRowDetails()).toBe('compact');
    const rows = items(provider);
    // On a diagram, with a warehouse name of its own and an owner: only the warehouse name.
    expect(rows.get('fct_order')!.description).toBe('as orders');
    const fctTip = tip(rows.get('fct_order')!);
    expect(fctTip).toContain('Owner: orders-team');
    expect(fctTip).toContain('On the diagram:\n- sales');
    expect(fctTip).toContain('the warehouse table `orders`');
    // The same name in another case is no alias; on no diagram is said in the row and announced.
    expect(rows.get('dim_store')!.description).toBe('on no diagram');
    expect(rows.get('dim_store')!.accessibilityInformation?.label).toBe('dim_store, not used in any diagram');
    expect(tip(rows.get('dim_store')!)).toContain('On no diagram yet');
    // An owner alone stays in the hover.
    expect(rows.get('dim_date')!.description).toBe('on no diagram');
    expect(tip(rows.get('dim_date')!)).toContain('Owner: calendar-team');

    provider.setRowDetails('full');
    expect(items(provider).get('fct_order')!.description).toBe('as orders · orders-team · on 1 diagram');
  });

  it('a table on a diagram with nothing unusual has no description at all', () => {
    const provider = compact([dbmlEntry('fct_order')]);
    expect(items(provider).get('fct_order')!.description).toBeUndefined();
  });

  it('keeps the DBML / YAML tag of a mixed project, and every error and duplicate text', () => {
    const yml: TableFileEntry = { name: 'dim_old', folder: '', filePath: `${DIR}/dim_old.yml`, storage: 'yaml' };
    const mixed = items(compact([dbmlEntry('fct_order'), yml], {}, 'mixed'));
    expect(mixed.get('fct_order')!.description).toBe('DBML');
    expect(mixed.get('dim_old')!.description).toBe('on no diagram · YAML');

    const broken = items(compact([dbmlEntry('fct_order'), dbmlEntry('dim_x')], {}, 'dbml', { dim_x: { kind: 'dbmlSyntax', line: 3 } }));
    expect(broken.get('dim_x')!.description).toBe('(DBML error — line 3)');

    const duplicate: TableFileEntry = { ...dbmlEntry('fct_order', 'silver'), shadowedBy: `${SEMANTIC}/gold/tables/gold/fct_order.dbml` };
    const dup = compact([dbmlEntry('fct_order'), duplicate]);
    const dupRow = allTables(dup.getChildren() as TableLibraryNode[]).find((n) => n.shadowedBy)!;
    expect(dup.getTreeItem(dupRow).description).toBe('(duplicate — ignored)');
  });

  it('a file that does not read says why in its hover (the reader\'s message, its line and a tip), the row staying short', () => {
    const filePath = `${SEMANTIC}/bronze/tables/bqs/addresse.dbml`;
    const broken = items(compact([dbmlEntry('fct_order'), dbmlEntry('addresse', 'bronze', 'bqs')], {}, 'dbml', {
      addresse: {
        kind: 'dbmlStructure', code: 'structure:nameMismatch', line: 1, filePath,
        message: 'addresse.dbml declares Table address; name the Table as its file (or rename the file)',
      },
    }));
    const row = broken.get('addresse')!;
    expect(row.description).toBe('(DBML error — line 1)');
    expect(row.tooltip).toBe([
      'This file can\'t be read, so the table is missing from every diagram. Open it to fix it.',
      '',
      'addresse.dbml declares Table address; name the Table as its file (or rename the file) (line 1)',
      '',
      "Tip: name the Table as its file, or rename the file to the Table's name.",
    ].join('\n'));
  });

  it('the hover names the file as the tree does, never by its absolute path, keeps a long message short, and stays as it was with no message', () => {
    const filePath = `${SEMANTIC}/gold/tables/gold/dim_x.dbml`;
    const unreadable = items(compact([dbmlEntry('dim_x')], {}, 'dbml', {
      dim_x: { kind: 'read', filePath, message: `EACCES: permission denied, open '${filePath}'\n    at readFileSync` },
    })).get('dim_x')!;
    expect(unreadable.description).toBe('(can\'t be read)');
    expect(String(unreadable.tooltip)).toContain("EACCES: permission denied, open '.erd-studio/gold/tables/gold/dim_x.dbml' at readFileSync");
    expect(String(unreadable.tooltip)).not.toContain('/project/');

    const long = items(compact([dbmlEntry('dim_x')], {}, 'dbml', { dim_x: { kind: 'dbmlSyntax', line: 3, filePath, message: 'x'.repeat(900) } })).get('dim_x')!;
    expect(String(long.tooltip).split('\n')[2]).toBe(`${'x'.repeat(399)}… (line 3)`);

    const silent = items(compact([dbmlEntry('dim_x')], {}, 'dbml', { dim_x: { kind: 'dbmlSyntax', line: 3, filePath } })).get('dim_x')!;
    expect(silent.tooltip).toBe([
      'This file can\'t be read, so the table is missing from every diagram. Open it to fix it.',
      '',
      'Tip: check the DBML syntax on that line (a missing bracket, quote or brace).',
    ].join('\n'));
  });

  it('a duplicate in another schema of the SAME layer is offered {schema}_{name}; in another layer, {layer}_{name} as before', () => {
    const winner = dbmlEntry('addresse', 'bronze', 'bqs');
    const copy: TableFileEntry = { ...dbmlEntry('addresse', 'bronze', 'ccc'), shadowedBy: winner.filePath };
    const sameLayer = compact([winner, copy]);
    const sameRow = allTables(sameLayer.getChildren() as TableLibraryNode[]).find((n) => n.shadowedBy)!;
    const sameItem = sameLayer.getTreeItem(sameRow);
    expect(sameItem.description).toBe('(duplicate — ignored)');
    expect(String(sameItem.tooltip)).toContain('to make this copy "ccc_addresse" with the warehouse name (alias) "addresse".');
    expect(String(sameItem.tooltip)).not.toContain('bronze_addresse');

    const other: TableFileEntry = { ...dbmlEntry('fct_order', 'silver', 'sales'), shadowedBy: `${SEMANTIC}/gold/tables/gold/fct_order.dbml` };
    const crossLayer = compact([dbmlEntry('fct_order'), other]);
    const crossRow = allTables(crossLayer.getChildren() as TableLibraryNode[]).find((n) => n.shadowedBy)!;
    expect(String(crossLayer.getTreeItem(crossRow).tooltip)).toContain('to make this copy "silver_fct_order" with the warehouse name (alias) "fct_order".');
  });

  it('a layer row and a schema row have context values of their own, which New Table… and New Schema… are offered on', () => {
    const provider = compact([dbmlEntry('fct_order'), dbmlEntry('dim_date', 'silver', 'calendar'), dbmlEntry('dim_time', 'silver', 'clock')]);
    const [silver, gold] = provider.getChildren() as TableLibraryLayerNode[];
    expect(provider.getTreeItem(silver).contextValue).toBe('tableLibraryLayer');
    expect(provider.getTreeItem(gold).contextValue).toBe('tableLibraryLayer');
    expect(provider.getTreeItem(silver.children[0]).contextValue).toBe('tableLibrarySchema');
  });

  it('layer rows say "Layer" and schema rows "Schema"; their hovers have the counts', () => {
    const provider = compact([dbmlEntry('fct_order'), dbmlEntry('dim_customer'), dbmlEntry('dim_date', 'silver', 'calendar'), dbmlEntry('dim_time', 'silver', 'clock')]);
    const [silver, gold] = provider.getChildren() as TableLibraryLayerNode[];
    const silverItem = provider.getTreeItem(silver);
    expect(silverItem.description).toBe('Layer');
    expect(tip(silverItem)).toContain('2 tables in 2 schemas');
    const calendar = provider.getTreeItem(silver.children[0]);
    expect(calendar.description).toBe('Schema');
    expect(tip(calendar)).toMatch(/\n1 table$/);
    const goldItem = provider.getTreeItem(gold);
    expect(goldItem.description).toBe('Layer');
    expect(tip(goldItem)).toMatch(/\n2 tables$/);
  });

  it('a YAML folder row drops its count (the hover has it), keeping the tables/ marker of a v6 folder', () => {
    const TDIR = '/project/.erd-studio/tables';
    const service = createMockTableLibraryServiceFromEntries([
      entry('fct_a', 'gold'), entry('dim_b', 'gold'),
      { name: 'fct_c', folder: 'gold', library: 'tables', filePath: `${TDIR}/gold/fct_c.yml` },
    ], DIR);
    mockReadFileSync.mockImplementation(() => '{}');
    const provider = new TableLibraryTreeProvider(service, createMockSubjectAreaService([]), '/project', '.erd-studio', () => LAYERS);
    const [v5Gold, v6Gold] = provider.getChildren() as TableLibraryFolderNode[];
    const v5 = provider.getTreeItem(v5Gold);
    expect(v5.description).toBeUndefined();
    expect(tip(v5)).toBe('logical-models/gold/ — tables created in Gold diagrams\n2 tables');
    expect(provider.getTreeItem(v6Gold).description).toBe('tables/');
  });

  it(`starts layer rows collapsed in a library of more than ${COLLAPSE_LAYERS_OVER} tables, expanded otherwise; a filter still expands them`, () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => dbmlEntry(`t${String(i).padStart(2, '0')}`, i % 2 ? 'gold' : 'silver', i % 2 ? 'gold' : 'calendar'));
    const small = compact(many(COLLAPSE_LAYERS_OVER));
    for (const row of small.getChildren()!) expect(small.getTreeItem(row).collapsibleState).toBe(TreeItemCollapsibleState.Expanded);

    const large = compact(many(COLLAPSE_LAYERS_OVER + 1));
    const roots = large.getChildren() as TableLibraryLayerNode[];
    for (const row of roots) {
      const item = large.getTreeItem(row);
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      // The id VS Code remembers the user's choice by.
      expect(item.id).toBe(`erdStudio.modelLibrary.layer:${row.layer}`);
    }
    // A schema row under a collapsed layer is expanded once its layer is.
    const [silver] = roots;
    expect(large.getTreeItem(silver.children[0]).collapsibleState).toBe(TreeItemCollapsibleState.Expanded);

    large.setFilter('t0');
    const [filtered] = large.getChildren() as TableLibraryLayerNode[];
    const item = large.getTreeItem(filtered);
    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(item.id).toMatch(/#filter1$/);
  });

  it('collapses a large YAML library\'s folder rows too', () => {
    const service = createMockTableLibraryServiceFromEntries(
      Array.from({ length: COLLAPSE_LAYERS_OVER + 1 }, (_, i) => entry(`t${i}`, i % 2 ? 'gold' : 'silver')), DIR);
    mockReadFileSync.mockImplementation(() => '{}');
    const provider = new TableLibraryTreeProvider(service, createMockSubjectAreaService([]), '/project', '.erd-studio', () => LAYERS);
    for (const row of provider.getChildren()!) expect(provider.getTreeItem(row).collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
  });

  it('gives the view\'s total for its title, not counting an ignored duplicate; none before a listing or for an empty library', () => {
    const duplicate: TableFileEntry = { ...dbmlEntry('fct_order', 'silver'), shadowedBy: `${SEMANTIC}/gold/tables/gold/fct_order.dbml` };
    const provider = compact([dbmlEntry('fct_order'), dbmlEntry('dim_customer'), duplicate]);
    expect(provider.headerTotal()).toBeUndefined();
    provider.getChildren();
    expect(provider.headerTotal()).toBe('2 tables');
    // Filtered, the total is still the library's.
    provider.setFilter('fct');
    provider.getChildren();
    expect(provider.headerTotal()).toBe('2 tables');

    const one = compact([dbmlEntry('fct_order')]);
    one.getChildren();
    expect(one.headerTotal()).toBe('1 table');
    const none = compact([]);
    none.getChildren();
    expect(none.headerTotal()).toBeUndefined();
  });
});
