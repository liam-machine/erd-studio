/**
 * Repair Relationships… — the vscode-free engine (issue #133, R10).
 *
 * Each case builds a small project on disk, reads it with the same lookup the
 * canvas uses, plans with scripted answers, writes the planned texts and
 * holds the result to `verifyRepair`: nothing outside the relationships
 * changes, every planned finding is gone, nothing new appears, and every
 * diagram draws what it drew (except where the user chose). Then a second run
 * must have nothing left to do.
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
  LEAVE_AS_IS,
  RepairEditError,
  analyseRepair,
  checkPlannedTexts,
  describeRepairPlan,
  editDomainRelationships,
  editYamlRelationships,
  linksTheMoveStores,
  planRelationshipRepair,
  readRepairSnapshot,
  scanDomainFiles,
  verifyRepair,
  type RepairOptions,
  type RepairPlan,
  type RepairQuestion,
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

type Answer = string | undefined | ((q: RepairQuestion) => string | undefined);

interface Run {
  before: RepairSnapshot;
  plan: RepairPlan | null;
  questions: RepairQuestion[];
  problems: string[];
  after?: RepairSnapshot;
}

/** Plan with scripted answers (in order; a function decides per question), write the result, verify it. */
async function repair(p: Project, answers: Answer[] = [], options: RepairOptions = {}): Promise<Run> {
  const before = readRepairSnapshot(p.deps);
  const questions: RepairQuestion[] = [];
  const plan = await planRelationshipRepair(before, options, async (q) => {
    questions.push(q);
    const next = answers.length > 0 ? answers.shift() : LEAVE_AS_IS;
    return typeof next === 'function' ? next(q) : next;
  });
  if (!plan) return { before, plan, questions, problems: [] };
  expect(checkPlannedTexts(plan)).toEqual([]);
  for (const change of plan.changes) fs.writeFileSync(change.filePath, change.text);
  const after = readRepairSnapshot(p.deps);
  return { before, plan, questions, problems: verifyRepair(before, after, plan), after };
}

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
    expect(run.questions).toEqual([]);
    expect(run.problems).toEqual([]);
    expect(run.plan!.counts.rehomed).toBe(1);
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(p.read('logical-models/fct_order.yml')).toBe(`${FCT}${[
      '  - fromColumn: customer_key',
      '    toModel: dim_customer',
      '    toColumn: customer_key',
      '    cardinality: many-to-one',
      '    role: buyer',
    ].join('\n')}\n`);
    expect(codes(run.after!)).not.toContain('REL002');
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
    expect(codes(run.after!)).not.toContain('REL005');
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
    expect(run.questions).toEqual([]);
    expect(run.problems).toEqual([]);
    expect(p.read('logical-models/fct_order.yml')).toBe(`${FCT}${entry}  # a comment between entries stays\n`);
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(codes(run.after!)).toEqual([]);
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
    expect(run.plan!.counts.domainCopiesRemoved).toBe(1);
    expect(JSON.parse(p.read('gold/orders.json')).logical.relationships).toEqual([kept]);
    expect(p.read('logical-models/fct_order.yml')).toBe(FCT);
  });

  it('is idempotent: a second run has nothing to do', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: FCT_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const first = await repair(p);
    expect(first.problems).toEqual([]);
    expect(first.plan!.changes.length).toBeGreaterThan(0);
    const second = await repair(p);
    expect(second.plan!.changes).toEqual([]);
    expect(analyseRepair(readRepairSnapshot(p.deps)).tasks).toEqual([]);
  });

  it('describes every file and change for the preview', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const before = readRepairSnapshot(p.deps);
    const plan = (await planRelationshipRepair(before, {}, async () => LEAVE_AS_IS))!;
    const detail = describeRepairPlan(plan);
    expect(detail).toContain('• logical-models/dim_customer.yml');
    expect(detail).toContain('• logical-models/fct_order.yml');
    expect(detail).toContain('adds fct_order.customer_key → dim_customer.customer_key (many-to-one)');
  });
});

describe('questions only the user can answer', () => {
  const conflicted = (): Project => project({
    'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n    role: buyer\n`,
    'logical-models/fct_order.yml': `${FCT}  - fromColumn: customer_key   # by hand\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
    'logical-models/dim_date.yml': DIM_DATE,
  });

  it('REL001 copies that disagree: one question, the copies as options, then Leave as is', async () => {
    const p = conflicted();
    const run = await repair(p, [(q) => q.options.find((o) => o.label.includes('"buyer"'))!.id]);
    expect(run.questions).toHaveLength(1);
    expect(run.questions[0].code).toBe('REL001');
    expect(run.questions[0].options.map((o) => o.label)).toEqual([
      'fct_order.customer_key → dim_customer.customer_key (many-to-one)',
      'fct_order.customer_key → dim_customer.customer_key (many-to-one, "buyer")',
      'Leave as is',
    ]);
    expect(run.problems).toEqual([]);
    // The kept entry gains the role in place; the one-side copy goes.
    expect(p.read('logical-models/fct_order.yml')).toBe(
      `${FCT}  - fromColumn: customer_key   # by hand\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n    role: buyer\n`,
    );
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(run.plan!.counts.settled).toBe(1);
  });

  it('REL001: "Leave as is" changes nothing, and Esc cancels the whole repair', async () => {
    const p = conflicted();
    const files = ['logical-models/dim_customer.yml', 'logical-models/fct_order.yml'].map((f) => [f, p.read(f)] as const);
    const left = await repair(p, [LEAVE_AS_IS]);
    expect(left.plan!.changes).toEqual([]);
    expect(left.plan!.left[0]).toContain('its copies disagree');
    const cancelled = await repair(p, [undefined]);
    expect(cancelled.plan).toBeNull();
    for (const [f, text] of files) expect(p.read(f)).toBe(text);
  });

  it('REL003: remove, point at another model, or leave', async () => {
    const files = {
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': `${FCT}  - fromColumn: customer_key\n    toModel: dim_client\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
    };
    const removed = project(files);
    const run = await repair(removed, ['remove']);
    expect(run.questions.map((q) => q.code)).toEqual(['REL003']);
    expect(run.questions[0].options.map((o) => o.label)).toEqual([
      'Remove this relationship',
      'Point it at dim_customer.customer_key',
      'Leave as is',
    ]);
    expect(run.problems).toEqual([]);
    expect(removed.read('logical-models/fct_order.yml')).toBe(FCT);

    const repointed = project(files);
    const again = await repair(repointed, [(q) => q.options[1].id]);
    expect(again.problems).toEqual([]);
    expect(repointed.read('logical-models/fct_order.yml')).toBe(
      `${FCT}  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
    );

    const left = project(files);
    const third = await repair(left, [LEAVE_AS_IS]);
    expect(third.plan!.changes).toEqual([]);
  });

  it('REL004: offers the model\'s columns, nearest first', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}  - name: customer_name\n    dataType: string\n`,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': `${FCT}  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer\n    cardinality: many-to-one\n`,
    });
    const run = await repair(p, [(q) => q.options.find((o) => o.label === 'Point it at dim_customer.customer_key')!.id]);
    expect(run.questions[0].code).toBe('REL004');
    // The model's own spelling, never capitalised into a name that does not exist.
    expect(run.questions[0].prompt).toBe('Model dim_customer has no column customer. What should happen to this relationship? (Esc cancels everything)');
    expect(run.questions[0].prompt).not.toContain('Dim_customer');
    expect(run.questions[0].options.map((o) => o.label)).toEqual([
      'Remove this relationship',
      'Point it at dim_customer.customer_key',
      'Point it at dim_customer.customer_name',
      'Leave as is',
    ]);
    expect(run.problems).toEqual([]);
    expect(p.read('logical-models/fct_order.yml')).toContain('    toColumn: customer_key\n    cardinality: many-to-one\n');
  });

  it('REL006: swapping the ends moves the relationship to the model the keys say holds the foreign key', async () => {
    const fct = FCT.replace('  - name: customer_key\n    dataType: string', '  - name: customer_key\n    dataType: string\n    isForeignKey: true');
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': fct,
    });
    const run = await repair(p, ['swap']);
    expect(run.questions.map((q) => q.code)).toEqual(['REL006']);
    expect(run.questions[0].options[0].label).toBe('Swap ends — make fct_order the many side');
    expect(run.problems).toEqual([]);
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(p.read('logical-models/fct_order.yml')).toContain('  - fromColumn: customer_key\n    toModel: dim_customer\n');
    expect(codes(run.after!)).not.toContain('REL006');
  });

  it('REL006: a 1.6.7 dim → fact line on an unflagged fact column is offered the swap and lands in the fact\'s file', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT,
    });
    expect(codes(readRepairSnapshot(p.deps))).toEqual(['REL006']);
    const run = await repair(p, ['swap']);
    expect(run.questions.map((q) => q.code)).toEqual(['REL006']);
    expect(run.problems).toEqual([]);
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    expect(p.read('logical-models/fct_order.yml')).toContain('  - fromColumn: customer_key\n    toModel: dim_customer\n');
    expect(codes(run.after!)).toEqual([]);
  });

  it('REL006: a swap that would take out a commented entry is left, and the respelling still goes ahead (a second run does nothing)', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key   # hand note\n    toModel: FCT_ORDER\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT,
    });
    const run = await repair(p, ['swap']);
    expect(run.problems).toEqual([]);
    expect(run.plan!.left.join(' ')).toMatch(/the keys suggest the other direction, but .*which turning it round would remove/);
    expect(p.read('logical-models/dim_customer.yml')).toContain('  - fromColumn: customer_key   # hand note\n    toModel: fct_order\n');
    const second = await repair(p, []);
    expect(second.plan?.changes ?? []).toEqual([]);
  });

  it('REL006: the file a swap writes is among the files checked for unsaved edits before any question', async () => {
    const fct = FCT.replace('  - name: customer_key\n    dataType: string', '  - name: customer_key\n    dataType: string\n    isForeignKey: true');
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': fct,
    });
    const analysis = analyseRepair(readRepairSnapshot(p.deps));
    const run = await repair(p, ['swap']);
    const written = run.plan!.changes.map((c) => c.filePath);
    expect(written).toContain(p.at('logical-models/fct_order.yml'));
    for (const file of written) expect(analysis.involvedFiles).toContain(file);
  });

  it('REL003 on the from side: the model file a repoint makes the home is checked for unsaved edits before any question', async () => {
    const gone = { fromModel: 'fct_ordr', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT,
      'gold/a.json': domainJson('a', ['fct_ordr', 'dim_customer'], [gone]),
      'gold/b.json': domainJson('b', ['fct_ordr', 'dim_customer'], [gone]),
    });
    const snapshot = readRepairSnapshot(p.deps);
    expect(snapshot.mode).toBe('library');
    const analysis = analyseRepair(snapshot);
    expect(analysis.tasks.some((t) => t.scope === 'library')).toBe(true);
    const run = await repair(p, [(q) => q.options.find((o) => o.label.includes('fct_order'))!.id]);
    expect(run.questions.map((q) => q.code)).toEqual(['REL003']);
    const written = run.plan!.changes.map((c) => c.filePath);
    expect(written).toContain(p.at('logical-models/fct_order.yml'));
    for (const file of written) expect(analysis.involvedFiles).toContain(file);
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
    expect(analysis.blocked[0]).toContain('could not be read in full');
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

  it('per-domain project: copies that disagree in one file store the pick, in the copy carrying its own keys', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const picked = { ...rel, cardinality: 'one-to-one', description: 'KEEP ME' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer'], [rel, picked]),
    });
    const run = await repair(p, [(q) => q.options.find((o) => o.label.includes('one-to-one'))!.id]);
    expect(run.questions.map((q) => q.code)).toEqual(['REL001']);
    expect(run.problems).toEqual([]);
    expect(run.plan!.counts.settled).toBe(1);
    expect(JSON.parse(p.read('gold/a.json')).logical.relationships).toEqual([picked]);

    // And picking the other copy keeps that one's meaning, with the extras of the entry kept.
    const q = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer'], [rel, picked]),
    });
    const other = await repair(q, [(question) => question.options.find((o) => o.label.includes('(many-to-one)'))!.id]);
    expect(other.problems).toEqual([]);
    expect(JSON.parse(q.read('gold/a.json')).logical.relationships).toEqual([{ ...rel, description: 'KEEP ME' }]);
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
  it('asks once about a relationship two diagrams define differently, then stores the pick once', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer'], [rel]),
      'gold/b.json': domainJson('b', ['fct_order', 'dim_customer'], [{ ...rel, cardinality: 'one-to-one' }]),
    });
    const run = await repair(p, [(q) => q.options.find((o) => o.label.includes('one-to-one'))!.id], { moveDomainsToLibrary: true });
    expect(run.questions).toHaveLength(1);
    expect(run.questions[0].options.map((o) => o.description)).toEqual(['as in gold/a', 'as in gold/b', 'decide later']);
    expect(run.problems).toEqual([]);
    expect(JSON.parse(p.read('gold/a.json')).logical.relationships).toEqual([]);
    expect(JSON.parse(p.read('gold/b.json')).logical.relationships).toEqual([]);
    expect(p.read('logical-models/fct_order.yml')).toBe(
      `${FCT_HEAD}\nrelationships:\n  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: one-to-one\n`,
    );
    expect(run.plan!.counts.moved).toBe(1);
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
    const plan = (await planRelationshipRepair(before, {}, async () => LEAVE_AS_IS))!;
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
    const plan = (await planRelationshipRepair(before, {}, async () => LEAVE_AS_IS))!;
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
    expect(run.plan!.counts.domainCopiesRemoved).toBe(1);
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
    const plan = (await planRelationshipRepair(before, {}, async () => LEAVE_AS_IS))!;
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
    expect(analysis.outOfReach).toEqual([
      expect.stringMatching(/^gold\/legacy\.json has 1 relationship problem but is still in the older format .*Migrate Domains to Central Model Store/),
    ]);
  });

  it('a domain file that cannot be read is out of reach, named', () => {
    const p = project({ 'logical-models/dim_customer.yml': DIM, 'gold/broken.json': '{ "nope' });
    const analysis = analyseRepair(readRepairSnapshot(p.deps));
    expect(analysis.outOfReach).toEqual([expect.stringMatching(/^gold\/broken\.json was not checked: it could not be read/)]);
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
    const run = await repair(p, [], { moveDomainsToLibrary: true });
    expect(run.questions).toEqual([]);
    expect(run.problems).toEqual([]);
    expect(run.plan!.counts.moved).toBe(1);
    expect(run.plan!.left).toEqual([
      expect.stringMatching(/^fct_order\.customer_code → dim_customer\.customer_code: left in gold\/a\.json — it uses dim_customer\.customer_code, which dim_customer's model file does not list/),
    ]);
    expect(JSON.parse(p.read('gold/a.json')).logical.relationships).toEqual([stubbed]);
    expect(p.read('logical-models/fct_order.yml')).toContain('toModel: dim_date');
  });
});

describe('two questions never both repoint onto one new link', () => {
  it('once one relationship is pointed at a column, the next question no longer offers it', async () => {
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': `${FCT}  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: cust_key\n    cardinality: many-to-one\n  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: custkey\n    cardinality: many-to-one\n`,
    });
    const target = 'Point it at dim_customer.customer_key';
    const run = await repair(p, [
      (q) => q.options.find((o) => o.label === target)!.id,
      (q) => q.options.find((o) => o.label === target)?.id ?? 'remove',
    ]);
    expect(run.questions).toHaveLength(2);
    expect(run.questions[0].options.map((o) => o.label)).toContain(target);
    expect(run.questions[1].options.map((o) => o.label)).not.toContain(target);
    expect(run.problems).toEqual([]);
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
    expect(run.plan!.outOfReach.join(' ')).toContain('silver/legacy.json');
  });

  it('an entry the user chose to remove takes its own keys with it — and verification still guards every other entry\'s', async () => {
    const fct = `${FCT}  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: no_such_column\n    cardinality: many-to-one\n    description: kept by hand\n`;
    const p = project({ 'logical-models/dim_customer.yml': DIM, 'logical-models/fct_order.yml': fct, 'logical-models/dim_date.yml': DIM_DATE });
    const run = await repair(p, ['remove']);
    expect(run.questions.map((q) => q.code)).toEqual(['REL004']);
    expect(run.problems).toEqual([]);
    expect(p.read('logical-models/fct_order.yml')).toBe(FCT);
    // The other entry's own key (`note`) is still guarded: a plan that took it out is reported.
    const lost = { ...run.plan!, expect: { ...run.plan!.expect } };
    const change = lost.changes.find((c) => c.file === 'logical-models/fct_order.yml')!;
    const tampered = { ...change, text: change.text.replace('    note: an unknown key the repair must keep\n', '') };
    fs.writeFileSync(change.filePath, tampered.text);
    const after = readRepairSnapshot(p.deps);
    expect(verifyRepair(run.before, after, { ...lost, changes: [tampered] })).toContain('logical-models/fct_order.yml: an entry\'s own key note is gone');
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
    expect(run.plan!.changes).toEqual([]);
    expect(run.plan!.left.join(' ')).toMatch(/logical-models\/dim_customer\.yml entry 1 has its own keys description, tests and comments, which this change would remove — left as it is/);
    expect(p.read('logical-models/dim_customer.yml')).toBe(dim);
  });

  it('the move never drops a domain entry\'s own keys', async () => {
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/orders.json': domainJson('orders', ['fct_order', 'dim_customer'], [{ ...CUSTOMER_REL, description: 'd1', label: 'L' }]),
    });
    const run = await repair(p, [], { moveDomainsToLibrary: true });
    expect(run.plan!.changes).toEqual([]);
    expect(run.plan!.left.join(' ')).toContain('gold/orders.json entry 1 has its own keys description, label');
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
    expect(run.plan!.changes).toEqual([]);
    expect(p.read('logical-models/fct_order.yml')).toBe(fct);

    const domain = domainJson('orders', ['fct_order', 'dim_customer'], [{ ...CUSTOMER_REL, toModel: 'DIM_customer', role: long }]);
    const q = project({
      'logical-models/dim_customer.yml': DIM, 'logical-models/fct_order.yml': FCT_HEAD + '\n', 'logical-models/dim_date.yml': DIM_DATE,
      'gold/orders.json': domain,
    });
    const moved = await repair(q, [], { moveDomainsToLibrary: true });
    expect(moved.plan!.changes).toEqual([]);
    expect(q.read('gold/orders.json')).toBe(domain);
  });

  it('REL003: a diagram\'s own relationship to a model the diagram does not hold is asked about, and repointed only within it', async () => {
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/dim_date.yml': DIM_DATE,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/orders.json': domainJson('orders', ['fct_order', 'dim_date'], [CUSTOMER_REL]),
    });
    const before = readRepairSnapshot(p.deps);
    expect(before.mode).toBe('domain');
    expect(before.findings.map((f) => f.code)).toEqual(['REL003']);
    const run = await repair(p, ['remove']);
    expect(run.questions.map((q) => q.code)).toEqual(['REL003']);
    expect(run.questions[0].prompt).toMatch(/^Model dim_customer is not one of gold\/orders\.json's models/);
    // No "point it at" choice outside the diagram (dim_customer is the only model with that column).
    expect(run.questions[0].options.map((o) => o.id)).toEqual(['remove', LEAVE_AS_IS]);
    expect(run.problems).toEqual([]);
    expect(JSON.parse(p.read('gold/orders.json')).logical.relationships).toEqual([]);
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
    const run = await repair(p, [], { moveDomainsToLibrary: true });
    expect(run.questions).toEqual([]);
    expect(run.problems).toEqual([]);
    expect(run.plan!.counts.moved).toBe(1);
    expect(run.plan!.left).toEqual([
      expect.stringMatching(/^fct_order\.date_key → dim_ghost\.ghost_key: left in gold\/a\.json — it points at dim_ghost, which has no readable file in logical-models\//),
    ]);
    expect(JSON.parse(p.read('gold/a.json')).logical.relationships).toEqual([ghost]);
    expect(p.read('logical-models/fct_order.yml')).toContain('toModel: dim_customer');
  });

  it('a link with an empty column is left up front: a model file cannot hold it', async () => {
    const empty = { ...good, fromColumn: 'date_key', toColumn: '' };
    const p = project(base([good, empty], [good]));
    expect([...linksTheMoveStores(readRepairSnapshot(p.deps))]).toHaveLength(1);
    const run = await repair(p, [], { moveDomainsToLibrary: true });
    expect(run.problems).toEqual([]);
    expect(run.plan!.counts.moved).toBe(1);
    expect(run.plan!.left).toEqual([expect.stringMatching(/its toColumn is empty, which a model file cannot hold/)]);
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
    const run = await repair(p, [], { moveDomainsToLibrary: true });
    expect(run.problems).toEqual([]);
    expect(run.plan!.counts).toMatchObject({ moved: 1, left: 1, noHome: 1 });
    expect(run.plan!.left).toEqual([
      'stg_x.customer_key → dim_customer.customer_key: stg_x has no readable file in logical-models/, so it stays where it is.',
    ]);
    expect(describeRepairPlan(run.plan!)).toContain('stg_x has no readable file in logical-models/');
    expect(JSON.parse(p.read('gold/a.json')).logical.relationships).toEqual([stray]);
  });

  it('copies that disagree with no home are not asked about, and count as left, never as settled', async () => {
    const stray = { fromModel: 'stg_x', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer', 'stg_x'], [good, stray]),
      'gold/b.json': domainJson('b', ['fct_order', 'dim_customer', 'stg_x'], [good, { ...stray, cardinality: 'many-to-many' }]),
    });
    const run = await repair(p, [(q) => q.options[0].id], { moveDomainsToLibrary: true });
    expect(run.questions).toEqual([]);
    expect(run.problems).toEqual([]);
    expect(run.plan!.counts).toMatchObject({ moved: 1, settled: 0, left: 1, noHome: 1 });
    expect(run.plan!.expect.userChanged.size).toBe(0);
  });

  it('a conflict picked, then left for want of a home, takes back its "settled" count', async () => {
    // A library project with the link in two diagram files, from a model that
    // has no file (REL003): the pick is asked, then the endpoint, and with
    // "Leave as is" there the link has nowhere to go.
    const stray = { fromModel: 'stg_x', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': `${FCT_HEAD}\nrelationships:\n  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one\n`,
      'gold/a.json': domainJson('a', ['dim_customer', 'stg_x'], [stray]),
      'gold/b.json': domainJson('b', ['dim_customer', 'stg_x'], [{ ...stray, cardinality: 'many-to-many' }]),
    });
    expect(readRepairSnapshot(p.deps).mode).toBe('library');
    const run = await repair(p, [(q) => q.options[0].id, LEAVE_AS_IS]);
    expect(run.questions.map((q) => q.kind)).toEqual(['conflict', 'endpoint']);
    expect(run.problems).toEqual([]);
    expect(run.plan!.changes).toEqual([]);
    expect(run.plan!.counts).toMatchObject({ settled: 0, left: 1 });
    expect(run.plan!.left).toEqual(['stg_x.customer_key → dim_customer.customer_key: stg_x has no readable file in logical-models/, so it stays where it is.']);
    expect(run.plan!.expect.userChanged.size).toBe(0);
  });
});

describe('review findings (#133): repoint in a per-diagram project', () => {
  it('offers the obvious repoint although another diagram holds that link: each diagram keeps its own copy', async () => {
    const right = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/a.json': domainJson('a', ['fct_order', 'dim_customer'], [right]),
      'gold/b.json': domainJson('b', ['fct_order', 'dim_customer'], [{ ...right, toColumn: 'cust_key' }]),
    });
    expect(readRepairSnapshot(p.deps).mode).toBe('domain');
    const run = await repair(p, [(q) => q.options.find((o) => o.id.startsWith('repoint:'))?.id ?? LEAVE_AS_IS]);
    expect(run.questions[0].options.map((o) => o.label)).toEqual([
      'Remove this relationship', 'Point it at dim_customer.customer_key', 'Leave as is',
    ]);
    expect(run.problems).toEqual([]);
    expect(JSON.parse(p.read('gold/b.json')).logical.relationships).toEqual([right]);
    expect(run.after!.findings).toEqual([]);
  });

  it('still never repoints onto a link the same diagram file already holds', async () => {
    const right = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'gold/b.json': domainJson('b', ['fct_order', 'dim_customer'], [right, { ...right, toColumn: 'cust_key' }]),
    });
    const run = await repair(p);
    expect(run.questions[0].options.map((o) => o.label)).toEqual(['Remove this relationship', 'Leave as is']);
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
    expect(analysis.outOfReach).toEqual([
      expect.stringMatching(/^logical-models\/fct_order\.yml was not checked: it has a YAML error on line \d+, so the relationships in it were not looked at/),
    ]);
  });

  it('a layers.json that cannot be used is out of reach', () => {
    const p = project({ 'logical-models/dim_customer.yml': DIM });
    const analysis = analyseRepair(readRepairSnapshot({ ...p.deps, layerService: { getLoadError: () => 'Invalid JSON' } }));
    expect(analysis.outOfReach).toEqual([expect.stringMatching(/^layers\.json could not be used \(Invalid JSON\)/)]);
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
    const run = await repair(p, [], { moveDomainsToLibrary: true });
    // Read as many-to-one from the dimension's primary key: also REL006 (a
    // unique column cannot be the many side), left as it is by the answer.
    expect(codes(run.before)).toEqual(['REL006', 'REL008']);
    expect(p.read('gold/a.json')).toBe(a);
    expect(p.read('logical-models/dim_customer.yml')).toBe(DIM);
    if (run.plan) {
      expect(run.plan.changes.map((c) => c.file)).not.toContain('gold/a.json');
      expect(run.problems).toEqual([]);
      expect(codes(run.after!)).toEqual(['REL006', 'REL008']);
    }
  });

  it('a direction question never claims swapping is right: the link may be a one-to-one (#133 review 8)', async () => {
    const typo = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': FCT_HEAD + '\n',
      'logical-models/dim_date.yml': DIM_DATE,
      'gold/a.json': domainJson('a', ['dim_customer', 'fct_order'], [typo]),
    });
    const run = await repair(p);
    const question = run.questions.find((q) => q.code === 'REL006');
    expect(question?.prompt).toBe(
      'The keys do not fit this relationship\'s direction. Swap its ends if it runs the other way; '
      + 'if both sides are unique, leave it and make it one-to-one on the canvas. (Esc cancels everything)',
    );
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
    if (run.plan) expect(run.plan.left.join('\n')).toMatch(/could not be read in full/);
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
    expect(run.plan!.counts.moved).toBe(1);
    expect(run.plan!.alsoDrawn).toEqual([
      'gold/c.json will also draw fct_order.customer_key → dim_customer.customer_key: it holds both models, and the relationship is now in the model library',
    ]);
    expect(describeRepairPlan(run.plan!)).toContain('Diagrams that will start drawing a relationship:\n• gold/c.json will also draw');
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
    expect(analysis.blocked).toEqual([
      'fct_order.customer_key → dim_customer.customer_key: logical-models/fct_order.yml: "relationships:" is not a list with one "- " entry per line — left as it is; change it by hand.',
    ]);
    const run = await repair(p);
    expect(run.plan).not.toBeNull();
    expect(run.problems).toEqual([]);
    expect(run.plan!.counts.domainCopiesRemoved).toBe(1);
    expect(run.plan!.left).toEqual(analysis.blocked);
    expect(p.read('logical-models/fct_order.yml')).toBe(fct);
    expect(JSON.parse(p.read('gold/orders.json')).logical.relationships).toEqual([]);
    expect(codes(run.after!)).toContain('REL002');
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
    expect(run.plan).not.toBeNull();
    expect(run.problems).toEqual([]);
    expect(run.plan!.counts.domainCopiesRemoved).toBe(1);
    expect(run.plan!.counts.respelled).toBe(0);
    expect(run.plan!.left).toEqual([
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

  it('removing the last model-library relationship while a diagram keeps its own is named in the preview, and verify holds it to that', async () => {
    const p = setUp();
    const run = await repair(p, ['remove']);
    expect(run.before.mode).toBe('library');
    expect(run.after!.mode).toBe('domain');
    expect(run.problems).toEqual([]);
    expect(run.plan!.modeChange).toMatch(/goes back to keeping relationships in each diagram's file/);
    expect(describeRepairPlan(run.plan!)).toContain('Where new relationships are saved: After this no model file holds a relationship');
  });

  it('verify refuses a mode the plan did not say', async () => {
    const p = setUp();
    const run = await repair(p, ['remove']);
    const silent: RepairPlan = { ...run.plan!, expect: { ...run.plan!.expect, modeAfter: 'library' } };
    expect(verifyRepair(run.before, run.after!, silent))
      .toContain("the project would go back to keeping relationships in each diagram's file, which the plan did not say");
  });

  it('a plan that keeps the mode says nothing about it', async () => {
    const p = project({
      'logical-models/dim_customer.yml': `${DIM}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`,
      'logical-models/fct_order.yml': FCT,
      'logical-models/dim_date.yml': DIM_DATE,
    });
    const run = await repair(p);
    expect(run.plan!.modeChange).toBeUndefined();
    expect(run.plan!.expect.modeAfter).toBe('library');
  });
});

describe('a name only in stubColumns does not put a model on the diagram (#133 review)', () => {
  it('Repair asks about the REL003 check reports for it, and removing it verifies', async () => {
    const rel = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    const p = project({
      'logical-models/dim_customer.yml': DIM,
      'logical-models/fct_order.yml': `${FCT_HEAD}\n`,
      'gold/a.json': JSON.stringify({
        schemaVersion: 5, domain: 'a', layer: 'gold', stubColumns: ['dim_customer'],
        logical: { models: ['fct_order'], relationships: [rel] }, viewConfig: {},
      }, null, 2) + '\n',
    });
    const run = await repair(p, ['remove']);
    expect(codes(run.before)).toEqual(['REL003']);
    expect(run.questions).toHaveLength(1);
    expect(run.questions[0].prompt).toMatch(/not one of gold\/a\.json's models/);
    expect(run.problems).toEqual([]);
    expect(codes(run.after!)).toEqual([]);
  });
});
