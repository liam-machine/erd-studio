/**
 * getErdStudioSetting — the legacy-setting fallback CLAUDE.md calls load-bearing.
 *
 * Resolution order: explicit erdStudio.<key> (folder > workspace > global),
 * then explicit dbtSemantic.<key> (same order), then the provided default.
 * The package default of erdStudio.<key> must never mask a value a pre-rename
 * user configured under dbtSemantic.<key>.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { USER_SCOPED_SETTINGS, getErdStudioSetting } from '../../src/services/configService';

const KEY = 'semanticDir';
const set = (section: 'erdStudio' | 'dbtSemantic', values: vscode.MockConfigValues) =>
  vscode._setMockConfiguration(section, KEY, values);
const read = () => getErdStudioSetting(KEY, '.erd-studio');

beforeEach(() => {
  vscode._resetMockConfiguration();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getErdStudioSetting', () => {
  it('returns the provided default when neither section is configured', () => {
    expect(read()).toBe('.erd-studio');
    expect(getErdStudioSetting('projectPath', '')).toBe('');
  });

  it('prefers an explicit erdStudio value over an explicit dbtSemantic value', () => {
    set('erdStudio', { globalValue: 'new-dir' });
    set('dbtSemantic', { globalValue: 'old-dir' });
    expect(read()).toBe('new-dir');
  });

  it('lets a global erdStudio value beat a folder-scoped dbtSemantic value', () => {
    set('erdStudio', { globalValue: 'new-dir' });
    set('dbtSemantic', { workspaceFolderValue: 'old-folder', workspaceValue: 'old-ws' });
    expect(read()).toBe('new-dir');
  });

  it('falls back to an explicit legacy dbtSemantic value when erdStudio is unset', () => {
    set('dbtSemantic', { workspaceValue: 'old-dir' });
    expect(read()).toBe('old-dir');
  });

  it('never lets the erdStudio package default mask an explicit legacy value', () => {
    // inspect() reports defaultValue for a registered setting even when the user set nothing.
    set('erdStudio', { defaultValue: '.erd-studio' });
    set('dbtSemantic', { defaultValue: 'semantic', globalValue: 'my-legacy-dir' });
    expect(read()).toBe('my-legacy-dir');
  });

  it('ignores both package defaults and uses the caller-provided default', () => {
    set('erdStudio', { defaultValue: '.erd-studio' });
    set('dbtSemantic', { defaultValue: 'semantic' });
    expect(getErdStudioSetting(KEY, 'fallback')).toBe('fallback');
  });

  it('resolves folder > workspace > global within the erdStudio section', () => {
    set('erdStudio', { globalValue: 'g', workspaceValue: 'w', workspaceFolderValue: 'f' });
    expect(read()).toBe('f');
    set('erdStudio', { globalValue: 'g', workspaceValue: 'w' });
    expect(read()).toBe('w');
    set('erdStudio', { globalValue: 'g' });
    expect(read()).toBe('g');
  });

  it('applies the same scope order within the legacy section', () => {
    set('dbtSemantic', { globalValue: 'g', workspaceFolderValue: 'f' });
    expect(read()).toBe('f');
    set('dbtSemantic', { globalValue: 'g', workspaceValue: 'w' });
    expect(read()).toBe('w');
  });

  it('honours explicit falsy values (empty string, false, 0) instead of skipping them', () => {
    set('erdStudio', { workspaceValue: '' });
    set('dbtSemantic', { workspaceValue: 'old-dir' });
    expect(read()).toBe('');

    vscode._setMockConfiguration('erdStudio', 'flag', { globalValue: false });
    expect(getErdStudioSetting('flag', true)).toBe(false);

    vscode._setMockConfiguration('dbtSemantic', 'count', { globalValue: 0 });
    expect(getErdStudioSetting('count', 5)).toBe(0);
  });

  it('reads only the requested key', () => {
    vscode._setMockConfiguration('erdStudio', 'projectPath', { globalValue: 'analytics' });
    expect(read()).toBe('.erd-studio');
    expect(getErdStudioSetting('projectPath', '')).toBe('analytics');
  });

  it('copes with inspect() returning undefined for an unregistered section', () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      inspect: () => undefined,
    } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);
    expect(read()).toBe('.erd-studio');
  });
});

/**
 * The feedback-analysis keys decide where a description — and the API key that
 * travels with it — is posted. A repository must not be able to answer that
 * question by shipping a `.vscode/settings.json`, so for these keys the
 * workspace and folder scopes are not read at all.
 */
describe('getErdStudioSetting: user-scoped feedback keys', () => {
  for (const key of USER_SCOPED_SETTINGS) {
    it(`ignores a workspace and folder value for ${key}`, () => {
      vscode._setMockConfiguration('erdStudio', key, {
        workspaceValue: 'https://evil.example/v1',
        workspaceFolderValue: 'https://also-evil.example/v1',
      });
      expect(getErdStudioSetting(key, 'unset')).toBe('unset');
    });

    it(`still honours the user's own global value for ${key}`, () => {
      vscode._setMockConfiguration('erdStudio', key, {
        globalValue: 'https://api.openai.com/v1',
        workspaceValue: 'https://evil.example/v1',
      });
      expect(getErdStudioSetting(key, 'unset')).toBe('https://api.openai.com/v1');
    });

    it(`ignores a legacy workspace value for ${key} too`, () => {
      vscode._setMockConfiguration('dbtSemantic', key, {
        workspaceValue: 'https://evil.example/v1',
      });
      expect(getErdStudioSetting(key, 'unset')).toBe('unset');
    });
  }

  it('leaves every other setting on the folder > workspace > global order', () => {
    set('erdStudio', { globalValue: 'g', workspaceValue: 'w' });
    expect(read()).toBe('w');
  });
});

/**
 * `claudeSync.skipPermissions` makes **Execute with Claude** pass
 * `--dangerously-skip-permissions`. A cloned repository's `.vscode/settings.json`
 * must not be able to turn that on.
 */
describe('getErdStudioSetting: claudeSync.skipPermissions', () => {
  const SKIP = 'claudeSync.skipPermissions';

  it('is user-scoped', () => {
    expect(USER_SCOPED_SETTINGS.has(SKIP)).toBe(true);
  });

  it('ignores a workspace or folder value of true', () => {
    vscode._setMockConfiguration('erdStudio', SKIP, { workspaceValue: true, workspaceFolderValue: true });
    expect(getErdStudioSetting(SKIP, false)).toBe(false);
  });

  it('ignores a legacy dbtSemantic workspace value of true', () => {
    vscode._setMockConfiguration('dbtSemantic', SKIP, { workspaceValue: true });
    expect(getErdStudioSetting(SKIP, false)).toBe(false);
  });

  it("honours the user's own global value", () => {
    vscode._setMockConfiguration('erdStudio', SKIP, { globalValue: true });
    expect(getErdStudioSetting(SKIP, false)).toBe(true);
  });

  it('lets a workspace false not override a user true', () => {
    vscode._setMockConfiguration('erdStudio', SKIP, { globalValue: true, workspaceValue: false });
    expect(getErdStudioSetting(SKIP, false)).toBe(true);
  });
});

/**
 * Both halves of the guard: every user-scoped key is also contributed with
 * `"scope": "machine"`, so VS Code itself keeps a workspace value out.
 */
describe('USER_SCOPED_SETTINGS and package.json agree', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  const properties: Record<string, { scope?: string }> = Object.assign(
    {},
    ...([] as Array<{ properties?: Record<string, { scope?: string }> }>)
      .concat(manifest.contributes.configuration)
      .map((section) => section.properties ?? {}),
  );

  for (const key of USER_SCOPED_SETTINGS) {
    it(`contributes erdStudio.${key} with "scope": "machine"`, () => {
      expect(properties[`erdStudio.${key}`]?.scope).toBe('machine');
    });
  }
});
