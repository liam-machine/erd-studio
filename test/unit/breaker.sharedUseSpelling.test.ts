/** Breaker: attacks on the photo-2 shared-spelling fix (ba2770aa). */
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

/** Realistic: two source systems' address tables that BOTH have an `id` column. */
function overlapProject(schemaA = 'bqs', schemaB = 'ccc'): void {
  write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'bronze', label: 'Bronze', color: '#cd7f32', creatable: true, order: 1 }] }, null, 2));
  write(`bronze/tables/${schemaA}/adresse.dbml`, 'Table adresse {\n  id INT [pk]\n  strasse VARCHAR\n}\n');
  write(`bronze/tables/${schemaB}/adresse.dbml`, 'Table adresse {\n  id INT [pk]\n  street VARCHAR\n}\n');
  write('bronze/tables/bqs/unit.dbml', 'Table unit {\n  unit_id INT [pk]\n  bqs_adresse_id INT\n  ccc_adresse_id INT\n}\n');
  write('bronze/diagrams/sap.dbml', [
    'Project sap {',
    "  erd_schema_version: '8'",
    "  erd_layout: '''",
    '    unit 40 40',
    `    ${schemaA}.adresse 400 40`,
    `    ${schemaB}.adresse 400 300`,
    "  '''",
    '}',
    '',
    "use { table unit } from '../tables/bqs/unit.dbml'",
    `use { table adresse } from '../tables/${schemaA}/adresse.dbml'`,
    `use { table adresse } from '../tables/${schemaB}/adresse.dbml'`,
    "use * from '../relationships/bronze.dbml'",
    '',
  ].join('\n'));
  write('bronze/relationships/bronze.dbml', [
    `use { table adresse } from '../tables/${schemaA}/adresse.dbml'`,
    "use { table unit } from '../tables/bqs/unit.dbml'",
    `use { table adresse } from '../tables/${schemaB}/adresse.dbml'`,
    '',
    'Ref: unit.bqs_adresse_id >? adresse.id',
    'Ref: unit.ccc_adresse_id >? adresse.id',
    '',
  ].join('\n'));
}

/**
 * Answer each "Which adresse does this relationship mean?" question the way
 * the person who drew the Ref would: the table whose schema its foreign-key
 * column names (`unit.ccc_adresse_id` → ccc.adresse). Returns the questions asked.
 */
function answerWhichTable(): string[] {
  const asked: string[] = [];
  vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>, options: { placeHolder?: string }) => {
    asked.push(options.placeHolder ?? '');
    const from = /:\s*Ref:\s*\S+?\.(\w+?)_/.exec(options.placeHolder ?? '')?.[1] ?? '';
    return items.find((i) => i.label.startsWith(`${from}.`));
  }) as never);
  return asked;
}

/*
 * Breaker for ba2770aa (the reporter's photo-2). The fix decides a Ref end spelled
 * `adresse` by columns. When BOTH address tables have the column the Ref
 * names (`id`, the usual case), nothing decides it. These tests fail today.
 */
describe('breaker: shared spelling where both tables have the Ref column', () => {
  it('Qualify Tables leaves every diagram and relationships file valid for the pinned DBML parser', async () => {
    overlapProject();
    answer = 'Qualify Tables';
    // Repair: both tables have `id`, so Qualify asks which table each Ref end means (one question per end).
    const asked = answerWhichTable();
    await open('bronze/diagrams/sap.dbml');
    await vi.waitFor(() => expect(read('bronze/tables/ccc/adresse.dbml')).toMatch(/^Table ccc\.adresse/m));
    expect(asked).toHaveLength(2);
    expect(read('bronze/relationships/bronze.dbml')).toContain('Ref: unit.bqs_adresse_id >? bqs.adresse.id');
    expect(read('bronze/relationships/bronze.dbml')).toContain('Ref: unit.ccc_adresse_id >? ccc.adresse.id');
    expect(read('bronze/diagrams/sap.dbml')).toContain("use * from '../relationships/bronze.dbml'");
    // Today: the headers are qualified but the relationships file keeps `use { table adresse }` twice,
    // so it now fails with [4000] "Table 'adresse' does not exist" (plus [3003]) and the diagram's
    // `use * from '../relationships/bronze.dbml'` line is dropped.
    expect(read('bronze/relationships/bronze.dbml')).not.toMatch(/use \{ table adresse \}/);
    expect(everyFileParses()).toEqual([]);
  });

  it('after Qualify, reopening the diagram does not offer Qualify Tables again for a fix it cannot make', async () => {
    overlapProject();
    answer = 'Qualify Tables';
    answerWhichTable();
    await open('bronze/diagrams/sap.dbml');
    await vi.waitFor(() => expect(read('bronze/tables/ccc/adresse.dbml')).toMatch(/^Table ccc\.adresse/m));
    const relsAfterFirst = read('bronze/relationships/bronze.dbml');
    // Qualify also dropped the diagram's `use *` line (no Ref resolved); put it back, as the user would to see the Refs.
    write('bronze/diagrams/sap.dbml', read('bronze/diagrams/sap.dbml') + "use * from '../relationships/bronze.dbml'\n");
    warnings = [];
    _resetMockWorkspace();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    await open('bronze/diagrams/sap.dbml');
    await new Promise((r) => setTimeout(r, 300));
    // A second Qualify Tables, if offered, must change something.
    if (buttonsOf('imports adresse').includes('Qualify Tables')) expect(read('bronze/relationships/bronze.dbml')).not.toBe(relsAfterFirst);
    // Today: the same "Declare each table in its schema folder's schema (Table ccc.adresse, …)" warning
    // returns with a Qualify Tables button whose edit changes nothing in the relationships file.
  });

  it('a relationship the user draws to ccc.adresse (Qualify declined) is drawn, or the edit asks first', async () => {
    overlapProject();
    write('bronze/relationships/bronze.dbml', read('bronze/relationships/bronze.dbml').replace('Ref: unit.ccc_adresse_id >? adresse.id\n', ''));
    const canvas = await open('bronze/diagrams/sap.dbml');
    warnings = [];
    const errors = await canvas.send({ type: 'addRelationship', payload: { fromModel: 'unit', fromColumn: 'ccc_adresse_id', toModel: 'ccc.adresse', toColumn: 'id', cardinality: 'many-to-one' } });
    // Today: no error, no prompt; `Ref: unit.ccc_adresse_id >? adresse.id` is written and the new line
    // is not drawn (the shared spelling already existed, so sharedSpellingsAdded sees nothing new).
    const asked = warnings.some((w) => w.includes('both declare Table adresse'));
    const drawn = edgesOf(canvas).includes('unit>ccc.adresse');
    expect({ errors, askedOrDrawn: asked || drawn }).toEqual({ errors: [], askedOrDrawn: true });
  });
});
