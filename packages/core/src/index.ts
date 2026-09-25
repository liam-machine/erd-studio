/**
 * @erd-studio/core — the ERD Studio domain model.
 *
 * Types, plus the pure pipeline from raw domain files (domain JSON,
 * `layers.json`, `logical-models/*.yml`) to the DisplayDomain the canvas
 * renders. Shared by the VS Code extension host, its webview and
 * `@erd-studio/renderer`. Nothing here may import Node built-ins, `vscode`,
 * React or React Flow.
 */

export * from './types/semantic.js';
export * from './types/layer.js';
export * from './types/display.js';
export * from './types/discrepancy.js';
export * from './types/canvasMessages.js';

export * from './positions.js';
export * from './domain.js';
export {
  LOGICAL_MODELS_DIR,
  RATIONALE_KEYS,
  YamlNodeLimitError,
  YamlCharLimitError,
  parseLogicalModelText,
  isSafeModelName,
  isValidModelAlias,
  MODEL_ALIAS_MAX_LENGTH,
  MODEL_ALIAS_RULE,
  type ParseLogicalModelOptions,
} from './logicalModel.js';
export * from './layers.js';
export * from './displayDomain.js';
export * from './loadDisplayDomain.js';
