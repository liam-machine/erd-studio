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

  it('does not re-wrap long descriptions or reformat flow sequences in touched files', () => {
    const longDescription =
      'This is a deliberately long plain-scalar description that comfortably exceeds the default eighty column fold width used by the yaml stringifier.';
    const filePath = writeYaml(
      tmpDir,
      'models/silver/dim_long.yml',
      [
        'version: 2',
        'models:',
        '  - name: dim_long',
        `    description: ${longDescription}`,
        '    tags: [domain:silver-customer, pii]',
        '    columns:',
        '      - name: id',
        '        description: >',
        '          A folded block scalar whose single source line is also longer than eighty characters wide.',
        '',
      ].join('\n'),
    );

    const svc = new LegacyTagCleanupService(tmpDir);
    const result = svc.stripAll();
    expect(result.tagsRemoved).toBe(1);

    const after = fs.readFileSync(filePath, 'utf-8');
    expect(after).toContain(`    description: ${longDescription}\n`);
    expect(after).toContain(
      '          A folded block scalar whose single source line is also longer than eighty characters wide.\n',
    );
    expect(after).toContain('tags: [ pii ]');
    expect(after).not.toContain('domain:silver-customer');
  });

  it('skips files with YAML syntax errors instead of rewriting a partial document', () => {
    const broken = [
      'version: 2',
      'models:',
      '  - name: dim_broken',
      '    tags: [domain:oops',
      '',
    ].join('\n');
    const filePath = writeYaml(tmpDir, 'models/dim_broken.yml', broken);

    const svc = new LegacyTagCleanupService(tmpDir);
    const result = svc.stripAll();

    expect(result.filesModified).toBe(0);
    expect(result.errors.some((e) => e.includes('dim_broken.yml'))).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(broken);
  });

  it('only scans dbt model-paths (default models/), leaving other YAML untouched', () => {
    const outside = [
      'version: 2',
      'models:',
      '  - name: stray',
      '    tags:',
      '      - domain:stray',
      '',
    ].join('\n');
    const strayPath = writeYaml(tmpDir, 'docs/stray.yml', outside);
    const seedPath = writeYaml(tmpDir, 'seeds/schema.yml', outside);
    writeYaml(
      tmpDir,
      'models/dim_in.yml',
      ['version: 2', 'models:', '  - name: dim_in', '    tags:', '      - domain:in', ''].join('\n'),
    );

    const svc = new LegacyTagCleanupService(tmpDir);
    const result = svc.stripAll();

    expect(result.filesScanned).toBe(1);
    expect(result.tagsRemoved).toBe(1);
    expect(fs.readFileSync(strayPath, 'utf-8')).toBe(outside);
    expect(fs.readFileSync(seedPath, 'utf-8')).toBe(outside);
  });

  it('honours custom model-paths from dbt_project.yml', () => {
    writeYaml(
      tmpDir,
      'dbt_project.yml',
      ['name: my_project', 'version: 1.0.0', 'model-paths:', '  - transform', '  - marts', ''].join('\n'),
    );
    const tagged = (name: string) =>
      ['version: 2', 'models:', `  - name: ${name}`, '    tags:', `      - domain:${name}`, ''].join('\n');
    writeYaml(tmpDir, 'transform/a.yml', tagged('a'));
    writeYaml(tmpDir, 'marts/b.yml', tagged('b'));
    const defaultPath = writeYaml(tmpDir, 'models/c.yml', tagged('c'));

    const svc = new LegacyTagCleanupService(tmpDir);
    const result = svc.stripAll();

    expect(result.filesScanned).toBe(2);
    expect(result.tagsRemoved).toBe(2);
    // models/ is not in model-paths for this project, so it is not touched.
    expect(fs.readFileSync(defaultPath, 'utf-8')).toBe(tagged('c'));
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
