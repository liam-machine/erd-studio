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
 * Compare columns between two matched models.
 */
function compareColumns(
  sourceModel: DisplayModel,
  targetModel: DisplayModel,
): ColumnDiscrepancy[] {
  const targetColumnMap = new Map(targetModel.columns.map((c) => [c.name, c]));
  const visited = new Set<string>();
  const result: ColumnDiscrepancy[] = [];

  for (const col of sourceModel.columns) {
    const targetCol = targetColumnMap.get(col.name);
    visited.add(col.name);

    if (!targetCol) {
      result.push({ name: col.name, status: 'extra', sourceDataType: col.dataType });
    } else if (col.dataType !== targetCol.dataType) {
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

  // Columns in target but not source
  for (const col of targetModel.columns) {
    if (!visited.has(col.name)) {
      result.push({ name: col.name, status: 'missing', targetDataType: col.dataType });
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
 */
export function compare(source: DisplayDomain, target: DisplayDomain): DiscrepancyReport {
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
      const columns = compareColumns(model, targetModel);
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
