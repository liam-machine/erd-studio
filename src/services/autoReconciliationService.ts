/**
 * AutoReconciliationService — detects and executes design→repo transitions
 * when models appear in the dbt manifest.
 *
 * This service encapsulates the business logic for auto-reconciliation:
 * 1. Find design models that now exist in manifest
 * 2. Transition source from 'design' to 'repo'
 * 3. Move inline columns NOT in manifest to plannedColumns (preserves user's planned work)
 * 4. Remove inline columns array (manifest becomes source of truth)
 *
 * Used by:
 * - F304: Auto-reconciliation on manifest change (file watcher trigger)
 * - F305: Manual refresh manifest command
 */

import type { ManifestData } from '../types/manifest';
import type { SemanticDomain, SemanticModel, ColumnDef } from '../types/semantic';

export interface ReconciliationResult {
  /** Whether any models were transitioned */
  transitioned: boolean;
  /** Names of models that transitioned from design to repo */
  newlyBuiltModels: string[];
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
   * 3. Update model: source='repo', remove design-only fields
   *
   * @param domain - The semantic domain containing the model (will be mutated)
   * @param modelName - Name of the model to transition
   * @param manifest - The manifest data containing built model information
   */
  transitionModelToRepo(
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

    // Find columns in design that are NOT yet built (preserve as planned)
    const inlineColumns = model.columns ?? [];
    const plannedColumns: ColumnDef[] = [];

    for (const col of inlineColumns) {
      if (!manifestColumnNames.has(col.name)) {
        // Column doesn't exist in manifest yet - keep as planned
        // Remove isPrimaryKey flag when moving to plannedColumns
        plannedColumns.push({
          name: col.name,
          dataType: col.dataType,
          description: col.description,
        });
      }
    }

    // Extract primary key from isPrimaryKey flag in design columns
    // Only set primaryKey if the column actually exists in manifest
    let primaryKey: string | undefined;
    const pkColumn = inlineColumns.find((col) => col.isPrimaryKey === true);
    if (pkColumn && manifestColumnNames.has(pkColumn.name)) {
      primaryKey = pkColumn.name;
    }

    // Build the repo model (replacing the design model)
    const repoModel: SemanticModel = {
      name: model.name,
      source: 'repo',
    };

    if (primaryKey) {
      repoModel.primaryKey = primaryKey;
    }

    if (plannedColumns.length > 0) {
      repoModel.plannedColumns = plannedColumns;
    }

    // Replace in domain
    domain.models[modelIndex] = repoModel;
  }

  /**
   * Execute auto-reconciliation for a domain.
   * Detects newly built models and transitions them.
   *
   * @param domain - The semantic domain to reconcile (will be mutated if transitions occur)
   * @param manifest - The manifest data to reconcile against
   * @returns Result indicating whether transitions occurred and which models
   */
  reconcileDomain(
    domain: SemanticDomain,
    manifest: ManifestData,
  ): ReconciliationResult {
    const newlyBuilt = this.findNewlyBuiltModels(domain, manifest);

    if (newlyBuilt.length === 0) {
      return { transitioned: false, newlyBuiltModels: [] };
    }

    // Transition each model
    for (const modelName of newlyBuilt) {
      this.transitionModelToRepo(domain, modelName, manifest);
    }

    return { transitioned: true, newlyBuiltModels: newlyBuilt };
  }
}
