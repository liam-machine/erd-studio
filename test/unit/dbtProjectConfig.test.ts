import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  readDbtProjectConfig,
  resolveManifestPath,
  resolveCatalogPath,
  modelPathsGlob,
  sourcePathsGlob,
  defaultDbtProjectConfig,
} from '../../src/services/dbtProjectConfig';

describe('dbtProjectConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (content: string) =>
    fs.writeFileSync(path.join(tmpDir, 'dbt_project.yml'), content, 'utf-8');

  /** A config literal with the defaults for everything the test does not care about. */
  const config = (overrides: Partial<ReturnType<typeof defaultDbtProjectConfig>> = {}) => ({
    ...defaultDbtProjectConfig(),
    ...overrides,
  });

  it('returns dbt defaults when dbt_project.yml is missing', () => {
    expect(readDbtProjectConfig(tmpDir)).toEqual({
      targetPath: 'target',
      modelPaths: ['models'],
      seedPaths: ['seeds'],
      snapshotPaths: ['snapshots'],
    });
  });

  it('returns dbt defaults when keys are absent', () => {
    write('name: proj\nversion: "1.0"\n');
    expect(readDbtProjectConfig(tmpDir)).toEqual(defaultDbtProjectConfig());
  });

  it('reads target-path and inline model-paths', () => {
    write('name: proj\ntarget-path: build\nmodel-paths: ["models", "extra_models"]\n');
    expect(readDbtProjectConfig(tmpDir)).toEqual(
      config({ targetPath: 'build', modelPaths: ['models', 'extra_models'] })
    );
  });

  it('reads block-sequence model-paths', () => {
    write('name: proj\nmodel-paths:\n  - transform\n  - marts\n');
    expect(readDbtProjectConfig(tmpDir).modelPaths).toEqual(['transform', 'marts']);
  });

  it('falls back to legacy source-paths when model-paths is absent', () => {
    write('name: proj\nsource-paths: ["legacy_models"]\n');
    expect(readDbtProjectConfig(tmpDir).modelPaths).toEqual(['legacy_models']);
  });

  it('normalises ./ prefixes, trailing slashes and backslashes', () => {
    write('target-path: "./dbt_target/"\nmodel-paths: ["./models/", "src\\\\models"]\n');
    expect(readDbtProjectConfig(tmpDir)).toEqual(
      config({ targetPath: 'dbt_target', modelPaths: ['models', 'src/models'] })
    );
  });

  it('ignores absolute, traversal, empty and non-string entries', () => {
    write('target-path: /abs/target\nmodel-paths: ["../outside", "", 42, "ok_models"]\n');
    expect(readDbtProjectConfig(tmpDir)).toEqual(config({ modelPaths: ['ok_models'] }));
  });

  it('returns defaults on malformed YAML', () => {
    write('name: [unclosed\ntarget-path: build\n');
    expect(readDbtProjectConfig(tmpDir)).toEqual(defaultDbtProjectConfig());
  });

  it('does not treat indented keys (e.g. under vars) as project paths', () => {
    write('name: proj\nvars:\n  target-path: nested\n');
    expect(readDbtProjectConfig(tmpDir).targetPath).toBe('target');
  });

  it('reads seed-paths and snapshot-paths', () => {
    write('name: proj\nseed-paths: ["data"]\nsnapshot-paths:\n  - snaps\n  - archive\n');
    expect(readDbtProjectConfig(tmpDir)).toEqual(
      config({ seedPaths: ['data'], snapshotPaths: ['snaps', 'archive'] })
    );
  });

  it('falls back to legacy data-paths when seed-paths is absent', () => {
    write('name: proj\ndata-paths: ["legacy_seeds"]\n');
    expect(readDbtProjectConfig(tmpDir).seedPaths).toEqual(['legacy_seeds']);
  });

  it('normalises and validates seed/snapshot entries like model paths', () => {
    write('seed-paths: ["./data/", "../outside", ""]\nsnapshot-paths: ["src\\\\snaps/"]\n');
    const parsed = readDbtProjectConfig(tmpDir);
    expect(parsed.seedPaths).toEqual(['data']);
    expect(parsed.snapshotPaths).toEqual(['src/snaps']);
  });

  it('resolveManifestPath joins the configured target-path', () => {
    const p = resolveManifestPath('/proj', config({ targetPath: 'build' }));
    expect(p).toBe(path.join('/proj', 'build', 'manifest.json'));
  });

  it('resolveCatalogPath joins the configured target-path', () => {
    expect(resolveCatalogPath('/proj', config({ targetPath: 'build' }))).toBe(
      path.join('/proj', 'build', 'catalog.json')
    );
    expect(resolveCatalogPath('/proj', defaultDbtProjectConfig())).toBe(
      path.join('/proj', 'target', 'catalog.json')
    );
  });

  it('modelPathsGlob emits a plain dir for one path and a brace group for many', () => {
    expect(modelPathsGlob(config({ modelPaths: ['models'] }))).toBe('models');
    expect(modelPathsGlob(config({ modelPaths: ['models', 'marts'] }))).toBe('{models,marts}');
    expect(modelPathsGlob(config({ modelPaths: [] }))).toBe('models');
  });

  it('sourcePathsGlob unions model, seed and snapshot paths', () => {
    expect(sourcePathsGlob(defaultDbtProjectConfig())).toBe('{models,seeds,snapshots}');
    expect(
      sourcePathsGlob(config({ modelPaths: ['models', 'marts'], seedPaths: ['data'], snapshotPaths: ['snaps'] }))
    ).toBe('{models,marts,data,snaps}');
  });

  it('sourcePathsGlob dedupes overlapping directories and emits a bare dir for one', () => {
    const single = config({ modelPaths: ['transform'], seedPaths: ['transform'], snapshotPaths: ['transform'] });
    expect(sourcePathsGlob(single)).toBe('transform');
  });

  it('sourcePathsGlob falls back to dbt defaults for any empty list', () => {
    expect(sourcePathsGlob(config({ seedPaths: [], snapshotPaths: [] }))).toBe('{models,seeds,snapshots}');
  });
});
