/**
 * #113 — why the manifest is missing (booleans only, never a path) and
 * whether Run dbt parse produced it.
 */
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  manifestAppearanceFeature,
  manifestMissingReasons,
  PARSE_CONVERSION_WINDOW_MS,
} from '../../src/services/manifestMissingReasons';
import { defaultDbtProjectConfig, type DbtProjectConfig } from '../../src/services/dbtProjectConfig';
import { MANIFEST_MISSING_REASON_FEATURES, recordManifestMissingReasons } from '../../src/extension';
import { telemetry } from '../../src/services/telemetryService';
import {
  buildHeartbeat,
  emptyCounters,
  FEATURES,
  recordFeatureOnce,
  type DailyCounters,
  type HeartbeatEnv,
} from '../../src/services/telemetryPayload';

const ROOT = path.resolve('/home/jane.doe/acme-dbt');
const config = (targetPath = 'target'): DbtProjectConfig => ({ ...defaultDbtProjectConfig(), targetPath });
const exists = (paths: string[]) => (p: string) => paths.includes(p);
const TARGET = path.resolve(ROOT, 'target');

afterEach(() => vi.restoreAllMocks());

describe('manifestMissingReasons', () => {
  it('reports nothing when the target dir exists, the path is default and dbt is found', () => {
    expect(manifestMissingReasons(ROOT, config(), { existsSync: exists([TARGET]), candidates: () => 1 })).toEqual([]);
  });

  it('noTargetDir alone', () => {
    expect(manifestMissingReasons(ROOT, config(), { existsSync: exists([]), candidates: () => 2 })).toEqual(['noTargetDir']);
  });

  it('customTargetPath alone (the custom dir exists)', () => {
    const custom = path.resolve(ROOT, 'build/artifacts');
    expect(manifestMissingReasons(ROOT, config('build/artifacts'), { existsSync: exists([custom]), candidates: () => 1 }))
      .toEqual(['customTargetPath']);
  });

  it('resolves an absolute target path as it is', () => {
    const abs = path.resolve('/var/dbt/out');
    const seen: string[] = [];
    manifestMissingReasons(ROOT, config(abs), { existsSync: (p) => { seen.push(p); return true; }, candidates: () => 1 });
    expect(seen).toEqual([abs]);
  });

  it('noDbtFound alone', () => {
    expect(manifestMissingReasons(ROOT, config(), { existsSync: exists([TARGET]), candidates: () => 0 })).toEqual(['noDbtFound']);
  });

  it('all three combined, in a fixed order', () => {
    expect(manifestMissingReasons(ROOT, config('/elsewhere'), { existsSync: () => false, candidates: () => 0 }))
      .toEqual(['noTargetDir', 'customTargetPath', 'noDbtFound']);
  });

  it('never throws; a failing check contributes nothing', () => {
    const boom = () => { throw new Error('EACCES /home/jane.doe'); };
    expect(manifestMissingReasons(ROOT, config(), { existsSync: boom, candidates: boom })).toEqual([]);
  });
});

describe('manifestAppearanceFeature', () => {
  const NOW = 1_800_000_000_000;

  it('records nothing unless the manifest was missing and exists now', () => {
    expect(manifestAppearanceFeature(false, true, NOW - 1000, NOW)).toBeNull();
    expect(manifestAppearanceFeature(true, false, NOW - 1000, NOW)).toBeNull();
    expect(manifestAppearanceFeature(false, false, undefined, NOW)).toBeNull();
  });

  it('manifestAppeared when Run dbt parse never launched', () => {
    expect(manifestAppearanceFeature(true, true, undefined, NOW)).toBe('manifestAppeared');
  });

  it('manifestAfterParse within 10 minutes of a launch (inclusive)', () => {
    expect(manifestAppearanceFeature(true, true, NOW - 30_000, NOW)).toBe('manifestAfterParse');
    expect(manifestAppearanceFeature(true, true, NOW - PARSE_CONVERSION_WINDOW_MS, NOW)).toBe('manifestAfterParse');
  });

  it('manifestAppeared once the window has passed', () => {
    expect(manifestAppearanceFeature(true, true, NOW - PARSE_CONVERSION_WINDOW_MS - 1, NOW)).toBe('manifestAppeared');
  });

  it('manifestAppeared for a launch timestamp in the future (clock change)', () => {
    expect(manifestAppearanceFeature(true, true, NOW + 60_000, NOW)).toBe('manifestAppeared');
  });
});

describe('recordManifestMissingReasons (extension wiring)', () => {
  it('records one once-per-day feature per reason', () => {
    const once = vi.spyOn(telemetry, 'featureOnce');
    recordManifestMissingReasons(ROOT, config('/elsewhere'), { existsSync: () => false, candidates: () => 0 });
    expect(once.mock.calls.map((c) => c[0])).toEqual(['manifestNoTargetDir', 'manifestCustomTargetPath', 'manifestNoDbtFound']);
  });

  it('records nothing when no reason holds, and never throws', () => {
    const once = vi.spyOn(telemetry, 'featureOnce');
    recordManifestMissingReasons(ROOT, config(), { existsSync: () => true, candidates: () => 1 });
    expect(once).not.toHaveBeenCalled();
    once.mockImplementation(() => { throw new Error('boom'); });
    expect(() => recordManifestMissingReasons(ROOT, config('x'), { existsSync: () => false, candidates: () => 0 })).not.toThrow();
  });

  it('maps every reason to a listed feature key', () => {
    for (const f of Object.values(MANIFEST_MISSING_REASON_FEATURES)) {
      expect(FEATURES).toContain(f);
    }
  });
});

describe('no path reaches the heartbeat', () => {
  it('a custom absolute target path is a yes/no only', () => {
    const secretPath = '/Users/jane.doe/acme-dbt/custom-target';
    let s: DailyCounters = emptyCounters('2026-09-28');
    for (const reason of manifestMissingReasons(ROOT, config(secretPath), { existsSync: () => false, candidates: () => 0 })) {
      s = recordFeatureOnce(s, MANIFEST_MISSING_REASON_FEATURES[reason]);
      s = recordFeatureOnce(s, MANIFEST_MISSING_REASON_FEATURES[reason]);
    }
    const env: HeartbeatEnv = {
      installId: '3b241101-e2bb-4255-8caf-4136c566a962',
      extVersion: '1.6.3',
      vscodeVersion: '1.104.2',
      platform: 'darwin',
      firstSeenDay: '2026-09-01',
    };
    const body = buildHeartbeat(s, env);
    expect(body.features).toEqual({ manifestNoTargetDir: 1, manifestCustomTargetPath: 1, manifestNoDbtFound: 1 });
    const json = JSON.stringify(body);
    for (const leak of [secretPath, 'jane', 'acme', 'custom-target', ROOT]) {
      expect(json).not.toContain(leak);
    }
  });
});
