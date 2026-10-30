/**
 * **Draw from dbt…** (`erdStudio.drawFromDbt`) — the no-AI route to a first
 * diagram. It reads the dbt project's schema yml and manifest, asks which
 * models to draw (a folder, a connected cluster or a hand-picked list), and
 * writes a LOGICAL draft: one `logical-models/*.yml` per model the library
 * does not have yet, copied from dbt the way the canvas's Add Existing Model
 * copies one, plus a new domain file with `viewConfig: {}` so the canvas lays
 * it out on first open. The physical stage stays derived; nothing here
 * persists it — the draft is a starting point the user asked for and edits.
 *
 * The scopes and the draft come from the pure `src/services/dbtDraft.ts`;
 * the picker is `src/providers/dbtDraftPicker.ts`; the files are written, all
 * or nothing, by `writeNewSubjectArea` (`src/services/newSubjectAreaWriter.ts`),
 * which Import DBML shares. Every service is injected
 * so `activate()` wires the real ones and the refreshes stay in extension.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  buildDbtDraft,
  buildDraftSubjectAreaDocument,
  listDraftModels,
  listDraftScopes,
  serializeDraftSubjectAreaDocument,
  suggestSubjectAreaName,
  type DbtDraft,
  type DraftSkipped,
} from '../services/dbtDraft';
import { pickDraftScope, type DraftScopePick } from '../providers/dbtDraftPicker';
import { openTableFileAt } from './openModelFile';
import { dirtyFiles, openOrDiskText } from '../providers/dirtyDocuments';
import { describeUnstoredRelationships, drawnDiagramCopies, routeToLibrary, usesLibraryRelationships } from '../services/libraryRelationships';
import { readSubjectAreaRelationships } from './moveRelationshipsToLibrary';
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
  showErrorWithActions as showErrorWith,
  type ErrorActions,
} from '../services/commandErrors';
import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../services/recoveryService';
import { telemetry } from '../services/telemetryService';
import type { SubjectAreaService } from '../services/domainService';
import type { LayerService } from '../services/layerService';
import type { TableLibraryService } from '../services/logicalModelService';
import {
  environmentWriteProblem,
  isRefusedWrite,
  refusalLocation,
  writeNewSubjectArea,
  writeOutcome,
  UnsavedFilesRefused,
  type RefusedWrite,
} from '../services/newSubjectAreaWriter';
import { diagramFilePath } from '@erd-studio/core';
import { DbmlEditRefused } from '@erd-studio/core/dbml';
import type { CatalogData } from '../types/catalog';
import type { ManifestData } from '../types/manifest';
import type { YmlData } from '../types/ymlData';
import { RESERVED_TABLE_NAME_MESSAGE } from '../types/naming';
import { log } from '../services/logger';

export const DRAW_FROM_DBT_COMMAND = 'erdStudio.drawFromDbt';

const TITLE = 'Draw from dbt';

/**
 * Shown when no model has columns to draw. `listDraftModels` takes a model's
 * columns from its schema yml, else the manifest — which is a compiled copy
 * of the same yml, so running dbt adds none. catalog.json only fills in the
 * types of those columns, never adds one.
 */
export const NO_DBT_MODELS_MESSAGE =
  'No dbt models with columns found. Draw from dbt reads the columns listed in your schema .yml files — ' +
  'add columns: to your models there, then try again.';


export interface DrawFromDbtDeps {
  workspaceRoot: string;
  semanticDir: string;
  /** `model-paths` from dbt_project.yml. */
  modelPaths: readonly string[];
  layerService: Pick<LayerService, 'getValidLayerIds' | 'getCreatableLayers' | 'getAllLayers' | 'saveConfig'>;
  subjectAreaService: Pick<SubjectAreaService, 'listSubjectAreas' | 'countSubjectAreaFileRelationships'>;
  tableLibraryService: Pick<
    TableLibraryService,
    'tableExists' | 'saveTable' | 'serializeTable' | 'groupsByFolder' | 'deleteTable' | 'listTables' | 'getTable' | 'hasUnreadableRelationships' | 'tablePath' | 'getTablesDir' | 'writesTableNaming'
  > & Partial<Pick<TableLibraryService, 'hasDbmlLibrary' | 'planTableWrites' | 'writesDbml' | 'tableStorage' | 'invalidateCache'>>;
  /** Schema yml, manifest and catalog; each may be undefined (no yml, never compiled, no `dbt docs generate`). */
  loadDbt: () => Promise<{ ymlData?: YmlData; manifest?: ManifestData; catalog?: CatalogData }>;
  /** `createDomain`'s rule for a new domain slug in `layer` (undefined = valid). */
  validateDomainName: (value: string, layer: string) => string | undefined;
  /**
   * Every file is written; refresh the tree, Table Library, context keys and
   * selectors. `modelNames` are the new tables; `changedModelNames` the
   * existing library tables that gained a relationship.
   */
  onWritten: (written: { domainPath: string; modelNames: string[]; changedModelNames: string[] }) => void;
}

/**
 * Where Try Again and Choose Another Name re-enter the flow (#189): at the
 * name step, with the models and layer the user already chose, so a failed
 * draw never costs them their selection.
 */
export interface DrawFromDbtResume {
  pick: DraftScopePick;
  layer: string;
  /** The name to offer again (Try Again); the suggested one when absent. */
  name?: string;
}

export { ADD_LAYER_BUTTON, CHOOSE_ANOTHER_NAME_BUTTON, NO_LAYERS_MESSAGE, OPEN_FILE_BUTTON, OPEN_IT_BUTTON, SHOW_FILE_BUTTON, TRY_AGAIN_BUTTON };

export interface DrawFromDbtResult {
  domainPath: string;
  draft: DbtDraft;
}

/**
 * Run the flow. Resolves undefined when the user cancels, when there is
 * nothing to draw, or when a write fails (each case has already said so).
 * Anything that throws is counted and rethrown.
 */
export async function drawFromDbt(deps: DrawFromDbtDeps, resume?: DrawFromDbtResume): Promise<DrawFromDbtResult | undefined> {
  telemetry.feature('drawStarted');
  try {
    return await runDrawFromDbt(deps, resume);
  } catch (err) {
    telemetry.error('drawFromDbtFailed');
    throw err;
  }
}

/**
 * Show an error with its buttons, and run the one the user picks. Never
 * awaited: the command resolves while the toast is still up.
 */
function showErrorWithActions(message: string, actions: ErrorActions): void {
  // A button that fails (a re-run whose dbt read throws) still says so, rather than seeming to do nothing.
  showErrorWith((m, ...items) => vscode.window.showErrorMessage(m, ...items), message, actions, (choice, err) => {
    log.error(`[ERD Studio] ${TITLE}: "${choice}" failed:`, err);
    const doing = `while running ${choice}`;
    showErrorWithActions(oursMessage(TITLE, doing, 'nothing was changed'), { [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err) });
  });
}

/** Send Feedback, prefilled with the redacted failure: for a failure that is ours. */
function sendFeedback(doing: string, err: unknown): () => unknown {
  return () => vscode.commands.executeCommand('erdStudio.reportBug', feedbackPrefill(TITLE, doing, err));
}

async function runDrawFromDbt(deps: DrawFromDbtDeps, resume?: DrawFromDbtResume): Promise<DrawFromDbtResult | undefined> {
  const { workspaceRoot, semanticDir, layerService, subjectAreaService, tableLibraryService } = deps;

  const { ymlData, manifest, catalog } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Reading your dbt project…' },
    () => deps.loadDbt(),
  );
  // #113: no manifest (never compiled, or removed) — `loadDbt` passes undefined then.
  if (!manifest) { telemetry.featureOnce('manifestMissingDraw'); }

  const layerIds = layerService.getValidLayerIds();
  const source = { ymlData, manifest, projectRoot: workspaceRoot, modelPaths: deps.modelPaths, layerIds };
  const models = listDraftModels(source);
  if (models.length === 0) {
    telemetry.feature('drawNoModels');
    void vscode.window.showInformationMessage(NO_DBT_MODELS_MESSAGE);
    return undefined;
  }
  const pick = resume?.pick ?? await pickDraftScope(listDraftScopes(source), { models, title: TITLE });
  if (!pick) { telemetry.feature('drawCancelScope'); return undefined; }

  // Layer: the one the dbt folder names (marts → gold, …) when it is a layer
  // here; otherwise ask, unless there is only one to choose.
  const creatable = layerService.getCreatableLayers();
  if (creatable.length === 0) {
    telemetry.feature('drawNoLayers');
    showErrorWithActions(NO_LAYERS_MESSAGE, {
      [ADD_LAYER_BUTTON]: () => vscode.commands.executeCommand('erdStudio.addLayer'),
    });
    return undefined;
  }
  let layer = creatable.find((l) => l.id === resume?.layer)?.id
    ?? creatable.find((l) => l.id === pick.scope.suggestedLayer)?.id;
  if (!layer && creatable.length === 1) { layer = creatable[0].id; }
  if (!layer) {
    const choice = await vscode.window.showQuickPick(
      creatable.map((l) => ({ label: l.label, description: l.id === l.label.toLowerCase() ? undefined : l.id, id: l.id })),
      { title: TITLE, placeHolder: 'Which layer is this diagram for?', ignoreFocusOut: true },
    );
    if (!choice) { telemetry.feature('drawCancelLayer'); return undefined; }
    layer = choice.id;
  }
  const layerLabel = creatable.find((l) => l.id === layer)?.label ?? layer;

  const existingDomains = subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir);
  const suggested = suggestSubjectAreaName(pick.scope, existingDomains.filter((d) => d.layer === layer).map((d) => d.domain));
  const chosenLayer = layer;
  const name = await vscode.window.showInputBox({
    title: TITLE,
    prompt: `Name the diagram. It is saved in the ${layerLabel} layer.`,
    value: resume?.name ?? suggested,
    ignoreFocusOut: true,
    validateInput: (value: string) => deps.validateDomainName(value, chosenLayer),
  });
  if (!name) { telemetry.feature('drawCancelName'); return undefined; }
  const slug = name.trim();

  // A project that writes DBML (§3.2) gets a `.dbml` diagram, whose members are DBML tables (D20).
  const dbml = tableLibraryService.writesDbml?.() ?? false;
  const draft = buildDbtDraft({
    modelNames: pick.modelNames,
    ymlData,
    manifest,
    catalog,
    libraryHas: (n) => tableLibraryService.tableExists(n),
    ...(dbml ? { dbml: { tableStorage: (n: string) => tableLibraryService.tableStorage?.(n) } } : {}),
  });
  if (draft.modelNames.length === 0) {
    telemetry.feature('drawNothingDrawable');
    void vscode.window.showWarningMessage(`${TITLE}: none of the chosen models could be drawn. ${describeSkipped(draft.skipped)}`);
    return undefined;
  }

  const layerDir = path.join(workspaceRoot, semanticDir, chosenLayer);
  // A DBML diagram is `<layer>/diagrams/<slug>.dbml` (§1.1); a JSON one `<layer>/<slug>.json`.
  const dbmlDiagramPath = path.join(workspaceRoot, semanticDir, ...diagramFilePath(chosenLayer, slug).split('/'));
  const domainPath = dbml ? dbmlDiagramPath : path.join(layerDir, `${slug}.json`);
  const again: DrawFromDbtResume = { pick, layer: chosenLayer, name: slug };
  const tryAgain = (): unknown => drawFromDbt(deps, again);
  // The name box already refuses a name in use; this is a diagram that
  // appeared since (another window, git), so the choices are kept.
  const nameTaken = (): void => showErrorWithActions(diagramNameTakenMessage(slug, layerLabel), {
    [OPEN_IT_BUTTON]: () => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(domainPath), SUBJECT_AREA_EDITOR_VIEW_TYPE),
    [CHOOSE_ANOTHER_NAME_BUTTON]: () => drawFromDbt(deps, { pick, layer: chosenLayer }),
  });
  // A name is taken in either format: `<slug>.json` and `diagrams/<slug>.dbml` would be one diagram's name twice.
  if (fs.existsSync(path.join(layerDir, `${slug}.json`)) || fs.existsSync(dbmlDiagramPath)) {
    nameTaken();
    return undefined;
  }

  // Decided once, before the first file lands: an empty library would
  // otherwise read as "flat" after one top-level write. A flat library stays
  // flat; one already grouped by layer gets this layer's folder.
  // Relationships go to their from-models' library files when the project
  // keeps them there (#126) — decided, like the folder, before any write.
  // A model file it would write that is open with unsaved edits stops the
  // draw before anything is written, as a canvas edit does.
  let folder: string | undefined;
  let routed: { kept: DbtDraft['relationships']; changed: DbtDraft['newModels'] };
  let dirty: string[];
  // Relationships a DBML diagram cannot store (their many-side table's file could not be read): named in the notice.
  let unstored: DbtDraft['relationships'] = [];
  try {
    // A DBML table always goes to the chosen layer's folder: groupsByFolder speaks for YAML libraries only.
    folder = dbml || tableLibraryService.groupsByFolder(new Set(layerService.getValidLayerIds())) ? chosenLayer : undefined;
    // A DBML diagram holds no relationships (D5): every one goes to the library,
    // none stays behind as a diagram copy.
    routed = dbml
      ? routeToLibrary(draft.relationships, draft.newModels, (n) => tableLibraryService.getTable(n))
      : usesLibraryRelationships(
        tableLibraryService.listTables(),
        subjectAreaService.countSubjectAreaFileRelationships(workspaceRoot, semanticDir),
        tableLibraryService.hasUnreadableRelationships(),
        // A DBML table's relationships can only live in the library (D5, §5.1).
        tableLibraryService.hasDbmlLibrary?.() ?? false,
      )
        ? routeToLibrary(draft.relationships, draft.newModels, (n) => tableLibraryService.getTable(n),
          drawnDiagramCopies(readSubjectAreaRelationships(subjectAreaService, workspaceRoot, semanticDir)))
        : { kept: draft.relationships, changed: [] };
    if (dbml && routed.kept.length > 0) {
      unstored = routed.kept;
      routed = { kept: [], changed: routed.changed };
    }
    const planned = dbml && tableLibraryService.planTableWrites
      // Every file the DBML save writes (relationships files too); a refusal surfaces here, before any write.
      ? tableLibraryService.planTableWrites({ save: [...draft.newModels, ...routed.changed].map((model) => ({ model })) }, folder, { dbml: true })
        .writes.map((w) => w.path)
      : [];
    dirty = dirtyFiles([
      ...draft.newModels.map((m) => tableLibraryService.tablePath(m.name, folder)),
      ...routed.changed.map((m) => tableLibraryService.tablePath(m.name)),
      ...planned,
    ]);
    // Throws DuplicateKeyWriteRefused for a library file that is read but may
    // not be written (#164), or RelationshipsRewriteRefused, before the diagram
    // is on disk rather than after. (A DBML plan above already checked its files.)
    if (!dbml) for (const model of routed.changed) tableLibraryService.serializeTable(model);
  } catch (err) {
    if (isRefusedWrite(err)) {
      showRefusal(err, 'Nothing was changed.', path.join(workspaceRoot, semanticDir));
      return undefined;
    }
    telemetry.error('drawFromDbtFailed');
    const doing = 'while reading your Table Library';
    showErrorWithActions(oursMessage(TITLE, doing, 'nothing was changed'), {
      [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err),
      [TRY_AGAIN_BUTTON]: tryAgain,
    });
    return undefined;
  }
  const showUnsaved = (dirtyPath: string): void => {
    const file = path.relative(path.dirname(tableLibraryService.getTablesDir()), dirtyPath).split(path.sep).join('/');
    showErrorWithActions(`${TITLE}: ${file} has unsaved changes. Save or revert it, then try again. Nothing was changed.`, {
      [SHOW_FILE_BUTTON]: () => vscode.window.showTextDocument(vscode.Uri.file(dirtyPath)),
    });
  };
  if (dirty.length > 0) {
    showUnsaved(dirty[0]);
    return undefined;
  }

  // Writes start here: every file, or none (`writeNewSubjectArea`). A project
  // with no ERD folder yet gets the default layers.json first, exactly as Set
  // Up Semantic Domains Directory writes it.
  const outcome = await writeNewSubjectArea({
    workspaceRoot,
    semanticDir,
    domainPath,
    newTables: draft.newModels,
    folder,
    changedTables: routed.changed,
    documentText: (tableNaming) => serializeDraftSubjectAreaDocument(buildDraftSubjectAreaDocument({
      domain: slug,
      layer: chosenLayer,
      description: `Drawn from dbt: ${pick.scope.label}.`,
      modelNames: draft.modelNames,
      relationships: routed.kept,
    }), tableNaming),
    document: () => buildDraftSubjectAreaDocument({
      domain: slug,
      layer: chosenLayer,
      description: `Drawn from dbt: ${pick.scope.label}.`,
      modelNames: draft.modelNames,
      relationships: [],
    }) as unknown as Record<string, unknown>,
  }, { layerService, tableLibraryService, readText: openOrDiskText, dirtyFiles });
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
      showRefusal(err, result, path.join(workspaceRoot, semanticDir));
      return undefined;
    }
    telemetry.error('drawWriteFailed');
    const why = environmentWriteProblem(err, workspaceRoot, `${semanticDir}/${chosenLayer}`);
    if (!why) {
      const doing = 'while saving the diagram';
      const ours = undone ? 'nothing was changed' : `some files in ${semanticDir}/ may already have changed`;
      showErrorWithActions(oursMessage(TITLE, doing, ours), {
        [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err),
        [TRY_AGAIN_BUTTON]: tryAgain,
      });
      return undefined;
    }
    showErrorWithActions(`${TITLE} couldn't save the diagram: ${why} ${result}`, { [TRY_AGAIN_BUTTON]: tryAgain });
    return undefined;
  }
  const written = outcome.written;

  deps.onWritten({ domainPath, modelNames: written, changedModelNames: outcome.changed });
  telemetry.feature('drawFromDbt');

  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(domainPath), SUBJECT_AREA_EDITOR_VIEW_TYPE);

  const notice = [describeDraftNotice(draft), describeUnstoredRelationships(unstored)].filter(Boolean).join(' ');
  if (notice) { void vscode.window.showInformationMessage(notice); }
  return { domainPath, draft };
}

/** The refusal's own sentence, with Open File when it knows the file. */
function showRefusal(err: RefusedWrite, outcome: string, semanticRoot?: string): void {
  const location = semanticRoot === undefined ? (err instanceof DbmlEditRefused ? undefined : err.location) : refusalLocation(err, semanticRoot);
  showErrorWithActions(`${TITLE}: ${err.message} ${outcome}`, location
    ? { [OPEN_FILE_BUTTON]: () => openTableFileAt(location.filePath, location.line) }
    : {});
}

/** The one-line note after drawing — only when something was left out. */
export function describeDraftNotice(draft: Pick<DbtDraft, 'modelNames' | 'skipped' | 'truncated'>): string | undefined {
  const overLimit = draft.skipped.filter((s) => s.reason === 'over-limit').length;
  const other = draft.skipped.filter((s) => SKIP_REASONS_WORTH_NAMING.has(s.reason));
  const parts: string[] = [];
  if (draft.truncated && overLimit > 0) {
    parts.push(
      `Drew the ${draft.modelNames.length} best-connected tables and left ${overLimit} out to keep the diagram readable. ` +
        'Add more from the canvas.',
    );
  }
  if (other.length > 0) { parts.push(describeSkipped(other)); }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** A repeated pick or the cap is not worth a sentence; these are. */
const SKIP_REASONS_WORTH_NAMING = new Set<DraftSkipped['reason']>(['invalid-name', 'not-found', 'disabled', 'yaml-table', 'reserved-name']);

/** The reasons a DBML diagram adds (§5.7), each with its own sentence. */
const DBML_SKIP_REASONS: Partial<Record<DraftSkipped['reason'], string>> = {
  'yaml-table': "a YAML table can't join a DBML diagram; convert the project first",
  'reserved-name': RESERVED_TABLE_NAME_MESSAGE.replace(/; choose another table name\.$/, ''),
};

function describeSkipped(skipped: readonly DraftSkipped[]): string {
  const relevant = skipped.filter((s) => SKIP_REASONS_WORTH_NAMING.has(s.reason));
  if (relevant.length === 0) { return ''; }
  const parts: string[] = [];
  const general = relevant.filter((s) => DBML_SKIP_REASONS[s.reason] === undefined);
  if (general.length > 0) {
    const names = general.slice(0, 3).map((s) => s.name).join(', ');
    const more = general.length > 3 ? ` and ${general.length - 3} more` : '';
    parts.push(`Skipped ${names}${more}: disabled in dbt, missing columns, or a name ERD Studio cannot use.`);
  }
  for (const [reason, why] of Object.entries(DBML_SKIP_REASONS)) {
    const names = relevant.filter((s) => s.reason === reason).map((s) => s.name);
    if (names.length > 0) parts.push(`Skipped ${names.join(', ')}: ${why}.`);
  }
  return parts.join(' ');
}
