/**
 * projectDiscovery — which dbt project a window opens (#82): the explicit
 * setting, then the per-machine pick, then auto-detection (ERD data first).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findOwningDbtProject, resolveDbtProject, samePath } from '../../src/services/projectDiscovery';

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

  it('reports hasDbt for a dbt root and for a projectPath plain folder (#111)', () => {
    const a = dbt('a', true);
    expect(resolveDbtProject([a])).toMatchObject({ root: a, source: 'auto', hasDbt: true });
    const diagrams = path.join(root, 'diagrams');
    fs.mkdirSync(diagrams);
    expect(resolveDbtProject([a], { projectPath: diagrams })).toMatchObject({ root: diagrams, source: 'setting', hasDbt: false });
  });
});

describe('resolveDbtProject — logical-only roots', () => {
  function folder(rel: string, withErd: false | '.erd-studio' | 'erd-studio' = false): string {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    if (withErd) { fs.mkdirSync(path.join(dir, withErd)); }
    return dir;
  }

  it('a plain folder with no dbt project opens as the root, source folder', () => {
    const docs = folder('docs');
    expect(resolveDbtProject([docs])).toMatchObject({
      root: docs, source: 'folder', hasDbt: false, candidates: [], autoRoot: undefined,
    });
  });

  it('a folder holding .erd-studio beats the first folder', () => {
    const first = folder('first');
    const second = folder('second', '.erd-studio');
    expect(resolveDbtProject([first, second])).toMatchObject({ root: second, source: 'erdData', hasDbt: false });
  });

  it('the legacy erd-studio/ folder counts as ERD data too', () => {
    const first = folder('first');
    const legacy = folder('legacy', 'erd-studio');
    fs.writeFileSync(path.join(legacy, 'erd-studio', 'layers.json'), '{}');
    expect(resolveDbtProject([first, legacy])).toMatchObject({ root: legacy, source: 'erdData' });
  });

  it('a configured semanticDir is what counts as ERD data', () => {
    const first = folder('first', '.erd-studio');
    const custom = folder('custom');
    fs.mkdirSync(path.join(custom, 'diagrams'));
    expect(resolveDbtProject([first, custom], { semanticDir: 'diagrams' })).toMatchObject({ root: custom, source: 'erdData' });
  });

  it('any dbt project beats a folder with .erd-studio', () => {
    const plain = folder('plain', '.erd-studio');
    const project = dbt('project');
    expect(resolveDbtProject([plain, project])).toMatchObject({ root: project, source: 'auto', hasDbt: true, candidates: [project] });
  });

  it('a nested dbt project beats a workspace folder with .erd-studio', () => {
    const ws = folder('ws', '.erd-studio');
    const nested = dbt('ws/analytics');
    expect(resolveDbtProject([ws])).toMatchObject({ root: nested, source: 'auto', hasDbt: true });
  });

  it('no folders → no root (the empty-window branch)', () => {
    const r = resolveDbtProject([]);
    expect(r.root).toBeUndefined();
    expect(r.hasDbt).toBe(false);
  });

  it('an invalid projectPath falls back to the plain folder and is still reported', () => {
    const docs = folder('docs');
    expect(resolveDbtProject([docs], { projectPath: path.join(root, 'nowhere') })).toMatchObject({
      root: docs, source: 'folder', invalidSetting: path.join(root, 'nowhere'),
    });
  });

  it('the logical-only fixture opens as erdData, with its decoy models/ ignored', () => {
    const fixture = path.resolve(__dirname, '../fixtures/logical-only');
    expect(resolveDbtProject([fixture])).toMatchObject({ root: fixture, source: 'erdData', hasDbt: false, candidates: [] });
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

  it('with stopAt spelt in another case, still finds the open root where the file system ignores case', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const standalone = path.join(root, 'docs', 'erd');
      const file = path.join(standalone, '.erd-studio', 'silver', 'x.json');
      // VS Code writes a Windows drive letter in lower case; path.resolve does not.
      expect(findOwningDbtProject(file, standalone.toUpperCase())).toBe(standalone);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('returns undefined outside every dbt project', () => {
    expect(findOwningDbtProject(path.join(root, 'loose', 'z.json'))).toBeUndefined();
  });
});

describe('samePath', () => {
  it('ignores case on Windows and macOS, and keeps it on Linux', () => {
    expect(samePath('/Proj/A', '/proj/a', 'win32')).toBe(true);
    expect(samePath('/Proj/A', '/proj/a', 'darwin')).toBe(true);
    expect(samePath('/Proj/A', '/proj/a', 'linux')).toBe(false);
    expect(samePath('/proj/x/../a', '/proj/a', 'linux')).toBe(true);
  });
});
