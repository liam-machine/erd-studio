// Entry point `@erd-studio/renderer/sizing`: model node size estimation, for
// layout code that needs node sizes before React Flow has measured them (the
// extension's ELK auto-layout). No components, no React Flow runtime.
export {
  NODE_WIDTH,
  estimateNodeHeight,
  countVisibleColumnRows,
  resolveNodeDimensions,
  estimateNodeWidth,
} from './lib/nodeSizing';
