import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  checkManifestStalenessFromMtimes,
  checkManifestStalenessFs,
  listSourceMtimesFs,
  readManifestMtime,
} from '../../src/services/manifestStaleness';
import { defaultDbtProjectConfig } from '../../src/services/dbtProjectConfig';

describe('checkManifestStalenessFromMtimes', () => {
  it('treats a missing manifest as stale', () => {
    expect(checkManifestStalenessFromMtimes(null, [5, 6])).toEqual({ isStale: true, manifestMtime: null, newestSourceMtime: null });
  });

  it('is fresh with no sources', () => {
    expect(checkManifestStalenessFromMtimes(100, [])).toEqual({ isStale: false, manifestMtime: 100, newestSourceMtime: null });
  });

  it('is stale when the newest source is newer than the manifest', () => {
    expect(checkManifestStalenessFromMtimes(100, [50, 150, 90])).toEqual({ isStale: true, manifestMtime: 100, newestSourceMtime: 150 });
  });

  it('is fresh when every source is older or equal', () => {
    expect(checkManifestStalenessFromMtimes(100, [50, 100])).toEqual({ isStale: false, manifestMtime: 100, newestSourceMtime: 100 });
  });

  it('accepts any iterable', () => {
    expect(checkManifestStalenessFromMtimes(10, new Set([20])).isStale).toBe(true);
  });
});

describe('fs listing', () => {
  let tmp: string;
  const touch = (rel: string, mtimeSec: number) => {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.utimesSync(file, mtimeSec, mtimeSec);
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-staleness-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('walks model-paths for sql/yml/yaml, skipping packages, venvs and target', () => {
    touch('models/a.sql', 1000);
    touch('models/sub/b.yml', 2000);
    touch('models/sub/c.YAML', 3000);
    touch('models/readme.md', 9000);
    touch('models/dbt_packages/x.sql', 9000);
    touch('models/.venv/y.sql', 9000);
    touch('models/target/z.sql', 9000);
    touch('seeds/s.sql', 9000);
    const mtimes = listSourceMtimesFs(tmp, defaultDbtProjectConfig()).map((m) => Math.round(m / 1000)).sort();
    expect(mtimes).toEqual([1000, 2000, 3000]);
  });

  it('honours configured model-paths and the file cap', () => {
    touch('src_models/a.sql', 1000);
    touch('src_models/b.sql', 1000);
    touch('models/c.sql', 1000);
    const config = { ...defaultDbtProjectConfig(), modelPaths: ['src_models'] };
    expect(listSourceMtimesFs(tmp, config)).toHaveLength(2);
    expect(listSourceMtimesFs(tmp, config, 1)).toHaveLength(1);
  });

  it('checkManifestStalenessFs combines both', () => {
    const config = defaultDbtProjectConfig();
    expect(checkManifestStalenessFs(tmp, config).isStale).toBe(true);
    expect(readManifestMtime(tmp, config)).toBeNull();

    touch('target/manifest.json', 2000);
    touch('models/a.sql', 1000);
    expect(checkManifestStalenessFs(tmp, config)).toMatchObject({ isStale: false });

    touch('models/b.sql', 3000);
    const result = checkManifestStalenessFs(tmp, config);
    expect(result.isStale).toBe(true);
    expect(Math.round(result.newestSourceMtime! / 1000)).toBe(3000);
  });
});
