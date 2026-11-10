/**
 * The sync plan in a DBML project (2.0 design §2.4, "every other consumer
 * uses the same module"): `modelContext[…].relationshipsPath` is where a NEW
 * Ref of that foreign-key table goes (`relationshipsFileForNewRef`, decision
 * 5), and each relationship carries `storedIn`, the relationships file that
 * holds it now (`relationshipsFileHolding`, the attach step's `locations`),
 * where a removal or a cardinality change is made in place. Both are
 * project-relative; a YAML table has neither. The YAML cases stay in
 * `syncPlanBuilder.test.ts`, unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { allSelections, buildSyncPlan } from '../../src/services/syncPlanBuilder';
import { TableLibraryService } from '../../src/services/logicalModelService';
import type { SyncPlanContext } from '../../src/services/syncPlanBuilder';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { ManifestData } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';

const HEADER = '// ERD Studio relationships: Refs only.\n';

let root: string;
let semantic: string;

function write(rel: string, text: string): void {
  const file = path.join(semantic, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sync-dbml-'));
  semantic = path.join(root, '.erd-studio');
  write('gold/tables/gold/fct_order.dbml', 'Table gold.fct_order {\n  id INT [pk]\n  customer_id INT\n  date_id INT\n  store_id INT\n}\n');
  write('gold/tables/gold/dim_customer.dbml', 'Table gold.dim_customer {\n  customer_id INT [pk]\n}\n');
  write('gold/tables/gold/dim_store.dbml', 'Table gold.dim_store {\n  store_id INT [pk]\n}\n');
  write('silver/tables/calendar/dim_date.dbml', 'Table calendar.dim_date {\n  date_id INT [pk]\n}\n');
  write('silver/tables/silver/stg_visit.dbml', 'Table silver.stg_visit {\n  id INT [pk]\n  store_id INT\n}\n');
  write('logical-models/dim_yaml.yml', 'name: dim_yaml\ncolumns:\n  - name: id\n    dataType: INT\n');
  // fct_order's Refs: the store one in gold's default file, the date one split out by hand.
  write('gold/relationships/gold.dbml', `${HEADER}use { table gold.dim_store } from '../tables/gold/dim_store.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nRef: gold.fct_order.store_id - gold.dim_store.store_id\n`);
  write('gold/relationships/dates.dbml', `${HEADER}use { table calendar.dim_date } from '../../silver/tables/calendar/dim_date.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nRef: gold.fct_order.date_id >? calendar.dim_date.date_id\n`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const emptyManifest: ManifestData = {
  models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set(),
};
const emptyYml = { models: new Map() } as unknown as YmlData;

function report(): DiscrepancyReport {
  return {
    domain: 'orders',
    layer: 'gold',
    sourceStage: 'logical',
    targetStage: 'physical',
    models: [],
    relationships: [
      // dbt has it, the logical model does not: a new Ref.
      { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', status: 'missing', targetCardinality: 'many-to-one' },
      // The logical model has it, dbt does not: removed where it is.
      { fromModel: 'fct_order', fromColumn: 'date_id', toModel: 'dim_date', toColumn: 'date_id', status: 'extra', sourceCardinality: 'many-to-one' },
      // The cardinalities differ: changed where it is.
      { fromModel: 'fct_order', fromColumn: 'store_id', toModel: 'dim_store', toColumn: 'store_id', status: 'cardinality-mismatch', sourceCardinality: 'one-to-one', targetCardinality: 'many-to-one' },
      // A new Ref of a table with none yet, in another layer.
      { fromModel: 'stg_visit', fromColumn: 'store_id', toModel: 'dim_store', toColumn: 'store_id', status: 'missing', targetCardinality: 'many-to-one' },
      // A YAML table: neither path.
      { fromModel: 'dim_yaml', fromColumn: 'id', toModel: 'dim_store', toColumn: 'store_id', status: 'missing', targetCardinality: 'many-to-one' },
    ],
    summary: {
      totalModels: 0, matchedModels: 0, extraModels: 0, missingModels: 0, totalColumns: 0, matchedColumns: 0,
      extraColumns: 0, missingColumns: 0, dataTypeMismatches: 0, undeclaredColumns: 0,
    },
  };
}

/** The context the canvas and `erd-studio diff` build, over this library. */
function contextOf(lib: TableLibraryService): SyncPlanContext {
  return {
    manifest: emptyManifest, ymlData: emptyYml, projectRoot: root, semanticDir: '.erd-studio',
    domain: 'orders', layer: 'gold', now: new Date('2026-01-02T03:04:05.000Z'),
    tableLibraryFile: (name) => lib.tableLibraryFile(name),
    relationshipsFile: (name) => {
      const file = lib.relationshipsFileForNewRef(name);
      return file === undefined ? undefined : lib.libraryRelativePath(file);
    },
    relationshipStoredIn: (rel) => {
      const file = lib.relationshipsFileHolding(rel);
      return file === undefined ? undefined : lib.libraryRelativePath(file);
    },
  };
}

describe('the sync plan in a DBML project', () => {
  it('relationshipsPath is where a new Ref of the FK table goes; storedIn is the file holding the Ref now', () => {
    const lib = new TableLibraryService(root, '.erd-studio');
    const plan = buildSyncPlan(report(), allSelections(report(), 'physical'), contextOf(lib));
    const byFrom = (from: string, to: string) => plan.relationships.find((r) => r.fromModel === from && r.toModel === to)!;

    expect(byFrom('fct_order', 'dim_customer')).toMatchObject({ action: 'add-relationship-to-logical' });
    expect(byFrom('fct_order', 'dim_customer')).not.toHaveProperty('storedIn');
    expect(byFrom('fct_order', 'dim_date')).toMatchObject({ action: 'remove-relationship-from-logical', storedIn: '.erd-studio/gold/relationships/dates.dbml' });
    expect(byFrom('fct_order', 'dim_store')).toMatchObject({ action: 'update-cardinality-in-logical', storedIn: '.erd-studio/gold/relationships/gold.dbml' });
    expect(byFrom('dim_yaml', 'dim_store')).not.toHaveProperty('storedIn');

    // fct_order holds one Ref in each file: a tie goes to path byte order (dates < gold).
    expect(plan.modelContext.fct_order).toMatchObject({
      logicalModelPath: '.erd-studio/gold/tables/gold/fct_order.dbml',
      relationshipsPath: '.erd-studio/gold/relationships/dates.dbml',
    });
    // No Ref yet: its own layer's default file, which does not exist yet.
    expect(plan.modelContext.stg_visit.relationshipsPath).toBe('.erd-studio/silver/relationships/silver.dbml');
    expect(fs.existsSync(path.join(semantic, 'silver/relationships/silver.dbml'))).toBe(false);
    expect(plan.modelContext.dim_yaml).not.toHaveProperty('relationshipsPath');
    expect(plan.modelContext.dim_yaml.logicalModelPath).toBe('.erd-studio/logical-models/dim_yaml.yml');
  });

  it('the most Refs win: a hand-split file holding more of the table\'s Refs is where its next one goes', () => {
    write('gold/relationships/dates.dbml', `${HEADER}use { table calendar.dim_date } from '../../silver/tables/calendar/dim_date.dbml'\nuse { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\n`
      + 'Ref: gold.fct_order.date_id >? calendar.dim_date.date_id\nRef: gold.fct_order.id >? gold.dim_customer.customer_id\n');
    const lib = new TableLibraryService(root, '.erd-studio');
    const plan = buildSyncPlan(report(), allSelections(report(), 'physical'), contextOf(lib));
    expect(plan.modelContext.fct_order.relationshipsPath).toBe('.erd-studio/gold/relationships/dates.dbml');
  });

  it('without the new context functions a plan has neither field (an older host)', () => {
    const plan = buildSyncPlan(report(), allSelections(report(), 'physical'), {
      manifest: emptyManifest, ymlData: emptyYml, projectRoot: root, semanticDir: '.erd-studio', domain: 'orders', layer: 'gold',
    });
    expect(plan.relationships.every((r) => !('storedIn' in r))).toBe(true);
    expect(Object.values(plan.modelContext).every((c) => !('relationshipsPath' in c))).toBe(true);
  });
});
