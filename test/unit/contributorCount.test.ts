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
} from '../../src/services/contributorCount';
import { CONTRIBUTOR_BUCKETS } from '../../src/services/telemetryPayload';

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
  it('runs one read-only git log in the semantic directory and returns only the bucket', async () => {
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];
    const found = await detectContributors('/repo/.erd-studio', async (cwd, args) => {
      calls.push({ cwd, args });
      return 'ana@example.com\nben@example.com\nana@example.com\n';
    });
    expect(found).toBe('2-3');
    expect(calls).toEqual([{ cwd: '/repo/.erd-studio', args: contributorLogArgs('.') }]);
  });

  it('asks git for the mailmapped author email of the last 90 days under the path, with no pager or fsmonitor', () => {
    expect(contributorLogArgs('.')).toEqual([
      '--no-pager', '-c', 'core.fsmonitor=false', 'log', '--since=90.days.ago', '--max-count=5000', '--format=%aE', '--', '.',
    ]);
  });

  it('is 0 for a repository with no commit under the directory', async () => {
    expect(await detectContributors('/repo/.erd-studio', async () => '')).toBe('0');
  });

  it('is undefined (nothing sent) when git is missing, fails or times out', async () => {
    expect(await detectContributors('/repo/.erd-studio', async () => { throw new Error('ENOENT'); })).toBeUndefined();
  });

  it('counts this repository with the real git runner', async () => {
    const found = await detectContributors(path.resolve(__dirname, '../../docs'));
    if (found !== undefined) expect(CONTRIBUTOR_BUCKETS).toContain(found);
  });
});

describe('the module keeps what it reads to itself', () => {
  it('imports no vscode and no logger', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../src/services/contributorCount.ts'), 'utf8');
    expect(/from\s+['"]vscode['"]/.test(text)).toBe(false);
    expect(/logger/.test(text)).toBe(false);
  });
});
