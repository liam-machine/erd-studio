/**
 * ReconciliationService — merges semantic domain JSON with dbt manifest data.
 *
 * This service implements "overlay semantics" for column resolution:
 *   1. For repo models: manifest columns (built) + plannedColumns not in manifest (planned)
 *   2. For design models: inline columns (all planned)
 *   3. PK/FK columns that don't exist are shown as "missing" ghost rows
 *
 * The output is a ReconciledDomain ready for the webview.
 */

import type {
  ManifestData,
  ManifestColumn,
  ManifestRelationshipTest,
} from '../types/manifest';
import type {
  SemanticDomain,
  SemanticModel,
  Relationship,
} from '../types/semantic';
import type {
  ReconciledDomainCore,
  ReconciledModel,
  ReconciledColumn,
  ReconciledRelationship,
  ModelStatus,
  RelationshipStatus,
} from '../types/reconciled';

export class ReconciliationService {
  /**
   * Reconcile a semantic domain against manifest data.
   *
   * @param domain - The semantic domain from JSON
   * @param manifest - The parsed manifest data (may be empty if no manifest)
   * @returns A fully reconciled domain ready for the webview
   */
  reconcile(domain: SemanticDomain, manifest: ManifestData): ReconciledDomainCore {
    // Build a set of FK column names per model for FK badge assignment
    const fkColumnsByModel = this.buildFkColumnMap(domain.relationships);

    const models = domain.models.map((model) =>
      this.reconcileModel(model, manifest, fkColumnsByModel.get(model.name) ?? new Set()),
    );

    const relationships = domain.relationships.map((rel) =>
      this.reconcileRelationship(rel, manifest.relationshipTests),
    );

    return {
      schemaVersion: domain.schemaVersion,
      domain: domain.domain,
      layer: domain.layer,
      description: domain.description,
      modelFolder: domain.modelFolder,
      models,
      relationships,
      viewConfig: domain.viewConfig,
    };
  }

  /**
   * Build a map of model name → set of FK column names.
   * A column is an FK if it appears as `fromColumn` in any relationship.
   */
  private buildFkColumnMap(
    relationships: Relationship[],
  ): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const rel of relationships) {
      if (!map.has(rel.fromModel)) {
        map.set(rel.fromModel, new Set());
      }
      map.get(rel.fromModel)!.add(rel.fromColumn);
    }
    return map;
  }

  /**
   * Reconcile a single model against manifest data.
   */
  private reconcileModel(
    model: SemanticModel,
    manifest: ManifestData,
    fkColumns: Set<string>,
  ): ReconciledModel {
    const manifestModel = manifest.models.get(model.name);
    const isInManifest = manifestModel !== undefined;

    // Determine model status
    let status: ModelStatus;
    if (model.source === 'design') {
      status = isInManifest ? 'built' : 'design';
    } else {
      // repo model
      status = isInManifest ? 'built' : 'missing';
    }

    // Resolve columns based on model source and manifest presence
    const columns = this.resolveColumns(model, manifestModel, fkColumns);

    return {
      name: model.name,
      status,
      schema: manifestModel?.schema ?? model.schema ?? '',
      description: manifestModel?.description ?? model.description ?? '',
      columns,
    };
  }

  /**
   * Resolve columns for a model using overlay semantics.
   *
   * Order:
   * 1. Built columns (from manifest) — green
   * 2. Planned columns not in manifest — orange
   * 3. Missing PK/FK ghost columns — orange
   */
  private resolveColumns(
    model: SemanticModel,
    manifestModel: { columns: ManifestColumn[] } | undefined,
    fkColumns: Set<string>,
  ): ReconciledColumn[] {
    const columns: ReconciledColumn[] = [];
    const seenColumns = new Set<string>();

    // For design models not in manifest, use inline columns
    if (model.source === 'design' && !manifestModel) {
      const inlineColumns = model.columns ?? [];
      for (const col of inlineColumns) {
        columns.push({
          name: col.name,
          dataType: col.dataType,
          description: col.description,
          status: 'planned',
          isPrimaryKey: col.isPrimaryKey === true,
          isForeignKey: fkColumns.has(col.name),
        });
        seenColumns.add(col.name);
      }
    } else if (manifestModel) {
      // Model is in manifest — use manifest columns (built)
      for (const col of manifestModel.columns) {
        const isPk = this.isPrimaryKey(model, col.name);
        columns.push({
          name: col.name,
          dataType: col.data_type ?? 'unknown',
          description: col.description,
          status: 'built',
          isPrimaryKey: isPk,
          isForeignKey: fkColumns.has(col.name),
        });
        seenColumns.add(col.name);
      }

      // Add planned columns not in manifest (overlay)
      const plannedColumns = model.plannedColumns ?? [];
      for (const col of plannedColumns) {
        if (!seenColumns.has(col.name)) {
          columns.push({
            name: col.name,
            dataType: col.dataType,
            description: col.description,
            status: 'planned',
            isPrimaryKey: this.isPrimaryKey(model, col.name),
            isForeignKey: fkColumns.has(col.name),
          });
          seenColumns.add(col.name);
        }
        // If column IS in manifest, skip it (manifest wins)
      }
    }

    // Add ghost rows for PK/FK references to non-existent columns
    this.addGhostColumns(model, fkColumns, seenColumns, columns);

    return columns;
  }

  /**
   * Check if a column is the primary key for a model.
   */
  private isPrimaryKey(model: SemanticModel, columnName: string): boolean {
    // For repo models, check the primaryKey field
    if (model.source === 'repo' && model.primaryKey === columnName) {
      return true;
    }
    // For design models, check the isPrimaryKey flag in columns
    if (model.source === 'design' && model.columns) {
      const col = model.columns.find((c) => c.name === columnName);
      return col?.isPrimaryKey === true;
    }
    return false;
  }

  /**
   * Add ghost rows for PK/FK columns that don't exist in the resolved columns.
   * These appear as orange "missing" rows to warn the user.
   */
  private addGhostColumns(
    model: SemanticModel,
    fkColumns: Set<string>,
    seenColumns: Set<string>,
    columns: ReconciledColumn[],
  ): void {
    // Check if PK column exists
    if (model.primaryKey && !seenColumns.has(model.primaryKey)) {
      columns.push({
        name: model.primaryKey,
        dataType: '???',
        description: 'Primary key column not found in manifest',
        status: 'missing',
        isPrimaryKey: true,
        isForeignKey: false,
      });
      seenColumns.add(model.primaryKey);
    }

    // Check if FK columns exist
    for (const fkCol of fkColumns) {
      if (!seenColumns.has(fkCol)) {
        columns.push({
          name: fkCol,
          dataType: '???',
          description: 'Foreign key column not found in manifest',
          status: 'missing',
          isPrimaryKey: false,
          isForeignKey: true,
        });
        seenColumns.add(fkCol);
      }
    }
  }

  /**
   * Reconcile a relationship to add status.
   *
   * A relationship is 'built' if it exists as a relationship test in the manifest.
   * Otherwise, it's 'design' (user-created and not yet in manifest).
   */
  private reconcileRelationship(
    rel: Relationship,
    manifestTests: ManifestRelationshipTest[],
  ): ReconciledRelationship {
    const isInManifest = this.isRelationshipInManifest(rel, manifestTests);

    // Built if exists in manifest tests, otherwise design
    const status: RelationshipStatus = isInManifest ? 'built' : 'design';

    return {
      fromModel: rel.fromModel,
      fromColumn: rel.fromColumn,
      toModel: rel.toModel,
      toColumn: rel.toColumn,
      cardinality: rel.cardinality,
      status,
    };
  }

  /**
   * Check if a relationship exists as a relationship test in the manifest.
   * Matches by composite key: (fromModel, fromColumn, toModel, toColumn).
   */
  private isRelationshipInManifest(
    rel: Relationship,
    tests: ManifestRelationshipTest[],
  ): boolean {
    return tests.some((test) => relationshipMatchesTest(rel, test));
  }
}

/**
 * Check if a relationship matches a manifest relationship test.
 * Matches by composite key: (fromModel, fromColumn, toModel, toColumn).
 *
 * Exported for use by AutoReconciliationService.
 */
export function relationshipMatchesTest(
  rel: { fromModel: string; fromColumn: string; toModel: string; toColumn: string },
  test: ManifestRelationshipTest,
): boolean {
  return (
    test.fromModel === rel.fromModel &&
    test.fromColumn === rel.fromColumn &&
    test.toModel === rel.toModel &&
    test.toColumn === rel.toColumn
  );
}
