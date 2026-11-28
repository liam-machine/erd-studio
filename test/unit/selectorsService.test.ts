import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as yamlParse } from 'yaml';

import { SelectorsService } from '../../src/services/selectorsService';
import type { CheckResult, SelectorsServiceHooks, SkipInfo } from '../../src/services/selectorsService';
import type { SubjectAreaService } from '../../src/services/domainService';
import { SubjectAreaService as RealSubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { DBT_FIXTURES, copyDbtFixture, diagramPath } from './helpers/dbtFixtures';

// Pass-through wrappers, so a test can see that check() never writes.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

interface FakeSubjectArea {
  domain: string;
  layer: string;
  filePath: string;
  models: string[];
}

function fakeSubjectAreaService(domains: FakeSubjectArea[]): SubjectAreaService {
  return {
    listSubjectAreas: () =>
      domains.map((d) => ({ domain: d.domain, layer: d.layer, filePath: d.filePath })),
    getSubjectArea: (filePath: string) => {
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
  } as unknown as SubjectAreaService;
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
    // selectors.yml is a dbt file: every case below runs in a dbt project root.
    fs.writeFileSync(path.join(tmpDir, 'dbt_project.yml'), 'name: test_project\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits one selector per non-empty domain with snake_case names', () => {
    const svc = new SelectorsService(
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      'selectors:\n  - name: domain_silver_old\n    description: All models in the old domain (silver layer). Managed by ERD Studio.\n    definition:\n      union:\n        - method: fqn\n          value: ghost_model\n',
    );

    const svc = new SelectorsService(
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
        '    description: Old domain. Managed by ERD Studio.',
        '    definition: { union: [{ method: fqn, value: ghost_model }] }',
        '  - name: incremental_critical',
        '    description: Nightly job',
        '    definition: { union: [{ method: fqn, value: fct_orders }] }',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
        '    description: Old domain. Managed by ERD Studio.',
        '    definition: { union: [{ method: fqn, value: ghost }] }',
        '  - name: my_user_selector',
        '    definition: { union: [{ method: fqn, value: fct_x }] }',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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

  it('does NOT create selectors.yml in a project with no domains (noop)', () => {
    const svc = new SelectorsService(fakeSubjectAreaService([]), tmpDir, '.erd-studio');
    const onWritten = vi.fn();
    const onSkipped = vi.fn();
    const svcWithHooks = new SelectorsService(fakeSubjectAreaService([]), tmpDir, '.erd-studio', { onWritten, onSkipped });

    expect(svc.regenerate().status).toBe('noop');
    expect(svcWithHooks.regenerate().status).toBe('noop');
    expect(fs.existsSync(path.join(tmpDir, 'selectors.yml'))).toBe(false);
    expect(onWritten).not.toHaveBeenCalled();
    expect(onSkipped).not.toHaveBeenCalled();
  });

  it('does NOT create selectors.yml when every domain is empty', () => {
    const svc = new SelectorsService(
      fakeSubjectAreaService([{ domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: [] }]),
      tmpDir,
      '.erd-studio',
    );
    expect(svc.regenerate().status).toBe('noop');
    expect(fs.existsSync(path.join(tmpDir, 'selectors.yml'))).toBe(false);
  });

  it('still rewrites an existing selectors.yml when no domains remain (drops stale domain_* entries)', () => {
    writeSelectors(
      tmpDir,
      [
        'selectors:',
        '  - name: domain_silver_old',
        '    description: Old domain. Managed by ERD Studio.',
        '    definition:',
        '      union:',
        '        - method: fqn',
        '          value: gone',
        '  - name: nightly',
        '    definition:',
        '      union:',
        '        - method: tag',
        '          value: nightly',
        '',
      ].join('\n'),
    );
    const svc = new SelectorsService(fakeSubjectAreaService([]), tmpDir, '.erd-studio');
    const result = svc.regenerate();
    expect(result.status).toBe('written');
    const parsed = readSelectors(tmpDir);
    expect(parsed.selectors.map((s) => s.name)).toEqual(['nightly']);
  });

  it('writes a fresh file when no selectors.yml exists yet', () => {
    const svc = new SelectorsService(
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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
      fakeSubjectAreaService([
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

  // Collision safety (H31) ------------------------------------------------------

  it('de-duplicates generated names when two domains sanitise to the same selector', () => {
    const collisions: Array<{ requestedName: string; assignedName: string; domain: string; conflictsWith: string }> = [];
    const svc = new SelectorsService(
      fakeSubjectAreaService([
        { domain: 'customer-360', layer: 'silver', filePath: '/x/silver/customer-360.json', models: ['dim_customer'] },
        { domain: 'customer_360', layer: 'silver', filePath: '/x/silver/customer_360.json', models: ['fct_orders'] },
      ]),
      tmpDir,
      '.erd-studio',
      { onNameCollision: (info) => collisions.push(info) },
    );
    const result = svc.regenerate();
    expect(result.status).toBe('written');

    const parsed = readSelectors(tmpDir);
    const names = parsed.selectors.map((s) => s.name);
    expect(names).toEqual(['domain_silver_customer_360', 'domain_silver_customer_360_2']);
    // Each selector still references exactly one domain's models — nothing merged or dropped
    const members = parsed.selectors.map((s) => s.definition.union[0].value).sort();
    expect(members).toEqual(['dim_customer', 'fct_orders']);

    expect(collisions).toHaveLength(1);
    expect(collisions[0].requestedName).toBe('domain_silver_customer_360');
    expect(collisions[0].assignedName).toBe('domain_silver_customer_360_2');
    expect([collisions[0].domain, collisions[0].conflictsWith].sort()).toEqual([
      'silver/customer-360',
      'silver/customer_360',
    ]);
  });

  it('keeps suffixed names stable across regenerates (idempotent with a collision)', () => {
    const svc = new SelectorsService(
      fakeSubjectAreaService([
        { domain: 'a-b', layer: 'silver', filePath: '/x/silver/a-b.json', models: ['m1'] },
        { domain: 'a_b', layer: 'silver', filePath: '/x/silver/a_b.json', models: ['m2'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();
    const first = fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8');
    svc.regenerate();
    const second = fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8');
    expect(second).toBe(first);
    expect(readSelectors(tmpDir).selectors.map((s) => s.name)).toEqual([
      'domain_silver_a_b',
      'domain_silver_a_b_2',
    ]);
  });

  it('preserves a user-authored `domain_*` selector that lacks the managed marker', () => {
    writeSelectors(
      tmpDir,
      [
        'selectors:',
        '  - name: domain_custom_nightly',
        '    description: Hand-written by the team',
        '    definition: { union: [{ method: fqn, value: fct_orders }] }',
        '',
      ].join('\n'),
    );

    const svc = new SelectorsService(
      fakeSubjectAreaService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
    );
    svc.regenerate();

    const parsed = readSelectors(tmpDir);
    const names = parsed.selectors.map((s) => s.name);
    expect(names).toContain('domain_silver_d');
    expect(names).toContain('domain_custom_nightly');
    const user = parsed.selectors.find((s) => s.name === 'domain_custom_nightly');
    expect(user!.definition.union[0].value).toBe('fct_orders');
  });

  it('suffixes a generated name that collides with a preserved user selector', () => {
    writeSelectors(
      tmpDir,
      [
        'selectors:',
        '  - name: domain_silver_d',
        '    description: Mine, not yours',
        '    definition: { union: [{ method: fqn, value: user_model }] }',
        '',
      ].join('\n'),
    );

    const collisions: Array<{ conflictsWith: string }> = [];
    const svc = new SelectorsService(
      fakeSubjectAreaService([
        { domain: 'd', layer: 'silver', filePath: '/x/silver/d.json', models: ['dim_d'] },
      ]),
      tmpDir,
      '.erd-studio',
      { onNameCollision: (info) => collisions.push(info) },
    );
    svc.regenerate();

    const parsed = readSelectors(tmpDir);
    const names = parsed.selectors.map((s) => s.name);
    expect(names).toEqual(['domain_silver_d_2', 'domain_silver_d']);
    const user = parsed.selectors.find((s) => s.name === 'domain_silver_d');
    expect(user!.definition.union[0].value).toBe('user_model');
    expect(collisions).toHaveLength(1);
    expect(collisions[0].conflictsWith).toBe('a user-managed selector');
  });

  it('after a skip → fix the file → next regenerate writes (recovers from skip)', () => {
    writeSelectors(tmpDir, 'selectors: not_a_list\n');

    const skipInfos: SkipInfo[] = [];
    const onSkipped = (info: SkipInfo) => { skipInfos.push(info); };
    const onWritten = vi.fn();

    const svc = new SelectorsService(
      fakeSubjectAreaService([
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

describe('SelectorsService in a folder that is not a dbt project (#111)', () => {
  let tmpDir: string;
  const domains: FakeSubjectArea[] = [
    { domain: 'customer-360', layer: 'silver', filePath: '/dummy/silver/customer-360.json', models: ['dim_customer', 'fct_orders'] },
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selectors-plain-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes nothing, even with subject areas that have tables', () => {
    const onWritten = vi.fn();
    const onSkipped = vi.fn();
    const isFileDirtyInEditor = vi.fn(() => false);
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', {
      onWritten, onSkipped, isFileDirtyInEditor,
    });

    const result = svc.regenerate();

    expect(result).toEqual({ status: 'not-dbt-project', filePath: path.join(tmpDir, 'selectors.yml') });
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    expect(onWritten).not.toHaveBeenCalled();
    expect(onSkipped).not.toHaveBeenCalled();
  });

  it('leaves an existing selectors.yml untouched, even a malformed one', () => {
    const content = 'selectors: [unclosed\n';
    writeSelectors(tmpDir, content);
    const onSkipped = vi.fn();
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', { onSkipped });

    expect(svc.regenerate().status).toBe('not-dbt-project');
    expect(fs.readFileSync(path.join(tmpDir, 'selectors.yml'), 'utf-8')).toBe(content);
    expect(onSkipped).not.toHaveBeenCalled();
  });

  it('scheduleRegenerate (the post-edit path) writes nothing', () => {
    vi.useFakeTimers();
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio');

    svc.scheduleRegenerate();
    vi.runAllTimers();

    expect(fs.existsSync(path.join(tmpDir, 'selectors.yml'))).toBe(false);
  });

  it('check() reads nothing and answers not-dbt-project, even with a selectors.yml', () => {
    writeSelectors(tmpDir, 'selectors: []\n');
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio');
    expect(svc.check()).toEqual({ status: 'not-dbt-project', filePath: path.join(tmpDir, 'selectors.yml') });
  });

  it('a dbt_project.yml directory does not count as a dbt project', () => {
    fs.mkdirSync(path.join(tmpDir, 'dbt_project.yml'));
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio');

    expect(svc.regenerate().status).toBe('not-dbt-project');
    expect(fs.existsSync(path.join(tmpDir, 'selectors.yml'))).toBe(false);
  });

  it('writes as before once the folder becomes a dbt project', () => {
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio');
    expect(svc.regenerate().status).toBe('not-dbt-project');

    fs.writeFileSync(path.join(tmpDir, 'dbt_project.yml'), 'name: now_dbt\n', 'utf-8');

    const result = svc.regenerate();
    expect(result.status).toBe('written');
    expect(readSelectors(tmpDir).selectors.map((s) => s.name)).toEqual(['domain_silver_customer_360']);
  });
});

// Writes only as the user's own action (the command creates; an edit updates
// an existing file), and check() never writes (activation, the watchers).
describe('SelectorsService: who may write, and the read-only check', () => {
  let tmpDir: string;
  const file = () => path.join(tmpDir, 'selectors.yml');
  const domains: FakeSubjectArea[] = [
    { domain: 'customer-360', layer: 'silver', filePath: '/dummy/silver/customer-360.json', models: ['dim_customer', 'fct_orders'] },
    { domain: 'reporting', layer: 'gold', filePath: '/dummy/gold/reporting.json', models: ['fct_revenue'] },
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selectors-check-'));
    fs.writeFileSync(path.join(tmpDir, 'dbt_project.yml'), 'name: test_project\n', 'utf-8');
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the post-edit path with no file answers absent and creates nothing', () => {
    const onWritten = vi.fn();
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', { onWritten });
    expect(svc.regenerate({ createIfMissing: false })).toEqual({ status: 'absent', filePath: file() });
    expect(fs.existsSync(file())).toBe(false);
    expect(fs.readdirSync(tmpDir)).toEqual(['dbt_project.yml']);
    expect(onWritten).not.toHaveBeenCalled();
  });

  it('the post-edit path with a file rebuilds every diagram\'s selector, and keeps the user\'s', () => {
    writeSelectors(tmpDir, 'selectors:\n  - name: mine\n    definition: { method: tag, value: nightly }\n');
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio');
    expect(svc.regenerate({ createIfMissing: false })).toMatchObject({ status: 'written', selectorsWritten: 2, created: false });
    expect(readSelectors(tmpDir).selectors.map((s) => s.name)).toEqual(['domain_gold_reporting', 'domain_silver_customer_360', 'mine']);
  });

  it('the command path (regenerate()) still creates the file, and says it did once', () => {
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio');
    expect(svc.regenerate()).toMatchObject({ status: 'written', created: true });
    expect(readSelectors(tmpDir).selectors.map((s) => s.name)).toEqual(['domain_gold_reporting', 'domain_silver_customer_360']);
    expect(svc.regenerate()).toMatchObject({ status: 'written', created: false });
  });

  it('scheduleRegenerate creates no file, updates an existing one, and reports a missing one as absent', () => {
    vi.useFakeTimers();
    const onChecked = vi.fn();
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', { onChecked });
    svc.scheduleRegenerate();
    vi.runAllTimers();
    expect(fs.existsSync(file())).toBe(false);
    expect(onChecked).toHaveBeenCalledWith({ status: 'absent', filePath: file() });

    writeSelectors(tmpDir, 'selectors: []\n');
    svc.scheduleRegenerate();
    vi.runAllTimers();
    expect(readSelectors(tmpDir).selectors.map((s) => s.name)).toEqual(['domain_gold_reporting', 'domain_silver_customer_360']);
  });

  it('check() never writes: no write, no rename, no temp file, mtime unchanged, no hook', () => {
    writeSelectors(tmpDir, 'selectors: []\n');
    const past = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file(), past, past);
    const writeFileSync = vi.mocked(fs.writeFileSync);
    const renameSync = vi.mocked(fs.renameSync);
    writeFileSync.mockClear();
    renameSync.mockClear();
    const hooks = { onWritten: vi.fn(), onSkipped: vi.fn(), onNameCollision: vi.fn(), onChecked: vi.fn(), isFileDirtyInEditor: vi.fn(() => true) };
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', hooks);

    expect(svc.check()).toMatchObject({ status: 'stale', added: ['domain_gold_reporting', 'domain_silver_customer_360'], removed: [], changed: [] });

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
    expect(fs.statSync(file()).mtimeMs).toBe(past.getTime());
    expect(fs.readdirSync(tmpDir).sort()).toEqual(['dbt_project.yml', 'selectors.yml']);
    for (const hook of Object.values(hooks)) expect(hook).not.toHaveBeenCalled();
    // The spies do see the service's writes: a regenerate is one.
    hooks.isFileDirtyInEditor.mockReturnValue(false);
    svc.regenerate();
    expect(writeFileSync).toHaveBeenCalled();
    expect(renameSync).toHaveBeenCalled();
  });

  it('check() with no file is absent (never stale: the project never opted in)', () => {
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio');
    expect(svc.check()).toEqual({ status: 'absent', filePath: file() });
    expect(fs.existsSync(file())).toBe(false);
  });

  it('currentSelectorFor names a diagram\'s selector only while the file is current, and writes nothing (#378)', () => {
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio');
    // No file: no selector to copy.
    expect(svc.currentSelectorFor('/dummy/silver/customer-360.json')).toBeUndefined();
    expect(fs.existsSync(file())).toBe(false);
    svc.regenerate();
    expect(svc.currentSelectorFor('/dummy/silver/customer-360.json')).toBe('domain_silver_customer_360');
    expect(svc.currentSelectorFor('/dummy/gold/reporting.json')).toBe('domain_gold_reporting');
    expect(svc.currentSelectorFor('/dummy/gold/elsewhere.json')).toBeUndefined();
    // Stale: the diagrams moved on, so the file's selector is not what the diagram holds.
    const before = fs.readFileSync(file(), 'utf-8');
    fs.writeFileSync(file(), before.replace('value: fct_orders', 'value: fct_order_lines'), 'utf-8');
    const stale = fs.readFileSync(file(), 'utf-8');
    expect(svc.currentSelectorFor('/dummy/silver/customer-360.json')).toBeUndefined();
    expect(fs.readFileSync(file(), 'utf-8')).toBe(stale);
  });

  it('check() of a freshly regenerated file is current', () => {
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio');
    svc.regenerate();
    expect(svc.check()).toEqual({ status: 'current', filePath: file() });
  });

  it('check() names the selectors a regenerate would add, remove and change', () => {
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio');
    svc.regenerate();
    const text = fs.readFileSync(file(), 'utf-8')
      .replace('domain_gold_reporting', 'domain_gold_old')
      .replace('value: fct_orders', 'value: fct_order_lines');
    writeSelectors(tmpDir, text);
    expect(svc.check()).toEqual({
      status: 'stale', filePath: file(),
      added: ['domain_gold_reporting'], removed: ['domain_gold_old'], changed: ['domain_silver_customer_360'],
    });
  });

  it('check() ignores user selectors, and a user domain_* selector without the marker', () => {
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio');
    svc.regenerate();
    fs.appendFileSync(file(), '  - name: domain_mine\n    definition: { method: tag, value: x }\n  - name: other\n    definition: { method: tag, value: y }\n');
    expect(svc.check().status).toBe('current');
  });

  it('check() of a malformed file is unreadable, with the parse detail', () => {
    writeSelectors(tmpDir, 'selectors: [unclosed\n');
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio');
    const result = svc.check();
    expect(result.status).toBe('unreadable');
    expect((result as Extract<CheckResult, { status: 'unreadable' }>).detail).not.toBe('');
  });

  it('scheduleCheck runs prepareCheck when there is a file, then reports the check', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const prepareCheck = vi.fn(async () => { order.push('prepare'); });
    const onChecked = vi.fn((r: CheckResult) => { order.push(r.status); });
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', { prepareCheck, onChecked });

    svc.scheduleCheck();
    await vi.runAllTimersAsync();
    // No file: nothing to prepare for.
    expect(order).toEqual(['absent']);

    writeSelectors(tmpDir, 'selectors: []\n');
    svc.scheduleCheck();
    await vi.runAllTimersAsync();
    expect(order).toEqual(['absent', 'prepare', 'stale']);
    expect(fs.readFileSync(file(), 'utf-8')).toBe('selectors: []\n');
  });

  it('a write scheduled before a check still writes; the check never cancels it', async () => {
    vi.useFakeTimers();
    writeSelectors(tmpDir, 'selectors: []\n');
    const onChecked = vi.fn();
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', { onChecked });

    svc.scheduleRegenerate(250);
    svc.scheduleCheck(50);
    await vi.advanceTimersByTimeAsync(100);
    // The check fell due while the write was pending: dropped, not run against the old file.
    expect(onChecked).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(readSelectors(tmpDir).selectors.map((s) => s.name)).toEqual(['domain_gold_reporting', 'domain_silver_customer_360']);

    // And a check scheduled right after a write, due at the same time, follows the write.
    writeSelectors(tmpDir, 'selectors: []\n');
    svc.scheduleRegenerate();
    svc.scheduleCheck();
    await vi.runAllTimersAsync();
    expect(readSelectors(tmpDir).selectors).toHaveLength(2);
    expect(onChecked).toHaveBeenLastCalledWith({ status: 'current', filePath: file() });
  });

  /** dbtModelsOf over dbt data nothing has loaded yet, as in a fresh window: fct_orders is dbt's stg_orders once loaded. */
  function lazyDbtHooks(): Pick<SelectorsServiceHooks, 'prepareCheck' | 'dbtModelsOf'> & { loaded: () => boolean } {
    let loaded = false;
    return {
      loaded: () => loaded,
      prepareCheck: async () => { loaded = true; },
      dbtModelsOf: () => new Map(loaded ? [['fct_orders', 'stg_orders']] : []),
    };
  }
  const silverMembers = (): string[] | undefined =>
    readSelectors(tmpDir).selectors.find((s) => s.name === 'domain_silver_customer_360')?.definition.union.map((u) => u.value);

  it('the command\'s write loads the dbt data the check reads first, so the check finds that write current', async () => {
    // Without it (plain regenerate() in a fresh window) the write and the next check disagree.
    const unready = lazyDbtHooks();
    new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', unready).regenerate();
    await unready.prepareCheck!();
    expect(new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', unready).check().status).toBe('stale');

    fs.rmSync(file());
    const hooks = lazyDbtHooks();
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', hooks);
    const result = await svc.regenerateWhenReady();
    expect(result).toMatchObject({ status: 'written', created: true });
    expect(silverMembers()).toEqual(['dim_customer', 'stg_orders']);
    expect(svc.check().status).toBe('current');
  });

  it('a scheduled write to an existing file loads the dbt data first too', async () => {
    vi.useFakeTimers();
    writeSelectors(tmpDir, 'selectors: []\n');
    const hooks = lazyDbtHooks();
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', hooks);
    svc.scheduleRegenerate();
    await vi.runAllTimersAsync();
    expect(silverMembers()).toEqual(['dim_customer', 'stg_orders']);
    expect(svc.check().status).toBe('current');

    // No file: nothing to load, and nothing written.
    fs.rmSync(file());
    const absent = lazyDbtHooks();
    new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', absent).scheduleRegenerate();
    await vi.runAllTimersAsync();
    expect(absent.loaded()).toBe(false);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('a scheduled write that throws reports a fresh check (the check it stood in for) and leaves no temporary file', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeSelectors(tmpDir, 'selectors: []\n');
    const onChecked = vi.fn();
    const svc = new SelectorsService(fakeSubjectAreaService(domains), tmpDir, '.erd-studio', { onChecked });
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); });

    svc.scheduleCheck(5);
    svc.scheduleRegenerate(20);
    await vi.runAllTimersAsync();
    expect(fs.readFileSync(file(), 'utf-8')).toBe('selectors: []\n');
    expect(onChecked).toHaveBeenCalledTimes(1);
    expect(onChecked.mock.calls[0][0]).toMatchObject({ status: 'stale' });
    expect(fs.readdirSync(tmpDir).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});

// The real subject areas of the dbt fixture, on both storages: selectors come
// from the diagrams (`<layer>/<name>.json` on YAML, `<layer>/diagrams/<name>.dbml`
// on DBML) through the real SubjectAreaService, and the user's own selectors stay.
describe.each(DBT_FIXTURES)('SelectorsService on the dbt fixture (%s storage)', (storage, fixture) => {
  let root: string;
  const realService = (): SubjectAreaService => {
    const layerService = new LayerService(root, '.erd-studio');
    const subjectAreaService = new RealSubjectAreaService(layerService);
    subjectAreaService.setTableLibraryService(new TableLibraryService(root, '.erd-studio'));
    return subjectAreaService;
  };

  beforeEach(() => { root = copyDbtFixture(fixture, 'selectors-fixture'); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('regenerating the committed selectors.yml rewrites it byte for byte', () => {
    const before = fs.readFileSync(path.join(root, 'selectors.yml'), 'utf-8');
    const result = new SelectorsService(realService(), root, '.erd-studio').regenerate();
    expect(result).toMatchObject({ status: 'written', selectorsWritten: 2, modelsReferenced: 7 });
    expect(fs.readFileSync(path.join(root, 'selectors.yml'), 'utf-8')).toBe(before);
  });

  it('an up-to-date selectors.yml is not written at all: same mtime and inode, still reported as written', () => {
    // Activation regenerates on every window: rewriting identical bytes changed
    // the mtime and fired every watcher on the file.
    const file = path.join(root, 'selectors.yml');
    const past = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file, past, past);
    const { ino } = fs.statSync(file);
    const onWritten = vi.fn();
    const result = new SelectorsService(realService(), root, '.erd-studio', { onWritten }).regenerate();
    // Callers read 'written' as "selectors.yml now matches the diagrams".
    expect(result).toMatchObject({ status: 'written', selectorsWritten: 2, modelsReferenced: 7 });
    expect(onWritten).toHaveBeenCalledTimes(1);
    // atomicWrite renames a temp file over it: a write would change both.
    expect(fs.statSync(file).mtimeMs).toBe(past.getTime());
    expect(fs.statSync(file).ino).toBe(ino);
    expect(fs.readdirSync(root).filter((f) => f.startsWith('selectors.yml.tmp'))).toEqual([]);
  });

  it('a stale selectors.yml is still rewritten', () => {
    const file = path.join(root, 'selectors.yml');
    const before = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, before.replace(/domain_silver_showcase/, 'domain_silver_old'));
    const past = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file, past, past);
    const result = new SelectorsService(realService(), root, '.erd-studio').regenerate();
    expect(result.status).toBe('written');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    expect(fs.statSync(file).mtimeMs).not.toBe(past.getTime());
  });

  it('a new diagram gets its domain_ selector, in member order; the user selector and its comments stay', () => {
    const file = diagramPath(root, storage, 'gold', 'reporting');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, storage === 'yaml'
      ? JSON.stringify({ schemaVersion: 5, domain: 'reporting', layer: 'gold', description: '', logical: { models: ['fct_sale', 'dim_customer'], relationships: [] }, viewConfig: {} }, null, 2)
      : [
        "use { table silver.fct_sale }     from '../../silver/tables/silver/fct_sale.dbml'",
        "use { table silver.dim_customer } from '../../silver/tables/silver/dim_customer.dbml'",
        '',
        'Project reporting {',
        "  erd_schema_version: '7'",
        '}',
        '',
      ].join('\n'));

    const result = new SelectorsService(realService(), root, '.erd-studio').regenerate();
    expect(result.status).toBe('written');
    const parsed = readSelectors(root);
    const reporting = parsed.selectors.find((s) => s.name === 'domain_gold_reporting')!;
    expect(reporting.definition.union.map((u) => u.value)).toEqual(['fct_sale', 'dim_customer']);
    expect(parsed.selectors.map((s) => s.name)).toEqual(['domain_gold_reporting', 'domain_silver_scroll_test', 'domain_silver_showcase', 'incremental_critical']);
    const text = fs.readFileSync(path.join(root, 'selectors.yml'), 'utf-8');
    expect(text).toContain('# Keep in sync with airflow DAG `incrementals_v2`');
  });

  it('check() of the committed file is current, and of its CRLF copy too', () => {
    const svc = new SelectorsService(realService(), root, '.erd-studio');
    expect(svc.check().status).toBe('current');
    const file = path.join(root, 'selectors.yml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(/\n/g, '\r\n'));
    expect(svc.check().status).toBe('current');
  });

  it('check() reads a different header, description wording, quoting, flow style or member order as current', () => {
    const file = path.join(root, 'selectors.yml');
    const committed = fs.readFileSync(file, 'utf-8');
    const reworded = committed
      .replace(/^# ERD Studio manages.*$/m, '# An older ERD Studio wrote this header.')
      .replace('All models in the showcase domain (silver layer). Managed by ERD Studio.', '"Showcase tables. Managed by ERD Studio."')
      .replace('      union:\n        - method: fqn\n          value: fct_large_table\n', "      union: [{ method: fqn, value: 'fct_large_table' }]\n")
      .replace('value: fct_task_event\n        - method: fqn\n          value: dim_task\n', 'value: dim_task\n        - method: fqn\n          value: fct_task_event\n');
    for (const piece of ['older ERD Studio', 'Showcase tables', "value: 'fct_large_table'", 'value: dim_task\n        - method: fqn\n          value: fct_task_event']) {
      expect(reworded).toContain(piece);
    }
    fs.writeFileSync(file, reworded);
    expect(new SelectorsService(realService(), root, '.erd-studio').check().status).toBe('current');
  });

  it('check() reads a real member difference as stale and names the selector, writing nothing', () => {
    const file = path.join(root, 'selectors.yml');
    // A teammate added fct_order to showcase and never regenerated.
    const stale = fs.readFileSync(file, 'utf-8').replace(/\n\s+- method: fqn\n\s+value: fct_order\n/, '\n');
    fs.writeFileSync(file, stale);
    expect(new SelectorsService(realService(), root, '.erd-studio').check())
      .toMatchObject({ status: 'stale', added: [], removed: [], changed: ['domain_silver_showcase'] });
    expect(fs.readFileSync(file, 'utf-8')).toBe(stale);
  });

  it('a deleted diagram loses its selector', () => {
    fs.rmSync(diagramPath(root, storage, 'silver', 'scroll-test'));
    const result = new SelectorsService(realService(), root, '.erd-studio').regenerate();
    expect(result.status).toBe('written');
    expect(readSelectors(root).selectors.map((s) => s.name)).toEqual(['domain_silver_showcase', 'incremental_critical']);
  });
});
