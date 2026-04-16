import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { LegacyTagCleanupService } from '../../src/services/legacyTagCleanupService';

function writeYaml(root: string, relPath: string, content: string): string {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

describe('LegacyTagCleanupService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-tag-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes domain:* tags from config.tags and preserves non-domain tags', () => {
    const filePath = writeYaml(
      tmpDir,
      'models/silver/dim_customer.yml',
      [
        'version: 2',
        'models:',
        '  - name: dim_customer',
        '    config:',
        '      tags:',
        '        - pii',
        '        - domain:customer-360',
        '        - domain:finance',
        '        - daily',
        '',
      ].join('\n'),
    );

    const svc = new LegacyTagCleanupService(tmpDir);
    const result = svc.stripAll();

    expect(result.tagsRemoved).toBe(2);
    expect(result.filesModified).toBe(1);

    const after = fs.readFileSync(filePath, 'utf-8');
    expect(after).toContain('pii');
    expect(after).toContain('daily');
    expect(after).not.toContain('domain:customer-360');
    expect(after).not.toContain('domain:finance');
  });

  it('removes emptied config.tags and config blocks', () => {
    const filePath = writeYaml(
      tmpDir,
      'models/silver/fct_orders.yml',
      [
        'version: 2',
        'models:',
        '  - name: fct_orders',
        '    config:',
        '      tags:',
        '        - domain:orders',
        '',
      ].join('\n'),
    );

    const svc = new LegacyTagCleanupService(tmpDir);
    svc.stripAll();

    const after = fs.readFileSync(filePath, 'utf-8');
    expect(after).not.toContain('domain:orders');
    expect(after).not.toContain('tags:');
    expect(after).not.toContain('config:');
  });

  it('also strips top-level model tags (not just config.tags)', () => {
    const filePath = writeYaml(
      tmpDir,
      'models/silver/dim_product.yml',
      [
        'version: 2',
        'models:',
        '  - name: dim_product',
        '    tags:',
        '      - domain:catalog',
        '      - hourly',
        '',
      ].join('\n'),
    );

    const svc = new LegacyTagCleanupService(tmpDir);
    const result = svc.stripAll();

    expect(result.tagsRemoved).toBe(1);
    const after = fs.readFileSync(filePath, 'utf-8');
    expect(after).not.toContain('domain:catalog');
    expect(after).toContain('hourly');
  });

  it('is idempotent — second run makes no changes', () => {
    writeYaml(
      tmpDir,
      'models/silver/dim_x.yml',
      [
        'version: 2',
        'models:',
        '  - name: dim_x',
        '    config:',
        '      tags:',
        '        - domain:a',
        '',
      ].join('\n'),
    );

    const svc = new LegacyTagCleanupService(tmpDir);
    const first = svc.stripAll();
    expect(first.filesModified).toBe(1);

    const second = svc.stripAll();
    expect(second.filesModified).toBe(0);
    expect(second.tagsRemoved).toBe(0);
  });

  it('skips excluded directories (target, node_modules, dbt_packages)', () => {
    writeYaml(
      tmpDir,
      'target/compiled/foo/dim_cached.yml',
      [
        'version: 2',
        'models:',
        '  - name: dim_cached',
        '    config:',
        '      tags:',
        '        - domain:cached',
        '',
      ].join('\n'),
    );

    const svc = new LegacyTagCleanupService(tmpDir);
    const result = svc.stripAll();

    expect(result.filesScanned).toBe(0);
    expect(result.tagsRemoved).toBe(0);
  });

  it('leaves non-model YAML files alone', () => {
    const filePath = writeYaml(
      tmpDir,
      'dbt_project.yml',
      [
        'name: my_project',
        'version: 1.0.0',
        'models:',
        '  my_project:',
        '    +tags:',
        '      - domain:noop',
        '',
      ].join('\n'),
    );

    const before = fs.readFileSync(filePath, 'utf-8');
    const svc = new LegacyTagCleanupService(tmpDir);
    svc.stripAll();
    const after = fs.readFileSync(filePath, 'utf-8');

    // dbt_project.yml uses a different shape (models: is a map, not a seq)
    // so the walker should not touch it.
    expect(after).toBe(before);
  });
});
