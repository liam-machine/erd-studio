/**
 * writeFilesWithRollback (§4.1, §5.1 of docs/plans/native-dbml-storage.md,
 * §9.5): the non-editor paths' writes, all or nothing — when the n-th
 * operation fails, for every n, every file and folder is as it was — and a
 * replaced file keeps its byte-order mark. Creates go in the layer-first
 * tree's order when the semantic dir is given (2.0 design §2.8): tables,
 * relationships files, diagrams, the README, anything else.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FileWriteExists, writeFilesWithRollback } from '../../src/services/fsFileWrites';
import type { FileWriteIo } from '../../src/services/fsFileWrites';
import { orderFileWrites } from '../../src/services/fileWrites';
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
    { kind: 'replace', path: at('gold/tables/gold/fct.dbml'), text: 'Table gold.fct {\n  id INT [pk]\n  x INT\n}\n' },
    { kind: 'create', path: at('silver/diagrams/new.dbml'), text: "use { table silver.new } from '../tables/silver/new.dbml'\n" },
    { kind: 'create', path: at('silver/relationships/silver.dbml'), text: '// rels\n' },
    { kind: 'create', path: at('silver/tables/silver/new.dbml'), text: 'Table silver.new {\n  id INT\n}\n' },
    { kind: 'delete', path: at('gold/tables/gold/old.dbml') },
    { kind: 'replace', path: at('gold/relationships/gold.dbml'), text: '// rels, edited\n' },
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

/** The files before every write: two gold tables and gold's relationships file (with a BOM). */
function seed(): void {
  fs.mkdirSync(at('gold/tables/gold'), { recursive: true });
  fs.mkdirSync(at('gold/relationships'), { recursive: true });
  fs.writeFileSync(at('gold/tables/gold/fct.dbml'), 'Table gold.fct {\n  id INT [pk]\n}\n');
  fs.writeFileSync(at('gold/tables/gold/old.dbml'), 'Table gold.old {\n  id INT\n}\n');
  fs.writeFileSync(at('gold/relationships/gold.dbml'), '﻿// rels\n');
}

const rel = (p: string): string => path.relative(root, p).split(path.sep).join('/');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-fs-writes-'));
  seed();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('writeFilesWithRollback', () => {
  it('applies every write, creates first (tables, relationships, diagrams with the semantic dir), and keeps a BOM the replaced file had', () => {
    const written = writeFilesWithRollback(writes(), { semanticRoot: root });
    expect(written.map(rel)).toEqual([
      'silver/tables/silver/new.dbml', 'silver/relationships/silver.dbml', 'silver/diagrams/new.dbml',
      'gold/tables/gold/fct.dbml', 'gold/relationships/gold.dbml', 'gold/tables/gold/old.dbml',
    ]);
    expect(fs.existsSync(at('gold/tables/gold/old.dbml'))).toBe(false);
    expect(fs.readFileSync(at('gold/relationships/gold.dbml'), 'utf-8')).toBe('﻿// rels, edited\n');
    expect(fs.readFileSync(at('gold/tables/gold/fct.dbml'), 'utf-8')).toBe('Table gold.fct {\n  id INT [pk]\n  x INT\n}\n');
  });

  it('without the semantic dir, every .dbml create ranks alike: they keep the order given', () => {
    const written = writeFilesWithRollback(writes());
    expect(written.map(rel).slice(0, 3)).toEqual(['silver/diagrams/new.dbml', 'silver/relationships/silver.dbml', 'silver/tables/silver/new.dbml']);
  });

  it('restores every snapshot (and removes the folders it made) when the n-th step fails, for every n', () => {
    const before = tree();
    const total = failingIo(Infinity);
    writeFilesWithRollback(writes(), { io: total.io, semanticRoot: root });
    const steps = total.calls();
    expect(steps).toBeGreaterThan(5);
    // Undo the successful run, then try every failure point.
    fs.rmSync(root, { recursive: true, force: true });
    for (let n = 1; n <= steps; n++) {
      seed();
      const { io } = failingIo(n);
      expect(() => writeFilesWithRollback(writes(), { io, semanticRoot: root }), `step ${n}`).toThrow(/injected failure/);
      expect(tree(), `after a failure at step ${n}`).toEqual(before);
      fs.rmSync(root, { recursive: true, force: true });
    }
    fs.mkdirSync(root, { recursive: true });
  });

  it('refuses a create whose file exists before writing anything', () => {
    fs.mkdirSync(at('silver/tables/silver'), { recursive: true });
    fs.writeFileSync(at('silver/tables/silver/new.dbml'), 'Table silver.new {\n  mine INT\n}\n');
    const before = tree();
    expect(() => writeFilesWithRollback(writes())).toThrow(FileWriteExists);
    expect(tree()).toEqual(before);
  });
});

describe('orderFileWrites: the create order (§2.8)', () => {
  const create = (rel: string): FileWrite => ({ kind: 'create', path: at(rel), text: '' });
  const order = (list: FileWrite[], semanticRoot?: string): string[] => orderFileWrites(list, semanticRoot).map((w) => rel(w.path));

  it('ranks by what the tree classifies the path as: a schema folder named `relationships` is a table', () => {
    const list = [
      create('notes.txt'),
      create('README.md'),
      create('gold/diagrams/sales.dbml'),
      create('gold/relationships/gold.dbml'),
      create('gold/tables/relationships/x.dbml'),
      create('gold/tables/gold/y.dbml'),
    ];
    expect(order(list, root)).toEqual([
      'gold/tables/relationships/x.dbml', 'gold/tables/gold/y.dbml',
      'gold/relationships/gold.dbml',
      'gold/diagrams/sales.dbml',
      'README.md',
      'notes.txt',
    ]);
  });

  it('a path outside the semantic dir ranks as it would without one; replaces and deletes follow every create', () => {
    const list: FileWrite[] = [
      { kind: 'delete', path: at('gold/tables/gold/old.dbml') },
      { kind: 'replace', path: at('gold/relationships/gold.dbml'), text: '' },
      { kind: 'create', path: path.join(os.tmpdir(), 'elsewhere', 'x.json'), text: '' },
      create('gold/diagrams/sales.dbml'),
      { kind: 'create', path: path.join(os.tmpdir(), 'elsewhere', 'y.dbml'), text: '' },
    ];
    const out = orderFileWrites(list, root).map((w) => `${w.kind} ${path.basename(w.path)}`);
    expect(out).toEqual(['create y.dbml', 'create sales.dbml', 'create x.json', 'replace gold.dbml', 'delete old.dbml']);
  });

  it('YAML and JSON creates: a table before the JSON diagram and layers.json, with and without the semantic dir', () => {
    // As each caller had it before 2.0: a .yml first, then everything else in the order given.
    const list = [create('layers.json'), create('gold/sales.json'), create('logical-models/dim_x.yml'), create('tables/gold/fct_y.yml')];
    expect(order(list)).toEqual(['logical-models/dim_x.yml', 'tables/gold/fct_y.yml', 'layers.json', 'gold/sales.json']);
    // With the semantic dir, a JSON diagram ranks 2 and layers.json 4 (only the DBML batch passes it).
    expect(order(list, root)).toEqual(['logical-models/dim_x.yml', 'tables/gold/fct_y.yml', 'gold/sales.json', 'layers.json']);
  });
});
