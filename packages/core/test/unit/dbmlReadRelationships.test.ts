/**
 * `readRelationshipsDbml` and `attachRelationships` (§2.3, §2.4, §4.3 of the
 * native DBML storage spec): a relationships file read Ref by Ref from the
 * AST (binding errors never hide a Ref), and the Refs attached to their
 * DBML owners — oriented, respelled, deduplicated and grouped.
 */
import { describe, it, expect, vi } from 'vitest';

import { readRelationshipsDbml } from '../../src/dbml/readRelationships';
import { attachRelationships, dbmlTableLookup, relationshipsFileFolder } from '../../src/dbmlAttach';
import * as relationships from '../../src/relationships';
import type { DbmlAttachTable, DbmlRelationshipsReading } from '../../src/types/dbmlStorage';
import type { ColumnDef } from '../../src/types/semantic';
import { STORAGE_PARSERS } from '../dbmlParsers';

const col = (name: string, isPrimaryKey = false): ColumnDef => ({ name, dataType: 'int', description: '', ...(isPrimaryKey ? { isPrimaryKey } : {}) });
const table = (name: string, folder: string, columns: ColumnDef[], extra: Partial<DbmlAttachTable> = {}): DbmlAttachTable =>
  ({ table: { name, columns }, folder, storage: 'dbml', ...extra });

const TABLES: DbmlAttachTable[] = [
  table('fct_order', 'gold', [col('order_line_id', true), col('customer_key'), col('order_date_key'), col('ship_date_key'), col('region_code'), col('country_code')]),
  table('dim_customer', 'gold', [col('customer_key', true), col('parent_customer_key')]),
  table('customer_profile', 'gold', [col('customer_key', true)]),
  table('dim_date', '', [col('date_key', true)]),
  table('dim_region', 'gold', [col('region_code', true), col('country_code', true)]),
];
const lookup = dbmlTableLookup(TABLES);

const read = (text: string): DbmlRelationshipsReading => readRelationshipsDbml(text);

const GOLD = `// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.
use { table dim_date } from '../dim_date.dbml'
use { table customer_profile } from './customer_profile.dbml'
use { table dim_customer } from './dim_customer.dbml'
use { table dim_region } from './dim_region.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: dim_customer.customer_key ?- customer_profile.customer_key
Ref "parent": dim_customer.parent_customer_key >? dim_customer.customer_key
Ref: fct_order.customer_key >? dim_customer.customer_key
Ref "order date": fct_order.order_date_key >? dim_date.date_key
Ref "ship date": fct_order.ship_date_key >? dim_date.date_key
Ref: fct_order.(region_code, country_code) >? dim_region.(region_code, country_code)
`;

describe('readRelationshipsDbml', () => {
  it.each(STORAGE_PARSERS)('reads the spec example, Ref by Ref, in file order (%s)', (_label, parser) => {
    // Read on its own, every use target is missing: [4001] binding errors never hide a Ref.
    const reading = readRelationshipsDbml(GOLD, parser);
    expect(reading.readable).toBe(true);
    expect(reading.problems).toEqual([]);
    expect(reading.refs.map((r) => [r.owner, r.target, r.relationships.map((x) => `${x.fromColumn}>${x.toColumn}:${x.cardinality}${x.role ? `:${x.role}` : ''}`), r.line])).toEqual([
      ['customer_profile', 'dim_customer', ['customer_key>customer_key:one-to-one'], 8],
      ['dim_customer', 'dim_customer', ['parent_customer_key>customer_key:many-to-one:parent'], 9],
      ['fct_order', 'dim_customer', ['customer_key>customer_key:many-to-one'], 10],
      ['fct_order', 'dim_date', ['order_date_key>date_key:many-to-one:order date'], 11],
      ['fct_order', 'dim_date', ['ship_date_key>date_key:many-to-one:ship date'], 12],
      ['fct_order', 'dim_region', ['region_code>region_code:many-to-one', 'country_code>country_code:many-to-one'], 13],
    ]);
    expect(reading.refs[0].oneToOneDirection).toBe('mark');
    for (const ref of reading.refs) {
      expect(GOLD.slice(ref.start, ref.fullEnd).startsWith('Ref')).toBe(true);
      expect(ref.relationships.every((r) => r.compositeKey === undefined)).toBe(true);
    }
  });

  describe.each(STORAGE_PARSERS)('in %s', (_parserLabel, parser) => {
    const oneWith = (text: string) => {
      const reading = readRelationshipsDbml(text, parser);
      expect(reading.readable).toBe(true);
      expect(reading.refs).toHaveLength(1);
      return reading.refs[0];
    };

    it.each([
      ['>', 'Ref: a.x > b.y', ['a', 'x', 'b', 'y', 'many-to-one']],
      ['>?', 'Ref: a.x >? b.y', ['a', 'x', 'b', 'y', 'many-to-one']],
      ['<', 'Ref: a.x < b.y', ['b', 'y', 'a', 'x', 'many-to-one']],
      ['<?', 'Ref: a.x <? b.y', ['b', 'y', 'a', 'x', 'many-to-one']],
      ['<>', 'Ref: a.x <> b.y', ['a', 'x', 'b', 'y', 'many-to-many']],
      ['<>?', 'Ref: a.x <>? b.y', ['a', 'x', 'b', 'y', 'many-to-many']],
      ['?- (marks the right end)', 'Ref: a.x ?- b.y', ['b', 'y', 'a', 'x', 'one-to-one']],
      ['-? (marks the left end)', 'Ref: a.x -? b.y', ['a', 'x', 'b', 'y', 'one-to-one']],
    ])('the operator %s', (_label, text, [fromModel, fromColumn, toModel, toColumn, cardinality]) => {
      const ref = oneWith(text);
      expect(ref.relationships[0]).toEqual({ fromModel, fromColumn, toModel, toColumn, cardinality });
      expect(ref.owner).toBe(fromModel);
    });

    it('a bare or doubly marked `-` is left to the keys, read with the second end as the foreign key', () => {
      for (const text of ['Ref: a.x - b.y', 'Ref: a.x ?-? b.y']) {
        const ref = oneWith(text);
        expect(ref.oneToOneDirection).toBe('keys');
        expect(ref.relationships[0]).toMatchObject({ fromModel: 'b', fromColumn: 'y', toModel: 'a', toColumn: 'x' });
      }
    });

    it('reads the block form, schema-qualified ends, quoted names and duplicate names', () => {
      const reading = readRelationshipsDbml(`Ref fk { gold.fct_order.customer_key > gold.dim_customer.customer_key }
Ref "fk": "order line".x > "dim x".y
Ref "fk": a.b > c.d
`, parser);
      expect(reading.refs.map((r) => [r.owner, r.target, r.relationships[0].role])).toEqual([
        ['fct_order', 'dim_customer', 'fk'],
        ['order line', 'dim x', 'fk'],
        ['a', 'c', 'fk'],
      ]);
    });
  });

  it('skips a Ref it cannot read with a problem, and reads the rest', () => {
    const reading = read('Ref: a.(x, y) > b.z\nRef: a.x > a.x\nRef: a.x > b.y\n');
    expect(reading.refs.map((r) => r.line)).toEqual([3]);
    expect(reading.problems.map((p) => [p.code, p.line])).toEqual([['unreadableRef', 1], ['unreadableRef', 2]]);
  });

  it.each(STORAGE_PARSERS)('a syntax error makes the file unreadable (%s)', (_label, parser) => {
    const reading = readRelationshipsDbml('Ref: a.x > b.y\nRef: a.x >\n', parser);
    expect(reading).toMatchObject({ readable: false, refs: [] });
    expect(reading.problems[0].severity).toBe('error');
  });

  it('git conflict markers make it unreadable, with mergeConflict', () => {
    const reading = read('<<<<<<< HEAD\nRef: a.x > b.y\n=======\nRef: a.x > b.z\n>>>>>>> other\n');
    expect(reading.readable).toBe(false);
    expect(reading.problems[0]).toMatchObject({ mergeConflict: true, line: 1 });
  });

  it('a leading byte-order mark is stripped', () => {
    expect(read('\uFEFFRef: a.x > b.y\n').refs).toHaveLength(1);
  });
});

describe('attachRelationships', () => {
  const attach = (files: Record<string, string>, tables = lookup) =>
    attachRelationships(Object.entries(files).map(([path, text]) => ({ path, reading: read(text) })), tables);

  it('attaches the spec example to its owners, respelled, with derived composite keys', () => {
    const result = attach({ 'tables/gold/_relationships.dbml': GOLD });
    expect(result.warnings).toEqual([]);
    expect(Object.fromEntries(result.byOwner)).toEqual({
      customer_profile: [{ fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' }],
      dim_customer: [{ fromColumn: 'parent_customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', role: 'parent' }],
      fct_order: [
        { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
        { fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'order date' },
        { fromColumn: 'ship_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'ship date' },
        { fromColumn: 'region_code', toModel: 'dim_region', toColumn: 'region_code', cardinality: 'many-to-one', compositeKey: 'fk_dim_region' },
        { fromColumn: 'country_code', toModel: 'dim_region', toColumn: 'country_code', cardinality: 'many-to-one', compositeKey: 'fk_dim_region' },
      ],
    });
  });

  it('derives composite keys with the planner\'s own nextCompositeKey', () => {
    const spy = vi.spyOn(relationships, 'nextCompositeKey');
    try {
      const result = attach({ 'tables/gold/_relationships.dbml': 'Ref: fct_order.(region_code, country_code) > dim_region.(region_code, country_code)\nRef: fct_order.(customer_key, order_date_key) > dim_region.(region_code, country_code)\n' });
      expect(result.byOwner.get('fct_order')!.map((r) => r.compositeKey)).toEqual(['fk_dim_region', 'fk_dim_region', 'fk_dim_region_2', 'fk_dim_region_2']);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
    // The module function is the one the host planner re-exports (moved to core in S1).
    expect(typeof relationships.nextCompositeKey).toBe('function');
  });

  it('respells ends to the real table and column spelling, and maps schema qualifiers and DBML aliases', () => {
    const tables = dbmlTableLookup([...TABLES, table('fct_sales', 'gold', [col('id', true), col('Customer_Key')], { dbmlAlias: 'FS' })]);
    const result = attach({ 'tables/gold/_relationships.dbml': 'Ref: FS.customer_key > GOLD.Dim_Customer.CUSTOMER_KEY\n' }, tables);
    expect(result.byOwner.get('fct_sales')).toEqual([{ fromColumn: 'Customer_Key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }]);
  });

  it('a self-reference attaches to its one table', () => {
    const result = attach({ 'tables/gold/_relationships.dbml': 'Ref: dim_customer.parent_customer_key > dim_customer.customer_key\n' });
    expect(result.byOwner.get('dim_customer')).toHaveLength(1);
  });

  it('keeps a dangling end (a target with no table, a column it lacks) in the owner\'s list', () => {
    const result = attach({ 'tables/gold/_relationships.dbml': 'Ref: fct_order.customer_key > dim_gone.id\nRef: fct_order.region_code > dim_customer.gone\n' });
    expect(result.byOwner.get('fct_order')).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_gone', toColumn: 'id', cardinality: 'many-to-one' },
      { fromColumn: 'region_code', toModel: 'dim_customer', toColumn: 'gone', cardinality: 'many-to-one' },
    ]);
  });

  describe('a one-to-one\'s direction (§2.3)', () => {
    it('(1) a single ? mark decides, whatever the keys say (the shared-primary-key pattern)', () => {
      // customer_profile.customer_key is its whole key; the mark still makes it the FK.
      const result = attach({ 'tables/gold/_relationships.dbml': 'Ref: dim_customer.customer_key ?- customer_profile.customer_key\n' });
      expect([...result.byOwner.keys()]).toEqual(['customer_profile']);
    });

    it('(2) a bare `-`: the second end is the FK, unless only it is its table\'s whole key', () => {
      // FK-first, as an assistant writes it: the right end is dim_customer's whole key, the left is not fct_order's.
      const fkFirst = attach({ 'tables/gold/_relationships.dbml': 'Ref: fct_order.customer_key - dim_customer.customer_key\n' });
      expect([...fkFirst.byOwner.keys()]).toEqual(['fct_order']);
      // Key-first, as DBML reads it: the second end is the FK.
      const keyFirst = attach({ 'tables/gold/_relationships.dbml': 'Ref: dim_customer.customer_key - fct_order.customer_key\n' });
      expect([...keyFirst.byOwner.keys()]).toEqual(['fct_order']);
      // Both ends whole keys: by position, the second end.
      const both = attach({ 'tables/gold/_relationships.dbml': 'Ref: dim_customer.customer_key - customer_profile.customer_key\n' });
      expect([...both.byOwner.keys()]).toEqual(['customer_profile']);
    });

    it('(3) an end whose table the reader does not have: the second end is the FK', () => {
      const result = attach({ 'tables/gold/_relationships.dbml': 'Ref: fct_order.customer_key - dim_gone.id\n' });
      expect(result.byOwner.size).toBe(0);
      expect(result.orphaned.map((o) => o.owner)).toEqual(['dim_gone']);
    });
  });

  it('a misplaced Ref attaches, with a warning naming its home', () => {
    const result = attach({ 'tables/_relationships.dbml': 'Ref: fct_order.customer_key >? dim_customer.customer_key\n' });
    expect(result.byOwner.get('fct_order')).toHaveLength(1);
    expect(result.misplaced).toEqual([{ path: 'tables/_relationships.dbml', line: 1, owner: 'fct_order', target: 'dim_customer', home: 'gold' }]);
    expect(result.warnings[0]).toContain('tables/gold/');
  });

  it('an orphaned Ref (a YAML owner, or no owner) is not attached', () => {
    const tables = dbmlTableLookup([...TABLES, { table: { name: 'yaml_fact', columns: [col('customer_key')] }, folder: 'gold', storage: 'yaml' }]);
    const result = attach({ 'tables/gold/_relationships.dbml': 'Ref: yaml_fact.customer_key > dim_customer.customer_key\nRef: nobody.x > dim_customer.customer_key\n' }, tables);
    expect(result.byOwner.size).toBe(0);
    expect(result.orphaned.map((o) => o.owner)).toEqual(['yaml_fact', 'nobody']);
    expect(result.warnings).toHaveLength(2);
  });

  it('partial: a Ref whose owner the lookup does not hold is skipped without a warning; a YAML owner is still orphaned', () => {
    // Core's loader holds only a diagram's members; the owner may be a DBML table off the diagram.
    const tables = dbmlTableLookup([...TABLES, { table: { name: 'yaml_fact', columns: [col('customer_key')] }, folder: 'gold', storage: 'yaml' }]);
    const text = 'Ref: yaml_fact.customer_key > dim_customer.customer_key\nRef: not_on_diagram.x > dim_customer.customer_key\nRef: fct_order.customer_key >? dim_customer.customer_key\n';
    const result = attachRelationships([{ path: 'tables/gold/_relationships.dbml', reading: read(text) }], tables, { partial: true });
    expect(result.orphaned.map((o) => o.owner)).toEqual(['yaml_fact']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('a YAML table');
    expect([...result.byOwner.keys()]).toEqual(['fct_order']);
  });

  it('the same link in two files, or twice in one, is attached once, with a warning naming both places', () => {
    const twoFiles = attach({
      'tables/gold/_relationships.dbml': 'Ref: fct_order.customer_key >? dim_customer.customer_key\n',
      'tables/_relationships.dbml': 'Ref "buyer": dim_customer.customer_key < fct_order.customer_key\n',
    });
    expect(twoFiles.byOwner.get('fct_order')).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', role: 'buyer' },
    ]);
    expect(twoFiles.duplicates).toHaveLength(1);
    expect(twoFiles.warnings.some((w) => w.includes('tables/gold/_relationships.dbml line 1') && w.includes('tables/_relationships.dbml line 1'))).toBe(true);

    const oneFile = attach({ 'tables/gold/_relationships.dbml': 'Ref: fct_order.customer_key > dim_customer.customer_key\nRef: fct_order.customer_key > dim_customer.customer_key\n' });
    expect(oneFile.byOwner.get('fct_order')).toHaveLength(1);
    expect(oneFile.duplicates.map((d) => [d.kept.line, d.dropped.line])).toEqual([[1, 2]]);
  });

  it('skips an unreadable file and reads the others', () => {
    const result = attach({
      'tables/gold/_relationships.dbml': 'Ref: fct_order.customer_key >\n',
      'tables/_relationships.dbml': 'Ref: fct_order.order_date_key > dim_date.date_key\n',
    });
    expect(result.byOwner.get('fct_order')).toHaveLength(1);
  });

  it('relationshipsFileFolder names the folder of a relationships file', () => {
    expect(relationshipsFileFolder('tables/_relationships.dbml')).toBe('');
    expect(relationshipsFileFolder('.erd-studio/tables/gold/_relationships.dbml')).toBe('gold');
    expect(relationshipsFileFolder('C:\\p\\.erd-studio\\tables\\SAP FI\\_relationships.dbml')).toBe('SAP FI');
  });
});

describe('line numbers in a large file (§7.6)', () => {
  it('reads 30,000 Refs with the right line each, in linear time', async () => {
    const { lineAt } = await import('../../src/dbml/parser');
    const lines = ['// header', ''];
    for (let i = 0; i < 30_000; i++) lines.push(`Ref: t${i}.fk >? t${i + 1}.id`);
    const text = `${lines.join('\n')}\n`;
    const start = performance.now();
    const reading = readRelationshipsDbml(text);
    const elapsed = performance.now() - start;
    expect(reading.refs).toHaveLength(30_000);
    expect(reading.refs[0].line).toBe(3);
    expect(reading.refs[29_999].line).toBe(30_002);
    // A line scan per Ref took about 15 s here; linear is about 1 s.
    expect(elapsed).toBeLessThan(10_000);
    // lineAt keeps answering for whichever text it is asked about.
    expect(lineAt('a\nb\r\nc', 0)).toBe(1);
    expect(lineAt('a\nb\r\nc', 2)).toBe(2);
    expect(lineAt(text, text.length + 50)).toBe(lines.length + 1);
    expect(lineAt('a\nb\r\nc', 5)).toBe(3);
    expect(lineAt('x', -1)).toBe(1);
  }, 60_000);
});

describe('pending relationships (D27)', () => {
  const FILE = `use { table fct } from './fct.dbml'

Ref: fct.a >? dim.a
// erd-studio pending: Ref: fct.b >? dim_missing.b
// erd-studio pending: Ref "role": dim.k ?- fct.k
// erd-studio pending: Ref: fct.c >
`;

  it.each(STORAGE_PARSERS)('%s: reads each pending line as a Ref of its own, never among the live Refs', (_label, parser) => {
    const reading = readRelationshipsDbml(FILE, parser);
    expect(reading.readable).toBe(true);
    expect(reading.refs.map((r) => r.relationships[0].fromColumn)).toEqual(['a']);
    expect(reading.pending?.map((r) => [r.line, r.pending, r.relationships])).toEqual([
      [4, true, [{ fromModel: 'fct', fromColumn: 'b', toModel: 'dim_missing', toColumn: 'b', cardinality: 'many-to-one' }]],
      [5, true, [{ fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'one-to-one', role: 'role' }]],
    ]);
    expect(reading.pending![0].start).toBe(FILE.indexOf('// erd-studio pending: Ref: fct.b'));
    expect(FILE.slice(reading.pending![0].start, reading.pending![0].fullEnd)).toBe('// erd-studio pending: Ref: fct.b >? dim_missing.b\n');
    expect(reading.problems).toEqual([expect.objectContaining({ line: 6, code: 'unreadableRef', message: expect.stringMatching(/^Line 6: the pending relationship `Ref: fct\.c >` is not one/) })]);
  });

  it('attaches a pending relationship to its owner exactly like a live Ref, a target with no table kept as written', () => {
    const table = (name: string, columns: string[]): DbmlAttachTable => ({
      table: { name, columns: columns.map((c) => ({ name: c, dataType: 'int', description: '' }) as ColumnDef) }, folder: '', storage: 'dbml',
    });
    const result = attachRelationships([{ path: 'tables/_relationships.dbml', reading: readRelationshipsDbml(FILE) }], dbmlTableLookup([table('fct', ['a', 'b', 'k']), table('dim', ['a', 'k'])]));
    expect(result.byOwner.get('fct')).toEqual([
      { fromColumn: 'a', toModel: 'dim', toColumn: 'a', cardinality: 'many-to-one' },
      { fromColumn: 'b', toModel: 'dim_missing', toColumn: 'b', cardinality: 'many-to-one' },
      { fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'one-to-one', role: 'role' },
    ]);
  });
});
