/**
 * The real-world import scorecard: each sample under
 * test/fixtures/real-world-imports/ driven through the same pure functions
 * its import command calls (up to the plan and the draft the user sees, minus
 * VS Code I/O), then compared with the independently counted source truth in
 * expected.json.
 *
 * The flows mirrored here:
 * - SQL DDL: `gatherSqlFiles` (folder or files, data stripped) → the detected
 *   dialect → `sqlDdlToDbml` → Import DBML's flow on the converted DBML.
 * - Power BI: `walkSemanticModelFiles` + `findSemanticModels` → `readSemanticModel` →
 *   `semanticModelToDbml` → Import DBML's flow.
 * - DBML file: `readDbml` → `analyseDbml` → `planDbmlImport`.
 * - Import from dbt: `listDraftScopes` → the top-ranked folder
 *   (`dbtDraftScopes`) → `buildDbtDraft` → `draftFromDbt`.
 * Import DBML's flow is `planDbmlImport` for a fresh DBML project (one Main
 * layer, relationships in the library) → `draftFromImportPlan`.
 *
 * Every metric is defined in `scoreSample` below; the verdict in `verdictOf`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_LAYERS } from '@erd-studio/core';
import type { ColumnDef, Relationship, SemanticTable } from '../../src/types/semantic';
import type { LayerConfig } from '../../src/types/layer';
import { toDraftView, type Draft, type DraftTarget } from '../../src/types/draft';
import { gatherSqlFiles } from '../../src/commands/importSqlDdl';
import { walkSemanticModelFiles } from '../../src/commands/importSemanticModel';
import { IMPORT_TITLES } from '../../src/commands/importDbml';
import * as sqlEngine from '../../src/services/sqlImportEngine';
import { SQL_DIALECT_LABELS, type SqlDialect, type SqlPartitionMode } from '../../src/services/sqlDdlImport';
import { readDbml, readDbmlImportLayout } from '../../src/services/dbmlImportParse';
import {
  analyseDbml,
  importLeftOut,
  importPlanNotes,
  planDbmlImport,
  suggestDbmlSubjectAreaName,
  type DbmlImportPlan,
  type DescribeDbmlImportOptions,
} from '../../src/services/dbmlImport';
import {
  describeImportProblems,
  semanticModelRenameNote,
  semanticModelSkippedSummary,
  sqlOriginPhrase,
  PROBLEMS_SHOWN,
  type DirEntries,
} from '../../src/services/importSources';
import { SEMANTIC_MODEL_META, findSemanticModels, readSemanticModel, semanticModelToDbml, type SemanticModelFile } from '../../src/services/semanticModelImport';
import { draftFromDbt, draftFromImportPlan, dbtDraftScopes } from '../../src/services/draftModel';
import type { LedgerEntry } from '../../src/services/importLedger';
import { buildDbtDraft, listDraftModels, listDraftScopes, suggestSubjectAreaName } from '../../src/services/dbtDraft';
import { YmlParserService } from '../../src/services/ymlParserService';
import { ManifestService } from '../../src/services/manifestService';

export const SAMPLES_ROOT = path.join(__dirname, '../fixtures/real-world-imports');

// ---------------------------------------------------------------------------
// Source truth (expected.json)
// ---------------------------------------------------------------------------

/** [name, type, flags, description?]; flags: P primary key, N not null, U unique, C calculated. */
export type TruthColumn = [name: string, type: string, flags: string, description?: string];

export interface TruthTable {
  name: string;
  schema?: string;
  description?: string;
  pk: string[];
  columns: TruthColumn[];
  calculationGroup?: boolean;
  calculatedTable?: boolean;
}

export interface TruthRelationship {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
  /** Pairs of one composite FK share this. */
  composite?: string;
  /** Written one-to-one in the source (a DBML `-`). */
  oneToOne?: boolean;
  inactive?: boolean;
  filtered?: boolean;
}

export interface TruthSample {
  importer: 'sql' | 'dbml' | 'semanticModel' | 'dbt';
  /** `partitions`: the SQL import's choice for partitions (absent: fold them, the default and the one-click import's). */
  input: { files?: string[]; folder?: string; file?: string; dialect?: SqlDialect; project?: string; manifest?: string; scope?: string; partitions?: SqlPartitionMode; timeLimitMs?: number };
  counts: { tables: number; columns: number; primaryKeys: number; relationships: number };
  tables: TruthTable[];
  relationships: TruthRelationship[];
  uniqueKeys: Array<{ table: string; columns: string[]; index?: boolean }>;
  /** Columns whose type carries a detail the import must keep: the imported type must match `expect` (a regex). */
  typeDetail?: Array<{ table: string; column: string; expect: string }>;
  /** Schemas the tables live in when the source does not qualify them (`schemasImplied`). */
  schemas?: string[];
  schemasImplied?: boolean;
  notes?: string;
}

export interface Truth {
  samples: Record<string, TruthSample>;
}

export function loadTruth(): Truth {
  return JSON.parse(fs.readFileSync(path.join(SAMPLES_ROOT, 'expected.json'), 'utf-8')) as Truth;
}

// ---------------------------------------------------------------------------
// One import run, reduced to what the scorecard compares
// ---------------------------------------------------------------------------

export interface RunProblem {
  file?: string;
  line?: number;
  message: string;
}

export interface ImportRun {
  /** A plan (or dbt draft) was produced: the user could press Keep. */
  ok: boolean;
  /** The dialect read as (SQL only), and what detection said. */
  dialect?: SqlDialect;
  detectedDialect?: SqlDialect | null;
  tables: SemanticTable[];
  relationships: Relationship[];
  /** Blocking problems: why the import failed. */
  problems: RunProblem[];
  /** Warnings shown with a draft that did import (Power BI's read/convert warnings). */
  warnings: string[];
  /** The failure message the user reads (`describeImportProblems`), when the import failed. */
  failureMessage?: string;
  /** The draft's notes and "Not imported" lines (empty for dbt, whose draft has no notes). */
  notes: string[];
  leftOut: string[];
  /** Every string the user can read: the draft's banner and details, or the failure message. */
  shown: string[];
  /** Names the draft says it left out (dbt's "Not drawn"). */
  leftOutTables: string[];
  /** The plan's own counts, for the record. */
  report?: { relationships: number; optionalRefs: number; requiredRefs: number };
  /** The import's loss ledger: the conversion's and the plan's own (`importLedger.ts`). */
  ledger?: LedgerEntry[];
  /** dbt: the scope the draft drew (the default, top-ranked folder) and its models. */
  scope?: { id: string; models: string[] };
}

const MAIN_LAYER: LayerConfig = { id: 'main', label: 'Main', abbreviation: 'MN', color: '#888888', creatable: true, order: 1 } as LayerConfig;

const fsDir = async (folder: string): Promise<DirEntries> =>
  fs.readdirSync(folder, { withFileTypes: true }).map((e) => [e.name, e.isDirectory()] as const);
const fsRead = async (file: string): Promise<string> => fs.readFileSync(file, 'utf-8');

/** Every string a viewer reads on the draft page (ids and the diagram's own names aside). */
function draftStrings(draft: Draft): string[] {
  const view = toDraftView(draft);
  return [
    view.title,
    view.banner.headline,
    view.banner.from ?? '',
    view.banner.detail,
    view.banner.notice ?? '',
    // An item reads as one row (`person.gender_concept_id → concept.concept_id: dbt tests it only where …`), so it is also one string.
    ...view.details.flatMap((s) => [s.title, s.hint ?? '', ...s.items.flatMap((i) => [i.path ?? '', i.text, i.tag ?? '', i.path && i.text ? `${i.path}: ${i.text}` : ''])]),
  ].filter((s) => s !== '');
}

/** Import DBML's flow for a fresh DBML project: one Main layer, every relationship in the library (D5). */
export function importDbmlFlow(
  dbml: string,
  fileName: string,
  importSource: 'file' | 'sql' | 'semanticModel',
  origin?: { from: string; description?: string; notes: readonly string[]; skipped: readonly string[]; ledger?: readonly LedgerEntry[] },
): ImportRun {
  const read = readDbml(dbml);
  if (!read.ok) {
    const problems = read.diagnostics.map((d) => ({ file: fileName, line: d.line, message: d.message }));
    const failureMessage = describeImportProblems(IMPORT_TITLES[importSource === 'file' ? 'file' : importSource], problems);
    return { ok: false, tables: [], relationships: [], problems, warnings: [], failureMessage, notes: [], leftOut: [], shown: [failureMessage], leftOutTables: [] };
  }
  const layout = readDbmlImportLayout(dbml);
  analyseDbml(read.model, { layerIds: ['main'], fileName });
  const name = suggestDbmlSubjectAreaName(read.model, fileName);
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'import';
  const plan: DbmlImportPlan = planDbmlImport({
    model: read.model,
    ...(layout ? { layout } : {}),
    layer: 'main',
    subjectAreaName: slug,
    fileName,
    ...(origin?.description ? { description: origin.description } : {}),
    library: { findTableName: () => null, getTable: () => null },
    libraryRelationships: true,
    diagramCopies: [],
    diagramHoldsNoRelationships: true,
  });
  const describe: DescribeDbmlImportOptions = {
    layerLabel: 'Main',
    dbml: { relationshipsFiles: ['main/relationships/main.dbml'], respelledSchemas: [] },
    ...(origin ? { origin } : {}),
  };
  const target: DraftTarget = { layer: 'main', layerLabel: 'Main', name: slug, diagramFile: `.erd-studio/main/diagrams/${slug}.dbml` };
  const draft = draftFromImportPlan({
    plan,
    importSource,
    trigger: 'sidebar',
    target,
    fileName,
    ...(origin ? { origin } : {}),
    describe,
    libraryTable: () => undefined,
    layers: [MAIN_LAYER],
    logicalOnly: true,
    hasFolder: true,
    changeOptions: true,
  });
  return {
    ok: true,
    tables: [...plan.newTables],
    relationships: [...plan.relationships],
    problems: [],
    warnings: [],
    notes: importPlanNotes(plan, describe),
    leftOut: importLeftOut(plan, describe),
    shown: draftStrings(draft),
    leftOutTables: [],
    report: { relationships: plan.report.relationships, optionalRefs: plan.report.optionalRefs, requiredRefs: plan.report.requiredRefs },
    ledger: [...plan.report.ledger, ...(origin?.ledger ?? [])],
  };
}

async function runSql(sample: TruthSample, root: string): Promise<ImportRun> {
  const sources = sample.input.folder
    ? { folder: path.join(root, sample.input.folder) }
    : { files: (sample.input.files ?? []).map((f) => path.join(root, f)) };
  const gathered = await gatherSqlFiles(sources, { readDirectory: fsDir, readFile: fsRead, fileSize: async (f) => fs.statSync(f).size });
  if ('message' in gathered) {
    return { ok: false, tables: [], relationships: [], problems: [{ message: gathered.message }], warnings: [], failureMessage: gathered.message, notes: [], leftOut: [], shown: [gathered.message], leftOutTables: [] };
  }
  // The dialect a user picks: the detected one, listed first and marked "detected".
  const detected = sqlEngine.detectSqlDialect(gathered.files.map((f) => f.text).join('\n')) ?? null;
  const dialect = detected ?? sample.input.dialect ?? 'postgres';
  const label = SQL_DIALECT_LABELS[dialect];
  // `timeLimitMs`: the extension's reading time limit (erdStudio.import.timeLimitSeconds), as its worker applies it.
  const deadline = sample.input.timeLimitMs ? Date.now() + sample.input.timeLimitMs : undefined;
  const options = {
    ...(sample.input.partitions ? { partitions: sample.input.partitions } : {}),
    ...(deadline ? { shouldStop: () => (Date.now() > deadline ? 'timeLimit' as const : undefined), timeLimitMs: sample.input.timeLimitMs } : {}),
  };
  const result = sqlEngine.sqlDdlToDbml({ files: gathered.files, dialect, ...(Object.keys(options).length ? { options } : {}) });
  if (!result.ok) {
    const failureMessage = describeImportProblems(IMPORT_TITLES.sql, result.problems, `They were read as ${label}.`);
    return {
      ok: false, dialect, detectedDialect: detected, tables: [], relationships: [],
      problems: result.problems.map((p) => ({ file: p.file, ...(p.line !== undefined ? { line: p.line } : {}), message: p.message })),
      warnings: [], failureMessage, notes: [], leftOut: [], shown: [failureMessage], leftOutTables: [], ledger: [...(result.ledger ?? [])],
    };
  }
  const run = importDbmlFlow(result.dbml, `${gathered.fileName}`, 'sql', {
    from: sqlOriginPhrase(gathered.files.length, label),
    description: `Imported from ${gathered.sourceLabel} (${label}).`,
    notes: result.notes,
    skipped: result.skipped,
    ledger: result.ledger,
  });
  return { ...run, dialect, detectedDialect: detected };
}

async function runDbmlFile(sample: TruthSample, root: string): Promise<ImportRun> {
  const file = path.join(root, sample.input.file!);
  const text = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
  return importDbmlFlow(text, path.basename(file), 'file');
}

async function runSemanticModel(sample: TruthSample, root: string): Promise<ImportRun> {
  const folder = path.join(root, sample.input.folder!);
  const folderName = path.basename(folder);
  const walk = await walkSemanticModelFiles(folder, fsDir);
  const relative = (full: string): string => path.join(folderName, path.relative(folder, full)).split(path.sep).join('/');
  const fullOf = new Map(walk.files.map((full) => [relative(full), full]));
  const entries = findSemanticModels([...fullOf.keys()]);
  if (entries.length === 0) {
    const message = `${IMPORT_TITLES.semanticModel}: no semantic model found in ${folderName}.`;
    return { ok: false, tables: [], relationships: [], problems: [{ message }], warnings: [], failureMessage: message, notes: [], leftOut: [], shown: [message], leftOutTables: [] };
  }
  const entry = entries[0];
  const files: SemanticModelFile[] = entry.files.map((f) => ({ path: f, text: fs.readFileSync(fullOf.get(f) ?? f, 'utf-8') }));
  const read = readSemanticModel(files);
  if (!read.ok) {
    const failureMessage = describeImportProblems(IMPORT_TITLES.semanticModel, read.problems);
    return { ok: false, tables: [], relationships: [], problems: read.problems.map((p) => ({ ...p })), warnings: [], failureMessage, notes: [], leftOut: [], shown: [failureMessage], leftOutTables: [] };
  }
  const converted = semanticModelToDbml(read.model);
  const warnings = [...read.warnings, ...converted.warnings];
  const renameNote = semanticModelRenameNote(converted.renamed);
  const run = importDbmlFlow(converted.dbml, `${entry.name}.dbml`, 'semanticModel', {
    from: `from the semantic model ${entry.name}`,
    notes: [...(renameNote ? [renameNote] : []), ...warnings],
    skipped: semanticModelSkippedSummary(converted.skippedCounts),
    ledger: converted.ledger,
  });
  return { ...run, warnings };
}

async function runDbt(sample: TruthSample, root: string): Promise<ImportRun> {
  const projectRoot = path.join(root, sample.input.project!);
  const ymlData = await new YmlParserService().loadYmlData(projectRoot);
  // The manifest `dbt parse` wrote, kept beside the sample (its target/ is not committed).
  // Without one (the import corpus never runs dbt parse), the draft reads the yml alone.
  let manifest;
  if (sample.input.manifest) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-scorecard-'));
    try {
      fs.mkdirSync(path.join(tmp, 'target'));
      fs.copyFileSync(path.join(root, sample.input.manifest), path.join(tmp, 'target', 'manifest.json'));
      manifest = await new ManifestService({ parseInProcess: true }).loadManifest(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const layerIds = DEFAULT_LAYERS.map((l) => l.id);
  const source = { ymlData, manifest, projectRoot, modelPaths: ['models'], layerIds };
  if (listDraftModels(source).length === 0) {
    const message = 'No dbt models with columns.';
    return { ok: false, tables: [], relationships: [], problems: [{ message }], warnings: [], failureMessage: message, notes: [], leftOut: [], shown: [message], leftOutTables: [] };
  }
  const scopes = listDraftScopes(source);
  const scope = scopes.find((s) => s.id === sample.input.scope) ?? dbtDraftScopes(scopes).defaultScope!;
  const draft = buildDbtDraft({ modelNames: scope.modelNames, ymlData, manifest, libraryHas: () => false, dbml: { tableStorage: () => undefined } });
  const layer = DEFAULT_LAYERS.find((l) => l.id === scope.suggestedLayer) ?? DEFAULT_LAYERS[DEFAULT_LAYERS.length - 1];
  const name = suggestSubjectAreaName(scope);
  const view = draftFromDbt({
    draft,
    relationships: draft.relationships,
    scope,
    scopes,
    trigger: 'sidebar',
    target: { layer: layer.id, layerLabel: layer.label, name, diagramFile: `.erd-studio/${layer.id}/diagrams/${name}.dbml` },
    libraryTable: () => undefined,
    layers: DEFAULT_LAYERS,
  });
  return {
    ok: draft.modelNames.length > 0,
    tables: [...draft.newModels],
    relationships: [...draft.relationships],
    problems: [],
    warnings: [],
    // The draft's Notes section (the D18 sentence, the layer-schema note, ledger notes).
    notes: (view.details ?? []).filter((d) => d.id === 'notes').flatMap((d) => d.items.map((i) => i.text)),
    leftOut: draft.skipped.map((s) => `${s.name}: ${s.reason}`),
    shown: draftStrings(view),
    leftOutTables: draft.skipped.map((s) => s.name),
    ledger: [...draft.ledger],
    scope: { id: scope.id, models: [...scope.modelNames] },
  };
}

/** One sample through its import's pipeline; `root` is the folder its `input` paths are under (the import corpus passes its cache). */
export async function runSample(sample: TruthSample, root: string = SAMPLES_ROOT): Promise<ImportRun> {
  switch (sample.importer) {
    case 'sql': return runSql(sample, root);
    case 'dbml': return runDbmlFile(sample, root);
    case 'semanticModel': return runSemanticModel(sample, root);
    case 'dbt': return runDbt(sample, root);
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Names compare by letters and digits only: `Internet Sales` = `internet_sales`, `DateKey` = `date_key`. */
export const canon = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const flag = (c: TruthColumn, f: string): boolean => c[2].includes(f);

/** A type as compared: case, brackets, quotes and spacing aside. */
export function normaliseType(t: string): string {
  return t.toLowerCase().replace(/[[\]"`]/g, '').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
}

/** The details a type carries that an import must keep: size/precision, UNSIGNED, a time zone, an array. */
export function typeDetails(t: string): string[] {
  const n = normaliseType(t);
  const out: string[] = [];
  const args = n.match(/\(([^()]*)\)/);
  if (args && /\d/.test(args[1])) out.push(`(${args[1]})`);
  if (/\bunsigned\b/.test(n)) out.push('unsigned');
  if (/\bwith time zone\b|\btimestamptz\b|\btimetz\b/.test(n)) out.push('time zone');
  if (/\[\]$|\barray\b/.test(n)) out.push('array');
  return out;
}

const hasDetail = (imported: string, detail: string): boolean => {
  const n = normaliseType(imported);
  if (detail === 'time zone') return /\bwith time zone\b|\btimestamptz\b|\btimetz\b/.test(n);
  if (detail === 'array') return /\[\]$|\barray\b/.test(n);
  if (detail === 'unsigned') return /\bunsigned\b/.test(n);
  return n.includes(detail);
};

const dbmlMeta = (m: { meta?: unknown } | undefined): Record<string, unknown> => {
  const meta = (m?.meta ?? {}) as Record<string, unknown>;
  return (meta.dbml ?? {}) as Record<string, unknown>;
};

/** NOT NULL as the import keeps it: DBML's `not null` in meta.dbml, or a dbt `not_null` test kept in meta. */
export const keptNotNull = (c: ColumnDef): boolean => {
  const d = dbmlMeta(c);
  const meta = (c.meta ?? {}) as Record<string, unknown>;
  return d.not_null === true || meta.not_null === true || (c as unknown as { notNull?: boolean }).notNull === true;
};

/** Unique as the import keeps it: a column's own `unique`, or a unique index over exactly these columns. */
function keptUnique(table: SemanticTable, columns: string[]): boolean {
  const want = columns.map(canon).sort().join(',');
  const pk = (table.columns ?? []).filter((x) => x.isPrimaryKey).map((x) => canon(x.name)).sort().join(',');
  return pk === want || importedUniqueKeys(table).some((cols) => cols.join(',') === want);
}

/** The unique keys an imported table keeps: each column's own `unique`, and each unique index (canonical, sorted). */
function importedUniqueKeys(table: SemanticTable): string[][] {
  const out: string[][] = [];
  for (const c of table.columns ?? []) if (dbmlMeta(c).unique === true) out.push([canon(c.name)]);
  const indexes = dbmlMeta(table).indexes;
  if (Array.isArray(indexes)) {
    for (const ix of indexes as Array<Record<string, unknown>>) {
      if (ix.unique !== true || ix.pk === true || !Array.isArray(ix.columns)) continue;
      const cols = (ix.columns as unknown[]).map((c) => (typeof c === 'string' ? c : String((c as Record<string, unknown>)?.value ?? '')));
      if (cols.some((c) => /[()`]/.test(c))) continue;
      out.push(cols.map(canon).sort());
    }
  }
  return out;
}

/** Whether any shown string names all of these (each as a whole word, any case; `_` and spaces alike). */
function mentioned(shown: readonly string[], ...names: string[]): boolean {
  // A file name (`sakila-schema.sql`) names no table, column or schema.
  const texts = shown.map((s) => s.replace(/\S+\.(sql|dbml|tmdl|bim|ya?ml|json)\b/gi, ' '));
  const res = names.map((n) => new RegExp(`(^|[^A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[_ ]/g, '[_ ]?')}($|[^A-Za-z0-9])`, 'i'));
  return texts.some((s) => res.every((re) => re.test(s)));
}

export type Verdict = 'Failed' | 'With problems' | 'With gaps' | 'Clean';

export interface SampleScore {
  slug: string;
  importer: TruthSample['importer'];
  dialect?: string;
  detectedDialect?: string | null;
  verdict: Verdict;
  /** Why the verdict is not Clean, one short reason each. */
  reasons: string[];
  tables: { source: number; imported: number; matched: number; missing: number; missingReported: number; extra: string[] };
  columns: { source: number; imported: number; matched: number; missing: number; missingReported: number; extra: number };
  primaryKeys: { source: number; imported: number; matched: number; composite: number; missing: number; wrong: string[]; extra: number };
  relationships: {
    source: number; imported: number; matched: number;
    missing: number; missingReported: number; missingSilent: string[];
    extra: string[]; wrongDirection: number;
  };
  oneToOne: { source: number; imported: number; drawnAsMany: string[] };
  /**
   * Links the source tests only for some rows (`filtered` in the truth: dbt's
   * `relationships_where`, a `where:` config) among the matched ones; `shown`:
   * the draft shows the condition (a string names the link's table and column
   * with "where"); `reported`: not shown, but a line names the link with
   * "relationships_where"; `silent`: neither.
   */
  conditions: { source: number; shown: number; reported: number; silent: string[] };
  /**
   * FKs whose columns are all NOT NULL (dbt: not_null) among the matched links; how many keep NOT NULL
   * in the table files; whether a note says relationships are saved optional (D18), and the number of
   * required references it claims (null when it gives none).
   */
  requiredFks: { source: number; keptNotNull: number; toldOptional: boolean; optionalNote?: string; noteClaims: number | null };
  /** Unique keys on imported tables (expression indexes aside); `extra`: imported unique keys the source does not have (e.g. dropped later). */
  uniqueKeys: { source: number; kept: number; lost: number; extra: string[] };
  types: { checked: number; verbatim: number; detailSource: number; detailKept: number; detailLost: string[] };
  descriptions: { source: number; imported: number; exact: number; changed: number; missing: number };
  schemas: { source: string[]; imported: string[]; kept: number; lostSilently: string[] };
  /** Blocking problems (failed imports): how many name a cause and a file + line, how many the message shows (3) or hides. */
  problems: { warnings: number; count: number; withCause: number; withLocation: number; shown: number; hidden: number; longest: number; messages: string[] };
  notes: string[];
  leftOut: string[];
  /** A note says details "are not lost" while details were lost silently. */
  falseNotLostNote: boolean;
  silentLosses: {
    tables: number; columns: number; primaryKeys: number; relationships: number; oneToOne: number;
    requiredFks: number; uniqueKeys: number; typeDetail: number; descriptions: number; schemas: number;
    /** Filtered links drawn with no word of their condition. */
    conditions: number;
    total: number;
  };
}

/**
 * A problem message that names no cause: it only says the parser could not
 * read something (`CREATE TABLE X could not be read: the SQL parser could not
 * read this statement`), with nothing about what in it.
 */
const GENERIC_PROBLEM = /(could not|couldn't|can't|cannot) (read|parse) (this|the) (statement|file|line|script)\.?$/i;

/**
 * A semantic model's run with each table and column under the Power BI name
 * the import keeps (`meta.power_bi_name`, written when snake_case changed it:
 * `1) Selected Metric` became `t_1_selected_metric`, `YOY%` became
 * `yoy_pct`), so it is compared with the source by its own name.
 */
export function withSourceNames(run: ImportRun): ImportRun {
  const original = (m: { meta?: unknown }): string | undefined => {
    const v = ((m.meta ?? {}) as Record<string, unknown>)[SEMANTIC_MODEL_META.name];
    return typeof v === 'string' && v.trim() ? v : undefined;
  };
  const tableName = new Map<string, string>();
  const columnName = new Map<string, string>();
  const tables = run.tables.map((t) => {
    const name = original(t) ?? t.name;
    tableName.set(t.name, name);
    const columns = (t.columns ?? []).map((c) => {
      const col = original(c) ?? c.name;
      columnName.set(`${t.name}\u0000${c.name}`, col);
      return { ...c, name: col };
    });
    return { ...t, name, columns };
  });
  const relationships = run.relationships.map((r) => ({
    ...r,
    fromModel: tableName.get(r.fromModel) ?? r.fromModel,
    fromColumn: columnName.get(`${r.fromModel}\u0000${r.fromColumn}`) ?? r.fromColumn,
    toModel: tableName.get(r.toModel) ?? r.toModel,
    toColumn: columnName.get(`${r.toModel}\u0000${r.toColumn}`) ?? r.toColumn,
  }));
  return { ...run, tables, relationships };
}

export function scoreSample(slug: string, truth: TruthSample, given: ImportRun): SampleScore {
  const run = truth.importer === 'semanticModel' ? withSourceNames(given) : given;
  const shown = run.shown;
  const failed = !run.ok || run.tables.length === 0;
  const reasons: string[] = [];

  // Tables -----------------------------------------------------------------
  const importedByCanon = new Map(run.tables.map((t) => [canon(t.name), t]));
  const truthByCanon = new Map(truth.tables.map((t) => [canon(t.name), t]));
  const leftOutTables = new Set(run.leftOutTables.map(canon));
  const missingTables = truth.tables.filter((t) => !importedByCanon.has(canon(t.name)));
  // Told by name, or by kind: "2 calculation groups: they hold DAX, not data".
  const tableReported = (t: TruthTable): boolean => failed || leftOutTables.has(canon(t.name)) || mentioned(shown, t.name)
    || (!!t.calculationGroup && shown.some((s) => /calculation groups?\b/i.test(s)))
    || (!!t.calculatedTable && shown.some((s) => /calculated tables?\b/i.test(s)));
  const missingTablesReported = missingTables.filter(tableReported);
  const extraTables = run.tables.filter((t) => !truthByCanon.has(canon(t.name))).map((t) => t.name);

  // Columns ----------------------------------------------------------------
  let colSource = 0; let colMatched = 0; let colMissing = 0; let colMissingReported = 0; let colExtra = 0;
  let typesChecked = 0; let typesVerbatim = 0; let detailSource = 0; let detailKept = 0;
  const detailLost: string[] = [];
  let descSource = 0; let descImported = 0; let descExact = 0; let descChanged = 0; let descMissing = 0;
  const descNorm = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
  const checkDesc = (src: string | undefined, got: string | undefined): void => {
    if (!descNorm(src)) return;
    descSource++;
    if (descNorm(got)) descImported++;
    if (descNorm(src) === descNorm(got)) descExact++;
    else if (descNorm(got)) descChanged++;
    else descMissing++;
  };
  const typeDetailWanted = new Map((truth.typeDetail ?? []).map((d) => [`${canon(d.table)}.${canon(d.column)}`, new RegExp(d.expect, 'i')]));
  for (const t of truth.tables) {
    colSource += t.columns.length;
    const got = importedByCanon.get(canon(t.name));
    if (!got) continue;
    checkDesc(t.description, got.description);
    const gotCols = new Map((got.columns ?? []).map((c) => [canon(c.name), c]));
    // The same name first: `name` and `_name` (Django) are one name by letters and digits.
    const gotExact = new Map((got.columns ?? []).map((c) => [c.name.toLowerCase(), c]));
    for (const c of t.columns) {
      const gc = gotExact.get(c[0].toLowerCase()) ?? gotCols.get(canon(c[0]));
      if (!gc) {
        colMissing++;
        if (mentioned(shown, t.name, c[0]) || mentioned(shown, `${t.name}.${c[0]}`)) colMissingReported++;
        continue;
      }
      colMatched++;
      checkDesc(c[3], gc.description);
      const wanted = typeDetailWanted.get(`${canon(t.name)}.${canon(c[0])}`);
      if (truth.importer === 'semanticModel') {
        if (wanted) {
          typesChecked++; detailSource++;
          if (wanted.test(gc.dataType.trim())) { typesVerbatim++; detailKept++; } else detailLost.push(`${t.name}.${c[0]}: ${c[1]} (${wanted.source}) → ${gc.dataType}`);
        }
        continue;
      }
      // A computed column has no declared type: the truth records '(computed)' or its expression
      // ('AS ISNULL(...)'), which the importer types `computed` with a note; not a type detail.
      if (!c[1] || c[1] === '(computed)' || /^AS\b/i.test(c[1].trim())) continue;
      typesChecked++;
      if (normaliseType(c[1]) === normaliseType(gc.dataType)) typesVerbatim++;
      for (const d of typeDetails(c[1])) {
        detailSource++;
        if (hasDetail(gc.dataType, d)) detailKept++;
        else detailLost.push(`${t.name}.${c[0]}: ${c[1]} → ${gc.dataType}`);
      }
    }
    for (const gc of got.columns ?? []) if (!t.columns.some((c) => canon(c[0]) === canon(gc.name))) colExtra++;
  }
  const colImported = run.tables.reduce((n, t) => n + (t.columns?.length ?? 0), 0);
  // Told when a shown string names the column with the word type or the detail itself.
  const detailLostSilent = detailLost.filter((d) => {
    const [t, c] = d.split(':')[0].split('.');
    return !(mentioned(shown, t, c, 'type') || ['unsigned', 'time zone', 'size', 'precision'].some((w) => mentioned(shown, t, c, w)));
  }).length;

  // Primary keys -------------------------------------------------------------
  const pkOf = (t: SemanticTable): string[] => (t.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => canon(c.name)).sort();
  let pkMatched = 0; let pkMissing = 0; let pkExtra = 0; let pkComposite = 0;
  const pkWrong: string[] = [];
  let pkSilent = 0;
  for (const t of truth.tables) {
    const got = importedByCanon.get(canon(t.name));
    if (!got) continue;
    const want = t.pk.map(canon).sort();
    const have = pkOf(got);
    if (want.length === 0) { if (have.length > 0) pkExtra++; continue; }
    if (have.join(',') === want.join(',')) { pkMatched++; if (want.length > 1) pkComposite++; continue; }
    if (have.length === 0) { pkMissing++; if (!mentioned(shown, t.name, 'key')) pkSilent++; continue; }
    pkWrong.push(`${t.name}: (${have.join(', ')}) instead of (${want.join(', ')})`);
    pkSilent++;
  }
  const pkImported = run.tables.filter((t) => pkOf(t).length > 0).length;

  // Relationships ------------------------------------------------------------
  type Link = { key: string; pairs: string[]; from: string; fromColumns: string[]; to: string; oneToOne: boolean };
  const pairKey = (from: string, fc: string, to: string, tc: string): string => `${canon(from)}.${canon(fc)}>${canon(to)}.${canon(tc)}`;
  const truthLinks: Link[] = [];
  {
    const groups = new Map<string, TruthRelationship[]>();
    for (const r of truth.relationships) {
      const k = r.composite ? `${canon(r.from)}:${r.composite}` : pairKey(r.from, r.fromColumn, r.to, r.toColumn);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    for (const [key, rs] of groups) {
      const from = truth.tables.find((t) => canon(t.name) === canon(rs[0].from));
      const fromCols = rs.map((r) => canon(r.fromColumn)).sort();
      // One-to-one: written so, or the FK columns are exactly the from table's key or a unique key.
      const isKey = !!from && from.pk.map(canon).sort().join(',') === fromCols.join(',');
      const isUnique = truth.uniqueKeys.some((u) => canon(u.table) === canon(rs[0].from) && u.columns.map(canon).sort().join(',') === fromCols.join(','))
        || (!!from && fromCols.length === 1 && from.columns.some((c) => canon(c[0]) === fromCols[0] && flag(c, 'U')));
      truthLinks.push({ key, pairs: rs.map((r) => pairKey(r.from, r.fromColumn, r.to, r.toColumn)), from: rs[0].from, fromColumns: rs.map((r) => r.fromColumn), to: rs[0].to, oneToOne: !!rs[0].oneToOne || isKey || isUnique });
    }
  }
  const importedLinks: Array<{ pairs: string[]; reversed: string[]; cardinality: string; label: string }> = [];
  {
    const groups = new Map<string, Relationship[]>();
    for (const r of run.relationships) {
      const k = r.compositeKey ? `${canon(r.fromModel)}:${r.compositeKey}` : pairKey(r.fromModel, r.fromColumn, r.toModel, r.toColumn);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    for (const rs of groups.values()) {
      // A one-to-many entry points from the one side: turn it round so the FK side comes first.
      const norm = rs.map((r) => (r.cardinality === 'one-to-many'
        ? { f: r.toModel, fc: r.toColumn, t: r.fromModel, tc: r.fromColumn }
        : { f: r.fromModel, fc: r.fromColumn, t: r.toModel, tc: r.toColumn }));
      importedLinks.push({
        pairs: norm.map((n) => pairKey(n.f, n.fc, n.t, n.tc)),
        reversed: norm.map((n) => pairKey(n.t, n.tc, n.f, n.fc)),
        cardinality: rs[0].cardinality,
        label: `${norm[0].f}.${norm.map((n) => n.fc).join('+')} → ${norm[0].t}.${norm.map((n) => n.tc).join('+')}`,
      });
    }
  }
  const importedPairs = new Set(importedLinks.flatMap((l) => l.pairs));
  const truthPairs = new Set(truthLinks.flatMap((l) => l.pairs));
  const matchedLinks = truthLinks.filter((l) => l.pairs.every((p) => importedPairs.has(p)));
  const missingLinks = truthLinks.filter((l) => !l.pairs.every((p) => importedPairs.has(p)));
  const linkReported = (l: Link): boolean => {
    if (failed) return true;
    const fromTable = truth.tables.find((t) => canon(t.name) === canon(l.from));
    // Left out with its table (the table is reported): the link goes with it.
    if (fromTable && !importedByCanon.has(canon(l.from)) && tableReported(fromTable)) return true;
    // Named: the from table and FK column with the target table, or with the word relationship / foreign key / reference.
    return l.fromColumns.some((c) => mentioned(shown, l.from, c, l.to)
      || ['relationship', 'foreign key', 'reference', 'ref'].some((w) => mentioned(shown, l.from, c, w)));
  };
  const missingReported = missingLinks.filter(linkReported);
  const missingSilent = missingLinks.filter((l) => !linkReported(l))
    // A from-table lost silently is already counted under tables.
    .filter((l) => importedByCanon.has(canon(l.from)))
    .map((l) => `${l.from}.${l.fromColumns.join('+')} → ${l.to}`);
  const extraLinks = importedLinks.filter((l) => !l.pairs.every((p) => truthPairs.has(p)));
  const wrongDirection = extraLinks.filter((l) => l.reversed.every((p) => truthPairs.has(p))).length;

  // One-to-one -------------------------------------------------------------
  const truthOneToOne = truthLinks.filter((l) => l.oneToOne);
  const importedOneToOne = importedLinks.filter((l) => l.cardinality === 'one-to-one').length;
  const drawnAsMany = truthOneToOne
    .filter((l) => importedLinks.some((il) => il.pairs.every((p) => l.pairs.includes(p)) && il.cardinality !== 'one-to-one'))
    .map((l) => `${l.from}.${l.fromColumns.join('+')} → ${l.to}`);

  // Conditions (filtered links: relationships_where) ----------------------------
  const filtered = new Set(truth.relationships.filter((r) => r.filtered).map((r) => pairKey(r.from, r.fromColumn, r.to, r.toColumn)));
  const filteredLinks = matchedLinks.filter((l) => l.pairs.some((p) => filtered.has(p)));
  const conditionShown = (l: Link): boolean => l.fromColumns.some((c) => mentioned(shown, l.from, c, l.to, 'where'));
  const conditionReported = (l: Link): boolean => l.fromColumns.some((c) => mentioned(shown, l.from, c, 'relationships_where'));
  const conditionsShown = filteredLinks.filter(conditionShown);
  const conditionsReported = filteredLinks.filter((l) => !conditionShown(l) && conditionReported(l));
  const conditionsSilent = filteredLinks.filter((l) => !conditionShown(l) && !conditionReported(l)).map((l) => `${l.from}.${l.fromColumns.join('+')} → ${l.to}`);

  // Required FKs (NOT NULL / not_null) -----------------------------------------
  const allNotes = [...run.notes, ...run.leftOut];
  const optionalNote = allNotes.find((n) => /optional/i.test(n));
  let requiredSource = 0; let requiredKept = 0;
  for (const l of matchedLinks) {
    const t = truth.tables.find((x) => canon(x.name) === canon(l.from));
    const cols = l.fromColumns.map((c) => t?.columns.find((x) => canon(x[0]) === canon(c)));
    if (!cols.every((c) => c && flag(c, 'N'))) continue;
    requiredSource++;
    const got = importedByCanon.get(canon(l.from));
    if (l.fromColumns.every((c) => { const gc = got?.columns?.find((x) => canon(x.name) === canon(c)); return !!gc && (keptNotNull(gc) || !!gc.isPrimaryKey); })) requiredKept++;
  }
  const requiredSilent = optionalNote ? 0 : requiredSource - requiredKept;

  // Unique keys ----------------------------------------------------------------
  let uniqueSource = 0; let uniqueKept = 0; let uniqueSilent = 0;
  for (const u of truth.uniqueKeys) {
    const got = importedByCanon.get(canon(u.table));
    if (!got) continue;
    // An expression index (lower(name)) is not a column key.
    if (u.columns.some((c) => /[()]/.test(c))) continue;
    uniqueSource++;
    if (keptUnique(got, u.columns)) uniqueKept++;
    else if (!mentioned(shown, u.table, u.columns[0], 'unique')) uniqueSilent++;
  }

  const uniqueExtra: string[] = [];
  {
    const truthSets = new Set(truth.uniqueKeys.map((u) => `${canon(u.table)}:${u.columns.map(canon).sort().join(',')}`));
    for (const t of truth.tables) {
      const pk = t.pk.map(canon).sort().join(',');
      if (pk) truthSets.add(`${canon(t.name)}:${pk}`);
    }
    for (const t of run.tables) {
      for (const cols of importedUniqueKeys(t)) {
        if (!truthSets.has(`${canon(t.name)}:${cols.join(',')}`)) uniqueExtra.push(`${t.name}(${cols.join(', ')})`);
      }
    }
  }

  // Schemas --------------------------------------------------------------------
  const truthSchemaOf = (t: TruthTable): string | undefined => t.schema ?? truth.schemas?.[0];
  const sourceSchemas = [...new Set(truth.tables.map(truthSchemaOf).filter((s): s is string => !!s))];
  const importedSchemas = [...new Set(run.tables.map((t) => t.schema ?? '(layer)'))];
  let schemaKept = 0;
  const lostSchemas = new Set<string>();
  for (const t of truth.tables) {
    const s = truthSchemaOf(t);
    const got = importedByCanon.get(canon(t.name));
    if (!s || !got) continue;
    if (got.schema && canon(got.schema) === canon(s)) schemaKept++;
    else lostSchemas.add(s);
  }
  // Told when a string says so: `schema sakila …`, `sakila schema`, `public became main` (not a file or diagram name like sakila-schema).
  const schemaTold = (name: string): boolean => {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\bschemas?\\s+["'\`]?${n}["'\`]?(\\s|[.,;:]|$)|(^|\\s)["'\`]?${n}["'\`]?\\s+(schema|became|is written|was written|was renamed)\\b`, 'i');
    return shown.some((s) => re.test(s));
  };
  const schemasLostSilently = [...lostSchemas].filter((s) => !schemaTold(s));

  // Problems ---------------------------------------------------------------------
  const labels = [...new Set(run.problems.map((p) => `${p.file ?? ''}:${p.line ?? ''}:${p.message}`))];
  const problems = {
    warnings: run.warnings.length,
    count: run.problems.length,
    withCause: run.problems.filter((p) => !GENERIC_PROBLEM.test(p.message.trim())).length,
    withLocation: run.problems.filter((p) => !!p.file && p.line !== undefined).length,
    shown: Math.min(labels.length, PROBLEMS_SHOWN),
    hidden: Math.max(0, labels.length - PROBLEMS_SHOWN),
    longest: run.problems.reduce((n, p) => Math.max(n, p.message.length), 0),
    messages: run.problems.map((p) => `${p.file ?? ''}${p.line !== undefined ? `:${p.line}` : ''} ${p.message}`.trim()),
  };

  const silent = failed
    ? { tables: 0, columns: 0, primaryKeys: 0, relationships: 0, oneToOne: 0, requiredFks: 0, uniqueKeys: 0, typeDetail: 0, descriptions: 0, schemas: 0, conditions: 0 }
    : {
      tables: missingTables.length - missingTablesReported.length,
      columns: colMissing - colMissingReported,
      primaryKeys: pkSilent,
      relationships: missingSilent.length,
      oneToOne: drawnAsMany.length,
      requiredFks: requiredSilent,
      uniqueKeys: uniqueSilent,
      typeDetail: detailLostSilent,
      descriptions: descChanged + descMissing,
      schemas: schemasLostSilently.length,
      conditions: conditionsSilent.length,
    };
  const total = Object.values(silent).reduce((a, b) => a + b, 0);
  const detailSilent = silent.typeDetail + silent.descriptions + silent.uniqueKeys + silent.requiredFks + silent.schemas + silent.conditions;
  const falseNotLostNote = !failed && detailSilent + silent.columns > 0 && allNotes.some((n) => /not lost/i.test(n));

  const score: SampleScore = {
    slug,
    importer: truth.importer,
    ...(run.dialect ? { dialect: run.dialect } : {}),
    ...(run.detectedDialect !== undefined ? { detectedDialect: run.detectedDialect } : {}),
    verdict: 'Clean',
    reasons,
    tables: { source: truth.tables.length, imported: run.tables.length, matched: truth.tables.length - missingTables.length, missing: missingTables.length, missingReported: missingTablesReported.length, extra: extraTables },
    columns: { source: colSource, imported: colImported, matched: colMatched, missing: colMissing, missingReported: colMissingReported, extra: colExtra },
    primaryKeys: { source: truth.tables.filter((t) => t.pk.length > 0).length, imported: pkImported, matched: pkMatched, composite: pkComposite, missing: pkMissing, wrong: pkWrong, extra: pkExtra },
    relationships: {
      source: truthLinks.length, imported: importedLinks.length, matched: matchedLinks.length,
      missing: missingLinks.length, missingReported: missingReported.length, missingSilent,
      extra: extraLinks.map((l) => l.label), wrongDirection,
    },
    oneToOne: { source: truthOneToOne.length, imported: importedOneToOne, drawnAsMany },
    conditions: { source: filteredLinks.length, shown: conditionsShown.length, reported: conditionsReported.length, silent: conditionsSilent },
    requiredFks: {
      source: requiredSource, keptNotNull: requiredKept, toldOptional: !!optionalNote, ...(optionalNote ? { optionalNote } : {}),
      // Counts may be written with a thousands separator (`1,139 relationships`).
      noteClaims: optionalNote ? Number((optionalNote.match(/(\d[\d,]*) (?:references?|relationships?)[^.]*not optional|(\d[\d,]*) required/i)?.slice(1).find(Boolean) ?? 'NaN').replace(/,/g, '')) : null,
    },
    uniqueKeys: { source: uniqueSource, kept: uniqueKept, lost: uniqueSource - uniqueKept, extra: uniqueExtra },
    types: { checked: typesChecked, verbatim: typesVerbatim, detailSource, detailKept, detailLost },
    descriptions: { source: descSource, imported: descImported, exact: descExact, changed: descChanged, missing: descMissing },
    schemas: { source: sourceSchemas, imported: importedSchemas, kept: schemaKept, lostSilently: schemasLostSilently },
    problems,
    notes: run.notes,
    leftOut: run.leftOut,
    falseNotLostNote,
    silentLosses: { ...silent, total },
  };
  score.verdict = verdictOf(score, failed, reasons);
  return score;
}

/**
 * - Failed: no table imported.
 * - With problems: the structure is wrong and the user is not told: a table,
 *   column, key or relationship lost silently, a wrong key, an extra table or
 *   relationship, a relationship the wrong way round, or a one-to-one drawn as
 *   many-to-one.
 * - With gaps: the structure is right, but something is left out (and said),
 *   or a detail is lost silently (type detail, description, unique key,
 *   NOT NULL, schema, a relationship's condition), or the draft says nothing was lost when it was, or
 *   required relationships are saved optional (D18) with no note.
 * - Clean: none of these.
 */
export function verdictOf(s: SampleScore, failed: boolean, reasons: string[]): Verdict {
  if (failed) {
    reasons.push(`nothing imported (${s.problems.count} problem${s.problems.count === 1 ? '' : 's'})`);
    return 'Failed';
  }
  const L = s.silentLosses;
  const problem: string[] = [];
  if (L.tables) problem.push(`${L.tables} table(s) lost silently`);
  if (s.tables.extra.length) problem.push(`${s.tables.extra.length} extra table(s): ${s.tables.extra.join(', ')}`);
  if (L.columns) problem.push(`${L.columns} column(s) lost silently`);
  if (L.primaryKeys) problem.push(`${L.primaryKeys} primary key(s) missing or wrong`);
  if (L.relationships) problem.push(`${L.relationships} relationship(s) lost silently`);
  if (s.relationships.extra.length) problem.push(`${s.relationships.extra.length} relationship(s) not in the source`);
  if (s.relationships.wrongDirection) problem.push(`${s.relationships.wrongDirection} relationship(s) the wrong way round`);
  if (L.oneToOne) problem.push(`${L.oneToOne} one-to-one link(s) drawn as many-to-one`);
  const gap: string[] = [];
  const reported = s.tables.missingReported + s.columns.missingReported + s.relationships.missingReported;
  if (reported) gap.push(`${reported} item(s) left out and reported`);
  if (L.typeDetail) gap.push(`${L.typeDetail} type detail(s) lost`);
  if (L.descriptions) gap.push(`${L.descriptions} description(s) lost or changed`);
  if (L.uniqueKeys) gap.push(`${L.uniqueKeys} unique key(s) lost`);
  if (L.requiredFks) gap.push(`${L.requiredFks} required FK(s) lost`);
  if (L.schemas) gap.push(`schema(s) ${s.schemas.lostSilently.join(', ')} lost`);
  if (L.conditions) gap.push(`${L.conditions} relationship condition(s) lost silently`);
  if (s.falseNotLostNote) gap.push('a note says details are not lost');
  if (s.requiredFks.source > 0 && !s.requiredFks.toldOptional) gap.push(`${s.requiredFks.source} required relationship(s) saved optional with no note`);
  const claims = s.requiredFks.noteClaims;
  if (claims !== null && Number.isFinite(claims) && claims !== s.requiredFks.source) gap.push(`the optional note counts ${claims} required references; the source has ${s.requiredFks.source}`);
  if (s.uniqueKeys.extra.length) gap.push(`${s.uniqueKeys.extra.length} unique key(s) not in the source`);
  reasons.push(...problem, ...gap);
  if (problem.length) return 'With problems';
  return gap.length ? 'With gaps' : 'Clean';
}

export interface Scorecard {
  samples: SampleScore[];
  totals: {
    verdicts: Record<Verdict, number>;
    tablesImported: number; tablesSource: number;
    relationshipsMatched: number; relationshipsSource: number;
    silentLosses: number;
  };
}

export function totalsOf(samples: readonly SampleScore[]): Scorecard['totals'] {
  const verdicts: Record<Verdict, number> = { Failed: 0, 'With problems': 0, 'With gaps': 0, Clean: 0 };
  for (const s of samples) verdicts[s.verdict]++;
  return {
    verdicts,
    tablesImported: samples.reduce((n, s) => n + s.tables.matched - (s.verdict === 'Failed' ? s.tables.matched : 0), 0),
    tablesSource: samples.reduce((n, s) => n + s.tables.source, 0),
    relationshipsMatched: samples.reduce((n, s) => n + (s.verdict === 'Failed' ? 0 : s.relationships.matched), 0),
    relationshipsSource: samples.reduce((n, s) => n + s.relationships.source, 0),
    silentLosses: samples.reduce((n, s) => n + s.silentLosses.total, 0),
  };
}

/** One markdown row per sample, for a quick look (the JSON is the record). */
export function scorecardTable(samples: readonly SampleScore[]): string {
  const head = '| Sample | Verdict | Tables | Columns | PKs | Rels matched / source (extra, silent miss) | 1:1 as many | Types detail kept | Descriptions exact | Problems (cause / location) | Silent losses |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = samples.map((s) => `| ${s.slug} | ${s.verdict} | ${s.tables.matched}/${s.tables.source} | ${s.columns.matched}/${s.columns.source} | ${s.primaryKeys.matched}/${s.primaryKeys.source} | ${s.relationships.matched}/${s.relationships.source} (${s.relationships.extra.length}, ${s.relationships.missingSilent.length}) | ${s.oneToOne.drawnAsMany.length}/${s.oneToOne.source} | ${s.types.detailKept}/${s.types.detailSource} | ${s.descriptions.exact}/${s.descriptions.source} | ${s.problems.count} (${s.problems.withCause} / ${s.problems.withLocation}) | ${s.silentLosses.total} |`);
  return [head, sep, ...rows].join('\n');
}
