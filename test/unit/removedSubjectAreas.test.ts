import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { removedSubjectAreaPaths } from '../../src/services/removedSubjectAreas';

describe('removedSubjectAreaPaths (the "subject area files deleted" toast)', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'erd-removed-'));

  it('a diagram deleted by hand, with no other format left, is a removed subject area', () => {
    const root = tmp();
    const deleted = path.join(root, 'silver', 'diagrams', 'stores.dbml');
    expect(removedSubjectAreaPaths([deleted], fs.existsSync)).toEqual([deleted]);
    const json = path.join(root, 'gold', 'sales.json');
    expect(removedSubjectAreaPaths([deleted, json], fs.existsSync)).toEqual([deleted, json]);
  });

  it('Undo of Convert Project to DBML: the .dbml diagrams go but their .json is back, so nothing was removed', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'silver'));
    const names = ['stores', 'customers', 'orders'];
    for (const n of names) fs.writeFileSync(path.join(root, 'silver', `${n}.json`), '{}');
    const deleted = names.map((n) => path.join(root, 'silver', 'diagrams', `${n}.dbml`));
    expect(removedSubjectAreaPaths(deleted, fs.existsSync)).toEqual([]);
    // One really gone among them is still reported.
    const gone = path.join(root, 'silver', 'diagrams', 'returns.dbml');
    expect(removedSubjectAreaPaths([...deleted, gone], fs.existsSync)).toEqual([gone]);
  });

  it('a .json diagram replaced by its .dbml (Convert itself) is not a removal; the same name in another layer does not count', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'silver', 'diagrams'), { recursive: true });
    fs.mkdirSync(path.join(root, 'gold', 'diagrams'), { recursive: true });
    fs.writeFileSync(path.join(root, 'silver', 'diagrams', 'stores.dbml'), '');
    fs.writeFileSync(path.join(root, 'gold', 'diagrams', 'sales.dbml'), '');
    const replaced = path.join(root, 'silver', 'stores.json');
    const elsewhere = path.join(root, 'silver', 'sales.json');
    expect(removedSubjectAreaPaths([replaced, elsewhere], fs.existsSync)).toEqual([elsewhere]);
  });

  it('a 1.9 pre-release <layer>/<name>.dbml has no other format: deleting it is a removal', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'silver'));
    fs.writeFileSync(path.join(root, 'silver', 'stores.json'), '{}');
    const old = path.join(root, 'silver', 'stores.dbml');
    expect(removedSubjectAreaPaths([old], fs.existsSync)).toEqual([old]);
  });
});
