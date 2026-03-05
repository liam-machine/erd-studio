/**
 * FileWatcherService unit tests.
 *
 * Tests the file watcher service's event emission and debouncing behavior.
 * Uses mocked VS Code FileSystemWatcher API.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

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
    service = new FileWatcherService('/test/workspace');
  });

  describe('initialization', () => {
    it('creates three file system watchers', () => {
      expect(_mockFileWatchers).toHaveLength(3);
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

    it('emits onSemanticFileChanged when semantic file is deleted', () => {
      const listener = vi.fn();
      service.onSemanticFileChanged(listener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri = vscode.Uri.file('/test/workspace/erd-studio/silver/deleted.json');
      semanticWatcher._simulateDelete(uri);
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledWith({ uri });
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
    it('emits onProjectConfigChanged when dbt_project.yml changes', () => {
      const listener = vi.fn();
      service.onProjectConfigChanged(listener);

      const projectWatcher = _mockFileWatchers[2];
      projectWatcher._simulateChange(vscode.Uri.file('/test/workspace/dbt_project.yml'));
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledTimes(1);
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
