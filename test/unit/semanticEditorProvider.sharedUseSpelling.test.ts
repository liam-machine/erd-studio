/**
 * the reporter 2026-11-12, photo-2: "DBML has issues importing the same table
 * twice — the official diagram view only shows one adresse table".
 *
 * His diagram:
 *   use { table bqs__v_sap_prod_unit2 } from '../tables/bqs/bqs__v_sap_prod_unit2.dbml'
 *   use { table adresse } from '../tables/bqs/adresse.dbml'
 *   use { table adresse } from '../tables/ccc/adresse.dbml'
 *
 * The unqualified specifiers mean his table files declare `Table adresse`
 * (no schema): ERD Studio spells a `use` specifier exactly as the file's
 * header declares (`declaredReference`). ERD Studio reads the two files as
 * (bqs, adresse) and (ccc, adresse) by folder, but DBML reads both as
 * public.adresse, so the pinned parser refuses the second import with
 * [3003] "Table 'adresse' already exists in schema 'public'" and other DBML
 * tools draw one table.
 *
 * Up to 2.0.4 ERD Studio wrote that shape itself (Add Existing, a drop, a
 * relationships file) and read a Ref end `adresse` as the FIRST line's
 * table, so a Ref to ccc.adresse was drawn on bqs.adresse and one between
 * the two became a self-loop. Now: an edit that would write the shape asks
 * to Qualify Tables (`Table bqs.adresse`, `Table ccc.adresse`, every use line
 * and Ref re-spelled, one edit) and writes nothing on Cancel; opening a
 * diagram already in that shape says so and offers the same fix; and a Ref
 * end of a spelling two use lines share is the one of those tables that has
 * its columns, else it is not drawn (never the first line's).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { compileDbmlProject } from '@erd-studio/core/dbml';
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

let root: string;
/** Every warning shown, and what the user answers to each (a button label, or undefined for Cancel). */
let warnings: string[];
let answer: string | undefined;
const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const read = (rel: string): string => fs.readFileSync(at(rel), 'utf-8');
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};

/** Every .dbml under the semantic dir, relative path → text. */
function dbmlFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.dbml')) out[path.relative(path.join(root, '.erd-studio'), abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf-8');
    }
  };
  walk(path.join(root, '.erd-studio'));
  return out;
}

/** The pinned parser's diagnostics for `entry`, as `file:line [code] message`. */
function officialParser(entry: string): string[] {
  const r = compileDbmlProject(dbmlFiles(), [entry]);
  return Object.entries(r).flatMap(([f, ds]) => ds.map((d) => `${f}:${d.line} [${d.code}] ${d.message}`));
}

/** Every diagram and relationships file compiled with its imports by the pinned parser: [] when all compile. */
function everyFileParses(): string[] {
  return Object.keys(dbmlFiles()).filter((f) => !f.includes('/tables/')).flatMap(officialParser);
}

/** the reporter's shape: unqualified headers (photo-2's use lines) or, for the control, qualified ones. */
function reporterProject(qualified: boolean): void {
  const q = (s: string): string => (qualified ? `${s}.` : '');
  write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'bronze', label: 'Bronze', color: '#cd7f32', creatable: true, order: 1 }] }, null, 2));
  write('bronze/tables/bqs/adresse.dbml', `Table ${q('bqs')}adresse {\n  id INT [pk]\n  strasse VARCHAR\n  ort VARCHAR\n}\n`);
  write('bronze/tables/ccc/adresse.dbml', `Table ${q('ccc')}adresse {\n  adr_id INT [pk]\n  street VARCHAR\n  city VARCHAR\n  postcode VARCHAR\n}\n`);
  write('bronze/tables/bqs/bqs__v_sap_prod_unit2.dbml', `Table ${q('bqs')}bqs__v_sap_prod_unit2 {\n  unit_id INT [pk]\n  bqs_adresse_id INT\n  ccc_adresse_id INT\n}\n`);
  // The diagram before the second adresse joins.
  write('bronze/diagrams/sap.dbml', [
    'Project sap {',
    "  erd_schema_version: '7'",
    "  erd_layout: '''",
    '    bqs__v_sap_prod_unit2 40 40',
    '    adresse 400 40',
    "  '''",
    '}',
    '',
    `use { table ${q('bqs')}bqs__v_sap_prod_unit2 } from '../tables/bqs/bqs__v_sap_prod_unit2.dbml'`,
    `use { table ${q('bqs')}adresse } from '../tables/bqs/adresse.dbml'`,
    '',
  ].join('\n'));
}

/** The relationships file 2.0.4 wrote for a Ref to each adresse and one between them (two `use { table adresse }` lines). */
const WRITTEN_BY_2_0_4 = [
  '// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.',
  "use { table adresse }               from '../tables/bqs/adresse.dbml'",
  "use { table bqs__v_sap_prod_unit2 } from '../tables/bqs/bqs__v_sap_prod_unit2.dbml'",
  "use { table adresse }               from '../tables/ccc/adresse.dbml'",
  '',
  'Ref: bqs__v_sap_prod_unit2.bqs_adresse_id >? adresse.id',
  'Ref: bqs__v_sap_prod_unit2.ccc_adresse_id >? adresse.adr_id',
  'Ref: adresse.adr_id >? adresse.id',
  '',
].join('\n');

/** the reporter's project as 2.0.4 left it: both adresse on the diagram (photo-2's lines), Refs to each and between them. */
function writtenBy204(relationships = WRITTEN_BY_2_0_4): void {
  reporterProject(false);
  write('bronze/diagrams/sap.dbml', [
    'Project sap {',
    "  erd_schema_version: '8'",
    "  erd_layout: '''",
    '    bqs__v_sap_prod_unit2 40 40',
    '    bqs.adresse 400 40',
    '    ccc.adresse 400 300',
    "  '''",
    '}',
    '',
    "use { table bqs__v_sap_prod_unit2 } from '../tables/bqs/bqs__v_sap_prod_unit2.dbml'",
    "use { table adresse } from '../tables/bqs/adresse.dbml'",
    "use { table adresse } from '../tables/ccc/adresse.dbml'",
    "use * from '../relationships/bronze.dbml'",
    '',
  ].join('\n'));
  write('bronze/relationships/bronze.dbml', relationships);
}

function buildProvider(): SemanticEditorProvider {
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
    context, subjectAreaService,
    { loadManifest: async () => empty, getRelationshipTests: () => [] } as unknown as ManifestService,
    { loadYmlData: async () => empty } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService, root, selectors, tables, new OwnWriteTracker(),
  );
  provider.setLogicalOnly(true);
  return provider;
}

type Posted = {
  models: Array<{ name: string; tableName?: string; columns: Array<{ name: string }> }>;
  relationships: Array<{ fromModel: string; toModel: string }>;
  viewConfig: { positions: Record<string, unknown> };
};

async function open(diagram: string) {
  const provider = buildProvider();
  const document = createMockTextDocument(at(diagram), read(diagram), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
  await panel._simulateMessage({ type: 'ready' });
  return {
    async send(message: unknown): Promise<string[]> {
      _appliedEdits.length = 0;
      panel._postedMessages.length = 0;
      await panel._simulateMessage(message);
      return panel._postedMessages
        .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
        .map((m) => m.payload.message);
    },
    posted(): Posted {
      const loaded = panel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded') as Array<{ payload: never }>;
      return loaded[loaded.length - 1].payload;
    },
  };
}

const edgesOf = (canvas: { posted(): Posted }): string[] =>
  canvas.posted().relationships.map((r) => `${r.fromModel}>${r.toModel}`).sort();

/** The buttons the warning that contains `text` offered. */
function buttonsOf(text: string): unknown[] {
  const calls = (vscode.window.showWarningMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.find((c) => String(c[0]).includes(text))?.slice(1) ?? [];
}

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-reporter-adresse-'));
  warnings = [];
  answer = undefined;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async () => undefined) as never);
  vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((async (message: string) => {
    warnings.push(message);
    return answer;
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('reported photo-2: the shape itself', () => {
  it('the pinned DBML parser refuses photo-2 as written ([3003] on the second use line): why "the official diagram view only shows one"', () => {
    reporterProject(false);
    write('bronze/diagrams/photo2.dbml', [
      "use { table bqs__v_sap_prod_unit2 } from '../tables/bqs/bqs__v_sap_prod_unit2.dbml'",
      "use { table adresse } from '../tables/bqs/adresse.dbml'",
      "use { table adresse } from '../tables/ccc/adresse.dbml'",
      '',
    ].join('\n'));
    expect(officialParser('bronze/diagrams/photo2.dbml')).toEqual([
      "bronze/diagrams/photo2.dbml:3 [3003] Table 'adresse' already exists in schema 'public'",
    ]);
  });
});

describe('reported photo-2: reading a project 2.0.4 wrote', () => {
  it('draws each Ref on the adresse whose columns it names, never on the first use line\'s (no collapse, no self-loop)', async () => {
    writtenBy204();
    const canvas = await open('bronze/diagrams/sap.dbml');
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['bqs.adresse', 'bqs__v_sap_prod_unit2', 'ccc.adresse']);
    expect(edgesOf(canvas)).toEqual(['bqs__v_sap_prod_unit2>bqs.adresse', 'bqs__v_sap_prod_unit2>ccc.adresse', 'ccc.adresse>bqs.adresse']);
  });

  it('a Ref end whose columns neither adresse has is drawn on neither', async () => {
    writtenBy204(WRITTEN_BY_2_0_4.replace('Ref: adresse.adr_id >? adresse.id\n', 'Ref: bqs__v_sap_prod_unit2.unit_id >? adresse.nowhere\n'));
    const canvas = await open('bronze/diagrams/sap.dbml');
    expect(edgesOf(canvas)).toEqual(['bqs__v_sap_prod_unit2>bqs.adresse', 'bqs__v_sap_prod_unit2>ccc.adresse']);
  });

  it('opening the diagram says which line imports adresse twice and how to write it, and offers Qualify Tables', async () => {
    writtenBy204();
    await open('bronze/diagrams/sap.dbml');
    const said = warnings.find((w) => w.includes('imports adresse'));
    expect(said).toBeDefined();
    expect(said).toContain('bronze/diagrams/sap.dbml: Line 12 imports adresse from ../tables/ccc/adresse.dbml, as line 11 (../tables/bqs/adresse.dbml) does from another file.');
    expect(said).toContain('[3003]');
    expect(said).toContain('Table bqs.adresse');
    expect(said).toContain("use { table ccc.adresse } from '../tables/ccc/adresse.dbml'");
    expect(buttonsOf('imports adresse')).toEqual(['Qualify Tables']);
  });

  it('Qualify Tables re-spells every header, use line and Ref in one edit; every file then compiles in the pinned parser, and the canvas draws the same', async () => {
    writtenBy204();
    // Another diagram, showing only bqs's adresse: its line is re-spelled in the same edit (the settle).
    write('bronze/diagrams/bqs-only.dbml', "use { table adresse } from '../tables/bqs/adresse.dbml'\n");
    expect(everyFileParses().length).toBeGreaterThan(0);
    answer = 'Qualify Tables';
    const canvas = await open('bronze/diagrams/sap.dbml');
    await vi.waitFor(() => expect(read('bronze/tables/ccc/adresse.dbml')).toMatch(/^Table ccc\.adresse \{/m));
    expect(read('bronze/tables/bqs/adresse.dbml')).toMatch(/^Table bqs\.adresse \{/m);
    // A table no use line shares a spelling with is left as it is.
    expect(read('bronze/tables/bqs/bqs__v_sap_prod_unit2.dbml')).toMatch(/^Table bqs__v_sap_prod_unit2 \{/m);
    expect(_appliedEdits.length).toBe(1);
    const diagram = read('bronze/diagrams/sap.dbml');
    expect(diagram).toMatch(/^use \{ table bqs\.adresse \} +from '\.\.\/tables\/bqs\/adresse\.dbml'$/m);
    expect(diagram).toMatch(/^use \{ table ccc\.adresse \} +from '\.\.\/tables\/ccc\/adresse\.dbml'$/m);
    const rels = read('bronze/relationships/bronze.dbml');
    expect(rels).toContain('Ref: bqs__v_sap_prod_unit2.bqs_adresse_id >? bqs.adresse.id');
    expect(rels).toContain('Ref: bqs__v_sap_prod_unit2.ccc_adresse_id >? ccc.adresse.adr_id');
    expect(rels).toContain('Ref: ccc.adresse.adr_id >? bqs.adresse.id');
    expect(rels).not.toMatch(/use \{ table adresse \}/);
    expect(read('bronze/diagrams/bqs-only.dbml')).toMatch(/^use \{ table bqs\.adresse \} +from '\.\.\/tables\/bqs\/adresse\.dbml'$/m);
    expect(everyFileParses()).toEqual([]);
    await vi.waitFor(() => expect(edgesOf(canvas)).toEqual(['bqs__v_sap_prod_unit2>bqs.adresse', 'bqs__v_sap_prod_unit2>ccc.adresse', 'ccc.adresse>bqs.adresse']));
  });
});

describe('reported photo-2: an edit that would write the shape', () => {
  it('Add Existing of the second adresse asks first; Cancel writes nothing', async () => {
    reporterProject(false);
    const before = dbmlFiles();
    const canvas = await open('bronze/diagrams/sap.dbml');
    const errors = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'adresse', sourcePath: '.erd-studio/bronze/tables/ccc/adresse.dbml' } });
    expect(errors).toEqual([]);
    expect(warnings).toContainEqual(expect.stringContaining('bronze/tables/bqs/adresse.dbml and bronze/tables/ccc/adresse.dbml both declare Table adresse with no schema'));
    expect(buttonsOf('both declare Table adresse')).toEqual([expect.objectContaining({ modal: true }), 'Qualify Tables']);
    expect(dbmlFiles()).toEqual(before);
    expect(_appliedEdits.length).toBe(0);
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['adresse', 'bqs__v_sap_prod_unit2']);
  });

  it('Add Existing with Qualify Tables writes headers and use lines the pinned parser accepts, in one edit, and shows both tables', async () => {
    reporterProject(false);
    const canvas = await open('bronze/diagrams/sap.dbml');
    answer = 'Qualify Tables';
    const errors = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'adresse', sourcePath: '.erd-studio/bronze/tables/ccc/adresse.dbml' } });
    expect(errors).toEqual([]);
    expect(_appliedEdits.length).toBe(1);
    expect(read('bronze/tables/bqs/adresse.dbml')).toMatch(/^Table bqs\.adresse \{/m);
    expect(read('bronze/tables/ccc/adresse.dbml')).toMatch(/^Table ccc\.adresse \{/m);
    expect(read('bronze/tables/bqs/bqs__v_sap_prod_unit2.dbml')).toMatch(/^Table bqs__v_sap_prod_unit2 \{/m);
    const after = read('bronze/diagrams/sap.dbml');
    expect(after).toMatch(/^use \{ table bqs\.adresse \} +from '\.\.\/tables\/bqs\/adresse\.dbml'$/m);
    expect(after).toMatch(/^use \{ table ccc\.adresse \} +from '\.\.\/tables\/ccc\/adresse\.dbml'$/m);
    expect(officialParser('bronze/diagrams/sap.dbml')).toEqual([]);
    const shown = canvas.posted();
    expect(shown.models.map((m) => m.name).sort()).toEqual(['bqs.adresse', 'bqs__v_sap_prod_unit2', 'ccc.adresse']);
    expect(Object.keys(shown.viewConfig.positions).sort()).toEqual(['bqs.adresse', 'bqs__v_sap_prod_unit2', 'ccc.adresse']);
  });

  it('a drop of the second adresse asks the same, and with Qualify Tables writes a diagram the pinned parser accepts', async () => {
    reporterProject(false);
    const canvas = await open('bronze/diagrams/sap.dbml');
    answer = 'Qualify Tables';
    const errors = await canvas.send({ type: 'dropTables', payload: { position: { x: 600, y: 300 }, uris: [`file://${at('bronze/tables/ccc/adresse.dbml')}`] } });
    expect(errors).toEqual([]);
    expect(warnings).toContainEqual(expect.stringContaining('both declare Table adresse'));
    expect(read('bronze/diagrams/sap.dbml')).toMatch(/^use \{ table ccc\.adresse \} +from '\.\.\/tables\/ccc\/adresse\.dbml'$/m);
    expect(officialParser('bronze/diagrams/sap.dbml')).toEqual([]);
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['bqs.adresse', 'bqs__v_sap_prod_unit2', 'ccc.adresse']);
  });

  it('relationships to each adresse and between them, once qualified: written qualified, drawn on the right tables, every file compiles', async () => {
    reporterProject(false);
    const canvas = await open('bronze/diagrams/sap.dbml');
    answer = 'Qualify Tables';
    await canvas.send({ type: 'addExistingModel', payload: { modelName: 'adresse', sourcePath: '.erd-studio/bronze/tables/ccc/adresse.dbml' } });
    expect(await canvas.send({ type: 'addRelationship', payload: { fromModel: 'bqs__v_sap_prod_unit2', fromColumn: 'bqs_adresse_id', toModel: 'bqs.adresse', toColumn: 'id', cardinality: 'many-to-one' } })).toEqual([]);
    expect(await canvas.send({ type: 'addRelationship', payload: { fromModel: 'bqs__v_sap_prod_unit2', fromColumn: 'ccc_adresse_id', toModel: 'ccc.adresse', toColumn: 'adr_id', cardinality: 'many-to-one' } })).toEqual([]);
    expect(await canvas.send({ type: 'addRelationship', payload: { fromModel: 'ccc.adresse', fromColumn: 'adr_id', toModel: 'bqs.adresse', toColumn: 'id', cardinality: 'many-to-one' } })).toEqual([]);
    expect(edgesOf(canvas)).toEqual(['bqs__v_sap_prod_unit2>bqs.adresse', 'bqs__v_sap_prod_unit2>ccc.adresse', 'ccc.adresse>bqs.adresse']);
    const rels = read('bronze/relationships/bronze.dbml');
    expect(rels).toContain('Ref: ccc.adresse.adr_id >? bqs.adresse.id');
    expect(rels).not.toMatch(/use \{ table adresse \}/);
    expect(everyFileParses()).toEqual([]);
  });
});

describe('control: the same project with qualified headers (what ERD Studio writes itself)', () => {
  it('Add Existing writes qualified use lines the official parser accepts, and asks nothing', async () => {
    reporterProject(true);
    const canvas = await open('bronze/diagrams/sap.dbml');
    const errors = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'adresse', sourcePath: '.erd-studio/bronze/tables/ccc/adresse.dbml' } });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    const after = read('bronze/diagrams/sap.dbml');
    expect(after).toMatch(/^use \{ table ccc\.adresse \} +from '\.\.\/tables\/ccc\/adresse\.dbml'$/m);
    expect(officialParser('bronze/diagrams/sap.dbml')).toEqual([]);
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['bqs.adresse', 'bqs__v_sap_prod_unit2', 'ccc.adresse']);
  });
});

/*
 * The usual case (found by the Breaker): both address tables have `id`, so a
 * Ref end `adresse.id` is not decided by its columns. Before the repair,
 * Qualify Tables left the relationships file with `use { table adresse }`
 * twice and the ends bare ([4000] + [3003]), dropped the diagram's `use *`,
 * offered the same useless fix again on reopen, and a relationship drawn
 * after declining was written ambiguously with no prompt.
 */
describe('reported photo-2: both adresse tables have the Ref column', () => {
  /** Two source systems' address tables that BOTH have `id`, with a Ref to each as 2.0.4 wrote them. */
  function bothHaveId(refs = ['Ref: unit.bqs_adresse_id >? adresse.id', 'Ref: unit.ccc_adresse_id >? adresse.id']): void {
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'bronze', label: 'Bronze', color: '#cd7f32', creatable: true, order: 1 }] }, null, 2));
    write('bronze/tables/bqs/adresse.dbml', 'Table adresse {\n  id INT [pk]\n  strasse VARCHAR\n}\n');
    write('bronze/tables/ccc/adresse.dbml', 'Table adresse {\n  id INT [pk]\n  street VARCHAR\n}\n');
    write('bronze/tables/bqs/unit.dbml', 'Table unit {\n  unit_id INT [pk]\n  bqs_adresse_id INT\n  ccc_adresse_id INT\n}\n');
    write('bronze/diagrams/sap.dbml', [
      'Project sap {',
      "  erd_schema_version: '8'",
      "  erd_layout: '''",
      '    unit 40 40',
      '    bqs.adresse 400 40',
      '    ccc.adresse 400 300',
      "  '''",
      '}',
      '',
      "use { table unit } from '../tables/bqs/unit.dbml'",
      "use { table adresse } from '../tables/bqs/adresse.dbml'",
      "use { table adresse } from '../tables/ccc/adresse.dbml'",
      "use * from '../relationships/bronze.dbml'",
      '',
    ].join('\n'));
    write('bronze/relationships/bronze.dbml', [
      "use { table adresse } from '../tables/bqs/adresse.dbml'",
      "use { table unit } from '../tables/bqs/unit.dbml'",
      "use { table adresse } from '../tables/ccc/adresse.dbml'",
      '',
      ...refs,
      '',
    ].join('\n'));
  }

  /** Answer each "Which adresse does this relationship mean?" with `pick(placeHolder)`'s schema; the questions asked. */
  function answerWhichTable(pick: (placeHolder: string) => string | undefined): Array<{ title?: string; placeHolder?: string; labels: string[] }> {
    const asked: Array<{ title?: string; placeHolder?: string; labels: string[] }> = [];
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string; description?: string }>, options: { title?: string; placeHolder?: string }) => {
      asked.push({ title: options.title, placeHolder: options.placeHolder, labels: items.map((i) => `${i.label} (${i.description})`) });
      const schema = pick(options.placeHolder ?? '');
      return schema === undefined ? undefined : items.find((i) => i.label === `${schema}.adresse`);
    }) as never);
    return asked;
  }
  /** The schema a Ref's foreign-key column names: `unit.ccc_adresse_id` → ccc. */
  const bySourceColumn = (placeHolder: string): string | undefined => /Ref: unit\.(\w+?)_adresse_id/.exec(placeHolder)?.[1];

  it('opening it says how many relationships are not drawn and why; none is drawn on the wrong table', async () => {
    bothHaveId();
    const canvas = await open('bronze/diagrams/sap.dbml');
    // Fail closed: before the fix both were drawn on bqs.adresse (the first use line's).
    expect(edgesOf(canvas)).toEqual([]);
    const said = warnings.find((w) => w.includes('imports adresse'));
    expect(said).toContain('2 Ref ends spelled adresse could mean either table, so those relationships are not drawn; Qualify Tables asks you which table each means.');
    expect(buttonsOf('imports adresse')).toEqual(['Qualify Tables']);
  });

  it('Qualify Tables asks which table each Ref end means, writes the answers, and leaves every file valid DBML in one edit', async () => {
    bothHaveId();
    answer = 'Qualify Tables';
    const asked = answerWhichTable(bySourceColumn);
    const canvas = await open('bronze/diagrams/sap.dbml');
    await vi.waitFor(() => expect(read('bronze/tables/ccc/adresse.dbml')).toMatch(/^Table ccc\.adresse \{/m));
    expect(asked).toEqual([
      {
        title: 'Which adresse does this relationship mean? (1 of 2)',
        placeHolder: 'bronze/relationships/bronze.dbml line 5: Ref: unit.bqs_adresse_id >? adresse.id. Every adresse has id, so only you can say which adresse.id means.',
        labels: ['bqs.adresse (bronze/tables/bqs/adresse.dbml)', 'ccc.adresse (bronze/tables/ccc/adresse.dbml)'],
      },
      {
        title: 'Which adresse does this relationship mean? (2 of 2)',
        placeHolder: 'bronze/relationships/bronze.dbml line 6: Ref: unit.ccc_adresse_id >? adresse.id. Every adresse has id, so only you can say which adresse.id means.',
        labels: ['bqs.adresse (bronze/tables/bqs/adresse.dbml)', 'ccc.adresse (bronze/tables/ccc/adresse.dbml)'],
      },
    ]);
    expect(_appliedEdits.length).toBe(1);
    const rels = read('bronze/relationships/bronze.dbml');
    expect(rels).toContain('Ref: unit.bqs_adresse_id >? bqs.adresse.id');
    expect(rels).toContain('Ref: unit.ccc_adresse_id >? ccc.adresse.id');
    expect(rels).not.toMatch(/use \{ table adresse \}/);
    expect(read('bronze/diagrams/sap.dbml')).toContain("use * from '../relationships/bronze.dbml'");
    expect(everyFileParses()).toEqual([]);
    await vi.waitFor(() => expect(edgesOf(canvas)).toEqual(['unit>bqs.adresse', 'unit>ccc.adresse']));
  });

  it('Cancel on a "which table" question writes nothing', async () => {
    bothHaveId();
    const before = dbmlFiles();
    answer = 'Qualify Tables';
    const asked = answerWhichTable(() => undefined);
    await open('bronze/diagrams/sap.dbml');
    await vi.waitFor(() => expect(asked.length).toBe(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(_appliedEdits.length).toBe(0);
    expect(dbmlFiles()).toEqual(before);
  });

  it('a relationship drawn to ccc.adresse after declining Qualify asks first; with Qualify both Refs are written qualified and drawn', async () => {
    bothHaveId(['Ref: unit.bqs_adresse_id >? adresse.id']);
    const canvas = await open('bronze/diagrams/sap.dbml');
    // Declined on open (answer undefined). Now the user draws unit.ccc_adresse_id → ccc.adresse.id.
    warnings = [];
    answer = 'Qualify Tables';
    const asked = answerWhichTable(bySourceColumn);
    const errors = await canvas.send({ type: 'addRelationship', payload: { fromModel: 'unit', fromColumn: 'ccc_adresse_id', toModel: 'ccc.adresse', toColumn: 'id', cardinality: 'many-to-one' } });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('both declare Table adresse with no schema'))).toBe(true);
    // Only the existing Ref is asked about: the new one names its table.
    expect(asked.map((a) => a.placeHolder)).toEqual([expect.stringContaining('line 5: Ref: unit.bqs_adresse_id >? adresse.id')]);
    const rels = read('bronze/relationships/bronze.dbml');
    expect(rels).toContain('Ref: unit.bqs_adresse_id >? bqs.adresse.id');
    expect(rels).toMatch(/Ref: unit\.ccc_adresse_id >\?? ccc\.adresse\.id/);
    expect(everyFileParses()).toEqual([]);
    await vi.waitFor(() => expect(edgesOf(canvas)).toEqual(['unit>bqs.adresse', 'unit>ccc.adresse']));
  });

  /*
   * Seen in a real VS Code window (verifier, round 1): on open neither Ref is drawn, so the user draws
   * the missing line, unit.ccc_adresse_id → ccc.adresse.id, which the line 6 Ref already means. Told
   * line 6 means ccc.adresse, the two were the same link and the plan refused: "… holds the relationship
   * ccc.adresse.id → unit.ccc_adresse_id twice. Remove one of them first." and nothing was written.
   */
  it('drawing the line an undecided Ref already holds, then Qualify: one Ref, both qualified, nothing refused', async () => {
    bothHaveId();
    const canvas = await open('bronze/diagrams/sap.dbml');
    warnings = [];
    answer = 'Qualify Tables';
    const asked = answerWhichTable(bySourceColumn);
    const errors = await canvas.send({ type: 'addRelationship', payload: { fromModel: 'unit', fromColumn: 'ccc_adresse_id', toModel: 'ccc.adresse', toColumn: 'id', cardinality: 'many-to-one' } });
    expect(errors).toEqual([]);
    expect(asked.length).toBe(2);
    expect(_appliedEdits.length).toBe(1);
    const rels = read('bronze/relationships/bronze.dbml');
    expect(rels).toContain('Ref: unit.bqs_adresse_id >? bqs.adresse.id');
    expect(rels.match(/Ref: unit\.ccc_adresse_id [<>-]\?? ccc\.adresse\.id/g)?.length).toBe(1);
    expect(rels).not.toMatch(/\sadresse\.id/); // no bare (ambiguous) end left
    expect(rels).not.toMatch(/use \{ table adresse \}/);
    expect(read('bronze/diagrams/sap.dbml')).toContain("use * from '../relationships/bronze.dbml'");
    expect(everyFileParses()).toEqual([]);
    await vi.waitFor(() => expect(edgesOf(canvas)).toEqual(['unit>bqs.adresse', 'unit>ccc.adresse']));
  });

  it('drawing that line, then telling Qualify the existing Ref means the OTHER adresse: both relationships are kept', async () => {
    bothHaveId();
    const canvas = await open('bronze/diagrams/sap.dbml');
    answer = 'Qualify Tables';
    // Line 5 and line 6 both mean bqs.adresse: the drawn ccc line is then a relationship of its own.
    answerWhichTable(() => 'bqs');
    const errors = await canvas.send({ type: 'addRelationship', payload: { fromModel: 'unit', fromColumn: 'ccc_adresse_id', toModel: 'ccc.adresse', toColumn: 'id', cardinality: 'many-to-one' } });
    expect(errors).toEqual([]);
    const rels = read('bronze/relationships/bronze.dbml');
    expect(rels).toContain('Ref: unit.bqs_adresse_id >? bqs.adresse.id');
    expect(rels).toContain('Ref: unit.ccc_adresse_id >? bqs.adresse.id');
    expect(rels).toMatch(/Ref: unit\.ccc_adresse_id [<>-]\?? ccc\.adresse\.id/);
    expect(everyFileParses()).toEqual([]);
  });

  it('declining that prompt writes nothing: no ambiguous Ref is written', async () => {
    bothHaveId(['Ref: unit.bqs_adresse_id >? adresse.id']);
    const canvas = await open('bronze/diagrams/sap.dbml');
    const before = dbmlFiles();
    const errors = await canvas.send({ type: 'addRelationship', payload: { fromModel: 'unit', fromColumn: 'ccc_adresse_id', toModel: 'ccc.adresse', toColumn: 'id', cardinality: 'many-to-one' } });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('both declare Table adresse with no schema'))).toBe(true);
    expect(dbmlFiles()).toEqual(before);
  });

  it('declined: an unrelated edit of the diagram keeps its use * of the relationships file whose Refs it cannot place yet', async () => {
    bothHaveId();
    write('bronze/tables/bqs/other.dbml', 'Table other {\n  id INT [pk]\n}\n');
    const canvas = await open('bronze/diagrams/sap.dbml');
    const errors = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'other', sourcePath: '.erd-studio/bronze/tables/bqs/other.dbml' } });
    expect(errors).toEqual([]);
    const diagram = read('bronze/diagrams/sap.dbml');
    expect(diagram).toContain("use { table other } from '../tables/bqs/other.dbml'");
    // Before: dropped, as if bronze.dbml held no relationship between the diagram's tables.
    expect(diagram).toContain("use * from '../relationships/bronze.dbml'");
  });

  it('headers already qualified but use lines left bare (by hand): Qualify re-spells the lines and ends, so the fix it offers is one it makes', async () => {
    bothHaveId();
    write('bronze/tables/bqs/adresse.dbml', read('bronze/tables/bqs/adresse.dbml').replace('Table adresse', 'Table bqs.adresse'));
    write('bronze/tables/ccc/adresse.dbml', read('bronze/tables/ccc/adresse.dbml').replace('Table adresse', 'Table ccc.adresse'));
    answer = 'Qualify Tables';
    answerWhichTable(bySourceColumn);
    await open('bronze/diagrams/sap.dbml');
    await vi.waitFor(() => expect(read('bronze/relationships/bronze.dbml')).not.toMatch(/use \{ table adresse \}/));
    expect(read('bronze/relationships/bronze.dbml')).toContain('Ref: unit.ccc_adresse_id >? ccc.adresse.id');
    expect(read('bronze/diagrams/sap.dbml')).not.toMatch(/use \{ table adresse \}/);
    expect(everyFileParses()).toEqual([]);
  });
});
