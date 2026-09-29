/**
 * Why a dbt project has no `manifest.json` (#113), as booleans only — the
 * telemetry records one fixed feature key per reason, never a path.
 *
 * vscode-free and spawn-free: it stats files and nothing else. Every input is
 * injectable so tests need no real file system or dbt install.
 */

import * as fs from 'fs';
import { DEFAULT_TARGET_PATH, resolveTargetDir, type DbtProjectConfig } from './dbtProjectConfig';
import { dbtExecutableCandidates } from './dbtEnv';

export type ManifestMissingReason = 'noTargetDir' | 'customTargetPath' | 'noDbtFound';

export interface ManifestMissingReasonDeps {
  existsSync?: (p: string) => boolean;
  /** Number of dbt executables found (stat only). Default: `dbtExecutableCandidates(root).length`. */
  candidates?: (root: string) => number;
}

/**
 * The subset of reasons that hold, in a fixed order:
 * - `noTargetDir` — the resolved artifact folder (absolute `targetPath` kept) does not exist;
 * - `customTargetPath` — `targetPath` is not dbt's default `target`;
 * - `noDbtFound` — no dbt executable in the venv, `$PATH` or the usual homes.
 *
 * Never throws: a failing check simply contributes no reason.
 */
export function manifestMissingReasons(
  root: string,
  dbtConfig: DbtProjectConfig,
  deps: ManifestMissingReasonDeps = {},
): ManifestMissingReason[] {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const candidates = deps.candidates ?? ((r: string) => dbtExecutableCandidates(r).length);
  const reasons: ManifestMissingReason[] = [];
  try {
    if (!existsSync(resolveTargetDir(root, dbtConfig))) { reasons.push('noTargetDir'); }
  } catch { /* no reason */ }
  if (dbtConfig.targetPath !== DEFAULT_TARGET_PATH) { reasons.push('customTargetPath'); }
  try {
    if (candidates(root) === 0) { reasons.push('noDbtFound'); }
  } catch { /* no reason */ }
  return reasons;
}

/** Last time Run dbt parse launched within this window counts as its conversion. */
export const PARSE_CONVERSION_WINDOW_MS = 10 * 60 * 1000;

/**
 * Which feature a manifest change records (#113): none unless the manifest was
 * missing before and exists now; `manifestAfterParse` when Run dbt parse
 * launched within {@link PARSE_CONVERSION_WINDOW_MS}, else `manifestAppeared`.
 */
export function manifestAppearanceFeature(
  wasMissing: boolean,
  existsNow: boolean,
  lastParseAt: number | undefined,
  now: number,
): 'manifestAfterParse' | 'manifestAppeared' | null {
  if (!wasMissing || !existsNow) { return null; }
  if (lastParseAt !== undefined && now >= lastParseAt && now - lastParseAt <= PARSE_CONVERSION_WINDOW_MS) {
    return 'manifestAfterParse';
  }
  return 'manifestAppeared';
}
