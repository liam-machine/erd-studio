// The folder a story opens, copied fresh into the story's temp HOME every run.
//
//   'empty'          no folder: VS Code starts as an empty window
//   'plain'          test/stories/workspaces/plain (a README and nothing else)
//   'dbt'            a copy of test/fixtures/dbt-project (a dbt project from before 2.0)
//   'yaml-project'   a copy of test/fixtures/logical-only (a pre-2.0 YAML/JSON project, no dbt)
//   any other name   test/stories/workspaces/<name>, else test/fixtures/<name>
//   (dir) => …       a function that fills an empty folder named "project" (sync or async)
//   { name, from?, skip?, add?, fill? }
//                    a folder called `name` (the window title shows it), built at run
//                    time from repo files, so no fixture is copied into git:
//                      from  a repo-relative folder to copy as the folder itself
//                      skip  top-level names of `from` not to copy (e.g. ['.erd-studio'])
//                      add   { 'path/in/folder': 'repo/relative/file-or-folder', … }
//                      fill  (dir) => …, run last

import fs from 'node:fs';
import path from 'node:path';

import { REPO } from './launch.mjs';

const OWN = path.join(REPO, 'test/stories/workspaces');

/** Named workspaces that reuse a test fixture rather than keep a copy in git. */
export const FIXTURE_ALIASES = {
  dbt: 'test/fixtures/dbt-project',
  'yaml-project': 'test/fixtures/logical-only',
};

function sourceOf(name) {
  if (FIXTURE_ALIASES[name]) return path.join(REPO, FIXTURE_ALIASES[name]);
  if (fs.existsSync(path.join(OWN, name))) return path.join(OWN, name);
  if (fs.existsSync(path.join(REPO, 'test/fixtures', name))) return path.join(REPO, 'test/fixtures', name);
  throw new Error(`unknown workspace "${name}": not in test/stories/workspaces/ or test/fixtures/`);
}

/**
 * Make the story's folder inside `home`; resolves its absolute path, or
 * undefined for an empty window.
 */
export async function prepareWorkspace(workspace, home) {
  if (workspace === undefined || workspace === 'empty') return undefined;
  if (workspace && typeof workspace === 'object') return buildWorkspace(workspace, home);
  if (typeof workspace === 'function') {
    const dir = path.join(home, 'project');
    fs.mkdirSync(dir, { recursive: true });
    await workspace(dir);
    return dir;
  }
  const dir = path.join(home, workspace);
  fs.cpSync(sourceOf(workspace), dir, {
    recursive: true,
    // Never copy a stray dependency folder or a git repository (a fixture's target/ is kept: it holds manifest.json).
    filter: (src) => !/[\\/](node_modules|\.git)$/.test(src),
  });
  return dir;
}

const COPY_FILTER = (src) => !/[\\/](node_modules|\.git)$/.test(src);

/** A `{ name, from, skip, add, fill }` workspace (see the top of this file). */
async function buildWorkspace({ name, from, skip = [], add = {}, fill }, home) {
  if (!name || !/^[A-Za-z0-9][\w.-]*$/.test(name)) throw new Error(`workspace name "${name}": letters, digits, '.', '_' and '-' only`);
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true });
  if (from) {
    const src = path.join(REPO, from);
    for (const entry of fs.readdirSync(src)) {
      if (skip.includes(entry)) continue;
      fs.cpSync(path.join(src, entry), path.join(dir, entry), { recursive: true, filter: COPY_FILTER });
    }
  }
  for (const [to, rel] of Object.entries(add)) {
    const dest = path.join(dir, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(REPO, rel), dest, { recursive: true, filter: COPY_FILTER });
  }
  if (fill) await fill(dir);
  return dir;
}
