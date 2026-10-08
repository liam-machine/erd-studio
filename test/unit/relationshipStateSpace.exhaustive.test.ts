/**
 * Bounded exhaustive check of relationship storage (#133): every small state,
 * every operation, every invariant. See relationshipStateSpace.model.ts.
 *
 * CI runs the small scope (≤2 copies, roles none/r1, lower case; ~15 s) and
 * fails on any violation not in ALLOWED. `STATESPACE_SCOPE=full` widens it
 * (3 copies, a second role, upper-case spellings); `STATESPACE_BFS=1` adds the
 * search over operation sequences from clean projects (depth STATESPACE_DEPTH,
 * default 3). `EXHAUSTIVE_REPORT=<file>` writes the report.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';

import {
  L_KEY, SWAP, checkMove, checkOp, describeState, draw, drawnAs, factOf, factText, hostUpdate, libraryMode, linkKey,
  moveApply, movePlan, opsFor, pickLabel, pickSets, readInvariants, states, storedCopies, weight, worldOf,
} from './relationshipStateSpace.model';
import type { Ends, Found, State, Violation, World } from './relationshipStateSpace.model';

/**
 * Violations still accepted, by signature, each with its reason. Empty: every
 * item of the #133 fix list has landed (L4's case-only renames, L5's renames
 * of another diagram's own copy).
 */
const ALLOWED: Record<string, string> = {};

const signature = (s: State, inv: string, op: string): string => {
  const dupInFile = new Set(s.copies.map((c) => c.where)).size < s.copies.length;
  return `${inv}${dupInFile ? ' [dup-in-file]' : ''} :: ${op.replace(/ r1$/, '').replace(/[a-z]+→[a-z]+ /, '').replace(/→ (none|r1|r2)/, '→ role')}`;
};

describe('relationship storage — bounded exhaustive check (#133)', () => {
  it('checks every small state against every operation', () => {
    const t0 = Date.now();
    const scope = process.env.STATESPACE_SCOPE === 'full' ? 'full' : 'small';
    const found = new Map<string, Found>();
    let stateCount = 0;
    let opCount = 0;
    let checkCount = 0;
    const record = (s: State, op: string, vs: Violation[]): void => {
      checkCount += 1;
      for (const [inv, detail] of vs) {
        const sig = signature(s, inv, op);
        const w = weight(s);
        const prev = found.get(sig);
        if (!prev) found.set(sig, { count: 1, weight: w, state: describeState(s), op, detail });
        else {
          prev.count += 1;
          if (w < prev.weight) Object.assign(prev, { weight: w, state: describeState(s), op, detail });
        }
      }
    };

    for (const s of states(scope)) {
      stateCount += 1;
      const w = worldOf(s.profile, s.copies, s.bystander);
      record(s, 'read', readInvariants(w));

      for (const op of opsFor(w)) {
        opCount += 1;
        const res = op.run(w);
        if (res.error) {
          record(s, op.name, JSON.stringify(res.world) === JSON.stringify(w) ? [] : [['refusal-changed-world', res.error]]);
          continue;
        }
        record(s, op.name, checkOp(w, op, res.world, res));
      }

      // I6: ⇄ twice is a round trip.
      const line = drawnAs(draw(w, 'D1'), L_KEY);
      if (line && (line.cardinality === 'many-to-one' || line.cardinality === 'one-to-many')) {
        opCount += 2;
        const ends: Ends = { fromModel: line.fromModel, fromColumn: line.fromColumn, toModel: line.toModel, toColumn: line.toColumn };
        const once = hostUpdate(w, { ...ends, cardinality: SWAP[line.cardinality] });
        const l2 = once.error ? undefined : drawnAs(draw(once.world, 'D1'), L_KEY);
        if (l2) {
          const twice = hostUpdate(once.world, { fromModel: l2.fromModel, fromColumn: l2.fromColumn, toModel: l2.toModel, toColumn: l2.toColumn, cardinality: SWAP[l2.cardinality] });
          const l3 = twice.error ? undefined : drawnAs(draw(twice.world, 'D1'), L_KEY);
          const vs: Violation[] = [];
          // The way back may be refused (keys win) — a refusal changes nothing.
          if (twice.error) vs.push(...(JSON.stringify(twice.world) === JSON.stringify(once.world) ? [] : [['refusal-changed-world', twice.error] as Violation]));
          // Folding a stale copy may show the role it carried on a line drawn without one.
          else if (!l3 || (factText(factOf(l3)) !== factText(factOf(line)) && !(line.role === undefined && l3.role
            && storedCopies(w).some((c) => linkKey(c.rel) === L_KEY && c.rel.role === l3.role)
            && factText(factOf({ ...l3, role: undefined })) === factText(factOf(line))))) vs.push(['I6 swap-round-trip', `${factText(factOf(line))} → ${l3 ? factText(factOf(l3)) : 'nothing'}`]);
          else if (libraryMode(w)) {
            // Spelling aside: a write respells the entry it touches (L4, checked by C2).
            const libL = (x: World) => storedCopies(x).filter((c) => c.file.endsWith('.yml') && linkKey(c.rel) === L_KEY).map((c) => `${c.file}:${JSON.stringify(c.rel)}`.toLowerCase());
            const canonicalBefore = libL(w).length === 1 && w.dom.D1.every((r) => linkKey(r) !== L_KEY) && line.cardinality === 'many-to-one';
            if (canonicalBefore && JSON.stringify(libL(twice.world)) !== JSON.stringify(libL(w))) {
              vs.push(['I6 swap-round-trip', `stored ${libL(w)} became ${libL(twice.world)}`]);
            }
          }
          record(s, 'swap ⇄ twice', vs);
        }
      }

      // Move: plan, every combination of conflict picks, apply; then again.
      const plan = movePlan(w);
      for (const picks of pickSets(plan)) {
        opCount += 1;
        record(s, `move${pickLabel(picks)}`, checkMove(w, plan, picks, moveApply(w, plan, picks).world));
      }
    }

    const ms = Date.now() - t0;
    const rows = [...found.entries()].sort((x, y) => x[0].localeCompare(y[0]));
    const lines = [
      `scope ${scope}: states ${stateCount}, operations ${opCount}, checks ${checkCount}, ${ms} ms`,
      `${rows.length} distinct violation signatures (${rows.filter(([sig]) => ALLOWED[sig]).length} allowed)`,
      ...rows.map(([sig, f]) => `\n${ALLOWED[sig] ? '○' : '●'} ${sig}  (×${f.count})\n    state: ${f.state}\n    op:    ${f.op}\n    got:   ${f.detail}`),
    ];
    if (process.env.EXHAUSTIVE_REPORT) fs.writeFileSync(process.env.EXHAUSTIVE_REPORT, lines.join('\n') + '\n');
    const unexpected = rows.filter(([sig]) => !ALLOWED[sig]);
    if (unexpected.length > 0) {
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));
    }
    expect(stateCount).toBeGreaterThan(1000);
    expect(unexpected.map(([sig, f]) => `${sig} — ${f.state} / ${f.op}: ${f.detail}`)).toEqual([]);
  }, 600_000);

  it.runIf(!!process.env.STATESPACE_BFS)('explores every state reachable from clean projects (BFS over operation sequences)', () => {
    const t0 = Date.now();
    const depth = Number(process.env.STATESPACE_DEPTH ?? 3);
    const seeds: Array<[string, World]> = [
      ['fresh project', worldOf('star', [], false)],
      ['library project with another link', worldOf('star', [], true)],
      ['per-diagram project', worldOf('star', [{ where: 'D1', dir: 'fd', card: 'many-to-one', upper: false }], false)],
      ['per-diagram project, drawn from the dimension (1.6.7)', worldOf('star', [{ where: 'D1', dir: 'df', card: 'many-to-one', upper: false }], false)],
      ['1.6.7 library, saved on the dimension', worldOf('star', [{ where: 'dim', dir: 'df', card: 'many-to-one', upper: false }], false)],
      ['1.6.7 library, saved at both ends', worldOf('star', [
        { where: 'dim', dir: 'df', card: 'many-to-one', upper: false }, { where: 'fct', dir: 'fd', card: 'many-to-one', upper: false }], false)],
    ];
    const found = new Map<string, { count: number; trace: string; detail: string }>();
    let reached = 0;
    let transitions = 0;
    for (const [seedName, seed] of seeds) {
      const visited = new Set<string>([JSON.stringify(seed)]);
      let frontier: Array<{ w: World; trace: string[] }> = [{ w: seed, trace: [] }];
      for (let level = 0; level < depth; level++) {
        const next: typeof frontier = [];
        for (const { w, trace } of frontier) {
          const steps: Array<{ name: string; world: World; vs: Violation[] }> = [];
          for (const op of [...opsFor(w, 'D1', { renames: false }), ...opsFor(w, 'D2', { renames: false })]) {
            const res = op.run(w);
            if (res.error) continue;
            steps.push({ name: op.name, world: res.world, vs: checkOp(w, op, res.world, res) });
          }
          const plan = movePlan(w);
          for (const picks of pickSets(plan)) {
            const res = moveApply(w, plan, picks);
            if (res.world === w) continue;
            steps.push({ name: `move${pickLabel(picks)}`, world: res.world, vs: checkMove(w, plan, picks, res.world) });
          }
          for (const step of steps) {
            transitions += 1;
            const path = [...trace, step.name];
            for (const [inv, detail] of step.vs) {
              const sig = `${inv} :: ${step.name.replace(/ r1( |$)/, '$1').replace(/[a-z]+→[a-z]+ /, '').replace(/→ (none|r1|r2)/, '→ role')}`;
              const f = found.get(sig);
              if (!f) found.set(sig, { count: 1, trace: `${seedName}: ${path.join(' → ')}`, detail });
              else f.count += 1;
            }
            const key = JSON.stringify(step.world);
            if (!visited.has(key)) {
              visited.add(key);
              next.push({ w: step.world, trace: path });
            }
          }
        }
        frontier = next;
      }
      reached += visited.size;
    }
    const rows = [...found.entries()].sort((x, y) => x[0].localeCompare(y[0]));
    const lines = [
      `BFS depth ${depth}: ${reached} reachable states, ${transitions} transitions, ${Date.now() - t0} ms`,
      `${rows.length} distinct violation signatures reachable from clean projects`,
      ...rows.map(([sig, f]) => `\n● ${sig}  (×${f.count})\n    trace: ${f.trace}\n    got:   ${f.detail}`),
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    if (process.env.EXHAUSTIVE_REPORT) fs.writeFileSync(process.env.EXHAUSTIVE_REPORT.replace(/\.txt$/, '-bfs.txt'), lines.join('\n') + '\n');
    expect(rows.filter(([sig]) => !Object.keys(ALLOWED).some((a) => a.replace(' [dup-in-file]', '') === sig)).map(([sig]) => sig)).toEqual([]);
  }, 1_800_000);
});
