import { describe, it, expect } from 'vitest';
import {
  PACKAGES,
  latestPublishedVersion,
  planPackages,
  applyPlanToManifest,
  shippedPathspec,
  // @ts-expect-error — plain ESM helper without type declarations (used by publish-packages.yml)
} from '../../scripts/release-packages.mjs';

const core = (version: string) => ({ name: '@erd-studio/core', version, dependencies: { yaml: '^2.9.0' } });
const renderer = (version: string, corePin: string) => ({
  name: '@erd-studio/renderer',
  version,
  dependencies: { '@erd-studio/core': corePin, zustand: '^5.0.0' },
});

function inputs(
  c: { manifest: object; published: string | null; changed: boolean },
  r: { manifest: object; published: string | null; changed: boolean },
) {
  return [
    { name: '@erd-studio/core', dir: 'packages/core', ...c },
    { name: '@erd-studio/renderer', dir: 'packages/renderer', ...r },
  ];
}

describe('release-packages.mjs — latestPublishedVersion', () => {
  it('takes the highest stable version from an npm view array', () => {
    expect(latestPublishedVersion(['0.1.0', '0.1.10', '0.1.9', '0.2.0-beta.1'])).toBe('0.1.10');
  });

  it('accepts the bare string npm prints for a single version', () => {
    expect(latestPublishedVersion('0.1.0')).toBe('0.1.0');
  });

  it('returns null when nothing is published', () => {
    expect(latestPublishedVersion(null)).toBeNull();
    expect(latestPublishedVersion([])).toBeNull();
  });
});

describe('release-packages.mjs — planPackages', () => {
  it('skips both packages when nothing shipped changed', () => {
    const plan = planPackages(
      inputs(
        { manifest: core('0.2.0'), published: '0.2.0', changed: false },
        { manifest: renderer('0.2.0', '0.2.0'), published: '0.2.0', changed: false },
      ),
    );
    expect(plan.map((e: { next: string | null }) => e.next)).toEqual([null, null]);
  });

  it('patch-bumps a changed core and re-pins the renderer, which is bumped with it', () => {
    const plan = planPackages(
      inputs(
        { manifest: core('0.2.0'), published: '0.2.0', changed: true },
        { manifest: renderer('0.2.0', '0.2.0'), published: '0.2.0', changed: false },
      ),
    );
    expect(plan[0]).toMatchObject({ next: '0.2.1', reason: 'changed since 0.2.0' });
    expect(plan[1]).toMatchObject({ next: '0.2.1', reason: 're-pins @erd-studio/core@0.2.1' });
  });

  it('publishes only the renderer when only the renderer changed', () => {
    const plan = planPackages(
      inputs(
        { manifest: core('0.2.0'), published: '0.2.0', changed: false },
        { manifest: renderer('0.2.3', '0.2.0'), published: '0.2.3', changed: true },
      ),
    );
    expect(plan.map((e: { next: string | null }) => e.next)).toEqual([null, '0.2.4']);
  });

  it('publishes a version the PR set ahead of npm as is (a minor release, or a retried one)', () => {
    const plan = planPackages(
      inputs(
        { manifest: core('0.3.0'), published: '0.2.5', changed: true },
        { manifest: renderer('0.3.0', '0.3.0'), published: '0.2.5', changed: false },
      ),
    );
    expect(plan.map((e: { next: string | null }) => e.next)).toEqual(['0.3.0', '0.3.0']);
  });

  it('bumps from npm when package.json has fallen behind it', () => {
    const plan = planPackages(
      inputs(
        { manifest: core('0.2.0'), published: '0.2.4', changed: true },
        { manifest: renderer('0.2.4', '0.2.4'), published: '0.2.4', changed: false },
      ),
    );
    expect(plan.map((e: { next: string | null }) => e.next)).toEqual(['0.2.5', '0.2.5']);
  });

  it('publishes the package.json version of a package npm does not have yet', () => {
    const plan = planPackages(
      inputs(
        { manifest: core('0.1.0'), published: null, changed: true },
        { manifest: renderer('0.1.0', '0.1.0'), published: null, changed: true },
      ),
    );
    expect(plan.map((e: { next: string | null }) => e.next)).toEqual(['0.1.0', '0.1.0']);
  });

  it('rejects a version that is not x.y.z', () => {
    expect(() =>
      planPackages(
        inputs(
          { manifest: core('next'), published: '0.2.0', changed: true },
          { manifest: renderer('0.2.0', '0.2.0'), published: '0.2.0', changed: false },
        ),
      ),
    ).toThrow(/not x\.y\.z/);
  });
});

describe('release-packages.mjs — applyPlanToManifest', () => {
  const plan = [
    { name: '@erd-studio/core', next: '0.2.1' },
    { name: '@erd-studio/renderer', next: '0.2.1' },
  ];

  it('sets the package version and pins internal dependencies exactly', () => {
    const updated = applyPlanToManifest(renderer('0.2.0', '0.2.0'), plan);
    expect(updated.version).toBe('0.2.1');
    expect(updated.dependencies).toEqual({ '@erd-studio/core': '0.2.1', zustand: '^5.0.0' });
  });

  it('updates the root manifest dependencies without touching its own version', () => {
    const root = {
      name: 'erd-studio',
      version: '1.6.7',
      dependencies: { '@erd-studio/core': '0.2.0', '@erd-studio/renderer': '0.2.0', react: '^18.3.0' },
    };
    const updated = applyPlanToManifest(root, plan);
    expect(updated.version).toBe('1.6.7');
    expect(updated.dependencies).toEqual({
      '@erd-studio/core': '0.2.1',
      '@erd-studio/renderer': '0.2.1',
      react: '^18.3.0',
    });
  });

  it('leaves a skipped package alone', () => {
    const updated = applyPlanToManifest(core('0.2.0'), [{ name: '@erd-studio/core', next: null }]);
    expect(updated).toEqual(core('0.2.0'));
  });
});

describe('release-packages.mjs — package list', () => {
  it('lists packages in dependency order, matching the workspace manifests', async () => {
    const fs = await import('node:fs');
    const names = PACKAGES.map((p: { name: string; dir: string }) => {
      const manifest = JSON.parse(fs.readFileSync(`${p.dir}/package.json`, 'utf8'));
      expect(manifest.name).toBe(p.name);
      expect(manifest.publishConfig?.access).toBe('public');
      return p.name;
    });
    expect(names).toEqual(['@erd-studio/core', '@erd-studio/renderer']);
    const rendererManifest = JSON.parse(fs.readFileSync('packages/renderer/package.json', 'utf8'));
    const coreManifest = JSON.parse(fs.readFileSync('packages/core/package.json', 'utf8'));
    // The renderer pins core exactly, to the version in the repo.
    expect(rendererManifest.dependencies['@erd-studio/core']).toBe(coreManifest.version);
  });

  it('excludes tests from the shipped-files diff', () => {
    expect(shippedPathspec('packages/core')).toEqual([
      '--',
      'packages/core',
      ':(exclude)packages/core/test',
      ':(exclude)packages/core/vitest.config.ts',
    ]);
  });
});
