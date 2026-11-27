/**
 * Sample rows (D37) are opt-in (guard G4 of the sample-rows plan): the
 * reader attaches them only for a caller that asks, and the extension asks
 * in one place, its table read for the canvas (`TableLibraryService`). Every
 * other reader in the extension (Convert and its self-check, doctor, the
 * CLI's snapshot, Import) goes without them.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { dbmlStorageReader } from '@erd-studio/core/dbml';
import { tableSampleDataOf } from '@erd-studio/core';

import { memoisedDbmlReader } from '../../src/services/dbmlConversion';

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
