/**
 * prerelease.yml publishes an opt-in pre-release from any ref. These pin the
 * properties that keep it from touching the stable channel or any branch:
 * manual only, --pre-release on the package and both publishes, the version set
 * only in the run's checkout (no commit, no push), no npm publish, a GitHub
 * pre-release that is never "Latest" under its own tag prefix, and validation
 * plus the telemetry check before anything is built.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
  'working-directory'?: string;
};
type Job = { permissions?: Record<string, string>; steps: Step[] };
type Workflow = {
  on: Record<string, { inputs?: Record<string, { required?: boolean; type?: string }> }>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

const source = readFileSync(resolve(__dirname, '../../.github/workflows/prerelease.yml'), 'utf8');
const workflow = parse(source) as Workflow;
const deploy = parse(
  readFileSync(resolve(__dirname, '../../.github/workflows/deploy.yml'), 'utf8'),
) as { concurrency: { group: string } };
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const runs = steps.map((s) => s.run ?? '').join('\n');
// Shell lines only, without comments, so prose in a comment cannot satisfy or break a check.
const commands = runs
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

function indexOf(predicate: (s: Step) => boolean): number {
  const index = steps.findIndex(predicate);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}
const commandsMatching = (pattern: RegExp) => commands.filter((line) => pattern.test(line));

describe('prerelease.yml', () => {
  it('runs only on workflow_dispatch, with a required ref and version', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const inputs = workflow.on.workflow_dispatch.inputs ?? {};
    expect(inputs.ref?.required).toBe(true);
    expect(inputs.version?.required).toBe(true);
  });

  it('never shares the stable deploy concurrency group', () => {
    expect(workflow.concurrency.group).not.toBe(deploy.concurrency.group);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.permissions).toEqual({});
  });

  it('packages and publishes with --pre-release everywhere', () => {
    const vscePackage = commandsMatching(/vsce package/);
    const vscePublish = commandsMatching(/vsce publish/);
    const ovsxPublish = commandsMatching(/ovsx@?\S* publish/);
    for (const lines of [vscePackage, vscePublish, ovsxPublish]) {
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toContain('--pre-release');
      }
    }
    for (const line of [...vscePublish, ...ovsxPublish]) {
      expect(line).toContain('--packagePath');
      expect(line).toContain('--skip-duplicate');
    }
  });

  it('Open VSX is non-fatal, like deploy.yml', () => {
    const step = steps[indexOf((s) => /ovsx@?\S* publish/.test(s.run ?? ''))];
    expect(step['continue-on-error']).toBe(true);
  });

  it('sets the version only in the checkout: no commit, push or tag push', () => {
    expect(commandsMatching(/npm version/)).toEqual([
      'npm version "$VERSION" --no-git-tag-version --allow-same-version',
    ]);
    expect(commandsMatching(/\bgit (push|commit|tag)\b/)).toEqual([]);
    for (const step of steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) {
      expect(step.with?.['persist-credentials']).toBe(false);
    }
  });

  it('never publishes the npm packages', () => {
    expect(commandsMatching(/npm publish|release-packages/)).toEqual([]);
  });

  it('the GitHub Release is a pre-release, never Latest, under its own tag prefix', () => {
    const create = steps[indexOf((s) => /gh release create/.test(s.run ?? ''))].run ?? '';
    expect(create).toContain('--prerelease');
    expect(create).toContain('--latest=false');
    expect(create).toMatch(/TAG="prerelease-v\$\{VERSION\}"/);
    expect(create).toContain('gh release create "$TAG"');
  });

  it('validates the version and the telemetry Worker before building anything', () => {
    const validate = indexOf((s) => /release\.mjs check-prerelease/.test(s.run ?? ''));
    const telemetry = indexOf((s) => /telemetry-worker-deployed/.test(JSON.stringify(s.env ?? {})));
    const install = indexOf((s) => /^npm ci$/m.test(s.run ?? ''));
    const pack = indexOf((s) => /vsce package/.test(s.run ?? ''));
    expect(validate).toBeLessThan(install);
    expect(telemetry).toBeLessThan(install);
    expect(install).toBeLessThan(pack);
    // The checks come from the workflow's own commit, not the ref being released.
    expect(steps[validate].run).toContain('../tooling/scripts/release.mjs');
  });

  it('runs the stable deploy’s compile, build and tests before packaging', () => {
    const pack = indexOf((s) => /vsce package/.test(s.run ?? ''));
    for (const script of ['npm run compile', 'npm run build', 'npm run test']) {
      expect(indexOf((s) => (s.run ?? '').trim() === script)).toBeLessThan(pack);
    }
    expect(commandsMatching(/-gt 60/).length).toBe(1);
  });

  it('never deploys the telemetry Worker or moves its tag', () => {
    expect(steps.some((s) => s.uses?.startsWith('cloudflare/wrangler-action'))).toBe(false);
    expect(commandsMatching(/wrangler/)).toEqual([]);
  });

  it('a re-run proves it is finishing the same commit', () => {
    // The first attempt tags the commit before it publishes; validation hands the
    // tag's commit and HEAD to check-prerelease, which refuses a mismatch on --rerun.
    const validate = steps[indexOf((s) => /release\.mjs check-prerelease/.test(s.run ?? ''))].run ?? '';
    expect(validate).toContain('--head "$HEAD_SHA"');
    expect(validate).toContain('--tag-commit "$TAG_COMMIT"');
    const tag = indexOf((s) => /git\/refs/.test(s.run ?? '') && /HEAD_SHA/.test(s.run ?? ''));
    const publish = indexOf((s) => /vsce publish/.test(s.run ?? ''));
    expect(tag).toBeLessThan(publish);
    // The release never replaces an asset, and never creates its tag anywhere else.
    expect(commandsMatching(/--clobber/)).toEqual([]);
    const release = steps[indexOf((s) => /gh release create/.test(s.run ?? ''))].run ?? '';
    expect(release).toContain('--verify-tag');
    expect(release).not.toContain('--target');
  });

  it('passes inputs to shell scripts through env, never interpolated', () => {
    for (const step of steps) {
      expect(step.run ?? '').not.toMatch(/\$\{\{\s*inputs\./);
    }
  });
});
