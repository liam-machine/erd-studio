/**
 * A manifest written by Parse without your credentials carries
 * `metadata.env.ERD_STUDIO_THROWAWAY_PROFILE = "1"` (dbt copies the
 * `DBT_ENV_CUSTOM_ENV_*` variable there). Its schemas are placeholders
 * (`erd_studio_placeholder`), so they are blanked on load and never shown
 * or written into the user's files; `config.schema` is the user's own and
 * is kept.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ManifestService } from '../../src/services/manifestService';
import { THROWAWAY_MARKER_KEY } from '../../src/types/manifest';
import { extractManifestData } from '../../src/workers/manifestExtractor';

function node(uniqueId: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unique_id: uniqueId,
    name,
    schema: 'erd_studio_placeholder',
    description: '',
    columns: { id: { name: 'id', data_type: null, description: '' }, k1: { name: 'k1' }, k2: { name: 'k2' } },
    ...extra,
  };
}

function manifest(env: unknown): Record<string, unknown> {
  return {
    metadata: { dbt_schema_version: 'v12', adapter_type: 'duckdb', env },
    nodes: {
      'model.p.fct': node('model.p.fct', 'fct', {
        config: { schema: 'finance' },
        constraints: [{ type: 'foreign_key', columns: ['k1', 'k2'], to: '"memory"."erd_studio_placeholder"."dim"', to_columns: ['k1', 'k2'] }],
      }),
      'model.p.dim': node('model.p.dim', 'dim'),
      'seed.p.codes': node('seed.p.codes', 'codes'),
    },
  };
}

describe('extractManifestData — placeholder manifests', () => {
  it('the marker blanks every schema and sets placeholderProfile', () => {
    const r = extractManifestData(manifest({ [THROWAWAY_MARKER_KEY]: '1' }));
    expect(r.placeholderProfile).toBe(true);
    for (const m of Object.values(r.models)) expect(m.schema).toBe('');
    for (const m of Object.values(r.resourceDocs ?? {})) expect(m.schema).toBe('');
    expect(r.models.fct.configSchema).toBe('finance');
    // Composite FK targets resolve by the relation's last segment.
    expect(r.compositeForeignKeys).toEqual([{ fromModel: 'fct', fromColumns: ['k1', 'k2'], toModel: 'dim', toColumns: ['k1', 'k2'] }]);
  });

  it.each([
    ['no marker', {}],
    ['other env keys', { OTHER: '1' }],
    ['env not an object', '1'],
    ['env an array', ['1']],
    ['marker "1 "', { [THROWAWAY_MARKER_KEY]: '1 ' }],
    ['marker number 1', { [THROWAWAY_MARKER_KEY]: 1 }],
    ['marker true', { [THROWAWAY_MARKER_KEY]: true }],
  ])('%s leaves the manifest as it is', (_label, env) => {
    const r = extractManifestData(manifest(env));
    expect(r.placeholderProfile).toBeUndefined();
    expect(r.models.fct.schema).toBe('erd_studio_placeholder');
  });

  it('metadata that is not an object is ignored', () => {
    expect(extractManifestData({ metadata: 'x', nodes: {} }).placeholderProfile).toBeUndefined();
    expect(extractManifestData({ metadata: null, nodes: {} }).placeholderProfile).toBeUndefined();
  });

  it('the no-`nodes` early return carries the flag', () => {
    const r = extractManifestData({ metadata: { env: { [THROWAWAY_MARKER_KEY]: '1' } } });
    expect(r.placeholderProfile).toBe(true);
    expect(r.models).toEqual({});
  });
});

describe('ManifestService — placeholderProfile', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-placeholder-'));
    fs.mkdirSync(path.join(tmp, 'target'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const write = (env: unknown) => fs.writeFileSync(path.join(tmp, 'target', 'manifest.json'), JSON.stringify(manifest(env)));

  it.each([true, false])('maps the flag (parseInProcess: %s)', async (parseInProcess) => {
    write({ [THROWAWAY_MARKER_KEY]: '1' });
    const svc = new ManifestService({ parseInProcess });
    const data = await svc.loadManifest(tmp);
    expect(data.placeholderProfile).toBe(true);
    expect(data.models.get('fct')?.schema).toBe('');
    expect(svc.placeholderProfile).toBe(true);

    write({});
    svc.invalidate();
    const real = await svc.loadManifest(tmp);
    expect(real.placeholderProfile).toBeUndefined();
    expect(real.models.get('fct')?.schema).toBe('erd_studio_placeholder');
    expect(svc.placeholderProfile).toBe(false);
  });
});
