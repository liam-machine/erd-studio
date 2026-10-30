/**
 * `withKeptFilepathKeys` (internal to the parser wrapper): every compile
 * keeps each parser file key once while it runs, and gives exactly the
 * diagnostics it gave without (the readers' and compileDbmlProject's own
 * tests and goldens run through it too).
 */

import { describe, expect, it } from 'vitest';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';

import { compileDbmlProject } from '../../src/dbml/compileProject';
import { PINNED_PARSER, withKeptFilepathKeys } from '../../src/dbml/parser';
import type { DbmlParserModule } from '../../src/dbml/parserModule';

type WithToKey = { prototype: { toKey: () => string } };
const toKeyOf = (parser: DbmlParserModule): (() => string) => (parser.Filepath as unknown as WithToKey).prototype.toKey;

describe('withKeptFilepathKeys', () => {
  it('gives the same keys while it runs and puts the parser method back', () => {
    const original = toKeyOf(PINNED_PARSER);
    const a = PINNED_PARSER.Filepath.from('/erd-studio/gold/tables/SAP FI/a b.dbml');
    const b = PINNED_PARSER.Filepath.from('/erd-studio/gold/diagrams/x.dbml');
    const keys = withKeptFilepathKeys(PINNED_PARSER, () => [a.toKey(), a.toKey(), b.toKey()]);
    expect(keys).toEqual([original.call(a), original.call(a), original.call(b)]);
    expect(toKeyOf(PINNED_PARSER)).toBe(original);
  });

  it('puts the method back when the work throws, and runs a nested call as is', () => {
    const original = toKeyOf(PINNED_PARSER);
    expect(() => withKeptFilepathKeys(PINNED_PARSER, () => withKeptFilepathKeys(PINNED_PARSER, () => { throw new Error('boom'); }))).toThrow('boom');
    expect(toKeyOf(PINNED_PARSER)).toBe(original);
  });

  it('runs unchanged with a parser whose Filepath has no such method', () => {
    const bare = { ...PINNED_PARSER, Filepath: { from: PINNED_PARSER.Filepath.from } } as DbmlParserModule;
    expect(withKeptFilepathKeys(bare, () => 42)).toBe(42);
  });

  it.each([
    ['9.1.1', v9 as unknown as DbmlParserModule],
    ['10.3.1', v10 as unknown as DbmlParserModule],
    ['11.0.0', PINNED_PARSER],
  ])('a multi-file compile reports the same with and without it (%s)', (_label, parser) => {
    const files = {
      'gold/tables/gold/a.dbml': 'Table gold.a {\n  id int [pk]\n  b_id int\n}\n',
      'gold/tables/gold/b.dbml': 'Table gold.b {\n  id int [pk]\n}\n',
      'gold/relationships/gold.dbml': "use { table gold.a } from '../tables/gold/a.dbml'\nuse { table gold.b } from '../tables/gold/b.dbml'\nRef: gold.a.b_id > gold.b.id\nRef: gold.a.nope > gold.b.id\n",
      'gold/diagrams/d.dbml': "use { table gold.a } from '../tables/gold/a.dbml'\nuse { table gold.missing } from '../tables/gold/missing.dbml'\nuse * from '../relationships/gold.dbml'\n",
    };
    const entries = Object.keys(files);
    const kept = compileDbmlProject(files, entries, parser);
    const proto = (parser.Filepath as unknown as WithToKey).prototype;
    const original = proto.toKey;
    // Without: a method that is not the original one, so withKeptFilepathKeys still installs, but computes every time.
    const plain = (() => {
      let result: ReturnType<typeof compileDbmlProject> | undefined;
      withKeptFilepathKeys(parser, () => {
        proto.toKey = original;
        result = compileDbmlProject(files, entries, parser);
      });
      return result!;
    })();
    expect(kept).toEqual(plain);
    expect(Object.values(kept).flat().length).toBeGreaterThan(0);
    expect(proto.toKey).toBe(original);
  });
});
