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

import { FileWatcherService, classifySemanticPath } from '../../src/watchers/FileWatcherService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
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

    it('watches the default target/manifest.json path', () => {
      const pattern = _mockFileWatchers[0]._pattern as vscode.RelativePattern;
      expect(pattern.pattern).toBe('target/manifest.json');
    });

    it('emits onManifestChanged when manifest.json is deleted (dbt clean)', () => {
      const listener = vi.fn();
      service.onManifestChanged(listener);

      _mockFileWatchers[0]._simulateDelete(vscode.Uri.file('/test/workspace/target/manifest.json'));
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
      const uri = vscode.Uri.file('/test/workspace/.erd-studio/silver/orders.json');
      semanticWatcher._simulateChange(uri);
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledWith({ uri });
    });

    it('emits onSemanticFileChanged when semantic file is created', () => {
      const listener = vi.fn();
      service.onSemanticFileChanged(listener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri = vscode.Uri.file('/test/workspace/.erd-studio/gold/new-domain.json');
      semanticWatcher._simulateCreate(uri);
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledWith({ uri });
    });

    it('emits onSemanticFileDeleted when semantic file is deleted', () => {
      const listener = vi.fn();
      service.onSemanticFileDeleted(listener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri = vscode.Uri.file('/test/workspace/.erd-studio/silver/deleted.json');
      semanticWatcher._simulateDelete(uri);
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledWith({ uris: [uri] });
    });

    it('coalesces a burst of domain deletes into a single event (H33)', () => {
      const listener = vi.fn();
      service.onSemanticFileDeleted(listener);

      const semanticWatcher = _mockFileWatchers[1];
      const uris = Array.from({ length: 20 }, (_, i) =>
        vscode.Uri.file(`/test/workspace/.erd-studio/silver/domain-${i}.json`));
      for (const uri of uris) {
        semanticWatcher._simulateDelete(uri);
        vi.advanceTimersByTime(10);
      }
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledTimes(1);
      const payload = listener.mock.calls[0][0] as { uris: vscode.Uri[] };
      expect(payload.uris).toHaveLength(20);
      expect(payload.uris.map(u => u.fsPath)).toEqual(uris.map(u => u.fsPath));
    });

    it('does not emit onSemanticFileDeleted for non-domain JSON files (H33)', () => {
      const listener = vi.fn();
      service.onSemanticFileDeleted(listener);

      const semanticWatcher = _mockFileWatchers[1];
      semanticWatcher._simulateDelete(vscode.Uri.file('/test/workspace/.erd-studio/layers.json'));
      semanticWatcher._simulateDelete(vscode.Uri.file('/test/workspace/.erd-studio/templates/fact.json'));
      semanticWatcher._simulateDelete(vscode.Uri.file('/test/workspace/.erd-studio/logical-models/dim.json'));
      semanticWatcher._simulateDelete(vscode.Uri.file('/test/workspace/.erd-studio/.sync-plan.json'));
      semanticWatcher._simulateDelete(vscode.Uri.file('/test/workspace/.erd-studio/silver/nested/deep.json'));
      semanticWatcher._simulateDelete(vscode.Uri.file('/test/workspace/.erd-studio/.hidden/x.json'));
      vi.advanceTimersByTime(300);

      expect(listener).not.toHaveBeenCalled();
    });

    it('only includes real domain files when a mixed burst is deleted (H33)', () => {
      const listener = vi.fn();
      service.onSemanticFileDeleted(listener);

      const semanticWatcher = _mockFileWatchers[1];
      const domainUri = vscode.Uri.file('/test/workspace/.erd-studio/gold/reporting.json');
      semanticWatcher._simulateDelete(vscode.Uri.file('/test/workspace/.erd-studio/layers.json'));
      semanticWatcher._simulateDelete(domainUri);
      semanticWatcher._simulateDelete(vscode.Uri.file('/test/workspace/.erd-studio/.sync-plan.json'));
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ uris: [domainUri] });
    });

    it('routes layers.json changes to onLayerConfigChanged, not onSemanticFileChanged (H18)', () => {
      const semanticListener = vi.fn();
      const layerListener = vi.fn();
      service.onSemanticFileChanged(semanticListener);
      service.onLayerConfigChanged(layerListener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri = vscode.Uri.file('/test/workspace/.erd-studio/layers.json');
      semanticWatcher._simulateChange(uri);
      semanticWatcher._simulateChange(uri);
      vi.advanceTimersByTime(300);

      expect(semanticListener).not.toHaveBeenCalled();
      expect(layerListener).toHaveBeenCalledTimes(1);
    });

    it('fires onLayerConfigChanged when layers.json is created or deleted (H18)', () => {
      const layerListener = vi.fn();
      service.onLayerConfigChanged(layerListener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri = vscode.Uri.file('/test/workspace/.erd-studio/layers.json');
      semanticWatcher._simulateCreate(uri);
      vi.advanceTimersByTime(300);
      semanticWatcher._simulateDelete(uri);
      vi.advanceTimersByTime(300);

      expect(layerListener).toHaveBeenCalledTimes(2);
    });

    it('does not treat a layers.json inside a layer directory as layer config', () => {
      const semanticListener = vi.fn();
      const layerListener = vi.fn();
      service.onSemanticFileChanged(semanticListener);
      service.onLayerConfigChanged(layerListener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri = vscode.Uri.file('/test/workspace/.erd-studio/silver/layers.json');
      semanticWatcher._simulateChange(uri);
      vi.advanceTimersByTime(300);

      expect(layerListener).not.toHaveBeenCalled();
      expect(semanticListener).toHaveBeenCalledWith({ uri });
    });

    it('does not emit onSemanticFileChanged when semantic file is deleted', () => {
      const listener = vi.fn();
      service.onSemanticFileChanged(listener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri = vscode.Uri.file('/test/workspace/.erd-studio/silver/deleted.json');
      semanticWatcher._simulateDelete(uri);
      vi.advanceTimersByTime(300);

      expect(listener).not.toHaveBeenCalled();
    });

    it('debounces changes per file independently', () => {
      const listener = vi.fn();
      service.onSemanticFileChanged(listener);

      const semanticWatcher = _mockFileWatchers[1];
      const uri1 = vscode.Uri.file('/test/workspace/.erd-studio/silver/file1.json');
      const uri2 = vscode.Uri.file('/test/workspace/.erd-studio/silver/file2.json');

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

  describe('dbt_project.yml path configuration (H30)', () => {
    it('builds the manifest watcher from target-path', () => {
      _clearMockFileWatchers();
      mockDbtProjectContent = 'name: p\ntarget-path: build\n';
      service.dispose();
      service = new FileWatcherService('/test/workspace');

      const pattern = _mockFileWatchers[0]._pattern as vscode.RelativePattern;
      expect(pattern.pattern).toBe('build/manifest.json');
    });

    it('builds the dbt schema watcher from model-paths', () => {
      _clearMockFileWatchers();
      mockDbtProjectContent = 'name: p\nmodel-paths:\n  - models\n  - transform\n';
      service.dispose();
      service = new FileWatcherService('/test/workspace');

      // dbt yml watcher is the last one created
      const pattern = _mockFileWatchers[_mockFileWatchers.length - 1]._pattern as vscode.RelativePattern;
      expect(pattern.pattern).toBe('{models,transform}/**/*.{yml,yaml}');
    });

    it('prefers an explicitly passed DbtProjectConfig over re-reading dbt_project.yml', () => {
      _clearMockFileWatchers();
      service.dispose();
      service = new FileWatcherService('/test/workspace', '.erd-studio', {
        targetPath: 'dbt_target',
        modelPaths: ['marts'],
      });

      expect((_mockFileWatchers[0]._pattern as vscode.RelativePattern).pattern).toBe('dbt_target/manifest.json');
      expect((_mockFileWatchers[_mockFileWatchers.length - 1]._pattern as vscode.RelativePattern).pattern)
        .toBe('marts/**/*.{yml,yaml}');
    });

    it('uses dbt defaults for the watchers when dbt_project.yml has no path keys', () => {
      _clearMockFileWatchers();
      mockDbtProjectContent = 'name: p\n';
      service.dispose();
      service = new FileWatcherService('/test/workspace');

      expect((_mockFileWatchers[0]._pattern as vscode.RelativePattern).pattern).toBe('target/manifest.json');
      expect((_mockFileWatchers[_mockFileWatchers.length - 1]._pattern as vscode.RelativePattern).pattern)
        .toBe('models/**/*.{yml,yaml}');
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

  describe('own-write suppression (H11)', () => {
    let tracker: OwnWriteTracker;

    beforeEach(() => {
      _clearMockFileWatchers();
      tracker = new OwnWriteTracker();
      service = new FileWatcherService('/test/workspace', '.erd-studio', undefined, tracker);
    });

    it('swallows a logical-model change recorded as an own write', () => {
      const listener = vi.fn();
      service.onLogicalModelChanged(listener);

      const modelPath = '/test/workspace/.erd-studio/logical-models/dim_customer.yml';
      // File does not exist on disk in this test, so both the record and the
      // watcher check see the same (null) signature — an exact match.
      tracker.recordWrite(modelPath);

      const modelWatcher = _mockFileWatchers[3];
      modelWatcher._simulateChange(vscode.Uri.file(modelPath));
      vi.advanceTimersByTime(300);

      expect(listener).not.toHaveBeenCalled();
    });

    it('still reports a logical-model change that was not recorded', () => {
      const listener = vi.fn();
      service.onLogicalModelChanged(listener);

      const modelWatcher = _mockFileWatchers[3];
      modelWatcher._simulateChange(vscode.Uri.file('/test/workspace/.erd-studio/logical-models/dim_x.yml'));
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].modelName).toBe('dim_x');
    });

    it('consumes the record so the next event for the same file is reported', () => {
      const listener = vi.fn();
      service.onLogicalModelChanged(listener);

      const modelPath = '/test/workspace/.erd-studio/logical-models/dim_customer.yml';
      tracker.recordWrite(modelPath);

      const modelWatcher = _mockFileWatchers[3];
      modelWatcher._simulateChange(vscode.Uri.file(modelPath));
      vi.advanceTimersByTime(300);
      expect(listener).not.toHaveBeenCalled();

      modelWatcher._simulateChange(vscode.Uri.file(modelPath));
      vi.advanceTimersByTime(300);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('drops an own domain delete from the coalesced delete event', () => {
      const listener = vi.fn();
      service.onSemanticFileDeleted(listener);

      const ownPath = '/test/workspace/.erd-studio/silver/mine.json';
      const externalUri = vscode.Uri.file('/test/workspace/.erd-studio/silver/theirs.json');
      tracker.recordDelete(ownPath);

      const semanticWatcher = _mockFileWatchers[1];
      semanticWatcher._simulateDelete(vscode.Uri.file(ownPath));
      semanticWatcher._simulateDelete(externalUri);
      vi.advanceTimersByTime(300);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ uris: [externalUri] });
    });

    it('emits nothing when every deleted domain was an own delete', () => {
      const listener = vi.fn();
      service.onSemanticFileDeleted(listener);

      const ownPath = '/test/workspace/.erd-studio/silver/mine.json';
      tracker.recordDelete(ownPath);

      const semanticWatcher = _mockFileWatchers[1];
      semanticWatcher._simulateDelete(vscode.Uri.file(ownPath));
      vi.advanceTimersByTime(300);

      expect(listener).not.toHaveBeenCalled();
    });

    it('swallows a layers.json write recorded by LayerService.saveConfig', () => {
      const listener = vi.fn();
      service.onLayerConfigChanged(listener);

      const configPath = '/test/workspace/.erd-studio/layers.json';
      tracker.recordWrite(configPath);

      const semanticWatcher = _mockFileWatchers[1];
      semanticWatcher._simulateChange(vscode.Uri.file(configPath));
      vi.advanceTimersByTime(300);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('classifySemanticPath', () => {
    const root = '/ws/.erd-studio';

    it('identifies {layer}/{domain}.json as a domain file', () => {
      expect(classifySemanticPath(root, '/ws/.erd-studio/silver/orders.json')).toBe('domain');
      expect(classifySemanticPath(root, '/ws/.erd-studio/platinum/x.json')).toBe('domain');
    });

    it('identifies the root layers.json as layer config', () => {
      expect(classifySemanticPath(root, '/ws/.erd-studio/layers.json')).toBe('layer-config');
    });

    it('rejects reserved directories, dotfiles, nested paths and non-json', () => {
      expect(classifySemanticPath(root, '/ws/.erd-studio/templates/fact.json')).toBe('other');
      expect(classifySemanticPath(root, '/ws/.erd-studio/logical-models/dim.json')).toBe('other');
      expect(classifySemanticPath(root, '/ws/.erd-studio/.sync-plan.json')).toBe('other');
      expect(classifySemanticPath(root, '/ws/.erd-studio/silver/.draft.json')).toBe('other');
      expect(classifySemanticPath(root, '/ws/.erd-studio/silver/a/b.json')).toBe('other');
      expect(classifySemanticPath(root, '/ws/.erd-studio/silver/orders.yml')).toBe('other');
      expect(classifySemanticPath(root, '/ws/other/silver/orders.json')).toBe('other');
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
