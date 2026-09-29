/**
 * **Run dbt parse** — writes `{target-path}/manifest.json` without touching
 * the warehouse (it still needs a working profile), which is what the
 * physical stage needs to read columns and tests on a fresh clone. Offered
 * by the physical stage's notice (`runDbtParse` message) and by the
 * "manifest missing" notifications in extension.ts.
 *
 * It runs in a visible VS Code terminal in the dbt project root. The canvas
 * refreshes itself: FileWatcherService fires `onManifestChanged` when
 * manifest.json appears, and activation refreshes every open domain on it.
 *
 * Finding dbt reuses `dbtExecutableCandidates()` (the CLI's `doctor` list)
 * and follows its trust rule: a dbt inside a project-local venv that is not
 * also the `dbt` on `PATH` is never run without asking — a cloned repo can
 * ship any `.venv/bin/activate` — and never in an untrusted workspace.
 */

import * as vscode from 'vscode';

import {
  dbtExecutableCandidates,
  displayPath,
  findVenvActivate,
  isUntrustedProjectExecutable,
  type DbtCandidate,
} from '../services/dbtEnv';
import { telemetry } from '../services/telemetryService';
import { GETTING_STARTED_EXTERNAL_URLS } from '../types/gettingStarted';

export const DBT_NOT_FOUND_MESSAGE =
  'ERD Studio couldn\'t find dbt on this machine. Install dbt (or activate the environment it is in), then try Run dbt parse again.';
export const DBT_INSTALL_ACTION = 'How to install dbt';
export const RUN_DBT_PARSE_ACTION = 'Run dbt parse';
const USE_VENV = 'Use the project\'s dbt';
const USE_OTHER = 'Use my dbt';

export interface RunDbtParseDeps {
  /** Test seam: the dbt candidates, most specific first. */
  candidates?: (root: string) => DbtCandidate[];
  /** Test seam: the venv activate command, or null. */
  venvActivate?: (root: string) => string | null;
  /** Test seam: whether the workspace is trusted. */
  isTrusted?: () => boolean;
}

/** What the terminal runs: typed into a shell, or dbt as the terminal's own process. */
export type DbtParseLaunch =
  | { kind: 'text'; text: string }
  | { kind: 'process'; shellPath: string; shellArgs: string[] };

/** How to run `dbt parse` with `candidate` (pure). */
export function dbtParseLaunch(candidate: DbtCandidate, activate: string | null): DbtParseLaunch {
  if (candidate.source === 'path' || candidate.onPath === true) {
    return { kind: 'text', text: 'dbt parse' };
  }
  if (candidate.source === 'venv' && activate) {
    // Same line the "Run dbt compile" button types.
    return { kind: 'text', text: `${activate} && dbt parse` };
  }
  // An absolute executable (activated env, pyenv shim, pipx) runs as the
  // terminal's process, so no shell has to parse or quote its path.
  return { kind: 'process', shellPath: candidate.executable, shellArgs: ['parse'] };
}

/**
 * When Run dbt parse last actually opened its terminal (ms since epoch), in
 * memory for this session only. Read by the manifest watcher to tell a
 * manifest the button produced (`manifestAfterParse`) from one that appeared
 * some other way (#113). Never persisted, never sent.
 */
let lastDbtParseLaunchAt: number | undefined;

/** The last Run dbt parse terminal launch this session, or undefined. */
export function getLastDbtParseLaunchAt(): number | undefined {
  return lastDbtParseLaunchAt;
}

/** Test seam: forget the last launch. */
export function _resetDbtParseLaunchForTests(): void {
  lastDbtParseLaunchAt = undefined;
}

/**
 * Run `dbt parse` in a terminal in `root`. Resolves false when dbt was not
 * found, or the user declined the venv prompt; true once the terminal runs.
 */
export async function runDbtParse(root: string, deps: RunDbtParseDeps = {}): Promise<boolean> {
  telemetry.feature('dbtParse');
  const trusted = (deps.isTrusted ?? (() => vscode.workspace.isTrusted !== false))();
  const all = (deps.candidates ?? ((r) => dbtExecutableCandidates(r)))(root);
  // An untrusted workspace never runs anything the project itself ships.
  const candidates = trusted ? all : all.filter((c) => c.source !== 'venv');

  let chosen = candidates[0];
  if (!chosen) {
    const pick = await vscode.window.showInformationMessage(DBT_NOT_FOUND_MESSAGE, DBT_INSTALL_ACTION);
    if (pick === DBT_INSTALL_ACTION) {
      await vscode.env.openExternal(vscode.Uri.parse(GETTING_STARTED_EXTERNAL_URLS.dbtInstallDocs));
    }
    return false;
  }

  if (isUntrustedProjectExecutable(chosen)) {
    const other = candidates.find((c) => !isUntrustedProjectExecutable(c));
    const buttons = other ? [USE_VENV, USE_OTHER] : [USE_VENV];
    const choice = await vscode.window.showWarningMessage(
      'Run dbt parse with the dbt inside this project?',
      {
        modal: true,
        detail: `This project has its own dbt at ${displayPath(chosen.executable, root)}. ` +
          'Only use it if you trust where this project came from.' +
          (other ? ` "${USE_OTHER}" runs ${displayPath(other.executable, root)} instead.` : ''),
      },
      ...buttons,
    );
    if (choice === USE_OTHER && other) {
      chosen = other;
    } else if (choice !== USE_VENV) {
      return false;
    }
  }

  const activate = chosen.source === 'venv' ? (deps.venvActivate ?? ((r) => findVenvActivate(r)))(root) : null;
  const launch = dbtParseLaunch(chosen, activate);
  if (launch.kind === 'text') {
    const terminal = vscode.window.createTerminal({ name: 'dbt parse', cwd: root });
    terminal.show();
    terminal.sendText(launch.text);
  } else {
    const terminal = vscode.window.createTerminal({
      name: 'dbt parse', cwd: root, shellPath: launch.shellPath, shellArgs: launch.shellArgs,
    });
    terminal.show();
  }
  lastDbtParseLaunchAt = Date.now();
  return true;
}
