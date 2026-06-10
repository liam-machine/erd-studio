import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as yamlParse } from 'yaml';

import { SelectorsService } from '../../src/services/selectorsService';
import type { SelectorsServiceHooks, SkipInfo } from '../../src/services/selectorsService';
import type { DomainService } from '../../src/services/domainService';

interface FakeDomain {
  domain: string;
  layer: string;
  filePath: string;
  models: string[];
}

function fakeDomainService(domains: FakeDomain[]): DomainService {
  return {
    listDomains: () =>
      domains.map((d) => ({ domain: d.domain, layer: d.layer, filePath: d.filePath })),
    getDomain: (filePath: string) => {
      const found = domains.find((d) => d.filePath === filePath);
      if (!found) { throw new Error(`Not found: ${filePath}`); }
      return {
        schemaVersion: 5,
        domain: found.domain,
        layer: found.layer,
        description: '',
        logical: {
          models: found.models.map((name) => ({ name, columns: [] })),
          relationships: [],
        },
        viewConfig: {},
      };
    },
  } as unknown as DomainService;
}

interface ParsedSelectors {
  selectors: Array<{
    name: string;
    description?: string;
    definition: { union: Array<{ method: string; value: string }> };
  }>;
}

function readSelectors(workspaceRoot: string): ParsedSelectors {
  const content = fs.readFileSync(path.join(workspaceRoot, 'selectors.yml'), 'utf-8');
  return yamlParse(content) as ParsedSelectors;
}

function writeSelectors(workspaceRoot: string, content: string): void {
  fs.writeFileSync(path.join(workspaceRoot, 'selectors.yml'), content, 'utf-8');
}

describe('SelectorsService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selectors-svc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits one selector per non-empty domain with snake_case names', () => {
    const svc = new SelectorsService(
      fakeDomainService([
        {
          domain: 'customer-360',
          layer: 'silver',
          filePath: '/dummy/silver/customer-360.json',
          models: ['dim_customer', 'fct_orders'],
        },
        {
          domain: 'reporting',
          layer: 'gold',
          filePath: '/dummy/gold/reporting.json',
          models: ['fct_revenue'],
        },
      ]),
      tmpDir,
      '.erd-studio',
    );

    const result = svc.regenerate();
    expect(result.status).toBe('written');
    if (result.status !== 'written') { throw new Error('expected written'); }
    expect(result.selectorsWritten).toBe(2);
    expect(result.modelsReferenced).toBe(3);

    const parsed = readSelectors(tmpDir);
    const names = parsed.selectors.map((s) => s.name);
    expect(names).toEqual(['domain_gold_reporting', 'domain_silver_customer_360']);

    const customer = parsed.selectors.find((s) => s.name === 'domain_silver_customer_360')!;
    expect(customer.definition.union).toEqual([
      { method: 'fqn', value: 'dim_customer' },
      { method: 'fqn', value: 'fct_orders' },
    ]);
  });

  it('references a conformed dimension in every domain that owns it', () => {
    const svc = new SelectorsService(
      fakeDomainService([
        {
          domain: 'customer-360',
          layer: 'silver',
          filePath: '/dummy/silver/customer-360.json',
          models: ['dim_customer', 'fct_orders'],
        },
        {
          domain: 'finance',
          layer: 'silver',
          filePath: '/dummy/silver/finance.json',
          models: ['dim_customer', 'fct_invoice'],
        },
      ]),
      tmpDir,
      '.erd-studio',
    );

    svc.regenerate();
    const parsed = readSelectors(tmpDir);

    const customer = parsed.selectors.find((s) => s.name === 'domain_silver_customer_360')!;
    const finance = parsed.selectors.find((s) => s.name === 'domain_silver_finance')!;
    expect(customer.definition.union.some((m) => m.value === 'dim_customer')).toBe(true);
    expect(finance.definition.union.some((m) => m.value === 'dim_customer')).toBe(true);
  });

  it('skips empty domains entirely', () => {
    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'placeholder', layer: 'silver', filePath: '/dummy/silver/placeholder.json', models: [] },
        { domain: 'real', layer: 'silver', filePath: '/dummy/silver/real.json', models: ['dim_real'] },
      ]),
      tmpDir,
      '.erd-studio',
    );

    const result = svc.regenerate();
    expect(result.status).toBe('written');
    if (result.status !== 'written') { throw new Error('expected written'); }
    expect(result.selectorsWritten).toBe(1);
    const parsed = readSelectors(tmpDir);
    expect(parsed.selectors.map((s) => s.name)).toEqual(['domain_silver_real']);
  });

  it('writes a header documenting the merge contract', () => {
    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['m1'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();
    const raw = fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8');
    expect(raw).toMatch(/^# ERD Studio manages selectors prefixed with `domain_`/);
    expect(raw).toContain('user-managed and preserved');
  });

  it('sanitizes non-alphanumeric characters in layer and domain names', () => {
    const svc = new SelectorsService(
      fakeDomainService([
        {
          domain: 'customer 360',
          layer: 'v2.0',
          filePath: '/dummy/v2.0/customer 360.json',
          models: ['dim_customer'],
        },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();

    const parsed = readSelectors(tmpDir);
    expect(parsed.selectors[0].name).toBe('domain_v2_0_customer_360');
  });

  it('removes stale `domain_*` selectors from a previous regenerate', () => {
    writeSelectors(
      tmpDir,
      'selectors:\n  - name: domain_silver_old\n    definition:\n      union:\n        - method: fqn\n          value: ghost_model\n',
    );

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'new', layer: 'silver', filePath: '/x/silver/new.json', models: ['dim_new'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();

    const parsed = readSelectors(tmpDir);
    const names = parsed.selectors.map((s) => s.name);
    expect(names).toContain('domain_silver_new');
    expect(names).not.toContain('domain_silver_old');
  });

  // Read-merge-write behaviour ------------------------------------------------

  it('preserves user-managed selectors (not prefixed with `domain_`) across regenerate', () => {
    writeSelectors(
      tmpDir,
      [
        'selectors:',
        '  - name: incremental_critical',
        '    description: Nightly job',
        '    definition:',
        '      union:',
        '        - method: fqn',
        '          value: fct_orders',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();

    const parsed = readSelectors(tmpDir);
    const names = parsed.selectors.map((s) => s.name);
    expect(names).toContain('domain_silver_d');
    expect(names).toContain('incremental_critical');
    // Generated first, user-managed second.
    expect(names.indexOf('domain_silver_d')).toBeLessThan(names.indexOf('incremental_critical'));
  });

  it('preserves multiple user selectors in their original order', () => {
    writeSelectors(
      tmpDir,
      [
        'selectors:',
        '  - name: nightly_build',
        '    definition: { union: [{ method: fqn, value: fct_a }] }',
        '  - name: hourly_refresh',
        '    definition: { union: [{ method: fqn, value: fct_b }] }',
        '  - name: ad_hoc',
        '    definition: { union: [{ method: fqn, value: fct_c }] }',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();

    const parsed = readSelectors(tmpDir);
    const userNames = parsed.selectors.map((s) => s.name).filter((n) => !n.startsWith('domain_'));
    expect(userNames).toEqual(['nightly_build', 'hourly_refresh', 'ad_hoc']);
  });

  it('preserves comments attached to user-managed selectors', () => {
    writeSelectors(
      tmpDir,
      [
        'selectors:',
        '  # Used by the nightly incremental job — keep in sync with airflow DAG `incrementals_v2`',
        '  - name: incremental_critical',
        '    definition:',
        '      union:',
        '        - method: fqn',
        '          value: fct_orders',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();

    const raw = fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8');
    expect(raw).toContain('Used by the nightly incremental job');
    expect(raw).toContain('airflow DAG `incrementals_v2`');
  });

  it('removes stale `domain_*` selectors AND keeps user selectors in one pass', () => {
    writeSelectors(
      tmpDir,
      [
        'selectors:',
        '  - name: domain_silver_old',
        '    definition: { union: [{ method: fqn, value: ghost_model }] }',
        '  - name: incremental_critical',
        '    description: Nightly job',
        '    definition: { union: [{ method: fqn, value: fct_orders }] }',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'new', layer: 'silver', filePath: '/x/silver/new.json', models: ['dim_new'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();

    const parsed = readSelectors(tmpDir);
    const names = parsed.selectors.map((s) => s.name);
    expect(names).toContain('domain_silver_new');
    expect(names).not.toContain('domain_silver_old');
    expect(names).toContain('incremental_critical');
  });

  it('regenerate() is idempotent — calling twice produces an identical file', () => {
    writeSelectors(
      tmpDir,
      [
        'selectors:',
        '  # Pre-existing user selector',
        '  - name: incremental_critical',
        '    definition:',
        '      union:',
        '        - method: fqn',
        '          value: fct_orders',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();
    const first = fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8');
    svc.regenerate();
    const second = fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8');
    expect(second).toBe(first);
  });

  it('replaces an old-version header at the top of the file (does not stack)', () => {
    writeSelectors(
      tmpDir,
      [
        '# AUTOGENERATED by ERD Studio — do not edit by hand.',
        '# Regenerated whenever a domain is created, renamed, deleted, or its model list changes.',
        'selectors:',
        '  - name: domain_silver_old',
        '    definition: { union: [{ method: fqn, value: ghost }] }',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();

    const raw = fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8');
    expect(raw).not.toContain('AUTOGENERATED by ERD Studio — do not edit by hand');
    const headerLines = raw.match(/^# /gm);
    expect(headerLines?.length).toBe(2);
  });

  it('drops a comment that was visually attached to a removed `domain_*` selector', () => {
    writeSelectors(
      tmpDir,
      [
        'selectors:',
        '  # comment for the old generated selector',
        '  - name: domain_silver_old',
        '    definition: { union: [{ method: fqn, value: ghost }] }',
        '  - name: my_user_selector',
        '    definition: { union: [{ method: fqn, value: fct_x }] }',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();

    const raw = fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8');
    expect(raw).not.toContain('comment for the old generated selector');
    expect(raw).toContain('my_user_selector');
  });

  it('preserves user selectors that use YAML anchors and aliases', () => {
    writeSelectors(
      tmpDir,
      [
        'selectors:',
        '  - name: shared_definition',
        '    definition: &shared',
        '      union:',
        '        - method: fqn',
        '          value: shared_model',
        '  - name: alias_user',
        '    definition: *shared',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    expect(() => svc.regenerate()).not.toThrow();

    const parsed = readSelectors(tmpDir);
    const names = parsed.selectors.map((s) => s.name);
    expect(names).toContain('shared_definition');
    expect(names).toContain('alias_user');

    const aliasUser = parsed.selectors.find((s) => s.name === 'alias_user')!;
    expect(aliasUser.definition).toEqual({ union: [{ method: 'fqn', value: 'shared_model' }] });
  });

  // Edge cases ----------------------------------------------------------------

  it('writes a fresh file when no selectors.yml exists yet', () => {
    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['m1'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    const result = svc.regenerate();
    expect(result.status).toBe('written');
    expect(fs.existsSync(path.join(tmpDir, 'selectors.yml'))).toBe(true);
  });

  it('treats an empty selectors.yml as no user content and writes a fresh file', () => {
    writeSelectors(tmpDir, '');
    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['m1'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    const result = svc.regenerate();
    expect(result.status).toBe('written');
    const parsed = readSelectors(tmpDir);
    expect(parsed.selectors.map((s) => s.name)).toEqual(['domain_silver_d']);
  });

  it('preserves non-map selector entries (cannot be ours by shape)', () => {
    writeSelectors(
      tmpDir,
      [
        'selectors:',
        '  - some_bare_string',
        '  - name: incremental_critical',
        '    definition: { union: [{ method: fqn, value: fct_orders }] }',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();

    const raw = fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8');
    expect(raw).toContain('some_bare_string');
    expect(raw).toContain('incremental_critical');
  });

  it('preserves selector entries with no `name` field (cannot be ours)', () => {
    writeSelectors(
      tmpDir,
      [
        'selectors:',
        '  - description: anonymous selector',
        '    definition: { union: [{ method: fqn, value: fct_x }] }',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();

    const raw = fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8');
    expect(raw).toContain('anonymous selector');
  });

  // Skip-on-broken-state behaviour --------------------------------------------

  it('SKIPS the write and surfaces info when selectors.yml is malformed YAML', () => {
    const malformed = [
      'selectors:',
      '  - name: my_user',
      '    definition: { union: [{ method: fqn, value: fct_x }] }',
      'jkhhuiojk',
      '',
    ].join('\n');
    writeSelectors(tmpDir, malformed);

    const onSkipped = vi.fn();
    const onWritten = vi.fn();
    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
      { onSkipped, onWritten },
    );
    const result = svc.regenerate();

    expect(result.status).toBe('skipped');
    if (result.status !== 'skipped') { throw new Error('expected skipped'); }
    expect(result.reason).toBe('malformed');
    expect(result.detail).toMatch(/Implicit map keys|Map keys/i);

    // File is unchanged
    expect(fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8')).toBe(malformed);

    // onSkipped fired with details, onWritten did not
    expect(onSkipped).toHaveBeenCalledOnce();
    expect(onSkipped.mock.calls[0][0]).toMatchObject({
      reason: 'malformed',
      filePath: path.join(tmpDir, 'selectors.yml'),
    });
    expect(onWritten).not.toHaveBeenCalled();
  });

  it('SKIPS the write when selectors.yml has no top-level `selectors:` key', () => {
    const original = 'something_else: value\n';
    writeSelectors(tmpDir, original);

    const onSkipped = vi.fn();
    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
      { onSkipped },
    );
    const result = svc.regenerate();

    expect(result.status).toBe('skipped');
    if (result.status !== 'skipped') { throw new Error('expected skipped'); }
    expect(result.reason).toBe('malformed');
    expect(result.detail).toMatch(/selectors:/);
    expect(fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8')).toBe(original);
    expect(onSkipped).toHaveBeenCalledOnce();
  });

  it('SKIPS the write when `selectors:` is not a list', () => {
    const original = 'selectors: not_a_list\n';
    writeSelectors(tmpDir, original);

    const onSkipped = vi.fn();
    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
      { onSkipped },
    );
    const result = svc.regenerate();

    expect(result.status).toBe('skipped');
    if (result.status !== 'skipped') { throw new Error('expected skipped'); }
    expect(result.reason).toBe('malformed');
    expect(result.detail).toMatch(/not a list/);
    expect(fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8')).toBe(original);
    expect(onSkipped).toHaveBeenCalledOnce();
  });

  it('SKIPS the write when isFileDirtyInEditor reports unsaved edits', () => {
    // File on disk is well-formed — but the editor has unsaved edits, so we
    // still must not overwrite (would clobber user work).
    writeSelectors(
      tmpDir,
      'selectors:\n  - name: my_user\n    definition: { union: [{ method: fqn, value: fct_x }] }\n',
    );

    const onSkipped = vi.fn();
    const onWritten = vi.fn();
    const isFileDirtyInEditor = vi.fn().mockReturnValue(true);

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
      { isFileDirtyInEditor, onSkipped, onWritten },
    );
    const before = fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8');
    const result = svc.regenerate();

    expect(result.status).toBe('skipped');
    if (result.status !== 'skipped') { throw new Error('expected skipped'); }
    expect(result.reason).toBe('unsaved-edits');

    // isFileDirtyInEditor was queried with the absolute selectors.yml path
    expect(isFileDirtyInEditor).toHaveBeenCalledWith(path.join(tmpDir, 'selectors.yml'));

    // File on disk is unchanged
    expect(fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8')).toBe(before);

    expect(onSkipped).toHaveBeenCalledOnce();
    expect(onSkipped.mock.calls[0][0]).toMatchObject({ reason: 'unsaved-edits' });
    expect(onWritten).not.toHaveBeenCalled();
  });

  it('proceeds normally when isFileDirtyInEditor returns false', () => {
    writeSelectors(tmpDir, '');
    const onSkipped = vi.fn();
    const onWritten = vi.fn();
    const isFileDirtyInEditor = vi.fn().mockReturnValue(false);

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
      { isFileDirtyInEditor, onSkipped, onWritten },
    );
    const result = svc.regenerate();

    expect(result.status).toBe('written');
    expect(onSkipped).not.toHaveBeenCalled();
    expect(onWritten).toHaveBeenCalledOnce();
  });

  it('fires onWritten on every successful write, never with onSkipped', () => {
    const onSkipped = vi.fn();
    const onWritten = vi.fn();
    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
      { onSkipped, onWritten },
    );
    svc.regenerate();
    svc.regenerate();
    svc.regenerate();
    expect(onSkipped).not.toHaveBeenCalled();
    expect(onWritten).toHaveBeenCalledTimes(3);
  });

  it('after a skip → fix the file → next regenerate writes (recovers from skip)', () => {
    writeSelectors(tmpDir, 'selectors: not_a_list\n');

    const skipInfos: SkipInfo[] = [];
    const onSkipped = (info: SkipInfo) => { skipInfos.push(info); };
    const onWritten = vi.fn();

    const svc = new SelectorsService(
      fakeDomainService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
      { onSkipped, onWritten },
    );

    // First call: skipped
    expect(svc.regenerate().status).toBe('skipped');
    expect(skipInfos.length).toBe(1);
    expect(onWritten).not.toHaveBeenCalled();

    // User fixes the file
    writeSelectors(
      tmpDir,
      'selectors:\n  - name: my_user\n    definition: { union: [{ method: fqn, value: fct_x }] }\n',
    );

    // Second call: written
    const result = svc.regenerate();
    expect(result.status).toBe('written');
    expect(onWritten).toHaveBeenCalledOnce();

    // User content survived the recovery
    const parsed = readSelectors(tmpDir);
    const names = parsed.selectors.map((s) => s.name);
    expect(names).toContain('my_user');
    expect(names).toContain('domain_silver_d');
  });
});
