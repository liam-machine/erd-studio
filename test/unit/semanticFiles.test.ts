/**
 * `listSemanticFiles`: the path-only walk doctor's stray check and
 * Convert's input listing share. Tested here on the shapes the classifier
 * already reads; the layer-first rows join when the classifier switches.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { listSemanticFiles } from '../../src/services/semanticFiles';

let semanticRoot: string;

function write(rel: string, text = ''): void {
  const file = path.join(semanticRoot, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  semanticRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-semantic-files-')), '.erd-studio');
  fs.mkdirSync(semanticRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(path.dirname(semanticRoot), { recursive: true, force: true });
});

describe('listSemanticFiles', () => {
  it('lists every file with its class, byte-sorted', () => {
    write('layers.json', '{}');
    write('logical-models/dim_customer.yml');
    write('logical-models/gold/fct_order.yml');
    write('gold/sales.json', '{}');
    write('templates/default.yml');
    write('modelling-approach.md');
    write('gold/notes.txt');
    const listed = listSemanticFiles(semanticRoot, { tablesDirIsLayer: false });
    expect(listed.map((f) => f.rel)).toEqual([
      'gold/notes.txt',
      'gold/sales.json',
      'layers.json',
      'logical-models/dim_customer.yml',
      'logical-models/gold/fct_order.yml',
      'modelling-approach.md',
      'templates/default.yml',
    ]);
    const kinds = Object.fromEntries(listed.map((f) => [f.rel, f.cls.kind]));
    expect(kinds).toEqual({
      'gold/notes.txt': 'other',
      'gold/sales.json': 'diagram',
      'layers.json': 'layers',
      'logical-models/dim_customer.yml': 'table',
      'logical-models/gold/fct_order.yml': 'table',
      'modelling-approach.md': 'other',
      'templates/default.yml': 'template',
    });
    expect(listed.find((f) => f.rel === 'logical-models/gold/fct_order.yml')?.cls).toEqual({ kind: 'table', storage: 'yaml', folder: 'gold', name: 'fct_order' });
  });

  it('classifies a tables/ folder by tablesDirIsLayer', () => {
    write('tables/dim_customer.yml');
    write('tables/sales.json', '{}');
    expect(listSemanticFiles(semanticRoot, { tablesDirIsLayer: false }).map((f) => f.cls.kind)).toEqual(['table', 'other']);
    expect(listSemanticFiles(semanticRoot, { tablesDirIsLayer: true }).map((f) => f.cls.kind)).toEqual(['other', 'diagram']);
  });

  it('skips dot entries and node_modules, and lists files at most five segments deep', () => {
    write('.sync-plan.json', '{}');
    write('.git/HEAD');
    write('gold/.hidden/x.dbml');
    write('node_modules/pkg/index.js');
    write('gold/node_modules/x.json');
    write('a/b/c/d/five.txt');
    write('a/b/c/d/e/six.txt');
    expect(listSemanticFiles(semanticRoot, { tablesDirIsLayer: false }).map((f) => f.rel)).toEqual(['a/b/c/d/five.txt']);
  });

  it('never follows a symbolic link to a directory, and lists one to a file', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-semantic-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'x.yml'), '');
      fs.mkdirSync(path.join(semanticRoot, 'logical-models'), { recursive: true });
      fs.symlinkSync(outside, path.join(semanticRoot, 'linked'), 'dir');
      fs.symlinkSync(path.join(outside, 'x.yml'), path.join(semanticRoot, 'logical-models', 'x.yml'));
      expect(listSemanticFiles(semanticRoot, { tablesDirIsLayer: false }).map((f) => f.rel)).toEqual(['logical-models/x.yml']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('lists nothing for a semantic dir that does not exist', () => {
    expect(listSemanticFiles(path.join(semanticRoot, 'nowhere'), { tablesDirIsLayer: false })).toEqual([]);
  });
});
