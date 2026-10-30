#!/usr/bin/env node
/**
 * End to end for native DBML storage (spec §7.6), run by `npm run test:e2e:dbml`
 * and in CI (`-- --no-build`, after the existing build):
 *
 * 1. `npm run build`, unless `--no-build`.
 * 2. Copy test/fixtures/dbt-project to a temp dir without `gold/finance.json`
 *    (a v4 file: the command would chain the v4 step, which is not under test).
 * 3. Bundle and run scripts/convert-fixture.ts on a second copy: Convert
 *    Project to DBML planned (no refusal) and written to disk.
 * 4. Run dist/cli.js doctor / diff / export on the original and the converted
 *    copy, and build every diagram's display in-process (core's
 *    loadDisplaySubjectArea), and compare: doctor says storage dbml with no
 *    DBML error; diff and the displays agree after the normalisations the spec
 *    names (positions included, compared whatever their key order); exports
 *    are byte-equal for diagrams the plan's notes do not touch (a rich DBML
 *    export carries its positions in erd_layout). A diagram the plan lists
 *    under movedRelationships differs by exactly those relationships.
 * 5. Compile every written .dbml as a multi-file project under @dbml/parse
 *    9.1.1, 10.3.1 and 11.0.0 with zero errors.
 * 6. Exit non-zero on any failure, with a readable diff.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CLI = path.join(ROOT, 'dist', 'cli.js');
const FORMATS = ['mermaid', 'dbml', 'dbml-rich'];

const failures = [];
const log = (line) => process.stdout.write(`${line}\n`);
const fail = (what, detail) => {
  failures.push(what);
  log(`FAIL ${what}`);
  if (detail !== undefined) log(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
};
const pass = (what) => log(`ok   ${what}`);

// ── 1. Build ────────────────────────────────────────────────────────────────
if (!process.argv.includes('--no-build')) {
  log('building (npm run build)…');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
}
if (!fs.existsSync(CLI)) {
  log(`dist/cli.js is missing: run npm run build first (or drop --no-build).`);
  process.exit(1);
}

// ── 2. Two copies of the fixture ────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-e2e-dbml-'));
const original = path.join(tmp, 'original');
const converted = path.join(tmp, 'converted');
fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'dbt-project'), original, { recursive: true });
fs.rmSync(path.join(original, '.erd-studio', 'gold', 'finance.json'));
log('removed .erd-studio/gold/finance.json from the copy: it is v4, and Convert would chain the v4 → v5 step, which this script does not test');
fs.cpSync(original, converted, { recursive: true });

// ── 3. Convert, through the bundled planner ────────────────────────────────
const helper = path.join(tmp, 'convert-fixture.cjs');
const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'scripts', 'convert-fixture.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: helper,
  loader: { '.md': 'text' },
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  logLevel: 'warning',
});
const runHelper = (mode, project) => {
  const r = spawnSync(process.execPath, [helper, mode, project], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    fail(`convert-fixture ${mode} exited ${r.status}`, `${r.stdout}\n${r.stderr}`);
    finish();
  }
  return JSON.parse(r.stdout);
};
const plan = runHelper('convert', converted);
pass(`Convert planned with no refusal: ${plan.summary.tables} tables, ${plan.summary.diagrams} diagrams, ${plan.summary.relationships} relationships, ${plan.movedRelationships.length} moved`);

// ── 4. The CLI and the displays on both copies ─────────────────────────────
const cli = (project, args) => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--project', project], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

// doctor
const doctor = JSON.parse(cli(converted, ['doctor', '--json', '--no-dbt']).out);
if (doctor.erd.storage !== 'dbml') fail(`doctor erd.storage is ${doctor.erd.storage}, not dbml`);
else pass('doctor: erd.storage is dbml');
const dbmlErrors = (doctor.erd.dbmlProblems ?? []).filter((p) => p.severity === 'error');
if (dbmlErrors.length > 0) fail('doctor: dbmlProblems has errors', dbmlErrors);
else pass(`doctor: no DBML error (${(doctor.erd.dbmlProblems ?? []).length} warnings)`);
const originalDoctor = JSON.parse(cli(original, ['doctor', '--json', '--no-dbt']).out);
if (originalDoctor.erd.storage !== 'yaml') fail(`the original copy reads as ${originalDoctor.erd.storage}, not yaml`);

// Which diagrams the plan names: a moved relationship now also draws there; a note mentions it or one of its tables.
const key = (file) => file.replace(/^\.erd-studio\//, '').replace(/\.(json|dbml)$/i, '');
const movedInto = new Map();
const linksOf = (from, to) => {
  const parse = (end) => {
    const m = /^([^.]+)\.(?:\((.*)\)|(.*))$/.exec(end);
    return { table: m[1], columns: (m[2] ?? m[3]).split(',').map((c) => c.trim()) };
  };
  const a = parse(from);
  const b = parse(to);
  return a.columns.map((c, i) => `${a.table}.${c}->${b.table}.${b.columns[i]}`.toLowerCase());
};
for (const m of plan.movedRelationships) {
  for (const d of m.diagrams) {
    const set = movedInto.get(key(d)) ?? new Set();
    for (const link of linksOf(m.from, m.to)) set.add(link);
    movedInto.set(key(d), set);
  }
}
// The diagrams whose own file held relationships: Convert moves those into the library (§6.3).
const movedLinks = new Set(plan.movedRelationships.flatMap((m) => linksOf(m.from, m.to)));
const holders = new Set();
const before = runHelper('displays', original);
const after = runHelper('displays', converted);
for (const diagram of Object.keys(before)) {
  const file = path.join(original, '.erd-studio', `${diagram}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const held = raw?.logical?.relationships;
    if (Array.isArray(held) && held.length > 0) holders.add(diagram);
  } catch {
    // not a JSON diagram, or unreadable: nothing held
  }
}
// A note touches a diagram when it names the diagram's file or one of its tables as a whole name, and says
// something that changes what is drawn. Keys kept as `//` lines in the diagram file are comments: no
// export holds them, so that note changes no export byte.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (note, name) => new RegExp(`(^|[^\\w])${escapeRe(name)}([^\\w]|$)`, 'i').test(note);
const drawingNotes = plan.notes.filter((note) => !/ are kept as \/\/ lines /.test(note));
const touched = (diagram) => {
  if (movedInto.has(diagram) || holders.has(diagram)) return true;
  const display = before[diagram];
  const names = [`${diagram}.json`, ...(display?.models ?? []).map((m) => m.name)];
  return drawingNotes.some((note) => names.some((n) => mentions(note, n)));
};

// diff --all: equal after normalising the paths (and schemaVersion)
const normalisePath = (p) => typeof p !== 'string' ? p : p.replace(/\.yml$/, '.dbml').replace('/logical-models/', '/tables/').replace(/\.json$/, '.dbml');
function normaliseDiff(result) {
  const out = {};
  for (const d of result.domains) {
    const fixes = d.fixes.map((f) => {
      const r = f.relationship;
      // A relationship Convert moved out of this diagram file is now fixed in the library: the documented move.
      if (r && movedLinks.has(`${r.fromModel}.${r.fromColumn}->${r.toModel}.${r.toColumn}`.toLowerCase())) {
        return { ...f, file: '(moved to the library)', movesFrom: undefined, explain: undefined };
      }
      const file = normalisePath(f.file);
      // A relationship fix names the owner's yml in YAML and its folder's relationships file in DBML.
      const owner = /\/_relationships\.dbml$/.test(file) ? file.replace(/_relationships\.dbml$/, `${f.model}.dbml`) : file;
      return { ...f, file: owner, ...(f.movesFrom ? { movesFrom: normalisePath(f.movesFrom).replace(/\/_relationships\.dbml$/, '/…') } : {}), explain: undefined };
    });
    out[key(d.file)] = {
      clean: d.clean, error: d.error?.code, needsMigration: d.needsMigration ?? false, counts: d.counts, phantoms: d.phantoms,
      missingModelFiles: d.missingModelFiles, modelsWithoutColumns: d.modelsWithoutColumns,
      unreadable: d.unreadableModelFiles.map((u) => u.name), fixes,
    };
  }
  return out;
}
const linkOfFix = (r) => `${r.fromModel}.${r.fromColumn}->${r.toModel}.${r.toColumn}`.toLowerCase();
const diffBefore = normaliseDiff(JSON.parse(cli(original, ['diff', '--all', '--json']).out));
const diffAfter = normaliseDiff(JSON.parse(cli(converted, ['diff', '--all', '--json']).out));
for (const diagram of Object.keys(diffBefore).sort()) {
  const a = diffBefore[diagram];
  const b = diffAfter[diagram];
  if (!b) { fail(`diff: ${diagram} is missing after Convert`); continue; }
  if (a.needsMigration) {
    // An older (v4) file with no inline table converts straight to DBML.
    if (b.needsMigration) fail(`diff: ${diagram} still needs migration after Convert`);
    continue;
  }
  const moved = movedInto.get(diagram);
  if (moved) {
    // It gains exactly the moved relationships (checked on its display below): compare everything else,
    // without the fixes about those relationships and the counts they change.
    const rest = (d) => JSON.stringify({ ...d, counts: undefined, fixes: d.fixes.filter((f) => !(f.relationship && moved.has(linkOfFix(f.relationship)))) });
    if (rest(a) !== rest(b)) fail(`diff: ${diagram} differs after Convert by more than its moved relationships`, { before: a, after: b });
    continue;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) fail(`diff: ${diagram} differs after Convert`, { before: a, after: b });
}
pass(`diff --all compared on ${Object.keys(diffBefore).length} diagrams`);

// displays: equal through the one comparator, apart from exactly the moved relationships
// The one storage-equivalence comparator (D24), bundled from core's source.
const comparator = path.join(tmp, 'storage-equivalence.cjs');
esbuild.buildSync({ entryPoints: [path.join(ROOT, 'packages', 'core', 'src', 'storageEquivalence.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: comparator, logLevel: 'warning' });
const compare = require(comparator).normaliseForStorageEquivalence;
/** JSON with every object's keys sorted: two displays are equal whatever order their positions (or anything else) were written in. */
const stableJson = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
  : v));
const linkKeyOf = (r) => `${r.fromModel}.${r.fromColumn}->${r.toModel}.${r.toColumn}`.toLowerCase();
for (const diagram of Object.keys(before).sort()) {
  const was = before[diagram];
  const now = after[diagram];
  if (!now || now.loadError) { fail(`display: ${diagram} does not load after Convert`, now?.loadError); continue; }
  if (was.loadError) continue;
  const moved = movedInto.get(diagram);
  if (moved) {
    const had = new Set(was.relationships.map(linkKeyOf));
    const appeared = now.relationships.filter((r) => !had.has(linkKeyOf(r)));
    const appearedKeys = new Set(appeared.map(linkKeyOf));
    const expected = [...moved].filter((k) => !had.has(k));
    if (appearedKeys.size !== expected.length || expected.some((k) => !appearedKeys.has(k))) {
      fail(`display: ${diagram} should gain exactly the moved relationships`, { expected, appeared: [...appearedKeys] });
    }
    // Recompute the expected output: take them out again, with the foreign-key mark each put on its column.
    now.relationships = now.relationships.filter((r) => !appearedKeys.has(linkKeyOf(r)));
    for (const r of appeared) {
      const col = (area) => area.models.find((m) => m.name.toLowerCase() === r.fromModel.toLowerCase())?.columns?.find((c) => c.name.toLowerCase() === r.fromColumn.toLowerCase());
      const nowCol = col(now);
      const wasCol = col(was);
      if (nowCol && wasCol) nowCol.isForeignKey = wasCol.isForeignKey;
    }
  }
  const a = stableJson(compare(was, { convert: true }));
  const b = stableJson(compare(now, { convert: true }));
  if (a !== b) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    fail(`display: ${diagram} draws differently after Convert`, `…${a.slice(Math.max(0, i - 120), i + 200)}\n   vs\n…${b.slice(Math.max(0, i - 120), i + 200)}`);
  }
}
pass(`displays compared on ${Object.keys(before).length} diagrams through normaliseForStorageEquivalence, positions included`);

// export --all: byte-equal for diagrams the notes do not touch
const exportsOf = (project, format) => {
  const r = cli(project, ['export', '--all', '--format', format, '--json']);
  if (r.code !== 0) fail(`export --all --format ${format} exited ${r.code}`, r.err || r.out);
  const files = JSON.parse(r.out).files ?? [];
  return new Map(files.map((f) => [`${key(f.domain)}\u0000${f.fileName}`, f.content]));
};
let byteCompared = 0;
let lineCompared = 0;
const skippedMoved = new Set();
for (const format of FORMATS) {
  const a = exportsOf(original, format);
  const b = exportsOf(converted, format);
  for (const [k, text] of a) {
    const [diagram] = k.split('\u0000');
    if (diffBefore[diagram]?.needsMigration || before[diagram]?.loadError) continue;
    if (!b.has(k)) { fail(`export ${format}: ${diagram} is missing after Convert`); continue; }
    if (movedInto.has(diagram)) {
      // It gains the moved relationships, whose export lines differ per format: checked on its display above.
      skippedMoved.add(diagram);
      continue;
    }
    if (!touched(diagram)) {
      byteCompared++;
      if (b.get(k) !== text) fail(`export ${format}: ${diagram} differs after Convert`, firstLineDiff(text, b.get(k)));
    } else {
      // A diagram the plan touches: the same lines, in the library's order (§2.8, "the order of relationships").
      lineCompared++;
      const sorted = (t) => t.split('\n').sort().join('\n');
      if (sorted(b.get(k)) !== sorted(text)) fail(`export ${format}: ${diagram} has other lines after Convert`, firstLineDiff(sorted(text), sorted(b.get(k))));
    }
  }
}
if (byteCompared === 0) fail('export: no export was compared byte for byte (every diagram counted as touched by the plan)');
if (skippedMoved.size > 0) log(`note exports not compared for ${[...skippedMoved].sort().join(', ')}: each gains moved relationships (its display is checked)`);
pass(`exports compared: ${byteCompared} byte for byte (the plan touches nothing there), ${lineCompared} line for line`);

// ── 5. Every written .dbml compiles in 9.1.1, 10.3.1 and 11.0.0 ─────────────
const compiled = runHelper('compile', converted);
for (const [version, errors] of Object.entries(compiled.errors)) {
  if (Object.keys(errors).length > 0) fail(`compile under @dbml/parse ${version}`, errors);
  else pass(`${compiled.files} .dbml files compile with no error under @dbml/parse ${version}`);
}

finish();

function firstLineDiff(a, b) {
  const x = a.split('\n');
  const y = (b ?? '').split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `line ${i + 1}:\n  before: ${x[i]}\n  after:  ${y[i]}`;
  }
  return '(same lines)';
}

function finish() {
  if (failures.length > 0) {
    log(`\n${failures.length} check(s) failed; the copies are in ${tmp}`);
    process.exit(1);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  log('\ne2e-dbml: every check passed');
  process.exit(0);
}
