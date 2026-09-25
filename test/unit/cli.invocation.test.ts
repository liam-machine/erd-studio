/**
 * `dbt docs generate` writes catalog.json and then rewrites manifest.json, so the catalog's
 * mtime trails the manifest's even though both are fresh. The CLI treats artifacts from the same
 * dbt run (same metadata.invocation_id) as current rather than reporting "older-than-manifest".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { catalogOlderThanManifest, readGeneratedAt, readInvocationId, sameDbtInvocation } from '../../src/cli/context';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-inv-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function artifact(name: string, invocationId: string | null, padding = 0): string {
  const file = path.join(tmp, name);
  const metadata = invocationId ? { dbt_version: '1.12.5', invocation_id: invocationId } : { dbt_version: '1.12.5' };
  fs.writeFileSync(file, JSON.stringify({ metadata, nodes: { pad: 'x'.repeat(padding) } }));
  return file;
}

describe('dbt invocation matching', () => {
  it('reads metadata.invocation_id from the head of the file, even when the file is large', () => {
    expect(readInvocationId(artifact('manifest.json', 'abc-123', 2_000_000))).toBe('abc-123');
  });

  it('matches artifacts from one run and not from different runs', () => {
    const manifest = artifact('manifest.json', 'run-1');
    expect(sameDbtInvocation(artifact('catalog.json', 'run-1'), manifest)).toBe(true);
    expect(sameDbtInvocation(artifact('catalog2.json', 'run-2'), manifest)).toBe(false);
  });

  it('never matches when either id is missing or the file does not exist', () => {
    const manifest = artifact('manifest.json', null);
    expect(sameDbtInvocation(artifact('catalog.json', null), manifest)).toBe(false);
    expect(sameDbtInvocation(path.join(tmp, 'nope.json'), manifest)).toBe(false);
  });
});

describe('catalog freshness uses the times dbt recorded, not file times', () => {
  function stamped(name: string, generatedAt: string | null, invocationId: string): string {
    const file = path.join(tmp, name);
    const metadata: Record<string, string> = { invocation_id: invocationId };
    if (generatedAt) { metadata.generated_at = generatedAt; }
    fs.writeFileSync(file, JSON.stringify({ metadata }));
    return file;
  }

  it('reads metadata.generated_at', () => {
    expect(readGeneratedAt(stamped('m.json', '2026-02-11T04:12:57.913204Z', 'a'))).toBe(Date.parse('2026-02-11T04:12:57.913Z'));
    expect(readGeneratedAt(stamped('n.json', null, 'a'))).toBeNull();
  });

  it('a fresh git checkout cannot make a newer catalog look stale', () => {
    // The checkout wrote catalog.json first (older mtime), but dbt generated it after the manifest.
    const manifest = stamped('manifest.json', '2025-01-15T10:30:00Z', 'run-1');
    const catalog = stamped('catalog.json', '2026-02-11T04:12:57Z', 'run-2');
    expect(catalogOlderThanManifest(catalog, manifest, 1000, 2000)).toBe(false);
  });

  it('flags a catalog generated before a later dbt parse, whatever the file times say', () => {
    const manifest = stamped('manifest.json', '2026-03-01T00:00:00Z', 'run-2');
    const catalog = stamped('catalog.json', '2026-02-01T00:00:00Z', 'run-1');
    expect(catalogOlderThanManifest(catalog, manifest, 5000, 1000)).toBe(true);
  });

  it('treats one dbt run as current, and falls back to file times without recorded times', () => {
    const same = stamped('m2.json', '2026-03-01T00:00:02Z', 'run-9');
    expect(catalogOlderThanManifest(stamped('c2.json', '2026-03-01T00:00:01Z', 'run-9'), same, 1, 2)).toBe(false);
    const bareM = stamped('m3.json', null, 'x');
    const bareC = stamped('c3.json', null, 'y');
    expect(catalogOlderThanManifest(bareC, bareM, 1, 2)).toBe(true);
    expect(catalogOlderThanManifest(bareC, bareM, 3, 2)).toBe(false);
  });
});
