/**
 * Finding the dbt project ERD Studio opens (#82).
 *
 * A window holds exactly one project: every service is built at activation
 * from the root chosen here. A workspace can contain several dbt projects —
 * multi-root workspaces, monorepos — so the choice is:
 *
 *   1. `erdStudio.projectPath` — the explicit, shareable setting;
 *   2. the project picked with **Select dbt Project…**, kept per machine in
 *      `workspaceState` so a personal choice never lands in a settings file
 *      a team commits;
 *   3. auto-detection: the first dbt project that already holds ERD data,
 *      else the first dbt project found.
 *
 * Pure (no vscode import) so it is unit-testable and safe to share with the
 * editor provider.
 */
import * as fs from 'fs';
import * as path from 'path';

import { findLegacySemanticDir } from './migrationService';

/** Directories never descended into when searching for a nested dbt project. */
const DBT_SEARCH_SKIP_DIRS = new Set(['node_modules', 'dbt_packages', '.git', 'target', '.venv', 'venv']);

/** Maximum directory depth (below a workspace folder) searched for dbt_project.yml. */
const DBT_SEARCH_MAX_DEPTH = 3;

export function hasDbtProjectFile(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'dbt_project.yml')).isFile();
  } catch {
    return false;
  }
}

/**
 * Every folder that holds a dbt_project.yml, in auto-detection priority
 * order: the workspace folders themselves (in workspace order), then a
 * depth-limited breadth-first search below each of them (skipping
 * node_modules, dbt_packages, .git, target, .venv and dot-directories),
 * shallowest first. The search depth matches the recursive
 * `workspaceContains` activation event, so activation never lands on "no
 * project found" for a monorepo with dbt in a subfolder.
 */
export function findDbtProjectCandidates(folderPaths: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string): void => {
    if (!seen.has(dir) && hasDbtProjectFile(dir)) {
      seen.add(dir);
      found.push(dir);
    }
  };

  folderPaths.forEach(add);

  // Breadth-first so the shallowest match comes first.
  let frontier = [...folderPaths];
  for (let depth = 1; depth <= DBT_SEARCH_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || DBT_SEARCH_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        const child = path.join(dir, entry.name);
        add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * Whether a dbt project already holds ERD Studio data — the configured
 * semantic dir, or a pre-0.6.44 `erd-studio/` that activation will rename.
 */
export function hasErdStudioData(projectRoot: string, semanticDir: string): boolean {
  try {
    if (fs.statSync(path.join(projectRoot, semanticDir)).isDirectory()) { return true; }
  } catch {
    // fall through to the legacy location
  }
  return findLegacySemanticDir(projectRoot, semanticDir) !== null;
}

/** Auto-detection over an already-listed set of candidates: ERD data first. */
export function autoDetectProject(candidates: readonly string[], semanticDir: string): string | undefined {
  return candidates.find(c => hasErdStudioData(c, semanticDir)) ?? candidates[0];
}

export type DbtProjectSource = 'setting' | 'picked' | 'auto';

export interface DbtProjectResolution {
  /** The project to open, or undefined when the workspace holds none. */
  root: string | undefined;
  /** Which rule chose `root`. */
  source: DbtProjectSource;
  /** Every dbt project in the workspace, in auto-detection order. */
  candidates: string[];
  /** Where auto-detection alone would land — what the picker's "Auto-detect" row means. */
  autoRoot: string | undefined;
  /** A non-empty `projectPath` that does not contain dbt_project.yml (surfaced to the user). */
  invalidSetting?: string;
}

/**
 * Resolve the project ERD Studio opens. Walks the workspace once; the result
 * also feeds the picker and the `hasMultipleDbtProjects` context key.
 *
 * `projectPath` may be absolute or relative to any workspace folder (the
 * first folder that resolves wins). `picked` is honoured only while it is
 * still one of the workspace's dbt projects, so a removed folder quietly
 * falls back to auto-detection.
 */
export function resolveDbtProject(
  folderPaths: readonly string[],
  opts: { projectPath?: string; picked?: string; semanticDir?: string } = {},
): DbtProjectResolution {
  const semanticDir = opts.semanticDir ?? '.erd-studio';
  const candidates = findDbtProjectCandidates(folderPaths);
  const autoRoot = autoDetectProject(candidates, semanticDir);

  const configured = (opts.projectPath ?? '').trim();
  let invalidSetting: string | undefined;
  if (configured) {
    const tries = path.isAbsolute(configured)
      ? [configured]
      : folderPaths.map(folder => path.resolve(folder, configured));
    const hit = tries.find(hasDbtProjectFile);
    if (hit) { return { root: hit, source: 'setting', candidates, autoRoot }; }
    invalidSetting = configured;
  }

  if (opts.picked && candidates.includes(opts.picked)) {
    return { root: opts.picked, source: 'picked', candidates, autoRoot, invalidSetting };
  }

  return { root: autoRoot, source: 'auto', candidates, autoRoot, invalidSetting };
}

/**
 * Resolve the dbt project root from the workspace folder paths and the
 * `erdStudio.projectPath` setting. Thin wrapper over {@link resolveDbtProject}
 * for callers that only need the path.
 */
export function resolveDbtProjectRoot(
  folderPaths: readonly string[],
  projectPathSetting: string,
  semanticDir = '.erd-studio',
  picked?: string,
): string | undefined {
  return resolveDbtProject(folderPaths, { projectPath: projectPathSetting, semanticDir, picked }).root;
}

/**
 * The dbt project a file belongs to: the nearest ancestor directory holding
 * dbt_project.yml, or undefined when there is none.
 */
export function findOwningDbtProject(filePath: string): string | undefined {
  let dir = path.dirname(path.resolve(filePath));
  for (;;) {
    if (hasDbtProjectFile(dir)) { return dir; }
    const parent = path.dirname(dir);
    if (parent === dir) { return undefined; }
    dir = parent;
  }
}

/** Whether two paths name the same location once resolved. */
export function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
