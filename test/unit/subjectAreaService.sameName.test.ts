/**
 * The extension host on two tables of one name in different schema folders
 * (packages/core/test/fixtures/dbml/same-name-two-schemas), before its library is keyed by a
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

import { tableLoadErrorOf, tableNameOf } from '@erd-studio/core';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';

const TWINS = path.resolve(__dirname, '../../packages/core/test/fixtures/dbml/same-name-two-schemas');
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

/** The host with its library telling tables apart by identity (`schemaScopedNames`). */
function scopedService(): SubjectAreaService {
  const subjectAreas = new SubjectAreaService(new LayerService(root, '.erd-studio'));
  subjectAreas.setTableLibraryService(new TableLibraryService(root, '.erd-studio', undefined, { schemaScopedNames: true }));
  return subjectAreas;
}

const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, '.erd-studio', rel)), { recursive: true });
  fs.writeFileSync(path.join(root, '.erd-studio', rel), text);
};

/** Each relationship of a Unified shape as `owner.column>target.column`, sorted. */
function edgesOf(unified: ReturnType<SubjectAreaService['getSubjectArea']>): string[] {
  return unified.logical.models.flatMap((m) => (m.relationships ?? []).map((r) => `${m.name}.${r.fromColumn}>${r.toModel}.${r.toColumn}`)).sort();
}

describe('SubjectAreaService, its library telling tables apart by identity', () => {
  it('draws each member\'s relationships under the diagram\'s names: the ccc diagram\'s kunde points at its addresse, never at bqs\'s', () => {
    const unified = scopedService().getSubjectArea(diagram('ccc'));
    expect(edgesOf(unified)).toEqual(['addresse.id>bqs.addresse.id', 'kunde.addresse_id>addresse.id']);
  });

  it('on the diagram of both, every end is one of its members', () => {
    const unified = scopedService().getSubjectArea(diagram('kunden'));
    expect(edgesOf(unified)).toEqual(['bqs.kunde.addresse_id>bqs.addresse.id', 'ccc.addresse.id>bqs.addresse.id', 'ccc.kunde.addresse_id>ccc.addresse.id']);
  });

  it('a member\'s error is the error of the file it was read from, never the library\'s first file of its name', () => {
    write('bronze/tables/ccc/addresse.dbml', 'Table ccc.addresse {\n  id INT [pk\n}\n');
    const ccc = scopedService().getSubjectArea(diagram('ccc'));
    const addresse = ccc.logical.models.find((m) => m.name === 'addresse')!;
    expect(tableLoadErrorOf(addresse)?.kind).toMatch(/^dbml/);
    const kunden = scopedService().getSubjectArea(diagram('kunden'));
    expect(tableLoadErrorOf(kunden.logical.models.find((m) => m.name === 'ccc.addresse')!)?.kind).toMatch(/^dbml/);
    expect(tableLoadErrorOf(kunden.logical.models.find((m) => m.name === 'bqs.addresse')!)).toBeUndefined();
  });

  it('a missing member named <schema>.<name> keeps its own name beside it, as core\'s loader names it', () => {
    fs.rmSync(path.join(root, '.erd-studio', 'bronze', 'tables', 'bqs', 'addresse.dbml'));
    const unified = scopedService().getSubjectArea(diagram('kunden'));
    expect(tableNameOf(unified.logical.models.find((m) => m.name === 'bqs.addresse')!)).toBe('addresse');
  });

  describe('a member whose use line names a file that is gone (owner decision B)', () => {
    /** A diagram of bqs.addresse and ccc.kunde, after bqs/addresse.dbml went. */
    function staleDiagram(): string {
      fs.rmSync(path.join(root, '.erd-studio', 'bronze', 'tables', 'bqs', 'addresse.dbml'));
      write('bronze/diagrams/stale.dbml', [
        "Project stale {\n  erd_schema_version: '7'\n}",
        "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
        "use { table ccc.kunde } from '../tables/ccc/kunde.dbml'",
        '',
      ].join('\n'));
      return path.join(root, '.erd-studio', 'bronze', 'diagrams', 'stale.dbml');
    }

    it('is read from the one other table of its name, when that is not another member\'s file', () => {
      const unified = scopedService().getSubjectArea(staleDiagram());
      expect((unified.logical.models.find((m) => m.name === 'addresse')?.columns ?? []).map((c) => c.name)).toEqual(['id', 'street', 'city', 'postcode']);
    });

    it('is drawn missing when two other schema folders have a table of its name', () => {
      write('bronze/tables/ddd/addresse.dbml', 'Table ddd.addresse {\n  id INT [pk]\n}\n');
      const file = staleDiagram();
      for (const scoped of [true, false]) {
        const unified = (scoped ? scopedService() : service()).getSubjectArea(file);
        expect(unified.logical.models.find((m) => m.name === 'addresse')?.columns ?? []).toEqual([]);
      }
    });

    it('is read from its own schema folder in another layer first', () => {
      write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'bronze', label: 'Bronze' }, { id: 'silver', label: 'Silver' }] }));
      write('silver/tables/bqs/addresse.dbml', 'Table bqs.addresse {\n  id INT [pk]\n  moved VARCHAR\n}\n');
      const unified = scopedService().getSubjectArea(staleDiagram());
      expect((unified.logical.models.find((m) => m.name === 'addresse')?.columns ?? []).map((c) => c.name)).toEqual(['id', 'moved']);
    });
  });

  it('a JSON diagram names tables by name alone: an end is drawn under its bare name only where that name reads that table', () => {
    write('bronze/legacy.json', JSON.stringify({
      schemaVersion: 5, domain: 'legacy', layer: 'bronze',
      logical: { models: ['addresse', 'kunde'], relationships: [] },
      viewConfig: { positions: { addresse: { x: 10, y: 20 }, kunde: { x: 300, y: 20 } } },
    }));
    const unified = scopedService().getSubjectArea(path.join(root, '.erd-studio', 'bronze', 'legacy.json'));
    // The library's first addresse and kunde are bqs's: their Ref is drawn; ccc's Refs name ccc's tables and are not.
    expect(edgesOf(unified)).toEqual(['kunde.addresse_id>addresse.id']);
    expect(unified.viewConfig.positions?.addresse).toEqual({ x: 10, y: 20 });
  });
});
