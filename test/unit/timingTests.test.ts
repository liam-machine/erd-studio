/**
 * test/timingTests.ts splits the suite for CI: the four `test` shards run
 * ERD_TEST_SET=main (every file but the wall-clock-budget ones), and
 * `test-timing` runs ERD_TEST_SET=timing (only those, one at a time). A
 * renamed file, or a job that drops its switch, would quietly stop running
 * tests (or run them twice), so both sides are pinned here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { TIMING_TEST_FILES } from '../timingTests';

type Step = { run?: string; env?: Record<string, string> };
type Job = { strategy?: { matrix?: { shard?: number[] } }; steps?: Step[] };

const ROOT = resolve(__dirname, '../..');
const ci = parse(readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> };

/** The job's one `npm run test` step. */
function testStep(job: string): Step {
  const steps = (ci.jobs[job]?.steps ?? []).filter((s) => /^npm run test\b/.test(s.run ?? ''));
  expect(steps, `${job} has one npm run test step`).toHaveLength(1);
  return steps[0];
}

describe('the wall-clock-budget test files (test/timingTests.ts)', () => {
  it('lists test files that exist, each once', () => {
    expect(TIMING_TEST_FILES.length).toBeGreaterThan(0);
    expect(new Set(TIMING_TEST_FILES).size).toBe(TIMING_TEST_FILES.length);
    for (const file of TIMING_TEST_FILES) {
      expect(file, file).toMatch(/^(test\/unit|packages\/[^/]+\/test)\/.+\.test\.tsx?$/);
      expect(existsSync(resolve(ROOT, file)), `${file} exists`).toBe(true);
    }
  });

  it('ci.yml shards every other file (ERD_TEST_SET=main) and runs these on their own (ERD_TEST_SET=timing)', () => {
    for (const [job, set] of [['test', 'main'], ['test-timing', 'timing']] as const) {
      const shards = ci.jobs[job]?.strategy?.matrix?.shard ?? [];
      expect(shards.length, `${job} has a shard matrix`).toBeGreaterThan(0);
      expect(shards, `${job} runs every shard`).toEqual(shards.map((_, i) => i + 1));
      const step = testStep(job);
      expect(step.env?.ERD_TEST_SET, job).toBe(set);
      expect(step.run).toBe(`npm run test -- --shard=\${{ matrix.shard }}/${shards.length}`);
    }
  });
});
