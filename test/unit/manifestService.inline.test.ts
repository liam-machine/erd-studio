/**
 * `parseInProcess` must produce exactly what the worker path produces, and
 * keep the same missing / empty / malformed semantics in `loadManifest`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ManifestService } from '../../src/services/manifestService';

const FIXTURES = path.resolve(__dirname, '../fixtures');

describe('ManifestService parseInProcess', () => {
  it.each(['dbt-project', 'dbt-project-sparse', 'dbt-project-empty-manifest'])(
    'deep-equals the worker result for %s',
    async (fixture) => {
      const root = path.join(FIXTURES, fixture);
      const viaWorker = await new ManifestService().loadManifest(root);
      const inline = new ManifestService({ parseInProcess: true });
      const viaInline = await inline.loadManifest(root);
      expect(viaInline).toEqual(viaWorker);
      expect(inline.isStale).toBe(false);
    },
  );

  it('parses the main fixture into models', async () => {
    const data = await new ManifestService({ parseInProcess: true }).loadManifest(path.join(FIXTURES, 'dbt-project'));
    expect(data.models.size).toBeGreaterThan(0);
  });

  describe('failure modes', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-inline-'));
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('reports a missing manifest as missing, empty and not stale', async () => {
      const svc = new ManifestService({ parseInProcess: true });
      const data = await svc.loadManifest(tmp);
      expect(data.models.size).toBe(0);
      expect(svc.isMissing).toBe(true);
      expect(svc.isStale).toBe(false);
    });

    it('treats malformed JSON as stale and serves empty data', async () => {
      fs.mkdirSync(path.join(tmp, 'target'));
      fs.writeFileSync(path.join(tmp, 'target', 'manifest.json'), '{"nodes": {');
      const svc = new ManifestService({ parseInProcess: true });
      const data = await svc.loadManifest(tmp);
      expect(data.models.size).toBe(0);
      expect(svc.isStale).toBe(true);
      expect(svc.isMissing).toBe(false);
    });

    it('honours target-path via dbtConfig', async () => {
      fs.mkdirSync(path.join(tmp, 'build'));
      fs.copyFileSync(path.join(FIXTURES, 'dbt-project', 'target', 'manifest.json'), path.join(tmp, 'build', 'manifest.json'));
      const svc = new ManifestService({ parseInProcess: true, dbtConfig: { targetPath: 'build' } });
      const data = await svc.loadManifest(tmp);
      expect(data.models.size).toBeGreaterThan(0);
      expect(svc.isMissing).toBe(false);
    });
  });
});
