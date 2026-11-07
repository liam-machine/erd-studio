import { describe, it, expect } from 'vitest';

import {
  FIELDS_FILE_NAME,
  FIELDS_FILE_PROBLEM_CODES,
  FIELDS_FILE_VERSION,
  parseFieldsText,
  renderFieldsText,
  type FieldsFileProblem,
} from '../../src/fieldsFile';
import { STARTING_FIELD_LIST, builtInField, type FieldList } from '../../src/fields';

const keys = (list: FieldList) => ({
  tables: list.tables.map((d) => d.key),
  columns: list.columns.map((d) => d.key),
  leftOut: list.leftOut,
});
const codes = (problems: FieldsFileProblem[]) => problems.map((p) => p.code);
const starting = keys(STARTING_FIELD_LIST);

/** The example from the design (§0), word for word. */
const DESIGN_EXAMPLE = `version: 1
tables:
  - grain                    # bare name = built-in, as shipped
  - purpose
  - key: decisions           # built-in with the team's own wording (label/guidance only)
    guidance: Choices finance signed off, and why.
  - open_questions
  - role
  - scd_strategy
  - measures
  - key: owner               # team field
    label: Owner
    type: value              # text (default) | value | choice | yes-no
    guidance: The team that owns it, e.g. crm-team.
    filled_by: dbt           # anyone (default) | people | dbt
  - key: sensitivity
    label: Sensitivity
    type: choice
    values: [public, internal, confidential]
    filled_by: people
    show_for: all            # dimensions | facts | all (default)
columns:
  - natural_key
  - scd_type
  - additive_type
  - key: pii
    label: Personal data
    type: yes-no
    filled_by: dbt
left_out: [dimension, metrics]   # dbt meta keys never copied (skill-only meaning)
`;

describe('parseFieldsText: the design example', () => {
  const { list, problems } = parseFieldsText(DESIGN_EXAMPLE);

  it('reads it without a problem', () => {
    expect(problems).toEqual([]);
  });

  it('keeps the list order and left_out', () => {
    expect(keys(list)).toEqual({
      tables: ['grain', 'purpose', 'decisions', 'open_questions', 'role', 'scd_strategy', 'measures', 'owner', 'sensitivity'],
      columns: ['natural_key', 'scd_type', 'additive_type', 'pii'],
      leftOut: ['dimension', 'metrics'],
    });
  });

  it('uses the catalogue\'s own definition for a bare name', () => {
    expect(list.tables[0]).toBe(builtInField('grain', 'table'));
    expect(list.columns[0]).toBe(builtInField('natural_key', 'column'));
  });

  it('overrides only the wording of a built-in', () => {
    expect(list.tables[2]).toEqual({ ...builtInField('decisions', 'table'), guidance: 'Choices finance signed off, and why.' });
  });

  it('resolves team fields fully', () => {
    expect(list.tables[7]).toEqual({
      key: 'owner', scope: 'table', label: 'Owner', type: 'value', guidance: 'The team that owns it, e.g. crm-team.',
      filledBy: 'dbt', showFor: 'all', status: 'team', home: { kind: 'meta' },
    });
    expect(list.tables[8]).toEqual({
      key: 'sensitivity', scope: 'table', label: 'Sensitivity', type: 'choice', values: ['public', 'internal', 'confidential'],
      filledBy: 'people', showFor: 'all', status: 'team', home: { kind: 'meta' },
    });
    expect(list.columns[3]).toEqual({
      key: 'pii', scope: 'column', label: 'Personal data', type: 'yes-no', filledBy: 'dbt', showFor: 'all', status: 'team', home: { kind: 'meta' },
    });
  });
});

describe('parseFieldsText: defaults and sections', () => {
  it('reads an empty or comment-only file as the starting set, with no problem', () => {
    for (const text of ['', '\n', '# nothing yet\n', '~\n', '---\n']) {
      const { list, problems } = parseFieldsText(text);
      expect(problems, JSON.stringify(text)).toEqual([]);
      expect(keys(list)).toEqual(starting);
    }
  });

  it('needs no version (1)', () => {
    expect(parseFieldsText('tables: [grain]\n').problems).toEqual([]);
    expect(FIELDS_FILE_VERSION).toBe(1);
    expect(FIELDS_FILE_NAME).toBe('fields.yml');
  });

  it('keeps the starting set\'s columns when only tables are listed, and the other way round', () => {
    expect(keys(parseFieldsText('tables:\n  - grain\n').list)).toEqual({ tables: ['grain'], columns: starting.columns, leftOut: [] });
    expect(keys(parseFieldsText('columns:\n  - natural_key\n').list)).toEqual({ tables: starting.tables, columns: ['natural_key'], leftOut: [] });
  });

  it('reads an explicit empty list, or a bare section key, as none', () => {
    expect(keys(parseFieldsText('tables: []\ncolumns: []\n').list)).toEqual({ tables: [], columns: [], leftOut: [] });
    expect(keys(parseFieldsText('tables:\ncolumns:\n').list)).toEqual({ tables: [], columns: [], leftOut: [] });
  });

  it('ignores unknown top-level keys and unknown entry keys', () => {
    const { list, problems } = parseFieldsText('owner_notes: hi\ntables:\n  - key: tier\n    colour: red\n');
    expect(problems).toEqual([]);
    expect(keys(list).tables).toEqual(['tier']);
  });

  it('defaults a team field: label = key, text, anyone, all', () => {
    expect(parseFieldsText('tables:\n  - key: tier\n').list.tables[0]).toEqual({
      key: 'tier', scope: 'table', label: 'tier', type: 'text', filledBy: 'anyone', showFor: 'all', status: 'team', home: { kind: 'meta' },
    });
  });

  it('lets a column field of the team use a key that is a table built-in', () => {
    const { list, problems } = parseFieldsText('columns:\n  - key: purpose\n    label: Why\n');
    expect(problems).toEqual([]);
    expect(list.columns[0]).toMatchObject({ key: 'purpose', scope: 'column', status: 'team', home: { kind: 'meta' } });
  });

  it('reads business_rule as the column built-in', () => {
    expect(parseFieldsText('columns: [business_rule]\n').list.columns[0]).toBe(builtInField('business_rule', 'column'));
  });

  it('reads left_out: a list, a single key, or nothing; deduplicated', () => {
    expect(parseFieldsText('left_out: [a, b, a, " c "]\n').list.leftOut).toEqual(['a', 'b', 'c']);
    expect(parseFieldsText('left_out: dimension\n').list.leftOut).toEqual(['dimension']);
    expect(parseFieldsText('left_out:\n').list.leftOut).toEqual([]);
    expect(parseFieldsText('left_out: [1, true]\n').list.leftOut).toEqual(['1', 'true']);
  });

  it('follows anchors and aliases', () => {
    const text = 'shared: &own\n  key: owner\n  type: value\ntables:\n  - *own\n';
    const { list, problems } = parseFieldsText(text);
    expect(problems).toEqual([]);
    expect(list.tables[0]).toMatchObject({ key: 'owner', type: 'value' });
  });

  it('accepts a quoted version', () => {
    expect(parseFieldsText("version: '1'\n").problems).toEqual([]);
  });
});

describe('parseFieldsText: problems', () => {
  const only = (text: string) => {
    const { problems } = parseFieldsText(text);
    expect(problems).toHaveLength(1);
    return problems[0];
  };

  it('fieldsYamlInvalid: not YAML → the starting set, with the line', () => {
    const { list, problems } = parseFieldsText('tables:\n  - grain\n  key: [\n');
    expect(codes(problems)).toEqual(['fieldsYamlInvalid']);
    expect(problems[0].severity).toBe('error');
    expect(problems[0].line).toBeGreaterThan(0);
    expect(keys(list)).toEqual(starting);
  });

  it('fieldsYamlInvalid: a duplicated top-level key', () => {
    expect(only('tables: []\ntables: [grain]\n').code).toBe('fieldsYamlInvalid');
  });

  it('fieldsYamlInvalid: not a map → the starting set', () => {
    for (const text of ['- grain\n', 'grain\n', '42\n']) {
      const { list, problems } = parseFieldsText(text);
      expect(codes(problems)).toEqual(['fieldsYamlInvalid']);
      expect(problems[0].message).toMatch(/must be a map/);
      expect(keys(list)).toEqual(starting);
    }
  });

  it('fieldsYamlInvalid: a git merge conflict, at its first marker', () => {
    const text = 'tables:\n<<<<<<< HEAD\n  - grain\n=======\n  - purpose\n>>>>>>> other\n';
    const p = only(text);
    expect(p).toMatchObject({ code: 'fieldsYamlInvalid', line: 2 });
    expect(p.message).toMatch(/merge conflict/);
  });

  it('fieldsSectionInvalid: a section that is not a list → that section\'s starting set', () => {
    const { list, problems } = parseFieldsText('tables: grain\ncolumns: [natural_key]\n');
    expect(problems).toEqual([expect.objectContaining({ code: 'fieldsSectionInvalid', severity: 'error', line: 1 })]);
    expect(keys(list)).toEqual({ tables: starting.tables, columns: ['natural_key'], leftOut: [] });
    expect(only('columns: {a: b}\n').code).toBe('fieldsSectionInvalid');
    const leftOut = parseFieldsText('left_out: {a: b}\n');
    expect(codes(leftOut.problems)).toEqual(['fieldsSectionInvalid']);
    expect(leftOut.list.leftOut).toEqual([]);
  });

  it('fieldsEntryInvalid: an entry that is neither a name nor a map with a key → skipped', () => {
    for (const entry of ['- 42', '- ', '- [a, b]', '- {label: Owner}', '- {key: ""}', '- {key: [a]}', '- true']) {
      const { list, problems } = parseFieldsText(`tables:\n  - grain\n  ${entry}\n`);
      expect(codes(problems), entry).toEqual(['fieldsEntryInvalid']);
      expect(problems[0]).toMatchObject({ severity: 'error', line: 3 });
      expect(keys(list).tables).toEqual(['grain']);
    }
    expect(only('left_out: [a, [b]]\n').code).toBe('fieldsEntryInvalid');
  });

  it('fieldsKeyInvalid: a key that is not lower-case snake case → skipped, with a hint', () => {
    const p = only('tables:\n  - key: Owner Name\n');
    expect(p).toMatchObject({ code: 'fieldsKeyInvalid', severity: 'error', key: 'Owner Name', line: 2 });
    expect(p.message).toMatch(/Try owner_name/);
    expect(only('tables:\n  - key: 9lives\n').code).toBe('fieldsKeyInvalid');
    expect(only('tables:\n  - key: café\n').code).toBe('fieldsKeyInvalid');
  });

  it('fieldsKeyReserved: DBML and ERD Studio names → skipped, with the approved wording', () => {
    expect(only('tables:\n  - key: note\n')).toMatchObject({
      code: 'fieldsKeyReserved', severity: 'error', key: 'note',
      message: 'note is a DBML setting and cannot be a field. Pick another key.',
    });
    for (const key of ['schema', 'alias', 'meta_json', 'json', 'dbml', 'erd_owner', 'rationale_x', 'meta_owner', 'constructor', '__proto__', 'pk', 'not_null']) {
      expect(only(`columns:\n  - key: ${key}\n`).code, key).toBe('fieldsKeyReserved');
    }
    expect(only('tables:\n  - key: natural_key\n').message).toMatch(/built-in column field/);
    expect(only('columns:\n  - key: grain\n').message).toMatch(/built-in table field/);
    expect(only('tables:\n  - key: erd_x\n').message).toMatch(/starts with erd_/);
  });

  it('fieldsKeyDuplicate: the later copy is skipped, bare or not', () => {
    const { list, problems } = parseFieldsText('tables:\n  - purpose\n  - key: owner\n  - key: purpose\n    label: Why\n  - owner\n  - key: owner\n');
    expect(codes(problems)).toEqual(['fieldsKeyDuplicate', 'fieldsUnknownName', 'fieldsKeyDuplicate']);
    expect(problems[0]).toMatchObject({ key: 'purpose', line: 4, severity: 'error' });
    expect(problems[2]).toMatchObject({ key: 'owner', line: 7 });
    expect(keys(list).tables).toEqual(['purpose', 'owner']);
    expect(list.tables[0].label).toBe('Purpose');
  });

  it('allows the same key once per section', () => {
    expect(parseFieldsText('tables: [{key: owner}]\ncolumns: [{key: owner}]\n').problems).toEqual([]);
  });

  it('fieldsTypeInvalid: an unknown type → text', () => {
    const { list, problems } = parseFieldsText('tables:\n  - key: tier\n    type: number\n');
    expect(problems).toEqual([expect.objectContaining({ code: 'fieldsTypeInvalid', severity: 'error', key: 'tier', line: 3 })]);
    expect(list.tables[0].type).toBe('text');
    expect(only('tables:\n  - key: tier\n    type: [a]\n').code).toBe('fieldsTypeInvalid');
  });

  it('fieldsChoiceWithoutValues: a choice with fewer than two values → text', () => {
    for (const values of ['', '    values: [only]\n', '    values: []\n', '    values: a, b\n', '    values: [a, a, " "]\n']) {
      const { list, problems } = parseFieldsText(`tables:\n  - key: tier\n    type: choice\n${values}`);
      expect(codes(problems), values).toEqual(['fieldsChoiceWithoutValues']);
      expect(list.tables[0].type).toBe('text');
      expect(list.tables[0].values).toBeUndefined();
    }
  });

  it('reads choice values as trimmed, deduplicated text', () => {
    const { list } = parseFieldsText('tables:\n  - key: tier\n    type: choice\n    values: [1, 2, " 2 ", gold]\n');
    expect(list.tables[0].values).toEqual(['1', '2', 'gold']);
  });

  it('ignores values on a field that is not a choice', () => {
    const { list, problems } = parseFieldsText('tables:\n  - key: tier\n    values: [a, b]\n');
    expect(problems).toEqual([]);
    expect(list.tables[0].values).toBeUndefined();
  });

  it('fieldsFilledByInvalid and fieldsShowForInvalid → the default', () => {
    const { list, problems } = parseFieldsText('tables:\n  - key: tier\n    filled_by: robots\n    show_for: bridges\n');
    expect(problems.map((p) => [p.code, p.severity, p.line])).toEqual([
      ['fieldsFilledByInvalid', 'error', 3],
      ['fieldsShowForInvalid', 'error', 4],
    ]);
    expect(list.tables[0]).toMatchObject({ filledBy: 'anyone', showFor: 'all' });
  });

  it('reads show_for dimensions and facts', () => {
    const { list } = parseFieldsText('tables:\n  - {key: a, show_for: dimensions}\n  - {key: b, show_for: facts}\n');
    expect(list.tables.map((d) => d.showFor)).toEqual(['dimensions', 'facts']);
  });

  it('fieldsUnknownName: a bare name that is not a built-in → skipped, with the closest built-in', () => {
    expect(only('tables:\n  - purpse\n')).toMatchObject({
      code: 'fieldsUnknownName', severity: 'warning', key: 'purpse', line: 2,
      message: 'purpse is not a built-in field. Did you mean purpose?',
    });
    expect(only('tables:\n  - Open Questions\n').message).toMatch(/Did you mean open_questions\?/);
    expect(only('tables:\n  - owner\n').message).toMatch(/- key: owner/);
    expect(only('tables:\n  - natural_key\n').message).toMatch(/column field. List it under columns:/);
    expect(only('columns:\n  - purpose\n').message).toMatch(/table field. List it under tables:/);
    const { list } = parseFieldsText('tables:\n  - purpse\n  - grain\n');
    expect(keys(list).tables).toEqual(['grain']);
  });

  it('never suggests a retired field', () => {
    expect(only('tables:\n  - desgn\n').message).not.toMatch(/design/);
  });

  it('fieldsBuiltInOverride: a built-in\'s type, values, show_for or home are ignored', () => {
    const { list, problems } = parseFieldsText(
      'tables:\n  - key: role\n    type: text\n    values: [a, b]\n    show_for: facts\n    home: meta\n    label: Kind\n');
    expect(problems).toEqual([expect.objectContaining({ code: 'fieldsBuiltInOverride', severity: 'warning', key: 'role', line: 2 })]);
    expect(problems[0].message).toMatch(/type, values, show_for, home are ignored/);
    expect(list.tables[0]).toEqual({ ...builtInField('role', 'table'), label: 'Kind' });
  });

  it('lets a built-in override its label, guidance and filled_by (A28)', () => {
    const { list, problems } = parseFieldsText(
      'tables:\n  - key: freshness\n    label: SLA\n    guidance: Hours late before anyone pages.\n    filled_by: dbt\n');
    expect(problems).toEqual([]);
    expect(list.tables[0]).toEqual({
      ...builtInField('freshness', 'table'), label: 'SLA', guidance: 'Hours late before anyone pages.', filledBy: 'dbt',
    });
    // The catalogue itself is untouched.
    expect(builtInField('freshness', 'table')!.label).toBe('Freshness');
  });

  it('keeps the catalogue object for a map entry that overrides nothing', () => {
    expect(parseFieldsText('tables:\n  - key: purpose\n').list.tables[0]).toBe(builtInField('purpose', 'table'));
  });

  it('fieldsFilledByInvalid on a built-in keeps the built-in\'s filled_by', () => {
    const { list, problems } = parseFieldsText('tables:\n  - key: retention\n    filled_by: robots\n');
    expect(codes(problems)).toEqual(['fieldsFilledByInvalid']);
    expect(list.tables[0].filledBy).toBe('people');
  });

  it('fieldsRetiredListed: a retired built-in is accepted and still listed', () => {
    const { list, problems } = parseFieldsText('tables:\n  - design\n  - key: grain_choice\n    label: Why this grain\n');
    expect(problems.map((p) => [p.code, p.severity, p.key])).toEqual([
      ['fieldsRetiredListed', 'warning', 'design'],
      ['fieldsRetiredListed', 'warning', 'grain_choice'],
    ]);
    expect(keys(list).tables).toEqual(['design', 'grain_choice']);
    expect(list.tables[1].label).toBe('Why this grain');
    expect(problems[0].message).toMatch(/Move to Decisions, or to Purpose\./);
  });

  it('fieldsVersionNewer: reads what it understands', () => {
    const { list, problems } = parseFieldsText('version: 2\ntables: [grain]\n');
    expect(problems).toEqual([expect.objectContaining({ code: 'fieldsVersionNewer', severity: 'warning', line: 1 })]);
    expect(keys(list).tables).toEqual(['grain']);
  });

  it('fieldsVersionInvalid: a version that is not a whole number of at least 1 reads as 1', () => {
    for (const version of ['0', 'one', '1.5', '[1]', '-1']) {
      const { list, problems } = parseFieldsText(`version: ${version}\ntables: [grain]\n`);
      expect(codes(problems), version).toEqual(['fieldsVersionInvalid']);
      expect(keys(list).tables).toEqual(['grain']);
    }
  });

  it('fieldsPropertyInvalid: a label or guidance that is not text is ignored', () => {
    const { list, problems } = parseFieldsText('tables:\n  - key: tier\n    label: [a]\n    guidance: {x: y}\n');
    expect(codes(problems)).toEqual(['fieldsPropertyInvalid', 'fieldsPropertyInvalid']);
    expect(list.tables[0]).toMatchObject({ label: 'tier' });
    expect(list.tables[0].guidance).toBeUndefined();
  });

  it('every code it emits is listed, and the list has no duplicates', () => {
    expect(new Set(FIELDS_FILE_PROBLEM_CODES).size).toBe(FIELDS_FILE_PROBLEM_CODES.length);
    expect(FIELDS_FILE_PROBLEM_CODES).toEqual(expect.arrayContaining([
      'fieldsYamlInvalid', 'fieldsEntryInvalid', 'fieldsKeyInvalid', 'fieldsKeyReserved', 'fieldsKeyDuplicate',
      'fieldsTypeInvalid', 'fieldsChoiceWithoutValues', 'fieldsUnknownName', 'fieldsBuiltInOverride',
      'fieldsRetiredListed', 'fieldsVersionNewer', 'fieldsFilledByInvalid', 'fieldsShowForInvalid',
    ]));
  });

  it('messages name no file (the host adds the path)', () => {
    const { problems } = parseFieldsText('version: 9\ntables:\n  - purpse\n  - key: note\n  - key: X\n');
    for (const p of problems) expect(p.message).not.toMatch(/^fields\.yml/);
  });
});

describe('parseFieldsText: untrusted files', () => {
  const laughs = [
    'a: &a [x, x, x, x, x, x, x, x, x, x]',
    'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
    'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
    'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
    'tables:',
    '  - key: tier',
    '    type: choice',
    '    values: *d',
  ].join('\n');

  it('never expands aliases it does not read', () => {
    // A choice's values must be text: nested lists are rejected without being walked.
    const { problems } = parseFieldsText(laughs, { maxNodes: 200 });
    expect(codes(problems)).toEqual(['fieldsChoiceWithoutValues']);
  });

  it('reports a file over the node budget, never expanding it', () => {
    const pairs = Array.from({ length: 100 }, (_, i) => `k${i}: v`).join(', ');
    const text = `m: &m {${pairs}, key: tier}\ntables: [${Array.from({ length: 50 }, () => '*m').join(', ')}]\n`;
    expect(codes(parseFieldsText(text).problems).every((c) => c === 'fieldsKeyDuplicate')).toBe(true);
    const { list, problems } = parseFieldsText(text, { maxNodes: 1000 });
    expect(problems).toEqual([expect.objectContaining({ code: 'fieldsYamlInvalid', severity: 'error' })]);
    expect(problems[0].message).toMatch(/too large/);
    expect(keys(list)).toEqual(starting);
  });

  it('reports a file over the character budget', () => {
    const long = 'x'.repeat(500);
    const text = `g: &g "${long}"\ntables:\n  - key: a\n    guidance: *g\n  - key: b\n    guidance: *g\n  - key: c\n    guidance: *g\n`;
    expect(parseFieldsText(text, { maxChars: 1000 }).problems[0]).toMatchObject({ code: 'fieldsYamlInvalid' });
    expect(parseFieldsText(text, { maxChars: 10_000 }).problems).toEqual([]);
  });

  it('survives an alias inside its own anchor', () => {
    expect(() => parseFieldsText('tables: &t [*t]\n')).not.toThrow();
    expect(codes(parseFieldsText('tables: &t [*t]\n').problems)).toEqual(['fieldsEntryInvalid']);
  });

  it('keeps __proto__ and constructor as data', () => {
    const { problems } = parseFieldsText('__proto__: {tables: []}\ntables:\n  - key: __proto__\n');
    expect(codes(problems)).toEqual(['fieldsKeyReserved']);
    expect(({} as Record<string, unknown>).tables).toBeUndefined();
  });

  it('never throws on any text', () => {
    for (const text of ['\t', ':', '- - -', '!!binary x', '{', 'tables: !!set {a, b}', '&a *a', 'tables: [*nope]', '\u0000']) {
      expect(() => parseFieldsText(text), JSON.stringify(text)).not.toThrow();
    }
    expect(() => parseFieldsText(undefined as unknown as string)).not.toThrow();
  });

  it('rejects a budget that is not a number, as parseTableText does', () => {
    expect(() => parseFieldsText('', { maxNodes: Number.NaN })).toThrow(TypeError);
    expect(() => parseFieldsText('', { maxChars: -1 })).toThrow(TypeError);
  });

  it('returns fresh lists each time (nothing shared with the starting set)', () => {
    const a = parseFieldsText('').list;
    a.tables.pop();
    expect(parseFieldsText('').list.tables).toHaveLength(STARTING_FIELD_LIST.tables.length);
    expect(STARTING_FIELD_LIST.tables).toHaveLength(7);
  });
});

describe('renderFieldsText', () => {
  it('renders the starting set as bare names, which read back without a problem', () => {
    const text = renderFieldsText(STARTING_FIELD_LIST);
    expect(text).toContain('version: 1\ntables:\n  - grain\n  - purpose\n  - decisions\n  - open_questions\n  - role\n  - scd_strategy\n  - measures\ncolumns:\n  - natural_key\n  - scd_type\n  - additive_type\n');
    expect(text.startsWith('#')).toBe(true);
    expect(text).not.toContain('left_out');
    const back = parseFieldsText(text);
    expect(back.problems).toEqual([]);
    expect(back.list).toEqual(STARTING_FIELD_LIST);
  });

  it('round-trips the design example', () => {
    const { list } = parseFieldsText(DESIGN_EXAMPLE);
    const text = renderFieldsText(list);
    const back = parseFieldsText(text);
    expect(back.problems).toEqual([]);
    expect(back.list).toEqual(list);
    expect(text).toContain('values: [public, internal, confidential]');
    expect(text).toContain('left_out: [dimension, metrics]');
    expect(text).toContain('  - key: decisions\n    guidance: Choices finance signed off, and why.\n');
  });

  it('quotes text YAML would misread', () => {
    const { list } = parseFieldsText('tables:\n  - key: tier\n    label: "yes"\n    guidance: "a: b # c"\n');
    const back = parseFieldsText(renderFieldsText(list));
    expect(back.list.tables[0]).toMatchObject({ label: 'yes', guidance: 'a: b # c' });
  });
});
