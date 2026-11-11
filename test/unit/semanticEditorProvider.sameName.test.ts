/**
 * The editor on two tables of one name in different schema folders
 * (packages/core/test/fixtures/dbml/same-name-two-schemas: bqs and ccc, each
 * with addresse and kunde), with the library telling tables apart by
 * identity: every
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
  const tables = new TableLibraryService(root, '.erd-studio', new OwnWriteTracker());
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

  it('adding the second table and removing it again gives back the same bytes, the relationships import and its line kept', async () => {
    const before = read('bronze/diagrams/bqs.dbml');
    const canvas = await open('bronze/diagrams/bqs.dbml');
    await canvas.send({ type: 'addExistingModel', payload: { modelName: 'addresse', sourcePath: '.erd-studio/bronze/tables/ccc/addresse.dbml' } });
    expect(read('bronze/diagrams/bqs.dbml')).toContain("use * from '../relationships/bronze.dbml'");
    const r = await canvas.send({ type: 'removeModel', payload: { modelName: 'ccc.addresse' } });
    expect(r.errors).toEqual([]);
    expect(read('bronze/diagrams/bqs.dbml')).toBe(before);
    expect(canvas.posted().relationships.map((rel) => `${rel.fromModel}>${rel.toModel}`)).toEqual(['kunde>addresse']);
  });

  it('removing one table of a pair from the diagram showing both keeps its relationships import', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const r = await canvas.send({ type: 'removeModel', payload: { modelName: 'ccc.addresse' } });
    expect(r.errors).toEqual([]);
    expect(read('bronze/diagrams/kunden.dbml')).toContain("use * from '../relationships/bronze.dbml'");
    expect(canvas.posted().relationships.map((rel) => `${rel.fromModel}>${rel.toModel}`)).toContain('bqs.kunde>addresse');
    fs.copyFileSync(path.join(TWINS, '.erd-studio/bronze/diagrams/kunden.dbml'), at('bronze/diagrams/kunden.dbml'));
    const again = await open('bronze/diagrams/kunden.dbml');
    const both = await again.send({ type: 'removeModels', payload: { modelNames: ['bqs.addresse', 'bqs.kunde'] } });
    expect(both.errors).toEqual([]);
    expect(read('bronze/diagrams/kunden.dbml')).toContain("use * from '../relationships/bronze.dbml'");
    expect(again.posted().relationships.map((rel) => `${rel.fromModel}>${rel.toModel}`)).toEqual(['kunde>addresse']);
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

describe('a rename into a name another schema folder\'s table has (the rule flipped: refused only in its own schema folder)', () => {
  it('ddd.kunde2 renamed addresse beside bqs.addresse: both keep their positions under <schema>.<name>, the diagram turns 8, bqs\'s file is untouched', async () => {
    fs.mkdirSync(at('bronze/tables/ddd'), { recursive: true });
    fs.writeFileSync(at('bronze/tables/ddd/kunde2.dbml'), 'Table ddd.kunde2 {\n  id INT [pk]\n}\n');
    fs.writeFileSync(at('bronze/diagrams/pairform.dbml'), [
      'Project pairform {', "  erd_schema_version: '7'", "  erd_layout: '''", '    addresse 10 20', '    kunde2 300 20', "  '''", '}', '',
      "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
      "use { table ddd.kunde2 }   from '../tables/ddd/kunde2.dbml'", '',
    ].join('\n'));
    const bqs = read('bronze/tables/bqs/addresse.dbml');
    const canvas = await open('bronze/diagrams/pairform.dbml');
    const r = await canvas.send({ type: 'renameModel', payload: { oldName: 'kunde2', newName: 'addresse' } });
    expect(r.errors).toEqual([]);
    expect(read('bronze/tables/ddd/addresse.dbml')).toMatch(/^Table ddd\.addresse \{/m);
    expect(read('bronze/tables/bqs/addresse.dbml')).toBe(bqs);
    const diagram = read('bronze/diagrams/pairform.dbml');
    expect(diagram).toContain("erd_schema_version: '8'");
    expect(diagram).toMatch(/^\s+bqs\.addresse 10 20$/m);
    expect(diagram).toMatch(/^\s+ddd\.addresse 300 20$/m);
    // Renaming bqs's onto a name its own schema folder has is refused, naming the schema.
    fs.writeFileSync(at('bronze/tables/bqs/ort.dbml'), 'Table bqs.ort {\n  id INT [pk]\n}\n');
    const again = await open('bronze/diagrams/pairform.dbml');
    const refused = await again.send({ type: 'renameModel', payload: { oldName: 'bqs.addresse', newName: 'Ort' } });
    expect(refused.errors).toEqual(['The schema bqs already has a table called "ort" (bronze/tables/bqs/ort.dbml). Choose a different name.']);
    expect(refused.changed).toEqual([]);
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

describe('New Table on a DBML diagram, in a schema folder another table of its name is not in', () => {
  const ID = [{ name: 'id', dataType: 'INT', description: '', isPrimaryKey: true }];

  it('a name only another schema folder has: the diagram reads the new file, and a later column edit changes only it', async () => {
    fs.writeFileSync(at('bronze/tables/bqs/ort.dbml'), 'Table bqs.ort {\n  id INT [pk]\n  plz VARCHAR\n}\n');
    const bqsOrt = read('bronze/tables/bqs/ort.dbml');
    const canvas = await open('bronze/diagrams/ccc.dbml');
    const r = await canvas.send({ type: 'addModel', payload: { name: 'ort', description: '', columns: ID, schemaFolder: 'ccc' } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual(['bronze/diagrams/ccc.dbml', 'bronze/tables/ccc/ort.dbml']);
    const diagram = read('bronze/diagrams/ccc.dbml');
    expect(diagram).toMatch(/^use \{ table ccc\.ort \} +from '\.\.\/tables\/ccc\/ort\.dbml'$/m);
    expect(diagram).not.toContain('bqs/ort.dbml');
    expect(canvas.posted().models.find((m) => m.name === 'ort')?.columns.map((c) => c.name)).toEqual(['id']);
    const col = await canvas.send({ type: 'addColumn', payload: { modelName: 'ort', column: { name: 'stadt', dataType: 'VARCHAR', description: '' } } });
    expect(col.errors).toEqual([]);
    expect(col.changed).toEqual(['bronze/tables/ccc/ort.dbml']);
    expect(read('bronze/tables/bqs/ort.dbml')).toBe(bqsOrt);
  });

  it('a name a member has in another schema folder forms the pair in one edit: version 8, both layout lines qualified', async () => {
    const canvas = await open('bronze/diagrams/bqs.dbml');
    const r = await canvas.send({ type: 'addModel', payload: { name: 'addresse', description: '', columns: ID, schemaFolder: 'ddd' } });
    expect(r.errors).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(r.changed).toEqual(['bronze/diagrams/bqs.dbml', 'bronze/tables/ddd/addresse.dbml']);
    expect(read('bronze/tables/ddd/addresse.dbml')).toContain('Table ddd.addresse');
    const after = read('bronze/diagrams/bqs.dbml');
    expect(after).toContain("erd_schema_version: '8'");
    expect(after).toContain('bqs.addresse 10 20');
    expect(after).toMatch(/ddd\.addresse -?\d+ -?\d+/);
    expect(after).not.toMatch(/^\s+addresse \d/m);
    expect(after).toMatch(/^use \{ table bqs\.addresse \} +from '\.\.\/tables\/bqs\/addresse\.dbml'$/m);
    expect(after).toMatch(/^use \{ table ddd\.addresse \} +from '\.\.\/tables\/ddd\/addresse\.dbml'$/m);
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['bqs.addresse', 'ddd.addresse', 'kunde']);
    expect(canvas.posted().models.find((m) => m.name === 'ddd.addresse')?.columns.map((c) => c.name)).toEqual(['id']);
  });

  it('a name a member has in the same schema folder is still refused', async () => {
    const canvas = await open('bronze/diagrams/bqs.dbml');
    const before = snapshot();
    const r = await canvas.send({ type: 'addModel', payload: { name: 'addresse', description: '', columns: ID, schemaFolder: 'bqs' } });
    expect(r.errors).toEqual(['Table "addresse" already exists in this diagram.']);
    expect(changed(before, snapshot())).toEqual([]);
  });
});

describe('renaming a table of a pair to its own name', () => {
  it('in another case is refused as a case-only rename; unchanged is a no-op', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const before = snapshot();
    const cased = await canvas.send({ type: 'renameModel', payload: { oldName: 'ccc.addresse', newName: 'Addresse' } });
    expect(cased.errors).toEqual(['"Addresse" differs from "addresse" only in upper/lower case, which cannot be renamed in place. Rename it to a different name first, then to the one you want.']);
    const same = await canvas.send({ type: 'renameModel', payload: { oldName: 'ccc.addresse', newName: 'addresse' } });
    expect(same.errors).toEqual([]);
    expect(changed(before, snapshot())).toEqual([]);
  });
});

describe('opening a diagram is never a write', () => {
  it('a version-7 diagram listing both tables of a pair (bare layout lines) is drawn with every table placed, and its file is left as it is', async () => {
    const before = snapshot();
    const canvas = await open('bronze/diagrams/kunden-bare.dbml');
    expect(changed(before, snapshot())).toEqual([]);
    expect(Object.keys(canvas.posted().viewConfig.positions).sort()).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    // The next real edit is what moves it to version 8 (doctor's twinDiagramVersion says so).
    const r = await canvas.send({ type: 'updateModelDescription', payload: { modelName: 'ccc.addresse', description: 'CCC' } });
    expect(r.errors).toEqual([]);
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

describe('the sidebar names a table of a pair by its file (stage 9)', () => {
  it('Add to Diagram… (and a drop on the diagram\'s row) adds the table of the file given, beside its namesake, and selects it', async () => {
    const canvas = await open('bronze/diagrams/bqs.dbml');
    canvas.panel._postedMessages.length = 0;
    await canvas.provider.addTablesToDiagram(vscode.Uri.file(at('bronze/diagrams/bqs.dbml')), ['addresse'], [at('bronze/tables/ccc/addresse.dbml')]);
    const after = read('bronze/diagrams/bqs.dbml');
    expect(after).toContain('bqs.addresse 10 20');
    expect(after).toMatch(/^use \{ table ccc\.addresse \} +from '\.\.\/tables\/ccc\/addresse\.dbml'$/m);
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['bqs.addresse', 'ccc.addresse', 'kunde']);
    const reveals = canvas.panel._postedMessages.filter((m) => (m as { type: string }).type === 'revealTable') as Array<{ payload: { modelName: string } }>;
    expect(reveals.map((m) => m.payload.modelName)).toEqual(['ccc.addresse']);
  });

  it('a table whose own file the diagram shows already is selected by what the diagram calls it, and nothing is written', async () => {
    const canvas = await open('bronze/diagrams/kunden.dbml');
    const before = snapshot();
    canvas.panel._postedMessages.length = 0;
    await canvas.provider.addTablesToDiagram(vscode.Uri.file(at('bronze/diagrams/kunden.dbml')), ['addresse'], [at('bronze/tables/ccc/addresse.dbml')]);
    expect(changed(before, snapshot())).toEqual([]);
    const reveals = canvas.panel._postedMessages.filter((m) => (m as { type: string }).type === 'revealTable') as Array<{ payload: { modelName: string } }>;
    expect(reveals.map((m) => m.payload.modelName)).toEqual(['ccc.addresse']);
  });

  it('a JSON diagram (names alone) is never given the other table of a shared name: ccc\'s is refused, bqs\'s (the one the name reads) is added', async () => {
    fs.writeFileSync(at('bronze/empty.json'), `${JSON.stringify({ schemaVersion: 5, domain: 'empty', layer: 'bronze', description: '', logical: { models: [], relationships: [], viewConfig: {} } }, null, 2)}\n`);
    const canvas = await open('bronze/empty.json');
    const before = snapshot();
    canvas.panel._postedMessages.length = 0;
    await canvas.provider.addTablesToDiagram(vscode.Uri.file(at('bronze/empty.json')), ['addresse'], [at('bronze/tables/ccc/addresse.dbml')]);
    const errors = canvas.panel._postedMessages
      .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
      .map((m) => m.payload.message);
    expect(errors).toEqual(['Can\'t add "addresse" to this diagram: the schema folders bqs and ccc each have a table called addresse, and a JSON diagram names tables by name alone. Add it to a DBML diagram.']);
    expect(changed(before, snapshot())).toEqual([]);
    await canvas.provider.addTablesToDiagram(vscode.Uri.file(at('bronze/empty.json')), ['addresse'], [at('bronze/tables/bqs/addresse.dbml')]);
    expect(JSON.parse(read('bronze/empty.json')).logical.models).toEqual(['addresse']);
  });

  it('Add Tables from dbt with a model whose name two schema folders share says so, naming both, and writes nothing', async () => {
    ymlModels = [{ name: 'addresse', configSchema: 'ddd' }];
    fs.writeFileSync(at('bronze/diagrams/empty.dbml'), "Project empty {\n  erd_schema_version: '7'\n}\n");
    const canvas = await open('bronze/diagrams/empty.dbml');
    const before = snapshot();
    canvas.panel._postedMessages.length = 0;
    const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
    await (canvas.provider as unknown as { applyDbtModels(...args: unknown[]): Promise<void> })
      .applyDbtModels(canvas.document, canvas.panel.webview, ['addresse'], ymlData(), empty);
    const errors = canvas.panel._postedMessages
      .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
      .map((m) => m.payload.message);
    expect(errors).toEqual([
      'No tables were added from dbt. "addresse" cannot be added by its name: the schema folders bqs and ccc each have a table called addresse. Add the one you mean with Add Existing Tables, which lists each by its file.',
    ]);
    expect(changed(before, snapshot())).toEqual([]);
  });

  it('Reveal in Table Library and Show on Other Diagrams… from a canvas name the member\'s own file', async () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const canvas = await open('bronze/diagrams/kunden.dbml');
    expect((await canvas.send({ type: 'revealTableInLibrary', payload: { modelName: 'ccc.addresse' } })).errors).toEqual([]);
    expect(exec).toHaveBeenCalledWith('erdStudio.revealInTableLibrary', 'addresse', at('bronze/tables/ccc/addresse.dbml'));
    expect((await canvas.send({ type: 'showTableOnOtherDiagrams', payload: { modelName: 'ccc.addresse' } })).errors).toEqual([]);
    expect(exec).toHaveBeenCalledWith(
      'erdStudio.openInDiagram',
      { type: 'model', name: 'addresse', filePath: at('bronze/tables/ccc/addresse.dbml') },
      { excludeDiagram: at('bronze/diagrams/kunden.dbml') },
    );
  });
});

describe('New Table on a JSON diagram (names alone, owner decision F)', () => {
  it('a name one schema folder already has is refused as before: the JSON diagram would read that table, not the new one', async () => {
    fs.writeFileSync(at('bronze/tables/bqs/solo.dbml'), 'Table bqs.solo {\n  id int [pk]\n}\n');
    writeJsonDiagram();
    const before = snapshot();
    const canvas = await open('bronze/legacy.json');
    const r = await canvas.send({ type: 'addModel', payload: { name: 'solo', description: '', columns: [{ name: 'id', dataType: 'int', description: '' }] } });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('Table "solo" already exists in the Table Library');
    expect(changed(before, snapshot())).toEqual([]);
  });

  it('a name no table has is still created', async () => {
    writeJsonDiagram();
    const canvas = await open('bronze/legacy.json');
    const r = await canvas.send({ type: 'addModel', payload: { name: 'fresh', description: '', columns: [{ name: 'id', dataType: 'int', description: '' }] } });
    expect(r.errors).toEqual([]);
    expect(r.changed.some((f) => f.endsWith('/fresh.dbml'))).toBe(true);
    expect(read('bronze/legacy.json')).toContain('"fresh"');
  });
});

describe('a project where no two tables share a name is left as it was', () => {
  /** Work on a copy of `fixture` (under test/fixtures) instead of the twin fixture. */
  function useFixture(fixture: string): void {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(path.resolve(__dirname, '../fixtures', fixture), root, { recursive: true });
  }

  async function contextOf(canvas: Canvas): Promise<{ tableFiles: Record<string, string> }> {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const all = canvas.panel._postedMessages.filter((m) => (m as { type: string }).type === 'canvasContext') as Array<{ payload: { tableFiles: Record<string, string> } }>;
    return all[all.length - 1].payload;
  }

  async function existingRows(canvas: Canvas): Promise<Array<[string, string]>> {
    await canvas.panel._simulateMessage({ type: 'requestExistingTables' });
    const sent = canvas.panel._postedMessages.filter((m) => (m as { type: string }).type === 'existingTables') as Array<{ payload: { existingModels: Array<{ name: string; sourcePath: string }> } }>;
    return sent[sent.length - 1].payload.existingModels.map((m) => [m.name, m.sourcePath]);
  }

  /** dbml-native with calendar.dim_date moved by hand to the schema folder calendar2; the diagram's use line still names the old path. */
  function moveDimDateToCalendar2(): void {
    useFixture('dbml-native');
    const from = at('silver/tables/calendar/dim_date.dbml');
    const text = fs.readFileSync(from, 'utf-8').replace('Table calendar.dim_date', 'Table calendar2.dim_date');
    fs.mkdirSync(at('silver/tables/calendar2'), { recursive: true });
    fs.writeFileSync(at('silver/tables/calendar2/dim_date.dbml'), text);
    fs.rmSync(from);
  }

  it('a member read through the stale-path fallback keeps its file and is not offered again by Add Existing', async () => {
    moveDimDateToCalendar2();
    const canvas = await open('gold/diagrams/sales.dbml');
    expect((await contextOf(canvas)).tableFiles.dim_date).toBe('.erd-studio/silver/tables/calendar2/dim_date.dbml');
    expect((await existingRows(canvas)).map(([name]) => name)).not.toContain('dim_date');
  });

  it('Add Existing by that file, or dropping it from the Explorer, says it is already there and writes nothing', async () => {
    moveDimDateToCalendar2();
    const canvas = await open('gold/diagrams/sales.dbml');
    const before = snapshot();
    const byFile = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'dim_date', sourcePath: '.erd-studio/silver/tables/calendar2/dim_date.dbml' } });
    expect(byFile.errors).toEqual(['Table "dim_date" already exists in this diagram.']);
    expect(changed(before, snapshot())).toEqual([]);
    const info = vi.mocked(vscode.window.showInformationMessage);
    info.mockClear();
    const dropped = await canvas.send({ type: 'dropTables', payload: { position: { x: 0, y: 0 }, uris: [pathToFileURL(at('silver/tables/calendar2/dim_date.dbml')).href] } });
    expect(dropped.errors).toEqual([]);
    expect(changed(before, snapshot())).toEqual([]);
    expect(info).toHaveBeenCalledWith('ERD Studio: "dim_date" is already on this diagram.');
  });

  it('a member whose file was moved by hand to another layer is not offered again either', async () => {
    useFixture('dbml-native');
    fs.mkdirSync(at('gold/tables/calendar'), { recursive: true });
    fs.renameSync(at('silver/tables/calendar/dim_date.dbml'), at('gold/tables/calendar/dim_date.dbml'));
    const canvas = await open('gold/diagrams/sales.dbml');
    expect((await existingRows(canvas)).map(([name]) => name)).not.toContain('dim_date');
    const before = snapshot();
    const r = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'dim_date', sourcePath: '.erd-studio/gold/tables/calendar/dim_date.dbml' } });
    expect(r.errors).toEqual(['Table "dim_date" already exists in this diagram.']);
    expect(changed(before, snapshot())).toEqual([]);
  });

  it('in a mixed project, renaming a DBML table on a DBML canvas re-spells a YAML table\'s relationship to it, as on a JSON canvas', async () => {
    useFixture('dbml-convert/mixed');
    const canvas = await open('gold/diagrams/sales.dbml');
    const r = await canvas.send({ type: 'renameModel', payload: { oldName: 'dim_customer', newName: 'dim_client' } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toContain('tables/fct_visit.yml');
    expect(read('tables/fct_visit.yml')).toContain('toTable: dim_client');
    expect(read('tables/fct_visit.yml')).not.toContain('dim_customer');
    const region = await canvas.send({ type: 'renameModel', payload: { oldName: 'dim_region', newName: 'dim_area' } });
    expect(region.errors).toEqual([]);
    expect(read('tables/fct_visit.yml')).toContain('toTable: dim_area');
    expect(read('tables/fct_visit.yml')).toContain('# Written by an AI helper set up before 2.0.');
  });

  it('a mixed diagram\'s unlinked YAML member keeps its file and is not offered by Add Existing', async () => {
    useFixture('dbml-convert/mixed');
    const canvas = await open('gold/diagrams/sales.dbml');
    expect((await contextOf(canvas)).tableFiles.fct_refund).toBe('.erd-studio/tables/gold/fct_refund.yml');
    expect((await existingRows(canvas)).map(([name]) => name)).toEqual(['fct_visit']);
  });
});
