/**
 * Discrepancy service — compares two DisplayDomains to produce a cross-stage
 * discrepancy report.
 *
 * Pure functions with no I/O or side effects. Runs on the extension host.
 *
 * Usage:
 *   compare(physicalDomain, logicalDomain) → DiscrepancyReport
 */

import type { DisplayDomain, DisplayModel, DisplayRelationship } from '../types/display';
import type {
  DiscrepancyReport,
  ModelDiscrepancy,
  ColumnDiscrepancy,
  RelationshipDiscrepancy,
} from '../types/discrepancy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Composite key for matching relationships across stages. */
function relationshipKey(r: { fromModel: string; fromColumn: string; toModel: string; toColumn: string }): string {
  return `${r.fromModel}|${r.fromColumn}|${r.toModel}|${r.toColumn}`;
}

/**
 * Alias map: common synonyms → canonical type name.
 * Applied after lowercasing and whitespace normalisation.
 */
const TYPE_ALIASES: Record<string, string> = {
  // String family
  varchar:  'string',
  text:     'string',
  char:     'string',
  nvarchar: 'string',
  nchar:    'string',
  ntext:    'string',
  // Integer family
  integer:  'int',
  tinyint:  'int',
  smallint: 'int',
  int64:    'int',
  // Big integer family
  bigint:   'bigint',
  // Numeric / decimal family
  numeric:  'decimal',
  number:   'decimal',
  // Float family
  float:    'double',
  real:     'double',
  float64:  'double',
  // Boolean family
  bool:     'boolean',
  // Timestamp family
  timestamp_ntz: 'timestamp',
  timestamp_ltz: 'timestamp',
  datetime:      'timestamp',
  datetime2:     'timestamp',
  // Binary family
  bytea:    'binary',
  blob:     'binary',
  varbinary: 'binary',
  // JSON family
  jsonb:    'json',
};

/**
 * Normalise a data type string for comparison purposes.
 *
 * Steps:
 * 1. Lowercase
 * 2. Trim outer whitespace
 * 3. Normalise whitespace inside parentheses: `decimal(15, 5)` → `decimal(15,5)`
 * 4. Map common aliases to a canonical name (varchar → string, integer → int, …)
 *
 * The original (un-normalised) strings are still stored on the discrepancy
 * result so the UI shows what the user actually typed / what dbt reports.
 */
export function normaliseDataType(raw: string | undefined): string {
  if (!raw) return '';
  let t = raw.trim().toLowerCase();
  // Strip spaces inside parens: `decimal( 15 , 5 )` → `decimal(15,5)`
  t = t.replace(/\(\s*/g, '(').replace(/\s*\)/g, ')').replace(/\s*,\s*/g, ',');
  // Extract base name (everything before the first '(')
  const parenIdx = t.indexOf('(');
  const baseName = parenIdx >= 0 ? t.slice(0, parenIdx) : t;
  const suffix = parenIdx >= 0 ? t.slice(parenIdx) : '';
  const canonical = TYPE_ALIASES[baseName] ?? baseName;
  return canonical + suffix;
}

/** Compare two data type strings using normalised forms. */
function dataTypesMatch(a: string | undefined, b: string | undefined): boolean {
  return normaliseDataType(a) === normaliseDataType(b);
}

/**
 * Compare columns between two matched models.
 *
 * @param stubColumns - When true, columns that exist in the target but not the
 *   source are suppressed. Used for stub/reference models where only a few key
 *   columns (PK/NK) are defined in logical — the physical model may have many
 *   more columns that should not surface as discrepancies.
 */
function compareColumns(
  sourceModel: DisplayModel,
  targetModel: DisplayModel,
  stubColumns: boolean,
): ColumnDiscrepancy[] {
  const targetColumnMap = new Map(targetModel.columns.map((c) => [c.name, c]));
  const visited = new Set<string>();
  const result: ColumnDiscrepancy[] = [];

  for (const col of sourceModel.columns) {
    const targetCol = targetColumnMap.get(col.name);
    visited.add(col.name);

    if (!targetCol) {
      result.push({ name: col.name, status: 'extra', sourceDataType: col.dataType });
    } else if (!dataTypesMatch(col.dataType, targetCol.dataType)) {
      result.push({
        name: col.name,
        status: 'type-mismatch',
        sourceDataType: col.dataType,
        targetDataType: targetCol.dataType,
      });
    } else {
      result.push({ name: col.name, status: 'matched' });
    }
  }

  // Columns in target but not source — suppressed for stub models
  if (!stubColumns) {
    for (const col of targetModel.columns) {
      if (!visited.has(col.name)) {
        result.push({ name: col.name, status: 'missing', targetDataType: col.dataType });
      }
    }
  }

  return result;
}

/**
 * Compare relationships between source and target domains.
 */
function compareRelationships(
  sourceRels: DisplayRelationship[],
  targetRels: DisplayRelationship[],
): RelationshipDiscrepancy[] {
  const targetMap = new Map(targetRels.map((r) => [relationshipKey(r), r]));
  const visited = new Set<string>();
  const result: RelationshipDiscrepancy[] = [];

  for (const rel of sourceRels) {
    const key = relationshipKey(rel);
    const targetRel = targetMap.get(key);
    visited.add(key);

    if (!targetRel) {
      result.push({
        fromModel: rel.fromModel,
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        status: 'extra',
        sourceCardinality: rel.cardinality,
      });
    } else if (rel.cardinality !== targetRel.cardinality) {
      result.push({
        fromModel: rel.fromModel,
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        status: 'cardinality-mismatch',
        sourceCardinality: rel.cardinality,
        targetCardinality: targetRel.cardinality,
      });
    } else {
      result.push({
        fromModel: rel.fromModel,
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        status: 'matched',
      });
    }
  }

  // Relationships in target but not source
  for (const rel of targetRels) {
    if (!visited.has(relationshipKey(rel))) {
      result.push({
        fromModel: rel.fromModel,
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        status: 'missing',
        targetCardinality: rel.cardinality,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main compare function
// ---------------------------------------------------------------------------

/**
 * Compare two display domains and produce a discrepancy report.
 *
 * @param source - The domain being viewed (e.g., physical)
 * @param target - The domain being compared against (e.g., logical)
 * @param stubColumnModels - Model names whose physical-only (missing) column
 *   discrepancies should be suppressed. See UnifiedDomain.stubColumns.
 */
export function compare(
  source: DisplayDomain,
  target: DisplayDomain,
  stubColumnModels: ReadonlySet<string> = new Set(),
): DiscrepancyReport {
  const targetModelMap = new Map(target.models.map((m) => [m.name, m]));
  const visitedModels = new Set<string>();
  const models: ModelDiscrepancy[] = [];

  let totalColumns = 0;
  let matchedColumns = 0;
  let extraColumns = 0;
  let missingColumns = 0;
  let dataTypeMismatches = 0;

  // Compare source models against target
  for (const model of source.models) {
    const targetModel = targetModelMap.get(model.name);
    visitedModels.add(model.name);

    if (!targetModel) {
      const extraCols: ColumnDiscrepancy[] = model.columns.map((c) => ({
        name: c.name,
        status: 'extra' as const,
        sourceDataType: c.dataType,
      }));
      models.push({ name: model.name, status: 'extra', columns: extraCols });
      totalColumns += model.columns.length;
      extraColumns += model.columns.length;
    } else {
      const isStub = stubColumnModels.has(model.name);
      const columns = compareColumns(model, targetModel, isStub);
      models.push({ name: model.name, status: 'matched', columns });

      for (const col of columns) {
        totalColumns++;
        switch (col.status) {
          case 'matched': matchedColumns++; break;
          case 'extra': extraColumns++; break;
          case 'missing': missingColumns++; break;
          case 'type-mismatch': dataTypeMismatches++; break;
        }
      }
    }
  }

  // Models in target but not source
  for (const model of target.models) {
    if (!visitedModels.has(model.name)) {
      const missingCols: ColumnDiscrepancy[] = model.columns.map((c) => ({
        name: c.name,
        status: 'missing' as const,
        targetDataType: c.dataType,
      }));
      models.push({ name: model.name, status: 'missing', columns: missingCols });
      totalColumns += model.columns.length;
      missingColumns += model.columns.length;
    }
  }

  const relationships = compareRelationships(source.relationships, target.relationships);

  return {
    domain: source.domain,
    layer: source.layer,
    sourceStage: source.stage,
    targetStage: target.stage,
    models,
    relationships,
    summary: {
      totalModels: source.models.length + target.models.filter((m) => !visitedModels.has(m.name)).length,
      matchedModels: models.filter((m) => m.status === 'matched').length,
      extraModels: models.filter((m) => m.status === 'extra').length,
      missingModels: models.filter((m) => m.status === 'missing').length,
      totalColumns,
      matchedColumns,
      extraColumns,
      missingColumns,
      dataTypeMismatches,
    },
  };
}
