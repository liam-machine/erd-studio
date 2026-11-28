/**
 * #354 — a logged error whose tag counts as `Other` names its site.
 *
 * The rule: each site that logs a `loggedErrorOther` line of ours records one
 * fixed `loggedErrorAt*` code beside it, and a tag the area table does not
 * list records `loggedErrorUnlistedTag`; never the tag or the line's text.
 * Every new code starts with `loggedError`, so none starts the known-fixes
 * check or an interim heartbeat.
 *
 * The hook is installed exactly as activation does (src/extension.ts), and
 * `telemetry.error` is spied so a code recorded at the site shows up beside
 * the hook's pair.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { LOGGED_ERROR_AREAS, loggedErrorCodes } from '../../src/services/runtimeTelemetry';
import { log, setErrorHook } from '../../src/services/logger';
import { telemetry } from '../../src/services/telemetryService';
import { ReportTrackingService, type TrackingFetch } from '../../src/services/reportTrackingService';
import { FileWatcherService } from '../../src/watchers/FileWatcherService';
import { _clearMockFileWatchers } from '../__mocks__/vscode';

const ROOT = path.resolve(__dirname, '../..');

/** The #354 codes, in their allowlist order. */
const SITE_CODES = [
  'loggedErrorAtWatcher',
  'loggedErrorAtLegacyRename',
  'loggedErrorAtRedraw',
  'loggedErrorAtExplorerMove',
  'loggedErrorAtFeedbackSend',
  'loggedErrorAtFailureAction',
  'loggedErrorAtTrackingSession',
  'loggedErrorAtTrackingRefresh',
  'loggedErrorUnlistedTag',
] as const;

let recorded: string[] = [];

function makeContext(): vscode.ExtensionContext {
  return (vscode as any).createMockExtensionContext({
    storageRoot: path.join(os.tmpdir(), 'erd-354'),
    extensionRoot: ROOT,
    globalStateSeed: [],
  }) as vscode.ExtensionContext;
}

beforeEach(() => {
  recorded = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(telemetry, 'error').mockImplementation((code) => { recorded.push(code); });
  // The same hook activation installs.
  setErrorHook((source) => { for (const code of loggedErrorCodes(source)) telemetry.error(code); });
  (vscode as any)._resetMockConfiguration();
  (vscode as any)._resetMockGithubSession();
  _clearMockFileWatchers();
});

afterEach(() => {
  setErrorHook(undefined);
  (vscode as any)._resetMockGithubSession();
  vi.restoreAllMocks();
});

async function myReportsPollFails(): Promise<string[]> {
  (vscode as any)._setMockGithubSession({
    id: 's', accessToken: 't', account: { id: '1', label: 'someone' }, scopes: ['read:user'],
  });
  const rateLimited: TrackingFetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
  const service = new ReportTrackingService(makeContext(), rateLimited);
  recorded = [];
  await service.refresh(); // the activation call (`void trackingService.refresh()`), cache empty → stale
  service.dispose();
  return [...recorded];
}

function watcherListenerThrows(): string[] {
  const service = new FileWatcherService('/test/workspace', '.erd-studio', undefined, undefined, { dbt: false });
  recorded = [];
  (service as any).safeFireEvent(() => { throw new Error('listener blew up'); });
  service.dispose();
  return [...recorded];
}

describe('#354: each loggedErrorOther site names itself', () => {
  it('a failed My Reports poll at start (403) records loggedErrorAtTrackingRefresh', async () => {
    const codes = await myReportsPollFails();
    console.log('My Reports poll 403 →', JSON.stringify(codes));
    expect(codes).toEqual(['loggedError', 'loggedErrorOther', 'loggedErrorAtTrackingRefresh']);
  });

  it('a failed silent GitHub session lookup records loggedErrorAtTrackingSession, apart from the poll', async () => {
    vi.spyOn(vscode.authentication, 'getSession').mockRejectedValue(new Error('auth provider gone'));
    const service = new ReportTrackingService(makeContext(), vi.fn());
    recorded = [];
    await service.refresh();
    service.dispose();
    console.log('getHandle throws →', JSON.stringify(recorded));
    expect(recorded).toEqual(['loggedError', 'loggedErrorOther', 'loggedErrorAtTrackingSession']);
  });

  it('a throwing file-change listener records loggedErrorAtWatcher', () => {
    const codes = watcherListenerThrows();
    console.log('watcher listener throws →', JSON.stringify(codes));
    expect(codes).toEqual(['loggedError', 'loggedErrorOther', 'loggedErrorAtWatcher']);
  });

  it('two different sites can be told apart in the heartbeat', async () => {
    const poll = await myReportsPollFails();
    const watcher = watcherListenerThrows();
    expect(poll).not.toEqual(watcher);
  });

  it('a tag nobody listed records loggedErrorUnlistedTag; an untagged line stays plain Other', () => {
    log.error('[Brand New] x');
    const unlisted = [...recorded];
    recorded = [];
    log.error('no tag at all');
    const untagged = [...recorded];
    console.log('unlisted tag →', JSON.stringify(unlisted), ' untagged →', JSON.stringify(untagged));
    expect(unlisted).toEqual(['loggedError', 'loggedErrorOther', 'loggedErrorUnlistedTag']);
    expect(untagged).toEqual(['loggedError', 'loggedErrorOther']);
  });

  it("a failure's own button that throws records loggedErrorAtFailureAction (commandFailure.ts)", async () => {
    const { showCommandFailure } = await import('../../src/commands/commandFailure');
    const { TRY_AGAIN_BUTTON } = await import('../../src/services/commandErrors');
    vi.spyOn(vscode.window, 'showErrorMessage')
      .mockResolvedValueOnce(TRY_AGAIN_BUTTON as never)
      .mockResolvedValue(undefined as never);
    showCommandFailure(
      { title: 'Rename Diagram', message: 'm', buttons: [TRY_AGAIN_BUTTON], doing: 'while renaming' },
      new Error('first'),
      { retry: () => { throw new Error('retry blew up'); } },
    );
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    console.log('failure button throws →', JSON.stringify(recorded));
    expect(recorded).toContain('loggedErrorAtFailureAction');
    expect(recorded.filter((c) => c === 'loggedErrorAtFailureAction')).toHaveLength(1);
  });
});

describe('#354: the site codes are fixed keys that never trigger anything', () => {
  it('every #354 code is an allowlisted error code that starts with loggedError, in one block in order', async () => {
    const { ERROR_CODES, FEATURES } = await import('../../src/services/telemetryPayload');
    // Later codes are appended after the block (#370's were the first); the exact tail is pinned in telemetryPayload.test.ts.
    const at = ERROR_CODES.indexOf(SITE_CODES[0]);
    expect(ERROR_CODES.slice(at, at + SITE_CODES.length)).toEqual([...SITE_CODES]);
    for (const code of SITE_CODES) {
      expect(code.startsWith('loggedError'), code).toBe(true);
      expect(code.length, code).toBeLessThanOrEqual(34);
      expect(FEATURES as readonly string[], code).not.toContain(code);
    }
  });

  it('provisionalTrigger asks for no interim copy when only these codes are new today', async () => {
    const { emptyCounters, provisionalTrigger, recordError } = await import('../../src/services/telemetryPayload');
    const before = emptyCounters('2026-11-28');
    let after = recordError(recordError(before, 'loggedError'), 'loggedErrorOther');
    for (const code of SITE_CODES) after = recordError(after, code);
    console.log('provisionalTrigger →', String(provisionalTrigger(before, after)));
    expect(provisionalTrigger(before, after)).toBeUndefined();
    // A code of ours that is not the catch-all still asks.
    expect(provisionalTrigger(before, recordError(after, 'saveFailed'))).toBe('error');
  });

  it('the known-fixes check never fetches the registry for them', async () => {
    vi.mocked(telemetry.error).mockRestore();
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { setKnownFixesEndpointForTests, startKnownFixes } = await import('../../src/services/knownFixesService');
    setKnownFixesEndpointForTests('https://telemetry.example/known-fixes');
    const context = (vscode as any).createMockExtensionContext({
      storageRoot: path.join(os.tmpdir(), 'erd-354-known-fixes'),
      extensionRoot: path.join(os.tmpdir(), 'erd-354-known-fixes', 'ext'),
      packageJSON: { version: '2.0.12' },
    }) as vscode.ExtensionContext;
    try {
      startKnownFixes(context);
      for (const code of SITE_CODES) telemetry.error(code);
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      for (const s of context.subscriptions) s.dispose();
      setKnownFixesEndpointForTests(null);
      vi.unstubAllGlobals();
    }
  });
});

describe('#354: every site records its code beside its log line', () => {
  const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf-8');

  // The sites a unit test cannot drive without activate(): each log line, and
  // the code that must follow it within the next two lines.
  const SITES: Array<[file: string, line: string, code: (typeof SITE_CODES)[number]]> = [
    ['src/watchers/FileWatcherService.ts', "'[FileWatcherService] Error in event handler:'", 'loggedErrorAtWatcher'],
    ['src/extension.ts', "'[ERD Studio] Legacy erd-studio/ migration failed:'", 'loggedErrorAtLegacyRename'],
    ['src/extension.ts', "'[ERD Studio] Redraw of a diagram from its file failed:'", 'loggedErrorAtRedraw'],
    ['src/extension.ts', "'[ERD Studio] Redraw after a fields.yml change failed:'", 'loggedErrorAtRedraw'],
    ['src/extension.ts', "'[ERD Studio] Following an Explorer move failed:'", 'loggedErrorAtExplorerMove'],
    ['src/extension.ts', "'[ERD Studio] Send Feedback: recording the report failed:'", 'loggedErrorAtFeedbackSend'],
    ['src/extension.ts', "'[ERD Studio] Send Feedback: copying the text failed:'", 'loggedErrorAtFeedbackSend'],
    ['src/services/reportTrackingService.ts', "hostErrorLog.record('ReportTrackingService.getHandle'", 'loggedErrorAtTrackingSession'],
    ['src/services/reportTrackingService.ts', "hostErrorLog.record('ReportTrackingService.refresh'", 'loggedErrorAtTrackingRefresh'],
  ];

  it.each(SITES)('%s: %s → %s', (file, line, code) => {
    const lines = read(file).split('\n');
    const at = lines.findIndex((l) => l.includes(line));
    expect(at, line).toBeGreaterThanOrEqual(0);
    expect(lines.filter((l) => l.includes(line)), line).toHaveLength(1);
    expect(lines.slice(at + 1, at + 3).join('\n'), line).toContain(`telemetry.error('${code}')`);
  });

  it('each site code is recorded only at its listed sites', () => {
    const files = [...new Set(SITES.map(([file]) => file))];
    for (const code of SITE_CODES.filter((c) => c !== 'loggedErrorUnlistedTag' && c !== 'loggedErrorAtFailureAction')) {
      const uses = files.reduce((n, file) => n + read(file).split(`telemetry.error('${code}')`).length - 1, 0);
      expect(uses, code).toBe(SITES.filter(([, , c]) => c === code).length);
    }
  });
});

describe('#354: every failure-button line records loggedErrorAtFailureAction', () => {
  // A button on a message of ours (Try Again, Send Feedback, Open It, Show
  // Import Report, …) that throws logs `[ERD Studio] <title>: "<button>" failed:`.
  // Found by scanning, so a new site cannot be missed.
  const FAILURE_LINE = /\[ERD Studio\][^`]*: "\$\{[^}]+\}" failed:/;
  const CODE = "telemetry.error('loggedErrorAtFailureAction')";

  function tsUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsUnder(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('each such line has the code within the next two lines, and the code is used nowhere else', () => {
    let lineCount = 0;
    let codeCount = 0;
    const missing: string[] = [];
    for (const file of tsUnder(path.join(ROOT, 'src'))) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      codeCount += lines.filter((l) => l.includes(CODE)).length;
      lines.forEach((l, i) => {
        if (!FAILURE_LINE.test(l)) return;
        lineCount++;
        if (!lines.slice(i + 1, i + 3).join('\n').includes(CODE)) missing.push(`${path.relative(ROOT, file)}:${i + 1}`);
      });
    }
    console.log(`${lineCount} failure-button lines, ${codeCount} codes, missing: ${missing.join(', ') || 'none'}`);
    expect(missing).toEqual([]);
    expect(lineCount).toBeGreaterThanOrEqual(23);
    expect(codeCount).toBe(lineCount);
  });
});

describe('#354: the coverage test sees the hostErrorLog.record family', () => {
  function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...filesUnder(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('every literal hostErrorLog.record source is in LOGGED_ERROR_AREAS', () => {
    const sources = new Set<string>();
    for (const file of filesUnder(path.join(ROOT, 'src'))) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const m of text.matchAll(/hostErrorLog\.record\(\s*['`]([^'`$]+)['`]/g)) sources.add(m[1]);
    }
    const missing = [...sources].filter((s) => !Object.prototype.hasOwnProperty.call(LOGGED_ERROR_AREAS, s)).sort();
    console.log(`${sources.size} literal hostErrorLog.record sources, ${missing.length} not listed:`, missing.join(', '));
    expect(missing).toEqual([]);
  });
});
