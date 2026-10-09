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

type Step = { id?: string; uses?: string; with?: Record<string, string> };
type Job = { needs?: string | string[]; if?: string; steps?: Step[] };
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
  return (parse(step?.with?.filters ?? '') as { extension: string[] }).extension;
}

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
});
