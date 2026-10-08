/**
 * Relationship journeys, end to end (issue #133) — part 1: drawing on the
 * canvas.
 *
 * Each journey is what a real team does, run against the real host
 * (`SemanticEditorProvider` over the vscode mock), real services on a temp
 * project, the CLI's `erd-studio check` in-process and the Repair
 * Relationships… runner. The canvas side is driven the way the webview drives
 * it: a drag is oriented with the webview's own `orientDrag` over the payload
 * the host sent, and ⇄ / cardinality / delete requests come from the
 * renderer's `relationshipActions`. Every step asserts what lands on disk,
 * what each diagram draws and what `check` says.
 *
 * 1. A Kimball team: drags both ways, ⇄, a role, a cardinality change, a
 *    delete, undo and redo.
 * 2. A Data Vault team: hubs, links and satellites (composite keys).
 * 3. A project that keeps relationships per diagram and never moved.
 *
 * The upgrade journeys (1.6.7 files, a teammate on 1.6.7, an AI assistant,
 * merged branches, Draw from dbt) are in journeys.relationships.upgrade.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { relationshipSwap, removeRelationshipRequest, updateCardinalityRequest } from '@erd-studio/renderer/editor';

import { _resetMockWorkspace, type MockTextDocument } from '../__mocks__/vscode';
import { runMoveRelationships } from '../../src/commands/repairRelationships';
import { orientDrag } from '../../webview/lib/relationshipDirection';
import type { DisplayRelationship } from '../../src/types/display';
import {
  createJourney,
  entryYaml,
  modelYaml,
  simulateUndoStack,
  sortDrawn,
  type Drawn,
  type Journey,
  type Panel,
} from './journeys.relationships.harness';

let j: Journey;
beforeEach(() => {
  _resetMockWorkspace();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  j?.dispose();
});

/** Drag from one column handle to another, oriented as the canvas does, and create it as the dialog sends it. */
async function drag(
  panel: Panel,
  from: [string, string],
  to: [string, string],
  options: { role?: string; cardinality?: 'many-to-one' | 'one-to-one' } = {},
): Promise<{ turned: boolean; confidence?: string; sent: Drawn }> {
  const oriented = orientDrag({ fromModel: from[0], fromColumn: from[1], toModel: to[0], toColumn: to[1] }, panel.loaded().models);
  const { fromModel, fromColumn, toModel, toColumn } = oriented.prefill;
  const sent = { fromModel, fromColumn, toModel, toColumn: toColumn!, cardinality: options.cardinality ?? 'many-to-one' } as Drawn;
  await panel.send({ type: 'addRelationship', payload: { ...sent, ...(options.role ? { role: options.role } : {}) } });
  return { turned: oriented.turned, confidence: oriented.verdict?.confidence, sent };
}

/** The drawn relationship between two columns (either way round), as the canvas holds it. */
function line(panel: Panel, a: string, b: string): DisplayRelationship {
  const ends = (r: DisplayRelationship) => [`${r.fromModel}.${r.fromColumn}`, `${r.toModel}.${r.toColumn}`];
  const found = panel.loaded().relationships.find((r) => ends(r).includes(a) && ends(r).includes(b));
  if (!found) throw new Error(`no line ${a} — ${b}`);
  return found;
}

describe('journey 1 — a Kimball team draws a star', () => {
  const FCT = modelYaml('fct_sales', [
    { name: 'sales_key', pk: true }, 'customer_key', 'order_date_key', 'ship_date_key', { name: 'amount', type: 'decimal' },
  ]);
  const DIM_CUSTOMER = modelYaml('dim_customer', [{ name: 'customer_key', pk: true }, 'customer_name']);
  const DIM_DATE = modelYaml('dim_date', [{ name: 'date_key', pk: true }, 'calendar_date']);

  it('every drag ends up on the fact, whichever way it was drawn; ⇄, role, cardinality, delete, undo and redo each change one entry', async () => {
    j = createJourney({
      models: { fct_sales: FCT, dim_customer: DIM_CUSTOMER, dim_date: DIM_DATE },
      domains: {
        'gold/sales': { models: ['fct_sales', 'dim_customer', 'dim_date'] },
        'gold/customers': { models: ['fct_sales', 'dim_customer'] },
      },
    });
    const undo = simulateUndoStack(j.semantic('gold/sales.json'));
    try {
      const sales = await j.open('gold/sales');
      await sales.send({ type: 'ready' });
      // A new project (no relationship anywhere) keeps them in the model library.
      expect(sales.loaded().relationshipHome).toBe('library');
      const customers = await j.open('gold/customers');
      await customers.send({ type: 'ready' });

      // --- Drag from the dimension's key to the fact: turned round onto the fact.
      const first = await drag(sales, ['dim_customer', 'customer_key'], ['fct_sales', 'customer_key']);
      expect(first.turned).toBe(true);
      expect(sales.errors()).toEqual([]);
      expect(sales.edits()).toBe(1);
      expect(j.modelText('fct_sales')).toBe(`${FCT}relationships:\n${entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one')}`);
      expect(j.modelText('dim_customer')).toBe(DIM_CUSTOMER);
      expect(j.domainJson('gold/sales').logical.relationships).toEqual([]);
      const toCustomer: Drawn = { fromModel: 'fct_sales', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
      expect(sales.drawn()).toEqual([toCustomer]);
      // The other diagram holding both models draws it too, refreshed without a reload.
      expect(customers.drawn()).toEqual([toCustomer]);
      expect(j.drawnOnDisk('gold/customers')).toEqual([toCustomer]);
      expect((await j.check()).findings).toEqual([]);

      // --- Drag from the fact to the dimension (role-playing dates): left as drawn.
      const second = await drag(sales, ['fct_sales', 'order_date_key'], ['dim_date', 'date_key'], { role: 'order date' });
      expect(second.turned).toBe(false);
      const third = await drag(sales, ['dim_date', 'date_key'], ['fct_sales', 'ship_date_key'], { role: 'ship date' });
      expect(third.turned).toBe(true);
      expect(sales.errors()).toEqual([]);
      const allThree = `${FCT}relationships:\n` +
        entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one') +
        entryYaml('order_date_key', 'dim_date', 'date_key', 'many-to-one', 'order date') +
        entryYaml('ship_date_key', 'dim_date', 'date_key', 'many-to-one', 'ship date');
      expect(j.modelText('fct_sales')).toBe(allThree);
      expect(j.modelText('dim_date')).toBe(DIM_DATE);
      expect(sales.drawn()).toHaveLength(3);
      // The customers diagram has no dim_date: it still draws only its one line.
      expect(customers.drawn()).toEqual([toCustomer]);
      const clean = await j.check();
      expect(clean.code).toBe(0);
      expect(clean.findings).toEqual([]);

      // --- The same link again, from the dimension as one-to-many: refused as a duplicate.
      await sales.send({ type: 'addRelationship', payload: { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_sales', toColumn: 'customer_key', cardinality: 'one-to-many' } });
      expect(sales.errors()).toEqual([expect.stringContaining('This relationship already exists.')]);
      expect(sales.edits()).toBe(0);
      expect(j.modelText('fct_sales')).toBe(allThree);

      // --- ⇄ on the customer line: dim_customer becomes the many side (the user's call).
      await sales.send(relationshipSwap(line(sales, 'fct_sales.customer_key', 'dim_customer.customer_key')).request);
      expect(sales.errors()).toEqual([]);
      expect(sales.edits()).toBe(1);
      expect(j.modelText('dim_customer')).toBe(`${DIM_CUSTOMER}relationships:\n${entryYaml('customer_key', 'fct_sales', 'customer_key', 'many-to-one')}`);
      expect(j.modelText('fct_sales')).not.toContain('toModel: dim_customer');
      // The keys say otherwise: a note (badge), never an error.
      expect(line(sales, 'fct_sales.customer_key', 'dim_customer.customer_key').issues).toEqual(['REL006']);
      const swapped = await j.check();
      expect(swapped.code).toBe(0);
      expect(swapped.findings).toEqual([{ code: 'REL006', severity: 'info', files: ['.erd-studio/logical-models/dim_customer.yml'] }]);

      // --- ⇄ again puts it back on the fact; the dimension's file is exactly as it was.
      await sales.send(relationshipSwap(line(sales, 'fct_sales.customer_key', 'dim_customer.customer_key')).request);
      expect(sales.errors()).toEqual([]);
      expect(j.modelText('dim_customer')).toBe(DIM_CUSTOMER);
      expect(sortDrawn(sales.drawn())).toEqual(sortDrawn([
        toCustomer,
        { fromModel: 'fct_sales', fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'order date' },
        { fromModel: 'fct_sales', fromColumn: 'ship_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'ship date' },
      ]));
      expect((await j.check()).findings).toEqual([]);

      // --- Edit a role in the dialog: that one entry's role, nothing else.
      const before = j.modelText('fct_sales');
      const orderDate = line(sales, 'fct_sales.order_date_key', 'dim_date.date_key');
      await sales.send({
        type: 'editRelationship',
        payload: {
          originalFromModel: orderDate.fromModel, originalFromColumn: orderDate.fromColumn,
          originalToModel: orderDate.toModel, originalToColumn: orderDate.toColumn,
          fromModel: orderDate.fromModel, fromColumn: orderDate.fromColumn, toModel: orderDate.toModel, toColumn: orderDate.toColumn,
          cardinality: orderDate.cardinality, role: 'booking date',
          ...(orderDate.stored ? { stored: orderDate.stored } : {}),
        },
      });
      expect(sales.errors()).toEqual([]);
      expect(j.modelText('fct_sales')).toBe(before.replace('role: order date', 'role: booking date'));

      // --- Change a cardinality from the line's menu: one-to-one, kept on the fact (it holds the key).
      await sales.send(updateCardinalityRequest(line(sales, 'fct_sales.customer_key', 'dim_customer.customer_key'), 'one-to-one'));
      expect(sales.errors()).toEqual([]);
      const oneToOne = j.modelText('fct_sales');
      expect(oneToOne).toContain(entryYaml('customer_key', 'dim_customer', 'customer_key', 'one-to-one'));
      expect(j.modelText('dim_customer')).toBe(DIM_CUSTOMER);
      expect(customers.drawn()).toEqual([{ ...toCustomer, cardinality: 'one-to-one' }]);
      expect((await j.check()).findings).toEqual([]);

      // --- Delete the ship-date line, then undo, redo and undo again.
      const withShip = j.modelText('fct_sales');
      await sales.send(removeRelationshipRequest(line(sales, 'fct_sales.ship_date_key', 'dim_date.date_key')));
      expect(sales.errors()).toEqual([]);
      const withoutShip = j.modelText('fct_sales');
      expect(withoutShip).toBe(withShip.replace(entryYaml('ship_date_key', 'dim_date', 'date_key', 'many-to-one', 'ship date'), ''));
      expect(sales.drawn()).toHaveLength(2);

      await sales.send({ type: 'undo' });
      expect(sales.errors()).toEqual([]);
      expect(j.modelText('fct_sales')).toBe(withShip);
      expect(sales.drawn()).toHaveLength(3);

      await sales.send({ type: 'redo' });
      expect(sales.errors()).toEqual([]);
      expect(j.modelText('fct_sales')).toBe(withoutShip);
      expect(sales.drawn()).toHaveLength(2);

      // Two undos: the delete, then the cardinality change — each one step.
      await sales.send({ type: 'undo' });
      await sales.send({ type: 'undo' });
      expect(sales.errors()).toEqual([]);
      expect(j.modelText('fct_sales')).toBe(withShip.replace('cardinality: one-to-one', 'cardinality: many-to-one'));
      expect(customers.drawn()).toEqual([toCustomer]);
      // Nothing was ever written into either diagram file.
      expect(j.domainJson('gold/sales').logical.relationships).toEqual([]);
      expect(j.domainJson('gold/customers').logical.relationships).toEqual([]);
      expect(j.modelText('dim_customer')).toBe(DIM_CUSTOMER);
      expect(j.modelText('dim_date')).toBe(DIM_DATE);
      const end = await j.check();
      expect(end.code).toBe(0);
      expect(end.findings).toEqual([]);
    } finally {
      undo.dispose();
    }
  });
});

describe('journey 1b — the same Kimball team keeps working on the star', () => {
  const FCT = modelYaml('fct_sales', [{ name: 'sales_key', pk: true }, 'customer_key', 'store_key', 'date_key']);
  const DIM_CUSTOMER = modelYaml('dim_customer', [{ name: 'customer_key', pk: true }]);
  const DIM_DATE = modelYaml('dim_date', [{ name: 'date_key', pk: true }]);
  // A dimension nobody has marked a key on yet.
  const DIM_STORE = modelYaml('dim_store', ['store_key', 'store_name']);
  const ENTRY_CUSTOMER = entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one');
  const ENTRY_DATE = entryYaml('date_key', 'dim_date', 'date_key', 'many-to-one');

  it('an unkeyed drag is not guessed: the user picks the direction and marks the key in the same undo step', async () => {
    j = createJourney({
      models: { fct_sales: `${FCT}relationships:\n${ENTRY_CUSTOMER}`, dim_customer: DIM_CUSTOMER, dim_store: DIM_STORE },
      domains: { 'gold/sales': { models: ['fct_sales', 'dim_customer', 'dim_store'] } },
    });
    const undo = simulateUndoStack(j.semantic('gold/sales.json'));
    try {
      const sales = await j.open('gold/sales');
      await sales.send({ type: 'ready' });
      // Drawn from the dimension: neither end is a key, so nothing is turned round.
      const oriented = orientDrag({ fromModel: 'dim_store', fromColumn: 'store_key', toModel: 'fct_sales', toColumn: 'store_key' }, sales.loaded().models);
      expect(oriented.turned).toBe(false);
      expect(oriented.verdict?.confidence).toBe('ambiguous');
      // The dialog: "fct_sales has many rows per dim_store", ticking "Mark store_key as dim_store's key".
      await sales.send({
        type: 'addRelationship',
        payload: {
          fromModel: 'fct_sales', fromColumn: 'store_key', toModel: 'dim_store', toColumn: 'store_key', cardinality: 'many-to-one',
          markKey: { model: 'dim_store', column: 'store_key' },
        },
      });
      expect(sales.errors()).toEqual([]);
      expect(sales.edits()).toBe(1);
      expect(j.modelText('dim_store')).toBe(DIM_STORE.replace('  - name: store_key\n    dataType: string\n', '  - name: store_key\n    dataType: string\n    isPrimaryKey: true\n'));
      expect(j.modelText('fct_sales')).toBe(`${FCT}relationships:\n${ENTRY_CUSTOMER}${entryYaml('store_key', 'dim_store', 'store_key', 'many-to-one')}`);
      // Now the key is marked, the next drag from the dimension is turned round on its own.
      expect(orientDrag({ fromModel: 'dim_store', fromColumn: 'store_key', toModel: 'fct_sales', toColumn: 'store_key' }, sales.loaded().models).turned).toBe(true);
      expect((await j.check(true)).findings).toEqual([]);

      // One undo takes back both the relationship and the key flag.
      await sales.send({ type: 'undo' });
      expect(sales.errors()).toEqual([]);
      expect(j.modelText('dim_store')).toBe(DIM_STORE);
      expect(j.modelText('fct_sales')).toBe(`${FCT}relationships:\n${ENTRY_CUSTOMER}`);
    } finally {
      undo.dispose();
    }
  });

  it('a dimension\'s file open with an unsaved edit does not stop drawing the fact\'s line — only a change that would rewrite that file', async () => {
    j = createJourney({
      models: { fct_sales: FCT, dim_customer: DIM_CUSTOMER },
      domains: { 'gold/sales': { models: ['fct_sales', 'dim_customer'] } },
    });
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const sales = await j.open('gold/sales');
    await sales.send({ type: 'ready' });
    // The user is half-way through describing the dimension in a text tab.
    const dimDoc = await vscode.workspace.openTextDocument(j.modelPath('dim_customer')) as unknown as MockTextDocument;
    const typing = `${DIM_CUSTOMER}description: One row per cust`;
    dimDoc._setText(typing);

    await drag(sales, ['dim_customer', 'customer_key'], ['fct_sales', 'customer_key']);
    expect(sales.errors()).toEqual([]);
    expect(j.modelText('fct_sales')).toBe(`${FCT}relationships:\n${ENTRY_CUSTOMER}`);
    // ⇄ would move the relationship into the dimension's file: refused by name, nothing written, the typing kept.
    await sales.send(relationshipSwap(line(sales, 'fct_sales.customer_key', 'dim_customer.customer_key')).request);
    expect(sales.errors()).toEqual([
      'Failed to update relationship: logical-models/dim_customer.yml has unsaved changes. Save or revert it first, then try again.',
    ]);
    expect(sales.edits()).toBe(0);
    expect(j.modelText('fct_sales')).toBe(`${FCT}relationships:\n${ENTRY_CUSTOMER}`);
    expect(j.modelText('dim_customer')).toBe(DIM_CUSTOMER);
    expect(dimDoc.getText()).toBe(typing);
    // Deleting the line writes only the fact's file: allowed.
    await sales.send(removeRelationshipRequest(line(sales, 'fct_sales.customer_key', 'dim_customer.customer_key')));
    expect(sales.errors()).toEqual([]);
    expect(j.modelText('fct_sales')).toBe(FCT);
    expect(dimDoc.getText()).toBe(typing);
  });

  it('renaming a key column or a model, adding a model and removing one keep every diagram drawing the right lines', async () => {
    j = createJourney({
      models: { fct_sales: `${FCT}relationships:\n${ENTRY_CUSTOMER}${ENTRY_DATE}`, dim_customer: DIM_CUSTOMER, dim_date: DIM_DATE },
      domains: {
        'gold/sales': { models: ['fct_sales', 'dim_customer'] },
        // A diagram without the dimension being renamed (renaming a model updates
        // only the open diagram's own reference to it).
        'gold/calendar': { models: ['fct_sales', 'dim_date'] },
      },
    });
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const sales = await j.open('gold/sales');
    await sales.send({ type: 'ready' });
    const calendar = await j.open('gold/calendar');
    await calendar.send({ type: 'ready' });
    // sales has no dim_date: only the customer line.
    expect(sales.drawn()).toEqual([{ fromModel: 'fct_sales', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }]);

    // Rename the dimension's key column: the fact's entry follows.
    await sales.send({
      type: 'updateColumn',
      payload: { modelName: 'dim_customer', oldColumnName: 'customer_key', column: { name: 'customer_sk', dataType: 'string', description: '' } },
    });
    expect(sales.errors()).toEqual([]);
    expect(j.modelText('fct_sales')).toContain(entryYaml('customer_key', 'dim_customer', 'customer_sk', 'many-to-one'));

    // Rename the dimension: the fact's entry and both diagrams follow.
    await sales.send({ type: 'renameModel', payload: { oldName: 'dim_customer', newName: 'dim_client' } });
    expect(sales.errors()).toEqual([]);
    expect(j.modelText('fct_sales')).toBe(`${FCT}relationships:\n${entryYaml('customer_key', 'dim_client', 'customer_sk', 'many-to-one')}${ENTRY_DATE}`);
    const toClient: Drawn = { fromModel: 'fct_sales', fromColumn: 'customer_key', toModel: 'dim_client', toColumn: 'customer_sk', cardinality: 'many-to-one' };
    expect(sales.drawn()).toEqual([toClient]);
    const toDate: Drawn = { fromModel: 'fct_sales', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    expect(j.drawnOnDisk('gold/calendar')).toEqual([toDate]);
    expect(calendar.drawn()).toEqual([toDate]);

    // Add an existing model: its library relationships appear with it.
    await sales.send({ type: 'addExistingModel', payload: { modelName: 'dim_date' } });
    expect(sales.errors()).toEqual([]);
    expect(sales.drawn()).toHaveLength(2);

    // Remove it again from this diagram: the relationship stays in the library, and the calendar still draws it.
    const fctBefore = j.modelText('fct_sales');
    await sales.send({ type: 'removeModel', payload: { modelName: 'dim_date' } });
    expect(sales.errors()).toEqual([]);
    expect(sales.drawn()).toEqual([toClient]);
    expect(j.modelText('fct_sales')).toBe(fctBefore);
    expect(j.drawnOnDisk('gold/calendar')).toEqual([toDate]);
    const end = await j.check(true);
    expect(end.code).toBe(0);
    expect(end.findings).toEqual([]);
  });
});

describe('journey 2 — a Data Vault team links hubs, links and satellites', () => {
  const HUB_CUSTOMER = modelYaml('hub_customer', [{ name: 'customer_hk', pk: true }, { name: 'customer_id', nk: true }, 'load_date', 'record_source']);
  const HUB_ORDER = modelYaml('hub_order', [{ name: 'order_hk', pk: true }, { name: 'order_id', nk: true }, 'load_date', 'record_source']);
  const LINK = modelYaml('link_customer_order', [{ name: 'link_hk', pk: true }, 'customer_hk', 'order_hk', 'load_date', 'record_source']);
  const SAT_CUSTOMER = modelYaml('sat_customer_details', [{ name: 'customer_hk', pk: true }, { name: 'load_date', pk: true }, 'hashdiff', 'customer_name']);
  const SAT_LINK = modelYaml('sat_customer_order_status', [{ name: 'link_hk', pk: true }, { name: 'load_date', pk: true }, 'hashdiff', 'status']);

  it('relationships land on the link and the satellites; the hubs are never edited', async () => {
    j = createJourney({
      // A raw vault grouped by layer folder (logical-models/silver/…).
      models: {
        'silver/hub_customer': HUB_CUSTOMER, 'silver/hub_order': HUB_ORDER, 'silver/link_customer_order': LINK,
        'silver/sat_customer_details': SAT_CUSTOMER, 'silver/sat_customer_order_status': SAT_LINK,
      },
      domains: {
        'silver/vault': { models: ['hub_customer', 'hub_order', 'link_customer_order', 'sat_customer_details', 'sat_customer_order_status'] },
        'silver/customer': { models: ['hub_customer', 'sat_customer_details'] },
      },
    });
    const vault = await j.open('silver/vault');
    await vault.send({ type: 'ready' });

    // Hub → link: the hub's whole key is the "one" side.
    const a = await drag(vault, ['hub_customer', 'customer_hk'], ['link_customer_order', 'customer_hk']);
    expect(a.turned).toBe(true);
    // Link → hub: drawn the right way already.
    const b = await drag(vault, ['link_customer_order', 'order_hk'], ['hub_order', 'order_hk']);
    expect(b.turned).toBe(false);
    // Hub → satellite: the satellite's hash key is only part of its key — certain.
    const c = await drag(vault, ['hub_customer', 'customer_hk'], ['sat_customer_details', 'customer_hk']);
    expect(c).toMatchObject({ turned: true, confidence: 'certain' });
    // Link satellite → link.
    const d = await drag(vault, ['sat_customer_order_status', 'link_hk'], ['link_customer_order', 'link_hk']);
    expect(d).toMatchObject({ turned: false, confidence: 'certain' });
    expect(vault.errors()).toEqual([]);

    expect(j.modelText('hub_customer')).toBe(HUB_CUSTOMER);
    expect(j.modelText('hub_order')).toBe(HUB_ORDER);
    expect(j.modelText('link_customer_order')).toBe(`${LINK}relationships:\n` +
      entryYaml('customer_hk', 'hub_customer', 'customer_hk', 'many-to-one') +
      entryYaml('order_hk', 'hub_order', 'order_hk', 'many-to-one'));
    expect(j.modelText('sat_customer_details')).toBe(`${SAT_CUSTOMER}relationships:\n${entryYaml('customer_hk', 'hub_customer', 'customer_hk', 'many-to-one')}`);
    expect(j.modelText('sat_customer_order_status')).toBe(`${SAT_LINK}relationships:\n${entryYaml('link_hk', 'link_customer_order', 'link_hk', 'many-to-one')}`);
    expect(j.domainJson('silver/vault').logical.relationships).toEqual([]);
    // Each written where it already was: in the layer folder.
    expect(j.modelPath('link_customer_order')).toBe(j.semantic('logical-models/silver/link_customer_order.yml'));
    expect(j.modelPath('sat_customer_details')).toBe(j.semantic('logical-models/silver/sat_customer_details.yml'));

    expect(vault.drawn()).toHaveLength(4);
    expect(vault.loaded().relationships.every((r) => !r.issues || r.issues.length === 0)).toBe(true);
    // The customer diagram (hub + satellite only) draws exactly the satellite's line.
    expect(j.drawnOnDisk('silver/customer')).toEqual([
      { fromModel: 'sat_customer_details', fromColumn: 'customer_hk', toModel: 'hub_customer', toColumn: 'customer_hk', cardinality: 'many-to-one' },
    ]);
    const check = await j.check();
    expect(check.code).toBe(0);
    expect(check.findings).toEqual([]);
    // Nothing for Repair to do.
    const repair = await j.repair();
    expect(repair.title).toBeUndefined();
    expect(repair.messages).toEqual(['Repair Relationships: nothing to repair — every relationship is stored once, in its home.']);
  });
});

describe('journey 3 — a project that keeps relationships per diagram and never moved', () => {
  const FCT = modelYaml('fct_order', [{ name: 'order_key', pk: true }, 'customer_key', 'date_key']);
  const DIM_CUSTOMER = modelYaml('dim_customer', [{ name: 'customer_key', pk: true }]);
  const DIM_DATE = modelYaml('dim_date', [{ name: 'date_key', pk: true }]);
  const TO_CUSTOMER = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };

  it('every edit stays in the open diagram file, the project never switches to the library, and other diagrams\' copies are not findings', async () => {
    j = createJourney({
      models: { fct_order: FCT, dim_customer: DIM_CUSTOMER, dim_date: DIM_DATE },
      domains: {
        'silver/orders': { models: ['fct_order', 'dim_customer', 'dim_date'], relationships: [{ ...TO_CUSTOMER }] },
        'silver/reporting': { models: ['fct_order', 'dim_customer'], relationships: [{ ...TO_CUSTOMER }] },
      },
    });
    const modelFiles = () => ({ fct: j.modelText('fct_order'), cust: j.modelText('dim_customer'), date: j.modelText('dim_date') });
    const modelsBefore = modelFiles();
    const reportingBefore = j.files()['.erd-studio/silver/reporting.json'];
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);

    const start = await j.check();
    expect(start.result.mode).toBe('domain');
    expect(start.findings).toEqual([]);

    const orders = await j.open('silver/orders');
    await orders.send({ type: 'ready' });
    expect(orders.loaded().relationshipHome).toBe('domain');
    // The #126 offer to move shared relationships is made — and writes nothing (Not Now).
    expect(info.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('Relationships can now be defined once and shared.')]);
    expect(modelFiles()).toEqual(modelsBefore);

    // A drag from the dimension: stored canonical, in this diagram file.
    const dragged = await drag(orders, ['dim_date', 'date_key'], ['fct_order', 'date_key']);
    expect(dragged.turned).toBe(true);
    expect(orders.errors()).toEqual([]);
    const toDate = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    expect(j.domainJson('silver/orders').logical.relationships).toEqual([TO_CUSTOMER, toDate]);

    // ⇄ rewrites this diagram's entry in place.
    await orders.send(relationshipSwap(line(orders, 'fct_order.customer_key', 'dim_customer.customer_key')).request);
    expect(orders.errors()).toEqual([]);
    expect(j.domainJson('silver/orders').logical.relationships).toEqual([
      { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' },
      toDate,
    ]);
    // The other diagram's own copy now says something different: still not a duplicate in a per-diagram project.
    const differing = await j.check();
    expect(differing.result.mode).toBe('domain');
    expect(differing.codes).toEqual(['REL006']);
    expect(differing.findings[0].files).toEqual(['.erd-studio/silver/orders.json']);
    await orders.send(relationshipSwap(line(orders, 'fct_order.customer_key', 'dim_customer.customer_key')).request);
    expect(j.domainJson('silver/orders').logical.relationships).toEqual([TO_CUSTOMER, toDate]);

    // A role and a cardinality change, in place.
    const cust = line(orders, 'fct_order.customer_key', 'dim_customer.customer_key');
    await orders.send({
      type: 'editRelationship',
      payload: {
        originalFromModel: cust.fromModel, originalFromColumn: cust.fromColumn, originalToModel: cust.toModel, originalToColumn: cust.toColumn,
        fromModel: cust.fromModel, fromColumn: cust.fromColumn, toModel: cust.toModel, toColumn: cust.toColumn,
        cardinality: 'many-to-one', role: 'buyer', ...(cust.stored ? { stored: cust.stored } : {}),
      },
    });
    await orders.send(updateCardinalityRequest(line(orders, 'fct_order.date_key', 'dim_date.date_key'), 'one-to-one'));
    expect(orders.errors()).toEqual([]);
    expect(j.domainJson('silver/orders').logical.relationships).toEqual([{ ...TO_CUSTOMER, role: 'buyer' }, { ...toDate, cardinality: 'one-to-one' }]);

    // Delete the customer line here: the other diagram keeps (and draws) its own copy.
    await orders.send(removeRelationshipRequest(line(orders, 'fct_order.customer_key', 'dim_customer.customer_key')));
    expect(orders.errors()).toEqual([]);
    expect(j.domainJson('silver/orders').logical.relationships).toEqual([{ ...toDate, cardinality: 'one-to-one' }]);
    expect(j.drawnOnDisk('silver/reporting')).toEqual([TO_CUSTOMER]);

    // Throughout: no model file was written, the other diagram file is untouched, and the mode never flipped.
    expect(modelFiles()).toEqual(modelsBefore);
    expect(j.files()['.erd-studio/silver/reporting.json']).toBe(reportingBefore);
    expect(orders.loaded().relationshipHome).toBe('domain');
    const end = await j.check();
    expect(end.code).toBe(0);
    expect(end.result.mode).toBe('domain');
    expect(end.findings).toEqual([]);
  });
});

describe('journey 3b — the per-diagram project accepts the move to the model library', () => {
  const FCT = modelYaml('fct_order', [{ name: 'order_key', pk: true }, 'customer_key', 'date_key']);
  const DIM_CUSTOMER = modelYaml('dim_customer', [{ name: 'customer_key', pk: true }]);
  const DIM_DATE = modelYaml('dim_date', [{ name: 'date_key', pk: true }]);
  const TO_CUSTOMER: Drawn = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
  const TO_DATE: Drawn = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };

  it('"Review the Move…" stores each relationship once on the fact; every diagram draws what it drew before; the project is then a library project', async () => {
    j = createJourney({
      models: { fct_order: FCT, dim_customer: DIM_CUSTOMER, dim_date: DIM_DATE },
      domains: {
        // One diagram keeps an old copy written from the dimension side.
        'silver/orders': {
          models: ['fct_order', 'dim_customer', 'dim_date'],
          relationships: [{ fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }, { ...TO_DATE }],
        },
        'silver/reporting': { models: ['fct_order', 'dim_customer'], relationships: [{ ...TO_CUSTOMER }] },
      },
    });
    const drawnBefore = { orders: sortDrawn(j.drawnOnDisk('silver/orders')), reporting: j.drawnOnDisk('silver/reporting') };
    expect(drawnBefore.orders).toEqual(sortDrawn([TO_CUSTOMER, TO_DATE]));
    const command = vscode.commands.registerCommand('erdStudio.moveRelationshipsToLibrary', () => runMoveRelationships({
      workspaceRoot: j.root, semanticDir: '.erd-studio', domainService: j.domainService, logicalModelService: j.models,
      onWritten: async () => { j.provider.markFilesRewrittenOnDisk(); await j.provider.refreshAllOpenDomains(); },
    }));
    const asked: string[] = [];
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
      asked.push(String(args[0]));
      const options = args[1] as { modal?: boolean } | undefined;
      if (options && typeof options === 'object' && options.modal) return args[args.length - 1];
      return args.includes('Review the Move…') ? 'Review the Move…' : undefined;
    }) as never);
    try {
      const orders = await j.open('silver/orders');
      await orders.send({ type: 'ready' });
      await new Promise((r) => setTimeout(r, 20));
      expect(asked[0]).toContain('Relationships can now be defined once and shared.');
      expect(asked[1]).toBe('Define each relationship once, in the model library?');

      expect(j.modelText('fct_order')).toBe(`${FCT}relationships:\n` +
        entryYaml('customer_key', 'dim_customer', 'customer_key', 'many-to-one') +
        entryYaml('date_key', 'dim_date', 'date_key', 'many-to-one'));
      expect(j.modelText('dim_customer')).toBe(DIM_CUSTOMER);
      expect(j.modelText('dim_date')).toBe(DIM_DATE);
      expect(j.domainJson('silver/orders').logical.relationships).toEqual([]);
      expect(j.domainJson('silver/reporting').logical.relationships).toEqual([]);
      expect(sortDrawn(j.drawnOnDisk('silver/orders'))).toEqual(drawnBefore.orders);
      expect(j.drawnOnDisk('silver/reporting')).toEqual(drawnBefore.reporting);
      expect(orders.loaded().relationshipHome).toBe('library');
      expect(sortDrawn(orders.drawn())).toEqual(drawnBefore.orders);

      const check = await j.check(true);
      expect(check.result.mode).toBe('library');
      expect(check.findings).toEqual([]);
      // Nothing left for either command.
      const again = await j.repair();
      expect(again.title).toBeUndefined();
    } finally {
      command.dispose();
    }
  });
});
