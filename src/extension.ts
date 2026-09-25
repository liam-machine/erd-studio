import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { DomainService, renameDomainInRaw } from './services/domainService';
import { LayerService } from './services/layerService';
import { CURRENT_SCHEMA_VERSION, getRawDomainModelNames, type DomainSummary, type Layer, type Stage, type UnifiedDomain, type StageData } from './types/semantic';
import { ManifestService, type ManifestLoadFailure } from './services/manifestService';
import { TemplateService } from './services/templateService';
import { DomainTreeProvider, type TreeElement } from './providers/DomainTreeProvider';
import { SemanticEditorProvider } from './providers/SemanticEditorProvider';
import { SemanticFileDecorationProvider } from './providers/SemanticFileDecorationProvider';
import { LayerDecorationProvider } from './providers/LayerDecorationProvider';
import { FileWatcherService } from './watchers/FileWatcherService';
import { HarnessService, HARNESS_TARGETS, HARNESS_VERSION, extractHarnessVersion, type HarnessInstallResult, type HarnessTarget } from './services/harnessService';
import { SelectorsService } from './services/selectorsService';
import { LegacyTagCleanupService } from './services/legacyTagCleanupService';
import { LogicalModelService } from './services/logicalModelService';
import { ownWrites } from './services/ownWriteTracker';
import { MigrationService, migrateLegacySemanticDir } from './services/migrationService';
import { hasErdStudioData, resolveDbtProject, samePath, type DbtProjectResolution } from './services/projectDiscovery';
import { YmlParserService } from './services/ymlParserService';
import { CatalogService } from './services/catalogService';
import { getErdStudioSetting } from './services/configService';
import { readDbtProjectConfig } from './services/dbtProjectConfig';
import { ModelLibraryTreeProvider, type ModelLibraryNode } from './providers/ModelLibraryTreeProvider';
import { describeOrganizePlan, planOrganizeByLayer, type DomainModelUsage } from './services/modelLibraryOrganizer';
import { describeDuplicateFix, planDuplicateFix, repointDomainModel, suggestDuplicateName, type DomainReference } from './services/duplicateModelResolver';
import { validateModelName } from './providers/payloadValidation';
import { parseLogicalModelText } from '@erd-studio/core';
import { DOMAIN_EDITOR_VIEW_TYPE, hasOpenDomainCanvas, saveAllAndReload } from './services/recoveryService';
import { submitFeedback } from './services/feedbackService';
import { clearFeedbackApiKey, setFeedbackApiKey } from './services/feedbackAnalysisService';
import { ReportTrackingService } from './services/reportTrackingService';
import { TelemetryService, telemetry } from './services/telemetryService';
import type { TelemetryErrorCode, TelemetryFeature } from './services/telemetryPayload';
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
  type GettingStartedDeps,
} from './providers/GettingStartedPanel';
import { deriveAiHelperState, promptFor, SETUP_PROMPT, type GettingStartedStatus } from './types/gettingStarted';
import { assistantInfo } from './types/aiAssistants';

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
 * picked project, then auto-detection. See `resolveDbtProject`.
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
    void vscode.window.showWarningMessage(NO_PROJECT_MESSAGE);
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

const MANIFEST_FAILURE_CODES: Record<ManifestLoadFailure, TelemetryErrorCode> = {
  missing: 'manifestMissing',
  malformed: 'manifestMalformed',
  timeout: 'manifestTimeout',
};

/** The generic Agent Skills target has no feature key of its own and is not counted. */
const HARNESS_INSTALL_FEATURES: Partial<Record<HarnessTarget['id'], TelemetryFeature>> = {
  claude: 'harnessInstallClaude',
  copilot: 'harnessInstallCopilot',
  gemini: 'harnessInstallGemini',
  codex: 'harnessInstallCodex',
};

function recordHarnessInstalls(results: HarnessInstallResult[]): void {
  for (const r of results) {
    const feature = r.success ? HARNESS_INSTALL_FEATURES[r.target.id] : undefined;
    if (feature) telemetry.feature(feature);
  }
}

const NO_PROJECT_MESSAGE =
  'ERD Studio: No dbt project found. Open a folder containing dbt_project.yml, ' +
  'or set erdStudio.projectPath to the dbt project folder.';

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
  'erdStudio.setFeedbackApiKey',
  'erdStudio.clearFeedbackApiKey',
  'erdStudio.refreshMyReports',
  'erdStudio.openTrackedReport',
  'erdStudio.organizeModelLibrary',
  'erdStudio.selectDbtProject',
  'erdStudio.resolveDuplicateModel',
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
 * custom editor for domain files. Used when no dbt project could be found so
 * the palette, sidebar welcome buttons and domain JSON files show a helpful
 * message instead of "command not found" / a blank editor error.
 */
function registerFallbackCommands(context: vscode.ExtensionContext): void {
  const showNoProject = async (): Promise<void> => {
    const choice = await vscode.window.showWarningMessage(NO_PROJECT_MESSAGE, 'Open Settings');
    if (choice === 'Open Settings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'erdStudio.projectPath');
    }
  };

  const contributed = (context.extension.packageJSON as {
    contributes?: { commands?: Array<{ command: string }> };
  }).contributes?.commands ?? [];

  for (const { command } of contributed) {
    // PRE_REGISTERED_COMMANDS are registered by activate() before this fallback
    // runs and work without a project; registering again would throw ("already exists").
    if (!command.startsWith('erdStudio.') || PRE_REGISTERED_COMMANDS.has(command)) { continue; }
    context.subscriptions.push(vscode.commands.registerCommand(command, showNoProject));
    // Post-rename commands never had a dbtSemantic.* id — see NO_LEGACY_ALIAS.
    if (NO_LEGACY_ALIAS.has(command)) { continue; }
    context.subscriptions.push(
      vscode.commands.registerCommand(command.replace(/^erdStudio\./, 'dbtSemantic.'), showNoProject),
    );
  }

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(DOMAIN_EDITOR_VIEW_TYPE, {
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
    `Domain "${domainName}" has unsaved changes. Save before ${operation}?`,
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

function validateDomainSlug(
  value: string,
  layer: Layer,
  existingDomains: DomainSummary[],
  currentDomainName?: string,
): string | undefined {
  if (!value || !value.trim()) {
    return 'Domain name is required';
  }

  const slug = value.trim();

  if (currentDomainName && slug === currentDomainName) {
    return 'Domain name unchanged';
  }

  if (!/^[a-z][a-z0-9_-]*$/.test(slug)) {
    return 'Domain name must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores';
  }

  if (slug.length > 64) {
    return 'Domain name must be 64 characters or less';
  }

  const collision = existingDomains.find(
    d => d.domain === slug && d.layer === layer,
  );
  if (collision) {
    return `A domain named "${slug}" already exists in the ${layer} layer`;
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

/** Welcome panel deps before a dbt project is found: the video plays, the steps ask for a folder. */
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
  if (previousVersion && previousVersion !== currentVersion && hasOpenDomainCanvas()) {
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
  // plays the video and asks for a dbt folder. The project path fills in
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
    vscode.commands.registerCommand(TRY_SAMPLE_COMMAND, async () => { await trySampleProject(); }),
  );

  const projectResolution = resolveWorkspaceProject(context);
  const workspaceRoot = projectResolution.root;
  // Picks which sidebar welcome text shows (package.json viewsWelcome).
  void vscode.commands.executeCommand('setContext', 'erdStudio.hasDbtProject', Boolean(workspaceRoot));
  if (!workspaceRoot) {
    telemetry.activation('no_project', false, 0);
    // Register stub commands / editor so palette entries and the sidebar
    // welcome buttons explain the problem instead of "command not found".
    registerFallbackCommands(context);
    // A fresh install first activated without a dbt project (usually by
    // clicking the ERD Studio icon) still starts on the Welcome panel: it
    // plays the video, offers the sample project and says how to open one.
    const pending = context.globalState.get<boolean>(GETTING_STARTED_PENDING_KEY) === true;
    if (pending && !context.globalState.get<boolean>(GETTING_STARTED_NO_PROJECT_SHOWN_KEY) && !gettingStartedAutoOpened) {
      gettingStartedAutoOpened = true;
      await context.globalState.update(GETTING_STARTED_NO_PROJECT_SHOWN_KEY, true);
      GettingStartedPanel.createOrShow(context, noProjectGettingStartedDeps());
      return; // the panel explains the missing project; no warning toast on top
    }
    void vscode.window.showWarningMessage(NO_PROJECT_MESSAGE, 'Open Settings').then(choice => {
      if (choice === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'erdStudio.projectPath');
      }
    });
    return;
  }

  console.log(`ERD Studio: Found dbt project at ${workspaceRoot}`);

  const semanticDir = getErdStudioSetting('semanticDir', '.erd-studio');

  // More than one dbt project in the workspace (multi-root or monorepo, #82):
  // reveal the sidebar's Select dbt Project button. Re-checked when folders
  // are added or removed (see the domain tree view below).
  let hasMultipleProjects = projectResolution.candidates.length > 1;
  void vscode.commands.executeCommand('setContext', 'erdStudio.hasMultipleDbtProjects', hasMultipleProjects);

  if (projectResolution.invalidSetting !== undefined) {
    // Visible, not just a console line: a projectPath copied from someone
    // else's machine otherwise looks like the setting being ignored.
    void vscode.window.showWarningMessage(
      `ERD Studio: erdStudio.projectPath "${projectResolution.invalidSetting}" does not contain dbt_project.yml, ` +
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
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(workspaceRoot, semanticDir);
  logicalModelService.onParseFailure = () => telemetry.error('modelFileParse');
  domainService.setLogicalModelService(logicalModelService);
  const manifestService = new ManifestService({ dbtConfig, onLoadFailure: f => telemetry.error(MANIFEST_FAILURE_CODES[f]) });
  const ymlParserService = new YmlParserService({ dbtConfig });
  // target/catalog.json — present only after `dbt docs generate`, and the only
  // source of the types the warehouse actually has. Shares the one dbtConfig
  // read above; never re-read dbt_project.yml for a second consumer.
  const catalogService = new CatalogService({ dbtConfig, onReadFailure: () => telemetry.error('catalogUnreadable') });
  const templateService = new TemplateService();
  // Status bar item shown while selectors.yml is out of sync (skipped writes).
  // Hidden as soon as a regenerate succeeds.
  let selectorsOutOfSyncStatus: vscode.StatusBarItem | undefined;

  const selectorsService = new SelectorsService(
    domainService,
    workspaceRoot,
    semanticDir,
    {
      isFileDirtyInEditor: (filePath) =>
        vscode.workspace.textDocuments.some(
          doc => doc.uri.fsPath === filePath && doc.isDirty,
        ),
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
          `ERD Studio: selector name "${info.requestedName}" for domain ${info.domain} collides with ` +
            `${info.conflictsWith}. Wrote "${info.assignedName}" to selectors.yml instead — ` +
            'rename one of the domains to avoid the suffix.',
        );
      },
    },
  );
  const legacyTagCleanupService = new LegacyTagCleanupService(workspaceRoot);

  // Ensure selectors.yml exists and is up to date at activation time so a
  // fresh `git clone` with pre-existing domain files gets a valid selector
  // set before the user makes any edits. Debounced so activation isn't
  // blocked on disk I/O.
  selectorsService.scheduleRegenerate();

  // Check for v4 → v5 migration (non-blocking)
  const migrationService = new MigrationService(workspaceRoot, layerService, logicalModelService, semanticDir);
  if (migrationService.needsMigration()) {
    void vscode.window.showInformationMessage(
      'ERD Studio has a new model storage format that enables cross-domain model sharing. Migrate domain files now?',
      'Migrate Now',
      'Later',
    ).then((choice) => {
      if (choice === 'Migrate Now') {
        const result = migrationService.migrate();
        const details: string[] = [];
        if (result.domainsConverted > 0) details.push(`${result.domainsConverted} domain(s) converted`);
        if (result.modelsCreated > 0) details.push(`${result.modelsCreated} model file(s) created in logical-models/`);
        if (result.mergeConflicts.length > 0) details.push(`${result.mergeConflicts.length} merge conflict(s) resolved (richest version kept)`);
        vscode.window.showInformationMessage(`Migration complete: ${details.join(', ')}.`);
        selectorsService.scheduleRegenerate();
      }
    });
  }
  const treeProvider = new DomainTreeProvider(domainService, layerService, workspaceRoot, semanticDir);
  const modelLibraryProvider = new ModelLibraryTreeProvider(
    logicalModelService,
    domainService,
    workspaceRoot,
    semanticDir,
    () => layerService.getAllLayers(),
  );
  const editorProvider = new SemanticEditorProvider(
    context,
    domainService,
    manifestService,
    ymlParserService,
    templateService,
    layerService,
    workspaceRoot,
    selectorsService,
    logicalModelService,
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

  const decorationProvider = new SemanticFileDecorationProvider(layerService, semanticDir);
  const layerDecorationProvider = new LayerDecorationProvider(layerService);

  // Set context keys so view/title menus only show when semantic dir exists.
  // Re-evaluated whenever the semantic dir changes on disk (watcher events) or
  // the extension itself creates it (createDomain, addLayer, setup), so the
  // "+ Add Layer" / "Install Harness" buttons appear without a window reload.
  const fullSemanticDirPath = path.join(workspaceRoot, semanticDir);
  const refreshContextKeys = (): void => {
    void vscode.commands.executeCommand('setContext', 'erdStudio.hasSemanticDir', fs.existsSync(fullSemanticDirPath));
    void vscode.commands.executeCommand('setContext', 'erdStudio.hasLogicalModelsDir', logicalModelService.dirExists());
  };
  refreshContextKeys();
  telemetry.activation('project_found', fs.existsSync(fullSemanticDirPath), domainService.listDomains(workspaceRoot, semanticDir).length);

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
  const fileWatcherService = new FileWatcherService(workspaceRoot, semanticDir, dbtConfig);

  // Manifest changed → refresh open editors
  let manifestRetryTimeout: ReturnType<typeof setTimeout> | undefined;
  let manifestChangeGen = 0;
  const manifestChangedSubscription = fileWatcherService.onManifestChanged(
    async () => {
      const gen = ++manifestChangeGen;
      manifestService.invalidate();
      await editorProvider.refreshAllOpenDomains();

      // Superseded by a newer file-change event during the await
      if (gen !== manifestChangeGen) { return; }

      if (manifestService.isMissing) {
        // Definitive (dbt clean / target removed) — no retry, no stale data.
        void vscode.window.showWarningMessage(
          `dbt manifest removed (${dbtConfig.targetPath}/manifest.json). ` +
            'Models and relationships still come from your schema .yml files. ' +
            'Run dbt compile for declared types, or dbt docs generate for warehouse types.',
        );
        return;
      }

      if (manifestService.isStale) {
        // Manifest likely mid-write by dbt — deduplicate and retry once after 2s
        clearTimeout(manifestRetryTimeout);
        manifestRetryTimeout = setTimeout(async () => {
          const retryGen = manifestChangeGen;
          try {
            manifestService.invalidate();
            await editorProvider.refreshAllOpenDomains();
            // Superseded by a newer event during retry
            if (retryGen !== manifestChangeGen) { return; }
            if (!manifestService.isStale) {
              void vscode.window.showInformationMessage(
                'dbt manifest updated. Graphs refreshed with latest model data.',
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
          'dbt manifest updated. Graphs refreshed with latest model data.',
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
    await editorProvider.refreshAllOpenDomains();
  });

  // Semantic file changed externally → refresh tree view + model library
  const semanticChangedSubscription = fileWatcherService.onSemanticFileChanged(({ uri }) => {
    treeProvider.invalidateDomain(uri.fsPath);
    treeProvider.refresh();
    modelLibraryProvider.refresh();
    // A pulled/created .erd-studio/ must reveal the view/title buttons without a reload
    refreshContextKeys();
  });

  // The editor wrote a domain (and possibly model files) itself. Those writes
  // are recorded as own writes so the watchers skip them (a watcher-driven
  // refresh would send a second, identical domainLoaded and clear the user's
  // column selection), so the side effects the watcher used to drive are
  // issued here directly instead.
  const editorWroteSubscription = editorProvider.onDidWriteDomain(({ uri, modelLibraryChanged }) => {
    treeProvider.invalidateDomain(uri.fsPath);
    treeProvider.refresh();
    // The Model Library lists a "N domains" count and the referencing domain
    // names per model, so ANY domain write can change what it shows — adding or
    // removing a model reference changes the count without creating or deleting
    // a yml file. Refresh on every write; `modelLibraryChanged` only gates the
    // context keys, which turn on the view itself and can only change when a
    // file appears or disappears.
    modelLibraryProvider.refresh();
    if (modelLibraryChanged) {
      refreshContextKeys();
    }
  });

  // Domain file(s) deleted → refresh tree + model library, prompt for tag cleanup.
  // The watcher coalesces a delete storm (branch switch) into one event and
  // filters out layers.json / templates / logical-models / .sync-plan.json, so
  // one toast covers the whole burst and only real domain files trigger it.
  // NOTE: reconcileAll() is NOT called automatically here because git operations
  // (pull, checkout, merge, rebase) trigger file-delete events on Windows (delete-
  // then-rename) and macOS (atomic rename via FSEvents), causing mass YAML
  // modifications. Instead, offer to run the manual sync command.
  const semanticDeletedSubscription = fileWatcherService.onSemanticFileDeleted(({ uris }) => {
    for (const uri of uris) {
      treeProvider.invalidateDomain(uri.fsPath);
    }
    treeProvider.refresh();
    modelLibraryProvider.refresh();
    refreshContextKeys();
    const subject = uris.length === 1
      ? 'Domain file deleted.'
      : `${uris.length} domain files deleted.`;
    void vscode.window.showInformationMessage(
      `${subject} Regenerate dbt selectors.yml to drop the removed domain${uris.length === 1 ? '' : 's'} from the selector set.`,
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
    treeProvider.invalidateDomain();
    treeProvider.refresh();
    modelLibraryProvider.refresh();
    layerDecorationProvider.refresh();
    decorationProvider.refresh();
    refreshContextKeys();
    warnIfLayerConfigBroken();
  });

  // Logical model file changed → refresh domains referencing that model + model library
  const logicalModelChangedSubscription = fileWatcherService.onLogicalModelChanged(
    async ({ modelName }) => {
      logicalModelService.invalidateCache(modelName);
      await editorProvider.refreshDomainsReferencingModel(modelName);
      treeProvider.refresh();
      modelLibraryProvider.refresh();
      // Re-evaluate context key so the Model Library view appears if logical-models/ was just created
      refreshContextKeys();
    },
  );

  // dbt schema .yml changed → refresh physical stage
  const dbtYmlChangedSubscription = fileWatcherService.onDbtYmlChanged(
    async () => {
      ymlParserService.invalidate();
      await editorProvider.refreshAllOpenDomains();
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
    vscode.window.registerCustomEditorProvider(DOMAIN_EDITOR_VIEW_TYPE, editorProvider, {
      // Keep the webview (React tree, ELK worker, in-progress discrepancy /
      // sync-merge state) alive when the tab is hidden instead of tearing it
      // down and rebuilding from PersistedState on every tab switch.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.window.registerFileDecorationProvider(layerDecorationProvider),
    modelLibraryProvider,
    (() => {
      return vscode.window.createTreeView('erdStudio.modelLibrary', {
        treeDataProvider: modelLibraryProvider,
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
    vscode.commands.registerCommand('erdStudio.deleteLogicalModel', async (node: ModelLibraryNode | undefined) => {
      if (!node || node.type !== 'model') {
        void vscode.window.showErrorMessage('Delete Model: No model selected. Right-click a model in the Model Library.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete model "${node.name}"? This removes the YAML file — domain references are not cleaned up.`,
        { modal: true },
        'Delete',
      );
      if (confirm === 'Delete') {
        logicalModelService.deleteModel(node.name);
        modelLibraryProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('erdStudio.selectDbtProject', (target?: unknown) =>
      selectDbtProject(context, workspaceRoot, semanticDir, typeof target === 'string' ? target : undefined)),
    // Move top-level logical-models/*.yml files into the folder of the one
    // layer whose domains use them (issue #76). Prompted, one WorkspaceEdit.
    vscode.commands.registerCommand('erdStudio.organizeModelLibrary', async () => {
      if (!logicalModelService.dirExists()) {
        void vscode.window.showInformationMessage('Organise Model Library: there is no logical-models/ folder yet.');
        return;
      }
      const usage: DomainModelUsage[] = [];
      for (const summary of domainService.listDomains(workspaceRoot, semanticDir)) {
        try {
          const raw = JSON.parse(fs.readFileSync(summary.filePath, 'utf-8')) as unknown;
          usage.push({ layer: summary.layer, modelNames: getRawDomainModelNames(raw) });
        } catch {
          // An unreadable domain contributes no usage; its models stay put.
        }
      }
      const modelsDir = logicalModelService.getModelsDir();
      const plan = planOrganizeByLayer(
        logicalModelService.listModelFiles(),
        usage,
        (name, layer) => LogicalModelService.isModelFolderName(layer) ? path.join(modelsDir, layer, `${name}.yml`) : null,
        new Set(layerService.getAllLayers().map((l) => l.id)),
      );
      if (plan.moves.length === 0) {
        void vscode.window.showInformationMessage(
          `Organise Model Library: nothing to move. ${describeOrganizePlan(plan).replace(/\n+/g, ' ')}`,
        );
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        'Organise Model Library by Layer?',
        { modal: true, detail: describeOrganizePlan(plan) },
        'Move Files',
      );
      if (choice !== 'Move Files') return;

      const edit = new vscode.WorkspaceEdit();
      const newFolders = new Set<string>();
      for (const move of plan.moves) {
        const folder = path.dirname(move.to);
        if (!fs.existsSync(folder)) newFolders.add(folder);
        logicalModelService.ensureDir(move.to);
        edit.renameFile(vscode.Uri.file(move.from), vscode.Uri.file(move.to), { overwrite: false });
      }
      if (!(await vscode.workspace.applyEdit(edit))) {
        // Leave no empty layer folders behind for a move that did not happen.
        for (const folder of newFolders) {
          try { fs.rmdirSync(folder); } catch { /* not empty, or already gone */ }
        }
        void vscode.window.showErrorMessage('Organise Model Library: VS Code rejected the file moves; nothing was changed.');
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
      logicalModelService.invalidateCache();
      modelLibraryProvider.refresh();
      void vscode.window.showInformationMessage(
        `Moved ${plan.moves.length} model file${plan.moves.length === 1 ? '' : 's'} into layer folders.`,
      );
    }),
    // A second file with a name the library already has is ignored (names are
    // identities). Give it its own name — `{layer}_{name}` — with an alias that
    // keeps the table name, and repoint the domains of its layer at it.
    // Prompted, one WorkspaceEdit, one undo step.
    vscode.commands.registerCommand('erdStudio.resolveDuplicateModel', async (arg?: ModelLibraryNode | string) => {
      const entries = logicalModelService.listModelFiles();
      const duplicates = entries.filter((e) => e.shadowedBy);
      const target = typeof arg === 'string' ? arg : arg?.type === 'model' ? arg.filePath : undefined;
      // Compare real paths: the tree hands over what the library listed, but a
      // warning or a caller may name the same file through a symlinked prefix.
      const realPath = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
      let entry = target === undefined ? undefined : duplicates.find((e) => realPath(e.filePath) === realPath(target));
      const modelsDir = logicalModelService.getModelsDir();
      const libPath = (p: string): string => `logical-models/${path.relative(modelsDir, p).split(path.sep).join('/')}`;
      if (!entry) {
        if (duplicates.length === 0) {
          void vscode.window.showInformationMessage('Every model file in the library has its own name.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          duplicates.map((e) => ({ label: libPath(e.filePath), description: `ignored — ${libPath(e.shadowedBy!)} is used`, entry: e })),
          { placeHolder: 'Which duplicate model file should get its own name?' },
        );
        if (!pick) return;
        entry = pick.entry;
      }
      const dup = entry;

      const model = (() => {
        try { return parseLogicalModelText(fs.readFileSync(dup.filePath, 'utf-8'), dup.name); } catch { return null; }
      })();
      if (!model) {
        void vscode.window.showErrorMessage(`${libPath(dup.filePath)} could not be read as a model file. Fix or rename it by hand.`);
        return;
      }

      const taken = new Set(entries.map((e) => e.name));
      const newName = (await vscode.window.showInputBox({
        title: `Give ${libPath(dup.filePath)} its own name`,
        prompt: `Model names are unique, as in dbt. The table name stays "${model.alias || dup.name}" (set as the model's alias).`,
        value: suggestDuplicateName(dup.name, dup.folder, taken),
        ignoreFocusOut: true,
        validateInput: (value) => validateModelName(value)
          ?? (taken.has(value.trim()) ? `"${value.trim()}" already exists in the model library.` : null),
      }))?.trim();
      if (!newName) return;

      const references: DomainReference[] = [];
      for (const summary of domainService.listDomains(workspaceRoot, semanticDir)) {
        try {
          const raw = JSON.parse(fs.readFileSync(summary.filePath, 'utf-8')) as unknown;
          if (getRawDomainModelNames(raw).includes(dup.name)) {
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
      const yamlText = logicalModelService.serializeModelAt({ ...model, name: newName, alias: plan.alias }, dup.filePath);
      edit.createFile(vscode.Uri.file(newPath), { overwrite: false, contents: Buffer.from(yamlText, 'utf-8') });
      edit.deleteFile(vscode.Uri.file(dup.filePath), { ignoreIfNotExists: true });
      const domainDocs: vscode.TextDocument[] = [];
      for (const ref of plan.repoint) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ref.filePath));
        const text = doc.getText();
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (!repointDomainModel(parsed, dup.name, newName)) continue;
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), JSON.stringify(parsed, null, 2) + '\n');
        domainDocs.push(doc);
      }
      if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showErrorMessage('VS Code rejected the rename; nothing was changed.');
        return;
      }
      // Domain edits land in memory; a canvas never sits dirty, so save them.
      // Every path is recorded as our own write, and the refreshes the
      // watchers would have driven are issued directly below.
      for (const doc of domainDocs) {
        await doc.save();
        ownWrites.recordWrite(doc.uri.fsPath);
        treeProvider.invalidateDomain(doc.uri.fsPath);
      }
      ownWrites.recordWrite(newPath);
      ownWrites.recordDelete(dup.filePath);
      logicalModelService.invalidateCache();
      modelLibraryProvider.refresh();
      treeProvider.refresh();
      selectorsService.scheduleRegenerate();
      await editorProvider.refreshAllOpenDomains();
      void vscode.window.showInformationMessage(
        `${libPath(newPath)} is now its own model, "${newName}" (table: ${plan.alias}).` +
        (domainDocs.length ? ` Repointed ${domainDocs.length} domain${domainDocs.length === 1 ? '' : 's'}.` : ''),
      );
    }),
    vscode.commands.registerCommand('erdStudio.revealLogicalModel', (node: ModelLibraryNode | undefined) => {
      if (!node || node.type !== 'model') {
        void vscode.window.showErrorMessage('Reveal in Explorer: No model selected. Right-click a model in the Model Library.');
        return;
      }
      void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(node.filePath));
    }),
    vscode.commands.registerCommand('erdStudio.openDomain', async (filePath: string, stage?: Stage) => {
      const fileUri = vscode.Uri.file(filePath);
      await vscode.commands.executeCommand(
        'vscode.openWith',
        fileUri,
        DOMAIN_EDITOR_VIEW_TYPE,
      );
      if (stage === 'physical') {
        editorProvider.switchStageForUri(fileUri, 'physical');
      }
    }),
    vscode.commands.registerCommand(
      'erdStudio.createDomain',
      async (layerArg?: Layer) => {
        // Step 1: Determine layer
        let layer: Layer | undefined = layerArg;
        if (!layer) {
          const creatableLayers = layerService.getCreatableLayers();
          if (creatableLayers.length === 0) {
            void vscode.window.showErrorMessage('No layers configured for domain creation. Add layers first.');
            return;
          }
          const layerItems = creatableLayers.map(l => ({ label: l.label, value: l.id }));
          const layerChoice = await vscode.window.showQuickPick(layerItems, {
            placeHolder: 'Select layer for the new semantic domain',
            ignoreFocusOut: true,
          });
          if (!layerChoice) { return; }
          layer = layerChoice.value;
        }

        // Step 2: Get domain name
        const existingDomains = domainService.listDomains(workspaceRoot, semanticDir);
        const domainSlug = await vscode.window.showInputBox({
          prompt: 'Enter domain name (slug format)',
          placeHolder: 'e.g. customer-360, sales-analytics, orders',
          ignoreFocusOut: true,
          validateInput: (value: string) =>
            validateDomainSlug(value, layer, existingDomains),
        });
        if (!domainSlug) { return; }
        const slug = domainSlug.trim();

        // Step 3: Get description
        const description = await vscode.window.showInputBox({
          prompt: 'Enter domain description (optional)',
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
              placeHolder: 'Filter models by folder (optional)',
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

        try {
          if (!fs.existsSync(layerDir)) {
            fs.mkdirSync(layerDir, { recursive: true });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to create directory: ${msg}`);
          return;
        }

        const emptyStage: StageData = { models: [], relationships: [] };
        const domainData: UnifiedDomain = {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          domain: slug,
          layer,
          description: description.trim(),
          ...(modelFolder ? { modelFolder } : {}),
          logical: { ...emptyStage },
          viewConfig: {},
        };

        try {
          fs.writeFileSync(filePath, JSON.stringify(domainData, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
        } catch (err) {
          if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
            void vscode.window.showErrorMessage(`Domain "${slug}" already exists in the ${layer} layer`);
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to create domain file: ${msg}`);
          return;
        }

        // Step 6: Refresh tree, regenerate selectors.yml, and auto-open domain.
        // The semantic dir may have just been created — reveal the title buttons.
        refreshContextKeys();
        treeProvider.refresh();
        selectorsService.scheduleRegenerate();
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(filePath),
          DOMAIN_EDITOR_VIEW_TYPE,
        );
      },
    ),
    vscode.commands.registerCommand(
      'erdStudio.deleteDomain',
      async (element?: TreeElement) => {
        if (!element || element.type !== 'domain') {
          void vscode.window.showErrorMessage('Delete Domain: No domain selected. Right-click a domain in the tree view.');
          return;
        }

        const domainName = element.summary.domain;
        const filePath = element.summary.filePath;
        const fileUri = vscode.Uri.file(filePath);

        const shouldProceed = await handleUnsavedChanges(fileUri, domainName, 'deleting');
        if (!shouldProceed) { return; }

        const confirm = await vscode.window.showWarningMessage(
          `Are you sure you want to delete domain "${domainName}"?`,
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
          treeProvider.invalidateDomain(filePath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to delete domain: ${msg}`);
        }

        treeProvider.refresh();
        selectorsService.scheduleRegenerate();
      },
    ),
    vscode.commands.registerCommand(
      'erdStudio.renameDomain',
      async (element?: TreeElement) => {
        if (!element || element.type !== 'domain') {
          void vscode.window.showErrorMessage('Rename Domain: No domain selected. Right-click a domain in the tree view.');
          return;
        }

        const oldDomainName = element.summary.domain;
        const oldFilePath = element.summary.filePath;
        const oldFileUri = vscode.Uri.file(oldFilePath);
        const layer = element.summary.layer;

        const shouldProceed = await handleUnsavedChanges(oldFileUri, oldDomainName, 'renaming');
        if (!shouldProceed) { return; }

        const existingDomains = domainService.listDomains(workspaceRoot, semanticDir);
        const newDomainSlug = await vscode.window.showInputBox({
          prompt: 'Enter new domain name',
          value: oldDomainName,
          ignoreFocusOut: true,
          validateInput: (value: string) =>
            validateDomainSlug(value, layer, existingDomains, oldDomainName),
        });
        if (!newDomainSlug) { return; }
        const newSlug = newDomainSlug.trim();
        if (newSlug === oldDomainName) { return; }

        // Read and update domain name in the unified file.
        // Validate via DomainService, but rewrite the RAW document so v5 model
        // name references and unknown keys are preserved — re-serialising the
        // resolved UnifiedDomain would inline model bodies into a v5 file.
        let renamedContent: string;
        try {
          domainService.getDomain(oldFilePath);
          renamedContent = renameDomainInRaw(fs.readFileSync(oldFilePath, 'utf-8'), newSlug);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to read domain file: ${msg}`);
          return;
        }

        // Close old editor tabs before applying the edit (file will be deleted)
        const oldTabs = findMatchingTabs(oldFileUri);
        if (oldTabs.length > 0) { await vscode.window.tabGroups.close(oldTabs, true); }

        const newFilePath = path.join(workspaceRoot, semanticDir, layer, `${newSlug}.json`);
        const newFileUri = vscode.Uri.file(newFilePath);

        const edit = new vscode.WorkspaceEdit();
        edit.createFile(newFileUri, { overwrite: false, ignoreIfExists: false });
        edit.insert(newFileUri, new vscode.Position(0, 0), renamedContent);
        edit.deleteFile(oldFileUri, { ignoreIfNotExists: false });

        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
          void vscode.window.showErrorMessage(`Failed to rename domain "${oldDomainName}" to "${newSlug}"`);
          return;
        }

        // Auto-open renamed domain
        selectorsService.scheduleRegenerate();
        await vscode.commands.executeCommand('vscode.openWith', newFileUri, DOMAIN_EDITOR_VIEW_TYPE);
      },
    ),
    vscode.commands.registerCommand('erdStudio.refreshManifest', async () => {
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
          await editorProvider.refreshAllOpenDomains();
          if (manifestService.isMissing) {
            void vscode.window.showWarningMessage(
              `manifest.json not found at ${dbtConfig.targetPath}/manifest.json. ` +
                'Models and relationships still come from your schema .yml files. ' +
                'Run dbt compile for declared types, or dbt docs generate for warehouse types.',
            );
          } else if (manifestService.isStale) {
            void vscode.window.showWarningMessage(
              'dbt manifest could not be parsed (it may be mid-write) — graphs show the last good data. Try again shortly.',
            );
          } else {
            void vscode.window.showInformationMessage('Manifest refreshed. Graphs updated with latest model data.');
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
                `Wrote ${result.selectorsWritten} selector(s) covering ${result.modelsReferenced} model reference(s) to ${relPath}.`,
              );
            } else if (result.status === 'noop') {
              void vscode.window.showInformationMessage(
                'No domains with models found — selectors.yml was not created.',
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
        void vscode.window.showInformationMessage('All domain files are already using the v5 central model store format.');
        return;
      }

      const v4Count = migrationService.findV4Domains().length;
      const confirm = await vscode.window.showWarningMessage(
        `Found ${v4Count} domain file(s) using the legacy inline model format. ` +
        'Migration will extract models to .erd-studio/logical-models/ and convert domain files to use name references. ' +
        'This cannot be undone automatically.',
        'Migrate Now',
        'Cancel',
      );

      if (confirm !== 'Migrate Now') return;

      let result: ReturnType<typeof migrationService.migrate>;
      try {
        result = migrationService.migrate();
      } catch (err) {
        telemetry.error('migrationFailed');
        throw err;
      }
      telemetry.feature('migrateV5');
      const details: string[] = [];
      if (result.domainsConverted > 0) details.push(`${result.domainsConverted} domain(s) converted`);
      if (result.modelsCreated > 0) details.push(`${result.modelsCreated} model file(s) created in logical-models/`);
      if (result.mergeConflicts.length > 0) details.push(`${result.mergeConflicts.length} merge conflict(s) resolved`);
      void vscode.window.showInformationMessage(`Migration complete: ${details.join(', ')}.`);

      treeProvider.refresh();
      await editorProvider.refreshAllOpenDomains();
      selectorsService.scheduleRegenerate();
    }),
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

          // Create logical-models directory
          const logicalModelsDir = path.join(fullSemanticDir, 'logical-models');
          if (!fs.existsSync(logicalModelsDir)) {
            fs.mkdirSync(logicalModelsDir, { recursive: true });
          }

          await layerService.saveConfig(defaultLayers);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to create semantic directory structure: ${msg}`);
          return;
        }

        // Update context keys so view/title menus appear
        refreshContextKeys();
        treeProvider.refresh();
        await new Promise(resolve => setTimeout(resolve, 100));
        void vscode.window.showInformationMessage('ERD Studio directory created! Now create your first domain.');
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

        const domains = domainService.listDomains(workspaceRoot, semanticDir);
        const layerDomains = domains.filter(d => d.layer === layerId);
        if (layerDomains.length > 0) {
          void vscode.window.showErrorMessage(
            `Cannot remove layer "${layer.label}" — it contains ${layerDomains.length} domain(s). Delete or move domains first.`,
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
      harness,
      cli,
      helper: deriveAiHelperState(harness, cli, assistants),
      claude: detectClaude().availability,
      assistants,
      domainCount: domainService.listDomains(workspaceRoot, semanticDir).length,
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

  // "Open a domain" from the panel: straight in when there is one, a pick when
  // there are several, and the create flow when there are none yet.
  const openCanvas = async (): Promise<void> => {
    const domains = domainService.listDomains(workspaceRoot, semanticDir);
    if (domains.length === 0) {
      await vscode.commands.executeCommand(
        fs.existsSync(fullSemanticDirPath) ? 'erdStudio.createDomain' : 'erdStudio.setupSemanticDirectory',
      );
      return;
    }
    let target = domains[0];
    if (domains.length > 1) {
      const picked = await vscode.window.showQuickPick(
        domains.map((d) => ({ label: d.domain, description: d.layer, summary: d })),
        { placeHolder: 'Open which domain?' },
      );
      if (!picked) { return; }
      target = picked.summary;
    }
    await vscode.commands.executeCommand('erdStudio.openDomain', target.filePath);
  };

  gettingStartedDeps = {
    workspaceRoot,
    semanticDir,
    runSetup,
    getStatus: getGettingStartedStatus,
    clipboardText: setupClipboardText,
    workspaceFolder: projectWorkspaceFolder,
    openCanvas,
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

  // First run (spec C.5, addendum P4). A fresh install opens the Welcome panel
  // once per machine and skips this run's harness QuickPick (the panel offers
  // the one-click setup instead); an upgrader gets one non-modal notice. The
  // "shown" flag is written BEFORE the panel opens so a crash cannot loop.
  let suppressHarnessQuickPick = false;
  {
    const pending = context.globalState.get<boolean>(GETTING_STARTED_PENDING_KEY) === true;
    const shown = context.globalState.get<boolean>(GETTING_STARTED_SHOWN_KEY) === true;
    if (pending && !shown && !gettingStartedAutoOpened) {
      gettingStartedAutoOpened = true;
      suppressHarnessQuickPick = true;
      await context.globalState.update(GETTING_STARTED_SHOWN_KEY, true);
      await context.globalState.update(GETTING_STARTED_PENDING_KEY, undefined);
      GettingStartedPanel.createOrShow(context, gettingStartedDeps);
    } else if (pending && shown) {
      // Another window got there first.
      await context.globalState.update(GETTING_STARTED_PENDING_KEY, undefined);
    } else if (!pending && !shown) {
      await context.globalState.update(GETTING_STARTED_SHOWN_KEY, true);
      void vscode.window.showInformationMessage(
        'ERD Studio: new short getting-started video and a guided setup for your AI assistant ' +
          '(Claude Code, GitHub Copilot, Codex, Gemini CLI or Cursor).',
        'Watch',
        'Not now',
      ).then((choice) => {
        if (choice === 'Watch') { void vscode.commands.executeCommand('erdStudio.showGettingStarted'); }
      });
    }
  }

  // AI coding harness — prompt to update stale files; offer install once per
  // workspace when none are present. Never overwrite anything silently:
  // harness files (AGENTS.md in particular) can hold user content.
  {
    const harnessService = new HarnessService(semanticDir);
    const existing = harnessService.detectExisting(workspaceRoot);
    const installedCount = [...existing.values()].filter(Boolean).length;
    const staleTargets = harnessService.detectStale(workspaceRoot);

    if (staleTargets.length > 0) {
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
      installedCount === 0 &&
      !context.workspaceState.get<boolean>(HARNESS_INSTALL_PROMPTED_KEY)
    ) {
      // No harnesses installed — offer the QuickPick once per workspace, not
      // on every window open. The command stays available in the palette.
      void context.workspaceState.update(HARNESS_INSTALL_PROMPTED_KEY, true);
      void vscode.commands.executeCommand('erdStudio.installCodingHarness');
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
