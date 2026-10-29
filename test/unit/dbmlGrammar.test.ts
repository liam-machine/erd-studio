/**
 * The DBML language contribution: syntaxes/dbml.tmLanguage.json (a TextMate
 * translation of the Monarch tokenizer in @dbml/parse) tokenized by the same
 * engine VS Code runs (vscode-textmate on the oniguruma WASM), plus the
 * package.json entries that ship it.
 *
 * The samples are the three file kinds ERD Studio writes (a table file, a
 * relationships file and a diagram file, laid out as the formatter lays them
 * out) and each one is checked to parse in the pinned parser first, so the
 * grammar is tested against syntax DBML really accepts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';
import { compileOne } from '../../packages/core/src/dbml/parser';

const REPO_ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const GRAMMAR_PATH = path.join(REPO_ROOT, 'syntaxes/dbml.tmLanguage.json');
const CONFIG_PATH = path.join(REPO_ROOT, 'syntaxes/dbml.language-configuration.json');

let grammar: vsctm.IGrammar;

beforeAll(async () => {
  const wasm = fs.readFileSync(path.join(REPO_ROOT, 'node_modules/vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
      createOnigString: (text: string) => new oniguruma.OnigString(text),
    }),
    loadGrammar: async (scopeName: string) =>
      scopeName === 'source.dbml' ? vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR_PATH, 'utf-8'), GRAMMAR_PATH) : null,
  });
  const loaded = await registry.loadGrammar('source.dbml');
  if (!loaded) throw new Error('source.dbml did not load');
  grammar = loaded;
});

interface Token {
  text: string;
  start: number;
  scopes: string[];
}

/** Tokenize `text` line by line, carrying the rule stack as VS Code does. */
function tokenize(text: string): Array<{ line: string; tokens: Token[] }> {
  let stack = vsctm.INITIAL;
  return text.split('\n').map((line) => {
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    return {
      line,
      tokens: result.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), start: t.startIndex, scopes: t.scopes })),
    };
  });
}

/**
 * The scopes of `token` on the first line that contains `lineMarker` (the
 * `nth` occurrence of `token` on that line). Fails unless the token is exactly
 * one grammar token, so a scope cannot leak onto its neighbours unnoticed.
 */
function scopesOf(tokenized: ReturnType<typeof tokenize>, lineMarker: string, token: string, nth = 0): string[] {
  const entry = tokenized.find((l) => l.line.includes(lineMarker));
  if (!entry) throw new Error(`no line contains ${JSON.stringify(lineMarker)}`);
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = entry.line.indexOf(token, at + 1);
    if (at < 0) throw new Error(`${JSON.stringify(token)} #${nth} not on line ${JSON.stringify(entry.line)}`);
  }
  const found = entry.tokens.find((t) => t.start === at);
  expect(found?.text, `token at ${at} on ${JSON.stringify(entry.line)}`).toBe(token);
  return found!.scopes;
}

function syntaxErrors(text: string): string[] {
  return compileOne(text)
    .errors.filter((e) => e.code < 2000)
    .map((e) => `[${e.code}] ${e.message} (line ${e.line})`);
}

const TABLE_FILE = [
  '// Order lines from the shop. Hand-written comments like this one survive every save.',
  'Table fct_order [',
  "  schema: 'gold',",
  "  role: 'transaction-fact',",
  "  grain: 'One row per order line',",
  "  rationale_purpose: 'Revenue reporting',",
  `  meta_json: '{"pii":false}'`,
  '] {',
  "  Note: '''",
  '    Order lines,',
  "    kept with their indent'''",
  "  order_line_id BIGINT [pk, note: 'Line id from the shop']",
  "  customer_key  INT    [foreign_key: 'true']",
  '  amount        "DECIMAL(18,2)" [',
  "    additive_type: 'additive',",
  "    note: 'Line total' // trailing comment",
  '  ]',
  '  price         decimal(18, 2) [not null, default: 0.5]',
  '  loaded_at     timestamp [null, default: `now()`, unique]',
  "  scd           INT [scd_type: '2', natural_key: 'true']",
  '  indexes {',
  '    (order_line_id, loaded_at) [pk]',
  "    loaded_at [type: btree, name: 'ix_loaded']",
  '  }',
  '  /* a block',
  '     comment */',
  '}',
  '',
].join('\n');

const RELATIONSHIPS_FILE = [
  '// ERD Studio relationships. Each Ref belongs to its foreign-key table.',
  "use { table dim_date } from '../dim_date.dbml'",
  "use { table dim_customer } from './dim_customer.dbml'",
  "use { table fct_order } from './fct_order.dbml'",
  '',
  'Ref: dim_customer.customer_key ?- customer_profile.customer_key',
  'Ref "order date": fct_order.order_date_key >? dim_date.date_key',
  'Ref: fct_order.(region_code, country_code) >? dim_region.(region_code, country_code) [delete: cascade]',
  'Ref: fct_order.customer_key <>? dim_customer.customer_key',
  '// erd-studio pending: Ref: fct_order.ship_date_key >? dim_date.date_key',
  '',
].join('\n');

const DIAGRAM_FILE = [
  'Project sales {',
  "  Note: 'Sales star schema'",
  "  database_type: 'PostgreSQL'",
  "  erd_schema_version: '7'",
  `  erd_layout_options: '{"elk.direction":"RIGHT"}'`,
  '}',
  '',
  "use { table fct_order } from '../tables/gold/fct_order.dbml'",
  "use * from '../tables/gold/_relationships.dbml'",
  '',
  `Note "3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c" [color: #f59e0b, linked_table: 'fct_order'] {`,
  "  '''",
  '  Check the grain',
  "  with finance'''",
  '}',
  '',
].join('\n');

describe('the samples are DBML the pinned parser reads', () => {
  it('has no syntax error in the table, relationships or diagram sample', () => {
    expect(syntaxErrors(TABLE_FILE)).toEqual([]);
    expect(syntaxErrors(RELATIONSHIPS_FILE)).toEqual([]);
    expect(syntaxErrors(DIAGRAM_FILE)).toEqual([]);
  });
});

describe('dbml.tmLanguage.json: a table file', () => {
  it('scopes comments, the Table keyword and its name', () => {
    const t = tokenize(TABLE_FILE);
    expect(scopesOf(t, '// Order lines', '//')).toContain('comment.line.double-slash.dbml');
    expect(scopesOf(t, '// Order lines', ' Order lines from the shop. Hand-written comments like this one survive every save.')).toContain(
      'comment.line.double-slash.dbml',
    );
    expect(scopesOf(t, 'Table fct_order', 'Table')).toContain('keyword.other.table.dbml');
    expect(scopesOf(t, 'Table fct_order', 'fct_order')).toContain('entity.name.type.table.dbml');
    expect(scopesOf(t, 'a block', '/*')).toContain('comment.block.dbml');
    expect(scopesOf(t, 'comment */', '*/')).toContain('comment.block.dbml');
  });

  it('gives ERD Studio custom properties their own scope, apart from built-in settings', () => {
    const t = tokenize(TABLE_FILE);
    for (const key of ['schema', 'role', 'grain', 'rationale_purpose', 'meta_json']) {
      expect(scopesOf(t, `  ${key}:`, key), key).toContain('variable.other.property.erd-studio.dbml');
    }
    expect(scopesOf(t, 'customer_key  INT', 'foreign_key')).toContain('variable.other.property.erd-studio.dbml');
    expect(scopesOf(t, 'additive_type:', 'additive_type')).toContain('variable.other.property.erd-studio.dbml');
    expect(scopesOf(t, 'scd           INT', 'scd_type')).toContain('variable.other.property.erd-studio.dbml');
    expect(scopesOf(t, 'scd           INT', 'natural_key')).toContain('variable.other.property.erd-studio.dbml');

    expect(scopesOf(t, 'order_line_id BIGINT', 'pk')).toContain('keyword.other.setting.dbml');
    expect(scopesOf(t, 'order_line_id BIGINT', 'note')).toContain('keyword.other.setting.dbml');
    expect(scopesOf(t, 'price ', 'not null')).toContain('keyword.other.setting.dbml');
    expect(scopesOf(t, 'price ', 'default')).toContain('keyword.other.setting.dbml');
    expect(scopesOf(t, 'loaded_at     timestamp', 'null')).toContain('keyword.other.setting.dbml');
    expect(scopesOf(t, 'loaded_at     timestamp', 'unique')).toContain('keyword.other.setting.dbml');
    expect(scopesOf(t, "note: 'Line total'", 'note')).toContain('keyword.other.setting.dbml');
  });

  it('scopes column names, types and type arguments, aligned or not', () => {
    const t = tokenize(TABLE_FILE);
    expect(scopesOf(t, 'order_line_id BIGINT', 'order_line_id')).toContain('variable.other.column.dbml');
    expect(scopesOf(t, 'order_line_id BIGINT', 'BIGINT')).toContain('support.type.dbml');
    expect(scopesOf(t, 'customer_key  INT', 'customer_key')).toContain('variable.other.column.dbml');
    expect(scopesOf(t, 'customer_key  INT', 'INT')).toContain('support.type.dbml');
    expect(scopesOf(t, 'amount ', 'amount')).toContain('variable.other.column.dbml');
    expect(scopesOf(t, 'amount ', '"DECIMAL(18,2)"')).toContain('support.type.dbml');
    expect(scopesOf(t, 'price ', 'decimal')).toContain('support.type.dbml');
    expect(scopesOf(t, 'price ', '18')).toContain('constant.numeric.dbml');
    expect(scopesOf(t, 'price ', '2')).toContain('constant.numeric.dbml');
    expect(scopesOf(t, 'price ', '0.5')).toContain('constant.numeric.dbml');
  });

  it('scopes strings of every quote style, the triple-quoted Note across lines', () => {
    const t = tokenize(TABLE_FILE);
    expect(scopesOf(t, "Note: '''", 'Note')).toContain('keyword.other.note.dbml');
    expect(scopesOf(t, "Note: '''", "'''")).toContain('string.quoted.triple.dbml');
    expect(scopesOf(t, 'Order lines,', '    Order lines,')).toContain('string.quoted.triple.dbml');
    expect(scopesOf(t, "indent'''", "'''")).toContain('punctuation.definition.string.end.dbml');
    expect(scopesOf(t, 'order_line_id BIGINT', 'Line id from the shop')).toContain('string.quoted.single.dbml');
    expect(scopesOf(t, 'loaded_at     timestamp', 'now()')).toContain('string.interpolated.backtick.dbml');
    // The Note's string ended: the next line is a column again.
    expect(scopesOf(t, 'order_line_id BIGINT', 'order_line_id')).not.toContain('string.quoted.triple.dbml');
  });

  it('scopes the indexes block, its columns and index settings', () => {
    const t = tokenize(TABLE_FILE);
    expect(scopesOf(t, 'indexes {', 'indexes')).toContain('keyword.other.indexes.dbml');
    expect(scopesOf(t, '(order_line_id, loaded_at)', 'order_line_id')).toContain('variable.other.column.dbml');
    expect(scopesOf(t, '(order_line_id, loaded_at)', 'pk')).toContain('keyword.other.setting.dbml');
    expect(scopesOf(t, 'ix_loaded', 'type')).toContain('keyword.other.setting.dbml');
    expect(scopesOf(t, 'ix_loaded', 'btree')).toContain('support.constant.dbml');
  });
});

describe('dbml.tmLanguage.json: a relationships file', () => {
  it('scopes use lines', () => {
    const t = tokenize(RELATIONSHIPS_FILE);
    expect(scopesOf(t, 'use { table dim_date }', 'use')).toContain('keyword.control.import.dbml');
    expect(scopesOf(t, 'use { table dim_date }', 'table')).toContain('keyword.other.table.dbml');
    expect(scopesOf(t, 'use { table dim_date }', 'dim_date')).toContain('entity.name.type.table.dbml');
    expect(scopesOf(t, 'use { table dim_date }', 'from')).toContain('keyword.control.from.dbml');
    expect(scopesOf(t, 'use { table dim_date }', '../dim_date.dbml')).toContain('string.quoted.single.dbml');
  });

  it('scopes Ref lines: keyword, role, ends and the relation operator', () => {
    const t = tokenize(RELATIONSHIPS_FILE);
    expect(scopesOf(t, 'Ref: dim_customer', 'Ref')).toContain('keyword.other.ref.dbml');
    expect(scopesOf(t, 'Ref: dim_customer', 'dim_customer')).toContain('entity.name.type.table.dbml');
    expect(scopesOf(t, 'Ref: dim_customer', 'customer_key')).toContain('variable.other.column.dbml');
    expect(scopesOf(t, 'Ref: dim_customer', '?-')).toContain('keyword.operator.relation.dbml');
    expect(scopesOf(t, 'Ref "order date"', '"order date"')).toContain('entity.name.function.ref.dbml');
    expect(scopesOf(t, 'Ref "order date"', '>?')).toContain('keyword.operator.relation.dbml');
    expect(scopesOf(t, 'Ref "order date"', 'date_key', 1)).toContain('variable.other.column.dbml');
    expect(scopesOf(t, 'Ref: fct_order.(region_code', 'country_code', 1)).toContain('variable.other.column.dbml');
    expect(scopesOf(t, 'Ref: fct_order.(region_code', 'dim_region')).toContain('entity.name.type.table.dbml');
    expect(scopesOf(t, 'Ref: fct_order.(region_code', 'delete')).toContain('keyword.other.setting.dbml');
    expect(scopesOf(t, 'Ref: fct_order.(region_code', 'cascade')).toContain('support.constant.dbml');
    expect(scopesOf(t, '<>?', '<>?')).toContain('keyword.operator.relation.dbml');
  });

  it('keeps a pending relationship a comment from end to end', () => {
    const t = tokenize(RELATIONSHIPS_FILE);
    const pending = t.find((l) => l.line.startsWith('// erd-studio pending:'))!;
    for (const token of pending.tokens) expect(token.scopes, token.text).toContain('comment.line.double-slash.dbml');
  });
});

describe('dbml.tmLanguage.json: a diagram file', () => {
  it('scopes the Project block: name, Note, built-in and ERD Studio keys', () => {
    const t = tokenize(DIAGRAM_FILE);
    expect(scopesOf(t, 'Project sales', 'Project')).toContain('keyword.other.project.dbml');
    expect(scopesOf(t, 'Project sales', 'sales')).toContain('entity.name.namespace.project.dbml');
    expect(scopesOf(t, "Note: 'Sales", 'Note')).toContain('keyword.other.note.dbml');
    expect(scopesOf(t, 'database_type', 'database_type')).toContain('keyword.other.setting.dbml');
    expect(scopesOf(t, 'erd_schema_version', 'erd_schema_version')).toContain('variable.other.property.erd-studio.dbml');
    expect(scopesOf(t, 'erd_schema_version', '7')).toContain('string.quoted.single.dbml');
  });

  it('scopes use * lines and the sticky Note with its settings and triple-quoted text', () => {
    const t = tokenize(DIAGRAM_FILE);
    expect(scopesOf(t, 'use *', '*')).toContain('keyword.operator.wildcard.dbml');
    expect(scopesOf(t, 'use *', 'use')).toContain('keyword.control.import.dbml');
    expect(scopesOf(t, 'Note "3f2b', 'Note')).toContain('keyword.other.note.dbml');
    expect(scopesOf(t, 'Note "3f2b', '"3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c"')).toContain('entity.name.type.note.dbml');
    expect(scopesOf(t, 'Note "3f2b', 'color')).toContain('keyword.other.setting.dbml');
    expect(scopesOf(t, 'Note "3f2b', '#f59e0b')).toContain('constant.other.color.rgb-value.hex.dbml');
    expect(scopesOf(t, 'Note "3f2b', 'linked_table')).toContain('variable.other.property.erd-studio.dbml');
    expect(scopesOf(t, 'Check the grain', '  Check the grain')).toContain('string.quoted.triple.dbml');
  });
});

describe('dbml.tmLanguage.json: other DBML', () => {
  it('scopes Enum, TableGroup, TablePartial, Records and custom keys', () => {
    const t = tokenize(
      [
        'Enum status {',
        "  active [note: 'On']",
        '}',
        'TableGroup sales_group [color: #000] {',
        '  fct_order',
        '}',
        'TablePartial audit [headercolor: #111111] {',
        "  created_at timestamp [team_flag: 'x']",
        '}',
        'Table t {',
        '  ~audit',
        '}',
        'Records t(id, ok) {',
        '  1, true, null',
        '}',
      ].join('\n'),
    );
    expect(scopesOf(t, 'Enum status', 'Enum')).toContain('keyword.other.enum.dbml');
    expect(scopesOf(t, 'Enum status', 'status')).toContain('entity.name.type.enum.dbml');
    expect(scopesOf(t, 'active [', 'active')).toContain('variable.other.enummember.dbml');
    expect(scopesOf(t, 'TableGroup', 'TableGroup')).toContain('keyword.other.tablegroup.dbml');
    expect(scopesOf(t, '  fct_order', 'fct_order')).toContain('entity.name.type.table.dbml');
    expect(scopesOf(t, 'TablePartial', 'TablePartial')).toContain('keyword.other.tablepartial.dbml');
    expect(scopesOf(t, 'team_flag', 'team_flag')).toContain('variable.other.property.dbml');
    expect(scopesOf(t, 'team_flag', 'team_flag')).not.toContain('variable.other.property.erd-studio.dbml');
    expect(scopesOf(t, '~audit', '~')).toContain('keyword.operator.partial-injection.dbml');
    expect(scopesOf(t, 'Records t', 'Records')).toContain('keyword.other.records.dbml');
    expect(scopesOf(t, '1, true', 'true')).toContain('constant.language.boolean.dbml');
    expect(scopesOf(t, '1, true', 'null')).toContain('constant.language.null.dbml');
  });

  it('recovers after an unterminated header or string', () => {
    const t = tokenize(['Table broken', 'Ref: a.b > c.d', 'Project p {', "  Note: 'open", "  erd_x: 'y'", '}'].join('\n'));
    expect(scopesOf(t, 'Ref: a.b', 'Ref')).toContain('keyword.other.ref.dbml');
    expect(scopesOf(t, 'Ref: a.b', '>')).toContain('keyword.operator.relation.dbml');
    // A single-quoted string cannot span lines in DBML: the next line is a key again.
    expect(scopesOf(t, 'erd_x', 'erd_x')).toContain('variable.other.property.erd-studio.dbml');
  });

  it('a column named like a keyword is still a column', () => {
    const t = tokenize(['Table x {', '  note varchar', '  records int', '  indexes text', '}'].join('\n'));
    for (const name of ['note', 'records', 'indexes']) {
      expect(scopesOf(t, `  ${name} `, name), name).toContain('variable.other.column.dbml');
    }
  });
});

describe('dbml.tmLanguage.json: structure', () => {
  const raw = JSON.parse(fs.readFileSync(GRAMMAR_PATH, 'utf-8'));

  function walk(node: unknown, visit: (key: string, value: unknown) => void): void {
    if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        visit(k, v);
        walk(v, visit);
      }
    }
  }

  it('every regex compiles under oniguruma', () => {
    const sources: string[] = [];
    walk(raw, (k, v) => {
      if (['match', 'begin', 'end', 'while'].includes(k) && typeof v === 'string') sources.push(v);
    });
    expect(sources.length).toBeGreaterThan(30);
    for (const source of sources) expect(() => new oniguruma.OnigScanner([source]), source).not.toThrow();
  });

  it('every include resolves and every scope is a .dbml scope', () => {
    walk(raw, (k, v) => {
      if (k === 'include' && typeof v === 'string' && v.startsWith('#')) expect(raw.repository, v).toHaveProperty([v.slice(1)]);
      if (k === 'name' && typeof v === 'string' && v !== 'DBML') expect(v, v).toMatch(/\.dbml$/);
    });
  });

  it('says it is derived from the @dbml/parse Monarch tokenizer and names source.dbml', () => {
    expect(raw.scopeName).toBe('source.dbml');
    expect(raw.information_for_contributors.join(' ')).toMatch(/Monarch tokenizer.*@dbml\/parse.*Apache-2\.0/s);
  });
});

describe('package.json: the dbml language', () => {
  it('contributes the dbml language for .dbml with its configuration, beside .dbdiagram as JSON', () => {
    const languages = pkg.contributes.languages as Array<Record<string, unknown>>;
    expect(languages).toContainEqual({ id: 'json', extensions: ['.dbdiagram'] });
    const dbml = languages.find((l) => l.id === 'dbml');
    expect(dbml).toEqual({
      id: 'dbml',
      aliases: ['DBML'],
      extensions: ['.dbml'],
      configuration: './syntaxes/dbml.language-configuration.json',
    });
  });

  it('contributes the grammar for dbml and makes ERD Studio the default dbml formatter, without format on save', () => {
    expect(pkg.contributes.grammars).toEqual([
      { language: 'dbml', scopeName: 'source.dbml', path: './syntaxes/dbml.tmLanguage.json' },
    ]);
    expect(pkg.contributes.configurationDefaults).toEqual({
      '[dbml]': {
        'editor.defaultFormatter': `${pkg.publisher}.${pkg.name}`,
        // The formatter's indent, so a line typed in a file with no indented lines yet gets 2 spaces.
        'editor.tabSize': 2,
        'editor.insertSpaces': true,
      },
    });
    expect(JSON.stringify(pkg.contributes.configurationDefaults)).not.toMatch(/formatOnSave/);
  });

  it('every contributed path exists, and none is excluded from the VSIX', () => {
    const paths = [
      ...pkg.contributes.languages.map((l: { configuration?: string }) => l.configuration).filter(Boolean),
      ...pkg.contributes.grammars.map((g: { path: string }) => g.path),
    ] as string[];
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.vscodeignore'), 'utf-8').split('\n').map((l) => l.trim());
    for (const p of paths) {
      expect(fs.existsSync(path.join(REPO_ROOT, p)), p).toBe(true);
      const top = p.replace(/^\.\//, '').split('/')[0];
      expect(ignore.filter((l) => l.startsWith(top)), p).toEqual([]);
    }
  });

  it('the language configuration is valid: its regexes compile and brackets indent', () => {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    expect(config.comments).toEqual({ lineComment: '//', blockComment: ['/*', '*/'] });
    expect(config.brackets).toEqual([
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ]);
    const quotes = config.autoClosingPairs.filter((p: { open: string }) => ["'", '"', '`'].includes(p.open));
    expect(quotes).toHaveLength(3);
    for (const q of quotes) expect(q.notIn).toEqual(['string', 'comment']);

    const increase = new RegExp(config.indentationRules.increaseIndentPattern);
    const decrease = new RegExp(config.indentationRules.decreaseIndentPattern);
    for (const line of ['Table fct_order {', 'Table fct_order [', '  amount "DECIMAL(18,2)" [', '  indexes {', 'Table x { // c']) {
      expect(increase.test(line), line).toBe(true);
    }
    for (const line of ['Table x { id int }', "  id int [pk] // not { here", "  Note: '''"]) expect(increase.test(line), line).toBe(false);
    for (const line of ['}', '  ]', '] {']) expect(decrease.test(line), line).toBe(true);
    for (const rule of config.onEnterRules) {
      expect(new RegExp(rule.beforeText).test('Table x {')).toBe(true);
      if (rule.afterText) expect(new RegExp(rule.afterText).test('}')).toBe(true);
    }
    expect(() => new RegExp(config.folding.markers.start)).not.toThrow();
    expect(() => new RegExp(config.folding.markers.end)).not.toThrow();
  });
});
