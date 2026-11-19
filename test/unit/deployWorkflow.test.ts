/**
 * deploy.yml keeps its "does not ship in the VSIX" list in two places: the
 * trigger's `paths` (whether the workflow starts at all) and the `changes`
 * job's paths-filter steps (whether a run that did start publishes the
 * extension). They must agree, except that telemetry/** starts the workflow —
 * so the Worker can deploy — without releasing the extension.
 *
 * The trigger reads its patterns in order and the last one a file matches
 * decides, so it can exclude a path (`!docs/**`) and bring part of it back
 * (the example projects under docs/examples, inlined into the bundle).
 * paths-filter cannot: an exclusion is final there. So `changes` asks twice —
 * "outside every `!` pattern" (`every`) or "matches a re-include" (`some`) —
 * and this file both checks the lists line up and runs both readings on
 * sample paths and on the real tree.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { bundledExampleIds, exampleFiles } from '../../src/services/exampleProjects';

type Step = { id?: string; name?: string; uses?: string; run?: string; with?: Record<string, string | number | boolean> };
type Job = {
  needs?: string | string[];
  if?: string;
  steps?: Step[];
  outputs?: Record<string, string>;
  'timeout-minutes'?: number;
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> };
};
type Workflow = {
  on: { pull_request: { paths?: string[]; 'paths-ignore'?: string[] } };
  jobs: Record<string, Job>;
};

const ROOT = resolve(__dirname, '../..');
const workflow = parse(readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8')) as Workflow;
const triggerPaths = workflow.on.pull_request.paths ?? [];
/** The trigger's `!` patterns (what never ships), without the `!`. */
const ignored = triggerPaths.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
/** The trigger's plain patterns after its `!` list: shipped although under an ignored path. */
const reincluded = triggerPaths.slice(triggerPaths.findLastIndex((p) => p.startsWith('!')) + 1);

function filterStep(id: string, quantifier: string): string[] {
  const step = workflow.jobs.changes.steps?.find((s) => s.id === id);
  expect(step?.uses).toMatch(/^dorny\/paths-filter@/);
  expect(step?.with?.['predicate-quantifier']).toBe(quantifier);
  const filters = parse(String(step?.with?.filters ?? '')) as Record<string, string[]>;
  expect(Object.keys(filters)).toEqual(['extension']);
  return filters.extension;
}
/** `changes` step 1: a file outside every `!` pattern. */
const extensionFilter = () => filterStep('filter', 'every');
/** `changes` step 2: a file matching any re-include. */
const inlinedFilter = () => filterStep('inlined', 'some');

/**
 * A filter pattern as a RegExp, for the syntax both engines read the same way:
 * literal characters, `*` (any characters but `/`) and `**` as a whole path
 * segment (any number of segments, dot-folders included). GitHub's cheat sheet
 * defines no special dot handling and paths-filter runs picomatch with
 * `dot: true`; `?`, `+`, `[]`, braces and extglobs differ between the two, so
 * the test below refuses them.
 */
function globToRegExp(glob: string): RegExp {
  const segments = glob.split('/');
  const escape = (text: string) => text.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  const body = segments.map((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === '**') return last ? '.*' : '(?:[^/]*/)*';
    return segment.split('*').map(escape).join('[^/]*') + (last ? '' : '/');
  }).join('');
  return new RegExp(`^${body}$`);
}
const matches = (glob: string, file: string) => globToRegExp(glob).test(file);

/** GitHub's `paths`: the last pattern a file matches decides; `!` excludes. */
function triggerIncludes(file: string): boolean {
  let included = false;
  for (const pattern of triggerPaths) {
    if (pattern.startsWith('!')) { if (matches(pattern.slice(1), file)) included = false; }
    else if (matches(pattern, file)) included = true;
  }
  return included;
}

/** paths-filter: `every` pattern must match (a `!` one by not matching), or `some` re-include does. */
function changesShips(file: string): boolean {
  const outside = extensionFilter().every((p) => (p.startsWith('!') ? !matches(p.slice(1), file) : matches(p, file)));
  return outside || inlinedFilter().some((p) => matches(p, file));
}

/** Every file under `dir` (repo-relative, posix), dotfiles included, OS junk not. */
function filesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.DS_Store') return [];
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}

const SHA_REF = '${{ needs.changes.outputs.sha }}';
const checkoutOf = (job: string) => workflow.jobs[job].steps?.find((s) => s.uses?.startsWith('actions/checkout@'));
const runs = (job: string) => (workflow.jobs[job].steps ?? []).map((s) => (s.run ?? '').trim());

describe('deploy.yml', () => {
  it('the trigger is everything, then the `!` list, then the re-includes', () => {
    // `paths-ignore` cannot bring a file back, and cannot sit beside `paths`.
    expect(workflow.on.pull_request['paths-ignore']).toBeUndefined();
    expect(triggerPaths[0]).toBe('**');
    expect(ignored.length).toBeGreaterThan(0);
    expect(reincluded.length).toBeGreaterThan(0);
    expect(triggerPaths).toEqual(['**', ...ignored.map((p) => `!${p}`), ...reincluded]);
  });

  it('the extension filter excludes exactly the trigger ignores plus telemetry/**', () => {
    const [first, ...rest] = extensionFilter();
    expect(first).toBe('**');
    expect(rest.every((p) => p.startsWith('!'))).toBe(true);
    expect(rest.map((p) => p.slice(1)).sort()).toEqual([...ignored, 'telemetry/**'].sort());
  });

  it('the inlined filter is exactly the trigger re-includes, and either one releases', () => {
    expect([...inlinedFilter()].sort()).toEqual([...reincluded].sort());
    expect(workflow.jobs.changes.outputs?.extension).toBe(
      "${{ steps.filter.outputs.extension == 'true' || steps.inlined.outputs.extension == 'true' }}",
    );
  });

  it('every pattern sticks to the syntax GitHub and paths-filter read alike', () => {
    for (const p of [...triggerPaths, ...extensionFilter(), ...inlinedFilter()]) {
      const glob = p.replace(/^!/, '');
      expect(glob, p).not.toMatch(/[?+[\]{}()!]/);
      // `**` only as a whole segment (`**.js` means different things to the two).
      for (const segment of glob.split('/')) expect(segment === '**' || !segment.includes('**'), p).toBe(true);
    }
  });

  // [path, starts the workflow, releases the extension]
  const SAMPLES: Array<[string, boolean, boolean]> = [
    // Inlined into dist/extension.js by scripts/exampleBundle.cjs: ships.
    ['docs/examples/medallion/.erd-studio/silver/tables/orders.dbml', true, true],
    ['docs/examples/medallion/.erd-studio/layers.json', true, true],
    ['docs/examples/medallion/.erd-studio/README.md', true, true],
    ['docs/examples/medallion/README.md', true, true],
    ['docs/examples/enterprise-warehouse/.github/CODEOWNERS', true, true],
    ['docs/examples/a-new-example/.erd-studio/gold/diagrams/x.dbml', true, true],
    // The examples index and every other doc: not read, never ships.
    ['docs/examples/README.md', false, false],
    ['docs/dbt.md', false, false],
    ['docs/dev/releasing.md', false, false],
    ['docs/dev/x.md', false, false],
    ['docs/assets/hero.gif', false, false],
    ['docs/a-new-folder/notes.txt', false, false],
    ['docs/plans/a-new-folder/x.json', false, false],
    // The setup-skill markdown is inlined by the '.md' text loader; its CLAUDE.md is not.
    ['src/harness/claude/erd-studio-setup/SKILL.md', true, true],
    ['src/harness/claude/erd-studio-setup/references/dbt-setup.md', true, true],
    ['src/harness/CLAUDE.md', false, false],
    // Unchanged by the re-includes.
    ['src/extension.ts', true, true],
    ['package.json', true, true],
    ['.vscodeignore', true, true],
    ['README.md', false, false],
    ['packages/core/README.md', false, false],
    ['.github/workflows/deploy.yml', false, false],
    ['.claude/skills/x/SKILL.md', false, false],
    ['test/fixtures/dbt-project/.erd-studio/silver/showcase.dbml', false, false],
    ['proxy/src/index.ts', false, false],
    ['telemetry/src/index.ts', true, false],
  ];

  it.each(SAMPLES)('%s: starts the workflow %s, releases %s', (file, starts, releases) => {
    expect(triggerIncludes(file)).toBe(starts);
    expect(changesShips(file)).toBe(releases);
  });

  it('every file the example bundle inlines releases; no other file under docs/ does', () => {
    const ids = bundledExampleIds();
    expect(ids.length).toBeGreaterThan(0);
    const bundled = new Set(ids.flatMap((id) => Object.keys(exampleFiles(id)).map((rel) => `docs/examples/${id}/${rel}`)));
    for (const file of bundled) {
      expect(triggerIncludes(file), file).toBe(true);
      expect(changesShips(file), file).toBe(true);
    }
    // A folder under docs/examples without `.erd-studio/` is not bundled but
    // would release: harmless, and the pattern cannot tell the two apart.
    for (const file of filesUnder('docs').filter((f) => !bundled.has(f) && !/^docs\/examples\/[^/]+\//.test(f))) {
      expect(triggerIncludes(file), file).toBe(false);
      expect(changesShips(file), file).toBe(false);
    }
  });

  it('every markdown file the extension imports releases', () => {
    const sources = ['src', 'webview'].flatMap(filesUnder).filter((f) => /\.tsx?$/.test(f));
    const imported = new Set<string>();
    for (const source of sources) {
      for (const m of readFileSync(join(ROOT, source), 'utf8').matchAll(/from\s+'(\.[^']+\.md)'/g)) {
        imported.add(relative(ROOT, resolve(ROOT, source, '..', m[1])).split('\\').join('/'));
      }
    }
    expect(imported.size).toBeGreaterThan(0);
    for (const file of imported) {
      expect(triggerIncludes(file), file).toBe(true);
      expect(changesShips(file), file).toBe(true);
    }
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

// Kept here, beside deploy.yml's checks, because this file never starts a release.
describe('issue-to-routine.yml', () => {
  const routine = parse(readFileSync(resolve(ROOT, '.github/workflows/issue-to-routine.yml'), 'utf8')) as {
    on: { issues: { types: string[] } };
    concurrency: { group: string; 'cancel-in-progress': boolean };
    jobs: Record<string, Job>;
  };

  it('another label added at the same time can never cancel the issue-to-pr run', () => {
    // One run per label added; a group keeps only its newest pending run, so the
    // label name must be in the group or an unrelated label's run displaces it.
    expect(routine.on.issues.types).toEqual(['labeled']);
    expect(routine.jobs.fire.if).toContain("github.event.label.name == 'issue-to-pr'");
    expect(routine.concurrency.group).toContain('${{ github.event.issue.number }}');
    expect(routine.concurrency.group).toContain('${{ github.event.label.name }}');
    // Two issue-to-pr events for one issue still never fire at the same time.
    expect(routine.concurrency['cancel-in-progress']).toBe(false);
  });
});
