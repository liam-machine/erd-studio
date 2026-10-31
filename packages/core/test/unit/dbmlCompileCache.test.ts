/**
 * The parser wrapper's compile caches (`compileOne`): a diagram's compile
 * lives in its own cache, so reading the hundreds of tables a diagram shows
 * (each one compiled once) never pushes the diagram out before the edit that
 * follows compiles it again.
 */

import { describe, it, expect } from 'vitest';

import { compileOne } from '../../src/dbml/parser';
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
});
