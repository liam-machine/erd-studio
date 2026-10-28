/**
 * writeNewSubjectArea's rollback with DBML library tables (§5.7 of
 * docs/plans/native-dbml-storage.md, S5 review): saving an existing `.dbml`
 * table also writes its folder's relationships file, so a later failure puts
 * back every file the save wrote (or removes one it created), not only the
 * table file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeNewSubjectArea } from '../../src/services/newSubjectAreaWriter';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import type { SemanticTable } from '../../src/types/semantic';

let root: string;
const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};

/** Every file under the semantic dir, relative path → text. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(path.join(root, '.erd-studio'), abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf-8');
    }
  };
  walk(path.join(root, '.erd-studio'));
  return out;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-new-sa-dbml-'));
  write('layers.json', `${JSON.stringify({ layers: [{ id: 'gold', label: 'Gold' }] }, null, 2)}\n`);
  write('tables/dim_date.dbml', 'Table dim_date {\n  date_key INT [pk]\n}\n');
  write('tables/fct_x.dbml', 'Table fct_x {\n  id INT [pk]\n  date_key INT\n}\n');
  write('tables/dim_yaml.yml', 'name: dim_yaml\ncolumns:\n  - name: id\n    dataType: INT\n');
  write('tables/fct_z.dbml', 'Table fct_z {\n  id INT [pk]\n  yaml_id INT\n}\n');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** fct_x gains a relationship (its folder's relationships file is written); then fct_z's save is refused (D20). */
async function writeThenFail(): Promise<Awaited<ReturnType<typeof writeNewSubjectArea>>> {
  const tables = new TableLibraryService(root, '.erd-studio');
  const fctX: SemanticTable = { ...tables.getTable('fct_x')!, relationships: [{ fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' }] };
  const fctZ: SemanticTable = { ...tables.getTable('fct_z')!, relationships: [{ fromColumn: 'yaml_id', toModel: 'dim_yaml', toColumn: 'id', cardinality: 'many-to-one' }] };
  return writeNewSubjectArea({
    workspaceRoot: root,
    semanticDir: '.erd-studio',
    domainPath: at('gold/new.json'),
    newTables: [],
    changedTables: [fctX, fctZ],
    documentText: () => `${JSON.stringify({ schemaVersion: 5, domain: 'new', layer: 'gold', logical: { models: ['fct_x', 'fct_z'], relationships: [] }, viewConfig: {} }, null, 2)}\n`,
  }, { layerService: new LayerService(root, '.erd-studio'), tableLibraryService: tables });
}

describe('writeNewSubjectArea rolls back every file a DBML table save wrote', () => {
  it('a relationships file the save created is removed again', async () => {
    const before = snapshot();
    const result = await writeThenFail();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.undone).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it('a relationships file the save changed is put back byte for byte', async () => {
    write('tables/_relationships.dbml', '﻿// Hand-written header\n');
    const before = snapshot();
    const result = await writeThenFail();
    expect(result.ok).toBe(false);
    expect(snapshot()).toEqual(before);
  });
});
