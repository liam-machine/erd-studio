/**
 * Opening a canvas (the `ready` handler) on a large library:
 *
 * - the host answers at once with `loading` (then the table count), and the
 *   message leaves before the diagram is read, so the webview never shows a
 *   false "Canvas disconnected";
 * - the payload is the same whether the library was read before or not
 *   (scoped reads give each table the relationships the whole library does);
 * - on a library with many unread files, the Add Existing Table rows go out
 *   by name (`detailsPending`) and `requestExistingTables` answers in full;
 * - positions computed for a partly placed diagram are written as a layout
 *   and the diagram is not read a second time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _appliedEdits, _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { EXISTING_TABLES_READ_AT_MOST, SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';

const NATIVE = path.resolve(__dirname, '..', 'fixtures', 'dbml-native');

let root: string;

interface Harness {
  provider: SemanticEditorProvider;
  subjectAreaService: SubjectAreaService;
  tableLibraryService: TableLibraryService;
}

function buildProvider(projectRoot: string): Harness {
  const layerService = new LayerService(projectRoot, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(projectRoot, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    extensionUri: vscode.Uri.file(path.join(projectRoot, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(projectRoot, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  const provider = new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty, getManifestPath: () => path.join(projectRoot, 'target', 'manifest.json') } as unknown as ManifestService,
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    projectRoot,
    new SelectorsService(subjectAreaService, projectRoot, '.erd-studio'),
    tableLibraryService,
    new OwnWriteTracker(),
  );
  provider.setLogicalOnly(true);
  return { provider, subjectAreaService, tableLibraryService };
}

const at = (rel: string): string => path.join(root, '.erd-studio', rel);

async function open(h: Harness, rel: string) {
  const doc = createMockTextDocument(at(rel), fs.readFileSync(at(rel), 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(doc);
  const panel = createMockWebviewPanel();
  await h.provider.resolveCustomTextEditor(doc as never, panel as never, {} as never);
  return { doc, panel };
}

type Posted = { type: string; payload?: any };
const posted = (panel: { _postedMessages: unknown[] }): Posted[] => panel._postedMessages as Posted[];
const loadedPayload = (panel: { _postedMessages: unknown[] }) => posted(panel).find((m) => m.type === 'domainLoaded')?.payload;

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-open-path-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the ready handler answers with loading first', () => {
  it('posts loading, then loading with the table count, then the diagram', async () => {
    const h = buildProvider(root);
    const { panel } = await open(h, 'gold/diagrams/sales.dbml');
    await panel._simulateMessage({ type: 'ready' });
    const types = posted(panel).map((m) => m.type);
    expect(types.slice(0, 3)).toEqual(['loading', 'loading', 'domainLoaded']);
    expect(posted(panel)[0].payload).toEqual({});
    expect(posted(panel)[1].payload).toEqual({ tables: 6 });
  });

  it('the loading message leaves the host (a turn of the event loop) before the diagram is read', async () => {
    const h = buildProvider(root);
    const { panel } = await open(h, 'gold/diagrams/sales.dbml');
    const order: string[] = [];
    const postMessage = panel.webview.postMessage.bind(panel.webview);
    vi.spyOn(panel.webview, 'postMessage').mockImplementation((message: unknown) => {
      const type = (message as { type: string }).type;
      order.push(`post:${type}`);
      // What VS Code's IPC does with a posted message: write it on a later turn.
      if (type === 'loading') setTimeout(() => order.push('sent:loading'), 0);
      return postMessage(message);
    });
    const read = h.subjectAreaService.getSubjectArea.bind(h.subjectAreaService);
    vi.spyOn(h.subjectAreaService, 'getSubjectArea').mockImplementation((...args) => {
      order.push('read');
      return read(...args);
    });
    await panel._simulateMessage({ type: 'ready' });
    expect(order.indexOf('sent:loading')).toBeGreaterThan(-1);
    expect(order.indexOf('sent:loading')).toBeLessThan(order.indexOf('read'));
  });

  it('a broken diagram: loading (no count), then the error', async () => {
    fs.writeFileSync(at('gold/diagrams/sales.dbml'), 'Project sales {\n  erd_schema_version: \'7\'\n');
    const h = buildProvider(root);
    const { panel } = await open(h, 'gold/diagrams/sales.dbml');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await panel._simulateMessage({ type: 'ready' });
    const types = posted(panel).map((m) => m.type);
    expect(types[0]).toBe('loading');
    expect(types.filter((t) => t === 'loading')).toHaveLength(1);
    expect(types).toContain('error');
    expect(types).not.toContain('domainLoaded');
  });

  it('a JSON diagram is counted from its file too', async () => {
    fs.mkdirSync(at('silver'), { recursive: true });
    fs.writeFileSync(at('silver/plain.json'), JSON.stringify({
      schemaVersion: 5, domain: 'plain', layer: 'silver', description: '',
      logical: { models: ['dim_date', 'fct_order'], relationships: [] },
      viewConfig: { positions: { dim_date: { x: 0, y: 0 }, fct_order: { x: 300, y: 0 } } },
    }));
    const h = buildProvider(root);
    const { panel } = await open(h, 'silver/plain.json');
    await panel._simulateMessage({ type: 'ready' });
    expect(posted(panel).filter((m) => m.type === 'loading').map((m) => m.payload)).toEqual([{}, { tables: 2 }]);
  });
});

describe('the payload does not depend on what was read before', () => {
  it('a cold open posts the same diagram as an open after the whole library was read', async () => {
    const cold = buildProvider(root);
    const first = await open(cold, 'gold/diagrams/sales.dbml');
    await first.panel._simulateMessage({ type: 'ready' });

    const warm = buildProvider(root);
    warm.tableLibraryService.listTables();
    const second = await open(warm, 'gold/diagrams/sales.dbml');
    await second.panel._simulateMessage({ type: 'ready' });

    const coldPayload = loadedPayload(first.panel);
    expect(coldPayload.models).toHaveLength(6);
    expect(coldPayload.relationships.length).toBeGreaterThanOrEqual(8);
    expect(JSON.parse(JSON.stringify(coldPayload))).toEqual(JSON.parse(JSON.stringify(loadedPayload(second.panel))));
  });
});

describe('Add Existing Table rows on a large library', () => {
  function addTables(count: number): string[] {
    const names = Array.from({ length: count }, (_, i) => `extra_${String(i).padStart(3, '0')}`);
    for (const name of names) {
      fs.writeFileSync(at(`gold/tables/gold/${name}.dbml`), `Table gold.${name} {\n  id INT [pk]\n  name VARCHAR\n}\n`);
    }
    return names;
  }

  it(`more than ${EXISTING_TABLES_READ_AT_MOST} unread files go out by name, and requestExistingTables answers in full`, async () => {
    const names = addTables(EXISTING_TABLES_READ_AT_MOST + 20);
    const h = buildProvider(root);
    const { panel } = await open(h, 'gold/diagrams/sales.dbml');
    await panel._simulateMessage({ type: 'ready' });
    const rows = loadedPayload(panel).existingModels as Array<{ name: string; detailsPending?: true; columnCount: number; sourcePath: string }>;
    const pending = rows.filter((r) => r.detailsPending);
    expect(pending.map((r) => r.name)).toEqual(expect.arrayContaining(names));
    expect(pending.every((r) => r.columnCount === 0 && r.sourcePath.endsWith('.dbml'))).toBe(true);
    // Not read: no table file of those was parsed for the payload.
    expect(h.tableLibraryService.unreadTableFiles().map((e) => e.name)).toEqual(expect.arrayContaining(names));

    posted(panel).length = 0;
    await panel._simulateMessage({ type: 'requestExistingTables' });
    const answer = posted(panel).find((m) => m.type === 'existingTables')?.payload;
    expect(answer).toBeDefined();
    expect(answer.existingModels.some((r: { detailsPending?: true }) => r.detailsPending)).toBe(false);
    const extra = answer.existingModels.find((r: { name: string }) => r.name === names[0]);
    expect(extra).toMatchObject({ schema: 'gold', columnCount: 2, source: 'logical' });

    // The same rows a payload carries once the library has been read.
    posted(panel).length = 0;
    await panel._simulateMessage({ type: 'ready' });
    expect(answer.existingModels).toEqual(loadedPayload(panel).existingModels);
  });

  it(`up to ${EXISTING_TABLES_READ_AT_MOST} unread files are read for the payload, as before`, async () => {
    addTables(10);
    const h = buildProvider(root);
    const { panel } = await open(h, 'gold/diagrams/sales.dbml');
    await panel._simulateMessage({ type: 'ready' });
    const rows = loadedPayload(panel).existingModels as Array<{ detailsPending?: true }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.detailsPending)).toBe(false);
  });

  it('requestExistingTables is allowed on the physical stage (it only reads)', async () => {
    const h = buildProvider(root);
    h.provider.setLogicalOnly(false);
    const { doc, panel } = await open(h, 'gold/diagrams/sales.dbml');
    (h.provider as unknown as { openPanels: Map<string, { activeStage: string }> }).openPanels.get(doc.uri.toString())!.activeStage = 'physical';
    await panel._simulateMessage({ type: 'requestExistingTables' });
    expect(posted(panel).map((m) => m.type)).toContain('existingTables');
    expect(posted(panel).some((m) => m.type === 'error')).toBe(false);
  });
});

describe('a partly placed diagram', () => {
  it('DBML: the computed positions are written to erd_layout and the diagram is read once', async () => {
    // fct_order loses its position; the other five keep theirs.
    const diagramPath = at('gold/diagrams/sales.dbml');
    fs.writeFileSync(diagramPath, fs.readFileSync(diagramPath, 'utf-8').replace('    fct_order 400 200\n', ''));
    const h = buildProvider(root);
    const { doc, panel } = await open(h, 'gold/diagrams/sales.dbml');
    const reads = vi.spyOn(h.subjectAreaService, 'getSubjectArea');
    const before = _appliedEdits.length;
    await panel._simulateMessage({ type: 'ready' });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(_appliedEdits.length).toBe(before + 1);
    const placed = /\n {4}fct_order (-?[\d.]+) (-?[\d.]+)\n/.exec(doc.getText());
    expect(placed).not.toBeNull();
    expect(loadedPayload(panel).viewConfig.positions.fct_order).toEqual({ x: Number(placed![1]), y: Number(placed![2]) });
  });

  it('JSON: the same, written to the diagram file', async () => {
    fs.mkdirSync(at('silver'), { recursive: true });
    fs.writeFileSync(at('silver/plain.json'), JSON.stringify({
      schemaVersion: 5, domain: 'plain', layer: 'silver', description: '',
      logical: { models: ['dim_date', 'fct_order'], relationships: [] },
      viewConfig: { positions: { dim_date: { x: 0, y: 0 } } },
    }, null, 2) + '\n');
    const h = buildProvider(root);
    const { panel } = await open(h, 'silver/plain.json');
    const reads = vi.spyOn(h.subjectAreaService, 'getSubjectArea');
    await panel._simulateMessage({ type: 'ready' });
    expect(reads).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(fs.readFileSync(at('silver/plain.json'), 'utf-8'));
    expect(saved.viewConfig.positions.fct_order).toBeDefined();
    expect(loadedPayload(panel).viewConfig.positions.fct_order).toEqual(saved.viewConfig.positions.fct_order);
  });
});

describe('the background read of the library steps aside for a canvas', () => {
  it('opening a canvas and every message from it are foreground work', async () => {
    const h = buildProvider(root);
    const noteForegroundWork = vi.fn();
    h.provider.setLibraryWarmUp({ noteForegroundWork });
    const { panel } = await open(h, 'gold/diagrams/sales.dbml');
    expect(noteForegroundWork).toHaveBeenCalledTimes(1);
    await panel._simulateMessage({ type: 'ready' });
    await panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 1, y: 2 } } } });
    expect(noteForegroundWork).toHaveBeenCalledTimes(3);
  });
});

