/**
 * Does the first draft look any good? (telemetry 2.0 B6.) Presence flags
 * computed on the device from a draft about to show: fixed keys only, never a
 * table, column or type name and never a count. Each flag is a ratio or a
 * threshold over the drafted tables, decided here, so only the boolean leaves.
 *
 * The example drafts (`example`, `exampleProject`) are ERD Studio's own and
 * say nothing about an import, so they get no flags.
 *
 * vscode-free and pure: `trackedDraftPreview` (`src/providers/draftWiring.ts`)
 * records what it returns.
 */

import { normaliseName } from './nameUtils';
import type { TelemetryFeature } from './telemetryPayload';
import type { Draft, DraftSource } from '../types/draft';

/** The import sources the source-qualified keys name. */
export type DraftQualitySource = 'Dbt' | 'SqlDdl' | 'SemanticModel' | 'Dbml';

const QUALITY_SOURCES: Readonly<Partial<Record<DraftSource, DraftQualitySource>>> = {
  dbt: 'Dbt',
  sqlDdl: 'SqlDdl',
  semanticModel: 'SemanticModel',
  dbml: 'Dbml',
};

/** A discard or a closed tab this soon after the page showed, with no details opened, is a rejection at a glance. */
export const DRAFT_REJECTED_FAST_MS = 15_000;
/** A table with more columns than this is wide. */
export const DRAFT_WIDE_TABLE_COLUMNS = 30;
/** Prefixes tried off a table name when a column looks like its key (`customer_id` → `dim_customer`). */
const KEY_TABLE_PREFIXES = ['dim_', 'fct_', 'stg_'] as const;

/** What a draft looks like, as booleans only. */
export interface DraftQuality {
  source: DraftQualitySource;
  /** At least 3 tables, and no relationships, mostly orphans, mostly empty or mostly untyped. */
  thin: boolean;
  /** At least 2 tables and no relationships. */
  relsNone: boolean;
  orphansMost: boolean;
  emptyTablesMost: boolean;
  untypedMost: boolean;
  /** SQL DDL and DBML only (dbt and semantic models rarely declare keys). */
  noPkMost: boolean;
  wideTablesMost: boolean;
  relsInferable: boolean;
  leftOut: boolean;
  capped: boolean;
  reusesLibrary: boolean;
}

/** `part` is at least half of `whole` (and `whole` is not 0). */
function atLeastHalf(part: number, whole: number): boolean {
  return whole > 0 && part * 2 >= whole;
}

function untyped(dataType: unknown): boolean {
  if (typeof dataType !== 'string') return true;
  const t = dataType.trim().toLowerCase();
  return t === '' || t === 'unknown';
}

/** The names a column could use to point at `table`: `<table>_id`, `<table>_key`, also without a dim_/fct_/stg_ prefix. */
function keyNamesOf(table: string): string[] {
  const base = normaliseName(table);
  const stems = new Set([base]);
  for (const prefix of KEY_TABLE_PREFIXES) {
    if (base.startsWith(prefix) && base.length > prefix.length) stems.add(base.slice(prefix.length));
  }
  return [...stems].flatMap((stem) => [`${stem}_id`, `${stem}_key`]);
}

/**
 * The draft's quality flags, or null for an example draft. Reads only
 * `draft.summary` and `draft.display` (models, their columns' types and keys,
 * and the relationship endpoints); a draft missing either reads as empty.
 */
export function draftQualityFlags(draft: Pick<Draft, 'source' | 'summary' | 'display'>): DraftQuality | null {
  const source = QUALITY_SOURCES[draft.source];
  if (!source) return null;
  const models = Array.isArray(draft.display?.models) ? draft.display.models : [];
  const relationships = Array.isArray(draft.display?.relationships) ? draft.display.relationships : [];
  const tables = models.length;

  const related = new Set<string>();
  for (const r of relationships) {
    if (typeof r?.fromModel === 'string') related.add(normaliseName(r.fromModel));
    if (typeof r?.toModel === 'string') related.add(normaliseName(r.toModel));
  }
  let orphans = 0;
  let empty = 0;
  let noPk = 0;
  let wide = 0;
  let columns = 0;
  let untypedColumns = 0;
  for (const model of models) {
    const cols = Array.isArray(model?.columns) ? model.columns : [];
    if (!related.has(normaliseName(String(model?.name ?? '')))) orphans++;
    if (cols.length === 0) empty++;
    if (!cols.some((c) => c?.isPrimaryKey === true)) noPk++;
    if (cols.length > DRAFT_WIDE_TABLE_COLUMNS) wide++;
    columns += cols.length;
    for (const c of cols) if (untyped(c?.dataType)) untypedColumns++;
  }

  const relsNone = tables >= 2 && relationships.length === 0;
  const orphansMost = tables >= 3 && atLeastHalf(orphans, tables);
  const emptyTablesMost = atLeastHalf(empty, tables);
  const untypedMost = atLeastHalf(untypedColumns, columns);
  const noPkMost = (source === 'SqlDdl' || source === 'Dbml') && atLeastHalf(noPk, tables);
  const wideTablesMost = atLeastHalf(wide, tables);

  let relsInferable = false;
  if (relsNone || orphansMost) {
    // Matched on the device; only the boolean leaves.
    const keyOwners = new Map<string, number>();
    models.forEach((model, i) => {
      for (const key of keyNamesOf(String(model?.name ?? ''))) if (!keyOwners.has(key)) keyOwners.set(key, i);
    });
    let matches = 0;
    models.forEach((model, i) => {
      const cols = Array.isArray(model?.columns) ? model.columns : [];
      for (const c of cols) {
        const owner = keyOwners.get(normaliseName(String(c?.name ?? '')));
        if (owner !== undefined && owner !== i) matches++;
      }
    });
    relsInferable = matches >= 2;
  }

  const summary = draft.summary;
  return {
    source,
    thin: tables >= 3 && (relsNone || orphansMost || emptyTablesMost || untypedMost),
    relsNone,
    orphansMost,
    emptyTablesMost,
    untypedMost,
    noPkMost,
    wideTablesMost,
    relsInferable,
    leftOut: (summary?.leftOut ?? 0) > 0,
    capped: summary?.available !== undefined,
    reusesLibrary: (summary?.reusedTables ?? 0) + (summary?.changedTables ?? 0) > 0,
  };
}

const THIN: Readonly<Record<DraftQualitySource, TelemetryFeature>> = {
  Dbt: 'draftThinDbt', SqlDdl: 'draftThinSqlDdl', SemanticModel: 'draftThinSemanticModel', Dbml: 'draftThinDbml',
};
const RELS_NONE: Readonly<Record<DraftQualitySource, TelemetryFeature>> = {
  Dbt: 'draftRelsNoneDbt', SqlDdl: 'draftRelsNoneSqlDdl', SemanticModel: 'draftRelsNoneSemanticModel', Dbml: 'draftRelsNoneDbml',
};
const KEPT_THIN: Readonly<Record<DraftQualitySource, TelemetryFeature>> = {
  Dbt: 'draftKeptThinDbt', SqlDdl: 'draftKeptThinSqlDdl', SemanticModel: 'draftKeptThinSemanticModel', Dbml: 'draftKeptThinDbml',
};
const REJECTED_FAST: Readonly<Record<DraftQualitySource, TelemetryFeature>> = {
  Dbt: 'draftRejectedFastDbt', SqlDdl: 'draftRejectedFastSqlDdl', SemanticModel: 'draftRejectedFastSemanticModel', Dbml: 'draftRejectedFastDbml',
};

/** The keys a draft about to show records: the unqualified flags, then its source's thin / no-relationships keys. */
export function draftShownQualityFeatures(q: DraftQuality | null): TelemetryFeature[] {
  if (!q) return [];
  const out: TelemetryFeature[] = [];
  if (q.orphansMost) out.push('draftOrphansMost');
  if (q.emptyTablesMost) out.push('draftEmptyTablesMost');
  if (q.untypedMost) out.push('draftUntypedMost');
  if (q.noPkMost) out.push('draftNoPkMost');
  if (q.wideTablesMost) out.push('draftWideTablesMost');
  if (q.relsInferable) out.push('draftRelsInferable');
  if (q.leftOut) out.push('draftLeftOut');
  if (q.capped) out.push('draftCapped');
  if (q.reusesLibrary) out.push('draftReusesLibrary');
  if (q.thin) out.push(THIN[q.source]);
  if (q.relsNone) out.push(RELS_NONE[q.source]);
  return out;
}

/** A Keep wrote this draft: its source's kept-thin key when it was thin. */
export function draftKeptQualityFeature(q: DraftQuality | null): TelemetryFeature | undefined {
  return q?.thin ? KEPT_THIN[q.source] : undefined;
}

/**
 * A discard or a closed tab `elapsedMs` after the page showed: its source's
 * rejected-at-a-glance key, when that was within {@link DRAFT_REJECTED_FAST_MS}
 * and no details were opened in between.
 */
export function draftRejectedFastFeature(source: DraftSource, elapsedMs: number, detailsSeen: boolean): TelemetryFeature | undefined {
  const s = QUALITY_SOURCES[source];
  if (!s || detailsSeen || !(elapsedMs >= 0 && elapsedMs < DRAFT_REJECTED_FAST_MS)) return undefined;
  return REJECTED_FAST[s];
}
