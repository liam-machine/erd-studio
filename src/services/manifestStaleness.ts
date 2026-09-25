/**
 * Manifest staleness — the pure comparison behind "has a dbt source file
 * changed since `manifest.json` was written?", plus a plain-`fs` lister of
 * source mtimes for callers with no VS Code workspace (the `erd-studio` CLI).
 *
 * `stalenessService.checkManifestStaleness` is the extension's entry point: it
 * lists files through `vscode.workspace.findFiles` and hands the mtimes here,
 * so the canvas and the CLI agree on what "stale" means by construction.
 *
 * No `vscode` import — this module is bundled into `dist/cli.js`.
 */

import * as fs from 'fs';
import * as path from 'path';

import { resolveManifestPath, type DbtProjectConfig } from './dbtProjectConfig';

export interface StalenessResult {
  isStale: boolean;
  /** Epoch ms of manifest.json mtime, or null if the file is missing. */
  manifestMtime: number | null;
  /** Epoch ms of the newest source file, or null if no sources found. */
  newestSourceMtime: number | null;
}

/** Most source files the fs lister will stat — the same cap `findFiles` is given. */
export const MAX_STALENESS_SOURCE_FILES = 5000;

/** Extensions whose change can alter what `dbt parse` writes to the manifest. */
const STALENESS_EXTENSIONS = new Set(['.sql', '.yml', '.yaml']);

/**
 * Directories the fs lister never descends into: installed packages, venvs and
 * build output are not the project's own sources. Mirrors the yml parser's
 * exclusions.
 */
const STALENESS_SKIP_DIRS = new Set([
  'node_modules', 'target', '.git',
  '.venv', 'venv', 'env', '.direnv', 'site-packages',
  '__pycache__', 'dbt_packages', 'dbt_modules', 'logs',
]);

/**
 * Pure staleness verdict from mtimes.
 *
 * A missing manifest (`manifestMtime === null`) is stale. With no sources the
 * manifest is not stale. Otherwise it is stale when the newest source is newer
 * than the manifest.
 */
export function checkManifestStalenessFromMtimes(
  manifestMtime: number | null,
  sourceMtimes: Iterable<number>,
): StalenessResult {
  if (manifestMtime === null) {
    return { isStale: true, manifestMtime: null, newestSourceMtime: null };
  }

  let newestSourceMtime: number | null = null;
  for (const mtime of sourceMtimes) {
    if (newestSourceMtime === null || mtime > newestSourceMtime) {
      newestSourceMtime = mtime;
    }
  }

  const isStale = newestSourceMtime !== null && newestSourceMtime > manifestMtime;
  return { isStale, manifestMtime, newestSourceMtime };
}

/** mtime of the manifest `dbtConfig` points at, or null when it does not exist. */
export function readManifestMtime(projectRoot: string, dbtConfig: DbtProjectConfig): number | null {
  try {
    return fs.statSync(resolveManifestPath(projectRoot, dbtConfig)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * mtimes of every `*.sql` / `*.yml` / `*.yaml` under the configured
 * `model-paths`, found by a plain recursive walk. Skips packages, venvs and
 * build output, and stops after `limit` files. Unreadable entries are skipped.
 */
export function listSourceMtimesFs(
  projectRoot: string,
  dbtConfig: DbtProjectConfig,
  limit = MAX_STALENESS_SOURCE_FILES,
): number[] {
  const mtimes: number[] = [];

  const walk = (dir: string): void => {
    if (mtimes.length >= limit) { return; }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (mtimes.length >= limit) { return; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!STALENESS_SKIP_DIRS.has(entry.name)) { walk(full); }
        continue;
      }
      if (!entry.isFile() || !STALENESS_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      try {
        mtimes.push(fs.statSync(full).mtimeMs);
      } catch {
        // Deleted between readdir and stat.
      }
    }
  };

  for (const modelPath of dbtConfig.modelPaths) {
    walk(path.resolve(projectRoot, modelPath));
  }
  return mtimes;
}

/**
 * The CLI's staleness check: the same verdict as the extension's, with the
 * source files listed from disk instead of through the VS Code workspace.
 */
export function checkManifestStalenessFs(
  projectRoot: string,
  dbtConfig: DbtProjectConfig,
): StalenessResult {
  const manifestMtime = readManifestMtime(projectRoot, dbtConfig);
  if (manifestMtime === null) {
    return checkManifestStalenessFromMtimes(null, []);
  }
  return checkManifestStalenessFromMtimes(manifestMtime, listSourceMtimesFs(projectRoot, dbtConfig));
}
