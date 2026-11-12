/**
 * REPRO (stage 1, diagnosis only; Gerhard 2026-11-12, photo-2): "DBML has
 * issues importing the same table twice — the official diagram view only
 * shows one adresse table".
 *
 * His diagram:
 *   use { table bqs__v_sap_prod_unit2 } from '../tables/bqs/bqs__v_sap_prod_unit2.dbml'
 *   use { table adresse } from '../tables/bqs/adresse.dbml'
 *   use { table adresse } from '../tables/ccc/adresse.dbml'
 *
 * The unqualified specifiers mean his table files declare `Table adresse`
 * (no schema): ERD Studio spells a `use` specifier exactly as the file's
 * header declares (`declaredReference`), and a qualified header with a bare
 * specifier is a [4000] in every parser. ERD Studio reads the two files as
 * (bqs, adresse) and (ccc, adresse) by folder, but DBML reads both as
 * public.adresse, so the pinned parser refuses the second import with
 * [3003] "Table 'adresse' already exists in schema 'public'" and other DBML
 * tools draw one table.
 *
 * Tests marked `it.fails` pin the CURRENT (buggy) behaviour the fix must
 * change; plain `it` pins what already works and must keep working.
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

/** Gerhard's shape, as his table files must declare it for photo-2's use lines (unqualified headers). */
function gerhardProject(qualified: boolean): void {
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
    posted(): { models: Array<{ name: string; tableName?: string; columns: Array<{ name: string }> }>; relationships: Array<{ fromModel: string; toModel: string }>; viewConfig: { positions: Record<string, unknown> } } {
      const loaded = panel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded') as Array<{ payload: never }>;
      return loaded[loaded.length - 1].payload;
    },
  };
}

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-gerhard-adresse-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async () => undefined) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('REPRO Gerhard photo-2: two unqualified `Table adresse` files in bqs/ and ccc/', () => {
  it('the pinned DBML parser refuses photo-2 as written ([3003] on the second use line): this is why "the official diagram view only shows one"', () => {
    gerhardProject(false);
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

  it('ERD Studio itself draws both tables, keyed bqs.adresse / ccc.adresse (works today)', async () => {
    gerhardProject(false);
    const canvas = await open('bronze/diagrams/sap.dbml');
    const errors = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'adresse', sourcePath: '.erd-studio/bronze/tables/ccc/adresse.dbml' } });
    expect(errors).toEqual([]);
    const shown = canvas.posted();
    expect(shown.models.map((m) => m.name).sort()).toEqual(['bqs.adresse', 'bqs__v_sap_prod_unit2', 'ccc.adresse']);
    expect(Object.keys(shown.viewConfig.positions).sort()).toEqual(['bqs.adresse', 'bqs__v_sap_prod_unit2', 'ccc.adresse']);
  });

  it.fails('BUG: Add Existing of the second adresse WRITES photo-2\'s ambiguous use line, which the official parser refuses', async () => {
    gerhardProject(false);
    const canvas = await open('bronze/diagrams/sap.dbml');
    await canvas.send({ type: 'addExistingModel', payload: { modelName: 'adresse', sourcePath: '.erd-studio/bronze/tables/ccc/adresse.dbml' } });
    // What it writes today (see the test below): the screenshot.
    expect(officialParser('bronze/diagrams/sap.dbml')).toEqual([]);
  });

  it('(pins today\'s write) the diagram ERD Studio writes is byte-for-byte the photo-2 shape', async () => {
    gerhardProject(false);
    const canvas = await open('bronze/diagrams/sap.dbml');
    await canvas.send({ type: 'addExistingModel', payload: { modelName: 'adresse', sourcePath: '.erd-studio/bronze/tables/ccc/adresse.dbml' } });
    const after = read('bronze/diagrams/sap.dbml');
    expect(after).toMatch(/^use \{ table adresse \} +from '\.\.\/tables\/bqs\/adresse\.dbml'$/m);
    expect(after).toMatch(/^use \{ table adresse \} +from '\.\.\/tables\/ccc\/adresse\.dbml'$/m);
    expect(after).toContain("erd_schema_version: '8'");
    expect(officialParser('bronze/diagrams/sap.dbml').join('\n')).toContain("[3003] Table 'adresse' already exists in schema 'public'");
  });

  it('a relationship to each adresse: what ERD Studio writes, and whether the official parser accepts it', async () => {
    gerhardProject(false);
    const canvas = await open('bronze/diagrams/sap.dbml');
    await canvas.send({ type: 'addExistingModel', payload: { modelName: 'adresse', sourcePath: '.erd-studio/bronze/tables/ccc/adresse.dbml' } });
    const e1 = await canvas.send({ type: 'addRelationship', payload: { fromModel: 'bqs__v_sap_prod_unit2', fromColumn: 'bqs_adresse_id', toModel: 'bqs.adresse', toColumn: 'id', cardinality: 'many-to-one' } });
    const e2 = await canvas.send({ type: 'addRelationship', payload: { fromModel: 'bqs__v_sap_prod_unit2', fromColumn: 'ccc_adresse_id', toModel: 'ccc.adresse', toColumn: 'adr_id', cardinality: 'many-to-one' } });
    const rels = Object.entries(dbmlFiles()).filter(([f]) => f.includes('/relationships/'));
    // Printed for the diagnosis; the assertions below pin what happens today.
    console.info('REPRO relationships errors', JSON.stringify({ e1, e2 }));
    for (const [f, text] of rels) console.info(`REPRO ${f}\n${text}`);
    for (const [f] of rels) console.info(`REPRO parser ${f}`, JSON.stringify(officialParser(f)));
    console.info('REPRO edges', JSON.stringify(canvas.posted().relationships.map((r) => `${r.fromModel}>${r.toModel}`)));
  });
});

describe('REPRO Gerhard photo-2: relationships and the layout input', () => {
  it.fails('BUG: once the relationships file imports both (two `use { table adresse }` lines), the Ref drawn to ccc.adresse is redrawn on bqs.adresse (silent collapse)', async () => {
    gerhardProject(false);
    const canvas = await open('bronze/diagrams/sap.dbml');
    await canvas.send({ type: 'addExistingModel', payload: { modelName: 'adresse', sourcePath: '.erd-studio/bronze/tables/ccc/adresse.dbml' } });
    await canvas.send({ type: 'addRelationship', payload: { fromModel: 'bqs__v_sap_prod_unit2', fromColumn: 'bqs_adresse_id', toModel: 'bqs.adresse', toColumn: 'id', cardinality: 'many-to-one' } });
    await canvas.send({ type: 'addRelationship', payload: { fromModel: 'bqs__v_sap_prod_unit2', fromColumn: 'ccc_adresse_id', toModel: 'ccc.adresse', toColumn: 'adr_id', cardinality: 'many-to-one' } });
    const edges = canvas.posted().relationships.map((r) => `${r.fromModel}>${r.toModel}`).sort();
    // Today: ['bqs__v_sap_prod_unit2>bqs.adresse', 'bqs__v_sap_prod_unit2>bqs.adresse'] (packages/core/src/dbmlAttach.ts useTableFor: first use line of a spelling wins).
    expect(edges).toEqual(['bqs__v_sap_prod_unit2>bqs.adresse', 'bqs__v_sap_prod_unit2>ccc.adresse']);
  });

  it('(pins today) dropping the ccc file on the canvas writes the same ambiguous use line', async () => {
    gerhardProject(false);
    const canvas = await open('bronze/diagrams/sap.dbml');
    const errors = await canvas.send({ type: 'dropTables', payload: { position: { x: 600, y: 300 }, uris: [`file://${at('bronze/tables/ccc/adresse.dbml')}`] } });
    expect(errors).toEqual([]);
    expect(read('bronze/diagrams/sap.dbml')).toMatch(/^use \{ table adresse \} +from '\.\.\/tables\/ccc\/adresse\.dbml'$/m);
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['bqs.adresse', 'bqs__v_sap_prod_unit2', 'ccc.adresse']);
  });

  it('(pins today) a relationship between the two adresse tables becomes a SELF-LOOP on bqs.adresse in the layout input', async () => {
    gerhardProject(false);
    const canvas = await open('bronze/diagrams/sap.dbml');
    await canvas.send({ type: 'addExistingModel', payload: { modelName: 'adresse', sourcePath: '.erd-studio/bronze/tables/ccc/adresse.dbml' } });
    const errors = await canvas.send({ type: 'addRelationship', payload: { fromModel: 'ccc.adresse', fromColumn: 'adr_id', toModel: 'bqs.adresse', toColumn: 'id', cardinality: 'many-to-one' } });
    const rels = Object.entries(dbmlFiles()).filter(([f]) => f.includes('/relationships/'));
    console.info('REPRO self-loop errors', JSON.stringify(errors));
    for (const [f, text] of rels) console.info(`REPRO ${f}\n${text}`);
    const edges = canvas.posted().relationships.map((r) => `${r.fromModel}>${r.toModel}`);
    console.info('REPRO self-loop edges', JSON.stringify(edges));
    expect(edges).toEqual(['bqs.adresse>bqs.adresse']);
  });
});

describe('REPRO control: the same project with qualified headers (what ERD Studio writes itself)', () => {
  it('Add Existing writes qualified use lines the official parser accepts', async () => {
    gerhardProject(true);
    const canvas = await open('bronze/diagrams/sap.dbml');
    const errors = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'adresse', sourcePath: '.erd-studio/bronze/tables/ccc/adresse.dbml' } });
    expect(errors).toEqual([]);
    const after = read('bronze/diagrams/sap.dbml');
    expect(after).toMatch(/^use \{ table ccc\.adresse \} +from '\.\.\/tables\/ccc\/adresse\.dbml'$/m);
    expect(officialParser('bronze/diagrams/sap.dbml')).toEqual([]);
    expect(canvas.posted().models.map((m) => m.name).sort()).toEqual(['bqs.adresse', 'bqs__v_sap_prod_unit2', 'ccc.adresse']);
  });
});
