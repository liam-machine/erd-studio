/**
 * `projectStorageOf` (native DBML storage, §3.2): core's `detectProjectStorage`
 * fed with what the host finds on disk — the one answer the canvas, the
 * commands, the `erdStudio.storage` context key and `doctor` share.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TableLibraryService } from '../../src/services/logicalModelService';
import { projectStorageOf, readFirstLine, subjectAreaStoragesIn } from '../../src/services/projectStorage';

let root: string;
let semantic: string;

function write(rel: string, text: string): void {
  const file = path.join(semantic, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const storage = (): string => projectStorageOf(new TableLibraryService(root, '.erd-studio'));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-storage-'));
  semantic = path.join(root, '.erd-studio');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const DBML_TABLE = 'Table dim_x {\n  id INT\n}\n';
const JSON_DIAGRAM = JSON.stringify({ schemaVersion: 5, domain: 'sales', layer: 'gold', logical: { models: [] } });
const DBML_DIAGRAM = "Project sales {\n  erd_schema_version: '7'\n}\n";

describe('projectStorageOf', () => {
  it('a project with nothing yet is dbml (also with no .erd-studio at all)', () => {
    expect(storage()).toBe('dbml');
    fs.mkdirSync(semantic, { recursive: true });
    write('layers.json', '{"schemaVersion":1,"layers":[]}');
    expect(storage()).toBe('dbml');
  });

  it('DBML library files make it dbml; a relationships file alone counts', () => {
    write('tables/gold/_relationships.dbml', '// relationships\n');
    expect(storage()).toBe('dbml');
    write('tables/dim_x.dbml', DBML_TABLE);
    write('gold/sales.dbml', DBML_DIAGRAM);
    expect(storage()).toBe('dbml');
  });

  it('YAML evidence alone is yaml: a .yml table, an empty logical-models/, a JSON diagram', () => {
    write('tables/dim_x.yml', 'name: dim_x\n');
    expect(storage()).toBe('yaml');
    fs.rmSync(semantic, { recursive: true });
    fs.mkdirSync(path.join(semantic, 'logical-models'), { recursive: true });
    expect(storage()).toBe('yaml');
    fs.rmSync(semantic, { recursive: true });
    write('gold/sales.json', JSON_DIAGRAM);
    expect(storage()).toBe('yaml');
  });

  it('a .dbml diagram alone never makes a YAML project DBML', () => {
    write('logical-models/dim_x.yml', 'name: dim_x\n');
    write('gold/sales.dbml', DBML_DIAGRAM);
    expect(storage()).toBe('yaml');
  });

  it('both kinds of evidence are mixed', () => {
    write('tables/dim_x.dbml', DBML_TABLE);
    write('gold/finance.json', JSON_DIAGRAM);
    expect(storage()).toBe('mixed');
  });

  it('a tables/ layer means yaml, whatever else is there', () => {
    write('tables/sales.json', JSON_DIAGRAM);
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'tables', label: 'T', abbreviation: 'T', color: '#888888', creatable: true, order: 1 }] }));
    write('tables/dim_x.dbml', DBML_TABLE);
    expect(storage()).toBe('yaml');
  });

  it('an empty logical-models/ beside a DBML library says nothing (a migration leftover)', () => {
    fs.mkdirSync(path.join(semantic, 'logical-models'), { recursive: true });
    write('tables/dim_x.dbml', DBML_TABLE);
    expect(storage()).toBe('dbml');
  });
});

describe('subjectAreaStoragesIn and readFirstLine', () => {
  it('names each diagram\'s storage, skipping a rich export saved in a layer folder and the library', () => {
    write('gold/sales.dbml', DBML_DIAGRAM);
    write('gold/finance.json', JSON_DIAGRAM);
    write('gold/export.dbml', '// erd-studio dbml-export v1\nTable x {\n  id INT\n}\n');
    write('tables/dim_x.dbml', DBML_TABLE);
    write('templates/fact.json', '{}');
    expect(subjectAreaStoragesIn(semantic, false).sort()).toEqual(['dbml', 'json']);
  });

  it('reads the first line only, without a line break, and undefined for a missing file', () => {
    write('gold/a.dbml', 'first line\r\nsecond');
    expect(readFirstLine(path.join(semantic, 'gold/a.dbml'))).toBe('first line');
    expect(readFirstLine(path.join(semantic, 'gold/missing.dbml'))).toBeUndefined();
  });
});
