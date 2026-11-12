#!/usr/bin/env node
// The real run behind the README GIF (player/hero.js). The GIF is drawn, like the old one, but what
// it draws happened: this script makes the GIF's project for real and takes it through the GIF's
// three edits, and writes what it saw to record/hero-run.json, which hero.js's constants are tested
// against (test/pipeline.test.mjs).
//
//   1. writes shop-analytics under /tmp/erd-hero (HERO_ROOT): a plain folder (no dbt), the code
//      that loads a warehouse in pipelines/ and the orders design in .erd-studio as DBML, the
//      files ERD Studio 2.0 writes (DESIGN), and checks them with the read-only CLI's doctor;
//   2. installs the AI helper files with the extension's own HarnessService (what Set Up My AI
//      Helper writes for Claude Code: the erd-studio skill and its PreToolUse hook);
//   3. BY HAND: opens the diagram in the real canvas (dist/webview.js in headless Chromium, the
//      host mocked: docs/dev/webview-preview.md), long-presses fct_return's date_key, drags it
//      onto dim_date's date_key and clicks the dialog's Create Relationship. Keeps the dialog as
//      the canvas drew it (player/assets/hero-new-relationship.png), its words and the message the
//      canvas sent its host. The host's write is not run here: the Ref it stands for is added to
//      the relationships file by this script, in the form ERD Studio writes (BY_HAND_REF);
//   4. AS TEXT: adds one column line to fct_order.dbml (TYPED_LINE), as someone typing it would;
//   5. WITH AI: runs Claude Code once, with the tour's flags (record/vscode.mjs CLAUDE_FLAGS: the
//      project's own settings, no MCP servers, edits accepted, no shell) and PROMPT, on your
//      existing login (print mode: nothing is typed or shown);
//   6. after each edit reads the design back with @erd-studio/core (what the canvas would draw:
//      its tables, columns and relationships) and runs the CLI's doctor, and saves the lot.
//
//   node record/heroRun.mjs            (needs `npm run build` at the repo root for dist/cli.js and
//                                       dist/webview.js, and Claude Code signed in; under a minute)
//   node record/heroRun.mjs --keep     keep an existing record's Claude Code run: re-run the rest
import { build } from '../../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBT_ERD } from './fixtures.erd.mjs';
import { CLAUDE_FLAGS } from './vscode.mjs';
import { startServer } from '../serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const ROOT = process.env.HERO_ROOT ?? '/tmp/erd-hero';
const FOLDER = join(ROOT, 'shop-analytics');
export const RECORD = join(HERE, 'hero-run.json');
/** The dialog the real canvas opens when the drag is dropped, as it drew it (2x). */
export const DIALOG_SHOT = join(HERE, '..', 'player', 'assets', 'hero-new-relationship.png');

/** What Claude Code is asked, word for word. */
export const PROMPT = 'Add a dim_store table and link fct_order to it.';
/** The drag by hand: from this column onto that one. */
export const DRAG = { from: ['fct_return', 'date_key'], to: ['dim_date', 'date_key'] };
/** The relationship that drag stands for, as ERD Studio writes a Ref in a relationships file. */
export const BY_HAND_REF = 'Ref: main.fct_return.date_key >? main.dim_date.date_key';
/** The line typed into fct_order.dbml, and the line it goes under. */
export const TYPED_LINE = '  quantity     INTEGER';
const TYPED_AFTER = "  product_key  INTEGER [foreign_key: 'true']";

const table = (name, cols) => {
  // as formatDbml aligns a table: names to the widest, and a type padded only up to the widest type that has settings after it
  const w = Math.max(...cols.map(([n]) => n.length)), tw = Math.max(...cols.filter(([, , s]) => s).map(([, t]) => t.length));
  return `Table main.${name} {\n${cols.map(([n, t, s]) => `  ${n.padEnd(w)} ${s ? `${t.padEnd(tw)} [${s}]` : t}`).join('\n')}\n}\n`;
};
const FK = "foreign_key: 'true'";
const L = 'main';
/** The design at the start, as ERD Studio 2.0 writes a DBML project (`npm test` checks formatDbml leaves each file alone). */
export const DESIGN = {
  // the folder's README.md, which ERD Studio writes with a project's first diagram (the text a tour take's project got)
  'README.md': DBT_ERD['README.md'],
  'layers.json': `${JSON.stringify({ schemaVersion: 1, layers: [{ id: L, label: 'Main', abbreviation: 'MAIN', color: '#6366f1', creatable: true, order: 1 }] }, null, 2)}\n`,
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
/** The rest of the folder: the code that loads the warehouse the design describes. No dbt. */
export const CODE = {
  'README.md': '# shop-analytics\n\nLoads the shop\'s orders into its warehouse. The data model is in .erd-studio.\n',
  '.gitignore': '.venv/\n__pycache__/\n',
  'pipelines/load_orders.py': 'def load_orders(conn):\n    conn.execute(open("pipelines/orders.sql").read())\n',
  'pipelines/orders.sql': 'insert into main.fct_order\nselect order_id, customer_key, date_key, product_key, amount\nfrom staging.orders\n',
};
const REL = 'main/relationships/main.dbml', FCT = 'main/tables/main/fct_order.dbml';
/** The design once the relationship drawn by hand is saved... */
export const afterDrag = (design) => ({ ...design, [REL]: `${design[REL]}${BY_HAND_REF}\n` });
/** ...and once the column is typed. */
export const afterTyping = (design) => ({ ...design, [FCT]: design[FCT].replace(`${TYPED_AFTER}\n`, `${TYPED_AFTER}\n${TYPED_LINE}\n`) });

const write = (dir, files) => { for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); } };
const readTree = (dir) => {
  const out = {};
  const walk = (d) => { for (const f of readdirSync(d).sort()) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p)] = readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
};
const which = (tool) => execFileSync('/bin/sh', ['-lc', `command -v ${tool}`], { encoding: 'utf8' }).trim();
const cli = (...args) => spawnSync('node', [join(REPO, 'dist', 'cli.js'), ...args, '--project', FOLDER], { encoding: 'utf8' });
/** The CLI's doctor on the folder: its lines about the design. */
function doctor() {
  const run = cli('doctor');
  if (run.status !== 0) throw new Error(`doctor: ${run.stdout}${run.stderr}`);
  return run.stdout.trim().split('\n').filter((l) => /^[✓✗–] (ERD Studio:|Claude skills)/.test(l));
}

const ALIAS = { '@erd-studio/core/dbml': join(REPO, 'packages/core/src/dbml/index.ts'), '@erd-studio/core': join(REPO, 'packages/core/src/index.ts') };
let loader;
/** The diagram as @erd-studio/core reads it from a set of .erd-studio files: what the canvas is handed to draw. */
async function load(design) {
  if (!loader) {
    loader = join(ROOT, 'load.cjs');
    await build({
      stdin: { contents: `import { loadDisplaySubjectArea } from '@erd-studio/core'; import { dbmlStorageReader } from '@erd-studio/core/dbml';
        const files = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
        loadDisplaySubjectArea({ domainPath: '.erd-studio/main/diagrams/orders.dbml', readOnly: false, dbml: dbmlStorageReader, readFile: async (p) => files[p] ?? null }).then((d) => console.log(JSON.stringify(d)));`, resolveDir: REPO, loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', outfile: loader, logLevel: 'warning', tsconfig: join(REPO, 'tsconfig.json'), alias: ALIAS,
    });
  }
  const input = join(ROOT, 'files.json');
  writeFileSync(input, JSON.stringify(Object.fromEntries(Object.entries(design).map(([k, v]) => [`.erd-studio/${k}`, v]))));
  return JSON.parse(execFileSync('node', [loader, input], { encoding: 'utf8', maxBuffer: 1 << 26 }));
}
/** What a loaded diagram draws, in short: each table's columns ([key, name, type]) and position, and each relationship. */
const drawn = (d) => ({
  tables: Object.fromEntries(d.models.map((m) => [m.name, m.columns.map((c) => [c.isPrimaryKey ? 'PK' : c.isForeignKey ? 'FK' : c.isNaturalKey ? 'NK' : null, c.name, c.dataType])])),
  grains: Object.fromEntries(d.models.filter((m) => m.grain).map((m) => [m.name, m.grain])),
  positions: Object.fromEntries(Object.entries(d.viewConfig?.positions ?? {}).map(([k, p]) => [k, [p.x, p.y]])),
  relationships: d.relationships.map((r) => `${r.fromModel}.${r.fromColumn} > ${r.toModel}.${r.toColumn}`).sort(),
});

// VS Code's dark theme, for the real canvas (docs/dev/webview-preview.md)
const VSCODE = { 'editor-background': '#1e1e1e', 'editor-foreground': '#d4d4d4', 'sideBar-background': '#252526', 'panel-border': '#404040', 'editorGroup-border': '#444444', 'button-background': '#0e639c', 'button-foreground': '#ffffff', 'button-hoverBackground': '#1177bb', 'input-background': '#3c3c3c', 'input-foreground': '#cccccc', 'input-border': 'transparent', 'focusBorder': '#007fd4', 'editor-selectionBackground': '#264f78', 'errorForeground': '#f48771', 'editorWarning-foreground': '#cca700', 'descriptionForeground': '#999999', 'font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 'font-size': '13px', 'font-weight': '400', 'editor-font-family': "'SF Mono', Menlo, Consolas, monospace" };
/**
 * The drag by hand, in the real canvas: dist/webview.js in headless Chromium, handed the diagram as
 * a plain folder's host would (`logicalOnly`). Returns the dialog's words and the messages the
 * canvas posted; `shots` also saves the canvas before, mid-drag and after, for looking at.
 */
async function dragInCanvas(domain, shots) {
  const out = join(REPO, 'video', 'build', 'hero-canvas');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/dist/webview.css">
<style>html,body,#root{margin:0;padding:0;width:100%;height:100vh;overflow:hidden}:root{${Object.entries(VSCODE).map(([k, v]) => `--vscode-${k}:${v}`).join(';')}}</style></head>
<body class="vscode-dark" data-vscode-theme-kind="vscode-dark"><div id="root"></div><script>
window.__posted = [];
window.acquireVsCodeApi = () => ({ postMessage: (m) => { window.__posted.push(m); if (m && m.type === 'ready') setTimeout(() => window.postMessage({ type: 'domainLoaded', payload: ${JSON.stringify(domain)}, logicalOnly: true }, '*'), 100); }, getState: () => null, setState: () => {} });
</script><script src="/dist/webview.js"></script></body></html>`);
  const server = await startServer(0);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 760 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/video/build/hero-canvas/index.html`);
    await page.waitForSelector('.react-flow__node');
    await page.waitForTimeout(1500);
    if (shots) await page.screenshot({ path: join(out, 'before.png') });
    const row = ([t, c]) => page.evaluate(([t, c]) => { const b = document.querySelector(`[data-model-name="${t}"] [data-column-name="${c}"]`).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, [t, c]);
    const a = await row(DRAG.from), z = await row(DRAG.to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.waitForTimeout(400);   // a long press starts the drag (ModelNode.tsx: 220 ms)
    for (let i = 1; i <= 20; i++) { await page.mouse.move(a.x + (z.x - a.x) * i / 20, a.y + (z.y - a.y) * i / 20); await page.waitForTimeout(20); }
    await page.waitForTimeout(200);
    if (shots) await page.screenshot({ path: join(out, 'dragging.png') });
    await page.mouse.up();
    const dialog = page.locator('.new-fk-dialog');
    await dialog.waitFor({ timeout: 5000 });
    await page.mouse.move(650, 20);
    await page.waitForTimeout(500);
    await dialog.screenshot({ path: DIALOG_SHOT });
    const box = await dialog.boundingBox();
    const words = (await dialog.evaluate((d) => [...d.querySelectorAll('.new-fk-dialog__title, h2, h3, legend, label, button, .new-fk-dialog__preview')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean)));
    const chosen = await dialog.evaluate((d) => [...d.querySelectorAll('select')].map((s) => s.options[s.selectedIndex]?.text ?? ''));
    const create = dialog.locator('button', { hasText: 'Create Relationship' });
    const cb = await create.boundingBox();
    await create.click();
    await page.waitForTimeout(400);
    const posted = await page.evaluate(() => window.__posted.filter((m) => m.type !== 'ready' && m.type !== 'requestNewRelationshipFiles'));
    if (errors.length) throw new Error(`the canvas threw: ${errors.join(' / ')}`);
    return { dialog: { width: Math.round(box.width), height: Math.round(box.height), words: [...new Set(words)], chosen, createButton: { x: Math.round(cb.x + cb.width / 2 - box.x), y: Math.round(cb.y + cb.height / 2 - box.y) } }, posted };
  } finally { await browser.close(); server.close(); }
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
  if (keep && !old?.claude) throw new Error('--keep needs an existing record/hero-run.json');
  for (const f of ['cli.js', 'webview.js']) if (!existsSync(join(REPO, 'dist', f))) throw new Error(`run \`npm run build\` at the repo root first (dist/${f})`);
  rmSync(FOLDER, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  write(FOLDER, CODE);
  write(join(FOLDER, '.erd-studio'), DESIGN);
  const helper = await installHelper();
  const start = await load(DESIGN);
  // by hand
  const drag = await dragInCanvas(start, process.argv.includes('--shots'));
  const dragged = afterDrag(DESIGN);
  // as text
  const typed = afterTyping(dragged);
  write(join(FOLDER, '.erd-studio'), typed);
  // with AI
  let claude, after;
  if (keep) {
    claude = old.claude;
    after = old.design.after;
    write(join(FOLDER, '.erd-studio'), after);
  } else {
    claude = runClaude();
    after = readTree(join(FOLDER, '.erd-studio'));
  }
  const record = {
    note: 'Written by video/record/heroRun.mjs: the real run the README GIF is drawn from. Do not edit by hand.',
    ranAt: keep ? old.ranAt : new Date().toISOString().slice(0, 10),
    cliVersion: JSON.parse(cli('inventory', '--json').stdout).cliVersion ?? null,
    helper,
    drag,
    prompt: PROMPT,
    claudeFlags: CLAUDE_FLAGS,
    claude,
    design: { start: DESIGN, after },
    drawn: { start: drawn(start), dragged: drawn(await load(dragged)), typed: drawn(await load(typed)), after: drawn(await load(after)) },
    doctor: doctor(),
  };
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`hero-run: ${RECORD}`);
  console.log(`  by hand:     ${JSON.stringify(drag.posted)}`);
  console.log(`  drawn:       ${Object.entries(record.drawn).map(([k, d]) => `${k} ${Object.keys(d.tables).length} tables, ${d.relationships.length} relationships`).join(' · ')}`);
  console.log(`  Claude Code: ${claude.calls.map((c) => `${c.tool}${c.ok ? '' : ' (refused)'}`).join(', ')} (${claude.seconds} s)`);
  console.log(`  ${record.doctor.join(' / ')}`);
}
