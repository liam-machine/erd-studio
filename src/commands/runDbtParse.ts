/**
 * **Run dbt parse** — writes `{target-path}/manifest.json`, which is what the
 * physical stage needs to read columns and tests on a fresh clone. `dbt
 * parse` never connects to the warehouse, but it does load profiles.yml.
 * Offered by the physical stage's notice and the Logical strip (`runDbtParse`
 * message) and by the "manifest missing" notifications in extension.ts.
 *
 * dbt runs in a pseudoterminal (`dbtTerminal.ts`) as the chosen candidate's
 * own absolute executable — never an activate line typed into a shell, which
 * PowerShell rejects — so its exit code and output are read:
 *
 * - success says so, and offers **Open Physical view** for the canvas that asked;
 * - a failure is classified (`dbtFailure.ts`) into a fixed cause with the next
 *   step: **Parse without your credentials**, **Run dbt deps**, how to install
 *   an adapter or set up a profile, or **Show output**.
 *
 * **Parse without your credentials** writes a placeholder profiles.yml into
 * ERD Studio's own global storage (never the workspace; no secrets) and runs
 * `dbt parse --profiles-dir <it> --profile erd_studio --target erd_studio`.
 * It never reads the content of the user's profiles.yml: only whether one
 * exists. Every file access goes through `deps.fs`.
 *
 * Telemetry records fixed keys only. dbt's output stays in memory and in the
 * terminal: it never reaches telemetry or the log.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  ADAPTER_LABELS,
  adapterHintsFromText,
  adapterTypeFromManifestStart,
  chooseThrowawayAdapter,
  NO_CREDS_ADAPTER_FEATURES,
  profilesYmlWouldBeFound,
  REQUIREMENTS_FILES,
  throwawayProfileYaml,
  type ThrowawayAdapter,
} from '../services/dbtAdapters';
import {
  feedbackPrefill,
  SEND_FEEDBACK_BUTTON,
  showErrorWithActions,
  TRY_AGAIN_BUTTON,
  type ErrorActions,
} from '../services/commandErrors';
import { displayPath, isUntrustedProjectExecutable, type DbtCandidate } from '../services/dbtEnv';
import {
  classifyDbtFailure,
  DBT_PARSE_FAILURE_FEATURES,
  envVarFailedAfterAdapterLoad,
  ENV_VAR_PROJECT_FILES,
  envVarUsedInProjectFile,
  failureNotice,
  missingAdapterType,
  missingEnvVarName,
  profileUnreadable,
  type DbtFailureAction,
} from '../services/dbtFailure';
import { planDbtSpawn, THROWAWAY_PROFILE_DIR_NAME, type DbtCommandKind, type DbtRunMode } from '../services/dbtLaunch';
import type { DbtProcessResult } from '../services/dbtProcess';
import { couldNotStartNotice, profileWriteNotice, type DbtNotice, type DbtNoticeAction } from '../services/dbtRunMessages';
import { defaultDbtProjectConfig, manifestDisplayPath, resolveManifestPath, type DbtProjectConfig } from '../services/dbtProjectConfig';
import { log } from '../services/logger';
import { readTextStart } from '../services/readFileStart';
import { THROWAWAY_MARKER_KEY } from '../types/manifest';
import { telemetry } from '../services/telemetryService';
import type { TelemetryFeature } from '../services/telemetryPayload';
import { GETTING_STARTED_EXTERNAL_URLS } from '../types/gettingStarted';
import {
  chooseDbtCandidate,
  claimDbtFlow,
  identifyDbt,
  isDbtFlowStarting,
  releaseDbtFlow,
  takesLogFlags,
  type DbtCandidateDeps,
  type DbtFlowClaim,
  type DbtIdentity,
} from './dbtCandidate';
import { getDbtRunHost, type DbtRunHost } from './dbtRunHost';
import { isDbtRunActive, runDbtInTerminal, showDbtOutput } from './dbtTerminal';

export const DBT_NOT_FOUND_MESSAGE =
  'ERD Studio couldn\'t find dbt on this machine. Install it in the project\'s .venv, or install it elsewhere and restart VS Code, then try Run dbt parse again.';
export const DBT_INSTALL_ACTION = 'How to install dbt';
export const RUN_DBT_PARSE_ACTION = 'Run dbt parse';
export const NO_CREDS_ACTION = 'Parse without your credentials';
export const RUN_DBT_DEPS_ACTION = 'Run dbt deps';
export const ADAPTER_DOCS_ACTION = 'How to install an adapter';
export const PROFILE_DOCS_ACTION = 'How to set up a profile';
export const SHOW_OUTPUT_ACTION = 'Show output';
export const OPEN_PHYSICAL_ACTION = 'Open Physical view';
export const REPLACE_MANIFEST_ACTION = 'Replace';
export const DBT_DOCS_URLS = {
  // Checked 2026-11-05: the older /docs/core/connect-data-platform/… paths now redirect here.
  adapters: 'https://docs.getdbt.com/docs/local/connect-data-platform/about-dbt-connections',
  profiles: 'https://docs.getdbt.com/docs/local/profiles.yml',
} as const;

export const DBT_BUSY_MESSAGE = 'dbt is already running for this project. Its terminal shows how far it got.';
/** Busy before any dbt process exists: the dbt check, the adapter list or another step before the run. */
export const DBT_STARTING_MESSAGE =
  'ERD Studio is already starting dbt for this project. Wait for it, or finish the step it\'s asking about (such as the adapter list) first.';
export const DBT_CLOUD_CLI_MESSAGE =
  'The dbt on this machine is the dbt Cloud CLI. Run dbt parse needs dbt Core: install it with your adapter in the project\'s .venv (for example pip install dbt-core dbt-snowflake), then try again.';
export const NO_PROFILES_MESSAGE =
  'There\'s no dbt profile on this machine (profiles.yml), so dbt parse would stop. Parse without your credentials uses placeholder connection details instead: nothing connects to your warehouse.';
export const PARSE_OK_MESSAGE = 'dbt parse finished. The Physical view can now show your dbt models\' columns and tests.';
export const PARSE_OK_ON_PHYSICAL_MESSAGE = 'dbt parse finished. The Physical view now shows your dbt models\' columns and tests.';
export const PARSE_REFRESH_MESSAGE = 'dbt parse finished. Diagrams refreshed with the new manifest.';
export const PARSE_NO_CREDS_OK_MESSAGE =
  'dbt parsed your project without your credentials. The Physical view shows your models\' columns and tests; schema names are left out because they came from placeholder connection details.';
export const NO_CREDS_UNSUPPORTED_MESSAGE =
  'Parse without your credentials needs one of these dbt adapters installed with dbt: DuckDB, Postgres, Redshift, Snowflake, Databricks, BigQuery, Microsoft Fabric, SQL Server, Trino or Spark.';
export const DEPS_FAILED_MESSAGE = 'dbt deps failed. The output shows why; it needs a network connection to download packages.';

const ACTION_LABELS: Record<DbtFailureAction, string> = {
  noCreds: NO_CREDS_ACTION,
  deps: RUN_DBT_DEPS_ACTION,
  adapterDocs: ADAPTER_DOCS_ACTION,
  profileDocs: PROFILE_DOCS_ACTION,
  showOutput: SHOW_OUTPUT_ACTION,
};

/** The file access the flow uses (every read goes through here: the "never reads profiles.yml" rule is checked on it). */
export interface DbtParseFs {
  existsSync(p: string): boolean;
  isFile(p: string): boolean;
  /** The file's modification time, or undefined when it is missing. */
  mtimeMs(p: string): number | undefined;
  readTextStart(p: string, chars: number): Promise<string>;
  readdirSync(p: string): string[];
  readFileSync(p: string, enc: 'utf8'): string;
  mkdirSync(p: string, o: { recursive: true }): void;
  writeFileSync(p: string, d: string): void;
  renameSync(a: string, b: string): void;
  unlinkSync(p: string): void;
}

const defaultFs: DbtParseFs = {
  existsSync: (p) => fs.existsSync(p),
  isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
  mtimeMs: (p) => { try { return fs.statSync(p).mtimeMs; } catch { return undefined; } },
  readTextStart: (p, chars) => readTextStart(p, chars),
  readdirSync: (p) => fs.readdirSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  mkdirSync: (p, o) => { fs.mkdirSync(p, o); },
  writeFileSync: (p, d) => fs.writeFileSync(p, d),
  renameSync: (a, b) => fs.renameSync(a, b),
  unlinkSync: (p) => fs.unlinkSync(p),
};

export interface RunDbtParseOptions {
  /** The canvas that asked. */
  origin?: vscode.Uri;
}

export interface RunDbtParseDeps extends DbtCandidateDeps {
  identify?: (c: DbtCandidate, root: string) => Promise<DbtIdentity>;
  run?: typeof runDbtInTerminal;
  /** null = no host; undefined = `getDbtRunHost()`. */
  host?: DbtRunHost | null;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  fs?: Partial<DbtParseFs>;
}

export interface DbtParseStart {
  /** A dbt process was started (or handed to a terminal). */
  started: boolean;
  /** The follow-up after the run (and any run it leads to). Never rejects. */
  settled: Promise<void>;
}

const NOT_STARTED: DbtParseStart = { started: false, settled: Promise.resolve() };

/**
 * When Run dbt parse last actually launched dbt (ms since epoch), in memory
 * for this session only. Read by the manifest watcher to tell a manifest the
 * button produced (`manifestAfterParse`) from one that appeared some other
 * way (#113). Never persisted, never sent.
 */
let lastDbtParseLaunchAt: number | undefined;

/** The last Run dbt parse launch this session, or undefined. */
export function getLastDbtParseLaunchAt(): number | undefined {
  return lastDbtParseLaunchAt;
}

/** Test seam: forget the last launch. */
export function _resetDbtParseLaunchForTests(): void {
  lastDbtParseLaunchAt = undefined;
}

/** Our own code threw: count it (never dbt's failure) and log the error's name only. */
export function recordDbtRunFailure(err: unknown): void {
  telemetry.error('dbtRunFailed');
  const name = err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'unknown';
  log.warn(`[dbt] follow-up failed: ${name}`);
}

function openUrl(url: string): void {
  void vscode.env.openExternal(vscode.Uri.parse(url));
}

/**
 * B1: a dbt run is already going for the project (`running`: the runner said
 * so, or a run is registered), or a flow is still before its run (no dbt
 * process and no terminal yet). One telemetry key either way.
 */
export function showDbtBusy(root: string, key: TelemetryFeature = 'dbtParseBusy', running = isDbtRunActive(root)): void {
  telemetry.feature(key);
  if (running && isDbtRunActive(root)) showDbtOutput(root);
  void vscode.window.showInformationMessage(running ? DBT_BUSY_MESSAGE : DBT_STARTING_MESSAGE);
}

const NOTICE_LABELS: Record<DbtNoticeAction, string> = {
  tryAgain: TRY_AGAIN_BUTTON,
  sendFeedback: SEND_FEEDBACK_BUTTON,
  installDocs: DBT_INSTALL_ACTION,
  profileDocs: PROFILE_DOCS_ACTION,
};

/**
 * Show a `dbtRunMessages.ts` notice as an error, never awaited (see
 * `claimDbtFlow`): `run` gives Try Again and Send Feedback their action; an
 * action with none is left off.
 */
function showDbtNotice(notice: DbtNotice, run: Partial<Record<DbtNoticeAction, () => unknown>>): void {
  const all: Partial<Record<DbtNoticeAction, () => unknown>> = {
    installDocs: () => openUrl(GETTING_STARTED_EXTERNAL_URLS.dbtInstallDocs),
    profileDocs: () => openUrl(DBT_DOCS_URLS.profiles),
    ...run,
  };
  const actions: ErrorActions = Object.fromEntries(
    notice.actions.flatMap((a) => { const act = all[a]; return act ? [[NOTICE_LABELS[a], act]] : []; }),
  );
  showErrorWithActions((m, ...items) => vscode.window.showErrorMessage(m, ...items), notice.message, actions, (_choice, err) => recordDbtRunFailure(err));
}

export interface CouldNotStartContext {
  /** The dbt command that did not start, for Send Feedback's report. */
  kind: DbtCommandKind;
  /** Try Again: the command again from the click, so dbt is looked for again. */
  retry?: () => unknown;
  /** The placeholder profile folder, for a Parse without your credentials run (it can be what was refused). */
  profilesDir?: string;
  /** Test seam: the file is there. */
  isFile?: (p: string) => boolean;
}

/**
 * M3 (#296): the executable could not be started (`startError`, a code) or
 * quoted (`refused`). The words are `couldNotStartNotice`'s; never Show
 * output: a refused run has no terminal, and a start error's shows only the
 * code.
 */
export function showCouldNotStart(executable: string, root: string, startError: string | 'refused', ctx: CouldNotStartContext): void {
  const isFile = ctx.isFile ?? defaultFs.isFile;
  const notice = couldNotStartNotice(startError, {
    shown: displayPath(executable, root),
    executable,
    profilesDir: ctx.profilesDir,
    profilesDirShown: ctx.profilesDir === undefined ? undefined : displayPath(ctx.profilesDir, root),
    executableExists: startError === 'ENOENT' && isFile(executable),
  });
  const title = `Run dbt ${ctx.kind}`;
  showDbtNotice(notice, {
    tryAgain: ctx.retry,
    // The code only (never a path): the toast leaves it out, the report carries it.
    sendFeedback: () => vscode.commands.executeCommand(
      'erdStudio.reportBug',
      feedbackPrefill(title, 'while starting dbt', new Error(`dbt did not start (${startError})`)),
    ),
  });
}

/** Everything one Run dbt parse click carries through its runs. */
interface ParseFlow {
  root: string;
  origin?: vscode.Uri;
  chosen: DbtCandidate;
  identity: DbtIdentity;
  host: DbtRunHost | undefined;
  cfg: DbtProjectConfig;
  manifestPath: string;
  noCredsAvailable: boolean;
  /** Set once the placeholder profile is written. */
  profilesDir?: string;
  run: typeof runDbtInTerminal;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  fs: DbtParseFs;
  /** Run dbt parse again from the click (Try Again after dbt did not start). */
  again: () => Promise<unknown>;
}

/** What a Try Again after the placeholder profile was not saved carries over. */
interface NoCredsRetry {
  adapter: ThrowawayAdapter;
  /** The manifest's modification time when the first attempt checked it (undefined: there was none). */
  manifestMtime: number | undefined;
}

/**
 * Run `dbt parse` for `root`. Resolves once a run has started (or a step
 * before it ended); the follow-up after dbt exits is `settled`.
 */
export async function runDbtParse(root: string, opts: RunDbtParseOptions = {}, deps: RunDbtParseDeps = {}): Promise<DbtParseStart> {
  telemetry.feature('dbtParse'); // the click (#113 continuity)
  if (isDbtRunActive(root) || isDbtFlowStarting(root)) {
    showDbtBusy(root);
    return NOT_STARTED;
  }
  const claim = claimDbtFlow(root);
  if (!claim) {
    showDbtBusy(root);
    return NOT_STARTED;
  }
  try {
    return await parseFlow(root, opts, deps, claim);
  } catch (err) {
    recordDbtRunFailure(err);
    return NOT_STARTED;
  } finally {
    // A no-op when parseFlow already released it (and another click may hold the root now).
    releaseDbtFlow(claim);
  }
}

/** A non-modal notice whose only button opens the dbt install docs; never awaited (see `claimDbtFlow`). */
function showInstallNotice(show: typeof vscode.window.showInformationMessage, message: string): void {
  void show(message, DBT_INSTALL_ACTION).then((pick) => {
    if (pick === DBT_INSTALL_ACTION) openUrl(GETTING_STARTED_EXTERNAL_URLS.dbtInstallDocs);
  });
}

/**
 * The steps before the run, holding `claim`. A non-modal notification can
 * sit unanswered in the notification centre indefinitely, so none is awaited
 * while the claim is held: a later click would be told dbt is busy.
 */
async function parseFlow(root: string, opts: RunDbtParseOptions, deps: RunDbtParseDeps, claim: DbtFlowClaim): Promise<DbtParseStart> {
  const picked = await chooseDbtCandidate(root, 'parse', deps);
  if (picked === 'noDbt') {
    telemetry.feature('dbtParseNoDbt');
    showInstallNotice(vscode.window.showInformationMessage, DBT_NOT_FOUND_MESSAGE);
    return NOT_STARTED;
  }
  if (picked === 'declined') {
    telemetry.feature('dbtParseVenvDeclined');
    return NOT_STARTED;
  }

  // After the trust modal: identifying may run the candidate (`--version`).
  const identify = deps.identify ?? ((c: DbtCandidate, r: string) => identifyDbt(c, r, { env: deps.env, platform: deps.platform }));
  let chosen = picked.chosen;
  let identity = await identify(chosen, root);
  if (identity.flavour === 'cloud-cli') {
    let found = false;
    for (const next of picked.candidates.slice(picked.candidates.indexOf(chosen) + 1)) {
      if (isUntrustedProjectExecutable(next)) continue;
      const id = await identify(next, root);
      if (id.flavour !== 'cloud-cli') {
        chosen = next;
        identity = id;
        found = true;
        break;
      }
    }
    if (!found) {
      telemetry.feature('dbtParseCloudCli');
      showInstallNotice(vscode.window.showWarningMessage, DBT_CLOUD_CLI_MESSAGE);
      return NOT_STARTED;
    }
  }

  const host = deps.host === undefined ? getDbtRunHost() : (deps.host ?? undefined);
  const cfg = host?.dbtConfig() ?? defaultDbtProjectConfig();
  const flow: ParseFlow = {
    root,
    origin: opts.origin,
    chosen,
    identity,
    host,
    cfg,
    manifestPath: resolveManifestPath(root, cfg),
    noCredsAvailable: false,
    run: deps.run ?? runDbtInTerminal,
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    homeDir: deps.homeDir ?? os.homedir(),
    fs: { ...defaultFs, ...deps.fs },
    again: () => runDbtParse(root, opts, deps),
  };
  // Only when a supported adapter is installed: otherwise the offer would end at "needs one of these adapters".
  flow.noCredsAvailable = !!host && identity.flavour === 'core-v1'
    && chooseThrowawayAdapter(identity.adapters, { manifest: null, files: await adapterFileHints(flow) }).kind !== 'none';

  // No profiles.yml anywhere: the normal run is certain to fail, so offer the route that works first.
  const profileFound = profilesYmlWouldBeFound(root, { env: flow.env, homeDir: flow.homeDir, isFile: (p) => flow.fs.isFile(p) });
  if (!profileFound && flow.noCredsAvailable) {
    telemetry.feature('dbtParseNoProfiles');
    // The notice can wait unanswered: let go of the project first. The run it leads to claims it again.
    releaseDbtFlow(claim);
    const pick = await vscode.window.showInformationMessage(NO_PROFILES_MESSAGE, NO_CREDS_ACTION, PROFILE_DOCS_ACTION);
    if (pick === NO_CREDS_ACTION) return followUp(flow, () => parseWithoutCredentials(flow));
    if (pick === PROFILE_DOCS_ACTION) openUrl(DBT_DOCS_URLS.profiles);
    return NOT_STARTED;
  }

  return launchParse(flow, 'normal');
}

/** Start `dbt parse` in `mode` for `flow`; the follow-up is `settled`. */
function launchParse(flow: ParseFlow, mode: DbtRunMode): DbtParseStart {
  const plan = planDbtSpawn(flow.chosen, 'parse', mode, {
    root: flow.root, profilesDir: flow.profilesDir, env: flow.env, platform: flow.platform, logFlags: takesLogFlags(flow.identity),
  });
  if ('refused' in plan) {
    telemetry.feature('dbtParseNoStart');
    showCouldNotStart(flow.chosen.executable, flow.root, 'refused', {
      kind: 'parse', retry: flow.again, profilesDir: mode === 'noCreds' ? flow.profilesDir : undefined,
    });
    return NOT_STARTED;
  }
  // The manifest's modification time before the run: a success must leave a new one, not the old file.
  const before = flow.fs.mtimeMs(flow.manifestPath);
  const hadManifest = before !== undefined;
  const start = flow.run(flow.root, 'parse', mode, plan);
  if (start.kind === 'busy') {
    showDbtBusy(flow.root, 'dbtParseBusy', true);
    return NOT_STARTED;
  }
  telemetry.feature('dbtParseLaunched');
  if (hadManifest) telemetry.feature('dbtParseRefresh');
  lastDbtParseLaunchAt = Date.now();
  const result = vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'dbt parse' },
    () => start.run.result,
  );
  const settled = Promise.resolve(result)
    .then((r) => handleParseResult(flow, mode, before, r))
    .catch(recordDbtRunFailure);
  return { started: true, settled };
}

async function handleParseResult(flow: ParseFlow, mode: DbtRunMode, before: number | undefined, r: DbtProcessResult): Promise<void> {
  const hadManifest = before !== undefined;
  if (r.outcome === 'notStarted') {
    telemetry.feature('dbtParseNoStart');
    showCouldNotStart(flow.chosen.executable, flow.root, r.startError ?? 'unknown', {
      kind: 'parse', retry: flow.again, isFile: (p) => flow.fs.isFile(p),
    });
    return;
  }
  if (r.outcome === 'stopped') {
    telemetry.feature('dbtParseStopped');
    return;
  }
  if (r.exitCode === 0) {
    log.info('[dbt] parse exited 0');
    telemetry.feature('dbtParseExitOk');
    if (mode === 'noCreds') telemetry.feature('dbtParseNoCredsOk');
    // dbt rewrites manifest.json on every successful parse; one left unchanged means dbt wrote somewhere else.
    const after = flow.fs.mtimeMs(flow.manifestPath);
    if (after === undefined || after === before) {
      telemetry.feature('dbtParseOkNoManifest');
      const pick = await vscode.window.showWarningMessage(
        `dbt parse finished, but there's no manifest at ${manifestDisplayPath(flow.root, flow.cfg)}. ` +
          'Check target-path in dbt_project.yml and the DBT_TARGET_PATH environment variable.',
        SHOW_OUTPUT_ACTION,
      );
      if (pick === SHOW_OUTPUT_ACTION) {
        telemetry.feature('dbtParseShowOutput');
        showDbtOutput(flow.root);
      }
      return;
    }
    await offerPhysical(flow, mode === 'noCreds'
      ? PARSE_NO_CREDS_OK_MESSAGE
      : hadManifest
        ? PARSE_REFRESH_MESSAGE
        : flow.host?.originIsPhysical(flow.origin) ? PARSE_OK_ON_PHYSICAL_MESSAGE : PARSE_OK_MESSAGE);
    return;
  }

  // Exited with a failure code, or ended by a signal (no exit code).
  const category = classifyDbtFailure(r.tail);
  log.info(`[dbt] parse exited ${r.exitCode === null ? 'without an exit code' : r.exitCode}`);
  log.info(`[dbt] parse failed: ${category}`);
  telemetry.feature('dbtParseExitFail');
  telemetry.feature(DBT_PARSE_FAILURE_FEATURES[category]);
  if (mode === 'noCreds') telemetry.feature('dbtParseNoCredsFail');

  const envVar = missingEnvVarName(r.tail);
  // In the project's files: dbt got past the profile (so a placeholder profile can't help), or a project file dbt renders first uses it.
  let envVarInProject = category === 'envVar' && envVarFailedAfterAdapterLoad(r.tail);
  if (envVar && !envVarInProject) {
    envVarInProject = ENV_VAR_PROJECT_FILES.some((f) => {
      try {
        return envVarUsedInProjectFile(flow.fs.readFileSync(path.join(flow.root, f), 'utf8'), envVar);
      } catch {
        return false; // no such file: not used there
      }
    });
  }
  const notice = failureNotice(category, {
    command: 'parse',
    mode,
    exitCode: r.exitCode,
    noCredsAvailable: flow.noCredsAvailable && mode === 'normal',
    envVar,
    envVarInProject,
    profileUnreadable: profileUnreadable(r.tail),
    adapterType: missingAdapterType(r.tail),
  });
  const pick = await vscode.window.showWarningMessage(notice.message, ...notice.actions.map((a) => ACTION_LABELS[a]));
  const action = notice.actions.find((a) => ACTION_LABELS[a] === pick);
  switch (action) {
    case 'noCreds':
      await (await followUp(flow, () => parseWithoutCredentials(flow))).settled;
      return;
    case 'deps':
      telemetry.feature('dbtParseDeps');
      await (await followUp(flow, async () => runDbtDeps({
        root: flow.root, chosen: flow.chosen, mode, profilesDir: flow.profilesDir,
        run: flow.run, env: flow.env, platform: flow.platform, logFlags: takesLogFlags(flow.identity),
        stoppedKey: 'dbtParseStopped', noStartKey: 'dbtParseNoStart', busyKey: 'dbtParseBusy',
        retry: flow.again,
        then: async () => { await launchParse(flow, mode).settled; },
      }))).settled;
      return;
    case 'adapterDocs':
      telemetry.feature('dbtParseAdapterDocs');
      openUrl(DBT_DOCS_URLS.adapters);
      return;
    case 'profileDocs':
      openUrl(DBT_DOCS_URLS.profiles);
      return;
    case 'showOutput':
      telemetry.feature('dbtParseShowOutput');
      showDbtOutput(flow.root);
      return;
    default:
      return;
  }
}

/** A success notice, with Open Physical view when there is a logical canvas to switch. */
async function offerPhysical(flow: ParseFlow, message: string): Promise<void> {
  const target = flow.host?.physicalTarget(flow.origin);
  const pick = target
    ? await vscode.window.showInformationMessage(message, OPEN_PHYSICAL_ACTION)
    : await vscode.window.showInformationMessage(message);
  if (target && pick === OPEN_PHYSICAL_ACTION && flow.host) {
    // Counted only when a canvas switched (the one named may have closed while the notice waited).
    if (await flow.host.openPhysical(target)) telemetry.feature('dbtParseOpenPhysical');
  }
}

/**
 * A run a failure notice offered (Parse without your credentials, Run dbt
 * deps): its pre-run steps hold the project like a click does, so a click
 * meanwhile is told dbt is busy.
 */
async function followUp(flow: ParseFlow, start: () => Promise<DbtParseStart>): Promise<DbtParseStart> {
  const claim = isDbtRunActive(flow.root) ? null : claimDbtFlow(flow.root);
  if (!claim) {
    showDbtBusy(flow.root);
    return NOT_STARTED;
  }
  try {
    return await start();
  } finally {
    releaseDbtFlow(claim);
  }
}

/**
 * Parse without your credentials: a placeholder profiles.yml for the
 * project's adapter in ERD Studio's own storage, then `dbt parse` with it.
 * `retry` is the Try Again after the profile was not saved (#296): the
 * adapter already picked, and no second Replace question unless the
 * manifest changed since the user answered the first.
 */
async function parseWithoutCredentials(flow: ParseFlow, retry?: NoCredsRetry): Promise<DbtParseStart> {
  const host = flow.host;
  if (!host) return NOT_STARTED;
  if (!retry) telemetry.feature('dbtParseNoCreds');

  // A manifest written with a real profile (the user's, or committed / copied from CI) is replaced only if they agree.
  let manifestStart: string | null = null;
  const manifestMtime = flow.fs.mtimeMs(flow.manifestPath);
  if (flow.fs.existsSync(flow.manifestPath)) {
    try { manifestStart = await flow.fs.readTextStart(flow.manifestPath, 16 * 1024); } catch { manifestStart = null; }
    const agreedAlready = retry !== undefined && retry.manifestMtime !== undefined && retry.manifestMtime === manifestMtime;
    if (!agreedAlready && (!manifestStart || !manifestStart.includes(`"${THROWAWAY_MARKER_KEY}"`))) {
      const shown = manifestDisplayPath(flow.root, flow.cfg);
      const pick = await vscode.window.showWarningMessage(
        `Replace ${shown}?`,
        {
          modal: true,
          detail: 'dbt wrote it with a real dbt profile. Parsing without your credentials replaces it, and schema names are left out until dbt parses with a real profile again.',
        },
        REPLACE_MANIFEST_ACTION,
      );
      if (pick !== REPLACE_MANIFEST_ACTION) return NOT_STARTED;
    }
  }

  const adapter = retry?.adapter ?? await pickAdapter(flow, manifestStart);
  if (!adapter) return NOT_STARTED;
  if (!retry) telemetry.feature(NO_CREDS_ADAPTER_FEATURES[adapter]);

  const dir = path.join(host.storageDir, THROWAWAY_PROFILE_DIR_NAME, adapter);
  const tmp = path.join(dir, `profiles.yml.${process.pid}.${Date.now()}.tmp`);
  try {
    flow.fs.mkdirSync(dir, { recursive: true });
    flow.fs.writeFileSync(tmp, throwawayProfileYaml(adapter));
    // The content per adapter folder is always the same, so two windows writing at once cannot leave a wrong profile.
    flow.fs.renameSync(tmp, path.join(dir, 'profiles.yml'));
  } catch (err) {
    telemetry.error('dbtProfileWriteFailed');
    const code = (err as NodeJS.ErrnoException)?.code;
    log.warn(`[dbt] placeholder profile not written: ${typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown'}`);
    try { flow.fs.unlinkSync(tmp); } catch { /* not there */ }
    const again: NoCredsRetry = { adapter, manifestMtime };
    showDbtNotice(profileWriteNotice(err, { folderShown: displayPath(dir, flow.root, flow.homeDir), platform: flow.platform }), {
      // Through `followUp`: the project was let go when this attempt ended, so the retry claims it again.
      tryAgain: () => followUp(flow, () => parseWithoutCredentials(flow, again)),
      sendFeedback: () => vscode.commands.executeCommand(
        'erdStudio.reportBug',
        feedbackPrefill('Parse without your credentials', 'while saving its placeholder dbt profile', err),
      ),
    });
    return NOT_STARTED;
  }
  flow.profilesDir = dir;
  return launchParse(flow, 'noCreds');
}

/** Adapters the project's requirements-style files name (never a profiles.yml). */
async function adapterFileHints(flow: ParseFlow): Promise<ThrowawayAdapter[]> {
  const files: ThrowawayAdapter[] = [];
  const candidates = REQUIREMENTS_FILES.map((f) => path.join(flow.root, f));
  try {
    const reqDir = path.join(flow.root, 'requirements');
    for (const f of flow.fs.readdirSync(reqDir)) {
      if (f.toLowerCase().endsWith('.txt')) candidates.push(path.join(reqDir, f));
    }
  } catch { /* no requirements/ folder */ }
  for (const file of candidates) {
    if (path.basename(file).toLowerCase() === 'profiles.yml') continue; // never, even by accident
    try {
      for (const a of adapterHintsFromText(await flow.fs.readTextStart(file, 256 * 1024))) {
        if (!files.includes(a)) files.push(a);
      }
    } catch { /* missing: skipped */ }
  }
  return files;
}

/** The placeholder adapter: from what is installed with dbt and the project's non-secret files; asks when it can't tell. */
async function pickAdapter(flow: ParseFlow, manifestStart: string | null): Promise<ThrowawayAdapter | undefined> {
  const files = await adapterFileHints(flow);
  // A placeholder manifest's adapter_type is only the last placeholder pick, not evidence about the project.
  const fromUserProfile = !!manifestStart && !manifestStart.includes(`"${THROWAWAY_MARKER_KEY}"`);
  const choice = chooseThrowawayAdapter(flow.identity.adapters, {
    manifest: fromUserProfile && manifestStart ? adapterTypeFromManifestStart(manifestStart) : null,
    files,
  });
  if (choice.kind === 'one') return choice.adapter;
  if (choice.kind === 'ask') {
    telemetry.feature('dbtParseNoCredsAsked');
    const picked = await vscode.window.showQuickPick(
      choice.options.map((a) => ({ label: ADAPTER_LABELS[a], description: `dbt-${a}`, adapter: a })),
      { placeHolder: 'Pick the dbt adapter this project uses', ignoreFocusOut: true },
    );
    return picked?.adapter;
  }
  telemetry.feature('dbtParseNoCredsUnsupported');
  void vscode.window.showWarningMessage(NO_CREDS_UNSUPPORTED_MESSAGE, ADAPTER_DOCS_ACTION).then((pick) => {
    if (pick === ADAPTER_DOCS_ACTION) {
      telemetry.feature('dbtParseAdapterDocs');
      openUrl(DBT_DOCS_URLS.adapters);
    }
  });
  return undefined;
}

export interface DepsRun {
  root: string;
  chosen: DbtCandidate;
  mode: DbtRunMode;
  profilesDir?: string;
  run: typeof runDbtInTerminal;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The dbt takes `LOG_ARGS` (dbtLaunch.ts). */
  logFlags?: boolean;
  stoppedKey: TelemetryFeature;
  noStartKey: TelemetryFeature;
  busyKey: TelemetryFeature;
  /** Try Again when dbt deps did not start: the command that offered it, from its click. */
  retry?: () => unknown;
  /** Runs after `dbt deps` exits 0 (parse or compile again, with the same dbt and no new prompt). */
  then: () => Promise<void>;
}

/** **Run dbt deps**, then the command that needed it again. */
export async function runDbtDeps(d: DepsRun): Promise<DbtParseStart> {
  const plan = planDbtSpawn(d.chosen, 'deps', d.mode, { root: d.root, env: d.env, platform: d.platform, logFlags: d.logFlags });
  if ('refused' in plan) {
    telemetry.feature(d.noStartKey);
    showCouldNotStart(d.chosen.executable, d.root, 'refused', { kind: 'deps', retry: d.retry });
    return NOT_STARTED;
  }
  const start = d.run(d.root, 'deps', d.mode, plan);
  if (start.kind === 'busy') {
    showDbtBusy(d.root, d.busyKey, true);
    return NOT_STARTED;
  }
  const result = vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'dbt deps' },
    () => start.run.result,
  );
  const settled = Promise.resolve(result).then(async (r) => {
    if (r.outcome === 'notStarted') {
      telemetry.feature(d.noStartKey);
      showCouldNotStart(d.chosen.executable, d.root, r.startError ?? 'unknown', { kind: 'deps', retry: d.retry });
      return;
    }
    if (r.outcome === 'stopped') {
      telemetry.feature(d.stoppedKey);
      return;
    }
    if (r.exitCode === 0) {
      log.info('[dbt] deps exited 0');
      telemetry.feature('dbtDepsExitOk');
      await d.then();
      return;
    }
    log.info(`[dbt] deps exited ${r.exitCode === null ? 'without an exit code' : r.exitCode}`);
    telemetry.feature('dbtDepsExitFail');
    const pick = await vscode.window.showWarningMessage(DEPS_FAILED_MESSAGE, SHOW_OUTPUT_ACTION);
    if (pick === SHOW_OUTPUT_ACTION) showDbtOutput(d.root);
  }).catch(recordDbtRunFailure);
  return { started: true, settled };
}
