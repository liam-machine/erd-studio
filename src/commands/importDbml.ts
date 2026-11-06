/**
 * **Import DBML…** (`erdStudio.importDbml`) — a DBML file in as a NEW logical
 * subject area: ERD Studio's own rich export (`toDbmlRich`, "Rich DBML") or
 * a file from dbdiagram.io or any other DBML tool. No dbt needed: it reads
 * only the chosen file. Its Project's `erd_layout`, when it has one (the rich
 * export writes it), places the tables and sticky notes; a dbdiagram.io
 * layout file beside it is not read.
 *
 * Steps: file → read it (`workspace.fs`) → `readDbml` (a file that is not
 * valid DBML is reported with its line numbers and an Open File button) →
 * layer → name (the rule New Subject Area uses) → the **draft** (Draft-first,
 * `docs/dev/draft-first.md` §5.1: the read-only preview of the diagram, with
 * Keep, Change options…, Discard and More ways to start) → write → open the
 * new diagram. Cancelling any step writes nothing. With no preview (a test's
 * fake, a host without one) the dry run is the old modal, Import / Cancel.
 *
 * The mapping is the pure planner's (`planDbmlImport` in
 * `src/services/dbmlImport.ts`); the files are written the way Import from dbt
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

import { slugFromName, validateTypedDiagramName } from './diagramName';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { classifySemanticFile, diagramFilePath } from '@erd-studio/core';
import { DBML_CONVERT_FIRST_MESSAGE } from '@erd-studio/core/dbml';

import {
  analyseDbml,
  planDbmlImport,
  serializeDbmlImportDocument,
  suggestDbmlSubjectAreaName,
  summariseDbmlImportPlan,
  type DbmlImportPlan,
  type DescribeDbmlImportOptions,
} from '../services/dbmlImport';
import { afterScope, draftFromImportPlan, importPlanFingerprint, DRAFT_REDRAWN_NOTICE } from '../services/draftModel';
import type { Draft, DraftKeepOutcome, DraftPreview, DraftScopes, DraftTarget, DraftTrigger } from '../types/draft';
import type { DbmlDiagnostic } from '../services/dbmlImportParse';
import {
  ADD_LAYER_BUTTON,
  CHOOSE_ANOTHER_NAME_BUTTON,
  NO_LAYERS_MESSAGE,
  OPEN_DIAGRAM_BUTTON,
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
import type { TelemetryErrorCode, TelemetryFeature } from '../services/telemetryPayload';
import type { SubjectAreaService } from '../services/domainService';
import type { LayerService } from '../services/layerService';
import type { TableLibraryService } from '../services/logicalModelService';
import type { SemanticTable } from '../types/semantic';
import { dirtyFiles, openOrDiskText } from '../providers/dirtyDocuments';
import { readSubjectAreaRelationships } from './moveRelationshipsToLibrary';
import { openTableFileAt } from './openModelFile';
import { log } from '../services/logger';
import { WHICH_LAYER_FOR_DIAGRAM, defaultDiagramLayer } from '../services/layerWording';

export const IMPORT_DBML_COMMAND = 'erdStudio.importDbml';

const TITLE = 'Import DBML';

/** Where the DBML comes from: the user's file, the built-in example, or a model ERD Studio converted to DBML first. */
export type ImportDbmlSource = 'file' | 'example' | 'sql' | 'semanticModel';

/** The title every prompt and message of a run shows, per source. */
export const IMPORT_TITLES: Readonly<Record<ImportDbmlSource, string>> = {
  file: TITLE,
  example: TITLE,
  sql: 'Import SQL DDL',
  semanticModel: 'Import Semantic Model',
};

/**
 * The funnel keys each source counts (`telemetry/README.md`): a finished
 * import, a cancel at any step, input that could not be read (the user's
 * file, not a failure) and a failure of ours. The example counts only its
 * finish, so the Import DBML counts stay the user's own files.
 */
export const IMPORT_SOURCE_TELEMETRY: Readonly<Record<ImportDbmlSource, {
  done: TelemetryFeature;
  cancelled?: TelemetryFeature;
  invalid?: TelemetryFeature;
  failed: TelemetryErrorCode;
}>> = {
  file: { done: 'importDbml', cancelled: 'importDbmlCancelled', invalid: 'importDbmlInvalid', failed: 'importDbmlFailed' },
  example: { done: 'exampleDiagram', failed: 'importDbmlFailed' },
  sql: { done: 'importSqlDdl', cancelled: 'importSqlDdlCancelled', invalid: 'importSqlDdlInvalid', failed: 'importSqlDdlFailed' },
  semanticModel: {
    done: 'importSemanticModel',
    cancelled: 'importSemanticModelCancelled',
    invalid: 'importSemanticModelInvalid',
    failed: 'importSemanticModelFailed',
  },
};

/**
 * A model ERD Studio converted to DBML before the import (SQL DDL, a
 * semantic model): what the dry run says it came from, and what the
 * conversion left out or changed. Shown to the user only, never counted.
 */
export interface ImportDbmlOrigin {
  /** After "Import N tables" in the dry run's headline: `from 2 SQL files (PostgreSQL)`. */
  from: string;
  /** The new diagram's description (default: the DBML's Project note). */
  description?: string;
  /** Kept, but worth saying (renamed tables, inferred keys…), one point each. */
  notes?: readonly string[];
  /** What the conversion left out, counted by kind, one point each. */
  skipped?: readonly string[];
}

export { ADD_LAYER_BUTTON, CHOOSE_ANOTHER_NAME_BUTTON, NO_LAYERS_MESSAGE, OPEN_IT_BUTTON, SHOW_FILE_BUTTON, TRY_AGAIN_BUTTON };
/** The fallback dry run's buttons (no preview): Import, and Change Options… on a quick import. */
export const IMPORT_BUTTON = 'Import';
export const CHANGE_OPTIONS_BUTTON = 'Change Options…';
export { OPEN_FILE_BUTTON };

/** How many of a file's DBML problems the message names; the rest are counted. */
const DIAGNOSTICS_SHOWN = 3;
/** @dbml/parse's message for several columns on one line (`id int [pk] name varchar`). */
const SEVERAL_FIELDS_ON_ONE_LINE = /These fields must be some inline settings/i;

/** Every vscode call the flow makes, injectable for tests. */
export interface ImportDbmlUi {
  /**
   * The DBML file to import (an Open dialog filtered to `.dbml`); undefined
   * when cancelled. It opens on `defaultPath`: a folder, or a file to have
   * that file chosen already.
   */
  pickFile(defaultPath: string | undefined): Promise<string | undefined>;
  /** A file's text (`workspace.fs`). Throws when it cannot be read. */
  readFile(filePath: string): Promise<string>;
  showQuickPick<T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions): Promise<T | undefined>;
  showInputBox(options: vscode.InputBoxOptions): Promise<string | undefined>;
  /** A modal: `message`, the `detail` under it, `button` and Cancel. True when `button` was picked. */
  confirm(message: string, detail: string, button: string): Promise<boolean>;
  /**
   * The fallback dry run's modal with several buttons (Import, Change
   * Options…) and Cancel: the button picked, undefined for Cancel. Absent
   * (a test's fake): {@link confirm} with Import alone.
   */
  choose?(message: string, detail: string, buttons: readonly string[]): Promise<string | undefined>;
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
  > & Partial<Pick<TableLibraryService, 'hasDbmlLibrary' | 'planTableWrites' | 'writesDbml' | 'tableStorage' | 'invalidateCache' | 'listsSchemaFolder'>>;
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
   * Where the DBML comes from (default `'file'`). `'example'` when Open
   * Example Diagram supplies it: a finished run counts `exampleDiagram`
   * instead of `importDbml`, and a cancel counts nothing, so the Import DBML
   * counts stay the user's own files. `'sql'` / `'semanticModel'` when Import
   * SQL DDL… / Import Semantic Model… converted the user's files to DBML:
   * the run shows that command's title and counts its own keys
   * ({@link IMPORT_SOURCE_TELEMETRY}). It travels with `deps`, so Try Again
   * and Choose Another Name keep it.
   */
  source?: ImportDbmlSource;
  /** With `'sql'` / `'semanticModel'`: what the dry run says about the conversion. */
  origin?: ImportDbmlOrigin;
  /**
   * A DBML file in the open folder (the start screen's look at it found one),
   * which the Open dialog then starts on, chosen, so Import takes it in one
   * press. Bounded and quiet: undefined (or a rejection) opens the dialog on
   * the folder, as before. Absent: never looked up.
   */
  findDefaultFile?: () => Promise<string | undefined>;
  /**
   * A quick import's **Change options…** on the draft (or the fallback dry
   * run): the step-by-step flow, preselected with what the quick path chose.
   * Absent: no such link. The flow it runs ends in a draft again (its trigger
   * `changeOptions`).
   */
  changeOptions?: (chosen: { layer: string; name: string }) => unknown;
  /**
   * The draft preview (Draft-first, §5.1): step 5 shows the plan as a
   * read-only diagram and waits for Keep instead of the dry run's modal.
   * Absent (a test's fake, a host with no preview): the modal.
   */
  draft?: ImportDraftOptions;
}

/** How an import shows its draft (`docs/dev/draft-first.md` §5.1). */
export interface ImportDraftOptions {
  /** The one preview of this extension host. */
  preview: DraftPreview;
  /** What opened it (telemetry and focus only). */
  trigger: DraftTrigger;
  /**
   * The automatic draft (the ERD Studio icon): no question is asked and no
   * message shown before the draft (they go to the log), and an early end
   * counts nothing here (the host counts `draftUnavailable`); never a
   * `*Cancelled` or `*Invalid` key.
   */
  quiet?: boolean;
  /** The switcher (several semantic models, the examples). */
  scopes?: DraftScopes;
  /** The switcher was used: the caller re-enters with that choice and the same preview. */
  onScope?(scopeId: string): unknown;
  /** Bumped by the semantic-dir watchers for changes that are not ERD Studio's own: a Keep after one re-plans. */
  generation?(): number;
  /** No stage colours: a folder without dbt (default true). */
  logicalOnly?: boolean;
}

/**
 * Where Try Again and Choose Another Name re-enter the flow: with the file
 * and layer the user already chose (the file is read again, so a fix made
 * meanwhile is picked up).
 */
export interface ImportDbmlResume {
  /** The file; absent: the Open dialog asks (starting on `findDefaultFile`'s). */
  filePath?: string;
  layer?: string;
  /** The name to offer again (Try Again); the suggested one when absent. */
  name?: string;
  /**
   * The quick path: no layer or name question. The layer is `layer`, else
   * the one the file names (a TableGroup or schema called like a layer),
   * else New Diagram's default for a project's first diagram
   * (`defaultDiagramLayer`); the name is `name`, else the suggestion, made
   * unique. The dry run is the only question.
   */
  quick?: boolean;
  /** The layer the layer pick starts on (Change Options…), ahead of the file's suggestion. */
  preferredLayer?: string;
  /**
   * A Keep found the project's files changed since its draft was planned
   * (§5.1 Staleness): the plan is made again, and when its fingerprint is
   * `fingerprint` it is written at once, settling the waiting Keep with
   * `settle`; otherwise the Keep is settled `{ kept: false }` and the new
   * draft is shown with the redrawn notice. `draft` is the draft that Keep
   * answered, asked again when the write does not land.
   */
  redraw?: { fingerprint: string; settle(outcome: DraftKeepOutcome): void; draft?: Draft };
}

export interface ImportDbmlResult {
  domainPath: string;
  plan: DbmlImportPlan;
}

/**
 * How far a run got, for the message when something throws that the flow did
 * not expect (#236): the file, Try Again's re-run, the diagram once it is on
 * disk, and the Keep still waiting.
 */
interface ImportRunProgress {
  fileName?: string;
  /** Re-enters with what the user already chose (the file, then the layer and name). */
  retry?: () => unknown;
  /** Set once every file is written: what failed after that was the refresh or the open. */
  written?: { domainPath: string; shown: string };
  /** The user is waiting on this run: false only for the automatic draft before its Keep. */
  loud: boolean;
  /** The draft's Keep, not settled yet. */
  settle?: (outcome: DraftKeepOutcome) => void;
}

/** The title an unexpected failure is said under (Open Example Diagram is its own command, #236). */
function failureTitle(source: ImportDbmlSource): string {
  return source === 'example' ? 'Open Example Diagram' : IMPORT_TITLES[source];
}

/**
 * Run the flow. Resolves undefined when the user cancels, when the file
 * cannot be imported, or when a write fails (each case has already said so).
 * Anything that throws is counted once and said as ERD Studio's problem, with
 * Send Feedback (#236): it never reaches VS Code's generic "command failed".
 * The automatic draft before its Keep still rethrows, so the host counts it
 * (`draftBuildFailed`) and shows nothing.
 */
export async function importDbml(deps: ImportDbmlDeps, resume?: ImportDbmlResume): Promise<ImportDbmlResult | undefined> {
  const base = deps.ui ?? vscodeImportDbmlUi();
  const source = deps.source ?? 'file';
  const ui = deps.draft?.quiet ? quietImportDbmlUi(base, IMPORT_TITLES[source]) : base;
  const progress: ImportRunProgress = { loud: !deps.draft?.quiet };
  try {
    return await runImportDbml(deps, ui, base, resume, progress);
  } catch (err) {
    telemetry.error(IMPORT_SOURCE_TELEMETRY[source].failed);
    // A Keep left waiting gets its answer: kept when the diagram is on disk.
    progress.settle?.(progress.written ? { kept: true } : { kept: false });
    if (!progress.loud) throw err;
    log.error(`[ERD Studio] ${failureTitle(source)} failed:`, err);
    reportUnexpectedImportFailure(base, source, progress, err);
    return undefined;
  }
}

/**
 * The words for a throw the flow did not expect: always ERD Studio's. Before
 * the write nothing was changed (Send Feedback, Try Again); after it, the
 * diagram exists and only opening it failed (Open Diagram, Send Feedback).
 */
function reportUnexpectedImportFailure(ui: ImportDbmlUi, source: ImportDbmlSource, progress: ImportRunProgress, err: unknown): void {
  const title = failureTitle(source);
  const show = (message: string, actions: ErrorActions): void => showErrorWithActions(
    (m, ...items) => ui.showErrorMessage(m, ...items),
    message,
    actions,
    (choice, actionErr) => log.error(`[ERD Studio] ${title}: "${choice}" failed:`, actionErr),
  );
  const written = progress.written;
  if (written) {
    const doing = 'while opening the new diagram';
    show(
      `${title} created ${written.shown}, but hit a problem in ERD Studio opening it. This isn't something you did. Please send us a report.`,
      {
        [OPEN_DIAGRAM_BUTTON]: () => ui.openDiagram(written.domainPath),
        [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(title, doing, err)),
      },
    );
    return;
  }
  const doing = source === 'example'
    ? 'while opening the example diagram'
    : source !== 'file'
      ? 'while importing the converted model'
      : progress.fileName ? `while importing ${progress.fileName}` : 'while importing';
  const retry = progress.retry;
  show(oursMessage(title, doing, 'nothing was changed'), {
    [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(title, doing, err)),
    ...(retry ? { [TRY_AGAIN_BUTTON]: retry } : {}),
  });
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

async function runImportDbml(
  deps: ImportDbmlDeps,
  ui: ImportDbmlUi,
  loudUi: ImportDbmlUi,
  resume: ImportDbmlResume | undefined,
  progress: ImportRunProgress,
): Promise<ImportDbmlResult | undefined> {
  const { workspaceRoot, semanticDir, layerService, subjectAreaService, tableLibraryService } = deps;
  const source = deps.source ?? 'file';
  const counts = IMPORT_SOURCE_TELEMETRY[source];
  const title = IMPORT_TITLES[source];
  /** DBML ERD Studio wrote itself (a conversion, the example): a problem in it is ours, not the user's. */
  const generated = source !== 'file';
  const draftOptions = deps.draft;
  /** The automatic draft: an early end is not the user's cancel or file (the host counts `draftUnavailable`). */
  const quiet = draftOptions?.quiet === true;
  const cancelled = (): undefined => {
    if (counts.cancelled && !quiet) telemetry.feature(counts.cancelled);
    return undefined;
  };

  /** Show an error with its buttons, and run the one the user picks. Never awaited. */
  const showError = (message: string, actions: ErrorActions = {}): void => {
    // A button that fails (a re-run whose read throws) still says so, rather than seeming to do nothing.
    showErrorWithActions((m, ...items) => ui.showErrorMessage(m, ...items), message, actions, (choice, err) => {
      log.error(`[ERD Studio] ${title}: "${choice}" failed:`, err);
      const doing = `while running ${choice}`;
      showError(oursMessage(title, doing, 'nothing was changed'), { [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err) });
    });
  };
  const sendFeedback = (doing: string, err: unknown) => (): unknown => ui.sendFeedback(feedbackPrefill(title, doing, err));

  // 1. The file.
  const filePath = resume?.filePath
    ?? await ui.pickFile((await deps.findDefaultFile?.().catch(() => undefined)) ?? (workspaceRoot || undefined));
  if (!filePath) return cancelled();
  const fileName = path.basename(filePath);
  progress.fileName = fileName;
  const quick = resume?.quick === true;
  /**
   * The deps a re-run takes: the automatic draft's own until its Keep, then
   * never quiet (the user is waiting on that Keep: its messages, a redraw's
   * name box and a Try Again all speak).
   */
  let rerunDeps = deps;
  const again = (more: Omit<ImportDbmlResume, 'filePath'> = {}): (() => unknown) =>
    () => importDbml(rerunDeps, { filePath, ...(quick ? { quick } : {}), ...more });
  progress.retry = again(resume?.layer !== undefined ? { layer: resume.layer } : {});

  let text: string;
  try {
    text = stripBom(await ui.readFile(filePath));
  } catch (err) {
    log.error(`[ERD Studio] ${title}: could not read the file:`, err);
    showError(`${title} couldn't read ${fileName}. Check that the file still exists and that you can open it, then try again.`, {
      [TRY_AGAIN_BUTTON]: again(),
    });
    return undefined;
  }

  // Loaded on first use: the parser is a third of the bundle, and only this command needs it.
  const { readDbml, readDbmlImportLayout } = await import('../services/dbmlImportParse');
  const read = readDbml(text);
  if (!read.ok && generated) {
    // DBML ERD Studio converted itself and cannot read back: our failure.
    telemetry.error(counts.failed);
    log.error(`[ERD Studio] ${title}: the converted DBML does not read:`, read.diagnostics.slice(0, 5).map((d) => `line ${d.line}: ${d.message}`).join('; '));
    const doing = 'while reading the converted model';
    showError(oursMessage(title, doing, 'nothing was changed'), {
      [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, new Error(read.diagnostics[0]?.message ?? 'unreadable DBML')),
    });
    return undefined;
  }
  if (!read.ok) {
    if (counts.invalid && !quiet) telemetry.feature(counts.invalid);
    const first = read.diagnostics[0];
    showError(read.importsOtherFiles ? `${title}: ${first.message}` : describeInvalidDbml(fileName, read.diagnostics), {
      [OPEN_FILE_BUTTON]: () => ui.openFileAt(filePath, first?.line, first?.column),
    });
    return undefined;
  }
  const model = read.model;
  if (model.tables.length === 0) {
    void ui.showInformationMessage(`${title}: ${fileName} has no tables, so there is nothing to import.`);
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
  const diagramCount = subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir).length;
  let layer = creatable.find((l) => l.id === resume?.layer)?.id;
  if (!layer && creatable.length === 1) layer = creatable[0].id;
  // The quick path: the layer the file names, else New Diagram's default (the last creatable layer).
  if (!layer && quick) {
    layer = creatable.find((l) => l.id === analysis.suggestedLayer)?.id
      ?? defaultDiagramLayer(creatable.map((l) => l.id), 0);
  }
  if (!layer) {
    const suggested = creatable.find((l) => l.id === analysis.suggestedLayer);
    // Enter takes the first: the layer chosen before (Change Options…), else the file's, else New Diagram's default.
    const preferred = creatable.find((l) => l.id === resume?.preferredLayer)
      ?? suggested
      ?? creatable.find((l) => l.id === defaultDiagramLayer(creatable.map((c) => c.id), diagramCount));
    const ordered = preferred ? [preferred, ...creatable.filter((l) => l !== preferred)] : creatable;
    const choice = await ui.showQuickPick(
      ordered.map((l) => ({
        label: l.label,
        description: l === suggested ? 'suggested by the file' : (l.id === l.label.toLowerCase() ? undefined : l.id),
        id: l.id,
      })),
      { title: title, placeHolder: WHICH_LAYER_FOR_DIAGRAM, ignoreFocusOut: true },
    );
    if (!choice) return cancelled();
    layer = choice.id;
  }
  const chosenLayer = layer;
  const layerLabel = creatable.find((l) => l.id === chosenLayer)?.label ?? chosenLayer;

  // 3. The name: the Project name or the file name, free in that layer.
  const taken = subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir)
    .filter((d) => d.layer === chosenLayer).map((d) => d.domain);
  const suggestedName = resume?.name ?? suggestDbmlSubjectAreaName(model, fileName, taken);
  // The quick path takes the suggestion when it is a valid, free name; otherwise it asks, as the step-by-step flow does.
  // A redraw (§5.1) keeps the name the draft showed: nothing is asked again.
  const quickName = (quick || resume?.redraw) && deps.validateDomainName(slugFromName(suggestedName), chosenLayer) === undefined
    ? suggestedName
    : undefined;
  const name = quickName ?? await ui.showInputBox({
    title: title,
    prompt: `Name the diagram. It is saved in the ${layerLabel} layer.`,
    value: suggestedName,
    ignoreFocusOut: true,
    // As New Diagram takes it: "Sales" is saved as sales.
    validateInput: (value: string) => validateTypedDiagramName(value, (slug) => deps.validateDomainName(slug, chosenLayer)),
  });
  if (!name) return cancelled();
  const slug = slugFromName(name);

  // A project that writes DBML (§3.2) gets a `.dbml` diagram whose relationships all live in the library (D5).
  const dbml = tableLibraryService.writesDbml?.() ?? false;
  const layerDir = path.join(workspaceRoot, semanticDir, chosenLayer);
  // A DBML diagram is `<layer>/diagrams/<slug>.dbml` (§1.1); a JSON one `<layer>/<slug>.json`.
  const dbmlDiagramPath = path.join(workspaceRoot, semanticDir, ...diagramFilePath(chosenLayer, slug).split('/'));
  const domainPath = dbml ? dbmlDiagramPath : path.join(layerDir, `${slug}.json`);
  const tryAgain = again({ layer: chosenLayer, name: slug });
  progress.retry = tryAgain;
  // The name box already refuses a name in use; this is a diagram that
  // appeared since (another window, git), so the choices are kept.
  const nameTaken = (): void => showError(diagramNameTakenMessage(slug, layerLabel), {
    [OPEN_IT_BUTTON]: () => ui.openDiagram(domainPath),
    [CHOOSE_ANOTHER_NAME_BUTTON]: again({ layer: chosenLayer }),
  });
  // A name is taken in either format: `<slug>.json` and `diagrams/<slug>.dbml` would be one diagram's name twice.
  if (fs.existsSync(path.join(layerDir, `${slug}.json`)) || fs.existsSync(dbmlDiagramPath)) {
    nameTaken();
    return undefined;
  }

  // 4. The plan. Decided before the first file lands, as Import from dbt
  // decides it: the library folder new tables go in (a flat library stays
  // flat), and whether relationships go to the tables' files (#126). A file
  // it would change that is open with unsaved edits stops it here.
  let plan: DbmlImportPlan;
  let folder: string | undefined;
  let dirty: string[];
  /** Every file a DBML project's save writes (empty for a YAML project). */
  let planned: string[] = [];
  /** New tables whose schema is written as the layer's existing folder spells it (or, `newFolder`, as an earlier table of the file does). */
  let respelled: Array<{ table: string; from: string; to: string; newFolder?: boolean }> = [];
  // The project's files as this plan saw them: a Keep after a change re-plans (§5.1).
  const planGeneration = draftOptions?.generation?.();
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
      ...(deps.origin?.description !== undefined ? { description: deps.origin.description } : {}),
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
        showError(`${title}: ${refusal} Nothing was changed.`);
        return undefined;
      }
    }
    // Every file the DBML save writes (relationships files too); a refusal surfaces here, before any write.
    // Each new table keeps the schema the file gives it (its qualifier), as the layer's folder spells it (§2.4).
    const planWrites = dbml && tableLibraryService.planTableWrites
      ? tableLibraryService.planTableWrites({ save: [...plan.newTables, ...plan.changedLibraryTables].map((model) => ({ model })) }, folder, { dbml: true, schemaFromSource: true })
      : undefined;
    planned = (planWrites?.writes ?? []).map((w) => w.path);
    if (planWrites?.plan) {
      respelled = respelledSchemas(plan.newTables, (name) => planWrites.plan!.resolveTable(name)?.reference)
        // A folder the layer does not list yet is made by this import, for the file's first spelling.
        .map((r) => (tableLibraryService.listsSchemaFolder?.(chosenLayer, r.to) ?? true ? r : { ...r, newFolder: true }));
    }
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
    telemetry.error(counts.failed);
    const doing = 'while preparing the import';
    showError(oursMessage(title, doing, 'nothing was changed'), {
      [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err),
      [TRY_AGAIN_BUTTON]: tryAgain,
    });
    return undefined;
  }
  const showUnsaved = (dirtyPath: string): void => {
    const file = path.relative(path.dirname(tableLibraryService.getTablesDir()), dirtyPath).split(path.sep).join('/');
    showError(`${title}: ${file} has unsaved changes. Save or revert it, then try again. Nothing was changed.`, {
      [SHOW_FILE_BUTTON]: () => ui.showFile(dirtyPath),
    });
  };
  if (dirty.length > 0) {
    showUnsaved(dirty[0]);
    return undefined;
  }

  // 5. The draft: the plan as a read-only diagram, what it creates, reuses and
  // leaves out, before any write (or, with no preview, the dry run's modal).
  const semanticRoot = path.join(workspaceRoot, semanticDir);
  const describeOptions: DescribeDbmlImportOptions = {
    layerLabel,
    // The bundled example carries no caveat about its references' `?`: on the
    // first diagram a new user sees it reads as a warning, and the example
    // with no folder has none (`exampleDbmlDraft`).
    ...(source === 'example' ? { example: true } : {}),
    ...(dbml ? {
      dbml: {
        // Where the relationships go: the `<layer>/relationships/` files this save writes.
        relationshipsFiles: planned
          .map((p) => path.relative(semanticRoot, p).split(path.sep).join('/'))
          .filter((rel) => classifySemanticFile(rel, { tablesDirIsLayer: false }).kind === 'relationships'),
        respelledSchemas: respelled,
      },
    } : {}),
    ...(deps.origin ? { origin: deps.origin } : {}),
  };
  const changeOptions = deps.changeOptions;
  const chosen = { layer: chosenLayer, name: slug };
  /** The waiting Keep, settled once the write ends (no draft: nothing to settle). */
  let settleKeep: (outcome: DraftKeepOutcome) => void = () => {};
  /** A Keep is waiting: settled once, here or (after a throw) by `importDbml`. */
  const keepWaiting = (settle: (outcome: DraftKeepOutcome) => void): void => {
    let done = false;
    settleKeep = (outcome) => {
      if (done) return;
      done = true;
      progress.settle = undefined;
      settle(outcome);
    };
    progress.settle = settleKeep;
  };
  /** The draft the viewer answers: asked again after a Keep that did not save, or a switcher choice that drew nothing. */
  let shown: Draft | undefined;
  /** A redraw of the same plan: its Keep is already answered, so the first pass writes at once. */
  let answered = false;
  const fingerprint = importPlanFingerprint(plan);
  if (draftOptions) {
    const redraw = resume?.redraw;
    if (redraw && redraw.fingerprint === fingerprint) {
      // Files changed since the draft, but not this plan: write what was shown.
      keepWaiting(redraw.settle);
      progress.loud = true;
      shown = redraw.draft;
      answered = true;
    } else {
      if (redraw) {
        // The plan is another one now: the Keep did not save, and the new draft says why.
        redraw.settle({ kept: false });
        telemetry.feature('draftRefreshed');
      }
      const target: DraftTarget = {
        layer: chosenLayer,
        layerLabel,
        name: slug,
        diagramFile: path.relative(workspaceRoot, domainPath).split(path.sep).join('/'),
      };
      try {
        shown = draftFromImportPlan({
          plan,
          importSource: source,
          trigger: draftOptions.trigger,
          target,
          fileName,
          ...(deps.origin ? { origin: deps.origin } : {}),
          describe: describeOptions,
          libraryTable: (n) => tableLibraryService.getTable(n) ?? undefined,
          layers: layerService.getAllLayers(),
          logicalOnly: draftOptions.logicalOnly ?? true,
          hasFolder: true,
          changeOptions: changeOptions !== undefined,
          ...(draftOptions.scopes ? { scopes: draftOptions.scopes } : {}),
          ...(redraw ? { notice: DRAFT_REDRAWN_NOTICE } : {}),
        });
      } catch (err) {
        telemetry.error('draftBuildFailed');
        log.error(`[ERD Studio] ${title}: could not build the draft:`, err);
        const doing = 'while drawing the draft';
        showError(oursMessage(title, doing, 'nothing was changed'), { [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err) });
        return undefined;
      }
    }
  }

  for (;;) {
    if (draftOptions && shown && !answered) {
      const asked: Draft = shown;
      const answer = await draftOptions.preview.ask(asked);
      switch (answer.kind) {
        case 'keep': {
          // The user waits on this Keep: what follows is said, even on the automatic draft.
          ui = loudUi;
          progress.loud = true;
          if (draftOptions.quiet) rerunDeps = { ...deps, draft: { ...draftOptions, quiet: false } };
          if (planGeneration !== undefined && draftOptions.generation?.() !== planGeneration) {
            // The project's files changed since this plan (another window, git, an assistant): plan again.
            let settled = false;
            const settle = (outcome: DraftKeepOutcome): void => {
              if (settled) return;
              settled = true;
              answer.settle(outcome);
            };
            try {
              return await importDbml(rerunDeps, {
                filePath,
                ...(quick ? { quick } : {}),
                layer: chosenLayer,
                name: slug,
                redraw: { fingerprint, settle, draft: asked },
              });
            } finally {
              // A re-plan that ended early (it said why) leaves the Keep unsaved.
              settle({ kept: false });
            }
          }
          keepWaiting(answer.settle);
          break;
        }
        case 'changeOptions':
          if (!changeOptions) return undefined;
          telemetry.feature('quickImportChangeOptions');
          void Promise.resolve().then(() => changeOptions(chosen));
          return undefined;
        case 'scope': {
          const onScope = draftOptions.onScope;
          if (!onScope) return undefined;
          const next = await afterScope(draftOptions.preview, asked, () => onScope(answer.scopeId));
          if (!next) return undefined;
          shown = next;
          continue;
        }
        case 'discard':
        case 'closed':
          return cancelled();
        // More ways to start: the host ran its fixed command. Superseded: another flow has the page.
        case 'otherStart':
        case 'superseded':
          return undefined;
      }
    } else if (!draftOptions) {
      const { headline, detail } = summariseDbmlImportPlan(plan, describeOptions);
      const answer = await dryRun(ui, headline, detail.join('\n'), changeOptions !== undefined);
      if (answer === 'changeOptions' && changeOptions) {
        telemetry.feature('quickImportChangeOptions');
        void Promise.resolve().then(() => changeOptions(chosen));
        return undefined;
      }
      if (answer !== 'import') return cancelled();
    }
    answered = false;

    // 6. Every file, or none.
    const outcome = await writeNewSubjectArea({
      workspaceRoot,
      semanticDir,
      domainPath,
      newTables: plan.newTables,
      folder,
      ...(dbml ? { schemaFromSource: true } : {}),
      changedTables: plan.changedLibraryTables,
      documentText: (tableNaming) => serializeDbmlImportDocument(plan.document, tableNaming),
      // The source's positions and sticky-note boxes go where the project keeps a new diagram's layout.
      document: () => ({ ...plan.document, logical: { ...plan.document.logical, relationships: [] } }) as unknown as Record<string, unknown>,
    }, { layerService, tableLibraryService, readText: openOrDiskText, dirtyFiles });
    if (!outcome.ok) {
      reportWriteFailure(outcome);
      // After its own message: the draft's buttons come back, and answer again.
      settleKeep({ kept: false });
      settleKeep = () => {};
      if (shown) continue;
      return undefined;
    }

    progress.written = { domainPath, shown: `${chosenLayer}/${slug}` };
    deps.onWritten({ domainPath, modelNames: outcome.written, changedModelNames: outcome.changed });
    telemetry.feature(counts.done);
    if (quick) telemetry.feature('quickImport');
    if (source === 'file' && layout) telemetry.feature('importDbmlLayout');

    // Kept: the draft closes and the new diagram opens.
    settleKeep({ kept: true });
    await ui.openDiagram(domainPath);
    return { domainPath, plan };
  }

  /** Say why the write did not land (each case its own message). */
  function reportWriteFailure(failed: Extract<Awaited<ReturnType<typeof writeNewSubjectArea>>, { ok: false }>): void {
    const { error: err, undone } = failed;
    if (failed.nameTaken) {
      nameTaken();
      return;
    }
    // A file the write would change (another diagram it re-renders, §5.7) has unsaved edits.
    if (err instanceof UnsavedFilesRefused) {
      showUnsaved(err.filePaths[0]);
      return;
    }
    const result = writeOutcome(undone, semanticDir);
    // A refusal is explained, not a failure, so it is not counted (as on the canvas).
    if (isRefusedWrite(err)) {
      showRefusal(err, result);
      return;
    }
    telemetry.error(counts.failed);
    const why = environmentWriteProblem(err, workspaceRoot, `${semanticDir}/${chosenLayer}`);
    if (!why) {
      const doing = 'while saving the diagram';
      const ours = undone ? 'nothing was changed' : `some files in ${semanticDir}/ may already have changed`;
      showError(oursMessage(title, doing, ours), {
        [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err),
        [TRY_AGAIN_BUTTON]: tryAgain,
      });
      return;
    }
    showError(`${title} couldn't save the diagram: ${why} ${result}`, { [TRY_AGAIN_BUTTON]: tryAgain });
  }

  /** The refusal's own sentence, with Open File when it knows the file. */
  function showRefusal(err: RefusedWrite, outcomeSentence: string): void {
    const location = refusalLocation(err, path.join(workspaceRoot, semanticDir));
    showError(`${title}: ${err.message} ${outcomeSentence}`, location
      ? { [OPEN_FILE_BUTTON]: () => ui.openFileAt(location.filePath, location.line) }
      : {});
  }
}

/**
 * The fallback dry run (no preview): the modal, Import, Change Options… on a
 * quick import, and Cancel. With a UI that has no `choose` (a test's fake),
 * the modal is `confirm` with Import alone.
 */
async function dryRun(
  ui: ImportDbmlUi,
  headline: string,
  detail: string,
  changeOptions: boolean,
): Promise<'import' | 'changeOptions' | 'cancel'> {
  if (!ui.choose) return (await ui.confirm(headline, detail, IMPORT_BUTTON)) ? 'import' : 'cancel';
  const choice = await ui.choose(headline, detail, [IMPORT_BUTTON, ...(changeOptions ? [CHANGE_OPTIONS_BUTTON] : [])]);
  if (choice === IMPORT_BUTTON) return 'import';
  if (choice === CHANGE_OPTIONS_BUTTON && changeOptions) return 'changeOptions';
  return 'cancel';
}

/**
 * The import UI of an automatic draft (§3.1): it asks nothing (every picker
 * and box resolves undefined, every modal Cancel) and shows nothing (each
 * message goes to the log), so anything the quick path would ask or say
 * before the draft ends it silently. Reading the file and opening the kept
 * diagram are `base`'s.
 */
export function quietImportDbmlUi(base: ImportDbmlUi, title: string): ImportDbmlUi {
  const logged = async (message: string): Promise<undefined> => {
    log.info(`[ERD Studio] ${title} (automatic draft, not shown): ${message}`);
    return undefined;
  };
  return {
    ...base,
    pickFile: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    confirm: async () => false,
    choose: async () => undefined,
    showInformationMessage: (message) => logged(message),
    showErrorMessage: (message) => logged(message),
  };
}

/**
 * Import DBML's quick path (the start screen's **Import your DBML file**, the
 * start suggestion): the DBML file the folder holds (`findDefaultFile`), the
 * layer and name chosen, the dry run the one question; Change Options… is
 * the step-by-step flow with that file chosen in its Open dialog and the
 * same layer and name offered first. No DBML file found: the step-by-step flow.
 */
export async function quickImportDbml(deps: ImportDbmlDeps): Promise<ImportDbmlResult | undefined> {
  const filePath = await deps.findDefaultFile?.().catch(() => undefined);
  if (!filePath) {
    // The automatic draft never asks: nothing to take is the end of it.
    if (deps.draft?.quiet) return undefined;
    telemetry.feature('quickImportFellBack');
    return importDbml(deps);
  }
  return importDbml({
    ...deps,
    // The step-by-step flow, ending in a draft of its own (never quiet: the user asked for it).
    changeOptions: ({ layer, name }) => importDbml(
      { ...deps, findDefaultFile: async () => filePath, ...changeOptionsDraft(deps.draft) },
      { preferredLayer: layer, name },
    ),
  }, { filePath, quick: true });
}

/** Change options…'s draft: the same preview, the `changeOptions` trigger, never quiet, no switcher. */
export function changeOptionsDraft(draft: ImportDraftOptions | undefined): { draft?: ImportDraftOptions } {
  if (!draft) return {};
  const { quiet: _quiet, scopes: _scopes, onScope: _onScope, ...rest } = draft;
  return { draft: { ...rest, trigger: 'changeOptions' } };
}

/**
 * Why a plan cannot become a DBML diagram, or undefined (D20): a table it
 * would reuse is stored as YAML (a `use` line cannot import a `.yml`). In
 * the layer-first tree any table name is a table's (`_relationships`
 * included): relationships files live in their own folder.
 */
export function dbmlImportRefusal(plan: DbmlImportPlan, tableStorage: (name: string) => 'yaml' | 'dbml' | undefined): string | undefined {
  const yaml = plan.reusedTables.filter((n) => tableStorage(n) === 'yaml');
  if (yaml.length > 0) {
    return `${yaml.join(', ')} ${yaml.length === 1 ? 'is a YAML table' : 'are YAML tables'} in the Table Library, and a YAML table can't join a DBML diagram. ${DBML_CONVERT_FIRST_MESSAGE}.`;
  }
  return undefined;
}

/**
 * The new tables whose schema is written in another spelling (§1.2 One
 * spelling: a layer that already has `sales/` gets `Table sales.x` for the
 * file's `Table Sales.x`), from each one's reference as the plan writes it.
 */
export function respelledSchemas(
  tables: readonly SemanticTable[],
  referenceOf: (name: string) => string | undefined,
): Array<{ table: string; from: string; to: string }> {
  const out: Array<{ table: string; from: string; to: string }> = [];
  for (const table of tables) {
    const reference = referenceOf(table.name);
    if (!table.schema || reference === undefined) continue;
    const dot = reference.lastIndexOf('.');
    const written = dot > 0 ? reference.slice(0, dot).replace(/^"(.*)"$/, '$1') : undefined;
    if (written !== undefined && written !== table.schema && written.toLowerCase() === table.schema.toLowerCase()) {
      out.push({ table: table.name, from: table.schema, to: written });
    }
  }
  return out;
}

/**
 * The import UI with the DBML supplied (a conversion's output, the example):
 * the "file" is `filePath`, which reads as `text` and is never opened from
 * disk. Everything else (the pickers, the dry run, opening the diagram) is
 * `base`'s, so the user still picks the layer, names the diagram and confirms.
 */
export function suppliedDbmlUi(base: ImportDbmlUi, filePath: string, text: string): ImportDbmlUi {
  return {
    ...base,
    pickFile: async () => filePath,
    readFile: async (p) => (p === filePath ? text : base.readFile(p)),
  };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The real UI. */
export function vscodeImportDbmlUi(): ImportDbmlUi {
  return {
    pickFile: async (defaultPath) => {
      const picked = await vscode.window.showOpenDialog({
        title: TITLE,
        openLabel: IMPORT_BUTTON,
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { DBML: ['dbml'] },
        ...(defaultPath ? { defaultUri: vscode.Uri.file(defaultPath) } : {}),
      });
      return picked?.[0]?.fsPath;
    },
    readFile: async (filePath) => new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))),
    showQuickPick: async (items, options) => vscode.window.showQuickPick([...items], options),
    showInputBox: async (options) => vscode.window.showInputBox(options),
    confirm: async (message, detail, button) =>
      (await vscode.window.showInformationMessage(message, { modal: true, detail }, button)) === button,
    choose: async (message, detail, buttons) => vscode.window.showInformationMessage(message, { modal: true, detail }, ...buttons),
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
