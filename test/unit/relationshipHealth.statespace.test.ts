/**
 * relationshipHealth over the exhaustive checker's universes (#133): the
 * self-check must stay silent on every write the real planner makes and on
 * every Move, because the exhaustive checker (whose ALLOWED list is empty)
 * already holds them sound. A `relInv*` error is only worth having if it
 * never fires on correct code — this is the false-positive guard.
 *
 * Small scope only (as CI runs the checker), sampled by state so it stays a
 * few seconds.
 */

import { describe, expect, it } from 'vitest';

import { applyMoveToModel, moveTargets, planRelationshipWrite, resolveConflict, usesLibraryRelationships } from '../../src/services/libraryRelationships';
import type { RelationshipWriteInput, RelationshipWriteOp, MoveToLibraryPlan, ConflictDefinition } from '../../src/services/libraryRelationships';
import { auditRelationshipWrite, checkLibraryRewrite } from '../../src/services/relationshipHealth';
import type { SemanticModel } from '../../src/types/semantic';
import {
  clone, dbtIndex, describeState, libModels, libraryMode, movePlan, opsFor, pickSets, states, worldOf,
} from './relationshipStateSpace.model';
import type { HostCall, World } from './relationshipStateSpace.model';
import {
  L, gDraw, gModels, gMovePlan, gPickSets, groupStates, groupWorld, selfStates, selfWorld, describeGroup, describeSelf,
} from './relationshipStateSpace.universes';
import type { GWorld } from './relationshipStateSpace.universes';
import { linkKey } from '@erd-studio/core';

const plannerOp = (c: HostCall): RelationshipWriteOp => {
  switch (c.kind) {
    case 'add': return { kind: 'add', drawn: c.p };
    case 'update': return { kind: 'update', ends: c.p, cardinality: c.p.cardinality };
    case 'edit': return { kind: 'edit', original: c.original, drawn: c.p };
    case 'remove': return { kind: 'remove', keys: c.keys };
  }
};

/** The audit of one write, as the provider runs it; null when the planner refuses. */
function audit(op: RelationshipWriteOp, input: RelationshipWriteInput): string[] | null {
  const plan = planRelationshipWrite(op, input);
  if (!plan.ok) return null;
  return auditRelationshipWrite(op, input, plan).broken;
}

/** The Move's rewrite of `models` under `plan`, checked as the command checks it. */
function moveCheck(models: SemanticModel[], plan0: MoveToLibraryPlan, picks: Array<ConflictDefinition | undefined>): string[] {
  let plan = plan0;
  plan0.conflicts.forEach((c, i) => { if (picks[i]) plan = resolveConflict(plan, c, picks[i]!); });
  const before: SemanticModel[] = [];
  const after: SemanticModel[] = [];
  for (const name of moveTargets(plan)) {
    const model = models.find((m) => m.name === name.toLowerCase());
    if (!model) continue;
    const copy: SemanticModel = { ...clone(model), relationships: model.relationships ? clone(model.relationships) : undefined };
    before.push(clone(model));
    applyMoveToModel(plan, copy);
    after.push(copy);
  }
  return checkLibraryRewrite(before, after, [...plan.toLibrary, ...plan.rehome.map((r) => r.to)]);
}

const SAMPLE = Number(process.env.HEALTH_SAMPLE ?? 7);

describe('relationshipHealth — silent on every sound write (false-positive guard)', () => {
  it('the main universe: every canvas edit and every Move', () => {
    const found: string[] = [];
    let audited = 0;
    let i = 0;
    for (const s of states('small')) {
      if (i++ % SAMPLE !== 0) continue;
      const w: World = worldOf(s.profile, s.copies, s.bystander);
      for (const op of opsFor(w, 'D1', { renames: false })) {
        if (!op.call) continue;
        const d = op.call.d ?? 'D1';
        const input: RelationshipWriteInput = {
          home: libraryMode(w) ? 'library' : 'domain', models: libModels(w), domainRelationships: clone(w.dom[d]), dbt: dbtIndex(w),
        };
        const broken = audit(plannerOp(op.call), input);
        if (broken === null) continue;
        audited++;
        if (broken.length > 0) found.push(`${broken.join(',')} :: ${op.name} :: ${describeState(s)}`);
      }
      const plan = movePlan(w);
      for (const picks of pickSets(plan)) {
        audited++;
        const broken = moveCheck(libModels(w), plan, picks);
        if (broken.length > 0) found.push(`${broken.join(',')} :: move :: ${describeState(s)}`);
      }
    }
    expect(audited).toBeGreaterThan(500);
    expect(found.slice(0, 10)).toEqual([]);
  });

  const gHome = (w: GWorld): 'library' | 'domain' =>
    (usesLibraryRelationships(gModels(w), w.dom.D1.length + w.dom.D2.length + w.dom.D3.length) ? 'library' : 'domain');

  it('composite keys: ⇄, edit, delete, regroup, add and Move act on the group', () => {
    const found: string[] = [];
    let audited = 0;
    for (const copies of groupStates()) {
      const w = groupWorld(copies);
      const input: RelationshipWriteInput = { home: gHome(w), models: gModels(w), domainRelationships: clone(w.dom.D1) };
      const line = gDraw(w, 'D1').find((r) => linkKey(r) === L);
      const ops: Array<[string, RelationshipWriteOp]> = [];
      const pairX = { fromColumn: 'k_x', toColumn: 'k_x' };
      if (line) {
        const ends = { fromModel: line.fromModel, fromColumn: line.fromColumn, toModel: line.toModel, toColumn: line.toColumn };
        const grouped = !!line.compositeKey;
        for (const card of ['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many'] as const) ops.push([`set ${card}`, { kind: 'update', ends, cardinality: card }]);
        ops.push(['edit role', { kind: 'edit', original: ends, drawn: { ...ends, cardinality: line.cardinality, role: 'r1' }, ...(grouped ? { extraPairs: [pairX] } : {}) }]);
        ops.push(['delete', { kind: 'remove', keys: [ends] }]);
        ops.push([grouped ? 'edit: drop pair' : 'edit: add pair', { kind: 'edit', original: ends, drawn: { ...ends, cardinality: line.cardinality }, ...(grouped ? {} : { extraPairs: [pairX] }) }]);
      } else {
        ops.push(['add composite from fct', { kind: 'add', drawn: { fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one' }, extraPairs: [pairX] }]);
        ops.push(['add composite from dim', { kind: 'add', drawn: { fromModel: 'dim', fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-many' }, extraPairs: [pairX] }]);
      }
      for (const [name, op] of ops) {
        const broken = audit(op, input);
        if (broken === null) continue;
        audited++;
        if (broken.length > 0) found.push(`${broken.join(',')} :: ${name} :: ${describeGroup(copies)}`);
      }
      const plan = gMovePlan(w);
      for (const picks of gPickSets(plan)) {
        audited++;
        const broken = moveCheck(gModels(w), plan, picks);
        if (broken.length > 0) found.push(`${broken.join(',')} :: move :: ${describeGroup(copies)}`);
      }
    }
    expect(audited).toBeGreaterThan(200);
    expect(found.slice(0, 10)).toEqual([]);
  });

  it('self-references: add, ⇄, turn round, delete and Move', () => {
    const found: string[] = [];
    let audited = 0;
    for (const { profile, copies } of selfStates()) {
      const w = selfWorld(profile, copies);
      const input: RelationshipWriteInput = { home: gHome(w), models: gModels(w), domainRelationships: clone(w.dom.D1) };
      const line = gDraw(w, 'D1').find((r) => r.fromModel === 'emp' && r.toModel === 'emp');
      const ops: Array<[string, RelationshipWriteOp]> = [];
      if (line) {
        const ends = { fromModel: 'emp', fromColumn: line.fromColumn, toModel: 'emp', toColumn: line.toColumn };
        for (const card of ['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many'] as const) ops.push([`set ${card}`, { kind: 'update', ends, cardinality: card }]);
        ops.push(['turn round', { kind: 'edit', original: ends, drawn: { fromModel: 'emp', fromColumn: line.toColumn, toModel: 'emp', toColumn: line.fromColumn, cardinality: line.cardinality } }]);
        ops.push(['delete', { kind: 'remove', keys: [ends] }]);
      } else {
        for (const card of ['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many'] as const) {
          ops.push([`add ${card}`, { kind: 'add', drawn: { fromModel: 'emp', fromColumn: 'mgr', toModel: 'emp', toColumn: 'id', cardinality: card } }]);
        }
      }
      for (const [name, op] of ops) {
        const broken = audit(op, input);
        if (broken === null) continue;
        audited++;
        if (broken.length > 0) found.push(`${broken.join(',')} :: ${name} :: ${describeSelf(profile, copies)}`);
      }
      const plan = gMovePlan(w);
      for (const picks of gPickSets(plan)) {
        audited++;
        const broken = moveCheck(gModels(w), plan, picks);
        if (broken.length > 0) found.push(`${broken.join(',')} :: move :: ${describeSelf(profile, copies)}`);
      }
    }
    expect(audited).toBeGreaterThan(50);
    expect(found.slice(0, 10)).toEqual([]);
  });
});
