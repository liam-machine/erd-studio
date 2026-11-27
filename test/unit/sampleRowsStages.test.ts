/**
 * Sample rows (D37) and the two stages (guard G6 of the sample-rows plan).
 *
 * A table's rows are shown on the logical stage only, and they are not part
 * of the design that Compare and Sync reason about:
 *
 * - rows on the logical side alone produce no discrepancy and no sync action:
 *   the report `computeSubjectAreaDiff` builds and the plan `buildSyncPlan`
 *   builds are the same with and without them, from either stage;
 * - the physical stage (`buildPhysicalSubjectArea`) never carries them, for a
 *   table dbt has and for one it lacks.
 *
 * Positive control: the logical side of the same diff does carry them, so the
 * equalities above are not empty.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { computeSubjectAreaDiff } from '../../src/services/stageDiff';
import { allSelections, buildSyncPlan, type SyncPlanContext } from '../../src/services/syncPlanBuilder';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { CatalogService } from '../../src/services/catalogService';
import type { ManifestData } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';
import type { CatalogData } from '../../src/types/catalog';
import type { Stage } from '../../src/types/semantic';
import { copyDbtFixture, dbtFixtureRoot, diagramPath } from './helpers/dbtFixtures';

const SENTINEL = 'zqSENTX7';
const LEAK = /SENTX7/;
const DBT_ROOT = dbtFixtureRoot('dbt-project');

/** dim_customer (dbt has it), with invented sample rows. */
const DIM_CUSTOMER = 'silver/tables/silver/dim_customer.dbml';
const WITH_ROWS = `  records (customer_key, customer_id, customer_name, email) {
    1, 'C-001', '${SENTINEL} one', 'one@example.com'
    2, 'C-002', , null
  }
`;

let manifest: ManifestData;
let ymlData: YmlData;
let catalog: CatalogData | undefined;
let root: string;

beforeAll(async () => {
  manifest = await new ManifestService({ parseInProcess: true }).loadManifest(DBT_ROOT);
  ymlData = await new YmlParserService().loadYmlData(DBT_ROOT, undefined);
  catalog = (await new CatalogService().loadCatalog(DBT_ROOT)) ?? undefined;
});

beforeEach(() => {
  root = copyDbtFixture('dbt-project-dbml', 'sample-rows-stages');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function services() {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const library = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(library);
  return { subjectAreaService, library };
}

/** Give a table file sample rows: the block goes last in its Table. */
function addRows(rel: string, block: string): void {
  const file = path.join(root, '.erd-studio', ...rel.split('/'));
  const text = fs.readFileSync(file, 'utf-8');
  const end = text.lastIndexOf('}');
  fs.writeFileSync(file, `${text.slice(0, end)}\n${block}${text.slice(end)}`);
}

function contextOf(library: TableLibraryService): SyncPlanContext {
  return {
    manifest, ymlData, projectRoot: root, semanticDir: '.erd-studio',
    domain: 'showcase', layer: 'silver', now: new Date('2026-01-02T03:04:05.000Z'),
    tableLibraryFile: (name) => library.tableLibraryFile(name),
    relationshipsFile: (name) => {
      const file = library.relationshipsFileForNewRef(name);
      return file === undefined ? undefined : library.libraryRelativePath(file);
    },
    relationshipStoredIn: (rel) => {
      const file = library.relationshipsFileHolding(rel);
      return file === undefined ? undefined : library.libraryRelativePath(file);
    },
  };
}

/** The diff and the plan that syncs everything towards the other stage, from `source`. */
function diffAndPlan(source: Stage) {
  const { subjectAreaService, library } = services();
  const result = computeSubjectAreaDiff({ subjectAreaService, ymlData, manifest, catalog }, diagramPath(root, 'dbml', 'silver', 'showcase'), source);
  const truth = result.report.sourceStage === 'logical' ? 'physical' : 'logical';
  const plan = buildSyncPlan(result.report, allSelections(result.report, truth), contextOf(library));
  return { ...result, plan };
}

describe('rows on the logical side alone (G6)', () => {
  it.each<Stage>(['logical', 'physical'])('produce no discrepancy and no sync action, from the %s stage', (source) => {
    const before = diffAndPlan(source);
    addRows(DIM_CUSTOMER, WITH_ROWS);
    const after = diffAndPlan(source);

    // Positive control: the logical side of the diff carries the rows now.
    const logical = after.source.stage === 'logical' ? after.source : after.target;
    expect(logical.models.find((m) => m.name === 'dim_customer')?.sampleData?.totalRows).toBe(2);

    expect(after.report).toEqual(before.report);
    // `generatedAt` aside, the plan is the same, and it holds no value.
    expect({ ...after.plan, generatedAt: '' }).toEqual({ ...before.plan, generatedAt: '' });
    expect(JSON.stringify(after.report)).not.toMatch(LEAK);
    expect(JSON.stringify(after.plan)).not.toMatch(LEAK);
  });
});

describe('the physical stage never carries the rows', () => {
  it('for a table dbt has, and for one it does not', () => {
    addRows(DIM_CUSTOMER, WITH_ROWS);
    const { subjectAreaService } = services();
    const unified = subjectAreaService.getSubjectArea(diagramPath(root, 'dbml', 'silver', 'showcase'));
    const customer = unified.logical.models.find((m) => m.name === 'dim_customer')!;
    expect((customer as { sampleData?: unknown }).sampleData).toBeDefined();
    // A phantom too: the logical model of a table dbt lacks, with rows.
    const phantom = { ...customer, name: 'dim_nowhere' };
    const physical = subjectAreaService.buildPhysicalSubjectArea(
      { ...unified, logical: { ...unified.logical, models: [...unified.logical.models, phantom] } },
      ymlData, manifest, catalog,
    );
    expect(physical.models.find((m) => m.name === 'dim_customer')?.existsInProject).toBe(true);
    expect(physical.models.find((m) => m.name === 'dim_nowhere')?.existsInProject).toBe(false);
    expect(physical.models.filter((m) => 'sampleData' in m)).toEqual([]);
    expect(JSON.stringify(physical)).not.toMatch(LEAK);
  });
});
