/**
 * AutoReconciliationService — detects and executes design→repo transitions
 * when models appear in the dbt manifest.
 *
 * This service encapsulates the business logic for auto-reconciliation:
 * 1. Find design models that now exist in manifest
 * 2. Transition source from 'design' to 'built'
 * 3. Move inline columns NOT in manifest to plannedColumns (preserves user's planned work)
 * 4. Remove inline columns array (manifest becomes source of truth)
 *
 * Used by:
 * - F304: Auto-reconciliation on manifest change (file watcher trigger)
 * - F305: Manual refresh manifest command
 */

import type { ManifestData } from '../types/manifest';
import type { SemanticDomain, SemanticModel, ColumnDef } from '../types/semantic';
import { relationshipMatchesTest } from './reconciliationService';

/** Identifies a relationship by its composite key */
export interface RelationshipKey {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
}

export interface ReconciliationResult {
  /** Whether any models or relationships were transitioned */
  transitioned: boolean;
  /** Names of models that transitioned from design to repo */
  newlyBuiltModels: string[];
  /** Relationships that transitioned from design to built */
  newlyBuiltRelationships: RelationshipKey[];
}

export class AutoReconciliationService {
  /**
   * Detect design models in a domain that now exist in manifest.
   * Returns array of model names that can be transitioned.
   */
  findNewlyBuiltModels(domain: SemanticDomain, manifest: ManifestData): string[] {
    const newlyBuilt: string[] = [];

    for (const model of domain.models) {
      if (model.source === 'design' && manifest.models.has(model.name)) {
        newlyBuilt.push(model.name);
      }
    }

    return newlyBuilt;
  }

  /**
   * Transition a design model to repo source.
   * Mutates the model in-place within the domain.
   *
   * Algorithm:
   * 1. Find design columns NOT in manifest → move to plannedColumns
   * 2. Extract primary key from isPrimaryKey flag
   * 3. Update model: source='built', remove design-only fields
   *
   * @param domain - The semantic domain containing the model (will be mutated)
   * @param modelName - Name of the model to transition
   * @param manifest - The manifest data containing built model information
   */
  transitionModelToBuilt(
    domain: SemanticDomain,
    modelName: string,
    manifest: ManifestData,
  ): void {
    const modelIndex = domain.models.findIndex((m) => m.name === modelName);
    if (modelIndex === -1) {
      throw new Error(`Model "${modelName}" not found in domain`);
    }

    const model = domain.models[modelIndex];

    if (model.source !== 'design') {
      throw new Error(
        `Model "${modelName}" is not a design model (source=${model.source})`,
      );
    }

    const manifestModel = manifest.models.get(modelName);
    if (!manifestModel) {
      throw new Error(`Model "${modelName}" not found in manifest`);
    }

    // Build set of manifest column names for fast lookup
    const manifestColumnNames = new Set(
      manifestModel.columns.map((col) => col.name),
    );

    // Process inline design columns in a single pass:
    // - Columns NOT in manifest → full planned column entries (key flags stripped)
    // - Columns IN manifest with key flags → minimal key-only override entries
    //   (same pattern used by handleToggleColumnKey in SemanticEditorProvider)
    const inlineColumns = model.columns ?? [];
    const plannedColumns: ColumnDef[] = [];
    const keyOverrides: ColumnDef[] = [];

    // Build manifest column lookup by name for dataType comparison
    const manifestColumnsByName = new Map(
      manifestModel.columns.map((c) => [c.name, c]),
    );

    for (const col of inlineColumns) {
      if (!manifestColumnNames.has(col.name)) {
        // Column doesn't exist in manifest yet — keep as planned column.
        // Key flags are stripped; they only apply to built columns.
        const plannedCol: ColumnDef = {
          name: col.name,
          dataType: col.dataType,
          description: col.description,
        };
        if (col.approved === true) {
          plannedCol.approved = true;
        }
        plannedColumns.push(plannedCol);
      } else {
        // Column IS in manifest — preserve key flags and detect dataType discrepancies
        const manifestCol = manifestColumnsByName.get(col.name);
        const override = { name: col.name } as ColumnDef;
        let hasOverrides = false;

        // Store expected dataType if it differs from manifest
        if (manifestCol && col.dataType && col.dataType !== (manifestCol.data_type ?? 'unknown')) {
          override.expectedDataType = col.dataType;
          hasOverrides = true;
        }

        // Preserve key flags as before
        if (col.isPrimaryKey === true) {
          override.isPrimaryKey = true;
          hasOverrides = true;
        }
        if (col.isForeignKey === true) {
          override.isForeignKey = true;
          hasOverrides = true;
        }
        if (col.isNaturalKey === true) {
          override.isNaturalKey = true;
          hasOverrides = true;
        }

        if (hasOverrides) {
          keyOverrides.push(override);
        }
      }
    }

    // Extract primary key from isPrimaryKey flag in design columns
    // Only set primaryKey if the column actually exists in manifest
    let primaryKey: string | undefined;
    const pkColumn = inlineColumns.find((col) => col.isPrimaryKey === true);
    if (pkColumn && manifestColumnNames.has(pkColumn.name)) {
      primaryKey = pkColumn.name;
    }

    // Build the built model (replacing the design model)
    // Note: approved flag is intentionally NOT preserved when transitioning to built
    // because the model is now built (exists in manifest), so approval is no longer relevant
    const builtModel: SemanticModel = {
      name: model.name,
      source: 'built',
    };

    if (primaryKey) {
      builtModel.primaryKey = primaryKey;
    }

    // Combine planned columns (not in manifest) with key overrides (in manifest)
    const allPlannedColumns = [...plannedColumns, ...keyOverrides];
    if (allPlannedColumns.length > 0) {
      builtModel.plannedColumns = allPlannedColumns;
    }

    // Replace in domain
    domain.models[modelIndex] = builtModel;
  }

  /**
   * Find relationships in domain with source: 'design' that now exist in manifest tests.
   */
  findNewlyBuiltRelationships(
    domain: SemanticDomain,
    manifest: ManifestData,
  ): RelationshipKey[] {
    const newlyBuilt: RelationshipKey[] = [];
    const tests = manifest.relationshipTests;

    for (const rel of domain.relationships) {
      // Only check relationships explicitly marked as design
      if (rel.source !== 'design') {
        continue;
      }

      // Check if this relationship now exists in manifest
      const matchingTest = tests.find((test) => relationshipMatchesTest(rel, test));

      if (matchingTest) {
        newlyBuilt.push({
          fromModel: rel.fromModel,
          fromColumn: rel.fromColumn,
          toModel: rel.toModel,
          toColumn: rel.toColumn,
        });
      }
    }

    return newlyBuilt;
  }

  /**
   * Remove source: 'design' field from relationships that now exist in manifest.
   * Mutates domain.relationships in-place.
   */
  transitionRelationshipsToBuilt(
    domain: SemanticDomain,
    manifest: ManifestData,
  ): void {
    const tests = manifest.relationshipTests;

    for (const rel of domain.relationships) {
      if (rel.source !== 'design') {
        continue;
      }

      const matchingTest = tests.find((test) => relationshipMatchesTest(rel, test));
      if (matchingTest) {
        // Remove the source field - absence of source means built
        delete rel.source;
      }
    }
  }

  /**
   * Execute auto-reconciliation for a domain.
   * Detects newly built models and relationships, then transitions them.
   *
   * @param domain - The semantic domain to reconcile (will be mutated if transitions occur)
   * @param manifest - The manifest data to reconcile against
   * @returns Result indicating whether transitions occurred and which models/relationships
   */
  reconcileDomain(
    domain: SemanticDomain,
    manifest: ManifestData,
  ): ReconciliationResult {
    const newlyBuiltModels = this.findNewlyBuiltModels(domain, manifest);
    const newlyBuiltRelationships = this.findNewlyBuiltRelationships(domain, manifest);

    const transitioned =
      newlyBuiltModels.length > 0 || newlyBuiltRelationships.length > 0;

    if (!transitioned) {
      return {
        transitioned: false,
        newlyBuiltModels: [],
        newlyBuiltRelationships: [],
      };
    }

    // Transition models
    for (const modelName of newlyBuiltModels) {
      this.transitionModelToBuilt(domain, modelName, manifest);
    }

    // Transition relationships
    if (newlyBuiltRelationships.length > 0) {
      this.transitionRelationshipsToBuilt(domain, manifest);
    }

    return {
      transitioned: true,
      newlyBuiltModels: newlyBuiltModels,
      newlyBuiltRelationships,
    };
  }
}
