/**
 * toDbml: every mapping in the table at the top of src/exportDbml.ts, and the
 * tolerant-input cases. Every output is read by the current `@dbml/parse` and
 * by the old `@dbml/core` 3.13.4 and 2.6.1 parsers most DBML tools embed, and
 * all three must read the same thing (`readDbmlEverywhere`).
 */

import { describe, it, expect } from 'vitest';

import { toDbml } from '../../src/exportDbml';
import type { DisplayDomain } from '../../src/types/display';
import { col, deepFreeze, domain, model, readDbmlEverywhere, rel } from '../exportParsers';
import type { DbmlReading } from '../exportParsers';

function exportAndRead(d: DisplayDomain): { text: string; db: DbmlReading } {
  const text = toDbml(deepFreeze(d));
  return { text, db: readDbmlEverywhere(text) };
}

const table = (db: DbmlReading, name: string) => db.tables.find((t) => t.name === name)!;
const field = (db: DbmlReading, tableName: string, name: string) => table(db, tableName).fields.find((f) => f.name === name)!;

describe('toDbml', () => {
  it('opens with the version line and the left-out list', () => {
    const { text } = exportAndRead(domain([model('a', [col('id')])]));
    const lines = text.split('\n');
    expect(lines[0]).toBe('// erd-studio dbml-export v1');
    expect(lines[1]).toBe('// Not exported: canvas positions and sizes, sticky-note colours, nested meta values (lists and maps).');
    expect(lines[2]).toBe("// ERD Studio's own fields (role, grain, alias, rationale, natural keys, SCD type, additivity, meta) are in the notes.");
    expect(text.endsWith('\n')).toBe(true);
  });

  it('uses no custom properties, which every DBML parser before @dbml/parse 9.1 rejects', () => {
    const { text } = exportAndRead(
      domain(
        [
          model('f', [col('id', 'int', { isPrimaryKey: true, isNaturalKey: true, scdType: 2, additiveType: 'additive', meta: { unit: 'EUR' } }), col('d_key', 'int', { isForeignKey: true })], {
            alias: 'facts',
            modelRole: 'transaction-fact',
            grain: 'One row',
            meta: { owner: 'a' },
          }),
          model('d', [col('k', 'int', { isPrimaryKey: true })]),
        ],
        [],
        { layer: 'gold' },
      ),
    );
    expect(text).not.toMatch(/erd_/);
    // No table settings at all, and column settings are only DBML's own `pk` and `note`.
    expect(text).not.toMatch(/^Table [^\n]*\[/m);
    const columnSettings = [...text.matchAll(/^ {2}\S+ \S+ \[(.*)$/gm)].map((m) => m[1]);
    expect(columnSettings.length).toBeGreaterThan(0);
    for (const settings of columnSettings) expect(settings).toMatch(/^(pk\]|pk, note: |note: )/);
  });

  it('writes the domain as the Project, with layer, stage and description in its note', () => {
    const { db } = exportAndRead(domain([], [], { domain: 'customer 360', layer: 'gold', description: "It's\nmulti-line" }));
    expect(db.project).toEqual({ name: 'customer 360', note: "Layer: gold\nStage: logical\n\nIt's\nmulti-line" });
  });

  it('writes a nameless Project, which old parsers need instead of an empty name', () => {
    const { text, db } = exportAndRead(domain([model('a', [col('id')])], [], { domain: '' }));
    expect(text).toContain('Project {\n');
    expect(db.project).toEqual({ name: null, note: 'Layer: silver\nStage: logical' });
    expect(db.tables.map((t) => t.name)).toEqual(['a']);
  });

  it('leaves the Project out when there is nothing to put in it', () => {
    const { text, db } = exportAndRead(domain([], [], { domain: '', layer: '', stage: '' as never }));
    expect(text).not.toContain('Project');
    expect(db.project).toBeNull();
    expect(db.tables).toEqual([]);
  });

  it('writes a model as a schema-qualified table, its ERD fields as lines in the table note', () => {
    const { text, db } = exportAndRead(
      domain([
        model('fct_order', [col('id', 'int', { isPrimaryKey: true })], {
          schema: 'gold',
          alias: 'orders',
          modelRole: 'transaction-fact',
          grain: 'One row per order line',
          description: 'Orders',
          rationale: { purpose: 'Reporting', grainChoice: 'Lines, not orders', scdStrategy: 'n/a' },
          meta: { owner: 'team a', certified: true, 'data-owner': 'c' },
        }),
      ]),
    );
    const t = table(db, 'fct_order');
    expect(t.schema).toBe('gold');
    expect(t.note).toBe(
      [
        'Role: transaction-fact',
        'Grain: One row per order line',
        'Warehouse table (alias): orders',
        '',
        'Orders',
        '',
        'Purpose: Reporting',
        'Grain choice: Lines, not orders',
        'SCD strategy: n/a',
        '',
        'Meta – owner: team a',
        'Meta – certified: true',
        'Meta – data-owner: c',
      ].join('\n'),
    );
    // alias is never DBML's `as`.
    expect(text).not.toMatch(/Table [^\n]* as /);
  });

  it('writes only the parts of the table note a model has', () => {
    const { db } = exportAndRead(
      domain([model('a', [col('id')], { description: 'Just a description' }), model('b', [col('id')], { grain: 'g' }), model('c', [col('id')])]),
    );
    expect(table(db, 'a').note).toBe('Just a description');
    expect(table(db, 'b').note).toBe('Grain: g');
    expect(table(db, 'c').note).toBeNull();
  });

  it('keeps two models that share an alias as two tables', () => {
    const { db } = exportAndRead(
      domain([model('silver_date', [col('d')], { alias: 'date', schema: 'silver' }), model('gold_date', [col('d')], { alias: 'date', schema: 'gold' })]),
    );
    expect(db.tables.map((t) => [t.schema, t.name, t.note])).toEqual([
      ['silver', 'silver_date', 'Warehouse table (alias): date'],
      ['gold', 'gold_date', 'Warehouse table (alias): date'],
    ]);
  });

  it('writes columns with their type and key, and their ERD fields after the description', () => {
    const { db } = exportAndRead(
      domain([
        model('dim', [
          col('k', 'INT', { isPrimaryKey: true, description: 'Surrogate key', scdType: 0 }),
          col('code', 'VARCHAR', { isNaturalKey: true, scdType: 2 }),
          col('amount', 'decimal(10,2)', { additiveType: 'semi-additive', meta: { unit: 'EUR', tags: ['x'] } }),
          col('parent', 'INT', { isForeignKey: true }),
          col('plain', 'INT', { description: 'Nothing else' }),
          col('bare', 'INT'),
          col('long', 'INT', { description: 'Line one\nline two', isNaturalKey: true }),
        ]),
      ]),
    );
    expect(field(db, 'dim', 'k')).toEqual({ name: 'k', type: 'INT', pk: true, note: 'Surrogate key (SCD type 0)' });
    expect(field(db, 'dim', 'code')).toEqual({ name: 'code', type: 'VARCHAR', pk: false, note: 'Natural key; SCD type 2' });
    expect(field(db, 'dim', 'amount')).toEqual({ name: 'amount', type: 'decimal(10,2)', pk: false, note: 'Semi-additive; meta unit: EUR' });
    // A foreign-key flag no exported Ref explains.
    expect(field(db, 'dim', 'parent').note).toBe('Foreign key');
    expect(field(db, 'dim', 'plain').note).toBe('Nothing else');
    expect(field(db, 'dim', 'bare').note).toBeNull();
    expect(field(db, 'dim', 'long').note).toBe('Line one\nline two\n(natural key)');
  });

  it('does not repeat "foreign key" for a column a Ref leaves from', () => {
    const { db } = exportAndRead(
      domain([model('f', [col('d_key', 'int', { isForeignKey: true }), col('e_key', 'int', { isForeignKey: true })]), model('d', [col('d_key')])], [rel('f.d_key', 'd.d_key')]),
    );
    expect(field(db, 'f', 'd_key').note).toBeNull();
    expect(field(db, 'f', 'e_key').note).toBe('Foreign key');
  });

  it('notes a foreign-key flag the same whichever way the link is stored', () => {
    const models = [model('fct', [col('dim_id', 'int', { isForeignKey: true })]), model('dim', [col('id', 'int', { isPrimaryKey: true, isForeignKey: true })])];
    const manyToOne = exportAndRead(domain(models, [rel('fct.dim_id', 'dim.id', 'many-to-one')])).db;
    const oneToMany = exportAndRead(domain(models, [rel('dim.id', 'fct.dim_id', 'one-to-many')])).db;
    for (const db of [manyToOne, oneToMany]) {
      // A Ref leaves fct.dim_id, so its flag needs no note; dim.id is the key end, so its flag does.
      expect(field(db, 'fct', 'dim_id').note).toBeNull();
      expect(field(db, 'dim', 'id').note).toBe('Foreign key');
    }
  });

  it('round-trips awkward text exactly in every parser: quotes, backslashes, newlines, tabs, unicode', () => {
    const awkward = "it's a \\ back\nslash\ttab ünï — 日本 😀 ''' \"dq\"";
    const endsInBackslash = 'C:\\temp\\';
    const endsInQuote = "say 'hi'";
    const { db } = exportAndRead(
      domain([
        model('t', [col('c', 'int', { description: awkward }), col('d', 'int', { description: endsInBackslash }), col('e', 'int', { description: endsInQuote })], {
          description: awkward,
        }),
      ]),
    );
    expect(table(db, 't').note).toBe(awkward);
    expect(field(db, 't', 'c').note).toBe(awkward);
    expect(field(db, 't', 'd').note).toBe(endsInBackslash);
    expect(field(db, 't', 'e').note).toBe(endsInQuote);
  });

  // The old @dbml/core parsers read a run of backslashes as one fewer and `\'` as `'` (and refuse
  // the whole file when a note ends that way); the current one reads them as written. No escape
  // reads alike in both, so such a backslash gets a space after it, and a comment says so.
  it('spaces apart a run of backslashes and a backslash before a quote, which old parsers misread', () => {
    const notes = ['a\\\\b', 'C:\\\\srv\\x', "back\\'q", "x\\'", 'one \\ alone'];
    const { text, db } = exportAndRead(
      domain([model('t', notes.map((n, i) => col(`c${i}`, 'int', { description: n })), { description: "regex \\\\d+ isn't" })], [], {
        description: "ends \\'",
      }),
    );
    expect(table(db, 't').fields.map((f) => f.note)).toEqual(['a\\ \\b', 'C:\\ \\srv\\x', "back\\ 'q", "x\\ '", 'one \\ alone']);
    expect(table(db, 't').note).toBe("regex \\ \\d+ isn't");
    expect(db.project!.note).toBe("Layer: silver\nStage: logical\n\nends \\ '");
    const said = "a space follows each \\ that comes before another \\ or a ' in its note (DBML parsers read those differently)";
    expect(text).toContain(`// Project: ${said}`);
    expect(text).toContain(`// t: ${said}`);
    for (const c of ['c0', 'c1', 'c2', 'c3']) expect(text).toContain(`  // ${c}: ${said}`);
    expect(text).not.toContain('  // c4:');
  });

  it('writes Windows line ends as \\n and drops white space at either end of a note', () => {
    const { db } = exportAndRead(domain([model('t', [col('c', 'int', { description: '\n\nfirst\r\nsecond\r\n\n  ' })], { description: '  \n one \n' })]));
    expect(field(db, 't', 'c').note).toBe('first\nsecond');
    expect(table(db, 't').note).toBe('one');
  });

  it('quotes types and names that are not plain identifiers', () => {
    const types = ['timestamp(6) without time zone', 'decimal(10,2)', 'STRUCT<a INT64>', '12.50', 'int[]', 'public.my_type'];
    const { db } = exportAndRead(
      domain([
        model('weird name', types.map((t, i) => col(`c${i}`, t))),
        model('日本', [col('a b'), col('Note'), col('indexes'), col('1st')], { schema: 's x' }),
        model('Table', [col('id')]),
      ]),
    );
    expect(table(db, 'weird name').fields.map((f) => f.type)).toEqual(types);
    expect(table(db, '日本').schema).toBe('s x');
    expect(table(db, '日本').fields.map((f) => f.name)).toEqual(['a b', 'Note', 'indexes', '1st']);
    expect(table(db, 'Table')).toBeDefined();
  });

  it('writes " and \\ in a name or type as \' and /, which every parser reads, and gives the original', () => {
    const { text, db } = exportAndRead(
      domain(
        [
          model('weird "name"', [col('a"b', 'STRUCT<a "b" INT64>'), col('c\\d', 'int')], { schema: 'x\\y' }),
          model('other', [col('k')]),
        ],
        [rel('weird "name".a"b', 'other.k')],
      ),
    );
    expect(text).toContain(`// x\\y.weird "name" is written as "x/y"."weird 'name'": DBML names cannot hold " or \\ in every parser`);
    expect(table(db, "weird 'name'").schema).toBe('x/y');
    expect(field(db, "weird 'name'", "a'b")).toEqual({ name: "a'b", type: "STRUCT<a 'b' INT64>", pk: false, note: 'Type STRUCT<a "b" INT64>; name a"b' });
    expect(field(db, "weird 'name'", 'c/d').note).toBe('Name c\\d');
    expect(db.refs).toEqual([{ name: null, ends: [['x/y', "weird 'name'", ["a'b"], '*'], ['public', 'other', ['k'], '1']] }]);
  });

  it('leaves out a table or column whose DBML name another already took, and the Refs that join it', () => {
    const { text, db } = exportAndRead(
      domain(
        [model('a"b', [col('x"y'), col("x'y")]), model("a'b", [col('k')]), model('c', [col('k')])],
        [rel("a'b.k", 'c.k'), rel("a\"b.x'y", 'c.k'), rel('a"b.x"y', 'c.k', 'one-to-one')],
      ),
    );
    expect(text).toContain('// Table a\'b is not exported: it is written as "a\'b", the name of an earlier table.');
    expect(text).toContain(`  // x'y: written as "x'y", the name of an earlier column; not exported`);
    expect(text).toContain("// Not exported: a'b.k -> c.k (a table or column it joins is not exported).");
    expect(text).toContain("// Not exported: a\"b.x'y -> c.k (a table or column it joins is not exported).");
    expect(db.tables.map((t) => [t.name, t.fields.map((f) => f.name)])).toEqual([
      ["a'b", ["x'y"]],
      ['c', ['k']],
    ]);
    expect(db.refs).toHaveLength(1);
  });

  it('writes an empty type as unknown', () => {
    const { db } = exportAndRead(domain([model('t', [col('c', ''), col('d', '   ')])]));
    expect(table(db, 't').fields.map((f) => f.type)).toEqual(['unknown', 'unknown']);
  });

  it('writes a composite primary key as a pk index', () => {
    const { text, db } = exportAndRead(domain([model('sat', [col('hk', 'binary', { isPrimaryKey: true }), col('load date', 'timestamp', { isPrimaryKey: true }), col('x')])]));
    expect(text).toContain('  indexes {\n    (hk, "load date") [pk]\n  }');
    expect(table(db, 'sat').fields.every((f) => !f.pk)).toBe(true);
    expect(table(db, 'sat').indexes).toEqual([{ pk: true, columns: ['hk', 'load date'] }]);
  });

  it('writes plain-text meta into the notes and names what it leaves out', () => {
    const { text, db } = exportAndRead(
      domain([
        model('m', [col('c', 'int', { meta: { 'pii-level': 'high', ok: 'yes', multi: 'a\nb', list: ['x'] } })], {
          meta: { owner: 'a', Owner: 'b', tags: ['x'], map: { k: 'v' }, nothing: null },
        }),
      ]),
    );
    expect(table(db, 'm').note).toBe('Meta – owner: a\nMeta – Owner: b');
    expect(field(db, 'm', 'c').note).toBe('Meta pii-level: high; meta ok: yes; meta multi: a b');
    expect(text).toContain('// m: meta not exported (a list, a map or empty): tags, map, nothing');
    expect(text).toContain('  // c: meta not exported (a list, a map or empty): list');
  });

  it.each([
    ['many-to-one', '>', ['*', '1']],
    ['one-to-many', '<', ['1', '*']],
    ['one-to-one', '-', ['1', '1']],
    ['many-to-many', '<>', ['*', '*']],
  ] as const)('writes a %s relationship from its from end', (cardinality, op, relations) => {
    const { text, db } = exportAndRead(domain([model('f', [col('d_key')]), model('d', [col('d_key')], { schema: 'gold' })], [rel('f.d_key', 'd.d_key', cardinality)]));
    expect(text).toContain(`Ref: f.d_key ${op} gold.d.d_key`);
    expect(db.refs).toEqual([{ name: null, ends: [['public', 'f', ['d_key'], relations[0]], ['gold', 'd', ['d_key'], relations[1]]] }]);
  });

  it('names a Ref after its role, and comments a role old parsers cannot read in a name', () => {
    const { text, db } = exportAndRead(
      domain(
        [model('f', [col('a'), col('b'), col('c'), col('e')]), model('d', [col('k')])],
        [
          rel('f.a', 'd.k', 'many-to-one', { role: 'ship date' }),
          rel('f.b', 'd.k', 'many-to-one', { role: 'billing' }),
          rel('f.c', 'd.k', 'many-to-one', { role: 'say "x" \\ y' }),
          rel('f.e', 'd.k', 'many-to-one', { role: 'billing' }),
        ],
      ),
    );
    expect(db.refs.map((r) => r.name)).toEqual(['ship date', 'billing', null, 'billing']);
    expect(text).toContain('Ref "ship date": f.a > d.k\nRef billing: f.b > d.k\n// Role: say "x" \\ y\nRef: f.c > d.k\n');
  });

  it('folds a composite foreign key into one Ref at its first member', () => {
    const { text, db } = exportAndRead(
      domain(
        [model('pit', [col('hk'), col('as_of'), col('other')]), model('sat', [col('hk'), col('load_date')])],
        [
          rel('pit.hk', 'sat.hk', 'many-to-one', { compositeKey: 'fk_sat', role: 'as of' }),
          rel('pit.other', 'sat.hk'),
          rel('pit.as_of', 'sat.load_date', 'many-to-one', { compositeKey: 'fk_sat' }),
        ],
      ),
    );
    expect(text).toContain('Ref "as of": pit.(hk, as_of) > sat.(hk, load_date)\nRef: pit.other > sat.hk');
    expect(db.refs[0].ends).toEqual([['public', 'pit', ['hk', 'as_of'], '*'], ['public', 'sat', ['hk', 'load_date'], '1']]);
  });

  it('does not fold a group that is not a valid composite', () => {
    const { db } = exportAndRead(
      domain(
        [model('a', [col('x'), col('y')]), model('b', [col('x'), col('y')]), model('c', [col('x')])],
        [rel('a.x', 'b.x', 'many-to-one', { compositeKey: 'k' }), rel('a.y', 'c.x', 'many-to-one', { compositeKey: 'k' }), rel('a.y', 'b.y', 'many-to-one', { compositeKey: 'lone' })],
      ),
    );
    expect(db.refs).toHaveLength(3);
  });

  it('writes a self-reference', () => {
    const { db } = exportAndRead(domain([model('employee', [col('id'), col('manager_id')])], [rel('employee.manager_id', 'employee.id')]));
    expect(db.refs[0].ends).toEqual([['public', 'employee', ['manager_id'], '*'], ['public', 'employee', ['id'], '1']]);
  });

  it("matches ends without case and writes the model's own spelling", () => {
    const { text } = exportAndRead(domain([model('Orders', [col('Customer_Key')]), model('dim_customer', [col('customer_key')])], [rel('orders.customer_key', 'DIM_CUSTOMER.CUSTOMER_KEY')]));
    expect(text).toContain('Ref: Orders.Customer_Key > dim_customer.customer_key');
  });

  it('leaves out, with a reason, links DBML would reject or that point outside the diagram', () => {
    const { text, db } = exportAndRead(
      domain(
        [model('a', [col('x'), col('y')]), model('b', [col('x')]), model('empty', [])],
        [
          rel('a.x', 'gone.x'),
          rel('nowhere.x', 'a.x'),
          rel('a.nope', 'b.x'),
          rel('a.x', 'a.x'),
          rel('a.x', 'b.x'),
          rel('a.x', 'b.x', 'one-to-one'),
          rel('b.x', 'a.x', 'one-to-many'),
          rel('empty.k', 'b.x'),
          { ...rel('a.y', 'b.x'), cardinality: 'sideways' as never },
        ],
      ),
    );
    expect(text).toContain('// Not exported: a.x -> gone.x (gone is not in this diagram).');
    expect(text).toContain('// Not exported: nowhere.x -> a.x (nowhere is not in this diagram).');
    expect(text).toContain('// Not exported: a.nope -> b.x (a has no column nope).');
    expect(text).toContain('// Not exported: a.x -> a.x (a column cannot point at itself).');
    expect(text).toContain('// Not exported: a.x -> b.x (the same link is already exported).');
    expect(text).toContain('// Not exported: b.x -> a.x (the same link is already exported).');
    expect(text).toContain('// Not exported: empty.k -> b.x (empty has no column k).');
    expect(text).toContain('// Not exported: a.y -> b.x (its cardinality "sideways" is not one an export can draw).');
    expect(db.refs).toHaveLength(1);
  });

  it('comments out a model with no columns or an unreadable file — DBML needs a column', () => {
    const { text, db } = exportAndRead(
      domain([model('raw_refunds', []), model('broken', [], { loadError: { kind: 'yamlIndent', line: 5 } }), model('ok', [col('id')])]),
    );
    expect(text).toContain('// Table raw_refunds is not exported: it has no columns, and a DBML table needs at least one.');
    expect(text).toContain('// Table broken is not exported: its model file could not be read (yamlIndent, line 5).');
    expect(db.tables.map((t) => t.name)).toEqual(['ok']);
  });

  it('writes sticky notes as comments, text only — old parsers have no Note blocks', () => {
    const { text } = exportAndRead(
      domain([model('a', [col('id')])], [], {
        viewConfig: {
          positions: { a: { x: 10, y: 20 } },
          annotations: [
            { id: 'n1', text: "Check the grain\nwith finance's team", x: 1, y: 2, color: 'pink', width: 200 },
            { id: 'n2', text: '', x: 0, y: 0 },
            { id: 'n3', text: 'Linked', x: 0, y: 0, linkedModel: 'a' },
          ],
        },
      }),
    );
    expect(text.endsWith("// Sticky note 1: Check the grain\n//     with finance's team\n// Sticky note 2 (linked to a): Linked\n")).toBe(true);
    expect(text).not.toMatch(/^Note /m);
    expect(text).not.toContain('pink');
    expect(text).not.toMatch(/\b(x|y|width): ?\d/);
  });

  it('accepts a DisplayDomain from an older core: only required fields, odd values, duplicates', () => {
    const old = {
      schemaVersion: 5,
      domain: 'old',
      layer: 'silver',
      stage: 'logical',
      description: '',
      models: [
        { name: 'a', schema: '', description: '', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false }] },
        { name: 'A', schema: '', description: '', columns: [{ name: 'x', dataType: 'int' }] },
        { name: null, schema: '', description: '', columns: [] },
        { name: 'b', schema: null, description: null, columns: [{ name: null }, { name: 123, dataType: null, description: null }, { name: '123' }] },
      ],
      relationships: [{ fromModel: 'b', fromColumn: '123', toModel: 'A', toColumn: 'ID', cardinality: 'many-to-one' }, null],
      viewConfig: { annotations: [null, { text: 5 }] },
      readOnly: false,
      positionDraggable: true,
    } as unknown as DisplayDomain;
    const { text, db } = exportAndRead(old);
    expect(text).toContain('// Not exported: A is listed more than once; exported once.');
    expect(text).toContain('// Not exported: model 3 has no name.');
    expect(text).toContain('// b: column 1 has no name; not exported');
    expect(text).toContain('// b: column 123 is listed more than once; not exported');
    expect(text).toContain('// Not exported: ?.? -> ?.? (it does not name both of its models).');
    expect(text).toContain('// Sticky note 1: 5');
    expect(db.refs).toEqual([{ name: null, ends: [['public', 'b', ['123'], '*'], ['public', 'a', ['id'], '1']] }]);
    expect(field(db, 'b', '123').type).toBe('unknown');
  });

  it('does not throw on a domain with no arrays at all', () => {
    const text = toDbml({ domain: 'x' } as unknown as DisplayDomain);
    expect(readDbmlEverywhere(text).project).toEqual({ name: 'x', note: null });
  });

  it('is deterministic', () => {
    const d = domain([model('a', [col('id')]), model('b', [col('a_id')])], [rel('b.a_id', 'a.id')]);
    expect(toDbml(d)).toBe(toDbml(JSON.parse(JSON.stringify(d))));
  });
});
