/**
 * DbmlStorageGuard — the editor side of the stable guard: the context key,
 * the once-per-session notification, refusals with an Update button, and the
 * `.dbml` watcher that catches a project becoming (or ceasing to be) DBML.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
  DBML_STORAGE_CONTEXT_KEY,
  DBML_STORAGE_MESSAGE,
  DbmlStorageGuard,
  UPDATE_ERD_STUDIO_BUTTON,
  _resetDbmlStorageNoticeForTests,
  openExtensionPage,
} from '../../src/providers/dbmlStorageGuardUi';
import type { DbmlStorageEvidence } from '../../src/services/dbmlStorageGuard';

const EVIDENCE: DbmlStorageEvidence = { kind: 'table', file: 'tables/x.dbml' };

let warn: ReturnType<typeof vi.spyOn>;
let exec: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetDbmlStorageNoticeForTests();
  vscode._clearMockFileWatchers();
  warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const contextKeyCalls = () => exec.mock.calls.filter((c) => c[0] === 'setContext' && c[1] === DBML_STORAGE_CONTEXT_KEY);

describe('DbmlStorageGuard', () => {
  it('a YAML / JSON project: key false, no notification, nothing refused', () => {
    const guard = new DbmlStorageGuard('/p/.erd-studio', () => null);
    expect(guard.isActive()).toBe(false);
    expect(guard.refuse()).toBe(false);
    expect(contextKeyCalls()).toEqual([['setContext', DBML_STORAGE_CONTEXT_KEY, false]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a DBML project: key true once, one notification per session however often it is checked', () => {
    const guard = new DbmlStorageGuard('/p/.erd-studio', () => EVIDENCE);
    expect(guard.isActive()).toBe(true);
    guard.isActive();
    new DbmlStorageGuard('/q/.erd-studio', () => EVIDENCE).isActive();
    expect(contextKeyCalls()).toEqual([
      ['setContext', DBML_STORAGE_CONTEXT_KEY, true],
      ['setContext', DBML_STORAGE_CONTEXT_KEY, true],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(DBML_STORAGE_MESSAGE, UPDATE_ERD_STUDIO_BUTTON);
  });

  it('refuse() says why every time, and its button opens the extension page', async () => {
    const guard = new DbmlStorageGuard('/p/.erd-studio', () => EVIDENCE);
    guard.isActive();
    warn.mockResolvedValue(UPDATE_ERD_STUDIO_BUTTON as never);
    expect(guard.refuse()).toBe(true);
    expect(guard.refuse()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('extension.open', 'liamwynne.erd-studio'));
  });

  it('checks the folder fresh on every call, and fires onDidChange only on a change', () => {
    let evidence: DbmlStorageEvidence | null = null;
    const guard = new DbmlStorageGuard('/p/.erd-studio', () => evidence);
    const changes: boolean[] = [];
    guard.onDidChange((v) => changes.push(v));
    expect(guard.refuse()).toBe(false);
    evidence = EVIDENCE; // e.g. git checkout of a converted branch
    expect(guard.refuse()).toBe(true);
    evidence = null;
    expect(guard.isActive()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('the .dbml watcher re-checks after a burst settles', () => {
    vi.useFakeTimers();
    const detect = vi.fn<(root: string) => DbmlStorageEvidence | null>(() => null);
    const guard = new DbmlStorageGuard('/p/.erd-studio', detect);
    guard.isActive();
    guard.watch();
    const watcher = vscode._mockFileWatchers.at(-1)!;
    expect(watcher._pattern).toMatchObject({ base: '/p/.erd-studio', pattern: '**/*.dbml' });
    const changes: boolean[] = [];
    guard.onDidChange((v) => changes.push(v));
    detect.mockReturnValue(EVIDENCE);
    watcher._simulateCreate(vscode.Uri.file('/p/.erd-studio/tables/x.dbml'));
    watcher._simulateCreate(vscode.Uri.file('/p/.erd-studio/tables/y.dbml'));
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(changes).toEqual([true]);
    expect(detect).toHaveBeenCalledTimes(2);
    guard.dispose();
  });
});

describe('openExtensionPage', () => {
  it('falls back to the Extensions search where extension.open is missing', async () => {
    exec.mockImplementation(async (command: string) => {
      if (command === 'extension.open') throw new Error("command 'extension.open' not found");
      return undefined;
    });
    await openExtensionPage();
    expect(exec).toHaveBeenCalledWith('workbench.extensions.search', '@id:liamwynne.erd-studio');
  });
});
