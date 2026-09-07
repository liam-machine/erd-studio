import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as extension from '../../src/extension';
import { resolveDbtProjectRoot } from '../../src/extension';

describe('extension', () => {
  it('exports activate and deactivate functions', () => {
    expect(typeof extension.activate).toBe('function');
    expect(typeof extension.deactivate).toBe('function');
  });

  it('registers the domain editor with retainContextWhenHidden (H20)', () => {
    // activate() needs a full workspace; assert on the registration call shape instead.
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');
    const match = source.match(/registerCustomEditorProvider\(DOMAIN_EDITOR_VIEW_TYPE,\s*editorProvider,\s*\{[\s\S]*?\}\)/);
    expect(match, 'registerCustomEditorProvider call with options').not.toBeNull();
    expect(match![0]).toMatch(/retainContextWhenHidden:\s*true/);
  });
});

describe('resolveDbtProjectRoot', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbt-root-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeDbtProject(rel: string): string {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dbt_project.yml'), 'name: x\n');
    return dir;
  }

  it('returns undefined when no folders are given', () => {
    expect(resolveDbtProjectRoot([], '')).toBeUndefined();
  });

  it('returns undefined when nothing contains dbt_project.yml', () => {
    fs.mkdirSync(path.join(root, 'src'));
    expect(resolveDbtProjectRoot([root], '')).toBeUndefined();
  });

  it('returns the workspace folder itself when it holds dbt_project.yml', () => {
    makeDbtProject('.');
    expect(resolveDbtProjectRoot([root], '')).toBe(root);
  });

  it('honours a relative erdStudio.projectPath before auto-detection', () => {
    makeDbtProject('.');
    const nested = makeDbtProject('analytics');
    expect(resolveDbtProjectRoot([root], 'analytics')).toBe(nested);
  });

  it('honours an absolute erdStudio.projectPath', () => {
    const nested = makeDbtProject('deep/analytics');
    expect(resolveDbtProjectRoot([root], nested)).toBe(nested);
  });

  it('falls back to auto-detection when projectPath does not contain dbt_project.yml', () => {
    makeDbtProject('.');
    expect(resolveDbtProjectRoot([root], 'missing')).toBe(root);
  });

  it('finds a nested dbt project one level down (monorepo)', () => {
    const nested = makeDbtProject('analytics');
    fs.mkdirSync(path.join(root, 'app'));
    expect(resolveDbtProjectRoot([root], '')).toBe(nested);
  });

  it('returns the shallowest match when several nested projects exist', () => {
    makeDbtProject('a/b/deep_project');
    const shallow = makeDbtProject('zzz_shallow');
    expect(resolveDbtProjectRoot([root], '')).toBe(shallow);
  });

  it('skips node_modules, dbt_packages, .git, target and .venv', () => {
    for (const skip of ['node_modules', 'dbt_packages', '.git', 'target', '.venv']) {
      makeDbtProject(path.join(skip, 'pkg'));
    }
    expect(resolveDbtProjectRoot([root], '')).toBeUndefined();

    const real = makeDbtProject('real');
    expect(resolveDbtProjectRoot([root], '')).toBe(real);
  });

  it('does not search deeper than the depth limit', () => {
    makeDbtProject('l1/l2/l3/l4/project');
    expect(resolveDbtProjectRoot([root], '')).toBeUndefined();
    const d3 = makeDbtProject('x1/x2/project3');
    expect(resolveDbtProjectRoot([root], '')).toBe(d3);
  });

  it('checks every workspace folder in a multi-root workspace', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbt-other-'));
    try {
      const nested = makeDbtProject('analytics');
      expect(resolveDbtProjectRoot([other, root], '')).toBe(nested);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
