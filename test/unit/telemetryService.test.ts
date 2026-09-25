/**
 * telemetryService — storage, timing, the switches and the network.
 *
 * Time is faked so a day can roll over inside a test, and `fetch` is stubbed
 * globally: the service calls the real global, so a forgotten stub would try
 * the network — `afterEach` restores it and every test installs its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  TELEMETRY_ENDPOINT,
  TelemetryService,
  setTelemetryEndpointForTests,
  telemetry,
} from '../../src/services/telemetryService';
import type { HeartbeatBody } from '../../src/services/telemetryPayload';

const mock = vscode as unknown as {
  _setMockConfiguration: (section: string, key: string, values: { globalValue?: unknown }) => void;
  _resetMockConfiguration: () => void;
  _setMockTelemetryEnabled: (enabled: boolean) => void;
  createMockExtensionContext: (options: { storageRoot: string; extensionRoot: string; packageJSON?: unknown }) => vscode.ExtensionContext;
  env: { machineId?: string };
};

const HOUR = 60 * 60 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let fetchMock: ReturnType<typeof vi.fn>;
let services: TelemetryService[] = [];

function makeContext(): vscode.ExtensionContext {
  const root = path.join(os.tmpdir(), 'erd-telemetry-test');
  return mock.createMockExtensionContext({ storageRoot: root, extensionRoot: root, packageJSON: { version: '1.4.0' } });
}

function startService(context = makeContext()): { service: TelemetryService; context: vscode.ExtensionContext } {
  const service = new TelemetryService(context);
  services.push(service);
  service.start();
  return { service, context };
}

function sentBodies(): HeartbeatBody[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as HeartbeatBody);
}

/** A day of use: one activation and a canvas, recorded through the facade. */
function useToday(): void {
  telemetry.activation('project_found', true, 2);
  telemetry.canvasOpened('logical', 'v5', 8);
  telemetry.feature('compare');
}

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
  setTelemetryEndpointForTests(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mock._setMockTelemetryEnabled(true);
});

describe('TelemetryService', () => {
  it('sends one heartbeat for the finished day when the day rolls over', async () => {
    startService();
    useToday();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-09-25T00:30:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    await vi.advanceTimersByTimeAsync(HOUR);
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TELEMETRY_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const [body] = sentBodies();
    expect(body).toMatchObject({
      v: 1,
      day: '2026-09-24',
      extVersion: '1.4.0',
      activation: 'project_found',
      hasSemanticDir: true,
      domainCount: '1-3',
      activations: 1,
      canvasOpens: 1,
      stages: ['logical'],
      schemaFormats: ['v5'],
      modelCount: '1-10',
      features: { compare: 1 },
      errors: {},
    });
    expect(body.installId).toMatch(UUID_V4);
  });

  it('sends the previous day on the next activation, then nothing more that day', async () => {
    const { context } = startService();
    useToday();
    services[0].dispose();

    vi.setSystemTime(new Date('2026-09-26T08:00:00Z'));
    startService(context);
    telemetry.feature('addModel');
    startService(context);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBodies()[0].day).toBe('2026-09-24');
  });

  it('sends nothing while VS Code telemetry is disabled, and forgets what was counted', async () => {
    startService();
    useToday();
    mock._setMockTelemetryEnabled(false);
    useToday();
    vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(fetchMock).not.toHaveBeenCalled();

    // Switched back on: the day counted before the switch is never sent.
    mock._setMockTelemetryEnabled(true);
    vi.setSystemTime(new Date('2026-09-26T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing when erdStudio.telemetry.enabled is false', async () => {
    mock._setMockConfiguration('erdStudio', 'telemetry.enabled', { globalValue: false });
    startService();
    useToday();
    vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads erdStudio.telemetry.enabled from user settings only', async () => {
    // A checked-in .vscode/settings.json does not get to decide either way.
    mock._setMockConfiguration('erdStudio', 'telemetry.enabled', { workspaceValue: false } as never);
    startService();
    useToday();
    vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops a failed send silently, with no retry', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startService();
    useToday();
    vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
  });

  it('aborts a send that takes longer than 5 seconds', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise(() => {});
    });
    startService();
    useToday();
    vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signal?.aborted).toBe(true);
  });

  it('skips a day with nothing counted and a day older than the Worker accepts', async () => {
    const { context } = startService();
    vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR); // 24th: nothing recorded
    useToday();
    services[0].dispose();
    vi.setSystemTime(new Date('2026-10-05T01:00:00Z')); // 25th is 10 days old
    startService(context);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps one install id for 30 days, then mints a new random one', async () => {
    startService();
    const ids: string[] = [];
    for (const day of ['2026-09-24', '2026-10-10', '2026-10-23', '2026-10-24']) {
      vi.setSystemTime(new Date(`${day}T10:00:00Z`));
      services[services.length - 1].rollover();
      useToday();
      vi.setSystemTime(new Date(new Date(`${day}T10:00:00Z`).getTime() + 24 * HOUR));
      services[services.length - 1].rollover();
      await vi.advanceTimersByTimeAsync(0);
      ids.push(sentBodies().at(-1)!.installId);
    }
    // Minted at the first send (2026-09-25); the send on 10-24 is 29 days on, 10-25 is 30.
    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
    expect(ids[3]).not.toBe(ids[2]);
    expect(ids.every(id => UUID_V4.test(id))).toBe(true);
  });

  it('never uses vscode.env.machineId', async () => {
    mock.env.machineId = 'machine-id-that-must-not-leak';
    try {
      startService();
      useToday();
      vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
      await vi.advanceTimersByTimeAsync(HOUR);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(sentBodies())).not.toContain('machine-id-that-must-not-leak');
    } finally {
      delete mock.env.machineId;
    }
  });

  it('refuses an endpoint that is not https', async () => {
    setTelemetryEndpointForTests('http://telemetry.example.com/v1/heartbeat');
    startService();
    useToday();
    vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('computes tenure from the first activation', async () => {
    startService();
    useToday();
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    services[0].rollover(); // the 24th is now older than the Worker accepts: not sent
    useToday();
    vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));
    services[0].rollover();
    await vi.advanceTimersByTimeAsync(0);
    expect(sentBodies().map(b => [b.day, b.tenure])).toEqual([['2026-10-20', '8-30']]);
  });

  it('is a no-op facade when no service exists', () => {
    expect(() => {
      useToday();
      telemetry.error('other');
    }).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
