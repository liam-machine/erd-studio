/**
 * `dbt docs generate` writes catalog.json and then rewrites manifest.json, so the catalog's
 * mtime trails the manifest's even though both are fresh. The CLI treats artifacts from the same
 * dbt run (same metadata.invocation_id) as current rather than reporting "older-than-manifest".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readInvocationId, sameDbtInvocation } from '../../src/cli/context';

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
