#!/usr/bin/env node
/**
 * Scores ERD Studio's imports against the import corpus, end to end:
 *
 *   1. fetch.mjs      — download the pinned schemas into the cache, checksums verified
 *   2. count_source.py — count each source without ERD Studio (python3 -I, sqlglot + PyYAML)
 *   3. test/unit/importCorpus.score.test.ts — import each schema the way the extension does,
 *      one vitest process per schema (a hang or crash costs that schema only)
 *   4. report.mjs     — the score table and the failure classes
 *
 *   node scripts/corpus/score.mjs [--cache DIR] [--only a,b] [--jobs 4] [--no-fetch] [--no-count]
 *                                 [--python python3] [--timeout-min 15] [--out DIR]
 *
 * Writes <out>/score-table.md, <out>/failure-classes.md and <out>/scores.json
 * (default out: <cache>/report). Needs `pip install -r scripts/corpus/requirements.txt`
 * for the Python counter.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const flag = (name) => argv.includes(name);

const cache = resolve(arg('--cache', process.env.IMPORT_CORPUS_DIR ?? join(repoRoot, '.cache', 'import-corpus')));
const out = resolve(arg('--out', join(cache, 'report')));
const jobs = Number(arg('--jobs', '3'));
const timeoutMs = Number(arg('--timeout-min', '15')) * 60_000;
const python = arg('--python', process.env.IMPORT_CORPUS_PYTHON ?? 'python3');
const onlyArg = arg('--only', process.env.IMPORT_CORPUS_ONLY ?? '');
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const only = new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean));
const names = manifest.schemas.map((s) => s.name).filter((n) => only.size === 0 || only.has(n));

function run(cmd, args, opts = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? repoRoot, env: { ...process.env, ...(opts.env ?? {}) }, stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    if (opts.quiet) {
      child.stdout.on('data', (d) => { output += d; });
      child.stderr.on('data', (d) => { output += d; });
    }
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs) : undefined;
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolveRun({ code, timedOut, output }); });
  });
}

const t0 = Date.now();
if (!flag('--no-fetch')) {
  const r = await run(process.execPath, [join(here, 'fetch.mjs'), '--cache', cache, ...(only.size ? ['--only', [...only].join(',')] : [])]);
  if (r.code !== 0) { console.error('fetch failed'); process.exit(1); }
}
if (!flag('--no-count')) {
  // -I: isolated mode, so nothing in the cache or the current folder can shadow a module. Run from the scripts folder, never the cache.
  const r = await run(python, ['-I', join(here, 'count_source.py'), '--cache', cache, ...(only.size ? ['--only', [...only].join(',')] : [])], { cwd: here });
  if (r.code !== 0) console.error('count_source.py reported failures (see above); those schemas are scored without truth.');
}

const resultsDir = join(cache, 'results');
mkdirSync(resultsDir, { recursive: true });
for (const n of names) rmSync(join(resultsDir, `${n}.json`), { force: true });

const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
let next = 0; let done = 0;
await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
  while (next < names.length) {
    const name = names[next++];
    const started = Date.now();
    const r = await run(process.execPath, [vitest, 'run', 'test/unit/importCorpus.score.test.ts'], {
      env: { IMPORT_CORPUS_DIR: cache, IMPORT_CORPUS_ONLY: name, NODE_OPTIONS: '--max-old-space-size=6144' },
      quiet: true, timeoutMs,
    });
    const file = join(resultsDir, `${name}.json`);
    if (!existsSync(file)) {
      const status = r.timedOut ? 'timed out' : 'crashed';
      const tail = r.output.split('\n').filter((l) => /Error|error|heap/.test(l)).slice(-3).join(' | ').slice(0, 300);
      writeFileSync(file, JSON.stringify({ name, status, ms: Date.now() - started, error: tail }, null, 1));
    }
    done++;
    const res = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`[${done}/${names.length}] ${name}: ${res.status}${res.score ? ` ${res.score.verdict}` : ''} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  }
}));

// The report covers every schema with a result, so an --only run updates its rows and keeps the rest.
const report = buildReport({ manifest, cache, names: manifest.schemas.map((s) => s.name) });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'score-table.md'), report.table + '\n');
writeFileSync(join(out, 'failure-classes.md'), report.classesTable + '\n');
writeFileSync(join(out, 'scores.json'), JSON.stringify(report.json, null, 1) + '\n');
console.log('\n' + report.table + '\n\n' + report.classesTable);
console.log(`\nWritten to ${out} in ${Math.round((Date.now() - t0) / 1000)} s.`);
