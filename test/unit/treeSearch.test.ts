/**
 * The sidebar's filter syntax (`src/services/treeSearch.ts`): words that must
 * all match, "phrases", -exclusions, `key:value` qualifiers (an unknown key
 * falls back to text and is reported), `is:` flags, what a row is highlighted
 * and annotated with, and the view's message. Pure: no VS Code.
 */
import { describe, it, expect } from 'vitest';

import {
  DIAGRAMS_FILTER,
  RELATIONSHIPS_FILTER,
  TABLE_LIBRARY_FILTER,
  describeFilterOutcome,
  filterPrompt,
  isEmptyQuery,
  isStructuredQuery,
  labelHighlights,
  matchTreeQuery,
  parseTreeQuery,
  queryUses,
  tableRoleValues,
  tableSearchSubject,
  withReasons,
  type SearchSubject,
} from '../../src/services/treeSearch';

const terms = (text: string, spec = TABLE_LIBRARY_FILTER) =>
  parseTreeQuery(text, spec).terms.map((t) => [t.key ?? '', t.value, t.negated]);

describe('parseTreeQuery', () => {
  it('reads plain words, case-insensitively, each a term of its own', () => {
    expect(terms('  Customer   ORDER ')).toEqual([['', 'customer', false], ['', 'order', false]]);
    expect(parseTreeQuery('  Customer   ORDER ').text).toBe('Customer   ORDER');
  });

  it('keeps a quoted phrase together, and an unclosed quote runs to the end', () => {
    expect(terms('"order line" fct')).toEqual([['', 'order line', false], ['', 'fct', false]]);
    expect(terms('"order li')).toEqual([['', 'order li', false]]);
    expect(terms('""')).toEqual([]);
  });

  it('reads -word (and -"a phrase", -key:value) as an exclusion; a lone - is a word', () => {
    expect(terms('-stg -"order line" -layer:bronze')).toEqual([
      ['', 'stg', true], ['', 'order line', true], ['layer', 'bronze', true],
    ]);
    expect(terms('a - b')).toEqual([['', 'a', false], ['', '-', false], ['', 'b', false]]);
  });

  it('reads key:value qualifiers, a quoted value with spaces, and the aliases column: and role:', () => {
    expect(terms('layer:Gold owner:"Data Team" col:customer_id Column:id role:fact')).toEqual([
      ['layer', 'gold', false], ['owner', 'data team', false], ['col', 'customer_id', false], ['col', 'id', false], ['type', 'fact', false],
    ]);
  });

  it('leaves out a key still being typed, so the view does not empty mid-word', () => {
    expect(terms('cust layer:')).toEqual([['', 'cust', false]]);
    expect(isEmptyQuery(parseTreeQuery('layer:'))).toBe(true);
    expect(isEmptyQuery(parseTreeQuery('   '))).toBe(true);
    expect(isEmptyQuery(undefined)).toBe(true);
  });

  it('searches an unknown key as plain text and reports it', () => {
    const q = parseTreeQuery('foo:bar cust', TABLE_LIBRARY_FILTER);
    expect(q.terms.map((t) => [t.key, t.value])).toEqual([[undefined, 'foo:bar'], [undefined, 'cust']]);
    expect(q.warnings).toEqual(['unknown filter key "foo:"']);
  });

  it('reports a key another view knows but this one does not, and searches it as text', () => {
    const q = parseTreeQuery('owner:finance', DIAGRAMS_FILTER);
    expect(q.terms).toEqual([{ value: 'owner:finance', text: 'owner:finance', negated: false }]);
    expect(q.warnings).toEqual(['"owner:" doesn\'t filter this view']);
  });

  it('does not read a time or a number as a key', () => {
    const q = parseTreeQuery('12:30');
    expect(q.terms).toEqual([{ value: '12:30', text: '12:30', negated: false }]);
    expect(q.warnings).toEqual([]);
  });

  it('reads is: values by prefix, and reports one the view has no flag for', () => {
    expect(parseTreeQuery('is:unused', TABLE_LIBRARY_FILTER).terms[0].flags).toEqual(['unused']);
    expect(parseTreeQuery('is:c', RELATIONSHIPS_FILTER).terms[0].flags).toEqual(['cross-layer', 'composite']);
    const odd = parseTreeQuery('is:unused', RELATIONSHIPS_FILTER);
    expect(odd.terms[0].flags).toEqual([]);
    expect(odd.warnings).toEqual(['"is:unused" is not a filter here (try is:problem, is:cross-layer, is:composite)']);
  });

  it('says which keys a query uses, and whether it is more than one plain word', () => {
    expect(queryUses(parseTreeQuery('a col:x'), 'col')).toBe(true);
    expect(queryUses(parseTreeQuery('-col:x'), 'col')).toBe(true);
    expect(queryUses(parseTreeQuery('a'), 'col')).toBe(false);
    expect(isStructuredQuery(parseTreeQuery('cust'))).toBe(false);
    for (const text of ['cust gold', 'layer:gold', '-stg', '"order line"']) {
      expect(isStructuredQuery(parseTreeQuery(text)), text).toBe(true);
    }
  });
});

describe('matchTreeQuery', () => {
  const subject: SearchSubject = {
    name: 'fct_order',
    nameKeys: ['table'],
    facets: [
      { key: 'layer', values: ['gold', 'Gold'] },
      { key: 'col', text: false, values: ['customer_key', 'amount'], reason: (v) => `column ${v}` },
      { values: ['Order lines from the shop'], reason: () => 'in description' },
      { key: 'diagram', text: false, values: ['sales'], reason: (v) => `on ${v}` },
    ],
    flags: ['unused'],
  };
  const match = (text: string) => matchTreeQuery(parseTreeQuery(text), subject);

  it('needs every word, in the name or anything plain words search', () => {
    expect(match('fct gold')).toBeDefined();
    expect(match('fct silver')).toBeUndefined();
    // A word only a column has: columns are searched by col: alone.
    expect(match('amount')).toBeUndefined();
    expect(match('col:amount')).toBeDefined();
  });

  it('highlights what matched the name, merged and in order', () => {
    expect(match('order fct')?.highlights).toEqual([[0, 3], [4, 9]]);
    expect(match('t_o fct')?.highlights).toEqual([[0, 5]]);
    expect(match('table:ORDER')?.highlights).toEqual([[4, 9]]);
  });

  it('says why it matched when the name did not: the column, the diagram, the description', () => {
    expect(match('col:cust')?.reasons).toEqual(['column customer_key']);
    expect(match('diagram:sal')?.reasons).toEqual(['on sales']);
    expect(match('shop')?.reasons).toEqual(['in description']);
    // A layer is shown by the tree itself: matched silently.
    expect(match('gold')?.reasons).toEqual([]);
    expect(match('fct')?.reasons).toEqual([]);
  });

  it('drops a row an exclusion matches', () => {
    expect(match('-fct')).toBeUndefined();
    expect(match('-col:amount')).toBeUndefined();
    expect(match('-silver fct')).toBeDefined();
  });

  it('matches is: flags, and an is: value with no flag matches nothing', () => {
    expect(match('is:unused')).toBeDefined();
    expect(match('-is:unused')).toBeUndefined();
    expect(matchTreeQuery(parseTreeQuery('is:problem', TABLE_LIBRARY_FILTER), subject)).toBeUndefined();
  });

  it('matches everything with an empty query', () => {
    expect(match('')).toEqual({ highlights: [], reasons: [] });
  });
});

describe('row helpers', () => {
  it('highlights a container label for plain words and its own keys only', () => {
    const q = parseTreeQuery('gold layer:old schema:x -go');
    expect(labelHighlights(q, 'Gold', ['layer'])).toEqual([[0, 4]]);
    expect(labelHighlights(q, 'Gold', [])).toEqual([[0, 4]]);
    expect(labelHighlights(undefined, 'Gold')).toEqual([]);
  });

  it('puts at most two reasons after a description', () => {
    expect(withReasons('on 2 diagrams', ['column a', 'on sales', 'in description'])).toBe('on 2 diagrams · column a · on sales');
    expect(withReasons(undefined, ['column a'])).toBe('column a');
    expect(withReasons('x', [])).toBe('x');
  });

  it('finds a role by its label, its key and its family', () => {
    expect(tableRoleValues('conformed-dim')).toEqual(['Conformed dimension', 'conformed-dim', 'dimension']);
    expect(tableRoleValues('periodic-snapshot')).toContain('fact');
    expect(tableRoleValues('factless-fact')).toEqual(expect.arrayContaining(['fact', 'bridge']));
    expect(tableRoleValues(undefined)).toEqual([]);
    const fact = tableSearchSubject({ name: 'fct_order', role: 'transaction-fact', diagrams: ['sales'] });
    expect(matchTreeQuery(parseTreeQuery('type:fact'), fact)?.reasons).toEqual(['Transaction fact']);
    expect(matchTreeQuery(parseTreeQuery('type:dim'), fact)).toBeUndefined();
  });

  it('builds the Table Library\'s table: unused only when on no diagram and not an ignored duplicate', () => {
    expect(tableSearchSubject({ name: 'a', diagrams: [] }).flags).toEqual(['unused']);
    expect(tableSearchSubject({ name: 'a', diagrams: ['x'] }).flags).toEqual([]);
    expect(tableSearchSubject({ name: 'a', diagrams: [], ignored: true }).flags).toEqual([]);
    const t = tableSearchSubject({ name: 'dim_customer', alias: 'customers', owner: 'Finance', schema: 'crm', layer: 'gold', layerLabel: 'Gold', diagrams: [] });
    for (const text of ['customers', 'owner:fin', 'schema:crm', 'layer:Gold', 'finance', 'table:customers']) {
      expect(matchTreeQuery(parseTreeQuery(text), t), text).toBeDefined();
    }
  });
});

describe('describeFilterOutcome', () => {
  const noun = { one: 'table', many: 'tables' };
  it('says how many of how many match, or that none do, then what the view could not use', () => {
    const q = parseTreeQuery('cust layer:gold');
    expect(describeFilterOutcome({ query: q, shown: 4, total: 52 }, noun)).toBe('Filtered: "cust layer:gold" — 4 of 52 tables');
    expect(describeFilterOutcome({ query: q, shown: 1, total: 1 }, noun)).toBe('Filtered: "cust layer:gold" — 1 of 1 table');
    expect(describeFilterOutcome({ query: q, shown: 0, total: 52 }, noun)).toBe('No tables match "cust layer:gold"');
    const odd = parseTreeQuery('foo:bar');
    expect(describeFilterOutcome({ query: odd, shown: 0, total: 3, reading: true }, noun))
      .toBe('No tables match "foo:bar" · unknown filter key "foo:" · reading table files…');
  });

  it('prompts with the keys the view knows', () => {
    expect(filterPrompt(TABLE_LIBRARY_FILTER)).toBe('Every word must match · "a phrase" · -exclude · layer: schema: owner: type: col: table: diagram: is:unused');
    expect(filterPrompt(DIAGRAMS_FILTER)).toBe('Every word must match · "a phrase" · -exclude · layer: schema: table: diagram:');
    expect(filterPrompt(RELATIONSHIPS_FILTER)).toContain('file: is:problem is:cross-layer is:composite');
  });
});
