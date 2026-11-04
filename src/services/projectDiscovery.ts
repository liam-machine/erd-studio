/**
 * Finding the dbt project ERD Studio opens (#82) — or, when
 * `erdStudio.projectPath` names a folder without dbt_project.yml (#111), that
 * plain folder.
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
 *      else the first dbt project found;
 *   4. no dbt project anywhere (logical-only mode): the first workspace
 *      folder that already holds ERD data (`.erd-studio`, or the legacy
 *      `erd-studio/`);
 *   5. else the first workspace folder — any folder works, and nothing is
 *      written there until the user asks for a diagram.
 *
 * Any dbt project still beats a plain folder with ERD data, and the picker,
 * `candidates`, `autoRoot` and the multi-project context key stay dbt-only.
 * `hasDbt` says whether the chosen root holds `dbt_project.yml`; without it
 * the host runs logical-only (no Physical stage, no dbt services).
 *
 * Pure (no vscode import) so it is unit-testable and safe to share with the
 * editor provider.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  findDbtProjectAbove,
  findDbtProjectsBelow,
  hasDbtProjectFile,
  sortDbtCandidates,
} from './dbtProjectSearch';
import { findLegacySemanticDir } from './migrationService';
import { pathKey } from './pathKey';

/** Draw from dbt in a folder with no dbt_project.yml (logical-only mode). */
export const DRAW_FROM_DBT_NEEDS_DBT_MESSAGE =
  'Draw from dbt needs a dbt project. Open the folder that holds dbt_project.yml, or start with New Diagram / Import DBML.';

/** The canvas's Add Tables from dbt in a folder with no dbt_project.yml (logical-only mode). */
export const ADD_FROM_DBT_NEEDS_DBT_MESSAGE =
  'Adding tables from dbt needs a dbt project. Open the folder that holds dbt_project.yml to compare your design with what dbt built.';

export { hasDbtProjectFile };

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every folder that holds a dbt_project.yml, in auto-detection priority
 * order: the workspace folders themselves (in workspace order); then, for a
 * workspace folder that is not one, the dbt project it sits inside (a dbt
 * project's `models/` opened on its own; never past a folder holding the ERD
 * Studio folder, see `findDbtProjectAbove`); then the projects below the
 * workspace folders, shallowest first: the bounded walk's
 * (`findDbtProjectsBelow`: six folders deep, hidden folders other than
 * tools' own, symbolic links followed) together with `hostCandidates`, the
 * host's own search when it answered (`vscode.workspace.findFiles`, no depth
 * limit, like the recursive `workspaceContains:**\/dbt_project.yml`
 * activation event). Without `hostCandidates`, a project deeper than the
 * walk goes is not found here; the host says so in its log
 * (`noteUnusedDbtProject` in `extension.ts`).
 */
export function findDbtProjectCandidates(
  folderPaths: readonly string[],
  options: { hostCandidates?: readonly string[]; semanticDir?: string } = {},
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string | undefined): void => {
    if (dir === undefined) return;
    const key = pathKey(dir);
    if (!seen.has(key) && hasDbtProjectFile(dir)) {
      seen.add(key);
      found.push(dir);
    }
  };

  folderPaths.forEach(add);
  for (const folder of folderPaths) {
    if (!hasDbtProjectFile(folder)) add(findDbtProjectAbove(folder, options.semanticDir ?? '.erd-studio'));
  }
  const walked = findDbtProjectsBelow(folderPaths);
  const below = options.hostCandidates ? sortDbtCandidates([...walked, ...options.hostCandidates], folderPaths) : walked;
  below.forEach(add);
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

/**
 * Which rule chose the root: `setting` (erdStudio.projectPath), `picked`
 * (Select dbt Project…), `auto` (a detected dbt project), `erdData` (no dbt
 * project; the first workspace folder holding ERD data) or `folder` (no dbt
 * project and no ERD data; the first workspace folder).
 */
export type DbtProjectSource = 'setting' | 'picked' | 'auto' | 'erdData' | 'folder';

export interface DbtProjectResolution {
  /** The project to open, or undefined when the window has no folder (and no valid projectPath). */
  root: string | undefined;
  /** Which rule chose `root`. */
  source: DbtProjectSource;
  /** Whether `root` holds `dbt_project.yml`. False for a plain folder (logical-only) and for no root. */
  hasDbt: boolean;
  /** Every dbt project in the workspace, in auto-detection order. */
  candidates: string[];
  /** Where auto-detection alone would land — what the picker's "Auto-detect" row means. */
  autoRoot: string | undefined;
  /** A non-empty `projectPath` that is not an existing folder (surfaced to the user). */
  invalidSetting?: string;
}

/**
 * Resolve the project ERD Studio opens. Walks the workspace once; the result
 * also feeds the picker and the `hasMultipleDbtProjects` context key.
 *
 * `projectPath` may be absolute or relative to any workspace folder (the
 * first folder that resolves wins), and need not be a dbt project (#111). `picked` is honoured only while it is
 * still a dbt project in the workspace, so a removed folder quietly falls
 * back to auto-detection. With no dbt project in the workspace, the
 * first folder holding ERD data opens, else the first folder (logical-only).
 */
export function resolveDbtProject(
  folderPaths: readonly string[],
  opts: { projectPath?: string; picked?: string; semanticDir?: string; hostCandidates?: readonly string[] } = {},
): DbtProjectResolution {
  const semanticDir = opts.semanticDir ?? '.erd-studio';
  const candidates = findDbtProjectCandidates(folderPaths, { hostCandidates: opts.hostCandidates, semanticDir });
  const autoRoot = autoDetectProject(candidates, semanticDir);

  const configured = (opts.projectPath ?? '').trim();
  let invalidSetting: string | undefined;
  if (configured) {
    const tries = path.isAbsolute(configured)
      ? [configured]
      : folderPaths.map(folder => path.resolve(folder, configured));
    // A dbt project first, so a relative path that is a dbt project under one
    // workspace folder beats a plain folder of the same name under another.
    // Any folder is accepted after that (#111): ERD Studio keeps its data
    // wherever the setting points, and without dbt_project.yml it simply has
    // no manifest to compare against.
    const hit = tries.find(hasDbtProjectFile) ?? tries.find(isDirectory);
    if (hit) { return { root: hit, source: 'setting', hasDbt: hasDbtProjectFile(hit), candidates, autoRoot }; }
    invalidSetting = configured;
  }

  // A pick deeper than this search went (Select dbt Project… lists the host's
  // whole search) still counts while it is a dbt project inside a workspace folder.
  const picked = opts.picked;
  if (picked && (candidates.includes(picked) || (hasDbtProjectFile(picked) && folderPaths.some(f => isInsideFolder(picked, f))))) {
    const all = candidates.includes(picked) ? candidates : [...candidates, picked];
    return { root: picked, source: 'picked', hasDbt: true, candidates: all, autoRoot, invalidSetting };
  }

  if (autoRoot) {
    return { root: autoRoot, source: 'auto', hasDbt: true, candidates, autoRoot, invalidSetting };
  }

  // No dbt project anywhere: logical-only. A folder that already holds ERD
  // data first, then simply the first folder. Only the workspace folders
  // themselves are considered — no search below them.
  const withData = folderPaths.find(folder => hasErdStudioData(folder, semanticDir));
  if (withData) {
    return { root: withData, source: 'erdData', hasDbt: false, candidates, autoRoot, invalidSetting };
  }
  const first = folderPaths.find(isDirectory);
  return { root: first, source: first ? 'folder' : 'auto', hasDbt: false, candidates, autoRoot, invalidSetting };
}

/**
 * Resolve the project root from the workspace folder paths and the
 * `erdStudio.projectPath` setting. Thin wrapper over {@link resolveDbtProject}
 * for callers that only need the path — which may be a plain folder when the
 * workspace holds no dbt project.
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
 * The project a file belongs to: the nearest ancestor directory holding
 * dbt_project.yml, or undefined when there is none. Passing the open
 * project's root as `stopAt` makes that root count as a project too, so a
 * root without dbt_project.yml (#111) owns its files even when it sits
 * inside a dbt repository, while a dbt project nested below it still does not.
 */
export function findOwningDbtProject(filePath: string, stopAt?: string): string | undefined {
  let dir = path.dirname(path.resolve(filePath));
  for (;;) {
    if (hasDbtProjectFile(dir) || (stopAt !== undefined && samePath(dir, stopAt))) { return dir; }
    const parent = path.dirname(dir);
    if (parent === dir) { return undefined; }
    dir = parent;
  }
}

/** Whether `child` is `folder` or inside it. */
function isInsideFolder(child: string, folder: string): boolean {
  const rel = path.relative(path.resolve(folder), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Whether two paths name the same location once resolved, ignoring case where the file system does. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}
