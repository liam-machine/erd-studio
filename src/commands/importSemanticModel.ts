/**
 * **Import Power BI or Fabric Semantic Model…** (`erdStudio.importSemanticModel`)
 * — a semantic model saved as files in as a new diagram: a Power BI Project's
 * `<Name>.SemanticModel` folder (or the older `<Name>.Dataset`), as TMDL
 * (`definition/*.tmdl`) or as one `model.bim`, from Power BI Desktop, Fabric
 * Git integration or Tabular Editor, or a Tabular Editor Save to Folder model
 * (`database.json` and a JSON file per table, column, relationship…).
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
 * **The quick path** (`quickImportSemanticModel`: the start screen's
 * **Import your Power BI semantic model** and the start suggestion) looks in
 * the open folder itself: one model is taken (several: the pick), Import
 * DBML's quick layer and name, and the draft (the read-only preview,
 * `docs/dev/draft-first.md` §5.1) is the one question; its Change options…
 * asks the layer and name, those offered first. No model found: the
 * step-by-step flow. With a draft, several models are not picked: the first
 * is drawn and the draft's **Model** switcher offers the others. On the
 * automatic draft (`draft.quiet`) nothing is asked or shown.
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
import { ledgerLogLines, type LedgerEntry } from '../services/importLedger';
import { SHOW_IMPORT_REPORT_COMMAND, SHOW_IMPORT_REPORT_LABEL, problemLedger } from '../services/importReport';
import { recordImportReport } from '../services/importReportStore';
import {
  decodeSemanticModelFile,
  findSemanticModels,
  readSemanticModel,
  semanticModelToDbml,
  type SemanticModelEntry,
  type SemanticModelFile,
  type SemanticModelKind,
  type SemanticModelProblem,
} from '../services/semanticModelImport';
import { telemetry } from '../services/telemetryService';
import { IMPORT_LIMIT_FEATURES, dropQuietly, type ImportInputLimit } from '../services/importTelemetry';
import { recordImportOutcome } from '../services/importOutcomeTelemetry';
import type { TelemetryFeature } from '../services/telemetryPayload';
import {
  IMPORT_TITLES,
  changeOptionsDraft,
  importDbml,
  suppliedDbmlUi,
  vscodeImportDbmlUi,
  type ImportDbmlDeps,
  type ImportDbmlResult,
  type ImportDbmlUi,
} from './importDbml';
import { openTableFileAt } from './openModelFile';
import type { DraftScopes } from '../types/draft';

export const IMPORT_SEMANTIC_MODEL_COMMAND = 'erdStudio.importSemanticModel';

const TITLE = IMPORT_TITLES.semanticModel;

/** At most this many model files (`.tmdl`, `.bim`, `database.json`) under the picked folder are listed. */
export const MAX_SEMANTIC_MODEL_FILES = 5000;
/**
 * At most this many files of the Save to Folder models under the picked
 * folder (one JSON file per table, column, measure, partition…, so a
 * mid-size model has thousands). Their text is bounded by
 * {@link MAX_SEMANTIC_MODEL_CHARS} too.
 */
export const MAX_FOLDER_MODEL_FILES = 100_000;
/** At most this much model text (characters). */
export const MAX_SEMANTIC_MODEL_CHARS = 50 * 1024 * 1024;

/** The button that picks another folder after one with no model. */
export const CHOOSE_ANOTHER_FOLDER_BUTTON = 'Choose Another Folder';

/** At most this many models in the draft's Model switcher (`DRAFT_SCOPE_LIMIT`). */
export const MODEL_SCOPE_LIMIT = 12;

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
  /** Runs Show Import Report (`erdStudio.showImportReport`) for import `reportId`. Absent: no such button. */
  showImportReport?(reportId?: number): Promise<void>;
}

export interface ImportSemanticModelDeps extends Omit<ImportDbmlDeps, 'ui' | 'source' | 'origin' | 'sqlDialect' | 'guideSource'> {
  modelUi?: ImportSemanticModelUi;
  /** The Import DBML half (layer, name, dry run, open). */
  ui?: ImportDbmlUi;
}

/**
 * Run the flow. Resolves Import DBML's result once a diagram is written, or
 * undefined when the user cancels, no model reads, or something failed (each
 * case has already said so).
 */
export async function importSemanticModel(
  deps: ImportSemanticModelDeps,
  quick?: { folder: string; model?: string },
  scope?: { folder: string; model: string },
): Promise<ImportDbmlResult | undefined> {
  const quiet = deps.draft?.quiet === true;
  const ui = quiet ? quietImportSemanticModelUi(deps.modelUi ?? vscodeImportSemanticModelUi()) : deps.modelUi ?? vscodeImportSemanticModelUi();
  const cancelled = (): undefined => {
    if (!quiet) telemetry.feature('importSemanticModelCancelled');
    return undefined;
  };
  const showError = (message: string, actions: ErrorActions = {}): void => {
    showErrorWithActions((m, ...items) => ui.showErrorMessage(m, ...items), message, actions, (choice, err) => {
      log.error(`[ERD Studio] ${TITLE}: "${choice}" failed:`, err);
      const doing = `while running ${choice}`;
      showError(oursMessage(TITLE, doing, 'nothing was changed'), { [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(TITLE, doing, err)) });
    });
  };
  /**
   * The model brought nothing in (`importOutcomeSemanticModelFail`). A success
   * is counted by Import DBML's flow, once its plan is ready; quiet, the draft's
   * early end is `draftDrop*` instead.
   */
  const failed = (): void => {
    if (!quiet) recordImportOutcome((key) => telemetry.featureQuiet(key), { importer: 'powerbi', outcome: 'failed' });
  };
  /** The model does not import: `importSemanticModelInvalid` and why (`reason`); quiet, the draft is dropped as unreadable. */
  const invalid = (message: string, actions: ErrorActions = {}, reason?: TelemetryFeature): undefined => {
    failed();
    if (quiet) dropQuietly(deps.draft, 'unreadable');
    else {
      telemetry.feature('importSemanticModelInvalid');
      if (reason) telemetry.feature(reason);
    }
    showError(message, actions);
    return undefined;
  };
  /** The input could not be taken in (too many files, too much text, a file that does not read). */
  const limited = (limit: ImportInputLimit): void => {
    failed();
    if (quiet) dropQuietly(deps.draft, 'unreadable');
    else telemetry.feature(IMPORT_LIMIT_FEATURES[limit]);
  };

  // 1. The folder, and the models in it.
  const folder = quick?.folder ?? scope?.folder ?? await ui.pickFolder(deps.workspaceRoot || undefined);
  if (!folder) return cancelled();
  const folderName = path.basename(folder);
  // The names paths are listed under: the picked folder's own (so a picked X.SemanticModel is still found),
  // and its parent's too when the pick is a model's `definition/` folder (so X.SemanticModel names the model, not "definition").
  const prefix = modelPathPrefix(folder);
  // Only model files count toward the bound: findSemanticModels reads nothing
  // else, and a big repo holding one model somewhere must still import from its root.
  // Model files, and the files of formats this import does not read (only to say so by name when no model is found).
  const walk = await walkSemanticModelFiles(folder, (f) => ui.readDirectory(f), { alsoUnread: true });
  // The quick path cannot take "the" model from a folder it could not list, or one with none: the step-by-step flow asks.
  if (quick && (walk.truncated || walk.files.length === 0)) {
    if (quiet) {
      dropQuietly(deps.draft, 'nothingFound');
      return undefined;
    }
    telemetry.feature('quickImportFellBack');
    return importSemanticModel(deps);
  }
  if (walk.truncated) {
    limited('tooManyFiles');
    showError(
      walk.tooBigFolderModel !== undefined
        ? `${TITLE}: the Tabular Editor folder ${path.basename(walk.tooBigFolderModel)} holds more than ${MAX_FOLDER_MODEL_FILES.toLocaleString('en-US')} files, too many to import at once.`
        : `${TITLE}: ${folderName} holds more than ${MAX_SEMANTIC_MODEL_FILES} model files. Pick the <Name>.SemanticModel folder itself, or the folder just above it.`,
      { [CHOOSE_ANOTHER_FOLDER_BUTTON]: () => importSemanticModel(deps) },
    );
    return undefined;
  }
  // Paths under the picked folder (its own name included, so a picked X.SemanticModel is still found).
  const relative = (full: string): string => path.join(...prefix, path.relative(folder, full)).split(path.sep).join('/');
  const fullOf = new Map(walk.files.map((full) => [relative(full), full]));
  const entries = findSemanticModels([...fullOf.keys()]);
  if (entries.length === 0 && quick) {
    if (quiet) {
      dropQuietly(deps.draft, 'nothingFound');
      return undefined;
    }
    telemetry.feature('quickImportFellBack');
    return importSemanticModel(deps);
  }
  if (entries.length === 0) {
    const unread = unreadModelFormat([...fullOf.keys()]);
    return invalid(
      `${TITLE}: no semantic model found in ${folderName}.${unread ? ` ${unread}` : ''} Pick the folder that holds <Name>.SemanticModel (saved as TMDL or as model.bim), or that folder itself.`,
      { [CHOOSE_ANOTHER_FOLDER_BUTTON]: () => importSemanticModel(deps) },
      'importSemanticModelNoModel',
    );
  }
  // Several models (not the switcher's own re-entry, which names the one it wants).
  if (entries.length > 1 && !scope && quick?.model === undefined) telemetry.feature('importSemanticModelSeveral');
  let entry = entries[0];
  /** With a draft and several models: the switcher, and how a choice on it re-enters. */
  let modelScopes: { scopes: DraftScopes; onScope: (id: string) => unknown } | undefined;
  if (deps.draft && entries.length > 1) {
    const wanted = quick?.model ?? scope?.model;
    const offered = entries.slice(0, MODEL_SCOPE_LIMIT);
    entry = offered.find((e) => e.root === wanted) ?? offered[0];
    modelScopes = {
      scopes: {
        label: 'Model',
        current: entry.root,
        options: offered.map((e) => ({
          id: e.root,
          label: path.posix.basename(e.root) || e.name,
          description: SEMANTIC_MODEL_FORMAT_LABELS[e.kind],
        })),
      },
      // The user's own choice: never quiet from here on (a model that does not convert says why).
      onScope: (id) => {
        const loud = deps.draft?.quiet ? { ...deps, draft: { ...deps.draft, quiet: false } } : deps;
        return quick
          ? importSemanticModel(loud, { folder, model: id })
          : importSemanticModel(loud, undefined, { folder, model: id });
      },
    };
  } else if (entries.length > 1) {
    const picked = await ui.pickModel(
      entries.map((e) => ({ label: e.name, description: SEMANTIC_MODEL_FORMAT_LABELS[e.kind], detail: e.root, entry: e })),
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
      limited('unreadable');
      showError(`${TITLE} couldn't read ${file}. Check that the file still exists and that you can open it, then try again.`);
      return undefined;
    }
    chars += text.length;
    if (chars > MAX_SEMANTIC_MODEL_CHARS) {
      limited('tooMuchText');
      showError(`${TITLE}: ${entry.name} holds more than ${Math.round(MAX_SEMANTIC_MODEL_CHARS / 1024 / 1024)} MB of model files, too much to import at once.`);
      return undefined;
    }
    files.push({ path: file, text });
  }
  // Fabric Git integration's `.platform` names the item (its displayName); optional, never an error.
  const platform = await readPlatformFile(ui, folder, prefix, entry);
  if (platform) files.push(platform);
  let read: ReturnType<typeof readSemanticModel>;
  let converted: ReturnType<typeof semanticModelToDbml>;
  try {
    read = readSemanticModel(files);
    if (!read.ok) {
      const first = read.problems.find((p) => fullOf.has(p.file));
      // The report lists every problem with its file and line (the message names the first few).
      const reported = !quiet && ui.showImportReport !== undefined;
      const reportId = !reported ? undefined : recordImportReport({
        source: 'semanticModel',
        title: TITLE,
        from: `from the semantic model ${entry.name}`,
        status: 'failed',
        ledger: problemLedger(read.problems, 'file', 'model file'),
        files: modelFiles(entry.files, fullOf),
      });
      return invalid(
        describeImportProblems(TITLE, read.problems),
        {
          ...(first ? { [OPEN_FILE_BUTTON]: () => ui.openFileAt(fullOf.get(first.file)!, first.line) } : {}),
          ...(reportId !== undefined ? { [SHOW_IMPORT_REPORT_LABEL]: () => ui.showImportReport!(reportId) } : {}),
        },
        SEMANTIC_MODEL_PARSE_FEATURES[entry.kind],
      );
    }
    converted = semanticModelToDbml(read.model);
  } catch (err) {
    telemetry.error('importSemanticModelFailed');
    failed();
    const doing = 'while converting the semantic model';
    log.error(`[ERD Studio] ${TITLE} failed ${doing}:`, err);
    showError(oursMessage(TITLE, doing, 'nothing was changed'), {
      [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(TITLE, doing, err)),
    });
    return undefined;
  }
  const warnings = [...read.warnings, ...converted.warnings];
  // What did not read was left out (each named in the ledger, so in the draft's Not imported list): every message to the log.
  for (const p of read.problems ?? []) log.info(`[ERD Studio] ${TITLE}: ${p.file}${p.line !== undefined ? ` line ${p.line}` : ''}: ${p.message}`);
  for (const line of [...converted.skipped, ...warnings]) log.info(`[ERD Studio] ${TITLE}: ${line}`);
  for (const line of ledgerLogLines(withoutLoggedProblems(converted.ledger ?? [], read.problems ?? []), TITLE)) log.info(`[ERD Studio] ${line}`);

  // 3. Import DBML's flow, with the converted DBML as its file.
  const renameNote = semanticModelRenameNote(converted.renamed);
  const filePath = path.join(deps.workspaceRoot, `${entry.name}.dbml`);
  const { modelUi: _modelUi, ui: importUi, ...rest } = deps;
  const importDeps = {
    ...rest,
    ...(rest.draft && modelScopes ? { draft: { ...rest.draft, ...modelScopes } } : {}),
    ui: suppliedDbmlUi(importUi ?? vscodeImportDbmlUi(), filePath, converted.dbml),
    source: 'semanticModel' as const,
    origin: {
      // The model's own name (Fabric's displayName when it has one), as the Project note says it.
      from: `from the semantic model ${read.model.name}`,
      notes: [...(renameNote ? [renameNote] : []), ...warnings],
      skipped: semanticModelSkippedSummary(converted.skippedCounts),
      ledger: converted.ledger ?? [],
      // The model's files, by the names the ledger gives them: Show Import Report opens them at a line.
      sourceFiles: modelFiles(entry.files, fullOf),
    },
  };
  if (!quick) return importDbml(importDeps, { filePath });
  // Change options…: the same model, the layer and name asked, the quick path's offered first, ending in a draft.
  return importDbml({
    ...importDeps,
    changeOptions: ({ layer, name }) => importDbml({ ...importDeps, ...changeOptionsDraft(importDeps.draft) }, { filePath, preferredLayer: layer, name }),
  }, { filePath, quick: true });
}

/** The model's own files, by the path the reader names them (the ledger's `where.file`) → full path. */
function modelFiles(files: readonly string[], fullOf: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries(files.flatMap((f) => (fullOf.has(f) ? [[f, fullOf.get(f)!]] : [])));
}

/**
 * The ledger without the problems already logged with their own message
 * (the same file and line), so each problem is logged once; a problem with
 * no message of its own (an annotation left out of the column it is under)
 * is still logged from the ledger.
 */
export function withoutLoggedProblems(ledger: readonly LedgerEntry[], problems: readonly SemanticModelProblem[]): LedgerEntry[] {
  const logged = new Set(problems.map((p) => `${p.file}\u0000${p.line ?? ''}`));
  return ledger.filter((e) => e.outcome !== 'problem' || !logged.has(`${e.where?.file ?? ''}\u0000${e.where?.line ?? ''}`));
}

/**
 * Why a model that does not read did not, by format: model.bim and TMDL
 * each have their own count; a Save to Folder model is counted only as
 * `importSemanticModelInvalid` (never as a model.bim).
 */
const SEMANTIC_MODEL_PARSE_FEATURES: Readonly<Record<SemanticModelKind, TelemetryFeature | undefined>> = {
  tmdl: 'importSemanticModelParseTmdl',
  tmsl: 'importSemanticModelParseBim',
  folder: undefined,
};

/**
 * The model folder's Fabric `.platform` file, when it has one (`root` is
 * relative to the picked folder, its own name first). Undefined when there
 * is none or it does not read: the name then comes from the folder.
 */
async function readPlatformFile(ui: ImportSemanticModelUi, folder: string, prefix: readonly string[], entry: SemanticModelEntry): Promise<SemanticModelFile | undefined> {
  const segments = entry.root.replace(/\\/g, '/').split('/').filter((s) => s !== '');
  if (segments[0] !== prefix[0]) return undefined;
  const relativePath = [...segments, '.platform'].join('/');
  // `root` is relative to the folder `prefix.length` levels up from the picked one.
  const base = prefix.length > 1 ? path.dirname(folder) : folder;
  try {
    const text = await ui.readFile(path.join(base, ...segments.slice(1), '.platform'));
    return { path: relativePath, text };
  } catch {
    return undefined;
  }
}

/**
 * The leading names of the paths a picked folder's files are listed under:
 * its own name, and its parent's before it when it is a model's
 * `definition` folder (TMDL's), so `Sales.SemanticModel/definition` is
 * found as the model Sales rather than one named "definition".
 */
export function modelPathPrefix(folder: string): string[] {
  const name = path.basename(folder);
  const parent = path.basename(path.dirname(folder));
  if (name.toLowerCase() === 'definition' && parent && path.dirname(folder) !== folder) return [parent, name];
  return [name];
}

/** The quick path: the semantic model in the open folder itself (the pick only when it holds several). */
export function quickImportSemanticModel(deps: ImportSemanticModelDeps): Promise<ImportDbmlResult | undefined> {
  return importSemanticModel(deps, { folder: deps.workspaceRoot });
}

/** The model UI of the automatic draft: it asks nothing and shows nothing (each message goes to the log). */
export function quietImportSemanticModelUi(base: ImportSemanticModelUi): ImportSemanticModelUi {
  return {
    ...base,
    pickFolder: async () => undefined,
    pickModel: async () => undefined,
    showErrorMessage: async (message) => {
      log.info(`[ERD Studio] ${TITLE} (automatic draft, not shown): ${message}`);
      return undefined;
    },
  };
}

/** A file of a model format this import does not read: a `.pbix` / `.pbit` (a zip). */
export function isUnreadModelFile(name: string): boolean {
  return /\.(pbix|pbit)$/i.test(name);
}

/**
 * When a folder with no model holds one in a format this import does not
 * read, what to do instead (names a file, never its contents); undefined
 * when it holds none.
 */
export function unreadModelFormat(paths: readonly string[]): string | undefined {
  const base = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p;
  const desktop = paths.find((p) => /\.(pbix|pbit)$/i.test(p));
  if (desktop) {
    return `${base(desktop)} is a Power BI Desktop file, which this import does not read: in Power BI Desktop, use File › Save as and pick Power BI project (*.pbip), then import the folder it makes.`;
  }
  const folderModel = paths.find((p) => base(p).toLowerCase() === 'database.json');
  if (folderModel) {
    return `${folderModel} has no tables/ folder of JSON files beside it, so it is not a model saved by Tabular Editor's Save to Folder: pick the folder Tabular Editor saved the whole model to.`;
  }
  return undefined;
}

/** A file {@link findSemanticModels} can build a model from (`.tmdl` or `.bim`), or that starts a Save to Folder model (`database.json`). */
export function isSemanticModelFile(name: string): boolean {
  return /\.(tmdl|bim)$/i.test(name) || /(^|[\\/])database\.json$/i.test(name);
}

/** How the model pick and the draft's Model list name each format. */
export const SEMANTIC_MODEL_FORMAT_LABELS: Readonly<Record<SemanticModelKind, string>> = {
  tmdl: 'TMDL',
  tmsl: 'model.bim',
  folder: 'Tabular Editor folder',
};

/**
 * Every model file under `folder`, bounded by {@link MAX_SEMANTIC_MODEL_FILES}:
 * `.tmdl`, `.bim` and `database.json` (`alsoUnread`: `.pbix` / `.pbit` too,
 * only to name them), then, under each `database.json`'s folder that has a
 * `tables/` folder beside it, every `.json` (a Save to Folder model's files),
 * bounded by {@link MAX_FOLDER_MODEL_FILES} on their own: a model with a
 * file per column is one model, however many files it has. Only model files
 * count toward either bound, so a big repo holding one model somewhere still
 * imports from its root. `tooBigFolderModel` is the Save to Folder model
 * that went over its bound, when that is why the walk was cut short.
 */
export async function walkSemanticModelFiles(
  folder: string,
  readDirectory: (folder: string) => Promise<DirEntries>,
  opts: { alsoUnread?: boolean } = {},
): Promise<{ files: string[]; truncated: boolean; tooBigFolderModel?: string }> {
  const walk = await walkFiles(folder, readDirectory, {
    include: (f) => isSemanticModelFile(f) || (!!opts.alsoUnread && isUnreadModelFile(f)),
    limit: MAX_SEMANTIC_MODEL_FILES,
  });
  if (walk.truncated) return walk;
  const files = new Set(walk.files);
  const roots = walk.files.filter((f) => path.basename(f).toLowerCase() === 'database.json').map((f) => path.dirname(f));
  /** The Save to Folder models' own files, counted toward their own bound. */
  let folderFiles = 0;
  for (const root of roots) {
    // Only a Save to Folder model's folder (a tables/ folder beside its database.json) is walked: a database.json
    // of another tool (db-migrate's, at a repo's root) must not pull in every JSON file of the repo.
    let entries: DirEntries;
    try {
      entries = await readDirectory(root);
    } catch {
      continue;
    }
    if (!entries.some(([name, isDirectory]) => isDirectory && name.toLowerCase() === 'tables')) continue;
    const inner = await walkFiles(root, readDirectory, { include: (f) => /\.json$/i.test(f), limit: MAX_FOLDER_MODEL_FILES - folderFiles });
    for (const f of inner.files) {
      if (!files.has(f)) folderFiles++;
      files.add(f);
    }
    if (inner.truncated) return { files: [...files], truncated: true, tooBigFolderModel: root };
  }
  return { files: [...files].sort(), truncated: false };
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
    // UTF-8, or UTF-16 by its BOM (older Visual Studio tooling saves model.bim so).
    readFile: async (filePath) => decodeSemanticModelFile(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))),
    pickModel: async (items, options) => vscode.window.showQuickPick([...items], options),
    showErrorMessage: async (message, ...items) => vscode.window.showErrorMessage(message, ...items),
    openFileAt: (filePath, line) => openTableFileAt(filePath, line),
    sendFeedback: async (prefill) => { await vscode.commands.executeCommand('erdStudio.reportBug', prefill); },
    showImportReport: async (reportId) => { await vscode.commands.executeCommand(SHOW_IMPORT_REPORT_COMMAND, reportId); },
  };
}
