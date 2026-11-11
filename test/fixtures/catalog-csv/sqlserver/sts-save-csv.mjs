#!/usr/bin/env node
// Runs a query through Microsoft SqlToolsService (the service the VS Code mssql extension runs) and saves the
// result with its own "Save as CSV" request (query/saveCsv), with the extension's default CSV settings:
// headers, comma, double quote, UTF-8, no line separator sent (so the service writes the platform's).
// Those are the parameters mssql 1.47.0's getConfigForCsv() sends at its defaults (its package.json
// mssql.saveAsCsv.*: includeHeaders true, delimiter ",", lineSeparator null, textIdentifier '"', encoding
// "utf-8"); its Save as CSV button sends them as query/saveCsv (resultsSerializer.ts, sendRequestToService).
//
// node sts-save-csv.mjs --service <MicrosoftSqlToolsServiceLayer> --server <host,port> --database <db>
//   --user <login> --password-env <VAR> --query-file <query.sql> --out <file.csv>
//   [--script-out <file.sql>] [--log <file>]
// Exits non-zero, with the service's own error, when connecting, the query, the save or the script fails.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
for (const k of ['service', 'server', 'database', 'user', 'password-env', 'query-file', 'out']) if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
const password = process.env[args['password-env']] ?? '';
const query = readFileSync(args['query-file'], 'utf-8');
const out = resolve(args.out);
const ownerUri = 'untitled:erd-studio-catalog-probe';
const log = (m) => { process.stderr.write(`[sts] ${m}\n`); if (args.log) writeFileSync(args.log, `${m}\n`, { flag: 'a' }); };

const child = spawn(args.service, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
const waiters = [];
const queryErrors = []; // SQL Server's own error text, as the Messages pane shows it
let closing = false; // after shutdown the service may exit before it answers
const send = (msg) => { const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf-8'); child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); child.stdin.write(body); };
const request = (method, params) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej, method }); send({ id, method, params }); });
const notification = (method, match = () => true, ms = 120_000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timed out waiting for ${method}`)), ms);
  waiters.push({ method, match, res: (p) => { clearTimeout(t); res(p); } });
});
child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString())?.[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString('utf-8'));
    buf = buf.subarray(sep + 4 + len);
    if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(`${p.method}: ${JSON.stringify(msg.error)}`)) : p.res(msg.result);
    } else if (msg.method && msg.id !== undefined) {
      send({ id: msg.id, result: null }); // a request from the service (none expected): acknowledge
    } else if (msg.method) {
      if (msg.method === 'window/logMessage' || msg.method.startsWith('telemetry/') || msg.method === 'scripting/scriptProgressNotification') continue;
      log(`<- ${msg.method}`);
      if (msg.method === 'query/message' && msg.params?.message?.isError) queryErrors.push(msg.params.message.message);
      const i = waiters.findIndex((w) => w.method === msg.method && w.match(msg.params));
      if (i >= 0) waiters.splice(i, 1)[0].res(msg.params);
    }
  }
});
child.on('exit', (code) => { if (!closing && (pending.size || waiters.length)) { console.error(`service exited (${code}) with requests pending`); process.exit(1); } });

try {
  await request('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  send({ method: 'initialized', params: {} });
  const connected = notification('connection/complete', (p) => p.ownerUri === ownerUri);
  await request('connection/connect', {
    ownerUri,
    connection: { options: {
      server: args.server, database: args.database, user: args.user, password, authenticationType: 'SqlLogin',
      encrypt: 'Mandatory', trustServerCertificate: true, applicationName: 'erd-studio-catalog-probe',
    } },
  });
  const c = await connected;
  if (!c.connectionId) throw new Error(`connection failed: ${c.messages ?? c.errorMessage ?? JSON.stringify(c)}`);
  log(`connected: ${c.serverInfo?.serverVersion ?? ''} ${c.serverInfo?.serverEdition ?? ''}`);
  const done = notification('query/complete', (p) => p.ownerUri === ownerUri, 600_000);
  await request('query/executeString', { ownerUri, query });
  const complete = await done;
  const batch = complete.batchSummaries?.[0];
  if (!batch || batch.hasError) throw new Error(`query failed: ${queryErrors.join(' | ') || JSON.stringify(complete.batchSummaries)}`);
  const rs = batch.resultSetSummaries?.[0];
  log(`rows: ${rs?.rowCount}, columns: ${rs?.columnInfo?.length}`);
  // VS Code's Save as CSV of the whole result: no selection, the extension's defaults (package.json mssql.saveAsCsv.*).
  const saved = await request('query/saveCsv', { ownerUri, filePath: out, batchIndex: 0, resultSetIndex: 0, includeHeaders: true, delimiter: ',', textIdentifier: '"', encoding: 'utf-8' });
  if (saved?.messages) throw new Error(`query/saveCsv failed: ${saved.messages}`); // what the extension shows as "Failed to save results"
  log(`saved ${out}`);
  if (args['script-out']) {
    // The SMO scripting behind the extension's "Script as Create" and SSMS's Generate Scripts, for every schema,
    // table, view and alias type in one file (schema only, keys, indexes, defaults, checks, extended properties).
    // The service writes it as UTF-16 with a byte order mark, as SSMS's "Unicode text" default does.
    const major = Number(String(c.serverInfo?.serverMajorVersion ?? 16));
    const scriptDone = notification('scripting/scriptComplete', () => true, 600_000);
    await request('scripting/script', {
      filePath: resolve(args['script-out']), scriptDestination: 'ToSingleFile', ownerURI: ownerUri, operation: 1,
      includeTypes: ['Schema', 'Table', 'View', 'UserDefinedDataType'], excludeSchemas: ['sys', 'INFORMATION_SCHEMA'],
      scriptOptions: {
        scriptCreateDrop: 'ScriptCreate', typeOfDataToScript: 'SchemaOnly', scriptStatistics: 'ScriptStatsNone',
        targetDatabaseEngineEdition: 'SqlServerEnterpriseEdition', targetDatabaseEngineType: 'SingleInstance',
        scriptCompatibilityOption: `Script${major}0Compat`, scriptExtendedProperties: true, scriptIndexes: true,
        uniqueKeys: true, scriptForeignKeys: true, scriptPrimaryKeys: true, scriptCheckConstraints: true, default: true,
      },
      returnScriptAsynchronously: false,
    });
    const end = await scriptDone;
    if (end?.hasError) throw new Error(`scripting failed: ${end.errorMessage} ${end.errorDetails ?? ''}`);
    log(`scripted: saved ${args['script-out']}`);
  }
  closing = true;
  await request('connection/disconnect', { ownerUri }).catch(() => {});
  send({ id: nextId++, method: 'shutdown', params: null }); // the service exits without answering it
  send({ method: 'exit' });
  process.exit(0);
} catch (e) {
  console.error(String(e?.message ?? e));
  child.kill();
  process.exit(1);
}
