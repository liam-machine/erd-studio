/**
 * Logical stage → DisplayDomain, the pure core.
 *
 * `SemanticEditorProvider.buildDisplayDomain` is this call plus the canvas-only
 * extras (templates, add-model pickers, layer config). The discrepancy
 * comparison only reads the core, so `computeDomainDiff` (`stageDiff.ts`) —
 * shared by the canvas and the `erd-studio` CLI — builds the logical side here
 * and both see exactly the same domain.
 *
 * No `vscode` import — this module is bundled into `dist/cli.js`.
 */

import type { DisplayDomain } from '../types/display';
import type { SemanticDomain, ViewConfig } from '../types/semantic';

/**
 * Convert a logical `SemanticDomain` to a `DisplayDomain`.
 *
 * Key flags are coerced to booleans (`isPrimaryKey === true`), and a column is
 * a foreign key when it says so OR when it is the `fromColumn` of one of the
 * domain's relationships. `viewConfig` is passed separately because it lives
 * at the root of the unified domain file, not in the stage section.
 */
export function buildLogicalDisplayDomain(
  domain: SemanticDomain,
  viewConfig: ViewConfig,
  stubColumns?: string[],
): DisplayDomain {
  // Build FK column set for isForeignKey computation
  const fkColumnsByModel = new Map<string, Set<string>>();
  for (const rel of domain.relationships) {
    if (!fkColumnsByModel.has(rel.fromModel)) {
      fkColumnsByModel.set(rel.fromModel, new Set());
    }
    fkColumnsByModel.get(rel.fromModel)!.add(rel.fromColumn);
  }

  const models = domain.models.map((model) => {
    const fkCols = fkColumnsByModel.get(model.name) ?? new Set<string>();
    const columns = (model.columns ?? []).map((col) => ({
      name: col.name,
      dataType: col.dataType,
      description: col.description,
      isPrimaryKey: col.isPrimaryKey === true,
      isForeignKey: col.isForeignKey === true || fkCols.has(col.name),
      isNaturalKey: col.isNaturalKey === true,
      ...(col.scdType != null ? { scdType: col.scdType } : {}),
      ...(col.additiveType ? { additiveType: col.additiveType } : {}),
    }));

    return {
      name: model.name,
      schema: model.schema ?? '',
      description: model.description ?? '',
      columns,
      ...(model.rationale ? { rationale: model.rationale } : {}),
      ...(model.grain ? { grain: model.grain } : {}),
      ...(model.modelRole ? { modelRole: model.modelRole } : {}),
    };
  });

  const relationships = domain.relationships.map((rel) => ({
    fromModel: rel.fromModel,
    fromColumn: rel.fromColumn,
    toModel: rel.toModel,
    toColumn: rel.toColumn,
    cardinality: rel.cardinality,
  }));

  return {
    schemaVersion: domain.schemaVersion,
    domain: domain.domain,
    layer: domain.layer,
    stage: domain.stage,
    description: domain.description,
    modelFolder: domain.modelFolder,
    models,
    relationships,
    viewConfig,
    readOnly: domain.stage === 'physical',
    positionDraggable: true,
    ...(stubColumns && stubColumns.length > 0 ? { stubColumns } : {}),
  };
}
