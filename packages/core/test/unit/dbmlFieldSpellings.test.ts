/**
 * Context fields in native DBML storage (spec §4 and amendments A1–A10): a
 * field is one setting `<key>: '<value>'`, and every older spelling of it
 * still reads as the same field.
 *
 * - `fixtures/dbml/fields-old` is a project in the spellings the 2.0
 *   pre-releases wrote (`rationale_*`, `meta_*`, `meta_json`, `erd_`
 *   variants, Metadata blocks). Its golden (`tables.golden.json`) was taken
 *   with the reader as it was before context fields, so it pins that no
 *   old file reads differently.
 * - `fixtures/dbml/fields-new` holds the same tables in the bare spellings,
 *   which must read as exactly the same tables, and `fct_return`, a table
 *   holding both spellings of several fields.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { parseTableDbml } from '../../src/dbml/readTable';
import type { DbmlTableReading } from '../../src/types/dbmlStorage';
import { STORAGE_PARSERS } from '../dbmlParsers';

type Ok = Extract<DbmlTableReading, { ok: true }>;

const FIXTURES = path.resolve(__dirname, '../fixtures/dbml');
const OLD = path.join(FIXTURES, 'fields-old');
const NEW = path.join(FIXTURES, 'fields-new');
const TABLES = 'gold/tables/gold';
const GOLDEN = path.join(OLD, 'tables.golden.json');

function read(project: string, stem: string, parser?: (typeof STORAGE_PARSERS)[number][1]): Ok {
  const text = fs.readFileSync(path.join(project, '.erd-studio', TABLES, `${stem}.dbml`), 'utf8');
  const reading = parseTableDbml(text, stem, { schemaFolder: 'gold' }, parser);
  if (!reading.ok) throw new Error(`${stem}: ${reading.error.message}`);
  return reading;
}

const TWINS = ['fct_sale', 'dim_store'];

describe('old spellings read as they always did (the fields-old golden)', () => {
  const tables = Object.fromEntries(TWINS.map((stem) => [stem, read(OLD, stem).table]));

  it('matches the golden taken before context fields, key order included', () => {
    const text = `${JSON.stringify(tables, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === '1' && !fs.existsSync(GOLDEN)) fs.writeFileSync(GOLDEN, text);
    expect(text).toBe(fs.readFileSync(GOLDEN, 'utf8'));
  });

  it.each(STORAGE_PARSERS)('reads the same in %s', (_label, parser) => {
    for (const stem of TWINS) expect(read(OLD, stem, parser).table).toEqual(tables[stem]);
  });
});

describe('the bare spellings read as the same tables (the fields-new twin)', () => {
  it.each(STORAGE_PARSERS)('fct_sale and dim_store read exactly as fields-old reads them, key order included (%s)', (_label, parser) => {
    for (const stem of TWINS) {
      const bare = read(NEW, stem, parser).table;
      const old = read(OLD, stem, parser).table;
      expect(bare).toEqual(old);
      expect(JSON.stringify(bare)).toBe(JSON.stringify(old));
    }
  });

  it('the old file\'s spellings are reported as old, the twin\'s as new', () => {
    const old = read(OLD, 'fct_sale').fieldSpellings ?? [];
    const bare = read(NEW, 'fct_sale').fieldSpellings ?? [];
    expect(old.filter((s) => s.old).map((s) => `${s.owner}.${s.key}:${s.spelling}`)).toEqual([
      '.purpose:rationale', '.design:rationale', '.measures:rationale', '.owner:meta', '.tier:meta', '.role_choice:rationale', '.reviewed:meta',
      'store_key.source:meta', 'amount.unit:meta',
    ]);
    // erd_ spellings are never old; meta_json entries that are not text are never old.
    expect(old.filter((s) => s.spelling === 'erd').map((s) => [s.key, s.old])).toEqual([['grain_choice', false], ['steward', false]]);
    expect(old.filter((s) => s.spelling === 'json').map((s) => [s.owner, s.key, s.old])).toEqual([['', 'pii', false], ['', 'tags', false], ['amount', 'sensitive', false]]);
    expect(bare.filter((s) => s.old)).toEqual([]);
    expect(bare.every((s) => s.used)).toBe(true);
  });

  it('a table with no field setting has no fieldSpellings', () => {
    const reading = parseTableDbml("Table t [role: 'reference', grain: 'g', color: 'x'] {\n  id int [pk, natural_key: 'true']\n}\n", 't');
    expect(reading.ok && reading.fieldSpellings).toBeUndefined();
  });
});

describe('both spellings at once (fields-new fct_return)', () => {
  it.each(STORAGE_PARSERS)('reads each field from its winning spelling, and never a reserved or multi-word setting (%s)', (_label, parser) => {
    const { table, problems } = read(NEW, 'fct_return', parser);
    expect(problems).toEqual([]);
    expect(table).toEqual({
      name: 'fct_return',
      schema: 'gold',
      modelRole: 'transaction-fact',
      rationale: {
        purpose: 'Returns, bare',
        decisions: 'Returns are their own fact, not negative sales',
        openQuestions: 'Do exchanges count as returns?',
        sourceOfTruth: 'POS',
        knownIssues: 'Late returns arrive a week after the sale',
      },
      meta: {
        owner: 'returns-team',
        sla: 'Next day',
        purpose: 'kept as metadata, never the built-in',
        note: 'a team key named like a DBML setting',
      },
      columns: [
        { name: 'return_id', dataType: 'BIGINT', description: '', isPrimaryKey: true },
        { name: 'store_key', dataType: 'INT', description: '', isForeignKey: true, meta: { purpose: 'a column field of its own', owner: 'new team' } },
        { name: 'reason', dataType: 'VARCHAR', description: '', meta: { pii: true, reviewed: 'yes' } },
      ],
    });
    expect(Object.keys(table.rationale!)).toEqual(['purpose', 'decisions', 'openQuestions', 'sourceOfTruth', 'knownIssues']);
    expect(Object.keys(table.meta!)).toEqual(['owner', 'sla', 'purpose', 'note']);
  });

  it('lists every spelling, which one is used, and which are old', () => {
    const spellings = read(NEW, 'fct_return').fieldSpellings!;
    expect(spellings.map((s) => [s.owner, s.home, s.key, s.spelling, s.used, s.old])).toEqual([
      ['', 'rationale', 'purpose', 'bare', true, false],
      ['', 'rationale', 'purpose', 'rationale', false, true],
      ['', 'rationale', 'decisions', 'bare', true, false],
      ['', 'rationale', 'open_questions', 'bare', false, false], // empty: skipped, so not used
      ['', 'rationale', 'open_questions', 'rationale', true, true],
      ['', 'rationale', 'source_of_truth', 'bare', true, false],
      ['', 'meta', 'owner', 'bare', true, false],
      ['', 'meta', 'owner', 'meta', false, true],
      ['', 'meta', 'sla', 'rationale', true, true], // rationale_<k> of a team key: an old spelling of that team field
      ['', 'meta', 'purpose', 'meta', true, false], // a built-in's name kept as metadata: meta_ is its spelling
      ['', 'meta', 'note', 'meta', true, false], // a reserved name: meta_ is its spelling
      ['', 'rationale', 'known_issues', 'bare', true, false], // from the Metadata block
      ['store_key', 'meta', 'purpose', 'bare', true, false], // a column has no Purpose: a team field
      ['store_key', 'meta', 'owner', 'rationale', false, true],
      ['store_key', 'meta', 'owner', 'bare', true, false],
      ['reason', 'meta', 'pii', 'json', true, false],
      ['reason', 'meta', 'reviewed', 'json', false, true],
      ['reason', 'meta', 'reviewed', 'bare', true, false],
    ]);
  });

  it('names the setting each spelling was read from, as the file writes it', () => {
    const spellings = read(NEW, 'fct_return').fieldSpellings!;
    expect(spellings.map((s) => [s.owner, s.key, s.name])).toEqual([
      ['', 'purpose', 'purpose'],
      ['', 'purpose', 'rationale_purpose'],
      ['', 'decisions', 'decisions'],
      ['', 'open_questions', 'open_questions'],
      ['', 'open_questions', 'rationale_open_questions'],
      ['', 'source_of_truth', 'source_of_truth'],
      ['', 'owner', 'owner'],
      ['', 'owner', 'meta_owner'],
      ['', 'sla', 'rationale_sla'],
      ['', 'purpose', 'meta_purpose'],
      ['', 'note', 'meta_note'],
      ['', 'known_issues', 'known_issues'],
      ['store_key', 'purpose', 'purpose'],
      ['store_key', 'owner', 'rationale_owner'],
      ['store_key', 'owner', 'owner'],
      ['reason', 'pii', 'meta_json'],
      ['reason', 'reviewed', 'meta_json'],
      ['reason', 'reviewed', 'reviewed'],
    ]);
  });

  it('names an erd_ spelling exactly', () => {
    const spellings = inline("erd_rationale_purpose: 'e', purpose: 'b', erd_meta_owner: 'o'").fieldSpellings!;
    expect(spellings.map((s) => [s.key, s.spelling, s.name])).toEqual([
      ['purpose', 'erd', 'erd_rationale_purpose'],
      ['purpose', 'bare', 'purpose'],
      ['owner', 'erd', 'erd_meta_owner'],
    ]);
  });
});

/** Read one inline table under the pin. */
function inline(settings: string, column = ''): Ok {
  const reading = parseTableDbml(`Table t [${settings}] {\n  id int${column ? ` [${column}]` : ''}\n}\n`, 't');
  if (!reading.ok) throw new Error(reading.error.message);
  return reading;
}

describe('precedence (A4)', () => {
  it('a rationale-home field: erd_K, K, erd_rationale_K, rationale_K — the first with text, whatever the order', () => {
    expect(inline("rationale_purpose: 'r', erd_rationale_purpose: 'er', purpose: 'b', erd_purpose: 'e'").table.rationale).toEqual({ purpose: 'e' });
    expect(inline("rationale_purpose: 'r', erd_rationale_purpose: 'er', purpose: 'b'").table.rationale).toEqual({ purpose: 'b' });
    expect(inline("rationale_purpose: 'r', erd_rationale_purpose: 'er'").table.rationale).toEqual({ purpose: 'er' });
    // An empty spelling is skipped (today's rationale rule), and an all-empty field is no value.
    expect(inline("erd_purpose: '', purpose: '', rationale_purpose: 'r'").table.rationale).toEqual({ purpose: 'r' });
    expect(inline("purpose: '', rationale_purpose: ''").table.rationale).toBeUndefined();
  });

  it('a meta key: erd_k, k, erd_meta_k, meta_k, erd_rationale_k, rationale_k, then meta_json — \'\' is a value', () => {
    const json = `meta_json: '{"owner":"j"}'`;
    expect(inline(`${json}, rationale_owner: 'r', meta_owner: 'm', owner: 'b', erd_owner: 'e'`).table.meta).toEqual({ owner: 'e' });
    expect(inline(`${json}, rationale_owner: 'r', meta_owner: 'm', owner: 'b'`).table.meta).toEqual({ owner: 'b' });
    expect(inline(`${json}, rationale_owner: 'r', erd_meta_owner: 'em', meta_owner: 'm'`).table.meta).toEqual({ owner: 'em' });
    expect(inline(`${json}, rationale_owner: 'r', erd_rationale_owner: 'er'`).table.meta).toEqual({ owner: 'er' });
    expect(inline(`${json}, rationale_owner: 'r'`).table.meta).toEqual({ owner: 'r' });
    expect(inline(`owner: '', meta_owner: 'm'`).table.meta).toEqual({ owner: '' });
  });

  it('a meta key stands where its winning spelling stands; a shadowed meta_json copy is skipped', () => {
    const read1 = inline(`team: 't', meta_json: '{"pii":true,"owner":"j"}', owner: 'b'`);
    expect(Object.keys(read1.table.meta!)).toEqual(['team', 'pii', 'owner']);
    expect(read1.table.meta).toEqual({ team: 't', pii: true, owner: 'b' });
  });

  it('a Metadata block entry of the same name wins over the inline one (D25), as one spelling', () => {
    const text = "Table t [purpose: 'inline', owner: 'inline'] {\n  id int\n}\nMetadata Table t {\n  purpose: 'block'\n  owner: 'block'\n}\n";
    const reading = parseTableDbml(text, 't');
    expect(reading.ok && reading.table.rationale).toEqual({ purpose: 'block' });
    expect(reading.ok && reading.table.meta).toEqual({ owner: 'block' });
    expect(reading.ok && reading.fieldSpellings!.map((s) => [s.key, s.spelling])).toEqual([['purpose', 'bare'], ['owner', 'bare']]);
  });

  it('typed settings keep their own rule: erd_<x> wins over <x>, even when empty', () => {
    expect(inline("grain: 'g', erd_grain: ''").table.grain).toBeUndefined();
    expect(inline("role: 'r', erd_role: 'e'").table.modelRole).toBe('e');
  });
});

describe('what is and is not a field', () => {
  it('reserved bare settings are never read as fields: DBML settings, ERD Studio\'s own names, prefixes, json, dbml', () => {
    const reading = inline("color: 'c', name: 'n', type: 'x', example: 'e', inactive: 'i', update: 'u', primary_key: 'p', not_null: 'n', linked_table: 'l', json: 'j', dbml: 'd', erd_placeholder: 'p'");
    expect(reading.table.meta).toBeUndefined();
    expect(reading.table.rationale).toBeUndefined();
    expect(reading.fieldSpellings).toBeUndefined();
  });

  it('team keys read bare on the table and on columns; business_rule is a column field kept in meta', () => {
    const reading = inline("owner: 'o', business_rule: 'table rule'", "business_rule: 'b', unit: 'AUD', purpose: 'p'");
    expect(reading.table.meta).toEqual({ owner: 'o', business_rule: 'table rule' });
    expect(reading.table.columns![0].meta).toEqual({ business_rule: 'b', unit: 'AUD', purpose: 'p' });
  });

  it('a column has no rationale: its rationale_<k> is an old spelling of the team field k', () => {
    const reading = inline('', "rationale_purpose: 'p', rationale_tier: 't'");
    expect(reading.table.columns![0].meta).toEqual({ purpose: 'p', tier: 't' });
  });

  it('a table\'s rationale_<k> for a team key reads as meta; rationale_unknown is no longer dropped', () => {
    expect(inline("rationale_unknown: 'u'").table).toMatchObject({ meta: { unknown: 'u' } });
    expect(inline("rationale_unknown: 'u'").table.rationale).toBeUndefined();
  });

  it('meta_<k> of any key still reads (today\'s read path), the parser-unsafe names included', () => {
    expect(inline("meta_1x: 'a', meta_purpose: 'p', meta_note: 'n', meta_erd_x: 'e', meta_rationale_x: 'r', meta_meta_x: 'm'").table.meta)
      .toEqual({ '1x': 'a', purpose: 'p', note: 'n', erd_x: 'e', rationale_x: 'r', meta_x: 'm' });
  });

  it.each(STORAGE_PARSERS)('constructor and __proto__ read from meta_ spellings in every parser (%s)', (_label, parser) => {
    const reading = parseTableDbml("Table t [meta_constructor: 'c', meta___proto__: 'p'] {\n  id int [meta_constructor: 'cc']\n}\n", 't', {}, parser);
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(Object.keys(reading.table.meta!)).toEqual(['constructor', '__proto__']);
    expect(Object.getOwnPropertyDescriptor(reading.table.meta!, '__proto__')?.value).toBe('p');
    expect(reading.table.meta!.constructor).toBe('c');
    expect(reading.table.columns![0].meta!.constructor).toBe('cc');
  });
});
