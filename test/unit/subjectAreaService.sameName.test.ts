/**
 * The extension host on two tables of one name in different schema folders
 * (test/fixtures/same-name-two-schemas), before its library is keyed by a
 * table's identity: SubjectAreaService reads each DBML diagram member from
 * its own `use` path, so a diagram that shows both draws each with its own
 * columns under core's names for them (`bqs.addresse`, `ccc.addresse`, with
 * `tableName` beside), never one table twice. Which relationships the host
 * attaches to the second table is the library's business (it still holds
 * the old rule: the later file is a duplicate), pinned in a later stage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { tableNameOf } from '@erd-studio/core';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';

const TWINS = path.resolve(__dirname, '../fixtures/same-name-two-schemas');
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-same-name-'));
  fs.cpSync(TWINS, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function service(): SubjectAreaService {
  const subjectAreas = new SubjectAreaService(new LayerService(root, '.erd-studio'));
  subjectAreas.setTableLibraryService(new TableLibraryService(root, '.erd-studio'));
  return subjectAreas;
}

const diagram = (name: string): string => path.join(root, '.erd-studio', 'bronze', 'diagrams', `${name}.dbml`);

describe('SubjectAreaService: members that share a name', () => {
  it('reads each from its own use path, named as core names it', () => {
    const subjectAreas = service();
    const unified = subjectAreas.getSubjectArea(diagram('kunden'));
    expect(unified.logical.models.map((m) => [m.name, tableNameOf(m), m.schema, (m.columns ?? []).map((c) => c.name)])).toEqual([
      ['bqs.addresse', 'addresse', 'bqs', ['id', 'strasse', 'ort']],
      ['bqs.kunde', 'kunde', 'bqs', ['id', 'name', 'addresse_id']],
      ['ccc.addresse', 'addresse', 'ccc', ['id', 'street', 'city', 'postcode']],
      ['ccc.kunde', 'kunde', 'ccc', ['id', 'full_name', 'addresse_id']],
    ]);
    expect(Object.keys(unified.viewConfig.positions ?? {}).sort()).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    expect([...(subjectAreas.dbmlMemberLayers(diagram('kunden')) ?? new Map())].sort()).toEqual([
      ['bqs.addresse', 'bronze'], ['bqs.kunde', 'bronze'], ['ccc.addresse', 'bronze'], ['ccc.kunde', 'bronze'],
    ]);
  });

  it('a member whose file is gone is drawn missing, never read from the file its namesake\'s use line points at (as core draws it)', () => {
    fs.rmSync(path.join(root, '.erd-studio', 'bronze', 'tables', 'bqs', 'addresse.dbml'));
    const unified = service().getSubjectArea(diagram('kunden'));
    const columnsOf = (name: string): string[] | undefined => {
      const model = unified.logical.models.find((m) => m.name === name);
      return model ? (model.columns ?? []).map((c) => c.name) : undefined;
    };
    expect(columnsOf('bqs.addresse') ?? []).toEqual([]);
    expect(columnsOf('ccc.addresse')).toEqual(['id', 'street', 'city', 'postcode']);
  });

  it('a diagram of the ccc tables alone reads ccc\'s files under their names, as before', () => {
    const unified = service().getSubjectArea(diagram('ccc'));
    expect(unified.logical.models.map((m) => [m.name, tableNameOf(m), (m.columns ?? []).map((c) => c.name)])).toEqual([
      ['addresse', undefined, ['id', 'street', 'city', 'postcode']],
      ['kunde', undefined, ['id', 'full_name', 'addresse_id']],
    ]);
  });
});
