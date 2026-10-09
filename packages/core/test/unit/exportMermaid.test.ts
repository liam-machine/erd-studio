// @vitest-environment jsdom
/**
 * toMermaid: every mapping in the table at the top of src/exportMermaid.ts,
 * and the tolerant-input cases, each held to the real Mermaid parser — the
 * oldest 10.x (10.0.0) and the current release (12.0.0).
 */

import { beforeAll, describe, it, expect } from 'vitest';

import { toMermaid, mermaidName, mermaidType } from '../../src/exportMermaid';
import type { DisplayDomain } from '../../src/types/display';
import { MERMAID_LOAD_TIMEOUT_MS, col, deepFreeze, domain, loadMermaidParsers, model, parseMermaid, parseMermaidOldest, rel } from '../exportParsers';

// Load both Mermaid releases here, outside any test's timeout (#152).
beforeAll(loadMermaidParsers, MERMAID_LOAD_TIMEOUT_MS);

async function exportAndParse(d: DisplayDomain) {
  const text = toMermaid(deepFreeze(d));
  const parsed = await parseMermaid(text);
  return { text, parsed };
}

describe('toMermaid', () => {
  it('opens with erDiagram, then the version line and the left-out list', async () => {
    const { text } = await exportAndParse(domain([model('a', [col('id')])], [], { domain: 'sales', layer: 'gold', description: 'Line one\nline two' }));
    const lines = text.split('\n');
    expect(lines[0]).toBe('erDiagram');
    expect(lines[1]).toBe('%% erd-studio mermaid-export v1');
    expect(lines[2]).toBe('%% Not exported: canvas positions and sizes, sticky-note colours, nested meta values (lists and maps).');
    expect(lines).toContain('%% Diagram: sales (layer gold, logical stage)');
    expect(lines).toContain('%% Description: Line one');
    expect(lines).toContain('%%     line two');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('puts erDiagram first because Mermaid 10.0 to 10.4 reject any line before it', async () => {
    const commentFirst = '%% a comment\nerDiagram\n  "a" {\n    int id\n  }\n';
    // The oldest parser the tests run really is that strict, so it would catch a regression…
    await expect(parseMermaidOldest(commentFirst)).rejects.toThrow();
    // …which the current release would not; without the comment, both read it.
    await parseMermaid(commentFirst.replace('%% a comment\n', ''));
    const { default: current } = await import('mermaid-current');
    await expect(current.parse(commentFirst)).resolves.toBeTruthy();
  });

  it('parses an empty domain', async () => {
    const { parsed } = await exportAndParse(domain([]));
    expect(parsed.entities).toEqual([]);
  });

  it('draws a model as a quoted entity with typed, keyed, commented attributes', async () => {
    const { parsed } = await exportAndParse(
      domain([
        model('dim_customer', [
          col('customer_key', 'INT', { isPrimaryKey: true, description: 'Surrogate key', scdType: 0 }),
          col('customer_id', 'VARCHAR', { isNaturalKey: true }),
          col('parent_key', 'INT', { isForeignKey: true }),
          col('both', 'INT', { isPrimaryKey: true, isForeignKey: true, isNaturalKey: true }),
          col('amount', 'decimal(10,2)', { additiveType: 'semi-additive' }),
        ]),
      ]),
    );
    expect(parsed.entities).toEqual([
      {
        name: 'dim_customer',
        attributes: [
          { type: 'INT', name: 'customer_key', keys: ['PK'], comment: 'Surrogate key; SCD type 0' },
          { type: 'VARCHAR', name: 'customer_id', keys: ['UK'], comment: '' },
          { type: 'INT', name: 'parent_key', keys: ['FK'], comment: '' },
          { type: 'INT', name: 'both', keys: ['PK', 'FK', 'UK'], comment: '' },
          { type: 'decimal_10_2', name: 'amount', keys: [], comment: 'type decimal(10,2); semi-additive' },
        ],
      },
    ]);
  });

  it('carries the model-level fields as %% lines above the entity', async () => {
    const { text } = await exportAndParse(
      domain([
        model('fct_order', [col('id', 'int', { meta: { pii: 'no', tags: ['a'] } })], {
          schema: 'gold',
          alias: 'orders',
          modelRole: 'transaction-fact',
          grain: 'One row per order',
          description: 'Orders',
          rationale: { purpose: 'Reporting', measures: 'amount is additive' },
          meta: { owner: 'team a', certified: true, nested: { x: 'y' }, empty: null },
        }),
      ]),
    );
    const block = text.slice(text.indexOf('  %% Model fct_order'), text.indexOf('  "fct_order" {'));
    expect(block.split('\n').filter(Boolean)).toEqual([
      '  %% Model fct_order',
      '  %%   schema: gold',
      '  %%   alias: orders',
      '  %%   role: transaction-fact',
      '  %%   grain: One row per order',
      '  %%   description: Orders',
      '  %%   Purpose: Reporting',
      '  %%   Measures: amount is additive',
      '  %%   meta owner: team a',
      '  %%   meta certified: true',
      '  %%   meta not exported (a list, a map or empty): nested, empty',
      '  %%   id meta pii: no',
      '  %%   id meta not exported (a list, a map or empty): tags',
    ]);
    // The entity is the model name, never the alias.
    expect(text).not.toContain('"orders"');
  });

  it.each([
    ['many-to-one', 'ONLY_ONE', 'ZERO_OR_MORE', '}o--||'],
    ['one-to-many', 'ZERO_OR_MORE', 'ONLY_ONE', '||--o{'],
    ['one-to-one', 'ONLY_ONE', 'ONLY_ONE', '||--||'],
    ['many-to-many', 'ZERO_OR_MORE', 'ZERO_OR_MORE', '}o--o{'],
  ] as const)('draws a %s relationship', async (cardinality, cardA, cardB, connector) => {
    const { text, parsed } = await exportAndParse(
      domain([model('f', [col('d_key')]), model('d', [col('d_key', 'int', { isPrimaryKey: true })])], [rel('f.d_key', 'd.d_key', cardinality)]),
    );
    expect(text).toContain(`  %% f.d_key -> d.d_key, ${cardinality}\n  "f" ${connector} "d" : "d_key"`);
    expect(parsed.relationships).toEqual([{ from: 'f', to: 'd', label: 'd_key', cardA, cardB }]);
  });

  it('labels a relationship with its role, and a one-to-many with the to end\'s column', async () => {
    const { parsed } = await exportAndParse(
      domain(
        [model('f', [col('ship_date'), col('order_date')]), model('d', [col('date_key')])],
        [rel('f.ship_date', 'd.date_key', 'many-to-one', { role: 'ship "date"' }), rel('d.date_key', 'f.order_date', 'one-to-many')],
      ),
    );
    expect(parsed.relationships.map((r) => r.label)).toEqual(["ship 'date'", 'order_date']);
  });

  it('folds a composite foreign key into one relationship naming every column', async () => {
    const { text, parsed } = await exportAndParse(
      domain(
        [model('pit', [col('hk'), col('as_of')]), model('sat', [col('hk'), col('load_date')])],
        [
          rel('pit.hk', 'sat.hk', 'many-to-one', { compositeKey: 'fk_sat' }),
          rel('pit.as_of', 'sat.load_date', 'many-to-one', { compositeKey: 'fk_sat' }),
        ],
      ),
    );
    expect(text).toContain('  %% pit.(hk, as_of) -> sat.(hk, load_date), many-to-one');
    expect(parsed.relationships).toEqual([{ from: 'pit', to: 'sat', label: 'hk, as_of', cardA: 'ONLY_ONE', cardB: 'ZERO_OR_MORE' }]);
  });

  it('draws a self-reference', async () => {
    const { parsed } = await exportAndParse(
      domain([model('employee', [col('id', 'int', { isPrimaryKey: true }), col('manager_id')])], [rel('employee.manager_id', 'employee.id', 'many-to-one', { role: 'manager' })]),
    );
    expect(parsed.relationships).toEqual([{ from: 'employee', to: 'employee', label: 'manager', cardA: 'ONLY_ONE', cardB: 'ZERO_OR_MORE' }]);
  });

  it('leaves out, with a reason, links it cannot draw — exactly as the DBML export does', async () => {
    const { text, parsed } = await exportAndParse(
      domain(
        [model('a', [col('x'), col('y')]), model('b', [col('x')]), model('empty', [])],
        [
          rel('a.x', 'gone.x'),
          rel('a.nope', 'b.x'),
          rel('a.x', 'a.x'),
          rel('a.x', 'b.x'),
          rel('b.x', 'a.x', 'one-to-many'),
          rel('empty.k', 'b.x'),
          { ...rel('a.y', 'b.x'), cardinality: 'sideways' as never },
        ],
      ),
    );
    expect(text).toContain('  %% Not exported: a.x -> gone.x (gone is not in this diagram).');
    expect(text).toContain('  %% Not exported: a.nope -> b.x (a has no column nope).');
    expect(text).toContain('  %% Not exported: a.x -> a.x (a column cannot point at itself).');
    expect(text).toContain('  %% Not exported: b.x -> a.x (the same link is already exported).');
    expect(text).toContain('  %% Not exported: empty.k -> b.x (empty has no column k).');
    expect(text).toContain('  %% Not exported: a.y -> b.x (its cardinality "sideways" is not one an export can draw).');
    expect(parsed.relationships).toHaveLength(1);
    // A relationship to a model outside the diagram must not conjure an entity.
    expect(parsed.entities.map((e) => e.name)).toEqual(['a', 'b', 'empty']);
  });

  it('draws a model with no columns, or an unreadable file, as an empty entity', async () => {
    const { text, parsed } = await exportAndParse(
      domain([model('raw_refunds', []), model('broken', [], { loadError: { kind: 'yamlIndent', line: 5 } })]),
    );
    expect(text).toContain('  %%   no columns yet');
    expect(text).toContain('  %%   its model file could not be read (yamlIndent, line 5)');
    expect(parsed.entities).toEqual([
      { name: 'raw_refunds', attributes: [] },
      { name: 'broken', attributes: [] },
    ]);
  });

  // Quoting every entity name is safe back to Mermaid 10.0.0 (parseMermaid runs it first), and
  // the keywords below fail bare in one release or another (`end`, `style`, `class` in 11 and 12;
  // `one`, `to`, `u` in 10.x), so the rule is "always quote", not "quote keywords".
  it('quotes keyword-like and unusual entity names so every Mermaid release reads them', async () => {
    const names = ['end', 'style', 'classDef', 'class', 'direction', 'title', 'erDiagram', 'PK', 'one', 'to', 'u', '1abc', 'my ent', 'café', 'say "hi"'];
    const { parsed } = await exportAndParse(domain(names.map((n) => model(n, [col('id')]))));
    expect(parsed.entities.map((e) => e.name)).toEqual(names.map((n) => n.replace(/"/g, "'")));
  });

  // Inside quotes Mermaid reads no `%` or `\` in an entity name (10.0.0 and 12.0.0 alike), and
  // these names reach a DisplayDomain from old v4 inline files and hand edits.
  it('writes %, \\ and " in an entity name as _, / and \', which every release reads, and gives the original', async () => {
    const { text, parsed } = await exportAndParse(
      domain(
        [model('x\\y', [col('id')]), model('a%b', [col('id')]), model('p%%q', [col('id')]), model('end\\', [col('id')]), model('ok', [col('id')])],
        [rel('a%b.id', 'x\\y.id')],
      ),
    );
    expect(parsed.entities.map((e) => e.name)).toEqual(['x/y', 'a_b', 'p__q', 'end/', 'ok']);
    expect(parsed.relationships).toEqual([{ from: 'a_b', to: 'x/y', label: 'id', cardA: 'ONLY_ONE', cardB: 'ZERO_OR_MORE' }]);
    expect(text).toContain('  %% Model x\\y\n  %%   written as "x/y": Mermaid entity names cannot hold ", % or \\\n');
    expect(text).toContain('  %% Model p% %q\n  %%   written as "p__q"');
    expect(text).not.toMatch(/%% Model ok\n {2}%% {3}written as/);
  });

  it('leaves out a model whose entity name an earlier model took, and the relationships that join it', async () => {
    const { text, parsed } = await exportAndParse(
      domain([model('a_b', [col('id')]), model('a%b', [col('k')]), model('c', [col('id')])], [rel('a%b.k', 'c.id'), rel('a_b.id', 'c.id')]),
    );
    expect(text).toContain('  %% Not exported: a%b is written as "a_b", the name of an earlier entity.');
    expect(text).toContain('  %% Not exported: a%b.k -> c.id (a model it joins is not exported).');
    expect(parsed.entities).toEqual([
      { name: 'a_b', attributes: [{ type: 'int', name: 'id', keys: [], comment: '' }] },
      { name: 'c', attributes: [{ type: 'int', name: 'id', keys: [], comment: '' }] },
    ]);
    expect(parsed.relationships.map((r) => [r.from, r.to])).toEqual([['a_b', 'c']]);
  });

  // Mermaid reads `%%{…}%%` anywhere in the text as a directive, comments and quoted strings
  // included, so free text could restyle the diagram; and 10.x refuses a label that starts `%%`.
  it('breaks up %% in every piece of free text, so no directive or comment can form', async () => {
    const directive = '%%{init: {"theme":"dark"}}%%';
    const { text } = await exportAndParse(
      domain(
        [model('a', [col('id', 'int', { description: `col ${directive}`, meta: { note: directive } })], { description: `Note ${directive} here`, grain: '%%' }), model('b', [col('id')])],
        [rel('a.id', 'b.id', 'many-to-one', { role: '%% c' })],
        { domain: `d ${directive}`, description: directive, viewConfig: { annotations: [{ id: 'n', text: directive, x: 0, y: 0 }] } },
      ),
    );
    expect(text).not.toContain('%%{');
    expect(text).not.toContain('}%%');
    expect(text).toContain(': "% % c"');
    // The current release reads no configuration out of the text.
    const { default: current } = await import('mermaid-current');
    expect(JSON.stringify(await current.parse(text))).not.toContain('dark');
  });

  // Mermaid reads `~…~` inside an attribute as generic-type syntax, comments included: two tildes in
  // a column description made 10.0.0 refuse the whole diagram, and `a~b~c` made 12.0.0 refuse it too.
  it('writes ~ in column comments as ∼, which every release reads as text', async () => {
    const { text, parsed } = await exportAndParse(
      domain(
        [model('a', [
          col('id', 'int', { description: 'about ~100 rows, ~5 per day' }),
          col('x', 'int', { description: 'x ~ y ~ z' }),
          col('y', 'int', { description: 'a~b~c' }),
          col('z', 'int', { description: '~' }),
        ]), model('b', [col('id')])],
        [rel('a.id', 'b.id', 'many-to-one', { role: 'a~b~c' })],
      ),
    );
    expect(text).toContain('"about ∼100 rows, ∼5 per day"');
    expect(text).toContain('"a∼b∼c"');
    expect(parsed.entities.find((e) => e.name === 'a')?.attributes).toHaveLength(4);
  });

  it('reduces types and names to tokens every Mermaid release reads, keeping the originals in the comment', async () => {
    const { parsed } = await exportAndParse(
      domain([
        model('t', [
          col('ts', 'timestamp(6) without time zone'),
          col('st', 'STRUCT<a INT64>'),
          col('arr', 'int[]'),
          col('n', '12.50'),
          col('blank', ''),
          col('k', 'pk'),
          col('PK', 'int'),
          col('fk', 'int'),
          col('1st_col', 'int'),
          col('日本', 'int'),
          col('naïve', 'int', { description: 'with "quotes", a\nnewline and %% signs' }),
        ]),
      ]),
    );
    expect(parsed.entities[0].attributes.map((a) => [a.type, a.name, a.comment])).toEqual([
      ['timestamp_6_without_time_zone', 'ts', 'type timestamp(6) without time zone'],
      ['STRUCT_a_INT64', 'st', 'type STRUCT<a INT64>'],
      ['int', 'arr', 'type int[]'],
      ['t_12_50', 'n', 'type 12.50'],
      ['unknown', 'blank', ''],
      ['t_pk', 'k', 'type pk'],
      ['int', '_PK', 'name PK'],
      ['int', '_fk', 'name fk'],
      ['int', '_1st_col', 'name 1st_col'],
      ['int', '_', 'name 日本'],
      ['int', 'na_ve', "with 'quotes', a newline and % % signs; name naïve"],
    ]);
  });

  it('keeps the token rules Mermaid 10 needs', () => {
    // Mermaid 10 rejects a comma inside a type, a leading digit, a bare PK/FK/UK
    // name and non-ASCII letters; these pins keep the output inside that subset.
    expect(mermaidType('decimal(10,2)')).toBe('decimal_10_2');
    expect(mermaidType('varchar(255)')).toBe('varchar_255');
    expect(mermaidType('9x')).toBe('t_9x');
    expect(mermaidType('UK')).toBe('t_UK');
    expect(mermaidName('Uk')).toBe('_Uk');
    expect(mermaidName('ünï')).toBe('_n_');
    expect(mermaidName('pk_id')).toBe('pk_id');
  });

  it('puts sticky notes at the end as comments', async () => {
    const { text } = await exportAndParse(
      domain([model('a', [col('id')])], [], {
        viewConfig: {
          positions: { a: { x: 10, y: 20 } },
          annotations: [
            { id: 'n1', text: 'Check the grain\nwith finance', x: 0, y: 0, color: 'pink' },
            { id: 'n2', text: '   ', x: 0, y: 0 },
            { id: 'n3', text: 'Linked', x: 0, y: 0, linkedModel: 'a' },
          ],
        },
      }),
    );
    expect(text.trimEnd().split('\n').slice(-3)).toEqual([
      '  %% Sticky note 1: Check the grain',
      '  %%     with finance',
      '  %% Sticky note 2 (linked to a): Linked',
    ]);
    expect(text).not.toMatch(/\b(x|y): ?\d/);
    expect(text).not.toContain('pink');
  });

  it('accepts a DisplayDomain from an older core: only required fields, odd values, duplicates', async () => {
    const old = {
      schemaVersion: 5,
      domain: 'old',
      layer: 'silver',
      stage: 'logical',
      description: '',
      models: [
        { name: 'a', schema: '', description: '', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false }] },
        { name: 'a', schema: '', description: '', columns: [] },
        { name: '', schema: '', description: '', columns: [] },
        { name: 'b', schema: null, description: null, columns: [{ name: null }, { name: 123, dataType: null, description: null }] },
      ],
      relationships: [{ fromModel: 'b', fromColumn: '123', toModel: 'A', toColumn: 'ID', cardinality: 'many-to-one' }],
      viewConfig: {},
      readOnly: false,
      positionDraggable: true,
    } as unknown as DisplayDomain;
    const { text, parsed } = await exportAndParse(old);
    expect(text).toContain('  %% Not exported: a is listed more than once; exported once.');
    expect(text).toContain('  %% Not exported: model 3 has no name.');
    expect(text).toContain('  %%   column 1 has no name; not exported');
    expect(parsed.relationships).toEqual([{ from: 'b', to: 'a', label: '123', cardA: 'ONLY_ONE', cardB: 'ZERO_OR_MORE' }]);
  });

  it('does not throw on a domain with no arrays at all', async () => {
    const text = toMermaid({ domain: 'x' } as unknown as DisplayDomain);
    expect(text.split('\n').slice(0, 2)).toEqual(['erDiagram', '%% erd-studio mermaid-export v1']);
    await parseMermaid(text);
  });

  it('is deterministic', () => {
    const d = domain([model('a', [col('id')]), model('b', [col('a_id')])], [rel('b.a_id', 'a.id')]);
    expect(toMermaid(d)).toBe(toMermaid(JSON.parse(JSON.stringify(d))));
  });
});
