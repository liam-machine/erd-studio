/**
 * writeFilesWithRollback (§4.1, §5.1 of docs/plans/native-dbml-storage.md,
 * §9.5): the non-editor paths' writes, all or nothing — when the n-th
 * operation fails, for every n, every file and folder is as it was — and a
 * replaced file keeps its byte-order mark.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FileWriteExists, writeFilesWithRollback } from '../../src/services/fsFileWrites';
import type { FileWriteIo } from '../../src/services/fsFileWrites';
import type { FileWrite } from '../../src/services/fileWrites';

let root: string;
const at = (rel: string): string => path.join(root, rel);

function tree(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) { out[`${rel}/`] = ''; walk(abs); } else out[rel] = fs.readFileSync(abs, 'latin1');
    }
  };
  walk(root);
  return out;
}

function writes(): FileWrite[] {
  return [
    { kind: 'replace', path: at('tables/gold/fct.dbml'), text: 'Table fct {\n  id INT [pk]\n  x INT\n}\n' },
    { kind: 'create', path: at('tables/silver/new.dbml'), text: 'Table new {\n  id INT\n}\n' },
    { kind: 'create', path: at('tables/silver/_relationships.dbml'), text: '// rels\n' },
    { kind: 'delete', path: at('tables/gold/old.dbml') },
    { kind: 'replace', path: at('tables/gold/_relationships.dbml'), text: '// rels, edited\n' },
  ];
}

/** Node's fs, with every mutating call counted and the `failAt`-th one throwing. */
function failingIo(failAt: number): { io: FileWriteIo; calls: () => number } {
  let n = 0;
  const step = (): void => {
    n++;
    if (n === failAt) throw new Error(`injected failure at step ${failAt}`);
  };
  return {
    calls: () => n,
    io: {
      readFile: (p) => fs.readFileSync(p),
      exists: (p) => fs.existsSync(p),
      writeFile: (p, d) => { step(); fs.writeFileSync(p, d); },
      rename: (a, b) => { step(); fs.renameSync(a, b); },
      unlink: (p) => { step(); fs.unlinkSync(p); },
      mkdir: (p) => { step(); fs.mkdirSync(p); },
      rmdir: (p) => fs.rmdirSync(p),
    },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-fs-writes-'));
  fs.mkdirSync(at('tables/gold'), { recursive: true });
  fs.writeFileSync(at('tables/gold/fct.dbml'), 'Table fct {\n  id INT [pk]\n}\n');
  fs.writeFileSync(at('tables/gold/old.dbml'), 'Table old {\n  id INT\n}\n');
  fs.writeFileSync(at('tables/gold/_relationships.dbml'), '﻿// rels\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('writeFilesWithRollback', () => {
  it('applies every write, creates first, and keeps a BOM the replaced file had', () => {
    const written = writeFilesWithRollback(writes());
    expect(written.map((p) => path.relative(root, p).split(path.sep).join('/'))).toEqual([
      'tables/silver/_relationships.dbml', 'tables/silver/new.dbml', 'tables/gold/fct.dbml', 'tables/gold/_relationships.dbml', 'tables/gold/old.dbml',
    ]);
    expect(fs.existsSync(at('tables/gold/old.dbml'))).toBe(false);
    expect(fs.readFileSync(at('tables/gold/_relationships.dbml'), 'utf-8')).toBe('﻿// rels, edited\n');
    expect(fs.readFileSync(at('tables/gold/fct.dbml'), 'utf-8')).toBe('Table fct {\n  id INT [pk]\n  x INT\n}\n');
  });

  it('restores every snapshot (and removes the folders it made) when the n-th step fails, for every n', () => {
    const before = tree();
    const total = failingIo(Infinity);
    writeFilesWithRollback(writes(), { io: total.io });
    const steps = total.calls();
    expect(steps).toBeGreaterThan(5);
    // Undo the successful run, then try every failure point.
    fs.rmSync(root, { recursive: true, force: true });
    for (let n = 1; n <= steps; n++) {
      fs.mkdirSync(at('tables/gold'), { recursive: true });
      fs.writeFileSync(at('tables/gold/fct.dbml'), 'Table fct {\n  id INT [pk]\n}\n');
      fs.writeFileSync(at('tables/gold/old.dbml'), 'Table old {\n  id INT\n}\n');
      fs.writeFileSync(at('tables/gold/_relationships.dbml'), '﻿// rels\n');
      const { io } = failingIo(n);
      expect(() => writeFilesWithRollback(writes(), { io }), `step ${n}`).toThrow(/injected failure/);
      expect(tree(), `after a failure at step ${n}`).toEqual(before);
      fs.rmSync(root, { recursive: true, force: true });
    }
    fs.mkdirSync(root, { recursive: true });
  });

  it('refuses a create whose file exists before writing anything', () => {
    fs.mkdirSync(at('tables/silver'), { recursive: true });
    fs.writeFileSync(at('tables/silver/new.dbml'), 'Table new {\n  mine INT\n}\n');
    const before = tree();
    expect(() => writeFilesWithRollback(writes())).toThrow(FileWriteExists);
    expect(tree()).toEqual(before);
  });
});
