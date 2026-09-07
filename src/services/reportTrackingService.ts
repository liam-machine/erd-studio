/**
 * ReportTrackingService — keeps track of the GitHub issues the user filed from
 * ERD Studio and surfaces them in the "My Reports" view.
 *
 * The extension never files anything itself: the user presses Submit on
 * github.com in their own browser, so the only way back to the issue number is
 * to search afterwards. Submitting records a {@link PendingReport} timestamp;
 * a later poll searches `repo:<repo> author:<handle> type:issue` and reconciles
 * by title.
 *
 * The handle comes from a **silent** `vscode.authentication.getSession` — with
 * no session there is nothing to track, the `erdStudio.hasTrackedReports`
 * context key stays false, the view never appears, and the user is never
 * prompted to sign in. The poll itself is one unauthenticated request.
 *
 * This module lives under `src/services/`, so it is type-checked by the
 * mcp-server CI job too: it must not be reachable from `mcp-server/src/index.ts`.
 */

import * as vscode from 'vscode';

import type {
  FeedbackKind,
  PendingReport,
  TrackedReport,
  TrackedReportsCache,
} from '../types/feedback';
import { TRACKING_PENDING_TTL_MS, TRACKING_REFRESH_MS } from '../types/feedback';
import { getErdStudioSetting } from './configService';
import { GITHUB_REPO, hostErrorLog } from './feedbackService';

// ---------------------------------------------------------------------------
// Keys & constants
// ---------------------------------------------------------------------------

/** globalState key holding the TrackedReportsCache. */
export const TRACKED_REPORTS_KEY = 'erdStudio.feedback.trackedReports';

/** Setting: whether to poll GitHub for the user's filed issues. */
export const FEEDBACK_TRACKING_SETTING = 'feedback.trackReports';

/** Context key gating the "My Reports" view. Set by this service alone. */
export const TRACKED_REPORTS_CONTEXT_KEY = 'erdStudio.hasTrackedReports';

/** Label GitHub's feature-request template applies. */
const FEATURE_LABEL = 'enhancement';

/** Label pattern carrying the version a fix shipped in, when there is no milestone. */
const SHIPPED_IN_LABEL = /^shipped-in:(.+)$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Icon and description for one row in the My Reports tree.
 *
 * There are four states, not five: one unauthenticated `GET /search/issues`
 * cannot know whether a pull request is linked, so there is no "In progress".
 * A closed issue with no `state_reason` is treated as implemented, matching
 * `duplicateModeFor()`.
 */
export function trackedReportLabel(report: TrackedReport): { icon: string; label: string } {
  if (report.state === 'open') {
    return {
      icon: '●',
      label: report.comments > 0 ? `Open · ${report.comments} comments` : 'Open',
    };
  }

  if (report.stateReason === 'not_planned') {
    return { icon: '⊘', label: 'Closed · not planned' };
  }

  return {
    icon: '✔',
    label: report.shippedIn ? `Implemented · shipped in v${report.shippedIn}` : 'Implemented',
  };
}

/**
 * Normalise a title for pending-submission matching: lowercased, punctuation
 * stripped, whitespace collapsed. The GitHub form prefixes the user's title
 * with `[Bug]: ` / `[Feature]: `, so matching is "contains", not "equals".
 */
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `found` looks like the issue `pending` produced. */
function matchesPending(found: TrackedReport, pending: PendingReport): boolean {
  const wanted = normaliseTitle(pending.title);
  if (!wanted) return false;
  if (Date.parse(found.createdAt) <= pending.openedAt) return false;
  const actual = normaliseTitle(found.title);
  return actual === wanted || actual.includes(wanted);
}

/**
 * Merge a fresh search result into the cache.
 *
 * Reports are keyed by issue number: the freshly fetched copy wins on every
 * field except `notifiedShipped`, which is carried across so a "shipped"
 * notification is never shown twice. Numbers already tracked are never
 * duplicated, and entries the search did not return are kept (a poll that
 * fails to mention an issue is not evidence it is gone).
 *
 * Pending submissions are dropped once a matching issue turns up, and dropped
 * unconditionally after {@link TRACKING_PENDING_TTL_MS}.
 */
export function reconcileReports(
  cache: TrackedReportsCache,
  found: readonly TrackedReport[],
  now: number,
): TrackedReportsCache {
  const merged = new Map<number, TrackedReport>();

  for (const report of cache.reports) {
    merged.set(report.number, report);
  }

  for (const report of found) {
    const previous = merged.get(report.number);
    merged.set(report.number, {
      ...report,
      notifiedShipped: previous?.notifiedShipped ?? report.notifiedShipped,
    });
  }

  const pending = cache.pending.filter((entry) => {
    if (now - entry.openedAt > TRACKING_PENDING_TTL_MS) return false;
    return !found.some((report) => matchesPending(report, entry));
  });

  return {
    handle: cache.handle,
    fetchedAt: now,
    reports: [...merged.values()].sort((a, b) => b.number - a.number),
    pending,
  };
}

/**
 * Reports that just became implemented and have not been announced yet.
 *
 * A report only qualifies when the previous poll already knew about it in some
 * other state — otherwise the very first poll after signing in would announce
 * every issue the user ever closed.
 */
export function newlyShipped(
  previous: readonly TrackedReport[],
  next: readonly TrackedReport[],
): TrackedReport[] {
  const before = new Map(previous.map((report) => [report.number, report]));

  return next.filter((report) => {
    if (report.state !== 'closed' || report.stateReason === 'not_planned') return false;
    if (report.notifiedShipped) return false;

    const was = before.get(report.number);
    if (!was) return false;
    return was.state !== 'closed' || was.stateReason === 'not_planned';
  });
}

/** True when the cache is missing or older than {@link TRACKING_REFRESH_MS}. */
export function isCacheStale(cache: TrackedReportsCache | undefined, now: number): boolean {
  if (!cache) return true;
  return now - cache.fetchedAt >= TRACKING_REFRESH_MS;
}

/**
 * Version a fix shipped in, read from real data only: the issue's milestone
 * title, else a `shipped-in:<version>` label. A leading `v` is normalised away
 * so the row can render `shipped in v<version>` without doubling it. Never
 * guessed — an invented version tells a user to update for a bug that is still
 * open, which is the worst thing this feature could do.
 */
function shippedInFor(milestoneTitle: string | undefined, labels: readonly string[]): string | undefined {
  const fromLabel = labels
    .map((label) => SHIPPED_IN_LABEL.exec(label)?.[1])
    .find((value): value is string => typeof value === 'string');

  const raw = (milestoneTitle ?? fromLabel ?? '').trim();
  if (!raw) return undefined;
  return raw.replace(/^v/i, '');
}

/** Which kind an issue was filed as, from the template's label. */
function kindFor(title: string, labels: readonly string[]): FeedbackKind {
  if (labels.includes(FEATURE_LABEL)) return 'feature';
  return /^\s*\[feature\]/i.test(title) ? 'feature' : 'bug';
}

/**
 * Convert one `GET /search/issues` response body into tracked reports.
 *
 * Anything that is not a well-formed issue object is skipped rather than
 * throwing — a shape change on GitHub's side must not break the sidebar.
 * Pull requests are dropped even though `type:issue` should have excluded them.
 */
export function parseTrackedReports(payload: unknown): TrackedReport[] {
  const items = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];

  const reports: TrackedReport[] = [];

  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;

    if (item.pull_request) continue;
    if (typeof item.number !== 'number' || !Number.isInteger(item.number)) continue;
    if (typeof item.title !== 'string' || typeof item.html_url !== 'string') continue;

    const state = item.state === 'closed' ? 'closed' : 'open';
    const stateReason =
      item.state_reason === 'completed' || item.state_reason === 'not_planned'
        ? item.state_reason
        : undefined;

    const labels = Array.isArray(item.labels)
      ? item.labels
          .map((label) =>
            typeof label === 'string' ? label : (label as { name?: unknown } | null)?.name,
          )
          .filter((name): name is string => typeof name === 'string')
      : [];

    const milestone = (item.milestone as { title?: unknown } | null)?.title;
    const shippedIn = shippedInFor(typeof milestone === 'string' ? milestone : undefined, labels);

    reports.push({
      number: item.number,
      title: item.title,
      url: item.html_url,
      kind: kindFor(item.title, labels),
      state,
      ...(stateReason ? { stateReason } : {}),
      comments: typeof item.comments === 'number' ? item.comments : 0,
      ...(shippedIn ? { shippedIn } : {}),
      createdAt: typeof item.created_at === 'string' ? item.created_at : '',
      updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
    });
  }

  return reports;
}

// ---------------------------------------------------------------------------
// Injectable fetch
// ---------------------------------------------------------------------------

/** The part of a `fetch` Response this service reads. */
export interface TrackingFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/**
 * Injectable `fetch`. Declared structurally rather than reusing the DOM/undici
 * types so tests can pass a plain function and no global stub is needed.
 */
export type TrackingFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<TrackingFetchResponse>;

const defaultTrackingFetch: TrackingFetch = (url, init) => {
  const runtime = globalThis as unknown as { fetch?: TrackingFetch };
  if (!runtime.fetch) {
    return Promise.reject(new Error('fetch is not available in this runtime.'));
  }
  return runtime.fetch(url, init);
};

// ---------------------------------------------------------------------------
// VS Code-facing service
// ---------------------------------------------------------------------------

/** Notification shown once when an issue the user filed turns up implemented. */
function shippedNotification(report: TrackedReport): string {
  return report.shippedIn
    ? `ERD Studio: #${report.number}, which you reported, shipped in v${report.shippedIn}.`
    : `ERD Studio: #${report.number}, which you reported, has been implemented.`;
}

export class ReportTrackingService {
  private readonly _onDidChangeReports = new vscode.EventEmitter<void>();

  /** Fires after any change to the cached reports. */
  readonly onDidChangeReports = this._onDidChangeReports.event;

  /** In-flight refresh, so concurrent callers share one request. */
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fetchJson: TrackingFetch = defaultTrackingFetch,
  ) {
    // Publish the key straight away so a reload restores the view without
    // waiting for the network. Activation never has to reference this service.
    this.updateContextKey();
  }

  /**
   * The signed-in GitHub handle, from a **silent** session only. Returns null
   * when there is no session — this must never prompt anyone to sign in.
   */
  async getHandle(): Promise<string | null> {
    try {
      const session = await vscode.authentication.getSession('github', ['read:user'], {
        silent: true,
      });
      return session?.account?.label ?? null;
    } catch (err) {
      hostErrorLog.record('ReportTrackingService.getHandle', err);
      return null;
    }
  }

  /** Cached reports, newest issue first. Empty before the first successful poll. */
  getReports(): TrackedReport[] {
    return [...this.readCache().reports].sort((a, b) => b.number - a.number);
  }

  /**
   * Record a submission the user just opened in the browser, so a later poll
   * can reconcile it. Recorded even when there is no session yet: signing in
   * afterwards should still pick the report up.
   */
  async recordPending(title: string, kind: FeedbackKind): Promise<void> {
    const cache = this.readCache();
    await this.writeCache({
      ...cache,
      pending: [...cache.pending, { title, kind, openedAt: Date.now() }],
    });
  }

  /**
   * Poll GitHub, reconcile against the cache, persist, fire the change event
   * and announce anything that has since been implemented.
   *
   * No-ops when `feedback.trackReports` is off, when there is no silent
   * session, or when the cache is still fresh and `force` was not passed.
   * Never throws: a failed poll leaves the previous cache in place.
   */
  async refresh(options?: { force?: boolean }): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runRefresh(options?.force === true).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  dispose(): void {
    this._onDidChangeReports.dispose();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async runRefresh(force: boolean): Promise<void> {
    if (!getErdStudioSetting<boolean>(FEEDBACK_TRACKING_SETTING, true)) {
      this.setContextKey(false);
      return;
    }

    const handle = await this.getHandle();
    if (!handle) {
      this.setContextKey(false);
      return;
    }

    // A different account means the cached numbers are somebody else's.
    let cache = this.readCache();
    if (cache.handle && cache.handle !== handle) {
      cache = { handle, fetchedAt: 0, reports: [], pending: cache.pending };
    } else if (!cache.handle) {
      cache = { ...cache, handle };
    }

    const now = Date.now();
    if (!force && !isCacheStale(cache, now)) {
      this.updateContextKey();
      return;
    }

    let found: TrackedReport[];
    try {
      found = await this.search(handle);
    } catch (err) {
      hostErrorLog.record('ReportTrackingService.refresh', err);
      return;
    }

    const next = reconcileReports(cache, found, now);
    const shipped = newlyShipped(cache.reports, next.reports);
    const announced = new Set(shipped.map((report) => report.number));

    if (announced.size > 0) {
      next.reports = next.reports.map((report) =>
        announced.has(report.number) ? { ...report, notifiedShipped: true } : report,
      );
    }

    await this.writeCache(next);
    this._onDidChangeReports.fire();

    for (const report of shipped) {
      void this.announceShipped(report);
    }
  }

  /** One unauthenticated search request. Throws on a non-OK response. */
  private async search(handle: string): Promise<TrackedReport[]> {
    const query = `repo:${GITHUB_REPO}+author:${encodeURIComponent(handle)}+type:issue`;
    const url = `https://api.github.com/search/issues?q=${query}&per_page=100&sort=updated&order=desc`;

    const response = await this.fetchJson(url, {
      headers: { Accept: 'application/vnd.github+json' },
    });

    if (!response.ok) {
      throw new Error(`GitHub search failed with status ${response.status}.`);
    }

    return parseTrackedReports(await response.json());
  }

  private async announceShipped(report: TrackedReport): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      shippedNotification(report),
      'Open issue',
    );
    if (choice === 'Open issue') {
      void vscode.env.openExternal(vscode.Uri.parse(report.url));
    }
  }

  private readCache(): TrackedReportsCache {
    const stored = this.context.globalState.get<TrackedReportsCache>(TRACKED_REPORTS_KEY);
    return {
      handle: typeof stored?.handle === 'string' ? stored.handle : '',
      fetchedAt: typeof stored?.fetchedAt === 'number' ? stored.fetchedAt : 0,
      reports: Array.isArray(stored?.reports) ? stored.reports : [],
      pending: Array.isArray(stored?.pending) ? stored.pending : [],
    };
  }

  private async writeCache(cache: TrackedReportsCache): Promise<void> {
    await this.context.globalState.update(TRACKED_REPORTS_KEY, cache);
    this.updateContextKey();
  }

  /** Drive the view's `when` clause from the service itself (see A12). */
  private updateContextKey(): void {
    this.setContextKey(this.readCache().reports.length > 0);
  }

  private setContextKey(value: boolean): void {
    void vscode.commands.executeCommand('setContext', TRACKED_REPORTS_CONTEXT_KEY, value);
  }
}
