/**
 * Where a `dbt_project.yml` is looked for: the one rule set behind the
 * extension's project discovery (`projectDiscovery.ts`), `findDbtProjectDir`
 * (`dbtEnv.ts`) and the CLI's `resolveProjectRoot` (`cli/context.ts`).
 *
 * - **Below a folder**: breadth first, shallowest match first, up to
 *   {@link DBT_SEARCH_MAX_DEPTH} folders deep and at most
 *   {@link DBT_SEARCH_MAX_DIRS} folders in all. Dependencies, build output and
 *   virtual environments ({@link DBT_SEARCH_SKIP_DIRS}) are never entered, nor
 *   are the hidden folders tools keep ({@link HIDDEN_TOOL_DIRS}); any other
 *   hidden folder is (a project in `.dbt-project/` is still a project), after
 *   the visible folders of the same depth. Symbolic links to folders are
 *   followed (each real folder once).
 * - **Above a folder**: the nearest ancestor holding `dbt_project.yml`, so a
 *   dbt project's `models/` opened on its own still finds its project. The walk
 *   stops at a folder holding the ERD Studio folder (a design folder is its own
 *   root) and never leaves the user's home folder for a path inside it.
 *
 * The extension prefers the host's own search when it answers in time
 * (`vscode.workspace.findFiles('**\/dbt_project.yml', DBT_SEARCH_EXCLUDE_GLOB)`,
 * which has no depth limit, like the `workspaceContains` activation event):
 * {@link sortDbtCandidates} orders those results the same way.
 *
 * Pure apart from reading the file system (no `vscode`): the CLI bundles it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Folders never entered: dependencies, build output, virtual environments, caches. */
export const DBT_SEARCH_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'dbt_packages', 'dbt_modules', 'target', 'venv', 'site-packages', '__pycache__', 'bower_components',
]);

/** Hidden folders tools keep, never entered (any other hidden folder is). */
export const HIDDEN_TOOL_DIRS: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn', '.venv', '.tox', '.nox', '.cache', '.idea', '.vscode', '.vscode-test', '.terraform',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.next', '.nuxt', '.yarn', '.pnpm-store', '.gradle', '.npm',
  '.direnv', '.eggs', '.ipynb_checkpoints', '.history', '.Trash',
]);

/** How deep below a folder the walk looks. */
export const DBT_SEARCH_MAX_DEPTH = 6;
/** How many folders the walk opens at most, so a huge tree never stalls activation. */
export const DBT_SEARCH_MAX_DIRS = 5000;

/** The host search's exclude glob: the same folders the walk never enters. */
export const DBT_SEARCH_EXCLUDE_GLOB = `**/{${[...DBT_SEARCH_SKIP_DIRS, ...HIDDEN_TOOL_DIRS].join(',')}}/**`;

/** Whether the walk skips a folder with this name. */
export function skipsDbtSearchDir(name: string): boolean {
  return DBT_SEARCH_SKIP_DIRS.has(name) || HIDDEN_TOOL_DIRS.has(name);
}

export function hasDbtProjectFile(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'dbt_project.yml')).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function realPath(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Visible names first, then hidden ones; each group in name order. */
function compareSearchNames(a: string, b: string): number {
  const ha = a.startsWith('.') ? 1 : 0;
  const hb = b.startsWith('.') ? 1 : 0;
  return ha - hb || a.localeCompare(b);
}

export interface DbtSearchOptions {
  maxDepth?: number;
  maxDirs?: number;
  /** Stop at the first match. */
  first?: boolean;
}

/**
 * Every folder below `starts` (not the starts themselves) holding
 * `dbt_project.yml`, shallowest first: depth by depth across all the starts,
 * visible folders before hidden ones, then name order.
 */
export function findDbtProjectsBelow(starts: readonly string[], options: DbtSearchOptions = {}): string[] {
  const maxDepth = options.maxDepth ?? DBT_SEARCH_MAX_DEPTH;
  const maxDirs = options.maxDirs ?? DBT_SEARCH_MAX_DIRS;
  const found: string[] = [];
  const seen = new Set<string>(starts.map(realPath));
  let opened = 0;
  let frontier = [...starts];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (opened >= maxDirs) return found;
      opened++;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => compareSearchNames(a.name, b.name));
      for (const entry of entries) {
        if (skipsDbtSearchDir(entry.name)) continue;
        const child = path.join(dir, entry.name);
        // A symbolic link counts when it points at a folder (fs.statSync follows it).
        if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDirectory(child))) continue;
        const real = realPath(child);
        if (seen.has(real)) continue;
        seen.add(real);
        if (hasDbtProjectFile(child)) {
          found.push(child);
          if (options.first) return found;
        }
        next.push(child);
      }
    }
    frontier = next;
  }
  return found;
}

/** Whether `dir` holds the ERD Studio folder (`semanticDir`, or the legacy `erd-studio/`). */
function holdsDesignFolder(dir: string, semanticDir: string): boolean {
  return isDirectory(path.join(dir, semanticDir)) || (semanticDir === '.erd-studio' && isDirectory(path.join(dir, 'erd-studio')));
}

/**
 * The nearest folder above `start` (not `start` itself) holding
 * `dbt_project.yml`, or undefined. With `semanticDir`, a folder holding the
 * ERD Studio folder — `start` included — ends the walk first: a design folder
 * is its own root, never the dbt project above it. A path inside the user's
 * home folder is never walked up to the home folder or out of it.
 */
export function findDbtProjectAbove(start: string, semanticDir?: string, home: string = safeHome()): string | undefined {
  let dir = path.resolve(start);
  if (semanticDir && holdsDesignFolder(dir, semanticDir)) return undefined;
  const inHome = home !== '' && isInside(dir, home);
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    if (inHome && (parent === path.resolve(home) || !isInside(parent, home))) return undefined;
    dir = parent;
    if (hasDbtProjectFile(dir)) return dir;
    if (semanticDir && holdsDesignFolder(dir, semanticDir)) return undefined;
  }
}

function safeHome(): string {
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

/** Whether `child` is `parent` or inside it. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Folders holding `dbt_project.yml` that the host's search found (each the
 * file's folder, or the folder itself), in the walk's order: shallowest below
 * its workspace folder first, visible before hidden, then workspace-folder
 * order, then name. Folders inside a skipped folder are dropped, as the walk
 * would never reach them; duplicates go.
 */
export function sortDbtCandidates(dirs: readonly string[], folderPaths: readonly string[]): string[] {
  const rows: Array<{ dir: string; depth: number; hidden: number; folder: number; key: string }> = [];
  const seen = new Set<string>();
  for (const raw of dirs) {
    const dir = path.basename(raw) === 'dbt_project.yml' ? path.dirname(raw) : raw;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    const folder = folderPaths.findIndex((f) => isInside(resolved, path.resolve(f)));
    const rel = folder >= 0 ? path.relative(path.resolve(folderPaths[folder]), resolved) : '';
    const parts = rel ? rel.split(path.sep) : [];
    if (parts.some(skipsDbtSearchDir)) continue;
    seen.add(resolved);
    rows.push({
      dir: resolved,
      depth: folder >= 0 ? parts.length : Number.MAX_SAFE_INTEGER,
      hidden: parts.some((p) => p.startsWith('.')) ? 1 : 0,
      folder: folder >= 0 ? folder : folderPaths.length,
      key: parts.join('/'),
    });
  }
  rows.sort((a, b) => a.depth - b.depth || a.hidden - b.hidden || a.folder - b.folder || compareSearchNames(a.key, b.key));
  return rows.map((r) => r.dir);
}
