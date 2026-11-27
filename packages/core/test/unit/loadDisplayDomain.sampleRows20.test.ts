/**
 * The old shape of a table file with sample rows (DBML `records`), pinned
 * before any reader or writer learns about the block
 * (packages/core/test/fixtures/dbml/sample-rows-2.0):
 *
 * - `dim_product` holds a valid `records (…) { … }` block nested in its
 *   Table. It loads as a table like any other, and nothing of its rows
 *   reaches the display.
 * - `dim_store` holds a block exactly as extension 2.0.10 (core 0.5.1)
 *   leaves it after a column drop: the column line is gone, but the
 *   records list still names it, so every parser refuses the file ([4000]).
 *   2.0.10 drew the table as a placeholder; since the reader learnt that a
 *   block that does not read leaves the table readable (D37), it loads with
 *   its columns and without its rows, read-only, with a `recordsUnreadable`
 *   warning. That change replaced this golden deliberately; the valid
 *   table's display stayed as it was.
 *
 * Goldens (packages/core/test/fixtures/golden/sample-rows-2.0.*):
 * regenerate with UPDATE_GOLDEN=1 for an intended change.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { loadDisplaySubjectArea } from '../../src/loadDisplayDomain';
import { dbmlStorageReader } from '../../src/dbml/index';
import type { DisplaySubjectArea } from '../../src/types/display';

type Files = Record<string, string>;

const UPDATE = process.env.UPDATE_GOLDEN === '1';
const FIXTURE = path.resolve(__dirname, '../fixtures/dbml/sample-rows-2.0');
const GOLDEN_DIR = path.resolve(__dirname, '../fixtures/golden');
const DIAGRAM = '.erd-studio/gold/diagrams/catalog.dbml';

/** Every cell of both blocks: none may reach the display, a warning or the golden. */
const ROW_VALUES = ['Blue widget', 'Red gadget', 'Green gizmo', '4.50', '12.00', 'North yard', 'South yard', 'N1', 'S2', '2020-01-15', '2021-06-01'];

function fixture(): Files {
  const out: Files = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(FIXTURE, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(FIXTURE);
  return out;
}

async function load(): Promise<{ display: DisplaySubjectArea; warnings: string[] }> {
  const files = fixture();
  const warnings: string[] = [];
  const display = await loadDisplaySubjectArea({
    domainPath: DIAGRAM,
    readFile: async (p) => files[p] ?? null,
    readOnly: false,
    warn: (m) => warnings.push(m),
    dbml: dbmlStorageReader,
  });
  return { display, warnings };
}

describe('a table file with sample rows, as 2.0.10 reads it', () => {
  it('a valid nested records block: the table loads with its columns, and its rows reach nothing', async () => {
    const { display } = await load();
    const product = display.models.find((m) => m.name === 'dim_product')!;
    expect(product.loadError).toBeUndefined();
    expect(product.columns.map((c) => c.name)).toEqual(['product_key', 'product_name', 'list_price', 'is_active', 'updated_at']);
    expect(Object.keys(product)).not.toContain('sampleData');
  });

  it('a stale records list (a dropped column still named): the table loads with its columns, without its rows, and says so by line', async () => {
    const { display, warnings } = await load();
    const store = display.models.find((m) => m.name === 'dim_store')!;
    expect(store.loadError).toBeUndefined();
    expect(store.columns.map((c) => c.name)).toEqual(['store_key', 'store_name', 'opened_on']);
    expect(Object.keys(store)).not.toContain('sampleData');
    expect(warnings).toContain('Model "dim_store": Line 7: the sample data (records) does not read as DBML, so it is not shown. Other DBML tools reject this file, and ERD Studio will not edit this table until the rows are fixed or removed.');
    const reading = dbmlStorageReader.parseTable(fixture()['.erd-studio/gold/tables/gold/dim_store.dbml'], 'dim_store', { schemaFolder: 'gold' });
    expect(reading.ok && reading.writable).toBe(false);
    expect(reading.ok ? reading.problems.map((p) => [p.code, p.line]) : []).toEqual([['recordsUnreadable', 7]]);
  });

  it('with the rows asked for: the valid table carries them, the stale one still none', async () => {
    const files = fixture();
    const display = await loadDisplaySubjectArea({
      domainPath: DIAGRAM,
      readFile: async (p) => files[p] ?? null,
      readOnly: false,
      warn: () => {},
      dbml: dbmlStorageReader,
      readSampleData: true,
    });
    const product = display.models.find((m) => m.name === 'dim_product')!;
    expect(product.sampleData).toEqual({
      columns: ['product_name', 'list_price', 'is_active'],
      rows: [
        [{ text: 'Blue widget', kind: 'string' }, { text: '4.50', kind: 'number' }, { text: 'true', kind: 'boolean' }],
        [{ text: 'Red gadget', kind: 'string' }, { text: '12.00', kind: 'number' }, { text: 'false', kind: 'boolean' }],
        [{ text: 'Green gizmo', kind: 'string' }, null, { text: 'true', kind: 'boolean' }],
      ],
      totalRows: 3,
    });
    expect(Object.keys(display.models.find((m) => m.name === 'dim_store')!)).not.toContain('sampleData');
  });

  it('no row value appears in the display or in a warning', async () => {
    const { display, warnings } = await load();
    const text = JSON.stringify(display) + '\n' + warnings.join('\n');
    for (const value of ROW_VALUES) expect(text).not.toContain(value);
  });
});

describe('golden: what core draws for the sample-rows-2.0 fixture', () => {
  it('the catalog diagram', async () => {
    const { display } = await load();
    const file = path.join(GOLDEN_DIR, 'sample-rows-2.0.catalog.display.json');
    const text = JSON.stringify(display, null, 2) + '\n';
    if (UPDATE) fs.writeFileSync(file, text);
    expect(text).toBe(fs.readFileSync(file, 'utf-8'));
  });
});
