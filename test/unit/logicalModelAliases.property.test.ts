/**
 * Randomised check of model-file saves over YAML anchors and aliases (#157).
 *
 * Each case is a model file whose values are plain, anchored (`&aN value`) or
 * aliases of an earlier anchor (`*aN`), spread over keys ERD Studio manages
 * (description, grain, meta, a column's type and description, scdType, a
 * relationship's role), keys it does not (`x-…` at the top and in a column)
 * and number-looking text (`007`, `1e3`, `.5`, `+1`). A few canvas edits are
 * applied and the model saved. Every save must:
 *
 * - not throw, and leave a file that parses with every alias resolved;
 * - read back exactly as the model it was given (core's reader);
 * - leave every key the canvas does not manage reading as it did;
 * - change nothing on a save with no edit, and settle in one save (a second
 *   save of the same model writes the same bytes).
 *
 * Seeded, so a failure names a case that reproduces.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse, parseDocument } from 'yaml';
import { parseLogicalModelText } from '@erd-studio/core';
import { LogicalModelService } from '../../src/services/logicalModelService';
import type { SemanticModel } from '../../src/types/semantic';

const CASES = 1500;

/** mulberry32: a small seeded PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'text' | 'number';
const TEXT = ['alpha', 'beta', 'two words', 'true', '007', '1e3', '.5', '+1'];
const NUMBER = ['1', '2', '02'];

/** One file built slot by slot, in document order, so an alias only names an anchor before it. */
class FileBuilder {
  private anchors: Array<{ name: string; kind: Kind }> = [];
  constructor(private readonly r: () => number) {}

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)];
  }

  /** A value for a slot of `kind`: plain, anchored, or an alias of an earlier anchor of the same kind. */
  value(kind: Kind): string {
    const roll = this.r();
    const earlier = this.anchors.filter((a) => a.kind === kind);
    if (roll < 0.3 && earlier.length > 0) return `*${this.pick(earlier).name}`;
    const plain = this.pick(kind === 'text' ? TEXT : NUMBER);
    if (roll < 0.6) {
      const name = `a${this.anchors.length}`;
      this.anchors.push({ name, kind });
      return `&${name} ${plain}`;
    }
    return plain;
  }

  maybe(p: number): boolean {
    return this.r() < p;
  }
}

function buildFile(r: () => number): string {
  const b = new FileBuilder(r);
  const lines = ['name: fct_order'];
  if (b.maybe(0.8)) lines.push(`description: ${b.value('text')}`);
  if (b.maybe(0.7)) lines.push(`grain: ${b.value('text')}`);
  if (b.maybe(0.6)) lines.push(`x-note: ${b.value('text')}`);
  if (b.maybe(0.6)) {
    lines.push('meta:', `  tier: ${b.value('text')}`);
    if (b.maybe(0.5)) lines.push(`  weight: ${b.value('number')}`);
  }
  lines.push('columns:');
  for (const col of ['order_key', 'customer_key']) {
    lines.push(`  - name: ${col}`, `    dataType: ${b.value('text')}`);
    if (b.maybe(0.5)) lines.push(`    description: ${b.value('text')}`);
    if (b.maybe(0.5)) lines.push(`    scdType: ${b.value('number')}`);
    if (b.maybe(0.5)) lines.push(`    x-src: ${b.value('text')}`);
  }
  if (b.maybe(0.7)) {
    lines.push(
      'relationships:',
      '  - fromColumn: customer_key',
      '    toModel: dim_customer',
      '    toColumn: customer_key',
      '    cardinality: many-to-one',
    );
    if (b.maybe(0.7)) lines.push(`    role: ${b.value('text')}`);
  }
  if (b.maybe(0.5)) lines.push(`x-tail: ${b.value('text')}`);
  if (b.maybe(0.3)) lines.push(`x-count: ${b.value('number')}`);
  return lines.join('\n') + '\n';
}

const SWAP = (m: SemanticModel): string => { m.columns!.reverse(); return 'swap the columns'; };
const RENAME = (m: SemanticModel): string => {
  const col = m.columns!.find((c) => c.name === 'customer_key');
  if (!col) return 'no customer_key';
  col.name = 'buyer_key';
  for (const rel of m.relationships ?? []) if (rel.fromColumn === 'customer_key') rel.fromColumn = 'buyer_key';
  return 'rename customer_key';
};

/** Canvas edits; each says what it did, for the failure message. */
const EDITS: Array<(m: SemanticModel, r: () => number) => string> = [
  (m) => { m.description = 'Edited description'; return 'set description'; },
  (m) => { delete m.description; return 'clear description'; },
  (m) => { m.grain = 'one row per line'; return 'set grain'; },
  (m) => { delete m.grain; return 'clear grain'; },
  (m) => { m.meta = { ...(m.meta ?? {}), tier: 'silver' }; return 'set meta.tier'; },
  (m) => {
    if (!m.meta) return 'no meta';
    const { tier: _, ...rest } = m.meta;
    if (Object.keys(rest).length > 0) m.meta = rest; else delete m.meta;
    return 'remove meta.tier';
  },
  (m, r) => { const i = Math.floor(r() * 2); m.columns![i].dataType = 'BIGINT'; return `set columns[${i}].dataType`; },
  (m, r) => { const i = Math.floor(r() * 2); m.columns![i].description = 'Edited column'; return `set columns[${i}].description`; },
  (m, r) => { const i = Math.floor(r() * 2); m.columns![i].scdType = 3 as never; return `set columns[${i}].scdType`; },
  (m, r) => { const i = Math.floor(r() * 2); delete m.columns![i].scdType; return `clear columns[${i}].scdType`; },
  SWAP,
  RENAME,
  (m) => { if (m.relationships) m.relationships[0].role = 'seller'; return 'set role'; },
  (m) => { if (m.relationships) delete m.relationships[0].role; return 'clear role'; },
  (m) => { if (m.relationships) m.relationships[0].cardinality = 'one-to-one'; return 'set cardinality'; },
  (m) => { delete m.relationships; return 'remove the relationship'; },
];

/** The keys ERD Studio does not manage, as any YAML reader reads them, by column name where they sit in one. */
function unmanaged(text: string, renamed: Record<string, string>): Record<string, unknown> {
  const raw = parse(text) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (key.startsWith('x-')) out[key] = value;
  for (const col of (raw.columns as Array<Record<string, unknown>>) ?? []) {
    const name = renamed[String(col.name)] ?? String(col.name);
    if ('x-src' in col) out[`${name}.x-src`] = col['x-src'];
  }
  return out;
}

describe('a save over YAML anchors and aliases (#157, randomised)', () => {
  let tempDir: string;
  let service: LogicalModelService;
  let file: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-alias-prop-'));
    service = new LogicalModelService(tempDir);
    service.ensureDir();
    file = service.modelPath('fct_order');
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const save = (text: string, edit: (m: SemanticModel) => void): { out: string; model: SemanticModel } => {
    fs.writeFileSync(file, text);
    service.invalidateCache();
    const model = service.getModel('fct_order')!;
    edit(model);
    service.saveModel(model);
    return { out: fs.readFileSync(file, 'utf-8'), model };
  };

  it(`holds for ${CASES} generated files and edits`, () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed);
      const input = buildFile(r);
      const count = Math.floor(r() * 4); // 0–3 edits; 0 is the "nothing changed" save
      const applied: string[] = [];
      const edit = (m: SemanticModel): void => {
        for (let k = 0; k < count; k++) {
          const next = EDITS[Math.floor(r() * EDITS.length)];
          // A rename and a reorder never reach one save from the canvas (each
          // is its own edit), and columns are matched by name, else position.
          if ((next === RENAME || next === SWAP) && (applied.includes('rename customer_key') || applied.includes('swap the columns'))) continue;
          applied.push(next(m, r));
        }
      };
      const label = (): string => `seed ${seed} (${applied.join(', ') || 'no edit'})\n--- in\n${input}`;

      let result: { out: string; model: SemanticModel };
      try {
        result = save(input, edit);
      } catch (err) {
        throw new Error(`save threw for ${label()}\n${(err as Error).message}`);
      }
      const { out, model } = result;
      const at = `${label()}--- out\n${out}`;

      expect(parseDocument(out).errors, at).toEqual([]);
      expect(parseLogicalModelText(out, 'fct_order'), at).toEqual(model);
      const renamed = applied.includes('rename customer_key') ? { buyer_key: 'customer_key' } : {};
      expect(unmanaged(out, renamed), at).toEqual(unmanaged(input, {}));
      if (count === 0) expect(out, at).toBe(input);

      const again = save(out, () => {}).out;
      expect(again, `${at}--- second save\n${again}`).toBe(out);
    }
  });
});
