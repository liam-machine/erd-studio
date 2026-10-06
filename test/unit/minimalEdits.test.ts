import { describe, expect, it } from 'vitest';
import { parseLogicalModelText } from '@erd-studio/core';

import { setDomainRelationships, setYamlRelationships } from '../../src/services/minimalEdits';
import type { ModelRelationship, Relationship } from '../../src/types/semantic';

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

const MESSY_BODY = `# Hand-written model — keep me
name: fct_order    # the order fact
schema: gold
description: >
  One row per order line, joined to the customer and the product, with the
  amounts converted to AUD at the daily rate. Refunds are negative lines.
tags: [finance,   core]
defaults: &defaults
  isNullable: true
columns:
  - name: order_key
    dataType: integer
    isPrimaryKey: yes
  - name: customer_key     # FK
    dataType: integer
    isForeignKey: yes
    scdType: "2"
    description: ''
  - name: note
    <<: *defaults
  - name: amount
    dataType: 'decimal(18,2)'

# trailing comment stays
`;

const REL_A: ModelRelationship = { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
const REL_B: ModelRelationship = { fromColumn: 'product_key', toModel: 'dim_product', toColumn: 'product_key', cardinality: 'one-to-one' };

const BLOCK_2 = `relationships:
  - fromColumn: customer_key
    toModel: dim_customer
    toColumn: customer_key
    cardinality: many-to-one
`;

/** Remove the first top-level `relationships:` block (key line + indented/`- ` lines after it). */
function withoutBlock(text: string): string {
  const lines = text.split(/(?<=\n)/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^relationships:/.test(line)) { skipping = true; continue; }
    if (skipping && /^(?:[ \t]|- |\r?\n$)/.test(line)) continue;
    skipping = false;
    out.push(line);
  }
  return out.join('');
}

function parse(text: string) {
  return parseLogicalModelText(text.replace(/^﻿/, ''), 'fallback');
}

/** The output parses to the input's model with exactly `relationships`. */
function expectSameModel(input: string, output: string, relationships: readonly ModelRelationship[]): void {
  const before = parse(input)!;
  const after = parse(output)!;
  expect(after.relationships ?? []).toEqual(relationships);
  const { relationships: _a, ...restBefore } = before;
  const { relationships: _b, ...restAfter } = after;
  void _a; void _b;
  expect(restAfter).toEqual(restBefore);
}

describe('setYamlRelationships', () => {
  it('appends a block to a messy file and changes nothing else', () => {
    const out = setYamlRelationships(MESSY_BODY, [REL_A]);
    expect(out).toBe(MESSY_BODY + BLOCK_2);
    expectSameModel(MESSY_BODY, out, [REL_A]);
  });

  it('uses the indentation of the file\'s other sequences', () => {
    const four = MESSY_BODY.replace(/^  - /gm, '    - ').replace(/^    (\w|<)/gm, '      $1');
    const out = setYamlRelationships(four, [REL_A]);
    expect(out).toBe(four + BLOCK_2.replace(/^  - /m, '    - ').replace(/^    (?=\w)/gm, '      '));
    expectSameModel(four, out, [REL_A]);

    const zero = 'name: m\ncolumns:\n- name: a\n  dataType: int\n';
    const out0 = setYamlRelationships(zero, [REL_A]);
    expect(out0).toBe(zero + 'relationships:\n- fromColumn: customer_key\n  toModel: dim_customer\n  toColumn: customer_key\n  cardinality: many-to-one\n');
    expectSameModel(zero, out0, [REL_A]);
  });

  it('keeps a file without a trailing newline that way', () => {
    const input = 'name: m\ncolumns:\n  - name: a';
    const out = setYamlRelationships(input, [REL_A]);
    expect(out).toBe(input + '\n' + BLOCK_2.slice(0, -1));
    expectSameModel(input, out, [REL_A]);
    // and removal drops the line break it added
    expect(setYamlRelationships(out, [])).toBe(input);
  });

  it('keeps CRLF line endings', () => {
    const crlf = MESSY_BODY.replace(/\n/g, '\r\n');
    const out = setYamlRelationships(crlf, [REL_A, REL_B]);
    expect(out.startsWith(crlf)).toBe(true);
    expect(out.slice(crlf.length)).not.toMatch(/(?<!\r)\n/);
    expect(out.slice(crlf.length).endsWith('\r\n')).toBe(true);
    expectSameModel(crlf, out, [REL_A, REL_B]);
  });

  it('keeps a leading BOM', () => {
    const input = '﻿' + MESSY_BODY;
    const out = setYamlRelationships(input, [REL_A]);
    expect(out).toBe(input + BLOCK_2);
    expectSameModel(input, out, [REL_A]);
  });

  it('replaces a block-style relationships list in place', () => {
    const middle = MESSY_BODY.replace('columns:\n', 'relationships:\n  - fromColumn: old\n    toModel: x   # gone\n    toColumn: old\n\n    cardinality: one-to-many\ncolumns:\n');
    const out = setYamlRelationships(middle, [REL_A, REL_B]);
    expect(withoutBlock(out)).toBe(withoutBlock(middle));
    expect(withoutBlock(middle)).toBe(MESSY_BODY);
    expect(out).toContain(BLOCK_2 + '  - fromColumn: product_key\n');
    expectSameModel(middle, out, [REL_A, REL_B]);
  });

  it('replaces a flow-style relationships list in place', () => {
    const flow = MESSY_BODY.replace('schema: gold\n', 'schema: gold\nrelationships: [{fromColumn: a, toModel: b, toColumn: c}]  # old\n');
    const out = setYamlRelationships(flow, [REL_A]);
    expect(out).toBe(MESSY_BODY.replace('schema: gold\n', 'schema: gold\n' + BLOCK_2));
    expectSameModel(flow, out, [REL_A]);
  });

  it('replaces a block at the end of a file without a final newline', () => {
    const input = 'name: m\nrelationships:\n  - fromColumn: a\n    toModel: b\n    toColumn: c';
    const out = setYamlRelationships(input, [REL_A]);
    expect(out).toBe('name: m\n' + BLOCK_2.slice(0, -1));
  });

  it('removes the key and its lines when the list is empty', () => {
    const withRels = setYamlRelationships(MESSY_BODY, [REL_A, REL_B]);
    expect(setYamlRelationships(withRels, [])).toBe(MESSY_BODY);

    const middle = MESSY_BODY.replace('schema: gold\n', 'schema: gold\n' + BLOCK_2);
    const out = setYamlRelationships(middle, []);
    expect(out).toBe(MESSY_BODY);
    expectSameModel(middle, out, []);

    const empty = MESSY_BODY.replace('schema: gold\n', 'schema: gold\nrelationships: []\n');
    expect(setYamlRelationships(empty, [])).toBe(MESSY_BODY);
    const nullValue = MESSY_BODY.replace('schema: gold\n', 'schema: gold\nrelationships:\n');
    expect(setYamlRelationships(nullValue, [])).toBe(MESSY_BODY);
  });

  it('returns the text unchanged when there is nothing to add or remove', () => {
    expect(setYamlRelationships(MESSY_BODY, [])).toBe(MESSY_BODY);
  });

  it('is idempotent', () => {
    const once = setYamlRelationships(MESSY_BODY, [REL_A, REL_B]);
    expect(setYamlRelationships(once, [REL_A, REL_B])).toBe(once);
  });

  it('quotes values only when YAML needs it', () => {
    const out = setYamlRelationships('name: m\n', [
      { fromColumn: 'yes', toModel: 'true', toColumn: 'a: b', cardinality: 'many-to-one' },
    ]);
    expect(out).toBe('name: m\nrelationships:\n  - fromColumn: "yes"\n    toModel: "true"\n    toColumn: "a: b"\n    cardinality: many-to-one\n');
    expect(parse(out)!.relationships).toEqual([{ fromColumn: 'yes', toModel: 'true', toColumn: 'a: b', cardinality: 'many-to-one' }]);
  });

  it('throws when the root is not a mapping', () => {
    expect(() => setYamlRelationships('- a\n- b\n', [REL_A])).toThrow(/not a YAML mapping/);
    expect(() => setYamlRelationships('just a string\n', [REL_A])).toThrow(/not a YAML mapping/);
    expect(() => setYamlRelationships('', [REL_A])).toThrow(/not a YAML mapping/);
  });
});

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const R1: Relationship = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
const R2: Relationship = { fromModel: 'fct_order', fromColumn: 'product_key', toModel: 'dim_product', toColumn: 'product_key', cardinality: 'many-to-one' };

function domainText(indent: string, rels: string): string {
  const i = (n: number) => indent.repeat(n);
  return `{
${i(1)}"schemaVersion": 5,
${i(1)}"description": "Caf\\u00e9 orders — price 2.50",
${i(1)}"price": 2.50,
${i(1)}"logical": {
${i(2)}"models": ["fct_order", "dim_customer", "dim_product"],
${i(2)}"relationships": ${rels}
${i(1)}},
${i(1)}"viewConfig": {"positions": {"fct_order": {"x": 1.0, "y": 2.50}}}
}
`;
}

/** Text before the relationships value and after it are identical; the JSON matches except for them. */
function expectOnlyRelationshipsChanged(input: string, output: string, rels: readonly Relationship[]): void {
  const parsedIn = JSON.parse(input.replace(/^﻿/, ''));
  const parsedOut = JSON.parse(output.replace(/^﻿/, ''));
  expect(parsedOut.logical.relationships).toEqual(rels);
  delete parsedIn.logical.relationships;
  delete parsedOut.logical.relationships;
  expect(parsedOut).toEqual(parsedIn);
}

function splitAroundRelationships(text: string): [string, string] {
  const start = text.indexOf('"relationships": ') + '"relationships": '.length;
  const parsedEnd = (() => {
    // the value is the array that starts at `start`
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '[') depth++;
      if (text[i] === ']' && --depth === 0) return i + 1;
    }
    throw new Error('no array');
  })();
  return [text.slice(0, start), text.slice(parsedEnd)];
}

describe('setYamlRelationships — role (#133)', () => {
  it('writes a role after the cardinality, and the parser reads it back', () => {
    const rel: ModelRelationship = { fromColumn: 'ship_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'ship: date' };
    const text = setYamlRelationships('name: fct_order\n', [rel]);
    expect(text).toContain('    cardinality: many-to-one\n    role: "ship: date"\n');
    expect(parseLogicalModelText(text, 'fct_order')?.relationships).toEqual([rel]);
  });
});

describe('setDomainRelationships', () => {
  it.each([
    ['2-space', '  '],
    ['4-space', '    '],
    ['tab', '\t'],
  ])('replaces only the array with %s indentation', (_label, indent) => {
    const input = domainText(indent, '[{"fromModel":"a","fromColumn":"b","toModel":"c","toColumn":"d","cardinality":"one-to-one"}]');
    const out = setDomainRelationships(input, [R1, R2]);
    expect(splitAroundRelationships(out)).toEqual(splitAroundRelationships(input));
    expectOnlyRelationshipsChanged(input, out, [R1, R2]);
    const i2 = indent.repeat(2);
    const i3 = indent.repeat(3);
    expect(out).toContain(`"relationships": [\n${i3}{\n${i3}${indent}"fromModel": "fct_order",\n`);
    expect(out).toContain(`${i3}},\n${i3}{\n`);
    expect(out).toContain(`\n${i3}}\n${i2}]\n${indent}},`);
    expect(out).toContain('"price": 2.50');
    expect(out).toContain('Caf\\u00e9');
  });

  it('renders an empty list as []', () => {
    const input = domainText('  ', '[\n      {"fromModel":"a","fromColumn":"b","toModel":"c","toColumn":"d","cardinality":"one-to-one"}\n    ]');
    const out = setDomainRelationships(input, []);
    expect(out).toBe(domainText('  ', '[]'));
  });

  it('is idempotent', () => {
    const once = setDomainRelationships(domainText('  ', '[]'), [R1]);
    expect(setDomainRelationships(once, [R1])).toBe(once);
  });

  it('keeps CRLF and a BOM', () => {
    const input = '﻿' + domainText('  ', '[]').replace(/\n/g, '\r\n');
    const out = setDomainRelationships(input, [R1]);
    expect(out.startsWith('﻿{\r\n')).toBe(true);
    expect(out).not.toMatch(/(?<!\r)\n/);
    expect(splitAroundRelationships(out)).toEqual(splitAroundRelationships(input));
    expectOnlyRelationshipsChanged(input, out, [R1]);
  });

  it('ignores "relationships" inside strings and other objects', () => {
    const input = `{
  "description": "see \\"logical\\": {\\"relationships\\": []}",
  "other": {"relationships": [1, 2]},
  "logical": {"models": [], "relationships": []}
}`;
    const out = setDomainRelationships(input, [R1]);
    expect(out.slice(0, out.indexOf('"logical"'))).toBe(input.slice(0, input.indexOf('"logical"')));
    expectOnlyRelationshipsChanged(input, out, [R1]);
    // logical is on one line: the array is compact too
    expect(out).toContain(`"relationships": ${JSON.stringify([R1])}}`);
  });

  it('inserts the key after models when missing', () => {
    const input = `{
    "logical": {
        "models": ["a", "b"],
        "notes": "x"
    }
}
`;
    const out = setDomainRelationships(input, [R1]);
    expect(out).toBe(`{
    "logical": {
        "models": ["a", "b"],
        "relationships": [
            {
                "fromModel": "fct_order",
                "fromColumn": "customer_key",
                "toModel": "dim_customer",
                "toColumn": "customer_key",
                "cardinality": "many-to-one"
            }
        ],
        "notes": "x"
    }
}
`);
    expectOnlyRelationshipsChanged(input, out, [R1]);
  });

  it('inserts as the last key when there is no models key, and into an empty logical object', () => {
    const noModels = '{\n  "logical": {\n    "notes": "x"\n  }\n}';
    expect(setDomainRelationships(noModels, [])).toBe('{\n  "logical": {\n    "notes": "x",\n    "relationships": []\n  }\n}');

    const empty = '{\n  "logical": {}\n}\n';
    expect(setDomainRelationships(empty, [])).toBe('{\n  "logical": {\n    "relationships": []\n  }\n}\n');
  });

  it('throws when there is no logical object', () => {
    expect(() => setDomainRelationships('[]', [])).toThrow(/not a JSON object/);
    expect(() => setDomainRelationships('{"logical": []}', [])).toThrow(/no "logical" object/);
    expect(() => setDomainRelationships('{}', [])).toThrow(/no "logical" object/);
    expect(() => setDomainRelationships('{', [])).toThrow();
  });
});
