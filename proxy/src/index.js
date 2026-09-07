/**
 * ERD Studio — hosted feedback-analysis proxy (Cloudflare Worker).
 *
 * This is the service behind `HOSTED_ANALYSIS_ENDPOINT` in
 * `src/services/feedbackAnalysisService.ts`: the extension's **last-resort**
 * analysis tier, used only when the user has neither a VS Code language model
 * nor their own OpenAI-compatible endpoint. It exists so that someone with no
 * model at all still gets a suggested title, a type and a duplicate check when
 * they file feedback.
 *
 * It is not part of the extension build. Nothing in `esbuild.js`, the
 * tsconfigs or the npm scripts may come to depend on this directory, and
 * `proxy/**` is listed in `.vscodeignore` so it never ships in the VSIX.
 * Deploy it by hand — see `README.md` in this directory.
 *
 * ## What it is
 *
 * One route, one shape: `POST /chat/completions` with the OpenAI-compatible
 * body the extension already sends, forwarded to an upstream chat-completions
 * API using a key this Worker holds as a secret. The extension sends **no**
 * Authorization header; the key never leaves the Worker.
 *
 * ## The rules it enforces, and why
 *
 * The endpoint URL is public — it ships inside a published VSIX, so anyone can
 * read it out of the extension and call it. The operator therefore pays for
 * every request that gets through, and everything below exists to bound that:
 *
 *   - **Route** — POST to exactly one path. Anything else is 405/404 before any
 *     work happens.
 *   - **Kill switch** — `KILL_SWITCH` truthy makes every request 503 with no
 *     upstream call and no KV read. It is a `[vars]` entry in `wrangler.toml`,
 *     which is its source of truth: a dashboard flip is immediate but is
 *     re-applied over by the next `wrangler deploy`, so a lasting stop is set
 *     here and deployed (README has the deploy-proof one).
 *   - **Body cap** — the extension's prompt is ~2-3 KB. Anything materially
 *     bigger is not our client and is refused (413) while it is still
 *     streaming, so an attacker cannot make us buffer a large body.
 *   - **Server-owned parameters** — `model`, `temperature`, `max_tokens` and
 *     `stream` are set here, never taken from the request. A client cannot ask
 *     for an expensive model or an unbounded completion. The request is
 *     rebuilt from an allowlist rather than forwarded, so unknown fields
 *     (tools, logprobs, n, …) simply do not reach the upstream.
 *   - **Per-IP sliding window + global daily budget**, both in KV. Either one
 *     exceeded is a 429 with a short JSON body — never a 500, because the
 *     client logs the status and a 5xx would read as our bug.
 *   - **Fail closed.** Any unexpected error — including a KV failure, which
 *     would otherwise mean "unmetered" — returns 503 and makes no upstream
 *     call. A broken limiter must cost nothing.
 *
 * ## Two invariants that are not negotiable
 *
 *   1. **The key never leaves.** `DEEPSEEK_API_KEY` is a Worker secret. It is
 *      used in exactly one place (the upstream `Authorization` header) and
 *      appears in no response body, no header we set and no log line. Upstream
 *      error bodies are **discarded**, never forwarded, because they are the
 *      one place a provider might echo something about the credential.
 *   2. **No prompt or completion text is ever logged.** The text is other
 *      people's private dbt model and table names. Every value in {@link log}
 *      is a literal or a number computed here; there is no code path that puts
 *      request or response content into `console.log`. Keep it that way.
 *
 * CORS is deliberately absent: the caller is the VS Code extension host, not a
 * browser, so no preflight is answered and no origin is blessed.
 */

/** The one path this Worker serves. The extension posts `<base>/chat/completions`. */
const ROUTE = '/chat/completions';

/**
 * Defaults for everything that is configurable through `[vars]`. Each is also
 * the value that applies when a var is missing, unparseable or out of range —
 * a typo in the dashboard degrades to a sane number rather than to "unlimited".
 */
const DEFAULTS = {
  /** Upstream chat-completions URL. */
  UPSTREAM_URL: 'https://api.deepseek.com/chat/completions',
  /** The only model this Worker will ask for, whatever the client sent. */
  MODEL: 'deepseek-v4-flash',
  /** Max request body. The extension's prompt is ~2-3 KB. */
  MAX_BODY_BYTES: 24 * 1024,
  /** Max upstream response we will buffer. */
  MAX_UPSTREAM_BYTES: 256 * 1024,
  /** Completion cap. The analysis JSON is a few hundred tokens. */
  MAX_TOKENS: 900,
  /** Most messages one request may carry (the extension sends system + user). */
  MAX_MESSAGES: 8,
  /** Requests one IP bucket may make per window. */
  IP_LIMIT: 15,
  /** Sliding window, in seconds. */
  IP_WINDOW_SECONDS: 300,
  /**
   * Requests one IP bucket may make per UTC day.
   *
   * The sliding window alone cannot bound a day: 15 per 5 minutes is 4,320 per
   * day, several times the global budget, so a single caller could drain it
   * legitimately. This is the cap that makes the per-IP check mean what its
   * comment says. It rides in the same KV entry as the window, so it costs no
   * extra read or write.
   */
  IP_DAILY_LIMIT: 60,
  /**
   * Requests all clients together may make per UTC day.
   *
   * Sized for the **Workers Free** plan rather than for the model bill: every
   * served request costs two KV writes (the per-caller entry and this counter)
   * against a 1,000/day free write quota, so ~500 served requests is the real
   * ceiling whatever this says — and exceeding the KV quota makes every request
   * 503 until UTC midnight rather than degrading to 429. 450 leaves headroom
   * for the single write a budget-denied request still incurs. On Workers Paid
   * this can be raised; see README.md.
   */
  DAILY_BUDGET: 450,
  /** Upstream timeout. The extension gives up at 20 s, so finish before it does. */
  UPSTREAM_TIMEOUT_MS: 18_000,
};

/** Roles a forwarded message may carry. Anything else is a bad request. */
const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);

/** KV entries live at least this long — the platform's minimum TTL. */
const MIN_KV_TTL_SECONDS = 60;

/** How long a daily counter is kept (two days, so a UTC rollover is never lost). */
const DAY_KEY_TTL_SECONDS = 172_800;

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const started = Date.now();

    // The kill switch is checked before anything else — before the method,
    // before the path, before KV — so "off" is genuinely free and genuinely
    // total.
    if (isKilled(env)) {
      return refuse(503, 'unavailable', started, 'kill_switch');
    }

    try {
      if (request.method !== 'POST') {
        return refuse(405, 'method_not_allowed', started, 'method', { Allow: 'POST' });
      }
      if (new URL(request.url).pathname !== ROUTE) {
        return refuse(404, 'not_found', started, 'path');
      }

      return await handleCompletion(request, env, started);
    } catch (err) {
      // Fail closed. Anything that reaches here — a KV outage, a runtime
      // error, a bug — is a refusal, not a pass-through: an unmetered request
      // is worse than a missing analysis, and the extension degrades to "no
      // analysis available" on any non-2xx anyway.
      //
      // Only the error's *name* is logged. Messages and stacks can quote
      // inputs, and inputs are the user's prose.
      log({ event: 'error', status: 503, ms: Date.now() - started, kind: errorName(err) });
      return json(503, { error: 'unavailable' });
    }
  },
};

/**
 * The one real code path: validate, meter, forward, reshape.
 *
 * @param {Request} request
 * @param {Env} env
 * @param {number} started
 * @returns {Promise<Response>}
 */
async function handleCompletion(request, env, started) {
  const maxBody = intVar(env.MAX_BODY_BYTES, DEFAULTS.MAX_BODY_BYTES, 1024, 1024 * 1024);

  const body = await readLimited(request.body, maxBody, request.headers.get('content-length'));
  if (!body.ok) {
    return refuse(413, 'payload_too_large', started, 'body_size');
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return refuse(400, 'bad_request', started, 'json');
  }

  const upstreamBody = buildUpstreamBody(parsed, env);
  if (!upstreamBody) {
    return refuse(400, 'bad_request', started, 'shape');
  }

  // Metering. Per-IP first: it is the cheaper check, and between the sliding
  // window and the per-bucket daily cap it is what stops one caller from eating
  // the day's budget on their own.
  const now = Date.now();
  const ipWindow = await checkIpWindow(env, await clientKey(request, env), now);
  if (!ipWindow.allowed) {
    return refuse(429, 'rate_limited', started, ipWindow.reason, {
      'Retry-After': String(ipWindow.retryAfter),
    });
  }

  // The daily budget is *reserved* before the upstream call, not recorded
  // after it. A request that is attempted has already committed the operator
  // to whatever it costs, and counting only successes would let a failing
  // upstream be retried without limit.
  const budget = await reserveDailyBudget(env, now);
  if (!budget.allowed) {
    return refuse(429, 'daily_budget_exhausted', started, 'daily_budget', {
      'Retry-After': String(secondsUntilNextUtcDay(now)),
    });
  }

  const upstream = await callUpstream(env, upstreamBody);
  if (!upstream.ok) {
    log({
      event: 'upstream_failed',
      status: upstream.status,
      upstream_status: upstream.upstreamStatus,
      ms: Date.now() - started,
      daily: budget.used,
    });
    // The upstream's own body is never forwarded: it is the one response that
    // could quote the credential back at us, and it is not shaped like
    // anything the client parses.
    return json(upstream.status, { error: upstream.error });
  }

  log({
    event: 'ok',
    status: 200,
    ms: Date.now() - started,
    daily: budget.used,
    /** Length only — never the text itself. */
    content_chars: upstream.content.length,
  });

  return json(200, {
    choices: [
      {
        index: 0,
        finish_reason: upstream.finishReason,
        message: { role: 'assistant', content: upstream.content },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Request validation
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

/**
 * The body we will actually send upstream, or `null` when the request is not
 * one we serve.
 *
 * This is an **allowlist rebuild**, not a rewrite of the client's object: the
 * only thing that survives from the request is the message list, and even that
 * is re-created message by message. `model`, `temperature`, `max_tokens` and
 * `stream` are the server's to decide — the client's `model` is advisory and
 * is discarded, which is what stops a public URL from being a way to spend the
 * operator's money on a model they did not choose.
 *
 * @param {unknown} parsed
 * @param {Env} env
 * @returns {Record<string, unknown> | null}
 */
function buildUpstreamBody(parsed, env) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const request = /** @type {Record<string, unknown>} */ (parsed);
  const maxMessages = intVar(env.MAX_MESSAGES, DEFAULTS.MAX_MESSAGES, 1, 32);
  const messages = sanitiseMessages(request.messages, maxMessages);
  if (!messages) return null;

  /** @type {Record<string, unknown>} */
  const body = {
    model: strVar(env.MODEL, DEFAULTS.MODEL),
    messages,
    temperature: 0,
    max_tokens: intVar(env.MAX_TOKENS, DEFAULTS.MAX_TOKENS, 16, 4096),
    stream: false,
  };

  // The extension asks for JSON back and parses it. Honour that one option —
  // by matching it, not by forwarding whatever the client put there.
  const format = request.response_format;
  if (format && typeof format === 'object' && !Array.isArray(format)) {
    if (/** @type {Record<string, unknown>} */ (format).type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
  }

  return body;
}

/**
 * `value` as a clean message list, or `null` if it is not one.
 *
 * @param {unknown} value
 * @param {number} maxMessages
 * @returns {Array<{ role: string, content: string }> | null}
 */
function sanitiseMessages(value, maxMessages) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxMessages) return null;

  /** @type {Array<{ role: string, content: string }>} */
  const messages = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const { role, content } = /** @type {Record<string, unknown>} */ (entry);
    if (typeof role !== 'string' || !ALLOWED_ROLES.has(role)) return null;
    if (typeof content !== 'string' || content.length === 0) return null;
    messages.push({ role, content });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Metering (KV)
// ---------------------------------------------------------------------------

/**
 * The address reduced to the unit a limit should apply to: a whole IPv4
 * address, but only the routing prefix of an IPv6 one.
 *
 * A single ordinary consumer or VPS allocation is a /64, so keying the window
 * on a full v6 address would hand one caller 2^64 fresh windows — a new source
 * address per request bypasses the per-IP limit entirely, at no cost. IPv4 is
 * left whole, where one address really is one host.
 *
 * `::ffff:1.2.3.4` (a v4-mapped address) falls back to the v4 path so the same
 * host is one bucket however it presents itself, and compressed (`2001:db8::1`)
 * and expanded forms of one prefix produce the same string.
 *
 * @param {string} ip
 * @returns {string}
 */
function ipBucket(ip) {
  if (!ip.includes(':')) return ip; // IPv4 — the host is the bucket
  const addr = ip.toLowerCase().split('%')[0]; // drop any zone id
  if (addr.startsWith('::ffff:') && addr.includes('.')) return addr.slice(7); // v4-mapped
  /** @type {string[]} */
  let parts;
  if (addr.includes('::')) {
    const [head, tail = ''] = addr.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const fill = Math.max(0, 8 - headParts.length - tailParts.length);
    parts = [...headParts, ...Array(fill).fill('0'), ...tailParts];
  } else {
    parts = addr.split(':');
  }
  return `${parts
    .slice(0, 4)
    .map((part) => (part || '0').padStart(4, '0'))
    .join(':')}::/64`;
}

/**
 * A stable, opaque identifier for the caller.
 *
 * The raw IP is never stored: it is hashed with an operator-supplied salt, so
 * what lands in KV is a bucket id rather than a record of who asked. It is
 * never logged either — the counts are what matter, not the callers.
 *
 * What is hashed is {@link ipBucket}'s output, not the address: IPv4 by host,
 * IPv6 by /64, because a whole v6 prefix belongs to one caller.
 *
 * A request with no `CF-Connecting-IP` (which should not happen behind
 * Cloudflare) shares one bucket rather than escaping the limit. The header
 * itself is not spoofable — Cloudflare overwrites it at the edge, and
 * `X-Forwarded-For` is deliberately ignored.
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<string>}
 */
async function clientKey(request, env) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return 'unknown';
  const salt = strVar(env.IP_HASH_SALT, 'erd-studio-feedback-proxy');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${salt}:${ipBucket(ip)}`),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Per-caller rate limit: a sliding window *and* a daily cap, in one KV entry.
 *
 * The window is a list of timestamps rather than a fixed-bucket counter, so
 * there is no burst at the boundary, and it is sized for real use — writing one
 * description fires several debounced analyses. The daily cap is what bounds
 * the day: `IP_LIMIT` per `IP_WINDOW_SECONDS` alone works out to thousands of
 * requests a day, which is more than the global budget, so without it "the
 * per-IP limit stops one caller eating the budget" would simply not be true.
 *
 * Both live in the same value, so this still costs exactly one KV read and one
 * KV write — the write quota is a real limit on the free plan (see README).
 *
 * KV is eventually consistent, which makes this approximate under concurrency
 * from one caller — that is fine: it is a cost guard backed by the global daily
 * budget, not an access control. A KV failure throws, and the caller turns that
 * into a 503 (see the fail-closed note in `fetch`).
 *
 * @param {Env} env
 * @param {string} key
 * @param {number} now
 * @returns {Promise<{ allowed: true } | { allowed: false, retryAfter: number, reason: string }>}
 */
async function checkIpWindow(env, key, now) {
  const limit = intVar(env.IP_LIMIT, DEFAULTS.IP_LIMIT, 1, 10_000);
  const windowSeconds = intVar(env.IP_WINDOW_SECONDS, DEFAULTS.IP_WINDOW_SECONDS, 10, 86_400);
  const dailyLimit = intVar(env.IP_DAILY_LIMIT, DEFAULTS.IP_DAILY_LIMIT, 1, 1_000_000);
  const cutoff = now - windowSeconds * 1000;
  const today = utcDay(now);

  const state = parseIpState(await env.ANALYSIS_KV.get(`ip:${key}`), cutoff, today);
  let hits = state.hits;

  if (hits.length >= limit) {
    const oldest = hits[0];
    const retryAfter = Math.max(1, Math.ceil((oldest - cutoff) / 1000));
    return {
      allowed: false,
      retryAfter: Math.min(retryAfter, windowSeconds),
      reason: 'ip_window',
    };
  }
  if (state.dayCount >= dailyLimit) {
    return {
      allowed: false,
      retryAfter: secondsUntilNextUtcDay(now),
      reason: 'ip_daily',
    };
  }

  hits.push(now);
  // Bound what we store even if the limit is large — a KV value is not a log.
  if (hits.length > limit) hits = hits.slice(-limit);

  await env.ANALYSIS_KV.put(
    `ip:${key}`,
    JSON.stringify({ w: hits, d: today, n: state.dayCount + 1 }),
    {
      // Long enough to outlive both the window and the UTC day it counts, or
      // the daily cap would forget itself minutes after the window expired.
      expirationTtl: Math.max(MIN_KV_TTL_SECONDS, windowSeconds, secondsUntilNextUtcDay(now)),
    },
  );
  return { allowed: true };
}

/**
 * The still-live timestamps and today's count in a stored entry.
 *
 * A corrupt or unparseable value is treated as an empty window with no count:
 * this is a spend guard, and the global daily budget is the backstop, so a bad
 * KV entry must not wedge a caller out for ever. A bare array is the shape
 * older deployments wrote and is still read, contributing no daily count.
 *
 * @param {string | null} raw
 * @param {number} cutoff
 * @param {string} today
 * @returns {{ hits: number[], dayCount: number }}
 */
function parseIpState(raw, cutoff, today) {
  if (!raw) return { hits: [], dayCount: 0 };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { hits: liveTimestamps(parsed, cutoff), dayCount: 0 };
    if (!parsed || typeof parsed !== 'object') return { hits: [], dayCount: 0 };
    const hits = Array.isArray(parsed.w) ? liveTimestamps(parsed.w, cutoff) : [];
    // A count from another UTC day is not today's, so it starts again at zero.
    const count = parsed.d === today && typeof parsed.n === 'number' ? parsed.n : 0;
    return { hits, dayCount: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0 };
  } catch {
    return { hits: [], dayCount: 0 };
  }
}

/**
 * The entries of a stored window that are still inside it, oldest first.
 *
 * @param {unknown[]} values
 * @param {number} cutoff
 * @returns {number[]}
 */
function liveTimestamps(values, cutoff) {
  return /** @type {number[]} */ (
    values.filter(
      (value) => typeof value === 'number' && Number.isFinite(value) && value > cutoff,
    )
  ).sort((a, b) => a - b);
}

/**
 * The UTC day a timestamp falls in, as `YYYY-MM-DD` — the unit both the global
 * budget and the per-caller daily cap are keyed by.
 *
 * @param {number} now
 * @returns {string}
 */
function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Claims one request against today's global budget.
 *
 * This is the number that decides the monthly bill, so it is checked for every
 * caller together and keyed by UTC day. Read-then-write over KV can undercount
 * under heavy concurrency; that is why the account-level spend cap in the
 * README is not optional. Set the budget where you would be content to be
 * wrong by a few requests, not by a factor.
 *
 * @param {Env} env
 * @param {number} now
 * @returns {Promise<{ allowed: boolean, used: number }>}
 */
async function reserveDailyBudget(env, now) {
  const budget = intVar(env.DAILY_BUDGET, DEFAULTS.DAILY_BUDGET, 1, 1_000_000);
  const key = `day:${utcDay(now)}`;

  const raw = await env.ANALYSIS_KV.get(key);
  const parsed = Number.parseInt(raw ?? '0', 10);
  const used = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

  if (used >= budget) return { allowed: false, used };

  await env.ANALYSIS_KV.put(key, String(used + 1), { expirationTtl: DAY_KEY_TTL_SECONDS });
  return { allowed: true, used: used + 1 };
}

/**
 * Seconds until the UTC day rolls over — the honest `Retry-After` for an
 * exhausted daily budget.
 *
 * @param {number} now
 * @returns {number}
 */
function secondsUntilNextUtcDay(now) {
  const today = new Date(now);
  const next = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

// ---------------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------------

/**
 * Calls the upstream chat-completions API and extracts the one field the
 * extension reads.
 *
 * Every failure mode collapses to a small, fixed error — the upstream's status
 * is logged as a number and its body is dropped. The client treats any non-2xx
 * as "no analysis", so there is nothing to gain from detail and something to
 * lose from leaking it.
 *
 * @param {Env} env
 * @param {Record<string, unknown>} body
 * @returns {Promise<
 *   { ok: true, content: string, finishReason: string }
 *   | { ok: false, status: number, error: string, upstreamStatus: number }
 * >}
 */
async function callUpstream(env, body) {
  const key = env.DEEPSEEK_API_KEY;
  if (typeof key !== 'string' || key.length === 0) {
    // Deployed without the secret. Refuse rather than call anything.
    return { ok: false, status: 503, error: 'unavailable', upstreamStatus: 0 };
  }

  const url = strVar(env.UPSTREAM_URL, DEFAULTS.UPSTREAM_URL);
  const timeout = intVar(env.UPSTREAM_TIMEOUT_MS, DEFAULTS.UPSTREAM_TIMEOUT_MS, 1000, 60_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        // The one and only use of the secret.
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Pass a 429 through as a 429 so the caller is told to back off; anything
      // else is our problem to the client, not theirs.
      const status = response.status === 429 ? 429 : 502;
      const error = status === 429 ? 'rate_limited' : 'upstream_error';
      return { ok: false, status, error, upstreamStatus: response.status };
    }

    const maxBytes = intVar(
      env.MAX_UPSTREAM_BYTES,
      DEFAULTS.MAX_UPSTREAM_BYTES,
      1024,
      4 * 1024 * 1024,
    );
    const payload = await readLimited(response.body, maxBytes, response.headers.get('content-length'));
    if (!payload.ok) {
      return { ok: false, status: 502, error: 'upstream_error', upstreamStatus: response.status };
    }

    /** @type {unknown} */
    let json;
    try {
      json = JSON.parse(payload.text);
    } catch {
      return { ok: false, status: 502, error: 'upstream_error', upstreamStatus: response.status };
    }

    const choice = /** @type {any} */ (json)?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string') {
      return { ok: false, status: 502, error: 'upstream_error', upstreamStatus: response.status };
    }

    const finishReason =
      typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'stop';
    return { ok: true, content, finishReason };
  } catch (err) {
    // Timeout, DNS, TLS, abort — all the same to the client. `errorName` keeps
    // the message (which can quote the URL) out of the log.
    log({ event: 'upstream_error', kind: errorName(err) });
    return { ok: false, status: 502, error: 'upstream_error', upstreamStatus: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Whether the kill switch is engaged.
 *
 * Anything other than an explicitly "off"-looking value counts as on, because
 * the failure this guards is "I meant to turn it off and fat-fingered the
 * value". `KILL_SWITCH` **unset** is the only implicit serving state.
 *
 * Cloudflare `[vars]` are JSON values, so `KILL_SWITCH = true` in
 * `wrangler.toml` is a boolean, not the string `"true"` — and that is exactly
 * what an operator reaches for while the key is being abused. Booleans and
 * numbers are therefore honoured in **both** directions (`false` / `0` still
 * serve, so nobody is locked out by writing the boolean form of "off"), and
 * anything else the runtime can hand us — an object or array var — is
 * unrecognised and refuses rather than serving on a switch that was set.
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
  if (value === '' || value === '0' || value === 'false' || value === 'off' || value === 'no') {
    return false;
  }
  return true;
}

/**
 * An integer var, clamped to `[min, max]`, falling back to `fallback` when it
 * is missing or unparseable.
 *
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function intVar(raw, fallback, min, max) {
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * A non-empty string var, or `fallback`.
 *
 * @param {unknown} raw
 * @param {string} fallback
 * @returns {string}
 */
function strVar(raw, fallback) {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;
}

// ---------------------------------------------------------------------------
// Responses and logging
// ---------------------------------------------------------------------------

/**
 * A JSON response. No CORS headers: the caller is an extension host, and a
 * browser has no business here.
 *
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

/**
 * A refusal: the short JSON error the client sees, plus one counted log line.
 *
 * @param {number} status
 * @param {string} error machine-readable, from a fixed set
 * @param {number} started
 * @param {string} reason literal label for the log — never derived from input
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function refuse(status, error, started, reason, headers) {
  log({ event: 'denied', status, reason, ms: Date.now() - started });
  return json(status, { error }, headers);
}

/**
 * The only logging in this Worker.
 *
 * **Counts, statuses and fixed labels only.** Nothing derived from a request
 * body, a completion, a header or an IP may be passed in here — that content is
 * other people's private schema names, and this is the boundary that keeps it
 * out of the operator's log tail.
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
 * An error's constructor name — safe to log, unlike its message, which can
 * quote the input that caused it.
 *
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
 * @typedef {Object} Env
 * @property {KVNamespace} ANALYSIS_KV KV namespace holding the rate-limit windows and the daily counter.
 * @property {string} [DEEPSEEK_API_KEY] Worker **secret** — the upstream API key. Never logged, never returned.
 * @property {string|boolean|number} [KILL_SWITCH] Any truthy-looking value makes every request 503. `[vars]` are JSON, so this can arrive as a boolean or a number.
 * @property {string} [UPSTREAM_URL] Upstream chat-completions URL.
 * @property {string} [MODEL] The only model this Worker will request.
 * @property {string} [MAX_BODY_BYTES] Request body cap.
 * @property {string} [MAX_UPSTREAM_BYTES] Upstream response cap.
 * @property {string} [MAX_TOKENS] Completion cap.
 * @property {string} [MAX_MESSAGES] Message-count cap.
 * @property {string} [IP_LIMIT] Requests per IP per window.
 * @property {string} [IP_WINDOW_SECONDS] Window length.
 * @property {string} [IP_DAILY_LIMIT] Requests per IP bucket per UTC day.
 * @property {string} [DAILY_BUDGET] Global requests per UTC day.
 * @property {string} [UPSTREAM_TIMEOUT_MS] Upstream timeout.
 * @property {string} [IP_HASH_SALT] Salt for the stored IP hash.
 */

/**
 * Minimal shape of the KV binding this Worker uses — declared so the file
 * type-checks on its own, without `@cloudflare/workers-types` installed.
 *
 * @typedef {Object} KVNamespace
 * @property {(key: string) => Promise<string | null>} get
 * @property {(key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>} put
 */
