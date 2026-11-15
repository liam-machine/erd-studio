/**
 * contributorCount — how many people work on a project's ERD Studio files, for
 * usage telemetry: the number of distinct commit authors under the semantic
 * directory in the last {@link CONTRIBUTOR_WINDOW_DAYS} days, sent as a bucket
 * and nothing else.
 *
 * It answers "is ERD Studio used by one person or by a team?" without telling
 * anyone which project or which people. The authors are counted on this
 * machine, from `git log`'s output held in memory; no name, email, hash,
 * remote, branch or path is kept, logged or sent. Only the bucket leaves this
 * module.
 *
 * `git log` is read-only. It is run with no pager, no prompt, no optional
 * locks and no fsmonitor, and the caller runs it only in a trusted workspace.
 *
 * No `vscode` import: the runner is injected, so this is testable as plain
 * functions.
 */
import { execFile } from 'child_process';
import type { ContributorBucket } from './telemetryPayload';

/** How far back commits count. The same span as the Worker's row retention. */
export const CONTRIBUTOR_WINDOW_DAYS = 90;
/** Commits read at most: enough for any real project's 90 days of model edits. */
const MAX_COMMITS = 5000;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;

/** Runs git with `args` in `cwd` and resolves its stdout, or rejects. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

/** The arguments of the one git command this module runs. */
export function contributorLogArgs(semanticDir: string): string[] {
  return [
    '--no-pager',
    '-c', 'core.fsmonitor=false',
    'log',
    `--since=${CONTRIBUTOR_WINDOW_DAYS}.days.ago`,
    `--max-count=${MAX_COMMITS}`,
    // The author's email after .mailmap: one person with two addresses the
    // project has mapped counts once.
    '--format=%aE',
    '--',
    semanticDir,
  ];
}

/** Distinct authors in `git log --format=%aE` output: one per non-empty line, compared without case. */
export function countAuthors(stdout: string): number {
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    const author = line.trim().toLowerCase();
    if (author) seen.add(author);
  }
  return seen.size;
}

export function contributorBucket(count: number): ContributorBucket {
  if (!(count > 0)) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 10) return '4-10';
  return '10+';
}

/**
 * The bucket for the project whose semantic directory is `semanticDir` (an
 * absolute path). `undefined` when it could not be counted: no git, not a
 * repository, a failure or a timeout. `'0'` is a repository with no commit
 * under the directory in the window (the files are new, or not committed).
 */
export async function detectContributors(
  semanticDir: string,
  run: GitRunner = runGit,
): Promise<ContributorBucket | undefined> {
  try {
    // Run inside the directory with the pathspec `.`, so a semantic directory
    // that is its own repository, or sits in a parent's, both work.
    return contributorBucket(countAuthors(await run(semanticDir, contributorLogArgs('.'))));
  } catch {
    return undefined;
  }
}

const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
