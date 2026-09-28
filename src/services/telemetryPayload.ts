/**
 * Pure half of the usage telemetry: the daily counters, the reducers that
 * update them, and the one function that turns a finished day into the
 * heartbeat body the telemetry Worker accepts.
 *
 * Keep this module free of `vscode` and of Node built-ins. Everything the
 * heartbeat can say is decided here, by type: a feature or error is one of the
 * fixed keys below or it cannot be recorded at all, and every size is a bucket
 * rather than a number. There is no field that could carry a name, a path or a
 * message, so there is nothing to scrub. `TelemetryService` owns storage,
 * timing and the network.
 *
 * The shape is a contract with `telemetry/` (the Worker) — change both
 * together, and bump `HEARTBEAT_VERSION` when a field changes meaning.
 */

export const HEARTBEAT_VERSION = 1;

/** Features whose use is counted. The Worker drops any key not in this list. */
export const FEATURES = [
  'physicalStage',
  'compare',
  'syncPlan',
  'launchClaude',
  'dbtCompile',
  'annotation',
  'autoLayout',
  'addModel',
  'addRelationship',
  'harnessInstallClaude',
  'harnessInstallCopilot',
  'harnessInstallGemini',
  'harnessInstallCodex',
  'migrateV5',
  'feedbackOpened',
] as const;
export type TelemetryFeature = (typeof FEATURES)[number];

/** Failure classes that are counted. Anything else is `other`. */
export const ERROR_CODES = [
  'manifestMissing',
  'manifestMalformed',
  'manifestTimeout',
  'catalogUnreadable',
  'domainLoad',
  'modelFileParse',
  'layersInvalid',
  'editRejected',
  'migrationFailed',
  'other',
] as const;
export type TelemetryErrorCode = (typeof ERROR_CODES)[number];

export type ActivationOutcome = 'project_found' | 'no_project';
export type TenureBucket = '0' | '1-7' | '8-30' | '31-90' | '90+';
export type DomainCountBucket = '0' | '1-3' | '4-10' | '10+';
/** `none` means no canvas with a model in it was opened that day. */
export type ModelCountBucket = 'none' | '1-10' | '11-50' | '51+';
export type ManifestState = 'ok' | 'missing' | 'stale' | 'unknown';
export type TelemetryStage = 'logical' | 'physical';
export type TelemetrySchemaFormat = 'v5' | 'v4';
export type TelemetryOs = 'darwin' | 'win32' | 'linux' | 'other';

export const MAX_ACTIVATIONS = 50;
export const MAX_CANVAS_OPENS = 200;
export const MAX_COUNTER = 100;

/** The Worker refuses a day older than this, so a heartbeat for one is not sent. */
export const MAX_HEARTBEAT_AGE_DAYS = 7;

/** How long one random install id lives before it is replaced. */
export const INSTALL_ID_TTL_DAYS = 30;

/** Everything counted for one UTC day, as kept in globalState. */
export interface DailyCounters {
  /** The UTC day (`YYYY-MM-DD`) these counts describe. */
  day: string;
  /** Most recent activation outcome; `null` until this window has activated. */
  activation: ActivationOutcome | null;
  hasSemanticDir: boolean;
  domainCount: DomainCountBucket;
  activations: number;
  canvasOpens: number;
  stages: TelemetryStage[];
  schemaFormats: TelemetrySchemaFormat[];
  modelCount: ModelCountBucket;
  manifest: ManifestState;
  catalog: boolean;
  features: Partial<Record<TelemetryFeature, number>>;
  errors: Partial<Record<TelemetryErrorCode, number>>;
}

/** What the extension host knows about itself, supplied at send time. */
export interface HeartbeatEnv {
  installId: string;
  extVersion: string;
  /** `vscode.version`, e.g. `1.104.2`. Reduced to `major.minor`. */
  vscodeVersion: string;
  /** `process.platform`. */
  platform: string;
  /** The UTC day of first activation (`YYYY-MM-DD`). */
  firstSeenDay: string;
}

/** The exact request body POSTed to `/v1/heartbeat`. */
export interface HeartbeatBody {
  v: typeof HEARTBEAT_VERSION;
  installId: string;
  day: string;
  extVersion: string;
  vscodeMajor: string;
  os: TelemetryOs;
  tenure: TenureBucket;
  activation: ActivationOutcome;
  hasSemanticDir: boolean;
  domainCount: DomainCountBucket;
  activations: number;
  canvasOpens: number;
  stages: TelemetryStage[];
  schemaFormats: TelemetrySchemaFormat[];
  modelCount: ModelCountBucket;
  manifest: ManifestState;
  catalog: boolean;
  features: Partial<Record<TelemetryFeature, number>>;
  errors: Partial<Record<TelemetryErrorCode, number>>;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** The UTC day of `date` as `YYYY-MM-DD`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export function tenureBucket(days: number): TenureBucket {
  if (days <= 0) return '0';
  if (days <= 7) return '1-7';
  if (days <= 30) return '8-30';
  if (days <= 90) return '31-90';
  return '90+';
}

export function domainCountBucket(count: number): DomainCountBucket {
  if (count <= 0) return '0';
  if (count <= 3) return '1-3';
  if (count <= 10) return '4-10';
  return '10+';
}

export function modelCountBucket(count: number): ModelCountBucket {
  if (count <= 0) return 'none';
  if (count <= 10) return '1-10';
  if (count <= 50) return '11-50';
  return '51+';
}

const MODEL_COUNT_ORDER: readonly ModelCountBucket[] = ['none', '1-10', '11-50', '51+'];

export function osBucket(platform: string): TelemetryOs {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : 'other';
}

/** `1.104.2` → `1.104`; anything unrecognisable → `0.0`. */
export function vscodeMajor(version: string): string {
  return /^(\d+\.\d+)/.exec(version)?.[1] ?? '0.0';
}

/** `1.4.0` and `1.4.0-beta.1` → `1.4.0`; anything unrecognisable → `0.0.0`. */
export function extVersion(version: string): string {
  return /^(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? '0.0.0';
}

// ---------------------------------------------------------------------------
// Reducers — each returns a new DailyCounters and never mutates its input.
// ---------------------------------------------------------------------------

export function emptyCounters(day: string): DailyCounters {
  return {
    day,
    activation: null,
    hasSemanticDir: false,
    domainCount: '0',
    activations: 0,
    canvasOpens: 0,
    stages: [],
    schemaFormats: [],
    modelCount: 'none',
    manifest: 'unknown',
    catalog: false,
    features: {},
    errors: {},
  };
}

/**
 * The counters for `day` that follow `prev`. The project facts from the last
 * activation (outcome, `.erd-studio/` present, domain count) describe a window
 * that is still open, so they carry over; every count starts again.
 */
export function nextDay(prev: DailyCounters, day: string): DailyCounters {
  return {
    ...emptyCounters(day),
    activation: prev.activation,
    hasSemanticDir: prev.hasSemanticDir,
    domainCount: prev.domainCount,
  };
}

export function recordActivation(
  state: DailyCounters,
  info: { outcome: ActivationOutcome; hasSemanticDir: boolean; domainCount: number },
): DailyCounters {
  return {
    ...state,
    activation: info.outcome,
    hasSemanticDir: info.hasSemanticDir,
    domainCount: domainCountBucket(info.domainCount),
    activations: Math.min(state.activations + 1, MAX_ACTIVATIONS),
  };
}

export function recordCanvasOpen(
  state: DailyCounters,
  info: { stage: TelemetryStage; format: TelemetrySchemaFormat; modelCount: number },
): DailyCounters {
  const seen = modelCountBucket(info.modelCount);
  const largest = MODEL_COUNT_ORDER.indexOf(seen) > MODEL_COUNT_ORDER.indexOf(state.modelCount) ? seen : state.modelCount;
  return {
    ...state,
    canvasOpens: Math.min(state.canvasOpens + 1, MAX_CANVAS_OPENS),
    stages: addOnce(state.stages, info.stage),
    schemaFormats: addOnce(state.schemaFormats, info.format),
    modelCount: largest,
  };
}

export function recordStage(state: DailyCounters, stage: TelemetryStage): DailyCounters {
  return { ...state, stages: addOnce(state.stages, stage) };
}

export function recordManifest(state: DailyCounters, manifest: Exclude<ManifestState, 'unknown'>): DailyCounters {
  return { ...state, manifest };
}

export function recordCatalog(state: DailyCounters, present: boolean): DailyCounters {
  return { ...state, catalog: state.catalog || present };
}

export function recordFeature(state: DailyCounters, feature: TelemetryFeature): DailyCounters {
  return { ...state, features: bump(state.features, feature) };
}

export function recordError(state: DailyCounters, code: TelemetryErrorCode): DailyCounters {
  return { ...state, errors: bump(state.errors, code) };
}

function addOnce<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list : [...list, value];
}

function bump<K extends string>(counts: Partial<Record<K, number>>, key: K): Partial<Record<K, number>> {
  return { ...counts, [key]: Math.min((counts[key] ?? 0) + 1, MAX_COUNTER) };
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Whether the finished day `state` should be sent on `today`. A day with no
 * activation, no canvas and nothing counted (a window left open overnight) is
 * not news, and a day older than the Worker accepts would only be refused.
 */
export function heartbeatDue(state: DailyCounters, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.day)) return false;
  const age = daysBetween(state.day, today);
  if (!(age >= 1 && age <= MAX_HEARTBEAT_AGE_DAYS)) return false;
  if (state.activation === null) return false;
  return (
    state.activations > 0 ||
    state.canvasOpens > 0 ||
    Object.keys(state.features).length > 0 ||
    Object.keys(state.errors).length > 0
  );
}

/**
 * The heartbeat body for a finished day. Rebuilt field by field from the
 * allowlists rather than spread from `state`, so a stray key in stored state —
 * from an older build, say — can never reach the wire.
 */
export function buildHeartbeat(state: DailyCounters, env: HeartbeatEnv): HeartbeatBody {
  return {
    v: HEARTBEAT_VERSION,
    installId: env.installId,
    day: state.day,
    extVersion: extVersion(env.extVersion),
    vscodeMajor: vscodeMajor(env.vscodeVersion),
    os: osBucket(env.platform),
    tenure: tenureBucket(daysBetween(env.firstSeenDay, state.day)),
    activation: pick(state.activation, ['project_found', 'no_project'], 'no_project'),
    hasSemanticDir: state.hasSemanticDir === true,
    domainCount: pick(state.domainCount, ['0', '1-3', '4-10', '10+'], '0'),
    activations: clampCount(state.activations, MAX_ACTIVATIONS),
    canvasOpens: clampCount(state.canvasOpens, MAX_CANVAS_OPENS),
    stages: (['logical', 'physical'] as const).filter(s => state.stages?.includes(s)),
    schemaFormats: (['v5', 'v4'] as const).filter(f => state.schemaFormats?.includes(f)),
    modelCount: pick(state.modelCount, MODEL_COUNT_ORDER, 'none'),
    manifest: pick(state.manifest, ['ok', 'missing', 'stale', 'unknown'], 'unknown'),
    catalog: state.catalog === true,
    features: allowedCounts(state.features, FEATURES),
    errors: allowedCounts(state.errors, ERROR_CODES),
  };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampCount(value: unknown, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(Math.floor(value), max)) : 0;
}

function allowedCounts<K extends string>(
  counts: Partial<Record<K, number>> | undefined,
  keys: readonly K[],
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const n = clampCount(counts?.[key], MAX_COUNTER);
    if (n > 0) out[key] = n;
  }
  return out;
}
