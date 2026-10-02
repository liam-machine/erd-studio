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
 * the picker is `src/providers/dbtDraftPicker.ts`. Every service is injected
 * so `activate()` wires the real ones and the refreshes stay in extension.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  buildDbtDraft,
  buildDraftDomainDocument,
  listDraftModels,
  listDraftScopes,
  serializeDraftDomainDocument,
  suggestDomainName,
  type DbtDraft,
  type DraftSkipped,
} from '../services/dbtDraft';
import { pickDraftScope } from '../providers/dbtDraftPicker';
import { routeToLibrary, usesLibraryRelationships } from '../services/libraryRelationships';
import { ownWrites } from '../services/ownWriteTracker';
import { DOMAIN_EDITOR_VIEW_TYPE } from '../services/recoveryService';
import { telemetry } from '../services/telemetryService';
import type { DomainService } from '../services/domainService';
import type { LayerService } from '../services/layerService';
import type { LogicalModelService } from '../services/logicalModelService';
import type { ManifestData } from '../types/manifest';
import type { YmlData } from '../types/ymlData';

export const DRAW_FROM_DBT_COMMAND = 'erdStudio.drawFromDbt';

const TITLE = 'Draw from dbt';

/**
 * Shown when no model has columns to draw. `listDraftModels` takes a model's
 * columns from its schema yml, else the manifest — which is a compiled copy
 * of the same yml, so running dbt adds none. catalog.json is not read here.
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
  domainService: Pick<DomainService, 'listDomains' | 'countDomainFileRelationships'>;
  logicalModelService: Pick<LogicalModelService, 'modelExists' | 'saveModel' | 'groupsByFolder' | 'deleteModel' | 'listModels' | 'getModel'>;
  /** Schema yml and manifest; either may be undefined (no yml, never compiled). */
  loadDbt: () => Promise<{ ymlData?: YmlData; manifest?: ManifestData }>;
  /** `createDomain`'s rule for a new domain slug in `layer` (undefined = valid). */
  validateDomainName: (value: string, layer: string) => string | undefined;
  /** Every file is written; refresh the tree, model library, context keys and selectors. */
  onWritten: (written: { domainPath: string; modelNames: string[] }) => void;
}

export interface DrawFromDbtResult {
  domainPath: string;
  draft: DbtDraft;
}

/**
 * Run the flow. Resolves undefined when the user cancels, when there is
 * nothing to draw, or when a write fails (each case has already said so).
 * Anything that throws is counted and rethrown.
 */
export async function drawFromDbt(deps: DrawFromDbtDeps): Promise<DrawFromDbtResult | undefined> {
  telemetry.feature('drawStarted');
  try {
    return await runDrawFromDbt(deps);
  } catch (err) {
    telemetry.error('drawFromDbtFailed');
    throw err;
  }
}

async function runDrawFromDbt(deps: DrawFromDbtDeps): Promise<DrawFromDbtResult | undefined> {
  const { workspaceRoot, semanticDir, layerService, domainService, logicalModelService } = deps;

  const { ymlData, manifest } = await vscode.window.withProgress(
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
  const pick = await pickDraftScope(listDraftScopes(source), { models, title: TITLE });
  if (!pick) { telemetry.feature('drawCancelScope'); return undefined; }

  // Layer: the one the dbt folder names (marts → gold, …) when it is a layer
  // here; otherwise ask, unless there is only one to choose.
  const creatable = layerService.getCreatableLayers();
  if (creatable.length === 0) {
    telemetry.feature('drawNoLayers');
    void vscode.window.showErrorMessage('No layers are configured for new diagrams. Add a layer first.');
    return undefined;
  }
  let layer = creatable.find((l) => l.id === pick.scope.suggestedLayer)?.id;
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

  const existingDomains = domainService.listDomains(workspaceRoot, semanticDir);
  const suggested = suggestDomainName(pick.scope, existingDomains.filter((d) => d.layer === layer).map((d) => d.domain));
  const chosenLayer = layer;
  const name = await vscode.window.showInputBox({
    title: TITLE,
    prompt: `Name the diagram. It is saved in the ${layerLabel} layer.`,
    value: suggested,
    ignoreFocusOut: true,
    validateInput: (value: string) => deps.validateDomainName(value, chosenLayer),
  });
  if (!name) { telemetry.feature('drawCancelName'); return undefined; }
  const slug = name.trim();

  const draft = buildDbtDraft({
    modelNames: pick.modelNames,
    ymlData,
    manifest,
    libraryHas: (n) => logicalModelService.modelExists(n),
  });
  if (draft.modelNames.length === 0) {
    telemetry.feature('drawNothingDrawable');
    void vscode.window.showWarningMessage(`${TITLE}: none of the chosen models could be drawn. ${describeSkipped(draft.skipped)}`);
    return undefined;
  }

  const layerDir = path.join(workspaceRoot, semanticDir, chosenLayer);
  const domainPath = path.join(layerDir, `${slug}.json`);
  if (fs.existsSync(domainPath)) {
    void vscode.window.showErrorMessage(`A diagram named "${slug}" already exists in the ${layerLabel} layer.`);
    return undefined;
  }

  // Writes start here. A project with no ERD folder yet gets the default
  // layers.json first, exactly as Set Up Semantic Domains Directory writes it.
  const written: string[] = [];
  try {
    if (!fs.existsSync(path.join(workspaceRoot, semanticDir))) {
      await layerService.saveConfig(layerService.getAllLayers());
    }
    fs.mkdirSync(layerDir, { recursive: true });

    // Decided once, before the first file lands: an empty library would
    // otherwise read as "flat" after one top-level write. A flat library stays
    // flat; one already grouped by layer gets this layer's folder.
    const folder = logicalModelService.groupsByFolder(new Set(layerService.getValidLayerIds())) ? chosenLayer : undefined;
    // Relationships go to their from-models' library files when the project
    // keeps them there (#126) — decided, like the folder, before any write.
    const routed = usesLibraryRelationships(
      logicalModelService.listModels(),
      domainService.countDomainFileRelationships(workspaceRoot, semanticDir),
    )
      ? routeToLibrary(draft.relationships, draft.newModels, (n) => logicalModelService.getModel(n))
      : { kept: draft.relationships, changed: [] };
    for (const model of draft.newModels) {
      logicalModelService.saveModel(model, folder);
      written.push(model.name);
    }

    const doc = buildDraftDomainDocument({
      domain: slug,
      layer: chosenLayer,
      description: `Drawn from dbt: ${pick.scope.label}.`,
      modelNames: draft.modelNames,
      relationships: routed.kept,
    });
    fs.writeFileSync(domainPath, serializeDraftDomainDocument(doc), { encoding: 'utf-8', flag: 'wx' });
    ownWrites.recordWrite(domainPath);
    // Existing library models that gained a relationship, once the diagram is on disk.
    for (const model of routed.changed) {
      if (!draft.newModels.includes(model)) logicalModelService.saveModel(model);
    }
  } catch (err) {
    // Leave no orphan model files behind a domain that was never written.
    for (const modelName of written) {
      try { logicalModelService.deleteModel(modelName); } catch { /* best effort */ }
    }
    const exists = err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST';
    if (!exists) { telemetry.error('drawWriteFailed'); }
    const msg = exists
      ? `A diagram named "${slug}" already exists in the ${layerLabel} layer.`
      : `${TITLE} could not write the diagram: ${err instanceof Error ? err.message : String(err)}`;
    void vscode.window.showErrorMessage(msg);
    return undefined;
  }

  deps.onWritten({ domainPath, modelNames: written });
  telemetry.feature('drawFromDbt');

  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(domainPath), DOMAIN_EDITOR_VIEW_TYPE);

  const notice = describeDraftNotice(draft);
  if (notice) { void vscode.window.showInformationMessage(notice); }
  return { domainPath, draft };
}

/** The one-line note after drawing — only when something was left out. */
export function describeDraftNotice(draft: Pick<DbtDraft, 'modelNames' | 'skipped' | 'truncated'>): string | undefined {
  const overLimit = draft.skipped.filter((s) => s.reason === 'over-limit').length;
  const other = draft.skipped.filter((s) => SKIP_REASONS_WORTH_NAMING.has(s.reason));
  const parts: string[] = [];
  if (draft.truncated && overLimit > 0) {
    parts.push(
      `Drew the ${draft.modelNames.length} best-connected models and left ${overLimit} out to keep the diagram readable. ` +
        'Add more from the canvas.',
    );
  }
  if (other.length > 0) { parts.push(describeSkipped(other)); }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** A repeated pick or the cap is not worth a sentence; these are. */
const SKIP_REASONS_WORTH_NAMING = new Set<DraftSkipped['reason']>(['invalid-name', 'not-found', 'disabled']);

function describeSkipped(skipped: readonly DraftSkipped[]): string {
  const relevant = skipped.filter((s) => SKIP_REASONS_WORTH_NAMING.has(s.reason));
  if (relevant.length === 0) { return ''; }
  const names = relevant.slice(0, 3).map((s) => s.name).join(', ');
  const more = relevant.length > 3 ? ` and ${relevant.length - 3} more` : '';
  return `Skipped ${names}${more}: disabled in dbt, missing columns, or a name ERD Studio cannot use.`;
}
