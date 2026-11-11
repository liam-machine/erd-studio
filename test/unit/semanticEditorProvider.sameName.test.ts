/**
 * The editor on two tables of one name in different schema folders
 * (packages/core/test/fixtures/dbml/same-name-two-schemas: bqs and ccc, each
 * with addresse and kunde), with the library telling tables apart by
 * identity (`schemaScopedNames`, off by default until the rule flips): every
 * canvas message names a table as the diagram does (its name, or
 * `<schema>.<name>` where two members share it), and each handler acts on
 * the table file that member's own `use` line reads (the diagram boundary,
 * `DiagramMemberTable`), never the library's first file of its name.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';

import { _appliedEdits, _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';

const TWINS = path.resolve(__dirname, '../../packages/core/test/fixtures/dbml/same-name-two-schemas');

let root: string;
const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const read = (rel: string): string => fs.readFileSync(at(rel), 'utf-8');

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

/** dbt's yml, when a test gives the project one: its models (by name) and relationship tests. */
let ymlModels: Array<{ name: string; configSchema?: string; columns?: string[] }> = [];
let ymlTests: Array<{ fromModel: string; fromColumn: string; toModel: string; toColumn: string }> = [];

function ymlData(): Record<string, unknown> {
  return {
    models: new Map(ymlModels.map((m) => [m.name, {
      name: m.name,
      description: '',
      columns: (m.columns ?? []).map((c) => ({ name: c, description: '' })),
      filePath: path.join(root, 'models', 'schema.yml'),
      tags: [],
      ...(m.configSchema ? { configSchema: m.configSchema } : {}),
    }])),
    relationshipTests: ymlTests,
    uniqueColumns: new Map(),
    compositeUniqueGroups: new Map(),
  };
}

function buildProvider(): { provider: SemanticEditorProvider; tables: TableLibraryService } {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tables = new TableLibraryService(root, '.erd-studio', new OwnWriteTracker(), { schemaScopedNames: true });
  subjectAreaService.setTableLibraryService(tables);
  const context = {
    extensionUri: vscode.Uri.file(path.join(root, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  const selectors = new SelectorsService(subjectAreaService, root, '.erd-studio');
  vi.spyOn(selectors, 'scheduleRegenerate').mockImplementation(() => undefined);
  const provider = new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty, getRelationshipTests: () => [] } as unknown as ManifestService,
    { loadYmlData: async () => ymlData() } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    root,
    selectors,
    tables,
    new OwnWriteTracker(),
  );
  provider.setLogicalOnly(true);
  return { provider, tables };
}

/** Every file under the semantic dir, relative path → text. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[path.relative(path.join(root, '.erd-studio'), abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf-8');
    }
  };
  walk(path.join(root, '.erd-studio'));
  return out;
}

/** The files whose text differs between two snapshots, sorted. */
function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]).sort();
}

interface Canvas {
  provider: SemanticEditorProvider;
  document: ReturnType<typeof createMockTextDocument>;
  panel: ReturnType<typeof createMockWebviewPanel>;
  send(message: unknown): Promise<{ errors: string[]; changed: string[] }>;
  /** The last diagram posted to the canvas. */
  posted(): { models: Array<{ name: string; tableName?: string; columns: Array<{ name: string }> }>; relationships: Array<{ fromModel: string; toModel: string }>; viewConfig: { positions: Record<string, unknown> } };
}

/** Open `diagram` on the canvas (its ready load done). */
async function open(diagram: string): Promise<Canvas> {
  const { provider } = buildProvider();
  const document = createMockTextDocument(at(diagram), read(diagram), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
  await panel._simulateMessage({ type: 'ready' });
  return {
    provider,
    document,
    panel,
    send: async (message) => {
      _appliedEdits.length = 0;
      panel._postedMessages.length = 0;
      const before = snapshot();
      await panel._simulateMessage(message);
      const errors = panel._postedMessages
        .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
        .map((m) => m.payload.message);
      return { errors, changed: changed(before, snapshot()) };
    },
    posted: () => {
      const loaded = panel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded') as Array<{ payload: ReturnType<Canvas['posted']> }>;
      return loaded[loaded.length - 1].payload;
    },
  };
}

beforeEach(() => {
  _resetMockWorkspace();
  ymlModels = [];
  ymlTests = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-same-name-editor-'));
  fs.cpSync(TWINS, root, { recursive: true });
  fs.writeFileSync(at('bronze/diagrams/bqs.dbml'), BQS_DIAGRAM);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async () => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('an edit goes to the file the member was read from', () => {
  it('on a diagram showing only ccc\'s tables, a description edit of addresse rewrites ccc/addresse.dbml only', async () => {
    const canvas = await open('bronze/diagrams/ccc.dbml');
    const r = await canvas.send({ type: 'updateModelDescription', payload: { modelName: 'addresse', description: 'CCC addresses, cleaned' } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual(['bronze/tables/ccc/addresse.dbml']);
    expect(read('bronze/tables/ccc/addresse.dbml')).toContain('CCC addresses, cleaned');
  });

  it('on the diagram showing both, each node edits its own file (a column added to ccc.addresse, then one to bqs.addresse)', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const ccc = await canvas.send({ type: 'addColumn', payload: { modelName: 'ccc.addresse', column: { name: 'country', dataType: 'VARCHAR', description: '' } } });
    expect(ccc.errors).toEqual([]);
    expect(ccc.changed).toEqual(['bronze/tables/ccc/addresse.dbml']);
    const bqs = await canvas.send({ type: 'addColumn', payload: { modelName: 'bqs.addresse', column: { name: 'land', dataType: 'VARCHAR', description: '' } } });
    expect(bqs.errors).toEqual([]);
    expect(bqs.changed).toEqual(['bronze/tables/bqs/addresse.dbml']);
    expect(read('bronze/tables/ccc/addresse.dbml')).toContain('country');
    expect(read('bronze/tables/ccc/addresse.dbml')).not.toContain('land');
    const shown = canvas.posted().models.find((m) => m.name === 'ccc.addresse');
    expect(shown?.tableName).toBe('addresse');
    expect(shown?.columns.map((c) => c.name)).toEqual(['id', 'street', 'city', 'postcode', 'country']);
  });

  it('removing a column of ccc\'s addresse cuts the Refs at that column, its own and the one to it, and leaves bqs\'s', async () => {
    const canvas = await open('bronze/diagrams/ccc.dbml');
    const r = await canvas.send({ type: 'removeColumn', payload: { modelName: 'addresse', columnName: 'id' } });
    expect(r.errors).toEqual([]);
    expect(r.changed).not.toContain('bronze/tables/bqs/addresse.dbml');
    const rels = read('bronze/relationships/bronze.dbml');
    expect(rels).not.toContain('Ref: ccc.kunde.addresse_id >? ccc.addresse.id');
    // ccc.addresse's own Ref starts at the removed column: it goes too, never left pointing at nothing.
    expect(rels).not.toContain('Ref: ccc.addresse.id >? bqs.addresse.id');
    expect(rels).toContain('Ref: bqs.kunde.addresse_id >? bqs.addresse.id');
  });

  it('renaming a column of ccc\'s addresse renames it in ccc\'s Refs only', async () => {
    const canvas = await open('bronze/diagrams/ccc.dbml');
    const r = await canvas.send({ type: 'updateColumn', payload: { modelName: 'addresse', oldColumnName: 'id', column: { name: 'addr_id', dataType: 'INT', description: '', isPrimaryKey: true } } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual(['bronze/relationships/bronze.dbml', 'bronze/tables/ccc/addresse.dbml']);
    const rels = read('bronze/relationships/bronze.dbml');
    expect(rels).toContain('Ref: ccc.kunde.addresse_id >? ccc.addresse.addr_id');
    expect(rels).toContain('Ref: ccc.addresse.addr_id >? bqs.addresse.id');
    expect(rels).toContain('Ref: bqs.kunde.addresse_id >? bqs.addresse.id');
  });

  it('an edit made on one diagram redraws another open diagram that shows the table under <schema>.<name>', async () => {
    const { provider } = buildProvider();
    const openOn = async (diagram: string): Promise<ReturnType<typeof createMockWebviewPanel>> => {
      const document = createMockTextDocument(at(diagram), read(diagram), { persist: true });
      (vscode.workspace.textDocuments as unknown[]).push(document);
      const panel = createMockWebviewPanel();
      await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
      await panel._simulateMessage({ type: 'ready' });
      return panel;
    };
    const ccc = await openOn('bronze/diagrams/ccc.dbml');
    const kunden = await openOn('bronze/diagrams/kunden.dbml');
    kunden._postedMessages.length = 0;
    await ccc._simulateMessage({ type: 'updateModelDescription', payload: { modelName: 'addresse', description: 'CCC addresses, cleaned' } });
    const loaded = kunden._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded') as Array<{ payload: { models: Array<{ name: string; description?: string }> } }>;
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded[loaded.length - 1].payload.models.find((m) => m.name === 'ccc.addresse')?.description).toBe('CCC addresses, cleaned');
  });

  it('a name the diagram does not show is refused, and nothing is written', async () => {
    const canvas = await open('bronze/diagrams/ccc.dbml');
    const r = await canvas.send({ type: 'updateModelDescription', payload: { modelName: 'bqs.addresse', description: 'x' } });
    expect(r.errors.join(' ')).toContain('not on this diagram');
    expect(r.changed).toEqual([]);
  });
});

describe('the second table of a name joins a diagram', () => {
  it('from the Add Existing dialog (by its file): one new use line, both layout lines qualified, version 8, the first use line kept', async () => {
    const before = read('bronze/diagrams/bqs.dbml');
    const canvas = await open('bronze/diagrams/bqs.dbml');
    const r = await canvas.send({
      type: 'addExistingModel',
      payload: { modelName: 'addresse', sourcePath: '.erd-studio/bronze/tables/ccc/addresse.dbml' },
    });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual(['bronze/diagrams/bqs.dbml']);
    const after = read('bronze/diagrams/bqs.dbml');
    expect(after).toContain("erd_schema_version: '8'");
    expect(after).toContain('bqs.addresse 10 20');
    expect(after).toMatch(/ccc\.addresse -?\d+ -?\d+/);
    expect(after).not.toMatch(/^\s+addresse \d/m);
    expect(after).toMatch(/^use \{ table ccc\.addresse \} +from '\.\.\/tables\/ccc\/addresse\.dbml'$/m);
    for (const line of before.split('\n').filter((l) => l.startsWith('use { table bqs.addresse }'))) expect(after).toContain(line);
    const shown = canvas.posted();
    expect(shown.models.map((m) => m.name).sort()).toEqual(['bqs.addresse', 'ccc.addresse', 'kunde']);
    expect(shown.models.find((m) => m.name === 'ccc.addresse')?.columns.map((c) => c.name)).toEqual(['id', 'street', 'city', 'postcode']);
  });

  it('by a drop of its file', async () => {
    const canvas = await open('bronze/diagrams/bqs.dbml');
    const r = await canvas.send({
      type: 'dropTables',
      payload: { position: { x: 600, y: 300 }, uris: [pathToFileURL(at('bronze/tables/ccc/addresse.dbml')).href] },
    });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual(['bronze/diagrams/bqs.dbml']);
    expect(read('bronze/diagrams/bqs.dbml')).toContain('bqs.addresse 10 20');
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['bqs.addresse', 'ccc.addresse', 'kunde']);
  });

  it('a table the diagram already shows (the same file) is named, and nothing is written', async () => {
    const canvas = await open('bronze/diagrams/bqs.dbml');
    const r = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'addresse', sourcePath: '.erd-studio/bronze/tables/bqs/addresse.dbml' } });
    expect(r.errors.join(' ')).toContain('already exists in this diagram');
    expect(r.changed).toEqual([]);
  });

  it('removing it brings the first back to its bare name, keeping its position', async () => {
    const canvas = await open('bronze/diagrams/bqs.dbml');
    await canvas.send({ type: 'addExistingModel', payload: { modelName: 'addresse', sourcePath: '.erd-studio/bronze/tables/ccc/addresse.dbml' } });
    const r = await canvas.send({ type: 'removeModel', payload: { modelName: 'ccc.addresse' } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual(['bronze/diagrams/bqs.dbml']);
    const after = read('bronze/diagrams/bqs.dbml');
    expect(after).toContain('addresse 10 20');
    expect(after).not.toContain('bqs.addresse 10 20');
    expect(after).not.toContain('ccc/addresse.dbml');
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['addresse', 'kunde']);
  });
});

describe('the diagram showing both', () => {
  it('positions are saved per table', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const r = await canvas.send({ type: 'updatePositions', payload: { positions: { 'ccc.addresse': { x: 111, y: 222 } } } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual(['bronze/diagrams/kunden.dbml']);
    const after = read('bronze/diagrams/kunden.dbml');
    expect(after).toContain('ccc.addresse 111 222');
    expect(after).toContain('bqs.addresse 40 40');
  });

  it('the Ref between the two addresse tables is drawn between two nodes, and drawing it again is refused as the same link (not a self-reference)', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const edges = canvas.posted().relationships.map((e) => `${e.fromModel}>${e.toModel}`).sort();
    expect(edges).toEqual(['bqs.kunde>bqs.addresse', 'ccc.addresse>bqs.addresse', 'ccc.kunde>ccc.addresse']);
    const r = await canvas.send({
      type: 'addRelationship',
      payload: { fromModel: 'bqs.addresse', fromColumn: 'id', toModel: 'ccc.addresse', toColumn: 'id', cardinality: 'one-to-one' },
    });
    expect(r.errors.join(' ')).toContain('already exists');
    expect(r.changed).toEqual([]);
  });

  it('a relationship drawn from ccc.kunde to bqs.addresse is stored with qualified ends, beside the same pair of names in ccc', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const r = await canvas.send({
      type: 'addRelationship',
      payload: { fromModel: 'ccc.kunde', fromColumn: 'id', toModel: 'bqs.addresse', toColumn: 'id', cardinality: 'many-to-one' },
    });
    expect(r.errors).toEqual([]);
    expect(r.changed.filter((f) => f.startsWith('bronze/tables/'))).toEqual([]);
    const rels = read('bronze/relationships/bronze.dbml');
    expect(rels).toContain('Ref: ccc.kunde.id >? bqs.addresse.id');
    expect(rels).toContain('Ref: ccc.kunde.addresse_id >? ccc.addresse.id');
    const edges = canvas.posted().relationships.map((e) => `${e.fromModel}>${e.toModel}`).sort();
    expect(edges).toContain('ccc.kunde>bqs.addresse');
    expect(edges).toContain('ccc.kunde>ccc.addresse');
  });

  it('removing one relationship removes exactly its Ref', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const before = read('bronze/relationships/bronze.dbml');
    const r = await canvas.send({
      type: 'removeRelationship',
      payload: { fromModel: 'ccc.kunde', fromColumn: 'addresse_id', toModel: 'ccc.addresse', toColumn: 'id' },
    });
    expect(r.errors).toEqual([]);
    const after = read('bronze/relationships/bronze.dbml');
    expect(after).not.toContain('Ref: ccc.kunde.addresse_id >? ccc.addresse.id');
    expect(after).toContain('Ref: bqs.kunde.addresse_id >? bqs.addresse.id');
    expect(after).toContain('Ref: ccc.addresse.id >? bqs.addresse.id');
    expect(before).not.toBe(after);
  });

  it('renaming ccc.addresse renames its file only; bqs\'s table returns to its bare name on the diagram with its position', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const bqsBefore = read('bronze/tables/bqs/addresse.dbml');
    const r = await canvas.send({ type: 'renameModel', payload: { oldName: 'ccc.addresse', newName: 'adresse2' } });
    expect(r.errors).toEqual([]);
    expect(fs.existsSync(at('bronze/tables/ccc/adresse2.dbml'))).toBe(true);
    expect(fs.existsSync(at('bronze/tables/ccc/addresse.dbml'))).toBe(false);
    expect(read('bronze/tables/bqs/addresse.dbml')).toBe(bqsBefore);
    const diagram = read('bronze/diagrams/kunden.dbml');
    expect(diagram).toContain('addresse 40 40');
    expect(diagram).toContain('adresse2 40 360');
    expect(diagram).not.toContain('bqs.addresse 40 40');
    const rels = read('bronze/relationships/bronze.dbml');
    expect(rels).toContain('Ref: bqs.kunde.addresse_id >? bqs.addresse.id');
    expect(rels).toContain('Ref: ccc.kunde.addresse_id >? ccc.adresse2.id');
    // Its new name is its name on the diagram, which the canvas selects it by: no reveal is needed.
    expect(canvas.panel._postedMessages.some((m) => (m as { type: string }).type === 'revealTable')).toBe(false);
  });

  it('renaming ccc.kunde names it by its new name on the diagram (where the canvas selects it), and bqs\'s kunde by its bare name', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const r = await canvas.send({ type: 'renameModel', payload: { oldName: 'ccc.kunde', newName: 'kunde_ccc' } });
    expect(r.errors).toEqual([]);
    const shown = canvas.posted().models.map((m) => m.name).sort();
    expect(shown).toEqual(['bqs.addresse', 'ccc.addresse', 'kunde', 'kunde_ccc']);
    const diagram = read('bronze/diagrams/kunden.dbml');
    expect(diagram).toContain('kunde 400 40');
    expect(diagram).toContain('kunde_ccc 400 360');
  });
});

describe('the canvas context and the Add Existing rows, by file', () => {
  /** The last `canvasContext` posted, once its background work is done. */
  async function contextOf(canvas: Canvas): Promise<{ tableFiles: Record<string, string>; offDiagram: Record<string, Array<Record<string, unknown>>> }> {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const all = canvas.panel._postedMessages.filter((m) => (m as { type: string }).type === 'canvasContext') as Array<{ payload: ReturnType<typeof contextOf> extends Promise<infer T> ? T : never }>;
    return all[all.length - 1].payload;
  }

  it('the ccc diagram\'s tables name their own files, and the bqs table their Ref reaches is listed off the diagram with its file', async () => {
    const canvas = await open('bronze/diagrams/ccc.dbml');
    const context = await contextOf(canvas);
    expect(context.tableFiles).toEqual({
      addresse: '.erd-studio/bronze/tables/ccc/addresse.dbml',
      kunde: '.erd-studio/bronze/tables/ccc/kunde.dbml',
    });
    expect(context.offDiagram).toEqual({
      addresse: [{ otherTable: 'bqs.addresse', columns: 'id', cardinality: 'many-to-one', direction: 'out', otherTablePath: '.erd-studio/bronze/tables/bqs/addresse.dbml' }],
    });
    // "+ Add" of that row adds bqs's table beside ccc's.
    const r = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'bqs.addresse', sourcePath: '.erd-studio/bronze/tables/bqs/addresse.dbml' } });
    expect(r.errors).toEqual([]);
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['bqs.addresse', 'ccc.addresse', 'kunde']);
  });

  it('the Add Existing rows leave out the diagram\'s own files, not their namesakes, and carry each layer and schema folder', async () => {
    const canvas = await open('bronze/diagrams/ccc.dbml');
    await canvas.panel._simulateMessage({ type: 'requestExistingTables' });
    const sent = canvas.panel._postedMessages.filter((m) => (m as { type: string }).type === 'existingTables') as Array<{ payload: { existingModels: Array<{ name: string; sourcePath: string; layer?: string; schemaFolder?: string }> } }>;
    const rows = sent[sent.length - 1].payload.existingModels.map((m) => [m.name, m.sourcePath, m.layer, m.schemaFolder]);
    expect(rows).toEqual([
      ['addresse', '.erd-studio/bronze/tables/bqs/addresse.dbml', 'bronze', 'bqs'],
      ['kunde', '.erd-studio/bronze/tables/bqs/kunde.dbml', 'bronze', 'bqs'],
    ]);
  });
});

describe('adding a table by its file, with dbt', () => {
  const CCC_KUNDE = '.erd-studio/bronze/tables/ccc/kunde.dbml';

  it('derives the relationships dbt tests, landing on the table whose schema dbt builds (ccc.kunde → bqs.addresse)', async () => {
    ymlModels = [{ name: 'kunde', configSchema: 'ccc' }, { name: 'addresse', configSchema: 'bqs' }];
    ymlTests = [{ fromModel: 'kunde', fromColumn: 'addresse_id', toModel: 'addresse', toColumn: 'id' }];
    const canvas = await open('bronze/diagrams/bqs.dbml');
    const before = read('bronze/relationships/bronze.dbml');
    const r = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'kunde', sourcePath: CCC_KUNDE } });
    expect(r.errors).toEqual([]);
    const rels = read('bronze/relationships/bronze.dbml');
    // The one new Ref is ccc's kunde to bqs's addresse; bqs's kunde gains nothing, and every Ref already there keeps its line.
    const added = rels.split('\n').filter((line) => !before.split('\n').includes(line) && line.startsWith('Ref:'));
    expect(added).toEqual([expect.stringMatching(/^Ref: ccc\.kunde\.addresse_id >\?? ?bqs\.addresse\.id$/)]);
    for (const line of before.split('\n').filter((l) => l.startsWith('Ref:'))) expect(rels).toContain(line);
    expect(r.changed).not.toContain('bronze/tables/bqs/kunde.dbml');
    expect(r.changed).not.toContain('bronze/tables/ccc/addresse.dbml');
    // Drawn between the two nodes.
    expect(canvas.posted().relationships.map((e) => `${e.fromModel}>${e.toModel}`)).toContain('ccc.kunde>addresse');
  });

  it('derives none when dbt\'s model of the name is built in neither schema', async () => {
    ymlModels = [{ name: 'kunde', configSchema: 'ccc' }, { name: 'addresse', configSchema: 'ddd' }];
    ymlTests = [{ fromModel: 'kunde', fromColumn: 'addresse_id', toModel: 'addresse', toColumn: 'id' }];
    const canvas = await open('bronze/diagrams/bqs.dbml');
    const before = read('bronze/relationships/bronze.dbml');
    const r = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'kunde', sourcePath: CCC_KUNDE } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual(['bronze/diagrams/bqs.dbml']);
    expect(read('bronze/relationships/bronze.dbml')).toBe(before);
  });

  it('a pick of a Table Library row and a dbt-only row adds the row by its file and seeds the other, in one edit', async () => {
    ymlModels = [{ name: 'stg_orte', columns: ['id', 'ort'] }];
    const canvas = await open('bronze/diagrams/bqs.dbml');
    const r = await canvas.send({
      type: 'addExistingModels',
      payload: { modelNames: ['kunde', 'stg_orte'], sourcePaths: [CCC_KUNDE, ''] },
    });
    expect(r.errors).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    const after = read('bronze/diagrams/bqs.dbml');
    // ccc's kunde joins beside bqs's (both named by schema now); the dbt model is a new table on the diagram.
    expect(after).toMatch(/^use \{ table ccc\.kunde \} +from '\.\.\/tables\/ccc\/kunde\.dbml'$/m);
    expect(after).toContain('bqs.kunde 300 20');
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['addresse', 'bqs.kunde', 'ccc.kunde', 'stg_orte']);
    expect(r.changed.filter((f) => f.endsWith('/stg_orte.dbml'))).toHaveLength(1);
    expect(r.changed).not.toContain('bronze/tables/bqs/kunde.dbml');
    expect(r.changed).not.toContain('bronze/tables/ccc/kunde.dbml');
  });

  it('a table seeded from dbt is saved as a new table (create), by Add Existing and by the batch add alike', async () => {
    ymlModels = [{ name: 'stg_orte', columns: ['id', 'ort'] }, { name: 'stg_plz', columns: ['id'] }];
    const canvas = await open('bronze/diagrams/bqs.dbml');
    const tables = (canvas.provider as unknown as { tableLibraryService: TableLibraryService }).tableLibraryService;
    const planned = vi.spyOn(tables, 'planTableWrites');
    const saves = (): Array<{ name: string; create?: boolean }> => planned.mock.calls
      .flatMap((c) => (c[0]?.save ?? []).map((save) => ({ name: save.model.name, ...(save.create ? { create: true } : {}) })));
    expect((await canvas.send({ type: 'addExistingModel', payload: { modelName: 'stg_orte' } })).errors).toEqual([]);
    expect(saves()).toEqual([{ name: 'stg_orte', create: true }]);
    planned.mockClear();
    expect((await canvas.send({ type: 'addExistingModels', payload: { modelNames: ['stg_plz'] } })).errors).toEqual([]);
    expect(saves()).toEqual([{ name: 'stg_plz', create: true }]);
  });

  it('a Table Library drag that names its files is added by file (names only when it has none)', async () => {
    const canvas = await open('bronze/diagrams/bqs.dbml');
    canvas.provider.noteLibraryDrag(['addresse'], [at('bronze/tables/ccc/addresse.dbml')]);
    const r = await canvas.send({ type: 'dropTables', payload: { position: { x: 600, y: 300 }, uris: [], fromLibrary: true } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual(['bronze/diagrams/bqs.dbml']);
    expect(read('bronze/diagrams/bqs.dbml')).toContain('bqs.addresse 10 20');
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['bqs.addresse', 'ccc.addresse', 'kunde']);
  });
});

describe('the second table of a name joins in one edit (one undo step)', () => {
  it('one WorkspaceEdit replaces the diagram\'s text only; putting that text back draws the diagram as before', async () => {
    const before = read('bronze/diagrams/bqs.dbml');
    const canvas = await open('bronze/diagrams/bqs.dbml');
    const shownBefore = canvas.posted();
    const r = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'addresse', sourcePath: '.erd-studio/bronze/tables/ccc/addresse.dbml' } });
    expect(r.errors).toEqual([]);
    // VS Code's undo rewinds one applied WorkspaceEdit: this add is exactly one, touching the diagram alone.
    expect(_appliedEdits).toHaveLength(1);
    const ops = _appliedEdits[0]._ops as Array<{ kind: string; uri?: { fsPath: string } }>;
    expect(ops.map((op) => [op.kind, op.uri?.fsPath])).toEqual([['replace', at('bronze/diagrams/bqs.dbml')]]);
    // What that undo puts back is the text before the edit: it reads as the diagram did.
    const undo = new vscode.WorkspaceEdit();
    undo.replace(canvas.document.uri as never, new vscode.Range(canvas.document.positionAt(0) as never, canvas.document.positionAt(canvas.document.getText().length) as never), before);
    await vscode.workspace.applyEdit(undo);
    await (canvas.document as unknown as { save(): Promise<boolean> }).save();
    expect(read('bronze/diagrams/bqs.dbml')).toBe(before);
    const reopened = await open('bronze/diagrams/bqs.dbml');
    expect(reopened.posted().models.map((m) => m.name)).toEqual(shownBefore.models.map((m) => m.name));
    expect(reopened.posted().viewConfig.positions.addresse).toEqual({ x: 10, y: 20 });
  });
});

describe('Delete Table File for one table of a pair', () => {
  it('Remove from the diagram showing both, then Delete Table File: only ccc\'s file, Refs and places go; bqs\'s stay byte for byte', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const bqsTable = read('bronze/tables/bqs/addresse.dbml');
    const bqsDiagram = read('bronze/diagrams/bqs.dbml');
    let prompt = '';
    let done = '';
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (message: string, ...items: string[]) => {
      if (items.includes('Delete Table File')) {
        prompt = message;
        return 'Delete Table File';
      }
      if (message.startsWith('Deleted ')) done = message;
      return undefined;
    }) as never);
    const r = await canvas.send({ type: 'removeModel', payload: { modelName: 'ccc.addresse' } });
    expect(r.errors).toEqual([]);
    // The offer is answered after the remove: wait for the delete it starts to finish.
    for (let i = 0; i < 200 && done === ''; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe('Deleted bronze/tables/ccc/addresse.dbml');
    expect(prompt).toContain('Removed "addresse" from this diagram');
    expect(fs.existsSync(at('bronze/tables/ccc/addresse.dbml'))).toBe(false);
    expect(read('bronze/tables/bqs/addresse.dbml')).toBe(bqsTable);
    expect(read('bronze/diagrams/bqs.dbml')).toBe(bqsDiagram);
    const rels = read('bronze/relationships/bronze.dbml');
    expect(rels).toContain('Ref: bqs.kunde.addresse_id >? bqs.addresse.id');
    expect(rels).toContain("use { table bqs.addresse } from '../tables/bqs/addresse.dbml'");
    expect(rels).not.toContain('ccc.addresse');
    // The ccc diagram loses ccc's addresse only; the diagram of 2.0.2 loses its use line and keeps bqs's.
    const ccc = read('bronze/diagrams/ccc.dbml');
    expect(ccc).not.toContain('ccc/addresse.dbml');
    expect(ccc).toContain("use { table ccc.kunde }    from '../tables/ccc/kunde.dbml'");
    const bare = read('bronze/diagrams/kunden-bare.dbml');
    expect(bare).not.toContain('ccc/addresse.dbml');
    expect(bare).toContain("use { table bqs.addresse } from '../tables/bqs/addresse.dbml'");
  });

  it('deleteTablesWithCascade by identity: the namesake\'s file, Refs, use lines and diagrams are byte-identical', async () => {
    const canvas = await open('bronze/diagrams/ccc.dbml');
    const keep = ['bronze/tables/bqs/addresse.dbml', 'bronze/tables/bqs/kunde.dbml', 'bronze/diagrams/bqs.dbml'].map((f) => [f, read(f)]);
    const result = await canvas.provider.deleteTablesWithCascade([{ schema: 'ccc', name: 'addresse' }]);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(at('bronze/tables/ccc/addresse.dbml'))).toBe(false);
    for (const [file, text] of keep) expect(read(file)).toBe(text);
    const rels = read('bronze/relationships/bronze.dbml');
    expect(rels).toContain('Ref: bqs.kunde.addresse_id >? bqs.addresse.id');
    expect(rels).not.toMatch(/ccc\.addresse/);
    const kunden = read('bronze/diagrams/kunden.dbml');
    expect(kunden).toContain("use { table bqs.addresse } from '../tables/bqs/addresse.dbml'");
    expect(kunden).not.toContain('ccc/addresse.dbml');
  });
});

/** A JSON diagram (v5) listing tables by name alone, with relationship copies of its own. */
function writeJsonDiagram(relationships: Array<Record<string, unknown>> = []): void {
  fs.writeFileSync(at('bronze/legacy.json'), `${JSON.stringify({
    schemaVersion: 5,
    domain: 'legacy',
    layer: 'bronze',
    description: '',
    logical: { models: ['addresse', 'kunde'], relationships, viewConfig: {} },
    viewConfig: { positions: { addresse: { x: 10, y: 10 }, kunde: { x: 300, y: 10 } } },
  }, null, 2)}\n`);
}

describe('other diagrams, by the reference each uses', () => {
  it('a column renamed on ccc\'s addresse is not renamed in a JSON diagram\'s own copy, whose addresse is bqs\'s', async () => {
    writeJsonDiagram([{ fromModel: 'kunde', fromColumn: 'addresse_id', toModel: 'addresse', toColumn: 'id', cardinality: 'many-to-one' }]);
    const before = read('bronze/legacy.json');
    const canvas = await open('bronze/diagrams/ccc.dbml');
    const r = await canvas.send({ type: 'updateColumn', payload: { modelName: 'addresse', oldColumnName: 'id', column: { name: 'addr_id', dataType: 'INT', description: '', isPrimaryKey: true } } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toContain('bronze/tables/ccc/addresse.dbml');
    expect(read('bronze/legacy.json')).toBe(before);
  });

  it('one renamed on bqs\'s addresse (the table the JSON diagram\'s name reads) is renamed there too', async () => {
    writeJsonDiagram([{ fromModel: 'kunde', fromColumn: 'addresse_id', toModel: 'addresse', toColumn: 'id', cardinality: 'many-to-one' }]);
    const canvas = await open('bronze/diagrams/bqs.dbml');
    const r = await canvas.send({ type: 'updateColumn', payload: { modelName: 'addresse', oldColumnName: 'id', column: { name: 'addr_id', dataType: 'INT', description: '', isPrimaryKey: true } } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toContain('bronze/legacy.json');
    expect(read('bronze/legacy.json')).toContain('"toColumn": "addr_id"');
  });

  it('a column removed from ccc\'s addresse takes the diagram\'s own (pending) copy of a member of the library composite it is in', async () => {
    // A composite Ref ccc.kunde.(addresse_id, full_name) > ccc.addresse.(id, street) in place of the single one, and the ccc diagram's own copy of its second pair.
    fs.writeFileSync(at('bronze/relationships/bronze.dbml'), fs.readFileSync(at('bronze/relationships/bronze.dbml'), 'utf-8')
    .replace('Ref: ccc.kunde.addresse_id >? ccc.addresse.id', 'Ref: ccc.kunde.(addresse_id, full_name) > ccc.addresse.(id, street)'));
    fs.appendFileSync(at('bronze/diagrams/ccc.dbml'), '\n// erd-studio pending: Ref: ccc.kunde.full_name > ccc.addresse.street\n');
    const canvas = await open('bronze/diagrams/ccc.dbml');
    const r = await canvas.send({ type: 'removeColumn', payload: { modelName: 'addresse', columnName: 'id' } });
    expect(r.errors).toEqual([]);
    expect(read('bronze/diagrams/ccc.dbml')).not.toContain('erd-studio pending');
  });
});

describe('a layer twin of a member named <schema>.<name>', () => {
  beforeEach(() => {
    const layers = JSON.parse(read('layers.json')) as { layers: Array<Record<string, unknown>> };
    layers.layers.push({ id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#c0c0c0', creatable: true, order: 2 });
    fs.writeFileSync(at('layers.json'), JSON.stringify(layers, null, 2));
    fs.mkdirSync(at('silver/tables/bqs'), { recursive: true });
    fs.copyFileSync(at('bronze/tables/bqs/addresse.dbml'), at('silver/tables/bqs/addresse.dbml'));
  });

  const warnings = (): string[] => (vscode.window.showWarningMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

  it('is warned about on the diagram showing both (where bqs\'s addresse is bqs.addresse)', async () => {
    vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((async () => undefined) as never);
    await open('bronze/diagrams/kunden.dbml');
    expect(warnings().filter((m) => m.includes('"addresse" is defined twice'))).toHaveLength(1);
  });

  it('is not warned about on a diagram showing only ccc\'s addresse (another table)', async () => {
    vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((async () => undefined) as never);
    await open('bronze/diagrams/ccc.dbml');
    expect(warnings().filter((m) => m.includes('defined twice'))).toEqual([]);
  });
});

describe('what the library\'s relationships name, on the canvas', () => {
  it('the relationship survey reads the library under its library references: no Ref to a table of a pair counts as dangling', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const { telemetry } = await import('../../src/services/telemetryService');
    const surveyed = vi.spyOn(telemetry, 'relationshipState').mockImplementation(() => undefined);
    (canvas.provider as unknown as { recordRelationshipState(d: unknown): void }).recordRelationshipState(canvas.document);
    expect(surveyed).toHaveBeenCalledTimes(1);
    expect(surveyed.mock.calls[0][0].danglingModel).toBe(0);
  });

  it('an unqualified Ref end two schema folders share is not drawn, even where one table of the name is bare on the diagram', async () => {
    fs.appendFileSync(at('bronze/relationships/bronze.dbml'), 'Ref: ccc.kunde.full_name > addresse.street\n');
    const canvas = await open('bronze/diagrams/ccc.dbml');
    const edges = canvas.posted().relationships as Array<{ fromModel: string; fromColumn?: string; toModel: string }>;
    expect(edges.filter((e) => e.fromColumn === 'full_name')).toEqual([]);
    expect(edges.map((e) => `${e.fromModel}>${e.toModel}`)).toEqual(['kunde>addresse']);
  });

  it('an edit names its table\'s cached read by its file, never by a name its namesake shares', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const tables = (canvas.provider as unknown as { tableLibraryService: TableLibraryService }).tableLibraryService;
    const dropped = vi.spyOn(tables, 'invalidateCache');
    const r = await canvas.send({ type: 'updateModelDescription', payload: { modelName: 'ccc.addresse', description: 'CCC addresses' } });
    expect(r.errors).toEqual([]);
    expect(dropped.mock.calls.map((c) => c[0])).not.toContain('addresse');
    // The next read is fresh all the same.
    expect(canvas.posted().models.find((m) => m.name === 'ccc.addresse') as unknown as { description?: string }).toMatchObject({ description: 'CCC addresses' });
  });
});

describe('a JSON diagram in a project with two tables of one name (owner decision F)', () => {
  it('reads the library\'s first table of the name; an edit of it, or a relationship to it, is refused in one sentence naming both schema folders', async () => {
    writeJsonDiagram();
    const canvas = await open('bronze/legacy.json');
    expect(canvas.posted().models.find((m) => m.name === 'addresse')?.columns.map((c) => c.name)).toEqual(['id', 'strasse', 'ort']);
    const before = snapshot();
    const edit = await canvas.send({ type: 'updateModelDescription', payload: { modelName: 'addresse', description: 'x' } });
    expect(edit.errors).toHaveLength(1);
    expect(edit.errors[0]).toMatch(/the schema folders bqs and ccc each have a table called addresse.*DBML diagram/);
    const rel = await canvas.send({ type: 'addRelationship', payload: { fromModel: 'kunde', fromColumn: 'addresse_id', toModel: 'addresse', toColumn: 'id', cardinality: 'many-to-one' } });
    expect(rel.errors).toHaveLength(1);
    expect(rel.errors[0]).toMatch(/schema folders bqs and ccc each have a table called (kunde|addresse).*DBML diagram/);
    expect(rel.errors[0]).not.toContain('not found in the Table Library');
    expect(snapshot()).toEqual(before);
  });
});
