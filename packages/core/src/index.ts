/**
 * @erd-studio/core — the ERD Studio domain model.
 *
 * Shared by the VS Code extension host, its webview and `@erd-studio/renderer`.
 * Nothing here may import Node built-ins, `vscode`, React or React Flow.
 */

export * from './types/semantic';
export * from './types/layer';
export * from './types/display';
export * from './types/discrepancy';
export * from './types/canvasMessages';
