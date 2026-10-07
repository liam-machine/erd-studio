import { describe, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { analyseRepair, planRelationshipRepair, readRepairSnapshot, describeRepairPlan, verifyRepair, LEAVE_AS_IS } from '../../src/services/relationshipRepair';

const SEMANTIC_DIR = '.erd-studio';
function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-scratch-'));
  const at = (rel: string) => path.join(root, SEMANTIC_DIR, rel);
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(at(rel)), { recursive: true }); fs.writeFileSync(at(rel), text); }
  fs.mkdirSync(at('logical-models'), { recursive: true });
  const layerService = new LayerService(root, SEMANTIC_DIR);
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(root, SEMANTIC_DIR);
  domainService.setLogicalModelService(logicalModelService);
  return { root, at, deps: { workspaceRoot: root, semanticDir: SEMANTIC_DIR, domainService, logicalModelService } };
}
const DIM = 'name: dim_customer\ncolumns:\n  - name: customer_key\n    dataType: string\n    isPrimaryKey: true\n';
const DATE = 'name: dim_date\ncolumns:\n  - name: date_key\n    dataType: string\n    isPrimaryKey: true\n';
const FCT = 'name: fct_order\ncolumns:\n  - name: order_key\n    dataType: string\n    isPrimaryKey: true\n  - name: customer_key\n    dataType: string\n  - name: date_key\n    dataType: string\nrelationships:\n  - fromColumn: date_key\n    toModel: dim_date\n    toColumn: date_key\n    cardinality: many-to-one\n';
const dj = (name: string, models: string[], relationships: unknown[]) => JSON.stringify({ schemaVersion: 5, domain: name, layer: 'gold', description: '', logical: { models, relationships }, viewConfig: { positions: {} } }, null, 2) + '\n';

describe('scratch', () => {
  it('after a canvas remove, repair re-adds the link to the library', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DATE,
      'logical-models/fct_order.yml': FCT,
      'gold/a.json': dj('a', ['dim_customer', 'fct_order'], []), // user just removed it here
      'gold/b.json': dj('b', ['dim_customer', 'fct_order'], [rel]),
      'gold/c.json': dj('c', ['dim_customer', 'fct_order'], [rel]),
    });
    const before = readRepairSnapshot(p.deps);
    console.log('BEFORE', before.mode, before.findings.map((f) => f.code + ' ' + f.message));
    const plan = await planRelationshipRepair(before, {}, async () => LEAVE_AS_IS);
    console.log('PREVIEW\n' + describeRepairPlan(plan!));
    for (const c of plan!.changes) fs.writeFileSync(c.filePath, c.text);
    const after = readRepairSnapshot(p.deps);
    console.log('VERIFY', verifyRepair(before, after, plan!), plan!.counts);
  });
  it('single other copy: repair does nothing', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DATE,
      'logical-models/fct_order.yml': FCT,
      'gold/a.json': dj('a', ['dim_customer', 'fct_order'], []),
      'gold/b.json': dj('b', ['dim_customer', 'fct_order'], [rel]),
    });
    const before = readRepairSnapshot(p.deps);
    const a = analyseRepair(before);
    console.log('SINGLE', before.mode, before.findings.length, a.tasks.length);
  });
});
