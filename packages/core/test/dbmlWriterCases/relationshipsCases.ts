/**
 * The relationships-file writer cases (§9.3 `dbmlWriteRelationships`): each
 * one edits (or creates) `gold/relationships/gold.dbml` against a small
 * layer-first library (gold's tables in `gold/tables/gold/`, `dim_date` in
 * `silver/tables/shared/`, every Table qualified) and checks the text. `dbmlWriteRelationships.test.ts` runs the
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

export const REL_PATH = 'gold/relationships/gold.dbml';

/** The library the cases resolve against: a schema-qualified table, real column spellings that differ in case, a composite key. */
export const LIBRARY: Readonly<Record<string, string>> = {
  'silver/tables/shared/dim_date.dbml': 'Table shared.dim_date {\n  date_key int [pk]\n}\n',
  'gold/tables/gold/dim_customer.dbml': 'Table gold.dim_customer {\n  customer_key int [pk]\n  parent_key int\n}\n',
  'gold/tables/gold/dim_region.dbml': 'Table gold.dim_region {\n  region_code varchar\n  country_code varchar\n  indexes {\n    (region_code, country_code) [pk]\n  }\n}\n',
  'gold/tables/gold/fct_order.dbml': 'Table gold.fct_order {\n  order_id int [pk]\n  Customer_Key int\n  region_code varchar\n  country_code varchar\n  order_date_key int\n  ship_date_key int\n}\n',
  'gold/tables/gold/customer_profile.dbml': 'Table gold.customer_profile {\n  customer_key int [pk]\n}\n',
  'gold/tables/gold/bridge.dbml': 'Table gold.bridge {\n  a_key int\n  b_key int\n}\n',
};

/** The library with `fct_order` renamed to `fct_order_line`. */
export const RENAMED_LIBRARY: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = { ...LIBRARY };
  delete out['gold/tables/gold/fct_order.dbml'];
  out['gold/tables/gold/fct_order_line.dbml'] = LIBRARY['gold/tables/gold/fct_order.dbml'].replace('Table gold.fct_order', 'Table gold.fct_order_line');
  return out;
})();

/** A hand-written file: a header comment, extra and unsorted lines, settings, marks and comments. */
export const HAND_WRITTEN = `// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.
use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'

// the customer of an order
Ref: gold.fct_order.Customer_Key > gold.dim_customer.customer_key [delete: cascade] // keep me
Ref "ship date": gold.fct_order.ship_date_key >? shared.dim_date.date_key

Ref: gold.dim_customer.customer_key - gold.customer_profile.customer_key
`;

/** A 1.9.x relationships file: the Refs of every table run together, with no blank line between tables. */
const OLD_LAYOUT = `use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'

Ref: gold.customer_profile.customer_key >? gold.dim_customer.customer_key
// the parent
Ref: gold.dim_customer.parent_key >? gold.dim_customer.customer_key
Ref: gold.fct_order.Customer_Key >? gold.dim_customer.customer_key
`;

/** A composite Ref with settings and a trailing comment. */
const COMPOSITE_REF = `use { table gold.dim_region } from '../tables/gold/dim_region.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'

Ref: gold.fct_order.(region_code, country_code) > gold.dim_region.(region_code, country_code) [delete: cascade] // keep
`;

/** A block-form Ref with a comment inside. */
const BLOCK_REF = `use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'

Ref fk {
  // explain
  gold.fct_order.Customer_Key > gold.dim_customer.customer_key [delete: cascade]
}
`;

/** A bare \`-\` written foreign key first. */
const FK_FIRST = `use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'

Ref: gold.fct_order.Customer_Key - gold.dim_customer.customer_key
`;

/** Two sorted Refs; renaming bridge to zz_bridge puts its Ref last. */
const SORTED_FOR_RENAME = `use { table gold.bridge } from '../tables/gold/bridge.dbml'
use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'
use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'

Ref: gold.bridge.a_key >? shared.dim_date.date_key // a tail
Ref: gold.customer_profile.customer_key >? shared.dim_date.date_key
`;

/** The library with \`bridge\` renamed to \`zz_bridge\`. */
const BRIDGE_RENAMED: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = { ...LIBRARY };
  delete out['gold/tables/gold/bridge.dbml'];
  out['gold/tables/gold/zz_bridge.dbml'] = LIBRARY['gold/tables/gold/bridge.dbml'].replace('Table gold.bridge', 'Table gold.zz_bridge');
  return out;
})();

/** The library with `fct_order` moved to silver's `sales` schema and `dim_customer` to gold's (a requalifying move each). */
const REQUALIFIED_LIBRARY: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = { ...LIBRARY };
  delete out['gold/tables/gold/fct_order.dbml'];
  delete out['gold/tables/gold/dim_customer.dbml'];
  out['silver/tables/sales/fct_order.dbml'] = LIBRARY['gold/tables/gold/fct_order.dbml'].replace('Table gold.fct_order', 'Table sales.fct_order');
  out['gold/tables/sales/dim_customer.dbml'] = LIBRARY['gold/tables/gold/dim_customer.dbml'].replace('Table gold.dim_customer', 'Table sales.dim_customer');
  return out;
})();

/** A file with a hand-added `use` line no Ref needs (bridge's). */
const STALE_USE = `use { table gold.bridge } from '../tables/gold/bridge.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'

Ref: gold.fct_order.Customer_Key >? gold.dim_customer.customer_key
`;

/** The library with `bridge` moved to the silver layer (same schema). */
const BRIDGE_MOVED: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = { ...LIBRARY };
  out['silver/tables/gold/bridge.dbml'] = out['gold/tables/gold/bridge.dbml'];
  delete out['gold/tables/gold/bridge.dbml'];
  return out;
})();

/** The library with `bridge` deleted. */
const BRIDGE_DELETED: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = { ...LIBRARY };
  delete out['gold/tables/gold/bridge.dbml'];
  return out;
})();

/** A file under the 1.9 pre-release's header line. */
const HEADER_19 = `// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'

Ref: gold.fct_order.Customer_Key >? gold.dim_customer.customer_key
`;

/** A relationships file with a live Ref and two pending lines (D27): one to a table with no file, one from another owner. */
export const PENDING_FILE = `use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'

Ref: gold.fct_order.Customer_Key >? gold.dim_customer.customer_key

// erd-studio pending: Ref: gold.fct_order.order_date_key >? dim_missing.date_key
// erd-studio pending: Ref: gold.customer_profile.customer_key >? dim_gone.k
`;

/** A pending line to a column its target table does not have. */
const PENDING_TO_COLUMN = `use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'

Ref: gold.customer_profile.customer_key >? gold.dim_customer.customer_key

// erd-studio pending: Ref: gold.customer_profile.customer_key >? shared.dim_date.nope
`;

/** The library with \`dim_date\` renamed to \`dim_day\`. */
const DIM_DAY_LIBRARY: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = { ...LIBRARY };
  delete out['silver/tables/shared/dim_date.dbml'];
  out['silver/tables/shared/dim_day.dbml'] = LIBRARY['silver/tables/shared/dim_date.dbml'].replace('Table shared.dim_date', 'Table shared.dim_day');
  return out;
})();

/** The library with fct_order's \`order_date_key\` renamed to \`order_day_key\`. */
const ORDER_DAY_LIBRARY: Readonly<Record<string, string>> = {
  ...LIBRARY,
  'gold/tables/gold/fct_order.dbml': LIBRARY['gold/tables/gold/fct_order.dbml'].replace('order_date_key', 'order_day_key'),
};

/** The library with a file for dim_missing. */
const WITH_DIM_MISSING: Readonly<Record<string, string>> = { ...LIBRARY, 'silver/tables/shared/dim_missing.dbml': 'Table shared.dim_missing {\n  date_key int [pk]\n}\n' };

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

/** `renamed`: the input is against the library before a rename, so only the output is compiled (with `library`). */
function relCase(name: string, text: string | null, edit: () => EditInput, check: (output: string) => void, library: Readonly<Record<string, string>> = LIBRARY, renamed = false): WriterCase {
  return {
    name,
    run: (): WriterOutcome => (renamed
      ? { path: REL_PATH, output: relEdit(text, edit(), library), context: { ...library }, parsers: ['9.1.1', '10.3.1', '11.0.0'] }
      : { path: REL_PATH, input: text, output: relEdit(text, edit(), library), context: { ...library } }),
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

/** customer_profile's Refs and fct_order's, as ERD Studio writes them anew: two groups with a blank line between. */
const W3_PROFILE = [M21('customer_key', 'dim_customer', 'customer_key')];
const W3_ORDER = [M21('customer_key', 'dim_customer', 'customer_key')];
const W3_TWO_GROUPS = relEdit(null, { owners: new Map([
  ['customer_profile', { name: 'customer_profile', relationships: W3_PROFILE }],
  ['fct_order', { name: 'fct_order', relationships: W3_ORDER }],
]) });
/** A fresh render of customer_profile's `profile` list beside fct_order's one Ref. */
const w3Fresh = (profile: TableRelationship[]): string => relEdit(null, { owners: new Map([
  ['customer_profile', { name: 'customer_profile', relationships: profile }],
  ['fct_order', { name: 'fct_order', relationships: W3_ORDER }],
]) });
const W3_TO_DATE = M21('customer_key', 'dim_date', 'date_key');
const W3_TO_ORDER = M21('customer_key', 'fct_order', 'order_id');
/** W3_TWO_GROUPS with a second Ref added to the FIRST group. */
const W3_FIRST_GROUP_GROWN = relEdit(W3_TWO_GROUPS, changed(W3_TWO_GROUPS, 'customer_profile', (list) => [...list, W3_TO_DATE]));

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
      'Ref "ship date": gold.fct_order.ship_date_key >? shared.dim_date.date_key\n',
      'Ref "order date": gold.fct_order.order_date_key >? shared.dim_date.date_key\nRef "ship date": gold.fct_order.ship_date_key >? shared.dim_date.date_key\n',
    ));
  }),
  relCase('a composite Ref is one line, `a.(x, y) >? b.(u, v)`, and its table gets a use line in path order', HAND_WRITTEN, () => changed(HAND_WRITTEN, 'fct_order', (list) => [
    ...list,
    M21('region_code', 'dim_region', 'region_code', { compositeKey: 'fk_dim_region' }),
    M21('country_code', 'dim_region', 'country_code', { compositeKey: 'fk_dim_region' }),
  ]), (out) => {
    expect(out).toContain("use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table gold.dim_region } from '../tables/gold/dim_region.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n");
    expect(out).toContain('Ref: gold.fct_order.(region_code, country_code) >? gold.dim_region.(region_code, country_code)\n');
    // No Ref after it in the (unsorted) file has a greater key, so it goes after the last one.
    expect(out.endsWith('Ref: gold.fct_order.(region_code, country_code) >? gold.dim_region.(region_code, country_code)\n')).toBe(true);
  }),
  relCase('a bare `-` whose foreign key is its first end (the keys decide, §2.3) keeps its bytes when its owner is listed', `use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'

Ref: gold.fct_order.Customer_Key - gold.dim_customer.customer_key
`, () => ({
    owners: new Map([['fct_order', { name: 'fct_order', relationships: [{ fromColumn: 'Customer_Key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' }] }]]),
  }), (out) => {
    expect(out).toBe(`use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'

Ref: gold.fct_order.Customer_Key - gold.dim_customer.customer_key
`);
  }),
  relCase('a Ref inserted into an unsorted file goes before the first Ref whose key is greater', `use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'

Ref: gold.fct_order.ship_date_key >? shared.dim_date.date_key
Ref: gold.fct_order.order_date_key >? shared.dim_date.date_key
`, () => ({
    owners: new Map([['bridge', { name: 'bridge', relationships: [{ fromColumn: 'a_key', toModel: 'fct_order', toColumn: 'order_id', cardinality: 'many-to-many' }] }]]),
  }), (out) => {
    expect(out).toBe(`use { table gold.bridge } from '../tables/gold/bridge.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'

Ref: gold.bridge.a_key <>? gold.fct_order.order_id

Ref: gold.fct_order.ship_date_key >? shared.dim_date.date_key
Ref: gold.fct_order.order_date_key >? shared.dim_date.date_key
`);
  }),
  relCase('a changed cardinality is rewritten in place, keeping the settings and the trailing comment', HAND_WRITTEN, () => changed(HAND_WRITTEN, 'fct_order', (list) =>
    list.map((r) => (r.toModel === 'dim_customer' ? { ...r, cardinality: 'one-to-one' } : r))), (out) => {
    expect(out).toBe(HAND_WRITTEN.replace(
      'Ref: gold.fct_order.Customer_Key > gold.dim_customer.customer_key [delete: cascade] // keep me',
      'Ref: gold.dim_customer.customer_key ?- gold.fct_order.Customer_Key [delete: cascade] // keep me',
    ));
  }),
  relCase('a changed role is rewritten in place', HAND_WRITTEN, () => changed(HAND_WRITTEN, 'fct_order', (list) =>
    list.map((r) => (r.toModel === 'dim_date' ? { ...r, role: 'shipped' } : r))), (out) => {
    expect(out).toBe(HAND_WRITTEN.replace('Ref "ship date": gold.fct_order.ship_date_key >? shared.dim_date.date_key', 'Ref shipped: gold.fct_order.ship_date_key >? shared.dim_date.date_key'));
  }),
  relCase('a removed Ref is cut (its comment above stays), and its table\'s use line goes when no Ref names it', HAND_WRITTEN, () => changed(HAND_WRITTEN, 'fct_order', (list) =>
    list.filter((r) => r.toModel !== 'dim_date')), (out) => {
    expect(out).toBe(HAND_WRITTEN
      .replace("use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'\n", '')
      .replace('Ref "ship date": gold.fct_order.ship_date_key >? shared.dim_date.date_key\n', ''));
  }),
  relCase('owners not listed keep their Refs byte for byte, the bare `-` included', HAND_WRITTEN, () => changed(HAND_WRITTEN, 'fct_order', () => []), (out) => {
    expect(out).toBe(`// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'

// the customer of an order

Ref: gold.dim_customer.customer_key - gold.customer_profile.customer_key
`);
  }),
  relCase('a file left with no Refs keeps its header and comments and loses its use lines (never deleted)', HAND_WRITTEN, () => ({
    owners: new Map([['fct_order', null], ['customer_profile', null]]),
  }), (out) => {
    expect(out).toBe(`// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.

// the customer of an order

`);
  }),
  relCase('hand-added and missing use lines are left alone when their table is not in the edit (Law 1)', `use { table gold.bridge } from '../tables/gold/bridge.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'

Ref: gold.fct_order.ship_date_key >? shared.dim_date.date_key
Ref: gold.customer_profile.customer_key >? gold.dim_customer.customer_key
`, () => ({
    owners: new Map([['customer_profile', { name: 'customer_profile', relationships: [M21('customer_key', 'dim_customer', 'customer_key', { role: 'profile of' })] }]]),
  }), (out) => {
    // dim_date's use line stays missing and bridge's extra one stays; the edited Ref's tables get theirs.
    expect(out).toBe(`use { table gold.bridge } from '../tables/gold/bridge.dbml'
use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'

Ref: gold.fct_order.ship_date_key >? shared.dim_date.date_key

Ref "profile of": gold.customer_profile.customer_key >? gold.dim_customer.customer_key
`);
  }),
  relCase('the use block of a file with none goes after a header comment followed by a blank line', `// my header

Ref: gold.fct_order.order_date_key >? shared.dim_date.date_key
`, () => ({
    owners: new Map([['customer_profile', { name: 'customer_profile', relationships: [M21('customer_key', 'dim_customer', 'customer_key')] }]]),
  }), (out) => {
    expect(out).toBe(`// my header
use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'

Ref: gold.customer_profile.customer_key >? gold.dim_customer.customer_key

Ref: gold.fct_order.order_date_key >? shared.dim_date.date_key
`);
  }),
  relCase('…and at offset 0 when the comment runs straight into the first Ref', `// about this Ref
Ref: gold.fct_order.order_date_key >? shared.dim_date.date_key
`, () => ({
    owners: new Map([['customer_profile', { name: 'customer_profile', relationships: [M21('customer_key', 'dim_customer', 'customer_key')] }]]),
  }), (out) => {
    expect(out).toBe(`use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'

Ref: gold.customer_profile.customer_key >? gold.dim_customer.customer_key

// about this Ref
Ref: gold.fct_order.order_date_key >? shared.dim_date.date_key
`);
  }),
  relCase('one-to-one writes the foreign key second with `?-`; many-to-many `<>?`', null, () => ({
    owners: new Map([
      ['customer_profile', { name: 'customer_profile', relationships: [{ fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' }] }],
      ['bridge', { name: 'bridge', relationships: [{ fromColumn: 'b_key', toModel: 'fct_order', toColumn: 'order_id', cardinality: 'many-to-many' }] }],
    ]),
  }), (out) => {
    expect(out).toContain('Ref: gold.bridge.b_key <>? gold.fct_order.order_id\n');
    expect(out).toContain('Ref: gold.dim_customer.customer_key ?- gold.customer_profile.customer_key\n');
  }),
  relCase('a one-to-many is stored canonically, as many-to-one from the other end', null, () => ({
    owners: new Map([['dim_date', { name: 'dim_date', relationships: [{ fromColumn: 'date_key', toModel: 'fct_order', toColumn: 'order_date_key', cardinality: 'one-to-many' }] }]]),
  }), (out) => {
    expect(out).toContain('Ref: gold.fct_order.order_date_key >? shared.dim_date.date_key\n');
  }),
  relCase('a new file from null: the header, sorted selective use lines, sorted Refs', null, () => ({
    owners: new Map([['fct_order', { name: 'fct_order', relationships: [
      M21('ship_date_key', 'dim_date', 'date_key', { role: 'ship date' }),
      M21('customer_key', 'dim_customer', 'customer_key'),
      M21('order_date_key', 'dim_date', 'date_key', { role: 'order date' }),
    ] }]]),
  }), (out) => {
    expect(out).toBe(`// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.
use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'

Ref: gold.fct_order.Customer_Key >? gold.dim_customer.customer_key
Ref "order date": gold.fct_order.order_date_key >? shared.dim_date.date_key
Ref "ship date": gold.fct_order.ship_date_key >? shared.dim_date.date_key
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
        .replace("use { table gold.fct_order } from '../tables/gold/fct_order.dbml'", "use { table gold.fct_order_line } from '../tables/gold/fct_order_line.dbml'")
        .replace('Ref: gold.fct_order.Customer_Key', 'Ref: gold.fct_order_line.Customer_Key')
        .replace('Ref "ship date": gold.fct_order.ship_date_key', 'Ref "ship date": gold.fct_order_line.ship_date_key'));
    },
  },
  {
    name: 'an owner listed with null loses its Refs here, and its use line with them, even when its path changed (§1.3: a line per table a Ref names)',
    run: (): WriterOutcome => {
      const output = relEdit(HAND_WRITTEN, { owners: new Map([['fct_order', null]]), pathChanged: new Set(['fct_order']) });
      return { path: REL_PATH, input: HAND_WRITTEN, output, context: { ...LIBRARY } };
    },
    check: (o) => {
      expect(o.output).not.toContain('fct_order');
      expect(o.output).toContain('Ref: gold.dim_customer.customer_key - gold.customer_profile.customer_key');
    },
  },

  // --- The layer-first tree (§1.3): moves to another schema, stale use lines, the header -------
  {
    name: 'a requalify (a move to another schema) re-spells owner and target ends in place, and their use lines',
    run: (): WriterOutcome => {
      const output = relEdit(HAND_WRITTEN, {
        owners: new Map(),
        requalified: new Set(['fct_order', 'dim_customer']),
        pathChanged: new Set(['fct_order', 'dim_customer']),
      }, REQUALIFIED_LIBRARY);
      // The input names the tables where they were, so only the output is compiled (with the library after).
      return { path: REL_PATH, output, context: { ...REQUALIFIED_LIBRARY }, parsers: ['9.1.1', '10.3.1', '11.0.0'] };
    },
    check: (o) => {
      expect(o.output).toBe(HAND_WRITTEN
        .replace("use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'", "use { table sales.dim_customer } from '../tables/sales/dim_customer.dbml'")
        .replace("use { table gold.fct_order } from '../tables/gold/fct_order.dbml'", "use { table sales.fct_order } from '../../silver/tables/sales/fct_order.dbml'")
        .replace('Ref: gold.fct_order.Customer_Key > gold.dim_customer.customer_key [delete: cascade] // keep me', 'Ref: sales.fct_order.Customer_Key > sales.dim_customer.customer_key [delete: cascade] // keep me')
        .replace('Ref "ship date": gold.fct_order.ship_date_key', 'Ref "ship date": sales.fct_order.ship_date_key')
        .replace('Ref: gold.dim_customer.customer_key - gold.customer_profile', 'Ref: sales.dim_customer.customer_key - gold.customer_profile'));
      // What the file means is unchanged: ends are matched by name.
      expect(meaning(o.output, REQUALIFIED_LIBRARY)).toEqual(meaning(HAND_WRITTEN));
    },
  },
  relCase('a stale use line no Ref needs is rewritten when its table moves (filesUsing)', STALE_USE, () => ({
    owners: new Map(),
    pathChanged: new Set(['bridge']),
  }), (out) => {
    expect(out).toBe(STALE_USE.replace("use { table gold.bridge } from '../tables/gold/bridge.dbml'", "use { table gold.bridge } from '../../silver/tables/gold/bridge.dbml'"));
  }, BRIDGE_MOVED, true),
  ...(['bridge', 'zz_bridge'] as const).map((key) => relCase(
    `a stale use line no Ref needs is rewritten when its table is renamed (pathChanged names it ${key === 'bridge' ? 'by its old name' : 'by its new name'})`,
    STALE_USE,
    () => ({ owners: new Map(), renamedOwners: new Map([['bridge', 'zz_bridge']]), pathChanged: new Set([key]) }),
    (out) => {
      expect(out).toBe(STALE_USE.replace("use { table gold.bridge } from '../tables/gold/bridge.dbml'", "use { table gold.zz_bridge } from '../tables/gold/zz_bridge.dbml'"));
    },
    BRIDGE_RENAMED,
    true,
  )),
  relCase('…and cut when its table is deleted', STALE_USE, () => ({
    owners: new Map(),
    pathChanged: new Set(['bridge']),
  }), (out) => {
    expect(out).toBe(STALE_USE.replace("use { table gold.bridge } from '../tables/gold/bridge.dbml'\n", ''));
  }, BRIDGE_DELETED, true),
  relCase('a use line added above the first one goes below a 1.9 header too (the header floor is the prefix)', HEADER_19, () => changed(HEADER_19, 'fct_order', (list) => [
    ...list, M21('order_date_key', 'dim_date', 'date_key'),
  ]), (out) => {
    expect(out).toBe(HEADER_19
      .replace('here.\n', "here.\nuse { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'\n")
      .replace('customer_key\n', 'customer_key\nRef: gold.fct_order.order_date_key >? shared.dim_date.date_key\n'));
  }),
  {
    name: 'an incoming Ref keeps `[delete: cascade]`, its `?` marks and its trailing comment',
    run: (): WriterOutcome => {
      const incoming = 'Ref: gold.fct_order.ship_date_key > shared.dim_date.date_key [delete: cascade] // moved here';
      const output = relEdit('// header\n', {
        owners: new Map([['fct_order', { name: 'fct_order', relationships: [M21('ship_date_key', 'dim_date', 'date_key')] }]]),
        incoming: [{ text: incoming, unit: { from: 'fct_order', to: 'dim_date', fromColumns: ['ship_date_key'], toColumns: ['date_key'], cardinality: 'many-to-one' } }],
      });
      return { path: REL_PATH, input: '// header\n', output, context: { ...LIBRARY } };
    },
    check: (o) => {
      expect(o.output).toBe("// header\nuse { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nRef: gold.fct_order.ship_date_key > shared.dim_date.date_key [delete: cascade] // moved here\n");
    },
  },
  {
    name: 'an incoming Ref whose owner was renamed is re-spelled only at that end',
    run: (): WriterOutcome => {
      const incoming = 'Ref: gold.fct_order.ship_date_key >? shared.dim_date.date_key [delete: cascade] // moved';
      const output = relEdit(null, {
        owners: new Map([['fct_order_line', { name: 'fct_order_line', relationships: [M21('ship_date_key', 'dim_date', 'date_key')] }]]),
        renamedOwners: new Map([['fct_order', 'fct_order_line']]),
        incoming: [{ text: incoming, unit: { from: 'fct_order', to: 'dim_date', fromColumns: ['ship_date_key'], toColumns: ['date_key'], cardinality: 'many-to-one' } }],
      }, RENAMED_LIBRARY);
      return { path: REL_PATH, input: null, output, context: { ...RENAMED_LIBRARY } };
    },
    check: (o) => {
      expect(o.output).toContain('Ref: gold.fct_order_line.ship_date_key >? shared.dim_date.date_key [delete: cascade] // moved\n');
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
    expect(out).toBe(COMPOSITE_REF.replace(') > gold.dim_region.', ') <>? gold.dim_region.'));
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
      expect(o.output).toBe(`use { table gold.zz_bridge } from '../tables/gold/zz_bridge.dbml'
use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'
use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'

Ref: gold.customer_profile.customer_key >? shared.dim_date.date_key

Ref r: gold.zz_bridge.a_key >? shared.dim_date.date_key // a tail
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
        .replace("use { table gold.fct_order } from '../tables/gold/fct_order.dbml'", "use { table gold.fct_order_line } from '../tables/gold/fct_order_line.dbml'")
        .replace('Ref: gold.fct_order.Customer_Key', 'Ref: gold.fct_order_line.Customer_Key')
        .replace('Ref "ship date": gold.fct_order.ship_date_key', 'Ref "ship date": gold.fct_order_line.ship_date_key'));
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
      expect(o.output).toContain('Ref: gold.bridge.a_key >? shared.dim_date.date_key\r\n');
    },
  },

  // --- Pending relationships (D27) --------------------------------------------------------
  relCase('a pending line stays byte for byte while its relationship is still wanted and cannot be live', PENDING_FILE, () => changed(PENDING_FILE, 'fct_order', (list) => list), (out) => {
    expect(out).toBe(PENDING_FILE);
  }),
  relCase('a pending line goes when its owner is listed without it; another owner\'s stays', PENDING_FILE,
    () => changed(PENDING_FILE, 'fct_order', (list) => list.filter((r) => r.toModel !== 'dim_missing')), (out) => {
      expect(out).toBe(PENDING_FILE.replace('// erd-studio pending: Ref: gold.fct_order.order_date_key >? dim_missing.date_key\n', ''));
    }),
  relCase('a pending line becomes a live Ref (with its use line) once both ends have files with those columns', PENDING_FILE,
    () => changed(PENDING_FILE, 'fct_order', (list) => list, WITH_DIM_MISSING), (out) => {
      expect(out).toBe([
        "use { table shared.dim_missing } from '../../silver/tables/shared/dim_missing.dbml'",
        "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'",
        "use { table gold.fct_order } from '../tables/gold/fct_order.dbml'",
        '',
        'Ref: gold.fct_order.Customer_Key >? gold.dim_customer.customer_key',
        'Ref: gold.fct_order.order_date_key >? shared.dim_missing.date_key',
        '',
        '// erd-studio pending: Ref: gold.customer_profile.customer_key >? dim_gone.k',
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
        '// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.',
        "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'",
        "use { table gold.fct_order } from '../tables/gold/fct_order.dbml'",
        '',
        'Ref: gold.fct_order.Customer_Key >? gold.dim_customer.customer_key',
        '',
        '// erd-studio pending: Ref: gold.fct_order.order_date_key >? dim_missing.date_key',
        '',
      ].join('\n'));
    },
  },

  // --- Renames over pending lines (D27): only the renamed names are spelled anew -----------
  relCase('renaming a pending line\'s owner re-spells it (and its live Refs); another owner\'s line stays', PENDING_FILE, () => {
    const list = currentOwners(PENDING_FILE).get('fct_order') ?? [];
    return {
      owners: new Map([['fct_order_line', { name: 'fct_order_line', relationships: list }]]),
      renamedOwners: new Map([['fct_order', 'fct_order_line']]),
      pathChanged: new Set(['fct_order', 'fct_order_line']),
    };
  }, (out) => {
    expect(out).toContain('// erd-studio pending: Ref: gold.fct_order_line.order_date_key >? dim_missing.date_key\n');
    expect(out).toContain('// erd-studio pending: Ref: gold.customer_profile.customer_key >? dim_gone.k\n');
    expect(out).toContain('Ref: gold.fct_order_line.Customer_Key >? gold.dim_customer.customer_key\n');
    expect(out).not.toMatch(/\bfct_order\./);
  }, RENAMED_LIBRARY, true),
  relCase('renaming a pending line\'s target table re-spells it, its owner not listed', PENDING_TO_COLUMN, () => ({
    owners: new Map(),
    renamedOwners: new Map([['dim_date', 'dim_day']]),
    pathChanged: new Set(['dim_date', 'dim_day']),
  }), (out) => {
    expect(out).toBe(PENDING_TO_COLUMN.replace('>? shared.dim_date.nope', '>? shared.dim_day.nope'));
  }, DIM_DAY_LIBRARY, true),
  relCase('renaming a pending line\'s column re-spells only that column', PENDING_FILE, () => {
    const list = (currentOwners(PENDING_FILE).get('fct_order') ?? []).map((r) => (r.fromColumn === 'order_date_key' ? { ...r, fromColumn: 'order_day_key' } : r));
    return {
      owners: new Map([['fct_order', { name: 'fct_order', relationships: list }]]),
      renamedColumns: new Map([['fct_order', new Map([['order_date_key', 'order_day_key']])]]),
    };
  }, (out) => {
    expect(out).toBe(PENDING_FILE.replace('fct_order.order_date_key >? dim_missing', 'fct_order.order_day_key >? dim_missing'));
  }, ORDER_DAY_LIBRARY, true),
  relCase('a pending relationship carried into a new file (its owner moved there) stays pending, never a live Ref or a refusal', null, () => ({
    owners: new Map([['fct_order', { name: 'fct_order', relationships: [M21('Customer_Key', 'dim_customer', 'customer_key'), M21('order_date_key', 'dim_missing', 'date_key'), M21('ship_date_key', 'dim_date', 'nope')] }]]),
    pendingBefore: [
      { from: 'fct_order', to: 'dim_missing', fromColumns: ['order_date_key'], toColumns: ['date_key'], cardinality: 'many-to-one' },
      { from: 'fct_order', to: 'dim_date', fromColumns: ['ship_date_key'], toColumns: ['nope'], cardinality: 'many-to-one' },
    ],
  }), (out) => {
    expect(out).toContain('// erd-studio pending: Ref: gold.fct_order.order_date_key >? dim_missing.date_key\n');
    expect(out).toContain('// erd-studio pending: Ref: gold.fct_order.ship_date_key >? shared.dim_date.nope\n');
    expect(out).not.toMatch(/^Ref: fct_order\.(order|ship)_date_key/m);
  }),
  relCase('an owner listed with a pending relationship whose other table was renamed outside the edit (a YAML table): the line is re-spelled in place', PENDING_FILE,
    () => changed(PENDING_FILE, 'fct_order', (list) => list.map((r) => (r.toModel === 'dim_missing' ? { ...r, toModel: 'dim_missing2' } : r))), (out) => {
      expect(out).toBe(PENDING_FILE.replace('>? dim_missing.date_key', '>? dim_missing2.date_key'));
    }),

  // --- W3: a blank line between the Refs of different foreign-key tables ----------------
  relCase('a new file puts a blank line between the Refs of each foreign-key table', null, () => ({
    owners: new Map([
      ['fct_order', { name: 'fct_order', relationships: [M21('customer_key', 'dim_customer', 'customer_key'), M21('order_date_key', 'dim_date', 'date_key')] }],
      ['customer_profile', { name: 'customer_profile', relationships: [M21('customer_key', 'dim_customer', 'customer_key')] }],
    ]),
  }), (out) => {
    expect(out.slice(out.indexOf('\nRef') + 1)).toBe(`Ref: gold.customer_profile.customer_key >? gold.dim_customer.customer_key

Ref: gold.fct_order.Customer_Key >? gold.dim_customer.customer_key
Ref: gold.fct_order.order_date_key >? shared.dim_date.date_key
`);
  }),
  relCase('an edit of a pre-2.0 file with no blank lines between tables adds them; Refs of one table stay together', OLD_LAYOUT, () => changed(OLD_LAYOUT, 'fct_order', (list) => [
    ...list, M21('order_date_key', 'dim_date', 'date_key'),
  ]), (out) => {
    expect(out).toBe(`use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'

Ref: gold.customer_profile.customer_key >? gold.dim_customer.customer_key

// the parent
Ref: gold.dim_customer.parent_key >? gold.dim_customer.customer_key

Ref: gold.fct_order.Customer_Key >? gold.dim_customer.customer_key
Ref: gold.fct_order.order_date_key >? shared.dim_date.date_key
`);
  }),
  relCase('a Ref added to the first of two tables joins its group: the file reads as a fresh render does', W3_TWO_GROUPS, () => changed(W3_TWO_GROUPS, 'customer_profile', (list) => [
    ...list, W3_TO_DATE,
  ]), (out) => {
    expect(out).toBe(w3Fresh([...W3_PROFILE, W3_TO_DATE]));
    expect(out.slice(out.indexOf('\nRef') + 1)).toBe(`Ref: gold.customer_profile.customer_key >? gold.dim_customer.customer_key
Ref: gold.customer_profile.customer_key >? shared.dim_date.date_key

Ref: gold.fct_order.Customer_Key >? gold.dim_customer.customer_key
`);
  }),
  relCase('a third Ref added to that first group still joins it (no drift builds up)', W3_FIRST_GROUP_GROWN, () => changed(W3_FIRST_GROUP_GROWN, 'customer_profile', (list) => [
    ...list, W3_TO_ORDER,
  ]), (out) => {
    expect(out).toBe(w3Fresh([...W3_PROFILE, W3_TO_DATE, W3_TO_ORDER]));
  }),
  relCase('a no-op on a pre-2.0 file stays byte-identical (no blank lines added)', OLD_LAYOUT, () => ({
    owners: new Map([...currentOwners(OLD_LAYOUT)].map(([k, v]) => [k, { name: k, relationships: v }])),
  }), (out) => {
    expect(out).toBe(OLD_LAYOUT);
  }),
];
