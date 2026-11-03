/**
 * The Relationships view (`RelationshipsTreeProvider`) and its two actions
 * (`src/commands/relationshipsView.ts`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { RelationshipsTreeProvider, type RelationshipsNode, type RelationshipNode } from '../../src/providers/RelationshipsTreeProvider';
import { dbmlFileIcon } from '../../src/providers/dbmlFileKinds';
import { diagramsShowing, openInDiagram, openRelationshipSource, relationshipLineInYaml, revealTarget, type RelationshipsViewDeps } from '../../src/commands/relationshipsView';
import type { TableLibraryService } from '../../src/services/logicalModelService';
import type { SubjectAreaService } from '../../src/services/domainService';
import type { SemanticTable, SubjectAreaSummary } from '../../src/types/semantic';

/**
 * The tests here check the full rows (`erdStudio.sidebar.rowDetails: full`,
 * today's text); the compact rows have tests of their own.
 */
function fullRows<T extends { setRowDetails(mode: 'compact' | 'full'): void }>(provider: T): T {
  provider.setRowDetails('full');
  return provider;
}

const table = (name: string, columns: string[], relationships: SemanticTable['relationships'] = []): SemanticTable =>
  ({ name, columns: columns.map((c) => ({ name: c })), ...(relationships.length ? { relationships } : {}) }) as SemanticTable;

const TABLES = [
  table('dim_customer', ['customer_sk']),
  table('fct_order', ['customer_sk', 'store_sk'], [
    { fromColumn: 'customer_sk', toModel: 'dim_customer', toColumn: 'customer_sk', cardinality: 'many-to-one' },
    { fromColumn: 'store_sk', toModel: 'dim_store', toColumn: 'store_sk', cardinality: 'many-to-one' },
  ]),
];

function libraryWith(tables: SemanticTable[], unread: string[] = []) {
  const read = new Set<string>();
  const service = {
    dirExists: () => true,
    listTables: vi.fn(() => tables),
    listTableFiles: () => tables.map((t) => ({ name: t.name, folder: '', filePath: `/lib/${t.name}.yml` })),
    peekTableFileError: (name: string) => (unread.includes(name) && !read.has(name) ? undefined : null),
    getTableFileError: vi.fn((name: string) => { read.add(name); return null; }),
    tableStorage: () => 'yaml' as const,
  };
  return service;
}

const noDiagrams = { listSubjectAreas: () => [] } as unknown as SubjectAreaService;

function providerOver(tables = TABLES, unread: string[] = []) {
  const service = libraryWith(tables, unread);
  const provider = fullRows(new RelationshipsTreeProvider(service as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio'));
  return { provider, service };
}

describe('RelationshipsTreeProvider', () => {
  it('lists "Needs attention" first, then each table with a relationship', async () => {
    const { provider } = providerOver();
    const rows = await provider.getChildren();
    expect(rows.map((r) => (r.type === 'table' ? r.group.table : r.type))).toEqual(['attention', 'dim_customer', 'dim_store', 'fct_order']);
    const attention = provider.getTreeItem(rows[0]);
    expect(attention.label).toBe('Needs attention');
    expect(attention.description).toBe('1 relationship');
    const problems = await provider.getChildren(rows[0]);
    expect(provider.getTreeItem(problems[0]).description).toBe('no table dim_store');
    // A problem is fixed in the file, so its row opens the file.
    expect(provider.getTreeItem(problems[0]).command).toMatchObject({ command: 'erdStudio.openRelationshipSource' });
  });

  it('shows a relationship from each side: → at the FK table, ← at the table it points at', async () => {
    const { provider } = providerOver();
    const rows = await provider.getChildren();
    const fct = rows.find((r) => r.type === 'table' && r.group.table === 'fct_order')!;
    const dim = rows.find((r) => r.type === 'table' && r.group.table === 'dim_customer')!;
    expect(provider.getTreeItem(fct).description).toBe('2 relationships · 1 problem');
    expect(provider.getTreeItem(fct).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);

    const out = provider.getTreeItem((await provider.getChildren(fct))[0]);
    expect(out.label).toBe('dim_customer');
    // Both ends share the column name: named once. N:1 read from the FK side.
    expect(out.description).toBe('customer_sk · N:1');
    expect((out.iconPath as vscode.ThemeIcon).id).toBe('arrow-right');

    const inc = provider.getTreeItem((await provider.getChildren(dim))[0]);
    expect(inc.label).toBe('fct_order');
    expect(inc.description).toBe('customer_sk · 1:N');
    expect((inc.iconPath as vscode.ThemeIcon).id).toBe('arrow-left');
    // A click shows it on a diagram, falling back to its file when none shows it.
    expect(inc.command).toMatchObject({ command: 'erdStudio.openInDiagram', arguments: [expect.anything(), { fallBackToFile: true }] });
    expect(inc.contextValue).toBe('relationship');
  });

  it('names both columns when they differ, with the arrow read from the row\'s table', async () => {
    const { provider } = providerOver([
      table('dim_date', ['date_sk']),
      table('fct_order', ['order_date_sk'], [{ fromColumn: 'order_date_sk', toModel: 'dim_date', toColumn: 'date_sk', cardinality: 'many-to-one', role: 'ordered on' }]),
    ]);
    const rows = await provider.getChildren();
    const [dim, fct] = rows;
    expect(provider.getTreeItem((await provider.getChildren(fct))[0]).description).toBe('order_date_sk → date_sk · N:1 · ordered on');
    expect(provider.getTreeItem((await provider.getChildren(dim))[0]).description).toBe('date_sk ← order_date_sk · 1:N · ordered on');
  });

  it('gives the same relationship a different id under each parent', async () => {
    const { provider } = providerOver();
    const ids = new Set<string>();
    const walk = async (node?: RelationshipsNode): Promise<void> => {
      for (const child of await provider.getChildren(node)) {
        const id = provider.getTreeItem(child).id!;
        expect(ids.has(id), id).toBe(false);
        ids.add(id);
        await walk(child);
      }
    };
    await walk();
    expect(ids.size).toBe(4 + 1 + 2 + 2); // 4 parents, 1 problem row, the 2 relationships under both tables each
  });

  it('reads table files no listing has read yet before it lists', async () => {
    const { provider, service } = providerOver(TABLES, ['fct_order']);
    await provider.getChildren();
    expect(service.getTableFileError).toHaveBeenCalledWith('fct_order');
    expect(service.getTableFileError).toHaveBeenCalledTimes(1);
  });

  it('is empty without a library or relationships, so the welcome text shows', async () => {
    const { provider } = providerOver([table('a', ['id'])]);
    expect(await provider.getChildren()).toEqual([]);
  });
});

describe('relationshipLineInYaml', () => {
  const yml = [
    'name: fct_order',
    'columns:',
    '  - name: customer_sk',
    'relationships:',
    '  - fromColumn: store_sk',
    '    toModel: dim_store',
    '  - fromColumn: customer_sk',
    "    toModel: 'Dim_Customer'",
    'meta:',
    '  toModel: dim_customer',
  ].join('\n');

  it('finds the item naming the other table, case-insensitive', () => {
    expect(relationshipLineInYaml(yml, 'dim_customer')).toBe(8);
    expect(relationshipLineInYaml(yml, 'dim_store')).toBe(6);
  });

  it('falls back to the relationships: line, and is undefined without one', () => {
    expect(relationshipLineInYaml(yml, 'dim_gone')).toBe(4);
    expect(relationshipLineInYaml('name: x\n', 'y')).toBeUndefined();
  });
});

describe('Relationships view actions', () => {
  let exec: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
  });

  const summary = (domain: string): SubjectAreaSummary => ({ domain, layer: 'gold', filePath: `/p/.erd-studio/gold/${domain}.json` });
  const deps = (over: Partial<RelationshipsViewDeps> = {}): RelationshipsViewDeps => ({
    relationshipLocation: () => undefined,
    findTableFile: () => null,
    listSubjectAreas: () => [summary('sales'), summary('crm')],
    memberNames: (p) => (p.endsWith('sales.json') ? ['fct_order', 'DIM_CUSTOMER'] : ['dim_customer']),
    layerLabel: () => 'Gold',
    revealRelationship: vi.fn(async () => undefined),
    ...over,
  });

  async function relationshipNode(): Promise<RelationshipNode> {
    const { provider } = providerOver();
    const rows = await provider.getChildren();
    const fct = rows.find((r) => r.type === 'table' && r.group.table === 'fct_order')!;
    return (await provider.getChildren(fct))[0] as RelationshipNode;
  }

  it('opens a DBML Ref at its line', async () => {
    const node = await relationshipNode();
    await openRelationshipSource(node, deps({ relationshipLocation: () => ({ filePath: '/p/gold/relationships/gold.dbml', line: 7 }) }));
    const [command, uri, options] = exec.mock.calls[0] as [string, vscode.Uri, { selection: vscode.Range }];
    expect(command).toBe('vscode.open');
    expect(uri.fsPath).toBe('/p/gold/relationships/gold.dbml');
    expect(options.selection.start.line).toBe(6);
  });

  it('opens a YAML table\'s relationship in the FK table\'s file, at its item', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-rels-'));
    const file = path.join(dir, 'fct_order.yml');
    fs.writeFileSync(file, 'name: fct_order\nrelationships:\n  - fromColumn: customer_sk\n    toModel: dim_customer\n');
    await openRelationshipSource(await relationshipNode(), deps({ findTableFile: (n) => (n === 'fct_order' ? file : null) }));
    const [, uri, options] = exec.mock.calls[0] as [string, vscode.Uri, { selection: vscode.Range }];
    expect(uri.fsPath).toBe(file);
    expect(options.selection.start.line).toBe(3);
  });

  it('finds the diagrams showing both tables (case-insensitive), opens the only one and shows the line on it', async () => {
    expect(diagramsShowing(['fct_order', 'dim_customer'], deps()).map((s) => s.domain)).toEqual(['sales']);
    const d = deps();
    await openInDiagram(await relationshipNode(), d);
    expect(exec).toHaveBeenCalledWith('erdStudio.openDomain', '/p/.erd-studio/gold/sales.json');
    expect(d.revealRelationship).toHaveBeenCalledWith('/p/.erd-studio/gold/sales.json',
      { fromModel: 'fct_order', toModel: 'dim_customer', pairs: [{ fromColumn: 'customer_sk', toColumn: 'customer_sk' }] });
  });

  it('shows a relationship a diagram keeps on that diagram, without looking for others', async () => {
    const node = await relationshipNode();
    const kept = { ...node, entry: { ...node.entry, source: { kind: 'diagram' as const, filePath: '/p/.erd-studio/gold/crm.json', label: 'gold/crm' } } };
    const d = deps({ listSubjectAreas: () => { throw new Error('not asked'); } });
    await openInDiagram(kept, d);
    expect(exec).toHaveBeenCalledWith('erdStudio.openDomain', '/p/.erd-studio/gold/crm.json');
    expect(d.revealRelationship).toHaveBeenCalledWith('/p/.erd-studio/gold/crm.json', revealTarget(node.entry));
  });

  it('gives a composite key every pair, in order', async () => {
    const node = await relationshipNode();
    const entry = { ...node.entry, fromColumns: ['order_id', 'line_no'], toColumns: ['order_id', 'line_no'] };
    expect(revealTarget(entry).pairs).toEqual([{ fromColumn: 'order_id', toColumn: 'order_id' }, { fromColumn: 'line_no', toColumn: 'line_no' }]);
  });

  it('opens a Table Library table\'s diagram, without a line to show', async () => {
    const d = deps();
    await openInDiagram({ type: 'model', name: 'dim_customer', filePath: '/lib/dim_customer.yml', referencingDomains: [] }, d);
    // Both diagrams draw dim_customer: the user picks one.
    expect(exec).not.toHaveBeenCalled();
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => items[1]) as never);
    await openInDiagram({ type: 'model', name: 'dim_customer', filePath: '/lib/dim_customer.yml', referencingDomains: [] }, d);
    expect((pick.mock.calls[0][0] as Array<{ label: string }>).map((i) => i.label)).toEqual(['sales', 'crm']);
    expect(exec).toHaveBeenCalledWith('erdStudio.openDomain', '/p/.erd-studio/gold/crm.json');
    expect(d.revealRelationship).not.toHaveBeenCalled();
  });

  it('lists every diagram that shows both tables, then the file the relationship is saved in', async () => {
    // Both diagrams draw the relationship: it is saved once, so the last choice opens that file.
    const d = deps({ memberNames: () => ['fct_order', 'dim_customer'], relationshipLocation: () => ({ filePath: '/p/.erd-studio/gold/relationships/gold.dbml', line: 7 }) });
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => items[items.length - 1]) as never);
    await openInDiagram(await relationshipNode(), d, { fallBackToFile: true });
    const items = pick.mock.calls[0][0] as Array<{ label: string; description?: string }>;
    expect(items.map((i) => i.label)).toEqual(['sales', 'crm', '$(go-to-file) Open in File']);
    expect(items[2].description).toBe('gold/relationships/gold.dbml, line 7');
    expect(String((pick.mock.calls[0][1] as { placeHolder: string }).placeHolder)).toBe('2 diagrams show both "fct_order" and "dim_customer". Open which?');
    expect(exec.mock.calls[0][0]).toBe('vscode.open');
    expect((exec.mock.calls[0][1] as vscode.Uri).fsPath).toBe('/p/.erd-studio/gold/relationships/gold.dbml');
    expect(d.revealRelationship).not.toHaveBeenCalled();
  });

  it('says so when no diagram shows both tables', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    await openInDiagram(await relationshipNode(), deps({ memberNames: () => ['fct_order'] }));
    expect(String(info.mock.calls[0][0])).toBe('ERD Studio: No diagram shows both "fct_order" and "dim_customer" yet. To add them, open a diagram and use + Add → Add Existing Tables.');
    expect(exec).not.toHaveBeenCalled();
  });

  it('a row\'s click opens where it is written instead, when no diagram shows both tables', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    const d = deps({ memberNames: () => ['fct_order'], relationshipLocation: () => ({ filePath: '/p/gold/relationships/gold.dbml', line: 7 }) });
    await openInDiagram(await relationshipNode(), d, { fallBackToFile: true });
    expect(info).not.toHaveBeenCalled();
    expect(exec.mock.calls[0][0]).toBe('vscode.open');
    expect((exec.mock.calls[0][1] as vscode.Uri).fsPath).toBe('/p/gold/relationships/gold.dbml');
    expect(d.revealRelationship).not.toHaveBeenCalled();
  });
});

describe('RelationshipsTreeProvider: grouped by layer (DBML tables have a home)', () => {
  const VAULT = [
    table('hub_customer', ['customer_hk']),
    table('sat_customer', ['customer_hk'], [{ fromColumn: 'customer_hk', toModel: 'hub_customer', toColumn: 'customer_hk', cardinality: 'many-to-one' }]),
    table('pit_customer', ['customer_hk'], [{ fromColumn: 'customer_hk', toModel: 'hub_customer', toColumn: 'customer_hk', cardinality: 'many-to-one' }]),
  ];
  const HOMES = new Map([
    ['hub_customer', { layer: 'raw_vault', schema: 'raw_vault' }],
    ['sat_customer', { layer: 'raw_vault', schema: 'raw_vault' }],
    ['pit_customer', { layer: 'business_vault', schema: 'business_vault' }],
  ]);
  const LAYER_CONFIGS = [
    { id: 'raw_vault', label: 'Raw Vault', abbreviation: 'RV', color: '#64748b', order: 0 },
    { id: 'business_vault', label: 'Business Vault', abbreviation: 'BV', color: '#8b5cf6', order: 1 },
  ];

  function layered() {
    const service = libraryWith(VAULT);
    return fullRows(new RelationshipsTreeProvider(
      service as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio', undefined,
      () => HOMES, () => LAYER_CONFIGS as never,
      () => ({ filePath: '/p/.erd-studio/business_vault/relationships/business_vault.dbml', line: 4 }),
    ));
  }

  it('lists each layer, in layers.json order, with its tables under it; the layer row says "Layer"', async () => {
    const provider = layered();
    const rows = await provider.getChildren();
    expect(rows.map((r) => (r.type === 'layer' ? r.layer : r.type))).toEqual(['raw_vault', 'business_vault']);
    const raw = provider.getTreeItem(rows[0]);
    expect(raw.label).toBe('Raw Vault');
    expect(raw.description).toBe('Layer · 2 tables · 2 relationships');
    expect(String((raw.iconPath as vscode.Uri).toString())).toMatch(/^data:image\/svg\+xml;base64,/);
    const tables = await provider.getChildren(rows[0]);
    expect(tables.map((t) => (t.type === 'table' ? t.group.table : t.type))).toEqual(['hub_customer', 'sat_customer']);
  });

  it('marks a relationship to another layer first in its row, and names the file that stores it', async () => {
    const provider = layered();
    const [raw, business] = await provider.getChildren();
    const hub = (await provider.getChildren(raw)).find((t) => t.type === 'table' && t.group.table === 'hub_customer')!;
    const rowsOfHub = (await provider.getChildren(hub)).map((r) => provider.getTreeItem(r));
    expect(rowsOfHub.find((i) => i.label === 'pit_customer')?.description).toBe('in Business Vault · customer_hk · 1:N');
    expect(rowsOfHub.find((i) => i.label === 'sat_customer')?.description).toBe('customer_hk · 1:N');

    const pit = (await provider.getChildren(business))[0];
    const out = provider.getTreeItem((await provider.getChildren(pit))[0]);
    expect(out.description).toBe('in Raw Vault · customer_hk · N:1');
    const tip = (out.tooltip as vscode.MarkdownString).value;
    expect(tip).toContain('Joins two layers: pit_customer is in Business Vault, hub_customer in Raw Vault.');
    expect(tip).toContain('Stored in `.erd-studio/business_vault/relationships/business_vault.dbml` (line 4)');
  });

  it('keeps the flat list of tables when no table has a layer (a YAML project)', async () => {
    const service = libraryWith(VAULT);
    const provider = fullRows(new RelationshipsTreeProvider(service as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio', undefined, () => new Map()));
    const rows = await provider.getChildren();
    expect(rows.every((r) => r.type === 'table')).toBe(true);
  });
});

describe('RelationshipsTreeProvider: grouped by relationships file', () => {
  const VAULT = [
    table('hub_customer', ['customer_hk']),
    table('sat_customer', ['customer_hk'], [{ fromColumn: 'customer_hk', toModel: 'hub_customer', toColumn: 'customer_hk', cardinality: 'many-to-one' }]),
    table('pit_customer', ['customer_hk'], [{ fromColumn: 'customer_hk', toModel: 'hub_customer', toColumn: 'customer_hk', cardinality: 'many-to-one' }]),
    table('link_order', ['customer_hk', 'order_hk'], [
      { fromColumn: 'order_hk', toModel: 'hub_order', toColumn: 'order_hk', cardinality: 'many-to-one' },
      { fromColumn: 'customer_hk', toModel: 'hub_customer', toColumn: 'customer_hk', cardinality: 'many-to-one', role: 'placed by' },
    ]),
    table('hub_order', ['order_hk']),
    table('yaml_fact', ['customer_hk'], [{ fromColumn: 'customer_hk', toModel: 'hub_customer', toColumn: 'customer_hk', cardinality: 'many-to-one' }]),
  ];
  const HOMES = new Map([
    ['hub_customer', { layer: 'raw_vault', schema: 'raw_vault' }],
    ['sat_customer', { layer: 'raw_vault', schema: 'raw_vault' }],
    ['link_order', { layer: 'raw_vault', schema: 'raw_vault' }],
    ['hub_order', { layer: 'raw_vault', schema: 'raw_vault' }],
    ['pit_customer', { layer: 'business_vault', schema: 'business_vault' }],
  ]);
  const LAYER_CONFIGS = [
    { id: 'raw_vault', label: 'Raw Vault', abbreviation: 'RV', color: '#64748b', order: 0 },
    { id: 'business_vault', label: 'Business Vault', abbreviation: 'BV', color: '#8b5cf6', order: 1 },
  ];
  const RV = '/p/.erd-studio/raw_vault/relationships';
  const BV = '/p/.erd-studio/business_vault/relationships';
  // Where each Ref is written, by its FK table and column.
  const AT: Record<string, { filePath: string; line: number }> = {
    'sat_customer.customer_hk': { filePath: `${RV}/raw_vault.dbml`, line: 3 },
    'link_order.order_hk': { filePath: `${RV}/links.dbml`, line: 2 },
    'link_order.customer_hk': { filePath: `${RV}/links.dbml`, line: 1 },
    'pit_customer.customer_hk': { filePath: `${BV}/business_vault.dbml`, line: 4 },
  };

  function byFile() {
    const service = libraryWith(VAULT);
    const provider = fullRows(new RelationshipsTreeProvider(
      service as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio', undefined,
      () => HOMES, () => LAYER_CONFIGS as never,
      (rel) => AT[`${rel.fromModel}.${rel.fromColumn}`],
    ));
    provider.setGrouping('file');
    return provider;
  }

  it('lists each layer\'s relationships files by name, each with its Refs in file order', async () => {
    const provider = byFile();
    const rows = await provider.getChildren();
    expect(rows.map((r) => (r.type === 'layer' ? r.layer ?? '(none)' : r.type))).toEqual(['raw_vault', 'business_vault', '(none)']);
    const raw = provider.getTreeItem(rows[0]);
    expect(raw.label).toBe('Raw Vault');
    expect(raw.description).toBe('Layer · 2 files · 3 relationships');

    const files = await provider.getChildren(rows[0]);
    expect(files.map((f) => provider.getTreeItem(f).label)).toEqual(['links', 'raw_vault']);
    const links = provider.getTreeItem(files[0]);
    expect(links.description).toBe('Relationships file · 2');
    expect((links.tooltip as vscode.MarkdownString).value).toContain('File: `.erd-studio/raw_vault/relationships/links.dbml`');

    const refs = (await provider.getChildren(files[0])).map((r) => provider.getTreeItem(r));
    // Line 1 first: file order, not name order.
    expect(refs.map((r) => r.label)).toEqual(['link_order → hub_customer', 'link_order → hub_order']);
    expect(refs[0].description).toBe('customer_hk · N:1 · placed by');
    expect(refs[1].description).toBe('order_hk · N:1');
    // Grouped by file, a click opens the file at the Ref's line (grouped by table, a diagram).
    expect(refs[0].command).toMatchObject({ command: 'erdStudio.openRelationshipSource', arguments: [expect.anything()] });
    expect(String((refs[0].tooltip as vscode.MarkdownString).value)).toContain('Click to open it in its file');
    expect(refs[0].contextValue).toBe('relationship');
  });

  it('marks a relationship to another layer first in its row', async () => {
    const provider = byFile();
    const [, business] = await provider.getChildren();
    const [file] = await provider.getChildren(business);
    const [row] = await provider.getChildren(file);
    const item = provider.getTreeItem(row);
    expect(item.label).toBe('pit_customer → hub_customer');
    expect(item.description).toBe('in Raw Vault · customer_hk · N:1');
  });

  it('lists a relationship no relationships file holds under its foreign-key table\'s layer', async () => {
    const provider = byFile();
    const rows = await provider.getChildren();
    const other = rows[2];
    expect(provider.getTreeItem(other).label).toBe('Other tables');
    const [row] = await provider.getChildren(other);
    expect(provider.getTreeItem(row).label).toBe('yaml_fact → hub_customer');
    // hub_customer is in Raw Vault, yaml_fact in no layer.
    expect(provider.getTreeItem(row).description).toBe('in Raw Vault · customer_hk · N:1');
  });

  it('counts a relationship with a problem in its file too, as the Explorer counts the file\'s Refs', async () => {
    const tables = [
      ...VAULT,
      table('sat_order', ['order_hk'], [{ fromColumn: 'order_hk', toModel: 'hub_gone', toColumn: 'order_hk', cardinality: 'many-to-one' }]),
    ];
    const at: Record<string, { filePath: string; line: number }> = { ...AT, 'sat_order.order_hk': { filePath: `${RV}/links.dbml`, line: 5 } };
    const homes = new Map([...HOMES, ['sat_order', { layer: 'raw_vault', schema: 'raw_vault' }]]);
    const provider = fullRows(new RelationshipsTreeProvider(
      libraryWith(tables) as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio', undefined,
      () => homes, () => LAYER_CONFIGS as never,
      (rel) => at[`${rel.fromModel}.${rel.fromColumn}`],
    ));
    provider.setGrouping('file');
    const rows = await provider.getChildren();
    expect(rows[0].type).toBe('attention');
    const raw = rows.find((r) => r.type === 'layer' && r.layer === 'raw_vault')!;
    expect(provider.getTreeItem(raw).description).toBe('Layer · 2 files · 4 relationships');
    const [links] = await provider.getChildren(raw);
    const item = provider.getTreeItem(links);
    expect(item.description).toBe('Relationships file · 3 · 1 problem');
    expect((item.tooltip as vscode.MarkdownString).value).toContain('3 relationships · 1 problem');
    const refs = (await provider.getChildren(links)).map((r) => provider.getTreeItem(r));
    expect(refs.map((r) => r.label)).toEqual(['link_order → hub_customer', 'link_order → hub_order', 'sat_order → hub_gone']);
    expect((refs[2].iconPath as vscode.ThemeIcon).id).toBe('warning');
  });

  it('keeps problems under "Needs attention", and every id unique', async () => {
    const service = libraryWith(TABLES);
    const provider = fullRows(new RelationshipsTreeProvider(service as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio'));
    provider.setGrouping('file');
    const rows = await provider.getChildren();
    expect(rows[0].type).toBe('attention');
    const ids = new Set<string>();
    const walk = async (node?: RelationshipsNode): Promise<void> => {
      for (const child of await provider.getChildren(node)) {
        const id = provider.getTreeItem(child).id!;
        expect(ids.has(id), id).toBe(false);
        ids.add(id);
        await walk(child);
      }
    };
    await walk();
  });

  it('switches back to the table grouping, and refreshes on a change only', async () => {
    const provider = byFile();
    const fired = vi.fn();
    provider.onDidChangeTreeData(fired);
    provider.setGrouping('file');
    expect(fired).not.toHaveBeenCalled();
    provider.setGrouping('table');
    expect(fired).toHaveBeenCalledTimes(1);
    expect(provider.getGrouping()).toBe('table');
    const rows = await provider.getChildren();
    expect((await provider.getChildren(rows[0]))[0].type).toBe('table');
  });
});

// ---------------------------------------------------------------------------
// Compact rows (`erdStudio.sidebar.rowDetails: compact`, the default) and the view's purple
// ---------------------------------------------------------------------------

describe('RelationshipsTreeProvider: compact rows (the default) and its own colour', () => {
  const VAULT = [
    table('hub_customer', ['customer_hk']),
    table('sat_customer', ['customer_hk'], [{ fromColumn: 'customer_hk', toModel: 'hub_customer', toColumn: 'customer_hk', cardinality: 'many-to-one' }]),
    table('pit_customer', ['customer_hk'], [{ fromColumn: 'customer_hk', toModel: 'hub_customer', toColumn: 'customer_hk', cardinality: 'many-to-one', role: 'tracks' }]),
    table('link_order', ['customer_hk', 'order_hk'], [
      { fromColumn: 'order_hk', toModel: 'hub_order', toColumn: 'order_hk', cardinality: 'many-to-one' },
      { fromColumn: 'customer_hk', toModel: 'hub_customer', toColumn: 'customer_hk', cardinality: 'many-to-one' },
    ]),
    table('hub_order', ['order_hk']),
    table('yaml_fact', ['customer_hk'], [{ fromColumn: 'customer_hk', toModel: 'hub_customer', toColumn: 'customer_hk', cardinality: 'many-to-one' }]),
  ];
  const HOMES = new Map([
    ['hub_customer', { layer: 'raw_vault', schema: 'raw_vault' }],
    ['sat_customer', { layer: 'raw_vault', schema: 'raw_vault' }],
    ['link_order', { layer: 'raw_vault', schema: 'raw_vault' }],
    ['hub_order', { layer: 'raw_vault', schema: 'raw_vault' }],
    ['pit_customer', { layer: 'business_vault', schema: 'business_vault' }],
  ]);
  const LAYER_CONFIGS = [
    { id: 'raw_vault', label: 'Raw Vault', abbreviation: 'RV', color: '#64748b', order: 0 },
    { id: 'business_vault', label: 'Business Vault', abbreviation: 'BV', color: '#8b5cf6', order: 1 },
  ];
  const RV = '/p/.erd-studio/raw_vault/relationships';
  const AT: Record<string, { filePath: string; line: number }> = {
    'sat_customer.customer_hk': { filePath: `${RV}/raw_vault.dbml`, line: 3 },
    'link_order.order_hk': { filePath: `${RV}/links.dbml`, line: 2 },
    'link_order.customer_hk': { filePath: `${RV}/links.dbml`, line: 1 },
    'pit_customer.customer_hk': { filePath: '/p/.erd-studio/business_vault/relationships/business_vault.dbml', line: 4 },
  };
  const EXT = vscode.Uri.file('/ext');
  const tip = (item: vscode.TreeItem): string => (typeof item.tooltip === 'string' ? item.tooltip : String((item.tooltip as vscode.MarkdownString).value));
  const purple = (item: vscode.TreeItem): [string, string | undefined] =>
    [(item.iconPath as vscode.ThemeIcon).id, ((item.iconPath as vscode.ThemeIcon).color as vscode.ThemeColor | undefined)?.id];

  function vault(icons = false) {
    return new RelationshipsTreeProvider(
      libraryWith(VAULT) as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio',
      icons ? (kind) => dbmlFileIcon(EXT, kind) : undefined,
      () => HOMES, () => LAYER_CONFIGS as never,
      (rel) => AT[`${rel.fromModel}.${rel.fromColumn}`],
    );
  }

  it('is compact until told otherwise', () => {
    expect(vault().getRowDetails()).toBe('compact');
  });

  it('a table row shows just its number of relationships, plus problems; its hover has the words', async () => {
    const provider = new RelationshipsTreeProvider(libraryWith(TABLES) as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio');
    const rows = await provider.getChildren();
    const item = (name: string) => provider.getTreeItem(rows.find((r) => r.type === 'table' && r.group.table === name)!);
    expect(item('fct_order').description).toBe('2 · 1 problem');
    expect(tip(item('fct_order'))).toContain('2 relationships · 1 problem');
    expect(item('dim_customer').description).toBe('1');
    expect(tip(item('dim_customer'))).toContain('1 relationship');
    // "Needs attention" counts its rows the same way.
    const attention = provider.getTreeItem(rows[0]);
    expect(attention.description).toBe('1');
    expect(tip(attention)).toContain('1 relationship');
    provider.setRowDetails('full');
    expect(provider.getTreeItem(rows.find((r) => r.type === 'table' && r.group.table === 'fct_order')!).description).toBe('2 relationships · 1 problem');
  });

  it('draws a table row with the relationships glyph, never the Table Library\'s table icon', async () => {
    const withIcons = vault(true);
    const [raw] = await withIcons.getChildren();
    const [hub] = await withIcons.getChildren(raw);
    expect(withIcons.getTreeItem(hub).iconPath).toBe(dbmlFileIcon(EXT, 'relationships'));
    expect(withIcons.getTreeItem(hub).iconPath).not.toBe(dbmlFileIcon(EXT, 'table'));
    // Without the DBML icons: a plain codicon (colour in the sidebar means the layer).
    const plain = new RelationshipsTreeProvider(libraryWith(TABLES) as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio');
    const fct = (await plain.getChildren()).find((r) => r.type === 'table' && r.group.table === 'fct_order')!;
    expect(purple(plain.getTreeItem(fct))).toEqual(['references', undefined]);
  });

  it('draws relationship rows as plain arrows; a problem keeps its warning', async () => {
    const provider = new RelationshipsTreeProvider(libraryWith(TABLES) as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio');
    const rows = await provider.getChildren();
    const fct = rows.find((r) => r.type === 'table' && r.group.table === 'fct_order')!;
    const dim = rows.find((r) => r.type === 'table' && r.group.table === 'dim_customer')!;
    const [out, broken] = (await provider.getChildren(fct)).map((r) => provider.getTreeItem(r));
    expect(purple(out)).toEqual(['arrow-right', undefined]);
    expect(purple(broken)).toEqual(['warning', 'list.warningForeground']);
    expect(purple(provider.getTreeItem((await provider.getChildren(dim))[0]))).toEqual(['arrow-left', undefined]);
    const [problem] = await provider.getChildren(rows[0]);
    expect(purple(provider.getTreeItem(problem))).toEqual(['warning', 'list.warningForeground']);
    // Grouped by file: a stored relationship is a two-way arrow.
    const byFile = vault();
    byFile.setGrouping('file');
    const [rawRow] = await byFile.getChildren();
    const [links] = await byFile.getChildren(rawRow);
    const [stored] = await byFile.getChildren(links);
    expect(purple(byFile.getTreeItem(stored))).toEqual(['arrow-both', undefined]);
  });

  it('a relationship row names a shared column once, and keeps cross-layer and role text', async () => {
    const provider = vault();
    const [raw] = await provider.getChildren();
    const hub = (await provider.getChildren(raw)).find((t) => t.type === 'table' && t.group.table === 'hub_customer')!;
    const rows = new Map((await provider.getChildren(hub)).map((r) => [provider.getTreeItem(r).label, provider.getTreeItem(r).description]));
    expect(rows.get('sat_customer')).toBe('customer_hk · 1:N');
    expect(rows.get('pit_customer')).toBe('in Business Vault · customer_hk · 1:N · tracks');
    const differ = new RelationshipsTreeProvider(libraryWith([
      table('dim_date', ['date_sk']),
      table('fct_order', ['order_date_sk'], [{ fromColumn: 'order_date_sk', toModel: 'dim_date', toColumn: 'date_sk', cardinality: 'many-to-one' }]),
    ]) as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio');
    const [, fct] = await differ.getChildren();
    expect(differ.getTreeItem((await differ.getChildren(fct))[0]).description).toBe('order_date_sk → date_sk · N:1');
  });

  it('a layer row says "Layer"; its hover has the tables and relationships it counts', async () => {
    const provider = vault();
    const [raw, business, other] = await provider.getChildren();
    const rawItem = provider.getTreeItem(raw);
    expect(rawItem.description).toBe('Layer');
    expect(tip(rawItem)).toContain('4 tables · 5 relationships');
    expect(provider.getTreeItem(business).description).toBe('Layer');
    // "Other tables" (no layer of their own) says nothing beside its name; its hover counts.
    const otherItem = provider.getTreeItem(other);
    expect(otherItem.label).toBe('Other tables');
    expect(otherItem.description).toBeUndefined();
    expect(tip(otherItem)).toContain('1 table · 1 relationship');
  });

  it('grouped by file: a layer row says "Layer", a file row its count; the hovers have the rest', async () => {
    const provider = vault();
    provider.setGrouping('file');
    const [raw, , other] = await provider.getChildren();
    const rawItem = provider.getTreeItem(raw);
    expect(rawItem.description).toBe('Layer');
    expect(tip(rawItem)).toContain('2 files · 3 relationships');
    const [links] = await provider.getChildren(raw);
    const linksItem = provider.getTreeItem(links);
    expect(linksItem.description).toBe('2');
    expect(tip(linksItem)).toContain('a relationships file of the Raw Vault layer');
    expect(tip(linksItem)).toContain('2 relationships');
    expect(linksItem.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    const otherItem = provider.getTreeItem(other);
    expect(otherItem.description).toBeUndefined();
    expect(tip(otherItem)).toContain('1 relationship');
  });

  it('still says why a filtered row matched', async () => {
    const provider = vault();
    provider.setFilter('file:business_vault');
    // The one match joins two layers: it is listed under both.
    const layers = await provider.getChildren();
    expect(layers.map((l) => (l.type === 'layer' ? l.layer : l.type))).toEqual(['raw_vault', 'business_vault']);
    const business = layers[1];
    expect(provider.getTreeItem(business).description).toBe('Layer');
    const [pit] = await provider.getChildren(business);
    expect(provider.getTreeItem(pit).description).toBe('1');
    const [row] = await provider.getChildren(pit);
    expect(provider.getTreeItem(row).description).toBe('in Raw Vault · customer_hk · N:1 · tracks · in business_vault');
  });

  it('gives the view\'s total for its title: the project\'s relationships, also while filtered', async () => {
    const provider = vault();
    expect(provider.headerTotal()).toBeUndefined();
    await provider.getChildren();
    expect(provider.headerTotal()).toBe('5 relationships · by table');
    provider.setFilter('pit_customer');
    await provider.getChildren();
    expect(provider.headerTotal()).toBe('5 relationships · by table');
    const one = new RelationshipsTreeProvider(libraryWith([
      table('a', ['id']), table('b', ['a_id'], [{ fromColumn: 'a_id', toModel: 'a', toColumn: 'id', cardinality: 'many-to-one' }]),
    ]) as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio');
    await one.getChildren();
    expect(one.headerTotal()).toBe('1 relationship · by table');
    const none = new RelationshipsTreeProvider(libraryWith([table('a', ['id'])]) as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio');
    await none.getChildren();
    expect(none.headerTotal()).toBeUndefined();
  });
});
