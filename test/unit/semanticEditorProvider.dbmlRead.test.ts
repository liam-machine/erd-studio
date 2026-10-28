/**
 * The canvas reading native DBML storage (§5.2, §5.3, §5.9 of
 * docs/plans/native-dbml-storage.md, stage S4): a `.dbml` diagram renders,
 * table and relationships files opened as `file:` documents are handed to
 * the text editor while other schemes are not, a DBML document is never
 * `JSON.parse`d, every handler sees a v5 object, a single-file DBML in a
 * layer folder offers Import DBML, and an edit is refused (writes come in S5).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  _appliedEdits,
  _resetMockWorkspace,
  createMockTextDocument,
  createMockWebviewPanel,
} from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { telemetry } from '../../src/services/telemetryService';
import { IMPORT_DBML_COMMAND } from '../../src/commands/importDbml';
import { DBML_DIAGRAM_EDITING_NOT_AVAILABLE } from '../../src/providers/subjectAreaCodec';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';
import { detectSubjectAreaFormat } from '../../src/types/semantic';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');

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
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    projectRoot,
    new SelectorsService(subjectAreaService, projectRoot, '.erd-studio'),
    tableLibraryService,
    new OwnWriteTracker(),
  );
}

const at = (rel: string): string => path.join(root, '.erd-studio', rel);

function openDoc(rel: string) {
  return createMockTextDocument(at(rel), fs.readFileSync(at(rel), 'utf-8'));
}

async function resolve(provider: SemanticEditorProvider, doc: ReturnType<typeof createMockTextDocument>) {
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  return panel;
}

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-canvas-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a DBML diagram on the canvas', () => {
  it('renders: the posted payload is the diagram with its tables, library relationships and Notes', async () => {
    const provider = buildProvider(root);
    const panel = await resolve(provider, openDoc('gold/sales.dbml'));
    await panel._simulateMessage({ type: 'ready' });
    const loaded = panel._postedMessages.find((m) => (m as { type: string }).type === 'domainLoaded') as { payload: Record<string, any> };
    expect(loaded).toBeDefined();
    expect(loaded.payload.schemaVersion).toBe(7);
    expect(loaded.payload.domain).toBe('sales');
    expect(loaded.payload.layer).toBe('gold');
    expect(loaded.payload.models.map((m: { name: string }) => m.name)).toEqual(
      ['fct_order', 'dim_customer', 'dim_date', 'dim_region', 'customer_profile', 'bridge_empty'],
    );
    expect(loaded.payload.relationships.length).toBeGreaterThanOrEqual(8);
    expect(loaded.payload.viewConfig.annotations).toHaveLength(2);
    // The ready load never writes a DBML diagram's layout yet (S5).
    expect(_appliedEdits).toHaveLength(0);
    expect(panel._postedMessages.some((m) => (m as { type: string }).type === 'dbmlEmbeddedTables')).toBe(false);
  });

  it('places a diagram with no layout file without writing one', async () => {
    const provider = buildProvider(root);
    const panel = await resolve(provider, openDoc('silver/staging.dbml'));
    await panel._simulateMessage({ type: 'ready' });
    const loaded = panel._postedMessages.find((m) => (m as { type: string }).type === 'domainLoaded') as { payload: Record<string, any> };
    expect(Object.keys(loaded.payload.viewConfig.positions).sort()).toEqual(['dim_date', 'fct_order']);
    expect(fs.existsSync(at('silver/staging.dbdiagram'))).toBe(false);
    expect(_appliedEdits).toHaveLength(0);
    // No ELK pass is asked for: its position save would be refused with a toast on open (S5 writes layouts).
    expect((loaded as { autoLayout?: boolean }).autoLayout).toBeUndefined();
    expect(panel._postedMessages.some((m) => (m as { type: string }).type === 'error')).toBe(false);
  });

  it('refuses an edit with the not-yet message, and writes nothing', async () => {
    const provider = buildProvider(root);
    const panel = await resolve(provider, openDoc('gold/sales.dbml'));
    const before = fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8');
    await panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 10, y: 20 } } } });
    await panel._simulateMessage({ type: 'updateModelDescription', payload: { modelName: 'fct_order', description: 'changed' } });
    const errors = panel._postedMessages.filter((m) => (m as { type: string }).type === 'error') as Array<{ payload: { message: string } }>;
    expect(errors.length).toBeGreaterThanOrEqual(2);
    for (const e of errors) expect(e.payload.message).toContain('not available yet');
    expect(errors.some((e) => e.payload.message.includes(DBML_DIAGRAM_EDITING_NOT_AVAILABLE))).toBe(true);
    expect(_appliedEdits).toHaveLength(0);
    expect(fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8')).toBe(before);
  });

  it('every handler reads a DBML diagram as a plain v5 object (D8): detectSubjectAreaFormat says v5', () => {
    const provider = buildProvider(root) as any;
    const doc = openDoc('gold/sales.dbml');
    const parsed = provider.parseSubjectAreaDocument(doc);
    expect(parsed.schemaVersion).toBe(5);
    expect(detectSubjectAreaFormat(parsed)).toBe('v5');
    expect(provider.isSubjectAreaV5(parsed)).toBe(true);
    expect(parsed.logical.models).toEqual(['fct_order', 'dim_customer', 'dim_date', 'dim_region', 'customer_profile', 'bridge_empty']);
    expect(parsed.logical.relationships).toEqual([]);
    expect(provider.parseSubjectAreaFile(doc)).toMatchObject({ storage: 'dbml', dbmlSchemaVersion: 7, writable: true });
    // The layout the edit pipeline will write through is beside the real file, never the shown relative path.
    expect(provider.parseSubjectAreaFile(doc).layoutPath).toBe(at('gold/sales.dbdiagram'));
  });

  it('the relationship survey reads a DBML diagram as v5 through the codec: the library is surveyed, nothing JSON.parsed or failed', () => {
    const provider = buildProvider(root) as any;
    const doc = openDoc('gold/sales.dbml');
    const parse = vi.spyOn(JSON, 'parse');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const survey = vi.spyOn(telemetry, 'relationshipState');
    const listTables = vi.spyOn(provider.tableLibraryService, 'listTables');
    provider.recordRelationshipState(doc);
    expect(error).not.toHaveBeenCalled();
    expect(listTables).toHaveBeenCalledTimes(1);
    expect(survey).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls.some(([text]) => text === doc.getText())).toBe(false);
  });

  it('records the canvas open as v5 plus the dbmlProject feature, and never JSON.parses the document', async () => {
    const provider = buildProvider(root) as any;
    const doc = openDoc('gold/sales.dbml');
    const parse = vi.spyOn(JSON, 'parse');
    const opened = vi.spyOn(telemetry, 'canvasOpened');
    const feature = vi.spyOn(telemetry, 'featureOnce');
    provider.recordCanvasOpen(doc, 'logical', 6, false);
    expect(opened).toHaveBeenCalledWith('logical', 'v5', 6);
    expect(feature).toHaveBeenCalledWith('dbmlProject');
    expect(parse.mock.calls.some(([text]) => text === doc.getText())).toBe(false);
  });

  it('a table change refreshes every open DBML canvas that uses the table, and only those', async () => {
    const provider = buildProvider(root);
    const sales = await resolve(provider, openDoc('gold/sales.dbml'));
    const staging = await resolve(provider, openDoc('silver/staging.dbml'));
    sales._postedMessages.length = 0;
    staging._postedMessages.length = 0;
    await provider.refreshSubjectAreasReferencingTable('dim_customer');
    expect(sales._postedMessages.map((m) => (m as { type: string }).type)).toContain('domainLoaded');
    expect(staging._postedMessages).toHaveLength(0);
    await provider.refreshSubjectAreasReferencingTable('FCT_ORDER');
    expect(staging._postedMessages.map((m) => (m as { type: string }).type)).toContain('domainLoaded');
  });
});

describe('removing a DBML table from a JSON diagram (D16 until S5)', () => {
  it('never offers or performs a bare delete of the .dbml file; a YAML table beside it is still offered', async () => {
    fs.writeFileSync(at('tables/gold/dim_yaml.yml'), 'name: dim_yaml\ncolumns:\n  - name: id\n    dataType: INT\n');
    fs.writeFileSync(at('gold/mixed.json'), `${JSON.stringify({
      schemaVersion: 5, domain: 'mixed', layer: 'gold',
      logical: { models: ['dim_customer', 'dim_yaml'], relationships: [] }, viewConfig: {},
    }, null, 2)}\n`);
    const provider = buildProvider(root);
    const panel = await resolve(provider, openDoc('gold/mixed.json'));
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (m: string, ...items: string[]) =>
      (String(m).includes('Delete the table file') ? items[0] : undefined)) as never);

    await panel._simulateMessage({ type: 'removeModels', payload: { modelNames: ['dim_customer'] } });
    expect(info.mock.calls.some((c) => String(c[0]).includes('Delete the table file'))).toBe(false);
    expect(fs.existsSync(at('tables/gold/dim_customer.dbml'))).toBe(true);

    await panel._simulateMessage({ type: 'removeModels', payload: { modelNames: ['dim_yaml'] } });
    await vi.waitFor(() => expect(fs.existsSync(at('tables/gold/dim_yaml.yml'))).toBe(false));
    expect(info.mock.calls.filter((c) => String(c[0]).includes('Delete the table file'))).toEqual([
      ['Table "dim_yaml" removed from this subject area. Delete the table file entirely?', 'Delete Table File', 'Keep File'],
    ]);
    expect(fs.existsSync(at('tables/gold/dim_customer.dbml'))).toBe(true);
  });
});

describe('the custom-editor reroute (§5.9)', () => {
  it.each(['tables/gold/fct_order.dbml', 'tables/gold/_relationships.dbml', 'tables/dim_date.dbml'])(
    'a file: %s is reopened in the text editor', async (rel) => {
      const provider = buildProvider(root);
      const execute = vi.spyOn(vscode.commands, 'executeCommand');
      const doc = openDoc(rel);
      const panel = await resolve(provider, doc);
      expect(panel._disposed).toBe(true);
      expect(execute).toHaveBeenCalledWith('vscode.openWith', doc.uri, 'default', expect.objectContaining({ preview: false }));
      expect(panel._postedMessages).toEqual([]);
    },
  );

  it('a git: table or relationships file is never rerouted: it gets the not-a-diagram page with Open as Text', async () => {
    const provider = buildProvider(root);
    const execute = vi.spyOn(vscode.commands, 'executeCommand');
    const doc = openDoc('tables/gold/_relationships.dbml');
    (doc as { uri: unknown }).uri = { ...doc.uri, scheme: 'git', toString: () => `git:${doc.uri.fsPath}` };
    const panel = await resolve(provider, doc);
    expect(panel._disposed).toBe(false);
    expect(execute).not.toHaveBeenCalledWith('vscode.openWith', expect.anything(), 'default', expect.anything());
    await panel._simulateMessage({ type: 'ready' });
    expect(panel._postedMessages).toContainEqual({
      type: 'error',
      payload: expect.objectContaining({ kind: 'not-a-domain', message: expect.stringContaining('is a DBML table or relationships file, not a diagram') }),
    });
  });

  it('a diagram is not rerouted', async () => {
    const provider = buildProvider(root);
    const panel = await resolve(provider, openDoc('gold/sales.dbml'));
    expect(panel._disposed).toBe(false);
  });
});

describe('a single-file DBML in a layer folder (§2.5)', () => {
  beforeEach(() => {
    fs.writeFileSync(at('gold/dropped.dbml'), [
      'Table orders {',
      '  id INT [pk]',
      '  customer_id INT [ref: > customers.id]',
      '}',
      '',
      'Table customers {',
      '  id INT [pk]',
      '}',
      '',
    ].join('\n'));
  });

  it('posts dbmlEmbeddedTables after the load, and importEmbeddedTables runs Import DBML on the file', async () => {
    const provider = buildProvider(root);
    const doc = openDoc('gold/dropped.dbml');
    const panel = await resolve(provider, doc);
    await panel._simulateMessage({ type: 'ready' });
    const types = panel._postedMessages.map((m) => (m as { type: string }).type);
    expect(types).toContain('domainLoaded');
    expect(types.indexOf('dbmlEmbeddedTables')).toBeGreaterThan(types.indexOf('domainLoaded'));

    const execute = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    await panel._simulateMessage({ type: 'importEmbeddedTables' });
    expect(execute).toHaveBeenCalledWith(IMPORT_DBML_COMMAND, doc.uri);

    execute.mockClear();
    await panel._simulateMessage({ type: 'importEmbeddedTables', payload: { file: '/etc/passwd' } });
    expect(execute).not.toHaveBeenCalledWith(IMPORT_DBML_COMMAND, expect.anything());
  });
});

describe('a broken DBML diagram', () => {
  it('shows the syntax screen with its file type', async () => {
    fs.writeFileSync(at('gold/sales.dbml'), "Project sales {\n  erd_schema_version: '7'\n\nuse { table fct_order } from '../tables/gold/fct_order.dbml'\n");
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = buildProvider(root) as any;
    const panel = createMockWebviewPanel();
    const doc = openDoc('gold/sales.dbml');
    vi.useFakeTimers();
    const sending = provider.sendSubjectAreaData(doc, panel.webview);
    await vi.runAllTimersAsync();
    await sending;
    vi.useRealTimers();
    const error = panel._postedMessages.find((m) => (m as { type: string }).type === 'error') as { payload: Record<string, unknown> };
    expect(error.payload).toMatchObject({ kind: 'domain-file', fileProblem: 'syntax', fileType: 'DBML' });
    expect(String(error.payload.message)).toMatch(/^\.erd-studio\/gold\/sales\.dbml has a mistake at line \d+, column \d+: /);
  });
});
