/**
 * Tests for the feedback-analysis proxy.
 *
 * Run with `npm test` in this directory. They use Node's built-in test runner
 * and Node's own `fetch`/`Request`/`Response`/`crypto` globals, so there is
 * nothing to install — the same reason the Worker itself has no dependencies.
 *
 * They are invisible to the repo's vitest suite, whose `include` is
 * `test/unit/**` at the root, and nothing at the root runs them. That is
 * deliberate: `npm run build` and `npm test` at the repo root must stay green
 * in a clone that has never touched this directory.
 *
 * The last group is the one to keep honest. This Worker's two promises — the
 * key never leaves, and no prompt or completion text is ever logged — are
 * exactly the kind of promise that rots silently, because nothing breaks when
 * it stops being true. So they are assertions, not comments: every log line
 * emitted across the whole run is captured and searched for the secret, the
 * prompt, the completion and the caller's IP.
 *
 * Requires Node 18+.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import worker from '../src/index.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A canary the tests search the logs for. Nothing may echo it. */
const SECRET = 'sk-test-SECRET-CANARY';

/** Stand-ins for the private schema names a real report is full of. */
const PROMPT_TEXT = 'dim_customer_pii joins fct_payroll_run';
const COMPLETION_TEXT = '{"kind":"bug","title":"Edge disappears"}';

/** Every line the Worker logged during the run, so the invariants can be checked. */
let logLines = [];
let realLog;

before(() => {
  realLog = console.log;
  console.log = (...args) => logLines.push(args.join(' '));
});

after(() => {
  console.log = realLog;
});

/** An in-memory stand-in for the KV namespace binding. */
function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

/** @param {Record<string, unknown>} [overrides] */
function makeEnv(overrides = {}) {
  return { ANALYSIS_KV: fakeKv(), DEEPSEEK_API_KEY: SECRET, ...overrides };
}

/** The body the extension actually sends, plus fields it does not. */
function clientBody() {
  return JSON.stringify({
    model: 'gpt-4o-please',
    messages: [
      { role: 'system', content: 'You classify feedback.' },
      { role: 'user', content: PROMPT_TEXT },
    ],
    temperature: 0.9,
    response_format: { type: 'json_object' },
    // Fields a hostile client might add. None may reach the upstream.
    tools: [{ type: 'function' }],
    max_tokens: 100000,
    n: 20,
    stream: true,
  });
}

function makeRequest(body = clientBody(), options = {}) {
  const { method = 'POST', path = '/chat/completions', ip = '203.0.113.7', headers = {} } = options;
  return new Request(`https://proxy.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers },
    ...(method === 'POST' ? { body } : {}),
  });
}

/** The last request the Worker made upstream. */
let upstreamCall = null;

/** A successful upstream, recording what it was sent. */
function upstreamOk() {
  return async (url, init) => {
    upstreamCall = {
      url,
      auth: init.headers.Authorization,
      body: JSON.parse(init.body),
    };
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-123',
        model: 'server-choice',
        usage: { total_tokens: 412 },
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: COMPLETION_TEXT } },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
}

/** An upstream that fails, echoing the credential the way a real API might. */
function upstreamFails(status) {
  return async () =>
    new Response(JSON.stringify({ error: { message: `key ${SECRET} is not authorised` } }), {
      status,
    });
}

/** Drives the Worker with a stubbed global fetch. */
async function call(request, env, upstream = upstreamOk()) {
  globalThis.fetch = upstream;
  return worker.fetch(request, env);
}

beforeEach(() => {
  upstreamCall = null;
});

// ---------------------------------------------------------------------------

describe('routing', () => {
  it('serves POST /chat/completions', async () => {
    const response = await call(makeRequest(), makeEnv());
    assert.equal(response.status, 200);
  });

  it('refuses any other method with 405', async () => {
    const response = await call(makeRequest(undefined, { method: 'GET' }), makeEnv());
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
  });

  it('refuses any other path with 404', async () => {
    const response = await call(makeRequest(clientBody(), { path: '/v1/chat/completions' }), makeEnv());
    assert.equal(response.status, 404);
  });

  it('answers no browser: there are no CORS headers', async () => {
    const response = await call(makeRequest(), makeEnv());
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
});

describe('the kill switch', () => {
  for (const value of ['on', '1', 'true', 'yes', 'DISABLED']) {
    it(`refuses everything with 503 when KILL_SWITCH is "${value}"`, async () => {
      const response = await call(makeRequest(), makeEnv({ KILL_SWITCH: value }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'unavailable' });
    });
  }

  for (const value of ['off', '0', 'false', 'no', '', '   ']) {
    it(`still serves when KILL_SWITCH is "${value}"`, async () => {
      assert.equal((await call(makeRequest(), makeEnv({ KILL_SWITCH: value }))).status, 200);
    });
  }

  // `[vars]` in wrangler.toml are JSON, so `KILL_SWITCH = true` reaches the
  // Worker as a boolean, not the string "true" — and that is exactly what an
  // operator writes while the key is being abused. Raw values here on purpose:
  // stringifying them would not exercise the branches that matter.
  for (const value of [true, 1, 42, {}, []]) {
    it(`kills when KILL_SWITCH is the ${typeof value} ${JSON.stringify(value)}`, async () => {
      const response = await call(makeRequest(), makeEnv({ KILL_SWITCH: value }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'unavailable' });
    });
  }

  // The asymmetry has to hold in both directions, or an operator who writes
  // the boolean form of "off" is locked out of their own Worker.
  for (const value of [false, 0, undefined, null]) {
    it(`still serves when KILL_SWITCH is ${JSON.stringify(value) ?? String(value)}`, async () => {
      assert.equal((await call(makeRequest(), makeEnv({ KILL_SWITCH: value }))).status, 200);
    });
  }

  it('is checked before anything else — no KV read, no upstream call', async () => {
    const env = makeEnv({ KILL_SWITCH: 'on' });
    let calledUpstream = false;
    await call(makeRequest(), env, async () => {
      calledUpstream = true;
      return new Response('{}');
    });
    assert.equal(calledUpstream, false);
    assert.equal(env.ANALYSIS_KV.store.size, 0);
  });
});

describe('the request the upstream actually receives', () => {
  it('is rebuilt from an allowlist: the client cannot choose the model or the spend', async () => {
    // The env value, not the production default: this asserts that the SERVER's
    // model wins over the client's `gpt-4o-please`, which is the invariant.
    // Pinning the real id here would make the test fail the day the provider
    // retires it — which is how `deepseek-chat` got shipped past its retirement.
    await call(makeRequest(), makeEnv({ MODEL: 'server-choice' }));
    assert.equal(upstreamCall.body.model, 'server-choice');
    assert.equal(upstreamCall.body.temperature, 0);
    assert.equal(upstreamCall.body.max_tokens, 900);
    assert.equal(upstreamCall.body.stream, false);
    assert.deepEqual(Object.keys(upstreamCall.body).sort(), [
      'max_tokens',
      'messages',
      'model',
      'response_format',
      'stream',
      'temperature',
    ]);
  });

  it('keeps the messages and honours the JSON response format the extension asks for', async () => {
    await call(makeRequest(), makeEnv());
    assert.deepEqual(upstreamCall.body.messages, [
      { role: 'system', content: 'You classify feedback.' },
      { role: 'user', content: PROMPT_TEXT },
    ]);
    assert.deepEqual(upstreamCall.body.response_format, { type: 'json_object' });
  });

  it('carries the key the extension never has', async () => {
    await call(makeRequest(), makeEnv());
    assert.equal(upstreamCall.auth, `Bearer ${SECRET}`);
  });
});

describe('what the client gets back', () => {
  it('is reshaped down to the one field the extension reads', async () => {
    const response = await call(makeRequest(), makeEnv());
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['choices']);
    assert.equal(body.choices[0].message.content, COMPLETION_TEXT);
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(body.choices[0].finish_reason, 'stop');
  });
});

describe('rejecting what is not our client', () => {
  it('refuses an oversized body with 413', async () => {
    const huge = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(30_000) }] });
    assert.equal((await call(makeRequest(huge), makeEnv())).status, 413);
  });

  it('refuses an oversized Content-Length before reading the body', async () => {
    const response = await call(
      makeRequest(clientBody(), { headers: { 'content-length': '999999' } }),
      makeEnv(),
    );
    assert.equal(response.status, 413);
  });

  const badBodies = {
    'unparseable JSON': 'not json at all',
    'a JSON array': '[]',
    'no messages': '{}',
    'an empty message list': '{"messages":[]}',
    'a disallowed role': '{"messages":[{"role":"tool","content":"x"}]}',
    'non-string content': '{"messages":[{"role":"user","content":{"a":1}}]}',
    'empty content': '{"messages":[{"role":"user","content":""}]}',
    'too many messages': JSON.stringify({
      messages: Array.from({ length: 9 }, () => ({ role: 'user', content: 'x' })),
    }),
  };

  for (const [name, body] of Object.entries(badBodies)) {
    it(`refuses ${name} with 400`, async () => {
      assert.equal((await call(makeRequest(body), makeEnv())).status, 400);
    });
  }

  it('makes no upstream call for a bad request', async () => {
    let calledUpstream = false;
    await call(makeRequest('{}'), makeEnv(), async () => {
      calledUpstream = true;
      return new Response('{}');
    });
    assert.equal(calledUpstream, false);
  });
});

describe('metering', () => {
  it('rate limits one caller and leaves the others alone', async () => {
    const env = makeEnv({ IP_LIMIT: '3' });
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await call(makeRequest(), env)).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    assert.equal((await call(makeRequest(clientBody(), { ip: '198.51.100.4' }), env)).status, 200);
  });

  it('answers a rate-limited caller with a short JSON error and a Retry-After', async () => {
    const env = makeEnv({ IP_LIMIT: '1' });
    await call(makeRequest(), env);
    const response = await call(makeRequest(), env);
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: 'rate_limited' });
    assert.ok(Number(response.headers.get('Retry-After')) > 0);
  });

  it('never stores a raw IP address', async () => {
    const env = makeEnv();
    await call(makeRequest(), env);
    assert.ok([...env.ANALYSIS_KV.store.keys()].every((key) => !key.includes('203.0.113.7')));
  });

  it('stops the whole day at the global budget, whoever is asking', async () => {
    const env = makeEnv({ DAILY_BUDGET: '2' });
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await call(makeRequest(clientBody(), { ip: `192.0.2.${i}` }), env)).status);
    }
    assert.deepEqual(statuses, [200, 200, 429, 429]);
  });

  it('reserves the budget before calling upstream, so failures still count', async () => {
    const env = makeEnv();
    await call(makeRequest(), env, upstreamFails(500));
    const day = `day:${new Date().toISOString().slice(0, 10)}`;
    assert.equal(await env.ANALYSIS_KV.get(day), '1');
  });

  it('caps one caller for the whole day, not just for the window', async () => {
    // The window alone cannot bound a day: 15 per 5 minutes is 4,320 per day,
    // several times the global budget. IP_DAILY_LIMIT is what makes "the
    // per-IP check stops one caller eating the budget" true.
    const env = makeEnv({ IP_DAILY_LIMIT: '2', IP_LIMIT: '50' });
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await call(makeRequest(), env)).status);
    assert.deepEqual(statuses, [200, 200, 429, 429]);
    // Another caller is untouched — this is a per-bucket cap, not a global one.
    assert.equal((await call(makeRequest(clientBody(), { ip: '198.51.100.9' }), env)).status, 200);
  });

  it('keeps the daily cap in the window\'s own KV entry — one read, one write', async () => {
    const env = makeEnv();
    await call(makeRequest(), env);
    const ipKeys = [...env.ANALYSIS_KV.store.keys()].filter((key) => key.startsWith('ip:'));
    assert.equal(ipKeys.length, 1);
    const stored = JSON.parse(await env.ANALYSIS_KV.get(ipKeys[0]));
    assert.equal(stored.n, 1);
    assert.equal(stored.d, new Date().toISOString().slice(0, 10));
    assert.equal(stored.w.length, 1);
  });

  it('still reads a window written by an older deployment', async () => {
    // Older builds stored a bare timestamp array. It must keep counting as a
    // window rather than wedging the caller or throwing.
    const env = makeEnv({ IP_LIMIT: '2' });
    await call(makeRequest(), env);
    const key = [...env.ANALYSIS_KV.store.keys()].find((k) => k.startsWith('ip:'));
    await env.ANALYSIS_KV.put(key, JSON.stringify([Date.now(), Date.now()]));
    assert.equal((await call(makeRequest(), env)).status, 429);
  });
});

describe('which caller a limit applies to', () => {
  /** The one `ip:` key the store holds after a single request. */
  async function bucketKeyFor(ip) {
    const env = makeEnv();
    await call(makeRequest(clientBody(), { ip }), env);
    return [...env.ANALYSIS_KV.store.keys()].find((key) => key.startsWith('ip:'));
  }

  it('shares one window across a whole IPv6 /64', async () => {
    // A consumer or VPS allocation is a /64. Keying on the full address would
    // give one caller 2^64 fresh windows — the limit bypassed at no cost.
    const env = makeEnv({ IP_LIMIT: '2' });
    const statuses = [];
    for (const suffix of ['1', '2', '3']) {
      statuses.push(
        (await call(makeRequest(clientBody(), { ip: `2001:db8:1:1::${suffix}` }), env)).status,
      );
    }
    assert.deepEqual(statuses, [200, 200, 429]);
  });

  it('does not share a window between two different /64s', async () => {
    const env = makeEnv({ IP_LIMIT: '1' });
    assert.equal((await call(makeRequest(clientBody(), { ip: '2001:db8:1:1::9' }), env)).status, 200);
    assert.equal((await call(makeRequest(clientBody(), { ip: '2001:db8:1:2::9' }), env)).status, 200);
  });

  it('keys compressed and expanded forms of one prefix the same way', async () => {
    assert.equal(
      await bucketKeyFor('2001:db8:1:1::5'),
      await bucketKeyFor('2001:0db8:0001:0001:0000:0000:0000:0099'),
    );
  });

  it('treats a v4-mapped address as the IPv4 host it is', async () => {
    assert.equal(await bucketKeyFor('::ffff:203.0.113.7'), await bucketKeyFor('203.0.113.7'));
  });

  it('still gives every IPv4 address a window of its own', async () => {
    assert.notEqual(await bucketKeyFor('203.0.113.7'), await bucketKeyFor('203.0.113.8'));
  });

  it('stores no part of an IPv6 address either', async () => {
    const env = makeEnv();
    await call(makeRequest(clientBody(), { ip: '2001:db8:1:1::5' }), env);
    assert.ok([...env.ANALYSIS_KV.store.keys()].every((key) => !key.includes('2001')));
  });
});

describe('upstream failures', () => {
  it('never forwards the upstream error body', async () => {
    const response = await call(makeRequest(), makeEnv(), upstreamFails(401));
    const text = await response.text();
    assert.equal(response.status, 502);
    assert.equal(text, '{"error":"upstream_error"}');
    assert.ok(!text.includes(SECRET));
  });

  it('passes a 429 through as a 429 so the caller backs off', async () => {
    const response = await call(makeRequest(), makeEnv(), upstreamFails(429));
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: 'rate_limited' });
  });

  it('treats an unexpected response shape as an upstream error', async () => {
    const response = await call(makeRequest(), makeEnv(), async () => new Response('{"choices":[]}'));
    assert.equal(response.status, 502);
  });

  it('survives a thrown fetch (timeout, DNS, TLS)', async () => {
    const response = await call(makeRequest(), makeEnv(), async () => {
      throw new TypeError(`connect to https://api.deepseek.com failed`);
    });
    assert.equal(response.status, 502);
  });
});

describe('failing closed', () => {
  it('refuses rather than serving unmetered when KV is down', async () => {
    const brokenKv = {
      async get() {
        throw new Error(`KV unavailable while holding ${SECRET}`);
      },
      async put() {},
    };
    let calledUpstream = false;
    const response = await call(makeRequest(), { ANALYSIS_KV: brokenKv, DEEPSEEK_API_KEY: SECRET }, async () => {
      calledUpstream = true;
      return new Response('{}');
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
    assert.equal(calledUpstream, false, 'a broken limiter must cost nothing');
  });

  it('refuses when deployed without the secret', async () => {
    let calledUpstream = false;
    const response = await call(makeRequest(), { ANALYSIS_KV: fakeKv() }, async () => {
      calledUpstream = true;
      return new Response('{}');
    });
    assert.equal(response.status, 503);
    assert.equal(calledUpstream, false);
  });

  it('falls back to the built-in caps when a var is nonsense', async () => {
    await call(makeRequest(), makeEnv({ MAX_TOKENS: 'unlimited', DAILY_BUDGET: '-5' }));
    assert.equal(upstreamCall.body.max_tokens, 900);
  });
});

// This group reads every log line produced by every test above, so it has to
// run last. It is the whole point of the file.
describe('the two invariants, across every line logged in this run', () => {
  it('logged something at all (otherwise the checks below are vacuous)', () => {
    assert.ok(logLines.length > 20, `expected many log lines, saw ${logLines.length}`);
  });

  it('never logged the API key', () => {
    assert.ok(!logLines.join('\n').includes(SECRET));
  });

  it('never logged the prompt or the completion', () => {
    const joined = logLines.join('\n');
    assert.ok(!joined.includes(PROMPT_TEXT), 'a prompt reached the log');
    assert.ok(!joined.includes(COMPLETION_TEXT), 'a completion reached the log');
    assert.ok(!joined.includes('classify feedback'), 'a system prompt reached the log');
  });

  it("never logged the caller's IP address", () => {
    const joined = logLines.join('\n');
    for (const ip of ['203.0.113.7', '198.51.100.4', '192.0.2.0']) {
      assert.ok(!joined.includes(ip), `${ip} reached the log`);
    }
  });

  it('logged only JSON objects of counts, statuses and fixed labels', () => {
    for (const line of logLines) {
      const entry = JSON.parse(line);
      assert.equal(typeof entry.at, 'string');
      assert.ok('event' in entry);
      for (const [key, value] of Object.entries(entry)) {
        assert.ok(
          typeof value === 'number' || typeof value === 'string',
          `${key} is not a scalar`,
        );
        if (typeof value === 'string') {
          assert.ok(value.length < 40, `${key} is too long to be a label: ${key}`);
        }
      }
    }
  });
});
