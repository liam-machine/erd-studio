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
 *
 * The package.json block also pins the three path-chosen language modes
 * (DBML Diagram, Table, Relationships): their icons, the one formatter and
 * grammar they share, and a mini VS Code glob checked against
 * `classifySemanticFile`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';
import { compileOne } from '../../packages/core/src/dbml/parser';
import { classifySemanticFile } from '../../packages/core/src/storage';
import { DBML_KIND_LANGUAGE_IDS, DBML_LANGUAGE_IDS, dbmlFileIconPath, type DbmlFileKind } from '../../src/providers/dbmlFileKinds';

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

/** The language ids ERD Studio contributes, in package.json's order. */
const LANGUAGE_IDS = ['dbml', 'dbml-diagram', 'dbml-table', 'dbml-relationships'];

/** The custom editor's DBML selector: the canvas opens what it matches. */
function canvasDbmlPattern(): string {
  const selector = pkg.contributes.customEditors[0].selector as Array<{ filenamePattern: string }>;
  const dbml = selector.filter((s) => s.filenamePattern.endsWith('.dbml'));
  expect(dbml).toHaveLength(1);
  return dbml[0].filenamePattern;
}

/**
 * A mini VS Code glob: `**\/` is any prefix (or none), `*` is any run within
 * one segment. Case-insensitive, as VS Code matches both language
 * `filenamePatterns` and custom-editor `filenamePattern`s (it lower-cases the
 * path and the pattern).
 */
function vscodeGlob(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (glob[i] === '*') {
      re += '[^/\\\\]*';
    } else {
      re += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/** The language VS Code gives `filePath`: a matching `filenamePatterns` entry beats an extension. */
function vscodeLanguageOf(filePath: string): string | undefined {
  const languages = pkg.contributes.languages as Array<{ id: string; filenamePatterns?: string[]; extensions?: string[] }>;
  const byPattern = languages.find((l) => (l.filenamePatterns ?? []).some((p) => vscodeGlob(p).test(filePath)));
  if (byPattern) return byPattern.id;
  return languages.find((l) => (l.extensions ?? []).some((e) => filePath.toLowerCase().endsWith(e.toLowerCase())))?.id;
}

/**
 * The language the classifier would give `filePath`: its kind's language
 * inside a `.erd-studio` folder (found in any case, as a case-insensitive
 * disk finds it), plain `dbml` otherwise.
 */
function classifierLanguageOf(filePath: string): string {
  const at = filePath.search(/\/\.erd-studio\//i);
  if (at < 0) return 'dbml';
  const rel = filePath.slice(at + '/.erd-studio/'.length);
  const cls = classifySemanticFile(rel, { tablesDirIsLayer: false });
  return cls.kind === 'diagram' || cls.kind === 'table' || cls.kind === 'relationships'
    ? DBML_KIND_LANGUAGE_IDS[cls.kind]
    : 'dbml';
}

const VSCODEIGNORE_LINES = fs.readFileSync(path.join(REPO_ROOT, '.vscodeignore'), 'utf-8').split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'));

/** A `.vscodeignore` glob as vsce's minimatch reads it: anchored at the root; `**` crosses folders, `*` does not. */
function ignoreGlob(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (glob[i] === '*') {
      re += '[^/]*';
    } else {
      re += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Whether vsce leaves `rel` out of the VSIX, read the way its `collectFiles`
 * reads `.vscodeignore`: a line whose last segment has no `*` also stands for
 * the folder of that name (`<line>/**`, or `<line>**` after a `/`), and a file
 * any line ignores ships only if any `!` line (wherever it sits) puts it back.
 */
function vscodeIgnores(rel: string, lines: string[] = VSCODEIGNORE_LINES): boolean {
  const all = [
    ...lines,
    ...lines.filter((l) => !/(^|\/)[^/]*\*[^/]*$/.test(l)).map((l) => (l.endsWith('/') ? `${l}**` : `${l}/**`)),
  ];
  const ignores = all.filter((l) => !l.startsWith('!'));
  const negations = all.filter((l) => l.startsWith('!')).map((l) => l.slice(1));
  return ignores.some((g) => ignoreGlob(g).test(rel)) && !negations.some((g) => ignoreGlob(g).test(rel));
}

const ICON_COLOURS: Record<DbmlFileKind, { dark: string; light: string }> = {
  table: { dark: '#3B82F6', light: '#2563EB' },
  relationships: { dark: '#8B5CF6', light: '#7C3AED' },
  diagram: { dark: '#0D9488', light: '#0F766E' },
};

describe('package.json: the dbml languages', () => {
  const languages = pkg.contributes.languages as Array<Record<string, unknown>>;

  it('contributes the dbml language for .dbml with its configuration and no icon, and none for .dbdiagram (positions are erd_layout)', () => {
    expect(languages.some((l) => (l.extensions as string[] | undefined)?.includes('.dbdiagram'))).toBe(false);
    const dbml = languages.find((l) => l.id === 'dbml');
    expect(dbml).toEqual({
      id: 'dbml',
      aliases: ['DBML'],
      extensions: ['.dbml'],
      configuration: './syntaxes/dbml.language-configuration.json',
    });
  });

  it('contributes a language for each kind of project file, chosen by path alone (no extensions), each with its own icon', () => {
    expect(languages.map((l) => l.id)).toEqual(LANGUAGE_IDS);
    expect([...DBML_LANGUAGE_IDS].sort()).toEqual([...LANGUAGE_IDS].sort());
    const kinds: Array<[DbmlFileKind, string, string]> = [
      ['diagram', 'DBML Diagram', '**/.erd-studio/*/diagrams/*.dbml'],
      ['table', 'DBML Table', '**/.erd-studio/*/tables/*/*.dbml'],
      ['relationships', 'DBML Relationships', '**/.erd-studio/*/relationships/*.dbml'],
    ];
    for (const [kind, alias, pattern] of kinds) {
      const language = languages.find((l) => l.id === DBML_KIND_LANGUAGE_IDS[kind]);
      expect(language, kind).toEqual({
        id: DBML_KIND_LANGUAGE_IDS[kind],
        aliases: [alias],
        filenamePatterns: [pattern],
        configuration: './syntaxes/dbml.language-configuration.json',
        icon: dbmlFileIconPath(kind),
      });
      expect(language).not.toHaveProperty('extensions');
    }
  });

  it('the dbml-diagram pattern is exactly the canvas selector, so every file shown as a DBML Diagram opens in the canvas', () => {
    const diagram = languages.find((l) => l.id === 'dbml-diagram') as { filenamePatterns: string[] };
    expect(diagram.filenamePatterns[0]).toBe(canvasDbmlPattern());
  });

  it('every id shares the one configuration, grammar and scopeName, and ERD Studio is each one\'s default formatter, without format on save', () => {
    for (const l of languages) expect(l.configuration, String(l.id)).toBe('./syntaxes/dbml.language-configuration.json');
    expect(pkg.contributes.grammars).toEqual(LANGUAGE_IDS.map((language) => (
      { language, scopeName: 'source.dbml', path: './syntaxes/dbml.tmLanguage.json' }
    )));
    const defaults = {
      'editor.defaultFormatter': `${pkg.publisher}.${pkg.name}`,
      // The formatter's indent, so a line typed in a file with no indented lines yet gets 2 spaces.
      'editor.tabSize': 2,
      'editor.insertSpaces': true,
    };
    expect(pkg.contributes.configurationDefaults).toEqual(
      Object.fromEntries(LANGUAGE_IDS.map((id) => [`[${id}]`, defaults])),
    );
    expect(JSON.stringify(pkg.contributes.configurationDefaults)).not.toMatch(/formatOnSave/);
  });

  it('every contributed path exists, and none is excluded from the VSIX', () => {
    // The matcher is not vacuous: it sees what .vscodeignore leaves out and puts back.
    expect(vscodeIgnores('media/demo.gif')).toBe(true);
    expect(vscodeIgnores('docs/dbml.md')).toBe(true);
    expect(vscodeIgnores('src/extension.ts')).toBe(true);
    expect(vscodeIgnores('README.md')).toBe(false);
    expect(vscodeIgnores('dist/extension.js')).toBe(false);
    expect(vscodeIgnores('media/icon.png')).toBe(false);
    // A line naming a folder leaves the whole folder out, and a `!` line puts a file back wherever it sits.
    const icon = 'media/file-icons/dbml-table-dark.svg';
    expect(vscodeIgnores(icon, ['media/file-icons'])).toBe(true);
    expect(vscodeIgnores(icon, ['media/'])).toBe(true);
    expect(vscodeIgnores(icon, ['!media/file-icons/*.svg', 'media/**'])).toBe(false);
    expect(vscodeIgnores(icon, ['media/*.svg'])).toBe(false);

    const paths = [
      ...languages.map((l) => l.configuration as string | undefined).filter(Boolean),
      ...languages.flatMap((l) => {
        const icon = l.icon as { light: string; dark: string } | undefined;
        return icon ? [icon.light, icon.dark] : [];
      }),
      ...pkg.contributes.grammars.map((g: { path: string }) => g.path),
    ] as string[];
    expect(paths.filter((p) => p.includes('file-icons'))).toHaveLength(6);
    for (const p of paths) {
      const rel = p.replace(/^\.\//, '');
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), p).toBe(true);
      expect(vscodeIgnores(rel), p).toBe(false);
    }
  });

  it('each icon is a 16×16 flat SVG with fixed colours; a light/dark pair differs only in colour; the three kinds differ', () => {
    const shapes = new Set<string>();
    for (const kind of Object.keys(ICON_COLOURS) as DbmlFileKind[]) {
      const { light, dark } = dbmlFileIconPath(kind);
      const lightText = fs.readFileSync(path.join(REPO_ROOT, light), 'utf-8');
      const darkText = fs.readFileSync(path.join(REPO_ROOT, dark), 'utf-8');
      for (const [text, colour] of [[lightText, ICON_COLOURS[kind].light], [darkText, ICON_COLOURS[kind].dark]]) {
        expect(text, kind).toContain('viewBox="0 0 16 16"');
        expect(text, kind).toContain('width="16" height="16"');
        expect(text, kind).not.toMatch(/currentColor/i);
        expect(text, kind).not.toMatch(/<(?:image|linearGradient|radialGradient|filter|style|script)\b/);
        expect(new Set(text.match(/#[0-9A-Fa-f]{6}\b/g)), kind).toEqual(new Set([colour]));
      }
      const shape = (text: string) => text.replace(/#[0-9A-Fa-f]{6}\b/g, '#COLOUR');
      expect(shape(lightText), kind).toBe(shape(darkText));
      shapes.add(shape(darkText));
    }
    expect(shapes.size).toBe(3);
  });

  it('the glob VS Code applies agrees with classifySemanticFile, apart from the pinned case differences', () => {
    // [path, the language both give, opens in the canvas]
    const agree: Array<[string, string, boolean]> = [
      ['/p/.erd-studio/gold/tables/gold/a.dbml', 'dbml-table', false],
      ['/p/.erd-studio/gold/relationships/gold.dbml', 'dbml-relationships', false],
      ['/p/.erd-studio/gold/diagrams/x.dbml', 'dbml-diagram', true],
      // A layer may be called diagrams or relationships: the grammar is by depth.
      ['/p/.erd-studio/diagrams/diagrams/x.dbml', 'dbml-diagram', true],
      ['/p/.erd-studio/relationships/relationships/relationships.dbml', 'dbml-relationships', false],
      // diagrams/ is flat: a subfolder is no diagram (nor a canvas).
      ['/p/.erd-studio/gold/diagrams/a/b.dbml', 'dbml', false],
      // An export outside .erd-studio.
      ['/p/exports/sales.dbml', 'dbml', false],
      // The semantic folder in another case is the same folder on a case-insensitive disk.
      ['/p/.ERD-Studio/gold/diagrams/x.dbml', 'dbml-diagram', true],
    ];
    const canvas = vscodeGlob(canvasDbmlPattern());
    for (const [filePath, language, opens] of agree) {
      expect(vscodeLanguageOf(filePath), filePath).toBe(language);
      expect(classifierLanguageOf(filePath), filePath).toBe(language);
      expect(canvas.test(filePath), filePath).toBe(opens);
    }

    // [path, VS Code's language, the classifier's language, opens in the canvas]
    const disagree: Array<[string, string, string, boolean]> = [
      // accepted, §1.1: do not make the classifier case-insensitive. VS Code
      // shows the DBML Diagram icon and opens the canvas, which shows the
      // "not a DBML diagram" page saying how to reopen it as text.
      ['/p/.erd-studio/gold/Diagrams/x.dbml', 'dbml-diagram', 'dbml', true],
      // accepted, §1.1: do not make the classifier case-insensitive.
      ['/p/.erd-studio/gold/Tables/s/x.dbml', 'dbml-table', 'dbml', false],
      // accepted, §1.1: a layer folder is a lower-case id (doctor's hint says
      // to rename Gold/ to gold/); a glob cannot say which folders are layers.
      ['/p/.ERD-Studio/Gold/diagrams/x.dbml', 'dbml-diagram', 'dbml', true],
    ];
    for (const [filePath, vscodeLanguage, classifierLanguage, opens] of disagree) {
      expect(vscodeLanguageOf(filePath), filePath).toBe(vscodeLanguage);
      expect(classifierLanguageOf(filePath), filePath).toBe(classifierLanguage);
      expect(canvas.test(filePath), filePath).toBe(opens);
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
