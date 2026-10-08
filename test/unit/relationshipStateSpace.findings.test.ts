/**
 * The minimal counterexamples the exhaustive check found (#133 fix list),
 * replayed against the REAL provider / Move command / read path, each pinned
 * as fixed. See relationshipStateSpace.model.ts for the notation.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { linkKey, mergeLibraryRelationships } from '@erd-studio/core';
import { _resetMockWorkspace } from '../__mocks__/vscode';
import type { Relationship } from '../../src/types/semantic';
import { libModels, movePlan, worldOf } from './relationshipStateSpace.model';
import type { World } from './relationshipStateSpace.model';
import { materialise, readBack, runRealMove, sendToProvider } from './relationshipStateSpace.harness';
import type { Project } from './relationshipStateSpace.harness';

const FD = { fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k' };
const L = (r: Relationship) => linkKey(r) === linkKey(FD);
const copiesOfL = (w: World) => [
  ...w.lib.dim.map((e) => `dim.yml ${e.fromColumn}→${e.toModel}.${e.toColumn} ${e.cardinality}${e.role ? ` "${e.role}"` : ''}`),
  ...w.lib.fct.filter((e) => e.fromColumn.toLowerCase() === 'k').map((e) => `fct.yml ${e.fromColumn}→${e.toModel}.${e.toColumn} ${e.cardinality}${e.role ? ` "${e.role}"` : ''}`),
  ...(['D1', 'D2', 'D3'] as const).flatMap((d) => w.dom[d].filter(L).map((r) => `${d} ${r.fromModel}.${r.fromColumn}→${r.toModel}.${r.toColumn} ${r.cardinality}${r.role ? ` "${r.role}"` : ''}`)),
];

let p: Project | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (p) fs.rmSync(p.root, { recursive: true, force: true });
  p = undefined;
});

describe('exhaustive-check findings, fixed on the real code (#133)', () => {
  it('F1: Add Existing Model keeps a link the library already stores — its role and cardinality — whatever dbt says', async () => {
    _resetMockWorkspace();
    const w = worldOf('star', [{ where: 'fct', dir: 'fd', card: 'many-to-one', role: 'order date', upper: false }], false);
    p = materialise(w);
    // D3 holds dim only; dbt declares fct.k → dim.k with both ends unique (one-to-one).
    fs.mkdirSync(path.join(p.root, 'models'), { recursive: true });
    fs.writeFileSync(path.join(p.root, 'models', 'schema.yml'), [
      'version: 2', 'models:',
      '  - name: dim', '    columns:', '      - name: k', '        tests: [unique]',
      '  - name: fct', '    columns:', '      - name: k', '        tests:', '          - unique',
      '          - relationships:', "              to: ref('dim')", '              field: k', '',
    ].join('\n'));
    const { errors } = await sendToProvider(p, { type: 'addExistingModel', payload: { modelName: 'fct' } }, 'D3');
    expect(errors).toEqual([]);
    expect(copiesOfL(readBack(p, 'star'))).toEqual(['fct.yml k→dim.k many-to-one "order date"']);
  });

  it('F2: a cardinality change keeps the role of the line drawn, and folds the 1.6.7 copy into one entry', async () => {
    _resetMockWorkspace();
    // Row 11: a 1.6.7 copy saved backwards on dim, plus the fact's own copy with a role (the one drawn).
    const w = worldOf('star', [
      { where: 'dim', dir: 'df', card: 'many-to-one', upper: false },
      { where: 'fct', dir: 'fd', card: 'many-to-one', role: 'order date', upper: false },
    ], false);
    expect(mergeLibraryRelationships(libModels(w), [])).toMatchObject([{ fromModel: 'fct', role: 'order date' }]);
    p = materialise(w);
    const { errors } = await sendToProvider(p, { type: 'updateRelationship', payload: { ...FD, cardinality: 'one-to-one' } });
    expect(errors).toEqual([]);
    expect(copiesOfL(readBack(p, 'star'))).toEqual(['fct.yml k→dim.k one-to-one "order date"']);
  });

  it('F2: ⇄ moves the line\'s role with it to the other file', async () => {
    _resetMockWorkspace();
    const w = worldOf('noKeys', [
      { where: 'dim', dir: 'df', card: 'many-to-one', upper: false },
      { where: 'fct', dir: 'fd', card: 'many-to-one', role: 'order date', upper: false },
    ], false);
    p = materialise(w);
    const { errors } = await sendToProvider(p, { type: 'updateRelationship', payload: { ...FD, cardinality: 'one-to-many' } });
    expect(errors).toEqual([]);
    expect(copiesOfL(readBack(p, 'noKeys'))).toEqual(['dim.yml k→fct.k many-to-one "order date"']);
  });

  it('F2: ⇄ refuses, changing nothing, when two copies of the link carry different roles', async () => {
    _resetMockWorkspace();
    const w = worldOf('noKeys', [
      { where: 'dim', dir: 'df', card: 'many-to-one', role: 'r2', upper: false },
      { where: 'fct', dir: 'fd', card: 'many-to-one', role: 'r1', upper: false },
    ], false);
    p = materialise(w);
    const { errors } = await sendToProvider(p, { type: 'updateRelationship', payload: { ...FD, cardinality: 'one-to-many' } });
    expect(errors).toEqual([expect.stringMatching(/saved more than once with different roles \("r2", "r1"\)|\("r1", "r2"\)/)]);
    expect(copiesOfL(readBack(p, 'noKeys')).sort()).toEqual(['dim.yml k→fct.k many-to-one "r2"', 'fct.yml k→dim.k many-to-one "r1"']);
  });

  it('F3: one Move stores a diagram copy drawn from the dimension\'s key on the fact; a second Move has nothing to do', async () => {
    _resetMockWorkspace();
    const w = worldOf('star', [{ where: 'D1', dir: 'df', card: 'many-to-one', upper: false }], false);
    expect(movePlan(w).turned).toHaveLength(1);
    p = materialise(w);
    await runRealMove(p, []);
    const once = readBack(p, 'star');
    expect(copiesOfL(once)).toEqual(['fct.yml k→dim.k many-to-one']);
    expect(movePlan(once)).toMatchObject({ toLibrary: [], rehome: [], conflicts: [] });
  });

  it('F3b: ⇄ refuses to make a whole key the "many" side, and changes nothing', async () => {
    _resetMockWorkspace();
    const w0 = worldOf('star', [{ where: 'fct', dir: 'fd', card: 'many-to-one', upper: false }], false);
    p = materialise(w0);
    const { errors } = await sendToProvider(p, { type: 'updateRelationship', payload: { ...FD, cardinality: 'one-to-many' } });
    expect(errors).toEqual([expect.stringContaining('dim.k is dim\'s key, so each value appears only once — it can\'t be the "many" side. Unmark it as a key first')]);
    expect(copiesOfL(readBack(p, 'star'))).toEqual(['fct.yml k→dim.k many-to-one']);
  });

  it('F4: Move takes a turned-round entry out by itself, never the other copy of the link in the same file', async () => {
    _resetMockWorkspace();
    // The one-to-many would make dim.k (dim's whole key) the many side: keys win, so it is the fact's many-to-one again.
    const w = worldOf('star', [
      { where: 'fct', dir: 'fd', card: 'many-to-one', role: 'order date', upper: false },
      { where: 'fct', dir: 'fd', card: 'one-to-many', upper: false },
    ], false);
    expect(movePlan(w).rehome).toHaveLength(1);
    p = materialise(w);
    await runRealMove(p, []);
    expect(copiesOfL(readBack(p, 'star'))).toEqual(['fct.yml k→dim.k many-to-one "order date"']);
  });

  it('F4: without keys, two copies in one file that disagree are both left, and listed', async () => {
    _resetMockWorkspace();
    const w = worldOf('noKeys', [
      { where: 'fct', dir: 'fd', card: 'many-to-one', role: 'order date', upper: false },
      { where: 'fct', dir: 'fd', card: 'one-to-many', upper: false },
    ], false);
    expect(movePlan(w).disagreements).toHaveLength(1);
    p = materialise(w);
    await runRealMove(p, []);
    expect(copiesOfL(readBack(p, 'noKeys'))).toEqual(['fct.yml k→dim.k many-to-one "order date"', 'fct.yml k→dim.k one-to-many']);
  });

  it('F5: two diagrams labelling the same link differently is a conflict; the picked label is kept', async () => {
    _resetMockWorkspace();
    const w = worldOf('star', [
      { where: 'D1', dir: 'fd', card: 'many-to-one', role: 'r1', upper: false },
      { where: 'D2', dir: 'fd', card: 'many-to-one', role: 'r2', upper: false },
    ], false);
    const [conflict] = movePlan(w).conflicts;
    expect(conflict.definitions.map((d) => [d.relationship.role, d.domains])).toEqual([['r1', ['D1']], ['r2', ['D2']]]);
    p = materialise(w);
    await runRealMove(p, [conflict.definitions[1]]);
    expect(copiesOfL(readBack(p, 'star'))).toEqual(['fct.yml k→dim.k many-to-one "r2"']);
  });

  it('F6: a one-to-one drawn from opposite ends is a conflict over which end holds the foreign key', async () => {
    _resetMockWorkspace();
    const w = worldOf('star', [
      { where: 'D1', dir: 'df', card: 'one-to-one', upper: false },
      { where: 'D2', dir: 'fd', card: 'one-to-one', upper: false },
    ], false);
    const [conflict] = movePlan(w).conflicts;
    expect(conflict.definitions.map((d) => `${d.relationship.fromModel} ${d.domains}`)).toEqual(['dim D1', 'fct D2']);
    expect(movePlan(w, ['D2', 'D1', 'D3']).conflicts[0].definitions.map((d) => d.relationship.fromModel)).toEqual(['dim', 'fct']);
    p = materialise(w);
    await runRealMove(p, [conflict.definitions[1]]);
    expect(copiesOfL(readBack(p, 'star'))).toEqual(['fct.yml k→dim.k one-to-one']);
  });

  it('F6: a many-to-many drawn opposite ways round is one link, stored from its lower end', () => {
    const w = worldOf('star', [
      { where: 'D1', dir: 'fd', card: 'many-to-many', upper: false },
      { where: 'D2', dir: 'df', card: 'many-to-many', upper: false },
    ], false);
    const plan = movePlan(w);
    expect([plan.conflicts, plan.toLibrary.map((r) => r.fromModel)]).toEqual([[], ['dim']]);
  });

  it('F7: Move leaves one canonical copy carrying the diagram\'s role when it turns the 1.6.7 library copy round', async () => {
    _resetMockWorkspace();
    const w = worldOf('star', [
      { where: 'dim', dir: 'df', card: 'many-to-one', upper: false },
      { where: 'D1', dir: 'fd', card: 'many-to-one', role: 'order date', upper: false },
    ], false);
    p = materialise(w);
    await runRealMove(p, []);
    const after = readBack(p, 'star');
    expect(copiesOfL(after)).toEqual(['fct.yml k→dim.k many-to-one "order date"']);
    expect(mergeLibraryRelationships(libModels(after), after.dom.D1).find(L)?.role).toBe('order date');
  });

  it('D1: a link stored twice in one diagram file is drawn once, from the same copy in either order', () => {
    const w = worldOf('star', [
      { where: 'D1', dir: 'fd', card: 'many-to-one', upper: false },
      { where: 'D1', dir: 'df', card: 'one-to-one', upper: false },
    ], false);
    const drawn = mergeLibraryRelationships(libModels(w), w.dom.D1);
    expect(drawn).toHaveLength(1);
    expect(mergeLibraryRelationships(libModels(w), [...w.dom.D1].reverse())).toEqual(drawn);
  });

  it('D1: re-keying a link a diagram file holds twice moves both copies', async () => {
    _resetMockWorkspace();
    const w = worldOf('star', [
      { where: 'D1', dir: 'fd', card: 'many-to-one', upper: false },
      { where: 'D1', dir: 'fd', card: 'many-to-one', upper: false },
    ], false);
    p = materialise(w);
    const { errors } = await sendToProvider(p, {
      type: 'editRelationship',
      payload: { originalFromModel: 'fct', originalFromColumn: 'k', originalToModel: 'dim', originalToColumn: 'k', ...FD, fromColumn: 'k2', cardinality: 'many-to-one' },
    });
    expect(errors).toEqual([]);
    expect(readBack(p, 'star').dom.D1).toEqual([{ ...FD, fromColumn: 'k2', cardinality: 'many-to-one' }]);
  });

  it('D2: Move lists a diagram copy that disagrees with the model library before taking it out', () => {
    const w = worldOf('star', [
      { where: 'fct', dir: 'fd', card: 'many-to-one', upper: false },
      { where: 'D1', dir: 'fd', card: 'one-to-one', upper: false },
    ], false);
    expect(movePlan(w).keptLibrary).toMatchObject([{ domain: 'D1', relationship: { cardinality: 'one-to-one' }, library: { cardinality: 'many-to-one' } }]);
  });

  it('D3: deleting a link tells the user which other diagram still draws its own copy, and leaves that copy', async () => {
    _resetMockWorkspace();
    // The bystander in fct.yml makes this a model-library project.
    const w = worldOf('star', [
      { where: 'D1', dir: 'fd', card: 'many-to-one', upper: false },
      { where: 'D2', dir: 'fd', card: 'many-to-one', upper: false },
    ], true);
    p = materialise(w);
    const { errors, infos } = await sendToProvider(p, { type: 'removeRelationship', payload: FD });
    expect(errors).toEqual([]);
    expect(infos).toEqual([expect.stringMatching(/The diagram silver\/D2 still draws this relationship from a copy of its own/)]);
    expect(copiesOfL(readBack(p, 'star'))).toEqual(['D2 fct.k→dim.k many-to-one']);
  });
});
