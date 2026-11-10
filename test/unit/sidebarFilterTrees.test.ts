/**
 * The three sidebar views filtered (`setFilter`), with the real services on
 * the `dbml-native` fixture (plus one table no diagram shows): only the
 * matching rows and the rows they sit in are listed, those ancestors get a
 * fresh id so VS Code shows them expanded, the matched part of a label is
 * highlighted and a row says why it matched when its name did not, each
 * listing reports what it found (`onDidFilter`, for the view's message), a
 * filter that matches nothing lists one Clear Filter row, and clearing
 * restores the full tree. Reveal (getParent / findTableNode) keeps working
 * on the filtered tree; `col:` reads unread table files, and only it does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SubjectAreaTreeProvider, diagramDescriptionOf, type TreeElement } from '../../src/providers/DomainTreeProvider';
import { TableLibraryTreeProvider, TABLE_LIBRARY_VIEW_ID, type TableLibraryNode, type TableLibraryTableNode } from '../../src/providers/ModelLibraryTreeProvider';
import { RelationshipsTreeProvider, type RelationshipsNode } from '../../src/providers/RelationshipsTreeProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { tableHomesOf } from '../../src/services/tableHomes';
import type { FilterOutcome } from '../../src/services/treeSearch';
import type { SemanticTable } from '../../src/types/semantic';

const NATIVE = path.resolve(__dirname, '../fixtures/dbml-native');
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-tree-filter-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  // A table no diagram shows (`is:unused`).
  fs.writeFileSync(path.join(root, '.erd-studio/gold/tables/gold/stg_unused.dbml'), 'Table gold.stg_unused {\n  id INT [pk]\n}\n');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function services() {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return { layerService, subjectAreaService, tableLibraryService };
}

/** Every outcome a provider reported, last last. */
function outcomes(provider: { onDidFilter: vscode.Event<FilterOutcome | undefined> }): Array<FilterOutcome | undefined> {
  const seen: Array<FilterOutcome | undefined> = [];
  provider.onDidFilter((o) => seen.push(o));
  return seen;
}

const labelOf = (item: vscode.TreeItem): string => (typeof item.label === 'string' ? item.label : item.label?.label ?? '');

// ---------------------------------------------------------------------------
// Table Library
// ---------------------------------------------------------------------------

describe('Table Library filtered', () => {
  function provider(read = true) {
    const s = services();
    // Most tests filter on what a table's file says: read every file first, as the background read does.
    if (read) for (const e of s.tableLibraryService.listTableFiles()) s.tableLibraryService.getTableFileError(e.name);
    const p = new TableLibraryTreeProvider(s.tableLibraryService, s.subjectAreaService, root, '.erd-studio', () => s.layerService.getAllLayers());
    return { p, ...s };
  }
  const tables = (nodes: readonly TableLibraryNode[] | undefined): TableLibraryTableNode[] =>
    (nodes ?? []).flatMap((n) => (n.type === 'model' ? [n] : n.type === 'noMatch' ? [] : tables(n.children)));
  const names = (p: TableLibraryTreeProvider): string[] => tables(p.getChildren()).map((t) => t.name).sort();

  it('lists the matching tables under their layer (expanded, with a fresh id), counts them, and clears back to the full tree', () => {
    const { p } = provider();
    // Full rows: the layer row counts what is shown (compact: below).
    p.setRowDetails('full');
    const seen = outcomes(p);
    const full = p.getChildren()!;
    expect(seen.at(-1)).toBeUndefined();
    const unfilteredIds = full.map((row) => p.getTreeItem(row).id);

    p.setFilter('customer');
    const rows = p.getChildren()!;
    expect(rows.map((r) => r.type === 'layer' && r.layer)).toEqual(['gold']);
    expect(names(p)).toEqual(['customer_profile', 'dim_customer']);
    const layer = p.getTreeItem(rows[0]);
    expect(layer.id).toBe(`erdStudio.modelLibrary.layer:gold#filter1`);
    expect(layer.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    // The layer row counts what is shown.
    expect(layer.description).toBe('Layer · 2 tables');
    const outcome = seen.at(-1)!;
    expect([outcome.shown, outcome.total, outcome.query.text]).toEqual([2, 7, 'customer']);
    expect(p.getFilter()).toBe('customer');
    expect(p.isFiltered()).toBe(true);

    // A new filter is a new generation: VS Code shows the ancestors expanded again.
    p.setFilter('customer_');
    expect(p.getTreeItem(p.getChildren()![0]).id).toBe('erdStudio.modelLibrary.layer:gold#filter2');

    p.setFilter('');
    expect(p.isFiltered()).toBe(false);
    const again = p.getChildren()!;
    expect(again.map((row) => p.getTreeItem(row).id)).toEqual(unfilteredIds);
    expect(tables(again)).toHaveLength(tables(full).length);
    expect(seen.at(-1)).toBeUndefined();
    p.dispose();
  });

  it('highlights the matched part of a name, and says why a row matched when its name did not', () => {
    const { p } = provider();
    p.setRowDetails('full');
    p.setFilter('cust');
    const profile = tables(p.getChildren()).find((t) => t.name === 'customer_profile')!;
    expect(p.getTreeItem(profile).label).toEqual({ label: 'customer_profile', highlights: [[0, 4]] });

    p.setFilter('col:customer_id');
    const [dim] = tables(p.getChildren());
    expect(dim.name).toBe('dim_customer');
    const item = p.getTreeItem(dim);
    // Not highlighted (the name did not match), and the row says which column did.
    expect(item.label).toBe('dim_customer');
    expect(item.description).toBe('on 1 diagram · column customer_id');
  });

  it('compact rows still say why a row matched, and a filtered layer row says only "Layer"', () => {
    const { p } = provider();
    expect(p.getRowDetails()).toBe('compact');
    p.setFilter('col:customer_id');
    const [layer] = p.getChildren()!;
    const layerItem = p.getTreeItem(layer);
    expect(layerItem.description).toBe('Layer');
    expect(layerItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    const [dim] = tables(p.getChildren());
    // "on 1 diagram" is hover-only in compact rows; the reason is not.
    expect(p.getTreeItem(dim).description).toBe('column customer_id');
    // The owner is hover-only in compact rows, unless the filter matched it: then it is why the row shows.
    p.setFilter('owner:sales');
    const owned = tables(p.getChildren());
    expect(owned.map((t) => [t.name, p.getTreeItem(t).description])).toEqual([['fct_order', 'as orders · sales-data']]);
    p.setFilter('fct_order');
    expect(tables(p.getChildren()).map((t) => p.getTreeItem(t).description)).toEqual(['as orders']);
    p.dispose();
  });

  it('keeps a schema folder and its layer, both expanded, for a table in one', () => {
    const { p } = provider();
    p.setFilter('layer:silver');
    const rows = p.getChildren()!;
    expect(rows).toHaveLength(1);
    const [folder] = p.getChildren(rows[0])!;
    expect(folder).toMatchObject({ type: 'folder', folder: 'calendar' });
    const item = p.getTreeItem(folder);
    expect(item.id).toMatch(/^erdStudio\.modelLibrary\.folder:silver\/tables\/calendar#filter\d+$/);
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    expect(names(p)).toEqual(['dim_date']);
    // A plain word highlights the layer row's label too.
    p.setFilter('silv');
    expect(p.getTreeItem(p.getChildren()![0]).label).toEqual({ label: 'Silver', highlights: [[0, 4]] });
  });

  it('filters by owner, type, schema, warehouse name, description, diagram and is:unused', () => {
    const { p } = provider();
    const by = (text: string): string[] => {
      p.setFilter(text);
      return names(p);
    };
    expect(by('owner:sales')).toEqual(['fct_order']);
    expect(by('type:fact')).toEqual(['fct_order']);
    expect(by('type:conformed')).toEqual(['dim_customer', 'dim_date']);
    expect(by('schema:calendar')).toEqual(['dim_date']);
    // The warehouse name, and words in a table's note.
    expect(by('orders')).toEqual(['fct_order']);
    expect(by('"calendar dimension"')).toEqual(['dim_date']);
    expect(by('diagram:staging')).toEqual(['dim_date', 'fct_order']);
    expect(by('is:unused')).toEqual(['stg_unused']);
    expect(by('dim -customer')).toEqual(['dim_date', 'dim_region']);
    expect(by('dim layer:gold')).toEqual(['dim_customer', 'dim_region']);
    p.setFilter('type:fact');
    expect(p.getTreeItem(tables(p.getChildren())[0]).description).toMatch(/· Transaction fact$/);
  });

  it('lists one Clear Filter row when nothing matches, never an empty view', () => {
    const { p } = provider();
    const seen = outcomes(p);
    p.setFilter('no_such_thing');
    const rows = p.getChildren()!;
    expect(rows).toEqual([{ type: 'noMatch', children: [] }]);
    const item = p.getTreeItem(rows[0]);
    expect(item.label).toBe('No tables match the filter');
    expect(item.command).toMatchObject({ command: 'erdStudio.clearTableLibraryFilter' });
    expect(p.getParent(rows[0])).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ shown: 0, total: 7 });
    // The library still has rows: "No tables yet" stays hidden.
    expect(p.isLoading()).toBe(true);
  });

  it('reveals a shown table through its filtered layer, and finds no hidden one', () => {
    const { p } = provider();
    p.setFilter('date');
    const node = p.findTableNode('dim_date')!;
    expect(node).toBeDefined();
    const folder = p.getParent(node)!;
    expect(folder).toMatchObject({ type: 'folder', folder: 'calendar', filterGeneration: 1 });
    const layer = p.getParent(folder)!;
    expect(layer).toMatchObject({ type: 'layer', layer: 'silver' });
    // The parent VS Code is given lists the node back.
    expect(p.getChildren(folder)!.some((c) => c.type === 'model' && c.name === 'dim_date')).toBe(true);
    expect(p.findTableNode('fct_order')).toBeUndefined();
    p.setFilter('');
    expect(p.findTableNode('fct_order')).toBeDefined();
  });

  it('reads unread table files for col: only, with the view\'s progress bar, then lists again', async () => {
    vi.useFakeTimers();
    const { p, tableLibraryService } = provider(false);
    const seen = outcomes(p);
    const reads = vi.spyOn(tableLibraryService, 'getTableFileError');
    const progress = vi.spyOn(vscode.window, 'withProgress');
    const changed = vi.fn();
    p.onDidChangeTreeData(changed);

    p.getChildren();
    p.setFilter('customer owner:sales');
    p.getChildren();
    expect(progress).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();

    p.setFilter('col:customer_id');
    expect(names(p)).toEqual([]);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls[0][0]).toEqual({ location: { viewId: TABLE_LIBRARY_VIEW_ID } });
    expect(seen.at(-1)).toMatchObject({ reading: true, shown: 0 });
    changed.mockClear();

    await vi.runAllTimersAsync();
    await p.whenFilterRead();
    expect(reads.mock.calls.map((c) => c[0]).sort()).toEqual(tableLibraryService.listTableFiles().map((e) => e.name).sort());
    // The read lists again, and the column now matches.
    expect(changed).toHaveBeenCalled();
    expect(names(p)).toEqual(['dim_customer']);
    expect(seen.at(-1)).toMatchObject({ shown: 1 });
    expect(seen.at(-1)?.reading).toBeUndefined();
    p.dispose();
  });
});

// ---------------------------------------------------------------------------
// Diagrams
// ---------------------------------------------------------------------------

describe('Diagrams filtered', () => {
  function provider() {
    const s = services();
    const p = new SubjectAreaTreeProvider(s.subjectAreaService, s.layerService, root, '.erd-studio', undefined, undefined,
      () => tableHomesOf(s.tableLibraryService.listTableFiles()));
    return p;
  }
  /** Each listed layer with its diagrams' names. */
  const listing = (p: SubjectAreaTreeProvider): Array<[string, string[]]> => (p.getChildren() ?? []).flatMap((row): Array<[string, string[]]> =>
    row.type === 'layer'
      ? [[row.layer, (p.getChildren(row) ?? []).map((c) => (c.type === 'domain' ? c.summary.domain : c.type))]]
      : [[row.type, []]]);

  it('lists the matching diagrams under their layers, without the New Diagram… / New Layer… rows, and clears back', () => {
    const p = provider();
    // Full rows: every creatable layer ends with New Diagram…, and a layer row counts its diagrams (compact: below).
    p.setRowDetails('full');
    const seen = outcomes(p);
    expect(listing(p)).toEqual([['silver', ['staging', 'newDomain']], ['gold', ['sales', 'newDomain']], ['newLayer', []]]);
    p.setFilter('sales');
    expect(listing(p)).toEqual([['gold', ['sales']]]);
    expect(seen.at(-1)).toMatchObject({ shown: 1, total: 2 });
    const [gold] = p.getChildren()!;
    const item = p.getTreeItem(gold);
    expect(item.id).toBe('erdStudio.diagrams.layer:gold#filter1');
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    expect(item.description).toBe('Layer · 1 diagram');
    const [sales] = p.getChildren(gold)!;
    expect(p.getTreeItem(sales).label).toEqual({ label: 'sales', highlights: [[0, 5]] });
    p.setFilter('');
    expect(listing(p)).toEqual([['silver', ['staging', 'newDomain']], ['gold', ['sales', 'newDomain']], ['newLayer', []]]);
    expect(p.getTreeItem(p.getChildren()![0]).id).toBe('erdStudio.diagrams.layer:silver');
  });

  it('compact: no New Diagram… row under a layer that has diagrams; a filtered layer row says "Layer"; reasons still show', () => {
    const p = provider();
    expect(listing(p)).toEqual([['silver', ['staging']], ['gold', ['sales']], ['newLayer', []]]);
    p.setFilter('dim_region');
    const [gold] = p.getChildren()!;
    expect(p.getTreeItem(gold).description).toBe('Layer');
    const [sales] = p.getChildren(gold)!;
    expect(p.getTreeItem(sales).description).toMatch(/has dim_region$/);
    expect(p.getTreeItem(sales).description).not.toMatch(/\btables?\b/);
    p.setFilter('');
    expect(listing(p)).toEqual([['silver', ['staging']], ['gold', ['sales']], ['newLayer', []]]);
  });

  it('matches a table the diagram shows, and says so; its layer, its description and table:/schema:', () => {
    const p = provider();
    p.setFilter('dim_region');
    expect(listing(p)).toEqual([['gold', ['sales']]]);
    const sales = p.getChildren(p.getChildren()![0])![0];
    expect(p.getTreeItem(sales).description).toMatch(/· has dim_region$/);
    p.setFilter('fct_order');
    expect(listing(p)).toEqual([['silver', ['staging']], ['gold', ['sales']]]);
    p.setFilter('layer:silver');
    expect(listing(p)).toEqual([['silver', ['staging']]]);
    p.setFilter('star');
    expect(listing(p)).toEqual([['gold', ['sales']]]);
    expect(p.getTreeItem(p.getChildren(p.getChildren()![0])![0]).description).toMatch(/· in description$/);
    p.setFilter('schema:calendar -diagram:sales');
    expect(listing(p)).toEqual([['silver', ['staging']]]);
    p.setFilter('table:customer_profile');
    expect(listing(p)).toEqual([['gold', ['sales']]]);
  });

  it('lists one Clear Filter row when nothing matches', () => {
    const p = provider();
    p.setFilter('nothing_here');
    const rows = p.getChildren()!;
    expect(rows).toEqual([{ type: 'noMatch' } satisfies TreeElement]);
    expect(p.getTreeItem(rows[0]).command).toMatchObject({ command: 'erdStudio.clearDiagramsFilter' });
    expect(p.isLoading()).toBe(true);
  });

  it('reads a diagram\'s description from a DBML Project note or a JSON description', () => {
    const sales = fs.readFileSync(path.join(root, '.erd-studio/gold/diagrams/sales.dbml'), 'utf-8');
    expect(diagramDescriptionOf(sales, 'sales.dbml')).toBe('Sales star schema');
    expect(diagramDescriptionOf("Project p {\n  Note: '''\n  Many\n  lines\n  '''\n}\n", 'p.dbml')).toBe('Many\n  lines');
    expect(diagramDescriptionOf('Project p {\n  erd_schema_version: \'7\'\n}\n', 'p.dbml')).toBe('');
    expect(diagramDescriptionOf(JSON.stringify({ description: ' Orders ' }), 'x.json')).toBe('Orders');
    expect(diagramDescriptionOf('{ broken', 'x.json')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

describe('Relationships filtered', () => {
  function provider() {
    const s = services();
    return new RelationshipsTreeProvider(
      s.tableLibraryService,
      s.subjectAreaService,
      root,
      '.erd-studio',
      undefined,
      () => tableHomesOf(s.tableLibraryService.listTableFiles()),
      () => s.layerService.getAllLayers(),
      (rel) => s.tableLibraryService.relationshipLocation(rel),
    );
  }
  /** Every row under `rows`, as `label` (`  ` per level). */
  async function outline(p: RelationshipsTreeProvider, rows?: RelationshipsNode[], depth = 0): Promise<string[]> {
    const out: string[] = [];
    for (const row of rows ?? await p.getChildren()) {
      out.push(`${'  '.repeat(depth)}${labelOf(p.getTreeItem(row))}`);
      out.push(...await outline(p, await p.getChildren(row), depth + 1));
    }
    return out;
  }

  it('lists the matching relationships under each of their tables, expanded, and counts them', async () => {
    const p = provider();
    const seen = outcomes(p);
    const all = await outline(p);
    p.setFilter('is:composite');
    expect(await outline(p)).toEqual(['Gold', '  dim_region', '    fct_order', '  fct_order', '    dim_region']);
    expect(seen.at(-1)).toMatchObject({ shown: 1, total: 8 });
    const [gold] = await p.getChildren();
    const [table] = await p.getChildren(gold);
    const item = p.getTreeItem(table);
    expect(item.id).toBe('erdStudio.relationships.table:dim_region#filter1');
    // A table row is collapsed unfiltered; filtered, its matches show.
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    p.setFilter('');
    expect(await outline(p)).toEqual(all);
  });

  it('filters by either end, a column, a layer, the file that stores it and is:cross-layer', async () => {
    const p = provider();
    const seen = outcomes(p);
    const count = async (text: string): Promise<number | undefined> => {
      p.setFilter(text);
      await p.getChildren();
      return seen.at(-1)?.shown;
    };
    expect(await count('is:cross-layer')).toBe(2);
    expect(await count('col:ship')).toBe(1);
    expect(await count('file:calendar')).toBe(1);
    expect(await count('table:customer_profile')).toBe(2);
    expect(await count('dim_customer -fct_order')).toBe(2);
    expect(await count('layer:silver')).toBe(3);
    // A row says which file stores it when grouped by table.
    p.setFilter('file:customers');
    const [gold] = await p.getChildren();
    const [first] = await p.getChildren(gold);
    const [rel] = await p.getChildren(first);
    expect(p.getTreeItem(rel).description).toMatch(/· in customers$/);
  });

  it('filters the file grouping too, keeping each file under its layer', async () => {
    const p = provider();
    p.setGrouping('file');
    p.setFilter('file:customers');
    expect(await outline(p)).toEqual(['Gold', '  customers', '    customer_profile → dim_customer', '    customer_profile → dim_region', '    dim_customer → dim_customer']);
    p.setFilter('ship');
    expect(await outline(p)).toEqual(['Gold', '  gold', '    fct_order → dim_date']);
  });

  it('reveals a shown table through its filtered layer, and finds no hidden one', async () => {
    const p = provider();
    p.setFilter('is:composite');
    const node = await p.findTableNode('dim_region');
    expect(node).toBeDefined();
    const parent = p.getParent(node!)!;
    expect(parent).toMatchObject({ type: 'layer', layer: 'gold' });
    expect((parent as { groups: Array<{ table: string }> }).groups.map((g) => g.table)).toEqual(['dim_region', 'fct_order']);
    expect(await p.findTableNode('dim_date')).toBeUndefined();
  });

  it('lists one Clear Filter row when nothing matches', async () => {
    const p = provider();
    p.setFilter('is:problem');
    const rows = await p.getChildren();
    expect(rows).toEqual([{ type: 'noMatch' }]);
    expect(p.getTreeItem(rows[0]).command).toMatchObject({ command: 'erdStudio.clearRelationshipsFilter' });
  });

  it('is:problem keeps the relationships that need attention', async () => {
    const table = (name: string, columns: string[], relationships: SemanticTable['relationships'] = []): SemanticTable =>
      ({ name, columns: columns.map((c) => ({ name: c })), ...(relationships.length ? { relationships } : {}) }) as SemanticTable;
    const tables = [
      table('dim_customer', ['customer_sk']),
      table('fct_order', ['customer_sk', 'store_sk'], [
        { fromColumn: 'customer_sk', toModel: 'dim_customer', toColumn: 'customer_sk', cardinality: 'many-to-one' },
        { fromColumn: 'store_sk', toModel: 'dim_store', toColumn: 'store_sk', cardinality: 'many-to-one' },
      ]),
    ];
    const service = {
      dirExists: () => true,
      listTables: () => tables,
      listTableFiles: () => tables.map((t) => ({ name: t.name, folder: '', filePath: `/lib/${t.name}.yml` })),
      tableStorage: () => 'yaml' as const,
    };
    const p = new RelationshipsTreeProvider(service as never, { listSubjectAreas: () => [] } as never, '/p', '.erd-studio');
    p.setFilter('is:problem');
    expect(await outline(p)).toEqual(['Needs attention', '  fct_order → dim_store', 'dim_store', '  fct_order', 'fct_order', '  dim_store']);
    p.setFilter('-is:problem');
    expect(await outline(p)).toEqual(['dim_customer', '  fct_order', 'fct_order', '  dim_customer']);
  });
});
