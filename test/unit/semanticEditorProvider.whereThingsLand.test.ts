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
    const place = vi.spyOn(TableLibraryService.prototype, 'newRelationshipPlacements');
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

/**
 * New Relationship's "Stored in" (DBML): two teams sharing the `gold` schema
 * keep team files (`gold/relationships/marketing.dbml` beside the layer's
 * shared `gold.dbml`). A new marketing table's first relationship would go
 * to `gold.dbml` (rules 2 and 3 cannot know the team); the dialog may pick
 * `marketing.dbml` instead, and rule 1 keeps every later one there.
 */
describe('choosing the relationships file of a new relationship', () => {
  const MARKETING = 'gold/relationships/marketing.dbml';
  const MARKETING_TEXT = '// The marketing team\'s relationships.\n';

  /** A marketing table on the sales diagram, with no relationship yet, and the team's (empty) file. */
  function marketing(): void {
    fs.writeFileSync(at('gold/tables/gold/fct_campaign.dbml'),
      'Table gold.fct_campaign {\n  campaign_id INT [pk]\n  customer_key INT\n  date_key INT\n  region_code VARCHAR\n  country_code VARCHAR\n}\n');
    fs.writeFileSync(at(MARKETING), MARKETING_TEXT);
    const diagram = at('gold/diagrams/sales.dbml');
    fs.writeFileSync(diagram, fs.readFileSync(diagram, 'utf-8')
      .replace('    fct_order 400 200\n', '    fct_campaign 400 600\n    fct_order 400 200\n')
      .replace("use { table gold.bridge_empty } from '../tables/gold/bridge_empty.dbml'\n",
        "use { table gold.bridge_empty } from '../tables/gold/bridge_empty.dbml'\nuse { table gold.fct_campaign } from '../tables/gold/fct_campaign.dbml'\n"));
  }
  const toProfile = { fromModel: 'fct_campaign', fromColumn: 'customer_key', toModel: 'customer_profile', toColumn: 'customer_key', cardinality: 'many-to-one' };
  const toDate = { fromModel: 'fct_campaign', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
  const read = (rel: string): string => fs.readFileSync(at(rel), 'utf-8');
  const choicesOf = (canvas: Awaited<ReturnType<typeof open>>) =>
    canvas.last('newRelationshipFiles')!.payload!.choices as Record<string, Array<{ path: string; projectPath: string }>>;

  it('lists each table\'s choices: the default first, then its layer\'s other relationships files', async () => {
    marketing();
    const canvas = await open();
    await canvas.send({ type: 'requestNewRelationshipFiles' });
    const { files } = canvas.last('newRelationshipFiles')!.payload! as { files: Record<string, string> };
    const choices = choicesOf(canvas);
    const paths = (name: string) => choices[name].map((c) => c.path);
    // No Ref yet, schema = layer: the layer's shared file (rule 3), then the team files.
    expect(paths('fct_campaign')).toEqual(['gold/relationships/gold.dbml', 'gold/relationships/customers.dbml', MARKETING]);
    // Rule 1 first, whatever its name.
    expect(paths('customer_profile')).toEqual(['gold/relationships/customers.dbml', 'gold/relationships/gold.dbml', MARKETING]);
    // A silver table: its own layer's files only.
    expect(paths('dim_date')).toEqual(['silver/relationships/calendar.dbml']);
    for (const [name, list] of Object.entries(choices)) {
      expect(list[0].projectPath).toBe(files[name]);
      for (const c of list) expect(c.projectPath).toBe(`.erd-studio/${c.path}`);
    }
    expect(_appliedEdits).toHaveLength(0);
  });

  it('rule 1 in another layer stays first; a relationships file that does not read is not offered', async () => {
    marketing();
    // fct_campaign's only Ref lives in silver's file; gold's customers.dbml has a merge conflict.
    fs.writeFileSync(at('silver/relationships/calendar.dbml'), `${read('silver/relationships/calendar.dbml')}`
      + "use { table gold.fct_campaign } from '../../gold/tables/gold/fct_campaign.dbml'\nRef: gold.fct_campaign.date_key > calendar.dim_date.date_key\n");
    fs.writeFileSync(at('gold/relationships/customers.dbml'), `<<<<<<< HEAD\n${read('gold/relationships/customers.dbml')}=======\n>>>>>>> other\n`);
    const canvas = await open();
    await canvas.send({ type: 'requestNewRelationshipFiles' });
    expect(choicesOf(canvas).fct_campaign.map((c) => c.path)).toEqual(['silver/relationships/calendar.dbml', 'gold/relationships/gold.dbml', MARKETING]);
  });

  it('saves the new relationship in the chosen file, with its use lines and the diagram\'s import, in one edit', async () => {
    marketing();
    const status = vi.spyOn(vscode.window, 'setStatusBarMessage');
    const gold = read('gold/relationships/gold.dbml');
    const canvas = await open();
    await canvas.send({ type: 'addRelationship', payload: { ...toProfile, relationshipsFile: MARKETING } });
    expect(canvas.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    const text = read(MARKETING);
    expect(text).toMatch(/^\/\/ The marketing team's relationships\.$/m);
    expect(text).toMatch(/^use \{ table gold\.customer_profile \} +from '\.\.\/tables\/gold\/customer_profile\.dbml'$/m);
    expect(text).toMatch(/^use \{ table gold\.fct_campaign \} +from '\.\.\/tables\/gold\/fct_campaign\.dbml'$/m);
    const lines = text.split(/\r?\n/);
    const line = lines.findIndex((l) => l.startsWith('Ref: gold.fct_campaign.customer_key >? gold.customer_profile.customer_key')) + 1;
    expect(line).toBeGreaterThan(0);
    expect(read('gold/relationships/gold.dbml')).toBe(gold);
    expect(read('gold/diagrams/sales.dbml')).toMatch(/^use \* from '\.\.\/relationships\/marketing\.dbml'$/m);
    expect(status).toHaveBeenCalledWith(relationshipSavedMessage(`.erd-studio/${MARKETING}`, line), expect.any(Number));
  });

  it('the table\'s next relationship follows it there by rule 1, with nothing chosen', async () => {
    marketing();
    const canvas = await open();
    await canvas.send({ type: 'addRelationship', payload: { ...toProfile, relationshipsFile: MARKETING } });
    await canvas.send({ type: 'requestNewRelationshipFiles' });
    expect((canvas.last('newRelationshipFiles')!.payload!.files as Record<string, string>).fct_campaign).toBe(`.erd-studio/${MARKETING}`);
    expect(choicesOf(canvas).fct_campaign[0].path).toBe(MARKETING);
    const gold = read('gold/relationships/gold.dbml');
    await canvas.send({ type: 'addRelationship', payload: toDate });
    expect(canvas.errors()).toEqual([]);
    expect(read(MARKETING)).toMatch(/^Ref: gold\.fct_campaign\.date_key >\? calendar\.dim_date\.date_key$/m);
    expect(read(MARKETING)).toMatch(/^use \{ table calendar\.dim_date \} +from '\.\.\/\.\.\/silver\/tables\/calendar\/dim_date\.dbml'$/m);
    expect(read('gold/relationships/gold.dbml')).toBe(gold);
  });

  it('a composite: every column pair lands in the chosen file, as one Ref', async () => {
    marketing();
    const canvas = await open();
    await canvas.send({
      type: 'addRelationship',
      payload: {
        fromModel: 'fct_campaign', fromColumn: 'region_code', toModel: 'dim_region', toColumn: 'region_code', cardinality: 'many-to-one',
        extraPairs: [{ fromColumn: 'country_code', toColumn: 'country_code' }], relationshipsFile: MARKETING,
      },
    });
    expect(canvas.errors()).toEqual([]);
    const refs = read(MARKETING).split(/\r?\n/).filter((l) => l.startsWith('Ref'));
    expect(refs).toEqual(['Ref: gold.fct_campaign.(region_code, country_code) >? gold.dim_region.(region_code, country_code)']);
    expect(read(MARKETING)).toMatch(/^use \{ table gold\.dim_region \} +from '\.\.\/tables\/gold\/dim_region\.dbml'$/m);
    expect(read('gold/relationships/gold.dbml')).not.toContain('fct_campaign');
  });

  it('without the field, the new relationship goes where placeNewRef says, as before', async () => {
    marketing();
    const canvas = await open();
    await canvas.send({ type: 'addRelationship', payload: toProfile });
    expect(canvas.errors()).toEqual([]);
    expect(read('gold/relationships/gold.dbml')).toMatch(/^Ref: gold\.fct_campaign\.customer_key >\? gold\.customer_profile\.customer_key$/m);
    expect(read(MARKETING)).toBe(MARKETING_TEXT);
  });

  describe('refused, with nothing written', () => {
    async function refused(payload: Record<string, unknown>, message: string, type = 'addRelationship'): Promise<void> {
      const canvas = await open();
      const before = ['gold/relationships/gold.dbml', 'gold/relationships/customers.dbml', MARKETING, 'gold/diagrams/sales.dbml'].map(read);
      await canvas.send({ type, payload });
      expect(canvas.errors()).toEqual([message]);
      expect(_appliedEdits).toHaveLength(0);
      expect(['gold/relationships/gold.dbml', 'gold/relationships/customers.dbml', MARKETING, 'gold/diagrams/sales.dbml'].map(read)).toEqual(before);
    }

    it('a path that is not a relationships file', async () => {
      marketing();
      await refused({ ...toProfile, relationshipsFile: 'gold/tables/gold/fct_order.dbml' },
        'Failed to add relationship: "gold/tables/gold/fct_order.dbml" is not a relationships file (<layer>/relationships/<name>.dbml).');
      await refused({ ...toProfile, relationshipsFile: 'gold/diagrams/sales.dbml' },
        'Failed to add relationship: "gold/diagrams/sales.dbml" is not a relationships file (<layer>/relationships/<name>.dbml).');
      await refused({ ...toProfile, relationshipsFile: 42 },
        'Failed to add relationship: the relationships file must be a path inside the project\'s ERD Studio folder.');
    });

    it('a path outside the semantic dir', async () => {
      marketing();
      await refused({ ...toProfile, relationshipsFile: '../elsewhere/relationships/x.dbml' },
        'Failed to add relationship: "../elsewhere/relationships/x.dbml" is not a path inside the project\'s ERD Studio folder.');
      await refused({ ...toProfile, relationshipsFile: 'gold/relationships/../relationships/marketing.dbml' },
        'Failed to add relationship: "gold/relationships/../relationships/marketing.dbml" is not a path inside the project\'s ERD Studio folder.');
      await refused({ ...toProfile, relationshipsFile: `${root}/.erd-studio/${MARKETING}` },
        `Failed to add relationship: "${root}/.erd-studio/${MARKETING}" is not a path inside the project's ERD Studio folder.`);
    });

    it.skipIf(process.platform === 'win32')('a relationships file that links out of the semantic dir', async () => {
      marketing();
      fs.mkdirSync(path.join(root, 'outside'), { recursive: true });
      fs.writeFileSync(path.join(root, 'outside', 'linked.dbml'), '// elsewhere\n');
      fs.symlinkSync(path.join(root, 'outside', 'linked.dbml'), at('gold/relationships/linked.dbml'));
      await refused({ ...toProfile, relationshipsFile: 'gold/relationships/linked.dbml' },
        'Failed to add relationship: .erd-studio/gold/relationships/linked.dbml is outside .erd-studio; choose a relationships file inside it.');
      expect(fs.readFileSync(path.join(root, 'outside', 'linked.dbml'), 'utf-8')).toBe('// elsewhere\n');
    });

    it('a file that does not exist', async () => {
      marketing();
      await refused({ ...toProfile, relationshipsFile: 'gold/relationships/finance.dbml' },
        'Failed to add relationship: There is no relationships file .erd-studio/gold/relationships/finance.dbml.');
    });

    it('a file that does not read', async () => {
      marketing();
      fs.writeFileSync(at(MARKETING), '<<<<<<< HEAD\nRef: gold.fct_campaign.customer_key > gold.customer_profile.customer_key\n=======\n>>>>>>> other\n');
      await refused({ ...toProfile, relationshipsFile: MARKETING },
        `Failed to add relationship: .erd-studio/${MARKETING} does not read; fix it first, or save the relationship in another file.`);
    });

    it('an edit of an existing relationship (it stays in the file that holds it)', async () => {
      marketing();
      await refused({
        originalFromModel: 'fct_order', originalFromColumn: 'customer_key', originalToModel: 'dim_customer', originalToColumn: 'customer_key',
        fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one',
        relationshipsFile: MARKETING,
      }, 'Failed to edit relationship: an existing relationship stays in the file that holds it; a relationships file can be chosen only for a new one.', 'editRelationship');
    });
  });

  it('a YAML project refuses it: there is no relationships file to choose (nor for a YAML table in a mixed one)', async () => {
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
      fs.writeFileSync(at(rel), text);
    };
    write('logical-models/dim_a.yml', 'name: dim_a\ncolumns:\n  - name: a_key\n    dataType: INT\n    isPrimaryKey: true\n');
    write('logical-models/fct_b.yml', 'name: fct_b\ncolumns:\n  - name: b_key\n    dataType: INT\n    isPrimaryKey: true\n  - name: a_key\n    dataType: INT\n');
    write('gold/s.json', `${JSON.stringify({
      schemaVersion: 5, domain: 's', layer: 'gold', description: 's',
      logical: { models: ['dim_a', 'fct_b'], relationships: [] },
      viewConfig: { positions: { dim_a: { x: 0, y: 0 }, fct_b: { x: 300, y: 0 } } },
    }, null, 2)}\n`);
    const yml = read('logical-models/fct_b.yml');
    const add = { type: 'addRelationship', payload: { fromModel: 'fct_b', fromColumn: 'a_key', toModel: 'dim_a', toColumn: 'a_key', cardinality: 'many-to-one', relationshipsFile: 'gold/relationships/gold.dbml' } };
    let canvas = await open('gold/s.json');
    await canvas.send(add);
    expect(canvas.errors()).toEqual(['Failed to add relationship: this project keeps its relationships in its YAML table files, so there is no relationships file to choose.']);
    expect(_appliedEdits).toHaveLength(0);
    expect(read('logical-models/fct_b.yml')).toBe(yml);
    // A relationships file on disk makes the project mixed; the YAML table still keeps its own relationships.
    write('gold/relationships/gold.dbml', '// not this table\'s\n');
    canvas = await open('gold/s.json');
    await canvas.send(add);
    expect(canvas.errors()).toEqual(['Failed to add relationship: fct_b is a YAML table: its relationships are kept in its own file, not a relationships file.']);
    expect(_appliedEdits).toHaveLength(0);
    expect(read('logical-models/fct_b.yml')).toBe(yml);
    expect(read('gold/relationships/gold.dbml')).toBe('// not this table\'s\n');
  });
});
