/**
 * Dragging tables onto a diagram, host side: the Table Library's drag source
 * (`TableLibraryDragController`: which tables a row drags, what goes in the
 * DataTransfer), the drop's helpers (`tablesOfDroppedUris`,
 * `dropGridPositions`), the `dropTables` payload check, and
 * `SemanticEditorProvider`'s handling of a drop — table files among the
 * dropped URIs, else the Table Library drag of the last minute; one edit with
 * the new tables at the drop point; tables already there selected; nothing on
 * the physical stage. The webview side is `test/unit/libraryDrop.test.tsx`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';

import { _appliedEdits, _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import {
  DROP_TABLES_NOTHING_MESSAGE,
  PENDING_LIBRARY_DRAG_MS,
  afterDragLands,
  PHYSICAL_READ_ONLY_MESSAGE,
  SemanticEditorProvider,
} from '../../src/providers/SemanticEditorProvider';
import { TABLE_LIBRARY_DRAG_MIME, TABLE_LIBRARY_NAMES_MIME, TableLibraryDragController, tablesOfDraggedRows } from '../../src/providers/tableLibraryDrag';
import type { TableLibraryFolderNode, TableLibraryLayerNode, TableLibraryTableNode } from '../../src/providers/ModelLibraryTreeProvider';
import { DROP_GRID_COLUMNS, dropGridPositions, tableFilesOfDroppedUris, tablesOfDroppedUris, tablesOfTreeDrop } from '../../src/services/tableDrop';
import { CANVAS_FRAME_MAX, validateCanvasFramePayload, validateDragReleasePayload, validateDropTablesPayload } from '../../src/providers/payloadValidation';
import { ADD_EXISTING_TABLES_LIMIT, DROP_TABLES_URI_LIMIT, DROP_TABLES_URI_MAX_LENGTH } from '../../src/types/messages';
import { NODE_HEIGHT, NODE_WIDTH, PADDING } from '../../src/services/positionService';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';

// ---------------------------------------------------------------------------
// The drag source
// ---------------------------------------------------------------------------

const table = (name: string, extra: Partial<TableLibraryTableNode> = {}): TableLibraryTableNode => ({
  type: 'model', name, filePath: `/p/.erd-studio/gold/tables/gold/${name}.dbml`, referencingDomains: [], ...extra,
});
const schema = (folder: string, children: TableLibraryTableNode[]): TableLibraryFolderNode => ({
  type: 'folder', folder, layer: 'gold', filePath: `/p/.erd-studio/gold/tables/${folder}`, children,
});
const layer = (children: Array<TableLibraryFolderNode | TableLibraryTableNode>): TableLibraryLayerNode => ({
  type: 'layer', layer: 'gold', filePath: '/p/.erd-studio/gold/tables', children, tableCount: 0, schemas: [],
});

describe('tablesOfDraggedRows', () => {
  it('drags a table row, every table of a schema row and of a layer row, each once, in tree order', () => {
    const sales = schema('sales', [table('fct_order'), table('dim_customer')]);
    const finance = schema('finance', [table('fct_invoice')]);
    expect(tablesOfDraggedRows([table('dim_date')]).names).toEqual(['dim_date']);
    expect(tablesOfDraggedRows([sales]).names).toEqual(['fct_order', 'dim_customer']);
    expect(tablesOfDraggedRows([layer([sales, finance, table('dim_region')])]).names)
      .toEqual(['fct_order', 'dim_customer', 'fct_invoice', 'dim_region']);
    // A row selected with its own schema row is dragged once, whatever its case.
    expect(tablesOfDraggedRows([sales, table('FCT_ORDER')]).names).toEqual(['fct_order', 'dim_customer']);
  });

  it('never drags a duplicate that is ignored, and keeps each name with its file', () => {
    const dup = table('fct_order', { filePath: '/p/.erd-studio/silver/tables/silver/fct_order.dbml', shadowedBy: '/p/x.dbml' });
    const dragged = tablesOfDraggedRows([schema('sales', [dup, table('dim_customer')])]);
    expect(dragged).toEqual({ names: ['dim_customer'], filePaths: ['/p/.erd-studio/gold/tables/gold/dim_customer.dbml'] });
  });

  it('stops at the Add Existing Tables cap', () => {
    const many = Array.from({ length: ADD_EXISTING_TABLES_LIMIT + 5 }, (_, i) => table(`t_${i}`));
    expect(tablesOfDraggedRows([schema('big', many)]).names).toHaveLength(ADD_EXISTING_TABLES_LIMIT);
    expect(tablesOfDraggedRows([schema('big', many)], 3).names).toEqual(['t_0', 't_1', 't_2']);
  });
});

describe('TableLibraryDragController', () => {
  it('offers the names\' own type and text/uri-list (never the view\'s tree type, where VS Code writes its own data), and accepts no drops', () => {
    const controller = new TableLibraryDragController(() => {});
    expect(controller.dragMimeTypes).toEqual([TABLE_LIBRARY_NAMES_MIME, 'text/uri-list']);
    expect(controller.dragMimeTypes).not.toContain(TABLE_LIBRARY_DRAG_MIME);
    expect(controller.dropMimeTypes).toEqual([]);
    expect(TABLE_LIBRARY_DRAG_MIME).toBe('application/vnd.code.tree.erdstudio.modellibrary');
    // Lower case: a browser DataTransfer lower-cases types, and VS Code matches them exactly.
    expect(TABLE_LIBRARY_NAMES_MIME).toBe(TABLE_LIBRARY_NAMES_MIME.toLowerCase());
    expect(TABLE_LIBRARY_NAMES_MIME.startsWith('application/vnd.code.tree.')).toBe(false);
  });

  it('puts the files in text/uri-list and the names under its mime type, then reports the drag', () => {
    const started = vi.fn();
    const transfer = new vscode.DataTransfer();
    new TableLibraryDragController(started).handleDrag([schema('sales', [table('fct_order'), table('dim_customer')])], transfer);
    expect(transfer.get('text/uri-list')?.value).toBe([
      vscode.Uri.file('/p/.erd-studio/gold/tables/gold/fct_order.dbml').toString(),
      vscode.Uri.file('/p/.erd-studio/gold/tables/gold/dim_customer.dbml').toString(),
    ].join('\r\n'));
    expect(transfer.get(TABLE_LIBRARY_NAMES_MIME)?.value).toBe('["fct_order","dim_customer"]');
    expect(transfer.get(TABLE_LIBRARY_DRAG_MIME)).toBeUndefined();
    expect(started).toHaveBeenCalledWith(['fct_order', 'dim_customer']);
  });

  it('a failure to note the drag keeps its DataTransfer and does not throw (VS Code would drop the whole drag)', () => {
    const transfer = new vscode.DataTransfer();
    const failing = new TableLibraryDragController(() => { throw new Error('Webview is disposed'); });
    expect(() => failing.handleDrag([table('fct_order')], transfer)).not.toThrow();
    expect(transfer.get(TABLE_LIBRARY_NAMES_MIME)?.value).toBe('["fct_order"]');
    expect(transfer.get('text/uri-list')?.value).toBeTruthy();
  });

  it('a drag with no table (an ignored duplicate alone) sets nothing and reports nothing', () => {
    const started = vi.fn();
    const transfer = new vscode.DataTransfer();
    new TableLibraryDragController(started).handleDrag([table('x', { shadowedBy: '/p/y.dbml' })], transfer);
    expect(transfer.get('text/uri-list')).toBeUndefined();
    expect(started).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The drop's helpers
// ---------------------------------------------------------------------------

describe('tablesOfDroppedUris', () => {
  const files = [
    { name: 'fct_order', filePath: '/proj/.erd-studio/gold/tables/gold/fct_order.dbml' },
    { name: 'dim_customer', filePath: '/proj/.erd-studio/logical-models/dim_customer.yml' },
    { name: 'dim_date', filePath: '/proj/.erd-studio/silver/tables/cal/dim_date.dbml', shadowedBy: '/proj/other.dbml' },
  ];
  const uri = (p: string): string => pathToFileURL(p).href;

  it('names the table files among the URIs, DBML and YAML, in drop order, each once', () => {
    expect(tablesOfDroppedUris([
      uri('/proj/.erd-studio/logical-models/dim_customer.yml'),
      uri('/proj/README.md'),
      uri('/proj/.erd-studio/gold/tables/gold/fct_order.dbml'),
      uri('/proj/.erd-studio/logical-models/dim_customer.yml'),
    ], files, 'linux')).toEqual(['dim_customer', 'fct_order']);
  });

  it('ignores a non-file URI, junk, a folder and an ignored duplicate', () => {
    expect(tablesOfDroppedUris([
      'vscode-remote://ssh/proj/.erd-studio/gold/tables/gold/fct_order.dbml',
      'https://example.com/fct_order.dbml',
      'not a uri',
      'file://%',
      uri('/proj/.erd-studio/gold/tables/gold'),
      uri('/proj/.erd-studio/silver/tables/cal/dim_date.dbml'),
    ], files, 'linux')).toEqual([]);
  });

  it('matches without case where the file system ignores it, and with case elsewhere', () => {
    const shouted = uri('/PROJ/.erd-studio/GOLD/tables/gold/FCT_ORDER.dbml');
    expect(tablesOfDroppedUris([shouted], files, 'darwin')).toEqual(['fct_order']);
    expect(tablesOfDroppedUris([shouted], files, 'linux')).toEqual([]);
  });

  it('reads a Windows file URI as VS Code writes it: an encoded, lower-case drive letter, or a share', () => {
    const win = [
      { name: 'fct_order', filePath: 'C:\\Users\\G\\proj\\.erd-studio\\gold\\tables\\dbo\\fct_order.dbml' },
      { name: 'dim_customer', filePath: '\\\\server\\share\\proj\\.erd-studio\\gold\\tables\\dbo\\dim_customer.dbml' },
    ];
    expect(tablesOfDroppedUris([
      'file:///c%3A/Users/G/proj/.erd-studio/gold/tables/dbo/fct_order.dbml',
      'file://server/share/proj/.erd-studio/gold/tables/dbo/dim_customer.dbml',
    ], win, 'win32')).toEqual(['fct_order', 'dim_customer']);
    expect(tablesOfDroppedUris(['file:///C:/users/g/PROJ/.erd-studio/gold/tables/dbo/FCT_ORDER.dbml'], win, 'win32')).toEqual(['fct_order']);
    // A URI list as VS Code joins it leaves a carriage return on a line read alone.
    expect(tablesOfDroppedUris(['file:///c%3A/Users/G/proj/.erd-studio/gold/tables/dbo/fct_order.dbml\r'], win, 'win32')).toEqual(['fct_order']);
  });

  it('decodes a percent-encoded path', () => {
    const spaced = [{ name: 'fct_order', filePath: '/my proj/.erd-studio/gold/tables/gold/fct_order.dbml' }];
    expect(tablesOfDroppedUris(['file:///my%20proj/.erd-studio/gold/tables/gold/fct_order.dbml'], spaced, 'linux')).toEqual(['fct_order']);
  });
});

describe('tableFilesOfDroppedUris', () => {
  const uri = (p: string): string => pathToFileURL(p).href;
  const twins = [
    { name: 'addresse', filePath: '/proj/.erd-studio/bronze/tables/bqs/addresse.dbml' },
    { name: 'addresse', filePath: '/proj/.erd-studio/bronze/tables/ccc/addresse.dbml' },
    { name: 'kunde', filePath: '/proj/.erd-studio/bronze/tables/ccc/kunde.dbml', shadowedBy: '/proj/x.dbml' },
  ];

  it('gives each dropped table file once, by its file: two tables of one name are two tables', () => {
    expect(tableFilesOfDroppedUris([
      uri('/proj/.erd-studio/bronze/tables/ccc/addresse.dbml'),
      uri('/proj/.erd-studio/bronze/tables/bqs/addresse.dbml'),
      uri('/proj/.erd-studio/bronze/tables/ccc/addresse.dbml'),
      uri('/proj/.erd-studio/bronze/tables/ccc/kunde.dbml'),
      uri('/proj/README.md'),
    ], twins, 'linux')).toEqual([twins[1], twins[0]]);
    // By name, as before, the second addresse is the first one again.
    expect(tablesOfDroppedUris(twins.slice(0, 2).map((f) => uri(f.filePath)), twins, 'linux')).toEqual(['addresse']);
  });
});

describe('tablesOfTreeDrop (Table Library rows dropped on a Diagrams row)', () => {
  const uri = (p: string): string => pathToFileURL(p).href;
  const lib = [
    { name: 'addresse', filePath: '/proj/.erd-studio/bronze/tables/bqs/addresse.dbml' },
    { name: 'addresse', filePath: '/proj/.erd-studio/bronze/tables/ccc/addresse.dbml' },
    { name: 'kunde', filePath: '/proj/.erd-studio/bronze/tables/ccc/kunde.dbml' },
  ];

  it('adds the dragged names; by their files where two schema folders share a name', () => {
    const drop = { tables: ['addresse'], uris: [uri(lib[1].filePath)] };
    expect(tablesOfTreeDrop(drop, lib, { byFile: false }, 'linux')).toEqual({ names: ['addresse'] });
    expect(tablesOfTreeDrop(drop, lib, { byFile: true }, 'linux')).toEqual({ names: ['addresse'], files: [lib[1].filePath] });
  });

  it('with no names it could read, adds the tables its files are, then the remembered drag; else nothing', () => {
    expect(tablesOfTreeDrop({ tables: [], uris: [uri(lib[2].filePath)] }, lib, { byFile: false }, 'linux')).toEqual({ names: ['kunde'] });
    expect(tablesOfTreeDrop({ tables: [], uris: [] }, lib, { byFile: false, remembered: { tables: ['kunde'] } }, 'linux')).toEqual({ names: ['kunde'] });
    expect(tablesOfTreeDrop({ tables: [], uris: [] }, lib, { byFile: true, remembered: { tables: ['addresse'], files: [lib[0].filePath] } }, 'linux'))
      .toEqual({ names: ['addresse'], files: [lib[0].filePath] });
    expect(tablesOfTreeDrop({ tables: [], uris: ['file:///proj/README.md'] }, lib, { byFile: false }, 'linux')).toBeUndefined();
    expect(tablesOfTreeDrop({ tables: [], uris: [] }, lib, { byFile: false, remembered: { tables: [] } }, 'linux')).toBeUndefined();
  });

  // Windows, as VS Code writes a dragged row's file there (vscode.Uri.file(...).toString()):
  // an encoded, lower-case drive letter; joined with CRLF in text/uri-list.
  it('reads a Windows drag: encoded or plain drive letter, any case, CRLF-joined lines', () => {
    const win = [
      { name: 'addresse', filePath: 'C:\\Users\\reporter\\proj\\.erd-studio\\bronze\\tables\\bqs\\addresse.dbml' },
      { name: 'addresse', filePath: 'C:\\Users\\reporter\\proj\\.erd-studio\\bronze\\tables\\ccc\\addresse.dbml' },
      { name: 'kunde', filePath: 'C:\\Users\\reporter\\proj\\.erd-studio\\bronze\\tables\\ccc\\kunde.dbml' },
    ];
    const lines = 'file:///c%3A/Users/reporter/proj/.erd-studio/bronze/tables/ccc/addresse.dbml\r\nfile:///C:/users/REPORTER/proj/.erd-studio/bronze/tables/ccc/KUNDE.dbml';
    const uris = lines.split(/\r?\n/);
    expect(tablesOfTreeDrop({ tables: [], uris }, win, { byFile: true }, 'win32')).toEqual({
      names: ['addresse', 'kunde'], files: [win[1].filePath, win[2].filePath],
    });
    // Names read: by name unless two schema folders share one.
    expect(tablesOfTreeDrop({ tables: ['addresse', 'kunde'], uris }, win, { byFile: false }, 'win32')).toEqual({ names: ['addresse', 'kunde'] });
  });
});

describe('dropGridPositions', () => {
  it('puts the first table under the pointer and the rest in rows of four', () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    const at = dropGridPositions(names, { x: 500.4, y: 300 });
    const left = Math.round(500.4 - NODE_WIDTH / 2);
    expect(DROP_GRID_COLUMNS).toBe(4);
    expect(at.a).toEqual({ x: left, y: 280 });
    expect(at.b).toEqual({ x: left + NODE_WIDTH + PADDING, y: 280 });
    expect(at.d).toEqual({ x: left + 3 * (NODE_WIDTH + PADDING), y: 280 });
    expect(at.e).toEqual({ x: left, y: 280 + NODE_HEIGHT + PADDING });
    expect(Object.keys(dropGridPositions([], { x: 0, y: 0 }))).toEqual([]);
  });
});

describe('validateDropTablesPayload', () => {
  it('accepts a finite point with a list of URIs, empty too', () => {
    expect(validateDropTablesPayload({ position: { x: 1, y: -2.5 }, uris: [] })).toBeNull();
    expect(validateDropTablesPayload({ position: { x: 1, y: 2 }, uris: [], fromLibrary: true })).toBeNull();
    expect(validateDropTablesPayload({ position: { x: 1, y: 2 }, uris: [], fromLibrary: false })).toBeNull();
    expect(validateDropTablesPayload({ position: { x: 1, y: 2 }, uris: [], afterDrag: true })).toBeNull();
    expect(validateDropTablesPayload({ position: { x: 0, y: 0 }, uris: ['file:///a.dbml'] })).toBeNull();
  });

  it.each([
    [undefined],
    [null],
    [[]],
    [{ uris: [] }],
    [{ position: { x: Number.NaN, y: 0 }, uris: [] }],
    [{ position: { x: 0, y: Number.POSITIVE_INFINITY }, uris: [] }],
    [{ position: { x: '1', y: 0 }, uris: [] }],
    [{ position: { x: 0, y: 0 } }],
    [{ position: { x: 0, y: 0 }, uris: 'file:///a.dbml' }],
    [{ position: { x: 0, y: 0 }, uris: [42] }],
    [{ position: { x: 0, y: 0 }, uris: [], fromLibrary: 'yes' }],
    [{ position: { x: 0, y: 0 }, uris: [], afterDrag: 1 }],
    [{ position: { x: 0, y: 0 }, uris: ['x'.repeat(DROP_TABLES_URI_MAX_LENGTH + 1)] }],
    [{ position: { x: 0, y: 0 }, uris: Array.from({ length: DROP_TABLES_URI_LIMIT + 1 }, () => 'file:///a.dbml') }],
  ])('refuses %j', (payload) => {
    expect(validateDropTablesPayload(payload)).toEqual(expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

const NATIVE = path.resolve(__dirname, '../fixtures/dbml-native');
let root: string;

function buildProvider(projectRoot: string): SemanticEditorProvider {
  const layerService = new LayerService(projectRoot, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(projectRoot, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    extensionUri: vscode.Uri.file(path.join(projectRoot, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(projectRoot, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty } as unknown as ManifestService,
    { loadYmlData: async () => empty } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    projectRoot,
    new SelectorsService(subjectAreaService, projectRoot, '.erd-studio'),
    tableLibraryService,
    new OwnWriteTracker(),
  );
}

const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const fileUri = (rel: string): string => pathToFileURL(at(rel)).href;
const SALES = 'gold/diagrams/sales.dbml';
const STAGING = 'silver/diagrams/staging.dbml';
const DIM_CUSTOMER = 'gold/tables/gold/dim_customer.dbml';
const DIM_REGION = 'gold/tables/gold/dim_region.dbml';
const FCT_ORDER = 'gold/tables/gold/fct_order.dbml';

async function loaded(provider: SemanticEditorProvider, rel = STAGING) {
  const panel = createMockWebviewPanel();
  const doc = createMockTextDocument(at(rel), fs.readFileSync(at(rel), 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(doc);
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  await panel._simulateMessage({ type: 'ready' });
  panel._postedMessages.length = 0;
  _appliedEdits.length = 0;
  return { panel, doc };
}

type Panel = ReturnType<typeof createMockWebviewPanel>;
const posted = (panel: Panel, type: string) => panel._postedMessages.filter((m) => (m as { type: string }).type === type);
const errors = (panel: Panel): string[] => posted(panel, 'error').map((m) => (m as { payload: { message: string } }).payload.message);
const notices = (panel: Panel): string[] => posted(panel, 'canvasNotice').map((m) => (m as { payload: { message: string } }).payload.message);
const drop = (panel: Panel, uris: string[], position = { x: 500, y: 300 }, fromLibrary?: boolean) =>
  panel._simulateMessage({ type: 'dropTables', payload: { position, uris, ...(fromLibrary === undefined ? {} : { fromLibrary }) } });
/** The webview saw a Table Library drag end over the canvas; no drop event arrived. */
const dragEndedOver = (panel: Panel, position = { x: 500, y: 300 }) =>
  panel._simulateMessage({ type: 'dropTables', payload: { position, uris: [], afterDrag: true } });

describe('afterDragLands', () => {
  const T = 1_000_000;
  const pending = { at: T, onScreen: new Set(['a']) };
  it('is the pending, fresh drag, for a canvas on screen when it started and still on screen', () => {
    expect(afterDragLands(pending, 'a', true, T + 3_000)).toBe(true);
  });
  it('is nothing once the drag is used up or stale, for another canvas, or one not on screen (then or now)', () => {
    expect(afterDragLands(undefined, 'a', true, T + 1)).toBe(false);
    expect(afterDragLands(pending, 'a', true, T + PENDING_LIBRARY_DRAG_MS + 1)).toBe(false);
    expect(afterDragLands(pending, 'a', true, T - 1)).toBe(false);
    expect(afterDragLands(pending, 'b', true, T + 1)).toBe(false);
    expect(afterDragLands(pending, 'a', false, T + 1)).toBe(false);
    expect(afterDragLands({ at: T }, 'a', true, T + 1)).toBe(false);
  });
});

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-drop-tables-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('dropTables', () => {
  it('adds the dropped table files in one edit, at the drop point, and selects them without moving the view', async () => {
    const provider = buildProvider(root);
    const { panel, doc } = await loaded(provider);
    await drop(panel, [fileUri(DIM_CUSTOMER), fileUri(DIM_REGION)]);
    expect(errors(panel)).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    const text = doc.getText();
    expect(text).toContain('use { table gold.dim_customer }');
    expect(text).toContain('use { table gold.dim_region }');
    const left = 500 - NODE_WIDTH / 2;
    expect(text).toMatch(new RegExp(`dim_customer ${left} 280\\b`));
    expect(text).toMatch(new RegExp(`dim_region ${left + NODE_WIDTH + PADDING} 280\\b`));
    // Selected where they landed: no revealTable (it centres and zooms, and opens the detail panel).
    expect(posted(panel, 'selectTables')).toEqual([{ type: 'selectTables', payload: { modelNames: ['dim_customer', 'dim_region'] } }]);
    expect(posted(panel, 'revealTable')).toEqual([]);
  });

  it('with no table file among the URIs, adds the Table Library drag of the last minute, once', async () => {
    const provider = buildProvider(root);
    const { panel, doc } = await loaded(provider);
    provider.noteLibraryDrag(['dim_region']);
    await drop(panel, [pathToFileURL(path.join(root, 'README.md')).href]);
    expect(_appliedEdits).toHaveLength(1);
    expect(doc.getText()).toContain('use { table gold.dim_region }');
    // Used up: a second drop with nothing in it adds nothing.
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    await drop(panel, []);
    expect(_appliedEdits).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(DROP_TABLES_NOTHING_MESSAGE);
  });

  it('prefers the dropped files over the remembered drag, and forgets the drag', async () => {
    const provider = buildProvider(root);
    const { panel, doc } = await loaded(provider);
    provider.noteLibraryDrag(['customer_profile']);
    await drop(panel, [fileUri(DIM_CUSTOMER)]);
    expect(doc.getText()).toContain('use { table gold.dim_customer }');
    expect(doc.getText()).not.toContain('customer_profile');
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    await drop(panel, []);
    expect(info).toHaveBeenCalledWith(DROP_TABLES_NOTHING_MESSAGE);
  });

  it('a drop that says it is a Table Library drag adds the whole remembered drag, not only the rows whose files it carries', async () => {
    // A schema row and a table row dragged together: VS Code gives the drop the table row's file only.
    const provider = buildProvider(root);
    const { panel, doc } = await loaded(provider);
    provider.noteLibraryDrag(['dim_customer', 'dim_region']);
    await drop(panel, [fileUri(DIM_CUSTOMER)], { x: 500, y: 300 }, true);
    expect(_appliedEdits).toHaveLength(1);
    expect(doc.getText()).toContain('use { table gold.dim_customer }');
    expect(doc.getText()).toContain('use { table gold.dim_region }');
  });

  it('a Table Library drop with no remembered drag left falls back on the files it carries', async () => {
    const provider = buildProvider(root);
    const { panel, doc } = await loaded(provider);
    await drop(panel, [fileUri(DIM_REGION)], { x: 500, y: 300 }, true);
    expect(_appliedEdits).toHaveLength(1);
    expect(doc.getText()).toContain('use { table gold.dim_region }');
  });

  it('a drag older than a minute is not used', async () => {
    const provider = buildProvider(root);
    const { panel, doc } = await loaded(provider);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    provider.noteLibraryDrag(['dim_region']);
    clock.mockReturnValue(now + PENDING_LIBRARY_DRAG_MS + 1);
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    await drop(panel, []);
    expect(info).toHaveBeenCalledWith(DROP_TABLES_NOTHING_MESSAGE);
    expect(_appliedEdits).toHaveLength(0);
    expect(doc.getText()).not.toContain('dim_region');
  });

  it('a table already on the diagram is selected and named on the canvas, not added', async () => {
    const provider = buildProvider(root);
    const { panel } = await loaded(provider);
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    await drop(panel, [fileUri(FCT_ORDER)]);
    expect(_appliedEdits).toHaveLength(0);
    expect(posted(panel, 'selectTables')).toEqual([{ type: 'selectTables', payload: { modelNames: ['fct_order'] } }]);
    expect(posted(panel, 'revealTable')).toEqual([]);
    expect(notices(panel)).toEqual(['"fct_order" is already on this diagram.']);
    expect(info).not.toHaveBeenCalled();
    expect(errors(panel)).toEqual([]);
  });

  it('a Shift-drop of a Table Library row already there (the drag remembered, no file in the drop) says so too', async () => {
    const provider = buildProvider(root);
    const { panel } = await loaded(provider);
    provider.noteLibraryDrag(['fct_order'], [at(FCT_ORDER)]);
    await drop(panel, [], { x: 1, y: 1 }, true);
    expect(_appliedEdits).toHaveLength(0);
    expect(notices(panel)).toEqual(['"fct_order" is already on this diagram.']);
  });

  it('a drag that ended over the canvas with no drop event (afterDrag) adds the remembered drag at that point, once', async () => {
    const provider = buildProvider(root);
    const { panel, doc } = await loaded(provider);
    provider.noteLibraryDrag(['dim_region'], [at(DIM_REGION)]);
    await dragEndedOver(panel, { x: 500, y: 300 });
    expect(errors(panel)).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(doc.getText()).toContain('use { table gold.dim_region }');
    expect(doc.getText()).toMatch(new RegExp(`dim_region ${500 - NODE_WIDTH / 2} 280\\b`));
    // Used up: a second one (or a real drop's echo) adds nothing and says nothing.
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    await dragEndedOver(panel);
    expect(_appliedEdits).toHaveLength(1);
    expect(info).not.toHaveBeenCalled();
  });

  it('afterDrag of a table already there says so on the canvas', async () => {
    const provider = buildProvider(root);
    const { panel } = await loaded(provider);
    provider.noteLibraryDrag(['fct_order'], [at(FCT_ORDER)]);
    await dragEndedOver(panel);
    expect(_appliedEdits).toHaveLength(0);
    expect(notices(panel)).toEqual(['"fct_order" is already on this diagram.']);
  });

  it('afterDrag with no drag waiting, a stale drag, or from a canvas that was not on screen when the drag started, does nothing and says nothing', async () => {
    const provider = buildProvider(root);
    const { panel, doc } = await loaded(provider);
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    await dragEndedOver(panel);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    provider.noteLibraryDrag(['dim_region']);
    clock.mockReturnValue(now + PENDING_LIBRARY_DRAG_MS + 1);
    await dragEndedOver(panel);
    clock.mockRestore();
    (panel as unknown as { visible: boolean }).visible = false;
    provider.noteLibraryDrag(['dim_region']);
    (panel as unknown as { visible: boolean }).visible = true;
    await dragEndedOver(panel);
    expect(_appliedEdits).toHaveLength(0);
    expect(doc.getText()).not.toContain('dim_region');
    expect(info).not.toHaveBeenCalled();
    expect(errors(panel)).toEqual([]);
    // That drag is still waiting for a real drop.
    await drop(panel, [], { x: 1, y: 1 }, true);
    expect(doc.getText()).toContain('use { table gold.dim_region }');
  });

  it('several tables all already there are named together', async () => {
    const provider = buildProvider(root);
    const { panel } = await loaded(provider, SALES);
    await drop(panel, [fileUri(FCT_ORDER), fileUri(DIM_REGION)]);
    expect(_appliedEdits).toHaveLength(0);
    expect(notices(panel)).toEqual(['These 2 tables are already on this diagram.']);
    expect(posted(panel, 'selectTables')).toEqual([{ type: 'selectTables', payload: { modelNames: ['fct_order', 'dim_region'] } }]);
    expect(posted(panel, 'revealTable')).toEqual([]);
  });

  it('adds the new ones of a mix, names the one already there on the canvas, and selects the new ones without moving the view', async () => {
    const provider = buildProvider(root);
    const { panel, doc } = await loaded(provider);
    await drop(panel, [fileUri(FCT_ORDER), fileUri(DIM_REGION)]);
    expect(_appliedEdits).toHaveLength(1);
    expect(doc.getText()).toContain('use { table gold.dim_region }');
    expect(posted(panel, 'selectTables')).toEqual([{ type: 'selectTables', payload: { modelNames: ['dim_region'] } }]);
    expect(posted(panel, 'revealTable')).toEqual([]);
    expect(notices(panel)).toEqual(['Added 1 table. Already on this diagram: fct_order.']);
  });

  it('keeps the existing placement for a drop on a positioned diagram: only the new table moves in', async () => {
    const provider = buildProvider(root);
    const { panel, doc } = await loaded(provider, SALES);
    // Every library table is on sales; take dim_region off first, then drop it back.
    const before = doc.getText();
    expect(before).toMatch(/fct_order 400 200\b/);
    await panel._simulateMessage({ type: 'removeModels', payload: { modelNames: ['dim_region'] } });
    _appliedEdits.length = 0;
    await drop(panel, [fileUri(DIM_REGION)], { x: 1000, y: 1000 });
    expect(_appliedEdits).toHaveLength(1);
    expect(doc.getText()).toMatch(new RegExp(`dim_region ${1000 - NODE_WIDTH / 2} 980\\b`));
    expect(doc.getText()).toMatch(/fct_order 400 200\b/);
  });

  it('says what to drop when nothing names a table', async () => {
    const provider = buildProvider(root);
    const { panel } = await loaded(provider);
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    await drop(panel, ['https://example.com/x']);
    expect(info).toHaveBeenCalledWith(DROP_TABLES_NOTHING_MESSAGE);
    expect(_appliedEdits).toHaveLength(0);
  });

  it('refuses a bad payload with a toast and writes nothing', async () => {
    const provider = buildProvider(root);
    const { panel } = await loaded(provider);
    await panel._simulateMessage({ type: 'dropTables', payload: { position: { x: Number.NaN, y: 0 }, uris: [] } });
    await panel._simulateMessage({ type: 'dropTables', payload: { position: { x: 0, y: 0 }, uris: [7] } });
    expect(errors(panel)).toEqual([
      'Failed to add the dropped tables: Position coordinates must be finite numbers.',
      'Failed to add the dropped tables: Each dropped URI must be text.',
    ]);
    expect(_appliedEdits).toHaveLength(0);
  });

  it('is refused on the physical stage (it is not on the read-only allowlist)', async () => {
    const provider = buildProvider(root);
    const { panel, doc } = await loaded(provider);
    const entry = [...(provider as unknown as { openPanels: Map<string, { activeStage: string }> }).openPanels.values()][0];
    entry.activeStage = 'physical';
    await drop(panel, [fileUri(DIM_REGION)]);
    expect(errors(panel)).toEqual([PHYSICAL_READ_ONLY_MESSAGE]);
    expect(_appliedEdits).toHaveLength(0);
    expect(doc.getText()).not.toContain('dim_region');
  });
});

describe('noteLibraryDrag', () => {
  it('tells each loaded canvas on the logical stage, and no other', async () => {
    const provider = buildProvider(root);
    const staging = await loaded(provider, STAGING);
    const sales = await loaded(provider, SALES);
    const opening = createMockWebviewPanel();
    const doc = createMockTextDocument(at('gold/diagrams/other.dbml'), fs.readFileSync(at(SALES), 'utf-8'), { persist: true });
    await provider.resolveCustomTextEditor(
      doc as unknown as import('vscode').TextDocument,
      opening as unknown as import('vscode').WebviewPanel,
      {} as import('vscode').CancellationToken,
    );
    const panels = (provider as unknown as { openPanels: Map<string, { activeStage: string; webview: unknown }> }).openPanels;
    [...panels.values()].find((p) => p.webview === sales.panel.webview)!.activeStage = 'physical';
    provider.noteLibraryDrag(['dim_customer', 'dim_region']);
    expect(posted(staging.panel, 'libraryDragStarted')).toEqual([
      { type: 'libraryDragStarted', payload: { tables: ['dim_customer', 'dim_region'] } },
    ]);
    expect(posted(sales.panel, 'libraryDragStarted')).toEqual([]);
    expect(posted(opening, 'libraryDragStarted')).toEqual([]);
  });

  it('once the drag is used up (a drop on a row or a canvas, or a missed drop), every loaded canvas is told it ended', async () => {
    const provider = buildProvider(root);
    const staging = await loaded(provider, STAGING);
    const sales = await loaded(provider, SALES);
    expect(provider.takeRememberedLibraryDrag()).toBeUndefined();
    expect(posted(staging.panel, 'libraryDragEnded')).toEqual([]);
    provider.noteLibraryDrag(['dim_customer'], [at('gold/tables/gold/dim_customer.dbml')]);
    const peeked = provider.peekRememberedLibraryDrag();
    expect(peeked).toMatchObject({ tables: ['dim_customer'], files: [at('gold/tables/gold/dim_customer.dbml')] });
    expect(typeof peeked?.at).toBe('number');
    // A peek does not use it up.
    expect(provider.peekRememberedLibraryDrag()?.tables).toEqual(['dim_customer']);
    expect(provider.takeRememberedLibraryDrag()?.tables).toEqual(['dim_customer']);
    expect(posted(staging.panel, 'libraryDragEnded')).toEqual([{ type: 'libraryDragEnded' }]);
    expect(posted(sales.panel, 'libraryDragEnded')).toEqual([{ type: 'libraryDragEnded' }]);
    expect(provider.peekRememberedLibraryDrag()).toBeUndefined();
  });

  // Verifier's step J (real VS Code 1.145): once a diagram tab was closed, every later Table
  // Library drag threw "Webview is disposed" here (the dispose handler read the disposed panel's
  // `webview`, so the closed canvas stayed in openPanels, and its `visible` threw on the next drag).
  // The drag was never remembered: a row drop did nothing again, and canvas Shift-drops raced.
  it('still works after another diagram tab was closed (its panel throws once disposed, as in VS Code)', async () => {
    const provider = buildProvider(root);
    const closed = await loaded(provider, SALES);
    const { panel, doc } = await loaded(provider, STAGING);
    closed.panel.dispose();
    const panels = (provider as unknown as { openPanels: Map<string, { webview: unknown }> }).openPanels;
    expect(panels.size).toBe(1);
    expect(() => provider.noteLibraryDrag(['dim_region'], [at(DIM_REGION)])).not.toThrow();
    expect(posted(panel, 'libraryDragStarted')).toEqual([{ type: 'libraryDragStarted', payload: { tables: ['dim_region'] } }]);
    // The drag is remembered: a drop that reached the canvas only as "the drag ended over it" lands.
    await dragEndedOver(panel);
    expect(doc.getText()).toContain('use { table gold.dim_region }');
    expect(errors(panel)).toEqual([]);
  });

  it('a canvas whose dispose never reached us is skipped, not thrown on, by the next drag and drop', async () => {
    const provider = buildProvider(root);
    const gone = await loaded(provider, SALES);
    const { panel, doc } = await loaded(provider, STAGING);
    // Disposed without its onDidDispose (as when VS Code closes a tab under an Undo).
    (gone.panel as unknown as { _disposed: boolean })._disposed = true;
    expect(() => provider.noteLibraryDrag(['dim_region'], [at(DIM_REGION)])).not.toThrow();
    await dragEndedOver(panel);
    expect(doc.getText()).toContain('use { table gold.dim_region }');
    const panels = (provider as unknown as { openPanels: Map<string, { webview: unknown }> }).openPanels;
    expect(panels.size).toBe(1);
  });

  it('an empty drag tells no one', async () => {
    const provider = buildProvider(root);
    const { panel } = await loaded(provider);
    provider.noteLibraryDrag([]);
    expect(posted(panel, 'libraryDragStarted')).toEqual([]);
  });
});

describe('libraryDragReleased (a glass sidebar drag let go outside the sidebar)', () => {
  const frame = { originX: 300, originY: 120, scale: 1, windowX: 40, windowY: 40, width: 1000, height: 700, pixelRatio: 2 };
  const release = { x: 520, y: 449, refX: 30, refY: 40, refScreenX: 118, refScreenY: 148, windowX: 40, windowY: 40 };
  const column = (panel: Panel, n: number | undefined) => { (panel as unknown as { viewColumn?: number }).viewColumn = n; };

  it('tells each loaded logical canvas on screen then and now, with the last frame its editor group reported', async () => {
    const provider = buildProvider(root);
    const staging = await loaded(provider, STAGING);
    const sales = await loaded(provider, SALES);
    column(staging.panel, 1);
    column(sales.panel, 2);
    // Staging's group reported where it sits; the sales group did not.
    await staging.panel._simulateMessage({ type: 'canvasFrame', payload: frame });
    provider.noteLibraryDrag(['dim_region'], [at(DIM_REGION)]);
    provider.libraryDragReleased(release);
    expect(posted(staging.panel, 'libraryDragReleased')).toEqual([{ type: 'libraryDragReleased', payload: { ...release, frame } }]);
    expect(posted(sales.panel, 'libraryDragReleased')).toEqual([{ type: 'libraryDragReleased', payload: release }]);
    // Nothing is added by the release itself: the canvas's afterDrag drop does that, once.
    expect(_appliedEdits).toHaveLength(0);
    await dragEndedOver(staging.panel);
    await dragEndedOver(sales.panel);
    expect(_appliedEdits).toHaveLength(1);
    expect(staging.doc.getText()).toContain('use { table gold.dim_region }');
  });

  it('tells no one with no drag waiting (used up, stale), and skips a canvas off screen or on the physical stage', async () => {
    const provider = buildProvider(root);
    const staging = await loaded(provider, STAGING);
    const sales = await loaded(provider, SALES);
    provider.libraryDragReleased(release);
    expect(posted(staging.panel, 'libraryDragReleased')).toEqual([]);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    provider.noteLibraryDrag(['dim_region']);
    clock.mockReturnValue(now + PENDING_LIBRARY_DRAG_MS + 1);
    provider.libraryDragReleased(release);
    clock.mockRestore();
    expect(posted(staging.panel, 'libraryDragReleased')).toEqual([]);
    // Sales was hidden when the drag started; staging shows the physical stage.
    (sales.panel as unknown as { visible: boolean }).visible = false;
    provider.noteLibraryDrag(['dim_region']);
    (sales.panel as unknown as { visible: boolean }).visible = true;
    const panels = (provider as unknown as { openPanels: Map<string, { activeStage: string; webview: unknown }> }).openPanels;
    [...panels.values()].find((p) => p.webview === staging.panel.webview)!.activeStage = 'physical';
    provider.libraryDragReleased(release);
    expect(posted(sales.panel, 'libraryDragReleased')).toEqual([]);
    (sales.panel as unknown as { visible: boolean }).visible = true;
    [...panels.values()].find((p) => p.webview === staging.panel.webview)!.activeStage = 'logical';
    provider.libraryDragReleased({ ...release, x: Number.NaN });
    expect(posted(staging.panel, 'libraryDragReleased')).toEqual([]);
    expect(posted(sales.panel, 'libraryDragReleased')).toEqual([]);
  });

  it('keeps only a well-formed canvasFrame, per editor group, and on the physical stage too (it writes nothing)', async () => {
    const provider = buildProvider(root);
    const { panel } = await loaded(provider, STAGING);
    column(panel, 3);
    await panel._simulateMessage({ type: 'canvasFrame', payload: { ...frame, originX: 'x' } });
    await panel._simulateMessage({ type: 'canvasFrame', payload: { ...frame, extra: 1 } });
    const frames = (provider as unknown as { canvasFrames: Map<number, unknown> }).canvasFrames;
    expect(frames.size).toBe(0);
    const panels = (provider as unknown as { openPanels: Map<string, { activeStage: string }> }).openPanels;
    [...panels.values()][0].activeStage = 'physical';
    await panel._simulateMessage({ type: 'canvasFrame', payload: frame });
    expect(errors(panel)).toEqual([]);
    expect(frames.get(3)).toEqual(frame);
  });
});

describe('validateCanvasFramePayload', () => {
  const frame = { originX: -12.5, originY: 80, scale: 1.2, windowX: 0, windowY: -900, width: 1200, height: 800, pixelRatio: 2.4 };
  it('takes exactly its eight finite numbers, in range', () => {
    expect(validateCanvasFramePayload(frame)).toBeNull();
  });
  it('refuses anything else', () => {
    expect(validateCanvasFramePayload(null)).not.toBeNull();
    expect(validateCanvasFramePayload([1, 2])).not.toBeNull();
    expect(validateCanvasFramePayload({ ...frame, width: undefined })).not.toBeNull();
    expect(validateCanvasFramePayload({ ...frame, path: '/etc' })).not.toBeNull();
    expect(validateCanvasFramePayload({ ...frame, originX: '1' })).not.toBeNull();
    expect(validateCanvasFramePayload({ ...frame, originY: Number.POSITIVE_INFINITY })).not.toBeNull();
    expect(validateCanvasFramePayload({ ...frame, windowX: CANVAS_FRAME_MAX + 1 })).not.toBeNull();
    expect(validateCanvasFramePayload({ ...frame, height: 0 })).not.toBeNull();
    expect(validateCanvasFramePayload({ ...frame, scale: 0 })).not.toBeNull();
    expect(validateCanvasFramePayload({ ...frame, pixelRatio: 17 })).not.toBeNull();
  });
});

describe('validateDragReleasePayload', () => {
  const release = { x: 520.5, y: 449, refX: 30, refY: 40, refScreenX: 118, refScreenY: 148, windowX: 40, windowY: -1000 };
  it('takes exactly its eight finite numbers, in range, and nothing else', () => {
    expect(validateDragReleasePayload(release)).toBeNull();
    expect(validateDragReleasePayload({ ...release, x: '1' })).not.toBeNull();
    expect(validateDragReleasePayload({ ...release, y: Number.NaN })).not.toBeNull();
    expect(validateDragReleasePayload({ ...release, refX: CANVAS_FRAME_MAX + 1 })).not.toBeNull();
    expect(validateDragReleasePayload({ ...release, uri: 'file:///etc' })).not.toBeNull();
    expect(validateDragReleasePayload({ x: 1, y: 2 })).not.toBeNull();
    expect(validateDragReleasePayload(undefined)).not.toBeNull();
  });
});
