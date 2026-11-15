/**
 * contributorCount — how many people work on a project's ERD Studio files, for
 * usage telemetry: the number of distinct commit authors under the semantic
 * directory in the last {@link CONTRIBUTOR_WINDOW_DAYS} days, sent as a bucket
 * and nothing else.
 *
 * It answers "is ERD Studio used by one person or by a team?". The authors are
 * counted on this machine, from `git log`'s output held in memory; no name,
 * email, remote, branch or path is kept, logged or sent.
 *
 * Beside the bucket goes the repository key ({@link repoKeyOf}): a short
 * one-way hash of the repository's first commit id, the same in every clone,
 * so the installs working in one repository can be counted. It is never made
 * from a name, a remote, a URL, a path or a file's contents.
 *
 * Only the bucket and the key leave this module. Every git command here is
 * read-only, run with no pager, no prompt, no optional locks and no
 * fsmonitor, and the caller runs them only in a trusted workspace.
 *
 * No `vscode` import: the runner is injected, so this is testable as plain
 * functions.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
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

/** Hex characters of the repository key: 48 bits, enough that two repositories never share one in practice. */
export const REPO_KEY_LENGTH = 12;
const GIT_SAFE = ['--no-pager', '-c', 'core.fsmonitor=false'] as const;
/** Whether the clone holds only part of its history (then its oldest commit is not the repository's first). */
export const SHALLOW_ARGS: readonly string[] = [...GIT_SAFE, 'rev-parse', '--is-shallow-repository'];
/** The commits with no parent reachable from HEAD: the repository's first commit (several after joined histories). */
export const ROOT_COMMIT_ARGS: readonly string[] = [...GIT_SAFE, 'rev-list', '--max-parents=0', 'HEAD'];

/**
 * The repository key for `rev-list --max-parents=0` output: the first
 * {@link REPO_KEY_LENGTH} hex characters of a SHA-256 over the first commit id
 * (the smallest, when joined histories left several). `undefined` when the
 * output holds no commit id.
 */
export function repoKeyOf(rootCommits: string): string | undefined {
  const roots = rootCommits
    .split('\n')
    .map(line => line.trim().toLowerCase())
    .filter(line => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(line))
    .sort();
  if (roots.length === 0) return undefined;
  return createHash('sha256').update(`erd-studio-repo:${roots[0]}`).digest('hex').slice(0, REPO_KEY_LENGTH);
}

/** What {@link detectContributors} found for one project. */
export interface ProjectTeam {
  contributors: ContributorBucket;
  /** Absent in a shallow clone, a repository with no commit, or when git could not say. */
  repoKey?: string;
}

/**
 * The bucket and repository key for the project whose semantic directory is
 * `semanticDir` (an absolute path). `undefined` when it could not be counted:
 * no git, not a repository, a failure or a timeout. A bucket of `'0'` is a
 * repository with no commit under the directory in the window (the files are
 * new, or not committed).
 */
export async function detectContributors(
  semanticDir: string,
  run: GitRunner = runGit,
): Promise<ProjectTeam | undefined> {
  let contributors: ContributorBucket;
  try {
    // Run inside the directory with the pathspec `.`, so a semantic directory
    // that is its own repository, or sits in a parent's, both work.
    contributors = contributorBucket(countAuthors(await run(semanticDir, contributorLogArgs('.'))));
  } catch {
    return undefined;
  }
  try {
    if ((await run(semanticDir, SHALLOW_ARGS)).trim() !== 'false') return { contributors };
    const repoKey = repoKeyOf(await run(semanticDir, ROOT_COMMIT_ARGS));
    return repoKey ? { contributors, repoKey } : { contributors };
  } catch {
    return { contributors };
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
