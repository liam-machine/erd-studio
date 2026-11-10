/**
 * The parser wrapper's compile caches (`compileOne`): a diagram's compile
 * lives in its own cache, so reading the hundreds of tables a diagram shows
 * (each one compiled once) never pushes the diagram out before the edit that
 * follows compiles it again.
 */

import { describe, it, expect } from 'vitest';

import { compileOne } from '../../src/dbml/parser';
import { clearDbmlCompileCaches, dbmlStorageReader } from '../../src/dbml/index';
import { parseSubjectAreaDbml } from '../../src/dbml/readDiagram';

const DIAGRAM = `Project d {
  erd_schema_version: '7'
}

use { table gold.a } from '../tables/gold/a.dbml'
use { table gold.b } from '../tables/gold/b.dbml'
`;

describe('compileOne caches', () => {
  it('a diagram compile survives many table compiles', () => {
    const first = compileOne(DIAGRAM, undefined, undefined, { diagram: true });
    for (let i = 0; i < 100; i++) compileOne(`Table t${i} {\n  id INT [pk]\n}\n`);
    expect(compileOne(DIAGRAM, undefined, undefined, { diagram: true })).toBe(first);
  });

  it('a table compile is still cached for the writer that re-reads it', () => {
    const text = 'Table only_once {\n  id INT [pk]\n}\n';
    expect(compileOne(text)).toBe(compileOne(text));
  });

  it('the two caches do not share entries: the same text compiled each way is two compiles', () => {
    const text = 'Table both_ways {\n  id INT [pk]\n}\n';
    expect(compileOne(text, undefined, undefined, { diagram: true })).not.toBe(compileOne(text));
  });

  it('reading a diagram after 100 table compiles reads the same as before', () => {
    const before = parseSubjectAreaDbml(DIAGRAM, 'gold/diagrams/d.dbml');
    for (let i = 0; i < 100; i++) compileOne(`Table u${i} {\n  id INT [pk]\n}\n`);
    expect(parseSubjectAreaDbml(DIAGRAM, 'gold/diagrams/d.dbml')).toEqual(before);
  });

  it('clearDbmlCompileCaches drops both caches: every file compiles again, and reads the same', () => {
    const table = 'Table cleared {\n  id INT [pk]\n}\n';
    const tableBefore = compileOne(table);
    const diagramBefore = compileOne(DIAGRAM, undefined, undefined, { diagram: true });
    const readBefore = parseSubjectAreaDbml(DIAGRAM, 'gold/diagrams/d.dbml');
    clearDbmlCompileCaches();
    expect(compileOne(table)).not.toBe(tableBefore);
    expect(compileOne(DIAGRAM, undefined, undefined, { diagram: true })).not.toBe(diagramBefore);
    clearDbmlCompileCaches();
    expect(parseSubjectAreaDbml(DIAGRAM, 'gold/diagrams/d.dbml')).toEqual(readBefore);
    expect(dbmlStorageReader.parseTable(table, 'cleared')).toEqual(dbmlStorageReader.parseTable(table, 'cleared'));
  });

  it('clearing between compiles keeps nothing: a compile made after a clear is the only one cached', () => {
    const a = compileOne('Table a1 {\n  id INT [pk]\n}\n');
    clearDbmlCompileCaches();
    const b = compileOne('Table b1 {\n  id INT [pk]\n}\n');
    expect(compileOne('Table b1 {\n  id INT [pk]\n}\n')).toBe(b);
    expect(compileOne('Table a1 {\n  id INT [pk]\n}\n')).not.toBe(a);
  });
});
