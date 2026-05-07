import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';

import {
  DOMAIN_EDITOR_VIEW_TYPE,
  hasOpenDomainCanvas,
  saveAllAndReload,
} from '../../src/services/recoveryService';

interface MutableTabGroups {
  all: Array<{ tabs: Array<{ input: unknown }> }>;
}

const mockTabGroups = (vscode.window as unknown as { tabGroups: MutableTabGroups }).tabGroups;

const setOpenTabs = (tabs: Array<{ input: unknown }>) => {
  mockTabGroups.all = [{ tabs }];
};

describe('recoveryService', () => {
  beforeEach(() => {
    setOpenTabs([]);
    (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [];
    vi.restoreAllMocks();
  });

  describe('hasOpenDomainCanvas', () => {
    it('returns false when no tabs are open', () => {
      expect(hasOpenDomainCanvas()).toBe(false);
    });

    it('returns false when only non-canvas tabs are open', () => {
      setOpenTabs([{ input: { uri: { fsPath: '/foo.ts' } } }]);
      expect(hasOpenDomainCanvas()).toBe(false);
    });

    it('returns true when a domain canvas tab is open', () => {
      const tabInput = new vscode.TabInputCustom({ fsPath: '/dom.json' }, DOMAIN_EDITOR_VIEW_TYPE);
      setOpenTabs([{ input: tabInput }]);
      expect(hasOpenDomainCanvas()).toBe(true);
    });

    it('ignores TabInputCustom entries with a different viewType', () => {
      const tabInput = new vscode.TabInputCustom({ fsPath: '/img.png' }, 'imagePreview.previewEditor');
      setOpenTabs([{ input: tabInput }]);
      expect(hasOpenDomainCanvas()).toBe(false);
    });
  });

  describe('saveAllAndReload', () => {
    it('runs saveAll then reloadWindow when nothing is dirty after save', async () => {
      const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

      await saveAllAndReload('test reason');

      expect(exec).toHaveBeenCalledWith('workbench.action.files.saveAll');
      expect(exec).toHaveBeenCalledWith('workbench.action.reloadWindow');
      // saveAll must precede reload — never reload before saving.
      const calls = exec.mock.calls.map(c => c[0]);
      expect(calls.indexOf('workbench.action.files.saveAll'))
        .toBeLessThan(calls.indexOf('workbench.action.reloadWindow'));
    });

    it('still attempts reload if saveAll throws (errors are swallowed)', async () => {
      const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (cmd: string) => {
        if (cmd === 'workbench.action.files.saveAll') throw new Error('boom');
        return undefined;
      });
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

      await saveAllAndReload('test reason');

      expect(exec).toHaveBeenCalledWith('workbench.action.reloadWindow');
      expect(consoleErr).toHaveBeenCalled();
    });

    it('prompts before reloading when documents remain dirty after save', async () => {
      (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [
        { isDirty: true, isUntitled: false },
      ];
      const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
      const warn = vi.spyOn(vscode.window, 'showWarningMessage')
        .mockResolvedValue('Reload Anyway' as never);

      await saveAllAndReload('test reason');

      expect(warn).toHaveBeenCalled();
      expect(exec).toHaveBeenCalledWith('workbench.action.reloadWindow');
    });

    it('aborts the reload when the user cancels the dirty-files prompt', async () => {
      (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [
        { isDirty: true, isUntitled: false },
      ];
      const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Cancel' as never);

      await saveAllAndReload('test reason');

      expect(exec).toHaveBeenCalledWith('workbench.action.files.saveAll');
      expect(exec).not.toHaveBeenCalledWith('workbench.action.reloadWindow');
    });

    it('ignores untitled dirty documents (they are not real saved-file losses)', async () => {
      (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [
        { isDirty: true, isUntitled: true },
      ];
      const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
      const warn = vi.spyOn(vscode.window, 'showWarningMessage');

      await saveAllAndReload('test reason');

      expect(warn).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledWith('workbench.action.reloadWindow');
    });
  });
});
