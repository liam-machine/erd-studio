/**
 * The AI sync eval: a real headless Claude Code applies a sync plan from the
 * installed SYNC.md, and the result must land where the deterministic applier
 * (`test/unit/syncPlanApply.harness.ts`) lands on the same plan. Opt-in and
 * paid (about US$1 a run): never in CI or `npm test`. Run by
 * `npm run eval:sync-ai` (`run.mjs` bundles this file); the README beside it
 * says when and how.
 *
 * 1. Copy `test/fixtures/dbt-project-dbml` to a short `/tmp` path, install the
 *    AI helper files with the real `HarnessService` (Claude Code target), lay
 *    the harness's scenario over it and write `.sync-plan.json` through the
 *    real provider's Compare + Sync, with the mixed selection
 *    (`syncPlanApply.dbml.test.ts` uses the same one: both sides written).
 * 2. A copy of that project gets the deterministic applier: the expected end.
 * 3. `claude -p` applies the plan in the other copy, from the installed
 *    skill files alone (or, with `--self-check`, the applier again, to prove
 *    the checks themselves pass for free).
 * 4. Checks: doctor reports no DBML error (and no warning the applier's result
 *    lacks); the canvas Compare equals the applier's (only the unselected
 *    items remain, no plan entry left unresolved); every relationships file
 *    holds the same Refs as the applier's (each new Ref in the file SYNC.md
 *    names); the schema yml gained and lost the same dbt tests.
 *
 * Exits 0 when every check passes, 1 when one fails, 2 when the eval could
 * not run. The work folder is kept on failure (and with `--keep`).
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

import { _resetMockWorkspace } from '../../__mocks__/vscode';
import { HarnessService, HARNESS_TARGETS, HARNESS_VERSION } from '../../../src/services/harnessService';
import { allSelections } from '../../../src/services/syncPlanBuilder';
import { runDoctor } from '../../../src/cli/doctor';
import { columnKey, relationshipKey, type GroundTruth, type SyncPlan } from '../../../src/types/syncPlan';
import type { DiscrepancyReport } from '../../../src/types/discrepancy';
import {
  SHOWCASE, applyScenario, applySyncPlan, compare, copyFixture, errorsOf, generatePlan,
} from '../../unit/syncPlanApply.harness';

const PROMPT = 'Apply the ERD Studio sync plan in .erd-studio/.sync-plan.json following .claude/skills/erd-studio/SYNC.md';
const ALLOWED_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash(node *)';

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };

// ---------------------------------------------------------------------------
// The selection (the same as syncPlanApply.dbml.test.ts's `mixed`)
// ---------------------------------------------------------------------------

/** The logical side gets the new table, Refs and types; dbt gets the tests and the keys it lacks. */
function mixed(report: DiscrepancyReport): Record<string, GroundTruth> {
  const rel = relationshipKey;
  const payments = report.models.find((m) => m.name === 'stg_raw_payments');
  if (!payments) throw new Error('the scenario\'s Compare has no stg_raw_payments: the fixture or the scenario changed');
  const physical: string[] = [
    columnKey('dim_customer', 'segment'), columnKey('dim_customer', 'created_at'),
    columnKey('fct_task_event', 'event_date'), columnKey('fct_task_event', 'loaded_at'),
    ...payments.columns.filter((c) => c.status !== 'matched').map((c) => columnKey('stg_raw_payments', c.name)),
    rel('fct_order', 'customer_key', 'dim_customer', 'customer_key'),
    rel('fct_order', 'project_key', 'dim_project', 'project_key'),
    rel('stg_raw_payments', 'order_id', 'fct_order', 'order_id'),
  ];
  const logical: string[] = [
    columnKey('dim_date', 'fiscal_year'), columnKey('dim_date', 'fiscal_quarter'),
    columnKey('fct_task_event', 'customer_key'), columnKey('fct_task_event', 'project_key'), columnKey('dim_project', 'parent_project_key'),
    rel('fct_task_event', 'customer_key', 'dim_customer', 'customer_key'),
    rel('fct_task_event', 'project_key', 'dim_project', 'project_key'),
    rel('dim_project', 'parent_project_key', 'dim_project', 'project_key'),
  ];
  const offered = allSelections(report, 'physical');
  const missing = [...physical, ...logical].filter((k) => !(k in offered));
  if (missing.length > 0) throw new Error(`Compare no longer offers ${missing.join(', ')}: the fixture or the scenario changed`);
  return { ...Object.fromEntries(physical.map((k) => [k, 'physical' as const])), ...Object.fromEntries(logical.map((k) => [k, 'logical' as const])) };
}

// ---------------------------------------------------------------------------
// What the checks read
// ---------------------------------------------------------------------------

const posix = (p: string): string => p.split(path.sep).join('/');

function walk(dir: string, keep: (rel: string) => boolean, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    const rel = posix(path.relative(base, p));
    if (e.isDirectory()) return walk(p, keep, base);
    return keep(rel) ? [rel] : [];
  });
}

/** The comparison's shape: every model's columns and every relationship with its status and cardinalities. */
function shape(report: DiscrepancyReport): { models: Array<{ name: string; status: string; columns: string[] }>; relationships: string[] } {
  const key = (r: { fromModel: string; fromColumn: string; toModel: string; toColumn: string }): string => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}`.toLowerCase();
  return {
    models: report.models.map((m) => ({ name: m.name, status: m.status, columns: m.columns.map((c) => `${c.name}:${c.status}`).sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    relationships: report.relationships.map((r) => `${key(r)}:${r.status}:${r.sourceCardinality ?? ''}/${r.targetCardinality ?? ''}`).sort(),
  };
}

/** Each plan entry the re-opened Compare still reports, as `action model.column` / `action from.col->to.col`. */
function unresolved(plan: SyncPlan, after: DiscrepancyReport): string[] {
  const lc = (s: string): string => s.toLowerCase();
  const left: string[] = [];
  for (const c of plan.columns) {
    const col = after.models.find((m) => lc(m.name) === lc(c.modelName))?.columns.find((x) => lc(x.name) === lc(c.columnName));
    if (col && col.status !== 'matched') left.push(`${c.action} ${c.modelName}.${c.columnName} (${col.status})`);
  }
  for (const r of plan.relationships) {
    const found = after.relationships.find((x) => lc(x.fromModel) === lc(r.fromModel) && lc(x.fromColumn) === lc(r.fromColumn)
      && lc(x.toModel) === lc(r.toModel) && lc(x.toColumn) === lc(r.toColumn));
    if (found && found.status !== 'matched') left.push(`${r.action} ${r.fromModel}.${r.fromColumn}->${r.toModel}.${r.toColumn} (${found.status})`);
  }
  return left.sort();
}

/**
 * Every Ref line of every `.dbml` file under `.erd-studio/`, per file, written
 * one way: names unquoted and lower-cased, a `<` Ref turned round to `>` (so
 * `a >? b` and `b ?< a` are the same Ref), the name and settings dropped.
 */
function refsByFile(root: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const erd = path.join(root, '.erd-studio');
  for (const rel of walk(erd, (r) => r.endsWith('.dbml'))) {
    const refs: string[] = [];
    for (const line of fs.readFileSync(path.join(erd, rel), 'utf-8').split(/\r?\n/)) {
      const m = /^\s*Ref\b[^:{]*:\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      const body = m[1].replace(/\s*\[[^\]]*\]\s*$/, '').replace(/["`]/g, '').toLowerCase();
      const parts = /^(\S+)\s*(\??(?:<>|<|>|-)\??)\s*(\S+)$/.exec(body);
      if (!parts) { refs.push(body.replace(/\s+/g, ' ')); continue; }
      let [, a, op, b] = parts;
      if (op.includes('<') && !op.includes('<>')) {
        [a, b] = [b, a];
        op = [...op].reverse().map((ch) => (ch === '<' ? '>' : ch)).join('');
      }
      refs.push(`${a} ${op} ${b}`);
    }
    if (refs.length > 0) result[`.erd-studio/${rel}`] = refs.sort();
  }
  return result;
}

/** Every test on every column of every schema yml under `models/`: file → `model.column` → the tests as compact JSON. */
function dbtTests(root: string): Record<string, Record<string, string[]>> {
  const result: Record<string, Record<string, string[]>> = {};
  for (const rel of walk(path.join(root, 'models'), (r) => r.endsWith('.yml'))) {
    const doc = parseYaml(fs.readFileSync(path.join(root, 'models', rel), 'utf-8')) as { models?: Array<{ name: string; columns?: Array<Record<string, unknown>> }> } | null;
    const byColumn: Record<string, string[]> = {};
    for (const m of doc?.models ?? []) {
      for (const c of m.columns ?? []) {
        byColumn[`${m.name}.${String(c.name)}`] = [...((c.tests ?? c.data_tests ?? []) as unknown[])].map((t) => JSON.stringify(t)).sort();
      }
    }
    result[`models/${rel}`] = byColumn;
  }
  return result;
}

/** What tests changed between two `dbtTests` snapshots, per `file model.column`. */
function testChanges(before: ReturnType<typeof dbtTests>, after: ReturnType<typeof dbtTests>): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[file] ?? {};
    const a = after[file] ?? {};
    for (const col of new Set([...Object.keys(b), ...Object.keys(a)])) {
      for (const t of a[col] ?? []) if (!(b[col] ?? []).includes(t)) added.push(`${file} ${col} ${t}`);
      for (const t of b[col] ?? []) if (!(a[col] ?? []).includes(t)) removed.push(`${file} ${col} ${t}`);
    }
  }
  return { added: added.sort(), removed: removed.sort() };
}

/** Every project file outside the AI helper's folders, with its hash: what an apply changed. */
function fileHashes(root: string): Map<string, string> {
  const skip = /^(\.claude|\.agents|\.global-storage)\//;
  return new Map(walk(root, (r) => !skip.test(r)).map((r) => [r, crypto.createHash('sha1').update(fs.readFileSync(path.join(root, r))).digest('hex')]));
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const all = new Set([...before.keys(), ...after.keys()]);
  return [...all].filter((f) => before.get(f) !== after.get(f)).map((f) => (after.has(f) ? (before.has(f) ? f : `${f} (new)`) : `${f} (deleted)`)).sort();
}

interface DoctorProblem { file: string; line?: number; code: number | string; severity: 'error' | 'warning'; message: string }

async function dbmlProblems(root: string, home: string): Promise<DoctorProblem[]> {
  const result = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: home });
  return result.erd.dbmlProblems as DoctorProblem[];
}

const problemText = (p: DoctorProblem): string => `${p.severity} ${p.file}${p.line ? `:${p.line}` : ''} ${p.code}: ${p.message}`;

// ---------------------------------------------------------------------------
// The assistant
// ---------------------------------------------------------------------------

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']) {
      const p = path.join(dir, name + ext);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

interface AssistantRun {
  exitCode: number | null;
  timedOut: boolean;
  seconds: number;
  costUsd?: number;
  turns?: number;
  isError?: boolean;
  finalText?: string;
  tools: string[];
  denied: string[];
  stderr: string;
}

/** Run `claude -p` in `cwd`, streaming each tool call as it happens; the raw stream goes to `transcript`. */
function runClaude(bin: string, cwd: string, transcript: string, opts: { maxUsd: string; timeoutMin: number; model?: string }): Promise<AssistantRun> {
  const args = [
    '-p', PROMPT,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ALLOWED_TOOLS,
    '--output-format', 'stream-json', '--verbose',
    // The project's settings only (the hook the helper installs), never this
    // machine's user settings, hooks or MCP servers: the run sees what a
    // fresh assistant in the user's repo sees.
    '--setting-sources', 'project,local',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-budget-usd', opts.maxUsd,
    ...(opts.model ? ['--model', opts.model] : []),
  ];
  const env = { ...process.env };
  // A nested session must not think it runs inside this one.
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(transcript);
    const run: AssistantRun = { exitCode: null, timedOut: false, seconds: 0, tools: [], denied: [], stderr: '' };
    let buffer = '';
    const onLine = (line: string): void => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'assistant') {
        for (const part of event.message?.content ?? []) {
          if (part.type !== 'tool_use') continue;
          const input = part.input ?? {};
          const what = input.file_path ?? input.path ?? input.pattern ?? input.command ?? '';
          const label = `${part.name} ${String(what).split(cwd + path.sep).join('').split(cwd).join('.')}`.trim().slice(0, 160);
          run.tools.push(label);
          out(`    · ${label}`);
        }
      } else if (event.type === 'result') {
        run.costUsd = event.total_cost_usd;
        run.turns = event.num_turns;
        run.isError = event.is_error === true || event.subtype !== 'success';
        run.finalText = typeof event.result === 'string' ? event.result : undefined;
        for (const d of event.permission_denials ?? []) {
          const input = d.tool_input ?? {};
          run.denied.push(`${d.tool_name} ${String(input.command ?? input.file_path ?? '').split(cwd + path.sep).join('').slice(0, 160)}`.trim());
        }
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      log.write(chunk);
      buffer += chunk.toString('utf-8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) { onLine(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
    });
    child.stderr.on('data', (chunk: Buffer) => { run.stderr += chunk.toString('utf-8'); });
    const timer = setTimeout(() => { run.timedOut = true; child.kill('SIGTERM'); }, opts.timeoutMin * 60_000);
    child.on('error', (err) => { run.stderr += String(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      onLine(buffer);
      log.end();
      run.exitCode = code;
      run.seconds = Math.round((Date.now() - started) / 1000);
      resolve(run);
    });
  });
}

// ---------------------------------------------------------------------------
// The eval
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const selfCheck = argv.includes('--self-check');
  const keep = argv.includes('--keep');
  if (argv.includes('--help')) {
    out('npm run eval:sync-ai [-- --self-check] [-- --keep]');
    out('  --self-check  apply with the deterministic applier instead of Claude (free: proves the checks)');
    out('  --keep        keep the work folder after a pass');
    out('Env: CLAUDE_BIN (default: claude on PATH), ERD_EVAL_MODEL, ERD_EVAL_MAX_USD (default 5), ERD_EVAL_TIMEOUT_MIN (default 20)');
    return 0;
  }

  let bin: string | null = null;
  if (!selfCheck) {
    bin = process.env.CLAUDE_BIN || findOnPath('claude');
    if (!bin) {
      out('Claude Code was not found: put `claude` on PATH or set CLAUDE_BIN=/path/to/claude (or run with -- --self-check).');
      return 2;
    }
  }

  // A short path: the assistant reads and writes it in every tool call.
  // Its real path (macOS: /private/tmp/…), the one the assistant's tool calls name.
  const work = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'erd-sync-ai-')));
  const home = path.join(work, 'home');
  fs.mkdirSync(home);
  const ai = path.join(work, 'ai');
  const det = path.join(work, 'det');
  const failures: string[] = [];
  const warnings: string[] = [];
  const check = (what: string, ok: boolean, detail?: unknown): void => {
    out(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) {
      failures.push(what);
      if (detail !== undefined) out((typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)).replace(/^/gm, '       '));
    }
  };

  try {
    out(`ERD Studio AI sync eval (HARNESS_VERSION ${HARNESS_VERSION})`);
    out(`work folder: ${work}`);

    // 1. The project, the AI helper, the scenario and the plan.
    fs.renameSync(copyFixture('dbml', work), ai);
    const install = new HarnessService().install(ai, HARNESS_TARGETS.find((t) => t.id === 'claude')!);
    if (!install.success) throw new Error(`Set Up My AI Helper (Claude Code) failed: ${install.error}`);
    out(`installed the AI helper: ${(install.filesWritten ?? []).join(', ')}`);
    applyScenario(ai, 'dbml');
    _resetMockWorkspace();
    const { plan } = await generatePlan(ai, SHOWCASE.dbml, mixed);
    out(`plan: ${plan.columns.length} column and ${plan.relationships.length} relationship entries (${plan.domain}, ${plan.layer}), requiresCompile ${plan.requiresCompile}`);
    for (const c of plan.columns) out(`    ${c.action} ${c.modelName}.${c.columnName}`);
    for (const r of plan.relationships) out(`    ${r.action} ${r.fromModel}.${r.fromColumn} -> ${r.toModel}.${r.toColumn}`);
    const beforeTests = dbtTests(ai);
    const beforeFiles = fileHashes(ai);

    // 2. The expected end: the deterministic applier on a copy.
    fs.cpSync(ai, det, { recursive: true, preserveTimestamps: true });
    applySyncPlan(det, plan);
    _resetMockWorkspace();
    const expected = await compare(det, SHOWCASE.dbml);
    const expectedTests = testChanges(beforeTests, dbtTests(det));
    const expectedRefs = refsByFile(det);
    const expectedProblems = await dbmlProblems(det, home);
    const baseline = [...errorsOf(expected.panel), ...unresolved(plan, expected.report), ...expectedProblems.filter((p) => p.severity === 'error').map(problemText)];
    if (baseline.length > 0) throw new Error(`the deterministic applier itself does not end clean, so there is nothing to compare with:\n${baseline.join('\n')}`);
    const refCount = Object.values(expectedRefs).reduce((n, r) => n + r.length, 0);
    if (refCount === 0) throw new Error('found no Ref line in the applier\'s result: the Ref reader no longer matches the DBML written');
    out(`expected (the applier's result): ${refCount} Refs in ${Object.keys(expectedRefs).length} files, ${expectedTests.added.length} dbt tests added, ${expectedTests.removed.length} removed`);

    // 3. The assistant applies the plan.
    let run: AssistantRun | null = null;
    if (selfCheck) {
      out('\n--self-check: the deterministic applier stands in for the assistant');
      applySyncPlan(ai, plan);
    } else {
      out(`\nrunning ${bin} -p "${PROMPT}"`);
      out(`  --permission-mode acceptEdits --allowedTools "${ALLOWED_TOOLS}" (in ${ai})`);
      run = await runClaude(bin!, ai, path.join(work, 'transcript.jsonl'), {
        maxUsd: process.env.ERD_EVAL_MAX_USD || '5',
        timeoutMin: Number(process.env.ERD_EVAL_TIMEOUT_MIN || '20'),
        model: process.env.ERD_EVAL_MODEL || undefined,
      });
      out(`\nassistant: exit ${run.exitCode}${run.timedOut ? ' (timed out)' : ''}, ${run.seconds} s, ${run.turns ?? '?'} turns, US$${run.costUsd?.toFixed(2) ?? '?'}`);
      if (run.denied.length > 0) out(`  denied (outside the allowed tools): ${run.denied.join('; ')}`);
      if (run.finalText) out(`  its last message:\n${run.finalText.trim().replace(/^/gm, '    | ')}`);
      if (run.stderr.trim()) out(`  stderr:\n${run.stderr.trim().replace(/^/gm, '    ! ')}`);
      out(`  transcript: ${path.join(work, 'transcript.jsonl')}`);
    }

    // 4. The checks.
    out('\nchecks');
    if (run) check('Claude Code finished without an error', run.exitCode === 0 && !run.timedOut && run.isError === false, { exitCode: run.exitCode, timedOut: run.timedOut, isError: run.isError });

    const problems = await dbmlProblems(ai, home);
    const expectedWarnings = new Set(expectedProblems.filter((p) => p.severity === 'warning').map((p) => `${p.file} ${p.code}`));
    check('doctor: no DBML error', problems.every((p) => p.severity !== 'error'), problems.filter((p) => p.severity === 'error').map(problemText));
    const newWarnings = problems.filter((p) => p.severity === 'warning' && !expectedWarnings.has(`${p.file} ${p.code}`));
    check('doctor: no DBML warning the applier\'s result does not have', newWarnings.length === 0, newWarnings.map(problemText));

    _resetMockWorkspace();
    const actual = await compare(ai, SHOWCASE.dbml);
    check('Compare: the diagram opens and compares with no error', errorsOf(actual.panel).length === 0, errorsOf(actual.panel));
    check('Compare: no plan entry left unresolved', unresolved(plan, actual.report).length === 0, unresolved(plan, actual.report));
    const want = shape(expected.report);
    const got = shape(actual.report);
    const wantModels = want.models.map((m) => JSON.stringify(m));
    const gotModels = got.models.map((m) => JSON.stringify(m));
    check('Compare: the same as the applier\'s (only the unselected items remain)', JSON.stringify(want) === JSON.stringify(got), {
      'models only the applier has': wantModels.filter((m) => !gotModels.includes(m)),
      'models only the assistant has': gotModels.filter((m) => !wantModels.includes(m)),
      'relationships only the applier has': want.relationships.filter((r) => !got.relationships.includes(r)),
      'relationships only the assistant has': got.relationships.filter((r) => !want.relationships.includes(r)),
    });

    const refs = refsByFile(ai);
    const refDiff: Record<string, { missing: string[]; extra: string[] }> = {};
    for (const file of new Set([...Object.keys(expectedRefs), ...Object.keys(refs)])) {
      const w = expectedRefs[file] ?? [];
      const g = refs[file] ?? [];
      const missing = w.filter((r) => !g.includes(r));
      const extra = g.filter((r) => !w.includes(r));
      if (missing.length > 0 || extra.length > 0) refDiff[file] = { missing, extra };
    }
    check('Refs: every relationships file holds the Refs the applier\'s does (each new Ref in the file SYNC.md names)', Object.keys(refDiff).length === 0, refDiff);

    const tests = testChanges(beforeTests, dbtTests(ai));
    check('schema yml: the same dbt tests added and removed as the applier', JSON.stringify(tests) === JSON.stringify(expectedTests), {
      expected: expectedTests, actual: tests,
    });

    // Not a failure: SYNC.md's last step, and the files each side touched.
    if (fs.existsSync(path.join(ai, '.erd-studio', '.sync-plan.json'))) warnings.push('.erd-studio/.sync-plan.json is still there (SYNC.md step 5 deletes it on success)');
    const aiChanged = changedFiles(beforeFiles, fileHashes(ai));
    const detChanged = changedFiles(beforeFiles, fileHashes(det));
    out(`\nfiles the assistant changed (${aiChanged.length}):${aiChanged.map((f) => `\n    ${f}`).join('')}`);
    const onlyAi = aiChanged.filter((f) => !detChanged.includes(f));
    const onlyDet = detChanged.filter((f) => !aiChanged.includes(f));
    if (onlyAi.length > 0) warnings.push(`changed by the assistant, not by the applier: ${onlyAi.join(', ')}`);
    if (onlyDet.length > 0) warnings.push(`changed by the applier, not by the assistant: ${onlyDet.join(', ')}`);
    for (const w of warnings) out(`note ${w}`);
  } catch (err) {
    out(`\nThe eval could not run: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    out(`work folder kept: ${work}`);
    return 2;
  }

  out('');
  if (failures.length > 0) {
    out(`${failures.length} check(s) failed. Work folder kept: ${work} (ai/ is the assistant's project, det/ the applier's; diff -r them)`);
    return 1;
  }
  out(`All checks passed.${keep ? ` Work folder kept: ${work}` : ''}`);
  if (!keep) fs.rmSync(work, { recursive: true, force: true });
  return 0;
}
