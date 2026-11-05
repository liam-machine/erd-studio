/**
 * **Run dbt compile** (the canvas's `runDbtCompile` message). The same runner
 * and the same candidate, trust and untrusted-workspace rules as Run dbt
 * parse (`dbtCandidate.ts`, `dbtTerminal.ts`): the candidate's own dbt
 * executable in a pseudoterminal, never an activate line typed into a shell.
 * It has no Parse without your credentials offer (compile needs the
 * warehouse) and no flavour probe. The manifest watcher refreshes the canvas.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type { DbtCandidate } from '../services/dbtEnv';
import {
  classifyDbtFailure,
  envVarFailedAfterAdapterLoad,
  envVarUsedInProjectFile,
  failureNotice,
  missingAdapterType,
  missingEnvVarName,
  type DbtFailureAction,
} from '../services/dbtFailure';
import { planDbtSpawn } from '../services/dbtLaunch';
import type { DbtProcessResult } from '../services/dbtProcess';
import { log } from '../services/logger';
import { telemetry } from '../services/telemetryService';
import { GETTING_STARTED_EXTERNAL_URLS } from '../types/gettingStarted';
import { chooseDbtCandidate, claimDbtFlow, isDbtFlowStarting, releaseDbtFlow, type DbtCandidateDeps } from './dbtCandidate';
import { isDbtRunActive, runDbtInTerminal, showDbtOutput } from './dbtTerminal';
import {
  ADAPTER_DOCS_ACTION,
  DBT_DOCS_URLS,
  DBT_INSTALL_ACTION,
  PROFILE_DOCS_ACTION,
  recordDbtRunFailure,
  RUN_DBT_DEPS_ACTION,
  runDbtDeps,
  SHOW_OUTPUT_ACTION,
  showCouldNotStart,
  showDbtBusy,
  type DbtParseStart,
} from './runDbtParse';

export const DBT_COMPILE_NOT_FOUND_MESSAGE =
  'ERD Studio couldn\'t find dbt on this machine. Install it in the project\'s .venv, or install it elsewhere and restart VS Code, then try Run dbt compile again.';
export const COMPILE_OK_MESSAGE = 'dbt compile finished. Diagrams refreshed with the new manifest.';

const LABELS: Record<Exclude<DbtFailureAction, 'noCreds'>, string> = {
  deps: RUN_DBT_DEPS_ACTION,
  adapterDocs: ADAPTER_DOCS_ACTION,
  profileDocs: PROFILE_DOCS_ACTION,
  showOutput: SHOW_OUTPUT_ACTION,
};

export interface RunDbtCompileDeps extends DbtCandidateDeps {
  run?: typeof runDbtInTerminal;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test seam: dbt_project.yml's text (for an env var the project uses). */
  readProjectFile?: (root: string) => string;
}

interface CompileFlow {
  root: string;
  chosen: DbtCandidate;
  run: typeof runDbtInTerminal;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  readProjectFile: (root: string) => string;
}

const NOT_STARTED: DbtParseStart = { started: false, settled: Promise.resolve() };

/** Run `dbt compile` for `root`. Resolves once it started (or a step before it ended). */
export async function runDbtCompile(root: string, deps: RunDbtCompileDeps = {}): Promise<DbtParseStart> {
  // The click (`dbtCompile`) is recorded by the provider.
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
    const picked = await chooseDbtCandidate(root, 'compile', deps);
    if (picked === 'noDbt') {
      telemetry.feature('dbtCompileNoDbt');
      // Never awaited while the project is claimed: an unanswered notice would make every later click "busy".
      void vscode.window.showInformationMessage(DBT_COMPILE_NOT_FOUND_MESSAGE, DBT_INSTALL_ACTION).then((pick) => {
        if (pick === DBT_INSTALL_ACTION) void vscode.env.openExternal(vscode.Uri.parse(GETTING_STARTED_EXTERNAL_URLS.dbtInstallDocs));
      });
      return NOT_STARTED;
    }
    if (picked === 'declined') {
      telemetry.feature('dbtCompileVenvDeclined');
      return NOT_STARTED;
    }
    return launchCompile({
      root,
      chosen: picked.chosen,
      run: deps.run ?? runDbtInTerminal,
      env: deps.env ?? process.env,
      platform: deps.platform ?? process.platform,
      readProjectFile: deps.readProjectFile ?? ((r) => fs.readFileSync(path.join(r, 'dbt_project.yml'), 'utf8')),
    });
  } catch (err) {
    recordDbtRunFailure(err);
    return NOT_STARTED;
  } finally {
    releaseDbtFlow(claim);
  }
}

function launchCompile(flow: CompileFlow): DbtParseStart {
  const plan = planDbtSpawn(flow.chosen, 'compile', 'normal', { root: flow.root, env: flow.env, platform: flow.platform });
  if ('refused' in plan) {
    telemetry.feature('dbtCompileNoStart');
    showCouldNotStart(flow.chosen.executable, flow.root, 'refused');
    return NOT_STARTED;
  }
  const start = flow.run(flow.root, 'compile', 'normal', plan);
  if (start.kind === 'busy') {
    showDbtBusy(flow.root);
    return NOT_STARTED;
  }
  telemetry.feature('dbtCompileLaunched');
  const result = vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'dbt compile' },
    () => start.run.result,
  );
  const settled = Promise.resolve(result).then((r) => handleCompileResult(flow, r)).catch(recordDbtRunFailure);
  return { started: true, settled };
}

async function handleCompileResult(flow: CompileFlow, r: DbtProcessResult): Promise<void> {
  if (r.outcome === 'notStarted') {
    telemetry.feature('dbtCompileNoStart');
    showCouldNotStart(flow.chosen.executable, flow.root, r.startError ?? 'unknown');
    return;
  }
  if (r.outcome === 'stopped') {
    telemetry.feature('dbtCompileStopped');
    return;
  }
  if (r.exitCode === 0) {
    log.info('[dbt] compile exited 0');
    telemetry.feature('dbtCompileExitOk');
    void vscode.window.showInformationMessage(COMPILE_OK_MESSAGE);
    return;
  }
  const category = classifyDbtFailure(r.tail);
  log.info(`[dbt] compile exited ${r.exitCode === null ? 'without an exit code' : r.exitCode}`);
  log.info(`[dbt] compile failed: ${category}`);
  telemetry.feature('dbtCompileExitFail');
  const envVar = missingEnvVarName(r.tail);
  // In the project's files: dbt got past the profile, or dbt_project.yml uses it.
  let envVarInProject = category === 'envVar' && envVarFailedAfterAdapterLoad(r.tail);
  if (envVar && !envVarInProject) {
    try { envVarInProject = envVarUsedInProjectFile(flow.readProjectFile(flow.root), envVar); } catch { /* none */ }
  }
  const notice = failureNotice(category, {
    command: 'compile', mode: 'normal', exitCode: r.exitCode, noCredsAvailable: false,
    envVar, envVarInProject, adapterType: missingAdapterType(r.tail),
  });
  const actions = notice.actions.filter((a): a is Exclude<DbtFailureAction, 'noCreds'> => a !== 'noCreds');
  const pick = await vscode.window.showWarningMessage(notice.message, ...actions.map((a) => LABELS[a]));
  const action = actions.find((a) => LABELS[a] === pick);
  switch (action) {
    case 'deps': {
      if (isDbtRunActive(flow.root) || isDbtFlowStarting(flow.root)) { showDbtBusy(flow.root); return; }
      const deps = await runDbtDeps({
        root: flow.root, chosen: flow.chosen, mode: 'normal', run: flow.run, env: flow.env, platform: flow.platform,
        stoppedKey: 'dbtCompileStopped', noStartKey: 'dbtCompileNoStart', busyKey: 'dbtParseBusy',
        then: async () => { await launchCompile(flow).settled; },
      });
      await deps.settled;
      return;
    }
    case 'adapterDocs':
      void vscode.env.openExternal(vscode.Uri.parse(DBT_DOCS_URLS.adapters));
      return;
    case 'profileDocs':
      void vscode.env.openExternal(vscode.Uri.parse(DBT_DOCS_URLS.profiles));
      return;
    case 'showOutput':
      showDbtOutput(flow.root);
      return;
    default:
      return;
  }
}
