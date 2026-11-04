/**
 * **Import Power BI or Fabric Semantic Model…** (`erdStudio.importSemanticModel`)
 * — a semantic model saved as files in as a new diagram: a Power BI Project's
 * `<Name>.SemanticModel` folder (or the older `<Name>.Dataset`), as TMDL
 * (`definition/*.tmdl`) or as one `model.bim`, from Power BI Desktop, Fabric
 * Git integration or Tabular Editor.
 *
 * Steps: a folder (an Open dialog) → every file under it, bounded →
 * `findSemanticModels` (a quick pick when the folder holds several) → read
 * the model's files (`workspace.fs`) → `readSemanticModel` (a model that does
 * not read is reported with file and line and an Open File button) →
 * `semanticModelToDbml` → the DBML goes through Import DBML's own flow
 * (`importDbml` with `source: 'semanticModel'`): the user picks the layer,
 * names the diagram and confirms a dry run that says what was skipped
 * (measures, calculation groups, auto date/time tables…, counted by kind; the
 * full list goes to the log). Cancelling any step writes nothing.
 *
 * Pure parts in `src/services/semanticModelImport.ts`; every vscode call goes
 * through `ImportSemanticModelUi` (and Import DBML's `ImportDbmlUi`).
 */

import * as path from 'path';
import * as vscode from 'vscode';

import {
  OPEN_FILE_BUTTON,
  SEND_FEEDBACK_BUTTON,
  feedbackPrefill,
  oursMessage,
  showErrorWithActions,
  type ErrorActions,
  type FeedbackPrefill,
} from '../services/commandErrors';
import {
  describeImportProblems,
  semanticModelRenameNote,
  semanticModelSkippedSummary,
  walkFiles,
  type DirEntries,
} from '../services/importSources';
import { log } from '../services/logger';
import {
  findSemanticModels,
  readSemanticModel,
  semanticModelToDbml,
  type SemanticModelEntry,
  type SemanticModelFile,
} from '../services/semanticModelImport';
import { telemetry } from '../services/telemetryService';
import {
  IMPORT_TITLES,
  importDbml,
  suppliedDbmlUi,
  vscodeImportDbmlUi,
  type ImportDbmlDeps,
  type ImportDbmlResult,
  type ImportDbmlUi,
} from './importDbml';
import { openTableFileAt } from './openModelFile';

export const IMPORT_SEMANTIC_MODEL_COMMAND = 'erdStudio.importSemanticModel';

const TITLE = IMPORT_TITLES.semanticModel;

/** At most this many files under the picked folder are listed. */
export const MAX_SEMANTIC_MODEL_FILES = 5000;
/** At most this much model text (characters). */
export const MAX_SEMANTIC_MODEL_CHARS = 50 * 1024 * 1024;

/** The button that picks another folder after one with no model. */
export const CHOOSE_ANOTHER_FOLDER_BUTTON = 'Choose Another Folder';

/** The model quick pick's item. */
export interface SemanticModelItem extends vscode.QuickPickItem {
  entry: SemanticModelEntry;
}

/** Every vscode call the semantic-model half of the flow makes, injectable for tests. */
export interface ImportSemanticModelUi {
  /** The folder holding the model; undefined when cancelled. */
  pickFolder(defaultFolder: string | undefined): Promise<string | undefined>;
  readDirectory(folder: string): Promise<DirEntries>;
  /** A file's text (`workspace.fs`). Throws when it cannot be read. */
  readFile(filePath: string): Promise<string>;
  pickModel(items: readonly SemanticModelItem[], options: vscode.QuickPickOptions): Promise<SemanticModelItem | undefined>;
  /** Resolves the button picked; the flow never awaits it. */
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
  openFileAt(filePath: string, line?: number): Promise<void>;
  sendFeedback(prefill: FeedbackPrefill): Promise<void>;
}

export interface ImportSemanticModelDeps extends Omit<ImportDbmlDeps, 'ui' | 'source' | 'origin'> {
  modelUi?: ImportSemanticModelUi;
  /** The Import DBML half (layer, name, dry run, open). */
  ui?: ImportDbmlUi;
}

/**
 * Run the flow. Resolves Import DBML's result once a diagram is written, or
 * undefined when the user cancels, no model reads, or something failed (each
 * case has already said so).
 */
export async function importSemanticModel(deps: ImportSemanticModelDeps): Promise<ImportDbmlResult | undefined> {
  const ui = deps.modelUi ?? vscodeImportSemanticModelUi();
  const cancelled = (): undefined => {
    telemetry.feature('importSemanticModelCancelled');
    return undefined;
  };
  const showError = (message: string, actions: ErrorActions = {}): void => {
    showErrorWithActions((m, ...items) => ui.showErrorMessage(m, ...items), message, actions, (choice, err) => {
      log.error(`[ERD Studio] ${TITLE}: "${choice}" failed:`, err);
      const doing = `while running ${choice}`;
      showError(oursMessage(TITLE, doing, 'nothing was changed'), { [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(TITLE, doing, err)) });
    });
  };
  const invalid = (message: string, actions: ErrorActions = {}): undefined => {
    telemetry.feature('importSemanticModelInvalid');
    showError(message, actions);
    return undefined;
  };

  // 1. The folder, and the models in it.
  const folder = await ui.pickFolder(deps.workspaceRoot || undefined);
  if (!folder) return cancelled();
  const folderName = path.basename(folder);
  // Only model files count toward the bound: findSemanticModels reads nothing
  // else, and a big repo holding one model somewhere must still import from its root.
  const walk = await walkFiles(folder, (f) => ui.readDirectory(f), { include: isSemanticModelFile, limit: MAX_SEMANTIC_MODEL_FILES });
  if (walk.truncated) {
    showError(
      `${TITLE}: ${folderName} holds more than ${MAX_SEMANTIC_MODEL_FILES} model files. Pick the <Name>.SemanticModel folder itself, or the folder just above it.`,
      { [CHOOSE_ANOTHER_FOLDER_BUTTON]: () => importSemanticModel(deps) },
    );
    return undefined;
  }
  // Paths under the picked folder (its own name included, so a picked X.SemanticModel is still found).
  const relative = (full: string): string => path.join(folderName, path.relative(folder, full)).split(path.sep).join('/');
  const fullOf = new Map(walk.files.map((full) => [relative(full), full]));
  const entries = findSemanticModels([...fullOf.keys()]);
  if (entries.length === 0) {
    return invalid(
      `${TITLE}: no semantic model found in ${folderName}. Pick the folder that holds <Name>.SemanticModel (saved as TMDL or as model.bim), or that folder itself.`,
      { [CHOOSE_ANOTHER_FOLDER_BUTTON]: () => importSemanticModel(deps) },
    );
  }
  let entry = entries[0];
  if (entries.length > 1) {
    const picked = await ui.pickModel(
      entries.map((e) => ({ label: e.name, description: e.kind === 'tmdl' ? 'TMDL' : 'model.bim', detail: e.root, entry: e })),
      { title: TITLE, placeHolder: 'Which semantic model?', ignoreFocusOut: true },
    );
    if (!picked) return cancelled();
    entry = picked.entry;
  }

  // 2. Read it.
  const files: SemanticModelFile[] = [];
  let chars = 0;
  for (const file of entry.files) {
    let text: string;
    try {
      text = await ui.readFile(fullOf.get(file) ?? file);
    } catch (err) {
      log.error(`[ERD Studio] ${TITLE}: could not read a file:`, err);
      showError(`${TITLE} couldn't read ${file}. Check that the file still exists and that you can open it, then try again.`);
      return undefined;
    }
    chars += text.length;
    if (chars > MAX_SEMANTIC_MODEL_CHARS) {
      showError(`${TITLE}: ${entry.name} holds more than ${Math.round(MAX_SEMANTIC_MODEL_CHARS / 1024 / 1024)} MB of model files, too much to import at once.`);
      return undefined;
    }
    files.push({ path: file, text });
  }
  let read: ReturnType<typeof readSemanticModel>;
  let converted: ReturnType<typeof semanticModelToDbml>;
  try {
    read = readSemanticModel(files);
    if (!read.ok) {
      const first = read.problems.find((p) => fullOf.has(p.file));
      return invalid(
        describeImportProblems(TITLE, read.problems),
        first ? { [OPEN_FILE_BUTTON]: () => ui.openFileAt(fullOf.get(first.file)!, first.line) } : {},
      );
    }
    converted = semanticModelToDbml(read.model);
  } catch (err) {
    telemetry.error('importSemanticModelFailed');
    const doing = 'while converting the semantic model';
    log.error(`[ERD Studio] ${TITLE} failed ${doing}:`, err);
    showError(oursMessage(TITLE, doing, 'nothing was changed'), {
      [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(TITLE, doing, err)),
    });
    return undefined;
  }
  const warnings = [...read.warnings, ...converted.warnings];
  for (const line of [...converted.skipped, ...warnings]) log.info(`[ERD Studio] ${TITLE}: ${line}`);

  // 3. Import DBML's flow, with the converted DBML as its file.
  const renameNote = semanticModelRenameNote(converted.renamed);
  const filePath = path.join(deps.workspaceRoot, `${entry.name}.dbml`);
  const { modelUi: _modelUi, ui: importUi, ...rest } = deps;
  return importDbml({
    ...rest,
    ui: suppliedDbmlUi(importUi ?? vscodeImportDbmlUi(), filePath, converted.dbml),
    source: 'semanticModel',
    origin: {
      from: `from the semantic model ${entry.name}`,
      notes: [...(renameNote ? [renameNote] : []), ...warnings],
      skipped: semanticModelSkippedSummary(converted.skippedCounts),
    },
  }, { filePath });
}

/** A file {@link findSemanticModels} can build a model from (`.tmdl` or `.bim`). */
export function isSemanticModelFile(name: string): boolean {
  return /\.(tmdl|bim)$/i.test(name);
}

/** The real UI. */
export function vscodeImportSemanticModelUi(): ImportSemanticModelUi {
  return {
    pickFolder: async (defaultFolder) => {
      const picked = await vscode.window.showOpenDialog({
        title: `${TITLE}: the folder that holds <Name>.SemanticModel`,
        openLabel: 'Import',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        ...(defaultFolder ? { defaultUri: vscode.Uri.file(defaultFolder) } : {}),
      });
      return picked?.[0]?.fsPath;
    },
    readDirectory: async (folder) =>
      (await vscode.workspace.fs.readDirectory(vscode.Uri.file(folder)))
        .map(([name, type]) => [name, (type & vscode.FileType.Directory) !== 0] as const),
    readFile: async (filePath) => new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))),
    pickModel: async (items, options) => vscode.window.showQuickPick([...items], options),
    showErrorMessage: async (message, ...items) => vscode.window.showErrorMessage(message, ...items),
    openFileAt: (filePath, line) => openTableFileAt(filePath, line),
    sendFeedback: async (prefill) => { await vscode.commands.executeCommand('erdStudio.reportBug', prefill); },
  };
}
