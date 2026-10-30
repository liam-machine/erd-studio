/**
 * @erd-studio/core — the ERD Studio domain model.
 *
 * Types, plus the pure pipeline from raw domain files (domain JSON,
 * `layers.json`, `logical-models/*.yml` or v6's `tables/*.yml`) to the DisplaySubjectArea the canvas
 * renders, and the parser-free half of native DBML storage (file
 * classification, versions, the `erd_layout` codec, the storage comparator). The DBML
 * readers and writers, which need `@dbml/parse`, are the `@erd-studio/core/dbml`
 * subpath; nothing here imports a value from it. Shared by the VS Code extension host, its webview and
 * `@erd-studio/renderer`. Nothing here may import Node built-ins, `vscode`,
 * React or React Flow.
 */

export * from './types/semantic.js';
export * from './types/layer.js';
export * from './types/display.js';
export * from './types/discrepancy.js';
export * from './types/canvasMessages.js';
export * from './types/dbmlStorage.js';

export * from './positions.js';
export * from './domain.js';
export * from './relationships.js';
export * from './keyEvidence.js';
export * from './orientLink.js';
export {
  LOGICAL_MODELS_DIR,
  TABLES_DIR,
  TABLE_LIBRARY_DIRS,
  RATIONALE_KEYS,
  YamlNodeLimitError,
  YamlCharLimitError,
  parseTableText,
  isSafeTableName,
  isValidTableAlias,
  TABLE_ALIAS_MAX_LENGTH,
  TABLE_ALIAS_RULE,
  type ParseTableOptions,
} from './logicalModel.js';
export * from './layers.js';
export * from './meta.js';
export * from './displayDomain.js';
export * from './loadDisplayDomain.js';
export * from './exportDiagram.js';
export * from './erdLayout.js';
export * from './dbmlRichProperties.js';
export * from './dbmlText.js';
export * from './storage.js';
// Named: the module's row-by-row helpers are internal (the twin-golden tests).
export { normaliseForStorageEquivalence, storageNoteText, type StorageEquivalenceOptions } from './storageEquivalence.js';
export * from './dbmlAttach.js';
export { findConflictMarkers } from './mergeConflict.js';
