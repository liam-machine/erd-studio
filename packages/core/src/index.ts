/**
 * @erd-studio/core — the ERD Studio domain model.
 *
 * Types, plus the pure pipeline from raw domain files (domain JSON,
 * `layers.json`, `logical-models/*.yml`) to the DisplayDomain the canvas
 * renders. Shared by the VS Code extension host, its webview and
 * `@erd-studio/renderer`. Nothing here may import Node built-ins, `vscode`,
 * React or React Flow.
 */

export * from './types/semantic';
export * from './types/layer';
export * from './types/display';
export * from './types/discrepancy';
export * from './types/canvasMessages';

export * from './positions';
export * from './domain';
export * from './logicalModel';
export * from './layers';
export * from './displayDomain';
export * from './loadDisplayDomain';
