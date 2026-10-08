/**
 * Repair Relationships… — the vscode-free engine (issue #133, R10).
 *
 * Each case builds a small project on disk, reads it with the same lookup the
 * canvas uses, plans (the engine asks nothing: it makes only the automatic
 * fixes and lists everything else), writes the planned texts and holds the
 * result to `verifyRepair`: nothing outside the relationships changes, every
 * planned finding is gone, nothing new appears, and every diagram draws what
 * it drew (except a link turned round on purpose). Then a second run must
 * have nothing left to do.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { usesLibraryRelationships } from '../../src/services/libraryRelationships';
import {
  RepairEditError,
  analyseRepair,
  checkPlannedTexts,
  clearForeignKeyFlags,
  describeRepairOffer,
  describeRepairPlan,
  editDomainRelationships,
  editYamlRelationships,
  linksTheMoveStores,
  planRelationshipRepair,
  readRepairSnapshot,
  repairReportItems,
  reportItemLine,
  scanDomainFiles,
  verifyRepair,
  type RepairOptions,
  type RepairPlan,
  type RepairReportItem,
  type RepairSnapshot,
  type RepairSnapshotDeps,
} from '../../src/services/relationshipRepair';

const SEMANTIC_DIR = '.erd-studio';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Project {
  root: string;
  deps: RepairSnapshotDeps;
  /** Absolute path of a file under the ERD data directory. */
  at: (rel: string) => string;
  read: (rel: string) => string;
  write: (rel: string, text: string) => void;
}

/** A project from `files` (paths relative to `.erd-studio/`). */
function project(files: Record<string, string>): Project {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-repair-'));
  roots.push(root);
  const at = (rel: string): string => path.join(root, SEMANTIC_DIR, rel);
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
    fs.writeFileSync(at(rel), text);
  };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  fs.mkdirSync(at('logical-models'), { recursive: true });
  const layerService = new LayerService(root, SEMANTIC_DIR);
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(root, SEMANTIC_DIR);
  domainService.setLogicalModelService(logicalModelService);
  return {
    root,
    deps: { workspaceRoot: root, semanticDir: SEMANTIC_DIR, domainService, logicalModelService },
    at,
    read: (rel) => fs.readFileSync(at(rel), 'utf-8'),
    write,
  };
}

interface Run {
  before: RepairSnapshot;
  plan: RepairPlan;
  problems: string[];
  after: RepairSnapshot;
}

/** Plan (no questions: automatic fixes only), write the result, verify it. */
async function repair(p: Project, options: RepairOptions = {}): Promise<Run> {
  const before = readRepairSnapshot(p.deps);
  const plan = planRelationshipRepair(before, options);
  expect(checkPlannedTexts(plan)).toEqual([]);
  for (const change of plan.changes) fs.writeFileSync(change.filePath, change.text);
  const after = readRepairSnapshot(p.deps);
  return { before, plan, problems: verifyRepair(before, after, plan), after };
}

const messages = (items: readonly RepairReportItem[]): string[] => items.map((i) => i.message);

const codes = (s: RepairSnapshot): string[] => s.findings.map((f) => f.code).sort();
const domainJson = (name: string, models: string[], relationships: unknown[] = []): string =>
  JSON.stringify({
    schemaVersion: 5, domain: name, layer: 'gold', description: 'keep me',
    logical: { models, relationships },
    viewConfig: { positions: {} },
  }, null, 2) + '\n';

const DIM = [
  '# the customer dimension — keep this comment',
  'name: dim_customer',
  'columns:',
  '  - name: customer_key',
  '    dataType: string',
  '    isPrimaryKey: true',
  '',
].join('\n');
const DIM_DATE = [
  'name: dim_date',
  'columns:',
  '  - name: date_key',
  '    dataType: date',
  '    isPrimaryKey: true',
  '',
].join('\n');
const FCT_HEAD = [
  'name: fct_order   # the fact',
  'columns:',
  '  - name: order_key',
  '    dataType: string',
  '    isPrimaryKey: true',
  '  - name: customer_key',
  '    dataType: string',
  '  - name: date_key',
  '    dataType: date',
].join('\n');
const FCT_DATE_REL = [
  'relationships:',
  '  - fromColumn: date_key   # when it was ordered',
  '    toModel: dim_date',
  '    toColumn: date_key',
  '    cardinality: many-to-one',
  '    note: an unknown key the repair must keep',
].join('\n');
const FCT = `${FCT_HEAD}\n${FCT_DATE_REL}\n`;

describe('automatic fixes', () => {
  it('REL002: moves a one-to-many out of the dimension into the fact, keeping every other entry and byte', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n    role: buyer\n`,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const run = await repair(p);
    expect(codes(run.before)).toContain('REL002');
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.rehomed).toBe(1);
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(p.read('logical-models/fct_order.yml')).toBe(`${FCT}${[
      '  - fromColumn: customer_key',
      '    toModel: dim_customer',
      '    toColumn: customer_key',
      '    cardinality: many-to-one',
      '    role: buyer',
    ].join('\n')}\n`);
    expect(codes(run.after)).not.toContain('REL002');
  });

  it('REL005: respells an endpoint in place, keeping the comment on its line', async () => {
    const fct = `${FCT}  - fromColumn: Customer_Key\n    toModel: DIM_Customer   # odd case\n    toColumn: customer_key\n    cardinality: many-to-one\n`;
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': fct,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const run = await repair(p);
    expect(codes(run.before)).toContain('REL005');
    expect(run.problems).toEqual([]);
    expect(p.read('logical-models/fct_order.yml')).toBe(
      `${FCT}  - fromColumn: customer_key\n    toModel: dim_customer   # odd case\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
    );
    expect(codes(run.after)).not.toContain('REL005');
  });

  it('REL001: keeps the copy in its canonical home and removes identical ones (in the same file and on the one side)', async () => {
    const entry = '  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n';
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/fct_order.yml': `${FCT}${entry}  # a comment between entries stays\n${entry}`,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const run = await repair(p);
    expect(codes(run.before)).toEqual(expect.arrayContaining(['REL001', 'REL002']));
    expect(run.problems).toEqual([]);
    expect(p.read('logical-models/fct_order.yml')).toBe(`${FCT}${entry}  # a comment between entries stays\n`);
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(codes(run.after)).toEqual([]);
  });

  it('REL009: removes a library project\'s domain-file copy that says what the library says, and nothing else in that file', async () => {
    const copy = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    const kept = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const original = domainJson('orders', ['fct_order', 'dim_date', 'dim_customer'], [copy, kept]);
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/orders.json': original,
    });
    const run = await repair(p);
    expect(run.before.mode).toBe('library');
    expect(codes(run.before)).toContain('REL009');
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.domainCopiesRemoved).toBe(1);
    expect(JSON.parse(p.read('gold/orders.json')).logical.relationships).toEqual([kept]);
    expect(p.read('logical-models/fct_order.yml')).toBe(FCT);
  });

  it('REL009: a diagram copy that says something else is left exactly as it is and listed; the identical copy elsewhere goes', async () => {
    const date = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    const differing = domainJson('sales', ['fct_order', 'dim_date'], [{ ...date, cardinality: 'one-to-one', role: 'ship' }]);
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/orders.json': domainJson('orders', ['fct_order', 'dim_date'], [date]),
      'gold/sales.json': differing,
    });
    const run = await repair(p);
    // Both copies are notes, never duplicates: the library's copy is drawn by both diagrams.
    expect(run.before.findings.filter((f) => f.code === 'REL009').map((f) => [f.files[0], f.fix])).toEqual([
      ['gold/orders.json', 'remove-domain-copy'],
      ['gold/sales.json', 'ignored-domain-copy'],
    ]);
    expect(codes(run.before)).not.toContain('REL001');
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.domainCopiesRemoved).toBe(1);
    expect(JSON.parse(p.read('gold/orders.json')).logical.relationships).toEqual([]);
    expect(p.read('gold/sales.json')).toBe(differing);
    expect(p.read('logical-models/fct_order.yml')).toBe(FCT);
    expect(run.plan.left).toHaveLength(1);
    expect(run.plan.left[0]).toMatchObject({ file: 'gold/sales.json' });
    expect(run.plan.left[0].message).toBe(
      'fct_order.date_key → dim_date.date_key: gold/sales.json keeps its own copy, which says ' +
      'fct_order.date_key → dim_date.date_key (one-to-one, "ship") where the model library says ' +
      'fct_order.date_key → dim_date.date_key (many-to-one). Diagrams draw the model library\'s copy and ignore this one, ' +
      'so it is left as it is — delete it from gold/sales.json if it is wrong.',
    );
    // Offered for the identical copy only — said as what it is.
    expect(describeRepairOffer(run.plan)).toBe(
      '1 relationship can be tidied up automatically (1 kept as an unused copy in a diagram file). ' +
      'Review the fixes with Repair Relationships…? Nothing changes until you confirm.',
    );
    // Nothing left to do on a second run; the differing copy is still listed, still untouched — and never offered.
    const again = await repair(p);
    expect(again.plan.changes).toEqual([]);
    expect(messages(again.plan.left)).toEqual(messages(run.plan.left));
    expect(describeRepairOffer(again.plan)).toBeNull();
  });

  it('a diagram copy that says something else never holds back the library\'s own fix (REL002 moved to its many side)', async () => {
    const differing = domainJson('orders', ['fct_order', 'dim_customer'], [
      { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' },
    ]);
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/orders.json': differing,
    });
    const run = await repair(p);
    expect(codes(run.before)).toEqual(expect.arrayContaining(['REL002', 'REL009']));
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.rehomed).toBe(1);
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(p.read('gold/orders.json')).toBe(differing);
    expect(codes(run.after)).toEqual(['REL009']);
    expect(run.after.findings[0].fix).toBe('ignored-domain-copy');
  });

  it('library copies that disagree still leave the whole link — every copy, the diagram\'s included', async () => {
    const date = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    const orders = domainJson('orders', ['fct_order', 'dim_date'], [date]);
    const dimDate = `${DIM_DATE}relationships:\n  - fromColumn: date_key\n    toModel: fct_order\n    toColumn: date_key\n    cardinality: one-to-many\n    role: shipped\n`;
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': dimDate,
      'gold/orders.json': orders,
    });
    const run = await repair(p);
    expect(run.before.findings.find((f) => f.code === 'REL001')).toMatchObject({ severity: 'error', files: ['logical-models/fct_order.yml', 'logical-models/dim_date.yml'] });
    expect(run.plan.changes).toEqual([]);
    expect(p.read('gold/orders.json')).toBe(orders);
    expect(p.read('logical-models/dim_date.yml')).toBe(dimDate);
    expect(messages(run.plan.left).join('\n')).toMatch(/its copies disagree/);
  });

  it('is idempotent: a second run has nothing to do', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: FCT_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const first = await repair(p);
    expect(first.problems).toEqual([]);
    expect(first.plan.changes.length).toBeGreaterThan(0);
    const second = await repair(p);
    expect(second.plan.changes).toEqual([]);
    expect(analyseRepair(readRepairSnapshot(p.deps)).tasks).toEqual([]);
  });

  it('describes every file and change for the preview', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const before = readRepairSnapshot(p.deps);
    const plan = planRelationshipRepair(before);
    const detail = describeRepairPlan(plan);
    expect(detail).toContain('• logical-models/dim_customer.yml');
    expect(detail).toContain('• logical-models/fct_order.yml');
    expect(detail).toContain('adds fct_order.customer_key → dim_customer.customer_key (many-to-one)');
  });
});

describe('left for the user: listed with its file, never changed', () => {
  const conflicted = (): Project => project({
    'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n    role: buyer\n`,
    'logical-models/fct_order.yml': `${FCT}  - fromColumn: customer_key   # by hand\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
    'logical-models/dim_date.yml': DIM_DATE,
  });

  it('REL001 copies that disagree: no copy is chosen or removed; the relationship is listed with the file to open', async () => {
    const p = conflicted();
    const files = ['logical-models/dim_customer.yml', 'logical-models/fct_order.yml'].map((f) => [f, p.read(f)] as const);
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(run.plan.changes).toEqual([]);
    expect(run.plan.fixed).toBe(0);
    expect(run.plan.left).toHaveLength(1);
    const [item] = run.plan.left;
    expect(item.message).toBe(
      'fct_order.customer_key → dim_customer.customer_key: its copies disagree ('
      + 'fct_order.customer_key → dim_customer.customer_key (many-to-one) in logical-models/fct_order.yml; '
      + 'fct_order.customer_key → dim_customer.customer_key (many-to-one, "buyer") in logical-models/dim_customer.yml'
      + ') — keep the right one and delete the others. Left as it is.',
    );
    // Open File goes to the copy that differs from the one the canvas draws, at its entry.
    expect(item.filePath).toBe(p.at('logical-models/dim_customer.yml'));
    expect(reportItemLine(item)).toBe(8);
    for (const [f, text] of files) expect(p.read(f)).toBe(text);
    expect(describeRepairPlan(run.plan)).toContain('Needs your attention — not changed by this repair:\n• fct_order.customer_key');
    // Nothing to fix on its own, so the canvas does not offer the repair.
    expect(describeRepairOffer(run.plan)).toBeNull();
  });

  it('REL003: a missing model is listed, never removed or repointed', async () => {
    const fct = `${FCT}  - fromColumn: customer_key\n    toModel: dim_client\n    toColumn: customer_key\n    cardinality: many-to-one\n`;
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': fct,
    });
    const run = await repair(p);
    expect(codes(run.before)).toEqual(['REL003']);
    expect(run.plan.changes).toEqual([]);
    expect(messages(run.plan.left)).toEqual([
      'fct_order.customer_key → dim_client.customer_key: model dim_client is not in the model library — point it at the right model and column, or delete it. Left as it is.',
    ]);
    expect(run.plan.left[0].file).toBe('logical-models/fct_order.yml');
    expect(p.read('logical-models/fct_order.yml')).toBe(fct);
  });

  it('REL004: a missing column is named with the model as it is spelt, never capitalised', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}  - name: customer_name\n    dataType: string\n`,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': `${FCT}  - fromColumn: Customer_Key\n    toModel: dim_customer\n    toColumn: customer\n    cardinality: many-to-one\n`,
    });
    const before = p.read('logical-models/fct_order.yml');
    const run = await repair(p);
    // The respelling of the same entry waits too: a link that needs a decision is left whole.
    expect(codes(run.before)).toEqual(['REL004', 'REL005']);
    expect(run.plan.changes).toEqual([]);
    expect(run.plan.left[0].message).toContain('model dim_customer has no column customer');
    expect(run.plan.left[0].message).not.toContain('Dim_customer');
    expect(p.read('logical-models/fct_order.yml')).toBe(before);
  });

  it('REL006 other than the 1.6.7 shape (the other end is part of a key) is listed, never turned round', async () => {
    // dim_customer.customer_key → brg_customer_date.customer_key many-to-one: the bridge's column is part of its key.
    const dim = `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: brg_customer_date\n    toColumn: customer_key\n    cardinality: many-to-one\n`;
    const bridge = 'name: brg_customer_date\ncolumns:\n  - name: customer_key\n    isPrimaryKey: true\n  - name: date_key\n    isPrimaryKey: true\n';
    const p = project({
      'logical-models/dim_customer.yml': dim, 'logical-models/brg_customer_date.yml': bridge,
      'logical-models/dim_date.yml': DIM_DATE, 'logical-models/fct_order.yml': FCT,
    });
    const run = await repair(p);
    expect(codes(run.before)).toEqual(['REL006']);
    expect(run.plan.changes).toEqual([]);
    expect(run.plan.left[0].message).toMatch(/the keys suggest it runs the other way — if so, use ⇄ on the canvas; if both sides are unique, make it one-to-one/);
    expect(p.read('logical-models/dim_customer.yml')).toBe(dim);
  });
});

describe('the 1.6.7 shape: a dimension → fact line stored backwards in the dimension\'s file', () => {
  const backwards = `relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: many-to-one\n`;
  const inFact = '  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n';

  it('is turned round into the fact\'s file automatically, and a second run does nothing', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}${backwards}`,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT,
    });
    expect(codes(readRepairSnapshot(p.deps))).toEqual(['REL006']);
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.swapped).toBe(1);
    expect(run.plan.expect.redrawn.size).toBe(1);
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(p.read('logical-models/fct_order.yml')).toBe(`${FCT}${inFact}`);
    expect(codes(run.after)).toEqual([]);
    expect(describeRepairOffer(run.plan)).toBe(
      '1 relationship can be tidied up automatically (1 saved the wrong way round (its key column as the "many" side)). '
      + 'Review the fixes with Repair Relationships…? Nothing changes until you confirm.',
    );
    expect((await repair(p)).plan.changes).toEqual([]);
  });

  it('also when the fact\'s column is marked as a foreign key', async () => {
    const fct = FCT.replace('  - name: customer_key\n    dataType: string', '  - name: customer_key\n    dataType: string\n    isForeignKey: true');
    const p = project({ 'logical-models/dim_customer.yml': `${DIM}${backwards}`, 'logical-models/dim_date.yml': DIM_DATE, 'logical-models/fct_order.yml': fct });
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(p.read('logical-models/fct_order.yml')).toBe(`${fct}${inFact}`);
    expect(codes(run.after)).toEqual([]);
  });

  it('(c) takes off the isForeignKey 1.6.7\'s Draw from dbt left on the dimension\'s key, and nothing else', async () => {
    const dimFk = `${DIM}    isForeignKey: true\n`;
    const p = project({ 'logical-models/dim_customer.yml': `${dimFk}${backwards}`, 'logical-models/dim_date.yml': DIM_DATE, 'logical-models/fct_order.yml': FCT });
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.foreignKeysCleared).toBe(1);
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(p.read('logical-models/fct_order.yml')).toBe(`${FCT}${inFact}`);
    expect(describeRepairPlan(run.plan)).toContain('takes isForeignKey off dim_customer.customer_key');
  });

  it('(c) keeps the flag when the key is also the foreign-key end of another relationship (a subtype of a party)', async () => {
    const party = 'name: dim_party\ncolumns:\n  - name: party_key\n    dataType: string\n    isPrimaryKey: true\n';
    const dim = `${DIM}    isForeignKey: true\n${backwards}  - fromColumn: customer_key\n    toModel: dim_party\n    toColumn: party_key\n    cardinality: one-to-one\n`;
    const p = project({
      'logical-models/dim_customer.yml': dim, 'logical-models/dim_party.yml': party,
      'logical-models/dim_date.yml': DIM_DATE, 'logical-models/fct_order.yml': FCT,
    });
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(run.plan.counts).toMatchObject({ swapped: 1, foreignKeysCleared: 0 });
    expect(p.read('logical-models/dim_customer.yml')).toContain('    isForeignKey: true\n');
    expect(p.read('logical-models/dim_customer.yml')).toContain('toModel: dim_party');
    expect(p.read('logical-models/fct_order.yml')).toBe(`${FCT}${inFact}`);
  });

  it('(c) a flag with a comment on its line is left and said; the turn still goes ahead', async () => {
    const dim = `${DIM}    isForeignKey: true   # from dbt\n${backwards}`;
    const p = project({ 'logical-models/dim_customer.yml': dim, 'logical-models/dim_date.yml': DIM_DATE, 'logical-models/fct_order.yml': FCT });
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(run.plan.counts).toMatchObject({ swapped: 1, foreignKeysCleared: 0 });
    expect(messages(run.plan.left)).toEqual([expect.stringMatching(
      /^dim_customer\.customer_key is its primary key but is still marked isForeignKey: true — .*shares its line with something else.*take the flag off by hand/,
    )]);
    expect(p.read('logical-models/dim_customer.yml')).toBe(`${DIM}    isForeignKey: true   # from dbt\n`);
  });

  it('an entry carrying a comment is left whole, and says why (a second run does nothing either)', async () => {
    const dim = `${DIM}relationships:\n  - fromColumn: customer_key   # hand note\n    toModel: FCT_ORDER\n    toColumn: customer_key\n    cardinality: many-to-one\n`;
    const p = project({ 'logical-models/dim_customer.yml': dim, 'logical-models/dim_date.yml': DIM_DATE, 'logical-models/fct_order.yml': FCT });
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(run.plan.changes).toEqual([]);
    expect(messages(run.plan.left).join(' ')).toMatch(/logical-models\/dim_customer\.yml entry 1 has comments, which this change would remove — left as it is/);
    expect(p.read('logical-models/dim_customer.yml')).toBe(dim);
  });

  it('in a diagram file of a per-diagram project it is listed, never turned round (use ⇄ on the canvas)', async () => {
    const typo = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const a = domainJson('a', ['dim_customer', 'fct_order'], [typo]);
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/a.json': a,
    });
    const run = await repair(p);
    expect(run.before.mode).toBe('domain');
    expect(run.plan.changes).toEqual([]);
    expect(run.plan.left[0].message).toBe(
      'dim_customer.customer_key → fct_order.customer_key: the keys suggest it runs the other way — if so, use ⇄ on the canvas; '
      + 'if both sides are unique, make it one-to-one. Left as it is.',
    );
    expect(run.plan.left[0].filePath).toBe(p.at('gold/a.json'));
    // The entry's `{` is on the line above its first key.
    expect(reportItemLine(run.plan.left[0])).toBe(a.split('\n').findIndex((l) => l.includes('"fromModel": "dim_customer"')));
    expect(p.read('gold/a.json')).toBe(a);
  });

  it('the move leaves a diagram copy of it where it is, with the ⇄ hint — never turned round, never moved into the dimension\'s file', async () => {
    const typo = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const a = domainJson('a', ['dim_customer', 'fct_order'], [typo]);
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/a.json': a,
      'gold/b.json': domainJson('b', ['dim_customer', 'fct_order']),
    });
    const run = await repair(p, { moveDomainsToLibrary: true });
    expect(run.problems).toEqual([]);
    expect(run.plan.counts).toMatchObject({ moved: 0, swapped: 0 });
    expect(run.plan.changes).toEqual([]);
    expect(messages(run.plan.left)).toEqual([expect.stringMatching(
      /^dim_customer\.customer_key → fct_order\.customer_key: the keys say it runs the other way .*use ⇄ on the canvas/,
    )]);
    expect(p.read('gold/a.json')).toBe(a);
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    // A second run is the same: nothing to do, the same item left.
    const again = await repair(p, { moveDomainsToLibrary: true });
    expect(again.plan.changes).toEqual([]);
  });

  it('Repair in a library project leaves copies of it in two diagram files as they are (never turned round)', async () => {
    const typo = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const a = domainJson('a', ['dim_customer', 'fct_order'], [typo]);
    const b = domainJson('b', ['dim_customer', 'fct_order'], [typo]);
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/a.json': a,
      'gold/b.json': b,
    });
    const run = await repair(p);
    expect(run.before.mode).toBe('library');
    expect(run.plan.counts.swapped).toBe(0);
    expect(run.plan.changes.filter((c) => c.kind === 'domain')).toEqual([]);
    expect(p.read('gold/a.json')).toBe(a);
    expect(p.read('gold/b.json')).toBe(b);
    expect(messages(run.plan.left).join(' ')).toContain('use ⇄ on the canvas');
  });

  it('a diagram copy stored backwards next to the right model-library record is listed as ignored, never removed as a copy', async () => {
    const typo = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const a = domainJson('a', ['dim_customer', 'fct_order'], [typo]);
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': `${FCT}${inFact}`,
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/a.json': a,
    });
    const snapshot = readRepairSnapshot(p.deps);
    expect(snapshot.findings.find((f) => f.code === 'REL009')?.fix).toBe('ignored-domain-copy');
    const plan = planRelationshipRepair(snapshot);
    expect(plan.changes).toEqual([]);
    expect(describeRepairOffer(plan)).toBeNull();
    expect(messages(plan.left)).toEqual([expect.stringMatching(/gold\/a\.json keeps its own copy.*delete it from gold\/a\.json if it is wrong/)]);
  });

  it('a one-to-one aggregate at a dimension\'s grain pointing at an unflagged dimension is listed, never turned round (#133)', async () => {
    const agg = 'name: agg_customer_ltv\ncolumns:\n  - name: customer_id\n    dataType: string\n    isPrimaryKey: true\n    isForeignKey: true\n  - name: ltv\n    dataType: number\n'
      + 'relationships:\n  - fromColumn: customer_id\n    toModel: dim_customer\n    toColumn: customer_id\n    cardinality: many-to-one\n';
    const dim = 'name: dim_customer\ncolumns:\n  - name: customer_id\n    dataType: string\n  - name: name\n    dataType: string\n';
    const p = project({ 'logical-models/agg_customer_ltv.yml': agg, 'logical-models/dim_customer.yml': dim });
    const snapshot = readRepairSnapshot(p.deps);
    expect(snapshot.findings.find((f) => f.code === 'REL006')?.fix).toBe('swap');
    const plan = planRelationshipRepair(snapshot);
    expect(plan.changes).toEqual([]);
    expect(describeRepairOffer(plan)).toBeNull();
    expect(messages(plan.left)).toEqual([expect.stringContaining('the keys suggest it runs the other way')]);
  });

  it('an SCD2 dimension\'s natural key pointing at an unflagged source model is listed, never turned round (#133)', async () => {
    const dim = 'name: dim_customer\ncolumns:\n  - name: customer_sk\n    dataType: string\n    isPrimaryKey: true\n  - name: customer_id\n    dataType: string\n    isNaturalKey: true\n'
      + 'relationships:\n  - fromColumn: customer_id\n    toModel: src_customers\n    toColumn: id\n    cardinality: many-to-one\n';
    const src = 'name: src_customers\ncolumns:\n  - name: id\n    dataType: string\n  - name: name\n    dataType: string\n';
    const p = project({ 'logical-models/dim_customer.yml': dim, 'logical-models/src_customers.yml': src });
    const plan = planRelationshipRepair(readRepairSnapshot(p.deps));
    expect(plan.changes).toEqual([]);
    expect(describeRepairOffer(plan)).toBeNull();
  });
});

describe('what the repair never touches', () => {
  it('REL008: an entry the reader could not read keeps its bytes, and blocks every other copy of its link', async () => {
    const bad = '  - fromColumn: customer_key   # typo below\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: one_to_many\n';
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': `${FCT.replace('toModel: dim_date', 'toModel: DIM_DATE')}${bad}`,
    });
    const analysis = analyseRepair(readRepairSnapshot(p.deps));
    expect(analysis.unreadableEntries).toHaveLength(1);
    expect(analysis.unreadableEntries[0].line).toBe(16);
    expect(analysis.left[0].message).toContain('could not be read in full');
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    // The date entry is respelled; the typo entry is exactly as written; the dimension's copy stays.
    expect(p.read('logical-models/fct_order.yml')).toBe(`${FCT}${bad}`);
    expect(p.read('logical-models/dim_customer.yml')).toContain('cardinality: one-to-many');
  });

  it('per-domain project: copies in different domain files are each diagram\'s own; one file\'s duplicates go', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const other = { ...rel, cardinality: 'one-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer'], [rel, rel]),
      'gold/b.json': domainJson('b', ['fct_order', 'dim_customer'], [other]),
    });
    const bBefore = p.read('gold/b.json');
    const run = await repair(p);
    expect(run.before.mode).toBe('domain');
    expect(run.problems).toEqual([]);
    expect(JSON.parse(p.read('gold/a.json')).logical.relationships).toEqual([rel]);
    expect(p.read('gold/b.json')).toBe(bBefore);
    expect(p.read('logical-models/fct_order.yml')).toBe(FCT_HEAD + '\n');
  });

  it('per-domain project: identical copies in one file keep the one carrying its own keys, even when it is not first', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer'], [rel, { ...rel, description: 'KEEP ME' }]),
    });
    const run = await repair(p);
    expect(run.before.mode).toBe('domain');
    expect(run.problems).toEqual([]);
    expect(JSON.parse(p.read('gold/a.json')).logical.relationships).toEqual([{ ...rel, description: 'KEEP ME' }]);
  });

  it('per-domain project: copies that disagree in one file are both kept and listed', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const other = { ...rel, cardinality: 'one-to-one', description: 'KEEP ME' };
    const a = domainJson('a', ['fct_order', 'dim_customer'], [rel, other]);
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': a,
    });
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(run.plan.changes).toEqual([]);
    expect(run.plan.left[0].message).toContain('its copies disagree');
    expect(run.plan.left[0].file).toBe('gold/a.json');
    expect(p.read('gold/a.json')).toBe(a);
  });

  it('a library project\'s domain copy whose domain does not show both models (so draws nothing) goes too', async () => {
    const copy = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/orders.json': domainJson('orders', ['fct_order'], [copy]),
    });
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(JSON.parse(p.read('gold/orders.json')).logical.relationships).toEqual([]);
    expect(p.read('logical-models/fct_order.yml')).toBe(FCT);
  });
});

describe('the move: domain → library', () => {
  it('leaves a relationship two diagrams define differently in both diagrams, and lists it', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer'], [rel]),
      'gold/b.json': domainJson('b', ['fct_order', 'dim_customer'], [{ ...rel, cardinality: 'one-to-one' }]),
    });
    const before = { a: p.read('gold/a.json'), b: p.read('gold/b.json') };
    const run = await repair(p, { moveDomainsToLibrary: true });
    expect(run.problems).toEqual([]);
    expect(run.plan.changes).toEqual([]);
    expect(run.plan.counts.moved).toBe(0);
    expect(run.plan.movedLinks.size).toBe(0);
    expect(run.plan.left[0].message).toMatch(/its copies disagree \(.*\(many-to-one\) in gold\/a\.json; .*\(one-to-one\) in gold\/b\.json\)/);
    expect(p.read('gold/a.json')).toBe(before.a);
    expect(p.read('gold/b.json')).toBe(before.b);
    expect(p.read('logical-models/fct_order.yml')).toBe(FCT_HEAD + '\n');
  });

  it('moves the relationships that agree and leaves only the one that does not', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const date = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer', 'dim_date'], [rel, date]),
      'gold/b.json': domainJson('b', ['fct_order', 'dim_customer', 'dim_date'], [{ ...rel, cardinality: 'one-to-one' }, date]),
    });
    const run = await repair(p, { moveDomainsToLibrary: true });
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.moved).toBe(1);
    expect(run.plan.left).toHaveLength(1);
    expect(JSON.parse(p.read('gold/a.json')).logical.relationships).toEqual([rel]);
    expect(JSON.parse(p.read('gold/b.json')).logical.relationships).toEqual([{ ...rel, cardinality: 'one-to-one' }]);
    expect(p.read('logical-models/fct_order.yml')).toContain('toModel: dim_date');
  });
});

describe('verifyRepair', () => {
  it('reports a byte changed outside the relationships, and a diagram that stopped drawing a link', async () => {
    const copy = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    const own = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/orders.json': domainJson('orders', ['fct_order', 'dim_date', 'dim_customer'], [copy, own]),
    });
    const before = readRepairSnapshot(p.deps);
    const plan = planRelationshipRepair(before);
    expect(plan.changes.map((c) => c.file)).toEqual(['gold/orders.json']);
    // Write the plan, but also drop the domain's own relationship and touch its description.
    const tampered = JSON.parse(plan.changes[0].text);
    tampered.logical.relationships = [];
    tampered.description = 'changed';
    fs.writeFileSync(plan.changes[0].filePath, JSON.stringify(tampered, null, 2) + '\n');
    const problems = verifyRepair(before, readRepairSnapshot(p.deps), plan);
    expect(problems).toEqual(expect.arrayContaining([
      'gold/orders.json does not hold what was written',
      'gold/orders.json: something other than its relationships changed',
      'gold/orders no longer draws fct_order.customer_key → dim_customer.customer_key',
    ]));
  });
});

describe('linksTheMoveStores — what the move offer counts', () => {
  const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
  const files = (a: unknown[], fct = FCT_HEAD + '\n') => ({
    'logical-models/dim_customer.yml': DIM,
    'logical-models/dim_date.yml': DIM_DATE,
    'logical-models/fct_order.yml': fct,
    'gold/a.json': domainJson('a', ['fct_order', 'dim_customer'], a),
    'gold/b.json': domainJson('b', ['fct_order', 'dim_customer'], []),
  });

  it('names a domain relationship the move would store in the model library', () => {
    const stored = linksTheMoveStores(readRepairSnapshot(project(files([rel])).deps));
    expect(stored.size).toBe(1);
  });

  it('leaves out a relationship whose only copy carries its own keys (the move would leave it)', () => {
    expect(linksTheMoveStores(readRepairSnapshot(project(files([{ ...rel, description: 'mine' }])).deps)).size).toBe(0);
  });

  it('leaves out a relationship whose from-model has no readable file', () => {
    const p = project(files([{ ...rel, fromModel: 'fct_gone' }]));
    expect(linksTheMoveStores(readRepairSnapshot(p.deps)).size).toBe(0);
  });
});

describe('verifyRepair: an entry\'s own keys', () => {
  it('reports a written file whose entries carry fewer of the user\'s own keys than before', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const dated = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', description: 'keep' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer', 'dim_date'], [rel, rel, dated]),
    });
    const before = readRepairSnapshot(p.deps);
    const plan = planRelationshipRepair(before);
    expect(plan.changes.map((c) => c.file)).toEqual(['gold/a.json']);
    const written = JSON.parse(plan.changes[0].text);
    expect(written.logical.relationships).toEqual([rel, dated]);
    // Write the plan with the description dropped, as a planner bug would.
    written.logical.relationships[1] = { ...rel, fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key' };
    const tampered = JSON.stringify(written, null, 2) + '\n';
    fs.writeFileSync(plan.changes[0].filePath, tampered);
    const problems = verifyRepair(before, readRepairSnapshot(p.deps), { ...plan, changes: [{ ...plan.changes[0], text: tampered }] });
    expect(problems).toContain("gold/a.json: an entry's own key description is gone");
  });
});

describe('editYamlRelationships', () => {
  const entry = { fromColumn: 'a', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one' as const };

  it('keeps CRLF line endings and a BOM', () => {
    const text = '﻿name: x\r\nrelationships:\r\n  - fromColumn: a\r\n    toModel: b\r\n    toColumn: id\r\n    cardinality: one-to-many\r\n';
    const out = editYamlRelationships(text, { remove: new Set(), update: new Map([[0, entry]]), append: [{ ...entry, fromColumn: 'c' }] });
    expect(out).toBe('﻿name: x\r\nrelationships:\r\n  - fromColumn: a\r\n    toModel: b\r\n    toColumn: id\r\n    cardinality: many-to-one\r\n'
      + '  - fromColumn: c\r\n    toModel: b\r\n    toColumn: id\r\n    cardinality: many-to-one\r\n');
  });

  it('adds and removes a role line in place', () => {
    const text = 'name: x\nrelationships:\n  - fromColumn: a\n    toModel: b\n    toColumn: id\n    cardinality: many-to-one\n    role: old   # was\n    note: kept\n';
    const cleared = editYamlRelationships(text, { remove: new Set(), update: new Map([[0, entry]]), append: [] });
    expect(cleared).toBe('name: x\nrelationships:\n  - fromColumn: a\n    toModel: b\n    toColumn: id\n    cardinality: many-to-one\n    note: kept\n');
    const added = editYamlRelationships(cleared, { remove: new Set(), update: new Map([[0, { ...entry, role: 'buyer' }]]), append: [] });
    expect(added).toBe('name: x\nrelationships:\n  - fromColumn: a\n    toModel: b\n    toColumn: id\n    cardinality: many-to-one\n    note: kept\n    role: buyer\n');
  });

  it('removes the list when its last entry goes, and handles an entry at the end of a file with no final newline', () => {
    const text = 'name: x\nrelationships:\n  - fromColumn: a\n    toModel: b\n    toColumn: id\n    cardinality: many-to-one';
    expect(editYamlRelationships(text, { remove: new Set([0]), update: new Map(), append: [] })).toBe('name: x');
    expect(editYamlRelationships(text, { remove: new Set(), update: new Map(), append: [{ ...entry, fromColumn: 'c' }] }))
      .toBe(`${text}\n  - fromColumn: c\n    toModel: b\n    toColumn: id\n    cardinality: many-to-one`);
  });

  it('refuses a flow-style list rather than rewriting it', () => {
    const text = 'name: x\nrelationships: [{ fromColumn: a, toModel: b, toColumn: id, cardinality: many-to-one }]\n';
    expect(() => editYamlRelationships(text, { remove: new Set([0]), update: new Map(), append: [] }, 'x.yml'))
      .toThrow(RepairEditError);
  });

  it('editDomainRelationships keeps an entry\'s other keys and every malformed entry', () => {
    const text = domainJson('d', ['a', 'b'], [
      { fromModel: 'A', fromColumn: 'x', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one', note: 'keep' },
      { fromModel: 'a' },
    ]);
    const out = editDomainRelationships(text, {
      remove: new Set(),
      update: new Map([[0, { fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one' }]]),
    });
    expect(JSON.parse(out).logical.relationships).toEqual([
      { fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one', note: 'keep' },
      { fromModel: 'a' },
    ]);
  });
});

describe('a diagram file changes entry by entry (#133 review)', () => {
  const head = '{\n  "schemaVersion": 5,\n  "domain": "orders",\n  "layer": "gold",\n  "logical": {\n    "models": ["a", "b", "fct_order", "dim_date"],\n    "relationships": [\n';
  const tail = '\n    ]\n  },\n  "viewConfig": {}\n}\n';
  const kept = '      { "fromModel": "a", "fromColumn": "x", "toModel": "b", "toColumn": "id", "cardinality": "many-to-one", "weight": 1.50, "note": "caf\\u00e9" }';
  const unreadable = '      { "fromModel": "a", "fromColumn": "y", "toModel": "b", "toColumn": "id", "cardinality": "one_to_many", "role": 12345678901234567890 }';
  const third = '      { "fromModel": "fct_order", "fromColumn": "date_key", "toModel": "dim_date", "toColumn": "date_key", "cardinality": "many-to-one" }';

  it('removing one entry leaves every other entry\'s bytes exactly as written', () => {
    const text = `${head}${kept},\n${unreadable},\n${third}${tail}`;
    expect(editDomainRelationships(text, { remove: new Set([2]), update: new Map() })).toBe(`${head}${kept},\n${unreadable}${tail}`);
    expect(editDomainRelationships(text, { remove: new Set([0]), update: new Map() })).toBe(`${head}${unreadable},\n${third}${tail}`);
    expect(editDomainRelationships(text, { remove: new Set([0, 1, 2]), update: new Map() }))
      .toBe(head.replace(/\[\n$/, '[]') + tail.replace(/^\n    \]/, ''));
  });

  it('changing one entry rewrites only the values that change, keeping its own keys and their spelling', () => {
    const text = `${head}${kept},\n${third}${tail}`;
    const out = editDomainRelationships(text, {
      remove: new Set(),
      update: new Map([[0, { fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'id', cardinality: 'one-to-one', role: 'buyer' }]]),
    });
    expect(out).toBe(`${head}${kept.replace('"many-to-one"', '"one-to-one"').replace(' }', ', "role": "buyer" }')},\n${third}${tail}`);
    const back = editDomainRelationships(out, {
      remove: new Set(),
      update: new Map([[0, { fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'id', cardinality: 'one-to-one' }]]),
    });
    expect(back).toBe(`${head}${kept.replace('"many-to-one"', '"one-to-one"')},\n${third}${tail}`);
  });

  it('a REL009 repair in a file holding an unreadable entry leaves that entry\'s value intact, and verify holds it to that', async () => {
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/a.yml': 'name: a\ncolumns:\n  - { name: x, dataType: INT }\n  - { name: y, dataType: INT }\n',
      'logical-models/b.yml': 'name: b\ncolumns:\n  - { name: id, dataType: INT, isPrimaryKey: true }\n',
      'gold/orders.json': `${head}${kept},\n${unreadable},\n${third}${tail}`,
    });
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.domainCopiesRemoved).toBe(1);
    expect(p.read('gold/orders.json')).toBe(`${head}${kept},\n${unreadable}${tail}`);
  });

  it('verify refuses a diagram file whose untouched entry was rewritten', async () => {
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/a.yml': 'name: a\ncolumns:\n  - { name: x, dataType: INT }\n',
      'logical-models/b.yml': 'name: b\ncolumns:\n  - { name: id, dataType: INT, isPrimaryKey: true }\n',
      'gold/orders.json': `${head}${kept},\n${third}${tail}`,
    });
    const before = readRepairSnapshot(p.deps);
    const plan = planRelationshipRepair(before);
    const change = plan.changes.find((c) => c.kind === 'domain')!;
    // What the old whole-array rewrite produced: the kept entry re-rendered.
    const rewritten = change.text.replace(kept, kept.replace('1.50', '1.5'));
    fs.writeFileSync(change.filePath, rewritten);
    const after = readRepairSnapshot(p.deps);
    expect(verifyRepair(before, after, { ...plan, changes: plan.changes.map((c) => (c === change ? { ...c, text: rewritten } : c)) }))
      .toContain('gold/orders.json: an entry the repair did not change was rewritten');
  });
});

describe('the repair and the checks read the same domains', () => {
  it('stub columns: a domain relationship to a stub model\'s unlisted column is no finding, as on the canvas', () => {
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': `${FCT_HEAD}\n  - name: customer_code\n    dataType: string\n`,
      'gold/a.json': JSON.stringify({
        schemaVersion: 5, domain: 'a', layer: 'gold', stubColumns: ['dim_customer'],
        logical: { models: ['fct_order', 'dim_customer'], relationships: [{ fromModel: 'fct_order', fromColumn: 'customer_code', toModel: 'dim_customer', toColumn: 'customer_code', cardinality: 'many-to-one' }] },
        viewConfig: {},
      }),
    });
    expect(readRepairSnapshot(p.deps).findings).toEqual([]);
  });

  it('a v4 diagram\'s problems are reported as out of reach, never as nothing to repair', () => {
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'gold/legacy.json': JSON.stringify({
        schemaVersion: 4, domain: 'legacy', layer: 'gold',
        logical: {
          models: [{ name: 'a', columns: [{ name: 'id', dataType: 'INT' }] }, { name: 'b', columns: [{ name: 'a_id', dataType: 'INT' }] }],
          relationships: [{ fromModel: 'b', fromColumn: 'nope', toModel: 'a', toColumn: 'id', cardinality: 'many-to-one' }],
        },
      }),
    });
    const snapshot = readRepairSnapshot(p.deps);
    expect(snapshot.findings.map((f) => f.code)).toEqual(['REL004']);
    const analysis = analyseRepair(snapshot);
    expect(analysis.tasks).toEqual([]);
    expect(messages(analysis.outOfReach)).toEqual([
      expect.stringMatching(/^gold\/legacy\.json has 1 relationship problem but is still in the older format .*Migrate Domains to Central Model Store/),
    ]);
    expect(analysis.outOfReach[0].filePath).toBe(p.at('gold/legacy.json'));
  });

  it('a domain file that cannot be read is out of reach, named', () => {
    const p = project({ 'logical-models/dim_customer.yml': DIM, 'gold/broken.json': '{ "nope' });
    const analysis = analyseRepair(readRepairSnapshot(p.deps));
    expect(messages(analysis.outOfReach)).toEqual([expect.stringMatching(/^gold\/broken\.json was not checked: it could not be read/)]);
  });
});

describe('the move and stub columns', () => {
  it('leaves a relationship only a diagram\'s stub columns allow where it is — said up front, never rolled back after writing', async () => {
    const stubbed = { fromModel: 'fct_order', fromColumn: 'customer_code', toModel: 'dim_customer', toColumn: 'customer_code', cardinality: 'many-to-one' };
    const sound = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': `${FCT_HEAD}\n  - name: customer_code\n    dataType: string\n`,
      'gold/a.json': JSON.stringify({
        schemaVersion: 5, domain: 'a', layer: 'gold', stubColumns: ['dim_customer'],
        logical: { models: ['fct_order', 'dim_customer', 'dim_date'], relationships: [stubbed, sound] },
        viewConfig: {},
      }, null, 2) + '\n',
    });
    const run = await repair(p, { moveDomainsToLibrary: true });
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.moved).toBe(1);
    expect(messages(run.plan.left)).toEqual([
      expect.stringMatching(/^fct_order\.customer_code → dim_customer\.customer_code: left in gold\/a\.json — it uses dim_customer\.customer_code, which dim_customer's model file does not list/),
    ]);
    expect(JSON.parse(p.read('gold/a.json')).logical.relationships).toEqual([stubbed]);
    expect(p.read('logical-models/fct_order.yml')).toContain('toModel: dim_date');
  });
});

describe('scanDomainFiles', () => {
  it('counts domain-file relationship entries exactly as DomainService.countDomainFileRelationships does', () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer'], [rel, 'junk', { fromModel: 'x' }]),
      'gold/legacy.json': JSON.stringify({ schemaVersion: 4, domain: 'legacy', layer: 'gold', logical: { models: [{ name: 'a', columns: [] }], relationships: [rel] } }),
      'gold/mixed.json': JSON.stringify({ schemaVersion: 5, domain: 'mixed', layer: 'gold', logical: { models: ['a', { name: 'b' }], relationships: [rel, rel] } }),
      'gold/broken.json': '{ "nope',
    });
    const scan = scanDomainFiles(p.deps.domainService, p.root, SEMANTIC_DIR);
    expect(scan.domainFileRelationshipCount).toBe(p.deps.domainService.countDomainFileRelationships(p.root, SEMANTIC_DIR));
    expect(scan.domainFileRelationshipCount).toBe(6);
    expect(scan.v5.map((d) => d.label)).toEqual(['gold/a']);
    expect(scan.v4.map((d) => d.label)).toEqual(['gold/legacy']);
    expect(scan.unchecked.map((d) => d.label).sort()).toEqual(['gold/broken', 'gold/mixed']);
    expect(scan.v5[0].readIssues.map((i) => [i.index, i.reason])).toEqual([[1, 'not-a-mapping'], [2, 'missing-endpoint']]);
  });

  it('a domain file saved with a byte-order mark is unchecked, as the canvas cannot open it either — never counted as checked', () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer'], [rel]),
      'gold/bom.json': '\uFEFF' + domainJson('bom', ['fct_order', 'dim_customer'], [rel]),
    });
    expect(() => p.deps.domainService.getDomain(path.join(p.root, SEMANTIC_DIR, 'gold', 'bom.json'))).toThrow();
    const scan = scanDomainFiles(p.deps.domainService, p.root, SEMANTIC_DIR);
    expect(scan.v5.map((d) => d.label)).toEqual(['gold/a']);
    expect(scan.unchecked).toEqual([expect.objectContaining({
      label: 'gold/bom',
      reason: 'it starts with a byte-order mark (BOM), so ERD Studio cannot open it — save it as UTF-8 without BOM',
    })]);
    expect(scan.domainFileRelationshipCount).toBe(p.deps.domainService.countDomainFileRelationships(p.root, SEMANTIC_DIR));
    // Unopenable, but its relationship still says the project keeps them per
    // diagram (#133 review 8): it counts towards the mode.
    expect(scan.domainFileRelationshipCount).toBe(2);
  });

  it('a domain file that does not parse (a merge conflict) still counts its relationships towards the mode (#133 review 8)', () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const conflicted = domainJson('sales', ['fct_order', 'dim_customer'], [rel])
      .replace('"viewConfig"', '<<<<<<< HEAD\n"viewConfig"');
    expect(() => JSON.parse(conflicted)).toThrow();
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'gold/sales.json': conflicted,
      'gold/other.json': domainJson('other', ['fct_order', 'dim_customer'], []),
      'gold/empty.json': '{ "nope',
    });
    const scan = scanDomainFiles(p.deps.domainService, p.root, SEMANTIC_DIR);
    expect(scan.domainFileRelationshipCount).toBe(1);
    expect(p.deps.domainService.countDomainFileRelationships(p.root, SEMANTIC_DIR)).toBe(1);
    // So the project stays per-diagram: a new relationship is not written to a model file.
    expect(usesLibraryRelationships([], scan.domainFileRelationshipCount)).toBe(false);
  });
});

describe('review findings (#133): nothing lost, nothing rolled back for something out of reach', () => {
  const CUSTOMER_REL = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };

  it('a v4 diagram\'s disagreeing copy does not make the repair of the other copies roll back', async () => {
    const date = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/orders.json': domainJson('orders', ['fct_order', 'dim_date'], [date]),
      'silver/legacy.json': JSON.stringify({
        schemaVersion: 4, domain: 'legacy', layer: 'silver',
        logical: {
          models: [
            { name: 'fct_order', columns: [{ name: 'date_key', dataType: 'date' }] },
            { name: 'dim_date', columns: [{ name: 'date_key', dataType: 'date', isPrimaryKey: true }] },
          ],
          // Two copies of its own that disagree: a real problem in the v4
          // file, which the repair cannot reach.
          relationships: [{ ...date, cardinality: 'one-to-one' }, date],
        },
      }),
    });
    const run = await repair(p);
    expect(codes(run.before)).toEqual(expect.arrayContaining(['REL001', 'REL009']));
    // The v4 copies are compared with each other, never with the library's
    // copy: a v4 diagram never draws the library's relationships (#133 review).
    const rel001 = run.before.findings.filter((f) => f.code === 'REL001');
    expect(rel001.map((f) => f.files)).toEqual([['silver/legacy.json']]);
    expect(run.problems).toEqual([]);
    expect(JSON.parse(p.read('gold/orders.json')).logical.relationships).toEqual([]);
    expect(messages(run.plan.outOfReach).join(' ')).toContain('silver/legacy.json');
  });

  it('a missing column\'s entry keeps its own keys — and verification guards every entry\'s own keys', async () => {
    const fct = `${FCT}  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: no_such_column\n    cardinality: many-to-one\n    description: kept by hand\n`;
    const p = project({ 'logical-models/dim_customer.yml': DIM, 'logical-models/fct_order.yml': fct, 'logical-models/dim_date.yml': DIM_DATE });
    const listed = await repair(p);
    expect(codes(listed.before)).toEqual(['REL004']);
    expect(listed.plan.changes).toEqual([]);
    expect(p.read('logical-models/fct_order.yml')).toBe(fct);

    // A REL002 fix that writes fct_order.yml: a plan that took out the other entry's `note` is reported.
    const q = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const run = await repair(q);
    expect(run.problems).toEqual([]);
    const change = run.plan.changes.find((c) => c.file === 'logical-models/fct_order.yml')!;
    const tampered = { ...change, text: change.text.replace('    note: an unknown key the repair must keep\n', '') };
    fs.writeFileSync(change.filePath, tampered.text);
    const after = readRepairSnapshot(q.deps);
    expect(verifyRepair(run.before, after, { ...run.plan, changes: [tampered] })).toContain('logical-models/fct_order.yml: an entry\'s own key note is gone');
  });

  it('a v4 diagram\'s single copy that differs from the library\'s is no finding: the two are never drawn together', () => {
    const date = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
      'silver/legacy.json': JSON.stringify({
        schemaVersion: 4, domain: 'legacy', layer: 'silver',
        logical: {
          models: [
            { name: 'fct_order', columns: [{ name: 'date_key', dataType: 'date' }] },
            { name: 'dim_date', columns: [{ name: 'date_key', dataType: 'date', isPrimaryKey: true }] },
          ],
          relationships: [{ ...date, cardinality: 'one-to-one' }],
        },
      }),
    });
    const snapshot = readRepairSnapshot(p.deps);
    expect(snapshot.findings.filter((f) => f.code === 'REL001')).toEqual([]);
    expect(analyseRepair(snapshot).outOfReach).toEqual([]);
  });

  it('never takes out an entry carrying the user\'s own keys or comments: the link is left, and says why', async () => {
    const dim = `${DIM}relationships:\n  # why: finance sign-off\n  - fromColumn: customer_key   # agreed\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n    description: sign-off by finance\n    tests: [relationships]\n`;
    const p = project({ 'logical-models/dim_customer.yml': dim, 'logical-models/fct_order.yml': FCT, 'logical-models/dim_date.yml': DIM_DATE });
    const run = await repair(p);
    expect(codes(run.before)).toContain('REL002');
    expect(run.plan.changes).toEqual([]);
    expect(messages(run.plan.left).join(' ')).toMatch(/logical-models\/dim_customer\.yml entry 1 has its own keys description, tests and comments, which this change would remove — left as it is/);
    expect(p.read('logical-models/dim_customer.yml')).toBe(dim);
  });

  it('the move never drops a domain entry\'s own keys', async () => {
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/orders.json': domainJson('orders', ['fct_order', 'dim_customer'], [{ ...CUSTOMER_REL, description: 'd1', label: 'L' }]),
    });
    const run = await repair(p, { moveDomainsToLibrary: true });
    expect(run.plan.changes).toEqual([]);
    expect(messages(run.plan.left).join(' ')).toContain('gold/orders.json entry 1 has its own keys description, label');
  });

  it('a comment above an entry stays when every entry of the list goes', async () => {
    const dim = `${DIM}relationships:\n  # turned round by the repair\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`;
    const p = project({ 'logical-models/dim_customer.yml': dim, 'logical-models/fct_order.yml': FCT, 'logical-models/dim_date.yml': DIM_DATE });
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(p.read('logical-models/dim_customer.yml')).toBe(`${DIM}relationships:\n  # turned round by the repair\n`);
    expect(p.read('logical-models/fct_order.yml')).toContain('    toModel: dim_customer\n');
  });

  it('a role longer than the canvas shows is never cut by a repair (model file and domain file)', async () => {
    const long = 'the customer who placed the order, as recorded on the order header at checkout time';
    const fct = `${FCT}  - fromColumn: customer_key\n    toModel: DIM_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n    role: ${long}\n`;
    const p = project({ 'logical-models/dim_customer.yml': DIM, 'logical-models/fct_order.yml': fct, 'logical-models/dim_date.yml': DIM_DATE });
    const run = await repair(p);
    expect(codes(run.before)).toEqual(expect.arrayContaining(['REL005', 'REL008']));
    expect(run.plan.changes).toEqual([]);
    expect(p.read('logical-models/fct_order.yml')).toBe(fct);

    const domain = domainJson('orders', ['fct_order', 'dim_customer'], [{ ...CUSTOMER_REL, toModel: 'DIM_customer', role: long }]);
    const q = project({
      'logical-models/dim_customer.yml': DIM, 'logical-models/fct_order.yml': FCT_HEAD + '\n', 'logical-models/dim_date.yml': DIM_DATE,
      'gold/orders.json': domain,
    });
    const moved = await repair(q, { moveDomainsToLibrary: true });
    expect(moved.plan.changes).toEqual([]);
    expect(q.read('gold/orders.json')).toBe(domain);
  });

  it('REL003: a diagram\'s own relationship to a model the diagram does not hold is listed, never changed', async () => {
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/orders.json': domainJson('orders', ['fct_order', 'dim_date'], [CUSTOMER_REL]),
    });
    const before = readRepairSnapshot(p.deps);
    expect(before.mode).toBe('domain');
    expect(before.findings.map((f) => f.code)).toEqual(['REL003']);
    const orders = p.read('gold/orders.json');
    const run = await repair(p);
    expect(run.plan.changes).toEqual([]);
    expect(run.plan.left[0].message).toMatch(/^fct_order\.customer_key → dim_customer\.customer_key: model dim_customer is not one of gold\/orders\.json's models/);
    expect(p.read('gold/orders.json')).toBe(orders);
  });
});

describe('review findings (#133): the move never plans what it cannot store and draw', () => {
  const good = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
  const ghost = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_ghost', toColumn: 'ghost_key', cardinality: 'many-to-one' };
  const base = (a: unknown[], b: unknown[] = a): Record<string, string> => ({
    'logical-models/dim_customer.yml': DIM,
    'logical-models/fct_order.yml': FCT_HEAD + '\n',
    'gold/a.json': domainJson('a', ['fct_order', 'dim_customer', 'dim_ghost'], a),
    'gold/b.json': domainJson('b', ['fct_order', 'dim_customer', 'dim_ghost'], b),
  });

  it('a link to a model with no readable file is left up front, and the good move goes through', async () => {
    const p = project(base([good, ghost]));
    const before = readRepairSnapshot(p.deps);
    expect([...linksTheMoveStores(before)]).toHaveLength(1);
    const run = await repair(p, { moveDomainsToLibrary: true });
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.moved).toBe(1);
    expect(messages(run.plan.left)).toEqual([
      expect.stringMatching(/^fct_order\.date_key → dim_ghost\.ghost_key: left in gold\/a\.json — it points at dim_ghost, which has no readable file in logical-models\//),
    ]);
    expect(JSON.parse(p.read('gold/a.json')).logical.relationships).toEqual([ghost]);
    expect(p.read('logical-models/fct_order.yml')).toContain('toModel: dim_customer');
  });

  it('a link with an empty column is left up front: a model file cannot hold it', async () => {
    const empty = { ...good, fromColumn: 'date_key', toColumn: '' };
    const p = project(base([good, empty], [good]));
    expect([...linksTheMoveStores(readRepairSnapshot(p.deps))]).toHaveLength(1);
    const run = await repair(p, { moveDomainsToLibrary: true });
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.moved).toBe(1);
    expect(messages(run.plan.left)).toEqual([expect.stringMatching(/its toColumn is empty, which a model file cannot hold/)]);
    expect(JSON.parse(p.read('gold/a.json')).logical.relationships).toEqual([empty]);
  });

  it('a single diagram relationship whose from-model has no readable file is named as left, never passed over', async () => {
    const stray = { fromModel: 'stg_x', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer', 'stg_x'], [good, stray]),
      'gold/b.json': domainJson('b', ['fct_order', 'dim_customer'], [good]),
    });
    const run = await repair(p, { moveDomainsToLibrary: true });
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.moved).toBe(1);
    expect(messages(run.plan.left)).toEqual([
      'stg_x.customer_key → dim_customer.customer_key: stg_x has no readable file in logical-models/, so it stays where it is.',
    ]);
    expect(describeRepairPlan(run.plan)).toContain('stg_x has no readable file in logical-models/');
    expect(JSON.parse(p.read('gold/a.json')).logical.relationships).toEqual([stray]);
  });

  it('copies that disagree with no home are listed once, as having no home', async () => {
    const stray = { fromModel: 'stg_x', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer', 'stg_x'], [good, stray]),
      'gold/b.json': domainJson('b', ['fct_order', 'dim_customer', 'stg_x'], [good, { ...stray, cardinality: 'many-to-many' }]),
    });
    const run = await repair(p, { moveDomainsToLibrary: true });
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.moved).toBe(1);
    expect(messages(run.plan.left)).toEqual([
      'stg_x.customer_key → dim_customer.customer_key: stg_x has no readable file in logical-models/, so it stays where it is.',
    ]);
  });

  it('in a library project, copies that disagree and point at a missing model are listed with both reasons', async () => {
    const stray = { fromModel: 'stg_x', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': `${FCT_HEAD}\nrelationships:\n  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
      'gold/a.json': domainJson('a', ['dim_customer', 'stg_x'], [stray]),
      'gold/b.json': domainJson('b', ['dim_customer', 'stg_x'], [{ ...stray, cardinality: 'many-to-many' }]),
    });
    expect(readRepairSnapshot(p.deps).mode).toBe('library');
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(run.plan.changes).toEqual([]);
    expect(run.plan.left).toHaveLength(1);
    expect(run.plan.left[0].message).toMatch(/its copies disagree .*; model stg_x is not in the model library/);
  });
});

describe('review findings (#133): a per-diagram project', () => {
  it('a missing column in one diagram\'s own copy is listed with that file; the other diagram\'s copy is not touched', async () => {
    const right = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer'], [right]),
      'gold/b.json': domainJson('b', ['fct_order', 'dim_customer'], [{ ...right, toColumn: 'cust_key' }]),
    });
    expect(readRepairSnapshot(p.deps).mode).toBe('domain');
    const files = { a: p.read('gold/a.json'), b: p.read('gold/b.json') };
    const run = await repair(p);
    expect(run.plan.changes).toEqual([]);
    expect(run.plan.left.map((i) => [i.file, i.message])).toEqual([[
      'gold/b.json',
      'fct_order.customer_key → dim_customer.cust_key: model dim_customer has no column cust_key — point it at the right model and column, or delete it. Left as it is.',
    ]]);
    expect(p.read('gold/a.json')).toBe(files.a);
    expect(p.read('gold/b.json')).toBe(files.b);
  });
});

describe('review findings (#133): never an all-clear over files it did not read', () => {
  it('a model file with a YAML error is out of reach, named with its line', () => {
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': 'name: fct_order\ndescription: Orders: one: row\ncolumns: []\n',
    });
    const analysis = analyseRepair(readRepairSnapshot(p.deps));
    expect(analysis.tasks).toEqual([]);
    expect(messages(analysis.outOfReach)).toEqual([
      expect.stringMatching(/^logical-models\/fct_order\.yml was not checked: it has a YAML error on line \d+, so the relationships in it were not looked at/),
    ]);
    expect(analysis.outOfReach[0].filePath).toBe(p.at('logical-models/fct_order.yml'));
    expect(analysis.outOfReach[0].line).toBeGreaterThan(0);
  });

  it('a layers.json that cannot be used is out of reach', () => {
    const p = project({ 'logical-models/dim_customer.yml': DIM });
    const analysis = analyseRepair(readRepairSnapshot({ ...p.deps, layerService: { getLoadError: () => 'Invalid JSON' } }));
    expect(messages(analysis.outOfReach)).toEqual([expect.stringMatching(/^layers\.json could not be used \(Invalid JSON\)/)]);
  });
});

describe('#133 review 6', () => {
  it('the move never stores a diagram entry whose cardinality could not be read (REL008), and says so truthfully', async () => {
    const typo = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one_to_many' };
    const a = domainJson('a', ['dim_customer', 'fct_order'], [typo]);
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/a.json': a,
      'gold/b.json': domainJson('b', ['dim_customer', 'fct_order']),
    });
    const run = await repair(p, { moveDomainsToLibrary: true });
    // Read as many-to-one from the dimension's primary key: also REL006 (a
    // unique column cannot be the many side), left as it is by the answer.
    expect(codes(run.before)).toEqual(['REL006', 'REL008']);
    expect(p.read('gold/a.json')).toBe(a);
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(run.plan.changes.map((c) => c.file)).not.toContain('gold/a.json');
    expect(run.problems).toEqual([]);
    expect(codes(run.after)).toEqual(['REL006', 'REL008']);
  });

  it('repair never removes a defaulted diagram entry as a duplicate of a good copy', async () => {
    const good = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const typo = { ...good, cardinality: 'many_to_one' };
    const a = domainJson('a', ['dim_customer', 'fct_order'], [good, typo]);
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/a.json': a,
    });
    const run = await repair(p);
    expect(codes(run.before)).toContain('REL008');
    expect(p.read('gold/a.json')).toBe(a);
    expect(messages(run.plan.left).join('\n')).toMatch(/could not be read in full/);
  });

  it('a role written as a block scalar is left exactly as written when the respell does not change it', async () => {
    const fct = `${FCT}  - fromColumn: Customer_Key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n    role: |\n      buyer\ndescription: the fact\n`;
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': fct,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const run = await repair(p);
    expect(codes(run.before)).toEqual(['REL005']);
    expect(run.problems).toEqual([]);
    expect(p.read('logical-models/fct_order.yml')).toBe(fct.replace('fromColumn: Customer_Key', 'fromColumn: customer_key'));
  });

  it('a block-scalar value that must change is refused by name, never spliced into an unparseable file', () => {
    const text = `${FCT_HEAD}\nrelationships:\n  - fromColumn: customer_key\n    toModel: |\n      dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\ndescription: x\n`;
    expect(() => editYamlRelationships(text, {
      remove: new Set(),
      update: new Map([[0, { fromColumn: 'customer_key', toModel: 'dim_client', toColumn: 'customer_key', cardinality: 'many-to-one' }]]),
      append: [],
    }, 'fct_order.yml')).toThrow(/"toModel" is written as a block/);
  });

  it('checkPlannedTexts refuses a planned text that would not parse', () => {
    const original = `${FCT_HEAD}\n`;
    const plan = {
      changes: [{ filePath: '/x/fct_order.yml', file: 'fct_order.yml', kind: 'model' as const, original, text: `${FCT_HEAD}\nrelationships:\n  - a: b\n    role: buyerdescription: x\n`, notes: [] }],
    } as unknown as RepairPlan;
    expect(checkPlannedTexts(plan)[0]).toMatch(/^fct_order\.yml would no longer read: /);
  });

  it('repair names every diagram that will start drawing a relationship it moves to the model library', async () => {
    const link = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      // Library mode: a model file already holds a relationship.
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer'], [link]),
      'gold/b.json': domainJson('b', ['fct_order', 'dim_customer'], [link]),
      'gold/c.json': domainJson('c', ['fct_order', 'dim_customer']),
    });
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.moved).toBe(1);
    expect(run.plan.alsoDrawn).toEqual([
      'gold/c.json will also draw fct_order.customer_key → dim_customer.customer_key: it holds both models, and the relationship is now in the model library',
    ]);
    expect(describeRepairPlan(run.plan)).toContain('Diagrams that will start drawing a relationship:\n• gold/c.json will also draw');
  });
});

describe('a model file the repair cannot edit in place never takes the whole run down (#133 review)', () => {
  const dateCopy = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };

  it('a link whose home lists its relationships on one line is left before any question; the unrelated REL009 fix goes ahead', async () => {
    const fct = `${FCT_HEAD}\nrelationships: [{fromColumn: date_key, toModel: dim_date, toColumn: date_key, cardinality: many-to-one}]\n`;
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/fct_order.yml': fct,
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/orders.json': domainJson('orders', ['fct_order', 'dim_date', 'dim_customer'], [dateCopy]),
    });
    const before = readRepairSnapshot(p.deps);
    expect(codes(before)).toEqual(expect.arrayContaining(['REL002', 'REL009']));
    const analysis = analyseRepair(before);
    expect(analysis.tasks).toHaveLength(1);
    expect(messages(analysis.left)).toEqual([
      'fct_order.customer_key → dim_customer.customer_key: logical-models/fct_order.yml: "relationships:" is not a list with one "- " entry per line — left as it is; change it by hand.',
    ]);
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.domainCopiesRemoved).toBe(1);
    expect(messages(run.plan.left)).toEqual(messages(analysis.left));
    expect(p.read('logical-models/fct_order.yml')).toBe(fct);
    expect(JSON.parse(p.read('gold/orders.json')).logical.relationships).toEqual([]);
    expect(codes(run.after)).toContain('REL002');
  });

  it('the move does not count a link whose home it cannot write', () => {
    const fct = `${FCT_HEAD}\nrelationships: [{fromColumn: date_key, toModel: dim_date, toColumn: date_key, cardinality: many-to-one}]\n`;
    const customerCopy = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': fct,
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/orders.json': domainJson('orders', ['fct_order', 'dim_customer'], [customerCopy]),
      'gold/billing.json': domainJson('billing', ['fct_order', 'dim_customer'], [customerCopy]),
    });
    expect(linksTheMoveStores(readRepairSnapshot(p.deps)).size).toBe(0);
  });

  it('an entry that cannot be changed in place (an alias) leaves only its own link; the other fix is written', async () => {
    const customerCopy = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const fct = `${FCT_HEAD}\n${[
      'relationships:',
      '  - fromColumn: customer_key',
      '    toModel: dim_customer',
      '    toColumn: customer_key',
      '    cardinality: &m2o many-to-one',
      '  - fromColumn: Date_Key',
      '    toModel: dim_date',
      '    toColumn: date_key',
      '    cardinality: *m2o',
    ].join('\n')}\n`;
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': fct,
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/orders.json': domainJson('orders', ['fct_order', 'dim_date', 'dim_customer'], [customerCopy]),
    });
    const run = await repair(p);
    expect(codes(run.before)).toEqual(expect.arrayContaining(['REL005', 'REL009']));
    expect(run.problems).toEqual([]);
    expect(run.plan.counts.domainCopiesRemoved).toBe(1);
    expect(run.plan.counts.respelled).toBe(0);
    expect(messages(run.plan.left)).toEqual([
      'fct_order.date_key → dim_date.date_key: logical-models/fct_order.yml: relationship entry 2: "cardinality" is not a plain value — left as it is; change it by hand.',
    ]);
    expect(p.read('logical-models/fct_order.yml')).toBe(fct);
    expect(JSON.parse(p.read('gold/orders.json')).logical.relationships).toEqual([]);
  });
});

describe('a repair never switches where new relationships are saved without saying so (#133 review)', () => {
  const own = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
  const setUp = () => project({
    'logical-models/dim_customer.yml': DIM,
    'logical-models/dim_date.yml': DIM_DATE,
    'logical-models/fct_order.yml': `${FCT_HEAD}\nrelationships:\n  - fromColumn: date_key\n    toModel: dim_gone\n    toColumn: date_key\n    cardinality: many-to-one\n`,
    'gold/orders.json': domainJson('orders', ['fct_order', 'dim_customer', 'dim_date'], [own]),
  });

  it('never takes out the model library\'s last relationship: one pointing at a missing model is listed and the mode stays', async () => {
    const p = setUp();
    const fct = p.read('logical-models/fct_order.yml');
    const run = await repair(p);
    expect(run.before.mode).toBe('library');
    expect(run.after.mode).toBe('library');
    expect(run.plan.changes).toEqual([]);
    expect(run.plan.modeChange).toBeUndefined();
    expect(run.plan.left[0].message).toContain('model dim_gone is not in the model library');
    expect(p.read('logical-models/fct_order.yml')).toBe(fct);
  });

  it('verify refuses a mode the plan did not say', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const run = await repair(p);
    expect(run.problems).toEqual([]);
    const silent: RepairPlan = { ...run.plan, expect: { ...run.plan.expect, modeAfter: 'domain' } };
    expect(verifyRepair(run.before, run.after, silent))
      .toContain('the project would switch to keeping relationships in the model library, which the plan did not say');
  });

  it('a plan that keeps the mode says nothing about it', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const run = await repair(p);
    expect(run.plan.modeChange).toBeUndefined();
    expect(run.plan.expect.modeAfter).toBe('library');
  });
});

describe('a name only in stubColumns does not put a model on the diagram (#133 review)', () => {
  it('Repair lists the REL003 the check reports for it, and changes nothing', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': `${FCT_HEAD}\n`,
      'gold/a.json': JSON.stringify({
        schemaVersion: 5, domain: 'a', layer: 'gold', stubColumns: ['dim_customer'],
        logical: { models: ['fct_order'], relationships: [rel] }, viewConfig: {},
      }, null, 2) + '\n',
    });
    const a = p.read('gold/a.json');
    const run = await repair(p);
    expect(codes(run.before)).toEqual(['REL003']);
    expect(run.plan.changes).toEqual([]);
    expect(run.plan.left[0].message).toMatch(/model dim_customer is not one of gold\/a\.json's models/);
    expect(p.read('gold/a.json')).toBe(a);
  });
});

describe('what the canvas offers, and where Open File goes', () => {
  it('describeRepairOffer counts each relationship once, by what is wrong with it', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: FCT_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const plan = planRelationshipRepair(readRepairSnapshot(p.deps));
    expect(plan.fixed).toBe(1);
    expect(describeRepairOffer(plan)).toBe(
      '1 relationship can be tidied up automatically (1 saved in the file of the model it points at; 1 spelled with different capital letters). '
      + 'Review the fixes with Repair Relationships…? Nothing changes until you confirm.',
    );
  });

  it('offers nothing when everything left needs a decision', () => {
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': `${FCT}  - fromColumn: customer_key\n    toModel: dim_client\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
    });
    const plan = planRelationshipRepair(readRepairSnapshot(p.deps));
    expect(plan.left).toHaveLength(1);
    expect(describeRepairOffer(plan)).toBeNull();
  });

  it('reportItemLine finds the entry in the file as it is now, after other entries above it moved', async () => {
    const fct = `${FCT}  - fromColumn: customer_key\n    toModel: dim_client\n    toColumn: customer_key\n    cardinality: many-to-one\n`;
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': fct,
    });
    const [item] = planRelationshipRepair(readRepairSnapshot(p.deps)).left;
    expect(reportItemLine(item)).toBe(16);
    // An entry above it goes (by hand): the item still lands on its entry.
    p.write('logical-models/fct_order.yml', fct.replace(FCT_DATE_REL, 'relationships:'));
    expect(reportItemLine(item)).toBe(11);
  });

  it('repairReportItems names unreadable entries with their file and line, after what is left', () => {
    const fct = `${FCT}  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: one_to_many\n`;
    const p = project({ 'logical-models/dim_customer.yml': DIM, 'logical-models/dim_date.yml': DIM_DATE, 'logical-models/fct_order.yml': fct });
    const snapshot = readRepairSnapshot(p.deps);
    const items = repairReportItems(planRelationshipRepair(snapshot), snapshot);
    expect(items).toEqual([expect.objectContaining({ file: 'logical-models/fct_order.yml', filePath: p.at('logical-models/fct_order.yml'), line: 16 })]);
  });
});

describe('clearForeignKeyFlags', () => {
  const text = 'name: dim\ncolumns:\n  - name: id\n    dataType: int\n    isForeignKey: true\n    isPrimaryKey: true\n  - name: other\n    isForeignKey: true\n';

  it('takes only the named column\'s flag line off', () => {
    expect(clearForeignKeyFlags(text, ['id'])).toBe(text.replace('    dataType: int\n    isForeignKey: true\n', '    dataType: int\n'));
    expect(clearForeignKeyFlags(text, [])).toBe(text);
  });

  it('refuses a flag it cannot take off in place, naming the file', () => {
    expect(() => clearForeignKeyFlags(text.replace('isForeignKey: true\n    isPrimaryKey', 'isForeignKey: true # dbt\n    isPrimaryKey'), ['id'], 'dim.yml'))
      .toThrow(/dim\.yml: column id's isForeignKey shares its line/);
    expect(() => clearForeignKeyFlags('name: dim\ncolumns:\n  - { name: id, isForeignKey: true }\n', ['id'], 'dim.yml')).toThrow(RepairEditError);
    expect(() => clearForeignKeyFlags('name: dim\ncolumns:\n  - isForeignKey: true\n    name: id\n', ['id'], 'dim.yml')).toThrow(/starts with isForeignKey/);
  });
});
