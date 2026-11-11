/**
 * The customer's shape, end to end, with the rule flipped (a DBML table is its
 * schema folder and name): fifteen schema folders in one layer, each with an
 * `addresse` and a `kunde` of its own and a table only it has, brought in by
 * Import DBML; a diagram holding pairs opened and edited; one twin edited,
 * dragged, added beside its namesake and removed again (erd_schema_version
 * 7 → 8 → 7), renamed and deleted. `doctor` is clean after every step, and
 * the other schema folder's twin file never changes by a byte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { importDbml, type ImportDbmlDeps, type ImportDbmlUi } from '../../src/commands/importDbml';
import { runDoctor } from '../../src/cli/doctor';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { SelectorsService } from '../../src/services/selectorsService';
import type { ManifestService } from '../../src/services/manifestService';
import type { TemplateService } from '../../src/services/templateService';
import type { YmlParserService } from '../../src/services/ymlParserService';

const SCHEMAS = Array.from({ length: 15 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`);
const LAYERS = JSON.stringify({ schemaVersion: 1, layers: [{ id: 'bronze', label: 'Bronze', abbreviation: 'BR', color: '#cd7f32', creatable: true, order: 0 }] }, null, 2);

/** The source system's DBML: every schema has addresse and kunde (repeated names) and one table of its own. */
function sourceDbml(): string {
  return SCHEMAS.flatMap((s) => [
    `Table ${s}.addresse {\n  id int [pk]\n  strasse varchar\n}`,
    `Table ${s}.kunde {\n  id int [pk]\n  addresse_id int\n}`,
    `Table ${s}.only_${s} {\n  id int [pk]\n  kunde_id int\n}`,
    `Ref: ${s}.kunde.addresse_id > ${s}.addresse.id`,
    `Ref: ${s}.only_${s}.kunde_id > ${s}.kunde.id`,
  ]).join('\n\n') + '\n';
}

let tmp: string;
let root: string;
const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const read = (rel: string): string => fs.readFileSync(at(rel), 'utf-8');

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

const changed = (before: Record<string, string>, after: Record<string, string>): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]).sort();

/** doctor's findings that say the project is not clean: any error, and the duplicate and Ref problems. */
async function doctorProblems(): Promise<string[]> {
  const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: tmp });
  const bad = new Set(['duplicateTableName', 'duplicateRef', 'duplicateDeclaredTable', 'ambiguousTableReference', 'missingUse', 'missingRelationshipsUse',
    'extraRelationshipsUse', 'danglingRef', 'usePathMismatch', 'twinDiagramVersion']);
  return [
    ...r.erd.dbmlProblems.filter((p) => p.severity === 'error' || bad.has(String(p.code))).map((p) => `${p.file}: ${p.code}: ${p.message}`),
    ...r.nextSteps.filter((s) => s.id === 'fix-dbml-file').map((s) => `next step: ${s.id}`),
  ];
}

function services(): { layerService: LayerService; subjectAreaService: SubjectAreaService; tables: TableLibraryService } {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tables = new TableLibraryService(root, '.erd-studio', new OwnWriteTracker());
  subjectAreaService.setTableLibraryService(tables);
  return { layerService, subjectAreaService, tables };
}

async function importSource(): Promise<string> {
  const { layerService, subjectAreaService, tables } = services();
  const file = path.join(tmp, 'source.dbml');
  fs.writeFileSync(file, sourceDbml());
  const ui: ImportDbmlUi = {
    pickFile: async () => file,
    readFile: async (p) => fs.readFileSync(p, 'utf-8'),
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) => (items as unknown as Array<T & { id?: string }>).find((i) => i.id === 'bronze') as T | undefined,
    showInputBox: async (o) => o.value,
    confirm: async () => true,
    showInformationMessage: async () => undefined,
    showErrorMessage: async (m) => { throw new Error(`error shown: ${m}`); },
    openFileAt: async () => {}, showFile: async () => {}, openDiagram: async () => {}, addLayer: async () => {}, sendFeedback: async () => {},
  };
  const deps: ImportDbmlDeps = {
    workspaceRoot: root, semanticDir: '.erd-studio', layerService, subjectAreaService, tableLibraryService: tables,
    validateDomainName: (v) => (/^[a-z][a-z0-9_-]*$/.test(v.trim()) ? undefined : 'bad'), onWritten: () => {}, ui,
  };
  const result = await importDbml(deps, { filePath: file, layer: 'bronze', name: 'source', quick: true });
  expect(result?.domainPath).toBeDefined();
  return result!.domainPath;
}

interface Canvas {
  send(message: unknown): Promise<{ errors: string[]; changed: string[] }>;
}

/** `diagram` (relative to the semantic dir) open on a canvas, its ready load done. */
async function open(diagram: string): Promise<Canvas> {
  const { layerService, subjectAreaService, tables } = services();
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
  const document = createMockTextDocument(at(diagram), read(diagram), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
  await panel._simulateMessage({ type: 'ready' });
  return {
    send: async (message) => {
      panel._postedMessages.length = 0;
      const before = snapshot();
      await panel._simulateMessage(message);
      const errors = panel._postedMessages
        .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
        .map((m) => m.payload.message);
      return { errors, changed: changed(before, snapshot()) };
    },
  };
}

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-schema-identity-e2e-'));
  root = path.join(tmp, 'project');
  fs.mkdirSync(path.join(root, '.erd-studio'), { recursive: true });
  fs.writeFileSync(at('layers.json'), LAYERS);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async () => undefined) as never);
  vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((async () => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fifteen schema folders with repeated table names, from Import DBML to Delete Table', () => {
  it('every step acts on one schema folder\'s table, doctor stays clean, and the other twin\'s file never changes', async () => {
    // 1. Import: every table under its own name, in its own schema folder; nothing renamed {schema}_{name}.
    const imported = path.relative(path.join(root, '.erd-studio'), await importSource()).split(path.sep).join('/');
    for (const s of SCHEMAS) {
      expect(read(`bronze/tables/${s}/addresse.dbml`)).toMatch(new RegExp(`^Table ${s}\\.addresse \\{`, 'm'));
      expect(read(`bronze/tables/${s}/addresse.dbml`)).not.toContain('alias');
      expect(read(`bronze/tables/${s}/kunde.dbml`)).toMatch(new RegExp(`^Table ${s}\\.kunde \\{`, 'm'));
      expect(fs.existsSync(at(`bronze/tables/${s}/${s}_addresse.dbml`))).toBe(false);
    }
    const library = services().tables;
    expect(library.listTableFiles().filter((e) => e.shadowedBy)).toEqual([]);
    expect(library.tablesNamed('addresse')).toHaveLength(15);
    // The imported diagram holds every pair, so it says version 8.
    expect(read(imported)).toContain("erd_schema_version: '8'");
    const relationships = Object.entries(snapshot()).filter(([f]) => f.startsWith('bronze/relationships/')).map(([, t]) => t).join('\n');
    expect(relationships).toContain('Ref: s01.kunde.addresse_id >? s01.addresse.id');
    expect(relationships).toContain('Ref: s15.kunde.addresse_id >? s15.addresse.id');
    expect(await doctorProblems()).toEqual([]);
    const twin = read('bronze/tables/s02/addresse.dbml');
    const twinUntouched = (): void => expect(read('bronze/tables/s02/addresse.dbml')).toBe(twin);

    // 2. Edit one twin on the diagram holding the pairs: only its own file changes.
    const all = await open(imported);
    let r = await all.send({ type: 'addColumn', payload: { modelName: 's01.addresse', column: { name: 'ort', dataType: 'varchar', description: '' } } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual(['bronze/tables/s01/addresse.dbml']);
    twinUntouched();
    expect(await doctorProblems()).toEqual([]);

    // 3. Drag one twin: only the diagram's layout line for it.
    r = await all.send({ type: 'updatePositions', payload: { positions: { 's01.addresse': { x: 777, y: 888 } } } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual([imported]);
    expect(read(imported)).toMatch(/^\s+s01\.addresse 777 888$/m);
    twinUntouched();

    // 4. A diagram of s01's addresse alone (version 7, a bare line); add s02's beside it (8), remove it again (7).
    fs.writeFileSync(at('bronze/diagrams/single.dbml'), [
      'Project single {',
      "  erd_schema_version: '7'",
      "  erd_layout: '''",
      '    addresse 10 20',
      "  '''",
      '}',
      '',
      "use { table s01.addresse } from '../tables/s01/addresse.dbml'",
      '',
    ].join('\n'));
    const single = 'bronze/diagrams/single.dbml';
    const singleBefore = read(single);
    expect(await doctorProblems()).toEqual([]);
    const canvas = await open(single);
    r = await canvas.send({ type: 'addExistingModel', payload: { modelName: 'addresse', sourcePath: '.erd-studio/bronze/tables/s02/addresse.dbml' } });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual([single]);
    expect(read(single)).toContain("erd_schema_version: '8'");
    expect(read(single)).toMatch(/^\s+s01\.addresse 10 20$/m);
    expect(read(single)).toMatch(/^use \{ table s02\.addresse \} +from '\.\.\/tables\/s02\/addresse\.dbml'$/m);
    twinUntouched();
    expect(await doctorProblems()).toEqual([]);
    r = await canvas.send({ type: 'removeModel', payload: { modelName: 's02.addresse' } });
    expect(r.errors).toEqual([]);
    expect(read(single)).toContain("erd_schema_version: '7'");
    expect(read(single)).toMatch(/^\s+addresse 10 20$/m);
    expect(read(single)).not.toContain('s02');
    expect(read(single).split('\n').filter((l) => l.startsWith('use '))).toEqual(singleBefore.split('\n').filter((l) => l.startsWith('use ')));
    twinUntouched();
    expect(await doctorProblems()).toEqual([]);

    // 5. Rename one twin (s01's, from the canvas): its own file and Refs only.
    r = await canvas.send({ type: 'renameModel', payload: { oldName: 'addresse', newName: 'adresse2' } });
    expect(r.errors).toEqual([]);
    expect(fs.existsSync(at('bronze/tables/s01/addresse.dbml'))).toBe(false);
    expect(read('bronze/tables/s01/adresse2.dbml')).toMatch(/^Table s01\.adresse2 \{/m);
    expect(r.changed.filter((f) => f.startsWith('bronze/tables/'))).toEqual(['bronze/tables/s01/addresse.dbml', 'bronze/tables/s01/adresse2.dbml']);
    const relsAfterRename = Object.entries(snapshot()).filter(([f]) => f.startsWith('bronze/relationships/')).map(([, t]) => t).join('\n');
    expect(relsAfterRename).toContain('Ref: s01.kunde.addresse_id >? s01.adresse2.id');
    expect(relsAfterRename).toContain('Ref: s02.kunde.addresse_id >? s02.addresse.id');
    twinUntouched();
    expect(await doctorProblems()).toEqual([]);

    // 6. Delete one twin (s03's, by its identity): its file and only the Refs to it go.
    const before = snapshot();
    services().tables.deleteTable({ schema: 's03', name: 'addresse' });
    const after = snapshot();
    expect(after['bronze/tables/s03/addresse.dbml']).toBeUndefined();
    expect(after['bronze/tables/s04/addresse.dbml']).toBe(before['bronze/tables/s04/addresse.dbml']);
    const relsAfterDelete = Object.entries(after).filter(([f]) => f.startsWith('bronze/relationships/')).map(([, t]) => t).join('\n');
    expect(relsAfterDelete).not.toContain('s03.addresse');
    expect(relsAfterDelete).toContain('Ref: s04.kunde.addresse_id >? s04.addresse.id');
    twinUntouched();
    expect(await doctorProblems()).toEqual([]);
  });
});
