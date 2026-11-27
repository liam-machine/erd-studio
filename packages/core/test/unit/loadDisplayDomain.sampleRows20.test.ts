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
 *   records list still names it, so every parser refuses the file ([4000])
 *   and the table is drawn as a placeholder.
 *
 * The placeholder golden is the one a later change to the reader replaces
 * deliberately (a block that does not read loads the table without its
 * rows); the valid table's display must stay as it is.
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

  it('a stale records list (a dropped column still named): the table is a placeholder ([4000]) with no columns', async () => {
    const { display } = await load();
    const store = display.models.find((m) => m.name === 'dim_store')!;
    expect(store.loadError).toEqual({ kind: 'dbmlStructure', line: 7, code: '4000' });
    expect(store.columns).toEqual([]);
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
