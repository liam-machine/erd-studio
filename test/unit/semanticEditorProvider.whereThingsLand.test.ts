/**
 * Where the canvas's new things land, on a copy of the `dbml-native`
 * fixture through the real SemanticEditorProvider:
 *
 * - the payload tells New Table the layer's schema folders and its default
 *   (`newTableSchemas`), and `requestNewRelationshipFiles` answers with the
 *   file a new relationship of each table goes to; a YAML project gets
 *   neither;
 * - `addModel` with a `schemaFolder` writes `<layer>/tables/<schema>/`, spelled
 *   as an existing folder; without one, where it always did; a bad one is refused;
 * - after `addRelationship`, the status bar says which file and line hold it.
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
import { SemanticEditorProvider, relationshipSavedMessage } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';
import { SCHEMA_FOLDER_RULE } from '../../src/types/schemaFolder';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');

let root: string;
const at = (rel: string): string => path.join(root, '.erd-studio', rel);

function buildProvider(): SemanticEditorProvider {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tables = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tables);
  const context = {
    extensionUri: vscode.Uri.file(path.join(root, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  const selectors = new SelectorsService(subjectAreaService, root, '.erd-studio');
  vi.spyOn(selectors, 'scheduleRegenerate').mockImplementation(() => undefined);
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty, getRelationshipTests: () => [] } as unknown as ManifestService,
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    root,
    selectors,
    tables,
    new OwnWriteTracker(),
  );
}

type Posted = { type: string; payload?: Record<string, any> };

/** Open `diagram` on the canvas and send `ready`. */
async function open(diagram = 'gold/diagrams/sales.dbml') {
  const provider = buildProvider();
  const document = createMockTextDocument(at(diagram), fs.readFileSync(at(diagram), 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    document as unknown as vscode.TextDocument,
    panel as unknown as vscode.WebviewPanel,
    {} as vscode.CancellationToken,
  );
  await panel._simulateMessage({ type: 'ready' });
  const posted = panel._postedMessages as Posted[];
  const loaded = (): Posted | undefined => [...posted].reverse().find((m) => m.type === 'domainLoaded');
  const errors = (): string[] => posted.filter((m) => m.type === 'error').map((m) => String(m.payload?.message));
  const last = (type: string): Posted | undefined => [...posted].reverse().find((m) => m.type === type);
  const send = async (message: unknown): Promise<void> => {
    _appliedEdits.length = 0;
    posted.length = 0;
    await panel._simulateMessage(message);
  };
  return { loaded, errors, send, last };
}

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-where-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the payload says where new things go', () => {
  it('a DBML diagram: the layer\'s schema folders and the default', async () => {
    const canvas = await open();
    const payload = canvas.loaded()!.payload!;
    expect(payload.newTableSchemas).toEqual({ dir: '.erd-studio', layer: 'gold', schemas: ['gold'], defaultSchema: 'gold' });
    expect(payload.newRefFiles).toBeUndefined();
  });

  it('requestNewRelationshipFiles: each table\'s new-relationship file (placeNewRef), project-relative', async () => {
    const canvas = await open();
    await canvas.send({ type: 'requestNewRelationshipFiles' });
    expect(canvas.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(0);
    const files = canvas.last('newRelationshipFiles')!.payload!.files as Record<string, string>;
    expect(files.customer_profile).toBe('.erd-studio/gold/relationships/customers.dbml');
    expect(files.fct_order).toBe('.erd-studio/gold/relationships/gold.dbml');
    expect(Object.keys(files).every((k) => k === k.toLowerCase())).toBe(true);
    expect(Object.values(files).every((f) => f.startsWith('.erd-studio/') && f.endsWith('.dbml'))).toBe(true);
  });

  it('requestNewRelationshipFiles reads the diagram\'s members from its text, resolving no table', async () => {
    const canvas = await open();
    const getSubjectArea = vi.spyOn(SubjectAreaService.prototype, 'getSubjectArea');
    const getTable = vi.spyOn(TableLibraryService.prototype, 'getTable');
    await canvas.send({ type: 'requestNewRelationshipFiles' });
    expect(getSubjectArea).not.toHaveBeenCalled();
    expect(getTable).not.toHaveBeenCalled();
    expect((canvas.last('newRelationshipFiles')!.payload!.files as Record<string, string>).fct_order).toBe('.erd-studio/gold/relationships/gold.dbml');
  });

  it('requestNewRelationshipFiles answers a YAML project empty without reading the diagram', async () => {
    const canvas = await open();
    vi.spyOn(TableLibraryService.prototype, 'writesDbml').mockReturnValue(false);
    const place = vi.spyOn(TableLibraryService.prototype, 'relationshipsFilesForNewRefs');
    await canvas.send({ type: 'requestNewRelationshipFiles' });
    expect(canvas.last('newRelationshipFiles')!.payload).toEqual({ files: {} });
    expect([...place.mock.calls[0][0]]).toEqual([]);
  });

  it('requestNewRelationshipFiles with a payload is refused', async () => {
    const canvas = await open();
    await canvas.send({ type: 'requestNewRelationshipFiles', payload: { table: 'x' } });
    expect(canvas.errors()).toEqual(['Asking where new relationships go takes no payload.']);
    expect(canvas.last('newRelationshipFiles')).toBeUndefined();
  });

  it('defaults to the schema most of the diagram\'s tables in the layer use', async () => {
    // Move three of the diagram's five gold tables to a `sales` schema folder (qualifier, use lines and Refs follow).
    const move = (name: string): void => {
      const from = at(`gold/tables/gold/${name}.dbml`);
      const to = at(`gold/tables/sales/${name}.dbml`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, fs.readFileSync(from, 'utf-8').replace(`Table gold.${name}`, `Table sales.${name}`));
      fs.rmSync(from);
      for (const rel of ['gold/diagrams/sales.dbml', 'gold/relationships/gold.dbml', 'gold/relationships/customers.dbml', 'silver/relationships/calendar.dbml', 'silver/diagrams/staging.dbml']) {
        const file = at(rel);
        if (!fs.existsSync(file)) continue;
        fs.writeFileSync(file, fs.readFileSync(file, 'utf-8')
          .split(`gold.${name}`).join(`sales.${name}`)
          .split(`tables/gold/${name}.dbml`).join(`tables/sales/${name}.dbml`));
      }
    };
    move('fct_order');
    move('dim_region');
    move('bridge_empty');
    const canvas = await open();
    expect(canvas.loaded()!.payload!.newTableSchemas).toMatchObject({ schemas: ['gold', 'sales'], defaultSchema: 'sales' });
  });

  it('a YAML project: neither (New Table asks for no schema)', async () => {
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
      fs.writeFileSync(at(rel), text);
    };
    write('logical-models/dim_a.yml', 'name: dim_a\ncolumns:\n  - name: a_key\n    dataType: INT\n    isPrimaryKey: true\n');
    write('gold/s.json', `${JSON.stringify({
      schemaVersion: 5, domain: 's', layer: 'gold', description: 's',
      logical: { models: ['dim_a'], relationships: [] },
      viewConfig: { positions: { dim_a: { x: 0, y: 0 } } },
    }, null, 2)}\n`);
    const canvas = await open('gold/s.json');
    const payload = canvas.loaded()!.payload!;
    expect(payload.models.map((m: { name: string }) => m.name)).toEqual(['dim_a']);
    expect(payload.newTableSchemas).toBeUndefined();
    await canvas.send({ type: 'requestNewRelationshipFiles' });
    expect(canvas.last('newRelationshipFiles')!.payload).toEqual({ files: {} });
  });
});

describe('addModel with a schema folder', () => {
  const dimStore = { name: 'dim_store', description: '', columns: [{ name: 'store_key', dataType: 'INT', description: '', isPrimaryKey: true }] };

  it('writes the table in the named schema folder, qualified by it', async () => {
    const canvas = await open();
    await canvas.send({ type: 'addModel', payload: { ...dimStore, schemaFolder: 'sales' } });
    expect(canvas.errors()).toEqual([]);
    expect(fs.readFileSync(at('gold/tables/sales/dim_store.dbml'), 'utf-8')).toMatch(/^Table sales\.dim_store /m);
    expect(fs.existsSync(at('gold/tables/gold/dim_store.dbml'))).toBe(false);
    expect(fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8')).toMatch(/^use \{ table sales\.dim_store \} +from '\.\.\/tables\/sales\/dim_store\.dbml'$/m);
    // The new folder is now one the dialog offers.
    expect(canvas.loaded()!.payload!.newTableSchemas.schemas).toEqual(['gold', 'sales']);
  });

  it('spells the schema as an existing folder that matches it without case', async () => {
    const canvas = await open();
    await canvas.send({ type: 'addModel', payload: { ...dimStore, schemaFolder: 'GOLD' } });
    expect(canvas.errors()).toEqual([]);
    expect(fs.readFileSync(at('gold/tables/gold/dim_store.dbml'), 'utf-8')).toMatch(/^Table gold\.dim_store /m);
  });

  it('without one: the layer id, as before', async () => {
    const canvas = await open();
    await canvas.send({ type: 'addModel', payload: dimStore });
    expect(canvas.errors()).toEqual([]);
    expect(fs.existsSync(at('gold/tables/gold/dim_store.dbml'))).toBe(true);
  });

  it('refuses a schema that cannot be a folder, and writes nothing', async () => {
    const canvas = await open();
    await canvas.send({ type: 'addModel', payload: { ...dimStore, schemaFolder: 'a/b' } });
    expect(canvas.errors()).toEqual([`Failed to add table: "a/b" cannot be a schema folder. ${SCHEMA_FOLDER_RULE}`]);
    expect(_appliedEdits).toHaveLength(0);
    expect(fs.existsSync(at('gold/tables/gold/dim_store.dbml'))).toBe(false);
  });
});

describe('after a relationship is added', () => {
  it('the status bar says which relationships file and line hold it', async () => {
    const status = vi.spyOn(vscode.window, 'setStatusBarMessage');
    const canvas = await open();
    await canvas.send({ type: 'addRelationship', payload: { fromModel: 'customer_profile', fromColumn: 'loyalty_tier', toModel: 'dim_region', toColumn: 'region_name', cardinality: 'many-to-one' } });
    expect(canvas.errors()).toEqual([]);
    const lines = fs.readFileSync(at('gold/relationships/customers.dbml'), 'utf-8').split(/\r?\n/);
    const line = lines.findIndex((l) => l.startsWith('Ref: gold.customer_profile.loyalty_tier')) + 1;
    expect(line).toBeGreaterThan(0);
    expect(status).toHaveBeenCalledWith(relationshipSavedMessage('.erd-studio/gold/relationships/customers.dbml', line), expect.any(Number));
    expect(relationshipSavedMessage('.erd-studio/gold/relationships/finance.dbml', 7))
      .toBe('ERD Studio: Relationship saved in .erd-studio/gold/relationships/finance.dbml (line 7)');
  });

  it('a refused relationship says nothing in the status bar', async () => {
    const status = vi.spyOn(vscode.window, 'setStatusBarMessage');
    const canvas = await open();
    await canvas.send({ type: 'addRelationship', payload: { fromModel: 'customer_profile', fromColumn: 'loyalty_tier', toModel: 'no_such_table', toColumn: 'id', cardinality: 'many-to-one' } });
    expect(canvas.errors().length).toBeGreaterThan(0);
    expect(status.mock.calls.filter(([m]) => String(m).includes('Relationship saved'))).toEqual([]);
  });
});
