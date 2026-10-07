/**
 * The words around the relationship checks (#133) say what the code does: a
 * reader who builds a consumer from CLAUDE.md, a hand-editor reading the
 * schema hover text and a team upgrading from the changelog must not be told
 * less than the behaviour they will meet.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf-8');

describe('CLAUDE.md describes `erd-studio check` as it behaves', () => {
  const claude = read('CLAUDE.md');

  it('names `unchecked` and `olderFormat` in the JSON shape, and exits 1 for a file it could not check', () => {
    expect(claude).toContain('checked, unchecked, olderFormat, findings }');
    expect(claude).toContain('**or any file it could not check**');
    const row = claude.split('\n').find((l) => l.startsWith('| 1 |'))!;
    expect(row).toContain('or a file it could not check');
  });

  it('names doctor\'s check-relationships step beside fix-relationships', () => {
    expect(claude).toMatch(/a `fix-relationships` next step for findings and a `check-relationships` step/);
  });
});

describe('the JSON schemas say REL008 covers a domain file\'s entries too', () => {
  for (const file of ['schemas/domain.schema.json', 'schemas/logical-model.schema.json']) {
    it(file, () => {
      const text = read(file);
      expect(text).not.toContain('in a model file, reported as REL008');
      expect(text).toContain('reported as REL008, in a model file or a domain file alike');
    });
  }
});

describe('CHANGELOG: upgrading a team names what an older version does with these files', () => {
  const section = (() => {
    const changelog = read('CHANGELOG.md');
    const start = changelog.indexOf('### Upgrading a team');
    return changelog.slice(start, changelog.indexOf('\n## ', start));
  })();

  it('older versions mark `role:` as not allowed', () => {
    expect(section).toContain('"Property role is not allowed"');
  });

  it('older Compare / diff report relationships tested from the dimension side as drift, and their fixes wait', () => {
    expect(section).toContain('report relationships tested from the dimension side as drift');
    expect(section).toContain('Do not apply those fixes until everyone has updated');
  });
});
