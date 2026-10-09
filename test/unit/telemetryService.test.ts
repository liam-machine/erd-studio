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

  it('records relationship states once a day and every broken invariant', async () => {
    startService();
    useToday();
    const clean = { storedTwice: 0, oneToManyInModelFile: 0, backwards: 0, danglingModel: 0, danglingColumn: 0, unreadable: 0, partialComposite: 0, caseRespelled: 0, domainCopyOfLibrary: 0 };
    telemetry.relationshipState({ ...clean, storedTwice: 4, danglingModel: 1 });
    telemetry.relationshipState({ ...clean, storedTwice: 2 });
    telemetry.relationshipState(clean);
    telemetry.relationshipInvariants(['otherLost', 'roleLost']);
    telemetry.relationshipInvariants(['otherLost']);
    telemetry.relationshipInvariants([]);

    vi.setSystemTime(new Date('2026-09-25T00:30:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);

    const [body] = sentBodies();
    expect(body.features).toEqual({ compare: 1, relStateStoredTwice: 1, relStateDanglingModel: 1 });
    expect(body.errors).toEqual({ relInvOtherLost: 2, relInvRoleLost: 1 });
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

  it('keeps one install id for good — it is never rotated', async () => {
    startService();
    const ids: string[] = [];
    for (const day of ['2026-09-24', '2026-10-24', '2027-01-10', '2027-09-30']) {
      vi.setSystemTime(new Date(`${day}T10:00:00Z`));
      services[services.length - 1].rollover();
      useToday();
      vi.setSystemTime(new Date(new Date(`${day}T10:00:00Z`).getTime() + 24 * HOUR));
      services[services.length - 1].rollover();
      await vi.advanceTimersByTimeAsync(0);
      ids.push(sentBodies().at(-1)!.installId);
    }
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(UUID_V4);
  });

  it('keeps an id minted by an older build that rotated it', async () => {
    const context = makeContext();
    const old = { id: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f', createdDay: '2026-01-01' };
    await context.globalState.update('erdStudio.telemetry.install', old);
    startService(context);
    useToday();
    vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sentBodies()[0].installId).toBe(old.id);
  });

  it('sends the editor app, remote kind and a dev flag from the extension mode', async () => {
    const appName = mock.env.appName;
    mock.env.appName = 'Cursor';
    mock.env.remoteName = 'wsl';
    try {
      const context = mock.createMockExtensionContext({
        storageRoot: path.join(os.tmpdir(), 'erd-telemetry-test'),
        extensionRoot: path.join(os.tmpdir(), 'erd-telemetry-test'),
        packageJSON: { version: '1.4.0' },
        extensionMode: mock.ExtensionMode.Development,
      }) as unknown as vscode.ExtensionContext;
      startService(context);
      useToday();
      vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
      await vi.advanceTimersByTimeAsync(HOUR);
      expect(sentBodies()[0]).toMatchObject({ host: 'cursor', remote: 'wsl', dev: true });
    } finally {
      mock.env.appName = appName;
      mock.env.remoteName = undefined;
    }
  });

  it('labels a day with the version that counted it, not the one sending it', async () => {
    const { context } = startService();
    useToday();
    services[0].dispose();
    services = [];
    // The extension updated overnight: the next activation runs 1.5.0.
    (context.extension as { packageJSON: unknown }).packageJSON = { version: '1.5.0' };
    vi.setSystemTime(new Date('2026-09-25T09:00:00Z'));
    startService(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(sentBodies()[0]).toMatchObject({ day: '2026-09-24', extVersion: '1.4.0' });
  });

  it('sends retention buckets counted on the device, never the dates', async () => {
    startService();
    for (const day of ['2026-09-20', '2026-09-22', '2026-09-24']) {
      vi.setSystemTime(new Date(`${day}T10:00:00Z`));
      services[0].rollover();
      telemetry.activation('project_found', true, 1);
      if (day !== '2026-09-22') telemetry.canvasOpened('logical', 'v5', 3);
    }
    vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    const body = sentBodies().at(-1)!;
    expect(body).toMatchObject({ day: '2026-09-24', activeDays28: '2-3', canvasDays28: '2-3', firstCanvas: '0' });
    // Earlier days' own heartbeats carry their day; this one never lists the others.
    expect(JSON.stringify(body)).not.toMatch(/2026-09-2[02]/);
  });

  it('records detected assistants and installed harnesses', async () => {
    startService();
    useToday();
    telemetry.assistants(['copilot', 'claude']);
    telemetry.harnesses(['claude']);
    vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sentBodies()[0]).toMatchObject({ assistants: ['claude', 'copilot'], harnesses: ['claude'] });
  });

  it('forgets the retention days when telemetry is switched off', async () => {
    const { context } = startService();
    useToday();
    expect(context.globalState.get('erdStudio.telemetry.activeDays')).toEqual(['2026-09-24']);
    mock._setMockTelemetryEnabled(false);
    expect(context.globalState.get('erdStudio.telemetry.activeDays')).toBeUndefined();
    expect(context.globalState.get('erdStudio.telemetry.canvasDays')).toBeUndefined();
    expect(context.globalState.get('erdStudio.telemetry.firstCanvasDay')).toBeUndefined();
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
