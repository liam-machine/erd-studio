#!/usr/bin/env node
// The real run behind the README GIF's dbt and AI beats (player/hero.js). The GIF is drawn, like
// the rest of it, but what it draws there happened: this script makes the GIF's project for real,
// changes its dbt side, compares, lets Claude Code bring the design in line and compares again,
// and writes what it saw to record/hero-run.json, which hero.js's constants are tested against
// (test/pipeline.test.mjs).
//
//   1. writes shop-analytics under /tmp/erd-hero (HERO_ROOT): a dbt project (six files in
//      models/, a profile that never connects) with the orders design in .erd-studio as DBML,
//      the files ERD Studio 2.0 writes;
//   2. installs the AI helper files with the extension's own HarnessService (what Set Up My AI
//      Helper writes for Claude Code: the erd-studio skill and its PreToolUse hook);
//   3. runs real dbt Core (dbt parse, pinned, through uvx: record/vscode.mjs DBT_UVX_ARGS) and
//      the read-only CLI (dist/cli.js diff): the design matches dbt;
//   4. changes the SQL (SQL_CHANGE: a new dim_store model, a store_key on fct_order), runs dbt
//      parse and the CLI again: the comparison's one difference;
//   5. runs Claude Code once, with the tour's flags (record/vscode.mjs CLAUDE_FLAGS: the
//      project's own settings, no MCP servers, edits accepted, no shell) and PROMPT, on your
//      existing login (print mode: nothing is typed or shown);
//   6. runs the CLI's doctor and diff again, and saves the lot.
//
//   node record/heroRun.mjs            (needs `npm run build` at the repo root for dist/cli.js,
//                                       uvx, and Claude Code signed in; about a minute)
//   node record/heroRun.mjs --keep     keep an existing record's Claude Code run: only re-check
//                                      that the project files still give the same comparisons
import { build } from '../../node_modules/esbuild/lib/main.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBT_ERD } from './fixtures.erd.mjs';
import { CLAUDE_FLAGS, DBT_UVX_ARGS } from './vscode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const ROOT = process.env.HERO_ROOT ?? '/tmp/erd-hero';
const FOLDER = join(ROOT, 'shop-analytics');
export const RECORD = join(HERE, 'hero-run.json');

/** What Claude Code is asked, word for word. */
export const PROMPT = 'dbt has a new dim_store model. Add it to the orders diagram and link fct_order to it.';

const table = (name, cols) => {
  // as formatDbml aligns a table: names to the widest, and a type padded only up to the widest type that has settings after it
  const w = Math.max(...cols.map(([n]) => n.length)), tw = Math.max(...cols.filter(([, , s]) => s).map(([, t]) => t.length));
  return `Table main.${name} {\n${cols.map(([n, t, s]) => `  ${n.padEnd(w)} ${s ? `${t.padEnd(tw)} [${s}]` : t}`).join('\n')}\n}\n`;
};
const FK = "foreign_key: 'true'";
/** The design, as ERD Studio 2.0 writes a DBML project (`erd-studio doctor` reads it; `npm test` checks formatDbml leaves each file alone). */
export const DESIGN = {
  // the folder's README.md, which ERD Studio writes with a project's first diagram (the text a tour take's project got)
  'README.md': DBT_ERD['README.md'],
  'layers.json': `${JSON.stringify({ schemaVersion: 1, layers: [{ id: 'main', label: 'Main', abbreviation: 'MAIN', color: '#6366f1', creatable: true, order: 1 }] }, null, 2)}\n`,
  'main/tables/main/dim_customer.dbml': table('dim_customer', [['customer_key', 'INTEGER', 'pk'], ['customer_id', 'VARCHAR'], ['name', 'VARCHAR']]),
  'main/tables/main/dim_date.dbml': table('dim_date', [['date_key', 'INTEGER', 'pk'], ['date_day', 'DATE'], ['month_name', 'VARCHAR']]),
  'main/tables/main/dim_product.dbml': table('dim_product', [['product_key', 'INTEGER', 'pk'], ['product_name', 'VARCHAR'], ['price', '"DECIMAL(10,2)"']]),
  'main/tables/main/fct_order.dbml': table('fct_order', [['order_id', 'INTEGER', 'pk'], ['customer_key', 'INTEGER', FK], ['date_key', 'INTEGER', FK], ['product_key', 'INTEGER', FK], ['amount', '"DECIMAL(18,2)"']]),
  'main/tables/main/fct_return.dbml': table('fct_return', [['return_id', 'INTEGER', 'pk'], ['order_id', 'INTEGER', FK], ['date_key', 'INTEGER', FK], ['refunded', '"DECIMAL(18,2)"']]),
  'main/relationships/main.dbml': `// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.
use { table main.dim_customer } from '../tables/main/dim_customer.dbml'
use { table main.dim_date }     from '../tables/main/dim_date.dbml'
use { table main.dim_product }  from '../tables/main/dim_product.dbml'
use { table main.fct_order }    from '../tables/main/fct_order.dbml'
use { table main.fct_return }   from '../tables/main/fct_return.dbml'

Ref: main.fct_order.customer_key >? main.dim_customer.customer_key
Ref: main.fct_order.date_key >? main.dim_date.date_key
Ref: main.fct_order.product_key >? main.dim_product.product_key
Ref: main.fct_return.order_id >? main.fct_order.order_id
Ref: main.fct_return.date_key >? main.dim_date.date_key
`,
  'main/diagrams/orders.dbml': `use { table main.dim_customer } from '../tables/main/dim_customer.dbml'
use { table main.dim_date }     from '../tables/main/dim_date.dbml'
use { table main.dim_product }  from '../tables/main/dim_product.dbml'
use { table main.fct_order }    from '../tables/main/fct_order.dbml'
use { table main.fct_return }   from '../tables/main/fct_return.dbml'
use * from '../relationships/main.dbml'

Project orders {
  erd_schema_version: '7'
  erd_layout: '''
    dim_customer 0 0
    dim_date 0 640
    dim_product 1040 0
    fct_order 520 170
    fct_return 1040 540
  '''
}
`,
};

const model = (source, cols) => `select\n${cols.map((c) => `    ${c}`).join(',\n')}\nfrom {{ source('shop', '${source}') }}\n`;
const yml = (models) => `version: 2\n\nmodels:\n${models.map(([name, cols]) => `  - name: ${name}\n    columns:\n${cols.map(([n, t, to], i) => `      - name: ${n}\n        data_type: ${t}\n${i === 0 ? '        data_tests: [unique, not_null]\n' : ''}${to ? `        data_tests:\n          - relationships:\n              arguments:\n                to: ref('${to[0]}')\n                field: ${to[1]}\n` : ''}`).join('')}`).join('\n')}`;
const sources = (names) => `version: 2\n\nsources:\n  - name: shop\n    tables:\n${names.map((n) => `      - name: ${n}\n`).join('')}`;
const MODELS = [
  ['dim_customer', 'customers', [['customer_key', 'integer'], ['customer_id', 'varchar'], ['name', 'varchar']]],
  ['dim_date', 'calendar', [['date_key', 'integer'], ['date_day', 'date'], ['month_name', 'varchar']]],
  ['dim_product', 'products', [['product_key', 'integer'], ['product_name', 'varchar'], ['price', 'decimal(10,2)']]],
  ['fct_order', 'orders', [['order_id', 'integer'], ['customer_key', 'integer', ['dim_customer', 'customer_key']], ['date_key', 'integer', ['dim_date', 'date_key']], ['product_key', 'integer', ['dim_product', 'product_key']], ['amount', 'decimal(18,2)']]],
  ['fct_return', 'returns', [['return_id', 'integer'], ['order_id', 'integer', ['fct_order', 'order_id']], ['date_key', 'integer', ['dim_date', 'date_key']], ['refunded', 'decimal(18,2)']]],
];
const dbtFiles = (models) => ({
  ...Object.fromEntries(models.map(([name, source, cols]) => [`models/${name}.sql`, model(source, cols.map(([n]) => n))])),
  'models/schema.yml': yml(models.map(([name, , cols]) => [name, cols])),
  'models/sources.yml': sources(models.map(([, source]) => source)),
});
/** The dbt project the design starts in step with. dbt parse reads the profile but never connects. */
export const DBT = {
  'README.md': '# shop-analytics\n\nThe shop\'s warehouse models, built with dbt, and their design in .erd-studio.\n',
  '.gitignore': 'target/\nlogs/\n',
  'dbt_project.yml': 'name: shop_analytics\nversion: \'1.0.0\'\nprofile: shop_analytics\nmodel-paths: ["models"]\nmodels:\n  shop_analytics:\n    +materialized: table\n',
  'profiles.yml': 'shop_analytics:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: ":memory:"\n      schema: main\n',
  // a model another team keeps as plain DBML: the file the GIF's import beat reads (player/editor.js SALES_DRAFT)
  'sales.dbml': `Table dim_branch {
  branch_id int [pk]
  branch_name varchar
  region varchar
}

Table dim_staff {
  staff_id int [pk]
  staff_name varchar
}

Table dim_calendar {
  date_day date [pk]
  month_name varchar
}

Table fct_sale {
  sale_id int [pk]
  branch_id int [ref: > dim_branch.branch_id]
  staff_id int [ref: > dim_staff.staff_id]
  sale_date date [ref: > dim_calendar.date_day]
  amount decimal(12,2)
}

Table fct_refund {
  refund_id int [pk]
  sale_id int [ref: > fct_sale.sale_id]
  refunded decimal(12,2)
}
`,
  ...dbtFiles(MODELS),
};
/** The SQL change: dbt gains a dim_store model, and fct_order a store_key that points at it. */
const CHANGED_MODELS = [
  ...MODELS.slice(0, 3),
  ['dim_store', 'stores', [['store_key', 'integer'], ['store_name', 'varchar'], ['city', 'varchar']]],
  ['fct_order', 'orders', [...MODELS[3][2].slice(0, 4), ['store_key', 'integer', ['dim_store', 'store_key']], MODELS[3][2][4]]],
  MODELS[4],
];
export const SQL_CHANGE = Object.fromEntries(Object.entries(dbtFiles(CHANGED_MODELS)).filter(([f, text]) => DBT[f] !== text));

const write = (dir, files) => { for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); } };
const readTree = (dir) => {
  const out = {};
  const walk = (d) => { for (const f of readdirSync(d).sort()) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p)] = readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
};
const which = (tool) => execFileSync('/bin/sh', ['-lc', `command -v ${tool}`], { encoding: 'utf8' }).trim();

/** Real dbt Core, never a dbt on your PATH: the tour's pinned one, with its own uv cache. */
function dbtParse() {
  const env = { ...process.env, UV_CACHE_DIR: join(ROOT, 'uv-cache'), PYTHONWARNINGS: 'ignore', DBT_SEND_ANONYMOUS_USAGE_STATS: 'false' };
  const run = spawnSync(which('uvx'), [...DBT_UVX_ARGS, 'parse', '--profiles-dir', '.'], { cwd: FOLDER, env, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`dbt parse failed:\n${run.stdout}${run.stderr}`);
}
const cli = (...args) => spawnSync('node', [join(REPO, 'dist', 'cli.js'), ...args, '--project', FOLDER], { encoding: 'utf8' });
/** The comparison the canvas's Compare with dbt makes (the CLI and the canvas share its code): the text, and the report's numbers. */
function compare() {
  const text = cli('diff', '--all').stdout.trim().split('\n');
  const json = JSON.parse(cli('diff', '--all', '--json').stdout);
  const d = json.domains[0];
  return {
    text, clean: d.clean, summary: d.report.summary,
    relationships: { matched: d.counts.matchedRelationships, other: d.report.relationships.filter((r) => r.status !== 'matched').length },
    differences: d.report.models.flatMap((m) => [
      ...(m.status !== 'matched' ? [{ table: m.name, status: m.status }] : []),
      ...m.columns.filter((c) => c.status !== 'matched').map((c) => ({ table: m.name, column: c.name, status: c.status, type: c.targetDataType ?? c.sourceDataType ?? null })),
    ]),
  };
}

/** Set Up My AI Helper's files for Claude Code, written by the extension's own HarnessService. */
async function installHelper() {
  const out = join(ROOT, 'install-helper.cjs');
  await build({
    stdin: { contents: `import { HarnessService } from ${JSON.stringify(join(REPO, 'src', 'services', 'harnessService'))};
      const r = new HarnessService().install(process.argv[2], { label: 'Claude Code', id: 'claude', description: '.claude/skills/erd-studio/SKILL.md', relativePath: '.claude/skills/erd-studio/SKILL.md' }, true);
      if (!r.success) { console.error(r.error); process.exit(1); }
      console.log(JSON.stringify(r.filesWritten));`, resolveDir: REPO, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', loader: { '.md': 'text' }, logLevel: 'warning', outfile: out, tsconfig: join(REPO, 'tsconfig.json'),
  });
  return JSON.parse(execFileSync('node', [out, FOLDER], { encoding: 'utf8' }).trim().split('\n').at(-1));
}

/** One real Claude Code run in the folder: every tool call it made, in order, and what it said at the end. */
function runClaude() {
  const env = { ...process.env, IS_DEMO: '1', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false' };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k];
  const run = spawnSync(process.env.CLAUDE_BIN ?? which('claude'), ['-p', PROMPT, '--output-format', 'stream-json', '--verbose', ...CLAUDE_FLAGS], { cwd: FOLDER, env, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(`claude failed (${run.status}):\n${run.stderr}`);
  const calls = [];
  const said = [];
  let result = null;
  const pending = new Map();
  for (const line of run.stdout.split('\n').filter(Boolean)) {
    const o = JSON.parse(line);
    if (o.type === 'assistant') for (const c of o.message.content) {
      if (c.type === 'text') said.push(c.text);
      if (c.type !== 'tool_use') continue;
      const target = c.input.skill ?? (c.input.file_path ? relative(FOLDER, c.input.file_path.replace(/^\/private/, '')) : c.input.pattern ?? '');
      const call = { tool: c.name, target, ok: true };
      calls.push(call);
      pending.set(c.id, call);
    }
    if (o.type === 'user' && Array.isArray(o.message.content)) for (const c of o.message.content) {
      if (c.type === 'tool_result' && c.is_error && pending.has(c.tool_use_id)) {
        const call = pending.get(c.tool_use_id);
        call.ok = false;
        call.error = String(typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).split(FOLDER).join('.').slice(0, 300);
      }
    }
    if (o.type === 'result') result = { subtype: o.subtype, seconds: Math.round(o.duration_ms / 100) / 10, turns: o.num_turns };
  }
  if (result?.subtype !== 'success') throw new Error(`claude did not finish: ${JSON.stringify(result)}`);
  return { calls, said: said.at(-1) ?? '', ...result };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const keep = process.argv.includes('--keep');
  const old = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : null;
  if (keep && !old) throw new Error('--keep needs an existing record/hero-run.json');
  if (!existsSync(join(REPO, 'dist', 'cli.js'))) throw new Error('run `npm run build` at the repo root first (dist/cli.js)');
  rmSync(FOLDER, { recursive: true, force: true });
  write(FOLDER, DBT);
  write(join(FOLDER, '.erd-studio'), DESIGN);
  const helper = await installHelper();
  const doctor0 = cli('doctor', '--no-dbt');
  if (doctor0.status !== 0) throw new Error(`doctor: ${doctor0.stdout}${doctor0.stderr}`);
  dbtParse();
  const inStep = compare();
  if (!inStep.clean) throw new Error(`the design should start in step with dbt: ${inStep.text.join(' / ')}`);
  write(FOLDER, SQL_CHANGE);
  dbtParse();
  const sqlChanged = compare();
  let claude, designAfter;
  if (keep) {
    claude = old.claude;
    designAfter = old.design.after;
    write(join(FOLDER, '.erd-studio'), designAfter);
  } else {
    claude = runClaude();
    designAfter = readTree(join(FOLDER, '.erd-studio'));
  }
  // the lines about the project (not the one naming the dbt on this machine's PATH)
  const doctor = cli('doctor').stdout.trim().split('\n').filter((l) => /^[✓✗–] (manifest|ERD Studio:|Claude skills)/.test(l));
  const afterAi = compare();
  const record = {
    note: 'Written by video/record/heroRun.mjs: the real run the README GIF\'s dbt and AI beats are drawn from. Do not edit by hand.',
    ranAt: keep ? old.ranAt : new Date().toISOString().slice(0, 10),
    cliVersion: JSON.parse(cli('diff', '--all', '--json').stdout).cliVersion,
    dbt: DBT_UVX_ARGS.filter((a) => a.includes('==')),
    helper,
    prompt: PROMPT,
    claudeFlags: CLAUDE_FLAGS,
    claude,
    sqlChange: Object.keys(SQL_CHANGE),
    design: { before: DESIGN, after: designAfter },
    doctor,
    compare: { inStep, sqlChanged, afterAi },
  };
  if (keep) for (const k of ['inStep', 'sqlChanged', 'afterAi']) {
    if (JSON.stringify(old.compare[k]) !== JSON.stringify(record.compare[k])) throw new Error(`${k}: the comparison no longer matches the record. Run without --keep.`);
  }
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`hero-run: ${RECORD}`);
  console.log(`  design in step:  ${inStep.text.join(' / ')}`);
  console.log(`  SQL changed:     ${sqlChanged.text.join(' / ')}`);
  console.log(`  Claude Code:     ${claude.calls.map((c) => `${c.tool}${c.ok ? '' : ' (refused)'}`).join(', ')} (${claude.seconds} s)`);
  console.log(`  after:           ${afterAi.text.join(' / ')}`);
}
