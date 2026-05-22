import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveSemanticDir } from '../../src/services/semanticDirResolver';

interface Inspected {
  globalValue?: string;
  workspaceValue?: string;
  workspaceFolderValue?: string;
}

// Minimal stand-in for vscode.WorkspaceConfiguration — only `inspect` is used.
function fakeConfig(inspected: Inspected = {}): any {
  return { inspect: () => ({ key: 'semanticDir', ...inspected }) };
}

describe('resolveSemanticDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semdir-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an explicit workspace-folder setting over disk state', () => {
    fs.mkdirSync(path.join(tmpDir, 'erd-studio'));
    const result = resolveSemanticDir(tmpDir, fakeConfig({ workspaceFolderValue: 'custom-dir' }));
    expect(result).toBe('custom-dir');
  });

  it('returns an explicit global setting when no narrower scope is set', () => {
    expect(resolveSemanticDir(tmpDir, fakeConfig({ globalValue: 'global-dir' }))).toBe('global-dir');
  });

  it('prefers a workspace setting over a global setting', () => {
    const result = resolveSemanticDir(
      tmpDir,
      fakeConfig({ workspaceValue: 'workspace-dir', globalValue: 'global-dir' }),
    );
    expect(result).toBe('workspace-dir');
  });

  it('detects an existing .erd-studio directory', () => {
    fs.mkdirSync(path.join(tmpDir, '.erd-studio'));
    expect(resolveSemanticDir(tmpDir, fakeConfig())).toBe('.erd-studio');
  });

  it('detects a legacy erd-studio directory', () => {
    fs.mkdirSync(path.join(tmpDir, 'erd-studio'));
    expect(resolveSemanticDir(tmpDir, fakeConfig())).toBe('erd-studio');
  });

  it('defaults to .erd-studio when neither directory exists', () => {
    expect(resolveSemanticDir(tmpDir, fakeConfig())).toBe('.erd-studio');
  });

  it('prefers .erd-studio when both directories exist', () => {
    fs.mkdirSync(path.join(tmpDir, '.erd-studio'));
    fs.mkdirSync(path.join(tmpDir, 'erd-studio'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveSemanticDir(tmpDir, fakeConfig())).toBe('.erd-studio');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Both .erd-studio'));
    warn.mockRestore();
  });
});
