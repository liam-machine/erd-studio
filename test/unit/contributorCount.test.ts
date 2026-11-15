/**
 * contributorCount — the bucket of distinct commit authors under the semantic
 * directory, for usage telemetry. Only the bucket may leave the module: these
 * tests pin the counting, the one git command it runs and that a failure sends
 * nothing.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  contributorBucket,
  contributorLogArgs,
  countAuthors,
  detectContributors,
  repoKeyOf,
  ROOT_COMMIT_ARGS,
  SHALLOW_ARGS,
  type GitRunner,
} from '../../src/services/contributorCount';
import { CONTRIBUTOR_BUCKETS, REPO_KEY_PATTERN } from '../../src/services/telemetryPayload';

const ROOT = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const OTHER_ROOT = '0000000000000000000000000000000000000001';
/** A git stand-in: two authors, a full clone, one first commit unless told otherwise. */
const fakeGit = (over: { shallow?: string; roots?: string; fail?: 'log' | 'rev' } = {}): GitRunner => async (_cwd, args) => {
  if (args.includes('log')) {
    if (over.fail === 'log') throw new Error('not a repository');
    return 'ana@example.com\nben@example.com\nana@example.com\n';
  }
  if (over.fail === 'rev') throw new Error('timeout');
  if (args.includes('rev-parse')) return over.shallow ?? 'false\n';
  return over.roots ?? `${ROOT}\n`;
};

describe('countAuthors', () => {
  it('counts distinct lines, without case, ignoring blanks', () => {
    expect(countAuthors('a@x.io\nB@x.io\na@x.io\n\nb@X.io\r\n  \n')).toBe(2);
    expect(countAuthors('')).toBe(0);
  });
});

describe('contributorBucket', () => {
  it('maps a count to its bucket', () => {
    expect([0, 1, 2, 3, 4, 10, 11, 500].map(contributorBucket)).toEqual(['0', '1', '2-3', '2-3', '4-10', '4-10', '10+', '10+']);
    expect(contributorBucket(Number.NaN)).toBe('0');
    expect(contributorBucket(-1)).toBe('0');
  });

  it('only ever returns a listed bucket', () => {
    for (let n = -2; n < 40; n++) expect(CONTRIBUTOR_BUCKETS).toContain(contributorBucket(n));
  });
});

describe('detectContributors', () => {
  it('runs three read-only git commands in the semantic directory and returns only the bucket and the key', async () => {
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];
    const git = fakeGit();
    const found = await detectContributors('/repo/.erd-studio', async (cwd, args) => {
      calls.push({ cwd, args });
      return git(cwd, args);
    });
    expect(found).toEqual({ contributors: '2-3', repoKey: repoKeyOf(ROOT) });
    expect(calls).toEqual([
      { cwd: '/repo/.erd-studio', args: contributorLogArgs('.') },
      { cwd: '/repo/.erd-studio', args: SHALLOW_ARGS },
      { cwd: '/repo/.erd-studio', args: ROOT_COMMIT_ARGS },
    ]);
    expect(JSON.stringify(found)).not.toMatch(/example|@|repo\//);
  });

  it('only ever reads: log, rev-parse and rev-list, with no pager or fsmonitor', () => {
    expect(SHALLOW_ARGS).toEqual(['--no-pager', '-c', 'core.fsmonitor=false', 'rev-parse', '--is-shallow-repository']);
    expect(ROOT_COMMIT_ARGS).toEqual(['--no-pager', '-c', 'core.fsmonitor=false', 'rev-list', '--max-parents=0', 'HEAD']);
  });

  it('sends no key from a shallow clone, whose oldest commit is not the first', async () => {
    expect(await detectContributors('/r', fakeGit({ shallow: 'true\n' }))).toEqual({ contributors: '2-3' });
    expect(await detectContributors('/r', fakeGit({ shallow: '' }))).toEqual({ contributors: '2-3' });
  });

  it('keeps the bucket when the key cannot be made', async () => {
    expect(await detectContributors('/r', fakeGit({ fail: 'rev' }))).toEqual({ contributors: '2-3' });
    expect(await detectContributors('/r', fakeGit({ roots: '' }))).toEqual({ contributors: '2-3' });
  });

  it('asks git for the mailmapped author email of the last 90 days under the path, with no pager or fsmonitor', () => {
    expect(contributorLogArgs('.')).toEqual([
      '--no-pager', '-c', 'core.fsmonitor=false', 'log', '--since=90.days.ago', '--max-count=5000', '--format=%aE', '--', '.',
    ]);
  });

  it('is 0 for a repository with no commit under the directory', async () => {
    expect((await detectContributors('/repo/.erd-studio', async () => ''))?.contributors).toBe('0');
  });

  it('is undefined (nothing sent) when git is missing, fails or times out', async () => {
    expect(await detectContributors('/repo/.erd-studio', async () => { throw new Error('ENOENT'); })).toBeUndefined();
    expect(await detectContributors('/repo/.erd-studio', fakeGit({ fail: 'log' }))).toBeUndefined();
  });

  it('counts this repository with the real git runner', async () => {
    const found = await detectContributors(path.resolve(__dirname, '../../docs'));
    if (found !== undefined) {
      expect(CONTRIBUTOR_BUCKETS).toContain(found.contributors);
      if (found.repoKey !== undefined) expect(found.repoKey).toMatch(REPO_KEY_PATTERN);
    }
  });
});

describe('repoKeyOf', () => {
  it('is 12 hex characters, the same for every clone of one first commit', () => {
    const key = repoKeyOf(`${ROOT}\n`);
    expect(key).toMatch(REPO_KEY_PATTERN);
    expect(repoKeyOf(`  ${ROOT.toUpperCase()}\r\n`)).toBe(key);
  });

  it('is a hash, not a piece of the commit id', () => {
    expect(ROOT).not.toContain(repoKeyOf(ROOT)!);
  });

  it('differs between repositories', () => {
    expect(repoKeyOf(OTHER_ROOT)).not.toBe(repoKeyOf(ROOT));
  });

  it('picks the same commit whatever order joined histories list their roots in', () => {
    expect(repoKeyOf(`${ROOT}\n${OTHER_ROOT}\n`)).toBe(repoKeyOf(`${OTHER_ROOT}\n${ROOT}\n`));
    expect(repoKeyOf(`${ROOT}\n${OTHER_ROOT}\n`)).toBe(repoKeyOf(OTHER_ROOT));
  });

  it('reads a SHA-256 repository too, and nothing that is not a commit id', () => {
    expect(repoKeyOf('a'.repeat(64))).toMatch(REPO_KEY_PATTERN);
    for (const junk of ['', 'fatal: bad revision HEAD', 'main', 'a'.repeat(39), 'https://github.com/acme/warehouse']) {
      expect(repoKeyOf(junk)).toBeUndefined();
    }
  });
});

describe('the module keeps what it reads to itself', () => {
  it('imports no vscode and no logger', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../src/services/contributorCount.ts'), 'utf8');
    expect(/from\s+['"]vscode['"]/.test(text)).toBe(false);
    expect(/logger/.test(text)).toBe(false);
  });
});
