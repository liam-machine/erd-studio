/**
 * The import corpus report: <cache>/results/*.json (written by
 * test/unit/importCorpus.score.test.ts) → the score table, the failure
 * classes ranked by how many schemas each hits, and one JSON record.
 *
 *   node scripts/corpus/report.mjs [--cache DIR]   # rebuild the report from existing results
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED = new Set(['postgres', 'mysql', 'sqlserver', 'snowflake', 'databricks', 'oracle', 'bigquery', 'redshift', 'sqlite']);

/** The DBML round trip's cell: `same`, the number of differences, `threw`, or – (not run: no converted DBML). */
const tripCell = (t) => (!t ? '–' : t.threw ? 'threw' : t.ok ? 'same' : `${t.differences} differ`);

const frac = (a, b) => `${a}/${b}`;
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');

/** A problem or ledger message with its names, numbers and quotes taken out, so like problems group. */
export function messageShape(m) {
  return m
    .replace(/^\S+:\d+\s+/, '')
    .replace(/`[^`]*`|"[^"]*"|'[^']*'|“[^”]*”/g, '…')
    .replace(/\b(CREATE|ALTER) (TABLE|INDEX) \S+/gi, '$1 $2 …')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\b[a-z_][\w$]*\.[\w$.]+\b/gi, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

/** The failure classes one schema's result shows. */
export function classesOf(r) {
  const out = new Set();
  if (r.status === 'no importer') { out.add(`no import reads ${r.kind}`); return out; }
  if (r.status === 'threw') { out.add('import threw (rule broken)'); return out; }
  if (r.status === 'timed out' || r.status === 'crashed') { out.add(`scorer ${r.status}`); return out; }
  const s = r.score;
  if (r.importer === 'sql' && !SUPPORTED.has(r.dialect)) out.add(`dialect not offered: ${r.dialect} read as ${r.importedAs}`);
  if (r.importer === 'sql' && SUPPORTED.has(r.dialect) && r.detectedDialect && r.detectedDialect !== r.dialect) out.add(`detection picked another dialect (${r.dialect} read as ${r.detectedDialect})`);
  if (r.ledger?.timeLimit) out.add('reading stopped at the time limit');
  if (s.verdict === 'Failed') {
    out.add('nothing imported');
    for (const m of new Set((r.problemMessages ?? []).map(messageShape))) out.add(`failure message: ${m}`);
  }
  const L = s.silentLosses;
  for (const [k, v] of Object.entries(L)) if (k !== 'total' && v > 0) out.add(`silent loss: ${k}`);
  if (s.tables.extra.length) out.add('extra tables (not in the source)');
  if (s.relationships.extra.length) out.add('extra relationships (not in the source)');
  if (s.relationships.wrongDirection) out.add('relationship the wrong way round');
  if (s.primaryKeys.wrong.length) out.add('wrong primary key');
  if (s.tables.missingReported + s.columns.missingReported + s.relationships.missingReported > 0) out.add('left out and reported');
  if (r.echoedSource?.count) out.add('message quotes source text (a 40-character run of a source line)');
  if (r.longMessages?.count) out.add('message over 300 characters (mostly long skip summaries)');
  if (r.ledger?.unlocated) out.add('ledger entry without file:line');
  if (r.roundTrip?.threw) out.add('DBML round trip: the export does not read back');
  else if (r.roundTrip && !r.roundTrip.ok) out.add('DBML round trip: something came back different');
  for (const [key, n] of Object.entries(r.ledger?.byKey ?? {})) {
    const [outcome, unit, cause, what] = key.split('/');
    if (outcome === 'problem' || outcome === 'lost') out.add(`ledger ${outcome}: ${unit} (${cause}${what ? `: ${what}` : ''})`);
    else if (outcome === 'repaired') out.add(`ledger repaired: ${unit} (${cause}${what ? `: ${what}` : ''})`);
    void n;
  }
  return out;
}

function row(r) {
  const truth = r.truth ? `${r.truth.approximate ? `~${r.truth.approximate}` : 'exact'}` : 'none';
  if (!r.score) {
    const c = r.truth?.counts;
    return `| ${r.name} | ${r.kind ?? ''} | ${r.dialect ?? ''} | – | **${r.status}** | ${c ? `0/${c.tables}` : '–'} | ${c ? `0/${c.columns}` : '–'} | ${c ? `0/${c.primaryKeys}` : '–'} | ${c ? `0/${c.relationships}` : '–'} | – | – | – | ${r.ms !== undefined ? (r.ms / 1000).toFixed(1) : '–'} | – | ${truth} |`;
  }
  const s = r.score;
  const readAs = r.importer === 'sql' ? `${r.dialect} → ${r.importedAs}${r.detectedDialect && r.detectedDialect !== r.importedAs ? ` (detected ${r.detectedDialect})` : r.detectedDialect ? ' (detected)' : ''}` : r.dialect;
  const led = r.ledger?.byKey ?? {};
  const sum = (o) => Object.entries(led).filter(([k]) => k.startsWith(`${o}/`)).reduce((n, [, v]) => n + v, 0);
  return `| ${r.name} | ${r.kind} | ${readAs} | ${s.verdict} | ${frac(s.tables.matched, s.tables.source)}${s.tables.extra.length ? ` +${s.tables.extra.length}` : ''} | ${frac(s.columns.matched, s.columns.source)} | ${frac(s.primaryKeys.matched, s.primaryKeys.source)} | ${frac(s.relationships.matched, s.relationships.source)}${s.relationships.extra.length ? ` +${s.relationships.extra.length}` : ''} | ${s.problems.count} | ${s.silentLosses.total} | ${sum('problem')}/${sum('lost')}/${sum('repaired')} | ${(r.ms / 1000).toFixed(1)} | ${tripCell(r.roundTrip)} | ${truth} |`;
}

export function buildReport({ manifest, cache, names }) {
  const results = names.map((n) => {
    const f = join(cache, 'results', `${n}.json`);
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { name: n, status: 'not run' };
  });
  const byName = new Map(manifest.schemas.map((s) => [s.name, s]));
  for (const r of results) { const m = byName.get(r.name); if (m) { r.kind ??= m.kind; r.dialect ??= m.dialect; r.importer ??= m.importer; } }

  const head = '| Schema | Kind | Dialect (source → read as) | Verdict | Tables | Columns | PKs | Relationships | Problems | Silent losses | Ledger problem/lost/repaired | Time (s) | Round trip | Truth |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const scored = results.filter((r) => r.score);
  const verdicts = {};
  for (const r of results) { const v = r.score?.verdict ?? r.status; verdicts[v] = (verdicts[v] ?? 0) + 1; }
  const tot = (f) => scored.reduce((n, r) => n + f(r.score), 0);
  const totals = {
    schemas: results.length,
    verdicts,
    tables: [tot((s) => (s.verdict === 'Failed' ? 0 : s.tables.matched)), tot((s) => s.tables.source)],
    columns: [tot((s) => (s.verdict === 'Failed' ? 0 : s.columns.matched)), tot((s) => s.columns.source)],
    primaryKeys: [tot((s) => (s.verdict === 'Failed' ? 0 : s.primaryKeys.matched)), tot((s) => s.primaryKeys.source)],
    relationships: [tot((s) => (s.verdict === 'Failed' ? 0 : s.relationships.matched)), tot((s) => s.relationships.source)],
    silentLosses: tot((s) => s.silentLosses.total),
    seconds: Math.round(results.reduce((n, r) => n + (r.ms ?? 0), 0) / 1000),
    roundTrip: [results.filter((r) => r.roundTrip?.ok).length, results.filter((r) => r.roundTrip).length],
  };
  const totalRow = `| **All ${results.length}** | | | ${Object.entries(verdicts).map(([k, v]) => `${v} ${k}`).join(', ')} | ${totals.tables[0]}/${totals.tables[1]} (${pct(...totals.tables)}) | ${totals.columns[0]}/${totals.columns[1]} (${pct(...totals.columns)}) | ${totals.primaryKeys[0]}/${totals.primaryKeys[1]} (${pct(...totals.primaryKeys)}) | ${totals.relationships[0]}/${totals.relationships[1]} (${pct(...totals.relationships)}) | | ${totals.silentLosses} | | ${totals.seconds} | ${totals.roundTrip[0]}/${totals.roundTrip[1]} same | |`;
  const table = [head, sep, ...results.map(row), totalRow].join('\n');

  const classes = new Map();
  for (const r of results) {
    for (const c of classesOf(r)) {
      if (!classes.has(c)) classes.set(c, { cls: c, count: 0, dialects: new Set(), examples: [] });
      const e = classes.get(c);
      e.count++;
      e.dialects.add(r.dialect);
      if (e.examples.length < 6) e.examples.push(r.name);
    }
  }
  const ranked = [...classes.values()].sort((a, b) => b.count - a.count || a.cls.localeCompare(b.cls)).map((e) => ({ ...e, dialects: [...e.dialects].sort() }));
  const classesTable = ['| Failure class | Schemas | Dialects | Examples |', '|---|---|---|---|',
    ...ranked.map((e) => `| ${e.cls.replace(/\|/g, '\\|')} | ${e.count} | ${e.dialects.join(', ')} | ${e.examples.join(', ')} |`)].join('\n');
  return { table, classesTable, json: { manifestPinned: manifest.pinned, totals, classes: ranked, results }, ranked, totals };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const i = process.argv.indexOf('--cache');
  const cache = resolve(i >= 0 ? process.argv[i + 1] : join(here, '../../.cache/import-corpus'));
  const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
  const names = manifest.schemas.map((s) => s.name);
  const report = buildReport({ manifest, cache, names });
  const out = join(cache, 'report');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'score-table.md'), report.table + '\n');
  writeFileSync(join(out, 'failure-classes.md'), report.classesTable + '\n');
  writeFileSync(join(out, 'scores.json'), JSON.stringify(report.json, null, 1) + '\n');
  console.log(report.table + '\n\n' + report.classesTable);
}
