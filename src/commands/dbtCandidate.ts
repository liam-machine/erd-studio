/**
 * Which dbt Run dbt parse and Run dbt compile use, shared by both buttons.
 *
 * Finding dbt reuses `dbtExecutableCandidates()` (the CLI's `doctor` list)
 * and follows its trust rule: a dbt inside a project-local venv that is not
 * also the `dbt` on `PATH` is never run without asking — a cloned repo can
 * ship any `.venv/bin/dbt` — and never in an untrusted workspace.
 *
 * Also: which flavour that dbt is (dbt Core by stat where possible, else
 * `dbt --version`, cached per executable and modification time), and the
 * per-project in-flight guard that keeps a double click from starting two
 * flows (two trust modals, two notifications).
 */

import * as fs from 'fs';
import * as vscode from 'vscode';

import { coreInstallOf, pluginsFromVersionOutput } from '../services/dbtAdapters';
import {
  classifyDbtVersion,
  dbtExecutableCandidates,
  displayPath,
  isUntrustedProjectExecutable,
  runDbtVersion,
  type DbtCandidate,
  type DbtFlavour,
  type DbtVersionRun,
} from '../services/dbtEnv';
import { childEnv } from '../services/dbtLaunch';
import { pathKey } from '../services/pathKey';

export const USE_VENV = 'Use the project\'s dbt';
export const USE_OTHER = 'Use my dbt';

/** The trust modal's title for `kind`. */
export function trustModalTitle(kind: 'parse' | 'compile'): string {
  return `Run dbt ${kind} with the dbt inside this project?`;
}

export interface DbtCandidateDeps {
  /** Test seam: the dbt candidates, most specific first. */
  candidates?: (root: string) => DbtCandidate[];
  /** Test seam: whether the workspace is trusted. */
  isTrusted?: () => boolean;
}

export interface ChosenDbt {
  chosen: DbtCandidate;
  /** Every candidate the workspace may run, in order (for the Cloud CLI fallback). */
  candidates: DbtCandidate[];
}

/**
 * The dbt to run, after the trust modal when the first candidate is a
 * project venv the shell would not run: `noDbt` when there is none,
 * `declined` when the modal was dismissed.
 */
export async function chooseDbtCandidate(
  root: string,
  kind: 'parse' | 'compile',
  deps: DbtCandidateDeps = {},
): Promise<ChosenDbt | 'noDbt' | 'declined'> {
  const trusted = (deps.isTrusted ?? (() => vscode.workspace.isTrusted !== false))();
  const all = (deps.candidates ?? ((r) => dbtExecutableCandidates(r)))(root);
  // An untrusted workspace never runs anything the project itself ships.
  const candidates = trusted ? all : all.filter((c) => c.source !== 'venv');

  let chosen = candidates[0];
  if (!chosen) return 'noDbt';

  if (isUntrustedProjectExecutable(chosen)) {
    const other = candidates.find((c) => !isUntrustedProjectExecutable(c));
    const buttons = other ? [USE_VENV, USE_OTHER] : [USE_VENV];
    const choice = await vscode.window.showWarningMessage(
      trustModalTitle(kind),
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
      return 'declined';
    }
  }
  return { chosen, candidates };
}

export interface DbtIdentity {
  flavour: DbtFlavour;
  adapters: string[];
  via: 'stat' | 'version';
}

export interface IdentifyDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Test seam: `dbt --version`. */
  runVersion?: (executable: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<DbtVersionRun>;
  /** Test seam: the executable's modification time, or undefined (no cache). */
  mtimeMs?: (executable: string) => number | undefined;
}

/** `dbt --version` results, per `executable:mtimeMs`, for the session. */
const versionCache = new Map<string, DbtIdentity>();

export function _resetDbtIdentityCacheForTests(): void {
  versionCache.clear();
}

/**
 * Which dbt `candidate` is. dbt Core by stat first (`coreInstallOf`, a handful
 * of stats, redone every call so an adapter installed mid-session shows up);
 * otherwise `dbt --version` (in the run's own environment), cached per
 * executable and modification time so a reinstalled dbt is probed again.
 */
export async function identifyDbt(candidate: DbtCandidate, root: string, deps: IdentifyDeps = {}): Promise<DbtIdentity> {
  const platform = deps.platform ?? process.platform;
  const core = coreInstallOf(candidate.executable, platform);
  if (core) return { flavour: 'core-v1', adapters: core.adapters, via: 'stat' };

  const mtime = (deps.mtimeMs ?? ((exe: string) => {
    try { return fs.statSync(exe).mtimeMs; } catch { return undefined; }
  }))(candidate.executable);
  const key = mtime === undefined ? undefined : `${candidate.executable}:${mtime}`;
  const cached = key ? versionCache.get(key) : undefined;
  if (cached) return cached;

  const run = deps.runVersion ?? runDbtVersion;
  const env = childEnv(candidate, 'normal', deps.env ?? process.env, platform);
  const { output } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Checking dbt…' },
    () => run(candidate.executable, { cwd: root, env }),
  );
  const identity: DbtIdentity = output === null
    ? { flavour: 'unknown', adapters: [], via: 'version' }
    : { flavour: classifyDbtVersion(output).flavour, adapters: pluginsFromVersionOutput(output), via: 'version' };
  if (key) versionCache.set(key, identity);
  return identity;
}

/** Roots whose Run dbt parse / compile is still before its run (modals, the probe, a prompt). */
const inFlight = new Set<string>();

/** Claim `root` for a flow's pre-run steps; false when another flow holds it. */
export function claimDbtFlow(root: string): boolean {
  const key = pathKey(root);
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

export function releaseDbtFlow(root: string): void {
  inFlight.delete(pathKey(root));
}

export function isDbtFlowStarting(root: string): boolean {
  return inFlight.has(pathKey(root));
}

export function _resetDbtFlowsForTests(): void {
  inFlight.clear();
}
