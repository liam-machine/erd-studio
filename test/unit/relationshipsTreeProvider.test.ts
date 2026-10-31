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
import { diagramsShowing, openInDiagram, openRelationshipSource, relationshipLineInYaml, revealTarget, type RelationshipsViewDeps } from '../../src/commands/relationshipsView';
import type { TableLibraryService } from '../../src/services/logicalModelService';
import type { SubjectAreaService } from '../../src/services/domainService';
import type { SemanticTable, SubjectAreaSummary } from '../../src/types/semantic';

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
  const provider = new RelationshipsTreeProvider(service as unknown as TableLibraryService, noDiagrams, '/p', '.erd-studio');
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

  it('says so when no diagram shows both tables', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    await openInDiagram(await relationshipNode(), deps({ memberNames: () => ['fct_order'] }));
    expect(String(info.mock.calls[0][0])).toBe('ERD Studio: No diagram shows both "fct_order" and "dim_customer" yet. To add them, open a diagram and use + Add → Add Existing Table.');
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
