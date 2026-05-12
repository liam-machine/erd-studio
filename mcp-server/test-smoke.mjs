#!/usr/bin/env node
// Quick smoke test — spawn the server, run a few JSON-RPC calls, print results.

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_PATH = path.resolve(__dirname, '../test/fixtures/dbt-project');
const SERVER = path.resolve(__dirname, 'dist/index.js');

const child = spawn('node', [SERVER], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const pending = new Map();
let nextId = 1;

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
    console.log(`❌ ${label}: ${JSON.stringify(msg.error)}`);
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

  child.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('Smoke test failed:', e);
  child.kill();
  process.exit(1);
});
