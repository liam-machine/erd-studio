import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { checkManifestStaleness } from '../../src/services/stalenessService';

/**
 * The vscode mock's `workspace.findFiles` returns no files, so these tests
 * exercise the manifest-path resolution (target-path honoured) rather than
 * source mtime comparison.
 */
describe('checkManifestStaleness (H30 target-path)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports a missing manifest as stale', async () => {
    const result = await checkManifestStaleness(tmpDir);
    expect(result).toEqual({ isStale: true, manifestMtime: null, newestSourceMtime: null });
  });

  it('reads the manifest from the target-path in dbt_project.yml', async () => {
    fs.writeFileSync(path.join(tmpDir, 'dbt_project.yml'), 'name: p\ntarget-path: build\n');
    fs.mkdirSync(path.join(tmpDir, 'build'));
    fs.writeFileSync(path.join(tmpDir, 'build', 'manifest.json'), '{}');

    const result = await checkManifestStaleness(tmpDir);
    expect(result.isStale).toBe(false);
    expect(result.manifestMtime).not.toBeNull();
  });

  it('honours an explicitly passed DbtProjectConfig', async () => {
    fs.mkdirSync(path.join(tmpDir, 'dbt_target'));
    fs.writeFileSync(path.join(tmpDir, 'dbt_target', 'manifest.json'), '{}');

    const withConfig = await checkManifestStaleness(tmpDir, { targetPath: 'dbt_target', modelPaths: ['models'] });
    expect(withConfig.isStale).toBe(false);

    // Default config looks in target/ which does not exist here
    const withDefaults = await checkManifestStaleness(tmpDir);
    expect(withDefaults.isStale).toBe(true);
  });
});
