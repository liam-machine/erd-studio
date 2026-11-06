import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  BUILT_IN_FIELDS,
  DBML_IMPORT_META_KEY,
  DBML_SETTING_NAMES,
  DIMENSION_ROLES,
  ERD_SETTING_NAMES,
  FACT_ROLES,
  FIELD_KEY_PATTERN,
  RATIONALE_FIELD_KEYS,
  RESERVED_FIELD_KEY_PREFIXES,
  STARTING_FIELD_LIST,
  TABLE_ROLE_VALUES,
  builtInField,
  fieldApplies,
  fieldKeyToRationaleKey,
  fieldRowId,
  isBareMetaKey,
  isDimensionRole,
  isFactRole,
  isRationaleFieldKey,
  isReservedFieldKey,
  metaFieldDefinition,
  metaSpellingNames,
  rationaleKeyToFieldKey,
  rationaleSpellingNames,
  reservedFieldKeyReason,
  resolveColumnFields,
  resolveTableFields,
  type FieldDefinition,
  type FieldList,
  type FieldRow,
} from '../../src/fields';
import {
  DBML_RICH_COLUMN_PROPERTIES,
  DBML_RICH_META_JSON_PROPERTY,
  DBML_RICH_META_PREFIX,
  DBML_RICH_NOTE_PROPERTIES,
  DBML_RICH_PLACEHOLDER_PROPERTY,
  DBML_RICH_PROPERTY_PREFIX,
  DBML_RICH_RATIONALE_PREFIX,
  DBML_RICH_TABLE_PROPERTIES,
} from '../../src/dbmlRichProperties';
import * as core from '../../src/index';
import type { DisplayColumn, DisplayTable } from '../../src/types/display';
import type { Rationale } from '../../src/types/semantic';

const table = (over: Partial<DisplayTable> = {}): DisplayTable => ({
  name: 't', schema: 's', description: '', columns: [], ...over,
});
const column = (over: Partial<DisplayColumn> = {}): DisplayColumn => ({
  name: 'c', dataType: 'int', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false, ...over,
});
const ids = (rows: FieldRow[]): string[] => rows.map((r) => r.id);
const row = (rows: FieldRow[], id: string): FieldRow | undefined => rows.find((r) => r.id === id);

describe('the catalogue', () => {
  it('lists every built-in in catalogue order', () => {
    expect(BUILT_IN_FIELDS.map((d) => `${d.scope}:${d.key}`)).toEqual([
      'table:grain', 'table:purpose', 'table:decisions', 'table:open_questions', 'table:role',
      'table:scd_strategy', 'table:measures', 'table:source_of_truth', 'table:freshness',
      'table:known_issues', 'table:retention', 'table:design', 'table:role_choice', 'table:grain_choice',
      'column:natural_key', 'column:scd_type', 'column:additive_type', 'column:business_rule',
    ]);
  });

  it('gives each built-in its label, type, status, home and rules', () => {
    const summary = BUILT_IN_FIELDS.map((d) => [d.key, d.label, d.type, d.status, d.home.kind, d.showFor, d.filledBy]);
    expect(summary).toEqual([
      ['grain', 'Grain', 'text', 'starting', 'grain', 'all', 'anyone'],
      ['purpose', 'Purpose', 'text', 'starting', 'rationale', 'all', 'anyone'],
      ['decisions', 'Decisions', 'text', 'starting', 'rationale', 'all', 'anyone'],
      ['open_questions', 'Open questions', 'text', 'starting', 'rationale', 'all', 'anyone'],
      ['role', 'Table role', 'choice', 'starting', 'role', 'all', 'anyone'],
      ['scd_strategy', 'History', 'text', 'starting', 'rationale', 'dimensions', 'anyone'],
      ['measures', 'Measures', 'text', 'starting', 'rationale', 'facts', 'anyone'],
      ['source_of_truth', 'Source of truth', 'value', 'optional', 'rationale', 'all', 'anyone'],
      ['freshness', 'Freshness', 'text', 'optional', 'rationale', 'all', 'anyone'],
      ['known_issues', 'Known issues', 'text', 'optional', 'rationale', 'all', 'anyone'],
      ['retention', 'Retention', 'text', 'optional', 'rationale', 'all', 'people'],
      ['design', 'Design', 'text', 'retired', 'rationale', 'all', 'anyone'],
      ['role_choice', 'Role choice', 'text', 'retired', 'rationale', 'all', 'anyone'],
      ['grain_choice', 'Grain choice', 'text', 'retired', 'rationale', 'all', 'anyone'],
      ['natural_key', 'Natural key', 'yes-no', 'starting', 'naturalKey', 'all', 'anyone'],
      ['scd_type', 'SCD type', 'choice', 'starting', 'scdType', 'dimensions', 'anyone'],
      ['additive_type', 'Additivity', 'choice', 'starting', 'additiveType', 'facts', 'anyone'],
      ['business_rule', 'Business rule', 'text', 'optional', 'meta', 'all', 'anyone'],
    ]);
  });

  it('uses the approved guidance wording', () => {
    const guidance = Object.fromEntries(BUILT_IN_FIELDS.map((d) => [`${d.scope}:${d.key}`, d.guidance]));
    expect(guidance['table:grain']).toBe('One row per ___. The one sentence that says what a row is.');
    expect(guidance['table:purpose']).toBe('Who uses this table and the question it answers.');
    expect(guidance['table:decisions']).toBe('A choice a later editor might undo, and why.');
    expect(guidance['table:open_questions']).toBe('What is still undecided. Assistants ask about these and never guess.');
    expect(guidance['table:role']).toBe('Which kind of table this is: conformed-dim, transaction-fact, …');
    expect(guidance['table:scd_strategy']).toBe('How this dimension keeps history: which columns track changes and which overwrite.');
    expect(guidance['table:measures']).toBe('How the measures add up: which sum across every dimension and which do not.');
    expect(guidance['table:source_of_truth']).toBe('The system this data is mastered in.');
    expect(guidance['table:freshness']).toBe('How fresh it must be, and how often it loads.');
    expect(guidance['table:known_issues']).toBe('Data problems a consumer should know before trusting a number.');
    expect(guidance['table:retention']).toBe('How long rows are kept, and why.');
    expect(guidance['table:design']).toBe('Move to Decisions, or to Purpose.');
    expect(guidance['table:role_choice']).toBe('Move to Decisions.');
    expect(guidance['table:grain_choice']).toBe('Move to Decisions.');
    expect(guidance['column:natural_key']).toBe('The business identifier, like an order number or a customer code.');
    expect(guidance['column:scd_type']).toBe('0 never changes, 1 overwrites, 2 keeps history.');
    expect(guidance['column:additive_type']).toBe('Additive, semi-additive or non-additive.');
    expect(guidance['column:business_rule']).toBe('How the value is worked out, in business terms.');
  });

  it('gives choices their values: the role list, SCD 0/1/2, additivity', () => {
    expect(builtInField('role', 'table')!.values).toEqual([...TABLE_ROLE_VALUES]);
    expect(builtInField('scd_type', 'column')!.values).toEqual(['0', '1', '2']);
    expect(builtInField('additive_type', 'column')!.values).toEqual(['additive', 'semi-additive', 'non-additive']);
    for (const def of BUILT_IN_FIELDS) {
      if (def.type === 'choice') expect(def.values!.length).toBeGreaterThanOrEqual(2);
      else expect(def.values).toBeUndefined();
    }
  });

  it('keeps every key a valid, unique field key per scope', () => {
    const seen = new Set<string>();
    for (const def of BUILT_IN_FIELDS) {
      expect(FIELD_KEY_PATTERN.test(def.key)).toBe(true);
      expect(seen.has(`${def.scope}:${def.key}`)).toBe(false);
      seen.add(`${def.scope}:${def.key}`);
      if (def.home.kind === 'rationale') {
        expect(rationaleKeyToFieldKey(def.home.key)).toBe(def.key);
        expect(def.scope).toBe('table');
      }
    }
  });

  it('is frozen, as is the starting set', () => {
    expect(Object.isFrozen(BUILT_IN_FIELDS)).toBe(true);
    for (const def of BUILT_IN_FIELDS) {
      expect(Object.isFrozen(def)).toBe(true);
      expect(Object.isFrozen(def.home)).toBe(true);
    }
    expect(Object.isFrozen(STARTING_FIELD_LIST)).toBe(true);
    expect(Object.isFrozen(STARTING_FIELD_LIST.tables)).toBe(true);
    expect(() => (STARTING_FIELD_LIST.tables as FieldDefinition[]).push(BUILT_IN_FIELDS[0])).toThrow();
  });

  it('starts with the starting set, made of the catalogue\'s own objects', () => {
    expect(STARTING_FIELD_LIST.tables.map((d) => d.key)).toEqual(
      ['grain', 'purpose', 'decisions', 'open_questions', 'role', 'scd_strategy', 'measures']);
    expect(STARTING_FIELD_LIST.columns.map((d) => d.key)).toEqual(['natural_key', 'scd_type', 'additive_type']);
    expect(STARTING_FIELD_LIST.leftOut).toEqual([]);
    for (const def of [...STARTING_FIELD_LIST.tables, ...STARTING_FIELD_LIST.columns]) {
      expect(def).toBe(builtInField(def.key, def.scope));
      expect(def.status).toBe('starting');
    }
    // Every starting built-in is in the starting set.
    expect(BUILT_IN_FIELDS.filter((d) => d.status === 'starting').length)
      .toBe(STARTING_FIELD_LIST.tables.length + STARTING_FIELD_LIST.columns.length);
  });

  it('looks built-ins up per scope', () => {
    expect(builtInField('purpose', 'table')?.label).toBe('Purpose');
    expect(builtInField('purpose', 'column')).toBeUndefined();
    expect(builtInField('business_rule', 'table')).toBeUndefined();
    expect(builtInField('business_rule', 'column')?.home).toEqual({ kind: 'meta' });
    expect(builtInField('Purpose', 'table')).toBeUndefined();
    expect(builtInField('toString', 'table')).toBeUndefined();
    expect(builtInField('__proto__', 'table')).toBeUndefined();
    expect(builtInField(undefined as unknown as string, 'table')).toBeUndefined();
  });

  it('classifies every role as a dimension or a fact', () => {
    expect([...DIMENSION_ROLES, ...FACT_ROLES].sort()).toEqual([...TABLE_ROLE_VALUES].sort());
    expect(TABLE_ROLE_VALUES).toEqual([
      'conformed-dim', 'domain-dim', 'transaction-fact', 'periodic-snapshot', 'accumulating-snapshot',
      'factless-fact', 'reference', 'gold-fact', 'gold-dim',
    ]);
  });
});

describe('rationale keys', () => {
  it('RATIONALE_FIELD_KEYS is the one ordered list of every rationale home', () => {
    expect(RATIONALE_FIELD_KEYS).toEqual([
      'purpose', 'decisions', 'openQuestions', 'design', 'grainChoice', 'roleChoice',
      'scdStrategy', 'measures', 'sourceOfTruth', 'freshness', 'knownIssues', 'retention',
    ]);
    const homes = BUILT_IN_FIELDS.flatMap((d) => (d.home.kind === 'rationale' ? [d.home.key] : []));
    expect([...homes].sort()).toEqual([...RATIONALE_FIELD_KEYS].sort());
    expect(Object.isFrozen(RATIONALE_FIELD_KEYS)).toBe(true);
  });

  it('keeps the first release\'s six keys in their relative order', () => {
    const legacy = ['purpose', 'design', 'grainChoice', 'roleChoice', 'scdStrategy', 'measures'];
    expect(RATIONALE_FIELD_KEYS.filter((k) => legacy.includes(k))).toEqual(legacy);
    expect(core.RATIONALE_KEYS).toEqual(legacy);
  });

  it('names every key of Rationale (compile-time check)', () => {
    // Fails to type-check if Rationale gains a key the list does not name.
    const all: Record<keyof Rationale, true> = {
      purpose: true, design: true, grainChoice: true, roleChoice: true, scdStrategy: true, measures: true,
      decisions: true, openQuestions: true, sourceOfTruth: true, freshness: true, knownIssues: true, retention: true,
    };
    expect(Object.keys(all).sort()).toEqual([...RATIONALE_FIELD_KEYS].sort());
  });

  it('maps field keys and rationale keys both ways, catalogue only', () => {
    expect(fieldKeyToRationaleKey('open_questions')).toBe('openQuestions');
    expect(fieldKeyToRationaleKey('scd_strategy')).toBe('scdStrategy');
    expect(fieldKeyToRationaleKey('role_choice')).toBe('roleChoice');
    expect(fieldKeyToRationaleKey('purpose')).toBe('purpose');
    expect(fieldKeyToRationaleKey('grain')).toBeUndefined();
    expect(fieldKeyToRationaleKey('business_rule')).toBeUndefined();
    expect(fieldKeyToRationaleKey('owner')).toBeUndefined();
    expect(fieldKeyToRationaleKey('openQuestions')).toBeUndefined();
    expect(rationaleKeyToFieldKey('sourceOfTruth')).toBe('source_of_truth');
    expect(rationaleKeyToFieldKey('purpose')).toBe('purpose');
    for (const key of RATIONALE_FIELD_KEYS) expect(fieldKeyToRationaleKey(rationaleKeyToFieldKey(key))).toBe(key);
    expect(isRationaleFieldKey('knownIssues')).toBe(true);
    expect(isRationaleFieldKey('known_issues')).toBe(false);
    expect(isRationaleFieldKey('notes')).toBe(false);
  });
});

describe('reserved keys', () => {
  it('reserves DBML\'s settings in both scopes', () => {
    for (const name of ['note', 'headercolor', 'color', 'pk', 'primary key', 'primary_key', 'unique', 'ref', 'dep',
      'not null', 'not_null', 'null', 'increment', 'default', 'name', 'type', 'check', 'update', 'delete', 'inactive', 'example']) {
      expect(isReservedFieldKey(name, 'table')).toBe(true);
      expect(isReservedFieldKey(name, 'column')).toBe(true);
      expect(reservedFieldKeyReason(name, 'table')).toBe('dbmlSetting');
    }
    expect([...DBML_SETTING_NAMES]).toContain('headercolor');
  });

  it('reserves ERD Studio\'s own names, including the typed built-ins', () => {
    for (const name of ['schema', 'alias', 'role', 'grain', 'foreign_key', 'natural_key', 'scd_type', 'additive_type',
      'meta_json', 'erd_placeholder', 'linked_table', 'json', 'dbml']) {
      expect(isReservedFieldKey(name, 'table')).toBe(true);
      expect(isReservedFieldKey(name, 'column')).toBe(true);
    }
    expect(reservedFieldKeyReason('alias', 'table')).toBe('erdSetting');
  });

  it('reserves the spelling prefixes and the parser-unsafe names', () => {
    for (const name of ['erd_owner', 'rationale_purpose', 'meta_owner', 'erd_', 'meta_']) {
      expect(isReservedFieldKey(name, 'table')).toBe(true);
    }
    expect(reservedFieldKeyReason('rationale_x', 'column')).toBe('prefix');
    expect(reservedFieldKeyReason('constructor', 'table')).toBe('unsafe');
    expect(reservedFieldKeyReason('__proto__', 'column')).toBe('unsafe');
  });

  it('compares names lower-cased, as DBML reads them', () => {
    expect(isReservedFieldKey('Note', 'table')).toBe(true);
    expect(isReservedFieldKey('PK', 'column')).toBe(true);
    expect(isReservedFieldKey('ERD_x', 'column')).toBe(true);
  });

  it('leaves ordinary keys, and the rationale-home built-ins, unreserved', () => {
    for (const name of ['owner', 'pii', 'sensitivity', 'purpose', 'decisions', 'retention', 'business_rule', 'notes', 'names', 'metadata', 'erdx']) {
      expect(isReservedFieldKey(name, 'table')).toBe(false);
    }
    expect(isReservedFieldKey(undefined as unknown as string, 'table')).toBe(false);
  });

  it('spells ERD Studio\'s names exactly as dbmlRichProperties.ts does', () => {
    expect(RESERVED_FIELD_KEY_PREFIXES).toEqual([DBML_RICH_PROPERTY_PREFIX, DBML_RICH_RATIONALE_PREFIX, DBML_RICH_META_PREFIX]);
    const erd = new Set(ERD_SETTING_NAMES);
    for (const name of [
      ...Object.values(DBML_RICH_TABLE_PROPERTIES),
      ...Object.values(DBML_RICH_COLUMN_PROPERTIES),
      ...Object.values(DBML_RICH_NOTE_PROPERTIES),
      DBML_RICH_META_JSON_PROPERTY,
      DBML_RICH_PLACEHOLDER_PROPERTY,
      DBML_RICH_META_JSON_PROPERTY.slice(DBML_RICH_META_PREFIX.length),
    ]) {
      expect(erd.has(name), name).toBe(true);
    }
    expect(rationaleSpellingNames('purpose')).toContain(`${DBML_RICH_RATIONALE_PREFIX}purpose`);
  });
});

describe('isBareMetaKey (A1)', () => {
  it('is true for a team key in either scope', () => {
    expect(isBareMetaKey('owner', 'table')).toBe(true);
    expect(isBareMetaKey('pii', 'column')).toBe(true);
    expect(isBareMetaKey('_x9', 'column')).toBe(true);
  });

  it('is true for business_rule on a column (meta home) and for a table built-in on a column', () => {
    expect(isBareMetaKey('business_rule', 'column')).toBe(true);
    expect(isBareMetaKey('purpose', 'column')).toBe(true);
    expect(isBareMetaKey('decisions', 'column')).toBe(true);
    expect(isBareMetaKey('business_rule', 'table')).toBe(true);
  });

  it('is false for a same-scope catalogue key kept elsewhere', () => {
    for (const key of ['purpose', 'decisions', 'open_questions', 'scd_strategy', 'measures', 'retention', 'design', 'source_of_truth']) {
      expect(isBareMetaKey(key, 'table')).toBe(false);
    }
  });

  it('is false for reserved keys and non-identifiers', () => {
    for (const key of ['note', 'role', 'grain', 'natural_key', 'json', 'dbml', 'meta_owner', 'erd_x', 'constructor', '__proto__']) {
      expect(isBareMetaKey(key, 'table')).toBe(false);
      expect(isBareMetaKey(key, 'column')).toBe(false);
    }
    for (const key of ['Owner', 'owner name', 'owner-name', '9lives', '', 'café']) {
      expect(isBareMetaKey(key, 'table')).toBe(false);
    }
  });
});

describe('spelling sets (A3)', () => {
  it('spells a rationale field four ways, in precedence order', () => {
    expect(rationaleSpellingNames('open_questions')).toEqual(
      ['erd_open_questions', 'open_questions', 'erd_rationale_open_questions', 'rationale_open_questions']);
  });

  it('spells a team field bare, meta_ and rationale_', () => {
    expect(metaSpellingNames('owner', 'table')).toEqual(
      ['erd_owner', 'owner', 'erd_meta_owner', 'meta_owner', 'erd_rationale_owner', 'rationale_owner']);
    expect(metaSpellingNames('business_rule', 'column')).toEqual(
      ['erd_business_rule', 'business_rule', 'erd_meta_business_rule', 'meta_business_rule', 'erd_rationale_business_rule', 'rationale_business_rule']);
  });

  it('never spells a shadowed meta key bare, nor as the rationale field it shadows', () => {
    expect(metaSpellingNames('purpose', 'table')).toEqual(['erd_meta_purpose', 'meta_purpose']);
    expect(metaSpellingNames('retention', 'table')).toEqual(['erd_meta_retention', 'meta_retention']);
    // On a column, purpose is a team key like any other.
    expect(metaSpellingNames('purpose', 'column')).toEqual(
      ['erd_purpose', 'purpose', 'erd_meta_purpose', 'meta_purpose', 'erd_rationale_purpose', 'rationale_purpose']);
  });

  it('keeps a reserved meta key under meta_ (and rationale_ for a key no rationale field uses)', () => {
    expect(metaSpellingNames('note', 'table')).toEqual(['erd_meta_note', 'meta_note', 'erd_rationale_note', 'rationale_note']);
    expect(metaSpellingNames('role', 'table')).toEqual(['erd_meta_role', 'meta_role', 'erd_rationale_role', 'rationale_role']);
    expect(metaSpellingNames('constructor', 'column')).toContain('meta_constructor');
    expect(metaSpellingNames('constructor', 'column')).not.toContain('constructor');
  });

  it('gives json no meta_ spelling (that is meta_json itself)', () => {
    expect(metaSpellingNames('json', 'table')).toEqual(['erd_rationale_json', 'rationale_json']);
    expect(metaSpellingNames('json', 'table')).not.toContain('meta_json');
  });

  it('gives a non-identifier key no setting at all (only meta_json holds it)', () => {
    expect(metaSpellingNames('Owner Name', 'table')).toEqual([]);
    expect(metaSpellingNames('a-b', 'column')).toEqual([]);
  });
});

describe('roles and show_for', () => {
  it('knows dimensions and facts, and nothing else', () => {
    for (const role of DIMENSION_ROLES) {
      expect(isDimensionRole(role)).toBe(true);
      expect(isFactRole(role)).toBe(false);
    }
    for (const role of FACT_ROLES) {
      expect(isFactRole(role)).toBe(true);
      expect(isDimensionRole(role)).toBe(false);
    }
    for (const role of [undefined, '', 'hub', 'Conformed-Dim', 42 as unknown as string]) {
      expect(isDimensionRole(role)).toBeUndefined();
      expect(isFactRole(role)).toBeUndefined();
    }
  });

  it('shows a dimension field on dimensions, unknown roles and no role; never on facts', () => {
    const history = builtInField('scd_strategy', 'table')!;
    expect(fieldApplies(history, 'conformed-dim')).toBe(true);
    expect(fieldApplies(history, 'reference')).toBe(true);
    expect(fieldApplies(history, undefined)).toBe(true);
    expect(fieldApplies(history, 'satellite')).toBe(true);
    expect(fieldApplies(history, 'transaction-fact')).toBe(false);
  });

  it('shows a fact field on facts, unknown roles and no role; never on dimensions', () => {
    const measures = builtInField('measures', 'table')!;
    expect(fieldApplies(measures, 'gold-fact')).toBe(true);
    expect(fieldApplies(measures, undefined)).toBe(true);
    expect(fieldApplies(measures, 'gold-dim')).toBe(false);
  });

  it('shows an all field, or a show_for from a newer core, everywhere', () => {
    expect(fieldApplies(builtInField('purpose', 'table')!, 'gold-dim')).toBe(true);
    const newer = { ...builtInField('purpose', 'table')!, showFor: 'bridges' } as unknown as FieldDefinition;
    expect(fieldApplies(newer, 'gold-dim')).toBe(true);
  });
});

describe('row ids and made-up definitions', () => {
  it('names a row by its home', () => {
    expect(fieldRowId(builtInField('open_questions', 'table')!)).toBe('rationale:openQuestions');
    expect(fieldRowId(builtInField('grain', 'table')!)).toBe('grain');
    expect(fieldRowId(builtInField('role', 'table')!)).toBe('role');
    expect(fieldRowId(builtInField('natural_key', 'column')!)).toBe('naturalKey');
    expect(fieldRowId(builtInField('scd_type', 'column')!)).toBe('scdType');
    expect(fieldRowId(builtInField('additive_type', 'column')!)).toBe('additiveType');
    expect(fieldRowId(builtInField('business_rule', 'column')!)).toBe('meta:business_rule');
    expect(fieldRowId(metaFieldDefinition('owner', 'table'))).toBe('meta:owner');
    expect(fieldRowId({ ...metaFieldDefinition('x', 'table'), home: { kind: 'later' } } as unknown as FieldDefinition)).toBe('meta:x');
  });

  it('labels an unlisted meta key with its key, and a shadow with (metadata)', () => {
    expect(metaFieldDefinition('owner', 'table')).toEqual({
      key: 'owner', scope: 'table', label: 'owner', type: 'text', filledBy: 'anyone', showFor: 'all', status: 'team', home: { kind: 'meta' },
    });
    expect(metaFieldDefinition('purpose', 'table').label).toBe('purpose (metadata)');
    expect(metaFieldDefinition('note', 'column').label).toBe('note (metadata)');
    expect(metaFieldDefinition('role', 'table').label).toBe('role (metadata)');
    expect(metaFieldDefinition('purpose', 'column').label).toBe('purpose');
    expect(metaFieldDefinition('business_rule', 'column').label).toBe('business_rule');
  });
});

describe('resolveTableFields', () => {
  it('lists the starting set for an empty table (no role suits every field)', () => {
    expect(ids(resolveTableFields(table()))).toEqual(
      ['grain', 'rationale:purpose', 'rationale:decisions', 'rationale:openQuestions', 'role', 'rationale:scdStrategy', 'rationale:measures']);
    for (const r of resolveTableFields(table())) {
      expect(r.source).toBe('list');
      expect(r.editable).toBe(true);
      expect(r.value).toBeUndefined();
      expect(r.definition.label).toBeTruthy();
    }
  });

  it('leaves out an empty field that does not suit the role, and keeps one with a value', () => {
    expect(ids(resolveTableFields(table({ modelRole: 'conformed-dim' })))).not.toContain('rationale:measures');
    expect(ids(resolveTableFields(table({ modelRole: 'conformed-dim' })))).toContain('rationale:scdStrategy');
    expect(ids(resolveTableFields(table({ modelRole: 'transaction-fact' })))).not.toContain('rationale:scdStrategy');
    const withHistory = resolveTableFields(table({ modelRole: 'transaction-fact', rationale: { scdStrategy: 'Type 2 on status' } }));
    expect(row(withHistory, 'rationale:scdStrategy')).toMatchObject({ source: 'list', value: 'Type 2 on status' });
    // An unknown role shows both kinds.
    expect(ids(resolveTableFields(table({ modelRole: 'hub' as never })))).toEqual(expect.arrayContaining(['rationale:scdStrategy', 'rationale:measures']));
  });

  it('reads each home: grain, role, rationale, meta', () => {
    const rows = resolveTableFields(table({
      grain: 'One row per order', modelRole: 'transaction-fact',
      rationale: { purpose: 'Orders', decisions: 'Kept cancelled ones', openQuestions: 'Refunds?' },
      meta: { owner: 'crm' },
    }));
    expect(row(rows, 'grain')?.value).toBe('One row per order');
    expect(row(rows, 'role')).toMatchObject({ value: 'transaction-fact', choice: 'transaction-fact', source: 'list' });
    expect(row(rows, 'role')?.outsideChoices).toBeUndefined();
    expect(row(rows, 'rationale:purpose')?.value).toBe('Orders');
    expect(row(rows, 'rationale:decisions')?.value).toBe('Kept cancelled ones');
    expect(row(rows, 'rationale:openQuestions')?.value).toBe('Refunds?');
    expect(row(rows, 'meta:owner')).toMatchObject({ source: 'notInList', value: 'crm', editable: true });
  });

  it('orders the rest: list, retired built-ins, other built-ins, then meta in map order', () => {
    const rows = resolveTableFields(table({
      rationale: { roleChoice: 'r', freshness: 'daily', design: 'd', purpose: 'p' },
      meta: { zeta: 'z', alpha: 'a' },
    }));
    expect(ids(rows)).toEqual([
      'grain', 'rationale:purpose', 'rationale:decisions', 'rationale:openQuestions', 'role', 'rationale:scdStrategy', 'rationale:measures',
      'rationale:design', 'rationale:roleChoice',
      'rationale:freshness',
      'meta:zeta', 'meta:alpha',
    ]);
    expect(row(rows, 'rationale:design')?.source).toBe('retired');
    expect(row(rows, 'rationale:roleChoice')?.source).toBe('retired');
    expect(row(rows, 'rationale:freshness')).toMatchObject({ source: 'notInList', definition: builtInField('freshness', 'table') });
  });

  it('follows a project\'s list order and labels', () => {
    const owner: FieldDefinition = {
      key: 'owner', scope: 'table', label: 'Owner', type: 'value', guidance: 'The team.', filledBy: 'dbt', showFor: 'all', status: 'team', home: { kind: 'meta' },
    };
    const decisions = { ...builtInField('decisions', 'table')!, guidance: 'Finance sign-offs.' };
    const list: FieldList = { tables: [owner, decisions, builtInField('grain', 'table')!], columns: [], leftOut: [] };
    const rows = resolveTableFields(table({ meta: { owner: 'crm' }, rationale: { purpose: 'p' } }), list);
    expect(ids(rows)).toEqual(['meta:owner', 'rationale:decisions', 'grain', 'rationale:purpose']);
    expect(rows[0]).toMatchObject({ source: 'list', value: 'crm', definition: { label: 'Owner', filledBy: 'dbt' } });
    expect(rows[1].definition.guidance).toBe('Finance sign-offs.');
    expect(rows[3].source).toBe('notInList');
  });

  it('shows a listed retired field as listed', () => {
    const list: FieldList = { tables: [builtInField('design', 'table')!], columns: [], leftOut: [] };
    expect(resolveTableFields(table({ rationale: { design: 'd' } }), list)).toEqual([
      expect.objectContaining({ id: 'rationale:design', source: 'list', value: 'd' }),
    ]);
    expect(resolveTableFields(table(), list).map((r) => r.id)).toEqual(['rationale:design']);
  });

  it('shows an empty list as no rows but every value', () => {
    const empty: FieldList = { tables: [], columns: [], leftOut: [] };
    expect(resolveTableFields(table(), empty)).toEqual([]);
    expect(ids(resolveTableFields(table({ grain: 'g', meta: { a: 'b' } }), empty))).toEqual(['grain', 'meta:a']);
  });

  it('keeps a meta key that shadows a built-in as its own row (A2)', () => {
    const rows = resolveTableFields(table({
      rationale: { purpose: 'the rationale' },
      meta: { purpose: 'the meta', retention: '7 years', note: 'n', role: 'x' },
    }));
    expect(row(rows, 'rationale:purpose')?.value).toBe('the rationale');
    expect(row(rows, 'meta:purpose')).toMatchObject({ source: 'notInList', value: 'the meta', editable: true, definition: { label: 'purpose (metadata)', status: 'team', home: { kind: 'meta' } } });
    expect(row(rows, 'meta:retention')?.definition.label).toBe('retention (metadata)');
    expect(row(rows, 'rationale:retention')).toBeUndefined();
    expect(row(rows, 'meta:note')?.definition.label).toBe('note (metadata)');
    expect(row(rows, 'meta:role')?.definition.label).toBe('role (metadata)');
    expect(row(rows, 'role')?.value).toBeUndefined();
  });

  it('never makes meta.dbml a row', () => {
    const rows = resolveTableFields(table({ meta: { dbml: { database_type: 'pg' }, owner: 'x' } }));
    expect(ids(rows)).not.toContain(`meta:${DBML_IMPORT_META_KEY}`);
    expect(ids(rows)).toContain('meta:owner');
    const listed: FieldList = { tables: [metaFieldDefinition('dbml', 'table')], columns: [], leftOut: [] };
    expect(resolveTableFields(table({ meta: { dbml: 'x' } }), listed)).toEqual([]);
  });

  it('shows left_out keys like any other unlisted key (A25)', () => {
    const list: FieldList = { tables: [], columns: [], leftOut: ['dimension'] };
    expect(resolveTableFields(table({ meta: { dimension: 'x' } }), list)).toEqual([
      expect.objectContaining({ id: 'meta:dimension', source: 'notInList' }),
    ]);
  });

  it('marks list and map meta values, and null, read-only; keeps \'\' as an editable value', () => {
    const rows = resolveTableFields(table({ meta: { tags: ['a', 'b'], lineage: { up: 'x' }, gone: null, blank: '' } }), { tables: [], columns: [], leftOut: [] });
    expect(rows.map((r) => [r.id, r.editable, r.value])).toEqual([
      ['meta:tags', false, ['a', 'b']],
      ['meta:lineage', false, { up: 'x' }],
      ['meta:gone', false, null],
      ['meta:blank', true, ''],
    ]);
  });

  it('treats blank rationale and grain text as no value', () => {
    const rows = resolveTableFields(table({ grain: '  ', rationale: { purpose: '', design: ' \n' } }));
    expect(row(rows, 'grain')?.value).toBeUndefined();
    expect(row(rows, 'rationale:purpose')?.value).toBeUndefined();
    expect(row(rows, 'rationale:design')).toBeUndefined();
  });

  it('reads yes-no and choice team fields, flagging values outside their options (A16)', () => {
    const pii: FieldDefinition = { ...metaFieldDefinition('pii', 'table'), label: 'PII', type: 'yes-no' };
    const sensitivity: FieldDefinition = { ...metaFieldDefinition('sensitivity', 'table'), type: 'choice', values: ['public', 'internal'] };
    const list: FieldList = { tables: [pii, sensitivity], columns: [], leftOut: [] };
    const read = (meta: Record<string, unknown>) => resolveTableFields(table({ meta: meta as never }), list);
    expect(read({ pii: true })[0]).toMatchObject({ value: true, choice: 'true', editable: true });
    expect(read({ pii: false })[0]).toMatchObject({ value: false, choice: 'false' });
    expect(read({ pii: ' TRUE ' })[0]).toMatchObject({ value: ' TRUE ', choice: 'true' });
    expect(read({ pii: 'false' })[0].outsideChoices).toBeUndefined();
    for (const odd of ['yes', 'no', '1', ['true']]) {
      const r = read({ pii: odd })[0];
      expect(r.outsideChoices, String(odd)).toBe(true);
      expect(r.choice).toBeUndefined();
      expect(r.value).toEqual(odd);
    }
    expect(read({ pii: '' })[0].outsideChoices).toBeUndefined();
    expect(read({ sensitivity: 'internal' })[1]).toMatchObject({ choice: 'internal' });
    expect(read({ sensitivity: 'secret' })[1]).toMatchObject({ value: 'secret', outsideChoices: true });
    expect(read({ sensitivity: 'Internal' })[1].outsideChoices).toBe(true);
  });

  it('shows a role outside the list, flagged, never dropped', () => {
    const r = row(resolveTableFields(table({ modelRole: 'hub' as never })), 'role');
    expect(r).toMatchObject({ value: 'hub', outsideChoices: true, editable: true });
    expect(r?.choice).toBeUndefined();
  });

  it('tolerates an older core\'s or a v4 inline model\'s values of any type', () => {
    const odd = {
      name: 'v4', grain: 42, modelRole: 7,
      rationale: { purpose: 12, design: true, measures: ['a', 1], scdStrategy: null, decisions: { why: 'x' } },
      meta: 'not a map',
    } as unknown as DisplayTable;
    const rows = resolveTableFields(odd);
    expect(row(rows, 'grain')?.value).toBe('42');
    expect(row(rows, 'role')).toMatchObject({ value: '7', outsideChoices: true });
    expect(row(rows, 'rationale:purpose')).toMatchObject({ value: '12', editable: true });
    expect(row(rows, 'rationale:design')).toMatchObject({ value: 'true', source: 'retired' });
    expect(row(rows, 'rationale:measures')).toMatchObject({ value: ['a', '1'], editable: false });
    expect(row(rows, 'rationale:decisions')).toMatchObject({ value: { why: 'x' }, editable: false });
    expect(row(rows, 'rationale:scdStrategy')?.value).toBeUndefined();
  });

  it('tolerates a missing table, a non-object rationale and inherited keys', () => {
    expect(resolveTableFields(null as unknown as DisplayTable)).toEqual([]);
    expect(resolveTableFields('t' as unknown as DisplayTable)).toEqual([]);
    expect(() => resolveTableFields(table({ rationale: 'x' as never }))).not.toThrow();
    const inherited = Object.create({ owner: 'from the prototype' });
    expect(ids(resolveTableFields(table({ meta: inherited }), { tables: [], columns: [], leftOut: [] }))).toEqual([]);
    const proto = JSON.parse('{"__proto__": "data", "constructor": "c"}');
    expect(resolveTableFields(table({ meta: proto }), { tables: [], columns: [], leftOut: [] }).map((r) => [r.id, r.value, r.definition.label])).toEqual([
      ['meta:__proto__', 'data', '__proto__ (metadata)'],
      ['meta:constructor', 'c', 'constructor (metadata)'],
    ]);
  });

  it('tolerates a malformed or partial list', () => {
    expect(ids(resolveTableFields(table(), {} as FieldList))).toEqual(ids(resolveTableFields(table())));
    expect(ids(resolveTableFields(table(), 'x' as unknown as FieldList))).toEqual(ids(resolveTableFields(table())));
    const messy = {
      tables: [null, 7, {}, { key: '' }, { key: 'purpose' }, { key: 'owner' }, builtInField('grain', 'table'), builtInField('grain', 'table')],
      columns: [],
      leftOut: [],
    } as unknown as FieldList;
    const rows = resolveTableFields(table({ meta: { owner: 'o' } }), messy);
    expect(ids(rows)).toEqual(['rationale:purpose', 'meta:owner', 'grain']);
    expect(rows[0].definition.label).toBe('Purpose');
    expect(rows[1].definition).toMatchObject({ label: 'owner', home: { kind: 'meta' } });
  });

  it('shows a definition from a newer core read-only, never dropping its value (A15)', () => {
    const newer = [
      { ...metaFieldDefinition('tier', 'table'), type: 'number' },
      { ...metaFieldDefinition('owner', 'table'), filledBy: 'catalog' },
      { ...metaFieldDefinition('zone', 'table'), showFor: 'bridges' },
      { ...metaFieldDefinition('lineage', 'table'), home: { kind: 'lineage' } },
    ] as unknown as FieldDefinition[];
    const rows = resolveTableFields(
      table({ modelRole: 'gold-dim', meta: { tier: '1', owner: 'crm', zone: 'eu', lineage: 'up' } }),
      { tables: newer, columns: [], leftOut: [] },
    );
    expect(rows.map((r) => [r.id, r.value, r.editable, r.source])).toEqual([
      ['meta:tier', '1', false, 'list'],
      ['meta:owner', 'crm', false, 'list'],
      ['meta:zone', 'eu', false, 'list'],
      ['meta:lineage', 'up', false, 'list'],
      ['role', 'gold-dim', true, 'notInList'],
    ]);
  });

  it('is pure: the table and the list are not changed', () => {
    const t = table({ rationale: { purpose: 'p' }, meta: { owner: 'o' } });
    const before = JSON.stringify(t);
    resolveTableFields(t, STARTING_FIELD_LIST);
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe('resolveColumnFields', () => {
  it('lists the starting column fields by the table\'s role', () => {
    expect(ids(resolveColumnFields(column(), table()))).toEqual(['naturalKey', 'scdType', 'additiveType']);
    expect(ids(resolveColumnFields(column(), table({ modelRole: 'conformed-dim' })))).toEqual(['naturalKey', 'scdType']);
    expect(ids(resolveColumnFields(column(), table({ modelRole: 'periodic-snapshot' })))).toEqual(['naturalKey', 'additiveType']);
  });

  it('normalises typed values to text (A16)', () => {
    const rows = resolveColumnFields(column({ isNaturalKey: true, scdType: 2, additiveType: 'semi-additive' }), table());
    expect(row(rows, 'naturalKey')).toMatchObject({ value: 'true', choice: 'true' });
    expect(row(rows, 'scdType')).toMatchObject({ value: '2', choice: '2' });
    expect(row(rows, 'additiveType')).toMatchObject({ value: 'semi-additive', choice: 'semi-additive' });
    expect(row(resolveColumnFields(column({ scdType: 0 }), table()), 'scdType')).toMatchObject({ value: '0', choice: '0' });
  });

  it('treats an unset natural key flag as no value', () => {
    expect(row(resolveColumnFields(column({ isNaturalKey: false }), table()), 'naturalKey')?.value).toBeUndefined();
    const noFlag = { name: 'c', dataType: 'int', description: '' };
    expect(row(resolveColumnFields(noFlag, table()), 'naturalKey')?.value).toBeUndefined();
  });

  it('shows a typed value off the list or off the role', () => {
    const rows = resolveColumnFields(column({ scdType: 1 }), table({ modelRole: 'transaction-fact' }));
    expect(row(rows, 'scdType')).toMatchObject({ source: 'list', value: '1' });
    const none: FieldList = { tables: [], columns: [], leftOut: [] };
    expect(resolveColumnFields(column({ isNaturalKey: true, additiveType: 'additive' }), table(), none).map((r) => [r.id, r.source]))
      .toEqual([['naturalKey', 'notInList'], ['additiveType', 'notInList']]);
  });

  it('flags typed values outside their options', () => {
    const odd = { name: 'c', dataType: 'x', description: '', scdType: 4, additiveType: 'sometimes' } as unknown as DisplayColumn;
    const rows = resolveColumnFields(odd, table());
    expect(row(rows, 'scdType')).toMatchObject({ value: '4', outsideChoices: true });
    expect(row(rows, 'additiveType')).toMatchObject({ value: 'sometimes', outsideChoices: true });
  });

  it('reads business_rule and team fields from column meta', () => {
    const rows = resolveColumnFields(column({ meta: { business_rule: 'Sum of lines', pii: true, purpose: 'x' } }), table());
    expect(row(rows, 'meta:business_rule')).toMatchObject({ source: 'notInList', value: 'Sum of lines', definition: { label: 'Business rule' } });
    expect(row(rows, 'meta:pii')).toMatchObject({ source: 'notInList', value: true, editable: true, definition: { label: 'pii' } });
    // purpose is not a column built-in: a plain team key, no "(metadata)".
    expect(row(rows, 'meta:purpose')?.definition.label).toBe('purpose');
    expect(ids(rows)).toEqual(['naturalKey', 'scdType', 'additiveType', 'meta:business_rule', 'meta:pii', 'meta:purpose']);
  });

  it('resolves a listed business_rule in list order', () => {
    const list: FieldList = { tables: [], columns: [builtInField('business_rule', 'column')!], leftOut: [] };
    expect(resolveColumnFields(column({ meta: { business_rule: 'r' } }), table(), list)).toEqual([
      expect.objectContaining({ id: 'meta:business_rule', source: 'list', value: 'r', editable: true }),
    ]);
  });

  it('tolerates a missing column or table', () => {
    expect(resolveColumnFields(undefined as unknown as DisplayColumn, table())).toEqual([]);
    expect(ids(resolveColumnFields(column(), undefined as unknown as DisplayTable))).toEqual(['naturalKey', 'scdType', 'additiveType']);
  });
});

describe('the package entry', () => {
  it('exports the fields API from @erd-studio/core', () => {
    expect(core.BUILT_IN_FIELDS).toBe(BUILT_IN_FIELDS);
    expect(core.STARTING_FIELD_LIST).toBe(STARTING_FIELD_LIST);
    expect(core.resolveTableFields).toBe(resolveTableFields);
    expect(core.RATIONALE_FIELD_KEYS).toBe(RATIONALE_FIELD_KEYS);
    expect(typeof core.parseFieldsText).toBe('function');
    expect(core.FIELDS_FILE_NAME).toBe('fields.yml');
  });

  it('fields.ts imports neither yaml nor the DBML parser', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../src/fields.ts'), 'utf8');
    const imports = [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.filter((s) => !s.startsWith('./'))).toEqual([]);
    expect(imports).not.toContain('./fieldsFile.js');
    expect(imports).not.toContain('./dbmlRichProperties.js');
  });
});
