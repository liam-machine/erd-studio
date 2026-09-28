/**
 * ERD Studio — usage telemetry collector (Cloudflare Worker).
 *
 * The endpoint the extension's daily heartbeat is posted to. Each install sends
 * at most one small JSON document per UTC day describing the *previous* day in
 * counts and buckets — how many canvases were opened, which features were
 * used, which error codes fired — and this Worker validates it and upserts one
 * row into D1. That is the whole job.
 *
 * It is not part of the extension build. Nothing in `esbuild.js`, the
 * tsconfigs or the npm scripts may come to depend on this directory, and
 * `telemetry/**` is listed in `.vscodeignore` so it never ships in the VSIX.
 * Deploy it by hand — see `README.md` in this directory.
 *
 * ## What it will and will not store
 *
 * The body is rebuilt from an allowlist, field by field, before anything is
 * written. A row is the validated body fields plus `received_day` (the UTC
 * date this Worker saw it, which is what retention keys on). Nothing else:
 *
 *   - **No IP address, no user-agent, no `cf` geo object, no header of any
 *     kind.** `request.headers` is read for exactly one thing — the declared
 *     `Content-Length`, as a size pre-check — and `request.cf` is never read.
 *     The tests bind a canary IP, user-agent and country and assert none of
 *     them reaches the SQL parameters.
 *   - **No free text.** Every stored value is an enum, a bucket, a bounded
 *     integer, a date, a version string matched by a strict regex, or the
 *     install id — a random UUID the extension rotates every 30 days.
 *   - **Unknown keys are dropped**, top-level and inside `features` / `errors`,
 *     so a newer extension that sends a field this Worker has never heard of
 *     still lands, minus that field — and an arbitrary client cannot use an
 *     unrecognised key to smuggle anything into storage.
 *
 * Raw rows are deleted 90 days after they were received by the `scheduled()`
 * handler below (a daily Cron Trigger). Only per-day aggregates with no install
 * ids are ever kept longer, and those live on the operator's machine, not here.
 *
 * ## The rules it enforces, and why
 *
 *   - **Route** — `POST /v1/heartbeat` and nothing else: another path is 404,
 *     another method on the right path is 405.
 *   - **Kill switch** — `KILL_SWITCH` truthy makes every request 503 before
 *     anything else, with no D1 access. `wrangler.toml` is its source of truth.
 *   - **Body cap** — a real heartbeat is a few hundred bytes. More than
 *     {@link MAX_BODY_BYTES} is refused (413) while it is still streaming, so
 *     the declared `Content-Length` is a free early exit, never the only check.
 *   - **Strict known fields** — a known field with a wrong type or an
 *     out-of-range value is a 400 and writes nothing. The day must be a real
 *     calendar date, not in the future and at most 7 days old, so a client with
 *     a broken clock cannot write rows retention would keep past 90 days.
 *   - **Fail closed** — a D1 error is a 503. The extension drops a failed
 *     heartbeat silently and never retries, so nothing downstream cares which
 *     non-2xx it gets.
 *
 * No payload is ever logged — {@link log} takes fixed labels and numbers only.
 * CORS is deliberately absent: the caller is the VS Code extension host, not a
 * browser, so no preflight is answered and no origin is blessed.
 */

/** The one path this Worker serves. */
const ROUTE = '/v1/heartbeat';

/** Largest body accepted. A real heartbeat is a few hundred bytes. */
const MAX_BODY_BYTES = 2048;

/** A heartbeat may describe a day at most this many days before it is received. */
const MAX_DAY_AGE_DAYS = 7;

/** Raw rows older than this (by `received_day`) are deleted by the cron. */
const RETENTION_DAYS = 90;

/** The telemetry contract version this Worker understands. */
const CONTRACT_VERSION = 1;

/** Random UUID v4 — the only identifier stored, rotated client-side every 30 days. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const MAJOR_MINOR = /^\d+\.\d+$/;

/**
 * Upper bound on the version-string fields, so a `9999…` of 1,000 digits that
 * still matches the regex cannot become a stored value.
 */
const MAX_VERSION_CHARS = 24;

const OS_VALUES = new Set(['darwin', 'win32', 'linux', 'other']);
const TENURE_VALUES = new Set(['0', '1-7', '8-30', '31-90', '90+']);
const ACTIVATION_VALUES = new Set(['project_found', 'no_project']);
const DOMAIN_COUNT_VALUES = new Set(['0', '1-3', '4-10', '10+']);
const MODEL_COUNT_VALUES = new Set(['none', '1-10', '11-50', '51+']);
const MANIFEST_VALUES = new Set(['ok', 'missing', 'stale', 'unknown']);

/** Array fields keep this order when stored, whatever order the client sent. */
const STAGES = ['logical', 'physical'];
const SCHEMA_FORMATS = ['v5', 'v4'];

/** The only keys `features` may carry; anything else is dropped. */
const FEATURES = [
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
];

/** The only keys `errors` may carry; anything else is dropped. */
const ERROR_CODES = [
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
];

/**
 * Last write wins for a given install and day. The extension sends once per
 * day, so a conflict means a retry after a lost response or a second window
 * racing the first — either way the newer counts are at least as complete.
 */
const UPSERT_SQL = `INSERT INTO heartbeats (
  install_id, day, received_day, ext_version, vscode_major, os, tenure, activation,
  has_semantic_dir, domain_count, activations, canvas_opens, stages, schema_formats,
  model_count, manifest, catalog, features, errors
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
ON CONFLICT(install_id, day) DO UPDATE SET
  received_day = excluded.received_day,
  ext_version = excluded.ext_version,
  vscode_major = excluded.vscode_major,
  os = excluded.os,
  tenure = excluded.tenure,
  activation = excluded.activation,
  has_semantic_dir = excluded.has_semantic_dir,
  domain_count = excluded.domain_count,
  activations = excluded.activations,
  canvas_opens = excluded.canvas_opens,
  stages = excluded.stages,
  schema_formats = excluded.schema_formats,
  model_count = excluded.model_count,
  manifest = excluded.manifest,
  catalog = excluded.catalog,
  features = excluded.features,
  errors = excluded.errors`;

const RETENTION_SQL = `DELETE FROM heartbeats WHERE received_day < date('now', '-${RETENTION_DAYS} days')`;

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    // Before the path, the method or D1, so "off" is free and total.
    if (isKilled(env)) {
      return refuse(503, 'kill_switch');
    }

    try {
      if (new URL(request.url).pathname !== ROUTE) {
        return refuse(404, 'path');
      }
      if (request.method !== 'POST') {
        return refuse(405, 'method', { Allow: 'POST' });
      }
      return await handleHeartbeat(request, env);
    } catch (err) {
      // Only the error's *name* — a message can quote the input.
      log({ event: 'error', status: 503, kind: errorName(err) });
      return new Response(null, { status: 503, headers: baseHeaders() });
    }
  },

  /**
   * Daily retention sweep (Cron Trigger in wrangler.toml).
   *
   * Keyed on `received_day`, which this Worker sets, rather than on the
   * client-supplied `day`: the promise is "no raw row lives on Cloudflare longer
   * than 90 days", and only a date we wrote ourselves can keep it.
   *
   * @param {unknown} _controller
   * @param {Env} env
   * @param {{ waitUntil(promise: Promise<unknown>): void }} ctx
   * @returns {Promise<void>}
   */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const result = await env.DB.prepare(RETENTION_SQL).run();
        log({ event: 'retention', deleted: result?.meta?.changes ?? 0 });
      })(),
    );
  },
};

/**
 * Read, validate, upsert.
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function handleHeartbeat(request, env) {
  const body = await readLimited(request.body, MAX_BODY_BYTES, request.headers.get('content-length'));
  if (!body.ok) {
    return refuse(413, 'body_size');
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return refuse(400, 'json');
  }

  const now = Date.now();
  const heartbeat = validateHeartbeat(parsed, now);
  if (!heartbeat) {
    return refuse(400, 'shape');
  }

  await env.DB.prepare(UPSERT_SQL)
    .bind(
      heartbeat.installId,
      heartbeat.day,
      utcDay(now),
      heartbeat.extVersion,
      heartbeat.vscodeMajor,
      heartbeat.os,
      heartbeat.tenure,
      heartbeat.activation,
      heartbeat.hasSemanticDir ? 1 : 0,
      heartbeat.domainCount,
      heartbeat.activations,
      heartbeat.canvasOpens,
      JSON.stringify(heartbeat.stages),
      JSON.stringify(heartbeat.schemaFormats),
      heartbeat.modelCount,
      heartbeat.manifest,
      heartbeat.catalog ? 1 : 0,
      JSON.stringify(heartbeat.features),
      JSON.stringify(heartbeat.errors),
    )
    .run();

  log({ event: 'ok', status: 204 });
  return new Response(null, { status: 204, headers: baseHeaders() });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The heartbeat to store, or `null` when any known field is missing or
 * invalid. Unknown keys are ignored — the result is built only from the fields
 * named here, so nothing the client adds can reach the row.
 *
 * `features` and `errors` may be omitted (an idle day has neither); every other
 * field is required.
 *
 * @param {unknown} raw
 * @param {number} now epoch ms, for the day-window check
 * @returns {Heartbeat | null}
 */
function validateHeartbeat(raw, now) {
  if (!isPlainObject(raw)) return null;
  const b = /** @type {Record<string, unknown>} */ (raw);

  if (b.v !== CONTRACT_VERSION) return null;
  if (typeof b.installId !== 'string' || !UUID_V4.test(b.installId)) return null;
  if (!isAcceptableDay(b.day, now)) return null;
  if (!isVersion(b.extVersion, SEMVER)) return null;
  if (!isVersion(b.vscodeMajor, MAJOR_MINOR)) return null;
  if (!isOneOf(b.os, OS_VALUES)) return null;
  if (!isOneOf(b.tenure, TENURE_VALUES)) return null;
  if (!isOneOf(b.activation, ACTIVATION_VALUES)) return null;
  if (typeof b.hasSemanticDir !== 'boolean') return null;
  if (!isOneOf(b.domainCount, DOMAIN_COUNT_VALUES)) return null;
  if (!isIntIn(b.activations, 0, 50)) return null;
  if (!isIntIn(b.canvasOpens, 0, 200)) return null;
  if (!isOneOf(b.modelCount, MODEL_COUNT_VALUES)) return null;
  if (!isOneOf(b.manifest, MANIFEST_VALUES)) return null;
  if (typeof b.catalog !== 'boolean') return null;

  const stages = subsetOf(b.stages, STAGES);
  const schemaFormats = subsetOf(b.schemaFormats, SCHEMA_FORMATS);
  if (!stages || !schemaFormats) return null;

  const features = countsOf(b.features, FEATURES);
  const errors = countsOf(b.errors, ERROR_CODES);
  if (!features || !errors) return null;

  return {
    // Lower-cased so one install cannot appear as two rows by changing case.
    installId: b.installId.toLowerCase(),
    day: /** @type {string} */ (b.day),
    extVersion: /** @type {string} */ (b.extVersion),
    vscodeMajor: /** @type {string} */ (b.vscodeMajor),
    os: /** @type {string} */ (b.os),
    tenure: /** @type {string} */ (b.tenure),
    activation: /** @type {string} */ (b.activation),
    hasSemanticDir: b.hasSemanticDir,
    domainCount: /** @type {string} */ (b.domainCount),
    activations: /** @type {number} */ (b.activations),
    canvasOpens: /** @type {number} */ (b.canvasOpens),
    stages,
    schemaFormats,
    modelCount: /** @type {string} */ (b.modelCount),
    manifest: /** @type {string} */ (b.manifest),
    catalog: b.catalog,
    features,
    errors,
  };
}

/**
 * A real `YYYY-MM-DD` calendar date between {@link MAX_DAY_AGE_DAYS} days ago
 * and today, UTC. Today is allowed (not only yesterday) so a client whose
 * clock is a few minutes ahead of ours is not refused at midnight.
 *
 * @param {unknown} value
 * @param {number} now
 * @returns {boolean}
 */
function isAcceptableDay(value, now) {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  // Date.parse accepts 2026-02-31 and rolls it over, so round-trip to reject it.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return false;
  const today = utcDay(now);
  const oldest = utcDay(now - MAX_DAY_AGE_DAYS * 86_400_000);
  // ISO dates compare correctly as strings.
  return value <= today && value >= oldest;
}

/**
 * @param {unknown} value
 * @param {RegExp} pattern
 * @returns {value is string}
 */
function isVersion(value, pattern) {
  return typeof value === 'string' && value.length <= MAX_VERSION_CHARS && pattern.test(value);
}

/**
 * @param {unknown} value
 * @param {Set<string>} allowed
 * @returns {value is string}
 */
function isOneOf(value, allowed) {
  return typeof value === 'string' && allowed.has(value);
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {value is number}
 */
function isIntIn(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * The elements of `value` in `allowed` order, or `null` when it is not an
 * array or holds anything outside `allowed`. Duplicates collapse — they say
 * nothing the single value does not.
 *
 * @param {unknown} value
 * @param {string[]} allowed
 * @returns {string[] | null}
 */
function subsetOf(value, allowed) {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.includes(item)) return null;
  }
  return allowed.filter((item) => value.includes(item));
}

/**
 * A `{ key: count }` object reduced to the `allowed` keys, in `allowed` order,
 * with zero counts dropped. `undefined` is an empty object. Unknown keys are
 * dropped silently (a newer extension may know more features than we do); a
 * known key with a non-integer or out-of-range count is `null`.
 *
 * @param {unknown} value
 * @param {string[]} allowed
 * @returns {Record<string, number> | null}
 */
function countsOf(value, allowed) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return null;
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, number>} */
  const out = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const count = source[key];
    if (!isIntIn(count, 0, 100)) return null;
    if (count > 0) out[key] = count;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Request reading
// ---------------------------------------------------------------------------

/**
 * Reads at most `limit` bytes from `stream`, refusing rather than truncating.
 *
 * `Content-Length` is checked first so an oversized declared body costs
 * nothing, but the stream is counted too: the header is a claim, not a fact,
 * and a chunked body has none at all.
 *
 * @param {ReadableStream<Uint8Array> | null} stream
 * @param {number} limit
 * @param {string | null} [declaredLength]
 * @returns {Promise<{ ok: true, text: string } | { ok: false }>}
 */
async function readLimited(stream, limit, declaredLength) {
  if (declaredLength !== null && declaredLength !== undefined) {
    const declared = Number(declaredLength);
    if (!Number.isFinite(declared) || declared < 0 || declared > limit) return { ok: false };
  }
  if (!stream) return { ok: true, text: '' };

  const reader = stream.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(buffer) };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * `[vars]` are JSON values, so `KILL_SWITCH = true` arrives as a boolean.
 * Booleans and numbers are honoured both ways; any other non-string value is
 * unrecognised and refuses rather than serving on a switch that was set. Same
 * rule as the feedback proxy's.
 *
 * @param {Env} env
 * @returns {boolean}
 */
function isKilled(env) {
  const raw = env.KILL_SWITCH;
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw !== 'string') return true;
  const value = raw.trim().toLowerCase();
  return !(value === '' || value === '0' || value === 'false' || value === 'off' || value === 'no');
}

/**
 * @param {number} now epoch ms
 * @returns {string} `YYYY-MM-DD`, UTC
 */
function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Responses and logging
// ---------------------------------------------------------------------------

/** @returns {Record<string, string>} */
function baseHeaders() {
  return { 'Cache-Control': 'no-store' };
}

/**
 * An empty-bodied refusal plus one counted log line. The extension ignores the
 * response entirely, so there is nothing useful to put in a body.
 *
 * @param {number} status
 * @param {string} reason literal label for the log — never derived from input
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function refuse(status, reason, headers) {
  log({ event: 'denied', status, reason });
  return new Response(null, { status, headers: { ...baseHeaders(), ...headers } });
}

/**
 * The only logging in this Worker. **Fixed labels and numbers only** — never a
 * body field, a header or an IP.
 *
 * @param {Record<string, string | number>} fields
 * @returns {void}
 */
function log(fields) {
  try {
    console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
  } catch {
    // Logging must never be the thing that fails a request.
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorName(err) {
  if (err && typeof err === 'object' && typeof (/** @type {any} */ (err).name) === 'string') {
    return (/** @type {any} */ (err).name);
  }
  return 'Error';
}

/**
 * @typedef {Object} Heartbeat
 * @property {string} installId
 * @property {string} day
 * @property {string} extVersion
 * @property {string} vscodeMajor
 * @property {string} os
 * @property {string} tenure
 * @property {string} activation
 * @property {boolean} hasSemanticDir
 * @property {string} domainCount
 * @property {number} activations
 * @property {number} canvasOpens
 * @property {string[]} stages
 * @property {string[]} schemaFormats
 * @property {string} modelCount
 * @property {string} manifest
 * @property {boolean} catalog
 * @property {Record<string, number>} features
 * @property {Record<string, number>} errors
 */

/**
 * @typedef {Object} Env
 * @property {D1Database} DB The `erd-studio-telemetry` D1 database.
 * @property {string|boolean|number} [KILL_SWITCH] Any truthy-looking value makes every request 503.
 */

/**
 * Minimal shape of the D1 binding this Worker uses — declared so the file
 * type-checks on its own, without `@cloudflare/workers-types` installed.
 *
 * @typedef {Object} D1Database
 * @property {(sql: string) => D1PreparedStatement} prepare
 *
 * @typedef {Object} D1PreparedStatement
 * @property {(...values: unknown[]) => D1PreparedStatement} bind
 * @property {() => Promise<{ meta?: { changes?: number } }>} run
 */
