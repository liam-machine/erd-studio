import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';

import {
  SUBJECT_AREA_EDITOR_VIEW_TYPE,
  activeSubjectAreaCanvasPath,
  hasOpenSubjectAreaCanvas,
  diagramViewColumn,
  openDiagramPaths,
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

  describe('hasOpenSubjectAreaCanvas', () => {
    it('returns false when no tabs are open', () => {
      expect(hasOpenSubjectAreaCanvas()).toBe(false);
    });

    it('returns false when only non-canvas tabs are open', () => {
      setOpenTabs([{ input: { uri: { fsPath: '/foo.ts' } } }]);
      expect(hasOpenSubjectAreaCanvas()).toBe(false);
    });

    it('returns true when a domain canvas tab is open', () => {
      const tabInput = new vscode.TabInputCustom({ fsPath: '/dom.json' }, SUBJECT_AREA_EDITOR_VIEW_TYPE);
      setOpenTabs([{ input: tabInput }]);
      expect(hasOpenSubjectAreaCanvas()).toBe(true);
    });

    it('ignores TabInputCustom entries with a different viewType', () => {
      const tabInput = new vscode.TabInputCustom({ fsPath: '/img.png' }, 'imagePreview.previewEditor');
      setOpenTabs([{ input: tabInput }]);
      expect(hasOpenSubjectAreaCanvas()).toBe(false);
    });
  });

  describe('activeSubjectAreaCanvasPath', () => {
    const active = (vscode.window as unknown as { tabGroups: { activeTabGroup: { activeTab: { input: unknown } | undefined } } }).tabGroups.activeTabGroup;
    beforeEach(() => {
      active.activeTab = undefined;
    });

    it('is the file of the diagram in the active tab', () => {
      active.activeTab = { input: new vscode.TabInputCustom(vscode.Uri.file('/p/.erd-studio/gold/diagrams/sales.dbml'), SUBJECT_AREA_EDITOR_VIEW_TYPE) };
      expect(activeSubjectAreaCanvasPath()).toBe('/p/.erd-studio/gold/diagrams/sales.dbml');
      active.activeTab = undefined;
    });

    it('is undefined with no tab, a text editor, or another custom editor in front', () => {
      expect(activeSubjectAreaCanvasPath()).toBeUndefined();
      active.activeTab = { input: { uri: vscode.Uri.file('/p/a.ts') } };
      expect(activeSubjectAreaCanvasPath()).toBeUndefined();
      active.activeTab = { input: new vscode.TabInputCustom(vscode.Uri.file('/p/a.png'), 'imagePreview.previewEditor') };
      expect(activeSubjectAreaCanvasPath()).toBeUndefined();
      active.activeTab = undefined;
    });
  });

  describe('openDiagramPaths', () => {
    const diagram = (p: string) => ({ input: new vscode.TabInputCustom(vscode.Uri.file(p), SUBJECT_AREA_EDITOR_VIEW_TYPE) });
    afterEach(() => { mockTabGroups.all = []; });

    it('is each editor group\'s active tab that is a diagram, each file once; hidden tabs and other editors are left out', () => {
      const sales = diagram('/p/.erd-studio/gold/diagrams/sales.dbml');
      const staging = diagram('/p/.erd-studio/silver/diagrams/staging.dbml');
      (mockTabGroups as unknown as { all: unknown[] }).all = [
        { tabs: [staging, sales], activeTab: sales },
        { tabs: [{ input: { uri: vscode.Uri.file('/p/a.ts') } }], activeTab: { input: { uri: vscode.Uri.file('/p/a.ts') } } },
        { tabs: [sales], activeTab: sales },
        { tabs: [], activeTab: undefined },
      ];
      expect(openDiagramPaths()).toEqual(['/p/.erd-studio/gold/diagrams/sales.dbml']);
    });

    it('is empty with no diagram on screen', () => {
      expect(openDiagramPaths()).toEqual([]);
    });
  });

  describe('diagramViewColumn', () => {
    const SALES = '/p/.erd-studio/gold/diagrams/sales.dbml';
    const diagram = (p: string) => ({ input: new vscode.TabInputCustom(vscode.Uri.file(p), SUBJECT_AREA_EDITOR_VIEW_TYPE) });
    const text = { input: new vscode.TabInputText(vscode.Uri.file('/p/README.md')) };
    const groups = mockTabGroups as unknown as { all: unknown[]; activeTabGroup: unknown };
    let activeBefore: unknown;
    beforeEach(() => { activeBefore = groups.activeTabGroup; });
    afterEach(() => { groups.activeTabGroup = activeBefore; groups.all = []; });

    it('is the group that shows the diagram in front, though another group is active (no second tab there)', () => {
      const sales = diagram(SALES);
      const left = { tabs: [text], activeTab: text, viewColumn: 1 };
      const right = { tabs: [sales], activeTab: sales, viewColumn: 2 };
      groups.all = [left, right];
      groups.activeTabGroup = left;
      expect(diagramViewColumn(SALES)).toBe(2);
      // Spelled in another case (macOS, Windows): the same file.
      if (process.platform !== 'linux') expect(diagramViewColumn(SALES.toUpperCase())).toBe(2);
    });

    it('prefers the active group when it shows the diagram in front too, then a group with it in front, then one with it behind', () => {
      const sales = diagram(SALES);
      const a = { tabs: [sales], activeTab: sales, viewColumn: 1 };
      const b = { tabs: [sales], activeTab: sales, viewColumn: 2 };
      groups.all = [a, b];
      groups.activeTabGroup = b;
      expect(diagramViewColumn(SALES)).toBe(2);
      const behind = { tabs: [sales, text], activeTab: text, viewColumn: 1 };
      const front = { tabs: [sales], activeTab: sales, viewColumn: 3 };
      groups.all = [behind, front];
      groups.activeTabGroup = behind;
      expect(diagramViewColumn(SALES)).toBe(3);
      groups.all = [behind];
      expect(diagramViewColumn(SALES)).toBe(1);
    });

    it('is undefined when no tab shows the diagram (it opens in the active group as before)', () => {
      groups.all = [{ tabs: [text], activeTab: text, viewColumn: 1 }, { tabs: [diagram('/p/other.dbml')], viewColumn: 2 }];
      expect(diagramViewColumn(SALES)).toBeUndefined();
    });
  });

  describe('saveAllAndReload', () => {
    it('returns true when the reload was requested', async () => {
      vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
      await expect(saveAllAndReload('test reason')).resolves.toBe(true);
    });

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
        { isDirty: true, isUntitled: false, uri: vscode.Uri.file('/p/orders.sql') },
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
        { isDirty: true, isUntitled: false, uri: vscode.Uri.file('/p/orders.sql') },
      ];
      const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
      // A modal's Cancel (or Escape) resolves undefined.
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);

      const reloaded = await saveAllAndReload('test reason');

      expect(reloaded).toBe(false);
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
