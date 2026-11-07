import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { STARTING_FIELD_LIST, builtInField } from '@erd-studio/core';
import { FIELDS_FILE_MAX_BYTES, FIELDS_FILE_PARSE_BUDGET, FieldsService, readFieldsFile } from '../../src/services/fieldsService';

let root: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-fields-'));
  file = path.join(root, 'fields.yml');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write the file and move its mtime on, so a same-size rewrite still changes the signature. */
function write(text: string, mtimeSeconds?: number): void {
  fs.writeFileSync(file, text);
  if (mtimeSeconds !== undefined) fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
}

describe('readFieldsFile', () => {
  it('gives the starting set and exists: false without a file', () => {
    const reading = readFieldsFile(root);
    expect(reading).toEqual({ exists: false, filePath: file, list: STARTING_FIELD_LIST, problems: [] });
    expect(reading.list).toBe(STARTING_FIELD_LIST);
  });

  it('reads the file with parseFieldsText', () => {
    write('tables:\n  - grain\n  - key: owner\n    type: value\n  - purpse\nleft_out: [dimension]\n');
    const reading = readFieldsFile(root);
    expect(reading.exists).toBe(true);
    expect(reading.list.tables.map((d) => d.key)).toEqual(['grain', 'owner']);
    expect(reading.list.columns).toEqual(STARTING_FIELD_LIST.columns);
    expect(reading.list.leftOut).toEqual(['dimension']);
    expect(reading.problems).toEqual([expect.objectContaining({ code: 'fieldsUnknownName', line: 5 })]);
  });

  it('reads a file with a byte-order mark', () => {
    write('﻿tables: [grain]\n');
    const reading = readFieldsFile(root);
    expect(reading.problems).toEqual([]);
    expect(reading.list.tables).toEqual([builtInField('grain', 'table')]);
  });

  it('reports a broken file and uses the starting set', () => {
    write('tables: [\n');
    const reading = readFieldsFile(root);
    expect(reading.exists).toBe(true);
    expect(reading.problems.map((p) => p.code)).toEqual(['fieldsYamlInvalid']);
    expect(reading.list.tables.map((d) => d.key)).toEqual(STARTING_FIELD_LIST.tables.map((d) => d.key));
  });

  it('bounds alias expansion with a YAML budget, not only the byte cap', () => {
    // 20 KB on disk that would expand to about 2 MB of guidance text.
    const entries = Array.from({ length: 100 }, (_, i) => `  - key: f${i}\n    guidance: *g`).join('\n');
    write(`g: &g "${'x'.repeat(20_000)}"\ntables:\n${entries}\n`);
    expect(fs.statSync(file).size).toBeLessThan(FIELDS_FILE_MAX_BYTES);
    const reading = readFieldsFile(root);
    expect(reading.problems).toEqual([expect.objectContaining({ code: 'fieldsYamlInvalid', severity: 'error' })]);
    expect(reading.list.tables.map((d) => d.key)).toEqual(STARTING_FIELD_LIST.tables.map((d) => d.key));
    expect(FIELDS_FILE_PARSE_BUDGET).toEqual({ maxNodes: 50_000, maxChars: FIELDS_FILE_MAX_BYTES });
  });

  it('reads a file whose aliases stay within the budget', () => {
    write('g: &g "Who owns it"\ntables:\n  - key: a\n    guidance: *g\n  - key: b\n    guidance: *g\n');
    const reading = readFieldsFile(root);
    expect(reading.problems).toEqual([]);
    expect(reading.list.tables.map((d) => d.guidance)).toEqual(['Who owns it', 'Who owns it']);
  });

  it('reports a folder named fields.yml', () => {
    fs.mkdirSync(file);
    const reading = readFieldsFile(root);
    expect(reading.exists).toBe(true);
    expect(reading.problems[0]).toMatchObject({ code: 'fieldsYamlInvalid', severity: 'error' });
    expect(reading.problems[0].message).toMatch(/not a file/);
    expect(reading.list).toBe(STARTING_FIELD_LIST);
  });

  it('refuses a file over the size cap without reading it', () => {
    write(`# ${'x'.repeat(FIELDS_FILE_MAX_BYTES)}\n`);
    const reading = readFieldsFile(root);
    expect(reading.problems[0].message).toMatch(/too large/);
    expect(reading.list).toBe(STARTING_FIELD_LIST);
  });

  it('returns a frozen reading', () => {
    write('tables:\n  - key: owner\n    type: choice\n    values: [a, b]\n');
    const reading = readFieldsFile(root);
    expect(Object.isFrozen(reading)).toBe(true);
    expect(Object.isFrozen(reading.list.tables)).toBe(true);
    expect(Object.isFrozen(reading.list.tables[0])).toBe(true);
    expect(Object.isFrozen(reading.list.tables[0].values)).toBe(true);
    expect(Object.isFrozen(reading.problems)).toBe(true);
  });

  it('reads a missing semantic dir as no file', () => {
    expect(readFieldsFile(path.join(root, 'nope')).exists).toBe(false);
  });
});

describe('FieldsService', () => {
  it('caches a reading while the file is unchanged', () => {
    write('tables: [grain]\n', 1_000);
    const service = new FieldsService(root);
    const first = service.read();
    expect(service.read()).toBe(first);
    expect(service.filePath).toBe(file);
  });

  it('rereads when the mtime or size changes', () => {
    write('tables: [grain]\n', 1_000);
    const service = new FieldsService(root);
    expect(service.getList().tables.map((d) => d.key)).toEqual(['grain']);
    write('tables: [role]\n', 2_000);
    expect(service.getList().tables.map((d) => d.key)).toEqual(['role']);
    write('tables: [grain, role]\n', 2_000);
    expect(service.getList().tables.map((d) => d.key)).toEqual(['grain', 'role']);
  });

  it('notices the file appearing and disappearing', () => {
    const service = new FieldsService(root);
    expect(service.read().exists).toBe(false);
    expect(service.displayFields()).toBeUndefined();
    write('columns: []\n');
    expect(service.read().exists).toBe(true);
    expect(service.displayFields()).toEqual({ tables: [...STARTING_FIELD_LIST.tables], columns: [], leftOut: [] });
    fs.rmSync(file);
    expect(service.read().exists).toBe(false);
    expect(service.getList()).toBe(STARTING_FIELD_LIST);
  });

  it('invalidate() rereads even when the signature looks the same', () => {
    write('tables: [{key: aaa}]\n', 1_000);
    const service = new FieldsService(root);
    const first = service.read();
    write('tables: [{key: bbb}]\n', 1_000); // same size, same mtime
    expect(service.read()).toBe(first);
    service.invalidate();
    expect(service.read().list.tables.map((d) => d.key)).toEqual(['bbb']);
  });

  it('gives no display fields for a file that is not a field list, as core\'s loader omits them', () => {
    write('tables: [\n');
    const service = new FieldsService(root);
    expect(service.read().exists).toBe(true);
    expect(service.getList().tables.map((d) => d.key)).toEqual(STARTING_FIELD_LIST.tables.map((d) => d.key));
    expect(service.displayFields()).toBeUndefined();
    write('tables: [grain]\n', 5_000);
    expect(service.displayFields()?.tables.map((d) => d.key)).toEqual(['grain']);
  });

  it('keeps the display list when the file has only lesser problems', () => {
    write('tables: [grain, purpse]\n');
    const service = new FieldsService(root);
    expect(service.read().problems.map((p) => p.code)).toEqual(['fieldsUnknownName']);
    expect(service.displayFields()?.tables.map((d) => d.key)).toEqual(['grain']);
  });

  it('gives the starting set as the list but no display fields without a file', () => {
    const service = new FieldsService(root);
    expect(service.getList()).toBe(STARTING_FIELD_LIST);
    expect(service.displayFields()).toBeUndefined();
  });

  it('never writes the file', () => {
    const service = new FieldsService(root);
    service.read();
    service.displayFields();
    service.invalidate();
    service.read();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('fieldsService module', () => {
  it('imports no vscode (the CLI bundles it)', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../src/services/fieldsService.ts'), 'utf8');
    expect(text).not.toMatch(/from ['"]vscode['"]/);
    expect(text).not.toMatch(/require\(['"]vscode['"]\)/);
  });
});
