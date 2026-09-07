/**
 * reportTrackingService — the "My Reports" cache.
 *
 * The extension never files an issue itself (the user presses Submit on
 * github.com), so the only route back to an issue number is to search
 * afterwards and match by title. That makes reconciliation the load-bearing
 * part: a wrong match attributes somebody else's issue to the user, and a
 * missed one loses their report forever.
 *
 * The GitHub call is injected, so nothing here touches the network. The handle
 * comes from a silent session only — `getHandle()` must never prompt.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  FEEDBACK_TRACKING_SETTING,
  ReportTrackingService,
  TRACKED_REPORTS_CONTEXT_KEY,
  TRACKED_REPORTS_KEY,
  isCacheStale,
  newlyShipped,
  parseTrackedReports,
  reconcileReports,
  trackedReportLabel,
  type TrackingFetch,
} from '../../src/services/reportTrackingService';
import { MyReportsTreeProvider, type MyReportNode } from '../../src/providers/MyReportsTreeProvider';
import {
  TRACKING_PENDING_TTL_MS,
  TRACKING_REFRESH_MS,
  type TrackedReport,
  type TrackedReportsCache,
} from '../../src/types/feedback';

const NOW = Date.parse('2026-09-07T00:00:00.000Z');

function report(overrides: Partial<TrackedReport> & { number: number }): TrackedReport {
  return {
    title: `Issue #${overrides.number}`,
    url: `https://github.com/liam-machine/erd-studio/issues/${overrides.number}`,
    kind: 'bug',
    state: 'open',
    comments: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function cache(overrides: Partial<TrackedReportsCache> = {}): TrackedReportsCache {
  return { handle: 'liam', fetchedAt: NOW - 1000, reports: [], pending: [], ...overrides };
}

type Context = import('vscode').ExtensionContext;

function makeContext(seed?: TrackedReportsCache): Context {
  return vscode.createMockExtensionContext({
    storageRoot: path.join(os.tmpdir(), 'erd-tracking'),
    extensionRoot: path.resolve(__dirname, '../..'),
    globalStateSeed: seed ? [[TRACKED_REPORTS_KEY, seed]] : [],
  }) as unknown as Context;
}

/** A search response carrying `items`, in GitHub's own shape. */
function searchFetch(items: unknown[], ok = true): TrackingFetch {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 403, json: async () => ({ items }) }));
}

const githubItem = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  title: '[Bug]: Edge vanished after rename',
  html_url: 'https://github.com/liam-machine/erd-studio/issues/42',
  state: 'open',
  comments: 1,
  created_at: '2026-09-05T00:00:00.000Z',
  updated_at: '2026-09-06T00:00:00.000Z',
  ...overrides,
});

describe('trackedReportLabel', () => {
  it('shows a comment count on an open issue, and omits it at zero', () => {
    expect(trackedReportLabel(report({ number: 1, comments: 3 }))).toEqual({
      icon: '●',
      label: 'Open · 3 comments',
    });
    expect(trackedReportLabel(report({ number: 1, comments: 0 }))).toEqual({
      icon: '●',
      label: 'Open',
    });
  });

  it('names the version a fix shipped in when it is known', () => {
    expect(
      trackedReportLabel(
        report({ number: 1, state: 'closed', stateReason: 'completed', shippedIn: '0.7.0' }),
      ),
    ).toEqual({ icon: '✔', label: 'Implemented · shipped in v0.7.0' });
  });

  it('says only "Implemented" when no version is known — never a guess', () => {
    expect(
      trackedReportLabel(report({ number: 1, state: 'closed', stateReason: 'completed' })),
    ).toEqual({ icon: '✔', label: 'Implemented' });
  });

  it('distinguishes "not planned" from implemented', () => {
    expect(
      trackedReportLabel(report({ number: 1, state: 'closed', stateReason: 'not_planned' })),
    ).toEqual({ icon: '⊘', label: 'Closed · not planned' });
  });

  it('treats a closed issue with no reason as implemented, matching duplicateModeFor', () => {
    expect(trackedReportLabel(report({ number: 1, state: 'closed' })).icon).toBe('✔');
  });
});

describe('reconcileReports', () => {
  it('matches a pending submission by normalised title and a later createdAt', () => {
    const before = cache({
      pending: [{ title: 'Edge vanished after rename', kind: 'bug', openedAt: NOW - 60_000 }],
    });
    const found = [
      report({
        number: 42,
        title: '[Bug]: Edge vanished after rename!',
        createdAt: new Date(NOW - 30_000).toISOString(),
      }),
    ];

    const next = reconcileReports(before, found, NOW);

    expect(next.pending).toEqual([]);
    expect(next.reports.map((r) => r.number)).toEqual([42]);
    expect(next.fetchedAt).toBe(NOW);
  });

  it('keeps a pending entry when the issue predates the submission', () => {
    const before = cache({
      pending: [{ title: 'Edge vanished after rename', kind: 'bug', openedAt: NOW - 60_000 }],
    });
    const found = [
      report({
        number: 42,
        title: 'Edge vanished after rename',
        createdAt: new Date(NOW - 120_000).toISOString(),
      }),
    ];

    expect(reconcileReports(before, found, NOW).pending).toHaveLength(1);
  });

  it('drops a pending entry once it is older than the TTL, matched or not', () => {
    const before = cache({
      pending: [
        { title: 'Old and unmatched', kind: 'bug', openedAt: NOW - TRACKING_PENDING_TTL_MS - 1 },
        { title: 'Still fresh', kind: 'feature', openedAt: NOW - 1000 },
      ],
    });

    expect(reconcileReports(before, [], NOW).pending.map((p) => p.title)).toEqual(['Still fresh']);
  });

  it('never duplicates a number already tracked, and takes the fresh copy', () => {
    const before = cache({ reports: [report({ number: 42, comments: 0, state: 'open' })] });
    const found = [report({ number: 42, comments: 4, state: 'closed', stateReason: 'completed' })];

    const next = reconcileReports(before, found, NOW);

    expect(next.reports).toHaveLength(1);
    expect(next.reports[0]).toMatchObject({ comments: 4, state: 'closed' });
  });

  it('carries notifiedShipped across so a shipped notification is never repeated', () => {
    const before = cache({
      reports: [report({ number: 42, state: 'closed', stateReason: 'completed', notifiedShipped: true })],
    });
    const found = [report({ number: 42, state: 'closed', stateReason: 'completed' })];

    expect(reconcileReports(before, found, NOW).reports[0].notifiedShipped).toBe(true);
  });

  it('keeps an issue the search did not mention — a quiet poll is not a deletion', () => {
    const before = cache({ reports: [report({ number: 7 })] });
    const next = reconcileReports(before, [report({ number: 42 })], NOW);
    expect(next.reports.map((r) => r.number)).toEqual([42, 7]);
  });
});

describe('newlyShipped', () => {
  it('fires for an issue that has just become implemented', () => {
    const previous = [report({ number: 42, state: 'open' })];
    const next = [report({ number: 42, state: 'closed', stateReason: 'completed' })];
    expect(newlyShipped(previous, next).map((r) => r.number)).toEqual([42]);
  });

  it('does not fire twice — once notified, it stays quiet', () => {
    const previous = [report({ number: 42, state: 'open' })];
    const next = [
      report({ number: 42, state: 'closed', stateReason: 'completed', notifiedShipped: true }),
    ];
    expect(newlyShipped(previous, next)).toEqual([]);
  });

  it('does not fire for an issue closed as not planned', () => {
    const previous = [report({ number: 42, state: 'open' })];
    const next = [report({ number: 42, state: 'closed', stateReason: 'not_planned' })];
    expect(newlyShipped(previous, next)).toEqual([]);
  });

  it('does not announce issues the very first poll discovers already closed', () => {
    const next = [report({ number: 42, state: 'closed', stateReason: 'completed' })];
    expect(newlyShipped([], next)).toEqual([]);
  });
});

describe('isCacheStale', () => {
  it('treats a missing cache as stale', () => {
    expect(isCacheStale(undefined, NOW)).toBe(true);
  });

  it('goes stale at exactly TRACKING_REFRESH_MS', () => {
    expect(isCacheStale(cache({ fetchedAt: NOW - TRACKING_REFRESH_MS + 1 }), NOW)).toBe(false);
    expect(isCacheStale(cache({ fetchedAt: NOW - TRACKING_REFRESH_MS }), NOW)).toBe(true);
  });
});

describe('parseTrackedReports', () => {
  it('reads the fields the tree row needs', () => {
    const [parsed] = parseTrackedReports({ items: [githubItem()] });
    expect(parsed).toEqual({
      number: 42,
      title: '[Bug]: Edge vanished after rename',
      url: 'https://github.com/liam-machine/erd-studio/issues/42',
      kind: 'bug',
      state: 'open',
      comments: 1,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    });
  });

  it('reads shippedIn from a milestone, normalising a leading v', () => {
    const [parsed] = parseTrackedReports({
      items: [githubItem({ state: 'closed', state_reason: 'completed', milestone: { title: 'v0.7.0' } })],
    });
    expect(parsed.shippedIn).toBe('0.7.0');
    expect(parsed.stateReason).toBe('completed');
  });

  it('falls back to a shipped-in: label when there is no milestone', () => {
    const [parsed] = parseTrackedReports({
      items: [githubItem({ labels: [{ name: 'shipped-in:0.6.49' }, { name: 'bug' }] })],
    });
    expect(parsed.shippedIn).toBe('0.6.49');
  });

  it('leaves shippedIn undefined when nothing says so', () => {
    expect(parseTrackedReports({ items: [githubItem()] })[0].shippedIn).toBeUndefined();
  });

  it('reads the kind from the enhancement label the feature template applies', () => {
    const [parsed] = parseTrackedReports({
      items: [githubItem({ title: '[Feature]: Search everywhere', labels: ['enhancement'] })],
    });
    expect(parsed.kind).toBe('feature');
  });

  it('skips pull requests and anything malformed rather than throwing', () => {
    const parsed = parseTrackedReports({
      items: [
        githubItem({ pull_request: { url: 'x' } }),
        githubItem({ number: 'not a number' }),
        { title: 'no number' },
        null,
        'nonsense',
        githubItem({ number: 7 }),
      ],
    });
    expect(parsed.map((r) => r.number)).toEqual([7]);
  });

  it('returns an empty list for a response with no items array', () => {
    expect(parseTrackedReports(null)).toEqual([]);
    expect(parseTrackedReports({})).toEqual([]);
    expect(parseTrackedReports({ items: 'nope' })).toEqual([]);
  });
});

describe('ReportTrackingService', () => {
  let executeCommand: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vscode._resetMockConfiguration();
    vscode._resetMockGithubSession();
    executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vscode._resetMockGithubSession();
    vi.restoreAllMocks();
  });

  const contextKeyCalls = () =>
    executeCommand.mock.calls.filter((c) => c[0] === 'setContext' && c[1] === TRACKED_REPORTS_CONTEXT_KEY);

  it('publishes the context key from the constructor, without waiting for a poll', () => {
    const service = new ReportTrackingService(makeContext(), searchFetch([]));
    expect(contextKeyCalls().at(-1)?.[2]).toBe(false);

    const seeded = new ReportTrackingService(
      makeContext(cache({ reports: [report({ number: 42 })] })),
      searchFetch([]),
    );
    expect(contextKeyCalls().at(-1)?.[2]).toBe(true);

    service.dispose();
    seeded.dispose();
  });

  it('never prompts for a sign-in: getHandle uses the silent session only', async () => {
    const getSession = vi.spyOn(vscode.authentication, 'getSession');
    const service = new ReportTrackingService(makeContext(), searchFetch([]));

    expect(await service.getHandle()).toBeNull();
    expect(getSession).toHaveBeenCalledWith('github', ['read:user'], { silent: true });
    service.dispose();
  });

  it('does nothing at all without a signed-in session', async () => {
    const fetch = searchFetch([githubItem()]);
    const service = new ReportTrackingService(makeContext(), fetch);

    await service.refresh({ force: true });

    expect(fetch).not.toHaveBeenCalled();
    expect(service.getReports()).toEqual([]);
    service.dispose();
  });

  it('does nothing when feedback.trackReports is off', async () => {
    vscode._setMockGithubSession({
      id: 's', accessToken: 't', account: { id: '1', label: 'liam' }, scopes: ['read:user'],
    });
    vscode._setMockConfiguration('erdStudio', FEEDBACK_TRACKING_SETTING, { globalValue: false });
    const fetch = searchFetch([githubItem()]);
    const service = new ReportTrackingService(makeContext(), fetch);

    await service.refresh({ force: true });

    expect(fetch).not.toHaveBeenCalled();
    service.dispose();
  });

  it('polls once, caches the result, fires the change event and flips the context key', async () => {
    vscode._setMockGithubSession({
      id: 's', accessToken: 't', account: { id: '1', label: 'liam' }, scopes: ['read:user'],
    });
    const fetch = searchFetch([githubItem()]);
    const context = makeContext();
    const service = new ReportTrackingService(context, fetch);
    let fired = 0;
    service.onDidChangeReports(() => { fired++; });

    await service.refresh({ force: true });

    expect(fetch).toHaveBeenCalledTimes(1);
    const url = String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toContain('https://api.github.com/search/issues?q=');
    expect(url).toContain('repo:liam-machine/erd-studio');
    expect(url).toContain('author:liam');
    expect(url).toContain('type:issue');
    expect(fired).toBe(1);
    expect(service.getReports().map((r) => r.number)).toEqual([42]);
    expect(contextKeyCalls().at(-1)?.[2]).toBe(true);
    service.dispose();
  });

  it('serves the cache without re-polling until it is stale', async () => {
    vscode._setMockGithubSession({
      id: 's', accessToken: 't', account: { id: '1', label: 'liam' }, scopes: ['read:user'],
    });
    const fetch = searchFetch([githubItem()]);
    const service = new ReportTrackingService(
      makeContext(cache({ fetchedAt: Date.now(), reports: [report({ number: 7 })] })),
      fetch,
    );

    await service.refresh();

    expect(fetch).not.toHaveBeenCalled();
    expect(service.getReports().map((r) => r.number)).toEqual([7]);
    service.dispose();
  });

  it('leaves the previous cache alone when the poll fails', async () => {
    vscode._setMockGithubSession({
      id: 's', accessToken: 't', account: { id: '1', label: 'liam' }, scopes: ['read:user'],
    });
    const service = new ReportTrackingService(
      makeContext(cache({ reports: [report({ number: 7 })] })),
      searchFetch([], false),
    );

    await service.refresh({ force: true });

    expect(service.getReports().map((r) => r.number)).toEqual([7]);
    service.dispose();
  });

  it('records a pending submission so a later poll can reconcile it', async () => {
    const context = makeContext();
    const service = new ReportTrackingService(context, searchFetch([]));

    await service.recordPending('Edge vanished after rename', 'bug');

    const stored = context.globalState.get<TrackedReportsCache>(TRACKED_REPORTS_KEY)!;
    expect(stored.pending).toHaveLength(1);
    expect(stored.pending[0]).toMatchObject({ title: 'Edge vanished after rename', kind: 'bug' });
    service.dispose();
  });

  it('announces a newly shipped report once, naming the version, with an Open issue action', async () => {
    vscode._setMockGithubSession({
      id: 's', accessToken: 't', account: { id: '1', label: 'liam' }, scopes: ['read:user'],
    });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const context = makeContext(cache({ reports: [report({ number: 42, state: 'open' })] }));
    const shipped = githubItem({
      state: 'closed',
      state_reason: 'completed',
      milestone: { title: 'v0.7.0' },
    });
    const service = new ReportTrackingService(context, searchFetch([shipped]));

    await service.refresh({ force: true });
    await service.refresh({ force: true });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      'ERD Studio: #42, which you reported, shipped in v0.7.0.',
      'Open issue',
    );
    service.dispose();
  });

  it('says only that it was implemented when no version is known', async () => {
    vscode._setMockGithubSession({
      id: 's', accessToken: 't', account: { id: '1', label: 'liam' }, scopes: ['read:user'],
    });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const service = new ReportTrackingService(
      makeContext(cache({ reports: [report({ number: 42, state: 'open' })] })),
      searchFetch([githubItem({ state: 'closed', state_reason: 'completed' })]),
    );

    await service.refresh({ force: true });

    expect(info).toHaveBeenCalledWith(
      'ERD Studio: #42, which you reported, has been implemented.',
      'Open issue',
    );
    service.dispose();
  });

  it('shares one request between concurrent refreshes', async () => {
    vscode._setMockGithubSession({
      id: 's', accessToken: 't', account: { id: '1', label: 'liam' }, scopes: ['read:user'],
    });
    const fetch = searchFetch([githubItem()]);
    const service = new ReportTrackingService(makeContext(), fetch);

    await Promise.all([service.refresh({ force: true }), service.refresh({ force: true })]);

    expect(fetch).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('throws away another account\'s cached issue numbers', async () => {
    vscode._setMockGithubSession({
      id: 's', accessToken: 't', account: { id: '1', label: 'someone-else' }, scopes: ['read:user'],
    });
    const service = new ReportTrackingService(
      makeContext(cache({ handle: 'liam', reports: [report({ number: 7 })] })),
      searchFetch([githubItem()]),
    );

    await service.refresh({ force: true });

    expect(service.getReports().map((r) => r.number)).toEqual([42]);
    service.dispose();
  });
});

describe('MyReportsTreeProvider', () => {
  /** A provider over a fixed list, without going near the tracking service's cache. */
  function providerOver(reports: TrackedReport[]) {
    const tracking = { getReports: () => reports } as unknown as ReportTrackingService;
    return new MyReportsTreeProvider(tracking);
  }

  it('renders one flat row per report, addressed by the row command', () => {
    const provider = providerOver([report({ number: 42, comments: 2 })]);
    const nodes = provider.getChildren() as MyReportNode[];
    expect(nodes).toHaveLength(1);

    const item = provider.getTreeItem(nodes[0]);
    expect(item.label).toBe('#42 Issue #42');
    expect(item.description).toBe('Open · 2 comments');
    expect(item.contextValue).toBe('trackedReport');
    expect(item.command).toEqual({
      command: 'erdStudio.openTrackedReport',
      title: 'Open on GitHub',
      arguments: [nodes[0]],
    });
    expect(String(item.tooltip?.value)).toContain(nodes[0].report.url);
    provider.dispose();
  });

  it('picks an icon per state', () => {
    const provider = providerOver([]);
    const iconOf = (r: TrackedReport) =>
      (provider.getTreeItem({ type: 'report', report: r }).iconPath as { id: string }).id;

    expect(iconOf(report({ number: 1 }))).toBe('issues');
    expect(iconOf(report({ number: 2, state: 'closed', stateReason: 'completed' }))).toBe('pass-filled');
    expect(iconOf(report({ number: 3, state: 'closed', stateReason: 'not_planned' }))).toBe('circle-slash');
    provider.dispose();
  });

  it('is a flat list: a row has no children, and an empty cache renders nothing', () => {
    const provider = providerOver([]);
    expect(provider.getChildren()).toEqual([]);
    expect(provider.getChildren({ type: 'report', report: report({ number: 1 }) })).toBeUndefined();
    provider.dispose();
  });

  it('fires its change event when refreshed', () => {
    const provider = providerOver([]);
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));
    provider.refresh();
    expect(fired).toEqual([undefined]);
    provider.dispose();
  });
});
