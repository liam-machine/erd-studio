import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SubjectAreaService, renameSubjectAreaInRaw, subjectAreaTableNames } from './services/domainService';
import { LayerService } from './services/layerService';
import { WRITTEN_SCHEMA_VERSION, detectSubjectAreaFormat, getRawSubjectAreaTableNames, type SubjectAreaSummary, type Layer, type Stage, type UnifiedSubjectArea, type StageData } from './types/semantic';
import { ManifestService, type ManifestLoadFailure } from './services/manifestService';
import { TemplateService } from './services/templateService';
import { SubjectAreaTreeProvider, type TreeElement } from './providers/DomainTreeProvider';
import { SemanticEditorProvider } from './providers/SemanticEditorProvider';
import { SemanticFileDecorationProvider } from './providers/SemanticFileDecorationProvider';
import { LayerDecorationProvider } from './providers/LayerDecorationProvider';
import { FileWatcherService } from './watchers/FileWatcherService';
import { HarnessService, HARNESS_TARGETS, HARNESS_VERSION, extractHarnessVersion, type HarnessInstallResult, type HarnessTarget } from './services/harnessService';
import { SelectorsService } from './services/selectorsService';
import { LegacyTagCleanupService } from './services/legacyTagCleanupService';
import { TABLES_DIR, TableLibraryService, tablesLayerConflict } from './services/logicalModelService';
import { projectStorageOf } from './services/projectStorage';
import type { ProjectStorage } from '@erd-studio/core';
import { ownWrites } from './services/ownWriteTracker';
import { MigrationService, migrateLegacySemanticDir } from './services/migrationService';
import {
  DRAW_FROM_DBT_NEEDS_DBT_MESSAGE,
  hasErdStudioData,
  resolveDbtProject,
  samePath,
  type DbtProjectResolution,
} from './services/projectDiscovery';
import { YmlParserService } from './services/ymlParserService';
import { dbtKeyIndexOf } from './services/stageDisplay';
import { CatalogService } from './services/catalogService';
import { getErdStudioSetting } from './services/configService';
import { manifestDisplayPath, readDbtProjectConfig, resolveManifestPath, type DbtProjectConfig } from './services/dbtProjectConfig';
import { detectPhysicalTooling, toolingExclude, type ToolingProbe } from './services/physicalTooling';
import { getLastDbtParseLaunchAt, RUN_DBT_PARSE_ACTION, runDbtParse } from './commands/runDbtParse';
import {
  manifestAppearanceFeature,
  manifestMissingReasons,
  type ManifestMissingReason,
  type ManifestMissingReasonDeps,
} from './services/manifestMissingReasons';
import { TableLibraryTreeProvider, type TableLibraryNode } from './providers/ModelLibraryTreeProvider';
import { describeOrganizePlan, planOrganizeByLayer, type SubjectAreaTableUsage } from './services/modelLibraryOrganizer';
import { describeDuplicateFix, planDuplicateFix, repointSubjectAreaTable, suggestDuplicateName, type SubjectAreaReference } from './services/duplicateModelResolver';
import { validateTableName } from './providers/payloadValidation';
import { layoutFilePathOf, normaliseSubjectAreaDocument, parseTableText, toTableNamingDocument } from '@erd-studio/core';
import { rewriteJsonScalars } from './services/minimalEdits';
import { migrateToTableNaming, planProjectNamingMigration } from './commands/migrateNaming';
import { projectNamingOf } from './services/projectNaming';
import { SUBJECT_AREA_EDITOR_VIEW_TYPE, hasOpenSubjectAreaCanvas, saveAllAndReload } from './services/recoveryService';
import { submitFeedback } from './services/feedbackService';
import { clearFeedbackApiKey, setFeedbackApiKey } from './services/feedbackAnalysisService';
import { ReportTrackingService } from './services/reportTrackingService';
import { TelemetryService, telemetry } from './services/telemetryService';
import { startKnownFixes } from './services/knownFixesService';
import type { TelemetryErrorCode, TelemetryFeature } from './services/telemetryPayload';
import { saveFailureCodes, tableFileErrorCode, type SaveFailure } from './services/telemetryPayload';
import { notifyTableFileError, shouldWarnAboutTableFile } from './commands/openModelFile';
import { MyReportsTreeProvider, type MyReportNode } from './providers/MyReportsTreeProvider';
import type { FeedbackKind } from './types/feedback';
import { CliLauncherService, type CliLauncherOptions } from './services/cliLauncherService';
import {
  GettingStartedPanel,
  detectAiAssistants,
  detectClaude,
  keepMineInstalls,
  openClaudeCode,
  openCopilotChat,
  runSetupAiHelper,
  SETUP_CANCELLED_MESSAGE,
  TRY_SAMPLE_COMMAND,
  trySampleProject,
  computeProjectSummary,
  type GettingStartedDeps,
} from './providers/GettingStartedPanel';
import { listDraftModels } from './services/dbtDraft';
import { readManifestMtime } from './services/manifestStaleness';
import { deriveAiHelperState, promptFor, SETUP_PROMPT, type GettingStartedStatus } from './types/gettingStarted';
import { assistantInfo } from './types/aiAssistants';
import { DRAW_FROM_DBT_COMMAND, drawFromDbt } from './commands/drawFromDbt';
import { IMPORT_DBML_COMMAND, importDbml } from './commands/importDbml';
import { OPEN_EXAMPLE_DIAGRAM_COMMAND, openExampleDiagram } from './commands/openExampleDiagram';
import { EXPORT_DIAGRAM_COMMAND, exportDiagramCommand } from './commands/exportDiagram';
import { EXPORT_ALL_DIAGRAMS_COMMAND, exportAllDiagramsCommand } from './commands/exportAllDiagrams';
import { exportSubjectAreaFile, exportSubjectAreaFiles } from './services/diagramExport';
import { moveRelationshipsToLibrary } from './commands/moveRelationshipsToLibrary';
import { saveDocumentByUri } from './providers/documentSave';
import { dirtyFiles } from './providers/dirtyDocuments';

/**
 * globalState key for the last extension version this host activated under.
 * If activation sees a different version stored here, the previous extension
 * host was torn down by an update — any open domain canvas is now orphaned
 * and the only reliable recovery is a window reload.
 */
const LAST_ACTIVATED_VERSION_KEY = 'lastActivatedVersion';

/**
 * workspaceState key set once the harness install QuickPick has been offered
 * for a workspace with no harness files, so it is not shown on every activation.
 */
const HARNESS_INSTALL_PROMPTED_KEY = 'erdStudio.harnessInstallPrompted';

/**
 * globalState: the Welcome panel has been opened automatically (or the
 * upgrade notice shown) on this machine. Once per user, never per workspace.
 */
export const GETTING_STARTED_SHOWN_KEY = 'erdStudio.gettingStartedShown';

/**
 * globalState: a fresh install (no `lastActivatedVersion`) is still owed the
 * Welcome panel. Set at the very top of activate() — before the no-project
 * early return — because the panel only auto-opens in a dbt project, and by
 * the time the user opens one `lastActivatedVersion` is already stored, so
 * that activation would otherwise look like an upgrade.
 */
export const GETTING_STARTED_PENDING_KEY = 'erdStudio.gettingStartedPending';

/**
 * globalState: the Welcome panel has already opened once in a window with no
 * dbt project. It does not clear the pending flag — the panel still opens
 * once more in the first dbt project, where its setup steps can actually run
 * (typically the sample project the no-project panel offered).
 */
export const GETTING_STARTED_NO_PROJECT_SHOWN_KEY = 'erdStudio.gettingStartedShownNoProject';

/**
 * The contributed walkthrough (package.json `contributes.walkthroughs`), as
 * `workbench.action.openWalkthrough` names it: `<publisher>.<name>#<id>`.
 */
export const WALKTHROUGH_ID = 'liamwynne.erd-studio#erdStudio.getStarted';

/**
 * workspaceState: the one-time "This project has N ERD Studio diagrams"
 * notice has been shown in this workspace.
 */
export const DIAGRAMS_NUDGE_SHOWN_KEY = 'erdStudio.diagramsNudgeShown';

/** Status bar item id (also the id users see in "Hide 'ERD Studio diagrams'"). */
export const DIAGRAMS_STATUS_ID = 'erdStudio.diagrams';

/**
 * Open the Get Started walkthrough. A host without the command (a fork, an
 * older build) gets the Welcome panel instead.
 */
async function openWalkthrough(fallback: () => void): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
    telemetry.feature('walkthroughOpened');
  } catch (err) {
    telemetry.error('walkthroughFailed');
    console.warn('[ERD Studio] Could not open the walkthrough, showing the Welcome panel instead:', err);
    fallback();
  }
}

/**
 * One automatic open per extension host, even if activation runs twice. Two
 * windows are two hosts; that race is accepted (both may open the panel once).
 */
let gettingStartedAutoOpened = false;

/** Tests run activate() many times in one module instance. */
export function _resetFirstRunGuardForTests(): void {
  gettingStartedAutoOpened = false;
}

export { findDbtProjectCandidates, hasErdStudioData, resolveDbtProjectRoot } from './services/projectDiscovery';

/**
 * workspaceState: the dbt project picked with **Select dbt Project…** (#82).
 * Per machine and never in a settings file — a personal choice must not land
 * in a `.code-workspace` or `.vscode/settings.json` a team commits.
 * `erdStudio.projectPath` stays the shareable, explicit override.
 */
export const SELECTED_PROJECT_KEY = 'erdStudio.selectedProjectRoot';

/** Filesystem paths of the open workspace folders, in workspace order. */
function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
}

/**
 * Resolve the project for this window: `erdStudio.projectPath`, then the
 * picked project, then dbt auto-detection, then (logical-only) the first
 * folder holding ERD data, then the first folder. See `resolveDbtProject`.
 */
function resolveWorkspaceProject(context: vscode.ExtensionContext): DbtProjectResolution {
  return resolveDbtProject(workspaceFolderPaths(), {
    projectPath: getErdStudioSetting('projectPath', ''),
    picked: context.workspaceState.get<string>(SELECTED_PROJECT_KEY),
    semanticDir: getErdStudioSetting('semanticDir', '.erd-studio'),
  });
}

/** Where a project sits in the workspace, for picker rows and messages. */
function describeProjectLocation(projectRoot: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot));
  if (!folder) { return projectRoot; }
  const rel = path.relative(folder.uri.fsPath, projectRoot);
  if (rel) { return `${folder.name}/${rel.split(path.sep).join('/')}`; }
  return folder.name === path.basename(projectRoot) ? 'workspace folder' : `workspace folder ${folder.name}`;
}

/** "In repo/analytics." plus a blank line for a nested project; nothing for a root folder, whose name is already in the title. */
function nestedLocation(projectRoot: string): string {
  const where = describeProjectLocation(projectRoot);
  return where.startsWith('workspace folder') ? '' : `In ${where}.\n\n`;
}

/**
 * **Select dbt Project…** — choose which dbt project ERD Studio opens when the
 * workspace holds more than one (multi-root workspaces, monorepos; #82).
 *
 * The first row, **Auto-detect**, clears the choice. Any other pick is kept
 * in `workspaceState` (this machine only) and applied by reloading the
 * window, which the confirmation offers directly. `target` skips the list —
 * the editor's "open this project instead" button passes the project that
 * owns the domain file the user just opened.
 */
async function selectDbtProject(
  context: vscode.ExtensionContext,
  currentRoot: string,
  semanticDir: string,
  target?: string,
): Promise<void> {
  const resolution = resolveWorkspaceProject(context);
  if (resolution.candidates.length === 0) {
    // A window always has a root here (the command is registered only then),
    // so no candidates means a plain folder: there is no dbt project to pick.
    void vscode.window.showInformationMessage(NEEDS_DBT_PROJECT_MESSAGE);
    return;
  }

  if (resolution.source === 'setting') {
    const choice = await vscode.window.showWarningMessage(
      `ERD Studio: the erdStudio.projectPath setting chooses the dbt project for this workspace (${path.basename(currentRoot)}). ` +
        'Clear it to pick a project here.',
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'erdStudio.projectPath');
    }
    return;
  }

  type ProjectPick = vscode.QuickPickItem & { projectRoot: string | undefined };
  let chosen: string | undefined;
  let fromAuto = false;
  if (target) {
    chosen = target;
  } else {
    const autoRoot = resolution.autoRoot;
    const items: ProjectPick[] = [
      {
        projectRoot: undefined,
        label: `${resolution.source === 'auto' ? '$(check)' : '$(sparkle)'} Auto-detect`,
        description: autoRoot ? `→ ${path.basename(autoRoot)}` : undefined,
        detail: 'Open the project that already has ERD diagrams' +
          (resolution.source === 'auto' ? ' · Current choice' : ''),
      },
      { projectRoot: undefined, label: 'dbt projects in this workspace', kind: vscode.QuickPickItemKind.Separator },
      ...resolution.candidates.map((projectRoot): ProjectPick => ({
        projectRoot,
        label: `${projectRoot === currentRoot ? '$(check)' : '$(folder)'} ${path.basename(projectRoot)}`,
        description: describeProjectLocation(projectRoot),
        detail: [
          projectRoot === currentRoot ? 'Open now' : undefined,
          hasErdStudioData(projectRoot, semanticDir) ? `Has ERD diagrams (${semanticDir})` : 'No ERD diagrams yet',
        ].filter(Boolean).join(' · '),
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'ERD Studio — Select dbt Project',
      placeHolder: 'Which dbt project should ERD Studio open in this workspace?',
      matchOnDescription: true,
    });
    if (!picked) { return; }
    if (picked.projectRoot === undefined) {
      // Auto-detect: forget the pick. Reload only if that moves the project.
      await context.workspaceState.update(SELECTED_PROJECT_KEY, undefined);
      if (!autoRoot || samePath(autoRoot, currentRoot)) { return; }
      chosen = autoRoot;
      fromAuto = true;
    } else {
      chosen = picked.projectRoot;
    }
  }

  if (samePath(chosen, currentRoot)) {
    // Already open. An explicit pick still pins it, so a project that gains
    // ERD data later cannot pull auto-detection away from it.
    await context.workspaceState.update(SELECTED_PROJECT_KEY, chosen);
    return;
  }

  const confirm = await vscode.window.showInformationMessage(
    `Switch ERD Studio to “${path.basename(chosen)}”?`,
    {
      modal: true,
      detail: `${nestedLocation(chosen)}The window reloads to open it. ` +
        'The choice is saved for this workspace on this machine only.',
    },
    'Switch and Reload',
  );
  if (confirm !== 'Switch and Reload') { return; }
  await context.workspaceState.update(SELECTED_PROJECT_KEY, fromAuto ? undefined : chosen);
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/**
 * Manifest failures counted as errors. `missing` is deliberately absent
 * (#110): no manifest.json is the normal state of a fresh clone before
 * `dbt parse`, and canvas opens already report it in the `manifest` field.
 */
export const MANIFEST_FAILURE_CODES: Partial<Record<ManifestLoadFailure, TelemetryErrorCode>> = {
  malformed: 'manifestMalformed',
  timeout: 'manifestTimeout',
};

/** The telemetry error a manifest load failure records, or null when it is not an error. */
export function manifestFailureCode(failure: ManifestLoadFailure): TelemetryErrorCode | null {
  return MANIFEST_FAILURE_CODES[failure] ?? null;
}

/** One once-per-day feature per reason a manifest is missing (#113). Booleans only, never a path. */
export const MANIFEST_MISSING_REASON_FEATURES: Record<ManifestMissingReason, TelemetryFeature> = {
  noTargetDir: 'manifestNoTargetDir',
  customTargetPath: 'manifestCustomTargetPath',
  noDbtFound: 'manifestNoDbtFound',
};

/**
 * Record why the manifest is missing (#113) — called from ManifestService's
 * `missing` load failure. Stat-only (never spawns dbt) and never throws.
 */
export function recordManifestMissingReasons(
  root: string,
  dbtConfig: DbtProjectConfig,
  deps?: ManifestMissingReasonDeps,
): void {
  try {
    for (const reason of manifestMissingReasons(root, dbtConfig, deps)) {
      telemetry.featureOnce(MANIFEST_MISSING_REASON_FEATURES[reason]);
    }
  } catch { /* telemetry must never break a manifest load */ }
}

const HARNESS_INSTALL_FEATURES: Record<HarnessTarget['id'], TelemetryFeature> = {
  claude: 'harnessInstallClaude',
  agents: 'harnessInstallAgents',
  copilot: 'harnessInstallCopilot',
  gemini: 'harnessInstallGemini',
  codex: 'harnessInstallCodex',
};

/**
 * Domain files ERD Studio itself is about to create outside the own-write
 * tracker (createDomain, renameDomain), so the watcher's create event for them
 * is not counted as `domainCreatedExternal`. Entries are removed when the event
 * arrives.
 */
const subjectAreasCreatedHere = new Set<string>();

/**
 * Usage telemetry: which AI assistants this machine has. Deferred so the PATH
 * scan never sits on the activation path; it reads the file system only and
 * never runs an assistant.
 */
function recordDetectedAssistants(): void {
  setTimeout(() => {
    try {
      telemetry.assistants(detectAiAssistants());
    } catch { /* telemetry must never break activation */ }
  }, 0);
}

/** workspaceState: the UTC day this workspace's physical tooling was last looked at. */
const PHYSICAL_TOOLING_DAY_KEY = 'erdStudio.telemetry.physicalToolingDay';
/** Long enough that the scan never competes with opening the first diagram. */
const PHYSICAL_TOOLING_DELAY_MS = 15_000;

/**
 * Usage telemetry: how this workspace builds its physical tables, and on which
 * platform, as fixed flags (`detectPhysicalTooling()`). Once per workspace per
 * UTC day, and not at all while telemetry is off. It searches file names and
 * reads the start of a few small files; it runs nothing and sends no path,
 * name or content.
 */
function recordPhysicalTooling(context: vscode.ExtensionContext): void {
  try {
    if (!telemetry.enabled() || !vscode.workspace.workspaceFolders?.length) return;
    const today = new Date().toISOString().slice(0, 10);
    if (context.workspaceState.get<string>(PHYSICAL_TOOLING_DAY_KEY) === today) return;
    setTimeout(() => {
      void detectPhysicalTooling(hostToolingProbe()).then(found => {
        telemetry.physicalTooling(found);
        void context.workspaceState.update(PHYSICAL_TOOLING_DAY_KEY, today);
      }, () => { /* telemetry must never break activation */ });
    }, PHYSICAL_TOOLING_DELAY_MS);
  } catch { /* telemetry must never break activation */ }
}

function hostToolingProbe(): ToolingProbe {
  const exclude = toolingExclude(getErdStudioSetting('semanticDir', '.erd-studio'));
  return {
    find: async (include, max) =>
      (await vscode.workspace.findFiles(include, exclude, max)).map(uri => uri.fsPath),
    readHead: async (file, bytes) => {
      const handle = await fs.promises.open(file, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.toString('utf8', 0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    manifestPathFor: dbtProjectFile => {
      const root = path.dirname(dbtProjectFile);
      return resolveManifestPath(root, readDbtProjectConfig(root));
    },
  };
}

function recordHarnessInstalls(results: HarnessInstallResult[]): void {
  for (const r of results) {
    const feature = r.success ? HARNESS_INSTALL_FEATURES[r.target.id] : undefined;
    if (feature) telemetry.feature(feature);
  }
}

/**
 * The empty window's message: any folder now opens (logical-only without
 * dbt), so the only "no project" left is no folder at all.
 */
export const NO_PROJECT_MESSAGE =
  'ERD Studio: Open a folder first. Any folder works; a dbt project also gets the Physical view.';

/** A dbt-only command run in a folder without dbt_project.yml (logical-only mode). */
export const NEEDS_DBT_PROJECT_MESSAGE =
  'ERD Studio: this folder is not a dbt project. Open the folder that holds dbt_project.yml to compare your design with what dbt built.';

/** "Open a folder first", with a button for each way out (#205). */
export async function showNoProjectWarning(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(NO_PROJECT_MESSAGE, 'Open Folder…', 'Open Settings');
  if (choice === 'Open Folder…') {
    void vscode.commands.executeCommand('vscode.openFolder');
  } else if (choice === 'Open Settings') {
    void vscode.commands.executeCommand('workbench.action.openSettings', 'erdStudio.projectPath');
  }
}

/**
 * Commands added after the `dbtSemantic.*` → `erdStudio.*` rename. They never
 * had a legacy id, so no user keybinding can reference one — registering an
 * alias for them would only widen the compatibility surface we are stuck with.
 * Consumed by `registerFallbackCommands` and mirrored by
 * `test/unit/extension.activate.test.ts`; `LEGACY_ALIASED_COMMANDS` at the end
 * of `activate()` is the matching allow-list of pre-rename names.
 */
export const NO_LEGACY_ALIAS = new Set([
  'erdStudio.reportBug',
  'erdStudio.showGettingStarted',
  'erdStudio.trySampleProject',
  'erdStudio.setupAiHelper',
  'erdStudio.drawFromDbt',
  'erdStudio.importDbml',
  'erdStudio.openExampleDiagram',
  'erdStudio.setFeedbackApiKey',
  'erdStudio.clearFeedbackApiKey',
  'erdStudio.refreshMyReports',
  'erdStudio.openTrackedReport',
  'erdStudio.organizeModelLibrary',
  'erdStudio.selectDbtProject',
  'erdStudio.resolveDuplicateModel',
  'erdStudio.moveRelationshipsToLibrary',
  'erdStudio.exportDiagram',
  'erdStudio.exportAllDiagrams',
  'erdStudio.migrateToTableNaming',
]);

/**
 * Commands activate() registers before the no-project early return, because
 * they work without a dbt project. registerFallbackCommands skips them —
 * registering an id twice throws.
 */
export const PRE_REGISTERED_COMMANDS = new Set([
  'erdStudio.reportBug',
  'erdStudio.showGettingStarted',
  'erdStudio.trySampleProject',
]);

/**
 * Register every contributed command (and its legacy dbtSemantic.* alias)
 * with a handler that explains why ERD Studio is inactive, plus a stub
 * custom editor for domain files. Used only in an empty window (any folder
 * opens, logical-only without dbt) so the palette, sidebar welcome buttons
 * and domain JSON files show a helpful message instead of "command not
 * found" / a blank editor error.
 */
function registerFallbackCommands(context: vscode.ExtensionContext): void {
  const contributed = (context.extension.packageJSON as {
    contributes?: { commands?: Array<{ command: string }> };
  }).contributes?.commands ?? [];

  for (const { command } of contributed) {
    // PRE_REGISTERED_COMMANDS are registered by activate() before this fallback
    // runs and work without a project; registering again would throw ("already exists").
    if (!command.startsWith('erdStudio.') || PRE_REGISTERED_COMMANDS.has(command)) { continue; }
    context.subscriptions.push(vscode.commands.registerCommand(command, showNoProjectWarning));
    // Post-rename commands never had a dbtSemantic.* id — see NO_LEGACY_ALIAS.
    if (NO_LEGACY_ALIAS.has(command)) { continue; }
    context.subscriptions.push(
      vscode.commands.registerCommand(command.replace(/^erdStudio\./, 'dbtSemantic.'), showNoProjectWarning),
    );
  }

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(SUBJECT_AREA_EDITOR_VIEW_TYPE, {
      resolveCustomTextEditor(_document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        panel.webview.options = { enableScripts: false };
        panel.webview.html =
          '<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:1.5em">' +
          '<h2>ERD Studio is inactive</h2>' +
          `<p>${NO_PROJECT_MESSAGE}</p>` +
          '<p>Reload the window after fixing the project location.</p>' +
          '</body></html>';
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

/**
 * Modification times closer together than this are treated as one checkout:
 * git keeps no mtimes, so a fresh clone stamps every file within moments and
 * "the newest" would only be checkout order.
 */
export const SAME_CHECKOUT_WINDOW_MS = 5_000;

/**
 * The domain whose file changed last (the only one, when there is one);
 * undefined for none. When every file's mtime falls within
 * `SAME_CHECKOUT_WINDOW_MS` — a fresh clone — the first domain in list (tree)
 * order is returned instead of an arbitrary checkout-order pick.
 */
export function mostRecentlyModified(domains: readonly SubjectAreaSummary[]): SubjectAreaSummary | undefined {
  let best: SubjectAreaSummary | undefined;
  let bestTime = -Infinity;
  let oldest = Infinity;
  for (const d of domains) {
    let time = 0;
    try { time = fs.statSync(d.filePath).mtimeMs; } catch { /* unreadable: oldest */ }
    oldest = Math.min(oldest, time);
    if (best === undefined || time > bestTime) {
      best = d;
      bestTime = time;
    }
  }
  if (domains.length > 1 && bestTime - oldest < SAME_CHECKOUT_WINDOW_MS) { return domains[0]; }
  return best;
}

function findMatchingTabs(fileUri: vscode.Uri): vscode.Tab[] {
  const allTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
  return allTabs.filter(tab => {
    const input = tab.input;
    return input && typeof input === 'object' && 'uri' in input &&
      (input as { uri: vscode.Uri }).uri.toString() === fileUri.toString();
  });
}

async function handleUnsavedChanges(
  fileUri: vscode.Uri,
  domainName: string,
  operation: 'deleting' | 'renaming',
): Promise<boolean> {
  const matchingTabs = findMatchingTabs(fileUri);
  const dirtyTab = matchingTabs.find(tab => tab.isDirty);

  if (!dirtyTab) {
    return true;
  }

  const saveChoice = await vscode.window.showWarningMessage(
    `Subject area "${domainName}" has unsaved changes. Save before ${operation}?`,
    { modal: true },
    'Save',
    'Discard',
    'Cancel',
  );

  if (saveChoice === 'Cancel' || saveChoice === undefined) {
    return false;
  }

  if (saveChoice === 'Save') {
    const doc = vscode.workspace.textDocuments.find(
      d => d.uri.toString() === fileUri.toString(),
    );
    if (doc) {
      const saved = await doc.save();
      if (!saved) {
        const opName = operation === 'deleting' ? 'Deletion' : 'Rename';
        void vscode.window.showErrorMessage(
          `Failed to save "${domainName}". ${opName} cancelled.`,
        );
        return false;
      }
    }
  }

  return true;
}

function validateSubjectAreaSlug(
  value: string,
  layer: Layer,
  existingDomains: SubjectAreaSummary[],
  currentDomainName?: string,
): string | undefined {
  if (!value || !value.trim()) {
    return 'Subject area name is required';
  }

  const slug = value.trim();

  if (currentDomainName && slug === currentDomainName) {
    return 'Subject area name unchanged';
  }

  if (!/^[a-z][a-z0-9_-]*$/.test(slug)) {
    return 'Subject area name must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores';
  }

  if (slug.length > 64) {
    return 'Subject area name must be 64 characters or less';
  }

  const collision = existingDomains.find(
    d => d.domain === slug && d.layer === layer,
  );
  if (collision) {
    return `A subject area named "${slug}" already exists in the ${layer} layer`;
  }

  return undefined;
}

/** Shared color options for layer creation and editing. */
const LAYER_COLOR_OPTIONS = [
  { label: '⚪ Silver', value: '#a0a0a0' },
  { label: '🟡 Gold', value: '#d4a800' },
  { label: '🔵 Blue', value: '#3b82f6' },
  { label: '🟢 Green', value: '#22c55e' },
  { label: '🟣 Purple', value: '#a855f7' },
  { label: '🟠 Orange', value: '#f97316' },
  { label: '🩵 Cyan', value: '#06b6d4' },
  { label: '🔴 Red', value: '#ef4444' },
  { label: '$(edit) Custom hex color...', value: 'custom' },
];

/** QuickPick labels for the canvas-less kind step, one per `FeedbackKind`. */
const FEEDBACK_KIND_PICKS: ReadonlyArray<{ label: string; kind: FeedbackKind }> = [
  { label: 'Report a bug', kind: 'bug' },
  { label: 'Request a feature', kind: 'feature' },
];

/**
 * "Send Feedback" without an active canvas: pick the kind, then gather a title
 * and a one-line description via input boxes, then open the prefilled GitHub
 * issue form. No duplicate check and no analysis — both of those need the
 * webview's dialog.
 *
 * Cancelling any of the three steps abandons the report.
 */
async function sendFeedbackWithoutCanvas(
  context: vscode.ExtensionContext,
  prefill?: { kind?: FeedbackKind; title?: string; description?: string },
  tracking?: ReportTrackingService,
): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    FEEDBACK_KIND_PICKS.map(p => p.label),
    { title: 'ERD Studio — Send Feedback (1/3)', placeHolder: 'What would you like to send?' },
  );
  if (picked === undefined) return;
  const kind = FEEDBACK_KIND_PICKS.find(p => p.label === picked)?.kind ?? prefill?.kind ?? 'bug';

  const title = await vscode.window.showInputBox({
    title: 'ERD Studio — Send Feedback (2/3)',
    prompt: 'One-line summary of the problem',
    value: prefill?.title ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Please enter a short title'),
  });
  if (title === undefined) return;
  const description = await vscode.window.showInputBox({
    title: 'ERD Studio — Send Feedback (3/3)',
    prompt: 'What happened? You can add more detail on GitHub before submitting.',
    value: prefill?.description ?? '',
    ignoreFocusOut: true,
  });
  if (description === undefined) return;
  const result = await submitFeedback(context, { kind, title, description, includeDiagnostics: true });
  // The browser is where the issue is actually filed, so all we can record is
  // that one was opened; the tracker reconciles it against GitHub later.
  if (result.ok && result.commentedOn === undefined) {
    await tracking?.recordPending(title, kind);
  }
}

/** Welcome panel deps in an empty window: the steps ask for a folder. */
function noProjectGettingStartedDeps(): GettingStartedDeps {
  return {
    workspaceRoot: null,
    semanticDir: getErdStudioSetting('semanticDir', '.erd-studio'),
    runSetup: async () => ({ ok: false, filesWritten: [], message: NO_PROJECT_MESSAGE }),
    getStatus: async () => ({
      hasProject: false,
      harness: {
        claude: { schemaSkill: 'missing', setupSkill: 'missing' },
        agents: { schemaSkill: 'missing', setupSkill: 'missing' },
      },
      cli: 'missing',
      helper: 'missing',
      claude: detectClaude().availability,
      assistants: detectAiAssistants(),
      domainCount: 0,
      project: null,
    }),
    clipboardText: (assistant) => (assistant && assistant !== 'claude' ? assistantInfo(assistant).prompt : SETUP_PROMPT),
    openCanvas: async () => {
      void vscode.window.showWarningMessage(NO_PROJECT_MESSAGE);
    },
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('ERD Studio is now active');

  // Auto-recover from extension updates that orphaned an open domain canvas.
  // VS Code 1.88+ restarts the extension host without a window reload when
  // an extension version changes — the new host has no message handler bound
  // for the existing webview, leaving a blank canvas. Detect by comparing
  // the version we last activated under to the current one. The globalState
  // update is awaited *before* the reload to prevent a reload loop if the
  // host crashes mid-recovery.
  const currentVersion = context.extension.packageJSON.version as string;
  const previousVersion = context.globalState.get<string>(LAST_ACTIVATED_VERSION_KEY);
  await context.globalState.update(LAST_ACTIVATED_VERSION_KEY, currentVersion);
  // Fresh install: remember that the Welcome panel is owed, even if this
  // activation has no dbt project and returns early below.
  if (previousVersion === undefined && !context.globalState.get<boolean>(GETTING_STARTED_SHOWN_KEY)) {
    await context.globalState.update(GETTING_STARTED_PENDING_KEY, true);
  }
  if (previousVersion && previousVersion !== currentVersion && hasOpenSubjectAreaCanvas()) {
    // If the user cancels the reload (unsaved files), keep activating so
    // commands and the custom editor are still registered for this host.
    if (await saveAllAndReload(`ERD Studio updated to v${currentVersion}`)) {
      return;
    }
  }

  // Usage telemetry: one anonymous heartbeat per UTC day, never while VS Code's
  // telemetry or erdStudio.telemetry.enabled is off. Constructed before the
  // project check so a no-project activation is counted too.
  const telemetryService = new TelemetryService(context);
  context.subscriptions.push(telemetryService);
  telemetryService.start();

  // "ERD Studio X fixes this — Update": checks recorded error codes against
  // the known-fixes registry. Independent of telemetry (it sends nothing about
  // the user); its own switch is erdStudio.checkKnownFixes.
  startKnownFixes(context);

  // "Send Feedback" is registered before any early return so it is always
  // reachable from the command palette, even when no dbt project is open.
  // When a canvas is active the report is routed through its webview so it can
  // include the diagnostics chips and the optional AI analysis.
  let editorProviderForFeedback: SemanticEditorProvider | undefined;
  let trackingServiceForFeedback: ReportTrackingService | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'erdStudio.reportBug',
      async (prefill?: { kind?: FeedbackKind; title?: string; description?: string }) => {
        if (editorProviderForFeedback?.requestFeedbackDialog(prefill)) return;
        telemetry.feature('feedbackOpened');
        await sendFeedbackWithoutCanvas(context, prefill, trackingServiceForFeedback);
      },
    ),
  );

  // "Watch Getting Started Video" works without a project too: the panel
  // asks for a folder. The project path fills in
  // gettingStartedDeps below (late-bound, like editorProviderForFeedback).
  let gettingStartedDeps: GettingStartedDeps | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand('erdStudio.showGettingStarted', () => {
      GettingStartedPanel.createOrShow(context, gettingStartedDeps ?? noProjectGettingStartedDeps());
    }),
  );

  // "Try the Sample Project" is for people with no dbt project yet, so it must
  // work in any window: confirm, then clone the fixed public sample repo.
  context.subscriptions.push(
    vscode.commands.registerCommand(TRY_SAMPLE_COMMAND, async () => {
      if (await trySampleProject() !== 'cancelled') { telemetry.feature('trySample'); }
    }),
  );

  const projectResolution = resolveWorkspaceProject(context);
  const workspaceRoot = projectResolution.root;
  // Logical-only mode: a root without dbt_project.yml (any folder now opens).
  // No Physical stage, no dbt services or watchers, nothing written unasked.
  const hasDbt = projectResolution.hasDbt;
  // Pick which sidebar welcome text shows (package.json viewsWelcome):
  // hasProject = a folder is open; hasDbtProject = it holds dbt_project.yml.
  void vscode.commands.executeCommand('setContext', 'erdStudio.hasProject', Boolean(workspaceRoot));
  void vscode.commands.executeCommand('setContext', 'erdStudio.hasDbtProject', hasDbt);
  if (!workspaceRoot) {
    telemetry.activation('no_project', false, 0);
    recordDetectedAssistants();
    recordPhysicalTooling(context);
    // Register stub commands / editor so palette entries and the sidebar
    // welcome buttons explain the problem instead of "command not found".
    registerFallbackCommands(context);
    // A fresh install first activated in an empty window (usually by
    // clicking the ERD Studio icon) still starts on the Get Started
    // walkthrough: the video, the sample project and how to open a folder.
    const pending = context.globalState.get<boolean>(GETTING_STARTED_PENDING_KEY) === true;
    if (pending && !context.globalState.get<boolean>(GETTING_STARTED_NO_PROJECT_SHOWN_KEY) && !gettingStartedAutoOpened) {
      gettingStartedAutoOpened = true;
      await context.globalState.update(GETTING_STARTED_NO_PROJECT_SHOWN_KEY, true);
      await openWalkthrough(() => GettingStartedPanel.createOrShow(context, noProjectGettingStartedDeps()));
    }
    // No toast for the ordinary case: an empty window is normal (the
    // extension activates on any of its commands), and the sidebar's welcome
    // view already says how to open a folder. An explicit
    // erdStudio.projectPath that points nowhere is a mistake, though, and is
    // still reported.
    if (projectResolution.invalidSetting !== undefined) {
      telemetry.error('projectPathInvalid');
      void vscode.window.showWarningMessage(
        `ERD Studio: erdStudio.projectPath "${projectResolution.invalidSetting}" is not a folder.`,
        'Open Settings',
      ).then(choice => {
        if (choice === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'erdStudio.projectPath');
        }
      });
    }
    return;
  }

  console.log(hasDbt
    ? `ERD Studio: Found dbt project at ${workspaceRoot}`
    : `ERD Studio: Opened ${workspaceRoot} (no dbt_project.yml: logical-only)`);

  const semanticDir = getErdStudioSetting('semanticDir', '.erd-studio');

  // More than one dbt project in the workspace (multi-root or monorepo, #82):
  // reveal the sidebar's Select dbt Project button. Re-checked when folders
  // are added or removed (see the domain tree view below).
  let hasMultipleProjects = projectResolution.candidates.length > 1;
  void vscode.commands.executeCommand('setContext', 'erdStudio.hasMultipleDbtProjects', hasMultipleProjects);

  if (projectResolution.invalidSetting !== undefined) {
    telemetry.error('projectPathInvalid');
    // Visible, not just a console line: a projectPath copied from someone
    // else's machine otherwise looks like the setting being ignored.
    void vscode.window.showWarningMessage(
      `ERD Studio: erdStudio.projectPath "${projectResolution.invalidSetting}" is not a folder, ` +
        `so ERD Studio opened ${path.basename(workspaceRoot)} instead.`,
      'Open Settings',
    ).then(choice => {
      if (choice === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'erdStudio.projectPath');
      }
    });
  }

  // v0.6.44 moved the default data directory from erd-studio/ to .erd-studio/.
  // Rename legacy folders in place before any service reads from disk so
  // existing projects keep working without intervention.
  try {
    if (migrateLegacySemanticDir(workspaceRoot, semanticDir)) {
      void vscode.window.showInformationMessage(
        'ERD Studio: your erd-studio/ folder was renamed to .erd-studio/ (the new default location). ' +
          'Commit the rename so collaborators stay in sync.',
      );
    }
  } catch (err) {
    // Never let a filesystem oddity (permissions, dangling symlink, …) in a
    // legacy folder abort activation — the rest of the extension still works.
    console.error('[ERD Studio] Legacy erd-studio/ migration failed:', err);
  }

  // Read target-path / model-paths / seed-paths / snapshot-paths from
  // dbt_project.yml once; every consumer (manifest parser, catalog reader,
  // schema walker, watchers) shares this. A change to these keys is picked up
  // by the dbt_project.yml watcher below, which prompts for a window reload.
  const dbtConfig = readDbtProjectConfig(workspaceRoot);

  const layerService = new LayerService(workspaceRoot, semanticDir);
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(workspaceRoot, semanticDir);
  tableLibraryService.onParseFailure = (error) => {
    // Fixed keys only — `error.message` may quote the file and never leaves the machine.
    telemetry.error('modelFileParse');
    telemetry.error(tableFileErrorCode(error.kind));
    // Once per broken file per session (the service never re-reports a path, #113),
    // and not again in a later session while the file is unchanged (#164).
    if (shouldWarnAboutTableFile(context.workspaceState, error.filePath)) {
      notifyTableFileError(error);
    }
  };
  // A model file's relationships: list could not be rewritten in place, so an edit was refused.
  tableLibraryService.onSyncRefused = () => telemetry.error('relSyncRefused');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  // Set once a manifest's (re)appearance has been counted, cleared when it is
  // seen missing again, so a manifest with no canvas to reload it (isMissing
  // then stays true) is not counted again on every later change (#113).
  let manifestAppearanceCounted = false;
  // Without dbt_project.yml the three dbt readers answer empty and never read
  // the folder (a plain folder's models/ or target/ is not dbt's).
  const manifestService = new ManifestService({ dbtConfig, enabled: hasDbt, onLoadFailure: f => {
    const code = manifestFailureCode(f);
    if (code) { telemetry.error(code); }
    if (f === 'missing') {
      manifestAppearanceCounted = false;
      recordManifestMissingReasons(workspaceRoot, dbtConfig);
    }
  } });
  const ymlParserService = new YmlParserService({ dbtConfig, enabled: hasDbt });
  // target/catalog.json — present only after `dbt docs generate`, and the only
  // source of the types the warehouse actually has. Shares the one dbtConfig
  // read above; never re-read dbt_project.yml for a second consumer.
  const catalogService = new CatalogService({ dbtConfig, enabled: hasDbt, onReadFailure: () => telemetry.error('catalogUnreadable') });
  const templateService = new TemplateService();
  // Status bar item shown while selectors.yml is out of sync (skipped writes).
  // Hidden as soon as a regenerate succeeds.
  let selectorsOutOfSyncStatus: vscode.StatusBarItem | undefined;

  const selectorsService = new SelectorsService(
    subjectAreaService,
    workspaceRoot,
    semanticDir,
    {
      // Paths compared as the file system does (a `c:` drive letter, a folder in another case).
      isFileDirtyInEditor: (filePath) => dirtyFiles([filePath]).length > 0,
      onSkipped: (info) => {
        const message = info.reason === 'unsaved-edits'
          ? 'selectors.yml has unsaved edits in your editor — ERD Studio won\'t overwrite to avoid losing your work. ' +
            'Save (or revert) the file, then click "Resync now" to update selectors.yml.'
          : `selectors.yml has a YAML syntax error and can't be safely regenerated: ${info.detail} ` +
            'Fix the syntax error in selectors.yml, save the file, then click "Resync now" to update.';

        void vscode.window
          .showWarningMessage(message, 'Show file', 'Resync now')
          .then((choice) => {
            if (choice === 'Show file') {
              void vscode.window.showTextDocument(vscode.Uri.file(info.filePath));
            } else if (choice === 'Resync now') {
              void vscode.commands.executeCommand('erdStudio.syncDomainTags');
            }
          });

        if (!selectorsOutOfSyncStatus) {
          selectorsOutOfSyncStatus = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            0,
          );
          selectorsOutOfSyncStatus.command = 'erdStudio.syncDomainTags';
          selectorsOutOfSyncStatus.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.warningBackground',
          );
          context.subscriptions.push(selectorsOutOfSyncStatus);
        }
        selectorsOutOfSyncStatus.text = '$(warning) selectors.yml out of sync';
        selectorsOutOfSyncStatus.tooltip = info.reason === 'unsaved-edits'
          ? 'selectors.yml has unsaved edits — save the file, then click to resync.'
          : `selectors.yml is malformed (${info.detail.split('\n')[0]}) — fix the YAML, then click to resync.`;
        selectorsOutOfSyncStatus.show();
      },
      onWritten: () => {
        selectorsOutOfSyncStatus?.hide();
      },
      onNameCollision: (info) => {
        void vscode.window.showWarningMessage(
          `ERD Studio: selector name "${info.requestedName}" for subject area ${info.domain} collides with ` +
            `${info.conflictsWith}. Wrote "${info.assignedName}" to selectors.yml instead — ` +
            'rename one of the subject areas to avoid the suffix.',
        );
      },
    },
  );
  const legacyTagCleanupService = new LegacyTagCleanupService(workspaceRoot);

  // Ensure selectors.yml exists and is up to date at activation time so a
  // fresh `git clone` with pre-existing domain files gets a valid selector
  // set before the user makes any edits. Debounced so activation isn't
  // blocked on disk I/O. Never in a folder without dbt_project.yml:
  // selectors.yml is a dbt file, and activation there writes nothing. The
  // guard is belt-and-braces: regenerate() itself returns 'not-dbt-project'
  // for a root without dbt_project.yml, which covers every post-edit caller.
  if (hasDbt) { selectorsService.scheduleRegenerate(); }

  // Check for v4 → v5 migration (non-blocking)
  const migrationService = new MigrationService(workspaceRoot, layerService, tableLibraryService, semanticDir);
  if (migrationService.needsMigration()) {
    void vscode.window.showInformationMessage(
      'ERD Studio has a new table storage format that lets subject areas share tables. Migrate subject area files now?',
      'Migrate Now',
      'Later',
    ).then((choice) => {
      if (choice === 'Migrate Now') {
        const result = migrationService.migrate();
        const details: string[] = [];
        if (result.domainsConverted > 0) details.push(`${result.domainsConverted} subject area(s) converted`);
        if (result.modelsCreated > 0) details.push(`${result.modelsCreated} table file(s) created in the Table Library`);
        if (result.mergeConflicts.length > 0) details.push(`${result.mergeConflicts.length} merge conflict(s) resolved (richest version kept)`);
        vscode.window.showInformationMessage(`Migration complete: ${details.join(', ')}.`);
        selectorsService.scheduleRegenerate();
      }
    });
  }
  const treeProvider = new SubjectAreaTreeProvider(subjectAreaService, layerService, workspaceRoot, semanticDir);
  const tableLibraryProvider = new TableLibraryTreeProvider(
    tableLibraryService,
    subjectAreaService,
    workspaceRoot,
    semanticDir,
    () => layerService.getAllLayers(),
  );
  const editorProvider = new SemanticEditorProvider(
    context,
    subjectAreaService,
    manifestService,
    ymlParserService,
    templateService,
    layerService,
    workspaceRoot,
    selectorsService,
    tableLibraryService,
  );
  editorProviderForFeedback = editorProvider;

  // Report tracking is constructed here, before refreshContextKeys() is defined
  // and called below, so nothing can reference a service that does not exist
  // yet. It owns its own `erdStudio.hasTrackedReports` context key (which gates
  // the My Reports view) — refreshContextKeys deliberately knows nothing about it.
  const trackingService = new ReportTrackingService(context);
  const myReportsProvider = new MyReportsTreeProvider(trackingService);
  trackingServiceForFeedback = trackingService;
  editorProvider.setReportTracking(trackingService);
  editorProvider.setCatalogService(catalogService);
  editorProvider.setLogicalOnly(!hasDbt);

  const decorationProvider = new SemanticFileDecorationProvider(layerService, semanticDir);
  const layerDecorationProvider = new LayerDecorationProvider(layerService);

  // Set context keys so view/title menus only show when semantic dir exists.
  // Re-evaluated whenever the semantic dir changes on disk (watcher events) or
  // the extension itself creates it (createDomain, addLayer, setup), so the
  // "+ Add Layer" / "Install Harness" buttons appear without a window reload.
  const fullSemanticDirPath = path.join(workspaceRoot, semanticDir);

  // "ERD N" in the status bar while the project has diagrams: one click from
  // any file back to a canvas. Kept current by refreshContextKeys(), which
  // every create / delete / external-change path already calls.
  const diagramsStatus = vscode.window.createStatusBarItem(DIAGRAMS_STATUS_ID, vscode.StatusBarAlignment.Left, -100);
  diagramsStatus.name = 'ERD Studio diagrams';
  diagramsStatus.tooltip = 'Open an ERD Studio diagram';
  diagramsStatus.command = 'erdStudio.openDomain';
  context.subscriptions.push(diagramsStatus);
  const refreshDiagramsStatus = (): void => {
    const count = subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir).length;
    if (count === 0) {
      diagramsStatus.hide();
      return;
    }
    diagramsStatus.text = `$(type-hierarchy) ERD ${count}`;
    diagramsStatus.show();
  };

  // The project's storage as the context key last said it (§5.6): the
  // foreign-format warning compares against it, since the file that triggers
  // the warning itself makes the project `mixed`.
  let knownStorage: ProjectStorage = 'yaml';
  // `tablesLayerConflict` (§3.3) is shown once per session.
  let tablesLayerConflictShown = false;
  const refreshContextKeys = (): void => {
    const hasSemanticDir = fs.existsSync(fullSemanticDirPath);
    void vscode.commands.executeCommand('setContext', 'erdStudio.hasSemanticDir', hasSemanticDir);
    knownStorage = projectStorageOf(tableLibraryService);
    void vscode.commands.executeCommand('setContext', 'erdStudio.storage', knownStorage);
    // A project that writes the v6 naming (#182) makes `tables/` with its first
    // table, so the view shows from setup on, not only once a table exists;
    // so does a DBML project (its library is always `tables/`).
    void vscode.commands.executeCommand('setContext', 'erdStudio.hasLogicalModelsDir',
      tableLibraryService.dirExists() || (hasSemanticDir && (tableLibraryService.writesTableNaming() || knownStorage !== 'yaml')));
    refreshDiagramsStatus();
    if (!tablesLayerConflictShown && hasSemanticDir) {
      const conflict = tablesLayerConflict(fullSemanticDirPath);
      if (conflict) {
        tablesLayerConflictShown = true;
        void vscode.window.showWarningMessage(`ERD Studio: ${conflict}`);
      }
    }
  };
  refreshContextKeys();

  // The one domain picker: straight to the only domain, a QuickPick when
  // there are several. Shared by openCanvas and Export Diagram.
  const pickDomainFile = async (
    domains: ReturnType<SubjectAreaService['listSubjectAreas']>,
    placeHolder: string,
  ): Promise<string | undefined> => {
    if (domains.length <= 1) { return domains[0]?.filePath; }
    const picked = await vscode.window.showQuickPick(
      domains.map((d) => ({ label: d.domain, description: d.layer, summary: d })),
      { placeHolder },
    );
    return picked?.summary.filePath;
  };
  // "Open a domain" (Welcome panel, status bar, palette): straight in when
  // there is one, a pick when there are several, the create flow when none.
  const openCanvas = async (): Promise<void> => {
    const domains = subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir);
    if (domains.length === 0) {
      // A plain folder goes straight to New Diagram, which makes the ERD
      // folder itself (setup's extra layer folders are for dbt projects).
      await vscode.commands.executeCommand(
        fs.existsSync(fullSemanticDirPath) || !hasDbt ? 'erdStudio.createDomain' : 'erdStudio.setupSemanticDirectory',
      );
      return;
    }
    const target = await pickDomainFile(domains, 'Open which subject area?');
    if (!target) { return; }
    await vscode.commands.executeCommand('erdStudio.openDomain', target);
  };
  telemetry.activation('project_found', fs.existsSync(fullSemanticDirPath), subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir).length);
  // A presence flag, once a day: activation resolved a root without dbt_project.yml.
  if (!hasDbt) { telemetry.featureOnce('logicalOnlyProject'); }
  recordDetectedAssistants();
  recordPhysicalTooling(context);

  // Surface a broken layers.json once per distinct error. LayerService falls
  // back to default layers in memory but refuses to overwrite the file, so the
  // user must know why their custom layers vanished.
  let lastLayerLoadErrorShown: string | null = null;
  const warnIfLayerConfigBroken = (): void => {
    const loadError = layerService.getLoadError();
    if (!loadError || loadError === lastLayerLoadErrorShown) {
      if (!loadError) { lastLayerLoadErrorShown = null; }
      return;
    }
    lastLayerLoadErrorShown = loadError;
    telemetry.error('layersInvalid');
    void vscode.window.showWarningMessage(
      `ERD Studio: ${semanticDir}/layers.json could not be loaded (${loadError}). ` +
      'Default layers are shown until the file is fixed; layer changes are disabled to avoid overwriting it.',
      'Open layers.json',
    ).then(choice => {
      if (choice === 'Open layers.json') {
        void vscode.window.showTextDocument(vscode.Uri.file(layerService.getConfigPath()));
      }
    });
  };
  warnIfLayerConfigBroken();

  // -------------------------------------------------------------------------
  // File watchers
  // -------------------------------------------------------------------------
  // No manifest / catalog / dbt source / dbt_project.yml watchers without dbt.
  const fileWatcherService = new FileWatcherService(workspaceRoot, semanticDir, dbtConfig, undefined, { dbt: hasDbt });

  // Manifest changed → refresh open editors
  let manifestRetryTimeout: ReturnType<typeof setTimeout> | undefined;
  let manifestChangeGen = 0;
  const manifestChangedSubscription = fileWatcherService.onManifestChanged(
    async () => {
      const gen = ++manifestChangeGen;
      // isMissing reflects the last load, before this change (#113).
      const wasMissing = manifestService.isMissing;
      manifestService.invalidate();
      if (!manifestAppearanceCounted) {
        let existsNow = false;
        try { existsNow = fs.existsSync(manifestService.getManifestPath(workspaceRoot)); } catch { /* treat as absent */ }
        const appeared = manifestAppearanceFeature(wasMissing, existsNow, getLastDbtParseLaunchAt(), Date.now());
        if (appeared) {
          manifestAppearanceCounted = true;
          telemetry.feature(appeared);
        }
      }
      await editorProvider.refreshAllOpenSubjectAreas();

      // Superseded by a newer file-change event during the await
      if (gen !== manifestChangeGen) { return; }

      if (manifestService.isMissing) {
        // Definitive (dbt clean / target removed) — no retry, no stale data.
        void vscode.window.showWarningMessage(
          `dbt manifest removed (${manifestDisplayPath(workspaceRoot, dbtConfig)}). ` +
            'Your dbt models and relationships still come from your schema .yml files. ' +
            'Run dbt parse to write it again (needs a working dbt profile), or dbt docs generate for warehouse types.',
          RUN_DBT_PARSE_ACTION,
        ).then(pick => { if (pick === RUN_DBT_PARSE_ACTION) { void runDbtParse(workspaceRoot); } });
        return;
      }

      if (manifestService.isStale) {
        // Manifest likely mid-write by dbt — deduplicate and retry once after 2s
        clearTimeout(manifestRetryTimeout);
        manifestRetryTimeout = setTimeout(async () => {
          const retryGen = manifestChangeGen;
          try {
            manifestService.invalidate();
            await editorProvider.refreshAllOpenSubjectAreas();
            // Superseded by a newer event during retry
            if (retryGen !== manifestChangeGen) { return; }
            if (!manifestService.isStale) {
              void vscode.window.showInformationMessage(
                'dbt manifest updated. Graphs refreshed with latest dbt model data.',
              );
            } else {
              void vscode.window.showWarningMessage(
                'dbt manifest still updating — graph may show stale data. Run dbt compile to refresh.',
              );
            }
          } catch (err) {
            console.error('[ERD Studio] Manifest retry failed:', err);
          }
        }, 2000);
      } else {
        void vscode.window.showInformationMessage(
          'dbt manifest updated. Graphs refreshed with latest dbt model data.',
        );
      }
    },
  );

  // Catalog changed → refresh open editors, SILENTLY. `dbt docs generate`
  // writes manifest.json and catalog.json minutes apart and the manifest
  // handler above already announces itself; a second toast for the same command
  // would say nothing new.
  const catalogChangedSubscription = fileWatcherService.onCatalogChanged(async () => {
    catalogService.invalidate();
    await editorProvider.refreshAllOpenSubjectAreas();
  });

  // A DBML relationships file changed externally: its Refs may belong to any
  // table (a misplaced Ref attaches wherever its owner is), so every open
  // canvas is redrawn (§5.4). Never a table event.
  const relationshipsChangedSubscription = fileWatcherService.onRelationshipsChanged(async () => {
    tableLibraryService.invalidateRelationships();
    await editorProvider.refreshAllOpenSubjectAreas();
    treeProvider.refresh();
    tableLibraryProvider.refresh();
    refreshContextKeys();
  });

  // A `.yml` table or `.json` diagram ERD Studio did not write appeared in a
  // DBML project: most likely an AI helper set up before 2.0 (§5.4). Said
  // once per session; the file is never converted or deleted.
  let foreignFormatWarned = false;
  const foreignFormatSubscription = fileWatcherService.onForeignFormatCreated(({ uri }) => {
    if (foreignFormatWarned || knownStorage !== 'dbml') return;
    foreignFormatWarned = true;
    telemetry.featureOnce('dbmlForeignFormatWarned');
    const shown = path.relative(workspaceRoot, uri.fsPath).split(path.sep).join('/');
    void vscode.window.showWarningMessage(
      `A YAML/JSON file was just added to this DBML project (${shown}), probably by an AI helper set up before ERD Studio 2.0. ` +
        'Update the AI helper files so it writes DBML?',
      'Update AI Helper Files',
      'Not Now',
    ).then((choice) => {
      if (choice !== 'Update AI Helper Files') return;
      const harnessService = new HarnessService(semanticDir);
      const results = harnessService.detectStale(workspaceRoot).map((target) => harnessService.install(workspaceRoot, target, true));
      recordHarnessInstalls(results);
      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        void vscode.window.showErrorMessage(
          `ERD Studio: ${failed.length} AI helper file(s) could not be updated. Errors: ${failed.map((r) => `${r.target.id}: ${r.error}`).join('; ')}`,
        );
      } else {
        void vscode.window.showInformationMessage(
          results.length > 0 ? `ERD Studio: Updated ${results.length} AI helper file(s) to v${HARNESS_VERSION}.` : 'ERD Studio: The AI helper files are up to date.',
        );
      }
    });
  });

  // Semantic file changed externally → refresh tree view + model library
  const semanticChangedSubscription = fileWatcherService.onSemanticFileChanged(({ uri, created }) => {
    // A DBML diagram's layout file lives beside it and is no open document of
    // the canvas: its change arrives here as a change to the diagram (§5.4).
    if (uri.fsPath.endsWith('.dbml')) void editorProvider.refreshSubjectAreaPanel(uri.fsPath);
    // A domain file ERD Studio did not write appeared: an AI assistant, a hand
    // edit or a git pull. createDomain / renameDomain write outside the own-write
    // tracker, so they mark their paths in subjectAreasCreatedHere instead.
    if (created && !subjectAreasCreatedHere.delete(uri.fsPath)) { telemetry.feature('domainCreatedExternal'); }
    // A canvas showing "deleted or renamed" whose file is back redraws (#161).
    editorProvider.syncSubjectAreaFilePresence();
    treeProvider.invalidateSubjectArea(uri.fsPath);
    treeProvider.refresh();
    tableLibraryProvider.refresh();
    // A pulled/created .erd-studio/ must reveal the view/title buttons without a reload
    refreshContextKeys();
  });

  // The editor wrote a domain (and possibly model files) itself. Those writes
  // are recorded as own writes so the watchers skip them (a watcher-driven
  // refresh would send a second, identical domainLoaded and clear the user's
  // column selection), so the side effects the watcher used to drive are
  // issued here directly instead.
  const editorWroteSubscription = editorProvider.onDidWriteSubjectArea(({ uri, modelLibraryChanged }) => {
    treeProvider.invalidateSubjectArea(uri.fsPath);
    treeProvider.refresh();
    // The Model Library lists a "N domains" count and the referencing domain
    // names per model, so ANY domain write can change what it shows — adding or
    // removing a model reference changes the count without creating or deleting
    // a yml file. Refresh on every write; `modelLibraryChanged` only gates the
    // context keys, which turn on the view itself and can only change when a
    // file appears or disappears.
    tableLibraryProvider.refresh();
    if (modelLibraryChanged) {
      refreshContextKeys();
    }
  });

  // Domain file(s) deleted → flag open canvases, refresh tree + model library, prompt for tag cleanup.
  // The watcher coalesces a delete storm (branch switch) into one event and
  // filters out layers.json / templates / logical-models / .sync-plan.json, so
  // one toast covers the whole burst and only real domain files trigger it.
  // NOTE: reconcileAll() is NOT called automatically here because git operations
  // (pull, checkout, merge, rebase) trigger file-delete events on Windows (delete-
  // then-rename) and macOS (atomic rename via FSEvents), causing mass YAML
  // modifications. Instead, offer to run the manual sync command.
  const semanticDeletedSubscription = fileWatcherService.onSemanticFileDeleted(({ uris }) => {
    // An open canvas whose file is gone says so at once, instead of staying
    // editable until a refresh fails (#161).
    editorProvider.syncSubjectAreaFilePresence();
    for (const uri of uris) {
      treeProvider.invalidateSubjectArea(uri.fsPath);
    }
    treeProvider.refresh();
    tableLibraryProvider.refresh();
    refreshContextKeys();
    const subject = uris.length === 1
      ? 'Subject area file deleted.'
      : `${uris.length} subject area files deleted.`;
    void vscode.window.showInformationMessage(
      `${subject} Regenerate dbt selectors.yml to drop the removed subject area${uris.length === 1 ? '' : 's'} from the selector set.`,
      'Regenerate Now',
    ).then(choice => {
      if (choice === 'Regenerate Now') {
        void vscode.commands.executeCommand('erdStudio.syncDomainTags');
      }
    });
  });

  // layers.json changed externally (git pull, manual edit, delete) → drop the
  // cached layer list so the tree, decorations and domain listing pick up the
  // new layers; warn if the file is now unreadable.
  const layerConfigChangedSubscription = fileWatcherService.onLayerConfigChanged(() => {
    layerService.invalidateCache();
    treeProvider.invalidateSubjectArea();
    treeProvider.refresh();
    tableLibraryProvider.refresh();
    layerDecorationProvider.refresh();
    decorationProvider.refresh();
    refreshContextKeys();
    warnIfLayerConfigBroken();
  });

  // Logical model file changed → refresh domains referencing that model + model library
  const logicalModelChangedSubscription = fileWatcherService.onTableChanged(
    async ({ modelName }) => {
      tableLibraryService.invalidateCache(modelName);
      await editorProvider.refreshSubjectAreasReferencingTable(modelName);
      treeProvider.refresh();
      tableLibraryProvider.refresh();
      // Re-evaluate context key so the Model Library view appears if logical-models/ was just created
      refreshContextKeys();
    },
  );

  // dbt schema .yml changed → refresh physical stage
  const dbtYmlChangedSubscription = fileWatcherService.onDbtYmlChanged(
    async () => {
      ymlParserService.invalidate();
      await editorProvider.refreshAllOpenSubjectAreas();
    },
  );

  // dbt_project.yml path config changed → suggest window reload
  const projectChangedSubscription = fileWatcherService.onProjectConfigChanged(() => {
    void vscode.window.showWarningMessage(
      'dbt_project.yml path configuration changed (target-path / model-paths / seed-paths / snapshot-paths). A window reload is needed to pick up the new paths.',
      'Reload Window',
    ).then(action => {
      if (action === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
  });

  // erdStudio.* settings are read once at activation (semanticDir feeds every
  // service constructor), so a mid-session change needs a window reload.
  const activationSettings = {
    semanticDir,
    projectPath: getErdStudioSetting('projectPath', ''),
  };
  const configChangedSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('erdStudio') && !e.affectsConfiguration('dbtSemantic')) {
      return;
    }
    const nextSemanticDir = getErdStudioSetting('semanticDir', '.erd-studio');
    const nextProjectPath = getErdStudioSetting('projectPath', '');
    if (
      nextSemanticDir === activationSettings.semanticDir &&
      nextProjectPath === activationSettings.projectPath
    ) {
      return;
    }
    void vscode.window.showWarningMessage(
      'ERD Studio settings changed (semanticDir / projectPath). A window reload is needed for the new values to take effect.',
      'Reload Window',
    ).then(action => {
      if (action === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
  });

  /** "Migrate Subject Areas to the Central Table Library": v4 → v5, prompted. True when it ran. */
  const migrateToV5 = async (): Promise<boolean> => {
    const v4Count = migrationService.findV4SubjectAreas().length;
    const confirm = await vscode.window.showWarningMessage(
      `Found ${v4Count} subject area file(s) using the legacy inline table format. ` +
      'Migration will extract tables to the Table Library and convert subject area files to use name references. ' +
      'This cannot be undone automatically.',
      'Migrate Now',
      'Cancel',
    );

    if (confirm !== 'Migrate Now') return false;

    let result: ReturnType<typeof migrationService.migrate>;
    try {
      result = migrationService.migrate();
    } catch (err) {
      telemetry.error('migrationFailed');
      throw err;
    }
    telemetry.feature('migrateV5');
    const details: string[] = [];
    if (result.domainsConverted > 0) details.push(`${result.domainsConverted} subject area(s) converted`);
    if (result.modelsCreated > 0) details.push(`${result.modelsCreated} table file(s) created in the Table Library`);
    if (result.mergeConflicts.length > 0) details.push(`${result.mergeConflicts.length} merge conflict(s) resolved`);
    void vscode.window.showInformationMessage(`Migration complete: ${details.join(', ')}.`);

    treeProvider.refresh();
    await editorProvider.refreshAllOpenSubjectAreas();
    selectorsService.scheduleRegenerate();
    return true;
  };

  /** "Migrate to the New File Naming" (#182): v5 → v6, prompted. */
  const migrateNaming = () => migrateToTableNaming({
    workspaceRoot,
    semanticDir,
    subjectAreaService,
    tableLibraryService,
    version: currentVersion,
    migrateToV5,
    holdRefreshes: () => editorProvider.holdRefreshes(),
    onMigrated: async (paths) => {
      for (const p of paths) treeProvider.invalidateSubjectArea(p);
      refreshContextKeys();
      tableLibraryProvider.refresh();
      treeProvider.refresh();
      selectorsService.scheduleRegenerate();
      await editorProvider.refreshAllOpenSubjectAreas();
    },
  });
  editorProvider.setNamingMigration(
    () => planProjectNamingMigration({ workspaceRoot, semanticDir, subjectAreaService, tableLibraryService }),
    () => projectNamingOf(path.join(workspaceRoot, semanticDir), tableLibraryService),
    async () => (await migrateNaming()) === 'migrated',
    currentVersion,
  );

  // After Draw from dbt or Import DBML writes a new diagram and its tables.
  // Every file was recorded as an own write, so the watchers stay quiet;
  // issue their refreshes here, as createDomain does.
  const refreshAfterNewSubjectArea = ({ domainPath, modelNames, changedModelNames }: {
    domainPath: string; modelNames: string[]; changedModelNames: string[];
  }): void => {
    layerService.invalidateCache();
    treeProvider.invalidateSubjectArea(domainPath);
    treeProvider.refresh();
    if (modelNames.length > 0 || changedModelNames.length > 0) { tableLibraryProvider.refresh(); }
    // A new table file may be one an open diagram already references
    // (a placeholder until now), and an existing one that gained a library
    // relationship is drawn in every open diagram holding both ends; the
    // table watcher skipped both own writes.
    for (const name of [...modelNames, ...changedModelNames]) { void editorProvider.refreshSubjectAreasReferencingTable(name); }
    layerDecorationProvider.refresh();
    decorationProvider.refresh();
    refreshContextKeys();
    selectorsService.scheduleRegenerate();
  };

  context.subscriptions.push(
    { dispose() { clearTimeout(manifestRetryTimeout); } },
    configChangedSubscription,
    treeProvider,
    decorationProvider,
    layerDecorationProvider,
    fileWatcherService,
    manifestChangedSubscription,
    catalogChangedSubscription,
    semanticChangedSubscription,
    relationshipsChangedSubscription,
    foreignFormatSubscription,
    editorWroteSubscription,
    semanticDeletedSubscription,
    layerConfigChangedSubscription,
    logicalModelChangedSubscription,
    dbtYmlChangedSubscription,
    projectChangedSubscription,
    (() => {
      const treeView = vscode.window.createTreeView('erdStudio.domainTree', {
        treeDataProvider: treeProvider,
        dragAndDropController: treeProvider,
        canSelectMany: false,
      });
      // Whenever there is a choice to make, the first row of the tree names
      // the open project and switches it on click — always visible, unlike
      // the view-title icon, which VS Code only shows on hover (#82).
      const showProjectName = (): void => {
        treeProvider.setProjectRow(hasMultipleProjects
          ? { name: path.basename(workspaceRoot), location: describeProjectLocation(workspaceRoot) }
          : undefined);
      };
      showProjectName();
      const foldersChanged = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        hasMultipleProjects = resolveWorkspaceProject(context).candidates.length > 1;
        void vscode.commands.executeCommand('setContext', 'erdStudio.hasMultipleDbtProjects', hasMultipleProjects);
        showProjectName();
      });
      return vscode.Disposable.from(treeView, foldersChanged);
    })(),
    vscode.window.registerCustomEditorProvider(SUBJECT_AREA_EDITOR_VIEW_TYPE, editorProvider, {
      // Keep the webview (React tree, ELK worker, in-progress discrepancy /
      // sync-merge state) alive when the tab is hidden instead of tearing it
      // down and rebuilding from PersistedState on every tab switch.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.window.registerFileDecorationProvider(layerDecorationProvider),
    tableLibraryProvider,
    (() => {
      return vscode.window.createTreeView('erdStudio.modelLibrary', {
        treeDataProvider: tableLibraryProvider,
        canSelectMany: false,
      });
    })(),
    trackingService,
    myReportsProvider,
    vscode.window.createTreeView('erdStudio.myReports', {
      treeDataProvider: myReportsProvider,
      canSelectMany: false,
    }),
    trackingService.onDidChangeReports(() => {
      myReportsProvider.refresh();
    }),
    vscode.commands.registerCommand('erdStudio.setFeedbackApiKey', () => setFeedbackApiKey(context)),
    vscode.commands.registerCommand('erdStudio.clearFeedbackApiKey', () => clearFeedbackApiKey(context)),
    vscode.commands.registerCommand('erdStudio.refreshMyReports', () => trackingService.refresh({ force: true })),
    // Code-only (never contributed): the row's own command, so it stays out of
    // the palette and out of registerFallbackCommands.
    vscode.commands.registerCommand('erdStudio.openTrackedReport', (node?: MyReportNode) => {
      if (node?.report?.url) { void vscode.env.openExternal(vscode.Uri.parse(node.report.url)); }
    }),
    vscode.commands.registerCommand('erdStudio.deleteLogicalModel', async (node: TableLibraryNode | undefined) => {
      if (!node || node.type !== 'model') {
        void vscode.window.showErrorMessage('Delete Table: No table selected. Right-click a table in the Table Library.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete table "${node.name}"? This removes the YAML file — subject area references are not cleaned up.`,
        { modal: true },
        'Delete',
      );
      if (confirm === 'Delete') {
        try {
          tableLibraryService.deleteTable(node.name);
        } catch (err) {
          void vscode.window.showErrorMessage(`Delete Table: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        tableLibraryProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('erdStudio.selectDbtProject', (target?: unknown) =>
      selectDbtProject(context, workspaceRoot, semanticDir, typeof target === 'string' ? target : undefined)),
    // Move top-level logical-models/*.yml files into the folder of the one
    // layer whose domains use them (issue #76). Prompted, one WorkspaceEdit.
    vscode.commands.registerCommand('erdStudio.organizeModelLibrary', async () => {
      if (!tableLibraryService.dirExists()) {
        void vscode.window.showInformationMessage('Organise Table Library: there is no Table Library folder yet.');
        return;
      }
      const usage: SubjectAreaTableUsage[] = [];
      for (const summary of subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir)) {
        try {
          const names = subjectAreaTableNames(fs.readFileSync(summary.filePath, 'utf-8'), summary.filePath);
          if (names) usage.push({ layer: summary.layer, modelNames: names });
        } catch {
          // An unreadable domain contributes no usage; its models stay put.
        }
      }
      const modelsDir = tableLibraryService.getTablesDir();
      const plan = planOrganizeByLayer(
        // `.dbml` tables are not moved yet: their relationships and `use` lines move with them (S6).
        tableLibraryService.listTableFiles().filter((e) => e.storage === 'yaml'),
        usage,
        // Each file is organised within its own library: `logical-models/` or v6's `tables/` (#182).
        (name, layer, from) => TableLibraryService.isTableFolderName(layer)
          ? path.join(tableLibraryService.isTableNamingFile(from) ? path.join(path.dirname(modelsDir), TABLES_DIR) : modelsDir, layer, `${name}.yml`)
          : null,
        new Set(layerService.getAllLayers().map((l) => l.id)),
      );
      if (plan.moves.length === 0) {
        void vscode.window.showInformationMessage(
          `Organise Table Library: nothing to move. ${describeOrganizePlan(plan).replace(/\n+/g, ' ')}`,
        );
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        'Organise Table Library by Layer?',
        { modal: true, detail: describeOrganizePlan(plan) },
        'Move Files',
      );
      if (choice !== 'Move Files') return;

      const edit = new vscode.WorkspaceEdit();
      const newFolders = new Set<string>();
      for (const move of plan.moves) {
        const folder = path.dirname(move.to);
        if (!fs.existsSync(folder)) newFolders.add(folder);
        tableLibraryService.ensureDir(move.to);
        edit.renameFile(vscode.Uri.file(move.from), vscode.Uri.file(move.to), { overwrite: false });
      }
      if (!(await vscode.workspace.applyEdit(edit))) {
        // Leave no empty layer folders behind for a move that did not happen.
        for (const folder of newFolders) {
          try { fs.rmdirSync(folder); } catch { /* not empty, or already gone */ }
        }
        void vscode.window.showErrorMessage('Organise Table Library: VS Code rejected the file moves; nothing was changed.');
        return;
      }
      // Our own moves: the watcher must not bounce them back as external
      // edits. Nothing a canvas shows changed (domains resolve models by
      // name), so only the library view needs refreshing.
      for (const move of plan.moves) {
        ownWrites.recordWrite(move.to);
        ownWrites.recordDelete(move.from);
      }
      // A layer folder emptied by moving its files out is removed.
      for (const move of plan.moves) {
        if (!move.fromFolder) continue;
        const folder = path.dirname(move.from);
        try {
          if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
        } catch { /* already gone */ }
      }
      tableLibraryService.invalidateCache();
      tableLibraryProvider.refresh();
      void vscode.window.showInformationMessage(
        `Moved ${plan.moves.length} table file${plan.moves.length === 1 ? '' : 's'} into layer folders.`,
      );
    }),
    // A second file with a name the library already has is ignored (names are
    // identities). Give it its own name — `{layer}_{name}` — with an alias that
    // keeps the table name, and repoint the domains of its layer at it.
    // Prompted, one WorkspaceEdit, one undo step.
    vscode.commands.registerCommand('erdStudio.resolveDuplicateModel', async (arg?: TableLibraryNode | string) => {
      const entries = tableLibraryService.listTableFiles();
      // A duplicate within one library (#182: `tables/` too). A `tables/` copy of a
      // name `logical-models/` also has is the migration's conflict, not fixed here (#181).
      const duplicates = entries.filter((e) => e.shadowedBy && (!e.library || tableLibraryService.isTableNamingFile(e.shadowedBy))
        // A `.dbml` copy is not renamed yet: its `use` lines and Refs move with it (S6).
        && e.storage === 'yaml' && !e.shadowedBy.endsWith('.dbml'));
      const target = typeof arg === 'string' ? arg : arg?.type === 'model' ? arg.filePath : undefined;
      // Compare real paths: the tree hands over what the library listed, but a
      // warning or a caller may name the same file through a symlinked prefix.
      const realPath = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
      let entry = target === undefined ? undefined : duplicates.find((e) => realPath(e.filePath) === realPath(target));
      const libPath = (p: string): string => tableLibraryService.libraryRelativePath(p);
      if (!entry) {
        if (duplicates.length === 0) {
          void vscode.window.showInformationMessage('Every table file in the library has its own name.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          duplicates.map((e) => ({ label: libPath(e.filePath), description: `ignored — ${libPath(e.shadowedBy!)} is used`, entry: e })),
          { placeHolder: 'Which duplicate table file should get its own name?' },
        );
        if (!pick) return;
        entry = pick.entry;
      }
      const dup = entry;

      const model = (() => {
        try { return parseTableText(fs.readFileSync(dup.filePath, 'utf-8'), dup.name); } catch { return null; }
      })();
      if (!model) {
        void vscode.window.showErrorMessage(`${libPath(dup.filePath)} could not be read as a table file. Fix or rename it by hand.`);
        return;
      }

      const taken = new Set(entries.map((e) => e.name));
      const newName = (await vscode.window.showInputBox({
        title: `Give ${libPath(dup.filePath)} its own name`,
        prompt: `Table names are unique, as dbt model names are. The warehouse table name stays "${model.alias || dup.name}" (set as the table's alias).`,
        value: suggestDuplicateName(dup.name, dup.folder, taken),
        ignoreFocusOut: true,
        validateInput: (value) => validateTableName(value)
          ?? (taken.has(value.trim()) ? `"${value.trim()}" already exists in the Table Library.` : null),
      }))?.trim();
      if (!newName) return;

      const references: SubjectAreaReference[] = [];
      for (const summary of subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir)) {
        try {
          if (summary.storage === 'dbml') continue;
          const raw = JSON.parse(fs.readFileSync(summary.filePath, 'utf-8')) as unknown;
          if (getRawSubjectAreaTableNames(raw).includes(dup.name)) {
            references.push({ filePath: summary.filePath, domain: summary.domain, layer: summary.layer });
          }
        } catch {
          // An unreadable domain is not repointed; it keeps the name it has.
        }
      }
      const plan = planDuplicateFix(dup.name, dup.folder, newName, model.alias, references);
      const newPath = path.join(path.dirname(dup.filePath), `${newName}.yml`);
      const choice = await vscode.window.showInformationMessage(
        `Rename the duplicate "${dup.name}" to "${newName}"?`,
        { modal: true, detail: describeDuplicateFix(plan, libPath(dup.filePath), libPath(newPath)) },
        'Rename',
      );
      if (choice !== 'Rename') return;

      const edit = new vscode.WorkspaceEdit();
      const yamlText = tableLibraryService.serializeTableAt({ ...model, name: newName, alias: plan.alias }, dup.filePath);
      edit.createFile(vscode.Uri.file(newPath), { overwrite: false, contents: Buffer.from(yamlText, 'utf-8') });
      edit.deleteFile(vscode.Uri.file(dup.filePath), { ignoreIfNotExists: true });
      const domainDocs: vscode.TextDocument[] = [];
      for (const ref of plan.repoint) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ref.filePath));
        const text = doc.getText();
        const raw = JSON.parse(text) as Record<string, unknown>;
        // A v6 diagram (#182) is repointed under its v5 keys and written back in v6.
        const v6 = detectSubjectAreaFormat(raw) === 'v6';
        const parsed = v6 ? normaliseSubjectAreaDocument(raw) : raw;
        if (!repointSubjectAreaTable(parsed, dup.name, newName)) continue;
        const fileObject = v6 ? toTableNamingDocument(parsed) : parsed;
        const next = rewriteJsonScalars(text, fileObject) ?? JSON.stringify(fileObject, null, 2) + '\n';
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), next);
        domainDocs.push(doc);
      }
      if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showErrorMessage('VS Code rejected the rename; nothing was changed.');
        return;
      }
      // Domain edits land in memory; a canvas never sits dirty, so save them.
      // Every path is recorded as our own write, and the refreshes the
      // watchers would have driven are issued directly below.
      // Re-fetched by URI and checked (#126): a handle opened before the edit
      // may have been disposed, and a save can fail without throwing.
      const unsaved: string[] = [];
      const saveFailures = new Set<SaveFailure>();
      for (const doc of domainDocs) {
        if (await saveDocumentByUri(doc.uri, (reason) => saveFailures.add(reason))) {
          ownWrites.recordWrite(doc.uri.fsPath);
        } else {
          unsaved.push(path.relative(workspaceRoot, doc.uri.fsPath).split(path.sep).join('/'));
        }
        treeProvider.invalidateSubjectArea(doc.uri.fsPath);
      }
      if (unsaved.length > 0) {
        for (const code of saveFailureCodes(saveFailures, { rename: true })) telemetry.error(code);
        void vscode.window.showErrorMessage(
          `Could not save ${unsaved.join(', ')} — the rename is open in the editor but not on disk. Save the file from its tab, or revert it.`,
        );
      }
      ownWrites.recordWrite(newPath);
      ownWrites.recordDelete(dup.filePath);
      tableLibraryService.invalidateCache();
      tableLibraryProvider.refresh();
      treeProvider.refresh();
      selectorsService.scheduleRegenerate();
      await editorProvider.refreshAllOpenSubjectAreas();
      void vscode.window.showInformationMessage(
        `${libPath(newPath)} is now its own table, "${newName}" (warehouse table: ${plan.alias}).` +
        (domainDocs.length ? ` Repointed ${domainDocs.length} subject area${domainDocs.length === 1 ? '' : 's'}.` : ''),
      );
    }),
    // Store every domain file's relationships once, in their from-models'
    // library files (#126). The opt-in for a project that keeps them per domain.
    vscode.commands.registerCommand('erdStudio.moveRelationshipsToLibrary', () =>
      moveRelationshipsToLibrary({
        workspaceRoot,
        semanticDir,
        subjectAreaService,
        tableLibraryService,
        loadDbtKeyIndex: async () => dbtKeyIndexOf(
          await ymlParserService.loadYmlData(workspaceRoot, undefined),
          await manifestService.loadManifest(workspaceRoot).catch(() => undefined),
        ),
        onWritten: async (domainPaths) => {
          for (const domainPath of domainPaths) treeProvider.invalidateSubjectArea(domainPath);
          tableLibraryProvider.refresh();
          treeProvider.refresh();
          selectorsService.scheduleRegenerate();
          await editorProvider.refreshAllOpenSubjectAreas();
        },
      })),
    vscode.commands.registerCommand('erdStudio.revealLogicalModel', (node: TableLibraryNode | undefined) => {
      if (!node || node.type !== 'model') {
        void vscode.window.showErrorMessage('Reveal in Explorer: No table selected. Right-click a table in the Table Library.');
        return;
      }
      void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(node.filePath));
    }),
    vscode.commands.registerCommand('erdStudio.openDomain', async (filePath?: string, stage?: Stage) => {
      // From the palette or the status bar there is no file: ask which.
      if (typeof filePath !== 'string' || !filePath) {
        await openCanvas();
        return;
      }
      const fileUri = vscode.Uri.file(filePath);
      // A preview tab, like a single click in the Explorer (#167): browsing
      // diagrams reuses one tab until an edit pins it. Without the option
      // `openWith` pins every tab. VS Code still pins it when the user has
      // `workbench.editor.enablePreview` off.
      await vscode.commands.executeCommand(
        'vscode.openWith',
        fileUri,
        SUBJECT_AREA_EDITOR_VIEW_TYPE,
        { preview: true },
      );
      if (stage === 'physical') {
        editorProvider.switchStageForUri(fileUri, 'physical');
      }
    }),
    // Export a domain's logical design as Mermaid or DBML. The argument is
    // the canvas's document Uri, the domain tree's node, or nothing (the
    // focused canvas, else the domain picker). Writes no ERD Studio file.
    vscode.commands.registerCommand(EXPORT_DIAGRAM_COMMAND, (arg?: unknown) =>
      exportDiagramCommand({
        exportDomain: async (domainPath, format) => {
          // dbt's key evidence, as the canvas reads the domain, so a link
          // stored twice is exported from the copy the canvas draws.
          const dbtKeyIndex = await Promise.resolve()
            .then(async () => dbtKeyIndexOf(
              await ymlParserService.loadYmlData(workspaceRoot, undefined),
              await manifestService.loadManifest(workspaceRoot).catch(() => undefined),
            ))
            .catch(() => undefined);
          return exportSubjectAreaFile(subjectAreaService, domainPath, format, { layers: layerService, ...(dbtKeyIndex ? { dbtKeyIndex } : {}) });
        },
        activeDomainPath: () => editorProvider.activeSubjectAreaPath(),
        hasDiagrams: () => subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir).length > 0,
        pickDomain: async () => pickDomainFile(subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir), 'Export which diagram?'),
        defaultSaveFolder: workspaceRoot,
        projectRoot: workspaceRoot,
      }, arg)),
    // Export every domain's logical design into a folder the user picks, one
    // file each (plus its .dbdiagram for DBML for dbdiagram.io).
    vscode.commands.registerCommand(EXPORT_ALL_DIAGRAMS_COMMAND, () =>
      exportAllDiagramsCommand({
        listSubjectAreas: () => subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir),
        exportAll: async (domainPaths, format) => {
          // dbt's key evidence once for the whole run, as Export Diagram reads it.
          const dbtKeyIndex = await Promise.resolve()
            .then(async () => dbtKeyIndexOf(
              await ymlParserService.loadYmlData(workspaceRoot, undefined),
              await manifestService.loadManifest(workspaceRoot).catch(() => undefined),
            ))
            .catch(() => undefined);
          return exportSubjectAreaFiles(subjectAreaService, domainPaths, format, { layers: layerService, ...(dbtKeyIndex ? { dbtKeyIndex } : {}) });
        },
        defaultFolder: workspaceRoot,
        projectRoot: workspaceRoot,
      })),
    vscode.commands.registerCommand(DRAW_FROM_DBT_COMMAND, async () => {
      if (!hasDbt) {
        void vscode.window.showInformationMessage(DRAW_FROM_DBT_NEEDS_DBT_MESSAGE);
        return;
      }
      const existingDomains = () => subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir);
      await drawFromDbt({
        workspaceRoot,
        semanticDir,
        modelPaths: dbtConfig.modelPaths,
        layerService,
        subjectAreaService,
        tableLibraryService,
        loadDbt: async () => {
          const ymlData = await ymlParserService.loadYmlData(workspaceRoot);
          const manifest = await manifestService.loadManifest(workspaceRoot);
          // The catalog only fills column types; undefined when there is none.
          const catalog = await catalogService.loadCatalog(workspaceRoot);
          return { ymlData, manifest: manifestService.isMissing ? undefined : manifest, catalog };
        },
        validateDomainName: (value, layer) => validateSubjectAreaSlug(value, layer, existingDomains()),
        onWritten: refreshAfterNewSubjectArea,
      });
    }),
    // Import a DBML file (ERD Studio's own rich export, dbdiagram.io's, any
    // tool's) as a new subject area. Needs no dbt artifacts.
    // With a file URI (the canvas's "Import these tables…" banner over a
    // single-file DBML in a layer folder, §2.5) that file is imported;
    // without one the user picks a file.
    vscode.commands.registerCommand(IMPORT_DBML_COMMAND, async (file?: unknown) => {
      const existingDomains = () => subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir);
      const uri = file as { scheme?: unknown; fsPath?: unknown } | undefined;
      const filePath = uri && typeof uri === 'object' && uri.scheme === 'file' && typeof uri.fsPath === 'string' ? uri.fsPath : undefined;
      await importDbml({
        workspaceRoot,
        semanticDir,
        layerService,
        subjectAreaService,
        tableLibraryService,
        validateDomainName: (value, layer) => validateSubjectAreaSlug(value, layer, existingDomains()),
        onWritten: refreshAfterNewSubjectArea,
      }, filePath !== undefined ? { filePath } : undefined);
    }),
    // A ready-made coffee-shop star schema, through the same Import DBML flow
    // (name, dry run, Import). Works in any folder; an empty window gets the
    // fallback "Open a folder first".
    vscode.commands.registerCommand(OPEN_EXAMPLE_DIAGRAM_COMMAND, async () => {
      const existingDomains = () => subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir);
      await openExampleDiagram({
        workspaceRoot,
        semanticDir,
        layerService,
        subjectAreaService,
        tableLibraryService,
        validateDomainName: (value, layer) => validateSubjectAreaSlug(value, layer, existingDomains()),
        onWritten: refreshAfterNewSubjectArea,
      });
    }),
    vscode.commands.registerCommand(
      'erdStudio.createDomain',
      async (layerArg?: Layer) => {
        // Step 1: Determine layer
        let layer: Layer | undefined = layerArg;
        if (!layer) {
          const creatableLayers = layerService.getCreatableLayers();
          if (creatableLayers.length === 0) {
            void vscode.window.showErrorMessage('No layers configured for subject area creation. Add layers first.');
            return;
          }
          const layerItems = creatableLayers.map(l => ({ label: l.label, value: l.id }));
          const layerChoice = await vscode.window.showQuickPick(layerItems, {
            placeHolder: 'Select layer for the new subject area',
            ignoreFocusOut: true,
          });
          if (!layerChoice) { return; }
          layer = layerChoice.value;
        }

        // Step 2: Get domain name
        const existingDomains = subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir);
        const domainSlug = await vscode.window.showInputBox({
          prompt: 'Enter subject area name (slug format)',
          placeHolder: 'e.g. customer-360, sales-analytics, orders',
          ignoreFocusOut: true,
          validateInput: (value: string) =>
            validateSubjectAreaSlug(value, layer, existingDomains),
        });
        if (!domainSlug) { return; }
        const slug = domainSlug.trim();

        // Step 3: Get description
        const description = await vscode.window.showInputBox({
          prompt: 'Enter subject area description (optional)',
          placeHolder: 'e.g. Customer 360 view with orders and interactions',
          ignoreFocusOut: true,
        });
        if (description === undefined) { return; }

        // Step 4: Get model folder filter (try yml source files first, fall back to manifest)
        let modelFolder: string | undefined;
        try {
          await ymlParserService.loadYmlData(workspaceRoot);
          let availableFolders = ymlParserService.getModelFolders(workspaceRoot);
          if (availableFolders.length === 0) {
            await manifestService.loadManifest(workspaceRoot);
            availableFolders = manifestService.getModelFolders();
          }
          if (availableFolders.length > 0) {
            const folderItems: Array<{ label: string; value: string | undefined }> = [
              { label: '$(folder) Any folder (no filter)', value: undefined },
              ...availableFolders.map((folder) => ({ label: `$(folder) ${folder}`, value: folder })),
            ];
            const folderChoice = await vscode.window.showQuickPick(folderItems, {
              placeHolder: 'Filter dbt models by folder (optional)',
              ignoreFocusOut: true,
            });
            if (folderChoice === undefined) { return; }
            modelFolder = folderChoice.value;
          }
        } catch {
          console.warn('[createDomain] Failed to load manifest for folder detection, skipping folder picker');
        }

        // Step 5: Create unified v3 domain file
        const layerDir = path.join(workspaceRoot, semanticDir, layer);
        const filePath = path.join(layerDir, `${slug}.json`);

        // A folder with no ERD data yet (a plain folder, or a dbt project
        // never set up): New Diagram is the explicit action that makes the
        // ERD folder, with the default layers.json first, as Draw from dbt and
        // Import DBML do. Removed again if the diagram cannot be written.
        const createdSemanticDir = !fs.existsSync(fullSemanticDirPath);
        const undoSemanticDir = (): void => {
          if (!createdSemanticDir) { return; }
          try { fs.rmSync(fullSemanticDirPath, { recursive: true, force: true }); } catch { /* leave it */ }
          layerService.invalidateCache();
        };
        try {
          if (createdSemanticDir) {
            await layerService.saveConfig(layerService.getAllLayers());
            layerService.invalidateCache();
          }
          if (!fs.existsSync(layerDir)) {
            fs.mkdirSync(layerDir, { recursive: true });
          }
        } catch (err) {
          undoSemanticDir();
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to create directory: ${msg}`);
          return;
        }

        const emptyStage: StageData = { models: [], relationships: [] };
        const domainData: UnifiedSubjectArea = {
          schemaVersion: WRITTEN_SCHEMA_VERSION,
          domain: slug,
          layer,
          description: description.trim(),
          ...(modelFolder ? { modelFolder } : {}),
          logical: { ...emptyStage },
          viewConfig: {},
        };

        try {
          subjectAreasCreatedHere.add(filePath);
          // In the naming the project writes (#182): v6 for a new or migrated project.
          const fileData = tableLibraryService.writesTableNaming()
            ? toTableNamingDocument(domainData as unknown as Record<string, unknown>)
            : domainData;
          fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
          telemetry.feature('domainCreated');
          // A blank start in a folder without dbt (logical-only mode).
          if (!hasDbt) { telemetry.feature('blankDiagram'); }
        } catch (err) {
          subjectAreasCreatedHere.delete(filePath);
          if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
            void vscode.window.showErrorMessage(`Subject area "${slug}" already exists in the ${layer} layer`);
            return;
          }
          undoSemanticDir();
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to create subject area file: ${msg}`);
          return;
        }

        // Step 6: Refresh tree, regenerate selectors.yml, and auto-open domain.
        // The semantic dir may have just been created — reveal the title buttons.
        if (createdSemanticDir) {
          layerDecorationProvider.refresh();
          decorationProvider.refresh();
        }
        refreshContextKeys();
        treeProvider.refresh();
        selectorsService.scheduleRegenerate();
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(filePath),
          SUBJECT_AREA_EDITOR_VIEW_TYPE,
        );
      },
    ),
    vscode.commands.registerCommand(
      'erdStudio.deleteDomain',
      async (element?: TreeElement) => {
        if (!element || element.type !== 'domain') {
          void vscode.window.showErrorMessage('Delete Subject Area: No subject area selected. Right-click a subject area in the tree view.');
          return;
        }

        const domainName = element.summary.domain;
        const filePath = element.summary.filePath;
        const fileUri = vscode.Uri.file(filePath);

        const shouldProceed = await handleUnsavedChanges(fileUri, domainName, 'deleting');
        if (!shouldProceed) { return; }

        const confirm = await vscode.window.showWarningMessage(
          `Are you sure you want to delete subject area "${domainName}"?`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') { return; }

        // Close any open editors
        const matchingTabs = findMatchingTabs(fileUri);
        if (matchingTabs.length > 0) {
          await vscode.window.tabGroups.close(matchingTabs, true);
        }

        // Delete the unified domain file. Record it as an own delete so the
        // watcher does not show the "Domain file deleted" toast — selectors
        // regeneration is already scheduled below.
        try {
          await vscode.workspace.fs.delete(fileUri);
          ownWrites.recordDelete(filePath);
          treeProvider.invalidateSubjectArea(filePath);
          // A DBML diagram's layout file goes with it (§5.7).
          const layoutPath = filePath.endsWith('.dbml') ? layoutFilePathOf(filePath) : undefined;
          if (layoutPath !== undefined && fs.existsSync(layoutPath)) {
            await vscode.workspace.fs.delete(vscode.Uri.file(layoutPath));
            ownWrites.recordDelete(layoutPath);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to delete subject area: ${msg}`);
        }

        treeProvider.refresh();
        refreshDiagramsStatus();
        selectorsService.scheduleRegenerate();
      },
    ),
    vscode.commands.registerCommand(
      'erdStudio.renameDomain',
      async (element?: TreeElement) => {
        if (!element || element.type !== 'domain') {
          void vscode.window.showErrorMessage('Rename Subject Area: No subject area selected. Right-click a subject area in the tree view.');
          return;
        }

        const oldDomainName = element.summary.domain;
        const oldFilePath = element.summary.filePath;
        const oldFileUri = vscode.Uri.file(oldFilePath);
        const layer = element.summary.layer;
        if (oldFilePath.endsWith('.dbml')) {
          void vscode.window.showInformationMessage('Rename Subject Area: renaming a DBML diagram is not available yet in this build of ERD Studio.');
          return;
        }

        const shouldProceed = await handleUnsavedChanges(oldFileUri, oldDomainName, 'renaming');
        if (!shouldProceed) { return; }

        const existingDomains = subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir);
        const newDomainSlug = await vscode.window.showInputBox({
          prompt: 'Enter new subject area name',
          value: oldDomainName,
          ignoreFocusOut: true,
          validateInput: (value: string) =>
            validateSubjectAreaSlug(value, layer, existingDomains, oldDomainName),
        });
        if (!newDomainSlug) { return; }
        const newSlug = newDomainSlug.trim();
        if (newSlug === oldDomainName) { return; }

        // Read and update domain name in the unified file.
        // Validate via SubjectAreaService, but rewrite the RAW document so v5 model
        // name references and unknown keys are preserved — re-serialising the
        // resolved UnifiedSubjectArea would inline model bodies into a v5 file.
        let renamedContent: string;
        try {
          subjectAreaService.getSubjectArea(oldFilePath);
          renamedContent = renameSubjectAreaInRaw(fs.readFileSync(oldFilePath, 'utf-8'), newSlug);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to read subject area file: ${msg}`);
          return;
        }

        // Close old editor tabs before applying the edit (file will be deleted)
        const oldTabs = findMatchingTabs(oldFileUri);
        if (oldTabs.length > 0) { await vscode.window.tabGroups.close(oldTabs, true); }

        const newFilePath = path.join(workspaceRoot, semanticDir, layer, `${newSlug}.json`);
        const newFileUri = vscode.Uri.file(newFilePath);

        const edit = new vscode.WorkspaceEdit();
        subjectAreasCreatedHere.add(newFilePath);
        edit.createFile(newFileUri, { overwrite: false, ignoreIfExists: false });
        edit.insert(newFileUri, new vscode.Position(0, 0), renamedContent);
        edit.deleteFile(oldFileUri, { ignoreIfNotExists: false });

        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
          void vscode.window.showErrorMessage(`Failed to rename subject area "${oldDomainName}" to "${newSlug}"`);
          return;
        }

        // Auto-open renamed domain
        selectorsService.scheduleRegenerate();
        await vscode.commands.executeCommand('vscode.openWith', newFileUri, SUBJECT_AREA_EDITOR_VIEW_TYPE);
      },
    ),
    vscode.commands.registerCommand('erdStudio.refreshManifest', async () => {
      if (!hasDbt) {
        void vscode.window.showInformationMessage(NEEDS_DBT_PROJECT_MESSAGE);
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Refreshing dbt manifest...',
          cancellable: false,
        },
        async () => {
          manifestService.invalidate();
          ymlParserService.invalidate();
          // The catalog caches its "there isn't one" answer too, so a catalog
          // generated after activation is only ever picked up by an invalidate.
          catalogService.invalidate();
          await manifestService.loadManifest(workspaceRoot);
          await ymlParserService.loadYmlData(workspaceRoot);
          await editorProvider.refreshAllOpenSubjectAreas();
          if (manifestService.isMissing) {
            telemetry.featureOnce('manifestMissingRefresh');
            void vscode.window.showWarningMessage(
              `No dbt manifest yet (${manifestDisplayPath(workspaceRoot, dbtConfig)}) — dbt hasn't been run in this project. ` +
                'Your dbt models and relationships still come from your schema .yml files. ' +
                'Run dbt parse to read columns and tests (needs a working dbt profile), or dbt docs generate for warehouse types.',
              RUN_DBT_PARSE_ACTION,
            ).then(pick => { if (pick === RUN_DBT_PARSE_ACTION) { void runDbtParse(workspaceRoot); } });
          } else if (manifestService.isStale) {
            void vscode.window.showWarningMessage(
              'dbt manifest could not be parsed (it may be mid-write) — graphs show the last good data. Try again shortly.',
            );
          } else {
            void vscode.window.showInformationMessage('Manifest refreshed. Graphs updated with latest dbt model data.');
          }
        },
      );
    }),
    // Regenerate the root selectors.yml from current domain files.
    // Run a domain refresh in dbt with: dbt build --selector domain_{layer}_{domain}
    vscode.commands.registerCommand('erdStudio.syncDomainTags', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Regenerating dbt selectors.yml...',
          cancellable: false,
        },
        async () => {
          try {
            const result = selectorsService.regenerate();
            if (result.status === 'written') {
              const relPath = path.relative(workspaceRoot, result.filePath);
              void vscode.window.showInformationMessage(
                `Wrote ${result.selectorsWritten} selector(s) covering ${result.modelsReferenced} dbt model reference(s) to ${relPath}.`,
              );
            } else if (result.status === 'noop') {
              void vscode.window.showInformationMessage(
                'No subject areas with tables found — selectors.yml was not created.',
              );
            } else if (result.status === 'not-dbt-project') {
              void vscode.window.showInformationMessage(
                'This folder is not a dbt project, so there is no selectors.yml to generate.',
              );
            }
            // For 'skipped': the onSkipped hook has already shown the
            // out-of-sync notification + status bar. No success toast.
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Failed to regenerate selectors.yml: ${msg}`);
          }
        },
      );
    }),
    // One-shot cleanup: strip legacy `domain:*` tags from every model YAML
    // left behind by the old SchemaTagService. Safe to run repeatedly.
    vscode.commands.registerCommand('erdStudio.stripLegacyDomainTags', async () => {
      // It rewrites dbt schema files under models/: never in a plain folder.
      if (!hasDbt) {
        void vscode.window.showInformationMessage(NEEDS_DBT_PROJECT_MESSAGE);
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        'This will scan every .yml file under your dbt model-paths (default `models/`) and remove any `domain:*` tag from `config.tags` or top-level `tags` on each dbt model. ' +
          'Review and commit the changes as a single PR. Continue?',
        { modal: true },
        'Strip Tags',
      );
      if (confirm !== 'Strip Tags') { return; }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Stripping legacy domain tags...',
          cancellable: false,
        },
        async () => {
          const result = legacyTagCleanupService.stripAll();

          if (result.errors.length > 0) {
            for (const err of result.errors) {
              console.warn(`[LegacyTagCleanup] ${err}`);
            }
          }

          if (result.tagsRemoved === 0) {
            void vscode.window.showInformationMessage(
              `No legacy domain tags found. Scanned ${result.filesScanned} YAML file(s).`,
            );
            return;
          }

          const choice = await vscode.window.showInformationMessage(
            `Removed ${result.tagsRemoved} tag(s) from ${result.filesModified} file(s). Scanned ${result.filesScanned}. Review the diff before committing.` +
              (result.errors.length > 0 ? ` (${result.errors.length} file(s) skipped — see Output.)` : ''),
            'Show Modified Files',
          );
          if (choice === 'Show Modified Files') {
            const items = result.modifiedPaths.map((p) => ({
              label: path.relative(workspaceRoot, p),
              description: '',
              fullPath: p,
            }));
            const picked = await vscode.window.showQuickPick(items, {
              placeHolder: 'Open a modified file to review',
            });
            if (picked) {
              await vscode.window.showTextDocument(vscode.Uri.file(picked.fullPath), { preview: true });
            }
          }
        },
      );
    }),
    // Migrate v4 domains to v5 central model store
    vscode.commands.registerCommand('erdStudio.migrateToV5', async () => {
      if (!migrationService.needsMigration()) {
        void vscode.window.showInformationMessage('All subject area files already use the v5 central Table Library format.');
        return;
      }
      // v4 → v5, then on to the new file naming (#182), so nobody goes through two prompts.
      if (await migrateToV5()) await migrateNaming();
    }),
    vscode.commands.registerCommand('erdStudio.migrateToTableNaming', async () => { await migrateNaming(); }),

    // F408: Set up semantic directory for new projects
    vscode.commands.registerCommand(
      'erdStudio.setupSemanticDirectory',
      async () => {
        const fullSemanticDir = path.join(workspaceRoot, semanticDir);
        const defaultLayers = layerService.getAllLayers();

        try {
          if (!fs.existsSync(fullSemanticDir)) {
            fs.mkdirSync(fullSemanticDir, { recursive: true });
          }

          // Create layer directories
          for (const layer of defaultLayers) {
            const layerDir = path.join(fullSemanticDir, layer.id);
            if (!fs.existsSync(layerDir)) {
              fs.mkdirSync(layerDir, { recursive: true });
            }
          }

          // A new project writes the v6 naming (#182): its tables/ library is
          // made with the first table (an empty one would read as a layer
          // folder). Only a project already on the v5 naming gets logical-models/.
          const logicalModelsDir = path.join(fullSemanticDir, 'logical-models');
          if (!tableLibraryService.writesTableNaming() && !fs.existsSync(logicalModelsDir)) {
            fs.mkdirSync(logicalModelsDir, { recursive: true });
          }

          await layerService.saveConfig(defaultLayers);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to create the ERD Studio directory structure: ${msg}`);
          return;
        }

        // Update context keys so view/title menus appear
        refreshContextKeys();
        treeProvider.refresh();
        await new Promise(resolve => setTimeout(resolve, 100));
        void vscode.window.showInformationMessage('ERD Studio directory created! Now create your first subject area.');
        await vscode.commands.executeCommand('erdStudio.createDomain');
      },
    ),
    // -------------------------------------------------------------------------
    // Layer Management Commands (unchanged)
    // -------------------------------------------------------------------------
    vscode.commands.registerCommand(
      'erdStudio.addLayer',
      async () => {
        // Step 1: Layer ID
        const id = await vscode.window.showInputBox({
          prompt: 'Layer name (lowercase, e.g., platinum)',
          placeHolder: 'e.g., platinum, staging, raw',
          ignoreFocusOut: true,
          validateInput: (value: string) => {
            if (!value || !value.trim()) { return 'Layer name is required'; }
            if (!/^[a-z][a-z0-9_-]*$/.test(value.trim())) { return 'Must start with lowercase letter, contain only lowercase letters, numbers, hyphens, underscores'; }
            if (layerService.hasLayer(value.trim())) { return `Layer "${value.trim()}" already exists`; }
            // Reserved for the table library's new folder (#162); a project that already has the layer keeps it.
            if (value.trim() === TABLES_DIR) { return `"${TABLES_DIR}" is reserved for the Table Library's folder; pick another name`; }
            return undefined;
          },
        });
        if (!id) return;
        const layerId = id.trim();

        // Step 2: Color
        const colorPick = await vscode.window.showQuickPick(LAYER_COLOR_OPTIONS, {
          placeHolder: `Select color for "${layerId}" layer`,
          ignoreFocusOut: true,
        });
        if (!colorPick) return;

        let color = colorPick.value;
        if (color === 'custom') {
          const customColor = await vscode.window.showInputBox({
            prompt: 'Enter hex color (e.g., #ff5733)',
            placeHolder: '#ff5733',
            ignoreFocusOut: true,
            validateInput: (value: string) => {
              if (!/^#[0-9a-fA-F]{6}$/.test(value)) { return 'Invalid hex color format (e.g., #ff5733)'; }
              return undefined;
            },
          });
          if (!customColor) return;
          color = customColor;
        }

        // Auto-generate label and abbreviation from ID
        const label = layerId.charAt(0).toUpperCase() + layerId.slice(1);
        const abbreviation = layerId.slice(0, 3).toUpperCase();

        try {
          await layerService.addLayer({
            id: layerId,
            label,
            abbreviation,
            color,
            creatable: true,
          });

          // Create layer directory
          const layerDir = path.join(workspaceRoot, semanticDir, layerId);
          if (!fs.existsSync(layerDir)) {
            fs.mkdirSync(layerDir, { recursive: true });
          }

          refreshContextKeys();
          treeProvider.refresh();
          layerDecorationProvider.refresh();
          decorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer "${label}" added. Use Edit Layer to customize display name or abbreviation.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to add layer: ${msg}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'erdStudio.editLayer',
      async (element?: TreeElement) => {
        let layerId: string | undefined;
        if (element && element.type === 'layer') {
          layerId = element.layer;
        } else {
          const layers = layerService.getAllLayers();
          const layerPick = await vscode.window.showQuickPick(
            layers.map(l => ({ label: l.label, value: l.id })),
            { placeHolder: 'Select layer to edit' },
          );
          if (!layerPick) return;
          layerId = layerPick.value;
        }

        const layer = layerService.getLayer(layerId);
        if (!layer) {
          void vscode.window.showErrorMessage(`Layer "${layerId}" not found`);
          return;
        }

        const editOptions = [
          { label: '$(edit) Rename Layer', value: 'rename' },
          { label: '$(symbol-color) Change Color', value: 'color' },
          { label: '$(tag) Change Abbreviation', value: 'abbreviation' },
        ];
        const editChoice = await vscode.window.showQuickPick(editOptions, {
          placeHolder: `Edit layer: ${layer.label}`,
        });
        if (!editChoice) return;

        try {
          switch (editChoice.value) {
            case 'rename': {
              const newLabel = await vscode.window.showInputBox({ prompt: 'New layer display name', value: layer.label, ignoreFocusOut: true });
              if (newLabel === undefined || newLabel.trim() === layer.label) return;
              await layerService.updateLayer(layerId, { label: newLabel.trim() });
              break;
            }
            case 'color': {
              const colorPick = await vscode.window.showQuickPick(LAYER_COLOR_OPTIONS, { placeHolder: 'Select new color' });
              if (!colorPick) return;
              let color = colorPick.value;
              if (color === 'custom') {
                const customColor = await vscode.window.showInputBox({
                  prompt: 'Enter hex color (e.g., #ff5733)', value: layer.color, ignoreFocusOut: true,
                  validateInput: (value: string) => { if (!/^#[0-9a-fA-F]{6}$/.test(value)) { return 'Invalid hex color format'; } return undefined; },
                });
                if (!customColor) return;
                color = customColor;
              }
              await layerService.updateLayerColor(layerId, color);
              break;
            }
            case 'abbreviation': {
              const newAbbrev = await vscode.window.showInputBox({
                prompt: 'New abbreviation (3-4 characters)', value: layer.abbreviation, ignoreFocusOut: true,
                validateInput: (value: string) => {
                  if (!value || value.trim().length === 0) { return 'Abbreviation is required'; }
                  if (value.trim().length > 4) { return 'Abbreviation should be 3-4 characters'; }
                  return undefined;
                },
              });
              if (newAbbrev === undefined) return;
              await layerService.updateLayer(layerId, { abbreviation: newAbbrev.trim().toUpperCase() });
              break;
            }
          }

          treeProvider.refresh();
          layerDecorationProvider.refresh();
          decorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer "${layer.label}" updated.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to update layer: ${msg}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'erdStudio.removeLayer',
      async (element?: TreeElement) => {
        let layerId: string | undefined;
        if (element && element.type === 'layer') {
          layerId = element.layer;
        } else {
          const layers = layerService.getAllLayers();
          const layerPick = await vscode.window.showQuickPick(
            layers.map(l => ({ label: l.label, value: l.id })),
            { placeHolder: 'Select layer to remove' },
          );
          if (!layerPick) return;
          layerId = layerPick.value;
        }

        const layer = layerService.getLayer(layerId);
        if (!layer) {
          void vscode.window.showErrorMessage(`Layer "${layerId}" not found`);
          return;
        }

        const domains = subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir);
        const layerDomains = domains.filter(d => d.layer === layerId);
        if (layerDomains.length > 0) {
          void vscode.window.showErrorMessage(
            `Cannot remove layer "${layer.label}" — it contains ${layerDomains.length} subject area(s). Delete or move subject areas first.`,
          );
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Remove layer "${layer.label}"? This will delete the directories.`,
          { modal: true },
          'Remove',
        );
        if (confirm !== 'Remove') return;

        try {
          await layerService.removeLayer(layerId);

          // Remove layer directory
          const layerDir = path.join(workspaceRoot, semanticDir, layerId);
          if (fs.existsSync(layerDir)) {
            await vscode.workspace.fs.delete(vscode.Uri.file(layerDir), { recursive: true });
          }

          treeProvider.refresh();
          layerDecorationProvider.refresh();
          decorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer "${layer.label}" removed.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to remove layer: ${msg}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'erdStudio.initializeLayerConfig',
      async () => {
        // saveConfig refuses to overwrite an unreadable layers.json (H18) —
        // surface that as a message rather than an unhandled command failure.
        try {
          const detected = layerService.detectLayersFromFilesystem();
          if (detected.length === 0) {
            const defaultLayers = layerService.getAllLayers();
            await layerService.saveConfig(defaultLayers);
            refreshContextKeys();
            void vscode.window.showInformationMessage('Layer configuration saved with default layers (Silver, Gold).');
            return;
          }

          const layerNames = detected.map(l => l.label).join(', ');
          const choice = await vscode.window.showInformationMessage(
            `Detected layers: ${layerNames}. Save this configuration?`,
            'Save', 'Customize', 'Cancel',
          );

          if (choice === 'Save') {
            await layerService.saveConfig(detected);
            layerService.invalidateCache();
            refreshContextKeys();
            treeProvider.refresh();
            layerDecorationProvider.refresh();
            decorationProvider.refresh();
            void vscode.window.showInformationMessage(`Layer configuration saved to ${semanticDir}/layers.json`);
          } else if (choice === 'Customize') {
            await layerService.saveConfig(detected);
            refreshContextKeys();
            const uri = vscode.Uri.file(layerService.getConfigPath());
            await vscode.commands.executeCommand('vscode.open', uri);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to save layer configuration: ${msg}`);
        }
      },
    ),
    // -------------------------------------------------------------------------
    // AI Coding Harness Installation
    // -------------------------------------------------------------------------
    vscode.commands.registerCommand(
      'erdStudio.installCodingHarness',
      async () => {
        const harnessService = new HarnessService(semanticDir);
        const existing = harnessService.detectExisting(workspaceRoot);
        const staleTargets = harnessService.detectStale(workspaceRoot);
        const staleIds = new Set(staleTargets.map(t => t.id));

        // Build QuickPick items with existing/outdated status
        const items = HARNESS_TARGETS.map(target => {
          const exists = existing.get(target.id);
          const isStale = staleIds.has(target.id);
          let description = target.description;
          if (exists && isStale) {
            description = '$(warning) outdated — update available';
          } else if (exists) {
            // A file without our version marker was not written by ERD Studio.
            let managed = false;
            try {
              managed = extractHarnessVersion(
                fs.readFileSync(path.join(workspaceRoot, target.relativePath), 'utf-8'),
              ) !== null;
            } catch {
              // unreadable — treat as unmanaged
            }
            description = managed
              ? '$(check) installed (v' + HARNESS_VERSION + ')'
              : target.id === 'codex'
                ? '$(info) existing AGENTS.md — ERD Studio section will be appended'
                : '$(warning) existing file not managed by ERD Studio — will be replaced';
          }
          return {
            label: target.label,
            description,
            picked: isStale, // Pre-select outdated targets
            target,
            exists,
          };
        });

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select AI coding harnesses to install ERD Studio schema into',
          canPickMany: true,
          ignoreFocusOut: true,
        });

        if (!selected || selected.length === 0) { return; }

        // Always overwrite — harness files are managed by the extension
        const results = selected.map(s =>
          harnessService.install(workspaceRoot, s.target, true),
        );
        recordHarnessInstalls(results);

        const succeeded = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        if (failed.length > 0) {
          const errors = failed.map(r => `${r.target.id}: ${r.error}`).join('; ');
          void vscode.window.showErrorMessage(
            `Harness install: ${succeeded.length} installed, ${failed.length} failed. Errors: ${errors}`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `AI coding harness: ${succeeded.length} installed.`,
          );
        }
      },
    ),
  );

  // One poll for the issues this user filed. No-ops without a silent GitHub
  // session, with `feedback.trackReports` off, or when the cache is still
  // fresh, so it costs nothing on a normal activation.
  void trackingService.refresh();

  // -------------------------------------------------------------------------
  // Welcome panel + Set Up My AI Helper
  // -------------------------------------------------------------------------
  const cliLauncher = new CliLauncherService();
  const launcherOptions: CliLauncherOptions = {
    homeDir: os.homedir(),
    extensionVersion: currentVersion,
    execPath: process.execPath,
    cliSourcePath: path.join(context.extensionUri.fsPath, 'dist', 'cli.js'),
  };
  const firstWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  // The workspace folder that holds the dbt project — in a multi-root
  // workspace not necessarily the first one (#82). Used to describe where the
  // project sits and to tell Copilot's "nested project" hint apart from a
  // project that is itself a root folder. The Claude command keeps the first
  // folder: that is where a new terminal starts, so it decides whether the
  // copied command needs a `cd`.
  const projectWorkspaceFolder =
    vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspaceRoot))?.uri.fsPath ?? firstWorkspaceFolder;
  const setupHarness = new HarnessService(semanticDir);

  const getGettingStartedStatus = async (): Promise<GettingStartedStatus> => {
    const status = setupHarness.harnessStatus(workspaceRoot);
    const harness = {
      claude: { schemaSkill: status.claude.schemaSkill, setupSkill: status.claude.setupSkill },
      agents: status.agents,
    };
    const cli = cliLauncher.status(launcherOptions);
    const assistants = detectAiAssistants();
    const relative = projectWorkspaceFolder ? path.relative(projectWorkspaceFolder, workspaceRoot) : '';
    return {
      hasProject: true,
      logicalOnly: !hasDbt,
      harness,
      cli,
      helper: deriveAiHelperState(harness, cli, assistants),
      claude: detectClaude().availability,
      assistants,
      domainCount: subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir).length,
      project: {
        name: path.basename(workspaceRoot),
        relativePath: relative && !relative.startsWith('..') && !path.isAbsolute(relative)
          ? relative.split(path.sep).join('/')
          : null,
      },
    };
  };
  const setupClipboardText = (assistant: Parameters<typeof promptFor>[0] = 'claude'): string =>
    promptFor(assistant, workspaceRoot, firstWorkspaceFolder, process.platform);

  const runSetup = async () => {
    const outcome = await runSetupAiHelper({
      root: workspaceRoot,
      harness: setupHarness,
      launcher: cliLauncher,
      launcherOptions,
      assistants: detectAiAssistants(),
      logicalOnly: !hasDbt,
      confirmReplace: async (unmanaged, targets) => {
        const REPLACE = 'Replace';
        const KEEP = 'Keep mine';
        const choice = await vscode.window.showWarningMessage(
          `${unmanaged.join(' and ')} ${unmanaged.length === 1 ? "exists and wasn't" : "exist and weren't"} ` +
            "written by ERD Studio. Replace with ERD Studio's version?",
          {
            modal: true,
            detail: `Keep mine leaves ${unmanaged.length === 1 ? 'that file' : 'those files'} exactly as ` +
              `${unmanaged.length === 1 ? 'it is' : 'they are'} and installs everything else ` +
              `(${keepMineInstalls(unmanaged, targets)}) plus the checking tool.`,
          },
          REPLACE,
          KEEP,
        );
        return choice === REPLACE ? 'replace' : choice === KEEP ? 'keep' : undefined;
      },
    });
    if (outcome.filesWritten.length > 0) { refreshContextKeys(); }
    return outcome;
  };

  gettingStartedDeps = {
    workspaceRoot,
    semanticDir,
    // The panel's logical-only page: New diagram / Import DBML, no dbt steps.
    logicalOnly: !hasDbt,
    runSetup,
    getStatus: getGettingStartedStatus,
    clipboardText: setupClipboardText,
    workspaceFolder: projectWorkspaceFolder,
    openCanvas,
    // One text line above the Welcome panel's cards ("12 dbt models · medallion
    // layout · manifest 2 days old"). Reads what the canvas already caches;
    // a missing manifest is fine and is reported as such, never an error.
    // None in a folder without dbt: there are no dbt models to summarise.
    getProjectSummary: !hasDbt ? undefined : async () => {
      const ymlData = await ymlParserService.loadYmlData(workspaceRoot);
      const loaded = await manifestService.loadManifest(workspaceRoot);
      const manifest = manifestService.isMissing ? undefined : loaded;
      if (manifestService.isMissing) { telemetry.featureOnce('manifestMissingWelcome'); }
      return computeProjectSummary({
        models: listDraftModels({ ymlData, manifest, projectRoot: workspaceRoot, modelPaths: dbtConfig.modelPaths }),
        manifest,
        manifestMtime: readManifestMtime(workspaceRoot, dbtConfig),
        now: Date.now(),
      });
    },
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('erdStudio.setupAiHelper', async () => {
      const outcome = await runSetup();
      await GettingStartedPanel.currentPanel?.postSetupResult(outcome);
      if (!outcome.ok) {
        if (outcome.message !== SETUP_CANCELLED_MESSAGE) {
          void vscode.window.showErrorMessage(`ERD Studio: ${outcome.message}`);
        }
        return;
      }
      // Offer an Open button for each assistant the editor can open, and one
      // Copy for the first detected assistant (Claude Code when none is).
      const assistants = detectAiAssistants();
      const OPEN_CLAUDE = 'Open Claude Code';
      const OPEN_COPILOT = 'Open Copilot Chat';
      const COPY = 'Copy prompt';
      const buttons = [
        ...(assistants.includes('claude') ? [OPEN_CLAUDE] : []),
        ...(assistants.includes('copilot') ? [OPEN_COPILOT] : []),
        COPY,
      ];
      const choice = await vscode.window.showInformationMessage(
        `${outcome.message} Guide not showing? Start your assistant from ${path.basename(workspaceRoot)}.`,
        ...buttons,
      );
      if (choice === OPEN_CLAUDE) {
        await openClaudeCode({ dbtRoot: workspaceRoot, clipboardText: setupClipboardText('claude') });
      } else if (choice === OPEN_COPILOT) {
        await openCopilotChat({ dbtRoot: workspaceRoot, workspaceFolder: projectWorkspaceFolder });
      } else if (choice === COPY) {
        await vscode.env.clipboard.writeText(setupClipboardText(assistants[0] ?? 'claude'));
      }
    }),
  );

  // First run (spec C.5, addendum P4). A fresh install opens the Get Started
  // walkthrough once per machine (the Welcome panel where the host has no
  // walkthrough command) and skips this run's harness QuickPick (the
  // walkthrough offers Draw from dbt and the one-click setup instead); an
  // upgrader gets one non-modal notice. The "shown" flag is written BEFORE the
  // walkthrough opens so a crash cannot loop.
  let suppressHarnessQuickPick = false;
  let firstRunNoticeShown = false;
  // A plain folder (no dbt_project.yml, no ERD folder yet) is where someone
  // merely clicked the ERD Studio icon: no notice, no QuickPick, no prompt —
  // the sidebar's welcome view is the whole offer there. Deferred flags stay
  // unset, so they come in a folder that has something to work on.
  const quietActivation = !hasDbt && !fs.existsSync(fullSemanticDirPath);
  {
    const pending = context.globalState.get<boolean>(GETTING_STARTED_PENDING_KEY) === true;
    const shown = context.globalState.get<boolean>(GETTING_STARTED_SHOWN_KEY) === true;
    if (pending && !shown && !gettingStartedAutoOpened) {
      gettingStartedAutoOpened = true;
      suppressHarnessQuickPick = true;
      await context.globalState.update(GETTING_STARTED_SHOWN_KEY, true);
      await context.globalState.update(GETTING_STARTED_PENDING_KEY, undefined);
      const deps = gettingStartedDeps;
      await openWalkthrough(() => GettingStartedPanel.createOrShow(context, deps));
    } else if (pending && shown) {
      // Another window got there first.
      await context.globalState.update(GETTING_STARTED_PENDING_KEY, undefined);
    } else if (!pending && !shown && !quietActivation) {
      await context.globalState.update(GETTING_STARTED_SHOWN_KEY, true);
      firstRunNoticeShown = true;
      // Without dbt the guided setup and the dbt video don't apply: the notice
      // offers the Welcome page's logical-only start instead.
      const OPEN = hasDbt ? 'Watch' : 'Open Welcome';
      void vscode.window.showInformationMessage(
        hasDbt
          ? 'ERD Studio: new short getting-started video and a guided setup for your AI assistant ' +
            '(Claude Code, GitHub Copilot, Codex, Gemini CLI or Cursor).'
          : 'ERD Studio: a new Welcome page: draw a diagram, import DBML, and set up your AI assistant ' +
            '(Claude Code, GitHub Copilot, Codex, Gemini CLI or Cursor) to work on the same files.',
        OPEN,
        'Not now',
      ).then((choice) => {
        if (choice === OPEN) { void vscode.commands.executeCommand('erdStudio.showGettingStarted'); }
      });
    }
  }

  // AI coding harness — prompt to update stale files; offer install once per
  // workspace when none are present. Never overwrite anything silently:
  // harness files (AGENTS.md in particular) can hold user content.
  let harnessPromptShown = false;
  {
    const harnessService = new HarnessService(semanticDir);
    const existing = harnessService.detectExisting(workspaceRoot);
    const installedCount = [...existing.values()].filter(Boolean).length;
    const staleTargets = harnessService.detectStale(workspaceRoot);
    // Usage telemetry: a managed (version-marked) harness file is present.
    // Only the primary files detectExisting already found are read; a
    // hand-written file with no marker does not count.
    try {
      const managed = HARNESS_TARGETS.filter(target => existing.get(target.id) &&
        extractHarnessVersion(fs.readFileSync(path.join(workspaceRoot, target.relativePath), 'utf-8')) !== null);
      if (managed.length > 0) { telemetry.featureOnce('harnessPresent'); }
      telemetry.harnesses(managed.map(target => target.id));
    } catch { /* telemetry must never break activation */ }

    if (staleTargets.length > 0) {
      harnessPromptShown = true;
      const names = staleTargets.map(t => t.label.replace(/\$\([^)]+\)\s*/g, '')).join(', ');
      void vscode.window.showWarningMessage(
        `ERD Studio: ${staleTargets.length} AI coding harness file(s) outdated (${names}). Update to v${HARNESS_VERSION}?`,
        'Update All',
        'Choose…',
        'Dismiss',
      ).then(choice => {
        if (choice === 'Update All') {
          const results = staleTargets.map(target => harnessService.install(workspaceRoot, target, true));
          recordHarnessInstalls(results);
          const failed = results.filter(r => !r.success);
          if (failed.length > 0) {
            const errors = failed.map(r => `${r.target.id}: ${r.error}`).join('; ');
            void vscode.window.showErrorMessage(
              `ERD Studio: ${failed.length} harness file(s) could not be updated. Errors: ${errors}`,
            );
          } else {
            void vscode.window.showInformationMessage(
              `ERD Studio: Updated ${results.length} AI coding harness file(s) to v${HARNESS_VERSION} (${names}).`,
            );
          }
        } else if (choice === 'Choose…') {
          // QuickPick pre-selects the outdated targets
          void vscode.commands.executeCommand('erdStudio.installCodingHarness');
        }
      });
    } else if (
      !suppressHarnessQuickPick &&
      // Offered where there is a dbt project or ERD data to describe, never
      // to a plain folder that has neither (logical-only, nothing yet).
      !quietActivation &&
      installedCount === 0 &&
      !context.workspaceState.get<boolean>(HARNESS_INSTALL_PROMPTED_KEY)
    ) {
      // No harnesses installed — offer the QuickPick once per workspace, not
      // on every window open. The command stays available in the palette.
      harnessPromptShown = true;
      void context.workspaceState.update(HARNESS_INSTALL_PROMPTED_KEY, true);
      void vscode.commands.executeCommand('erdStudio.installCodingHarness');
    }
  }

  // Existing diagrams, once per workspace: a teammate's clone already holds
  // .erd-studio/ domains the user may never have seen. Not on the walkthrough
  // run, beside the upgrade notice or beside either harness prompt above (one
  // prompt at a time; the flag stays unset, so it comes next time), and not
  // when a canvas is already open.
  // Writes nothing to the workspace.
  if (
    !suppressHarnessQuickPick &&
    !firstRunNoticeShown &&
    !harnessPromptShown &&
    !context.workspaceState.get<boolean>(DIAGRAMS_NUDGE_SHOWN_KEY) &&
    !hasOpenSubjectAreaCanvas()
  ) {
    const domains = subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir);
    const latest = mostRecentlyModified(domains);
    if (latest) {
      await context.workspaceState.update(DIAGRAMS_NUDGE_SHOWN_KEY, true);
      const open = `Open ${latest.domain}`;
      void vscode.window.showInformationMessage(
        `This project has ${domains.length} ERD Studio diagram${domains.length === 1 ? '' : 's'}.`,
        open,
        'Not now',
      ).then((choice) => {
        if (choice === open) { void vscode.commands.executeCommand('erdStudio.openDomain', latest.filePath); }
      });
    }
  }

  // First-run check
  const fullSemanticDir = path.join(workspaceRoot, semanticDir);
  if (fs.existsSync(fullSemanticDir) && !layerService.configFileExists()) {
    const detected = layerService.detectLayersFromFilesystem();
    if (detected.length > 0) {
      const layerNames = detected.map(l => l.label).join(', ');
      void vscode.window.showInformationMessage(
        `Detected layers: ${layerNames}. Would you like to save layer configuration for customization?`,
        'Save Config', 'Later',
      ).then(async (choice) => {
        if (choice === 'Save Config') {
          try {
            await layerService.saveConfig(detected);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Failed to save layer configuration: ${msg}`);
            return;
          }
          layerService.invalidateCache();
          refreshContextKeys();
          treeProvider.refresh();
          layerDecorationProvider.refresh();
          decorationProvider.refresh();
          void vscode.window.showInformationMessage(`Layer configuration saved to ${semanticDir}/layers.json`);
        }
      });
    }
  }

  // Keep ~/.erd-studio-cli in step with this extension — only if the user
  // installed it (Set Up My AI Helper). The second documented exception to
  // "no unprompted writes": it writes outside the workspace, only after that
  // opt-in, and never throws or toasts.
  void cliLauncher.refreshIfInstalled(launcherOptions);

  // ---------------------------------------------------------------------------
  // Legacy command aliases
  // ---------------------------------------------------------------------------
  // The extension was originally published with dbtSemantic.* command IDs.
  // Keep them callable (registered in code only, so they stay out of the
  // command palette) so existing user keybindings keep working after the
  // erdStudio.* rename.
  const LEGACY_ALIASED_COMMANDS = [
    'createDomain',
    'setupSemanticDirectory',
    'openDomain',
    'deleteDomain',
    'refreshManifest',
    'renameDomain',
    'addLayer',
    'editLayer',
    'removeLayer',
    'initializeLayerConfig',
    'installCodingHarness',
    'syncDomainTags',
    'stripLegacyDomainTags',
    'migrateToV5',
    'deleteLogicalModel',
    'revealLogicalModel',
  ];
  for (const name of LEGACY_ALIASED_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`dbtSemantic.${name}`, (...args: unknown[]) =>
        vscode.commands.executeCommand(`erdStudio.${name}`, ...args),
      ),
    );
  }
}

export function deactivate(): void {
  // Cleanup will be added when services are implemented
}
