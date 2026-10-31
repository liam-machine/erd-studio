#!/usr/bin/env node
// Quick smoke test — spawn the server, run a few JSON-RPC calls, print results.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_PATH = path.resolve(__dirname, '../test/fixtures/dbt-project');
// A logical-only project: .erd-studio/ and no dbt_project.yml.
const LOGICAL_PATH = path.resolve(__dirname, '../test/fixtures/logical-only');
// A project stored as DBML (ERD Studio 2.0): tables, relationships files and diagrams.
const DBML_PATH = path.resolve(__dirname, '../test/fixtures/dbml-native');
const SERVER = path.resolve(__dirname, 'dist/index.js');

// Build a temporary "uninitialized" project — has dbt_project.yml but no .erd-studio/
const UNINIT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-mcp-uninit-'));
fs.writeFileSync(path.join(UNINIT_PATH, 'dbt_project.yml'), "name: 'test_uninit'\nversion: '1.0.0'\n");

const child = spawn('node', [SERVER], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const pending = new Map();
let nextId = 1;
// Set when any check prints ❌ so CI gets a non-zero exit code.
let failed = false;

function fail(message) {
  failed = true;
  console.log(`❌ ${message}`);
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      // notification or partial
    }
  }
});

function rpc(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function summarize(label, msg) {
  if (msg.error) {
    fail(`${label}: ${JSON.stringify(msg.error)}`);
    return false;
  }
  const text = msg.result?.content?.[0]?.text;
  if (text) {
    const parsed = JSON.parse(text);
    console.log(`✅ ${label}`);
    console.log(JSON.stringify(parsed, null, 2).split('\n').slice(0, 15).join('\n'));
    console.log('...');
  } else if (msg.result?.tools) {
    console.log(`✅ ${label}: ${msg.result.tools.length} tools`);
    for (const t of msg.result.tools) console.log(`   • ${t.name}`);
  } else {
    console.log(`✅ ${label}:`, Object.keys(msg.result || {}).join(','));
  }
  return true;
}

async function main() {
  // 1. Initialize
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.1.0' },
  });
  summarize('initialize', init);
  notify('notifications/initialized', {});

  // 2. List tools
  const list = await rpc('tools/list', {});
  summarize('tools/list', list);

  // 3. Call list_domains
  console.log('\n--- list_domains ---');
  const ld = await rpc('tools/call', {
    name: 'list_domains',
    arguments: { project_path: PROJECT_PATH },
  });
  summarize('list_domains', ld);

  // 4. Call read_domain for showcase
  console.log('\n--- read_domain showcase ---');
  const rd = await rpc('tools/call', {
    name: 'read_domain',
    arguments: { project_path: PROJECT_PATH, layer: 'silver', domain: 'showcase' },
  });
  summarize('read_domain', rd);

  // 5. Call list_models
  console.log('\n--- list_models ---');
  const lm = await rpc('tools/call', {
    name: 'list_models',
    arguments: { project_path: PROJECT_PATH },
  });
  summarize('list_models', lm);

  // 6. Call read_model
  console.log('\n--- read_model dim_customer ---');
  const rm = await rpc('tools/call', {
    name: 'read_model',
    arguments: { project_path: PROJECT_PATH, model_name: 'dim_customer' },
  });
  summarize('read_model', rm);

  // 7. Call list_manifest_models
  console.log('\n--- list_manifest_models ---');
  const lmm = await rpc('tools/call', {
    name: 'list_manifest_models',
    arguments: { project_path: PROJECT_PATH, name_contains: 'dim' },
  });
  summarize('list_manifest_models', lmm);

  // 8. Call get_editor_setup
  console.log('\n--- get_editor_setup ---');
  const ges = await rpc('tools/call', {
    name: 'get_editor_setup',
    arguments: {},
  });
  if (ges.result?.content?.[0]?.text?.includes('marketplace.visualstudio.com')) {
    console.log('✅ get_editor_setup returns marketplace link');
  } else {
    fail('get_editor_setup missing marketplace link');
    console.log(ges);
  }

  // 9. Verify graceful "not initialized" tip on uninitialized project
  console.log('\n--- list_domains on UNINITIALIZED project ---');
  const uninit = await rpc('tools/call', {
    name: 'list_domains',
    arguments: { project_path: UNINIT_PATH },
  });
  const uninitText = uninit.result?.content?.[0]?.text || '';
  if (uninitText.includes('tip') && uninitText.includes('marketplace.visualstudio.com')) {
    console.log('✅ uninitialized project returns tip pointing to extension');
  } else {
    fail('uninitialized fallback missing tip');
    console.log(uninitText.slice(0, 300));
  }

  // 10. A logical-only folder (no dbt_project.yml) opens; the manifest lists nothing
  console.log('\n--- logical-only project ---');
  const lom = await rpc('tools/call', {
    name: 'list_models',
    arguments: { project_path: LOGICAL_PATH },
  });
  const lomText = lom.result?.content?.[0]?.text || '';
  if (!lom.result?.isError && lomText.includes('customer')) {
    console.log('✅ list_models reads a logical-only project');
  } else {
    fail('list_models on a logical-only project');
    console.log(lomText.slice(0, 300));
  }
  const lomm = await rpc('tools/call', {
    name: 'list_manifest_models',
    arguments: { project_path: LOGICAL_PATH },
  });
  const lommText = lomm.result?.content?.[0]?.text || '';
  let lommJson = null;
  try { lommJson = JSON.parse(lommText); } catch { /* reported below */ }
  if (lommJson && lommJson.total === 0 && typeof lommJson.tip === 'string') {
    console.log('✅ list_manifest_models on a logical-only project lists nothing, with a tip');
  } else {
    fail('list_manifest_models on a logical-only project');
    console.log(lommText.slice(0, 300));
  }

  // 11. Native DBML storage: diagrams, relationships and tables read from .dbml files
  console.log('\n--- DBML project (test/fixtures/dbml-native) ---');
  const parsed = (msg) => {
    try { return msg.error || msg.result?.isError ? null : JSON.parse(msg.result?.content?.[0]?.text ?? ''); } catch { return null; }
  };
  const check = (ok, label, detail) => {
    if (ok) { console.log(`✅ ${label}`); } else { fail(label); if (detail !== undefined) console.log(JSON.stringify(detail, null, 2).slice(0, 600)); }
  };
  const dld = parsed(await rpc('tools/call', { name: 'list_domains', arguments: { project_path: DBML_PATH } }));
  check(
    dld && dld.count === 2 && dld.domains.every((d) => d.file_format === 'dbml' && d.file_path.endsWith('.dbml'))
      && dld.domains.map((d) => `${d.layer}/${d.domain}`).sort().join(',') === 'gold/sales,silver/staging',
    'list_domains lists both DBML diagrams with file_format dbml', dld,
  );
  const drd = parsed(await rpc('tools/call', { name: 'read_domain', arguments: { project_path: DBML_PATH, layer: 'gold', domain: 'sales' } }));
  const rels = drd?.relationships ?? [];
  const has = (pred) => rels.some(pred);
  check(drd && drd.file_format === 'dbml' && drd.models.length === 6, 'read_domain reads the DBML diagram with its six tables', drd && { file_format: drd.file_format, models: drd.models.map((m) => m.name) });
  check(
    rels.filter((r) => r.from_model === 'fct_order' && r.to_model === 'dim_region').map((r) => r.from_column).sort().join(',') === 'country_code,region_code',
    'read_domain: the composite foreign key, one entry per column pair', rels,
  );
  check(has((r) => r.from_model === 'fct_order' && r.from_column === 'ship_date_key' && r.role === 'ship date'), 'read_domain: a role (ship date)', rels);
  check(has((r) => r.cardinality === 'one-to-one' && r.from_model === 'customer_profile' && r.to_model === 'dim_customer'), 'read_domain: a one-to-one, foreign key on customer_profile', rels);
  check(has((r) => r.from_model === 'dim_customer' && r.to_model === 'dim_customer' && r.role === 'parent'), 'read_domain: a self-reference', rels);
  check(has((r) => r.cardinality === 'many-to-many'), 'read_domain: a many-to-many', rels);
  const missing = await rpc('tools/call', { name: 'read_domain', arguments: { project_path: DBML_PATH, layer: 'gold', domain: 'nope' } });
  const missingText = missing.result?.content?.[0]?.text ?? missing.error?.message ?? '';
  check(missingText.includes("without .dbml or .json"), 'read_domain names the file name rule when a diagram is not found', missingText);
  const dlm = parsed(await rpc('tools/call', { name: 'list_models', arguments: { project_path: DBML_PATH } }));
  check(dlm && dlm.count === 6 && dlm.models.every((m) => m.file_format === 'dbml'), 'list_models lists the six DBML tables with file_format dbml', dlm);
  const drm = parsed(await rpc('tools/call', { name: 'read_model', arguments: { project_path: DBML_PATH, model_name: 'fct_order' } }));
  check(
    drm && drm.grain === 'One row per order line' && drm.model_role === 'transaction-fact' && drm.alias === 'orders'
      && drm.columns.some((c) => c.name === 'order_number' && c.is_natural_key) && drm.columns.some((c) => c.name === 'order_line_id' && c.is_primary_key),
    'read_model reads a DBML table file (grain, role, alias, keys)', drm,
  );

  // Cleanup
  fs.rmSync(UNINIT_PATH, { recursive: true, force: true });
  child.kill();
  if (failed) {
    console.error('\nSmoke test: one or more checks failed');
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Smoke test failed:', e);
  child.kill();
  process.exit(1);
});
