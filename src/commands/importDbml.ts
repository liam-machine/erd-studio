/**
 * **Import DBML…** (`erdStudio.importDbml`) — a DBML file in as a NEW logical
 * subject area: ERD Studio's own rich export (`toDbmlRich`, "Rich DBML") or
 * a file from dbdiagram.io or any other DBML tool. No dbt needed: it reads
 * only the chosen file. Its Project's `erd_layout`, when it has one (the rich
 * export writes it), places the tables and sticky notes; a `.dbdiagram` file
 * beside it is not read.
 *
 * Steps: file → read it (`workspace.fs`) → `readDbml` (a file that is not
 * valid DBML is reported with its line numbers and an Open File button) →
 * layer → name (the rule New Subject Area uses) → a dry-run summary with
 * Import / Cancel → write → open the new diagram. Cancelling any step writes
 * nothing.
 *
 * The mapping is the pure planner's (`planDbmlImport` in
 * `src/services/dbmlImport.ts`); the files are written the way Draw from dbt
 * writes a draft, through the shared `writeNewSubjectArea`: tables the Table
 * Library already has are used as they are and never overwritten, new table
 * files go in the folder the library groups by, the subject area file is
 * created with `wx`, relationships go to the tables' files when the project
 * keeps them there (`usesLibraryRelationships`), and any failure puts every
 * file back. A file it would change that is open with unsaved edits stops it
 * before anything is written.
 *
 * Every vscode call goes through `ImportDbmlUi`, so the flow is unit-tested
 * with plain fakes; `vscodeImportDbmlUi()` is the real one `activate()` uses.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { DBML_RELATIONSHIPS_FILE_NAME, isReservedTableName } from '@erd-studio/core';
import { DBML_CONVERT_FIRST_MESSAGE } from '@erd-studio/core/dbml';
import { RESERVED_TABLE_NAME_MESSAGE } from '../types/naming';

import {
  analyseDbml,
  describeDbmlImportPlan,
  planDbmlImport,
  serializeDbmlImportDocument,
  suggestDbmlSubjectAreaName,
  type DbmlImportPlan,
} from '../services/dbmlImport';
import type { DbmlDiagnostic } from '../services/dbmlImportParse';
import {
  ADD_LAYER_BUTTON,
  CHOOSE_ANOTHER_NAME_BUTTON,
  NO_LAYERS_MESSAGE,
  OPEN_FILE_BUTTON,
  OPEN_IT_BUTTON,
  SEND_FEEDBACK_BUTTON,
  SHOW_FILE_BUTTON,
  TRY_AGAIN_BUTTON,
  diagramNameTakenMessage,
  feedbackPrefill,
  oursMessage,
  showErrorWithActions,
  type ErrorActions,
  type FeedbackPrefill,
} from '../services/commandErrors';
import { drawnDiagramCopies, usesLibraryRelationships } from '../services/libraryRelationships';
import {
  environmentWriteProblem,
  isRefusedWrite,
  refusalLocation,
  writeNewSubjectArea,
  writeOutcome,
  UnsavedFilesRefused,
  type RefusedWrite,
} from '../services/newSubjectAreaWriter';
import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../services/recoveryService';
import { telemetry } from '../services/telemetryService';
import type { SubjectAreaService } from '../services/domainService';
import type { LayerService } from '../services/layerService';
import type { TableLibraryService } from '../services/logicalModelService';
import { dirtyFiles, openOrDiskText } from '../providers/dirtyDocuments';
import { readSubjectAreaRelationships } from './moveRelationshipsToLibrary';
import { openTableFileAt } from './openModelFile';
import { log } from '../services/logger';

export const IMPORT_DBML_COMMAND = 'erdStudio.importDbml';

const TITLE = 'Import DBML';

export { ADD_LAYER_BUTTON, CHOOSE_ANOTHER_NAME_BUTTON, NO_LAYERS_MESSAGE, OPEN_IT_BUTTON, SHOW_FILE_BUTTON, TRY_AGAIN_BUTTON };
export const IMPORT_BUTTON = 'Import';
export { OPEN_FILE_BUTTON };

/** How many of a file's DBML problems the message names; the rest are counted. */
const DIAGNOSTICS_SHOWN = 3;
/** @dbml/parse's message for several columns on one line (`id int [pk] name varchar`). */
const SEVERAL_FIELDS_ON_ONE_LINE = /These fields must be some inline settings/i;

/** Every vscode call the flow makes, injectable for tests. */
export interface ImportDbmlUi {
  /** The DBML file to import (an Open dialog filtered to `.dbml`); undefined when cancelled. */
  pickFile(defaultFolder: string | undefined): Promise<string | undefined>;
  /** A file's text (`workspace.fs`). Throws when it cannot be read. */
  readFile(filePath: string): Promise<string>;
  showQuickPick<T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions): Promise<T | undefined>;
  showInputBox(options: vscode.InputBoxOptions): Promise<string | undefined>;
  /** A modal: `message`, the `detail` under it, `button` and Cancel. True when `button` was picked. */
  confirm(message: string, detail: string, button: string): Promise<boolean>;
  showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
  /** Resolves the button picked; the flow never awaits it. */
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
  /** Open a file as text, the cursor at the 1-based line and column when given. */
  openFileAt(filePath: string, line?: number, column?: number): Promise<void>;
  /** Show a file open with unsaved edits. */
  showFile(filePath: string): Promise<void>;
  /** Open a subject area on the ERD canvas. */
  openDiagram(domainPath: string): Promise<void>;
  /** Run Add Layer (`erdStudio.addLayer`). */
  addLayer(): Promise<void>;
  /** Open Send Feedback (`erdStudio.reportBug`) with this prefill. */
  sendFeedback(prefill: FeedbackPrefill): Promise<void>;
}

export interface ImportDbmlDeps {
  workspaceRoot: string;
  semanticDir: string;
  layerService: Pick<LayerService, 'getValidLayerIds' | 'getCreatableLayers' | 'getAllLayers' | 'saveConfig'>;
  subjectAreaService: Pick<SubjectAreaService, 'listSubjectAreas' | 'countSubjectAreaFileRelationships'>;
  tableLibraryService: Pick<
    TableLibraryService,
    'findTableNameIgnoringCase' | 'getTable' | 'saveTable' | 'serializeTable' | 'groupsByFolder' | 'deleteTable'
      | 'listTables' | 'hasUnreadableRelationships' | 'tablePath' | 'getTablesDir' | 'writesTableNaming'
  > & Partial<Pick<TableLibraryService, 'hasDbmlLibrary' | 'planTableWrites' | 'writesDbml' | 'tableStorage' | 'invalidateCache'>>;
  /** `createDomain`'s rule for a new subject area name in `layer` (undefined = valid). */
  validateDomainName: (value: string, layer: string) => string | undefined;
  /**
   * Every file is written; refresh the tree, Table Library, context keys and
   * selectors. `modelNames` are the new tables; `changedModelNames` the
   * existing library tables that gained a relationship.
   */
  onWritten: (written: { domainPath: string; modelNames: string[]; changedModelNames: string[] }) => void;
  ui?: ImportDbmlUi;
  /**
   * `'example'` when Open Example Diagram supplies the DBML: a finished run
   * counts `exampleDiagram` instead of `importDbml`, and a cancel counts
   * nothing, so the Import DBML counts stay the user's own files. It travels
   * with `deps`, so Try Again and Choose Another Name keep it. Default `'file'`.
   */
  source?: 'file' | 'example';
}

/**
 * Where Try Again and Choose Another Name re-enter the flow: with the file
 * and layer the user already chose (the file is read again, so a fix made
 * meanwhile is picked up).
 */
export interface ImportDbmlResume {
  filePath: string;
  layer?: string;
  /** The name to offer again (Try Again); the suggested one when absent. */
  name?: string;
}

export interface ImportDbmlResult {
  domainPath: string;
  plan: DbmlImportPlan;
}

/**
 * Run the flow. Resolves undefined when the user cancels, when the file
 * cannot be imported, or when a write fails (each case has already said so).
 * Anything that throws is counted and rethrown.
 */
export async function importDbml(deps: ImportDbmlDeps, resume?: ImportDbmlResume): Promise<ImportDbmlResult | undefined> {
  const ui = deps.ui ?? vscodeImportDbmlUi();
  try {
    return await runImportDbml(deps, ui, resume);
  } catch (err) {
    telemetry.error('importDbmlFailed');
    throw err;
  }
}

/**
 * The message for a file that is not valid DBML: the first few problems with
 * their 1-based line numbers, the rest counted. The user's file, not a
 * failure of ours.
 */
export function describeInvalidDbml(fileName: string, diagnostics: readonly DbmlDiagnostic[]): string {
  // The parser reports one mistake once per stray token (same line, same
  // message, another column): name each problem once.
  const problems = [...new Set(diagnostics.map((d) => `Line ${d.line}: ${d.message.trim().replace(/\.$/, '')}.`))];
  const shown = problems.slice(0, DIAGNOSTICS_SHOWN);
  const more = problems.length - shown.length;
  const tail = more > 0 ? ` And ${more} more ${more === 1 ? 'problem' : 'problems'}.` : '';
  const hint = diagnostics.some((d) => SEVERAL_FIELDS_ON_ONE_LINE.test(d.message))
    ? ' Each column goes on a line of its own.'
    : '';
  return `${TITLE}: ${fileName} isn't valid DBML, so nothing was imported. ${shown.join(' ')}${tail}${hint}`;
}

async function runImportDbml(deps: ImportDbmlDeps, ui: ImportDbmlUi, resume?: ImportDbmlResume): Promise<ImportDbmlResult | undefined> {
  const { workspaceRoot, semanticDir, layerService, subjectAreaService, tableLibraryService } = deps;
  const fromExample = deps.source === 'example';
  const cancelled = (): undefined => {
    if (!fromExample) telemetry.feature('importDbmlCancelled');
    return undefined;
  };

  /** Show an error with its buttons, and run the one the user picks. Never awaited. */
  const showError = (message: string, actions: ErrorActions = {}): void => {
    // A button that fails (a re-run whose read throws) still says so, rather than seeming to do nothing.
    showErrorWithActions((m, ...items) => ui.showErrorMessage(m, ...items), message, actions, (choice, err) => {
      log.error(`[ERD Studio] ${TITLE}: "${choice}" failed:`, err);
      const doing = `while running ${choice}`;
      showError(oursMessage(TITLE, doing, 'nothing was changed'), { [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err) });
    });
  };
  const sendFeedback = (doing: string, err: unknown) => (): unknown => ui.sendFeedback(feedbackPrefill(TITLE, doing, err));

  // 1. The file.
  const filePath = resume?.filePath ?? await ui.pickFile(workspaceRoot || undefined);
  if (!filePath) return cancelled();
  const fileName = path.basename(filePath);
  const again = (more: Omit<ImportDbmlResume, 'filePath'> = {}): (() => unknown) =>
    () => importDbml(deps, { filePath, ...more });

  let text: string;
  try {
    text = stripBom(await ui.readFile(filePath));
  } catch (err) {
    log.error(`[ERD Studio] ${TITLE}: could not read the file:`, err);
    showError(`${TITLE} couldn't read ${fileName}. Check that the file still exists and that you can open it, then try again.`, {
      [TRY_AGAIN_BUTTON]: again(),
    });
    return undefined;
  }

  // Loaded on first use: the parser is a third of the bundle, and only this command needs it.
  const { readDbml, readDbmlImportLayout } = await import('../services/dbmlImportParse');
  const read = readDbml(text);
  if (!read.ok) {
    if (!fromExample) telemetry.feature('importDbmlInvalid');
    const first = read.diagnostics[0];
    showError(read.importsOtherFiles ? `${TITLE}: ${first.message}` : describeInvalidDbml(fileName, read.diagnostics), {
      [OPEN_FILE_BUTTON]: () => ui.openFileAt(filePath, first?.line, first?.column),
    });
    return undefined;
  }
  const model = read.model;
  if (model.tables.length === 0) {
    void ui.showInformationMessage(`${TITLE}: ${fileName} has no tables, so there is nothing to import.`);
    return undefined;
  }

  // The positions in the file's own Project (`erd_layout`), when it has
  // them. Lines that cannot be read are not a reason to stop: the dry run
  // names them and the canvas places those tables instead.
  const layout = readDbmlImportLayout(text);

  // 2. The layer: the one the file's TableGroup or schema names, offered first.
  const creatable = layerService.getCreatableLayers();
  if (creatable.length === 0) {
    showError(NO_LAYERS_MESSAGE, { [ADD_LAYER_BUTTON]: () => ui.addLayer() });
    return undefined;
  }
  const analysis = analyseDbml(model, { layerIds: layerService.getValidLayerIds(), fileName });
  let layer = creatable.find((l) => l.id === resume?.layer)?.id;
  if (!layer && creatable.length === 1) layer = creatable[0].id;
  if (!layer) {
    const suggested = creatable.find((l) => l.id === analysis.suggestedLayer);
    const ordered = suggested ? [suggested, ...creatable.filter((l) => l !== suggested)] : creatable;
    const choice = await ui.showQuickPick(
      ordered.map((l) => ({
        label: l.label,
        description: l === suggested ? 'suggested by the file' : (l.id === l.label.toLowerCase() ? undefined : l.id),
        id: l.id,
      })),
      { title: TITLE, placeHolder: 'Which layer is this diagram for?', ignoreFocusOut: true },
    );
    if (!choice) return cancelled();
    layer = choice.id;
  }
  const chosenLayer = layer;
  const layerLabel = creatable.find((l) => l.id === chosenLayer)?.label ?? chosenLayer;

  // 3. The name: the Project name or the file name, free in that layer.
  const taken = subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir)
    .filter((d) => d.layer === chosenLayer).map((d) => d.domain);
  const name = await ui.showInputBox({
    title: TITLE,
    prompt: `Name the diagram. It is saved in the ${layerLabel} layer.`,
    value: resume?.name ?? suggestDbmlSubjectAreaName(model, fileName, taken),
    ignoreFocusOut: true,
    validateInput: (value: string) => deps.validateDomainName(value, chosenLayer),
  });
  if (!name) return cancelled();
  const slug = name.trim();

  // A project that writes DBML (§3.2) gets a `.dbml` diagram whose relationships all live in the library (D5).
  const dbml = tableLibraryService.writesDbml?.() ?? false;
  const layerDir = path.join(workspaceRoot, semanticDir, chosenLayer);
  const domainPath = path.join(layerDir, `${slug}.${dbml ? 'dbml' : 'json'}`);
  const tryAgain = again({ layer: chosenLayer, name: slug });
  // The name box already refuses a name in use; this is a diagram that
  // appeared since (another window, git), so the choices are kept.
  const nameTaken = (): void => showError(diagramNameTakenMessage(slug, layerLabel), {
    [OPEN_IT_BUTTON]: () => ui.openDiagram(domainPath),
    [CHOOSE_ANOTHER_NAME_BUTTON]: again({ layer: chosenLayer }),
  });
  // A name is taken in either format: `<slug>.json` and `<slug>.dbml` would be one diagram's name twice.
  if (fs.existsSync(path.join(layerDir, `${slug}.json`)) || fs.existsSync(path.join(layerDir, `${slug}.dbml`))) {
    nameTaken();
    return undefined;
  }

  // 4. The plan. Decided before the first file lands, as Draw from dbt
  // decides it: the library folder new tables go in (a flat library stays
  // flat), and whether relationships go to the tables' files (#126). A file
  // it would change that is open with unsaved edits stops it here.
  let plan: DbmlImportPlan;
  let folder: string | undefined;
  let dirty: string[];
  /** Every file a DBML project's save writes (empty for a YAML project). */
  let planned: string[] = [];
  try {
    // A DBML table always goes to the chosen layer's folder: groupsByFolder speaks for YAML libraries only.
    folder = dbml || tableLibraryService.groupsByFolder(new Set(layerService.getValidLayerIds())) ? chosenLayer : undefined;
    const libraryRelationships = dbml || usesLibraryRelationships(
      tableLibraryService.listTables(),
      subjectAreaService.countSubjectAreaFileRelationships(workspaceRoot, semanticDir),
      tableLibraryService.hasUnreadableRelationships(),
      // A DBML table's relationships can only live in the library (D5, §5.1).
      tableLibraryService.hasDbmlLibrary?.() ?? false,
    );
    plan = planDbmlImport({
      model,
      layout,
      layer: chosenLayer,
      subjectAreaName: slug,
      fileName,
      library: {
        findTableName: (n) => tableLibraryService.findTableNameIgnoringCase(n),
        getTable: (n) => tableLibraryService.getTable(n),
      },
      libraryRelationships,
      // A DBML diagram keeps no copy: every relationship goes to the library.
      diagramCopies: libraryRelationships && !dbml
        ? drawnDiagramCopies(readSubjectAreaRelationships(subjectAreaService, workspaceRoot, semanticDir))
        : [],
      // A DBML diagram holds no relationships (D5): one the library cannot take is named, not dropped silently.
      ...(dbml ? { diagramHoldsNoRelationships: true } : {}),
    });
    if (dbml) {
      const refusal = dbmlImportRefusal(plan, (n) => tableLibraryService.tableStorage?.(n));
      if (refusal) {
        showError(`${TITLE}: ${refusal} Nothing was changed.`);
        return undefined;
      }
    }
    planned = dbml && tableLibraryService.planTableWrites
      // Every file the DBML save writes (relationships files too); a refusal surfaces here, before any write.
      ? tableLibraryService.planTableWrites({ save: [...plan.newTables, ...plan.changedLibraryTables].map((model) => ({ model })) }, folder, { dbml: true })
        .writes.map((w) => w.path)
      : [];
    dirty = dirtyFiles([
      ...plan.newTables.map((t) => tableLibraryService.tablePath(t.name, folder)),
      ...plan.changedLibraryTables.map((t) => tableLibraryService.tablePath(t.name)),
      ...planned,
    ]);
    // Throws DuplicateKeyWriteRefused for a library file that is read but may
    // not be written (#164), or RelationshipsRewriteRefused, before the diagram
    // is on disk rather than after. (A DBML plan above already checked its files.)
    if (!dbml) for (const table of plan.changedLibraryTables) tableLibraryService.serializeTable(table);
  } catch (err) {
    if (isRefusedWrite(err)) {
      showRefusal(err, 'Nothing was changed.');
      return undefined;
    }
    telemetry.error('importDbmlFailed');
    const doing = 'while preparing the import';
    showError(oursMessage(TITLE, doing, 'nothing was changed'), {
      [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err),
      [TRY_AGAIN_BUTTON]: tryAgain,
    });
    return undefined;
  }
  const showUnsaved = (dirtyPath: string): void => {
    const file = path.relative(path.dirname(tableLibraryService.getTablesDir()), dirtyPath).split(path.sep).join('/');
    showError(`${TITLE}: ${file} has unsaved changes. Save or revert it, then try again. Nothing was changed.`, {
      [SHOW_FILE_BUTTON]: () => ui.showFile(dirtyPath),
    });
  };
  if (dirty.length > 0) {
    showUnsaved(dirty[0]);
    return undefined;
  }

  // 5. The dry run: what it creates, reuses and leaves out, before any write.
  const semanticRoot = path.join(workspaceRoot, semanticDir);
  const [headline, ...details] = describeDbmlImportPlan(plan, {
    layerLabel,
    ...(dbml ? {
      dbml: {
        // Where the relationships go: the library's `_relationships.dbml` files this save writes.
        relationshipsFiles: planned
          .filter((p) => path.basename(p) === DBML_RELATIONSHIPS_FILE_NAME)
          .map((p) => path.relative(semanticRoot, p).split(path.sep).join('/')),
      },
    } : {}),
  }).split('\n');
  if (!await ui.confirm(headline, details.join('\n'), IMPORT_BUTTON)) return cancelled();

  // 6. Every file, or none.
  const outcome = await writeNewSubjectArea({
    workspaceRoot,
    semanticDir,
    domainPath,
    newTables: plan.newTables,
    folder,
    changedTables: plan.changedLibraryTables,
    documentText: (tableNaming) => serializeDbmlImportDocument(plan.document, tableNaming),
    // The source's positions and sticky-note boxes go where the project keeps a new diagram's layout.
    document: () => ({ ...plan.document, logical: { ...plan.document.logical, relationships: [] } }) as unknown as Record<string, unknown>,
  }, { layerService, tableLibraryService, subjectAreaService, readText: openOrDiskText, dirtyFiles });
  if (!outcome.ok) {
    const { error: err, undone } = outcome;
    if (outcome.nameTaken) {
      nameTaken();
      return undefined;
    }
    // A file the write would change (another diagram it re-renders, §5.7) has unsaved edits.
    if (err instanceof UnsavedFilesRefused) {
      showUnsaved(err.filePaths[0]);
      return undefined;
    }
    const result = writeOutcome(undone, semanticDir);
    // A refusal is explained, not a failure, so it is not counted (as on the canvas).
    if (isRefusedWrite(err)) {
      showRefusal(err, result);
      return undefined;
    }
    telemetry.error('importDbmlFailed');
    const why = environmentWriteProblem(err, workspaceRoot, `${semanticDir}/${chosenLayer}`);
    if (!why) {
      const doing = 'while saving the diagram';
      const ours = undone ? 'nothing was changed' : `some files in ${semanticDir}/ may already have changed`;
      showError(oursMessage(TITLE, doing, ours), {
        [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err),
        [TRY_AGAIN_BUTTON]: tryAgain,
      });
      return undefined;
    }
    showError(`${TITLE} couldn't save the diagram: ${why} ${result}`, { [TRY_AGAIN_BUTTON]: tryAgain });
    return undefined;
  }

  deps.onWritten({ domainPath, modelNames: outcome.written, changedModelNames: outcome.changed });
  if (fromExample) {
    telemetry.feature('exampleDiagram');
  } else {
    telemetry.feature('importDbml');
    if (layout) telemetry.feature('importDbmlLayout');
  }

  await ui.openDiagram(domainPath);
  return { domainPath, plan };

  /** The refusal's own sentence, with Open File when it knows the file. */
  function showRefusal(err: RefusedWrite, outcomeSentence: string): void {
    const location = refusalLocation(err, path.join(workspaceRoot, semanticDir));
    showError(`${TITLE}: ${err.message} ${outcomeSentence}`, location
      ? { [OPEN_FILE_BUTTON]: () => ui.openFileAt(location.filePath, location.line) }
      : {});
  }
}

/**
 * Why a plan cannot become a DBML diagram, or undefined (§5.7, D20): a table
 * it would reuse is stored as YAML (a `use` line cannot import a `.yml`), or
 * a table it would create is named `_relationships` (§2.1).
 */
export function dbmlImportRefusal(plan: DbmlImportPlan, tableStorage: (name: string) => 'yaml' | 'dbml' | undefined): string | undefined {
  const yaml = plan.reusedTables.filter((n) => tableStorage(n) === 'yaml');
  if (yaml.length > 0) {
    return `${yaml.join(', ')} ${yaml.length === 1 ? 'is a YAML table' : 'are YAML tables'} in the Table Library, and a YAML table can't join a DBML diagram. ${DBML_CONVERT_FIRST_MESSAGE}.`;
  }
  const reserved = plan.newTables.find((t) => isReservedTableName(t.name));
  if (reserved) return RESERVED_TABLE_NAME_MESSAGE;
  return undefined;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The real UI. */
export function vscodeImportDbmlUi(): ImportDbmlUi {
  return {
    pickFile: async (defaultFolder) => {
      const picked = await vscode.window.showOpenDialog({
        title: TITLE,
        openLabel: IMPORT_BUTTON,
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { DBML: ['dbml'] },
        ...(defaultFolder ? { defaultUri: vscode.Uri.file(defaultFolder) } : {}),
      });
      return picked?.[0]?.fsPath;
    },
    readFile: async (filePath) => new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))),
    showQuickPick: async (items, options) => vscode.window.showQuickPick([...items], options),
    showInputBox: async (options) => vscode.window.showInputBox(options),
    confirm: async (message, detail, button) =>
      (await vscode.window.showInformationMessage(message, { modal: true, detail }, button)) === button,
    showInformationMessage: async (message, ...items) => vscode.window.showInformationMessage(message, ...items),
    showErrorMessage: async (message, ...items) => vscode.window.showErrorMessage(message, ...items),
    openFileAt: (filePath, line, column) => openTableFileAt(filePath, line, column),
    showFile: async (filePath) => { await vscode.window.showTextDocument(vscode.Uri.file(filePath)); },
    openDiagram: async (domainPath) => {
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(domainPath), SUBJECT_AREA_EDITOR_VIEW_TYPE);
    },
    addLayer: async () => { await vscode.commands.executeCommand('erdStudio.addLayer'); },
    sendFeedback: async (prefill) => { await vscode.commands.executeCommand('erdStudio.reportBug', prefill); },
  };
}
