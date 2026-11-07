/**
 * A table whose file does not read, in the sync plan, on both storages of the
 * dbt fixture. Such a table loads with no columns and (on DBML) none of its
 * Refs, so Compare reports every dbt column as missing and every Ref as gone.
 * Those entries are artefacts of the failed read: applied, "add it" writes a
 * duplicate Ref or column, and with the logical model as the truth "remove
 * it" would strip the dbt model. So `buildSyncPlan` leaves them out and lists
 * the table in `unreadableTables`, the same for the canvas's
 * `.sync-plan.json` and the plan `erd-studio diff --json` prints (they share
 * `syncPlanLibraryLookups`).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import { main } from '../../src/cli/index';
import type { DiffResult } from '../../src/cli/diff';
import { allSelections } from '../../src/services/syncPlanBuilder';
import type { GroundTruth, SyncPlan } from '../../src/types/syncPlan';
import { DBT_FIXTURES, copyDbtFixture, diagramRel, tableFilePath } from './helpers/dbtFixtures';
import { compare, errorsOf } from './syncPlanApply.harness';

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
beforeEach(() => {
  _resetMockWorkspace();
  // The failed read is logged; that is expected here.
  for (const kind of ['log', 'warn', 'error'] as const) vi.spyOn(console, kind).mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const BROKEN = 'fct_task_event';

/** git left both sides of a merge in the table's file. */
function breakTableFile(root: string, storage: 'yaml' | 'dbml'): void {
  const file = tableFilePath(root, storage, BROKEN)!;
  const text = fs.readFileSync(file, 'utf-8');
  const lines = text.split('\n');
  lines.splice(1, 0, '<<<<<<< HEAD', lines[1], '=======', lines[1], '>>>>>>> feature');
  fs.writeFileSync(file, lines.join('\n'));
}

async function cliPlan(root: string, diagram: string): Promise<SyncPlan> {
  let out = '';
  await main(['diff', '--json', '--domain', `.erd-studio/${diagram}`], {
    stdout: { write: (s: string) => { out += s; } }, stderr: { write: () => {} }, cwd: root, env: {},
  });
  const d = (JSON.parse(out) as DiffResult).domains[0];
  expect(d.unreadableModelFiles.map((u) => u.name)).toEqual([BROKEN]);
  return d.plan!;
}

async function canvasPlan(root: string, diagram: string, truth: GroundTruth): Promise<SyncPlan | string[]> {
  const { panel, report } = await compare(root, diagram);
  panel._postedMessages.length = 0;
  await panel._simulateMessage({ type: 'generateSyncPlan', payload: { selections: allSelections(report, truth) } });
  const file = path.join(root, '.erd-studio', '.sync-plan.json');
  if (!fs.existsSync(file)) return errorsOf(panel);
  const plan = JSON.parse(fs.readFileSync(file, 'utf-8')) as SyncPlan;
  fs.rmSync(file);
  return plan;
}

const touches = (plan: SyncPlan): unknown[] => [
  ...plan.columns.filter((c) => c.modelName === BROKEN),
  ...plan.relationships.filter((r) => r.fromModel === BROKEN || r.toModel === BROKEN),
];

describe.each(DBT_FIXTURES)('a table file that does not read, on %s storage (%s)', (storage, fixture) => {
  const diagram = diagramRel(storage, 'silver', 'showcase');

  it('the canvas plan and the diff plan leave out its entries and list it, whichever side is the truth', { timeout: 30_000 }, async () => {
    const root = copyDbtFixture(fixture, 'erd-unreadable');
    roots.push(root);
    // Read first, so it is clear the entries are there while the file reads.
    const whole = await canvasPlan(root, diagram, 'physical') as SyncPlan;
    expect(touches(whole).length).toBeGreaterThan(0);
    expect(whole).not.toHaveProperty('unreadableTables');

    breakTableFile(root, storage);
    const fromCli = await cliPlan(root, diagram);
    expect(touches(fromCli)).toEqual([]);
    expect(fromCli.unreadableTables).toEqual([BROKEN]);

    const fromCanvas = await canvasPlan(root, diagram, 'physical') as SyncPlan;
    expect(touches(fromCanvas)).toEqual([]);
    expect(fromCanvas.unreadableTables).toEqual([BROKEN]);
    // The two are the same plan.
    expect({ ...fromCanvas, generatedAt: '' }).toEqual({ ...fromCli, generatedAt: '' });
    // Every other table's entries are still offered.
    expect(fromCanvas.columns.length + fromCanvas.relationships.length).toBeGreaterThan(0);

    // With the logical model as the truth, nothing asks to strip the dbt model of what the failed read lost.
    const logical = await canvasPlan(root, diagram, 'logical');
    if (Array.isArray(logical)) {
      expect(logical).toEqual([]);
    } else {
      expect(touches(logical)).toEqual([]);
      expect(logical.columns.filter((c) => c.action === 'remove-column-from-physical' && c.modelName === BROKEN)).toEqual([]);
    }
  });
});
