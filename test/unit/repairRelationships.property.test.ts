/**
 * Repair Relationships… — seeded property tests (issue #133, R12).
 *
 * Random projects — models with keys and foreign keys, library entries stored
 * on either side with random cardinalities, roles, case variants, duplicates,
 * typos (REL008), missing models and columns, and domain files with their own
 * copies — each repaired with random answers. For every world:
 *
 * - the result passes `verifyRepair`: nothing outside the relationships
 *   changed, every planned finding is gone, nothing new appeared, and every
 *   diagram draws what it drew except where the user chose;
 * - repairing twice is repairing once: a second run that leaves every
 *   question unanswered changes nothing;
 * - an entry the reader could not read is still there, byte for byte.
 *
 * No new dependency: a small seeded generator (mulberry32).
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import {
  LEAVE_AS_IS,
  RepairEditError,
  checkPlannedTexts,
  planRelationshipRepair,
  readRepairSnapshot,
  verifyRepair,
  type RepairOptions,
  type RepairSnapshotDeps,
} from '../../src/services/relationshipRepair';

const SEMANTIC_DIR = '.erd-studio';
const WORLDS = 160;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-repair-prop-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface World {
  deps: RepairSnapshotDeps;
  /** Model file path → the typo entries' text, which must survive. */
  typos: Map<string, string[]>;
  root: string;
}

const CARDINALITIES = ['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many'];

function makeWorld(seed: number): World {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const chance = (p: number): boolean => rand() < p;
  const root = path.join(base, `w${seed}`);
  const erd = path.join(root, SEMANTIC_DIR);
  fs.mkdirSync(path.join(erd, 'logical-models'), { recursive: true });
  fs.mkdirSync(path.join(erd, 'gold'), { recursive: true });

  const n = 3 + Math.floor(rand() * 3);
  const names = Array.from({ length: n }, (_, i) => `model_${String.fromCharCode(97 + i)}`);
  const columns = new Map<string, string[]>();
  const columnYaml = new Map<string, string[]>();
  for (const [i, name] of names.entries()) {
    const cols = ['id', 'code', ...names.filter((_, j) => j !== i).map((other) => `${other}_id`)];
    columns.set(name, cols);
    columnYaml.set(name, cols.flatMap((c) => [
      `  - name: ${c}`,
      '    dataType: string',
      ...(c === 'id' && chance(0.7) ? ['    isPrimaryKey: true'] : []),
      ...(c.endsWith('_id') && chance(0.35) ? ['    isForeignKey: true'] : []),
    ]));
  }
  const variant = (s: string): string => (chance(0.15) ? s.toUpperCase() : s);
  const entries = new Map<string, string[]>(names.map((m) => [m, []]));
  const typos = new Map<string, string[]>();
  const library = chance(0.75);
  const linkCount = library ? Math.floor(rand() * 7) : 0;
  const domainLinks: Array<Record<string, string>> = [];
  for (let k = 0; k < linkCount; k++) {
    const holder = pick(names);
    const other = chance(0.1) ? holder : pick(names.filter((m) => m !== holder));
    const fromColumn = pick(columns.get(holder)!);
    let toModel = other;
    let toColumn = pick(columns.get(other)!);
    if (chance(0.05)) toModel = 'ghost_model';
    else if (chance(0.05)) toColumn = 'no_such_column';
    const cardinality = chance(0.06) ? 'one_to_many' : pick(CARDINALITIES);
    const role = chance(0.2) ? pick(['buyer', 'seller']) : undefined;
    const lines = [
      `  - fromColumn: ${fromColumn}${chance(0.3) ? '   # hand note' : ''}`,
      `    toModel: ${variant(toModel)}`,
      `    toColumn: ${variant(toColumn)}`,
      `    cardinality: ${cardinality}`,
      ...(role ? [`    role: ${role}`] : []),
      ...(chance(0.15) ? ['    note: unknown key'] : []),
    ];
    entries.get(holder)!.push(...lines);
    if (cardinality === 'one_to_many') typos.set(holder, [...(typos.get(holder) ?? []), lines.join('\n')]);
    if (chance(0.25)) entries.get(holder)!.push(...lines.map((l) => l.replace('   # hand note', '')));
    if (chance(0.2) && cardinality !== 'one_to_many' && toModel !== 'ghost_model' && holder !== other) {
      // The same link again, stored on the other end.
      entries.get(other)!.push(
        `  - fromColumn: ${toColumn}`,
        `    toModel: ${holder}`,
        `    toColumn: ${fromColumn}`,
        `    cardinality: ${pick(CARDINALITIES)}`,
      );
    }
    if (chance(0.3)) domainLinks.push({ fromModel: holder, fromColumn, toModel, toColumn, cardinality: cardinality === 'one_to_many' ? 'one-to-many' : cardinality });
  }
  if (!library) {
    for (let k = 0; k < 4; k++) {
      const a = pick(names);
      const b = pick(names.filter((m) => m !== a));
      domainLinks.push({ fromModel: variant(a), fromColumn: `${b}_id`, toModel: b, toColumn: 'id', cardinality: pick(CARDINALITIES) });
    }
  }
  for (const name of names) {
    const rels = entries.get(name)!;
    const text = [
      `# ${name}, written by hand`,
      `name: ${name}`,
      'columns:',
      ...columnYaml.get(name)!,
      ...(rels.length > 0 ? ['relationships:', ...rels] : []),
      ...(chance(0.3) ? ['# trailing comment'] : []),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(erd, 'logical-models', `${name}.yml`), text);
  }
  for (const d of ['a', 'b']) {
    const shown = names.filter(() => chance(0.7));
    const models = (shown.length >= 2 ? shown : names.slice(0, 2)).map((m) => (chance(0.1) ? m.toUpperCase() : m));
    const own = domainLinks.filter(() => chance(0.6)).map((r) => (chance(0.3) ? { ...r, cardinality: pick(CARDINALITIES) } : r));
    if (chance(0.2) && own.length > 0) own.push(own[0]);
    fs.writeFileSync(path.join(erd, 'gold', `${d}.json`), JSON.stringify({
      schemaVersion: 5, domain: d, layer: 'gold', description: '',
      logical: { models, relationships: own },
      viewConfig: { positions: {} },
    }, null, 2) + '\n');
  }

  const layerService = new LayerService(root, SEMANTIC_DIR);
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(root, SEMANTIC_DIR);
  domainService.setLogicalModelService(logicalModelService);
  return {
    deps: { workspaceRoot: root, semanticDir: SEMANTIC_DIR, domainService, logicalModelService },
    typos: new Map([...typos].map(([m, t]) => [path.join(erd, 'logical-models', `${m}.yml`), t])),
    root,
  };
}

/** One run with answers from `answer`; returns the plan's change count and verification problems. */
async function runOnce(
  world: World,
  answer: (options: string[]) => string,
  options: RepairOptions = {},
): Promise<{ changes: number; problems: string[] }> {
  const before = readRepairSnapshot(world.deps);
  const plan = await planRelationshipRepair(before, options, async (q) => answer(q.options.map((o) => o.id)));
  expect(plan).not.toBeNull();
  expect(checkPlannedTexts(plan!)).toEqual([]);
  for (const change of plan!.changes) fs.writeFileSync(change.filePath, change.text);
  const problems = verifyRepair(before, readRepairSnapshot(world.deps), plan!);
  return { changes: plan!.changes.length, problems };
}

describe('Repair Relationships — seeded worlds', () => {
  for (const move of [false, true]) {
    const name = move ? 'Move Relationships to Model Library' : 'Repair Relationships';
    it(`${name}: keeps every promise over ${WORLDS} random projects, and a second run changes nothing`, async () => {
      let repaired = 0;
      let refused = 0;
      for (let seed = 1; seed <= WORLDS; seed++) {
        const world = makeWorld(seed + (move ? 100_000 : 0));
        const rand = mulberry32(seed * 7919);
        let first: { changes: number; problems: string[] };
        try {
          first = await runOnce(world, (ids) => ids[Math.floor(rand() * ids.length)], { moveDomainsToLibrary: move });
        } catch (err) {
          // Only a file the engine says it cannot edit in place may stop it.
          expect(err, `seed ${seed}`).toBeInstanceOf(RepairEditError);
          refused++;
          continue;
        }
        expect(first.problems, `seed ${seed}: ${JSON.stringify(first.problems)}`).toEqual([]);
        if (first.changes > 0) repaired++;
        const second = await runOnce(world, () => LEAVE_AS_IS, { moveDomainsToLibrary: move });
        expect(second.changes, `seed ${seed}: a second run changed something`).toBe(0);
        for (const [file, texts] of world.typos) {
          const now = fs.readFileSync(file, 'utf-8');
          for (const t of texts) expect(now, `seed ${seed}: an unreadable entry changed`).toContain(t);
        }
      }
      // The generator really exercises the engine.
      expect(repaired).toBeGreaterThan(WORLDS / 3);
      expect(refused).toBe(0);
    }, 120_000);
  }
});
