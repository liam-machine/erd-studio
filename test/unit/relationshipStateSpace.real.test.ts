/**
 * Keeps relationshipStateSpace.model.ts honest: the same states and canvas
 * messages, sent to the real SemanticEditorProvider over real files (through
 * the vscode mock), and the real Move command — the files it leaves must be
 * the files the model predicts, and the invariants must hold on them.
 *
 * CI runs a light sample (every STATESPACE_REAL_EVERY-th small-scope state,
 * default 211; ~20 s). `STATESPACE_REAL_EVERY=1` checks every state.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import { _resetMockWorkspace } from '../__mocks__/vscode';
import {
  checkMove, checkOp, describeState, messageOf, moveApply, movePlan, opsFor, pickLabel, pickSets, states, worldOf,
} from './relationshipStateSpace.model';
import type { State, Violation } from './relationshipStateSpace.model';
import { materialise, norm, readBack, runRealMove, sendToProvider } from './relationshipStateSpace.harness';

/** A fixed, spread-out sample: every n-th state. */
function sample(every: number): State[] {
  const out: State[] = [];
  let i = 0;
  for (const s of states('small')) if (i++ % every === 0) out.push(s);
  return out;
}

describe('relationshipStateSpace model vs the real provider and Move command', () => {
  it('predicts exactly the files each canvas edit and each Move leaves', async () => {
    const t0 = Date.now();
    const every = Number(process.env.STATESPACE_REAL_EVERY ?? 211);
    const mismatches: string[] = [];
    const violations: string[] = [];
    let runs = 0;
    const note = (s: State, op: string, vs: Violation[]): void => {
      for (const [inv, detail] of vs) violations.push(`${inv} :: ${op} — ${describeState(s)}: ${detail}`);
    };
    for (const s of sample(every)) {
      const w = worldOf(s.profile, s.copies, s.bystander);
      for (const op of opsFor(w)) {
        if (!op.call) continue;
        _resetMockWorkspace();
        const p = materialise(w);
        try {
          const before = readBack(p, w.profile);
          const predicted = op.run(before);
          const { errors, infos } = await sendToProvider(p, messageOf(op.call));
          const actual = readBack(p, w.profile);
          runs += 1;
          const notice = (['D1', 'D2', 'D3'] as const).filter((d) => infos.some((m) => m.includes(`silver/${d}`)));
          if (errors.length === 0) note(s, op.name, checkOp(w, op, actual, { world: actual, notice }));
          if (norm(actual) !== norm(predicted.world) || !!predicted.error !== errors.length > 0) {
            mismatches.push(`${describeState(s)} / ${op.name}\n   model: ${predicted.error ?? norm(predicted.world)}\n   real:  ${errors.join('; ') || norm(actual)}`);
          }
        } finally {
          vi.restoreAllMocks();
          fs.rmSync(p.root, { recursive: true, force: true });
        }
      }
      // The Move, with every pick.
      const plan = movePlan(w);
      for (const picks of pickSets(plan)) {
        _resetMockWorkspace();
        const p = materialise(w);
        try {
          const predicted = moveApply(readBack(p, w.profile), plan, picks);
          await runRealMove(p, picks);
          const actual = readBack(p, w.profile);
          runs += 1;
          note(s, `move${pickLabel(picks)}`, checkMove(w, plan, picks, actual));
          if (norm(actual) !== norm(predicted.world)) {
            mismatches.push(`${describeState(s)} / move${pickLabel(picks)}\n   model: ${norm(predicted.world)}\n   real:  ${norm(actual)}`);
          }
        } finally {
          vi.restoreAllMocks();
          fs.rmSync(p.root, { recursive: true, force: true });
        }
      }
    }
    // eslint-disable-next-line no-console
    if (process.env.EXHAUSTIVE_REPORT) console.log(`real runs ${runs}, ${Date.now() - t0} ms`);
    expect(runs).toBeGreaterThan(100);
    expect(mismatches.slice(0, 20)).toEqual([]);
    expect(violations.slice(0, 20)).toEqual([]);
  }, 600_000);
});
