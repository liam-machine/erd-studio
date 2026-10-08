/**
 * Relationship journeys, end to end (issue #133) — part 2: files written by
 * something other than this version's canvas.
 *
 * 4. The issue reporter: a model library written by ERD Studio 1.6.7 is
 *    opened after the upgrade — notification, one Repair, a clean check, a
 *    second Repair that does nothing.
 * 5. A teammate still on 1.6.7 rewrites a model file (dropping `role:`) and
 *    draws a new relationship the old way round.
 * 6. An AI assistant writes relationships by hand from the harness rules,
 *    with one classic mistake (`one-to-many` on the dimension).
 * 7. Two branches add the same link from opposite ends and are merged.
 * 8. Draw from dbt / Add models from dbt over a `relationships` test
 *    declared on the parent (the dimension).
 *
 * Same harness as part 1 (journeys.relationships.harness.ts): the real host,
 * real services on a temp project, `erd-studio check` in-process and the
 * Repair Relationships… runner with its preview accepted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import { UNDO_BARRIER_MESSAGE } from '../../src/providers/SemanticEditorProvider';
import { describeRepairOffer, planRelationshipRepair, readRepairSnapshot } from '../../src/services/relationshipRepair';
import { HarnessService } from '../../src/services/harnessService';
import { drawFromDbt } from '../../src/commands/drawFromDbt';
import { repairRelationships } from '../../src/commands/repairRelationships';
import { relationshipSwap } from '@erd-studio/renderer/editor';
import { YmlParserService } from '../../src/services/ymlParserService';
import { LayerService } from '../../src/services/layerService';
import type { DisplayDomain } from '../../src/types/display';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import { main } from '../../src/cli/index';
import { linkKey } from '@erd-studio/core';
import {
  SEMANTIC_DIR,
  createJourney,
  entryYaml,
  modelYaml,
  plainDrawn,
  sortDrawn,
  type Drawn,
  type Journey,
  type Panel,
} from './journeys.relationships.harness';

const picker = vi.hoisted(() => ({ modelNames: [] as string[] }));
vi.mock('../../src/providers/dbtDraftPicker', () => ({
  pickDraftScope: async () => ({ scope: { label: 'marts', suggestedLayer: 'gold' }, modelNames: picker.modelNames }),
}));

let j: Journey;
beforeEach(() => {
  _resetMockWorkspace();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  j?.dispose();
});

const many = (fromModel: string, fromColumn: string, toModel: string, toColumn: string, role?: string): Drawn =>
  ({ fromModel, fromColumn, toModel, toColumn, cardinality: 'many-to-one', ...(role ? { role } : {}) });

/** What Repair Relationships… would offer on its own right now (the notification's own question, D11). */
function repairOffer(journey: Journey): string | null {
  journey.models.invalidateCache();
  return describeRepairOffer(planRelationshipRepair(readRepairSnapshot({
    workspaceRoot: journey.root,
    semanticDir: SEMANTIC_DIR,
    domainService: journey.domainService,
    logicalModelService: journey.models,
  })));
}

/** Codes of the issues on the canvas line between two columns. */
function lineIssues(panel: Panel, a: string, b: string): string[] {
  const ends = (r: { fromModel: string; fromColumn: string; toModel: string; toColumn: string }) => [`${r.fromModel}.${r.fromColumn}`, `${r.toModel}.${r.toColumn}`];
  const found = panel.loaded().relationships.find((r) => ends(r).includes(a) && ends(r).includes(b));
  if (!found) throw new Error(`no line ${a} — ${b}`);
  return found.issues ?? [];
}

const FCT_COLUMNS = [{ name: 'order_key', pk: true }, 'customer_key', 'product_key', 'date_key'] as const;
const DIM_DATE = modelYaml('dim_date', [{ name: 'date_key', pk: true }]);
const DIM_PRODUCT = modelYaml('dim_product', [{ name: 'product_key', pk: true }, 'product_name']);
const DIM_CUSTOMER = modelYaml('dim_customer', [{ name: 'customer_key', pk: true }, 'customer_name']);

describe('journey 4 — the issue reporter upgrades a library written by 1.6.7', () => {
  // What 1.6.7 left behind: a line drawn from the dimension saved in the
  // dimension's file the wrong way round, with Draw from dbt's stray
  // isForeignKey on the dimension's key; a one-to-many saved on the dimension;
  // and the same relationship saved twice on the fact.
  const DIM_CUSTOMER_167 = `${modelYaml('dim_customer', [{ name: 'customer_key', pk: true, fk: true }, 'customer_name'])}relationships:\n` +
    entryYaml('customer_key', 'fct_order', 'customer_key', 'many-to-one');
  const DIM_PRODUCT_167 = `${DIM_PRODUCT}relationships:\n${entryYaml('product_key', 'fct_order', 'product_key', 'one-to-many')}`;
  const FCT_167 = `${modelYaml('fct_order', [...FCT_COLUMNS])}relationships:\n` +
    entryYaml('date_key', 'dim_date', 'date_key', 'many-to-one') +
    entryYaml('date_key', 'dim_date', 'date_key', 'many-to-one');

  it('the notification offers Repair; one confirm fixes everything automatic; check is clean; a second Repair does nothing', async () => {
    j = createJourney({
      models: { dim_customer: DIM_CUSTOMER_167, dim_product: DIM_PRODUCT_167, fct_order: FCT_167, dim_date: DIM_DATE },
      domains: {
        'gold/orders': { models: ['fct_order', 'dim_customer', 'dim_product', 'dim_date'] },
        'silver/sales': { models: ['fct_order', 'dim_customer'] },
      },
    });

    // The new version reads 1.6.7's files without changing a byte.
    const before = j.files();
    const findings = await j.check();
    expect(findings.result.mode).toBe('library');
    expect([...findings.codes].sort()).toEqual(['REL001', 'REL002', 'REL006']);
    expect(findings.findings.find((f) => f.code === 'REL001')).toMatchObject({ severity: 'warning', files: ['.erd-studio/logical-models/fct_order.yml'] });
    // REL002 names the file it is in and the file it belongs in.
    expect(findings.findings.find((f) => f.code === 'REL002')).toMatchObject({
      severity: 'warning', files: ['.erd-studio/logical-models/dim_product.yml', '.erd-studio/logical-models/fct_order.yml'],
    });
    expect(findings.findings.find((f) => f.code === 'REL006')).toMatchObject({ severity: 'info', files: ['.erd-studio/logical-models/dim_customer.yml'] });
    // Warnings and notes do not fail a plain run; --strict counts the warnings.
    expect(findings.code).toBe(0);
    expect((await j.check(true)).code).toBe(1);

    // Opening the diagram: three lines (the duplicate drawn once), each badged; the notification offers Repair.
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const orders = await j.open('gold/orders');
    await orders.send({ type: 'ready' });
    expect(orders.drawn()).toHaveLength(3);
    expect(lineIssues(orders, 'fct_order.date_key', 'dim_date.date_key')).toEqual(['REL001']);
    expect(lineIssues(orders, 'fct_order.product_key', 'dim_product.product_key')).toEqual(['REL002']);
    expect(lineIssues(orders, 'fct_order.customer_key', 'dim_customer.customer_key')).toEqual(['REL006']);
    const offers = info.mock.calls.filter((c) => c.includes('Repair Relationships…'));
    expect(offers).toHaveLength(1);
    expect(String(offers[0][0])).toMatch(/^3 relationships can be tidied up automatically \(/);
    expect(String(offers[0][0])).toContain('Nothing changes until you confirm.');
    expect(j.files()).toEqual(before);
    info.mockRestore();

    // Repair: one preview, one confirm.
    const repair = await j.repair();
    expect(repair.errors).toEqual([]);
    expect(repair.title).toBe('Repair Relationships: change 3 files?');
    expect(repair.detail).toContain('• logical-models/dim_customer.yml');
    expect(repair.detail).toContain('• logical-models/dim_product.yml');
    expect(repair.detail).toContain('• logical-models/fct_order.yml');
    expect(repair.detail).toContain('takes isForeignKey off dim_customer.customer_key');

    // On disk: every relationship on the fact, once; the dimensions back to plain models, stray FK flag gone.
    expect(j.modelText('dim_customer')).toBe(DIM_CUSTOMER);
    expect(j.modelText('dim_product')).toBe(DIM_PRODUCT);
    expect(j.modelText('dim_date')).toBe(DIM_DATE);
    const fct = j.modelText('fct_order');
    expect(fct.startsWith(`${modelYaml('fct_order', [...FCT_COLUMNS])}relationships:\n`)).toBe(true);
    j.models.invalidateCache();
    expect(sortDrawn((j.models.getModel('fct_order')?.relationships ?? []).map((r) => ({ ...r, fromModel: 'fct_order' }) as Drawn))).toEqual(sortDrawn([
      many('fct_order', 'customer_key', 'dim_customer', 'customer_key'),
      many('fct_order', 'product_key', 'dim_product', 'product_key'),
      many('fct_order', 'date_key', 'dim_date', 'date_key'),
    ]));
    expect(j.domainJson('gold/orders').logical.relationships).toEqual([]);

    // The open diagram was refreshed: same three lines, now all from the fact, no badges, no banner.
    const loaded = orders.loaded();
    expect(sortDrawn(loaded.relationships.map(plainDrawn))).toEqual(sortDrawn([
      many('fct_order', 'customer_key', 'dim_customer', 'customer_key'),
      many('fct_order', 'product_key', 'dim_product', 'product_key'),
      many('fct_order', 'date_key', 'dim_date', 'date_key'),
    ]));
    expect(loaded.relationships.every((r) => !r.issues?.length)).toBe(true);
    expect(loaded.relationshipIssues ?? []).toEqual([]);
    expect(j.drawnOnDisk('silver/sales')).toEqual([many('fct_order', 'customer_key', 'dim_customer', 'customer_key')]);

    const after = await j.check(true);
    expect(after.code).toBe(0);
    expect(after.findings).toEqual([]);
    expect(j.schemaProblems()).toEqual([]);

    // Undo on the open diagram stops before the repair's disk write.
    const repaired = j.files();
    await orders.send({ type: 'undo' });
    expect(orders.errors()).toEqual([UNDO_BARRIER_MESSAGE]);
    expect(j.files()).toEqual(repaired);

    // A second Repair finds nothing, and no notification would be offered again.
    const again = await j.repair();
    expect(again.title).toBeUndefined();
    expect(again.messages).toEqual(['Repair Relationships: nothing to repair — every relationship is stored once, in its home.']);
    expect(j.files()).toEqual(repaired);
    expect(repairOffer(j)).toBeNull();
  });
});

describe('journey 4b — the same upgrade, accepted from the notification itself', () => {
  it('"Repair Relationships…" on the notification runs the command, whose preview is the only confirm', async () => {
    j = createJourney({
      models: {
        dim_product: `${DIM_PRODUCT}relationships:\n${entryYaml('product_key', 'fct_order', 'product_key', 'one-to-many')}`,
        fct_order: modelYaml('fct_order', [...FCT_COLUMNS]),
      },
      domains: { 'gold/orders': { models: ['fct_order', 'dim_product'] } },
    });
    const command = vscode.commands.registerCommand('erdStudio.repairRelationships', () => repairRelationships({
      workspaceRoot: j.root, semanticDir: SEMANTIC_DIR, domainService: j.domainService, logicalModelService: j.models,
      onWritten: async () => { j.provider.markFilesRewrittenOnDisk(); await j.provider.refreshAllOpenDomains(); },
    }));
    const asked: string[] = [];
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
      asked.push(String(args[0]));
      const options = args[1] as { modal?: boolean } | undefined;
      if (options && typeof options === 'object' && options.modal) return args[args.length - 1];
      return args.includes('Repair Relationships…') ? 'Repair Relationships…' : undefined;
    }) as never);
    try {
      const orders = await j.open('gold/orders');
      await orders.send({ type: 'ready' });
      await new Promise((r) => setTimeout(r, 20));
      expect(asked[0]).toMatch(/^1 relationship can be tidied up automatically \(1 saved in the file of the model it points at\)/);
      expect(asked[1]).toBe('Repair Relationships: change 2 files?');
      expect(j.modelText('dim_product')).toBe(DIM_PRODUCT);
      expect(j.modelText('fct_order')).toBe(`${modelYaml('fct_order', [...FCT_COLUMNS])}relationships:\n${entryYaml('product_key', 'dim_product', 'product_key', 'many-to-one')}`);
      expect(orders.drawn()).toEqual([many('fct_order', 'product_key', 'dim_product', 'product_key')]);
      expect(orders.loaded().relationships[0].issues ?? []).toEqual([]);
      expect((await j.check(true)).findings).toEqual([]);
    } finally {
      command.dispose();
    }
  });
});

describe('journey 4c — a per-diagram project 1.6.7 drew the wrong way round', () => {
  it('check notes it, Repair lists it without writing, and ⇄ on the line fixes it in the diagram file', async () => {
    const BACKWARDS = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' };
    j = createJourney({
      models: { fct_order: modelYaml('fct_order', [...FCT_COLUMNS]), dim_customer: DIM_CUSTOMER },
      domains: { 'gold/orders': { models: ['fct_order', 'dim_customer'], relationships: [BACKWARDS] } },
    });
    const check = await j.check();
    expect(check.result.mode).toBe('domain');
    expect(check.code).toBe(0);
    expect(check.findings).toEqual([{ code: 'REL006', severity: 'info', files: ['.erd-studio/gold/orders.json'] }]);

    const before = j.files();
    const repair = await j.repair();
    expect(j.files()).toEqual(before);
    // Listed, with what to do (the message's Open File goes to the entry).
    expect(repair.title).toBeUndefined();
    expect(repair.messages).toEqual([expect.stringContaining('dim_customer.customer_key → fct_order.customer_key: the keys suggest it runs the other way — if so, use ⇄ on the canvas')]);

    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const orders = await j.open('gold/orders');
    await orders.send({ type: 'ready' });
    const drawnLine = orders.loaded().relationships[0];
    expect(drawnLine.issues).toEqual(['REL006']);
    await orders.send(relationshipSwap(drawnLine).request);
    expect(orders.errors()).toEqual([]);
    expect(j.domainJson('gold/orders').logical.relationships).toEqual([many('fct_order', 'customer_key', 'dim_customer', 'customer_key')]);
    expect(orders.loaded().relationshipHome).toBe('domain');
    expect((await j.check(true)).findings).toEqual([]);
  });
});

describe('journey 5 — a teammate still on 1.6.7 edits the same model library', () => {
  it('the new version reads their files, flags the backwards line, and Repair turns it round without touching their other edits', async () => {
    const FCT_NEW = `${modelYaml('fct_order', [...FCT_COLUMNS])}relationships:\n` +
      entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one') +
      entryYaml('date_key', 'dim_date', 'date_key', 'many-to-one', 'order date');
    j = createJourney({
      models: { fct_order: FCT_NEW, dim_customer: DIM_CUSTOMER, dim_product: DIM_PRODUCT, dim_date: DIM_DATE },
      domains: { 'gold/orders': { models: ['fct_order', 'dim_customer', 'dim_product', 'dim_date'] } },
    });
    expect((await j.check()).findings).toEqual([]);

    // The teammate (1.6.7) changes the fact's description on the canvas: 1.6.7
    // re-emits the whole relationships list and drops every `role:` …
    const FCT_167 = `${modelYaml('fct_order', [...FCT_COLUMNS]).replace('name: fct_order\n', 'name: fct_order\ndescription: One row per order line\n')}relationships:\n` +
      entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one') +
      entryYaml('date_key', 'dim_date', 'date_key', 'many-to-one');
    // … and draws a line from dim_product to the fact, saved the old way: in the dimension's file.
    const DIM_PRODUCT_167 = `${DIM_PRODUCT}relationships:\n  # drawn by Sam\n${entryYaml('product_key', 'fct_order', 'product_key', 'many-to-one')}`;
    j.writeModel('fct_order', FCT_167);
    j.writeModel('dim_product', DIM_PRODUCT_167);

    // After `git pull`: the new version reads both files as written.
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const orders = await j.open('gold/orders');
    await orders.send({ type: 'ready' });
    expect(sortDrawn(orders.drawn())).toEqual(sortDrawn([
      many('fct_order', 'customer_key', 'dim_customer', 'customer_key'),
      // The role is gone — 1.6.7 dropped it; nothing can tell it was there.
      many('fct_order', 'date_key', 'dim_date', 'date_key'),
      // Drawn as stored, with a badge: the keys say it runs the other way.
      many('dim_product', 'product_key', 'fct_order', 'product_key'),
    ]));
    expect(lineIssues(orders, 'fct_order.product_key', 'dim_product.product_key')).toEqual(['REL006']);
    const flagged = await j.check();
    expect(flagged.code).toBe(0);
    expect(flagged.findings).toEqual([{ code: 'REL006', severity: 'info', files: ['.erd-studio/logical-models/dim_product.yml'] }]);
    expect(info.mock.calls.filter((c) => c.includes('Repair Relationships…')).map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/^1 relationship can be tidied up automatically \(1 saved the wrong way round/),
    ]);
    info.mockRestore();

    const repair = await j.repair();
    expect(repair.errors).toEqual([]);
    expect(repair.title).toBe('Repair Relationships: change 2 files?');
    // Sam's comment stays, under an empty key — which the bundled schema accepts.
    expect(j.modelText('dim_product')).toBe(`${DIM_PRODUCT}relationships:\n  # drawn by Sam\n`);
    expect(j.schemaProblems()).toEqual([]);
    // The teammate's description stays; the turned-round line joins the fact's list.
    expect(j.modelText('fct_order')).toBe(`${FCT_167}${entryYaml('product_key', 'dim_product', 'product_key', 'many-to-one')}`);
    expect(lineIssues(orders, 'fct_order.product_key', 'dim_product.product_key')).toEqual([]);
    expect((await j.check(true)).findings).toEqual([]);
    expect((await j.repair()).title).toBeUndefined();
  });
});

describe('journey 5b — fixing the teammate\'s backwards line by hand instead', () => {
  it('⇄ on the badged line stores it once, on the fact, in one undo step', async () => {
    const DIM_PRODUCT_167 = `${DIM_PRODUCT}relationships:\n${entryYaml('product_key', 'fct_order', 'product_key', 'many-to-one')}`;
    const FCT = modelYaml('fct_order', [...FCT_COLUMNS]);
    j = createJourney({
      models: { fct_order: FCT, dim_product: DIM_PRODUCT_167 },
      domains: { 'gold/orders': { models: ['fct_order', 'dim_product'] } },
    });
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const orders = await j.open('gold/orders');
    await orders.send({ type: 'ready' });
    const drawnLine = orders.loaded().relationships[0];
    expect(drawnLine.issues).toEqual(['REL006']);
    const swap = relationshipSwap(drawnLine);
    expect(swap.title).toBe('Make fct_order the many side');
    await orders.send(swap.request);
    expect(orders.errors()).toEqual([]);
    expect(orders.edits()).toBe(1);
    expect(j.modelText('dim_product')).toBe(DIM_PRODUCT);
    expect(j.modelText('fct_order')).toBe(`${FCT}relationships:\n${entryYaml('product_key', 'dim_product', 'product_key', 'many-to-one')}`);
    expect(orders.drawn()).toEqual([many('fct_order', 'product_key', 'dim_product', 'product_key')]);
    expect((await j.check(true)).findings).toEqual([]);
  });
});

describe('journey 5c — a teammate hand-types a cardinality ERD Studio cannot read', () => {
  it('check is an error with the line, the canvas shows the banner, Repair leaves it, and the Edit dialog fixes exactly that entry', async () => {
    const FCT = modelYaml('fct_order', [...FCT_COLUMNS]);
    const typo = `${FCT}relationships:\n${entryYaml('customer_key', 'dim_customer', 'customer_key', 'one_to_many')}`;
    j = createJourney({
      models: { fct_order: typo, dim_customer: DIM_CUSTOMER },
      domains: { 'gold/orders': { models: ['fct_order', 'dim_customer'] } },
    });
    const check = await j.check();
    expect(check.code).toBe(1);
    expect(check.codes).toEqual(['REL008']);
    expect(check.result.findings[0]).toMatchObject({ severity: 'error', files: ['.erd-studio/logical-models/fct_order.yml'], line: expect.any(Number) });

    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const orders = await j.open('gold/orders');
    await orders.send({ type: 'ready' });
    // Still drawn (as many-to-one, as before), and the banner counts it.
    expect(orders.drawn()).toEqual([many('fct_order', 'customer_key', 'dim_customer', 'customer_key')]);
    expect(orders.loaded().relationshipIssues?.map((i) => i.code)).toEqual(['REL008']);

    // Repair never touches an entry it could not read.
    const repair = await j.repair();
    expect(j.modelText('fct_order')).toBe(typo);
    expect([repair.detail ?? '', ...repair.messages].join('\n')).toContain('logical-models/fct_order.yml');

    // The Edit dialog on that line rewrites its cardinality — and nothing else.
    const rel = orders.loaded().relationships[0];
    await orders.send({
      type: 'editRelationship',
      payload: {
        originalFromModel: rel.fromModel, originalFromColumn: rel.fromColumn, originalToModel: rel.toModel, originalToColumn: rel.toColumn,
        fromModel: rel.fromModel, fromColumn: rel.fromColumn, toModel: rel.toModel, toColumn: rel.toColumn,
        cardinality: 'many-to-one', role: '', ...(rel.stored ? { stored: rel.stored } : {}),
      },
    });
    expect(orders.errors()).toEqual([]);
    expect(j.modelText('fct_order')).toBe(typo.replace('one_to_many', 'many-to-one'));
    expect(orders.loaded().relationshipIssues ?? []).toEqual([]);
    expect((await j.check(true)).findings).toEqual([]);
  });
});

describe('journey 6 — an AI assistant writes relationships by hand from the harness rules', () => {
  it('the rules it follows say where and which way; its one mistake (one-to-many on the dimension) is REL002, which Repair moves', async () => {
    // What the assistant is told (the installed skill's text).
    const skill = new HarnessService(SEMANTIC_DIR).generateContent('claude');
    expect(skill).toContain('`fromModel` is always the many (FK) side, `toModel` the side it points at (PK). Never write `one-to-many`');
    expect(skill).toContain('`REL002` a `one-to-many` in a model file');
    expect(skill).toContain('erd-studio check --json');

    const fct = `${modelYaml('fct_order', [
      { name: 'order_key', pk: true }, { name: 'customer_key', fk: true }, { name: 'store_key', fk: true }, { name: 'date_key', fk: true },
    ])}relationships:\n` +
      entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one') +
      entryYaml('date_key', 'dim_date', 'date_key', 'many-to-one');
    const store = `${modelYaml('dim_store', [{ name: 'store_key', pk: true }, 'store_name'])}relationships:\n` +
      entryYaml('store_key', 'fct_order', 'store_key', 'one-to-many');
    // A model the assistant created with an empty list, to be drawn later.
    const RETURNS = modelYaml('fct_return', [{ name: 'return_key', pk: true }, 'customer_key']);
    j = createJourney({
      models: { fct_order: fct, dim_customer: DIM_CUSTOMER, dim_date: DIM_DATE, dim_store: store, fct_return: `${RETURNS}relationships: []\n` },
      domains: { 'gold/orders': { models: ['fct_order', 'dim_customer', 'dim_date', 'dim_store', 'fct_return'] } },
    });
    expect(j.schemaProblems()).toEqual([]);

    // `erd-studio check --json`, as the assistant is told to run it.
    const check = await j.check();
    expect(check.code).toBe(0);
    expect(check.findings).toEqual([{ code: 'REL002', severity: 'warning', files: ['.erd-studio/logical-models/dim_store.yml', '.erd-studio/logical-models/fct_order.yml'] }]);
    expect(check.result.findings[0].message).toContain('one-to-many');
    expect((await j.check(true)).code).toBe(1);

    // The canvas draws it the right way round already, with a badge.
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const orders = await j.open('gold/orders');
    await orders.send({ type: 'ready' });
    expect(orders.drawn()).toContainEqual(many('fct_order', 'store_key', 'dim_store', 'store_key'));
    expect(lineIssues(orders, 'fct_order.store_key', 'dim_store.store_key')).toEqual(['REL002']);

    const repair = await j.repair();
    expect(repair.errors).toEqual([]);
    expect(j.modelText('dim_store')).toBe(modelYaml('dim_store', [{ name: 'store_key', pk: true }, 'store_name']));
    expect(j.modelText('fct_order')).toBe(`${fct}${entryYaml('store_key', 'dim_store', 'store_key', 'many-to-one')}`);
    const after = await j.check(true);
    expect(after.code).toBe(0);
    expect(after.findings).toEqual([]);

    // The user then draws the returns line on the canvas: the empty list becomes
    // a block list, one entry per line — which Repair and the move can edit.
    await orders.send({ type: 'addRelationship', payload: { ...many('fct_return', 'customer_key', 'dim_customer', 'customer_key') } });
    expect(orders.errors()).toEqual([]);
    expect(j.modelText('fct_return')).toBe(`${RETURNS}relationships:\n${entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one')}`);
    expect(j.schemaProblems()).toEqual([]);
    expect((await j.check(true)).findings).toEqual([]);
  });
});

describe('journey 6b — an AI assistant spells a model with different capital letters', () => {
  it('the line is drawn, check says REL005, and Repair respells it to the real name', async () => {
    const FCT = modelYaml('fct_order', [{ name: 'order_key', pk: true }, 'customer_key']);
    const written = `${FCT}relationships:\n${entryYaml('customer_key', 'Dim_Customer', 'Customer_Key', 'many-to-one')}`;
    j = createJourney({
      models: { fct_order: written, dim_customer: DIM_CUSTOMER },
      domains: { 'gold/orders': { models: ['fct_order', 'dim_customer'] } },
    });
    expect(j.drawnOnDisk('gold/orders')).toEqual([many('fct_order', 'customer_key', 'dim_customer', 'customer_key')]);
    const check = await j.check();
    expect(check.code).toBe(0);
    expect(check.codes).toEqual(['REL005']);
    await j.repair();
    expect(j.modelText('fct_order')).toBe(`${FCT}relationships:\n${entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one')}`);
    expect((await j.check(true)).findings).toEqual([]);
  });
});

describe('journey 7 — two branches add the same link from opposite ends', () => {
  const FCT = modelYaml('fct_order', [{ name: 'order_key', pk: true }, 'customer_key']);
  const TO_CUSTOMER = many('fct_order', 'customer_key', 'dim_customer', 'customer_key');
  const FROM_DIM = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' };
  const domains = { 'gold/orders': { models: ['fct_order', 'dim_customer'] } };

  it('both on this version (dim→fact and fact→dim drags): the merge keeps both entries on the fact — one line, REL001, Repair keeps one', async () => {
    const entry = entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one');
    j = createJourney({ models: { fct_order: `${FCT}relationships:\n${entry}${entry}`, dim_customer: DIM_CUSTOMER }, domains });
    expect(j.drawnOnDisk('gold/orders')).toEqual([TO_CUSTOMER]);
    const check = await j.check();
    expect(check.findings).toEqual([{ code: 'REL001', severity: 'warning', files: ['.erd-studio/logical-models/fct_order.yml'] }]);

    const repair = await j.repair();
    expect(repair.errors).toEqual([]);
    expect(j.modelText('fct_order')).toBe(`${FCT}relationships:\n${entry}`);
    expect(j.modelText('dim_customer')).toBe(DIM_CUSTOMER);
    expect((await j.check(true)).findings).toEqual([]);
  });

  it('one branch on the fact, the other on the dimension as one-to-many: one line, REL001 and REL002, Repair removes the dimension\'s copy', async () => {
    const entry = entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one');
    j = createJourney({
      models: {
        fct_order: `${FCT}relationships:\n${entry}`,
        dim_customer: `${DIM_CUSTOMER}relationships:\n${entryYaml('customer_key', 'fct_order', 'customer_key', 'one-to-many')}`,
      },
      domains,
    });
    expect(j.drawnOnDisk('gold/orders')).toEqual([TO_CUSTOMER]);
    const check = await j.check();
    expect([...check.codes].sort()).toEqual(['REL001', 'REL002']);
    expect(check.findings.find((f) => f.code === 'REL001')).toMatchObject({
      severity: 'warning',
      files: expect.arrayContaining(['.erd-studio/logical-models/fct_order.yml', '.erd-studio/logical-models/dim_customer.yml']),
    });

    await j.repair();
    expect(j.modelText('fct_order')).toBe(`${FCT}relationships:\n${entry}`);
    expect(j.modelText('dim_customer')).toBe(DIM_CUSTOMER);
    expect((await j.check(true)).findings).toEqual([]);
    expect(j.drawnOnDisk('gold/orders')).toEqual([TO_CUSTOMER]);
  });

  it('one branch in the library, the other in the diagram file (written from the dimension): one line, a REL009 note, Repair removes the diagram\'s copy', async () => {
    const entry = entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one');
    j = createJourney({
      models: { fct_order: `${FCT}relationships:\n${entry}`, dim_customer: DIM_CUSTOMER },
      domains: { 'gold/orders': { models: ['fct_order', 'dim_customer'], relationships: [FROM_DIM] } },
    });
    expect(j.drawnOnDisk('gold/orders')).toEqual([TO_CUSTOMER]);
    const check = await j.check();
    expect(check.result.mode).toBe('library');
    expect(check.code).toBe(0);
    expect(check.findings).toEqual([{
      code: 'REL009', severity: 'info',
      files: expect.arrayContaining(['.erd-studio/gold/orders.json']),
    }]);

    await j.repair();
    expect(j.domainJson('gold/orders').logical.relationships).toEqual([]);
    expect(j.modelText('fct_order')).toBe(`${FCT}relationships:\n${entry}`);
    expect((await j.check(true)).findings).toEqual([]);
    expect(j.drawnOnDisk('gold/orders')).toEqual([TO_CUSTOMER]);
  });

  it('copies that disagree (many-to-one vs one-to-one): one line drawn the same in every diagram, REL001 is an error, Repair lists it and writes nothing', async () => {
    j = createJourney({
      models: {
        fct_order: `${FCT}relationships:\n${entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one')}`,
        dim_customer: `${DIM_CUSTOMER}relationships:\n${entryYaml('customer_key', 'fct_order', 'customer_key', 'one-to-one')}`,
      },
      domains: {
        'gold/orders': { models: ['fct_order', 'dim_customer'] },
        // The same two models listed the other way round: the same line.
        'gold/customers': { models: ['dim_customer', 'fct_order'] },
      },
    });
    const drawn = j.drawnOnDisk('gold/orders');
    expect(drawn).toHaveLength(1);
    expect(j.drawnOnDisk('gold/customers')).toEqual(drawn);
    const check = await j.check();
    expect(check.code).toBe(1);
    expect(check.findings.find((f) => f.code === 'REL001')?.severity).toBe('error');

    const before = j.files();
    const repair = await j.repair();
    expect(repair.errors).toEqual([]);
    expect(j.files()).toEqual(before);
    expect([...(repair.detail ? [repair.detail] : []), ...repair.messages].join('\n')).toMatch(/fct_order\.customer_key/);
  });

  it('per-diagram project: both branches append to the same diagram file — one line, REL001, Repair keeps the fact-side entry', async () => {
    j = createJourney({
      models: { fct_order: FCT, dim_customer: DIM_CUSTOMER },
      domains: { 'gold/orders': { models: ['fct_order', 'dim_customer'], relationships: [{ ...TO_CUSTOMER }, FROM_DIM] } },
    });
    expect(j.drawnOnDisk('gold/orders')).toEqual([TO_CUSTOMER]);
    const check = await j.check();
    expect(check.result.mode).toBe('domain');
    expect(check.findings).toEqual([{ code: 'REL001', severity: 'warning', files: ['.erd-studio/gold/orders.json'] }]);

    await j.repair();
    expect(j.domainJson('gold/orders').logical.relationships).toEqual([TO_CUSTOMER]);
    expect(j.modelText('fct_order')).toBe(FCT);
    expect(j.modelText('dim_customer')).toBe(DIM_CUSTOMER);
    const after = await j.check(true);
    expect(after.result.mode).toBe('domain');
    expect(after.findings).toEqual([]);
  });
});

describe('journey 8 — Draw from dbt over a relationships test declared on the dimension', () => {
  const SCHEMA_YML = `version: 2
models:
  - name: fct_order
    columns:
      - name: order_key
        data_type: integer
        tests: [unique, not_null]
      - name: customer_key
        data_type: integer
      - name: amount
        data_type: numeric
  - name: dim_customer
    columns:
      - name: customer_key
        data_type: integer
        tests:
          - unique
          - not_null
          - relationships:
              to: ref('fct_order')
              field: customer_key
      - name: customer_name
        data_type: varchar
`;
  const files = { 'models/marts/schema.yml': SCHEMA_YML };
  const TO_CUSTOMER = many('fct_order', 'customer_key', 'dim_customer', 'customer_key');

  function checkModels(): void {
    j.models.invalidateCache();
    const fct = j.models.getModel('fct_order')!;
    const dim = j.models.getModel('dim_customer')!;
    expect(dim.columns?.find((c) => c.name === 'customer_key')).toMatchObject({ isPrimaryKey: true });
    expect(dim.columns?.find((c) => c.name === 'customer_key')?.isForeignKey).toBeUndefined();
    expect(fct.columns?.find((c) => c.name === 'order_key')).toMatchObject({ isPrimaryKey: true });
    expect(fct.columns?.find((c) => c.name === 'customer_key')).toMatchObject({ isForeignKey: true });
    expect(j.modelText('dim_customer')).not.toContain('isForeignKey');
  }

  it('Draw from dbt… (a new project): the relationship is stored on the fact, the dimension key is not a foreign key, check is clean', async () => {
    j = createJourney({ models: {}, files });
    picker.modelNames = ['fct_order', 'dim_customer'];
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('orders');
    const errors = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    const yml = new YmlParserService();

    const result = await drawFromDbt({
      workspaceRoot: j.root,
      semanticDir: SEMANTIC_DIR,
      modelPaths: ['models'],
      layerService: new LayerService(j.root, SEMANTIC_DIR),
      domainService: j.domainService,
      logicalModelService: j.models,
      loadDbt: async () => ({ ymlData: await yml.loadYmlData(j.root) }),
      validateDomainName: () => undefined,
      onWritten: () => undefined,
    });

    expect(errors).not.toHaveBeenCalled();
    expect(result?.domainPath).toBe(j.semantic('gold/orders.json'));
    j.models.invalidateCache();
    expect(j.models.getModel('fct_order')?.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]);
    expect(j.models.getModel('dim_customer')?.relationships).toBeUndefined();
    expect(j.domainJson('gold/orders').logical.relationships).toEqual([]);
    checkModels();
    expect(j.drawnOnDisk('gold/orders')).toEqual([TO_CUSTOMER]);
    const check = await j.check(true);
    expect(check.code).toBe(0);
    expect(check.findings).toEqual([]);

    // The diagram opens on the logical stage with one line; the physical stage
    // (dbt's own test, as declared) also draws one line between the same columns.
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const orders = await j.open('gold/orders');
    await orders.send({ type: 'ready' });
    expect(orders.drawn()).toEqual([TO_CUSTOMER]);
    expect(orders.loaded().relationships[0].issues ?? []).toEqual([]);
    await orders.send({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    expect(orders.errors()).toEqual([]);
    const physical = orders.posted().filter((m) => m.type === 'stageData').pop()?.payload as DisplayDomain;
    expect(physical.stage).toBe('physical');
    expect(physical.relationships.map((r) => linkKey(r))).toEqual([linkKey(TO_CUSTOMER)]);
    // Compare to Logical finds no drift: the same relationship, whichever end dbt tests it from.
    await orders.send({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'logical' } });
    expect(orders.errors()).toEqual([]);
    const report = orders.posted().filter((m) => m.type === 'discrepancyReport').pop()?.payload as DiscrepancyReport;
    expect(report.relationships.map((r) => r.status)).toEqual(['matched']);
    // … and neither does `erd-studio diff`.
    let out = '';
    const diffCode = await main(['diff', '--all', '--json', '--project', j.root], {
      stdout: { write: (text: string) => { out += text; } }, stderr: { write: () => undefined }, cwd: j.root, env: {},
    });
    expect(diffCode).toBe(0);
    const diff = JSON.parse(out) as { domains: Array<{ clean: boolean; fixes: Array<{ action: string }> }> };
    expect(diff.domains.map((d) => d.fixes.filter((f) => f.action.includes('relationship')))).toEqual([[]]);
  });

  it('Add models from dbt on an empty canvas does the same', async () => {
    j = createJourney({ models: {}, files, domains: { 'gold/orders': { models: [] } } });
    picker.modelNames = ['fct_order', 'dim_customer'];
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const orders = await j.open('gold/orders');
    await orders.send({ type: 'ready' });
    await orders.send({ type: 'addModelsFromDbt' });

    expect(orders.errors()).toEqual([]);
    expect(orders.edits()).toBe(1);
    j.models.invalidateCache();
    expect(j.models.getModel('fct_order')?.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]);
    expect(j.models.getModel('dim_customer')?.relationships).toBeUndefined();
    checkModels();
    expect(orders.drawn()).toEqual([TO_CUSTOMER]);
    expect((await j.check(true)).findings).toEqual([]);
  });

  it('in a project that keeps relationships per diagram, the drawn diagram holds it from the fact', async () => {
    j = createJourney({
      models: { dim_date: DIM_DATE, fct_other: modelYaml('fct_other', [{ name: 'other_key', pk: true }, 'date_key']) },
      domains: {
        'silver/other': {
          models: ['fct_other', 'dim_date'],
          relationships: [many('fct_other', 'date_key', 'dim_date', 'date_key')],
        },
      },
      files,
    });
    picker.modelNames = ['dim_customer', 'fct_order'];
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('orders');
    const yml = new YmlParserService();
    await drawFromDbt({
      workspaceRoot: j.root,
      semanticDir: SEMANTIC_DIR,
      modelPaths: ['models'],
      layerService: new LayerService(j.root, SEMANTIC_DIR),
      domainService: j.domainService,
      logicalModelService: j.models,
      loadDbt: async () => ({ ymlData: await yml.loadYmlData(j.root) }),
      validateDomainName: () => undefined,
      onWritten: () => undefined,
    });
    expect(j.domainJson('gold/orders').logical.relationships).toEqual([TO_CUSTOMER]);
    j.models.invalidateCache();
    expect(j.models.getModel('fct_order')?.relationships).toBeUndefined();
    checkModels();
    const check = await j.check(true);
    expect(check.result.mode).toBe('domain');
    expect(check.findings).toEqual([]);
  });
});
