/**
 * Moved to `@erd-studio/core` (packages/core/src/positions.ts). This module
 * re-exports every symbol so existing imports of this path keep working.
 */

export type { PositionContext } from '@erd-studio/core';
export {
  NODE_WIDTH,
  NODE_HEIGHT,
  PADDING,
  computeNewModelPositions,
  findOpenPosition,
} from '@erd-studio/core';
