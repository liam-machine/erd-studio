/**
 * Tests for the usage telemetry collector.
 *
 * Run with `npm test` in this directory. They use Node's built-in test runner
 * and Node's own `fetch`/`Request`/`Response` globals, so there is nothing to
 * install — the same reason the Worker itself has no dependencies.
 *
 * They are invisible to the repo's vitest suite, whose `include` is
 * `test/unit/**` at the root, and nothing at the root runs them: `npm run build`
 * and `npm test` at the repo root must stay green in a clone that has never
 * touched this directory.
 *
 * The group to keep honest is the last one. "No IP, no user-agent, no header is
 * stored and no payload is logged" is exactly the kind of promise that rots
 * silently, so it is an assertion: every value bound to D1 and every log line
 * emitted across the run is searched for canaries planted in the request.
 *
 * Requires Node 18+.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import worker from '../src/index.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CANARY_IP = '198.51.100.77';
const CANARY_UA = 'CanaryAgent/9.9 (secret-host)';
const CANARY_COUNTRY = 'ZZ-CANARY';
const INSTALL_ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

let logLines = [];
let realLog;

before(() => {
  realLog = console.log;
  console.log = (...args) => logLines.push(args.join(' '));
});

after(() => {
  console.log = realLog;
});

/** Every statement the Worker ran against the fake D1, across the whole run. */
const allStatements = [];

/** An in-memory stand-in for the D1 binding that records every statement. */
function fakeD1({ fail = false } = {}) {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      const statement = { sql, params: [] };
      return {
        bind(...values) {
          statement.params = values;
          return this;
        },
        async run() {
          if (fail) throw new Error(`D1_ERROR: boom ${CANARY_IP}`);
          statements.push(statement);
          allStatements.push(statement);
          return { meta: { changes: 3 } };
        },
      };
    },
  };
}

function makeEnv(overrides = {}) {
  return { DB: fakeD1(), KILL_SWITCH: 'off', ...overrides };
}

function utcDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** A valid heartbeat, as the extension sends it. */
function heartbeat(overrides = {}) {
  return {
    v: 1,
    installId: INSTALL_ID,
    day: utcDay(-1),
    extVersion: '1.1.0',
    vscodeMajor: '1.104',
    os: 'darwin',
    tenure: '8-30',
    activation: 'project_found',
    hasSemanticDir: true,
    domainCount: '1-3',
    activations: 3,
    canvasOpens: 7,
    stages: ['physical', 'logical'],
    schemaFormats: ['v5'],
    modelCount: '11-50',
    manifest: 'ok',
    catalog: false,
    features: { physicalStage: 2, compare: 1 },
    errors: { manifestMissing: 1 },
    ...overrides,
  };
}

function makeRequest(body, options = {}) {
  const { method = 'POST', path = '/v1/heartbeat', headers = {} } = options;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? heartbeat());
  return new Request(`https://telemetry.example${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': CANARY_IP,
      'X-Forwarded-For': CANARY_IP,
      'User-Agent': CANARY_UA,
      'CF-IPCountry': CANARY_COUNTRY,
      ...headers,
    },
    ...(method === 'POST' || method === 'PUT' ? { body: text } : {}),
  });
}

/** A request whose body arrives as a stream with no Content-Length. */
function streamingRequest(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request('https://telemetry.example/v1/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stream,
    duplex: 'half',
  });
}

async function call(request, env = makeEnv()) {
  return worker.fetch(request, env);
}

/** Posts `body` and returns `{ status, env }`. */
async function post(body, env = makeEnv()) {
  const response = await call(makeRequest(body), env);
  return { status: response.status, env, response };
}

/** The stored row's params for a body that should be accepted. */
async function storedParams(body) {
  const { status, env } = await post(body);
  assert.equal(status, 204);
  assert.equal(env.DB.statements.length, 1);
  return env.DB.statements[0].params;
}

beforeEach(() => {
  logLines = [];
});

// ---------------------------------------------------------------------------
// Routing and the kill switch
// ---------------------------------------------------------------------------

describe('routing', () => {
  it('accepts a valid heartbeat with 204 and an empty body', async () => {
    const { status, env, response } = await post(heartbeat());
    assert.equal(status, 204);
    assert.equal(await response.text(), '');
    assert.equal(env.DB.statements.length, 1);
    assert.match(env.DB.statements[0].sql, /ON CONFLICT\(install_id, day\) DO UPDATE/);
  });

  it('404s any other path, without touching D1', async () => {
    for (const path of ['/', '/v1/heartbeats', '/v2/heartbeat', '/v1/heartbeat/x']) {
      const env = makeEnv();
      assert.equal((await call(makeRequest(heartbeat(), { path }), env)).status, 404, path);
      assert.equal(env.DB.statements.length, 0);
    }
  });

  it('405s other methods on the route, with Allow: POST', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await call(makeRequest(heartbeat(), { method }));
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('Allow'), 'POST');
    }
  });

  it('sets no CORS headers', async () => {
    const response = await call(makeRequest(heartbeat(), { headers: { Origin: 'https://evil.example' } }));
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    const preflight = await call(makeRequest(null, { method: 'OPTIONS' }));
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), null);
  });

  for (const value of ['on', 'true', '1', 'yes', true, 1, {}]) {
    it(`503s everything with no D1 access when KILL_SWITCH is ${JSON.stringify(value)}`, async () => {
      const env = makeEnv({ KILL_SWITCH: value });
      assert.equal((await call(makeRequest(heartbeat()), env)).status, 503);
      assert.equal((await call(makeRequest(heartbeat(), { path: '/nope' }), env)).status, 503);
      assert.equal(env.DB.statements.length, 0);
    });
  }

  for (const value of ['off', 'false', '0', 'no', '', false, 0, undefined]) {
    it(`serves when KILL_SWITCH is ${JSON.stringify(value) ?? 'unset'}`, async () => {
      assert.equal((await call(makeRequest(heartbeat()), makeEnv({ KILL_SWITCH: value }))).status, 204);
    });
  }

  it('fails closed with 503 when D1 throws, logging only the error name', async () => {
    const response = await call(makeRequest(heartbeat()), makeEnv({ DB: fakeD1({ fail: true }) }));
    assert.equal(response.status, 503);
    assert.ok(!logLines.join('\n').includes('boom'));
  });
});

// ---------------------------------------------------------------------------
// Body size
// ---------------------------------------------------------------------------

describe('body size', () => {
  it('accepts a body of exactly 2048 bytes', async () => {
    const base = JSON.stringify(heartbeat());
    // Pad with an unknown key (dropped) to hit the cap exactly.
    const padding = 2048 - base.length - ',"pad":""'.length;
    const body = base.slice(0, -1) + `,"pad":"${'x'.repeat(padding)}"}`;
    assert.equal(new TextEncoder().encode(body).byteLength, 2048);
    assert.equal((await post(body)).status, 204);
  });

  it('413s a body of 2049 bytes', async () => {
    const base = JSON.stringify(heartbeat());
    const padding = 2049 - base.length - ',"pad":""'.length;
    const body = base.slice(0, -1) + `,"pad":"${'x'.repeat(padding)}"}`;
    const { status, env } = await post(body);
    assert.equal(status, 413);
    assert.equal(env.DB.statements.length, 0);
  });

  it('413s an oversized declared Content-Length before reading', async () => {
    const response = await call(makeRequest(heartbeat(), { headers: { 'content-length': '999999' } }));
    assert.equal(response.status, 413);
  });

  it('counts the stream rather than trusting a missing Content-Length', async () => {
    const env = makeEnv();
    const response = await call(streamingRequest(['{"v":1,"pad":"', 'x'.repeat(3000), '"}']), env);
    assert.equal(response.status, 413);
    assert.equal(env.DB.statements.length, 0);
  });

  it('accepts a small chunked body', async () => {
    const text = JSON.stringify(heartbeat());
    const response = await call(streamingRequest([text.slice(0, 50), text.slice(50)]));
    assert.equal(response.status, 204);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validation — rejections', () => {
  it('400s a body that is not JSON', async () => {
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post('')).status, 400);
  });

  for (const body of ['null', '[]', '"str"', '42', 'true']) {
    it(`400s a JSON ${body} that is not an object`, async () => {
      assert.equal((await post(body)).status, 400);
    });
  }

  const required = [
    'v', 'installId', 'day', 'extVersion', 'vscodeMajor', 'os', 'tenure', 'activation',
    'hasSemanticDir', 'domainCount', 'activations', 'canvasOpens', 'stages', 'schemaFormats',
    'modelCount', 'manifest', 'catalog',
  ];
  for (const field of required) {
    it(`400s when ${field} is missing`, async () => {
      const body = heartbeat();
      delete body[field];
      const { status, env } = await post(body);
      assert.equal(status, 400);
      assert.equal(env.DB.statements.length, 0);
    });
  }

  /** @type {Array<[string, unknown]>} */
  const invalid = [
    ['v', 2],
    ['v', '1'],
    ['v', 0],
    ['installId', 'not-a-uuid'],
    ['installId', '3f2b8c1e-9a4d-1e6f-8b7a-1c2d3e4f5a6b'], // v1, not v4
    ['installId', '3f2b8c1e-9a4d-4e6f-cb7a-1c2d3e4f5a6b'], // bad variant
    ['installId', `${INSTALL_ID}x`],
    ['installId', 12345],
    ['day', '2026-13-01'],
    ['day', '2026-02-31'],
    ['day', '26-01-01'],
    ['day', '2026-1-1'],
    ['day', utcDay(1)], // future
    ['day', utcDay(-8)], // older than 7 days
    ['day', `${utcDay(-1)}T00:00:00Z`],
    ['day', 20260101],
    ['extVersion', '1.1'],
    ['extVersion', 'v1.1.0'],
    ['extVersion', '1.1.0-beta'],
    ['extVersion', `1.1.${'9'.repeat(40)}`],
    ['extVersion', 110],
    ['vscodeMajor', '1'],
    ['vscodeMajor', '1.104.0'],
    ['vscodeMajor', 1.104],
    ['os', 'windows'],
    ['os', 'Darwin'],
    ['os', ''],
    ['tenure', '90'],
    ['tenure', 0],
    ['tenure', '2-7'],
    ['activation', 'found'],
    ['activation', null],
    ['hasSemanticDir', 'true'],
    ['hasSemanticDir', 1],
    ['domainCount', '11+'],
    ['domainCount', 3],
    ['activations', -1],
    ['activations', 51],
    ['activations', 1.5],
    ['activations', '3'],
    ['activations', Number.NaN],
    ['canvasOpens', 201],
    ['canvasOpens', -1],
    ['canvasOpens', null],
    ['stages', 'logical'],
    ['stages', ['logical', 'conceptual']],
    ['stages', [1]],
    ['stages', { 0: 'logical' }],
    ['schemaFormats', ['v3']],
    ['schemaFormats', null],
    ['modelCount', '0'],
    ['modelCount', 10],
    ['manifest', 'fresh'],
    ['catalog', 'false'],
    ['catalog', 0],
    ['features', []],
    ['features', null],
    ['features', 'physicalStage'],
    ['features', { physicalStage: 101 }],
    ['features', { physicalStage: -1 }],
    ['features', { physicalStage: 1.5 }],
    ['features', { physicalStage: '2' }],
    ['errors', []],
    ['errors', { other: 101 }],
    ['errors', { domainLoad: true }],
  ];
  for (const [field, value] of invalid) {
    it(`400s ${field} = ${JSON.stringify(value) ?? String(value)}`, async () => {
      const { status, env } = await post(heartbeat({ [field]: value }));
      assert.equal(status, 400);
      assert.equal(env.DB.statements.length, 0);
    });
  }
});

describe('validation — acceptance and normalisation', () => {
  it('drops unknown top-level keys', async () => {
    const params = await storedParams(heartbeat({ hostname: 'secret-laptop', ip: '10.0.0.1', extra: { a: 1 } }));
    const flat = JSON.stringify(params);
    assert.ok(!flat.includes('secret-laptop'));
    assert.ok(!flat.includes('10.0.0.1'));
    assert.equal(params.length, 19);
  });

  it('drops unknown feature and error keys, and zero counts', async () => {
    const params = await storedParams(
      heartbeat({
        features: { physicalStage: 2, secretFeature: 5, compare: 0, __proto__: { x: 1 } },
        errors: { manifestMissing: 1, stackTrace: 99, other: 0 },
      }),
    );
    assert.equal(params[17], '{"physicalStage":2}');
    assert.equal(params[18], '{"manifestMissing":1}');
  });

  it('treats omitted features and errors as empty', async () => {
    const body = heartbeat();
    delete body.features;
    delete body.errors;
    const params = await storedParams(body);
    assert.equal(params[17], '{}');
    assert.equal(params[18], '{}');
  });

  it('stores arrays in canonical order with duplicates collapsed', async () => {
    const params = await storedParams(heartbeat({ stages: ['physical', 'logical', 'physical'], schemaFormats: ['v4', 'v5'] }));
    assert.equal(params[12], '["logical","physical"]');
    assert.equal(params[13], '["v5","v4"]');
  });

  it('accepts empty arrays', async () => {
    const params = await storedParams(heartbeat({ stages: [], schemaFormats: [], modelCount: 'none', canvasOpens: 0 }));
    assert.equal(params[12], '[]');
  });

  it('accepts today and exactly 7 days ago', async () => {
    await storedParams(heartbeat({ day: utcDay(0) }));
    await storedParams(heartbeat({ day: utcDay(-7) }));
  });

  it('accepts the boundary values of every integer field', async () => {
    await storedParams(heartbeat({ activations: 0, canvasOpens: 0, features: { compare: 100 }, errors: { other: 100 } }));
    await storedParams(heartbeat({ activations: 50, canvasOpens: 200 }));
  });

  it('lower-cases the install id', async () => {
    const params = await storedParams(heartbeat({ installId: INSTALL_ID.toUpperCase() }));
    assert.equal(params[0], INSTALL_ID);
  });

  it('binds every column in order, with received_day set by the Worker', async () => {
    const params = await storedParams(heartbeat({ catalog: true, hasSemanticDir: false }));
    assert.deepEqual(params, [
      INSTALL_ID,
      utcDay(-1),
      utcDay(0),
      '1.1.0',
      '1.104',
      'darwin',
      '8-30',
      'project_found',
      0,
      '1-3',
      3,
      7,
      '["logical","physical"]',
      '["v5"]',
      '11-50',
      'ok',
      1,
      '{"physicalStage":2,"compare":1}',
      '{"manifestMissing":1}',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe('scheduled retention', () => {
  it('deletes rows received more than 90 days ago', async () => {
    const env = makeEnv();
    const pending = [];
    await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    assert.equal(env.DB.statements.length, 1);
    assert.equal(
      env.DB.statements[0].sql,
      "DELETE FROM heartbeats WHERE received_day < date('now', '-90 days')",
    );
    assert.match(logLines.join('\n'), /"deleted":3/);
  });
});

// ---------------------------------------------------------------------------
// Privacy invariants — checked across everything the run did
// ---------------------------------------------------------------------------

describe('privacy invariants', () => {
  it('never binds an IP, user-agent, country or any header value', () => {
    assert.ok(allStatements.length > 10, 'the run should have stored rows');
    const bound = JSON.stringify(allStatements.map((s) => s.params));
    for (const canary of [CANARY_IP, CANARY_UA, CANARY_COUNTRY, 'application/json', 'evil.example']) {
      assert.ok(!bound.includes(canary), `bound params contain ${canary}`);
    }
  });

  it('logs no payload, header or IP', async () => {
    logLines = [];
    await post(heartbeat());
    await post(heartbeat({ os: 'bogus' }));
    const logs = logLines.join('\n');
    for (const canary of [CANARY_IP, CANARY_UA, CANARY_COUNTRY, INSTALL_ID, 'bogus', 'darwin', '1.104']) {
      assert.ok(!logs.includes(canary), `logs contain ${canary}`);
    }
  });
});
