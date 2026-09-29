/**
 * projectDiscovery — which dbt project a window opens (#82): the explicit
 * setting, then the per-machine pick, then auto-detection (ERD data first).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findOwningDbtProject, resolveDbtProject } from '../../src/services/projectDiscovery';

let root: string;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-discovery-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function dbt(rel: string, withErd = false): string {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dbt_project.yml'), 'name: x\n');
  if (withErd) { fs.mkdirSync(path.join(dir, '.erd-studio')); }
  return dir;
}

describe('resolveDbtProject', () => {
  it('auto-detects the project with ERD data and reports every candidate', () => {
    const a = dbt('a');
    const b = dbt('b', true);
    const r = resolveDbtProject([a, b]);
    expect(r).toMatchObject({ root: b, source: 'auto', autoRoot: b, candidates: [a, b] });
    expect(r.invalidSetting).toBeUndefined();
  });

  it('a picked project wins over auto-detection', () => {
    const a = dbt('a');
    const b = dbt('b', true);
    expect(resolveDbtProject([a, b], { picked: a })).toMatchObject({ root: a, source: 'picked', autoRoot: b });
  });

  it('ignores a pick that is no longer one of the workspace projects', () => {
    const a = dbt('a');
    const b = dbt('b', true);
    const gone = path.join(root, 'removed');
    expect(resolveDbtProject([a, b], { picked: gone })).toMatchObject({ root: b, source: 'auto' });
  });

  it('erdStudio.projectPath beats a pick', () => {
    const a = dbt('a');
    const b = dbt('b', true);
    expect(resolveDbtProject([a, b], { projectPath: a, picked: b })).toMatchObject({ root: a, source: 'setting' });
  });

  it('reports a projectPath without dbt_project.yml so it can be surfaced, and falls back', () => {
    const a = dbt('a');
    const b = dbt('b', true);
    const r = resolveDbtProject([a, b], { projectPath: '/Users/someone-else/datamodels', picked: a });
    expect(r).toMatchObject({ root: a, source: 'picked', invalidSetting: '/Users/someone-else/datamodels' });
  });

  it('projectPath may name any folder, with or without dbt_project.yml (#111)', () => {
    const ws = path.join(root, 'ws');
    const diagrams = path.join(ws, 'docs', 'diagrams');
    fs.mkdirSync(diagrams, { recursive: true });
    const r = resolveDbtProject([ws], { projectPath: 'docs/diagrams' });
    expect(r).toMatchObject({ root: diagrams, source: 'setting', candidates: [] });
    expect(r.invalidSetting).toBeUndefined();
    // Absolute works too, and also while the workspace holds dbt projects.
    const a = dbt('ws/a', true);
    expect(resolveDbtProject([ws], { projectPath: diagrams })).toMatchObject({ root: diagrams, source: 'setting', autoRoot: a });
  });

  it('a relative projectPath prefers the workspace folder where it is a dbt project', () => {
    const plainWs = path.join(root, 'plain');
    fs.mkdirSync(path.join(plainWs, 'analytics'), { recursive: true });
    const dbtWs = path.join(root, 'dbtws');
    const analytics = dbt('dbtws/analytics');
    expect(resolveDbtProject([plainWs, dbtWs], { projectPath: 'analytics' })).toMatchObject({ root: analytics, source: 'setting' });
  });

  it('a projectPath that is a file, not a folder, is still reported', () => {
    const a = dbt('a');
    const file = path.join(root, 'notes.txt');
    fs.writeFileSync(file, '');
    expect(resolveDbtProject([a], { projectPath: file })).toMatchObject({ root: a, source: 'auto', invalidSetting: file });
  });

  it('returns no root for a workspace without dbt projects', () => {
    fs.mkdirSync(path.join(root, 'docs'));
    expect(resolveDbtProject([path.join(root, 'docs')])).toMatchObject({ root: undefined, candidates: [] });
  });
});

describe('findOwningDbtProject', () => {
  it('finds the nearest ancestor holding dbt_project.yml', () => {
    const outer = dbt('mono');
    const inner = dbt('mono/analytics');
    const file = path.join(inner, '.erd-studio', 'silver', 'x.json');
    expect(findOwningDbtProject(file)).toBe(inner);
    expect(findOwningDbtProject(path.join(outer, '.erd-studio', 'gold', 'y.json'))).toBe(outer);
  });

  it('with stopAt, the open root owns its files even inside a dbt repo (#111)', () => {
    const repo = dbt('repo');
    const standalone = path.join(repo, 'docs', 'erd');
    const file = path.join(standalone, '.erd-studio', 'silver', 'x.json');
    expect(findOwningDbtProject(file)).toBe(repo);
    expect(findOwningDbtProject(file, standalone)).toBe(standalone);
    // A dbt project nested below the open root is still its own project.
    const nested = dbt('repo/docs/erd/inner');
    expect(findOwningDbtProject(path.join(nested, '.erd-studio', 'gold', 'y.json'), standalone)).toBe(nested);
  });

  it('returns undefined outside every dbt project', () => {
    expect(findOwningDbtProject(path.join(root, 'loose', 'z.json'))).toBeUndefined();
  });
});
