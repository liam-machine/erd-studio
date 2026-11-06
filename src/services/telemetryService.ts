/**
 * Usage telemetry: one anonymous heartbeat per UTC day.
 *
 * Counters for "today" accumulate in globalState through the reducers in
 * `telemetryPayload.ts`. When the day rolls over — checked on activation and
 * hourly — the finished day is sent once and the counters start again. The
 * send goes through `vscode.env.createTelemetryLogger`, so it honours
 * `telemetry.telemetryLevel` and shows in Output → Telemetry; on top of that,
 * nothing is recorded or sent while `vscode.env.isTelemetryEnabled` is false or
 * `erdStudio.telemetry.enabled` is off. Every failure is dropped silently: no
 * retry, no toast, no log line.
 *
 * During an install's first week, and on any day a new error code is counted,
 * an interim copy of today's summary may also go out the same day (at most
 * {@link MAX_PROVISIONAL_SENDS}, marked `heartbeatProvisional`, through the
 * same logger); the final one the next day replaces it in the Worker.
 *
 * Call sites use the {@link telemetry} facade, one short line each. It is a
 * no-op until {@link TelemetryService} is constructed, so code that runs
 * without one (tests, the no-project fallback) needs no guard.
 */

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

import { getErdStudioSetting } from './configService';
import { safeBaseUrl } from './feedbackAnalysisService';
import {
  buildHeartbeat,
  emptyCounters,
  FIRST_DRAFT_FEATURES,
  heartbeatHash,
  isMajorUpdate,
  provisionalBody,
  provisionalDue,
  provisionalTrigger,
  trimHeartbeat,
  ttfFeature,
  type HeartbeatEnv,
  type ProvisionalReason,
  hostBucket,
  rememberDay,
  remoteBucket,
  stampEnv,
  recordAssistants,
  recordHarnesses,
  recordPhysicalTooling,
  heartbeatDue,
  nextDay,
  recordActivation,
  recordCanvasOpen,
  recordCatalog,
  recordError,
  recordFeature,
  recordFeatureOnce,
  recordManifest,
  recordStage,
  recordTrail,
  retractTrail,
  trailKept,
  nextTrailWindow,
  TRAIL_AWAY_MIN_MS,
  trailError,
  utcDay,
  type ActivationOutcome,
  type CounterEnv,
  type DailyCounters,
  type HeartbeatBody,
  type ManifestState,
  type TelemetryErrorCode,
  type TelemetryFeature,
  type TelemetrySchemaFormat,
  type TelemetryStage,
  type TelemetryAssistant,
  type TelemetryHarness,
  type TelemetryPhysicalTool,
  type TelemetryPlatform,
  type TrailEvent,
  type TrailMarker,
  TRAIL_DAYS,
  daysBetween,
  MAX_PROVISIONAL_SENDS,
} from './telemetryPayload';
import { invariantErrorCodes, surveyFeatures } from './relationshipHealth';
import type { RelationshipInvariant, RelationshipSurvey } from './relationshipHealth';

/** Where heartbeats go. Served by the Worker in `telemetry/`. */
export const TELEMETRY_ENDPOINT = 'https://erd-studio-telemetry.w2solutions.ai/v1/heartbeat';

export const TELEMETRY_ENABLED_SETTING = 'telemetry.enabled';

const COUNTERS_KEY = 'erdStudio.telemetry.counters';
const INSTALL_KEY = 'erdStudio.telemetry.install';
const FIRST_SEEN_KEY = 'erdStudio.telemetry.firstSeenDay';
/** Recent UTC days with an activation / a canvas open. Dates stay on the device; only counts are sent. */
const ACTIVE_DAYS_KEY = 'erdStudio.telemetry.activeDays';
const CANVAS_DAYS_KEY = 'erdStudio.telemetry.canvasDays';
const FIRST_CANVAS_KEY = 'erdStudio.telemetry.firstCanvasDay';
/** B2: today's interim copies — `{ day, sent, hash }`. Never sent. */
const PROVISIONAL_KEY = 'erdStudio.telemetry.provisional';
/**
 * B5: an update happened (`{ major }`), written before the update reload can
 * return from `activate()` and read on the next start. No version text.
 */
export const PENDING_UPDATE_KEY = 'erdStudio.telemetry.pendingUpdate';
/** B5: this install's first counted start was an update, so it is not a new user's first week. Never sent. */
const UPGRADED_INSTALL_KEY = 'erdStudio.telemetry.upgradedInstall';
/** B15: epoch ms of the first run, and whether the first draft / diagram has been timed. Never sent. */
const FIRST_RUN_AT_KEY = 'erdStudio.telemetry.firstRunAt';
const FIRST_DRAFT_DONE_KEY = 'erdStudio.telemetry.firstDraftDone';
const FIRST_DIAGRAM_DONE_KEY = 'erdStudio.telemetry.firstDiagramDone';

const HEARTBEAT_EVENT = 'heartbeat';
const ROLLOVER_INTERVAL_MS = 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 5_000;
/** B2: an interim copy waits this long after the event that asked for it (debounced). */
export const PROVISIONAL_DEBOUNCE_MS = 30_000;
/** B2: on a first-week day, an interim copy is considered this long after start. */
export const PROVISIONAL_SETTLE_MS = 2 * 60_000;
/** Bodies waiting for the logger's sender; more than this and the oldest is dropped. */
const MAX_OUTGOING = 4;

interface StoredProvisional {
  day: string;
  sent: number;
  hash: string;
}

interface StoredInstall {
  id: string;
  /** UTC day the id was minted. Informational: the id is never replaced. */
  createdDay: string;
}

let endpointOverride: string | null = null;

/**
 * Overrides {@link TELEMETRY_ENDPOINT}. **Tests only** — nothing in the
 * extension calls this. Pass `null` to go back to the constant.
 */
export function setTelemetryEndpointForTests(endpoint: string | null): void {
  endpointOverride = endpoint;
}

/** The heartbeat URL, or `''` when it is not somewhere a request may be sent. */
function telemetryEndpoint(): string {
  return safeBaseUrl(endpointOverride ?? TELEMETRY_ENDPOINT);
}

export class TelemetryService implements vscode.Disposable {
  private readonly logger: vscode.TelemetryLogger;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  /**
   * The body the sender posts. VS Code's logger clones and scrubs the data it
   * is handed and prefixes the event name, so the sender posts the body
   * {@link buildHeartbeat} produced rather than whatever arrives through it.
   */
  private outgoing: HeartbeatBody[] = [];
  /** The running environment, stamped onto the day's counters on every update. */
  private readonly env: CounterEnv;
  /** This window's number in today's onboarding trail, once it has added to it. */
  private trailWindow: { day: string; n: number } | undefined;
  /** When each away marker was added (`window`, or a canvas by key), for a quick return to take it back. */
  private readonly awaySince = new Map<string, number>();
  /** The UTC day this window activated, for the trail's `dayContinued` (B15). */
  private readonly activationDay = utcDay(new Date());
  /** B2: the pending debounced interim copy, and why (an error outranks onboarding). */
  private provisionalTimer: ReturnType<typeof setTimeout> | undefined;
  private provisionalReason: ProvisionalReason | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.env = {
      extVersion: String(context.extension?.packageJSON?.version ?? ''),
      vscodeVersion: vscode.version,
      host: hostBucket(vscode.env.appName ?? ''),
      remote: remoteBucket(vscode.env.remoteName, vscode.env.uiKind === vscode.UIKind.Web),
      // B5: Liam's own installs set ERD_STUDIO_INTERNAL=1, read once here; there is no setting for it.
      dev: (context.extensionMode !== undefined && context.extensionMode !== vscode.ExtensionMode.Production)
        || process.env.ERD_STUDIO_INTERNAL === '1',
    };
    this.logger = vscode.env.createTelemetryLogger(
      {
        sendEventData: (eventName) => {
          if (!eventName.endsWith(HEARTBEAT_EVENT)) return;
          const body = this.outgoing.shift();
          if (body) void postHeartbeat(body);
        },
        // Never send stack traces or error details.
        sendErrorData: () => {},
      },
      { ignoreBuiltInCommonProperties: true },
    );
    this.disposables.push(
      this.logger,
      // Turning telemetry off discards what was counted, so nothing gathered
      // before the switch is sent if it is switched back on later.
      vscode.env.onDidChangeTelemetryEnabled((enabled) => {
        if (!enabled) this.discard();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`erdStudio.${TELEMETRY_ENABLED_SETTING}`) && !this.enabled()) this.discard();
      }),
    );
    // The trail's window markers: away while another app or VS Code window has the focus.
    if (typeof vscode.window.onDidChangeWindowState === 'function') {
      this.disposables.push(vscode.window.onDidChangeWindowState((e) => this.away('window', !e.focused, 'windowAway', 'windowBack')));
    }
    this.timer = setInterval(() => this.rollover(), ROLLOVER_INTERVAL_MS);
    this.timer.unref?.();
    active = this;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.cancelProvisional();
    for (const d of this.disposables) d.dispose();
    if (active === this) active = undefined;
  }

  /** Both VS Code's switch and ours must allow it. Ours can only turn it off. */
  enabled(): boolean {
    return vscode.env.isTelemetryEnabled && getErdStudioSetting<boolean>(TELEMETRY_ENABLED_SETTING, true) !== false;
  }

  /**
   * Send the finished day, if the day has changed since the counters were
   * started. Called on activation and hourly.
   */
  rollover(): void {
    const today = utcDay(new Date());
    const state = this.context.globalState.get<DailyCounters>(COUNTERS_KEY);
    if (state?.day === today) return;
    void this.context.globalState.update(COUNTERS_KEY, state ? nextDay(state, today) : emptyCounters(today));
    if (state && this.enabled() && heartbeatDue(state, today)) this.send(state, today);
  }

  update(reducer: (state: DailyCounters) => DailyCounters): void {
    if (!this.enabled()) return;
    this.rollover();
    const state = this.context.globalState.get<DailyCounters>(COUNTERS_KEY) ?? emptyCounters(utcDay(new Date()));
    // Stamped before the reducer counts anything, so stampEnv sees what an
    // earlier version had counted today (versionMixed, B5).
    const next = reducer(stampEnv(state, this.env));
    // Nothing changed (a trail marker on a day without a trail): no write.
    if (next === state) return;
    void this.context.globalState.update(COUNTERS_KEY, next);
    const trigger = provisionalTrigger(state, next);
    if (trigger) this.scheduleProvisional(trigger, PROVISIONAL_DEBOUNCE_MS);
  }

  /**
   * Run `reducer`, then add `event` to the onboarding trail when it is kept
   * today ({@link trailKept}); with `onlyIfChanged`, only when the reducer
   * changed something (a once-a-day flag already set is not a new event).
   */
  record(reducer: (state: DailyCounters) => DailyCounters, event?: TrailEvent, onlyIfChanged = false): void {
    this.update((s) => {
      const next = reducer(s);
      if (event === undefined || (onlyIfChanged && next === s)) return next;
      return this.withTrail(next, event, Date.now());
    });
  }

  /** `state` with `event` on its trail at `now`, if the trail is kept today. */
  withTrail(state: DailyCounters, event: TrailEvent, now: number): DailyCounters {
    if (!trailKept(state, this.firstSeenDay(state.day), event)) return state;
    if (this.trailWindow?.day !== state.day) this.trailWindow = { day: state.day, n: nextTrailWindow(state) };
    // B15: today's trail begins in a window that was activated on an earlier UTC day.
    const begun = Array.isArray(state.trail) && state.trail.length > 0;
    const first = !begun && this.activationDay < state.day ? recordTrail(state, 'dayContinued', now, this.trailWindow.n) : state;
    return recordTrail(first, event, now, this.trailWindow.n);
  }

  /**
   * An away / back change for `key` (the window, or one canvas): the away
   * marker now, and on return either the back marker or, within
   * {@link TRAIL_AWAY_MIN_MS} and with nothing recorded since, neither.
   */
  away(key: string, isAway: boolean, awayEvent: TrailMarker, backEvent: TrailMarker): void {
    const now = Date.now();
    if (isAway) {
      if (this.awaySince.has(key)) return;
      this.awaySince.set(key, now);
      this.record((s) => s, awayEvent);
      return;
    }
    const since = this.awaySince.get(key);
    if (since === undefined) return;
    this.awaySince.delete(key);
    if (now - since < TRAIL_AWAY_MIN_MS) {
      const n = this.trailWindow?.n;
      if (n !== undefined) this.update((s) => retractTrail(s, awayEvent, n));
      return;
    }
    this.record((s) => s, backEvent);
  }

  /** A canvas closed: no back marker will follow its away one. */
  forgetAway(key: string): void {
    this.awaySince.delete(key);
  }

  /** Remember that today had an activation (`active`) or a canvas open (`canvas`). */
  markDay(kind: 'active' | 'canvas'): void {
    if (!this.enabled()) return;
    const today = utcDay(new Date());
    const key = kind === 'active' ? ACTIVE_DAYS_KEY : CANVAS_DAYS_KEY;
    void this.context.globalState.update(key, rememberDay(this.context.globalState.get<string[]>(key), today));
    if (kind === 'canvas' && !this.context.globalState.get<string>(FIRST_CANVAS_KEY)) {
      void this.context.globalState.update(FIRST_CANVAS_KEY, today);
    }
  }

  private send(state: DailyCounters, today: string): void {
    if (!telemetryEndpoint()) return;
    this.post(buildHeartbeat(state, this.heartbeatEnv(state, today)));
  }

  /**
   * Hand `body` to the logger, trimmed under the size guard (B3). The sender
   * takes bodies in the order they were queued, so an interim copy never
   * replaces a final one that is waiting. A body is queued only while the
   * logger would pass it on (telemetry level at usage), so nothing waits to be
   * posted on its own later.
   */
  private post(body: HeartbeatBody): void {
    if (!this.logger.isUsageEnabled) return;
    const sent = trimHeartbeat(body);
    this.outgoing.push(sent);
    if (this.outgoing.length > MAX_OUTGOING) this.outgoing.shift();
    this.logger.logUsage(HEARTBEAT_EVENT, { ...sent });
  }

  private heartbeatEnv(state: DailyCounters, today: string): HeartbeatEnv {
    return {
      installId: this.installId(today),
      extVersion: this.env.extVersion,
      vscodeVersion: this.env.vscodeVersion,
      platform: process.platform,
      firstSeenDay: this.firstSeenDay(state.day),
      activeDays: this.context.globalState.get<string[]>(ACTIVE_DAYS_KEY),
      canvasDays: this.context.globalState.get<string[]>(CANVAS_DAYS_KEY),
      firstCanvasDay: this.context.globalState.get<string>(FIRST_CANVAS_KEY) ?? null,
      host: this.env.host,
      remote: this.env.remote,
      dev: this.env.dev,
    };
  }

  /**
   * B2: ask for an interim copy `delay` ms from now. A later ask replaces the
   * earlier (debounced); an error outranks onboarding. The timer is unref'd.
   */
  private scheduleProvisional(reason: ProvisionalReason, delay: number): void {
    if (this.provisionalTimer) clearTimeout(this.provisionalTimer);
    this.provisionalReason = this.provisionalReason === 'error' ? 'error' : reason;
    this.provisionalTimer = setTimeout(() => {
      const why = this.provisionalReason ?? reason;
      this.provisionalTimer = undefined;
      this.provisionalReason = undefined;
      this.sendProvisional(why);
    }, delay);
    this.provisionalTimer.unref?.();
  }

  private cancelProvisional(): void {
    if (this.provisionalTimer) clearTimeout(this.provisionalTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.provisionalTimer = undefined;
    this.provisionalReason = undefined;
    this.settleTimer = undefined;
  }

  /**
   * B2: send an interim copy of today's counters now, if {@link provisionalDue}
   * allows it. Same body as the final, plus `heartbeatProvisional` (in the
   * body only, never the stored counters), through the same logger. Never throws.
   */
  sendProvisional(reason: ProvisionalReason): void {
    try {
      if (!this.enabled() || !telemetryEndpoint() || !this.logger.isUsageEnabled) return;
      // No rollover here: a finished day is the hourly timer's to send. A
      // stale day is simply not today's (provisionalDue).
      const today = utcDay(new Date());
      const state = this.context.globalState.get<DailyCounters>(COUNTERS_KEY);
      if (!state) return;
      const body = buildHeartbeat(state, this.heartbeatEnv(state, today));
      const hash = heartbeatHash(body);
      const stored = this.context.globalState.get<StoredProvisional>(PROVISIONAL_KEY);
      const sameDay = stored?.day === today;
      const sentToday = sameDay && typeof stored?.sent === 'number' ? stored.sent : 0;
      const due = provisionalDue(state, today, {
        trailDay: this.onboardingDay(state.day),
        sentToday,
        lastHash: sameDay ? stored?.hash : undefined,
        hash,
        reason,
      });
      if (!due) return;
      void this.context.globalState.update(PROVISIONAL_KEY, { day: today, sent: Math.min(sentToday + 1, MAX_PROVISIONAL_SENDS), hash } satisfies StoredProvisional);
      this.post(provisionalBody(body));
    } catch {
      // Telemetry never breaks the caller.
    }
  }

  /**
   * B2/B5: whether `day` may send onboarding interim copies: within the
   * install's first {@link TRAIL_DAYS} days, and not an install whose first
   * counted start was an update (an existing user, not a new one).
   */
  private onboardingDay(day: string): boolean {
    if (this.context.globalState.get<boolean>(UPGRADED_INSTALL_KEY)) return false;
    const age = daysBetween(this.firstSeenDay(day), day);
    return Number.isFinite(age) && age >= 0 && age < TRAIL_DAYS;
  }

  /**
   * A random id, never `vscode.env.machineId`, minted once per VS Code profile
   * and kept for good (it used to be replaced every 30 days). Switching
   * telemetry off does not clear it; nothing is sent while it is off.
   */
  private installId(today: string): string {
    const stored = this.context.globalState.get<StoredInstall>(INSTALL_KEY);
    if (stored?.id) return stored.id;
    const fresh: StoredInstall = { id: randomUUID(), createdDay: today };
    void this.context.globalState.update(INSTALL_KEY, fresh);
    return fresh.id;
  }

  private firstSeenDay(fallback: string): string {
    const stored = this.context.globalState.get<string>(FIRST_SEEN_KEY);
    if (stored) return stored;
    void this.context.globalState.update(FIRST_SEEN_KEY, fallback);
    return fallback;
  }

  /** Called on activation, before anything is counted. */
  start(): void {
    const pending = this.context.globalState.get<{ major?: boolean }>(PENDING_UPDATE_KEY);
    if (!this.context.globalState.get<string>(FIRST_SEEN_KEY)) {
      void this.context.globalState.update(FIRST_SEEN_KEY, utcDay(new Date()));
      // B5: first counted on an update (a user from before telemetry, or one
      // who had it off): an existing user, never an onboarding week.
      if (pending) void this.context.globalState.update(UPGRADED_INSTALL_KEY, true);
    }
    this.rollover();
    if (pending) {
      void this.context.globalState.update(PENDING_UPDATE_KEY, undefined);
      // Counted, not put on the trail: it would come before this window's windowOpened.
      this.update((s) => (pending.major === true ? recordFeatureOnce(recordFeatureOnce(s, 'extUpdated'), 'extUpdatedMajor') : recordFeatureOnce(s, 'extUpdated')));
    }
    // B2 trigger (c): a first-week day gets one look a couple of minutes in.
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.enabled() && this.onboardingDay(utcDay(new Date()))) {
      this.settleTimer = setTimeout(() => {
        this.settleTimer = undefined;
        this.sendProvisional('settle');
      }, PROVISIONAL_SETTLE_MS);
      this.settleTimer.unref?.();
    }
  }

  /** B15: the first run, timed from now. Kept on the device; only buckets are sent. */
  noteFirstRun(): void {
    if (!this.enabled() || this.context.globalState.get<number>(FIRST_RUN_AT_KEY) !== undefined) return;
    void this.context.globalState.update(FIRST_RUN_AT_KEY, Date.now());
  }

  /**
   * B15: the first real draft or first diagram with tables since the first
   * run, bucketed once per install. Installs with no recorded first run (from
   * before 2.0) are never timed.
   */
  firstOf(kind: 'draft' | 'diagram'): void {
    if (!this.enabled()) return;
    const doneKey = kind === 'draft' ? FIRST_DRAFT_DONE_KEY : FIRST_DIAGRAM_DONE_KEY;
    const firstRunAt = this.context.globalState.get<number>(FIRST_RUN_AT_KEY);
    if (typeof firstRunAt !== 'number' || this.context.globalState.get<boolean>(doneKey)) return;
    void this.context.globalState.update(doneKey, true);
    const feature = ttfFeature(kind, firstRunAt, Date.now());
    this.record((s) => recordFeatureOnce(s, feature), feature, true);
  }

  private discard(): void {
    this.cancelProvisional();
    void this.context.globalState.update(COUNTERS_KEY, emptyCounters(utcDay(new Date())));
    void this.context.globalState.update(ACTIVE_DAYS_KEY, undefined);
    void this.context.globalState.update(CANVAS_DAYS_KEY, undefined);
    void this.context.globalState.update(FIRST_CANVAS_KEY, undefined);
    void this.context.globalState.update(PROVISIONAL_KEY, undefined);
    void this.context.globalState.update(PENDING_UPDATE_KEY, undefined);
    void this.context.globalState.update(FIRST_RUN_AT_KEY, undefined);
    void this.context.globalState.update(FIRST_DRAFT_DONE_KEY, undefined);
    void this.context.globalState.update(FIRST_DIAGRAM_DONE_KEY, undefined);
  }
}

/** POST the body; every failure — offline, timeout, 4xx, 5xx — is dropped. */
async function postHeartbeat(body: HeartbeatBody): Promise<void> {
  const url = telemetryEndpoint();
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Dropped on purpose: telemetry never retries and never complains.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * B5: called in `activate()` before the update reload can return early, with
 * the version last activated and the one running now. Remembers that an
 * update happened (and whether the major version changed), never the
 * versions, for the next {@link TelemetryService.start} to count. Nothing is
 * kept while telemetry is off. Never throws.
 */
export async function notePendingUpdate(context: vscode.ExtensionContext, previous: string | undefined, current: string): Promise<void> {
  try {
    if (!previous || previous === current) return;
    if (!vscode.env.isTelemetryEnabled || getErdStudioSetting<boolean>(TELEMETRY_ENABLED_SETTING, true) === false) return;
    await context.globalState.update(PENDING_UPDATE_KEY, { major: isMajorUpdate(previous, current) });
  } catch {
    // Telemetry never blocks activation.
  }
}

let active: TelemetryService | undefined;

let errorCodeListener: ((code: TelemetryErrorCode) => void) | undefined;

/**
 * Called with every error code the facade records, **whether or not telemetry
 * is on** — the known-fixes check (`knownFixesService.ts`) sends nothing about
 * the user, so it has its own switch. One listener; `undefined` removes it.
 */
export function setErrorCodeListener(listener: ((code: TelemetryErrorCode) => void) | undefined): void {
  errorCodeListener = listener;
}

function errorRecorded(code: TelemetryErrorCode): void {
  try {
    errorCodeListener?.(code);
  } catch {
    // A listener must never break the call site that recorded the error.
  }
}

/**
 * One-line call sites. Each takes only fixed keys, booleans and counts, so a
 * name, path or message cannot be passed. Safe before a service exists.
 */
export const telemetry = {
  activation(outcome: ActivationOutcome, hasSemanticDir: boolean, domainCount: number): void {
    active?.record(s => recordActivation(s, { outcome, hasSemanticDir, domainCount }), 'windowOpened');
    active?.markDay('active');
  },
  canvasOpened(stage: TelemetryStage, format: TelemetrySchemaFormat, modelCount: number): void {
    active?.record(s => recordCanvasOpen(s, { stage, format, modelCount }), 'canvasOpened');
    active?.markDay('canvas');
    if (modelCount > 0) active?.firstOf('diagram');
  },
  /** AI assistants detected on this machine (`detectAssistants()` ids). */
  assistants(found: readonly TelemetryAssistant[]): void {
    active?.update(s => recordAssistants(s, found));
  },
  /** ERD Studio harness targets installed, version-marked, in the open project. */
  harnesses(found: readonly TelemetryHarness[]): void {
    active?.update(s => recordHarnesses(s, found));
  },
  /** How the open workspace builds its physical tables (`detectPhysicalTooling()` flags). */
  physicalTooling(found: { tools: readonly TelemetryPhysicalTool[]; platforms: readonly TelemetryPlatform[] }): void {
    active?.update(s => recordPhysicalTooling(s, found));
  },
  /** Whether anything would be recorded now, so a caller can skip work whose only use is telemetry. */
  enabled(): boolean {
    return active?.enabled() === true;
  },
  stage(stage: TelemetryStage): void {
    active?.update(s => recordStage(s, stage));
  },
  manifest(state: Exclude<ManifestState, 'unknown'>): void {
    active?.update(s => recordManifest(s, state));
  },
  catalog(present: boolean): void {
    active?.update(s => recordCatalog(s, present));
  },
  feature(feature: TelemetryFeature): void {
    active?.record(s => recordFeature(s, feature), feature);
    if (FIRST_DRAFT_FEATURES.includes(feature)) active?.firstOf('draft');
  },
  /** Count `feature` at most once per day (a presence flag). */
  featureOnce(feature: TelemetryFeature): void {
    active?.record(s => recordFeatureOnce(s, feature), feature, true);
    if (feature === 'firstRun') active?.noteFirstRun();
  },
  /**
   * Count `feature` without adding it to the onboarding trail (`once`: at most
   * once per day): for flags that describe what was shown or found rather
   * than something the user did, so they never use up the first day's trail.
   */
  featureQuiet(feature: TelemetryFeature, once = false): void {
    active?.update(s => (once ? recordFeatureOnce(s, feature) : recordFeature(s, feature)));
  },
  error(code: TelemetryErrorCode): void {
    errorRecorded(code);
    active?.record(s => recordError(s, code), trailError(code));
  },
  /** Canvas open: each relationship state found (`surveyLibrary`), at most once a day — counts only, never which links. */
  relationshipState(survey: RelationshipSurvey): void {
    const found = surveyFeatures(survey);
    const service = active;
    if (found.length > 0 && service) {
      service.update(s => found.reduce((acc, f) => {
        const next = recordFeatureOnce(acc, f);
        return next === acc ? acc : service.withTrail(next, f, Date.now());
      }, s));
    }
  },
  /** A relationship write or Move that succeeded: each new behaviour it used (`relationshipWriteUsage`, `moveUsage`). */
  relationshipUsage(used: readonly TelemetryFeature[]): void {
    const service = active;
    if (used.length > 0 && service) service.update(s => used.reduce((acc, f) => service.withTrail(recordFeature(acc, f), f, Date.now()), s));
  },
  /** After a relationship write: one error per invariant it broke (`checkRelationshipWrite`). */
  relationshipInvariants(broken: readonly RelationshipInvariant[]): void {
    const codes = invariantErrorCodes(broken);
    codes.forEach(errorRecorded);
    const service = active;
    if (codes.length > 0 && service) service.update(s => codes.reduce((acc, c) => service.withTrail(recordError(acc, c), trailError(c), Date.now()), s));
  },
  /**
   * A trail-only event ({@link TrailMarker}): it counts nothing, and is kept
   * only on a day the onboarding trail is.
   */
  marker(marker: TrailMarker): void {
    active?.record(s => s, marker);
  },
  /** A canvas went behind another tab (`visible` false) or came back. */
  canvasVisible(key: string, visible: boolean): void {
    active?.away(`canvas:${key}`, !visible, 'canvasHidden', 'canvasShown');
  },
  /** A canvas closed. */
  canvasClosed(key: string): void {
    active?.forgetAway(`canvas:${key}`);
    active?.record(s => s, 'canvasClosed');
  },
};
