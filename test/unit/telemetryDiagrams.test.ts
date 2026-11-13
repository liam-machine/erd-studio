/**
 * Use per diagram: `[id, opens, edits]` entries in the daily heartbeat.
 *
 * The id is a random number made up on the device. These tests hold the two
 * promises that make it private: nothing about the file (name, path, URI or a
 * hash of one) reaches the heartbeat, and nothing is kept while telemetry is off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { TelemetryService, planDiagramIds, telemetry } from '../../src/services/telemetryService';
import {
  MAX_CANVAS_OPENS,
  MAX_DIAGRAMS,
  MAX_DIAGRAM_EDITS,
  MAX_DIAGRAM_ID,
  OTHER_DIAGRAM_ID,
  buildHeartbeat,
  emptyCounters,
  heartbeatBytes,
  nextDay,
  recordActivation,
  recordDiagramUse,
  sentDiagrams,
} from '../../src/services/telemetryPayload';
import type { DailyCounters, HeartbeatBody, HeartbeatEnv } from '../../src/services/telemetryPayload';

const ENV: HeartbeatEnv = {
  installId: '6f1f7a52-3c7e-4f0e-9a51-1d2c3b4a5e6f',
  extVersion: '2.0.5',
  vscodeVersion: '1.104.2',
  platform: 'darwin',
  firstSeenDay: '2026-09-01',
};

function activeDay(): DailyCounters {
  return recordActivation(emptyCounters('2026-09-24'), { outcome: 'project_found', hasSemanticDir: true, domainCount: 2 });
}

describe('recordDiagramUse', () => {
  it('counts opens and edits per diagram', () => {
    let s = activeDay();
    s = recordDiagramUse(s, 41822, 'open');
    s = recordDiagramUse(s, 41822, 'edit');
    s = recordDiagramUse(s, 41822, 'edit');
    s = recordDiagramUse(s, 7, 'open');
    expect(sentDiagrams(s.diagrams)).toEqual(expect.arrayContaining([[41822, 1, 2], [7, 1, 0]]));
    expect(s.diagrams).toHaveLength(2);
  });

  it('never mutates its input', () => {
    const before = recordDiagramUse(activeDay(), 7, 'open');
    const copy = JSON.parse(JSON.stringify(before)) as DailyCounters;
    recordDiagramUse(before, 7, 'edit');
    expect(before).toEqual(copy);
  });

  it('caps each count', () => {
    let s = activeDay();
    for (let i = 0; i < MAX_CANVAS_OPENS + 5; i++) s = recordDiagramUse(s, 7, 'open');
    for (let i = 0; i < MAX_DIAGRAM_EDITS + 5; i++) s = recordDiagramUse(s, 7, 'edit');
    expect(s.diagrams).toEqual([[7, MAX_CANVAS_OPENS, MAX_DIAGRAM_EDITS]]);
  });

  it('adds up the diagrams past the cap under id 0, and keeps counting a listed one', () => {
    let s = activeDay();
    for (let id = 1; id <= MAX_DIAGRAMS + 3; id++) s = recordDiagramUse(s, id, 'open');
    s = recordDiagramUse(s, MAX_DIAGRAMS + 1, 'edit');
    s = recordDiagramUse(s, 1, 'edit');
    const sent = sentDiagrams(s.diagrams);
    expect(sent).toHaveLength(MAX_DIAGRAMS + 1);
    expect(sent.find(d => d[0] === OTHER_DIAGRAM_ID)).toEqual([OTHER_DIAGRAM_ID, 3, 1]);
    expect(sent.find(d => d[0] === 1)).toEqual([1, 1, 1]);
    // The day's totals are still right.
    expect(sent.reduce((n, d) => n + d[1], 0)).toBe(MAX_DIAGRAMS + 3);
  });

  it('ignores an id that is not a whole number from 1 to the cap', () => {
    const s = activeDay();
    for (const id of [0, -1, 1.5, MAX_DIAGRAM_ID + 1, Number.NaN]) expect(recordDiagramUse(s, id, 'open')).toBe(s);
  });

  it('starts again on the next day', () => {
    const s = recordDiagramUse(activeDay(), 7, 'open');
    expect(nextDay(s, '2026-09-25').diagrams).toBeUndefined();
  });
});

describe('the heartbeat', () => {
  it('omits diagrams on a day none was used, so an older day keeps its shape', () => {
    expect('diagrams' in buildHeartbeat(activeDay(), ENV)).toBe(false);
  });

  it('sends only numbers', () => {
    const s = recordDiagramUse(recordDiagramUse(activeDay(), 41822, 'open'), 41822, 'edit');
    expect(buildHeartbeat(s, ENV).diagrams).toEqual([[41822, 1, 1]]);
  });

  it('rebuilds stored entries: a stray string, a duplicate or an oversized count never reaches the wire', () => {
    const stored = [
      ['/Users/jane/acme/.erd-studio/gold/finance.dbml', 1, 0],
      [7, 1e9, -4],
      [7, 2, 2],
      [8, 1, 0, 'finance'],
      [MAX_DIAGRAM_ID + 1, 1, 0],
      'finance',
      [9, '3', null],
    ];
    const s = { ...activeDay(), diagrams: stored } as unknown as DailyCounters;
    const body = buildHeartbeat(s, ENV);
    expect(body.diagrams).toEqual([[7, MAX_CANVAS_OPENS, 0], [9, 0, 0]]);
    expect(JSON.stringify(body)).not.toContain('finance');
  });

  it('adds little to the body at its largest', () => {
    const base = buildHeartbeat(activeDay(), ENV);
    const diagrams = [...Array.from({ length: MAX_DIAGRAMS }, (_, i) => [MAX_DIAGRAM_ID - i, MAX_CANVAS_OPENS, MAX_DIAGRAM_EDITS]), [0, MAX_CANVAS_OPENS, MAX_DIAGRAM_EDITS]];
    const full = buildHeartbeat({ ...activeDay(), diagrams } as DailyCounters, ENV);
    expect(full.diagrams).toHaveLength(MAX_DIAGRAMS + 1);
    expect(heartbeatBytes(full) - heartbeatBytes(base)).toBeLessThan(700);
  });
});

describe('planDiagramIds', () => {
  const random = (...values: number[]) => () => values.shift() ?? 1;

  it('makes up a number for a new diagram and keeps it', () => {
    const first = planDiagramIds(undefined, 'aaa', '2026-09-24', random(41822));
    expect(first).toEqual({ id: 41822, map: { aaa: [41822, '2026-09-24'] }, changed: true });
    const again = planDiagramIds(first.map, 'aaa', '2026-09-30', random(5));
    expect(again.id).toBe(41822);
    expect(again.map.aaa).toEqual([41822, '2026-09-30']);
  });

  it('writes nothing more on a day the diagram was already used', () => {
    const first = planDiagramIds(undefined, 'aaa', '2026-09-24', random(9));
    expect(planDiagramIds(first.map, 'aaa', '2026-09-24', random(5)).changed).toBe(false);
  });

  it('never gives two diagrams the same number', () => {
    const first = planDiagramIds(undefined, 'aaa', '2026-09-24', random(9));
    const second = planDiagramIds(first.map, 'bbb', '2026-09-24', random(9, 9, 12));
    expect(second.id).toBe(12);
  });

  it('forgets a diagram not used for 90 days', () => {
    const first = planDiagramIds(undefined, 'aaa', '2026-06-01', random(9));
    const later = planDiagramIds(first.map, 'bbb', '2026-09-24', random(12));
    expect(Object.keys(later.map)).toEqual(['bbb']);
  });

  it('keeps at most 500, dropping the least recently used', () => {
    let map: Record<string, [number, string]> = {};
    for (let i = 0; i < 500; i++) map[`k${i}`] = [i + 1, i === 0 ? '2026-09-01' : '2026-09-20'];
    const next = planDiagramIds(map, 'new', '2026-09-24', random(60000));
    map = next.map;
    expect(Object.keys(map)).toHaveLength(500);
    expect(map.k0).toBeUndefined();
    expect(map.new).toEqual([60000, '2026-09-24']);
  });

  it('drops stored entries that are not [number, day]', () => {
    const stored = { ok: [5, '2026-09-20'], bad1: ['x', '2026-09-20'], bad2: [70000, '2026-09-20'], bad3: [6, 'yesterday'], bad4: 7 };
    const next = planDiagramIds(stored, 'new', '2026-09-24', random(8));
    expect(Object.keys(next.map).sort()).toEqual(['new', 'ok']);
  });
});

describe('through the service', () => {
  const mock = vscode as unknown as {
    _resetMockConfiguration: () => void;
    _setMockTelemetryEnabled: (enabled: boolean) => void;
    createMockExtensionContext: (options: { storageRoot: string; extensionRoot: string; packageJSON?: unknown }) => vscode.ExtensionContext;
  };
  const URI_A = 'file:///Users/jane/acme/.erd-studio/gold/finance.dbml';
  const URI_B = 'file:///Users/jane/acme/.erd-studio/silver/customer-360.json';
  let fetchMock: ReturnType<typeof vi.fn>;
  let services: TelemetryService[] = [];

  function start(): vscode.ExtensionContext {
    const root = path.join(os.tmpdir(), 'erd-telemetry-diagrams-test');
    const context = mock.createMockExtensionContext({ storageRoot: root, extensionRoot: root, packageJSON: { version: '2.0.5' } });
    const service = new TelemetryService(context);
    services.push(service);
    service.start();
    return context;
  }

  const sent = (): HeartbeatBody[] => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as HeartbeatBody);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    mock._resetMockConfiguration();
    mock._setMockTelemetryEnabled(true);
  });

  afterEach(() => {
    for (const s of services) s.dispose();
    services = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
    mock._setMockTelemetryEnabled(true);
  });

  it('sends a count per diagram and nothing that names one', async () => {
    start();
    telemetry.activation('project_found', true, 2);
    telemetry.diagramUsed(URI_A, 'open');
    telemetry.diagramUsed(URI_A, 'edit');
    telemetry.diagramUsed(URI_A, 'edit');
    telemetry.diagramUsed(URI_B, 'open');
    vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    const body = sent().at(-1)!;
    expect(body.day).toBe('2026-09-24');
    const diagrams = body.diagrams!;
    expect(diagrams.map(d => [d[1], d[2]]).sort()).toEqual([[1, 0], [1, 2]]);
    expect(new Set(diagrams.map(d => d[0])).size).toBe(2);
    for (const [id] of diagrams) expect(Number.isInteger(id) && id >= 1 && id <= MAX_DIAGRAM_ID).toBe(true);
    const text = JSON.stringify(body);
    for (const word of ['finance', 'customer', 'acme', 'jane', 'file:', '.erd-studio', '.dbml']) expect(text).not.toContain(word);
  });

  it('gives a diagram the same number on a later day', async () => {
    start();
    telemetry.activation('project_found', true, 2);
    telemetry.diagramUsed(URI_A, 'open');
    vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
    services[0].rollover();
    telemetry.activation('project_found', true, 2);
    telemetry.diagramUsed(URI_A, 'open');
    vi.setSystemTime(new Date('2026-09-26T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    const ids = sent().filter(b => b.diagrams).map(b => b.diagrams![0][0]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('keeps no URI on the device, only a fingerprint', () => {
    const context = start();
    telemetry.diagramUsed(URI_A, 'open');
    const stored = JSON.stringify(context.globalState.get('erdStudio.telemetry.diagramIds'));
    expect(stored).toMatch(/^\{"[0-9a-f]{24}":\[\d+,"2026-09-24"\]\}$/);
  });

  it('keeps and counts nothing while telemetry is off', () => {
    mock._setMockTelemetryEnabled(false);
    const context = start();
    telemetry.diagramUsed(URI_A, 'open');
    expect(context.globalState.get('erdStudio.telemetry.diagramIds')).toBeUndefined();
    expect(context.globalState.get<DailyCounters>('erdStudio.telemetry.counters')?.diagrams).toBeUndefined();
  });
});

describe('the documents', () => {
  const read = (file: string): string => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');

  it('telemetry.json describes diagrams', () => {
    const fields = JSON.parse(read('telemetry.json')).events['liamwynne.erd-studio/heartbeat'] as Record<string, { comment: string }>;
    expect(fields.diagrams.comment).toMatch(/random number/);
    expect(fields.diagrams.comment).toMatch(/never .*name/);
  });

  it('the Worker README and schema describe the column', () => {
    expect(read('telemetry/README.md')).toMatch(/`diagrams`/);
    expect(read('telemetry/schema.sql')).toMatch(/diagrams TEXT/);
  });
});
