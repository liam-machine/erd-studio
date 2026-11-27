/**
 * Sample rows (D37) are opt-in (guard G4 of the sample-rows plan): the
 * reader attaches them only for a caller that asks, and the extension asks
 * in one place, its table read (`TableLibraryService`).
 *
 * - Every `TableLibraryService` read carries rows: the canvas's, and the
 *   CLI's (doctor, inventory, diff, changes) and the MCP server's, which
 *   build on it. Those outputs list their fields one by one, so no row
 *   reaches them (`sampleDataPrivacy.test.ts` holds the CLI's to it).
 * - Readers that do not go through it go without rows: Convert and its
 *   self-check (`memoisedDbmlReader`, `dbmlTablesAsYaml`), Import's own
 *   reading of the file it imports, and the bundled example drafts.
 * - A draft (Import DBML, Draw from dbt) that reuses a Table Library table
 *   drops that table's rows (`displayFromTables`): a draft carries rows only
 *   when they are given to it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbmlStorageReader } from '@erd-studio/core/dbml';
import { DEFAULT_LAYERS, tableSampleDataOf } from '@erd-studio/core';

import { memoisedDbmlReader } from '../../src/services/dbmlConversion';
import { displayFromTables } from '../../src/services/draftDisplay';
import { TableLibraryService } from '../../src/services/logicalModelService';

const ROOT = path.resolve(__dirname, '../..');
const TABLE = "Table gold.dim_region {\n  region_code VARCHAR [pk]\n  region_name VARCHAR\n\n  records (region_code, region_name) {\n    'N1', 'North'\n  }\n}\n";

describe('the memoised reader (Convert\'s self-check)', () => {
  it('never serves a reading with rows to a caller that did not ask for them, nor the other way round', () => {
    const base = { ...dbmlStorageReader, parseTable: vi.fn(dbmlStorageReader.parseTable) };
    const reader = memoisedDbmlReader(base);
    const rowsOf = (options?: { schemaFolder?: string; sampleData?: boolean }) => {
      const reading = reader.parseTable(TABLE, 'dim_region', options);
      return reading.ok ? tableSampleDataOf(reading.table) : 'unreadable';
    };
    expect(rowsOf({ schemaFolder: 'gold', sampleData: true })?.totalRows).toBe(1);
    expect(rowsOf({ schemaFolder: 'gold' })).toBeUndefined();
    expect(rowsOf({ schemaFolder: 'gold', sampleData: true })?.totalRows).toBe(1);
    expect(rowsOf({ schemaFolder: 'gold' })).toBeUndefined();
    // Each text is still read once per option.
    expect(base.parseTable).toHaveBeenCalledTimes(2);
  });
});

describe('the one place the extension asks for rows', () => {
  it('is TableLibraryService\'s table read', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.tsx?$/.test(entry.name) && /\bsampleData: true\b|\breadSampleData: true\b/.test(fs.readFileSync(file, 'utf-8'))) {
          hits.push(path.relative(ROOT, file).split(path.sep).join('/'));
        }
      }
    };
    for (const dir of ['src', 'webview', 'webview-draft', 'mcp-server/src']) if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir));
    expect(hits).toEqual(['src/services/logicalModelService.ts']);
  });
});

describe('a draft that reuses a Table Library table', () => {
  const SAMPLE_ROWS = path.join(ROOT, 'packages', 'core', 'test', 'fixtures', 'dbml', 'sample-rows');
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('draws it without the rows the library read attached', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-draft-rows-'));
    fs.cpSync(SAMPLE_ROWS, root, { recursive: true });
    const reused = new TableLibraryService(root, '.erd-studio').getTable('dim_product');
    expect(reused && tableSampleDataOf(reused)?.rows.length).toBeGreaterThan(0);
    const before = JSON.stringify(reused);

    const { display } = displayFromTables({ name: 'imported', layer: 'gold', tables: [reused!], relationships: [], layers: DEFAULT_LAYERS });
    expect(display.models.map((m) => m.name)).toEqual(['dim_product']);
    expect(Object.keys(display.models[0])).not.toContain('sampleData');
    expect(display.models[0].columns.length).toBeGreaterThan(0);
    // The library's table is left as it was.
    expect(JSON.stringify(reused)).toBe(before);
  });
});
