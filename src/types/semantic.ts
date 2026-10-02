/**
 * Moved to `@erd-studio/core` (packages/core/src/types/semantic.ts). This module
 * re-exports every symbol so existing imports of this path keep working.
 */

export type {
  Layer,
  Stage,
  ColumnDef,
  Meta,
  MetaValue,
  ModelRole,
  Rationale,
  SemanticModel,
  ModelLoadError,
  ModelLoadErrorKind,
  UnreadableModelPlaceholder,
  DesignModel,
  Cardinality,
  Relationship,
  ModelRelationship,
  NodePosition,
  LayoutOptions,
  AnnotationColor,
  Annotation,
  ViewConfig,
  StageData,
  SemanticDomain,
  UnifiedDomain,
  StageDataV5,
  UnifiedDomainV5,
  RawDomainFile,
  DomainFormat,
  DomainSummary,
  ModelTemplate,
} from '@erd-studio/core';
export {
  CURRENT_SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION,
  detectDomainFormat,
  describeUnsupportedDomainFormat,
  getRawDomainModelNames,
  isDomainV5,
  modelLoadErrorOf,
} from '@erd-studio/core';
