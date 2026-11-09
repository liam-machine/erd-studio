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
import { fakeDraftPreview } from './helpers/draftDriver';
import {
  CHOOSE_ANOTHER_FOLDER_BUTTON,
  IMPORT_SEMANTIC_MODEL_COMMAND,
  MAX_SEMANTIC_MODEL_FILES,
  importSemanticModel,
  type ImportSemanticModelDeps,
  type ImportSemanticModelUi,
  type SemanticModelItem,
} from '../../src/commands/importSemanticModel';
import { NO_LEGACY_ALIAS, PRE_REGISTERED_COMMANDS } from '../../src/extension';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { log } from '../../src/services/logger';
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

/** Import DBML's half: the fallback modal answered by `confirm` (default Import). */
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
    // The fallback modal (no preview): what it counts and says. Cancelled: nothing written.
    const fallback = modelUi(path.join(FIXTURES, fixture));
    const modal = importUi({ confirm: false });
    expect(await importSemanticModel(deps(fallback, modal))).toBeUndefined();
    expect(modal.confirms).toHaveLength(1);
    expect(modal.confirms[0].message).toMatch(/^Import \d+ tables and \d+ relationships from the semantic model AdventureSales into a new diagram "[a-z0-9-]+" in the Gold layer\.$/);
    const detail = modal.confirms[0].detail;
    // The modal counts what was left out, with the first; the draft's details list every one.
    // The ledger's lines (model features not kept, most important first) lead; the skipped kinds follow.
    expect(detail).toMatch(/• Not imported: .+; and \d+ more\./);
    expect(detail).toMatch(/snake_case; the original Power BI names are kept in the table files\./);
    expect(fs.existsSync(erd())).toBe(false);

    // The draft (Draft-first): Keep writes it.
    const model = modelUi(path.join(FIXTURES, fixture));
    const ui = importUi();
    const preview = fakeDraftPreview(['keep']);
    const result = await importSemanticModel({ ...deps(model, ui), draft: { preview, trigger: 'palette' } });

    // One model in the folder: no pick, and no switcher.
    expect(model.modelPicks).toEqual([]);
    expect(model.errors).toEqual([]);
    expect(ui.confirms).toEqual([]);
    const draft = preview.drafts[0];
    expect(draft.source).toBe('semanticModel');
    expect(draft.scopes).toBeUndefined();
    expect(draft.banner.headline).toMatch(/^Draft from the semantic model AdventureSales · \d+ tables, \d+ relationships · not saved$/);
    const left = draft.details.find((section) => section.id === 'leftOut')!.items.map((i) => i.text);
    expect(left).toContainEqual(expect.stringMatching(/^\d+ measures?: DAX calculations, not columns$/));
    expect(left).toContain('1 auto date/time table: Power BI makes one per date column');
    // What the page shows as text: the banner and the details (the diagram's own meta is the table files').
    const page = JSON.stringify({ banner: draft.banner, details: draft.details });
    for (const text of [detail, page]) {
      // Plain words: no storage key a Power BI developer has never seen.
      expect(text).not.toMatch(/\bmeta\b|power_bi_name|erd_layout/);
      // Counts by kind: no measure's name or DAX in the dialog or the draft.
      expect(text).not.toMatch(/LocalDateTable_|\bSUM\(|CALCULATE/);
      expect(text).not.toContain('Left out');
    }
    expect(result?.plan.report.dropped).toEqual([]);
    expect(result?.plan.report.renamed).toEqual([]);
    expect(result?.plan.newTables.map((t) => t.name)).toContain('date_table');
    expect(ui.opened).toEqual([result!.domainPath]);
    expect(preview.settled).toEqual([{ kept: true }]);
    expect(result!.domainPath.startsWith(erd('gold', 'diagrams'))).toBe(true);
    // The Project note becomes the description.
    expect(fs.readFileSync(result!.domainPath, 'utf-8')).toContain('Converted from the Power BI semantic model AdventureSales.');
    expect(features()).toEqual(['importSemanticModelCancelled', 'importSemanticModel']);
    expect(errors()).toEqual([]);
  });

  it('a folder with several models asks which one; closing that pick is a cancel', async () => {
    const model = modelUi(FIXTURES, () => undefined);
    await importSemanticModel(deps(model, importUi()));
    expect(model.modelPicks).toHaveLength(1);
    expect(model.modelPicks[0].map((i) => i.label).sort()).toEqual(['AdventureSales', 'AdventureSales', 'Broken', 'BrokenTmdl']);
    expect(model.modelPicks[0].map((i) => i.description).sort()).toEqual(['TMDL', 'TMDL', 'model.bim', 'model.bim']);
    expect(features()).toEqual(['importSemanticModelSeveral', 'importSemanticModelCancelled']);
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
    // Why, by the model's format.
    expect(features()).toEqual(['importSemanticModelInvalid', name === 'BrokenTmdl' ? 'importSemanticModelParseTmdl' : 'importSemanticModelParseBim']);
  });

  it('a folder with no model says what to pick, offers another folder, and counts as invalid', async () => {
    fs.mkdirSync(path.join(tmp, 'reports'));
    fs.writeFileSync(path.join(tmp, 'reports', 'notes.txt'), 'nothing here');
    const model = modelUi(path.join(tmp, 'reports'));
    await importSemanticModel(deps(model, importUi()));
    expect(model.errors[0].message).toContain('no semantic model found in reports');
    expect(model.errors[0].items).toEqual([CHOOSE_ANOTHER_FOLDER_BUTTON]);
    expect(features()).toEqual(['importSemanticModelInvalid', 'importSemanticModelNoModel']);
  });

  it('a folder holding only a .pbix, or a Tabular Editor JSON folder, names it and says how to save it so it imports', async () => {
    for (const [file, expected] of [['Sales.pbix', /Sales\.pbix is a Power BI Desktop file.*Power BI project \(\*\.pbip\)/], ['tables/database.json', /database\.json is a model saved by Tabular Editor's Save to Folder.*TMDL or as one model\.bim/]] as const) {
      const folder = path.join(tmp, `reports-${path.basename(file)}`);
      fs.mkdirSync(path.join(folder, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(folder, file), 'PK\u0003\u0004 binary');
      const model = modelUi(folder);
      await importSemanticModel(deps(model, importUi()));
      expect(model.errors[0].message).toMatch(/no semantic model found in reports-/);
      expect(model.errors[0].message).toMatch(expected);
      expect(model.errors[0].message).not.toContain('binary');
    }
  });

  it('a big repo with one model in it still imports from its root: only model files count toward the bound', async () => {
    const repo = path.join(tmp, 'repo');
    fs.cpSync(path.join(FIXTURES, 'pbip-tmdl'), path.join(repo, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'assets'));
    for (let i = 0; i <= MAX_SEMANTIC_MODEL_FILES; i++) fs.writeFileSync(path.join(repo, 'assets', `img${i}.png`), '');
    const model = modelUi(repo);
    const result = await importSemanticModel(deps(model, importUi()));
    expect(model.errors).toEqual([]);
    expect(result?.plan.newTables.map((t) => t.name)).toContain('date_table');
  });

  it('a folder with too many model files says what to pick and offers another folder', async () => {
    const model = modelUi('/big', undefined, CHOOSE_ANOTHER_FOLDER_BUTTON);
    model.readDirectory = async () => Array.from({ length: MAX_SEMANTIC_MODEL_FILES + 1 }, (_, i) => [`t${i}.tmdl`, false] as const);
    let again = 0;
    const pickFolder = model.pickFolder;
    model.pickFolder = async (f) => { again++; return again === 1 ? pickFolder(f) : undefined; };
    await importSemanticModel(deps(model, importUi()));
    await new Promise((r) => setTimeout(r, 0));
    expect(model.errors[0].message).toMatch(new RegExp(`big holds more than ${MAX_SEMANTIC_MODEL_FILES} model files\\. Pick the <Name>\\.SemanticModel folder itself`));
    expect(model.errors[0].items).toEqual([CHOOSE_ANOTHER_FOLDER_BUTTON]);
    expect(features()[0]).toBe('importLimitTooManyFiles');
    // The button runs the import again, from the folder dialog.
    expect(again).toBe(2);
  });

  it('closing the folder dialog, or the dry run, writes nothing and counts a cancel', async () => {
    await importSemanticModel(deps(modelUi(undefined), importUi()));
    await importSemanticModel(deps(modelUi(path.join(FIXTURES, 'pbip-tmdl')), importUi({ confirm: false })));
    expect(features()).toEqual(['importSemanticModelCancelled', 'importSemanticModelCancelled']);
    expect(fs.existsSync(erd('gold', 'diagrams'))).toBe(false);
  });
});

describe('Import Semantic Model… — names and the loss ledger', () => {
  /** The pbip-tmdl fixture copied under tmp, with Fabric's `.platform` naming the item. */
  function fabricCopy(displayName: string | undefined): string {
    const src = path.join(FIXTURES, 'pbip-tmdl');
    const dest = path.join(tmp, 'src', 'fabric-repo');
    fs.cpSync(src, dest, { recursive: true });
    if (displayName !== undefined) {
      fs.writeFileSync(path.join(dest, 'AdventureSales.SemanticModel', '.platform'), JSON.stringify({ metadata: { type: 'SemanticModel', displayName }, config: { version: '2.0' } }));
    }
    return dest;
  }

  it("names the Project after Fabric's .platform displayName, and draws without one as before", async () => {
    for (const [displayName, expected] of [['Sales Insights (EU)', 'Sales Insights (EU)'], [undefined, 'AdventureSales']] as const) {
      fs.rmSync(path.join(tmp, 'src'), { recursive: true, force: true });
      const model = modelUi(fabricCopy(displayName));
      const preview = fakeDraftPreview(['keep']);
      const result = await importSemanticModel({ ...deps(model, importUi()), draft: { preview, trigger: 'palette' } });
      expect(model.errors).toEqual([]);
      expect(fs.readFileSync(result!.domainPath, 'utf-8')).toContain(`Converted from the Power BI semantic model ${expected}.`);
      expect(preview.drafts[0].banner.headline).toMatch(new RegExp(`^Draft from the semantic model ${expected.replace(/[()]/g, '\\$&')} · `));
      fs.rmSync(erd(), { recursive: true, force: true });
      _resetMockWorkspace();
    }
  });

  it("picking the model's definition folder itself names the model after X.SemanticModel (and its .platform), not \"definition\"", async () => {
    for (const [displayName, expected] of [[undefined, 'AdventureSales'], ['Sales Insights', 'Sales Insights']] as const) {
      fs.rmSync(path.join(tmp, 'src'), { recursive: true, force: true });
      const model = modelUi(path.join(fabricCopy(displayName), 'AdventureSales.SemanticModel', 'definition'));
      const preview = fakeDraftPreview(['keep']);
      const result = await importSemanticModel({ ...deps(model, importUi()), draft: { preview, trigger: 'palette' } });
      expect(model.errors).toEqual([]);
      expect(fs.readFileSync(result!.domainPath, 'utf-8')).toContain(`Converted from the Power BI semantic model ${expected}.`);
      fs.rmSync(erd(), { recursive: true, force: true });
      _resetMockWorkspace();
    }
  });

  it('passes the ledger to the draft (Not imported names the model features left out) and logs each with its file and line', async () => {
    const info = vi.spyOn(log, 'info');
    const model = modelUi(path.join(FIXTURES, 'pbip-tmdl'));
    const preview = fakeDraftPreview(['discard']);
    await importSemanticModel({ ...deps(model, importUi()), draft: { preview, trigger: 'palette' } });
    const draft = preview.drafts[0];
    const left = draft.details.find((section) => section.id === 'leftOut')!.items.map((i) => i.text);
    expect(left).toContainEqual(expect.stringMatching(/^1 object: Q&A linguistic metadata not kept \(en-AU\)$/));
    expect(left).toContainEqual(expect.stringMatching(/settings: summarizeBy not kept: a report setting/));
    const logged = info.mock.calls.map((c) => String(c[0]));
    expect(logged).toContainEqual(expect.stringMatching(/Import Semantic Model: .*cultures\/en-AU\.tmdl line \d+: object en-AU: lost, notDesign: Q&A linguistic metadata/));
    // The date-only Date Table[Date] (formatString Long Date) is a date, said in the notes.
    const notes = draft.details.find((section) => section.id === 'notes')?.items.map((i) => i.text) ?? [];
    expect(notes.join('\n')).toMatch(/1 type: dateTime → date because Power BI marks the column date-only \(Date Table\.Date\)/);
  });
});
