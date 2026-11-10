/**
 * DBML's own column settings for what Import DBML keeps in `meta.dbml`
 * (`nativeColumnSettings.ts`): `not_null`, `unique`, `increment` and
 * `default` are written as `not null`, `unique`, `increment` and
 * `default: …` in a `.dbml` table file, and read back into `meta.dbml`.
 *
 * - `fixtures/dbml/import-settings-old` is a table as the 2.0 pre-releases
 *   wrote an imported one (every value in `meta_json`). Its golden
 *   (`tables.golden.json`) was taken with the reader as it was before the
 *   native settings, so it pins that such a file reads as it always did.
 * - `fixtures/dbml/import-settings-new` is the same table as a new import
 *   writes it, which must read as the same table.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { parseTableDbml } from '../../src/dbml/readTable';
import { editTableDbml, renderNewTableDbml } from '../../src/dbml/writeTable';
import { formatDbml } from '../../src/dbml/format';
import { dbmlStorageReader } from '../../src/dbml/index';
import { loadDisplaySubjectArea } from '../../src/loadDisplayDomain';
import { DIAGRAM_EXPORT_FORMATS, exportDiagram } from '../../src/exportDiagram';
import type { DbmlTableReading } from '../../src/types/dbmlStorage';
import type { ColumnDef, SemanticTable } from '../../src/types/semantic';
import { STORAGE_PARSERS } from '../dbmlParsers';

type Ok = Extract<DbmlTableReading, { ok: true }>;

const FIXTURES = path.resolve(__dirname, '../fixtures/dbml');
const OLD = path.join(FIXTURES, 'import-settings-old');
const NEW = path.join(FIXTURES, 'import-settings-new');
const GOLDEN = path.join(OLD, 'tables.golden.json');
const fileOf = (project: string): string => path.join(project, '.erd-studio', 'gold/tables/gold/customers.dbml');
const textOf = (project: string): string => fs.readFileSync(fileOf(project), 'utf8');

function read(text: string, parser?: (typeof STORAGE_PARSERS)[number][1]): Ok {
  const reading = parseTableDbml(text, 'customers', { schemaFolder: 'gold' }, parser);
  if (!reading.ok) throw new Error(reading.error.message);
  return reading;
}

const tableOf = (text: string): SemanticTable => read(text).table;
const edit = (text: string, change: (columns: ColumnDef[]) => void): string => {
  const desired = structuredClone(tableOf(text));
  change(desired.columns!);
  return editTableDbml(text, desired, { schemaFolder: 'gold' });
};
const column = (columns: ColumnDef[], name: string): ColumnDef => columns.find((c) => c.name === name)!;
const lineOf = (text: string, name: string): string => text.split('\n').find((l) => l.trimStart().startsWith(`${name} `))!.trim();

describe('a table an earlier 2.0 build imported (meta_json) reads as it always did', () => {
  it('matches the golden taken before the native settings', () => {
    const text = `${JSON.stringify(read(textOf(OLD)).table, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === '1' && !fs.existsSync(GOLDEN)) fs.writeFileSync(GOLDEN, text);
    expect(text).toBe(fs.readFileSync(GOLDEN, 'utf8'));
  });

  it.each(STORAGE_PARSERS)('the new spelling reads as the same table (%s)', (_label, parser) => {
    const old = read(textOf(OLD), parser);
    const now = read(textOf(NEW), parser);
    expect(now.problems).toEqual([]);
    expect(now.table).toEqual(old.table);
  });

  it('a no-op edit and an unrelated edit leave every meta_json as it is', () => {
    const old = textOf(OLD);
    expect(editTableDbml(old, tableOf(old), { schemaFolder: 'gold' })).toBe(old);
    const described = edit(old, (cs) => { column(cs, 'tier').description = 'Tier'; });
    expect(described).toContain(`'{"dbml":{"not_null":true}}'`);
    expect(described).toContain(`'{"dbml":{"not_null":true,"unique":true}}'`);
    expect(tableOf(described).columns!.map((c) => c.meta)).toEqual(tableOf(old).columns!.map((c) => c.meta));
  });

  it('a changed value moves out of meta_json into the setting; one left alone stays where it is', () => {
    const old = textOf(OLD);
    const out = edit(old, (cs) => { (column(cs, 'email').meta!.dbml as Record<string, unknown>).default = 'n/a'; });
    expect(lineOf(out, 'email')).toBe(`email      varchar   [default: 'n/a', meta_json: '{"dbml":{"not_null":true,"unique":true}}']`);
    expect(column(tableOf(out).columns!, 'email').meta).toEqual({ dbml: { not_null: true, unique: true, default: 'n/a' } });
    // Clearing a key meta_json holds takes it out of the JSON.
    const cleared = edit(old, (cs) => { delete (column(cs, 'email').meta!.dbml as Record<string, unknown>).not_null; });
    expect(lineOf(cleared, 'email')).toBe(`email      varchar   [meta_json: '{"dbml":{"unique":true}}']`);
    const gone = edit(old, (cs) => { delete column(cs, 'tier').meta!.dbml; });
    expect(lineOf(gone, 'tier')).toBe("tier       int       [owner: 'crm', note: 'Loyalty tier']");
  });
});

describe('every consumer of core sees the same model in both spellings', () => {
  const load = (project: string) => loadDisplaySubjectArea({
    domainPath: '.erd-studio/gold/diagrams/crm.dbml',
    readFile: async (p) => { try { return fs.readFileSync(path.join(project, p), 'utf8'); } catch { return null; } },
    readOnly: false,
    warn: () => {},
    dbml: dbmlStorageReader,
  });

  it('the canvas and the viewer draw the same columns, and every export is the same', async () => {
    const [old, now] = await Promise.all([load(OLD), load(NEW)]);
    expect(now.models).toEqual(old.models);
    for (const format of DIAGRAM_EXPORT_FORMATS) {
      // The diagram's own Note differs; nothing else may.
      const strip = (text: string) => text.replace(/pre-releases wrote it|release writes it/g, '');
      expect(strip(exportDiagram(now, format))).toBe(strip(exportDiagram(old, format)));
    }
  });
});

describe('a new table file writes DBML\'s own settings', () => {
  it('renders the imported table as DBML spells it, and reads it back the same', () => {
    const table = { ...tableOf(textOf(OLD)), schema: 'gold' };
    const rendered = formatDbml(renderNewTableDbml(table)).text;
    expect(rendered).toBe(textOf(NEW));
    expect(read(rendered).table).toEqual(table);
  });

  it('keeps in meta_json what no setting can hold: a default that is not quoted text, a multi-line one, a flag that is not true', () => {
    const settings = (dbml: Record<string, unknown>): string => renderNewTableDbml({
      name: 't', schema: 'gold', columns: [{ name: 'c', dataType: 'int', description: '', meta: { dbml } } as ColumnDef],
    }).split('\n')[1].trim();
    expect(settings({ default: '0' })).toBe(`c int [meta_json: '{"dbml":{"default":"0"}}']`);
    expect(settings({ default: 'TRUE', not_null: true })).toBe(`c int [not null, meta_json: '{"dbml":{"default":"TRUE"}}']`);
    expect(settings({ default: 'a\nb' })).toBe(`c int [meta_json: '{"dbml":{"default":"a\\\\nb"}}']`);
    expect(settings({ default: "it's" })).toBe("c int [default: 'it\\'s']");
    expect(settings({ not_null: false, unique: 'yes' })).toBe(`c int [meta_json: '{"dbml":{"not_null":false,"unique":"yes"}}']`);
    expect(settings({ increment: true, default: '`nextval()`' })).toBe('c int [increment, default: `nextval()`]');
  });
});

describe('editing the settings in a file that has them', () => {
  const now = (): string => textOf(NEW);
  const dbml = (cs: ColumnDef[], name: string): Record<string, unknown> => {
    const c = column(cs, name);
    c.meta ??= {};
    c.meta.dbml ??= {};
    return c.meta.dbml as Record<string, unknown>;
  };

  it.each([
    ['sets not null', (cs: ColumnDef[]) => { dbml(cs, 'score').not_null = true; }, 'score', `score      int       [not null, meta_json: '{"dbml":{"default":"0","checks":["score >= 0"]}}']`],
    ['clears not null', (cs: ColumnDef[]) => { delete dbml(cs, 'email').not_null; }, 'email', 'email      varchar   [unique]'],
    ['clears the last setting with meta.dbml', (cs: ColumnDef[]) => { delete column(cs, 'tier').meta!.dbml; }, 'tier', "tier       int       [owner: 'crm', note: 'Loyalty tier']"],
    ['changes a default in place', (cs: ColumnDef[]) => { dbml(cs, 'status').default = 'active'; }, 'status', "status     varchar   [not null, default: 'active']"],
    ['turns a default into an expression', (cs: ColumnDef[]) => { dbml(cs, 'status').default = '`gen()`'; }, 'status', 'status     varchar   [not null, default: `gen()`]'],
    ['moves a default no setting can hold into meta_json', (cs: ColumnDef[]) => { dbml(cs, 'status').default = '1'; }, 'status', `status     varchar   [not null, meta_json: '{"dbml":{"default":"1"}}']`],
    ['adds unique beside not null', (cs: ColumnDef[]) => { dbml(cs, 'tier').unique = true; }, 'tier', "tier       int       [not null, unique, owner: 'crm', note: 'Loyalty tier']"],
  ])('%s', (_name, change, name, line) => {
    const before = now();
    const out = edit(before, change);
    expect(lineOf(out, name)).toBe(line);
    // Only that column's line changes, and the file reads back as the edit asked.
    expect(out.split('\n').filter((l, i) => l !== before.split('\n')[i])).toHaveLength(1);
    const want = structuredClone(tableOf(before));
    change(want.columns!);
    for (const c of want.columns!) {
      const d = c.meta?.dbml as Record<string, unknown> | undefined;
      if (d && Object.keys(d).length === 0) delete c.meta!.dbml;
      if (c.meta && Object.keys(c.meta).length === 0) delete c.meta;
    }
    expect(tableOf(out)).toEqual(want);
  });

  it('a new column and not null replacing an explicit null', () => {
    const text = 'Table gold.t {\n  id int [pk]\n  name varchar [null]\n}\n';
    const desired = structuredClone(tableOf2(text));
    (desired.columns![1].meta = { dbml: { not_null: true } });
    desired.columns!.push({ name: 'added', dataType: 'int', description: '', meta: { dbml: { not_null: true, default: '`now()`' } } } as ColumnDef);
    const out = editTableDbml(text, desired);
    expect(out).toBe('Table gold.t {\n  id int [pk]\n  name varchar [not null]\n  added int [not null, default: `now()`]\n}\n');
    expect(tableOf2(out)).toEqual(desired);
  });

  it('leaves the settings alone while meta.dbml is text (the reader cannot merge them)', () => {
    const text = "Table gold.t {\n  id int [pk, not null, meta_dbml: 'kept']\n}\n";
    const table = tableOf2(text);
    expect(table.columns![0].meta).toEqual({ dbml: 'kept' });
    expect(editTableDbml(text, { ...table, description: 'T' })).toContain('id int [pk, not null, meta_dbml: \'kept\']');
  });
});

function tableOf2(text: string): SemanticTable {
  const reading = parseTableDbml(text, 't');
  if (!reading.ok) throw new Error(reading.error.message);
  return reading.table;
}
