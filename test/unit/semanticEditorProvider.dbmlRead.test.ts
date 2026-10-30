/**
 * The canvas reading native DBML storage in the layer-first tree: a
 * `<layer>/diagrams/*.dbml` diagram renders; any other `.dbml` the editor is
 * asked to open (a table or relationships file, a 1.9 pre-release file,
 * anything else) gets the not-a-diagram page (§1.8) and is never rerouted;
 * a DBML document is never `JSON.parse`d, every handler sees a v5 object, a
 * single-file DBML saved as a diagram offers Import DBML, and an edit is
 * written.
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
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';
import { detectSubjectAreaFormat } from '../../src/types/semantic';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');
const OLD = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-1.9-tree');
const REOPEN = 'To edit it as text, right-click the tab and choose Reopen Editor With… > Text Editor.';

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
    const panel = await resolve(provider, openDoc('gold/diagrams/sales.dbml'));
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
    // A fully laid out diagram: the ready load writes nothing.
    expect(_appliedEdits).toHaveLength(0);
    expect(panel._postedMessages.some((m) => (m as { type: string }).type === 'dbmlEmbeddedTables')).toBe(false);
  });

  it('places a diagram with no erd_layout without writing one, and asks the canvas for an ELK layout (S5)', async () => {
    const provider = buildProvider(root);
    const panel = await resolve(provider, openDoc('silver/diagrams/staging.dbml'));
    await panel._simulateMessage({ type: 'ready' });
    const loaded = panel._postedMessages.find((m) => (m as { type: string }).type === 'domainLoaded') as { payload: Record<string, any> };
    expect(Object.keys(loaded.payload.viewConfig.positions).sort()).toEqual(['dim_date', 'fct_order']);
    expect(fs.readFileSync(at('silver/diagrams/staging.dbml'), 'utf-8')).not.toContain('erd_layout');
    expect(_appliedEdits).toHaveLength(0);
    // A fresh layout: the webview's ELK pass persists through updatePositions, which writes erd_layout.
    expect((loaded as { autoLayout?: boolean }).autoLayout).toBe(true);
    expect(panel._postedMessages.some((m) => (m as { type: string }).type === 'error')).toBe(false);
  });

  it('an edit is written (S5): a drag rewrites the moved table\'s erd_layout line, every other byte stays', async () => {
    const provider = buildProvider(root);
    const doc = openDoc('gold/diagrams/sales.dbml');
    const panel = await resolve(provider, doc);
    const diagram = fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8');
    await panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_order: { x: 10, y: 20 } } } });
    const errors = panel._postedMessages.filter((m) => (m as { type: string }).type === 'error');
    expect(errors).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(doc.getText()).toBe(diagram.replace('    fct_order 400 200\n', '    fct_order 10 20\n'));
  });

  it('a taken name suggests `<layer>_<name>` from the diagram\'s layer, never `diagrams_<name>`', async () => {
    const provider = buildProvider(root);
    const panel = await resolve(provider, openDoc('silver/diagrams/staging.dbml'));
    await panel._simulateMessage({
      type: 'addModel',
      payload: { name: 'dim_customer', columns: [{ name: 'customer_key', dataType: 'int', description: '' }] },
    });
    const errors = () => panel._postedMessages
      .filter((m) => (m as { type: string }).type === 'error')
      .map((m) => (m as { payload: { message: string } }).payload.message);
    await vi.waitFor(() => expect(errors()).toHaveLength(1));
    const [message] = errors();
    expect(message).toContain('already exists in the Table Library');
    expect(message).toContain('name it silver_dim_customer');
    expect(message).not.toContain('diagrams_');
    expect(_appliedEdits).toHaveLength(0);
  });

  it('a DBML table that a YAML file also has (part-way through Convert) is reported as in both folders, with no Fix…', async () => {
    fs.mkdirSync(at('logical-models'), { recursive: true });
    fs.writeFileSync(at('logical-models/dim_customer.yml'), 'name: dim_customer\ncolumns:\n  - name: customer_key\n    dataType: INT\n');
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    const provider = buildProvider(root);
    const panel = await resolve(provider, openDoc('gold/diagrams/sales.dbml'));
    await panel._simulateMessage({ type: 'ready' });
    const call = warn.mock.calls.find(([m]) => String(m).startsWith('"dim_customer"'));
    expect(call?.[0]).toBe('"dim_customer" has a file in both the old and the new table folder. gold/sales uses '
      + 'logical-models/dim_customer.yml; gold/tables/gold/dim_customer.dbml is ignored. Delete the copy you don\'t want.');
    expect(call).not.toContain('Fix…');
  });

  it('every handler reads a DBML diagram as a plain v5 object (D8): detectSubjectAreaFormat says v5', () => {
    const provider = buildProvider(root) as any;
    const doc = openDoc('gold/diagrams/sales.dbml');
    const parsed = provider.parseSubjectAreaDocument(doc);
    expect(parsed.schemaVersion).toBe(5);
    expect(detectSubjectAreaFormat(parsed)).toBe('v5');
    expect(provider.isSubjectAreaV5(parsed)).toBe(true);
    expect(parsed.logical.models).toEqual(['fct_order', 'dim_customer', 'dim_date', 'dim_region', 'customer_profile', 'bridge_empty']);
    expect(parsed.logical.relationships).toEqual([]);
    expect(provider.parseSubjectAreaFile(doc)).toMatchObject({ storage: 'dbml', dbmlSchemaVersion: 7, writable: true });
    // Positions are the diagram's own (erd_layout): there is no file beside it.
    expect(provider.parseSubjectAreaFile(doc).parsed.viewConfig.positions.fct_order).toEqual({ x: 400, y: 200 });
  });

  it('the relationship survey reads a DBML diagram as v5 through the codec: the library is surveyed, nothing JSON.parsed or failed', () => {
    const provider = buildProvider(root) as any;
    const doc = openDoc('gold/diagrams/sales.dbml');
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
    const doc = openDoc('gold/diagrams/sales.dbml');
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
    const sales = await resolve(provider, openDoc('gold/diagrams/sales.dbml'));
    const staging = await resolve(provider, openDoc('silver/diagrams/staging.dbml'));
    sales._postedMessages.length = 0;
    staging._postedMessages.length = 0;
    await provider.refreshSubjectAreasReferencingTable('dim_customer');
    expect(sales._postedMessages.map((m) => (m as { type: string }).type)).toContain('domainLoaded');
    expect(staging._postedMessages).toHaveLength(0);
    await provider.refreshSubjectAreasReferencingTable('FCT_ORDER');
    expect(staging._postedMessages.map((m) => (m as { type: string }).type)).toContain('domainLoaded');
  });
});

describe('removing a DBML table from a JSON diagram (D16)', () => {
  it('offers the delete with its cascade, and runs it as one edit; a YAML table beside it keeps the plain prompt', async () => {
    fs.mkdirSync(at('logical-models'), { recursive: true });
    fs.writeFileSync(at('logical-models/dim_yaml.yml'), 'name: dim_yaml\ncolumns:\n  - name: id\n    dataType: INT\n');
    fs.writeFileSync(at('gold/mixed.json'), `${JSON.stringify({
      schemaVersion: 5, domain: 'mixed', layer: 'gold',
      logical: { models: ['dim_customer', 'dim_yaml'], relationships: [] }, viewConfig: {},
    }, null, 2)}\n`);
    const provider = buildProvider(root);
    const panel = await resolve(provider, openDoc('gold/mixed.json'));
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (m: string, ...items: string[]) =>
      (String(m).includes('Delete the table file') ? items[0] : undefined)) as never);

    await panel._simulateMessage({ type: 'removeModels', payload: { modelNames: ['dim_customer'] } });
    await vi.waitFor(() => expect(fs.existsSync(at('gold/tables/gold/dim_customer.dbml'))).toBe(false));
    // The replaced files are saved after the edit lands.
    await vi.waitFor(() => expect(fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8')).not.toMatch(/dim_customer/));
    const prompt = info.mock.calls.find((c) => String(c[0]).includes('Delete the table file'));
    expect(String(prompt?.[0])).toContain("This removes the table's file, its 3 relationships and its place in 1 other diagram.");
    // Its Refs and every use line naming it are gone; the diagram that used it no longer does.
    for (const file of ['gold/relationships/gold.dbml', 'gold/relationships/customers.dbml']) {
      expect(fs.readFileSync(at(file), 'utf-8')).not.toMatch(/dim_customer/);
    }

    await panel._simulateMessage({ type: 'removeModels', payload: { modelNames: ['dim_yaml'] } });
    await vi.waitFor(() => expect(fs.existsSync(at('logical-models/dim_yaml.yml'))).toBe(false));
    expect(info.mock.calls.filter((c) => String(c[0]).includes('Delete the table file') && String(c[0]).includes('dim_yaml'))).toEqual([
      ['Table "dim_yaml" removed from this subject area. Delete the table file entirely?', 'Delete Table File', 'Keep File'],
    ]);
  });
});

describe('the not-a-diagram page (§1.8): no reroute, ever', () => {
  async function pageFor(doc: ReturnType<typeof createMockTextDocument>, projectRoot = root): Promise<{ message: string; disposed: boolean; rerouted: boolean }> {
    const provider = buildProvider(projectRoot);
    const execute = vi.spyOn(vscode.commands, 'executeCommand');
    const panel = await resolve(provider, doc);
    await panel._simulateMessage({ type: 'ready' });
    const error = panel._postedMessages.find((m) => (m as { type: string }).type === 'error') as { payload: { kind: string; message: string } } | undefined;
    expect(error?.payload.kind).toBe('not-a-domain');
    expect(panel._postedMessages.some((m) => (m as { type: string }).type === 'domainLoaded')).toBe(false);
    return {
      message: error?.payload.message ?? '',
      disposed: panel._disposed,
      rerouted: execute.mock.calls.some((c) => c[0] === 'vscode.openWith'),
    };
  }

  it.each(['gold/tables/gold/fct_order.dbml', 'gold/relationships/gold.dbml', 'silver/tables/calendar/dim_date.dbml'])(
    'a file: %s keeps its tab and gets the table-or-relationships page, ending with how to reopen it as text', async (rel) => {
      const page = await pageFor(openDoc(rel));
      expect(page.disposed).toBe(false);
      expect(page.rerouted).toBe(false);
      const layer = rel.split('/')[0];
      expect(page.message).toBe(`${at(rel)} is a DBML table or relationships file, not a diagram. Open a diagram in ${layer}/diagrams/. ${REOPEN}`);
      // The substring `cli/diff.ts` matches.
      expect(page.message).toContain('is a DBML table or relationships file, not a diagram');
    },
  );

  it('a git: table or relationships file gets the same page', async () => {
    const doc = openDoc('gold/relationships/customers.dbml');
    (doc as { uri: unknown }).uri = { ...doc.uri, scheme: 'git', toString: () => `git:${doc.uri.fsPath}` };
    const page = await pageFor(doc);
    expect(page.disposed).toBe(false);
    expect(page.rerouted).toBe(false);
    expect(page.message).toContain('is a DBML table or relationships file, not a diagram');
  });

  it.each(['gold/sales.dbml', 'tables/gold/_relationships.dbml', 'tables/dim_date.dbml', 'gold/sales.dbdiagram'])(
    'a 1.9 pre-release file (a restored tab) %s gets the 1.9 page, naming it relative to the semantic dir', async (rel) => {
      const old = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-1.9-'));
      try {
        fs.cpSync(OLD, old, { recursive: true });
        const file = path.join(old, '.erd-studio', rel);
        const page = await pageFor(createMockTextDocument(file.endsWith('.dbdiagram') ? file.replace(/\.dbdiagram$/, '.dbml') : file, fs.readFileSync(file, 'utf-8')), old);
        const named = rel.endsWith('.dbdiagram') ? rel.replace(/\.dbdiagram$/, '.dbml') : rel;
        expect(page.rerouted).toBe(false);
        expect(page.message).toBe(`${named} was written by an ERD Studio 1.9 pre-release, whose folder layout 2.0 does not read. `
          + `Run erd-studio doctor in the project for the steps to convert it again. ${REOPEN}`);
      } finally {
        fs.rmSync(old, { recursive: true, force: true });
      }
    },
  );

  it('any other .dbml gets where diagrams live', async () => {
    fs.mkdirSync(at('gold/notes'), { recursive: true });
    fs.writeFileSync(at('gold/notes/x.dbml'), "Project x {\n  erd_schema_version: '7'\n}\n");
    const page = await pageFor(openDoc('gold/notes/x.dbml'));
    expect(page.message).toBe(`${at('gold/notes/x.dbml')} is not a DBML diagram. ERD Studio diagrams live in <layer>/diagrams/<name>.dbml (the folder names are lower-case). ${REOPEN}`);
  });

  it('a diagram renders', async () => {
    const provider = buildProvider(root);
    const panel = await resolve(provider, openDoc('gold/diagrams/sales.dbml'));
    expect(panel._disposed).toBe(false);
    await panel._simulateMessage({ type: 'ready' });
    expect(panel._postedMessages.some((m) => (m as { type: string }).type === 'domainLoaded')).toBe(true);
  });

  it('a JSON file that is not a subject area names both shapes', async () => {
    fs.mkdirSync(at('templates'), { recursive: true });
    fs.writeFileSync(at('templates/fact.json'), '{}');
    const page = await pageFor(openDoc('templates/fact.json'));
    expect(page.message).toBe('fact.json is not an ERD Studio subject area file — subject areas live in .erd-studio/{layer}/{domain}.json '
      + 'or .erd-studio/{layer}/diagrams/{domain}.dbml. Open it as text to edit it.');
  });
});

describe('a single-file DBML saved as a diagram (§2.5)', () => {
  beforeEach(() => {
    fs.writeFileSync(at('gold/diagrams/dropped.dbml'), [
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
    const doc = openDoc('gold/diagrams/dropped.dbml');
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
    fs.writeFileSync(at('gold/diagrams/sales.dbml'), "Project sales {\n  erd_schema_version: '7'\n\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n");
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = buildProvider(root) as any;
    const panel = createMockWebviewPanel();
    const doc = openDoc('gold/diagrams/sales.dbml');
    vi.useFakeTimers();
    const sending = provider.sendSubjectAreaData(doc, panel.webview);
    await vi.runAllTimersAsync();
    await sending;
    vi.useRealTimers();
    const error = panel._postedMessages.find((m) => (m as { type: string }).type === 'error') as { payload: Record<string, unknown> };
    expect(error.payload).toMatchObject({ kind: 'domain-file', fileProblem: 'syntax', fileType: 'DBML' });
    expect(String(error.payload.message)).toMatch(/^\.erd-studio\/gold\/diagrams\/sales\.dbml has a mistake at line \d+, column \d+: /);
  });
});
