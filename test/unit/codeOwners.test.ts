/**
 * The CODEOWNERS matcher the Table Library uses for "Reviewed by …".
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CodeOwnersReader, codeOwnersOf, codeOwnersPatternRegex, parseCodeOwners } from '../../src/services/codeOwners';

const owners = (text: string, file: string) => codeOwnersOf(parseCodeOwners(text), file);

describe('parseCodeOwners', () => {
  it('skips comments and blank lines, and drops an inline comment', () => {
    const rules = parseCodeOwners('# who reviews what\n\n*.dbml @acme/modellers  # all DBML\n/docs/ @docs-team\n');
    expect(rules.map((r) => [r.pattern, r.owners])).toEqual([
      ['*.dbml', ['@acme/modellers']],
      ['/docs/', ['@docs-team']],
    ]);
  });
});

describe('codeOwnersOf', () => {
  it('lets the last matching rule win', () => {
    const text = '* @everyone\n.erd-studio/ @acme/modellers\n.erd-studio/gold/tables/sales/ @acme/orders-team\n';
    expect(owners(text, '.erd-studio/gold/tables/sales/fct_order.dbml')).toEqual(['@acme/orders-team']);
    expect(owners(text, '.erd-studio/gold/tables/finance/fct_gl.dbml')).toEqual(['@acme/modellers']);
    expect(owners(text, 'README.md')).toEqual(['@everyone']);
  });

  it('leaves a path unowned when the last matching rule names no one', () => {
    expect(owners('* @everyone\n/generated/\n', 'generated/x.dbml')).toEqual([]);
  });

  it('anchors a leading / at the root, and a pattern with no / matches at any depth', () => {
    expect(owners('/sales/ @a\n', 'sales/x.dbml')).toEqual(['@a']);
    expect(owners('/sales/ @a\n', 'gold/sales/x.dbml')).toEqual([]);
    expect(owners('sales/ @a\n', 'gold/tables/sales/x.dbml')).toEqual(['@a']);
    expect(owners('fct_order.dbml @a\n', '.erd-studio/gold/tables/sales/fct_order.dbml')).toEqual(['@a']);
  });

  it('anchors a pattern with a / inside it at the root', () => {
    expect(owners('gold/tables @a\n', 'gold/tables/sales/x.dbml')).toEqual(['@a']);
    expect(owners('gold/tables @a\n', 'x/gold/tables/sales/x.dbml')).toEqual([]);
  });

  it('matches * within one folder and ** across folders', () => {
    expect(owners('*.dbml @a\n', 'deep/down/x.dbml')).toEqual(['@a']);
    expect(owners('/.erd-studio/*/tables/sales/* @a\n', '.erd-studio/gold/tables/sales/x.dbml')).toEqual(['@a']);
    // `docs/*` owns the files directly in docs/, not those in a folder under it.
    expect(owners('docs/* @a\n', 'docs/x.md')).toEqual(['@a']);
    expect(owners('docs/* @a\n', 'docs/sub/x.md')).toEqual([]);
    expect(owners('/.erd-studio/**/sales/ @a\n', '.erd-studio/gold/tables/sales/x.dbml')).toEqual(['@a']);
    expect(owners('/.erd-studio/** @a\n', '.erd-studio/gold/tables/sales/x.dbml')).toEqual(['@a']);
    expect(owners('**/tables/** @a\n', 'gold/tables/sales/x.dbml')).toEqual(['@a']);
  });

  it('owns a folder\'s files from a trailing / or a plain folder name', () => {
    expect(owners('/.erd-studio/gold/ @a\n', '.erd-studio/gold/tables/sales/x.dbml')).toEqual(['@a']);
    expect(owners('/.erd-studio/gold @a\n', '.erd-studio/gold/tables/sales/x.dbml')).toEqual(['@a']);
    // A trailing / never matches a file of that name.
    expect(owners('/x.dbml/ @a\n', 'x.dbml')).toEqual([]);
  });

  it('takes the dots in a pattern literally', () => {
    expect(codeOwnersPatternRegex('a.b')!.test('axb')).toBe(false);
    expect(codeOwnersPatternRegex('a.b')!.test('a.b')).toBe(true);
  });
});

describe('CodeOwnersReader', () => {
  function repo(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-codeowners-'));
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
  }

  it('reads .github/CODEOWNERS before the root and docs/ copies, matching paths from the root', () => {
    const root = repo({
      '.github/CODEOWNERS': '/.erd-studio/ @from-github\n',
      CODEOWNERS: '/.erd-studio/ @from-root\n',
      'docs/CODEOWNERS': '/.erd-studio/ @from-docs\n',
    });
    const reader = new CodeOwnersReader(() => [root], 0);
    expect(reader.ownersOf(path.join(root, '.erd-studio', 'gold', 'tables', 'sales', 'x.dbml'))).toEqual(['@from-github']);
    fs.rmSync(path.join(root, '.github'), { recursive: true });
    expect(reader.ownersOf(path.join(root, '.erd-studio', 'x.dbml'))).toEqual(['@from-root']);
    fs.rmSync(path.join(root, 'CODEOWNERS'));
    expect(reader.ownersOf(path.join(root, '.erd-studio', 'x.dbml'))).toEqual(['@from-docs']);
  });

  it('says no one without a CODEOWNERS file, or for a file outside the root', () => {
    const root = repo({ 'other.txt': '' });
    expect(new CodeOwnersReader(() => [root], 0).ownersOf(path.join(root, 'x.dbml'))).toEqual([]);
    const withFile = repo({ CODEOWNERS: '* @a\n' });
    expect(new CodeOwnersReader(() => [withFile], 0).ownersOf('/elsewhere/x.dbml')).toEqual([]);
  });

  it('reuses one look on disk for a moment, then sees a change', () => {
    const root = repo({ CODEOWNERS: '* @before\n' });
    let now = 0;
    const reader = new CodeOwnersReader(() => [root], 1000, () => now);
    const file = path.join(root, 'x.dbml');
    expect(reader.ownersOf(file)).toEqual(['@before']);
    fs.writeFileSync(path.join(root, 'CODEOWNERS'), '* @after-with-more\n');
    now = 500;
    expect(reader.ownersOf(file)).toEqual(['@before']);
    now = 1500;
    expect(reader.ownersOf(file)).toEqual(['@after-with-more']);
  });
});
