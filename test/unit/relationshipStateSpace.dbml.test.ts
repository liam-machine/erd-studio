/**
 * relationshipStateSpace on native DBML storage (§9.5 of
 * docs/plans/native-dbml-storage.md, stage S5).
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
 * - **ownership by the FK side**, and **every Ref in its owner's folder
 *   file** (`dim` at the top of `tables/`, `fct` in `tables/gold/`);
 * - **representable**: when the edit succeeds, the library read back equals
 *   the state `planRelationshipWrite` decides for the projected world
 *   (the model's `op.run`, which calls it), modulo §2.8; when the planner
 *   refuses, the edit is refused and nothing changes;
 * - **Law 5** on every file: the project compiles with no diagnostic in
 *   9.1.1, 10.3.1 and 11.0.0; **Law 4**: no file the edit did not need to
 *   touch (the table files) changes.
 *
 * CI runs a sample (every STATESPACE_DBML_EVERY-th small-scope state,
 * default 151); `STATESPACE_DBML_EVERY=1` checks every state.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import { describeState, messageOf, opsFor, states, worldOf } from './relationshipStateSpace.model';
import type { State } from './relationshipStateSpace.model';
import {
  TABLE_PATHS, dbmlFiles, materialiseDbml, normaliseLibrary, projectWorld, readBackDbml, sendToDbmlProvider, storedRefs,
} from './relationshipStateSpace.dbmlHarness';
import type { DbmlProject } from './relationshipStateSpace.dbmlHarness';
import { projectDiagnostics } from '../../packages/core/test/dbmlWriterSupport';

const FOLDER_FILE: Record<string, string> = { dim: 'tables/_relationships.dbml', fct: 'tables/gold/_relationships.dbml' };

function sample(every: number): State[] {
  const out: State[] = [];
  let i = 0;
  for (const s of states('small')) if (i++ % every === 0) out.push(s);
  return out;
}

/** The violations of the storage invariants on `p`'s files. */
function storageViolations(p: DbmlProject): string[] {
  const out: string[] = [];
  const refs = storedRefs(p);
  const seen = new Map<string, string>();
  for (const ref of refs) {
    for (const link of ref.links) {
      const held = seen.get(link);
      if (held) out.push(`one-link: ${link.replace('\u0000', '~')} in ${held} and ${ref.file}`);
      seen.set(link, ref.file);
    }
    if (FOLDER_FILE[ref.owner] !== ref.file) out.push(`home: a Ref owned by ${ref.owner} is in ${ref.file}`);
  }
  const diagnostics = projectDiagnostics(dbmlFiles(p));
  for (const d of diagnostics.slice(0, 3)) out.push(`law5: ${d.parser} ${d.file} ${d.type} ${d.text}`);
  return out;
}

describe('relationshipStateSpace on native DBML storage (projected universes)', () => {
  it('every relationship edit from a DBML diagram keeps one link per key, in its owner\'s folder file, representable and compiling', async () => {
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
          const predicted = op.run(projected);
          const { errors } = await sendToDbmlProvider(p, messageOf(op.call));
          const actual = readBackDbml(p, projected);
          runs++;
          const label = `${describeState(s)} / ${op.name}`;
          for (const v of storageViolations(p)) violations.push(`${v} :: ${label}`);
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
