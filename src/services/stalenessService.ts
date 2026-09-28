/**
 * StalenessService — detects whether the dbt manifest is stale by comparing
 * the mtime of `{target-path}/manifest.json` against source model files
 * under the configured `model-paths`.
 *
 * The comparison itself is `checkManifestStalenessFromMtimes`
 * (`manifestStaleness.ts`), shared with the CLI; this module only supplies the
 * VS Code workspace file listing.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';

import {
  modelPathsGlob,
  readDbtProjectConfig,
  type DbtProjectConfig,
} from './dbtProjectConfig';
import {
  checkManifestStalenessFromMtimes,
  MAX_STALENESS_SOURCE_FILES,
  readManifestMtime,
  type StalenessResult,
} from './manifestStaleness';

export type { StalenessResult } from './manifestStaleness';

/**
 * Check whether dbt model source files have been modified after the manifest
 * was last generated.
 *
 * Returns `isStale: true` when:
 *   - The manifest file does not exist, OR
 *   - Any model source file (*.sql, *.yml, *.yaml) under a model path is
 *     newer than the manifest.
 *
 * @param dbtConfig — resolved dbt_project.yml paths; read from disk when omitted.
 */
export async function checkManifestStaleness(
  projectPath: string,
  dbtConfig: DbtProjectConfig = readDbtProjectConfig(projectPath),
): Promise<StalenessResult> {
  const manifestMtime = readManifestMtime(projectPath, dbtConfig);
  if (manifestMtime === null) {
    return checkManifestStalenessFromMtimes(null, []);
  }

  // Find all model source files
  const pattern = new vscode.RelativePattern(
    projectPath,
    `${modelPathsGlob(dbtConfig)}/**/*.{sql,yml,yaml}`,
  );
  const sourceUris = await vscode.workspace.findFiles(pattern, null, MAX_STALENESS_SOURCE_FILES);

  const sourceMtimes: number[] = [];
  for (const uri of sourceUris) {
    try {
      sourceMtimes.push(fs.statSync(uri.fsPath).mtimeMs);
    } catch {
      // File may have been deleted between findFiles and stat
    }
  }

  return checkManifestStalenessFromMtimes(manifestMtime, sourceMtimes);
}
