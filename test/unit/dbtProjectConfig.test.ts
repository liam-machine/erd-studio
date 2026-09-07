import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  readDbtProjectConfig,
  resolveManifestPath,
  modelPathsGlob,
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

  it('returns dbt defaults when dbt_project.yml is missing', () => {
    expect(readDbtProjectConfig(tmpDir)).toEqual({ targetPath: 'target', modelPaths: ['models'] });
  });

  it('returns dbt defaults when keys are absent', () => {
    write('name: proj\nversion: "1.0"\n');
    expect(readDbtProjectConfig(tmpDir)).toEqual(defaultDbtProjectConfig());
  });

  it('reads target-path and inline model-paths', () => {
    write('name: proj\ntarget-path: build\nmodel-paths: ["models", "extra_models"]\n');
    expect(readDbtProjectConfig(tmpDir)).toEqual({
      targetPath: 'build',
      modelPaths: ['models', 'extra_models'],
    });
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
    expect(readDbtProjectConfig(tmpDir)).toEqual({
      targetPath: 'dbt_target',
      modelPaths: ['models', 'src/models'],
    });
  });

  it('ignores absolute, traversal, empty and non-string entries', () => {
    write('target-path: /abs/target\nmodel-paths: ["../outside", "", 42, "ok_models"]\n');
    expect(readDbtProjectConfig(tmpDir)).toEqual({
      targetPath: 'target',
      modelPaths: ['ok_models'],
    });
  });

  it('returns defaults on malformed YAML', () => {
    write('name: [unclosed\ntarget-path: build\n');
    expect(readDbtProjectConfig(tmpDir)).toEqual(defaultDbtProjectConfig());
  });

  it('does not treat indented keys (e.g. under vars) as project paths', () => {
    write('name: proj\nvars:\n  target-path: nested\n');
    expect(readDbtProjectConfig(tmpDir).targetPath).toBe('target');
  });

  it('resolveManifestPath joins the configured target-path', () => {
    const p = resolveManifestPath('/proj', { targetPath: 'build', modelPaths: ['models'] });
    expect(p).toBe(path.join('/proj', 'build', 'manifest.json'));
  });

  it('modelPathsGlob emits a plain dir for one path and a brace group for many', () => {
    expect(modelPathsGlob({ targetPath: 'target', modelPaths: ['models'] })).toBe('models');
    expect(modelPathsGlob({ targetPath: 'target', modelPaths: ['models', 'marts'] })).toBe('{models,marts}');
    expect(modelPathsGlob({ targetPath: 'target', modelPaths: [] })).toBe('models');
  });
});
