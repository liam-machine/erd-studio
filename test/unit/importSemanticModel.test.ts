/**
 * Import Power BI or Fabric Semantic Model… (`erdStudio.importSemanticModel`)
 * end to end: a folder → the models in it (a pick when several) → read →
 * convert → Import DBML's own flow (layer, name, dry run, write, open), with
 * the funnel keys. A model that does not read is the user's, reported with
 * file and line; the dry run counts what was skipped by kind and names nothing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import type { ImportDbmlUi } from '../../src/commands/importDbml';
import {
  CHOOSE_ANOTHER_FOLDER_BUTTON,
  IMPORT_SEMANTIC_MODEL_COMMAND,
  importSemanticModel,
  type ImportSemanticModelDeps,
  type ImportSemanticModelUi,
  type SemanticModelItem,
} from '../../src/commands/importSemanticModel';
import { NO_LEGACY_ALIAS, PRE_REGISTERED_COMMANDS } from '../../src/extension';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { telemetry } from '../../src/services/telemetryService';
import packageJson from '../../package.json';

const FIXTURES = path.join(__dirname, '../fixtures/semantic-model');

let tmp: string;
let feature: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const features = () => feature.mock.calls.map((c: unknown[]) => c[0]);
const errors = () => error.mock.calls.map((c: unknown[]) => c[0]);
const erd = (...parts: string[]) => path.join(tmp, '.erd-studio', ...parts);

interface ModelRecorder extends ImportSemanticModelUi {
  modelPicks: SemanticModelItem[][];
  errors: Array<{ message: string; items: string[] }>;
  opened: Array<{ filePath: string; line?: number }>;
}

function modelUi(folder: string | undefined, pick?: (items: SemanticModelItem[]) => SemanticModelItem | undefined, button?: string): ModelRecorder {
  const ui: ModelRecorder = {
    modelPicks: [], errors: [], opened: [],
    pickFolder: async () => folder,
    readDirectory: async (f) => fs.readdirSync(f, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
    readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
    pickModel: async (items) => { ui.modelPicks.push([...items]); return pick?.([...items]); },
    showErrorMessage: async (message, ...items) => { ui.errors.push({ message, items }); return button && items.includes(button) ? button : undefined; },
    openFileAt: async (filePath, line) => { ui.opened.push({ filePath, line }); },
    sendFeedback: async () => {},
  };
  return ui;
}

interface ImportRecorder extends ImportDbmlUi {
  confirms: Array<{ message: string; detail: string }>;
  inputs: Array<string | undefined>;
  opened: string[];
}

function importUi(answers: { confirm?: boolean } = {}): ImportRecorder {
  const ui: ImportRecorder = {
    confirms: [], inputs: [], opened: [],
    pickFile: async () => { throw new Error('no Open dialog for converted DBML'); },
    readFile: async () => { throw new Error('converted DBML is never read from disk'); },
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) =>
      (items as unknown as Array<{ id: string }>).find((i) => i.id === 'gold') as unknown as T | undefined,
    showInputBox: async (options) => { ui.inputs.push(options.value); return options.value; },
    confirm: async (message, detail) => { ui.confirms.push({ message, detail }); return answers.confirm ?? true; },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    openFileAt: async () => {},
    showFile: async () => {},
    openDiagram: async (domainPath) => { ui.opened.push(domainPath); },
    addLayer: async () => {},
    sendFeedback: async () => {},
  };
  return ui;
}

function deps(model: ImportSemanticModelUi, ui: ImportDbmlUi): ImportSemanticModelDeps {
  const layerService = new LayerService(tmp, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return {
    workspaceRoot: tmp, semanticDir: '.erd-studio', layerService, subjectAreaService, tableLibraryService,
    validateDomainName: () => undefined, onWritten: () => {}, modelUi: model, ui,
  };
}

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-semantic-import-'));
  feature = vi.spyOn(telemetry, 'feature');
  error = vi.spyOn(telemetry, 'error');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Import Semantic Model… — contributed', () => {
  it('is a palette command with no legacy alias, not pre-registered, and in the + menu after Import SQL DDL…', () => {
    const pkg = packageJson as unknown as {
      contributes: { commands: Array<{ command: string; title: string; category?: string }>; menus: Record<string, Array<{ command?: string; when?: string; group?: string }>> };
    };
    expect(pkg.contributes.commands.find((c) => c.command === IMPORT_SEMANTIC_MODEL_COMMAND)).toEqual({
      command: IMPORT_SEMANTIC_MODEL_COMMAND, title: 'Import Power BI or Fabric Semantic Model…', category: 'ERD Studio',
    });
    expect(NO_LEGACY_ALIAS.has(IMPORT_SEMANTIC_MODEL_COMMAND)).toBe(true);
    expect(PRE_REGISTERED_COMMANDS.has(IMPORT_SEMANTIC_MODEL_COMMAND)).toBe(false);
    expect(pkg.contributes.menus.commandPalette.filter((m) => m.command === IMPORT_SEMANTIC_MODEL_COMMAND)).toEqual([{ command: IMPORT_SEMANTIC_MODEL_COMMAND, when: 'erdStudio.hasProject' }]);
    expect(pkg.contributes.menus['erdStudio.newMenu']).toContainEqual({ command: IMPORT_SEMANTIC_MODEL_COMMAND, when: 'erdStudio.hasProject', group: '1_diagram@5' });
  });
});

describe('Import Semantic Model…', () => {
  it.each(['pbip-tmdl', 'pbip-tmsl'])('a Power BI Project (%s): found, converted and imported as a DBML diagram, the skips counted', async (fixture) => {
    const model = modelUi(path.join(FIXTURES, fixture));
    const ui = importUi();

    const result = await importSemanticModel(deps(model, ui));

    // One model in the folder: no pick.
    expect(model.modelPicks).toEqual([]);
    expect(model.errors).toEqual([]);
    expect(ui.confirms).toHaveLength(1);
    expect(ui.confirms[0].message).toMatch(/^Import \d+ tables from the semantic model AdventureSales into a new diagram "[a-z0-9-]+" in the Gold layer\.$/);
    const detail = ui.confirms[0].detail;
    expect(detail).toContain('Not imported:');
    expect(detail).toMatch(/• \d+ measures?: DAX calculations, not columns\./);
    expect(detail).toMatch(/• 1 auto date\/time table: Power BI makes one per date column\./);
    expect(detail).toMatch(/snake_case; each Power BI name is kept in its meta, as power_bi_name\./);
    // Counts by kind: no measure's name or DAX in the dialog.
    expect(detail).not.toMatch(/LocalDateTable_|\bSUM\(|CALCULATE/);
    expect(detail).not.toContain('Left out');
    expect(result?.plan.report.dropped).toEqual([]);
    expect(result?.plan.report.renamed).toEqual([]);
    expect(result?.plan.newTables.map((t) => t.name)).toContain('date_table');
    expect(ui.opened).toEqual([result!.domainPath]);
    expect(result!.domainPath.startsWith(erd('gold', 'diagrams'))).toBe(true);
    // The Project note becomes the description.
    expect(fs.readFileSync(result!.domainPath, 'utf-8')).toContain('Converted from the Power BI semantic model AdventureSales.');
    expect(features()).toEqual(['importSemanticModel']);
    expect(errors()).toEqual([]);
  });

  it('a folder with several models asks which one; closing that pick is a cancel', async () => {
    const model = modelUi(FIXTURES, () => undefined);
    await importSemanticModel(deps(model, importUi()));
    expect(model.modelPicks).toHaveLength(1);
    expect(model.modelPicks[0].map((i) => i.label).sort()).toEqual(['AdventureSales', 'AdventureSales', 'Broken', 'BrokenTmdl']);
    expect(model.modelPicks[0].map((i) => i.description).sort()).toEqual(['TMDL', 'TMDL', 'model.bim', 'model.bim']);
    expect(features()).toEqual(['importSemanticModelCancelled']);
    expect(fs.existsSync(erd())).toBe(false);
  });

  it.each(['Broken', 'BrokenTmdl'])('a model that does not read (%s): its problems with file and line, Open File, counted as invalid', async (name) => {
    const model = modelUi(path.join(FIXTURES, 'broken', `${name}.SemanticModel`), undefined, 'Open File');
    expect(await importSemanticModel(deps(model, importUi()))).toBeUndefined();
    expect(model.errors).toHaveLength(1);
    expect(model.errors[0].message).toMatch(/^Import Semantic Model: nothing was imported\. /);
    expect(model.errors[0].message).toMatch(/line \d+/);
    expect(model.errors[0].items).toEqual(['Open File']);
    await vi.waitFor(() => expect(model.opened).toHaveLength(1));
    expect(model.opened[0].filePath.startsWith(path.join(FIXTURES, 'broken', `${name}.SemanticModel`))).toBe(true);
    expect(fs.existsSync(erd())).toBe(false);
    expect(features()).toEqual(['importSemanticModelInvalid']);
  });

  it('a folder with no model says what to pick, offers another folder, and counts as invalid', async () => {
    fs.mkdirSync(path.join(tmp, 'reports'));
    fs.writeFileSync(path.join(tmp, 'reports', 'notes.txt'), 'nothing here');
    const model = modelUi(path.join(tmp, 'reports'));
    await importSemanticModel(deps(model, importUi()));
    expect(model.errors[0].message).toContain('no semantic model found in reports');
    expect(model.errors[0].items).toEqual([CHOOSE_ANOTHER_FOLDER_BUTTON]);
    expect(features()).toEqual(['importSemanticModelInvalid']);
  });

  it('closing the folder dialog, or the dry run, writes nothing and counts a cancel', async () => {
    await importSemanticModel(deps(modelUi(undefined), importUi()));
    await importSemanticModel(deps(modelUi(path.join(FIXTURES, 'pbip-tmdl')), importUi({ confirm: false })));
    expect(features()).toEqual(['importSemanticModelCancelled', 'importSemanticModelCancelled']);
    expect(fs.existsSync(erd('gold', 'diagrams'))).toBe(false);
  });
});
