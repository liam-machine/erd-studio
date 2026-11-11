/**
 * The physical stage, the sync plan and the dbt selectors on two tables of
 * one name in different schema folders (the twin fixture,
 * packages/core/test/fixtures/dbml/same-name-two-schemas), with the library
 * telling tables apart by identity.
 *
 * dbt model names are unique in a dbt project, so the two `addresse` tables
 * are two dbt models with aliases (matched by relation: schema + alias), or
 * one model called `addresse` plus something else. A table whose name two
 * schema folders share is matched by its relation first, then by its name
 * only when that dbt model's schema agrees with the table's: one dbt model
 * `addresse` is never both tables. Every other table matches as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument } from 'yaml';

import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { computeSubjectAreaDiff } from '../../src/services/stageDiff';
import { allSelections, buildSyncPlan, syncPlanLibraryLookups } from '../../src/services/syncPlanBuilder';
import { emptyYmlData } from '../../src/services/ymlParserService';
import { columnKey, tableKey } from '../../src/types/syncPlan';
import type { CatalogData } from '../../src/types/catalog';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { ManifestData, ManifestModelInfo } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';

const TWINS = path.resolve(__dirname, '../../packages/core/test/fixtures/dbml/same-name-two-schemas');
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-physical-same-name-'));
  fs.cpSync(TWINS, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function services(): { subjectAreas: SubjectAreaService; library: TableLibraryService } {
  const subjectAreas = new SubjectAreaService(new LayerService(root, '.erd-studio'));
  const library = new TableLibraryService(root, '.erd-studio');
  subjectAreas.setTableLibraryService(library);
  return { subjectAreas, library };
}

const diagram = (name: string): string => path.join(root, '.erd-studio', 'bronze', 'diagrams', `${name}.dbml`);

function model(name: string, schema: string, over: Partial<ManifestModelInfo> = {}): ManifestModelInfo {
  return {
    name,
    uniqueId: `model.p.${name}`,
    projectName: 'p',
    schema,
    description: '',
    columns: [{ name: 'id', data_type: 'int', description: '' }],
    originalFilePath: `models/${name}.sql`,
    ...over,
  };
}

function manifestOf(...models: ManifestModelInfo[]): ManifestData {
  return {
    models: new Map(models.map((m) => [m.name, m])),
    relationshipTests: [],
    uniqueColumns: new Map(),
    compositeUniqueGroups: new Map(),
    disabledModels: new Set(),
  };
}

const ymlOf = (): YmlData => emptyYmlData();

/** The physical stage of `name` as [reference, tableName, exists, schema, alias]. */
function physicalOf(subjectAreas: SubjectAreaService, name: string, manifest: ManifestData): Array<[string, string | undefined, boolean, string, string | undefined]> {
  const unified = subjectAreas.getSubjectArea(diagram(name));
  const display = subjectAreas.buildPhysicalSubjectArea(unified, ymlOf(), manifest);
  return display.models.map((m) => [m.name, m.tableName, m.existsInProject !== false, m.schema, m.alias]);
}

describe('physical stage: a table whose name two schema folders share', () => {
  it('two dbt models built as bqs.addresse and ccc.addresse (aliases) match each table by its relation, on every diagram', () => {
    const { subjectAreas } = services();
    const manifest = manifestOf(
      model('stg_bqs_addresse', 'bqs', { alias: 'addresse' }),
      model('stg_ccc_addresse', 'ccc', { alias: 'addresse' }),
      model('stg_ccc_kunde', 'ccc', { alias: 'kunde' }),
    );
    expect(physicalOf(subjectAreas, 'kunden', manifest)).toEqual([
      ['bqs.addresse', 'addresse', true, 'bqs', 'addresse'],
      ['bqs.kunde', 'kunde', false, '', undefined],
      ['ccc.addresse', 'addresse', true, 'ccc', 'addresse'],
      ['ccc.kunde', 'kunde', true, 'ccc', 'kunde'],
    ]);
    // The diagram of ccc's tables alone names them bare, and still finds ccc's models.
    expect(physicalOf(subjectAreas, 'ccc', manifest)).toEqual([
      ['addresse', undefined, true, 'ccc', 'addresse'],
      ['kunde', undefined, true, 'ccc', 'kunde'],
    ]);
  });

  it('one dbt model named addresse in schema bqs is bqs\'s table only: ccc\'s is missing in dbt, never matched by name', () => {
    const { subjectAreas } = services();
    const manifest = manifestOf(model('addresse', 'bqs'));
    expect(physicalOf(subjectAreas, 'ccc', manifest).find(([ref]) => ref === 'addresse')).toEqual(['addresse', undefined, false, '', undefined]);
    expect(physicalOf(subjectAreas, 'kunden', manifest).filter(([ref]) => ref.endsWith('addresse'))).toEqual([
      ['bqs.addresse', 'addresse', true, 'bqs', undefined],
      ['ccc.addresse', 'addresse', false, '', undefined],
    ]);
  });

  it('a relationships test of bqs\'s dbt model never lands on ccc\'s table of that name', () => {
    const { subjectAreas } = services();
    const manifest = manifestOf(
      model('addresse', 'bqs'),
      model('stg_ccc_addresse', 'ccc', { alias: 'addresse' }),
      model('kunde', 'ccc', { columns: [{ name: 'addresse_id', data_type: 'int', description: '' }] }),
    );
    manifest.relationshipTests = [
      { fromModel: 'kunde', fromColumn: 'addresse_id', toModel: 'addresse', toColumn: 'id' },
      { fromModel: 'kunde', fromColumn: 'addresse_id', toModel: 'stg_ccc_addresse', toColumn: 'id' },
    ] as ManifestData['relationshipTests'];
    const unified = subjectAreas.getSubjectArea(diagram('ccc'));
    const display = subjectAreas.buildPhysicalSubjectArea(unified, ymlOf(), manifest);
    expect(display.relationships.map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}`)).toEqual(['kunde.addresse_id>addresse.id']);
    expect(display.models.map((m) => [m.name, m.existsInProject !== false])).toEqual([['addresse', true], ['kunde', true]]);
  });

  it('with no manifest, a shared table found through the schema yml never takes the catalog\'s node of its short name (owner decision H)', () => {
    const { subjectAreas } = services();
    const yml = emptyYmlData();
    yml.models.set('addresse', { name: 'addresse', description: '', columns: [{ name: 'id', description: '' }], filePath: path.join(root, 'models', 'schema.yml'), tags: [], configSchema: 'bqs' } as never);
    // The catalog's only node of that short name is built in ccc: it is not bqs's table, whatever its name.
    const ccc = { uniqueId: 'model.p.addresse', resourceType: 'model' as const, name: 'addresse', relationName: 'addresse', schema: 'ccc', database: null, comment: null,
      columns: [{ name: 'id', dataType: 'int', comment: null, index: 1 }, { name: 'ccc_only', dataType: 'text', comment: null, index: 2 }] };
    const catalog = { byUniqueId: new Map([[ccc.uniqueId, ccc]]), byName: new Map([['addresse', ccc]]), generatedAt: null } as unknown as CatalogData;
    const display = subjectAreas.buildPhysicalSubjectArea(subjectAreas.getSubjectArea(diagram('kunden')), yml, undefined, catalog);
    const bqs = display.models.find((m) => m.name === 'bqs.addresse');
    expect(bqs?.existsInProject).not.toBe(false);
    expect(bqs?.columns.map((c) => c.name)).not.toContain('ccc_only');
  });

  it('a table whose name is unique matches as before: by its name first, then its relation', () => {
    fs.rmSync(path.join(root, '.erd-studio', 'bronze', 'tables', 'bqs', 'addresse.dbml'));
    const { subjectAreas } = services();
    // addresse is unique now: the dbt model named addresse is its model whatever its schema.
    expect(physicalOf(subjectAreas, 'ccc', manifestOf(model('addresse', 'bqs'))).find(([ref]) => ref === 'addresse'))
      .toEqual(['addresse', undefined, true, 'bqs', undefined]);
  });

  it('dbtModelNamesOf names the dbt model each shared table was found as, and lists no table found by its own name', () => {
    const { subjectAreas } = services();
    const manifest = manifestOf(model('addresse', 'bqs'), model('stg_ccc_addresse', 'ccc', { alias: 'addresse' }));
    const unified = subjectAreas.getSubjectArea(diagram('kunden'));
    expect([...subjectAreas.dbtModelNamesOf(unified, ymlOf(), manifest)]).toEqual([
      ['bqs.addresse', 'addresse'],
      ['bqs.kunde', null],
      ['ccc.addresse', 'stg_ccc_addresse'],
      ['ccc.kunde', null],
    ]);
    expect([...subjectAreas.tableIdsOf(unified)].map(([ref, id]) => [ref, id.schema, id.name])).toEqual([
      ['bqs.addresse', 'bqs', 'addresse'],
      ['bqs.kunde', 'bqs', 'kunde'],
      ['ccc.addresse', 'ccc', 'addresse'],
      ['ccc.kunde', 'ccc', 'kunde'],
    ]);
  });
});

describe('sync plan: a table whose name two schema folders share', () => {
  it('modelContext names the table\'s own file and the dbt files of the model it was found as', () => {
    const { subjectAreas, library } = services();
    const manifest = manifestOf(
      model('addresse', 'bqs', { columns: [] }),
      model('stg_ccc_addresse', 'ccc', { alias: 'addresse', columns: [], originalFilePath: 'models/ccc/stg_ccc_addresse.sql' }),
    );
    const ymlData = ymlOf();
    const file = diagram('kunden');
    const { unified, report } = computeSubjectAreaDiff({ subjectAreaService: subjectAreas, ymlData, manifest }, file, 'logical');
    const ids = subjectAreas.tableIdsOf(unified);
    const dbtModels = subjectAreas.dbtModelNamesOf(unified, ymlData, manifest);
    const plan = buildSyncPlan(report, allSelections(report, 'physical'), {
      manifest, ymlData, projectRoot: root, semanticDir: '.erd-studio', domain: unified.domain, layer: unified.layer,
      ...syncPlanLibraryLookups(library, {
        diagramFile: file, layerIds: new Set(['bronze']), manifest, ymlData,
        tableIdOf: (name) => ids.get(name.toLowerCase()),
      }),
      dbtModelOf: (name) => dbtModels.get(name.toLowerCase()),
      now: new Date(0),
    });
    const context = (ref: string) => {
      const c = plan.modelContext[ref];
      return c ? [c.logicalModelPath, c.dbtSchemaPath] : undefined;
    };
    expect(context('bqs.addresse')).toEqual(['.erd-studio/bronze/tables/bqs/addresse.dbml', 'models/addresse.yml']);
    expect(context('ccc.addresse')).toEqual(['.erd-studio/bronze/tables/ccc/addresse.dbml', 'models/ccc/stg_ccc_addresse.yml']);
    // A table found as no dbt model has no dbt files, never those of the model named like it.
    expect(context('ccc.kunde')).toEqual(['.erd-studio/bronze/tables/ccc/kunde.dbml', null]);
    expect(plan.modelContext['ccc.kunde'].dbtSqlPath).toBeNull();
  });

  it('a selection key is matched by building each item\'s key, so a name holding \':\' is never cut, and a key two items share is left out', () => {
    const report: DiscrepancyReport = {
      sourceStage: 'logical',
      targetStage: 'physical',
      models: [
        { name: 'sch:x.addresse', status: 'missing', columns: [{ name: 'id', status: 'missing' }] },
        { name: 'a', status: 'matched', columns: [{ name: 'b:c', status: 'missing' }] },
        { name: 'a:b', status: 'matched', columns: [{ name: 'c', status: 'missing' }] },
      ],
      relationships: [],
    } as unknown as DiscrepancyReport;
    const plan = buildSyncPlan(report, allSelections(report, 'physical'), {
      manifest: manifestOf(), ymlData: ymlOf(), projectRoot: root, semanticDir: '.erd-studio', domain: 'd', layer: 'bronze', now: new Date(0),
    });
    expect(allSelections(report, 'physical')).toHaveProperty([tableKey('sch:x.addresse')]);
    expect(plan.models.map((m) => m.modelName)).toEqual(['sch:x.addresse']);
    expect(plan.columns.map((c) => [c.modelName, c.columnName])).toEqual([['sch:x.addresse', 'id']]);
    // `col:a:b:c` is a's b:c and a:b's c alike: neither is planned.
    expect(columnKey('a', 'b:c')).toBe(columnKey('a:b', 'c'));
  });
});

describe('selectors: a table whose name two schema folders share', () => {
  function writeDbtProject(): void {
    fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: p\nprofile: p\n');
  }

  function selectorValues(dbt?: { manifest?: ManifestData }): Record<string, string[]> {
    const { subjectAreas } = services();
    const selectors = new SelectorsService(subjectAreas, root, '.erd-studio', {
      dbtModelsOf: (unified) => subjectAreas.dbtModelNamesOf(unified, ymlOf(), dbt?.manifest),
    });
    selectors.regenerate();
    const doc = parseDocument(fs.readFileSync(path.join(root, 'selectors.yml'), 'utf-8')).toJS() as {
      selectors: Array<{ name: string; definition: { union: Array<{ value: string }> } }>;
    };
    return Object.fromEntries(doc.selectors.map((s) => [s.name, s.definition.union.map((u) => u.value)]));
  }

  it('writes the dbt model each table was found as, never a schema-qualified reference, and leaves out one found as none', () => {
    writeDbtProject();
    const manifest = manifestOf(model('addresse', 'bqs'), model('stg_ccc_addresse', 'ccc', { alias: 'addresse' }), model('stg_ccc_kunde', 'ccc', { alias: 'kunde' }));
    const values = selectorValues({ manifest });
    expect(values.domain_bronze_kunden).toEqual(['addresse', 'stg_ccc_addresse', 'stg_ccc_kunde']);
    expect(values.domain_bronze_ccc).toEqual(['stg_ccc_addresse', 'stg_ccc_kunde']);
    expect(Object.values(values).flat().some((v) => v.includes('.'))).toBe(false);
  });

  it('without dbt data, a shared table is left out rather than guessed (here every table is shared: nothing to write)', () => {
    writeDbtProject();
    const { subjectAreas } = services();
    const result = new SelectorsService(subjectAreas, root, '.erd-studio', {
      dbtModelsOf: (unified) => subjectAreas.dbtModelNamesOf(unified, ymlOf()),
    }).regenerate();
    expect(result.status).toBe('noop');
    expect(fs.existsSync(path.join(root, 'selectors.yml'))).toBe(false);
  });

  it('a host that cannot say which dbt model a table is leaves out each one its diagram names <schema>.<name>', () => {
    writeDbtProject();
    new SelectorsService(services().subjectAreas, root, '.erd-studio').regenerate();
    const doc = parseDocument(fs.readFileSync(path.join(root, 'selectors.yml'), 'utf-8')).toJS() as {
      selectors: Array<{ name: string; definition: { union: Array<{ value: string }> } }>;
    };
    expect(doc.selectors.find((s) => s.name === 'domain_bronze_kunden')).toBeUndefined();
  });

  it('in a library where no other schema folder has their names, the ccc diagram\'s tables are written by name as before', () => {
    writeDbtProject();
    fs.rmSync(path.join(root, '.erd-studio', 'bronze', 'tables', 'bqs'), { recursive: true });
    const subjectAreas = services().subjectAreas;
    new SelectorsService(subjectAreas, root, '.erd-studio').regenerate();
    const doc = parseDocument(fs.readFileSync(path.join(root, 'selectors.yml'), 'utf-8')).toJS() as {
      selectors: Array<{ name: string; definition: { union: Array<{ value: string }> } }>;
    };
    expect(doc.selectors.find((s) => s.name === 'domain_bronze_ccc')?.definition.union.map((u) => u.value)).toEqual(['addresse', 'kunde']);
  });
});
