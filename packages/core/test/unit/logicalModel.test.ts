import { describe, it, expect } from 'vitest';
import { parseDocument, isAlias, isMap, isScalar, isSeq } from 'yaml';
import type { Document } from 'yaml';

import {
  LOGICAL_MODELS_DIR,
  RATIONALE_KEYS,
  YamlNodeLimitError,
  isSafeModelName,
  parseLogicalModelText,
} from '../../src/logicalModel';

/** A classic exponential alias expansion: 10 levels of 10x, about 10^10 nodes. */
function billionLaughs(): string {
  const lines = ['name: bomb', 'a0: &a0 [lol, lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
  for (let i = 1; i < 10; i++) {
    const prev = `*a${i - 1}`;
    lines.push(`a${i}: &a${i} [${Array(10).fill(prev).join(', ')}]`);
  }
  lines.push('columns: *a9');
  return lines.join('\n') + '\n';
}

/**
 * Reference expansion that resolves each alias with yaml's own
 * `Alias.resolve(doc)` (a fresh scan per alias), for comparing against the
 * one-pass alias resolution. Only the mapping to plain values matters here.
 */
function referencePlain(doc: Document, node: unknown): unknown {
  if (isAlias(node)) return referencePlain(doc, node.resolve(doc));
  if (isMap(node)) {
    const obj: Record<string, unknown> = {};
    for (const pair of node.items) obj[String(referencePlain(doc, pair.key))] = referencePlain(doc, pair.value);
    return obj;
  }
  if (isSeq(node)) return node.items.map((item) => referencePlain(doc, item));
  if (isScalar(node)) {
    const v = node.value;
    if (typeof v === 'string' || typeof v === 'boolean' || v === null || v === undefined) return v ?? null;
    return node.source ?? String(v);
  }
  return node ?? null;
}

describe('constants', () => {
  it('names the model directory and the rationale keys', () => {
    expect(LOGICAL_MODELS_DIR).toBe('logical-models');
    expect([...RATIONALE_KEYS]).toEqual(['purpose', 'design', 'grainChoice', 'roleChoice', 'scdStrategy', 'measures']);
  });
});

describe('parseLogicalModelText', () => {
  it('reads a model with its columns and rationale', () => {
    const text = [
      'name: dim_customer',
      'schema: silver',
      'description: Customers',
      'grain: One row per customer',
      'modelRole: dimension',
      'rationale:',
      '  purpose: Shared customer reference',
      '  notARationaleKey: dropped',
      'columns:',
      '  - name: customer_key',
      '    dataType: INT',
      '    description: Surrogate key',
      '    isPrimaryKey: true',
      '    scdType: 2',
      '  - name: segment',
      '    additiveType: non-additive',
      '    isForeignKey: "yes"',
      '    isNaturalKey: no',
      '  - just a string',
      '',
    ].join('\n');
    expect(parseLogicalModelText(text, 'fallback')).toEqual({
      name: 'dim_customer',
      schema: 'silver',
      description: 'Customers',
      grain: 'One row per customer',
      modelRole: 'dimension',
      rationale: { purpose: 'Shared customer reference' },
      columns: [
        { name: 'customer_key', dataType: 'INT', description: 'Surrogate key', isPrimaryKey: true, scdType: 2 },
        { name: 'segment', dataType: 'unknown', description: '', isForeignKey: true, additiveType: 'non-additive' },
      ],
    });
  });

  it('returns null for an empty file, a non-mapping root and a model without a name', () => {
    expect(parseLogicalModelText('', 'x')).toBeNull();
    expect(parseLogicalModelText('# only a comment\n', 'x')).toBeNull();
    expect(parseLogicalModelText('- a\n- b\n', 'x')).toBeNull();
    expect(parseLogicalModelText('just text\n', 'x')).toBeNull();
    expect(parseLogicalModelText('description: no name\n', 'x')).toBeNull();
    expect(parseLogicalModelText('name:\n', 'x')).toBeNull();
    expect(parseLogicalModelText("name: ''\n", 'x')).toBeNull();
  });

  it('throws the first YAML syntax error', () => {
    const text = 'name: broken\ncolumns:\n  - name: a\n    dataType: [INT\n  - name: b\n';
    expect(() => parseLogicalModelText(text, 'broken')).toThrow(/Flow sequence in block collection/);
  });

  it('keeps numeric-looking scalars as their source text (schema: 007)', () => {
    const model = parseLogicalModelText(
      'name: 1e3\nschema: 007\ncolumns:\n  - name: balance\n    dataType: 12.50\n    description: 0x1F\n    scdType: "1"\n',
      'fallback',
    );
    expect(model).toEqual({
      name: '1e3',
      schema: '007',
      columns: [{ name: 'balance', dataType: '12.50', description: '0x1F', scdType: 1 }],
    });
  });

  it('resolves anchors and aliases to the same values yaml itself produces', () => {
    const text = [
      'name: dim_account',
      'rationale:',
      '  purpose: &why Shared account reference',
      '  design: *why',
      'columns:',
      '  - &key',
      '    name: account_key',
      '    dataType: INT',
      '    description: Surrogate key',
      '  - *key',
      '  - name: other',
      '    dataType: VARCHAR',
      '    description: *why',
      '',
    ].join('\n');
    const expected = parseDocument(text).toJS() as {
      name: string;
      rationale: Record<string, string>;
      columns: Array<{ name: string; dataType: string; description: string }>;
    };
    expect(parseLogicalModelText(text, 'x')).toEqual({
      name: expected.name,
      rationale: expected.rationale,
      columns: expected.columns,
    });
  });

  it('uses the last anchor defined before an alias, as yaml does', () => {
    const text = 'name: x\ndescription: &d first\ngrain: *d\nschema: &d second\nmodelRole: *d\n';
    const expected = parseDocument(text).toJS() as Record<string, string>;
    const model = parseLogicalModelText(text, 'x');
    expect(model?.grain).toBe(expected.grain);
    expect(model?.modelRole).toBe(expected.modelRole);
    expect(model?.grain).toBe('first');
    expect(model?.modelRole).toBe('second');
  });

  it('resolves aliases exactly as Alias.resolve does, across anchor shapes', () => {
    const docs = [
      // redefined anchors: each alias takes the latest definition before it
      'name: &n first\ndescription: *n\nschema: &n second\ngrain: *n\n',
      // anchors on keys, on collections, nested inside anchored collections
      'name: x\n? &k description\n: *k\ncolumns:\n  - &col { name: &cn a, dataType: *cn, description: &d desc }\n  - *col\n  - { name: b, dataType: INT, description: *d }\n',
      // an anchor defined inside a sequence item and used after the sequence
      'name: y\ncolumns:\n  - name: a\n    dataType: &t VARCHAR\n  - name: b\n    dataType: *t\ngrain: *t\n',
      // an alias to an anchor defined later resolves to nothing, as in yaml
      'name: z\nrationale:\n  purpose: *later\n  design: &later now\n',
      // numeric anchored scalars keep their source text through an alias
      'name: w\nschema: &s 007\ngrain: *s\n',
    ];
    for (const text of docs) {
      const doc = parseDocument(text);
      expect(doc.errors).toEqual([]);
      const reference = referencePlain(doc, doc.contents) as Record<string, unknown>;
      const model = parseLogicalModelText(text, 'fallback');
      const again = parseLogicalModelText(text, 'fallback', { maxNodes: 1_000 });
      expect(model).toEqual(again);
      // The model keeps only the fields ERD Studio reads, so compare those.
      expect(model?.name).toBe(reference.name);
      for (const key of ['description', 'schema', 'grain'] as const) {
        expect(model?.[key]).toBe(reference[key] === null || reference[key] === undefined ? undefined : String(reference[key]) || undefined);
      }
      if (Array.isArray(reference.columns)) {
        expect(model?.columns?.map((c) => [c.name, c.dataType])).toEqual(
          (reference.columns as Array<Record<string, unknown>>).map((c) => [String(c.name), String(c.dataType)]),
        );
      }
    }
  });

  it('stops a self-referencing alias at maxNodes', () => {
    expect(() => parseLogicalModelText('name: x\ncolumns: &c [*c]\n', 'x', { maxNodes: 1_000 })).toThrow(YamlNodeLimitError);
  });

  it('stops a billion-laughs document at maxNodes, quickly', () => {
    const started = Date.now();
    let caught: unknown;
    try {
      parseLogicalModelText(billionLaughs(), 'bomb', { maxNodes: 50_000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(YamlNodeLimitError);
    expect((caught as YamlNodeLimitError).maxNodes).toBe(50_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('counts keys, values and followed aliases against maxNodes', () => {
    // root map (1) + 2 pairs x (key + value) = 5 nodes
    expect(parseLogicalModelText('name: a\nschema: b\n', 'x', { maxNodes: 5 })).toEqual({ name: 'a', schema: 'b' });
    expect(() => parseLogicalModelText('name: a\nschema: b\n', 'x', { maxNodes: 4 })).toThrow(YamlNodeLimitError);
    // the alias itself and the node it resolves to both count
    expect(() => parseLogicalModelText('name: &n a\nschema: *n\n', 'x', { maxNodes: 5 })).toThrow(YamlNodeLimitError);
    expect(parseLogicalModelText('name: &n a\nschema: *n\n', 'x', { maxNodes: 6 })).toEqual({ name: 'a', schema: 'a' });
  });

  it('parses 20,000 aliases in under 2s', () => {
    const tags = ['  - &a INT', ...Array.from({ length: 20_000 }, () => '  - *a')].join('\n');
    const text = `name: wide\nz: &z BIGINT\ncolumns:\n  - name: c\n    dataType: *z\ntags:\n${tags}\n`;
    const started = Date.now();
    const model = parseLogicalModelText(text, 'wide');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(model).toEqual({ name: 'wide', columns: [{ name: 'c', dataType: 'BIGINT', description: '' }] });
  });

  it('reads a non-string name as its text, and falls back to the given name when that is empty', () => {
    expect(parseLogicalModelText('name: 42\n', 'x')?.name).toBe('42');
    expect(parseLogicalModelText('name: true\n', 'x')?.name).toBe('true');
    expect(parseLogicalModelText('name: []\n', 'fallback')?.name).toBe('fallback');
  });
});

describe('isSafeModelName', () => {
  it('accepts plain names, including dots, dashes and spaces', () => {
    for (const name of ['dim_customer', 'fct.order-v2', 'with space', '.hidden', '-lead']) {
      expect(isSafeModelName(name)).toBe(true);
    }
  });

  it('rejects blanks, path separators, .. and non-strings', () => {
    for (const name of ['', '   ', 'a/b', '/abs', 'a\\b', '..', 'a..b', '../up', 7, null, undefined, {}]) {
      expect(isSafeModelName(name)).toBe(false);
    }
  });
});
