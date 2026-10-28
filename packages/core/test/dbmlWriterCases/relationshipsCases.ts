/**
 * The relationships-file writer cases (§9.3 `dbmlWriteRelationships`): each
 * one edits (or creates) `tables/gold/_relationships.dbml` against a small
 * library and checks the text. `dbmlWriteRelationships.test.ts` runs the
 * checks; `dbmlMultiParser.test.ts` compiles every output again, with the
 * table files its `use` lines name, under 9.1.1, 10.3.1 and 11.0.0. Not a
 * test file.
 */
import { expect } from 'vitest';

import { editRelationshipsDbml, type RelationshipsFileEdit } from '../../src/dbml/writeRelationships';
import type { TableRelationship } from '../../src/types/semantic';
import {
  comparableRelationships,
  libraryOf,
  ownersOf,
  relationshipsResolver,
  type WriterCase,
  type WriterOutcome,
} from '../dbmlWriterSupport';

export const REL_PATH = 'tables/gold/_relationships.dbml';

/** The library the cases resolve against: a schema-qualified table, real column spellings that differ in case, a composite key. */
export const LIBRARY: Readonly<Record<string, string>> = {
  'tables/dim_date.dbml': 'Table dim_date {\n  date_key int [pk]\n}\n',
  'tables/gold/dim_customer.dbml': 'Table gold.dim_customer {\n  customer_key int [pk]\n  parent_key int\n}\n',
  'tables/gold/dim_region.dbml': 'Table dim_region {\n  region_code varchar\n  country_code varchar\n  indexes {\n    (region_code, country_code) [pk]\n  }\n}\n',
  'tables/gold/fct_order.dbml': 'Table fct_order {\n  order_id int [pk]\n  Customer_Key int\n  region_code varchar\n  country_code varchar\n  order_date_key int\n  ship_date_key int\n}\n',
  'tables/gold/customer_profile.dbml': 'Table customer_profile {\n  customer_key int [pk]\n}\n',
  'tables/gold/bridge.dbml': 'Table bridge {\n  a_key int\n  b_key int\n}\n',
};

/** The library with `fct_order` renamed to `fct_order_line`. */
export const RENAMED_LIBRARY: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = { ...LIBRARY };
  delete out['tables/gold/fct_order.dbml'];
  out['tables/gold/fct_order_line.dbml'] = LIBRARY['tables/gold/fct_order.dbml'].replace('Table fct_order', 'Table fct_order_line');
  return out;
})();

/** A hand-written file: a header comment, extra and unsorted lines, settings, marks and comments. */
export const HAND_WRITTEN = `// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.
use { table dim_date } from '../dim_date.dbml'
use { table gold.dim_customer } from './dim_customer.dbml'
use { table fct_order } from './fct_order.dbml'
use { table customer_profile } from './customer_profile.dbml'

// the customer of an order
Ref: fct_order.Customer_Key > gold.dim_customer.customer_key [delete: cascade] // keep me
Ref "ship date": fct_order.ship_date_key >? dim_date.date_key
Ref: gold.dim_customer.customer_key - customer_profile.customer_key
`;

/** A composite Ref with settings and a trailing comment. */
const COMPOSITE_REF = `use { table dim_region } from './dim_region.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: fct_order.(region_code, country_code) > dim_region.(region_code, country_code) [delete: cascade] // keep
`;

/** A block-form Ref with a comment inside. */
const BLOCK_REF = `use { table gold.dim_customer } from './dim_customer.dbml'
use { table fct_order } from './fct_order.dbml'

Ref fk {
  // explain
  fct_order.Customer_Key > gold.dim_customer.customer_key [delete: cascade]
}
`;

/** A bare \`-\` written foreign key first. */
const FK_FIRST = `use { table fct_order } from './fct_order.dbml'
use { table gold.dim_customer } from './dim_customer.dbml'

Ref: fct_order.Customer_Key - gold.dim_customer.customer_key
`;

/** Two sorted Refs; renaming bridge to zz_bridge puts its Ref last. */
const SORTED_FOR_RENAME = `use { table bridge } from './bridge.dbml'
use { table customer_profile } from './customer_profile.dbml'
use { table dim_date } from '../dim_date.dbml'

Ref: bridge.a_key >? dim_date.date_key // a tail
Ref: customer_profile.customer_key >? dim_date.date_key
`;

/** The library with \`bridge\` renamed to \`zz_bridge\`. */
const BRIDGE_RENAMED: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = { ...LIBRARY };
  delete out['tables/gold/bridge.dbml'];
  out['tables/gold/zz_bridge.dbml'] = LIBRARY['tables/gold/bridge.dbml'].replace('Table bridge', 'Table zz_bridge');
  return out;
})();

/** A relationships file with a live Ref and two pending lines (D27): one to a table with no file, one from another owner. */
export const PENDING_FILE = `use { table gold.dim_customer } from './dim_customer.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: fct_order.Customer_Key >? gold.dim_customer.customer_key

// erd-studio pending: Ref: fct_order.order_date_key >? dim_missing.date_key
// erd-studio pending: Ref: customer_profile.customer_key >? dim_gone.k
`;

/** The library with a file for dim_missing. */
const WITH_DIM_MISSING: Readonly<Record<string, string>> = { ...LIBRARY, 'tables/dim_missing.dbml': 'Table dim_missing {\n  date_key int [pk]\n}\n' };

const M21 = (fromColumn: string, toModel: string, toColumn: string, extra: Partial<TableRelationship> = {}): TableRelationship =>
  ({ fromColumn, toModel, toColumn, cardinality: 'many-to-one', ...extra });

/** Each owner's relationships as `text` reads (§2.4), for building "the same plus a change". */
export function currentOwners(text: string, library: Readonly<Record<string, string>> = LIBRARY): Map<string, TableRelationship[]> {
  return ownersOf({ ...library, [REL_PATH]: text }, libraryOf(library));
}

type EditInput = Omit<RelationshipsFileEdit, 'filePath' | 'resolve'>;

export function relEdit(text: string | null, edit: EditInput, library: Readonly<Record<string, string>> = LIBRARY, path = REL_PATH): string {
  return editRelationshipsDbml(text, { filePath: path, resolve: relationshipsResolver(libraryOf(library)), ...edit });
}

function relCase(name: string, text: string | null, edit: () => EditInput, check: (output: string) => void, library: Readonly<Record<string, string>> = LIBRARY): WriterCase {
  return {
    name,
    run: (): WriterOutcome => ({ path: REL_PATH, input: text, output: relEdit(text, edit(), library), context: { ...library } }),
    check: (o) => check(o.output),
  };
}

/** `owners` for one owner: its relationships as read from `text`, changed by `change`. */
function changed(text: string, owner: string, change: (list: TableRelationship[]) => TableRelationship[], library = LIBRARY): EditInput {
  const list = currentOwners(text, library).get(owner.toLowerCase()) ?? [];
  return { owners: new Map([[owner.toLowerCase(), { name: owner, relationships: change(list.map((r) => ({ ...r }))) }]]) };
}

/** The Law 2/3 edit: fct_order's list with dim_date dropped, a composite and a one-to-one with a role. */
function lawOwners(): Map<string, { name: string; relationships: TableRelationship[] }> {
  const owners = currentOwners(HAND_WRITTEN);
  return new Map([['fct_order', {
    name: 'fct_order',
    relationships: [
      ...owners.get('fct_order')!.filter((r) => r.toModel !== 'dim_date'),
      M21('region_code', 'dim_region', 'region_code', { compositeKey: 'k' }),
      M21('country_code', 'dim_region', 'country_code', { compositeKey: 'k' }),
      { fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'one-to-one', role: 'order date' },
    ],
  }]]);
}

/** What the written file means: each owner's relationships, comparable. */
export function meaning(text: string, library: Readonly<Record<string, string>> = LIBRARY): Record<string, unknown> {
  const owners = currentOwners(text, library);
  return Object.fromEntries([...owners.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, comparableRelationships(v)]));
}

export const RELATIONSHIPS_CASES: WriterCase[] = [
  relCase('a no-op (every owner listed with what it holds) is byte-identical', HAND_WRITTEN, () => ({
    owners: new Map([...currentOwners(HAND_WRITTEN)].map(([k, v]) => [k, { name: k, relationships: v }])),
  }), (out) => {
    expect(out).toBe(HAND_WRITTEN);
  }),
  relCase('a new Ref goes in at its sorted place, with real column spellings and a use line', HAND_WRITTEN, () => changed(HAND_WRITTEN, 'fct_order', (list) => [
    ...list, M21('ORDER_DATE_KEY', 'dim_date', 'Date_Key', { role: 'order date' }),
  ]), (out) => {
    expect(out).toBe(HAND_WRITTEN.replace(
      'Ref "ship date": fct_order.ship_date_key >? dim_date.date_key\n',
      'Ref "order date": fct_order.order_date_key >? dim_date.date_key\nRef "ship date": fct_order.ship_date_key >? dim_date.date_key\n',
    ));
  }),
  relCase('a composite Ref is one line, `a.(x, y) >? b.(u, v)`, and its table gets a use line in path order', HAND_WRITTEN, () => changed(HAND_WRITTEN, 'fct_order', (list) => [
    ...list,
    M21('region_code', 'dim_region', 'region_code', { compositeKey: 'fk_dim_region' }),
    M21('country_code', 'dim_region', 'country_code', { compositeKey: 'fk_dim_region' }),
  ]), (out) => {
    expect(out).toContain("use { table gold.dim_customer } from './dim_customer.dbml'\nuse { table dim_region } from './dim_region.dbml'\nuse { table fct_order } from './fct_order.dbml'\n");
    expect(out).toContain('Ref: fct_order.(region_code, country_code) >? dim_region.(region_code, country_code)\n');
    // No Ref after it in the (unsorted) file has a greater key, so it goes after the last one.
    expect(out.endsWith('Ref: fct_order.(region_code, country_code) >? dim_region.(region_code, country_code)\n')).toBe(true);
  }),
  relCase('a bare `-` whose foreign key is its first end (the keys decide, §2.3) keeps its bytes when its owner is listed', `use { table fct_order } from './fct_order.dbml'
use { table gold.dim_customer } from './dim_customer.dbml'

Ref: fct_order.Customer_Key - gold.dim_customer.customer_key
`, () => ({
    owners: new Map([['fct_order', { name: 'fct_order', relationships: [{ fromColumn: 'Customer_Key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' }] }]]),
  }), (out) => {
    expect(out).toBe(`use { table fct_order } from './fct_order.dbml'
use { table gold.dim_customer } from './dim_customer.dbml'

Ref: fct_order.Customer_Key - gold.dim_customer.customer_key
`);
  }),
  relCase('a Ref inserted into an unsorted file goes before the first Ref whose key is greater', `use { table fct_order } from './fct_order.dbml'
use { table dim_date } from '../dim_date.dbml'

Ref: fct_order.ship_date_key >? dim_date.date_key
Ref: fct_order.order_date_key >? dim_date.date_key
`, () => ({
    owners: new Map([['bridge', { name: 'bridge', relationships: [{ fromColumn: 'a_key', toModel: 'fct_order', toColumn: 'order_id', cardinality: 'many-to-many' }] }]]),
  }), (out) => {
    expect(out).toBe(`use { table bridge } from './bridge.dbml'
use { table fct_order } from './fct_order.dbml'
use { table dim_date } from '../dim_date.dbml'

Ref: bridge.a_key <>? fct_order.order_id
Ref: fct_order.ship_date_key >? dim_date.date_key
Ref: fct_order.order_date_key >? dim_date.date_key
`);
  }),
  relCase('a changed cardinality is rewritten in place, keeping the settings and the trailing comment', HAND_WRITTEN, () => changed(HAND_WRITTEN, 'fct_order', (list) =>
    list.map((r) => (r.toModel === 'dim_customer' ? { ...r, cardinality: 'one-to-one' } : r))), (out) => {
    expect(out).toBe(HAND_WRITTEN.replace(
      'Ref: fct_order.Customer_Key > gold.dim_customer.customer_key [delete: cascade] // keep me',
      'Ref: gold.dim_customer.customer_key ?- fct_order.Customer_Key [delete: cascade] // keep me',
    ));
  }),
  relCase('a changed role is rewritten in place', HAND_WRITTEN, () => changed(HAND_WRITTEN, 'fct_order', (list) =>
    list.map((r) => (r.toModel === 'dim_date' ? { ...r, role: 'shipped' } : r))), (out) => {
    expect(out).toBe(HAND_WRITTEN.replace('Ref "ship date": fct_order.ship_date_key >? dim_date.date_key', 'Ref shipped: fct_order.ship_date_key >? dim_date.date_key'));
  }),
  relCase('a removed Ref is cut (its comment above stays), and its table\'s use line goes when no Ref names it', HAND_WRITTEN, () => changed(HAND_WRITTEN, 'fct_order', (list) =>
    list.filter((r) => r.toModel !== 'dim_date')), (out) => {
    expect(out).toBe(HAND_WRITTEN
      .replace("use { table dim_date } from '../dim_date.dbml'\n", '')
      .replace('Ref "ship date": fct_order.ship_date_key >? dim_date.date_key\n', ''));
  }),
  relCase('owners not listed keep their Refs byte for byte, the bare `-` included', HAND_WRITTEN, () => changed(HAND_WRITTEN, 'fct_order', () => []), (out) => {
    expect(out).toBe(`// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.
use { table gold.dim_customer } from './dim_customer.dbml'
use { table customer_profile } from './customer_profile.dbml'

// the customer of an order
Ref: gold.dim_customer.customer_key - customer_profile.customer_key
`);
  }),
  relCase('a file left with no Refs keeps its header and comments and loses its use lines (never deleted)', HAND_WRITTEN, () => ({
    owners: new Map([['fct_order', null], ['customer_profile', null]]),
  }), (out) => {
    expect(out).toBe(`// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.

// the customer of an order
`);
  }),
  relCase('hand-added and missing use lines are left alone when their table is not in the edit (Law 1)', `use { table bridge } from './bridge.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: fct_order.ship_date_key >? dim_date.date_key
Ref: customer_profile.customer_key >? gold.dim_customer.customer_key
`, () => ({
    owners: new Map([['customer_profile', { name: 'customer_profile', relationships: [M21('customer_key', 'dim_customer', 'customer_key', { role: 'profile of' })] }]]),
  }), (out) => {
    // dim_date's use line stays missing and bridge's extra one stays; the edited Ref's tables get theirs.
    expect(out).toBe(`use { table bridge } from './bridge.dbml'
use { table customer_profile } from './customer_profile.dbml'
use { table gold.dim_customer } from './dim_customer.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: fct_order.ship_date_key >? dim_date.date_key
Ref "profile of": customer_profile.customer_key >? gold.dim_customer.customer_key
`);
  }),
  relCase('the use block of a file with none goes after a header comment followed by a blank line', `// my header

Ref: fct_order.order_date_key >? dim_date.date_key
`, () => ({
    owners: new Map([['customer_profile', { name: 'customer_profile', relationships: [M21('customer_key', 'dim_customer', 'customer_key')] }]]),
  }), (out) => {
    expect(out).toBe(`// my header
use { table customer_profile } from './customer_profile.dbml'
use { table gold.dim_customer } from './dim_customer.dbml'

Ref: customer_profile.customer_key >? gold.dim_customer.customer_key
Ref: fct_order.order_date_key >? dim_date.date_key
`);
  }),
  relCase('…and at offset 0 when the comment runs straight into the first Ref', `// about this Ref
Ref: fct_order.order_date_key >? dim_date.date_key
`, () => ({
    owners: new Map([['customer_profile', { name: 'customer_profile', relationships: [M21('customer_key', 'dim_customer', 'customer_key')] }]]),
  }), (out) => {
    expect(out).toBe(`use { table customer_profile } from './customer_profile.dbml'
use { table gold.dim_customer } from './dim_customer.dbml'

Ref: customer_profile.customer_key >? gold.dim_customer.customer_key
// about this Ref
Ref: fct_order.order_date_key >? dim_date.date_key
`);
  }),
  relCase('one-to-one writes the foreign key second with `?-`; many-to-many `<>?`', null, () => ({
    owners: new Map([
      ['customer_profile', { name: 'customer_profile', relationships: [{ fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' }] }],
      ['bridge', { name: 'bridge', relationships: [{ fromColumn: 'b_key', toModel: 'fct_order', toColumn: 'order_id', cardinality: 'many-to-many' }] }],
    ]),
  }), (out) => {
    expect(out).toContain('Ref: bridge.b_key <>? fct_order.order_id\n');
    expect(out).toContain('Ref: gold.dim_customer.customer_key ?- customer_profile.customer_key\n');
  }),
  relCase('a one-to-many is stored canonically, as many-to-one from the other end', null, () => ({
    owners: new Map([['dim_date', { name: 'dim_date', relationships: [{ fromColumn: 'date_key', toModel: 'fct_order', toColumn: 'order_date_key', cardinality: 'one-to-many' }] }]]),
  }), (out) => {
    expect(out).toContain('Ref: fct_order.order_date_key >? dim_date.date_key\n');
  }),
  relCase('a new file from null: the header, sorted selective use lines, sorted Refs', null, () => ({
    owners: new Map([['fct_order', { name: 'fct_order', relationships: [
      M21('ship_date_key', 'dim_date', 'date_key', { role: 'ship date' }),
      M21('customer_key', 'dim_customer', 'customer_key'),
      M21('order_date_key', 'dim_date', 'date_key', { role: 'order date' }),
    ] }]]),
  }), (out) => {
    expect(out).toBe(`// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.
use { table dim_date } from '../dim_date.dbml'
use { table gold.dim_customer } from './dim_customer.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: fct_order.Customer_Key >? gold.dim_customer.customer_key
Ref "order date": fct_order.order_date_key >? dim_date.date_key
Ref "ship date": fct_order.ship_date_key >? dim_date.date_key
`);
  }),
  {
    name: 'an owner rename re-spells its Refs in place and rewrites the use line\'s specifier and path',
    run: (): WriterOutcome => {
      const owners = currentOwners(HAND_WRITTEN);
      const output = relEdit(HAND_WRITTEN, {
        owners: new Map([['fct_order_line', { name: 'fct_order_line', relationships: owners.get('fct_order')! }]]),
        renamedOwners: new Map([['fct_order', 'fct_order_line']]),
        pathChanged: new Set(['fct_order']),
      }, RENAMED_LIBRARY);
      // The input is the file before the rename, with the library before it.
      return { path: REL_PATH, output, context: { ...RENAMED_LIBRARY }, parsers: ['9.1.1', '10.3.1', '11.0.0'] };
    },
    check: (o) => {
      expect(o.output).toBe(HAND_WRITTEN
        .replace("use { table fct_order } from './fct_order.dbml'", "use { table fct_order_line } from './fct_order_line.dbml'")
        .replace('Ref: fct_order.Customer_Key', 'Ref: fct_order_line.Customer_Key')
        .replace('Ref "ship date": fct_order.ship_date_key', 'Ref "ship date": fct_order_line.ship_date_key'));
    },
  },
  {
    name: 'an owner moved out of the folder takes its Refs with it',
    run: (): WriterOutcome => {
      const output = relEdit(HAND_WRITTEN, { owners: new Map([['fct_order', null]]), pathChanged: new Set(['fct_order']) });
      return { path: REL_PATH, input: HAND_WRITTEN, output, context: { ...LIBRARY } };
    },
    check: (o) => {
      expect(o.output).not.toContain('fct_order');
      expect(o.output).toContain('Ref: gold.dim_customer.customer_key - customer_profile.customer_key');
    },
  },
  {
    name: 'an incoming Ref keeps `[delete: cascade]`, its `?` marks and its trailing comment',
    run: (): WriterOutcome => {
      const incoming = 'Ref: fct_order.ship_date_key > dim_date.date_key [delete: cascade] // moved here';
      const output = relEdit('// header\n', {
        owners: new Map([['fct_order', { name: 'fct_order', relationships: [M21('ship_date_key', 'dim_date', 'date_key')] }]]),
        incoming: [{ text: incoming, unit: { from: 'fct_order', to: 'dim_date', fromColumns: ['ship_date_key'], toColumns: ['date_key'], cardinality: 'many-to-one' } }],
      });
      return { path: REL_PATH, input: '// header\n', output, context: { ...LIBRARY } };
    },
    check: (o) => {
      expect(o.output).toBe("// header\nuse { table dim_date } from '../dim_date.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\nRef: fct_order.ship_date_key > dim_date.date_key [delete: cascade] // moved here\n");
    },
  },
  {
    name: 'an incoming Ref whose owner was renamed is re-spelled only at that end',
    run: (): WriterOutcome => {
      const incoming = 'Ref: fct_order.ship_date_key >? dim_date.date_key [delete: cascade] // moved';
      const output = relEdit(null, {
        owners: new Map([['fct_order_line', { name: 'fct_order_line', relationships: [M21('ship_date_key', 'dim_date', 'date_key')] }]]),
        renamedOwners: new Map([['fct_order', 'fct_order_line']]),
        incoming: [{ text: incoming, unit: { from: 'fct_order', to: 'dim_date', fromColumns: ['ship_date_key'], toColumns: ['date_key'], cardinality: 'many-to-one' } }],
      }, RENAMED_LIBRARY);
      return { path: REL_PATH, input: null, output, context: { ...RENAMED_LIBRARY } };
    },
    check: (o) => {
      expect(o.output).toContain('Ref: fct_order_line.ship_date_key >? dim_date.date_key [delete: cascade] // moved\n');
    },
  },
  // --- Round 1 review: link identity, moves, block form, owner keys -------------------
  relCase('a composite listed with its pairs in another order is the same Ref: its bytes stay', COMPOSITE_REF, () => {
    const list = currentOwners(COMPOSITE_REF).get('fct_order')!;
    return { owners: new Map([['fct_order', { name: 'fct_order', relationships: [...list].reverse() }]]) };
  }, (out) => {
    expect(out).toBe(COMPOSITE_REF);
  }),
  relCase('…and a cardinality change on it keeps the file\'s pair order, settings and comment', COMPOSITE_REF, () => {
    const list = currentOwners(COMPOSITE_REF).get('fct_order')!;
    return { owners: new Map([['fct_order', { name: 'fct_order', relationships: [...list].reverse().map((r) => ({ ...r, cardinality: 'many-to-many' as const })) }]]) };
  }, (out) => {
    expect(out).toBe(COMPOSITE_REF.replace(') > dim_region.', ') <>? dim_region.'));
  }),
  {
    name: 'a Ref regenerated with a renamed end moves to its sorted place, with its trailing comment',
    run: (): WriterOutcome => {
      const output = relEdit(SORTED_FOR_RENAME, {
        owners: new Map([['zz_bridge', { name: 'zz_bridge', relationships: [M21('a_key', 'dim_date', 'date_key', { role: 'r' })] }]]),
        renamedOwners: new Map([['bridge', 'zz_bridge']]),
        pathChanged: new Set(['bridge']),
      }, BRIDGE_RENAMED);
      return { path: REL_PATH, output, context: { ...BRIDGE_RENAMED }, parsers: ['9.1.1', '10.3.1', '11.0.0'] };
    },
    check: (o) => {
      expect(o.output).toBe(`use { table zz_bridge } from './zz_bridge.dbml'
use { table customer_profile } from './customer_profile.dbml'
use { table dim_date } from '../dim_date.dbml'

Ref: customer_profile.customer_key >? dim_date.date_key
Ref r: zz_bridge.a_key >? dim_date.date_key // a tail
`);
    },
  },
  relCase('a block-form Ref whose cardinality changes keeps its block and the comments in it', BLOCK_REF, () => changed(BLOCK_REF, 'fct_order', (list) =>
    list.map((r) => ({ ...r, cardinality: 'many-to-many' as const }))), (out) => {
    expect(out).toBe(BLOCK_REF.replace('fct_order.Customer_Key > gold.dim_customer', 'fct_order.Customer_Key <>? gold.dim_customer'));
  }),
  relCase('…and a role change on it splices only its name', BLOCK_REF, () => changed(BLOCK_REF, 'fct_order', (list) =>
    list.map((r) => ({ ...r, role: 'the customer' }))), (out) => {
    expect(out).toBe(BLOCK_REF.replace('Ref fk {', 'Ref "the customer" {').replace(' > gold.', ' >? gold.'));
  }),
  relCase('…or removes it', BLOCK_REF, () => changed(BLOCK_REF, 'fct_order', (list) =>
    list.map((r) => { const { role: _role, ...rest } = r; return rest; })), (out) => {
    expect(out).toBe(BLOCK_REF.replace('Ref fk {', 'Ref {').replace(' > gold.', ' >? gold.'));
  }),
  {
    name: 'a renamed owner keyed by its old name is read through renamedOwners',
    run: (): WriterOutcome => {
      const owners = currentOwners(HAND_WRITTEN);
      const output = relEdit(HAND_WRITTEN, {
        owners: new Map([['fct_order', { name: 'fct_order_line', relationships: owners.get('fct_order')! }]]),
        renamedOwners: new Map([['fct_order', 'fct_order_line']]),
        pathChanged: new Set(['fct_order']),
      }, RENAMED_LIBRARY);
      return { path: REL_PATH, output, context: { ...RENAMED_LIBRARY }, parsers: ['9.1.1', '10.3.1', '11.0.0'] };
    },
    check: (o) => {
      expect(o.output).toBe(HAND_WRITTEN
        .replace("use { table fct_order } from './fct_order.dbml'", "use { table fct_order_line } from './fct_order_line.dbml'")
        .replace('Ref: fct_order.Customer_Key', 'Ref: fct_order_line.Customer_Key')
        .replace('Ref "ship date": fct_order.ship_date_key', 'Ref "ship date": fct_order_line.ship_date_key'));
    },
  },
  relCase('a listed owner\'s one-to-many record matches the Ref stored from the other end', HAND_WRITTEN, () => ({
    owners: new Map([['dim_date', { name: 'dim_date', relationships: [{ fromColumn: 'date_key', toModel: 'fct_order', toColumn: 'ship_date_key', cardinality: 'one-to-many', role: 'ship date' }] }]]),
  }), (out) => {
    expect(out).toBe(HAND_WRITTEN);
  }),
  {
    name: 'a bare `-` whose foreign key is its first end keeps its bytes when the resolver gives no keys',
    run: (): WriterOutcome => {
      const resolve = relationshipsResolver(libraryOf(LIBRARY));
      const output = editRelationshipsDbml(FK_FIRST, {
        filePath: REL_PATH,
        owners: new Map([['fct_order', { name: 'fct_order', relationships: [{ fromColumn: 'Customer_Key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' }] }]]),
        resolve: (name) => { const t = resolve(name); if (!t) return t; const { primaryKey: _pk, ...rest } = t; return rest; },
      });
      return { path: REL_PATH, input: FK_FIRST, output, context: { ...LIBRARY } };
    },
    check: (o) => { expect(o.output).toBe(FK_FIRST); },
  },

  // --- Laws and file shapes -------------------------------------------------------
  {
    name: 'reads back as the relationships it was given (Law 3) and is idempotent (Law 2)',
    run: (): WriterOutcome => ({ path: REL_PATH, input: HAND_WRITTEN, output: relEdit(HAND_WRITTEN, { owners: lawOwners() }), context: { ...LIBRARY } }),
    check: (o) => {
      const desired = lawOwners();
      expect(comparableRelationships(currentOwners(o.output).get('fct_order'))).toEqual(comparableRelationships(desired.get('fct_order')!.relationships));
      expect(relEdit(o.output, { owners: desired })).toBe(o.output);
      // Owners the edit did not list read as before.
      expect(meaning(o.output).customer_profile).toEqual(meaning(HAND_WRITTEN).customer_profile);
    },
  },
  {
    name: 'a byte-order mark and CRLF line endings are kept',
    run: (): WriterOutcome => {
      const crlf = `﻿${HAND_WRITTEN.replace(/\n/g, '\r\n')}`;
      const output = relEdit(crlf, { owners: new Map([['bridge', { name: 'bridge', relationships: [M21('a_key', 'dim_date', 'date_key')] }]]) });
      return { path: REL_PATH, input: crlf, output, context: { ...LIBRARY } };
    },
    check: (o) => {
      expect(o.output.startsWith('﻿')).toBe(true);
      expect(o.output.replace(/\r\n/g, '')).not.toContain('\n');
      expect(o.output).toContain('Ref: bridge.a_key >? dim_date.date_key\r\n');
    },
  },

  // --- Pending relationships (D27) --------------------------------------------------------
  relCase('a pending line stays byte for byte while its relationship is still wanted and cannot be live', PENDING_FILE, () => changed(PENDING_FILE, 'fct_order', (list) => list), (out) => {
    expect(out).toBe(PENDING_FILE);
  }),
  relCase('a pending line goes when its owner is listed without it; another owner\'s stays', PENDING_FILE,
    () => changed(PENDING_FILE, 'fct_order', (list) => list.filter((r) => r.toModel !== 'dim_missing')), (out) => {
      expect(out).toBe(PENDING_FILE.replace('// erd-studio pending: Ref: fct_order.order_date_key >? dim_missing.date_key\n', ''));
    }),
  relCase('a pending line becomes a live Ref (with its use line) once both ends have files with those columns', PENDING_FILE,
    () => changed(PENDING_FILE, 'fct_order', (list) => list, WITH_DIM_MISSING), (out) => {
      expect(out).toBe([
        "use { table dim_missing } from '../dim_missing.dbml'",
        "use { table gold.dim_customer } from './dim_customer.dbml'",
        "use { table fct_order } from './fct_order.dbml'",
        '',
        'Ref: fct_order.Customer_Key >? gold.dim_customer.customer_key',
        'Ref: fct_order.order_date_key >? dim_missing.date_key',
        '',
        '// erd-studio pending: Ref: customer_profile.customer_key >? dim_gone.k',
        '',
      ].join('\n'));
    }, WITH_DIM_MISSING),
  {
    name: 'writePending (Convert): a new relationship that cannot be live is written as a pending line, after the Refs',
    run: (): WriterOutcome => ({
      path: REL_PATH,
      input: null,
      output: relEdit(null, {
        owners: new Map([['fct_order', { name: 'fct_order', relationships: [M21('Customer_Key', 'dim_customer', 'customer_key'), M21('order_date_key', 'dim_missing', 'date_key')] }]]),
        writePending: true,
      }),
      context: { ...LIBRARY },
    }),
    check: (o) => {
      expect(o.output).toBe([
        '// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.',
        "use { table gold.dim_customer } from './dim_customer.dbml'",
        "use { table fct_order } from './fct_order.dbml'",
        '',
        'Ref: fct_order.Customer_Key >? gold.dim_customer.customer_key',
        '',
        '// erd-studio pending: Ref: fct_order.order_date_key >? dim_missing.date_key',
        '',
      ].join('\n'));
    },
  },
];
