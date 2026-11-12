/**
 * Finding a table across the project (`src/commands/goToTable.ts`): Go to
 * Table…'s rows and buttons, Add to Diagram…'s diagram list, and the table
 * side of Open in Diagram (`openInDiagram` selecting the table, offering Add
 * to a Diagram… when no diagram shows it, leaving out the diagram the canvas
 * is on). Plus the contributions that put them in the palette, the Table
 * Library's title bar and its right-click menu.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  GO_TO_TABLE_PLACEHOLDER,
  OPEN_FILE_BUTTON,
  OPEN_IN_DIAGRAM_BUTTON,
  SHOW_RELATIONSHIPS_BUTTON,
  OPEN_DIAGRAM_NOTE,
  ADDED_TO_DIAGRAM_STATUS_MS,
  addToDiagramCommand,
  addedToDiagramStatus,
  diagramToAddTo,
  withOpenDiagramFirst,
  buildGoToTableItems,
  diagramPickItems,
  diagramUsage,
  diagramsDetail,
  goToTableCommand,
  projectRelativePath,
  tablesFromTreeArgs,
  type GoToTableDeps,
  type GoToTableItem,
  type TableDetails,
} from '../../src/commands/goToTable';
import { ADD_TO_DIAGRAM, openInDiagram, type RelationshipsViewDeps } from '../../src/commands/relationshipsView';
import { NO_LEGACY_ALIAS } from '../../src/extension';
import type { TableFileEntry } from '../../src/services/logicalModelService';
import type { SubjectAreaSummary } from '../../src/types/semantic';

const SEM = '/p/.erd-studio';
const dbml = (name: string, layer: string, schema: string, extra: Partial<TableFileEntry> = {}): TableFileEntry => ({
  name, folder: schema, layer, storage: 'dbml', filePath: `${SEM}/${layer}/tables/${schema}/${name}.dbml`, ...extra,
});
const yaml = (name: string, folder = ''): TableFileEntry => ({
  name, folder, storage: 'yaml', filePath: `${SEM}/logical-models/${folder ? `${folder}/` : ''}${name}.yml`,
});
const diagram = (domain: string, layer = 'gold'): SubjectAreaSummary => ({ domain, layer, filePath: `${SEM}/${layer}/diagrams/${domain}.dbml`, storage: 'dbml' });
const LABELS: Record<string, string> = { gold: 'Gold', silver: 'Silver' };
const layerLabel = (id: string): string => LABELS[id] ?? id;

afterEach(() => vi.restoreAllMocks());

describe('Go to Table rows', () => {
  const entries = [
    dbml('fct_order', 'gold', 'sales'),
    dbml('dim_customer', 'gold', 'sales'),
    dbml('dim_customer', 'silver', 'crm', { shadowedBy: `${SEM}/gold/tables/sales/dim_customer.dbml` }),
    dbml('dim_date', 'silver', 'calendar'),
    yaml('stg_orders', 'silver'),
  ];
  const homes = new Map([
    ['fct_order', { layer: 'gold', schema: 'sales' }],
    ['dim_customer', { layer: 'gold', schema: 'sales' }],
    ['dim_date', { layer: 'silver', schema: 'calendar' }],
  ]);

  it('name each table once, sorted, with schema · layer · alias · owner and the diagrams that show it', () => {
    const usage = diagramUsage([diagram('sales'), diagram('finance')], (p) => (p.endsWith('sales.dbml') ? ['fct_order', 'DIM_CUSTOMER'] : ['fct_order']));
    const rows = buildGoToTableItems({
      entries,
      homes,
      usage,
      layerLabel,
      details: (name) => (name === 'fct_order' ? { alias: 'orders', owner: 'Data Team' } : name === 'dim_customer' ? { alias: 'DIM_CUSTOMER' } : undefined),
    });
    expect(rows.map((r) => r.label)).toEqual(['dim_customer', 'dim_date', 'fct_order', 'stg_orders']);
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by.fct_order.description).toBe('sales · Gold · as orders · Data Team');
    expect(by.fct_order.detail).toBe('on sales, finance');
    // An alias that only differs in case says nothing new.
    expect(by.dim_customer.description).toBe('sales · Gold');
    expect(by.dim_customer.detail).toBe('on sales');
    // The duplicate copy is never listed: its file is the one used.
    expect(by.dim_customer.filePath).toBe(`${SEM}/gold/tables/sales/dim_customer.dbml`);
    expect(by.dim_date.detail).toBe('on no diagram');
    // A YAML table in a layer folder names the layer.
    expect(by.stg_orders.description).toBe('Silver');
  });

  it('list at most four diagrams, then how many more', () => {
    expect(diagramsDetail(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('on a, b, c, d and 2 more');
    expect(diagramsDetail([])).toBe('on no diagram');
  });

  it('skip a diagram that cannot be read', () => {
    const usage = diagramUsage([diagram('broken'), diagram('sales')], (p) => {
      if (p.endsWith('broken.dbml')) throw new Error('bad');
      return ['fct_order'];
    });
    expect(usage.get('fct_order')).toEqual(['sales']);
  });
});

/** A QuickPick stand-in: records what the command sets, and lets a test accept or press a button. */
function fakeQuickPick() {
  const listeners: Record<string, (arg?: unknown) => void> = {};
  const qp = {
    items: [] as GoToTableItem[],
    activeItems: [] as GoToTableItem[],
    selectedItems: [] as GoToTableItem[],
    value: '',
    title: '',
    placeholder: '',
    matchOnDescription: false,
    matchOnDetail: false,
    shown: false,
    disposed: false,
    show() { qp.shown = true; },
    hide() { listeners.hide?.(); },
    dispose() { qp.disposed = true; },
    onDidAccept(fn: () => void) { listeners.accept = fn; return { dispose() {} }; },
    onDidTriggerItemButton(fn: (e: unknown) => void) { listeners.button = fn; return { dispose() {} }; },
    onDidHide(fn: () => void) { listeners.hide = fn; return { dispose() {} }; },
    onDidChangeValue(fn: (value: string) => void) { listeners.value = fn as (arg?: unknown) => void; return { dispose() {} }; },
    accept(item: GoToTableItem) { qp.selectedItems = [item]; listeners.accept?.(); },
    /** Type into the box, as VS Code reports it. */
    type(value: string) { qp.value = value; listeners.value?.(value); },
    press(item: GoToTableItem, button: vscode.QuickInputButton) { listeners.button?.({ item, button }); },
  };
  return qp;
}

describe('Go to Table…', () => {
  const entries = [dbml('fct_order', 'gold', 'sales'), dbml('dim_customer', 'gold', 'sales')];
  const deps = (qp: ReturnType<typeof fakeQuickPick>, over: Partial<GoToTableDeps> = {}): GoToTableDeps => ({
    listTableFiles: () => entries,
    tableHomes: () => new Map([['fct_order', { layer: 'gold', schema: 'sales' }], ['dim_customer', { layer: 'gold', schema: 'sales' }]]),
    listSubjectAreas: () => [diagram('sales')],
    memberNames: () => ['fct_order'],
    layerLabel,
    peekDetails: () => ({}),
    openInDiagram: vi.fn(async () => undefined),
    openFile: vi.fn(async () => undefined),
    showRelationships: vi.fn(async () => undefined),
    createQuickPick: () => qp as unknown as vscode.QuickPick<GoToTableItem>,
    ...over,
  });

  /** Start the command and wait until its list shows. */
  async function start(d: GoToTableDeps, qp: ReturnType<typeof fakeQuickPick>, query?: string): Promise<{ done: Promise<void> }> {
    const done = goToTableCommand(d, query);
    await vi.waitFor(() => expect(qp.shown).toBe(true));
    // Wrapped: an async function returning a promise would wait for it.
    return { done };
  }

  it('lists every table, matching on the description and detail too, with the search filled in', async () => {
    const qp = fakeQuickPick();
    const d = deps(qp);
    const { done } = await start(d, qp, 'orders');
    expect(qp.matchOnDescription).toBe(true);
    expect(qp.matchOnDetail).toBe(true);
    expect(qp.value).toBe('orders');
    expect(qp.title).toBe('Go to Table');
    expect(qp.items.map((i) => i.label)).toEqual(['dim_customer', 'fct_order']);
    expect(qp.items[1].buttons).toEqual([OPEN_IN_DIAGRAM_BUTTON, OPEN_FILE_BUTTON, SHOW_RELATIONSHIPS_BUTTON]);
    qp.accept(qp.items[1]);
    await done;
    expect(d.openInDiagram).toHaveBeenCalledWith('fct_order');
    expect(qp.disposed).toBe(true);
  });

  it('runs each button', async () => {
    for (const [button, check] of [
      [OPEN_FILE_BUTTON, (d: GoToTableDeps) => expect(d.openFile).toHaveBeenCalledWith(`${SEM}/gold/tables/sales/fct_order.dbml`)],
      [SHOW_RELATIONSHIPS_BUTTON, (d: GoToTableDeps) => expect(d.showRelationships).toHaveBeenCalledWith('fct_order')],
      [OPEN_IN_DIAGRAM_BUTTON, (d: GoToTableDeps) => expect(d.openInDiagram).toHaveBeenCalledWith('fct_order')],
    ] as const) {
      const qp = fakeQuickPick();
      const d = deps(qp);
      const { done } = await start(d, qp);
      qp.press(qp.items.find((i) => i.table === 'fct_order')!, button);
      await done;
      check(d);
    }
  });

  it('fills in the warehouse name and owner of tables not read yet, after the list shows', async () => {
    const qp = fakeQuickPick();
    const d = deps(qp, {
      peekDetails: () => undefined,
      readDetails: (name) => (name === 'fct_order' ? { alias: 'orders', owner: 'Data Team' } : {}),
    });
    const { done } = await start(d, qp);
    expect(qp.items.find((i) => i.table === 'fct_order')!.description).toBe('sales · Gold');
    await vi.waitFor(() => expect(qp.items.find((i) => i.table === 'fct_order')!.description).toBe('sales · Gold · as orders · Data Team'));
    qp.hide();
    await done;
  });

  it('says so when the project has no tables', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    const qp = fakeQuickPick();
    await goToTableCommand(deps(qp, { listTableFiles: () => [] }));
    expect(qp.shown).toBe(false);
    expect(String(info.mock.calls[0][0])).toMatch(/no tables yet/);
  });
});

describe('Go to Table… with the sidebar\'s filter keys', () => {
  const entries = [dbml('fct_order', 'gold', 'sales'), dbml('dim_customer', 'gold', 'sales'), dbml('dim_date', 'silver', 'calendar')];
  const details: Record<string, TableDetails> = {
    fct_order: { owner: 'Data Team', role: 'transaction-fact', columns: ['order_id', 'customer_key'] },
    dim_customer: { role: 'conformed-dim', columns: ['customer_key', 'customer_id'], description: 'One row per customer' },
    dim_date: { role: 'conformed-dim', columns: ['date_key'] },
  };
  const deps = (qp: ReturnType<typeof fakeQuickPick>, over: Partial<GoToTableDeps> = {}): GoToTableDeps => ({
    listTableFiles: () => entries,
    tableHomes: () => new Map([
      ['fct_order', { layer: 'gold', schema: 'sales' }],
      ['dim_customer', { layer: 'gold', schema: 'sales' }],
      ['dim_date', { layer: 'silver', schema: 'calendar' }],
    ]),
    listSubjectAreas: () => [diagram('sales')],
    memberNames: () => ['fct_order', 'dim_customer'],
    layerLabel,
    peekDetails: (name) => details[name],
    openInDiagram: vi.fn(async () => undefined),
    openFile: vi.fn(async () => undefined),
    showRelationships: vi.fn(async () => undefined),
    createQuickPick: () => qp as unknown as vscode.QuickPick<GoToTableItem>,
    ...over,
  });
  async function open(qp: ReturnType<typeof fakeQuickPick>, d: GoToTableDeps, query?: string) {
    const done = goToTableCommand(d, query);
    await vi.waitFor(() => expect(qp.shown).toBe(true));
    return { done };
  }
  const shown = (qp: ReturnType<typeof fakeQuickPick>) => qp.items.map((i) => i.label);

  it('says in its placeholder that the filter keys work', () => {
    expect(GO_TO_TABLE_PLACEHOLDER).toMatch(/table name/);
    expect(GO_TO_TABLE_PLACEHOLDER).toContain('layer:gold');
    expect(GO_TO_TABLE_PLACEHOLDER).toContain('col:');
  });

  it('matches keys, phrases, exclusions and several words itself, and keeps the rows it matches showing', async () => {
    const qp = fakeQuickPick();
    const { done } = await open(qp, deps(qp));
    expect(qp.placeholder).toBe(GO_TO_TABLE_PLACEHOLDER);
    qp.type('layer:gold');
    expect(shown(qp)).toEqual(['dim_customer', 'fct_order']);
    // The QuickPick would hide a row the text does not fuzzy-match: these always show.
    expect(qp.items.every((i) => i.alwaysShow)).toBe(true);
    qp.type('cust layer:gold');
    expect(shown(qp)).toEqual(['dim_customer']);
    qp.type('col:customer_key -fct');
    expect(shown(qp)).toEqual(['dim_customer']);
    qp.type('type:fact');
    expect(shown(qp)).toEqual(['fct_order']);
    qp.type('owner:"data team"');
    expect(shown(qp)).toEqual(['fct_order']);
    qp.type('is:unused');
    expect(shown(qp)).toEqual(['dim_date']);
    qp.type('diagram:sales schema:sales');
    expect(shown(qp)).toEqual(['dim_customer', 'fct_order']);
    qp.type('"per customer"');
    expect(shown(qp)).toEqual(['dim_customer']);
    // Buttons and accepting work on a filtered row.
    qp.accept(qp.items[0]);
    await done;
    expect(qp.disposed).toBe(true);
  });

  it('leaves one plain word to the QuickPick\'s own matching, with every row back', async () => {
    const qp = fakeQuickPick();
    const { done } = await open(qp, deps(qp));
    qp.type('layer:gold');
    expect(qp.items).toHaveLength(2);
    qp.type('dim');
    expect(shown(qp)).toEqual(['dim_customer', 'dim_date', 'fct_order']);
    expect(qp.items.some((i) => i.alwaysShow)).toBe(false);
    qp.hide();
    await done;
  });

  it('applies keys in the search it opens with, and names a key it does not know in its title', async () => {
    const qp = fakeQuickPick();
    const { done } = await open(qp, deps(qp), 'layer:silver');
    expect(shown(qp)).toEqual(['dim_date']);
    qp.type('foo:bar cust');
    expect(qp.title).toBe('Go to Table · unknown filter key "foo:"');
    // Searched as the text it is: no table holds "foo:bar".
    expect(shown(qp)).toEqual([]);
    // Alone it is one plain word: the QuickPick's own matching, every row back.
    qp.type('foo:bar');
    expect(qp.title).toBe('Go to Table · unknown filter key "foo:"');
    expect(qp.items.some((i) => i.alwaysShow)).toBe(false);
    qp.type('');
    expect(qp.title).toBe('Go to Table');
    qp.hide();
    await done;
  });

  it('matches a table by its columns once its file is read in the background', async () => {
    const qp = fakeQuickPick();
    const { done } = await open(qp, deps(qp, {
      peekDetails: () => undefined,
      readDetails: (name) => details[name],
    }));
    qp.type('col:date_key');
    await vi.waitFor(() => expect(shown(qp)).toEqual(['dim_date']));
    qp.hide();
    await done;
  });
});

describe('Add to Diagram…', () => {
  const summaries = [diagram('sales'), diagram('staging', 'silver'), diagram('finance')];
  const members = (p: string): string[] | null =>
    (p.endsWith('sales.dbml') ? ['fct_order', 'dim_customer'] : p.endsWith('staging.dbml') ? ['fct_order'] : ['dim_date']);

  it('lists the diagrams with their layer and table count, leaving out those that show every table already', () => {
    const items = diagramPickItems(summaries, members, layerLabel, ['FCT_ORDER']);
    expect(items.map((i) => [i.label, i.description])).toEqual([['finance', 'Gold · 1 table']]);
    const both = diagramPickItems(summaries, members, layerLabel, ['fct_order', 'dim_date']);
    expect(both.map((i) => [i.label, i.description, i.detail])).toEqual([
      ['sales', 'Gold · 2 tables', 'Already shows fct_order'],
      ['staging', 'Silver · 1 table', 'Already shows fct_order'],
      ['finance', 'Gold · 1 table', 'Already shows dim_date'],
    ]);
  });

  it('acts on the whole selection when it holds the clicked row, never on a duplicate', () => {
    const row = (name: string, shadowedBy?: string) => ({ type: 'model', name, ...(shadowedBy ? { shadowedBy } : {}) });
    const a = row('a');
    const b = row('b');
    expect(tablesFromTreeArgs(a, [a, b, row('c', '/x')])).toEqual(['a', 'b']);
    expect(tablesFromTreeArgs(a, [b])).toEqual(['a']);
    expect(tablesFromTreeArgs(['x', 'y'], undefined)).toEqual(['x', 'y']);
    expect(tablesFromTreeArgs({ type: 'folder' }, undefined)).toEqual([]);
  });

  it('adds the tables to the picked diagram', async () => {
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => items[0]) as never);
    const addTables = vi.fn(async () => undefined);
    await addToDiagramCommand({ listSubjectAreas: () => summaries, memberNames: members, layerLabel, addTables }, ['dim_date']);
    expect((pick.mock.calls[0][1] as { placeHolder: string }).placeHolder).toBe('Add "dim_date" to which diagram?');
    expect(addTables).toHaveBeenCalledWith(`${SEM}/gold/diagrams/sales.dbml`, ['dim_date']);
  });

  it('offers the diagram in the active tab first, marked as open, so Enter adds to it', async () => {
    const items = diagramPickItems(summaries, members, layerLabel, ['dim_region']);
    expect(items.map((i) => i.label)).toEqual(['sales', 'staging', 'finance']);
    const first = withOpenDiagramFirst(items, `${SEM}/silver/diagrams/staging.dbml`);
    expect(first.map((i) => [i.label, i.description])).toEqual([
      ['staging', `Silver · 1 table · ${OPEN_DIAGRAM_NOTE}`],
      ['sales', 'Gold · 2 tables'],
      ['finance', 'Gold · 1 table'],
    ]);
    // No diagram in front, or one that is not offered (it shows the tables already): the list as it was.
    expect(withOpenDiagramFirst(items, undefined)).toEqual(items);
    expect(withOpenDiagramFirst(items, '/elsewhere/other.dbml')).toEqual(items);

    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (picks: Array<{ label: string }>) => picks[0]) as never);
    const addTables = vi.fn(async () => undefined);
    await addToDiagramCommand({
      listSubjectAreas: () => summaries, memberNames: members, layerLabel, addTables,
      activeDiagramPath: () => `${SEM}/silver/diagrams/staging.dbml`,
    }, ['dim_region', 'dim_date']);
    expect(addTables).toHaveBeenCalledWith(`${SEM}/silver/diagrams/staging.dbml`, ['dim_region', 'dim_date']);
  });

  // Gerhard: Add to Diagram should add to the diagram that is open, without asking.
  describe('with a diagram open', () => {
    const STAGING = `${SEM}/silver/diagrams/staging.dbml`;
    const SALES = `${SEM}/gold/diagrams/sales.dbml`;

    it('adds to the diagram in the active tab without asking, and the status bar says where', async () => {
      const pick = vi.spyOn(vscode.window, 'showQuickPick');
      const status = vi.spyOn(vscode.window, 'setStatusBarMessage');
      const addTables = vi.fn(async () => undefined);
      await addToDiagramCommand({ listSubjectAreas: () => summaries, memberNames: members, layerLabel, addTables, activeDiagramPath: () => STAGING }, ['dim_date']);
      expect(pick).not.toHaveBeenCalled();
      expect(addTables).toHaveBeenCalledWith(STAGING, ['dim_date']);
      expect(status).toHaveBeenCalledWith('$(check) ERD Studio: Added "dim_date" to staging', ADDED_TO_DIAGRAM_STATUS_MS);
    });

    it('adds to the only diagram on screen when the sidebar has focus (no diagram in the active tab)', async () => {
      const pick = vi.spyOn(vscode.window, 'showQuickPick');
      const addTables = vi.fn(async () => undefined);
      await addToDiagramCommand({
        listSubjectAreas: () => summaries, memberNames: members, layerLabel, addTables,
        activeDiagramPath: () => undefined, openDiagramPaths: () => [SALES],
      }, ['dim_date', 'dim_region']);
      expect(pick).not.toHaveBeenCalled();
      expect(addTables).toHaveBeenCalledWith(SALES, ['dim_date', 'dim_region']);
    });

    it('asks when two diagrams are on screen and neither is in the active tab, or none is open', async () => {
      const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async () => undefined) as never);
      const addTables = vi.fn(async () => undefined);
      await addToDiagramCommand({
        listSubjectAreas: () => summaries, memberNames: members, layerLabel, addTables,
        activeDiagramPath: () => undefined, openDiagramPaths: () => [SALES, STAGING],
      }, ['dim_date']);
      await addToDiagramCommand({ listSubjectAreas: () => summaries, memberNames: members, layerLabel, addTables, openDiagramPaths: () => [] }, ['dim_date']);
      expect(pick).toHaveBeenCalledTimes(2);
      expect(addTables).not.toHaveBeenCalled();
    });

    it('a table the open diagram shows already goes to it too (its canvas says it is already there), and the status bar names only what is new', async () => {
      const pick = vi.spyOn(vscode.window, 'showQuickPick');
      const status = vi.spyOn(vscode.window, 'setStatusBarMessage');
      const addTables = vi.fn(async () => undefined);
      await addToDiagramCommand({ listSubjectAreas: () => summaries, memberNames: members, layerLabel, addTables, activeDiagramPath: () => STAGING }, ['fct_order']);
      expect(pick).not.toHaveBeenCalled();
      expect(addTables).toHaveBeenCalledWith(STAGING, ['fct_order']);
      expect(status).not.toHaveBeenCalled();
      await addToDiagramCommand({ listSubjectAreas: () => summaries, memberNames: members, layerLabel, addTables, activeDiagramPath: () => STAGING }, ['fct_order', 'dim_date']);
      expect(status).toHaveBeenCalledWith(addedToDiagramStatus('"dim_date"', 'staging'), ADDED_TO_DIAGRAM_STATUS_MS);
    });

    it('Add to Diagram… (ask) always asks, the open diagram first, so another diagram can still be chosen', async () => {
      const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => items[1]) as never);
      const status = vi.spyOn(vscode.window, 'setStatusBarMessage');
      const addTables = vi.fn(async () => undefined);
      await addToDiagramCommand({ listSubjectAreas: () => summaries, memberNames: members, layerLabel, addTables, activeDiagramPath: () => STAGING }, ['dim_region'], { ask: true });
      expect(pick).toHaveBeenCalledTimes(1);
      expect((pick.mock.calls[0][0] as unknown as Array<{ label: string }>).map((i) => i.label)).toEqual(['staging', 'sales', 'finance']);
      expect(addTables).toHaveBeenCalledWith(SALES, ['dim_region']);
      expect(status).not.toHaveBeenCalled();
    });

    it('the status bar names what the canvas says it added, and nothing when it added nothing (a refused add)', async () => {
      const status = vi.spyOn(vscode.window, 'setStatusBarMessage');
      const refused = vi.fn(async () => [] as string[]);
      await addToDiagramCommand({ listSubjectAreas: () => summaries, memberNames: members, layerLabel, addTables: refused, activeDiagramPath: () => STAGING }, ['dim_date']);
      expect(refused).toHaveBeenCalledWith(STAGING, ['dim_date']);
      expect(status).not.toHaveBeenCalled();
      const someAdded = vi.fn(async () => ['dim_region', 'dim_date']);
      await addToDiagramCommand({ listSubjectAreas: () => summaries, memberNames: members, layerLabel, addTables: someAdded, activeDiagramPath: () => STAGING }, ['dim_region', 'dim_date', 'fct_order']);
      expect(status).toHaveBeenCalledWith(addedToDiagramStatus('2 tables', 'staging'), ADDED_TO_DIAGRAM_STATUS_MS);
    });

    it('diagramToAddTo: the active diagram, else the only one on screen (each file once, any case on macOS/Windows), else none', () => {
      expect(diagramToAddTo(summaries, STAGING, [SALES])?.domain).toBe('staging');
      expect(diagramToAddTo(summaries, undefined, [SALES, SALES])?.domain).toBe('sales');
      expect(diagramToAddTo(summaries, undefined, [SALES, STAGING])).toBeUndefined();
      expect(diagramToAddTo(summaries, undefined, [])).toBeUndefined();
      // Not a diagram of the project: the pick decides.
      expect(diagramToAddTo(summaries, '/elsewhere/x.dbml', [])).toBeUndefined();
    });
  });

  it('says so when every diagram shows them, or there is no diagram', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    const addTables = vi.fn(async () => undefined);
    await addToDiagramCommand({ listSubjectAreas: () => [summaries[0]], memberNames: members, layerLabel, addTables }, ['fct_order']);
    expect(String(info.mock.calls[0][0])).toBe('ERD Studio: Every diagram already shows "fct_order".');
    await addToDiagramCommand({ listSubjectAreas: () => [], memberNames: members, layerLabel, addTables }, ['fct_order']);
    expect(String(info.mock.calls[1][0])).toMatch(/no diagram yet/);
    expect(addTables).not.toHaveBeenCalled();
  });
});

describe('Open in Diagram on a table', () => {
  let exec: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
  });
  const deps = (over: Partial<RelationshipsViewDeps> = {}): RelationshipsViewDeps => ({
    relationshipLocation: () => undefined,
    findTableFile: () => null,
    listSubjectAreas: () => [diagram('sales'), diagram('finance')],
    memberNames: (p) => (p.endsWith('sales.dbml') ? ['fct_order', 'dim_customer'] : ['fct_order']),
    layerLabel,
    revealRelationship: vi.fn(async () => undefined),
    revealTable: vi.fn(async () => undefined),
    addToDiagram: vi.fn(async () => undefined),
    ...over,
  });

  it('selects the table on the diagram it opens', async () => {
    const d = deps();
    await openInDiagram({ type: 'model', name: 'dim_customer' }, d);
    expect(exec).toHaveBeenCalledWith('erdStudio.openDomain', `${SEM}/gold/diagrams/sales.dbml`);
    expect(d.revealTable).toHaveBeenCalledWith(`${SEM}/gold/diagrams/sales.dbml`, 'dim_customer');
  });

  it('leaves out the diagram the canvas is on (Show on Other Diagrams…)', async () => {
    const d = deps();
    await openInDiagram({ type: 'model', name: 'fct_order' }, d, { excludeDiagram: `${SEM}/gold/diagrams/sales.dbml` });
    expect(exec).toHaveBeenCalledWith('erdStudio.openDomain', `${SEM}/gold/diagrams/finance.dbml`);
    expect(d.revealTable).toHaveBeenCalledWith(`${SEM}/gold/diagrams/finance.dbml`, 'fct_order');
  });

  it('offers Add to Diagram… when no diagram shows it, instead of a dead end', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(ADD_TO_DIAGRAM as never);
    const d = deps();
    await openInDiagram({ type: 'model', name: 'dim_date' }, d);
    expect(info.mock.calls[0]).toEqual(['ERD Studio: No diagram shows "dim_date" yet. Add it to one?', ADD_TO_DIAGRAM]);
    expect(d.addToDiagram).toHaveBeenCalledWith(['dim_date']);
    expect(exec).not.toHaveBeenCalled();
  });

  it('labels that button as the command it runs is titled', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')) as { contributes: { commands: Array<{ command: string; title: string }> } };
    expect(manifest.contributes.commands.find((c) => c.command === 'erdStudio.addToDiagram')?.title).toBe(ADD_TO_DIAGRAM);
  });

  it('says "No other diagram" when only the open one shows it', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const d = deps();
    await openInDiagram({ type: 'model', name: 'dim_customer' }, d, { excludeDiagram: `${SEM}/gold/diagrams/sales.dbml` });
    expect(String(info.mock.calls[0][0])).toBe('ERD Studio: No other diagram shows "dim_customer" yet. Add it to one?');
    expect(d.addToDiagram).not.toHaveBeenCalled();
  });
});

describe('projectRelativePath', () => {
  it('is the path from the project folder, with forward slashes', () => {
    expect(projectRelativePath('/p', '/p/.erd-studio/gold/tables/sales/fct_order.dbml')).toBe('.erd-studio/gold/tables/sales/fct_order.dbml');
    expect(projectRelativePath('/p', '/elsewhere/x.dbml')).toBe('/elsewhere/x.dbml');
  });
});

describe('contributions', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')) as {
    contributes: {
      commands: Array<{ command: string; title: string; icon?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
    };
  };
  const { commands, menus } = pkg.contributes;

  it('contribute Go to Table…, Add to Diagram… and Reveal in Table Library, with no legacy alias', () => {
    expect(commands.find((c) => c.command === 'erdStudio.goToTable')).toMatchObject({ title: 'Go to Table…', icon: '$(search)' });
    expect(commands.find((c) => c.command === 'erdStudio.addToDiagram')?.title).toBe('Add to Diagram…');
    expect(commands.find((c) => c.command === 'erdStudio.revealInTableLibrary')?.title).toBe('Reveal in Table Library');
    for (const id of ['erdStudio.goToTable', 'erdStudio.addToDiagram', 'erdStudio.revealInTableLibrary']) {
      expect(NO_LEGACY_ALIAS.has(id), id).toBe(true);
    }
  });

  it('put Go to Table… in the palette for a project and as the Table Library\'s search icon', () => {
    expect(menus.commandPalette).toContainEqual({ command: 'erdStudio.goToTable', when: 'erdStudio.hasProject' });
    expect(menus['view/title']).toContainEqual({ command: 'erdStudio.goToTable', when: 'view == erdStudio.modelLibrary && erdStudio.hasProject', group: 'navigation@0' });
    // The other two need a table to act on.
    expect(menus.commandPalette).toContainEqual({ command: 'erdStudio.addToDiagram', when: 'false' });
    expect(menus.commandPalette).toContainEqual({ command: 'erdStudio.revealInTableLibrary', when: 'false' });
  });

  it('put Add to Open Diagram, then Add to Diagram…, on a Table Library table\'s right-click menu', () => {
    // Gerhard: the right-click add goes to the open diagram; Add to Diagram… still asks, for any other diagram.
    expect(menus['view/item/context']).toContainEqual({ command: 'erdStudio.addToOpenDiagram', when: 'view == erdStudio.modelLibrary && viewItem == logicalModel', group: 'navigation@2' });
    expect(menus['view/item/context']).toContainEqual({ command: 'erdStudio.addToDiagram', when: 'view == erdStudio.modelLibrary && viewItem == logicalModel', group: 'navigation@3' });
  });

  it('put Add to Open Diagram as a + button on a Table Library table row, out of the palette, with no legacy alias', () => {
    expect(commands.find((c) => c.command === 'erdStudio.addToOpenDiagram')).toMatchObject({ title: 'Add to Open Diagram', icon: '$(add)' });
    expect(menus['view/item/context']).toContainEqual({ command: 'erdStudio.addToOpenDiagram', when: 'view == erdStudio.modelLibrary && viewItem == logicalModel', group: 'inline' });
    expect(menus.commandPalette).toContainEqual({ command: 'erdStudio.addToOpenDiagram', when: 'false' });
    expect(NO_LEGACY_ALIAS.has('erdStudio.addToOpenDiagram')).toBe(true);
  });
});
