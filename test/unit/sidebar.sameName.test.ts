/**
 * The sidebar and its commands on two tables of one name in different schema
 * folders (packages/core/test/fixtures/dbml/same-name-two-schemas: bqs and
 * ccc, each with addresse and kunde; the diagrams ccc.dbml, kunden.dbml and
 * kunden-bare.dbml, plus a diagram of bqs's tables here), with the library
 * telling tables apart by identity (`schemaScopedNames`, off by default
 * until the rule flips): the Table Library's rows, their reads and "on N
 * diagrams", a drag, Go to Table, Add to Diagram…, Open in Diagram, the
 * Relationships view, the Explorer's tooltips, the Diagrams view's drop and
 * New Table each name a table by its own file, never by a name another
 * schema folder shares (`sidebarTables.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';

import { TableLibraryTreeProvider, type TableLibraryNode, type TableLibraryTableNode } from '../../src/providers/ModelLibraryTreeProvider';
import { RelationshipsTreeProvider, type RelationshipsNode } from '../../src/providers/RelationshipsTreeProvider';
import { SemanticFileDecorationProvider } from '../../src/providers/SemanticFileDecorationProvider';
import { SubjectAreaTreeProvider, draggedTableUris } from '../../src/providers/DomainTreeProvider';
import { TABLE_LIBRARY_DRAG_MIME, TableLibraryDragController, tablesOfDraggedRows } from '../../src/providers/tableLibraryDrag';
import {
  addToDiagramCommand,
  buildGoToTableItems,
  diagramPickItems,
  diagramUsage,
  goToTableCommand,
  tableRowsFromTreeArgs,
  type GoToTableItem,
} from '../../src/commands/goToTable';
import { openInDiagram, type RelationshipsViewDeps } from '../../src/commands/relationshipsView';
import { createDbmlTable, type NewTableDeps } from '../../src/commands/newTable';
import { SubjectAreaService } from '../../src/services/domainService';
import { DiagramMembers } from '../../src/services/diagramMembers';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { tableUsageOf } from '../../src/services/sidebarTables';
import { tableHomesById } from '../../src/services/tableHomes';
import type { FileWrite } from '../../src/services/fileWrites';

const TWINS = path.resolve(__dirname, '../../packages/core/test/fixtures/dbml/same-name-two-schemas');

let root: string;
const at = (rel: string): string => path.join(root, '.erd-studio', ...rel.split('/'));
const read = (rel: string): string => fs.readFileSync(at(rel), 'utf-8');
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};

/** A diagram that shows bqs's two tables only, by their names. */
const BQS_DIAGRAM = [
  'Project bqs {',
  "  erd_schema_version: '7'",
  "  erd_layout: '''",
  '    addresse 10 20',
  '    kunde 300 20',
  "  '''",
  '}',
  '',
  "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
  "use { table bqs.kunde }    from '../tables/bqs/kunde.dbml'",
  "use * from '../relationships/bronze.dbml'",
  '',
].join('\n');

const LAYERS = [{ id: 'bronze', label: 'Bronze', color: '#cd7f32', creatable: true, order: 1 }];

function services(scoped = true) {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tables = new TableLibraryService(root, '.erd-studio', undefined, { schemaScopedNames: scoped });
  subjectAreaService.setTableLibraryService(tables);
  const members = new DiagramMembers();
  return { layerService, subjectAreaService, tables, members, usage: () => tableUsageOf(tables, members) };
}

/** Every table row in a listing, depth first. */
function tableRows(nodes: readonly TableLibraryNode[], provider: TableLibraryTreeProvider): TableLibraryTableNode[] {
  return nodes.flatMap((n) => (n.type === 'model' ? [n] : n.type === 'noMatch' ? [] : tableRows(provider.getChildren(n) ?? [], provider)));
}

/** Every row of a listing with its tree item, depth first. */
function allItems(nodes: readonly TableLibraryNode[], provider: TableLibraryTreeProvider): vscode.TreeItem[] {
  return nodes.flatMap((n) => [provider.getTreeItem(n), ...(n.type === 'model' || n.type === 'noMatch' ? [] : allItems(provider.getChildren(n) ?? [], provider))]);
}

const diagramPath = (name: string): string => at(`bronze/diagrams/${name}.dbml`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-same-name-sidebar-'));
  fs.cpSync(TWINS, root, { recursive: true });
  write('bronze/diagrams/bqs.dbml', BQS_DIAGRAM);
  // Each addresse has its own warehouse name, so a row that read its namesake's file would show the wrong one.
  write('bronze/tables/bqs/addresse.dbml', read('bronze/tables/bqs/addresse.dbml').replace('Table bqs.addresse {', 'Table bqs.addresse [alias: \'bqs_adressen\'] {'));
  write('bronze/tables/ccc/addresse.dbml', read('bronze/tables/ccc/addresse.dbml').replace('Table ccc.addresse {', 'Table ccc.addresse [alias: \'ccc_addresses\'] {'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the Table Library: two ordinary rows', () => {
  function listing(scoped = true) {
    const s = services(scoped);
    const provider = new TableLibraryTreeProvider(s.tables, s.subjectAreaService, root, '.erd-studio', () => LAYERS as never, undefined, undefined, undefined, s.members);
    // Read every file first, so each row shows what its own file says.
    for (const entry of s.tables.listTableFiles()) s.tables.getTable(entry.id ?? entry.name);
    const roots = provider.getChildren() ?? [];
    return { ...s, provider, roots, rows: tableRows(roots, provider) };
  }

  it('each with its own warehouse name and the diagrams whose use lines read its file', () => {
    const { rows, provider } = listing();
    const by = (rel: string): TableLibraryTableNode => rows.find((r) => r.filePath === at(rel))!;
    const bqs = by('bronze/tables/bqs/addresse.dbml');
    const ccc = by('bronze/tables/ccc/addresse.dbml');
    expect([bqs.shadowedBy, ccc.shadowedBy]).toEqual([undefined, undefined]);
    expect([bqs.alias, ccc.alias]).toEqual(['bqs_adressen', 'ccc_addresses']);
    expect(bqs.referencingDomains.sort()).toEqual(['bqs', 'kunden', 'kunden-bare']);
    expect(ccc.referencingDomains.sort()).toEqual(['ccc', 'kunden', 'kunden-bare']);
    expect(ccc.id).toEqual({ schema: 'ccc', name: 'addresse' });
    expect(provider.getTreeItem(ccc).description).toBe('as ccc_addresses');
    expect(String((provider.getTreeItem(ccc).tooltip as vscode.MarkdownString).value)).toContain('**ccc.addresse** — the warehouse table `ccc_addresses`');
  });

  it('every row with an id has its own id', () => {
    const { roots, provider } = listing();
    const ids = allItems(roots, provider).map((i) => i.id).filter((id): id is string => id !== undefined);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Reveal in Table Library finds the row of the file given, and by name alone the first, as before', () => {
    const { provider } = listing();
    expect(provider.findTableNode('addresse', at('bronze/tables/ccc/addresse.dbml'))?.filePath).toBe(at('bronze/tables/ccc/addresse.dbml'));
    expect(provider.findTableNode('addresse')?.filePath).toBe(at('bronze/tables/bqs/addresse.dbml'));
  });

  it('with the option off, the second file is still the duplicate that is ignored (the rule until it flips)', () => {
    const { rows } = listing(false);
    expect(rows.find((r) => r.filePath === at('bronze/tables/ccc/addresse.dbml'))?.shadowedBy).toBe(at('bronze/tables/bqs/addresse.dbml'));
  });

  it('dragging the layer row carries every table, both of each name, each with its own file', () => {
    const { roots } = listing();
    const layer = roots.find((r) => r.type === 'layer')!;
    const dragged = tablesOfDraggedRows([layer]);
    expect(dragged.names).toEqual(['addresse', 'kunde', 'addresse', 'kunde']);
    expect(dragged.filePaths).toEqual([
      at('bronze/tables/bqs/addresse.dbml'), at('bronze/tables/bqs/kunde.dbml'),
      at('bronze/tables/ccc/addresse.dbml'), at('bronze/tables/ccc/kunde.dbml'),
    ]);
    // A row selected with its own schema row is still dragged once.
    const ccc = layer.children.find((c) => c.type === 'folder' && c.folder === 'ccc')!;
    expect(tablesOfDraggedRows([ccc, ...(ccc.type === 'folder' ? ccc.children : [])]).names).toEqual(['addresse', 'kunde']);
    // The extension asks for the files with the names: the editor adds by file.
    const started = vi.fn();
    new TableLibraryDragController(started, { withFiles: true }).handleDrag([ccc], new vscode.DataTransfer());
    expect(started).toHaveBeenCalledWith(['addresse', 'kunde'], [at('bronze/tables/ccc/addresse.dbml'), at('bronze/tables/ccc/kunde.dbml')]);
  });
});

describe('the usage rule (sidebarTables.ts)', () => {
  it('a diagram shows a table when a member\'s use line reads its file; a stale line counts only for the one table of its name', () => {
    write('bronze/diagrams/stale.dbml', [
      'Project stale {', "  erd_schema_version: '7'", '}', '',
      "use { table zzz.addresse } from '../tables/zzz/addresse.dbml'",
      "use { table zzz.kunde2 } from '../tables/zzz/kunde2.dbml'",
      '',
    ].join('\n'));
    write('bronze/tables/ddd/kunde2.dbml', 'Table ddd.kunde2 {\n  id INT [pk]\n}\n');
    const { usage } = services();
    const u = usage();
    const keys = u.membersOf(diagramPath('stale'))!;
    // addresse: two tables share the name, so a line to a file that is gone names neither.
    expect(keys).not.toContain(u.keyOf({ name: 'addresse', filePath: at('bronze/tables/bqs/addresse.dbml') }));
    expect(keys).not.toContain(u.keyOf({ name: 'addresse', filePath: at('bronze/tables/ccc/addresse.dbml') }));
    // kunde2: the only table of its name.
    expect(keys).toContain(u.keyOf({ name: 'kunde2', filePath: at('bronze/tables/ddd/kunde2.dbml') }));
    expect(u.refOn(diagramPath('kunden'), { name: 'addresse', filePath: at('bronze/tables/ccc/addresse.dbml') })).toBe('ccc.addresse');
    expect(u.refOn(diagramPath('ccc'), { name: 'addresse', filePath: at('bronze/tables/ccc/addresse.dbml') })).toBe('addresse');
    expect(u.refOn(diagramPath('bqs'), { name: 'addresse', filePath: at('bronze/tables/ccc/addresse.dbml') })).toBeUndefined();
    // A library reference names its table too (the Relationships view's names).
    expect(u.keyOf('ccc.addresse')).toBe(u.keyOf({ name: 'addresse', filePath: at('bronze/tables/ccc/addresse.dbml') }));
  });

  it('a JSON diagram\'s bare name is the table that name reads in the library (the first listed)', () => {
    write('bronze/old.json', JSON.stringify({ schemaVersion: 5, domain: 'old', layer: 'bronze', logical: { models: ['addresse'], relationships: [] } }));
    const { usage } = services();
    const u = usage();
    expect(u.membersOf(at('bronze/old.json'))).toEqual([u.keyOf({ name: 'addresse', filePath: at('bronze/tables/bqs/addresse.dbml') })]);
  });
});

describe('Go to Table', () => {
  it('lists both tables of a name, each with its own schema and diagrams, and opens the one picked by its file', async () => {
    const s = services();
    const usage = s.usage();
    const summaries = s.subjectAreaService.listSubjectAreas(root, '.erd-studio');
    const rows = buildGoToTableItems({
      entries: s.tables.listTableFiles(),
      homes: tableHomesById(s.tables.listTableFiles()),
      usage: diagramUsage(summaries, (p) => usage.membersOf(p)),
      layerLabel: () => 'Bronze',
      details: () => undefined,
      keyOf: (e) => usage.keyOf({ name: e.name, filePath: e.filePath }),
    });
    const addresses = rows.filter((r) => r.label === 'addresse');
    expect(addresses.map((r) => [r.description, r.filePath])).toEqual([
      ['bqs · Bronze', at('bronze/tables/bqs/addresse.dbml')],
      ['ccc · Bronze', at('bronze/tables/ccc/addresse.dbml')],
    ]);
    const shownOn = (detail: string): string[] => detail.replace(/^on /, '').split(', ').sort();
    expect(addresses.map((r) => shownOn(r.detail))).toEqual([['bqs', 'kunden', 'kunden-bare'], ['ccc', 'kunden', 'kunden-bare']]);

    // Accepting the ccc row opens it by its file; its details are read by its file.
    const peek = vi.fn(() => ({}));
    const openOne = vi.fn(async () => undefined);
    let qp: { items: GoToTableItem[]; selectedItems: GoToTableItem[]; activeItems: GoToTableItem[] } & Record<string, unknown> = undefined as never;
    const listeners: Record<string, (arg?: unknown) => void> = {};
    const run = goToTableCommand({
      listTableFiles: () => s.tables.listTableFiles(),
      tableHomes: () => tableHomesById(s.tables.listTableFiles()),
      listSubjectAreas: () => summaries,
      memberNames: () => null,
      usage: () => usage,
      layerLabel: () => 'Bronze',
      peekDetails: peek,
      openInDiagram: openOne,
      openFile: vi.fn(async () => undefined),
      showRelationships: vi.fn(async () => undefined),
      createQuickPick: () => {
        qp = {
          items: [], selectedItems: [], activeItems: [], value: '',
          show() {}, hide() { listeners.hide?.(); }, dispose() {},
          onDidAccept(fn: () => void) { listeners.accept = fn; return { dispose() {} }; },
          onDidTriggerItemButton() { return { dispose() {} }; },
          onDidHide(fn: () => void) { listeners.hide = fn; return { dispose() {} }; },
          onDidChangeValue() { return { dispose() {} }; },
        };
        return qp as never;
      },
    });
    await Promise.resolve();
    qp.selectedItems = [qp.items.find((i) => i.filePath === at('bronze/tables/ccc/addresse.dbml'))!];
    listeners.accept?.();
    await run;
    expect(openOne).toHaveBeenCalledWith('addresse', at('bronze/tables/ccc/addresse.dbml'));
    expect(peek).toHaveBeenCalledWith('addresse', at('bronze/tables/ccc/addresse.dbml'));
  });
});

describe('Add to Diagram… and Open in Diagram', () => {
  it('offers the diagrams that do not read the row\'s own file, and adds it by that file', async () => {
    const s = services();
    const summaries = s.subjectAreaService.listSubjectAreas(root, '.erd-studio');
    const ccc = { name: 'addresse', filePath: at('bronze/tables/ccc/addresse.dbml') };
    const items = diagramPickItems(summaries, () => null, () => 'Bronze', [ccc], s.usage());
    // The bqs diagram shows bqs's addresse, not this one: it is offered, and says nothing is there already.
    expect(items.map((i) => [i.label, i.detail])).toEqual([['bqs', undefined]]);
    const addTables = vi.fn(async () => undefined);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (list: unknown[]) => list[0]) as never);
    const rows = tableRowsFromTreeArgs({ type: 'model', name: 'addresse', filePath: ccc.filePath }, undefined);
    await addToDiagramCommand({ listSubjectAreas: () => summaries, memberNames: () => null, usage: s.usage, layerLabel: () => 'Bronze', addTables }, rows);
    expect(addTables).toHaveBeenCalledWith(diagramPath('bqs'), ['addresse'], [ccc.filePath]);
  });

  it('a right-click on both rows of a name names two tables', () => {
    const a = { type: 'model', name: 'addresse', filePath: at('bronze/tables/bqs/addresse.dbml') };
    const b = { type: 'model', name: 'addresse', filePath: at('bronze/tables/ccc/addresse.dbml') };
    expect(tableRowsFromTreeArgs(a, [a, b])).toEqual([{ name: 'addresse', filePath: a.filePath }, { name: 'addresse', filePath: b.filePath }]);
  });

  it('opens a diagram that reads the row\'s file and selects the table by what that diagram calls it', async () => {
    const s = services();
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const revealTable = vi.fn(async () => undefined);
    const deps: RelationshipsViewDeps = {
      relationshipLocation: () => undefined,
      findTableFile: () => null,
      listSubjectAreas: () => s.subjectAreaService.listSubjectAreas(root, '.erd-studio'),
      memberNames: () => null,
      usage: s.usage,
      layerLabel: () => 'Bronze',
      revealRelationship: vi.fn(async () => undefined),
      revealTable,
    };
    // Shown on ccc, kunden and kunden-bare (never on bqs, whose addresse is another table): kunden is picked.
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (list: Array<{ label: string }>) => list.find((i) => i.label === 'kunden')) as never);
    await openInDiagram({ type: 'model', name: 'addresse', filePath: at('bronze/tables/ccc/addresse.dbml') }, deps);
    expect((pick.mock.calls[0][0] as Array<{ label: string }>).map((i) => i.label).sort()).toEqual(['ccc', 'kunden', 'kunden-bare']);
    expect(exec).toHaveBeenCalledWith('erdStudio.openDomain', diagramPath('kunden'));
    expect(revealTable).toHaveBeenCalledWith(diagramPath('kunden'), 'ccc.addresse');
  });

  it('a relationship row (library references) opens on a diagram showing both its tables, its ends named as there', async () => {
    const s = services();
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const revealRelationship = vi.fn(async () => undefined);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (list: Array<{ label: string }>) => list.find((i) => i.label === 'ccc')) as never);
    const entry = {
      fromModel: 'ccc.kunde', toModel: 'ccc.addresse', fromColumns: ['addresse_id'], toColumns: ['id'], cardinality: 'many-to-one',
      first: { fromModel: 'ccc.kunde', fromColumn: 'addresse_id', toModel: 'ccc.addresse', toColumn: 'id', cardinality: 'many-to-one' },
      source: { kind: 'library', table: 'ccc.kunde' }, problems: [],
    };
    await openInDiagram({ type: 'relationship', entry, side: 'from', parentId: 'x' } as never, {
      relationshipLocation: () => undefined,
      findTableFile: () => null,
      listSubjectAreas: () => s.subjectAreaService.listSubjectAreas(root, '.erd-studio'),
      memberNames: () => null,
      usage: s.usage,
      layerLabel: () => 'Bronze',
      revealRelationship,
    });
    expect(revealRelationship).toHaveBeenCalledWith(diagramPath('ccc'), {
      fromModel: 'kunde', toModel: 'addresse', pairs: [{ fromColumn: 'addresse_id', toColumn: 'id' }],
    });
  });
});

describe('the Relationships view', () => {
  async function rows() {
    const s = services();
    const provider = new RelationshipsTreeProvider(s.tables, s.subjectAreaService, root, '.erd-studio', undefined,
      () => new Map(), () => LAYERS as never);
    const roots = await provider.getChildren();
    const layer = roots.find((r) => r.type === 'layer')!;
    const tables = await provider.getChildren(layer);
    return { provider, tables };
  }

  it('names each table of a pair by its schema, one row each with its own id, layer and relationships', async () => {
    const { provider, tables } = await rows();
    const labels = tables.map((t) => provider.getTreeItem(t).label);
    expect(labels).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    const ids = tables.map((t) => provider.getTreeItem(t).id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toContain('erdStudio.relationships.table:ccc/addresse');
    const ccc = tables.find((t) => provider.getTreeItem(t).label === 'ccc.addresse')!;
    expect(String(provider.getTreeItem(ccc).tooltip).split('\n')[0]).toBe('ccc.addresse — Bronze layer');
    // ccc.kunde points at it; it points at bqs.addresse.
    const children: RelationshipsNode[] = await provider.getChildren(ccc);
    expect(children.map((c) => provider.getTreeItem(c).label).sort()).toEqual(['bqs.addresse', 'ccc.kunde']);
    const all = (await Promise.all(tables.map((t) => provider.getChildren(t)))).flat().map((c) => provider.getTreeItem(c).id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('Go to Table → Show Relationships finds the row by the table\'s library reference', async () => {
    const { provider } = await rows();
    const node = await provider.findTableNode('ccc.addresse');
    expect(node?.group.table).toBe('ccc.addresse');
  });
});

describe('the Explorer\'s tooltips', () => {
  it('count each table file on the diagrams whose use lines read it, with its own warehouse name', async () => {
    const s = services();
    for (const entry of s.tables.listTableFiles()) s.tables.getTable(entry.id ?? entry.name);
    const layerService = { getLayer: (id: string) => LAYERS.find((l) => l.id === id), getAllLayers: () => LAYERS, configFileExists: () => true } as unknown as LayerService;
    const provider = new SemanticFileDecorationProvider(layerService, '.erd-studio', {
      listTableFiles: () => s.tables.listTableFiles(),
      peekAlias: (name) => s.tables.peekTableSummary(name)?.alias,
      listDiagrams: () => s.subjectAreaService.listSubjectAreas(root, '.erd-studio'),
      diagramMembers: (p) => s.members.of(p),
      usage: s.usage,
    }, { semanticRoot: path.join(root, '.erd-studio') });
    const tip = (rel: string): unknown => provider.provideFileDecoration(vscode.Uri.file(at(rel)) as never)?.tooltip;
    tip('bronze/tables/ccc/addresse.dbml');
    await new Promise<void>((resolve) => { const sub = provider.onDidChangeFileDecorations(() => { sub.dispose(); resolve(); }); });
    expect(tip('bronze/tables/ccc/addresse.dbml')).toBe('ccc.addresse (warehouse table ccc_addresses) — on 3 diagrams');
    expect(tip('bronze/tables/bqs/addresse.dbml')).toBe('bqs.addresse (warehouse table bqs_adressen) — on 3 diagrams');
    expect(tip('bronze/diagrams/kunden.dbml')).toBe('A diagram in the Bronze layer: 4 tables');
    provider.dispose();
  });
});

describe('the Diagrams view: Table Library rows dropped on a diagram\'s row', () => {
  it('hand the handler the dragged rows\' files with their names, so each table is its own file', async () => {
    const s = services();
    const provider = new SubjectAreaTreeProvider(s.subjectAreaService, s.layerService, root, '.erd-studio');
    const handler = vi.fn(async () => undefined);
    provider.setTablesDropHandler(handler);
    const transfer = new vscode.DataTransfer();
    const files = [at('bronze/tables/bqs/addresse.dbml'), at('bronze/tables/ccc/addresse.dbml')];
    transfer.set(TABLE_LIBRARY_DRAG_MIME, new vscode.DataTransferItem(['addresse', 'addresse']));
    const uris = files.map((f) => pathToFileURL(f).href);
    transfer.set('text/uri-list', new vscode.DataTransferItem(uris.join('\r\n')));
    expect(await draggedTableUris(transfer)).toEqual(uris);
    const target = { type: 'domain', summary: { domain: 'ccc', layer: 'bronze', filePath: diagramPath('ccc') }, modelCount: 2 };
    await provider.handleDrop(target as never, transfer, {} as never);
    expect(handler).toHaveBeenCalledWith(diagramPath('ccc'), ['addresse'], uris);
  });
});

describe('New Table on a schema row', () => {
  it('in ccc while only bqs has addresse: creates ccc/addresse.dbml (create, through the planner) and edits nothing else', async () => {
    // Only bqs's addresse: ccc's file and every diagram naming it are gone.
    fs.rmSync(at('bronze/tables/ccc/addresse.dbml'));
    for (const d of ['ccc', 'kunden', 'kunden-bare']) fs.rmSync(diagramPath(d));
    const rels = read('bronze/relationships/bronze.dbml').split('\n')
      .filter((l) => !l.includes('ccc.addresse')).join('\n');
    write('bronze/relationships/bronze.dbml', rels);
    const s = services();
    const before = Object.fromEntries((fs.readdirSync(at(''), { recursive: true }) as string[])
      .map((f) => f.split(path.sep).join('/')).filter((f) => fs.statSync(at(f)).isFile()).map((f) => [f, read(f)]));
    const applied: FileWrite[] = [];
    const shown: Array<[string, string]> = [];
    const deps: NewTableDeps = {
      workspaceRoot: root,
      semanticRoot: path.join(root, '.erd-studio'),
      tableLibraryService: {
        listTableFiles: () => s.tables.listTableFiles(),
        listDbmlLayerFolders: () => s.tables.listDbmlLayerFolders(),
        // The name refusal stays project-wide until the rule flips (stage 10): here it is the planner's create flag under test.
        findTableNameIgnoringCase: () => null,
        planDbmlBatch: (args) => s.tables.planDbmlBatch(args),
      },
      storage: () => 'dbml',
      layers: () => LAYERS,
      readText: (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null),
      dirtyFiles: () => [],
      applyWrites: async (writes) => {
        applied.push(...writes);
        return { ok: true, unsaved: [], unrestored: [] };
      },
      afterCreated: async () => undefined,
      show: async (name, filePath) => { shown.push([name, filePath]); },
    };
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const errors = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    const made = await createDbmlTable(deps, { layer: 'bronze', schema: 'ccc' }, 'addresse');
    expect(errors).not.toHaveBeenCalled();
    expect(made).toBe(at('bronze/tables/ccc/addresse.dbml'));
    expect(applied.map((w) => [w.kind, path.relative(path.join(root, '.erd-studio'), w.path).split(path.sep).join('/')])).toEqual([['create', 'bronze/tables/ccc/addresse.dbml']]);
    expect(applied[0].kind === 'create' ? applied[0].text : '').toMatch(/^Table ccc\.addresse \{/);
    expect(shown).toEqual([['addresse', at('bronze/tables/ccc/addresse.dbml')]]);
    // Nothing on disk was touched (the writes were only planned here).
    for (const [f, text] of Object.entries(before)) expect(read(f), f).toBe(text);
  });
});
