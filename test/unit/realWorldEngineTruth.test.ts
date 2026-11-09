/**
 * Database truth: the hand-counted expected.json against what the real engines
 * hold after loading each SQL sample (test/real-world-truth/engine/*.json, from
 * test/real-world-truth/readback.py; docs/dev/real-world-truth.md).
 *
 * Every difference is listed with its resolution in
 * test/real-world-truth/differences.json, and nothing else is: a new difference
 * (a truth edit, a recapture) fails here until it is explained, and an explained
 * difference that went away must be taken out.
 *
 *   ENGINE_TRUTH_OUT=/tmp/claude-501/engine-diffs.json npx vitest run test/unit/realWorldEngineTruth.test.ts
 *     writes the current differences (to start a differences.json entry from).
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { loadTruth } from './realWorldScorecard';
import {
  ENGINE_PAIRS,
  NOT_ENGINE_VERIFIED,
  allEngineDiffs,
  loadErrorText,
  canonType,
  compareWithEngine,
  diffKey,
  foldPartitions,
  loadDocumented,
  loadReadback,
  type EngineReadback,
} from './realWorldEngineTruth';

const truth = loadTruth();

describe('database truth (engine read-back) against expected.json', () => {
  const diffs = allEngineDiffs(truth.samples);
  const documented = loadDocumented();

  it('has an engine read-back for every SQL sample, or says why it has none', () => {
    for (const p of ENGINE_PAIRS) expect(loadReadback(p.engine), p.engine).not.toBeNull();
    // Every SQL sample in expected.json, not only the ones listed: a new sample needs a read-back or a reason.
    const sql = Object.entries(truth.samples).filter(([, s]) => s.importer === 'sql').map(([slug]) => slug).sort();
    const checked = new Set(ENGINE_PAIRS.map((p) => p.truth));
    for (const slug of sql) {
      expect(checked.has(slug) || slug in NOT_ENGINE_VERIFIED, `${slug}: an ENGINE_PAIRS entry or a NOT_ENGINE_VERIFIED reason`).toBe(true);
      expect(checked.has(slug) && slug in NOT_ENGINE_VERIFIED, `${slug}: engine-verified and listed as not`).toBe(false);
    }
    for (const slug of Object.keys(NOT_ENGINE_VERIFIED)) expect(sql, `${slug} in NOT_ENGINE_VERIFIED is a SQL sample`).toContain(slug);
  });

  it('names every sample with no engine read-back in expected.json\'s $comment', () => {
    // The truth file tells its reader which counts an engine checked; a sample added to
    // NOT_ENGINE_VERIFIED and left out of that sentence would read as engine-checked.
    const comment = (truth as unknown as { $comment: string[] }).$comment.find((l) => /NOT_ENGINE_VERIFIED/.test(l)) ?? '';
    for (const slug of Object.keys(NOT_ENGINE_VERIFIED)) expect(comment, `expected.json $comment names ${slug}`).toContain(slug);
  });

  it('has a SOURCE.md hand table that matches expected.json, table by table, for every sample with no engine', () => {
    // With no engine, the hand check in SOURCE.md is the second reading of the truth: one
    // foreign key per entry ("a, b → target"), each as the file writes it.
    for (const slug of Object.keys(NOT_ENGINE_VERIFIED)) {
      const sample = truth.samples[slug];
      const text = fs.readFileSync(path.join(__dirname, '../fixtures/real-world-imports', slug, 'SOURCE.md'), 'utf-8');
      const lines = text.split('\n');
      const head = lines.findIndex((l) => l.startsWith('|') && l.includes('Foreign keys (column → target)'));
      expect(head, `${slug}: SOURCE.md has a per-table table`).toBeGreaterThanOrEqual(0);
      const cells = (l: string): string[] => l.split('|').slice(1, -1).map((c) => c.trim());
      const header = cells(lines[head]);
      const col = (name: string): number => header.indexOf(name);
      const list = (c: string): string[] => (c === '–' ? [] : c.split(',').map((x) => x.trim()));
      const hand = new Map<string, { columns: number; pk: string[]; fks: string[] }>();
      for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) {
        const c = cells(lines[i]);
        const fks = c[col('Foreign keys (column → target)')] === '–' ? [] : c[col('Foreign keys (column → target)')].split(';').map((e) => {
          const [from, to] = e.split('→').map((x) => x.trim());
          return `${list(from).join(',')}>${to.split('.').pop()!}`;
        });
        hand.set(c[col('Table')], { columns: Number(c[col('Columns')]), pk: list(c[col('Primary key')]), fks: fks.sort() });
      }
      const fksOf = (table: string): string[] => {
        const groups = new Map<string, { cols: string[]; to: string }>();
        sample.relationships.filter((r) => r.from === table).forEach((r, i) => {
          const key = r.composite ?? `single${i}`;
          const g = groups.get(key) ?? { cols: [], to: r.to };
          g.cols.push(r.fromColumn);
          groups.set(key, g);
        });
        return [...groups.values()].map((g) => `${g.cols.join(',')}>${g.to}`).sort();
      };
      const want = new Map(sample.tables.map((t) => [t.name, { columns: t.columns.length, pk: t.pk, fks: fksOf(t.name) }]));
      expect(Object.fromEntries(hand), `${slug}: SOURCE.md's table against expected.json`).toEqual(Object.fromEntries(want));
    }
  });

  it('explains every statement an engine refused (loadErrors), by pattern and count', () => {
    for (const engine of new Set(ENGINE_PAIRS.map((p) => p.engine))) {
      const rb = loadReadback(engine)!;
      const patterns = documented.loadErrors.filter((l) => l.sample === engine);
      const counts = new Map(patterns.map((p) => [p, 0]));
      for (const e of rb.errors) {
        const hits = patterns.filter((p) => new RegExp(p.match).test(loadErrorText(e)));
        expect(hits.length, `${engine}: ${loadErrorText(e)} (${String(e.file)}:${String(e.line ?? e.batchLine)}) matches one loadErrors entry`).toBe(1);
        counts.set(hits[0], counts.get(hits[0])! + 1);
      }
      for (const [p, n] of counts) expect(n, `${engine}: ${p.match}`).toBe(p.count);
    }
  });

  it('explains every difference in differences.json, and lists no stale one', () => {
    const out = process.env.ENGINE_TRUTH_OUT;
    if (out) fs.writeFileSync(out, JSON.stringify(diffs, null, 1) + '\n');
    const found = diffs.map(diffKey).sort();
    const listed = documented.differences.map(diffKey).sort();
    expect(found.filter((k) => !listed.includes(k)), 'differences not in differences.json').toEqual([]);
    expect(listed.filter((k) => !found.includes(k)), 'differences.json entries that no longer differ').toEqual([]);
  });

  it('records the same truth and engine values as differences.json, each with a reason', () => {
    const byKey = new Map(diffs.map((d) => [diffKey(d), d]));
    for (const d of documented.differences) {
      const now = byKey.get(diffKey(d))!;
      expect({ truth: d.truth, engine: d.engine }, diffKey(d)).toEqual({ truth: now.truth, engine: now.engine });
      expect(d.reason.length, `${diffKey(d)} has a reason`).toBeGreaterThan(20);
    }
  });

  it('keeps every resolved difference resolved', () => {
    const found = new Set(diffs.map(diffKey));
    for (const r of documented.resolved) {
      expect(r.items.length, `${r.sample} ${r.kind}`).toBeGreaterThan(0);
      for (const item of r.items) expect(found.has(diffKey({ sample: r.sample, kind: r.kind, item })), `${r.sample} | ${r.kind} | ${item} differs again`).toBe(false);
    }
  });
});

describe('engine truth rules', () => {
  it('brings each dialect\'s spellings of a type to one form', () => {
    expect(canonType('postgres', 'SERIAL')).toBe(canonType('postgres', 'integer'));
    expect(canonType('postgres', 'varchar (30)')).toBe(canonType('postgres', 'character varying(30)'));
    expect(canonType('postgres', 'timestamptz')).toBe('timestamp with time zone');
    expect(canonType('postgres', 'timestamp')).toBe('timestamp without time zone');
    expect(canonType('postgres', 'public.year')).toBe('year');
    expect(canonType('mysql', 'INT(11)')).toBe('int');
    expect(canonType('mysql', 'BOOLEAN')).toBe('tinyint(1)');
    expect(canonType('sqlserver', '[nvarchar](60)')).toBe('nvarchar(60)');
    expect(canonType('sqlserver', '[datetime2]')).toBe('datetime2(7)');
    expect(canonType('snowflake', 'TIMESTAMP_NTZ(9)')).toBe(canonType('snowflake', 'TIMESTAMP_NTZ'));
    expect(canonType('snowflake', 'TIMESTAMP_LTZ(6)')).not.toBe(canonType('snowflake', 'TIMESTAMP_LTZ'));
    expect(canonType('snowflake', 'NUMBER(12)')).toBe('number(12,0)');
    expect(canonType('snowflake', 'STRING')).toBe('varchar(16777216)');
    expect(canonType('databricks', 'long')).toBe(canonType('databricks', 'BIGINT'));
  });

  const rb: EngineReadback = {
    sample: 's', engine: 'e', errors: [],
    tables: [
      { schema: 'public', name: 'payment', pk: ['id', 'at'], columns: [{ name: 'id', type: 'integer', notNull: true }, { name: 'at', type: 'date', notNull: true }, { name: 'customer_id', type: 'integer', notNull: true }] },
      { schema: 'public', name: 'payment_p1', partitionOf: 'public.payment', pk: ['id', 'at'], columns: [{ name: 'id', type: 'integer', notNull: true }, { name: 'at', type: 'date', notNull: true }, { name: 'customer_id', type: 'integer', notNull: true }] },
      { schema: 'public', name: 'customer', pk: ['id'], columns: [{ name: 'id', type: 'integer', notNull: true }] },
    ],
    uniqueKeys: [],
    foreignKeys: [
      { schema: 'public', table: 'payment_p1', name: 'a', columns: ['customer_id'], refSchema: 'public', refTable: 'customer', refColumns: ['id'] },
    ],
  };

  it('folds partitions into their parent, foreign keys and all', () => {
    const folded = foldPartitions(rb);
    expect(folded.tables.map((t) => t.name)).toEqual(['payment', 'customer']);
    expect(folded.foreignKeys.map((f) => `${f.table}>${f.refTable}`)).toEqual(['payment>customer']);
  });

  it('reports each kind of difference once, by item', () => {
    const diffs = compareWithEngine('s', {
      importer: 'sql', input: {}, counts: { tables: 2, columns: 3, primaryKeys: 2, relationships: 0 },
      tables: [
        { name: 'payment', schema: 'public', pk: ['id'], columns: [['id', 'int', 'PN'], ['at', 'date', ''], ['customer_id', 'bigint', 'N']] },
        { name: 'customer', schema: 'public', pk: ['id'], columns: [['id', 'serial', 'PN']] },
      ],
      relationships: [],
      uniqueKeys: [],
    }, foldPartitions(rb), 'postgres');
    expect(diffs.map(diffKey)).toEqual([
      's | foreign-key | payment (customer_id) → customer (id)',
      's | not-null | payment.at',
      's | primary-key | payment',
      's | type | payment.customer_id',
    ]);
  });
});
