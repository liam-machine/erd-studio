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
  hostBucket,
  rememberDay,
  remoteBucket,
  stampEnv,
  recordAssistants,
  recordHarnesses,
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
} from './telemetryPayload';

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

const HEARTBEAT_EVENT = 'heartbeat';
const ROLLOVER_INTERVAL_MS = 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 5_000;

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
  private outgoing: HeartbeatBody | null = null;
  /** The running environment, stamped onto the day's counters on every update. */
  private readonly env: CounterEnv;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.env = {
      extVersion: String(context.extension?.packageJSON?.version ?? ''),
      vscodeVersion: vscode.version,
      host: hostBucket(vscode.env.appName ?? ''),
      remote: remoteBucket(vscode.env.remoteName, vscode.env.uiKind === vscode.UIKind.Web),
      dev: context.extensionMode !== undefined && context.extensionMode !== vscode.ExtensionMode.Production,
    };
    this.logger = vscode.env.createTelemetryLogger(
      {
        sendEventData: (eventName) => {
          if (!eventName.endsWith(HEARTBEAT_EVENT)) return;
          const body = this.outgoing;
          this.outgoing = null;
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
    this.timer = setInterval(() => this.rollover(), ROLLOVER_INTERVAL_MS);
    this.timer.unref?.();
    active = this;
  }

  dispose(): void {
    clearInterval(this.timer);
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
    void this.context.globalState.update(COUNTERS_KEY, stampEnv(reducer(state), this.env));
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
    this.outgoing = buildHeartbeat(state, {
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
    });
    // The sender takes `outgoing` and clears it. If the logger declines
    // (telemetry level below usage) it stays until the next day's send
    // replaces it, and is never posted on its own.
    this.logger.logUsage(HEARTBEAT_EVENT, { ...this.outgoing });
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
    if (!this.context.globalState.get<string>(FIRST_SEEN_KEY)) {
      void this.context.globalState.update(FIRST_SEEN_KEY, utcDay(new Date()));
    }
    this.rollover();
  }

  private discard(): void {
    void this.context.globalState.update(COUNTERS_KEY, emptyCounters(utcDay(new Date())));
    void this.context.globalState.update(ACTIVE_DAYS_KEY, undefined);
    void this.context.globalState.update(CANVAS_DAYS_KEY, undefined);
    void this.context.globalState.update(FIRST_CANVAS_KEY, undefined);
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

let active: TelemetryService | undefined;

/**
 * One-line call sites. Each takes only fixed keys, booleans and counts, so a
 * name, path or message cannot be passed. Safe before a service exists.
 */
export const telemetry = {
  activation(outcome: ActivationOutcome, hasSemanticDir: boolean, domainCount: number): void {
    active?.update(s => recordActivation(s, { outcome, hasSemanticDir, domainCount }));
    active?.markDay('active');
  },
  canvasOpened(stage: TelemetryStage, format: TelemetrySchemaFormat, modelCount: number): void {
    active?.update(s => recordCanvasOpen(s, { stage, format, modelCount }));
    active?.markDay('canvas');
  },
  /** AI assistants detected on this machine (`detectAssistants()` ids). */
  assistants(found: readonly TelemetryAssistant[]): void {
    active?.update(s => recordAssistants(s, found));
  },
  /** ERD Studio harness targets installed, version-marked, in the open project. */
  harnesses(found: readonly TelemetryHarness[]): void {
    active?.update(s => recordHarnesses(s, found));
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
    active?.update(s => recordFeature(s, feature));
  },
  /** Count `feature` at most once per day (a presence flag). */
  featureOnce(feature: TelemetryFeature): void {
    active?.update(s => recordFeatureOnce(s, feature));
  },
  error(code: TelemetryErrorCode): void {
    active?.update(s => recordError(s, code));
  },
};
