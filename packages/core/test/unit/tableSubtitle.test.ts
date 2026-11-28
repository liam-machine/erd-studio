/**
 * The choice of what the line under a table's name shows (`tableSubtitle.ts`,
 * #367): one string, `field:<key>`, `description` or `none`, read the same
 * way by the extension's setting, the canvas message and `ErdCanvas`'s prop.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TABLE_SUBTITLE,
  FIELD_KEY_PATTERN,
  TABLE_SUBTITLE_DESCRIPTION,
  TABLE_SUBTITLE_KEY_MAX,
  TABLE_SUBTITLE_NONE,
  isReservedFieldKey,
  isTableSubtitle,
  normaliseTableSubtitle,
  parseFieldsText,
  resolveTableFields,
  tableSubtitleFieldKey,
  tableSubtitleIsRow,
  tableSubtitleOfField,
  tableSubtitleRow,
  type DisplayTable,
} from '../../src/index';

const table = (extra: Partial<DisplayTable> = {}): DisplayTable => ({
  name: 'dim_customer',
  schema: 'sales',
  description: 'Every customer.',
  columns: [],
  ...extra,
});

describe('the choice', () => {
  it('is the grain by default', () => {
    expect(DEFAULT_TABLE_SUBTITLE).toBe('field:grain');
    expect(isTableSubtitle(DEFAULT_TABLE_SUBTITLE)).toBe(true);
  });

  it('is a field, the description, or nothing', () => {
    for (const value of ['field:grain', 'field:owner', 'field:Data Owner', 'field:none', 'field:description', 'description', 'none']) {
      expect(isTableSubtitle(value)).toBe(true);
      expect(normaliseTableSubtitle(value)).toBe(value);
    }
  });

  it.each([
    undefined, null, 7, true, {}, ['none'], '', 'grain', 'owner', 'Description', 'NONE', 'note', 'meta:owner',
    'field:', 'field: owner', 'field:owner ', 'field:own\ner', 'Field:owner', `field:${'k'.repeat(TABLE_SUBTITLE_KEY_MAX + 1)}`,
  ])('reads %j as the grain', (value) => {
    expect(isTableSubtitle(value)).toBe(false);
    expect(normaliseTableSubtitle(value)).toBe(DEFAULT_TABLE_SUBTITLE);
  });

  it('a team field can be named `description` or `none` without being taken for the two choices', () => {
    // Both are legal field keys, which is why a field choice carries a prefix.
    for (const key of [TABLE_SUBTITLE_DESCRIPTION, TABLE_SUBTITLE_NONE]) {
      expect(FIELD_KEY_PATTERN.test(key)).toBe(true);
      expect(isReservedFieldKey(key, 'table')).toBe(false);
      expect(tableSubtitleFieldKey(key)).toBeUndefined();
      expect(tableSubtitleFieldKey(tableSubtitleOfField(key))).toBe(key);
    }
  });

  it('gives the key of a field choice only', () => {
    expect(tableSubtitleFieldKey('field:open_questions')).toBe('open_questions');
    expect(tableSubtitleFieldKey(`field:${'k'.repeat(TABLE_SUBTITLE_KEY_MAX)}`)).toHaveLength(TABLE_SUBTITLE_KEY_MAX);
    expect(tableSubtitleFieldKey('description')).toBeUndefined();
    expect(tableSubtitleFieldKey('none')).toBeUndefined();
    expect(tableSubtitleFieldKey(undefined)).toBeUndefined();
  });
});

describe('the row a field choice shows', () => {
  const list = parseFieldsText('version: 1\ntables:\n  - grain\n  - purpose\n  - key: owner\n    label: Owner\n').list;

  it('is the resolver\'s row for that field', () => {
    const t = table({ grain: 'One row per customer', rationale: { purpose: 'The customer list.' }, meta: { owner: 'crm-team' } });
    expect(tableSubtitleRow(t, 'field:grain', list)?.value).toBe('One row per customer');
    expect(tableSubtitleRow(t, 'field:purpose', list)?.value).toBe('The customer list.');
    expect(tableSubtitleRow(t, 'field:owner', list)?.value).toBe('crm-team');
    expect(tableSubtitleRow(t, 'field:owner', list)?.definition.label).toBe('Owner');
  });

  it('is found for a value no list names, and with no list at all', () => {
    const t = table({ meta: { steward: 'ana' }, rationale: { freshness: 'Hourly.' } });
    expect(tableSubtitleRow(t, 'field:steward')?.value).toBe('ana');
    expect(tableSubtitleRow(t, 'field:steward')?.source).toBe('notInList');
    // An optional built-in the starting set leaves out.
    expect(tableSubtitleRow(t, 'field:freshness')?.value).toBe('Hourly.');
  });

  it('has no value, or is not there, when the table has nothing for the field: never another field\'s', () => {
    const t = table({ grain: 'One row per customer' });
    expect(tableSubtitleRow(t, 'field:purpose', list)?.value).toBeUndefined();
    expect(tableSubtitleRow(t, 'field:owner', list)?.value).toBeUndefined();
    expect(tableSubtitleRow(t, 'field:steward', list)).toBeUndefined();
  });

  it('`field:purpose` is the built-in Purpose, not a `meta.purpose` kept beside it', () => {
    const t = table({ meta: { purpose: 'from meta' }, rationale: { purpose: 'from rationale' } });
    expect(tableSubtitleRow(t, 'field:purpose', list)?.id).toBe('rationale:purpose');
    expect(tableSubtitleRow(t, 'field:purpose', list)?.value).toBe('from rationale');
    const rows = resolveTableFields(t, list);
    expect(rows.filter((row) => tableSubtitleIsRow('field:purpose', row)).map((row) => row.id)).toEqual(['rationale:purpose']);
  });

  it('is undefined for the description, for nothing, and for what is not a choice', () => {
    const t = table({ grain: 'One row per customer' });
    for (const choice of ['description', 'none', 'grain', undefined, 7]) expect(tableSubtitleRow(t, choice, list)).toBeUndefined();
  });

  it('never throws on a table or a list of any shape', () => {
    expect(tableSubtitleRow(null as unknown as DisplayTable, 'field:grain')).toBeUndefined();
    expect(tableSubtitleRow(table({ meta: 7 as never }), 'field:owner', { tables: 'x' } as never)).toBeUndefined();
  });
});
