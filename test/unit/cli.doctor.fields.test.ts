import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STARTING_FIELD_LIST, type SemanticTable } from '@erd-studio/core';
import { runDoctor, type DoctorResult } from '../../src/cli/doctor';
import { ALLOWED_ROOT_FILES } from '../../src/cli/dbmlProblems';
import {
  FIELD_FINDING_CODES,
  isFieldProblemCode,
  startingSetSummary,
  summariseFields,
  type FieldFinding,
} from '../../src/cli/fieldFindings';
import { formatDoctor, makePaint } from '../../src/cli/format';
import { main } from '../../src/cli/index';
import { readFieldsFile } from '../../src/services/fieldsService';

/**
 * doctor's `erd.fields` (context fields, spec §9): the field list it read,
 * fields.yml's problems (errors raise fix-fields-file), and the findings
 * about the tables' field values — never part of `erd.dbmlProblems`.
 */

const FIXTURES = path.resolve(__dirname, '../fixtures');
const FCT_ORDER = 'gold/tables/gold/fct_order.dbml';
const DIM_CUSTOMER = 'gold/tables/gold/dim_customer.dbml';
const DIM_DATE = 'silver/tables/calendar/dim_date.dbml';
const STARTING_TABLES = STARTING_FIELD_LIST.tables.map((d) => d.key);
const STARTING_COLUMNS = STARTING_FIELD_LIST.columns.map((d) => d.key);

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-cli-fields-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const cleanEnv: NodeJS.ProcessEnv = { PATH: '' };

function copyFixture(name: string): string {
  const dest = path.join(tmp, name);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

/** A copy of dbml-native with `edits` applied (paths relative to its .erd-studio; a string replaces the file). */
function nativeWith(edits: Record<string, string | ((text: string) => string)>): string {
  const root = copyFixture('dbml-native');
  for (const [rel, edit] of Object.entries(edits)) {
    const file = path.join(root, '.erd-studio', rel);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof edit === 'string' ? edit : edit(before));
  }
  return root;
}

const replace = (from: string, to: string) => (text: string): string => {
  expect(text, from).toContain(from);
  return text.replace(from, to);
};

const doctor = (root: string): Promise<DoctorResult> =>
  runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
const ids = (r: DoctorResult): string[] => r.nextSteps.map((s) => s.id);
const finding = (r: DoctorResult, code: string): FieldFinding[] => r.erd.fields.problems.filter((p) => p.code === code);

const TEAM_FIELDS = `version: 1
tables:
  - grain
  - purpose
  - key: sensitivity
    label: Sensitivity
    type: choice
    values: [public, internal, confidential]
    filled_by: people
columns:
  - natural_key
  - key: pii
    label: Personal data
    type: yes-no
`;

describe('erd.fields: which list doctor reads', () => {
  it('without fields.yml: the starting set, no file, and the DBML project stays clean and ready', async () => {
    const r = await doctor(copyFixture('dbml-native'));
    expect(r.erd.fields).toMatchObject({ file: null, source: 'starting-set', tables: STARTING_TABLES, columns: STARTING_COLUMNS, leftOut: [] });
    expect(r.erd.dbmlProblems).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
    // Information never raises a step: the old spellings of dbml-native are counted, nothing more.
    expect(r.erd.fields.problems.every((p) => p.severity === 'info')).toBe(true);
  });

  it('with fields.yml: its keys, in order, and its left_out; the file is no stray in a DBML project', async () => {
    const r = await doctor(nativeWith({ 'fields.yml': `${TEAM_FIELDS}left_out: [dimension, metrics]\n` }));
    expect(r.erd.fields).toMatchObject({
      file: '.erd-studio/fields.yml', source: 'file',
      tables: ['grain', 'purpose', 'sensitivity'], columns: ['natural_key', 'pii'], leftOut: ['dimension', 'metrics'],
    });
    expect(r.erd.dbmlProblems).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('fields.yml is an allowed root file, and the stray-file message names it', async () => {
    expect(ALLOWED_ROOT_FILES.has('fields.yml')).toBe(true);
    const r = await doctor(nativeWith({ 'notes.txt': 'hello\n', 'fields.yml': TEAM_FIELDS }));
    const stray = r.erd.dbmlProblems.filter((p) => p.code === 'unexpectedFileInDbmlFolder');
    expect(stray.map((p) => p.file)).toEqual(['.erd-studio/notes.txt']);
    expect(stray[0].message).toContain('modelling-approach.md and fields.yml');
  });

  it('a project with no .erd-studio reports the starting set', async () => {
    const root = path.join(tmp, 'fresh');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: fresh\nversion: "1.0.0"\n');
    const r = await doctor(root);
    expect(r.erd.fields).toEqual(startingSetSummary());
  });

  it('a folder that is not a project still has the block', async () => {
    const r = await runDoctor({ project: tmp, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: home });
    expect(r.erd.fields).toEqual(startingSetSummary());
  });
});

describe('fields.yml problems', () => {
  it('an error carries the project-relative file and line, and raises fix-fields-file right after fix-dbml-file', async () => {
    const r = await doctor(nativeWith({
      'fields.yml': 'version: 1\ntables:\n  - grain\n  - key: note\n    label: Note\n',
      [DIM_DATE]: replace("role: 'conformed-dim'", 'role: conformed'),
    }));
    const [p] = finding(r, 'fieldsKeyReserved');
    expect(p).toMatchObject({ severity: 'error', file: '.erd-studio/fields.yml', line: 4, key: 'note' });
    expect(p.message).not.toContain('fields.yml');
    const steps = ids(r);
    expect(steps.indexOf('fix-fields-file')).toBe(steps.indexOf('fix-dbml-file') + 1);
    const step = r.nextSteps.find((s) => s.id === 'fix-fields-file')!;
    expect(step.title).toBe('Fix a problem in the field list (.erd-studio/fields.yml)');
    expect(step.why).toContain('.erd-studio/fields.yml:4 (fieldsKeyReserved) — ');
    expect(step.command).toBeNull();
    // Never a DBML problem.
    expect(r.erd.dbmlProblems.some((d) => String(d.code).startsWith('field'))).toBe(false);
  });

  it('a file that is not YAML is an error, and the starting set is used', async () => {
    const r = await doctor(nativeWith({ 'fields.yml': 'tables: [grain\n' }));
    expect(r.erd.fields).toMatchObject({ file: '.erd-studio/fields.yml', source: 'starting-set', tables: STARTING_TABLES });
    expect(finding(r, 'fieldsYamlInvalid')).toHaveLength(1);
    expect(ids(r)).toEqual(['fix-fields-file']);
  });

  it('a warning (a name that is not a built-in) raises no next step', async () => {
    const r = await doctor(nativeWith({ 'fields.yml': 'tables:\n  - grain\n  - purpse\n' }));
    const [p] = finding(r, 'fieldsUnknownName');
    expect(p).toMatchObject({ severity: 'warning', file: '.erd-studio/fields.yml', line: 3 });
    expect(p.message).toContain('Did you mean purpose?');
    expect(ids(r)).toEqual(['ready']);
  });

  it('a retired built-in on the list is a warning only', async () => {
    const r = await doctor(nativeWith({ 'fields.yml': 'tables:\n  - grain\n  - design\n' }));
    expect(finding(r, 'fieldsRetiredListed')[0]).toMatchObject({ severity: 'warning', line: 3 });
    expect(ids(r)).toEqual(['ready']);
  });
});

describe('field findings on DBML tables', () => {
  it('fieldValueOutsideChoices: a choice or yes-no value outside its options is a warning per table or column', async () => {
    const r = await doctor(nativeWith({
      'fields.yml': TEAM_FIELDS,
      [FCT_ORDER]: (t) => replace("alias: 'orders',", "alias: 'orders',\n  sensitivity: 'secret',")(
        replace("[natural_key: 'true']", "[natural_key: 'true', pii: 'yes']")(t)),
    }));
    const outside = finding(r, 'fieldValueOutsideChoices');
    expect(outside).toEqual([
      {
        code: 'fieldValueOutsideChoices', severity: 'warning', file: `.erd-studio/${FCT_ORDER}`, table: 'fct_order', key: 'sensitivity',
        message: 'fct_order: sensitivity is secret; fields.yml allows public, internal, confidential.',
      },
      {
        code: 'fieldValueOutsideChoices', severity: 'warning', file: `.erd-studio/${FCT_ORDER}`, table: 'fct_order', column: 'order_number', key: 'pii',
        message: 'fct_order.order_number: pii is yes; fields.yml allows true or false.',
      },
    ]);
    expect(r.erd.dbmlProblems).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('a value inside the options, and true/false for yes-no in any case, is no finding', async () => {
    const r = await doctor(nativeWith({
      'fields.yml': TEAM_FIELDS,
      [FCT_ORDER]: (t) => replace("alias: 'orders',", "alias: 'orders',\n  sensitivity: 'internal',")(
        replace("[natural_key: 'true']", "[natural_key: 'true', pii: 'TRUE']")(t)),
    }));
    expect(finding(r, 'fieldValueOutsideChoices')).toEqual([]);
  });

  it('fieldSpelledTwice: one field under two spellings is a warning naming the one used', async () => {
    const r = await doctor(nativeWith({ [FCT_ORDER]: replace("alias: 'orders',", "alias: 'orders',\n  purpose: 'Bare wins',") }));
    const [p] = finding(r, 'fieldSpelledTwice');
    expect(p).toMatchObject({ severity: 'warning', file: `.erd-studio/${FCT_ORDER}`, table: 'fct_order', key: 'purpose' });
    expect(p.column).toBeUndefined();
    expect(p.message).toMatch(/^fct_order has (purpose and rationale_purpose|rationale_purpose and purpose); purpose is used\. Remove the other\.$/);
    expect(ids(r)).toEqual(['ready']);
  });

  it('fieldSpelledTwice on a column names the column', async () => {
    const r = await doctor(nativeWith({ [FCT_ORDER]: replace("[natural_key: 'true']", "[natural_key: 'true', owner: 'a', meta_owner: 'b']") }));
    const [p] = finding(r, 'fieldSpelledTwice');
    expect(p).toMatchObject({ table: 'fct_order', column: 'order_number', key: 'owner' });
    expect(p.message).toBe('fct_order.order_number has owner and meta_owner; owner is used. Remove the other.');
  });

  it('fieldSpelledTwice names an erd_ spelling exactly, from the reader', async () => {
    const r = await doctor(nativeWith({ [FCT_ORDER]: replace("[natural_key: 'true']", "[natural_key: 'true', owner: 'a', erd_meta_owner: 'b']") }));
    const [p] = finding(r, 'fieldSpelledTwice');
    expect(p).toMatchObject({ table: 'fct_order', column: 'order_number', key: 'owner' });
    // A bare key outranks erd_meta_<k>; the erd_ setting is named exactly, not 'an erd_ spelling of owner'.
    expect(p.message).toBe('fct_order.order_number has owner and erd_meta_owner; owner is used. Remove the other.');
  });

  it('fieldOldSpellings: one information line counting every old spelling, with an example', async () => {
    const r = await doctor(copyFixture('dbml-native'));
    const old = finding(r, 'fieldOldSpellings');
    expect(old).toHaveLength(1);
    // rationale_purpose, rationale_measures and meta_owner; meta_json holds only non-text values, which are never old.
    expect(old[0]).toMatchObject({ severity: 'info', count: 3, table: 'fct_order', file: `.erd-studio/${FCT_ORDER}` });
    expect(old[0].message).toBe('1 table still says rationale_purpose, rationale_measures or meta_owner (3 old spellings). '
      + 'They read as the same fields. Ask your assistant to rename them.');
  });

  it('no old spelling once a table is written bare', async () => {
    const r = await doctor(nativeWith({
      [FCT_ORDER]: (t) => t.replace('rationale_purpose', 'purpose').replace('rationale_measures', 'measures').replace('meta_owner', 'owner'),
    }));
    expect(finding(r, 'fieldOldSpellings')).toEqual([]);
    expect(finding(r, 'fieldSpelledTwice')).toEqual([]);
  });

  it('fieldRetired: tables still holding a retired field are counted', async () => {
    const r = await doctor(nativeWith({
      [FCT_ORDER]: replace("alias: 'orders',", "alias: 'orders',\n  design: 'One row per line',"),
      [DIM_CUSTOMER]: replace("[role: 'conformed-dim']", "[role: 'conformed-dim', rationale_grain_choice: 'Kept per version']"),
    }));
    const [p] = finding(r, 'fieldRetired');
    expect(p).toMatchObject({ severity: 'info', count: 2 });
    expect(p.message).toMatch(/^2 tables still have (Design or Grain choice|Grain choice or Design)\. Ask your assistant to move them into Decisions\.$/);
  });

  it('fieldNotInList: only with a fields.yml, for values the list does not name, ignoring left_out', async () => {
    const without = await doctor(copyFixture('dbml-native'));
    expect(finding(without, 'fieldNotInList')).toEqual([]);

    const listed = await doctor(nativeWith({ 'fields.yml': TEAM_FIELDS }));
    const [p] = finding(listed, 'fieldNotInList');
    expect(p).toMatchObject({ severity: 'info' });
    // owner (meta_owner), and fct_order's measures (a built-in this list leaves out).
    expect(p.message).toContain('owner');
    expect(p.message).toContain('measures');
    expect(p.message).toContain('which fields.yml does not list');
    expect(p.message).toContain('"Not in your list"');

    const leftOut = await doctor(nativeWith({ 'fields.yml': `${TEAM_FIELDS}left_out: [owner, tags]\n` }));
    const [q] = finding(leftOut, 'fieldNotInList');
    expect(q.message).not.toMatch(/\bowner\b/);
    expect(q.message).not.toMatch(/\btags\b/);
  });

  it('fieldMetaShadowsBuiltIn: metadata named like a built-in stays metadata, counted once', async () => {
    const r = await doctor(nativeWith({ [FCT_ORDER]: replace("alias: 'orders',", "alias: 'orders',\n  meta_purpose: 'kept as metadata',") }));
    const [p] = finding(r, 'fieldMetaShadowsBuiltIn');
    expect(p).toMatchObject({ severity: 'info', count: 1, table: 'fct_order', key: 'purpose' });
    expect(p.message).toContain('"purpose (metadata)"');
    // Not an old spelling: a new file writes meta.purpose as meta_purpose too.
    expect(finding(r, 'fieldOldSpellings')[0].count).toBe(3);
  });
});

describe('field findings on a YAML project', () => {
  function yamlProject(table: string, fields?: string): string {
    const root = copyFixture('logical-only');
    fs.writeFileSync(path.join(root, '.erd-studio', 'tables', 'customer.yml'), table);
    if (fields !== undefined) fs.writeFileSync(path.join(root, '.erd-studio', 'fields.yml'), fields);
    return root;
  }
  const TABLE = `name: customer
tableRole: conformed-dim
grain: One row per customer
rationale:
  purpose: Who the customers are
  design: SCD2 on segment
meta:
  purpose: shadowed
  sensitivity: secret
  tier: gold
columns:
  - name: customer_id
    dataType: INT
    isPrimaryKey: true
    meta:
      pii: maybe
`;

  it('runs the choice, retired, not-in-list and shadow checks; never the spelling checks', async () => {
    const r = await doctor(yamlProject(TABLE, TEAM_FIELDS));
    expect(r.erd.storage).toBe('yaml');
    expect(finding(r, 'fieldValueOutsideChoices').map((p) => p.message)).toEqual([
      'customer: sensitivity is secret; fields.yml allows public, internal, confidential.',
      'customer.customer_id: pii is maybe; fields.yml allows true or false.',
    ]);
    expect(finding(r, 'fieldRetired')[0]).toMatchObject({ count: 1, table: 'customer', key: 'design' });
    expect(finding(r, 'fieldNotInList')[0].message).toContain('tier');
    expect(finding(r, 'fieldMetaShadowsBuiltIn')[0]).toMatchObject({ key: 'purpose', count: 1 });
    expect(finding(r, 'fieldOldSpellings')).toEqual([]);
    expect(finding(r, 'fieldSpelledTwice')).toEqual([]);
    expect(ids(r)).toEqual(['ready']);
  });

  it('reads fields.yml in a YAML project, and its errors raise fix-fields-file', async () => {
    const r = await doctor(yamlProject(TABLE, 'tables:\n  - key: Bad Key\n'));
    expect(finding(r, 'fieldsKeyInvalid')[0]).toMatchObject({ severity: 'error', file: '.erd-studio/fields.yml', line: 2 });
    expect(ids(r)).toEqual(['fix-fields-file']);
  });
});

describe('summariseFields (pure)', () => {
  const reading = (text?: string) => {
    if (text === undefined) return readFieldsFile(path.join(tmp, 'none'));
    const dir = path.join(tmp, `sem-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'fields.yml'), text);
    return readFieldsFile(dir);
  };
  const table = (t: Partial<SemanticTable>): SemanticTable => ({ name: 't', columns: [], ...t } as SemanticTable);

  it('never checks the table role, which the canvas offers as its own dropdown', () => {
    const s = summariseFields(reading(), '.erd-studio/fields.yml', [{ name: 't', file: 'x.dbml', table: table({ modelRole: 'weird' as never }) }]);
    expect(s.problems.filter((p) => p.code === 'fieldValueOutsideChoices')).toEqual([]);
  });

  it('a built-in choice outside its options names the field when there is no fields.yml', () => {
    const s = summariseFields(reading(), '.erd-studio/fields.yml', [{
      name: 't', file: 'x.yml', table: table({ columns: [{ name: 'c', dataType: 'INT', scdType: 7 as never }] as never }),
    }]);
    expect(s.problems.filter((p) => p.code === 'fieldValueOutsideChoices').map((p) => p.message)).toEqual(['t.c: scd_type is 7; SCD type allows 0, 1, 2.']);
  });

  it('a field problem from the DBML reader is reported here as a warning', () => {
    const s = summariseFields(reading(), '.erd-studio/fields.yml', [{
      name: 't', file: '.erd-studio/x.dbml', table: table({}), readerProblems: [{ code: 'fieldSomething', line: 3, message: 'odd' }],
    }]);
    expect(s.problems).toEqual([{ code: 'fieldSomething', severity: 'warning', message: 'odd', file: '.erd-studio/x.dbml', table: 't', line: 3 }]);
  });

  it('spellings with no value name none as used', () => {
    const s = summariseFields(reading(), '.erd-studio/fields.yml', [{
      name: 't', file: 'x.dbml', table: table({}),
      spellings: [
        { owner: '', home: 'rationale', key: 'purpose', spelling: 'bare', used: false, old: false },
        { owner: '', home: 'rationale', key: 'purpose', spelling: 'rationale', used: false, old: true },
        { owner: '', home: 'rationale', key: 'purpose', spelling: 'erd', used: false, old: false },
      ],
    }]);
    const [p] = s.problems.filter((q) => q.code === 'fieldSpelledTwice');
    expect(p.message).toBe('t has purpose, rationale_purpose and an erd_ spelling of purpose; none of them has a value. Keep one and remove the others.');
  });

  it('isFieldProblemCode picks out field codes only', () => {
    expect(isFieldProblemCode('fieldSpelledTwice')).toBe(true);
    expect(isFieldProblemCode('metaJson')).toBe(false);
    expect(isFieldProblemCode(3075)).toBe(false);
    for (const code of FIELD_FINDING_CODES) expect(isFieldProblemCode(code)).toBe(true);
  });
});

describe('human output', () => {
  it('errors ✗, warnings !, one line per piece of information, and a line for the list', async () => {
    const r = await doctor(nativeWith({
      'fields.yml': `${TEAM_FIELDS}  - key: note\n    label: Note\n`,
      [FCT_ORDER]: replace("alias: 'orders',", "alias: 'orders',\n  sensitivity: 'secret',"),
    }));
    const out = formatDoctor(r, makePaint(false));
    // An error in the list marks the line as not in place.
    expect(out).toContain('– Fields: .erd-studio/fields.yml — 3 table fields, 2 column fields');
    expect(out).toMatch(/✗ \.erd-studio\/fields\.yml line \d+: .*note.* \(fieldsKeyReserved\)/);
    expect(out).toContain('! fct_order: sensitivity is secret; fields.yml allows public, internal, confidential. (fieldValueOutsideChoices)');
    const infos = out.split('\n').filter((l) => l.startsWith('· '));
    expect(infos.length).toBe(r.erd.fields.problems.filter((p) => p.severity === 'info').length);
    expect(infos.some((l) => l.includes('old spellings'))).toBe(true);
    expect(out).toContain('Fix a problem in the field list (.erd-studio/fields.yml)');
  });

  it('without fields.yml the line names the starting set', async () => {
    const out = formatDoctor(await doctor(copyFixture('dbml-native')), makePaint(false));
    expect(out).toContain('✓ Fields: the starting set (no fields.yml) — 7 table fields, 3 column fields');
  });

  it('a broken fields.yml says the starting set is used', async () => {
    const out = formatDoctor(await doctor(nativeWith({ 'fields.yml': 'tables: [grain\n' })), makePaint(false));
    expect(out).toContain('– Fields: the starting set (.erd-studio/fields.yml could not be read)');
  });
});

describe('doctor --json', () => {
  it('carries erd.fields', async () => {
    const root = nativeWith({ 'fields.yml': TEAM_FIELDS });
    let out = '';
    const code = await main(['doctor', '--project', root, '--no-dbt', '--json'], {
      stdout: { write: (s: string) => { out += s; } },
      stderr: { write: () => {} },
      cwd: tmp,
      env: cleanEnv,
    });
    expect(code).toBe(0);
    const json = JSON.parse(out) as DoctorResult;
    expect(json.erd.fields).toMatchObject({ file: '.erd-studio/fields.yml', source: 'file', tables: ['grain', 'purpose', 'sensitivity'] });
    expect(json.erd.dbmlProblems).toEqual([]);
  });
});

describe('fieldMetaShadowsBuiltIn wording', () => {
  const table = (meta: Record<string, string>): SemanticTable => ({ name: 't', columns: [], meta } as unknown as SemanticTable);
  const none = () => readFieldsFile(path.join(tmp, 'none'));
  const message = (meta: Record<string, string>): string =>
    summariseFields(none(), '.erd-studio/fields.yml', [{ name: 't', file: 'x.yml', table: table(meta) }])
      .problems.find((p) => p.code === 'fieldMetaShadowsBuiltIn')!.message;

  it('names a built-in, a reserved name, or both', () => {
    expect(message({ retention: '7 years' })).toBe('1 table has metadata named retention, the name of a built-in field. '
      + 'It stays metadata, shown as "retention (metadata)", apart from the built-in.');
    expect(message({ note: 'x' })).toBe('1 table has metadata named note, a name DBML or ERD Studio reserves. It stays metadata, shown as "note (metadata)".');
    expect(message({ purpose: 'x', note: 'y' })).toContain('the name of a built-in field or a reserved setting');
  });

  it('a bare team key is no shadow', () => {
    const s = summariseFields(none(), '.erd-studio/fields.yml', [{ name: 't', file: 'x.yml', table: table({ owner: 'a' }) }]);
    expect(s.problems).toEqual([]);
  });
});

describe('fix-fields-file wording', () => {
  it('lists every error once, with no doubled full stop', async () => {
    const r = await doctor(nativeWith({ 'fields.yml': 'tables:\n  - key: note\n  - key: Bad\n' }));
    const step = r.nextSteps.find((s) => s.id === 'fix-fields-file')!;
    expect(step.title).toBe('Fix 2 problems in the field list (.erd-studio/fields.yml)');
    expect(step.why).toContain('.erd-studio/fields.yml:2 (fieldsKeyReserved)');
    expect(step.why).toContain('.erd-studio/fields.yml:3 (fieldsKeyInvalid)');
    expect(step.why).not.toContain('..');
  });
});
