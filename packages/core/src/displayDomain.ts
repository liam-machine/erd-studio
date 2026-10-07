/**
 * Logical stage -> DisplayDomain: the shape the canvas renders.
 */

import type { ModelTemplate, NodePosition, Relationship, SemanticDomain, ViewConfig } from './types/semantic.js';
import type { DisplayDomain, DisplayRelationshipIssue, ExistingModelPreview, ManifestModelPreview } from './types/display.js';
import type { LayerConfig } from './types/layer.js';
import { computeNewModelPositions } from './positions.js';
import { modelLoadErrorOf } from './types/semantic.js';

/**
 * Detect models in logical.models that lack entries in viewConfig.positions
 * and compute positions for them. Pure — returns the computed positions (or
 * null when every model already has one) without touching the document.
 */
export function computeMissingPositions(
  unifiedDomain: { logical: { models: Array<{ name: string }>; relationships: Relationship[] }; viewConfig: { positions?: Record<string, NodePosition> } },
): Record<string, NodePosition> | null {
  const positions = unifiedDomain.viewConfig.positions ?? {};
  const modelNames = unifiedDomain.logical.models.map((m) => m.name);
  const newModels = modelNames.filter((name) => !positions[name]);

  if (newModels.length === 0) return null;

  const computed = computeNewModelPositions({
    newModels,
    relationships: unifiedDomain.logical.relationships ?? [],
    existingPositions: positions,
  });

  return Object.keys(computed).length === 0 ? null : computed;
}

/** Editor-only data the extension adds to an editable stage. */
export interface DisplayDomainEditorPayload {
  templates: ModelTemplate[];
  manifestModels: ManifestModelPreview[];
  existingModels: ExistingModelPreview[];
}

export interface ToDisplayDomainOptions {
  /** The domain's global view config (it lives on the UnifiedDomain, not the stage). */
  viewConfig: ViewConfig;
  stubColumns?: string[];
  /** The configured layer the domain belongs to, for badge styling. */
  layerConfig: LayerConfig | undefined;
  readOnly: boolean;
  /** Templates and addable models, when the host offers editing. */
  editorPayload?: DisplayDomainEditorPayload;
  /** Where a new relationship is stored (editable logical payload only). */
  relationshipHome?: 'library' | 'domain';
  /** Relationship findings for the canvas banner (editable logical payload only); omitted when empty. */
  relationshipIssues?: DisplayRelationshipIssue[];
}

/**
 * Convert a SemanticDomain to a DisplayDomain for the canvas.
 *
 * A column shows the FK badge (`isForeignKey`) when its model file says so or
 * when it is the `from` side of a relationship; `isForeignKeyDeclared` is set
 * only by the model file, so it can serve as evidence. Relationships keep
 * their runtime-only `source`, `stored` and `issues`.
 */
export function toDisplayDomain(domain: SemanticDomain, options: ToDisplayDomainOptions): DisplayDomain {
  const { viewConfig, stubColumns, layerConfig, readOnly, editorPayload, relationshipHome, relationshipIssues } = options;

  // Build FK column set for isForeignKey computation (names without case).
  const fkColumnsByModel = new Map<string, Set<string>>();
  for (const rel of domain.relationships) {
    const model = rel.fromModel.toLowerCase();
    if (!fkColumnsByModel.has(model)) {
      fkColumnsByModel.set(model, new Set());
    }
    fkColumnsByModel.get(model)!.add(rel.fromColumn.toLowerCase());
  }

  const models = domain.models.map((model) => {
    const loadError = modelLoadErrorOf(model);
    const fkCols = fkColumnsByModel.get(model.name.toLowerCase()) ?? new Set<string>();
    const columns = (model.columns ?? []).map((col) => ({
      name: col.name,
      dataType: col.dataType,
      description: col.description,
      isPrimaryKey: col.isPrimaryKey === true,
      isForeignKey: col.isForeignKey === true || fkCols.has(col.name.toLowerCase()),
      ...(col.isForeignKey === true ? { isForeignKeyDeclared: true } : {}),
      isNaturalKey: col.isNaturalKey === true,
      ...(col.scdType != null ? { scdType: col.scdType } : {}),
      ...(col.additiveType ? { additiveType: col.additiveType } : {}),
      ...(col.meta ? { meta: col.meta } : {}),
    }));

    return {
      name: model.name,
      schema: model.schema ?? '',
      ...(model.alias ? { alias: model.alias } : {}),
      description: model.description ?? '',
      columns,
      ...(model.rationale ? { rationale: model.rationale } : {}),
      ...(model.grain ? { grain: model.grain } : {}),
      ...(model.modelRole ? { modelRole: model.modelRole } : {}),
      ...(model.meta ? { meta: model.meta } : {}),
      ...(loadError ? { loadError: { ...loadError } } : {}),
    };
  });

  const relationships = domain.relationships.map((rel) => ({
    fromModel: rel.fromModel,
    fromColumn: rel.fromColumn,
    toModel: rel.toModel,
    toColumn: rel.toColumn,
    cardinality: rel.cardinality,
    ...(rel.role ? { role: rel.role } : {}),
    ...(rel.source ? { source: { ...rel.source } } : {}),
    ...(rel.stored ? { stored: { ...rel.stored } } : {}),
    ...(rel.issues && rel.issues.length > 0 ? { issues: [...rel.issues] } : {}),
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
    ...(editorPayload
      ? {
          templates: editorPayload.templates,
          manifestModels: editorPayload.manifestModels,
          existingModels: editorPayload.existingModels,
        }
      : {}),
    layerConfig,
    readOnly,
    positionDraggable: true,
    ...(stubColumns && stubColumns.length > 0 ? { stubColumns } : {}),
    ...(relationshipHome ? { relationshipHome } : {}),
    ...(relationshipIssues && relationshipIssues.length > 0 ? { relationshipIssues } : {}),
  };
}
