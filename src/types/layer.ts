/**
 * Moved to `@erd-studio/core` (packages/core/src/types/layer.ts). This module
 * re-exports every symbol so existing imports of this path keep working.
 */

export type {
  LayerConfig,
  LayersConfigFile,
} from '@erd-studio/core';
export {
  LAYERS_SCHEMA_VERSION,
  DEFAULT_LAYERS,
  KNOWN_LAYER_DEFAULTS,
  AUTO_DETECT_COLORS,
} from '@erd-studio/core';
