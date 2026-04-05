/**
 * FileWatcherService unit tests.
 *
 * Tests the file watcher service's event emission and debouncing behavior.
 * Uses mocked VS Code FileSystemWatcher API.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

// Mock fs before importing FileWatcherService
let mockDbtProjectContent = 'name: my_project\ntarget-path: target\nmodel-paths: ["models"]\n';
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn((p: string, _enc?: string) => {
      if (typeof p === 'string' && p.endsWith('dbt_project.yml')) {
        return mockDbtProjectContent;
      }
      return actual.readFileSync(p as any, _enc as any);
    }),
  };
});

import { FileWatcherService } from '../../src/watchers/FileWatcherService';
import {
  _clearMockFileWatchers,
  _mockFileWatchers,
  type MockFileSystemWatcher,
} from '../__mocks__/vscode';

// Mock timers for testing debounce
vi.useFakeTimers();

describe('FileWatcherService', () => {
  let service: FileWatcherService;

  beforeEach(() => {
    vi.clearAllTimers();
    _clearMockFileWatchers();
    mockDbtProjectContent = 'name: my_project\ntarget-path: target\nmodel-paths: ["models"]\n';
    service = new FileWatcherService('/test/workspace');
  });

  describe('initialization', () => {
    it('creates five file system watchers', () => {
      expect(_mockFileWatchers).toHaveLength(5);
    });
  });

  describe('manifest watcher', () => {
    it('emits onManifestChanged when manifest.json changes', () => {
      const listener = vi.fn();
      service.onManifestChanged(listener);

      // Manifest watcher is the first one created
      const manifestWatcher = _mockFileWatchers[0];
      manifestWatcher._simulateChange(vscode.Uri.file('/test/workspace/target/manifest.json'));

      // Advance past debounce
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('emits onManifestChanged when manifest.json is created', () => {
      const listener = vi.fn();
      service.onManifestChanged(listener);

      const manifestWatcher = _mockFileWatchers[0];
      manifestWatcher._simulateCreate(vscode.Uri.file('/test/workspace/target/manifest.json'));
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('debounces rapid manifest changes', () => {
      const listener = vi.fn();
      service.onManifestChanged(listener);

      const manifestWatcher = _mockFileWatchers[0];

      // Simulate rapid changes
      manifestWatcher._simulateChange(vscode.Uri.file('/test/workspace/target/manifest.json'));
      vi.advanceTimersByTime(100);
      manifestWatcher._simulateChange(vscode.Uri.file('/test/workspace/target/manifest.json'));
      vi.advanceTimersByTime(100);
      manifestWatcher._simulateChange(vscode.Uri.file('/test/workspace/target/manifest.json'));

      // Not yet fired (debounce still pending)
      expect(listener).not.toHaveBeenCalled();

      // Advance past debounce
      vi.advanceTimersByTime(300);

      // Should only fire once
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('semantic file watcher', () => {
    it('emits onSemanticFileChanged with URI when semantic file changes', () => {
      const listener = vi.fn();
      service.onSemanticFileChanged(listener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri = vscode.Uri.file('/test/workspace/erd-studio/silver/work-lots.json');
      semanticWatcher._simulateChange(uri);
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledWith({ uri });
    });

    it('emits onSemanticFileChanged when semantic file is created', () => {
      const listener = vi.fn();
      service.onSemanticFileChanged(listener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri = vscode.Uri.file('/test/workspace/erd-studio/gold/new-domain.json');
      semanticWatcher._simulateCreate(uri);
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledWith({ uri });
    });

    it('emits onSemanticFileDeleted when semantic file is deleted', () => {
      const listener = vi.fn();
      service.onSemanticFileDeleted(listener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri = vscode.Uri.file('/test/workspace/erd-studio/silver/deleted.json');
      semanticWatcher._simulateDelete(uri);
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledWith({ uri });
    });

    it('does not emit onSemanticFileChanged when semantic file is deleted', () => {
      const listener = vi.fn();
      service.onSemanticFileChanged(listener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri = vscode.Uri.file('/test/workspace/erd-studio/silver/deleted.json');
      semanticWatcher._simulateDelete(uri);
      vi.advanceTimersByTime(300);

      expect(listener).not.toHaveBeenCalled();
    });

    it('debounces changes per file independently', () => {
      const listener = vi.fn();
      service.onSemanticFileChanged(listener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri1 = vscode.Uri.file('/test/workspace/erd-studio/silver/file1.json');
      const uri2 = vscode.Uri.file('/test/workspace/erd-studio/silver/file2.json');

      // Change file1 multiple times
      semanticWatcher._simulateChange(uri1);
      vi.advanceTimersByTime(100);
      semanticWatcher._simulateChange(uri1);
      vi.advanceTimersByTime(100);

      // Change file2 once
      semanticWatcher._simulateChange(uri2);

      // Advance past debounce
      vi.advanceTimersByTime(300);

      // Should have 2 calls: one for file1 (debounced), one for file2
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledWith({ uri: uri1 });
      expect(listener).toHaveBeenCalledWith({ uri: uri2 });
    });
  });

  describe('project config watcher', () => {
    it('emits onProjectConfigChanged when target-path changes', () => {
      const listener = vi.fn();
      service.onProjectConfigChanged(listener);

      // Project config watcher is the third one created (after manifest, semantic)
      const projectWatcher = _mockFileWatchers[2];

      // Change the target-path
      mockDbtProjectContent = 'name: my_project\ntarget-path: custom_target\nmodel-paths: ["models"]\n';
      projectWatcher._simulateChange(vscode.Uri.file('/test/workspace/dbt_project.yml'));
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('emits onProjectConfigChanged when model-paths block-sequence items change', () => {
      // Start with multi-line block-sequence form
      _clearMockFileWatchers();
      mockDbtProjectContent = 'name: my_project\ntarget-path: target\nmodel-paths:\n  - "models"\n  - "other"\n';
      service = new FileWatcherService('/test/workspace');

      const listener = vi.fn();
      service.onProjectConfigChanged(listener);

      const projectWatcher = _mockFileWatchers[2];

      // Remove the "other" path entry
      mockDbtProjectContent = 'name: my_project\ntarget-path: target\nmodel-paths:\n  - "models"\n';
      projectWatcher._simulateChange(vscode.Uri.file('/test/workspace/dbt_project.yml'));
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not emit onProjectConfigChanged when non-path config changes', () => {
      const listener = vi.fn();
      service.onProjectConfigChanged(listener);

      const projectWatcher = _mockFileWatchers[2];

      // Change only the project name — paths stay the same
      mockDbtProjectContent = 'name: renamed_project\ntarget-path: target\nmodel-paths: ["models"]\n';
      projectWatcher._simulateChange(vscode.Uri.file('/test/workspace/dbt_project.yml'));
      vi.advanceTimersByTime(300);

      expect(listener).not.toHaveBeenCalled();
    });

    it('does not match indented path keys (e.g. under vars)', () => {
      const listener = vi.fn();
      service.onProjectConfigChanged(listener);

      const projectWatcher = _mockFileWatchers[2];

      // Add an indented model-paths under vars — should be ignored
      mockDbtProjectContent = 'name: my_project\ntarget-path: target\nmodel-paths: ["models"]\nvars:\n  model-paths: "some_var"\n';
      projectWatcher._simulateChange(vscode.Uri.file('/test/workspace/dbt_project.yml'));
      vi.advanceTimersByTime(300);

      expect(listener).not.toHaveBeenCalled();
    });

    it('fires again when path config reverts to original', () => {
      const listener = vi.fn();
      service.onProjectConfigChanged(listener);

      const projectWatcher = _mockFileWatchers[2];

      // First change: different target-path
      mockDbtProjectContent = 'name: my_project\ntarget-path: custom_target\nmodel-paths: ["models"]\n';
      projectWatcher._simulateChange(vscode.Uri.file('/test/workspace/dbt_project.yml'));
      vi.advanceTimersByTime(300);
      expect(listener).toHaveBeenCalledTimes(1);

      // Revert to original
      mockDbtProjectContent = 'name: my_project\ntarget-path: target\nmodel-paths: ["models"]\n';
      projectWatcher._simulateChange(vscode.Uri.file('/test/workspace/dbt_project.yml'));
      vi.advanceTimersByTime(300);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('does not emit for seed-paths or snapshot-paths changes', () => {
      const listener = vi.fn();
      service.onProjectConfigChanged(listener);

      const projectWatcher = _mockFileWatchers[2];

      // Add seed-paths and snapshot-paths — should not trigger since extension doesn't use them
      mockDbtProjectContent = 'name: my_project\ntarget-path: target\nmodel-paths: ["models"]\nseed-paths: ["seeds"]\nsnapshot-paths: ["snapshots"]\n';
      projectWatcher._simulateChange(vscode.Uri.file('/test/workspace/dbt_project.yml'));
      vi.advanceTimersByTime(300);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('clears pending debounce timers on dispose', () => {
      const listener = vi.fn();
      service.onManifestChanged(listener);

      const manifestWatcher = _mockFileWatchers[0];

      // Trigger a change but don't let debounce complete
      manifestWatcher._simulateChange(vscode.Uri.file('/test/workspace/target/manifest.json'));
      vi.advanceTimersByTime(100);

      // Dispose before debounce completes
      service.dispose();

      // Advance past what would have been the debounce
      vi.advanceTimersByTime(300);

      // Listener should not have been called
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
