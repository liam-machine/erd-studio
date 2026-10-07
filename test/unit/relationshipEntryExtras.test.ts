/**
 * Which comments belong to a model file's relationship entry (#133 review):
 * a comment the parser attaches to the entry itself — a flow entry's
 * trailing comment, or one indented under a block entry at its end — is the
 * entry's, so taking the entry out would lose it.
 */
import { describe, it, expect } from 'vitest';

import { COMMENTS, yamlEntryExtras } from '../../src/services/relationshipEntryExtras';

const file = (...lines: string[]): string => ['name: fct', 'relationships:', ...lines, ''].join('\n');

describe('yamlEntryExtras — comments on the entry itself', () => {
  it('counts a flow entry\'s trailing comment', () => {
    const text = file(
      '  - { fromColumn: a, toModel: dim, toColumn: id } # legacy SAP link, keep',
      '  - { fromColumn: b, toModel: dim, toColumn: id }',
    );
    expect([...yamlEntryExtras(text)]).toEqual([[0, [COMMENTS]]]);
  });

  it('counts a comment indented under a block entry at its end, whether or not another entry follows', () => {
    const entry = ['  - fromColumn: dim_id', '    toModel: dim', '    toColumn: id', '    cardinality: one-to-one', '    # Agreed with finance 2024-03'];
    expect([...yamlEntryExtras(file(...entry))]).toEqual([[0, [COMMENTS]]]);
    expect([...yamlEntryExtras(file(...entry, '  - fromColumn: x', '    toModel: dim', '    toColumn: id'))]).toEqual([[0, [COMMENTS]]]);
  });

  it('counts a comment on the entry\'s dash line and one inside a multi-line flow entry', () => {
    expect([...yamlEntryExtras(file('  - # note', '    fromColumn: a', '    toModel: dim', '    toColumn: id'))]).toEqual([[0, [COMMENTS]]]);
    expect([...yamlEntryExtras(file('  - { fromColumn: a, # inside', '      toModel: dim, toColumn: id }'))]).toEqual([[0, [COMMENTS]]]);
  });

  it('does not count a comment above an entry, at the list\'s own indent after the last one, or a # inside a value', () => {
    expect([...yamlEntryExtras(file(
      '  # above the first',
      '  - fromColumn: a',
      '    toModel: dim',
      '    toColumn: id',
      '  # above the second',
      '  - fromColumn: b',
      '    toModel: dim',
      '    toColumn: id',
      '    role: "ship # 2"',
      '  # after the last, at the list indent',
    ))]).toEqual([]);
  });
});
