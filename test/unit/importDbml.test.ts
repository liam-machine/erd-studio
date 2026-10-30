/**
 * Import DBML… (`erdStudio.importDbml`) — the command flow in
 * src/commands/importDbml.ts, driven through its injected UI with fakes over
 * a real temp project (real LayerService, SubjectAreaService and
 * TableLibraryService): the file → layer → name → dry run → write → open
 * steps, ERD Studio's own rich export (generated with `toDbmlRich` from the
 * fixture project) and DBML from other tools, the file's own `erd_layout`
 * present, absent, partial and with bad lines (a `.dbdiagram` beside the file
 * is ignored), every cancel, a file that is not
 * DBML, a name taken, the unsaved-file and refusal stops, write failures with
 * full rollback, v5 vs v6 naming projects and library vs subject-area
 * relationship storage, and its telemetry.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { toDbmlRich } from '@erd-studio/core';

import { createMockTextDocument, _resetMockWorkspace } from '../__mocks__/vscode';
import {
  ADD_LAYER_BUTTON,
  CHOOSE_ANOTHER_NAME_BUTTON,
  IMPORT_BUTTON,
  IMPORT_DBML_COMMAND,
  NO_LAYERS_MESSAGE,
  OPEN_FILE_BUTTON,
  OPEN_IT_BUTTON,
  SHOW_FILE_BUTTON,
  TRY_AGAIN_BUTTON,
  describeInvalidDbml,
  importDbml,
  type ImportDbmlDeps,
  type ImportDbmlUi,
} from '../../src/commands/importDbml';
import { NO_LEGACY_ALIAS, PRE_REGISTERED_COMMANDS } from '../../src/extension';
import type { FeedbackPrefill } from '../../src/services/commandErrors';
import { SubjectAreaService, subjectAreaTableNames } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { DuplicateKeyWriteRefused, TableLibraryService } from '../../src/services/logicalModelService';
import { buildLogicalDisplaySubjectArea } from '../../src/services/stageDisplay';
import { telemetry } from '../../src/services/telemetryService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const DBML_FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml');
const LAYERS_JSON = fs.readFileSync(path.join(FIXTURE_ROOT, '.erd-studio', 'layers.json'), 'utf-8');

/** A small foreign DBML file: two tables, an inline ref, no Project. */
const SHOP_DBML = [
  'Table customers {',
  '  id int [pk]',
  '  name varchar [not null]',
  '}',
  '',
  'Table orders {',
  '  id int [pk]',
  '  customer_id int [ref: > customers.id]',
  '}',
  '',
].join('\n');

/** SHOP_DBML with a Project whose `erd_layout` holds these lines (the rich export's shape). */
const shopWithLayout = (...lines: string[]): string =>
  `${SHOP_DBML}\nProject shop {\n  erd_layout: '''\n${lines.map((l) => `    ${l}\n`).join('')}  '''\n}\n`;

/** SHOP_DBML with both tables placed. */
const SHOP_PLACED = shopWithLayout('customers 10 20', 'orders 300.5 40');

type Pickable = vscode.QuickPickItem & { id?: string };

interface Answers {
  /** The file the Open dialog returns (undefined = cancelled). */
  file?: string;
  /** The layer id picked (undefined = Escape). */
  layer?: string;
  /** What the name box returns, in turn; absent = accept the suggestion; null = Escape. */
  names?: Array<string | null>;
  /** The dry run's answer (default: Import). */
  confirm?: boolean;
  /** The button picked on each error message, in turn (undefined = dismissed). */
  errorChoices?: Array<string | undefined>;
  /** Files whose read throws (each time, or the first `failReads` times). */
  unreadable?: string[];
  failReads?: number;
}

interface FakeUi extends ImportDbmlUi {
  dialogs: Array<string | undefined>;
  reads: string[];
  picks: Array<{ items: Pickable[]; options: vscode.QuickPickOptions }>;
  inputs: vscode.InputBoxOptions[];
  confirms: Array<{ message: string; detail: string; button: string }>;
  infos: string[];
  errors: Array<{ message: string; buttons: string[] }>;
  openedAt: Array<{ filePath: string; line?: number; column?: number }>;
  shownFiles: string[];
  openedDiagrams: string[];
  addLayers: number;
  feedback: FeedbackPrefill[];
}

function fakeUi(answers: Answers): FakeUi {
  const names = [...(answers.names ?? [])];
  const errorChoices = [...(answers.errorChoices ?? [])];
  const ui: FakeUi = {
    dialogs: [], reads: [], picks: [], inputs: [], confirms: [], infos: [], errors: [], openedAt: [], shownFiles: [],
    openedDiagrams: [], addLayers: 0, feedback: [],
    pickFile: async (defaultFolder) => { ui.dialogs.push(defaultFolder); return answers.file; },
    readFile: async (filePath) => {
      ui.reads.push(filePath);
      if (answers.unreadable?.includes(filePath) && (answers.failReads === undefined || answers.failReads-- > 0)) throw Object.assign(new Error(`EACCES: open '${filePath}'`), { code: 'EACCES' });
      return fs.readFileSync(filePath, 'utf-8');
    },
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions) => {
      ui.picks.push({ items: [...items] as Pickable[], options });
      return (items as readonly Pickable[]).find((i) => i.id === answers.layer) as T | undefined;
    },
    showInputBox: async (options) => {
      ui.inputs.push(options);
      if (names.length === 0) return options.value;
      const next = names.shift();
      return next === null ? undefined : next;
    },
    confirm: async (message, detail, button) => {
      ui.confirms.push({ message, detail, button });
      return answers.confirm ?? true;
    },
    showInformationMessage: async (message) => { ui.infos.push(message); return undefined; },
    showErrorMessage: async (message, ...items) => {
      ui.errors.push({ message, buttons: items });
      return errorChoices.shift();
    },
    openFileAt: async (filePath, line, column) => { ui.openedAt.push({ filePath, line, column }); },
    showFile: async (filePath) => { ui.shownFiles.push(filePath); },
    openDiagram: async (domainPath) => { ui.openedDiagrams.push(domainPath); },
    addLayer: async () => { ui.addLayers++; },
    sendFeedback: async (prefill) => { ui.feedback.push(prefill); },
  };
  return ui;
}

let tmp: string;
let inbox: string;
let layerService: LayerService;
let subjectAreaService: SubjectAreaService;
let lms: TableLibraryService;
let written: Array<{ domainPath: string; modelNames: string[]; changedModelNames: string[] }>;
let feature: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

const erd = (...parts: string[]) => path.join(tmp, '.erd-studio', ...parts);

/**
 * A project: `.erd-studio/layers.json` (Silver, Gold) and, for `naming: 'v5'`,
 * an empty `logical-models/` (a project with no library yet writes v6, #182).
 * `naming: 'none'` is a project with no ERD folder at all.
 */
function makeProject(naming: 'v5' | 'v6' | 'none' = 'v5'): void {
  if (naming !== 'none') {
    fs.mkdirSync(erd(), { recursive: true });
    fs.writeFileSync(erd('layers.json'), LAYERS_JSON);
  }
  if (naming === 'v5') fs.mkdirSync(erd('logical-models'), { recursive: true });
  if (naming === 'v6') {
    fs.mkdirSync(erd('tables'), { recursive: true });
    // A YAML project in the v6 naming: one v6 JSON diagram is YAML evidence (native DBML storage, §3.2); an empty project writes DBML.
    fs.mkdirSync(erd('seed'), { recursive: true });
    fs.writeFileSync(erd('seed', 'seed.json'), JSON.stringify({ schemaVersion: 6, subjectArea: 'seed', layer: 'seed', description: '', logical: { tables: [], relationships: [] }, viewConfig: {} }));
  }
  layerService = new LayerService(tmp, '.erd-studio');
  subjectAreaService = new SubjectAreaService(layerService);
  lms = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(lms);
}

function deps(ui: ImportDbmlUi, overrides: Partial<ImportDbmlDeps> = {}): ImportDbmlDeps {
  return {
    workspaceRoot: tmp,
    semanticDir: '.erd-studio',
    layerService,
    subjectAreaService,
    tableLibraryService: lms,
    validateDomainName: (value) => (/^[a-z][a-z0-9_-]*$/.test(value.trim()) ? undefined : 'Subject area name must start with a lowercase letter'),
    onWritten: (w) => { written.push(w); },
    ui,
    ...overrides,
  };
}

/** Put a DBML file in the inbox folder; returns its path. */
function dbmlFile(name: string, text: string): string {
  const file = path.join(inbox, name);
  fs.writeFileSync(file, text);
  return file;
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));
const features = () => feature.mock.calls.map((c: unknown[]) => c[0]);
const errorNames = () => error.mock.calls.map((c: unknown[]) => c[0]);

/** Every file under `.erd-studio/`, project-relative, sorted. */
function erdFiles(): string[] {
  if (!fs.existsSync(erd())) return [];
  return (fs.readdirSync(erd(), { recursive: true }) as string[])
    .filter((f) => fs.statSync(erd(f)).isFile())
    .map((f) => f.split(path.sep).join('/'))
    .sort();
}

/** The fixture project's showcase subject area as the canvas's logical stage sees it. */
function showcaseDisplay() {
  const fixtureLayers = new LayerService(FIXTURE_ROOT, '.erd-studio');
  const service = new SubjectAreaService(fixtureLayers);
  service.setTableLibraryService(new TableLibraryService(FIXTURE_ROOT, '.erd-studio'));
  const unified = service.getSubjectArea(path.join(FIXTURE_ROOT, '.erd-studio', 'silver', 'showcase.json'));
  return buildLogicalDisplaySubjectArea(SubjectAreaService.toLogicalStage(unified), unified.viewConfig, unified.stubColumns);
}

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-import-dbml-'));
  inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-import-dbml-in-'));
  written = [];
  feature = vi.spyOn(telemetry, 'feature');
  error = vi.spyOn(telemetry, 'error');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(inbox, { recursive: true, force: true });
});

describe('Import DBML — a file from another tool', () => {
  it('writes each table, a new subject area holding them, opens it, and says what it will do first', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'gold' });

    const result = await importDbml(deps(ui));

    const domainPath = erd('gold', 'shop.json');
    expect(result?.domainPath).toBe(domainPath);
    expect(ui.dialogs).toEqual([tmp]);
    // Layer, then the name, suggested from the file's name.
    expect(ui.picks[0].items.map((i) => i.id)).toEqual(['silver', 'gold']);
    expect(ui.picks[0].options.placeHolder).toBe('Which layer is this diagram for?');
    expect(ui.inputs[0].value).toBe('shop');
    expect(ui.inputs[0].prompt).toBe('Name the diagram. It is saved in the Gold layer.');
    // The dry run, before anything is written.
    expect(ui.confirms).toHaveLength(1);
    expect(ui.confirms[0].message).toBe('Import 2 tables into a new diagram "shop" in the Gold layer.');
    expect(ui.confirms[0].button).toBe(IMPORT_BUTTON);
    expect(ui.confirms[0].detail).toContain('• New: customers, orders.');
    expect(ui.confirms[0].detail).toContain('No erd_layout in the file');

    expect(lms.getTable('customers')?.columns?.map((c) => c.name)).toEqual(['id', 'name']);
    expect(lms.getTable('customers')?.columns?.[0].isPrimaryKey).toBe(true);
    const doc = readJson(domainPath);
    expect(doc).toMatchObject({ domain: 'shop', layer: 'gold', logical: { models: ['customers', 'orders'] } });
    expect(doc.description).toBe('Imported from shop.dbml.');
    // No layout: an empty viewConfig, so the canvas lays it out on first open.
    expect(doc.viewConfig).toEqual({});
    expect(ui.openedDiagrams).toEqual([domainPath]);
    expect(written).toEqual([{ domainPath, modelNames: ['customers', 'orders'], changedModelNames: [] }]);
    expect(features()).toEqual(['importDbml']);
    expect(errorNames()).toEqual([]);
  });

  it('imports the dbdiagram.io-style sample (partials, enums, composite and optional refs, schemas)', async () => {
    makeProject('v5');
    const file = path.join(inbox, 'ecommerce.dbml');
    fs.copyFileSync(path.join(DBML_FIXTURES, 'foreign', 'ecommerce.dbml'), file);
    const ui = fakeUi({ file, layer: 'silver' });

    const result = await importDbml(deps(ui));

    expect(result).toBeDefined();
    const doc = readJson(result!.domainPath);
    expect(doc.logical.models.length).toBe(result!.plan.modelNames.length);
    for (const name of result!.plan.report.newTables) expect(lms.tableExists(name)).toBe(true);
    // The Project names the subject area and describes it.
    expect(ui.inputs[0].value).toBe('ecommerce');
    expect(doc.description).toBe('Online shop: users, merchants, products and orders');
    expect(ui.confirms[0].detail).toMatch(/optional \(\?\)/);
  });

  it('suggests the layer a schema is named after, first in the list', async () => {
    makeProject('v5');
    const file = dbmlFile('g.dbml', 'Table gold.a {\n  id int [pk]\n}\n');
    const ui = fakeUi({ file, layer: 'gold' });

    await importDbml(deps(ui));

    expect(ui.picks[0].items.map((i) => [i.id, i.description])).toEqual([['gold', 'suggested by the file'], ['silver', undefined]]);
  });

  it('asks no layer when there is only one to choose', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file });
    const d = deps(ui);
    d.layerService = Object.assign(Object.create(layerService), {
      getCreatableLayers: () => [{ id: 'silver', label: 'Silver' }],
    });

    await importDbml(d);

    expect(ui.picks).toEqual([]);
    expect(fs.existsSync(erd('silver', 'shop.json'))).toBe(true);
  });

  it('uses a table the Table Library already has as it is, in the library\'s spelling, and never rewrites it', async () => {
    makeProject('v5');
    const existing = 'name: Customers\ndescription: Ours\ncolumns:\n  - name: id\n    dataType: bigint\n    description: ""\n';
    fs.writeFileSync(erd('logical-models', 'Customers.yml'), existing);
    // A subject area that keeps its relationships in the file: the import does too.
    fs.mkdirSync(erd('silver'), { recursive: true });
    fs.writeFileSync(erd('silver', 'old.json'), JSON.stringify({
      schemaVersion: 5, domain: 'old', layer: 'silver', description: '',
      logical: { models: ['Customers'], relationships: [{ fromModel: 'Customers', fromColumn: 'id', toModel: 'Customers', toColumn: 'id', cardinality: 'many-to-one' }] },
      viewConfig: {},
    }));
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver' });

    const result = await importDbml(deps(ui));

    expect(fs.readFileSync(erd('logical-models', 'Customers.yml'), 'utf-8')).toBe(existing);
    const doc = readJson(result!.domainPath);
    expect(doc.logical.models).toEqual(['Customers', 'orders']);
    expect(doc.logical.relationships).toEqual([
      expect.objectContaining({ fromModel: 'orders', fromColumn: 'customer_id', toModel: 'Customers', toColumn: 'id', cardinality: 'many-to-one' }),
    ]);
    expect(lms.getTable('orders')?.relationships ?? []).toEqual([]);
    expect(written[0].modelNames).toEqual(['orders']);
    expect(ui.confirms[0].detail).toContain('Already in your Table Library, used as they are: Customers.');
  });
});

describe('Import DBML — ERD Studio\'s own rich export', () => {
  it('round-trips the showcase subject area: every table, its relationships and its layout', async () => {
    makeProject('v5');
    const display = showcaseDisplay();
    const file = dbmlFile('showcase.dbml', toDbmlRich(display));
    const ui = fakeUi({ file, layer: 'silver', names: ['showcase-copy'] });

    const result = await importDbml(deps(ui));

    expect(result).toBeDefined();
    // One file: the positions are in its own Project.
    expect(ui.reads).toEqual([file]);
    expect(result).not.toHaveProperty('layoutPath');
    // The file's TableGroup names the layer: offered first.
    expect(ui.picks[0].items[0]).toMatchObject({ id: 'silver', description: 'suggested by the file' });
    const names = display.models.map((m) => m.name);
    const doc = readJson(result!.domainPath);
    expect(doc.logical.models).toEqual(names);
    for (const name of names) expect(lms.tableExists(name)).toBe(true);
    // Every position the showcase has comes back, at the same place.
    const positions = readJson(path.join(FIXTURE_ROOT, '.erd-studio', 'silver', 'showcase.json')).viewConfig.positions;
    expect(doc.viewConfig.positions).toEqual(positions);
    expect(ui.confirms[0].detail).toContain("Layout: every table placed from the file's erd_layout.");
    // erd_layout is read, not left out as a project setting.
    expect(ui.confirms[0].detail).not.toContain('erd_layout (');
    // A new library keeps relationships in the tables' files.
    const libraryLinks = names.flatMap((n) => lms.getTable(n)?.relationships ?? []);
    expect(libraryLinks.length).toBe(result!.plan.report.relationships);
    expect(doc.logical.relationships).toEqual([]);
    expect(features()).toEqual(['importDbml', 'importDbmlLayout']);
  });

  it('imports the hand-written rich fixture with its layout', async () => {
    makeProject('v5');
    const file = path.join(inbox, 'sales.dbml');
    fs.copyFileSync(path.join(DBML_FIXTURES, 'erd-studio', 'sales.dbml'), file);
    const ui = fakeUi({ file, layer: 'gold' });

    const result = await importDbml(deps(ui));

    expect(result).toBeDefined();
    expect(ui.inputs[0].value).toBe('sales');
    expect(lms.getTable('fct_order')).toMatchObject({ grain: 'One row per order line', alias: 'orders' });
    expect(readJson(result!.domainPath).viewConfig.positions).toMatchObject({ fct_order: { x: 400, y: 120 }, dim_passport: { x: -320, y: 40.5 } });
    expect(features()).toContain('importDbmlLayout');
  });

  it('a layout that places only some tables: places those, and says the rest are placed when it opens', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', shopWithLayout('customers 10 20'));
    const ui = fakeUi({ file, layer: 'silver' });

    const result = await importDbml(deps(ui));

    expect(readJson(result!.domainPath).viewConfig.positions).toEqual({ customers: { x: 10, y: 20 } });
    expect(ui.confirms[0].detail).toContain("Layout: 1 of 2 tables placed from the file's erd_layout; the rest are placed when it opens.");
    expect(features()).toEqual(['importDbml', 'importDbmlLayout']);
  });

  it('a full layout: places every table', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_PLACED);
    const ui = fakeUi({ file, layer: 'silver' });

    const result = await importDbml(deps(ui));

    expect(readJson(result!.domainPath).viewConfig.positions).toEqual({ customers: { x: 10, y: 20 }, orders: { x: 300.5, y: 40 } });
  });

  it('erd_layout lines it cannot read do not stop the import: says so in the dry run, and places the rest', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', shopWithLayout('customers 10 20', 'orders here'));
    const ui = fakeUi({ file, layer: 'silver' });

    const result = await importDbml(deps(ui));

    expect(readJson(result!.domainPath).viewConfig.positions).toEqual({ customers: { x: 10, y: 20 } });
    expect(ui.confirms[0].detail).toMatch(/\n• Line \d+ of the file is not <name> <x> <y> in erd_layout; that table is placed when the diagram opens\.\n/);
    // The file had an erd_layout, so the import counts it.
    expect(features()).toEqual(['importDbml', 'importDbmlLayout']);
  });

  it('a sibling .dbdiagram is ignored: only the file itself is read', async () => {
    makeProject('v5');
    // A temp copy of the pulled file, with a layout file beside it as `dbdiagram pull` writes one.
    const file = path.join(inbox, 'silver.dbml');
    fs.copyFileSync(path.join(DBML_FIXTURES, 'dbdiagram-pull', 'silver.dbml'), file);
    fs.writeFileSync(path.join(inbox, 'silver.dbdiagram'), JSON.stringify({
      version: '3.0.0',
      defaultView: { tablePositions: [{ name: 'dim_task', schemaName: 'silver', x: 1, y: 2 }], stickyNoteLayouts: [] },
    }));
    const ui = fakeUi({ file, layer: 'silver' });

    const result = await importDbml(deps(ui));

    expect(result).toBeDefined();
    expect(ui.reads).toEqual([file]);
    expect(readJson(result!.domainPath).viewConfig.positions).toBeUndefined();
    expect(ui.confirms[0].detail).toContain('No erd_layout in the file');
    expect(features()).toEqual(['importDbml']);
  });
});

describe('Import DBML — a file it cannot import', () => {
  it('not valid DBML: names the problems by line, offers Open File at the first, counts importDbmlInvalid, writes nothing', async () => {
    makeProject('v5');
    const file = dbmlFile('broken.dbml', 'Table a {\n  id int [pk]\n\nTable b {\n  id int\n}\n');
    const ui = fakeUi({ file, errorChoices: [OPEN_FILE_BUTTON] });

    await expect(importDbml(deps(ui))).resolves.toBeUndefined();

    expect(ui.errors).toHaveLength(1);
    expect(ui.errors[0].message).toMatch(/^Import DBML: broken\.dbml isn't valid DBML, so nothing was imported\. Line \d+: /);
    expect(ui.errors[0].buttons).toEqual([OPEN_FILE_BUTTON]);
    await vi.waitFor(() => expect(ui.openedAt).toHaveLength(1));
    expect(ui.openedAt[0].filePath).toBe(file);
    expect(ui.openedAt[0].line).toBeGreaterThan(0);
    expect(ui.picks).toEqual([]);
    expect(features()).toEqual(['importDbmlInvalid']);
    expect(errorNames()).toEqual([]);
    expect(erdFiles()).toEqual(['layers.json']);
  });

  it('a file with no tables: says there is nothing to import', async () => {
    makeProject('v5');
    const file = dbmlFile('empty.dbml', "Project empty {\n  Note: 'Nothing here'\n}\n");
    const ui = fakeUi({ file });

    await expect(importDbml(deps(ui))).resolves.toBeUndefined();

    expect(ui.infos).toEqual(['Import DBML: empty.dbml has no tables, so there is nothing to import.']);
    expect(ui.picks).toEqual([]);
    expect(erdFiles()).toEqual(['layers.json']);
  });

  it('a file it cannot read: says so, and Try Again reads it again', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver', unreadable: [file], failReads: 1, errorChoices: [TRY_AGAIN_BUTTON] });

    await expect(importDbml(deps(ui))).resolves.toBeUndefined();
    expect(ui.errors[0]).toEqual({
      message: "Import DBML couldn't read shop.dbml. Check that the file still exists and that you can open it, then try again.",
      buttons: [TRY_AGAIN_BUTTON],
    });

    await vi.waitFor(() => expect(fs.existsSync(erd('silver', 'shop.json'))).toBe(true));
    // Try Again does not ask for the file again.
    expect(ui.dialogs).toHaveLength(1);
  });
});

describe('Import DBML — cancelling', () => {
  it.each([
    ['the file', { file: undefined }],
    ['the layer', { layer: undefined }],
    ['the name', { layer: 'silver', names: [null] }],
    ['the dry run', { layer: 'silver', confirm: false }],
  ] as Array<[string, Partial<Answers>]>)('at %s: writes nothing and counts importDbmlCancelled', async (_step, answers) => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, ...answers });

    await expect(importDbml(deps(ui))).resolves.toBeUndefined();

    expect(features()).toEqual(['importDbmlCancelled']);
    expect(erdFiles()).toEqual(['layers.json']);
    expect(lms.tableExists('customers')).toBe(false);
    expect(ui.openedDiagrams).toEqual([]);
    expect(written).toEqual([]);
  });
});

describe('Import DBML — the name', () => {
  it('checks the name with the rule New Subject Area uses, in the chosen layer', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'gold' });
    const validate = vi.fn((value: string, _layer: string) => (value === 'Bad' ? 'Not that one' : undefined));

    await importDbml(deps(ui, { validateDomainName: validate }));

    expect(ui.inputs[0].validateInput!('Bad')).toBe('Not that one');
    expect(validate).toHaveBeenLastCalledWith('Bad', 'gold');
  });

  it('suggests a name not already used in the layer', async () => {
    makeProject('v5');
    fs.mkdirSync(erd('silver'), { recursive: true });
    fs.writeFileSync(erd('silver', 'shop.json'), JSON.stringify({ schemaVersion: 5, domain: 'shop', layer: 'silver', description: '', logical: { models: [], relationships: [] }, viewConfig: {} }));
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver' });

    await importDbml(deps(ui));

    expect(ui.inputs[0].value).toBe('shop-2');
    expect(fs.existsSync(erd('silver', 'shop-2.json'))).toBe(true);
  });

  it('a diagram that appeared under the chosen name: Open It, or Choose Another Name keeps the file and layer', async () => {
    makeProject('v5');
    fs.mkdirSync(erd('silver'), { recursive: true });
    fs.writeFileSync(erd('silver', 'shop.json'), '{}');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver', names: ['shop', 'shop-copy'], errorChoices: [CHOOSE_ANOTHER_NAME_BUTTON] });

    await expect(importDbml(deps(ui))).resolves.toBeUndefined();

    expect(ui.errors[0]).toEqual({
      message: 'A diagram named "shop" already exists in the Silver layer.',
      buttons: [OPEN_IT_BUTTON, CHOOSE_ANOTHER_NAME_BUTTON],
    });
    await vi.waitFor(() => expect(fs.existsSync(erd('silver', 'shop-copy.json'))).toBe(true));
    expect(fs.readFileSync(erd('silver', 'shop.json'), 'utf-8')).toBe('{}');
    expect(ui.dialogs).toHaveLength(1);
    expect(ui.picks).toHaveLength(1);
  });

  it('Open It opens the diagram already there', async () => {
    makeProject('v5');
    fs.mkdirSync(erd('silver'), { recursive: true });
    fs.writeFileSync(erd('silver', 'shop.json'), '{}');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver', names: ['shop'], errorChoices: [OPEN_IT_BUTTON] });

    await importDbml(deps(ui));

    await vi.waitFor(() => expect(ui.openedDiagrams).toEqual([erd('silver', 'shop.json')]));
    expect(lms.tableExists('customers')).toBe(false);
  });

  it('a name taken between the check and the write (the exclusive create fails): offers another name, leaves nothing', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver' });
    const save = lms.saveTable.bind(lms);
    vi.spyOn(lms, 'saveTable').mockImplementation((table, folder) => {
      save(table, folder);
      // Another window writes the diagram just before ours.
      if (!fs.existsSync(erd('silver', 'shop.json'))) fs.writeFileSync(erd('silver', 'shop.json'), '{}');
    });

    await expect(importDbml(deps(ui))).resolves.toBeUndefined();

    expect(ui.errors[0].message).toBe('A diagram named "shop" already exists in the Silver layer.');
    expect(lms.tableExists('customers')).toBe(false);
    expect(lms.tableExists('orders')).toBe(false);
    expect(fs.readFileSync(erd('silver', 'shop.json'), 'utf-8')).toBe('{}');
    expect(errorNames()).toEqual([]);
  });
});

describe('Import DBML — the project\'s naming', () => {
  it('a v5 project with a flat library: table files at the top of logical-models/, the subject area under the v5 keys', async () => {
    makeProject('v5');
    fs.writeFileSync(erd('logical-models', 'dim_x.yml'), 'name: dim_x\ncolumns:\n  - name: id\n    dataType: int\n    description: ""\n');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver' });
    const result = await importDbml(deps(ui));

    expect(fs.existsSync(erd('logical-models', 'customers.yml'))).toBe(true);
    const doc = readJson(result!.domainPath);
    expect(doc.logical.models).toEqual(['customers', 'orders']);
    expect(doc.logical.tables).toBeUndefined();
    expect(doc.domain).toBe('shop');
  });

  it('a v6 project: table files in tables/, the subject area in the v6 naming', async () => {
    makeProject('v6');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver' });
    const result = await importDbml(deps(ui));

    // An empty library is grouped by layer from its first file.
    expect(erdFiles()).toEqual(['layers.json', 'seed/seed.json', 'silver/shop.json', 'tables/silver/customers.yml', 'tables/silver/orders.yml']);
    const doc = readJson(result!.domainPath);
    expect(doc.logical.tables).toEqual(['customers', 'orders']);
    expect(doc.logical.models).toBeUndefined();
    expect(doc.subjectArea).toBe('shop');
    // It reads back as the same subject area.
    expect(subjectAreaService.getSubjectArea(result!.domainPath).logical.models.map((m) => m.name)).toEqual(['customers', 'orders']);
  });

  it('a project with no ERD folder: writes layers.json, then the tables and the subject area', async () => {
    makeProject('none');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver' });
    const result = await importDbml(deps(ui));

    expect(result).toBeDefined();
    // A new project stores its model as DBML (native DBML storage, §3.2): the relationship in its folder's relationships file.
    expect(erdFiles()).toEqual(['layers.json', 'silver/shop.dbml', 'tables/silver/_relationships.dbml', 'tables/silver/customers.dbml', 'tables/silver/orders.dbml']);
    expect(subjectAreaTableNames(fs.readFileSync(result!.domainPath, 'utf-8'), result!.domainPath)).toEqual(['customers', 'orders']);
  });

  it('an empty v5 library: grouped by layer from its first file', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    await importDbml(deps(fakeUi({ file, layer: 'gold' })));

    expect(erdFiles()).toEqual(['gold/shop.json', 'layers.json', 'logical-models/gold/customers.yml', 'logical-models/gold/orders.yml']);
  });

  it('a library grouped by layer folder: new tables go in the chosen layer\'s folder', async () => {
    makeProject('v5');
    fs.mkdirSync(erd('logical-models', 'gold'), { recursive: true });
    fs.writeFileSync(erd('logical-models', 'gold', 'dim_x.yml'), 'name: dim_x\ncolumns:\n  - name: id\n    dataType: int\n    description: ""\n');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    await importDbml(deps(fakeUi({ file, layer: 'silver' })));

    expect(fs.existsSync(erd('logical-models', 'silver', 'customers.yml'))).toBe(true);
    expect(fs.existsSync(erd('logical-models', 'silver', 'orders.yml'))).toBe(true);
  });
});

describe('Import DBML — where relationships go', () => {
  it('a project that keeps them in the tables\' files: on the FK table\'s file, none in the subject area', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const result = await importDbml(deps(fakeUi({ file, layer: 'silver' })));

    expect(lms.getTable('orders')?.relationships).toEqual([
      expect.objectContaining({ fromColumn: 'customer_id', toModel: 'customers', toColumn: 'id', cardinality: 'many-to-one' }),
    ]);
    expect(readJson(result!.domainPath).logical.relationships).toEqual([]);
  });

  it('a library that holds DBML keeps them in the library, even when a diagram file holds some (native DBML, §5.1)', async () => {
    makeProject('v6');
    fs.writeFileSync(erd('tables', 'dim_other.dbml'), 'Table dim_other {\n  id INT [pk]\n}\n');
    fs.mkdirSync(erd('silver'), { recursive: true });
    fs.writeFileSync(erd('silver', 'legacy.json'), `${JSON.stringify({
      schemaVersion: 5, domain: 'legacy', layer: 'silver',
      logical: { models: ['a', 'b'], relationships: [{ fromModel: 'a', fromColumn: 'b_id', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one' }] },
      viewConfig: {},
    }, null, 2)}\n`);
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const result = await importDbml(deps(fakeUi({ file, layer: 'gold' })));

    // A mixed project writes new files as DBML (§3.2): a DBML diagram holds no relationships (D5).
    expect(result!.domainPath.endsWith('.dbml')).toBe(true);
    expect(lms.getTable('orders')?.relationships).toEqual([
      expect.objectContaining({ fromColumn: 'customer_id', toModel: 'customers', toColumn: 'id', cardinality: 'many-to-one' }),
    ]);
  });

  it('adds the relationship to an existing library table, after the subject area is written', async () => {
    makeProject('v5');
    const ordersYml = 'name: orders\ncolumns:\n  - name: id\n    dataType: int\n    description: ""\n  - name: customer_id\n    dataType: int\n    description: ""\n';
    fs.writeFileSync(erd('logical-models', 'orders.yml'), ordersYml);
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver' });

    const result = await importDbml(deps(ui));

    expect(result!.plan.changedLibraryTables.map((t) => t.name)).toEqual(['orders']);
    expect(lms.getTable('orders')?.relationships).toEqual([
      expect.objectContaining({ fromColumn: 'customer_id', toModel: 'customers', toColumn: 'id' }),
    ]);
    // Only the new table is reported as written; the library file was edited in place.
    expect(fs.readFileSync(erd('logical-models', 'orders.yml'), 'utf-8').startsWith(ordersYml.trimEnd().split('\n')[0])).toBe(true);
    expect(written[0].modelNames).toEqual(['customers']);
    // The changed library file is handed on too: its write was an own write,
    // so open diagrams showing orders are refreshed from here, not the watcher.
    expect(written[0].changedModelNames).toEqual(['orders']);
  });

  it('a file whose tables are all in the library already: reports the changed library tables to refresh', async () => {
    makeProject('v5');
    fs.writeFileSync(erd('logical-models', 'customers.yml'), 'name: customers\ncolumns:\n  - name: id\n    dataType: int\n    description: ""\n');
    fs.writeFileSync(erd('logical-models', 'orders.yml'), 'name: orders\ncolumns:\n  - name: id\n    dataType: int\n    description: ""\n  - name: customer_id\n    dataType: int\n    description: ""\n');
    const file = dbmlFile('shop.dbml', SHOP_DBML);

    const result = await importDbml(deps(fakeUi({ file, layer: 'silver' })));

    expect(result!.plan.newTables).toEqual([]);
    expect(lms.getTable('orders')?.relationships).toEqual([
      expect.objectContaining({ fromColumn: 'customer_id', toModel: 'customers', toColumn: 'id' }),
    ]);
    expect(written).toEqual([{ domainPath: result!.domainPath, modelNames: [], changedModelNames: ['orders'] }]);
  });

  it('refuses, naming the file, when a library file it would change is open with unsaved edits, and writes nothing', async () => {
    makeProject('v5');
    const ordersYml = 'name: orders\ncolumns:\n  - name: customer_id\n    dataType: int\n    description: ""\n';
    const ordersPath = erd('logical-models', 'orders.yml');
    fs.writeFileSync(ordersPath, ordersYml);
    const tab = createMockTextDocument(ordersPath, ordersYml);
    tab._setText(`${ordersYml}# unsaved\n`);
    (vscode.workspace.textDocuments as unknown[]).push(tab);
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver', errorChoices: [SHOW_FILE_BUTTON] });

    await expect(importDbml(deps(ui))).resolves.toBeUndefined();

    expect(ui.errors[0]).toEqual({
      message: 'Import DBML: logical-models/orders.yml has unsaved changes. Save or revert it, then try again. Nothing was changed.',
      buttons: [SHOW_FILE_BUTTON],
    });
    await vi.waitFor(() => expect(ui.shownFiles).toEqual([ordersPath]));
    expect(ui.confirms).toEqual([]);
    expect(fs.readFileSync(ordersPath, 'utf-8')).toBe(ordersYml);
    expect(lms.tableExists('customers')).toBe(false);
  });

  it('a library file that may not be written: keeps the refusal\'s words, opens the file at its line', async () => {
    makeProject('v5');
    const ordersPath = erd('logical-models', 'orders.yml');
    fs.writeFileSync(ordersPath, 'name: orders\ncolumns:\n  - name: customer_id\n    dataType: int\n    description: ""\n');
    vi.spyOn(lms, 'serializeTable').mockImplementation(() => {
      throw new DuplicateKeyWriteRefused('orders.yml, line 2: "columns" is written twice in one block.', { filePath: ordersPath, line: 2 });
    });
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver', errorChoices: [OPEN_FILE_BUTTON] });

    await expect(importDbml(deps(ui))).resolves.toBeUndefined();

    expect(ui.errors[0]).toEqual({
      message: 'Import DBML: orders.yml, line 2: "columns" is written twice in one block. Nothing was changed.',
      buttons: [OPEN_FILE_BUTTON],
    });
    await vi.waitFor(() => expect(ui.openedAt).toEqual([{ filePath: ordersPath, line: 2, column: undefined }]));
    expect(errorNames()).toEqual([]);
    expect(lms.tableExists('customers')).toBe(false);
  });
});

describe('Import DBML — a write that fails', () => {
  const fsError = (code: string, file: string) =>
    Object.assign(new Error(`${code}: failed, open '${file}'`), { code, path: file });

  it('an unknown error is ours: Send Feedback (redacted) and Try Again, counted importDbmlFailed, nothing left behind', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver', errorChoices: ['Send Feedback'] });
    const save = lms.saveTable.bind(lms);
    vi.spyOn(lms, 'saveTable').mockImplementation((table, folder) => {
      if (table.name === 'orders') throw new Error(`something odd in ${tmp}`);
      save(table, folder);
    });

    await expect(importDbml(deps(ui))).resolves.toBeUndefined();

    expect(ui.errors).toEqual([{
      message: "Import DBML hit a problem in ERD Studio while saving the diagram, so nothing was changed. This isn't something you did. Please send us a report.",
      buttons: ['Send Feedback', TRY_AGAIN_BUTTON],
    }]);
    await vi.waitFor(() => expect(ui.feedback).toHaveLength(1));
    expect(ui.feedback[0].description).toContain('something odd');
    expect(ui.feedback[0].description).not.toContain(tmp);
    expect(lms.tableExists('customers')).toBe(false);
    expect(lms.tableExists('orders')).toBe(false);
    expect(fs.existsSync(erd('silver', 'shop.json'))).toBe(false);
    expect(fs.existsSync(erd('silver'))).toBe(false);
    expect(errorNames()).toEqual(['importDbmlFailed']);
    expect(features()).not.toContain('importDbml');
    expect(written).toEqual([]);
  });

  it('EACCES: names the folder project-relative and offers Try Again, which resumes at the name', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver', names: ['shop', 'shop'], errorChoices: [TRY_AGAIN_BUTTON] });
    let failures = 1;
    const save = lms.saveTable.bind(lms);
    vi.spyOn(lms, 'saveTable').mockImplementation((table, folder) => {
      if (failures-- > 0) throw fsError('EACCES', erd('logical-models', `${table.name}.yml.123.tmp`));
      save(table, folder);
    });

    await expect(importDbml(deps(ui))).resolves.toBeUndefined();

    expect(ui.errors[0]).toEqual({
      message: "Import DBML couldn't save the diagram: ERD Studio isn't allowed to write to .erd-studio/logical-models/. " +
        "Check the folder's permissions, then try again. Nothing was changed.",
      buttons: [TRY_AGAIN_BUTTON],
    });
    expect(ui.errors[0].message).not.toContain(tmp);
    await vi.waitFor(() => expect(fs.existsSync(erd('silver', 'shop.json'))).toBe(true));
    // Try Again kept the file and the layer, and offered the same name.
    expect(ui.dialogs).toHaveLength(1);
    expect(ui.picks).toHaveLength(1);
    expect(ui.inputs[1].value).toBe('shop');
  });

  it('ENOSPC: says the disk is full', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver' });
    vi.spyOn(lms, 'saveTable').mockImplementation(() => { throw fsError('ENOSPC', erd('x')); });

    await importDbml(deps(ui));

    expect(ui.errors[0].message).toBe(
      "Import DBML couldn't save the diagram: the disk is full. Free up some space, then try again. Nothing was changed.",
    );
  });

  it('a library file that fails after the subject area is written: the subject area is removed and the file put back', async () => {
    makeProject('v5');
    const ordersYml = 'name: orders\ncolumns:\n  - name: customer_id\n    dataType: int\n    description: ""\n';
    const ordersPath = erd('logical-models', 'orders.yml');
    fs.writeFileSync(ordersPath, ordersYml);
    const save = lms.saveTable.bind(lms);
    vi.spyOn(lms, 'saveTable').mockImplementation((table, folder) => {
      save(table, folder);
      if (table.name === 'orders') throw fsError('EACCES', ordersPath);
    });
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver' });

    await importDbml(deps(ui));

    expect(fs.existsSync(erd('silver', 'shop.json'))).toBe(false);
    expect(lms.tableExists('customers')).toBe(false);
    expect(fs.readFileSync(ordersPath, 'utf-8')).toBe(ordersYml);
    expect(ui.errors[0].message).toMatch(/Nothing was changed\.$/);
  });

  it('a project with no ERD folder: a failed import also removes the folder it created', async () => {
    makeProject('none');
    // A new project writes DBML (§3.2): the write's own plan fails (the first plan is the pre-write check).
    const plan = lms.planTableWrites.bind(lms);
    vi.spyOn(lms, 'planTableWrites').mockImplementationOnce(plan).mockImplementation(() => { throw fsError('ENOSPC', erd('x')); });
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver' });

    await importDbml(deps(ui));

    expect(fs.existsSync(erd())).toBe(false);
    expect(ui.errors[0].message).toMatch(/Nothing was changed\.$/);
  });

  it('a library it cannot read to plan the import: ours, nothing written, Try Again', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver' });
    vi.spyOn(lms, 'listTables').mockImplementation(() => { throw new Error('EIO: scandir'); });

    await expect(importDbml(deps(ui))).resolves.toBeUndefined();

    expect(ui.errors).toEqual([{
      message: "Import DBML hit a problem in ERD Studio while preparing the import, so nothing was changed. This isn't something you did. Please send us a report.",
      buttons: ['Send Feedback', TRY_AGAIN_BUTTON],
    }]);
    expect(ui.confirms).toEqual([]);
    expect(errorNames()).toEqual(['importDbmlFailed']);
    expect(erdFiles()).toEqual(['layers.json']);
  });

  it('a throw it did not expect is counted and rethrown', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, layer: 'silver' });
    ui.showInputBox = async () => { throw new Error('boom'); };

    await expect(importDbml(deps(ui))).rejects.toThrow('boom');
    expect(errorNames()).toEqual(['importDbmlFailed']);
  });
});

describe('Import DBML — no layers', () => {
  it('says to add one, and Add Layer runs it', async () => {
    makeProject('v5');
    const file = dbmlFile('shop.dbml', SHOP_DBML);
    const ui = fakeUi({ file, errorChoices: [ADD_LAYER_BUTTON] });
    const d = deps(ui);
    d.layerService = Object.assign(Object.create(layerService), { getCreatableLayers: () => [] });

    await expect(importDbml(d)).resolves.toBeUndefined();

    expect(ui.errors).toEqual([{ message: NO_LAYERS_MESSAGE, buttons: [ADD_LAYER_BUTTON] }]);
    await vi.waitFor(() => expect(ui.addLayers).toBe(1));
    expect(erdFiles()).toEqual(['layers.json']);
  });
});

describe('Import DBML — helpers', () => {
  it('names three problems by line and counts the rest', () => {
    const d = (line: number, message: string) => ({ line, column: 1, message });
    expect(describeInvalidDbml('a.dbml', [d(2, 'Expected }'), d(4, 'Unknown column.'), d(9, 'x'), d(10, 'y'), d(11, 'z')])).toBe(
      "Import DBML: a.dbml isn't valid DBML, so nothing was imported. Line 2: Expected }. Line 4: Unknown column. Line 9: x. And 2 more problems.",
    );
    expect(describeInvalidDbml('a.dbml', [d(1, 'a'), d(2, 'b'), d(3, 'c'), d(4, 'd')])).toMatch(/And 1 more problem\.$/);
  });

  it('names a problem the parser repeats on one line once, and counts only distinct problems', () => {
    const d = (line: number, column: number, message: string) => ({ line, column, message });
    expect(describeInvalidDbml('a.dbml', [d(2, 10, 'Bad'), d(2, 15, 'Bad'), d(2, 20, 'Bad.'), d(5, 8, 'Missing'), d(5, 9, 'Missing')])).toBe(
      "Import DBML: a.dbml isn't valid DBML, so nothing was imported. Line 2: Bad. Line 5: Missing.",
    );
  });

  it('several columns on one line: each problem once, and a hint that names the fix', async () => {
    makeProject('v5');
    const file = dbmlFile('bad.dbml', 'Table t {\n  id int [pk] name varchar\n  x int\n}\nRef: t.zz > t.id\n');
    const ui = fakeUi({ file });

    await expect(importDbml(deps(ui))).resolves.toBeUndefined();

    const message = ui.errors[0].message;
    expect(message.match(/Line 2: /g)).toHaveLength(1);
    expect(message).toMatch(/Line 5: Column 'zz' does not exist/);
    expect(message).not.toMatch(/more problem/);
    expect(message).toMatch(/Each column goes on a line of its own\.$/);
  });
});

describe('Import DBML — contributed', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    contributes: {
      commands: Array<{ command: string; title: string; category?: string }>;
      menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
      viewsWelcome: Array<{ view: string; contents: string; when?: string }>;
    };
  };

  it('is a palette command in the ERD Studio category, with no legacy alias, registered after the project check', () => {
    expect(pkg.contributes.commands.find((c) => c.command === IMPORT_DBML_COMMAND)).toEqual({
      command: IMPORT_DBML_COMMAND, title: 'Import DBML…', category: 'ERD Studio',
    });
    expect(NO_LEGACY_ALIAS.has(IMPORT_DBML_COMMAND)).toBe(true);
    expect(PRE_REGISTERED_COMMANDS.has(IMPORT_DBML_COMMAND)).toBe(false);
    // In the palette whenever a folder is open (a dbt project or not).
    expect((pkg.contributes.menus.commandPalette ?? []).filter((m) => m.command === IMPORT_DBML_COMMAND))
      .toEqual([{ command: IMPORT_DBML_COMMAND, when: 'erdStudio.hasProject' }]);
  });

  it('is in the Subject Areas view\'s title menu and both "No diagrams yet" welcomes (with and without dbt)', () => {
    expect(pkg.contributes.menus['view/title']).toContainEqual({
      command: IMPORT_DBML_COMMAND, when: 'view == erdStudio.domainTree && erdStudio.hasProject', group: '1_create@1',
    });
    const dbt = pkg.contributes.viewsWelcome.find((v) => v.view === 'erdStudio.domainTree' && v.when === 'erdStudio.hasDbtProject && !erdStudio.diagramsLoading')!;
    expect(dbt.contents.startsWith('No diagrams yet.')).toBe(true);
    expect(dbt.contents).toContain('(command:erdStudio.drawFromDbt)');
    expect(dbt.contents).toContain('[New Diagram](command:erdStudio.createDomain)');
    expect(dbt.contents).toContain('[Import DBML](command:erdStudio.importDbml)');
    const plain = pkg.contributes.viewsWelcome.find((v) => v.view === 'erdStudio.domainTree' && v.when === 'erdStudio.hasProject && !erdStudio.hasDbtProject && !erdStudio.diagramsLoading')!;
    expect(plain.contents.startsWith('No diagrams yet.\n\n[New Diagram](command:erdStudio.createDomain)')).toBe(true);
    expect(plain.contents).toContain('[Import DBML](command:erdStudio.importDbml)');
    expect(plain.contents).not.toContain('erdStudio.drawFromDbt');
  });
});
