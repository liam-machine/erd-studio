/**
 * relationshipStateSpace on native DBML storage in the layer-first tree
 * (ERD Studio 2.0; first written for §9.5 of
 * docs/plans/native-dbml-storage.md).
 *
 * The universes store a link either way round, as one-to-many records and
 * in diagram files, which DBML cannot hold, so each state is first
 * projected through the DBML codec (`projectWorld`: diagram copies dropped,
 * entries canonicalised to their foreign-key table, ends respelled). States
 * the projection changes beyond §2.8 — a link stored twice, or a state the
 * writer refuses to store — are skipped and counted; a floor keeps the suite
 * from silently skipping everything.
 *
 * Every canvas relationship message is then sent from the DBML diagram D1
 * to the real SemanticEditorProvider, and these invariants are checked on
 * the files it leaves:
 *
 * - **one link per linkKey**, across every relationships file;
 * - **no existing Ref changes file**: a link held before and after is in
 *   the same file, and a Ref whose links are all new is either in a file
 *   that held a Ref of the same table pair before (a column change, match
 *   2b, regenerated in place) or in `placeNewRef`'s file for the index
 *   before the edit (decision 5; `dim` lives in silver, `fct` in gold);
 * - **exact imports**: every diagram's `use *` set of relationships files
 *   equals `relationshipsImportsFor(members)` after the edit (D1 is the
 *   diagram edited, D2 and D3 are settled in the same WorkspaceEdit);
 * - **representable**: when the edit succeeds, the library read back equals
 *   the state `planRelationshipWrite` decides for the projected world
 *   (the model's `op.run`, which calls it), modulo §2.8; when the planner
 *   refuses, the edit is refused and nothing changes;
 * - **Law 5** on every file: the project compiles with no diagnostic in
 *   9.1.1, 10.3.1 and 11.0.0; **Law 4**: no file the edit did not need to
 *   touch (the table files) changes; **Laws 1 and 2**: the same edit sent
 *   again changes no byte; **Law 3** is the representability check above.
 *
 * CI runs a sample of the main universe (every STATESPACE_DBML_EVERY-th
 * small-scope state, default 151); `STATESPACE_DBML_EVERY=1` checks every
 * state.
 *
 * The GROUP and SELF universes (#133 L2, L3: a composite foreign key, a
 * partial and a 1.6.7 split group; a self-reference stored either way
 * round) are projected the same way (`projectGWorld`) and run in full: the
 * projection drops their diagram copies, so their states collapse to a few
 * distinct libraries, each run once with every canvas edit
 * `checkGroupState` / `checkSelfState` make. Their composites are written
 * as `fct.(k, k_x)` Refs and their self-reference as a bare `emp` self-Ref.
 * The prediction is `planRelationshipWrite` for the projected world
 * (`gWrite`); a refusal must leave the library unchanged.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import { CARDS, SWAP, describeState, messageOf, opsFor, states, worldOf } from './relationshipStateSpace.model';
import type { State } from './relationshipStateSpace.model';
import {
  GROUP_LAYOUT, SELF_LAYOUT, TABLE_LAYERS, TABLE_PATHS, dbmlFiles, importViolations, materialiseDbml, materialiseDbmlG, normaliseLibrary, normaliseLibraryG,
  projectGWorld, projectWorld, readBackDbml, readBackDbmlG, sendToDbmlProvider, storedRefs,
} from './relationshipStateSpace.dbmlHarness';
import type { DbmlProject, GLayout } from './relationshipStateSpace.dbmlHarness';
import { L, describeGroup, describeSelf, gDraw, gWrite, groupStates, groupWorld, selfStates, selfWorld } from './relationshipStateSpace.universes';
import type { GWorld } from './relationshipStateSpace.universes';
import type { RelationshipWriteOp } from '../../src/services/libraryRelationships';
import type { Relationship } from '../../src/types/semantic';
import { linkKey } from '@erd-studio/core';
import { projectDiagnostics } from '../../packages/core/test/dbmlWriterSupport';
import { placeNewRef } from '../../src/services/dbmlRelationshipsIndex';
import type { RelationshipsIndex } from '../../src/services/dbmlRelationshipsIndex';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SEMANTIC_DIR } from './relationshipStateSpace.harness';

/** What the storage invariants compare with: the Refs and the relationships index before the edit. */
interface Before { refs: ReturnType<typeof storedRefs>; index: RelationshipsIndex }

function beforeOf(p: DbmlProject): Before {
  return { refs: storedRefs(p), index: new TableLibraryService(p.root, SEMANTIC_DIR).relationshipsIndex() };
}

function sample(every: number): State[] {
  const out: State[] = [];
  let i = 0;
  for (const s of states('small')) if (i++ % every === 0) out.push(s);
  return out;
}

/** The violations of the storage invariants on `p`'s files, against the state `before` the edit. */
function storageViolations(p: DbmlProject, before: Before): string[] {
  const out: string[] = [];
  const refs = storedRefs(p);
  const seen = new Map<string, string>();
  const heldBefore = new Map(before.refs.flatMap((r) => r.links.map((l) => [l, r.file] as const)));
  const pairFilesBefore = new Map<string, Set<string>>();
  for (const r of before.refs) pairFilesBefore.set(r.pair, (pairFilesBefore.get(r.pair) ?? new Set()).add(r.file));
  for (const ref of refs) {
    for (const link of ref.links) {
      const held = seen.get(link);
      if (held) out.push(`one-link: ${link.replace('\u0000', '~')} in ${held} and ${ref.file}`);
      seen.set(link, ref.file);
    }
    const kept = ref.links.filter((l) => heldBefore.has(l));
    for (const link of kept) {
      if (heldBefore.get(link) !== ref.file) out.push(`moved: ${link.replace('\u0000', '~')} went from ${heldBefore.get(link)} to ${ref.file}`);
    }
    if (kept.length === 0) {
      const placed = placeNewRef({ table: ref.owner, layer: TABLE_LAYERS[ref.owner] }, before.index).file;
      if (ref.file !== placed && !pairFilesBefore.get(ref.pair)?.has(ref.file)) {
        out.push(`placement: a new Ref owned by ${ref.owner} is in ${ref.file}, not ${placed}`);
      }
    }
  }
  out.push(...importViolations(p));
  const diagnostics = projectDiagnostics(dbmlFiles(p));
  for (const d of diagnostics.slice(0, 3)) out.push(`law5: ${d.parser} ${d.file} ${d.type} ${d.text}`);
  return out;
}

/**
 * Laws 1 and 2 at the canvas: the same edit sent again finds the library
 * already as it asks, so it writes nothing (every byte unchanged), whether
 * it is accepted as a no-op or refused.
 */
async function resendViolations(p: DbmlProject, message: unknown): Promise<string[]> {
  const before = JSON.stringify(dbmlFiles(p));
  _resetMockWorkspace();
  vi.restoreAllMocks();
  await sendToDbmlProvider(p, message);
  return JSON.stringify(dbmlFiles(p)) === before ? [] : ['law2: the same edit sent again changed a file'];
}

describe('relationshipStateSpace on native DBML storage (projected universes)', () => {
  it('every relationship edit from a DBML diagram keeps one link per key, moves no Ref, places a new one by decision 5, imports exactly, representable and compiling', async () => {
    const every = Number(process.env.STATESPACE_DBML_EVERY ?? 151);
    let runs = 0;
    let skippedProjection = 0;
    let skippedUnstorable = 0;
    const violations: string[] = [];
    const mismatches: string[] = [];
    for (const s of sample(every)) {
      const projected = projectWorld(worldOf(s.profile, s.copies, s.bystander));
      if (!projected) { skippedProjection++; continue; }
      for (const op of opsFor(projected)) {
        if (!op.call) continue;
        _resetMockWorkspace();
        let p: DbmlProject;
        try {
          p = materialiseDbml(projected);
        } catch {
          skippedUnstorable++;
          continue;
        }
        try {
          const before = readBackDbml(p, projected);
          if (normaliseLibrary(before) !== normaliseLibrary(projected)) { skippedUnstorable++; continue; }
          const tablesBefore = Object.values(TABLE_PATHS).map((t) => dbmlFiles(p)[t]);
          const stored = beforeOf(p);
          const predicted = op.run(projected);
          const { errors } = await sendToDbmlProvider(p, messageOf(op.call));
          const actual = readBackDbml(p, projected);
          runs++;
          const label = `${describeState(s)} / ${op.name}`;
          for (const v of storageViolations(p, stored)) violations.push(`${v} :: ${label}`);
          // Column-free relationship edits never touch a table file (Law 4).
          const tablesAfter = Object.values(TABLE_PATHS).map((t) => dbmlFiles(p)[t]);
          if (JSON.stringify(tablesAfter) !== JSON.stringify(tablesBefore) && !errors.length) {
            const marks = op.call.kind === 'add' || op.call.kind === 'edit';
            if (!marks) violations.push(`law4: a table file changed :: ${label}`);
          }
          if (predicted.error) {
            if (errors.length === 0) mismatches.push(`${label}\n   planner refused (${predicted.error}); the edit was written`);
            else if (normaliseLibrary(actual) !== normaliseLibrary(before)) mismatches.push(`${label}\n   refused, but the library changed`);
          } else if (errors.length > 0) {
            mismatches.push(`${label}\n   planner: ${normaliseLibrary(predicted.world)}\n   refused: ${errors.join('; ')}`);
          } else if (normaliseLibrary(actual) !== normaliseLibrary(predicted.world)) {
            mismatches.push(`${label}\n   planner: ${normaliseLibrary(predicted.world)}\n   real:    ${normaliseLibrary(actual)}`);
          }
          if (errors.length === 0) for (const v of await resendViolations(p, messageOf(op.call))) violations.push(`${v} :: ${label}`);
        } finally {
          vi.restoreAllMocks();
          fs.rmSync(p.root, { recursive: true, force: true });
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[relationshipStateSpace.dbml] runs ${runs}; skipped: ${skippedProjection} states the projection changes beyond §2.8, ${skippedUnstorable} the writer cannot store`);
    expect(runs).toBeGreaterThan(300);
    expect(violations.slice(0, 20)).toEqual([]);
    expect(mismatches.slice(0, 20)).toEqual([]);
  }, 600_000);
});

/** One canvas edit of a GROUP or SELF state: its message and the planner op it asks for. */
interface GOp { name: string; message: { type: string; payload: unknown }; op: RelationshipWriteOp; marks: boolean }

const endsOf = (r: Relationship) => ({ fromModel: r.fromModel, fromColumn: r.fromColumn, toModel: r.toModel, toColumn: r.toColumn });
const opAdd = (name: string, drawn: Relationship, extraPairs?: Array<{ fromColumn: string; toColumn: string }>): GOp => ({
  name, marks: true,
  message: { type: 'addRelationship', payload: { ...drawn, ...(extraPairs ? { extraPairs } : {}) } },
  op: { kind: 'add', drawn, ...(extraPairs ? { extraPairs } : {}) },
});
const opUpdate = (name: string, line: Relationship, cardinality: Relationship['cardinality']): GOp => ({
  name, marks: false,
  message: { type: 'updateRelationship', payload: { ...endsOf(line), cardinality } },
  op: { kind: 'update', ends: endsOf(line), cardinality },
});
const opEdit = (name: string, line: Relationship, drawn: Relationship, extraPairs?: Array<{ fromColumn: string; toColumn: string }>): GOp => {
  const o = endsOf(line);
  return {
    name, marks: true,
    message: { type: 'editRelationship', payload: {
      originalFromModel: o.fromModel, originalFromColumn: o.fromColumn, originalToModel: o.toModel, originalToColumn: o.toColumn,
      ...drawn, ...(extraPairs ? { extraPairs } : {}),
    } },
    op: { kind: 'edit', original: o, drawn, ...(extraPairs ? { extraPairs } : {}) },
  };
};
const opRemove = (line: Relationship): GOp => ({
  name: 'delete', marks: false,
  message: { type: 'removeRelationship', payload: endsOf(line) },
  op: { kind: 'remove', keys: [endsOf(line)] },
});

/** The SELF universe's canvas edits from D1 (as `checkSelfState`). */
function selfOps(w: GWorld): GOp[] {
  const SELF = linkKey({ fromModel: 'emp', fromColumn: 'mgr', toModel: 'emp', toColumn: 'id' });
  const line = gDraw(w, 'D1').find((r) => linkKey(r) === SELF);
  if (!line) {
    return (['fd', 'df'] as const).flatMap((dir) => CARDS.map((card) => opAdd(`add ${dir} ${card}`, dir === 'fd'
      ? { fromModel: 'emp', fromColumn: 'mgr', toModel: 'emp', toColumn: 'id', cardinality: card }
      : { fromModel: 'emp', fromColumn: 'id', toModel: 'emp', toColumn: 'mgr', cardinality: card })));
  }
  return [
    ...[SWAP[line.cardinality], ...CARDS].map((card) => opUpdate(`set ${card}`, line, card)),
    opEdit('edit: turn ends round', line, { fromModel: 'emp', fromColumn: line.toColumn, toModel: 'emp', toColumn: line.fromColumn, cardinality: line.cardinality }),
    opRemove(line),
  ];
}

/** The GROUP universe's canvas edits from D1 (as `checkGroupState`). */
function groupOps(w: GWorld): GOp[] {
  const drawn = gDraw(w, 'D1');
  const line = drawn.find((r) => linkKey(r) === L);
  const pairX = { fromColumn: 'k_x', toColumn: 'k_x' };
  if (!line) {
    return [
      opAdd('add composite from fct', { fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one' }, [pairX]),
      opAdd('add composite from dim', { fromModel: 'dim', fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-many' }, [pairX]),
    ];
  }
  const grouped = drawn.some((r) => r !== line && r.compositeKey && line.compositeKey && r.compositeKey === line.compositeKey);
  const ends = { ...endsOf(line) };
  return [
    ...([SWAP[line.cardinality], 'many-to-one', 'one-to-one', 'many-to-many'] as const).map((card) => opUpdate(`set ${card}`, line, card)),
    opEdit('edit role → r1', line, { ...ends, cardinality: line.cardinality, role: 'r1' }, grouped ? [pairX] : undefined),
    opRemove(line),
    grouped
      ? opEdit('edit: drop pair k_x', line, { ...ends, cardinality: line.cardinality })
      : opEdit('edit: add pair k_x', line, { ...ends, cardinality: line.cardinality }, [pairX]),
  ];
}

/**
 * Run every canvas edit of every distinct projected state of a GROUP or
 * SELF universe on real DBML files. Distinct: diagram copies are dropped by
 * the projection, so many states project to one; each is run once.
 */
async function runUniverse(
  worlds: Iterable<{ world: GWorld; label: string }>,
  layout: GLayout,
  opsOf: (w: GWorld) => GOp[],
): Promise<{ runs: number; skippedProjection: number; skippedUnstorable: number; duplicates: number; refusedByHost: number; violations: string[]; mismatches: string[] }> {
  const result = { runs: 0, skippedProjection: 0, skippedUnstorable: 0, duplicates: 0, refusedByHost: 0, violations: [] as string[], mismatches: [] as string[] };
  const seen = new Set<string>();
  const tablePaths = Object.values(layout.tablePaths);
  for (const { world, label: stateLabel } of worlds) {
    const projected = projectGWorld(world);
    if (!projected) { result.skippedProjection++; continue; }
    const key = normaliseLibraryG(projected);
    if (seen.has(key)) { result.duplicates++; continue; }
    seen.add(key);
    for (const g of opsOf(projected)) {
      _resetMockWorkspace();
      let p: DbmlProject;
      try {
        p = materialiseDbmlG(projected, layout);
      } catch {
        result.skippedUnstorable++;
        continue;
      }
      try {
        const before = readBackDbmlG(p, projected);
        // A state the writer stores differently from the projection (beyond §2.8) is not a starting point.
        if (normaliseLibraryG(before) !== normaliseLibraryG(projected)) { result.skippedUnstorable++; continue; }
        const tablesBefore = tablePaths.map((t) => dbmlFiles(p)[t]);
        const stored = beforeOf(p);
        const predicted = gWrite(projected, g.op);
        const { errors } = await sendToDbmlProvider(p, g.message);
        const actual = readBackDbmlG(p, projected);
        result.runs++;
        const label = `${stateLabel} / ${g.name}`;
        for (const v of storageViolations(p, stored)) result.violations.push(`${v} :: ${label}`);
        if (!g.marks && JSON.stringify(tablePaths.map((t) => dbmlFiles(p)[t])) !== JSON.stringify(tablesBefore)) {
          result.violations.push(`law4: a table file changed :: ${label}`);
        }
        if (errors.length > 0) {
          // Refused (by the planner, or by the host's own checks before it): nothing changed.
          if (!predicted.error) result.refusedByHost++;
          if (normaliseLibraryG(actual) !== normaliseLibraryG(before)) result.mismatches.push(`${label}\n   refused (${errors[0]}), but the library changed`);
        } else if (predicted.error) {
          result.mismatches.push(`${label}\n   planner refused (${predicted.error}); the edit was written`);
        } else if (normaliseLibraryG(actual) !== normaliseLibraryG(predicted.world)) {
          result.mismatches.push(`${label}\n   planner: ${normaliseLibraryG(predicted.world)}\n   real:    ${normaliseLibraryG(actual)}`);
        }
        if (errors.length === 0) for (const v of await resendViolations(p, g.message)) result.violations.push(`${v} :: ${label}`);
      } finally {
        vi.restoreAllMocks();
        fs.rmSync(p.root, { recursive: true, force: true });
      }
    }
  }
  return result;
}

describe('relationshipStateSpace on native DBML storage: the GROUP and SELF universes (#133 L2, L3)', () => {
  it('GROUP: a composite foreign key, a partial and a 1.6.7 split group, written as `(k, k_x)` Refs, stay representable', async () => {
    const worlds = (function* () {
      for (const copies of groupStates()) yield { world: groupWorld(copies), label: describeGroup(copies) };
    })();
    const r = await runUniverse(worlds, GROUP_LAYOUT, groupOps);
    // eslint-disable-next-line no-console
    console.log(`[relationshipStateSpace.dbml GROUP] runs ${r.runs} over distinct projected states; skipped: ${r.skippedProjection} the projection changes beyond §2.8, ${r.duplicates} duplicates of another projection, ${r.skippedUnstorable} the writer cannot store; ${r.refusedByHost} refused by the host's checks`);
    expect(r.runs).toBeGreaterThan(60);
    expect(r.violations.slice(0, 20)).toEqual([]);
    expect(r.mismatches.slice(0, 20)).toEqual([]);
  }, 600_000);

  it('SELF: a self-reference stored either way round, as a bare self-Ref, stays representable', async () => {
    const worlds = (function* () {
      for (const { profile, copies } of selfStates()) yield { world: selfWorld(profile, copies), label: describeSelf(profile, copies) };
    })();
    const r = await runUniverse(worlds, SELF_LAYOUT, selfOps);
    // eslint-disable-next-line no-console
    console.log(`[relationshipStateSpace.dbml SELF] runs ${r.runs} over distinct projected states; skipped: ${r.skippedProjection} the projection changes beyond §2.8, ${r.duplicates} duplicates of another projection, ${r.skippedUnstorable} the writer cannot store; ${r.refusedByHost} refused by the host's checks`);
    expect(r.runs).toBeGreaterThan(40);
    expect(r.violations.slice(0, 20)).toEqual([]);
    expect(r.mismatches.slice(0, 20)).toEqual([]);
  }, 600_000);
});

describe('the DBML storage invariants are not vacuous', () => {
  it('a diagram missing an import, a Ref moved to another file and a new Ref out of place are each reported', () => {
    let world = null as ReturnType<typeof projectWorld>;
    for (const s of states('small')) {
      const w = projectWorld(worldOf(s.profile, s.copies, s.bystander));
      if (w && w.lib.fct.length > 0 && w.domModels.D1.includes('dim') && w.domModels.D1.includes('fct')) { world = w; break; }
    }
    expect(world).not.toBeNull();
    const p = materialiseDbml(world!);
    try {
      const stored = beforeOf(p);
      expect(storageViolations(p, stored)).toEqual([]);
      const semantic = `${p.root}/${SEMANTIC_DIR}`;
      const held = stored.refs[0].file;
      expect(held).toMatch(/^(silver|gold)\/relationships\/(silver|gold)\.dbml$/);
      // Drop D1's import of the file holding the Ref.
      const d1 = p.diagramPath('D1');
      const d1Text = fs.readFileSync(d1, 'utf-8');
      fs.writeFileSync(d1, d1Text.replace(new RegExp(`^use \\* from '[^']*${held.split('/').pop()!.replace('.', '\\.')}'\n`, 'm'), ''));
      expect(storageViolations(p, stored).some((v) => v.startsWith('imports: silver/diagrams/D1.dbml'))).toBe(true);
      fs.writeFileSync(d1, d1Text);
      // Move the file (its Ref with it) to another name in the same folder: the Ref moved.
      fs.renameSync(`${semantic}/${held}`, `${semantic}/${held.replace(/[^/]+\.dbml$/, 'moved.dbml')}`);
      expect(storageViolations(p, stored).some((v) => v.startsWith('moved: '))).toBe(true);
      // A Ref none held before, in a file placeNewRef would not choose and no Ref of its pair was in.
      expect(storageViolations(p, { refs: [], index: stored.index }).some((v) => v.startsWith('placement: '))).toBe(true);
    } finally {
      fs.rmSync(p.root, { recursive: true, force: true });
    }
  });
});
