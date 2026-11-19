/**
 * deploy.yml keeps its "does not ship in the VSIX" list in two places: the
 * trigger's `paths-ignore` (whether the workflow starts at all) and the
 * `changes` job's `extension` filter (whether a run that did start publishes
 * the extension). They must agree, except that telemetry/** starts the
 * workflow — so the Worker can deploy — without releasing the extension.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { id?: string; name?: string; uses?: string; run?: string; with?: Record<string, string | number | boolean> };
type Job = {
  needs?: string | string[];
  if?: string;
  steps?: Step[];
  'timeout-minutes'?: number;
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> };
};
type Workflow = {
  on: { pull_request: { 'paths-ignore': string[] } };
  jobs: Record<string, Job>;
};

const workflow = parse(
  readFileSync(resolve(__dirname, '../../.github/workflows/deploy.yml'), 'utf8'),
) as Workflow;
const ignored = workflow.on.pull_request['paths-ignore'];

function extensionFilter(): string[] {
  const step = workflow.jobs.changes.steps?.find((s) => s.id === 'filter');
  expect(step?.uses).toMatch(/^dorny\/paths-filter@/);
  expect(step?.with?.['predicate-quantifier']).toBe('every');
  return (parse(String(step?.with?.filters ?? '')) as { extension: string[] }).extension;
}

const SHA_REF = '${{ needs.changes.outputs.sha }}';
const checkoutOf = (job: string) => workflow.jobs[job].steps?.find((s) => s.uses?.startsWith('actions/checkout@'));
const runs = (job: string) => (workflow.jobs[job].steps ?? []).map((s) => (s.run ?? '').trim());

describe('deploy.yml', () => {
  it('the extension filter excludes exactly the trigger ignores plus telemetry/**', () => {
    const [first, ...rest] = extensionFilter();
    expect(first).toBe('**');
    expect(rest.every((p) => p.startsWith('!'))).toBe(true);
    expect(rest.map((p) => p.slice(1)).sort()).toEqual([...ignored, 'telemetry/**'].sort());
  });

  it('a telemetry-only merge starts the workflow; proxy/** never ships', () => {
    expect(ignored.some((p) => p.startsWith('telemetry'))).toBe(false);
    expect(ignored).toContain('proxy/**');
  });

  it('the extension waits for the Worker and never follows a failed one', () => {
    const deploy = workflow.jobs.deploy;
    expect(deploy.needs).toEqual(expect.arrayContaining(['changes', 'telemetry-worker']));
    expect(deploy.if).toContain('!cancelled()');
    expect(deploy.if).toContain("needs.changes.outputs.extension == 'true'");
    expect(deploy.if).toContain("needs.telemetry-worker.result == 'success' || needs.telemetry-worker.result == 'skipped'");
    expect(workflow.jobs['telemetry-worker'].needs).toBe('changes');
  });

  it('release tooling and the pre-release workflow never start a stable release', () => {
    for (const path of ['.github/**', 'scripts/release.mjs', 'test/unit/release.test.ts', 'test/unit/prereleaseWorkflow.test.ts']) {
      expect(ignored).toContain(path);
    }
  });

  it('the import corpus runs only by hand and its tooling never starts a release', () => {
    const corpus = parse(readFileSync(resolve(__dirname, '../../.github/workflows/import-corpus.yml'), 'utf8')) as { on: Record<string, unknown> };
    expect(Object.keys(corpus.on)).toEqual(['workflow_dispatch']);
    for (const path of ['.github/**', 'scripts/corpus/**', 'test/unit/importCorpus.score.test.ts']) {
      expect(ignored).toContain(path);
    }
  });

  it('the stable GitHub Release is Latest and never a pre-release', () => {
    const run = workflow.jobs.deploy.steps?.find((s) => /gh release create/.test(s.run ?? ''))?.run ?? '';
    expect(run).toContain('gh release create "v${NEW_VERSION}"');
    expect(run).toContain('--latest');
    expect(run).not.toContain('--latest=false');
    expect(run).not.toContain('--prerelease');
  });

  it('build and the four test shards gate the release and run only when one happens', () => {
    const deploy = workflow.jobs.deploy;
    expect(deploy.needs).toEqual(expect.arrayContaining(['build', 'verify']));
    expect(deploy.if).toContain("needs.build.result == 'success'");
    expect(deploy.if).toContain("needs.verify.result == 'success'");
    for (const job of ['build', 'verify']) {
      expect(workflow.jobs[job].needs).toBe('changes');
      expect(workflow.jobs[job].if).toBe("needs.changes.outputs.extension == 'true'");
    }
    const verify = workflow.jobs.verify;
    expect(verify.strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
    expect(verify.strategy?.['fail-fast']).toBe(false);
    // The same script as `npm run test`, so the shards together run its whole file list.
    expect(runs('verify')).toContain('npm run test -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}');
    // Every check the release ran before the split still runs before it publishes.
    expect(runs('build')).toEqual(expect.arrayContaining(['npm run compile', 'npm run build']));
    expect(runs('deploy').some((r) => /npm (run )?test|npm run compile/.test(r))).toBe(false);
  });

  it('build, verify and deploy check out the one commit `changes` saw', () => {
    for (const job of ['build', 'verify', 'deploy', 'telemetry-worker']) {
      expect(checkoutOf(job)?.with?.ref).toBe(SHA_REF);
    }
    // A rebased bump may only bring in release bookkeeping, never untested code.
    const commit = runs('deploy').find((r) => r.includes('git pull --rebase origin main')) ?? '';
    expect(commit).toContain('"${SHA}..origin/main"');
    expect(commit.indexOf('only_bookkeeping_since_tested;')).toBeGreaterThan(commit.indexOf('git pull --rebase origin main'));
  });

  it('every job has a timeout and no setup-node caches implicitly', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job['timeout-minutes'], name).toBeGreaterThan(0);
      for (const step of (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/setup-node@'))) {
        expect(step.with?.['node-version'], name).toBe(24);
        expect(step.with?.cache === 'npm' || step.with?.['package-manager-cache'] === false, name).toBe(true);
      }
    }
  });
});
