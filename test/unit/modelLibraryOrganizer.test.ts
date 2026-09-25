/**
 * Tests for the pure "Organise Model Library by Layer" planner (issue #76).
 */
import { describe, it, expect } from 'vitest';

import { describeOrganizePlan, planOrganizeByLayer, type OrganizePlan } from '../../src/services/modelLibraryOrganizer';
import type { ModelFileEntry } from '../../src/services/logicalModelService';

const DIR = '/p/.erd-studio/logical-models';
const top = (name: string): ModelFileEntry => ({ name, folder: '', filePath: `${DIR}/${name}.yml` });
const inFolder = (folder: string, name: string, shadowedBy?: string): ModelFileEntry => ({
  name,
  folder,
  filePath: `${DIR}/${folder}/${name}.yml`,
  ...(shadowedBy ? { shadowedBy } : {}),
});
const target = (name: string, layer: string): string => `${DIR}/${layer}/${name}.yml`;

describe('planOrganizeByLayer', () => {
  it('moves a top-level model used only by one layer into that layer\'s folder', () => {
    const plan = planOrganizeByLayer(
      [top('dim_customer'), top('fct_order')],
      [
        { layer: 'silver', modelNames: ['dim_customer'] },
        { layer: 'silver', modelNames: ['dim_customer', 'fct_order'] },
      ],
      target,
    );
    expect(plan.moves).toEqual([
      { name: 'dim_customer', layer: 'silver', from: `${DIR}/dim_customer.yml`, to: `${DIR}/silver/dim_customer.yml` },
      { name: 'fct_order', layer: 'silver', from: `${DIR}/fct_order.yml`, to: `${DIR}/silver/fct_order.yml` },
    ]);
    expect(plan.shared).toEqual([]);
    expect(plan.unused).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it('keeps a model used by more than one layer at the top level, listing its layers sorted', () => {
    const plan = planOrganizeByLayer(
      [top('dim_date'), top('rpt_sales')],
      [
        { layer: 'silver', modelNames: ['dim_date'] },
        { layer: 'gold', modelNames: ['dim_date', 'rpt_sales'] },
      ],
      target,
    );
    expect(plan.shared).toEqual([{ name: 'dim_date', layers: ['gold', 'silver'] }]);
    expect(plan.moves.map((m) => [m.name, m.layer])).toEqual([['rpt_sales', 'gold']]);
  });

  it('keeps a model no domain references at the top level as unused', () => {
    const plan = planOrganizeByLayer([top('dim_orphan')], [{ layer: 'silver', modelNames: ['elsewhere'] }], target);
    expect(plan.unused).toEqual(['dim_orphan']);
    expect(plan.moves).toEqual([]);
  });

  it('reports a conflict when the layer folder already has a file of that name', () => {
    const plan = planOrganizeByLayer(
      [top('dim_customer'), inFolder('silver', 'dim_customer', `${DIR}/dim_customer.yml`)],
      [{ layer: 'silver', modelNames: ['dim_customer'] }],
      target,
    );
    expect(plan.conflicts).toEqual([{ name: 'dim_customer', layer: 'silver' }]);
    expect(plan.moves).toEqual([]);
  });

  it('a same-named file in a DIFFERENT folder is not a conflict', () => {
    const plan = planOrganizeByLayer(
      [top('dim_customer'), inFolder('gold', 'dim_customer', `${DIR}/dim_customer.yml`)],
      [{ layer: 'silver', modelNames: ['dim_customer'] }],
      target,
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.moves.map((m) => m.to)).toEqual([`${DIR}/silver/dim_customer.yml`]);
  });

  it('moves a file out of another layer\'s folder into the one layer that now uses it', () => {
    const plan = planOrganizeByLayer(
      [inFolder('gold', 'rpt_sales'), inFolder('silver', 'dim_gold_used')],
      [
        { layer: 'silver', modelNames: ['rpt_sales'] },
        { layer: 'gold', modelNames: ['dim_gold_used'] },
      ],
      target,
      new Set(['silver', 'gold']),
    );
    expect(plan.moves).toEqual([
      { name: 'dim_gold_used', layer: 'gold', from: `${DIR}/silver/dim_gold_used.yml`, to: target('dim_gold_used', 'gold'), fromFolder: 'silver' },
      { name: 'rpt_sales', layer: 'silver', from: `${DIR}/gold/rpt_sales.yml`, to: target('rpt_sales', 'silver'), fromFolder: 'gold' },
    ]);
  });

  it('leaves a file that is already in its layer\'s folder, or in a layer folder but now shared or unused', () => {
    const plan = planOrganizeByLayer(
      [inFolder('gold', 'fct_ok'), inFolder('gold', 'dim_shared'), inFolder('silver', 'dim_orphan')],
      [
        { layer: 'gold', modelNames: ['fct_ok', 'dim_shared'] },
        { layer: 'silver', modelNames: ['dim_shared'] },
      ],
      target,
      new Set(['silver', 'gold']),
    );
    expect(plan).toEqual({ moves: [], shared: [], unused: [], conflicts: [], otherFolders: [] });
  });

  it('never touches a folder that is not a configured layer, and reports it', () => {
    const plan = planOrganizeByLayer(
      [inFolder('Staging', 'rpt_a'), inFolder('Staging', 'rpt_b'), inFolder('old_gold', 'fct_x')],
      [{ layer: 'gold', modelNames: ['rpt_a', 'fct_x'] }],
      target,
      new Set(['silver', 'gold']),
    );
    expect(plan.moves).toEqual([]);
    expect(plan.otherFolders).toEqual([{ folder: 'old_gold', count: 1 }, { folder: 'Staging', count: 2 }]);
  });

  it('skips shadowed entries', () => {
    const plan = planOrganizeByLayer(
      // A shadowed top-level entry cannot exist in practice (top level wins),
      // but the planner must skip any shadowed entry regardless.
      [{ ...top('dim_shadow'), shadowedBy: `${DIR}/elsewhere/dim_shadow.yml` }, inFolder('gold', 'dim_shadow2', `${DIR}/dim_shadow2.yml`)],
      [{ layer: 'silver', modelNames: ['dim_shadow', 'dim_shadow2'] }],
      target,
      new Set(['silver', 'gold']),
    );
    expect(plan).toEqual({ moves: [], shared: [], unused: [], conflicts: [], otherFolders: [] });
  });

  it('treats a layer whose targetPath is null as shared (nowhere safe to put it)', () => {
    const plan = planOrganizeByLayer(
      [top('dim_x')],
      [{ layer: 'Bad Layer', modelNames: ['dim_x'] }],
      (name, layer) => (layer === 'Bad Layer' ? null : target(name, layer)),
    );
    expect(plan.moves).toEqual([]);
    expect(plan.shared).toEqual([{ name: 'dim_x', layers: ['Bad Layer'] }]);
  });

  it('orders every list by model name, whatever the input order', () => {
    const plan = planOrganizeByLayer(
      [top('zz'), top('bb'), top('aa'), top('yy'), top('cc'), top('xx')],
      [
        { layer: 'silver', modelNames: ['zz', 'aa'] },
        { layer: 'gold', modelNames: ['yy', 'xx'] },
        { layer: 'silver', modelNames: ['yy', 'xx'] },
      ],
      target,
    );
    expect(plan.moves.map((m) => m.name)).toEqual(['aa', 'zz']);
    expect(plan.shared.map((s) => s.name)).toEqual(['xx', 'yy']);
    expect(plan.unused).toEqual(['bb', 'cc']);
  });

  it('counts a layer once even when several of its domains use the model', () => {
    const plan = planOrganizeByLayer(
      [top('dim_a')],
      [
        { layer: 'gold', modelNames: ['dim_a'] },
        { layer: 'gold', modelNames: ['dim_a', 'dim_a'] },
      ],
      target,
    );
    expect(plan.moves.map((m) => m.layer)).toEqual(['gold']);
  });
});

describe('describeOrganizePlan', () => {
  const move = (name: string, layer: string) => ({ name, layer, from: `${DIR}/${name}.yml`, to: target(name, layer) });

  it('summarises moves per layer and what stays, then notes domain files are untouched', () => {
    const plan: OrganizePlan = {
      moves: [move('a', 'silver'), move('b', 'silver'), move('c', 'gold')],
      shared: [{ name: 'd', layers: ['gold', 'silver'] }],
      unused: ['e', 'f'],
      conflicts: [{ name: 'g', layer: 'silver' }],
      otherFolders: [],
    };
    expect(describeOrganizePlan(plan)).toBe([
      'Move 3 models into layer folders (1 → gold/, 2 → silver/).',
      'Staying at the top of logical-models/: 1 model used by more than one layer (d); 2 unused models (e, f); ' +
        '1 model whose layer folder already has a file of that name (g).',
      'Domain files reference models by name, so no domain file changes.',
    ].join('\n\n'));
  });

  it('uses the singular for one move and omits the staying line when nothing stays', () => {
    const text = describeOrganizePlan({ moves: [move('a', 'gold')], shared: [], unused: [], conflicts: [], otherFolders: [] });
    expect(text).toBe(
      'Move 1 model into layer folders (1 → gold/).\n\nDomain files reference models by name, so no domain file changes.',
    );
  });

  it('describes a plan with nothing to move', () => {
    const text = describeOrganizePlan({ moves: [], shared: [], unused: ['x'], conflicts: [], otherFolders: [] });
    expect(text).not.toContain('Move ');
    expect(text).toContain('Staying at the top of logical-models/: 1 unused model (x).');
  });

  it('names at most three models per group', () => {
    const text = describeOrganizePlan({ moves: [], shared: [], unused: ['a', 'b', 'c', 'd', 'e'], conflicts: [], otherFolders: [] });
    expect(text).toContain('5 unused models (a, b, c and 2 more)');
  });

  it('explains files moving out of another layer\'s folder and folders it leaves alone', () => {
    const text = describeOrganizePlan({
      moves: [{ ...move('rpt_sales', 'silver'), fromFolder: 'gold' }, move('dim_a', 'silver')],
      shared: [],
      unused: [],
      conflicts: [],
      otherFolders: [{ folder: 'Staging', count: 2 }],
    });
    expect(text).toContain('Move 2 models into layer folders (2 → silver/).');
    expect(text).toContain("One is in another layer's folder, because the domains that use it are now in a different layer (rpt_sales: gold/ → silver/).");
    expect(text).toContain('Left alone: folders that are not a layer in layers.json — Staging/ (2).');
  });
});
