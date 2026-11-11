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
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
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
