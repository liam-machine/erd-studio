/**
 * StalenessService — detects whether the dbt manifest is stale by comparing
 * the mtime of `target/manifest.json` against source model files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface StalenessResult {
  isStale: boolean;
  /** Epoch ms of manifest.json mtime, or null if the file is missing. */
  manifestMtime: number | null;
  /** Epoch ms of the newest source file, or null if no sources found. */
  newestSourceMtime: number | null;
}

/**
 * Check whether dbt model source files have been modified after the manifest
 * was last generated.
 *
 * Returns `isStale: true` when:
 *   - The manifest file does not exist, OR
 *   - Any model source file (*.sql, *.yml, *.yaml) under `models/` is newer
 *     than the manifest.
 */
export async function checkManifestStaleness(
  projectPath: string,
): Promise<StalenessResult> {
  const manifestPath = path.join(projectPath, 'target', 'manifest.json');

  // Get manifest mtime
  let manifestMtime: number | null = null;
  try {
    const stat = fs.statSync(manifestPath);
    manifestMtime = stat.mtimeMs;
  } catch {
    // Manifest doesn't exist
    return { isStale: true, manifestMtime: null, newestSourceMtime: null };
  }

  // Find all model source files
  const pattern = new vscode.RelativePattern(projectPath, 'models/**/*.{sql,yml,yaml}');
  const sourceUris = await vscode.workspace.findFiles(pattern, null, 5000);

  if (sourceUris.length === 0) {
    // No source files — manifest is not stale
    return { isStale: false, manifestMtime, newestSourceMtime: null };
  }

  // Find the newest source file mtime
  let newestSourceMtime: number | null = null;
  for (const uri of sourceUris) {
    try {
      const stat = fs.statSync(uri.fsPath);
      if (newestSourceMtime === null || stat.mtimeMs > newestSourceMtime) {
        newestSourceMtime = stat.mtimeMs;
      }
    } catch {
      // File may have been deleted between findFiles and stat
    }
  }

  const isStale = newestSourceMtime !== null && newestSourceMtime > manifestMtime;
  return { isStale, manifestMtime, newestSourceMtime };
}
