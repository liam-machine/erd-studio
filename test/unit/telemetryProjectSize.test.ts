/**
 * #331: how big a project is, as fixed ranges. `model_count` stops at `51+`
 * and is set only by a canvas open, so a 60-table diagram and a 1,100-table
 * one sent the same heartbeat, and nothing said how many tables the Table
 * Library holds. Two families of presence keys now say it:
 *
 * - `libraryTables*`: the library's size when a window with a project opens;
 * - `diagramTables*`: the largest diagram of more than 50 tables opened that day.
 *
 * The rule pinned here: one key per family per day, the largest range wins,
 * every edge sits where the issue put it, `diagramTables*` exists exactly when
 * `modelCount` is `51+`, the keys survive the size guard, and nothing about
 * the existing fields changes. Never a count, a name or a path.
 */
import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  HEARTBEAT_SOFT_LIMIT,
  HEARTBEAT_VERSION,
  LARGE_DIAGRAM_FEATURES,
  LIBRARY_TABLE_FEATURES,
  buildHeartbeat,
  emptyCounters,
  hasCounts,
  heartbeatBytes,
  largeDiagramFeature,
  libraryTablesFeature,
  nextDay,
  provisionalBody,
  recordActivation,
  recordCanvasOpen,
  recordLibraryTables,
  tableCountBucket,
  trimHeartbeat,
  type DailyCounters,
  type HeartbeatEnv,
} from '../../src/services/telemetryPayload';
import { distinctTableCount } from '../../src/services/tableLibraryIndex';
import type { TableFileEntry } from '../../src/services/logicalModelService';

const ENV: HeartbeatEnv = {
  installId: '3b241101-e2bb-4255-8caf-4136c566a962',
  extVersion: '2.0.6',
  vscodeVersion: '1.104.2',
  platform: 'darwin',
  firstSeenDay: '2026-09-01',
};
const DAY = '2026-11-16';

const open = (s: DailyCounters, modelCount: number, stage: 'logical' | 'physical' = 'logical'): DailyCounters =>
  recordCanvasOpen(s, { stage, format: 'v5', modelCount });

const sizeKeys = (s: DailyCounters | { features: Record<string, number | undefined> }) =>
  Object.keys(s.features).filter((k) => /^(libraryTables|diagramTables)/.test(k));

describe('the ranges (#331)', () => {
  it('a library is None, 1–10, 11–50, 51–199, 200–499 or 500+ tables', () => {
    const counts = [0, 1, 10, 11, 50, 51, 199, 200, 499, 500, 5000];
    expect(counts.map(libraryTablesFeature)).toEqual([
      'libraryTablesNone',
      'libraryTables1to10', 'libraryTables1to10',
      'libraryTables11to50', 'libraryTables11to50',
      'libraryTables51to199', 'libraryTables51to199',
      'libraryTables200to499', 'libraryTables200to499',
      'libraryTables500Plus', 'libraryTables500Plus',
    ]);
  });

  it('the library\'s edges below 51 are model_count\'s, so the two read side by side', () => {
    const named = { libraryTablesNone: 'none', libraryTables1to10: '1-10', libraryTables11to50: '11-50' } as const;
    for (let n = 0; n <= 60; n++) {
      const key = libraryTablesFeature(n);
      expect(key in named ? named[key as keyof typeof named] : '51+', String(n)).toBe(tableCountBucket(n));
    }
  });

  it('a diagram has a key only above 50 tables: 51–199, 200–499 or 500+', () => {
    expect([0, 1, 10, 49, 50].map(largeDiagramFeature)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect([51, 199, 200, 499, 500, 1100].map(largeDiagramFeature)).toEqual([
      'diagramTables51to199', 'diagramTables51to199',
      'diagramTables200to499', 'diagramTables200to499',
      'diagramTables500Plus', 'diagramTables500Plus',
    ]);
  });

  it('the two families are listed in FEATURES, in range order, at the end of the #331 block', () => {
    expect(LIBRARY_TABLE_FEATURES).toEqual([
      'libraryTablesNone', 'libraryTables1to10', 'libraryTables11to50',
      'libraryTables51to199', 'libraryTables200to499', 'libraryTables500Plus',
    ]);
    expect(LARGE_DIAGRAM_FEATURES).toEqual(['diagramTables51to199', 'diagramTables200to499', 'diagramTables500Plus']);
    const at = FEATURES.indexOf('libraryTablesNone');
    expect(at).toBe(FEATURES.indexOf('readyLateOver60s') + 1);
    expect(FEATURES.slice(at, at + 9)).toEqual([...LIBRARY_TABLE_FEATURES, ...LARGE_DIAGRAM_FEATURES]);
  });
});

describe('the largest diagram opened that day (#331)', () => {
  it('60, then 300, then 20 tables leaves only diagramTables200to499', () => {
    let s = emptyCounters(DAY);
    s = open(s, 60);
    expect(sizeKeys(s)).toEqual(['diagramTables51to199']);
    s = open(s, 300);
    s = open(s, 20);
    expect(sizeKeys(s)).toEqual(['diagramTables200to499']);
    expect(s.features.diagramTables200to499).toBe(1);
    expect(s.modelCount).toBe('51+');
  });

  it('the same opens in reverse order give the same day', () => {
    let s = emptyCounters(DAY);
    for (const n of [20, 300, 60]) s = open(s, n);
    expect(sizeKeys(s)).toEqual(['diagramTables200to499']);
    expect(s.features.diagramTables200to499).toBe(1);
  });

  it('a diagram of 50 tables or fewer adds no key; model_count is unchanged', () => {
    let s = emptyCounters(DAY);
    s = open(s, 50);
    s = open(s, 7);
    expect(sizeKeys(s)).toEqual([]);
    expect(s.modelCount).toBe('11-50');
  });

  it('a physical open counts like a logical one, as model_count does', () => {
    const s = open(emptyCounters(DAY), 1100, 'physical');
    expect(sizeKeys(s)).toEqual(['diagramTables500Plus']);
    expect(s.modelCount).toBe('51+');
  });

  it('for any sequence of opens, a diagramTables key exists exactly when model_count is 51+, and never more than one', () => {
    const sizes = [0, 1, 50, 51, 120, 199, 200, 350, 499, 500, 2000];
    // Every sequence of three opens over these sizes (11^3 = 1,331 days).
    for (const a of sizes) for (const b of sizes) for (const c of sizes) {
      const s = [a, b, c].reduce(open, emptyCounters(DAY));
      const keys = sizeKeys(s);
      const largest = Math.max(a, b, c);
      expect(keys.length, `${a},${b},${c}`).toBe(s.modelCount === '51+' ? 1 : 0);
      if (keys.length === 1) expect(keys[0], `${a},${b},${c}`).toBe(largeDiagramFeature(largest));
    }
  });

  it('the existing canvas fields are untouched', () => {
    const s = open(open(emptyCounters(DAY), 300), 10);
    expect(s.canvasOpens).toBe(2);
    expect(s.stages).toEqual(['logical']);
    expect(s.schemaFormats).toEqual(['v5']);
  });
});

describe('the Table Library at activation (#331)', () => {
  it('records the library\'s range, once', () => {
    const s = recordLibraryTables(emptyCounters(DAY), 250);
    expect(sizeKeys(s)).toEqual(['libraryTables200to499']);
    expect(s.features.libraryTables200to499).toBe(1);
    expect(recordLibraryTables(s, 250)).toBe(s);
  });

  it('two windows on one day keep only the larger library, in either order', () => {
    const a = recordLibraryTables(recordLibraryTables(emptyCounters(DAY), 0), 600);
    const b = recordLibraryTables(recordLibraryTables(emptyCounters(DAY), 600), 0);
    expect(sizeKeys(a)).toEqual(['libraryTables500Plus']);
    expect(sizeKeys(b)).toEqual(['libraryTables500Plus']);
  });

  it('counts tables, not files: a YAML copy in both libraries once, two DBML schemas\' tables of one name twice', () => {
    const yaml = (name: string, library?: 'tables', shadowedBy?: string): TableFileEntry =>
      ({ name, folder: '', filePath: `/p/.erd-studio/${library ?? 'logical-models'}/${name}.yml`, storage: 'yaml', ...(library ? { library } : {}), ...(shadowedBy ? { shadowedBy } : {}) });
    const dbml = (schema: string, name: string): TableFileEntry =>
      ({ name, folder: schema, layer: 'silver', filePath: `/p/.erd-studio/silver/tables/${schema}/${name}.dbml`, storage: 'dbml' });
    expect(distinctTableCount([])).toBe(0);
    expect(distinctTableCount([yaml('dim_customer'), yaml('dim_customer', 'tables', '/p/.erd-studio/logical-models/dim_customer.yml'), yaml('fct_order')])).toBe(2);
    expect(distinctTableCount([yaml('Customer'), yaml('customer', 'tables', '/p/.erd-studio/logical-models/Customer.yml')])).toBe(1);
    expect(distinctTableCount([dbml('sales', 'customer'), dbml('crm', 'customer')])).toBe(2);
  });

  it('an empty library is libraryTablesNone', () => {
    expect(sizeKeys(recordLibraryTables(emptyCounters(DAY), 0))).toEqual(['libraryTablesNone']);
  });

  it('the library and the diagram ranges are separate families', () => {
    let s = recordLibraryTables(emptyCounters(DAY), 40);
    s = open(s, 300);
    expect(sizeKeys(s).sort()).toEqual(['diagramTables200to499', 'libraryTables11to50']);
  });

  it('neither family carries over to the next day, so an idle day sends nothing', () => {
    let s = recordActivation(emptyCounters(DAY), { outcome: 'project_found', hasSemanticDir: true, domainCount: 2 });
    s = open(recordLibraryTables(s, 250), 300);
    const next = nextDay(s, '2026-11-17');
    expect(sizeKeys(next)).toEqual([]);
    expect(hasCounts(next)).toBe(false);
  });
});

describe('the heartbeat (#331)', () => {
  it('sends the keys as presence flags, with model_count, domain_count and the version unchanged', () => {
    let s = recordActivation(emptyCounters(DAY), { outcome: 'project_found', hasSemanticDir: true, domainCount: 2 });
    s = recordLibraryTables(s, 250);
    s = open(s, 1100);
    const body = buildHeartbeat(s, ENV);
    expect(body.v).toBe(HEARTBEAT_VERSION);
    expect(HEARTBEAT_VERSION).toBe(1);
    expect(body.modelCount).toBe('51+');
    expect(body.domainCount).toBe('1-3');
    expect(body.features).toEqual({ libraryTables200to499: 1, diagramTables500Plus: 1 });
  });

  it('a day over the size guard keeps them: they are the newest keys, and the trim would take them first', () => {
    const all = Object.fromEntries(FEATURES.map((f) => [f, 1]));
    const s: DailyCounters = { ...emptyCounters(DAY), features: { ...all, libraryTables500Plus: 1, diagramTables500Plus: 1 } };
    const body = provisionalBody(buildHeartbeat(s, ENV));
    expect(heartbeatBytes(body)).toBeGreaterThan(HEARTBEAT_SOFT_LIMIT);
    const trimmed = trimHeartbeat(body);
    expect(heartbeatBytes(trimmed)).toBeLessThanOrEqual(HEARTBEAT_SOFT_LIMIT);
    expect(trimmed.features.heartbeatTrimmed).toBe(1);
    for (const key of [...LIBRARY_TABLE_FEATURES, ...LARGE_DIAGRAM_FEATURES]) expect(trimmed.features[key], key).toBe(1);
  });
});
