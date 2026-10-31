/**
 * Open Example Diagram (`erdStudio.openExampleDiagram`) — the inline
 * coffee-shop DBML parses with the bundled @dbml/parse the importer pins,
 * plans cleanly (nothing left out, nothing kept in meta.dbml), and goes
 * through the real Import DBML flow: name box, dry run, write, open, with a
 * plain folder getting `.erd-studio/` only on Import. Cancelling writes
 * nothing; the file is never read from disk.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import { CHOOSE_ANOTHER_NAME_BUTTON, type ImportDbmlDeps, type ImportDbmlUi } from '../../src/commands/importDbml';
import {
  EXAMPLE_DBML,
  EXAMPLE_DBML_FILE_NAME,
  EXAMPLE_LAYER,
  OPEN_EXAMPLE_DIAGRAM_COMMAND,
  exampleDbmlUi,
  openExampleDiagram,
} from '../../src/commands/openExampleDiagram';
import { NO_LEGACY_ALIAS, PRE_REGISTERED_COMMANDS } from '../../src/extension';
import { planDbmlImport } from '../../src/services/dbmlImport';
import { readDbml } from '../../src/services/dbmlImportParse';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { telemetry } from '../../src/services/telemetryService';
import packageJson from '../../package.json';

const SAMPLE_TABLES = ['dim_customers', 'dim_products', 'dim_locations', 'dim_dates', 'fct_orders', 'fct_order_items'];

let tmp: string;
let layerService: LayerService;
let subjectAreaService: SubjectAreaService;
let lms: TableLibraryService;
let feature: ReturnType<typeof vi.spyOn>;

const erd = (...parts: string[]) => path.join(tmp, '.erd-studio', ...parts);
const features = () => feature.mock.calls.map((c: unknown[]) => c[0]);

function services(): void {
  layerService = new LayerService(tmp, '.erd-studio');
  subjectAreaService = new SubjectAreaService(layerService);
  lms = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(lms);
}

interface Recorder extends ImportDbmlUi {
  dialogs: number;
  reads: string[];
  picks: string[][];
  inputs: Array<string | undefined>;
  confirms: Array<{ message: string; detail: string }>;
  opened: string[];
  errors: string[];
}

/** The base UI the example wraps: records everything, reads nothing. */
function recorder(answers: { confirm?: boolean; layer?: string } = {}): Recorder {
  const ui: Recorder = {
    dialogs: 0, reads: [], picks: [], inputs: [], confirms: [], opened: [], errors: [],
    pickFile: async () => { ui.dialogs++; return undefined; },
    readFile: async (filePath) => { ui.reads.push(filePath); throw new Error('read from disk'); },
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) => {
      const ids = (items as unknown as Array<{ id: string }>).map((i) => i.id);
      ui.picks.push(ids);
      return (items as unknown as Array<{ id: string }>).find((i) => i.id === answers.layer) as unknown as T | undefined;
    },
    showInputBox: async (options) => { ui.inputs.push(options.value); return options.value; },
    confirm: async (message, detail) => { ui.confirms.push({ message, detail }); return answers.confirm ?? true; },
    showInformationMessage: async () => undefined,
    showErrorMessage: async (message) => { ui.errors.push(message); return undefined; },
    openFileAt: async () => {},
    showFile: async () => {},
    openDiagram: async (domainPath) => { ui.opened.push(domainPath); },
    addLayer: async () => {},
    sendFeedback: async () => {},
  };
  return ui;
}

function deps(ui: ImportDbmlUi): ImportDbmlDeps {
  return {
    workspaceRoot: tmp,
    semanticDir: '.erd-studio',
    layerService,
    subjectAreaService,
    tableLibraryService: lms,
    validateDomainName: () => undefined,
    onWritten: () => {},
    ui,
  };
}

function erdFiles(): string[] {
  if (!fs.existsSync(erd())) return [];
  return (fs.readdirSync(erd(), { recursive: true }) as string[])
    .filter((f) => fs.statSync(erd(f)).isFile())
    .map((f) => f.split(path.sep).join('/'))
    .sort();
}

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-example-'));
  feature = vi.spyOn(telemetry, 'feature');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the example DBML', () => {
  it('parses with the bundled DBML parser: the six sample tables and their eight relationships', () => {
    const read = readDbml(EXAMPLE_DBML);
    if (!read.ok) throw new Error(JSON.stringify(read.diagnostics));
    expect(read.model.tables.map((t) => t.name)).toEqual(SAMPLE_TABLES);
    expect(read.model.refs).toHaveLength(8);
  });

  it('plans cleanly: roles, grain, keys and measures read; nothing left out, renamed or kept in meta', () => {
    const read = readDbml(EXAMPLE_DBML);
    if (!read.ok) throw new Error('not DBML');
    const plan = planDbmlImport({
      model: read.model,
      layer: 'gold',
      subjectAreaName: 'coffee-shop',
      fileName: EXAMPLE_DBML_FILE_NAME,
      library: { findTableName: () => null, getTable: () => null },
      libraryRelationships: false,
      diagramCopies: [],
    });
    expect(plan.report.dropped).toEqual([]);
    expect(plan.report.notes).toEqual([]);
    expect(plan.report.renamed).toEqual([]);
    expect(plan.report.keptInMeta).toBe(0);
    expect(plan.report.relationships).toBe(8);
    expect(plan.document.description).toContain('Kimball star schema');
    const byName = Object.fromEntries(plan.newTables.map((t) => [t.name, t]));
    for (const name of SAMPLE_TABLES) {
      expect(byName[name].grain, name).toMatch(/^One row per /);
      expect(byName[name].modelRole, name).toBe(name.startsWith('dim_') ? 'conformed-dim' : 'transaction-fact');
      expect(byName[name].columns.filter((c) => c.isPrimaryKey), name).toHaveLength(1);
      expect(byName[name].meta, name).toBeUndefined();
    }
    const orders = byName.fct_orders;
    expect(orders.columns.find((c) => c.name === 'subtotal')?.additiveType).toBe('additive');
    expect(orders.columns.find((c) => c.name === 'customer_order_number')?.additiveType).toBe('non-additive');
    expect(orders.columns.find((c) => c.name === 'order_id')?.isNaturalKey).toBe(true);
    expect(byName.dim_customers.rationale?.scdStrategy).toContain('Type 1');
    expect(byName.dim_customers.columns.find((c) => c.name === 'customer_name')?.scdType).toBe(1);
    // Every relationship from a fact's FK column to a dimension's (or the order's) key.
    for (const rel of plan.relationships) {
      expect(rel.fromModel).toMatch(/^fct_/);
    }
  });

  it('says nothing that is not true of DBML or ERD Studio', () => {
    expect(EXAMPLE_DBML).not.toMatch(/open standard|open source|lossless/i);
  });
});

describe('Open Example Diagram', () => {
  it('is a post-rename command with no legacy alias, registered after project resolution', () => {
    expect(OPEN_EXAMPLE_DIAGRAM_COMMAND).toBe('erdStudio.openExampleDiagram');
    expect(NO_LEGACY_ALIAS.has(OPEN_EXAMPLE_DIAGRAM_COMMAND)).toBe(true);
    // An empty window gets the fallback "Open a folder first" with Open Folder….
    expect(PRE_REGISTERED_COMMANDS.has(OPEN_EXAMPLE_DIAGRAM_COMMAND)).toBe(false);
  });

  it('is contributed in the ERD Studio category and offered in the no-dbt sidebar welcome', () => {
    const pkg = packageJson as unknown as {
      contributes: {
        commands: Array<{ command: string; title: string; category?: string }>;
        viewsWelcome: Array<{ view: string; contents: string; when?: string }>;
      };
    };
    expect(pkg.contributes.commands.find((c) => c.command === OPEN_EXAMPLE_DIAGRAM_COMMAND)).toEqual({
      command: OPEN_EXAMPLE_DIAGRAM_COMMAND, title: 'Open Example Diagram', category: 'ERD Studio',
    });
    const plain = pkg.contributes.viewsWelcome.find((v) => v.view === 'erdStudio.domainTree' && v.when === 'erdStudio.hasProject && !erdStudio.hasDbtProject && !erdStudio.diagramsLoading')!;
    expect(plain.contents).toContain('New to data modelling? [Open Example Diagram](command:erdStudio.openExampleDiagram)');
    const dbt = pkg.contributes.viewsWelcome.find((v) => v.view === 'erdStudio.domainTree' && v.when === 'erdStudio.hasDbtProject && !erdStudio.diagramsLoading')!;
    expect(dbt.contents).not.toContain('openExampleDiagram');
  });

  it('in a plain folder: name box, dry run, then .erd-studio/ with layers.json, the tables and the diagram, opened', async () => {
    services();
    const ui = recorder();

    const result = await openExampleDiagram(deps(ui));

    // A new project stores the example as DBML (native DBML storage, §3.2).
    const domainPath = erd(EXAMPLE_LAYER, 'diagrams', 'coffee-shop.dbml');
    expect(result?.domainPath).toBe(domainPath);
    // No Open dialog, no layer pick (the default layers have gold), no read from disk.
    expect(ui.dialogs).toBe(0);
    expect(ui.picks).toEqual([]);
    expect(ui.reads).toEqual([]);
    expect(ui.inputs).toEqual(['coffee-shop']);
    expect(ui.confirms).toHaveLength(1);
    expect(ui.confirms[0].message).toBe('Import 6 tables into a new diagram "coffee-shop" in the Gold layer.');
    expect(ui.confirms[0].detail).toContain('8 relationships');
    expect(ui.confirms[0].detail).toContain('laid out automatically');
    expect(ui.confirms[0].detail).not.toContain('Left out');
    expect(ui.errors).toEqual([]);
    expect(ui.opened).toEqual([domainPath]);
    // A project with no library yet writes DBML (§3.2) in the layer-first tree: the tables in gold/tables/gold/
    // (layer gold, schema gold), the Refs in gold's relationships file, and the README a new project starts with.
    expect(erdFiles()).toEqual([
      'README.md',
      'gold/diagrams/coffee-shop.dbml',
      'gold/relationships/gold.dbml',
      ...SAMPLE_TABLES.map((t) => `gold/tables/gold/${t}.dbml`).sort(),
      'layers.json',
    ]);
    expect(fs.readFileSync(erd('gold', 'tables', 'gold', 'fct_orders.dbml'), 'utf-8')).toMatch(/^Table gold\.fct_orders \[/m);
    // Counted as the example only: the Import DBML counts stay the user's own files.
    expect(features()).toEqual(['exampleDiagram']);
  });

  it('twice: the second gets a free name and reuses the tables it already wrote', async () => {
    services();
    await openExampleDiagram(deps(recorder()));
    services();
    const ui = recorder();
    const result = await openExampleDiagram(deps(ui));
    expect(ui.inputs).toEqual(['coffee-shop-2']);
    expect(result?.plan.reusedTables).toEqual(SAMPLE_TABLES);
    expect(ui.confirms[0].detail).toContain('Already in your Table Library');
  });

  it('cancelled at the dry run: nothing written, not counted as an example', async () => {
    services();
    const ui = recorder({ confirm: false });
    expect(await openExampleDiagram(deps(ui))).toBeUndefined();
    expect(fs.existsSync(erd())).toBe(false);
    // Not an example, and not a cancelled Import DBML either.
    expect(features()).toEqual([]);
  });

  it('finished through Choose Another Name: still counted as the example, once', async () => {
    // A diagram the name box did not know about (another window, git) takes the first name.
    fs.mkdirSync(erd('gold'), { recursive: true });
    fs.writeFileSync(erd('gold', 'taken.json'), '{}');
    services();
    const ui = recorder();
    const names = ['taken', 'coffee-shop'];
    ui.showInputBox = async () => names.shift();
    ui.showErrorMessage = async (message, ...items) => {
      ui.errors.push(message);
      return items.find((i) => i === CHOOSE_ANOTHER_NAME_BUTTON);
    };

    expect(await openExampleDiagram(deps(ui))).toBeUndefined();
    await vi.waitFor(() => expect(ui.opened).toEqual([erd(EXAMPLE_LAYER, 'coffee-shop.json')]));
    expect(ui.errors).toEqual(['A diagram named "taken" already exists in the Gold layer.']);
    expect(ui.reads).toEqual([]);
    expect(features()).toEqual(['exampleDiagram']);
  });

  it('a project without a gold layer is asked for one, as any import is', async () => {
    fs.mkdirSync(erd(), { recursive: true });
    fs.writeFileSync(erd('layers.json'), JSON.stringify({
      schemaVersion: 1,
      layers: [
        { id: 'staging', label: 'Staging', color: '#888888', creatable: true },
        { id: 'marts', label: 'Marts', color: '#999999', creatable: true },
      ],
    }));
    services();
    const ui = recorder({ layer: 'marts' });
    const result = await openExampleDiagram(deps(ui));
    expect(ui.picks).toEqual([['staging', 'marts']]);
    // A project with no tables yet writes DBML (§3.2).
    expect(result?.domainPath).toBe(erd('marts', 'diagrams', 'coffee-shop.dbml'));
    expect(fs.existsSync(erd('marts', 'tables', 'marts', 'fct_orders.dbml'))).toBe(true);
  });

  it('exampleDbmlUi reads only the example, which has no erd_layout', async () => {
    const base = recorder();
    const examplePath = path.join(tmp, EXAMPLE_DBML_FILE_NAME);
    const ui = exampleDbmlUi(base, examplePath);
    expect(await ui.pickFile(tmp)).toBe(examplePath);
    expect(await ui.readFile(examplePath)).toBe(EXAMPLE_DBML);
    expect(ui).not.toHaveProperty('exists');
    expect(EXAMPLE_DBML).not.toContain('erd_layout');
    await expect(ui.readFile(path.join(tmp, 'other.dbml'))).rejects.toThrow('read from disk');
  });
});
