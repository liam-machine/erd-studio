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
import {
  LEAVE_AS_IS,
  RepairEditError,
  analyseRepair,
  checkPlannedTexts,
  describeRepairPlan,
  editDomainRelationships,
  editYamlRelationships,
  planRelationshipRepair,
  readRepairSnapshot,
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
