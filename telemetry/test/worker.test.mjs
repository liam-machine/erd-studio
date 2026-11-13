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

import { readFileSync } from 'node:fs';

import worker from '../src/index.js';

/** The Worker's FEATURES list, read from its source (it is not exported). */
const WORKER_FEATURES = [
  ...(/const FEATURES = \[([\s\S]*?)\];/.exec(readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'))?.[1] ?? '')
    .matchAll(/'([A-Za-z0-9]+)'/g),
].map((m) => m[1]);

/** The Worker's ERROR_CODES list, read the same way. */
const WORKER_ERROR_CODES = [
  ...(/const ERROR_CODES = \[([\s\S]*?)\];/.exec(readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'))?.[1] ?? '')
    .matchAll(/'([A-Za-z0-9]+)'/g),
].map((m) => m[1]);

/** The Worker's PHYSICAL_TOOLS list, read the same way. */
const WORKER_PHYSICAL_TOOLS = [
  ...(/const PHYSICAL_TOOLS = \[([\s\S]*?)\];/.exec(readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'))?.[1] ?? '')
    .matchAll(/'([A-Za-z0-9]+)'/g),
].map((m) => m[1]);

/** The Worker's PLATFORMS list, read the same way. */
const WORKER_PLATFORMS = [
  ...(/const PLATFORMS = \[([\s\S]*?)\];/.exec(readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'))?.[1] ?? '')
    .matchAll(/'([A-Za-z0-9]+)'/g),
].map((m) => m[1]);

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

/**
 * An in-memory stand-in for the D1 binding that records every statement:
 * `worker_daily` ledger statements in `ledger`, everything else in
 * `statements`. `fail` fails every statement, `failLedger` only the ledger's.
 */
function fakeD1({ fail = false, failLedger = false } = {}) {
  const statements = [];
  const ledger = [];
  return {
    statements,
    ledger,
    prepare(sql) {
      const statement = { sql, params: [] };
      const isLedger = /worker_daily/.test(sql);
      return {
        bind(...values) {
          statement.params = values;
          return this;
        },
        async run() {
          if (fail || (failLedger && isLedger)) throw new Error(`D1_ERROR: boom ${CANARY_IP}`);
          (isLedger ? ledger : statements).push(statement);
          allStatements.push(statement);
          return { meta: { changes: 3 } };
        },
      };
    },
  };
}

/** A Workers `ctx` whose `waitUntil` promises can be awaited with `settle()`. */
function makeCtx() {
  const pending = [];
  return {
    pending,
    waitUntil(promise) {
      pending.push(promise);
    },
    settle() {
      return Promise.all(pending);
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

/** Calls the Worker the way the runtime does, then waits for its `waitUntil` work (the ledger). */
async function call(request, env = makeEnv(), ctx = makeCtx()) {
  const response = await worker.fetch(request, env, ctx);
  await ctx.settle();
  return response;
}

/** The one ledger row a request wrote, as `{ day, family, outcome, reason, features, errors, trail }`. */
function ledgerRow(env) {
  assert.equal(env.DB.ledger.length, 1, 'one ledger upsert per heartbeat request');
  const [day, family, outcome, reason, features, errors, trail] = env.DB.ledger[0].params;
  return { day, family, outcome, reason, features, errors, trail };
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
  it('accepts a body of exactly 32768 bytes', async () => {
    const base = JSON.stringify(heartbeat());
    // Pad with an unknown key (dropped) to hit the cap exactly.
    const padding = 32768 - base.length - ',"pad":""'.length;
    const body = base.slice(0, -1) + `,"pad":"${'x'.repeat(padding)}"}`;
    assert.equal(new TextEncoder().encode(body).byteLength, 32768);
    assert.equal((await post(body)).status, 204);
  });

  it('413s a body of 32769 bytes', async () => {
    const base = JSON.stringify(heartbeat());
    const padding = 32769 - base.length - ',"pad":""'.length;
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
    const response = await call(streamingRequest(['{"v":1,"pad":"', 'x'.repeat(33000), '"}']), env);
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
    ['day', utcDay(2)], // future
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
  it('accepts tomorrow only within an hour of our midnight (a fast clock\'s interim copy)', async () => {
    const realNow = Date.now;
    try {
      const midnight = Date.parse(`${utcDay(1)}T00:00:00Z`);
      Date.now = () => midnight - 10 * 60_000; // 23:50 UTC
      assert.equal((await post(heartbeat({ day: utcDay(1) }))).status, 204);
      Date.now = () => midnight - 3 * 3_600_000; // 21:00 UTC
      const { status, env } = await post(heartbeat({ day: utcDay(1) }));
      assert.equal(status, 400);
      assert.equal(env.DB.statements.length, 0);
    } finally {
      Date.now = realNow;
    }
  });

  it('drops unknown top-level keys', async () => {
    const params = await storedParams(heartbeat({ hostname: 'secret-laptop', ip: '10.0.0.1', extra: { a: 1 } }));
    const flat = JSON.stringify(params);
    assert.ok(!flat.includes('secret-laptop'));
    assert.ok(!flat.includes('10.0.0.1'));
    assert.equal(params.length, 32);
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

  it('keeps the onboarding feature keys', async () => {
    const params = await storedParams(
      heartbeat({ features: { drawFromDbt: 1, addFromDbt: 3, emptyCanvas: 2 } }),
    );
    assert.equal(params[17], '{"drawFromDbt":1,"addFromDbt":3,"emptyCanvas":2}');
  });

  it('keeps the logical-only feature keys', async () => {
    const params = await storedParams(
      heartbeat({ features: { logicalOnlyProject: 1, exampleDiagram: 2, blankDiagram: 3 } }),
    );
    assert.equal(params[17], '{"logicalOnlyProject":1,"exampleDiagram":2,"blankDiagram":3}');
  });

  it('keeps the native DBML storage keys', async () => {
    const params = await storedParams(
      heartbeat({
        features: { dbmlProject: 1, convertToDbml: 1, convertToDbmlOffered: 2, convertToDbmlDeclined: 1, convertToDbmlNotNow: 1, convertToDbmlCancelled: 1, convertToDbmlRefused: 1, dbmlForeignFormatWarned: 1 },
        errors: { modelFileDbmlSyntax: 1, modelFileDbmlInvalid: 2, modelFileDbmlStructure: 3, domainLoadDbml: 4, convertToDbmlFailed: 5 },
      }),
    );
    assert.equal(
      params[17],
      '{"dbmlProject":1,"convertToDbml":1,"convertToDbmlOffered":2,"convertToDbmlDeclined":1,"convertToDbmlNotNow":1,"convertToDbmlCancelled":1,"convertToDbmlRefused":1,"dbmlForeignFormatWarned":1}',
    );
    assert.equal(params[18], '{"modelFileDbmlSyntax":1,"modelFileDbmlInvalid":2,"modelFileDbmlStructure":3,"domainLoadDbml":4,"convertToDbmlFailed":5}');
  });

  it('keeps the import outcome keys (importer, SQL dialect, ledger cause), and drops a look-alike', async () => {
    const params = await storedParams(
      heartbeat({
        features: {
          importOutcomeSqlDdlPartial: 2,
          importSqlOutcomeSnowflakePartial: 2,
          importCauseGrammarGap: 1,
          importOutcomeDbtTimedOut: 1,
          importCauseOther: 1,
          importOutcomeSqlDdlFailed: 3,
          importCauseDimCustomer: 1,
        },
      }),
    );
    assert.equal(
      params[17],
      // In the allowlist's order, not the body's.
      '{"importOutcomeSqlDdlPartial":2,"importOutcomeDbtTimedOut":1,"importSqlOutcomeSnowflakePartial":2,"importCauseGrammarGap":1,"importCauseOther":1}',
    );
  });

  it('keeps what a failed layout was like (class, size bucket, duration, fallbacks), and drops a look-alike or a raw count', async () => {
    const errors = {
      layoutFailed: 2, firstLayoutFailed: 1, draftLayoutFailed: 1, layoutFailedStack: 1,
      layoutFailedMemory: 1, layoutFailedUnsupported: 1, layoutFailedInput: 1, layoutFailedEngine: 1, layoutFailedResult: 1, layoutFailedOther: 1,
      layoutFailedTablesUnder50: 1, layoutFailedTables50to199: 1, layoutFailedTables200to499: 1, layoutFailedTables500Plus: 1,
      layoutFailedRelsUnder100: 1, layoutFailedRels100to499: 1, layoutFailedRels500to1999: 1, layoutFailedRels2000Plus: 1,
      layoutFailedUnder1s: 1, layoutFailed1to5s: 1, layoutFailedOver5s: 1,
      layoutFailedAllRungs: 1, layoutFailedLastRungTimeout: 1, layoutFailedLastRungWorker: 1, layoutFailedLastRungMemory: 1,
    };
    const params = await storedParams(
      heartbeat({
        features: { layoutFallbackRung2: 1, layoutFallbackRung3: 2, layoutFallbackRung4: 1 },
        errors: { ...errors, layoutFailedTables1100: 1, layoutFailedTables: 1134, layoutFailedLastRungStack: 1 },
      }),
    );
    assert.deepEqual(JSON.parse(params[17]), { layoutFallbackRung2: 1, layoutFallbackRung3: 2 });
    assert.deepEqual(JSON.parse(params[18]), errors);
  });

  it('keeps why the dbt project search failed and whether the walk found it (#304), and drops a look-alike or a key on the wrong side', async () => {
    const errors = { dbtSearchFailed: 3, dbtSearchFailedRejected: 1, dbtSearchFailedSort: 1, dbtSearchFailedThrew: 1 };
    const params = await storedParams(
      heartbeat({
        // The reasons are errors and WalkFound a feature: each sent on the other side is dropped.
        features: { dbtSearchFailedWalkFound: 2, dbtSearchFailedRejected: 1, dbtSearchFailedWalk: 1 },
        errors: { ...errors, dbtSearchFailedWalkFound: 1, dbtSearchFailedTimeout: 1, dbtSearchFailedSorted: 1 },
      }),
    );
    assert.deepEqual(JSON.parse(params[17]), { dbtSearchFailedWalkFound: 2 });
    assert.deepEqual(JSON.parse(params[18]), errors);
  });

  it('keeps the automatic draft\'s time-limit drop key, after the import outcome keys', async () => {
    const params = await storedParams(heartbeat({ features: { draftDropTimeLimit: 1, importCauseTimeLimit: 1, draftDropTimeLimits: 1 } }));
    assert.equal(params[17], '{"importCauseTimeLimit":1,"draftDropTimeLimit":1}');
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
      // The 1.6.3 fields, absent from an older client's body, are stored NULL.
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      // So are the physical tooling fields (migrations/0003).
      null,
      null,
      // And the onboarding trail (migrations/0004).
      null,
      null,
      // And use per diagram (migrations/0006).
      null,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Optional fields (extension 1.6.3+)
// ---------------------------------------------------------------------------

const NEW_FIELDS = {
  host: 'cursor',
  remote: 'wsl',
  dev: false,
  assistants: ['gemini', 'claude', 'claude'],
  harnesses: ['agents', 'claude'],
  activeDays28: '4-7',
  canvasDays28: '2-3',
  firstCanvas: '0',
};

describe('optional 1.6.3 fields', () => {
  it('binds them after errors, arrays in canonical order', async () => {
    const params = await storedParams(heartbeat(NEW_FIELDS));
    assert.deepEqual(params.slice(19, 27), ['cursor', 'wsl', 0, '["claude","gemini"]', '["claude","agents"]', '4-7', '2-3', '0']);
  });

  it('stores dev as 1 and accepts empty arrays and never', async () => {
    const params = await storedParams(heartbeat({ ...NEW_FIELDS, dev: true, assistants: [], harnesses: [], firstCanvas: 'never' }));
    assert.deepEqual(params.slice(19, 27), ['cursor', 'wsl', 1, '[]', '[]', '4-7', '2-3', 'never']);
  });

  for (const [field, value] of [
    ['host', 'Visual Studio Code'],
    ['host', 'notepad'],
    ['remote', 'ssh-remote'],
    ['dev', 'yes'],
    ['assistants', ['claude', 'chatgpt']],
    ['assistants', 'claude'],
    ['harnesses', ['cursor']],
    ['activeDays28', '29'],
    ['canvasDays28', 3],
    ['firstCanvas', 'later'],
  ]) {
    it(`refuses ${field} = ${JSON.stringify(value)} with 400 and no write`, async () => {
      const env = makeEnv();
      const response = await post(heartbeat({ ...NEW_FIELDS, [field]: value }), env);
      assert.equal(response.status, 400);
      assert.equal(env.DB.statements.length, 0);
    });
  }

  it('accepts a body carrying every feature key at once', async () => {
    const features = Object.fromEntries(WORKER_FEATURES.map((key) => [key, 100]));
    const env = makeEnv();
    const response = await post(heartbeat({ ...NEW_FIELDS, features }), env);
    assert.equal(response.status, 204);
  });

  it('accepts a body carrying every feature and every error key at once, and stores them all', async () => {
    const features = Object.fromEntries(WORKER_FEATURES.map((key) => [key, 100]));
    const errors = Object.fromEntries(WORKER_ERROR_CODES.map((key) => [key, 100]));
    const env = makeEnv();
    const response = await post(heartbeat({ ...NEW_FIELDS, features, errors }), env);
    assert.equal(response.status, 204);
    const params = env.DB.statements[0].params;
    assert.deepEqual(Object.keys(JSON.parse(params[17])), WORKER_FEATURES);
    assert.deepEqual(Object.keys(JSON.parse(params[18])), WORKER_ERROR_CODES);
  });
});

// ---------------------------------------------------------------------------
// Physical tooling (migrations/0003)
// ---------------------------------------------------------------------------

describe('optional physical tooling fields', () => {
  it('binds them last, in canonical order and without duplicates', async () => {
    const params = await storedParams(heartbeat({
      ...NEW_FIELDS,
      physicalTools: ['notebooks', 'dbt', 'fabric', 'dbt'],
      platforms: ['snowflake', 'databricks'],
    }));
    assert.deepEqual(params.slice(27, 29), ['["dbt","fabric","notebooks"]', '["databricks","snowflake"]']);
  });

  it('stores [] (looked, found nothing) apart from NULL (did not look)', async () => {
    assert.deepEqual((await storedParams(heartbeat({ physicalTools: [], platforms: [] }))).slice(27, 29), ['[]', '[]']);
    assert.deepEqual((await storedParams(heartbeat({}))).slice(27, 29), [null, null]);
  });

  it('accepts every value at once', async () => {
    const params = await storedParams(heartbeat({ physicalTools: WORKER_PHYSICAL_TOOLS, platforms: WORKER_PLATFORMS }));
    assert.deepEqual(JSON.parse(params[27]), WORKER_PHYSICAL_TOOLS);
    assert.deepEqual(JSON.parse(params[28]), WORKER_PLATFORMS);
  });

  for (const [field, value] of [
    ['physicalTools', ['dbt', 'terraform']],
    ['physicalTools', 'dbt'],
    ['physicalTools', ['src/models/dim_customer.sql']],
    ['platforms', ['Databricks']],
    ['platforms', ['snowflake', 42]],
    ['platforms', { snowflake: true }],
  ]) {
    it(`refuses ${field} = ${JSON.stringify(value)} with 400 and no write`, async () => {
      const env = makeEnv();
      const response = await post(heartbeat({ [field]: value }), env);
      assert.equal(response.status, 400);
      assert.equal(env.DB.statements.length, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// The onboarding trail (migrations/0004)
// ---------------------------------------------------------------------------

describe('the onboarding trail', () => {
  const TRAIL = [
    ['windowOpened', 0, 1, 1],
    ['draftShown', 2, 1, 1],
    ['guideStarted', 0, 1, 1],
    ['guideStepDraftBanner', 1, 1, 1],
    ['windowAway', 34, 1, 1],
    ['windowBack', 3600, 1, 1],
    ['editLayout', 4, 2, 7],
    ['!draftBuildFailed', 0, 1, 1],
    ['layoutFailed', 1, 1, 1],
    ['!layoutFailed', 0, 1, 1],
  ];

  it('stores it in order as JSON, with the dropped count', async () => {
    const params = await storedParams(heartbeat({ trail: TRAIL, trailDropped: 3 }));
    assert.equal(params.length, 32);
    assert.deepEqual(JSON.parse(params[29]), TRAIL);
    assert.equal(params[30], 3);
  });

  it('stores NULL for both when there is no trail, and 0 dropped when it is omitted', async () => {
    assert.deepEqual((await storedParams(heartbeat({}))).slice(29, 31), [null, null]);
    assert.deepEqual((await storedParams(heartbeat({ trail: [] }))).slice(29, 31), ['[]', 0]);
  });

  it('drops an event it does not list (a newer extension\'s) and keeps the order of the rest', async () => {
    const params = await storedParams(heartbeat({ trail: [['windowOpened', 0, 1, 1], ['someFutureEvent', 3, 1, 1], ['!someFutureError', 1, 1, 1], ['!compare', 1, 1, 1], ['canvasOpened', 5, 1, 1]] }));
    assert.deepEqual(JSON.parse(params[29]), [['windowOpened', 0, 1, 1], ['canvasOpened', 5, 1, 1]]);
  });

  it('accepts 100 entries and every marker', async () => {
    const markers = ['windowOpened', 'windowClosed', 'windowAway', 'windowBack', 'canvasOpened', 'canvasClosed', 'canvasHidden', 'canvasShown'];
    const trail = Array.from({ length: 100 }, (_, i) => [markers[i % markers.length], i % 3600, 1 + (i % 20), 1 + (i % 100)]);
    const params = await storedParams(heartbeat({ trail, trailDropped: 10000 }));
    assert.equal(JSON.parse(params[29]).length, 100);
  });

  for (const [what, body] of [
    ['a trail that is not an array', { trail: { windowOpened: 1 } }],
    ['101 entries', { trail: Array.from({ length: 101 }, () => ['windowOpened', 0, 1, 1]) }],
    ['an entry of three values', { trail: [['windowOpened', 0, 1]] }],
    ['a path as the event', { trail: [['/Users/jane/acme/dim_customer.sql', 0, 1, 1]] }],
    ['a table name with a dot as the event', { trail: [['sales.dim_customer', 0, 1, 1]] }],
    ['two bangs before an event', { trail: [['!!draftBuildFailed', 0, 1, 1]] }],
    ['a gap over an hour', { trail: [['windowOpened', 3601, 1, 1]] }],
    ['a negative gap', { trail: [['windowOpened', -1, 1, 1]] }],
    ['a fractional gap', { trail: [['windowOpened', 1.5, 1, 1]] }],
    ['window 0', { trail: [['windowOpened', 0, 0, 1]] }],
    ['window 21', { trail: [['windowOpened', 0, 21, 1]] }],
    ['repeat 0', { trail: [['windowOpened', 0, 1, 0]] }],
    ['repeat 101', { trail: [['windowOpened', 0, 1, 101]] }],
    ['a dropped count without a trail', { trailDropped: 1 }],
    ['a dropped count over the cap', { trail: [], trailDropped: 10001 }],
  ]) {
    it(`refuses ${what} with 400 and no write`, async () => {
      const env = makeEnv();
      const response = await post(heartbeat(body), env);
      assert.equal(response.status, 400);
      assert.equal(env.DB.statements.length, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// Use per diagram (migrations/0006)
// ---------------------------------------------------------------------------

describe('use per diagram', () => {
  it('stores [id, opens, edits] entries as JSON, last', async () => {
    const diagrams = [[41822, 3, 12], [7, 1, 0], [0, 2, 5]];
    const params = await storedParams(heartbeat({ diagrams }));
    assert.equal(params.length, 32);
    assert.deepEqual(JSON.parse(params[31]), diagrams);
  });

  it('stores NULL when the client sends none, and [] for an empty list', async () => {
    assert.equal((await storedParams(heartbeat({})))[31], null);
    assert.equal((await storedParams(heartbeat({ diagrams: [] })))[31], '[]');
  });

  it('accepts 30 diagrams plus the entry for the rest, at every cap', async () => {
    const diagrams = [...Array.from({ length: 30 }, (_, i) => [65535 - i, 200, 1000]), [0, 200, 1000]];
    assert.equal(JSON.parse((await storedParams(heartbeat({ diagrams })))[31]).length, 31);
  });

  for (const [what, diagrams] of [
    ['a list that is not an array', { 7: [1, 0] }],
    ['31 numbered diagrams', Array.from({ length: 31 }, (_, i) => [i + 1, 1, 0])],
    ['an entry of two values', [[7, 1]]],
    ['a name as the id', [['customer-360', 1, 0]]],
    ['a path as the id', [['/Users/jane/acme/.erd-studio/gold/finance.dbml', 1, 0]]],
    ['an id over the cap', [[65536, 1, 0]]],
    ['a negative id', [[-1, 1, 0]]],
    ['a fractional id', [[1.5, 1, 0]]],
    ['the same id twice', [[7, 1, 0], [7, 2, 0]]],
    ['opens over the cap', [[7, 201, 0]]],
    ['edits over the cap', [[7, 1, 1001]]],
    ['a fourth value', [[7, 1, 0, 'finance']]],
  ]) {
    it(`refuses ${what} with 400 and no write`, async () => {
      const env = makeEnv();
      const response = await post(heartbeat({ diagrams }), env);
      assert.equal(response.status, 400);
      assert.equal(env.DB.statements.length, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// Known-fixes registry
// ---------------------------------------------------------------------------

describe('GET /known-fixes', () => {
  const REGISTRY = JSON.parse(readFileSync(new URL('../known-fixes.json', import.meta.url), 'utf8'));

  it('returns the bundled registry as JSON with a short public cache', async () => {
    const env = makeEnv();
    const response = await call(makeRequest(null, { method: 'GET', path: '/known-fixes' }), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=300');
    assert.deepEqual(await response.json(), REGISTRY);
    assert.equal(env.DB.statements.length, 0);
  });

  it('is the same response whatever the query string says', async () => {
    const plain = await call(makeRequest(null, { method: 'GET', path: '/known-fixes' }));
    const queried = await call(makeRequest(null, { method: 'GET', path: '/known-fixes?code=domainLoad&v=1.0.0' }));
    assert.equal(await queried.text(), await plain.text());
  });

  it('answers HEAD with no body', async () => {
    const response = await call(makeRequest(null, { method: 'HEAD', path: '/known-fixes' }));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  });

  it('405s other methods with Allow: GET, HEAD', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const env = makeEnv();
      const response = await call(makeRequest(heartbeat(), { method, path: '/known-fixes' }), env);
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('Allow'), 'GET, HEAD');
      assert.equal(env.DB.statements.length, 0);
    }
  });

  it('404s neighbouring paths', async () => {
    for (const path of ['/known-fixes/', '/known-fixes.json', '/v1/known-fixes']) {
      assert.equal((await call(makeRequest(null, { method: 'GET', path }))).status, 404, path);
    }
  });

  it('logs nothing at all, so how often it is asked is never recorded', async () => {
    logLines = [];
    await call(makeRequest(null, { method: 'GET', path: '/known-fixes?code=domainLoad' }));
    await call(makeRequest(null, { method: 'POST', path: '/known-fixes' }));
    assert.deepEqual(logLines, []);
  });

  it('is behind the kill switch like every other request', async () => {
    const response = await call(makeRequest(null, { method: 'GET', path: '/known-fixes' }), makeEnv({ KILL_SWITCH: 'on' }));
    assert.equal(response.status, 503);
  });
});

// ---------------------------------------------------------------------------
// The worker_daily ledger (migrations/0005)
// ---------------------------------------------------------------------------

describe('the worker_daily ledger', () => {
  it('counts an accepted heartbeat as (family, ok, none) with nothing dropped', async () => {
    const { status, env } = await post(heartbeat({ extVersion: '2.0.3' }));
    assert.equal(status, 204);
    assert.deepEqual(ledgerRow(env), { day: utcDay(0), family: '2.0', outcome: 'ok', reason: 'none', features: 0, errors: 0, trail: 0 });
    assert.match(env.DB.ledger[0].sql, /ON CONFLICT\(day, ext_family, outcome, reason\) DO UPDATE SET\s+n = n \+ 1/);
  });

  it('counts unknown feature and error keys and trail events it dropped, never their names', async () => {
    const { status, env } = await post(heartbeat({
      extVersion: '2.0.0',
      features: { physicalStage: 1, secretFeatureOne: 1, secretFeatureTwo: 3 },
      errors: { manifestMissing: 1, secretError: 1 },
      trail: [['windowOpened', 0, 1, 1], ['secretEvent', 3, 1, 1], ['!secretCode', 4, 1, 1]],
    }));
    assert.equal(status, 204);
    const row = ledgerRow(env);
    assert.equal(row.features, 2);
    assert.equal(row.errors, 1);
    assert.equal(row.trail, 2);
    assert.ok(!JSON.stringify(env.DB.ledger).includes('secret'));
  });

  it('records a bad trail as (2.0, denied, shape_trail) and stores no heartbeat', async () => {
    const { status, env } = await post(heartbeat({ extVersion: '2.0.1', trail: [['windowOpened', -1, 1, 1]] }));
    assert.equal(status, 400);
    assert.equal(env.DB.statements.length, 0);
    assert.deepEqual(ledgerRow(env), { day: utcDay(0), family: '2.0', outcome: 'denied', reason: 'shape_trail', features: 0, errors: 0, trail: 0 });
  });

  for (const [field, value, reason] of [
    ['installId', 'nope', 'shape_installId'],
    ['day', '2020-01-01', 'shape_day'],
    ['os', 'beos', 'shape_os'],
    ['activations', 51, 'shape_counts'],
    ['features', { compare: 101 }, 'shape_features'],
    ['errors', [], 'shape_errors'],
    ['host', 'emacs', 'shape_host'],
    ['harnesses', ['nope'], 'shape_harnesses'],
    ['platforms', ['nope'], 'shape_platforms'],
    ['manifest', 'nope', 'shape_other'],
    ['v', 2, 'shape_other'],
  ]) {
    it(`records ${field} = ${JSON.stringify(value)} as ${reason}`, async () => {
      const { status, env } = await post(heartbeat({ extVersion: '1.9.8', [field]: value }));
      assert.equal(status, 400);
      const row = ledgerRow(env);
      assert.equal(row.reason, reason);
      assert.equal(row.family, '1.9');
      assert.equal(row.outcome, 'denied');
    });
  }

  it('records trailDropped without a trail as shape_trailDropped', async () => {
    const { env } = await post(heartbeat({ trailDropped: 3 }));
    assert.equal(ledgerRow(env).reason, 'shape_trailDropped');
  });

  it('records an oversized body as (other, denied, body_size)', async () => {
    const base = JSON.stringify(heartbeat({ extVersion: '2.0.0' }));
    const body = base.slice(0, -1) + `,"pad":"${'x'.repeat(33000)}"}`;
    const { status, env } = await post(body);
    assert.equal(status, 413);
    const row = ledgerRow(env);
    assert.deepEqual([row.family, row.outcome, row.reason], ['other', 'denied', 'body_size']);
  });

  it('records a body that is not JSON as (other, denied, json)', async () => {
    const { status, env } = await post('{"extVersion":"2.0.0",');
    assert.equal(status, 400);
    const row = ledgerRow(env);
    assert.deepEqual([row.family, row.outcome, row.reason], ['other', 'denied', 'json']);
  });

  for (const [extVersion, family] of [['x', 'other'], ['10.0.0', 'other'], ['2.100.0', 'other'], ['2.10.4', '2.10'], [42, 'other']]) {
    it(`files extVersion ${JSON.stringify(extVersion)} under ${family}`, async () => {
      const { env } = await post(heartbeat({ extVersion }));
      assert.equal(ledgerRow(env).family, family);
    });
  }

  it('writes nothing at all when the kill switch is on', async () => {
    const env = makeEnv({ KILL_SWITCH: 'on' });
    const response = await call(makeRequest(heartbeat()), env);
    assert.equal(response.status, 503);
    assert.equal(env.DB.statements.length, 0);
    assert.equal(env.DB.ledger.length, 0);
  });

  it('writes nothing for 404, 405 or /known-fixes', async () => {
    const env = makeEnv();
    await call(makeRequest(heartbeat(), { path: '/nope' }), env);
    await call(makeRequest(heartbeat(), { method: 'PUT' }), env);
    await call(makeRequest(null, { method: 'GET', path: '/known-fixes' }), env);
    assert.equal(env.DB.ledger.length, 0);
  });

  it('writes no ledger row when the heartbeat upsert itself fails', async () => {
    const env = makeEnv({ DB: fakeD1({ fail: true }) });
    const response = await call(makeRequest(heartbeat()), env);
    assert.equal(response.status, 503);
    assert.equal(env.DB.ledger.length, 0);
  });

  it('keeps a 204 a 204 when the ledger write fails, logging only the error name', async () => {
    logLines = [];
    const env = makeEnv({ DB: fakeD1({ failLedger: true }) });
    const response = await call(makeRequest(heartbeat()), env);
    assert.equal(response.status, 204);
    assert.equal(env.DB.statements.length, 1);
    assert.equal(env.DB.ledger.length, 0);
    assert.match(logLines.join('\n'), /"event":"ledger_error","kind":"Error"/);
    assert.ok(!logLines.join('\n').includes('boom'));
  });

  it('keeps a 400 a 400 when the ledger write fails', async () => {
    const env = makeEnv({ DB: fakeD1({ failLedger: true }) });
    assert.equal((await call(makeRequest(heartbeat({ os: 'beos' })), env)).status, 400);
  });

  it('runs the ledger write through ctx.waitUntil, off the response path', async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const response = await worker.fetch(makeRequest(heartbeat()), env, ctx);
    assert.equal(response.status, 204);
    assert.equal(ctx.pending.length, 1);
    await ctx.settle();
    assert.equal(env.DB.ledger.length, 1);
  });

  it('binds no install id, IP, header or body value', async () => {
    const env = makeEnv();
    await call(makeRequest(heartbeat({ extVersion: '2.0.0' })), env);
    const bound = JSON.stringify(env.DB.ledger.map((st) => st.params));
    for (const canary of [INSTALL_ID, CANARY_IP, CANARY_UA, CANARY_COUNTRY, '2.0.0', 'darwin', '1.104']) {
      assert.ok(!bound.includes(canary), `ledger params contain ${canary}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe('scheduled retention', () => {
  it('deletes rows received more than 90 days ago, and ledger days older than 90 days', async () => {
    const env = makeEnv();
    const pending = [];
    await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    assert.equal(env.DB.statements.length, 1);
    assert.equal(
      env.DB.statements[0].sql,
      "DELETE FROM heartbeats WHERE received_day < date('now', '-90 days')",
    );
    assert.equal(env.DB.ledger.length, 1);
    assert.equal(env.DB.ledger[0].sql, "DELETE FROM worker_daily WHERE day < date('now', '-90 days')");
    assert.match(logLines.join('\n'), /"deleted":3/);
    assert.match(logLines.join('\n'), /"table":"worker_daily","deleted":3/);
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
